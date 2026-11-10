// client/electron/guardian/chat.js
// 游乐场里的「看护」：专属智能体，跑在看护设置的执行应用上；用户有疑问时和它对话。
// 不是资产（不进资产库、不能投射），每次对话开始时带上看护当前的状态和待处理事项。
'use strict';

const guardian = require('./index');

const AGENT_ID = 'assistant:tb-guardian';

function isGuardianAgent(id) {
  return String(id || '') === AGENT_ID;
}

function engine() {
  return require('./engine');
}

/** 游乐场智能体列表里的一项；看护关了或没有执行应用就不出现 */
function listEntry(launchableIds, AGENT_CLI = {}) {
  if (!guardian.getSettings().enabled) return null;
  const st = engine().status();
  if (!st.ready || !launchableIds.has(st.runtime)) return null;
  const runtimeName = AGENT_CLI[st.runtime]?.name || st.runtimes.find(r => r.id === st.runtime)?.label || st.runtime;
  return {
    id: AGENT_ID,
    name: '内置看护智能体',
    type: 'assistant',
    guardian: true,
    builtin: true,
    runtimeAgentId: st.runtime,
    runtimeName,
    execRuntimeName: runtimeName,
    description: 'Token Bank 内置看护：资产、投射、模型来源、路由出了状况，有疑问就问它',
    custom: true,
    capabilities: AGENT_CLI[st.runtime]?.capabilities || ['chat'],
    status: 'active',
  };
}

function line(r) {
  const extra = [r.advice, r.resultNote, r.lastError].filter(Boolean).join('；');
  return `- [${r.status}] ${r.title}${extra ? `（${extra}）` : ''}`;
}

/** 系统说明：角色 + 规矩 + 现在的状况（每次对话开始时现算） */
function systemText() {
  const out = [
    '你是 Token Bank 的内置看护，在用户的游乐场里回答关于 Token Bank 本身的问题：技能 / 提示词 / 智能体资产、投射到各应用（Claude Code、Codex、Cursor 等）、模型来源和网关路由、看护做过的处理。',
    '规矩：',
    '1. 先弄清楚原因再给办法，用用户听得懂的话；不确定就说不确定，需要时请用户补充信息。',
    '2. 只读排查（看文件、看配置、看日志）可以直接做；改文件、执行会改变状态的命令、删除任何东西之前，先说清楚要做什么、为什么，等用户同意。',
    '3. 不读取、不输出密钥和令牌的值；不替用户发布、付费或对外提交任何东西。',
    '4. 看护页的记录都能撤销，能用看护记录上的按钮解决的，优先告诉用户点哪个。',
    '常用位置：资产库技能目录 ~/.agents/skills；各应用技能目录如 ~/.claude/skills、~/.codex/skills；模型来源 ~/.llm-agent/config.json；应用与路由 ~/.llm-agent/local-config.json；看护数据 ~/.tokenbank/guardian/。',
  ];
  try {
    const h = require('./health').health();
    out.push(`看护运行状态：${h.level}${(h.issues || []).length ? `；问题：${h.issues.map(i => i.text).join('；')}` : ''}`);
  } catch { /* 状态取不到不影响对话 */ }
  try {
    const recs = guardian.listRecords({ limit: 60 });
    const open = recs.filter(r => ['info', 'suggested', 'failed'].includes(r.status)).slice(0, 15);
    const done = recs.filter(r => r.status === 'done').slice(0, 8);
    out.push(open.length ? `待处理：\n${open.map(line).join('\n')}` : '待处理：没有。');
    if (done.length) out.push(`最近处理过（可撤销）：\n${done.map(line).join('\n')}`);
  } catch { /* ignore */ }
  return out.join('\n');
}

module.exports = { AGENT_ID, isGuardianAgent, listEntry, systemText };
