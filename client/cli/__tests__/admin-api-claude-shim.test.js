'use strict';
// Docker admin-api：Claude Code shim 改路由时写 ~/.claude/settings.json，且不触发 Pi config-file 写入
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-admin-claude-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const mockWrites = [];
require.cache[require.resolve('../../electron/config-file-write')] = {
  id: require.resolve('../../electron/config-file-write'),
  filename: require.resolve('../../electron/config-file-write'),
  loaded: true,
  exports: {
    isConfigFileApp: (appRec) => !!(appRec?.config_file || appRec?.inject === 'config-file'),
    writeConfigFile: async (opts) => {
      mockWrites.push(opts);
      return { ok: true };
    },
    revertConfigFile: () => ({ ok: true }),
  },
};

const adminApi = require('../admin-api');

let server;
let port;
const mockGateway = {
  getStatus: () => ({ running: true, port: 11430 }),
  setRouterModelMap: () => {},
  setAppControls: () => {},
  setKeySceneMap: () => {},
  setClaudeModels: () => {},
  setBackendConfig: () => {},
  setUserAuth: () => {},
  setPeerModels: () => {},
  getLog: () => [],
  getDailyStats: () => ({ calls: 0 }),
};

function makeRequest(urlPath, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path: urlPath, method };
    if (body) options.headers = { 'Content-Type': 'application/json' };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
        resolve({ statusCode: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const localConfigPath = path.join(HOME, '.llm-agent', 'local-config.json');
const GW = 'http://127.0.0.1:11430';

function writeLocalConfig(apps) {
  fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
  fs.writeFileSync(localConfigPath, JSON.stringify({ apps, scene_routes: [], local_keys: [] }, null, 2), 'utf8');
}

test.before(async () => {
  writeLocalConfig([{
    id: 'app-shim-claude-code',
    name: 'Claude Code',
    link_method: 'shim',
    agent_id: 'claude-code',
    hosted: true,
    route_id: 'deepseek-v4.1-flash',
    api_key: 'sk-local-claude-shim-test-key-41ch',
  }]);
  await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      port = s.address().port;
      s.close(() => {
        server = adminApi.start(port, mockGateway, '127.0.0.1');
        setTimeout(resolve, 80);
      });
    });
  });
});

test.after(async () => {
  if (server) adminApi.stop();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('PUT Claude shim 改路由：写 settings.json，不调用 config-file writer', async () => {
  mockWrites.length = 0;
  const res = await makeRequest('/api/apps/app-shim-claude-code', {
    method: 'PUT',
    body: { route_id: 'paid:volcengine:deepseek-v4-pro', route_ids: ['paid:volcengine:deepseek-v4-pro'] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(mockWrites.length, 0, 'shim 应用不应走 Pi config-file 写入');
  const settingsPath = path.join(HOME, '.claude', 'settings.json');
  assert.ok(fs.existsSync(settingsPath), '应创建默认 ~/.claude/settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, GW);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, 'PROXY_MANAGED');
});
