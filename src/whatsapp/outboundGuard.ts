import { AsyncLocalStorage } from 'node:async_hooks'
import { config } from '../config.js'
import { normalizePhoneNumber } from '../utils/phone.js'

/**
 * Freno de salida: decide si el agente puede escribirle a una dirección.
 *
 * Por qué existe, y por qué acá y no en cada job: hay ONCE puntos que
 * llaman a `sock.sendMessage` (respuestas del agente, recepción
 * proactiva, avisos de stock, cola del ERP, reportes al dueño). El
 * interruptor anterior (`BOT_KILL_SWITCH`) cubría UNO solo
 * -- handleMessage --, así que con el freno puesto el job de recepción
 * proactiva seguía escribiéndole a clientes cada 30 segundos por su
 * cuenta. Un `if` por punto de envío es exactamente la clase de defensa
 * de la que se escapa el siguiente que se agregue.
 *
 * Por eso el control vive envuelto alrededor del socket (ver
 * `instalarFrenoDeSalida`): TODO mensaje pasa por acá, incluido el que
 * escriba un job que todavía no existe.
 */

/** Motivo por el que un envío está autorizado, si lo está. */
export type MotivoPermitido =
  /** Lo escribió una persona del equipo desde el ERP (cola agent_outbox). */
  | 'human_erp'
  /** Aviso interno al número del dueño: no es un cliente. */
  | 'owner_notice'

const contexto = new AsyncLocalStorage<MotivoPermitido>()

/**
 * Marca un envío como autorizado por el motivo dado. Todo lo que se mande
 * dentro del callback (incluido lo asíncrono) queda etiquetado.
 */
export function conPermiso<T>(motivo: MotivoPermitido, fn: () => Promise<T>): Promise<T> {
  return contexto.run(motivo, fn)
}

const jidDelDueno = normalizePhoneNumber(config.ownerPhoneNumber)

/** true si la dirección es el número del dueño (no un cliente). */
function esDelDueno(jid: string): boolean {
  const digits = jid.split('@')[0]?.replace(/\D/g, '') ?? ''
  return digits.length > 0 && digits === jidDelDueno
}

export interface Decision {
  permitido: boolean
  /** Por qué se bloqueó, para el log. Vacío si se permitió. */
  razon: string
}

/**
 * Reglas, de más a menos permisiva según `config.outboundMode`:
 *
 * - `full`: el agente trabaja normal (respuestas automáticas y jobs).
 * - `erp_only`: los clientes SOLO reciben lo que una persona escribió a
 *   mano desde el ERP. El agente no contesta solo.
 * - `blocked`: ningún cliente recibe nada. Solo pasan los avisos al
 *   número del dueño.
 *
 * El dueño recibe siempre: son avisos internos (escalamientos, resumen
 * diario), no mensajes a clientes, y silenciarlos dejaría al negocio sin
 * saber que algo necesita atención.
 */
export function puedeEnviar(jid: string): Decision {
  if (esDelDueno(jid)) return { permitido: true, razon: '' }

  switch (config.outboundMode) {
    case 'full':
      return { permitido: true, razon: '' }
    case 'erp_only':
      return contexto.getStore() === 'human_erp'
        ? { permitido: true, razon: '' }
        : {
            permitido: false,
            razon: 'OUTBOUND_MODE=erp_only: a los clientes solo se les manda lo que se escribe desde el ERP',
          }
    case 'blocked':
    default:
      return {
        permitido: false,
        razon: 'OUTBOUND_MODE=blocked: el agente no le escribe a ningún cliente',
      }
  }
}
