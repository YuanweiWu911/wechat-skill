#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT_ROOT = resolve(import.meta.dir || process.cwd());
const CLAUDE_DIR = join(PROJECT_ROOT, ".claude");
const STATE_PATH = join(CLAUDE_DIR, "wechat-auto-state.json");
const PENDING_PATH = join(CLAUDE_DIR, "wechat-auto-pending.jsonl");
const HISTORY_PATH = join(CLAUDE_DIR, "chat-history.jsonl");
const CURSOR_PATH = join(CLAUDE_DIR, "wechat-auto-cursor.txt");
const PID_PATH = join(CLAUDE_DIR, "wechat-auto.pid");

const PORT = parseInt(process.env.GUI_PORT || "3456", 10);

const SKILL_DIR = join(PROJECT_ROOT, ".claude", "skills", "wechat-skill-2");
const COLLECT_PS1 = join(SKILL_DIR, "collect-wechat.ps1");
const STOP_PS1 = join(CLAUDE_DIR, "hooks", "stop-wechat-auto.ps1");
const START_PS1 = join(CLAUDE_DIR, "hooks", "start-wechat-auto.ps1");

function psRun(script: string, args: string[] = []): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(
    "powershell",
    [
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", script,
      ...args,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 30000,
      windowsHide: true,
      env: { ...process.env, BUN_UTF8: "1" },
    },
  );
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? -1,
  };
}

function isWatcherRunning(): boolean {
  return getWatcherPid() !== 0;
}

function getWatcherPid(): number {
  if (!existsSync(PID_PATH)) return 0;
  try {
    const pidRaw = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(pidRaw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return 0;

    const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    });
    if (result.status !== 0) return 0;
    return result.stdout.includes(`"${pid}"`) ? pid : 0;
  } catch {
    return 0;
  }
}

function readLines(filePath: string, maxLines = 500): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

interface PendingReply {
  id: string;
  inboxId?: string;
  fromUserId?: string;
  contextToken?: string;
  originalText?: string;
  text?: string;
  replyText?: string;
  rawOutput?: string;
  status?: string;
  createdAt?: string;
}

function loadPending(): PendingReply[] {
  const lines = readLines(PENDING_PATH, 200);
  return lines.map((l) => {
    try {
      return JSON.parse(l) as PendingReply;
    } catch {
      return null;
    }
  }).filter(Boolean) as PendingReply[];
}

interface StateJson {
  messageStates?: Record<string, any>;
  deadLetterIds?: string[];
  pendingConfirmation?: any;
  lastStartedAt?: string;
}

function loadState(): StateJson {
  if (!existsSync(STATE_PATH)) return { messageStates: {}, deadLetterIds: [] };
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { messageStates: {}, deadLetterIds: [] };
  }
}

interface ChatRecord {
  time?: string;
  direction?: string;
  from?: string;
  to?: string;
  fromUserId?: string;
  text?: string;
  file?: string;
  attachmentPath?: string;
  attachmentType?: string;
  attachmentName?: string;
  id?: string;
}

function loadHistory(): ChatRecord[] {
  const lines = readLines(HISTORY_PATH, 1000);
  return lines.map((l) => {
    try {
      return JSON.parse(l) as ChatRecord;
    } catch {
      return null;
    }
  }).filter(Boolean) as ChatRecord[];
}

function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function textResponse(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
  });
}

function htmlResponse(html: string, status = 200) {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
  });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  if (method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders() });
  }

  // --- Static file: serve the GUI HTML ---
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const htmlPath = join(PROJECT_ROOT, "wechat-skill-gui.html");
    if (!existsSync(htmlPath)) {
      return textResponse("GUI file not found. Create wechat-skill-gui.html in the project root.", 404);
    }
    const html = readFileSync(htmlPath, "utf-8");
    return htmlResponse(html);
  }

  // --- API routes ---
  const apiMatch = url.pathname.match(/^\/api\/(.+)/);

  // --- Media file serving ---
  const mediaMatch = url.pathname.match(/^\/media\/(.+)/);
  if (mediaMatch) {
    const mediaFile = join(PROJECT_ROOT, ".claude", "wechat-media", decodeURIComponent(mediaMatch[1]));
    if (!existsSync(mediaFile)) return textResponse("Not found", 404);
    const buf = readFileSync(mediaFile);
    const ext = mediaMatch[1].split(".").pop()?.toLowerCase() || "";
    const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
                   mp4: "video/mp4", mov: "video/quicktime",
                   pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                   xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                   txt: "text/plain", csv: "text/csv", json: "application/json",
                   silk: "audio/silk", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    }[ext] || "application/octet-stream";
    return new Response(buf, { headers: { "Content-Type": mime, ...corsHeaders() } });
  }

  if (!apiMatch) {
    return textResponse("Not found", 404);
  }

  const route = apiMatch[1];

  // GET /api/status
  if (route === "status" && method === "GET") {
    const running = isWatcherRunning();
    const pid = getWatcherPid();
    const state = loadState();
    const pendingItems = loadPending().filter((p) => p.status === "pending" || !p.status);
    return jsonResponse({
      running,
      pid,
      message: running ? "Watcher 运行中" : "Watcher 已停止",
      pidExists: existsSync(PID_PATH),
      pendingCount: pendingItems.length,
      lastStartedAt: state.lastStartedAt || null,
    });
  }

  // GET /api/check — lightweight change-detection for GUI polling
  if (route === "check" && method === "GET") {
    function mtime(path: string): number {
      try { return statSync(path).mtimeMs; } catch { return 0; }
    }
    return jsonResponse({
      history: mtime(HISTORY_PATH),
      state: mtime(STATE_PATH),
      pending: mtime(PENDING_PATH),
      watcher: isWatcherRunning(),
      pid: getWatcherPid(),
    });
  }

  // POST /api/watcher/start
  if (route === "watcher/start" && method === "POST") {
    if (isWatcherRunning()) {
      return jsonResponse({ success: true, message: "Watcher 已在运行中" });
    }
    const result = psRun(START_PS1);
    if (result.exitCode !== 0) {
      return jsonResponse({
        success: false,
        message: `启动失败 (exit=${result.exitCode})`,
        stderr: result.stderr.slice(0, 200),
      }, 500);
    }
    const running = isWatcherRunning();
    return jsonResponse({
      success: running,
      message: running ? "Watcher 已启动" : "启动可能未完成，请检查状态",
    });
  }

  // POST /api/watcher/stop
  if (route === "watcher/stop" && method === "POST") {
    if (!isWatcherRunning()) {
      return jsonResponse({ success: true, message: "Watcher 未在运行" });
    }
    const result = psRun(STOP_PS1);
    return jsonResponse({
      success: true,
      message: "Watcher 已停止",
      output: result.stdout.slice(0, 200),
    });
  }

  // POST /api/watcher/restart
  if (route === "watcher/restart" && method === "POST") {
    if (isWatcherRunning()) {
      psRun(STOP_PS1);
      await Bun.sleep(1000);
    }
    const result = psRun(START_PS1);
    const running = isWatcherRunning();
    return jsonResponse({
      success: running,
      message: running ? "Watcher 已重启" : "重启失败",
    });
  }

  // POST /api/watcher/poll
  if (route === "watcher/poll" && method === "POST") {
    const result = psRun(COLLECT_PS1, []);
    return jsonResponse({
      success: true,
      message: "消息轮询触发完成",
      output: result.stdout.slice(0, 200),
    });
  }

  // GET /api/state
  if (route === "state" && method === "GET") {
    const state = loadState();
    return jsonResponse(state);
  }

  // GET /api/history
  if (route === "history" && method === "GET") {
    const history = loadHistory();
    return jsonResponse(history);
  }

  // GET /api/history/search?q=keyword
  if (route === "history/search" && method === "GET") {
    const q = url.searchParams.get("q") || "";
    if (!q.trim()) return jsonResponse([]);
    const history = loadHistory();
    const lower = q.toLowerCase();
    const results = history.filter(
      (r) => (r.text || "").toLowerCase().includes(lower),
    ).slice(-100);
    return jsonResponse(results);
  }

  // GET /api/pending
  if (route === "pending" && method === "GET") {
    const items = loadPending().filter((p) => p.status === "pending" || !p.status);
    return jsonResponse({ count: items.length, items });
  }

  // POST /api/pending/approve/:id
  const approveMatch = route.match(/^pending\/approve\/(.+)$/);
  if (approveMatch && method === "POST") {
    const targetId = decodeURIComponent(approveMatch[1]);
    const all = loadPending();
    let found = false;
    for (const item of all) {
      if (item.id === targetId) {
        item.status = "approved";
        found = true;
        break;
      }
    }
    if (!found) return jsonResponse({ error: "Not found" }, 404);

    const content = all.map((p) => JSON.stringify(p)).join("\n") + "\n";
    try {
      writeFileSync(PENDING_PATH, content, "utf-8");
    } catch {}
    return jsonResponse({ success: true, message: `已批准 ${targetId}` });
  }

  // POST /api/pending/reject/:id
  const rejectMatch = route.match(/^pending\/reject\/(.+)$/);
  if (rejectMatch && method === "POST") {
    const targetId = decodeURIComponent(rejectMatch[1]);
    const all = loadPending();
    let found = false;
    for (const item of all) {
      if (item.id === targetId) {
        item.status = "rejected";
        found = true;
        break;
      }
    }
    if (!found) return jsonResponse({ error: "Not found" }, 404);

    const content = all.map((p) => JSON.stringify(p)).join("\n") + "\n";
    try {
      writeFileSync(PENDING_PATH, content, "utf-8");
    } catch {}
    return jsonResponse({ success: true, message: `已拒绝 ${targetId}` });
  }

  return textResponse("Not found", 404);
}

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
console.log(`  \x1b[36mWeChat Skill Control Center\x1b[0m`);
console.log(`  \x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
console.log(`  \x1b[37mURL:\x1b[0m  \x1b[4mhttp://localhost:${PORT}\x1b[0m`);
console.log(`  \x1b[37mPID:\x1b[0m  ${server.port}`);
console.log(`  \x1b[37mCWD:\x1b[0m  ${PROJECT_ROOT}`);
console.log(`  \x1b[90m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
console.log(`  \x1b[2mPress Ctrl+C to stop\x1b[0m`);
console.log(`\x1b[36m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m`);
