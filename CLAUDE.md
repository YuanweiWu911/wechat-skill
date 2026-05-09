# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This is a personal sandbox for learning, practicing, and prototyping Claude Code custom skills. There is no application code, build system, or test suite.

## Skill development

Custom skills live under `.claude/skills/<skill-name>/SKILL.md`. Each skill is a directory containing at minimum a `SKILL.md` with YAML frontmatter (`name`, `description`, and optional fields) followed by Markdown instructions.

When creating or editing a skill:
- Use `` !`command` `` syntax to inject live shell output into the skill content before Claude sees it
- Prefer `disable-model-invocation: true` for skills with side effects; omit it for skills Claude should auto-load
- Reference scripts or supporting files via `${CLAUDE_SKILL_DIR}`

Skills are hot-reloaded: changes to `.claude/skills/` take effect within the current session.

## Security: WeChat skill chain (`wechat-skill-2`)

The WeChat integration spans multiple layers: SKILL.md → `collect-wechat.ps1` / `wechat-approve.ps1` → `weixin-inbox.ps1` → `cc-weixin` plugin (GitHub: `qufei1993/cc-weixin`, v0.2.0). It communicates with WeChat's iLink Bot API at `https://ilinkai.weixin.qq.com`.

Key risks to be aware of when modifying or extending this skill:

- **Third-party plugin trust:** The `cc-weixin` plugin is from an unaudited GitHub repo. It runs as `bun src/cli-inbox.ts` with full WeChat account access (read all messages, send replies, download media). A compromised plugin update could hijack the connected WeChat account.
- **Privacy / data egress:** Imported WeChat messages become part of the Claude conversation context and are sent to Anthropic's API. All chat content — including media attachments — flows to external servers.
- **Auto-start:** A `SessionStart` hook (`start-wechat-auto.ps1`) launches the WeChat poll loop in the background every Claude Code session without confirmation.
- **Clipboard exposure:** `cli-inbox.ts copy` pipes message content into the Windows clipboard via `spawnSync("clip", ...)`, making it readable by any running application.
- **Plaintext persistence:** Messages are stored unencrypted in `~/.claude/channels/weixin/inbox.jsonl`. Media downloads go to `%TMP%/weixin-media/`, a shared temp directory.
- **PowerShell ExecutionPolicy Bypass:** All PowerShell scripts in this chain run with `-ExecutionPolicy Bypass`. Standard for Claude Code scripts but removes a safety net.

Positive measures already in place: auth token stored with `chmod 600`, pairing-code access control, session-expiry handling, orphaned-process cleanup via parent-PID monitoring, and consecutive-error backoff.
