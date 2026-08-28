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

/**
 * Lanza si alguno de los campos vino contaminado. Va DENTRO del reintento:
 * la idea es pedirle de nuevo al modelo, no seguir con datos inventados.
 */
export function exigirCamposLimpios(campos: Record<string, unknown>, largoMaximo?: number): void {
  for (const [nombre, valor] of Object.entries(campos)) {
    if (campoContaminado(valor, largoMaximo)) {
      throw new Error(
        `El modelo devolvió su razonamiento en el campo "${nombre}" en vez del dato: ${JSON.stringify(valor)?.slice(0, 200)}`,
      )
    }
  }
}
