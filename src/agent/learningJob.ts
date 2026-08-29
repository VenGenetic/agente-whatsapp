import { refreshLearnedExamples } from '../db/learnedExamples.js'

export async function runLearningJob(): Promise<void> {
  const processed = await refreshLearnedExamples(5000)
  if (processed > 0) console.log(`Aprendizaje: ${processed} ejemplo(s) humano(s) revisados o actualizados.`)
}
