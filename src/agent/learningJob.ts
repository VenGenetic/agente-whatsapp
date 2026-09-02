import { refreshLearnedExamples } from '../db/learnedExamples.js'
import { refreshRequestStatistics } from '../db/requestKnowledge.js'

/**
 * El aprendizaje es auxiliar: una tabla o RPC temporalmente caída no debe
 * impedir refrescar la otra fuente ni convertirse en una falla general del
 * agente. Cada fuente deja su propio rastro para poder corregirla.
 */
async function refreshSafely(name: string, task: () => Promise<number>): Promise<number> {
  try {
    return await task()
  } catch (err) {
    console.error(`Aprendizaje: no se pudo actualizar ${name}:`, err)
    return 0
  }
}

export async function runLearningJob(): Promise<void> {
  const [examples, statistics] = await Promise.all([
    refreshSafely('los ejemplos de respuestas humanas', () => refreshLearnedExamples(5000)),
    refreshSafely('las tendencias y alias de recepción', () => refreshRequestStatistics()),
  ])
  if (examples > 0) console.log(`Aprendizaje: ${examples} ejemplo(s) humano(s) revisados o actualizados.`)
  if (statistics > 0) console.log(`Conocimiento de recepción: ${statistics} tendencia(s) de modelos y repuestos actualizada(s).`)
}
