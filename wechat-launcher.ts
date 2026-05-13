#!/usr/bin/env bun
// wechat-launcher.ts — One-click launcher, fully standalone.
// Start watcher + built-in HTTP server + open browser.
// NO external bun dependency needed at runtime.

import { existsSync, readFileSync, readdirSync, appendFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";

// ── Project root = directory of this exe ─────────────────
const PROJ = resolve(dirname(process.argv[0]));
const PORT = 3456;

const CLAUDE_DIR = join(PROJ, ".claude");
const SKILL_DIR = join(PROJ, ".claude", "skills", "wechat-skill-2");
const COLLECT_PS1 = join(SKILL_DIR, "collect-wechat.ps1");
const GUI_HTML = join(PROJ, "wechat-skill-gui.html");
const PID_PATH = join(CLAUDE_DIR, "wechat-auto.pid");
const STATE_PATH = join(CLAUDE_DIR, "wechat-auto-state.json");
const PENDING_PATH = join(CLAUDE_DIR, "wechat-auto-pending.jsonl");
const HISTORY_PATH = join(CLAUDE_DIR, "chat-history.jsonl");
const LOG_PATH = join(CLAUDE_DIR, "wechat-launcher.log");

let server: any = null;

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { appendFileSync(LOG_PATH, line + "\n", "utf-8"); } catch {}
  console.log(msg);
}

log(`========================================`);
log(`WeChat Skill Launcher v2`);
log(`PROJ=${PROJ}`);
log(`PID_PATH=${PID_PATH}`);

// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════

function isWatcherRunning(): boolean {
  return getWatcherPid() !== 0;
}

function getWatcherPid(): number {
  if (!existsSync(PID_PATH)) return 0;
  try {
    const raw = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return 0;
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf-8", timeout: 5000, windowsHide: true,
    });
    return r.stdout.includes(`"${pid}"`) ? pid : 0;
  } catch { return 0; }
}

function getDataVersions() {
  function mtime(path: string): number {
    try { return statSync(path).mtimeMs; } catch { return 0; }
  }
  return {
    history: mtime(HISTORY_PATH),
    state: mtime(STATE_PATH),
    pending: mtime(PENDING_PATH),
    watcher: isWatcherRunning(),
    pid: getWatcherPid(),
  };
}

function loadState(): any {
  if (!existsSync(STATE_PATH)) return { messageStates: {}, deadLetterIds: [] };
  try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")); }
  catch { return { messageStates: {}, deadLetterIds: [] }; }
}

function loadHistory(): any[] {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return readFileSync(HISTORY_PATH, "utf-8").split("\n").filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function loadPending(): any[] {
  if (!existsSync(PENDING_PATH)) return [];
  try {
    return readFileSync(PENDING_PATH, "utf-8").split("\n").filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function savePending(items: any[]) {
  const content = items.map(i => JSON.stringify(i)).join("\n") + "\n";
  try { writeFileSync(PENDING_PATH, content, "utf-8"); } catch {}
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
  };
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function text(t: string, status = 200) {
  return new Response(t, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...corsHeaders() },
  });
}

// ═══════════════════════════════════════════════════════
//  WATCHER
// ═══════════════════════════════════════════════════════

function startWatcher(): Promise<boolean> {
  return new Promise(resolve_ => {
    if (isWatcherRunning()) {
      log("Watcher already running");
      resolve_(true);
      return;
    }
    if (!existsSync(COLLECT_PS1)) {
      log(`COLLECT_PS1 not found at ${COLLECT_PS1}`);
      resolve_(false);
      return;
    }
    log("Starting watcher...");
    const proc = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", COLLECT_PS1, "--start",
    ], { cwd: PROJ, stdio: "pipe", windowsHide: true, env: { ...process.env, BUN_UTF8: "1" } });

    let stdout = "";
    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    const timer = setTimeout(() => { proc.kill(); log("Watcher start timed out"); resolve_(false); }, 15000);
    proc.on("close", code => {
      clearTimeout(timer);
      const r = isWatcherRunning();
      if (r) { log("Watcher started"); resolve_(true); }
      else { log(`Watcher failed exit=${code}: ${stdout.trim().slice(0,200)}`); resolve_(false); }
    });
    proc.on("error", e => { clearTimeout(timer); log(`Watcher error: ${e.message}`); resolve_(false); });
  });
}

// ═══════════════════════════════════════════════════════
//  HTTP SERVER (fully inline, no external bun needed)
// ═══════════════════════════════════════════════════════

function findBun(): string {
  const result = spawnSync("where.exe", ["bun"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t && existsSync(t)) {
      if (t.toLowerCase().endsWith(".exe")) return t;
      if (t.toLowerCase().endsWith(".cmd")) return t;
    }
  }
  return "bun.exe";
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

  // ── Resolve bun once per request for send APIs
  const bunPath = findBun();
  const useCmd = bunPath.toLowerCase().endsWith(".cmd");

  if (method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  // Serve GUI HTML
  if (url.pathname === "/" || url.pathname === "/index.html") {
    if (!existsSync(GUI_HTML)) return text("GUI HTML not found", 404);
    const html = readFileSync(GUI_HTML, "utf-8");
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
    });
  }

  const m = url.pathname.match(/^\/api\/(.+)/);

  // Media file serving
  const mediaMatch = url.pathname.match(/^\/media\/(.+)/);
  if (mediaMatch) {
    const mediaDir = join(PROJ, ".claude", "wechat-media");
    const mediaFile = join(mediaDir, decodeURIComponent(mediaMatch[1]));
    if (!existsSync(mediaFile)) return text("Not found", 404);
    const buf = readFileSync(mediaFile);
    const ext = mediaMatch[1].split(".").pop()?.toLowerCase() || "";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
      mp4: "video/mp4", mov: "video/quicktime",
      pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      txt: "text/plain", csv: "text/csv", json: "application/json",
      silk: "audio/silk", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
    };
    const mime = mimeMap[ext] || "application/octet-stream";
    return new Response(buf, { headers: { "Content-Type": mime, ...corsHeaders() } });
  }

  if (!m) return text("Not found", 404);

  const route = m[1];

  // Status
  if (route === "status" && method === "GET") {
    const pid = getWatcherPid();
    const running = pid !== 0;
    const state = loadState();
    const pending = loadPending().filter((p: any) => p.status === "pending" || !p.status);
    return json({ running, pid, message: running ? "Watcher 运行中" : "Watcher 已停止", pendingCount: pending.length });
  }

  // Watcher control
  if (route === "watcher/start" && method === "POST") {
    if (isWatcherRunning()) return json({ success: true, message: "Watcher 已在运行中" });
    const ok = await startWatcher();
    return json({ success: ok, message: ok ? "Watcher 已启动" : "启动失败" });
  }
  if (route === "watcher/stop" && method === "POST") {
    const r = spawnSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(CLAUDE_DIR, "hooks", "stop-wechat-auto.ps1"),
    ], { cwd: PROJ, encoding: "utf-8", timeout: 15000, windowsHide: true });
    return json({ success: true, message: "Watcher 已停止" });
  }
  if (route === "watcher/restart" && method === "POST") {
    spawnSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(CLAUDE_DIR, "hooks", "stop-wechat-auto.ps1"),
    ], { cwd: PROJ, timeout: 10000, windowsHide: true });
    const ok = await startWatcher();
    return json({ success: ok, message: ok ? "Watcher 已重启" : "重启失败" });
  }
  if (route === "watcher/poll" && method === "POST") {
    const r = spawnSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", COLLECT_PS1,
    ], { cwd: PROJ, encoding: "utf-8", timeout: 15000, windowsHide: true });
    return json({ success: true, message: "已触发轮询" });
  }

  // Lightweight change-detection for GUI polling
  if (route === "check" && method === "GET") return json(getDataVersions());

  // Data
  if (route === "state" && method === "GET") return json(loadState());
  if (route === "history" && method === "GET") return json(loadHistory());

  if (route === "history/search" && method === "GET") {
    const q = url.searchParams.get("q") || "";
    if (!q.trim()) return json([]);
    const lower = q.toLowerCase();
    return json(loadHistory().filter((r: any) => (r.text || "").toLowerCase().includes(lower)).slice(-100));
  }

  if (route === "pending" && method === "GET") {
    const items = loadPending().filter((p: any) => p.status === "pending" || !p.status);
    return json({ count: items.length, items });
  }

  const approveMatch = route.match(/^pending\/approve\/(.+)$/);
  if (approveMatch && method === "POST") {
    const id = decodeURIComponent(approveMatch[1]);
    const all = loadPending();
    let found = false;
    for (const item of all) { if (item.id === id) { item.status = "approved"; found = true; break; } }
    if (!found) return json({ error: "Not found" }, 404);
    savePending(all);
    return json({ success: true, message: `已批准 ${id}` });
  }

  const rejectMatch = route.match(/^pending\/reject\/(.+)$/);
  if (rejectMatch && method === "POST") {
    const id = decodeURIComponent(rejectMatch[1]);
    const all = loadPending();
    let found = false;
    for (const item of all) { if (item.id === id) { item.status = "rejected"; found = true; break; } }
    if (!found) return json({ error: "Not found" }, 404);
    savePending(all);
    return json({ success: true, message: `已拒绝 ${id}` });
  }

  // POST /api/send — send text message to WeChat user
  if (route === "send" && method === "POST") {
    try {
      const body = await req.json();
      const { to, text } = body;
      if (!to || !text) return json({ error: "Missing to or text" }, 400);

      const sendScript = join(PROJ, "wechat-send.ts");
      if (!existsSync(sendScript)) return json({ error: "wechat-send.ts not found" }, 500);

      const spawnBin = useCmd ? "cmd.exe" : bunPath;
      const spawnArgs = useCmd
        ? ["/c", bunPath, "run", sendScript, "--to", to, "--text", text]
        : ["run", sendScript, "--to", to, "--text", text];

      const r = spawnSync(spawnBin, spawnArgs, {
        cwd: PROJ, encoding: "utf-8", timeout: 30000, windowsHide: true,
        env: { ...process.env, BUN_UTF8: "1" },
      });

      const stdout = (r.stdout || "").trim();

      if (stdout) {
        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            const record = { time: new Date().toISOString(), direction: "out" as const, to, text };
            try { appendFileSync(HISTORY_PATH, JSON.stringify(record) + "\n", "utf-8"); } catch {}
            return json({ success: true, messageId: result.messageId });
          }
          return json({ success: false, error: result.error || "send failed" }, 500);
        } catch {}
      }

      const err = (r.stderr || stdout || "").trim();
      log(`Send API: bun exit=${r.exitCode} error=${err.slice(0,200)}`);
      return json({ success: false, error: err || `bun exited with code ${r.exitCode}` }, 500);
    } catch (e: any) {
      return json({ success: false, error: e.message }, 500);
    }
  }

  // POST /api/send/file — send file to WeChat user
  if (route === "send/file" && method === "POST") {
    try {
      const formData = await req.formData();
      const to = formData.get("to")?.toString() || "";
      const text = formData.get("text")?.toString() || "";
      const file = formData.get("file");
      if (!to || !file) return json({ error: "Missing to or file" }, 400);

      const fileName = (file as any).name || "file";
      const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : "";

      const tmpFile = join(PROJ, ".claude", `wechat-send-tmp-${Date.now()}${ext}`);
      const buf = await file.arrayBuffer();
      writeFileSync(tmpFile, Buffer.from(buf));

      const sendScript = join(PROJ, "wechat-send.ts");
      if (!existsSync(sendScript)) {
        try { rmSync(tmpFile); } catch {}
        return json({ error: "wechat-send.ts not found" }, 500);
      }

      const spawnArgs = useCmd
        ? ["/c", bunPath, "run", sendScript, "--to", to, "--file", tmpFile]
        : ["run", sendScript, "--to", to, "--file", tmpFile];
      if (text) spawnArgs.push("--text", text);
      const spawnBin = useCmd ? "cmd.exe" : bunPath;

      const r = spawnSync(spawnBin, spawnArgs, {
        cwd: PROJ, encoding: "utf-8", timeout: 60000, windowsHide: true,
        env: { ...process.env, BUN_UTF8: "1" },
      });

      try { rmSync(tmpFile); } catch {}

      const stdout = (r.stdout || "").trim();

      if (stdout) {
        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            const record = { time: new Date().toISOString(), direction: "out" as const, to, text, file: fileName };
            try { appendFileSync(HISTORY_PATH, JSON.stringify(record) + "\n", "utf-8"); } catch {}
            return json({ success: true, messageId: result.messageId, fileName });
          }
          return json({ success: false, error: result.error || "send failed" }, 500);
        } catch {}
      }

      const err = (r.stderr || stdout || "").trim();
      log(`Send file API: bun exit=${r.exitCode} error=${err.slice(0,200)}`);
      return json({ success: false, error: err || `bun exited with code ${r.exitCode}` }, 500);
    } catch (e: any) {
      return json({ success: false, error: e.message }, 500);
    }
  }

  return text("Not found", 404);
}

// ═══════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);

  // No args (double-click): launch system tray and exit
  if (args.length === 0) {
    const trayExe = join(PROJ, ".claude", "hooks", "wechat-tray.exe");
    if (!existsSync(trayExe)) {
      log("Tray exe not found, falling back to console mode");
      log("Compile it: \"$env:windir\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe\" /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:.claude\\hooks\\wechat-tray.exe .claude\\hooks\\wechat-tray.cs");
      // Fall through to console mode
    } else {
      log("Starting in tray mode (background + notification icon)...");
      const child = spawn(trayExe, ["-ProjectRoot", PROJ], {
        cwd: PROJ,
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
      child.unref();
      log("Tray mode active, this window will close now.");
      process.exit(0);
    }
  }

  // --tray mode: explicit tray launch (same as no-args)
  if (args.includes("--tray")) {
    const trayExe = join(PROJ, ".claude", "hooks", "wechat-tray.exe");
    if (!existsSync(trayExe)) {
      log(`Tray exe not found: ${trayExe}`);
      log(`Compile it first with:`);
      log(`  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:.claude\\hooks\\wechat-tray.exe .claude\\hooks\\wechat-tray.cs`);
      process.exit(1);
    }
    log("Launching system tray...");
    const child = spawn(trayExe, ["-ProjectRoot", PROJ], {
      cwd: PROJ,
      stdio: "ignore",
      windowsHide: true,
      detached: true,
    });
    child.unref();
    log("Tray launched (PID: " + child.pid + ")");
    process.exit(0);
  }

  // --hidden mode: used by tray script, no logs to console
  const hidden = args.includes("--hidden");

  if (!hidden) log("");

  // 1. Start watcher
  const watcherOk = await startWatcher();
  if (!hidden) log(watcherOk ? "✓ Watcher: OK" : "⚠ Watcher: FAILED (continuing)");

  // 2. Start built-in HTTP server
  if (!hidden) log("Starting built-in GUI server...");

  // Clean stale temp files from previous runs
  try {
    for (const entry of readdirSync(join(PROJ, ".claude")).filter(f => f.startsWith("wechat-send-tmp-"))) {
      try { rmSync(join(PROJ, ".claude", entry)); } catch {}
    }
  } catch {}

  try {
    server = Bun.serve({
      port: PORT,
      fetch: handleRequest,
    });
    if (!hidden) log(`✓ GUI server: http://localhost:${PORT}`);
  } catch (e: any) {
    log(`✗ GUI server failed: ${e.message}`);
    return;
  }

  // 3. Open browser (only in non-hidden mode)
  if (!hidden) {
    log("Opening browser...");
    try {
      spawnSync("cmd.exe", ["/c", "start", "", `http://localhost:${PORT}`], { timeout: 8000, windowsHide: true });
      log("✓ Browser opened");
    } catch { log("⚠ Could not open browser"); }
  }

  log("");
  log("========================================");
  log("  ALL SYSTEMS READY");
  log(`  GUI: http://localhost:${PORT}`);
  log("  Close this window to stop");
  log("========================================");

  await new Promise(() => {});
}

main().catch(e => { log(`FATAL: ${e.message}`); });

process.on("SIGINT", () => { log("Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { log("Shutting down..."); process.exit(0); });
