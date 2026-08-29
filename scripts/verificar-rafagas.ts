/**
 * Comprueba que el agente ESPERE a que el cliente termine de escribir
 * antes de contestar (src/agent/messageBuffer.ts). No toca WhatsApp ni la
 * base: se puede correr cuando sea.
 *
 * Existe porque este arreglo salió de un fallo real, y sin una prueba se
 * vuelve a romper sin que nadie se entere:
 *
 *     CLIENTE  Buenas tardes moto tuko cr3 max 200
 *     CLIENTE  busco rin trasero
 *     BOT      ¿Qué repuesto estás buscando para tu Tuko CR3 Max 200?
 *
 * El cliente ya lo había dicho. El bot contestaba el primer mensaje sin
 * haber leído el segundo.
 *
 * Uso: npm run verificar-rafagas
 */
import type { WAMessage } from '@whiskeysockets/baileys'
import {
  encolarParaProcesar,
  mediaDeLaRafaga,
  textoDeLaRafaga,
  type MensajeEnRafaga,
} from '../src/agent/messageBuffer.js'
import type { ParsedMessage } from '../src/whatsapp/parseMessage.js'

let fallos = 0

function esperar(etiqueta: string, real: unknown, esperado: unknown): void {
  const ok = JSON.stringify(real) === JSON.stringify(esperado)
  if (ok) {
    console.log(`  OK   ${etiqueta}`)
  } else {
    fallos++
    console.log(`FALLÓ  ${etiqueta}`)
    console.log(`         esperado: ${JSON.stringify(esperado)}`)
    console.log(`         fue:      ${JSON.stringify(real)}`)
  }
}

/** Un mensaje mínimo, con lo único que mira el buffer. */
function mensaje(body: string | null, contentType: ParsedMessage['contentType'] = 'text'): MensajeEnRafaga {
  return {
    parsed: { body, contentType } as ParsedMessage,
    msg: {} as WAMessage,
  }
}

const CONV = 999

async function main(): Promise<void> {
  console.log('Verificando el agrupado de ráfagas (no se manda ningún mensaje).\n')

  // 1) El caso real que motivó el arreglo.
  console.log('Caso real: la moto en un mensaje y el repuesto en el siguiente')
  const rafagaReal = [mensaje('Buenas tardes moto tuko cr3 max 200'), mensaje('busco rin trasero')]
  esperar(
    'los dos mensajes llegan juntos al intérprete',
    textoDeLaRafaga(rafagaReal),
    'Buenas tardes moto tuko cr3 max 200\nbusco rin trasero',
  )

  // 2) Los adjuntos sin texto igual tienen que contarse: si no, una foto
  //    sola dejaría el mensaje vacío y el bot no sabría que llegó algo.
  console.log('\nAdjuntos')
  esperar(
    'una foto sin texto se anuncia',
    textoDeLaRafaga([mensaje(null, 'image')]),
    '(foto)',
  )
  esperar(
    'foto + pregunta escrita después',
    textoDeLaRafaga([mensaje(null, 'image'), mensaje('tienen este?')]),
    '(foto)\ntienen este?',
  )

  // 3) Con dos fotos gana la última: la segunda suele corregir a la primera.
  const dosFotos = [mensaje('mira', 'image'), mensaje('esta se ve mejor', 'image')]
  esperar('con dos fotos se usa la última', mediaDeLaRafaga(dosFotos)?.parsed.body, 'esta se ve mejor')
  esperar('sin adjuntos no hay media', mediaDeLaRafaga([mensaje('hola')]), null)

  // 4) Lo que de verdad importa: que se procese UNA sola vez.
  console.log('\nAgrupado en el tiempo')
  let vueltas = 0
  let recibidos: string[] = []
  await new Promise<void>((listo) => {
    const procesar = async (ms: MensajeEnRafaga[]) => {
      vueltas++
      recibidos = ms.map((m) => m.parsed.body ?? '')
      listo()
    }
    // Tres mensajes seguidos, como los escribe una persona.
    encolarParaProcesar(CONV, mensaje('hola'), procesar)
    setTimeout(() => encolarParaProcesar(CONV, mensaje('busco un cdi'), procesar), 300)
    setTimeout(() => encolarParaProcesar(CONV, mensaje('para wolf 200'), procesar), 600)
  })

  esperar('tres mensajes seguidos se procesan UNA sola vez', vueltas, 1)
  esperar('y llegan los tres, en orden', recibidos, ['hola', 'busco un cdi', 'para wolf 200'])

  // 5) Si llega otra ráfaga mientras la primera sigue trabajando, la
  // segunda espera. Antes podían quedar dos llamadas a Gemini y dos
  // respuestas simultáneas para el mismo cliente.
  console.log('\nProcesamiento exclusivo por conversación')
  const orden: string[] = []
  let liberarPrimera!: () => void
  const primeraTerminada = new Promise<void>((resolve) => { liberarPrimera = resolve })
  let arrancoPrimera!: () => void
  const primeraArranco = new Promise<void>((resolve) => { arrancoPrimera = resolve })
  let terminoSegunda!: () => void
  const segundaTermino = new Promise<void>((resolve) => { terminoSegunda = resolve })
  const convExclusiva = CONV + 1

  encolarParaProcesar(convExclusiva, mensaje('primera'), async () => {
    orden.push('inicio-1')
    arrancoPrimera()
    await primeraTerminada
    orden.push('fin-1')
  })
  await primeraArranco
  encolarParaProcesar(convExclusiva, mensaje('segunda'), async () => {
    orden.push('inicio-2')
    orden.push('fin-2')
    terminoSegunda()
  })
  // La segunda ráfaga alcanza a cerrar, pero no debe arrancar mientras la
  // primera sigue bloqueada.
  await new Promise((resolve) => setTimeout(resolve, 7500))
  esperar('la segunda espera mientras la primera procesa', orden, ['inicio-1'])
  liberarPrimera()
  await segundaTermino
  esperar('después se procesan estrictamente en orden', orden, ['inicio-1', 'fin-1', 'inicio-2', 'fin-2'])

  console.log('')
  if (fallos > 0) {
    console.log(`${fallos} comprobación(es) fallaron.`)
    process.exitCode = 1
    return
  }
  console.log('Todo bien: el agente lee la ráfaga completa antes de contestar.')
}

main().catch((err) => {
  console.error('Falló la verificación:', err)
  process.exitCode = 1
})
