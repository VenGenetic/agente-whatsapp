import { supabase } from '../supabaseClient.js'

export type EscalationReason =
  | 'discount_request'
  | 'complaint_or_return'
  | 'ambiguous_after_retries'
  | 'angry_or_urgent'
  | 'other'

export async function createEscalation(params: {
  conversationId: number
  reason: EscalationReason
  messageSnapshot: string
}): Promise<void> {
  const { error } = await supabase.from('agent_escalations').insert({
    conversation_id: params.conversationId,
    reason: params.reason,
    message_snapshot: params.messageSnapshot,
  })
  if (error) throw error
}
