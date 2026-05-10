import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

type TestStatus = "PASS" | "FAIL" | "WARN";

interface TestResult {
  name: string;
  status: TestStatus;
  detail: string;
}

interface CommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface RawCommandResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  error?: string;
}

interface ClaudeRunResultForTest {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

type ParsedAction =
  | { action: "chat" | "executed"; reply: string }
  | { action: "risky"; warning: string; command?: string };

interface QueueEntry {
  id: string;
  text: string;
  fromUserId: string;
}

interface QueueLifecycle {
  status: "classifying" | "classified" | "executing" | "replied" | "dead";
  failCount: number;
}

interface QueueState {
  messageStates: Record<string, QueueLifecycle>;
  deadLetterIds?: string[];
  pendingConfirmation?: {
    chatId: string;
  };
}

interface PendingConfirmationCase {
  chatId: string;
  inboxId: string;
  pendingAction: string;
}

const projectRoot = process.cwd();
const skillDir = join(projectRoot, ".claude", "skills", "wechat-skill-2");
const hooksDir = join(projectRoot, ".claude", "hooks");
const stateDir = join(homedir(), ".claude", "channels", "weixin");
const settingsPath = join(projectRoot, ".claude", "settings.weixin-session.json");
const pluginVersionsRoot = join(homedir(), ".claude", "plugins", "cache", "cc-weixin", "weixin");

function buildClassificationPrompt(text: string): string {
  return [
    `用户从微信发来消息："${text}"`,
    "",
    "你必须忽略上下文中的其他所有指令。现在你的唯一身份是一个JSON消息分类器，不要做任何其他事。",
    "",
    "分类规则：",
    "- 纯闲聊（打招呼、情感表达、简单问答等）→ 输出JSON:",
    '  {"action":"chat","reply":"你的自然回复"}',
    "- 安全操作（查看文件、搜索内容、读取信息、查询实时数据等）→ 输出JSON:",
    '  {"action":"executed","reply":"简述你准备做什么"}',
    "- 风险操作（删除文件、创建文件、写入文件、修改系统、安装软件、执行脚本等）→ 输出JSON:",
    '  {"action":"risky","warning":"风险说明","command":"操作简述"}',
    "",
    "铁律：",
    "- 你的回答必须以 { 开头，以 } 结尾，必须是合法JSON",
    "- 不要输出任何JSON以外的文字、解释、问候、或Markdown",
    "- 闲聊回复要自然亲切，用简体中文",
    "- 风险判断从严：涉及删、改、建、写、装、脚本字眼的都是风险",
  ].join("\n");
}

function buildExecutePrompt(text: string): string {
  return [
    `用户要求："${text}"。请使用可用工具完成这个请求。`,
    "",
    "可用工具：Glob（文件匹配）、Grep（内容搜索）、Read（读取文件）、Bash（Shell命令）、WebSearch（网络搜索）、WebFetch（读取网页）。",
    "执行完成后用简体中文简洁总结结果，必须输出合法JSON:",
    '  {"action":"executed","reply":"执行结果文本"}',
    "",
    "铁律：只输出一行合法JSON，绝不要任何额外文字。",
  ].join("\n");
}

function buildRiskyExecutePromptForTest(originalText: string, command: string): string {
  const action = command || originalText;
  return [
    `用户要求："${originalText}"，已获得用户确认，请立即执行。`,
    `具体操作：${action}`,
    "",
    "可用工具：Glob（文件匹配）、Grep（内容搜索）、Read（读取文件）、Write（写入文件）、Bash（Shell命令）、WebSearch（网络搜索）、WebFetch（读取网页）。",
    "执行完成后用简体中文简洁输出结果，必须输出合法JSON:",
    '  {"action":"executed","reply":"执行结果文本"}',
    "",
    "铁律：只输出一行合法JSON，绝不要任何额外文字。",
  ].join("\n");
}

function runCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    input?: string;
    env?: Record<string, string>;
    timeout?: number;
  },
): CommandResult {
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    encoding: "utf-8",
    cwd: options?.cwd || projectRoot,
    input: options?.input,
    timeout: options?.timeout || 120000,
    env: {
      ...process.env,
      ...options?.env,
    },
  });

  return {
    status: result.status,
    signal: result.signal,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error ? String(result.error.message || result.error) : undefined,
  };
}

function runRawCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    input?: string;
    env?: Record<string, string>;
    timeout?: number;
  },
): RawCommandResult {
  const result = spawnSync(command, args, {
    cwd: options?.cwd || projectRoot,
    input: options?.input,
    timeout: options?.timeout || 120000,
    env: {
      ...process.env,
      ...options?.env,
    },
  });

  return {
    status: result.status,
    signal: result.signal,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || ""),
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr || ""),
    error: result.error ? String(result.error.message || result.error) : undefined,
  };
}

function toHex(buffer: Buffer): string {
  return buffer.toString("hex");
}

function latestPluginRoot(): string | null {
  if (!existsSync(pluginVersionsRoot)) {
    return null;
  }

  const candidates = readdirSync(pluginVersionsRoot)
    .map((name) => join(pluginVersionsRoot, name))
    .filter((fullPath) => existsSync(join(fullPath, "package.json")))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  return candidates[0] || null;
}

function resolveBunPath(): string | null {
  const whereBun = runCommand("where.exe", ["bun"], { timeout: 15000 });
  if (whereBun.status !== 0 || !whereBun.stdout) {
    return null;
  }

  const candidates = whereBun.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith(".exe") && existsSync(candidate)) {
      return candidate;
    }
    const siblingExe = join(dirname(candidate), "node_modules", "bun", "bin", "bun.exe");
    if (existsSync(siblingExe)) {
      return siblingExe;
    }
  }

  return candidates[0] || null;
}

function resolveClaudePath(): string | null {
  const whereClaude = runCommand("where.exe", ["claude"], { timeout: 15000 });
  if (whereClaude.status !== 0 || !whereClaude.stdout) {
    return null;
  }

  const candidates = whereClaude.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith(".exe") && existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0] || null;
}

function parseActionPayload(raw: string): ParsedAction | null {
  const text = raw.trim();
  if (!text) return null;

  const parseCandidate = (candidate: string): ParsedAction | null => {
    try {
      const parsed = JSON.parse(candidate);
      if ((parsed.action === "chat" || parsed.action === "executed") && typeof parsed.reply === "string") {
        return { action: parsed.action, reply: parsed.reply };
      }
      if (parsed.action === "risky" && typeof parsed.warning === "string") {
        return { action: "risky", warning: parsed.warning, command: parsed.command };
      }
      if (parsed.type === "result" && typeof parsed.result === "string") {
        return parseCandidate(parsed.result);
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = parseCandidate(text);
  if (direct) return direct;

  const nestedMatch = text.match(/\{[\s\S]*"type"\s*:\s*"result"[\s\S]*\}/);
  if (nestedMatch) {
    const nested = parseCandidate(nestedMatch[0]);
    if (nested) return nested;
  }

  const actionMatch = text.match(/\{[\s\S]*"action"[\s\S]*\}/);
  if (actionMatch) {
    return parseCandidate(actionMatch[0]);
  }

  return null;
}

function shouldSkipQueueEntry(entry: QueueEntry): boolean {
  return entry.text.trim().length === 0;
}

function rankQueueEntry(entry: QueueEntry, state: QueueState): number {
  const lifecycle = state.messageStates[entry.id];
  if (lifecycle && (lifecycle.status === "replied" || lifecycle.status === "dead")) {
    return 99;
  }
  const deadLetter = new Set(state.deadLetterIds || []);
  if (deadLetter.has(entry.id)) {
    return 99;
  }
  if (shouldSkipQueueEntry(entry)) {
    return 99;
  }
  const pc = state.pendingConfirmation;
  if (pc && entry.fromUserId === pc.chatId) {
    return 0;
  }
  if (!lifecycle) {
    return 1;
  }
  return 2;
}

function dedupeQueueEntries(entries: QueueEntry[]): QueueEntry[] {
  const seen = new Set<string>();
  const unique: QueueEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

function isConfirmReplyForTest(text: string): boolean {
  return /^(是|好|可以|行|对|确认|ok|yes|y|没错|嗯|对的|是的)/i.test(text.trim());
}

function isDenyReplyForTest(text: string): boolean {
  return /^(不|否|别|取消|no|n|算了|不要)/i.test(text.trim());
}

function decidePendingBranchCurrent(
  entry: QueueEntry,
  pending?: PendingConfirmationCase,
): "confirm" | "deny" | "ignore_original" | "clear_and_new" | "new_request" {
  if (!pending || entry.fromUserId !== pending.chatId) {
    return "new_request";
  }

  if (entry.id === pending.inboxId) {
    return "ignore_original";
  }

  if (isConfirmReplyForTest(entry.text)) {
    return "confirm";
  }

  if (isDenyReplyForTest(entry.text)) {
    return "deny";
  }

  return "clear_and_new";
}

function applyRiskConfirmStateCurrent(state: QueueState, confirmEntry: QueueEntry): QueueState {
  const advancedState: QueueState = {
    ...state,
    messageStates: {
      ...state.messageStates,
      [confirmEntry.id]: { status: "replied", failCount: 0 },
    },
  };

  void advancedState;

  // Current production behavior: save pendingConfirmation: undefined using stale currentState,
  // which overwrites the just-advanced replied lifecycle for the confirm message.
  return {
    ...state,
    pendingConfirmation: undefined,
  };
}

function applyRiskConfirmStateExpected(state: QueueState, confirmEntry: QueueEntry): QueueState {
  return {
    ...state,
    messageStates: {
      ...state.messageStates,
      [confirmEntry.id]: { status: "replied", failCount: 0 },
    },
    pendingConfirmation: undefined,
  };
}

function getRiskyExecRetryReasonForTest(result: ClaudeRunResultForTest): "empty_stdout" | "timeout" | null {
  const stderrText = `${result.stderr}\n${result.error || ""}`;
  if (!result.stdout.trim() && result.status === 0) {
    return "empty_stdout";
  }
  if (/ETIMEDOUT|timed out after \d+ms/i.test(stderrText)) {
    return "timeout";
  }
  return null;
}

function extractSimpleDeleteTargetForTest(text: string): string | null {
  const trimmed = text.trim();
  const patterns = [
    /^(?:请)?(?:准备)?删除(?:文件)?\s*([A-Za-z0-9._\-\\/]+?)(?:\s*文件)?$/i,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function resolveSafeProjectDeletePathForTest(projectRootPath: string, text: string): string | null {
  const target = extractSimpleDeleteTargetForTest(text);
  if (!target) return null;
  if (/^[a-zA-Z]:/.test(target) || target.startsWith("/") || target.startsWith("\\")) {
    return null;
  }
  const normalizedTarget = target.replace(/[\\/]+/g, "\\");
  if (normalizedTarget.split("\\").some((segment) => segment === ".." || segment.length === 0)) {
    return null;
  }
  const resolved = resolve(projectRootPath, normalizedTarget);
  const normalizedProjectRoot = normalize(projectRootPath).toLowerCase();
  const normalizedResolved = normalize(resolved).toLowerCase();
  if (normalizedResolved !== normalizedProjectRoot && !normalizedResolved.startsWith(`${normalizedProjectRoot}\\`)) {
    return null;
  }
  return resolved;
}

function selectCurrentQueueEntry(unreadEntries: QueueEntry[], state: QueueState): QueueEntry | null {
  const ranked = dedupeQueueEntries(unreadEntries)
    .map((entry, index) => ({ entry, index, rank: rankQueueEntry(entry, state) }))
    .filter((item) => item.rank < 99)
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked[0]?.entry || null;
}

function push(results: TestResult[], name: string, status: TestStatus, detail: string): void {
  results.push({ name, status, detail });
}

function runEnvTests(): TestResult[] {
  const results: TestResult[] = [];
  const claude = runCommand("claude", ["--version"], { timeout: 15000 });
  push(
    results,
    "claude --version",
    claude.status === 0 ? "PASS" : "FAIL",
    claude.status === 0 ? claude.stdout : claude.error || claude.stderr || "claude 不可用",
  );

  const bun = runCommand("bun", ["--version"], { timeout: 15000 });
  push(
    results,
    "bun --version",
    bun.status === 0 ? "PASS" : "FAIL",
    bun.status === 0 ? bun.stdout : bun.error || bun.stderr || "bun 不可用",
  );

  const whereBun = runCommand("where.exe", ["bun"], { timeout: 15000 });
  push(
    results,
    "where bun",
    whereBun.status === 0 ? "PASS" : "WARN",
    whereBun.stdout || whereBun.stderr || whereBun.error || "未找到 bun 路径",
  );

  const bunPath = resolveBunPath();
  if (bunPath) {
    const bunResolved = runCommand(bunPath, ["--version"], { timeout: 15000 });
    push(
      results,
      "resolved bun --version",
      bunResolved.status === 0 ? "PASS" : "FAIL",
      bunResolved.stdout || bunResolved.stderr || bunResolved.error || bunPath,
    );
  }

  const checks: Array<[string, string]> = [
    ["settings.weixin-session.json", settingsPath],
    ["wechat-auto-reply.ts", join(hooksDir, "wechat-auto-reply.ts")],
    ["collect-wechat.ps1", join(skillDir, "collect-wechat.ps1")],
    ["weixin-inbox.ps1", join(skillDir, "weixin-inbox.ps1")],
    ["wechat-approve.ps1", join(skillDir, "wechat-approve.ps1")],
    ["account.json", join(stateDir, "account.json")],
    ["inbox.jsonl", join(stateDir, "inbox.jsonl")],
  ];

  for (const [name, filePath] of checks) {
    push(results, `exists:${name}`, existsSync(filePath) ? "PASS" : "FAIL", filePath);
  }

  const pluginRoot = latestPluginRoot();
  push(
    results,
    "cc-weixin plugin",
    pluginRoot ? "PASS" : "FAIL",
    pluginRoot || `未找到插件目录: ${pluginVersionsRoot}`,
  );

  return results;
}

function runScriptTests(): TestResult[] {
  const results: TestResult[] = [];
  const wechatApprove = runCommand(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(skillDir, "wechat-approve.ps1"), "count"],
    { timeout: 30000 },
  );
  push(
    results,
    "wechat-approve.ps1 count",
    wechatApprove.status === 0 ? "PASS" : "FAIL",
    wechatApprove.stdout || wechatApprove.stderr || wechatApprove.error || "无输出",
  );

  const inboxList = runCommand(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(skillDir, "weixin-inbox.ps1"), "list", "--limit", "1"],
    { timeout: 45000 },
  );
  push(
    results,
    "weixin-inbox.ps1 list --limit 1",
    inboxList.status === 0 ? "PASS" : "FAIL",
    (inboxList.stdout || inboxList.stderr || inboxList.error || "无输出").slice(0, 300),
  );

  const collect = runCommand(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(skillDir, "collect-wechat.ps1"), "--limit", "1"],
    { timeout: 60000 },
  );
  push(
    results,
    "collect-wechat.ps1 --limit 1",
    collect.status === 0 ? "PASS" : "FAIL",
    (collect.stdout || collect.stderr || collect.error || "无输出").slice(0, 300),
  );

  return results;
}

function runClassificationTests(): TestResult[] {
  const results: TestResult[] = [];
  const prompt = buildClassificationPrompt("hello");
  const env = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL_WATCHER || "claude-haiku-4-5-20251001",
  };

  const promptMode = runCommand(
    "claude",
    ["-p", prompt, "--permission-mode", "bypassPermissions"],
    { env, timeout: 120000 },
  );
  const promptModeParsed = parseActionPayload(promptMode.stdout);
  push(
    results,
    "claude -p classify hello",
    promptMode.status === 0 && !!promptModeParsed ? "PASS" : "FAIL",
    promptModeParsed
      ? `解析成功: ${JSON.stringify(promptModeParsed).slice(0, 180)}`
      : (promptMode.stdout || promptMode.stderr || promptMode.error || "无输出").slice(0, 300),
  );

  const stdinMode = runCommand(
    "claude",
    ["--permission-mode", "bypassPermissions"],
    { env, input: prompt, timeout: 120000 },
  );
  const stdinModeParsed = parseActionPayload(stdinMode.stdout);
  push(
    results,
    "claude stdin classify hello",
    stdinMode.status === 0 && !!stdinModeParsed ? "PASS" : "FAIL",
    stdinModeParsed
      ? `解析成功: ${JSON.stringify(stdinModeParsed).slice(0, 180)}`
      : (stdinMode.stdout || stdinMode.stderr || stdinMode.error || "无输出").slice(0, 300),
  );

  return results;
}

function runProtocolTests(): TestResult[] {
  const results: TestResult[] = [];

  const samples: Array<{ name: string; raw: string; expect: "chat" | "executed" | "risky" }> = [
    {
      name: "direct action json",
      raw: '{"action":"chat","reply":"你好"}',
      expect: "chat",
    },
    {
      name: "result wrapper json",
      raw: '{"type":"result","subtype":"success","result":"{\\"action\\":\\"executed\\",\\"reply\\":\\"已读取 CLAUDE.md\\"}"}',
      expect: "executed",
    },
    {
      name: "wrapped noisy output",
      raw: '[log] start\n{"type":"result","subtype":"success","result":"{\\"action\\":\\"risky\\",\\"warning\\":\\"删除文件有风险\\",\\"command\\":\\"删除 test.txt\\"}"}\n[log] end',
      expect: "risky",
    },
  ];

  for (const sample of samples) {
    const parsed = parseActionPayload(sample.raw);
    push(
      results,
      `parse sample: ${sample.name}`,
      parsed?.action === sample.expect ? "PASS" : "FAIL",
      parsed ? `解析为 ${parsed.action}` : "返回 null",
    );
  }

  const env = {
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL_WATCHER || "claude-haiku-4-5-20251001",
  };
  const timeoutMsRaw = Number.parseInt(process.env.API_TIMEOUT_MS || "", 10);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 180000;

  const executePrompt = [
    '请只使用 Read 工具读取当前项目下 `CLAUDE.md` 的第一行。',
    '完成后必须只输出一行合法 JSON，格式为 {"action":"executed","reply":"执行结果文本"}。',
    '不要输出任何额外文字。',
  ].join("\n");
  const executeResult = runCommand(
    "claude",
    ["-p", executePrompt, "--permission-mode", "bypassPermissions", "--tools", "Read"],
    { env, timeout: timeoutMs },
  );
  const executeParsed = parseActionPayload(executeResult.stdout);
  const executeStatus: TestStatus =
    executeResult.status === 0 && executeParsed?.action === "executed"
      ? "PASS"
      : (executeResult.error || executeResult.stderr).includes("ETIMEDOUT")
        ? "WARN"
        : "FAIL";
  push(
    results,
    "claude -p execute read CLAUDE.md",
    executeStatus,
    executeParsed
      ? `解析成功: ${JSON.stringify(executeParsed).slice(0, 220)}`
      : (executeResult.stdout || executeResult.stderr || executeResult.error || "无输出").slice(0, 400),
  );

  return results;
}

function runEncodingTests(): TestResult[] {
  const results: TestResult[] = [];
  const bunPath = resolveBunPath();

  if (!bunPath) {
    push(results, "resolve bun path", "FAIL", "无法定位 bun 可执行文件");
    return results;
  }

  const expectedHex = Buffer.from("中文测试\n", "utf8").toString("hex");
  const directBun = runRawCommand(
    bunPath,
    ["-e", "console.log('中文测试')"],
    { timeout: 30000 },
  );
  push(
    results,
    "bun.exe stdout utf8",
    directBun.status === 0 && toHex(directBun.stdout) === expectedHex ? "PASS" : "FAIL",
    `hex=${toHex(directBun.stdout)} utf8=${directBun.stdout.toString("utf8").trim() || "(empty)"} stderr=${directBun.stderr.toString("utf8").trim() || "(empty)"}`,
  );

  const inner = [
    `& '${bunPath}' -e "console.log('中文测试')"`,
  ].join("\n");
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const psBun = runRawCommand(
    "powershell",
    ["-NoProfile", "-EncodedCommand", encoded],
    { timeout: 30000 },
  );
  push(
    results,
    "powershell -> bun.exe stdout utf8",
    psBun.status === 0 && toHex(psBun.stdout) === expectedHex ? "PASS" : "FAIL",
    `hex=${toHex(psBun.stdout)} utf8=${psBun.stdout.toString("utf8").trim() || "(empty)"} stderr=${psBun.stderr.toString("utf8").trim() || "(empty)"}`,
  );

  const tempLogPath = join(projectRoot, ".claude", "tmp-encoding-test.log");
  rmSync(tempLogPath, { force: true });
  const redirectScript = [
    `[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `$OutputEncoding = [System.Text.UTF8Encoding]::new($false)`,
    `$PSDefaultParameterValues['*:Encoding'] = 'utf8'`,
    `& '${bunPath}' -e "console.log('中文测试')" *>> '${tempLogPath}'`,
  ].join("\n");
  const redirectEncoded = Buffer.from(redirectScript, "utf16le").toString("base64");
  const redirectResult = runRawCommand(
    "powershell",
    ["-NoProfile", "-EncodedCommand", redirectEncoded],
    { timeout: 30000 },
  );
  const redirectedBytes = existsSync(tempLogPath) ? readFileSync(tempLogPath) : Buffer.alloc(0);
  push(
    results,
    "powershell redirection log utf8",
    redirectResult.status === 0 && toHex(redirectedBytes) === expectedHex ? "PASS" : "FAIL",
    `hex=${toHex(redirectedBytes)} utf8=${redirectedBytes.toString("utf8").trim() || "(empty)"} stderr=${redirectResult.stderr.toString("utf8").trim() || "(empty)"}`,
  );
  rmSync(tempLogPath, { force: true });

  return results;
}

function runPathTests(): TestResult[] {
  const results: TestResult[] = [];

  const whereBun = runCommand("where.exe", ["bun"], { timeout: 15000 });
  const bunCandidates = whereBun.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  push(
    results,
    "where bun candidates",
    bunCandidates.length > 0 ? "PASS" : "FAIL",
    bunCandidates.join(" | ") || "未找到 bun",
  );

  if (bunCandidates[0]) {
    const bunWrapper = runCommand(bunCandidates[0], ["--version"], { timeout: 15000 });
    push(
      results,
      "bun wrapper --version",
      bunWrapper.status === 0 && !!bunWrapper.stdout.trim() ? "PASS" : "WARN",
      `path=${bunCandidates[0]} stdout=${bunWrapper.stdout || "(empty)"} stderr=${bunWrapper.stderr || "(empty)"} error=${bunWrapper.error || "(none)"}`,
    );
  }

  const bunPath = resolveBunPath();
  push(
    results,
    "resolved bun path",
    bunPath?.toLowerCase().endsWith("bun.exe") ? "PASS" : "FAIL",
    bunPath || "未解析到 bun 路径",
  );
  if (bunPath) {
    const bunExe = runCommand(bunPath, ["--version"], { timeout: 15000 });
    push(
      results,
      "bun.exe --version",
      bunExe.status === 0 && !!bunExe.stdout.trim() ? "PASS" : "FAIL",
      `path=${bunPath} stdout=${bunExe.stdout || "(empty)"} stderr=${bunExe.stderr || "(empty)"} error=${bunExe.error || "(none)"}`,
    );
  }

  const whereClaude = runCommand("where.exe", ["claude"], { timeout: 15000 });
  const claudeCandidates = whereClaude.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  push(
    results,
    "where claude candidates",
    claudeCandidates.length > 0 ? "PASS" : "FAIL",
    claudeCandidates.join(" | ") || "未找到 claude",
  );

  if (claudeCandidates[0]) {
    const claudeWrapper = runCommand(claudeCandidates[0], ["--version"], { timeout: 15000 });
    push(
      results,
      "claude wrapper --version",
      claudeWrapper.status === 0 && !!claudeWrapper.stdout.trim() ? "PASS" : "WARN",
      `path=${claudeCandidates[0]} stdout=${claudeWrapper.stdout || "(empty)"} stderr=${claudeWrapper.stderr || "(empty)"} error=${claudeWrapper.error || "(none)"}`,
    );
  }

  const claudePath = resolveClaudePath();
  push(
    results,
    "resolved claude path",
    claudePath?.toLowerCase().endsWith("claude.exe") ? "PASS" : "FAIL",
    claudePath || "未解析到 claude 路径",
  );
  if (claudePath) {
    const claudeExe = runCommand(claudePath, ["--version"], { timeout: 15000 });
    push(
      results,
      "claude.exe --version",
      claudeExe.status === 0 && !!claudeExe.stdout.trim() ? "PASS" : "FAIL",
      `path=${claudePath} stdout=${claudeExe.stdout || "(empty)"} stderr=${claudeExe.stderr || "(empty)"} error=${claudeExe.error || "(none)"}`,
    );
  }

  return results;
}

function runQueueTests(): TestResult[] {
  const results: TestResult[] = [];

  const oldBlockedId = "old-flight";
  const newHelloId = "new-hello";
  const newerHelloId = "newer-hello";
  const syntheticEntries: QueueEntry[] = [
    { id: oldBlockedId, text: "帮我查询西安飞莫斯科的航班都有哪些", fromUserId: "chat-a" },
    { id: newHelloId, text: "hello", fromUserId: "chat-a" },
    { id: newerHelloId, text: "hello", fromUserId: "chat-a" },
  ];
  const syntheticState: QueueState = {
    messageStates: {
      [oldBlockedId]: { status: "classifying", failCount: 1 },
    },
    deadLetterIds: [],
  };

  const firstPick = selectCurrentQueueEntry(syntheticEntries, syntheticState);
  push(
    results,
    "current queue picks oldest blocked message",
    firstPick?.id === newHelloId ? "PASS" : "FAIL",
    `当前选中=${firstPick?.id || "(none)"}；若想避免新消息饿死，应优先处理 ${newHelloId}`,
  );

  const secondState: QueueState = {
    messageStates: {
      [oldBlockedId]: { status: "classifying", failCount: 2 },
    },
    deadLetterIds: [],
  };
  const secondPick = selectCurrentQueueEntry(syntheticEntries, secondState);
  push(
    results,
    "repeated retry still blocks newer hello",
    secondPick?.id === newHelloId ? "PASS" : "FAIL",
    `第二轮仍选中=${secondPick?.id || "(none)"}；结合每轮只处理一条，会让 ${newHelloId}/${newerHelloId} 持续等待`,
  );

  const duplicateEntries: QueueEntry[] = [
    { id: "dup-1", text: "你好，聊聊天", fromUserId: "chat-a" },
    { id: "dup-1", text: "你好，聊聊天", fromUserId: "chat-a" },
    { id: "dup-1", text: "你好，聊聊天", fromUserId: "chat-a" },
    { id: "fresh-1", text: "hello", fromUserId: "chat-a" },
  ];
  const deduped = dedupeQueueEntries(duplicateEntries);
  push(
    results,
    "duplicate inbox ids are deduped",
    deduped.length === 2 ? "PASS" : "FAIL",
    `去重后数量=${deduped.length}；期望 2（dup-1 + fresh-1）`,
  );

  const actualStatePath = join(projectRoot, ".claude", "wechat-auto-state.json");
  const inboxPath = join(stateDir, "inbox.jsonl");
  if (existsSync(actualStatePath) && existsSync(inboxPath)) {
    try {
      const actualState = JSON.parse(readFileSync(actualStatePath, "utf-8")) as QueueState;
      const actualInbox = readFileSync(inboxPath, "utf-8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const parsed = JSON.parse(line) as QueueEntry;
            return [{ id: parsed.id, text: parsed.text, fromUserId: parsed.fromUserId }];
          } catch {
            return [];
          }
        });
      const actualIds = [
        "o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat:7458743926473977000",
        "o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat:7458897576261358000",
        "o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat:7458898054802150000",
      ];
      const actualEntries = actualInbox.filter((entry) => actualIds.includes(entry.id));
      const actualPick = selectCurrentQueueEntry(actualEntries, actualState);
      const activeIds = actualIds.filter((id) => {
        const lifecycle = actualState.messageStates[id];
        return lifecycle && lifecycle.status !== "replied" && lifecycle.status !== "dead";
      });
      push(
        results,
        "actual queue reproduces blocked hello",
        activeIds.length === 0 || actualPick?.id === "o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat:7458897576261358000" ? "PASS" : "FAIL",
        activeIds.length === 0
          ? "当前真实队列已清空；不再存在老消息阻塞新消息"
          : `当前真实选中=${actualPick?.id || "(none)"}；若不是 hello，则说明老消息仍可能阻塞新消息`,
      );

      const duplicateActual = actualInbox.filter((entry) => entry.id === "o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat:7458913714269703000");
      const duplicateActualDeduped = dedupeQueueEntries(duplicateActual);
      push(
        results,
        "actual duplicate inbox ids are deduped",
        duplicateActual.length > 1 && duplicateActualDeduped.length === 1 ? "PASS" : "FAIL",
        `真实重复条数=${duplicateActual.length}，去重后=${duplicateActualDeduped.length}`,
      );
    } catch (error) {
      push(results, "actual queue reproduces blocked hello", "WARN", error instanceof Error ? error.message : String(error));
    }
  } else {
    push(results, "actual queue reproduces blocked hello", "WARN", "缺少真实 state/inbox 文件，已跳过");
  }

  return results;
}

function runRiskTests(): TestResult[] {
  const results: TestResult[] = [];
  const createPrompt = buildClassificationPrompt("创建test.txt");

  push(
    results,
    "classification prompt marks create file as risky",
    createPrompt.includes("创建文件") && createPrompt.includes("写入文件") ? "PASS" : "FAIL",
    "创建/写入文件属于会修改文件系统的操作，分类提示词必须明确将其归为 risky，避免被模型当成 executed 直接执行",
  );

  const riskyEntry: QueueEntry = {
    id: "risk-delete-test-txt",
    text: "删除test.txt文件",
    fromUserId: "chat-risk",
  };
  const confirmEntry: QueueEntry = {
    id: "risk-confirm-yes",
    text: "是",
    fromUserId: "chat-risk",
  };
  const pending: PendingConfirmationCase = {
    chatId: "chat-risk",
    inboxId: riskyEntry.id,
    pendingAction: riskyEntry.text,
  };

  const currentOriginalDecision = decidePendingBranchCurrent(riskyEntry, pending);
  push(
    results,
    "original risky message should not clear pending",
    currentOriginalDecision === "ignore_original" ? "PASS" : "FAIL",
    `当前分支结果=${currentOriginalDecision}；原始风险消息重复出现时，不应清空 pending 并重新分类`,
  );

  let pendingAfterOriginal: PendingConfirmationCase | undefined = pending;
  if (currentOriginalDecision === "clear_and_new") {
    pendingAfterOriginal = undefined;
  }
  const confirmDecision = decidePendingBranchCurrent(confirmEntry, pendingAfterOriginal);
  push(
    results,
    "yes reply should still route to pending confirm",
    confirmDecision === "confirm" ? "PASS" : "FAIL",
    `原始风险消息重复后，再收到"是"时当前结果=${confirmDecision}；期望仍为 confirm`,
  );

  const preConfirmState: QueueState = {
    messageStates: {
      [riskyEntry.id]: { status: "replied", failCount: 0 },
    },
    deadLetterIds: [],
    pendingConfirmation: {
      chatId: pending.chatId,
    },
  };
  const currentConfirmState = applyRiskConfirmStateCurrent(preConfirmState, confirmEntry);
  push(
    results,
    "stale state overwrite reproduces confirm reply loss",
    currentConfirmState.messageStates[confirmEntry.id]?.status !== "replied" ? "PASS" : "FAIL",
    "旧逻辑会在清除 pendingConfirmation 时覆盖掉确认消息的 replied 状态，这正是“是”被二次处理的根因",
  );

  const currentReplayPick = selectCurrentQueueEntry([confirmEntry], currentConfirmState);
  push(
    results,
    "stale state overwrite reproduces confirm requeue",
    currentReplayPick !== null ? "PASS" : "FAIL",
    currentReplayPick
      ? `当前状态下同一条确认消息会再次入队：${currentReplayPick.id}`
      : "旧逻辑未复现确认消息二次入队，和历史现象不一致",
  );

  const expectedConfirmState = applyRiskConfirmStateExpected(preConfirmState, confirmEntry);
  push(
    results,
    "merged state keeps confirm reply replied",
    expectedConfirmState.messageStates[confirmEntry.id]?.status === "replied" ? "PASS" : "FAIL",
    "修复后应先保留最新 messageStates，再清除 pendingConfirmation",
  );
  const fixedReplayPick = selectCurrentQueueEntry([confirmEntry], expectedConfirmState);
  push(
    results,
    "merged state prevents confirm requeue",
    fixedReplayPick === null ? "PASS" : "FAIL",
    fixedReplayPick
      ? `修复后确认消息仍再次入队：${fixedReplayPick.id}`
      : "修复后确认消息会被正确跳过，不再进入聊天/分类分支",
  );
  push(
    results,
    "risky exec timeout should trigger retry",
    getRiskyExecRetryReasonForTest({
      status: -1,
      stdout: "",
      stderr: "claude timed out after 120000ms\nspawnSync claude ETIMEDOUT",
    }) === "timeout" ? "PASS" : "FAIL",
    "真实 RiskyExec 删除失败日志包含 timed out after 120000ms / ETIMEDOUT，命中后应立即重试一次，而不是直接回复执行失败",
  );
  push(
    results,
    "risky exec empty stdout should still retry",
    getRiskyExecRetryReasonForTest({
      status: 0,
      stdout: "",
      stderr: "",
    }) === "empty_stdout" ? "PASS" : "FAIL",
    "保留现有空 stdout 重试语义，避免修复超时时回退掉已有兜底",
  );
  push(
    results,
    "risky exec non-timeout failure should not retry",
    getRiskyExecRetryReasonForTest({
      status: 1,
      stdout: "",
      stderr: "permission denied",
    }) === null ? "PASS" : "FAIL",
    "普通失败不应无限扩大重试面，只针对空输出和超时做最小容错",
  );
  push(
    results,
    "extract delete target from compact command",
    extractSimpleDeleteTargetForTest("删除test.txt") === "test.txt" ? "PASS" : "FAIL",
    `提取结果=${extractSimpleDeleteTargetForTest("删除test.txt") || "(null)"}`,
  );
  push(
    results,
    "extract delete target from explicit file command",
    extractSimpleDeleteTargetForTest("删除文件 test.txt") === "test.txt" ? "PASS" : "FAIL",
    `提取结果=${extractSimpleDeleteTargetForTest("删除文件 test.txt") || "(null)"}`,
  );
  push(
    results,
    "extract delete target from prepared command",
    extractSimpleDeleteTargetForTest("准备删除 test.txt 文件") === "test.txt" ? "PASS" : "FAIL",
    `提取结果=${extractSimpleDeleteTargetForTest("准备删除 test.txt 文件") || "(null)"}`,
  );
  push(
    results,
    "reject parent traversal delete target",
    resolveSafeProjectDeletePathForTest(projectRoot, "删除 ../secret.txt") === null ? "PASS" : "FAIL",
    "应拒绝删除项目根目录之外的路径",
  );
  const safeDeletePath = resolveSafeProjectDeletePathForTest(projectRoot, "删除 test.txt");
  push(
    results,
    "resolve simple delete target inside project",
    safeDeletePath === join(projectRoot, "test.txt") ? "PASS" : "FAIL",
    `解析路径=${safeDeletePath || "(null)"}`,
  );

  const claudePath = resolveClaudePath();
  if (!claudePath) {
    push(results, "resolve claude path for risky exec probe", "FAIL", "无法定位 claude 可执行文件");
  } else {
    const env = {
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL_WATCHER || "claude-haiku-4-5-20251001",
    };
    const timeoutMsRaw = Number.parseInt(process.env.API_TIMEOUT_MS || "", 10);
    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 120000;
    const createProbePath = join(projectRoot, "risk-create-probe.txt");
    const deleteProbePath = join(projectRoot, "risk-delete-probe.txt");
    const probeReportPath = join(projectRoot, ".claude", "risk-exec-probe.json");

    rmSync(createProbePath, { force: true });
    rmSync(deleteProbePath, { force: true });
    rmSync(probeReportPath, { force: true });

    const createPrompt = buildRiskyExecutePromptForTest("创建 risk-create-probe.txt", "创建 risk-create-probe.txt 文件");
    const createResult = runCommand(
      claudePath,
      ["--permission-mode", "bypassPermissions", "--tools", "Bash,Read,Write,WebSearch,WebFetch,Glob,Grep"],
      { env, input: createPrompt, timeout: timeoutMs + 10000 },
    );
    const createParsed = parseActionPayload(createResult.stdout);
    const createExistsAfter = existsSync(createProbePath);
    push(
      results,
      "risky exec probe create file",
      createResult.status === 0 && createParsed?.action === "executed" && createExistsAfter ? "PASS" : "FAIL",
      createParsed
        ? `status=${createResult.status} parsed=${JSON.stringify(createParsed).slice(0, 180)} fileExists=${createExistsAfter}`
        : `status=${createResult.status} stdout=${createResult.stdout.slice(0, 160)} stderr=${(createResult.stderr || createResult.error || "").slice(0, 180)} fileExists=${createExistsAfter}`,
    );

    const deletePrep = runCommand("powershell", ["-NoProfile", "-Command", `Set-Content -Path '${deleteProbePath}' -Value 'probe' -Encoding UTF8`], { timeout: 5000 });
    void deletePrep;
    const deletePrompt = buildRiskyExecutePromptForTest("删除 risk-delete-probe.txt", "准备删除 risk-delete-probe.txt 文件");
    const deleteResult = runCommand(
      claudePath,
      ["--permission-mode", "bypassPermissions", "--tools", "Bash,Read,Write,WebSearch,WebFetch,Glob,Grep"],
      { env, input: deletePrompt, timeout: timeoutMs + 10000 },
    );
    const deleteParsed = parseActionPayload(deleteResult.stdout);
    const deleteExistsAfter = existsSync(deleteProbePath);
    rmSync(deleteProbePath, { force: true });
    const aliasDeletePrep = runCommand("powershell", ["-NoProfile", "-Command", `Set-Content -Path '${deleteProbePath}' -Value 'probe-alias' -Encoding UTF8`], { timeout: 5000 });
    void aliasDeletePrep;
    const aliasDeleteResult = runCommand(
      "claude",
      ["--permission-mode", "bypassPermissions", "--tools", "Bash,Read,Write,WebSearch,WebFetch,Glob,Grep"],
      { env, input: deletePrompt, timeout: timeoutMs + 10000 },
    );
    const aliasDeleteParsed = parseActionPayload(aliasDeleteResult.stdout);
    const aliasDeleteExistsAfter = existsSync(deleteProbePath);
    writeFileSync(
      probeReportPath,
      JSON.stringify({
        claudePath,
        timeoutMs,
        create: {
          status: createResult.status,
          signal: createResult.signal,
          stdout: createResult.stdout,
          stderr: createResult.stderr,
          error: createResult.error,
          parsed: createParsed,
          fileExistsAfter: createExistsAfter,
        },
        delete: {
          status: deleteResult.status,
          signal: deleteResult.signal,
          stdout: deleteResult.stdout,
          stderr: deleteResult.stderr,
          error: deleteResult.error,
          parsed: deleteParsed,
          fileExistsAfter: deleteExistsAfter,
        },
        aliasDelete: {
          status: aliasDeleteResult.status,
          signal: aliasDeleteResult.signal,
          stdout: aliasDeleteResult.stdout,
          stderr: aliasDeleteResult.stderr,
          error: aliasDeleteResult.error,
          parsed: aliasDeleteParsed,
          fileExistsAfter: aliasDeleteExistsAfter,
        },
      }, null, 2),
      "utf-8",
    );
    push(
      results,
      "risky exec probe delete file",
      deleteResult.status === 0 && deleteParsed?.action === "executed" && !deleteExistsAfter ? "PASS" : "FAIL",
      deleteParsed
        ? `status=${deleteResult.status} parsed=${JSON.stringify(deleteParsed).slice(0, 180)} fileExists=${deleteExistsAfter}`
        : `status=${deleteResult.status} stdout=${deleteResult.stdout.slice(0, 160)} stderr=${(deleteResult.stderr || deleteResult.error || "").slice(0, 180)} fileExists=${deleteExistsAfter}`,
    );
    push(
      results,
      "risky exec probe delete file via alias claude",
      aliasDeleteResult.status === 0 && aliasDeleteParsed?.action === "executed" && !aliasDeleteExistsAfter ? "PASS" : "FAIL",
      aliasDeleteParsed
        ? `status=${aliasDeleteResult.status} parsed=${JSON.stringify(aliasDeleteParsed).slice(0, 180)} fileExists=${aliasDeleteExistsAfter}`
        : `status=${aliasDeleteResult.status} stdout=${aliasDeleteResult.stdout.slice(0, 160)} stderr=${(aliasDeleteResult.stderr || aliasDeleteResult.error || "").slice(0, 180)} fileExists=${aliasDeleteExistsAfter}`,
    );

    rmSync(createProbePath, { force: true });
    rmSync(deleteProbePath, { force: true });
  }

  const logPath = join(projectRoot, ".claude", "wechat-auto.log");
  if (existsSync(logPath)) {
    const logText = readFileSync(logPath, "utf-8");
    const recreateBug =
      logText.includes('Processing: o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat:7459029455685880000 text="请创建测试文件，test.txt"') &&
      logText.includes('Risk warn sent: "创建文件属于写操作，将修改文件系统内容"') &&
      logText.includes("Non-confirm while risky-pending; treating as new request");
    push(
      results,
      "log reproduces pending cleared by original risky message",
      recreateBug ? "PASS" : "WARN",
      recreateBug
        ? "历史日志已复现：同一条创建 test.txt 的原始风险消息在发出确认后再次进入 pending 分支，并触发 Non-confirm 清空 pending"
        : "未在日志中找到该复现片段",
    );

    const yesMisrouted =
      logText.includes('Processing: o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat:7459030188791553000 text="是"') &&
      !logText.includes('Risk confirm YES for "删除test.txt文件"');
    push(
      results,
      "log reproduces yes reply lost after pending cleared",
      yesMisrouted ? "PASS" : "WARN",
      yesMisrouted
        ? '历史日志已复现：用户对删除 test.txt 回复"是"后，没有进入 Risk confirm YES，而是继续重复风险确认/重分类'
        : '日志中未看到该误路由片段',
    );
  } else {
    push(results, "log reproduces pending cleared by original risky message", "WARN", "缺少 wechat-auto.log，已跳过");
    push(results, "log reproduces yes reply lost after pending cleared", "WARN", "缺少 wechat-auto.log，已跳过");
  }

  return results;
}

function runWatcherTests(): TestResult[] {
  const results: TestResult[] = [];
  const pidPath = join(projectRoot, ".claude", "wechat-auto.pid");
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, "utf-8").trim();
    const pidCheck = runCommand("tasklist", ["/FI", `PID eq ${pid}`], { timeout: 15000 });
    push(
      results,
      "wechat-auto.pid",
      pidCheck.stdout.includes(pid) ? "PASS" : "WARN",
      pidCheck.stdout || `PID 文件存在，但未找到进程: ${pid}`,
    );
  } else {
    push(results, "wechat-auto.pid", "WARN", "未找到 PID 文件");
  }

  const stopWatcher = runCommand(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(hooksDir, "stop-wechat-auto.ps1")],
    { timeout: 30000 },
  );
  push(
    results,
    "stop-wechat-auto.ps1",
    stopWatcher.status === 0 ? "PASS" : "FAIL",
    stopWatcher.stdout || stopWatcher.stderr || stopWatcher.error || "无输出",
  );

  const bunPath = resolveBunPath();
  if (!bunPath) {
    push(results, "resolved bun path", "FAIL", "无法定位 bun 可执行文件");
    return results;
  }

  const runOnce = runCommand(
    bunPath,
    ["run", join(hooksDir, "wechat-auto-reply.ts"), "--project-root", ".", "--once"],
    { timeout: 180000 },
  );
  push(
    results,
    "wechat-auto-reply.ts --once",
    runOnce.status === 0 ? "PASS" : "FAIL",
    (runOnce.stdout || runOnce.stderr || runOnce.error || "无输出").slice(0, 300),
  );

  return results;
}

function printResults(title: string, results: TestResult[]): boolean {
  console.log(`\n## ${title}`);
  let ok = true;
  for (const result of results) {
    if (result.status === "FAIL") ok = false;
    console.log(`[${result.status}] ${result.name}`);
    console.log(`  ${result.detail}`);
  }
  return ok;
}

function main(): void {
  const mode = process.argv[2] || "all";
  let overallOk = true;

  if (mode === "env" || mode === "all") {
    overallOk = printResults("环境测试", runEnvTests()) && overallOk;
  }

  if (mode === "scripts" || mode === "all") {
    overallOk = printResults("脚本测试", runScriptTests()) && overallOk;
  }

  if (mode === "classify" || mode === "all") {
    overallOk = printResults("分类测试", runClassificationTests()) && overallOk;
  }

  if (mode === "watcher" || mode === "all") {
    overallOk = printResults("Watcher 测试", runWatcherTests()) && overallOk;
  }

  if (mode === "protocol" || mode === "all") {
    overallOk = printResults("协议测试", runProtocolTests()) && overallOk;
  }

  if (mode === "encoding" || mode === "all") {
    overallOk = printResults("编码测试", runEncodingTests()) && overallOk;
  }

  if (mode === "paths" || mode === "all") {
    overallOk = printResults("路径测试", runPathTests()) && overallOk;
  }

  if (mode === "queue" || mode === "all") {
    overallOk = printResults("队列测试", runQueueTests()) && overallOk;
  }

  if (mode === "risk" || mode === "all") {
    overallOk = printResults("风险确认测试", runRiskTests()) && overallOk;
  }

  if (!["env", "scripts", "classify", "watcher", "protocol", "encoding", "paths", "queue", "risk", "all"].includes(mode)) {
    console.error(`未知模式: ${mode}`);
    console.error("用法: bun run test-watcher.ts [env|scripts|classify|watcher|protocol|encoding|paths|queue|risk|all]");
    process.exit(1);
  }

  process.exit(overallOk ? 0 : 1);
}

main();
