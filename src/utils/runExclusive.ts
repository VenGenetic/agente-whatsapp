const queues = new Map<string, Promise<unknown>>()

/**
 * Encadena `fn` detrás de lo último encolado con la misma `key`, para que
 * dos llamadas con la misma key nunca corran en paralelo -- llamadas con
 * keys distintas sí corren en paralelo, sin esperarse entre sí.
 *
 * Hace falta porque Baileys dispara 'messages.upsert' una vez por cada
 * tanda que llega de WhatsApp, y el handler es async sin que nada lo
 * espere -- si el mismo cliente manda dos mensajes seguidos (algo muy
 * común: "hola" y dos segundos después "necesito un filtro"), sin esto se
 * procesan los dos A LA VEZ. Eso duplica llamadas a Gemini con historial
 * desactualizado (el segundo mensaje no ve la respuesta al primero
 * todavía) y puede mandar las dos respuestas fuera de orden.
 */
export function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(fn, fn)
  // Guardamos una versión que nunca rechaza como cola -- si no, un mensaje
  // que falla dejaría la cola de ESE cliente rota para siempre (todo lo
  // que venga después con la misma key heredaría el rechazo sin correr
  // `fn`). El error real igual se propaga a quien llamó a runExclusive,
  // vía el `next` que se devuelve acá.
  const settled = next.catch(() => undefined)
  queues.set(key, settled)
  // Si nadie encoló nada más para esta key mientras corría, la sacamos del
  // mapa -- si no, `queues` crece para siempre con una entrada por cada
  // número que haya escrito alguna vez en la vida del proceso.
  settled.finally(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return next
}
