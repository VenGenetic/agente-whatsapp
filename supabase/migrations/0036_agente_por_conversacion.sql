-- El agente se elige al activar cada conversacion desde la bandeja.
-- `intake` solo recopila la informacion y entrega la ficha;
-- `sales` atiende el flujo completo, incluido catalogo, stock y precio.
BEGIN;

ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS selected_agent TEXT;

ALTER TABLE public.agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_selected_agent_check;
ALTER TABLE public.agent_conversations
    ADD CONSTRAINT agent_conversations_selected_agent_check
    CHECK (selected_agent IS NULL OR selected_agent IN ('intake', 'sales'));

COMMENT ON COLUMN public.agent_conversations.selected_agent IS
    'Agente elegido al activar el chat: intake solo pide informacion; sales brinda atencion completa. Debe guardarse junto con bot_enabled=true.';

-- Mantiene el comportamiento seguro que ya tenian los chats activos.
UPDATE public.agent_conversations
SET selected_agent = 'intake'
WHERE bot_enabled = true AND selected_agent IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_conversations_selected_agent
    ON public.agent_conversations(selected_agent)
    WHERE bot_enabled = true;

-- Punto unico para el boton del ERP. Evita el estado intermedio peligroso
-- de encender primero y elegir el agente en una segunda consulta.
CREATE OR REPLACE FUNCTION public.set_conversation_agent(
    p_conversation_id BIGINT,
    p_enabled BOOLEAN,
    p_selected_agent TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_enabled AND p_selected_agent NOT IN ('intake', 'sales') THEN
        RAISE EXCEPTION 'Al activar debe elegir intake o sales';
    END IF;

    UPDATE public.agent_conversations
    SET bot_enabled = p_enabled,
        selected_agent = CASE
            WHEN p_enabled THEN p_selected_agent
            ELSE selected_agent
        END,
        updated_at = NOW()
    WHERE id = p_conversation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Conversacion % no encontrada', p_conversation_id;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_conversation_agent(BIGINT, BOOLEAN, TEXT)
    TO authenticated;

COMMIT;
