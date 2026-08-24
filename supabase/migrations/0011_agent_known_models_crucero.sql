-- Migration: auditoría de cobertura de modelos contra el catálogo real --
-- "CRUCERO" aparece en 140 productos ("PEDAL CAMBIOS CRUCERO", "TELESCOPICAS
-- (I-D) CRUCERO", "TAPA MOTOR DER. CRUCERO 200 GRIS SL", etc.) y no estaba
-- en agent_known_models -- un cliente pidiendo "algo para mi crucero" no
-- tenía el mismo tratamiento de disambiguación/prioridad que el resto de
-- modelos conocidos.
-- PROPUESTA — no aplicada todavía.

INSERT INTO public.agent_known_models (name) VALUES
    ('CRUCERO')
ON CONFLICT (name) DO NOTHING;
