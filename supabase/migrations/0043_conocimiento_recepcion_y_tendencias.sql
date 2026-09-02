BEGIN;

-- Conocimiento que la recepción va acumulando. Las tendencias no son una
-- promesa de stock ni de compatibilidad: solo ayudan a entender cómo llaman
-- los clientes a los modelos y repuestos más habituales.
CREATE TABLE IF NOT EXISTS public.agent_request_statistics (
    stat_type TEXT NOT NULL CHECK (stat_type IN ('model', 'part')),
    term_key TEXT NOT NULL,
    term TEXT NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0),
    last_requested_at TIMESTAMPTZ NOT NULL,
    refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (stat_type, term_key)
);

COMMENT ON TABLE public.agent_request_statistics IS
    'Tendencias agregadas de las fichas de recepción: modelos y repuestos solicitados. No guarda ni clasifica clientes.';

ALTER TABLE public.agent_request_statistics ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read request statistics" ON public.agent_request_statistics;
CREATE POLICY "Authenticated read request statistics"
    ON public.agent_request_statistics FOR SELECT TO authenticated USING (true);

-- Conserva la manera textual en que un cliente nombró una pieza. Solo se
-- observa al quedar una ficha confirmada; dos observaciones iguales la
-- activan. Si dos nombres canónicos chocan, queda en cuarentena para que no
-- se convierta en conocimiento automático.
CREATE TABLE IF NOT EXISTS public.agent_part_aliases (
    alias TEXT PRIMARY KEY,
    canonical_part TEXT NOT NULL,
    observations INTEGER NOT NULL DEFAULT 1 CHECK (observations > 0),
    active BOOLEAN NOT NULL DEFAULT false,
    review_status TEXT NOT NULL DEFAULT 'auto'
        CHECK (review_status IN ('auto', 'approved', 'rejected', 'quarantined')),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.agent_part_aliases IS
    'Alias confirmados de nombres de repuestos. Nunca expresa equivalencias entre modelos ni disponibilidad.';

ALTER TABLE public.agent_part_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read part aliases" ON public.agent_part_aliases;
CREATE POLICY "Authenticated read part aliases"
    ON public.agent_part_aliases FOR SELECT TO authenticated USING (true);

-- La frase original se guarda en la ficha para que el aprendizaje posterior
-- pueda ser auditable. No se muestra al cliente ni se agrega al resumen del
-- vendedor.
ALTER TABLE public.agent_intake_requests
    ADD COLUMN IF NOT EXISTS repuesto_cliente TEXT;

COMMENT ON COLUMN public.agent_intake_requests.repuesto_cliente IS
    'Nombre o frase con que el cliente llamó al repuesto; sirve para aprender alias solo después de confirmar la ficha.';

CREATE OR REPLACE FUNCTION public.agent_refresh_request_statistics()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
    DELETE FROM public.agent_request_statistics;

    WITH source AS (
        SELECT
            NULLIF(regexp_replace(trim(modelo), '\s+', ' ', 'g'), '') AS model_term,
            NULLIF(regexp_replace(trim(repuesto), '\s+', ' ', 'g'), '') AS part_term,
            COALESCE(lista_at, updated_at, created_at) AS requested_at
        FROM public.agent_intake_requests
        WHERE estado <> 'descartada'
    ), aggregated AS (
        SELECT
            'model'::TEXT AS stat_type,
            lower(model_term) AS term_key,
            min(model_term) AS term,
            count(*)::INTEGER AS request_count,
            max(requested_at) AS last_requested_at
        FROM source
        -- Una cilindrada sola es un error de recepción, no un modelo para
        -- enseñarle al agente.
        WHERE model_term IS NOT NULL
          AND model_term !~ '^[0-9]+(\s*(cc|c\.c\.))?$'
        GROUP BY lower(model_term)

        UNION ALL

        SELECT
            'part'::TEXT AS stat_type,
            lower(part_term) AS term_key,
            min(part_term) AS term,
            count(*)::INTEGER AS request_count,
            max(requested_at) AS last_requested_at
        FROM source
        -- Una lista de varias piezas es una solicitud válida, pero no es un
        -- nombre de repuesto que convenga inyectar como vocabulario.
        WHERE part_term IS NOT NULL
          AND part_term !~ '[,;/]'
          AND part_term !~* '\s+y\s+'
        GROUP BY lower(part_term)
    )
    INSERT INTO public.agent_request_statistics
        (stat_type, term_key, term, request_count, last_requested_at, refreshed_at)
    SELECT stat_type, term_key, term, request_count, last_requested_at, NOW()
    FROM aggregated;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$$;

CREATE OR REPLACE FUNCTION public.agent_observe_part_alias(
    p_alias TEXT,
    p_canonical_part TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_alias TEXT := lower(regexp_replace(trim(COALESCE(p_alias, '')), '\s+', ' ', 'g'));
    v_part TEXT := trim(COALESCE(p_canonical_part, ''));
BEGIN
    IF length(v_alias) < 4 OR length(v_part) < 2 OR lower(v_part) = v_alias THEN
        RETURN;
    END IF;

    INSERT INTO public.agent_part_aliases(alias, canonical_part)
    VALUES (v_alias, v_part)
    ON CONFLICT (alias) DO UPDATE SET
        observations = CASE
            WHEN agent_part_aliases.canonical_part = EXCLUDED.canonical_part
                THEN agent_part_aliases.observations + 1
            ELSE 1
        END,
        canonical_part = CASE
            WHEN agent_part_aliases.review_status = 'approved'
                THEN agent_part_aliases.canonical_part
            ELSE EXCLUDED.canonical_part
        END,
        active = CASE
            WHEN agent_part_aliases.review_status = 'approved' THEN true
            WHEN agent_part_aliases.review_status = 'rejected' THEN false
            WHEN agent_part_aliases.canonical_part = EXCLUDED.canonical_part
                 AND agent_part_aliases.observations + 1 >= 2 THEN true
            ELSE false
        END,
        review_status = CASE
            WHEN agent_part_aliases.review_status IN ('approved', 'rejected')
                THEN agent_part_aliases.review_status
            WHEN agent_part_aliases.canonical_part = EXCLUDED.canonical_part
                THEN 'auto'
            ELSE 'quarantined'
        END,
        last_seen_at = NOW();
END;
$$;

-- Asociaciones revisadas en conversaciones recientes. Se activan desde el
-- inicio porque la pieza fue confirmada por el cliente antes de escalarla.
INSERT INTO public.agent_part_aliases(alias, canonical_part, observations, active, review_status)
VALUES
    ('placas del tanque', 'placa tanque', 2, true, 'approved'),
    ('plasticos del tanque', 'placa tanque', 2, true, 'approved'),
    ('cola atras donde va la placa', 'porta placa', 2, true, 'approved'),
    ('repuesto de la cola atras donde va la placa', 'porta placa', 2, true, 'approved'),
    ('tambor del cable que marca la velocidad', 'reenvío de velocímetro', 2, true, 'approved')
ON CONFLICT (alias) DO NOTHING;

REVOKE ALL ON FUNCTION public.agent_refresh_request_statistics() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_observe_part_alias(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_refresh_request_statistics() TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_observe_part_alias(TEXT, TEXT) TO service_role;

COMMIT;
