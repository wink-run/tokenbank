'use strict';
// 应用的 tokenbank 条目里，给这个应用的第三方 MCP 原样列出（不藏在 tb_call_mcp 后面）；
// 用户自己在应用配置里配过的不再经网关列一遍；别的应用专属的不给
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-app-scope-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const relay = require('../mcp-gateway-server');

let fake;
let url;
const calls = [];
test.before(async () => {
  fake = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const msg = JSON.parse(b || '{}');
      const reply = (result) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); };
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
      if (msg.method === 'tools/list') {
        return reply({ tools: [{ name: 'post_message', description: 'Post a message', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } }] });
      }
      if (msg.method === 'tools/call') { calls.push(msg.params); return reply({ content: [{ type: 'text', text: 'sent' }] }); }
      if (!msg.id) { res.writeHead(202); return res.end(); }
      return reply({});
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${fake.address().port}/mcp`;
});
test.after(() => { relay.stopMcpGateway(); fake.close(); });

const rows = (extra = {}) => [{ id: 'mcp-chat', name: 'chat', display_name: 'Chat', type: 'http', url, status: 'active', metadata: {}, gateway_clients: ['cursor'], sync_clients: [], ...extra }];

async function list(cid, scope = 'app') {
  const r = await relay.handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, cid, { scope });
  return r.result.tools.map((t) => t.name);
}

test('给这个应用的第三方 MCP 原样列在 tokenbank 条目里，可以直接调用；别的应用看不到', async () => {
  relay.attachToGateway({ port: 1, listRoutedFn: () => rows() });
  const names = await list('cursor');
  assert.ok(names.includes('tb_list_agents'), 'Token Bank 自己的工具还在');
  assert.ok(names.includes('chat__post_message'), '第三方工具原样列出');
  assert.ok(!(await list('codex')).includes('chat__post_message'), '没给 codex 的不列');
  assert.ok(!(await list('cursor', 'tokenbank')).includes('chat__post_message'), 'scope=tokenbank 只要自己的');
  const r = await relay.handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'chat__post_message', arguments: { channel: '#a', text: 'hi' } } }, 'cursor', { scope: 'app' });
  assert.equal(r.result.content[0].text, 'sent');
  assert.deepEqual(calls.at(-1), { name: 'post_message', arguments: { channel: '#a', text: 'hi' } });
});

test('用户自己在这个应用配置里配过同一条的，不再经网关重复列出', async () => {
  relay.setOwnConfigCheck((cid, row) => cid === 'cursor' && row.name === 'chat');
  try {
    relay.attachToGateway({ port: 1, listRoutedFn: () => rows() });
    relay.reloadMcpGateway();
    assert.ok(!(await list('cursor')).includes('chat__post_message'));
  } finally {
    relay.setOwnConfigCheck(() => false);
  }
});

test('别的应用专属的 MCP 不给这个应用', async () => {
  relay.attachToGateway({ port: 1, listRoutedFn: () => rows({ gateway_clients: ['cursor', 'workbuddy'], metadata: { exclusive_to: 'workbuddy' } }) });
  relay.reloadMcpGateway();
  assert.ok(!(await list('cursor')).includes('chat__post_message'));
  assert.ok((await list('workbuddy')).includes('chat__post_message'));
});
