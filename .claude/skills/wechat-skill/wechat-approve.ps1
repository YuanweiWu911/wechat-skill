param(
  [string]$Command = "list",
  [string]$Id = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$cliPath = Join-Path $projectRoot ".claude\hooks\wechat-approve-cli.ts"

if ($Id) {
  bun run --cwd $projectRoot $cliPath $Command $Id
} else {
  bun run --cwd $projectRoot $cliPath $Command
}
