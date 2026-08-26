/**
 * Borra del chat los archivos MÁS VIEJOS que cierta cantidad de meses, para
 * que el Storage de Supabase no crezca sin techo.
 *
 * Por qué hace falta: se midió el consumo real -- unos 190 MB por mes entre
 * fotos, notas de voz y videos. Con 1 GB de cuota gratuita, sin borrar nada
 * el bucket se llena en unos 5 meses y ahí empieza a costar plata. Poner
 * topes de tamaño baja el ritmo, pero no cambia que sea crecimiento
 * infinito: lo único que lo vuelve sostenible es soltar lo viejo.
 *
 * Qué se pierde y qué NO: se borra el ARCHIVO, no el mensaje. La
 * conversación queda completa -- quién escribió, qué dijo, cuándo -- y el
 * hilo del ERP muestra "archivo no guardado", igual que con los mensajes
 * importados del historial. Nadie pierde el rastro de una venta; se pierde
 * poder volver a ver una foto de hace medio año, que es lo que casi nunca
 * se necesita.
 *
 * Uso:
 *   npm run limpiar-media                    -> muestra qué borraría (6 meses)
 *   npm run limpiar-media -- --meses 3       -> cambia la antigüedad
 *   npm run limpiar-media -- --aplicar       -> lo borra
 */
import { config } from '../src/config.js'
import { supabase } from '../src/supabaseClient.js'

const APLICAR = process.argv.includes('--aplicar')
const iMeses = process.argv.indexOf('--meses')
const MESES = iMeses !== -1 ? Number(process.argv[iMeses + 1]) : 6

if (!Number.isFinite(MESES) || MESES < 1) {
  console.log('El valor de --meses tiene que ser un número de 1 o más.')
  process.exit(1)
}

async function main(): Promise<void> {
  const corte = new Date()
  corte.setMonth(corte.getMonth() - MESES)
  console.log(`Buscando media anterior a ${corte.toISOString().slice(0, 10)} (${MESES} meses)...`)

  // Se parte de los MENSAJES y no del bucket: la fecha del mensaje es la
  // que importa, y así nunca se toca un archivo que no le pertenezca a uno
  // (por ejemplo la foto de un producto del catálogo, que vive en otro
  // bucket pero podría estar referenciada acá).
  const urls: Array<{ id: number; media_url: string }> = []
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await supabase
      .from('agent_messages')
      .select('id, media_url')
      .not('media_url', 'is', null)
      .lt('created_at', corte.toISOString())
      .order('id', { ascending: true })
      .range(desde, desde + 999)
    if (error) throw error
    if (!data || data.length === 0) break
    urls.push(...(data as Array<{ id: number; media_url: string }>))
    if (data.length < 1000) break
  }

  // Solo lo que vive en NUESTRO bucket del chat. Si un mensaje apunta a una
  // foto del catálogo (`product_images`), ese archivo no es nuestro para
  // borrarlo: lo usa el ERP en otras pantallas.
  const marca = `/${config.chatMediaBucket}/`
  const rutas: string[] = []
  const ids: number[] = []
  for (const fila of urls) {
    const i = fila.media_url.indexOf(marca)
    if (i === -1) continue
    rutas.push(decodeURIComponent(fila.media_url.slice(i + marca.length)))
    ids.push(fila.id)
  }

  console.log(`\nmensajes con archivo anteriores al corte: ${urls.length}`)
  console.log(`  de ellos, en el bucket del chat (borrables): ${rutas.length}`)

  if (rutas.length === 0) {
    console.log('\nNada que limpiar.')
    return
  }

  if (!APLICAR) {
    console.log(`\nNada se borró. Para hacerlo: npm run limpiar-media -- --meses ${MESES} --aplicar`)
    return
  }

  // De a 200: `remove()` con miles de nombres de una vez devuelve 502.
  let borrados = 0
  for (let i = 0; i < rutas.length; i += 200) {
    const lote = rutas.slice(i, i + 200)
    const { error } = await supabase.storage.from(config.chatMediaBucket).remove(lote)
    if (error) throw error

    // Se limpia `media_url` de esos mensajes en el MISMO paso: dejar la URL
    // apuntando a un archivo borrado le mostraría al equipo una foto rota,
    // que es peor que decir claramente "archivo no guardado".
    const loteIds = ids.slice(i, i + 200)
    const { error: errorUpdate } = await supabase
      .from('agent_messages')
      .update({ media_url: null })
      .in('id', loteIds)
    if (errorUpdate) throw errorUpdate

    borrados += lote.length
    process.stdout.write(`\r  borrados: ${borrados}/${rutas.length}`)
  }

  console.log(`\n\nListo. Se liberaron ${borrados} archivo(s) de más de ${MESES} meses.`)
  console.log('Los mensajes siguen en la conversación; solo se soltó el archivo.')
}

main().catch((err) => {
  console.error('Falló la limpieza de media:', err)
  process.exitCode = 1
})
