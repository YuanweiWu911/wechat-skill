# wechat-skill

`wechat-skill` is a Claude Code WeChat auto-reply repository built around `wechat-skill-2`.

## Current Version

- Main branch upgraded to **cc-weixin v0.2.1** compatibility
- Message flow: `cc-weixin getUpdates -> MCP channel push -> wechat-auto-reply watcher`
- Legacy `cli-inbox.ts` / `inbox.jsonl` import model is deprecated

## Plugin Dependency

This repository depends on the third-party WeChat plugin `cc-weixin v0.2.1`.

- Install via Skill Market: `cc-weixin`
- Upstream source: `https://github.com/qufei1993/cc-weixin`
- Git URL: `https://github.com/qufei1993/cc-weixin.git`

## Capabilities

- Background WeChat message watcher
- Auto chat replies
- File/image/video/voice attachment reception (CDN download + AES decrypt, uniform reply: `Received 《filename》, need help?`)
- Safe request auto-execution
- Risky request confirmation
- Whitelisted file sending from project root
- Send text messages and files from the GUI
- Watcher single-instance protection, timeout retry, state persistence

## Architecture

`cc-weixin v0.2.1` no longer writes messages to local inbox files via `cli-inbox.ts`. Instead, messages are pushed directly into the Claude conversation context:

1. `cc-weixin` uses `getUpdates` long-polling on the WeChat iLink Bot API
2. The plugin pushes WeChat messages via MCP `notifications/claude/channel`
3. Claude sessions show `<channel source="weixin" ...>` notifications
4. `.claude/hooks/wechat-auto-reply.ts` processes classification, execution, reply, and confirmation in the background
5. The watcher uses `.claude/wechat-auto-cursor.txt` for its own independent cursor

## Main Files

- `.claude/skills/wechat-skill-2/SKILL.md`
- `.claude/skills/wechat-skill-2/collect-wechat.ps1`
- `.claude/skills/wechat-skill-2/wechat-approve.ps1`
- `.claude/hooks/wechat-auto-reply.ts`
- `.claude/hooks/start-wechat-auto.ps1`
- `.claude/hooks/start-wechat-auto-runner.ps1`
- `.claude/hooks/stop-wechat-auto.ps1`
- `test-watcher.ts`
- `wechat-launcher.ts` — All-in-one launcher source (start watcher + inline HTTP server + launch browser)
- `wechat-launcher.exe` — Pre-compiled standalone executable (double-click, no external Bun needed)
- `wechat-send.ts` — CLI send tool (text/file to WeChat user)
- `wechat-gui-server.ts` — Standalone Bun backend server (dev mode)
- `wechat-skill-gui.html` — Single-page GUI frontend
- `.claude/hooks/wechat-tray.cs` — System tray C# source
- `.claude/hooks/wechat-tray.exe` — Compiled tray executable
- `.claude/hooks/wechat-tray.ico` — Tray icon
- `.claude/hooks/wechat-approve-cli.ts` — CLI tool to list/approve/reject pending risk approvals
- `claude-weixin-official-login.ps1` — Launch Claude Code with WeChat session for QR login
- `claude-weixin-official.ps1` — Launch Claude Code with WeChat session and dev channel
- `start-watcher.ps1` — Quick-start wrapper for the background watcher

## Usage

Start the background watcher:

```powershell
/wechat-skill-2 --start
```

Stop the background watcher:

```powershell
/wechat-skill-2 --stop
```

Check current status:

```powershell
/wechat-skill-2
```

Notes:
- Default `/wechat-skill-2` no longer performs inbox import
- Messages arrive via MCP channel push directly into Claude context
- Risk approvals can be reviewed manually via `wechat-approve.ps1`

## Web GUI

A browser-based control center for visual watcher management.

### One-Click Launch (Recommended)

Double-click `wechat-launcher.exe` to automatically:
1. Start the background watcher
2. Start the built-in GUI server (all `wechat-gui-server.ts` APIs inlined)
3. Open `http://localhost:3456` in the browser

> `wechat-launcher.exe` is a standalone executable — **no external Bun runtime required**.

### System Tray Mode (Background)

Double-click `wechat-launcher.exe` for background operation with a notification area icon:

- **Left-click** — Open GUI
- **Right-click menu** — Open GUI / Restart Watcher / Exit
- The tray program auto-monitors the launcher process and restarts it on unexpected exit
- Selecting **Exit** closes the launcher, GUI server, and tray icon

Core files:
| File | Description |
|------|-------------|
| `.claude/hooks/wechat-tray.cs` | System tray C# source |
| `.claude/hooks/wechat-tray.exe` | Compiled tray executable (~8KB) |

Compile the tray exe (uses Windows built-in .NET Framework csc.exe):

```powershell
"$env:windir\Microsoft.NET\Framework\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:.claude\hooks\wechat-tray.exe .claude\hooks\wechat-tray.cs
```

### Dev Mode Launch

```powershell
bun run wechat-gui-server.ts
```

Then open **http://localhost:3456**.

### Compile Launcher

The project root includes a pre-compiled `wechat-launcher.exe`. To recompile:

```powershell
bun build wechat-launcher.ts --compile --outfile wechat-launcher.exe
```

Produces ~117MB single-file executable.

### Core Files

| File | Description |
|------|-------------|
| `wechat-launcher.ts` | All-in-one launcher source (start watcher + inline HTTP server + launch browser) |
| `wechat-launcher.exe` | Pre-compiled standalone executable (double-click to run) |
| `wechat-send.ts` | CLI send tool (text/file to WeChat user) |
| `wechat-gui-server.ts` | Standalone Bun backend server (dev mode; launcher has it inlined) |
| `wechat-skill-gui.html` | Single-page frontend (dark/light theme) |

### GUI Features

- **Watcher status** — Real-time status badge with PID display
- **Start/Stop/Restart** — One-click watcher control
- **Message sending** — Input box at bottom, Enter to send; 📎 button for file transfer
- **File reception** — Attachments auto-downloaded (CDN + AES decrypt), displayed as clickable links with original filenames
- **Session list** — Sorted by last message time, click to switch
- **User nicknames** — Click avatar in session list to set display nickname (localStorage persisted)
- **Message bubbles** — WeChat-style, incoming left, outgoing right
- **Anti-flicker polling** — Data fingerprint comparison before DOM rebuild; only re-renders on actual change
- **History search** — Modal global keyword search
- **Risk approval panel** — Bottom panel listing pending items, approve/reject
- **Statistics** — Replied / risky-pending / dead-letter counts
- **Theme toggle** — Dark/light theme, persisted to localStorage

## Testing

Recommended regression entry:

```powershell
bun run .\test-watcher.ts risk
```

You can also verify the following flows with real WeChat messages:

- `chat`
- `executed`
- `risky`
- File transfer
- Watcher start/stop

## Security

- WeChat messages enter the Claude conversation context and are sent to the Anthropic API
- `cc-weixin` is installed via Skill Market; the GitHub repository is for source review, version tracking, and issue reporting
- The watcher persists state, cursor, logs, and pending review data in the local `.claude/` directory
- All PowerShell scripts run with `-ExecutionPolicy Bypass`
