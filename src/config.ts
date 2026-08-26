import 'dotenv/config'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name} (revisá .env contra .env.example)`)
  }
  return value
}

export const config = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  geminiApiKey: required('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
  businessName: process.env.BUSINESS_NAME ?? 'el negocio',
  // Número (con código de país, sin '+' ni espacios, ej. 593987654321) al
  // que el bot avisa por WhatsApp cada vez que escala una conversación.
  ownerPhoneNumber: required('OWNER_PHONE_NUMBER'),
  // Debajo de este score de similitud (0-1), un match no cuenta como
  // "encontrado" -- se trata como que el producto no existe en catálogo.
  matchConfidenceThreshold: Number(process.env.MATCH_CONFIDENCE_THRESHOLD ?? '0.3'),
  // Hora (0-23, horario de Ecuador) en la que se manda el resumen diario
  // de huecos (búsquedas sin resultado + escalamientos) al dueño.
  gapsReportHour: Number(process.env.GAPS_REPORT_HOUR ?? '8'),
  // Apagalo durante pruebas (DEMAND_REGISTRATION_ENABLED=false en .env)
  // para que las conversaciones de prueba no ensucien product_demands con
  // demandas falsas -- el bot sigue respondiendo normal, solo no anota.
  demandRegistrationEnabled: process.env.DEMAND_REGISTRATION_ENABLED !== 'false',
  // Interruptor general: en false, el bot registra mensajes entrantes pero
  // NO contesta nada (ni normal, ni escalamiento, ni Gemini) -- para poder
  // reconectar la sesión de WhatsApp sin riesgo mientras se sigue
  // probando/ajustando. Poner en true recién cuando esté listo para ir en vivo.
  // Freno de emergencia a nivel servidor. El interruptor normal del
  // agente vive en la base (`agent_settings`) y se maneja desde el ERP;
  // esto solo existe para poder cortar todo de raíz sin depender del ERP.
  botKillSwitch: process.env.BOT_KILL_SWITCH === 'true',
  // A quién puede escribirle el agente. Se aplica en el socket mismo, así
  // que cubre TODOS los caminos de salida -- no solo las respuestas
  // automáticas (ver whatsapp/outboundGuard.ts).
  //
  //   blocked  -> ningún cliente recibe nada (solo avisos al dueño).
  //   erp_only -> los clientes solo reciben lo que una persona escribe
  //               a mano desde el ERP; el agente no contesta solo.
  //   full     -> el agente trabaja normal.
  //
  // El default es `blocked` A PROPÓSITO: si la variable falta o está mal
  // escrita, el sistema se queda callado en vez de escribirle a clientes
  // reales. Un default permisivo acá manda mensajes que no se pueden
  // deshacer.
  outboundMode: (['blocked', 'erp_only', 'full'] as const).includes(process.env.OUTBOUND_MODE as never)
    ? (process.env.OUTBOUND_MODE as 'blocked' | 'erp_only' | 'full')
    : 'blocked',
  // 'intake': el bot SOLO le saca datos al cliente (repuesto, marca,
  // modelo, año, color si aplica) y pasa la conversación a un humano --
  // nunca consulta el catálogo ni dice precio/stock/fotos.
  // 'full': el flujo completo (busca en el catálogo y cotiza).
  agentMode: process.env.AGENT_MODE === 'full' ? 'full' : 'intake',
  // Desde qué fecha guardar los mensajes que trae el history sync de
  // WhatsApp al vincular (formato YYYY-MM-DD). Sin esto, no se importa
  // historial -- solo se registran los mensajes nuevos.
  historyImportSince: process.env.HISTORY_IMPORT_SINCE ? new Date(process.env.HISTORY_IMPORT_SINCE) : null,
  // Cuántos chats "arranca" el agente por vuelta (cada 60s). Deliberadamente
  // bajo: mandar mensajes no solicitados en ráfaga es lo que hizo que
  // WhatsApp restringiera el número una vez. Subilo con cuidado.
  proactiveIntakeBatchSize: Number(process.env.PROACTIVE_INTAKE_BATCH_SIZE ?? '1'),
  authStateDir: process.env.AUTH_STATE_DIR ?? './auth_state',
  authBackupBucket: process.env.AUTH_BACKUP_BUCKET ?? 'agent_whatsapp_session',
  // Bucket PÚBLICO con la media del chat: la foto que manda el cliente y
  // lo que el equipo adjunta desde el ERP. Público porque WhatsApp
  // descarga el archivo por URL cuando lo enviamos (ver migración 0026).
  chatMediaBucket: process.env.CHAT_MEDIA_BUCKET ?? 'agent_chat_media',
  // Guardar en Storage la media que entra. Se puede apagar
  // (CHAT_MEDIA_CAPTURE=false) si el bucket se llena: el mensaje se sigue
  // registrando, solo que sin la foto.
  chatMediaCaptureEnabled: process.env.CHAT_MEDIA_CAPTURE !== 'false',
  // Tope por archivo, POR TIPO. Se midió el consumo real: las fotos pesan
  // 124 KB de media y los audios 27 KB, pero un video promedia 3,9 MB --
  // siendo el 3% de los archivos, los videos son el 57% del crecimiento
  // del Storage. Y en repuestos el pedido llega como foto de la pieza o
  // como nota de voz, casi nunca como video.
  //
  // Por eso el video tiene su propio tope, mucho más bajo: el mensaje se
  // registra igual, solo que sin el archivo.
  chatMediaMaxMb: Number(process.env.CHAT_MEDIA_MAX_MB ?? '8'),
  chatMediaMaxVideoMb: Number(process.env.CHAT_MEDIA_MAX_VIDEO_MB ?? '3'),
  baileysLogLevel: process.env.BAILEYS_LOG_LEVEL ?? 'warn',
}
