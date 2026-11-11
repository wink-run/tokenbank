// client/electron/guardian/events.js
// 事件触发的两类处理：装了新技能、应用升级了。都是静默处理，按用户教的规矩来；没有规矩就照默认。
'use strict';

const guardian = require('./index');
const store = require('./store');

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

function agentName(id) {
  try { return require('../config-loader').appEntityById(id)?.name || id; } catch { return id; }
}

/** 没有规矩时的智能兜底：已经启用过、有风险、没有可用应用的不问 */
async function judgeSkill(info, facts) {
  try {
    const m = rm();
    const r = m.getResource(info.resourceId);
    const internal = require('./diagnose').INTERNAL_TARGETS;   // 资产库自己的落点不算「已经启用到应用」
    if (!r || r.type !== 'skill' || (r.projections || []).some(p => !internal.has(p.agentId || p.agent_id))) return null;
    if (require('./asset-checks').securityGate(r)) return null;
    const apps = require('../resource-agent-targets').listManagedResourceAgentIds().map(id => ({ id, name: agentName(id) }));
    if (!apps.length) return null;
    const j = await require('./judge').judge({
      event: 'skill-installed', label: '用户装了一个新技能，还没有启用到任何应用',
      facts: { name: facts.name, source: facts.source }, keyFacts: { id: info.resourceId },
      context: `技能说明：${String(r.description || '').slice(0, 800)}\n本机已纳管的应用：${apps.map(a => `${a.id}（${a.name}）`).join('、')}`,
      actions: {
        project: '启用到应用，agentIds 里写应用 id（只能从已纳管的应用里选，选用得上它的）',
        ignore: '先不启用，等用户自己决定',
      },
      fallback: 'ignore',
    });
    if (!j || j.action !== 'project') return null;
    return { action: 'project', data: { agentIds: j.agentIds }, reason: j.reason, rule: null };
  } catch { return null; }
}

/** 装了新技能：按规矩自动启用到应用；开了「自动跑」的管家技能过一遍 */
async function onSkillInstalled(info = {}) {
  if (guardian.modeOf('assets') === 'off' || !info.resourceId) return;
  const facts = { resourceId: info.resourceId, name: info.name || '', source: info.source || '' };
  let d = null;
  try { d = require('./rules').decide('skill-installed', facts); } catch { /* ignore */ }
  if (!d) d = await judgeSkill(info, facts);   // 没有规矩：看这个技能是干什么的，判断该不该启用、启用到哪
  if (d && d.action === 'project') {
    const m = rm();
    const r = m.getResource(info.resourceId);
    // 高风险技能不自动启用：启用的那一刻要用户自己确认
    const risky = r && require('./asset-checks').securityGate(r);
    const managed = new Set(require('../resource-agent-targets').listManagedResourceAgentIds());
    const ids = (d.data.agentIds || []).filter(id => managed.has(id));
    if (r && !risky && ids.length) {
      const res = m.projectToAgents(info.resourceId, ids, 'global', { force: false });
      if (!(res && res.success === false)) {
        guardian.record({
          category: 'assets', kind: 'skill-auto-enabled', status: 'done',
          title: d.rule
            ? `按你定的规矩，把新装的「${r.display_name || r.name}」启用到了 ${ids.map(agentName).join('、')}`
            : `新装的「${r.display_name || r.name}」，我看它适合 ${ids.map(agentName).join('、')}，就启用过去了${d.reason ? `（${d.reason}）` : ''}`,
          undo: { type: 'commandUnproject', data: { resourceId: r.id, agentIds: ids } },
          ...(d.rule ? { byRule: d.rule.id } : { byJudge: true }), caseEvent: 'skill-installed', facts,
        });
      }
    }
  }
  try { await Promise.all(require('./skills').runOnEvent('skill-installed', facts)); } catch { /* ignore */ }
}

/** 应用列表更新：版本号变了就是升级了 → 把它的技能链接看一遍（升级常会清空技能目录） */
async function onAgentList(agents) {
  if (guardian.modeOf('projection') === 'off' || !Array.isArray(agents)) return;
  const known = store.readJson('app-versions.json', {});
  const next = { ...known };
  const upgraded = [];
  for (const a of agents) {
    if (!a || a.type !== 'cli' || !a.version) continue;
    if (known[a.id] && known[a.id] !== a.version) upgraded.push({ agentId: a.id, from: known[a.id], to: a.version });
    next[a.id] = a.version;
  }
  if (JSON.stringify(next) !== JSON.stringify(known)) store.writeJson('app-versions.json', next);
  let run = false;
  for (const u of upgraded) {
    let d = null;
    try { d = require('./rules').decide('app-upgraded', u); } catch { /* ignore */ }
    if (!(d && d.action === 'ignore')) run = true;
  }
  if (run) await guardian.runCheck('projection').catch(() => {});
}

function attach() {
  guardian.on('skill:installed', (info) => onSkillInstalled(info));
  try { require('../agent-executor').on('list:updated', (agents) => { onAgentList(agents).catch(() => {}); }); } catch { /* 执行器不可用 */ }
}

module.exports = { attach, onSkillInstalled, onAgentList };
