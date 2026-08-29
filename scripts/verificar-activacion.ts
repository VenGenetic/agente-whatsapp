import { isAutoActivationMessage } from '../src/agent/autoActivation.js'

const cases: Array<[string | null, boolean]> = [
  ['¡Hola! Quiero más información.', true],
  ['Hola quiero mas informacion', true],
  ['  ¡HOLA!   Quiero más información  ', true],
  ['Hola, quiero más información sobre un tanque', false],
  ['Hola', false],
  [null, false],
]

let failures = 0
for (const [message, expected] of cases) {
  const actual = isAutoActivationMessage(message)
  if (actual === expected) console.log(`OK: ${JSON.stringify(message)}`)
  else {
    failures++
    console.error(`FALLÓ: ${JSON.stringify(message)}; esperado ${expected}, fue ${actual}`)
  }
}
if (failures) process.exitCode = 1
