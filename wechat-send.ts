#!/usr/bin/env bun
// wechat-send.ts — Send a text message or file to a WeChat user.
// Usage:
//   bun run wechat-send.ts --to <userId> --text "message" [--context-token <token>]
//   bun run wechat-send.ts --to <userId> --file <path> [--text "caption"] [--context-token <token>]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const STATE_DIR = join(homedir(), ".claude", "channels", "weixin");

function parseArgs(): { to: string; text: string; file?: string; contextToken: string } {
  const args = process.argv.slice(2);
  let to = "", text = "", file = "", contextToken = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--to" && i + 1 < args.length) to = args[++i];
    else if (args[i] === "--text" && i + 1 < args.length) text = args[++i];
    else if (args[i] === "--file" && i + 1 < args.length) file = args[++i];
    else if (args[i] === "--context-token" && i + 1 < args.length) contextToken = args[++i];
  }
  if (!to) { console.error(JSON.stringify({ error: "Missing --to" })); process.exit(1); }
  if (!text && !file) { console.error(JSON.stringify({ error: "Missing --text or --file" })); process.exit(1); }
  return { to, text, file: file || undefined, contextToken };
}

function loadAccount() {
  const accountPath = join(STATE_DIR, "account.json");
  if (!existsSync(accountPath)) {
    console.error(JSON.stringify({ error: "account.json not found. Is cc-weixin plugin configured?" }));
    process.exit(1);
  }
  return JSON.parse(readFileSync(accountPath, "utf-8"));
}

async function importWeixinModules(pluginRoot: string) {
  const load = async <T>(relativePath: string): Promise<T> =>
    import(pathToFileURL(join(pluginRoot, relativePath)).href) as Promise<T>;

  const send = await load<{
    sendText(params: {
      to: string; text: string; baseUrl: string; token: string; contextToken: string;
    }): Promise<{ messageId: string }>;
    sendMediaFile(params: {
      filePath: string; to: string; text: string; baseUrl: string; token: string;
      contextToken: string; cdnBaseUrl: string;
    }): Promise<{ messageId: string }>;
  }>("src/send.ts");
  const accounts = await load<{ CDN_BASE_URL: string }>("src/accounts.ts");
  return { sendText: send.sendText, sendMediaFile: send.sendMediaFile, CDN_BASE_URL: accounts.CDN_BASE_URL };
}

function findPluginRoot(): string {
  const envRoot = process.env.WECHAT_PLUGIN_ROOT;
  if (envRoot && existsSync(envRoot)) return envRoot;

  const versionsRoot = join(homedir(), ".claude", "plugins", "cache", "cc-weixin", "weixin");
  if (!existsSync(versionsRoot)) {
    throw new Error(`Plugin not found at ${versionsRoot}`);
  }
  const candidates = readdirSync(versionsRoot)
    .map((name: string) => join(versionsRoot, name))
    .filter((p: string) => existsSync(join(p, "package.json")))
    .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));
  if (candidates.length === 0) throw new Error("No cc-weixin plugin version found");
  return candidates[0];
}

async function main() {
  const { to, text, file, contextToken } = parseArgs();
  const account = loadAccount();

  let pluginRoot: string;
  try {
    pluginRoot = findPluginRoot();
  } catch (e: any) {
    console.error(JSON.stringify({ error: `Plugin error: ${e.message}` }));
    process.exit(1);
  }

  try {
    const weixin = await importWeixinModules(pluginRoot);
    const baseUrl = account.baseUrl || "https://ilinkai.weixin.qq.com";
    const ctoken = contextToken || account.userId || "";

    if (file) {
      // Send file
      if (!existsSync(file)) {
        console.error(JSON.stringify({ error: `File not found: ${file}` }));
        process.exit(1);
      }
      const result = await weixin.sendMediaFile({
        filePath: resolve(file),
        to,
        text: text || "",
        baseUrl,
        token: account.token,
        contextToken: ctoken,
        cdnBaseUrl: weixin.CDN_BASE_URL || "https://cdn.weixin.qq.com",
      });
      console.log(JSON.stringify({ success: true, messageId: result.messageId }));
    } else {
      // Send text
      const result = await weixin.sendText({
        to,
        text,
        baseUrl,
        token: account.token,
        contextToken: ctoken,
      });
      console.log(JSON.stringify({ success: true, messageId: result.messageId }));
    }
  } catch (e: any) {
    console.error(JSON.stringify({ error: e.message || String(e) }));
    process.exit(1);
  }
}

main();
