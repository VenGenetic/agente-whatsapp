import type { WASocket } from '@whiskeysockets/baileys'
import { supabase } from '../supabaseClient.js'

/**
 * Los grupos de WhatsApp a los que pertenece la cuenta, guardados como
 * conversaciones para poder ESCRIBIRLES desde el ERP.
 *
 * La entrada de grupos sigue ignorada (ver `shouldIgnoreJid` en
 * baileys.ts): esto no lee nada de lo que se dice en el grupo, solo
 * averigua que el grupo existe y cómo se llama, para que alguien pueda
 * elegirlo como destino.
 *
 * Hace falta porque un JID de grupo no se puede escribir a mano ni
 * deducir: es un identificador interno de WhatsApp
 * (`120363...@g.us`). La única forma de conocerlo es preguntárselo a
 * WhatsApp, que es lo que hace `groupFetchAllParticipating`.
 */

/**
 * Si nadie eligió un grupo todavía, se preselecciona el que se llame así.
 *
 * Es una comodidad, no una regla: evita tener que configurar nada para
 * que el aviso de compras funcione. Se compara sin tildes ni mayúsculas
 * porque el nombre lo escribió una persona en el teléfono. En cuanto
 * alguien elija un grupo a mano, esto deja de mirarse -- por eso no se
 * puede dejar el nombre fijo en el envío: un grupo se renombra y el aviso
 * dejaría de salir en silencio.
 */
const GRUPO_POR_DEFECTO = 'ventas bajo pedido'

/** Sin tildes, sin mayúsculas y sin espacios de más. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export async function runGroupsJob(sock: WASocket): Promise<void> {
  const grupos = await sock.groupFetchAllParticipating()
  const entradas = Object.values(grupos ?? {})
  if (entradas.length === 0) return

  for (const grupo of entradas) {
    const jid = grupo.id
    if (!jid?.endsWith('@g.us')) continue

    // `phone_number` es NOT NULL UNIQUE y en un grupo no hay teléfono: se
    // usan los dígitos del propio JID, que ya son únicos por grupo. La
    // bandeja no los muestra como número porque la fila va marcada con
    // `is_group`.
    const identificador = jid.split('@')[0]?.replace(/\D/g, '')
    if (!identificador) continue

    const { error } = await supabase.from('agent_conversations').upsert(
      {
        phone_number: identificador,
        // `?? ` no alcanza: WhatsApp devuelve el asunto como cadena VACÍA
        // en algunos grupos, no como null (se vio en 4 de 34), y eso
        // dejaba filas en blanco en la lista de la bandeja.
        customer_name: grupo.subject?.trim() || 'Grupo sin nombre',
        chat_jid: jid,
        is_group: true,
        // Un grupo no se atiende con el bot. Explícito y no por defecto:
        // que el agente conteste solo dentro de un grupo de trabajo sería
        // difícil de deshacer y muy visible.
        bot_enabled: false,
      },
      { onConflict: 'phone_number' },
    )
    if (error) {
      // Un grupo que no se pudo guardar no puede tumbar a los demás.
      console.error(`Grupos: no se pudo guardar "${grupo.subject}":`, error.message)
    }
  }

  await preseleccionarGrupoDeRequerimientos(entradas.map((g) => ({ id: g.id, subject: g.subject })))
}

/**
 * Elige el grupo de requerimientos la primera vez, si nadie lo eligió.
 *
 * Solo escribe cuando la configuración está vacía: si alguien ya eligió
 * uno, esto no lo toca nunca -- ni siquiera si aparece otro grupo que se
 * llame igual.
 */
async function preseleccionarGrupoDeRequerimientos(
  grupos: Array<{ id: string; subject: string }>,
): Promise<void> {
  const { data, error } = await supabase
    .from('agent_settings')
    .select('requirements_group_jid')
    .eq('id', 1)
    .maybeSingle()
  // Si falta la migración 0034 la columna no existe. No es un fallo del
  // agente: se sigue sin preseleccionar nada.
  if (error || !data) return
  if (data.requirements_group_jid) return

  const buscado = normalizar(GRUPO_POR_DEFECTO)
  const elegido = grupos.find((g) => normalizar(g.subject ?? '') === buscado)
  if (!elegido) return

  const { error: errorGuardar } = await supabase
    .from('agent_settings')
    .update({
      requirements_group_jid: elegido.id,
      requirements_group_name: elegido.subject,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1)
    // Solo si sigue vacío: entre la lectura y esta escritura alguien pudo
    // haberlo elegido desde el ERP, y su elección manda sobre la nuestra.
    .is('requirements_group_jid', null)

  if (errorGuardar) {
    console.error('Grupos: no se pudo preseleccionar el grupo de requerimientos:', errorGuardar.message)
    return
  }
  console.log(`Grupos: "${elegido.subject}" queda como grupo de requerimientos.`)
}
