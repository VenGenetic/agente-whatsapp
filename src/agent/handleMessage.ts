import type { WAMessage, WASocket } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import {
  type ActionTaken,
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
import { isBotAutoReplyEnabled } from '../db/settings.js'
import { createEscalation, type EscalationReason } from '../db/escalations.js'
import { interpretMessage, type InterpretedItem, type InterpretResult } from '../gemini/interpret.js'
import { formatIntakeSummary, runIntake } from './intake.js'
import { encolarParaProcesar, mediaDeLaRafaga, textoDeLaRafaga, type MensajeEnRafaga } from './messageBuffer.js'
import { draftReply } from '../gemini/respond.js'
import {
  applyModelDefault,
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
// mensaje. Cada llamada a Gemini reintenta una vez (20s + 1s + 20s = ~41s
// en el peor caso), así que el presupuesto tiene que cubrir el intérprete
// más hasta MAX_ITEMS_PER_MESSAGE redactores sin cortar un reintento a
// mitad de camino.
const MAX_ITEMS_PER_MESSAGE = 3
const PROCESS_MESSAGE_TIMEOUT_MS = 41000 * (MAX_ITEMS_PER_MESSAGE + 1)

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

async function sendAndLog(
  sock: WASocket,
  conversationId: number,
  chatJid: string,
  text: string,
  extra: { productId?: number | null; matchConfidence?: number | null; actionTaken: ActionTaken },
): Promise<void> {
  await humanDelay()
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
  options?: { instruction?: string; ownerContext?: string },
): Promise<void> {
  const ownerContext = options?.ownerContext ?? customerMessage
  await createEscalation({ conversationId, reason, messageSnapshot: ownerContext })
  await setConversationStatus(conversationId, 'escalated')

  const reply = await draftReply({
    facts: { case: 'none' },
    escalation: { escalate: true, reason },
    history,
    customerMessage,
    instruction: options?.instruction ?? 'Reconoce lo que pide el cliente y avísale que en breve le escribe alguien del equipo.',
  })
  await sendAndLog(sock, conversationId, chatJid, reply, { actionTaken: 'escalated' })
  await notifyOwner(sock, phoneNumber, reason, ownerContext)
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
    const matchModels = detectKnownModels(match.name, knownModels)
    const matchOverlapsQuery = matchModels.some((m) => queryModels.includes(m))

    if (queryModels.length > 0 && matchModels.length > 0 && !matchOverlapsQuery) {
      const betterMatch = matches.find(
        (m) =>
          m.productId !== match.productId &&
          detectKnownModels(m.name, knownModels).some((mm) => queryModels.includes(mm)),
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
        for (const model of detectKnownModels(m.name, knownModels)) modelsAcrossCandidates.add(model)
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
  const fallbackText = 'Uy, tuvimos un problema técnico procesando tu mensaje. Ya te escribe alguien del equipo para ayudarte.'

  await createEscalation({ conversationId, reason: 'other', messageSnapshot: '(falla técnica interna -- ver logs del servidor)' })
  await setConversationStatus(conversationId, 'escalated')
  const sentFallback = await sock.sendMessage(chatJid, { text: fallbackText })
  await logOutboundMessage(conversationId, {
    body: fallbackText,
    actionTaken: 'escalated',
    whatsappMessageId: sentFallback?.key?.id ?? null,
  })
  await notifyOwner(sock, phoneNumber, 'other', '(falla técnica -- revisar logs del servidor)')
}

/**
 * Modo recepción (`AGENT_MODE=intake`): el bot NO consulta el catálogo ni
 * dice precios/stock/fotos -- solo le saca al cliente los datos de lo que
 * necesita (repuesto, marca, modelo, año, y color si aplica) y, cuando ya
 * los tiene todos, pasa la conversación a un humano con el resumen.
 * Ver docs/system-prompts.md.
 */
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
    image: parsed.contentType === 'image' && media ? media : undefined,
    audio: parsed.contentType === 'audio' && media ? media : undefined,
  })

  if (result.needsHuman) {
    await escalate(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, 'other', history, customerMessage)
    return
  }

  if (result.complete) {
    // Ya están todos los datos -- se los pasa al equipo y el bot deja de
    // contestar solo en esta conversación (mismo mecanismo de handoff que
    // cualquier otro escalamiento).
    await escalate(sock, conversation.id, parsed.phoneNumber, parsed.chatJid, 'other', history, customerMessage, {
      instruction:
        'Agradecele los datos y avísale que en breve alguien del equipo le confirma disponibilidad y precio. NO le des precio ni disponibilidad vos.',
      ownerContext: `[Datos del cliente listos]\n${formatIntakeSummary(result.data)}\n\nÚltimo mensaje: "${customerMessage}"`,
    })
    return
  }

  const question = result.nextQuestion?.trim()
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
      ownerContext: `[El bot no supo qué preguntar -- datos hasta ahora]\n${formatIntakeSummary(result.data)}\n\nÚltimo mensaje: "${customerMessage}"`,
    })
    return
  }

  await sendAndLog(sock, conversation.id, parsed.chatJid, question, { actionTaken: 'asked_clarification' })
}

async function processMessage(
  sock: WASocket,
  conversation: { id: number; status: string },
  parsed: NonNullable<ReturnType<typeof parseIncomingMessage>>,
  msg: WAMessage,
  /**
   * La ráfaga completa: todos los mensajes que el cliente mandó seguidos
   * (ver messageBuffer.ts). `parsed` y `msg` son el último, que es el que
   * define a qué chat se contesta.
   */
  rafaga: MensajeEnRafaga[],
): Promise<void> {
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

  if (config.agentMode === 'intake') {
    await processIntakeMessage(sock, conversation, parsed, customerMessage, history, media)
    return
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
    await logOutboundMessage(ownConversation.id, {
      body: parsed.body ?? '',
      contentType: parsed.contentType,
      actionTaken: 'human_reply',
      whatsappMessageId: parsed.whatsappMessageId,
      sentAt: parsed.sentAt,
    })
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

  const conversation = await upsertConversation(parsed.phoneNumber, parsed.pushName, parsed.lid, parsed.chatJid)
  await logInboundMessage(conversation.id, {
    contentType: parsed.contentType,
    body: parsed.body,
    whatsappMessageId: msg.key.id ?? null,
    sentAt: parsed.sentAt,
  })

  // La media se copia SIEMPRE, incluso si el bot no va a contestar esta
  // conversación: WhatsApp no la vuelve a entregar más tarde, así que si
  // no se guarda ahora se pierde para siempre. Va en segundo plano para
  // no demorarle la respuesta al cliente.
  capturarMediaEnSegundoPlano(sock, msg, {
    conversationId: conversation.id,
    whatsappMessageId: msg.key.id ?? null,
    contentType: parsed.contentType,
  })

  // Si ya está escalada o un humano tomó el hilo, el bot no contesta solo --
  // solo queda el log de arriba para que el humano tenga el contexto.
  if (conversation.status === 'escalated' || conversation.status === 'human_active') return

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
        processMessage(sock, { id: conversation.id, status: actual.status }, ultimo.parsed, ultimo.msg, mensajes),
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
