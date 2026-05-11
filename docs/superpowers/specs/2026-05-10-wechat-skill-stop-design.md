# `/wechat-skill --stop` Design

## Goal

Add a `--stop` control mode to `wechat-skill` so the user can terminate the background watcher directly from the skill entrypoint.

The feature must:

- stop the currently running watcher for this project
- return a clear status message that distinguishes "stopped" from "already not running"
- short-circuit the normal inbox sync flow
- reject mixed usage with sync arguments such as `--all` and `--limit`
- reuse the existing watcher stop implementation instead of duplicating process-kill logic

## Existing Context

Current behavior is split across these files:

- `.claude/skills/wechat-skill/SKILL.md`: user-facing skill contract and argument hint
- `.claude/skills/wechat-skill/collect-wechat.ps1`: current skill entry script that forwards arguments to `weixin-inbox.ps1 copy/export`
- `.claude/hooks/stop-wechat-auto.ps1`: current project-scoped stop implementation for runner/watcher processes
- `.claude/hooks/start-wechat-auto.ps1` and `.claude/hooks/start-wechat-auto-runner.ps1`: current auto-start and runner ownership chain

The stop capability already exists at the hook layer. The missing piece is a skill-level control branch that exposes it as `/wechat-skill --stop`.

## Chosen Approach

Implement `--stop` inside `collect-wechat.ps1` as an exclusive control-mode branch.

Why this approach:

- keeps one stable user entrypoint for `wechat-skill`
- reuses the existing and tested `stop-wechat-auto.ps1` implementation
- minimizes surface area compared with introducing a second stop wrapper script
- makes parameter validation straightforward
- keeps the stop decision at the skill boundary, instead of leaking a control flag into the inbox sync chain

## Rejected Alternatives

### Alternative A: Add a separate stop wrapper script

This would keep `collect-wechat.ps1` narrower, but adds another user-facing moving part and more documentation/maintenance overhead for a small feature.

### Alternative B: Pass `--stop` through to the inbox pipeline

This is semantically wrong because `weixin-inbox.ps1` handles inbox copy/export, not watcher lifecycle control. It would create unnecessary coupling and ambiguous behavior.

## Architecture

`wechat-skill` keeps a single top-level entrypoint in `SKILL.md`, still calling `collect-wechat.ps1`.

`collect-wechat.ps1` gains a lightweight argument router:

- if `--stop` is present, enter stop mode
- otherwise, keep the existing sync mode behavior

In stop mode:

1. validate that `--stop` is not mixed with `--all` or `--limit`
2. invoke `.claude/hooks/stop-wechat-auto.ps1`
3. normalize the user-facing output
4. exit immediately without calling `weixin-inbox.ps1 copy/export`

In sync mode:

1. preserve the current flow unchanged
2. continue calling `weixin-inbox.ps1 copy`
3. continue calling `weixin-inbox.ps1 export`

The underlying stop script remains the single source of truth for pid-file cleanup and project-scoped process termination.

## Parameter Contract

`--stop` is an exclusive control argument.

Rules:

- `/wechat-skill --stop` is valid
- `/wechat-skill --stop --all` is invalid
- `/wechat-skill --stop --limit 10` is invalid
- `/wechat-skill --stop --all --limit 10` is invalid
- repeated `--stop` flags should still resolve to stop mode, but do not need special meaning beyond that

If mixed arguments are detected, the script should fail fast with a non-zero exit code and a clear conflict message.

## User-Facing Output

Successful stop mode should normalize output into one of these messages:

- `已停止 watcher。`
- `watcher 未运行，无需停止。`

The skill should not expose raw internal implementation details unless stop execution fails.

On failure, the entry script should return a concise readable error message that includes a short summary of the underlying script output for debugging.

## Data Flow

### Stop mode

1. parse remaining arguments
2. detect `--stop`
3. validate argument exclusivity
4. call `stop-wechat-auto.ps1`
5. map underlying result into normalized status text
6. exit

### Sync mode

1. parse remaining arguments
2. confirm `--stop` is absent
3. call `weixin-inbox.ps1 copy`
4. call `weixin-inbox.ps1 export`
5. print existing sync report

## Error Handling

Three error categories are in scope:

### 1. Parameter conflict

If `--stop` is combined with sync arguments, fail with a clear message such as:

`参数冲突：--stop 不能与 --all 或 --limit 同时使用。`

This should use a non-zero exit code.

### 2. Stop execution failure

If `stop-wechat-auto.ps1` throws or exits non-zero, `collect-wechat.ps1` should surface a concise wrapper error and include a short output excerpt for diagnosis.

### 3. Successful no-op stop

If no watcher is running, this is still success, but must be reported distinctly as:

`watcher 未运行，无需停止。`

## Testing Strategy

Use tests-first, with the smallest focused additions that protect the new branch.

High-value tests:

1. `collect-wechat.ps1 --stop` stops a running watcher and returns the normalized success message
2. `collect-wechat.ps1 --stop` when the watcher is not running returns the normalized "already stopped" message
3. `collect-wechat.ps1 --stop --limit 10` fails with the expected parameter conflict

The existing stop coverage in `test-watcher.ts` already proves the underlying stop script behavior. These new tests should verify the new skill-entry routing and output normalization layer.

## Documentation Changes

### `.claude/skills/wechat-skill/SKILL.md`

Update:

- `argument-hint` to include `--stop`
- common usage examples to include `/wechat-skill --stop`
- the execution instructions to explain that `--stop` is a control mode that stops and exits
- the behavior contract to state that `--stop` must not be forwarded into the inbox sync chain

### `CLAUDE.md`

Update repository guidance to record:

- `wechat-skill` has a stop control entrypoint
- `--stop` is exclusive with sync arguments
- the skill entry layer is responsible for routing stop mode before inbox import

## Out of Scope

- changing how SessionStart auto-start works
- changing the low-level stop script ownership rules
- adding a restart command
- changing watcher runtime behavior after stop beyond what `stop-wechat-auto.ps1` already does

## Implementation Notes

The implementation should remain narrow:

- add argument parsing/validation to `collect-wechat.ps1`
- reuse existing stop script output where possible, but normalize final user-visible text
- avoid modifying watcher runtime code unless tests show a real gap

## Success Criteria

The feature is done when:

- `/wechat-skill --stop` cleanly stops this project's watcher
- `/wechat-skill --stop` reports a distinct "already not running" result when appropriate
- mixed stop/sync arguments fail clearly
- normal sync usage remains unchanged
- tests cover the new skill-entry branch
- `SKILL.md` and `CLAUDE.md` document the new contract
