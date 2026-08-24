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
