'use strict';
// tokenbank-prompts 的下发规则:有投射才同步,物化为 Electron-as-node + TB_CLIENT_ID
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const resourceManager = require('../resource-manager');
const sync = require('../mcp-client-sync');
const mcpTargets = require('../mcp-agent-targets');

const promptsRow = {
  id: 'tokenbank-prompts', name: 'tokenbank-prompts', status: 'active',
  command: '__DYNAMIC_ELECTRON__', args: '[]', env: '{"ELECTRON_RUN_AS_NODE":"1"}', builtin: 1,
};

/** darwin/linux/docker 经 /bin/sh 包装；Windows 经 cmd.exe */
function unixLauncherPath(entry) {
  const { resolveUnixShell } = require('../host-exec');
  assert.equal(entry.command, resolveUnixShell());
  return String(entry.args && entry.args[0] || '');
}

/** CI 无本机 Agent 安装时，getServerSyncClients 会把 sync_clients 滤空；测试里 stub 已装列表 */
function withInstalledClients(ids, fn) {
  const orig = mcpTargets.listInstalledClientIds;
  mcpTargets.listInstalledClientIds = () => [...ids];
  try { return fn(); }
  finally { mcpTargets.listInstalledClientIds = orig; }
}

test('serverToEntry: prompts server 物化为 shell launcher（内嵌 ELECTRON_RUN_AS_NODE）', () => {
  const entry = sync.serverToEntry(promptsRow, 'claude-code');
  assert.deepEqual(entry.env || {}, {});
  const isWin = process.platform === 'win32';
  if (isWin) {
    assert.match(String(entry.command), /cmd\.exe$/i);
    assert.ok(entry.args.some((a) => /prompts-claude-code\.cmd/i.test(String(a))), entry.args);
    const cmdPath = String(entry.args.find((a) => /\.cmd/i.test(String(a)))).replace(/^"|"$/g, '');
    const sh = require('fs').readFileSync(cmdPath, 'utf8');
    assert.ok(sh.includes('ELECTRON_RUN_AS_NODE'));
    assert.ok(sh.includes('prompt-mcp.js'));
    assert.ok(sh.includes('TB_CLIENT_ID'));
  } else {
    const launcher = unixLauncherPath(entry);
    assert.ok(launcher.endsWith('prompts-claude-code.sh'), launcher);
    const sh = require('fs').readFileSync(launcher, 'utf8');
    assert.ok(sh.includes('ELECTRON_RUN_AS_NODE=1'));
    assert.ok(sh.includes('prompt-mcp.js'));
    // 即使在系统 Node 下跑测试，launcher 也应指向 Electron 二进制而非 node
    assert.ok(/Electron(\.app|['"])|[/\\]electron['"]/i.test(sh), sh);
    assert.ok(!/[/\\]bin[/\\]node'/.test(sh), 'launcher must not use system node');
    assert.ok(sh.includes("TB_CLIENT_ID='claude-code'") || sh.includes('TB_CLIENT_ID=claude-code'));
  }
});

test('serverToEntry: 派发桥物化为常驻 launcher；其它动态占位仍跳过', () => {
  const entry = sync.serverToEntry({
    id: 'tokenbank-agent-bridge', name: 'tokenbank-agent-bridge', status: 'active',
    command: '__DYNAMIC_ELECTRON__', builtin: 1,
  }, 'cursor');
  assert.ok(entry);
  if (process.platform === 'win32') {
    assert.ok(entry.args.some((a) => /bridge-cursor\.cmd/i.test(String(a))), entry.args);
  } else {
    const launcher = unixLauncherPath(entry);
    assert.ok(launcher.endsWith('bridge-cursor.sh'), launcher);
    const sh = require('fs').readFileSync(launcher, 'utf8');
    assert.ok(sh.includes('agent-dispatch-mcp.js'));
    assert.ok(sh.includes('TB_CLIENT_ID'));
  }
  assert.equal(sync.serverToEntry({ id: 'other', status: 'active', command: '__DYNAMIC_ELECTRON__' }, 'codex'), null);
});

test('serverToEntry: models server 物化为 shell launcher', () => {
  const entry = sync.serverToEntry({
    id: 'tokenbank-models', name: 'tokenbank-models', status: 'active',
    command: '__DYNAMIC_ELECTRON__', args: '[]', env: '{"ELECTRON_RUN_AS_NODE":"1"}', builtin: 1,
  }, 'cursor');
  if (process.platform === 'win32') {
    assert.ok(entry.args.some((a) => /models-cursor\.cmd/i.test(String(a))), entry.args);
  } else {
    const launcher = unixLauncherPath(entry);
    assert.ok(launcher.endsWith('models-cursor.sh'), launcher);
    const sh = require('fs').readFileSync(launcher, 'utf8');
    assert.ok(sh.includes('models-mcp.js'));
    assert.ok(sh.includes('ELECTRON_RUN_AS_NODE=1'));
  }
});

test('serverToEntry: resources server 物化为 shell launcher 并内嵌 TB_CLIENT_ID', () => {
  const entry = sync.serverToEntry({
    id: 'tokenbank-resources', name: 'tokenbank-resources', status: 'active',
    command: '__DYNAMIC_ELECTRON__', args: '[]', env: '{"ELECTRON_RUN_AS_NODE":"1"}', builtin: 1,
  }, 'codex');
  if (process.platform === 'win32') {
    assert.ok(entry.args.some((a) => /resources-codex\.cmd/i.test(String(a))), entry.args);
  } else {
    const launcher = unixLauncherPath(entry);
    assert.ok(launcher.endsWith('resources-codex.sh'), launcher);
    const sh = require('fs').readFileSync(launcher, 'utf8');
    assert.ok(sh.includes('resources-mcp.js'));
    // 与 prompts 一致：否则空 client 会列出全部 assistant
    assert.ok(sh.includes("TB_CLIENT_ID='codex'") || sh.includes('TB_CLIENT_ID=codex'));
  }
});

test('serverToEntry: URL/SSE MCP 可写出 url 条目', () => {
  const entry = sync.serverToEntry({
    id: 'mcp-import-connector-proxy',
    name: 'connector-proxy',
    status: 'active',
    type: 'sse',
    command: '',
    url: 'http://127.0.0.1:50097/mcp',
    metadata: {},
  }, 'cursor');
  assert.ok(entry);
  assert.equal(entry.url, 'http://127.0.0.1:50097/mcp');
  assert.equal(entry.type, 'sse');
  assert.equal(entry.command, undefined);
});

test('filterServersForClient: 无投射的 client 不下发 prompts server', () => {
  const orig = resourceManager.hasPromptProjections;
  resourceManager.hasPromptProjections = (cid) => cid === 'cursor';
  try {
    // 未显式配置 sync_clients → 懒下发，仅有投射的 client
    const withProj = sync.filterServersForClient([promptsRow], 'cursor');
    const withoutProj = sync.filterServersForClient([promptsRow], 'codex');
    assert.equal(withProj.length, 1);
    assert.equal(withoutProj.length, 0);
  } finally { resourceManager.hasPromptProjections = orig; }
});

test('filterServersForClient: 显式 sync_clients 时即使无投射也下发 prompts', () => {
  const orig = resourceManager.hasPromptProjections;
  resourceManager.hasPromptProjections = () => false;
  try {
    withInstalledClients(['workbuddy', 'cursor'], () => {
      const row = {
        ...promptsRow,
        sync_clients: ['workbuddy'],
        metadata: { sync_clients: ['workbuddy'] },
      };
      assert.equal(sync.filterServersForClient([row], 'workbuddy').length, 1);
      assert.equal(sync.filterServersForClient([row], 'cursor').length, 0);
    });
  } finally { resourceManager.hasPromptProjections = orig; }
});

test('filterServersForClient: 取消 sync_clients 勾选后不下发 prompts（即使有投射）', () => {
  const orig = resourceManager.hasPromptProjections;
  resourceManager.hasPromptProjections = () => true;
  try {
    withInstalledClients(['cursor', 'codex', 'workbuddy'], () => {
      const row = {
        ...promptsRow,
        sync_clients: ['cursor', 'codex'],
        metadata: { sync_clients: ['cursor', 'codex'] },
      };
      assert.equal(sync.filterServersForClient([row], 'cursor').length, 1);
      assert.equal(sync.filterServersForClient([row], 'workbuddy').length, 0);
    });
  } finally { resourceManager.hasPromptProjections = orig; }
});
