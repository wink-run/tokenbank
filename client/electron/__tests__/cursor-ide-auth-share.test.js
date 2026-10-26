'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  isUsableAccessToken,
  isCursorSafeStorageCipher,
  decryptCursorSafeStorage,
  scrubInvalidAuthJson,
  buildCursorSpawnEnv,
  SAFE_STORAGE_PREFIX,
} = require('../cursor-ide-auth');

test('isUsableAccessToken 只接受 JWT 形态', () => {
  assert.equal(isUsableAccessToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepart'), true);
  assert.equal(isUsableAccessToken('not-a-jwt-token-at-all-but-long-enough-xxxxxxxxxxxx'), false);
  assert.equal(isUsableAccessToken('eyJonlyheader'), false);
  assert.equal(isUsableAccessToken(''), false);
});

test('isCursorSafeStorageCipher 识别加密前缀', () => {
  assert.equal(isCursorSafeStorageCipher(`${SAFE_STORAGE_PREFIX}djEw`), true);
  assert.equal(isCursorSafeStorageCipher('eyJhbGciOiJIUzI1NiJ9.a.b'), false);
});

test('decryptCursorSafeStorage 可用已知口令还原 JWT', () => {
  const password = 'test-cursor-safe-storage-pw';
  const plain = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturepartxx';
  const key = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), Buffer.from('saltysalt'), 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  const blob = Buffer.concat([Buffer.from('v10', 'utf8'), ct]);
  const raw = SAFE_STORAGE_PREFIX + blob.toString('base64');

  const out = decryptCursorSafeStorage(raw, password);
  assert.equal(out, plain);
  assert.equal(isUsableAccessToken(out), true);
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

test('buildCursorSpawnEnv 注入的 CURSOR_AUTH_TOKEN 必须是 JWT', () => {
  const { env, injected } = buildCursorSpawnEnv({ PATH: '/usr/bin', CURSOR_API_KEY: 'eyJhbGciOiJfake.xx.yy' });
  // 伪 JWT 形态的 API KEY 应被剔除
  assert.equal(env.CURSOR_API_KEY, undefined);
  if (!injected) {
    assert.equal(env.CURSOR_AUTH_TOKEN, undefined);
  } else {
    assert.ok(isUsableAccessToken(env.CURSOR_AUTH_TOKEN));
  }
});
