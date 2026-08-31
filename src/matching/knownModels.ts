import { supabase } from '../supabaseClient.js'

const CACHE_TTL_MS = 5 * 60 * 1000

let cached: { names: string[]; fetchedAt: number } | null = null
let cachedDefaults: { map: Map<string, string>; fetchedAt: number } | null = null
let cachedDisambiguations: { list: ModelDisambiguation[]; fetchedAt: number } | null = null

/**
 * Familias cuyo nombre corto es a la vez un modelo propio. Una coincidencia
 * de "WOLF" dentro de "WOLF 250" no prueba compatibilidad con la Wolf 200;
 * lo mismo aplica entre Tekken y sus tres líneas. Se conservan los nombres
 * cortos cuando aparecen separados en una descripción compuesta.
 */
const MODEL_FAMILIES: Array<{ base: string; variants: string[] }> = [
  { base: 'WOLF', variants: ['WOLF 250', 'WOLF EVOLUTION', 'SUPER WOLF'] },
  { base: 'TEKKEN', variants: ['TEKKEN 250', 'TEKKEN EVO', 'TEKKEN DISCOVERY'] },
]

function escapedModel(model: string): string {
  return model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rangesOfModel(text: string, model: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  const pattern = new RegExp(`\\b${escapedModel(model)}\\b`, 'gi')
  for (const match of text.matchAll(pattern)) {
    if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

function baseAppearsSeparately(text: string, base: string, variants: string[]): boolean {
  const variantRanges = variants.flatMap((variant) => rangesOfModel(text, variant))
  return rangesOfModel(text, base).some((baseRange) =>
    !variantRanges.some((variantRange) => variantRange.start <= baseRange.start && variantRange.end >= baseRange.end),
  )
}

/**
 * Lista de modelos de moto conocidos (agent_known_models), para dar contexto
 * real al intérprete en vez de que dependa de lo que Gemini "sepa" sobre la
 * marca Daytona -- que puede confundirla con otra marca del mismo nombre.
 * Cachea 5 minutos: cambia poco, y así no se consulta en cada mensaje.
 */
export async function getKnownModels(): Promise<string[]> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.names
  }

  const { data, error } = await supabase.from('agent_known_models').select('name').order('name')
  if (error) {
    // Si falla la consulta, mejor seguir sin la lista que tumbar la interpretación entera.
    console.error('No se pudo cargar agent_known_models:', error.message)
    return cached?.names ?? []
  }

  cached = { names: (data ?? []).map((row) => row.name), fetchedAt: Date.now() }
  return cached.names
}

/**
 * Detecta si `text` menciona alguno de los modelos conocidos, como palabra
 * completa (así "force" no matchea dentro de "workforce" ni viceversa).
 * Ordena por longitud descendente para preferir el modelo más específico
 * cuando dos aparecen como substring uno del otro (ej. si el texto dijera
 * "workforce", eso tiene que ganarle a "force").
 */
export function detectKnownModel(text: string, knownModels: string[]): string | null {
  return detectKnownModels(text, knownModels)[0] ?? null
}

/**
 * Igual que `detectKnownModel`, pero devuelve TODOS los modelos conocidos
 * que aparecen en `text`, no solo el más largo. Hace falta para productos
 * compatibles con varios modelos a la vez (ej. "WOLF/ADV 200/MAVERICK/WOLF
 * 250/FEROCE/WOLF EVOLUTION/..."): si solo miráramos "el" modelo del
 * nombre, un cliente pidiendo "wolf" contra ese producto se marcaría como
 * modelo equivocado (por matchear "MAVERICK", el más largo) aunque WOLF
 * también sea válido para esa pieza.
 */
export function detectKnownModels(text: string, knownModels: string[]): string[] {
  const upper = text.toUpperCase()
  const sorted = [...knownModels].sort((a, b) => b.length - a.length)
  const found: string[] = []
  for (const model of sorted) {
    const family = MODEL_FAMILIES.find((candidate) => candidate.base === model)
    const knownVariants = family?.variants.filter((variant) => knownModels.includes(variant)) ?? []
    if (family && knownVariants.length > 0) {
      if (baseAppearsSeparately(upper, model, knownVariants)) found.push(model)
    } else if (rangesOfModel(upper, model).length > 0) {
      found.push(model)
    }
  }
  return found
}

/**
 * El catálogo conserva "TEKKEN" en muchos repuestos del modelo anterior.
 * Para una DESCRIPCIÓN de producto ese nombre equivale a Tekken 250; para
 * lo que escribe un cliente se usa detectKnownModels y sigue siendo una
 * consulta ambigua. Así no se vende una pieza de Evo/Discovery por error.
 */
export function detectCatalogModels(text: string, knownModels: string[]): string[] {
  const models = detectKnownModels(text, knownModels)
  if (!models.includes('TEKKEN') || !knownModels.includes('TEKKEN 250')) return models
  return [...new Set(models.map((model) => (model === 'TEKKEN' ? 'TEKKEN 250' : model)))]
}

/**
 * Variante por defecto de cada modelo (agent_model_defaults), para cuando
 * el cliente lo nombra pelado -- ej. "wolf" sin cilindraje normalmente es
 * la Wolf 200. Mismo cache de 5 minutos que getKnownModels.
 */
export async function getModelDefaults(): Promise<Map<string, string>> {
  if (cachedDefaults && Date.now() - cachedDefaults.fetchedAt < CACHE_TTL_MS) {
    return cachedDefaults.map
  }

  const { data, error } = await supabase.from('agent_model_defaults').select('model, default_variant')
  if (error) {
    console.error('No se pudo cargar agent_model_defaults:', error.message)
    return cachedDefaults?.map ?? new Map()
  }

  cachedDefaults = {
    map: new Map((data ?? []).map((row) => [row.model, row.default_variant])),
    fetchedAt: Date.now(),
  }
  return cachedDefaults.map
}

/**
 * Si `query` no menciona ningún número (cc, año, etc.) y nombra un modelo
 * que tiene variante por defecto configurada, se la agrega -- así "filtro
 * aire wolf" busca como "filtro aire wolf 200" en vez de dejar que la
 * similitud difusa elija cualquier cilindraje al azar. Si el cliente ya
 * puso un número, no se toca nada -- ya fue específico.
 */
export function applyModelDefault(query: string, knownModels: string[], defaults: Map<string, string>): string {
  if (/\d/.test(query)) return query
  const model = detectKnownModel(query, knownModels)
  if (!model) return query
  const defaultVariant = defaults.get(model)
  if (!defaultVariant) return query
  return `${query} ${defaultVariant}`
}

export type ModelDisambiguation = { models: string[]; hint: string }

/**
 * Combinaciones de modelos que, aunque el cliente ya nombró un modelo
 * conocido, siguen siendo ambiguas entre productos REALMENTE distintos --
 * ej. "wing evo" sin más es ambiguo entre Wing Evo (antes de 2024) y Wing
 * Evo 2 (desde 2024), dos diseños distintos, no la misma pieza compatible
 * con varios modelos. `models` guarda la combinación EXACTA que dispara la
 * pregunta -- si el cliente da algo más específico, ya no matchea. Mismo
 * cache de 5 minutos que getKnownModels.
 */
export async function getModelDisambiguations(): Promise<ModelDisambiguation[]> {
  if (cachedDisambiguations && Date.now() - cachedDisambiguations.fetchedAt < CACHE_TTL_MS) {
    return cachedDisambiguations.list
  }

  const { data, error } = await supabase.from('agent_model_disambiguations').select('models, question_hint')
  if (error) {
    console.error('No se pudo cargar agent_model_disambiguations:', error.message)
    return cachedDisambiguations?.list ?? []
  }

  cachedDisambiguations = {
    list: (data ?? []).map((row) => ({ models: [...row.models].sort(), hint: row.question_hint })),
    fetchedAt: Date.now(),
  }
  return cachedDisambiguations.list
}

/**
 * Compara el conjunto EXACTO de modelos detectados en el pedido contra las
 * combinaciones registradas -- si el cliente mencionó algo de más (otro
 * modelo, un año, un número), ya no es un match exacto y no se pregunta,
 * porque eso significa que ya fue lo bastante específico.
 */
export function findModelDisambiguation(
  queryModels: string[],
  disambiguations: ModelDisambiguation[],
): ModelDisambiguation | null {
  const sorted = [...queryModels].sort()
  return (
    disambiguations.find((d) => d.models.length === sorted.length && d.models.every((m, i) => m === sorted[i])) ??
    null
  )
}
