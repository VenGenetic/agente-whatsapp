import { Type, type Schema } from '@google/genai'
import { config } from '../config.js'
import type { HistoryTurn } from '../db/conversations.js'
import { genai } from '../gemini/client.js'
import { getKnownModels } from '../matching/knownModels.js'
import { withRetry } from '../utils/withRetry.js'
import { withTimeout } from '../utils/withTimeout.js'

const GEMINI_TIMEOUT_MS = 20000

/**
 * Datos que hay que sacarle al cliente antes de pasarle la conversación a
 * un humano. `color` es condicional -- muchos repuestos de este catálogo
 * son productos distintos según el color, pero otros no vienen en
 * colores; se pide solo cuando aplica a la pieza que pidió.
 */
export type IntakeData = {
  repuesto: string | null
  marca: string | null
  modelo: string | null
  anio: string | null
  color: string | null
}

export type IntakeResult = {
  data: IntakeData
  /** true cuando ya no falta ningún dato obligatorio para esta pieza. */
  complete: boolean
  /**
   * Qué preguntar ahora (una sola pregunta corta, redactada por el
   * modelo). Null cuando `complete` es true.
   */
  nextQuestion: string | null
  /** true si el cliente pide hablar con una persona, se queja, etc. */
  needsHuman: boolean
}

const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    repuesto: { type: Type.STRING, nullable: true },
    marca: { type: Type.STRING, nullable: true },
    modelo: { type: Type.STRING, nullable: true },
    anio: { type: Type.STRING, nullable: true },
    color: { type: Type.STRING, nullable: true },
    color_aplica: { type: Type.BOOLEAN },
    complete: { type: Type.BOOLEAN },
    next_question: { type: Type.STRING, nullable: true },
    needs_human: { type: Type.BOOLEAN },
  },
  required: ['complete', 'needs_human', 'color_aplica'],
}

function buildIntakeSystemPrompt(knownModels: string[]): string {
  const modelsBlock = knownModels.length > 0 ? knownModels.join(', ') : '(sin lista cargada todavía)'

  return `
Sos el módulo de RECEPCIÓN de un negocio de repuestos usados de moto en
Ecuador (${config.businessName}). Tu único trabajo es sacarle al cliente
los datos de lo que necesita, para que después una persona del equipo le
cotice.

REGLA MÁS IMPORTANTE: NUNCA hables de disponibilidad, precios, stock,
fotos, plazos de entrega ni de qué hay o no hay en el catálogo. No tenés
acceso a esa información y no debés inventarla ni insinuarla. Si el
cliente pregunta precio o si hay stock, decile que eso se lo confirma
alguien del equipo apenas tengas sus datos, y seguí con la pregunta que
te falte.

## Cómo llenar los campos (importante)

Cada dato va en SU PROPIO campo del JSON, siempre. Nunca metas varios
datos juntos en uno solo. El campo repuesto lleva ÚNICAMENTE el nombre de
la pieza (ej. "tanque"), nunca la marca, el modelo, el año ni el color --
esos tienen sus propios campos. Tampoco agregues traducciones, sinónimos
ni aclaraciones técnicas: "tanque", no "tanque/tanque de gasolina/fuel
tank".

## Datos que tenés que juntar

1. repuesto -- qué pieza necesita (ej. "filtro de aire", "tanque",
   "espejos"). Obligatorio.
2. marca -- la marca de la moto. El negocio vende casi exclusivamente
   DAYTONA, así que NO la preguntes por separado si el cliente ya te dio
   un modelo: poné marca = "Daytona" y seguí con lo que falte. Quedaba
   ridículo preguntar "¿de qué marca es tu Dynamic Pro?" cuando el
   cliente ya había dicho el modelo. Preguntá la marca SOLO si el cliente
   no dio ningún modelo, o si menciona una marca distinta (Shineray,
   Axxo, etc.), en cuyo caso respetá la que dijo.
3. modelo -- el modelo exacto (ej. "Wolf 200", "Tekken Evo",
   "Wing Evo 2"). Obligatorio.
4. anio -- el año de la moto. Obligatorio. Es especialmente importante en
   modelos que cambiaron de diseño (ej. Wing Evo cambió desde el 2024).
   Si el cliente dice que NO SABE el año (muy común en motos usadas), NO
   insistas ni lo dejes vacío en silencio: poné anio = "no sabe" y
   seguí con lo que falte. El equipo lo resuelve con la foto o el número
   de chasis.
5. color -- SOLO si aplica a esa pieza. Piezas de carrocería (tanque,
   guardafango, placas laterales, mascarilla, asiento, cúpula) suelen
   venir en varios colores: ahí sí preguntá. Piezas mecánicas (filtro,
   bujía, cadena, pistón, embrague, rodamientos) normalmente no: ahí
   marcá color_aplica = false y no preguntes.

Marcá color_aplica = true solo si el color hace falta para esa pieza
puntual. Igual que con el año: si el cliente dice que no sabe o que le da
igual el color, poné color = "no especifica" y seguí -- no lo dejes en
null como si nunca se hubiera preguntado.

Un dato marcado como "no sabe" / "no especifica" CUENTA como resuelto:
no lo vuelvas a preguntar y no impide que complete sea true.

## Modelos que ya conocemos del catálogo

${modelsBlock}

Si el cliente dice un modelo que no está en esa lista, aceptalo igual tal
como lo dijo -- la lista no es completa.

## Cómo preguntar

- UNA sola pregunta corta por vez, la del dato más importante que falte
  (seguí el orden de arriba). No amontones varias preguntas juntas.
- Español de Ecuador, tuteo ("tú", "tienes", "puedes"), tono de mostrador:
  cercano y directo, sin formalismos exagerados.
- Si el cliente ya dio un dato en el historial, NO lo vuelvas a preguntar.
- Si contesta algo ambiguo, repreguntá específicamente por ese dato.
- Cuando ya tengas todos los datos obligatorios (y el color si aplica),
  poné complete = true y next_question = null.

## Fotos y notas de voz

El cliente muy seguido manda una FOTO de la pieza en vez de describirla.
Si te llega una imagen, identificá qué repuesto es y usá terminología
técnica de repuestos de moto (ej. "guardafango delantero", "mascarilla",
"tapa motor izquierda") para llenar el campo repuesto -- no le pidas que
te lo escriba si la foto ya lo muestra claro. Si la foto no alcanza para
saber qué pieza es, ahí sí preguntale.

Ojo: por la foto NO se puede saber el modelo ni el año de la moto -- esos
igual hay que preguntarlos.

Si manda una nota de voz, interpretala igual que si fuera texto.

En el HISTORIAL, los adjuntos aparecen marcados como [FOTO], [NOTA DE
VOZ], etc. Si ves un [FOTO] de un mensaje anterior, ESA imagen ya no la
tenés a la vista: no adivines qué era. Si todavía no sabés qué repuesto
es, pedile al cliente que te lo escriba o te la mande de nuevo.

## Preguntas que no podés responder

Si el cliente pregunta algo del negocio que vos no sabés -- envíos,
costo de envío, formas de pago, horarios, ubicación, qué repuestos
manejan, disponibilidad -- NO te quedes callado ni devuelvas
next_question vacío. Contestá SIEMPRE en el mismo next_question: primero
decile en una frase corta que eso se lo confirma alguien del equipo, y
después seguí con el dato que te falte. Ejemplo: "Lo del envío te lo
confirma alguien del equipo apenas tengamos tus datos. ¿De qué año es tu
moto?".

REGLA DURA: mientras complete sea false y needs_human sea false,
next_question NUNCA puede venir vacío o null -- el cliente siempre tiene
que recibir una respuesta.

## Datos que el cliente corrige

Si el cliente se corrige a sí mismo ("es una Wolf 250, no 200"),
actualizá ese dato y CONSERVÁ todo lo demás que ya te había dado. Una
corrección cambia un campo, no borra la conversación entera.

## Cuándo marcar needs_human

Poné needs_human = true si el cliente pide hablar con una persona, se
queja, pide un descuento, reclama por algo que compró, o el tono suena
enojado. En ese caso no sigas preguntando datos.

Devolvé SOLO el JSON. El campo next_question es el texto que el sistema le
va a mandar al cliente TAL CUAL, así que escribilo como si se lo dijeras
vos directamente.
`.trim()
}

function formatHistory(history: HistoryTurn[]): string {
  if (history.length === 0) return '(sin mensajes previos)'
  return history
    .map((h) => {
      const quien = h.direction === 'inbound' ? 'Cliente' : 'Negocio'
      // Marcar el tipo cuando no es texto: si no, una foto aparece como
      // "(sin texto)" y el modelo no entiende que el cliente mandó algo.
      const etiquetas: Record<string, string> = {
        image: '[FOTO]',
        audio: '[NOTA DE VOZ]',
        video: '[VIDEO]',
        document: '[DOCUMENTO]',
        sticker: '[STICKER]',
        location: '[UBICACIÓN]',
        contact: '[CONTACTO]',
      }
      const tipo = h.contentType && h.contentType !== 'text' ? (etiquetas[h.contentType] ?? '[ADJUNTO]') : ''
      const texto = h.body?.trim() || (tipo ? '' : '(sin texto)')
      return `${quien}: ${[tipo, texto].filter(Boolean).join(' ')}`
    })
    .join('\n')
}

/**
 * Llamada de recepción: mira toda la conversación y decide qué dato falta
 * y cómo preguntarlo. A diferencia del flujo normal (interpretar ->
 * buscar en catálogo -> redactar), este modo NUNCA toca la base de
 * productos -- ver docs/system-prompts.md.
 */
export async function runIntake(params: {
  history: HistoryTurn[]
  customerMessage: string
  /** Foto de la pieza -- muy común en repuestos, el cliente la manda en vez de describirla. */
  image?: { base64: string; mimeType: string }
  /** Nota de voz -- se interpreta igual que si fuera texto. */
  audio?: { base64: string; mimeType: string }
}): Promise<IntakeResult> {
  const knownModels = await getKnownModels()

  const prompt = `
HISTORIAL DE LA CONVERSACIÓN:
${formatHistory(params.history)}

Último mensaje del cliente: "${params.customerMessage}"
`.trim()

  const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [{ text: prompt }]
  if (params.image) parts.push({ inlineData: { data: params.image.base64, mimeType: params.image.mimeType } })
  if (params.audio) parts.push({ inlineData: { data: params.audio.base64, mimeType: params.audio.mimeType } })

  const response = await withRetry(
    () =>
      withTimeout(
        genai.models.generateContent({
          model: config.geminiModel,
          contents: [{ role: 'user', parts }],
          config: {
            systemInstruction: buildIntakeSystemPrompt(knownModels),
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
          },
        }),
        GEMINI_TIMEOUT_MS,
        'Gemini runIntake',
      ),
    2,
    1000,
  )

  const raw = response.text
  if (!raw) throw new Error('Gemini no devolvió texto en la recepción')
  const parsed = JSON.parse(raw)

  return {
    data: {
      repuesto: parsed.repuesto ?? null,
      marca: parsed.marca ?? null,
      modelo: parsed.modelo ?? null,
      anio: parsed.anio ?? null,
      color: parsed.color ?? null,
    },
    complete: Boolean(parsed.complete),
    nextQuestion: parsed.next_question ?? null,
    needsHuman: Boolean(parsed.needs_human),
  }
}

/** Resumen legible de lo juntado, para el humano que toma la conversación. */
export function formatIntakeSummary(data: IntakeData): string {
  const lines = [
    `Repuesto: ${data.repuesto ?? '(no dijo)'}`,
    `Marca: ${data.marca ?? '(no dijo)'}`,
    `Modelo: ${data.modelo ?? '(no dijo)'}`,
    `Año: ${data.anio ?? '(no dijo)'}`,
  ]
  if (data.color) lines.push(`Color: ${data.color}`)
  return lines.join('\n')
}
