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
import {
  canonicalDaytonaModel,
  cilindrajeSinModelo,
  enforceDaytonaIntake,
  isDaytonaBrand,
  soloCilindraje,
} from '../src/agent/daytonaModels.js'
import { campoContaminado, limpiarTextoParaElCliente, textoCorrupto } from '../src/gemini/sanidad.js'
import { nombreDePila } from '../src/agent/nombreDelCliente.js'
import { decidirAgente, preguntaDeRespaldoDeRecepcion } from '../src/agent/handleMessage.js'
import { esDesistimiento } from '../src/agent/cierreDeConversacion.js'
import type { Etapa } from '../src/db/etapas.js'

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

function verificarRouter(): void {
  console.log('\nQuién contesta: la decisión que puede mandarle un mensaje a un cliente')

  const soloRecepcion = { recepcion: true, ventas: false }
  const ambos = { recepcion: true, ventas: true }
  const ninguno = { recepcion: false, ventas: false }
  const soloVentas = { recepcion: false, ventas: true }

  // El punto de partida buscado: recepción automática + vendedor humano.
  esperar('chat nuevo, recepción elegida -> recepción', decidirAgente('new', soloRecepcion, 'intake'), 'intake')
  esperar('juntando datos -> recepción', decidirAgente('intake_in_progress', soloRecepcion, 'intake'), 'intake')
  esperar('esperando al cliente -> recepción', decidirAgente('waiting_customer_info', soloRecepcion, 'intake'), 'intake')

  // Lo más importante de todo: con la ficha lista y el vendedor apagado,
  // NO contesta nadie. Si acá saliera 'intake', la recepción volvería a
  // preguntar datos que el cliente ya dio.
  esperar('ficha lista con recepción -> nadie', decidirAgente('ready_for_sales', ambos, 'intake'), null)
  esperar('ficha lista con ventas -> ventas', decidirAgente('ready_for_sales', ambos, 'sales'), 'sales')
  esperar('cotizando con ventas -> ventas', decidirAgente('sales_in_progress', ambos, 'sales'), 'sales')

  // Una persona tomó el chat: no contesta nadie, aunque los dos agentes
  // estén encendidos. Es la regla 10.
  esperar('lo tomó un humano -> nadie', decidirAgente('human_assigned', ambos, 'sales'), null)
  esperar('conversación resuelta -> nadie', decidirAgente('resolved', ambos, 'sales'), null)

  // Con todo apagado no sale nada: ante la duda, silencio.
  esperar('todo apagado -> nadie', decidirAgente('new', ninguno, 'intake'), null)
  esperar('todo apagado, ficha lista -> nadie', decidirAgente('ready_for_sales', ninguno, 'sales'), null)

  // Modo "todo automático" de más adelante.
  esperar('ventas elegida, chat nuevo -> ventas', decidirAgente('new', soloVentas, 'sales'), 'sales')

  esperar('activado sin elegir agente -> nadie', decidirAgente('new', ambos, null), null)

  // Sin la migración 0035 la etapa viene en null: tiene que comportarse
  // como antes de que existieran las etapas.
  esperar('sin etapa, recepción elegida -> recepción', decidirAgente(null, soloRecepcion, 'intake'), 'intake')

  // Y que ninguna etapa quede sin decisión definida.
  const todas: Etapa[] = [
    'new', 'intake_in_progress', 'waiting_customer_info',
    'ready_for_sales', 'sales_in_progress', 'human_assigned', 'resolved',
  ]
  const decididas = todas.map((e) => decidirAgente(e, ambos, e.startsWith('sales') ? 'sales' : 'intake'))
  esperar('las 7 etapas tienen una decisión', decididas.length, 7)
  esperar(
    'y con todo encendido nunca contestan los dos',
    decididas.every((d) => d === 'intake' || d === 'sales' || d === null),
    true,
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

function verificarTextoRoto(): void {
  console.log('\nTexto roto a nivel de caracteres (no se puede reparar, hay que volver a pedirlo)')
  esperar(
    'el caso real: "¿Est! bien as!?"',
    textoCorrupto('Listo: filtro de aire para Wolf 200 del 2021. ¿Est! bien as!?'),
    true,
  )
  // Lo que el bot escribe todo el día NO puede dar falso positivo: si da,
  // cada mensaje se reintenta tres veces y termina en el fallback.
  const sanos = [
    '¡Listo! ¿De qué año es tu moto?',
    '¡Buenas tardes, Andrés! ¿Qué repuesto necesitas?',
    '¡Qué bueno tenerte de vuelta! ¿Qué buscas?',
    'Dale. ¿De qué lado es, izquierda o derecha?',
    '¡Perfecto!',
  ]
  for (const texto of sanos) esperar(`no marca: "${texto.slice(0, 34)}…"`, textoCorrupto(texto), false)
}

function verificarCierresYRespaldo(): void {
  console.log('\nDesistimiento y respaldo de recepción')
  const cierres = ['ya no deseo gracias', 'No lo necesito por ahora', 'ya conseguí el repuesto, gracias']
  for (const texto of cierres) esperar(`cierra: "${texto}"`, esDesistimiento(texto), true)

  const noCierres = ['no sé el año', 'no quiero el izquierdo, sino el derecho', 'gracias, ¿qué modelos tienen?']
  for (const texto of noCierres) esperar(`no cierra: "${texto}"`, esDesistimiento(texto), false)

  const base = {
    repuesto: null,
    marca: null,
    modelo: null,
    modeloDaytonaEquivalente: null,
    anio: null,
    color: null,
    posicion: null,
    cilindraje: null,
    observaciones: null,
    fotoRecibida: false,
  }
  esperar('sin pieza pregunta la pieza', preguntaDeRespaldoDeRecepcion(base), '¿Qué repuesto estás buscando?')
  esperar(
    'con pieza pero sin moto pregunta marca y modelo',
    preguntaDeRespaldoDeRecepcion({ ...base, repuesto: 'tanque' }),
    '¿Para qué marca y modelo de moto necesitas ese repuesto?',
  )
  esperar(
    'con modelo pero sin año pregunta el año',
    preguntaDeRespaldoDeRecepcion({ ...base, repuesto: 'tanque', marca: 'Daytona', modelo: 'Tekken Evo' }),
    '¿De qué año es tu Tekken Evo?',
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

function verificarModelosDaytona(): void {
  console.log('\nModelos Daytona conocidos y modelos nuevos declarados')
  esperar('normaliza Wing Evo 2', canonicalDaytonaModel('Daytona Wing Evo 2 200cc'), 'Wing Evo II')
  esperar('acepta GP-1 RR', canonicalDaytonaModel('GP1 RR'), 'GP-1 RR')
  esperar('corrige Tekken Evo mal escrito', canonicalDaytonaModel('Teken Evo'), 'Tekken Evo')
  esperar('corrige Dynamic Pro mal escrito', canonicalDaytonaModel('Dinamic Pro'), 'Dynamic Pro')
  esperar('Daytona mal escrito sigue siendo la marca', isDaytonaBrand('Daitona'), true)
  esperar('una marca distinta no se confunde con Daytona', isDaytonaBrand('Shineray'), false)
  esperar('Shark sin número queda ambiguo', canonicalDaytonaModel('Shark'), null)
  esperar('rechaza un modelo inexistente', canonicalDaytonaModel('Inventada 500'), null)
  const modeloNuevo = enforceDaytonaIntake({ marca: 'Daytona', modelo: 'Raptor X 250', repuesto: 'faro', complete: true },
    'busco faro para mi Daytona Raptor X 250')
  esperar('conserva un modelo nuevo declarado por el cliente', modeloNuevo.modelo, 'Raptor X 250')
  esperar('el modelo nuevo declarado puede completar la ficha', modeloNuevo.complete, true)
  const modeloInventado = enforceDaytonaIntake({ marca: 'Daytona', modelo: 'Raptor X', repuesto: 'faro', complete: true },
    'busco faro para mi Daytona')
  esperar('no conserva un modelo que el cliente no declaró', modeloInventado.modelo, null)
  esperar('un modelo no declarado mantiene la ficha abierta', modeloInventado.complete, false)
  const modeloAprendido = enforceDaytonaIntake({ marca: 'Daytona', modelo: 'Raptor X', complete: true },
    'busco faro para mi Raptor', { modeloDaytonaAprendido: true })
  esperar('conserva una variante aprendida y confirmada', modeloAprendido.modelo, 'Raptor X')
  const otraMarca = enforceDaytonaIntake({ marca: 'Shineray', modelo: 'XY 200', complete: true }, 'es Shineray')
  esperar('otra marca no completa la ficha', otraMarca.complete, false)
  esperar('otra marca conserva su modelo original', otraMarca.modelo, 'XY 200')
  esperar('otra marca pide una foto para comparar', /foto completa/i.test(otraMarca.next_question), true)
  const otraMarcaConFoto = enforceDaytonaIntake({ marca: 'Shineray', modelo: 'XY 200',
    modelo_daytona_equivalente: 'Tekken Evo', complete: true }, 'adjunto foto', { currentPhotoReceived: true })
  esperar('la foto permite guardar el equivalente Daytona', otraMarcaConFoto.modelo_daytona_equivalente, 'Tekken Evo')
  esperar('la equivalencia conserva la marca original', otraMarcaConFoto.marca, 'Shineray')
  const fotoAmbigua = enforceDaytonaIntake({ marca: 'Tuko', modelo: 'CR3 Max 200', complete: true },
    'adjunto foto', { currentPhotoReceived: true })
  esperar('una foto ambigua no inventa equivalencia', fotoAmbigua.complete, false)
  const noSabe = enforceDaytonaIntake({ marca: 'Daytona', modelo: null, complete: false }, 'no sé el modelo')
  esperar('si no sabe recibe opciones', /Wing Evo II/.test(noSabe.next_question), true)
  const razonada = enforceDaytonaIntake({ marca: 'Daytona', modelo: null, complete: false,
    next_question: 'Por la forma parece Tekken Evo o Tekken Discovery. ¿Cuál de esas dice en el emblema?' }, 'mandé la foto')
  esperar('conserva opciones razonadas desde una foto', /Tekken Discovery/.test(razonada.next_question), true)

  // El error caro de todos los días: el cliente cree que "Daytona 150"
  // identifica su moto. En esa cilindrada hay una docena de modelos con
  // piezas distintas -- si la ficha se cierra así, el vendedor cotiza a
  // ciegas.
  console.log('\nLa cilindrada sola no es un modelo')
  esperar('"Daytona 150" es cilindrada, no modelo', soloCilindraje('Daytona 150'), '150')
  esperar('"200 cc" también', soloCilindraje('200 cc'), '200')
  esperar('"Tekken 250" sí trae modelo', soloCilindraje('Tekken 250'), null)
  esperar('"Adventure 300R" es un modelo real', soloCilindraje('Adventure 300R'), null)
  esperar(
    'el mensaje entero sin modelo deja la cilindrada',
    cilindrajeSinModelo('hola, tengo una daytona 150, busco el tanque'),
    '150',
  )
  esperar(
    'si el mensaje nombra un modelo no es este caso',
    cilindrajeSinModelo('busco tanque para mi tekken evo 250'),
    null,
  )

  const soloCC = enforceDaytonaIntake({ marca: 'Daytona', modelo: 'Daytona 150', repuesto: 'tanque', complete: true },
    'necesito un tanque para mi daytona 150')
  esperar('no cierra la ficha con la cilindrada sola', soloCC.complete, false)
  esperar('y no guarda "Daytona 150" como modelo', soloCC.modelo, null)
  esperar('conserva la cilindrada que sí dio', soloCC.cilindraje, '150')
  esperar('pregunta el modelo exacto nombrando opciones', /150.*Wing Evo II/s.test(soloCC.next_question), true)
  esperar('y ofrece ayuda con una foto', /foto/i.test(soloCC.next_question), true)

  const ccEnElMensaje = enforceDaytonaIntake({ marca: 'Daytona', modelo: null, repuesto: 'espejos', complete: false },
    'busco espejos para una daytona 300')
  esperar('la cilindrada del mensaje también se rescata', ccEnElMensaje.cilindraje, '300')
  esperar('y se pregunta por el modelo de esa cilindrada', /Daytona 300/.test(ccEnElMensaje.next_question), true)
}

function main(): void {
  console.log('Verificando la recepción (no se manda ningún mensaje ni se consulta nada).')
  verificarSaludos()
  verificarRouter()
  verificarNombre()
  verificarSanidad()
  verificarTextoAlCliente()
  verificarTextoRoto()
  verificarCierresYRespaldo()
  verificarRescate()
  verificarModelosDaytona()

  console.log('')
  if (fallos > 0) {
    console.log(`${fallos} comprobación(es) fallaron.`)
    process.exitCode = 1
    return
  }
  console.log('Todo bien: saludo, router de agentes, nombre, detección de basura, limpieza y rescate.')
}

main()
