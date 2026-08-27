import type { AnyMessageContent, WAMessage, WASocket, proto } from '@whiskeysockets/baileys'
import { supabase } from '../supabaseClient.js'

/**
 * Acciones sobre mensajes que YA existen: borrar para todos, reaccionar,
 * editar, citar y marcar leído (migración 0031).
 *
 * Todas necesitan la CLAVE del mensaje en WhatsApp, no solo su id. La
 * clave es `{ remoteJid, id, fromMe }`: sin `remoteJid` WhatsApp no sabe
 * en qué chat buscarlo, y sin `fromMe` no sabe si es nuestro (solo se
 * pueden borrar y editar los propios). Se reconstruye con lo que ya
 * guardamos: la dirección del chat sale de la conversación y `fromMe` de
 * la dirección del mensaje en `agent_messages`.
 */

export type ClaveMensaje = proto.IMessageKey

/** Qué mostrar en la cita cuando el mensaje citado no tiene texto. */
const DESCRIPCION_SIN_TEXTO: Record<string, string> = {
  image: 'Foto',
  audio: 'Nota de voz',
  video: 'Video',
  document: 'Archivo',
  sticker: 'Sticker',
}

/**
 * Arma la clave de un mensaje guardado. Devuelve null si no está: no se
 * puede actuar sobre un mensaje que no tenemos registrado.
 */
export async function claveDe(whatsappMessageId: string, chatJid: string): Promise<ClaveMensaje | null> {
  const { data, error } = await supabase
    .from('agent_messages')
    .select('direction')
    .eq('whatsapp_message_id', whatsappMessageId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  return {
    remoteJid: chatJid,
    id: whatsappMessageId,
    // Los mensajes salientes son nuestros. WhatsApp solo deja borrar y
    // editar los propios; para reaccionar da igual.
    fromMe: data.direction === 'outbound',
  }
}

/**
 * El mensaje citado, en la forma mínima que Baileys necesita para dibujar
 * la cita.
 *
 * No hace falta el mensaje original completo -- que además no lo tenemos,
 * porque WhatsApp no lo reentrega. Alcanza con la clave y un cuerpo de
 * texto: es lo que WhatsApp muestra en la tarjetita de arriba.
 */
export async function mensajeCitado(
  whatsappMessageId: string,
  chatJid: string,
): Promise<WAMessage | null> {
  const { data, error } = await supabase
    .from('agent_messages')
    .select('direction, body, content_type')
    .eq('whatsapp_message_id', whatsappMessageId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  const textoCitado =
    data.body?.trim() ||
    // Un mensaje sin texto (una foto, un audio) igual se puede citar: en la
    // tarjeta va una descripción en vez del cuerpo.
    DESCRIPCION_SIN_TEXTO[data.content_type] ||
    'Mensaje'

  return {
    key: { remoteJid: chatJid, id: whatsappMessageId, fromMe: data.direction === 'outbound' },
    message: { conversation: textoCitado },
  } as WAMessage
}

/** Borra un mensaje para todos ("eliminar para todos" de WhatsApp). */
export function contenidoBorrar(clave: ClaveMensaje): AnyMessageContent {
  return { delete: clave }
}

/**
 * Pone (o quita) una reacción. Un emoji vacío la quita, que es como lo
 * modela WhatsApp: no hay una operación "borrar reacción" aparte.
 */
export function contenidoReaccion(clave: ClaveMensaje, emoji: string): AnyMessageContent {
  return { react: { text: emoji, key: clave } }
}

/** Edita el texto de un mensaje propio (WhatsApp lo permite ~15 minutos). */
export function contenidoEditar(clave: ClaveMensaje, texto: string): AnyMessageContent {
  return { text: texto, edit: clave }
}

/**
 * Marca leídos los mensajes del cliente en ese chat -- el doble tilde azul.
 *
 * Se hace al ABRIR el chat, igual que WhatsApp Web, y no solo al
 * responder. No es una preferencia estética: el conteo de no leídos NO lo
 * calculamos nosotros, lo espeja WhatsApp (ver syncChatUnreadCounts). Si
 * el ERP apagara el contador por su cuenta sin avisarle a WhatsApp, el
 * chat seguiría no leído en el teléfono y el siguiente `chats.update` lo
 * volvería a encender -- que es exactamente lo que se veía: chats que
 * reaparecían como pendientes después de haberlos atendido.
 */
export async function marcarLeidoEnWhatsApp(
  sock: WASocket,
  conversationId: number,
  chatJid: string,
): Promise<number> {
  // Solo los ENTRANTES sin leer: marcar los propios no tiene sentido.
  const { data, error } = await supabase
    .from('agent_messages')
    .select('whatsapp_message_id')
    .eq('conversation_id', conversationId)
    .eq('direction', 'inbound')
    .not('whatsapp_message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) throw error

  const claves: ClaveMensaje[] = (data ?? [])
    .filter((m) => m.whatsapp_message_id)
    .map((m) => ({ remoteJid: chatJid, id: m.whatsapp_message_id as string, fromMe: false }))
  if (claves.length === 0) return 0

  await sock.readMessages(claves)
  return claves.length
}

/**
 * Marca el chat como NO leído en WhatsApp, para que vuelva a aparecer
 * pendiente también en el teléfono.
 *
 * Es la vuelta del par: sin esto, "marcar sin leer" en el ERP era un
 * espejo local que WhatsApp pisaba en el siguiente `chats.update`, y el
 * botón parecía no hacer nada.
 *
 * WhatsApp necesita saber DESDE QUÉ mensaje queda sin leer, así que va la
 * clave del último mensaje del chat.
 */
export async function marcarNoLeidoEnWhatsApp(
  sock: WASocket,
  conversationId: number,
  chatJid: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('agent_messages')
    .select('whatsapp_message_id, direction, created_at')
    .eq('conversation_id', conversationId)
    .not('whatsapp_message_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.whatsapp_message_id) {
    // Un chat sin un solo mensaje registrado no se puede marcar: WhatsApp
    // no tiene desde dónde contar.
    throw new Error('No hay ningún mensaje registrado en este chat para marcarlo sin leer')
  }

  await sock.chatModify(
    {
      markRead: false,
      lastMessages: [
        {
          key: {
            remoteJid: chatJid,
            id: data.whatsapp_message_id,
            fromMe: data.direction === 'outbound',
          },
          messageTimestamp: Math.floor(new Date(data.created_at).getTime() / 1000),
        },
      ],
    },
    chatJid,
  )
}

/**
 * "Escribiendo..." en el teléfono del cliente.
 *
 * No pasa por la cola: es efímero -- si llega tarde no sirve de nada, y
 * reintentarlo tampoco tiene sentido. Los fallos se tragan por lo mismo.
 */
export async function mostrarEscribiendo(sock: WASocket, chatJid: string, activo: boolean): Promise<void> {
  try {
    await sock.presenceSubscribe(chatJid)
    await sock.sendPresenceUpdate(activo ? 'composing' : 'paused', chatJid)
  } catch {
    // Un indicador de "escribiendo" que no llega no rompe nada.
  }
}
