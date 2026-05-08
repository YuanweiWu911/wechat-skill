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

$pluginRoot = "C:\Users\len\.claude\plugins\cache\cc-weixin\weixin\0.2.0"

if (-not (Test-Path $pluginRoot)) {
  throw "Weixin plugin is not installed at the expected path."
}

if ($InboxArgs.Count -eq 0) {
  $InboxArgs = @("list")
}

Push-Location $pluginRoot
try {
  & bun src/cli-inbox.ts @InboxArgs
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
