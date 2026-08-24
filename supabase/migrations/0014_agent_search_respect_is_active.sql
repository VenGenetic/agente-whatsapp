-- Migration: la búsqueda del agente solo filtraba is_discontinued, no
-- is_active -- que es el campo de BORRADO SUAVE que usa el ERP
-- (pages/Products.tsx: "eliminar" un producto hace
-- `.update({ is_active: false })`, y la propia lista de productos del ERP
-- filtra `.eq('is_active', true)`). Encontrado auditando: 320 productos
-- con is_active=false pero is_discontinued=false, al menos 1 con stock
-- real -- el bot podía seguir ofreciendo un producto que el negocio ya
-- "borró" desde el ERP.
--
-- COALESCE(..., true) igual que is_discontinued usa COALESCE(..., false)
-- -- por si hay filas viejas con is_active NULL, se tratan como activas
-- (no se excluyen de golpe productos sin este campo cargado).
--
-- No cambia la firma de la función (mismos parámetros) -- solo el WHERE.
--
-- De paso, se encontró que `alias_exact` (los alias curados a mano) NUNCA
-- filtraba is_discontinued/is_active -- ni en su propio WHERE ni en el
-- JOIN final. Un alias apuntando a un producto que se descontinuó o se
-- "borró" después de curado seguía resolviendo igual. Se agrega el mismo
-- filtro al SELECT final (cubre alias_exact Y fuzzy de una sola vez, en
-- vez de duplicarlo en cada CTE).
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
        WHERE COALESCE(p.is_discontinued, false) = false
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
        r.score,
        CASE WHEN r.score >= 1.0 THEN 'alias_exact' ELSE 'fuzzy' END
    FROM ranked r
    JOIN public.products p ON p.id = r.product_id
    WHERE COALESCE(p.is_discontinued, false) = false
      AND COALESCE(p.is_active, true) = true
    ORDER BY r.score DESC
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.agent_search_products(TEXT, INT, TEXT, TEXT) TO service_role, authenticated;
