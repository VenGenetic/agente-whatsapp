import type { WASocket } from '@whiskeysockets/baileys'

/**
 * Manda texto con foto si hay `imageUrl`, con respaldo a texto solo si la
 * foto falla -- se encontró en vivo que la subida de imagen a WhatsApp
 * puede fallar con "Connection Closed" (problema de la conexión de medios,
 * no de la sesión en general) mientras el envío de texto plano sigue
 * funcionando bien. Sin este respaldo, el cliente se quedaba sin NINGÚN
 * mensaje cuando fallaba la foto -- justo lo que este proyecto evita en
 * todos los demás puntos de falla (ver handleProcessingFailure).
 */
export async function sendTextOrPhoto(
  sock: WASocket,
  jid: string,
  text: string,
  imageUrl: string | null,
): Promise<string | null> {
  if (imageUrl) {
    try {
      const sent = await sock.sendMessage(jid, { image: { url: imageUrl }, caption: text })
      return sent?.key?.id ?? null
    } catch (err) {
      console.error(`No se pudo mandar la foto (${imageUrl}), reintentando solo con texto:`, err)
    }
  }
  const sent = await sock.sendMessage(jid, { text })
  return sent?.key?.id ?? null
}
