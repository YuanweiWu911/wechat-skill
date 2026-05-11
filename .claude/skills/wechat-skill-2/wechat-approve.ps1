param(
  [string]$Command = "list",
  [string]$Id = ""
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$env:BUN_UTF8 = "1"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$cliPath = Join-Path $projectRoot ".claude\hooks\wechat-approve-cli.ts"

if ($Id) {
  bun run --cwd $projectRoot $cliPath $Command $Id
} else {
  bun run --cwd $projectRoot $cliPath $Command
}
