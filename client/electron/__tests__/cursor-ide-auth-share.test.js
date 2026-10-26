'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isUsableAccessToken,
  scrubInvalidAuthJson,
  AUTH_JSON,
  buildCursorSpawnEnv,
} = require('../cursor-ide-auth');

test('isUsableAccessToken 只接受 JWT 形态', () => {
  assert.equal(isUsableAccessToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart'), true);
  assert.equal(isUsableAccessToken('not-a-jwt-token-at-all-but-long-enough-xxxxxxxxxxxx'), false);
  assert.equal(isUsableAccessToken('eyJonlyheader'), false);
  assert.equal(isUsableAccessToken(''), false);
});

test('scrubInvalidAuthJson 删除非 JWT 污染的 auth.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cursor-auth-'));
  const authPath = path.join(dir, 'auth.json');
  try {
    fs.writeFileSync(authPath, JSON.stringify({
      accessToken: 'opaque-ide-ciphertext-not-a-jwt-xxxxxxxxxxxx',
      refreshToken: 'opaque-ide-ciphertext-not-a-jwt-xxxxxxxxxxxx',
    }, null, 2));
    const r = scrubInvalidAuthJson(authPath);
    assert.equal(r.scrubbed, true);
    assert.equal(fs.existsSync(authPath), false);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('buildCursorSpawnEnv 对非 JWT 不注入 CURSOR_AUTH_TOKEN', () => {
  // 不依赖本机是否有 IDE；用桩替换 readIdeCursorSession 不可行（未导出 hook），
  // 这里只验证：在无可用会话时不会凭空注入。
  const { env, injected } = buildCursorSpawnEnv({ PATH: '/usr/bin', CURSOR_API_KEY: 'eyJhbGciOiJfake.xx.yy' });
  // 伪 JWT 形态的 API KEY 应被剔除；是否 injected 取决于本机 IDE
  assert.equal(env.CURSOR_API_KEY, undefined);
  if (!injected) {
    assert.equal(env.CURSOR_AUTH_TOKEN, undefined);
  } else {
    assert.ok(isUsableAccessToken(env.CURSOR_AUTH_TOKEN));
  }
});
