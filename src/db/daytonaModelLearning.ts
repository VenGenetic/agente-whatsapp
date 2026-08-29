import { supabase } from '../supabaseClient.js'

export async function getLearnedDaytonaAliases(): Promise<Map<string, string>> {
  const { data, error } = await supabase.from('agent_daytona_model_aliases').select('alias,canonical_model')
    .eq('active', true).neq('review_status', 'rejected').limit(200)
  if (error) return new Map()
  return new Map((data ?? []).map((row) => [String(row.alias), String(row.canonical_model)]))
}

export async function observeDaytonaModelAlias(alias: string, canonicalModel: string): Promise<void> {
  const { error } = await supabase.rpc('agent_observe_daytona_model_alias', { p_alias: alias, p_canonical_model: canonicalModel })
  if (error && error.code !== 'PGRST202' && error.code !== '42883') console.warn('No se pudo aprender el alias Daytona:', error.message)
}
