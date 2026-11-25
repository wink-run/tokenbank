'use strict';
// Token Bank 自己的 MCP 只有一条 tokenbank：旧的四条升级时合进来；中转按应用的权限在进程内给工具。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const localStats = require('../local-stats');
const mcpManager = require('../mcp-manager');
const gw = require('../mcp-gateway-targets');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-relay-'));
  localStats.close();
  mcpManager._seeded = false;
  assert.ok(localStats.init(dir, { force: true }));
  try { return fn(); } finally {
    localStats.close();
    mcpManager._seeded = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

test('升级：旧的四条内置 MCP 合成一条 tokenbank，投射和中转取并集，旧行删掉', () => {
  withDb(() => {
    const origSync = mcpManager.syncToClients;
    let synced = 0;
    mcpManager.syncToClients = () => { synced += 1; return { success: true, results: [] }; };
    try {
      const db = localStats.getDb();
      const now = Date.now();
      const legacy = {
        'tokenbank-agent-bridge': { sync_clients: ['cursor'] },
        'tokenbank-models': { sync_clients: ['cursor', 'codex'], gateway_clients: ['api'] },
        'tokenbank-resources': { sync_clients: ['codex'], gateway_clients: ['api', 'trae-work'] },
      };
      for (const [id, meta] of Object.entries(legacy)) {
        db.prepare(`INSERT INTO mcp_servers (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
          VALUES (?, ?, ?, 'stdio', '__DYNAMIC_ELECTRON__', '[]', '{}', 1, 'active', ?, ?, ?)`).run(id, id, id, JSON.stringify(meta), now, now);
      }
      mcpManager.init();
      for (const id of Object.keys(legacy)) assert.equal(mcpManager.getServer(id), null, id);
      const row = db.prepare('SELECT metadata FROM mcp_servers WHERE id = ?').get('tokenbank');
      const meta = JSON.parse(row.metadata);
      // 旧的都在（本机装了的应用也会被默认补上）
      assert.ok(meta.sync_clients.includes('codex') && meta.sync_clients.includes('cursor'), meta.sync_clients.join(','));
      assert.deepEqual([...meta.gateway_clients].sort(), ['api', 'trae-work']);
      assert.equal(meta.tools.length, 11);
      assert.ok(synced >= 1, '升级后重写应用配置，清掉旧的四条');
    } finally {
      mcpManager.syncToClients = origSync;
    }
  });
});

test('中转：Token Bank 的工具在进程内按应用的权限给；只要 tokenbank 时不带第三方 MCP', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-access-'));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const relay = require('../mcp-gateway-server');
    const access = require('../mcp-access');
    const list = async (cid) => (await relay.handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, cid, { scope: 'tokenbank' })).result.tools.map((t) => t.name);
    assert.equal(access.appLevel('cursor'), 'full');
    assert.equal((await list('cursor')).length, 11);
    access.setAppLevel('cursor', 'read');
    const names = await list('cursor');
    assert.ok(names.includes('tb_list_agents') && !names.includes('tb_dispatch_agent'));
    const denied = await relay.handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tb_chat', arguments: { model: 'x', prompt: 'y' } } }, 'cursor', { scope: 'tokenbank' });
    assert.equal(denied.result.isError, true);
    access.setAppLevel('cursor', 'off');
    assert.deepEqual(await list('cursor'), []);
    assert.ok((await list('guardian-chat')).includes('tb_save_resource'), '智能管家多一组改资产的工具');
    const init = await relay.handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }, 'cursor', { scope: 'tokenbank' });
    assert.equal(init.result.serverInfo.name, 'tokenbank');
    assert.match(init.result.instructions, /tb_dispatch_agent/);
  } finally {
    process.env.HOME = prevHome;
  }
});

test('isAllowedGatewayClientId：非法 id 拒绝；已删除的 app-* 不再放行', () => {
  assert.equal(gw.isAllowedGatewayClientId('这不是合法id!!'), false);
  gw.setAppsGetter(() => []);
  assert.equal(gw.isAllowedGatewayClientId('app-abc123'), false);
  gw.setAppsGetter(() => [{ id: 'app-abc123', link_method: 'manual', name: 'demo', draft: false }]);
  assert.equal(gw.isAllowedGatewayClientId('app-abc123'), true);
  gw.setAppsGetter(null);
});

test('unbindClient 清掉已删应用的中转与投射', () => {
  withDb(() => {
    const origSync = mcpManager.syncToClients;
    mcpManager.syncToClients = () => ({ success: true, results: [] });
    try {
      mcpManager.init();
      const db = localStats.getDb();
      const now = Date.now();
      for (const id of ['tokenbank']) {
        const row = db.prepare('SELECT metadata FROM mcp_servers WHERE id = ?').get(id);
        const meta = JSON.parse(row.metadata || '{}');
        meta.gateway_clients = ['api', 'app-deadbeef'];
        meta.gateway_routed = true;
        meta.sync_clients = ['cursor', 'app-deadbeef'];
        db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(meta), now, id);
      }
      const r = mcpManager.unbindClient('app-deadbeef');
      assert.ok(r.updated >= 1);
      for (const id of ['tokenbank']) {
        const s = mcpManager.getServer(id);
        assert.ok(!(s.gateway_clients || []).includes('app-deadbeef'), id);
        assert.ok(!(s.sync_clients || []).includes('app-deadbeef'), id);
        assert.ok((s.gateway_clients || []).includes('api'), id);
      }
    } finally {
      mcpManager.syncToClients = origSync;
    }
  });
});

test('pruneStaleDeletedAppBindings 清掉列表里已不存在的 app-*', () => {
  withDb(() => {
    const origSync = mcpManager.syncToClients;
    mcpManager.syncToClients = () => ({ success: true, results: [] });
    gw.setAppsGetter(() => []);
    try {
      mcpManager.init();
      const db = localStats.getDb();
      const now = Date.now();
      const row = db.prepare('SELECT metadata FROM mcp_servers WHERE id = ?').get('tokenbank');
      const meta = JSON.parse(row.metadata || '{}');
      meta.gateway_clients = ['api', 'app-gone'];
      meta.gateway_routed = true;
      db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(meta), now, 'tokenbank');
      const r = mcpManager.pruneStaleDeletedAppBindings();
      assert.ok(r.stale.includes('app-gone'));
      const s = mcpManager.getServer('tokenbank');
      assert.ok(!(s.gateway_clients || []).includes('app-gone'));
      assert.ok((s.gateway_clients || []).includes('api'));
    } finally {
      mcpManager.syncToClients = origSync;
      gw.setAppsGetter(null);
    }
  });
});

test('要用应用项目目录的本地 MCP 直接写进应用配置，其它经网关', () => {
  const { needsAppContext } = mcpManager;
  assert.equal(needsAppContext({ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'] }), true);
  assert.equal(needsAppContext({ name: 'my-tools', command: 'npx', args: ['-y', '@playwright/mcp'] }), true);
  assert.equal(needsAppContext({ name: 'git', command: 'uvx', args: ['mcp-server-git'] }), true);
  assert.equal(needsAppContext({ name: 'search', type: 'http', url: 'https://x/mcp' }), false, '远程的走网关');
  assert.equal(needsAppContext({ name: 'pipeworx', command: 'npx', args: ['-y', '@pipeworx/mcp'] }), false);
  assert.equal(needsAppContext({ name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }), false, 'github 是远程服务，不是本地 git');
});

test('以前经网关给了应用的本地 MCP（电脑操作等）改成写进应用配置；API 应用留在网关', () => {
  withDb(() => {
    const origSync = mcpManager.syncToClients;
    mcpManager.syncToClients = () => ({ success: true, results: [] });
    const targets = require('../mcp-agent-targets');
    const saved = { inst: targets.listInstalledClientIds, en: targets.listSyncEnabledClientIds };
    targets.listInstalledClientIds = () => ['cursor', 'workbuddy'];
    targets.listSyncEnabledClientIds = () => ['cursor', 'workbuddy', 'codex'];
    try {
      mcpManager.init();
      const db = localStats.getDb();
      const now = Date.now();
      db.prepare(`INSERT INTO mcp_servers (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES ('mcp-cu', 'computer-use', 'computer-use', 'stdio', './Codex Computer Use.app/x', '["mcp"]', '{}', 0, 'active', ?, ?, ?)`)
        .run(JSON.stringify({ gateway_clients: ['cursor', 'workbuddy', 'app-api1'], gateway_routed: true }), now, now);
      assert.equal(mcpManager._moveAppContextToConfig(), 1);
      const meta = JSON.parse(db.prepare("SELECT metadata FROM mcp_servers WHERE id = 'mcp-cu'").get().metadata);
      assert.deepEqual([...meta.sync_clients].sort(), ['cursor', 'workbuddy']);
      assert.deepEqual(meta.gateway_clients, ['app-api1']);
    } finally {
      mcpManager.syncToClients = origSync;
      targets.listInstalledClientIds = saved.inst;
      targets.listSyncEnabledClientIds = saved.en;
    }
  });
});
