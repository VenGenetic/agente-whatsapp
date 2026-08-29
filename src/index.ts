import { runGapsReportJob } from './agent/gapsReportJob.js'
import { runGroupsJob } from './agent/groupsJob.js'
import { iniciarOutboxWatcher } from './agent/outboxWatcher.js'
import { runProactiveIntakeJob } from './agent/proactiveIntakeJob.js'
import { runStockNotificationJob } from './agent/stockNotificationJob.js'
import { runMergeConversationsJob } from './agent/mergeConversationsJob.js'
import { runLearningJob } from './agent/learningJob.js'
import { latir } from './db/heartbeat.js'
import { cuandoConecte, getSocket, startWhatsApp } from './whatsapp/baileys.js'

const STOCK_NOTIFICATION_INTERVAL_MS = 5 * 60 * 1000
// 30s: el cliente está esperando del otro lado y a los 3 minutos ya se
// fue del chat (se midió: 3min 49s de demora en un caso real). La
// consulta es un índice parcial sobre pocas filas, así que es barata --
// acá pesa más no perder al cliente que ahorrar consultas.
const PROACTIVE_INTAKE_INTERVAL_MS = 30 * 1000
// Solo tiene que acertar la ventana horaria (GAPS_REPORT_HOUR); corta sin
// tocar la base cuando no es la hora, así que 30 min alcanza de sobra.
const GAPS_REPORT_INTERVAL_MS = 30 * 60 * 1000
/**
 * Cada cuánto se relee la lista de grupos. Media hora: los grupos se
 * crean y se renombran de vez en cuando, no todo el tiempo, y cada
 * consulta le pregunta a WhatsApp por todos.
 */
const GROUPS_SYNC_INTERVAL_MS = 30 * 60 * 1000
// Cada 30s: el ERP da por caído al agente si el latido tiene más de 2
// minutos, así que este ritmo deja margen para un par de fallos seguidos
// sin dar una falsa alarma. Es un solo UPDATE de una fila.
const HEARTBEAT_INTERVAL_MS = 30 * 1000
// Cada 30 min. La búsqueda la hace Postgres y casi siempre devuelve cero
// filas (migración 0029), así que cuesta prácticamente nada -- pero un
// duplicado aparece recién cuando el cliente escribe, o sea que tampoco
// hay nada que ganar corriendo más seguido.
const MERGE_CONVERSATIONS_INTERVAL_MS = 30 * 60 * 1000
const LEARNING_INTERVAL_MS = 30 * 60 * 1000

startWhatsApp()
  .then(() => {
    // Le dice al ERP que este proceso está vivo y si puede enviar. Sin
    // esto, un agente caído deja los mensajes del equipo en la cola sin
    // que nadie se entere (ver db/heartbeat.ts).
    latir()
    setInterval(() => {
      latir().catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)

    /*
      APAGADO A PROPÓSITO. Leer esto antes de descomentarlo.

      Avisar "ya llegó tu repuesto" hoy lo hace una PERSONA desde el ERP:
      bandeja de WhatsApp -> "Por avisar", o el botón "Notificar" de
      Solicitudes. Ese camino muestra el mensaje antes de mandarlo, reserva
      el pedido de forma atómica para que dos vendedores no avisen lo mismo
      dos veces, y respeta el tope por hora.

      Este job hace lo mismo pero solo y sin que nadie lo mire. Si se
      enciende, los dos caminos compiten por las mismas demandas.

      Y hay algo que antes no pasaba: hasta la migración 20260827150000
      casi ninguna demanda llegaba al estado `stock_available`, así que
      esto no tenía a quién avisarle. Ahora hay más de cien. Descomentarlo
      sin pensar sale como una tanda de más de cien mensajes automáticos.

      Segundo candado: arranca con `if (config.outboundMode !== 'full')
      return`, así que con OUTBOUND_MODE=erp_only no corre ni descomentado.
      Los dos candados tienen que caer para que esto mande algo.
    */
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

    // Los grupos a los que pertenece la cuenta, para poder ESCRIBIRLES
    // desde el ERP (el requerimiento de compra cuando un cliente abona).
    // No lee nada de lo que se dice adentro: la entrada de grupos sigue
    // ignorada. Se relee de a ratos porque los grupos se crean, se
    // renombran y a veces te sacan de uno.
    const sincronizarGrupos = () => {
      const sock = getSocket()
      if (!sock) return
      runGroupsJob(sock).catch((err) => console.error('Error sincronizando los grupos:', err))
    }
    // La primera pasada va enganchada a la conexión y no acá: `groupFetchAllParticipating`
    // le PREGUNTA a WhatsApp, y en este punto el socket existe pero
    // todavía no conectó -- se comprobó, fallaba con "Connection Closed".
    cuandoConecte(sincronizarGrupos)
    setInterval(sincronizarGrupos, GROUPS_SYNC_INTERVAL_MS)

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

    // Aprende ejemplos seguros de las respuestas humanas ya registradas.
    // No toca catálogo, precio ni stock: solo estilo y forma de atender.
    runLearningJob().catch((err) => console.error('Error actualizando el aprendizaje:', err))
    setInterval(() => {
      runLearningJob().catch((err) => console.error('Error actualizando el aprendizaje:', err))
    }, LEARNING_INTERVAL_MS)
  })
  .catch((err) => {
    console.error('Error fatal iniciando la conexión de WhatsApp:', err)
    process.exit(1)
  })
