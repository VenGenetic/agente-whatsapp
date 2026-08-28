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
 * Nada de esto se le dice al cliente: el bot en modo recepción no habla
 * de precio ni de stock. Es información interna para el que atiende.
 */

import { config } from '../config.js'
import { applyModelDefault, getKnownModels, getModelDefaults } from '../matching/knownModels.js'
import { findProductMatches, type ProductMatch } from '../matching/searchProducts.js'
import { roundedCustomerPrice } from '../utils/pricing.js'
import { formatIntakeSummary, type IntakeData } from './intake.js'

/** Cuántos candidatos se muestran. Va por WhatsApp: tiene que entrar de un vistazo. */
const CANDIDATOS = 3

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
  const partes = [util(data.repuesto), util(data.modelo), util(data.color)].filter((p): p is string => !!p)
  if (partes.length === 0) return null

  const query = partes.join(' ')
  const knownModels = await getKnownModels()
  const defaults = await getModelDefaults()
  return applyModelDefault(query, knownModels, defaults)
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
export async function resumenParaElVendedor(data: IntakeData): Promise<string> {
  const datos = formatIntakeSummary(data)

  try {
    const query = await consultaDeCatalogo(data)
    if (!query) return datos

    const matches = (await findProductMatches(query, CANDIDATOS)).filter(
      (m) => m.matchConfidence >= config.matchConfidenceThreshold,
    )

    if (matches.length === 0) {
      return `${datos}\n\nEn catálogo: sin coincidencias para "${query}" -- hay que revisarlo a mano.`
    }

    return `${datos}\n\nEn catálogo (buscado: "${query}"):\n${matches.map(lineaDe).join('\n')}`
  } catch (err) {
    console.error('No se pudo buscar en el catálogo para el resumen de recepción:', err)
    return datos
  }
}
