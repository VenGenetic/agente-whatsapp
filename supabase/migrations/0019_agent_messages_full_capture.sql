-- Migration: capturar TODA la conversación de WhatsApp, no solo lo que el
-- bot procesa -- el negocio lo quiere para análisis de datos.
--
-- Dos huecos que tapa esta migración:
--
-- 1. `content_type` solo permitía ('text','image','audio','system'), así
--    que un mensaje de otro tipo (documento, sticker, ubicación,
--    contacto, video) no se podía guardar ni siquiera como registro de
--    que existió. Se amplía el CHECK.
--
-- 2. `action_taken` no tenía forma de marcar "esto no lo hizo el bot" --
--    las respuestas que el VENDEDOR manda desde su propio WhatsApp
--    (vinculado como dispositivo del número del bot) ahora se guardan
--    también, con action_taken = 'human_reply'. Sin esto, un análisis de
--    las conversaciones solo vería el lado del cliente y las respuestas
--    del bot, nunca las del humano.
--
-- El índice único sobre whatsapp_message_id (migración 0001) es lo que
-- evita duplicar los mensajes del propio bot cuando WhatsApp nos los
-- devuelve por el eco de 'fromMe' -- por eso ahora también guardamos ese
-- id en los mensajes salientes del bot.
-- PROPUESTA — no aplicada todavía.

ALTER TABLE public.agent_messages DROP CONSTRAINT IF EXISTS agent_messages_content_type_check;
ALTER TABLE public.agent_messages ADD CONSTRAINT agent_messages_content_type_check
    CHECK (content_type IN (
        'text', 'image', 'audio', 'system',
        'video', 'document', 'sticker', 'location', 'contact', 'other'
    ));

ALTER TABLE public.agent_messages DROP CONSTRAINT IF EXISTS agent_messages_action_taken_check;
ALTER TABLE public.agent_messages ADD CONSTRAINT agent_messages_action_taken_check
    CHECK (action_taken IN (
        'answered_in_stock', 'registered_demand', 'demand_already_existed',
        'registered_lost_demand', 'escalated', 'asked_clarification',
        'greeting', 'none', 'human_reply'
    ));

-- Estado de "no leído" que reporta el propio WhatsApp para cada chat, para
-- poder ver en el ERP cuáles quedaron sin atender. Es un espejo de lo que
-- muestra la app: WhatsApp lo manda en el history sync y en los eventos
-- `chats.update`, no lo calculamos nosotros.
ALTER TABLE public.agent_conversations
    ADD COLUMN IF NOT EXISTS unread_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.agent_conversations.unread_count IS
    'Mensajes sin leer segun WhatsApp (espejo de la app, no se calcula acá). 0 = leído.';

CREATE INDEX IF NOT EXISTS idx_agent_conversations_unread
    ON public.agent_conversations(unread_count) WHERE unread_count > 0;
