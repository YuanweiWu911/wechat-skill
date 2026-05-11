# /wechat-skill --start Design

## Summary

Add an explicit `/wechat-skill --start` control mode so the skill can start the current project's background watcher on demand. The new mode is symmetric with the existing `--stop` entry:

- `--start` is an exclusive control argument
- it short-circuits the normal inbox import flow
- it reuses the existing watcher start chain
- it returns normalized, user-facing status text
- it only reports success when background execution is observably running

This is a new skill-entry capability, not a rewrite of the watcher startup internals.

## Goals

- Add `/wechat-skill --start` as an explicit way to start the current project's watcher
- Keep the skill entry behavior symmetric with `/wechat-skill --stop`
- Reuse `start-wechat-auto.ps1` instead of duplicating startup logic
- Make success depend on observable watcher state, not only script exit code
- Preserve the existing default `/wechat-skill` import behavior unchanged

## Non-Goals

- Do not make default `/wechat-skill` implicitly auto-start the watcher
- Do not redesign `start-wechat-auto.ps1` or `start-wechat-auto-runner.ps1`
- Do not change the existing `--stop` behavior
- Do not change `wechat-auto-reply.ts` watcher business logic

## Current State

`collect-wechat.ps1` currently supports:

- normal import mode via `weixin-inbox.ps1 copy/export`
- `--stop` exclusive mode via `stop-wechat-auto.ps1`

The watcher start chain already exists:

- `start-wechat-auto.ps1`
- `start-wechat-auto-runner.ps1`
- `wechat-auto-reply.ts`

However, there is currently no skill entry that explicitly starts the watcher. The watcher is normally started by the SessionStart hook, or manually by calling the start script.

## Design

### Entry Model

`collect-wechat.ps1` remains the single control and import entrypoint for `wechat-skill`.

It will support three mutually exclusive modes:

- default import mode
- `--stop` control mode
- `--start` control mode

When `--start` is present:

- it must short-circuit normal import
- it must not pass `--start` through to `weixin-inbox.ps1`
- it must invoke `start-wechat-auto.ps1`

### Argument Contract

`--start` is an exclusive control argument.

Allowed:

- `["--start"]`

Rejected:

- `["--start", "--all"]`
- `["--start", "--limit", "10"]`
- `["--start", "foo"]`
- any other argument list containing `--start` plus extra arguments

Error text is normalized to:

- `参数冲突：--start 必须单独使用。`

### Success Contract

`/wechat-skill --start` returns one of two normalized success messages:

- `已启动 watcher。`
- `watcher 已在运行。`

The implementation should distinguish these outcomes as follows:

- if the watcher is already observably running before the start attempt, return `watcher 已在运行。`
- otherwise invoke the start script, then verify the watcher becomes observably running
- if observable running state appears within the polling window, return `已启动 watcher。`

### Observable Running State

The skill-entry success condition is not just `start-wechat-auto.ps1` exiting with code `0`.

Observable running state is defined as at least one of:

- the current project's `.claude/wechat-auto.pid` exists and contains a valid process id for the project runner
- the current project's `start-wechat-auto-runner.ps1` process is present

The polling window should be short and bounded, only long enough to confirm startup.

### Failure Contract

Startup failure is reported when either of the following occurs:

1. `start-wechat-auto.ps1` exits non-zero
2. the start script exits successfully, but no observable running state appears within the polling window

Failure text should follow the same pattern as the existing stop wrapper:

- a short prefix indicating watcher start failure
- a concise output summary from the start script when available

### Data Flow

`--start` flow:

1. Parse arguments
2. Detect `--start`
3. Reject if any extra arguments are present
4. Check whether the current project watcher is already running
5. If already running, return `watcher 已在运行。`
6. Invoke `start-wechat-auto.ps1`
7. Poll for observable running state
8. Return `已启动 watcher。` on success, or fail with a normalized error

Default flow remains unchanged:

1. Parse arguments
2. No control mode matched
3. Run `weixin-inbox.ps1 copy`
4. Run `weixin-inbox.ps1 export`
5. Output sync summary

## Test Plan

Add focused regression coverage to `test-watcher.ts`:

1. `collect-wechat.ps1 --start starts watcher and normalizes success text`
2. `collect-wechat.ps1 --start reports watcher already running`
3. `collect-wechat.ps1 --start rejects mixed arguments`
4. `collect-wechat.ps1 --start fails when watcher is not observably running after start`

The tests should verify:

- `--start` does not fall through to import mode
- `--start` is exclusive
- success text is normalized
- a real runner process or pid file is observed before reporting startup success
- existing default import mode still remains intact

## Documentation Changes

Update:

- `.claude/skills/wechat-skill/SKILL.md`
- `CLAUDE.md`
- `CLAUDE_CN.md`

Required documentation updates:

- add `--start` to `argument-hint`
- document `/wechat-skill --start` in common usage
- add a `Start` entry contract alongside the existing `Stop` contract
- explain that `--start` only starts the watcher and exits
- explain that default `/wechat-skill` still does not implicitly start the watcher

## Implementation Scope

Files expected to change:

- `.claude/skills/wechat-skill/collect-wechat.ps1`
- `test-watcher.ts`
- `.claude/skills/wechat-skill/SKILL.md`
- `CLAUDE.md`
- `CLAUDE_CN.md`

Files explicitly out of scope unless debugging shows a hard blocker:

- `.claude/hooks/start-wechat-auto.ps1`
- `.claude/hooks/start-wechat-auto-runner.ps1`
- `.claude/hooks/wechat-auto-reply.ts`

## Risks

- `start-wechat-auto.ps1` may return success before the runner is observably present; this is why polling is part of the design
- Windows PowerShell encoding behavior may affect direct Chinese string literals; existing safe string construction patterns in `collect-wechat.ps1` should be reused
- Process detection must stay project-scoped so one project does not mistake another project's watcher as its own

## Acceptance Criteria

The feature is complete when all of the following are true:

- `/wechat-skill --start` starts the current project's watcher when it is not running
- `/wechat-skill --start` returns `watcher 已在运行。` when it is already running
- `/wechat-skill --start` fails on extra arguments
- the command only reports startup success after observable background state appears
- default `/wechat-skill` still behaves as import-only mode
- documentation and tests are updated to match the implementation
