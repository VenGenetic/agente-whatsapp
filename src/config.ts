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
  baileysLogLevel: process.env.BAILEYS_LOG_LEVEL ?? 'warn',
}
