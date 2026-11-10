'use strict';
// 目录/自定义纳管第三方 MCP 后，默认中转到全部已纳管应用
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const localStats = require('../local-stats');
const mcpManager = require('../mcp-manager');
const gw = require('../mcp-gateway-targets');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-relay-'));
  localStats.close();
  mcpManager._seeded = false;
  assert.ok(localStats.init(dir, { force: true }));
  const origSync = mcpManager.syncToClients;
  mcpManager.syncToClients = () => ({ success: true, results: [] });
  try {
    return fn();
  } finally {
    mcpManager.syncToClients = origSync;
    gw.setAppsGetter(null);
    localStats.close();
    mcpManager._seeded = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function stubManagedApps(apps) {
  gw.setAppsGetter(() => apps);
}

test('installFromCatalog: 默认中转到已纳管应用（含不可写盘的 OpenClaw / API 应用）', () => {
  withDb(() => {
    stubManagedApps([
      { agent_id: 'cursor', hosted: true, link_method: 'shim', draft: false },
      { agent_id: 'claude-desktop', hosted: true, link_method: 'shim', draft: false },
      { agent_id: 'openclaw', hosted: true, link_method: 'shim', draft: false },
      { id: 'app-abc', hosted: true, link_method: 'manual', draft: false, name: 'API' },
    ]);
    mcpManager.init();
    const res = mcpManager.installFromCatalog('pipeworx');
    assert.equal(res.success, true);
    const server = mcpManager.getServer('mcp-pipeworx');
    assert.ok(server);
    const ids = new Set(server.gateway_clients || []);
    assert.ok(ids.has('cursor'));
    assert.ok(ids.has('claude-code'), 'claude-desktop 应归一到 claude-code');
    assert.ok(ids.has('openclaw'), '不可写盘应用也应中转');
    assert.ok(ids.has('app-abc'));
    assert.equal((server.sync_clients || []).length, 0, '第三方默认不写盘投射');
  });
});

test('installFromCatalog: 已有 gateway_clients 不覆盖用户勾选', () => {
  withDb(() => {
    stubManagedApps([
      { agent_id: 'cursor', hosted: true, link_method: 'shim', draft: false },
      { agent_id: 'codex', hosted: true, link_method: 'shim', draft: false },
    ]);
    mcpManager.init();
    mcpManager.installFromCatalog('pipeworx');
    mcpManager.setServerGatewayRouted('mcp-pipeworx', false);
    mcpManager.setServerGatewayRouted('mcp-pipeworx', true, ['cursor']);
    const again = mcpManager.installFromCatalog('pipeworx');
    assert.equal(again.success, true);
    assert.deepEqual(mcpManager.getServer('mcp-pipeworx').gateway_clients, ['cursor']);
  });
});

test('saveServer 新建自定义 MCP：默认中转到已纳管应用', () => {
  withDb(() => {
    stubManagedApps([
      { agent_id: 'codex', hosted: true, link_method: 'shim', draft: false },
    ]);
    mcpManager.init();
    const res = mcpManager.saveServer({
      id: 'mcp-custom-demo',
      name: 'demo',
      display_name: 'Demo',
      type: 'http',
      url: 'https://example.com/mcp',
    });
    assert.equal(res.success, true);
    assert.deepEqual(mcpManager.getServer('mcp-custom-demo').gateway_clients, ['codex']);
  });
});

test('saveServer API 与本地 CLI 不进入 MCP 中转', () => {
  withDb(() => {
    stubManagedApps([
      { agent_id: 'codex', hosted: true, link_method: 'shim', draft: false },
    ]);
    mcpManager.init();
    const api = mcpManager.saveServer({
      id: 'tool-api-demo',
      name: 'demo-api',
      display_name: 'Demo API',
      type: 'http',
      url: 'https://example.com/v1/search',
      tool_kind: 'api',
      method: 'GET',
    });
    assert.equal(api.success, true);
    assert.equal(api.server.metadata.tool_kind, 'api');
    assert.equal(api.server.metadata.method, 'GET');
    assert.equal((api.server.gateway_clients || []).length, 0);

    const cli = mcpManager.saveServer({
      id: 'tool-cli-demo',
      name: 'demo-cli',
      display_name: 'Demo CLI',
      type: 'stdio',
      command: 'echo',
      args: ['hi'],
      tool_kind: 'cli',
    });
    assert.equal(cli.success, true);
    assert.equal(cli.server.metadata.tool_kind, 'cli');
    assert.equal((cli.server.gateway_clients || []).length, 0);
  });
});

test('listRelayedMcpsForClient: 按应用过滤并带出 Pipeworx 工具名', () => {
  withDb(() => {
    stubManagedApps([
      { agent_id: 'cursor', hosted: true, link_method: 'shim', draft: false },
    ]);
    mcpManager.init();
    mcpManager.installFromCatalog('pipeworx');
    const forCursor = mcpManager.listRelayedMcpsForClient('cursor');
    const hit = forCursor.find((s) => s.name === 'pipeworx');
    assert.ok(hit, 'cursor 应看到 pipeworx');
    assert.equal(hit.prefix, 'pipeworx');
    assert.ok(hit.tools.includes('ask_pipeworx'));
    assert.equal(mcpManager.resolveRelayedMcpForClient('cursor', 'Pipeworx')?.id, 'mcp-pipeworx');
    assert.equal(mcpManager.listRelayedMcpsForClient('codex').length, 0);
  });
});

