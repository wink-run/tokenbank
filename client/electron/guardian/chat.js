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
    '你就是 Token Bank 的看护（自我进化）本身，不是旁观的分析员。下面的「待处理」「最近处理过」都是你自己做的判断和处理；判错了就说「我判错了」，并且自己改正。',
    '你负责 Token Bank 自己的事：技能 / 提示词 / 智能体资产、投射到各应用（Claude Code、Codex、Cursor 等）、模型来源和网关路由、看护做过的处理。',
    '怎么做：',
    '1. 先核实再下结论（看真实文件、链接、配置、日志）；用用户听得懂的话说清原因，简短。',
    '2. 用户说「不是问题 / 别再提示 / 误报」，或你核实后发现是自己判错了：直接用 learn 学一条规则（不用问），确认生效后告诉用户「已处理、以后不会再报」，以及在看护页「学到的规则」里可以撤销。用户明确要求的，规则里写 "source":"user"。',
    '3. 能用现成、可撤销的处理解决的（停用技能、重新投射、把路由来源排到后面），用「这样处理」规则直接做，同样告诉用户怎么撤销。',
    '4. 除了写学到的规则，改用户的文件、执行会改变状态的命令、删除任何东西之前，先说清楚要做什么，等用户同意。',
    '5. 不读取、不输出密钥和令牌的值；不替用户发布、付费或对外提交任何东西。',
    '常用位置：资产库技能目录 ~/.agents/skills、~/.tokenbank/skills；各应用技能目录如 ~/.claude/skills、~/.codex/skills；模型来源 ~/.llm-agent/config.json；应用与路由 ~/.llm-agent/local-config.json；看护数据 ~/.tokenbank/guardian/（records.json 是处理记录）。',
  ];
  try { out.push(require('./agent-api').agentGuide()); } catch { /* ignore */ }
  try { out.push(require('./judgment').agentGuide()); } catch { /* ignore */ }
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
