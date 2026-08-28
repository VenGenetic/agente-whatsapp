import { GoogleGenAI, type GenerateContentParameters, type GenerateContentResponse, type ThinkingConfig } from '@google/genai'
import { config } from '../config.js'

export const genai = new GoogleGenAI({ apiKey: config.geminiApiKey })

/**
 * Toda llamada al modelo pasa por acá, para poder fijar en UN solo lugar
 * cuánto "piensa" antes de responder.
 *
 * Los modelos Flash nuevos razonan por defecto y esos tokens se COBRAN
 * aunque no se vean, así que valía la pena probar si se podían bajar.
 *
 * MEDIDO contra gemini-3.6-flash con el prompt real de recepción, y el
 * resultado fue que NO: por eso el default es `off` (no se manda el
 * parámetro).
 *
 *   - 'low' ROMPE la salida estructurada. El modelo empieza a volcar su
 *     propio razonamiento adentro de los campos del JSON -- se vio
 *     repuesto = "tanquePool/tank/tanque" y hasta un campo con la frase
 *     "wait, let's format JSON cleanly" -- y devuelve next_question en
 *     null, o sea el cliente se queda sin respuesta. Inservible.
 *   - 'medium' contesta bien, pero no ahorra: 293 y 656 tokens de
 *     pensamiento en dos llamadas iguales, contra 310 del default.
 *
 * Queda como perilla porque el modelo se cambia por .env y el próximo
 * puede comportarse distinto. Si se toca, hay que volver a medir CALIDAD,
 * no solo latencia.
 */
let nivelNoSoportado = false

/** Un 400 de la API: el modelo no acepta ese parámetro. */
function esArgumentoInvalido(err: unknown): boolean {
  const mensaje = err instanceof Error ? err.message : String(err)
  return mensaje.includes('INVALID_ARGUMENT') || mensaje.includes('"code":400')
}

export async function generarContenido(params: GenerateContentParameters): Promise<GenerateContentResponse> {
  const nivel = config.geminiThinkingLevel
  if (!nivel || nivelNoSoportado) return genai.models.generateContent(params)

  try {
    return await genai.models.generateContent({
      ...params,
      config: {
        ...params.config,
        thinkingConfig: { ...params.config?.thinkingConfig, thinkingLevel: nivel as ThinkingConfig['thinkingLevel'] },
      },
    })
  } catch (err) {
    if (!esArgumentoInvalido(err)) throw err
    // No todos los modelos aceptan `thinkingLevel` (los 2.5 usan
    // `thinkingBudget`, y con un valor inválido devuelven 400 sin
    // explicar cuál). Si cambian el modelo por .env, el agente no puede
    // quedarse mudo por esto: se avisa una vez y se sigue sin fijarlo.
    nivelNoSoportado = true
    console.warn(
      `El modelo ${config.geminiModel} no acepta GEMINI_THINKING_LEVEL=${nivel}. Se sigue con el razonamiento por defecto.`,
    )
    return genai.models.generateContent(params)
  }
}
