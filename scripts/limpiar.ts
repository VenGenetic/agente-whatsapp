/**
 * Limpieza de datos que ensucian la bandeja y pueden causar avisos
 * indebidos. NO borra nada sin respaldar primero.
 *
 * Uso:
 *   npm run limpiar              -> solo muestra qué haría (no toca nada)
 *   npm run limpiar -- --aplicar -> hace la limpieza
 */
import { writeFileSync } from 'node:fs'
import { supabase } from '../src/supabaseClient.js'

const APLICAR = process.argv.includes('--aplicar')

async function todasLasFilas<T>(tabla: string, columnas: string): Promise<T[]> {
  const filas: T[] = []
  const PAGINA = 1000
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase.from(tabla).select(columnas).range(desde, desde + PAGINA - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    filas.push(...(data as T[]))
    if (data.length < PAGINA) break
  }
  return filas
}

// ---------- 1) Conversaciones sin ningún mensaje ----------
const conversaciones = await todasLasFilas<{ id: number; phone_number: string; bot_enabled: boolean }>(
  'agent_conversations',
  'id, phone_number, bot_enabled',
)
const mensajes = await todasLasFilas<{ conversation_id: number }>('agent_messages', 'conversation_id')
const conMensajes = new Set(mensajes.map((m) => m.conversation_id))

// Nunca se borra una conversación con el agente activado: es una decisión
// explícita del negocio, aunque todavía no tenga mensajes.
const vacias = conversaciones.filter((c) => !conMensajes.has(c.id) && !c.bot_enabled)
console.log(`Conversaciones sin ningún mensaje: ${vacias.length} (de ${conversaciones.length})`)

// ---------- 2) Demandas de stock del número anterior ----------
// Son de clientes que pidieron por el número viejo. Si se reactiva el job
// de avisos, les escribiría desde un número que no reconocen.
const CORTE = '2026-08-23T23:40:00Z'
const { data: demandasViejas } = await supabase
  .from('product_demands')
  .select('id, phone_number, product_id, status, created_at')
  .in('status', ['pending_stock', 'stock_available'])
  .lt('created_at', CORTE)
console.log(`Demandas activas anteriores al número actual: ${demandasViejas?.length ?? 0}`)

if (!APLICAR) {
  console.log('\n(modo simulación -- no se tocó nada)')
  console.log('Para aplicar: npm run limpiar -- --aplicar')
  process.exit(0)
}

// ---------- Respaldo antes de tocar nada ----------
const respaldo = {
  exportadoEl: new Date().toISOString(),
  conversacionesVacias: vacias,
  demandasViejas: demandasViejas ?? [],
}
const archivo = `backup-limpieza-${Date.now()}.json`
writeFileSync(archivo, JSON.stringify(respaldo, null, 2), 'utf8')
console.log(`\nRespaldo guardado en ${archivo}`)

// ---------- Aplicar ----------
if (vacias.length > 0) {
  const ids = vacias.map((c) => c.id)
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await supabase.from('agent_conversations').delete().in('id', ids.slice(i, i + 500))
    if (error) throw error
  }
  console.log(`${ids.length} conversaciones vacías borradas.`)
}

if (demandasViejas && demandasViejas.length > 0) {
  // Se marcan como canceladas en vez de borrarlas: `product_demands` es
  // una tabla del ERP con historial propio, no algo del agente.
  const ids = demandasViejas.map((d) => d.id)
  for (let i = 0; i < ids.length; i += 500) {
    const { error } = await supabase
      .from('product_demands')
      .update({ status: 'cancelled' })
      .in('id', ids.slice(i, i + 500))
    if (error) throw error
  }
  console.log(`${ids.length} demandas viejas marcadas como canceladas (no borradas).`)
}

console.log('\nListo.')
