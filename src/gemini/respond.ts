import { config } from '../config.js'
import type { EscalationReason } from '../db/escalations.js'
import { withRetry } from '../utils/withRetry.js'
import { withTimeout } from '../utils/withTimeout.js'
import { generarContenido } from './client.js'
import { buildResponderSystemPrompt } from './prompts.js'

const GEMINI_TIMEOUT_MS = 40000 // ver el porqué en agent/intake.ts
const GEMINI_INTENTOS = 3
const GEMINI_ESPERA_ENTRE_INTENTOS_MS = 1500

export type VerifiedFacts =
  | { case: 'in_stock'; productName: string; sku: string; price: number; imageUrl: string | null }
  | { case: 'no_stock'; productName: string; price: number; alreadyRegistered: boolean }
  | { case: 'not_in_catalog'; searchTerm: string }
  // Sin producto involucrado: saludo, pedido de aclaración, o escalamiento.
  | { case: 'none' }

export type EscalationBlock = {
  escalate: boolean
  reason?: EscalationReason | null
}

export type HistoryTurn = { direction: 'inbound' | 'outbound'; body: string | null }

function formatHistory(history: HistoryTurn[]): string {
  if (history.length === 0) return '(sin mensajes previos)'
  return history.map((h) => `${h.direction === 'inbound' ? 'Cliente' : 'Tú'}: ${h.body ?? '(sin texto)'}`).join('\n')
}

function formatFacts(facts: VerifiedFacts): Record<string, unknown> {
  switch (facts.case) {
    case 'in_stock':
      return {
        case: 'in_stock',
        product_name: facts.productName,
        sku: facts.sku,
        price: facts.price,
        image_url: facts.imageUrl,
        stock_available: true,
      }
    case 'no_stock':
      return {
        case: 'no_stock',
        product_name: facts.productName,
        price: facts.price,
        already_registered: facts.alreadyRegistered,
      }
    case 'not_in_catalog':
      return { case: 'not_in_catalog', search_term: facts.searchTerm }
    case 'none':
      return { case: 'none' }
  }
}

/**
 * Llamada 2: redacta el mensaje final para el cliente. Solo puede usar los
 * hechos del bloque `facts` -- `instruction` le dice QUÉ debe transmitir
 * (decidido por código, no por el modelo), y el modelo decide únicamente
 * CÓMO decirlo con la voz del negocio. Ver docs/system-prompts.md.
 */
export async function draftReply(params: {
  facts: VerifiedFacts
  escalation: EscalationBlock
  history: HistoryTurn[]
  customerMessage: string
  instruction: string
}): Promise<string> {
  const prompt = `
HECHOS_VERIFICADOS:
${JSON.stringify(formatFacts(params.facts))}

ESCALAMIENTO:
${JSON.stringify(params.escalation)}

HISTORIAL RECIENTE:
${formatHistory(params.history)}

Último mensaje del cliente: "${params.customerMessage}"

Qué tienes que transmitirle (decidido por el sistema, redáctalo tú con la voz del negocio):
${params.instruction}
`.trim()

  const response = await withRetry(
    () =>
      withTimeout(
        generarContenido({
          model: config.geminiModel,
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          config: { systemInstruction: buildResponderSystemPrompt() },
        }),
        GEMINI_TIMEOUT_MS,
        'Gemini draftReply',
      ),
    GEMINI_INTENTOS,
    GEMINI_ESPERA_ENTRE_INTENTOS_MS,
  )

  const text = response.text?.trim()
  if (!text) throw new Error('Gemini no devolvió texto en la redacción')
  return text
}
