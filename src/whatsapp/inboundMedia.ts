import type { WAMessage, WASocket } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import type { ContentType } from '../db/conversations.js'
import { supabase } from '../supabaseClient.js'
import { downloadMediaBuffer, mediaFileLength, mediaMimeType } from './media.js'

/**
 * Guarda en Supabase Storage la foto / audio / archivo que llega por
 * WhatsApp, y anota su URL en el mensaje ya registrado.
 *
 * Por qué hace falta: en repuestos, buena parte de los pedidos llegan como
 * FOTO de la pieza ("¿tienen esto?"). Hasta ahora el ERP solo mostraba el
 * texto "(foto)" y la persona que atendía tenía que abrir el WhatsApp del
 * teléfono para verla -- o sea, salirse del sistema justo en el momento en
 * que necesita decidir qué contestar.
 *
 * La media de WhatsApp NO se puede volver a bajar más tarde: las claves de
 * descifrado viajan con el mensaje y los servidores la borran. Si no se
 * copia cuando llega, se pierde. Por eso esto corre siempre que entra
 * media, aunque el bot no vaya a contestar esa conversación.
 *
 * Corre EN SEGUNDO PLANO a propósito (ver `capturarMediaEnSegundoPlano`):
 * la descarga puede tardar segundos y el cliente está esperando respuesta.
 * La fila del mensaje ya se insertó; acá solo se completa `media_url`.
 */

/**
 * Tipos que vale la pena guardar.
 *
 * Los stickers entran: son pocos y pesan nada, y en el ERP un mensaje que
 * dice "(sticker)" a secas no le sirve a nadie -- a veces el cliente
 * responde con uno en vez de escribir "sí".
 *
 * Ubicación y contacto quedan afuera: no traen archivo, su contenido ya se
 * guarda como texto en `body`.
 */
const TIPOS_CON_MEDIA: ReadonlySet<ContentType> = new Set<ContentType>([
  'image',
  'audio',
  'video',
  'document',
  'sticker',
])

/**
 * Extensión a partir del mimetype. Importa que sea la correcta: el
 * navegador del ERP decide por ella si puede mostrar el archivo, y una
 * extensión equivocada deja la foto como un enlace roto.
 */
function extensionPara(mime: string): string {
  const limpio = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  const conocidas: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    // Las notas de voz de WhatsApp llegan como "audio/ogg; codecs=opus".
    // La extensión importa: el navegador del ERP decide por ella si puede
    // reproducir el archivo, y con la equivocada el reproductor queda mudo.
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/webm': 'webm',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/amr': 'amr',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
  }
  if (conocidas[limpio]) return conocidas[limpio]
  // "application/vnd.openxmlformats-...-document" -> nada usable; se
  // guarda sin extensión antes que inventar una que engañe al visor.
  const subtipo = limpio.split('/')[1] ?? ''
  return /^[a-z0-9]{1,5}$/.test(subtipo) ? subtipo : 'bin'
}

export type CapturaMedia = {
  conversationId: number
  whatsappMessageId: string | null
  contentType: ContentType
}

/**
 * Descarga la media, la sube al bucket y completa `media_url` del mensaje.
 * Devuelve la URL guardada, o null si no había nada que guardar.
 */
export async function capturarMediaEntrante(
  sock: WASocket,
  msg: WAMessage,
  { conversationId, whatsappMessageId, contentType }: CapturaMedia,
): Promise<string | null> {
  if (!config.chatMediaCaptureEnabled) return null
  if (!TIPOS_CON_MEDIA.has(contentType)) return null
  // Sin id no hay forma de decir a QUÉ fila pertenece la media.
  if (!whatsappMessageId) return null

  const mime = mediaMimeType(msg)
  if (!mime) return null

  // El tamaño lo declara WhatsApp en el propio mensaje: se descarta antes
  // de gastar la descarga.
  //
  // El video tiene su propio tope, más bajo. Se midió: promedia 3,9 MB
  // contra 124 KB de una foto, así que unos pocos videos pesan más que
  // todas las fotos del mes -- y en repuestos lo que importa es la foto de
  // la pieza. El mensaje queda registrado igual, solo sin el archivo.
  const topeMb = contentType === 'video' ? config.chatMediaMaxVideoMb : config.chatMediaMaxMb
  const topeBytes = topeMb * 1024 * 1024
  const bytes = mediaFileLength(msg)
  if (bytes !== null && bytes > topeBytes) {
    console.warn(
      `Media de ${(bytes / 1024 / 1024).toFixed(1)} MB descartada (tope ${topeMb} MB para ${contentType}): mensaje ${whatsappMessageId}.`,
    )
    return null
  }

  const descargada = await downloadMediaBuffer(sock, msg)
  if (!descargada) return null
  if (descargada.buffer.byteLength > topeBytes) return null

  // El id del mensaje es único y estable, así que el mismo mensaje
  // reentregado tras una reconexión pisa su propio archivo en vez de
  // duplicarlo.
  const ruta = `chats/${conversationId}/${whatsappMessageId}.${extensionPara(descargada.mimeType)}`

  const { error: errorSubida } = await supabase.storage
    .from(config.chatMediaBucket)
    .upload(ruta, descargada.buffer, {
      contentType: descargada.mimeType,
      cacheControl: '31536000',
      upsert: true,
    })
  if (errorSubida) throw errorSubida

  const { data } = supabase.storage.from(config.chatMediaBucket).getPublicUrl(ruta)
  const url = data.publicUrl

  // `is('media_url', null)`: si la fila ya tiene URL, es un mensaje que
  // mandamos nosotros y volvió como eco -- la URL buena es la que se
  // guardó al enviarlo, no esta copia.
  const { error: errorUpdate } = await supabase
    .from('agent_messages')
    .update({ media_url: url })
    .eq('whatsapp_message_id', whatsappMessageId)
    .is('media_url', null)
  if (errorUpdate) throw errorUpdate

  return url
}

/**
 * Igual que `capturarMediaEntrante`, pero sin bloquear ni tumbar el flujo
 * del mensaje: una foto que no se pudo copiar es una molestia, perder la
 * respuesta al cliente es un problema de verdad.
 */
export function capturarMediaEnSegundoPlano(sock: WASocket, msg: WAMessage, datos: CapturaMedia): void {
  capturarMediaEntrante(sock, msg, datos).catch((err) => {
    console.error(`No se pudo guardar la media del mensaje ${datos.whatsappMessageId}:`, err)
  })
}
