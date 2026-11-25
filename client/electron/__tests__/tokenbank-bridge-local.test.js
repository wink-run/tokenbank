'use strict';
// 应用里的 tokenbank 桥：要在应用里跑的 MCP 由它起子进程，工具和网关给的一起列；Token Bank 没开时照样能用
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bridge-local-'));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-bridge-work-'));
const FAKE = path.join(HOME, 'fake-local-mcp.js');
// 本地 MCP：工具 where 返回它的工作目录（看是不是在应用的目录里起的）
fs.writeFileSync(FAKE, `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l); if (m.id == null) return;
  const out = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') return out({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
  if (m.method === 'tools/list') return out({ tools: [{ name: 'where', description: 'cwd', inputSchema: { type: 'object' } }] });
  if (m.method === 'tools/call') return out({ content: [{ type: 'text', text: process.cwd() + '|' + (m.params.arguments.x || '') }] });
  out({});
});
`);

const SERVERS = [{ id: 'mcp-fs', name: 'filesystem', prefix: 'filesystem', command: process.execPath, args: [FAKE], env: {}, cwd: '' }];
let gw;
const seen = [];
test.before(async () => {
  gw = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== 'Bearer k') { res.writeHead(401); return res.end(); }
    if (req.method === 'GET' && req.url === '/mcp/cursor/local') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ servers: SERVERS }));
    }
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const m = JSON.parse(b);
      const result = m.method === 'tools/list'
        ? { tools: [{ name: 'tb_list_models', description: 'models', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: `gateway:${m.params?.name}` }] };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  fs.mkdirSync(path.join(HOME, '.tokenbank'), { recursive: true });
});
test.after(() => gw.close());

function writeInfo(port) {
  fs.writeFileSync(path.join(HOME, '.tokenbank', 'mcp-gateway.json'), JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, token: 'k' }));
}

function bridge() {
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'tokenbank-mcp-stdio.js')], {
    cwd: WORK,
    env: { ...process.env, HOME, USERPROFILE: HOME, TB_CLIENT_ID: 'cursor' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const waiting = new Map();
  readline.createInterface({ input: p.stdout }).on('line', (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let n = 0;
  const ask = (method, params) => new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return { ask, close: () => p.stdin.end() };
}

test('网关的工具和在应用里起的一起列；调用按前缀分流，在应用的目录里起', async () => {
  writeInfo(gw.address().port);
  const b = bridge();
  try {
    const list = await b.ask('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('tb_list_models'));
    assert.ok(names.includes('filesystem__where'));
    const r = await b.ask('tools/call', { name: 'filesystem__where', arguments: { x: 'hi' } });
    assert.equal(r.result.content[0].text, `${fs.realpathSync(WORK)}|hi`);
    const g = await b.ask('tools/call', { name: 'tb_list_models', arguments: {} });
    assert.equal(g.result.content[0].text, 'gateway:tb_list_models');
    assert.ok(!seen.some((s) => s.includes('filesystem__where')), '本地的不经网关');
  } finally { b.close(); }
  assert.ok(fs.existsSync(path.join(HOME, '.tokenbank', 'mcp', 'app-local', 'cursor.json')), '清单存了一份');
});

test('Token Bank 没开：用存着的清单照样起、照样能调', async () => {
  writeInfo(1); // 连不上
  const b = bridge();
  try {
    const list = await b.ask('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('filesystem__where'));
    assert.ok(names.includes('tb_list_models'), '静态的 Token Bank 工具也在');
    const r = await b.ask('tools/call', { name: 'filesystem__where', arguments: {} });
    assert.match(r.result.content[0].text, /\|$/);
  } finally { b.close(); }
});

test('应用发完请求就关输入：照样把工具列表答完再退', async () => {
  writeInfo(gw.address().port);
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'tokenbank-mcp-stdio.js')], {
    cwd: WORK,
    env: { ...process.env, HOME, USERPROFILE: HOME, TB_CLIENT_ID: 'cursor' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const lines = [];
  readline.createInterface({ input: p.stdout }).on('line', (l) => lines.push(JSON.parse(l)));
  p.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  await new Promise((r) => p.on('exit', r));
  const list = lines.find((m) => m.id === 2);
  assert.ok(list, '工具列表答了');
  assert.ok(list.result.tools.some((t) => t.name === 'tb_list_models'));
  assert.ok(list.result.tools.some((t) => t.name === 'filesystem__where'));
});
