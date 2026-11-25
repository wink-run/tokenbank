'use strict';
// 应用读工具列表不能被慢的第三方 MCP 拖住；插件类 MCP 的相对路径命令要在它自己的目录里起
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-slow-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const relay = require('../mcp-gateway-server');
const sync = require('../mcp-client-sync');

let slow;
let url;
let delay = 5000;
test.before(async () => {
  slow = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const msg = JSON.parse(b || '{}');
      const reply = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (!msg.id) { res.writeHead(202); return res.end(); }
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } });
      if (msg.method === 'tools/list') return setTimeout(() => reply({ tools: [{ name: 'look', description: 'Look', inputSchema: { type: 'object', properties: {} } }] }), delay);
      return reply({});
    });
  });
  await new Promise((r) => slow.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${slow.address().port}/mcp`;
});
test.after(() => { relay.stopMcpGateway(); slow.close(); });

const names = async (cid) => (await relay.handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, cid, { scope: 'app' })).result.tools.map((t) => t.name);

test('慢的第三方 MCP 不拖住工具列表：先给 Token Bank 自己的；起来后记住，下次马上给', async () => {
  relay.attachToGateway({ port: 1, listRoutedFn: () => [{ id: 'mcp-slow', name: 'slow', type: 'http', url, status: 'active', metadata: {}, gateway_clients: ['cursor'], sync_clients: [] }] });
  const t0 = Date.now();
  const first = await names('cursor');
  assert.ok(Date.now() - t0 < 4500, `等了 ${Date.now() - t0}ms`);
  assert.ok(first.includes('tb_list_agents'));
  assert.ok(!first.includes('slow__look'), '还没起来的先不列');
  assert.ok(!first.includes('tb_gateway_status'), '不塞占位工具');
  await new Promise((r) => setTimeout(r, 2600));   // 后台起来了
  assert.ok((await names('cursor')).includes('slow__look'));
  // 换一个进程（后端都重建）：缓存马上给
  relay.stopMcpGateway();
  delay = 8000;
  const t1 = Date.now();
  const again = await names('cursor');
  assert.ok(again.includes('slow__look'), '用上次记住的工具定义');
  assert.ok(Date.now() - t1 < 1000, `等了 ${Date.now() - t1}ms`);
});

test('相对路径的命令在它自己的目录里起；没记目录的给出明白的错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-plugin-'));
  const script = path.join(dir, 'server.js');
  fs.writeFileSync(script, `#!${process.execPath}
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const m = JSON.parse(l); if (m.id == null) return;
  const result = m.method === 'tools/list' ? { tools: [{ name: 'click', description: 'Click', inputSchema: { type: 'object', properties: {} } }] } : { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'p', version: '1' } };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n'); });
`);
  fs.chmodSync(script, 0o755);
  const row = (meta) => [{ id: 'mcp-plugin', name: 'plugin', type: 'stdio', command: './server.js', args: [], status: 'active', metadata: meta, gateway_clients: ['codex'], sync_clients: [] }];
  relay.stopMcpGateway();
  relay.attachToGateway({ port: 1, listRoutedFn: () => row({ cwd: dir }) });
  relay.reloadMcpGateway();
  for (let i = 0; i < 20 && !(await names('codex')).includes('plugin__click'); i++) await new Promise((r) => setTimeout(r, 200));
  assert.ok((await names('codex')).includes('plugin__click'));

  // 写进应用配置时：命令换成绝对路径，并带上工作目录
  const entry = sync.serverToEntry({ id: 'x', name: 'plugin', status: 'active', command: './server.js', args: ['mcp'], metadata: { cwd: dir } }, 'codex');
  assert.equal(entry.command, script);
  assert.equal(entry.cwd, dir);
});

test('从 Codex 配置导入时带上 cwd', () => {
  const file = path.join(HOME, 'config.toml');
  fs.writeFileSync(file, '[mcp_servers.computer-use]\ncommand = "./Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient"\nargs = ["mcp"]\ncwd = "/Users/me/.codex/plugins/computer-use"\n');
  const pairs = sync.parseMcpEntriesFromFile(file, { format: 'toml-mcp' });
  const [, raw] = pairs.find(([k]) => k === 'computer-use');
  const entry = sync.normalizeMcpEntry(raw);
  assert.equal(entry.cwd, '/Users/me/.codex/plugins/computer-use');
  assert.equal(entry.command, './Codex Computer Use.app/Contents/MacOS/SkyComputerUseClient');
});
