'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

test('parseCursorModelLines 解析 id、名称和当前项', () => {
  const { parseCursorModelLines } = require('../cursor-agent-install');
  const models = parseCursorModelLines([
    'Available models',
    '',
    'auto - Auto (current, default)',
    'composer-2.5 - Composer 2.5',
    'Tip: use --model <id>',
  ].join('\n'));
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'auto');
  assert.equal(models[0].name, 'Auto');
  assert.equal(models[0].current, true);
  assert.equal(models[1].id, 'composer-2.5');
  assert.equal(models[1].current, false);
});

test('ensureLocalBinOnPath 把 ~/.local/bin 放到 PATH 最前', () => {
  const { ensureLocalBinOnPath } = require('../cursor-agent-install');
  const os = require('os');
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const env = ensureLocalBinOnPath({ PATH: '/usr/bin:/bin' });
  const parts = env.PATH.split(path.delimiter);
  assert.equal(parts[0], localBin);
  assert.ok(parts.includes('/usr/bin'));
});

test('installCursorAgentCli 已安装时直接返回 already', async () => {
  const shimPath = require.resolve('../shim-installer');
  const installPath = require.resolve('../cursor-agent-install');
  delete require.cache[installPath];

  const fakeShim = {
    clearCommandCache() {},
    resolveRealCommand(cmd) {
      return cmd === 'cursor-agent' ? '/tmp/fake/cursor-agent' : null;
    },
  };
  require.cache[shimPath] = {
    id: shimPath,
    filename: shimPath,
    loaded: true,
    exports: fakeShim,
  };

  try {
    const { installCursorAgentCli } = require('../cursor-agent-install');
    const res = await installCursorAgentCli();
    assert.equal(res.ok, true);
    assert.equal(res.already, true);
    assert.equal(res.path, '/tmp/fake/cursor-agent');
  } finally {
    delete require.cache[shimPath];
    delete require.cache[installPath];
  }
});

test('installCursorAgentCli 未安装时跑官方脚本并复检', async () => {
  const shimPath = require.resolve('../shim-installer');
  const installPath = require.resolve('../cursor-agent-install');
  const cpPath = require.resolve('child_process');
  delete require.cache[installPath];

  let installed = false;
  const fakeShim = {
    clearCommandCache() {},
    resolveRealCommand(cmd) {
      if (!installed) return null;
      return (cmd === 'cursor-agent' || cmd === 'agent') ? '/home/u/.local/bin/agent' : null;
    },
  };
  require.cache[shimPath] = {
    id: shimPath,
    filename: shimPath,
    loaded: true,
    exports: fakeShim,
  };

  const realCp = require('child_process');
  const origExecFile = realCp.execFile;
  realCp.execFile = (_file, _args, _opts, cb) => {
    process.nextTick(() => {
      installed = true;
      cb(null, 'ok', '');
    });
    return { on() {} };
  };

  try {
    const { installCursorAgentCli } = require('../cursor-agent-install');
    const res = await installCursorAgentCli();
    assert.equal(res.ok, true);
    assert.equal(res.already, false);
    assert.equal(res.path, '/home/u/.local/bin/agent');
  } finally {
    realCp.execFile = origExecFile;
    delete require.cache[shimPath];
    delete require.cache[installPath];
  }
});
