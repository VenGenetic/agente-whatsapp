export const DAYTONA_MODELS = [
  'Wing Evo II', 'GP-1', 'GP-1 S', 'GP-1 R', 'GP-1 RR', 'Cobra', 'Feroce', 'GTR', 'GTR Roadster',
  'Terrex', 'S1 Adventure', 'S1 Crossover', 'Tekken Evo', 'Tekken Discovery', 'Everest Dual Sport',
  'Everest Off Road', 'Adventure', 'Adventure 300R', 'Arctic', 'Shark 1', 'Shark 3', 'Montana',
  'Xpedition', 'Delta', 'Work Force', 'Spitfire', 'Crucero', 'Dynamic Pro', 'CX7 Pro', 'Tanq',
  'Caballito', 'Bit Se Bi', 'Agility X', 'Eagle 5', 'Eagle Z', 'Scorpion', 'Wolf Evolution',
  'Super Wolf', 'XPower', 'ZR', 'Arrow', 'Scrambler Max', 'Scrambler Revolution', 'Cafe Racer',
  'Predator', 'Hunter 4', 'Commander',
] as const

export function normalizeDaytonaText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/\bdaytona\b/g, '').replace(/\b(?:moto|modelo)\b/g, '')
    .replace(/\b(?:1[0258]0|170|180|200|202|250|290|300|370)\s*(?:cc|c\.c\.)?\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j]
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return previous[b.length]
}

const aliases = new Map<string, string>(DAYTONA_MODELS.map((model) => [normalizeDaytonaText(model), model]))
for (const [alias, model] of [['wing evo 2', 'Wing Evo II'], ['gp1', 'GP-1'], ['gp1 s', 'GP-1 S'],
  ['gp1 r', 'GP-1 R'], ['gp1 rr', 'GP-1 RR'], ['x power', 'XPower'], ['workforce', 'Work Force'],
  ['bit sebi', 'Bit Se Bi']] as const) aliases.set(alias, model)

export function canonicalDaytonaModel(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const input = normalizeDaytonaText(value)
  const exact = aliases.get(input)
  if (exact) return exact
  if (input.length < 4) return null

  const ranked = [...aliases.entries()]
    .map(([alias, model]) => ({ model, distance: editDistance(input, alias), aliasLength: alias.length }))
    .sort((a, b) => a.distance - b.distance || a.aliasLength - b.aliasLength)
  const best = ranked[0]
  const secondDifferent = ranked.find((candidate) => candidate.model !== best?.model)
  const allowed = Math.min(3, Math.max(1, Math.floor(Math.max(input.length, best?.aliasLength ?? 0) * 0.25)))
  // Si dos modelos quedan igual de cerca, preguntar es más seguro que elegir.
  if (!best || best.distance > allowed || secondDifferent?.distance === best.distance) return null
  return best.model
}

export function isDaytonaBrand(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const words = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z]+/g) ?? []
  return words.some((word) => word === 'daytona' || (word.length >= 6 && editDistance(word, 'daytona') <= 2))
}

function nearestModels(value: string, limit = 4): string[] {
  const input = normalizeDaytonaText(value)
  const result: string[] = []
  for (const candidate of [...aliases.entries()].sort((a, b) => editDistance(input, a[0]) - editDistance(input, b[0]))) {
    if (!result.includes(candidate[1])) result.push(candidate[1])
    if (result.length === limit) break
  }
  return result
}

const EXAMPLES = ['Wing Evo II', 'Tekken Evo', 'Dynamic Pro', 'GP-1', 'Shark 1', 'Wolf Evolution']

export function daytonaModelQuestion(customerText: string, invalidModel?: string | null): string {
  if (/\b(no (?:se|sé|recuerdo|conozco)|ni idea|no sabria|no sabría)\b/i.test(customerText)) {
    return `¿Será alguno de estos modelos Daytona: ${EXAMPLES.join(', ')}? Si ninguno te suena, envíame una foto de la moto o de su matrícula y te ayudamos a identificarla.`
  }
  if (invalidModel) return `No pude identificar con seguridad “${invalidModel}”. ¿Será alguno de estos modelos Daytona: ${nearestModels(invalidModel).join(', ')}?`
  return `¿Qué modelo Daytona tienes? Por ejemplo: ${EXAMPLES.slice(0, 4).join(', ')}. Si no lo sabes, dímelo y te muestro más opciones.`
}

export function enforceDaytonaIntake(data: Record<string, any>, customerText: string): Record<string, any> {
  const hasBrand = typeof data.marca === 'string' && data.marca.trim().length > 0
  if (hasBrand && !isDaytonaBrand(data.marca)) return { ...data, marca: null, modelo: null, complete: false,
    next_question: 'Por el momento atendemos solicitudes de repuestos para motos Daytona. ¿Tu moto es Daytona?' }
  const rawModel = typeof data.modelo === 'string' ? data.modelo.trim() : ''
  const canonical = canonicalDaytonaModel(rawModel)
  if (rawModel && !canonical) return { ...data, marca: 'Daytona', modelo: null, complete: false,
    next_question: daytonaModelQuestion(customerText, rawModel) }
  if (!canonical) {
    const proposed = typeof data.next_question === 'string' && data.next_question.length <= 300
      && DAYTONA_MODELS.some((model) => data.next_question.toLowerCase().includes(model.toLowerCase()))
      ? data.next_question
      : daytonaModelQuestion(customerText)
    return { ...data, marca: hasBrand ? 'Daytona' : data.marca ?? null, modelo: null,
      complete: false, next_question: proposed }
  }
  return { ...data, marca: 'Daytona', modelo: canonical }
}
