'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jevShadow = require('../jev-shadow');

test('loadConfig: defaults to opendecision preset, disabled', () => {
  const cfg = jevShadow.loadConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.provider, 'opendecision');
  assert.equal(cfg.requireApiKey, false);
});

test('loadDecisionConfig: safe default keeps llm until explicitly enabled', () => {
  const cfg = jevShadow.loadDecisionConfig({});
  assert.equal(cfg.engine, 'llm');
  assert.equal(cfg.endpoint, 'http://127.0.0.1:18080/v1/systemone');
  assert.equal(cfg.provider, 'opendecision');
  assert.equal(cfg.fallbackLlm, true);
});

test('loadDecisionConfig: user can force llm', () => {
  const cfg = jevShadow.loadDecisionConfig({
    decision_classifier: { engine: 'llm' },
  });
  assert.equal(cfg.engine, 'llm');
});

test('loadDecisionConfig: systemone + opendecision', () => {
  const cfg = jevShadow.loadDecisionConfig({
    decision_classifier: {
      engine: 'systemone',
      provider: 'opendecision',
      min_confidence: 0.35,
    },
  });
  assert.equal(cfg.engine, 'systemone');
  assert.equal(cfg.provider, 'opendecision');
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.minConfidence, 0.35);
  assert.equal(cfg.requireApiKey, false);
});

test('classifyForRouting: returns choice', async () => {
  const dc = jevShadow.loadDecisionConfig({
    decision_classifier: { engine: 'systemone', provider: 'opendecision' },
  });
  const out = await jevShadow.classifyForRouting('bill me', ['billing', 'tech'], dc, async () => ({
    ok: true,
    json: async () => ({
      answers: { intent: { choice: 'billing', confidence: 0.9, probabilities: {} } },
    }),
  }));
  assert.equal(out.choice, 'billing');
});

test('classifyForRouting: low confidence nulls choice', async () => {
  const dc = jevShadow.loadDecisionConfig({
    decision_classifier: {
      engine: 'systemone',
      provider: 'opendecision',
      min_confidence: 0.8,
    },
  });
  const out = await jevShadow.classifyForRouting('maybe', ['a', 'b'], dc, async () => ({
    ok: true,
    json: async () => ({
      answers: { intent: { choice: 'a', confidence: 0.4, probabilities: {} } },
    }),
  }));
  assert.equal(out.choice, null);
  assert.match(out.error, /low_confidence/);
});

test('classifyWithJev: local opendecision works without api key', async () => {
  const out = await jevShadow.classifyWithJev('bill me', ['billing', 'tech'], {
    enabled: true,
    provider: 'opendecision',
    apiKey: '',
    requireApiKey: false,
    endpoint: 'http://127.0.0.1:8000/v1/systemone',
    model: 'opendecision',
    timeoutMs: 500,
    maxChars: 600,
  }, async (_url, init) => {
    assert.equal(init.headers.Authorization, undefined);
    return {
      ok: true,
      json: async () => ({
        answers: { intent: { choice: 'billing', confidence: 0.88, probabilities: {} } },
      }),
    };
  });
  assert.equal(out.choice, 'billing');
});

test('observeParallel: disabled never calls fetch', async () => {
  let called = false;
  jevShadow.observeParallel({
    text: 'x',
    categories: ['a'],
    localLabelPromise: Promise.resolve('a'),
    routingCfg: { jev_shadow: { enabled: false } },
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({}) }; },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(called, false);
});

let sequence = 0;
function config(overrides = {}) {
  return jevShadow.loadDecisionConfig({ decision_classifier: {
    engine: 'systemone', endpoint: `http://127.0.0.1:18080/test-${++sequence}`,
    health_check: false, ...overrides,
  } });
}
const answer = (choice = 'a', confidence = 0.9) => ({
  ok: true, json: async () => ({ answers: { intent: { choice, confidence } } }),
});

test('local/custom credentials do not inherit TypeSafe or gateway keys', (t) => {
  const saved = { ...process.env };
  process.env.TYPESAFE_API_KEY = 'fake-typesafe';
  process.env.AI_GATEWAY_API_KEY = 'fake-gateway';
  process.env.TEST_DECISION_KEY = 'explicit';
  t.after(() => {
    for (const k of ['TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY', 'TEST_DECISION_KEY']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
  assert.equal(config().apiKey, '');
  assert.equal(config({ provider: 'custom' }).apiKey, '');
  assert.equal(config({ provider: 'typesafe' }).apiKey, 'fake-typesafe');
  assert.equal(config({ api_key_env: 'TEST_DECISION_KEY' }).apiKey, 'explicit');
  assert.equal(config({ provider: 'typesafe' }).healthCheck, false);
  assert.equal(jevShadow.isLoopbackUrl('http://[::1]:18080'), true);
});

test('kill switch restores llm and numeric budgets are finite and bounded', () => {
  const c = config({ enabled: false, timeout_ms: Infinity, min_confidence: NaN });
  assert.equal(c.engine, 'llm');
  assert.equal(c.timeoutMs, 1500);
  assert.equal(c.minConfidence, 0.35);
});

test('missing/invalid confidence and out-of-list choices always abstain', async () => {
  for (const confidence of [null, undefined, '0.9', NaN, Infinity, -1, 1.1]) {
    const r = await jevShadow.classifyForRouting('x', ['a'], config({ min_confidence: 0 }), async () => ({
      ok: true, json: async () => ({ answers: { intent: { choice: 'a', confidence } } }),
    }));
    assert.equal(r.choice, null);
    assert.equal(r.error, 'invalid_confidence');
  }
  const r = await jevShadow.classifyForRouting('x', ['a'], config(), async () => answer('other'));
  assert.equal(r.error, 'invalid_choice');
});

test('deadline covers a stalled body, cancels it, and releases concurrency', async () => {
  const cfg = { ...config(), timeoutMs: 25, maxConcurrent: 1 };
  let signal;
  const r = await jevShadow.classifyWithJev('x', ['a'], cfg, async (_, init) => {
    signal = init.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  });
  assert.equal(r.error, 'timeout');
  assert.equal(signal.aborted, true);
  assert.equal((await jevShadow.classifyWithJev('x', ['a'], cfg, async () => answer())).choice, 'a');
});

test('unhealthy service opens circuit; one successful half-open trial recovers', async (t) => {
  const cfg = config({ failure_threshold: 2, cooldown_ms: 1000, health_check: true });
  let now = Date.now(), count = 0;
  t.mock.method(Date, 'now', () => now);
  const failed = async () => { count++; return { ok: false, status: 503 }; };
  for (let i = 0; i < 2; i++) {
    assert.equal((await jevShadow.classifyWithJev('x', ['a'], cfg, failed)).error, 'health_http_503');
  }
  assert.equal((await jevShadow.classifyWithJev('x', ['a'], cfg, failed)).error, 'circuit_open');
  assert.equal(count, 2);
  now += 1001;
  let release;
  const trial = jevShadow.classifyWithJev('x', ['a'], cfg, async url => {
    if (url.endsWith('/health')) return { ok: true, json: async () => ({ status: 'ok' }) };
    await new Promise(r => { release = r; });
    return answer();
  });
  await new Promise(r => setImmediate(r));
  assert.equal((await jevShadow.classifyWithJev('y', ['a'], cfg, failed)).error, 'circuit_open');
  release();
  assert.equal((await trial).choice, 'a');
  assert.equal((await jevShadow.classifyWithJev('z', ['a'], cfg, async () => answer())).choice, 'a');
});

test('bounded concurrency skips instead of queuing; successful health is cached', async () => {
  const cfg = config({ max_concurrent: 1, health_check: true });
  let release, checks = 0;
  const fetcher = async url => {
    if (url.endsWith('/health')) {
      checks++; return { ok: true, json: async () => ({ status: 'ok' }) };
    }
    await new Promise(r => { release = r; });
    return answer();
  };
  const first = jevShadow.classifyWithJev('x', ['a'], cfg, fetcher);
  await new Promise(r => setImmediate(r));
  assert.equal((await jevShadow.classifyWithJev('y', ['a'], cfg, fetcher)).error, 'busy');
  release(); await first;
  await jevShadow.classifyWithJev('z', ['a'], cfg, async url => {
    assert.ok(!url.endsWith('/health')); return answer();
  });
  assert.equal(checks, 1);
});

test('cache and dedup use actual truncated input, endpoint, model and threshold', async () => {
  const cfg = config({ max_chars: 64 });
  let calls = 0, release;
  const fetcher = async (_, init) => {
    calls++;
    assert.equal(JSON.parse(init.body).state, 'x'.repeat(64));
    await new Promise(r => { release = r; });
    return answer('a', 0.7);
  };
  const first = jevShadow.classifyForRouting('x'.repeat(64) + 'one', ['a'], cfg, fetcher);
  const second = jevShadow.classifyForRouting('x'.repeat(64) + 'two', ['a'], cfg, fetcher);
  await new Promise(r => setImmediate(r)); release();
  assert.equal((await first).choice, 'a');
  assert.equal((await second).choice, 'a');
  assert.equal(calls, 1);
  const noWait = async () => { calls++; return answer('a', 0.7); };
  assert.equal((await jevShadow.classifyForRouting('x'.repeat(64), ['a'], cfg, noWait)).cached, true);
  assert.equal((await jevShadow.classifyForRouting('x'.repeat(64), ['a'], { ...cfg, minConfidence: 0.8 }, noWait)).error, 'low_confidence');
  await jevShadow.classifyForRouting('x'.repeat(64), ['a'], { ...cfg, endpoint: cfg.endpoint + '-new' }, noWait);
  await jevShadow.classifyForRouting('x'.repeat(64), ['a'], { ...cfg, model: 'other' }, noWait);
  assert.equal(calls, 4);
});

test('HTTP and malformed JSON failures abstain without caching or exposing response data', async () => {
  const cfg = config();
  const r = await jevShadow.classifyForRouting('x', ['a'], cfg, async () => ({
    ok: false, status: 401, text: async () => 'secret-body',
  }));
  assert.equal(r.error, 'http_401');
  const bad = await jevShadow.classifyForRouting('x', ['a'], cfg, async () => ({
    ok: true, json: async () => { throw new Error('private malformed body'); },
  }));
  assert.equal(bad.error, 'request_failed');
  assert.equal((await jevShadow.classifyForRouting('x', ['a'], cfg, async () => answer())).choice, 'a');
});
