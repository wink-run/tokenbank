// client/electron/guardian/idle-skills.js
// 闲置技能：启用 30 天一次都没用过的，智能管家从应用里撤下（资产还在，记录里可以一键放回）。
// 技能放在应用里，每次对话都占一点上下文；用不上的放着只是干扰。以前资产页顶部有一条「N 项启用后一直没用」
// 让用户自己点，现在交给管家：每天看一次，有把握才动。
//  - 只动「启用 30 天、一次都没用过」的（7 天没用只是状态，不动）
//  - 智能体模板里用到的技能不动（撤了智能体就少了这个技能）
//  - 内置的、高风险等你确认的不动
'use strict';

const guardian = require('./index');

const IDLE_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

/** 智能体模板里写了的技能名 */
function skillsUsedByAgents(m) {
  const names = new Set();
  for (const a of m.listResources({ type: 'assistant' }) || []) {
    try {
      const cfg = typeof a.content === 'string' ? JSON.parse(a.content || '{}') : (a.content || {});
      for (const s of Array.isArray(cfg.skills) ? cfg.skills : []) {
        const n = typeof s === 'string' ? s : (s && (s.name || s.id));
        if (n) names.add(String(n));
      }
    } catch { /* 正文不是 JSON：没有技能清单 */ }
  }
  return names;
}

/** 这次该撤下的：[{ resourceId, name, agentIds }] */
function findIdle(m, now = Date.now()) {
  const { classifyLifecycle, isLifecycleExempt } = require('../resource-hit-or-exit');
  const used = skillsUsedByAgents(m);
  const out = [];
  for (const r of m.listResources({ type: 'skill' }) || []) {
    const agentIds = [...new Set((r.projections || []).map((p) => p.agentId).filter(Boolean))];
    const builtin = r.source === 'builtin' || r.metadata?.builtin || String(r.source_url || '').startsWith('builtin:');
    if (!agentIds.length || builtin || isLifecycleExempt(r)) continue;
    if (used.has(r.name) || used.has(r.display_name) || used.has(r.id)) continue;
    const life = classifyLifecycle(r, now);
    if (life.useCount > 0 || life.ageMs < IDLE_DAYS * DAY) continue;
    out.push({ resourceId: r.id, name: r.display_name || r.name, agentIds });
  }
  return out;
}

async function check() {
  if (guardian.modeOf('assets') === 'off') return { ok: true, skipped: true };
  const m = rm();
  const idle = findIdle(m);
  if (!idle.length) return { ok: true, removed: 0 };
  const done = [];
  for (const it of idle) {
    let ok = true;
    for (const agentId of it.agentIds) {
      // 不是用户撤的：不记「用户撤下过」，以后用户重新启用会照常放进所有应用
      try { m.unproject({ resourceId: it.resourceId, agentId }); } catch { ok = false; }
    }
    if (ok) done.push(it);
  }
  if (done.length) {
    const names = done.map((d) => d.name);
    guardian.record({
      category: 'assets',
      kind: 'idle-skills-removed',
      status: 'done',
      title: done.length === 1
        ? `「${names[0]}」启用 ${IDLE_DAYS} 天一次没用过，已从应用里撤下`
        : `${done.length} 个技能启用 ${IDLE_DAYS} 天一次没用过，已从应用里撤下`,
      detail: `${names.slice(0, 12).join('、')}${names.length > 12 ? ' 等' : ''}。资产还在，需要时在资产页点「启用」，或在这里撤销。`,
      undo: { type: 'reprojectMany', data: { items: done.map(({ resourceId, agentIds }) => ({ resourceId, agentIds })) } },
      meta: { items: done },
    });
  }
  return { ok: true, removed: done.length };
}

function register() {
  // 撤销：放回原来那些应用
  guardian.registerAction('reprojectMany', ({ items = [] }) => {
    const m = rm();
    let n = 0;
    for (const it of items) {
      try { const r = m.projectToAgents(it.resourceId, it.agentIds || [], 'global', {}); if (r && r.success !== false) n++; } catch { /* 资产已删 */ }
    }
    return { ok: true, message: n ? `已放回 ${n} 个技能` : '这些技能已经不在资产库里了' };
  });
  guardian.registerCheck('idle-skills', check);
}

module.exports = { register, check, findIdle, IDLE_DAYS };
