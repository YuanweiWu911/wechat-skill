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

$weixinInboxScript = Join-Path $PSScriptRoot "weixin-inbox.ps1"
$stopWatcherScript = Join-Path $PSScriptRoot "..\..\hooks\stop-wechat-auto.ps1"

if (-not (Test-Path $weixinInboxScript)) {
  throw "Missing weixin-inbox.ps1 at $weixinInboxScript"
}

if (-not (Test-Path $stopWatcherScript)) {
  throw "Missing stop-wechat-auto.ps1 at $stopWatcherScript"
}

function ConvertFrom-CodePoints([int[]]$CodePoints) {
  return (-join ($CodePoints | ForEach-Object { [char]$_ }))
}

$normalizedArgs = @()
if ($InboxArgs) {
  $normalizedArgs = $InboxArgs
}

$stopRequested = $normalizedArgs -contains "--stop"
$usesAll = $normalizedArgs -contains "--all"
$usesLimit = [Array]::IndexOf($normalizedArgs, "--limit") -ge 0

$stopConflictMessage = ConvertFrom-CodePoints @(0x53C2, 0x6570, 0x51B2, 0x7A81, 0xFF1A)
$stopConflictMessage += "--stop "
$stopConflictMessage += ConvertFrom-CodePoints @(0x4E0D, 0x80FD, 0x4E0E)
$stopConflictMessage += " --all "
$stopConflictMessage += ConvertFrom-CodePoints @(0x6216)
$stopConflictMessage += " --limit "
$stopConflictMessage += ConvertFrom-CodePoints @(0x540C, 0x65F6, 0x4F7F, 0x7528, 0x3002)

$stopFailurePrefix = ConvertFrom-CodePoints @(0x505C, 0x6B62)
$stopFailurePrefix += " watcher "
$stopFailurePrefix += ConvertFrom-CodePoints @(0x5931, 0x8D25, 0x3002)

$noOutputMessage = ConvertFrom-CodePoints @(0x65E0, 0x8F93, 0x51FA)
$watcherNotRunningMessage = "watcher " + (ConvertFrom-CodePoints @(0x672A, 0x8FD0, 0x884C, 0xFF0C, 0x65E0, 0x9700, 0x505C, 0x6B62, 0x3002))
$watcherStoppedMessage = (ConvertFrom-CodePoints @(0x5DF2, 0x505C, 0x6B62)) + " watcher" + (ConvertFrom-CodePoints @(0x3002))

if ($stopRequested) {
  if ($usesAll -or $usesLimit) {
    throw $stopConflictMessage
  }

  $stopOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $stopWatcherScript 2>&1
  $stopExit = $LASTEXITCODE
  $stopText = ($stopOutput | Out-String).Trim()

  if ($stopExit -ne 0) {
    $summary = $noOutputMessage
    if ($stopText) {
      $summary = $stopText
    }
    throw "$stopFailurePrefix`n$summary"
  }

  if ($stopText -match "not running") {
    Write-Output $watcherNotRunningMessage
    exit 0
  }

  Write-Output $watcherStoppedMessage
  exit 0
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
