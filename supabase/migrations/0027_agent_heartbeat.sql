-- Migration: que el ERP sepa si el agente está vivo y si puede enviar.
--
-- El problema concreto: desde el ERP se le contesta al cliente encolando
-- en `agent_outbox`, y quien despacha es el proceso del agente. Si ese
-- proceso está caído, desconectado de WhatsApp, o con la salida frenada
-- (OUTBOUND_MODE), los mensajes se quedan en la cola en silencio. Del
-- lado del ERP se ve exactamente igual que "todavía no salió": nadie se
-- entera hasta que el cliente reclama.
--
-- Con esto el agente deja su estado en la base cada vuelta, y el ERP
-- puede avisar ANTES de que alguien escriba tres mensajes al vacío.
--
-- Vive en agent_settings (tabla de una sola fila, migración 0018) y no en
-- una tabla nueva: es el estado del único agente que hay.

BEGIN;

ALTER TABLE public.agent_settings
    ADD COLUMN IF NOT EXISTS agent_last_seen_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS agent_connection TEXT,
    ADD COLUMN IF NOT EXISTS agent_outbound_mode TEXT,
    ADD COLUMN IF NOT EXISTS agent_version TEXT;

COMMENT ON COLUMN public.agent_settings.agent_last_seen_at IS
    'Ultimo latido del proceso del agente. Si esta viejo, el proceso esta caido y lo que se encole no va a salir.';
COMMENT ON COLUMN public.agent_settings.agent_connection IS
    'Estado de la sesion de WhatsApp que reporta el agente: connected | connecting | disconnected.';
COMMENT ON COLUMN public.agent_settings.agent_outbound_mode IS
    'Freno de salida vigente en el servidor (blocked | erp_only | full). Con blocked, ni siquiera lo que escribe una persona sale.';

COMMIT;
