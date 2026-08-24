/**
 * Resetea una conversación de WhatsApp de prueba: borra el historial
 * (agent_conversations, que en cascada se lleva agent_messages y
 * agent_escalations) para poder probar el bot desde cero sin que el
 * historial viejo lo confunda.
 *
 * Uso:
 *   npm run reset-chat -- <numero>              (ej. 593993279707)
 *   npm run reset-chat -- <numero> --with-demands
 *
 * --with-demands también borra las demandas (product_demands) que ese
 * número generó durante las pruebas -- product_demands es una tabla real
 * del ERP, no exclusiva del agente, así que por defecto NO se toca; solo
 * se borra si lo pedís explícitamente.
 */
import { supabase } from '../src/supabaseClient.js'

const phoneNumber = process.argv[2]
const withDemands = process.argv.includes('--with-demands')

if (!phoneNumber) {
  console.error('Uso: npm run reset-chat -- <numero> [--with-demands]')
  process.exit(1)
}

const { data: conversation, error: findError } = await supabase
  .from('agent_conversations')
  .select('id')
  .eq('phone_number', phoneNumber)
  .maybeSingle()

if (findError) throw findError

if (!conversation) {
  console.log(`No hay ninguna conversación guardada para "${phoneNumber}" -- nada que resetear.`)
} else {
  const { error: deleteError } = await supabase.from('agent_conversations').delete().eq('id', conversation.id)
  if (deleteError) throw deleteError
  console.log(`Conversación de "${phoneNumber}" borrada (historial, escalamientos -- todo en cascada).`)
}

if (withDemands) {
  const { error: demandsError, count } = await supabase
    .from('product_demands')
    .delete({ count: 'exact' })
    .eq('phone_number', phoneNumber)
  if (demandsError) throw demandsError
  console.log(`${count ?? 0} demanda(s) de producto de "${phoneNumber}" borrada(s).`)
}

console.log('Listo. El próximo mensaje de este número arranca una conversación nueva.')
