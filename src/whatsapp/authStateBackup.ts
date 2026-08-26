import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { supabase } from '../supabaseClient.js'

const BUCKET = config.authBackupBucket

// `list()` de Supabase Storage devuelve 100 archivos por defecto. El
// auth-state de Baileys pasa fácil los 400 archivos (una clave de sync
// por chat), así que sin paginar se restauraba una sesión INCOMPLETA --
// pasó en vivo: quedaron 407 archivos sin borrar en una limpieza y el
// proceso restauró credenciales viejas ya invalidadas, dando "sesión
// cerrada desde el teléfono" en loop.
const LIST_PAGE_SIZE = 1000

async function listAllBackupFiles(): Promise<string[]> {
  const names: string[] = []
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await supabase.storage.from(BUCKET).list('', { limit: LIST_PAGE_SIZE, offset })
    if (error) throw error
    if (!data || data.length === 0) break
    names.push(...data.map((f) => f.name))
    if (data.length < LIST_PAGE_SIZE) break
  }
  return names
}

/**
 * Qué archivo se subió y con qué fecha de modificación. Sirve para no
 * volver a subir lo que no cambió.
 *
 * Se guarda en disco porque el auth-state es enorme: con la sesión
 * vinculada y el historial sincronizado se midieron 36.936 archivos (una
 * clave de sesión por cada chat). Si el registro viviera solo en memoria,
 * cada reinicio del proceso re-subiría los 36.936 de nuevo.
 *
 * Va FUERA de `auth_state/` a propósito: esa carpeta se copia tal cual al
 * restaurar, y un manifiesto de otra máquina ahí adentro haría creer que
 * ya está todo respaldado cuando el bucket está vacío.
 */
const yaRespaldados = new Map<string, number>()

const MANIFIESTO = path.resolve('.auth-backup-manifest.json')

/**
 * Siempre se re-suben, sin importar lo que diga el manifiesto: son pocos
 * y son los que de verdad definen la sesión. Si alguno quedara viejo en
 * el bucket, la restauración daría una sesión que WhatsApp rechaza.
 */
function esCritico(file: string): boolean {
  return file === 'creds.json' || file.startsWith('app-state-sync-key-')
}

/**
 * Caché que WhatsApp reconstruye solo, y que NO se respalda.
 *
 * `lid-mapping-*` es la equivalencia LID<->teléfono y `tctoken-*` son
 * tokens de contacto: los dos se vuelven a aprender de los mensajes que
 * van llegando. No hacen falta para autenticar la sesión ni para descifrar
 * nada (eso lo hacen creds, las app-state-sync-key, las pre-key, las
 * session y las identity, que sí se respaldan).
 *
 * Se excluyen porque son el 97% del auth-state: se midieron 29.277
 * `lid-mapping` y 6.984 `tctoken` contra ~1.050 archivos que sí importan.
 * Respaldarlos significaba miles de subidas y, al restaurar, 37.000
 * descargas -- puro consumo de cuota de Supabase para recuperar algo que
 * WhatsApp regala de nuevo en unos minutos de uso.
 */
function esCacheRegenerable(file: string): boolean {
  return file.startsWith('lid-mapping-') || file.startsWith('tctoken-')
}

async function cargarManifiesto(mtimesLocales: Map<string, number>): Promise<void> {
  if (yaRespaldados.size > 0) return
  try {
    const crudo = await readFile(MANIFIESTO, 'utf-8')
    for (const [file, mtime] of Object.entries(JSON.parse(crudo) as Record<string, number>)) {
      yaRespaldados.set(file, mtime)
    }
    return
  } catch {
    // No existe (primer arranque con esta versión) o quedó ilegible.
  }

  // Sin manifiesto, se siembra con lo que YA está en el bucket en vez de
  // re-subir el auth-state entero: son decenas de miles de archivos y
  // volver a subirlos es justo lo que saturaba el Storage.
  //
  // Se anota el mtime LOCAL de cada uno: si el archivo no cambió, coincide
  // y no se re-sube; si cambia más adelante, deja de coincidir y se sube
  // como cualquier otro. Los críticos quedan afuera para que se suban de
  // todos modos.
  try {
    const enBucket = await listAllBackupFiles()
    let sembrados = 0
    for (const file of enBucket) {
      const mtime = mtimesLocales.get(file)
      if (mtime === undefined || esCritico(file)) continue
      yaRespaldados.set(file, mtime)
      sembrados++
    }
    if (sembrados > 0) console.log(`Respaldo: ${sembrados} archivo(s) ya estaban en el bucket, no se vuelven a subir.`)
  } catch (err) {
    console.warn('No se pudo leer el bucket para sembrar el manifiesto (se respaldará todo):', err)
  }
}

async function guardarManifiesto(): Promise<void> {
  try {
    await writeFile(MANIFIESTO, JSON.stringify(Object.fromEntries(yaRespaldados)))
  } catch (err) {
    // Perder el manifiesto solo cuesta una re-subida, no la sesión.
    console.warn('No se pudo guardar el manifiesto de respaldo:', err)
  }
}

/** Subidas en paralelo. Bajo a propósito: ver el comentario de abajo. */
const EN_PARALELO = 5
/**
 * Bajadas en paralelo. Más alto que las subidas porque una descarga pesa
 * mucho menos en Storage que una escritura, y acá el volumen es otro: la
 * restauración baja el auth-state ENTERO (37.000+ archivos) de una sola
 * vez, mientras que un respaldo sube uno o dos.
 */
const BAJADAS_EN_PARALELO = 20
const REINTENTOS = 3

async function subirConReintento(localDir: string, file: string): Promise<void> {
  for (let intento = 1; ; intento++) {
    const content = await readFile(path.join(localDir, file))
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(file, content, { upsert: true, contentType: 'application/json' })
    if (!error) return
    if (intento >= REINTENTOS) throw error
    // Storage devuelve 502/503 cuando se lo satura; esperar y reintentar
    // resuelve la mayoría sin perder el respaldo.
    await new Promise((r) => setTimeout(r, 500 * 2 ** (intento - 1)))
  }
}

/**
 * Sube al bucket privado de Supabase Storage los archivos del auth-state
 * QUE HAYAN CAMBIADO desde el último respaldo. Se llama con debounce
 * después de cada creds.update, para que si el VPS se pierde no haya que
 * volver a escanear el QR.
 *
 * Antes subía los archivos de a uno y TODOS en cada vuelta. Con una
 * sesión vinculada de verdad eso son ~2300 archivos (una clave de sync
 * por chat) cada pocos segundos: se midió en vivo una racha de
 * `StorageApiError: Bad Gateway` -- o sea, el respaldo no se estaba
 * guardando, que es justo el escenario que este módulo existe para
 * evitar. En régimen normal cambian uno o dos archivos por vuelta, así
 * que con esto se suben esos y nada más.
 */
export async function backupAuthState(localDir: string): Promise<void> {
  const files = await readdir(localDir)

  // La caché regenerable ni se mira: son ~36.000 archivos y hacerles
  // `stat` en cada respaldo es trabajo puro al pedo (ver esCacheRegenerable).
  const respaldables = files.filter((f) => !esCacheRegenerable(f))

  const mtimesLocales = new Map<string, number>()
  for (const file of respaldables) {
    const { mtimeMs } = await stat(path.join(localDir, file))
    mtimesLocales.set(file, mtimeMs)
  }

  await cargarManifiesto(mtimesLocales)

  const pendientes: Array<{ file: string; mtimeMs: number }> = []
  for (const [file, mtimeMs] of mtimesLocales) {
    if (yaRespaldados.get(file) === mtimeMs) continue
    pendientes.push({ file, mtimeMs })
  }
  if (pendientes.length === 0) return

  let siguiente = 0
  const trabajador = async (): Promise<void> => {
    while (siguiente < pendientes.length) {
      const item = pendientes[siguiente++]
      await subirConReintento(localDir, item.file)
      // Se marca DESPUÉS de subir: si falla, queda pendiente para la
      // próxima vuelta en vez de darse por respaldado.
      yaRespaldados.set(item.file, item.mtimeMs)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(EN_PARALELO, pendientes.length) }, trabajador))
  } finally {
    // Se guarda incluso si una subida falló: lo que sí subió no tiene por
    // qué volver a subirse en la próxima vuelta.
    await guardarManifiesto()
  }

  console.log(`Auth-state respaldado: ${pendientes.length} archivo(s) subido(s) de ${respaldables.length}.`)
}

/**
 * Restaura la sesión desde el respaldo, pero SOLO si no hay ya una sesión
 * local -- nunca pisa un auth-state que ya esté activo en este disco.
 */
export async function restoreAuthState(localDir: string): Promise<void> {
  await mkdir(localDir, { recursive: true })

  const existing = await readdir(localDir)
  if (existing.length > 0) return

  let files: string[]
  try {
    files = await listAllBackupFiles()
  } catch (err) {
    console.warn(`No se pudo listar el respaldo de sesión (bucket "${BUCKET}"):`, err)
    return
  }
  if (files.length === 0) return

  // Sin creds.json el resto del auth-state no sirve para nada -- restaurar
  // solo las claves de sync deja una sesión rota que WhatsApp rechaza.
  if (!files.includes('creds.json')) {
    console.warn(`El respaldo no tiene creds.json (${files.length} archivos sueltos): se ignora y se pedirá QR nuevo.`)
    return
  }

  // Se baja a una carpeta APARTE y recién al terminar se pone en su
  // lugar. Antes se escribía directo en `auth_state/`: si la restauración
  // se cortaba a la mitad (se cae la red, se para el proceso), la carpeta
  // quedaba con archivos sueltos y el arranque siguiente veía "ya hay
  // sesión" -- el `return` de arriba -- y salía a conectarse con un
  // auth-state incompleto, que WhatsApp rechaza. Un rename de carpeta es
  // atómico: o está entera o no está.
  const parcial = `${localDir}.parcial`
  await rm(parcial, { recursive: true, force: true })
  await mkdir(parcial, { recursive: true })

  console.log(`Restaurando la sesión de WhatsApp desde el respaldo (${files.length} archivos)...`)

  // En paralelo: con la sesión en uso el auth-state pasa los 37.000
  // archivos (una clave por chat), y de a uno la restauración tardaba
  // horas -- o sea que el respaldo no servía justo para lo que existe,
  // levantar el bot en una máquina nueva sin re-escanear el QR.
  let siguiente = 0
  let fallidos = 0
  const trabajador = async (): Promise<void> => {
    while (siguiente < files.length) {
      const name = files[siguiente++]
      const { data, error: downloadError } = await supabase.storage.from(BUCKET).download(name)
      if (downloadError || !data) {
        // Una clave de sesión suelta que no baje solo cuesta re-negociar
        // el cifrado con ESE chat. Sin creds.json, en cambio, no hay
        // sesión -- por eso abajo se corta si justo faltó ese.
        fallidos++
        console.warn(`No se pudo descargar ${name} del respaldo: ${downloadError?.message}`)
        continue
      }
      await writeFile(path.join(parcial, name), Buffer.from(await data.arrayBuffer()))
    }
  }
  await Promise.all(Array.from({ length: Math.min(BAJADAS_EN_PARALELO, files.length) }, trabajador))

  // Sin creds.json lo restaurado no sirve: mejor dejar la carpeta vacía y
  // pedir QR que arrancar con una sesión que WhatsApp va a rechazar.
  try {
    await stat(path.join(parcial, 'creds.json'))
  } catch {
    await rm(parcial, { recursive: true, force: true })
    console.warn('La restauración falló justo en creds.json: se descarta y se pedirá QR nuevo.')
    return
  }

  // `localDir` lo creó el mkdir del principio y está vacío (se comprobó
  // arriba); hay que sacarlo para poder poner la carpeta restaurada.
  await rm(localDir, { recursive: true, force: true })
  await rename(parcial, localDir)

  console.log(
    `Sesión de WhatsApp restaurada desde el respaldo (${files.length - fallidos} de ${files.length} archivos).`,
  )
}
