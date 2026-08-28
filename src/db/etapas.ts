import { supabase } from '../supabaseClient.js'

/**
 * La etapa del flujo de una conversación, y el registro de cada cambio.
 *
 * Es una pregunta DISTINTA de la que contesta `status`:
 *
 *   status -> ¿quién manda este chat? (bot / humano / escalado / cerrado)
 *   etapa  -> ¿en qué punto del flujo está?
 *
 * Hasta la migración 0035, `status` intentaba ser las dos cosas, y por eso
 * una recepción terminada con éxito y una falla técnica quedaban iguales:
 * las dos como `escalated`. Separarlas es lo que permite que la bandeja
 * muestre "listo para vendedor" sin tocar el freno que ya impide que el
 * bot escriba encima de una persona.
 */

export type Etapa =
  /** Llegó y todavía no se procesó. */
  | 'new'
  /** La recepción está juntando datos. */
  | 'intake_in_progress'
  /** Se preguntó algo y falta que el cliente conteste. */
  | 'waiting_customer_info'
  /** Ficha completa y confirmada por el cliente. */
  | 'ready_for_sales'
  /** El agente vendedor está cotizando. */
  | 'sales_in_progress'
  /** Lo tomó una persona del equipo. */
  | 'human_assigned'
  /** Terminada. */
  | 'resolved'

/** Quién movió la conversación. */
export type Actor = 'intake' | 'sales' | 'human' | 'system'

/**
 * Etapas donde ningún agente automático debe escribir: o ya está en manos
 * de una persona, o la conversación terminó.
 */
const ETAPAS_CERRADAS: ReadonlySet<Etapa> = new Set<Etapa>(['human_assigned', 'resolved'])

export function etapaCerrada(etapa: Etapa | null | undefined): boolean {
  return !!etapa && ETAPAS_CERRADAS.has(etapa)
}

/**
 * true cuando falta la migración 0035.
 *
 * Son CUATRO códigos distintos y hay que tenerlos todos, porque PostgREST
 * usa uno diferente según qué falte y en qué operación. Se comprobó
 * corriendo esto contra la base sin la migración:
 *
 *   42703     columna inexistente al LEER (select)
 *   PGRST204  columna inexistente al ESCRIBIR (insert/update)
 *   PGRST205  tabla que no está en el cache de esquema
 *   42P01     tabla inexistente
 *
 * Faltaba PGRST204 en la primera versión, y el efecto era el peor
 * posible: el mensaje del cliente no se registraba.
 */
function faltaLaMigracion(error: { code?: string } | null | undefined): boolean {
  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    error?.code === 'PGRST205' ||
    error?.code === '42P01'
  )
}

let avisadoQueFalta = false

/**
 * Un solo aviso por proceso. Si la migración 0035 no se corrió, el agente
 * tiene que seguir trabajando igual que antes -- no quedarse mudo ni
 * llenar el log con el mismo error en cada mensaje.
 */
function avisarUnaVez(donde: string): void {
  if (avisadoQueFalta) return
  avisadoQueFalta = true
  console.warn(
    `Falta la migración 0035 (${donde}): el agente sigue funcionando, pero sin etapas ni ficha estructurada.`,
  )
}

/**
 * Cambia la etapa y deja el rastro de por qué.
 *
 * No lanza nunca. Una etapa que no se pudo guardar no puede impedir que
 * al cliente le llegue su respuesta: lo que de verdad no se puede perder
 * es el mensaje, y eso ya está registrado antes de llegar acá.
 */
export async function cambiarEtapa(params: {
  conversationId: number
  etapa: Etapa
  actor: Actor
  motivo?: string
}): Promise<void> {
  // La etapa anterior se lee para el registro. Si no se puede, se anota
  // igual con anterior = null: el cambio importa más que el "desde".
  const { data: fila } = await supabase
    .from('agent_conversations')
    .select('etapa')
    .eq('id', params.conversationId)
    .maybeSingle()

  const anterior = (fila?.etapa as Etapa | undefined) ?? null
  // Nada que hacer: sin esto, cada mensaje del cliente durante la
  // recepción dejaría una fila idéntica en el registro de eventos.
  if (anterior === params.etapa) return

  const { error } = await supabase
    .from('agent_conversations')
    .update({ etapa: params.etapa, updated_at: new Date().toISOString() })
    .eq('id', params.conversationId)

  if (error) {
    if (faltaLaMigracion(error)) avisarUnaVez('agent_conversations.etapa')
    else console.error('No se pudo cambiar la etapa de la conversación:', error.message)
    return
  }

  const { error: errorEvento } = await supabase.from('agent_conversation_events').insert({
    conversation_id: params.conversationId,
    etapa_anterior: anterior,
    etapa_nueva: params.etapa,
    actor: params.actor,
    motivo: params.motivo ?? null,
  })
  // El registro es para poder auditar después; que falle no invalida el
  // cambio, que ya quedó hecho.
  if (errorEvento && !faltaLaMigracion(errorEvento)) {
    console.error('No se pudo registrar el cambio de etapa:', errorEvento.message)
  }
}

/**
 * La etapa actual, o null si la migración todavía no corrió (y entonces
 * quien llama tiene que comportarse como antes de que existieran).
 */
export async function etapaDe(conversationId: number): Promise<Etapa | null> {
  const { data, error } = await supabase
    .from('agent_conversations')
    .select('etapa')
    .eq('id', conversationId)
    .maybeSingle()

  if (error) {
    if (faltaLaMigracion(error)) avisarUnaVez('agent_conversations.etapa')
    else console.error('No se pudo leer la etapa de la conversación:', error.message)
    return null
  }
  return (data?.etapa as Etapa | undefined) ?? null
}
