-- Migration: el agente deja de ser puramente reactivo. Cuando el negocio
-- activa el agente en un chat desde el ERP, el bot arranca la recepción de
-- datos por su cuenta (leyendo el historial viejo del chat), sin esperar a
-- que el cliente vuelva a escribir.
--
-- `intake_started_at` es el marcador que evita mandar el saludo inicial más
-- de una vez: el job proactivo solo toma conversaciones con
-- `bot_enabled = true` y esto en NULL. Se completa cuando el bot manda su
-- primer mensaje ahí.
--
-- OJO (contexto importante): mandar mensajes que el cliente no acaba de
-- pedir es justo lo que hizo que WhatsApp restringiera el número una vez
-- (ver docs/system-prompts.md, incidente del envío masivo). Acá el riesgo
-- es menor porque siempre es un chat donde el cliente YA escribió -- es
-- responder un hilo abierto, no abrir uno nuevo -- pero el job igual manda
-- de a uno y espaciado, a propósito.
-- PROPUESTA — no aplicada todavía.

ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS intake_started_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.agent_conversations.intake_started_at IS
    'Cuándo el agente arrancó la recepción por su cuenta en este chat. NULL = todavía no arrancó. Evita repetir el primer mensaje.';

-- Índice parcial para la consulta del job: pocas filas, muy consultada.
CREATE INDEX IF NOT EXISTS idx_agent_conversations_pending_intake
    ON public.agent_conversations(bot_enabled, intake_started_at)
    WHERE bot_enabled = true AND intake_started_at IS NULL;
