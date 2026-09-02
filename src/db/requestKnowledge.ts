import { supabase } from '../supabaseClient.js'

export type RequestTrend = { term: string; count: number }

export type ReceptionKnowledge = {
  commonModels: RequestTrend[]
  commonParts: RequestTrend[]
  /** Alias ya confirmados; clave y valor normalizados para usar en código. */
  partAliases: Map<string, string>
}

const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_MODELS = 8
const MAX_PARTS = 12
const MAX_ALIASES = 40

let cached: { value: ReceptionKnowledge; fetchedAt: number } | null = null

function missingMigration(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST202' || error?.code === '42883' || error?.code === 'PGRST205' || error?.code === '42P01'
}

/** La misma forma que se guarda en `agent_part_aliases`. */
export function normalizePartAlias(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Tendencias agregadas y vocabulario verificado de recepción.
 *
 * No trae teléfonos, nombres de clientes, precios ni stock. Las tendencias
 * sirven únicamente para reconocer palabras frecuentes, jamás para deducir
 * que un cliente tiene una moto o que una pieza es compatible.
 */
export async function getReceptionKnowledge(): Promise<ReceptionKnowledge> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value

  const empty: ReceptionKnowledge = { commonModels: [], commonParts: [], partAliases: new Map() }
  const [statsResult, aliasesResult] = await Promise.all([
    supabase
      .from('agent_request_statistics')
      .select('stat_type, term, request_count')
      .in('stat_type', ['model', 'part'])
      .order('request_count', { ascending: false })
      .limit(MAX_MODELS + MAX_PARTS + 20),
    supabase
      .from('agent_part_aliases')
      .select('alias, canonical_part')
      .eq('active', true)
      .neq('review_status', 'rejected')
      .order('observations', { ascending: false })
      .limit(MAX_ALIASES),
  ])

  if (statsResult.error && !missingMigration(statsResult.error)) {
    console.warn('No se pudieron leer las tendencias de recepción:', statsResult.error.message)
  }
  if (aliasesResult.error && !missingMigration(aliasesResult.error)) {
    console.warn('No se pudieron leer los alias de repuestos:', aliasesResult.error.message)
  }

  const trends = statsResult.error ? [] : (statsResult.data ?? [])
  const commonModels = trends
    .filter((row) => row.stat_type === 'model')
    .slice(0, MAX_MODELS)
    .map((row) => ({ term: String(row.term), count: Number(row.request_count) }))
  const commonParts = trends
    .filter((row) => row.stat_type === 'part')
    .slice(0, MAX_PARTS)
    .map((row) => ({ term: String(row.term), count: Number(row.request_count) }))
  const partAliases = new Map(
    aliasesResult.error
      ? []
      : (aliasesResult.data ?? []).map((row) => [normalizePartAlias(String(row.alias)), String(row.canonical_part)]),
  )

  cached = { value: { commonModels, commonParts, partAliases }, fetchedAt: Date.now() }
  return cached.value
}

/** Recalcula las estadísticas desde las fichas, sin contar clientes. */
export async function refreshRequestStatistics(): Promise<number> {
  const { data, error } = await supabase.rpc('agent_refresh_request_statistics')
  if (error) {
    if (missingMigration(error)) return 0
    throw error
  }
  // La próxima recepción debe ver el resultado fresco.
  cached = null
  return Number(data ?? 0)
}

/**
 * Aprende un nombre de repuesto únicamente después de que el cliente
 * confirmó la ficha. La base exige dos observaciones coherentes antes de
 * activarlo para futuras conversaciones.
 */
export async function observeConfirmedPartAlias(alias: string | null | undefined, canonicalPart: string | null | undefined): Promise<void> {
  if (!alias || !canonicalPart) return
  const normalizedAlias = normalizePartAlias(alias)
  const normalizedCanonical = normalizePartAlias(canonicalPart)
  if (normalizedAlias.length < 4 || normalizedAlias === normalizedCanonical) return

  const { error } = await supabase.rpc('agent_observe_part_alias', {
    p_alias: normalizedAlias,
    p_canonical_part: canonicalPart.trim(),
  })
  if (error && !missingMigration(error)) {
    console.warn('No se pudo observar el alias confirmado de repuesto:', error.message)
  }
}
