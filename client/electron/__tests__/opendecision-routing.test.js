'use strict';
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const http = require('http');

// Isolate all gateway/config/log state; never contact a real model provider.
const tmpRoot = fs.realpathSync(os.tmpdir());
const home = fs.mkdtempSync(path.join(tmpRoot, 'tb-opendecision-'));
const originalHome = os.homedir;
os.homedir = () => home;
const filename = require.resolve('../local-gateway');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(fs.readFileSync(filename, 'utf8') + `
module.exports.testing = {
  resolveSteps, classifyInput, routingCfg, internalComplete,
  setConfig: c => { _getConfig = () => c; _classifyCache.clear(); },
  setComplete: fn => { internalComplete = fn; },
};`, filename);
const gw = mod.exports.testing;
const jev = require('../jev-shadow');
const loader = require('../config-loader');
let sequence = 0, logs;
function configure(overrides = {}, providers = []) {
  gw.setConfig({ providers, routing: {
    decision_classifier: {
      engine: 'systemone', health_check: false,
      endpoint: `http://127.0.0.1:18080/route-${++sequence}`, ...overrides,
    },
  } });
}
const classifier = { categories: ['billing', 'tech'], model: 'test-classifier' };
const fallback = { model: 'chosen-default', tier: 'free', scope: 'personal', provider: 'allowed' };
const scene = {
  scene_name: 'test-scene', classifier,
  steps: [
    { model: 'billing-model', when: { type: 'classifier', value: 'billing' } },
    { model: 'negative-model', when: { type: 'classifier', op: 'not', value: 'billing' } },
    fallback,
  ],
};
const ctx = () => ({ text: 'old-history '.repeat(200), keyword_text: 'please fix my bill' });
const provider = { id: 'test', enabled: true, type: 'free', base_url: 'http://127.0.0.1:1/v1', models: [classifier.model] };
beforeEach(t => {
  logs = [];
  t.mock.method(loader, 'routing', () => ({}));
  t.mock.method(jev, 'logDecision', r => logs.push(r));
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('test offline'); });
  gw.setComplete(async () => { throw new Error('test LLM offline'); });
  configure();
});
after(() => {
  os.homedir = originalHome;
  assert.ok(fs.realpathSync(home).startsWith(tmpRoot + path.sep));
  fs.rmSync(home, { recursive: true, force: true });
});

test('classification uses latest user text, never the prefix of old history', async t => {
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    assert.equal(JSON.parse(init.body).state, ctx().keyword_text);
    return { ok: true, json: async () => ({ answers: { intent: { choice: 'billing', confidence: 0.9 } } }) };
  });
  assert.deepEqual((await gw.resolveSteps(scene, ctx())).map(s => s.model), ['billing-model', 'chosen-default']);
  assert.equal(logs[0].used, 'systemone');
});

test('OpenDecision failure uses configured LLM; log reflects actual fallback success', async () => {
  configure({}, [provider]);
  gw.setComplete(async (_, model, prompt) => {
    assert.equal(model, classifier.model);
    assert.ok(prompt.includes(ctx().keyword_text));
    assert.ok(!prompt.includes('old-history'));
    return { text: 'billing' };
  });
  assert.deepEqual((await gw.resolveSteps(scene, ctx())).map(s => s.model), ['billing-model', 'chosen-default']);
  assert.equal(logs[0].used, 'fallback_llm');
});

test('both classifiers fail: only configured defaults survive, preserving all restrictions', async () => {
  configure({}, [provider]);
  assert.deepEqual(await gw.resolveSteps(scene, ctx()), [fallback]);
  assert.equal(logs[0].used, 'abstain');
  assert.equal(logs[1].used, 'fallback_default');
});

test('abstention never satisfies negative/regex/numeric classifier rules', async () => {
  const steps = ['not', 'match', 'contains', 'lt', 'is', 'in'].map(op => ({
    model: 'must-not-use', when: { type: 'classifier', op, value: op === 'lt' ? 100 : '.*' },
  }));
  assert.deepEqual(await gw.resolveSteps({ classifier, steps: [...steps, fallback] }, ctx()), [fallback]);
});

test('no default route: no invented model/provider and explicit log', async () => {
  assert.deepEqual(await gw.resolveSteps({ ...scene, steps: scene.steps.slice(0, 2) }, ctx()), []);
  assert.equal(logs.at(-1).used, 'no_default_route');
});

test('fallback_llm=false skips second classifier and uses default chain', async () => {
  configure({ fallback_llm: false }, [provider]);
  let calls = 0;
  gw.setComplete(async () => { calls++; return 'billing'; });
  assert.deepEqual(await gw.resolveSteps(scene, ctx()), [fallback]);
  assert.equal(calls, 0);
});

test('kill switch bypasses System One and restores configured LLM', async t => {
  configure({ enabled: false }, [provider]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected'); });
  gw.setComplete(async () => 'billing');
  assert.equal((await gw.resolveSteps(scene, ctx()))[0].model, 'billing-model');
  assert.equal(calls, 0);
});

test('scenes without classifier conditions do not call any classifier', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected'); });
  gw.setComplete(async () => { calls++; throw new Error('unexpected'); });
  assert.deepEqual(await gw.resolveSteps({ steps: [fallback] }, ctx()), [fallback]);
  assert.equal(calls, 0);
});

test('empty user input abstains instead of classifying the system/history', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected'); });
  assert.deepEqual(await gw.resolveSteps(scene, { ...ctx(), keyword_text: '' }), [fallback]);
  assert.equal(calls, 0);
});

test('user YAML is read; explicit runtime fields override it without dropping other fields', t => {
  t.mock.method(loader, 'routing', () => ({ decision_classifier: {
    engine: 'systemone', endpoint: 'http://127.0.0.1:19001/v1/systemone', min_confidence: 0.75,
  }, jev_shadow: { enabled: true } }));
  gw.setConfig({ routing: { decision_classifier: { enabled: false } } });
  const cfg = gw.routingCfg();
  assert.equal(cfg.decision_classifier.endpoint, 'http://127.0.0.1:19001/v1/systemone');
  assert.equal(cfg.decision_classifier.min_confidence, 0.75);
  assert.equal(jev.loadDecisionConfig(cfg).engine, 'llm');
  assert.equal(cfg.jev_shadow.enabled, true);
});

test('LLM labels must exactly match: prose containing a category is not a decision', async () => {
  configure({ engine: 'llm' }, [provider]);
  gw.setComplete(async () => 'not billing, perhaps tech');
  assert.deepEqual(await gw.resolveSteps(scene, ctx()), [fallback]);
});

test('LLM fallbacks coalesce identical inputs and bound distinct concurrent work', async () => {
  configure({ engine: 'llm' }, [provider]);
  const releases = [];
  gw.setComplete(() => new Promise(r => releases.push(r)));
  const first = gw.classifyInput('same', classifier);
  const duplicate = gw.classifyInput('same', classifier);
  const others = ['two', 'three', 'four'].map(text => gw.classifyInput(text, classifier));
  await new Promise(r => setImmediate(r));
  assert.equal(releases.length, 4);
  assert.equal(await gw.classifyInput('overload', classifier), null);
  releases.forEach(r => r('billing'));
  assert.deepEqual(await Promise.all([first, duplicate, ...others]), Array(5).fill('billing'));
});

test('LLM cache cannot mask a disabled classifier provider', async () => {
  configure({ engine: 'llm' }, [provider]);
  gw.setComplete(async () => 'billing');
  assert.equal(await gw.classifyInput('request', classifier), 'billing');
  provider.enabled = false;
  try { assert.equal(await gw.classifyInput('request', classifier), null); }
  finally { provider.enabled = true; }
});

test('LLM fallback has an absolute deadline and cancels the HTTP request', async t => {
  const server = http.createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{'); // headers and partial body do not satisfy the deadline
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  configure({ engine: 'llm', llm_timeout_ms: 200 }, [{
    ...provider, base_url: `http://127.0.0.1:${server.address().port}/v1`,
  }]);
  gw.setComplete(gw.internalComplete);
  const start = Date.now();
  assert.deepEqual(await gw.resolveSteps(scene, ctx()), [fallback]);
  assert.ok(Date.now() - start < 1500);
});

test('shadow inference is non-blocking and cannot change the selected chain', async t => {
  gw.setConfig({ providers: [provider], routing: {
    decision_classifier: { engine: 'llm' },
    jev_shadow: { enabled: true, endpoint: 'http://127.0.0.1:18080/shadow-only', health_check: false },
  } });
  gw.setComplete(async () => 'billing');
  let release;
  t.mock.method(globalThis, 'fetch', () => new Promise(r => { release = r; }));
  const selected = await gw.resolveSteps(scene, ctx());
  assert.equal(selected[0].model, 'billing-model');
  assert.equal(typeof release, 'function');
  release({ ok: true, json: async () => ({ answers: { intent: { choice: 'tech', confidence: 0.9 } } }) });
  await new Promise(r => setImmediate(r));
  assert.equal(selected[0].model, 'billing-model');
});

test('decision logs omit input and URL credentials and rotate at 5MiB', () => {
  const log = jev.LOG_FILE;
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, 'x'.repeat(5 * 1024 * 1024 + 1));
  jev.appendLog({ endpoint: 'http://user:secret@127.0.0.1:18080/v1/systemone?key=secret', text_preview: 'private text', used: 'abstain' });
  const content = fs.readFileSync(log, 'utf8');
  assert.ok(!/secret|private text/.test(content));
  assert.ok(fs.statSync(log + '.1').size > 5 * 1024 * 1024);
  assert.equal(JSON.parse(content).used, 'abstain');
});
