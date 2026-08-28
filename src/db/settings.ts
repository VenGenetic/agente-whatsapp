import { supabase } from '../supabaseClient.js'

// Cache: el ajuste se lee en CADA mensaje entrante, así que sin cache un
// negocio con mucho tráfico haría una consulta por mensaje. 60s mantiene
// el cambio desde el ERP prácticamente inmediato (es una acción manual,
// nadie mide el minuto) y recorta muchísimo las consultas.
const CACHE_TTL_MS = 60 * 1000

let cached: { enabled: boolean; fetchedAt: number } | null = null

/**
 * Interruptor MAESTRO del agente (`agent_settings`, migración 0018),
 * controlado desde el ERP. Es el primero de dos candados: además de esto,
 * cada conversación necesita su propio `bot_enabled`.
 *
 * Si la consulta falla, devuelve FALSE (no contestar) en vez de asumir
 * que estaba encendido -- ante la duda, el agente se queda callado.
 */
export async function isBotAutoReplyEnabled(): Promise<boolean> {
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.enabled

  const { data, error } = await supabase
    .from('agent_settings')
    .select('bot_auto_reply_enabled')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    console.error('No se pudo leer agent_settings (el agente NO va a contestar):', error.message)
    return false
  }

  const enabled = Boolean(data?.bot_auto_reply_enabled)
  cached = { enabled, fetchedAt: Date.now() }
  return enabled
}

/**
 * Qué agente puede contestar, leído de la base y no de una variable de
 * entorno.
 *
 * Hasta la migración 0035 esto era `AGENT_MODE` en el `.env`: global, y
 * cambiarlo exigía reiniciar el proceso. Ahora son dos interruptores
 * independientes, porque el punto de partida real del negocio es
 * "recepción automática + vendedor humano" y ese estado no se puede
 * expresar con un solo modo.
 *
 * El maestro (`bot_auto_reply_enabled`) sigue mandando por encima de los
 * dos: en false no contesta nadie.
 */
export type AgentesEncendidos = { recepcion: boolean; ventas: boolean }

let cachedAgentes: { valor: AgentesEncendidos; fetchedAt: number } | null = null

export async function agentesEncendidos(respaldo: AgentesEncendidos): Promise<AgentesEncendidos> {
  if (cachedAgentes && Date.now() - cachedAgentes.fetchedAt < CACHE_TTL_MS) return cachedAgentes.valor

  const { data, error } = await supabase
    .from('agent_settings')
    .select('intake_agent_enabled, sales_agent_enabled')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    // 42703 = falta la migración 0035. NO es un motivo para callar al
    // agente: se usa lo que diga AGENT_MODE, que es como venía
    // funcionando. Cualquier otro error sí es motivo para desconfiar, y
    // el respaldo es igual de conservador.
    if (error.code !== '42703') {
      console.error('No se pudo leer qué agentes están encendidos:', error.message)
    }
    return respaldo
  }

  const valor: AgentesEncendidos = {
    recepcion: Boolean(data?.intake_agent_enabled),
    ventas: Boolean(data?.sales_agent_enabled),
  }
  cachedAgentes = { valor, fetchedAt: Date.now() }
  return valor
}
