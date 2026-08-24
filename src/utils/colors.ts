/**
 * En este catálogo, el color suele ser parte del PRODUCTO, no un atributo
 * elegible aparte -- "TANQUE GASOLINA DELTA...NEGRO" y "...BLANCO" son filas
 * distintas. Si el cliente no especifica color y hay variantes, hay que
 * preguntar antes de registrar una demanda o confirmar stock -- si no, se le
 * puede avisar por el color equivocado cuando llegue el repuesto.
 */
export const COLOR_WORDS = [
  'NEGRO', 'NEGRA', 'BLANCO', 'BLANCA', 'ROJO', 'ROJA', 'AZUL', 'VERDE',
  'AMARILLO', 'AMARILLA', 'NARANJA', 'GRIS', 'DORADO', 'DORADA', 'PLATA',
  'PLATEADO', 'PLATEADA', 'PLOMO', 'CAFE', 'CAFÉ', 'MORADO', 'MORADA',
  'ROSADO', 'ROSADA', 'CELESTE', 'BEIGE', 'VINOTINTO', 'FUCSIA', 'TURQUESA',
  'CROMADO', 'CROMADA', 'TITANIO',
]

function colorPattern(): RegExp {
  // Instancia nueva cada vez -- un regex global reusado arrastra lastIndex
  // entre llamadas y da falsos negativos intermitentes.
  return new RegExp(`\\b(${COLOR_WORDS.join('|')})\\b`, 'i')
}

export function extractColor(text: string): string | null {
  const match = text.toUpperCase().match(colorPattern())
  return match ? match[0] : null
}

export function stripColor(text: string): string {
  return text
    .toUpperCase()
    .replace(new RegExp(colorPattern(), 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function mentionsColor(text: string): boolean {
  return colorPattern().test(text.toUpperCase())
}
