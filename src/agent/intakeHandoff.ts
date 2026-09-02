/**
 * Lo que recibe el vendedor cuando el bot terminó de recibir al cliente.
 *
 * El modo recepción junta los datos (repuesto, marca, modelo, año, color)
 * y le pasa la conversación a una persona. Hasta acá el vendedor recibía
 * esos cinco campos y tenía que ir a buscar la pieza al catálogo él
 * mismo -- que es el trabajo que se quería ahorrar.
 *
 * Este módulo hace esa búsqueda antes de pasar el aviso, así el vendedor
 * abre el chat y ya sabe de qué producto se está hablando, con SKU,
 * precio y stock. La búsqueda es la MISMA que usa el modo completo
 * (`findProductMatches`), así que lo que ve el vendedor es exactamente lo
 * que habría contestado el bot si estuviera cotizando.
 *
 * La ayuda interna conserva todos los candidatos. Por separado, una regla
 * más estricta puede autorizar UNA sugerencia al cliente: foto y precio,
 * nunca stock. Todo lo que no pase esa regla queda para revisión humana.
 */

import { config } from '../config.js'
import {
  applyModelDefault,
  detectCatalogModels,
  detectKnownModels,
  getKnownModels,
  getModelDefaults,
} from '../matching/knownModels.js'
import { findProductMatches, type ProductMatch } from '../matching/searchProducts.js'
import { extractColor } from '../utils/colors.js'
import { roundedCustomerPrice } from '../utils/pricing.js'
import { formatIntakeSummary, type IntakeData } from './intake.js'

/** Cuántos candidatos se muestran. Va por WhatsApp: tiene que entrar de un vistazo. */
const CANDIDATOS = 5

/** Los nombres del catálogo son larguísimos (listan todos los modelos compatibles). */
const LARGO_NOMBRE = 70

/**
 * Valores que el modelo pone cuando el cliente dijo que no sabe o que le
 * da igual (ver el prompt de recepción). Son datos resueltos, pero no
 * sirven para buscar: meterlos en la consulta la ensucia.
 */
const SIN_DATO = new Set(['no sabe', 'no especifica', 'no aplica', 'ninguno'])

function util(valor: string | null): string | null {
  const limpio = valor?.trim()
  if (!limpio) return null
  return SIN_DATO.has(limpio.toLowerCase()) ? null : limpio
}

/**
 * Con qué se busca en el catálogo. La MARCA queda afuera a propósito: el
 * catálogo es casi todo Daytona (la búsqueda incluso descarta esa palabra
 * como ruido) y el nombre del producto se arma con el modelo, no con la
 * marca. Lo que discrimina es modelo + pieza + color.
 */
export async function consultaDeCatalogo(data: IntakeData): Promise<string | null> {
  const partes = [util(data.repuesto), util(data.modelo), util(data.color), util(data.posicion)].filter((p): p is string => !!p)
  if (partes.length === 0) return null

  const query = partes.join(' ')
  const knownModels = await getKnownModels()
  const defaults = await getModelDefaults()
  return applyModelDefault(query, knownModels, defaults)
}

export type CatalogLookup = {
  query: string | null
  /** Todos los candidatos suficientemente relevantes: ayuda para el humano. */
  matches: ProductMatch[]
  /** El único candidato que se puede mostrar automáticamente al cliente. */
  suggestion: ProductMatch | null
}

function keyColor(text: string | null): string | null {
  const color = text ? extractColor(text) : null
  if (!color) return null
  const keys: Record<string, string> = {
    NEGRA: 'NEGRO',
    BLANCA: 'BLANCO',
    ROJA: 'ROJO',
    AMARILLA: 'AMARILLO',
    DORADA: 'DORADO',
    PLATEADO: 'PLATA',
    PLATEADA: 'PLATA',
    CROMADA: 'CROMADO',
    MORADA: 'MORADO',
  }
  return keys[color] ?? color
}

type Position = 'left' | 'right' | 'front' | 'rear'

function positions(text: string | null): Set<Position> {
  const value = text?.toUpperCase() ?? ''
  const result = new Set<Position>()
  if (/\b(IZQ(?:UIERD[AO])?|LEFT)\b/.test(value)) result.add('left')
  if (/\b(DER(?:ECH[AO])?|RIGHT)\b/.test(value)) result.add('right')
  if (/\b(DEL(?:ANTER[AO])?|FRONT)\b/.test(value)) result.add('front')
  if (/\b(POST(?:ERIOR)?|TRASER[AO]|REAR)\b/.test(value)) result.add('rear')
  return result
}

function contradictsPosition(
  requested: Set<Position>,
  catalog: Set<Position>,
  first: Position,
  second: Position,
): boolean {
  const expected = [first, second].find((position) => requested.has(position))
  const listed = [first, second].find((position) => catalog.has(position))
  // Si el catálogo enumera ambos (una pieza que sirve a ambos lados o
  // posiciones), no hay una contradicción exclusiva que permita descartarla.
  const listsBoth = catalog.has(first) && catalog.has(second)
  return Boolean(expected && listed && expected !== listed && !listsBoth)
}

/**
 * La búsqueda puede servir para sugerir cosas al vendedor con una
 * coincidencia moderada; para mostrársela al cliente no. Además del score,
 * se rechaza cualquier contradicción explícita de modelo, color o posición.
 */
export function esSugerenciaDeCatalogoSegura(
  match: ProductMatch,
  data: IntakeData,
  knownModels: string[],
): boolean {
  if (!match.imageUrl || match.price <= 0) return false
  if (match.matchConfidence < config.catalogSuggestionConfidenceThreshold) return false

  const requestedColor = keyColor(data.color)
  const catalogColor = keyColor(match.name)
  if (requestedColor && catalogColor && requestedColor !== catalogColor) return false

  const requestedPositions = positions(data.posicion)
  const catalogPositions = positions(match.name)
  if (
    contradictsPosition(requestedPositions, catalogPositions, 'left', 'right') ||
    contradictsPosition(requestedPositions, catalogPositions, 'front', 'rear')
  ) return false

  // Un modelo conocido que contradice al que lista el producto es una señal
  // fuerte de pieza equivocada. Si el catálogo no nombra modelos, no se
  // adivina incompatibilidad: el vendedor humano lo valida al revisar stock.
  const requestedModels = detectKnownModels(data.modelo ?? '', knownModels)
  const catalogModels = detectCatalogModels(match.name, knownModels)
  if (
    requestedModels.length > 0 &&
    catalogModels.length > 0 &&
    !catalogModels.some((model) => requestedModels.includes(model))
  ) return false

  return true
}

/**
 * Busca primero con el nombre canónico que armó recepción. Ahí ya viven
 * los alias aprendidos, sinónimos y abreviaturas del catálogo; no se intenta
 * volver a traducir con una regla improvisada antes de consultar.
 */
export async function buscarCatalogoParaRecepcion(data: IntakeData): Promise<CatalogLookup> {
  const [query, knownModels] = await Promise.all([consultaDeCatalogo(data), getKnownModels()])
  if (!query) return { query: null, matches: [], suggestion: null }

  const matches = (await findProductMatches(query, CANDIDATOS)).filter(
    (match) => match.matchConfidence >= config.matchConfidenceThreshold,
  )
  const suggestion = matches.find((match) => esSugerenciaDeCatalogoSegura(match, data, knownModels)) ?? null
  return { query, matches, suggestion }
}

function stockDe(match: ProductMatch): string {
  // El flag "Agotado en Importadora" del ERP marca ese número como no
  // confiable -- mostrarlo como stock real haría que el vendedor prometa
  // algo que no existe.
  const importadora = match.importerUnavailable ? 'agotado' : String(match.importerStock)
  return `local ${match.localStock} / import. ${importadora}`
}

function lineaDe(match: ProductMatch, indice: number): string {
  const nombre =
    match.name.length > LARGO_NOMBRE ? `${match.name.slice(0, LARGO_NOMBRE - 1).trimEnd()}…` : match.name
  const confianza = Math.round(match.matchConfidence * 100)
  return `${indice + 1}. ${nombre}\n   ${match.sku} · $${roundedCustomerPrice(match.price)} · ${stockDe(match)} · ${confianza}%`
}

/**
 * El resumen completo para el vendedor: los datos que dio el cliente más
 * lo que hay en el catálogo que se le parece.
 *
 * NUNCA lanza. Si el catálogo no responde, el vendedor tiene que recibir
 * igual los datos del cliente -- que es lo que de verdad no se puede
 * perder. La búsqueda es una ayuda, no el mensaje.
 */
export function resumenParaElVendedorConCatalogo(data: IntakeData, catalogo: CatalogLookup): string {
  const datos = formatIntakeSummary(data)

  if (!catalogo.query) return datos

  if (catalogo.matches.length === 0) {
    return `${datos}\n\nEn catálogo: sin coincidencias para "${catalogo.query}" -- hay que revisarlo a mano.`
  }

  const aviso = catalogo.suggestion
    ? '\nHay una sugerencia segura disponible; confirmar stock real antes de vender.'
    : '\nNo se envió sugerencia automática: confirmar pieza, foto y stock antes de responder.'
  return `${datos}\n\nEn catálogo (buscado: "${catalogo.query}"):\n${catalogo.matches.slice(0, 3).map(lineaDe).join('\n')}${aviso}`
}

export async function resumenParaElVendedor(data: IntakeData): Promise<string> {
  try {
    return resumenParaElVendedorConCatalogo(data, await buscarCatalogoParaRecepcion(data))
  } catch (err) {
    console.error('No se pudo buscar en el catálogo para el resumen de recepción:', err)
    return formatIntakeSummary(data)
  }
}
