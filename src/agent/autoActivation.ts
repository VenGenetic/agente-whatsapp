/**
 * Mensaje prellenado que llega desde anuncios o botones de mÃ¡s informaciÃ³n.
 * Tolera mayÃºsculas, tildes, puntuaciÃ³n y espacios, pero no texto adicional.
 */
export function isAutoActivationMessage(value: string | null): boolean {
  if (!value) return false
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
  return normalized === 'hola quiero mas informacion'
}
