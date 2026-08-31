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
  /**
   * Id de WhatsApp del mensaje que esta respuesta está citando. WhatsApp lo
   * guarda dentro de `contextInfo` y puede venir en texto, fotos, archivos o
   * notas de voz.
   */
  replyToWaId: string | null
  /** Cuándo lo envió WhatsApp (no cuándo lo recibimos nosotros). */
  sentAt: Date | null
}

/**
 * La cita viaja en `contextInfo.stanzaId`; no solo en texto. Un cliente
 * puede responder a una foto o un documento, y si se leyera únicamente
 * `extendedTextMessage` el ERP volvería a mostrar su respuesta suelta.
 */
function replyToWaId(content: NonNullable<WAMessage['message']>): string | null {
  const candidates = [
    content.extendedTextMessage?.contextInfo?.stanzaId,
    content.imageMessage?.contextInfo?.stanzaId,
    content.videoMessage?.contextInfo?.stanzaId,
    content.documentMessage?.contextInfo?.stanzaId,
    content.audioMessage?.contextInfo?.stanzaId,
  ];
  return candidates.find((id): id is string => Boolean(id)) ?? null;
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
  // En Baileys 7 el número real detrás de un chat @lid viene en
  // `remoteJidAlt` (antes era `senderPn`). Es la contraparte del jid del
  // chat: si el chat va por LID, acá está el teléfono, y viceversa.
  const identityJid = fromMe ? remoteJid : (msg.key.remoteJidAlt ?? remoteJid)
  const identityIsLid = isLid(identityJid)

  // El LID sale del CHAT, no de la identidad.
  //
  // Antes se sacaba de `identityJid`, y eso partía en dos al mismo cliente:
  // cuando WhatsApp mandaba `remoteJidAlt` (el teléfono real) el `lid`
  // quedaba en null aunque el chat fuera un chat @lid, y cuando no lo
  // mandaba -- o el mensaje era nuestro (`fromMe`), que ni lo mira -- la
  // conversación se guardaba bajo los dígitos del LID como si fueran un
  // teléfono. Resultado: dos filas del mismo chat, una con el número y
  // otra con el "ID interno", cada una con la mitad de los mensajes. Se
  // midieron 37 pares así, con 493 mensajes del lado equivocado.
  //
  // `chat_jid` es lo único estable: viene igual en todos los mensajes del
  // chat, los propios y los del cliente.
  const lid = isLid(chatJid)
    ? chatJid.split('@')[0]
    : identityIsLid
      ? identityJid.split('@')[0]
      : null
  const phoneNumber = normalizePhoneNumber(identityJid.split('@')[0])
  const pushName = fromMe ? null : (msg.pushName ?? null)
  const whatsappMessageId = msg.key.id ?? null
  const timestampSeconds = Number(msg.messageTimestamp ?? 0)
  const sentAt = timestampSeconds > 0 ? new Date(timestampSeconds * 1000) : null
  const base = {
    phoneNumber,
    lid,
    chatJid,
    pushName,
    fromMe,
    whatsappMessageId,
    replyToWaId: replyToWaId(content),
    sentAt,
  }

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

  // Todo lo demás (reacciones, acuses, mensajes de protocolo, claves de
  // cifrado...) NO se guarda: no tiene contenido que mostrarle a nadie ni
  // sirve para analizar la conversación. Se midió en vivo: en media hora
  // metió 147 filas vacías en el chat del propio bot, tapando los
  // mensajes reales en el ERP.
  return null
}
