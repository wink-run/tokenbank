'use strict';
// Claude 订阅源自己提供的模型不能被 Claude Code 的整表改写收成别的供给（例如 minimax）。
// 社区转发通常不带应用钥匙，只靠 shim；CLI 钥匙则把目录里每个 claude-* 和 '*' 写成同一条路由。
const http = require('http');
const https = require('https');
const net = require('net');
const { EventEmitter } = require('events');
const { test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { bindClaudeCliRouteToKeyScene, bindClaudeRoutesToKeyScene } = require('../../shared/route-binding');
const gateway = require('../local-gateway');

const MINIMAX = {
  steps: [{ model: 'minimax-m2.7', tier: 'p2p' }],
  scene_name: 'minimax-m2.7',
};
const CMS = ['claude-opus-4-8', 'claude-sonnet-4-5', 'claude-fable-5', 'claude-fable-5-1'];

function claudeProvider(models) {
  return {
    id: 'claude-pro',
    type: 'paid',
    source: 'subscription',
    enabled: true,
    auth_type: 'oauth',
    oauth_provider: 'claude',
    base_url: 'https://api.anthropic.com/v1',
    models,
  };
}

function resolve(model, { providers, keyScene = {}, callerKey = '', shim = MINIMAX, isApiKeyCaller = false } = {}) {
  const served = gateway.claudeSubscriptionServesModel(model, providers || []);
  return gateway.resolveBoundScene({
    origModel: model,
    callerKey,
    isApiKeyCaller,
    isClaudeClientName: /^claude-/i.test(model),
    claudeKey: CMS.includes(model) ? model : null,
    shimClaudeScene: (!served && !isApiKeyCaller && /^claude-/i.test(model)) ? shim : null,
    keyScene,
    codexGptFallback: {},
    servedByClaudeSubscription: served,
  });
}

test('启用的 Claude 订阅源列出 fable 时，无钥匙请求不再改写到 minimax', () => {
  const providers = [claudeProvider([
    { name: 'claude-fable-5', type: 'chat' },
    { name: 'claude-fable-5-1', type: 'chat' },
  ])];
  for (const model of ['claude-fable-5', 'claude-fable-5-1']) {
    assert.equal(gateway.claudeSubscriptionServesModel(model, providers), true);
    assert.equal(resolve(model, { providers }), null);
  }
});

test('OAuth 模型列表为空时按官方目录视为提供 fable，显式缩小的列表则不', () => {
  const open = [claudeProvider([])];
  assert.equal(gateway.claudeSubscriptionServesModel('claude-fable-5', open), true);
  assert.equal(resolve('claude-fable-5', { providers: open }), null);
  assert.equal(gateway.claudeSubscriptionServesModel('claude-3-5-haiku-20241022', open), false);
  const narrowed = [claudeProvider([{ name: 'claude-sonnet-4-6', type: 'chat' }])];
  assert.equal(gateway.claudeSubscriptionServesModel('claude-fable-5', narrowed), false);
  assert.equal(resolve('claude-fable-5', { providers: narrowed }).steps[0].model, 'minimax-m2.7');
});

test('关掉的 Claude 订阅源不拦截整表改写', () => {
  const providers = [claudeProvider([{ name: 'claude-fable-5', type: 'chat' }])];
  providers[0].enabled = false;
  assert.equal(gateway.claudeSubscriptionServesModel('claude-fable-5', providers), false);
  assert.equal(resolve('claude-fable-5', { providers }).steps[0].model, 'minimax-m2.7');
});

test('CLI 通配和同目标的批量别名让路；目标不同的单名规则仍生效', () => {
  const providers = [claudeProvider([
    { name: 'claude-fable-5', type: 'chat' },
    { name: 'claude-fable-5-1', type: 'chat' },
  ])];
  const keyScene = {};
  bindClaudeCliRouteToKeyScene(keyScene, 'sk-cli', 'p2p:minimax-m2.7', [], CMS);
  const hit = resolve('claude-fable-5', {
    providers, keyScene, callerKey: 'sk-cli', isApiKeyCaller: true, shim: null,
  });
  assert.equal(hit, null);

  const unknown = resolve('claude-3-5-haiku-20241022', {
    providers, keyScene, callerKey: 'sk-cli', isApiKeyCaller: true, shim: null,
  });
  assert.equal(unknown.steps[0].model, 'minimax-m2.7');

  keyScene['sk-cli']['claude-fable-5'] = {
    steps: [{ model: 'explicit-fallback' }],
    scene_name: 'explicit-fallback',
  };
  const explicit = resolve('claude-fable-5', {
    providers, keyScene, callerKey: 'sk-cli', isApiKeyCaller: true, shim: null,
  });
  assert.equal(explicit.steps[0].model, 'explicit-fallback');
});

test('Desktop 按名字分开的绑定仍改写，不因订阅源提供同名模型而丢掉', () => {
  const providers = [claudeProvider([{ name: 'claude-fable-5', type: 'chat' }])];
  const keyScene = {};
  bindClaudeRoutesToKeyScene(keyScene, 'sk-desktop', ['paid:desktop-slot'], [], ['claude-fable-5']);
  const hit = resolve('claude-fable-5', {
    providers, keyScene, callerKey: 'sk-desktop', isApiKeyCaller: true, shim: null,
  });
  assert.equal(hit.steps[0].model, 'desktop-slot');
  assert.equal(keyScene['sk-desktop']['*'], undefined);
});

test.describe('gateway does not send subscription fable to the catch-all provider', { concurrency: 1 }, () => {
  let port = 0;
  let requests = [];
  const providers = [
    {
      id: 'minimax',
      type: 'paid',
      enabled: true,
      base_url: 'https://api.minimax.test/v1',
      api_format: 'openai',
      token: 'sk-mini',
      models: [{ name: 'minimax-m2.7', type: 'chat' }],
    },
    {
      id: 'claude-pro',
      type: 'paid',
      source: 'subscription',
      enabled: true,
      auth_type: 'oauth',
      oauth_provider: 'claude',
      base_url: 'https://api.anthropic.com/v1',
      token: '',
      credentials: {
        access_token: 'test-token',
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      },
      models: [
        { name: 'claude-fable-5', type: 'chat' },
        { name: 'claude-fable-5-1', type: 'chat' },
      ],
    },
  ];

  function freePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const chosen = server.address().port;
        server.close(() => resolve(chosen));
      });
    });
  }

  before(async () => {
    port = await freePort();
    mock.method(https, 'request', (opts, cb) => {
      const req = new EventEmitter();
      const chunks = [];
      const rec = { url: '', body: null };
      req.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
      req.end = () => {
        rec.url = `https://${opts.hostname}${opts.path}`;
        try { rec.body = JSON.parse(Buffer.concat(chunks).toString() || 'null'); } catch { rec.body = null; }
        requests.push(rec);
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = { 'content-type': 'application/json' };
        process.nextTick(() => {
          cb(res);
          res.emit('data', Buffer.from(JSON.stringify({
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: rec.body && rec.body.model,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          })));
          res.emit('end');
        });
      };
      req.destroy = () => {};
      req.setTimeout = () => {};
      return req;
    });
    gateway.setClaudeShimScene({
      steps: [{ model: 'minimax-m2.7' }],
      scene_name: 'minimax-m2.7',
    });
    gateway.setKeySceneMap({});
    gateway.setAppControls([]);
    await new Promise((resolve, reject) => {
      gateway.start(port, () => ({ providers }), null, '127.0.0.1', reject);
      const started = Date.now();
      const wait = () => {
        const probe = http.get({ host: '127.0.0.1', port, path: '/v1/models' }, (res) => {
          res.resume();
          resolve();
        });
        probe.on('error', () => {
          if (Date.now() - started > 2000) reject(new Error('gateway did not listen'));
          else setTimeout(wait, 20);
        });
      };
      wait();
    });
  });

  after(() => {
    mock.restoreAll();
    gateway.setClaudeShimScene(null);
    gateway.stop();
  });

  function post(model) {
    const data = Buffer.from(JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
    }));
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          'x-p2p-hop': '1',
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode,
          raw: Buffer.concat(chunks).toString(),
        }));
      });
      req.on('error', reject);
      req.end(data);
    });
  }

  test('社区转发 claude-fable-5 打到 Claude 订阅源，而不是 minimax', async () => {
    requests = [];
    const res = await post('claude-fable-5');
    assert.equal(res.status, 200, res.raw);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, 'claude-fable-5');
    assert.match(requests[0].url, /api\.anthropic\.com/);
  });

  test('订阅源未提供的 claude 名仍走显式兜底路由', async () => {
    requests = [];
    const res = await post('claude-3-5-haiku-20241022');
    assert.equal(res.status, 200, res.raw);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, 'minimax-m2.7');
    assert.match(requests[0].url, /api\.minimax\.test/);
  });
});
