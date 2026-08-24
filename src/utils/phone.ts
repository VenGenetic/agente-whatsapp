/**
 * Arma un JID de WhatsApp a partir de un número en cualquier formato humano
 * razonable ('+593 98 765 4321', '593987654321', etc.) -- un JID real nunca
 * lleva '+' ni espacios, así que normalizamos acá en vez de confiar en que
 * cada .env/entrada venga ya en el formato exacto.
 */
export function toWhatsAppJid(phoneNumber: string): string {
  return `${normalizePhoneNumber(phoneNumber)}@s.whatsapp.net`
}

/**
 * Forma canónica de un teléfono para guardar en la base: solo dígitos.
 *
 * Hace falta porque WhatsApp entrega el mismo número en formatos
 * distintos según de dónde venga ('+593...', '593...', '+593 96 789
 * 9868'), y sin normalizar el MISMO cliente terminaba como dos
 * conversaciones separadas -- pasó de verdad, 11 duplicados (ver
 * migración 0021).
 */
export function normalizePhoneNumber(phoneNumber: string): string {
  return phoneNumber.replace(/\D/g, '')
}

/**
 * true si el identificador es un LID de WhatsApp (id interno) y no un
 * teléfono. WhatsApp usa LIDs en chats donde no expone el número real; se
 * guardan aparte para no ensuciar la columna del teléfono.
 */
export function isLid(jid: string): boolean {
  return jid.includes('@lid')
}

/**
 * Un LID de WhatsApp es un identificador interno, NO un teléfono. Se
 * distingue por el largo: los teléfonos con código de país llegan a ~13
 * dígitos como mucho (Ecuador: 593 + 9 = 12), los LIDs son de 14-15.
 */
export function looksLikeLid(identifier: string): boolean {
  const digits = identifier.replace(/\D/g, '')
  return digits.length > 13
}

/**
 * Dirección de WhatsApp a la que hay que ENVIAR, a partir de lo guardado
 * en la conversación.
 *
 * Es distinto de `toWhatsAppJid`: un chat identificado por LID necesita el
 * sufijo `@lid`, no `@s.whatsapp.net`. Se detectó en vivo -- el agente
 * mandó su saludo a "124327005577278@s.whatsapp.net", una dirección que
 * no existe, y el cliente nunca recibió nada (el envío no falla: WhatsApp
 * lo acepta y lo tira al vacío).
 */
export function toChatJid(conversation: { phone_number: string; lid?: string | null }): string {
  const lid = conversation.lid?.replace(/\D/g, '')
  if (lid) return `${lid}@lid`

  const identifier = normalizePhoneNumber(conversation.phone_number)
  if (looksLikeLid(identifier)) return `${identifier}@lid`
  return `${identifier}@s.whatsapp.net`
}
