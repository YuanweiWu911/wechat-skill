import { spawnSync } from "node:child_process";

const prompt = [
  '用户从微信发来消息："hello"',
  '',
  '你是一个消息分类器。只分析意图并输出JSON，不要做任何其他事。',
  '',
  '分类规则：',
  '- 纯闲聊（打招呼、情感表达、简单问答等）→ 输出JSON:',
  '  {"action":"chat","reply":"你的自然回复"}',
  '- 安全操作（查看文件、搜索内容、读取信息、查询实时数据等）→ 输出JSON:',
  '  {"action":"executed","reply":"简述你准备做什么"}',
  '- 风险操作（删除文件、修改系统、安装软件、执行脚本等）→ 输出JSON:',
  '  {"action":"risky","warning":"风险说明","command":"操作简述"}',
  '',
  '铁律：',
  '- 只输出一行合法JSON，绝不要任何额外文字',
  '- 闲聊回复要自然亲切，用简体中文',
  '- 风险判断从严：涉及删、改、装、脚本字眼的都是风险',
].join('\n');

console.log('Starting test...');
const result = spawnSync("claude", [
  "-p", prompt,
  "--permission-mode", "bypassPermissions",
], {
  encoding: "utf-8",
  cwd: process.cwd(),
  timeout: 120000,
  env: {
    ...process.env,
    ANTHROPIC_MODEL: "claude-haiku-4-5-20251001",
  },
});

console.log('Done. exit:', result.status, 'signal:', result.signal);
console.log('stdout:', (result.stdout || '').slice(0, 300));
