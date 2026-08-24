import type { WAMessage } from '@whiskeysockets/baileys'
import type { ContentType } from '../db/conversations.js'
import { isLid, normalizePhoneNumber } from '../utils/phone.js'

export type ParsedMessage = {
  /** Solo dígitos. Si el chat va por LID, acá viene el LID hasta que WhatsApp comparta el número real. */
  phoneNumber: string
  /** Identificador interno de WhatsApp, cuando el chat va por LID. */
  lid: string | null
  chatJid: string
  contentType: ContentType
  body: string | null
  pushName: string | null
  /**
   * true = lo mandó el número del bot, no el cliente. Puede ser el propio
   * bot (WhatsApp nos devuelve un eco de lo que enviamos) o el vendedor
   * escribiendo desde su teléfono vinculado. Se guarda igual para tener la
   * conversación completa, pero nunca se procesa como pedido.
   */
  fromMe: boolean
  whatsappMessageId: string | null
  /** Cuándo lo envió WhatsApp (no cuándo lo recibimos nosotros). */
  sentAt: Date | null
}

/**
 * Extrae lo esencial de un mensaje entrante de Baileys.
 *
 * WhatsApp puede identificar un chat por LID (identificador interno) en vez
 * del número de teléfono real -- `key.remoteJid` viene entonces como
 * "...@lid", y `key.senderPn` trae el número real por separado. Guardamos
 * `chatJid` (el remoteJid tal cual, sea @lid o @s.whatsapp.net) para poder
 * CONTESTARLE siempre a la dirección correcta, y `phoneNumber` (preferimos
 * senderPn cuando existe) solo para mostrar/guardar en la base -- nunca se
 * debe reconstruir un JID de envío a partir de phoneNumber solo, porque en
 * un chat @lid ese número no es una dirección válida de WhatsApp.
 *
 * Este esqueleto NO descarga ni transcribe imágenes/audio todavía -- eso es
 * trabajo de la Llamada 1 (intérprete, ver docs/system-prompts.md), que se
 * conecta en el siguiente paso. Por ahora solo registra que llegó ese tipo
 * de contenido.
 */
export function parseIncomingMessage(msg: WAMessage): ParsedMessage | null {
  const remoteJid = msg.key.remoteJid
  if (!remoteJid) return null
  if (remoteJid === 'status@broadcast') return null
  if (remoteJid.endsWith('@g.us')) return null // el bot no atiende grupos

  const content = msg.message
  if (!content) return null

  const chatJid = remoteJid
  const fromMe = Boolean(msg.key.fromMe)
  // En un mensaje propio, `remoteJid` es el DESTINATARIO (el cliente) --
  // que es justo la conversación donde queremos guardarlo. `senderPn`
  // apunta al número del bot, así que no sirve acá.
  const identityJid = fromMe ? remoteJid : (msg.key.senderPn ?? remoteJid)
  // Si el chat va por LID, `identityJid` no es un teléfono: se guarda como
  // `lid` y el número queda pendiente hasta que WhatsApp lo comparta (ver
  // el evento `chats.phoneNumberShare` en baileys.ts).
  const identityIsLid = isLid(identityJid)
  const lid = identityIsLid ? identityJid.split('@')[0] : null
  const phoneNumber = normalizePhoneNumber(identityJid.split('@')[0])
  const pushName = fromMe ? null : (msg.pushName ?? null)
  const whatsappMessageId = msg.key.id ?? null
  const timestampSeconds = Number(msg.messageTimestamp ?? 0)
  const sentAt = timestampSeconds > 0 ? new Date(timestampSeconds * 1000) : null
  const base = { phoneNumber, lid, chatJid, pushName, fromMe, whatsappMessageId, sentAt }

  if (content.conversation) {
    return { ...base, contentType: 'text', body: content.conversation }
  }
  if (content.extendedTextMessage?.text) {
    return { ...base, contentType: 'text', body: content.extendedTextMessage.text }
  }
  if (content.imageMessage) {
    return { ...base, contentType: 'image', body: content.imageMessage.caption ?? null }
  }
  if (content.audioMessage) {
    return { ...base, contentType: 'audio', body: null }
  }
  // Los tipos de abajo no son parte del flujo de "pedir un repuesto" (el
  // bot no los interpreta), pero se registran igual para tener la
  // conversación completa -- el negocio los usa para análisis.
  if (content.videoMessage) {
    return { ...base, contentType: 'video', body: content.videoMessage.caption ?? null }
  }
  if (content.documentMessage) {
    return { ...base, contentType: 'document', body: content.documentMessage.fileName ?? null }
  }
  if (content.stickerMessage) {
    return { ...base, contentType: 'sticker', body: null }
  }
  if (content.locationMessage) {
    const { degreesLatitude, degreesLongitude } = content.locationMessage
    return { ...base, contentType: 'location', body: `${degreesLatitude ?? '?'}, ${degreesLongitude ?? '?'}` }
  }
  if (content.contactMessage || content.contactsArrayMessage) {
    return { ...base, contentType: 'contact', body: content.contactMessage?.displayName ?? null }
  }

  // Cualquier otra cosa (reacciones, encuestas, mensajes de sistema...):
  // se deja constancia de que llegó algo, sin intentar interpretarlo.
  return { ...base, contentType: 'other', body: null }
}
