$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$collectScript = Join-Path $scriptDir ".claude\skills\wechat-skill-2\collect-wechat.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -File $collectScript --start
