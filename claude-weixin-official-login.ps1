param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$altSettingsPath = Join-Path $scriptRoot ".claude\settings.weixin-session.json"

if (-not (Test-Path $altSettingsPath)) {
  throw "Missing alternate settings file: $altSettingsPath"
}

& claude --settings $altSettingsPath auth login @ClaudeArgs
exit $LASTEXITCODE
