# CLAUDE.md

Chinese version: see `CLAUDE_CN.md`.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This is a personal sandbox for learning, practicing, and prototyping Claude Code custom skills. The main active project is `wechat-skill-2`, which includes a Bun-based watcher, PowerShell launch scripts, watcher-focused regression tests in `test-watcher.ts`, and a Web GUI control center (`wechat-gui-server.ts` + `wechat-skill-gui.html`).

Current repository status: `wechat-skill-2` is upgraded to work with `cc-weixin v0.2.1`.

Dependency source:
- Install `cc-weixin v0.2.1` from Skill Market
- Upstream source repo: `https://github.com/qufei1993/cc-weixin`
- Git URL: `https://github.com/qufei1993/cc-weixin.git`

## Skill development

Custom skills live under `.claude/skills/<skill-name>/SKILL.md`. Each skill is a directory containing at minimum a `SKILL.md` with YAML frontmatter (`name`, `description`, and optional fields) followed by Markdown instructions.

When creating or editing a skill:
- Use `` !`command` `` syntax to inject live shell output into the skill content before Claude sees it
- Prefer `disable-model-invocation: true` for skills with side effects; omit it for skills Claude should auto-load
- Reference scripts or supporting files via `${CLAUDE_SKILL_DIR}`

Skills are hot-reloaded: changes to `.claude/skills/` take effect within the current session.

## Testing

- Primary regression entrypoint: `bun run .\test-watcher.ts risk`
- `test-watcher.ts` contains protocol, queueing, risk-confirmation, retry, risky-exec probe, and file-transfer whitelist / confirmation tests
- For watcher changes, prefer tests-first: add the smallest focused repro in `test-watcher.ts`, then patch production code, then rerun the targeted suite

## Watcher Contract

When modifying `wechat-skill-2`, treat the watcher behavior below as a contract, not a suggestion:

- **Path contract:** every inbound message must resolve to exactly one of `chat`, `executed`, or `risky`
- **Risk contract:** create/write/delete/install/script/config-change requests must be treated as `risky`, never direct `executed`
- **Confirmation contract:** while `pendingConfirmation` exists, affirmative replies such as `是` must resolve to confirm-execute, and negative replies such as `不` must resolve to cancel
- **State contract:** the original risky message must not clear `pendingConfirmation` while the system is waiting for confirmation
- **Reply contract:** one inbound message should produce one primary outcome; a confirmed risky execution must not fall through and generate an extra chat-style reply
- **Delete contract:** simple project-local file deletions may be handled by the watcher locally, but only for safe relative paths inside the project root
- **File transfer contract:** project-local whitelisted single-file transfers may be handled locally by the watcher; files over `10MB` require a second confirmation before sending
- **Media receive contract:** when a user sends an image/video/voice/file attachment, the watcher auto-downloads it via CDN (AES-128-ECB decrypt), saves to `.claude/wechat-media/`, and records the original filename; the reply must use the uniform format `收到《filename》，需要我帮忙吗？` without elaboration
- **Media reply contract:** attachment messages must produce a single standardized reply; do not speculate about file content, do not generate extra chat replies after the acknowledgment
- **Channel contract:** code must not depend on `cli-inbox.ts`, `inbox.jsonl`, or inbox import/export flows; inbound messages now arrive through MCP channel push
- **Cursor contract:** watcher progress is persisted in project-local `.claude/wechat-auto-cursor.txt`; do not switch it back to the plugin-global cursor
- **Start entry contract:** `wechat-skill-2` supports `/wechat-skill-2 --start` as a skill-entry control mode; this must route in `collect-wechat.ps1` before inbox import, stay exclusive with all other arguments, and only return success after the project watcher is observably running
- **Stop entry contract:** `wechat-skill-2` supports `/wechat-skill-2 --stop` as a skill-entry control mode; this must route in `collect-wechat.ps1` before inbox import and must stay exclusive with `--all` / `--limit`

## WeChat Skill GUI

The project includes a Web-based control center for visually managing the watcher.

**One-click launch (double-click `wechat-launcher.exe`):**
1. Starts the background watcher
2. Starts the built-in HTTP server (all features of `wechat-gui-server.ts` are inlined)
3. Automatically opens the browser at `http://localhost:3456`

**Dev mode launch:**
```powershell
bun run wechat-gui-server.ts
```

**Files:**
- `wechat-launcher.ts` — Monolithic launcher (watcher start + inline HTTP server + browser launch); compiles to standalone exe
- `wechat-launcher.exe` — Pre-compiled standalone executable (~117MB, no external Bun needed)
- `wechat-gui-server.ts` — Bun backend serving REST API on port 3456 (dev mode / fallback)
- `wechat-skill-gui.html` — Single-page frontend (dark/light theme)

**Features:**
- Watcher status indicator with PID display, start/stop/restart controls
- Session list sorted by last message time, click to switch
- WeChat-style message bubbles (incoming left, outgoing right)
- **Message sending** — Type text in the input box at the bottom, press Enter to send; file picker button for file transfer
- **File receiving** — Attachments (image/video/voice/file) are auto-downloaded via CDN + AES decrypt, displayed as clickable links with original filenames
- **User nicknames** — Click the avatar in the session list to set a display nickname (persisted in localStorage, does not affect backend user IDs)
- Anti-flicker polling — Compares data fingerprints before DOM rebuild; only re-renders on actual change
- Keyword search across chat history (modal)
- Pending risk-approval review panel
- Runtime statistics (replied / risky / dead-letter counts)
- Dark/light theme toggle (persisted)

**Compile launcher:**
```powershell
bun build wechat-launcher.ts --compile --outfile wechat-launcher.exe
```

## Security: WeChat skill chain (`wechat-skill-2`)

The WeChat integration spans multiple layers: `SKILL.md` → `collect-wechat.ps1` / `wechat-approve.ps1` → watcher scripts under `.claude/hooks/` → `cc-weixin` plugin (`v0.2.1`, installed from Skill Market; upstream repo: `qufei1993/cc-weixin`). It communicates with WeChat's iLink Bot API at `https://ilinkai.weixin.qq.com`.

Current watcher/runtime layout:

- Background auto-start: `start-wechat-auto.ps1` launches `start-wechat-auto-runner.ps1`, which owns the long-lived `wechat-auto-reply.ts` watcher
- Single-instance protection: the start/stop scripts coordinate via pid files / runner ownership to avoid killing unrelated `bun.exe` processes
- Message lifecycle: watcher tracks `classifying` / `classified` / `executing` / `replied` / `dead` in `.claude/wechat-auto-state.json`
- Poll cursor: watcher persists an independent project-local cursor in `.claude/wechat-auto-cursor.txt`
- Risk behavior: simple chat replies are sent directly; safe read/search/web tasks execute directly; create/write/delete/script/install/config-changing requests require confirmation
- Risk delete fallback: confirmed simple project-local file deletions can be executed locally by the watcher to avoid Claude tool sandbox limitations
- File transfer behavior: project-local whitelisted single files can be sent as attachments directly; oversized files require confirmation; current matching is exact relative-path matching, not fuzzy filename search
- Message ingress: `cc-weixin v0.2.1` uses `getUpdates` long polling and MCP `notifications/claude/channel`; messages arrive directly as `<channel source="weixin" ...>` in the chat context
- Compatibility bridge: `weixin-inbox.ps1` is now a compatibility stub for old references; it no longer imports or copies inbox content
- Start entry behavior: `collect-wechat.ps1` accepts `--start` as a control-mode argument, starts the project watcher via `start-wechat-auto.ps1`, and exits without running inbox import; default `/wechat-skill-2` is now status-only and does not implicitly start the watcher
- Stop entry behavior: `collect-wechat.ps1` accepts `--stop` as a control-mode argument, stops the project watcher via `stop-wechat-auto.ps1`, and exits without running inbox import

Key risks to be aware of when modifying or extending this skill:

- **Third-party plugin trust:** The `cc-weixin` plugin is installed via Skill Market, with its upstream source hosted on GitHub. It runs with full WeChat account access (read messages, send replies, download media). A compromised plugin update could hijack the connected account.
- **Privacy / data egress:** Imported WeChat messages become part of the Claude conversation context and are sent to Anthropic's API. All chat content — including media attachments — flows to external servers.
- **Auto-start:** A `SessionStart` hook (`start-wechat-auto.ps1`) launches the WeChat poll loop in the background every Claude Code session without confirmation.
- **Cursor ownership:** If code accidentally reuses the plugin-global cursor instead of `.claude/wechat-auto-cursor.txt`, the MCP server and the watcher may compete for updates and lose messages.
- **Plaintext persistence:** Watcher state, pending approvals, and logs are persisted locally in `.claude/`. Media downloads are saved to `.claude/wechat-media/` with original file extensions.
- **PowerShell ExecutionPolicy Bypass:** All PowerShell scripts in this chain run with `-ExecutionPolicy Bypass`. Standard for Claude Code scripts but removes a safety net.

Positive measures already in place: pairing-code access control, session-expiry handling, orphaned-process cleanup via parent-PID monitoring, single-instance protection, independent watcher cursor, risky-confirmation state protection, local risky-delete fallback, local whitelisted file-transfer handling with large-file confirmation, timeout retry handling, and consecutive-error backoff.
