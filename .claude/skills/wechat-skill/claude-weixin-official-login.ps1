param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptRoot "..\..\..")
$altSettingsPath = Join-Path $projectRoot ".claude\settings.weixin-session.json"

if (-not (Test-Path $altSettingsPath)) {
  throw "Missing alternate settings file: $altSettingsPath"
}

& claude --settings $altSettingsPath auth login @ClaudeArgs
exit $LASTEXITCODE
