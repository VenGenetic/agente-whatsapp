import { detectarPares, unificarPar } from '../db/mergeConversations.js'

/**
 * Une los chats que aparecen duplicados en el ERP: el mismo cliente en dos
 * filas, una con su teléfono y otra con su "ID interno" (LID).
 *
 * Por qué es un job y no algo que se corra a mano: un duplicado queda
 * LATENTE hasta que esa persona vuelve a escribir. Recién ahí el mensaje
 * trae las dos identidades juntas y se puede saber que son la misma. O sea
 * que aparecen de a poco, para siempre -- y esperar que alguien se dé
 * cuenta de correr un script cuando ve dos veces al mismo cliente no es un
 * plan: el equipo lo que hace es contestarle a uno de los dos hilos, con
 * la mitad de la conversación a la vista.
 *
 * No corre en el camino de cada mensaje a propósito: unir implica borrar
 * una fila, y hacerlo mientras se está guardando un mensaje entrante
 * arriesga justo ese mensaje. Acá corre tranquilo, cada tanto.
 */
export async function runMergeConversationsJob(): Promise<void> {
  const pares = await detectarPares()
  // null = falta la migración 0029; ya se avisó por consola.
  if (!pares || pares.length === 0) return

  for (const par of pares) {
    try {
      const r = await unificarPar(par)
      console.log(
        `Chats unificados: conv ${r.sobraId} -> conv ${r.quedaId} (${r.mensajesMovidos} mensajes, tel ${r.telefono}).`,
      )
    } catch (err) {
      // Un par que falla no debe frenar a los demás: cada uno es
      // independiente y el próximo tick lo reintenta.
      console.error(`No se pudo unificar conv ${par.conLid.id} con conv ${par.conTelefono.id}:`, err)
    }
  }
}
