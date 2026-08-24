/**
 * Reporte de "huecos" del agente -- para ir cerrando casos sin depender de
 * probar en vivo por WhatsApp cada vez. Junta:
 *
 *   1. Búsquedas de WhatsApp que no encontraron nada en el catálogo
 *      (lost_demand) -- candidatas a alias nuevo en agent_product_aliases,
 *      o a revisar si de verdad no se maneja ese repuesto.
 *   2. Escalamientos recientes por ambigüedad ("no entendí después de 2
 *      intentos") -- candidatos a nuevas entradas en
 *      agent_model_disambiguations o a nuevos agent_known_models.
 *   3. Otros escalamientos recientes (queja, descuento, urgente) -- solo
 *      para tener el panorama, no accionable desde acá.
 *
 * Misma data que el resumen diario automático por WhatsApp (ver
 * src/agent/gapsReportJob.ts) -- acá con más detalle, corrido a demanda.
 *
 * Uso: npm run gaps-report
 */
import { collectGapsReportData } from '../src/db/gapsReport.js'

function bar(count: number, max: number, width = 20): string {
  const filled = max > 0 ? Math.round((count / max) * width) : 0
  return '█'.repeat(filled) + '·'.repeat(width - filled)
}

const data = await collectGapsReportData()

console.log('=== Búsquedas sin resultado en el catálogo (últimos 30 días) ===\n')

if (data.topLostSearches.length === 0) {
  console.log('(sin búsquedas sin resultado en los últimos 30 días)')
} else {
  const max = data.topLostSearches[0].count
  for (const { term, count } of data.topLostSearches.slice(0, 25)) {
    console.log(`${bar(count, max)}  ${count.toString().padStart(3)}  ${term}`)
  }
  console.log(
    `\n${data.topLostSearches.length} término(s) distinto(s). Si uno se repite y SÍ existe en el catálogo con otro\n` +
      'nombre, agregalo como alias en agent_product_aliases. Si de verdad no se maneja, queda\n' +
      'como referencia de qué está pidiendo la gente.',
  )
}

console.log('\n=== Escalamientos recientes (últimos 30 días) ===\n')

for (const { reason, count } of data.escalationsByReason) {
  console.log(`${count.toString().padStart(3)}  ${reason}`)
}

if (data.ambiguousSnapshots.length > 0) {
  console.log('\n-- Últimos escalados por ambigüedad (candidatos a agent_model_disambiguations) --')
  for (const snapshot of data.ambiguousSnapshots) console.log(`  "${snapshot}"`)
}

console.log('\nListo.')
