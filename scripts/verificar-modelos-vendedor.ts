/**
 * Prueba las relaciones entre nombres de los repuestos del catálogo y los
 * modelos que el vendedor usa para no cruzar familias parecidas.
 * No toca WhatsApp, Gemini ni la base.
 */
import {
  detectCatalogModels,
  detectKnownModels,
  findModelDisambiguation,
} from '../src/matching/knownModels.js'

const MODELOS = [
  'WOLF', 'WOLF 250', 'WOLF EVOLUTION', 'SUPER WOLF',
  'TEKKEN', 'TEKKEN 250', 'TEKKEN EVO', 'TEKKEN DISCOVERY',
]

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

console.log('Verificando vínculos catálogo → modelo para el agente vendedor.\n')

esperar('el cliente que dice Wolf 250 no se cruza con Wolf 200',
  detectKnownModels('busco un tanque para Wolf 250', MODELOS), ['WOLF 250'])
esperar('el cliente que dice Tekken Evo no se cruza con Tekken genérico',
  detectKnownModels('necesito faro para Daytona Tekken Evo', MODELOS), ['TEKKEN EVO'])
esperar('Tekken sin apellido sigue siendo ambiguo para el cliente',
  findModelDisambiguation(detectKnownModels('busco plásticos Daytona Tekken', MODELOS), [{
    models: ['TEKKEN'], hint: 'preguntar las tres variantes',
  }])?.hint, 'preguntar las tres variantes')
esperar('un repuesto histórico TEKKEN se enlaza a Tekken 250',
  detectCatalogModels('KIT ARRASTRE TEKKEN', MODELOS), ['TEKKEN 250'])
esperar('un repuesto Evo se enlaza solo a Tekken Evo',
  detectCatalogModels('MASCARILLA COMP TEKKEN EVO/AXXO TRACKER 250CC ROJO', MODELOS), ['TEKKEN EVO'])
esperar('un repuesto Discovery se enlaza solo a Tekken Discovery',
  detectCatalogModels('MASCARILLA COMP. TEKKEN DISCOVERY 300CC', MODELOS), ['TEKKEN DISCOVERY'])
esperar('un repuesto Super Wolf no se cruza con Wolf 200',
  detectCatalogModels('TIMON SUPER WOLF 300', MODELOS), ['SUPER WOLF'])
esperar('una descripción que lista Wolf y variantes conserva todos los compatibles',
  detectCatalogModels('ARO WOLF/ADV 200/MAVERICK/WOLF 250/FEROCE/WOLF EVOLUTION', MODELOS),
  ['WOLF EVOLUTION', 'WOLF 250', 'WOLF'])

if (fallos > 0) {
  console.error(`\n${fallos} comprobación(es) fallaron.`)
  process.exitCode = 1
} else {
  console.log('\nTodo bien: ventas puede usar las descripciones como evidencia de modelo.')
}
