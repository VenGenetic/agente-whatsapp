-- Migration: normalizar los teléfonos de las conversaciones y preparar el
-- manejo de LIDs, para que en el ERP cada cliente sea UNA fila con su
-- número real.
--
-- Problema encontrado con datos reales (101 conversaciones):
--   * 60 guardadas con "+", 41 sin "+", 4 con espacios -> el MISMO cliente
--     aparecía hasta dos veces (11 duplicados confirmados).
--   * 27 identificadas con el LID de WhatsApp (ej. "187711629586537") en
--     vez del teléfono, porque en esos chats WhatsApp no expone el número
--     directamente en el mensaje.
--
-- Esta migración:
--   1. Agrega `lid` para guardar el identificador interno APARTE del
--      teléfono (antes se pisaban en la misma columna).
--   2. Fusiona los duplicados: los mensajes y escalamientos se reapuntan a
--      la conversación más vieja y la duplicada se borra.
--   3. Normaliza `phone_number` a solo dígitos.
--
-- El código (src/utils/phone.ts) normaliza igual de ahora en más, así que
-- no se vuelven a generar duplicados.
-- PROPUESTA — no aplicada todavía.

ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS lid TEXT;

COMMENT ON COLUMN public.agent_conversations.lid IS
    'Identificador interno de WhatsApp (LID) del chat, cuando aplica. El teléfono real va en phone_number.';

-- 1) Fusionar duplicados que solo difieren en formato ("+593..." vs "593...").
DO $$
DECLARE
    grupo RECORD;
    canonico BIGINT;
BEGIN
    FOR grupo IN
        SELECT regexp_replace(phone_number, '\D', '', 'g') AS digitos,
               array_agg(id ORDER BY created_at, id) AS ids
        FROM public.agent_conversations
        WHERE regexp_replace(phone_number, '\D', '', 'g') <> ''
        GROUP BY 1
        HAVING COUNT(*) > 1
    LOOP
        -- La más vieja manda: conserva su historial y su id.
        canonico := grupo.ids[1];

        UPDATE public.agent_messages
        SET conversation_id = canonico
        WHERE conversation_id = ANY(grupo.ids) AND conversation_id <> canonico;

        UPDATE public.agent_escalations
        SET conversation_id = canonico
        WHERE conversation_id = ANY(grupo.ids) AND conversation_id <> canonico;

        -- Si alguna de las duplicadas tenía el agente activado o un nombre
        -- cargado, no se pierde al fusionar.
        UPDATE public.agent_conversations c
        SET bot_enabled = true
        WHERE c.id = canonico
          AND EXISTS (
              SELECT 1 FROM public.agent_conversations d
              WHERE d.id = ANY(grupo.ids) AND d.id <> canonico AND d.bot_enabled
          );

        UPDATE public.agent_conversations c
        SET customer_name = COALESCE(c.customer_name, (
            SELECT d.customer_name FROM public.agent_conversations d
            WHERE d.id = ANY(grupo.ids) AND d.id <> canonico AND d.customer_name IS NOT NULL
            LIMIT 1
        ))
        WHERE c.id = canonico;

        -- Conservar la actividad más reciente de todo el grupo.
        UPDATE public.agent_conversations c
        SET last_message_at = (
            SELECT MAX(d.last_message_at) FROM public.agent_conversations d
            WHERE d.id = ANY(grupo.ids)
        )
        WHERE c.id = canonico;

        DELETE FROM public.agent_conversations
        WHERE id = ANY(grupo.ids) AND id <> canonico;
    END LOOP;
END $$;

-- 2) Normalizar a solo dígitos (ya sin riesgo de chocar con el UNIQUE).
UPDATE public.agent_conversations
SET phone_number = regexp_replace(phone_number, '\D', '', 'g')
WHERE phone_number <> regexp_replace(phone_number, '\D', '', 'g');
