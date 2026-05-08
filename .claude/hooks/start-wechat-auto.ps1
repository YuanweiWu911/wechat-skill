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

if ($env:WECHAT_AUTO_REPLY_CHILD -eq "1") {
  Write-Output '{"continue":true,"suppressOutput":true}'
  exit 0
}

if (-not (Test-Path $claudeDir)) {
  New-Item -ItemType Directory -Path $claudeDir | Out-Null
}

# Force-kill ALL old wechat watcher processes
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'wechat-auto-reply\.ts' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Force-kill ALL orphan cc-weixin server processes
Get-CimInstance Win32_Process -Filter "Name='bun.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'cc-weixin\\weixin' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Clean up stale PID file
Remove-Item $pidPath -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

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
