import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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
 * Sube todos los archivos del auth-state local al bucket privado de
 * Supabase Storage. Se llama con debounce después de cada creds.update,
 * para que si el VPS se pierde no haya que volver a escanear el QR --
 * basta con levantar el proceso en una máquina nueva y restaurar.
 */
export async function backupAuthState(localDir: string): Promise<void> {
  const files = await readdir(localDir)

  for (const file of files) {
    const content = await readFile(path.join(localDir, file))
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(file, content, { upsert: true, contentType: 'application/json' })
    if (error) throw error
  }
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

  for (const name of files) {
    const { data, error: downloadError } = await supabase.storage.from(BUCKET).download(name)
    if (downloadError || !data) {
      console.warn(`No se pudo descargar ${name} del respaldo: ${downloadError?.message}`)
      continue
    }
    const buffer = Buffer.from(await data.arrayBuffer())
    await writeFile(path.join(localDir, name), buffer)
  }

  console.log(`Sesión de WhatsApp restaurada desde el respaldo (${files.length} archivos).`)
}
