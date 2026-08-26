/**
 * Borra del respaldo de sesión los archivos que WhatsApp reconstruye solo.
 *
 * `lid-mapping-*` (equivalencia LID<->teléfono) y `tctoken-*` (tokens de
 * contacto) se vuelven a aprender de los mensajes que van llegando. No
 * hacen falta para autenticar la sesión ni para descifrar nada -- eso lo
 * hacen `creds.json`, las `app-state-sync-key-*`, las `pre-key-*`, las
 * `session-*` y las `identity-*`, que este script NUNCA toca.
 *
 * Por qué limpiarlos: son el 97% del respaldo (se midieron 29.277
 * lid-mapping y 6.984 tctoken contra ~1.050 archivos que sí importan). El
 * agente ya dejó de subirlos, pero los que se acumularon siguen ahí, y
 * restaurar la sesión en una máquina nueva significaría bajar 37.000
 * archivos en vez de 1.000.
 *
 * Es seguro correrlo con el agente andando: son archivos que el proceso no
 * vuelve a subir y que WhatsApp regenera.
 *
 * Uso:
 *   npm run limpiar-respaldo              -> solo cuenta qué borraría
 *   npm run limpiar-respaldo -- --aplicar -> lo borra
 */
import { config } from '../src/config.js'
import { supabase } from '../src/supabaseClient.js'

const APLICAR = process.argv.includes('--aplicar')
const BUCKET = config.authBackupBucket

/** Lo que se puede borrar: caché que WhatsApp vuelve a construir. */
function esRegenerable(nombre: string): boolean {
  return nombre.startsWith('lid-mapping-') || nombre.startsWith('tctoken-')
}

async function main(): Promise<void> {
  console.log(`Revisando el bucket "${BUCKET}"...`)

  const regenerables: string[] = []
  let total = 0
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.storage.from(BUCKET).list('', { limit: 1000, offset })
    if (error) throw error
    if (!data || data.length === 0) break
    total += data.length
    for (const f of data) if (esRegenerable(f.name)) regenerables.push(f.name)
    if (data.length < 1000) break
  }

  const seQuedan = total - regenerables.length
  console.log(`\nArchivos en el respaldo: ${total}`)
  console.log(`  regenerables (se pueden borrar): ${regenerables.length}`)
  console.log(`  de la sesión (NO se tocan):      ${seQuedan}`)

  if (regenerables.length === 0) {
    console.log('\nNada que limpiar.')
    return
  }

  // Sin creds.json el respaldo no sirve para nada. Si no está, algo raro
  // pasa y no es momento de andar borrando.
  if (seQuedan === 0) {
    console.log('\nEl respaldo NO tiene archivos de sesión. No se borra nada: revisá el bucket a mano.')
    process.exit(1)
  }

  if (!APLICAR) {
    console.log('\nNada se borró. Para hacerlo: npm run limpiar-respaldo -- --aplicar')
    return
  }

  // De a 200: `remove()` con miles de nombres de una vez devuelve 502.
  let borrados = 0
  for (let i = 0; i < regenerables.length; i += 200) {
    const lote = regenerables.slice(i, i + 200)
    const { error } = await supabase.storage.from(BUCKET).remove(lote)
    if (error) throw error
    borrados += lote.length
    process.stdout.write(`\r  borrados: ${borrados}/${regenerables.length}`)
  }

  console.log(`\n\nListo. El respaldo quedó en ${seQuedan} archivos (era ${total}).`)
  console.log('La sesión sigue intacta: solo se borró caché que WhatsApp reconstruye.')
}

main().catch((err) => {
  console.error('Falló la limpieza del respaldo:', err)
  process.exit(1)
})
