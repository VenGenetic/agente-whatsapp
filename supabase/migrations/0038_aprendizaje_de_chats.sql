-- Aprendizaje automatico seguro desde respuestas humanas.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.agent_learned_examples (
    id BIGSERIAL PRIMARY KEY,
    source_message_id BIGINT NOT NULL UNIQUE REFERENCES public.agent_messages(id) ON DELETE CASCADE,
    conversation_id BIGINT NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
    customer_text TEXT NOT NULL,
    reply_text TEXT NOT NULL,
    product_id INTEGER REFERENCES public.products(id) ON DELETE SET NULL,
    quality_score NUMERIC(4,3) NOT NULL DEFAULT 0.700,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_learned_examples_customer_trgm
    ON public.agent_learned_examples USING gin (customer_text gin_trgm_ops)
    WHERE active = true;

ALTER TABLE public.agent_learned_examples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow authenticated read agent_learned_examples"
    ON public.agent_learned_examples;
CREATE POLICY "Allow authenticated read agent_learned_examples"
    ON public.agent_learned_examples FOR SELECT TO authenticated USING (true);

-- Incorpora pares cliente -> respuesta humana. Deliberadamente excluye
-- precios, descuentos, pagos, reclamos y datos logisticos: esos hechos no
-- deben convertirse en reglas por repeticion historica.
CREATE OR REPLACE FUNCTION public.agent_refresh_learned_examples(p_limit INTEGER DEFAULT 500)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_inserted INTEGER;
BEGIN
    WITH candidates AS (
        SELECT
            outm.id AS source_message_id,
            outm.conversation_id,
            regexp_replace(
                regexp_replace(inm.body, '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', '[correo]', 'gi'),
                '(\+?[0-9][0-9 ()-]{7,}[0-9])', '[telefono]', 'g'
            ) AS customer_text,
            regexp_replace(
                regexp_replace(outm.body, '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}', '[correo]', 'gi'),
                '(\+?[0-9][0-9 ()-]{7,}[0-9])', '[telefono]', 'g'
            ) AS reply_text,
            outm.product_id,
            CASE WHEN outm.product_id IS NOT NULL THEN 0.900 ELSE 0.700 END AS quality_score
        FROM public.agent_messages outm
        JOIN LATERAL (
            SELECT body, created_at
            FROM public.agent_messages
            WHERE conversation_id = outm.conversation_id
              AND direction = 'inbound'
              AND body IS NOT NULL
              AND created_at <= outm.created_at
            ORDER BY created_at DESC
            LIMIT 1
        ) inm ON true
        WHERE outm.direction = 'outbound'
          AND outm.action_taken = 'human_reply'
          AND outm.body IS NOT NULL
          AND length(trim(outm.body)) BETWEEN 10 AND 600
          AND length(trim(inm.body)) BETWEEN 3 AND 500
          AND inm.created_at >= outm.created_at - INTERVAL '24 hours'
          AND COALESCE(outm.delivery_status, 'sent') <> 'failed'
          AND outm.deleted_at IS NULL
          AND outm.body !~* '(\$|precio|cuesta|sale en|descuento|transferencia|cuenta bancaria|deposito|depósito|cedula|cédula|direccion|dirección|ubicacion|ubicación|garantia|garantía|devolucion|devolución|reclamo)'
          AND NOT EXISTS (
              SELECT 1 FROM public.agent_learned_examples e
              WHERE e.source_message_id = outm.id
          )
        ORDER BY outm.created_at
        LIMIT GREATEST(1, LEAST(p_limit, 2000))
    )
    INSERT INTO public.agent_learned_examples (
        source_message_id, conversation_id, customer_text, reply_text, product_id, quality_score
    )
    SELECT source_message_id, conversation_id, customer_text, reply_text, product_id, quality_score
    FROM candidates
    ON CONFLICT (source_message_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_find_learned_examples(
    p_query TEXT,
    p_limit INTEGER DEFAULT 3
)
RETURNS TABLE(customer_text TEXT, reply_text TEXT, similarity_score NUMERIC)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT e.customer_text,
           e.reply_text,
           similarity(lower(e.customer_text), lower(trim(p_query)))::numeric AS similarity_score
    FROM public.agent_learned_examples e
    WHERE e.active = true
      AND p_query IS NOT NULL
      AND length(trim(p_query)) >= 3
      AND similarity(lower(e.customer_text), lower(trim(p_query))) >= 0.20
    ORDER BY similarity(lower(e.customer_text), lower(trim(p_query))) DESC,
             e.quality_score DESC, e.id DESC
    LIMIT GREATEST(1, LEAST(p_limit, 5));
$$;

REVOKE ALL ON FUNCTION public.agent_refresh_learned_examples(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_refresh_learned_examples(INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.agent_find_learned_examples(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_find_learned_examples(TEXT, INTEGER) TO service_role;

COMMIT;
