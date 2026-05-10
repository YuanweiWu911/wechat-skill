# WeChat Skill 2 Stop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/wechat-skill-2 --stop` so the skill can stop the background watcher, return normalized status text, reject mixed sync arguments, and leave normal sync behavior unchanged.

**Architecture:** Keep `wechat-skill-2` as a single entrypoint. Add a small argument router in `collect-wechat.ps1` that detects `--stop`, validates exclusivity with `--all` and `--limit`, then delegates to the existing `stop-wechat-auto.ps1` script and normalizes its output. Verify the new branch with focused `test-watcher.ts` coverage, then update the user-facing skill contract and repository guidance.

**Tech Stack:** PowerShell, Bun/TypeScript test harness, Markdown docs

---

## File Structure

### Files to Modify

- `.claude/skills/wechat-skill-2/collect-wechat.ps1`
  - Add stop-mode argument parsing, parameter conflict validation, stop-script invocation, and normalized stop output.
- `test-watcher.ts`
  - Add focused tests for the new skill-entry `--stop` branch without changing existing watcher runtime tests.
- `.claude/skills/wechat-skill-2/SKILL.md`
  - Document the new `--stop` argument, exclusive behavior, and common usage.
- `CLAUDE.md`
  - Record the new stop-entry contract and parameter exclusivity rule for future repository work.

### Files to Read While Implementing

- `.claude/hooks/stop-wechat-auto.ps1`
  - Existing project-scoped watcher stop implementation that should remain the single source of truth.
- `docs/superpowers/specs/2026-05-10-wechat-skill-2-stop-design.md`
  - Approved design spec; implementation should stay inside its scope.

### Files Explicitly Out of Scope

- `.claude/hooks/wechat-auto-reply.ts`
- `.claude/hooks/start-wechat-auto.ps1`
- `.claude/hooks/start-wechat-auto-runner.ps1`

Do not change watcher runtime/startup behavior unless a failing test proves the new skill-entry branch cannot be implemented without it.

### Task 1: Add Failing Stop-Mode Tests

**Files:**
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\test-watcher.ts`
- Read: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\skills\wechat-skill-2\collect-wechat.ps1`
- Read: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\hooks\stop-wechat-auto.ps1`

- [ ] **Step 1: Add a helper that runs `collect-wechat.ps1` directly**

Insert a focused helper near the existing `runCommand()` helpers so the new tests do not duplicate the PowerShell invocation each time:

```ts
function runCollectWechat(args: string[]): CommandResult {
  return runCommand(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(skillDir, "collect-wechat.ps1"), ...args],
    { timeout: 30000 },
  );
}
```

- [ ] **Step 2: Add a failing test for `--stop` when the watcher is running**

In the existing watcher-test section near the current stop-script coverage, add a new case that starts the watcher, waits for the pid file, then calls `collect-wechat.ps1 --stop` and asserts normalized output:

```ts
const startForCollectStop = runCommand(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", startScript],
  { timeout: 30000 },
);
const collectStopReady = waitUntil(15000, () => {
  const pid = readRegisteredRunnerPid(pidPath);
  return pid !== null && processExists(pid);
});
const collectStopPid = readRegisteredRunnerPid(pidPath);
const collectStop = runCollectWechat(["--stop"]);
const collectStopPidRemoved = waitUntil(5000, () => !existsSync(pidPath));
const collectStopRunnerStopped =
  collectStopPid === null ? false : waitUntil(8000, () => !processExists(collectStopPid));
push(
  results,
  "collect-wechat.ps1 --stop stops watcher and normalizes success text",
  startForCollectStop.status === 0 &&
    collectStopReady &&
    collectStop.status === 0 &&
    collectStop.stdout.includes("已停止 watcher。") &&
    collectStopPidRemoved &&
    collectStopRunnerStopped
    ? "PASS"
    : "FAIL",
  `start=${startForCollectStop.status} ready=${collectStopReady} stop=${collectStop.status} pid=${collectStopPid ?? "null"} pidRemoved=${collectStopPidRemoved} runnerStopped=${collectStopRunnerStopped} stdout=${collectStop.stdout || "无输出"} stderr=${collectStop.stderr || "无输出"} error=${collectStop.error || "无"}`,
);
```

- [ ] **Step 3: Add a failing test for `--stop` when the watcher is not running**

Stop any existing watcher first, then call the new skill-entry branch and assert the no-op normalized success text:

```ts
runCommand(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", stopScript],
  { timeout: 30000 },
);
const collectStopNoop = runCollectWechat(["--stop"]);
push(
  results,
  "collect-wechat.ps1 --stop reports watcher not running",
  collectStopNoop.status === 0 &&
    collectStopNoop.stdout.includes("watcher 未运行，无需停止。")
    ? "PASS"
    : "FAIL",
  `status=${collectStopNoop.status} stdout=${collectStopNoop.stdout || "无输出"} stderr=${collectStopNoop.stderr || "无输出"} error=${collectStopNoop.error || "无"}`,
);
```

- [ ] **Step 4: Run the watcher test suite and confirm the new tests fail**

Run:

```bash
bun run .\test-watcher.ts watcher
```

Expected:

```text
FAIL collect-wechat.ps1 --stop stops watcher and normalizes success text
FAIL collect-wechat.ps1 --stop reports watcher not running
```

The failures should show that `collect-wechat.ps1` still forwards `--stop` into the inbox sync path instead of stopping the watcher.

- [ ] **Step 5: Commit the failing-test checkpoint**

Run:

```bash
git add test-watcher.ts
git commit -m "test: add failing wechat stop entry coverage"
```

### Task 2: Add Failing Parameter-Conflict Coverage

**Files:**
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\test-watcher.ts`
- Read: `c:\Users\len\ywwu_workspace\claude_skill_learn\docs\superpowers\specs\2026-05-10-wechat-skill-2-stop-design.md`

- [ ] **Step 1: Add a failing mixed-argument test**

Append a third test near the other new stop-entry assertions:

```ts
const collectStopConflict = runCollectWechat(["--stop", "--limit", "10"]);
push(
  results,
  "collect-wechat.ps1 --stop rejects mixed sync arguments",
  collectStopConflict.status !== 0 &&
    /参数冲突：--stop 不能与 --all 或 --limit 同时使用。/.test(
      [collectStopConflict.stdout, collectStopConflict.stderr, collectStopConflict.error].join("\n"),
    )
    ? "PASS"
    : "FAIL",
  `status=${collectStopConflict.status} stdout=${collectStopConflict.stdout || "无输出"} stderr=${collectStopConflict.stderr || "无输出"} error=${collectStopConflict.error || "无"}`,
);
```

- [ ] **Step 2: Run the targeted watcher suite and confirm the new conflict test fails**

Run:

```bash
bun run .\test-watcher.ts watcher
```

Expected:

```text
FAIL collect-wechat.ps1 --stop rejects mixed sync arguments
```

The failure should show that no exclusivity validation exists yet.

- [ ] **Step 3: Commit the expanded failing-test checkpoint**

Run:

```bash
git add test-watcher.ts
git commit -m "test: cover wechat stop argument conflicts"
```

### Task 3: Implement the `collect-wechat.ps1` Stop Router

**Files:**
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\skills\wechat-skill-2\collect-wechat.ps1`
- Test: `c:\Users\len\ywwu_workspace\claude_skill_learn\test-watcher.ts`

- [ ] **Step 1: Add stop-path constants and argument inspection**

Near the top of `collect-wechat.ps1`, add the stop script path and detect the new mode:

```powershell
$stopWatcherScript = Join-Path $PSScriptRoot "..\..\hooks\stop-wechat-auto.ps1"

if (-not (Test-Path $stopWatcherScript)) {
  throw "Missing stop-wechat-auto.ps1 at $stopWatcherScript"
}

$normalizedArgs = @()
if ($InboxArgs) {
  $normalizedArgs = $InboxArgs
}

$stopRequested = $normalizedArgs -contains "--stop"
$usesAll = $normalizedArgs -contains "--all"
$limitIndex = [Array]::IndexOf($normalizedArgs, "--limit")
$usesLimit = $limitIndex -ge 0
```

- [ ] **Step 2: Add conflict validation and the stop-mode branch before inbox sync**

Insert the new control branch before any `weixin-inbox.ps1 copy/export` calls:

```powershell
if ($stopRequested) {
  if ($usesAll -or $usesLimit) {
    throw "参数冲突：--stop 不能与 --all 或 --limit 同时使用。"
  }

  $stopOutput = & $stopWatcherScript 2>&1
  $stopExit = $LASTEXITCODE
  $stopText = ($stopOutput | Out-String).Trim()

  if ($stopExit -ne 0) {
    $summary = if ($stopText) { $stopText } else { "无输出" }
    throw "停止 watcher 失败。`n$summary"
  }

  if ($stopText -match "not running") {
    Write-Output "watcher 未运行，无需停止。"
    exit 0
  }

  Write-Output "已停止 watcher。"
  exit 0
}
```

- [ ] **Step 3: Preserve the existing sync path exactly after the new branch**

After the new stop block, keep the existing sync behavior intact:

```powershell
$copyOutput = & $weixinInboxScript copy @normalizedArgs 2>&1
$copyExit = $LASTEXITCODE

$exportOutput = & $weixinInboxScript export @normalizedArgs 2>&1
$exportExit = $LASTEXITCODE

if ($copyExit -ne 0 -and $exportExit -ne 0) {
  throw "Both clipboard copy and export failed.`nCopy output:`n$copyOutput`n`nExport output:`n$exportOutput"
}
```

Do not refactor the sync output block in this task.

- [ ] **Step 4: Run the watcher suite and verify the three new tests pass**

Run:

```bash
bun run .\test-watcher.ts watcher
```

Expected:

```text
PASS collect-wechat.ps1 --stop stops watcher and normalizes success text
PASS collect-wechat.ps1 --stop reports watcher not running
PASS collect-wechat.ps1 --stop rejects mixed sync arguments
```

- [ ] **Step 5: Run diagnostics on edited files**

Use diagnostics on:

- `file:///c:/Users/len/ywwu_workspace/claude_skill_learn/.claude/skills/wechat-skill-2/collect-wechat.ps1`
- `file:///c:/Users/len/ywwu_workspace/claude_skill_learn/test-watcher.ts`

Expected: no new diagnostics introduced by the stop-entry change.

- [ ] **Step 6: Commit the implementation**

Run:

```bash
git add .claude/skills/wechat-skill-2/collect-wechat.ps1 test-watcher.ts
git commit -m "feat: add wechat skill stop entry"
```

### Task 4: Update the Skill Contract and Repository Guidance

**Files:**
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\skills\wechat-skill-2\SKILL.md`
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\CLAUDE.md`
- Test: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\skills\wechat-skill-2\collect-wechat.ps1`

- [ ] **Step 1: Update `SKILL.md` argument hint and usage examples**

Apply these exact changes:

```md
argument-hint: "[--stop] [--all] [--limit N]"
```

Add a stop-mode usage example under common usage:

```md
- `/wechat-skill-2 --stop` — 停止后台 watcher 并立即退出
```

- [ ] **Step 2: Update the execution instructions and behavior contract in `SKILL.md`**

Add the stop-mode rule in the execution section:

```md
- `--stop`：停止当前项目的后台 watcher，并直接退出，不导入微信消息
```

Add one contract bullet in the behavior-contract area:

```md
- `--stop` 是 skill 入口层控制命令，命中后必须短路正常导入流程，不得透传给 `weixin-inbox.ps1 copy/export`。
```

- [ ] **Step 3: Update `CLAUDE.md` repository guidance**

Add a repository-level reminder in the watcher contract or security/runtime section:

```md
- **Stop entry contract:** `wechat-skill-2` supports `/wechat-skill-2 --stop` as a skill-entry control mode; this must route in `collect-wechat.ps1` before inbox import and must stay exclusive with `--all` / `--limit`
```

- [ ] **Step 4: Sanity-check the user-facing stop path manually**

Run:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\skills\wechat-skill-2\collect-wechat.ps1 --stop
```

Expected one of:

```text
已停止 watcher。
```

or

```text
watcher 未运行，无需停止。
```

- [ ] **Step 5: Run the watcher suite one final time**

Run:

```bash
bun run .\test-watcher.ts watcher
```

Expected: the watcher suite still passes with the new stop-entry coverage included.

- [ ] **Step 6: Run diagnostics and commit docs**

Run diagnostics on:

- `file:///c:/Users/len/ywwu_workspace/claude_skill_learn/.claude/skills/wechat-skill-2/SKILL.md`
- `file:///c:/Users/len/ywwu_workspace/claude_skill_learn/CLAUDE.md`

Then commit:

```bash
git add .claude/skills/wechat-skill-2/SKILL.md CLAUDE.md
git commit -m "docs: document wechat skill stop mode"
```

## Self-Review

### Spec Coverage

- Stop this project's watcher: covered by Task 1 and Task 3.
- Distinct success text for stopped vs already-not-running: covered by Task 1, Task 3, and Task 4.
- Short-circuit the normal sync flow: covered by Task 3 and documented in Task 4.
- Reject mixed `--stop`/sync arguments: covered by Task 2 and Task 3.
- Reuse existing stop implementation: covered by Task 3 architecture constraints.
- Keep normal sync usage unchanged: covered by Task 3, with explicit instruction not to refactor the sync path.
- Update `SKILL.md` and `CLAUDE.md`: covered by Task 4.

### Placeholder Scan

The plan includes exact file paths, concrete test code, concrete PowerShell code, exact commands, and expected outputs. No `TODO`/`TBD` placeholders remain.

### Type Consistency

- Test helper name: `runCollectWechat()`
- PowerShell mode variable: `$stopRequested`
- Conflict error text: `参数冲突：--stop 不能与 --all 或 --limit 同时使用。`
- Success texts: `已停止 watcher。` and `watcher 未运行，无需停止。`

These names and strings are used consistently across tests, implementation, and docs.
