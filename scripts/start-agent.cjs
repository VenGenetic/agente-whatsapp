const { spawn } = require('node:child_process')
const path = require('node:path')

const projectDir = path.resolve(__dirname, '..')
const shimPath = path.join(__dirname, 'node-userinfo-shim.cjs')
const tsxCliPath = path.join(projectDir, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const existingNodeOptions = process.env.NODE_OPTIONS?.trim()
const preloadOption = `--require=${shimPath}`
const nodeOptions = existingNodeOptions?.includes(shimPath)
  ? existingNodeOptions
  : [existingNodeOptions, preloadOption].filter(Boolean).join(' ')

const child = spawn(process.execPath, [tsxCliPath, path.join(projectDir, 'src', 'index.ts')], {
  cwd: projectDir,
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
  stdio: 'inherit',
  windowsHide: true,
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.on('error', (error) => {
  console.error('No se pudo iniciar el proceso del agente:', error)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
