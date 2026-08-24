-- Migration: "tanque" (el tanque de gasolina) perdía el ranking contra
-- "PLACA TANQUE"/"CUBRE TANQUE" (accesorios, no el tanque en sí) cuando
-- ambos empataban en el boost de "contiene todas las palabras" (0.85) --
-- el empate lo desempataba el orden interno de Postgres, no la relevancia
-- real. En este catálogo el nombre del producto siempre arranca con el
-- tipo de pieza ("TANQUE GASOLINA...", "PLACA TANQUE...", "ARO DEL...."),
-- así que si el nombre EMPIEZA con la primera palabra de la búsqueda es la
-- pieza correcta con más probabilidad que una donde esa palabra aparece
-- después calificando otra cosa. Boost más alto que el de "contiene todas
-- las palabras" para que gane ese empate.
-- PROPUESTA — no aplicada todavía.

CREATE OR REPLACE FUNCTION public.agent_search_products(
    p_query TEXT,
    p_limit INT DEFAULT 5,
    p_fuzzy_query TEXT DEFAULT NULL
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
            unaccent(lower(trim(COALESCE(p_fuzzy_query, p_query)))) AS fuzzy_q
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
                similarity(unaccent(p.name), n.fuzzy_q),
                similarity(unaccent(p.sku), n.fuzzy_q),
                COALESCE(
                    (SELECT MAX(similarity(unaccent(a.alias), n.fuzzy_q))
                     FROM public.agent_product_aliases a
                     WHERE a.product_id = p.id),
                    0
                ),
                -- Contención de palabras: si TODAS las palabras de 3+
                -- letras de la consulta aparecen en el nombre, es un match
                -- relevante aunque el nombre sea largo y la similitud de
                -- texto completo salga baja por eso.
                CASE WHEN (
                    SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                    FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                    WHERE length(word) >= 3
                ) THEN 0.85 ELSE 0 END,
                -- Igual que el boost de arriba, pero exige además que el
                -- nombre EMPIECE con la primera palabra de la búsqueda --
                -- desempata a favor del tipo de pieza correcto entre
                -- variantes que de otro modo quedan 0.85 contra 0.85.
                CASE WHEN
                    length(split_part(n.fuzzy_q, ' ', 1)) >= 3
                    AND unaccent(p.name) ILIKE split_part(n.fuzzy_q, ' ', 1) || '%'
                    AND (
                        SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                        FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                        WHERE length(word) >= 3
                    )
                THEN 0.9 ELSE 0 END
            ) AS score,
            'fuzzy'::text AS matched_via
        FROM public.products p, normalized n
        WHERE COALESCE(p.is_discontinued, false) = false
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

GRANT EXECUTE ON FUNCTION public.agent_search_products(TEXT, INT, TEXT) TO service_role, authenticated;
