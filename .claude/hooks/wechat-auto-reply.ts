#!/usr/bin/env bun

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

interface AutoReplyState {
  processedMessageIds: string[];
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

const FALLBACK_REPLY = "已收到你的消息，我会尽快继续处理。";
const DEFAULT_POLL_MS = 8000;

let processing = false;

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

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function loadState(statePath: string): AutoReplyState {
  if (!existsSync(statePath)) {
    return { processedMessageIds: [], deadLetterIds: [] };
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8")) as AutoReplyState;
  } catch {
    return { processedMessageIds: [], deadLetterIds: [] };
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

function safeMarkInboxRead(markInboxRead: (ids: string[]) => number, ids: string[], config: AutoReplyConfig): void {
  try {
    markInboxRead(ids);
  } catch (e) {
    logLine(config, `markInboxRead EPERM (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
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
    markInboxRead(ids: string[]): number;
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

interface MessageIntent {
  action: "chat" | "executed" | "risky";
  reply?: string;
  warning?: string;
  command?: string;
}

function buildUnifiedPrompt(entry: InboxEntry): string {
  return [
    `用户从微信发来消息："${entry.text}"`,
    "",
    "你是一个消息分类器。只分析意图并输出JSON，不要做任何其他事。",
    "",
    "分类规则：",
    "- 纯闲聊（打招呼、情感表达、简单问答等）→ 输出JSON:",
    '  {"action":"chat","reply":"你的自然回复"}',
    "- 安全操作（查看文件、搜索内容、读取信息、查询实时数据等）→ 输出JSON:",
    '  {"action":"executed","reply":"简述你准备做什么"}',
    "- 风险操作（删除文件、修改系统、安装软件、执行脚本等）→ 输出JSON:",
    '  {"action":"risky","warning":"风险说明","command":"操作简述"}',
    "",
    "铁律：",
    "- 只输出一行合法JSON，绝不要任何额外文字",
    "- 闲聊回复要自然亲切，用简体中文",
    "- 风险判断从严：涉及删、改、装、脚本字眼的都是风险",
  ].join("\n");
}

function buildSafeExecutePrompt(originalText: string): string {
  return [
    `用户要求："${originalText}"。请使用可用工具完成这个请求。`,
    "",
    "可用工具：Glob（文件匹配）、Grep（内容搜索）、Read（读取文件）、Bash（Shell命令）、WebSearch（网络搜索）、WebFetch（读取网页）。",
    "执行完成后用简体中文简洁总结结果，必须输出合法JSON:",
    '  {"action":"executed","reply":"执行结果文本"}',
    "",
    "铁律：只输出一行合法JSON，绝不要任何额外文字。",
  ].join("\n");
}

function buildRiskyExecutePrompt(originalText: string, command: string): string {
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

type ActionResult = { type: "chat" | "executed"; reply: string } | { type: "risky"; warning: string; command: string } | { type: "failed"; reason: string };

function callClaude(
  prompt: string,
  projectRoot: string,
  withTools: boolean,
  logLabel: string,
  config: AutoReplyConfig,
): { stdout: string; stderr: string; exitCode: number } {
  const args: string[] = [
    "-p", prompt,
    "--permission-mode", "bypassPermissions",
  ];
  if (withTools) {
    args.push("--tools", "Bash,Read,Write,WebSearch,WebFetch,Glob,Grep");
  }

  let stdout: string;
  let stderr: string;
  let exitCode: number;

  try {
    const result = spawnSync("claude", args, {
      encoding: "utf-8",
      cwd: projectRoot,
      timeout: 120000,
      env: {
        ...process.env,
        ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL_WATCHER || "claude-haiku-4-5-20251001",
      },
    });
    stdout = (result.stdout || "").trim();
    stderr = (result.stderr || "").trim();
    exitCode = result.status ?? -1;

    if (stdout) {
      logLine(config, `${logLabel}: ${stdout.slice(0, 200)}`);
    }
    if (exitCode !== 0 && stderr) {
      logLine(config, `${logLabel} stderr (exit=${exitCode}): ${stderr.slice(0, 200)}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logLine(config, `${logLabel} crash: ${msg}`);
    return { stdout: "", stderr: msg, exitCode: 1 };
  }

  return { stdout, stderr, exitCode };
}

function parseActionJson(stdout: string): ActionResult | null {
  const raw = stdout.trim();
  if (!raw) return null;

  // Try to parse the entire output as action JSON
  try {
    const parsed = JSON.parse(raw);
    if (parsed.action === "chat" && parsed.reply) {
      return { type: "chat", reply: sanitizeReply(parsed.reply) };
    }
    if (parsed.action === "executed" && parsed.reply) {
      return { type: "executed", reply: sanitizeReply(parsed.reply) };
    }
    if (parsed.action === "risky" && parsed.warning) {
      return { type: "risky", warning: parsed.warning, command: parsed.command || "" };
    }
  } catch {
    // Not pure JSON, try to extract a JSON object
  }

  // Try to find a JSON object with "action" field
  const jsonMatch = raw.match(/\{[\s\S]*?"action"[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.action === "chat" && parsed.reply) {
        return { type: "chat", reply: sanitizeReply(parsed.reply) };
      }
      if (parsed.action === "executed" && parsed.reply) {
        return { type: "executed", reply: sanitizeReply(parsed.reply) };
      }
      if (parsed.action === "risky" && parsed.warning) {
        return { type: "risky", warning: parsed.warning, command: parsed.command || "" };
      }
    } catch {
      // Regex match but not valid JSON
    }
  }

  // Fallback: treat non-JSON output as chat reply
  const cleaned = sanitizeReply(raw);
  if (cleaned) {
    return { type: "chat", reply: cleaned };
  }
  return null;
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
    const prompt = buildRiskyExecutePrompt(forceExecute.originalText, forceExecute.command);
    const label = `RiskyExec ${entry.id}`;
    logLine(config, `RiskyExec calling claude for ${entry.id}`);

    let result = callClaude(prompt, config.projectRoot, true, label, config);

    if (!result.stdout.trim() && result.exitCode === 0) {
      logLine(config, `${label} empty stdout (exit=0), retrying after 2s`);
      await Bun.sleep(2000);
      result = callClaude(prompt, config.projectRoot, true, `${label} retry`, config);
    }

    const action = parseActionJson(result.stdout);
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
  const classifyPrompt = buildUnifiedPrompt(entry);
  const classifyLabel = `Classify ${entry.id}`;
  logLine(config, `Classify calling claude for ${entry.id}`);

  let classifyResult = callClaude(classifyPrompt, config.projectRoot, false, classifyLabel, config);

  if (!classifyResult.stdout.trim() && classifyResult.exitCode === 0) {
    logLine(config, `${classifyLabel} empty stdout (exit=0), retrying after 2s`);
    await Bun.sleep(2000);
    classifyResult = callClaude(classifyPrompt, config.projectRoot, false, `${classifyLabel} retry`, config);
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
    const executePrompt = buildSafeExecutePrompt(entry.text);
    const executeLabel = `Execute ${entry.id}`;
    logLine(config, `Execute calling claude for ${entry.id}`);

    let execResult = callClaude(executePrompt, config.projectRoot, true, executeLabel, config);

    if (!execResult.stdout.trim() && execResult.exitCode === 0) {
      logLine(config, `${executeLabel} empty stdout (exit=0), retrying after 2s`);
      await Bun.sleep(2000);
      execResult = callClaude(executePrompt, config.projectRoot, true, `${executeLabel} retry`, config);
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

async function processUnreadMessages(config: AutoReplyConfig): Promise<number> {
  if (processing) return 0;
  processing = true;

  try {
  const pluginRoot = resolveWeixinPluginRoot();
  const stateDir = resolveWeixinStateDir();
  const account = loadAccount(stateDir);

  let listInboxEntries: (opts?: { unreadOnly?: boolean; limit?: number }) => InboxEntry[];
  let markInboxRead: (ids: string[]) => number;
  let sendText: any;
  let sendMediaFile: any;
  let CDN_BASE_URL: string;
  let getUpdates: any;

  for (let retry = 0; retry < 5; retry++) {
    try {
      const mods = await importWeixinModules(pluginRoot);
      listInboxEntries = mods.listInboxEntries;
      markInboxRead = mods.markInboxRead;
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
  const processed = new Set(state.processedMessageIds);

  let unreadEntries: InboxEntry[] = [];
  for (let retry = 0; retry < 3; retry++) {
    try {
      unreadEntries = listInboxEntries({ unreadOnly: true, limit: 100 }).reverse();
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

  for (const entry of unreadEntries) {
    if (processed.has(entry.id) || shouldSkip(entry)) {
      continue;
    }

    const currentState = loadState(config.statePath);
    const deadLetter = new Set(currentState.deadLetterIds || []);
    if (deadLetter.has(entry.id)) {
      logLine(config, `Skipping dead-letter: ${entry.id}`);
      processed.add(entry.id);
      continue;
    }
    const pc = currentState.pendingConfirmation;

    // --- BRANCH A: Reply to a pending risky-confirmation ---
    if (pc && entry.fromUserId === pc.chatId) {
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

        processed.add(entry.id);
        safeMarkInboxRead(markInboxRead, [entry.id], config);
        saveState(config.statePath, {
          ...currentState,
          processedMessageIds: Array.from(processed).slice(-1000),
          pendingConfirmation: undefined,
        });
        replied++;
        continue;
      }

      if (isDenyReply(entry.text)) {
        await wrappedSendText({ to: entry.fromUserId, text: "好的，已取消。", contextToken: entry.contextToken || "" });
        processed.add(entry.id);
        safeMarkInboxRead(markInboxRead, [entry.id], config);
        saveState(config.statePath, {
          ...currentState,
          processedMessageIds: Array.from(processed).slice(-1000),
          pendingConfirmation: undefined,
        });
        replied++;
        logLine(config, `Risk deny for "${pc.pendingAction.slice(0, 60)}"`);
        continue;
      }

      // Not a confirm/deny — clear old pending, treat as new message
      logLine(config, `Non-confirm while risky-pending; treating as new request`);
      saveState(config.statePath, {
        ...currentState,
        processedMessageIds: Array.from(processed).slice(-1000),
        pendingConfirmation: undefined,
      });
    }

    // --- BRANCH B: New message → analyze intent → act ---
    logLine(config, `Processing: ${entry.id} text="${entry.text.slice(0, 80)}"`);

    processed.add(entry.id);
    saveState(config.statePath, {
      ...currentState,
      processedMessageIds: Array.from(processed).slice(-1000),
      [`attempting:${entry.id}`]: new Date().toISOString(),
    } as any);

    let action: ActionResult;
    try {
      action = await handleMessage(entry, wrappedSendText, config);
    } catch (e) {
      logLine(config, `handleMessage crash: ${e instanceof Error ? e.message : String(e)}`);
      action = { type: "failed", reason: "LLM调用异常" };
    }

    if (action.type === "chat" || action.type === "executed") {
      const clipped = action.reply.length > 800 ? action.reply.slice(0, 800) + "..." : action.reply;
      await wrappedSendText({ to: entry.fromUserId, text: clipped, contextToken: entry.contextToken || "" });
      logLine(config, `Sent ${action.type}: "${clipped.slice(0, 80)}"`);
      processed.add(entry.id);
      safeMarkInboxRead(markInboxRead, [entry.id], config);
      saveState(config.statePath, {
        ...currentState,
        processedMessageIds: Array.from(processed).slice(-1000),
        lastStartedAt: new Date().toISOString(),
      });
      replied++;
      break; // ONE reply per poll cycle
    } else if (action.type === "risky") {
      const askMsg = `⚠️ ${action.warning}\n\n回复"是"确认执行，回复"不"取消。`;
      await wrappedSendText({ to: entry.fromUserId, text: askMsg, contextToken: entry.contextToken || "" });
      logLine(config, `Risk warn sent: "${action.warning.slice(0, 80)}"`);
      processed.add(entry.id);
      // Don't mark as read — keep pending for user confirmation
      saveState(config.statePath, {
        ...loadState(config.statePath),
        processedMessageIds: Array.from(processed).slice(-1000),
        pendingConfirmation: {
          chatId: entry.fromUserId,
          contextToken: entry.contextToken || "",
          pendingAction: entry.text,
          askedAt: new Date().toISOString(),
          replyText: action.command,
          inboxId: entry.id,
        },
      });
      replied++;
      continue;
    } else {
      if (!action.reason.includes("EPERM")) {
        const errMsg = `抱歉，处理失败：${action.reason}`;
        await wrappedSendText({ to: entry.fromUserId, text: errMsg, contextToken: entry.contextToken || "" });
      }
      logLine(config, `Failed: ${action.reason}`);

      const crashKey = `crash:${entry.id}`;
      const crashCount = (currentState as any)[crashKey] || 0;
      if (crashCount >= 3) {
        logLine(config, `Moving to dead-letter: ${entry.id}`);
        const newDead = [...(currentState.deadLetterIds || []), entry.id].slice(-200);
        saveState(config.statePath, {
          ...currentState,
          processedMessageIds: Array.from(processed).slice(-1000),
          deadLetterIds: newDead,
          lastStartedAt: new Date().toISOString(),
        });
        continue;
      }
      saveState(config.statePath, {
        ...currentState,
        processedMessageIds: Array.from(processed).slice(-1000),
        [crashKey]: crashCount + 1,
        lastStartedAt: new Date().toISOString(),
      } as any);
      processed.add(entry.id);
      safeMarkInboxRead(markInboxRead, [entry.id], config);
      replied++;
      break;
    }
  }

  const finalState = loadState(config.statePath);
  saveState(config.statePath, {
    processedMessageIds: Array.from(processed).slice(-1000),
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
