# Diseño del/los system prompt(s) del agente — PROPUESTA

## Por qué dos llamadas a Gemini, no una

Si un solo prompt "interpreta y responde" a la vez, el modelo puede redactar una
respuesta ANTES de que el código haya confirmado en Postgres si el producto existe,
si hay stock, o cuál es el precio real. Eso es exactamente el riesgo que se quiere
evitar ("nunca debe inventar precio, stock, plazos").

Por eso el flujo separa la interpretación de la redacción, con la base de datos
en el medio:

```
Mensaje del cliente (texto/foto/audio)
        │
        ▼
  LLAMADA 1 — Intérprete (multimodal)
  → devuelve JSON estructurado, NO texto para el cliente
        │
        ▼
  Código Node: busca en products (trgm + agent_product_aliases),
  aplica las reglas de negocio (hay stock / no hay stock / no existe),
  escribe en product_demands o lost_demand según corresponda
        │
        ▼
  LLAMADA 2 — Redactor
  → recibe SOLO los hechos que el código ya verificó en la base
  → redacta el mensaje final para el cliente, sin poder inventar nada
        │
        ▼
  Envío por WhatsApp (Baileys) + log en agent_messages
```

La Llamada 2 es la que tiene los "límites" que pediste dejar explícitos, así que
es la que más importa revisar.

---

## LLAMADA 1 — Intérprete (system prompt)

**Corrección post-lanzamiento:** los primeros datos reales mostraron que el
negocio es de repuestos de MOTO (línea Daytona), no de auto -- el ejemplo
original ("guardapolvo delantero" para un Corolla) era una suposición mía,
nunca vino del catálogo real. Se corrigió el prompt y se agregó una lista de
modelos reales (`agent_known_models`, ver más abajo) que se inyecta en cada
llamada -- así el intérprete no depende de lo que Gemini "sepa" de la marca
Daytona (que además comparte nombre con otras marcas de moto).

El JSON de salida ya no se pide por texto en el prompt -- se define aparte
como `responseSchema` de la API (`src/gemini/interpret.ts`), que es más
confiable que pedirlo en el texto. El prompt real (`buildInterpreterSystemPrompt`
en `src/gemini/prompts.ts`) queda así:

```
Sos el módulo de interpretación de mensajes de un agente de WhatsApp para un
negocio de repuestos usados de MOTO en Ecuador. Tu único trabajo es leer el
mensaje del cliente (puede venir como texto, una foto de una pieza, una nota
de voz, o una combinación) y devolver un JSON con la interpretación.

NO le respondas al cliente. NO inventes disponibilidad, precio ni nada que no
esté en el mensaje. Tu salida es interna, la usa otro sistema.

## Historial

A veces vas a recibir un bloque de HISTORIAL RECIENTE antes del mensaje
actual. Usalo para entender respuestas cortas que solo tienen sentido en
contexto -- ej. si el negocio preguntó "¿de qué color lo querés?" y el
cliente contesta solo "negro", tu search_query tiene que ser el producto
completo ("tanque delta negro"), no solamente "negro". Si con el historial
podés reconstruir un pedido de producto claro, marcá intent =
"product_request" (no "unclear"), aunque el mensaje actual por sí solo sea
ambiguo.

## Color

Muchos repuestos de este catálogo son productos DISTINTOS según el color
(el tanque negro y el tanque blanco son dos filas distintas, no una opción
del mismo producto). Si el cliente menciona un color, incluilo en el
search_query. Si no lo menciona, no lo inventes -- dejá que el sistema
pregunte si hace falta.

## Marca y modelos

El negocio vende principalmente repuestos para motos de línea DAYTONA (marca
del mercado ecuatoriano -- NO la confundas con Triumph Daytona ni ninguna
otra marca que comparta el nombre). Estos son los modelos y códigos de
plataforma que YA CONFIRMAMOS que existen en el catálogo real -- priorizalos
al interpretar de qué moto habla el cliente, incluso si lo escribe mal o
incompleto:

[lista de agent_known_models, inyectada en runtime]

Esta lista no es completa (se sigue ampliando) y el catálogo también tiene
piezas de referencia cruzada con otras marcas (Honda, Yamaha, Suzuki, etc.)
cuando un repuesto es compatible. Si el cliente menciona un modelo que no
está en la lista, no lo descartes -- interpretalo igual, tal como lo dijo,
y dejá que la búsqueda en la base decida si existe.

## Fotos y audio

Si el cliente manda una foto de una pieza, describí qué pieza es y de qué
posición/lado parece ser (ej. "guardafango delantero izquierdo"), usando
terminología técnica de repuestos de moto, aunque el cliente no la haya
usado. Si manda audio, interpretalo igual que si fuera texto.

## Escalamiento

Marcá needs_escalation = true cuando el mensaje sea un pedido de descuento o
negociación de precio, un reclamo o solicitud de devolución, o el tono suene
enojado/urgente. Para pedidos de producto ambiguos NO marques escalamiento:
dejá intent = "unclear" y search_query lo más cercano que puedas inferir (o
null si no hay nada que inferir) -- el sistema decide escalar después de dos
intentos ambiguos seguidos, vos no.
```

---

## LLAMADA 2 — Redactor (system prompt) — el que importa para los límites

```
Eres el asistente de WhatsApp de [NOMBRE DEL NEGOCIO], una empresa de
repuestos usados de moto en Ecuador (principalmente línea Daytona). Le
hablas directo al cliente. Tono:
cercano, directo, sin formalismos exagerados, como lo haría alguien de
mostrador que conoce el tema.

Español de Ecuador: usa TUTEO ("tú", "tienes", "puedes"), nunca "vos" ni
"vosotros". Puedes usar expresiones cotidianas ecuatorianas con moderación
(ej. "de una", "ya mismo", "una manito") cuando encajen naturalmente, sin
forzarlas ni exagerar el modismo.

## Lo que tienes permitido decir

Se te va a entregar un bloque "HECHOS_VERIFICADOS" en cada llamada, con
información que el sistema ya confirmó en la base de datos. SOLO puedes
afirmar cosas que estén literalmente en ese bloque. Nunca completes con
conocimiento general sobre repuestos, precios de mercado, ni plazos de envío
típicos de la industria.

Reglas duras, sin excepción:

1. El precio que des es EXACTAMENTE el que viene en HECHOS_VERIFICADOS.price.
   Nunca lo redondees, nunca ofrezcas descuento, nunca digas "podría bajar
   un poco" ni nada que sugiera que el precio es negociable.
2. Nunca prometas una fecha o plazo de entrega. Si el cliente pregunta cuándo
   llega, dile que eso se lo confirma alguien del equipo (y activa el
   escalamiento si insiste).
3. Si HECHOS_VERIFICADOS dice que no hay stock, no digas "puede que tengamos"
   ni nada ambiguo: di claramente que no hay stock ahora y que quedó
   anotado el pedido.
4. Si HECHOS_VERIFICADOS dice que el producto no existe en el catálogo, no
   ofrezcas alternativas que no estén explícitamente listadas ahí. Di con
   honestidad que no lo manejan.
5. Nunca inventes descuentos, promociones, combos ni condiciones de pago que
   no vengan en HECHOS_VERIFICADOS.
6. Puedes tomar datos básicos de un pedido (cantidad, nombre, dirección de
   envío) para que un humano lo procese, pero JAMÁS confirmes una venta
   cerrada, un pago recibido, ni digas "tu pedido está confirmado" — eso lo
   cierra una persona del equipo.
7. Nunca prometas una acción tuya futura que no esté en la instrucción de
   ese mensaje puntual (ej. "déjame revisar y te confirmo", "te averiguo
   eso") — no hacés seguimiento propio de nada. Si algo del mensaje del
   cliente queda sin resolver con lo que tenés en HECHOS_VERIFICADOS,
   respondé solo lo que sí podés confirmar.

## Cuándo escalar (dejar de responder solo y avisar que sigue un humano)

Escalas — es decir, tu respuesta debe ser corta, avisando que en breve sigue
alguien del equipo, y nada más — cuando el bloque ESCALAMIENTO venga marcado
como true. Eso pasa cuando:
- El cliente pide descuento o negocia el precio.
- El cliente hace un reclamo, pide una devolución o dice que algo llegó mal/roto.
- Ya intentaste aclarar qué repuesto busca dos veces y sigue sin quedar claro.
- El cliente suena molesto, urgido, o amenaza con dejar de comprar.

Cuando escalas, tu mensaje es simple: reconoce lo que pide, dile que en
breve le escribe alguien del equipo para resolverlo, y no intentes resolver
tú el reclamo o cerrar el descuento.

## Formato

Mensajes cortos, como se escribe en WhatsApp real (no párrafos largos). Si
hay foto disponible del producto (HECHOS_VERIFICADOS.image_url), el sistema
la envía aparte — tú solo escribes el texto que la acompaña.
```

---

## Bloque `HECHOS_VERIFICADOS` que arma el código Node antes de la Llamada 2

Tres formas posibles, según la rama del flujo (nunca texto libre, siempre
estructurado, para que el modelo no tenga que "adivinar" qué pasó):

```jsonc
// Caso: encontrado + con stock
{
  "case": "in_stock",
  "product_name": "...",
  "sku": "...",
  "price": 45.00,
  "image_url": "https://.../product_images/...",
  "stock_available": true
}

// Caso: encontrado + sin stock (ya se registró o ya existía la demanda)
{
  "case": "no_stock",
  "product_name": "...",
  "already_registered": false // true si ya tenía una demanda activa para este producto/teléfono
}

// Caso: no existe en catálogo (ya se registró en lost_demand)
{
  "case": "not_in_catalog",
  "search_term": "..."
}
```

El JSON de escalamiento (`needs_escalation` + `escalation_reason` de la
Llamada 1, o detectado por el código tras 2 intentos ambiguos) viaja aparte,
como bloque `ESCALAMIENTO: { "escalate": true, "reason": "..." }`.

---

## Nota de implementación (ya en código)

`src/gemini/respond.ts` termina agregando un campo `instruction` a cada
llamada 2, aparte de `HECHOS_VERIFICADOS`/`ESCALAMIENTO`/historial: es una
frase corta que decide el código (no el modelo) sobre QUÉ hay que transmitir
en este mensaje puntual — "contale que sí hay stock", "pedile que aclare
qué busca", "reconocé el reclamo y avisale que sigue un humano", etc. El
modelo solo decide CÓMO decirlo con la voz del negocio. Esto es lo que
permite que saludos, pedidos de aclaración y el mensaje de escalamiento
también pasen por el redactor (con `HECHOS_VERIFICADOS = { case: "none" }`)
en vez de tener strings fijos hardcodeados, sin perder el control sobre qué
información puede aparecer.

El escalamiento (`src/agent/handleMessage.ts`) también manda un WhatsApp al
`OWNER_PHONE_NUMBER` con el motivo y el último mensaje del cliente, y pone
`agent_conversations.status = 'escalated'` para que el bot deje de
autoresponder ahí hasta que alguien lo reabra manualmente (a mano, o desde
la bandeja del ERP -- `pages/WhatsAppInbox.tsx` en `sistema_erp`, ver abajo).

Cada mensaje pasa primero por un timeout de 20s + 1 reintento en cada
llamada a Gemini (`src/utils/withTimeout.ts`, `withRetry.ts`), y todo el
`processMessage` tiene además un timeout general de 95s
(`src/agent/handleMessage.ts`). Si de verdad no hay forma de procesar el
mensaje, el cliente recibe un aviso honesto de falla técnica y la
conversación se escala sola -- nunca se queda en silencio total.

### Vocabulario de modelos (`agent_known_models`)

Migración `0004_agent_known_models.sql`. Es una lista curada de nombres de
modelo/plataforma reales (extraídos por frecuencia de `products.name` y
revisados a mano), que `src/matching/knownModels.ts` carga con cache de 5
minutos y se inyecta en el prompt del intérprete (`buildInterpreterSystemPrompt`)
en cada llamada. Existe para que el intérprete reconozca "wolf", "tekken",
"scrambler", etc. como modelos reales del catálogo en vez de depender de lo
que Gemini sepa (o no sepa, o confunda) sobre la marca Daytona.

Es DATA en Supabase, no un truco de prompt específico de Gemini -- si el día
de mañana se cambia de proveedor de IA, el nuevo agente lee la misma tabla.
Arrancó con una primera curación mía; se sigue ajustando a mano, caso por
caso, según vayan apareciendo modelos que el bot no reconozca bien.

### Variantes de color

Muchos repuestos de este catálogo son PRODUCTOS DISTINTOS según el color
(fila aparte, no un atributo del mismo producto -- ej. "TANQUE...DELTA...NEGRO"
y "...BLANCO" son dos SKUs). Si el cliente no especifica color y el mejor
match tiene uno, el bot NO adivina ni registra la demanda todavía: busca
entre los otros candidatos devueltos por `agent_search_products` cuáles
comparten el mismo nombre sin el color (`src/utils/colors.ts`,
`stripColor`/`extractColor`/`mentionsColor`), y si hay más de un color
disponible, pregunta cuál quiere antes de seguir.

Para que la respuesta corta del cliente ("negro") se entienda en ese
contexto, el intérprete ahora recibe el HISTORIAL reciente de la
conversación (antes solo lo recibía el redactor) -- ver la sección
"Historial" del prompt de la Llamada 1 más arriba.

### Modelo equivocado por similitud de texto (ej. "force" vs "workforce")

La búsqueda difusa (pg_trgm) puede confundir dos modelos reales cuando uno
es substring del otro -- "force" matchea razonablemente bien contra
"workforce" aunque sean motos distintas. `detectKnownModel`
(`src/matching/knownModels.ts`) busca por palabra completa (con límites de
palabra, así "force" nunca matchea dentro de "workforce") cuál modelo
conocido menciona el texto. Si el modelo que dijo el cliente y el modelo
del mejor match no coinciden, el bot primero busca entre los otros
candidatos ya traídos si alguno sí es del modelo correcto (autocorrección
sin pregunta extra); si no lo encuentra, pregunta cuál de los dos modelos
es, en vez de asumir.

## Bandeja de handoff (ERP)

`pages/WhatsAppInbox.tsx` en `sistema_erp` (ruta `/whatsapp-inbox`) lista las
filas de `agent_escalations`, con el historial de `agent_messages` de esa
conversación para dar contexto. Un humano puede "Reclamar" (marca quién la
está atendiendo, pone `agent_conversations.status = 'human_active'`) y
"Marcar resuelta" (`agent_escalations.status = 'resolved'` +
`agent_conversations.status` vuelve a `'bot_active'`, salvo que se tilde
"no devolver al bot", que la deja en `'closed'`).

Esta pantalla NO manda mensajes de WhatsApp -- por diseño, la respuesta real
al cliente se sigue haciendo desde el WhatsApp personal vinculado como
dispositivo del número del bot (multi-dispositivo). La bandeja es solo
triage: ver qué se escaló y por qué, y avisarle al bot cuándo puede retomar.

### Variante por defecto (ej. "wolf" sin cilindraje -> Wolf 200)

Migración `0005_agent_model_defaults.sql`. Cuando el cliente nombra un
modelo pelado, sin ningún número (cc, año) en el mensaje, y ese modelo
tiene una variante configurada como default, `applyModelDefault`
(`src/matching/knownModels.ts`) se la agrega a la búsqueda antes de
consultar la base -- "filtro aire wolf" busca como "filtro aire wolf 200".
Si el cliente ya puso un número, no se toca nada. Arrancó con `WOLF -> 200`;
se agrega un modelo más cada vez que aparezca el mismo problema con otro.

### Precio redondeado hacia arriba

`src/utils/pricing.ts` (`roundedCustomerPrice`, `Math.ceil`). El precio que
ve el cliente siempre se redondea al dólar entero hacia arriba ($5.20 y
$5.50 se cotizan como $6.00) -- se aplica en código antes de armar
`HECHOS_VERIFICADOS.price`, nunca se le pide al modelo que haga la cuenta
(los LLM no son confiables para aritmética exacta). `products.price` en la
base queda intacto; el redondeo es solo para lo que se le dice al cliente.

### Nombres largos y abreviaturas del catálogo

Dos ajustes más a `agent_search_products` / `findProductMatches` (migración
`0006_agent_search_word_boost.sql`):

- **Boost de contención de palabras**: productos compatibles con varios
  modelos a la vez (ej. "...WOLF/ADV 200/MAVERICK/WOLF 250/FEROCE/WOLF
  EVOLUTION/RANGER CFZ 250/HONDA CB190...") tienen nombres larguísimos, y
  `similarity()` de pg_trgm los castiga solo por longitud aunque todas las
  palabras de la consulta estén presentes. Si TODAS las palabras de 3+
  letras de la consulta aparecen en el nombre, se le da un puntaje alto
  igual.
- **Abreviaturas de posición**: el catálogo dice sistemáticamente "ARO DEL"
  (delantero) / "ARO POST" (posterior/trasero), nunca la palabra completa.
  `withCatalogAbbreviations` (`src/matching/searchProducts.ts`) reemplaza
  "delantero"/"trasero"/"posterior" por "del"/"post" -- pero SOLO para la
  búsqueda difusa (`p_fuzzy_query`), nunca para el match exacto de alias
  (`p_query` sin tocar), porque ya hay alias aprendidos que contienen la
  palabra completa ("aro delantero tekken de rayos") y tocarla los rompería.

También se corrigió `detectKnownModel` -> ahora existe `detectKnownModels`
(plural) que devuelve TODOS los modelos que menciona un nombre, no solo el
más largo -- si no, un producto compatible con "WOLF" y "MAVERICK" a la vez
se marcaba como modelo equivocado apenas alguien pedía "wolf", porque
"MAVERICK" (más largo) le ganaba a "WOLF" en la detección de un solo modelo.

En `handleProductRequest` (`src/agent/handleMessage.ts`), la comparación
modelo-pedido vs. modelo-del-match ahora usa `detectKnownModels` (plural)
de los DOS lados, no solo del match -- porque algunos modelos del catálogo
son compuestos por dos palabras que además existen como modelo individual
en `agent_known_models` (ej. "WING EVO", donde "WING" y "EVO" están
registrados por separado). Con la versión anterior (`detectKnownModel`,
singular, solo del pedido), un cliente que escribía "wing evo" -- ya
inequívoco -- disparaba igual la pregunta de "¿qué modelo tenés?" en bucle,
porque el código nunca comparaba lo que el cliente ya había dicho contra
los modelos del match, solo contra los modelos de TODOS los candidatos
devueltos por la búsqueda. Ahora se pregunta solo si ninguno de los
modelos que nombró el cliente coincide con ninguno de los que tiene el
match.

`getRecentHistory` (`src/db/conversations.ts`) filtra los mensajes salientes
con `action_taken = 'escalated'` (el fallback fijo "tuvimos un problema
técnico...") antes de armarle el historial al intérprete y al redactor. Se
detectó con una conversación real donde ese texto, mezclado con preguntas
sin responder de mientras estaba escalada, confundía al intérprete sobre
qué pregunta seguía abierta (el cliente contestaba "wing evo" y el bot
volvía a preguntar el modelo). Pide `limit * 3` filas para poder descartar
ese ruido y aun así completar los `limit` turnos reales de conversación.

`agent_search_products` (migración `0008`) agrega un tercer nivel de boost:
si el nombre del producto EMPIEZA con la primera palabra de la búsqueda,
0.9 (por encima del 0.85 de "contiene todas las palabras"). Se detectó con
"tanque wing evo" -- devolvía "PLACA TANQUE..."/"CUBRE TANQUE..."
(accesorios) antes que "TANQUE GASOLINA..." (lo que pedía el cliente)
porque los tres empataban en 0.85 y el desempate quedaba al orden interno
de Postgres, no a la relevancia real. Como el catálogo nombra los
productos "TIPO_DE_PIEZA + calificadores" de forma consistente, el
prefijo es una señal confiable de cuál es el tipo de pieza correcto.

El fix de "overlap" de `queryModels`/`matchModels` de más arriba no
alcanzaba para todos los casos: "wing evo" ya solapaba con el match top
(WING y EVO están en el nombre de CUALQUIER variante, vieja o nueva) y
"tekken" solo, sin más, también solapaba con cualquier producto Tekken --
en ningún caso había un modelo "distinto" que disparara la pregunta, pero
seguía siendo ambiguo entre productos REALMENTE distintos (Wing Evo
pre-2024 vs Wing Evo 2 desde 2024; Tekken 250/Nativa vs Tekken Evo 250 vs
Tekken Discovery 300 -- año o motor no alcanza a verse solo comparando
modelos conocidos). Para esto se agregó `agent_model_disambiguations`
(migración `0009`): combinaciones EXACTAS de modelos conocidos que, aunque
el cliente ya nombró uno, siguen sin alcanzar para saber cuál producto es
-- si el cliente ya dio un número (año, cc, "evo 2") se asume que ya fue
específico y no se pregunta. Es DATA igual que `agent_known_models` /
`agent_model_defaults`: se sigue ajustando caso por caso, sin tocar código
ni el prompt.

El caso `no_stock` de `VerifiedFacts` (`src/gemini/respond.ts`) ahora
también lleva `price` -- antes solo `in_stock` lo tenía. Se detectó con un
cliente que, después de que le avisaran que un pedal de cambios estaba sin
stock (y quedó anotado el pedido), preguntó "¿cuál era el valor del
repuesto?". Aunque Gemini hubiera respondido bien en ese momento, el
redactor NUNCA tenía el precio disponible para un producto sin stock --
`match.price` existe siempre (tenga o no stock), pero `handleProductRequest`
solo lo pasaba a `draftReply` en la rama `in_stock`. Ahora se pasa
redondeado (`roundedCustomerPrice`) también en la rama `no_stock`, así que
el cliente puede preguntar el precio de algo que quedó pendiente sin que
haga falta que vuelva a pedir el repuesto desde cero.

Se agregó la regla dura 7 (no prometer una acción de seguimiento propia)
al redactor -- se detectó con un caso real donde la búsqueda matcheó el
producto equivocado (ver el fix de `0010` de más arriba) y el cliente
corrigió al bot en el mismo mensaje ("no necesito el asiento, quiero el
cdi"). El redactor, viendo esa corrección en el historial pero sin datos
de CDI en HECHOS_VERIFICADOS, improvisó "Déjame consultar lo del CDI para
darte el dato exacto" -- una promesa que el sistema no tiene forma de
cumplir (no hay ningún mecanismo de "reviso y te aviso"). No inventó un
precio ni un hecho falso (segía cumpliendo las reglas 1-6), pero sí generó
una expectativa falsa. La regla nueva se lo prohíbe explícitamente.

`interpretation.quantity` (Llamada 1) se capturaba pero nunca se usaba --
si el cliente pedía "3 filtros de aire", el bot confirmaba stock como si
pidiera 1 unidad, sin fijarse si `local_stock + importer_stock` alcanzaba
para las 3. Ahora, en la rama `in_stock` de `handleProductRequest`, si
`requestedQuantity > 1` la instrucción cambia según si el stock disponible
alcanza o no -- si no alcanza, le dice cuántas unidades hay de verdad y le
pregunta si le sirve, en vez de confirmar como si tuviera lo suficiente.

Se agregaron dos scripts de operación, corridos por el dueño del negocio
(no por el agente):
- `npm run reset-chat -- <numero> [--with-demands]` -- borra el historial
  de una conversación de prueba (cascada a mensajes/escalamientos) para
  poder probar desde cero sin que quede ruido de pruebas anteriores.
- `npm run gaps-report` -- junta `lost_demand` (búsquedas de WhatsApp sin
  resultado, agrupadas y contadas) y `agent_escalations` recientes
  (agrupados por motivo, con el detalle de los de `ambiguous_after_retries`)
  para poder ir cerrando huecos de catálogo (alias nuevos, modelos nuevos,
  entradas de `agent_model_disambiguations`) sin depender de que alguien
  esté mirando conversaciones en vivo.

### Pedidos con varios repuestos en un mismo mensaje

`InterpretResult` (Llamada 1) cambió `search_query`/`quantity`/
`brand_mentioned`/`vehicle_context` (un solo valor cada uno) por `items:
InterpretedItem[]` -- un elemento por cada repuesto distinto que el
cliente pida en el mismo mensaje (ej. "un filtro de aire y una bujía para
mi wolf 200"). `processMessage` recorre `interpretation.items` (tope
`MAX_ITEMS_PER_MESSAGE = 3`, para no volar el presupuesto de tiempo) y
llama a `handleProductRequest` una vez por item, en orden -- cada uno
reusa TODA la lógica ya existente de un pedido individual (desambiguación
de modelo, color, stock) sin cambios, y el cliente recibe una respuesta
por repuesto en vez de una sola respuesta combinada. `customer_name` y
`shipping_info` siguen siendo un solo valor a nivel de todo el mensaje
(no por item). El presupuesto total (`PROCESS_MESSAGE_TIMEOUT_MS`) se
recalculó para cubrir el intérprete más hasta 3 llamadas al redactor.

### Cantidad vs. stock disponible

Ver la nota de `interpretation.quantity` de más arriba -- ahora es
`item.quantity` (por repuesto, no por mensaje), misma lógica.

### Auditoría de cobertura (modelos y colores)

Se comparó `agent_known_models` y `COLOR_WORDS` contra el catálogo real
completo (6143 productos, no una muestra). Encontrado y corregido:
- **CRUCERO** -- 140 productos ("PEDAL CAMBIOS CRUCERO", "TAPA MOTOR DER.
  CRUCERO 200 GRIS SL", etc.) y no estaba en `agent_known_models`
  (migración `0011`).
- **CROMADO** (26 productos) y **TITANIO** (13 productos) -- se usan como
  acabado/color distintivo igual que "NEGRO"/"ROJO", y no estaban en
  `COLOR_WORDS`.
No se agregó "MATE"/"BRILLANTE" (aparecen siempre pegados a un color base
real, ej. "NEGRO MATE" -- el color base ya se extrae bien solo, y agregar
el modificador arriesgaba romper el agrupamiento de variantes hermanas sin
beneficio claro) ni marcas cruzadas como "BULTACO" (son motos de OTRA
marca usadas como referencia de compatibilidad, no un modelo Daytona --
el prompt del intérprete ya maneja esto explícitamente: interpreta
modelos no listados igual, en vez de descartarlos).

### Resumen diario de huecos por WhatsApp

`src/agent/gapsReportJob.ts` (corre cada 15 min, como `stockNotificationJob`)
manda un resumen corto al dueño (`OWNER_PHONE_NUMBER`) una vez al día,
dentro de la hora configurada en `GAPS_REPORT_HOUR` (default 8, horario de
Ecuador fijo UTC-5 -- no tiene horario de verano). Reusa la misma consulta
que `npm run gaps-report` (`src/db/gapsReport.ts`, compartido entre el
script y el job). Se registra en la tabla nueva `agent_report_log`
(migración `0012`) para no mandarlo dos veces el mismo día -- el proceso
se reinicia seguido (pruebas, deploys) y sin ese registro en base de datos
se repetiría cada vez que un reinicio cae dentro de la ventana horaria.

### Mensajes seguidos del mismo cliente (condición de carrera)

Baileys dispara `messages.upsert` una vez por cada tanda que llega de
WhatsApp, sin esperar a que el handler anterior termine. Si el mismo
cliente manda dos mensajes seguidos (común: "hola" y a los pocos segundos
"necesito un filtro") como DOS eventos separados (no siempre llegan
agrupados en el mismo evento), antes se procesaban en paralelo -- el
segundo podía interpretar el mensaje sin ver la respuesta al primero
todavía (historial desactualizado), y las dos respuestas podían salir
desordenadas. `src/utils/runExclusive.ts` encola por número de
teléfono -- mensajes de UN cliente se procesan de a uno, en orden;
clientes distintos siguen en paralelo sin esperarse. Se engancha en
`src/whatsapp/baileys.ts`, en el loop de `messages.upsert`.

### Precio en $0

Se encontró en el catálogo real un producto con stock (`MANUBRIOS (I-D)
TEKKEN`, 10 unidades) y `price = 0` -- dato sin cargar, no que sea gratis.
`handleProductRequest` ahora revisa esto ANTES de armar la respuesta de
`in_stock`: si hay stock pero `price <= 0`, en vez de confirmarle un
precio de $0 al cliente, escala (mismo mecanismo que otros escalamientos,
con una instrucción y un mensaje al dueño específicos: le dice al cliente
que sí hay stock pero que el precio se lo confirma alguien del equipo, y
al dueño qué producto/SKU le falta el precio).

### Color como palabra de más (no todo repuesto viene en colores)

No todo repuesto de este catálogo viene en varios colores -- ej. ningún
"espejo" tiene color en el nombre, es un solo producto. Si el cliente
igual menciona un color ("espejos negros"), el boost de "contiene todas
las palabras" lo exigía tal cual en el nombre -- se encontró un caso real
donde eso hacía perder los espejos GP1 de verdad (con stock) contra un
producto genérico corto llamado literalmente "ESPEJO", que le ganaba por
similitud cruda solo porque no tenía la palabra "negro" de menos.
`agent_search_products` (migración `0013`) agrega `p_fuzzy_query_no_color`
-- la misma consulta sin las palabras de color (`stripColor`, calculado en
`src/matching/searchProducts.ts`) -- como un boost de respaldo (0.75,
menos que el 0.85 con color) para cuando ningún candidato real tiene el
color puesto. Si SÍ existe una variante con el color en el nombre, esa
sigue ganando por el puntaje más alto.

**Incidente:** la migración `0013` cambia la firma del RPC (agrega un
parámetro). Se desplegó el código que lo llama ANTES de que la migración
estuviera aplicada -- Postgres no reconocía el parámetro nuevo y el RPC
entero fallaba (`PGRST202`), tumbando la búsqueda de productos para TODOS
los mensajes durante unos minutos, no solo el caso de color. Se revirtió
el código de inmediato (la línea que manda `p_fuzzy_query_no_color` quedó
comentada en `src/matching/searchProducts.ts`) hasta confirmar que la
migración está aplicada. Lección: un cambio que toca la FIRMA del RPC de
búsqueda (a diferencia de uno que solo lee tablas) no es seguro de
desplegar hasta tener la migración confirmada -- a partir de acá, ese tipo
de cambio se secuencia distinto: primero la migración, confirmada, recién
después el código que la usa.

### Preguntas generales del negocio (pago, envíos, horario, garantía)

"¿Aceptan transferencia?" se clasificaba como `greeting_smalltalk` (el
bot respondía con un saludo genérico, ignorando la pregunta) o `unclear`
-- no había ninguna categoría para "pregunta real sobre el negocio, no
sobre un repuesto puntual". El redactor tiene explícitamente prohibido
inventar método de pago/envío/garantía (reglas 1-6 de
`buildResponderSystemPrompt`), así que el bot no tenía forma de contestar
bien de todos modos. Se agregó el intent `general_question` -- escala
igual que `order_followup` (mismo mecanismo, un humano contesta), en vez
de ignorar la pregunta o intentar adivinar. Verificado contra Gemini real:
"¿aceptan transferencia?", "¿hacen envíos a Cuenca?", "¿a qué hora abren?"
y "¿este repuesto tiene garantía?" los cuatro clasifican correctamente.

**Seguimiento del mismo hallazgo:** un mensaje puede mezclar un pedido de
producto CON una pregunta general en el mismo texto ("necesito un filtro
de aire para mi wolf, y de paso, ¿aceptan transferencia?") -- como
`intent` solo puede ser un valor, la pregunta general quedaba
completamente perdida (ni rastro, ni aviso al dueño) mientras el filtro
se contestaba normal. Se agregó `has_unanswered_general_question`
(booleano, separado de `intent`) -- cuando viene en true y el intent
principal no es ya `general_question` ni dispara `needs_escalation` (esos
dos casos ya mandan el mensaje completo al dueño por su cuenta),
`processMessage` manda un aviso liviano al dueño (`notifyOwnerOfGeneralQuestion`)
SIN escalar la conversación ni tocar su estado -- el bot sigue
respondiendo normal al pedido de producto, solo se asegura de que la
pregunta del negocio no se pierda silenciosamente. Verificado contra
Gemini real: el mensaje combinado marca `hasGeneralQ=true` con el filtro
resuelto normal; los mensajes puros (solo producto, solo pregunta) NO
disparan un falso positivo. Verificado también junto con pedidos
multi-item ("un filtro para mi wolf y una bujía para mi gp1, aparte
¿hacen envíos a Cuenca?") -- los 2 items se separan bien Y la pregunta
general se marca, sin que se pisen entre sí.

### La búsqueda no respetaba el borrado suave del ERP (`is_active`)

`agent_search_products` solo filtraba `is_discontinued` -- no `is_active`,
que es el campo que usa el ERP para "eliminar" un producto sin borrar la
fila (`pages/Products.tsx`: eliminar hace
`.update({ is_active: false })`, y la lista de productos del ERP filtra
`.eq('is_active', true)`). Encontrado auditando: 320 productos con
`is_active=false` pero `is_discontinued=false`, al menos uno con stock
real -- el bot podía seguir ofreciendo algo que el negocio ya "borró"
desde el ERP. Migración `0014`: agrega `COALESCE(p.is_active, true) =
true` (mismo patrón que `is_discontinued`, NULL se trata como activo por
si hay filas viejas sin este campo cargado). No cambia la firma de la
función -- solo el WHERE, no hace falta tocar el código que la llama.

De paso se encontró y corrigió que `alias_exact` (los alias curados a
mano en `agent_product_aliases`) nunca filtraba `is_discontinued`/
`is_active` en absoluto -- ni en su propio WHERE ni en el JOIN final. Un
alias apuntando a un producto descontinuado o borrado después de curado
seguía resolviendo igual. Se movió el filtro al SELECT final para que
cubra alias_exact y fuzzy de una sola vez.

### La búsqueda ignoraba el flag de "no confiar en el stock de la importadora"

El ERP tiene `products.importer_unavailable_override` ("Agotado en
Importadora") -- un flag manual para cuando `importer_stock` NO es
confiable (dato del proveedor desactualizado/erróneo). El código del
propio ERP (`utils/importerOverride.ts`) lo dice explícito: *"el stock de
la importadora no es confiable. No prometas disponibilidad a esos
clientes todavía"*, y hay un trigger de base que revierte demandas de
`stock_available` a `pending_stock` cuando se prende. El job de aviso
(`stockNotificationJob.ts`) ya está protegido por ese trigger -- pero
`handleProductRequest` (la búsqueda EN VIVO durante una conversación) lee
`importer_stock` directo de `agent_search_products`, sin pasar por ese
mecanismo. Migración `0015` agrega la columna
`importer_unavailable_override` al resultado del RPC (cambia el tipo de
retorno, no los parámetros de entrada -- necesita DROP + CREATE, igual
que un cambio de firma). La lógica de qué hacer con el flag queda del
lado de TypeScript (`src/matching/searchProducts.ts` /
`src/agent/handleMessage.ts`), todavía sin implementar -- se agrega
recién después de confirmar que la migración está aplicada.

**Implementado tras confirmar la migración:** `ProductMatch.importerUnavailable`
(mapeado de la columna nueva). `handleProductRequest` calcula
`effectiveImporterStock = match.importerUnavailable ? 0 : match.importerStock`
y lo usa en TODOS los lugares que antes leían `match.importerStock`
directo: el chequeo de `hasStock`, el desempate de candidatos empatados
con stock, y el chequeo de cantidad suficiente. Verificado contra la base
real: el flag se mapea bien (`importerUnavailable: true` para un producto
marcado así) -- no había ningún caso ACTIVO ahora mismo donde esto
cambiara el resultado (nadie tiene el override prendido con
`importer_stock > 0` al mismo tiempo hoy), pero es la protección correcta
para cuando un sync del proveedor repueble ese número sin que el override
se apague.

### `is_discontinued` no era realmente "para siempre"

El ERP soporta descontinuación TEMPORAL -- `utils/discontinuedHelper.ts`
(`isProductDiscontinued`): si el producto tiene `discontinued_until` Y esa
fecha ya pasó, vuelve a contar como activo automáticamente, aunque el
booleano `is_discontinued` siga en true (no hay evidencia de que se
limpie solo). El filtro de `agent_search_products` venía usando
`is_discontinued = false` a secas desde la migración `0001` -- un
producto con descontinuación temporal ya vencida seguía excluido de la
búsqueda del bot como si fuera permanente. Migración `0016`: mismo
patrón que `isProductDiscontinued` -- no descontinuado SI `is_discontinued
= false`, O SI tiene `discontinued_until` Y esa fecha ya pasó. Auditado
contra datos reales: de los 739 productos con `is_discontinued = true`
hoy, NINGUNO tiene `discontinued_until` seteado -- este fix no cambia
ningún resultado actual, es preventivo para cuando el negocio empiece a
usar esa función del ERP (la UI la soporta desde antes).

### Demandas atascadas en 'pending_stock' con stock real (hallazgo mayor)

Auditando `product_demands` se encontró que sistema_erp tiene un trigger
(`trg_products_stock_arrival`, en su propia carpeta de migraciones) que
debería pasar una demanda de `pending_stock` a `stock_available` apenas
`products.local_stock`/`importer_stock` sube de 0 a positivo -- pero en la
práctica **59 demandas reales** quedaron en `pending_stock` con el
producto YA teniendo stock, algunas desde hacía semanas. Como
`runStockNotificationJob` (via `getPendingStockNotifications`) solo mira
`status = 'stock_available'`, esos 59 clientes nunca iban a recibir el
aviso -- probablemente porque el trigger es `AFTER UPDATE OF
importer_stock, local_stock` y algún camino de carga de stock (import
masivo, sync) no dispara un UPDATE fila por fila normal.

Se agregó `getStuckPendingDemands()` (`src/db/demands.ts`) como red de
seguridad: recalcula el stock "real" de cada demanda en `pending_stock`
con las mismas reglas que ya usa la búsqueda del agente (`is_active`,
`is_discontinued`/`discontinued_until`, `importer_unavailable_override`)
en vez de confiar en que el trigger ya corrió. `runStockNotificationJob`
ahora procesa `getPendingStockNotifications()` (el camino normal) Y
`getStuckPendingDemands()` (la red de seguridad) en cada tick de 5 min,
con la misma lógica de envío (`notifyDemand`, extraída como función
compartida). `markDemandNotified` ahora acepta
`alsoBackfillStockDetectedAt` -- las demandas atascadas nunca pasaron por
el trigger, así que `stock_detected_at` habría quedado NULL para siempre
si no se completa acá también.

**Confirmado con el usuario antes de desplegar** (bulk-envío real a 59
números de WhatsApp, no algo para activar sin avisar): eligió activarlo
de inmediato -- son clientes que de verdad están esperando ese repuesto.

**Dos problemas reales que salieron corriendo el envío del backlog en
vivo, corregidos sobre la marcha:**

1. La foto del producto fallaba con "Connection Closed" al subirla
   (problema de la conexión de medios, no de la sesión en general) --
   `sendTextOrPhoto` (`src/utils/sendTextOrPhoto.ts`) reintenta con texto
   solo si falla la foto, en vez de dejar al cliente sin nada. Se aplicó
   acá Y en `sendProductPhotoAndLog` (`handleMessage.ts`), que tenía la
   misma vulnerabilidad para conversaciones en vivo, no solo el backlog.
2. Durante el envío se vio una racha de **~395 reconexiones seguidas**
   (código 408) en loop apretado, sin ninguna pausa entre intentos --
   `startWhatsApp()` (`src/whatsapp/baileys.ts`) reconectaba de inmediato
   apenas se cerraba la conexión, sin backoff. Eso no le daba tiempo a la
   red de estabilizarse, y reconexiones tan seguidas pueden leerse como
   comportamiento abusivo del lado de WhatsApp. Se agregó backoff
   exponencial (`RECONNECT_BASE_DELAY_MS = 2000`, techo
   `RECONNECT_MAX_DELAY_MS = 60000`), reseteado apenas la conexión abre
   bien.

Durante ese mismo bache de red hubo un caso real donde ni la respuesta
normal NI el fallback de "problema técnico" pudieron mandarse (los dos
fallaron por la misma caída de red) -- el mensaje del cliente sí quedó
guardado en `agent_messages` (se loguea antes de procesar), así que no se
perdió del todo, pero no recibió ninguna respuesta en el momento. No se
tomó ninguna acción de código adicional para esto -- es un caso límite de
infraestructura (caída de red real), no algo que el código pueda
prevenir del todo; el backoff de reconexión reduce cuánto dura ese tipo
de bache.

**Incidente:** la racha de reconexiones (arriba) hizo que WhatsApp cerrara
la sesión del bot desde el lado del teléfono ("La sesión fue cerrada
desde el teléfono" -- probablemente la detectó como actividad
sospechosa). Hubo que borrar `auth_state/` local y limpiar el bucket
`agent_whatsapp_session` en Supabase Storage para volver a vincular con un
QR nuevo. Antes de reconectar, el usuario pidió explícitamente que el bot
NO le escriba a nadie hasta confirmar que está listo -- se agregó
`BOT_AUTO_REPLY_ENABLED` (`src/config.ts`, default `false` -- a
diferencia de `DEMAND_REGISTRATION_ENABLED` que por defecto viene en
`true`, este arranca en modo seguro por diseño): en `false`,
`handleIncomingMessage` (`src/agent/handleMessage.ts`) sigue registrando
cada mensaje entrante (`logInboundMessage`) pero corta ANTES de llamar a
Gemini o mandar cualquier respuesta -- ni normal, ni escalamiento, ni
fallback. Poner en `true` en `.env` recién cuando el negocio confirme que
el bot está listo para ir en vivo.

### Modo RECEPCIÓN (`AGENT_MODE=intake`) -- el bot no cotiza, solo junta datos

Pedido explícito del negocio tras la restricción de WhatsApp: el agente
NO debe mandarle información del catálogo a nadie -- solo sacarle al
cliente los datos de lo que necesita, para que después una persona
cotice. Se implementó como un modo aparte (`src/agent/intake.ts`), NO
como una modificación del flujo normal, para que ambos convivan sin
pisarse:

- `AGENT_MODE=intake` (**default**): `processMessage` deriva a
  `processIntakeMessage` y **nunca** llama a `findProductMatches` ni al
  redactor normal -- es imposible por construcción que diga un precio o
  un stock, no porque el prompt se lo pida sino porque no tiene acceso a
  esos datos en ese camino de código.
- `AGENT_MODE=full`: el flujo completo de siempre (busca en catálogo y
  cotiza), intacto.

`runIntake()` es una llamada a Gemini con `responseSchema` propio que, a
partir de TODO el historial, devuelve qué datos ya tiene
(repuesto/marca/modelo/año/color), si están completos, y UNA sola
pregunta corta para el dato que falte. Los 4 primeros son obligatorios
(pedido del negocio); `color` es condicional -- el prompt le explica que
piezas de carrocería (tanque, guardafango, mascarilla) suelen venir en
varios colores y las mecánicas (filtro, bujía, cadena) no. Cuando
`complete`, escala con el resumen formateado (`formatIntakeSummary`) en
el mensaje al dueño, y el bot deja de contestar solo en esa conversación
(mismo mecanismo de handoff de siempre).

Verificado contra Gemini real, conversación completa turno por turno
("info por favor" -> tanque -> daytona -> wing evo -> 2022 -> negro ->
handoff con los 5 datos) más los casos difíciles: pieza mecánica (NO
pregunta color, completa en 4 datos), cliente preguntando precio/stock
(contesta "eso te lo confirma alguien del equipo" y sigue con la
pregunta pendiente, sin inventar nada), cliente enojado (`needsHuman`),
y todo-en-un-mensaje (completa de una). También: info desordenada en un
solo mensaje ("del 2019 rojo, la mascarilla, wing evo daytona" -> la
ordena bien), cliente que cambia de opinión a mitad ("mejor el asiento
no el tanque" -> corrige el repuesto sin perder lo demás), moto de otra
marca (la acepta igual, no la fuerza a Daytona), y cliente insistiendo
con el precio dos veces seguidas (no cede ni da un estimado).

**Bugs encontrados y corregidos probando el modo:**

1. **"No sé el año" quedaba en la nada.** Muy común en motos usadas: el
   cliente decía que no sabe, el bot seguía de largo y el año quedaba
   `null` para siempre -- indistinguible de "nunca se preguntó", y el
   equipo no se enteraba. Ahora el prompt le dice que lo registre como
   `"no sabe"` (y `"no especifica"` para el color cuando al cliente le da
   igual): un dato así CUENTA como resuelto, no se vuelve a preguntar, y
   queda visible en el resumen del handoff.
2. **El modo recepción era ciego a las fotos.** `processIntakeMessage`
   recibía la media descargada pero no se la pasaba a `runIntake()` -- el
   cliente mandaba una foto de la pieza (algo muy común en repuestos) y
   el bot solo veía el texto `"(foto)"`, así que preguntaba "¿qué
   repuesto buscas?" sobre una foto que ya lo mostraba. Se agregaron
   `image`/`audio` a `runIntake()` (mismo patrón que `interpretMessage`)
   más una sección de prompt sobre fotos -- con la aclaración de que por
   la foto NO se puede saber modelo ni año, esos igual hay que
   preguntarlos. Verificado con una foto real del catálogo: identificó
   una "PLACA LAT." como "tapas laterales" y siguió con la pregunta
   correcta.
3. **Pregunta sin respuesta = cliente en silencio.** Cuando el cliente
   preguntaba algo que el bot no puede contestar (costo de envío, "¿qué
   repuestos tienen?"), el modelo devolvía `next_question: null` con
   `complete: false` -- una combinación que no debería existir. Se agregó
   una sección al prompt ("Preguntas que no podés responder") con una
   regla dura: mientras `complete` y `needs_human` sean false,
   `next_question` NUNCA puede venir vacío -- tiene que decir en una
   frase que eso lo confirma el equipo y seguir con el dato faltante. Más
   una red de seguridad en `processIntakeMessage`: si igual llega vacío,
   escala con una instrucción concreta en vez del texto genérico.
4. **Corrección del cliente perdía datos ya dados.** "Es una Wolf 250, no
   200" hacía que el modelo perdiera el modelo y volviera a preguntar la
   marca en loop. Se agregó al prompt que una corrección cambia UN campo
   y conserva el resto.
5. **Campos colapsados en uno solo (el más grave).** En una conversación
   con corrección, el modelo metió todo (`"tanque ... MARCA Daytona
   MODELO Wolf 250 ANIO 2022 COLOR negro"`) dentro del campo `repuesto`,
   dejando marca/modelo/año en null -- el resumen que le llega al equipo
   quedaba inservible aunque el cliente hubiera dado todos los datos. Se
   agregó una sección "Cómo llenar los campos" al principio del prompt:
   cada dato en SU campo, `repuesto` lleva solo el nombre de la pieza,
   sin traducciones ni sinónimos. Verificado: los dos casos que fallaban
   ahora devuelven los 5 campos separados correctamente.

### Permiso por conversación (`agent_conversations.bot_enabled`)

Segundo pedido del negocio: el bot solo le contesta a los clientes que él
habilite desde el ERP. Migración `0017` agrega
`agent_conversations.bot_enabled BOOLEAN NOT NULL DEFAULT false` -- una
conversación nueva queda registrada y visible en la bandeja, pero sin
respuesta automática hasta que alguien la habilite a mano.
`handleIncomingMessage` lo chequea después del interruptor maestro:

- `BOT_AUTO_REPLY_ENABLED` (.env) = interruptor MAESTRO, global.
- `bot_enabled` (por fila) = permiso INDIVIDUAL, por cliente.

Ambos tienen que estar en true para que el bot conteste. En el ERP
(`pages/WhatsAppInbox.tsx`) se agregó un botón "Activar/Desactivar
agente" en el detalle de cada conversación.

### Control total desde el ERP (migración 0018 + rework de la bandeja)

El interruptor maestro vivía solo en el `.env` del servidor, así que
prender/apagar el agente obligaba a editar un archivo y reiniciar el
proceso. Se movió a la base:

- **`agent_settings`** (migración `0018`): tabla de UNA sola fila
  (`CHECK (id = 1)`) con `bot_auto_reply_enabled`, default `false`. El
  agente la lee en cada mensaje con cache de 15s (`src/db/settings.ts`)
  -- así un cambio desde el ERP toma efecto casi inmediato sin
  reiniciar. Si la consulta falla, devuelve `false` (no contestar): ante
  la duda, el agente se calla.
- **`BOT_KILL_SWITCH`** (.env) reemplaza a `BOT_AUTO_REPLY_ENABLED`:
  ahora es solo un freno de emergencia a nivel servidor (default
  `false` = no frena nada). El manejo del día a día va por el ERP.

Los tres candados, en orden: `BOT_KILL_SWITCH` (emergencia, servidor) ->
`agent_settings.bot_auto_reply_enabled` (maestro, ERP) ->
`agent_conversations.bot_enabled` (por cliente, ERP).

La bandeja del ERP se reestructuró para esto: antes solo listaba
ESCALAMIENTOS, así que una conversación que nunca escaló era invisible --
no se le podía activar el agente aunque el permiso existiera. Ahora:

- Pestaña nueva **"Todas"** que lista `agent_conversations` directo
  (ordenadas por `last_message_at`), con su estado de agente a la vista.
- El panel de detalle se unificó en un tipo `SelectedContext` que sirve
  para las tres pestañas -- las acciones de escalamiento
  (Reclamar/Resolver) solo aparecen si esa conversación tiene un
  escalamiento asociado; el botón de activar/desactivar agente aparece
  siempre.
- Banner arriba con el interruptor maestro y una advertencia si una
  conversación está habilitada pero el agente global está apagado (si no,
  el usuario activa una conversación y no entiende por qué no responde).
- El realtime ahora escucha también `agent_conversations`, no solo
  `agent_escalations`.

**Nota:** el registro de mensajes nunca dependió de estos permisos --
`logInboundMessage` corre ANTES de los tres candados, así que todo lo que
llega queda guardado y visible aunque el agente esté apagado.

### Recepción proactiva (el agente deja de ser puramente reactivo)

Pedido del negocio: al activar el agente en un chat desde el ERP, que
arranque a sacar datos SIN esperar a que el cliente vuelva a escribir,
usando el historial viejo como contexto. Antes el bot solo actuaba sobre
`messages.upsert`, así que activarlo no hacía nada hasta el próximo
mensaje del cliente (y encima el filtro `PROCESS_STARTED_AT_SECONDS`
descarta los mensajes anteriores al arranque del proceso).

`src/agent/proactiveIntakeJob.ts` corre cada 60s y busca conversaciones
con `bot_enabled = true`, `intake_started_at IS NULL` (migración `0020`)
y `status = 'bot_active'` (si un humano ya la tomó, el bot no se mete).
Para cada una lee el historial, corre `runIntake()` y manda la pregunta
que falte. `intake_started_at` se completa siempre -- incluso en los
casos que no mandan mensaje -- para no reintentar en loop.

Tres casos donde NO le escribe al cliente y solo avisa al dueño:
- el historial ya tenía todos los datos (`complete`) -- mandar un mensaje
  que no pidió, sin necesidad, es justo lo que hay que evitar;
- `needsHuman`;
- el modelo no formuló pregunta.

**Ritmo:** `PROACTIVE_INTAKE_BATCH_SIZE` (default **1** por vuelta, o sea
~1 chat por minuto). Es deliberadamente lento por el incidente de la
restricción de WhatsApp (ver más abajo): mandar mensajes no solicitados en
ráfaga fue exactamente lo que la disparó. Acá el riesgo es bastante menor
--siempre es un chat donde el cliente YA había escrito, o sea responder un
hilo abierto, no abrir uno nuevo-- y el control real lo tiene el negocio,
que habilita chat por chat desde el ERP. El límite queda igual como red de
seguridad para el caso de habilitar varios de golpe.

### Tres bugs de armado de consulta (probados solo con Gemini + Supabase directo, sin tocar WhatsApp -- cuenta restringida 24h)

1. **Modelo/marca perdido cuando search_query ya tenía otra cosa.**
   `handleProductRequest` solo usaba `brand_mentioned`/`vehicle_context`
   como fallback COMPLETO (cuando `search_query` era null) -- si el
   intérprete separaba el modelo en su propio campo mientras
   `search_query` tenía algo genérico (real: "se me dañó el motor de mi
   tekken discovery" -> `search_query="repuestos motor"`,
   `vehicle_context="Tekken Discovery"`), el modelo se perdía en
   silencio. Se agregó `buildSearchQuery()` que combina los tres campos
   siempre, dedupeando palabra por palabra (sin importar mayúsculas) para
   no repetir el modelo si ya aparece en ambos.
2. **Match exacto (SKU/alias) disparaba la pregunta de modelo igual.**
   Un cliente pegando el SKU exacto ("me sirve el CB250TKN-020?")
   encontraba el producto correcto con confianza 1.0
   (`matchedVia: 'alias_exact'`) -- pero como el texto del SKU no
   contiene ninguna palabra de "modelo conocido", caía en la rama de "no
   dijo el modelo" y preguntaba igual, aunque ya había dado el
   identificador más preciso posible. Ahora todo el bloque de
   desambiguación de modelo se salta cuando `match.matchedVia ===
   'alias_exact'` -- un match exacto es inequívoco por definición.
3. **"repuestos"/"pieza"/"producto" como primera palabra anulaba el
   puntaje.** Estas palabras genéricas nunca aparecen literales en
   `products.name` (los productos se nombran por la pieza específica:
   "CIGÜEÑAL", "FILTRO ACEITE", nunca "REPUESTO") -- si quedaban como
   primera palabra de la consulta combinada del fix #1, el boost de
   prefijo/contención nunca se disparaba y un match real (ej. "MOTOR
   ARRANQUE... TEKKEN DISCOVERY") terminaba con puntaje 0 -- por debajo
   del umbral, se hubiera tratado como "no lo manejamos" a pesar de
   existir en stock. Se agregaron a `SEARCH_NOISE_WORDS`
   (`searchProducts.ts`), mismo mecanismo que ya existía para "DAYTONA".

Los tres verificados contra Gemini y Supabase reales, con checks de
regresión sobre casos ya arreglados antes (alias exacto, filtro wolf) --
sin tocar Baileys/WhatsApp para nada, dado que la cuenta sigue restringida
24h y el usuario pidió explícitamente no generar actividad ahí mientras
tanto.

### Precio en $0 (segundo lugar donde faltaba el mismo chequeo)

El chequeo de `price <= 0` de más arriba solo estaba en
`handleProductRequest` -- `stockNotificationJob.ts` (el aviso automático
de "te llegó lo que esperabas" cuando una demanda pasa a
`stock_available`) tenía el mismo hueco sin cubrir: si el producto vuelve
a tener stock mientras el precio sigue en $0, el aviso automático le
habría confirmado ese precio al cliente. Como acá no hay una conversación
activa para escalar, en vez de eso se avisa al DUEÑO por WhatsApp (SKU +
nombre) y la demanda queda SIN marcar `notified` -- se reintenta solo en
el próximo tick (cada 5 min) hasta que se cargue el precio real, momento
en el que el aviso normal le llega bien al cliente.

### Cantidad mal inferida por el plural del español

Se encontró que el intérprete inflaba `quantity` a partir del plural
gramatical ("necesito unos guardafangos" -> quantity=2), cuando en
español el plural del nombre de un repuesto casi nunca implica una
cantidad real (se vende de a uno). Esto afectaba directamente el chequeo
de "cantidad vs. stock disponible" (ver más arriba) con datos falsos. Se
agregó una sección al prompt del intérprete aclarando que la cantidad es 1
salvo que el cliente dé un número explícito.

### Rechazo/corrección sin especificar reemplazo

"no, ese no, quiero el otro modelo" (sin decir cuál) hacía que el
intérprete reconstruyera el MISMO search_query que ya se le había
ofrecido y rechazado -- el bot iba a terminar re-ofreciendo lo mismo. Se
agregó una regla al prompt: si el cliente rechaza/corrige sin dar el dato
de reemplazo, marcar intent = "unclear" (dispara la pregunta de
aclaración genérica) en vez de adivinar.

## Preguntas abiertas para vos (no asumidas en este diseño)

1. **Tono exacto / nombre del negocio** — dejé placeholders (`[NOMBRE DEL
   NEGOCIO]`, tuteo genérico). Lo ajustamos con tu marca real antes de
   implementar.
2. **Pocos-shot de aprendizaje** — el prompt de la Llamada 1 no tiene
   ejemplos todavía. Cuando reviséis los primeros escalamientos por
   ambigüedad, ahí es donde se agregan 3-5 ejemplos reales
   ("cliente escribió X, el repuesto correcto era Y") directo en este
   prompt — el proceso semanal que mencionás.
3. **Captura de "pedido básico"** — lo estoy guardando como texto libre en
   `agent_messages.body` / notas, sin tabla de "carrito" nueva, porque dijiste
   explícitamente que no improvisemos sobre `orders`. Si más adelante querés
   que el bot arme un borrador estructurado (cantidad, dirección) para que un
   humano lo convierta en pedido con un clic, eso es una tabla chica aparte
   — lo dejo fuera de este alcance hasta que confirmes.

---

## Ráfagas: leer todo lo que el cliente escribió antes de contestar

**El fallo, en una conversación real (agosto 2026):**

```
CLIENTE  Buenas tardes moto tuko cr3 max 200
CLIENTE  busco rin trasero
BOT      ¿Qué repuesto estás buscando para tu Tuko CR3 Max 200?
BOT      ¿De qué año es tu moto?
```

El cliente ya había dicho qué quería. Pero la gente escribe en varios
mensajes cortos, y cada uno disparaba su propio `handleIncomingMessage`: el
bot contestó el primero sin haber leído el segundo, y encima mandó dos
preguntas seguidas. Se nota en los números: **12 de 13** respuestas del bot
fueron `asked_clarification`.

**El arreglo** (`src/agent/messageBuffer.ts`): los mensajes se juntan por
conversación y se procesan todos juntos cuando el cliente deja de escribir
(7s de silencio, con tope de 25s desde el primero, para que alguien que
escribe sin parar igual reciba respuesta).

Lo que NO se demora es el **registro**: el mensaje se guarda apenas llega,
así que el ERP lo muestra en vivo. Lo único que espera es la respuesta
automática.

Tres consecuencias en el código:

- El texto que llega al intérprete viene con **saltos de línea**, uno por
  mensaje. Se juntan así y no con espacios: pegarlos como una frase corrida
  le hace perder al modelo dónde termina uno y empieza el otro. Los dos
  prompts (intérprete y recepción) lo explican con este mismo ejemplo.
- La foto o la nota de voz puede venir en **cualquier** mensaje de la
  ráfaga, no en el último — es común mandar la foto y después escribir
  "¿tienen este?". Con dos fotos gana la última: la segunda suele corregir a
  la primera.
- El estado de la conversación se **relee** antes de contestar: en esos
  segundos alguien del equipo pudo tomar el chat o apagarle el agente, y
  contestar con el estado viejo sería escribir por encima de una persona
  que ya está atendiendo.

Cubierto por `npm run verificar-rafagas`, que no toca WhatsApp ni la base.

### Encender el agente: saludos, naturalidad y lo que cuesta cada mensaje

Cambios hechos para poder dejar el agente atendiendo solo en modo
recepción. Todo lo de abajo se midió contra Gemini y el catálogo real, no
es criterio a ojo.

**El saludo ya no pasa por el modelo** (`src/agent/saludos.ts`). "hola" y
"buenas tardes" son el primer mensaje de casi toda conversación nueva, y
la respuesta no depende de nada que el cliente haya dicho -- porque
todavía no dijo nada. Es el único mensaje del flujo cuya respuesta se
puede saber de antemano sin perder calidad, así que se contesta desde un
banco de 56 combinaciones (8 aperturas x 7 preguntas), con el saludo
ajustado a la franja horaria de Ecuador (UTC-5 fijo).

La variedad **no se puede pedir por prompt**: el modelo no ve lo que le
contestó a los otros clientes, así que converge siempre a la misma frase.

Se activa solo si el mensaje es cortesía pura (sin números, sin pieza, sin
pregunta) **y nunca contestamos antes en ese chat**. Un "hola" suelto a
mitad de una conversación sigue yendo por el flujo normal: responderle un
saludo de bienvenida sería tirar el contexto de lo que ya había dicho.

**"Escribiendo..." desde que se empieza a procesar**, no recién al mandar
(`mostrarEscribiendo` al entrar a `processMessage`). Antes el cliente veía
silencio durante toda la llamada al modelo y de golpe aparecía un mensaje.

**El vendedor recibe el resumen ya cruzado con el catálogo**
(`src/agent/intakeHandoff.ts`). Con los datos que juntó la recepción se
corre la MISMA búsqueda que usa el modo completo y se le adjuntan hasta 3
candidatos con SKU, precio y stock (local / importadora, respetando el
flag de "agotado en importadora"). Ejemplo real:

    Repuesto: filtro de aire
    Marca: Daytona
    Modelo: Tekken 250
    Año: 2019

    En catálogo (buscado: "filtro de aire Tekken 250"):
    1. FILTRO AIRE TEKKEN EVO/AXXO TRACKER/DK NATIVA 250CC
       CB250TKN-056 · $7 · local 6 / import. 0 · 90%

Si no hay coincidencia lo dice ("hay que revisarlo a mano") y si el
catálogo falla devuelve igual los datos del cliente: la búsqueda es una
ayuda, no el mensaje.

**"rin" no es "aro"** (`CATALOG_SYNONYMS` en `searchProducts.ts`). El
cliente dice "rin", el catálogo dice "ARO". Medido: `rin trasero wolf 200`
traía un aro de otra moto al 38%, y `rines wolf 200` traía **BALANCINES**
al 80% -- un producto que no tiene nada que ver. Cambiando la palabra, las
dos consultas dan el aro correcto al 90%. Ya había dos alias cargados a
mano para tapar esto de a un producto por vez. "RIN" seguido de número no
se toca: ahí sí es la medida y está en el nombre ("ARO POST REFORZADO RIN
10 HUNTER 200").

**El prompt de recepción se acortó de 6.613 a 5.557 caracteres** sin sacar
ninguna regla (todas venían de un error real) y se le agregó la sección de
cómo escribir: variar el arranque, no repetir una frase ya usada en esa
conversación, enganchar con lo que el cliente acaba de decir, devolver el
saludo en la misma línea, un emoji suelto de vez en cuando.

#### Lo que se midió y NO sirvió

`thinkingLevel` (perilla `GEMINI_THINKING_LEVEL`, default `off`):

- **`low` rompe la salida estructurada.** El modelo vuelca su razonamiento
  adentro de los campos del JSON y devuelve `next_question` en null, o sea
  el cliente se queda sin respuesta. Se vio `repuesto =
  "tanquePool/tank/tanque"` y un campo entero con la frase *"wait, let's
  format JSON cleanly"*.
- **`medium` contesta bien pero no ahorra**: 293 y 656 tokens de
  pensamiento en dos llamadas iguales, contra 310 del default.

La perilla queda porque el modelo se cambia por `.env`, pero si se toca
hay que volver a medir CALIDAD, no solo latencia.

#### Sanidad de la respuesta (`src/gemini/sanidad.ts`)

Esa fuga de razonamiento **también pasa con el default**, más raro. El
esquema de respuesta no protege: el JSON es válido y el tipo es correcto,
la API no tiene forma de saber que el contenido es el borrador del modelo.

Se controla en código, adentro del reintento: si un campo pasa de 45
caracteres, trae dos o más barras, o contiene rastros de razonamiento, se
le vuelve a preguntar al modelo en vez de seguir con basura. También se
rechaza `complete = true` sin repuesto o sin modelo: eso no es un dato
completo, es una respuesta rota que le llegaría al vendedor como "datos
listos" con la ficha vacía.

Lo mismo en el intérprete: un `search_query` contaminado busca cualquier
cosa en el catálogo.

#### Los tiempos reales del modelo

La mediana de una llamada de recepción (2.049 tokens de entrada) es de 4 a
8 segundos, pero hay picos de 25 y 41, y `gemini-3.6-flash` devuelve 503
"high demand" cada tanto. Con el techo anterior de 20 segundos y dos
intentos, **2 de cada 6 mensajes de prueba terminaban en el mensaje de
"problema técnico"** -- un cliente real habría recibido eso en vez de una
respuesta.

Ahora son 40 segundos y tres intentos. El tercero sale casi gratis en el
caso que más se repite: el 503 falla en ~200ms y no consume el techo.

#### Cuando el modelo insiste: rescatar en vez de romper

La fuga de razonamiento se detecta y se reintenta (tres veces). Si aun así
sigue viniendo sucia, lo que NO hay que hacer es tirar la respuesta
entera: el cliente recibiría el mensaje de "problema técnico" y la
conversación quedaría escalada para siempre, por lo que casi siempre es UN
campo.

Se rescata lo limpio (`rescatarLoLimpio` en `agent/intake.ts`) y se sigue
como si ese dato el cliente no lo hubiera dicho -- que es exactamente lo
que pasó. La única regla dura: si se cae el repuesto o el modelo, la
recepción deja de estar completa, aunque el modelo haya dicho que sí. Un
aviso de "datos listos" con la ficha vacía es peor que una pregunta de
más.

El intérprete hace lo mismo con `search_query`: descartado, el pedido se
queda sin texto para buscar y el flujo ya sabe qué hacer con eso -- pedir
que aclare qué repuesto necesita.

Detalle que costó un bug propio y quedó escrito en `gemini/sanidad.ts`: el
error tiene que llevar la respuesta ENTERA, no el puñado de campos que se
está mirando. Un helper de conveniencia que lanzara solo con esos campos
dejaba al rescate sin los items, y los vaciaba.

#### `npm run verificar-recepcion`

Las tres defensas son invisibles cuando se rompen -- el bot sigue
contestando, solo que mal -- así que hay una verificación que no toca
WhatsApp, ni la base, ni Gemini: cuándo se saluda desde el banco, qué se
reconoce como razonamiento filtrado (con los textos reales que se vieron)
y qué sobrevive al rescate.
