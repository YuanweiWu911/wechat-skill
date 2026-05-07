param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InboxArgs
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$weixinInboxScript = Join-Path $repoRoot "weixin-inbox.ps1"

if (-not (Test-Path $weixinInboxScript)) {
  throw "Missing weixin-inbox.ps1 at $weixinInboxScript"
}

$normalizedArgs = @()
if ($InboxArgs) {
  $normalizedArgs = $InboxArgs
}

$copyOutput = & $weixinInboxScript copy @normalizedArgs 2>&1
$copyExit = $LASTEXITCODE

$exportOutput = & $weixinInboxScript export @normalizedArgs 2>&1
$exportExit = $LASTEXITCODE

if ($copyExit -ne 0 -and $exportExit -ne 0) {
  throw "Both clipboard copy and export failed.`nCopy output:`n$copyOutput`n`nExport output:`n$exportOutput"
}

Write-Output "WeChat Skill 2.0 sync"
Write-Output ""

if ($copyExit -eq 0) {
  Write-Output "Clipboard:"
  Write-Output $copyOutput
} else {
  Write-Output "Clipboard:"
  Write-Output "Copy failed, but export is still available."
  Write-Output $copyOutput
}

Write-Output ""
Write-Output "Imported messages:"
Write-Output $exportOutput
