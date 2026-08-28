import { supabase } from '../supabaseClient.js'

/**
 * Unifica los chats que quedaron partidos en dos filas: una identificada
 * por el teléfono y otra por el "ID interno" (LID) del mismo cliente. En
 * el ERP se veían como dos clientes distintos, con la conversación
 * repartida entre los dos.
 *
 * Por qué se parten: en un chat por LID, WhatsApp manda el teléfono real
 * solo en ALGUNOS mensajes (`remoteJidAlt`) y nunca en los propios. El
 * agente ya no crea filas nuevas así (`upsertConversation` resuelve por
 * LID, que sí viene siempre), pero siguen apareciendo pares viejos: un
 * duplicado latente se vuelve visible recién cuando esa persona escribe y
 * el mensaje trae las dos identidades juntas.
 *
 * Por eso vive acá y no solo en un script suelto: lo usan el job
 * periódico (`agent/mergeConversationsJob.ts`) y `npm run unificar-chats`,
 * para que no puedan divergir.
 */

export type Fila = {
  id: number
  phone_number: string
  lid: string | null
  chat_jid: string | null
  customer_name: string | null
  customer_id: number | null
  status: string
  bot_enabled: boolean
  selected_agent: 'intake' | 'sales' | null
  last_message_at: string | null
  unread_count: number
}

export type Par = { conTelefono: Fila; conLid: Fila }

const CAMPOS =
  'id, phone_number, lid, chat_jid, customer_name, customer_id, status, bot_enabled, selected_agent, last_message_at, unread_count'

/**
 * Los pares duplicados, buscados DENTRO de la base (migración 0029).
 *
 * Antes esto traía la tabla de conversaciones entera y cruzaba los pares
 * en JavaScript. Con 3.500 chats son ~875 KB por vuelta y casi siempre
 * para no encontrar nada -- corriendo seguido, varios GB de egress al mes,
 * o sea la cuota gratuita de Supabase gastada en no hacer nada. Filtrar
 * "los que tienen LID" tampoco alcanzaba: se midió, el 97% lo tiene.
 *
 * Ahora el cruce lo hace Postgres y por el cable viajan solo los pares:
 * casi siempre cero filas.
 *
 * Si la migración 0029 todavía no se aplicó, devuelve null en vez de
 * volver al escaneo completo: mejor no unificar por un rato que gastar
 * cuota sin que nadie lo pidiera.
 */
export async function detectarPares(): Promise<Par[] | null> {
  const { data, error } = await supabase.rpc('agent_chats_duplicados')

  if (error) {
    // La función no existe todavía (falta aplicar la migración). Hay que
    // mirar los DOS códigos: Postgres devuelve 42883, pero cuando el que
    // no la encuentra es PostgREST -- que resuelve por su propio caché de
    // esquema -- devuelve PGRST202 con otro texto ("Could not find the
    // function ... in the schema cache"). Contemplar solo el de Postgres
    // hacía que esto explotara cada media hora en vez de avisar y seguir.
    const faltaLaFuncion =
      error.code === '42883' ||
      error.code === 'PGRST202' ||
      /(does not exist|could not find the function)/i.test(error.message)
    if (faltaLaFuncion) {
      console.warn(
        'Falta aplicar supabase/migrations/0029_agent_chats_duplicados_rpc.sql: ' +
          'no se buscan chats duplicados (se evita a propósito el escaneo completo, que gasta cuota).',
      )
      return null
    }
    throw error
  }

  const parejas = (data ?? []) as Array<{ id_telefono: number; id_lid: number }>
  if (parejas.length === 0) return []

  // Recién ahora se traen las filas completas: son un puñado.
  const ids = [...new Set(parejas.flatMap((p) => [p.id_telefono, p.id_lid]))]
  const { data: filas, error: errorFilas } = await supabase
    .from('agent_conversations')
    .select(CAMPOS)
    .in('id', ids)
  if (errorFilas) throw errorFilas

  const porId = new Map<number, Fila>((filas ?? []).map((f) => [(f as Fila).id, f as Fila]))

  const pares: Par[] = []
  const usadas = new Set<number>()
  for (const p of parejas) {
    const conTelefono = porId.get(p.id_telefono)
    const conLid = porId.get(p.id_lid)
    if (!conTelefono || !conLid) continue
    // Un chat partido en tres se une de a dos, una vuelta por vez: unir
    // una fila dos veces en la misma pasada dejaría un id ya borrado.
    if (usadas.has(conTelefono.id) || usadas.has(conLid.id)) continue
    usadas.add(conTelefono.id)
    usadas.add(conLid.id)
    pares.push({ conTelefono, conLid })
  }
  return pares
}

export async function contarMensajes(conversationId: number): Promise<number> {
  const { count, error } = await supabase
    .from('agent_messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
  if (error) throw error
  return count ?? 0
}

/**
 * Estado que gana al unir. Si de un lado alguien ya estaba atendiendo, eso
 * pesa más que el estado por defecto: perderlo haría que el bot retome un
 * chat que una persona tiene tomado.
 */
const PRIORIDAD_ESTADO = ['bot_active', 'closed', 'escalated', 'human_active']
function estadoGanador(a: string, b: string): string {
  return PRIORIDAD_ESTADO.indexOf(a) >= PRIORIDAD_ESTADO.indexOf(b) ? a : b
}

/** Tablas que cuelgan de una conversación y hay que mudar antes de borrarla. */
const TABLAS_HIJAS = ['agent_messages', 'agent_escalations', 'agent_outbox'] as const

export type ResultadoMerge = { quedaId: number; sobraId: number; mensajesMovidos: number; telefono: string }

/**
 * Une un par. Conserva la fila MÁS VIEJA -- la que trae el historial --,
 * le pasa todo lo que colgaba de la otra, le pone el teléfono real y la
 * dirección de chat vigente, y borra la que quedó vacía.
 */
export async function unificarPar({ conTelefono, conLid }: Par): Promise<ResultadoMerge> {
  const [queda, sobra] = conLid.id < conTelefono.id ? [conLid, conTelefono] : [conTelefono, conLid]

  // Mudar lo que cuelga ANTES de borrar: las tablas hijas son ON DELETE
  // CASCADE, así que borrar primero se llevaría los mensajes puestos.
  //
  // Se repite hasta que no quede nada: entre la mudanza y el borrado puede
  // entrar un mensaje nuevo para la fila que se va, y el CASCADE lo
  // borraría sin dejar rastro. Con el reintento esa ventana se cierra.
  const mensajesMovidos = await contarMensajes(sobra.id)
  for (let vuelta = 1; vuelta <= 3; vuelta++) {
    for (const tabla of TABLAS_HIJAS) {
      const { error } = await supabase
        .from(tabla)
        .update({ conversation_id: queda.id })
        .eq('conversation_id', sobra.id)
      if (error) throw new Error(`moviendo ${tabla} de ${sobra.id} a ${queda.id}: ${error.message}`)
    }
    if ((await contarMensajes(sobra.id)) === 0) break
  }

  const { error: errorBorrado } = await supabase.from('agent_conversations').delete().eq('id', sobra.id)
  if (errorBorrado) throw new Error(`borrando conv ${sobra.id}: ${errorBorrado.message}`)

  // La dirección a la que hay que ESCRIBIRLE es la del chat que WhatsApp
  // usa ahora, o sea la de la fila con actividad más reciente. Tomar
  // siempre la de la fila del teléfono mandaba a la dirección VIEJA
  // (`@s.whatsapp.net`) en los chats que WhatsApp migró a LID: el envío no
  // falla, WhatsApp lo acepta y lo tira al vacío (ver migración 0022).
  const masReciente =
    (conLid.last_message_at ?? '') >= (conTelefono.last_message_at ?? '') ? conLid : conTelefono
  const fechas = [queda.last_message_at, sobra.last_message_at].filter(Boolean) as string[]

  const { error: errorUpdate } = await supabase
    .from('agent_conversations')
    .update({
      phone_number: conTelefono.phone_number,
      lid: conLid.lid ?? conLid.phone_number,
      chat_jid: masReciente.chat_jid ?? conLid.chat_jid ?? conTelefono.chat_jid,
      customer_name: queda.customer_name ?? sobra.customer_name,
      customer_id: queda.customer_id ?? sobra.customer_id,
      status: estadoGanador(queda.status, sobra.status),
      // Si en cualquiera de las dos alguien había encendido el agente a
      // mano, se respeta: apagarlo en silencio rompería lo que el negocio
      // ya había decidido para ese cliente.
      bot_enabled: queda.bot_enabled || sobra.bot_enabled,
      // Conserva la eleccion del chat que queda; si no tenia, toma la del
      // duplicado. Nunca inventa un agente al fusionar.
      selected_agent: queda.selected_agent ?? sobra.selected_agent,
      unread_count: Math.max(queda.unread_count ?? 0, sobra.unread_count ?? 0),
      last_message_at: fechas.length ? fechas.sort().at(-1) : null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', queda.id)
  if (errorUpdate) throw new Error(`actualizando conv ${queda.id}: ${errorUpdate.message}`)

  return { quedaId: queda.id, sobraId: sobra.id, mensajesMovidos, telefono: conTelefono.phone_number }
}
