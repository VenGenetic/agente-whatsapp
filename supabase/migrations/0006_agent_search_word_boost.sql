-- Migration: la búsqueda difusa no encontraba productos con nombres muy
-- largos (varios modelos compatibles listados) aunque TODAS las palabras
-- de la consulta estuvieran presentes, porque similarity() de pg_trgm
-- penaliza fuerte la diferencia de longitud entre la consulta corta y un
-- nombre largo. Se agrega un boost: si cada palabra significativa de la
-- consulta aparece en el nombre del producto (contención simple, no
-- similitud), se le da un puntaje alto aunque el nombre sea largo.
--
-- `p_query` queda IGUAL a como lo escribió/normalizó el cliente -- el
-- match exacto de alias (agent_product_aliases) sigue comparando contra
-- esto, tal cual. `p_fuzzy_query` es opcional: el código puede mandar una
-- versión con sinónimos/abreviaturas del catálogo agregados (ej.
-- "delantero" -> también agrega "del") SOLO para la búsqueda difusa, sin
-- romper alias ya aprendidos que contengan la palabra completa.
-- PROPUESTA — no aplicada todavía.

-- Postgres identifica una función por nombre + tipos de parámetros -- como
-- se agrega un parámetro nuevo, esto sería un OVERLOAD, no un reemplazo.
-- La borramos primero para que quede una sola versión (si no, PostgREST no
-- sabe cuál de las dos llamar y tira "function is not unique").
DROP FUNCTION IF EXISTS public.agent_search_products(TEXT, INT);

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
            lower(trim(p_query)) AS q,
            lower(trim(COALESCE(p_fuzzy_query, p_query))) AS fuzzy_q
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
                similarity(p.name, n.fuzzy_q),
                similarity(p.sku, n.fuzzy_q),
                COALESCE(
                    (SELECT MAX(similarity(a.alias, n.fuzzy_q))
                     FROM public.agent_product_aliases a
                     WHERE a.product_id = p.id),
                    0
                ),
                -- Contención de palabras: si TODAS las palabras de 3+
                -- letras de la consulta aparecen en el nombre, es un match
                -- relevante aunque el nombre sea largo y la similitud de
                -- texto completo salga baja por eso.
                CASE WHEN (
                    SELECT bool_and(p.name ILIKE '%' || word || '%')
                    FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                    WHERE length(word) >= 3
                ) THEN 0.85 ELSE 0 END
            ) AS score,
            'fuzzy'::text AS matched_via
        FROM public.products p, normalized n
        WHERE COALESCE(p.is_discontinued, false) = false
          AND (
              p.name % n.fuzzy_q
              OR p.sku % n.fuzzy_q
              OR EXISTS (
                  SELECT 1 FROM public.agent_product_aliases a
                  WHERE a.product_id = p.id AND a.alias % n.fuzzy_q
              )
              OR (
                  SELECT bool_and(p.name ILIKE '%' || word || '%')
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
