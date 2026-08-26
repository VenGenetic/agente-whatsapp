/**
 * Une los chats que quedaron partidos en dos filas: una con el número de
 * teléfono y otra con el "ID interno" (LID) del mismo cliente.
 *
 * El agente ya hace esto solo, cada 10 minutos
 * (`src/agent/mergeConversationsJob.ts`). Este script existe para las
 * veces en que hace falta a mano: revisar qué se va a unir antes de que
 * pase, o arreglar la base con el proceso apagado.
 *
 * La lógica de detección y de unión NO está acá: vive en
 * `src/db/mergeConversations.ts`, compartida con el job, para que las dos
 * no puedan terminar haciendo cosas distintas.
 *
 * Uso:
 *   npm run unificar-chats                -> solo muestra qué haría
 *   npm run unificar-chats -- --aplicar   -> lo hace (deja respaldo JSON)
 */
import { writeFile } from 'node:fs/promises'
import { contarMensajes, detectarPares, unificarPar } from '../src/db/mergeConversations.js'

const APLICAR = process.argv.includes('--aplicar')

async function main(): Promise<void> {
  const pares = await detectarPares()
  if (pares === null) {
    console.log('Falta aplicar supabase/migrations/0029_agent_chats_duplicados_rpc.sql.')
    // `exitCode` y no `process.exit()`: cortar de golpe con el cliente de
    // Supabase todavía abierto revienta libuv en Windows ("Assertion
    // failed: !(handle->flags & UV_HANDLE_CLOSING)"). Así Node cierra
    // ordenado y el código de salida sigue siendo 1.
    process.exitCode = 1
    return
  }
  if (pares.length === 0) {
    console.log('No hay chats duplicados. Nada que hacer.')
    return
  }

  console.log(`\nPares duplicados: ${pares.length}`)
  console.log(APLICAR ? 'Modo APLICAR: se van a unificar.\n' : 'Modo prueba (agregá --aplicar para hacerlo).\n')

  const respaldo: unknown[] = []
  let unificados = 0
  let mensajesMovidos = 0

  for (const par of pares) {
    const { conTelefono, conLid } = par
    const nTelefono = await contarMensajes(conTelefono.id)
    const nLid = await contarMensajes(conLid.id)
    const nombre = conTelefono.customer_name ?? conLid.customer_name ?? '(sin nombre)'

    console.log(
      `${nombre}: conv ${conTelefono.id} (${nTelefono} msgs, tel ${conTelefono.phone_number}) ` +
        `<-> conv ${conLid.id} (${nLid} msgs, LID ${conLid.phone_number})`,
    )

    respaldo.push({ conTelefono, conLid, mensajesTelefono: nTelefono, mensajesLid: nLid })
    if (!APLICAR) continue

    const r = await unificarPar(par)
    mensajesMovidos += r.mensajesMovidos
    unificados++
    console.log(`   -> queda conv ${r.quedaId}, se borró conv ${r.sobraId} (${r.mensajesMovidos} mensajes movidos)`)
  }

  if (!APLICAR) {
    console.log('\nNada se modificó. Para hacerlo: npm run unificar-chats -- --aplicar')
    return
  }

  const archivo = `backup-unificar-chats-${Date.now()}.json`
  await writeFile(archivo, JSON.stringify(respaldo, null, 2), 'utf-8')
  console.log(`\nUnificados: ${unificados} chats. Mensajes movidos: ${mensajesMovidos}.`)
  console.log(`Respaldo de lo que había antes: ${archivo}`)
}

main().catch((err) => {
  console.error('Falló la unificación:', err)
  process.exit(1)
})
