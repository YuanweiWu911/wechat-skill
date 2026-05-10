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
$pidPath = Join-Path $ProjectRoot ".claude\wechat-auto.pid"
$scriptPath = Join-Path $ProjectRoot ".claude\hooks\wechat-auto-reply.ts"
$launcherPath = Join-Path $ProjectRoot ".claude\hooks\start-wechat-auto-runner.ps1"

function Test-RunnerProcess([int]$ProcessId) {
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    return $processInfo.CommandLine -match [regex]::Escape($launcherPath) -and $processInfo.CommandLine -match [regex]::Escape($ProjectRoot)
  } catch {
    return $false
  }
}

function Resolve-BunExePath {
  if ($env:BUN_EXE -and (Test-Path $env:BUN_EXE)) {
    return $env:BUN_EXE
  }

  $candidates = New-Object System.Collections.Generic.List[string]
  try {
    $command = Get-Command bun -ErrorAction Stop
    if ($command.Source) { [void]$candidates.Add($command.Source) }
    if ($command.Path) { [void]$candidates.Add($command.Path) }
  } catch {
  }

  try {
    foreach ($candidate in (where.exe bun 2>$null)) {
      if ($candidate) { [void]$candidates.Add($candidate) }
    }
  } catch {
  }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ($candidate -match '\.exe$' -and (Test-Path $candidate)) {
      return $candidate
    }

    $candidateDir = Split-Path $candidate -Parent
    if ($candidateDir) {
      $siblingExe = Join-Path $candidateDir "node_modules\bun\bin\bun.exe"
      if (Test-Path $siblingExe) {
        return $siblingExe
      }
    }
  }

  throw "Unable to resolve bun.exe"
}

$backoff = 2
$maxBackoff = 120
$bunExe = Resolve-BunExePath
$currentRunnerPid = $PID

if (Test-Path $pidPath) {
  $registeredPidRaw = (Get-Content $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
  $registeredPid = 0
  if ([int]::TryParse($registeredPidRaw, [ref]$registeredPid) -and $registeredPid -ne $currentRunnerPid -and (Test-RunnerProcess $registeredPid)) {
    $timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    "[$timestamp] Runner: duplicate start ignored (existing pid $registeredPid, current pid $currentRunnerPid)" | Add-Content -Path $logPath -Encoding UTF8
    exit 0
  }
}

Set-Content -Path $pidPath -Value $currentRunnerPid -Encoding UTF8
"[$([DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"))] Runner: started pid=$currentRunnerPid bun=$bunExe" | Add-Content -Path $logPath -Encoding UTF8

while ($true) {
  if (-not (Test-Path $pidPath)) {
    break
  }

  $activePidRaw = (Get-Content $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
  $activePid = 0
  if ([int]::TryParse($activePidRaw, [ref]$activePid) -and $activePid -ne $currentRunnerPid) {
    $timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    "[$timestamp] Runner: pid file reassigned to $activePid, exiting pid $currentRunnerPid" | Add-Content -Path $logPath -Encoding UTF8
    break
  }

  $exitCode = 999
  try {
    & $bunExe run $scriptPath --project-root $ProjectRoot *>> $logPath
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
