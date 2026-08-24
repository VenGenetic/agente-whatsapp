import type { WASocket } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import { getRecentHistory, logOutboundMessage } from '../db/conversations.js'
import { supabase } from '../supabaseClient.js'
import { humanDelay } from '../utils/humanDelay.js'
import { toChatJid, toWhatsAppJid } from '../utils/phone.js'
import { formatIntakeSummary, runIntake } from './intake.js'

type PendingIntake = {
  id: number
  phoneNumber: string
  customerName: string | null
  lid: string | null
  chatJid: string | null
}

/**
 * Conversaciones donde el negocio activó el agente pero el bot todavía no
 * arrancó -- ver migración 0020. Se excluyen las que ya están en manos de
 * un humano: si alguien la tomó, el bot no se mete.
 */
async function getPendingIntakes(limit: number): Promise<PendingIntake[]> {
  const { data, error } = await supabase
    .from('agent_conversations')
    .select('id, phone_number, customer_name, lid, chat_jid')
    .eq('bot_enabled', true)
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
  }))
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
  const pending = await getPendingIntakes(config.proactiveIntakeBatchSize)
  if (pending.length === 0) return

  for (const conversation of pending) {
    try {
      const history = await getRecentHistory(conversation.id, 15)
      if (history.length === 0) {
        // Sin nada que leer no hay contexto para arrancar -- se marca igual
        // para no reintentar en loop; cuando el cliente escriba, el flujo
        // reactivo normal lo atiende.
        await supabase
          .from('agent_conversations')
          .update({ intake_started_at: new Date().toISOString() })
          .eq('id', conversation.id)
        continue
      }

      const lastInbound = [...history].reverse().find((h) => h.direction === 'inbound')
      const result = await runIntake({
        history,
        customerMessage: lastInbound?.body ?? '(el cliente escribió antes, sin texto)',
      })

      // Si con el historial ya alcanza, no hay nada que preguntar: se avisa
      // al dueño con el resumen y no se le escribe al cliente (mandarle un
      // mensaje que no pidió sin necesidad sería justo lo que queremos
      // evitar).
      if (result.complete || result.needsHuman || !result.nextQuestion?.trim()) {
        await supabase
          .from('agent_conversations')
          .update({ intake_started_at: new Date().toISOString() })
          .eq('id', conversation.id)
        await sock.sendMessage(toWhatsAppJid(config.ownerPhoneNumber), {
          text: result.complete
            ? `El historial de ${conversation.customerName ?? conversation.phoneNumber} ya tenía todos los datos:\n${formatIntakeSummary(result.data)}`
            : `Revisá el chat de ${conversation.customerName ?? conversation.phoneNumber}: el agente no arrancó solo (necesita a alguien del equipo).`,
        })
        continue
      }

      await humanDelay()
      // Se usa la dirección REAL guardada del chat (`chat_jid`), no una
      // reconstruida a partir del teléfono: reconstruirla mal hacía que
      // los mensajes a chats por LID se perdieran en silencio -- WhatsApp
      // los acepta sin error y nunca llegan. `toChatJid` queda solo como
      // respaldo para filas viejas sin `chat_jid`.
      const jid =
        conversation.chatJid ?? toChatJid({ phone_number: conversation.phoneNumber, lid: conversation.lid })
      const sent = await sock.sendMessage(jid, { text: result.nextQuestion })
      await logOutboundMessage(conversation.id, {
        body: result.nextQuestion,
        actionTaken: 'asked_clarification',
        // Sin el id, el eco `fromMe` de este mismo envío entraría como un
        // mensaje aparte y quedaría duplicado en el historial.
        whatsappMessageId: sent?.key?.id ?? null,
      })
      await supabase
        .from('agent_conversations')
        .update({ intake_started_at: new Date().toISOString() })
        .eq('id', conversation.id)

      console.log(`Recepción arrancada en el chat de ${conversation.phoneNumber}.`)
    } catch (err) {
      console.error(`No se pudo arrancar la recepción en la conversación #${conversation.id}:`, err)
    }
  }
}
