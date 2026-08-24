import { downloadMediaMessage, type WAMessage, type WASocket } from '@whiskeysockets/baileys'
import pino from 'pino'

const logger = pino({ level: 'warn' })

export type DownloadedMedia = { base64: string; mimeType: string }

/**
 * Descarga una imagen o nota de voz entrante y la deja lista en base64 para
 * mandarla como inlineData a Gemini. Devuelve null si el mensaje no trae un
 * mimetype reconocible (no debería pasar para image/audio, pero por las
 * dudas no tumbamos el proceso).
 */
export async function downloadMediaAsBase64(sock: WASocket, msg: WAMessage): Promise<DownloadedMedia | null> {
  const content = msg.message
  const mimeType = content?.imageMessage?.mimetype ?? content?.audioMessage?.mimetype
  if (!mimeType) return null

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  return { base64: buffer.toString('base64'), mimeType }
}
