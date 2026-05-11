#!/usr/bin/env bun
// Usage: bun run wechat-approve-cli.ts [list|approve <id>|approve-all|reject <id>|count]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

process.stdout.setDefaultEncoding("utf-8");
process.stderr.setDefaultEncoding("utf-8");

interface PendingReply {
  id: string;
  inboxId: string;
  fromUserId: string;
  contextToken: string;
  originalText: string;
  replyText: string;
  rawOutput: string;
  status: "pending" | "approved" | "rejected" | "sent";
  createdAt: string;
}

const PENDING_PATH = join(process.cwd(), ".claude", "wechat-auto-pending.jsonl");

function loadReplies(): PendingReply[] {
  if (!existsSync(PENDING_PATH)) return [];
  const raw = readFileSync(PENDING_PATH, "utf-8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line) as PendingReply);
}

function saveReplies(replies: PendingReply[]): void {
  writeFileSync(PENDING_PATH, replies.map((r) => JSON.stringify(r)).join("\n") + (replies.length > 0 ? "\n" : ""), "utf-8");
}

const cmd = process.argv[2];

if (cmd === "list") {
  const replies = loadReplies();
  const active = replies.filter((r) => r.status !== "sent");
  if (active.length === 0) {
    process.stdout.write("No pending replies.\n");
  } else {
    let out = "";
    for (const r of active) {
      const statLabel = r.status === "approved" ? "[APPROVED]" : r.status === "rejected" ? "[REJECTED]" : "[PENDING]";
      out += `${statLabel} ${r.id}\n`;
      out += `  Original: ${r.originalText}\n`;
      out += `  Reply: ${r.replyText}\n`;
      out += `  Raw: ${r.rawOutput.slice(0, 200)}${r.rawOutput.length > 200 ? "..." : ""}\n`;
      out += "\n";
    }
    process.stdout.write(out);
  }
} else if (cmd === "approve") {
  const targetId = process.argv[3];
  if (!targetId) { process.stdout.write("Usage: approve <id>\n"); process.exit(1); }
  const replies = loadReplies();
  const found = replies.find((r) => r.id === targetId);
  if (!found) { process.stdout.write(`Not found: ${targetId}\n`); process.exit(1); }
  found.status = "approved";
  saveReplies(replies);
  process.stdout.write(`Approved: ${targetId}\nReply: ${found.replyText}\n`);
} else if (cmd === "approve-all") {
  const replies = loadReplies();
  let count = 0;
  for (const r of replies) { if (r.status === "pending") { r.status = "approved"; count++; } }
  saveReplies(replies);
  process.stdout.write(`Approved ${count} replies\n`);
} else if (cmd === "reject") {
  const targetId = process.argv[3];
  if (!targetId) { process.stdout.write("Usage: reject <id>\n"); process.exit(1); }
  const replies = loadReplies();
  const found = replies.find((r) => r.id === targetId);
  if (!found) { process.stdout.write(`Not found: ${targetId}\n`); process.exit(1); }
  found.status = "rejected";
  saveReplies(replies);
  process.stdout.write(`Rejected: ${targetId}\n`);
} else if (cmd === "count") {
  const replies = loadReplies();
  process.stdout.write(String(replies.filter((r) => r.status === "pending").length));
} else {
  process.stdout.write("Usage:\n  list\n  approve <id>\n  approve-all\n  reject <id>\n  count\n");
}
