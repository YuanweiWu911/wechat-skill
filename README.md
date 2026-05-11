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
