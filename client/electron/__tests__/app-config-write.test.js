'use strict';
// 桌面版与 Docker 共用的「写配置文件」纳管：Pi 家族写入 / 还原
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cfgwrite-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
delete process.env.PI_CODING_AGENT_DIR;

const shared = require('../app-config-write');
const piCfg = require('../pi-config');

test('resolvePatchDeep fills {BASE} and {KEY} in nested values', () => {
  const out = shared.resolvePatchDeep(
    { a: '{BASE}/v1', b: [{ k: '{KEY}' }], n: 3 },
    { base: 'http://127.0.0.1:11430', key: 'sk-x' },
  );
  assert.deepEqual(out, { a: 'http://127.0.0.1:11430/v1', b: [{ k: 'sk-x' }], n: 3 });
});

test('non-Pi handlers are left to the caller', async () => {
  assert.equal(await shared.writePiFamilyConfig('codex-desktop-api', {}, {}), null);
});

test('Pi: refuses to create config when pi is not present', async () => {
  const r = await shared.writePiFamilyConfig('pi-cli', {}, { base: 'http://127.0.0.1:1', allowCreate: false });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'config-missing');
});

test('Pi: writes the tokenbank provider and reverts it', async () => {
  const profile = piCfg.profileForHandler('pi-cli');
  // pi 已运行过：agent 目录存在（familyReady 的强信号）
  fs.mkdirSync(piCfg.agentDir(profile), { recursive: true });
  const r = await shared.writePiFamilyConfig('pi-cli', {
    'providers.tokenbank.baseUrl': 'http://127.0.0.1:11430/v1',
    'providers.tokenbank.apiKey': 'sk-test',
  }, { base: 'http://127.0.0.1:1', key: 'sk-test', allowCreate: true });
  assert.equal(r.ok, true, r.error);
  const doc = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.ok(doc.providers && doc.providers.tokenbank, 'tokenbank provider written');

  assert.equal(shared.revertPiFamilyConfig('pi', { preset_id: 'pi' }), true);
  const after = fs.existsSync(r.file) ? JSON.parse(fs.readFileSync(r.file, 'utf8')) : {};
  assert.ok(!(after.providers && after.providers.tokenbank), 'tokenbank provider removed');
});
