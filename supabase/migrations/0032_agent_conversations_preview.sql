-- Migration: mostrar de qué habla cada chat en la lista, sin abrirlo.
--
-- La lista de conversaciones mostraba nombre, teléfono y hora -- pero no
-- el último mensaje. Para saber si un chat pide un repuesto, reclama o
-- solo dice "gracias", había que abrirlo. Con miles de conversaciones eso
-- convierte el triaje en abrir y cerrar chats de a uno.
--
-- Por qué el texto se GUARDA acá en vez de consultarse:
--
-- Lo natural sería pedir el último mensaje de cada conversación al armar
-- la lista, pero PostgREST no hace `DISTINCT ON`: habría que traer cientos
-- de mensajes y quedarse con uno de cada grupo, o una consulta por chat.
-- Con 200 conversaciones por página y la lista recargándose, eso es
-- exactamente el tipo de gasto que ya costó caro en cuota de Supabase.
--
-- Denormalizar tiene un costo real -- este texto puede quedar desfasado si
-- algo escribe en `agent_messages` sin pasar por el agente -- y se acepta a
-- propósito: es una vista previa para triar, no la fuente de verdad. El
-- hilo real siempre se lee de `agent_messages`.

BEGIN;

ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS last_message_preview TEXT,
    ADD COLUMN IF NOT EXISTS last_message_direction TEXT;

COMMENT ON COLUMN public.agent_conversations.last_message_preview IS
    'Texto del ultimo mensaje, recortado. Vista previa para la lista: la fuente de verdad es agent_messages.';
COMMENT ON COLUMN public.agent_conversations.last_message_direction IS
    'inbound | outbound: de que lado fue el ultimo mensaje, para el "Vos:" de la lista.';

-- ============================================================
-- Relleno de lo que ya existe
-- ============================================================
-- `DISTINCT ON` sí está disponible acá (es Postgres, no PostgREST): toma
-- el mensaje más reciente de cada conversación en una sola pasada.
--
-- Los mensajes sin texto (una foto, una nota de voz) se describen en vez
-- de quedar vacíos: "(foto)" dice más que una línea en blanco.
WITH ultimos AS (
    SELECT DISTINCT ON (m.conversation_id)
        m.conversation_id,
        m.direction,
        COALESCE(
            NULLIF(btrim(m.body), ''),
            CASE m.content_type
                WHEN 'image'    THEN '(foto)'
                WHEN 'audio'    THEN '(nota de voz)'
                WHEN 'video'    THEN '(video)'
                WHEN 'document' THEN '(archivo)'
                WHEN 'sticker'  THEN '(sticker)'
                WHEN 'location' THEN '(ubicación)'
                WHEN 'contact'  THEN '(contacto)'
                ELSE NULL
            END
        ) AS preview
    FROM public.agent_messages m
    ORDER BY m.conversation_id, m.created_at DESC
)
UPDATE public.agent_conversations c
SET last_message_preview = left(u.preview, 120),
    last_message_direction = u.direction
FROM ultimos u
WHERE u.conversation_id = c.id
  AND u.preview IS NOT NULL;

COMMIT;
