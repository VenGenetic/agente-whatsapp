import type { AnyMessageContent, WASocket } from '@whiskeysockets/baileys'
import { type ContentType, logOutboundMessage } from '../db/conversations.js'
import { supabase } from '../supabaseClient.js'
import { toChatJid } from '../utils/phone.js'
import { conPermiso } from '../whatsapp/outboundGuard.js'
import {
  claveDe,
  contenidoBorrar,
  contenidoEditar,
  contenidoReaccion,
  marcarLeidoEnWhatsApp,
  marcarNoLeidoEnWhatsApp,
  mensajeCitado,
} from './outboxActions.js'

/** Tope por vuelta: si se acumulan muchos, se mandan de a tandas. */
const POR_VUELTA = 5
/** A partir de acá se deja de reintentar y queda marcado como fallido. */
const MAX_INTENTOS = 3

/** Lo que puede llevar un mensaje encolado desde el ERP (migraciones 0026 y 0030). */
type TipoSalida = 'text' | 'image' | 'video' | 'document' | 'audio' | 'delete' | 'reaction' | 'edit' | 'read' | 'unread'

type Pendiente = {
  id: number
  conversation_id: number
  body: string | null
  kind: TipoSalida
  media_url: string | null
  media_mime: string | null
  media_filename: string | null
  is_voice_note: boolean
  target_wa_id: string | null
  reply_to_wa_id: string | null
  reaction_emoji: string | null
  product_id: number | null
  intentos: number
  agent_conversations: { phone_number: string; lid: string | null; chat_jid: string | null } | null
}

/** `kind` de la cola -> `content_type` del historial de mensajes. */
const TIPO_A_CONTENIDO: Partial<Record<TipoSalida, ContentType>> = {
  text: 'text',
  image: 'image',
  video: 'video',
  document: 'document',
  audio: 'audio',
}

/** Los tipos que mandan un archivo y por lo tanto lo necesitan. */
const LLEVAN_ARCHIVO = new Set<TipoSalida>(['image', 'video', 'document', 'audio'])


/**
 * Arma el mensaje para Baileys.
 *
 * Las fotos y archivos se mandan POR URL (Baileys los descarga del bucket
 * público, ver migración 0026) en vez de subir bytes desde acá: el archivo
 * ya está en Supabase porque el ERP lo subió, y volver a moverlo por este
 * proceso solo agrega una copia y un punto de falla más.
 */
async function construirContenido(item: Pendiente, chatJid: string): Promise<AnyMessageContent | null> {
  const caption = item.body?.trim() ? item.body : undefined

  // Acciones sobre un mensaje que ya existe (migración 0031). Necesitan la
  // CLAVE del mensaje, que se reconstruye con lo guardado -- ver
  // outboxActions.ts. Si el mensaje no está registrado no se puede actuar
  // sobre él, y devolver null lo marca como fallido con un motivo claro en
  // vez de mandarle a WhatsApp una clave inventada.
  if (item.kind === 'delete' || item.kind === 'reaction' || item.kind === 'edit') {
    const clave = await claveDe(item.target_wa_id!, chatJid)
    if (!clave) return null
    if (item.kind === 'delete') return contenidoBorrar(clave)
    if (item.kind === 'reaction') return contenidoReaccion(clave, item.reaction_emoji ?? '')
    return contenidoEditar(clave, item.body ?? '')
  }

  // Responder citando: WhatsApp dibuja la tarjetita con el mensaje al que
  // se contesta. Si el citado ya no está, se manda igual sin la cita --
  // perder la cita es mejor que no mandar la respuesta.
  const quoted = item.reply_to_wa_id ? await mensajeCitado(item.reply_to_wa_id, chatJid) : null
  const opciones = quoted ? { quoted } : {}

  switch (item.kind) {
    case 'image':
      return { image: { url: item.media_url! }, caption, ...opciones }
    case 'video':
      return { video: { url: item.media_url! }, caption, ...opciones }
    case 'audio':
      return {
        audio: { url: item.media_url! },
        // WhatsApp decide por el mimetype si puede reproducirlo en el
        // chat. Un audio sin mimetype le llega al cliente como archivo
        // que hay que descargar.
        mimetype: item.media_mime ?? 'audio/ogg; codecs=opus',
        // `ptt` = nota de voz: sale con la onda y se escucha de una. Sin
        // esto, hasta una grabación del vendedor se ve como un adjunto.
        ptt: item.is_voice_note,
        // Sin caption a propósito: WhatsApp lo ignora en los audios, así
        // que si el ERP mandó texto va como mensaje aparte (ver 0030).
      }
    case 'document':
      return {
        document: { url: item.media_url! },
        // Sin `fileName` WhatsApp muestra el archivo como "documento" a
        // secas y el cliente no sabe qué está por abrir.
        fileName: item.media_filename ?? 'archivo',
        mimetype: item.media_mime ?? 'application/octet-stream',
        caption,
        ...opciones,
      }
    case 'text':
    default:
      return { text: item.body ?? '', ...opciones }
  }
}

/**
 * Envía por WhatsApp lo que el equipo escribió desde el ERP (tabla
 * `agent_outbox`, migraciones 0024 y 0026): texto, fotos del repuesto,
 * archivos, y las fichas de producto que se arman desde el buscador del
 * catálogo.
 *
 * Existe porque los mensajes escritos desde el teléfono llegan cifrados y
 * el agente no puede leerlos, así que nunca quedan registrados. Escritos
 * desde el ERP sí: el sistema conoce el contenido antes de mandarlo.
 *
 * El mensaje se guarda en `agent_messages` recién DESPUÉS de que WhatsApp
 * acepta el envío -- al revés quedaría en el historial algo que nunca
 * salió.
 */
/** Columnas que existen desde la migración 0026. */
const CAMPOS_BASE =
  'id, conversation_id, body, kind, media_url, media_mime, media_filename, product_id, intentos, agent_conversations ( phone_number, lid, chat_jid )'
/** Con la nota de voz (migración 0030) y las acciones (0031). */
const CAMPOS_COMPLETOS =
  'id, conversation_id, body, kind, media_url, media_mime, media_filename, is_voice_note, target_wa_id, reply_to_wa_id, reaction_emoji, product_id, intentos, agent_conversations ( phone_number, lid, chat_jid )'

/**
 * Lee los pendientes.
 *
 * `is_voice_note` llegó con la migración 0030, y si esa migración todavía
 * no se aplicó la consulta entera falla con 42703 -- o sea que dejaría de
 * salir TODO lo que el equipo escribe, no solo las notas de voz. Un
 * archivo de migración sin aplicar no puede romper una función que ya
 * andaba: si falta la columna, se lee sin ella y las notas de voz salen
 * como audio normal hasta que se aplique.
 */
async function leerPendientes(): Promise<Pendiente[]> {
  const consulta = (campos: string) =>
    supabase
      .from('agent_outbox')
      .select(campos)
      .eq('status', 'pending')
      .lt('intentos', MAX_INTENTOS)
      // Orden de escritura: si alguien manda tres fotos y después el
      // precio, al cliente le tienen que llegar en ese mismo orden.
      .order('created_at', { ascending: true })
      .limit(POR_VUELTA)

  const { data, error } = await consulta(CAMPOS_COMPLETOS)
  if (!error) return (data ?? []) as unknown as Pendiente[]

  if (error.code !== '42703') throw error
  // Falta alguna de las migraciones nuevas. Se sigue enviando con lo
  // básico en vez de dejar de despachar TODO: un archivo de migración sin
  // aplicar no puede romper el envío de texto, que funcionaba desde antes.
  console.warn(
    'Faltan columnas de agent_outbox (migraciones 0030/0031): ' +
      'se despacha sin notas de voz ni acciones sobre mensajes hasta aplicarlas.',
  )
  const { data: basico, error: errorBasico } = await consulta(CAMPOS_BASE)
  if (errorBasico) throw errorBasico
  return ((basico ?? []) as unknown[]).map((f) => ({
    ...(f as Pendiente),
    is_voice_note: false,
    target_wa_id: null,
    reply_to_wa_id: null,
    reaction_emoji: null,
  }))
}

export async function runOutboxJob(sock: WASocket): Promise<void> {
  const pendientes = await leerPendientes()
  if (pendientes.length === 0) return

  for (const item of pendientes) {
    const conversacion = item.agent_conversations
    if (!conversacion) {
      await supabase
        .from('agent_outbox')
        .update({ status: 'failed', error: 'La conversación ya no existe' })
        .eq('id', item.id)
      continue
    }

    // Un mensaje de media sin archivo saldría vacío. La migración lo
    // prohíbe con un CHECK, pero una fila vieja o cargada a mano podría
    // colarse -- mejor marcarla fallida que mandar un mensaje en blanco.
    if (LLEVAN_ARCHIVO.has(item.kind) && !item.media_url) {
      await supabase
        .from('agent_outbox')
        .update({ status: 'failed', error: 'El mensaje es de tipo archivo pero no tiene archivo adjunto' })
        .eq('id', item.id)
      continue
    }

    const esUltimoIntento = item.intentos + 1 >= MAX_INTENTOS

    try {
      // Dirección real del chat, nunca reconstruida (ver migración 0022).
      const jid =
        conversacion.chat_jid ??
        toChatJid({ phone_number: conversacion.phone_number, lid: conversacion.lid })

      // Marcar leído no manda nada al chat: es un acuse, así que va por su
      // propio camino y ni pasa por el freno de salida (no le llega un
      // mensaje al cliente, solo se le pone el tilde azul a lo que ya
      // mandó él).
      if (item.kind === 'read') {
        const cuantos = await marcarLeidoEnWhatsApp(sock, item.conversation_id, jid)
        await supabase
          .from('agent_outbox')
          .update({ status: 'sent', sent_at: new Date().toISOString(), error: null })
          .eq('id', item.id)
        console.log(`Outbox: ${cuantos} mensaje(s) marcados como leídos en ${jid}.`)
        continue
      }

      // Y la vuelta: dejar el chat pendiente también en el teléfono. Tampoco
      // le llega nada al cliente, así que tampoco pasa por el freno.
      if (item.kind === 'unread') {
        await marcarNoLeidoEnWhatsApp(sock, item.conversation_id, jid)
        await supabase
          .from('agent_outbox')
          .update({ status: 'sent', sent_at: new Date().toISOString(), error: null })
          .eq('id', item.id)
        console.log(`Outbox: chat ${jid} marcado como NO leído.`)
        continue
      }

      const contenido = await construirContenido(item, jid)
      if (!contenido) {
        await supabase
          .from('agent_outbox')
          .update({
            status: 'failed',
            error: 'El mensaje sobre el que se quería actuar ya no está registrado',
          })
          .eq('id', item.id)
        continue
      }

      // Único canal que puede llegarle a un cliente con el freno en
      // `erp_only`: acá el contenido lo escribió una persona del equipo y
      // lo mandó a propósito desde el ERP. Los envíos automáticos del
      // agente no llevan esta marca y quedan frenados.
      const sent = await conPermiso('human_erp', () => sock.sendMessage(jid, contenido))

      // El freno devuelve `undefined` cuando bloquea. Sin este chequeo el
      // mensaje quedaba marcado como 'sent' y el equipo del ERP veía
      // "enviado" un mensaje que el cliente nunca recibió -- justo el
      // engaño que el acuse de recibo (migración 0023) vino a eliminar.
      if (!sent) {
        await supabase
          .from('agent_outbox')
          .update({
            status: 'failed',
            error: 'Frenado por OUTBOUND_MODE: el agente tiene bloqueada la salida a clientes',
          })
          .eq('id', item.id)
        console.warn(`Outbox: mensaje #${item.id} NO salió (freno de salida activo).`)
        continue
      }

      // A PARTIR DE ACÁ EL MENSAJE YA ESTÁ EN EL TELÉFONO DEL CLIENTE.
      //
      // Lo que sigue es anotarlo en nuestra base, y eso puede fallar por su
      // cuenta (un corte con Supabase, un choque de clave). Cuando eso
      // pasaba, el fallo caía en el `catch` de abajo y se trataba como si
      // el envío hubiera fallado: se sumaba un intento y el mensaje se
      // MANDABA DE NUEVO -- el cliente lo recibía dos y tres veces -- y al
      // agotar los intentos el ERP mostraba "No se pudo enviar" sobre un
      // mensaje que el cliente ya tenía.
      //
      // Un envío no se puede deshacer, así que un fallo posterior nunca
      // puede reabrirlo. La fila se cierra igual y el problema de registro
      // queda anotado como aviso.
      await registrarSinReenviar(item, sent?.key?.id ?? null, item.kind, item.media_url, null)
      console.log(`Outbox: mensaje #${item.id} (${item.kind}) enviado a ${jid}.`)
    } catch (err) {
      const mensaje = err instanceof Error ? err.message : String(err)

      // Último intento de un mensaje con foto y con texto: antes de darlo
      // por perdido se manda al menos el texto. Se comprobó en vivo que la
      // subida de imagen a WhatsApp puede fallar ("Connection Closed")
      // mientras el texto plano sigue saliendo bien -- y el texto es el que
      // lleva el precio y la disponibilidad. Queda anotado que la foto no
      // salió: el ERP lo muestra, así nadie cree que el cliente la vio.
      if (esUltimoIntento && LLEVAN_ARCHIVO.has(item.kind) && item.body?.trim()) {
        try {
          const jid =
            conversacion.chat_jid ??
            toChatJid({ phone_number: conversacion.phone_number, lid: conversacion.lid })
          const soloTexto = await conPermiso('human_erp', () => sock.sendMessage(jid, { text: item.body! }))
          if (soloTexto) {
            // Mismo caso: el texto ya salió, anotarlo no puede reenviarlo.
            await registrarSinReenviar(
              item,
              soloTexto?.key?.id ?? null,
              'text',
              null,
              `Se envió solo el texto: el archivo no se pudo mandar (${mensaje})`,
            )
            console.warn(`Outbox: mensaje #${item.id} salió sin el archivo adjunto.`)
            continue
          }
        } catch (errTexto) {
          console.error(`Outbox: el respaldo de solo texto del #${item.id} también falló:`, errTexto)
        }
      }

      const intentos = item.intentos + 1
      await supabase
        .from('agent_outbox')
        .update({
          intentos,
          // Recién se da por perdido tras varios intentos: una caída
          // momentánea de red no debería descartar el mensaje.
          status: intentos >= MAX_INTENTOS ? 'failed' : 'pending',
          error: mensaje,
        })
        .eq('id', item.id)
      console.error(`Outbox: fallo enviando el mensaje #${item.id} (intento ${intentos}):`, mensaje)
    }
  }
}

/**
 * Anota un mensaje QUE YA SALIÓ, pase lo que pase con la base.
 *
 * Si el registro falla, la fila se cierra igual como enviada: es la única
 * respuesta correcta cuando el cliente ya lo tiene en el teléfono.
 * Reintentar sería mandárselo otra vez, y marcarlo fallido sería mentirle
 * a quien lo escribió.
 *
 * Lo que sí queda es el aviso, para que se vea que el historial de esa
 * conversación puede tener un hueco.
 */
async function registrarSinReenviar(
  item: Pendiente,
  whatsappMessageId: string | null,
  tipo: TipoSalida,
  mediaUrl: string | null,
  aviso: string | null,
): Promise<void> {
  try {
    await guardarEnvio(item, whatsappMessageId, tipo, mediaUrl, aviso)
  } catch (err) {
    const detalle = err instanceof Error ? err.message : String(err)
    console.error(`Outbox: el mensaje #${item.id} SALIÓ pero no se pudo registrar:`, detalle)
    try {
      await supabase
        .from('agent_outbox')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          error: `El mensaje se envió, pero no se pudo anotar en el historial (${detalle})`,
        })
        .eq('id', item.id)
    } catch (err2) {
      // Si tampoco se puede cerrar la fila, el próximo turno la va a
      // reintentar y el cliente puede recibirla repetida. No hay nada
      // mejor que hacer desde acá, pero tiene que quedar dicho.
      console.error(
        `Outbox: TAMPOCO se pudo cerrar la fila #${item.id}. Puede reenviarse y llegarle repetido al cliente.`,
        err2,
      )
    }
  }
}

/**
 * Deja el mensaje en el historial y cierra la fila de la cola.
 *
 * El id del mensaje guardado se anota en la cola (`sent_message_id`) para
 * que el ERP pueda sacar del hilo la burbuja "en cola" en cuanto aparece
 * la real, sin mostrar el mismo mensaje dos veces.
 */
async function guardarEnvio(
  item: Pendiente,
  whatsappMessageId: string | null,
  tipo: TipoSalida,
  mediaUrl: string | null,
  aviso: string | null,
): Promise<void> {
  // Borrar y reaccionar NO crean un mensaje nuevo en el historial: actúan
  // sobre uno que ya está. Se anota el efecto en ESE mensaje.
  //
  // El borrado marca, no elimina: la conversación es el registro de lo que
  // pasó, y hacer desaparecer de nuestro propio historial una cotización
  // equivocada es justo lo contrario de lo que sirve cuando después hay
  // que entender un reclamo. El ERP lo muestra tachado, como WhatsApp.
  if (tipo === 'delete' || tipo === 'reaction') {
    const cambio =
      tipo === 'delete'
        ? { deleted_at: new Date().toISOString() }
        : { reaction: item.reaction_emoji || null }
    await supabase.from('agent_messages').update(cambio).eq('whatsapp_message_id', item.target_wa_id!)
    await supabase
      .from('agent_outbox')
      .update({ status: 'sent', sent_at: new Date().toISOString(), error: aviso })
      .eq('id', item.id)
    return
  }

  // Editar reemplaza el texto del mensaje original en el historial: en
  // WhatsApp el cliente ve el texto corregido, así que dejar el viejo acá
  // mostraría dos cosas distintas.
  if (tipo === 'edit') {
    await supabase
      .from('agent_messages')
      .update({ body: item.body ?? '' })
      .eq('whatsapp_message_id', item.target_wa_id!)
    await supabase
      .from('agent_outbox')
      .update({ status: 'sent', sent_at: new Date().toISOString(), error: aviso })
      .eq('id', item.id)
    return
  }

  const messageId = await logOutboundMessage(item.conversation_id, {
    body: item.body ?? '',
    contentType: TIPO_A_CONTENIDO[tipo] ?? 'text',
    mediaUrl,
    productId: item.product_id,
    actionTaken: 'human_reply',
    whatsappMessageId,
    // Este mensaje lo mandamos NOSOTROS (a diferencia de los que el
    // vendedor escribe desde su teléfono, que también son 'human_reply'),
    // así que el acuse de recibo de WhatsApp sí aplica: quien lo escribió
    // desde el ERP puede ver si le llegó y si lo leyó.
    trackDelivery: true,
  })

  await supabase
    .from('agent_outbox')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      sent_message_id: messageId,
      error: aviso,
    })
    .eq('id', item.id)
}
