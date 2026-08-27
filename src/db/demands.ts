import { config } from '../config.js'
import { supabase } from '../supabaseClient.js'

/**
 * Registra una demanda de producto sin stock. Reusa `product_demands` tal
 * como lo pide el diseño -- no hay tabla paralela. El índice único
 * (phone_number, product_id) sobre demandas activas hace el trabajo de
 * "no duplicar"; acá solo interpretamos la violación de esa constraint.
 *
 * `config.demandRegistrationEnabled` (env `DEMAND_REGISTRATION_ENABLED`)
 * lo apaga sin tocar el resto del flujo -- para pruebas en vivo sin
 * ensuciar `product_demands` con datos falsos. El bot sigue contestando
 * "no hay stock, ya quedó anotado" igual (así la conversación se prueba
 * completa), solo que no queda nada guardado en la base.
 */
export async function registerProductDemand(params: {
  productId: number
  phoneNumber: string
  customerName: string | null
  notes: string | null
}): Promise<{ alreadyRegistered: boolean }> {
  if (!config.demandRegistrationEnabled) {
    console.log(`[DEMAND_REGISTRATION_ENABLED=false] no se guardó la demanda de prueba (producto ${params.productId}, ${params.phoneNumber})`)
    return { alreadyRegistered: false }
  }

  const { error } = await supabase.from('product_demands').insert({
    product_id: params.productId,
    phone_number: params.phoneNumber,
    customer_name: params.customerName,
    notes: params.notes,
  })

  if (!error) return { alreadyRegistered: false }
  if (error.code === '23505') return { alreadyRegistered: true }
  throw error
}

/**
 * Registra que un cliente pidió algo que ni existe en el catálogo.
 * `product_id` queda null a propósito -- no hay producto que asociar.
 */
export async function registerLostDemand(searchTerm: string): Promise<void> {
  const { error } = await supabase.from('lost_demand').insert({
    search_term: searchTerm,
    product_id: null,
    reason: 'not_in_catalog',
    channel: 'WHATSAPP',
  })
  if (error) throw error
}

/**
 * Demandas listas para avisar (`stock_available` sin `notified_at`) que el
 * job periódico de aviso debe procesar. Espeja la transición manual que ya
 * existe en pages/ProductDemands.tsx del ERP.
 */
export type PendingNotification = {
  id: number
  productId: number
  phoneNumber: string
  customerName: string | null
}

/*
  AVISAR = ESTÁ EN LA BODEGA.

  El stock de la importadora no cuenta para avisar, aunque el repuesto
  exista y venga en camino: decirle a alguien "ya llegó lo que pediste"
  cuando todavía no lo tenemos en la mano es prometer una fecha que no
  controlamos, y el cliente viene al mostrador y no está.

  Es la misma regla que aplica el ERP en el aviso manual desde la bandeja
  (`FILTRO_EN_BODEGA` en components/whatsapp/avisarLlegada.ts) y en la
  tarjeta "Listos para Notificar". Las dos tienen que decir lo mismo: si
  este job se enciende con la regla vieja, le avisaría a clientes que el
  ERP a propósito no muestra como avisables.

  Ojo con `status = 'stock_available'`: desde la migración
  20260827150000 ese estado significa "hay stock en algún lado", que es
  MÁS amplio que esto. Por eso el filtro va igual acá, sobre el producto.
*/
export async function getPendingStockNotifications(): Promise<PendingNotification[]> {
  const { data, error } = await supabase
    .from('product_demands')
    // `!inner` para que el filtro de stock descarte DEMANDAS y no solo el
    // producto embebido.
    .select('id, product_id, phone_number, customer_name, products!inner(local_stock)')
    .eq('status', 'stock_available')
    .is('notified_at', null)
    .gt('products.local_stock', 0)

  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    productId: row.product_id,
    phoneNumber: row.phone_number,
    customerName: row.customer_name,
  }))
}

/**
 * Red de seguridad: demandas que quedaron en 'pending_stock' aunque el
 * producto YA tiene stock real disponible. sistema_erp tiene un trigger
 * (`trg_products_stock_arrival`) que debería pasarlas a 'stock_available'
 * solo con que `products.local_stock`/`importer_stock` suba de 0 a
 * positivo -- pero se encontraron casos reales donde no se disparó (2
 * clientes esperando un producto que ya tenía stock desde hacía días, sin
 * ningún aviso en camino). Como `getPendingStockNotifications` solo mira
 * `status = 'stock_available'`, esos casos quedaban invisibles para
 * siempre. Acá se recalcula el stock "real" con las mismas reglas que
 * usa la búsqueda del agente (is_active, is_discontinued/discontinued_until,
 * importer_unavailable_override) en vez de confiar en el trigger.
 */
export async function getStuckPendingDemands(): Promise<PendingNotification[]> {
  const { data: pending, error } = await supabase
    .from('product_demands')
    .select('id, product_id, phone_number, customer_name')
    .eq('status', 'pending_stock')
  if (error) throw error
  if (!pending || pending.length === 0) return []

  const productIds = [...new Set(pending.map((d) => d.product_id))]
  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, local_stock, importer_stock, importer_unavailable_override, is_active, is_discontinued, discontinued_until')
    .in('id', productIds)
  if (productsError) throw productsError

  const now = new Date()
  const availableProductIds = new Set(
    (products ?? [])
      .filter((p) => {
        if (p.is_active === false) return false
        const stillDiscontinued = p.is_discontinued && (!p.discontinued_until || new Date(p.discontinued_until) > now)
        if (stillDiscontinued) return false
        // Solo bodega propia, igual que `getPendingStockNotifications`:
        // la importadora no habilita un aviso. Por eso tampoco hace falta
        // mirar `importer_unavailable_override`, que solo corrige el
        // número del proveedor.
        return (p.local_stock ?? 0) > 0
      })
      .map((p) => p.id),
  )

  return pending
    .filter((d) => availableProductIds.has(d.product_id))
    .map((row) => ({
      id: row.id,
      productId: row.product_id,
      phoneNumber: row.phone_number,
      customerName: row.customer_name,
    }))
}

export async function markDemandNotified(demandId: number, options?: { alsoBackfillStockDetectedAt?: boolean }): Promise<void> {
  const update: Record<string, string> = { status: 'notified', notified_at: new Date().toISOString() }
  // Si venía de 'pending_stock' (agarrada por getStuckPendingDemands), el
  // trigger normal nunca corrió -- stock_detected_at quedaría NULL para
  // siempre si no se completa acá también.
  if (options?.alsoBackfillStockDetectedAt) update.stock_detected_at = update.notified_at
  const { error } = await supabase.from('product_demands').update(update).eq('id', demandId)
  if (error) throw error
}
