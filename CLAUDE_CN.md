# CLAUDE_CN.md

英文原版请见 `CLAUDE.md`。

本文档为仓库根目录 `CLAUDE.md` 的中文阅读版，便于中文查看与维护。

## 仓库用途

这是一个用于学习、练习和原型验证 Claude Code 自定义技能的个人沙箱仓库。当前最主要的活跃项目是 `wechat-skill-2`，包含基于 Bun 的 watcher、PowerShell 启动脚本、位于 `test-watcher.ts` 的 watcher 回归测试，以及一个 Web GUI 控制中心（`wechat-gui-server.ts` + `wechat-skill-gui.html`）。

当前仓库状态：`wechat-skill-2` 已升级为 **兼容 `cc-weixin v0.2.1`** 的实现。

依赖来源：
- 请从 Skill Market 安装 `cc-weixin v0.2.1`
- 上游源码仓库：`https://github.com/qufei1993/cc-weixin`
- Git 克隆地址：`https://github.com/qufei1993/cc-weixin.git`

## Skill 开发

自定义技能位于 `.claude/skills/<skill-name>/SKILL.md`。每个技能目录至少包含一个 `SKILL.md`，文件由 YAML frontmatter（如 `name`、`description` 及可选字段）和后续 Markdown 指令组成。

创建或修改 skill 时：

- 使用 `` !`command` `` 语法，在 Claude 看到技能内容前注入实时 shell 输出
- 对有副作用的技能优先使用 `disable-model-invocation: true`；仅对需要 Claude 自动加载的技能省略该字段
- 通过 `${CLAUDE_SKILL_DIR}` 引用脚本或附属文件

`.claude/skills/` 下的技能支持热加载：修改会在当前会话内生效。

## 测试

- 主要回归入口：`bun run .\test-watcher.ts risk`
- `test-watcher.ts` 包含协议、队列、风险确认、重试、risky-exec 探针，以及文件传输白名单 / 大文件确认测试
- 修改 watcher 时，优先遵循 tests-first：先在 `test-watcher.ts` 里补最小复现，再修改生产代码，最后重跑针对性测试

## Watcher 契约

修改 `wechat-skill-2` 时，以下 watcher 行为应被视为契约，而不是建议：

- **路径契约：** 每条输入消息必须且只能落到 `chat`、`executed`、`risky` 三条路径之一
- **风险契约：** 创建、写入、删除、安装、执行脚本、修改配置等请求必须视为 `risky`，不能直接归入 `executed`
- **确认契约：** 只要 `pendingConfirmation` 存在，像 `是` 这样的肯定回复必须解释为确认执行，像 `不` 这样的否定回复必须解释为取消
- **状态契约：** 在等待确认期间，原始风险消息本身不能清空 `pendingConfirmation`
- **回复契约：** 一条输入消息只应产生一个主结果；风险确认执行完成后，不能再继续落入闲聊分支发送额外回复
- **删除契约：** 简单的项目内本地文件删除可以由 watcher 本地执行，但仅限项目根目录内的安全相对路径
- **文件传输契约：** 项目内白名单单文件发送可以由 watcher 本地执行；超过 `10MB` 的文件必须先进行二次确认
- **媒体接收契约：** 用户发送图片/视频/语音/文件附件时，watcher 通过 CDN（AES-128-ECB 解密）自动下载，保存到 `.claude/wechat-media/`，并记录原始文件名；回复必须使用统一格式 `收到《文件名》，需要我帮忙吗？`，不做展开
- **媒体回复契约：** 附件消息必须产生唯一的标准化回复；不得猜测文件内容，不得在确认回复后再生成额外的闲聊回复
- **Channel 契约：** 代码不得再依赖 `cli-inbox.ts`、`inbox.jsonl`、copy/export 导入流程；消息现在通过 MCP channel push 进入上下文
- **Cursor 契约：** watcher 进度持久化在项目内 `.claude/wechat-auto-cursor.txt`；不要再切回插件全局 cursor
- **Start 入口契约：** `wechat-skill-2` 支持 `/wechat-skill-2 --start` 作为 skill 入口层控制模式；该参数必须在 `collect-wechat.ps1` 中先于 inbox 导入被处理，且必须与其他所有参数保持互斥；只有在观察到当前项目 watcher 已后台运行后，才能返回成功
- **Stop 入口契约：** `wechat-skill-2` 支持 `/wechat-skill-2 --stop` 作为 skill 入口层控制模式；该参数必须在 `collect-wechat.ps1` 中先于 inbox 导入被处理，且必须与 `--all` / `--limit` 保持互斥

## WeChat Skill GUI（图形管理界面）

项目附带一个基于 Web 的控制中心，可零命令行可视化管理 watcher。

**一键启动（双击 `wechat-launcher.exe`）：**
1. 启动后台 watcher
2. 启动内置 HTTP 服务器（已内嵌 `wechat-gui-server.ts` 全部功能）
3. 自动打开浏览器访问 `http://localhost:3456`

**开发模式启动：**
```powershell
bun run wechat-gui-server.ts
```

**核心文件：**

- `wechat-launcher.ts` — 一体化启动器源码（启 watcher + 内嵌 HTTP 服务器 + 开浏览器）；可编译为独立 exe
- `wechat-launcher.exe` — 预编译独立可执行文件（约 117MB，不依赖外部 Bun）
- `wechat-gui-server.ts` — Bun 后端服务器，提供 REST API，端口 3456（开发模式/降级方案）
- `wechat-skill-gui.html` — 单页面前端（深色/浅色主题）

**功能列表：**

- **Watcher 状态监控** — 顶部状态徽章显示 PID，运行/停止/启动中
- **启停控制** — 一键启动、停止、重启 watcher
- **会话浏览** — 左侧列表按最后消息时间倒排，点击切换
- **对话气泡** — 类微信风格，用户消息居左、Bot 回复居右
- **消息发送** — 底部输入框输入文本，回车发送；文件选择器用于文件传输
- **文件接收** — 附件（图片/视频/语音/文件）通过 CDN + AES 解密自动下载，在气泡中显示原始文件名的可点击链接
- **用户昵称** — 点击会话列表头像设置显示昵称（localStorage 持久化，不影响后台用户 ID）
- **防闪烁轮询** — 比较数据指纹后再重建 DOM，仅在实际变化时重新渲染
- **关键词搜索** — 模态框全局历史检索
- **风险审核面板** — 底部弹出面板，支持批准/拒绝
- **运行统计** — 已回复/风险待审/死信计数
- **配色切换** — 深色/浅色主题一键切换，选择持久化

**编译 launcher：**
```powershell
bun build wechat-launcher.ts --compile --outfile wechat-launcher.exe
```

## 安全：微信技能链（`wechat-skill-2`）

微信集成跨越多层：`SKILL.md` → `collect-wechat.ps1` / `wechat-approve.ps1` → `.claude/hooks/` 下的 watcher 脚本 → `cc-weixin` 插件（`v0.2.1`，通过 Skill Market 安装；上游源码仓库：`qufei1993/cc-weixin`）。它与微信 iLink Bot API `https://ilinkai.weixin.qq.com` 通信。

当前 watcher / 运行时结构：

- 后台自动启动：`start-wechat-auto.ps1` 会启动 `start-wechat-auto-runner.ps1`，后者负责长驻运行 `wechat-auto-reply.ts` watcher
- 单实例保护：启动/停止脚本通过 pid 文件和 runner 归属控制，避免误杀无关的 `bun.exe` 进程
- 消息生命周期：watcher 在 `.claude/wechat-auto-state.json` 中跟踪 `classifying` / `classified` / `executing` / `replied` / `dead`
- 轮询游标：watcher 在 `.claude/wechat-auto-cursor.txt` 中维护项目独立 cursor
- 风险行为：普通闲聊直接回复；安全读/搜/网页查询类任务直接执行；创建/写入/删除/脚本/安装/改配置类请求必须先确认
- 风险删除兜底：已确认的简单项目内文件删除，可以由 watcher 本地执行，避免受 Claude 工具沙箱限制影响
- 文件传输行为：项目内白名单单文件可以直接作为附件发送；超大文件需要先确认；当前只支持按相对路径精确匹配，不支持按文件名模糊搜索
- 消息入口：`cc-weixin v0.2.1` 通过 `getUpdates` 长轮询，并使用 MCP `notifications/claude/channel` 将消息直接推送为 `<channel source="weixin" ...>` 上下文
- 兼容桥接：`weixin-inbox.ps1` 现仅作为兼容旧引用的占位脚本，不再负责 inbox 导入或 copy
- Start 入口行为：`collect-wechat.ps1` 接受 `--start` 作为控制模式参数，通过 `start-wechat-auto.ps1` 启动当前项目 watcher，并直接退出，不再执行 inbox 导入；默认 `/wechat-skill-2` 现在只显示状态，不会隐式启动 watcher
- Stop 入口行为：`collect-wechat.ps1` 接受 `--stop` 作为控制模式参数，通过 `stop-wechat-auto.ps1` 停止当前项目 watcher，并直接退出，不再执行 inbox 导入

修改或扩展该 skill 时，需要注意的关键风险：

- **第三方插件信任风险：** `cc-weixin` 通过 Skill Market 安装，其上游源码托管在 GitHub，拥有完整微信账户能力（读取消息、发送回复、下载媒体）。若插件更新被污染，可能劫持已连接的微信账户
- **隐私 / 数据外发：** 导入的微信消息会进入 Claude 对话上下文，并发送给 Anthropic API。所有聊天内容，包括媒体附件，都会流向外部服务器
- **自动启动：** `SessionStart` 钩子 `start-wechat-auto.ps1` 会在每次 Claude Code 会话启动时，无需确认地自动启动微信轮询
- **Cursor 竞争风险：** 如果代码误用插件全局 cursor，而不是 `.claude/wechat-auto-cursor.txt`，MCP 主进程与 watcher 可能互相抢更新，造成漏消息
- **明文持久化：** watcher 的状态、pending 审核信息和日志会落在本地 `.claude/` 目录；媒体文件保存到 `.claude/wechat-media/`，保留原始扩展名
- **PowerShell ExecutionPolicy Bypass：** 该链路中的所有 PowerShell 脚本都以 `-ExecutionPolicy Bypass` 运行。虽然这是 Claude Code 脚本常见做法，但也移除了一个基础安全网

当前已具备的正向防护包括：配对码访问控制、会话过期处理、基于父进程 PID 的孤儿进程清理、单实例保护、独立 watcher cursor、风险确认状态保护、本地风险删除兜底、本地白名单文件发送与大文件确认、超时重试，以及连续错误退避。
