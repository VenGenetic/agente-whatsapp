-- Migration: el bot NO debe contestarle a cualquiera que escriba. El
-- negocio decide, conversación por conversación desde el ERP (bandeja de
-- WhatsApp), a quién le contesta el agente y a quién no.
--
-- `bot_enabled` arranca en FALSE por diseño: una conversación nueva
-- (alguien que escribe por primera vez) queda registrada y visible en la
-- bandeja, pero el bot no le responde hasta que alguien del equipo lo
-- habilite a mano. Es el mismo criterio de "modo seguro por defecto" que
-- BOT_AUTO_REPLY_ENABLED en el .env, pero por cliente en vez de global:
-- el .env es el interruptor maestro, esto es el permiso individual.
-- PROPUESTA — no aplicada todavía.

ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS bot_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.agent_conversations.bot_enabled IS
    'Si el agente puede responder automáticamente en esta conversación. Se habilita a mano desde la bandeja de WhatsApp del ERP.';

CREATE INDEX IF NOT EXISTS idx_agent_conversations_bot_enabled
    ON public.agent_conversations(bot_enabled) WHERE bot_enabled = true;
