import { supabase } from '../supabaseClient.js'
import { withRetry } from '../utils/withRetry.js'

export type ConversationRow = {
  id: number
  status: string
  /**
   * Permiso individual: el bot solo contesta en esta conversación si el
   * negocio lo habilitó a mano desde la bandeja del ERP. Arranca en false
   * para cada cliente nuevo (ver migración 0017).
   */
  botEnabled: boolean
  /** Agente elegido para este chat al activarlo desde el ERP. */
  selectedAgent: 'intake' | 'sales' | null
}

export type ContentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'system'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'other'

export type InboundMessageInput = {
  contentType: ContentType
  body: string | null
  whatsappMessageId: string | null
  /**
   * Copia de la foto/audio/archivo en Supabase Storage. Se llena aparte,
   * después de insertar la fila (ver whatsapp/inboundMedia.ts): la
   * descarga tarda y el registro del mensaje no debe esperarla.
   */
  mediaUrl?: string | null
  /**
   * Cuándo se mandó el mensaje según WhatsApp. Sin esto la fila queda con
   * la hora de INSERCIÓN, que no es lo mismo: al reconectar, WhatsApp
   * reentrega mensajes de rato antes y todos quedarían fechados en el
   * momento de la sincronización -- inservible para analizar la
   * conversación.
   */
  sentAt?: Date | null
}

type FilaIdentidad = { id: number; phone_number: string; lid: string | null }

/** Cuánto de la vista previa se guarda. Alcanza para dos líneas en la lista. */
const LARGO_PREVIEW = 120

/** Qué mostrar de un mensaje que no tiene texto. */
const PREVIEW_SIN_TEXTO: Partial<Record<ContentType, string>> = {
  image: '(foto)',
  audio: '(nota de voz)',
  video: '(video)',
  document: '(archivo)',
  sticker: '(sticker)',
  location: '(ubicación)',
  contact: '(contacto)',
}

/**
 * Deja en la conversación el texto del último mensaje, para que la lista
 * del ERP muestre de qué habla cada chat sin abrirlo (migración 0032).
 *
 * Se guarda acá en vez de consultarse al armar la lista porque PostgREST
 * no hace `DISTINCT ON`: sacar el último mensaje de 200 conversaciones
 * costaría cientos de filas por recarga, que es justo el gasto de cuota
 * que ya salió caro una vez.
 *
 * No lanza: es una comodidad para la lista. Que falle no puede tumbar el
 * registro del mensaje, que sí es el dato real.
 */
async function actualizarPreview(
  conversationId: number,
  direction: 'inbound' | 'outbound',
  body: string | null,
  contentType: ContentType,
): Promise<void> {
  // Todo el espacio en blanco se colapsa a uno solo: la vista previa es
  // UNA línea en la lista, y un mensaje con saltos de línea se guardaba
  // con ellos adentro. El CSS los disimula, pero el dato queda sucio y
  // recorta antes de lo que debería -- los saltos cuentan para el tope.
  const crudo = body?.trim() || PREVIEW_SIN_TEXTO[contentType]
  if (!crudo) return
  const texto = crudo.replace(/\s+/g, ' ').trim()
  if (!texto) return

  try {
    await supabase
      .from('agent_conversations')
      .update({
        last_message_preview: texto.slice(0, LARGO_PREVIEW),
        last_message_direction: direction,
      })
      .eq('id', conversationId)
  } catch {
    // Ver el comentario de arriba.
  }
}

/**
 * Conversación de un chat por LID.
 *
 * Busca por la columna `lid` y también por `phone_number = lid`: las filas
 * viejas guardaron los dígitos del LID en la columna del teléfono (era el
 * único identificador disponible cuando WhatsApp no compartía el número),
 * y siguen siendo la conversación buena de ese chat.
 */
async function buscarPorLid(lid: string): Promise<FilaIdentidad | null> {
  const { data, error } = await supabase
    .from('agent_conversations')
    .select('id, phone_number, lid')
    .or(`lid.eq.${lid},phone_number.eq.${lid}`)
    // La más vieja es la que tiene el historial: si por un duplicado
    // previo hubiera dos, se sigue usando esa y no se parte más el hilo.
    .order('id', { ascending: true })
    .limit(1)
  if (error) throw error
  return data?.[0] ?? null
}

async function buscarPorTelefono(phoneNumber: string): Promise<FilaIdentidad | null> {
  const { data, error } = await supabase
    .from('agent_conversations')
    .select('id, phone_number, lid')
    .eq('phone_number', phoneNumber)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/**
 * Crea la conversación si es la primera vez que escribe este número, o la
 * actualiza (last_message_at, y el nombre si vino uno nuevo) si ya existía.
 * No toca `status` -- eso lo maneja la lógica de escalamiento más adelante.
 */
export async function upsertConversation(
  phoneNumber: string,
  customerName: string | null,
  lid: string | null = null,
  /**
   * Dirección exacta del chat (remoteJid). Se guarda para poder responder
   * SIN reconstruirla: reconstruirla mal hizo que los mensajes a chats
   * por LID se perdieran en silencio (ver migración 0022).
   */
  chatJid: string | null = null,
): Promise<ConversationRow> {
  const now = new Date().toISOString()

  // En un chat por LID, el TELÉFONO no sirve como identidad: WhatsApp lo
  // manda solo en algunos mensajes (`remoteJidAlt`) y nunca en los
  // propios, así que un mismo chat entraba unas veces por el número y
  // otras por los dígitos del LID -- dos filas para el mismo cliente. El
  // LID sí viene en todos. Por eso, cuando hay LID, manda el LID.
  if (lid) {
    const existente = await buscarPorLid(lid)
    if (existente) {
      const cambios: Record<string, unknown> = { last_message_at: now, updated_at: now }
      if (customerName) cambios.customer_name = customerName
      if (chatJid) cambios.chat_jid = chatJid
      if (existente.lid !== lid) cambios.lid = lid

      // Recién ahora sabemos el teléfono real de un chat que se había
      // guardado con el LID en esa columna: se completa. Si otra fila ya
      // lo tiene, hay un duplicado viejo -- no se toca (chocaría con el
      // índice único) y se avisa para poder unificarlo.
      if (phoneNumber !== lid && existente.phone_number !== phoneNumber) {
        const otro = await buscarPorTelefono(phoneNumber)
        if (!otro) cambios.phone_number = phoneNumber
        else if (otro.id !== existente.id) {
          // Este mensaje es la ÚNICA fuente que sabe que este LID y este
          // teléfono son la misma persona: WhatsApp lo manda en
          // `remoteJidAlt` y no queda en ningún lado más. Si solo
          // avisáramos por consola, el dato se pierde al cerrar la
          // terminal y las dos filas quedan sin nada que las relacione --
          // pasó con un chat que WhatsApp migró de teléfono a LID
          // (`@s.whatsapp.net` -> `@lid`), donde ninguna columna las unía.
          //
          // Anotarlo en la fila del teléfono deja el par visible para
          // `npm run unificar-chats`, que es quien fusiona de verdad
          // (fusionar acá, en el camino de cada mensaje, arriesgaría
          // perder el mensaje que estamos guardando).
          if (otro.lid !== lid) {
            await supabase.from('agent_conversations').update({ lid }).eq('id', otro.id)
          }
          console.warn(
            `Chat duplicado: conv ${existente.id} (LID ${lid}) y conv ${otro.id} (tel ${phoneNumber}) ` +
              'son el mismo cliente. Unificalos con: npm run unificar-chats',
          )
        }
      }

      const { data, error } = await supabase
        .from('agent_conversations')
        .update(cambios)
        .eq('id', existente.id)
        .select('id, status, bot_enabled, selected_agent')
        .single()
      if (error) throw error
      return { id: data.id, status: data.status, botEnabled: Boolean(data.bot_enabled), selectedAgent: data.selected_agent }
    }
  }

  const { data, error } = await supabase
    .from('agent_conversations')
    .upsert(
      {
        phone_number: phoneNumber,
        ...(customerName ? { customer_name: customerName } : {}),
        ...(lid ? { lid } : {}),
        ...(chatJid ? { chat_jid: chatJid } : {}),
        last_message_at: now,
        updated_at: now,
      },
      { onConflict: 'phone_number' },
    )
    .select('id, status, bot_enabled, selected_agent')
    .single()

  if (error) throw error
  return { id: data.id, status: data.status, botEnabled: Boolean(data.bot_enabled), selectedAgent: data.selected_agent }
}

export async function logInboundMessage(
  conversationId: number,
  message: InboundMessageInput,
): Promise<void> {
  // Se reintenta porque un mensaje perdido no se recupera: si Supabase
  // parpadea justo acá, esa conversación queda incompleta para siempre.
  await withRetry(
    async () => {
      const { error } = await supabase.from('agent_messages').insert({
        conversation_id: conversationId,
        direction: 'inbound',
        content_type: message.contentType,
        body: message.body,
        whatsapp_message_id: message.whatsappMessageId,
        ...(message.mediaUrl ? { media_url: message.mediaUrl } : {}),
        ...(message.sentAt ? { created_at: message.sentAt.toISOString() } : {}),
      })

      // Un mensaje duplicado (mismo whatsapp_message_id) no debe tumbar el
      // proceso ni reintentarse -- Baileys reentrega eventos tras una
      // reconexión, y el duplicado significa que YA está guardado.
      if (error && error.code !== '23505') throw error
    },
    3,
    1000,
  )
  await actualizarPreview(conversationId, 'inbound', message.body, message.contentType)
}

export type ActionTaken =
  /** Lo escribió una PERSONA del equipo desde el teléfono, no el agente. */
  | 'human_reply'
  | 'answered_in_stock'
  | 'registered_demand'
  | 'demand_already_existed'
  | 'registered_lost_demand'
  | 'escalated'
  | 'asked_clarification'
  | 'greeting'
  | 'none'

/**
 * Quién escribió un mensaje saliente. Hace falta desde que hay dos
 * agentes automáticos: `action_taken` dice QUÉ se hizo, no QUIÉN lo
 * hizo, y sin esto no se puede auditar cuál de los dos mandó una
 * respuesta equivocada. Ver migración 0035.
 */
export type AgenteQueEscribe = 'intake' | 'sales' | 'human' | 'system'

export type OutboundMessageInput = {
  body: string
  productId?: number | null
  matchConfidence?: number | null
  actionTaken: ActionTaken
  /** Cuál de los agentes lo escribió. Ver `AgenteQueEscribe`. */
  agent?: AgenteQueEscribe
  contentType?: ContentType
  /**
   * Id del mensaje en WhatsApp. Guardarlo es lo que evita duplicados: el
   * propio envío del bot nos vuelve como eco `fromMe`, y el índice único
   * sobre esta columna hace que el eco se descarte solo.
   */
  whatsappMessageId?: string | null
  /** Ver InboundMessageInput.sentAt -- misma razón. */
  sentAt?: Date | null
  /**
   * URL pública de la foto/archivo que se mandó (bucket agent_chat_media,
   * o la del propio catálogo si salió de ahí). Es lo que deja al ERP
   * mostrar en el hilo lo mismo que recibió el cliente.
   */
  mediaUrl?: string | null
  /**
   * Seguir el acuse de recibo de WhatsApp para este mensaje.
   *
   * Por defecto se sigue todo lo que manda el agente, y NO lo marcado como
   * `human_reply` -- esos eran los mensajes escritos desde el teléfono del
   * vendedor, que ya salieron por su cuenta y no tenemos nada que
   * confirmar. Pero los que se escriben desde el ERP también son
   * `human_reply` y los enviamos NOSOTROS: ahí el acuse sí existe, y es
   * justo el dato que quiere ver quien escribió ("¿lo leyó?").
   */
  trackDelivery?: boolean
}

/**
 * Devuelve el id de la fila insertada, o null si el mensaje ya estaba
 * guardado (el eco de WhatsApp choca contra el índice único). La cola de
 * salida usa ese id para enlazar lo que encoló el ERP con el mensaje
 * real y no mostrarlo dos veces en el hilo.
 */
/**
 * Si la columna `agent` (migración 0035) todavía no existe, PostgREST
 * rechaza la fila ENTERA con 42703 -- no ignora el campo de más. O sea que
 * mandarla sin que exista no dejaría "sin autoría" al mensaje: lo dejaría
 * sin registrar, que es la única cosa de todo el sistema que no se puede
 * perder.
 *
 * Se descubre una sola vez, en el primer intento, y a partir de ahí se
 * omite. El proceso se reinicia después de correr la migración, así que
 * no hace falta volver a probar.
 */
let columnaAgenteDisponible = true

export async function logOutboundMessage(
  conversationId: number,
  message: OutboundMessageInput,
): Promise<number | null> {
  let insertedId: number | null = null
  await withRetry(
    async () => {
      const fila = () => ({
        conversation_id: conversationId,
        direction: 'outbound',
        content_type: message.contentType ?? 'text',
        body: message.body,
        product_id: message.productId ?? null,
        match_confidence: message.matchConfidence ?? null,
        action_taken: message.actionTaken,
        ...(message.agent && columnaAgenteDisponible ? { agent: message.agent } : {}),
        whatsapp_message_id: message.whatsappMessageId ?? null,
        ...(message.mediaUrl ? { media_url: message.mediaUrl } : {}),
        ...(message.sentAt ? { created_at: message.sentAt.toISOString() } : {}),
        // Arranca en 'pending': hasta que WhatsApp confirme, NO se puede
        // decir que el cliente lo recibió. Ver `trackDelivery`.
        ...((message.trackDelivery ?? message.actionTaken !== 'human_reply')
          ? { delivery_status: 'pending' }
          : {}),
      })

      // `maybeSingle` y no `single`: cuando el insert choca con el eco ya
      // guardado no vuelve ninguna fila, y `single` lo trataría como error.
      let { data, error } = await supabase.from('agent_messages').insert(fila()).select('id').maybeSingle()

      // PGRST204 y no 42703: en un INSERT, PostgREST usa ese código para
      // "esa columna no existe". Con el código equivocado acá, el mensaje
      // del cliente no se registraba -- que es lo único de todo el sistema
      // que no se puede perder.
      if ((error?.code === 'PGRST204' || error?.code === '42703') && message.agent && columnaAgenteDisponible) {
        console.warn(
          'Falta la migración 0035 (agent_messages.agent): se registra el mensaje sin anotar qué agente lo escribió. Reiniciá el agente después de correrla.',
        )
        columnaAgenteDisponible = false
        ;({ data, error } = await supabase.from('agent_messages').insert(fila()).select('id').maybeSingle())
      }

      // Duplicado por el eco de WhatsApp: no es un error, ya está registrado.
      if (error && error.code !== '23505') throw error
      insertedId = data?.id ?? null
    },
    3,
    1000,
  )
  await actualizarPreview(conversationId, 'outbound', message.body, message.contentType ?? 'text')
  return insertedId
}

/**
 * Estado de entrega real que reporta WhatsApp. Es lo que evita que el ERP
 * muestre como "respondido" algo que el cliente nunca recibió.
 */
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

/** Códigos de `proto.WebMessageInfo.Status` de WhatsApp. */
const CODIGO_A_ESTADO: Record<number, DeliveryStatus> = {
  0: 'failed', // ERROR
  1: 'pending', // PENDING
  2: 'sent', // SERVER_ACK
  3: 'delivered', // DELIVERY_ACK
  4: 'read', // READ
  5: 'read', // PLAYED (audio escuchado)
}

/**
 * Actualiza el acuse de recibo de un mensaje saliente. Solo avanza: si ya
 * está en 'read' no vuelve a 'delivered' (WhatsApp puede reenviar acuses
 * viejos y retroceder el estado confundiría al que mira el ERP).
 */
const ORDEN: DeliveryStatus[] = ['failed', 'pending', 'sent', 'delivered', 'read']

export async function updateDeliveryStatus(whatsappMessageId: string, statusCode: number): Promise<void> {
  const nuevo = CODIGO_A_ESTADO[statusCode]
  if (!nuevo) return

  const { data } = await supabase
    .from('agent_messages')
    .select('id, delivery_status')
    .eq('whatsapp_message_id', whatsappMessageId)
    .maybeSingle()
  if (!data) return

  const actual = data.delivery_status as DeliveryStatus | null
  if (actual && nuevo !== 'failed' && ORDEN.indexOf(nuevo) <= ORDEN.indexOf(actual)) return

  await supabase.from('agent_messages').update({ delivery_status: nuevo }).eq('id', data.id)
}

export type HistoryTurn = {
  direction: 'inbound' | 'outbound'
  body: string | null
  /** Sirve para saber que el cliente mandó una foto/audio y no solo texto. */
  contentType?: ContentType
}

/**
 * Últimos N mensajes de la conversación, en orden cronológico.
 *
 * Los mensajes de fallback ("tuvimos un problema técnico...", action_taken
 * = 'escalated') no son contenido real de la conversación -- son ruido
 * interno que confunde al intérprete sobre qué se le estaba preguntando al
 * cliente cuando el historial es largo y mezcla varios temas. Se piden más
 * filas de las que hacen falta para poder descartarlos y aun así completar
 * `limit` turnos reales.
 */
export async function getRecentHistory(conversationId: number, limit = 10): Promise<HistoryTurn[]> {
  const { data, error } = await supabase
    .from('agent_messages')
    .select('direction, body, action_taken, content_type')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit * 3)

  if (error) throw error
  return (data ?? [])
    .filter((row) => row.action_taken !== 'escalated')
    .slice(0, limit)
    .reverse()
    .map((row) => ({ direction: row.direction, body: row.body, contentType: row.content_type }))
}

/**
 * true si el último mensaje saliente de esta conversación fue un pedido de
 * aclaración -- es lo que decide si un intent "unclear" es el primer
 * intento (preguntamos) o el segundo (escalamos), sin necesitar un contador
 * aparte en el esquema.
 */
export async function lastReplyWasClarification(conversationId: number): Promise<boolean> {
  const { data, error } = await supabase
    .from('agent_messages')
    .select('action_taken')
    .eq('conversation_id', conversationId)
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data?.action_taken === 'asked_clarification'
}

/**
 * Estado actual de la conversación, releído de la base.
 *
 * Hace falta porque entre que llega un mensaje y se contesta pasan unos
 * segundos (se espera a que el cliente termine de escribir, ver
 * `agent/messageBuffer.ts`), y en ese rato alguien del equipo puede haber
 * tomado el chat o apagado el agente para ese cliente. Contestar con el
 * estado que se leyó al principio sería escribir por encima de una persona
 * que ya está atendiendo.
 */
export async function getConversationState(conversationId: number): Promise<ConversationRow | null> {
  const { data, error } = await supabase
    .from('agent_conversations')
    .select('id, status, bot_enabled, selected_agent')
    .eq('id', conversationId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return { id: data.id, status: data.status, botEnabled: Boolean(data.bot_enabled), selectedAgent: data.selected_agent }
}

export async function setConversationStatus(
  conversationId: number,
  status: 'bot_active' | 'escalated' | 'human_active' | 'closed',
): Promise<void> {
  const { error } = await supabase
    .from('agent_conversations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', conversationId)
  if (error) throw error
}
