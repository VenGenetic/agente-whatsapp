import { config } from '../config.js'
import { supabase } from '../supabaseClient.js'

/**
 * Latido del agente: deja en la base que el proceso está vivo, cómo está
 * la sesión de WhatsApp y si la salida está frenada (migración 0027).
 *
 * Existe para un caso muy concreto: desde el ERP se le contesta al cliente
 * encolando en `agent_outbox`, y el que despacha es este proceso. Si está
 * caído o desconectado, los mensajes se quedan en la cola sin que nadie se
 * entere -- en pantalla se ve igual que "todavía no salió". Con el latido,
 * el ERP puede avisar antes de que alguien escriba tres mensajes al vacío.
 */

export type EstadoConexion = 'connected' | 'connecting' | 'disconnected'

let ultimoEstado: EstadoConexion = 'connecting'

/** Último estado reportado, para poder repetirlo en cada latido. */
export function estadoActual(): EstadoConexion {
  return ultimoEstado
}

/**
 * Escribe el latido. No lanza: que no se pueda anotar el estado no debe
 * tumbar el agente ni cortar una conversación en curso.
 */
export async function latir(estado: EstadoConexion = ultimoEstado): Promise<void> {
  ultimoEstado = estado
  const { error } = await supabase
    .from('agent_settings')
    .update({
      agent_last_seen_at: new Date().toISOString(),
      agent_connection: estado,
      agent_outbound_mode: config.outboundMode,
    })
    .eq('id', 1)

  if (error) {
    // A nivel warn y no error: es información de estado, no una falla de
    // servicio. Si esto se pusiera ruidoso taparía los errores de verdad.
    console.warn('No se pudo anotar el latido del agente:', error.message)
  }
}

/** Igual que `latir`, pero para llamar sin await desde un manejador de eventos. */
export function latirEnSegundoPlano(estado: EstadoConexion): void {
  latir(estado).catch(() => {
    /* ya se avisó adentro */
  })
}
