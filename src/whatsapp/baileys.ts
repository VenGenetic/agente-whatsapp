import { Boom } from '@hapi/boom'
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type Contact, type WASocket } from '@whiskeysockets/baileys'
import path from 'node:path'
import pino from 'pino'
import qrcode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import { handleIncomingMessage } from '../agent/handleMessage.js'
import { config } from '../config.js'
import { updateDeliveryStatus } from '../db/conversations.js'
import { supabase } from '../supabaseClient.js'
import { importHistoryMessages, syncChatUnreadCounts, syncContactNames } from '../db/historyImport.js'
import { runExclusive } from '../utils/runExclusive.js'
import { latirEnSegundoPlano } from '../db/heartbeat.js'

import { backupAuthState, restoreAuthState } from './authStateBackup.js'
import { puedeEnviar } from './outboundGuard.js'
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

/**
 * La sesión murió (WhatsApp devolvió 401) y estas credenciales ya no
 * sirven. Deja de respaldar: subirlas al bucket es peor que no tener
 * respaldo, porque al arrancar `restoreAuthState` las restauraría y el
 * proceso volvería a la misma sesión muerta sin llegar a mostrar el QR.
 * Se vio en vivo el 2026-08-26: quedó un `creds.json` a medio vincular en
 * un bucket que se acababa de vaciar a propósito.
 */
let sesionInvalidada = false

function scheduleBackup(): void {
  if (sesionInvalidada) return
  if (backupTimer) clearTimeout(backupTimer)
  // Debounce: Baileys dispara creds.update varias veces seguidas al conectar;
  // esto colapsa esas ráfagas en un solo respaldo.
  backupTimer = setTimeout(() => {
    if (sesionInvalidada) return
    backupAuthState(AUTH_DIR).catch((err) => logger.error({ err }, 'No se pudo respaldar el auth-state en Supabase'))
  }, 5000)
}

/**
 * Envuelve `sendMessage` para que NINGÚN camino de salida pueda saltarse
 * el freno (ver outboundGuard.ts). Se aplica al socket recién creado, así
 * que también cubre los sockets nuevos que aparecen al reconectar.
 *
 * Devuelve `undefined` cuando bloquea, que es lo mismo que devuelve
 * Baileys cuando no llega a mandar: los llamadores ya contemplan ese caso
 * (guardan `sent?.key?.id ?? null`).
 */
function instalarFrenoDeSalida(sock: WASocket): void {
  const enviarOriginal = sock.sendMessage.bind(sock)

  sock.sendMessage = (async (jid: string, contenido: unknown, opciones?: unknown) => {
    const decision = puedeEnviar(jid)
    if (!decision.permitido) {
      console.warn(`[freno] Mensaje NO enviado a ${jid} -- ${decision.razon}`)
      return undefined
    }
    return enviarOriginal(jid, contenido as never, opciones as never)
  }) as WASocket['sendMessage']
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
    // Los estados que publican los contactos (`status@broadcast`) y los
    // grupos no son parte de este negocio: `parseMessage` ya los
    // descartaba, pero recién DESPUÉS de que Baileys intentara
    // descifrarlos -- y como son mensajes de grupo cifrados para otra
    // sesión, cada uno dejaba dos errores de nivel 50 en el log ("No
    // session found to decrypt message" + "transaction failed, rolling
    // back"). Eso no rompía nada, pero enterraba los errores de verdad
    // entre decenas de fallos inofensivos. Descartándolos acá ni se
    // intenta descifrarlos.
    shouldIgnoreJid: (jid: string) => jid === 'status@broadcast' || jid.endsWith('@g.us'),
    // Cuando el teléfono del cliente no puede descifrar un mensaje
    // nuestro, pide automáticamente que se lo reenviemos. Baileys sólo
    // puede responder a ese pedido si le damos forma de recuperar el
    // mensaje original -- sin esto el cliente queda con "Esperando
    // mensaje. Esto puede tomar tiempo." para siempre. Se midió: de 6
    // mensajes salientes, 3 quedaron trabados así.
    getMessage: async (key) => {
      if (!key.id) return undefined
      try {
        const { data } = await supabase
          .from('agent_messages')
          .select('body')
          .eq('whatsapp_message_id', key.id)
          .maybeSingle()
        if (!data?.body) return undefined
        // Todo lo que manda el agente es texto, así que alcanza con
        // reconstruir el mensaje simple.
        return { conversation: data.body }
      } catch (err) {
        logger.error({ err }, 'No se pudo recuperar el mensaje para reenviarlo')
        return undefined
      }
    },
  })
  instalarFrenoDeSalida(sock)
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
        // Antes que nada: que no se respalden estas credenciales muertas.
        // El timer del último `creds.update` puede estar todavía en vuelo.
        sesionInvalidada = true
        if (backupTimer) clearTimeout(backupTimer)
        latirEnSegundoPlano('disconnected')
        console.error(
          'WhatsApp rechazó la sesión (401). Para volver a vincular: parar el proceso, ' +
            `vaciar la carpeta de auth-state (${AUTH_DIR}) y el bucket "${config.authBackupBucket}" ` +
            '(npx tsx scripts/_tmp-vaciar-bucket.ts), y arrancar de nuevo.',
        )
        return
      }

      // 515 no es una caída: es lo que WhatsApp manda SIEMPRE justo
      // después de escanear el QR, para exigir que se reinicie el stream y
      // así terminar de vincular. Hay que volver a conectar YA.
      //
      // Pasarlo por el backoff exponencial rompía la vinculación: con los
      // reintentos acumulados de los QR vencidos, la espera había llegado a
      // 60s, WhatsApp descartaba el emparejamiento a medias y la siguiente
      // conexión volvía con 401 -- que este mismo código reporta como "la
      // sesión fue cerrada desde el teléfono", un mensaje que manda a
      // borrar el auth-state y reintentar, cayendo justo en el mismo pozo.
      // Se vio en vivo el 2026-08-26.
      const esReinicioDeVinculacion = statusCode === DisconnectReason.restartRequired

      latirEnSegundoPlano('connecting')
      const delay = esReinicioDeVinculacion
        ? 0
        : Math.min(RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts, RECONNECT_MAX_DELAY_MS)
      // Un 515 tampoco cuenta como intento fallido: si sumara, la próxima
      // caída real arrancaría el backoff más arriba de lo que corresponde.
      if (!esReinicioDeVinculacion) reconnectAttempts += 1

      console.warn(
        esReinicioDeVinculacion
          ? 'Vinculación aceptada: WhatsApp pide reiniciar la conexión (515). Reconectando ya...'
          : `Conexión cerrada (código ${statusCode ?? 'desconocido'}). Reconectando en ${delay}ms...`,
      )
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
      // El ERP lo lee para avisar si lo que se encola va a salir o no
      // (ver db/heartbeat.ts).
      latirEnSegundoPlano('connected')
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

  // En Baileys 7 ya no existe el evento `chats.phoneNumberShare`: el
  // teléfono real detrás de un LID llega directamente en cada mensaje
  // (`key.remoteJidAlt`, ver parseMessage.ts), así que la asociación se
  // hace ahí y no hace falta un listener aparte.

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
    // 'notify'  = mensaje nuevo que llega de afuera (el cliente).
    // 'append'  = mensaje que se agrega al chat desde OTRO dispositivo de
    //             esta misma cuenta -- o sea, lo que el vendedor escribe
    //             desde su teléfono.
    //
    // Descartar 'append' dejaba la conversación a medias en el ERP: se
    // veía al cliente diciendo "Ok" o "Por favor" respondiendo a
    // mensajes que nunca se habían guardado. Se procesan los dos; lo que
    // impide que el bot se responda a sí mismo es el chequeo de `fromMe`
    // dentro de handleIncomingMessage, no este filtro.
    //
    // Nota: los mensajes que el vendedor escribe desde el TELÉFONO llegan
    // igual por acá, pero vienen cifrados y sin poder abrirse ("No
    // session found to decrypt message"): se midió 1 fallo de descifrado
    // por cada mensaje propio, y todos llegaron con el contenido vacío.
    // Por eso el equipo responde desde el ERP (ver agent_outbox,
    // migración 0024): así el texto se conoce antes de cifrarlo y la
    // conversación queda completa.
    if (event.type !== 'notify' && event.type !== 'append') return
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
