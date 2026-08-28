-- Migration: separar RECEPCIÓN de VENTAS en dos agentes
--
-- Los dos agentes ya existían en el código (`AGENT_MODE=intake` y
-- `AGENT_MODE=full`, con prompts distintos). Lo que faltaba era todo lo de
-- alrededor, y es lo que agrega esta migración:
--
--   1. La ficha que arma la recepción no se guardaba en ningún lado. Se
--      formateaba como texto y se mandaba por WhatsApp al dueño; en la
--      base quedaba un párrafo en `agent_escalations.message_snapshot`.
--      Nadie podía filtrar, mostrar una ficha en la bandeja, ni pasarle
--      esos datos al agente vendedor sin volver a parsear prosa.
--   2. "Listo para vendedor" y "algo salió mal" terminaban los dos en
--      status = 'escalated', o sea indistinguibles.
--   3. Había 4 estados y hacían falta 7.
--   4. Elegir qué agente contesta era una variable de entorno: global y
--      con reinicio del proceso.
--   5. No quedaba registro de qué agente escribió cada mensaje ni de
--      cuándo una conversación cambió de etapa.
--
-- DECISIÓN CENTRAL: no se toca `status`. La columna vieja contesta "¿quién
-- manda este chat?" (bot / humano / escalado / cerrado) y es lo que frena
-- al bot cuando una persona toma la conversación; la columna nueva
-- contesta "¿en qué punto del flujo está?". Hoy `status` intenta ser las
-- dos cosas y por eso el éxito y la falla quedan iguales. Separándolas, el
-- freno que ya funciona sigue funcionando sin enterarse de que existen las
-- etapas.
--
-- Nada acá borra ni renombra nada. Todo es aditivo y con IF NOT EXISTS,
-- así que se puede correr dos veces sin romper.

BEGIN;

-- ============================================================
-- 1. La etapa del flujo (agent_conversations.etapa)
-- ============================================================
ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS etapa TEXT NOT NULL DEFAULT 'new';

-- Como constraint aparte y no en la definición: si la columna ya existía
-- de una corrida anterior, el CHECK inline no se habría aplicado.
ALTER TABLE public.agent_conversations DROP CONSTRAINT IF EXISTS agent_conversations_etapa_check;
ALTER TABLE public.agent_conversations ADD CONSTRAINT agent_conversations_etapa_check
    CHECK (etapa IN (
        'new',                    -- llegó y todavía no se procesó
        'intake_in_progress',     -- la recepción está juntando datos
        'waiting_customer_info',  -- se preguntó algo y falta que conteste
        'ready_for_sales',        -- ficha completa y confirmada por el cliente
        'sales_in_progress',      -- el agente vendedor está cotizando
        'human_assigned',         -- lo tomó una persona del equipo
        'resolved'                -- terminada
    ));

COMMENT ON COLUMN public.agent_conversations.etapa IS
    'En qué punto del flujo está la conversación. Es distinto de `status`, que dice quién manda el chat: una conversación puede estar en ready_for_sales (etapa) y escalated (status) al mismo tiempo, y de hecho es lo normal.';

CREATE INDEX IF NOT EXISTS idx_agent_conversations_etapa
    ON public.agent_conversations(etapa);

-- Las que le importan a la bandeja: lo que espera a una persona.
CREATE INDEX IF NOT EXISTS idx_agent_conversations_listas
    ON public.agent_conversations(last_message_at DESC)
    WHERE etapa = 'ready_for_sales';

-- Backfill de lo que ya existe. Se deduce de `status`, que es lo único que
-- hay: las conversaciones viejas no tienen forma de saber si la recepción
-- llegó a terminar, así que las escaladas quedan como human_assigned (que
-- es lo que de verdad pasó: alguien las tuvo que atender) y NO como
-- ready_for_sales, que sería inventar que hay una ficha completa.
UPDATE public.agent_conversations
SET etapa = CASE
        WHEN status = 'closed' THEN 'resolved'
        WHEN status = 'human_active' THEN 'human_assigned'
        WHEN status = 'escalated' THEN 'human_assigned'
        WHEN last_message_at IS NULL THEN 'new'
        ELSE 'intake_in_progress'
    END
WHERE etapa = 'new';

-- ============================================================
-- 2. Qué agente escribió cada mensaje (agent_messages.agent)
-- ============================================================
-- `action_taken` dice QUÉ se hizo, no QUIÉN lo hizo. Con dos agentes
-- automáticos conviviendo, sin esto no se puede auditar cuál de los dos
-- mandó una respuesta equivocada.
ALTER TABLE public.agent_messages
    ADD COLUMN IF NOT EXISTS agent TEXT;

ALTER TABLE public.agent_messages DROP CONSTRAINT IF EXISTS agent_messages_agent_check;
ALTER TABLE public.agent_messages ADD CONSTRAINT agent_messages_agent_check
    CHECK (agent IS NULL OR agent IN ('intake', 'sales', 'human', 'system'));

COMMENT ON COLUMN public.agent_messages.agent IS
    'Quién escribió el mensaje: intake (agente de recepción), sales (agente vendedor), human (una persona, desde el ERP o el teléfono), system (avisos automáticos). NULL en los mensajes viejos, anteriores a la separación en dos agentes.';

-- Los entrantes son del cliente: el campo solo tiene sentido en los que
-- salen. Lo que ya está registrado como escrito a mano se puede deducir.
UPDATE public.agent_messages
SET agent = 'human'
WHERE agent IS NULL AND direction = 'outbound' AND action_taken = 'human_reply';

-- ============================================================
-- 3. Prender y apagar cada agente por separado
-- ============================================================
-- `bot_auto_reply_enabled` sigue siendo el interruptor MAESTRO: en false
-- no contesta nadie, sin importar estos dos. Estos eligen quién contesta
-- cuando el maestro está encendido.
--
-- El vendedor arranca apagado A PROPÓSITO: es el que dice precios y
-- confirma stock, y encenderlo sin mirar es la clase de error que se
-- lee en el WhatsApp de un cliente.
ALTER TABLE public.agent_settings
    ADD COLUMN IF NOT EXISTS intake_agent_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS sales_agent_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.agent_settings.intake_agent_enabled IS
    'Agente de RECEPCIÓN: junta los datos del repuesto y deja la conversación lista para un vendedor. No consulta catálogo ni dice precios.';
COMMENT ON COLUMN public.agent_settings.sales_agent_enabled IS
    'Agente VENDEDOR: cotiza contra el catálogo (precio, stock, foto). Arranca apagado: lo que dice llega tal cual al cliente.';

-- ============================================================
-- 4. La ficha estructurada (agent_intake_requests)
-- ============================================================
-- Una fila por SOLICITUD, no por cliente: el mismo cliente vuelve en tres
-- meses por otra pieza, y esa es otra solicitud con su propia ficha.
--
-- Se escribe en BORRADOR desde el primer dato, no recién al final: si una
-- persona entra a mitad de la recepción, tiene que ver lo que se lleva
-- juntado en vez de leer el hilo entero.
CREATE TABLE IF NOT EXISTS public.agent_intake_requests (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,

    -- Los datos, tal como los da el cliente. Se guardan como texto y no
    -- normalizados contra el catálogo a propósito: esto es lo que PIDIÓ,
    -- y el cruce con productos lo hace el vendedor (o el agente vendedor)
    -- después. Meter aquí un product_id sería adivinar.
    repuesto TEXT,
    marca TEXT,
    modelo TEXT,
    anio TEXT,
    color TEXT,
    -- Izquierda/derecha, delantero/trasero, superior/inferior. La
    -- referencia de izquierda y derecha es siempre "sentado como
    -- conductor" (está en el prompt): sin eso, la mitad de las respuestas
    -- vienen al revés.
    posicion TEXT,
    -- Cilindraje o versión, SOLO cuando distingue dos variantes del mismo
    -- modelo. La mayoría de las fichas lo van a tener en NULL.
    cilindraje TEXT,
    -- Lo que el cliente dijo y no entra en ningún campo ("es para un
    -- viaje el sábado", "el anterior me duró dos meses").
    observaciones TEXT,
    -- Si mandó una foto de la pieza. No se pregunta: se deduce del hilo.
    foto_recibida BOOLEAN NOT NULL DEFAULT false,

    estado TEXT NOT NULL DEFAULT 'borrador'
        CHECK (estado IN ('borrador', 'lista', 'atendida', 'descartada')),

    -- Lo que encontró la búsqueda de catálogo con estos datos, en el
    -- momento de cerrar la ficha. Es una AYUDA para el vendedor, no una
    -- afirmación: el stock y el precio cambian, y por eso queda con su
    -- fecha en vez de leerse como verdad actual.
    catalogo_sugerido JSONB,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    -- Cuándo quedó lista para un vendedor.
    lista_at TIMESTAMP WITH TIME ZONE
);

COMMENT ON TABLE public.agent_intake_requests IS
    'La ficha que arma el agente de recepción: qué repuesto pidió el cliente y para qué moto. Una fila por solicitud. Antes esto se perdía: se formateaba como texto y se mandaba por WhatsApp.';

-- Solo puede haber UN borrador abierto por conversación. Sin esto, cada
-- mensaje del cliente crearía una ficha nueva en vez de completar la que
-- ya se venía llenando.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_intake_borrador_unico
    ON public.agent_intake_requests(conversation_id)
    WHERE estado = 'borrador';

CREATE INDEX IF NOT EXISTS idx_agent_intake_conversacion
    ON public.agent_intake_requests(conversation_id, created_at DESC);

-- La cola de trabajo del vendedor.
CREATE INDEX IF NOT EXISTS idx_agent_intake_listas
    ON public.agent_intake_requests(lista_at DESC)
    WHERE estado = 'lista';

ALTER TABLE public.agent_intake_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_intake_requests"
    ON public.agent_intake_requests;
CREATE POLICY "Allow all operations for authenticated users on agent_intake_requests"
ON public.agent_intake_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 5. Trazabilidad de los cambios de etapa
-- ============================================================
-- Append-only. Sirve para dos cosas concretas: reconstruir por qué una
-- conversación quedó donde quedó, y medir cuántas llegan de verdad a
-- ready_for_sales (que es el número que dice si la recepción sirve).
CREATE TABLE IF NOT EXISTS public.agent_conversation_events (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
    etapa_anterior TEXT,
    etapa_nueva TEXT NOT NULL,
    -- Quién lo movió: 'intake', 'sales', 'human', 'system'.
    actor TEXT,
    -- En una frase, por qué. Se lee en la bandeja cuando algo no cuadra.
    motivo TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_conversation_events_conv
    ON public.agent_conversation_events(conversation_id, created_at DESC);

ALTER TABLE public.agent_conversation_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_conversation_events"
    ON public.agent_conversation_events;
CREATE POLICY "Allow all operations for authenticated users on agent_conversation_events"
ON public.agent_conversation_events FOR ALL TO authenticated USING (true) WITH CHECK (true);

COMMIT;
