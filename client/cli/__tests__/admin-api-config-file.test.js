'use strict';
// Docker admin-api：config-file 应用的 host_method 回填 + 路由变化服务端重写
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-adminapi-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

// Mock 共享写入模块：记录调用，不真正写文件
const mockWrites = [];
const mockReverts = [];
const mockWriter = {
  isConfigFileApp: (appRec) => !!(appRec?.config_file || appRec?.inject === 'config-file'),
  writeConfigFile: async (opts) => {
    mockWrites.push(opts);
    return { ok: true, file: opts.appRec?.config_file, envCount: 0 };
  },
  revertConfigFile: (opts) => {
    mockReverts.push(opts);
    return { ok: true };
  },
};

// 注入模块缓存，让 admin-api 使用 mock
require.cache[require.resolve('../../electron/config-file-write')] = {
  id: require.resolve('../../electron/config-file-write'),
  filename: require.resolve('../../electron/config-file-write'),
  loaded: true,
  exports: mockWriter,
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

function makeRequest(path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const options = { hostname: '127.0.0.1', port, path, method };
    if (body) {
      options.headers = { 'Content-Type': 'application/json' };
    }
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ statusCode: res.statusCode, body: json || raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function setupServer() {
  return new Promise((resolve) => {
    const testServer = http.createServer();
    testServer.listen(0, '127.0.0.1', () => {
      port = testServer.address().port;
      testServer.close(() => {
        server = adminApi.start(port, mockGateway, '127.0.0.1');
        setTimeout(resolve, 100);
      });
    });
  });
}

function teardownServer() {
  return new Promise((resolve) => {
    if (server) {
      adminApi.stop();
      setTimeout(resolve, 100);
    } else {
      resolve();
    }
  });
}

const localConfigPath = path.join(HOME, '.llm-agent', 'local-config.json');

function writeLocalConfig(apps) {
  fs.mkdirSync(path.dirname(localConfigPath), { recursive: true });
  fs.writeFileSync(localConfigPath, JSON.stringify({ apps, scene_routes: [], local_keys: [] }, null, 2), 'utf8');
}

test.before(async () => {
  writeLocalConfig([{
    id: 'app-pi',
    name: 'Pi',
    preset_id: 'pi',
    link_method: 'api-key',
    inject: 'config-file',
    config_file: '/data/.pi/agent/models.json',
    patch: {
      'providers.tokenbank.name': 'Token Bank',
      'providers.tokenbank.baseUrl': '{BASE}/v1',
      'providers.tokenbank.api': 'openai-completions',
      'providers.tokenbank.apiKey': '{KEY}',
    },
    api_key: 'sk-test',
    route_id: 'paid:deepseek:deepseek-v4.1-flash',
    route_ids: ['paid:deepseek:deepseek-v4.1-flash'],
    hosted: true,
  }]);
  await setupServer();
});

test.after(async () => {
  await teardownServer();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {}
});

test('GET /api/apps backfills host_method for saved config-file apps', async () => {
  const res = await makeRequest('/api/apps');
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body));
  const pi = res.body.find((a) => a.id === 'app-pi');
  assert.ok(pi, 'Pi app returned');
  assert.equal(pi.host_method, 'config-file', 'host_method should be backfilled');
});

test('POST /api/apps/write-config-file uses shared writer', async () => {
  mockWrites.length = 0;
  const res = await makeRequest('/api/apps/write-config-file', {
    method: 'POST',
    body: { app_id: 'app-pi', route_id: 'paid:openai:gpt-5.6-sol', route_ids: ['paid:openai:gpt-5.6-sol'] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(mockWrites.length, 1);
  assert.equal(mockWrites[0].appRec.id, 'app-pi');
  assert.deepEqual(mockWrites[0].route_ids, ['paid:openai:gpt-5.6-sol']);
});

test('PUT /api/apps/:id triggers shared rewrite when route changes', async () => {
  mockWrites.length = 0;
  const res = await makeRequest('/api/apps/app-pi', {
    method: 'PUT',
    body: { route_id: 'paid:anthropic:claude-sonnet-4-6', route_ids: ['paid:anthropic:claude-sonnet-4-6'] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.route_id, 'paid:anthropic:claude-sonnet-4-6');
  // 服务端兜底调用共享写入路径
  assert.equal(mockWrites.length, 1, 'shared writer should be called on route change');
  assert.deepEqual(mockWrites[0].route_ids, ['paid:anthropic:claude-sonnet-4-6']);
  assert.equal(mockWrites[0].allowCreate, false, 'allowCreate should be false on route-change rewrite');
});

test('PUT /api/apps/:id does not rewrite when route unchanged', async () => {
  mockWrites.length = 0;
  const res = await makeRequest('/api/apps/app-pi', {
    method: 'PUT',
    body: { name: 'Pi Renamed' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.name, 'Pi Renamed');
  assert.equal(mockWrites.length, 0, 'shared writer should not be called when route unchanged');
});

test('POST /api/apps/revert-config-file uses shared reverter', async () => {
  mockReverts.length = 0;
  const res = await makeRequest('/api/apps/revert-config-file', {
    method: 'POST',
    body: { app_id: 'app-pi', config_file: '/data/.pi/agent/models.json' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(mockReverts.length, 1);
});
