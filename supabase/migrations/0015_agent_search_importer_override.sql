-- Migration: el ERP tiene un flag manual `products.importer_unavailable_override`
-- ("Agotado en Importadora") para cuando el número de importer_stock NO es
-- confiable -- el propio código del ERP (utils/importerOverride.ts) lo dice
-- explícito: "el stock de la importadora no es confiable. No prometas
-- disponibilidad a esos clientes todavía", y hay un trigger de base
-- (trg_check_demand_stock_arrival) que revierte demandas de
-- 'stock_available' a 'pending_stock' cuando se prende este override.
--
-- El job de aviso de stock (stockNotificationJob.ts) ya está protegido
-- porque depende de ese trigger (solo procesa demandas en
-- 'stock_available'). Pero la búsqueda EN VIVO durante una conversación
-- (handleProductRequest) lee `products.importer_stock` directo, sin pasar
-- por ese mecanismo -- el bot podía confirmarle a un cliente que había
-- stock de importadora aunque el negocio ya lo hubiera marcado como no
-- confiable.
--
-- Se agrega la columna al resultado del RPC (decisión de qué hacer con
-- ella queda en TypeScript, no en SQL, mismo patrón que el resto del
-- matching). No cambia los parámetros de entrada -- solo agrega una
-- columna de salida, así que hace falta DROP porque Postgres no permite
-- cambiar el tipo de retorno de una función con CREATE OR REPLACE.
-- PROPUESTA — no aplicada todavía.

DROP FUNCTION IF EXISTS public.agent_search_products(TEXT, INT, TEXT, TEXT);

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
        COALESCE(p.importer_unavailable_override, false),
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
