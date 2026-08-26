-- Migration: acciones sobre mensajes ya enviados -- borrar, reaccionar,
-- citar, editar y marcar leído.
--
-- Hasta acá la cola solo sabía MANDAR contenido nuevo. Falta lo que en
-- WhatsApp se hace todo el día sobre un mensaje que ya existe, y que en un
-- negocio de repuestos tiene consecuencias concretas:
--
--   * BORRAR ("eliminar para todos"): se cotizó un precio equivocado y el
--     cliente lo tiene en el teléfono. Hoy la única salida es escribir
--     "perdón, es otro precio" y esperar que lea el segundo mensaje. Es el
--     error más caro que se puede cometer desde esta pantalla.
--   * CITAR: el cliente manda cinco mensajes seguidos y hay que contestar
--     el tercero. Sin cita, la respuesta queda colgada de la nada.
--   * REACCIONAR: un 👍 cierra un "ok, gracias" sin sumar otro mensaje al
--     hilo.
--   * EDITAR: WhatsApp deja corregir un texto dentro de los 15 minutos, y
--     es más limpio que borrar y volver a mandar.
--   * MARCAR LEÍDO: el doble tilde azul. Se hace al RESPONDER y no al
--     abrir el chat -- ver el comentario de abajo.
--
-- Todo entra por la misma cola en vez de una tabla nueva: son cosas que el
-- proceso del agente tiene que ejecutar contra WhatsApp, exactamente como
-- un envío, y compartir la cola significa compartir los reintentos, el
-- freno de salida y el registro de fallos que ya funcionan.

BEGIN;

ALTER TABLE public.agent_outbox
    -- Mensaje de WhatsApp sobre el que se actúa (borrar/reaccionar/editar).
    ADD COLUMN IF NOT EXISTS target_wa_id TEXT,
    -- Mensaje que se está citando al responder.
    ADD COLUMN IF NOT EXISTS reply_to_wa_id TEXT,
    -- El emoji, cuando kind = 'reaction'. Vacío = quitar la reacción.
    ADD COLUMN IF NOT EXISTS reaction_emoji TEXT;

COMMENT ON COLUMN public.agent_outbox.target_wa_id IS
    'whatsapp_message_id del mensaje sobre el que se actua (delete/reaction/edit).';
COMMENT ON COLUMN public.agent_outbox.reply_to_wa_id IS
    'whatsapp_message_id del mensaje citado al responder.';

ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_kind_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_kind_check
    CHECK (kind IN ('text', 'image', 'video', 'document', 'audio', 'delete', 'reaction', 'edit', 'read'));

-- Las acciones necesitan saber sobre QUÉ mensaje actúan. Sin esto, una
-- fila mal armada haría que el agente borrara o editara lo que no es.
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_target_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_target_check
    CHECK (kind NOT IN ('delete', 'reaction', 'edit') OR target_wa_id IS NOT NULL);

-- El CHECK de contenido (migración 0026) exigía texto o archivo. Una
-- acción no lleva ninguno de los dos: borrar un mensaje no tiene cuerpo.
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_contenido_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_contenido_check
    CHECK (
        kind IN ('delete', 'reaction', 'read')
        OR length(trim(COALESCE(body, ''))) > 0
        OR media_url IS NOT NULL
    );

-- Lo mismo con el CHECK de media: solo aplica a los tipos que mandan archivo.
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_media_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_media_check
    CHECK (kind NOT IN ('image', 'video', 'document', 'audio') OR media_url IS NOT NULL);

-- ============================================================
-- Marcar borrado en el historial del ERP
-- ============================================================
-- Un mensaje borrado NO se saca de `agent_messages`: la conversación es el
-- registro de lo que pasó, y hacer desaparecer una cotización equivocada
-- de nuestro propio historial es justo lo contrario de lo que sirve cuando
-- después hay que entender un reclamo. Se marca, y el ERP lo muestra
-- tachado -- igual que WhatsApp, que deja "Se eliminó este mensaje".
ALTER TABLE public.agent_messages
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN public.agent_messages.deleted_at IS
    'Cuando se borro para todos en WhatsApp. El mensaje se conserva y se muestra tachado: el historial no se reescribe.';

-- La reacción que se le puso al mensaje, para que el ERP la muestre.
ALTER TABLE public.agent_messages
    ADD COLUMN IF NOT EXISTS reaction TEXT;

-- A qué mensaje responde, para dibujar la cita en el hilo.
ALTER TABLE public.agent_messages
    ADD COLUMN IF NOT EXISTS reply_to_wa_id TEXT;

COMMIT;
