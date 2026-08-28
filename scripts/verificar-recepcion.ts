/**
 * Comprueba las defensas de la recepción, todas nacidas de fallas reales
 * vistas en pruebas contra gemini-3.6-flash. No toca WhatsApp, ni la base,
 * ni Gemini: se puede correr cuando sea.
 *
 * Existe porque todas son invisibles cuando se rompen -- el bot sigue
 * contestando, solo que mal:
 *
 *   - El saludo vuelve a costar una llamada por cada "hola", o peor: le
 *     contesta una bienvenida a alguien con quien ya se venía hablando.
 *   - Se trata por "su nombre" a un perfil que se llama "Repuestos JP".
 *   - El razonamiento del modelo ("tanquePool/tank/tanque") se guarda como
 *     si fuera el repuesto, y llega al resumen del vendedor.
 *   - Le llega al cliente un "Buen###ísimo, 2019."
 *   - Se le manda el mensaje de falla a alguien por un campo sucio que se
 *     podía descartar.
 *
 * Uso: npm run verificar-recepcion
 */
import { correspondeSaludar, esSaludoPuro, textoDeSaludo } from '../src/agent/saludos.js'
import { rescatarLoLimpio } from '../src/agent/intake.js'
import { campoContaminado, limpiarTextoParaElCliente } from '../src/gemini/sanidad.js'
import { nombreDePila } from '../src/agent/nombreDelCliente.js'

let fallos = 0

function esperar(etiqueta: string, real: unknown, esperado: unknown): void {
  if (JSON.stringify(real) === JSON.stringify(esperado)) {
    console.log(`  OK   ${etiqueta}`)
    return
  }
  fallos++
  console.log(`FALLÓ  ${etiqueta}`)
  console.log(`         esperado: ${JSON.stringify(esperado)}`)
  console.log(`         fue:      ${JSON.stringify(real)}`)
}

/** Un turno del historial, con lo único que mira la regla del saludo. */
const del = (direction: 'inbound' | 'outbound') => ({ direction })

function verificarSaludos(): void {
  console.log('\nQué cuenta como saludo pelado')
  const soloCortesia = ['hola', 'Buenas tardes', 'buenas tardes, como esta?', 'holaaa', 'Buenos dias señor', 'que tal']
  for (const texto of soloCortesia) esperar(`"${texto}" es saludo`, esSaludoPuro(texto), true)

  console.log('\nQué NO cuenta (tiene que verlo el modelo)')
  const noEsSaludo: Array<[string, string]> = [
    ['hola busco un tanque', 'trae el repuesto'],
    ['buenas tengo una wolf 200', 'trae la moto'],
    ['Hola, ¿me pueden ayudar?', 'pide algo'],
    ['buenas atienden hoy?', 'es una pregunta del negocio'],
    ['2019', 'es un dato'],
    ['', 'no hay texto'],
  ]
  for (const [texto, porque] of noEsSaludo) {
    esperar(`"${texto}" no es saludo (${porque})`, esSaludoPuro(texto), false)
  }

  console.log('\nCuándo corresponde saludar desde el banco')
  esperar(
    'chat nuevo, saludo pelado, sin adjunto -> sí',
    correspondeSaludar({ texto: 'buenas', tieneMedia: false, historial: [] }),
    true,
  )
  esperar(
    'ya le contestamos antes -> no (se contesta con el contexto)',
    correspondeSaludar({ texto: 'buenas', tieneMedia: false, historial: [del('inbound'), del('outbound')] }),
    false,
  )
  esperar(
    'mandó una foto -> no (hay que mirarla)',
    correspondeSaludar({ texto: 'buenas', tieneMedia: true, historial: [] }),
    false,
  )
  // El cliente escribió antes pero nadie le contestó (chat viejo sin
  // atender): ahí sí corresponde saludar, es la primera vez que hablamos.
  esperar(
    'escribió antes y nunca le contestamos -> sí',
    correspondeSaludar({ texto: 'hola', tieneMedia: false, historial: [del('inbound'), del('inbound')] }),
    true,
  )

  console.log('\nEl saludo que sale')
  const manana = textoDeSaludo({ ahora: new Date('2026-08-28T14:00:00Z') }) // 09:00 en Ecuador
  const tarde = textoDeSaludo({ ahora: new Date('2026-08-28T20:00:00Z') }) // 15:00
  const noche = textoDeSaludo({ ahora: new Date('2026-08-29T01:00:00Z') }) // 20:00
  esperar('a las 9 saluda de mañana', /Buenos días|Hola/.test(manana), true)
  esperar('a las 15 no dice "buenos días"', manana === tarde || !tarde.includes('Buenos días'), true)
  esperar('a las 20 no dice "buenas tardes"', !noche.includes('Buenas tardes'), true)

  // Lo que importa del saludo: que además de saludar, PIDA el dato. Un
  // "buenas tardes" solo deja al cliente esperando y suma un mensaje al
  // chat sin hacer avanzar nada.
  //
  // No se mira el "?": dos de las variantes lo piden sin signo ("Cuéntame
  // qué repuesto buscas y para qué moto"), que es igual de válido y suena
  // más de mostrador. Lo que no puede faltar es el pedido en sí.
  const cien = Array.from({ length: 100 }, () => textoDeSaludo())
  esperar('siempre pide el repuesto o la moto', cien.every((s) => /repuesto|pieza|buscando|ayudar/i.test(s)), true)
  esperar('nunca sale vacío', cien.every((s) => s.trim().length > 10), true)
  esperar('hay variedad real (más de 10 textos distintos en 100)', new Set(cien).size > 10, true)
}

function verificarSanidad(): void {
  console.log('\nCampos que el modelo ensució (casos textuales de las pruebas)')
  const sucios = [
    'tanquePool/tank/tanque',
    'mascarilla light/frontal/mascarilla (según foto anterior)',
    "tanque Henrique? No, standard tanque. Wait, let's keep it strictly 'tanque'",
    'tanqueCompleto|tanque|tanque de gasolina|tanque de combustible|tanque metalico',
  ]
  for (const valor of sucios) esperar(`se descarta: "${valor.slice(0, 40)}…"`, campoContaminado(valor), true)

  console.log('\nDatos de verdad que NO se pueden descartar')
  const limpios = [
    'tanque',
    'filtro de aire',
    'guardafango delantero izquierdo',
    'Wolf 200',
    'CR3 Max 200',
    'no sabe',
    'no especifica',
    'placas laterales delanteras',
    'tapa motor izquierda',
  ]
  for (const valor of limpios) esperar(`pasa: "${valor}"`, campoContaminado(valor), false)

  // La pregunta al cliente es prosa: dos líneas son normales, y una barra
  // ("negro/rojo") no la vuelve sospechosa. Por eso lleva su propio largo.
  esperar(
    'una pregunta larga con barra no se descarta',
    campoContaminado('¿Lo quieres negro/rojo, o te da igual el color?', 400),
    false,
  )
}

function verificarNombre(): void {
  console.log('\nDe qué perfiles de WhatsApp se puede sacar un nombre')
  const casos: Array<[string | null, string | null]> = [
    ['Andrés', 'Andrés'],
    ['ANDRES PEREZ', 'Andres'],
    ['juan carlos rodriguez', 'Juan'],
    ['Sr. Ramón Vega', 'Ramón'],
    ['Ma. Fernanda Loor', 'Fernanda'],
    ['🔥Andres🔥', 'Andres'],
    // Tratar por "su nombre" a un negocio es peor que no usar ninguno.
    ['Repuestos JP', null],
    ['Moto Center', null],
    ['Taller El Rayo', null],
    ['0987654321', null],
    ['Dios es bueno todo el tiempo', null],
    ['JP', null],
    [null, null],
  ]
  for (const [perfil, esperado] of casos) {
    esperar(`${JSON.stringify(perfil)} -> ${JSON.stringify(esperado)}`, nombreDePila(perfil), esperado)
  }
}

function verificarTextoAlCliente(): void {
  console.log('\nBasura de formato que el modelo mete en el texto del cliente')
  esperar(
    'el caso real visto en pruebas',
    limpiarTextoParaElCliente('Buen###ísimo, 2019. "?"¿En qué color necesitas el tanque?'),
    'Buenísimo, 2019. ¿En qué color necesitas el tanque?',
  )
  esperar(
    'asteriscos de negrita fuera',
    limpiarTextoParaElCliente('*Listo*, ¿de qué año es tu moto?'),
    'Listo, ¿de qué año es tu moto?',
  )
  esperar(
    'un mensaje sano no se toca',
    limpiarTextoParaElCliente('Dale Andrés, ¿de qué año es tu Wolf 200?'),
    'Dale Andrés, ¿de qué año es tu Wolf 200?',
  )
  esperar(
    'los puntos suspensivos son legítimos',
    limpiarTextoParaElCliente('Perfecto... ¿y de qué color?'),
    'Perfecto... ¿y de qué color?',
  )
  esperar(
    'las comillas de verdad se respetan',
    limpiarTextoParaElCliente('¿Te referís al "tanque" o a las placas laterales?'),
    '¿Te referís al "tanque" o a las placas laterales?',
  )
}

function verificarRescate(): void {
  console.log('\nQué se rescata cuando el modelo insiste en ensuciar la respuesta')

  const conRepuestoSucio = rescatarLoLimpio({
    repuesto: 'tanquePool/tank/tanque',
    marca: 'Daytona',
    modelo: 'Wolf 200',
    anio: '2019',
    color: 'negro',
    complete: true,
    next_question: null,
  })
  esperar('el campo sucio se descarta', conRepuestoSucio.repuesto, null)
  esperar('lo limpio se conserva', conRepuestoSucio.modelo, 'Wolf 200')
  esperar('y el año también', conRepuestoSucio.anio, '2019')
  // Lo importante: sin la pieza NO se le puede avisar al vendedor que los
  // datos están listos, aunque el modelo lo haya dicho.
  esperar('ya no está completa (falta la pieza)', conRepuestoSucio.complete, false)

  const soloLaPregunta = rescatarLoLimpio({
    repuesto: 'tanque',
    marca: 'Daytona',
    modelo: 'Wolf 200',
    anio: null,
    color: null,
    complete: false,
    next_question: "Wait, the user said Wolf. Let's ask the year. next_question: ¿De qué año?",
  })
  esperar('una pregunta contaminada no se le manda al cliente', soloLaPregunta.next_question, null)
  esperar('pero los datos que sí dio se conservan', soloLaPregunta.repuesto, 'tanque')

  const sana = rescatarLoLimpio({
    repuesto: 'filtro de aire',
    marca: 'Daytona',
    modelo: 'Tekken 250',
    anio: 'no sabe',
    color: null,
    complete: true,
    next_question: null,
  })
  esperar('una respuesta sana pasa intacta', sana.complete, true)
  esperar('y no le toca los datos', [sana.repuesto, sana.modelo, sana.anio], ['filtro de aire', 'Tekken 250', 'no sabe'])
}

function main(): void {
  console.log('Verificando la recepción (no se manda ningún mensaje ni se consulta nada).')
  verificarSaludos()
  verificarNombre()
  verificarSanidad()
  verificarTextoAlCliente()
  verificarRescate()

  console.log('')
  if (fallos > 0) {
    console.log(`${fallos} comprobación(es) fallaron.`)
    process.exitCode = 1
    return
  }
  console.log('Todo bien: saludo, nombre, detección de basura, limpieza y rescate.')
}

main()
