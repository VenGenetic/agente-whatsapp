import type { WASocket } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import { getRecentHistory, logOutboundMessage } from '../db/conversations.js'
import { agentesEncendidos, isBotAutoReplyEnabled, puedeResponderAhora } from '../db/settings.js'
import { supabase } from '../supabaseClient.js'
import { humanDelay } from '../utils/humanDelay.js'
import { toChatJid, toWhatsAppJid } from '../utils/phone.js'
import { runIntake } from './intake.js'
import { resumenParaElVendedor } from './intakeHandoff.js'

type PendingIntake = {
  id: number
  phoneNumber: string
  customerName: string | null
  lid: string | null
  chatJid: string | null
  /** Marca del último mensaje al momento de armar la cola. */
  lastMessageAt: string | null
}

/**
 * Conversaciones donde el negocio activó el agente pero el bot todavía no
 * arrancó -- ver migración 0020. Se excluyen las que ya están en manos de
 * un humano: si alguien la tomó, el bot no se mete.
 */
async function getPendingIntakes(limit: number): Promise<PendingIntake[]> {
  const { data, error } = await supabase
    .from('agent_conversations')
    .select('id, phone_number, customer_name, lid, chat_jid, last_message_at')
    .eq('bot_enabled', true)
    .eq('selected_agent', 'intake')
    .is('intake_started_at', null)
    .in('status', ['bot_active'])
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    phoneNumber: row.phone_number,
    customerName: row.customer_name,
    lid: row.lid,
    chatJid: row.chat_jid,
    lastMessageAt: row.last_message_at,
  }))
}

/**
 * Reclama una conversación de forma atómica antes de llamar a Gemini.
 *
 * Dos vueltas del intervalo (o el flujo reactivo al mismo tiempo) podían
 * leer la misma fila pendiente y las dos terminaban enviando una pregunta.
 * La condición sobre `intake_started_at` permite que solo una gane. También
 * exigimos que no haya entrado un mensaje desde que se armó la cola: si lo
 * hubo, el flujo reactivo debe ser el único que responda.
 */
async function claimPendingIntake(conversation: PendingIntake): Promise<string | null> {
  const claimedAt = new Date().toISOString()
  let query = supabase
    .from('agent_conversations')
    .update({ intake_started_at: claimedAt })
    .eq('id', conversation.id)
    .eq('bot_enabled', true)
    .eq('selected_agent', 'intake')
    .eq('status', 'bot_active')
    .is('intake_started_at', null)

  query = conversation.lastMessageAt
    ? query.eq('last_message_at', conversation.lastMessageAt)
    : query.is('last_message_at', null)

  const { data, error } = await query.select('id').maybeSingle()
  if (error) throw error
  return data ? claimedAt : null
}

/** Libera un reclamo fallido, sin pisar una actualización más nueva. */
async function releasePendingIntakeClaim(conversationId: number, claimedAt: string): Promise<void> {
  const { error } = await supabase
    .from('agent_conversations')
    .update({ intake_started_at: null })
    .eq('id', conversationId)
    .eq('intake_started_at', claimedAt)
  if (error) throw error
}

/**
 * `created_at` puede ser la hora original de WhatsApp cuando llega algo tras
 * una reconexión. `last_message_at` usa la hora de ingreso, así que es la
 * marca segura para saber si el cliente escribió mientras el job pensaba.
 */
async function customerWroteSince(conversationId: number, claimedAt: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('agent_conversations')
    .select('last_message_at')
    .eq('id', conversationId)
    .maybeSingle()
  if (error) throw error
  return Boolean(data?.last_message_at && data.last_message_at > claimedAt)
}

/**
 * Arranca la recepción de datos en los chats que el negocio habilitó,
 * SIN esperar a que el cliente escriba de nuevo. Usa el historial viejo
 * del chat como contexto, así no vuelve a preguntar lo que el cliente ya
 * dijo hace horas.
 *
 * Va de a poco a propósito (`proactiveIntakeBatchSize`, uno por tick por
 * defecto): mandar mensajes no solicitados en ráfaga es lo que hizo que
 * WhatsApp restringiera el número una vez. Acá siempre es un chat donde el
 * cliente ya había escrito, pero el ritmo lento se mantiene igual.
 */
export async function runProactiveIntakeJob(sock: WASocket): Promise<void> {
  // Este job es el único que le escribe a un cliente SIN que el cliente
  // haya escrito primero, así que es el primero que hay que frenar. Con
  // la salida bloqueada ni siquiera se consulta la base: además de no
  // mandar nada, no marca `intake_started_at`, así que cuando se
  // reactive el agente estos chats siguen en la cola en vez de haber
  // quedado "arrancados" sin que el cliente recibiera nunca el saludo.
  if (config.outboundMode !== 'full' || config.botKillSwitch) return
  if (!(await isBotAutoReplyEnabled())) return
  const encendidos = await agentesEncendidos({
    recepcion: config.agentMode === 'intake',
    ventas: config.agentMode === 'full',
  })
  if (!encendidos.recepcion) return

  const pending = await getPendingIntakes(config.proactiveIntakeBatchSize)
  if (pending.length === 0) return

  for (const conversation of pending) {
    let claimedAt: string | null = null
    let sentToCustomer = false
    try {
      claimedAt = await claimPendingIntake(conversation)
      if (!claimedAt) continue

      const history = await getRecentHistory(conversation.id, 15)
      if (history.length === 0) {
        // Sin nada que leer no hay contexto para arrancar. El reclamo ya
        // la deja marcada para no reintentar en loop; si el cliente escribe,
        // el flujo reactivo normal lo atiende.
        continue
      }

      const lastInbound = [...history].reverse().find((h) => h.direction === 'inbound')
      const result = await runIntake({
        history,
        customerMessage: lastInbound?.body ?? '(el cliente escribió antes, sin texto)',
      })

      // Si llegó algo mientras Gemini procesaba, no se usa la conclusión
      // del historial anterior ni siquiera para avisarle al equipo.
      if (await customerWroteSince(conversation.id, claimedAt)) {
        console.log(`Recepción proactiva cancelada en #${conversation.id}: el cliente escribió mientras se procesaba.`)
        continue
      }

      // El permiso pudo cambiar durante la llamada al modelo.
      if (!(await puedeResponderAhora(conversation.id, 'intake'))) continue

      // Si con el historial ya alcanza, no hay nada que preguntar: se avisa
      // al dueño con el resumen y no se le escribe al cliente (mandarle un
      // mensaje que no pidió sin necesidad sería justo lo que queremos
      // evitar).
      if (result.complete || result.needsHuman || !result.nextQuestion?.trim()) {
        await sock.sendMessage(toWhatsAppJid(config.ownerPhoneNumber), {
          text: result.complete
            ? `El historial de ${conversation.customerName ?? conversation.phoneNumber} ya tenía todos los datos:\n${await resumenParaElVendedor(result.data)}`
            : `Revisá el chat de ${conversation.customerName ?? conversation.phoneNumber}: el agente no arrancó solo (necesita a alguien del equipo).`,
        })
        continue
      }

      await humanDelay()
      // Mientras Gemini procesaba o durante la pausa humana pudo llegar un
      // mensaje. No se responde a un historial viejo: la respuesta reactiva
      // de ese nuevo mensaje es la que corresponde.
      if (await customerWroteSince(conversation.id, claimedAt)) {
        console.log(`Recepción proactiva cancelada en #${conversation.id}: el cliente escribió mientras se procesaba.`)
        continue
      }
      // El estado también puede haber cambiado durante la pausa.
      if (!(await puedeResponderAhora(conversation.id, 'intake'))) continue
      // Se usa la dirección REAL guardada del chat (`chat_jid`), no una
      // reconstruida a partir del teléfono: reconstruirla mal hacía que
      // los mensajes a chats por LID se perdieran en silencio -- WhatsApp
      // los acepta sin error y nunca llegan. `toChatJid` queda solo como
      // respaldo para filas viejas sin `chat_jid`.
      const jid =
        conversation.chatJid ?? toChatJid({ phone_number: conversation.phoneNumber, lid: conversation.lid })
      const sent = await sock.sendMessage(jid, { text: result.nextQuestion })
      sentToCustomer = true
      await logOutboundMessage(conversation.id, {
        body: result.nextQuestion,
        actionTaken: 'asked_clarification',
        agent: 'intake',
        // Sin el id, el eco `fromMe` de este mismo envío entraría como un
        // mensaje aparte y quedaría duplicado en el historial.
        whatsappMessageId: sent?.key?.id ?? null,
      })
      console.log(`Recepción arrancada en el chat de ${conversation.phoneNumber}.`)
    } catch (err) {
      // Si ni siquiera se alcanzó a escribir al cliente, se libera solo
      // nuestro reclamo para reintentar luego. Si WhatsApp ya aceptó el
      // envío, conservarlo es crucial: repetir sería peor que un fallo al
      // registrar el eco.
      if (claimedAt && !sentToCustomer) {
        await releasePendingIntakeClaim(conversation.id, claimedAt).catch((releaseErr) => {
          console.error(`No se pudo liberar el reclamo de la conversación #${conversation.id}:`, releaseErr)
        })
      }
      console.error(`No se pudo arrancar la recepción en la conversación #${conversation.id}:`, err)
    }
  }
}
