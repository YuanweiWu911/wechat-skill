param()

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$pidPath = Join-Path $projectRoot ".claude\wechat-auto.pid"

if (-not (Test-Path $pidPath)) {
  Write-Output "WeChat auto-reply watcher is not running."
  exit 0
}

$watcherPid = (Get-Content $pidPath -Raw).Trim()
if ($watcherPid) {
  Stop-Process -Id ([int]$watcherPid) -ErrorAction SilentlyContinue
}

Remove-Item $pidPath -ErrorAction SilentlyContinue
Write-Output "WeChat auto-reply watcher stopped."
