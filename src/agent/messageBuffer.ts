import type { WAMessage } from '@whiskeysockets/baileys'
import type { ParsedMessage } from '../whatsapp/parseMessage.js'

/**
 * Junta la RÁFAGA de mensajes de un cliente antes de contestarle.
 *
 * El problema, visto en una conversación real:
 *
 *     CLIENTE  Buenas tardes moto tuko cr3 max 200
 *     CLIENTE  busco rin trasero
 *     BOT      ¿Qué repuesto estás buscando para tu Tuko CR3 Max 200?
 *     BOT      ¿De qué año es tu moto?
 *
 * El cliente YA había dicho qué quería. Pero la gente escribe en varios
 * mensajes cortos, y cada uno disparaba su propio procesamiento: el bot
 * contestó el primero sin haber leído el segundo, y encima mandó dos
 * preguntas seguidas. Del lado del cliente eso se siente como que no lo
 * están escuchando -- y se nota en los números: 12 de 13 respuestas del
 * bot fueron "pedir aclaración".
 *
 * Acá se espera a que el cliente termine de escribir y se procesa TODO
 * junto, como haría una persona: leer los tres mensajes y contestar una
 * vez.
 *
 * Lo que NO se demora es el registro: el mensaje se guarda apenas llega
 * (eso pasa antes, en handleMessage), así que el ERP lo muestra en vivo.
 * Lo único que espera es la respuesta automática.
 */

/**
 * Silencio que hay que ver para dar por terminada la ráfaga. Se eligió
 * corto: el cliente está esperando del otro lado y una demora larga se
 * siente peor que una respuesta imperfecta.
 */
const ESPERA_MS = 7000

/**
 * Tope desde el primer mensaje de la ráfaga. Sin esto, alguien que manda
 * un mensaje cada 6 segundos sin parar no recibiría respuesta nunca.
 */
const ESPERA_MAXIMA_MS = 25000

export type MensajeEnRafaga = { parsed: ParsedMessage; msg: WAMessage }

type Rafaga = {
  mensajes: MensajeEnRafaga[]
  temporizador: NodeJS.Timeout
  /** Cuándo llegó el primero, para respetar el tope. */
  desde: number
}

const rafagas = new Map<number, Rafaga>()

/**
 * Junta el mensaje con los que ya estaban esperando de esa conversación y
 * llama a `procesar` cuando la ráfaga se da por cerrada.
 *
 * `procesar` recibe TODOS los mensajes juntos, en el orden en que
 * llegaron.
 */
export function encolarParaProcesar(
  conversationId: number,
  entrada: MensajeEnRafaga,
  procesar: (mensajes: MensajeEnRafaga[]) => Promise<void>,
): void {
  const existente = rafagas.get(conversationId)
  const ahora = Date.now()
  const desde = existente?.desde ?? ahora

  if (existente) clearTimeout(existente.temporizador)
  const mensajes = [...(existente?.mensajes ?? []), entrada]

  const disparar = () => {
    rafagas.delete(conversationId)
    procesar(mensajes).catch((err) =>
      console.error(`Error procesando la ráfaga de la conversación ${conversationId}:`, err),
    )
  }

  // Lo que quede del tope, para no pasarse esperando a alguien que escribe
  // sin parar.
  const restante = Math.max(0, ESPERA_MAXIMA_MS - (ahora - desde))
  const espera = Math.min(ESPERA_MS, restante)

  rafagas.set(conversationId, { mensajes, desde, temporizador: setTimeout(disparar, espera) })
}

/**
 * Junta los textos de la ráfaga en un solo mensaje para el intérprete.
 *
 * Va con saltos de línea y no con espacios: son mensajes distintos, y
 * pegarlos como una sola frase corrida ("hola busco rin trasero de que
 * año") le hace perder al modelo dónde termina uno y empieza el otro.
 */
export function textoDeLaRafaga(mensajes: MensajeEnRafaga[]): string {
  const partes: string[] = []
  for (const { parsed } of mensajes) {
    if (parsed.body?.trim()) {
      partes.push(parsed.body.trim())
      continue
    }
    // Un mensaje sin texto igual dice algo: que mandó una foto de la pieza
    // o una nota de voz. El contenido en sí va aparte, como media.
    if (parsed.contentType === 'image') partes.push('(foto)')
    else if (parsed.contentType === 'audio') partes.push('(nota de voz)')
  }
  return partes.join('\n')
}

/**
 * La foto o la nota de voz de la ráfaga que hay que mandarle a Gemini.
 *
 * Se toma la ÚLTIMA: si el cliente mandó dos fotos, la segunda suele ser
 * la que corrige a la primera ("perdón, esta se ve mejor").
 */
export function mediaDeLaRafaga(mensajes: MensajeEnRafaga[]): MensajeEnRafaga | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const tipo = mensajes[i].parsed.contentType
    if (tipo === 'image' || tipo === 'audio') return mensajes[i]
  }
  return null
}
