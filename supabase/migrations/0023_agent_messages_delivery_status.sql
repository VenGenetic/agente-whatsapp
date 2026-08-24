-- Migration: estado de ENTREGA real de cada mensaje que manda el agente.
--
-- Problema detectado en vivo: el ERP mostraba el mensaje del bot como si
-- el cliente lo hubiera recibido, cuando WhatsApp nunca lo entregó. Se
-- confirmó con un caso real: el bot preguntó "¿qué repuesto buscas?" y el
-- cliente contestó "?" un minuto después -- nunca vio la pregunta.
--
-- La causa de fondo es que `sock.sendMessage()` no falla cuando el
-- destino no existe o la sesión está rota: WhatsApp acepta el envío y lo
-- descarta. Sin guardar el acuse de recibo, el ERP "alucina" respuestas.
--
-- Los estados son los que reporta WhatsApp:
--   pending   -> se envió, sin acuse todavía
--   sent      -> el servidor de WhatsApp lo aceptó
--   delivered -> llegó al teléfono del cliente
--   read      -> el cliente lo abrió
--   failed    -> WhatsApp lo rechazó
-- PROPUESTA — no aplicada todavía.

ALTER TABLE public.agent_messages
    ADD COLUMN IF NOT EXISTS delivery_status TEXT
    CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'read', 'failed'));

COMMENT ON COLUMN public.agent_messages.delivery_status IS
    'Acuse de recibo real de WhatsApp para mensajes salientes. NULL en los entrantes.';

-- Para poder listar rápido lo que quedó sin entregar.
CREATE INDEX IF NOT EXISTS idx_agent_messages_no_entregados
    ON public.agent_messages(delivery_status)
    WHERE delivery_status IN ('pending', 'failed');
