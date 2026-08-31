-- Una caída breve de WhatsApp no debe agotar tres intentos consecutivos y
-- dejar mensajes reales como fallidos. La cola espera antes de reintentarlos.

ALTER TABLE public.agent_outbox
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP WITH TIME ZONE
    DEFAULT TIMEZONE('utc'::text, NOW());

-- Las filas ya pendientes deben poder salir de inmediato después de aplicar
-- la migración; las que fallen después las programa el worker.
UPDATE public.agent_outbox
SET next_attempt_at = COALESCE(next_attempt_at, created_at, TIMEZONE('utc'::text, NOW()));

ALTER TABLE public.agent_outbox
    ALTER COLUMN next_attempt_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_outbox_pendientes_programados
    ON public.agent_outbox(next_attempt_at, created_at)
    WHERE status = 'pending';

COMMENT ON COLUMN public.agent_outbox.next_attempt_at IS
    'Momento más temprano para reintentar un envío pendiente después de un fallo temporal de WhatsApp.';
