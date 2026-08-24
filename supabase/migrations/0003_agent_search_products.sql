-- Migration: RPC de búsqueda difusa de productos para el agente
-- PROPUESTA — no aplicada todavía.
--
-- Prioriza un alias exacto aprendido (agent_product_aliases) sobre la
-- búsqueda por similitud (pg_trgm, ya habilitado en esta base) contra
-- nombre, sku y alias parciales. Devuelve los datos que el agente necesita
-- para responder sin hacer una segunda consulta.

CREATE OR REPLACE FUNCTION public.agent_search_products(p_query TEXT, p_limit INT DEFAULT 5)
RETURNS TABLE (
    product_id INTEGER,
    name TEXT,
    sku TEXT,
    price NUMERIC,
    image_url TEXT,
    local_stock INTEGER,
    importer_stock INTEGER,
    match_confidence NUMERIC,
    matched_via TEXT
)
LANGUAGE sql
STABLE
AS $$
    WITH normalized AS (
        SELECT lower(trim(p_query)) AS q
    ),
    alias_exact AS (
        SELECT a.product_id, 1.0::numeric AS score, 'alias_exact'::text AS matched_via
        FROM public.agent_product_aliases a, normalized n
        WHERE lower(trim(a.alias)) = n.q
    ),
    fuzzy AS (
        SELECT
            p.id AS product_id,
            GREATEST(
                similarity(p.name, n.q),
                similarity(p.sku, n.q),
                COALESCE(
                    (SELECT MAX(similarity(a.alias, n.q))
                     FROM public.agent_product_aliases a
                     WHERE a.product_id = p.id),
                    0
                )
            ) AS score,
            'fuzzy'::text AS matched_via
        FROM public.products p, normalized n
        WHERE COALESCE(p.is_discontinued, false) = false
          AND (
              p.name % n.q
              OR p.sku % n.q
              OR EXISTS (
                  SELECT 1 FROM public.agent_product_aliases a
                  WHERE a.product_id = p.id AND a.alias % n.q
              )
          )
    ),
    ranked AS (
        SELECT product_id, MAX(score) AS score
        FROM (SELECT * FROM alias_exact UNION ALL SELECT * FROM fuzzy) combined
        GROUP BY product_id
    )
    SELECT
        p.id,
        p.name,
        p.sku,
        p.price,
        p.image_url,
        p.local_stock,
        p.importer_stock,
        r.score,
        CASE WHEN r.score >= 1.0 THEN 'alias_exact' ELSE 'fuzzy' END
    FROM ranked r
    JOIN public.products p ON p.id = r.product_id
    ORDER BY r.score DESC
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.agent_search_products(TEXT, INT) TO service_role, authenticated;
