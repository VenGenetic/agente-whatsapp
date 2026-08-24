-- Migration: Bucket privado para respaldar la sesión de Baileys (auth-state)
-- PROPUESTA — no aplicada todavía.
--
-- Sin políticas para 'authenticated'/'anon' a propósito: solo el proceso Node
-- del bot toca este bucket, y lo hace con la SERVICE ROLE key, que no pasa
-- por RLS/policies de storage. Nadie más necesita acceso.

INSERT INTO storage.buckets (id, name, public)
VALUES ('agent_whatsapp_session', 'agent_whatsapp_session', false)
ON CONFLICT (id) DO NOTHING;
