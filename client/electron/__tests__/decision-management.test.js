'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { createManager, registerIpc } = require('../decision-management');
const decision = require('../jev-shadow');

const goodFetch = async url => ({ ok: true, json: async () => url.endsWith('/health')
  ? { status: 'ok', service: 'OpenDecision' }
  : { answers: { intent: { choice: 'coding', confidence: 0.8 } } } });
function setup(initial = {}, yaml = {}, fetchImpl = goodFetch) {
  let cfg = structuredClone(initial), writes = 0;
  const deps = {
    getConfig: () => cfg, saveConfig: next => { cfg = next; writes++; },
    getYamlRouting: () => yaml, fetchImpl,
  };
  return { manager: createManager(deps), deps, current: () => cfg, replace: c => { cfg = c; }, writes: () => writes };
}

test('status is read-only, makes no fetch, exposes no resolved keys or URL credentials', () => {
  const s = setup({ routing: { jev_shadow: { endpoint: 'http://name:password@127.0.0.1:18080/v1/systemone?key=secret' } } }, {}, () => { throw Error('must not fetch'); });
  const status = s.manager.status();
  assert.equal(status.mode, 'off');
  assert.equal(status.supported, false);
  assert.equal(status.probe, null);
  assert.ok(!/password|secret|apiKey/.test(JSON.stringify(status)));
  assert.equal(s.writes(), 0);
});

test('read effective YAML/runtime config with the same precedence as gateway', () => {
  const s = setup({ routing: { decision_classifier: { enabled: false } } }, {
    decision_classifier: { engine: 'systemone', min_confidence: 0.7 },
    jev_shadow: { enabled: true, endpoint: 'http://127.0.0.1:19001/v1/systemone' },
  });
  assert.equal(s.manager.status().mode, 'shadow');
  assert.equal(s.manager.status().minConfidence, 0.7);
  assert.equal(s.manager.status().endpoint, 'http://127.0.0.1:19001/v1/systemone');
});

test('probe uses only synthetic input and does not change routing, metrics or circuit', async () => {
  let calls = 0;
  const s = setup({}, {}, async (url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, undefined);
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.state, 'Please write a Python function that sorts a list of integers.');
    }
    return goodFetch(url);
  });
  const before = s.manager.status();
  const result = await s.manager.probe();
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  const after = s.manager.status();
  assert.deepEqual(before.metrics, after.metrics);
  assert.deepEqual(before.circuit, after.circuit);
  assert.equal(s.writes(), 0);
  assert.equal(after.probe.ok, true);
});

test('remote, credential-bearing and nonstandard endpoints are never probed', async () => {
  for (const endpoint of ['https://example.com/v1/systemone', 'http://127.0.0.1:18080/admin', 'http://user:pass@127.0.0.1:18080/v1/systemone', 'http://127.0.0.1:18080/v1/systemone?key=x']) {
    const s = setup({ routing: { jev_shadow: { endpoint } } }, {}, () => { throw Error('must not fetch'); });
    assert.equal((await s.manager.probe()).error, 'unsupported_endpoint');
    assert.equal((await s.manager.setMode('shadow')).ok, false);
    assert.equal(s.writes(), 0);
  }
});

test('enable shadow only after a valid inference and preserve unrelated/latest settings', async () => {
  const initial = { providers: [{ token: 'keep-me' }], routing: { other: 1, decision_classifier: { min_confidence: 0.65, engine: 'systemone' } } };
  const s = setup(initial);
  const result = await s.manager.setMode('shadow');
  assert.equal(result.ok, true);
  assert.equal(result.status.mode, 'shadow');
  assert.equal(result.status.probe.ok, true);
  assert.deepEqual(s.current().providers, initial.providers);
  assert.equal(s.current().routing.other, 1);
  assert.equal(s.current().routing.decision_classifier.min_confidence, 0.65);
  assert.equal(s.current().routing.decision_classifier.engine, 'llm');
  assert.equal(s.current().routing.decision_classifier.enabled, false);
  assert.ok(!JSON.stringify(result).includes('keep-me'));
});

test('bad health / invalid inference cannot enable shadow', async () => {
  for (const fetchImpl of [async () => ({ ok: false, status: 503 }), async () => ({ ok: true, json: async () => ({}) })]) {
    const s = setup({}, {}, fetchImpl);
    assert.equal((await s.manager.setMode('shadow')).ok, false);
    assert.equal(s.writes(), 0);
    assert.equal(s.manager.status().mode, 'off');
  }
});

test('disable works offline and overrides YAML live mode without destroying model settings', async () => {
  const s = setup({ routing: { decision_classifier: { model: 'keep-model' } } }, {
    decision_classifier: { engine: 'systemone' }, jev_shadow: { enabled: true },
  }, () => { throw Error('offline'); });
  assert.equal(s.manager.status().mode, 'active');
  assert.equal((await s.manager.setMode('off')).status.mode, 'off');
  assert.equal(s.current().routing.decision_classifier.model, 'keep-model');
});

test('management API refuses live routing and unknown modes', async () => {
  const s = setup();
  for (const mode of ['active', 'systemone', null, { mode: 'shadow' }]) {
    assert.equal((await s.manager.setMode(mode)).error, 'unsupported_mode');
  }
  assert.equal(s.writes(), 0);
});

test('a newer disable wins over an in-flight shadow enable', async () => {
  let release;
  const s = setup({}, {}, async (url, init) => {
    if (init.method === 'POST') await new Promise(r => { release = r; });
    return goodFetch(url);
  });
  const enable = s.manager.setMode('shadow');
  await new Promise(r => setImmediate(r));
  await s.manager.setMode('off');
  release();
  assert.equal((await enable).error, 'superseded');
  assert.equal(s.manager.status().mode, 'off');
  assert.equal(s.writes(), 1);
});

test('config edits during probe are preserved; endpoint changes require a new check', async () => {
  let release;
  const s = setup({}, {}, async (url, init) => {
    if (init.method === 'POST') await new Promise(r => { release = r; });
    return goodFetch(url);
  });
  const enable = s.manager.setMode('shadow');
  await new Promise(r => setImmediate(r));
  s.replace({ providers: [{ id: 'new' }], routing: { jev_shadow: { endpoint: 'http://127.0.0.1:18081/v1/systemone' } } });
  release();
  assert.equal((await enable).error, 'config_changed');
  assert.equal(s.writes(), 0);
  assert.equal(s.manager.status().probe, null);
});

test('concurrent identical probes are coalesced', async () => {
  let calls = 0;
  const s = setup({}, {}, async url => { calls++; await new Promise(r => setImmediate(r)); return goodFetch(url); });
  const results = await Promise.all([s.manager.probe(), s.manager.probe(), s.manager.probe()]);
  assert.equal(calls, 2);
  assert.ok(results.every(r => r.ok));
});

test('IPC exposes exactly read, probe and constrained mode operations', async () => {
  const handlers = {};
  const s = setup();
  registerIpc({ handle: (name, fn) => { handlers[name] = fn; } }, s.deps);
  assert.deepEqual(Object.keys(handlers), ['decision:status', 'decision:probe', 'decision:setMode']);
  assert.equal(handlers['decision:status']().mode, 'off');
  assert.equal((await handlers['decision:setMode']({}, 'active')).ok, false);
});

test('agreement excludes abstentions and failures; metrics snapshots cannot mutate live counters', t => {
  t.mock.method(fs, 'mkdirSync', () => { throw Error('disable disk writes in test'); });
  const before = decision.getMetrics().shadow;
  decision.appendLog({ mode: 'shadow', local_label: 'a', jev_choice: 'a' });
  decision.appendLog({ mode: 'shadow', local_label: null, jev_choice: 'a' });
  decision.appendLog({ mode: 'shadow', local_label: 'a', jev_choice: null, jev_error: 'timeout' });
  const after = decision.getMetrics().shadow;
  assert.equal(after.total - before.total, 3);
  assert.equal(after.comparable - before.comparable, 1);
  assert.equal(after.agreed - before.agreed, 1);
  assert.equal(after.errors - before.errors, 1);
  after.total = -1;
  assert.notEqual(decision.getMetrics().shadow.total, -1);
});
