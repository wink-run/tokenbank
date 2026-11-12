'use strict';
// Docker/CLI 须在 gateway.start 前注入 setLocalConfigReader，否则未登记付费模板仍会出现在 /v1/models。
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../../electron/local-gateway');

const STUB_ANTHROPIC = [{ name: 'claude-opus-4-7', type: 'chat' }];

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
  ];
}

const LOCAL_CFG = {
  user_payg_providers: [],
  user_subscriptions: [],
  direct_source_billing: {},
};

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

function fetchModelIds(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/v1/models' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          resolve(new Set((body.data || []).map((m) => m.id)));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function startGateway(port, { withReader }) {
  gateway.setLocalConfigReader(withReader ? () => LOCAL_CFG : null);
  await new Promise((resolve, reject) => {
    gateway.start(port, () => ({ providers: agentProviders() }), null, '127.0.0.1', reject);
    waitListen(port).then(resolve).catch(reject);
  });
}

function teardownGateway() {
  gateway.setLocalConfigReader(null);
  gateway.stop();
}

test('CLI gateway.js 在 start 前调用 setLocalConfigReader(readLocalConfig)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'gateway.js'), 'utf8');
  assert.match(
    src,
    /gateway\.setLocalConfigReader\s*\(\s*readLocalConfig\s*\)/,
    'client/cli/gateway.js 须与 Electron 一样注入 local-config 读取器',
  );
});

test('无 local-config 读取器时保留旧行为：未登记 anthropic-paid 仍出现在 /v1/models', async () => {
  const port = await freePort();
  try {
    await startGateway(port, { withReader: false });
    const ids = await fetchModelIds(port);
    assert.ok(ids.has('claude-opus-4-7'), 'legacy：localCfg 为空时不拦 catalog 模板');
  } finally {
    teardownGateway();
  }
});

test('注入读取器后未登记 anthropic-paid 不出现在 /v1/models', async () => {
  const port = await freePort();
  try {
    await startGateway(port, { withReader: true });
    const ids = await fetchModelIds(port);
    assert.ok(!ids.has('claude-opus-4-7'), 'Docker/CLI 与个人页登记规则一致');
  } finally {
    teardownGateway();
  }
});
