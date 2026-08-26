import type { WASocket } from '@whiskeysockets/baileys'
import { supabase } from '../supabaseClient.js'
import { runOutboxJob } from './outboxJob.js'

/**
 * Despacha lo que el equipo escribe desde el ERP APENAS se encola, sin
 * estar preguntando.
 *
 * Antes esto era un `setInterval` de 3 segundos. Del otro lado hay una
 * persona esperando que su mensaje salga, así que la respuesta rápida no
 * se negocia -- pero preguntar cada 3 segundos son ~864.000 consultas por
 * mes que casi siempre no traen nada, y eso es cuota de Supabase gastada
 * en preguntar "¿hay algo?".
 *
 * Con realtime, Supabase avisa cuando entra una fila (`agent_outbox` está
 * en la publicación desde la migración 0028) y el despacho sale igual de
 * rápido, o más.
 *
 * Igual queda una consulta lenta de respaldo: si la conexión de realtime
 * se cae o se pierde un evento, un mensaje del equipo NO puede quedarse
 * trabado para siempre. Es el mismo criterio del resto del proyecto --
 * nada crítico depende de un solo camino.
 */

/** Respaldo por si se pierde un evento de realtime. */
const RESPALDO_MS = 60 * 1000

let despachando = false

/**
 * Corre el job sin pisarse consigo mismo: el evento de realtime y el
 * respaldo pueden coincidir, y dos despachos a la vez mandarían el mismo
 * mensaje dos veces.
 */
async function despachar(sock: WASocket | null): Promise<void> {
  if (!sock || despachando) return
  despachando = true
  try {
    await runOutboxJob(sock)
  } catch (err) {
    console.error('Error enviando la cola de salida:', err)
  } finally {
    despachando = false
  }
}

export function iniciarOutboxWatcher(getSocket: () => WASocket | null): void {
  supabase
    .channel('agent_outbox_despacho')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'agent_outbox' }, () => {
      despachar(getSocket())
    })
    // Un UPDATE a 'pending' es un reintento pedido desde el ERP.
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'agent_outbox' }, (payload) => {
      if ((payload.new as { status?: string }).status === 'pending') despachar(getSocket())
    })
    .subscribe((estado) => {
      if (estado === 'SUBSCRIBED') console.log('Cola de salida: escuchando en vivo.')
      // CHANNEL_ERROR / TIMED_OUT: supabase-js reintenta solo, y mientras
      // tanto el respaldo de abajo sigue despachando.
      else if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT') {
        console.warn(`Cola de salida: realtime en estado ${estado}; se despacha por el respaldo cada 60s.`)
      }
    })

  setInterval(() => despachar(getSocket()), RESPALDO_MS)

  // Al arrancar puede haber quedado algo encolado mientras el proceso
  // estaba caído.
  despachar(getSocket())
}
