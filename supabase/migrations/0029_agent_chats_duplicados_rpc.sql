-- Migration: detectar los chats duplicados DENTRO de la base.
--
-- Por qué: el job que une los chats partidos (mismo cliente con teléfono y
-- con LID) traía la tabla de conversaciones entera y buscaba los pares en
-- JavaScript. Con 3.500 conversaciones eso son ~875 KB por vuelta, y
-- corriendo seguido son varios GB de egress al mes -- casi toda la cuota
-- gratuita de Supabase -- para no encontrar NADA el 99% de las veces.
--
-- Filtrar por "tiene LID" tampoco servía: se midió, el 97% de los chats
-- tienen LID (WhatsApp direccionó así casi todo el historial), así que el
-- filtro ahorraba apenas un 3%.
--
-- Con esto la búsqueda pasa a Postgres y por el cable viajan solo los
-- pares encontrados: casi siempre cero filas.
--
-- Los dos patrones de duplicado, los dos vistos en datos reales:
--
--   1. El chat SIEMPRE fue por LID. Una fila guardó el teléfono real y
--      tiene `chat_jid` @lid; otra guardó los dígitos del LID en la
--      columna del teléfono.
--
--   2. WhatsApp MIGRÓ el chat de teléfono a LID. La fila vieja quedó con
--      `chat_jid` @s.whatsapp.net y la nueva con @lid, así que el patrón 1
--      no las ve. Lo único que las une es la columna `lid`, que el agente
--      completa cuando un mensaje trae las dos identidades juntas.
--
-- Los dos se reducen a lo mismo: una fila cuyo `phone_number` es la
-- identidad LID de OTRA fila.

BEGIN;

CREATE OR REPLACE FUNCTION public.agent_chats_duplicados()
RETURNS TABLE (
    -- La fila que tiene el teléfono real del cliente.
    id_telefono BIGINT,
    -- La fila identificada por el LID (phone_number = dígitos del LID).
    id_lid BIGINT
)
LANGUAGE sql
STABLE
AS $$
    WITH identidades AS (
        SELECT
            c.id,
            c.phone_number,
            -- El LID del chat, venga de la columna o de la dirección.
            COALESCE(
                c.lid,
                CASE WHEN c.chat_jid LIKE '%@lid' THEN split_part(c.chat_jid, '@', 1) END
            ) AS lid_real
        FROM public.agent_conversations c
    )
    SELECT con_tel.id, con_lid.id
    FROM identidades con_tel
    JOIN identidades con_lid
      ON con_lid.phone_number = con_tel.lid_real
    WHERE con_tel.lid_real IS NOT NULL
      -- La fila del teléfono guarda un teléfono, no el propio LID: si
      -- fueran iguales sería la misma fila consigo misma.
      AND con_tel.phone_number <> con_tel.lid_real
      AND con_tel.id <> con_lid.id;
$$;

COMMENT ON FUNCTION public.agent_chats_duplicados() IS
    'Pares de conversaciones que son el mismo cliente (una por telefono, otra por LID). Las une el job del agente / npm run unificar-chats.';

GRANT EXECUTE ON FUNCTION public.agent_chats_duplicados() TO service_role, authenticated;

-- La búsqueda cruza `phone_number` contra el LID, así que conviene tener
-- indexado por dónde se entra.
CREATE INDEX IF NOT EXISTS idx_agent_conversations_lid
    ON public.agent_conversations(lid) WHERE lid IS NOT NULL;

COMMIT;
