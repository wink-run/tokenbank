'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const oauth = require('../oauth');
const providerTest = require('../../shared/provider-test');

// Exercise the actual IPC handler without booting Electron, touching account
// configuration, refreshing credentials, or making any network requests.
function providerTestHandler(response) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('gateway:testProvider',");
  const end = source.indexOf('  // Periodically refresh P2P model list', start);
  assert.ok(start >= 0 && end > start);
  const requests = [];
  const proxies = [];
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (_name, fn) => { handler = fn; } },
    oauthMod: oauth,
    readAgentConfig: () => ({ network_proxy: 'http://network-proxy.invalid:8080' }),
    writeAgentConfig: () => { throw new Error('The probe must not rewrite test configuration'); },
    nodeRequest: async (url, method, headers, body, agent) => {
      requests.push({ url, method, headers, body, agent });
      return response(url, requests.length);
    },
    console: { log() {}, warn() {} },
    require: (id) => {
      if (id === '../shared/provider-test') return providerTest;
      if (id === '../shared/outbound-proxy') return {
        resolveOutboundProxyAgent: (opts) => { proxies.push(opts); return 'test-proxy-agent'; },
      };
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return { run: (p) => handler(null, p), requests, proxies };
}

function oauthProvider(name, base_url) {
  return {
    id: name === 'codex' ? 'openai' : name,
    base_url,
    auth_type: 'oauth',
    oauth_provider: name,
    credentials: {
      access_token: 'test-oauth-access-token',
      account_id: 'test-account-id',
      expires_at: Math.floor(Date.now() / 1000) + 86400,
    },
  };
}

const CODEX_USAGE = 'https://chatgpt.com/backend-api/wham/usage';

test('Codex OAuth probes the read-only subscription endpoint, not public API models', async () => {
  const p = oauthProvider('codex', 'https://api.openai.com/v1');
  p.proxy = 'http://provider-proxy.invalid:8080';
  const original = structuredClone(p);
  const probe = providerTestHandler((url) => url === CODEX_USAGE
    ? { status: 200, body: JSON.stringify({ rate_limit: { limit_reached: true } }) }
    : { status: 403, body: JSON.stringify({ error: { message: 'Missing scopes: api.model.read' } }) });
  const result = await probe.run(p);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(probe.requests.length, 1);
  const req = probe.requests[0];
  assert.equal(req.url, CODEX_USAGE);
  assert.equal(req.method, 'GET');
  assert.equal(req.body, null);
  assert.equal(req.headers.Authorization, 'Bearer test-oauth-access-token');
  assert.equal(req.headers['chatgpt-account-id'], 'test-account-id');
  assert.equal(req.headers.originator, 'codex_cli_rs');
  assert.equal(req.headers['Content-Type'], undefined);
  assert.equal(req.headers['Content-Length'], undefined);
  assert.equal(req.agent, 'test-proxy-agent');
  assert.equal(probe.proxies[0].provider.proxy, p.proxy);
  assert.equal(probe.proxies[0].networkProxy, 'http://network-proxy.invalid:8080');
  assert.deepEqual(p, original);
});

test('Codex OAuth auth failure is reported without probing unrelated endpoints', async () => {
  const probe = providerTestHandler(() => ({ status: 401, body: '{"error":{"message":"Unauthorized"}}' }));
  const result = await probe.run(oauthProvider('codex', 'https://api.openai.com/v1'));
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.error, 'Unauthorized');
  assert.deepEqual(probe.requests.map((r) => r.url), [CODEX_USAGE]);
});

test('Codex OAuth 404 does not fall back to public API or inference', async () => {
  const probe = providerTestHandler(() => ({ status: 404, body: 'Not found' }));
  assert.equal((await probe.run(oauthProvider('codex', 'https://api.openai.com/v1'))).ok, false);
  assert.deepEqual(probe.requests.map((r) => r.url), [CODEX_USAGE]);
});

test('Claude OAuth uses the adapter upstream and keeps the models fallback', async () => {
  const probe = providerTestHandler((_url, count) => ({ status: count === 1 ? 404 : 200, body: '{}' }));
  assert.equal((await probe.run(oauthProvider('claude', 'https://configured.invalid/v1'))).ok, true);
  assert.deepEqual(probe.requests.map((r) => r.url), [
    'https://api.anthropic.com/models', 'https://api.anthropic.com/v1/models',
  ]);
  assert.ok(probe.requests.every((r) => r.method === 'GET' && r.body === null));
});

test('Copilot OAuth uses its adapter upstream', async () => {
  const probe = providerTestHandler(() => ({ status: 200, body: '{}' }));
  assert.equal((await probe.run(oauthProvider('copilot', 'https://configured.invalid/v1'))).ok, true);
  assert.deepEqual(probe.requests.map((r) => r.url), ['https://api.githubcopilot.com/models']);
});

test('OpenAI API-key connections still use public API models', async () => {
  const probe = providerTestHandler(() => ({ status: 200, body: '{"data":[]}' }));
  const result = await probe.run({
    id: 'openai', base_url: 'https://api.openai.com/v1', api_format: 'openai',
    auth_type: 'api_key', token: 'test-api-key',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(probe.requests.map((r) => r.url), ['https://api.openai.com/v1/models']);
  assert.equal(probe.requests[0].headers.Authorization, 'Bearer test-api-key');
});
