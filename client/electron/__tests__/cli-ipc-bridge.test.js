'use strict';
// Docker / CLI：admin-api 的 /api/bridge 复用桌面版资产与智能体 IPC handler
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离 HOME：资产库、投射目录、local-config 都写到临时目录
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bridge-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.LLM_AGENT_CONFIG_DIR, 'local-config.json'), JSON.stringify({ apps: [] }));

const bridge = require('../../cli/ipc-bridge');

let server;
let base;

test.before(async () => {
  server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // 与 admin-api 的全局 CORS 一致，bridge 需自行去掉
    const url = req.url.split('?')[0];
    if (!(await bridge.handle(req, res, url, req.method))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { server.close(); });

function post(pathname, body, headers = {}) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-TokenBank-Bridge': '1', ...headers },
    body: JSON.stringify(body),
  });
}

test('require("electron") resolves to the CLI stub after install', () => {
  bridge.installElectronStub();
  const electron = require('electron');
  assert.equal(typeof electron.ipcMain.handle, 'function');
  assert.ok(electron.__handlers instanceof Map);
});

test('ping registers resource and agent channels', async () => {
  const res = await fetch(`${base}/api/bridge/ping`, { headers: { 'X-TokenBank-Bridge': '1' } });
  const body = await res.json();
  assert.equal(body.ok, true, body.error);
  assert.ok(body.channels.includes('resource:listResources'));
  assert.ok(body.channels.includes('agent:execute'));
  assert.ok(body.channels.includes('llm:fetch'));
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('requests without the bridge header are refused', async () => {
  const res = await fetch(`${base}/api/bridge/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'resource:listResources', args: [{}] }),
  });
  assert.equal(res.status, 403);
});

test('cross-origin requests are refused', async () => {
  const res = await post('/api/bridge/invoke', { channel: 'resource:listResources', args: [{}] }, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
});

test('unknown or non-whitelisted channels are refused', async () => {
  const res = await post('/api/bridge/invoke', { channel: 'config:write', args: [{}] });
  assert.equal(res.status, 404);
});

test('built-in assistants are managed through the bridge', async () => {
  const res = await post('/api/bridge/invoke', { channel: 'resource:listResources', args: [{ type: 'assistant' }] });
  const body = await res.json();
  assert.equal(body.ok, true, body.error);
  const names = (body.result.resources || []).map((r) => r.name);
  assert.ok(names.includes('resource-installer'));
});

test('a prompt can be saved and listed through the bridge', async () => {
  const save = await (await post('/api/bridge/invoke', {
    channel: 'resource:saveResource',
    args: [{ type: 'prompt', name: 'bridge-test', display_name: 'Bridge test', content: 'hello' }],
  })).json();
  assert.equal(save.ok, true, save.error);
  assert.equal(save.result.success, true, save.result.error);
  const list = await (await post('/api/bridge/invoke', { channel: 'resource:listResources', args: [{ type: 'prompt' }] })).json();
  assert.ok(list.result.resources.some((r) => r.name === 'bridge-test'));
});

test('file dialogs report cancelled in web mode', async () => {
  const body = await (await post('/api/bridge/invoke', { channel: 'resource:pickImportPath', args: [{}] })).json();
  assert.equal(body.ok, true);
  assert.equal(body.result.canceled, true);
});

test('llm.fetch only reaches loopback hosts', async () => {
  const body = await (await post('/api/bridge/invoke', { channel: 'llm:fetch', args: [{ url: 'https://example.com/v1/models' }] })).json();
  assert.equal(body.ok, true);
  assert.equal(body.result.status, 0);
  assert.match(body.result.error, /local gateway/);
});
