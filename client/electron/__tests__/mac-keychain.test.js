'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const mac = require('../usage/mac-keychain');

test('findGenericPassword：同进程第二次不调 security', () => {
  mac._resetForTests();
  let n = 0;
  const execFileSync = () => {
    n += 1;
    return 'secret-pw\n';
  };
  const a = mac.findGenericPassword('Claude Safe Storage', 'Claude Key', {
    platform: 'darwin',
    execFileSync,
  });
  const b = mac.findGenericPassword('Claude Safe Storage', 'Claude Key', {
    platform: 'darwin',
    execFileSync,
  });
  assert.equal(a, 'secret-pw');
  assert.equal(b, 'secret-pw');
  assert.equal(n, 1);
});

test('findGenericPassword：失败也短缓存，避免连弹', () => {
  mac._resetForTests();
  let n = 0;
  const execFileSync = () => {
    n += 1;
    throw new Error('user denied');
  };
  assert.equal(mac.findGenericPassword('Claude Safe Storage', 'Claude Key', {
    platform: 'darwin', execFileSync,
  }), null);
  assert.equal(mac.findGenericPassword('Claude Safe Storage', 'Claude Key', {
    platform: 'darwin', execFileSync,
  }), null);
  assert.equal(n, 1);
});

test('findGenericPassword：interactive false 不弹钥匙串', () => {
  mac._resetForTests();
  let n = 0;
  const v = mac.findGenericPassword('Claude Safe Storage', 'Claude Key', {
    platform: 'darwin',
    interactive: false,
    execFileSync: () => { n += 1; return 'x\n'; },
  });
  assert.equal(v, null);
  assert.equal(n, 0);
});

test('findGenericPassword：非 darwin 不调用', () => {
  mac._resetForTests();
  let n = 0;
  mac.findGenericPassword('Claude Safe Storage', 'Claude Key', {
    platform: 'linux',
    execFileSync: () => { n += 1; return 'x'; },
  });
  assert.equal(n, 0);
});

test('memo：成功结果复用', () => {
  mac._resetForTests();
  let n = 0;
  const fn = () => { n += 1; return { access_token: 't' }; };
  assert.deepEqual(mac.memo('claude-code-creds', fn), { access_token: 't' });
  assert.deepEqual(mac.memo('claude-code-creds', fn), { access_token: 't' });
  assert.equal(n, 1);
});

test('findGenericPassword：落盘后清空内存不再调 security', () => {
  mac._resetForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-kc-'));
  const storePath = path.join(dir, 'mac-keychain-cache.json');
  let n = 0;
  const execFileSync = () => { n += 1; return 'persist-pw\n'; };
  const opts = {
    platform: 'darwin',
    execFileSync,
    persist: true,
    storePath,
  };
  assert.equal(mac.findGenericPassword('Claude Safe Storage', 'Claude Key', opts), 'persist-pw');
  mac._resetForTests();
  assert.equal(mac.findGenericPassword('Claude Safe Storage', 'Claude Key', opts), 'persist-pw');
  assert.equal(n, 1);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});
