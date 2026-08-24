import { supabase } from '../supabaseClient.js'

const LOOKBACK_DAYS = 30

export type GapsReportSection = {
  topLostSearches: Array<{ term: string; count: number }>
  escalationsByReason: Array<{ reason: string; count: number }>
  ambiguousSnapshots: string[]
}

/**
 * Junta lost_demand (búsquedas de WhatsApp sin resultado en el catálogo) y
 * agent_escalations recientes -- la misma data que usa `npm run
 * gaps-report`, reusada acá para el resumen periódico por WhatsApp (ver
 * gapsReportJob.ts). Separado del formateo para que cada consumidor lo
 * presente a su manera (consola con barras, WhatsApp en texto plano).
 */
export async function collectGapsReportData(): Promise<GapsReportSection> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { data: lost, error: lostError } = await supabase
    .from('lost_demand')
    .select('search_term, created_at')
    .eq('channel', 'WHATSAPP')
    .gte('created_at', since)
  if (lostError) throw lostError

  const counts = new Map<string, number>()
  for (const row of lost ?? []) {
    const term = (row.search_term ?? '').trim().toLowerCase()
    if (!term) continue
    counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  const topLostSearches = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([term, count]) => ({ term, count }))

  const { data: escalations, error: escError } = await supabase
    .from('agent_escalations')
    .select('reason, message_snapshot, created_at')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
  if (escError) throw escError

  const byReason = new Map<string, number>()
  for (const row of escalations ?? []) byReason.set(row.reason, (byReason.get(row.reason) ?? 0) + 1)
  const escalationsByReason = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }))

  const ambiguousSnapshots = (escalations ?? [])
    .filter((r) => r.reason === 'ambiguous_after_retries')
    .slice(0, 10)
    .map((r) => r.message_snapshot ?? '')
    .filter(Boolean)

  return { topLostSearches, escalationsByReason, ambiguousSnapshots }
}

/** Versión corta en texto plano, pensada para un mensaje de WhatsApp. */
export function formatGapsReportForWhatsApp(data: GapsReportSection): string {
  const lines: string[] = [`Resumen del agente (últimos ${LOOKBACK_DAYS} días):`]

  if (data.topLostSearches.length === 0) {
    lines.push('', 'Búsquedas sin resultado: ninguna.')
  } else {
    lines.push('', `Búsquedas sin resultado (${data.topLostSearches.length} distintas), top 10:`)
    for (const { term, count } of data.topLostSearches.slice(0, 10)) {
      lines.push(`- ${term} (${count}x)`)
    }
  }

  if (data.escalationsByReason.length === 0) {
    lines.push('', 'Escalamientos: ninguno.')
  } else {
    lines.push('', 'Escalamientos por motivo:')
    for (const { reason, count } of data.escalationsByReason) {
      lines.push(`- ${reason}: ${count}`)
    }
  }

  if (data.ambiguousSnapshots.length > 0) {
    lines.push('', 'Mensajes que quedaron ambiguos:')
    for (const snapshot of data.ambiguousSnapshots) lines.push(`- "${snapshot}"`)
  }

  lines.push('', 'Reporte completo: npm run gaps-report')
  return lines.join('\n')
}
