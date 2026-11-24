'use strict';
// 写进应用配置的 tokenbank 条目：一个启动脚本（带应用 id），按 sync_clients 下发；旧的四条清掉
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sync = require('../mcp-client-sync');
const mcpTargets = require('../mcp-agent-targets');

const row = {
  id: 'tokenbank', name: 'tokenbank', status: 'active',
  command: '__DYNAMIC_ELECTRON__', args: '[]', env: '{"ELECTRON_RUN_AS_NODE":"1"}', builtin: 1,
};

function launcherPath(entry) {
  const arg = (entry.args || []).map((a) => String(a).replace(/^"|"$/g, '')).find((a) => /\.(sh|cmd)$/i.test(a));
  return arg || String(entry.command || '');
}

function withInstalledClients(ids, fn) {
  const orig = mcpTargets.listInstalledClientIds;
  mcpTargets.listInstalledClientIds = () => [...ids];
  try { return fn(); } finally { mcpTargets.listInstalledClientIds = orig; }
}

test('serverToEntry: tokenbank 写成启动脚本，转给网关，带应用 id', () => {
  const entry = sync.serverToEntry(row, 'claude-code');
  assert.deepEqual(entry.env || {}, {});
  const file = launcherPath(entry);
  assert.match(path.basename(file), /^tokenbank-claude-code\.(sh|cmd)$/);
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(body.includes('ELECTRON_RUN_AS_NODE'));
  assert.ok(body.includes('tokenbank-mcp-stdio.js'));
  assert.ok(body.includes("TB_CLIENT_ID='claude-code'") || body.includes('TB_CLIENT_ID=claude-code'));
  assert.equal(sync.serverToEntry({ id: 'other', status: 'active', command: '__DYNAMIC_ELECTRON__' }, 'codex'), null);
});

test('serverToEntry: URL/SSE MCP 可写出 url 条目', () => {
  const entry = sync.serverToEntry({
    id: 'mcp-import-connector-proxy', name: 'connector-proxy', status: 'active',
    type: 'sse', command: '', url: 'http://127.0.0.1:50097/mcp', metadata: {},
  }, 'cursor');
  assert.equal(entry.url, 'http://127.0.0.1:50097/mcp');
  assert.equal(entry.type, 'sse');
});

test('filterServersForClient: 按 sync_clients 下发，取消勾选就不下发', () => {
  withInstalledClients(['cursor', 'codex', 'workbuddy'], () => {
    const r = { ...row, sync_clients: ['cursor', 'codex'], metadata: { sync_clients: ['cursor', 'codex'] } };
    assert.equal(sync.filterServersForClient([r], 'cursor').length, 1);
    assert.equal(sync.filterServersForClient([r], 'workbuddy').length, 0);
  });
});

test('同步时清掉应用配置里旧的四条 Token Bank 条目（只清 Token Bank 写的）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-sync-legacy-'));
  const file = path.join(dir, 'mcp.json');
  const ours = { command: '/bin/sh', args: [path.join(os.homedir(), '.tokenbank', 'mcp', 'prompts-cursor.sh')] };
  fs.writeFileSync(file, JSON.stringify({
    mcpServers: {
      'tokenbank-prompts': ours,
      'tokenbank-agent-bridge': { ...ours },
      'tb-tokenbank-models': { ...ours },
      'tokenbank-resources': { command: 'my-own-server' }, // 用户自己配的同名，不动
      github: { command: 'npx', args: ['-y', 'gh'] },
    },
  }));
  try {
    sync.syncJsonClient('legacy-test-client', file, [row]);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(doc.mcpServers).sort(), ['github', 'tokenbank', 'tokenbank-resources']);
    assert.equal(doc.mcpServers['tokenbank-resources'].command, 'my-own-server');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
