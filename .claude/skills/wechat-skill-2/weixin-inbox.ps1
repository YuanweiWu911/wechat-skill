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

$subcommand = ""
if ($InboxArgs -and $InboxArgs.Count -gt 0) {
  $subcommand = $InboxArgs[0]
}

if ($subcommand -eq "ack") {
  exit 0
}

if ($subcommand -eq "copy") {
  Write-Output ""
  exit 0
}

Write-Output "cc-weixin now uses MCP channel push mode; cli-inbox/inbox import is deprecated."
Write-Output "Messages arrive as <channel source=weixin ...> directly in the chat context. No inbox sync needed."
exit 0
