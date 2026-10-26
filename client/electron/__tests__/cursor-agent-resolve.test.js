'use strict';
// Cursor Agent CLI 探测：官方装在 ~/.local/bin + versions；与 Cursor IDE 纳管口径分离

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shim = require('../shim-installer');

function makeTmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cursor-agent-'));
}

test('looksLikeCursorAgent 识别官方路径', () => {
  assert.equal(shim.looksLikeCursorAgent('/home/u/.local/bin/cursor-agent'), true);
  assert.equal(shim.looksLikeCursorAgent('/home/u/.local/share/cursor-agent/versions/2026.10/cursor-agent'), true);
  assert.equal(shim.looksLikeCursorAgent('C:\\Users\\u\\.local\\share\\cursor-agent\\versions\\x\\cursor-agent.exe'), true);
  assert.equal(shim.looksLikeCursorAgent('/usr/bin/agent'), false);
  assert.equal(shim.looksLikeCursorAgent('/opt/other/agent'), false);
});

test('resolveBundledCursorAgentPath 走 versions 目录兜底', () => {
  const home = makeTmpHome();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // os.homedir() 在部分环境读 Homedir 缓存；用 Object.define 不可靠，这里直接写候选树并依赖 HOME
  // Node os.homedir 优先 env：Linux/mac 看 HOME，Win 看 USERPROFILE
  try {
    const verDir = path.join(home, '.local', 'share', 'cursor-agent', 'versions', '2026.10.22-test');
    fs.mkdirSync(verDir, { recursive: true });
    const bin = path.join(verDir, 'cursor-agent');
    fs.writeFileSync(bin, '#!/bin/sh\necho cursor-agent\n');
    fs.chmodSync(bin, 0o755);

    // 清缓存并临时把 homedir 指到 tmp：shim 内部用 os.homedir()
    const osHomedir = os.homedir;
    os.homedir = () => home;
    shim.clearCommandCache();
    try {
      const got = shim.resolveBundledCursorAgentPath();
      assert.equal(got, fs.realpathSync(bin));
    } finally {
      os.homedir = osHomedir;
    }
  } finally {
    process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('resolveRealCommand(cursor-agent) 命中 ~/.local/bin 软链', () => {
  const home = makeTmpHome();
  const osHomedir = os.homedir;
  os.homedir = () => home;
  shim.clearCommandCache('cursor-agent');
  shim.clearCommandCache('agent');
  try {
    const verDir = path.join(home, '.local', 'share', 'cursor-agent', 'versions', '2026.01.01');
    fs.mkdirSync(verDir, { recursive: true });
    const real = path.join(verDir, 'cursor-agent');
    fs.writeFileSync(real, '#!/bin/sh\necho ok\n');
    fs.chmodSync(real, 0o755);
    const localBin = path.join(home, '.local', 'bin');
    fs.mkdirSync(localBin, { recursive: true });
    fs.symlinkSync(real, path.join(localBin, 'cursor-agent'));
    fs.symlinkSync(real, path.join(localBin, 'agent'));

    const got = shim.resolveRealCommand('cursor-agent');
    assert.ok(got, '应解析到 cursor-agent');
    assert.equal(fs.realpathSync(got), fs.realpathSync(real));
    shim.clearCommandCache('agent');
    const gotAgent = shim.resolveRealCommand('agent');
    assert.ok(gotAgent, '应解析到 agent');
    assert.equal(fs.realpathSync(gotAgent), fs.realpathSync(real));
  } finally {
    os.homedir = osHomedir;
    shim.clearCommandCache();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('resolveRealCommand(agent) 忽略无关的 PATH agent', () => {
  const home = makeTmpHome();
  const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-decoy-agent-'));
  const osHomedir = os.homedir;
  const prevPath = process.env.PATH;
  os.homedir = () => home;
  try {
    const decoy = path.join(decoyDir, 'agent');
    fs.writeFileSync(decoy, '#!/bin/sh\necho decoy\n');
    fs.chmodSync(decoy, 0o755);
    process.env.PATH = `${decoyDir}${path.delimiter}${prevPath || ''}`;
    shim.clearCommandCache('agent');

    // 无官方安装位时：不应把 decoy agent 当成 Cursor
    const got = shim.resolveRealCommand('agent');
    assert.equal(got, null);
  } finally {
    process.env.PATH = prevPath;
    os.homedir = osHomedir;
    shim.clearCommandCache('agent');
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(decoyDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
