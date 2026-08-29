import { supabase } from '../supabaseClient.js'

export type LearnedExample = { id: number; customerText: string; replyText: string; similarity: number }

export async function refreshLearnedExamples(limit = 500): Promise<number> {
  const { data, error } = await supabase.rpc('agent_refresh_learned_examples', { p_limit: limit })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') return 0
    throw error
  }
  return Number(data ?? 0)
}

export async function findLearnedExamples(query: string, limit = 3): Promise<LearnedExample[]> {
  if (query.trim().length < 3) return []
  const { data, error } = await supabase.rpc('agent_find_learned_examples', {
    p_query: query,
    p_limit: limit,
  })
  if (error) {
    if (error.code === 'PGRST202' || error.code === '42883') return []
    console.error('No se pudieron recuperar ejemplos aprendidos:', error.message)
    return []
  }
  const examples: LearnedExample[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: Number(row.id),
    customerText: String(row.customer_text ?? ''),
    replyText: String(row.reply_text ?? ''),
    similarity: Number(row.similarity_score ?? 0),
  }))
  if (examples.length > 0) {
    const { error: usageError } = await supabase.rpc('agent_record_learned_example_usage', {
      p_ids: examples.map((example) => example.id),
    })
    if (usageError && usageError.code !== 'PGRST202' && usageError.code !== '42883') {
      console.warn('No se pudo registrar el uso del aprendizaje:', usageError.message)
    }
  }
  return examples
}
