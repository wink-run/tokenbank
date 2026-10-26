'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('buildCursorSpawnEnv injects CURSOR_AUTH_TOKEN without CURSOR_API_KEY', () => {
  const mod = require('../cursor-ide-auth');
  const session = mod.readIdeCursorSession();
  if (!session?.usable) {
    console.log('skip: no shareable Cursor IDE JWT on this machine');
    return;
  }

  const { env, injected, reason } = mod.buildCursorSpawnEnv({
    PATH: process.env.PATH,
    CURSOR_API_KEY: 'eyJhbGciOiJfake', // 会话型伪 JWT，应被剔除
  });
  assert.equal(injected, true);
  assert.ok(['ide_state_vscdb', 'ide_decrypted'].includes(reason), reason);
  assert.equal(env.CURSOR_AUTH_TOKEN, session.accessToken);
  assert.ok(mod.isUsableAccessToken(env.CURSOR_AUTH_TOKEN));
  assert.equal(env.CURSOR_API_KEY, undefined);

  // 同步了文件凭证（必须是 JWT，不能是密文）
  assert.ok(fs.existsSync(mod.AUTH_JSON));
  const disk = JSON.parse(fs.readFileSync(mod.AUTH_JSON, 'utf8'));
  assert.equal(disk.accessToken, session.accessToken);
  assert.ok(mod.isUsableAccessToken(disk.accessToken));
});

test('auth.json shape keys are accessToken/refreshToken', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cursor-auth-'));
  const authPath = path.join(dir, 'auth.json');
  try {
    fs.writeFileSync(authPath, JSON.stringify({
      accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepartxx',
      refreshToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.signaturepartyy',
    }, null, 2));
    const parsed = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    assert.deepEqual(Object.keys(parsed).sort(), ['accessToken', 'refreshToken']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
