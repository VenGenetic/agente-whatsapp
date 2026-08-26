import type { WASocket } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import { logOutboundMessage, upsertConversation } from '../db/conversations.js'
import { getPendingStockNotifications, getStuckPendingDemands, markDemandNotified, type PendingNotification } from '../db/demands.js'
import { draftReply } from '../gemini/respond.js'
import { supabase } from '../supabaseClient.js'
import { humanDelay } from '../utils/humanDelay.js'
import { toChatJid, toWhatsAppJid } from '../utils/phone.js'
import { roundedCustomerPrice } from '../utils/pricing.js'
import { sendTextOrPhoto } from '../utils/sendTextOrPhoto.js'

type ProductBasics = { name: string; sku: string; price: number; imageUrl: string | null }

async function getProductBasics(productId: number): Promise<ProductBasics | null> {
  const { data, error } = await supabase
    .from('products')
    .select('name, sku, price, image_url')
    .eq('id', productId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null
  return { name: data.name, sku: data.sku, price: Number(data.price ?? 0), imageUrl: data.image_url }
}

async function notifyDemand(sock: WASocket, demand: PendingNotification, backfillStockDetectedAt: boolean): Promise<void> {
  const product = await getProductBasics(demand.productId)
  if (!product) return

  // Mismo caso que en handleMessage.ts: price = 0 es un dato sin cargar
  // todavía, no que sea gratis. Acá no hay conversación activa para
  // escalar -- se avisa al dueño en vez del cliente, y se deja la demanda
  // SIN marcar notified para que se reintente (y le llegue bien al
  // cliente) apenas se cargue el precio real.
  if (product.price <= 0) {
    await sock.sendMessage(toWhatsAppJid(config.ownerPhoneNumber), {
      text: `Ojo: "${product.name}" (SKU ${product.sku}) ya tiene stock y un cliente lo está esperando, pero el precio está en $0 -- hace falta cargarlo para poder avisarle.`,
    })
    return
  }

  const conversation = await upsertConversation(demand.phoneNumber, demand.customerName)

  // Dirección REAL del chat, no una reconstruida a partir del teléfono:
  // para los chats identificados por LID, la reconstruida no existe y
  // WhatsApp descarta el mensaje sin dar error (ver migración 0022).
  const { data: datosChat } = await supabase
    .from('agent_conversations')
    .select('phone_number, lid, chat_jid')
    .eq('id', conversation.id)
    .maybeSingle()
  const jidDestino =
    datosChat?.chat_jid ??
    toChatJid({ phone_number: datosChat?.phone_number ?? demand.phoneNumber, lid: datosChat?.lid ?? null })

  const text = await draftReply({
    facts: {
      case: 'in_stock',
      productName: product.name,
      sku: product.sku,
      price: roundedCustomerPrice(product.price),
      imageUrl: product.imageUrl,
    },
    escalation: { escalate: false },
    history: [],
    customerMessage: '(aviso automático de stock disponible, no es un mensaje del cliente)',
    instruction: 'Avísale que llegó el repuesto que estaba esperando, dale el precio, y dile que le mandas la foto.',
  })

  await humanDelay()
  const sentId = await sendTextOrPhoto(sock, jidDestino, text, product.imageUrl)

  await logOutboundMessage(conversation.id, {
    body: text,
    productId: demand.productId,
    actionTaken: 'answered_in_stock',
    whatsappMessageId: sentId,
  })

  await markDemandNotified(demand.id, { alsoBackfillStockDetectedAt: backfillStockDetectedAt })
}

/**
 * Manda el WhatsApp de "te llegó lo que esperabas" para cada demanda que el
 * trigger de la base ya marcó `stock_available` pero todavía no fue
 * notificada. Espeja la acción manual que ya existe en
 * pages/ProductDemands.tsx del ERP: deja la fila en el mismo estado
 * ('notified' + notified_at) que dejaría un humano haciendo clic ahí.
 *
 * También corre `getStuckPendingDemands` -- se encontraron casos reales de
 * demandas en 'pending_stock' cuyo producto YA tenía stock desde hacía
 * días, sin que el trigger de sistema_erp las pasara a 'stock_available'
 * (clientes esperando un aviso que nunca iba a llegar). Es una red de
 * seguridad, no reemplaza el mecanismo normal.
 *
 * La dirección de envío sale de `agent_conversations.chat_jid` (la real
 * que usa WhatsApp), no de reconstruirla desde el teléfono: para chats
 * identificados por LID la reconstruida no existe y WhatsApp descarta el
 * mensaje sin dar error.
 */
export async function runStockNotificationJob(sock: WASocket): Promise<void> {
  // Avisar "llegó tu repuesto" es escribirle a un cliente sin que lo
  // pida. Se corta antes de consultar la base para no marcar demandas
  // como notificadas cuando el aviso no salió: si se marcaran, el cliente
  // no recibiría el aviso nunca más al reactivar el agente.
  if (config.outboundMode !== 'full') return

  const pending = await getPendingStockNotifications()
  for (const demand of pending) {
    try {
      await notifyDemand(sock, demand, false)
    } catch (err) {
      console.error(`No se pudo notificar la demanda #${demand.id}:`, err)
    }
  }

  const stuck = await getStuckPendingDemands()
  for (const demand of stuck) {
    try {
      await notifyDemand(sock, demand, true)
    } catch (err) {
      console.error(`No se pudo notificar la demanda atascada #${demand.id}:`, err)
    }
  }
}
