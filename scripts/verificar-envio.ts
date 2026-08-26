/**
 * Comprueba que la base esté lista para responderle al cliente desde el
 * ERP con fotos y productos del catálogo (migraciones 0026 y 0027).
 *
 * Existe porque las migraciones de este proyecto se aplican A MANO en
 * Supabase: sin esto, la primera señal de que falta aplicar una es que
 * alguien intenta mandarle una foto a un cliente y no pasa nada.
 *
 * No manda ningún mensaje ni escribe nada: solo lee. Se puede correr
 * cuando sea.
 *
 * Uso: npm run verificar-envio
 */
import { config } from '../src/config.js'
import { supabase } from '../src/supabaseClient.js'

type Resultado = { ok: boolean; nombre: string; detalle: string; arreglo?: string }

const resultados: Resultado[] = []

function anotar(r: Resultado): void {
  resultados.push(r)
  console.log(`${r.ok ? ' OK  ' : 'FALTA'}  ${r.nombre}${r.ok ? '' : ` -- ${r.detalle}`}`)
}

/**
 * Pide las columnas con `limit(0)`: si alguna no existe, PostgREST
 * responde 42703 y sabemos exactamente cuál falta, sin traer datos.
 */
async function verificarColumnas(tabla: string, columnas: string, arreglo: string): Promise<void> {
  const { error } = await supabase.from(tabla).select(columnas).limit(0)
  anotar({
    ok: !error,
    nombre: `${tabla} (${columnas})`,
    detalle: error?.message ?? '',
    arreglo,
  })
}

async function verificarBucket(): Promise<void> {
  const { data, error } = await supabase.storage.getBucket(config.chatMediaBucket)
  if (error || !data) {
    anotar({
      ok: false,
      nombre: `bucket "${config.chatMediaBucket}"`,
      detalle: error?.message ?? 'no existe',
      arreglo: 'Aplicá la migración 0026 (crea el bucket) o creálo a mano en Storage, marcado como público.',
    })
    return
  }

  // Tiene que ser PÚBLICO: quien descarga la foto para mandarla es
  // WhatsApp, y una URL firmada que vence rompe el envío si el mensaje se
  // queda un rato en la cola.
  anotar({
    ok: data.public === true,
    nombre: `bucket "${config.chatMediaBucket}" es público`,
    detalle: 'existe pero es privado: WhatsApp no va a poder descargar las fotos',
    arreglo: 'En Supabase > Storage > el bucket > Settings, marcalo como público.',
  })
}

console.log('Verificando que se pueda responder desde el ERP (no se envía nada).\n')

await verificarColumnas(
  'agent_outbox',
  'kind, media_url, media_mime, media_filename, product_id, sent_message_id',
  'Aplicá supabase/migrations/0026_agent_outbox_media.sql.',
)
await verificarColumnas('agent_messages', 'media_url', 'Aplicá supabase/migrations/0026_agent_outbox_media.sql.')
await verificarColumnas('agent_quick_replies', 'id, label, body', 'Aplicá supabase/migrations/0026_agent_outbox_media.sql.')
await verificarColumnas(
  'agent_settings',
  'agent_last_seen_at, agent_connection, agent_outbound_mode',
  'Aplicá supabase/migrations/0027_agent_heartbeat.sql.',
)
await verificarBucket()

// El freno de salida no es un error de instalación, pero es LA razón más
// común de que un mensaje encolado nunca salga: se avisa igual.
console.log('')
if (config.outboundMode === 'full') {
  console.log(' OK    OUTBOUND_MODE=full: el agente responde solo y también manda lo del ERP.')
} else if (config.outboundMode === 'erp_only') {
  console.log(' OK    OUTBOUND_MODE=erp_only: sale lo que escribe una persona desde el ERP; el bot no contesta solo.')
} else {
  console.log('AVISO  OUTBOUND_MODE=blocked: NO sale nada, ni siquiera lo que se escriba desde el ERP.')
  console.log('       Cambialo a erp_only (o full) en el .env del agente cuando quieras empezar a responder.')
}

const faltan = resultados.filter((r) => !r.ok)
console.log('')
if (faltan.length === 0) {
  console.log('Todo listo: el ERP puede mandar texto, fotos, archivos y productos del catálogo.')
  process.exit(0)
}

console.log(`Falta${faltan.length === 1 ? '' : 'n'} ${faltan.length} cosa${faltan.length === 1 ? '' : 's'}:`)
for (const r of faltan) console.log(`  - ${r.nombre}: ${r.arreglo}`)
process.exit(1)
