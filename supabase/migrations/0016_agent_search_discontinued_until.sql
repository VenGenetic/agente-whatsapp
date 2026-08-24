-- Migration: el ERP no trata is_discontinued como "para siempre" -- la
-- lógica real (utils/discontinuedHelper.ts, isProductDiscontinued) es: si
-- tiene discontinued_until Y esa fecha ya pasó, el producto vuelve a
-- contar como activo automáticamente (descontinuación TEMPORAL). El
-- filtro de agent_search_products solo miraba el booleano is_discontinued
-- desde la migración 0001, ignorando la fecha -- un producto con
-- descontinuación temporal ya vencida seguía excluido de la búsqueda del
-- bot como si fuera permanente.
--
-- Auditado contra datos reales: hoy los 739 productos con
-- is_discontinued=true tienen discontinued_until en NULL (nadie usa la
-- descontinuación temporal todavía), así que este fix no cambia ningún
-- resultado actual -- es preventivo, para cuando alguien SÍ use esa
-- función del ERP (la UI la soporta explícitamente).
--
-- No cambia la firma ni el tipo de retorno -- solo el WHERE.
-- PROPUESTA — no aplicada todavía.

CREATE OR REPLACE FUNCTION public.agent_search_products(
    p_query TEXT,
    p_limit INT DEFAULT 5,
    p_fuzzy_query TEXT DEFAULT NULL,
    p_fuzzy_query_no_color TEXT DEFAULT NULL
)
RETURNS TABLE (
    product_id INTEGER,
    name TEXT,
    sku TEXT,
    price NUMERIC,
    image_url TEXT,
    local_stock INTEGER,
    importer_stock INTEGER,
    importer_unavailable_override BOOLEAN,
    match_confidence NUMERIC,
    matched_via TEXT
)
LANGUAGE sql
STABLE
AS $$
    WITH normalized AS (
        SELECT
            unaccent(lower(trim(p_query))) AS q,
            unaccent(lower(trim(COALESCE(p_fuzzy_query, p_query)))) AS fuzzy_q,
            unaccent(lower(trim(COALESCE(p_fuzzy_query_no_color, p_fuzzy_query, p_query)))) AS fuzzy_q_no_color
    ),
    alias_exact AS (
        SELECT a.product_id, 1.0::numeric AS score, 'alias_exact'::text AS matched_via
        FROM public.agent_product_aliases a, normalized n
        WHERE unaccent(lower(trim(a.alias))) = n.q
    ),
    fuzzy AS (
        SELECT
            p.id AS product_id,
            GREATEST(
                CASE WHEN
                    length(split_part(n.fuzzy_q, ' ', 1)) < 3
                    OR unaccent(p.name) ILIKE '%' || split_part(n.fuzzy_q, ' ', 1) || '%'
                THEN similarity(unaccent(p.name), n.fuzzy_q) ELSE 0 END,
                similarity(unaccent(p.sku), n.fuzzy_q),
                COALESCE(
                    (SELECT MAX(similarity(unaccent(a.alias), n.fuzzy_q))
                     FROM public.agent_product_aliases a
                     WHERE a.product_id = p.id),
                    0
                ),
                CASE WHEN (
                    SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                    FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                    WHERE length(word) >= 3
                ) THEN 0.85 ELSE 0 END,
                CASE WHEN
                    length(split_part(n.fuzzy_q, ' ', 1)) >= 3
                    AND unaccent(p.name) ILIKE split_part(n.fuzzy_q, ' ', 1) || '%'
                    AND (
                        SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                        FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                        WHERE length(word) >= 3
                    )
                THEN 0.9 ELSE 0 END,
                CASE WHEN (
                    SELECT bool_and(word_similarity(word, unaccent(p.name)) >= 0.5)
                    FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                    WHERE length(word) >= 3
                ) THEN 0.8 ELSE 0 END,
                CASE WHEN (
                    SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                    FROM unnest(string_to_array(n.fuzzy_q_no_color, ' ')) AS word
                    WHERE length(word) >= 3
                ) THEN 0.75 ELSE 0 END
            ) AS score,
            'fuzzy'::text AS matched_via
        FROM public.products p, normalized n
        WHERE (
              COALESCE(p.is_discontinued, false) = false
              OR (p.discontinued_until IS NOT NULL AND p.discontinued_until <= now())
          )
          AND COALESCE(p.is_active, true) = true
          AND (
              unaccent(p.name) % n.fuzzy_q
              OR unaccent(p.sku) % n.fuzzy_q
              OR EXISTS (
                  SELECT 1 FROM public.agent_product_aliases a
                  WHERE a.product_id = p.id AND unaccent(a.alias) % n.fuzzy_q
              )
              OR (
                  SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                  FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                  WHERE length(word) >= 3
              )
              OR (
                  SELECT bool_and(word_similarity(word, unaccent(p.name)) >= 0.5)
                  FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                  WHERE length(word) >= 3
              )
              OR (
                  SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                  FROM unnest(string_to_array(n.fuzzy_q_no_color, ' ')) AS word
                  WHERE length(word) >= 3
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
        COALESCE(p.importer_unavailable_override, false),
        r.score,
        CASE WHEN r.score >= 1.0 THEN 'alias_exact' ELSE 'fuzzy' END
    FROM ranked r
    JOIN public.products p ON p.id = r.product_id
    WHERE (
          COALESCE(p.is_discontinued, false) = false
          OR (p.discontinued_until IS NOT NULL AND p.discontinued_until <= now())
      )
      AND COALESCE(p.is_active, true) = true
    ORDER BY r.score DESC
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.agent_search_products(TEXT, INT, TEXT, TEXT) TO service_role, authenticated;
