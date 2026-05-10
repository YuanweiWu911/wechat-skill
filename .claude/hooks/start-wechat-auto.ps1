param()

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['*:Encoding'] = 'utf8'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$claudeDir = Join-Path $projectRoot ".claude"
$pidPath = Join-Path $claudeDir "wechat-auto.pid"
$runnerPath = Join-Path $PSScriptRoot "wechat-auto-reply.ts"
$launcherPath = Join-Path $PSScriptRoot "start-wechat-auto-runner.ps1"

function Get-ProjectMutexName {
  $md5 = [System.Security.Cryptography.MD5]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($projectRoot.Path)
    $hash = [System.BitConverter]::ToString($md5.ComputeHash($bytes)).Replace("-", "").ToLowerInvariant()
    return "Global\claude-wechat-auto-$hash"
  } finally {
    $md5.Dispose()
  }
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

  return $commandLine -match [regex]::Escape($launcherPath) -and $commandLine -match [regex]::Escape($projectRoot.Path)
}

if ($env:WECHAT_AUTO_REPLY_CHILD -eq "1") {
  Write-Output '{"continue":true,"suppressOutput":true}'
  exit 0
}

if (-not (Test-Path $claudeDir)) {
  New-Item -ItemType Directory -Path $claudeDir | Out-Null
}

$mutex = [System.Threading.Mutex]::new($false, (Get-ProjectMutexName))
$lockTaken = $false

try {
  $lockTaken = $mutex.WaitOne(0)
  if (-not $lockTaken) {
    Write-Output '{"continue":true,"suppressOutput":true}'
    exit 0
  }

  if (Test-Path $pidPath) {
    $runnerPidRaw = (Get-Content $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
    $runnerPid = 0
    if ([int]::TryParse($runnerPidRaw, [ref]$runnerPid)) {
      $existingRunner = Get-RunnerProcess $runnerPid
      if (Test-RunnerMatchesProject $existingRunner) {
        Write-Output '{"continue":true,"suppressOutput":true}'
        exit 0
      }
    }

    Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
  }

  $process = Start-Process `
    -FilePath "powershell" `
    -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $launcherPath,
      "-ProjectRoot", $projectRoot
    ) `
    -WindowStyle Hidden `
    -PassThru

  Set-Content -Path $pidPath -Value $process.Id -Encoding UTF8
  Write-Output '{"continue":true,"suppressOutput":true}'
} finally {
  if ($lockTaken) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
}
