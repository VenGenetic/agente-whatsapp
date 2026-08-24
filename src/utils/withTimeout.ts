/**
 * Evita que una llamada externa (ej. Gemini) se quede colgada para siempre.
 * Si `promise` no resuelve dentro de `ms`, rechaza con un error claro en vez
 * de dejar la conversación en el limbo sin respuesta ni log.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms) esperando: ${label}`)), ms)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer!)
  }
}
