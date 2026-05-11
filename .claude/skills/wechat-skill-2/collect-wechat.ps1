param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InboxArgs
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$env:BUN_UTF8 = "1"

$startWatcherScript = Join-Path $PSScriptRoot "..\..\hooks\start-wechat-auto.ps1"
$stopWatcherScript = Join-Path $PSScriptRoot "..\..\hooks\stop-wechat-auto.ps1"
$runnerLauncherPath = Join-Path $PSScriptRoot "..\..\hooks\start-wechat-auto-runner.ps1"
$pidPath = Join-Path $PSScriptRoot "..\..\wechat-auto.pid"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")

if (-not (Test-Path $startWatcherScript)) {
  throw "Missing start-wechat-auto.ps1 at $startWatcherScript"
}

if (-not (Test-Path $stopWatcherScript)) {
  throw "Missing stop-wechat-auto.ps1 at $stopWatcherScript"
}

function ConvertFrom-CodePoints([int[]]$CodePoints) {
  return (-join ($CodePoints | ForEach-Object { [char]$_ }))
}

function Get-RunnerProcess([int]$ProcessId) {
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-RunnerMatchesProject($ProcessInfo) {
  if (-not $ProcessInfo) {
    return $false
  }

  $commandLine = $ProcessInfo.CommandLine
  if (-not $commandLine) {
    return $false
  }

  return $commandLine -match [regex]::Escape($runnerLauncherPath) -and $commandLine -match [regex]::Escape($projectRoot.Path)
}

function Test-AnyRunnerMatchesProject {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -eq "powershell.exe" -and (Test-RunnerMatchesProject $_)
  } | Select-Object -First 1 | ForEach-Object {
    return $true
  }

  return $false
}

function Test-WatcherRunning {
  if (Test-Path $pidPath) {
    $runnerPidRaw = (Get-Content $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
    $runnerPid = 0
    if ([int]::TryParse($runnerPidRaw, [ref]$runnerPid)) {
      $runnerProcess = Get-RunnerProcess $runnerPid
      if ($runnerProcess) {
        return $true
      }
    }
  }

  return Test-AnyRunnerMatchesProject
}

function Wait-ForWatcherRunning([int]$TimeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-WatcherRunning) {
      return $true
    }

    Start-Sleep -Milliseconds 250
  }

  return Test-WatcherRunning
}

$normalizedArgs = @()
if ($InboxArgs) {
  $normalizedArgs = $InboxArgs
}

$startRequested = $normalizedArgs -contains "--start"
$stopRequested = $normalizedArgs -contains "--stop"
$usesAll = $normalizedArgs -contains "--all"
$usesLimit = [Array]::IndexOf($normalizedArgs, "--limit") -ge 0

$startExclusiveMessage = ConvertFrom-CodePoints @(0x53C2, 0x6570, 0x51B2, 0x7A81, 0xFF1A)
$startExclusiveMessage += "--start "
$startExclusiveMessage += ConvertFrom-CodePoints @(0x5FC5, 0x987B, 0x5355, 0x72EC, 0x4F7F, 0x7528, 0x3002)
$stopConflictMessage = ConvertFrom-CodePoints @(0x53C2, 0x6570, 0x51B2, 0x7A81, 0xFF1A)
$stopConflictMessage += "--stop "
$stopConflictMessage += ConvertFrom-CodePoints @(0x4E0D, 0x80FD, 0x4E0E)
$stopConflictMessage += " --all "
$stopConflictMessage += ConvertFrom-CodePoints @(0x6216)
$stopConflictMessage += " --limit "
$stopConflictMessage += ConvertFrom-CodePoints @(0x540C, 0x65F6, 0x4F7F, 0x7528, 0x3002)
$stopExclusiveMessage = ConvertFrom-CodePoints @(0x53C2, 0x6570, 0x51B2, 0x7A81, 0xFF1A)
$stopExclusiveMessage += "--stop "
$stopExclusiveMessage += ConvertFrom-CodePoints @(0x5FC5, 0x987B, 0x5355, 0x72EC, 0x4F7F, 0x7528, 0x3002)

$startFailurePrefix = ConvertFrom-CodePoints @(0x542F, 0x52A8)
$startFailurePrefix += " watcher "
$startFailurePrefix += ConvertFrom-CodePoints @(0x5931, 0x8D25, 0x3002)
$stopFailurePrefix = ConvertFrom-CodePoints @(0x505C, 0x6B62)
$stopFailurePrefix += " watcher "
$stopFailurePrefix += ConvertFrom-CodePoints @(0x5931, 0x8D25, 0x3002)

$noOutputMessage = ConvertFrom-CodePoints @(0x65E0, 0x8F93, 0x51FA)
$watcherAlreadyRunningMessage = "watcher " + (ConvertFrom-CodePoints @(0x5DF2, 0x5728, 0x8FD0, 0x884C, 0x3002))
$watcherStartedMessage = (ConvertFrom-CodePoints @(0x5DF2, 0x542F, 0x52A8)) + " watcher" + (ConvertFrom-CodePoints @(0x3002))
$watcherNotRunningMessage = "watcher " + (ConvertFrom-CodePoints @(0x672A, 0x8FD0, 0x884C, 0xFF0C, 0x65E0, 0x9700, 0x505C, 0x6B62, 0x3002))
$watcherStoppedMessage = (ConvertFrom-CodePoints @(0x5DF2, 0x505C, 0x6B62)) + " watcher" + (ConvertFrom-CodePoints @(0x3002))
$startNotObservedMessage = ConvertFrom-CodePoints @(0x672A, 0x89C2, 0x5BDF, 0x5230, 0x540E, 0x53F0, 0x20, 0x77, 0x61, 0x74, 0x63, 0x68, 0x65, 0x72, 0x20, 0x8FD0, 0x884C, 0x72B6, 0x6001, 0x3002)
$startObserveTimeoutMs = 8000
if ($env:WECHAT_START_OBSERVE_TIMEOUT_MS) {
  $parsedObserveTimeout = 0
  if ([int]::TryParse($env:WECHAT_START_OBSERVE_TIMEOUT_MS, [ref]$parsedObserveTimeout)) {
    $startObserveTimeoutMs = [Math]::Max(0, $parsedObserveTimeout)
  }
}

if ($startRequested) {
  if ($normalizedArgs.Length -ne 1) {
    throw $startExclusiveMessage
  }

  if (Test-WatcherRunning) {
    Write-Output $watcherAlreadyRunningMessage
    exit 0
  }

  $startOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $startWatcherScript 2>&1
  $startExit = $LASTEXITCODE
  $startText = ($startOutput | Out-String).Trim()

  if ($startExit -ne 0) {
    $summary = $noOutputMessage
    if ($startText) {
      $summary = $startText
    }

    throw "$startFailurePrefix`n$summary"
  }

  if (-not (Wait-ForWatcherRunning $startObserveTimeoutMs)) {
    $summary = $startNotObservedMessage
    if ($startText) {
      $summary += "`n$startText"
    }

    throw "$startFailurePrefix`n$summary"
  }

  Write-Output $watcherStartedMessage
  exit 0
}


if ($stopRequested) {
  if ($usesAll -or $usesLimit) {
    throw $stopConflictMessage
  }

  if ($normalizedArgs.Length -ne 1) {
    throw $stopExclusiveMessage
  }

  $stopOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $stopWatcherScript 2>&1
  $stopExit = $LASTEXITCODE
  $stopText = ($stopOutput | Out-String).Trim()

  if ($stopExit -ne 0) {
    $summary = $noOutputMessage
    if ($stopText) {
      $summary = $stopText
    }
    throw "$stopFailurePrefix`n$summary"
  }

  if ($stopText -match "not running") {
    Write-Output $watcherNotRunningMessage
    exit 0
  }

  Write-Output $watcherStoppedMessage
  exit 0
}

if (Test-WatcherRunning) {
  Write-Output $watcherAlreadyRunningMessage
} else {
  Write-Output $watcherNotRunningMessage
}

Write-Output ""
Write-Output "cc-weixin now uses MCP channel push: messages arrive as <channel source=weixin ...> directly in the chat context."
Write-Output "Inbox import/sync is deprecated."
