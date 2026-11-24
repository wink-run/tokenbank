'use strict';
// Windows MCP：.cmd launcher + 缺省 mcp.json 可创建
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  writeElectronAsNodeLauncher,
  writeTokenbankLauncher,
  mcpStdioFromLauncher,
} = require('../mcp-manager');
const { syncJsonClient, syncCodexClient } = require('../mcp-client-sync');

test('writeElectronAsNodeLauncher(platform=win32) 生成 .cmd 并内嵌 ELECTRON_RUN_AS_NODE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-win-'));
  try {
    const launcher = writeElectronAsNodeLauncher({
      name: 'prompts-test',
      scriptPath: path.join(__dirname, '..', 'tokenbank-mcp-stdio.js'),
      env: { TB_CLIENT_ID: 'workbuddy' },
      platform: 'win32',
      mcpDir: dir,
    });
    assert.ok(launcher.endsWith('.cmd'), launcher);
    const body = fs.readFileSync(launcher, 'utf8');
    assert.ok(body.includes('@echo off'));
    assert.ok(body.includes('ELECTRON_RUN_AS_NODE'));
    assert.ok(body.includes('TB_CLIENT_ID'));
    assert.ok(body.includes('tokenbank-mcp-stdio.js'));
    assert.ok(!body.includes('#!/bin/bash'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeElectronAsNodeLauncher unix 用 #!/bin/sh（Alpine/Docker 无 bash）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-sh-'));
  try {
    const launcher = writeElectronAsNodeLauncher({
      name: 'models-test',
      scriptPath: path.join(__dirname, '..', 'tokenbank-mcp-stdio.js'),
      platform: 'linux',
      mcpDir: dir,
    });
    assert.ok(launcher.endsWith('.sh'), launcher);
    const body = fs.readFileSync(launcher, 'utf8');
    assert.ok(body.startsWith('#!/bin/sh\n'), body.slice(0, 40));
    assert.ok(!body.includes('#!/bin/bash'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeTokenbankLauncher(platform=win32) 生成 tokenbank-<应用>.cmd，带应用 id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-tokenbank-'));
  try {
    const launcher = writeTokenbankLauncher({ clientId: 'codex', mcpDir: dir, platform: 'win32' });
    assert.ok(launcher.endsWith('tokenbank-codex.cmd'), launcher);
    const body = fs.readFileSync(launcher, 'utf8');
    assert.ok(body.includes('TB_CLIENT_ID=codex'));
    assert.ok(body.includes('tokenbank-mcp-stdio.js'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mcpStdioFromLauncher: win32 cmd.exe /c；unix/docker /bin/sh 读脚本', () => {
  const { resolveUnixShell, resolveCmdExe } = require('../host-exec');
  const darwin = mcpStdioFromLauncher('/tmp/foo.sh', {}, 'darwin');
  assert.equal(darwin.command, resolveUnixShell());
  assert.deepEqual(darwin.args, ['/tmp/foo.sh']);

  const linux = mcpStdioFromLauncher('/tmp/foo.sh', {}, 'linux');
  assert.equal(linux.command, resolveUnixShell());
  assert.deepEqual(linux.args, ['/tmp/foo.sh']);

  const win = mcpStdioFromLauncher('C:\\Users\\x\\.tokenbank\\mcp\\a.cmd', {}, 'win32');
  assert.equal(win.command, resolveCmdExe());
  assert.deepEqual(win.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(String(win.args[3]).includes('a.cmd'));
});

test('syncJsonClient: 清掉 leftover tokenbank 条目并原地更新，不叠 tb- 重复', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-reclaim-'));
  const filePath = path.join(dir, 'mcp.json');
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({
      mcpServers: {
        'tokenbank': {
          command: '/Users/x/.tokenbank/mcp/tokenbank-workbuddy.sh',
          args: [],
        },
        'tb-tokenbank': {
          command: '/bin/bash',
          args: ['/Users/x/.tokenbank/mcp/tokenbank-workbuddy.sh'],
        },
        'keep-me': { command: 'npx', args: ['foo'] },
      },
    }, null, 2)}\n`);
    const ok = syncJsonClient('test-reclaim-client', filePath, [{
      id: 'tokenbank', name: 'tokenbank', status: 'active',
      command: '__DYNAMIC_ELECTRON__', builtin: 1,
    }], { allowCreate: false });
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(doc.mcpServers['keep-me']);
    assert.ok(doc.mcpServers['tokenbank'], Object.keys(doc.mcpServers));
    assert.equal(doc.mcpServers['tb-tokenbank'], undefined);
    assert.equal(ok.synced.length, 1);
    assert.deepEqual(ok.keys, ['tokenbank']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncJsonClient: 缺文件且 allowCreate → 新建并写入 MCP', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-json-'));
  const filePath = path.join(dir, 'mcp.json');
  try {
    assert.equal(fs.existsSync(filePath), false);
    const denied = syncJsonClient('workbuddy', filePath, [{
      id: 's1', name: 'demo', status: 'active',
      command: 'npx', args: ['-y', 'demo-mcp'],
    }], { allowCreate: false });
    assert.equal(denied.reason, 'config-missing');
    assert.equal(fs.existsSync(filePath), false);

    const ok = syncJsonClient('workbuddy', filePath, [{
      id: 's1', name: 'demo', status: 'active',
      command: 'npx', args: ['-y', 'demo-mcp'],
    }], { allowCreate: true });
    assert.equal(ok.skipped, undefined);
    assert.equal(ok.synced.length, 1);
    assert.ok(fs.existsSync(filePath));
    const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.ok(doc.mcpServers.demo || doc.mcpServers['tb-demo'] || Object.keys(doc.mcpServers).length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncCodexClient: 缺 config.toml 且 allowCreate → 新建并写入 mcp_servers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mcp-toml-'));
  const filePath = path.join(dir, 'config.toml');
  try {
    const denied = syncCodexClient('codex', filePath, [{
      id: 's1', name: 'demo', status: 'active',
      command: 'npx', args: ['-y', 'demo-mcp'],
    }], [], { allowCreate: false });
    assert.equal(denied.reason, 'config-missing');

    const ok = syncCodexClient('codex', filePath, [{
      id: 's1', name: 'demo', status: 'active',
      command: 'npx', args: ['-y', 'demo-mcp'],
    }], [], { allowCreate: true });
    assert.ok(fs.existsSync(filePath));
    const text = fs.readFileSync(filePath, 'utf8');
    assert.ok(text.includes('[mcp_servers.demo]') || text.includes('mcp_servers'));
    assert.ok(text.includes('tokenbank-mcp'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
