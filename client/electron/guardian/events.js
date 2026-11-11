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

/** 装了新技能：按规矩自动启用到应用；开了「自动跑」的管家技能过一遍 */
async function onSkillInstalled(info = {}) {
  if (guardian.modeOf('assets') === 'off' || !info.resourceId) return;
  const facts = { resourceId: info.resourceId, name: info.name || '', source: info.source || '' };
  let d = null;
  try { d = require('./rules').decide('skill-installed', facts); } catch { /* ignore */ }
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
          title: `按你定的规矩，把新装的「${r.display_name || r.name}」启用到了 ${ids.map(agentName).join('、')}`,
          undo: { type: 'commandUnproject', data: { resourceId: r.id, agentIds: ids } },
          byRule: d.rule.id, caseEvent: 'skill-installed', facts,
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
