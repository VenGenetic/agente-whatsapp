-- El índice único de la migración 0001 era PARCIAL
-- (WHERE whatsapp_message_id IS NOT NULL). PostgREST manda el upsert como
-- `ON CONFLICT (whatsapp_message_id) DO NOTHING`, sin repetir ese
-- predicado, y Postgres no puede inferir un índice parcial sin él: cada
-- import del history sync moría con 42P10 ("there is no unique or
-- exclusion constraint matching the ON CONFLICT specification") y se
-- perdía el lote entero. Se midió en vivo al re-vincular: lotes de ~4700
-- mensajes descartados uno tras otro.
--
-- El índice total se comporta igual para las filas sin id de WhatsApp:
-- Postgres no considera dos NULL como duplicados, así que los mensajes
-- salientes que todavía no tienen whatsapp_message_id siguen entrando sin
-- chocar entre sí.
BEGIN;

DROP INDEX IF EXISTS public.idx_agent_messages_wa_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_wa_id
    ON public.agent_messages(whatsapp_message_id);

COMMIT;
