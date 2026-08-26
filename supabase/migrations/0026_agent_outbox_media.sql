-- Migration: responderle al cliente DESDE el ERP con fotos, archivos y
-- productos del catálogo -- no solo texto.
--
-- De dónde viene: la cola `agent_outbox` (migración 0024) solo lleva
-- `body TEXT`. Con eso el equipo puede escribir, pero no puede hacer lo
-- que más se hace en este negocio: mandar la FOTO del repuesto. Hoy eso
-- obliga a salirse del ERP (abrir WhatsApp en el teléfono, buscar la
-- foto, mandarla), y todo lo que se manda por fuera del ERP no queda
-- registrado en la conversación -- los mensajes escritos desde el
-- teléfono llegan cifrados al agente y nunca se pueden abrir (ver el
-- comentario de la migración 0024).
--
-- Esta migración agrega tres cosas:
--
--   1. La cola acepta media (foto/video/documento) y puede señalar de qué
--      producto del catálogo salió.
--   2. `agent_messages` guarda la URL de la media, así el ERP puede
--      MOSTRAR la foto -- tanto la que mandó el cliente (clave en
--      repuestos: la mitad de los pedidos llegan como foto de la pieza)
--      como la que mandó el equipo.
--   3. Respuestas rápidas: los textos que el equipo repite todo el día
--      (horarios, dirección, formas de pago) dejan de re-escribirse.
--
-- El bucket es público a propósito: WhatsApp descarga la foto por URL
-- (Baileys manda `{ image: { url } }`), así que una URL firmada que vence
-- rompería el envío. Solo se suben fotos de repuestos, no hay dato
-- sensible acá.

BEGIN;

-- ============================================================
-- 1. Bucket de media del chat
-- ============================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('agent_chat_media', 'agent_chat_media', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "agent_chat_media_public_access" ON storage.objects;
CREATE POLICY "agent_chat_media_public_access"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'agent_chat_media');

DROP POLICY IF EXISTS "agent_chat_media_auth_uploads" ON storage.objects;
CREATE POLICY "agent_chat_media_auth_uploads"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (bucket_id = 'agent_chat_media');

-- Borrar lo que uno mismo subió: hace falta para "quitar el adjunto"
-- antes de enviarlo, si no el bucket se llena de archivos que nadie
-- llegó a mandar.
DROP POLICY IF EXISTS "agent_chat_media_auth_delete" ON storage.objects;
CREATE POLICY "agent_chat_media_auth_delete"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (bucket_id = 'agent_chat_media');

-- ============================================================
-- 2. agent_outbox: media + producto + cancelar
-- ============================================================
ALTER TABLE public.agent_outbox
    ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text',
    ADD COLUMN IF NOT EXISTS media_url TEXT,
    ADD COLUMN IF NOT EXISTS media_mime TEXT,
    ADD COLUMN IF NOT EXISTS media_filename TEXT,
    ADD COLUMN IF NOT EXISTS product_id INTEGER REFERENCES public.products(id) ON DELETE SET NULL,
    -- Fila de agent_messages que quedó al enviarse. Es lo que deja al ERP
    -- mostrar el mensaje en cola y reemplazarlo por el real sin que
    -- aparezca dos veces en el hilo.
    ADD COLUMN IF NOT EXISTS sent_message_id BIGINT REFERENCES public.agent_messages(id) ON DELETE SET NULL;

ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_kind_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_kind_check
    CHECK (kind IN ('text', 'image', 'video', 'document'));

-- Una foto puede ir sin texto (mandar la foto sola es normal), así que el
-- CHECK original -- body obligatorio y no vacío -- ya no sirve. La regla
-- real es: algo tiene que llevar, texto o archivo.
ALTER TABLE public.agent_outbox ALTER COLUMN body DROP NOT NULL;
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_body_check;
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_contenido_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_contenido_check
    CHECK (length(trim(COALESCE(body, ''))) > 0 OR media_url IS NOT NULL);

-- Un mensaje de tipo media SIN archivo saldría vacío por WhatsApp.
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_media_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_media_check
    CHECK (kind = 'text' OR media_url IS NOT NULL);

-- 'canceled': el equipo se arrepintió antes de que saliera. Distinto de
-- 'failed' -- no es un problema técnico y no hay que reintentarlo.
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_status_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_status_check
    CHECK (status IN ('pending', 'sent', 'failed', 'canceled'));

COMMENT ON COLUMN public.agent_outbox.kind IS
    'text | image | video | document. Media lleva media_url; el body va como pie de foto.';
COMMENT ON COLUMN public.agent_outbox.product_id IS
    'Producto del catálogo del que salió este mensaje, si se armó desde el buscador. Solo para trazabilidad.';

-- El ERP lista lo que está en cola de UNA conversación, no de todas.
CREATE INDEX IF NOT EXISTS idx_agent_outbox_conversacion
    ON public.agent_outbox(conversation_id, created_at DESC);

-- ============================================================
-- 3. agent_messages: guardar la URL de la media
-- ============================================================
ALTER TABLE public.agent_messages
    ADD COLUMN IF NOT EXISTS media_url TEXT;

COMMENT ON COLUMN public.agent_messages.media_url IS
    'Copia en Storage (bucket agent_chat_media) de la foto/audio/archivo del mensaje. NULL en mensajes de solo texto y en los importados del historial (WhatsApp no reentrega la media vieja).';

-- ============================================================
-- 4. Respuestas rápidas
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_quick_replies (
    id BIGSERIAL PRIMARY KEY,
    -- Cómo se llama en el menú ("Horarios", "Dirección", "Cómo pagar").
    label TEXT NOT NULL CHECK (length(trim(label)) > 0),
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    -- Orden manual en el menú; a igual valor, alfabético por label.
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

COMMENT ON TABLE public.agent_quick_replies IS
    'Textos que el equipo repite todo el dia, para insertarlos en el chat sin re-escribirlos.';

ALTER TABLE public.agent_quick_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_quick_replies" ON public.agent_quick_replies;
CREATE POLICY "Allow all operations for authenticated users on agent_quick_replies"
ON public.agent_quick_replies FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Semilla mínima: sirve de ejemplo de formato y se edita/borra desde el
-- ERP. Solo si la tabla está vacía, para no re-crear lo que alguien borró.
-- Tuteo, como habla el agente (ver docs/system-prompts.md): mezclar
-- "usted" acá y "tú" en las respuestas del bot se nota en el mismo chat.
INSERT INTO public.agent_quick_replies (label, body, sort_order)
SELECT * FROM (VALUES
    ('Saludo', '¡Hola! ¿En qué te podemos ayudar?', 10),
    ('Pedir el modelo', 'Para buscarte el repuesto exacto, ¿me confirmas la marca, el modelo y el año de la moto?', 20),
    ('Pedir foto', '¿Me puedes mandar una foto de la pieza? Así te confirmo que sea la correcta.', 30),
    ('Un momento', 'Ya te reviso el stock, dame un momento por favor.', 40)
) AS seed(label, body, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM public.agent_quick_replies);

COMMIT;
