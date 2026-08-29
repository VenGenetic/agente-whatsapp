import type { Chat, Contact, WAMessage } from '@whiskeysockets/baileys'
import { supabase } from '../supabaseClient.js'
import { normalizePhoneNumber } from '../utils/phone.js'
import { parseIncomingMessage } from '../whatsapp/parseMessage.js'

/**
 * Importación del history sync de WhatsApp (evento
 * `messaging-history.set`, que dispara al vincular un dispositivo) para
 * poder ANALIZAR las conversaciones -- nunca para procesarlas como
 * pedidos: acá no se llama a Gemini ni se contesta nada.
 *
 * TODO acá trabaja por LOTES a propósito. La primera versión hacía una
 * consulta por contacto y otra por chat; con los volúmenes reales que
 * manda WhatsApp (se midió: 4219 contactos y 4939 mensajes en un solo
 * evento) eso eran miles de consultas seguidas y la importación nunca
 * terminaba -- los mensajes no llegaban a guardarse nunca.
 */

/** Tope por consulta: Postgres/PostgREST se atragantan con listas enormes en un IN. */
const CHUNK = 500

function chunked<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

type FilaMensaje = {
  conversation_id: number
  direction: string
  content_type: string
  body: string | null
  whatsapp_message_id: string | null
  action_taken: string | null
  created_at: string
}

/**
 * Inserta los mensajes del historial salteando los que ya estaban.
 *
 * Por qué no un `upsert` con `onConflict: 'whatsapp_message_id'`, que es
 * lo natural: el índice único de esa columna es PARCIAL (`WHERE
 * whatsapp_message_id IS NOT NULL`, migración 0001). PostgREST manda el
 * `ON CONFLICT` sin repetir ese predicado y Postgres no puede inferir un
 * índice parcial sin él, así que TODO el lote moría con 42P10 ("there is
 * no unique or exclusion constraint matching the ON CONFLICT
 * specification"). Se midió en vivo al re-vincular: lotes de ~4700
 * mensajes descartados uno tras otro hasta perder el historial entero,
 * que WhatsApp manda una sola vez.
 *
 * La deduplicación se hace acá: se pregunta qué ids ya existen y se
 * insertan solo los nuevos. Más lento que un ON CONFLICT, pero funciona
 * con el esquema tal como está y no depende de que se aplique una
 * migración. La migración 0025 arregla el índice de todos modos; con ella
 * aplicada esto sigue siendo correcto, solo redundante.
 */
async function insertarSinDuplicar(rows: FilaMensaje[]): Promise<number> {
  if (rows.length === 0) return 0

  // 1) Qué ids ya están guardados.
  const ids = rows.map((r) => r.whatsapp_message_id).filter((id): id is string => !!id)
  const existentes = new Set<string>()
  for (const lote of chunked(ids)) {
    const { data, error } = await supabase
      .from('agent_messages')
      .select('whatsapp_message_id')
      .in('whatsapp_message_id', lote)
    if (error) throw error
    for (const fila of data ?? []) {
      if (fila.whatsapp_message_id) existentes.add(fila.whatsapp_message_id)
    }
  }

  // 2) Solo los nuevos, y sin repetidos DENTRO del propio lote: el history
  //    sync puede traer el mismo mensaje dos veces en una tanda, y el
  //    índice parcial lo rechazaría igual.
  const vistos = new Set<string>()
  const nuevos = rows.filter((r) => {
    const id = r.whatsapp_message_id
    if (!id) return true // sin id no hay con qué deduplicar; entra
    if (existentes.has(id) || vistos.has(id)) return false
    vistos.add(id)
    return true
  })
  if (nuevos.length === 0) return 0

  // 3) Insertar. Si aun así choca contra el índice único (una carrera con
  //    el flujo de mensajes nuevos), se reintenta el lote de a uno para
  //    guardar todo lo que sí se pueda en vez de perderlo entero.
  let insertados = 0
  for (const lote of chunked(nuevos)) {
    const { error, count } = await supabase.from('agent_messages').insert(lote, { count: 'exact' })
    if (!error) {
      insertados += count ?? lote.length
      continue
    }
    if (error.code !== '23505') throw error

    for (const fila of lote) {
      const { error: errorFila } = await supabase.from('agent_messages').insert(fila)
      if (!errorFila) insertados++
      else if (errorFila.code !== '23505') throw errorFila
    }
  }
  return insertados
}

/**
 * Mapa identificador -> id de conversación, creando las que falten.
 * `identifier` es el teléfono normalizado (solo dígitos) o, si el chat va
 * por LID, el LID.
 */
async function ensureConversations(
  identities: Array<{ identifier: string; lid: string | null; name: string | null; chatJid: string | null }>,
): Promise<Map<string, number>> {
  const byIdentifier = new Map<string, { lid: string | null; name: string | null; chatJid: string | null }>()
  for (const it of identities) {
    if (!it.identifier) continue
    const prev = byIdentifier.get(it.identifier)
    byIdentifier.set(it.identifier, {
      lid: it.lid ?? prev?.lid ?? null,
      name: it.name ?? prev?.name ?? null,
      chatJid: it.chatJid ?? prev?.chatJid ?? null,
    })
  }
  const identifiers = [...byIdentifier.keys()]
  const map = new Map<string, number>()
  if (identifiers.length === 0) return map

  // 1) Las que ya existen.
  const sinDireccion: Array<{ id: number; chatJid: string }> = []
  for (const group of chunked(identifiers)) {
    const { data, error } = await supabase
      .from('agent_conversations')
      .select('id, phone_number, chat_jid')
      .in('phone_number', group)
    if (error) throw error
    for (const row of data ?? []) {
      map.set(row.phone_number, row.id)
      // Fila vieja sin la dirección real del chat: se completa ahora que
      // el historial la trae. Sin `chat_jid` hay que RECONSTRUIR la
      // dirección al escribirle, y reconstruirla mal manda el mensaje al
      // vacío sin error (ver migración 0022) -- justo lo que le pasaría a
      // los jobs que escriben por su cuenta (recepción proactiva, avisos
      // de stock).
      const chatJid = byIdentifier.get(row.phone_number)?.chatJid
      if (!row.chat_jid && chatJid) sinDireccion.push({ id: row.id, chatJid })
    }
  }
  for (const fila of sinDireccion) {
    const { error } = await supabase
      .from('agent_conversations')
      .update({ chat_jid: fila.chatJid })
      .eq('id', fila.id)
      .is('chat_jid', null)
    if (error) throw error
  }
  if (sinDireccion.length > 0) {
    console.log(`History sync: ${sinDireccion.length} conversación(es) recuperaron la dirección real del chat.`)
  }

  // 2) Las que faltan, en lotes. `ignoreDuplicates` cubre la carrera con
  //    los mensajes en vivo, que pueden crear la misma conversación.
  const missing = identifiers.filter((id) => !map.has(id))
  for (const group of chunked(missing)) {
    const rows = group.map((identifier) => {
      const extra = byIdentifier.get(identifier)
      return {
        phone_number: identifier,
        ...(extra?.lid ? { lid: extra.lid } : {}),
        ...(extra?.name ? { customer_name: extra.name } : {}),
        ...(extra?.chatJid ? { chat_jid: extra.chatJid } : {}),
      }
    })
    const { error } = await supabase
      .from('agent_conversations')
      .upsert(rows, { onConflict: 'phone_number', ignoreDuplicates: true })
    if (error) throw error
  }

  // 3) Releer las nuevas para tener sus ids.
  for (const group of chunked(missing)) {
    const { data, error } = await supabase
      .from('agent_conversations')
      .select('id, phone_number')
      .in('phone_number', group)
    if (error) throw error
    for (const row of data ?? []) map.set(row.phone_number, row.id)
  }

  return map
}

/**
 * Guarda el nombre de los contactos que reporta WhatsApp, para que en el
 * ERP se vea quién es cada cliente y no solo el número.
 *
 * `name` es el nombre que el negocio tiene guardado en su agenda;
 * `notify` es el que el cliente se puso a sí mismo. Se prefiere el de la
 * agenda porque suele ser más útil ("Juan repuestos" vs "🔥JR🔥").
 * Nunca pisa un nombre ya guardado con uno vacío.
 */
export async function syncContactNames(contacts: Array<Partial<Contact>>): Promise<number> {
  const wanted = new Map<string, string>()
  for (const contact of contacts) {
    // Baileys 7 renombró `jid` a `phoneNumber` en Contact.
    const identifier = contact.phoneNumber ?? contact.id
    if (!identifier || identifier === 'status@broadcast' || identifier.endsWith('@g.us')) continue
    const name = contact.name?.trim() || contact.notify?.trim()
    if (!name) continue
    const digits = normalizePhoneNumber(identifier.split('@')[0])
    if (digits) wanted.set(digits, name)
  }
  if (wanted.size === 0) return 0

  // Solo se actualizan conversaciones que YA existen: un contacto de la
  // agenda sin conversación no es un chat, no hay nada que mostrar.
  let updated = 0
  for (const group of chunked([...wanted.keys()])) {
    const { data, error } = await supabase
      .from('agent_conversations')
      .select('id, phone_number, customer_name')
      .in('phone_number', group)
    if (error) throw error

    const rows = (data ?? [])
      .filter((row) => !row.customer_name && wanted.get(row.phone_number))
      .map((row) => ({ id: row.id, phone_number: row.phone_number, customer_name: wanted.get(row.phone_number)! }))
    if (rows.length === 0) continue

    const { error: upError } = await supabase.from('agent_conversations').upsert(rows, { onConflict: 'id' })
    if (upError) throw upError
    updated += rows.length
  }
  return updated
}

/**
 * Espeja en `agent_conversations.unread_count` el estado de "no leído"
 * que reporta WhatsApp. No lo calculamos nosotros: es lo mismo que se ve
 * en la app, así el ERP puede mostrar qué quedó sin atender.
 */
export async function syncChatUnreadCounts(chats: Array<Partial<Chat>>): Promise<number> {
  const wanted = new Map<string, number>()
  for (const chat of chats) {
    const jid = chat.id
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) continue
    if (chat.unreadCount === undefined || chat.unreadCount === null) continue
    const identifier = normalizePhoneNumber(jid.split('@')[0])
    if (!identifier) continue
    // Negativo = marcado como no leído a mano en la app (convención de
    // WhatsApp). Se normaliza a 1 para que "hay algo sin leer" sea `> 0`.
    wanted.set(identifier, chat.unreadCount < 0 ? 1 : chat.unreadCount)
  }
  if (wanted.size === 0) return 0

  let updated = 0
  for (const group of chunked([...wanted.keys()])) {
    const { data, error } = await supabase
      .from('agent_conversations')
      .select('id, phone_number, unread_count, last_message_direction')
      .in('phone_number', group)
    if (error) throw error

    const rows = (data ?? [])
      .map((row) => ({
        id: row.id,
        phone_number: row.phone_number,
        // La lista representa "espera respuesta del negocio". Si el
        // último mensaje fue nuestro, un contador rezagado de WhatsApp no
        // debe volver a mostrar el chat como no leído.
        unread_count: row.last_message_direction === 'outbound' ? 0 : wanted.get(row.phone_number)!,
      }))
      .filter((row) => row.unread_count !== data?.find((actual) => actual.id === row.id)?.unread_count)
    if (rows.length === 0) continue

    const { error: upError } = await supabase.from('agent_conversations').upsert(rows, { onConflict: 'id' })
    if (upError) throw upError
    updated += rows.length
  }
  return updated
}

/**
 * WhatsApp avisa el teléfono real detrás de un LID por el evento
 * `chats.phoneNumberShare`. Es la única forma de que una conversación
 * identificada con un id interno pase a mostrarse con el número real.
 *
 * Si ya existe una conversación con ese teléfono, NO se fusiona
 * automáticamente -- fusionar historiales es destructivo y conviene
 * mirarlo antes; solo se deja anotado el lid.
 */
export async function linkLidToPhoneNumber(lid: string, phoneJid: string): Promise<void> {
  const lidDigits = lid.split('@')[0]
  const phoneDigits = normalizePhoneNumber(phoneJid.split('@')[0])
  if (!lidDigits || !phoneDigits) return

  const { data: existing } = await supabase
    .from('agent_conversations')
    .select('id')
    .eq('phone_number', phoneDigits)
    .maybeSingle()

  if (existing) {
    console.log(`LID ${lidDigits} corresponde a ${phoneDigits}, que ya tiene conversación #${existing.id} -- se marca el lid, sin fusionar.`)
    await supabase.from('agent_conversations').update({ lid: lidDigits }).eq('id', existing.id)
    return
  }

  const { error } = await supabase
    .from('agent_conversations')
    .update({ phone_number: phoneDigits, lid: lidDigits })
    .eq('phone_number', lidDigits)
  if (error) {
    console.error(`No se pudo asociar el LID ${lidDigits} al teléfono ${phoneDigits}:`, error.message)
    return
  }
  console.log(`Conversación ${lidDigits} ahora identificada con el teléfono ${phoneDigits}.`)
}

export type HistoryImportResult = {
  conversationsTouched: number
  messagesInserted: number
  skippedBeforeCutoff: number
  skippedUnparseable: number
}

export async function importHistoryMessages(
  messages: WAMessage[],
  options: { since: Date },
): Promise<HistoryImportResult> {
  const cutoffSeconds = Math.floor(options.since.getTime() / 1000)
  let skippedBeforeCutoff = 0
  let skippedUnparseable = 0

  // 1) Parsear todo en memoria primero -- sin tocar la base.
  const parsedRows: Array<{
    identifier: string
    lid: string | null
    name: string | null
    chatJid: string | null
    direction: 'inbound' | 'outbound'
    contentType: string
    body: string | null
    whatsappMessageId: string | null
    createdAt: string
  }> = []

  for (const msg of messages) {
    const timestamp = Number(msg.messageTimestamp ?? 0)
    if (timestamp > 0 && timestamp < cutoffSeconds) {
      skippedBeforeCutoff += 1
      continue
    }
    const parsed = parseIncomingMessage(msg)
    if (!parsed) {
      skippedUnparseable += 1
      continue
    }
    parsedRows.push({
      identifier: parsed.phoneNumber,
      lid: parsed.lid,
      name: parsed.pushName,
      chatJid: parsed.chatJid,
      direction: parsed.fromMe ? 'outbound' : 'inbound',
      contentType: parsed.contentType,
      body: parsed.body,
      whatsappMessageId: parsed.whatsappMessageId,
      createdAt: (parsed.sentAt ?? new Date()).toISOString(),
    })
  }
  if (parsedRows.length === 0) {
    return { conversationsTouched: 0, messagesInserted: 0, skippedBeforeCutoff, skippedUnparseable }
  }

  // 2) Resolver/crear todas las conversaciones de una.
  const conversationIds = await ensureConversations(
    parsedRows.map((r) => ({ identifier: r.identifier, lid: r.lid, name: r.name, chatJid: r.chatJid })),
  )

  // 3) Insertar los mensajes en lotes, salteando los que ya estaban
  //    (el history sync puede repetirse). Ver `insertarSinDuplicar`.
  const rows = parsedRows
    .map((r) => {
      const conversationId = conversationIds.get(r.identifier)
      if (conversationId === undefined) return null
      return {
        conversation_id: conversationId,
        direction: r.direction,
        content_type: r.contentType,
        body: r.body,
        whatsapp_message_id: r.whatsappMessageId,
        // Los salientes del historial los escribió una persona desde el
        // teléfono, no el agente.
        action_taken: r.direction === 'outbound' ? 'human_reply' : null,
        created_at: r.createdAt,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)

  const messagesInserted = await insertarSinDuplicar(rows)

  return {
    conversationsTouched: conversationIds.size,
    messagesInserted,
    skippedBeforeCutoff,
    skippedUnparseable,
  }
}
