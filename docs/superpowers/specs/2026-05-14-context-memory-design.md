# Context + Memory 升级设计

**日期:** 2026-05-14
**版本:** v1.0
**状态:** 已确认

---

## 1. 背景与动机

当前 `wechat-skill-2` 是一问一答模式：每次 `handleIncomingMessage` 是一次性独立分类，无会话上下文，无用户记忆，`CLASSIFY_SYSTEM_PROMPT` 完全静态。不适合长期使用。

目标：在现有架构上引入 **Context（会话上下文）** 和 **Memory（用户记忆）**，增强互动体验与智能化水平。

## 2. 方案选择

在 A/B/C 三种方案中选定 **方案 A：最小侵入 — 扩展现有 messageStates + 新增 Memory 文件**。

理由：改动最小（约 300 行）、风险最低、核心分类→回复链路不变、团队对现有代码最熟悉。

### 关键决策汇总

| 决策 | 选择 |
|------|------|
| Context 窗口边界 | 10 分钟无交互过期 + `/new` 手动重置 + 窗口最多 20 条 |
| Memory 维度 | 兴趣标签、交互统计、显式偏好、AI 推断画像、备注（全维度） |
| Memory 更新时机 | 会话结束时由 LLM 自动总结更新 |
| Context 注入方式 | 拼入 System Prompt |
| Memory 缓存策略 | 三层缓存：L0 指纹 → L1 近层 → L2 远层 |
| 过期会话处理 | 询问用户意图（继续/新会话），不自动关闭 |

## 3. 架构概览

```
新消息到达
  │
  ├─ Session 管理
  │   ├─ 查询/创建 Session (wechat-sessions.jsonl)
  │   ├─ 过期检测 → 询问用户
  │   └─ 提取最近 20 条摘要
  │
  ├─ Memory 缓存 (三层)
  │   ├─ L0: md5(memory.json) vs memory-digest.txt
  │   ├─ L1: 最近 10 条 (≤500 chars)
  │   └─ L2: 全量 (保留接口，当前不自动触发)
  │
  ├─ 拼入 CLASSIFY_SYSTEM_PROMPT
  │   └─ + session_context + memory_context
  │
  ├─ LLM 分类 → 回复 (现有链路，不变)
  │
  └─ 会话关闭时
      ├─ LLM 生成会话摘要
      ├─ LLM 更新 user memory
      └─ 计算 L0 指纹，决定是否写盘
```

## 4. 数据模型

### 4.1 Session

文件：`.claude/wechat-sessions.jsonl`（每行一个会话）

```ts
interface Session {
  id: string;           // "sess:<userId>:<startTimestamp>"
  userId: string;
  startedAt: string;    // ISO 8601
  lastMessageAt: string;
  messageCount: number;
  summary: string;      // ≤300 chars, 会话结束时 LLM 生成
  status: "active" | "closed";
  closedAt?: string;
  closingReason?: "timeout" | "reset" | "manual";
}
```

活跃 session cursor：`.claude/wechat-session-cursor.json`

```ts
interface SessionCursor {
  [userId: string]: string;  // 当前活跃 session ID
}
```

### 4.2 Message Window

每个 `handleIncomingMessage` 调用时，从 session 的消息窗口提取最多 20 条摘要：

```
[用户 10:30] 帮我查天气
[Bot 10:31] {"action":"chat","reply":"请问你要查哪个城市？"}
[用户 10:31] 西安
[Bot 10:32] {"action":"executed","reply":"西安今天晴，18-28°C..."}
```

规则：
- Bot 消息截取 reply 字段前 80 字符
- 用户消息保留全文
- 媒体消息替换为 `[用户 10:33] 发送了附件: xxx.pdf`
- 最多 20 条，超出截断最早的消息

### 4.3 User Memory

文件：`.claude/wechat-memory.json`

```ts
interface UserMemoryMap {
  [userId: string]: {
    userId: string;
    updatedAt: string;

    // 5 个维度
    interests: string[];         // 兴趣标签
    stats: {
      totalInteractions: number;
      firstSeenAt: string;
      lastSeenAt: string;
      activeHours: number[];
      topicsMentioned: Record<string, number>;
    };
    preferences: string[];       // 显式偏好
    profile: string;             // AI 推断画像
    notes: string[];             // 备注
  };
}
```

### 4.4 L0 Digest

文件：`.claude/wechat-memory-digest.txt`

```
# 每行: <userId> <md5hex32>
o9cq800Z_OcxBhGABZk4agJWxLP0@im.wechat a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
```

## 5. 缓存架构

```
新消息 → handleIncomingMessage
  │
  ▼
计算 md5(memory.json[userId])
  │
  ├─ === digest.txt 中的值
  │    → L0 命中
  │    → 复用 lastInjectedMemory 变量（运行时缓存）
  │    → token: 0
  │
  └─ !== digest.txt
       → L0 未命中
       → 加载 memory.json[userId]
       → 取最近 10 条条目（按 updatedAt 排序），≤500 chars
       → 拼入 system prompt
       → 更新 lastInjectedMemory
       → 更新 memory-digest.txt
       → token: ~200
```

### Token 预算

| 场景 | L0 | L1 | Token 消耗 |
|------|-----|-----|-----------|
| Memory 未变化 | ✅ 命中 | ❌ | 0 |
| Memory 变化 + 近层 | ❌ | ✅ | ~200 |
| 需要全量（未来） | ❌ | ✅ | ~800 |

### L2 远层（保留接口）

当前不自动触发 L2。未来可通过 system prompt 中的指令让 LLM 自行判断是否需要全量 Memory，触发方式：

```
若需更多上下文，在分类 reply 中附带 "需要更多背景" 信号，
watcher 检测到后在下次调用时注入 L2 全量。
```

## 6. Session 生命周期

### 6.1 创建

- 用户发来第一条消息，且无活跃 session
- 创建 Session，写入 sessions.jsonl 和 session-cursor.json

### 6.2 活跃期

- 每条入站消息追加入窗口
- `lastMessageAt` 更新
- `messageCount` 递增
- 消息摘要暂存于内存（不写盘，sessions.jsonl 仅在关闭时写）

### 6.3 过期检测

当 `now - lastMessageAt > 10 * 60 * 1000` 且本条消息非 `/new`：

```
Bot → 用户: "之前的对话已中断（10分钟无互动）。要开启新的话题吗？回复"新"开始新会话，或直接继续当前话题。"
```

- 用户回复"新"/"新的"/"开启" → 关闭旧 session + 创建新 session
- 用户回复其他内容 → 保持旧 session，更新 lastMessageAt
- 24 小时内不回复 → 自动关闭旧 session

### 6.4 手动重置

用户发送 `/new` 或 `/reset`：

```
关闭旧 session → 创建新 session → Bot: "已开始新对话。"
```

### 6.5 关闭

```
会话关闭
  ├─ 更新 session.status = "closed"
  ├─ LLM 生成 session.summary（≤300 chars）
  ├─ LLM 调用 MEMORY_UPDATE_PROMPT 更新 user memory
  ├─ 计算 L0 指纹
  │   ├─ 变化 → 写入 memory.json + memory-digest.txt
  │   └─ 未变化 → 跳过写盘
  └─ 更新 sessions.jsonl
```

## 7. Memory 更新流程

### 7.1 MEMORY_UPDATE_PROMPT

```
你是用户记忆管理器。根据本次会话摘要，更新用户记忆。
只修改有变化的字段，不变字段保持原值。

当前记忆: {...memory.json[userId]...}
本次会话摘要: "...session.summary..."

输出合法 JSON:
{
  "interests": [...],
  "stats": {...},
  "preferences": [...],
  "profile": "...",
  "notes": [...]
}
铁律：只输出 JSON，不要额外文字。
```

### 7.2 降级

- LLM 调用失败 → 跳过本次 Memory 更新，log 警告
- JSON 解析失败 → retry × 1，仍失败则跳过

## 8. Context 注入格式

最终的 `CLASSIFY_SYSTEM_PROMPT` 变为：

```
[会话上下文 - 最近 N 条消息]
用户: 帮我查天气
Bot: 请问你要查哪个城市？
用户: 西安
Bot: 西安今天晴，18-28°C...
用户: 那南京呢？

[记忆 - 用户偏好]
兴趣: 地球物理学, 射电天文学
偏好: 简洁回复
画像: 地球物理学研究者，关注射电天文学...
```

- Session context 最多 20 条消息
- Memory context 从 L1 加载，≤500 chars
- 总注入 ≤800 chars

## 9. 错误处理与降级

| 层级 | 场景 | 行为 | 用户感知 |
|------|------|------|---------|
| G0 | Memory 更新 LLM 失败 | 跳过，保留旧 Memory | 无感知 |
| G1 | Session 摘要 LLM 失败 | 用模板替代 | 无感知 |
| G2 | memory.json 损坏/不存在 | 创建空 Memory 初始化 | 无感知 |
| G3 | sessions.jsonl 损坏 | 备份 .bak，创建空文件 | 丢失历史会话 |
| G4 | memory-digest.txt 不匹配 | L0 视为未命中，触 L1 | token +200 |
| G5 | 磁盘满/写失败 | 跳过持久化，log error | 重启丢失 |

### 关键保护

- **分类主链路不可阻塞**：任何新功能失败不得中断聊天
- **读写隔离**：Memory 写仅在会话关闭时执行（processing 锁已释放）
- **并发安全**：L0 计算 + L1 加载在同一 processing 锁内
- **截断保护**：context+memory 注入总长 ≤800 chars

## 10. 文件变更清单

### 新增

| 文件 | 用途 |
|------|------|
| `.claude/wechat-sessions.jsonl` | Session 存储 |
| `.claude/wechat-session-cursor.json` | 活跃 session 索引 |
| `.claude/wechat-memory.json` | 用户记忆存储 |
| `.claude/wechat-memory-digest.txt` | L0 指纹缓存 |
| `docs/superpowers/specs/2026-05-14-context-memory-design.md` | 本设计文档 |

### 修改

| 文件 | 改动 |
|------|------|
| `.claude/hooks/wechat-auto-reply.ts` | +~300 行：Session/Memory 管理、缓存逻辑、新的 System Prompts、会话过期处理 |
| `.claude/skills/wechat-skill-2/SKILL.md` | 更新能力描述 (/new 命令等) |
| `test-watcher.ts` | 新增 session/memory/degrade 测试套件 |

## 11. 契约扩充

| 契约 | 内容 |
|------|------|
| **Session 契约** | 每条入站消息必须归属一个 session；过期不自动关闭，须询问用户 |
| **Memory 写入契约** | Memory 仅在会话关闭时写入，不可在分类过程中写入 |
| **Token 预算契约** | 每次分类注入的 context+memory 总和 ≤800 chars |
| **降级契约** | 任何新功能失败不得阻塞分类→回复主链路 |
| **Media 回复契约** | 已存在，不变 |
| **路径契约** | 已存在，不变 |

## 12. GUI 影响

`wechat-skill-gui.html` **零改动**。Session 和 Memory 信息不在 GUI 展示，用户通过命令行或直接查看文件来管理。

## 13. 测试计划

| 套件 | 验证点 |
|------|--------|
| `session` | 创建 session、过期询问、"新"回复关闭、"/new" 重置、context 注入格式 |
| `memory` | 空 memory 初始化、L0 命中跳过、L1 截断、MEMORY_UPDATE_PROMPT 解析 |
| `degrade` | memory.json 损坏降级、sessions.jsonl 损坏降级、LLM 失败回退 |
