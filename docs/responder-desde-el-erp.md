# Responderle al cliente desde el ERP

Cómo funciona la Bandeja de WhatsApp del ERP: contestar con texto, mandar
fotos y archivos, y buscar un repuesto en el catálogo para enviarlo con su
precio, sin salir de la conversación.

## Por qué no se contesta desde el teléfono

El número del bot se puede vincular al WhatsApp personal de quien atiende,
y a primera vista contestar desde ahí parece más simple. No lo es: **los
mensajes escritos desde el teléfono le llegan cifrados al proceso del
agente y nunca se pueden abrir**. Se comprobó en vivo -- 6 mensajes
enviados desde el teléfono, los 6 llegaron vacíos, con un fallo de
descifrado por cada uno. Por esa vía el ERP jamás tiene la conversación
completa: se ve lo que dijo el cliente y lo que respondió el bot, pero no
lo que contestó la persona.

Escribiendo desde el ERP, el sistema conoce el mensaje **antes** de
cifrarlo, así que queda registrado sí o sí.

## El camino de un mensaje

```
ERP (navegador)                 Supabase                 Agente (Node)            WhatsApp
     |                             |                          |                      |
  1. escribe/adjunta               |                          |                      |
     |-- sube el archivo -------> Storage                     |                      |
     |    (bucket agent_chat_media, público)                  |                      |
     |                             |                          |                      |
  2. |-- inserta ---------------> agent_outbox                |                      |
     |    (kind, body, media_url, product_id)                 |                      |
     |                             | <---- lee cada 3s -------|                      |
     |                             |                          |-- sendMessage -----> |
     |                             |                          |    (image + caption) |
     |                             | <-- guarda el mensaje ---|                      |
     |                             |     (agent_messages)     |                      |
  3. | <-- realtime ---------------|                          |                      |
     |    (la burbuja "en cola" pasa a mensaje real)          |                      |
```

El navegador **no** tiene la sesión de WhatsApp -- la tiene el proceso del
agente. Por eso es una cola y no una llamada directa: el ERP encola, el
agente despacha, y el estado de cada mensaje queda a la vista.

Las fotos se mandan **por URL**: Baileys las descarga del bucket público.
Por eso ese bucket tiene que ser público -- una URL firmada que vence
rompería el envío de un mensaje que se quedó un rato en la cola.

## Qué se puede hacer desde la bandeja

| Acción | Cómo |
| --- | --- |
| Escribir | Enter envía, Shift+Enter salta de línea |
| Mandar una foto | Botón *Adjuntar*, **Ctrl+V** para pegar, o arrastrarla al chat |
| Mandar un archivo | Igual que una foto (PDF, video, audio) |
| **Grabar una nota de voz** | Botón *Nota de voz*; se escucha antes de mandarla |
| **Ver fotos, escuchar audios** | Se ven y se escuchan en el hilo, sin salir |
| Enviar un repuesto | Botón *Catálogo*: busca, elegís, se manda foto + precio + disponibilidad |
| Varias fotos del mismo repuesto | En el catálogo, marcás las de la galería que quieras |
| Respuestas rápidas | Botón *Rápidas*, o escribí `/` al principio del mensaje |
| Guardar una frase que se repite | *Guardar como rápida*, con el texto escrito |
| Cancelar lo que todavía no salió | *Cancelar*, en la burbuja "En cola" |
| Reintentar lo que falló | *Reintentar*, en la burbuja roja |
| Ver la foto que mandó el cliente | Se ve en el hilo; clic para agrandarla |
| **Cotizar varios repuestos** | Botón *Proforma*: se arma y sale como imagen |
| **Anotar un repuesto que no hay** | Botón *Anotar pedido* |
| **Cobrar lo cotizado** | *Cobrar en el POS*, dentro de la proforma |

### La proforma

El caso real: el cliente pide tres o cuatro piezas y hay que cotizarlas
juntas, con total y envío. Antes eso obligaba a salir del ERP, armarla en
la pantalla del POS, exportarla como imagen y volver a WhatsApp a
adjuntarla — y esa proforma quedaba atada al POS, no a ese cliente.

- **Un borrador por conversación** (`store/useChatProformaStore.ts`). El
  vendedor atiende varios chats a la vez; con un solo borrador global le
  mandaría a un cliente los repuestos del otro. Se guarda en el navegador,
  así que cambiar de chat o recargar la página no lo pierde.
- **Se manda como imagen**, no como PDF: en WhatsApp una imagen se ve en el
  chat sin abrir nada, y un PDF hay que descargarlo — muchos clientes no lo
  abren. Opcionalmente va también el detalle en texto, que es lo que se
  puede copiar, buscar y reenviar.
- **La hoja es la misma del POS** (`components/whatsapp/ProformaDocument.tsx`
  replica el diseño de `ProformaPreviewModal`): el cliente puede recibir una
  cotización por WhatsApp hoy y otra en el mostrador mañana, y tienen que
  parecer del mismo negocio.
- **Vista previa real**: se ve la hoja tal cual la va a recibir el cliente,
  encogida con `transform: scale` para que la caja de captura siga midiendo
  650px y la imagen no cambie.
- **Cobrar en el POS** carga el carrito con `utils/proformaToCart.ts` — la
  misma conversión que usan el panel de escritorio y el modo móvil. Si algún
  repuesto no entra limpio (sin bodega, sin stock), se avisa **antes** de ir
  a la caja. El borrador no se borra: si la venta se cae, la proforma sigue
  ahí.

### La ficha del cliente

Al costado del chat, no detrás de un clic: lo que dice hay que tenerlo a la
vista **mientras** se cotiza.

- Si el número está registrado en `customers`, y **con qué descuento** — sin
  eso se cotiza de más y el cliente reclama.
- Qué repuestos dejó pedidos y en qué estado.
- **Cuáles ya llegaron**, con un botón para cotizarlos al toque: ese es el
  caso donde más rápido hay que reaccionar, el repuesto está en bodega y el
  cliente está escribiendo justo ahora.

El vínculo se busca por los **últimos 9 dígitos** del teléfono:
`agent_conversations` guarda solo dígitos (migración 0021) y
`customers.phone` está cargado a mano de mil formas (`+593`, `0`, espacios).

### Anotar un pedido

Cuando el repuesto no está, se anota desde el chat en `product_demands` — la
misma tabla de la pantalla de Solicitudes. Se hace acá porque el momento en
que se sabe que falta es éste, hablando con el cliente; si hay que ir a otra
pantalla, no se carga, y cuando el repuesto llega nadie sabe a quién
avisarle. No duplica un pedido ya vivo del mismo repuesto (recibiría dos
avisos), y si el repuesto **sí** tiene stock lo advierte: conviene venderlo,
no dejarlo esperando.

### Fotos, audios y archivos en el hilo

Todo se ve y se escucha **dentro de la conversación**: la foto en la
burbuja (clic para agrandarla), la nota de voz con su propio reproductor
—play, barra arrastrable y duración—, el video con controles, y el archivo
como tarjeta con su nombre.

Antes el hilo decía "(foto)" o "(nota de voz)" y había que abrir el
WhatsApp del teléfono para verlos, justo en el momento de decidir qué
contestar. En este negocio eso pesa: se midieron **585 notas de voz** y
**1.083 fotos** recibidas — muchos pedidos llegan como foto de la pieza, o
como audio del cliente que va manejando.

Dos detalles del reproductor de audio: no usa el `<audio controls>` nativo
(mide ~300px, no entra en una burbuja y se ve distinto en cada navegador),
y **pausa cualquier otra nota que esté sonando** — dos audios encimados no
se entienden. Las notas de WhatsApp son OGG/Opus: Chrome y Firefox las
reproducen, Safari no, así que ahí se ofrece el enlace de descarga en vez
de un reproductor mudo.

Los mensajes anteriores a esta función y los del historial importado
aparecen marcados como *"archivo no guardado"*: WhatsApp no reentrega la
media vieja.

### Notas de voz

El botón *Nota de voz* graba desde el navegador, deja **escucharla antes de
enviarla** (una nota sale una sola vez y no se puede borrar del teléfono
del cliente) y la manda como nota de voz de verdad — con la onda, no como
archivo adjunto. Corta sola a los 3 minutos.

El formato se elige entre lo que soporte el navegador, prefiriendo
OGG/Opus, que es el que usa WhatsApp; Chrome graba WebM/Opus, mismo códec.
Se manda el mimetype **real**, sin mentirle a WhatsApp sobre el contenedor.

### El precio lo pone el catálogo, no la memoria

El texto que arma el buscador usa **las mismas reglas que el bot**:

- **Precio**: `products.price` redondeado hacia arriba al dólar entero
  (`$45.20` → `$46.00`). Misma regla que `src/utils/pricing.ts`.
- **Disponibilidad**: hay stock si `local_stock > 0`, o si el importador
  tiene y **no** está marcado "Agotado en Importadora"
  (`importer_unavailable_override`), que es la marca manual del ERP para
  decir que el dato del proveedor no es confiable.

Así el cliente escucha lo mismo conteste quien conteste. El texto se puede
editar antes de enviarlo: **lo que se manda es exactamente lo que quedó en
pantalla**.

### La búsqueda es la misma del bot

El buscador del catálogo llama al RPC `agent_search_products` -- alias
aprendidos, similitud pg_trgm, tolerancia a errores de tipeo y las
abreviaturas del catálogo (`delantero` → `DEL`, `trasero` → `POST`). Si el
bot encuentra un repuesto con el nombre que usa el cliente, quien atiende
lo encuentra igual.

## Las fotos que manda el cliente

En repuestos, buena parte de los pedidos llegan como foto de la pieza. El
agente ahora **copia esa foto a Storage** apenas llega y la deja visible en
el hilo del ERP.

Es importante que sea al llegar: **WhatsApp no reentrega la media vieja**.
Las claves de descifrado viajan con el mensaje y los servidores la borran,
así que lo que no se guarde en el momento se pierde para siempre. Por eso
la copia corre incluso en conversaciones donde el bot no va a contestar.

Corre en segundo plano: si la descarga tarda o falla, el mensaje del
cliente ya quedó registrado igual y la respuesta no se demora.

Los mensajes que se importaron del historial al vincular el teléfono **no**
tienen foto: son de antes de que existiera esta copia, y WhatsApp no la
vuelve a entregar.

## Cuando el mensaje no va a salir

Tres cosas lo impiden, y las tres se avisan en pantalla antes de escribir
(recuadro amarillo arriba de la bandeja):

1. **El agente está caído.** El proceso deja un latido en `agent_settings`
   cada 30s; si tiene más de 2 minutos, se da por caído. Lo que se encole
   sale cuando vuelva.
2. **No está conectado a WhatsApp.** Está reconectando; la cola se despacha
   sola cuando la sesión vuelve.
3. **`OUTBOUND_MODE=blocked`.** El freno del servidor
   (`src/whatsapp/outboundGuard.ts`) no deja salir nada, ni lo que escriba
   una persona. Para responder desde el ERP hace falta `erp_only` (el bot
   sigue sin contestar solo) o `full`.

Si un mensaje sale igual pero la foto falla, se manda **solo el texto** y
queda anotado en el mensaje que la foto no salió -- el texto es el que
lleva el precio, y perderlo entero por un problema de subida es peor. En el
ERP se ve la aclaración; nadie queda creyendo que el cliente vio la foto.

## Puesta en marcha

1. Aplicar en Supabase (SQL Editor), en orden:
   - `supabase/migrations/0026_agent_outbox_media.sql`
   - `supabase/migrations/0027_agent_heartbeat.sql`
2. Comprobar que quedó todo: `npm run verificar-envio`
   (no manda ningún mensaje, solo lee).
3. Poner `OUTBOUND_MODE=erp_only` en el `.env` del agente y reiniciar el
   proceso. Comprobar el freno con `npm run verificar-freno`.

## Esquema

- `agent_outbox` -- la cola. `kind` (text/image/video/document), `body`
  (texto o pie de foto), `media_url`, `media_mime`, `media_filename`,
  `product_id` (trazabilidad), `status`
  (pending/sent/failed/**canceled**), `sent_message_id` (enlace al mensaje
  real, para no mostrarlo dos veces en el hilo).
- `agent_messages.media_url` -- copia en Storage de la foto/audio/archivo.
- `agent_quick_replies` -- respuestas rápidas (baja lógica con
  `is_active`).
- `agent_settings.agent_last_seen_at` / `agent_connection` /
  `agent_outbound_mode` -- el latido del agente.
- Bucket `agent_chat_media` (público) -- media del chat, en dos carpetas:
  `chats/{conversationId}/` lo que entra, `erp/{año-mes}/` lo que se
  adjunta desde el ERP.
