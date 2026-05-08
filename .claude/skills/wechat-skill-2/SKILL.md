---
name: wechat-skill-2
description: 自动同步本地微信 inbox，导入消息上下文。后台 Watcher 会自动处理消息：闲聊直接回复、安全指令自动执行、风险操作等待确认。
user-invocable: true
argument-hint: "[--all] [--limit N]"
---

# WeChat Skill 2.0

## 自动回复机制（Watcher 后台运行）

当用户在微信发消息时，Watcher 自动调用 LLM 分析语义并按以下路径处理：

### 路径 A：纯闲聊
用户说"你好"、"哈哈"等 → LLM 直接生成自然回复 → 通过微信发送 → 本轮结束。

### 路径 B：安全操作
用户要求查看文件、列出目录、搜索内容等 → LLM 用 Glob/LS/Read/Write 直接执行 → 将结果通过微信发送 → 本轮结束。
用户要求查询实时信息（天气、新闻、百科等）→ LLM 优先用 WebSearch/WebFetch 搜索 → 将结果通过微信发送 → 本轮结束。

安全操作示例：查看目录、搜索文件、读取内容、获取信息、查询天气、搜索网络。

### 路径 C：风险操作
用户要求删除文件、修改系统、安装软件等 → Watcher 不执行，通过微信询问确认 → 用户回复"是"则执行 → 回复"不"则取消 → 本轮结束。

风险操作示例：删除文件、修改配置、安装程序、执行脚本。

## 你必须在每次调用后自动完成以下 3 步

### 第 1 步：导入微信消息

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/collect-wechat.ps1" <ARGUMENTS>
```

- 默认：只处理未读消息
- `--all`：包含已读消息
- `--limit N`：限制导入条数

### 第 2 步：检查待处理风险确认（可选）

如果 Watcher 暂停或需手动审核风险操作：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File wechat-approve.ps1 list
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
powershell -NoProfile -ExecutionPolicy Bypass -File wechat-approve.ps1 approve <pending-id>
```

### 第 3 步：展示结果

简短报告：导入了多少条消息，Watcher 已自动处理了多少条。

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

- `/wechat-skill-2` — 导入未读 + 审核 + 发送
- `/wechat-skill-2 --limit 10` — 仅最近 10 条
- `/wechat-skill-2 --all --limit 20` — 包含已读
