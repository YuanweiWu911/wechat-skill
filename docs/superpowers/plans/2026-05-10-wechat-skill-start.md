# WeChat Skill --start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/wechat-skill --start` so the skill can explicitly start the current project's background watcher and return normalized status text only after startup is observably running.

**Architecture:** Extend `collect-wechat.ps1` with a new exclusive `--start` control branch that reuses `start-wechat-auto.ps1`, validates arguments, checks project-scoped running state, polls for observable startup success, and keeps default inbox import unchanged. Drive the change with focused watcher-script regression tests in `test-watcher.ts`, then sync the skill and repo docs.

**Tech Stack:** PowerShell, Bun, TypeScript test harness, git

---

## File Structure

- Modify: `.claude/skills/wechat-skill/collect-wechat.ps1`
  - Add `--start` argument handling, project-scoped watcher running detection, startup polling, normalized success and failure text.
- Modify: `test-watcher.ts`
  - Add failing and passing regression coverage for `--start` startup, already-running detection, exclusive-argument rejection, and default import safety.
- Modify: `.claude/skills/wechat-skill/SKILL.md`
  - Document the new `--start` argument, common usage, and the start entry contract.
- Modify: `CLAUDE.md`
  - Add repo-level contract for the explicit start control entry.
- Modify: `CLAUDE_CN.md`
  - Keep the Chinese repo doc in sync with the English repo contract.

### Task 1: Add Failing `--start` Script Tests

**Files:**
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\test-watcher.ts`
- Test: `c:\Users\len\ywwu_workspace\claude_skill_learn\test-watcher.ts`

- [ ] **Step 1: Write the failing `--start` test cases**

Insert new assertions near the existing `collect-wechat.ps1 --stop` tests inside `runScriptTests()`:

```ts
  runCommand(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", stopScript],
    { timeout: 30000 },
  );
  const collectStart = runCollectWechat(["--start"]);
  const collectStartReady = waitUntil(15000, () => {
    const pid = readRegisteredRunnerPid(pidPath);
    return pid !== null && processExists(pid);
  });
  const collectStartPid = readRegisteredRunnerPid(pidPath);
  push(
    results,
    "collect-wechat.ps1 --start starts watcher and normalizes success text",
    collectStart.status === 0 &&
      collectStart.stdout.includes("已启动 watcher。") &&
      collectStartReady &&
      collectStartPid !== null
      ? "PASS"
      : "FAIL",
    `status=${collectStart.status} ready=${collectStartReady} pid=${collectStartPid ?? "null"} stdout=${collectStart.stdout || "无输出"} stderr=${collectStart.stderr || "无输出"} error=${collectStart.error || "无"}`,
  );

  const collectStartAgain = runCollectWechat(["--start"]);
  push(
    results,
    "collect-wechat.ps1 --start reports watcher already running",
    collectStartAgain.status === 0 && collectStartAgain.stdout.includes("watcher 已在运行。")
      ? "PASS"
      : "FAIL",
    `status=${collectStartAgain.status} stdout=${collectStartAgain.stdout || "无输出"} stderr=${collectStartAgain.stderr || "无输出"} error=${collectStartAgain.error || "无"}`,
  );

  const collectStartConflict = runCollectWechat(["--start", "--limit", "10"]);
  push(
    results,
    "collect-wechat.ps1 --start rejects mixed arguments",
    collectStartConflict.status !== 0 &&
      /参数冲突：--start 必须单独使用。/.test(
        [collectStartConflict.stdout, collectStartConflict.stderr, collectStartConflict.error].join("\n"),
      )
      ? "PASS"
      : "FAIL",
    `status=${collectStartConflict.status} stdout=${collectStartConflict.stdout || "无输出"} stderr=${collectStartConflict.stderr || "无输出"} error=${collectStartConflict.error || "无"}`,
  );
```

- [ ] **Step 2: Add a failing startup-observation regression**

Add a lightweight helper and a failure-mode test that can temporarily force the observable-start check to fail without redesigning the start scripts:

```ts
function withEnvVars(extraEnv: NodeJS.ProcessEnv, fn: () => CommandResult): CommandResult {
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(extraEnv)) {
    previousValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of previousValues.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
```

Then add:

```ts
  runCommand(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", stopScript],
    { timeout: 30000 },
  );
  const collectStartNoObserve = withEnvVars(
    { WECHAT_START_OBSERVE_TIMEOUT_MS: "0" },
    () => runCollectWechat(["--start"]),
  );
  push(
    results,
    "collect-wechat.ps1 --start fails when watcher is not observably running after start",
    collectStartNoObserve.status !== 0 &&
      /启动 watcher 失败。/.test(
        [collectStartNoObserve.stdout, collectStartNoObserve.stderr, collectStartNoObserve.error].join("\n"),
      )
      ? "PASS"
      : "FAIL",
    `status=${collectStartNoObserve.status} stdout=${collectStartNoObserve.stdout || "无输出"} stderr=${collectStartNoObserve.stderr || "无输出"} error=${collectStartNoObserve.error || "无"}`,
  );
```

- [ ] **Step 3: Run the watcher script tests and confirm the new `--start` cases fail**

Run:

```powershell
bun run .\test-watcher.ts watcher
```

Expected before implementation:

- `collect-wechat.ps1 --start starts watcher and normalizes success text` is `FAIL`
- `collect-wechat.ps1 --start reports watcher already running` is `FAIL`
- `collect-wechat.ps1 --start rejects mixed arguments` is `FAIL`
- `collect-wechat.ps1 --start fails when watcher is not observably running after start` is `FAIL`
- existing `--stop` tests remain unchanged

- [ ] **Step 4: Commit the failing test scaffold**

```powershell
git add test-watcher.ts
git commit -m "test: add failing wechat start coverage"
```

### Task 2: Implement Minimal `--start` Support

**Files:**
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\skills\wechat-skill\collect-wechat.ps1`
- Test: `c:\Users\len\ywwu_workspace\claude_skill_learn\test-watcher.ts`

- [ ] **Step 1: Add project-scoped running detection helpers to `collect-wechat.ps1`**

Insert these helpers before the `--stop` branch so `--start` can check observable state using the same project-scoped rules as the start/stop scripts:

```powershell
$startWatcherScript = Join-Path $PSScriptRoot "..\..\hooks\start-wechat-auto.ps1"
$pidPath = Join-Path $PSScriptRoot "..\..\wechat-auto.pid"
$runnerLauncherPath = Join-Path $PSScriptRoot "..\..\hooks\start-wechat-auto-runner.ps1"

if (-not (Test-Path $startWatcherScript)) {
  throw "Missing start-wechat-auto.ps1 at $startWatcherScript"
}

function Get-RunnerProcess([int]$ProcessId) {
  try {
    return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
  } catch {
    return $null
  }
}

function Test-RunnerMatchesProject($ProcessInfo) {
  if (-not $ProcessInfo) {
    return $false
  }

  $commandLine = $ProcessInfo.CommandLine
  if (-not $commandLine) {
    return $false
  }

  return $commandLine -match [regex]::Escape($runnerLauncherPath) -and $commandLine -match [regex]::Escape((Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path)
}

function Test-WatcherRunning {
  if (-not (Test-Path $pidPath)) {
    return $false
  }

  $runnerPidRaw = (Get-Content $pidPath -Raw -ErrorAction SilentlyContinue).Trim()
  $runnerPid = 0
  if (-not [int]::TryParse($runnerPidRaw, [ref]$runnerPid)) {
    return $false
  }

  return Test-RunnerMatchesProject (Get-RunnerProcess $runnerPid)
}
```

- [ ] **Step 2: Add normalized `--start` strings and bounded polling**

Add safe string construction and a polling helper alongside the existing `--stop` messages:

```powershell
$startExclusiveMessage = ConvertFrom-CodePoints @(0x53C2, 0x6570, 0x51B2, 0x7A81, 0xFF1A)
$startExclusiveMessage += "--start "
$startExclusiveMessage += ConvertFrom-CodePoints @(0x5FC5, 0x987B, 0x5355, 0x72EC, 0x4F7F, 0x7528, 0x3002)
$startFailurePrefix = ConvertFrom-CodePoints @(0x542F, 0x52A8)
$startFailurePrefix += " watcher "
$startFailurePrefix += ConvertFrom-CodePoints @(0x5931, 0x8D25, 0x3002)
$watcherAlreadyRunningMessage = "watcher " + (ConvertFrom-CodePoints @(0x5DF2, 0x5728, 0x8FD0, 0x884C, 0x3002))
$watcherStartedMessage = (ConvertFrom-CodePoints @(0x5DF2, 0x542F, 0x52A8)) + " watcher" + (ConvertFrom-CodePoints @(0x3002))

function Wait-ForWatcherRunning([int]$TimeoutMs) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-WatcherRunning) {
      return $true
    }
    Start-Sleep -Milliseconds 250
  }
  return Test-WatcherRunning
}
```

- [ ] **Step 3: Add the minimal `--start` branch**

Insert the branch before the existing `--stop` handling:

```powershell
$startRequested = $normalizedArgs -contains "--start"
$startObserveTimeoutMs = 8000
if ($env:WECHAT_START_OBSERVE_TIMEOUT_MS) {
  $parsedObserveTimeout = 0
  if ([int]::TryParse($env:WECHAT_START_OBSERVE_TIMEOUT_MS, [ref]$parsedObserveTimeout)) {
    $startObserveTimeoutMs = [Math]::Max(0, $parsedObserveTimeout)
  }
}

if ($startRequested) {
  if ($normalizedArgs.Length -ne 1) {
    throw $startExclusiveMessage
  }

  if (Test-WatcherRunning) {
    Write-Output $watcherAlreadyRunningMessage
    exit 0
  }

  $startOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $startWatcherScript 2>&1
  $startExit = $LASTEXITCODE
  $startText = ($startOutput | Out-String).Trim()

  if ($startExit -ne 0) {
    $summary = $noOutputMessage
    if ($startText) {
      $summary = $startText
    }
    throw "$startFailurePrefix`n$summary"
  }

  if (-not (Wait-ForWatcherRunning $startObserveTimeoutMs)) {
    $summary = $noOutputMessage
    if ($startText) {
      $summary = $startText
    }
    throw "$startFailurePrefix`n未观察到后台 watcher 运行状态。`n$summary"
  }

  Write-Output $watcherStartedMessage
  exit 0
}
```

- [ ] **Step 4: Run the watcher script tests and verify the new `--start` cases pass**

Run:

```powershell
bun run .\test-watcher.ts watcher
```

Expected after implementation:

- all 4 new `--start` tests are `PASS`
- existing `--stop` tests remain `PASS`
- `collect-wechat.ps1 default mode still imports inbox` remains `PASS`

- [ ] **Step 5: Check diagnostics for the edited files**

Check:

```text
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/.claude/skills/wechat-skill/collect-wechat.ps1
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/test-watcher.ts
```

Expected:

- no new diagnostics in either file

- [ ] **Step 6: Commit the implementation**

```powershell
git add .claude/skills/wechat-skill/collect-wechat.ps1 test-watcher.ts
git commit -m "feat: add wechat skill start mode"
```

### Task 3: Document the `--start` Contract

**Files:**
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\skills\wechat-skill\SKILL.md`
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\CLAUDE.md`
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\CLAUDE_CN.md`

- [ ] **Step 1: Update `SKILL.md` argument hints and common usage**

Edit the header and usage section to include `--start`:

```md
argument-hint: "[--start] [--stop] [--all] [--limit N]"
```

And add:

```md
- `/wechat-skill --start` — 启动后台 watcher 并立即退出
```

- [ ] **Step 2: Add the start entry contract to the skill doc**

Insert a new section near the existing `Stop 入口契约`:

```md
### 7. Start 入口契约

- `--start` 是 skill 入口层控制命令，命中后必须短路正常导入流程，不得透传给 `weixin-inbox.ps1 copy/export`。
- `--start` 只能单独使用，不得与其他参数混用。
- `/wechat-skill --start` 只负责启动当前项目的后台 watcher，并立即退出。
- 仅当观察到当前项目 watcher 已在后台运行时，才返回启动成功。
```
```

Then renumber the existing stop section from `### 7` to `### 8`.

- [ ] **Step 3: Update `CLAUDE.md` and `CLAUDE_CN.md` repo contracts**

Add parallel start-entry bullets near the existing stop-entry contract sections:

```md
- `collect-wechat.ps1` must treat `--start` as an exclusive control mode before inbox import.
- `--start` must only return success after the current project's watcher is observably running.
- Default `/wechat-skill` remains import-only and must not implicitly start the watcher.
```
```

Use equivalent Chinese wording in `CLAUDE_CN.md`.

- [ ] **Step 4: Check diagnostics for all updated docs**

Check:

```text
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/.claude/skills/wechat-skill/SKILL.md
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/CLAUDE.md
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/CLAUDE_CN.md
```

Expected:

- no diagnostics in all three docs

- [ ] **Step 5: Commit the documentation**

```powershell
git add .claude/skills/wechat-skill/SKILL.md CLAUDE.md CLAUDE_CN.md
git commit -m "docs: document wechat skill start mode"
```

### Task 4: Final Verification and Handoff

**Files:**
- Modify: `c:\Users\len\ywwu_workspace\claude_skill_learn\test-watcher.ts`
- Verify: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\skills\wechat-skill\collect-wechat.ps1`
- Verify: `c:\Users\len\ywwu_workspace\claude_skill_learn\.claude\skills\wechat-skill\SKILL.md`
- Verify: `c:\Users\len\ywwu_workspace\claude_skill_learn\CLAUDE.md`
- Verify: `c:\Users\len\ywwu_workspace\claude_skill_learn\CLAUDE_CN.md`

- [ ] **Step 1: Re-run the watcher script suite**

Run:

```powershell
bun run .\test-watcher.ts watcher
```

Expected:

- all `collect-wechat.ps1 --start` cases `PASS`
- all existing `collect-wechat.ps1 --stop` cases `PASS`
- no regression in `wechat-auto-reply.ts --once`

- [ ] **Step 2: Manually verify real `--start` and `--stop` behavior**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\skills\wechat-skill\collect-wechat.ps1 --stop
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\skills\wechat-skill\collect-wechat.ps1 --start
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\skills\wechat-skill\collect-wechat.ps1 --start
powershell -NoProfile -ExecutionPolicy Bypass -File .\.claude\skills\wechat-skill\collect-wechat.ps1 --stop
```

Expected:

- first stop returns either `已停止 watcher。` or `watcher 未运行，无需停止。`
- first start returns `已启动 watcher。`
- second start returns `watcher 已在运行。`
- final stop returns `已停止 watcher。`

- [ ] **Step 3: Check final diagnostics on recently edited files**

Check:

```text
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/.claude/skills/wechat-skill/collect-wechat.ps1
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/test-watcher.ts
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/.claude/skills/wechat-skill/SKILL.md
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/CLAUDE.md
file:///c:/Users/len/ywwu_workspace/claude_skill_learn/CLAUDE_CN.md
```

Expected:

- no new diagnostics

- [ ] **Step 4: Commit any final verification-only adjustments**

```powershell
git status --short
```

Expected:

- no unexpected modified tracked files

- [ ] **Step 5: Push after user approval**

```powershell
git push
```

Expected:

- remote branch updated successfully after review
