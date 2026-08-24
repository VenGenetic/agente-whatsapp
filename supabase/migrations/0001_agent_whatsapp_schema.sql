-- Migration: WhatsApp Agent — memoria de conversación, aprendizaje de alias, cola de escalamiento
-- PROPUESTA — no aplicada todavía. Depende de tablas ya existentes en sistema_erp:
--   products, product_demands, lost_demand, customers, auth.users
--
-- No modifica products, product_demands ni el flujo de orders/inventory_levels.

-- ============================================================
-- 1. agent_conversations: una fila por número de teléfono.
--    Es la "memoria" del bot: quién es el cliente, en qué estado
--    está su hilo (bot / escalado / humano / cerrado) y un link
--    blando al cliente del ERP si existe.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_conversations (
    id BIGSERIAL PRIMARY KEY,
    phone_number TEXT NOT NULL UNIQUE,
    customer_name TEXT,
    customer_id INTEGER REFERENCES public.customers(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'bot_active'
        CHECK (status IN ('bot_active', 'escalated', 'human_active', 'closed')),
    last_message_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_status ON public.agent_conversations(status);

-- ============================================================
-- 2. agent_messages: log append-only de cada mensaje entrante/
--    saliente, ligado a una conversación. Esto es lo que le da
--    memoria real ("este cliente ya preguntó por esto la semana
--    pasada") tanto al bot como a un humano que tome el hilo.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'image', 'audio', 'system')),
    body TEXT, -- texto del cliente, o la transcripción/descripción para audio/imagen, o la respuesta del bot
    whatsapp_message_id TEXT, -- id de mensaje de Baileys, para idempotencia/dedup
    product_id INTEGER REFERENCES public.products(id) ON DELETE SET NULL,
    match_confidence NUMERIC(4,3), -- score de similitud del match de producto, si aplica (para tuning futuro)
    action_taken TEXT CHECK (action_taken IN (
        'answered_in_stock', 'registered_demand', 'demand_already_existed',
        'registered_lost_demand', 'escalated', 'asked_clarification', 'greeting', 'none'
    )),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_conversation ON public.agent_messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_messages_wa_id ON public.agent_messages(whatsapp_message_id) WHERE whatsapp_message_id IS NOT NULL;

-- ============================================================
-- 3. agent_product_aliases: el mecanismo real de "aprendizaje".
--    Mapea cómo el cliente REALMENTE nombra un repuesto (coloquial,
--    con errores) -> product_id. Se llena SOLO cuando un humano
--    corrige un match durante la revisión de un escalamiento; el
--    modelo nunca escribe acá por su cuenta.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_product_aliases (
    id BIGSERIAL PRIMARY KEY,
    alias TEXT NOT NULL, -- texto normalizado (minúsculas, trim) tal como lo escribe el cliente
    product_id INTEGER NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'human_correction' CHECK (source IN ('human_correction', 'manual_seed')),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    conversation_id BIGINT REFERENCES public.agent_conversations(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    UNIQUE (alias, product_id)
);

CREATE EXTENSION IF NOT EXISTS pg_trgm; -- ya habilitado en esta base (idempotente)
CREATE INDEX IF NOT EXISTS idx_agent_product_aliases_trgm ON public.agent_product_aliases USING gin (alias gin_trgm_ops);

-- ============================================================
-- 4. agent_escalations: la cola de handoff a humano. Una misma
--    conversación puede escalar más de una vez en su vida, así que
--    esto es un log de EVENTOS de escalamiento, no un campo de estado.
--    Esta tabla es lo que listaría/reclamaría/resolvería una futura
--    página "Bandeja WhatsApp" en el ERP.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_escalations (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES public.agent_conversations(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK (reason IN (
        'discount_request', 'complaint_or_return', 'ambiguous_after_retries', 'angry_or_urgent', 'other'
    )),
    message_snapshot TEXT, -- último mensaje del cliente, para triage rápido sin abrir todo el hilo
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'resolved')),
    claimed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    claimed_at TIMESTAMP WITH TIME ZONE,
    resolved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_escalations_open ON public.agent_escalations(status) WHERE status IN ('open', 'claimed');

-- ============================================================
-- 5. RLS: mismo patrón permisivo-para-authenticated que el resto
--    de este esquema (ver product_demands, lost_demand). El bot
--    se conecta con la SERVICE ROLE key y no pasa por RLS — estas
--    policies solo gobiernan a los usuarios del ERP.
-- ============================================================
ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_product_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_escalations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_conversations" ON public.agent_conversations;
CREATE POLICY "Allow all operations for authenticated users on agent_conversations"
ON public.agent_conversations FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_messages" ON public.agent_messages;
CREATE POLICY "Allow all operations for authenticated users on agent_messages"
ON public.agent_messages FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_product_aliases" ON public.agent_product_aliases;
CREATE POLICY "Allow all operations for authenticated users on agent_product_aliases"
ON public.agent_product_aliases FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_escalations" ON public.agent_escalations;
CREATE POLICY "Allow all operations for authenticated users on agent_escalations"
ON public.agent_escalations FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 6. lost_demand necesita el valor de canal 'WHATSAPP' — hoy el
--    CHECK vivo solo permite ('POS', 'ONLINE').
-- ============================================================
ALTER TABLE public.lost_demand DROP CONSTRAINT IF EXISTS lost_demand_channel_check;
ALTER TABLE public.lost_demand ADD CONSTRAINT lost_demand_channel_check
    CHECK (channel IN ('POS', 'ONLINE', 'WHATSAPP'));
