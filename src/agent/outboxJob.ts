import type { WASocket } from '@whiskeysockets/baileys'
import { logOutboundMessage } from '../db/conversations.js'
import { supabase } from '../supabaseClient.js'
import { toChatJid } from '../utils/phone.js'

/** Tope por vuelta: si se acumulan muchos, se mandan de a tandas. */
const POR_VUELTA = 5
/** A partir de acá se deja de reintentar y queda marcado como fallido. */
const MAX_INTENTOS = 3

type Pendiente = {
  id: number
  conversation_id: number
  body: string
  intentos: number
  agent_conversations: { phone_number: string; lid: string | null; chat_jid: string | null } | null
}

/**
 * Envía por WhatsApp lo que el equipo escribió desde el ERP (tabla
 * `agent_outbox`, migración 0024).
 *
 * Existe porque los mensajes escritos desde el teléfono llegan cifrados y
 * el agente no puede leerlos, así que nunca quedan registrados. Escritos
 * desde el ERP sí: el sistema conoce el texto antes de mandarlo.
 *
 * El mensaje se guarda en `agent_messages` recién DESPUÉS de que WhatsApp
 * acepta el envío -- al revés quedaría en el historial algo que nunca
 * salió.
 */
export async function runOutboxJob(sock: WASocket): Promise<void> {
  const { data, error } = await supabase
    .from('agent_outbox')
    .select('id, conversation_id, body, intentos, agent_conversations ( phone_number, lid, chat_jid )')
    .eq('status', 'pending')
    .lt('intentos', MAX_INTENTOS)
    .order('created_at', { ascending: true })
    .limit(POR_VUELTA)

  if (error) throw error
  const pendientes = (data ?? []) as unknown as Pendiente[]
  if (pendientes.length === 0) return

  for (const item of pendientes) {
    const conversacion = item.agent_conversations
    if (!conversacion) {
      await supabase
        .from('agent_outbox')
        .update({ status: 'failed', error: 'La conversación ya no existe' })
        .eq('id', item.id)
      continue
    }

    try {
      // Dirección real del chat, nunca reconstruida (ver migración 0022).
      const jid =
        conversacion.chat_jid ??
        toChatJid({ phone_number: conversacion.phone_number, lid: conversacion.lid })

      const sent = await sock.sendMessage(jid, { text: item.body })

      await logOutboundMessage(item.conversation_id, {
        body: item.body,
        actionTaken: 'human_reply',
        whatsappMessageId: sent?.key?.id ?? null,
      })

      await supabase
        .from('agent_outbox')
        .update({ status: 'sent', sent_at: new Date().toISOString(), error: null })
        .eq('id', item.id)

      console.log(`Outbox: mensaje #${item.id} enviado a ${jid}.`)
    } catch (err) {
      const intentos = item.intentos + 1
      const mensaje = err instanceof Error ? err.message : String(err)
      await supabase
        .from('agent_outbox')
        .update({
          intentos,
          // Recién se da por perdido tras varios intentos: una caída
          // momentánea de red no debería descartar el mensaje.
          status: intentos >= MAX_INTENTOS ? 'failed' : 'pending',
          error: mensaje,
        })
        .eq('id', item.id)
      console.error(`Outbox: fallo enviando el mensaje #${item.id} (intento ${intentos}):`, mensaje)
    }
  }
}
