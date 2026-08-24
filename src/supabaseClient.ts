import { createClient } from '@supabase/supabase-js'
import { config } from './config.js'

// Cliente server-side con la SERVICE ROLE key: no pasa por RLS de usuario.
// Nunca importar este módulo desde código que corra en el navegador.
export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false },
})
