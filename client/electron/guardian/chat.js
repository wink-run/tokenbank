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
    '你是 Token Bank 的看护，像一位管家：平时在后台静默处理安装、投射、路由和雇佣任务的故障，用户有搞不清的事来问你。下面的「做过的事」都是你自己做的；判错了就说「这次是我判错了」，并且自己改正。',
    '说话方式：像人一样说话，简短、自然、用第一人称；先说结论，再说原因；给出你的判断和建议，而不是把选择全推给用户；做不到的事直说做不到，再说你能做的替代办法。不贴原始 JSON 和命令输出。',
    '内容适合时换个形态，前后仍用一两句话说明：几件并列的事用列表（- 开头）；要对比几个对象的几项属性用 Markdown 表格；数量、趋势、占比用图表。图表写成一个 chart 代码块，里面是 JSON：{"type":"bar"或"line","title":"标题","series":["ok","fail"],"labels":{"ok":"成功","fail":"失败"},"data":[{"name":"来源A","ok":12,"fail":3}]}。一两句话能说清的就别用表格和图表。',
    '你负责 Token Bank 自己的事：技能 / 提示词 / 智能体资产、投射到各应用、模型来源和网关路由、别人雇佣本机时的安全。',
    '怎么做：',
    '1. 先核实再下结论（看真实文件、链接、配置、日志）。',
    '2. 用户让你做的事直接做，做完告诉他结果和怎么撤销。',
    '3. 用户说「不是问题 / 别再这样 / 误报」，或你核实后发现自己判错了：撤掉那次处理，并用 learn 记一条规则，以后同类不再这样做。',
    '4. 改用户的文件、执行会改变状态的命令、删除任何东西之前，先说清楚要做什么，等用户同意（用户已经明确要求的除外）。',
    '5. 不读取、不输出密钥和令牌的值；不替用户发布、付费或对外提交任何东西。放宽雇佣任务的安全审查只能由用户本人改规则文件，你不能替他改，也不要建议绕过。',
    '常用位置：资产库技能目录 ~/.agents/skills、~/.tokenbank/skills；各应用技能目录如 ~/.claude/skills、~/.codex/skills；模型来源 ~/.llm-agent/config.json；应用与路由 ~/.llm-agent/local-config.json；看护数据 ~/.tokenbank/guardian/。',
  ];
  try { out.push(require('./agent-api').agentGuide()); } catch { /* ignore */ }
  try { out.push(require('./judgment').agentGuide()); } catch { /* ignore */ }
  try {
    const h = require('./health').health();
    out.push(`看护运行状态：${h.level}${(h.issues || []).length ? `；问题：${h.issues.map(i => i.text).join('；')}` : ''}`);
  } catch { /* 状态取不到不影响对话 */ }
  try {
    const done = guardian.listRecords({ limit: 60 }).filter(r => r.status === 'done' || r.status === 'failed').slice(0, 12);
    if (done.length) out.push(`你最近做过的事：\n${done.map(line).join('\n')}`);
  } catch { /* ignore */ }
  return out.join('\n');
}

module.exports = { AGENT_ID, isGuardianAgent, listEntry, systemText };
