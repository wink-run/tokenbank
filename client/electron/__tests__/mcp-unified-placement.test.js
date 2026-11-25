'use strict';
// 应用配置里只有一条 tokenbank：每个 MCP 只记给哪些应用用；要用应用环境的由应用里的桥起，其它在网关里起。
// 依赖某个应用自己东西的 MCP 标成那个应用专属，不能给别的应用。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-unified-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const localStats = require('../local-stats');
const mcpManager = require('../mcp-manager');
const placement = require('../mcp-placement');
const targets = require('../mcp-agent-targets');

function withDb(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-unified-db-'));
  localStats.close();
  mcpManager._seeded = false;
  assert.ok(localStats.init(dir, { force: true }));
  const origSync = mcpManager.syncToClients;
  const saved = { inst: targets.listInstalledClientIds, en: targets.listSyncEnabledClientIds };
  mcpManager.syncToClients = () => ({ success: true, results: [] });
  targets.listInstalledClientIds = () => ['cursor', 'codex', 'workbuddy'];
  targets.listSyncEnabledClientIds = () => ['cursor', 'codex', 'workbuddy'];
  try { return fn(localStats.getDb()); } finally {
    mcpManager.syncToClients = origSync;
    targets.listInstalledClientIds = saved.inst;
    targets.listSyncEnabledClientIds = saved.en;
    localStats.close();
    mcpManager._seeded = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function insert(db, id, name, cmd, args, meta, extra = {}) {
  const now = Date.now();
  db.prepare(`INSERT INTO mcp_servers (id, name, display_name, type, command, args, url, env, builtin, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', 0, 'active', ?, ?, ?)`)
    .run(id, name, name, extra.type || 'stdio', cmd, JSON.stringify(args), extra.url || null, JSON.stringify(meta), now, now);
}
const metaOf = (db, id) => JSON.parse(db.prepare('SELECT metadata FROM mcp_servers WHERE id = ?').get(id).metadata);

test('在哪里跑：文件、git、浏览器、电脑操作在应用里；远程地址和其它在网关里；手动指定为准', () => {
  assert.equal(placement.runsIn({ name: 'filesystem', command: 'npx', args: ['@modelcontextprotocol/server-filesystem'] }), 'app');
  assert.equal(placement.runsIn({ name: 'computer-use', command: './x' }), 'app');
  assert.equal(placement.runsIn({ name: 'github', command: 'npx', args: ['@modelcontextprotocol/server-github'] }), 'gateway');
  assert.equal(placement.runsIn({ name: 'browser', type: 'http', url: 'http://127.0.0.1:9/mcp' }), 'gateway');
  assert.equal(placement.runsIn({ name: 'github', command: 'x', metadata: { runs_in: 'app' } }), 'app');
});

test('认专属：命令在应用目录或程序包里、或是应用在本机开的服务；Token Bank 自己的地址和普通命令不算', () => {
  const codexPlugin = path.join(HOME, '.codex', 'plugins', 'cache', 'computer-use');
  assert.equal(placement.detectExclusiveOwner({ command: './Codex Computer Use.app/Contents/MacOS/cu', metadata: { cwd: codexPlugin, originAgents: ['codex'] } }), 'codex');
  assert.equal(placement.detectExclusiveOwner({ command: '/Applications/Cursor.app/Contents/Resources/mcp', metadata: { originAgents: ['cursor'] } }), 'cursor');
  assert.equal(placement.detectExclusiveOwner({ type: 'http', url: 'http://127.0.0.1:53111/connector-proxy/mcp', metadata: { originAgents: ['workbuddy'] } }), 'workbuddy');
  assert.equal(placement.detectExclusiveOwner({ type: 'http', url: 'http://127.0.0.1:11430/mcp/cursor', metadata: { originAgents: ['cursor'] } }, { gatewayPorts: [11430] }), '');
  assert.equal(placement.detectExclusiveOwner({ type: 'http', url: 'https://api.example.com/mcp', metadata: { originAgents: ['cursor'] } }), '');
  assert.equal(placement.detectExclusiveOwner({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], metadata: { originAgents: ['cursor'] } }), '');
  assert.equal(placement.allowedFor({ metadata: { exclusive_to: 'codex' } }, 'codex-desktop'), true, '别名算同一个应用');
  assert.equal(placement.allowedFor({ metadata: { exclusive_to: 'codex' } }, 'cursor'), false);
});

test('升级：以前写进应用配置的并进「给哪些应用用」；导入的认一次专属，给了别的应用的撤掉', () => {
  withDb((db) => {
    insert(db, 'mcp-fs', 'filesystem', 'npx', ['@modelcontextprotocol/server-filesystem', '/tmp'],
      { sync_clients: ['cursor', 'workbuddy'], gateway_clients: ['app-api1'] });
    insert(db, 'mcp-cu', 'computer-use', './Codex Computer Use.app/cu', ['mcp'],
      { origin: 'client_scan', originAgents: ['codex'], cwd: path.join(HOME, '.codex', 'plugins', 'cu'), sync_clients: ['cursor', 'codex'], description: '客户端自配 · cu' });
    mcpManager.init();
    const fsMeta = metaOf(db, 'mcp-fs');
    assert.deepEqual(fsMeta.sync_clients, []);
    assert.deepEqual([...fsMeta.gateway_clients].sort(), ['cursor', 'workbuddy'], 'API 应用起不了在应用里跑的，撤掉');
    const cu = metaOf(db, 'mcp-cu');
    assert.equal(cu.exclusive_to, 'codex');
    assert.deepEqual(cu.gateway_clients, ['codex'], '给 Cursor 的撤掉，只留 Codex');
    assert.equal(cu.description, 'cu', '导入的和 Token Bank 加的一样看待，描述不写来源');
    // 列表里只剩 tokenbank 写进应用配置
    const row = mcpManager.getServer('mcp-fs');
    assert.deepEqual(row.sync_clients, []);
    assert.equal(row.runs_in, 'app');
    assert.equal(mcpManager.getServer('mcp-cu').exclusive_to, 'codex');
  });
});

test('专属的不能给别的应用；在应用里跑的不能给 API 应用', () => {
  withDb((db) => {
    mcpManager.init();
    insert(db, 'mcp-cu', 'computer-use', '/x/cu', [], { exclusive_to: 'codex', gateway_clients: [] });
    assert.throws(() => mcpManager.setServerGatewayRouted('mcp-cu', true, ['cursor']), /Codex 专属/);
    assert.equal(mcpManager.setServerGatewayRouted('mcp-cu', true, ['codex']).success, true);
    // 一起选时只给能给的
    insert(db, 'mcp-fs', 'filesystem', 'npx', ['@modelcontextprotocol/server-filesystem'], { gateway_clients: [] });
    const gwTargets = require('../mcp-gateway-targets');
    const orig = gwTargets.isAllowedGatewayClientId;
    gwTargets.isAllowedGatewayClientId = (id) => id !== 'api';
    try {
      assert.throws(() => mcpManager.setServerGatewayRouted('mcp-fs', true, ['app-api1']), /在应用里跑/);
      const r = mcpManager.setServerGatewayRouted('mcp-fs', true, ['cursor', 'app-api1']);
      assert.deepEqual(r.gateway_clients, ['cursor']);
    } finally {
      gwTargets.isAllowedGatewayClientId = orig;
    }
  });
});

test('手动标 / 取消专属：标上时撤掉给别的应用的', () => {
  withDb((db) => {
    mcpManager.init();
    insert(db, 'mcp-x', 'proxy', '/x/p', [], { gateway_clients: ['cursor', 'workbuddy'], gateway_routed: true });
    mcpManager.setServerExclusive('mcp-x', 'workbuddy');
    let m = metaOf(db, 'mcp-x');
    assert.equal(m.exclusive_to, 'workbuddy');
    assert.deepEqual(m.gateway_clients, ['workbuddy']);
    mcpManager.setServerExclusive('mcp-x', '');
    m = metaOf(db, 'mcp-x');
    assert.equal(m.exclusive_to, undefined);
    assert.equal(m.exclusive_checked, true, '取消后不再自动认回去');
  });
});

test('应用里要起的清单：给了它、在应用里跑、不是别人专属、它自己配置里没有', () => {
  withDb((db) => {
    mcpManager.init();
    insert(db, 'mcp-fs', 'filesystem', 'npx', ['@modelcontextprotocol/server-filesystem'], { gateway_clients: ['cursor', 'codex'] });
    insert(db, 'mcp-gh', 'github', 'npx', ['@modelcontextprotocol/server-github'], { gateway_clients: ['cursor'] });
    insert(db, 'mcp-cu', 'computer-use', './cu', ['mcp'], { cwd: '/plugins/cu', exclusive_to: 'codex', gateway_clients: ['codex', 'cursor'] });
    const ids = (cid) => mcpManager.listAppLocalServers(cid).map((s) => s.id).sort();
    assert.deepEqual(ids('cursor'), ['mcp-fs']);
    assert.deepEqual(ids('codex'), ['mcp-cu', 'mcp-fs']);
    const cu = mcpManager.listAppLocalServers('codex').find((s) => s.id === 'mcp-cu');
    assert.equal(cu.command, path.resolve('/plugins/cu', './cu'), '相对路径的命令换成绝对路径');
    assert.equal(cu.prefix, 'computer-use');
    // 网关不起在应用里跑的
    assert.deepEqual(mcpManager.listGatewayRoutedServers().map((s) => s.id), ['mcp-gh']);
    // 用户自己在 Cursor 配置里配了 filesystem：不再重复起
    fs.mkdirSync(path.join(HOME, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['x'] } } }));
    require('../mcp-client-sync').invalidateScanCache();
    try {
      assert.deepEqual(ids('cursor'), []);
    } finally {
      fs.rmSync(path.join(HOME, '.cursor'), { recursive: true, force: true });
      require('../mcp-client-sync').invalidateScanCache();
    }
  });
});

test('同步只往应用配置里写 tokenbank 一条', () => {
  const { getServerSyncClients } = require('../mcp-client-sync');
  const saved = { inst: targets.listInstalledClientIds, en: targets.listSyncEnabledClientIds };
  targets.listInstalledClientIds = () => ['cursor'];
  targets.listSyncEnabledClientIds = () => ['cursor'];
  try {
    assert.deepEqual(getServerSyncClients({ id: 'tokenbank', sync_clients: ['cursor'] }), ['cursor']);
    assert.deepEqual(getServerSyncClients({ id: 'mcp-fs', name: 'filesystem', sync_clients: ['cursor'] }), []);
  } finally {
    targets.listInstalledClientIds = saved.inst;
    targets.listSyncEnabledClientIds = saved.en;
  }
});

test('导入时自动写的描述不带来源', () => {
  const { inferClientMcpDescription } = require('../mcp-client-sync');
  assert.equal(inferClientMcpDescription({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }), '@modelcontextprotocol/server-github');
  assert.equal(inferClientMcpDescription({ url: 'https://x.dev/mcp' }), 'https://x.dev/mcp');
});
