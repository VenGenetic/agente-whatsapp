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
