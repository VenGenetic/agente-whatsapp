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
   * Cuándo se mandó el mensaje según WhatsApp. Sin esto la fila queda con
   * la hora de INSERCIÓN, que no es lo mismo: al reconectar, WhatsApp
   * reentrega mensajes de rato antes y todos quedarían fechados en el
   * momento de la sincronización -- inservible para analizar la
   * conversación.
   */
  sentAt?: Date | null
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
    .select('id, status, bot_enabled')
    .single()

  if (error) throw error
  return { id: data.id, status: data.status, botEnabled: Boolean(data.bot_enabled) }
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

export type OutboundMessageInput = {
  body: string
  productId?: number | null
  matchConfidence?: number | null
  actionTaken: ActionTaken
  contentType?: ContentType
  /**
   * Id del mensaje en WhatsApp. Guardarlo es lo que evita duplicados: el
   * propio envío del bot nos vuelve como eco `fromMe`, y el índice único
   * sobre esta columna hace que el eco se descarte solo.
   */
  whatsappMessageId?: string | null
  /** Ver InboundMessageInput.sentAt -- misma razón. */
  sentAt?: Date | null
}

export async function logOutboundMessage(conversationId: number, message: OutboundMessageInput): Promise<void> {
  await withRetry(
    async () => {
      const { error } = await supabase.from('agent_messages').insert({
        conversation_id: conversationId,
        direction: 'outbound',
        content_type: message.contentType ?? 'text',
        body: message.body,
        product_id: message.productId ?? null,
        match_confidence: message.matchConfidence ?? null,
        action_taken: message.actionTaken,
        whatsapp_message_id: message.whatsappMessageId ?? null,
        ...(message.sentAt ? { created_at: message.sentAt.toISOString() } : {}),
        // Arranca en 'pending': hasta que WhatsApp confirme, NO se puede
        // decir que el cliente lo recibió. Los mensajes del vendedor
        // (human_reply) ya salieron de su teléfono, no hay nada que
        // confirmar de nuestro lado.
        ...(message.actionTaken === 'human_reply' ? {} : { delivery_status: 'pending' }),
      })

      // Duplicado por el eco de WhatsApp: no es un error, ya está registrado.
      if (error && error.code !== '23505') throw error
    },
    3,
    1000,
  )
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
