-- Migration: para ciertos modelos, aunque el cliente ya nombró un modelo
-- conocido, ese nombre por sí solo sigue siendo ambiguo entre dos o más
-- productos REALMENTE distintos (no la misma pieza compatible con varios
-- modelos a la vez, que es un caso normal y no debe disparar pregunta) --
-- ej. "Wing Evo" cambió de diseño en 2024 (antes: Wing Evo / Wing Evo 200,
-- desde 2024: Wing Evo 2), y "Tekken" tiene 3 versiones reales (Tekken 250
-- / Tekken Nativa, Tekken Evo 250, Tekken Discovery 300). Es DATA, igual
-- que agent_known_models/agent_model_defaults: se sigue ajustando caso por
-- caso a medida que aparezcan en conversaciones reales, sin tocar código
-- ni el prompt -- y así el conocimiento sobrevive aunque cambiemos de
-- agente/LLM.
-- PROPUESTA — no aplicada todavía.

CREATE TABLE IF NOT EXISTS public.agent_model_disambiguations (
    id BIGSERIAL PRIMARY KEY,
    -- Combinación EXACTA de modelos conocidos detectados en el pedido del
    -- cliente que dispara la pregunta (orden alfabético, ver
    -- src/matching/knownModels.ts). Si el cliente da algo más específico
    -- (otro modelo, o cualquier número/año), ya no matchea exacto y no se
    -- pregunta.
    models TEXT[] NOT NULL,
    question_hint TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL,
    UNIQUE (models)
);

ALTER TABLE public.agent_model_disambiguations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_model_disambiguations" ON public.agent_model_disambiguations;
CREATE POLICY "Allow all operations for authenticated users on agent_model_disambiguations"
ON public.agent_model_disambiguations FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.agent_model_disambiguations (models, question_hint) VALUES
    (
        ARRAY['EVO', 'WING'],
        'El modelo Wing Evo cambió de diseño desde el 2024: antes del 2024 es Wing Evo (o Wing Evo 200), desde el 2024 es Wing Evo 2. Pregúntale de qué año es la moto, o si es Wing Evo o Wing Evo 2, en una sola pregunta corta.'
    ),
    (
        ARRAY['TEKKEN'],
        'La Tekken tiene 3 versiones distintas: Tekken 250 (o Tekken Nativa), Tekken Evo 250 y Tekken Discovery 300. Pregúntale cuál de las 3 es. Si además el repuesto es una pieza del motor (pistón, cilindro, árbol de levas, empaques, culata, etc.), pregúntale también si su moto es de 2 o 4 válvulas.'
    )
ON CONFLICT (models) DO NOTHING;
