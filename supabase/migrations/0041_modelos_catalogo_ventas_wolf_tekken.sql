-- Modelos específicos que aparecen en las descripciones reales de products.
-- El agente vendedor los carga dinámicamente para contrastar el modelo que
-- escribió el cliente con los modelos que declara cada repuesto.

INSERT INTO public.agent_known_models (name, notes) VALUES
  ('WOLF 250', 'Familia Wolf: modelo distinto de Wolf 200'),
  ('WOLF EVOLUTION', 'Familia Wolf: modelo 250 distinto de Wolf 250'),
  ('SUPER WOLF', 'Familia Wolf: modelo 300 distinto'),
  ('TEKKEN 250', 'Tekken anterior; en el catálogo histórico suele figurar solo como TEKKEN'),
  ('TEKKEN EVO', 'Tekken Evo 250'),
  ('TEKKEN DISCOVERY', 'Tekken Discovery 300')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.agent_model_disambiguations (models, question_hint) VALUES
  (
    ARRAY['TEKKEN'],
    'Hay tres modelos Tekken distintos: Tekken 250 (modelo anterior), Tekken Evo 250 y Tekken Discovery 300. Pregunta cuál de los tres tiene antes de buscar o cotizar.'
  )
ON CONFLICT (models) DO UPDATE
SET question_hint = EXCLUDED.question_hint;
