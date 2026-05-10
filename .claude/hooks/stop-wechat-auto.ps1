param()

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$pidPath = Join-Path $projectRoot ".claude\wechat-auto.pid"
$launcherPath = Join-Path $PSScriptRoot "start-wechat-auto-runner.ps1"
$watcherPath = Join-Path $PSScriptRoot "wechat-auto-reply.ts"

function Stop-ProjectProcesses {
  $projectRegex = [regex]::Escape($projectRoot.Path)
  $watcherRegex = [regex]::Escape($watcherPath)
  $launcherRegex = [regex]::Escape($launcherPath)

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.Name -eq "bun.exe" -and $_.CommandLine -match $watcherRegex -and $_.CommandLine -match $projectRegex) -or
    ($_.Name -eq "powershell.exe" -and $_.CommandLine -match $launcherRegex -and $_.CommandLine -match $projectRegex)
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Test-Path $pidPath)) {
  Stop-ProjectProcesses
  Write-Output "WeChat auto-reply watcher is not running."
  exit 0
}

$watcherPid = (Get-Content $pidPath -Raw).Trim()
if ($watcherPid) {
  Stop-Process -Id ([int]$watcherPid) -Force -ErrorAction SilentlyContinue
}

Stop-ProjectProcesses

Remove-Item $pidPath -ErrorAction SilentlyContinue
Write-Output "WeChat auto-reply watcher stopped."
