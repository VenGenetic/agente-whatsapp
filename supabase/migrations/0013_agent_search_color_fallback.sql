-- Migration: no todos los repuestos vienen en varios colores en este
-- catálogo (ej. ningún "espejo" tiene color en el nombre -- son un solo
-- producto). Si el cliente igual menciona un color ("espejos negros"), el
-- boost de "contiene todas las palabras" lo exige tal cual en el nombre --
-- como ningún espejo real lo tiene, esos candidatos reales pierden contra
-- lo que sea que matchee por similitud cruda (en un caso real, un producto
-- genérico corto llamado literalmente "ESPEJO" le ganó a los espejos GP1
-- de verdad, con stock, solo por la palabra "negro" de más).
--
-- Se agrega `p_fuzzy_query_no_color` (la consulta sin las palabras de
-- color, ver stripColor en src/utils/colors.ts) como un respaldo de menor
-- puntaje: si existe una variante que SÍ tiene el color en el nombre,
-- sigue ganando por el puntaje más alto de p_fuzzy_query normal; si no
-- existe ninguna, este respaldo igual encuentra el producto real en vez
-- de perderlo por una palabra que ese repuesto nunca iba a tener.
-- PROPUESTA — no aplicada todavía.

-- Mismo motivo que en la migración 0006: un parámetro nuevo hace que esto
-- sea un OVERLOAD, no un reemplazo -- hay que borrar la versión de 3
-- parámetros primero para que no queden las dos y PostgREST no sepa cuál
-- llamar ("function is not unique").
DROP FUNCTION IF EXISTS public.agent_search_products(TEXT, INT, TEXT);

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
                -- similarity() de nombre solo cuenta si el nombre contiene
                -- la primera palabra de la búsqueda (el tipo de pieza) --
                -- si no, un candidato no puede ganar puntaje alto solo por
                -- coincidir en palabras secundarias (modelo/color/etc.)
                -- mientras la pieza pedida ni aparece en el nombre.
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
                -- Contención de palabras: si TODAS las palabras de 3+
                -- letras de la consulta aparecen LITERALMENTE en el
                -- nombre, es un match relevante aunque el nombre sea largo.
                CASE WHEN (
                    SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                    FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                    WHERE length(word) >= 3
                ) THEN 0.85 ELSE 0 END,
                -- Igual que el de arriba, pero exige además que el nombre
                -- EMPIECE con la primera palabra -- desempata a favor del
                -- tipo de pieza correcto entre variantes que empatan 0.85.
                CASE WHEN
                    length(split_part(n.fuzzy_q, ' ', 1)) >= 3
                    AND unaccent(p.name) ILIKE split_part(n.fuzzy_q, ' ', 1) || '%'
                    AND (
                        SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                        FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                        WHERE length(word) >= 3
                    )
                THEN 0.9 ELSE 0 END,
                -- Tolerancia a errores de tipeo: cada palabra de 3+ letras
                -- de la consulta tiene que tener una similitud de
                -- trigramas razonable contra ALGUNA porción del nombre
                -- (no el nombre completo) -- por debajo del boost de
                -- containment literal, pero alcanza para no perder el
                -- producto por una letra de más/menos/cambiada.
                CASE WHEN (
                    SELECT bool_and(word_similarity(word, unaccent(p.name)) >= 0.5)
                    FROM unnest(string_to_array(n.fuzzy_q, ' ')) AS word
                    WHERE length(word) >= 3
                ) THEN 0.8 ELSE 0 END,
                -- Respaldo sin color: mismo chequeo de "contiene todas las
                -- palabras", pero sin exigir el color -- puntaje menor que
                -- el 0.85 con color, para que un producto que SÍ tiene el
                -- color puesto siga ganando cuando existe.
                CASE WHEN (
                    SELECT bool_and(unaccent(p.name) ILIKE '%' || word || '%')
                    FROM unnest(string_to_array(n.fuzzy_q_no_color, ' ')) AS word
                    WHERE length(word) >= 3
                ) THEN 0.75 ELSE 0 END
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
    ORDER BY r.score DESC
    LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION public.agent_search_products(TEXT, INT, TEXT, TEXT) TO service_role, authenticated;
