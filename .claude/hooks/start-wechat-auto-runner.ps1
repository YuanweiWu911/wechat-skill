param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$env:NODE_OPTIONS = ""
$env:BUN_UTF8 = "1"

Set-Location $ProjectRoot

$logPath = Join-Path $ProjectRoot ".claude\wechat-auto.log"
$scriptPath = Join-Path $ProjectRoot ".claude\hooks\wechat-auto-reply.ts"

$backoff = 2
$maxBackoff = 120

while ($true) {
  $exitCode = 999
  try {
    & bun run $scriptPath --project-root $ProjectRoot *>> $logPath
    $exitCode = $LASTEXITCODE
  } catch {
    $timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    "[$timestamp] Runner: crash $_" | Add-Content -Path $logPath -Encoding UTF8
  }

  if ($exitCode -eq 0 -or $exitCode -eq 1 -or $exitCode -eq 2) {
    break
  }

  $timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  "[$timestamp] Runner: watcher exit $exitCode, restart in ${backoff}s" | Add-Content -Path $logPath -Encoding UTF8

  Start-Sleep -Seconds $backoff
  $backoff = [Math]::Min($backoff * 2, $maxBackoff)
}
