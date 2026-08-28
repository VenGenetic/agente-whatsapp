import { Type, type Schema } from '@google/genai'
import { config } from '../config.js'
import type { HistoryTurn } from '../db/conversations.js'
import { getKnownModels } from '../matching/knownModels.js'
import { exigirCamposLimpios } from './sanidad.js'
import { withRetry } from '../utils/withRetry.js'
import { withTimeout } from '../utils/withTimeout.js'
import { generarContenido } from './client.js'
import { buildInterpreterSystemPrompt } from './prompts.js'

const GEMINI_TIMEOUT_MS = 40000 // ver el porqué en agent/intake.ts
const GEMINI_INTENTOS = 3
const GEMINI_ESPERA_ENTRE_INTENTOS_MS = 1500

export type InterpreterIntent =
  | 'product_request'
  | 'order_followup'
  | 'complaint'
  | 'discount_request'
  | 'general_question'
  | 'greeting_smalltalk'
  | 'unclear'

export type EscalationReason = 'discount_request' | 'complaint_or_return' | 'ambiguous' | 'angry_or_urgent'

/**
 * Un mensaje puede pedir más de un repuesto a la vez (ej. "un filtro de
 * aire y una bujía para mi wolf") -- cada uno se busca y se responde por
 * separado, reusando toda la lógica de un pedido individual.
 */
export type InterpretedItem = {
  searchQuery: string | null
  brandMentioned: string | null
  vehicleContext: string | null
  quantity: number
}

export type InterpretResult = {
  intent: InterpreterIntent
  items: InterpretedItem[]
  customerName: string | null
  shippingInfo: string | null
  sentimentUrgentOrAngry: boolean
  needsEscalation: boolean
  escalationReason: EscalationReason | null
  /**
   * El mensaje mezcla un pedido de producto (u otra cosa que ya se
   * procesa por su cuenta) CON una pregunta general del negocio (pago,
   * envíos, horario) -- `intent` solo puede ser uno, así que esto avisa
   * que además hay algo del negocio sin contestar, para no perderlo
   * silenciosamente. Ej. "necesito un filtro de aire para mi wolf, y de
   * paso, ¿aceptan transferencia?" -- intent sigue siendo product_request,
   * pero esto queda en true.
   */
  hasUnansweredGeneralQuestion: boolean
}

export type InterpretInput = {
  text: string | null
  image?: { base64: string; mimeType: string }
  audio?: { base64: string; mimeType: string }
  /**
   * Turnos recientes de la conversación. Sin esto, una respuesta corta del
   * cliente (ej. "negro", respondiendo a "¿de qué color lo querés?") llega
   * sin contexto y el intérprete no tiene cómo saber a qué producto se
   * refiere.
   */
  history?: HistoryTurn[]
}

function formatHistoryForInterpreter(history: HistoryTurn[]): string {
  if (history.length === 0) return ''
  const lines = history.map((h) => `${h.direction === 'inbound' ? 'Cliente' : 'Negocio'}: ${h.body ?? '(sin texto)'}`)
  return `HISTORIAL RECIENTE DE LA CONVERSACIÓN (para dar contexto -- el mensaje actual puede ser una respuesta corta a lo último que preguntó "Negocio"):\n${lines.join('\n')}\n\nMENSAJE ACTUAL DEL CLIENTE:`
}

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    intent: {
      type: Type.STRING,
      enum: [
        'product_request',
        'order_followup',
        'complaint',
        'discount_request',
        'general_question',
        'greeting_smalltalk',
        'unclear',
      ],
    },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          search_query: { type: Type.STRING, nullable: true },
          brand_mentioned: { type: Type.STRING, nullable: true },
          vehicle_context: { type: Type.STRING, nullable: true },
          quantity: { type: Type.INTEGER },
        },
        required: ['quantity'],
      },
    },
    customer_name: { type: Type.STRING, nullable: true },
    shipping_info: { type: Type.STRING, nullable: true },
    sentiment_urgent_or_angry: { type: Type.BOOLEAN },
    needs_escalation: { type: Type.BOOLEAN },
    escalation_reason: {
      type: Type.STRING,
      nullable: true,
      enum: ['discount_request', 'complaint_or_return', 'ambiguous', 'angry_or_urgent'],
    },
    has_unanswered_general_question: { type: Type.BOOLEAN },
  },
  required: ['intent', 'items', 'sentiment_urgent_or_angry', 'needs_escalation', 'has_unanswered_general_question'],
}

/**
 * Llamada 1: interpreta el mensaje del cliente (texto/foto/audio) y devuelve
 * SOLO un JSON estructurado -- nunca texto para el cliente. Ver
 * docs/system-prompts.md para el razonamiento del diseño de dos llamadas.
 */
export async function interpretMessage(input: InterpretInput): Promise<InterpretResult> {
  const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = []

  const historyBlock = formatHistoryForInterpreter(input.history ?? [])
  if (historyBlock) parts.push({ text: historyBlock })

  if (input.text) parts.push({ text: input.text })
  if (input.image) parts.push({ inlineData: { data: input.image.base64, mimeType: input.image.mimeType } })
  if (input.audio) parts.push({ inlineData: { data: input.audio.base64, mimeType: input.audio.mimeType } })
  if (parts.length === 0) parts.push({ text: '(mensaje sin contenido reconocible)' })

  const knownModels = await getKnownModels()

  // Igual que en recepción: parsear y controlar la sanidad adentro del
  // reintento. Un search_query con el razonamiento del modelo adentro
  // busca cualquier cosa en el catálogo -- ver gemini/sanidad.ts.
  const parsed = await withRetry(
    async () => {
      const response = await withTimeout(
        generarContenido({
          model: config.geminiModel,
          contents: [{ role: 'user', parts }],
          config: {
            systemInstruction: buildInterpreterSystemPrompt(knownModels),
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
        GEMINI_TIMEOUT_MS,
        'Gemini interpretMessage',
      )

      const raw = response.text
      if (!raw) throw new Error('Gemini no devolvió texto en la interpretación')
      const datos = JSON.parse(raw)

      for (const item of Array.isArray(datos.items) ? datos.items : []) {
        exigirCamposLimpios({
          search_query: item?.search_query,
          brand_mentioned: item?.brand_mentioned,
          vehicle_context: item?.vehicle_context,
        })
      }
      exigirCamposLimpios({ customer_name: datos.customer_name })

      return datos
    },
    GEMINI_INTENTOS,
    GEMINI_ESPERA_ENTRE_INTENTOS_MS,
  )
  const items: InterpretedItem[] = Array.isArray(parsed.items)
    ? parsed.items.map((item: Record<string, unknown>) => ({
        searchQuery: (item.search_query as string | null | undefined) ?? null,
        brandMentioned: (item.brand_mentioned as string | null | undefined) ?? null,
        vehicleContext: (item.vehicle_context as string | null | undefined) ?? null,
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
      }))
    : []

  return {
    intent: parsed.intent,
    items,
    customerName: parsed.customer_name ?? null,
    shippingInfo: parsed.shipping_info ?? null,
    sentimentUrgentOrAngry: Boolean(parsed.sentiment_urgent_or_angry),
    needsEscalation: Boolean(parsed.needs_escalation),
    escalationReason: parsed.escalation_reason ?? null,
    hasUnansweredGeneralQuestion: Boolean(parsed.has_unanswered_general_question),
  }
}
