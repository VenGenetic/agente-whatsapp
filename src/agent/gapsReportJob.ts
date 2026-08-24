import type { WASocket } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import { collectGapsReportData, formatGapsReportForWhatsApp } from '../db/gapsReport.js'
import { borrarConversacionesVacias } from '../db/maintenance.js'
import { supabase } from '../supabaseClient.js'
import { toWhatsAppJid } from '../utils/phone.js'

const REPORT_TYPE = 'gaps_report'

// Ecuador no usa horario de verano -- UTC-5 fijo todo el año, así que un
// offset constante alcanza (no hace falta una librería de timezones).
const ECUADOR_UTC_OFFSET_HOURS = -5

function ecuadorLocalDateAndHour(now: Date): { date: string; hour: number } {
  const local = new Date(now.getTime() + ECUADOR_UTC_OFFSET_HOURS * 60 * 60 * 1000)
  return { date: local.toISOString().slice(0, 10), hour: local.getUTCHours() }
}

/**
 * Manda un resumen diario (búsquedas sin resultado + escalamientos) al
 * dueño por WhatsApp, dentro de la ventana horaria configurada -- así no
 * depende de que alguien se acuerde de correr `npm run gaps-report`. Se
 * fija en `agent_report_log` para no mandarlo dos veces el mismo día: el
 * proceso se reinicia seguido (pruebas, deploys), y sin este chequeo en
 * base de datos se repetiría cada vez que el reinicio cae dentro de la
 * ventana horaria.
 */
export async function runGapsReportJob(sock: WASocket): Promise<void> {
  const { date, hour } = ecuadorLocalDateAndHour(new Date())
  if (hour !== config.gapsReportHour) return

  const { data: existing, error: findError } = await supabase
    .from('agent_report_log')
    .select('id')
    .eq('report_type', REPORT_TYPE)
    .eq('report_date', date)
    .maybeSingle()
  if (findError) throw findError
  if (existing) return

  // Mantenimiento diario, aprovechando que este job ya corre una vez al
  // día: las conversaciones vacías se acumulan solas (ver
  // borrarConversacionesVacias) y ensucian la bandeja.
  try {
    const borradas = await borrarConversacionesVacias()
    if (borradas > 0) console.log(`Mantenimiento: ${borradas} conversación(es) vacías borradas.`)
  } catch (err) {
    // No debe impedir que el resumen salga.
    console.error('Error en la limpieza de conversaciones vacías:', err)
  }

  const data = await collectGapsReportData()
  const text = formatGapsReportForWhatsApp(data)
  await sock.sendMessage(toWhatsAppJid(config.ownerPhoneNumber), { text })

  const { error: insertError } = await supabase
    .from('agent_report_log')
    .insert({ report_type: REPORT_TYPE, report_date: date })
  // Si ya lo insertó otro tick concurrente (23505 = unique violation), no es un error real.
  if (insertError && insertError.code !== '23505') throw insertError
}
