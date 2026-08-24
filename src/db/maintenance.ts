import { supabase } from '../supabaseClient.js'

/**
 * Borra conversaciones que quedaron sin ningún mensaje.
 *
 * Se generan solas: cuando llega el eco de un mensaje que ya estaba
 * registrado, `upsertConversation` crea/actualiza la fila y el insert del
 * mensaje se descarta por duplicado -- queda la conversación sin
 * contenido. En una corrida real se juntaron 207, que ensucian la bandeja
 * y hacen ruido en cualquier análisis.
 *
 * NUNCA borra una conversación con el agente habilitado: eso es una
 * decisión explícita del negocio, aunque todavía no tenga mensajes.
 */
export async function borrarConversacionesVacias(): Promise<number> {
  const PAGINA = 1000

  const conversaciones: Array<{ id: number }> = []
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from('agent_conversations')
      .select('id')
      .eq('bot_enabled', false)
      .range(desde, desde + PAGINA - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    conversaciones.push(...data)
    if (data.length < PAGINA) break
  }
  if (conversaciones.length === 0) return 0

  const conMensajes = new Set<number>()
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from('agent_messages')
      .select('conversation_id')
      .range(desde, desde + PAGINA - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    for (const fila of data) conMensajes.add(fila.conversation_id)
    if (data.length < PAGINA) break
  }

  const vacias = conversaciones.filter((c) => !conMensajes.has(c.id)).map((c) => c.id)
  if (vacias.length === 0) return 0

  for (let i = 0; i < vacias.length; i += 500) {
    const { error } = await supabase.from('agent_conversations').delete().in('id', vacias.slice(i, i + 500))
    if (error) throw error
  }
  return vacias.length
}
