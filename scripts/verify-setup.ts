/**
 * Chequeo de humo, sin WhatsApp: valida que las 3 migraciones quedaron bien
 * aplicadas en Supabase y que el pipeline de Gemini (intérprete + redactor)
 * funciona con las credenciales reales del .env. Útil para verificar el
 * setup antes de -- o sin -- tener el teléfono del bot a mano.
 *
 * Uso: npm run verify
 */
import { supabase } from '../src/supabaseClient.js'
import { interpretMessage } from '../src/gemini/interpret.js'
import { draftReply } from '../src/gemini/respond.js'

let failures = 0

function ok(label: string): void {
  console.log(`  OK  ${label}`)
}

function fail(label: string, err: unknown): void {
  failures++
  console.log(`FALLÓ  ${label}`)
  console.log(`       ${err instanceof Error ? err.message : String(err)}`)
}

async function checkTablesExist(): Promise<void> {
  const tables = ['agent_conversations', 'agent_messages', 'agent_product_aliases', 'agent_escalations']
  for (const table of tables) {
    const { error } = await supabase.from(table).select('id', { count: 'exact', head: true })
    if (error) fail(`tabla ${table} existe y es consultable`, error.message)
    else ok(`tabla ${table} existe y es consultable`)
  }

  const { error: lostDemandError } = await supabase
    .from('lost_demand')
    .select('id', { count: 'exact', head: true })
    .eq('channel', 'WHATSAPP')
    .limit(0)
  if (lostDemandError) fail("lost_demand.channel acepta 'WHATSAPP'", lostDemandError.message)
  else ok("lost_demand.channel acepta 'WHATSAPP'")
}

async function checkSearchRpc(): Promise<void> {
  const { data: sample, error: sampleError } = await supabase
    .from('products')
    .select('id, name')
    .eq('is_discontinued', false)
    .limit(1)
    .maybeSingle()

  if (sampleError) {
    fail('leer un producto de muestra para probar la RPC', sampleError.message)
    return
  }
  if (!sample) {
    console.log('  --  no hay productos en la tabla, se salta la prueba de la RPC de búsqueda')
    return
  }

  const { data, error } = await supabase.rpc('agent_search_products', { p_query: sample.name, p_limit: 3 })
  if (error) {
    fail('RPC agent_search_products responde', error.message)
    return
  }
  const found = (data ?? []).some((row: { product_id: number }) => row.product_id === sample.id)
  if (found) ok(`RPC agent_search_products encuentra "${sample.name}" por su propio nombre`)
  else fail(`RPC agent_search_products encuentra "${sample.name}" por su propio nombre`, 'no vino en los resultados')
}

async function checkGeminiInterpret(): Promise<void> {
  try {
    const result = await interpretMessage({
      text: 'hola buenas, tienen guardapolvo delantero para un corolla 2015?',
    })
    const searchQuery = result.items[0]?.searchQuery ?? null
    if (result.intent === 'product_request' && searchQuery) {
      ok(`Gemini (intérprete) devolvió intent="${result.intent}" search_query="${searchQuery}"`)
    } else {
      fail('Gemini (intérprete) interpreta un pedido de producto de ejemplo', `intent=${result.intent} search_query=${searchQuery}`)
    }
  } catch (err) {
    fail('Gemini (intérprete) responde', err)
  }
}

async function checkGeminiRespond(): Promise<void> {
  try {
    const reply = await draftReply({
      facts: { case: 'in_stock', productName: 'Guardapolvo delantero izquierdo', sku: 'TEST-001', price: 25, imageUrl: null },
      escalation: { escalate: false },
      history: [],
      customerMessage: 'hola, tienen ese guardapolvo?',
      instruction: 'Contale que sí lo tienen, dale el precio, y avisá que le mandás la foto.',
    })
    if (reply.includes('25')) {
      ok(`Gemini (redactor) devolvió un mensaje que respeta el precio dado: "${reply}"`)
    } else {
      fail('Gemini (redactor) respeta el precio exacto de HECHOS_VERIFICADOS', `mensaje devuelto: "${reply}"`)
    }
  } catch (err) {
    fail('Gemini (redactor) responde', err)
  }
}

async function main(): Promise<void> {
  console.log('== Tablas y RPC en Supabase ==')
  await checkTablesExist()
  await checkSearchRpc()

  console.log('\n== Pipeline de Gemini ==')
  await checkGeminiInterpret()
  await checkGeminiRespond()

  console.log(`\n${failures === 0 ? 'Todo OK.' : `${failures} chequeo(s) fallaron.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
