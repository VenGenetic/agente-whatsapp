-- Migration: mandar notas de voz y audios desde el ERP.
--
-- La cola (migración 0026) acepta texto, imagen, video y documento. Falta
-- el audio, que en este negocio no es un adorno: se midieron 585 notas de
-- voz recibidas contra 1.083 fotos. El cliente que va manejando o tiene
-- las manos sucias manda un audio, y hoy el vendedor solo le puede
-- contestar por escrito.
--
-- `ptt` (push-to-talk) distingue una NOTA DE VOZ grabada en el momento de
-- un archivo de audio adjunto. WhatsApp las muestra distinto: la nota de
-- voz sale con la onda y se reproduce sola al tocarla; un audio adjunto
-- aparece como archivo. Mandar una nota de voz como archivo se ve
-- descuidado, así que la distinción viaja hasta el envío.

BEGIN;

ALTER TABLE public.agent_outbox
    ADD COLUMN IF NOT EXISTS is_voice_note BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.agent_outbox.is_voice_note IS
    'true = nota de voz (ptt): WhatsApp la muestra con la onda, no como archivo adjunto.';

ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_kind_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_kind_check
    CHECK (kind IN ('text', 'image', 'video', 'document', 'audio'));

-- Una nota de voz es audio por definición.
ALTER TABLE public.agent_outbox DROP CONSTRAINT IF EXISTS agent_outbox_voice_check;
ALTER TABLE public.agent_outbox ADD CONSTRAINT agent_outbox_voice_check
    CHECK (is_voice_note = FALSE OR kind = 'audio');

-- Un audio no lleva pie de foto: WhatsApp ignora el caption en los
-- mensajes de audio, así que un texto ahí se perdería en silencio. Se
-- documenta acá porque el ERP lo tiene que mandar como mensaje aparte.
COMMENT ON COLUMN public.agent_outbox.body IS
    'Texto del mensaje, o pie de foto/video/documento. En kind=audio se ignora: WhatsApp no muestra caption en audios.';

COMMIT;
