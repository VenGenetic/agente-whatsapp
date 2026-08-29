import { supabase } from '../supabaseClient.js'
import type { IntakeData } from '../agent/intake.js'

/**
 * La ficha que arma el agente de recepción, guardada como DATOS y no como
 * un párrafo.
 *
 * Antes de la migración 0035 esto no existía: los campos se formateaban en
 * un texto, se mandaban por WhatsApp al dueño y en la base quedaba esa
 * prosa dentro de `agent_escalations.message_snapshot`. Con eso no se
 * podía filtrar nada, ni mostrar una ficha en la bandeja, ni pasarle los
 * datos al agente vendedor sin volver a parsear un párrafo.
 *
 * Se guarda en BORRADOR desde el primer dato, no recién al final: si una
 * persona entra a mitad de la recepción tiene que ver lo que se lleva
 * juntado. Ese borrador es único por conversación (índice parcial en la
 * migración), así que llamar a `guardarBorrador` en cada mensaje completa
 * la misma fila en vez de crear una nueva.
 */

export type FichaDeRecepcion = IntakeData & {
  fotoRecibida: boolean
}

/**
 * true cuando falta la migración 0035.
 *
 * Son CUATRO códigos distintos y hay que tenerlos todos, porque PostgREST
 * usa uno diferente según qué falte y en qué operación. Se comprobó
 * corriendo esto contra la base sin la migración:
 *
 *   42703     columna inexistente al LEER (select)
 *   PGRST204  columna inexistente al ESCRIBIR (insert/update)
 *   PGRST205  tabla que no está en el cache de esquema
 *   42P01     tabla inexistente
 *
 * Faltaba PGRST204 en la primera versión, y el efecto era el peor
 * posible: el mensaje del cliente no se registraba.
 */
function faltaLaMigracion(error: { code?: string } | null | undefined): boolean {
  return (
    error?.code === '42703' ||
    error?.code === 'PGRST204' ||
    error?.code === 'PGRST205' ||
    error?.code === '42P01'
  )
}

let avisadoQueFalta = false

function avisarUnaVez(): void {
  if (avisadoQueFalta) return
  avisadoQueFalta = true
  console.warn(
    'Falta la migración 0035 (agent_intake_requests): la recepción sigue funcionando, pero la ficha no se guarda estructurada.',
  )
}

/** Los campos tal como van a la tabla. */
function comoFila(datos: FichaDeRecepcion): Record<string, unknown> {
  return {
    repuesto: datos.repuesto,
    marca: datos.marca,
    modelo: datos.modelo,
    anio: datos.anio,
    color: datos.color,
    posicion: datos.posicion,
    cilindraje: datos.cilindraje,
    observaciones: [
      datos.observaciones,
      datos.modeloDaytonaEquivalente ? `Equivalente Daytona por foto: ${datos.modeloDaytonaEquivalente}` : null,
    ].filter(Boolean).join(' | ') || null,
    foto_recibida: datos.fotoRecibida,
    updated_at: new Date().toISOString(),
  }
}

/**
 * Deja lo que se sabe hasta ahora en el borrador abierto de esa
 * conversación, creándolo si no había.
 *
 * No lanza: la ficha es para que el vendedor no empiece de cero, no es el
 * mensaje. Si falla, el cliente igual recibe su respuesta y el hilo queda
 * completo, que es lo que de verdad no se puede perder.
 */
export async function guardarBorrador(conversationId: number, datos: FichaDeRecepcion): Promise<void> {
  const { data: abierto, error: errorBuscar } = await supabase
    .from('agent_intake_requests')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('estado', 'borrador')
    .maybeSingle()

  if (errorBuscar) {
    if (faltaLaMigracion(errorBuscar)) avisarUnaVez()
    else console.error('No se pudo buscar el borrador de la ficha:', errorBuscar.message)
    return
  }

  if (abierto) {
    const { error } = await supabase.from('agent_intake_requests').update(comoFila(datos)).eq('id', abierto.id)
    if (error) console.error('No se pudo actualizar el borrador de la ficha:', error.message)
    return
  }

  const { error } = await supabase
    .from('agent_intake_requests')
    .insert({ conversation_id: conversationId, estado: 'borrador', ...comoFila(datos) })
  if (error) {
    // 23505: otro mensaje de la misma ráfaga creó el borrador entre la
    // consulta y este insert. No es un problema -- el dato ya está.
    if (error.code === '23505') return
    if (faltaLaMigracion(error)) avisarUnaVez()
    else console.error('No se pudo crear el borrador de la ficha:', error.message)
  }
}

/**
 * Cierra la ficha: pasa de borrador a lista para un vendedor.
 *
 * `catalogoSugerido` es lo que encontró la búsqueda con esos datos en este
 * momento. Va guardado con su fecha y como ayuda, no como afirmación: el
 * stock y el precio cambian, y el vendedor tiene que poder ver que ese
 * dato es de cuando se cerró la ficha.
 *
 * Devuelve el id de la ficha, o null si no se pudo guardar.
 */
export async function marcarFichaLista(
  conversationId: number,
  datos: FichaDeRecepcion,
  catalogoSugerido?: unknown,
): Promise<number | null> {
  const fila = {
    ...comoFila(datos),
    estado: 'lista',
    lista_at: new Date().toISOString(),
    ...(catalogoSugerido === undefined ? {} : { catalogo_sugerido: catalogoSugerido }),
  }

  const { data: abierto } = await supabase
    .from('agent_intake_requests')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('estado', 'borrador')
    .maybeSingle()

  if (abierto) {
    const { data, error } = await supabase
      .from('agent_intake_requests')
      .update(fila)
      .eq('id', abierto.id)
      // Solo si sigue en borrador: si alguien la cerró a mano desde el ERP
      // mientras tanto, esa decisión manda sobre la nuestra.
      .eq('estado', 'borrador')
      .select('id')
      .maybeSingle()
    if (error) {
      if (faltaLaMigracion(error)) avisarUnaVez()
      else console.error('No se pudo cerrar la ficha de recepción:', error.message)
      return null
    }
    return data?.id ?? null
  }

  // Sin borrador previo (la recepción terminó en un solo mensaje, o el
  // borrador falló antes): se crea ya cerrada.
  const { data, error } = await supabase
    .from('agent_intake_requests')
    .insert({ conversation_id: conversationId, ...fila })
    .select('id')
    .maybeSingle()
  if (error) {
    if (faltaLaMigracion(error)) avisarUnaVez()
    else console.error('No se pudo crear la ficha de recepción:', error.message)
    return null
  }
  return data?.id ?? null
}
