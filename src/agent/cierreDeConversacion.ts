/**
 * Señales inequívocas de que el cliente ya no quiere continuar con esta
 * consulta. Se resuelven antes de llamar al modelo para no insistir con
 * una foto o el modelo de la moto después de un "ya no deseo, gracias".
 *
 * La regla es deliberadamente conservadora: "no quiero el izquierdo, sino
 * el derecho" no es un desistimiento y debe seguir llegando al intérprete.
 */
export function esDesistimiento(texto: string | null | undefined): boolean {
  if (!texto) return false
  const limpio = texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!limpio) return false

  return [
    /\bya no (?:lo )?(?:necesito|quiero|deseo|me interesa)\b/,
    /\bno (?:lo )?(?:necesito|quiero|deseo|me interesa)(?:\s+(?:ya|gracias|por ahora|nada mas))?\s*$/,
    /\b(?:ya )?(?:lo )?consegui(?:\s+(?:ya|gracias))?\b/,
    /\bno mas\b/,
  ].some((pattern) => pattern.test(limpio))
}

export const RESPUESTA_DE_DESISTIMIENTO = 'De una, gracias por avisar. Si luego necesitas otro repuesto, aquí te ayudamos.'
