'use strict';
/**
 * macOS 钥匙串读取：
 * 1) 进程内缓存（成功不过期）—— 切 tab 不再弹窗
 * 2) 落盘 ~/.tokenbank（成功后）—— 重启后也不再调 `security`
 * 失败只短缓存，避免连弹，仍可点「刷新」再试。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FAIL_TTL_MS = 20 * 1000;
const DEFAULT_STORE = () => path.join(os.homedir(), '.tokenbank', 'mac-keychain-cache.json');

const cache = new Map(); // key → { value, ok, at }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return { miss: true };
  // 成功：本进程一直复用，不再调 security
  if (hit.ok) return { miss: false, value: hit.value };
  if (Date.now() - hit.at >= FAIL_TTL_MS) return { miss: true };
  return { miss: false, value: hit.value };
}

function cacheSet(key, value, ok) {
  cache.set(key, { value, ok: !!ok, at: Date.now() });
}

function resolveStorePath(deps = {}) {
  if (deps.persist === false) return null;
  if (deps.storePath) return deps.storePath;
  // 测试注入 exec 时默认不写真实磁盘
  if (deps.execFileSync) return null;
  return DEFAULT_STORE();
}

function encryptValue(plain) {
  try {
    const { safeStorage } = require('electron');
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
      && safeStorage.isEncryptionAvailable()) {
      return { v: 1, data: safeStorage.encryptString(String(plain)).toString('base64') };
    }
  } catch { /* 测试 / CLI 无 Electron */ }
  return { v: 0, data: String(plain) };
}

function decryptValue(rec) {
  if (!rec || rec.data == null) return null;
  if (rec.v === 1) {
    try {
      const { safeStorage } = require('electron');
      return safeStorage.decryptString(Buffer.from(rec.data, 'base64'));
    } catch {
      return null;
    }
  }
  return String(rec.data);
}

function readDisk(file) {
  try {
    if (!file || !fs.existsSync(file)) return {};
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeDisk(file, recs) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(recs)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

function persistOk(file, key, value) {
  if (!file || value == null || value === '') return;
  const recs = readDisk(file);
  recs[key] = encryptValue(value);
  writeDisk(file, recs);
}

function loadPersisted(file, key) {
  if (!file) return null;
  const recs = readDisk(file);
  const value = decryptValue(recs[key]);
  return value || null;
}

/**
 * 读 generic password（对应钥匙串弹窗里的服务名 / 账户）。
 * 成功：内存 + 落盘，之后启动不再询问；失败短缓存。
 */
function findGenericPassword(service, account, deps = {}) {
  const plat = deps.platform || process.platform;
  if (plat !== 'darwin') return null;
  const key = `pw:${service}:${account || ''}`;
  const hit = cacheGet(key);
  if (!hit.miss) return hit.value;

  const store = resolveStorePath(deps);
  const persisted = loadPersisted(store, key);
  if (persisted) {
    cacheSet(key, persisted, true);
    return persisted;
  }

  // 账户列表等后台读取不弹窗；用户点「查看余额」才传 interactive: true
  if (deps.interactive === false) return null;

  const exec = deps.execFileSync || execFileSync;
  try {
    const args = ['find-generic-password', '-w', '-s', String(service)];
    if (account) args.push('-a', String(account));
    // 系统密码框要等用户输入。超时太短时进程先被杀掉，密码确认后界面拿不到结果，还得再点一次。
    const value = String(exec('security', args, {
      encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'],
    })).replace(/\n$/, '') || null;
    cacheSet(key, value, !!value);
    if (value) persistOk(store, key, value);
    return value;
  } catch (err) {
    // 超时说明对话框可能还开着，不要记成失败，避免用户刚输完密码却读到空
    if (!(err && (err.killed || err.code === 'ETIMEDOUT'))) cacheSet(key, null, false);
    return null;
  }
}

/** 缓存任意钥匙串相关计算结果（如 Claude Code 凭证）。成功不过期。 */
function memo(key, fn) {
  const hit = cacheGet(`memo:${key}`);
  if (!hit.miss) return hit.value;
  try {
    const value = fn();
    cacheSet(`memo:${key}`, value, value != null);
    return value;
  } catch {
    cacheSet(`memo:${key}`, null, false);
    return null;
  }
}

function _resetForTests() {
  cache.clear();
}

module.exports = {
  findGenericPassword,
  memo,
  _resetForTests,
  FAIL_TTL_MS,
};
