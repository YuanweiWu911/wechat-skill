param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Set-Location $ProjectRoot

$logPath = Join-Path $ProjectRoot ".claude\wechat-auto.log"
$scriptPath = Join-Path $ProjectRoot ".claude\hooks\wechat-auto-reply.ts"

$backoff = 2
$maxBackoff = 120

while ($true) {
  $exitCode = 999
  try {
    bun run $scriptPath --project-root $ProjectRoot *>> $logPath
    $exitCode = $LASTEXITCODE
  } catch {
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
    "[$timestamp] Runner: crash $_" | Add-Content -Path $logPath -Encoding UTF8
  }

  if ($exitCode -eq 0) {
    break
  }

  $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ss.fffZ"
  "[$timestamp] Runner: watcher exit $exitCode, restart in ${backoff}s" | Add-Content -Path $logPath -Encoding UTF8

  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($backoff * 2, $maxBackoff)
}
