#!/usr/bin/env bun

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

interface InboxEntry {
  id: string;
  messageId: string;
  fromUserId: string;
  receivedAt: string;
  text: string;
  contextToken?: string;
  attachmentPath?: string;
  attachmentType?: string;
}

interface MessageLifecycle {
  status: "classifying" | "classified" | "executing" | "replied" | "dead";
  failCount: number;
  lastAttemptAt: string; // ISO timestamp
  cachedAction?: ActionResult; // preserved across restarts for crash recovery
}

interface AutoReplyState {
  /** @deprecated replaced by messageStates; kept for migration */
  processedMessageIds?: string[];
  /** Per-message lifecycle state machine */
  messageStates: Record<string, MessageLifecycle>;
  lastStartedAt?: string;
  deadLetterIds: string[];
  pendingConfirmation?: {
    chatId: string;
    contextToken: string;
    pendingAction: string;
    askedAt: string;
    replyText: string;
    inboxId: string;
  };
}

const CLASSIFY_TTL_MS = 5 * 60 * 1000; // 5 min — if stuck in classifying, assume crash
const MAX_CLASSIFY_RETRIES = 2; // retries before falling back to chat reply

function fallbackReply(originalText: string): string {
  const snippet = originalText.length > 30 ? originalText.slice(0, 30) + "..." : originalText;
  return `收到你的消息："${snippet}"，我稍后回复你。`;
}

interface PendingReply {
  id: string;
  inboxId: string;
  fromUserId: string;
  contextToken: string;
  originalText: string;
  replyText: string;
  rawOutput: string;
  status: "pending" | "approved" | "rejected" | "sent" | "failed";
  createdAt: string;
}

interface AccountData {
  token: string;
  baseUrl: string;
}

interface AutoReplyConfig {
  projectRoot: string;
  statePath: string;
  pendingPath: string;
  pollMs: number;
}

const DEFAULT_POLL_MS = 8000;

let processing = false;
let claudeExecutableCache: string | null | undefined;

function parseArgs(): { projectRoot: string; once: boolean } {
  const args = process.argv.slice(2);
  let projectRoot = process.cwd();
  let once = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project-root") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("Missing value for --project-root");
      }
      projectRoot = value;
      i++;
    } else if (arg === "--once") {
      once = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { projectRoot, once };
}

function resolveWeixinStateDir(): string {
  return process.env.WEIXIN_STATE_DIR || join(homedir(), ".claude", "channels", "weixin");
}

function resolveWeixinPluginRoot(): string {
  if (process.env.WECHAT_PLUGIN_ROOT && existsSync(process.env.WECHAT_PLUGIN_ROOT)) {
    return process.env.WECHAT_PLUGIN_ROOT;
  }

  const versionsRoot = join(homedir(), ".claude", "plugins", "cache", "cc-weixin", "weixin");
  if (!existsSync(versionsRoot)) {
    throw new Error(`Weixin plugin cache not found: ${versionsRoot}`);
  }

  const candidates = readdirSync(versionsRoot)
    .map((name) => join(versionsRoot, name))
    .filter((fullPath) => existsSync(join(fullPath, "package.json")))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

  if (candidates.length === 0) {
    throw new Error(`No installed weixin plugin version found in ${versionsRoot}`);
  }

  return candidates[0];
}

function resolveClaudeExecutable(): string {
  if (claudeExecutableCache !== undefined) {
    return claudeExecutableCache || "claude";
  }

  const envCandidate = process.env.CLAUDE_BIN?.trim();
  if (envCandidate && existsSync(envCandidate)) {
    claudeExecutableCache = envCandidate;
    return claudeExecutableCache;
  }

  const whereClaude = spawnSync("where.exe", ["claude"], {
    encoding: "utf-8",
    timeout: 15000,
    env: process.env,
  });
  const candidates = (whereClaude.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.toLowerCase().endsWith(".exe") && existsSync(candidate)) {
      claudeExecutableCache = candidate;
      return candidate;
    }

    const siblingExe = join(dirname(candidate), "claude.exe");
    if (existsSync(siblingExe)) {
      claudeExecutableCache = siblingExe;
      return siblingExe;
    }
  }

  claudeExecutableCache = null;
  return "claude";
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function loadState(statePath: string): AutoReplyState {
  if (!existsSync(statePath)) {
    return { messageStates: {}, deadLetterIds: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<AutoReplyState>;

    // Migration: old processedMessageIds → messageStates
    if (raw.messageStates === undefined) {
      raw.messageStates = {};
    }
    if (raw.processedMessageIds && raw.processedMessageIds.length > 0) {
      for (const id of raw.processedMessageIds) {
        if (!raw.messageStates[id]) {
          raw.messageStates[id] = {
            status: "replied",
            failCount: 0,
            lastAttemptAt: new Date().toISOString(),
          };
        }
      }
      delete raw.processedMessageIds;
    }

    return {
      messageStates: raw.messageStates,
      deadLetterIds: raw.deadLetterIds || [],
      lastStartedAt: raw.lastStartedAt,
      pendingConfirmation: raw.pendingConfirmation,
    } as AutoReplyState;
  } catch {
    return { messageStates: {}, deadLetterIds: [] };
  }
}

function saveState(statePath: string, state: AutoReplyState): void {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    const altPath = statePath.replace(".json", ".backup.json");
    try {
      writeFileSync(altPath, JSON.stringify(state, null, 2), "utf-8");
    } catch {
      // best effort
    }
  }
}

function savePendingReply(pendingPath: string, reply: PendingReply): void {
  appendFileSync(pendingPath, JSON.stringify(reply) + "\n", "utf-8");
}

async function safeMarkInboxRead(ids: string[], config: AutoReplyConfig): Promise<void> {
  if (ids.length === 0) return;
  const scriptPath = join(config.projectRoot, ".claude", "skills", "wechat-skill-2", "weixin-inbox.ps1");
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "ack", ...ids],
      {
        cwd: config.projectRoot,
        encoding: "utf-8",
        timeout: 30000,
        env: { ...process.env, BUN_UTF8: "1" },
      },
    );
    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      const stdout = (result.stdout || "").trim();
      throw new Error(stderr || stdout || `ack exited with code ${result.status}`);
    }
  } catch (e) {
    logLine(config, `markInboxRead failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
  }
}

function logLine(config: AutoReplyConfig, message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
}

function loadAccount(stateDir: string): AccountData {
  const accountPath = join(stateDir, "account.json");
  if (!existsSync(accountPath)) {
    throw new Error(`Missing Weixin account file: ${accountPath}`);
  }

  return JSON.parse(readFileSync(accountPath, "utf-8")) as AccountData;
}

async function importWeixinModules(pluginRoot: string) {
  const load = async <T>(relativePath: string): Promise<T> =>
    import(pathToFileURL(join(pluginRoot, relativePath)).href) as Promise<T>;

  const inbox = await load<{
    listInboxEntries(options?: { unreadOnly?: boolean; limit?: number }): InboxEntry[];
  }>("src/inbox.ts");
  const send = await load<{
    sendText(params: {
      to: string;
      text: string;
      baseUrl: string;
      token: string;
      contextToken: string;
    }): Promise<{ messageId: string }>;
    sendMediaFile(params: {
      filePath: string;
      to: string;
      text: string;
      baseUrl: string;
      token: string;
      contextToken: string;
      cdnBaseUrl: string;
    }): Promise<{ messageId: string }>;
  }>("src/send.ts");
  const apiMod = await load<{
    getConfig(baseUrl: string, token: string, userId: string, contextToken?: string): Promise<{ typing_ticket?: string }>;
    getUpdates(baseUrl: string, token: string, getUpdatesBuf: string, signal?: AbortSignal): Promise<{ ret: number; msgs?: unknown[]; get_updates_buf?: string }>;
  }>("src/api.ts");
  const accounts = await load<{
    CDN_BASE_URL: string;
  }>("src/accounts.ts");

  return { ...inbox, ...send, ...accounts, getConfig: apiMod.getConfig, getUpdates: apiMod.getUpdates };
}

function sanitizeReply(text: string): string {
  return text.replace(/\r/g, "").trim().replace(/\n{3,}/g, "\n\n").trim();
}

function shouldSkip(entry: InboxEntry): boolean {
  const text = entry.text.trim();
  return text.length === 0;
}

// --- Static system prompts (cached by API via --system-prompt) ---

const CLASSIFY_SYSTEM_PROMPT = [
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

const SAFE_EXECUTE_SYSTEM_PROMPT = [
  "可用工具：Glob（文件匹配）、Grep（内容搜索）、Read（读取文件）、Bash（Shell命令）、WebSearch（网络搜索）、WebFetch（读取网页）。",
  "执行完成后用简体中文简洁总结结果，必须输出合法JSON:",
  '  {"action":"executed","reply":"执行结果文本"}',
  "",
  "铁律：只输出一行合法JSON，绝不要任何额外文字。",
].join("\n");

const RISKY_EXECUTE_SYSTEM_PROMPT = [
  "可用工具：Glob（文件匹配）、Grep（内容搜索）、Read（读取文件）、Write（写入文件）、Bash（Shell命令）、WebSearch（网络搜索）、WebFetch（读取网页）。",
  "执行完成后用简体中文简洁输出结果，必须输出合法JSON:",
  '  {"action":"executed","reply":"执行结果文本"}',
  "",
  "铁律：只输出一行合法JSON，绝不要任何额外文字。",
].join("\n");

// --- Dynamic stdin messages (only user-specific text, changed per call) ---

function buildClassifyStdin(entry: InboxEntry): string {
  return `用户从微信发来消息："${entry.text}"`;
}

function buildSafeExecuteStdin(originalText: string): string {
  return `用户要求："${originalText}"。请使用可用工具完成这个请求。`;
}

function buildRiskyExecuteStdin(originalText: string, command: string): string {
  const action = command || originalText;
  return `用户要求："${originalText}"，已获得用户确认，请立即执行。\n具体操作：${action}`;
}

type ActionResult = { type: "chat" | "executed"; reply: string } | { type: "risky"; warning: string; command: string } | { type: "failed"; reason: string };

function callClaude(
  prompt: string,
  projectRoot: string,
  withTools: boolean,
  logLabel: string,
  config: AutoReplyConfig,
  systemPrompt?: string,
): { stdout: string; stderr: string; exitCode: number } {
  const timeoutMsRaw = Number.parseInt(process.env.API_TIMEOUT_MS || "", 10);
  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 120000;
  const claudeExecutable = resolveClaudeExecutable();
  const args: string[] = [
    "--permission-mode", "bypassPermissions",
    "--exclude-dynamic-system-prompt-sections",
  ];
  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }
  if (withTools) {
    args.push("--tools", "Bash,Read,Write,WebSearch,WebFetch,Glob,Grep");
  }

  let stdout: string;
  let stderr: string;
  let exitCode: number;

  try {
    const result = spawnSync(claudeExecutable, args, {
      encoding: "utf-8",
      cwd: projectRoot,
      timeout: timeoutMs,
      input: prompt,
      env: {
        ...process.env,
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL_WATCHER || "claude-haiku-4-5-20251001",
      },
    });
    stdout = (result.stdout || "").trim();
    stderr = (result.stderr || "").trim();
    exitCode = result.status ?? -1;

    if (result.error) {
      const errorMsg = result.error instanceof Error ? result.error.message : String(result.error);
      stderr = stderr ? `${stderr}\n${errorMsg}` : errorMsg;
      if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
        stderr = `claude timed out after ${timeoutMs}ms${stderr ? `\n${stderr}` : ""}`;
      }
    }

    if (stdout) {
      logLine(config, `${logLabel}: ${stdout.slice(0, 200)}`);
    }
    if (exitCode !== 0 || result.signal || result.error) {
      const stderrPreview = stderr ? stderr.slice(0, 200) : "(empty)";
      logLine(config, `${logLabel} bin=${claudeExecutable} exit=${exitCode} signal=${result.signal || "none"} stderr=${stderrPreview}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLine(config, `${logLabel} crash: ${msg}`);
    return { stdout: "", stderr: msg, exitCode: 1 };
  }

  return { stdout, stderr, exitCode };
}

function parseActionCandidate(candidate: unknown): ActionResult | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const parsed = candidate as Record<string, unknown>;
  if (parsed.action === "chat" && typeof parsed.reply === "string") {
    return { type: "chat", reply: sanitizeReply(parsed.reply) };
  }
  if (parsed.action === "executed" && typeof parsed.reply === "string") {
    return { type: "executed", reply: sanitizeReply(parsed.reply) };
  }
  if (parsed.action === "risky" && typeof parsed.warning === "string") {
    return { type: "risky", warning: parsed.warning, command: typeof parsed.command === "string" ? parsed.command : "" };
  }
  if (parsed.type === "result" && typeof parsed.result === "string") {
    return parseActionJson(parsed.result);
  }

  return null;
}

function parseActionJson(stdout: string): ActionResult | null {
  const raw = stdout.trim();
  if (!raw) return null;

  // Try pure JSON first, including Claude's {"type":"result","result":"..."} wrapper.
  try {
    const direct = parseActionCandidate(JSON.parse(raw));
    if (direct) {
      return direct;
    }
  } catch {
    // Not pure JSON, continue below.
  }

  const resultWrapperMatch = raw.match(/\{[\s\S]*?"type"\s*:\s*"result"[\s\S]*?\}/);
  if (resultWrapperMatch) {
    try {
      const wrapped = parseActionCandidate(JSON.parse(resultWrapperMatch[0]));
      if (wrapped) {
        return wrapped;
      }
    } catch {
      // Regex matched but wrapper JSON was malformed.
    }
  }

  const jsonMatch = raw.match(/\{[\s\S]*?"action"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const extracted = parseActionCandidate(JSON.parse(jsonMatch[0]));
      if (extracted) {
        return extracted;
      }
    } catch {
      // Regex matched but action JSON was malformed.
    }
  }

  // Fallback: treat non-JSON output as chat reply
  const cleaned = sanitizeReply(raw);
  if (cleaned) {
    return { type: "chat", reply: cleaned };
  }
  return null;
}

function getRiskyExecRetryReason(result: { stdout: string; stderr: string; exitCode: number }): "empty_stdout" | "timeout" | null {
  if (!result.stdout.trim() && result.exitCode === 0) {
    return "empty_stdout";
  }
  if (/ETIMEDOUT|timed out after \d+ms/i.test(result.stderr)) {
    return "timeout";
  }
  return null;
}

function extractSimpleDeleteTarget(text: string): string | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(?:请)?(?:准备)?删除(?:文件)?\s*([A-Za-z0-9._\-\\/]+?)(?:\s*文件)?$/i);
  return match?.[1] || null;
}

function resolveSafeProjectDeletePath(projectRoot: string, actionText: string): string | null {
  const target = extractSimpleDeleteTarget(actionText);
  if (!target) return null;
  if (/^[a-zA-Z]:/.test(target) || target.startsWith("/") || target.startsWith("\\")) {
    return null;
  }
  const normalizedTarget = target.replace(/[\\/]+/g, "\\");
  if (normalizedTarget.split("\\").some((segment) => segment === ".." || segment.length === 0)) {
    return null;
  }
  const resolved = resolve(projectRoot, normalizedTarget);
  const normalizedProjectRoot = normalize(projectRoot).toLowerCase();
  const normalizedResolved = normalize(resolved).toLowerCase();
  if (normalizedResolved !== normalizedProjectRoot && !normalizedResolved.startsWith(`${normalizedProjectRoot}\\`)) {
    return null;
  }
  return resolved;
}

function tryExecuteSimpleRiskyDelete(projectRoot: string, originalText: string, command: string): ActionResult | null {
  const actionText = command || originalText;
  const targetPath = resolveSafeProjectDeletePath(projectRoot, actionText) || resolveSafeProjectDeletePath(projectRoot, originalText);
  if (!targetPath) return null;
  const relativeDisplay = relative(projectRoot, targetPath).replace(/\\/g, "/") || targetPath;
  if (!existsSync(targetPath)) {
    return { type: "executed", reply: `文件 ${relativeDisplay} 不存在，无需删除。` };
  }
  try {
    rmSync(targetPath, { force: true });
    return { type: "executed", reply: `已在项目根目录删除文件 ${relativeDisplay}。` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { type: "failed", reason: `本地删除失败: ${message.slice(0, 120)}` };
  }
}

async function handleMessage(
  entry: InboxEntry,
  doSend: (params: { to: string; text: string; contextToken: string }) => Promise<boolean>,
  config: AutoReplyConfig,
  forceExecute?: { originalText: string; command: string },
): Promise<ActionResult> {
  const isRiskExec = !!forceExecute;

  // --- Risky-execute: user confirmed, execute directly with tools ---
  if (isRiskExec) {
    const localDelete = tryExecuteSimpleRiskyDelete(config.projectRoot, forceExecute.originalText, forceExecute.command);
    if (localDelete) {
      logLine(config, `RiskyExec local delete shortcut for ${entry.id}: ${forceExecute.command || forceExecute.originalText}`);
      return localDelete;
    }

    const riskyStdin = buildRiskyExecuteStdin(forceExecute.originalText, forceExecute.command);
    const label = `RiskyExec ${entry.id}`;
    logLine(config, `RiskyExec calling claude for ${entry.id}`);

    let result = callClaude(riskyStdin, config.projectRoot, true, label, config, RISKY_EXECUTE_SYSTEM_PROMPT);
    let action = parseActionJson(result.stdout);
    const retryReason = !action ? getRiskyExecRetryReason(result) : null;
    if (retryReason) {
      const retryDelayMs = retryReason === "timeout" ? 3000 : 2000;
      const retryNote = retryReason === "timeout"
        ? `${label} timeout detected, retrying once after ${Math.round(retryDelayMs / 1000)}s`
        : `${label} empty stdout (exit=0), retrying after ${Math.round(retryDelayMs / 1000)}s`;
      logLine(config, retryNote);
      await Bun.sleep(retryDelayMs);
      result = callClaude(riskyStdin, config.projectRoot, true, `${label} retry`, config, RISKY_EXECUTE_SYSTEM_PROMPT);
      action = parseActionJson(result.stdout);
    }

    if (action) {
      logLine(config, `RiskyExec parsed: action=${action.type}, reply=${(action as any).reply?.slice(0, 50) || 'N/A'}`);
      return action;
    }

    const cleaned = sanitizeReply(result.stdout);
    if (cleaned) return { type: "executed", reply: cleaned };

    if (result.exitCode !== 0 && result.stderr) {
      const brief = result.stderr.split("\n").filter(l => l.trim()).slice(0, 2).join(" | ");
      return { type: "failed", reason: `LLM调用失败(exit=${result.exitCode}): ${brief.slice(0, 100)}` };
    }
    return { type: "failed", reason: "无法解析执行结果" };
  }

  // --- Pass 1: classify intent WITHOUT tools ---
  const classifyStdin = buildClassifyStdin(entry);
  const classifyLabel = `Classify ${entry.id}`;
  logLine(config, `Classify calling claude for ${entry.id}`);

  let classifyResult = callClaude(classifyStdin, config.projectRoot, false, classifyLabel, config, CLASSIFY_SYSTEM_PROMPT);

  if (!classifyResult.stdout.trim() && classifyResult.exitCode === 0) {
    logLine(config, `${classifyLabel} empty stdout (exit=0), retrying after 2s`);
    await Bun.sleep(2000);
    classifyResult = callClaude(classifyStdin, config.projectRoot, false, `${classifyLabel} retry`, config, CLASSIFY_SYSTEM_PROMPT);
  }

  const action = parseActionJson(classifyResult.stdout);

  if (!action) {
    if (classifyResult.exitCode !== 0 && classifyResult.stderr) {
      const brief = classifyResult.stderr.split("\n").filter(l => l.trim()).slice(0, 2).join(" | ");
      return { type: "failed", reason: `LLM调用失败(exit=${classifyResult.exitCode}): ${brief.slice(0, 100)}` };
    }
    return { type: "failed", reason: "无法解析LLM输出" };
  }

  logLine(config, `Classify parsed: action=${action.type}, reply=${(action as any).reply?.slice(0, 50) || 'N/A'}`);

  // Chat: reply directly
  if (action.type === "chat") return action;

  // Risky: return for confirmation flow
  if (action.type === "risky") return action;

  // --- Pass 2: safe operation — execute WITH tools ---
  if (action.type === "executed") {
    const executeStdin = buildSafeExecuteStdin(entry.text);
    const executeLabel = `Execute ${entry.id}`;
    logLine(config, `Execute calling claude for ${entry.id}`);

    let execResult = callClaude(executeStdin, config.projectRoot, true, executeLabel, config, SAFE_EXECUTE_SYSTEM_PROMPT);

    if (!execResult.stdout.trim() && execResult.exitCode === 0) {
      logLine(config, `${executeLabel} empty stdout (exit=0), retrying after 2s`);
      await Bun.sleep(2000);
      execResult = callClaude(executeStdin, config.projectRoot, true, `${executeLabel} retry`, config, SAFE_EXECUTE_SYSTEM_PROMPT);
    }

    const execAction = parseActionJson(execResult.stdout);
    if (execAction && (execAction.type === "executed" || execAction.type === "chat")) {
      logLine(config, `Execute parsed: action=${execAction.type}`);
      return execAction;
    }

    const cleaned = sanitizeReply(execResult.stdout);
    if (cleaned) return { type: "executed", reply: cleaned };

    if (execResult.exitCode !== 0 && execResult.stderr) {
      const brief = execResult.stderr.split("\n").filter(l => l.trim()).slice(0, 2).join(" | ");
      return { type: "failed", reason: `执行失败(exit=${execResult.exitCode}): ${brief.slice(0, 100)}` };
    }
    return { type: "failed", reason: "无法解析执行结果" };
  }

  return { type: "failed", reason: "未知action类型" };
}

function isConfirmReply(text: string): boolean {
  return /^(是|好|可以|行|对|确认|ok|yes|y|对|没错|嗯|对的|是的)/i.test(text.trim());
}

function isDenyReply(text: string): boolean {
  return /^(不|否|别|取消|no|n|算了|不要)/i.test(text.trim());
}

async function warmupApiSession(
  account: AccountData,
  getUpdates: (baseUrl: string, token: string, getUpdatesBuf: string, signal?: AbortSignal) => Promise<{ ret: number }>,
  config: AutoReplyConfig,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await getUpdates(account.baseUrl, account.token, "", controller.signal);
    logLine(config, `API warmup getUpdates ret=${r.ret}`);
  } catch {
    // AbortError is expected
  } finally {
    clearTimeout(timeout);
  }
}

type SendTextFn = (params: { to: string; text: string; baseUrl: string; token: string; contextToken: string }) => Promise<{ messageId: string }>;

async function safeSendText(
  sendText: SendTextFn,
  account: AccountData,
  getUpdates: (baseUrl: string, token: string, getUpdatesBuf: string, signal?: AbortSignal) => Promise<{ ret: number }>,
  config: AutoReplyConfig,
  params: { to: string; text: string; contextToken: string },
  retries: number,
): Promise<boolean> {
  for (let i = 0; i <= retries; i++) {
    try {
      await sendText({
        to: params.to,
        text: params.text,
        baseUrl: account.baseUrl || "https://ilinkai.weixin.qq.com",
        token: account.token,
        contextToken: params.contextToken,
      });
      logLine(config, `Message sent: ${params.text.slice(0, 60)}`);
      return true;
    } catch (err) {
      logLine(config, `Send attempt ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (i < retries) {
        await warmupApiSession(account, getUpdates, config);
        await Bun.sleep(1000);
      }
    }
  }
  return false;
}

// --- State machine helpers ---

function advanceState(
  config: AutoReplyConfig,
  entryId: string,
  status: MessageLifecycle["status"],
  failCount?: number,
  cachedAction?: ActionResult,
): void {
  const state = loadState(config.statePath);
  state.messageStates[entryId] = {
    status,
    failCount: failCount ?? 0,
    lastAttemptAt: new Date().toISOString(),
    cachedAction,
  };
  saveState(config.statePath, state);
}

/** Finalize a classified message: send reply, or retry, or fallback. */
async function finalizeAction(
  config: AutoReplyConfig,
  entry: InboxEntry,
  action: ActionResult,
  wrappedSendText: (params: { to: string; text: string; contextToken: string }) => Promise<boolean>,
): Promise<void> {
  const state = loadState(config.statePath);
  const lifecycle = state.messageStates[entry.id];
  const failCount = lifecycle?.failCount ?? 0;

  if (action.type === "chat" || action.type === "executed") {
    const clipped = action.reply.length > 800 ? action.reply.slice(0, 800) + "..." : action.reply;
    const sent = await wrappedSendText({ to: entry.fromUserId, text: clipped, contextToken: entry.contextToken || "" });
    if (sent) {
      advanceState(config, entry.id, "replied", failCount);
      await safeMarkInboxRead([entry.id], config);
      logLine(config, `Sent ${action.type}: "${clipped.slice(0, 80)}"`);
    }
    return;
  }

  if (action.type === "risky") {
    const askMsg = `⚠️ ${action.warning}\n\n回复"是"确认执行，回复"不"取消。`;
    await wrappedSendText({ to: entry.fromUserId, text: askMsg, contextToken: entry.contextToken || "" });
    logLine(config, `Risk warn sent: "${action.warning.slice(0, 80)}"`);
    advanceState(config, entry.id, "replied", failCount, action);
    await safeMarkInboxRead([entry.id], config);
    saveState(config.statePath, {
      ...loadState(config.statePath),
      pendingConfirmation: {
        chatId: entry.fromUserId,
        contextToken: entry.contextToken || "",
        pendingAction: entry.text,
        askedAt: new Date().toISOString(),
        replyText: action.command,
        inboxId: entry.id,
      },
    });
    return;
  }

  // --- Failed: retry or fallback ---
  const newFailCount = failCount + 1;
  logLine(config, `Failed (attempt ${newFailCount}/${MAX_CLASSIFY_RETRIES}): ${action.reason}`);

  if (newFailCount <= MAX_CLASSIFY_RETRIES) {
    // Retry: reset to classifying so next poll picks it up
    advanceState(config, entry.id, "classifying", newFailCount);
    logLine(config, `Will retry ${entry.id} on next poll cycle`);
    return; // Don't mark inbox-read — message stays unread for retry
  }

  // Exhausted retries → send fallback chat reply
  const fallback = fallbackReply(entry.text);
  logLine(config, `Fallback for ${entry.id}: "${fallback.slice(0, 80)}"`);
  const sent = await wrappedSendText({ to: entry.fromUserId, text: fallback, contextToken: entry.contextToken || "" });
  if (sent) {
    advanceState(config, entry.id, "replied", newFailCount);
    await safeMarkInboxRead([entry.id], config);
  } else {
    // Can't even send fallback → dead letter
    advanceState(config, entry.id, "dead", newFailCount);
    await safeMarkInboxRead([entry.id], config);
    logLine(config, `Moving to dead-letter (send failed): ${entry.id}`);
    const newDead = [...(state.deadLetterIds || []), entry.id].slice(-200);
    saveState(config.statePath, { ...state, deadLetterIds: newDead });
  }
}

/** On startup, recover messages stuck in transient states (crash recovery). */
function recoverStaleStates(config: AutoReplyConfig): InboxEntry[] {
  const state = loadState(config.statePath);
  const now = Date.now();
  const staleIds: string[] = [];

  for (const [id, lifecycle] of Object.entries(state.messageStates)) {
    if (lifecycle.status === "replied" || lifecycle.status === "dead") continue;
    const elapsed = now - new Date(lifecycle.lastAttemptAt).getTime();
    if (elapsed > CLASSIFY_TTL_MS) {
      staleIds.push(id);
      logLine(config, `Recover stale: ${id} status=${lifecycle.status} elapsed=${Math.round(elapsed / 1000)}s`);
    }
  }

  if (staleIds.length === 0) return [];

  const allEntries = readInboxEntriesSync();
  return allEntries.filter((e: InboxEntry) => staleIds.includes(e.id));
}

/** Direct inbox.jsonl reader (synchronous — used for stale recovery during startup). */
function dedupeInboxEntries(entries: InboxEntry[]): InboxEntry[] {
  const seen = new Set<string>();
  const unique: InboxEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

function readInboxEntriesSync(): InboxEntry[] {
  const stateDir = resolveWeixinStateDir();
  const p = join(stateDir, "inbox.jsonl");
  if (!existsSync(p)) return [];
  return dedupeInboxEntries(readFileSync(p, "utf-8")
    .split("\n")
    .map((line: string) => line.trim())
    .filter(Boolean)
    .flatMap((line: string) => {
      try { return [JSON.parse(line) as InboxEntry]; } catch { return []; }
    }));
}

function rankUnreadEntry(entry: InboxEntry, state: AutoReplyState): number {
  const lifecycle = state.messageStates[entry.id];
  if (lifecycle && (lifecycle.status === "replied" || lifecycle.status === "dead")) {
    return 99;
  }

  const deadLetter = new Set(state.deadLetterIds || []);
  if (deadLetter.has(entry.id)) {
    return 99;
  }

  if (shouldSkip(entry)) {
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

async function processUnreadMessages(config: AutoReplyConfig): Promise<number> {
  if (processing) return 0;
  processing = true;

  try {
  const pluginRoot = resolveWeixinPluginRoot();
  const stateDir = resolveWeixinStateDir();
  const account = loadAccount(stateDir);

  let listInboxEntries: (opts?: { unreadOnly?: boolean; limit?: number }) => InboxEntry[];
  let sendText: any;
  let sendMediaFile: any;
  let CDN_BASE_URL: string;
  let getUpdates: any;

  for (let retry = 0; retry < 5; retry++) {
    try {
      const mods = await importWeixinModules(pluginRoot);
      listInboxEntries = mods.listInboxEntries;
      sendText = mods.sendText;
      sendMediaFile = mods.sendMediaFile;
      CDN_BASE_URL = mods.CDN_BASE_URL;
      getUpdates = mods.getUpdates;
      break;
    } catch (e) {
      if (retry < 4) {
        logLine(config, `importWeixinModules EPERM, retry ${retry + 1}/5`);
        await Bun.sleep(2000);
      } else {
        logLine(config, `importWeixinModules failed after 5 retries: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(2);
      }
    }
  }

  const wrappedSendText = (params: { to: string; text: string; contextToken: string }) =>
    safeSendText(sendText, account, getUpdates, config, params, 2);

  const state = loadState(config.statePath);

  // --- Stale-state recovery: retry messages stuck by a prior crash ---
  const staleEntries = recoverStaleStates(config);
  for (const entry of staleEntries) {
    const lifecycle = state.messageStates[entry.id];
    logLine(config, `Recovery retry: ${entry.id} status=${lifecycle.status} fail=${lifecycle.failCount}`);
    // If we have a cached action (classified before crash), send it directly
    if (lifecycle.cachedAction && (lifecycle.cachedAction.type === "chat" || lifecycle.cachedAction.type === "executed")) {
      const a = lifecycle.cachedAction;
      const clipped = a.reply.length > 800 ? a.reply.slice(0, 800) + "..." : a.reply;
      const sent = await wrappedSendText({ to: entry.fromUserId, text: clipped, contextToken: entry.contextToken || "" });
      if (sent) {
        advanceState(config, entry.id, "replied", lifecycle.failCount);
        await safeMarkInboxRead([entry.id], config);
        logLine(config, `Recovery sent cached: ${entry.id}`);
      }
      continue;
    }
    // Otherwise re-process from scratch
    advanceState(config, entry.id, "classifying", lifecycle.failCount);
    const action = await handleMessage(entry, wrappedSendText, config);
    await finalizeAction(config, entry, action, wrappedSendText);
  }

  let unreadEntries: InboxEntry[] = [];
  for (let retry = 0; retry < 3; retry++) {
    try {
      unreadEntries = dedupeInboxEntries(listInboxEntries({ unreadOnly: true, limit: 100 }).reverse());
      break;
    } catch (e) {
      if (retry < 2) {
        logLine(config, `listInboxEntries EPERM, retry ${retry + 1}/3`);
        await Bun.sleep(3000);
      } else {
        logLine(config, `listInboxEntries failed: ${e instanceof Error ? e.message : String(e)}`);
        return 0;
      }
    }
  }
  let replied = 0;
  const prioritizedEntries = unreadEntries
    .map((entry, index) => ({ entry, index, rank: rankUnreadEntry(entry, state) }))
    .filter((item) => item.rank < 99)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.entry);

  for (const entry of prioritizedEntries) {
    const currentState = loadState(config.statePath);
    const lifecycle = currentState.messageStates[entry.id];
    const deadLetter = new Set(currentState.deadLetterIds || []);
    const pc = currentState.pendingConfirmation;

    if (lifecycle && (lifecycle.status === "replied" || lifecycle.status === "dead")) {
      continue;
    }
    if (shouldSkip(entry)) {
      continue;
    }
    if (deadLetter.has(entry.id)) {
      logLine(config, `Skipping dead-letter: ${entry.id}`);
      advanceState(config, entry.id, "dead");
      continue;
    }

    // --- BRANCH A: Reply to a pending risky-confirmation ---
    if (pc && entry.fromUserId === pc.chatId) {
      if (entry.id === pc.inboxId) {
        logLine(config, `Ignoring original risky message while pending confirmation: ${entry.id}`);
        await safeMarkInboxRead([entry.id], config);
        continue;
      }

      if (isConfirmReply(entry.text)) {
        logLine(config, `Risk confirm YES for "${pc.pendingAction.slice(0, 60)}"`);

        const action = await handleMessage(entry, wrappedSendText, config, {
          originalText: pc.pendingAction,
          command: pc.replyText || pc.pendingAction,
        });

        if (action.type === "executed" || action.type === "chat") {
          const clipped = action.reply.length > 800 ? action.reply.slice(0, 800) + "..." : action.reply;
          await wrappedSendText({ to: entry.fromUserId, text: clipped, contextToken: entry.contextToken || pc.contextToken || "" });
          logLine(config, `Risk executed for ${pc.inboxId}: "${clipped.slice(0, 80)}"`);
        } else if (action.type === "failed") {
          await wrappedSendText({ to: entry.fromUserId, text: `执行失败：${action.reason}`, contextToken: entry.contextToken || "" });
        }

        advanceState(config, entry.id, "replied");
        await safeMarkInboxRead([entry.id], config);
        saveState(config.statePath, { ...loadState(config.statePath), pendingConfirmation: undefined });
        replied++;
        continue;
      }

      if (isDenyReply(entry.text)) {
        await wrappedSendText({ to: entry.fromUserId, text: "好的，已取消。", contextToken: entry.contextToken || "" });
        advanceState(config, entry.id, "replied");
        await safeMarkInboxRead([entry.id], config);
        saveState(config.statePath, { ...loadState(config.statePath), pendingConfirmation: undefined });
        replied++;
        logLine(config, `Risk deny for "${pc.pendingAction.slice(0, 60)}"`);
        continue;
      }

      // Not a confirm/deny — clear old pending, treat as new message
      logLine(config, `Non-confirm while risky-pending; treating as new request`);
      saveState(config.statePath, { ...currentState, pendingConfirmation: undefined });
    }

    // --- BRANCH B: New message → classify (state machine) ---
    if (lifecycle && lifecycle.status !== "replied" && lifecycle.status !== "dead") {
      logLine(config, `Retry deferred behind fresh messages: ${entry.id} status=${lifecycle.status} fail=${lifecycle.failCount}`);
    }
    logLine(config, `Processing: ${entry.id} text="${entry.text.slice(0, 80)}"`);

    // Mark as classifying BEFORE calling LLM — crash recovery can detect this
    advanceState(config, entry.id, "classifying");

    let action: ActionResult;
    try {
      action = await handleMessage(entry, wrappedSendText, config);
    } catch (e) {
      logLine(config, `handleMessage crash: ${e instanceof Error ? e.message : String(e)}`);
      action = { type: "failed", reason: "LLM调用异常" };
    }

    // Cache successful classification results in the state for crash recovery
    if (action.type === "chat" || action.type === "executed" || action.type === "risky") {
      advanceState(config, entry.id, "classified", 0, action);
    }

    await finalizeAction(config, entry, action, wrappedSendText);
    replied++;
    break; // ONE reply per poll cycle
  }

  const finalState = loadState(config.statePath);
  saveState(config.statePath, {
    messageStates: finalState.messageStates,
    deadLetterIds: finalState.deadLetterIds || [],
    pendingConfirmation: finalState.pendingConfirmation || undefined,
    lastStartedAt: state.lastStartedAt || new Date().toISOString(),
  });

  return replied;
  } finally {
    processing = false;
  }
}

async function main(): Promise<void> {
  const { projectRoot, once } = parseArgs();
  const claudeDir = join(projectRoot, ".claude");
  ensureDir(claudeDir);

  const config: AutoReplyConfig = {
    projectRoot,
    statePath: join(claudeDir, "wechat-auto-state.json"),
    pendingPath: join(claudeDir, "wechat-auto-pending.jsonl"),
    pollMs: DEFAULT_POLL_MS,
  };

  const initialState = loadState(config.statePath);
  if (!initialState.lastStartedAt) {
    saveState(config.statePath, {
      ...initialState,
      lastStartedAt: new Date().toISOString(),
    });
  }

  logLine(config, `Auto-reply watcher started in ${config.projectRoot}`);
  await Bun.sleep(5000); // Cooldown: wait for stale file locks to release

  const claudeCheck = spawnSync("claude", ["--version"], { encoding: "utf-8", timeout: 15000 });
  if (claudeCheck.status !== 0) {
    logLine(config, `claude CLI check failed (exit ${claudeCheck.status}), watcher cannot function, exiting`);
    process.exit(0);
  }
  logLine(config, `claude CLI available: ${claudeCheck.stdout.trim().slice(0, 80)}`);

  do {
    try {
      await processUnreadMessages(config);
    } catch (e) {
      logLine(config, `Poll cycle error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (once) {
      break;
    }
    await Bun.sleep(config.pollMs);
  } while (true);
}

await main();
