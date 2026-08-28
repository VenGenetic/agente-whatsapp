/**
 * El saludo de apertura, resuelto en código y no con una llamada a Gemini.
 *
 * Dos razones, y las dos importan para encender el agente:
 *
 * 1. PLATA. "hola" / "buenas tardes" es el primer mensaje de casi toda
 *    conversación nueva. Mandarlo a interpretar y después a redactar son
 *    dos llamadas al modelo (o una, en modo recepción) para producir algo
 *    que no depende de nada que el cliente haya dicho -- porque no dijo
 *    nada todavía. Es el único mensaje del flujo cuya respuesta se puede
 *    saber de antemano sin perder ni una pizca de calidad.
 *
 * 2. VARIEDAD. Pedirle al modelo que "salude distinto cada vez" no
 *    funciona: no ve lo que le contestó a los otros clientes, así que
 *    converge siempre a la misma frase. Acá hay 56 combinaciones y se
 *    descarta la que ya se usó en ese chat, cosa que el modelo no puede
 *    hacer solo.
 *
 * Lo que NO hace: si el cliente dice cualquier cosa además del saludo
 * ("buenas, busco un tanque"), esto no se activa -- ahí sí hay que
 * entender qué pidió, y de eso se encarga el flujo normal.
 */

import { config } from '../config.js'

/** Ecuador es UTC-5 todo el año (no hay horario de verano). */
const OFFSET_ECUADOR_MS = 5 * 60 * 60 * 1000

function saludoSegunLaHora(ahora: Date): string {
  const hora = new Date(ahora.getTime() - OFFSET_ECUADOR_MS).getUTCHours()
  if (hora < 12) return 'Buenos días'
  if (hora < 19) return 'Buenas tardes'
  return 'Buenas noches'
}

/**
 * Aperturas y preguntas se combinan (8 x 7). Separarlas en dos listas da
 * mucha más variedad que escribir 56 saludos enteros a mano, y evita que
 * dos variantes queden casi iguales.
 *
 * `{s}` = el saludo de la franja horaria, `{n}` = el nombre del negocio.
 */
const APERTURAS = [
  '¡{s}! Bienvenido a {n}.',
  '¡{s}! Gracias por escribir a {n}.',
  '¡{s}!',
  '¡{s}! ¿Cómo estás?',
  '¡{s}! Habla {n}.',
  '¡Hola! ¿Cómo estás?',
  '¡{s}! ¿Cómo va todo?',
  '¡{s}! Un gusto saludarte.',
]

const PREGUNTAS = [
  '¿Qué repuesto andas buscando?',
  '¿Qué repuesto necesitas?',
  'Cuéntame qué repuesto buscas y para qué moto, y te ayudo.',
  '¿Qué pieza necesitas y para qué moto es?',
  'Dime qué repuesto buscas y para qué modelo, y lo revisamos.',
  '¿Qué estás buscando para tu moto?',
  '¿En qué te puedo ayudar?',
]

/**
 * Deja el texto comparable: sin tildes, sin mayúsculas, sin signos y con
 * las letras repetidas colapsadas ("holaaa" y "buenasss" son lo mismo que
 * "hola" y "buenas" -- así se escribe en WhatsApp).
 *
 * Ninguna de las palabras de cortesía que reconocemos lleva letra doble
 * legítima, así que colapsarlas no confunde ninguna con otra.
 */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/([a-z])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Palabras que por sí solas no piden nada. Si el mensaje entero está
 * hecho únicamente de estas, el cliente saludó y nada más.
 *
 * Se dejaron AFUERA a propósito las que parecen cortesía pero son una
 * pregunta real del negocio ("atienden", "abierto", "info"): esas tiene
 * que verlas una persona, no un saludo automático.
 */
const PALABRAS_DE_CORTESIA = new Set(
  [
    'hola', 'holi', 'ola', 'alo', 'hey', 'ey', 'hi', 'hello',
    'buenas', 'buenos', 'buena', 'bueno', 'buen',
    'dias', 'dia', 'tardes', 'tarde', 'noches', 'noche',
    'saludos', 'saludo', 'saludandolo', 'saludandole',
    'que', 'tal', 'como', 'esta', 'estas', 'estan', 'usted', 'ustedes',
    'gracias', 'por', 'favor', 'disculpe', 'disculpa', 'permiso',
    'senor', 'senora', 'senorita', 'don', 'dona', 'amigo', 'amiga', 'compa',
    'feliz', 'muy', 'cordial', 'cordialmente', 'bendiciones',
  ].map(normalizar),
)

/** Más de esto ya no es un saludo suelto, aunque todas sean de cortesía. */
const MAXIMO_DE_PALABRAS = 8

/**
 * true si el cliente solo saludó: ni pieza, ni modelo, ni pregunta.
 *
 * Cualquier número lo descarta de entrada -- un año, un cilindraje o un
 * "250" es información del pedido, y responderle con un saludo genérico
 * sería ignorar justo el dato que dio.
 */
export function esSaludoPuro(texto: string | null | undefined): boolean {
  if (!texto) return false
  const limpio = normalizar(texto)
  if (!limpio) return false
  if (/\d/.test(limpio)) return false

  const palabras = limpio.split(' ')
  if (palabras.length > MAXIMO_DE_PALABRAS) return false
  return palabras.every((palabra) => PALABRAS_DE_CORTESIA.has(palabra))
}

/**
 * El saludo que se le manda. `yaDichos` son los textos que el negocio ya
 * mandó en ese chat: sirven para no repetir la misma frase con el mismo
 * cliente (que es lo que delata a un bot más rápido que cualquier otra
 * cosa).
 */
export function textoDeSaludo(opciones?: { yaDichos?: string[]; ahora?: Date }): string {
  const saludo = saludoSegunLaHora(opciones?.ahora ?? new Date())
  const negocio = config.businessName

  const variantes: string[] = []
  for (const apertura of APERTURAS) {
    for (const pregunta of PREGUNTAS) {
      variantes.push(`${apertura.replace('{s}', saludo).replace('{n}', negocio)} ${pregunta}`)
    }
  }

  const usados = new Set((opciones?.yaDichos ?? []).map(normalizar))
  const disponibles = variantes.filter((v) => !usados.has(normalizar(v)))
  // Si de casualidad se usaron las 56, mejor repetir una que no contestar.
  const candidatas = disponibles.length > 0 ? disponibles : variantes
  return candidatas[Math.floor(Math.random() * candidatas.length)]
}
