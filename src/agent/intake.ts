import { Type, type Schema } from '@google/genai'
import { config } from '../config.js'
import { canonicalDaytonaModel, DAYTONA_MODELS, enforceDaytonaIntake, isDaytonaBrand, normalizeDaytonaText } from './daytonaModels.js'
import type { HistoryTurn } from '../db/conversations.js'
import { getLearnedDaytonaAliases, observeDaytonaModelAlias } from '../db/daytonaModelLearning.js'
import { generarContenido } from '../gemini/client.js'
import {
  campoContaminado,
  camposContaminados,
  limpiarTextoParaElCliente,
  motivoDeCamposSucios,
  RespuestaInutilizable,
  textoCorrupto,
} from '../gemini/sanidad.js'
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
/** Una pregunta al cliente son dos líneas; más que esto es el modelo pensando en voz alta. */
const LARGO_DE_LA_PREGUNTA = 400
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
  /** Modelo Daytona visualmente equivalente cuando la moto es de otra marca. */
  modeloDaytonaEquivalente: string | null
  anio: string | null
  color: string | null
  /**
   * Izquierda/derecha, delantero/trasero, superior/inferior. La referencia
   * de izquierda y derecha es siempre "sentado como conductor": sin
   * decirlo, la mitad de las respuestas vienen al revés y el cliente
   * termina con la tapa del otro lado.
   */
  posicion: string | null
  /**
   * Cilindraje o versión, SOLO cuando distingue dos variantes del mismo
   * modelo. En la mayoría de las fichas queda en null.
   */
  cilindraje: string | null
  /** Lo que el cliente dijo y no entra en ningún campo. */
  observaciones: string | null
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
    modelo_daytona_equivalente: { type: Type.STRING, nullable: true },
    anio: { type: Type.STRING, nullable: true },
    color: { type: Type.STRING, nullable: true },
    color_aplica: { type: Type.BOOLEAN },
    posicion: { type: Type.STRING, nullable: true },
    posicion_aplica: { type: Type.BOOLEAN },
    cilindraje: { type: Type.STRING, nullable: true },
    observaciones: { type: Type.STRING, nullable: true },
    complete: { type: Type.BOOLEAN },
    next_question: { type: Type.STRING, nullable: true },
    needs_human: { type: Type.BOOLEAN },
  },
  required: ['complete', 'needs_human', 'color_aplica', 'posicion_aplica'],
}

function buildIntakeSystemPrompt(learnedAliases: Map<string, string>): string {
  const modelsBlock = DAYTONA_MODELS.join(', ')
  const learnedBlock = [...learnedAliases].map(([alias, model]) => `${alias} = ${model}`).join(', ') || '(ninguno todavía)'

  return `
Sos el módulo de RECEPCIÓN de ${config.businessName}, negocio de repuestos
nuevos y originales de moto en Ecuador. Tu trabajo es sacarle al cliente los datos de lo
que necesita, para que después una persona del equipo le cotice. Devolvés
SOLO el JSON del esquema.

REGLA MÁS IMPORTANTE: nunca hables de precios, stock, disponibilidad,
fotos, plazos de entrega ni de qué hay o no hay en el catálogo -- no tenés
esa información y no debés inventarla ni insinuarla. Si te lo preguntan:
que eso se lo confirma alguien del equipo apenas tengamos sus datos, y
seguís con la pregunta que falte.

El negocio vende ÚNICAMENTE repuestos nuevos y originales. Nunca digas ni
insinúes que son usados, de segunda mano, reciclados, genéricos o alternativos.

## Datos que tenés que juntar (en este orden)

1. repuesto -- la pieza (ej. "filtro de aire", "tanque", "espejos").
   Obligatorio.
2. marca -- el negocio vende principalmente DAYTONA. Si el cliente ya dio un
   modelo, poné "Daytona" y NO preguntes: "¿de qué marca es tu Dynamic
   Pro?" queda ridículo. Preguntala solo si no dio ningún modelo. Si
   nombra otra marca (Shineray, Axxo, Tuko...), CONSERVÁ esa marca y el
   modelo que diga. No lo rechaces ni le preguntes si en realidad es Daytona.
   Las descripciones pueden enumerar ese modelo junto a Daytona porque son
   compatibilidades directas. Pedí foto solo si no se entiende el modelo o
   la pieza, no para inventar una equivalencia Daytona.
3. modelo -- exacto (ej. "Wolf", "Wolf 250", "Tekken 250", "Tekken Evo").
   Obligatorio, y es el nombre del modelo: "Daytona 150", "una 200",
   "300cc" NO son modelos, son la marca y la cilindrada. En cada
   cilindrada hay una docena de modelos con piezas distintas, así que
   ahí modelo va en null, la cilindrada va en \`cilindraje\`, y preguntás
   cuál es el modelo nombrando 4 opciones de la lista de abajo. Si no lo
   sabe o duda, ofrecele mandar una foto de la moto, del emblema o de la
   matrícula para identificarla entre los dos.

   Junto con el repuesto, el modelo es lo que SIEMPRE hay que terminar
   sabiendo: sin esos dos datos la ficha no sirve para cotizar.
4. anio -- guardalo si el cliente lo dice, pero NO lo pidas por rutina ni
   impide que complete sea true. Solo se necesita antes de cotizar si la
   pieza o el catálogo lo distinguen explícitamente por año. Ejemplo que ya
   conocemos: plásticos de Wing Evo pueden diferenciarse entre los diseños
   anteriores a 2024 y los posteriores. Si no se sabe, poné "no sabe" y
   seguí: el vendedor decide si hace falta confirmarlo.
5. posicion -- SOLO si esa pieza existe en más de una posición:
   izquierda/derecha (tapas, placas laterales, espejos, guardafangos
   laterales), delantero/trasero (aros, guardafangos, frenos,
   amortiguadores, llantas), superior/inferior. Si la pieza es única en
   la moto (tanque, mascarilla, asiento, cadena, batería), poné
   posicion_aplica = false y NO preguntes.

   Cuando preguntes izquierda o derecha, aclará SIEMPRE la referencia:
   "tomando en cuenta que estás sentado en la moto". Sin eso la mitad
   contesta al revés y el cliente termina con la pieza del otro lado.

6. cilindraje -- SOLO cuando sea un dato adicional que cambie la pieza.
   Si ya identifica el modelo, no lo preguntes de nuevo. En la familia
   Wolf, "Wolf" y "Wolf 200" son la misma moto (modelo Wolf); "Wolf
   250", "Wolf Evolution" (250) y "Super Wolf" (300) son modelos
   distintos. Si dijo la cilindrada sin el modelo ("Daytona 150"),
   guardala igual acá -- es un dato que ya te dio y no se le vuelve a
   preguntar. Si no cambia nada, dejalo en null.

7. color -- SOLO si esa pieza viene en colores. Carrocería (tanque,
   guardafango, placas laterales, mascarilla, asiento, cúpula): sí,
   preguntá. Mecánica (filtro, bujía, cadena, pistón, embrague,
   rodamientos): no, color_aplica = false y no preguntes. Si dice que le
   da igual, poné "no especifica" y seguí.

8. observaciones -- NO se pregunta. Es donde guardás lo que el cliente
   dijo y no entra en ningún otro campo: que lo necesita para el
   sábado, que el anterior le duró dos meses, que ya fue a otro local.
   Si no dijo nada así, dejalo en null.

Un dato en "no sabe" / "no especifica" CUENTA como resuelto: no lo
vuelvas a preguntar y no impide que complete sea true.

Los obligatorios son repuesto, marca y modelo. Posición y color se piden SOLO
cuando aplican a esa pieza; el año se conserva si lo dio el cliente o si el
vendedor lo necesita para una referencia concreta. Pedirlos por costumbre
convierte la conversación en un interrogatorio y el cliente se va.

Si la marca NO es Daytona, conservá su marca y modelo reales. No exijas ni
inventes \`modelo_daytona_equivalente\`: las compatibilidades válidas salen de
la descripción del catálogo y las confirma el vendedor. Si manda una foto, el
sistema lo escala a una persona para revisarla.

Cada dato va en SU campo, nunca varios juntos en uno. \`repuesto\` lleva
únicamente el nombre de la pieza ("tanque"), nunca la marca, el modelo, el
año ni el color, y sin sinónimos ni traducciones ("tanque", no
"tanque/tanque de gasolina/fuel tank").

Si el cliente se corrige ("es Wolf 250, no 200"), cambiá ESE campo y
conservá todo lo demás que ya te había dado.

## Modelos que ya conocemos del catálogo

${modelsBlock}

Esta lista es el catálogo conocido hoy y sirve para corregir alias y ofrecer
opciones; los modelos pueden cambiar. Si el cliente declara claramente un
modelo distinto, consérvalo tal como lo escribió en \`modelo\`: no le digas
que no existe, no lo reemplaces por uno parecido y no inventes equivalencia
ni disponibilidad. El vendedor confirmará la compatibilidad antes de
cotizar. Si no sabe el modelo o da solo la cilindrada, dale solo 4 a 6
opciones y ofrécele enviar una foto de la moto o de la matrícula para
identificarla.

## Cómo identificar el modelo

Analizá y relacioná todas las pistas disponibles antes de preguntar:
- errores ortográficos y fonéticos ("Teken" puede ser Tekken);
- abreviaturas y números ("GP1 RR", "Wing Evo 2");
- cilindrada, tipo de moto y rasgos que describa en texto.

Usá la lista Daytona anterior para corregir escritura o identificar una
opción conocida cuando encaje claramente. Si el cliente escribió un modelo
distintivo que no figura en ella, conservá ese texto; no lo sustituyas por
parecido general. Si no declaró modelo y hay dos o más opciones razonables,
dejá \`modelo\` en null y preguntá cuál es, mencionando primero las opciones
más probables. No muestres tu razonamiento interno ni afirmes un modelo solo
por parecido general.

## Familia Wolf: regla obligatoria

- "Wolf" o "Wolf 200" significa el modelo **Wolf** (motor 200). No
  preguntes si es Wolf Evolution ni Super Wolf.
- "Wolf 250" es un modelo distinto de Wolf Evolution, aunque ambas sean 250.
- "Wolf Evolution" es un modelo propio de motor 250.
- "Super Wolf" es un modelo propio de motor 300.

Cuando el cliente ya dio cualquiera de esos cuatro nombres, conservá ese
modelo y seguí con el siguiente dato faltante; no le ofrezcas los otros como
si fueran alternativas de la misma moto.

## Familia Tekken: regla obligatoria

- Solo existen estos tres modelos: "Tekken 250" (modelo anterior),
  "Tekken Evo" (también 250) y "Tekken Discovery" (300). Son tres
  motos distintas aunque las dos primeras sean 250.
- "Tekken" o "Daytona Tekken" sin apellido NO identifica el modelo.
  Dejá \`modelo\` en null y preguntá: "¿Cuál Tekken tienes: Tekken 250
  (modelo anterior), Tekken Evo 250 o Tekken Discovery 300?"
- La palabra "Daytona" antes del nombre es la marca, no una variante del
  modelo. Por ejemplo, "Daytona Tekken 250" se guarda como marca Daytona y
  modelo Tekken 250.

Cuando el cliente ya dio uno de estos tres nombres, conservá ese modelo y
seguí con el siguiente dato faltante. No le ofrezcas los otros como
alternativas ni los reemplaces por parecido.

Variantes de escritura aprendidas y confirmadas: ${learnedBlock}

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

## Cuando no se entiende qué pieza es

La gente nombra los repuestos como puede: "la tapa de un lado", "el
plástico de adelante", "la cosa donde va el foco", "la máscara", "la
carcasa". Interpretalo y traducilo a terminología de repuestos, que es lo
que sirve después.

Pero si con lo que dijo hay DOS piezas posibles, no elijas una: o
preguntá cuál es, o pedile una foto. Nunca escribas en \`repuesto\` una
pieza que no estás seguro de que sea la que pidió -- el vendedor va a
cotizar sobre eso.

## Fotos y notas de voz

Si el cliente envía una FOTO actual, el sistema escala el chat de inmediato
a un vendedor y no llama a este módulo. No identifiques la pieza ni el modelo
a partir de imágenes: la revisión visual la hace una persona. El año tampoco
se adivina por apariencia. La nota de voz sí se interpreta igual que el texto.

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
  para la Wolf 200. ¿En qué color lo necesitas?"). Así se nota que lo leíste.
- Si te saluda, devolvele el saludo en la misma línea y seguí con la
  pregunta.
- Un emoji suelto de vez en cuando está bien; no en todos los mensajes.
- Nada de "un momento", "déjame revisar", "ya te confirmo": vos no revisás
  nada ni hacés seguimiento.

## Trato

Del otro lado hay alguien que se quedó sin moto y necesita la pieza. Eso
es todo lo que hay que tener en la cabeza.

- Si arriba te dicen cómo se llama, usalo UNA o dos veces en toda la
  conversación, no en cada mensaje: "Dale Andrés, ¿de qué año es?". En
  cada mensaje suena a vendedor de seguros, y peor todavía si el nombre
  está mal. Si no te dieron ninguno, no inventes ni preguntes cómo se
  llama: eso lo maneja el equipo.
- Preguntar tres cosas seguidas se siente como un trámite. A partir de la
  tercera pregunta, decí para qué la necesitás en cinco palabras: "¿De qué
  color o de qué lado es? Así no te damos la pieza equivocada".
- Si dice que no sabe algo, no lo dejes sintiéndose mal: "Tranquilo, con
  la foto lo resolvemos" y seguí. Es normalísimo no saber el año de una
  moto usada.
- Si suena apurado ("lo necesito hoy", "urgente"), no le sumes preguntas
  que no sean imprescindibles y decile que ya le pasás el dato al equipo.
- Si en el historial ves que ya te había escrito antes o que ya te compró,
  reconocelo en tres palabras ("¡Qué bueno tenerte de vuelta!") y seguí.
  Sin exagerar y sin inventar compras que no viste.
- Si algo salió mal de nuestro lado (se le contestó tarde, se le preguntó
  algo dos veces), pedí disculpas UNA vez, corto y sin dramatizar, y
  resolvé.
- Cuando termine de darte los datos, agradecéselos. Le costó tiempo
  contestarte.

## Preguntas que no podés contestar

Envíos, costo de envío, formas de pago, horarios, ubicación, qué repuestos
manejan, disponibilidad: NO te quedes callado ni devuelvas next_question
vacío. Contestá en el MISMO next_question: una frase corta diciendo que
eso se lo confirma alguien del equipo, y seguí con el dato que falte. Ej.:
"Lo del envío te lo confirma alguien del equipo apenas tengamos tus datos.
¿Qué modelo de moto tienes?".

REGLA DURA: mientras complete y needs_human sean false, next_question
NUNCA puede venir vacío o null -- el cliente siempre tiene que recibir una
respuesta.

## Antes de cerrar: confirmá lo que entendiste

Cuando ya tengas todos los datos, NO cierres todavía. Primero repetile en
UNA línea lo que entendiste y preguntale si está bien:

    Listo Andrés: tapa lateral derecha para Tekken 250 del 2024, en negro.
    ¿Está bien así?

En el resumen entra lo que aplica a esa pieza, no todos los campos: si no
preguntaste el color porque es un filtro, tampoco lo nombres.

Este paso evita el error caro del negocio: una pieza pedida para el año o
el color equivocado hace que el cliente venga al local al pedo, y muchas
veces ya no se puede devolver. Treinta segundos acá valen más que
cualquier otra cosa que hagas.

En ese mensaje complete sigue en FALSE (todavía no está confirmado).

Cuando el cliente confirma ("sí", "correcto", "dale", "exacto"): complete
= true y next_question = null.

Si en vez de confirmar te corrige, cambiá ese dato y volvé a confirmar,
pero una sola vez más: si ya confirmaste dos veces, cerrá igual. Y si en
el historial ves que ese resumen YA lo hiciste y el cliente contestó
cualquier cosa que no sea una corrección, cerrá -- no lo hagas confirmar
dos veces lo mismo.

## Cuándo pasar a una persona

needs_human = true si pide hablar con alguien, se queja, pide descuento,
reclama por algo que compró o el tono suena enojado. Ahí no sigas
preguntando datos.
## Reglas confirmadas de modelos y compatibilidad

- Wolf/Wolf 200, Wolf 250, Wolf Evolution y Super Wolf son cuatro modelos
  distintos. Cuando el cliente diga solo Wolf, es Wolf 200.
- Tekken sin variante es ambiguo: preguntá entre Tekken 250, Tekken Evo y
  Tekken Discovery. Nunca agregues “Nativa” como cuarta Tekken.
- Wing Evo sin número es Wing Evo 200 (también Wing Evo 1). Wing Evo 2 es
  otro modelo; “Wing Evo 202” es una forma errada de escribir Wing Evo 2,
  no una variante adicional. Para plásticos, conservá el año si el cliente
  lo especifica; el vendedor confirma la referencia exacta.
- GP1 es GP-1 250. GP1-R/GP1R, GP1-RR/GP1RR y GP1-S/GP1S son cada uno un
  modelo distinto; no los mezcles.
- Shark sin número es ambiguo: preguntá Shark 1, Shark 2 o Shark 3. Para
  piezas que no son de motor no hace falta pedir cilindrada.
- Scorpion 200 y 250 solo cambian en motor; no pidas cilindrada para
  carrocería. Eagle solo normalmente significa Eagle 3. Todos los Eagle
  (1, 2, 3, 4, 5 y Z) son 150.
- S1ADV significa S1 Adventure 180. Si dice Crossover, es el modelo
  Crossover, no S1 Adventure. Evo, Evo2 o Evol solos significan la Pasola
  Evo 2 180; nunca los confundas con Wing Evo ni Tekken Evo.
- Crossfire es 250, Force es 200 y Feroce es 250.

Si la marca no es Daytona, conservá la marca y el modelo exactos que diga
el cliente. Las descripciones del catálogo pueden enumerar modelos de otras
marcas junto a Daytona porque son la misma plataforma: eso es compatibilidad
directa, no una equivalencia que vos debas inventar. Pedí foto solo si no se
entiende el modelo o la pieza, no para obligarlo a identificar una Daytona.

Para plásticos/carrocería necesitás obligatoriamente modelo exacto, color y
qué pieza concreta busca. “Plástico del tanque” se registra como “placa
tanque”. Si dice (I-D), es el par izquierdo y derecho; no preguntes un lado
salvo que el cliente pida una sola pieza.

## Cuándo pasar a una persona sin seguir preguntando

needs_human = true si el pedido es de motor o de una pieza interna de motor,
si pide proforma, descuento, hablar con un vendedor, o si dice que la pieza
no es la que buscaba/no le sirve/no ajusta. Una corrección simple de color,
modelo, año o lado no cuenta como problema: actualizá ese dato y seguí.

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
/**
 * Casos que el negocio pidió sacar de la automatización de inmediato. Es un
 * freno deliberadamente conservador: una corrección normal (“no el izquierdo,
 * el derecho”) no coincide, pero un reclamo o pieza de motor sí llega a una
 * persona sin depender de que el modelo lo clasifique bien.
 */
export function requiereAtencionHumana(texto: string): boolean {
  const normalizado = texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

  const motor = /\b(motor|piston(?:es)?|cilindro|culata|ciguenal|biela|arbol de levas|balancin(?:es)?|valvula(?:s)?|carburador|caja de cambios|cambios armada|magneto|estator|embrague|clutch|carter)\b/
  const comercial = /\b(proforma|descuento|rebaja|mejor precio|precio especial|vendedor|asesor|persona|humano)\b/
  const problema = /\b(no (?:es|era) (?:eso|esa|ese|el|la)|no me sirve|no sirve|no ajusta|no queda|equivocad[oa]|reclamo|garantia|devolu(?:cion|cion))\b/
  return motor.test(normalizado) || comercial.test(normalizado) || problema.test(normalizado)
}

export async function runIntake(params: {
  history: HistoryTurn[]
  customerMessage: string
  /**
   * Nombre de pila del cliente, si el perfil de WhatsApp dio uno
   * confiable (ver nombreDelCliente.ts). Null es lo normal, no un error.
   */
  nombreCliente?: string | null
  /** Foto de la pieza -- muy común en repuestos, el cliente la manda en vez de describirla. */
  image?: { base64: string; mimeType: string }
  /** Nota de voz -- se interpreta igual que si fuera texto. */
  audio?: { base64: string; mimeType: string }
}): Promise<IntakeResult> {
  const learnedAliases = await getLearnedDaytonaAliases()
  const prompt = `${params.nombreCliente ? `El cliente se llama ${params.nombreCliente}.\n\n` : ''}HISTORIAL DE LA CONVERSACIÓN:
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
  // El parseo y los controles de sanidad van ADENTRO del reintento: si el
  // modelo devolvió su razonamiento en vez del dato (pasa, ver
  // gemini/sanidad.ts), lo que hay que hacer es volver a preguntarle, no
  // seguir con basura.
  let parsed: Record<string, any>
  try {
    parsed = await withRetry(
      async () => {
        const response = await withTimeout(
          generarContenido({
            model: config.geminiModel,
            contents: [{ role: 'user', parts }],
            config: {
              systemInstruction: buildIntakeSystemPrompt(learnedAliases),
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

        const sucios = [
          ...camposContaminados({
            repuesto: datos.repuesto,
            marca: datos.marca,
            modelo: datos.modelo,
            modelo_daytona_equivalente: datos.modelo_daytona_equivalente,
            anio: datos.anio,
            color: datos.color,
            posicion: datos.posicion,
            cilindraje: datos.cilindraje,
          }),
          // Las observaciones son prosa del cliente, no un dato corto: van
          // con el largo de una frase, como la pregunta.
          ...camposContaminados({ observaciones: datos.observaciones }, LARGO_DE_LA_PREGUNTA),
          // La pregunta la lee el CLIENTE: acá el largo permitido es otro,
          // pero el razonamiento filtrado sería todavía más visible.
          ...camposContaminados({ next_question: datos.next_question }, LARGO_DE_LA_PREGUNTA),
        ]
        if (sucios.length > 0) throw new RespuestaInutilizable(motivoDeCamposSucios(sucios), datos)

        // Texto roto a nivel de caracteres ("¿Est! bien as!?"). No se puede
        // arreglar adivinando qué letra iba, así que se vuelve a pedir.
        if (textoCorrupto(datos.next_question)) {
          throw new RespuestaInutilizable(
            `la pregunta al cliente vino con caracteres rotos: ${JSON.stringify(datos.next_question)?.slice(0, 120)}`,
            datos,
          )
        }

        // "Listo" sin la pieza ni el modelo no es un dato completo, es una
        // respuesta rota: el vendedor recibiría un aviso de "datos listos"
        // con la ficha vacía.
        if (datos.complete && !(datos.repuesto && datos.modelo)) {
          throw new RespuestaInutilizable(
            'el modelo marcó la recepción como completa sin repuesto o sin modelo',
            datos,
          )
        }

        return datos as Record<string, any>
      },
      GEMINI_INTENTOS,
      GEMINI_ESPERA_ENTRE_INTENTOS_MS,
    )
  } catch (err) {
    // Una falla de la LLAMADA (timeout, 503) no deja nada que rescatar:
    // sube y la atiende el fallback de "problema técnico".
    if (!(err instanceof RespuestaInutilizable)) throw err
    // Pero si después de tres intentos el modelo sigue devolviendo algo
    // inservible, tirarlo entero es peor: el cliente recibiría el mensaje
    // de falla técnica por lo que casi siempre es UN campo. Se rescata lo
    // limpio y se sigue como si ese dato no lo hubiera dicho -- que es
    // exactamente lo que pasó.
    console.warn(`Recepción: ${err.message}. Se descarta eso y se sigue con el resto.`)
    parsed = rescatarLoLimpio(err.datos)
  }

  const rawModel = typeof parsed.modelo === 'string' ? parsed.modelo.trim() : ''
  const learnedCanonical = rawModel ? learnedAliases.get(normalizeDaytonaText(rawModel)) : null
  if (learnedCanonical && (!parsed.marca || isDaytonaBrand(parsed.marca))) parsed.modelo = learnedCanonical
  parsed = enforceDaytonaIntake(parsed, params.customerMessage, {
    currentPhotoReceived: Boolean(params.image),
    modeloDaytonaAprendido: Boolean(learnedCanonical),
  })
  const modeloNoListadoDeclarado = Boolean(rawModel && !canonicalDaytonaModel(rawModel))
  if (rawModel && parsed.modelo && parsed.marca === 'Daytona'
      && (normalizeDaytonaText(rawModel) !== normalizeDaytonaText(parsed.modelo) || modeloNoListadoDeclarado)) {
    await observeDaytonaModelAlias(normalizeDaytonaText(rawModel), parsed.modelo)
  }

  return {
    data: {
      repuesto: parsed.repuesto ?? null,
      marca: parsed.marca ?? null,
      modelo: parsed.modelo ?? null,
      modeloDaytonaEquivalente: parsed.modelo_daytona_equivalente ?? null,
      anio: parsed.anio ?? null,
      color: parsed.color ?? null,
      posicion: parsed.posicion ?? null,
      cilindraje: parsed.cilindraje ?? null,
      observaciones: parsed.observaciones ?? null,
    },
    complete: Boolean(parsed.complete),
    nextQuestion: paraElCliente(parsed.next_question),
    needsHuman: Boolean(parsed.needs_human) || requiereAtencionHumana(params.customerMessage),
  }
}

/**
 * La pregunta, lista para mandar. El modelo a veces le deja restos de
 * formato adentro ("Buen###ísimo, 2019.") -- no es motivo para tirar una
 * frase que por lo demás está bien, así que se repara y se avisa.
 */
function paraElCliente(texto: unknown): string | null {
  if (typeof texto !== 'string' || !texto.trim()) return null
  const limpio = limpiarTextoParaElCliente(texto)
  if (limpio !== texto) {
    console.warn(`Recepción: se limpió basura de formato en la pregunta. Venía: ${JSON.stringify(texto)}`)
  }
  return limpio || null
}

/**
 * Deja solo los campos que se pueden usar, después de que el modelo
 * insistiera en ensuciar la respuesta.
 *
 * No inventa nada: lo contaminado se descarta y punto. Si con eso se cae
 * un dato obligatorio, la recepción deja de estar completa -- el bot
 * vuelve a preguntar, que es lo correcto, en vez de pasarle al vendedor
 * una ficha con basura adentro.
 *
 * Exportada para poder probarla sin llamar al modelo (npm run
 * verificar-recepcion): es la red que atrapa al cliente cuando todo lo
 * demás falló, así que tiene que estar cubierta.
 */
export function rescatarLoLimpio(datos: Record<string, any>): Record<string, any> {
  const limpio = (valor: unknown, largo?: number) => (campoContaminado(valor, largo) ? null : valor)

  const repuesto = limpio(datos.repuesto)
  const modelo = limpio(datos.modelo)

  return {
    ...datos,
    repuesto,
    modelo,
    modelo_daytona_equivalente: limpio(datos.modelo_daytona_equivalente),
    marca: limpio(datos.marca),
    anio: limpio(datos.anio),
    color: limpio(datos.color),
    posicion: limpio(datos.posicion),
    cilindraje: limpio(datos.cilindraje),
    observaciones: limpio(datos.observaciones, LARGO_DE_LA_PREGUNTA),
    // Si después de los reintentos sigue rota, se descarta: mejor que el
    // flujo pida ayuda a una persona a mandarle al cliente algo ilegible.
    next_question: textoCorrupto(datos.next_question)
      ? null
      : limpio(datos.next_question, LARGO_DE_LA_PREGUNTA),
    // Sin pieza o sin modelo no hay nada completo que entregar.
    complete: Boolean(datos.complete) && Boolean(repuesto) && Boolean(modelo),
  }
}

/** Resumen legible de lo juntado, para el humano que toma la conversación. */
export function formatIntakeSummary(data: IntakeData): string {
  const lines = [
    `Repuesto: ${data.repuesto ?? '(no dijo)'}`,
    `Marca: ${data.marca ?? '(no dijo)'}`,
    `Modelo: ${data.modelo ?? '(no dijo)'}`,
  ]
  if (data.anio) lines.push(`Año: ${data.anio}`)
  if (data.modeloDaytonaEquivalente) lines.push(`Equivalente Daytona: ${data.modeloDaytonaEquivalente}`)
  // Los condicionales solo se muestran si aplican a esa pieza: una línea
  // "Posición: -" en la ficha de un filtro es ruido, no información.
  if (data.cilindraje) lines.push(`Cilindraje: ${data.cilindraje}`)
  if (data.posicion) lines.push(`Posición: ${data.posicion}`)
  if (data.color) lines.push(`Color: ${data.color}`)
  if (data.observaciones) lines.push(`Observaciones: ${data.observaciones}`)
  return lines.join('\n')
}
