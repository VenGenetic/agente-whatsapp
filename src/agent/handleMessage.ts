import type { WAMessage, WASocket } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import {
  type ActionTaken,
  type AgenteQueEscribe,
  activateConversationForIntake,
  getConversationState,
  getRecentHistory,
  lastReplyWasClarification,
  logInboundMessage,
  logOutboundMessage,
  setConversationStatus,
  upsertConversation,
  type HistoryTurn,
} from '../db/conversations.js'
import { registerLostDemand, registerProductDemand } from '../db/demands.js'
import { agentesEncendidos, isBotAutoReplyEnabled, puedeResponderAhora, type AgentesEncendidos } from '../db/settings.js'
import { cambiarEtapa, etapaCerrada, etapaDe, type Etapa } from '../db/etapas.js'
import { guardarBorrador, marcarFichaLista, type FichaDeRecepcion } from '../db/fichaDeRecepcion.js'
import { createEscalation, type EscalationReason } from '../db/escalations.js'
import { interpretMessage, type InterpretedItem, type InterpretResult } from '../gemini/interpret.js'
import { runIntake } from './intake.js'
import { buscarCatalogoParaRecepcion, resumenParaElVendedor, resumenParaElVendedorConCatalogo } from './intakeHandoff.js'
import { nombreDePila } from './nombreDelCliente.js'
import { isAutoActivationMessage } from './autoActivation.js'
import { esDesistimiento, RESPUESTA_DE_DESISTIMIENTO } from './cierreDeConversacion.js'
import { correspondeSaludar, textoDeSaludo } from './saludos.js'
import { encolarParaProcesar, mediaDeLaRafaga, textoDeLaRafaga, type MensajeEnRafaga } from './messageBuffer.js'
import { draftReply } from '../gemini/respond.js'
import {
  applyModelDefault,
  detectCatalogModels,
  detectKnownModels,
  findModelDisambiguation,
  getKnownModels,
  getModelDefaults,
  getModelDisambiguations,
} from '../matching/knownModels.js'
import { findProductMatches } from '../matching/searchProducts.js'
import { extractColor, mentionsColor, stripColor } from '../utils/colors.js'
import { humanDelay } from '../utils/humanDelay.js'
import { toWhatsAppJid } from '../utils/phone.js'
import { roundedCustomerPrice } from '../utils/pricing.js'
import { sendTextOrPhoto } from '../utils/sendTextOrPhoto.js'
import { withTimeout } from '../utils/withTimeout.js'
import { mostrarEscribiendo } from './outboxActions.js'
import { capturarMediaEnSegundoPlano } from '../whatsapp/inboundMedia.js'
import { downloadMediaAsBase64 } from '../whatsapp/media.js'
import { parseIncomingMessage } from '../whatsapp/parseMessage.js'

// Presupuesto total para procesar UN mensaje, de punta a punta (descarga de
// media, Gemini, búsqueda en la base, envío). Cubre cuelgues en cualquier
// paso, no solo en las llamadas a Gemini -- que ya tienen su propio timeout
// más corto, pero un cuelgue en otro punto (ej. una consulta a Supabase)
// también debe terminar disparando el fallback en vez de dejar al cliente
// sin respuesta para siempre.
// Un mensaje puede pedir varios repuestos a la vez -- cada uno llama al
// redactor por separado, además del intérprete una sola vez para todo el
// mensaje. Cada llamada a Gemini son hasta tres intentos de 40s (40 + 1,5
// + 40 + 1,5 + 40 = ~123s en el peor caso), así que el presupuesto tiene
// que cubrir el intérprete más hasta MAX_ITEMS_PER_MESSAGE redactores sin
// cortar un reintento a mitad de camino.
//
// Ojo con leerlo mal: esto NO es lo que se le hace esperar al cliente, es
// un detector de cuelgues. La mediana real de un mensaje es de 5 a 10
// segundos; este techo existe para que un proceso trabado termine
// disparando el fallback en vez de dejar la conversación muda para
// siempre.
const MAX_ITEMS_PER_MESSAGE = 3
// La rÃ¡faga consume unos segundos, pero el proceso entero no puede usar
// el mismo límite corto: Gemini suele responder en 4-8s y tiene picos
// reales de 25-41s. Con 11s se convertían respuestas válidas en el
// fallback técnico "se me complicó" y se escalaban chats sin necesidad.
// 65s cubre esos picos y todavía corta una dependencia realmente colgada.
const PROCESS_MESSAGE_TIMEOUT_MS = 65000

const EMPTY_ITEM: InterpretedItem = { searchQuery: null, brandMentioned: null, vehicleContext: null, quantity: 1 }

/**
 * Combina search_query con brand_mentioned/vehicle_context -- el
 * intérprete a veces pone el modelo SOLO en vehicle_context aunque
 * search_query ya tenga otra cosa (ver docs/system-prompts.md). Dedupea
 * palabra por palabra (sin importar mayúsculas) para no repetir el modelo
 * dos veces cuando ya está en ambos campos.
 */
function buildSearchQuery(item: InterpretedItem): string | null {
  const parts = [item.searchQuery, item.brandMentioned, item.vehicleContext].filter(
    (v): v is string => !!v && v.trim().length > 0,
  )
  if (parts.length === 0) return null

  const seen = new Set<string>()
  const words: string[] = []
  for (const part of parts) {
    for (const word of part.trim().split(/\s+/)) {
      const key = word.toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      words.push(word)
    }
  }
  return words.join(' ')
}

function mapEscalationReason(reason: InterpretResult['escalationReason']): EscalationReason {
  switch (reason) {
    case 'discount_request':
      return 'discount_request'
    case 'complaint_or_return':
      return 'complaint_or_return'
    case 'ambiguous':
      return 'ambiguous_after_retries'
    case 'angry_or_urgent':
      return 'angry_or_urgent'
    default:
      return 'other'
  }
}

/**
 * Quién contesta este mensaje. Es el ÚNICO lugar del sistema donde se
 * decide, y por eso dos agentes no pueden hablar a la vez ni aunque los
 * dos estén encendidos.
 *
 * Antes era un `if (config.agentMode === 'intake')` a mitad de
 * `processMessage`: global, con reinicio del proceso, y sin forma de
 * expresar el estado real del negocio, que es "recepción automática +
 * vendedor humano".
 *
 * El caso `null` -- que no conteste nadie -- es deliberado y no un
 * agujero: ante la duda es mejor que el chat quede visible en la bandeja
 * esperando a una persona, que mandarle al cliente algo inventado.
 */
export function decidirAgente(
  etapa: Etapa | null,
  encendidos: AgentesEncendidos,
  seleccionado: 'intake' | 'sales' | null = null,
): 'intake' | 'sales' | null {
  // Ya la tiene una persona, o la conversación terminó.
  if (etapaCerrada(etapa)) return null

  // La eleccion es por conversacion. No se adivina un agente cuando el
  // ERP activa el chat sin guardar cual debe atenderlo.
  if (!seleccionado) return null
  if (seleccionado === 'sales') return encendidos.ventas ? 'sales' : null

  // La recepción ya hizo lo suyo: de acá en adelante es trabajo del
  // vendedor. Si el vendedor está apagado, no contesta nadie -- que es
  // justamente el punto de partida buscado: la ficha queda lista y la
  // atiende una persona.
  if (etapa === 'ready_for_sales' || etapa === 'sales_in_progress') {
    return null
  }

  return encendidos.recepcion ? 'intake' : null
}

/**
 * La decisión de arriba, con los interruptores leídos de la base.
 *
 * Está separada de `decidirAgente` para poder probar la regla sin base ni
 * WhatsApp (npm run verificar-recepcion): es la función que decide si a un
 * cliente le llega o no un mensaje, y esa no puede quedar sin cubrir.
 */
async function elegirAgente(
  etapa: Etapa | null,
  seleccionado: 'intake' | 'sales' | null,
): Promise<'intake' | 'sales' | null> {
  // Sin la migración 0035 no hay interruptores en la base: se usa
  // AGENT_MODE, o sea exactamente el comportamiento anterior.
  const encendidos = await agentesEncendidos({
    recepcion: config.agentMode === 'intake',
    ventas: config.agentMode === 'full',
  })
  return decidirAgente(etapa, encendidos, seleccionado)
}

async function sendAndLog(
  sock: WASocket,
  conversationId: number,
  chatJid: string,
  text: string,
  extra: {
    productId?: number | null
    matchConfidence?: number | null
    actionTaken: ActionTaken
    /** Cuál de los dos agentes lo escribió. Ver migración 0035. */
    agent?: AgenteQueEscribe
  },
): Promise<void> {
  await humanDelay()
  const agente = extra.agent === 'intake' ? 'intake' : 'sales'
  if (!(await puedeResponderAhora(conversationId, agente, { permitirEscalado: extra.actionTaken === 'escalated' }))) {
    console.log(`Respuesta ${extra.actionTaken} cancelada: el permiso del chat #${conversationId} cambio mientras se procesaba.`)
    return
  }
  const sent = await sock.sendMessage(chatJid, { text })
  await logOutboundMessage(conversationId, { body: text, whatsappMessageId: sent?.key?.id ?? null, ...extra })
}

async function sendProductPhotoAndLog(
  sock: WASocket,
  conversationId: number,
  chatJid: string,
  text: string,
  imageUrl: string | null,
  productId: number,
  matchConfidence: number,
): Promise<void> {
  await humanDelay()
  if (!(await puedeResponderAhora(conversationId, 'sales'))) {
    console.log(`Foto/respuesta cancelada: el permiso del chat #${conversationId} cambio mientras se procesaba.`)
    return
  }
  const sentId = await sendTextOrPhoto(sock, chatJid, text, imageUrl)
  await logOutboundMessage(conversationId, {
    body: text,
    productId,
    matchConfidence,
    actionTaken: 'answered_in_stock',
    whatsappMessageId: sentId,
  })
}

async function notifyOwner(sock: WASocket, customerPhone: string, reason: EscalationReason, snapshot: string): Promise<void> {
  const text = [
    'Se escaló una conversación de WhatsApp.',
    `Motivo: ${reason}`,
    `Cliente: ${customerPhone}`,
    `Último mensaje: "${snapshot}"`,
  ].join('\n')
  await sock.sendMessage(toWhatsAppJid(config.ownerPhoneNumber), { text })
}

/**
 * Cuando el mensaje mezcla un pedido de producto (u otra cosa que ya se
 * procesa normal) CON una pregunta general del negocio, el bot sigue
 * respondiendo lo suyo solo -- esto NO escala ni cambia el estado de la
 * conversación, solo le avisa al dueño que quedó algo del negocio sin
 * contestar, para que no se pierda silenciosamente.
 */
async function notifyOwnerOfGeneralQuestion(sock: WASocket, customerPhone: string, customerMessage: string): Promise<void> {
  const text = [
    'El cliente mezcló una pregunta del negocio (pago/envío/horario/garantía) en un mensaje de WhatsApp.',
    `Cliente: ${customerPhone}`,
    `Mensaje: "${customerMessage}"`,
  ].join('\n')
  await sock.sendMessage(toWhatsAppJid(config.ownerPhoneNumber), { text })
}

async function escalate(
  sock: WASocket,
  conversationId: number,
  phoneNumber: string,
  chatJid: string,
  reason: EscalationReason,
  history: HistoryTurn[],
  customerMessage: string,
  options?: {
    instruction?: string
    ownerContext?: string
    agent?: AgenteQueEscribe
    /**
     * A qué etapa queda. El default es `human_assigned` porque escalar
     * es, por definición, pasarle el chat a una persona -- la excepción
     * es la recepción terminada bien, que queda `ready_for_sales`.
     *
     * Va acá adentro y no en cada llamador a propósito: hay seis caminos
     * que escalan (queja, descuento, pregunta del negocio, seguimiento de
     * pedido, falla técnica, recepción lista) y uno que se olvide de
     * mover la etapa deja un chat esperando a alguien sin que se note en
     * la bandeja.
     */
    etapa?: Etapa
  },
): Promise<void> {
  const ownerContext = options?.ownerContext ?? customerMessage
  await createEscalation({ conversationId, reason, messageSnapshot: ownerContext })
  await setConversationStatus(conversationId, 'escalated')
  await cambiarEtapa({
    conversationId,
    etapa: options?.etapa ?? 'human_assigned',
    actor: options?.agent ?? 'system',
    motivo: `Escalado: ${reason}`,
  })

  const reply = await draftReply({
    facts: { case: 'none' },
    escalation: { escalate: true, reason },
    history,
    customerMessage,
    instruction: options?.instruction ?? 'Reconoce lo que pide el cliente y avísale que en breve le escribe alguien del equipo.',
  })
  await sendAndLog(sock, conversationId, chatJid, reply, {
    actionTaken: 'escalated',
    agent: options?.agent ?? 'sales',
  })
  await notifyOwner(sock, phoneNumber, reason, ownerContext)
}

/**
 * Pasa el chat a una persona sin agregar otro mensaje automático. Se usa
 * después de una sugerencia de catálogo: el cliente ya recibió la foto y el
 * precio, y ahora alguien del equipo debe comprobar el stock real. También
 * evita que el bot siga proponiendo alternativas si el cliente rechaza la
 * pieza mostrada.
 */
async function assignToHumanSilently(
  sock: WASocket,
  conversationId: number,
  phoneNumber: string,
  ownerContext: string,
): Promise<void> {
  await createEscalation({ conversationId, reason: 'other', messageSnapshot: ownerContext })
  await setConversationStatus(conversationId, 'escalated')
  await cambiarEtapa({
    conversationId,
    etapa: 'human_assigned',
    actor: 'intake',
    motivo: 'Recepción terminada; una persona debe revisar la pieza y confirmar stock',
  })
  await notifyOwner(sock, phoneNumber, 'other', ownerContext)
}

/**
 * Esta foto no admite respaldo a texto. Si WhatsApp no puede descargar la
 * imagen, es mejor que una persona la mande después que decir "te envié la
 * foto" sin haberla enviado. El precio viaja como pie de foto y nunca se
 * menciona disponibilidad.
 */
async function sendCatalogSuggestionPhotoAndLog(
  sock: WASocket,
  conversationId: number,
  chatJid: string,
  text: string,
  imageUrl: string,
  productId: number,
  matchConfidence: number,
): Promise<boolean> {
  await humanDelay()
  if (!(await puedeResponderAhora(conversationId, 'intake'))) {
    console.log(`Sugerencia de catálogo cancelada: el permiso del chat #${conversationId} cambió mientras se procesaba.`)
    return false
  }

  try {
    const sent = await sock.sendMessage(chatJid, { image: { url: imageUrl }, caption: text })
    // El mensaje ya llegó a WhatsApp. Un fallo posterior al guardarlo no
    // puede reescribir la historia como "la foto falló" ni disparar otro
    // mensaje al cliente; queda en el log para que se investigue.
    try {
      await logOutboundMessage(conversationId, {
        body: text,
        productId,
        matchConfidence,
        contentType: 'image',
        mediaUrl: imageUrl,
        // No es una confirmación de stock: solo una sugerencia con foto y
        // valor. Se reutiliza un valor ya permitido para no exigir una
        // migración antes de que el cambio sea seguro de desplegar.
        actionTaken: 'none',
        agent: 'intake',
        whatsappMessageId: sent?.key?.id ?? null,
      })
    } catch (logError) {
      console.error('La sugerencia se envió, pero no se pudo registrar en el ERP:', logError)
    }
    return true
  } catch (err) {
    console.error(`No se pudo enviar la foto de sugerencia (${imageUrl}):`, err)
    return false
  }
}

/**
 * Las fotos se reservan para revisión humana. No se pasan por Gemini: una
 * identificación visual equivocada puede terminar en el repuesto incorrecto.
 */
async function escalatePhotoToHuman(
  sock: WASocket,
  conversationId: number,
  phoneNumber: string,
  customerMessage: string | null,
): Promise<void> {
  const snapshot = customerMessage?.trim()
    ? `[Foto enviada] ${customerMessage.trim()}`
    : '[Foto enviada: requiere revisión de un vendedor]'

  await createEscalation({ conversationId, reason: 'other', messageSnapshot: snapshot })
  await setConversationStatus(conversationId, 'escalated')
  await cambiarEtapa({
    conversationId,
    etapa: 'human_assigned',
    actor: 'intake',
    motivo: 'El cliente envió una foto; revisión visual asignada a vendedor',
  })
  await notifyOwner(sock, phoneNumber, 'other', snapshot)
}

async function handleProductRequest(
  sock: WASocket,
  conversationId: number,
  phoneNumber: string,
  chatJid: string,
  item: InterpretedItem,
  interpretation: InterpretResult,
  history: HistoryTurn[],
  customerMessage: string,
): Promise<void> {
  // El intérprete a veces separa el modelo/marca en su propio campo en vez
  // de incluirlo en search_query (ej. "se me dañó el motor de mi tekken
  // discovery" -> search_query="repuestos motor", vehicleContext="Tekken
  // Discovery") -- combinarlos siempre, no solo cuando search_query falta
  // del todo, si no el modelo se pierde en silencio y la búsqueda queda
  // sin la info que el cliente sí dio.
  let query = buildSearchQuery(item)

  if (!query) {
    const reply = await draftReply({
      facts: { case: 'none' },
      escalation: { escalate: false },
      history,
      customerMessage,
      instruction: 'No quedó claro qué repuesto busca. Pídele que aclare qué necesita.',
    })
    await sendAndLog(sock, conversationId, chatJid, reply, { actionTaken: 'asked_clarification' })
    return
  }

  const knownModels = await getKnownModels()
  const modelDefaults = await getModelDefaults()
  query = applyModelDefault(query, knownModels, modelDefaults)

  // Algunos modelos siguen siendo ambiguos aunque el cliente ya haya
  // nombrado uno conocido -- ej. "wing evo" sin más es ambiguo entre dos
  // diseños distintos (antes/después del 2024), no una pieza compatible
  // con varios modelos a la vez. Si el cliente ya dio un número (año, cc,
  // "evo 2") se asume que ya fue específico y no se pregunta.
  if (!/\d/.test(query)) {
    const disambiguations = await getModelDisambiguations()
    const disambiguation = findModelDisambiguation(detectKnownModels(query, knownModels), disambiguations)
    if (disambiguation) {
      const reply = await draftReply({
        facts: { case: 'none' },
        escalation: { escalate: false },
        history,
        customerMessage,
        instruction: disambiguation.hint,
      })
      await sendAndLog(sock, conversationId, chatJid, reply, { actionTaken: 'asked_clarification' })
      return
    }
  }

  const matches = await findProductMatches(query, 5)

  // Entre candidatos empatados en el mejor puntaje, preferir el que tiene
  // stock -- si no, se le puede terminar diciendo "no hay" a un cliente
  // cuando en realidad hay una variante casi idéntica (mismo repuesto,
  // otro color) con stock, que quedó más abajo por un empate arbitrario.
  const topScore = matches[0]?.matchConfidence
  if (topScore !== undefined) {
    const tiedInStock = matches.find(
      (m) => m.matchConfidence === topScore && (m.localStock > 0 || (!m.importerUnavailable && m.importerStock > 0)),
    )
    if (tiedInStock && tiedInStock !== matches[0]) {
      matches.splice(matches.indexOf(tiedInStock), 1)
      matches.unshift(tiedInStock)
    }
  }

  let match = matches[0]

  if (!match || match.matchConfidence < config.matchConfidenceThreshold) {
    await registerLostDemand(query)
    const reply = await draftReply({
      facts: { case: 'not_in_catalog', searchTerm: query },
      escalation: { escalate: false },
      history,
      customerMessage,
      instruction: 'Cuéntale con honestidad que no manejan ese repuesto.',
    })
    await sendAndLog(sock, conversationId, chatJid, reply, { actionTaken: 'registered_lost_demand' })
    return
  }

  // La búsqueda difusa puede confundir modelos que comparten texto (ej.
  // "force" matchea dentro de "workforce" por similitud). Si el cliente
  // nombró modelo(s) conocido(s) y NINGUNO de los modelos que lista el
  // match coincide con lo que dijo, puede ser el producto equivocado --
  // ojo, muchas piezas son compatibles con varios modelos a la vez (ej.
  // "WOLF/MAVERICK/FEROCE"), y algunos modelos del catálogo son
  // compuestos por dos palabras que también están registradas por
  // separado (ej. "WING EVO" -- "WING" y "EVO" existen ambos como modelo
  // individual). Por eso se comparan TODOS los modelos que menciona el
  // cliente contra TODOS los que lista el match, no uno solo de cada
  // lado -- si el cliente dijo "wing evo" y el match es justamente un
  // WING EVO, hay superposición y no hay nada que preguntar. Primero
  // intentamos autocorregir con otro candidato ya traído; si no hay uno
  // confiable, preguntamos en vez de adivinar.
  // Un match exacto (alias curado a mano, o el cliente pegó el SKU tal
  // cual) ya es inequívoco por diseño -- no tiene sentido preguntar qué
  // modelo es solo porque el texto de la consulta (ej. un código de SKU)
  // no contiene ninguna palabra de "modelo conocido" reconocible. Sin
  // este salto, pedir el SKU exacto de un repuesto terminaba en la
  // pregunta de desambiguación en vez de la respuesta directa.
  if (match.matchedVia !== 'alias_exact') {
    const queryModels = detectKnownModels(query, knownModels)
    const matchModels = detectCatalogModels(match.name, knownModels)
    const matchOverlapsQuery = matchModels.some((m) => queryModels.includes(m))

    if (queryModels.length > 0 && matchModels.length > 0 && !matchOverlapsQuery) {
      const betterMatch = matches.find(
        (m) =>
          m.productId !== match.productId &&
          detectCatalogModels(m.name, knownModels).some((mm) => queryModels.includes(mm)),
      )
      if (betterMatch && betterMatch.matchConfidence >= config.matchConfidenceThreshold) {
        match = betterMatch
      } else {
        const reply = await draftReply({
          facts: { case: 'none' },
          escalation: { escalate: false },
          history,
          customerMessage,
          instruction: `No queda claro si el cliente se refiere al modelo ${queryModels.join(' o ')} o al modelo ${matchModels.join(' o ')} -- son modelos distintos. Preguntale cuál de los dos es, en una sola pregunta corta.`,
        })
        await sendAndLog(sock, conversationId, chatJid, reply, { actionTaken: 'asked_clarification' })
        return
      }
    } else if (queryModels.length === 0 && matchModels.length > 0) {
      // El cliente no nombró NINGÚN modelo (decir "mi moto daytona" no cuenta
      // -- todo el catálogo es Daytona, eso no distingue nada) y los
      // candidatos que trajo la búsqueda cubren más de un modelo real. No
      // hay forma confiable de adivinar cuál -- preguntamos.
      const modelsAcrossCandidates = new Set<string>()
      for (const m of matches) {
        for (const model of detectCatalogModels(m.name, knownModels)) modelsAcrossCandidates.add(model)
      }
      if (modelsAcrossCandidates.size > 1) {
        const examples = [...modelsAcrossCandidates].slice(0, 5).join(', ')
        const reply = await draftReply({
          facts: { case: 'none' },
          escalation: { escalate: false },
          history,
          customerMessage,
          instruction: `No dijo de qué modelo de moto es, y esa pieza cambia según el modelo (ej. ${examples}). Preguntale qué modelo Daytona tiene, en una sola pregunta corta.`,
        })
        await sendAndLog(sock, conversationId, chatJid, reply, { actionTaken: 'asked_clarification' })
        return
      }
    }
  }

  // Muchos repuestos de este catálogo son productos DISTINTOS según el
  // color (fila aparte, no un atributo del mismo producto). Si el match
  // tiene color y el cliente no lo especificó, hay que preguntar -- si no,
  // se le puede terminar avisando por el color equivocado cuando llegue.
  const matchColor = extractColor(match.name)
  if (matchColor && !mentionsColor(customerMessage)) {
    const baseName = stripColor(match.name)
    const siblingColors = matches
      .filter((m) => m.productId !== match.productId && stripColor(m.name) === baseName)
      .map((m) => extractColor(m.name))
      .filter((c): c is string => !!c)
    const colorOptions = [...new Set([matchColor, ...siblingColors])]

    if (colorOptions.length > 1) {
      const reply = await draftReply({
        facts: { case: 'none' },
        escalation: { escalate: false },
        history,
        customerMessage,
        instruction: `Ese repuesto viene en varios colores (${colorOptions.join(', ').toLowerCase()}). Preguntale de qué color lo quiere, en una sola pregunta corta.`,
      })
      await sendAndLog(sock, conversationId, chatJid, reply, { actionTaken: 'asked_clarification' })
      return
    }
  }

  // "Agotado en Importadora": el negocio ya marcó ese número de
  // importer_stock como no confiable (dato del proveedor desactualizado)
  // -- no cuenta como stock real disponible. Ver docs/system-prompts.md.
  const effectiveImporterStock = match.importerUnavailable ? 0 : match.importerStock
  const hasStock = match.localStock > 0 || effectiveImporterStock > 0

  // Algunos productos tienen price = 0 en la base -- dato sin cargar
  // todavía, no que sea gratis. Nunca hay que confirmarle un precio de $0
  // a un cliente; se escala para que alguien del equipo lo confirme.
  if (hasStock && match.price <= 0) {
    await escalate(sock, conversationId, phoneNumber, chatJid, 'other', history, customerMessage, {
      instruction: 'Cuéntale que sí tienen ese repuesto en stock, pero que el precio te lo confirma alguien del equipo en breve.',
      ownerContext: `[Falta configurar el precio: "${match.name}" / SKU ${match.sku}] ${customerMessage}`,
    })
    return
  }

  if (hasStock) {
    // El cliente puede pedir más de una unidad ("necesito 3 filtros") --
    // si lo que hay en stock no le alcanza, hay que avisarle en vez de
    // confirmar como si tuviera lo suficiente para lo que pidió.
    const requestedQuantity = Math.max(1, item.quantity || 1)
    const availableQuantity = match.localStock + effectiveImporterStock
    const enoughForQuantity = availableQuantity >= requestedQuantity

    const reply = await draftReply({
      facts: {
        case: 'in_stock',
        productName: match.name,
        sku: match.sku,
        price: roundedCustomerPrice(match.price),
        imageUrl: match.imageUrl,
      },
      escalation: { escalate: false },
      history,
      customerMessage,
      instruction:
        requestedQuantity > 1
          ? enoughForQuantity
            ? `Cuéntale que sí lo tienen y que hay para las ${requestedQuantity} unidades que pidió, dale el precio por unidad, y avísale que le mandas la foto.`
            : `Cuéntale que sí lo tienen pero que ahorita solo hay ${availableQuantity} unidad(es) en stock, no las ${requestedQuantity} que pidió -- dale el precio por unidad y preguntale si le sirve con lo que hay disponible.`
          : 'Cuéntale que sí lo tienen, dale el precio, y avísale que le mandas la foto.',
    })
    await sendProductPhotoAndLog(sock, conversationId, chatJid, reply, match.imageUrl, match.productId, match.matchConfidence)
    return
  }

  const { alreadyRegistered } = await registerProductDemand({
    productId: match.productId,
    phoneNumber,
    customerName: interpretation.customerName,
    notes: [customerMessage, interpretation.shippingInfo ? `Envío: ${interpretation.shippingInfo}` : null]
      .filter(Boolean)
      .join(' | '),
  })

  const reply = await draftReply({
    facts: { case: 'no_stock', productName: match.name, price: roundedCustomerPrice(match.price), alreadyRegistered },
    escalation: { escalate: false },
    history,
    customerMessage,
    instruction: alreadyRegistered
      ? 'Cuéntale que ya tenía un pedido anotado para este producto, no hace falta que pida de nuevo -- le avisan apenas llegue. Si pregunta el precio, dáselo.'
      : 'Cuéntale que no hay stock ahora pero que ya quedó anotado el pedido y le avisan apenas llegue. Si pregunta el precio, dáselo.',
  })
  await sendAndLog(sock, conversationId, chatJid, reply, {
    productId: match.productId,
    matchConfidence: match.matchConfidence,
    actionTaken: alreadyRegistered ? 'demand_already_existed' : 'registered_demand',
  })
}

/**
 * Último recurso cuando algo del pipeline (Gemini, descarga de media, la
 * base) falla o se cuelga: en vez de dejar al cliente sin ninguna
 * respuesta, le avisamos que hubo un problema técnico y escalamos a un
 * humano -- mismo mecanismo que un escalamiento normal, pero disparado por
 * una falla interna en vez de una regla de negocio.
 */
async function handleProcessingFailure(
  sock: WASocket,
  conversationId: number,
  phoneNumber: string,
  chatJid: string,
): Promise<void> {
  // Al cliente no le importa ni le sirve saber que fue "un problema
  // técnico": eso es lenguaje de adentro, y encima suena a excusa. Lo
  // único que necesita saber es que su mensaje no se perdió y que alguien
  // de verdad lo va a atender -- que es lo que pasa: esto escala.
  const fallbackText = 'Perdón, se me complicó por acá. Ya le paso tu mensaje a alguien del equipo para que te ayude.'

  await createEscalation({ conversationId, reason: 'other', messageSnapshot: '(falla técnica interna -- ver logs del servidor)' })
  await setConversationStatus(conversationId, 'escalated')
  await cambiarEtapa({
    conversationId,
    etapa: 'human_assigned',
    actor: 'system',
    motivo: 'Falla técnica al procesar el mensaje',
  })
  const actual = await getConversationState(conversationId)
  const agente = actual?.selectedAgent
  if (!agente || !(await puedeResponderAhora(conversationId, agente, { permitirEscalado: true }))) {
    console.log(`Fallback tecnico cancelado: el permiso del chat #${conversationId} cambio mientras se procesaba.`)
    return
  }
  const sentFallback = await sock.sendMessage(chatJid, { text: fallbackText })
  await logOutboundMessage(conversationId, {
    body: fallbackText,
    actionTaken: 'escalated',
    whatsappMessageId: sentFallback?.key?.id ?? null,
  })
  await notifyOwner(sock, phoneNumber, 'other', '(falla técnica -- revisar logs del servidor)')
}

/**
 * Modo recepción (`AGENT_MODE=intake`): junta y confirma los datos del
 * repuesto. Al terminar, consulta el catálogo una sola vez y solo manda
 * foto/precio si la coincidencia es estricta; el stock siempre lo confirma
 * una persona.
 * Ver docs/system-prompts.md.
 */
/**
 * Última red de seguridad de la recepción. Un JSON incompleto del modelo no
 * justifica pasarle al vendedor un cliente del que todavía no sabemos ni la
 * pieza ni la moto; se pregunta el siguiente dato imprescindible y se
 * conserva lo que ya pudo extraerse.
 */
export function preguntaDeRespaldoDeRecepcion(data: FichaDeRecepcion): string {
  const detalleCondicional = ' Si es plástico o carrocería, agrega la parte concreta y el color; si va de un lado, indica izquierda o derecha sentado en la moto.'
  if (!data.repuesto) {
    return `Para ayudarte, indícame el repuesto y la marca y modelo exacto de tu moto.${detalleCondicional}`
  }
  if (!data.marca && !data.modelo) {
    return `Para el ${data.repuesto}, indícame la marca y el modelo exacto de tu moto.${detalleCondicional}`
  }
  if (!data.modelo) return `Para el ${data.repuesto}, ¿qué modelo exacto de moto tienes?${detalleCondicional}`
  return '¿Me confirmas el repuesto y el modelo de tu moto para ayudarte bien?'
}

async function processIntakeMessage(
  sock: WASocket,
  conversation: { id: number; status: string },
  parsed: NonNullable<ReturnType<typeof parseIncomingMessage>>,
  customerMessage: string,
  history: HistoryTurn[],
  media: { base64: string; mimeType: string } | null,
): Promise<void> {
  const result = await runIntake({
    history,
    customerMessage,
    nombreCliente: nombreDePila(parsed.pushName),
    image: parsed.contentType === 'image' && media ? media : undefined,
    audio: parsed.contentType === 'audio' && media ? media : undefined,
  })

  // Si mandó una foto en algún momento del hilo, va anotado en la ficha:
  // el vendedor tiene que saber que hay una imagen que mirar antes de
  // cotizar. No se pregunta, se deduce.
  const ficha: FichaDeRecepcion = {
    ...result.data,
    fotoRecibida:
      parsed.contentType === 'image' || history.some((h) => h.contentType === 'image'),
  }

  // El borrador se guarda SIEMPRE y en cada vuelta, aunque falten datos:
  // si una persona entra a mitad de la recepción tiene que ver lo que se
  // lleva juntado, no el hilo entero para reconstruirlo a mano.
  await guardarBorrador(conversation.id, ficha)

  if (result.needsHuman) {
    await escalate(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, 'other', history, customerMessage, {
      agent: 'intake',
    })
    return
  }

  if (result.complete) {
    // Ya están todos los datos y el cliente los confirmó. La ficha se
    // cierra ANTES de buscar/enviar: aunque falle el catálogo o WhatsApp,
    // una persona recibe el trabajo completo y no vuelve a preguntarle.
    let catalogo: Awaited<ReturnType<typeof buscarCatalogoParaRecepcion>> | null = null
    let resumen: string
    try {
      catalogo = await buscarCatalogoParaRecepcion(result.data)
      resumen = resumenParaElVendedorConCatalogo(result.data, catalogo)
    } catch (err) {
      console.error('No se pudo buscar en el catálogo al terminar la recepción:', err)
      resumen = await resumenParaElVendedor(result.data)
    }

    const sugerencia = catalogo?.suggestion ?? null
    await marcarFichaLista(conversation.id, ficha, {
      resumen,
      cerrada_at: new Date().toISOString(),
      catalogo_consultado: catalogo?.query ?? null,
      sugerencia_enviada: sugerencia
        ? {
            product_id: sugerencia.productId,
            nombre: sugerencia.name,
            sku: sugerencia.sku,
            precio: roundedCustomerPrice(sugerencia.price),
            confianza: sugerencia.matchConfidence,
          }
        : null,
    })

    const ownerContextBase = `[Datos del cliente listos]\n${resumen}\n\nÚltimo mensaje: "${customerMessage}"`
    if (sugerencia?.imageUrl) {
      const value = roundedCustomerPrice(sugerencia.price)
      const caption = `Te comparto la foto del ${sugerencia.name}. Su valor es $${value}. Una persona del equipo te confirma la disponibilidad.`
      const photoSent = await sendCatalogSuggestionPhotoAndLog(
        sock,
        conversation.id,
        parsed.chatJid,
        caption,
        sugerencia.imageUrl,
        sugerencia.productId,
        sugerencia.matchConfidence,
      )
      await assignToHumanSilently(
        sock,
        conversation.id,
        parsed.phoneNumber,
        `${ownerContextBase}\n\n${photoSent ? 'Se envió foto y precio al cliente.' : 'No se pudo enviar la foto; mandarla manualmente.'}\nConfirmar stock real antes de vender.`,
      )
      return
    }

    // Sin una coincidencia estricta (o sin foto/precio completo) no se
    // menciona un producto al cliente. La tarea queda directamente en la
    // cola humana, sin el mensaje automático genérico de antes.
    await assignToHumanSilently(
      sock,
      conversation.id,
      parsed.phoneNumber,
      `${ownerContextBase}\n\nNo se envió sugerencia automática; revisar catálogo y stock manualmente.`,
    )
    return
  }

  const question = result.nextQuestion?.trim() || preguntaDeRespaldoDeRecepcion(ficha)
  if (!question) {
    // Red de seguridad: el modelo dijo que falta info pero no formuló la
    // pregunta (se vio en pruebas cuando el cliente pregunta algo que el
    // bot no puede responder, ej. costo de envío). El prompt ya lo
    // prohíbe explícitamente, pero si igual pasa, el cliente NO puede
    // quedarse sin respuesta -- se escala con una instrucción concreta en
    // vez del texto genérico de escalamiento.
    await escalate(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, 'other', history, customerMessage, {
      instruction:
        'Decile en una frase corta que eso se lo confirma alguien del equipo, y que en breve le escriben. NO le des precio, disponibilidad, ni datos de envío vos.',
      ownerContext: `[El bot no supo qué preguntar -- datos hasta ahora]\n${await resumenParaElVendedor(result.data)}\n\nÚltimo mensaje: "${customerMessage}"`,
      agent: 'intake',
    })
    return
  }

  // Se preguntó algo: la pelota queda del lado del cliente. Es la etapa
  // que deja ver en la bandeja quién está esperando una respuesta que
  // nunca llegó.
  await sendAndLog(sock, conversation.id, parsed.chatJid, question, {
    actionTaken: 'asked_clarification',
    agent: 'intake',
  })
  await cambiarEtapa({
    conversationId: conversation.id,
    etapa: 'waiting_customer_info',
    actor: 'intake',
    motivo: 'Se le preguntó un dato y falta que conteste',
  })
}

async function processMessage(
  sock: WASocket,
  conversation: { id: number; status: string; selectedAgent: 'intake' | 'sales' | null },
  parsed: NonNullable<ReturnType<typeof parseIncomingMessage>>,
  msg: WAMessage,
  /**
   * La ráfaga completa: todos los mensajes que el cliente mandó seguidos
   * (ver messageBuffer.ts). `parsed` y `msg` son el último, que es el que
   * define a qué chat se contesta.
   */
  rafaga: MensajeEnRafaga[],
): Promise<void> {
  // "Escribiendo..." desde el momento en que se empieza a procesar, no
  // recién al mandar. Es lo que hace una persona: se la ve escribir
  // mientras piensa la respuesta. Sin esto el cliente ve silencio durante
  // toda la llamada al modelo y de golpe aparece un mensaje.
  // Se apaga solo cuando se envía; si algo falla, WhatsApp lo limpia a los
  // segundos.
  await mostrarEscribiendo(sock, parsed.chatJid, true)

  // La foto o la nota de voz puede haber venido en CUALQUIER mensaje de la
  // ráfaga, no necesariamente en el último: es común mandar la foto y
  // después escribir "¿tienen este?".
  const conMedia = mediaDeLaRafaga(rafaga)
  let media: { base64: string; mimeType: string } | null = null
  if (conMedia) {
    media = await downloadMediaAsBase64(sock, conMedia.msg)
  }
  const tipoDeMedia = conMedia?.parsed.contentType

  const history = await getRecentHistory(conversation.id, 10)

  // Todo lo que dijo el cliente en la ráfaga, junto. Antes se usaba solo
  // el último mensaje, y por eso el bot preguntaba cosas que el cliente ya
  // había contestado dos mensajes antes.
  const customerMessage = textoDeLaRafaga(rafaga)

  // Se decide antes del saludo para que incluso la primera respuesta
  // respete el agente elegido al activar este chat.
  const etapa = await etapaDe(conversation.id)
  const agente = await elegirAgente(etapa, conversation.selectedAgent)
  if (!agente) return

  // No hace falta interpretar ni seguir pidiendo datos si la persona ya
  // desistió. Marcar el hilo resuelto evita que una frase de cortesía como
  // "ya no deseo, gracias" vuelva a disparar la misma pregunta después.
  if (esDesistimiento(customerMessage)) {
    await sendAndLog(sock, conversation.id, parsed.chatJid, RESPUESTA_DE_DESISTIMIENTO, {
      actionTaken: 'none',
      agent: agente,
    })
    await setConversationStatus(conversation.id, 'closed')
    await cambiarEtapa({
      conversationId: conversation.id,
      etapa: 'resolved',
      actor: agente,
      motivo: 'El cliente indicó que ya no necesita la consulta',
    })
    return
  }

  // Un saludo pelado ("hola", "buenas tardes") no tiene nada que
  // interpretar: el cliente todavía no pidió nada. Se contesta desde el
  // banco de saludos, sin gastar ninguna llamada al modelo y sin repetir
  // siempre la misma frase -- ver saludos.ts.
  //
  // Solo en un chat donde nunca contestamos: si ya veníamos hablando,
  // responderle un saludo de bienvenida a un "hola" suelto sería tirar a
  // la basura el contexto de lo que ya nos había dicho.
  if (correspondeSaludar({ texto: customerMessage, tieneMedia: !!media, historial: history })) {
    const saludo = textoDeSaludo({ pushName: parsed.pushName })
    // Una respuesta instantánea delata al bot más que cualquier redacción.
    // Como acá no hubo llamada al modelo que demorara, se agrega la pausa
    // que habría tomado leer y escribir el saludo (sendAndLog suma la suya).
    await humanDelay(900, 2200)
    await sendAndLog(sock, conversation.id, parsed.chatJid, saludo, {
      actionTaken: 'greeting',
      // El saludo lo arma la recepción, aunque no pase por el modelo.
      agent: agente,
    })
    return
  }

  // Un solo punto de decisión: ver `elegirAgente`.
  if (agente === 'intake') {
    // Primera respuesta de la recepción en este chat: deja de ser 'new'.
    if (etapa === 'new' || etapa === null) {
      await cambiarEtapa({
        conversationId: conversation.id,
        etapa: 'intake_in_progress',
        actor: 'intake',
        motivo: 'El cliente escribió y la recepción empezó a juntar datos',
      })
    }
    await processIntakeMessage(sock, conversation, parsed, customerMessage, history, media)
    return
  }

  // De acá para abajo, el agente VENDEDOR.
  if (etapa !== 'sales_in_progress') {
    await cambiarEtapa({
      conversationId: conversation.id,
      etapa: 'sales_in_progress',
      actor: 'sales',
      motivo: 'El agente vendedor tomó la conversación',
    })
  }

  const interpretation = await interpretMessage({
    text: customerMessage || null,
    image: tipoDeMedia === 'image' && media ? media : undefined,
    audio: tipoDeMedia === 'audio' && media ? media : undefined,
    history,
  })

  // Si el mensaje mezcla una pregunta del negocio con otra cosa (ej. un
  // pedido de producto), esa otra cosa sigue su curso normal más abajo --
  // esto solo evita que la pregunta del negocio se pierda sin dejar
  // rastro. Se salta cuando el intent YA ES general_question o cuando
  // needs_escalation ya va a mandar el mensaje completo al dueño de
  // todos modos (evita duplicar el aviso).
  if (interpretation.hasUnansweredGeneralQuestion && interpretation.intent !== 'general_question' && !interpretation.needsEscalation) {
    await notifyOwnerOfGeneralQuestion(sock, parsed.phoneNumber, customerMessage)
  }

  if (interpretation.needsEscalation) {
    await escalate(
      sock,
      conversation.id,
      parsed.phoneNumber,
      parsed.chatJid,
      mapEscalationReason(interpretation.escalationReason),
      history,
      customerMessage,
    )
    return
  }

  switch (interpretation.intent) {
    case 'greeting_smalltalk': {
      const reply = await draftReply({
        facts: { case: 'none' },
        escalation: { escalate: false },
        history,
        customerMessage,
        instruction: 'Saluda y pregúntale qué repuesto está buscando.',
      })
      await sendAndLog(sock, conversation.id, parsed.chatJid, reply, { actionTaken: 'greeting' })
      return
    }

    case 'order_followup': {
      // Fuera de alcance tocar `orders`/el estado del pedido -- lo resuelve un humano.
      await escalate(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, 'other', history, customerMessage)
      return
    }

    case 'general_question': {
      // Métodos de pago, zonas de envío, horario, garantía, etc. -- el
      // redactor tiene explícitamente prohibido inventar esto (reglas 1-6
      // de buildResponderSystemPrompt), así que no hay nada que el bot
      // pueda contestar por su cuenta. Antes esto cascaba como
      // "greeting_smalltalk" o "unclear" y el bot ignoraba la pregunta.
      await escalate(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, 'other', history, customerMessage, {
        instruction: 'Reconoce la pregunta del cliente sobre el negocio y avísale que en breve le escribe alguien del equipo con la info.',
      })
      return
    }

    case 'complaint':
    case 'discount_request': {
      // Red de seguridad por si el intérprete no marcó needs_escalation.
      const reason = interpretation.intent === 'discount_request' ? 'discount_request' : 'complaint_or_return'
      await escalate(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, reason, history, customerMessage)
      return
    }

    case 'unclear': {
      const alreadyAsked = await lastReplyWasClarification(conversation.id)
      if (alreadyAsked) {
        await escalate(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, 'ambiguous_after_retries', history, customerMessage)
        return
      }
      const reply = await draftReply({
        facts: { case: 'none' },
        escalation: { escalate: false },
        history,
        customerMessage,
        instruction:
          'No quedó claro qué repuesto busca. Pídele que aclare -- marca, modelo del auto, y de qué lado/posición si aplica -- en una sola pregunta corta.',
      })
      await sendAndLog(sock, conversation.id, parsed.chatJid, reply, { actionTaken: 'asked_clarification' })
      return
    }

    case 'product_request':
    default: {
      // Uno o varios repuestos en el mismo mensaje (ej. "un filtro de aire y
      // una bujía para mi wolf") -- se procesan de a uno, en orden, cada uno
      // con su propia respuesta. Si el intérprete no separó ningún item (no
      // debería pasar con intent product_request, pero por las dudas), cae
      // en un item vacío para que handleProductRequest pida aclaración.
      const items = interpretation.items.length > 0 ? interpretation.items : [EMPTY_ITEM]
      for (const item of items.slice(0, MAX_ITEMS_PER_MESSAGE)) {
        await handleProductRequest(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, item, interpretation, history, customerMessage)
      }
    }
  }
}

export async function handleIncomingMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const parsed = parseIncomingMessage(msg)
  if (!parsed) return

  // Mensajes salientes del propio número: el eco de lo que mandó el bot, o
  // el vendedor escribiendo desde su teléfono vinculado. Se guardan para
  // tener la conversación COMPLETA (el negocio la usa para análisis), pero
  // jamás se procesan como pedido -- el bot se estaría respondiendo solo.
  //
  // El eco del propio bot se descarta solo por el índice único sobre
  // whatsapp_message_id: el bot ya guardó ese id al enviar, así que este
  // insert choca y se ignora. Lo que sí queda registrado es lo que
  // escribió la persona del equipo, marcado como 'human_reply'.
  if (parsed.fromMe) {
    const ownConversation = await upsertConversation(parsed.phoneNumber, parsed.pushName, parsed.lid, parsed.chatJid)
    const idRegistrado = await logOutboundMessage(ownConversation.id, {
      body: parsed.body ?? '',
      contentType: parsed.contentType,
      actionTaken: 'human_reply',
      agent: 'human',
      whatsappMessageId: parsed.whatsappMessageId,
      replyToWaId: parsed.replyToWaId,
      sentAt: parsed.sentAt,
    })

    // Devuelve null cuando el insert chocó con el índice único, o sea
    // cuando este mensaje es el ECO de algo que mandó el propio bot y ya
    // estaba registrado. Sin esta distinción, cada respuesta automática
    // se leería como "un humano tomó el chat" y la recepción se apagaría
    // sola después del primer mensaje.
    if (idRegistrado !== null) {
      await cambiarEtapa({
        conversationId: ownConversation.id,
        etapa: 'human_assigned',
        actor: 'human',
        motivo: 'Alguien del equipo escribió desde el teléfono',
      })
    }
    // La foto que el vendedor mandó desde el teléfono también se guarda:
    // si no, el hilo del ERP muestra "(foto)" y nadie sabe qué se le
    // mandó al cliente.
    capturarMediaEnSegundoPlano(sock, msg, {
      conversationId: ownConversation.id,
      whatsappMessageId: parsed.whatsappMessageId,
      contentType: parsed.contentType,
    })
    return
  }

  let conversation = await upsertConversation(parsed.phoneNumber, parsed.pushName, parsed.lid, parsed.chatJid)
  const esNuevo = await logInboundMessage(conversation.id, {
    contentType: parsed.contentType,
    body: parsed.body,
    whatsappMessageId: msg.key.id ?? null,
    replyToWaId: parsed.replyToWaId,
    sentAt: parsed.sentAt,
  })

  // WhatsApp/Baileys puede reenviar un evento tras una reconexión. La base
  // ya lo deduplica por whatsapp_message_id; no alcanzar con eso hacía que
  // el mismo texto entrara de nuevo al buffer y produjera otra respuesta.
  if (!esNuevo) {
    console.log(`Mensaje entrante duplicado ignorado en la conversación #${conversation.id}.`)
    return
  }

  // La media se copia SIEMPRE, incluso si el bot no va a contestar esta
  // conversación: WhatsApp no la vuelve a entregar más tarde, así que si
  // no se guarda ahora se pierde para siempre. Va en segundo plano para
  // no demorarle la respuesta al cliente.
  capturarMediaEnSegundoPlano(sock, msg, {
    conversationId: conversation.id,
    whatsappMessageId: msg.key.id ?? null,
    contentType: parsed.contentType,
  })

  // Una imagen no se intenta interpretar automáticamente. Se registra y se
  // manda de inmediato a la cola humana, aun si el chat todavía no estaba
  // habilitado para recepción.
  if (parsed.contentType === 'image'
      && conversation.status !== 'escalated'
      && conversation.status !== 'human_active'
      && conversation.status !== 'closed') {
    await escalatePhotoToHuman(sock, conversation.id, parsed.phoneNumber, parsed.body)
    return
  }

  // Los anuncios y botones de contacto de Meta llegan con esta frase
  // prellenada. Para esos clientes el propio mensaje inicia la recepción:
  // se habilita el chat antes del freno individual. Nunca se roba una
  // conversación ya tomada por una persona o escalada.
  if (isAutoActivationMessage(parsed.body)
      && conversation.status !== 'escalated'
      && conversation.status !== 'human_active'
      && conversation.status !== 'closed') {
    conversation = await activateConversationForIntake(conversation.id)
    console.log(`Agente de recepción activado automáticamente en el chat #${conversation.id}.`)
  }

  // Si ya está escalada o un humano tomó el hilo, el bot no contesta solo --
  // solo queda el log de arriba para que el humano tenga el contexto.
  if (conversation.status === 'escalated' || conversation.status === 'human_active' || conversation.status === 'closed') return

  // Freno de emergencia del servidor (BOT_KILL_SWITCH=true en el .env):
  // apaga el agente entero sin importar lo que diga el ERP. Es para
  // cortar de raíz si algo se descontrola; el manejo del día a día va por
  // el interruptor del ERP, no por acá.
  if (config.botKillSwitch) return

  // Con la salida frenada, el socket bloquearía igual la respuesta (ver
  // outboundGuard.ts), pero seguir adelante gastaría una llamada a Gemini
  // por mensaje y dejaría en la base un saliente que nunca salió. Se
  // corta acá: el mensaje del cliente queda registrado igual (arriba).
  if (config.outboundMode !== 'full') return

  // Interruptor MAESTRO (global), controlado desde el ERP -- ver
  // agent_settings (migración 0018). Registra el mensaje igual (arriba),
  // pero no contesta nada.
  if (!(await isBotAutoReplyEnabled())) return

  // Permiso INDIVIDUAL: aunque el interruptor maestro esté encendido, el
  // bot solo contesta a las conversaciones que el negocio habilitó a mano
  // desde la bandeja del ERP (ver migración 0017). Un cliente nuevo queda
  // registrado y visible, pero sin respuesta automática hasta que alguien
  // lo habilite.
  if (!conversation.botEnabled) return

  // No se contesta este mensaje suelto: se espera a que el cliente termine
  // de escribir y se procesa la ráfaga entera de una (ver messageBuffer.ts).
  // La gente manda "buenas tardes, moto tuko cr3 max 200" y "busco rin
  // trasero" como dos mensajes, y contestar el primero sin haber leído el
  // segundo es preguntarle algo que ya dijo.
  encolarParaProcesar(conversation.id, { parsed, msg }, async (mensajes) => {
    // El estado pudo cambiar mientras se esperaba: alguien del equipo pudo
    // tomar la conversación o apagarle el agente justo en esos segundos.
    // Vuelve a mirarlo antes de contestar en vez de usar lo que se leyó al
    // llegar el primer mensaje.
    const actual = await getConversationState(conversation.id)
    if (!actual || !actual.botEnabled) return
    if (actual.status === 'escalated' || actual.status === 'human_active') return

    const ultimo = mensajes[mensajes.length - 1]
    try {
      await withTimeout(
        processMessage(sock, {
          id: conversation.id,
          status: actual.status,
          selectedAgent: actual.selectedAgent,
        }, ultimo.parsed, ultimo.msg, mensajes),
        PROCESS_MESSAGE_TIMEOUT_MS,
        'processMessage',
      )
    } catch (err) {
      await handleProcessingFailure(sock, conversation.id, ultimo.parsed.phoneNumber, ultimo.parsed.chatJid).catch(
        (fallbackErr) => {
          // Si hasta el fallback falla (ej. el envío por WhatsApp también
          // está colgado), al menos que quede visible en el log -- si no,
          // esta conversación queda sin ninguna traza de que algo salió mal.
          console.error('El fallback de falla técnica también falló:', fallbackErr)
        },
      )
      throw err
    }
  })
}
