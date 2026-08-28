/**
 * Cómo llamar al cliente por su nombre sin quedar en ridículo.
 *
 * Tratar a alguien por su nombre es lo que más rápido cambia el tono de
 * una conversación: "¿De qué año es tu moto?" y "Dale Andrés, ¿de qué año
 * es tu moto?" no se leen igual, aunque digan lo mismo.
 *
 * El problema es de dónde sale ese nombre. Lo único que tenemos es el
 * `pushName` de WhatsApp: el texto que la persona se puso a sí misma en su
 * perfil. Casi siempre es su nombre, pero muy seguido es cualquier otra
 * cosa -- el nombre del negocio ("Repuestos JP"), un apodo con emojis, un
 * número de teléfono, una frase.
 *
 * Y usar mal el nombre es MUCHO peor que no usarlo: "Dale Repuestos JP,
 * ¿de qué año es tu moto?" es exactamente la clase de detalle por el que
 * un cliente se da cuenta de que está hablando con un robot. Por eso acá
 * la regla es al revés de lo habitual: ante la duda, no se usa.
 */

/**
 * Palabras que delatan que el perfil es de un NEGOCIO y no de una persona.
 * Si aparece cualquiera, no se usa nada de ese nombre.
 */
const PALABRAS_DE_NEGOCIO = [
  'repuesto',
  'repuestos',
  'moto',
  'motos',
  'motorepuesto',
  'taller',
  'mecanica',
  'lubricadora',
  'importadora',
  'distribuidora',
  'comercial',
  'almacen',
  'ventas',
  'venta',
  'tienda',
  'servicio',
  'servicios',
  'sa',
  'cia',
  'srl',
  'ltda',
  'store',
  'shop',
  'parts',
]

/** Tratamientos que a veces vienen pegados adelante y no son el nombre. */
const TRATAMIENTOS = ['sr', 'sra', 'srta', 'don', 'dona', 'ing', 'lic', 'dr', 'dra', 'mr']

/** Sin tildes, sin emojis, sin signos: solo letras y espacios. */
function soloLetras(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * El primer nombre utilizable del cliente, o null si no hay ninguno
 * confiable.
 *
 * Devuelve UNA sola palabra: el nombre de pila. Nadie del mostrador dice
 * "Dale Juan Carlos Pérez"; dice "Dale Juan".
 */
export function nombreDePila(pushName: string | null | undefined): string | null {
  if (!pushName) return null

  const original = pushName.trim()
  // Un perfil con dígitos suele ser un teléfono o un nombre de negocio con
  // sucursal ("Repuestos 24"). No vale la pena arriesgarse.
  if (/\d/.test(original)) return null

  const limpio = soloLetras(original)
  if (!limpio) return null

  const palabras = limpio.toLowerCase().split(' ')

  // Un perfil de negocio no se trata por "su nombre".
  if (palabras.some((p) => PALABRAS_DE_NEGOCIO.includes(p))) return null

  // Cuatro palabras o más ya no es un nombre, es una frase de perfil
  // ("Dios es bueno todo el tiempo").
  if (palabras.length > 3) return null

  const primera = palabras.find((p) => !TRATAMIENTOS.includes(p) && p.length >= 3)
  if (!primera) return null
  // Más de 15 letras seguidas no es un nombre de pila.
  if (primera.length > 15) return null

  // Se devuelve capitalizado y no como vino: mucha gente escribe su perfil
  // TODO EN MAYÚSCULAS, y un "Dale JUAN" grita.
  const acentuada = palabraOriginal(original, primera) ?? primera
  return acentuada.charAt(0).toUpperCase() + acentuada.slice(1).toLowerCase()
}

/**
 * Recupera la palabra tal como venía (con tildes) a partir de su versión
 * sin acentos, para no escribir "Ramon" cuando la persona puso "Ramón".
 */
function palabraOriginal(original: string, sinAcentos: string): string | null {
  for (const palabra of original.split(/\s+/)) {
    if (soloLetras(palabra).toLowerCase() !== sinAcentos) continue
    // Se devuelven solo las letras: mucha gente encierra su nombre entre
    // emojis ("🔥Andres🔥") y esos no son parte de cómo se llama.
    return palabra.replace(/[^\p{L}]/gu, '')
  }
  return null
}
