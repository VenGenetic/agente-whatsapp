-- Migration: cola de salida para responderle al cliente DESDE el ERP.
--
-- Por qué hace falta: los mensajes que el vendedor escribe desde el
-- teléfono llegan al agente cifrados y sin poder abrirse (WhatsApp cifra
-- una copia por dispositivo vinculado y la librería no logra establecer
-- esa sesión). Se comprobó en vivo: 6 mensajes enviados desde el
-- teléfono, los 6 llegaron vacíos, con 1 fallo de descifrado por cada
-- uno. O sea que por esa vía el ERP nunca va a tener la conversación
-- completa.
--
-- Respondiendo desde el ERP el sistema conoce el texto ANTES de cifrarlo,
-- así que queda registrado sí o sí.
--
-- Es una cola y no una llamada directa porque el ERP (navegador) no tiene
-- la sesión de WhatsApp: la tiene el proceso del agente. El ERP encola y
-- el agente envía, con estado y reintentos visibles.
-- PROPUESTA — no aplicada todavía.

CREATE TABLE IF NOT EXISTS public.agent_outbox (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    error TEXT,
    intentos INTEGER NOT NULL DEFAULT 0,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    sent_at TIMESTAMP WITH TIME ZONE
);

COMMENT ON TABLE public.agent_outbox IS
    'Mensajes que el equipo escribe desde el ERP y el proceso del agente envia por WhatsApp.';

-- El agente consulta seguido por lo pendiente: indice parcial, pocas filas.
CREATE INDEX IF NOT EXISTS idx_agent_outbox_pendientes
    ON public.agent_outbox(created_at) WHERE status = 'pending';

ALTER TABLE public.agent_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_outbox" ON public.agent_outbox;
CREATE POLICY "Allow all operations for authenticated users on agent_outbox"
ON public.agent_outbox FOR ALL TO authenticated USING (true) WITH CHECK (true);
