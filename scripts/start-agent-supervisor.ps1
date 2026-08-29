$ErrorActionPreference = 'Continue'

$projectDir = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $projectDir 'agent.supervisor.log'
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'WhatsAppAgentSupervisor', [ref]$createdNew)

if (-not $createdNew) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) No se inicio otra instancia: el supervisor ya esta activo."
  exit 0
}

try {
  Set-Location -LiteralPath $projectDir

  while ($true) {
    $startedAt = Get-Date
    Add-Content -LiteralPath $logPath -Value "$($startedAt.ToString('o')) Iniciando el agente."

    & npm.cmd run start
    $agentExitCode = $LASTEXITCODE
    $lifetimeSeconds = [int]((Get-Date) - $startedAt).TotalSeconds

    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) El agente termino con codigo $agentExitCode despues de $lifetimeSeconds segundos; reinicio en 10 segundos."
    Start-Sleep -Seconds 10
  }
}
finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
