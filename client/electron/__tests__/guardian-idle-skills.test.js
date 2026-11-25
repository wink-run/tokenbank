'use strict';
// 智能管家撤下闲置技能：只动启用 30 天、一次没用过、没有智能体用到的
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-idle-'));
const { findIdle, IDLE_DAYS } = require('../guardian/idle-skills');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const proj = (agentId, ageDays) => ({ agentId, createdAt: now - ageDays * DAY });

const m = {
  listResources: ({ type }) => (type === 'assistant' ? [
    { id: 'a1', type: 'assistant', name: 'writer', content: JSON.stringify({ skills: ['used-by-agent'] }) },
  ] : [
    { id: 's-old', type: 'skill', name: 'old-unused', use_count: 0, projections: [proj('codex', 40), proj('cursor', 40)] },
    { id: 's-young', type: 'skill', name: 'week-unused', use_count: 0, projections: [proj('codex', 10)] },
    { id: 's-used', type: 'skill', name: 'old-used', use_count: 3, projections: [proj('codex', 90)] },
    { id: 's-agent', type: 'skill', name: 'used-by-agent', use_count: 0, projections: [proj('codex', 90)] },
    { id: 's-off', type: 'skill', name: 'not-enabled', use_count: 0, projections: [] },
    { id: 's-builtin', type: 'skill', name: 'builtin-one', source: 'builtin', use_count: 0, projections: [proj('codex', 90)] },
  ]),
};

test(`只撤启用 ${IDLE_DAYS} 天一次没用过的；7 天没用、用过的、智能体用到的、没启用的、内置的都不动`, () => {
  const idle = findIdle(m, now);
  assert.deepEqual(idle.map((x) => x.resourceId), ['s-old']);
  assert.deepEqual(idle[0].agentIds, ['codex', 'cursor'], '记下原来在哪些应用，撤销时放回去');
});
