---
name: wechat-skill-2
description: 基于 cc-weixin v0.2.1 的微信后台驻守与自动回复技能。消息通过 MCP channel push 直接进入对话上下文；后台 Watcher 自动处理闲聊、安全执行、文件发送和风险确认。
user-invocable: true
argument-hint: "[--start] [--stop] [--all] [--limit N]"
disable-model-invocation: true
---

# WeChat Skill 2

## 当前版本

- 当前仓库中的 `wechat-skill-2` 已升级为 **兼容 `cc-weixin v0.2.1`** 的版本。
- 新版本不再依赖 `cli-inbox.ts`、`inbox.jsonl`、`copy/export` 导入流程。
- 微信消息通过 `cc-weixin v0.2.1` 的 **MCP channel push** 直接进入 Claude 对话上下文，Watcher 负责后台驻守、分类、执行、回复和风险确认。

## 依赖插件与安装来源

- 依赖插件：`cc-weixin v0.2.1`
- 安装方式：请从 **Skill Market** 安装 `cc-weixin`
- 上游源码仓库：`https://github.com/qufei1993/cc-weixin`
- Git 仓库地址：`https://github.com/qufei1993/cc-weixin.git`

## 新版消息链路

新版 `cc-weixin` 的消息传递链路如下：

1. `cc-weixin` 使用 `getUpdates` 长轮询微信 iLink Bot API。
2. 新消息通过 MCP `notifications/claude/channel` 进入 Claude 上下文。
3. 你会在对话里看到 `<channel source="weixin" ...>` 通知。
4. `wechat-auto-reply.ts` 作为后台 watcher 持续运行，处理自动回复、风险确认、文件发送和本地状态持久化。
5. watcher 使用项目内 `.claude/wechat-auto-cursor.txt` 持久化自己的 cursor，避免与 `cc-weixin` 主进程抢共享游标。

## 当前能力

- **闲聊自动回复：** 如"你好""你是谁"等，直接回复。
- **会话上下文记忆：** 支持多轮对话上下文，最近 20 条消息窗口；10 分钟无互动自动开启新会话（旧会话记忆自动保存）；发送 `/new` 或 `新` 手动开启新会话。
- **用户记忆：** 跨会话持久化用户兴趣、偏好、画像（会话结束时自动更新）；三级缓存（L0 指纹→L1 近层→L2 远层）节省 token。
- **文件/图片/视频/语音附件收到：** 统一回复格式 `收到《文件名》，需要我帮忙吗？`（无文件名时回复"收到文件，需要我帮忙吗？"），不展开联想，不猜测文件内容。
- **安全请求自动执行：** 如读取文件、列目录、搜索内容、查询天气/网页信息。
- **项目内白名单文件直发：** 允许 `.json`、`.md`、`.txt`、`.yaml`、`.yml`、`.log`、`.ts`、`.pdf`、`.docx`、`.pptx`、`.xlsx`。
- **风险请求二次确认：** 创建、写入、删除、安装、执行脚本、修改配置等必须先确认。
- **简单删除本地兜底：** 对确认后的简单项目内删除请求，可由 watcher 本地执行，避免工具沙箱误伤。

## 技能入口

### 启动 watcher

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/collect-wechat.ps1" --start
```

- 只负责启动当前项目的后台 watcher。
- 成功条件是观察到 watcher 已经在后台运行。

### 停止 watcher

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/collect-wechat.ps1" --stop
```

- 只负责停止当前项目的后台 watcher。

### 查看当前状态

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/collect-wechat.ps1"
```

- 默认不再导入 inbox。
- 只输出 watcher 状态，并提示当前已经切换到 MCP channel push 模式。

## 风险确认审核

当 watcher 进入需要人工审核的场景时，可使用：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/wechat-approve.ps1" list
```

其他常用命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/wechat-approve.ps1" count
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/wechat-approve.ps1" approve <pending-id>
powershell -NoProfile -ExecutionPolicy Bypass -File "${CLAUDE_SKILL_DIR}/wechat-approve.ps1" reject <pending-id>
```

## 行为契约

- 每条消息必须且只能归入 `chat`、`executed`、`risky` 三类之一。
- 创建、写入、删除、安装、脚本执行、配置修改等必须归入 `risky`。
- 在 `pendingConfirmation` 存在时，`是` / `确认` / `yes` 必须优先解释为确认执行，`不` / `取消` / `no` 必须优先解释为取消执行。
- 风险确认完成后，不得再额外补一条闲聊回复。
- 项目内简单删除只允许安全相对路径，不允许绝对路径、盘符路径、根路径或 `..` 越界路径。
- 文件发送仅允许项目根目录内白名单单文件；超过 `10MB` 必须先确认。
- 代码和文档不得再依赖 `cli-inbox.ts`、`inbox.jsonl`、`markInboxRead()` 之类旧架构。

## 隐私与安全提示

- 微信消息会进入 Claude 对话上下文，并发送到 Anthropic API。
- `cc-weixin` 当前建议通过 **Skill Market** 安装；GitHub 仓库仅用于查看源码、版本信息和问题追踪。
- 后台 watcher 会在本地持久化运行状态、cursor、pending 审核信息和日志。
- 所有 PowerShell 脚本都以 `-ExecutionPolicy Bypass` 运行，应将本仓库视作高权限自动化环境。

## 常见用法

- `/wechat-skill-2 --start`：启动后台 watcher
- `/wechat-skill-2 --stop`：停止后台 watcher
- `/wechat-skill-2`：查看 watcher 状态，并提示 MCP channel push 已启用

## 图形管理界面 (Web GUI)

项目提供了一个基于 Bun 的 Web 控制台，可通过浏览器可视化管理 watcher。

**启动命令：**

```powershell
bun run wechat-gui-server.ts
```

启动后访问 **http://localhost:3456** 即可打开操作面板。

**核心文件：**

| 文件 | 说明 |
|------|------|
| `wechat-gui-server.ts` | Bun 后端服务器，提供 REST API（端口 3456） |
| `wechat-skill-gui.html` | 单页面 GUI 前端（深色工业风设计） |

**GUI 提供以下功能：**

- **Watcher 状态监控** — 顶部状态徽章实时显示运行/停止状态
- **Watcher 启停控制** — 一键启动、停止、重启 watcher
- **消息盒子更新** — 手动触发消息轮询 + 自动 5 秒刷新
- **会话浏览** — 左侧会话列表，点击切换，按时间倒排
- **对话气泡展示** — 类微信风格，用户消息居左、Bot 回复居右
- **历史关键词检索** — 左侧搜索框过滤会话 + 模态框全局历史搜索
- **风险请求审核** — 底部面板列出待审核项，支持批准/拒绝
- **运行统计** — 已回复/风险待审/死信统计

**编译为独立 exe（可选）：**

```powershell
bun build wechat-gui-server.ts --compile --outfile wechat-gui-server.exe
.\wechat-gui-server.exe
```
