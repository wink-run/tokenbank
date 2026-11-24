'use strict';
// Token Bank 以 MCP 暴露给外部智能体：用它自己的 token，按用户给的权限开放工具
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const ext = require('../external-agents');
const mcp = require('../tokenbank-mcp');

let server;
let base;
let token;
test.before(async () => {
  server = http.createServer((req, res) => mcp.handle(req, res, { port: 1 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const { code } = ext.newPairingCode();
  token = ext.register({ code, name: 'Grok Bot' }).token;
  ext.approve('external:grok-bot');
});
test.after(() => { ext._internal.reset(); server.close(); });

async function rpc(body, tk = token) {
  const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

test('默认关闭：带 token 也不让用；没 token 401', async () => {
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, '')).status, 401);
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error.type, 'mcp_not_allowed');
});

test('只读：只列看的工具；调派活被拒', async () => {
  ext.setMcpLevel('external:grok-bot', 'read');
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.json.result.serverInfo.name, 'tokenbank');
  const names = (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result.tools.map((t) => t.name);
  assert.ok(names.includes('tb_list_agents') && names.includes('tb_list_models') && names.includes('tb_list_devices'));
  assert.ok(!names.includes('tb_dispatch_agent') && !names.includes('tb_chat') && !names.includes('tb_hire_community_agent'));
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'tb_dispatch_agent', arguments: { agent_id: 'codex', prompt: 'x' } } });
  assert.equal(call.json.result.isError, true);
  assert.match(call.json.result.content[0].text, /没有权限/);
});

test('派活：多了派任务和调模型；不能派给自己；雇佣要完全控制', async () => {
  ext.setMcpLevel('external:grok-bot', 'operate');
  const names = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json.result.tools.map((t) => t.name);
  assert.ok(names.includes('tb_dispatch_agent') && names.includes('tb_chat'));
  assert.ok(!names.includes('tb_hire_community_agent') && !names.includes('tb_call_mcp'));
  const self = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tb_dispatch_agent', arguments: { agent_id: 'external:grok-bot', prompt: 'x' } } });
  assert.match(self.json.result.content[0].text, /不能把任务派给你自己/);
  ext.setMcpLevel('external:grok-bot', 'full');
  const all = (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json.result.tools.map((t) => t.name);
  assert.ok(all.includes('tb_hire_community_agent') && all.includes('tb_call_mcp'));
  assert.equal(new Set(all).size, all.length, '同名工具只留一个');
});

test('通知回 202；批量请求按顺序回答；调用次数有记录；停用后不能用', async () => {
  const n = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(n.status, 202);
  const batch = await rpc([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }, { jsonrpc: '2.0', id: 'b', method: 'nope' }]);
  assert.deepEqual(batch.json.map((m) => m.id), ['a', 'b']);
  assert.equal(batch.json[1].error.code, -32601);
  const before = ext.get('external:grok-bot').mcpCalls;
  await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'tb_list_devices', arguments: {} } });
  assert.equal(ext.get('external:grok-bot').mcpCalls, before + 1);
  ext.disable('external:grok-bot');
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 403);
  ext.enable('external:grok-bot');
  assert.throws(() => ext.setMcpLevel('external:grok-bot', 'admin'), /权限只能是/);
});
