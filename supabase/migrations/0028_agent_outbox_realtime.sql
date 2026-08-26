-- Migration: realtime para la cola de salida.
--
-- Supabase solo emite `postgres_changes` de las tablas incluidas en la
-- publicación `supabase_realtime`. `agent_outbox` se creó en la migración
-- 0024 sin agregarla, así que la suscripción del ERP se conecta bien pero
-- no recibe NADA.
--
-- Se nota justo donde más molesta: el mensaje que alguien acaba de
-- escribir queda mostrándose como "En cola" aunque el agente ya lo haya
-- enviado, hasta que la persona recargue la página. Y un mensaje que
-- falló no se enteraría nunca.
--
-- La lectura sigue protegida por la RLS que ya tiene la tabla: Realtime
-- la respeta.

BEGIN;
  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'agent_outbox'
      ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_outbox;
      END IF;
    END IF;
  END
  $$;
COMMIT;
