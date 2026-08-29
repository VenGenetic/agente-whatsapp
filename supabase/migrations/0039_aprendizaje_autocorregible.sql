-- Hace el aprendizaje reversible, auditable y resistente a ejemplos malos.
BEGIN;

ALTER TABLE public.agent_learned_examples
    ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS times_used INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.agent_learned_examples DROP CONSTRAINT IF EXISTS agent_learned_examples_review_status_check;
ALTER TABLE public.agent_learned_examples ADD CONSTRAINT agent_learned_examples_review_status_check
    CHECK (review_status IN ('auto', 'approved', 'rejected', 'quarantined'));
ALTER TABLE public.agent_learned_examples DROP CONSTRAINT IF EXISTS agent_learned_examples_times_used_check;
ALTER TABLE public.agent_learned_examples ADD CONSTRAINT agent_learned_examples_times_used_check
    CHECK (times_used >= 0);

CREATE INDEX IF NOT EXISTS idx_agent_learned_examples_review
    ON public.agent_learned_examples(review_status, active);

CREATE OR REPLACE FUNCTION public.agent_refresh_learned_examples(p_limit INTEGER DEFAULT 5000)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_processed INTEGER;
BEGIN
    -- Si el humano borra/edita la fuente para que deje de ser valida, se retira.
    UPDATE public.agent_learned_examples e SET
        active = false, rejection_reason = 'source_invalid', updated_at = NOW()
    FROM public.agent_messages m
    WHERE m.id = e.source_message_id
      AND (m.direction <> 'outbound' OR m.action_taken IS DISTINCT FROM 'human_reply'
           OR m.deleted_at IS NOT NULL OR m.delivery_status = 'failed');

    -- Revalida los ejemplos automaticos. Las decisiones manuales se conservan.
    UPDATE public.agent_learned_examples SET
        active = false, rejection_reason = 'pending_refresh', updated_at = NOW()
    WHERE review_status IN ('auto', 'quarantined');

    WITH candidates AS (
        SELECT outm.id AS source_message_id, outm.conversation_id,
          regexp_replace(regexp_replace(regexp_replace(inm.body,
            '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', '[correo]', 'gi'),
            '(https?://|www\.)[^[:space:]]+', '[enlace]', 'gi'),
            '(\+?[0-9][0-9 ()-]{7,}[0-9])', '[telefono]', 'g') AS customer_text,
          regexp_replace(regexp_replace(regexp_replace(outm.body,
            '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', '[correo]', 'gi'),
            '(https?://|www\.)[^[:space:]]+', '[enlace]', 'gi'),
            '(\+?[0-9][0-9 ()-]{7,}[0-9])', '[telefono]', 'g') AS reply_text,
          outm.product_id,
          CASE WHEN correction.found THEN 0.300 WHEN positive.found THEN 0.850
               WHEN outm.product_id IS NOT NULL THEN 0.900 ELSE 0.700 END AS quality_score,
          COALESCE(correction.found, false) AS has_correction
        FROM public.agent_messages outm
        JOIN LATERAL (
          SELECT body, created_at FROM public.agent_messages
          WHERE conversation_id = outm.conversation_id AND direction = 'inbound'
            AND body IS NOT NULL AND deleted_at IS NULL AND created_at <= outm.created_at
          ORDER BY created_at DESC LIMIT 1
        ) inm ON true
        LEFT JOIN LATERAL (
          SELECT true AS found FROM public.agent_messages n
          WHERE n.conversation_id = outm.conversation_id AND n.direction = 'inbound'
            AND n.deleted_at IS NULL AND n.created_at > outm.created_at
            AND n.created_at <= outm.created_at + INTERVAL '2 hours'
            AND lower(trim(n.body)) ~ '^(no[, .!]|nop|incorrect|eso no|esta mal|está mal|te dije|no era|equivocad)'
          LIMIT 1
        ) correction ON true
        LEFT JOIN LATERAL (
          SELECT true AS found FROM public.agent_messages n
          WHERE n.conversation_id = outm.conversation_id AND n.direction = 'inbound'
            AND n.deleted_at IS NULL AND n.created_at > outm.created_at
            AND n.created_at <= outm.created_at + INTERVAL '2 hours'
            AND lower(trim(n.body)) ~ '^(gracias|perfecto|excelente|listo|dale|de acuerdo|ok|okay|si[, .!]|sí[, .!])'
          LIMIT 1
        ) positive ON true
        WHERE outm.direction = 'outbound' AND outm.action_taken = 'human_reply'
          AND outm.body IS NOT NULL AND outm.deleted_at IS NULL
          AND length(trim(outm.body)) BETWEEN 10 AND 600
          AND length(trim(inm.body)) BETWEEN 3 AND 500
          AND inm.created_at >= outm.created_at - INTERVAL '24 hours'
          AND COALESCE(outm.delivery_status, 'sent') <> 'failed'
          AND outm.body !~* '(\$|precio|cuesta|sale en|descuento|transferencia|cuenta bancaria|deposito|depósito|cedula|cédula|direccion|dirección|ubicacion|ubicación|garantia|garantía|devolucion|devolución|reclamo|contraseña|clave|token)'
          AND (inm.body || ' ' || outm.body) !~* '(ignora (las )?instrucciones|ignore (all |the )?(previous )?instructions|system prompt|developer message|actua como|actúa como|revela (el )?prompt)'
        ORDER BY outm.created_at DESC
        LIMIT GREATEST(1, LEAST(p_limit, 5000))
    )
    INSERT INTO public.agent_learned_examples
      (source_message_id, conversation_id, customer_text, reply_text, product_id,
       quality_score, active, review_status, rejection_reason)
    SELECT source_message_id, conversation_id, customer_text, reply_text, product_id,
      quality_score, NOT has_correction,
      CASE WHEN has_correction THEN 'quarantined' ELSE 'auto' END,
      CASE WHEN has_correction THEN 'customer_correction' ELSE NULL END
    FROM candidates
    ON CONFLICT (source_message_id) DO UPDATE SET
      customer_text = EXCLUDED.customer_text, reply_text = EXCLUDED.reply_text,
      product_id = EXCLUDED.product_id, quality_score = EXCLUDED.quality_score,
      active = CASE WHEN agent_learned_examples.review_status = 'rejected' THEN false
                    WHEN agent_learned_examples.review_status = 'approved' THEN true
                    ELSE EXCLUDED.active END,
      review_status = CASE WHEN agent_learned_examples.review_status IN ('approved','rejected')
                           THEN agent_learned_examples.review_status ELSE EXCLUDED.review_status END,
      rejection_reason = CASE WHEN agent_learned_examples.review_status = 'rejected'
                              THEN agent_learned_examples.rejection_reason
                              WHEN agent_learned_examples.review_status = 'approved' THEN NULL
                              ELSE EXCLUDED.rejection_reason END,
      updated_at = NOW();
    GET DIAGNOSTICS v_processed = ROW_COUNT;
    RETURN v_processed;
END;
$$;

-- Cambia el contrato para devolver tambien el id usado en auditoria.
DROP FUNCTION IF EXISTS public.agent_find_learned_examples(TEXT, INTEGER);
CREATE FUNCTION public.agent_find_learned_examples(p_query TEXT, p_limit INTEGER DEFAULT 3)
RETURNS TABLE(id BIGINT, customer_text TEXT, reply_text TEXT, similarity_score NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT e.id, e.customer_text, e.reply_text,
    similarity(lower(e.customer_text), lower(trim(p_query)))::numeric AS similarity_score
  FROM public.agent_learned_examples e
  WHERE e.active = true AND e.review_status <> 'rejected'
    AND p_query IS NOT NULL AND length(trim(p_query)) >= 3
    AND similarity(lower(e.customer_text), lower(trim(p_query))) >= 0.20
  ORDER BY similarity(lower(e.customer_text), lower(trim(p_query))) DESC,
           e.quality_score DESC, e.id DESC
  LIMIT GREATEST(1, LEAST(p_limit, 5));
$$;

CREATE OR REPLACE FUNCTION public.agent_record_learned_example_usage(p_ids BIGINT[])
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE public.agent_learned_examples
  SET times_used = times_used + 1, last_used_at = NOW()
  WHERE id = ANY(COALESCE(p_ids, ARRAY[]::BIGINT[])) AND active = true;
$$;

CREATE OR REPLACE FUNCTION public.agent_review_learned_example(
  p_example_id BIGINT, p_approved BOOLEAN, p_reason TEXT DEFAULT NULL
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.agent_learned_examples SET active = p_approved,
    review_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
    rejection_reason = CASE WHEN p_approved THEN NULL ELSE COALESCE(NULLIF(trim(p_reason), ''), 'manual_review') END,
    updated_at = NOW()
  WHERE id = p_example_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ejemplo de aprendizaje inexistente'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_record_learned_example_usage(BIGINT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_review_learned_example(BIGINT, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_record_learned_example_usage(BIGINT[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_review_learned_example(BIGINT, BOOLEAN, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_find_learned_examples(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_find_learned_examples(TEXT, INTEGER) TO service_role;

COMMIT;
