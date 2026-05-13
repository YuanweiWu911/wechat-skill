#!/usr/bin/env bun
// wechat-launcher.ts — One-click launcher, fully standalone.
// Start watcher + built-in HTTP server + open browser.
// NO external bun dependency needed at runtime.

import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
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
  if (!existsSync(PID_PATH)) return false;
  try {
    const raw = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) return false;
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf-8", timeout: 5000, windowsHide: true,
    });
    return r.stdout.includes(`"${pid}"`);
  } catch { return false; }
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

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method;

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
  if (!m) return text("Not found", 404);

  const route = m[1];

  // Status
  if (route === "status" && method === "GET") {
    const running = isWatcherRunning();
    const state = loadState();
    const pending = loadPending().filter((p: any) => p.status === "pending" || !p.status);
    return json({ running, message: running ? "Watcher 运行中" : "Watcher 已停止", pendingCount: pending.length });
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

  return text("Not found", 404);
}

// ═══════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════

async function main() {
  log("");

  // 1. Start watcher
  const watcherOk = await startWatcher();
  log(watcherOk ? "✓ Watcher: OK" : "⚠ Watcher: FAILED (continuing)");

  // 2. Start built-in HTTP server
  log("Starting built-in GUI server...");
  try {
    server = Bun.serve({
      port: PORT,
      fetch: handleRequest,
    });
    log(`✓ GUI server: http://localhost:${PORT}`);
  } catch (e: any) {
    log(`✗ GUI server failed: ${e.message}`);
    return;
  }

  // 3. Open browser
  log("Opening browser...");
  try {
    spawnSync("cmd.exe", ["/c", "start", "", `http://localhost:${PORT}`], { timeout: 8000, windowsHide: true });
    log("✓ Browser opened");
  } catch { log("⚠ Could not open browser"); }

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
