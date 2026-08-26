import { downloadMediaMessage, type WAMessage, type WASocket } from '@whiskeysockets/baileys'
import pino from 'pino'

const logger = pino({ level: 'warn' })

export type DownloadedMedia = { base64: string; mimeType: string }
export type DownloadedBuffer = { buffer: Buffer; mimeType: string }

/**
 * Mimetype de la media del mensaje, sea del tipo que sea. Null si el
 * mensaje no trae media.
 */
export function mediaMimeType(msg: WAMessage): string | null {
  const c = msg.message
  return (
    c?.imageMessage?.mimetype ??
    c?.audioMessage?.mimetype ??
    c?.videoMessage?.mimetype ??
    c?.documentMessage?.mimetype ??
    c?.stickerMessage?.mimetype ??
    null
  )
}

/**
 * Tamaño declarado por WhatsApp, en bytes. Sirve para descartar un archivo
 * enorme ANTES de bajarlo.
 */
export function mediaFileLength(msg: WAMessage): number | null {
  const c = msg.message
  const raw =
    c?.imageMessage?.fileLength ??
    c?.audioMessage?.fileLength ??
    c?.videoMessage?.fileLength ??
    c?.documentMessage?.fileLength ??
    c?.stickerMessage?.fileLength
  if (raw === null || raw === undefined) return null
  // Baileys devuelve Long (protobuf) o number según el campo.
  const n = typeof raw === 'number' ? raw : Number(raw.toString())
  return Number.isFinite(n) ? n : null
}

/** Descarga la media del mensaje tal cual, sin convertirla. */
export async function downloadMediaBuffer(sock: WASocket, msg: WAMessage): Promise<DownloadedBuffer | null> {
  const mimeType = mediaMimeType(msg)
  if (!mimeType) return null

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  return { buffer, mimeType }
}

/**
 * Descarga una imagen o nota de voz entrante y la deja lista en base64 para
 * mandarla como inlineData a Gemini. Devuelve null si el mensaje no trae un
 * mimetype reconocible (no debería pasar para image/audio, pero por las
 * dudas no tumbamos el proceso).
 */
export async function downloadMediaAsBase64(sock: WASocket, msg: WAMessage): Promise<DownloadedMedia | null> {
  const downloaded = await downloadMediaBuffer(sock, msg)
  if (!downloaded) return null
  return { base64: downloaded.buffer.toString('base64'), mimeType: downloaded.mimeType }
}
