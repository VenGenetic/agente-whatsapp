import { runGapsReportJob } from './agent/gapsReportJob.js'
import { runOutboxJob } from './agent/outboxJob.js'
import { runProactiveIntakeJob } from './agent/proactiveIntakeJob.js'
import { runStockNotificationJob } from './agent/stockNotificationJob.js'
import { getSocket, startWhatsApp } from './whatsapp/baileys.js'

const STOCK_NOTIFICATION_INTERVAL_MS = 5 * 60 * 1000
// 30s: el cliente está esperando del otro lado y a los 3 minutos ya se
// fue del chat (se midió: 3min 49s de demora en un caso real). La
// consulta es un índice parcial sobre pocas filas, así que es barata --
// acá pesa más no perder al cliente que ahorrar consultas.
const PROACTIVE_INTAKE_INTERVAL_MS = 30 * 1000
// Cada 3s: es un mensaje que una persona acaba de escribir y esta
// esperando que salga. La consulta usa un indice parcial sobre lo
// pendiente, que casi siempre esta vacio.
const OUTBOX_INTERVAL_MS = 3 * 1000
// Solo tiene que acertar la ventana horaria (GAPS_REPORT_HOUR); corta sin
// tocar la base cuando no es la hora, así que 30 min alcanza de sobra.
const GAPS_REPORT_INTERVAL_MS = 30 * 60 * 1000

startWhatsApp()
  .then(() => {
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

    // Envía lo que el equipo escribe desde el ERP. Rápido a propósito:
    // del otro lado hay alguien esperando que salga su mensaje.
    setInterval(() => {
      const sock = getSocket()
      if (!sock) return
      runOutboxJob(sock).catch((err) => console.error('Error enviando la cola de salida:', err))
    }, OUTBOX_INTERVAL_MS)

    // Arranca la recepción en los chats que el negocio habilitó desde el
    // ERP, sin esperar a que el cliente vuelva a escribir. Ritmo lento a
    // propósito (ver config.proactiveIntakeBatchSize).
    setInterval(() => {
      const sock = getSocket()
      if (!sock) return
      runProactiveIntakeJob(sock).catch((err) => console.error('Error en el job de recepción proactiva:', err))
    }, PROACTIVE_INTAKE_INTERVAL_MS)
  })
  .catch((err) => {
    console.error('Error fatal iniciando la conexión de WhatsApp:', err)
    process.exit(1)
  })
