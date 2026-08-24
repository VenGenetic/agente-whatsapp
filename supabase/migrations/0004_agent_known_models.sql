-- Migration: Vocabulario de modelos de moto conocidos (marca Daytona +
-- referencias cruzadas reales que aparecen en el catálogo, ej. Honda CB/CG).
-- PROPUESTA — no aplicada todavía.
--
-- Esto es DATA, no un truco de prompt de un proveedor de IA en particular:
-- cualquier agente futuro (sea con Gemini, OpenAI, o lo que sea) puede leer
-- esta tabla y usarla igual. Arranca con una primera curación extraída por
-- frecuencia real del catálogo (products.name) -- se va a seguir ajustando
-- a mano, caso por caso, como cualquier corrección real que aparezca.

CREATE TABLE IF NOT EXISTS public.agent_known_models (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE, -- normalizado en mayúsculas, tal como aparece en products.name
    notes TEXT, -- ej. "línea Daytona" / "referencia cruzada Honda" -- opcional, solo para humanos
    created_at TIMESTAMP WITH TIME ZONE DEFAULT TIMEZONE('utc'::text, NOW()) NOT NULL
);

ALTER TABLE public.agent_known_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all operations for authenticated users on agent_known_models" ON public.agent_known_models;
CREATE POLICY "Allow all operations for authenticated users on agent_known_models"
ON public.agent_known_models FOR ALL TO authenticated USING (true) WITH CHECK (true);

INSERT INTO public.agent_known_models (name) VALUES
    ('ADVENTURE'), ('ADVENTURE-R'), ('AGILITY'), ('ARTIC'), ('ASFALT'), ('AXXO'),
    ('BEAST'), ('BONEVILLE'), ('BULL'),
    ('CB125'), ('CB150'), ('CB180'), ('CB190'), ('CB200'), ('CB250'),
    ('CFZ'), ('CG150'), ('CG200'), ('CHIEF'), ('CLASICA'), ('COMMANDER'),
    ('CR3'), ('CR5'), ('CR300'), ('CROSSFIRE'), ('CROSSOVER'), ('CX7'),
    ('DAYTONA'), ('DELTA'), ('DESERT'), ('DISCOVERY'), ('DK250-D'), ('DR300CC'),
    ('DUKK'), ('DY250'), ('DYNAMIC'),
    ('EAGLE'), ('EIVISSA'), ('ELEMENT'), ('EVEREST'), ('EVEREST300'), ('EVO'), ('EVO2'), ('EVOL'),
    ('F16'), ('F22'), ('F51'), ('FACTORY'), ('FALCON'), ('FE250'), ('FE300'), ('FEROCE'), ('FORCE'),
    ('GN125'), ('GP1'), ('GP1-R'), ('GP1R'), ('GP1RR'), ('GP1S'), ('GP200'), ('GTR'),
    ('H2EVO'), ('HORNET'), ('HUNTER'),
    ('JEDI'),
    ('MAVERICK'), ('MIG25'), ('MONACO'), ('MONTANA'), ('MT1'),
    ('NATIVA'), ('NOMADA'),
    ('PANTHER'), ('PEGASSO'), ('PHANTON'), ('PR300'), ('PREDATOR'),
    ('R51'), ('R200'), ('RACER'), ('RAGNAROD'), ('RANGER'), ('RAPTOR'), ('REVOLUTION'), ('ROADSTER'),
    ('S1ADV'), ('SCORPION'), ('SCRAMBLER'), ('SHARK'), ('SHARK1'), ('SIKR'), ('SILENCE'),
    ('SPITFIRE'), ('SR71'), ('STIFF'), ('STORM'),
    ('TEKKEN'), ('THD'), ('THUNDER'), ('TRACKER'), ('TRX'), ('TUKO'), ('TUNDRA'),
    ('VELOCE'), ('VENOM'), ('VENOOM'), ('VENTO'), ('VENTURE'),
    ('WIND'), ('WIND250'), ('WING'), ('WOLF'), ('WORKFORCE'), ('WORKFORCE-S'),
    ('XCAPE'), ('XPEDITION'), ('XPOWER'), ('XTREEM'), ('XTZ'),
    ('Z250')
ON CONFLICT (name) DO NOTHING;
