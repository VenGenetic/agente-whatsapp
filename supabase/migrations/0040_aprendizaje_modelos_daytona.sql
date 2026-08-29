BEGIN;
CREATE TABLE IF NOT EXISTS public.agent_daytona_model_aliases (
  alias TEXT PRIMARY KEY, canonical_model TEXT NOT NULL,
  observations INTEGER NOT NULL DEFAULT 1 CHECK (observations > 0),
  active BOOLEAN NOT NULL DEFAULT false,
  review_status TEXT NOT NULL DEFAULT 'auto' CHECK (review_status IN ('auto','approved','rejected','quarantined')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.agent_daytona_model_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read Daytona aliases" ON public.agent_daytona_model_aliases;
CREATE POLICY "Authenticated read Daytona aliases" ON public.agent_daytona_model_aliases FOR SELECT TO authenticated USING (true);
CREATE OR REPLACE FUNCTION public.agent_observe_daytona_model_alias(p_alias TEXT, p_canonical_model TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF length(trim(p_alias)) < 3 OR length(trim(p_canonical_model)) < 2 THEN RETURN; END IF;
  INSERT INTO public.agent_daytona_model_aliases(alias, canonical_model) VALUES (lower(trim(p_alias)), trim(p_canonical_model))
  ON CONFLICT (alias) DO UPDATE SET
    observations = CASE WHEN agent_daytona_model_aliases.canonical_model = EXCLUDED.canonical_model THEN agent_daytona_model_aliases.observations + 1 ELSE 1 END,
    canonical_model = CASE WHEN agent_daytona_model_aliases.review_status = 'approved' THEN agent_daytona_model_aliases.canonical_model ELSE EXCLUDED.canonical_model END,
    active = CASE WHEN agent_daytona_model_aliases.review_status = 'approved' THEN true WHEN agent_daytona_model_aliases.review_status = 'rejected' THEN false ELSE agent_daytona_model_aliases.canonical_model = EXCLUDED.canonical_model AND agent_daytona_model_aliases.observations + 1 >= 2 END,
    review_status = CASE WHEN agent_daytona_model_aliases.review_status IN ('approved','rejected') THEN agent_daytona_model_aliases.review_status WHEN agent_daytona_model_aliases.canonical_model = EXCLUDED.canonical_model THEN 'auto' ELSE 'quarantined' END,
    last_seen_at = NOW();
END; $$;
REVOKE ALL ON FUNCTION public.agent_observe_daytona_model_alias(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_observe_daytona_model_alias(TEXT, TEXT) TO service_role;
COMMIT;
