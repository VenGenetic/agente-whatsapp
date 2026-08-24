/**
 * Reintenta una operación que falla de forma intermitente (ej. Gemini
 * colgándose o devolviendo 503 "alta demanda"). Un solo reintento corto
 * alcanza para la enorme mayoría de estos casos -- no es para errores
 * persistentes, para eso sigue estando el fallback de escalamiento.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
  }
  throw lastError
}
