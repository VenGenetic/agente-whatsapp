import { runGapsReportJob } from './agent/gapsReportJob.js'
import { iniciarOutboxWatcher } from './agent/outboxWatcher.js'
import { runProactiveIntakeJob } from './agent/proactiveIntakeJob.js'
import { runStockNotificationJob } from './agent/stockNotificationJob.js'
import { runMergeConversationsJob } from './agent/mergeConversationsJob.js'
import { latir } from './db/heartbeat.js'
import { getSocket, startWhatsApp } from './whatsapp/baileys.js'

const STOCK_NOTIFICATION_INTERVAL_MS = 5 * 60 * 1000
// 30s: el cliente está esperando del otro lado y a los 3 minutos ya se
// fue del chat (se midió: 3min 49s de demora en un caso real). La
// consulta es un índice parcial sobre pocas filas, así que es barata --
// acá pesa más no perder al cliente que ahorrar consultas.
const PROACTIVE_INTAKE_INTERVAL_MS = 30 * 1000
// Solo tiene que acertar la ventana horaria (GAPS_REPORT_HOUR); corta sin
// tocar la base cuando no es la hora, así que 30 min alcanza de sobra.
const GAPS_REPORT_INTERVAL_MS = 30 * 60 * 1000
// Cada 30s: el ERP da por caído al agente si el latido tiene más de 2
// minutos, así que este ritmo deja margen para un par de fallos seguidos
// sin dar una falsa alarma. Es un solo UPDATE de una fila.
const HEARTBEAT_INTERVAL_MS = 30 * 1000
// Cada 30 min. La búsqueda la hace Postgres y casi siempre devuelve cero
// filas (migración 0029), así que cuesta prácticamente nada -- pero un
// duplicado aparece recién cuando el cliente escribe, o sea que tampoco
// hay nada que ganar corriendo más seguido.
const MERGE_CONVERSATIONS_INTERVAL_MS = 30 * 60 * 1000

startWhatsApp()
  .then(() => {
    // Le dice al ERP que este proceso está vivo y si puede enviar. Sin
    // esto, un agente caído deja los mensajes del equipo en la cola sin
    // que nadie se entere (ver db/heartbeat.ts).
    latir()
    setInterval(() => {
      latir().catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)

    // PAUSADO A PROPÓSITO (temporal): compitiendo por cuota de Gemini con
    // pruebas en vivo. Reactivar sacando el comentario cuando termine la
    // sesión de pruebas -- quedan pocas demandas atascadas por mandar.
    // setInterval(() => {
    //   const sock = getSocket()
    //   if (!sock) return // reconectando o deslogueado -- se reintenta en el próximo tick
    //   runStockNotificationJob(sock).catch((err) => console.error('Error en el job de aviso de stock:', err))
    // }, STOCK_NOTIFICATION_INTERVAL_MS)

    setInterval(() => {
      const sock = getSocket()
      if (!sock) return
      runGapsReportJob(sock).catch((err) => console.error('Error en el job de resumen de huecos:', err))
    }, GAPS_REPORT_INTERVAL_MS)

    // Envía lo que el equipo escribe desde el ERP, apenas se encola.
    // Escucha en vivo en vez de preguntar cada pocos segundos (ver
    // outboxWatcher.ts): igual de rápido para quien espera del otro lado,
    // sin gastar cuota preguntando "¿hay algo?" un millón de veces al mes.
    iniciarOutboxWatcher(getSocket)

    // Arranca la recepción en los chats que el negocio habilitó desde el
    // ERP, sin esperar a que el cliente vuelva a escribir. Ritmo lento a
    // propósito (ver config.proactiveIntakeBatchSize).
    setInterval(() => {
      const sock = getSocket()
      if (!sock) return
      runProactiveIntakeJob(sock).catch((err) => console.error('Error en el job de recepción proactiva:', err))
    }, PROACTIVE_INTAKE_INTERVAL_MS)

    // Une los chats que aparecen duplicados en el ERP (mismo cliente con
    // teléfono y con LID). No necesita el socket: es solo base de datos.
    runMergeConversationsJob().catch((err) => console.error('Error unificando chats duplicados:', err))
    setInterval(() => {
      runMergeConversationsJob().catch((err) => console.error('Error unificando chats duplicados:', err))
    }, MERGE_CONVERSATIONS_INTERVAL_MS)
  })
  .catch((err) => {
    console.error('Error fatal iniciando la conexión de WhatsApp:', err)
    process.exit(1)
  })
