# CLAUDE.md

Chinese version: see `CLAUDE_CN.md`.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This is a personal sandbox for learning, practicing, and prototyping Claude Code custom skills. The main active project is `wechat-skill-2`, which includes a Bun-based watcher, PowerShell launch scripts, and watcher-focused regression tests in `test-watcher.ts`.

## Skill development

Custom skills live under `.claude/skills/<skill-name>/SKILL.md`. Each skill is a directory containing at minimum a `SKILL.md` with YAML frontmatter (`name`, `description`, and optional fields) followed by Markdown instructions.

When creating or editing a skill:
- Use `` !`command` `` syntax to inject live shell output into the skill content before Claude sees it
- Prefer `disable-model-invocation: true` for skills with side effects; omit it for skills Claude should auto-load
- Reference scripts or supporting files via `${CLAUDE_SKILL_DIR}`

Skills are hot-reloaded: changes to `.claude/skills/` take effect within the current session.

## Testing

- Primary regression entrypoint: `bun run .\test-watcher.ts risk`
- `test-watcher.ts` contains protocol, queueing, risk-confirmation, retry, and risky-exec probe tests
- For watcher changes, prefer tests-first: add the smallest focused repro in `test-watcher.ts`, then patch production code, then rerun the targeted suite

## Watcher Contract

When modifying `wechat-skill-2`, treat the watcher behavior below as a contract, not a suggestion:

- **Path contract:** every inbound message must resolve to exactly one of `chat`, `executed`, or `risky`
- **Risk contract:** create/write/delete/install/script/config-change requests must be treated as `risky`, never direct `executed`
- **Confirmation contract:** while `pendingConfirmation` exists, affirmative replies such as `是` must resolve to confirm-execute, and negative replies such as `不` must resolve to cancel
- **State contract:** the original risky message must not clear `pendingConfirmation` while the system is waiting for confirmation
- **Reply contract:** one inbound message should produce one primary outcome; a confirmed risky execution must not fall through and generate an extra chat-style reply
- **Delete contract:** simple project-local file deletions may be handled by the watcher locally, but only for safe relative paths inside the project root
- **Ack contract:** watcher code must not rely on in-process writes to `~/.claude/channels/weixin/inbox-state.json`; unread acknowledgements should go through `weixin-inbox.ps1 ack`

## Security: WeChat skill chain (`wechat-skill-2`)

The WeChat integration spans multiple layers: SKILL.md → `collect-wechat.ps1` / `wechat-approve.ps1` → `weixin-inbox.ps1` → `cc-weixin` plugin (GitHub: `qufei1993/cc-weixin`, v0.2.0). It communicates with WeChat's iLink Bot API at `https://ilinkai.weixin.qq.com`.

Current watcher/runtime layout:

- Background auto-start: `start-wechat-auto.ps1` launches `start-wechat-auto-runner.ps1`, which owns the long-lived `wechat-auto-reply.ts` watcher
- Single-instance protection: the start/stop scripts coordinate via pid files / runner ownership to avoid killing unrelated `bun.exe` processes
- Message lifecycle: watcher tracks `classifying` / `classified` / `executing` / `replied` / `dead` in `.claude/wechat-auto-state.json`
- Risk behavior: simple chat replies are sent directly; safe read/search/web tasks execute directly; create/write/delete/script/install/config-changing requests require confirmation
- Risk delete fallback: confirmed simple project-local file deletions can be executed locally by the watcher to avoid Claude tool sandbox limitations

Key risks to be aware of when modifying or extending this skill:

- **Third-party plugin trust:** The `cc-weixin` plugin is from an unaudited GitHub repo. It runs as `bun src/cli-inbox.ts` with full WeChat account access (read all messages, send replies, download media). A compromised plugin update could hijack the connected WeChat account.
- **Privacy / data egress:** Imported WeChat messages become part of the Claude conversation context and are sent to Anthropic's API. All chat content — including media attachments — flows to external servers.
- **Auto-start:** A `SessionStart` hook (`start-wechat-auto.ps1`) launches the WeChat poll loop in the background every Claude Code session without confirmation.
- **Sandbox asymmetry:** The watcher process can read inbox data directly, but some writes under `~/.claude/channels/weixin/` may be blocked in-process by Trae sandboxing. Read acknowledgements should therefore go through `weixin-inbox.ps1 ack` rather than direct `markInboxRead()` writes.
- **Clipboard exposure:** `cli-inbox.ts copy` pipes message content into the Windows clipboard via `spawnSync("clip", ...)`, making it readable by any running application.
- **Plaintext persistence:** Messages are stored unencrypted in `~/.claude/channels/weixin/inbox.jsonl`. Media downloads go to `%TMP%/weixin-media/`, a shared temp directory.
- **PowerShell ExecutionPolicy Bypass:** All PowerShell scripts in this chain run with `-ExecutionPolicy Bypass`. Standard for Claude Code scripts but removes a safety net.

Positive measures already in place: auth token stored with `chmod 600`, pairing-code access control, session-expiry handling, orphaned-process cleanup via parent-PID monitoring, single-instance protection, duplicate-inbox de-duping, risky-confirmation state protection, local risky-delete fallback, and consecutive-error backoff.
