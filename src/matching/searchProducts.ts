import { config } from '../config.js'
import { supabase } from '../supabaseClient.js'
import { stripColor } from '../utils/colors.js'

/**
 * El catálogo abrevia sistemáticamente la posición de la pieza -- "ARO DEL
 * MAGNECIO..." (delantero) / "ARO POST MAGNECIO..." (posterior/trasero).
 * El cliente casi nunca escribe la abreviatura, así que sin esto la
 * búsqueda difusa pierde productos reales solo por esa diferencia de forma.
 */
const CATALOG_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bDELANTEROS?\b/i, 'DEL'],
  [/\bDELANTERAS?\b/i, 'DEL'],
  [/\bTRASEROS?\b/i, 'POST'],
  [/\bTRASERAS?\b/i, 'POST'],
  [/\bPOSTERIORES?\b/i, 'POST'],
]

/**
 * Palabras que el cliente dice pero que casi nunca aparecen tal cual en
 * products.name -- "daytona" es la marca, no un modelo, y como el 100% del
 * catálogo es Daytona no distingue nada. Con el boost de "contiene todas
 * las palabras" activo, dejarla en la consulta difusa hace que ese boost
 * NUNCA se dispare (ningún producto la tiene), empeorando el resultado en
 * vez de ayudar -- se saca solo para la búsqueda, no para lo que se le
 * muestra al cliente.
 */
const SEARCH_NOISE_WORDS = [
  /\bDAYTONA\b/i,
  // Palabras genéricas de "quiero un repuesto" que el cliente dice pero
  // que ningún producto tiene literalmente en el nombre (se nombran por
  // la pieza específica: "CIGUEÑAL", "FILTRO ACEITE", nunca "REPUESTO")
  // -- si quedan como primera palabra de la consulta, el boost de
  // prefijo/contención nunca se dispara y un match real termina con
  // puntaje 0 en vez de encontrarse.
  /\bREPUESTOS?\b/i,
  /\bPIEZAS?\b/i,
  /\bPRODUCTOS?\b/i,
]

/**
 * Reemplaza (no agrega) la palabra completa por la abreviatura del
 * catálogo -- el boost de "contiene todas las palabras" exige que CADA
 * palabra de la consulta esté en el nombre, así que dejar "delantero" sin
 * tocar además de agregar "del" no sirve: "delantero" nunca va a estar en
 * el nombre igual, y sigue fallando el chequeo.
 */
function withCatalogAbbreviations(query: string): string {
  let result = query
  for (const [pattern, abbrev] of CATALOG_ABBREVIATIONS) {
    result = result.replace(pattern, abbrev)
  }
  for (const pattern of SEARCH_NOISE_WORDS) {
    result = result.replace(pattern, ' ')
  }
  return result.replace(/\s+/g, ' ').trim()
}

export type ProductMatch = {
  productId: number
  name: string
  sku: string
  price: number
  imageUrl: string | null
  localStock: number
  importerStock: number
  /**
   * Flag manual del ERP ("Agotado en Importadora") -- cuando está en true,
   * `importerStock` es un número que el negocio ya marcó como NO
   * confiable (dato del proveedor desactualizado/erróneo). No hay que
   * contarlo como stock real disponible.
   */
  importerUnavailable: boolean
  matchConfidence: number
  matchedVia: 'alias_exact' | 'fuzzy'
}

function mapRow(row: any): ProductMatch {
  return {
    productId: row.product_id,
    name: row.name,
    sku: row.sku,
    price: Number(row.price ?? 0),
    imageUrl: row.image_url,
    localStock: row.local_stock ?? 0,
    importerStock: row.importer_stock ?? 0,
    importerUnavailable: Boolean(row.importer_unavailable_override),
    matchConfidence: Number(row.match_confidence),
    matchedVia: row.matched_via,
  }
}

/**
 * Devuelve hasta `limit` candidatos (alias aprendidos primero, después
 * similitud pg_trgm sobre nombre/sku/alias), ordenados por confianza. Sirve
 * para detectar variantes hermanas (ej. mismo repuesto en varios colores),
 * no solo para quedarse con el mejor match.
 */
export async function findProductMatches(query: string, limit = 5): Promise<ProductMatch[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const fuzzyQuery = withCatalogAbbreviations(trimmed)

  // No todos los repuestos vienen en varios colores (ej. espejos: ninguno
  // en este catálogo tiene color en el nombre) -- si el cliente igual
  // menciona uno ("espejos negros"), exigirlo tal cual en el nombre deja
  // afuera los candidatos reales solo por esa palabra de más. Esta
  // versión sin color es un respaldo de menor puntaje (ver migración
  // 0013): si existe una variante que SÍ tiene el color, esa sigue
  // ganando por el puntaje más alto de p_fuzzy_query.
  const { data, error } = await supabase.rpc('agent_search_products', {
    p_query: trimmed,
    p_limit: limit,
    p_fuzzy_query: fuzzyQuery,
    p_fuzzy_query_no_color: stripColor(fuzzyQuery),
  })
  if (error) throw error
  return (data ?? []).map(mapRow)
}

/**
 * Busca el mejor match de producto para lo que el cliente pidió. Devuelve
 * null si nada supera el umbral mínimo de confianza -- eso es lo que
 * dispara la rama de "no existe en catálogo".
 */
export async function findBestProductMatch(query: string): Promise<ProductMatch | null> {
  const matches = await findProductMatches(query, 1)
  const best = matches[0]
  if (!best || best.matchConfidence < config.matchConfidenceThreshold) return null
  return best
}
