# Agente de WhatsApp — repuestos usados

Servicio Node separado del SPA de `sistema_erp`. Se conecta a WhatsApp con
Baileys (número dedicado) y al mismo proyecto de Supabase que el ERP, usando
la SERVICE ROLE key.

**Estado actual: funcional de punta a punta.** Conecta a WhatsApp, interpreta
cada mensaje (texto/foto/audio) con Gemini, busca el producto en `products`
(alias aprendidos + similitud pg_trgm), aplica las reglas de negocio
(stock/demanda/no-catálogo/escalamiento), redacta y manda la respuesta, y
loguea todo en `agent_conversations` / `agent_messages`. También corre un job
periódico que avisa por WhatsApp cuando llega el stock de una demanda
pendiente. Ver `docs/system-prompts.md` para el diseño de los prompts.

Verificado contra Supabase y Gemini reales (`npm run verify` — ver
`scripts/verify-setup.ts`): migraciones aplicadas, RPC de búsqueda
encontrando productos reales, y las dos llamadas de Gemini funcionando de
punta a punta. Falta la prueba con un WhatsApp real -- necesita escanear el
QR desde el teléfono dedicado del bot.

## Setup

1. Aplicar las migraciones nuevas en el proyecto de Supabase (mismo proyecto
   que usa `sistema_erp`), en orden:
   - `supabase/migrations/0001_agent_whatsapp_schema.sql`
   - `supabase/migrations/0002_agent_session_backup_bucket.sql`
   - `supabase/migrations/0003_agent_search_products.sql`
2. `npm install`
3. Copiar `.env.example` a `.env` y completar:
   - `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (Project Settings > API en
     Supabase — la service_role, nunca la anon)
   - `GEMINI_API_KEY` (la misma que ya usa `sistema_erp`)
   - `BUSINESS_NAME` (se usa en el prompt del redactor)
   - `OWNER_PHONE_NUMBER` (a dónde te avisa el bot cuando escala una
     conversación)
4. `npm run dev`
5. Escanear el QR que aparece en la terminal **desde el WhatsApp dedicado
   del bot**, no desde un número personal.

Si todo anda bien, cada mensaje que llegue al número del bot dispara el flujo
completo: interpretación → búsqueda → regla de negocio → respuesta redactada
y enviada.

## Deploy (Hetzner)

Guía completa paso a paso en `docs/deploy-hetzner.md` (crear el servidor,
Node + pm2, llevar el código, variables de entorno, levantar y verificar).

Resumen: VPS chico (CX22 alcanza de sobra), Node 20+, `pm2` para mantenerlo
vivo. La carpeta `auth_state/` vive en el disco del VPS, pero si el VPS se
pierde no hace falta re-escanear el QR desde cero -- al arrancar en una
máquina nueva, el proceso restaura la sesión automáticamente desde el
bucket `agent_whatsapp_session` en Supabase Storage. No se necesita build
(`npm run start` corre TypeScript directo vía `tsx`).
