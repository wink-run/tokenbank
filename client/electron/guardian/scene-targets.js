// client/electron/guardian/scene-targets.js
// 按场景投射：新技能启用时，不再投射到所有应用，只投到最近真正在用技能的应用。
// 依据是会话里实际调用技能的记录（local-stats.skill_calls），纯规则、不花 token。
'use strict';

const guardian = require('./index');

const WINDOW_DAYS = 60;

/** agent_id → 最近 60 天调用技能的次数 */
function skillUseByAgent(sinceMs) {
  try {
    const d = require('../local-stats').getDb();
    if (!d) return new Map();
    const rows = d.prepare('SELECT agent_id, COUNT(*) AS n FROM skill_calls WHERE ts >= ? GROUP BY agent_id').all(sinceMs);
    return new Map(rows.filter(r => r.agent_id).map(r => [String(r.agent_id), r.n]));
  } catch {
    return new Map();
  }
}

/**
 * 从候选应用里挑出真正在用技能的那些（按使用次数排）。
 * 没有使用记录、或投射智能管家已关闭时返回 null，调用方按原来的默认应用处理。
 */
function preferredTargets({ resourceType, candidates = [] } = {}) {
  if (guardian.modeOf('projection') === 'off') return null;
  if (resourceType && resourceType !== 'skill') return null;
  const use = skillUseByAgent(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  if (!use.size) return null;
  const picked = candidates.filter(id => use.get(id) > 0).sort((a, b) => use.get(b) - use.get(a));
  return picked.length ? { agentIds: picked, reason: 'skill-usage', usage: Object.fromEntries(picked.map(id => [id, use.get(id)])) } : null;
}

module.exports = { preferredTargets, skillUseByAgent };
