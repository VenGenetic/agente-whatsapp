-- Migration: registro de envíos del resumen diario de "huecos" (búsquedas
-- sin resultado + escalamientos recientes) al dueño por WhatsApp -- ver
-- src/agent/gapsReportJob.ts. Necesita ser una tabla (no memoria del
-- proceso) porque el proceso se reinicia seguido durante pruebas/deploys,
-- y sin esto se mandaría el resumen de nuevo cada vez que reinicia dentro
-- de la ventana horaria del envío.
-- PROPUESTA — no aplicada todavía.

CREATE TABLE IF NOT EXISTS public.agent_report_log (
    id BIGSERIAL PRIMARY KEY,
    report_type TEXT NOT NULL,
    report_date DATE NOT NULL,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    UNIQUE (report_type, report_date)
);

ALTER TABLE public.agent_report_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_report_log" ON public.agent_report_log;
CREATE POLICY "Allow all operations for authenticated users on agent_report_log"
ON public.agent_report_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
