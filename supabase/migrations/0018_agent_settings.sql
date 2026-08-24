-- Migration: interruptor GLOBAL del agente, controlado desde el ERP.
--
-- Hasta ahora el interruptor maestro vivía solo en el .env del servidor
-- (BOT_AUTO_REPLY_ENABLED), así que prender/apagar el agente entero
-- obligaba a editar un archivo en el servidor y reiniciar el proceso. El
-- negocio necesita poder hacerlo desde el ERP, sin depender de nadie.
--
-- Tabla de una sola fila (id = 1, forzado por el CHECK) en vez de
-- key/value genérico: son pocos ajustes y con tipos concretos se leen y
-- validan mejor.
--
-- `bot_auto_reply_enabled` arranca en FALSE por diseño -- mismo criterio
-- de "modo seguro por defecto" que agent_conversations.bot_enabled: si
-- alguien aplica esta migración sin querer, el agente NO empieza a
-- contestarle a nadie.
-- PROPUESTA — no aplicada todavía.

CREATE TABLE IF NOT EXISTS public.agent_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    bot_auto_reply_enabled BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON COLUMN public.agent_settings.bot_auto_reply_enabled IS
    'Interruptor maestro: si el agente puede responder automáticamente. Además de esto, cada conversación necesita su propio agent_conversations.bot_enabled.';

INSERT INTO public.agent_settings (id, bot_auto_reply_enabled)
VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.agent_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_settings" ON public.agent_settings;
CREATE POLICY "Allow all operations for authenticated users on agent_settings"
ON public.agent_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);
