'use strict';
// 智能体路由：存取、名单过滤、派发规则、选主智能体
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-routes-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const routes = require('../agent-routes');

const AGENTS = [
  { id: 'codex', type: 'cli', installed: true },
  { id: 'claude-code', type: 'cli', installed: true },
  { id: 'assistant:review', type: 'assistant' },
  { id: 'assistant:tb-guardian', type: 'assistant', guardian: true },
  { id: 'external:muse', type: 'external' },
  { id: 'community:x@adam', type: 'community' },
];

test('a default route always exists and cannot be deleted', () => {
  const list = routes.list();
  assert.equal(list[0].id, routes.DEFAULT_ID);
  assert.throws(() => routes.remove(routes.DEFAULT_ID));
});

test('saving a new route gives it an agent-router id and keeps rules in order', () => {
  const r = routes.save({ name: '写代码', rules: ['说到评审交给代码评审', '  ', '改代码先交给 Codex'], candidates: ['assistant:review', 'codex'], mainAgentId: 'claude-code' });
  assert.match(r.id, /^agent-router-[0-9a-f]{6}$/);
  assert.deepEqual(r.rules, ['说到评审交给代码评审', '改代码先交给 Codex']);
  assert.equal(routes.get(r.id).name, '写代码');
  assert.ok(routes.remove(r.id));
  assert.equal(routes.get(r.id), null);
});

test('the default list is every local agent, never the butler, and hired agents only when allowed', () => {
  const d = routes.get(routes.DEFAULT_ID);
  const ids = routes.filterAgents(d, AGENTS).map(a => a.id);
  assert.deepEqual(ids, ['codex', 'claude-code', 'assistant:review', 'external:muse']);
  const withHired = routes.filterAgents({ ...d, allowHired: true }, AGENTS).map(a => a.id);
  assert.ok(withHired.includes('community:x@adam'));
});

test('a route with picked candidates only allows those', () => {
  const r = { candidates: ['assistant:review', 'codex'], allowHired: false };
  assert.ok(routes.canDispatchTo(r, 'codex', AGENTS));
  assert.ok(!routes.canDispatchTo(r, 'claude-code', AGENTS));
  assert.ok(!routes.canDispatchTo(r, 'community:x@adam', AGENTS));
});

test('rules text puts the user rules first and the built-in order after', () => {
  const t = routes.rulesText({ name: '写代码', rules: ['说到评审交给代码评审'], whenNone: 'error' });
  const lines = t.split('\n');
  assert.match(lines[1], /^1\. 说到评审交给代码评审/);
  assert.match(t, /2\. 名单里有对得上的专业智能体/);
  assert.match(t, /不要自己做/);
});

test('main agent: the route choice, then the caller, then the first launchable one', () => {
  const launchable = new Set(['codex', 'pi']);
  assert.equal(routes.resolveMainAgent({ mainAgentId: 'pi' }, launchable, 'codex'), 'pi');
  assert.equal(routes.resolveMainAgent({ mainAgentId: 'claude-code' }, launchable, 'codex'), 'codex');
  assert.equal(routes.resolveMainAgent({ mainAgentId: '' }, launchable, ''), 'codex');
  assert.equal(routes.resolveMainAgent({}, new Set(), ''), '');
});

test('a route harness runs the main agent in orchestrator mode with the route id', async () => {
  const { resolveHarness } = require('../agent-http');
  const fake = { _launchableCliIds: new Set(['codex']), listAvailableAgents: async () => AGENTS };
  const r = await resolveHarness(fake, routes.DEFAULT_ID, '');
  assert.equal(r.agentId, 'codex');
  assert.deepEqual(r.options, { mode: 'orchestrator', mainAgentId: 'codex', agentRouteId: routes.DEFAULT_ID });
  const plain = await resolveHarness(fake, 'assistant:review', '');
  assert.deepEqual(plain, { agentId: 'assistant:review', options: {} });
  await assert.rejects(resolveHarness(fake, 'agent-router-nope', ''), /没有这条智能体路由/);
  const none = { _launchableCliIds: new Set(), listAvailableAgents: async () => [] };
  await assert.rejects(resolveHarness(none, routes.DEFAULT_ID, ''), /没有能派发的主智能体/);
});
