-- Migration: los grupos de WhatsApp como DESTINO de mensajes
--
-- El agente ignora los grupos en la ENTRADA, a propósito y en cuatro
-- lugares (`shouldIgnoreJid` en baileys.ts, `parseIncomingMessage`, y dos
-- veces en historyImport). Eso no cambia: un mensaje de grupo llega
-- cifrado para otra sesión y cada intento de descifrarlo dejaba dos
-- errores de nivel 50 en el log, enterrando los errores de verdad.
--
-- Lo que se habilita acá es la SALIDA, que es otro problema y mucho más
-- simple: poder escribirle a un grupo desde el ERP. El caso concreto es
-- el requerimiento de compra -- un cliente abona un repuesto que no está
-- en la bodega, y el grupo de compras tiene que enterarse para pedirlo.
--
-- Se reusa `agent_conversations` en vez de una tabla nueva. Un grupo es,
-- para la cola de salida, exactamente lo mismo que un chat: una dirección
-- a la que mandar. Reusándola, el grupo hereda sin escribir una línea la
-- cola, los reintentos, el freno de salida, el registro de lo enviado y
-- los acuses de recibo. Una tabla aparte habría obligado a duplicar todo
-- eso o a hacer `agent_outbox.conversation_id` opcional, que es peor.
--
-- Consecuencia a tener presente: como la entrada sigue ignorando los
-- grupos, en el hilo de un grupo solo se ve lo que MANDAMOS nosotros. Lo
-- que el equipo conteste ahí se lee en WhatsApp, no en el ERP.

BEGIN;

-- ============================================================
-- 1. Distinguir un grupo de un cliente
-- ============================================================
-- Hace falta un marcador explícito y no deducirlo del formato del
-- identificador: la bandeja tiene que poder sacar los grupos de la lista
-- de clientes, y sobre todo el aviso de "ya llegó tu repuesto" NUNCA
-- puede salir a un grupo por una coincidencia de números.
ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.agent_conversations.is_group IS
    'true = es un grupo de WhatsApp, no un cliente. Solo se usa como destino de salida: la entrada de grupos sigue ignorada.';

CREATE INDEX IF NOT EXISTS idx_agent_conversations_grupos
ON public.agent_conversations (is_group)
WHERE is_group = true;

-- ============================================================
-- 2. A qué grupo van los requerimientos de compra
-- ============================================================
-- Se guarda el JID y también el nombre. El nombre es solo para mostrarlo
-- en la pantalla de configuración sin tener que ir a buscarlo: si el
-- grupo se renombra en WhatsApp, el JID sigue siendo el mismo y el envío
-- no se rompe.
ALTER TABLE public.agent_settings
    ADD COLUMN IF NOT EXISTS requirements_group_jid TEXT,
    ADD COLUMN IF NOT EXISTS requirements_group_name TEXT;

COMMENT ON COLUMN public.agent_settings.requirements_group_jid IS
    'Grupo de WhatsApp al que se avisa automáticamente cuando un cliente abona un repuesto que hay que encargar. Vacío = no se avisa a ningún grupo.';

COMMIT;
