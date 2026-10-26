// client/electron/cursor-ide-auth.js
// 从 Cursor IDE 会话共享登录给 cursor-agent（仅读 state.vscdb；可用时再写 auth.json）
//
// 注意：IDE 登录 ≠ Agent CLI 登录。新版 IDE 的 accessToken 可能是非 JWT 密文，
// 写入 ~/.cursor/auth.json / 注入 CURSOR_AUTH_TOKEN 会被 CLI 判为
// 「Your stored authentication is invalid」。仅当 token 像可用 JWT 时才共享；
// 否则让用户走 `agent login` / CURSOR_API_KEY。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH_JSON = path.join(os.homedir(), '.cursor', 'auth.json');

/** 粗判是否为 CLI 可接受的 Bearer JWT（不以内容解码为准，只看形态） */
function isUsableAccessToken(token) {
  const t = String(token || '').trim();
  if (t.length < 40) return false;
  // 标准 JWT：header.payload.sig，且以 eyJ 开头
  if (!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return false;
  return true;
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
    const { execFileSync } = require('child_process');
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

/**
 * 读取 Cursor IDE 当前登录。
 * @returns {{ accessToken: string, refreshToken: string, email: string|null, usable: boolean }|null}
 */
function readIdeCursorSession() {
  const accessToken = readIdeItem('cursorAuth/accessToken');
  if (!accessToken || accessToken.length < 20) return null;
  const refreshToken = readIdeItem('cursorAuth/refreshToken') || accessToken;
  const email = readIdeItem('cursorAuth/cachedEmail');
  return {
    accessToken,
    refreshToken,
    email,
    usable: isUsableAccessToken(accessToken),
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

/**
 * 将可用的 IDE JWT 写入 ~/.cursor/auth.json。
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
    return { ok: true, path: AUTH_JSON, email: s.email || null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * 为 spawn cursor-agent 准备环境。
 * - 可用 JWT：注入 CURSOR_AUTH_TOKEN 并同步 auth.json
 * - 非 JWT / 无会话：清理可能被污染的 auth.json，不注入假凭证
 */
function buildCursorSpawnEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  // 避免误把会话 JWT 当 API Key
  if (env.CURSOR_API_KEY && /^eyJ/.test(String(env.CURSOR_API_KEY))) {
    delete env.CURSOR_API_KEY;
  }

  const session = readIdeCursorSession();
  if (!session?.accessToken) {
    scrubInvalidAuthJson();
    return { env, injected: false, reason: 'no_ide_session' };
  }

  if (!session.usable) {
    // IDE 有登录痕迹但 token 不能给 CLI 用 → 清掉误写的 auth.json
    scrubInvalidAuthJson();
    return {
      env,
      injected: false,
      email: session.email || null,
      reason: 'ide_token_not_shareable',
    };
  }

  syncIdeAuthJson(session);
  env.CURSOR_AUTH_TOKEN = session.accessToken;
  return {
    env,
    injected: true,
    email: session.email || null,
    reason: 'ide_state_vscdb',
  };
}

module.exports = {
  AUTH_JSON,
  resolveIdeStateDb,
  readIdeItem,
  readIdeCursorSession,
  syncIdeAuthJson,
  scrubInvalidAuthJson,
  buildCursorSpawnEnv,
  isUsableAccessToken,
};
