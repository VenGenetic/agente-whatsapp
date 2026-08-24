-- Migration: Variante por defecto cuando el cliente nombra un modelo pelado
-- (sin cilindraje/año), ej. "wolf" sin más -> asumir "wolf 200".
-- PROPUESTA — no aplicada todavía.
--
-- Es DATA, igual que agent_known_models: se sigue ajustando modelo por
-- modelo a medida que aparezcan casos reales, sin tocar código.

CREATE TABLE IF NOT EXISTS public.agent_model_defaults (
    id BIGSERIAL PRIMARY KEY,
    model TEXT NOT NULL UNIQUE REFERENCES public.agent_known_models(name) ON DELETE CASCADE,
    default_variant TEXT NOT NULL, -- ej. "200" -- se agrega a la búsqueda cuando el modelo aparece solo, sin número
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

ALTER TABLE public.agent_model_defaults ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_model_defaults" ON public.agent_model_defaults;
CREATE POLICY "Allow all operations for authenticated users on agent_model_defaults"
ON public.agent_model_defaults FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.agent_model_defaults (model, default_variant) VALUES
    ('WOLF', '200')
ON CONFLICT (model) DO NOTHING;
