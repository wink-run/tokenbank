'use strict';
// 启用的技能自动出现在所有支持技能的已装应用里；高风险的、用户撤下过的、同名冲突的不放
const { test } = require('node:test');
const assert = require('node:assert/strict');

const rm = require('../resource-manager');
const targets = require('../resource-agent-targets');

const SKILLS = [
  { id: 's-on', type: 'skill', name: 'image-gen', metadata: {}, projections: [{ agentId: 'claude-code' }] },
  { id: 's-off', type: 'skill', name: 'unused', metadata: {}, projections: [] },
  { id: 's-risky', type: 'skill', name: 'curl-bash', metadata: {}, projections: [{ agentId: 'claude-code' }] },
  { id: 's-excl', type: 'skill', name: 'git-commit', metadata: { excluded_agents: ['codex'] }, projections: [{ agentId: 'claude-code' }] },
  { id: 's-conflict', type: 'skill', name: 'pdf', metadata: {}, projections: [{ agentId: 'claude-code' }] },
];

function withStubs(fn) {
  const saved = { init: rm.init, listAgentTargets: rm.listAgentTargets, listResources: rm.listResources, getResource: rm.getResource, projectToAgents: rm.projectToAgents, _setSkillMeta: rm._setSkillMeta, getAgentTarget: targets.getAgentTarget };
  const projected = [];
  projected.meta = {};
  rm.init = () => {};
  rm._setSkillMeta = (id, key, list) => { projected.meta[`${id}.${key}`] = list; };
  rm.listAgentTargets = () => ['claude-code', 'codex', 'cursor', 'trae'].map((id) => ({ id }));
  targets.getAgentTarget = (id) => (id === 'trae' ? null : { id });   // trae 不支持技能目录
  rm.listResources = () => SKILLS;
  rm.getResource = (id) => SKILLS.find((x) => x.id === id);
  rm.projectToAgents = (id, ids, scope, opts) => {
    projected.push({ id, ids, auto: opts.auto });
    return { results: ids.map((agentId) => ({ agentId, projectionType: id === 's-conflict' && agentId === 'codex' ? 'conflict' : 'symlink' })) };
  };
  try { return fn(projected); } finally { Object.assign(rm, { init: saved.init, listAgentTargets: saved.listAgentTargets, listResources: saved.listResources, getResource: saved.getResource, projectToAgents: saved.projectToAgents, _setSkillMeta: saved._setSkillMeta }); targets.getAgentTarget = saved.getAgentTarget; }
}

test('启用的技能补到所有支持技能的已装应用；没启用的、高风险的、撤下过的跳过；同名冲突不算补上', () => {
  withStubs((projected) => {
    const r = rm.ensureSkillsInManagedApps({ securityGate: (res) => (res.id === 's-risky' ? { findings: ['下载即执行'] } : null) });
    const byId = Object.fromEntries(projected.map((p) => [p.id, p.ids]));
    assert.deepEqual(byId['s-on'], ['codex', 'cursor'], '补到其它支持技能的应用，不补 trae');
    assert.equal(byId['s-off'], undefined, '一个应用都没有 = 没启用，不动');
    assert.equal(byId['s-risky'], undefined);
    assert.deepEqual(r.skippedRisky, ['s-risky']);
    assert.deepEqual(byId['s-excl'], ['cursor'], '用户从 codex 撤下过：不放回去');
    assert.ok(projected.every((p) => p.auto === true), '自动补的不清用户的排除记录');
    assert.ok(!r.added.some((x) => x.resourceId === 's-conflict' && x.agentId === 'codex'), '同名冲突没补上');
    assert.deepEqual(projected.meta['s-conflict.auto_conflict_agents'], ['codex'], '冲突记下来，资产页写明原因');
    assert.deepEqual(projected.meta['s-on.auto_conflict_agents'], [], '没冲突就清掉');
    assert.ok(r.added.some((x) => x.resourceId === 's-on' && x.agentId === 'cursor'));
  });
});

test('排除记录：用户撤下时记上，之后用户自己再投到那个应用时清掉', () => {
  const store = new Map([['s1', JSON.stringify({ authorityPath: '/x' })]]);
  const db = {
    prepare: (sql) => ({
      get: (id) => (sql.startsWith('SELECT metadata') ? { metadata: store.get(id) } : null),
      run: (meta, id) => { store.set(id, meta); },
    }),
  };
  const savedDb = rm._getDb;
  rm._getDb = () => db;
  try {
    rm._setSkillExcluded('s1', ['codex'], true);
    assert.deepEqual(JSON.parse(store.get('s1')), { authorityPath: '/x', excluded_agents: ['codex'] });
    rm._setSkillExcluded('s1', ['codex'], false);
    assert.deepEqual(JSON.parse(store.get('s1')), { authorityPath: '/x' });
  } finally {
    rm._getDb = savedDb;
  }
});
