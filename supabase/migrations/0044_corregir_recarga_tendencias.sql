BEGIN;

-- Algunos proyectos protegen DELETE sin una condición explícita. La función
-- anterior era correcta lógicamente, pero ese guardia la rechaza antes de
-- ejecutarla. El filtro cubre todos los tipos válidos de la tabla.
CREATE OR REPLACE FUNCTION public.agent_refresh_request_statistics()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_rows INTEGER;
BEGIN
    DELETE FROM public.agent_request_statistics
    WHERE stat_type IN ('model', 'part');

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

REVOKE ALL ON FUNCTION public.agent_refresh_request_statistics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_refresh_request_statistics() TO service_role;

COMMIT;
