-- Migration: guardar la dirección EXACTA de WhatsApp de cada chat.
--
-- Problema real detectado en vivo: el agente contestó a un cliente cuyo
-- chat se identifica por LID ("124327005577278"), y el mensaje NUNCA le
-- llegó. El código armaba la dirección asumiendo un teléfono
-- ("...@s.whatsapp.net"); para un chat por LID el sufijo correcto es
-- "@lid". Lo peor es que WhatsApp ACEPTA el envío sin error y lo
-- descarta -- en el ERP figuraba como respondido y el cliente no había
-- recibido nada. Afectaba a las ~244 conversaciones con LID, o sea la
-- mayoría.
--
-- Adivinar el sufijo por el largo del número es frágil. La forma
-- confiable es no adivinar: cuando el cliente escribe, WhatsApp ya nos
-- dice la dirección del chat (`key.remoteJid`); se guarda tal cual y se
-- reutiliza al responder.
-- PROPUESTA — no aplicada todavía.

ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS chat_jid TEXT;

COMMENT ON COLUMN public.agent_conversations.chat_jid IS
    'Direccion exacta del chat en WhatsApp (remoteJid). Es a donde hay que responder: NO reconstruir a partir del telefono.';

-- Relleno para las conversaciones que ya existen: las que parecen LID
-- (14+ digitos, mas largo que cualquier telefono con codigo de pais)
-- llevan @lid, el resto @s.whatsapp.net. Se sobrescribe solo con el
-- valor real en cuanto el cliente vuelva a escribir.
UPDATE public.agent_conversations
SET chat_jid = CASE
        WHEN length(regexp_replace(phone_number, '\D', '', 'g')) > 13
            THEN regexp_replace(phone_number, '\D', '', 'g') || '@lid'
        ELSE regexp_replace(phone_number, '\D', '', 'g') || '@s.whatsapp.net'
    END
WHERE chat_jid IS NULL;
