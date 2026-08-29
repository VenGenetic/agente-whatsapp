-- Activacion segura por conversacion y handoff entre recepcion/ventas.
BEGIN;

-- No puede existir un chat encendido sin agente elegido.
UPDATE public.agent_conversations
SET bot_enabled = false
WHERE bot_enabled = true AND selected_agent IS NULL;

ALTER TABLE public.agent_conversations
    DROP CONSTRAINT IF EXISTS agent_conversations_bot_requires_agent;
ALTER TABLE public.agent_conversations
    ADD CONSTRAINT agent_conversations_bot_requires_agent
    CHECK (NOT bot_enabled OR selected_agent IS NOT NULL);

CREATE OR REPLACE FUNCTION public.set_conversation_agent(
    p_conversation_id BIGINT,
    p_enabled BOOLEAN,
    p_selected_agent TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_etapa TEXT;
BEGIN
    IF p_enabled AND (p_selected_agent IS NULL OR p_selected_agent NOT IN ('intake', 'sales')) THEN
        RAISE EXCEPTION 'Al activar debe elegir intake o sales';
    END IF;

    SELECT etapa INTO v_etapa
    FROM public.agent_conversations
    WHERE id = p_conversation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Conversacion % no encontrada', p_conversation_id;
    END IF;

    UPDATE public.agent_conversations
    SET bot_enabled = p_enabled,
        selected_agent = CASE WHEN p_enabled THEN p_selected_agent ELSE selected_agent END,
        status = CASE WHEN p_enabled THEN 'bot_active' ELSE status END,
        etapa = CASE
            WHEN NOT p_enabled THEN etapa
            WHEN p_selected_agent = 'sales' THEN 'sales_in_progress'
            WHEN etapa IN ('human_assigned', 'resolved', 'ready_for_sales', 'sales_in_progress')
                THEN 'intake_in_progress'
            ELSE etapa
        END,
        updated_at = NOW()
    WHERE id = p_conversation_id;

    -- Al devolver el chat al bot, los escalamientos abiertos dejan de ser
    -- trabajo pendiente para una persona.
    IF p_enabled THEN
        UPDATE public.agent_escalations
        SET status = 'resolved', resolved_at = COALESCE(resolved_at, NOW())
        WHERE conversation_id = p_conversation_id
          AND status IN ('open', 'claimed');

        INSERT INTO public.agent_conversation_events (
            conversation_id, etapa_anterior, etapa_nueva, actor, motivo
        )
        SELECT p_conversation_id,
               v_etapa,
               etapa,
               'human',
               CASE p_selected_agent
                   WHEN 'sales' THEN 'Se activo la atencion completa desde el ERP'
                   ELSE 'Se activo la recepcion de informacion desde el ERP'
               END
        FROM public.agent_conversations
        WHERE id = p_conversation_id AND etapa IS DISTINCT FROM v_etapa;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_conversation_agent(BIGINT, BOOLEAN, TEXT)
    TO authenticated;

COMMIT;
