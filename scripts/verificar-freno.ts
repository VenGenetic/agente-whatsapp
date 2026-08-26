/**
 * Comprueba el freno de salida (src/whatsapp/outboundGuard.ts) sin tocar
 * WhatsApp ni la base: cero mensajes reales, se puede correr cuando sea.
 *
 * Existe porque "el agente no le escribe a nadie" es una afirmación que
 * hay que poder verificar, no asumir. Cada modo se prueba en un proceso
 * aparte porque la config se lee una sola vez, al importar.
 *
 * Uso: npm run verificar-freno
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const NUMERO_CLIENTE = '593987654321@s.whatsapp.net'

/** Corre las pruebas de un modo en un proceso limpio. */
function correrModo(modo: string): boolean {
  const resultado = spawnSync(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--hijo'],
    { env: { ...process.env, OUTBOUND_MODE: modo }, encoding: 'utf-8' },
  )
  process.stdout.write(resultado.stdout ?? '')
  if (resultado.status !== 0) process.stderr.write(resultado.stderr ?? '')
  return resultado.status === 0
}

async function pruebasDelHijo(): Promise<void> {
  const { config } = await import('../src/config.js')
  const { puedeEnviar, conPermiso } = await import('../src/whatsapp/outboundGuard.js')
  const { toWhatsAppJid } = await import('../src/utils/phone.js')

  const jidDueno = toWhatsAppJid(config.ownerPhoneNumber)
  let fallos = 0

  const esperar = (etiqueta: string, real: boolean, esperado: boolean) => {
    if (real === esperado) {
      console.log(`  OK   ${etiqueta}`)
    } else {
      fallos++
      console.log(`FALLÓ  ${etiqueta} (esperado ${esperado ? 'PERMITIDO' : 'BLOQUEADO'}, fue ${real ? 'PERMITIDO' : 'BLOQUEADO'})`)
    }
  }

  console.log(`\nOUTBOUND_MODE=${config.outboundMode}`)

  // El dueño recibe siempre: son avisos internos, no mensajes a clientes.
  esperar('aviso al dueño', puedeEnviar(jidDueno).permitido, true)

  const automatico = puedeEnviar(NUMERO_CLIENTE).permitido
  esperar('mensaje automático a un cliente', automatico, config.outboundMode === 'full')

  const desdeErp = await conPermiso('human_erp', async () => puedeEnviar(NUMERO_CLIENTE).permitido)
  esperar(
    'mensaje escrito a mano desde el ERP',
    desdeErp,
    config.outboundMode === 'full' || config.outboundMode === 'erp_only',
  )

  if (fallos > 0) {
    console.log(`\n${fallos} comprobación(es) fallaron en modo ${config.outboundMode}.`)
    process.exit(1)
  }
}

if (process.argv.includes('--hijo')) {
  await pruebasDelHijo()
} else {
  console.log('Verificando el freno de salida (no se manda ningún mensaje real).')
  // Se prueba un valor inválido a propósito: tiene que caer en 'blocked',
  // no en "permitir todo".
  const modos = ['blocked', 'erp_only', 'full', 'typo-invalido']
  const ok = modos.map(correrModo).every(Boolean)
  console.log(ok ? '\nTodo bien: el freno se comporta como dice la config.' : '\nHAY FALLOS (ver arriba).')
  process.exit(ok ? 0 : 1)
}
