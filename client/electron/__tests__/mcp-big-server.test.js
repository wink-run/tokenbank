'use strict';
// 工具多的 MCP（Pipeworx 有七千多个）不逐个列给应用：整份列表应用收不完，Token Bank 自己的工具也被淹没。
// 改成搜着调：tb_get_resource(type=mcp, query) 搜到工具名和参数，再 tb_call_mcp。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-big-mcp-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const relay = require('../mcp-gateway-server');
const tools = require('../tokenbank-tools');

const N = 3000;
const BIG = Array.from({ length: N }, (_, i) => ({ name: i === 7 ? 'discover_tools' : `pack_${i}_query`, description: i === 42 ? 'SEC filings for a company' : `pack ${i}`, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }));
const SMALL = [{ name: 'post_message', description: 'Post', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }];

let srv; let base;
const calls = [];
test.before(async () => {
  srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const msg = JSON.parse(b || '{}');
      const which = req.url.includes('big') ? BIG : SMALL;
      const reply = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'f', version: '1' } });
      if (msg.method === 'tools/list') return reply({ tools: which });
      if (msg.method === 'tools/call') { calls.push(msg.params); return reply({ content: [{ type: 'text', text: 'ok' }] }); }
      if (msg.id == null) { res.writeHead(202); return res.end(); }
      return reply({});
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const rows = [
    { id: 'mcp-big', name: 'pipeworx', display_name: 'Pipeworx', type: 'http', url: `${base}/big`, status: 'active', metadata: {}, gateway_clients: ['cursor'] },
    { id: 'mcp-chat', name: 'chat', display_name: 'Chat', type: 'http', url: `${base}/small`, status: 'active', metadata: {}, gateway_clients: ['cursor'] },
  ];
  relay.attachToGateway({ port: 1, listRoutedFn: () => rows });
  relay.reloadMcpGateway();
  tools.setRelayedToolDefs((cid) => relay.relayedToolDefs(cid));
  tools.setRelayedMcpLister(() => [
    { id: 'mcp-big', name: 'pipeworx', display_name: 'Pipeworx', description: '', tools: [], prefix: 'pipeworx' },
    { id: 'mcp-chat', name: 'chat', display_name: 'Chat', description: '', tools: [], prefix: 'chat' },
  ]);
});
test.after(() => { relay.stopMcpGateway(); srv.close(); tools.setRelayedToolDefs(null); tools.setRelayedMcpLister(null); });

const ctx = { clientId: 'cursor', level: 'full', callRelayed: (n, a) => relay.callRelayedTool ? relay.callRelayedTool(n, a, 'cursor') : null };

test('工具列表：Token Bank 自己的全在，大 MCP 不逐个列，小的照常列', async () => {
  const r = await relay.handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'cursor', { scope: 'app' });
  const names = r.result.tools.map((t) => t.name);
  assert.ok(names.includes('tb_list_resources'));
  assert.ok(names.includes('tb_call_mcp'));
  assert.ok(names.includes('chat__post_message'));
  assert.ok(!names.some((n) => n.startsWith('pipeworx__')));
  assert.ok(names.length < 30, `只有 ${names.length} 个`);
});

test('搜：按关键词给工具名和参数；不给关键词先给它自带的搜索工具；不全列', async () => {
  const hit = JSON.parse((await tools.callTool('tb_get_resource', { type: 'mcp', name: 'pipeworx', query: 'SEC filings' }, ctx)).content[0].text);
  assert.equal(hit.tool_count, N);
  assert.equal(hit.tools[0].name, 'pack_42_query');
  assert.ok(hit.tools.length <= 20);
  const none = JSON.parse((await tools.callTool('tb_get_resource', { type: 'mcp', name: 'pipeworx' }, ctx)).content[0].text);
  assert.deepEqual(none.tools.map((t) => t.name), ['discover_tools']);
  const list = (await tools.callTool('tb_list_resources', { type: 'mcp' }, ctx)).content[0].text;
  assert.ok(list.length < 3000, `列表 ${list.length} 字`);
  assert.match(list, /3000 个工具/);
  const caps = (await tools.callTool('tb_capabilities', {}, ctx)).content[0].text;
  assert.ok(caps.length < 8000, `能力说明 ${caps.length} 字`);
});

test('没列出来的照样能调；工具名写错给相近的，不把几千个全贴出来', async () => {
  const ok = await tools.callTool('tb_call_mcp', { server: 'pipeworx', tool: 'pack_42_query', arguments: { q: 'x' } }, ctx);
  assert.equal(ok.isError, false);
  assert.deepEqual(calls.at(-1), { name: 'pack_42_query', arguments: { q: 'x' } });
  const bad = await tools.callTool('tb_call_mcp', { server: 'pipeworx', tool: 'pack_42', arguments: {} }, ctx);
  assert.equal(bad.isError, true);
  assert.ok(bad.content[0].text.length < 3000);
});
