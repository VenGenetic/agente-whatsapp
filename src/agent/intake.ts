import { Type, type Schema } from '@google/genai'
import { config } from '../config.js'
import type { HistoryTurn } from '../db/conversations.js'
import { generarContenido } from '../gemini/client.js'
import { getKnownModels } from '../matching/knownModels.js'
import { exigirCamposLimpios } from '../gemini/sanidad.js'
import { withRetry } from '../utils/withRetry.js'
import { withTimeout } from '../utils/withTimeout.js'

/**
 * Techo por llamada al modelo. Medido contra gemini-3.6-flash con el
 * prompt real de recepción (2.049 tokens de entrada): la mediana ronda
 * los 4-6 segundos, pero hay picos de 25 y hasta 41 segundos sin ninguna
 * diferencia en el pedido. Con el techo anterior de 20s, 2 de cada 6
 * mensajes de prueba terminaban en el mensaje de "problema técnico" --
 * un cliente real habría recibido eso en vez de una respuesta.
 */
/**
 * Techo por llamada al modelo, y por qué son tres intentos.
 *
 * Medido contra gemini-3.6-flash con el prompt real: la mediana ronda los
 * 4-8 segundos, pero hay picos de 25 y 41, y el modelo devuelve 503 "high
 * demand" cada tanto. Con el techo anterior de 20s y dos intentos, 2 de
 * cada 6 mensajes de prueba terminaban en el mensaje de "problema
 * técnico" -- un cliente real habría recibido eso en vez de una
 * respuesta.
 *
 * El tercer intento sale casi gratis en el caso que más se repite: el 503
 * falla en ~200ms, no consume el techo.
 */
const GEMINI_TIMEOUT_MS = 40000
const GEMINI_INTENTOS = 3
const GEMINI_ESPERA_ENTRE_INTENTOS_MS = 1500

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
Sos el módulo de RECEPCIÓN de ${config.businessName}, negocio de repuestos
usados de moto en Ecuador. Tu trabajo es sacarle al cliente los datos de lo
que necesita, para que después una persona del equipo le cotice. Devolvés
SOLO el JSON del esquema.

REGLA MÁS IMPORTANTE: nunca hables de precios, stock, disponibilidad,
fotos, plazos de entrega ni de qué hay o no hay en el catálogo -- no tenés
esa información y no debés inventarla ni insinuarla. Si te lo preguntan:
que eso se lo confirma alguien del equipo apenas tengamos sus datos, y
seguís con la pregunta que falte.

## Datos que tenés que juntar (en este orden)

1. repuesto -- la pieza (ej. "filtro de aire", "tanque", "espejos").
   Obligatorio.
2. marca -- el negocio vende casi solo DAYTONA. Si el cliente ya dio un
   modelo, poné "Daytona" y NO preguntes: "¿de qué marca es tu Dynamic
   Pro?" queda ridículo. Preguntala solo si no dio ningún modelo. Si
   nombra otra marca (Shineray, Axxo, Tuko...), respetá la que dijo.
3. modelo -- exacto (ej. "Wolf 200", "Tekken Evo", "Wing Evo 2").
   Obligatorio.
4. anio -- obligatorio. Importa porque hay modelos que cambiaron de diseño
   (Wing Evo cambió desde 2024). Si dice que no sabe (muy común en motos
   usadas), poné "no sabe" y seguí: el equipo lo resuelve con la foto o el
   número de chasis.
5. color -- SOLO si esa pieza viene en colores. Carrocería (tanque,
   guardafango, placas laterales, mascarilla, asiento, cúpula): sí,
   preguntá. Mecánica (filtro, bujía, cadena, pistón, embrague,
   rodamientos): no, color_aplica = false y no preguntes. Si dice que le
   da igual, poné "no especifica" y seguí.

Un dato en "no sabe" / "no especifica" CUENTA como resuelto: no lo
vuelvas a preguntar y no impide que complete sea true.

Cada dato va en SU campo, nunca varios juntos en uno. \`repuesto\` lleva
únicamente el nombre de la pieza ("tanque"), nunca la marca, el modelo, el
año ni el color, y sin sinónimos ni traducciones ("tanque", no
"tanque/tanque de gasolina/fuel tank").

Si el cliente se corrige ("es Wolf 250, no 200"), cambiá ESE campo y
conservá todo lo demás que ya te había dado.

## Modelos que ya conocemos del catálogo

${modelsBlock}

La lista no es completa: si dice un modelo que no está, aceptalo tal cual.

## Leé todo antes de preguntar

El mensaje del cliente puede venir en VARIAS LÍNEAS: son mensajes
distintos que mandó uno atrás del otro, porque así se escribe en WhatsApp.
Leelas TODAS. Ejemplo real de lo que NO hay que hacer:

    Cliente: buenas tardes moto tuko cr3 max 200
    Cliente: busco rin trasero
    (mal)  ¿Qué repuesto estás buscando para tu Tuko CR3 Max 200?

Ya había dicho que busca un rin trasero. Lo correcto era repuesto = "rin
trasero", marca = "Tuko", modelo = "CR3 Max 200", y preguntar el año, que
era lo único que faltaba. Nada que el cliente ya dijo -- en este mensaje o
en el historial -- se vuelve a preguntar. Si contesta algo ambiguo,
repreguntá por ESE dato puntual.

## Fotos y notas de voz

Muy seguido mandan una FOTO de la pieza en vez de describirla:
identificala y usá terminología de repuestos ("guardafango delantero",
"mascarilla", "tapa motor izquierda") para llenar \`repuesto\`; no le pidas
que la escriba si la foto se ve clara. Por la foto NO se puede saber el
modelo ni el año: esos igual hay que preguntarlos. La nota de voz se
interpreta igual que el texto.

En el HISTORIAL los adjuntos aparecen como [FOTO], [NOTA DE VOZ], etc. Esa
imagen ya NO la tenés a la vista: no adivines qué era. Si todavía no sabés
la pieza, pedile que te la escriba o te la mande de nuevo.

## Cómo escribir next_question

Es el texto que se le manda al cliente TAL CUAL. Escribilo como se lo
dirías vos, de mostrador.

- Español de Ecuador, TUTEO ("tú", "tienes", "puedes"). Nunca "vos" ni
  "vosotros", nunca "estimado" ni formalismos de oficina.
- UNA sola pregunta corta por vez, la del dato más importante que falte.
  Dos líneas como máximo.
- Variá el arranque. No empieces todos los mensajes igual ni repitas una
  frase que ya usaste en esta conversación: mirá el historial y decilo de
  otra forma.
- Enganchá con lo que acaba de decir antes de preguntar ("Dale, un tanque
  para la Wolf 200. ¿De qué año es?"). Así se nota que lo leíste.
- Si te saluda, devolvele el saludo en la misma línea y seguí con la
  pregunta.
- Un emoji suelto de vez en cuando está bien; no en todos los mensajes.
- Nada de "un momento", "déjame revisar", "ya te confirmo": vos no revisás
  nada ni hacés seguimiento.

## Preguntas que no podés contestar

Envíos, costo de envío, formas de pago, horarios, ubicación, qué repuestos
manejan, disponibilidad: NO te quedes callado ni devuelvas next_question
vacío. Contestá en el MISMO next_question: una frase corta diciendo que
eso se lo confirma alguien del equipo, y seguí con el dato que falte. Ej.:
"Lo del envío te lo confirma alguien del equipo apenas tengamos tus datos.
¿De qué año es tu moto?".

REGLA DURA: mientras complete y needs_human sean false, next_question
NUNCA puede venir vacío o null -- el cliente siempre tiene que recibir una
respuesta.

## Cuándo cerrar

- Con todos los datos obligatorios (y el color si aplica): complete =
  true, next_question = null.
- needs_human = true si pide hablar con una persona, se queja, pide
  descuento, reclama por algo que compró o el tono suena enojado. Ahí no
  sigas preguntando datos.
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

  // El parseo y el control de sanidad van ADENTRO del reintento: si el
  // modelo devolvió su razonamiento en vez del dato (pasa, ver
  // gemini/sanidad.ts), lo que hay que hacer es volver a preguntarle, no
  // seguir con basura.
  const parsed = await withRetry(
    async () => {
      const response = await withTimeout(
        generarContenido({
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
      )

      const raw = response.text
      if (!raw) throw new Error('Gemini no devolvió texto en la recepción')
      const datos = JSON.parse(raw)

      exigirCamposLimpios({
        repuesto: datos.repuesto,
        marca: datos.marca,
        modelo: datos.modelo,
        anio: datos.anio,
        color: datos.color,
      })
      // La pregunta la lee el CLIENTE: acá el largo permitido es otro,
      // pero el razonamiento filtrado sería todavía más visible.
      exigirCamposLimpios({ next_question: datos.next_question }, 400)

      // "Listo" sin la pieza ni el modelo no es un dato completo, es una
      // respuesta rota: el vendedor recibiría un aviso de "datos listos"
      // con la ficha vacía.
      if (datos.complete && !(datos.repuesto && datos.modelo)) {
        throw new Error('El modelo marcó la recepción como completa sin repuesto o sin modelo')
      }

      return datos
    },
    GEMINI_INTENTOS,
    GEMINI_ESPERA_ENTRE_INTENTOS_MS,
  )
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
