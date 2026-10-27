// client/electron/cursor-ide-auth.js
// 从 Cursor IDE 会话共享登录给 cursor-agent（读 state.vscdb → 解密 → auth.json / 钥匙串 / CURSOR_AUTH_TOKEN）
//
// 新版 IDE 在加密落盘开启时，accessToken 形如 cursor-safe-storage:v1:<base64(v10…)>。
// macOS 可用钥匙串「Cursor Safe Storage / Cursor Key」按 Chromium 方式解密为 JWT，
// 再写入 CLI 凭证（darwin: 钥匙串 cursor-*-token；其它平台: ~/.cursor/auth.json），
// 并注入 CURSOR_AUTH_TOKEN。解密失败时不写密文，避免 CLI 报 invalid。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const AUTH_JSON = path.join(os.homedir(), '.cursor', 'auth.json');
const SAFE_STORAGE_PREFIX = 'cursor-safe-storage:v1:';
/** Agent CLI 在 darwin 上使用的钥匙串域名（与 CLI domain:"cursor" 一致） */
const CLI_KEYCHAIN_ACCOUNT = 'cursor-user';
const CLI_KEYCHAIN_ACCESS = 'cursor-access-token';
const CLI_KEYCHAIN_REFRESH = 'cursor-refresh-token';

/** 粗判是否为 CLI 可接受的 Bearer JWT（不以内容解码为准，只看形态） */
function isUsableAccessToken(token) {
  const t = String(token || '').trim();
  if (t.length < 40) return false;
  // 标准 JWT：header.payload.sig，且以 eyJ 开头
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return false;
  return true;
}

function isCursorSafeStorageCipher(raw) {
  return typeof raw === 'string' && raw.startsWith(SAFE_STORAGE_PREFIX);
}

/** IDE state.vscdb 路径（macOS / Windows / Linux） */
function resolveIdeStateDb() {
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb',
    );
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/** 只读 ItemTable（优先 better-sqlite3；失败回退 sqlite3 CLI；不碰钥匙串） */
function readIdeItem(key) {
  const dbPath = resolveIdeStateDb();
  if (!fs.existsSync(dbPath)) return null;
  const k = String(key);

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(k);
      const v = row?.value;
      if (v == null) return null;
      return Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    // Electron ABI 的 better-sqlite3 在系统 Node 单测里会失败，回退 CLI
  }

  try {
    const out = execFileSync(
      'sqlite3',
      [dbPath, `SELECT value FROM ItemTable WHERE key='${k.replace(/'/g, "''")}';`],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 读取 Cursor Safe Storage 主密钥。只有 interactive: true 才弹钥匙串，其余只用缓存。 */
function readCursorSafeStoragePassword(opts = {}) {
  if (process.platform !== 'darwin') return null;
  try {
    const { findGenericPassword } = require('./usage/mac-keychain');
    const pw = findGenericPassword('Cursor Safe Storage', 'Cursor Key', {
      // 未显式要求时传 false，避免启动探测走到 security 弹窗
      interactive: opts.interactive === true,
    });
    return pw || null;
  } catch {
    return null;
  }
}

/**
 * 解密 IDE encryption-at-rest 密文 → 明文 JWT。
 * Chromium/Electron macOS：v10 + AES-128-CBC，密钥 = PBKDF2(password, "saltysalt", 1003, 16, sha1)，IV = 16 个空格。
 */
function decryptCursorSafeStorage(raw, password = null) {
  if (!isCursorSafeStorageCipher(raw)) return null;
  const pw = password ?? readCursorSafeStoragePassword({ interactive: false });
  if (!pw) return null;
  try {
    const blob = Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), 'base64');
    if (blob.length < 4 || blob.subarray(0, 3).toString('utf8') !== 'v10') return null;
    const key = crypto.pbkdf2Sync(Buffer.from(pw, 'utf8'), Buffer.from('saltysalt'), 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 将 IDE 落盘值解析为可用 JWT：明文 JWT 直接用；密文则尝试解密。
 * @returns {{ token: string|null, source: 'jwt'|'decrypted'|'cipher'|'empty' }}
 */
function resolveUsableToken(raw, opts = {}) {
  if (!raw || typeof raw !== 'string' || raw.length < 20) {
    return { token: null, source: 'empty' };
  }
  if (isUsableAccessToken(raw)) return { token: raw, source: 'jwt' };
  if (isCursorSafeStorageCipher(raw)) {
    const pw = readCursorSafeStoragePassword({ interactive: opts.interactive });
    if (!pw) return { token: null, source: 'cipher', needsKeychain: true };
    const plain = decryptCursorSafeStorage(raw, pw);
    if (isUsableAccessToken(plain)) return { token: plain, source: 'decrypted' };
    return { token: null, source: 'cipher' };
  }
  return { token: null, source: 'cipher' };
}

/**
 * 读取 Cursor IDE 当前登录（自动解密 encryption-at-rest）。
 * @returns {{ accessToken: string, refreshToken: string, email: string|null, usable: boolean, tokenSource: string }|null}
 */
function readIdeCursorSession(opts = {}) {
  const accessRaw = readIdeItem('cursorAuth/accessToken');
  if (!accessRaw || accessRaw.length < 20) return null;
  const refreshRaw = readIdeItem('cursorAuth/refreshToken') || accessRaw;
  const email = readIdeItem('cursorAuth/cachedEmail');

  const access = resolveUsableToken(accessRaw, opts);
  const refresh = resolveUsableToken(refreshRaw, opts);
  // 仅当 access 解密/本身为 JWT 时视为可共享
  const accessToken = access.token || accessRaw;
  const refreshToken = refresh.token || (access.token ? access.token : refreshRaw);

  return {
    accessToken,
    refreshToken,
    email,
    usable: !!access.token,
    tokenSource: access.source,
    needsKeychain: !access.token && !!access.needsKeychain,
  };
}

/**
 * 若 auth.json 里是不可用的非 JWT（常见于误同步的 IDE 密文），备份后删除，
 * 避免 CLI 一直报 stored authentication is invalid。
 * @param {string} [authPath] 可测性：覆盖默认 ~/.cursor/auth.json
 */
function scrubInvalidAuthJson(authPath = AUTH_JSON) {
  try {
    if (!fs.existsSync(authPath)) return { scrubbed: false, reason: 'missing' };
    const raw = fs.readFileSync(authPath, 'utf8');
    let data;
    try { data = JSON.parse(raw); } catch {
      return { scrubbed: false, reason: 'parse_error' };
    }
    const tok = data?.accessToken;
    if (isUsableAccessToken(tok)) return { scrubbed: false, reason: 'ok' };
    const bak = `${authPath}.tb-invalid.bak`;
    try { fs.copyFileSync(authPath, bak); } catch { /* ignore */ }
    fs.unlinkSync(authPath);
    return { scrubbed: true, reason: 'non_jwt', backup: bak };
  } catch (e) {
    return { scrubbed: false, reason: e.message };
  }
}

/** 将 JWT 写入 Agent CLI 的 macOS 钥匙串条目 */
function syncCliKeychainTokens(accessToken, refreshToken) {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not_darwin' };
  if (!isUsableAccessToken(accessToken)) return { ok: false, reason: 'not_jwt' };
  const refresh = isUsableAccessToken(refreshToken) ? refreshToken : accessToken;

  function setPass(service, password) {
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', service, '-a', CLI_KEYCHAIN_ACCOUNT],
        { stdio: 'ignore', timeout: 5000 },
      );
    } catch { /* 条目不存在时忽略 */ }
    execFileSync(
      'security',
      ['add-generic-password', '-U', '-s', service, '-a', CLI_KEYCHAIN_ACCOUNT, '-w', password],
      { stdio: 'pipe', timeout: 5000 },
    );
  }

  try {
    setPass(CLI_KEYCHAIN_ACCESS, accessToken);
    setPass(CLI_KEYCHAIN_REFRESH, refresh);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 将可用的 IDE JWT 写入 ~/.cursor/auth.json，并在 macOS 同步钥匙串。
 * 非 JWT 不写，避免污染 CLI 凭证。
 */
function syncIdeAuthJson(session = null) {
  const s = session || readIdeCursorSession();
  if (!s?.accessToken) return { ok: false, reason: 'no_ide_session' };
  if (!isUsableAccessToken(s.accessToken)) {
    return { ok: false, reason: 'ide_token_not_jwt' };
  }
  try {
    fs.mkdirSync(path.dirname(AUTH_JSON), { recursive: true });
    const payload = {
      accessToken: s.accessToken,
      refreshToken: isUsableAccessToken(s.refreshToken) ? s.refreshToken : s.accessToken,
    };
    fs.writeFileSync(AUTH_JSON, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(AUTH_JSON, 0o600); } catch { /* ignore */ }

    const keychain = syncCliKeychainTokens(payload.accessToken, payload.refreshToken);
    return {
      ok: true,
      path: AUTH_JSON,
      email: s.email || null,
      tokenSource: s.tokenSource || null,
      keychain,
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 主动把 IDE 登录共享给 CLI（供 status 探测 / 登录按钮复用）。
 * 默认不弹钥匙串；用户点「登录」时才传 interactive: true。
 * @returns {{ ok: boolean, injected?: boolean, reason?: string, email?: string|null }}
 */
function shareIdeLoginWithCli(opts = {}) {
  const session = readIdeCursorSession({ interactive: opts.interactive === true });
  if (!session?.accessToken) {
    scrubInvalidAuthJson();
    return { ok: false, reason: 'no_ide_session' };
  }
  if (!session.usable) {
    scrubInvalidAuthJson();
    return {
      ok: false,
      email: session.email || null,
      reason: 'ide_token_not_shareable',
      tokenSource: session.tokenSource,
    };
  }
  const sync = syncIdeAuthJson(session);
  if (!sync.ok) return { ok: false, reason: sync.reason, email: session.email || null };
  return {
    ok: true,
    injected: true,
    accessToken: session.accessToken,
    email: session.email || null,
    reason: session.tokenSource === 'decrypted' ? 'ide_decrypted' : 'ide_state_vscdb',
    keychain: sync.keychain,
  };
}

/**
 * 为 spawn cursor-agent 准备环境。
 * - 可用 JWT（含解密后）：注入 CURSOR_AUTH_TOKEN 并同步 auth.json / 钥匙串
 * - 非 JWT / 无会话：清理可能被污染的 auth.json，不注入假凭证
 */
function buildCursorSpawnEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  // 避免误把会话 JWT 当 API Key
  if (env.CURSOR_API_KEY && /^eyJ/.test(String(env.CURSOR_API_KEY))) {
    delete env.CURSOR_API_KEY;
  }

  // 执行时也不弹窗：密码已在「登录 / 查看余额」解开过则会命中缓存
  const shared = shareIdeLoginWithCli({ interactive: false });
  if (!shared.ok || !shared.accessToken) {
    return {
      env,
      injected: false,
      email: shared.email || null,
      reason: shared.reason || 'no_ide_session',
    };
  }

  env.CURSOR_AUTH_TOKEN = shared.accessToken;
  return {
    env,
    injected: true,
    email: shared.email || null,
    reason: shared.reason,
  };
}

module.exports = {
  AUTH_JSON,
  SAFE_STORAGE_PREFIX,
  CLI_KEYCHAIN_ACCOUNT,
  CLI_KEYCHAIN_ACCESS,
  CLI_KEYCHAIN_REFRESH,
  resolveIdeStateDb,
  readIdeItem,
  readIdeCursorSession,
  syncIdeAuthJson,
  syncCliKeychainTokens,
  shareIdeLoginWithCli,
  scrubInvalidAuthJson,
  buildCursorSpawnEnv,
  isUsableAccessToken,
  isCursorSafeStorageCipher,
  decryptCursorSafeStorage,
  resolveUsableToken,
};
