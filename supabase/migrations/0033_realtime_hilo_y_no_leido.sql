-- Migration: realtime del hilo y de la lista + marcar NO leído en WhatsApp.
--
-- ============================================================
-- 1. El chat no se actualizaba solo
-- ============================================================
-- Supabase solo emite `postgres_changes` de las tablas incluidas en la
-- publicación `supabase_realtime`. La migración 0028 agregó `agent_outbox`
-- pero NO `agent_messages` ni `agent_conversations`, así que el ERP se
-- suscribía bien y no recibía absolutamente nada de las dos tablas que
-- forman el chat.
--
-- Se nota en lo que más se usa: escribís un mensaje, se ve un momento como
-- "En cola" -- eso sí funcionaba, porque la cola es la tabla que sí está
-- publicada -- y cuando el agente lo despacha DESAPARECE de la pantalla,
-- porque el mensaje real vive en `agent_messages` y de ahí no llegaba
-- ningún aviso. Hay que recargar para volver a verlo. Lo mismo con lo que
-- escribe el cliente, con el tilde azul y con el orden de la lista.
--
-- La lectura sigue protegida por la RLS que ya tienen las tablas:
-- Realtime la respeta.
BEGIN;
  DO $$
  DECLARE
    t TEXT;
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
      FOREACH t IN ARRAY ARRAY['agent_messages', 'agent_conversations'] LOOP
        IF NOT EXISTS (
          SELECT 1 FROM pg_publication_tables
          WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
        ) THEN
          EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
        END IF;
      END LOOP;
    END IF;
  END
  $$;
COMMIT;

-- ============================================================
-- 2. "Marcar sin leer" no llegaba a WhatsApp
-- ============================================================
-- Marcar un chat como no leído en el ERP escribía `unread_count = 1` y
-- nada más. Pero el conteo de no leídos NO lo calculamos nosotros: lo
-- espeja WhatsApp (ver syncChatUnreadCounts). Así que el chat seguía
-- leído en el teléfono, el siguiente `chats.update` lo devolvía a 0 y el
-- botón parecía no hacer nada.
--
-- Ahora va por la cola como cualquier otra acción, y es WhatsApp el que
-- devuelve el conteo -- que es lo que hace que el ERP y el teléfono
-- muestren siempre lo mismo.
BEGIN;

ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_kind_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_kind_check
    CHECK (kind IN ('text', 'image', 'video', 'document', 'audio', 'delete', 'reaction', 'edit', 'read', 'unread'));

-- Una acción no lleva cuerpo ni archivo: marcar sin leer no tiene texto.
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_contenido_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_contenido_check
    CHECK (
        kind IN ('delete', 'reaction', 'read', 'unread')
        OR length(trim(COALESCE(body, ''))) > 0
        OR media_url IS NOT NULL
    );

COMMIT;
