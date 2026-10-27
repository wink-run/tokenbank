'use strict';
/**
 * usage 抓取公共工具 —— 跨 provider 复用。
 * 新增一家 usage 抓取器时，HTTP / 数值清洗 / 窗口结构都从这里取，避免各 provider 重复实现。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_BETA = 'oauth-2025-04-20';
const CLAUDE_UA = 'claude-code/2.1.0';

/** 仅保留有限数值，其余归 null（便于区分「0%」与「无数据」）。 */
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

/** 兼容字符串数值（部分余额端点把金额返回为 string，如 DeepSeek total_balance）。 */
function toNum(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : null;
}

/** 从 provider 条目取 API key（api_key 类抓取器用；OAuth 类走 oauth.prepare 不用这个）。 */
function providerApiKey(provider) {
  if (!provider) return null;
  const c = provider.credentials || {};
  return provider.token || c.api_key || c.key || null;
}

/**
 * 回退读取各 CLI 自维护的凭证文件 —— agent config 里没有该源的 OAuth token 时用它。
 * CLI（claude / codex / gemini）自己负责登录与刷新，这里只读它落盘的最新凭证。
 * 返回统一形状 { access_token, refresh_token, ... } 或 null（文件缺失/无 token）。
 *   - claude → ~/.claude/.credentials.json；macOS 再试钥匙串 Claude Code-credentials
 *   - codex  → ~/.codex/auth.json（tokens.*）
 *   - gemini → ~/.gemini/oauth_creds.json（access_token / refresh_token / expiry_date）
 */
function readMacKeychainClaude(opts = {}) {
  if (process.platform !== 'darwin') return null;
  const { findGenericPassword, memo } = require('./mac-keychain');
  // 静默失败不能挡住用户稍后点「查看余额」
  const interactive = opts.interactive === true;
  const memoKey = interactive ? 'claude-code-creds:ask' : 'claude-code-creds:quiet';
  return memo(memoKey, () => {
    const parse = (raw) => {
      if (!raw) return null;
      try {
        const j = JSON.parse(raw);
        const o = (j && (j.claudeAiOauth || j.oauth)) || {};
        return {
          access_token: o.accessToken || null,
          refresh_token: o.refreshToken || null,
          expires_at: o.expiresAt || null,
          subscriptionType: o.subscriptionType || null,
          rateLimitTier: o.rateLimitTier || null,
        };
      } catch {
        const text = String(raw).trim();
        if (text.length > 20) return { access_token: text, refresh_token: null, expires_at: null };
        return null;
      }
    };
    // 只读主条目。dump-keychain 会再弹一次密码，读到 token 后也不再扫。
    const main = parse(findGenericPassword('Claude Code-credentials', undefined, { interactive }));
    if (main && (main.access_token || main.refresh_token)) return main;
    return main && (main.subscriptionType || main.rateLimitTier) ? main : null;
  });
}

function readCliCreds(name, opts = {}) {
  const home = os.homedir();
  try {
    if (name === 'claude') {
      let fromFile = null;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8'));
        const o = (j && j.claudeAiOauth) || {};
        if (o.accessToken || o.refreshToken || o.subscriptionType) {
          fromFile = {
            access_token: o.accessToken || null,
            refresh_token: o.refreshToken || null,
            expires_at: o.expiresAt || null,
            subscriptionType: o.subscriptionType || null,
            rateLimitTier: o.rateLimitTier || null,
          };
        }
      } catch { /* 无文件 */ }
      // 文件已有 token 则不碰钥匙串，避免切 tab 反复弹授权
      if (fromFile && (fromFile.access_token || fromFile.refresh_token)) return fromFile;
      const fromKey = readMacKeychainClaude(opts);
      if (fromKey && (fromKey.access_token || fromKey.refresh_token)) return fromKey;
      // 仅有套餐元数据时也返回，供 UsageMeter 展示订阅情况
      if (fromFile && (fromFile.subscriptionType || fromFile.rateLimitTier)) return fromFile;
      if (fromKey) return fromKey;
      return null;
    }
    if (name === 'codex') {
      const j = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
      const t = (j && j.tokens) || {};
      if (!t.access_token) return null;
      return {
        access_token: t.access_token,
        refresh_token: t.refresh_token || null,
        account_id: t.account_id || null,
        id_token: t.id_token || null,
      };
    }
    if (name === 'gemini') {
      const j = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'oauth_creds.json'), 'utf8'));
      if (!j || (!j.access_token && !j.refresh_token)) return null;
      return {
        access_token: j.access_token || null,
        refresh_token: j.refresh_token || null,
        id_token: j.id_token || null,
        expiry_date: j.expiry_date || null,
      };
    }
  } catch {
    // 文件不存在 / 解析失败 —— 回退无凭证
  }
  return null;
}

/** 把 4xx/5xx 状态翻译成可读中文错误（OAuth 类端点通用）。 */
function describeHttpError(status, pathname) {
  if (status === 401) return '401 未授权：token 失效，请重新登录';
  if (status === 403) return '403：账号可能以 setup-token 登录（缺 user:profile 权限），请用完整权限重新登录';
  if (status === 429) return '429 限流，请稍后再试';
  return `HTTP ${status}${pathname ? ' @ ' + pathname : ''}`;
}

/**
 * 通用 Anthropic OAuth GET —— 返回解析后的 JSON；非 2xx 抛可读 Error。
 * usage / profile 以及后续其他 Anthropic OAuth 端点共用。
 */
async function anthropicOAuthGet(pathname, token, opts = {}) {
  if (!token) throw new Error('缺少 access_token');
  const { base = ANTHROPIC_BASE, beta = ANTHROPIC_BETA, userAgent = CLAUDE_UA } = opts;
  const resp = await fetch(base + pathname, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': beta,
      'User-Agent': userAgent,
    },
  });
  if (!resp.ok) throw new Error(describeHttpError(resp.status, pathname));
  return resp.json();
}

module.exports = {
  num,
  toNum,
  providerApiKey,
  readCliCreds,
  describeHttpError,
  anthropicOAuthGet,
  ANTHROPIC_BASE,
  ANTHROPIC_BETA,
  CLAUDE_UA,
};
