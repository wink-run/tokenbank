'use strict';
/**
 * Claude Desktop Web 会话额度（对齐 token-monitor fetchClaudeWebLimits）。
 *
 * 凭证：解密 ~/Library/Application Support/Claude/Cookies 里的 sessionKey
 * （Electron Safe Storage → AES-128-CBC，明文前 32 字节为摘要前缀）。
 *
 * 端点：
 *   GET https://claude.ai/api/organizations
 *   GET https://claude.ai/api/organizations/:id/usage  → five_hour / seven_day …
 *
 * 网络受限时回退读 Desktop 本地 plan-usage-history.json（fh/sd 百分比采样）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CLAUDE_WEB_BASE = 'https://claude.ai';
const COOKIE_DIGEST_PREFIX = 32; // Chromium cookie 明文前缀（SHA256）

function claudeSupportDir(home = os.homedir()) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude');
  }
  return path.join(home, '.config', 'Claude');
}

function claudeCookiesPath(home = os.homedir()) {
  return path.join(claudeSupportDir(home), 'Cookies');
}

function claudePlanUsageHistoryPath(home = os.homedir()) {
  return path.join(claudeSupportDir(home), 'plan-usage-history.json');
}

/** 出站代理：环境变量优先，否则读系统代理（与 inject-proxy-env 同口径）。 */
function resolveHttpsProxyUrl() {
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (fromEnv) return String(fromEnv).trim();
  try {
    const { readSystemProxyUrl } = require('../../shared/inject-proxy-env');
    return readSystemProxyUrl();
  } catch {
    return null;
  }
}

/** macOS：Claude Safe Storage 密码。interactive 为 false 时只用缓存，不弹钥匙串。 */
function readClaudeSafeStoragePassword(deps = {}) {
  const { findGenericPassword } = require('./mac-keychain');
  return findGenericPassword('Claude Safe Storage', 'Claude Key', {
    interactive: deps.interactive,
  });
}

/** PBKDF2 → AES-128-CBC 解密 v10 Cookie（spaces IV）。 */
function decryptChromiumCookie(encryptedValue, password) {
  if (!encryptedValue || !password) return null;
  const buf = Buffer.isBuffer(encryptedValue)
    ? encryptedValue
    : Buffer.from(encryptedValue);
  if (buf.length < 19 || buf.slice(0, 3).toString() !== 'v10') return null;
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20); // 16 spaces
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let pt;
  try {
    pt = Buffer.concat([decipher.update(buf.slice(3)), decipher.final()]);
  } catch {
    return null;
  }
  // 去掉 32 字节摘要前缀
  if (pt.length > COOKIE_DIGEST_PREFIX) {
    const rest = pt.slice(COOKIE_DIGEST_PREFIX);
    const s = rest.toString('utf8');
    if (/^(sk-ant-|[\da-f]{8}-)/i.test(s)) return s;
  }
  const m = pt.toString('utf8', 0, pt.length).match(/sk-ant-[A-Za-z0-9._\-]+/);
  return m ? m[0] : null;
}

function decryptCookieToText(encryptedValue, password) {
  if (!encryptedValue || !password) return null;
  const buf = Buffer.isBuffer(encryptedValue)
    ? encryptedValue
    : Buffer.from(encryptedValue);
  if (buf.length < 19 || buf.slice(0, 3).toString() !== 'v10') return null;
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let pt;
  try {
    pt = Buffer.concat([decipher.update(buf.slice(3)), decipher.final()]);
  } catch {
    return null;
  }
  if (pt.length > COOKIE_DIGEST_PREFIX) {
    return pt.slice(COOKIE_DIGEST_PREFIX).toString('utf8');
  }
  return pt.toString('utf8');
}

/** 只读复制 Cookies SQLite，避免 Desktop 锁库。 */
function readClaudeDesktopCookies(deps = {}) {
  const dbPath = deps.cookiesPath || claudeCookiesPath(deps.home);
  if (!fs.existsSync(dbPath)) return null;
  const password = deps.password || readClaudeSafeStoragePassword(deps);
  if (!password) {
    // macOS 有 Cookie 库但还没授权：交给上层提示，不在列表加载时弹密码
    if (deps.interactive === false && process.platform === 'darwin') {
      const err = new Error('查看余额需解锁钥匙串');
      err.code = 'needs_keychain';
      throw err;
    }
    return null;
  }

  // Electron 主进程可用 better-sqlite3；系统 Node / ABI 不匹配时回退 sqlite3 CLI
  try {
    const Database = require('better-sqlite3');
    const tmp = path.join(os.tmpdir(), `tb-claude-cookies-${process.pid}-${Date.now()}.db`);
    try {
      fs.copyFileSync(dbPath, tmp);
      const db = new Database(tmp, { readonly: true, fileMustExist: true });
      try {
        const rows = db.prepare(
          `SELECT name, encrypted_value FROM cookies WHERE host_key LIKE '%claude.ai%'`,
        ).all();
        const out = {};
        for (const row of rows) {
          const raw = row.encrypted_value;
          if (row.name === 'sessionKey') {
            const v = decryptChromiumCookie(raw, password);
            if (v) out.sessionKey = v;
          } else if (row.name === 'lastActiveOrg') {
            const v = decryptCookieToText(raw, password);
            if (v && /^[\da-f-]{36}$/i.test(String(v).trim())) out.lastActiveOrg = String(v).trim();
          }
        }
        return out.sessionKey ? out : null;
      } finally {
        try { db.close(); } catch { /* ignore */ }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  } catch {
    return readClaudeDesktopCookiesViaSqlite3(dbPath, password);
  }
}

function readClaudeDesktopCookiesViaSqlite3(dbPath, password) {
  try {
    const tmp = path.join(os.tmpdir(), `tb-claude-cookies-${process.pid}.db`);
    fs.copyFileSync(dbPath, tmp);
    const skHex = execFileSync('sqlite3', [
      tmp,
      `SELECT hex(encrypted_value) FROM cookies WHERE name='sessionKey' AND host_key LIKE '%claude.ai%' ORDER BY length(encrypted_value) DESC LIMIT 1;`,
    ], { encoding: 'utf8', timeout: 3000 }).trim();
    const orgHex = execFileSync('sqlite3', [
      tmp,
      `SELECT hex(encrypted_value) FROM cookies WHERE name='lastActiveOrg' AND host_key LIKE '%claude.ai%' LIMIT 1;`,
    ], { encoding: 'utf8', timeout: 3000 }).trim();
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    const out = {};
    if (skHex) {
      const v = decryptChromiumCookie(Buffer.from(skHex, 'hex'), password);
      if (v) out.sessionKey = v;
    }
    if (orgHex) {
      const v = decryptCookieToText(Buffer.from(orgHex, 'hex'), password);
      if (v && /^[\da-f-]{36}$/i.test(v.trim())) out.lastActiveOrg = v.trim();
    }
    return out.sessionKey ? out : null;
  } catch {
    return null;
  }
}

function parseClaudeWebBody(status, bodyText) {
  const text = String(bodyText || '');
  if (status === 401 || status === 403) {
    throw new Error(`Claude Web ${status}：会话无效，请重新登录 Claude Desktop`);
  }
  // 区域不可用 / 登录跳转：勿当成功
  if (status === 302 || /app-unavailable-in-region/i.test(text.slice(0, 400))) {
    throw new Error('Claude Web 区域不可用（需系统代理）');
  }
  if (status < 200 || status >= 300) throw new Error(`Claude Web HTTP ${status}`);
  if (/Just a moment|cf-browser-verification/i.test(text.slice(0, 200))) {
    throw new Error('Claude Web 被 Cloudflare 拦截，请稍后重试');
  }
  return JSON.parse(text);
}

function claudeWebGet(url, sessionKey, deps = {}) {
  const headers = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/0.9.0 Chrome/120.0.0.0 Safari/537.36',
    Referer: 'https://claude.ai/settings/usage',
    Origin: 'https://claude.ai',
  };

  if (typeof deps.fetch === 'function') {
    return deps.fetch(url, { method: 'GET', headers, redirect: 'manual' }).then(async (resp) => {
      const text = await resp.text();
      return parseClaudeWebBody(resp.status, text);
    });
  }

  // 1) Electron net（跟随系统代理，对齐 token-monitor）
  const viaNet = () => {
    try {
      const { net } = require('electron');
      if (!(net && typeof net.request === 'function')) return null;
      return new Promise((resolve, reject) => {
        const req = net.request({ method: 'GET', url: String(url), redirect: 'manual' });
        for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
        const chunks = [];
        req.on('response', (response) => {
          response.on('data', (c) => chunks.push(Buffer.from(c)));
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve(parseClaudeWebBody(
                response.statusCode || 0,
                Buffer.concat(chunks).toString('utf8'),
              ));
            } catch (e) { reject(e); }
          });
        });
        req.on('redirect', (statusCode, method, redirectUrl, responseHeaders) => {
          // 不跟随区域/登录跳转；其它 3xx 也交给 parse 报错
          try {
            req.abort();
          } catch { /* ignore */ }
          reject(new Error(`Claude Web HTTP ${statusCode} → ${redirectUrl || ''}`));
        });
        req.on('error', reject);
        req.end();
      });
    } catch {
      return null;
    }
  };

  // 2) curl + 显式 -x（undici fetch 不读 HTTPS_PROXY，国内必挂）
  const viaCurl = () => Promise.resolve().then(() => claudeWebGetViaCurl(url, sessionKey, deps));

  const netP = viaNet();
  if (netP) {
    return netP.catch(async (err) => {
      try { return await viaCurl(); } catch { throw err; }
    });
  }
  return viaCurl();
}

/** curl：显式带系统代理；不跟 -L，避免跳进区域不可用页后超时 */
function claudeWebGetViaCurl(url, sessionKey, deps = {}) {
  const proxy = deps.proxy != null ? deps.proxy : resolveHttpsProxyUrl();
  const args = [
    '-sS', '--max-time', '20',
    '-H', `Cookie: sessionKey=${sessionKey}`,
    '-H', 'Accept: application/json, text/plain, */*',
    '-H', 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Claude/0.9.0 Chrome/120.0.0.0 Safari/537.36',
    '-H', 'Referer: https://claude.ai/settings/usage',
    '-H', 'Origin: https://claude.ai',
  ];
  // 显式 -x，避免 ALL_PROXY=socks 与 HTTP 代理混用触发 CF
  if (proxy) args.push('-x', String(proxy));
  args.push(String(url));

  // 清空继承的代理 env，只认 -x，行为可预期
  const env = { ...process.env };
  for (const k of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
  ]) delete env[k];

  // stderr 丢弃，避免 curl 失败噪声刷主进程日志
  const out = execFileSync('curl', args, {
    encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024, env,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (/Just a moment|cf-browser-verification/i.test(out.slice(0, 200))) {
    throw new Error('Claude Web 被 Cloudflare 拦截');
  }
  if (/app-unavailable-in-region/i.test(out.slice(0, 400))) {
    throw new Error('Claude Web 区域不可用（需系统代理）');
  }
  if (/permission_error|Invalid authorization/i.test(out.slice(0, 200))) {
    throw new Error('Claude Web 403：会话无效，请重新登录 Claude Desktop');
  }
  return JSON.parse(out);
}

/**
 * Desktop 本地用量采样：plan-usage-history.json
 * samples[].u.fh / .sd → five_hour / seven_day 已用百分比。
 */
function readClaudePlanUsageHistory(deps = {}) {
  const histPath = deps.historyPath || claudePlanUsageHistoryPath(deps.home);
  if (!fs.existsSync(histPath)) return null;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(histPath, 'utf8'));
  } catch {
    return null;
  }
  const samples = Array.isArray(j && j.samples) ? j.samples : [];
  if (!samples.length) return null;
  const last = samples[samples.length - 1];
  if (!last || !last.u || typeof last.u !== 'object') return null;
  const fh = typeof last.u.fh === 'number' && isFinite(last.u.fh) ? last.u.fh : null;
  const sd = typeof last.u.sd === 'number' && isFinite(last.u.sd) ? last.u.sd : null;
  if (fh == null && sd == null) return null;
  const usage = {};
  if (fh != null) usage.five_hour = { utilization: fh };
  if (sd != null) usage.seven_day = { utilization: sd };
  return {
    usage,
    organization: last.org ? { uuid: last.org } : null,
    account: null,
    sampledAt: typeof last.t === 'number' ? new Date(last.t).toISOString() : null,
    source: 'local-history',
  };
}

function pickOrganization(orgs, preferredId) {
  const list = Array.isArray(orgs) ? orgs : [];
  if (preferredId) {
    const hit = list.find((o) => o && (o.uuid === preferredId || o.id === preferredId));
    if (hit) return hit;
  }
  // 优先有 chat 能力的组织
  const withChat = list.find((o) => {
    const caps = o?.capabilities || o?.settings?.capabilities || [];
    return Array.isArray(caps) && caps.includes('chat');
  });
  return withChat || list[0] || null;
}

/**
 * 用 Desktop sessionKey 拉用量；失败时回退本地 plan-usage-history。
 * @returns 原始 usage JSON + 组织信息（交给 claude.mapUsage）
 */
async function fetchClaudeWebUsageRaw(deps = {}) {
  const localFallback = () => {
    const hist = readClaudePlanUsageHistory(deps);
    if (!hist) return null;
    // 补全组织：Cookie lastActiveOrg / history.org
    const cookies = deps.cookies || null;
    if (!hist.organization && cookies && cookies.lastActiveOrg) {
      hist.organization = { uuid: cookies.lastActiveOrg };
    }
    return hist;
  };

  let cookies = deps.cookies;
  try {
    cookies = cookies || readClaudeDesktopCookies(deps);
  } catch (e) {
    if (e && e.code === 'needs_keychain') {
      const hist = localFallback();
      if (hist) return hist;
      throw e;
    }
    cookies = null;
  }

  if (!cookies || !cookies.sessionKey) {
    const hist = localFallback();
    if (hist) return hist;
    throw new Error('未找到 Claude Desktop 登录会话，请打开并登录 Claude Desktop');
  }

  const sessionKey = cookies.sessionKey;
  try {
    const orgs = await claudeWebGet(`${CLAUDE_WEB_BASE}/api/organizations`, sessionKey, deps);
    const org = pickOrganization(orgs, cookies.lastActiveOrg);
    const orgId = org && (org.uuid || org.id);
    if (!orgId) throw new Error('Claude Desktop 未找到可用组织');
    const usage = await claudeWebGet(
      `${CLAUDE_WEB_BASE}/api/organizations/${encodeURIComponent(orgId)}/usage`,
      sessionKey,
      deps,
    );
    let account = null;
    try {
      account = await claudeWebGet(`${CLAUDE_WEB_BASE}/api/account`, sessionKey, deps);
    } catch { /* 可选 */ }
    return {
      usage,
      organization: org,
      account,
      sessionKey,
      source: 'web',
    };
  } catch (apiErr) {
    const hist = localFallback();
    if (hist) {
      // 保留套餐推断所需的 org 能力字段：若 API 已拿到 orgs 失败在 usage，hist 只有 uuid
      hist.warning = (apiErr && apiErr.message) || String(apiErr);
      return hist;
    }
    throw apiErr;
  }
}

module.exports = {
  claudeCookiesPath,
  claudePlanUsageHistoryPath,
  readClaudeSafeStoragePassword,
  decryptChromiumCookie,
  readClaudeDesktopCookies,
  readClaudePlanUsageHistory,
  fetchClaudeWebUsageRaw,
  pickOrganization,
  resolveHttpsProxyUrl,
  CLAUDE_WEB_BASE,
};
