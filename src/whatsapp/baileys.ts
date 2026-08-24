import { Boom } from '@hapi/boom'
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type Contact, type WASocket } from '@whiskeysockets/baileys'
import path from 'node:path'
import pino from 'pino'
import qrcode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import { handleIncomingMessage } from '../agent/handleMessage.js'
import { config } from '../config.js'
import { updateDeliveryStatus } from '../db/conversations.js'
import { importHistoryMessages, linkLidToPhoneNumber, syncChatUnreadCounts, syncContactNames } from '../db/historyImport.js'
import { runExclusive } from '../utils/runExclusive.js'
import { backupAuthState, restoreAuthState } from './authStateBackup.js'
import { parseIncomingMessage } from './parseMessage.js'

const AUTH_DIR = path.resolve(config.authStateDir)
const logger = pino({ level: config.baileysLogLevel })

// Al vincular un dispositivo nuevo (o reconectar), WhatsApp sincroniza un
// lote de chats/mensajes recientes y Baileys los entrega por el mismo
// evento 'messages.upsert' con type 'notify' -- indistinguibles de un
// mensaje realmente nuevo. Sin este filtro, ese historial se procesa como
// si fueran pedidos de clientes (gasta cuota de Gemini y puede terminar
// mandando respuestas no pedidas a contactos viejos). Se ignora todo
// mensaje con timestamp anterior al arranque de este proceso.
const PROCESS_STARTED_AT_SECONDS = Math.floor(Date.now() / 1000) - 5

let currentSocket: WASocket | null = null

// Sin backoff, una racha de desconexiones (red inestable) reconecta en
// loop apretado sin ninguna pausa -- se vieron ~395 reintentos seguidos en
// vivo, cada uno fallando de nuevo casi al instante. Eso no solo no ayuda
// (la red no tuvo tiempo de estabilizarse) sino que WhatsApp puede tratar
// reconexiones tan seguidas como comportamiento abusivo. Backoff
// exponencial con techo; se resetea apenas la conexión abre bien.
const RECONNECT_BASE_DELAY_MS = 2000
const RECONNECT_MAX_DELAY_MS = 60000
let reconnectAttempts = 0

/**
 * Socket vigente. Baileys se reconecta creando un socket NUEVO (ver
 * `connection.update` más abajo) -- cualquier código que necesite enviar
 * mensajes desde fuera del handler de mensajes (ej. el job de aviso de
 * stock) debe pedirlo acá en cada uso, nunca guardar la referencia que
 * devolvió `startWhatsApp()` una sola vez.
 */
export function getSocket(): WASocket | null {
  return currentSocket
}

let backupTimer: NodeJS.Timeout | null = null

function scheduleBackup(): void {
  if (backupTimer) clearTimeout(backupTimer)
  // Debounce: Baileys dispara creds.update varias veces seguidas al conectar;
  // esto colapsa esas ráfagas en un solo respaldo.
  backupTimer = setTimeout(() => {
    backupAuthState(AUTH_DIR).catch((err) => logger.error({ err }, 'No se pudo respaldar el auth-state en Supabase'))
  }, 5000)
}

export async function startWhatsApp(): Promise<WASocket> {
  await restoreAuthState(AUTH_DIR)
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  const sock = makeWASocket({
    auth: state,
    logger,
    // Sin esto, WhatsApp manda un history sync mínimo (o directamente
    // nada) al vincular -- se comprobó en vivo: 0 mensajes viejos, 0
    // nombres de contacto y 0 estados de no-leído. Con `syncFullHistory`
    // pide el historial que el teléfono tenga disponible, que es lo que
    // alimenta el análisis de conversaciones en el ERP.
    syncFullHistory: true,
    // El nombre que se muestra como "dispositivo vinculado" en el
    // teléfono. Antes quedaba el genérico de la librería.
    browser: ['Agente ERP', 'Chrome', '1.0.0'],
  })
  currentSocket = sock

  sock.ev.on('creds.update', async () => {
    await saveCreds()
    scheduleBackup()
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // El QR en la terminal se rompe en PowerShell (los caracteres de
      // bloque salen como "Ôûä" y queda ilegible), así que además se
      // guarda como imagen: eso siempre se puede escanear.
      const qrImagePath = path.resolve('qr-whatsapp.png')
      qrcode
        .toFile(qrImagePath, qr, { width: 400, margin: 2 })
        .then(() => console.log(`\nQR guardado en: ${qrImagePath}\nAbrí esa imagen y escaneala desde WhatsApp > Dispositivos vinculados.\n`))
        .catch((err) => logger.error({ err }, 'No se pudo guardar el QR como imagen'))

      console.log('\nSi la imagen no te sirve, también está acá abajo (puede verse mal según la terminal):\n')
      qrcodeTerminal.generate(qr, { small: true })
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut

      if (loggedOut) {
        currentSocket = null
        console.error(
          'La sesión fue cerrada desde el teléfono. Borrá la carpeta de auth-state ' +
            `(${AUTH_DIR}) y el contenido del bucket "${config.authBackupBucket}", y reiniciá para volver a escanear el QR.`,
        )
        return
      }

      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS)
      reconnectAttempts += 1
      console.warn(`Conexión cerrada (código ${statusCode ?? 'desconocido'}). Reconectando en ${delay}ms...`)
      // Sin esto, el socket viejo puede quedar con su listener de
      // 'messages.upsert' todavía activo -- si WhatsApp llega a entregarle
      // algo antes de que termine de morir, el mensaje se procesa DOS
      // veces (una por cada socket) y el cliente recibe dos respuestas.
      sock.ev.removeAllListeners('messages.upsert')
      sock.ev.removeAllListeners('connection.update')
      sock.ev.removeAllListeners('creds.update')
      setTimeout(() => {
        startWhatsApp().catch((err) => logger.error({ err }, 'Error al reconectar'))
      }, delay)
    } else if (connection === 'open') {
      reconnectAttempts = 0
      console.log('Conectado a WhatsApp.')
    }
  })

  // History sync: WhatsApp manda un lote de chats/mensajes recientes al
  // vincular el dispositivo. NO se procesa como pedidos (para eso está el
  // filtro de timestamp más abajo) -- se guarda tal cual para que el
  // negocio pueda analizar las conversaciones. Ver docs/system-prompts.md.
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType, progress, isLatest }) => {
    // Log incondicional: se comprobó que WhatsApp manda la notificación de
    // historial (y Baileys la acepta) pero no llegaba nada a la base --
    // sin esto no hay forma de saber si el evento no dispara, o dispara
    // vacío, o falla al guardar.
    console.log(
      `[history] evento recibido: ${chats?.length ?? 0} chats, ${contacts?.length ?? 0} contactos, ` +
        `${messages?.length ?? 0} mensajes (syncType=${syncType ?? '?'}, progress=${progress ?? '?'}, isLatest=${isLatest ?? '?'})`,
    )
    try {
      // Los mensajes van PRIMERO: son lo que da valor al análisis, y las
      // conversaciones que crean son las que después los nombres y el
      // estado de no-leído necesitan para engancharse.
      if (messages?.length && config.historyImportSince) {
        const result = await importHistoryMessages(messages, { since: config.historyImportSince })
        console.log(
          `History sync: ${result.messagesInserted} mensaje(s) nuevos guardados en ${result.conversationsTouched} conversación(es) ` +
            `(${result.skippedBeforeCutoff} anteriores al corte, ${result.skippedUnparseable} no interpretables).`,
        )
      }
      if (contacts?.length) {
        const named = await syncContactNames(contacts)
        if (named > 0) console.log(`History sync: ${named} contacto(s) con nombre actualizado.`)
      }
      if (chats?.length) {
        const updated = await syncChatUnreadCounts(chats)
        if (updated > 0) console.log(`History sync: ${updated} chat(s) con estado de no-leído actualizado.`)
      }
    } catch (err) {
      logger.error({ err }, 'Error importando el historial de WhatsApp')
    }
  })

  // Acuses de recibo: WhatsApp avisa por acá si el mensaje llegó al
  // teléfono del cliente o si se quedó en el camino. Sin esto el ERP daba
  // por respondido algo que el cliente nunca vio (`sendMessage` no falla
  // cuando el destino no existe -- ver migración 0023).
  sock.ev.on('messages.update', async (updates) => {
    for (const update of updates) {
      const id = update.key?.id
      const status = update.update?.status
      if (!id || status === undefined || status === null) continue
      try {
        await updateDeliveryStatus(id, Number(status))
      } catch (err) {
        logger.error({ err }, 'Error actualizando el acuse de recibo')
      }
    }
  })

  // Contactos nuevos o renombrados en vivo -- mantiene los nombres del
  // ERP al día sin esperar a un re-vinculado.
  const handleContacts = async (contacts: Array<Partial<Contact>>) => {
    try {
      await syncContactNames(contacts)
    } catch (err) {
      logger.error({ err }, 'Error sincronizando nombres de contactos')
    }
  }
  sock.ev.on('contacts.upsert', handleContacts)
  sock.ev.on('contacts.update', handleContacts)

  // WhatsApp comparte el teléfono real detrás de un LID -- es lo que
  // convierte una conversación identificada con un id interno en una con
  // el número del cliente a la vista en el ERP.
  sock.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
    try {
      await linkLidToPhoneNumber(lid, jid)
    } catch (err) {
      logger.error({ err }, 'Error asociando LID a número de teléfono')
    }
  })

  // Cambios de estado de chat en vivo (marcar leído/no leído desde el
  // teléfono) -- mantiene el ERP en sintonía con lo que ve el vendedor.
  sock.ev.on('chats.update', async (updates) => {
    try {
      await syncChatUnreadCounts(updates)
    } catch (err) {
      logger.error({ err }, 'Error actualizando el estado de no-leído')
    }
  })

  sock.ev.on('messages.upsert', async (event) => {
    if (event.type !== 'notify') return
    // Defensa extra contra el mismo problema: si por lo que sea este
    // listener de un socket viejo llega a dispararse, `sock` ya no es el
    // socket vigente y no debe procesar nada.
    if (sock !== currentSocket) return

    for (const msg of event.messages) {
      const timestamp = Number(msg.messageTimestamp ?? 0)
      if (timestamp > 0 && timestamp < PROCESS_STARTED_AT_SECONDS) continue // historial sincronizado, no un mensaje nuevo

      // Baileys dispara un 'messages.upsert' por cada tanda que llega de
      // WhatsApp, sin esperar a que el handler anterior termine -- si el
      // mismo cliente manda dos mensajes seguidos (muy común: "hola" y dos
      // segundos después "necesito un filtro"), sin esto se procesan en
      // paralelo con historial desactualizado. runExclusive serializa por
      // número de teléfono -- clientes distintos siguen en paralelo.
      const parsed = parseIncomingMessage(msg)

      try {
        if (parsed) {
          await runExclusive(parsed.phoneNumber, () => handleIncomingMessage(sock, msg))
        } else {
          await handleIncomingMessage(sock, msg)
        }
      } catch (err) {
        logger.error({ err }, 'Error procesando un mensaje entrante')
      }
    }
  })

  return sock
}
