---
name: wechat-skill-2
description: 自动同步本地微信 inbox，导入消息上下文。后台 Watcher 会自动处理消息：闲聊直接回复、安全指令自动执行、项目内白名单文件可直发，创建/写入/删除等风险操作等待确认。
user-invocable: true
argument-hint: "[--start] [--stop] [--all] [--limit N]"
disable-model-invocation: true
---

# WeChat Skill 2.0

## 隐私与安全提示

使用本技能时请注意：微信消息将被导入 Claude 对话上下文并发送至 Anthropic API；消息以明文存储在本地 `~/.claude/channels/weixin/inbox.jsonl`；媒体文件下载到 `%TMP%/weixin-media/` 共享临时目录。

## 自动回复机制（Watcher 后台运行）

Watcher 通过 SessionStart 钩子（`start-wechat-auto.ps1`）在每次 Claude Code 会话启动时自动在后台运行，无需确认。

当用户在微信发消息时，Watcher 自动调用 LLM 分析语义并按以下路径处理：

### 路径 A：纯闲聊
用户说"你好"、"哈哈"等 → LLM 直接生成自然回复 → 通过微信发送 → 本轮结束。

### 路径 B：安全操作
用户要求查看文件、列出目录、搜索内容等 → LLM 用 Glob/LS/Read/Write 直接执行 → 将结果通过微信发送 → 本轮结束。
用户要求查询实时信息（天气、新闻、百科等）→ LLM 优先用 WebSearch/WebFetch 搜索 → 将结果通过微信发送 → 本轮结束。
用户要求发送项目内白名单文件（如 `CLAUDE.md`、`.claude/settings.local.json`）→ Watcher 直接发送附件 → 本轮结束。

安全操作示例：查看目录、搜索文件、读取内容、获取信息、查询天气、搜索网络、发送项目内白名单文件。

### 路径 C：风险操作
用户要求创建文件、写入文件、删除文件、修改系统、安装软件、执行脚本等 → Watcher 不直接执行，通过微信询问确认 → 用户回复"是"则执行 → 回复"不"则取消 → 本轮结束。

风险操作示例：创建文件、写入文件、删除文件、修改配置、安装程序、执行脚本。

## Watcher 当前行为

- 单实例运行：`start-wechat-auto.ps1` / `start-wechat-auto-runner.ps1` 会避免重复启动与互相抢占。
- 去重读取：Watcher 会对 `inbox.jsonl` 中重复的 message id 去重，避免重复恢复和重复回复。
- 风险确认稳定：原始风险消息不会在待确认期间清空 `pendingConfirmation`，用户回复"是" / "不"会优先命中确认分支。
- 风险执行兜底：对确认后的简单项目内文件删除（如 `删除test.txt`），Watcher 会优先在本地执行删除，避免受 Claude 工具沙箱限制影响。
- 文件传输：对项目内白名单单文件发送请求，Watcher 会优先本地发送附件，不再退化成“先读文件再摘要回复”。
- 大文件确认：白名单文件超过 `10MB` 时不会直接发送，而是先发起二次确认，用户回复"是"后再发送。
- 路径边界：当前文件发送按项目内相对路径精确匹配，例如 `将.claude/settings.local.json文件发给我` 可以命中，`将settings.local.json文件发给我` 当前不会自动补全路径。

## 行为契约

Claude 在参与 `wechat-skill-2` 的分类、执行、回复时，必须遵守以下契约：

### 1. 分类契约

- 每条消息只能落入 `chat`、`executed`、`risky` 这 3 条业务路径之一。
- 纯闲聊、问候、寒暄优先归类为 `chat`。
- 读取目录、搜索内容、读取文件、查询天气/网络信息等只读或查询类操作归类为 `executed`。
- 创建文件、写入文件、删除文件、执行脚本、安装软件、修改配置、修改系统状态等，必须归类为 `risky`，不得直接执行。

### 2. 风险确认契约

- 风险操作必须先发送确认提示，再等待用户回复。
- 用户回复 `是`、`好`、`可以`、`确认`、`yes` 等确认词时，优先解释为“确认执行”，不得回落到普通闲聊。
- 用户回复 `不`、`取消`、`no` 等拒绝词时，优先解释为“取消执行”。
- 在待确认期间，原始风险消息本身不得清空待确认状态，也不得被重新当成一条新请求处理。

### 3. 删除执行契约

- 对确认后的简单项目内文件删除请求，Watcher 可以直接在本地执行删除。
- 仅允许删除项目根目录内的相对路径文件。
- 包含绝对路径、盘符路径、根路径、`..` 越界路径的删除请求，不得走本地删除捷径。

### 4. 回复契约

- 每条消息最多触发一条主回复，不得在风险确认完成后再追加一条普通闲聊回复。
- 风险执行完成后，必须返回明确结果，例如“已创建”“已删除”“已取消”“执行失败”。
- 文件发送成功时，应返回明确发送结果，并通过微信附件链路发送文件，不得退化成只返回文件内容摘要。

### 5. 未读确认契约

- Watcher 不应在受限进程内直接写 `~/.claude/channels/weixin/inbox-state.json`。
- 标记消息已读必须通过 `weixin-inbox.ps1 ack` 完成，以规避 Trae 沙箱对插件状态目录写入的限制。

### 6. 文件传输契约

- 当前仅支持项目根目录内的白名单单文件发送：`.json`、`.md`、`.txt`、`.yaml`、`.yml`、`.log`、`.ts`、`.pdf`、`.docx`、`.pptx`、`.xlsx`。
- 仅允许相对路径，且不得包含绝对路径、盘符路径、根路径或 `..` 越界路径。
- 小于等于 `10MB` 的白名单文件可直接发送。
- 大于 `10MB` 的白名单文件必须先确认，再发送。

### 7. Start 入口契约

- `--start` 是 skill 入口层控制命令，命中后必须短路正常导入流程，不得透传给 `weixin-inbox.ps1 copy/export`。
- `--start` 只能单独使用，不得与其他参数混用。
- `/wechat-skill-2 --start` 只负责启动当前项目的后台 watcher，并立即退出。
- 仅当观察到当前项目 watcher 已在后台运行时，才返回启动成功。
- 默认 `/wechat-skill-2` 仍然只做 inbox 导入，不会隐式启动 watcher。

### 8. Stop 入口契约

- `--stop` 是 skill 入口层控制命令，命中后必须短路正常导入流程，不得透传给 `weixin-inbox.ps1 copy/export`。
- `--stop` 只能单独使用，不得与 `--all`、`--limit` 混用。
- `/wechat-skill-2 --stop` 只负责停止当前项目的后台 watcher，并立即退出。

## 你必须在每次调用后自动完成以下 3 步

### 第 1 步：导入微信消息

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/collect-wechat.ps1" <ARGUMENTS>
```

- `--start`：启动当前项目的后台 watcher，并直接退出，不导入微信消息
- `--stop`：停止当前项目的后台 watcher，并直接退出，不导入微信消息
- 默认：只处理未读消息
- `--all`：包含已读消息
- `--limit N`：限制导入条数

### 第 2 步：检查待处理风险确认（可选）

如果 Watcher 暂停、崩溃，或需手动审核风险操作：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/wechat-approve.ps1" list
```

每条包含：`[PENDING]` id, 原始消息, 拟回复文本, Raw 执行输出。

**审核标准：**
- **通过**：`rawOutput` 有实际执行痕迹（Bash 输出、文件列表、Read 内容）→ 批准
- **不通过**：`rawOutput` 只有聊天内容、或只说"好的"、"等下"等 → 拒绝，文案改写后再批准

**批准后必须立即用 MCP 发送：**

使用 `mcp__plugin_weixin_weixin__reply` 工具：

```
chat_id: <pending 条目中 fromUserId 的值>
text: <pending 条目中 replyText 的值，原样发送>
```

发送成功后，标记 pending 为已处理：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/wechat-approve.ps1" approve <pending-id>
```

### 第 3 步：展示结果

简短报告：导入了多少条消息，Watcher 已自动处理了多少条；如存在风险确认，说明是已自动发出确认还是仍待人工审核。

## 发送微信消息的方法

**唯一正确的方法：`mcp__plugin_weixin_weixin__reply`**

纯文本：
```
mcp__plugin_weixin_weixin__reply
  chat_id: o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat
  text: 回复内容
```

带附件：
```
mcp__plugin_weixin_weixin__reply
  chat_id: o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat
  text: 说明文字
  files: ["C:\\Users\\len\\ywwu_workspace\\claude_skill_learn\\figure\\1.jpg"]
```

- `files` 必须是绝对路径

## 常见用法

- `/wechat-skill-2 --start` — 启动后台 watcher 并立即退出
- `/wechat-skill-2 --stop` — 停止后台 watcher 并立即退出
- `/wechat-skill-2` — 导入未读 + 审核 + 发送
- `/wechat-skill-2 --limit 10` — 仅最近 10 条
- `/wechat-skill-2 --all --limit 20` — 包含已读
