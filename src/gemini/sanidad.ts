/**
 * Defensa contra una falla REAL y medida del modelo: de vez en cuando
 * vuelca su propio razonamiento adentro de los campos del JSON, en vez de
 * devolver el dato.
 *
 * Ejemplos textuales de pruebas contra gemini-3.6-flash con el prompt de
 * recepción, todos en el campo `repuesto`:
 *
 *     "tanquePool/tank/tanque"
 *     "tanque Henrique? No, standard tanque. Wait, let's keep it strictly
 *      'tanque' as specified in repuesto definition. repuesto: tanque,
 *      marca: Daytona, ..."
 *
 * No es constante -- la misma consulta sale bien la mayoría de las veces --
 * así que reintentar alcanza. Lo que NO se puede hacer es guardarlo: ese
 * texto termina en el resumen que lee el vendedor y en la búsqueda de
 * catálogo, y ahí ya no hay forma de darse cuenta de que era basura.
 *
 * El esquema de respuesta no protege de esto: el JSON es válido, el tipo
 * es el correcto (string), y la API no tiene forma de saber que el
 * contenido es el borrador del modelo.
 */

/**
 * Un dato de este dominio es corto: "guardafango delantero izquierdo" son
 * 31 caracteres. Pasado este largo no es un repuesto ni un modelo, es
 * texto de más. Se bajó a 45 después de ver pasar por 60 el valor
 * "mascarilla light/frontal/mascarilla (según foto anterior)".
 */
const LARGO_MAXIMO_DE_DATO = 45

/** Palabras que aparecen cuando el modelo está pensando, no contestando. */
const RASTROS_DE_RAZONAMIENTO =
  /\b(wait|let's|let us|the user|we should|i should|hmm|standard|strictly|next_question|repuesto:|marca:|modelo:|json)\b/i

/** true si el valor no parece un dato sino el borrador del modelo. */
export function campoContaminado(valor: unknown, largoMaximo = LARGO_MAXIMO_DE_DATO): boolean {
  if (typeof valor !== 'string') return false
  const texto = valor.trim()
  if (!texto) return false
  if (texto.length > largoMaximo) return true
  // La lista de sinónimos separados por barra es el otro artefacto
  // recurrente ("tanquePool/tank/tanque"). Solo se mira en los campos de
  // dato: en una pregunta al cliente una barra puede ser legítima.
  if (largoMaximo <= LARGO_MAXIMO_DE_DATO && (texto.match(/\//g) ?? []).length >= 2) return true
  return RASTROS_DE_RAZONAMIENTO.test(texto)
}

/** Qué campos de este lote vinieron contaminados. Vacío = está limpio. */
export function camposContaminados(campos: Record<string, unknown>, largoMaximo?: number): string[] {
  return Object.entries(campos)
    .filter(([, valor]) => campoContaminado(valor, largoMaximo))
    .map(([nombre]) => nombre)
}

/**
 * El modelo contestó, pero la respuesta no se puede usar tal cual: trae su
 * razonamiento adentro de un campo, o se contradice a sí misma (dice que
 * ya tiene todos los datos y no mandó ninguno).
 *
 * Es un error aparte y no un Error suelto porque quien llama necesita
 * distinguirlo. Un timeout o un 503 son fallas de la LLAMADA y no dejan
 * nada que rescatar; acá sí hay una respuesta, solo que con partes
 * inservibles. Agotados los reintentos, quedarse con lo limpio es mejor
 * que dejar al cliente sin ninguna respuesta.
 */
export class RespuestaInutilizable extends Error {
  constructor(
    motivo: string,
    /** La respuesta cruda, para poder rescatar lo que sí sirve. */
    readonly datos: Record<string, unknown>,
  ) {
    super(motivo)
    this.name = 'RespuestaInutilizable'
  }
}

/** El motivo, redactado igual siempre, para que el log se pueda buscar. */
export function motivoDeCamposSucios(campos: string[]): string {
  return `el modelo devolvió su razonamiento en vez del dato, en: ${campos.join(', ')}`
}

/*
 * A propósito NO hay un `exigirCamposLimpios(campos)` de conveniencia.
 * Se probó y era una trampa: lanzaba llevando como `datos` el puñado de
 * campos que estaba mirando, así que el rescate de quien lo atrapaba se
 * quedaba sin el resto de la respuesta y la vaciaba. Quien detecta tiene
 * que armar el error con la respuesta ENTERA -- por eso se exporta
 * `camposContaminados` y no un atajo que lance solo.
 */

/**
 * Restos de formato que el modelo mete a veces en el texto que va PARA EL
 * CLIENTE. Visto en pruebas: "Buen###ísimo, 2019. "?"¿En qué color
 * necesitas el tanque?" -- la pregunta es correcta, solo que con basura
 * incrustada.
 *
 * Acá no sirve el criterio de los campos de dato (descartar y volver a
 * preguntar): la frase está bien, es legible y hace avanzar la
 * conversación. Tirarla obligaría a otro viaje al modelo, y si el
 * problema persiste el cliente terminaría recibiendo el mensaje de falla
 * técnica por unos numerales de más. Se repara y se sigue.
 *
 * Ninguno de estos caracteres aparece en un mensaje real de WhatsApp de
 * este negocio; los asteriscos de negrita tampoco, porque el bot escribe
 * en texto plano a propósito.
 */
const BASURA_DE_FORMATO = /[#*~|=_`<>{}\\]+/g

/** Un signo suelto entre comillas ("?"), el otro resto que se vio. */
const SIGNO_ENTRECOMILLADO = /"([?!.,;:¿¡]+)"/g

/**
 * Deja el texto como para mandárselo a una persona. Devuelve el mismo
 * string si no había nada que limpiar, así quien llama puede avisar solo
 * cuando de verdad hubo que tocarlo.
 */
export function limpiarTextoParaElCliente(texto: string): string {
  const limpio = texto
    .replace(BASURA_DE_FORMATO, '')
    .replace(SIGNO_ENTRECOMILLADO, '')
    // Espacio que quedó colgando antes de un signo, y espacios dobles.
    .replace(/ +([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  return limpio === texto ? texto : limpio
}

/**
 * Texto ROTO a nivel de caracteres, distinto de la basura de formato.
 *
 * Visto en pruebas: el modelo devolvió "¿Est! bien as!?" en vez de "¿Está
 * bien así?" -- reemplazó las vocales acentuadas por signos de admiración.
 *
 * Acá no se puede reparar como con los numerales: adivinar qué letra iba
 * es inventar. Lo que corresponde es volver a pedirlo, que es lo que hace
 * quien llama al detectar esto.
 *
 * La regla es angosta a propósito -- un signo de admiración pegado a una
 * letra por izquierda Y a una letra o signo por derecha. Así "¡Listo!" y
 * "¡Buenas tardes!" pasan sin problema, que es lo que el bot escribe todo
 * el día.
 */
const ADMIRACION_EN_MEDIO = /[a-záéíóúüñ]![?¿a-záéíóúüñ]/i

export function textoCorrupto(valor: unknown): boolean {
  if (typeof valor !== 'string') return false
  return ADMIRACION_EN_MEDIO.test(valor)
}
