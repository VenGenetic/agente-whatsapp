/**
 * Delay "humano" antes de enviar un mensaje saliente, para no responder de
 * forma instantánea y perfectamente regular como un bot -- reduce el riesgo
 * de que Meta lo detecte como automatizado.
 *
 * Se acortó (era 1.2-3.5s) porque el cliente está esperando en el chat y
 * cada segundo cuenta para que no se vaya. Sigue siendo aleatorio y no
 * instantáneo, que es lo que importa para no parecer un bot.
 */
export function randomDelayMs(minMs = 600, maxMs = 1500): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
}

export async function humanDelay(minMs?: number, maxMs?: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, randomDelayMs(minMs, maxMs)))
}
