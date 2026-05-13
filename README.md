# wechat-skill

`wechat-skill` 是一个围绕 `wechat-skill-2` 构建的 Claude Code 微信自动回复仓库。

## 当前版本

- 当前仓库主线版本：已升级为 **兼容 `cc-weixin v0.2.1`** 的实现
- 当前消息链路：`cc-weixin getUpdates -> MCP channel push -> wechat-auto-reply watcher`
- 旧版 `cli-inbox.ts` / `inbox.jsonl` 导入模型已废弃，不再是运行前提

## 依赖插件

本仓库依赖第三方微信插件 `cc-weixin v0.2.1`。

- 安装方式：请通过 Skill Market 安装 `cc-weixin`
- 上游源码仓库：`https://github.com/qufei1993/cc-weixin`
- Git 克隆地址：`https://github.com/qufei1993/cc-weixin.git`

## 核心能力

- 微信消息后台驻守
- 闲聊自动回复
- 安全请求自动执行
- 风险请求二次确认
- 项目内白名单文件直发
- watcher 单实例保护、超时重试、状态持久化

## 当前架构

新版 `cc-weixin v0.2.1` 不再通过 `cli-inbox.ts` 把消息写入本地 inbox 文件，而是直接把消息推送进 Claude 对话上下文：

1. `cc-weixin` 使用 `getUpdates` 长轮询微信 iLink Bot API
2. 插件通过 MCP `notifications/claude/channel` 推送微信消息
3. Claude 会话中出现 `<channel source="weixin" ...>` 通知
4. `.claude/hooks/wechat-auto-reply.ts` 在后台处理分类、执行、回复和确认
5. watcher 使用 `.claude/wechat-auto-cursor.txt` 保存自己的独立 cursor

## 主要文件

- `.claude/skills/wechat-skill-2/SKILL.md`
- `.claude/skills/wechat-skill-2/collect-wechat.ps1`
- `.claude/skills/wechat-skill-2/wechat-approve.ps1`
- `.claude/skills/wechat-skill-2/weixin-inbox.ps1`
- `.claude/hooks/wechat-auto-reply.ts`
- `.claude/hooks/start-wechat-auto.ps1`
- `.claude/hooks/start-wechat-auto-runner.ps1`
- `.claude/hooks/stop-wechat-auto.ps1`
- `test-watcher.ts`
- `wechat-launcher.ts` — 一键启动器源码
- `wechat-launcher.exe` — 编译后的独立可执行文件（双击即用）
- `wechat-gui-server.ts` — 分离式 Bun 后端服务器（开发模式用）
- `wechat-skill-gui.html` — 单页面 GUI 前端
- `start-wechat-tray.bat` — 系统托盘启动脚本
- `.claude/hooks/wechat-tray.cs` — 系统托盘 C# 源码
- `.claude/hooks/wechat-tray.exe` — 编译后的托盘可执行文件

## 使用方式

启动后台 watcher：

```powershell
/wechat-skill-2 --start
```

停止后台 watcher：

```powershell
/wechat-skill-2 --stop
```

查看当前状态：

```powershell
/wechat-skill-2
```

说明：

- 默认 `/wechat-skill-2` 不再做 inbox 导入
- 消息会通过 MCP channel push 直接进入 Claude 上下文
- 风险审核可通过 `wechat-approve.ps1` 进行人工查看和批准

## 图形管理界面 (Web GUI)

项目提供基于 Web 的控制中心，可在浏览器中可视化管理 watcher。

### 一键启动（推荐）

双击 `wechat-launcher.exe` 即可自动完成：
1. 启动后台 watcher
2. 启动内置 GUI 服务器（接管 `wechat-gui-server.ts` 的所有 API 接口）
3. 自动打开浏览器访问 `http://localhost:3456`

> `wechat-launcher.exe` 为独立可执行文件，**不依赖外部 bun 运行时**。

### 系统托盘模式（后台静默运行）

双击 `start-wechat-tray.bat` 可以无窗口后台运行，任务栏通知区域出现图标：

- **左键单击** — 打开 GUI
- **右键菜单** — Open GUI / Restart Watcher / Exit
- 托盘程序会自动监控 wechat-launcher 进程，意外退出后立即重拉
- 选择 **Exit** 会关闭 launcher 和 GUI 服务器，图标消失

核心文件：
| 文件 | 说明 |
|------|------|
| `.claude/hooks/wechat-tray.cs` | 系统托盘 C# 源码 |
| `.claude/hooks/wechat-tray.exe` | 编译后的托盘可执行文件（约 5KB） |
| `start-wechat-tray.bat` | 双击启动托盘模式 |

编译托盘 exe（使用 Windows 内置 .NET Framework csc.exe）：

```powershell
"$env:windir\Microsoft.NET\Framework\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:.claude\hooks\wechat-tray.exe .claude\hooks\wechat-tray.cs
```

### 启动命令（开发模式）

```powershell
bun run wechat-gui-server.ts
```

启动后访问 **http://localhost:3456**。

### 编译 launcher

项目根目录已预编译 `wechat-launcher.exe`。如需重新编译：

```powershell
bun build wechat-launcher.ts --compile --outfile wechat-launcher.exe
```

编译产物为约 117MB 的单文件 exe，`process.argv[0]` 自动推导项目根目录。

### 核心文件

| 文件 | 说明 |
|------|------|
| `wechat-launcher.ts` | 一键启动器源码（启动 watcher + 内嵌 HTTP 服务器 + 打开浏览器） |
| `wechat-launcher.exe` | 编译后的独立可执行文件（双击即用） |
| `wechat-gui-server.ts` | 分离式 Bun 后端服务器（开发模式用，launcher 已内嵌其功能） |
| `wechat-skill-gui.html` | 单页面前端界面（深色/浅色主题） |

### GUI 功能

- **Watcher 状态监控** — 顶部状态徽章实时显示运行/停止
- **启停控制** — 一键启动、停止、重启 watcher
- **消息盒子更新** — 消息轮询触发 + 自动 5 秒刷新
- **会话浏览** — 左侧会话列表，点击切换，时间倒排
- **对话气泡** — 类微信风格，用户消息居左、Bot 回复居右
- **历史关键词检索** — 左侧搜索框过滤 + 模态框全局搜索
- **风险请求审核** — 底部面板列出待审核项，支持批准/拒绝
- **运行统计** — 已回复/风险待审/死信计数
- **配色切换** — 深色/浅色主题一键切换，选择持久化到 localStorage

## 测试

推荐回归入口：

```powershell
bun run .\test-watcher.ts risk
```

也可以使用真实微信消息验证以下链路：

- `chat`
- `executed`
- `risky`
- 文件发送
- watcher 启停

## 安全说明

- 微信消息会进入 Claude 对话上下文，并发送给 Anthropic API
- `cc-weixin` 当前通过 Skill Market 安装；GitHub 仓库仅用于查看源码、版本与问题追踪
- watcher 会在本地 `.claude/` 目录持久化状态、cursor、日志与待审核数据
- 所有 PowerShell 脚本使用 `-ExecutionPolicy Bypass` 运行
