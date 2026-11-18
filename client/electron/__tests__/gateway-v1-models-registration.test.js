'use strict';
// catalog 预填 enabled:true 的付费模板不得出现在 /v1/models，除非个人页或直连计费已登记。
const http = require('http');
const net = require('net');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const billing = require('../billing-config');
const gateway = require('../local-gateway');

const STUB_ANTHROPIC = [
  { name: 'claude-opus-4-7', type: 'chat' },
  { name: 'claude-fable-5', type: 'chat' },
];
const STUB_OPENAI = [
  { name: 'gpt-5.4', type: 'chat' },
  { name: 'o3', type: 'chat' },
];
const DEEPSEEK_MODELS = [{ name: 'deepseek-v4-flash', type: 'chat' }];

function agentProviders() {
  return [
    {
      id: 'anthropic-paid',
      type: 'paid',
      enabled: true,
      token: '',
      base_url: 'https://api.anthropic.com/v1',
      models: STUB_ANTHROPIC,
    },
    {
      id: 'openai',
      type: 'paid',
      enabled: true,
      token: '',
      base_url: 'https://api.openai.com/v1',
      models: STUB_OPENAI,
    },
    {
      id: 'deepseek',
      type: 'paid',
      enabled: true,
      token: 'sk-test',
      base_url: 'https://api.deepseek.com/v1',
      models: DEEPSEEK_MODELS,
    },
    { id: 'tokenbank-p2p', type: 'p2p', enabled: true },
  ];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitListen(port) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/v1/models' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > 3000) reject(new Error('gateway listen timeout'));
        else setTimeout(probe, 25);
      });
    };
    probe();
  });
}

function fetchModels(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/v1/models' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

test('providerEligibleForGatewayRoute 排除未登记模板，保留按量与直连', () => {
  const local = {
    user_payg_providers: [{ provider_id: 'deepseek' }],
    user_subscriptions: [],
    direct_source_billing: {},
  };
  assert.equal(
    billing.providerEligibleForGatewayRoute({ id: 'anthropic-paid', type: 'paid' }, local),
    false,
  );
  assert.equal(
    billing.providerEligibleForGatewayRoute({ id: 'openai', type: 'paid' }, local),
    false,
  );
  assert.equal(
    billing.providerEligibleForGatewayRoute({ id: 'deepseek', type: 'paid' }, local),
    true,
  );
  const direct = {
    user_payg_providers: [],
    user_subscriptions: [],
    direct_source_billing: {
      'claude-code': { source_id: 'claude', mode: 'subscription' },
    },
  };
  assert.equal(
    billing.providerEligibleForGatewayRoute(
      { id: 'anthropic-paid', type: 'paid', oauth_provider: 'claude' },
      direct,
    ),
    true,
  );
});

let port;

before(async () => {
  port = await freePort();
  const localCfg = {
    user_payg_providers: [{ provider_id: 'deepseek' }],
    user_subscriptions: [
      // 单测环境可能无 billing 目录文件，显式写明 gateway_id
      { source_id: 'codex', subscription_to_api: true, gateway_id: 'openai' },
    ],
    direct_source_billing: {},
  };
  gateway.setLocalConfigReader(() => localCfg);
  gateway.setPeerModels(['community-model-a']);
  gateway.setUserAuth('test-jwt');
  gateway.setBackendConfig({ url: 'https://example.test' });
  await new Promise((resolve, reject) => {
    gateway.start(port, () => ({ providers: agentProviders() }), null, '127.0.0.1', reject);
    waitListen(port).then(resolve).catch(reject);
  });
});

after(() => {
  gateway.setLocalConfigReader(null);
  gateway.setUserAuth(null);
  gateway.setBackendConfig({ url: '', token: '' });
  gateway.setPeerModels([]);
  gateway.stop();
});

test('/v1/models 不含未登记 anthropic-paid，含 deepseek、catalog 登记的 codex 与 P2P', async () => {
  const body = await fetchModels(port);
  const ids = new Set((body.data || []).map((m) => m.id));
  assert.ok(!ids.has('claude-opus-4-7'), 'anthropic-paid 模板模型不应出现');
  assert.ok(!ids.has('claude-fable-5'), 'anthropic-paid 模板模型不应出现');
  assert.ok(ids.has('deepseek-v4-flash'), '已登记按量 deepseek 应出现');
  assert.ok(ids.has('gpt-5.4'), '已登记 Codex 订阅应对应 openai 源模型');
  assert.ok(ids.has('community-model-a'), '登录后 P2P 模型应仍出现');
});
