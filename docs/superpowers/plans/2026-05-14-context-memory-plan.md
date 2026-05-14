# Context + Memory 升级实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 wechat-skill-2 引入会话上下文 (Session Context) 和用户记忆 (Memory)，采用三层缓存架构 (L0 指纹→L1 近层→L2 远层)，叠加到现有分类→回复链路，不破坏现有功能。

**Architecture:** 所有改动集中在 `wechat-auto-reply.ts`（~300 新行）。新增 Session/Memory 数据文件自动创建。CLASSIFY_SYSTEM_PROMPT 动态拼入 context+memory。Session 过期询问用户，Memory 仅在会话关闭时更新。

**Tech Stack:** Bun, TypeScript, Node.js fs/path/crypto (md5)

---

## 文件映射

| 文件 | 角色 |
|------|------|
| `.claude/hooks/wechat-auto-reply.ts` | modified: 所有新逻辑 |
| `.claude/wechat-sessions.jsonl` | created: Session 存储 |
| `.claude/wechat-session-cursor.json` | created: 活跃 session 索引 |
| `.claude/wechat-memory.json` | created: 用户记忆存储 |
| `.claude/wechat-memory-digest.txt` | created: L0 指纹缓存 |
| `.claude/skills/wechat-skill-2/SKILL.md` | modified: 更新能力描述 |
| `test-watcher.ts` | modified: 新增测试套件 |

---

### Task 1: 新数据模型 interfaces + 配置扩展

**Files:**
- Modify: `.claude/hooks/wechat-auto-reply.ts` (interfaces and config blocks)

- [ ] **Step 1: 在 `AutoReplyConfig` 接口中添加新路径字段**

修改文件 `.claude/hooks/wechat-auto-reply.ts`，在 `interface AutoReplyConfig` 的 `chatHistoryPath` 后添加：

```ts
interface AutoReplyConfig {
  projectRoot: string;
  statePath: string;
  pendingPath: string;
  cursorPath: string;
  chatHistoryPath: string;
  sessionPath: string;       // NEW
  sessionCursorPath: string; // NEW
  memoryPath: string;        // NEW
  memoryDigestPath: string;  // NEW
}
```

- [ ] **Step 2: 添加 Session 和 Memory 接口**

在 `interface AutoReplyConfig` 块之后，添加新接口：

```ts
interface Session {
  id: string;
  userId: string;
  startedAt: string;
  lastMessageAt: string;
  messageCount: number;
  summary: string;
  status: "active" | "closed";
  closedAt?: string;
  closingReason?: "timeout" | "reset" | "manual";
}

interface SessionCursor {
  [userId: string]: string;
}

interface UserMemory {
  userId: string;
  updatedAt: string;
  interests: string[];
  stats: {
    totalInteractions: number;
    firstSeenAt: string;
    lastSeenAt: string;
    activeHours: number[];
    topicsMentioned: Record<string, number>;
  };
  preferences: string[];
  profile: string;
  notes: string[];
}

interface UserMemoryMap {
  [userId: string]: UserMemory;
}
```

- [ ] **Step 3: 添加新常量**

在 `const DIRECT_SEND_ALLOWED_EXTENSIONS` 之后：

```ts
const SESSION_TTL_MS = 10 * 60 * 1000;  // 10 min
const MAX_WINDOW_MESSAGES = 20;
const MEMORY_L1_CHARS = 500;
const MAX_CONTEXT_CHARS = 800;
```

- [ ] **Step 4: 验证编译**

```powershell
bun run --print "1" .claude/hooks/wechat-auto-reply.ts
```

- [ ] **Step 5: Commit**

```bash
git add .claude/hooks/wechat-auto-reply.ts
git commit -m "feat: add Session/Memory interfaces and config fields"
```

---

### Task 2: Session 管理函数

**Files:**
- Modify: `.claude/hooks/wechat-auto-reply.ts`

- [ ] **Step 1: 写测试文件**

创建测试文件内容（稍后在 test-watcher.ts 中追加）：

```ts
// --- Session tests ---
function testCreateSession(): TestResult {
  const sid = createSession("test-user@wechat");
  if (!sid || !sid.startsWith("sess:test-user@wechat:")) return { name: "createSession", status: "FAIL", detail: "bad id: " + sid };
  if (!sessions[sid]) return { name: "createSession", status: "FAIL", detail: "session not stored" };
  if (sessions[sid].status !== "active") return { name: "createSession", status: "FAIL", detail: "not active" };
  return { name: "createSession", status: "PASS", detail: sid };
}

function testSessionExpired(): TestResult {
  const sid = createSession("test-user@wechat");
  sessions[sid].lastMessageAt = new Date(Date.now() - SESSION_TTL_MS - 60000).toISOString();
  const expired = isSessionExpired(sid);
  if (!expired) return { name: "sessionExpired", status: "FAIL", detail: "should be expired" };
  return { name: "sessionExpired", status: "PASS", detail: "detected" };
}

function testCloseSession(): TestResult {
  const sid = createSession("test-user@wechat");
  closeSession(sid, "reset");
  if (sessions[sid].status !== "closed") return { name: "closeSession", status: "FAIL", detail: "still active" };
  if (sessions[sid].closingReason !== "reset") return { name: "closeSession", status: "FAIL", detail: "wrong reason" };
  return { name: "closeSession", status: "PASS", detail: "closed" };
}

function testBuildSessionContext(): TestResult {
  const sid = createSession("test-user@wechat");
  addMessageToWindow(sid, "你好", "in");
  addMessageToWindow(sid, "你好呀，有什么可以帮你的？", "out");
  const ctx = buildSessionContext(sid);
  if (!ctx.includes("用户:")) return { name: "buildSessionContext", status: "FAIL", detail: "missing user label" };
  if (!ctx.includes("Bot:")) return { name: "buildSessionContext", status: "FAIL", detail: "missing bot label" };
  return { name: "buildSessionContext", status: "PASS", detail: "format ok" };
}
```

- [ ] **Step 2: 实现 Session 存储与加载函数**

在 `wechat-auto-reply.ts` 中，`function ensureDir` 之后添加：

```ts
// ======================== SESSION MANAGEMENT ========================
let sessions: Record<string, Session> = {};
let sessionCursor: SessionCursor = {};

function loadSessions(sessionPath: string): void {
  if (!existsSync(sessionPath)) return;
  try {
    const lines = readFileSync(sessionPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const s = JSON.parse(line) as Session;
      sessions[s.id] = s;
    }
  } catch { /* G3: degrade to empty */ }
}

function loadSessionCursor(cursorPath: string): void {
  if (!existsSync(cursorPath)) return;
  try {
    sessionCursor = JSON.parse(readFileSync(cursorPath, "utf-8"));
  } catch { /* G4: degrade */ }
}

function saveSessions(sessionPath: string): void {
  try {
    const lines = Object.values(sessions).map(s => JSON.stringify(s)).join("\n") + "\n";
    writeFileSync(sessionPath, lines, "utf-8");
  } catch { /* G5: disk full */ }
}
```

- [ ] **Step 3: 实现 Session CRUD**

继续在 Session 管理块：

```ts
function createSession(userId: string): string {
  const id = `sess:${userId}:${Date.now()}`;
  const now = new Date().toISOString();
  sessions[id] = {
    id, userId, startedAt: now, lastMessageAt: now,
    messageCount: 0, summary: "", status: "active",
  };
  sessionCursor[userId] = id;
  return id;
}

function getActiveSession(userId: string): Session | null {
  const sid = sessionCursor[userId];
  if (!sid || !sessions[sid] || sessions[sid].status !== "active") return null;
  return sessions[sid];
}

function isSessionExpired(sessionId: string): boolean {
  const s = sessions[sessionId];
  if (!s || s.status !== "active") return false;
  return Date.now() - new Date(s.lastMessageAt).getTime() > SESSION_TTL_MS;
}

function closeSession(sessionId: string, reason: Session["closingReason"]): void {
  const s = sessions[sessionId];
  if (!s) return;
  s.status = "closed";
  s.closedAt = new Date().toISOString();
  s.closingReason = reason;
}
```

- [ ] **Step 4: 实现消息窗口**

```ts
interface WindowMessage {
  text: string;
  direction: "in" | "out";
  time: string;
}

const messageWindows: Record<string, WindowMessage[]> = {};

function addMessageToWindow(sessionId: string, text: string, direction: "in" | "out"): void {
  if (!messageWindows[sessionId]) messageWindows[sessionId] = [];
  const w = messageWindows[sessionId];
  w.push({ text, direction, time: new Date().toISOString() });
  if (w.length > MAX_WINDOW_MESSAGES) w.shift();
  const s = sessions[sessionId];
  if (s) { s.messageCount++; s.lastMessageAt = new Date().toISOString(); }
}

function buildSessionContext(sessionId: string): string {
  const w = messageWindows[sessionId];
  if (!w || w.length === 0) return "";
  const recent = w.slice(-MAX_WINDOW_MESSAGES);
  const lines: string[] = [];
  for (const m of recent) {
    const label = m.direction === "in" ? "用户" : "Bot";
    const snippet = m.direction === "out" ? m.text.slice(0, 80) : m.text;
    lines.push(`${label}: ${snippet}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 5: 验证编译**

```powershell
bun run --print "1" .claude/hooks/wechat-auto-reply.ts
```

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks/wechat-auto-reply.ts
git commit -m "feat: add Session management functions"
```

---

### Task 3: Memory 管理与缓存

**Files:**
- Modify: `.claude/hooks/wechat-auto-reply.ts`

- [ ] **Step 1: 实现 Memory 加载与 L0 指纹**

在 Session 管理块之后：

```ts
// ======================== MEMORY MANAGEMENT ========================
let memoryMap: UserMemoryMap = {};
let memoryDigestCache: Record<string, string> = {};
let lastInjectedMemory: Record<string, string> = {};

function loadMemory(memoryPath: string): void {
  if (!existsSync(memoryPath)) return;
  try { memoryMap = JSON.parse(readFileSync(memoryPath, "utf-8")); }
  catch { /* G2 */ }
}

function loadMemoryDigest(digestPath: string): void {
  if (!existsSync(digestPath)) return;
  try {
    const lines = readFileSync(digestPath, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const [userId, hash] = line.split(" ");
      if (userId && hash) memoryDigestCache[userId] = hash;
    }
  } catch { /* G4 */ }
}

function saveMemory(memoryPath: string): void {
  try { writeFileSync(memoryPath, JSON.stringify(memoryMap), "utf-8"); }
  catch { /* G5 */ }
}

function saveMemoryDigest(digestPath: string): void {
  try {
    const lines = Object.entries(memoryDigestCache).map(([k, v]) => `${k} ${v}`).join("\n") + "\n";
    writeFileSync(digestPath, lines, "utf-8");
  } catch { /* G5 */ }
}
```

- [ ] **Step 2: 实现 L0 指纹和 L1 提取**

```ts
function computeMemoryHash(userId: string): string {
  const mem = memoryMap[userId];
  if (!mem) return "";
  const raw = JSON.stringify(mem);
  // Simple hash for Bun: use Bun.hash
  return Bun.hash(raw).toString(16);
}

function isMemoryDigestHit(userId: string): boolean {
  const current = computeMemoryHash(userId);
  if (!current) return false;
  return memoryDigestCache[userId] === current;
}

function buildMemoryContextL1(userId: string): string {
  const mem = memoryMap[userId];
  if (!mem) return "";
  const parts: string[] = [];
  if (mem.interests.length) parts.push(`兴趣: ${mem.interests.join(", ")}`);
  if (mem.profile) parts.push(`画像: ${mem.profile}`);
  if (mem.preferences.length) parts.push(`偏好: ${mem.preferences.join(", ")}`);
  if (mem.notes.length) parts.push(`备注: ${mem.notes.slice(-3).join("; ")}`);
  let ctx = parts.join("\n");
  if (ctx.length > MEMORY_L1_CHARS) ctx = ctx.slice(0, MEMORY_L1_CHARS - 3) + "...";
  return ctx;
}

function getMemoryContext(userId: string): string {
  if (isMemoryDigestHit(userId) && lastInjectedMemory[userId] !== undefined) {
    return lastInjectedMemory[userId];
  }
  const ctx = buildMemoryContextL1(userId);
  memoryDigestCache[userId] = computeMemoryHash(userId);
  lastInjectedMemory[userId] = ctx;
  return ctx;
}
```

- [ ] **Step 3: 确保内建空 Memory**

```ts
function ensureUserMemory(userId: string): void {
  if (!memoryMap[userId]) {
    memoryMap[userId] = {
      userId,
      updatedAt: new Date().toISOString(),
      interests: [],
      stats: { totalInteractions: 0, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), activeHours: [], topicsMentioned: {} },
      preferences: [],
      profile: "",
      notes: [],
    };
  }
}
```

- [ ] **Step 4: 添加 `MEMORY_UPDATE_PROMPT` 常量**

在 `CLASSIFY_SYSTEM_PROMPT` 附近：

```ts
const MEMORY_UPDATE_PROMPT = [
  "你是用户记忆管理器。根据本次会话摘要，更新用户记忆。只修改有变化的字段，不变字段保持原值。",
  "输出必须是合法 JSON，格式: {\"interests\": [...], \"stats\": {...}, \"preferences\": [...], \"profile\": \"...\", \"notes\": [...]}",
  "铁律：只输出 JSON，不要任何额外文字。",
].join("\n");
```

- [ ] **Step 5: 验证编译**

```powershell
bun run --print "1" .claude/hooks/wechat-auto-reply.ts
```

- [ ] **Step 6: Commit**

```bash
git add .claude/hooks/wechat-auto-reply.ts
git commit -m "feat: add Memory management with L0/L1 cache"
```

---

### Task 4: Context 注入 System Prompt

**Files:**
- Modify: `.claude/hooks/wechat-auto-reply.ts`

- [ ] **Step 1: 更新 `CLASSIFY_SYSTEM_PROMPT` 添加占位符**

修改 `CLASSIFY_SYSTEM_PROMPT` 数组，在原有规则之前添加 context 占位行：

找到现有的 `const CLASSIFY_SYSTEM_PROMPT = [...]`，在 `"分类规则："` 之后、`"纯闲聊"` 之前，插入动态占位部分的说明行。但更简洁的方式是：创建一个 **运行时构建 system prompt 的函数**。

```ts
function buildClassifySystemPrompt(sessionContext: string, memoryContext: string): string {
  const contextBlock = sessionContext
    ? `[会话上下文 - 最近消息]\n${sessionContext}\n`
    : "";
  const memoryBlock = memoryContext
    ? `[记忆 - 用户偏好]\n${memoryContext}\n`
    : "";
  const extra = contextBlock + memoryBlock;
  if (extra) return extra + "\n" + CLASSIFY_SYSTEM_PROMPT;
  return CLASSIFY_SYSTEM_PROMPT;
}
```

- [ ] **Step 2: 更新 `callClaude` 的调用点 — `handleMessage` 中 classify 调用**

修改 `callClaude` 传递动态 system prompt。当前 classify 调用在 `handleMessage` 中，需要把 `sessionContext` 和 `memoryContext` 传到 `handleMessage`。

最简单的改动：在 `handleIncomingMessage` 中构建 context 字符串，传给 `handleMessage` → 再传给 `callClaude`。但现有的 `handleMessage` 签名是 `(entry, wrappedSendText, config, forceExecute?)`。

最小侵入方案：在 `handleIncomingMessage` 中，**在调用 `handleMessage` 之前计算 context**，然后在 `handleMessage` 中把 context 注入到 classify stdin 的开头。或者更简单：**在 handleMessage 函数内部，从 entry.fromUserId 计算 context**。

在 `handleMessage` 函数中，找到 classify stdin 的构建部分（约 L870-L900），在 stdin 前面加上 context：

观察现有 classify stdin 构建：

```ts
const classifyStdin = [
  `Message: ${text}`,
].join("\n");
```

改为：

```ts
const sessionCtx = buildSessionContext(getActiveSession(entry.fromUserId)?.id || "");
const memoryCtx = getMemoryContext(entry.fromUserId);
const sysPrompt = buildClassifySystemPrompt(sessionCtx, memoryCtx);

const classifyStdin = [
  `Message: ${text}`,
].join("\n");
```

并将 `sysPrompt` 传给 `callClaude`（替换固定的 `CLASSIFY_SYSTEM_PROMPT`）：

```ts
let classifyResult = await callClaude(classifyStdin, config.projectRoot, false, classifyLabel, config, "classify", sysPrompt);
// retry
classifyResult = await callClaude(classifyStdin, config.projectRoot, false, `${classifyLabel} retry`, config, "classify", sysPrompt);
```

- [ ] **Step 3: 验证编译**

```powershell
bun run --print "1" .claude/hooks/wechat-auto-reply.ts
```

- [ ] **Step 4: Commit**

```bash
git add .claude/hooks/wechat-auto-reply.ts
git commit -m "feat: inject session+memory context into classify system prompt"
```

---

### Task 5: Session 生命周期集成 + 过期询问

**Files:**
- Modify: `.claude/hooks/wechat-auto-reply.ts`

- [ ] **Step 1: 在 `handleIncomingMessage` 开头集成 Session 管理**

修改 `handleIncomingMessage` 函数，在 `if (processing) return;` 之后、`try {` 之后，处理逻辑之后的第一部分：

```ts
try {
  // --- Session management ---
  ensureUserMemory(entry.fromUserId);
  let session = getActiveSession(entry.fromUserId);
  
  if (!session) {
    createSession(entry.fromUserId);
    session = getActiveSession(entry.fromUserId)!;
  } else if (isSessionExpired(session.id)) {
    // Ask user before auto-closing
    await wrappedSendText({
      to: entry.fromUserId,
      text: `之前的对话已中断（10分钟无互动）。要开启新的话题吗？回复"新"开始新会话，或直接继续当前话题。`,
      contextToken: entry.contextToken || "",
    });
    // Note: user response will come as next message, don't close now
    closeSession(session.id, "timeout");
    createSession(entry.fromUserId);
    session = getActiveSession(entry.fromUserId)!;
  }
  
  // Record message in window
  addMessageToWindow(session.id, entry.text, "in");
  // ... existing processing continues below
```
等等 — 过期询问需要更精巧的处理。如果用户正在说"那南京呢"（前指），直接关闭 session 会丢失上下文。更好的方式：

```ts
} else if (isSessionExpired(session.id)) {
  // Send inquiry and wait for user response in next message
  await wrappedSendText({
    to: entry.fromUserId,
    text: `之前的对话已中断（10分钟无互动）。回复"新"开始新话题，或直接继续。`,
    contextToken: entry.contextToken || "",
  });
  // Don't close yet — user's next message will determine
  // For this message, still use old session context
}
```

简化处理：过期时发送询问告知用户，但不关闭 session。在**下一条消息**检查：如果上一条是询问且用户回复"新"才关闭。否则视为继续。

更简单的实现：过期时自动关闭 + 告知用户已重置，因为问"继续还是新"需要额外的状态机。

按 spec 要求询问用户。实现方式：在 `messageStates` 中用一个特殊标记。

但为了最小化改动，采用更简单的方案：
- 过期时，发一条消息告知用户"之前的对话已中断，已开启新会话"
- 如果用户想继续旧话题，他们可以提及

这与 spec 的"询问用户意图"略有偏差，但实现简单很多。

**按照 spec 严格实现：** 过期时发询问但不关闭 session。用一个 session 内的 pending flag。

```ts
} else if (isSessionExpired(session.id)) {
  if (!session._expirePromptSent) {
    (session as any)._expirePromptSent = true;
    await wrappedSendText({
      to: entry.fromUserId,
      text: `之前的对话已中断（10分钟无互动）。回复"新"开启新话题，或直接输入继续。`,
      contextToken: entry.contextToken || "",
    });
    // Still use old session context for this message
  } else {
    // User already prompted — close old, create new
    closeSession(session.id, "timeout");
    createSession(entry.fromUserId);
    session = getActiveSession(entry.fromUserId)!;
  }
}
```

如果用户回复"新"：这个被现有的 chat classify 路径处理，但我们需要在 handleMessage 之前拦截。最简单的是在 session 管理之后，检查 `entry.text` 是否为"新"/"开始新会话"等：

```ts
// Check /new command
if (entry.text.trim() === "/new" || entry.text.trim() === "/reset" || entry.text.trim() === "新") {
  closeSession(session.id, "manual");
  const newSid = createSession(entry.fromUserId);
  addMessageToWindow(newSid, entry.text, "in");
  await wrappedSendText({
    to: entry.fromUserId,
    text: "已开始新对话。",
    contextToken: entry.contextToken || "",
  });
  advanceState(config, entry.id, "replied");
  return;
}
```

- [ ] **Step 2: 记录出站消息到窗口**

在 `handleIncomingMessage` 中，`finalizeAction` 或 `sendActionReply` 成功后，记录 Bot 回复：

在 `sendActionReply` 成功返回后（找到 `wrappedSendText` 调用的地方），添加 `addMessageToWindow(sessionId, replyText, "out")`。

由于 `handleIncomingMessage` 已持有 `session` 对象，在分类后的回复发送处添加：

在 `finalizeAction` 中的发送成功路径里，在 `wrappedSendText` 成功后：

```ts
const session = getActiveSession(entry.fromUserId);
if (session) addMessageToWindow(session.id, replyText, "out");
```

更具体地，在 `sendActionReply` 函数内部或调用点后添加。最简单的是在 `handleIncomingMessage` 中 `finalizeAction` 之后，因为那是唯一发送回复的出口。

- [ ] **Step 3: 验证编译**

```powershell
bun run --print "1" .claude/hooks/wechat-auto-reply.ts
```

- [ ] **Step 4: Commit**

```bash
git add .claude/hooks/wechat-auto-reply.ts
git commit -m "feat: integrate session lifecycle with expiration inquiry"
```

---

### Task 6: Memory 更新（会话关闭时）

**Files:**
- Modify: `.claude/hooks/wechat-auto-reply.ts`

- [ ] **Step 1: 实现 `updateMemoryOnSessionClose` 函数**

```ts
async function updateMemoryOnSessionClose(
  session: Session,
  config: AutoReplyConfig,
  wrappedSendText: (params: { to: string; text: string; contextToken: string }) => Promise<boolean>,
): Promise<void> {
  if (session.messageCount < 2) return; // Don't update for trivial sessions
  
  const windowMsgs = messageWindows[session.id] || [];
  const summaryInput = windowMsgs.map(m => {
    const label = m.direction === "in" ? "用户" : "Bot";
    return `${label}: ${m.text.slice(0, 100)}`;
  }).join("\n").slice(0, 800);
  
  ensureUserMemory(session.userId);
  const currentMem = JSON.stringify(memoryMap[session.userId]);
  
  const stdin = `以下为当前用户记忆（JSON）：\n${currentMem}\n\n以下为本次会话的对话摘要：\n${summaryInput}`;
  
  let result: { stdout: string };
  try {
    result = await callClaude(stdin, config.projectRoot, false, `memory ${session.id.slice(-8)}`, config, "memory", MEMORY_UPDATE_PROMPT);
  } catch {
    logLine(config, `Memory update LLM failed for ${session.userId}`);
    return;
  }
  
  try {
    const jsonStart = result.stdout.indexOf("{");
    const jsonEnd = result.stdout.lastIndexOf("}") + 1;
    if (jsonStart < 0 || jsonEnd <= jsonStart) return;
    const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd));
    
    const mem = memoryMap[session.userId];
    if (parsed.interests) mem.interests = [...new Set([...mem.interests, ...parsed.interests])].slice(-20);
    if (parsed.profile) mem.profile = parsed.profile;
    if (parsed.preferences) mem.preferences = [...new Set([...mem.preferences, ...parsed.preferences])].slice(-10);
    if (parsed.notes) mem.notes = parsed.notes.slice(-10);
    mem.stats.totalInteractions += session.messageCount;
    mem.stats.lastSeenAt = new Date().toISOString();
    mem.updatedAt = new Date().toISOString();
    
    // Update L0 digest
    memoryDigestCache[session.userId] = computeMemoryHash(session.userId);
    saveMemory(config.memoryPath);
    saveMemoryDigest(config.memoryDigestPath);
    
    logLine(config, `Memory updated for ${session.userId}`);
  } catch {
    logLine(config, `Memory JSON parse failed for ${session.userId}`);
  }
}
```

- [ ] **Step 2: 在会话关闭路径中调用**

找到 `closeSession` 的调用点（过期自动关闭和 `/new` 重置），在关闭后插入 memory 更新：

在 `/new` 处理块中：
```ts
await updateMemoryOnSessionClose(oldSession, config, wrappedSendText);
```

在 `handleIncomingMessage` 中过期自动关闭后：
```ts
await updateMemoryOnSessionClose(oldSession, config, wrappedSendText);
```

- [ ] **Step 3: 添加会话摘要生成到关闭**

```ts
function generateSessionSummary(sessionId: string): string {
  const msgs = messageWindows[sessionId] || [];
  if (msgs.length === 0) return "";
  const topics = new Set<string>();
  for (const m of msgs) {
    for (const kw of ["天气", "文件", "PDF", "图片", "查询", "安装", "读取", "搜索", "下载"]) {
      if (m.text.includes(kw)) topics.add(kw);
    }
  }
  const parts: string[] = [`${msgs.length} 条消息`];
  if (topics.size) parts.push(`话题: ${[...topics].join(", ")}`);
  return parts.join(", ");
}
```

在 `closeSession` 函数中设置 `session.summary`：

```ts
function closeSession(sessionId: string, reason: Session["closingReason"]): void {
  const s = sessions[sessionId];
  if (!s) return;
  s.summary = generateSessionSummary(sessionId);
  s.status = "closed";
  s.closedAt = new Date().toISOString();
  s.closingReason = reason;
}
```

- [ ] **Step 4: 验证编译**

```powershell
bun run --print "1" .claude/hooks/wechat-auto-reply.ts
```

- [ ] **Step 5: Commit**

```bash
git add .claude/hooks/wechat-auto-reply.ts
git commit -m "feat: implement memory update on session close"
```

---

### Task 7: main() 集成 — 配置文件路径 + 加载

**Files:**
- Modify: `.claude/hooks/wechat-auto-reply.ts`

- [ ] **Step 1: 在 `main()` 中设置新文件路径**

找到 `main()` 函数中的 `const config: AutoReplyConfig = {...}` 块（约 L1510），添加新路径：

```ts
const config: AutoReplyConfig = {
  projectRoot,
  statePath: join(claudeDir, "wechat-auto-state.json"),
  pendingPath: join(claudeDir, "wechat-auto-pending.jsonl"),
  cursorPath: join(claudeDir, "wechat-auto-cursor.txt"),
  chatHistoryPath: join(claudeDir, "chat-history.jsonl"),
  sessionPath: join(claudeDir, "wechat-sessions.jsonl"),
  sessionCursorPath: join(claudeDir, "wechat-session-cursor.json"),
  memoryPath: join(claudeDir, "wechat-memory.json"),
  memoryDigestPath: join(claudeDir, "wechat-memory-digest.txt"),
};
```

- [ ] **Step 2: 在 watcher 启动后加载 Session + Memory**

在 `main()` 中，`loadState` 调用之后：

```ts
loadSessions(config.sessionPath);
loadSessionCursor(config.sessionCursorPath);
loadMemory(config.memoryPath);
loadMemoryDigest(config.memoryDigestPath);
```

- [ ] **Step 3: 验证编译**

```powershell
bun run --print "1" .claude/hooks/wechat-auto-reply.ts
```

- [ ] **Step 4: Commit**

```bash
git add .claude/hooks/wechat-auto-reply.ts
git commit -m "feat: wire session/memory loading in main()"
```

---

### Task 8: 测试套件 + 端到端验证

**Files:**
- Modify: `test-watcher.ts`

- [ ] **Step 1: 在 test-watcher.ts 中添加 session 测试**

在 test-watcher.ts 末尾的 `allTests` 数组中追加：

```ts
  // Session tests
  { name: "createSession", fn: testCreateSession },
  { name: "sessionExpired", fn: testSessionExpired },
  { name: "closeSession", fn: testCloseSession },
  { name: "buildSessionContext", fn: testBuildSessionContext },
```

（test 函数已在 Task 2 Step 1 中定义）

- [ ] **Step 2: 运行测试**

```powershell
bun run test-watcher.ts session
```

- [ ] **Step 3: 终端到终端测试 — 启动 watcher 发消息**

重启 watcher，发送简单消息验证 context 是否工作：

```powershell
curl.exe -s -X POST http://localhost:3456/api/watcher/restart
```

然后通过微信发送两条相关消息（如"查天气"→"那南京呢"），观察回复是否有上下文感知。

- [ ] **Step 4: Commit**

```bash
git add test-watcher.ts
git commit -m "test: add session/memory test suite"
```

---

### Task 9: 更新 SKILL.md

**Files:**
- Modify: `.claude/skills/wechat-skill-2/SKILL.md`

- [ ] **Step 1: 更新能力描述**

在 SKILL.md 的"当前能力"部分，在"闲聊自动回复"之后添加：

```markdown
- **会话上下文记忆：** 支持多轮对话上下文，最近 20 条消息窗口；10 分钟无互动提示开启新会话
- **用户记忆：** 跨会话持久化用户兴趣、偏好、画像（会话结束时自动更新）；三级缓存节省 token
- **`/new` 命令：** 用户发送 `/new` 或 `新` 手动开启新会话
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/wechat-skill-2/SKILL.md
git commit -m "docs: update SKILL.md with context+memory capabilities"
```

---

### Task 10: 最终集成测试 + 重启 watcher

- [ ] **Step 1: 重启 watcher**

```powershell
curl.exe -s -X POST http://localhost:3456/api/watcher/restart
```

- [ ] **Step 2: 验证新文件创建**

```powershell
dir .claude/wechat-sessions.jsonl, .claude/wechat-session-cursor.json, .claude/wechat-memory.json, .claude/wechat-memory-digest.txt
```

- [ ] **Step 3: 发送测试消息**

通过微信发送"你好"，检查 watcher log：

```powershell
Get-Content .claude/wechat-launcher.log -Tail 20
```

确认 session/memory 日志正常。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final integration verification"
```

---

## 降级检查清单

在发布到生产环境前，确保以下降级场景能正常工作：

| 场景 | 验证方式 |
|------|---------|
| G2: memory.json 不存在 | 删除文件，重启 watcher，发消息 — 应正常工作 |
| G3: sessions.jsonl 损坏 | 写入无效 JSON，重启 watcher — 应正常降级 |
| L0 miss → L1 | 修改 memory.json 后发消息 — 应重新加载 |
| 分类主链路不被阻塞 | 模拟 LLM 调用失败 — 消息仍应被 fallback |
