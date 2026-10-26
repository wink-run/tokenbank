'use strict';
/**
 * Cursor 订阅用量抓取（对齐 token-monitor cursorProbe）。
 *
 * 凭证：读 Cursor IDE state.vscdb 的 accessToken（JWT），拼成
 *   WorkosCursorSessionToken=<jwt.sub>%3A%3A<accessToken>
 * 再打 cursor.com 用量接口（纯 JWT Bearer / 裸 Cookie 会 401）。
 *
 * 端点：
 *   GET /api/usage-summary → 套餐百分比 / Auto / API / on-demand
 *   GET /api/auth/me → sub（供 /api/usage 请求额度）
 *   GET /api/usage?user= → 可选请求次数窗（session 请求额度）
 */
const { num } = require('./shared');
const { planLabelFromParts } = require('./plan-labels');

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary';
const AUTH_ME_URL = 'https://cursor.com/api/auth/me';
const REQUEST_USAGE_URL = 'https://cursor.com/api/usage';

const DEFAULT_HEADERS = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.cursor.com/settings',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
};

function clampPercent(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function centsToUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value) / 100;
}

function percentFromUsedLimit(used, limit) {
  if (used == null || limit == null || !(limit > 0)) return null;
  return clampPercent((used / limit) * 100);
}

/** JWT payload.sub（不校验签名，仅本地拼 Cookie）。 */
function jwtSub(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const pad = '='.repeat((4 - (part.length % 4)) % 4);
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
    const sub = JSON.parse(json).sub;
    return sub ? String(sub) : null;
  } catch {
    return null;
  }
}

/**
 * IDE JWT → WorkosCursorSessionToken 值。
 * token-monitor / 实测：必须是 userId%3A%3A<jwt>，否则 usage-summary 401。
 */
function buildSessionCookieValue(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) return null;
  if (token.includes('%3A%3A') || token.includes('::')) return token.includes('::')
    ? token.replace('::', '%3A%3A')
    : token;
  const sub = jwtSub(token);
  if (!sub) return null;
  return `${sub}%3A%3A${token}`;
}

function formatCursorMembership(type) {
  if (!type || typeof type !== 'string') return '';
  const raw = type.trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'pro+' || raw === 'pro_plus') return 'Pro+';
  return planLabelFromParts(raw) || '';
}

function parseRequestUsage(input) {
  const usage = input && typeof input === 'object' ? input : {};
  const gpt4 = usage['gpt-4'] || usage.gpt4 || {};
  return {
    requestsUsed: num(gpt4.numRequestsTotal) ?? num(gpt4.numRequests),
    requestsLimit: num(gpt4.maxRequestUsage),
  };
}

/** usage-summary(+optional /api/usage) → 统一窗口快照字段（纯函数，可单测）。 */
function parseUsageSummary(input, { requestUsage = null } = {}) {
  const summary = input && typeof input === 'object' ? input : {};
  const individual = summary.individualUsage && typeof summary.individualUsage === 'object'
    ? summary.individualUsage : {};
  const plan = individual.plan && typeof individual.plan === 'object' ? individual.plan : {};
  const onDemand = individual.onDemand && typeof individual.onDemand === 'object' ? individual.onDemand : {};
  const autoPercent = clampPercent(num(plan.autoPercentUsed));
  const apiPercent = clampPercent(num(plan.apiPercentUsed));
  let planPercent = clampPercent(num(plan.totalPercentUsed));
  if (planPercent == null) {
    if (autoPercent != null && apiPercent != null) planPercent = clampPercent((autoPercent + apiPercent) / 2);
    else planPercent = apiPercent ?? autoPercent ?? percentFromUsedLimit(num(plan.used), num(plan.limit)) ?? 0;
  }
  const req = parseRequestUsage(requestUsage);
  return {
    planPercent,
    autoPercent,
    apiPercent,
    planUsedUsd: centsToUsd(num(plan.used) ?? 0),
    planLimitUsd: centsToUsd(num(plan.limit) ?? 0),
    planRemainingUsd: plan.remaining === undefined ? null : centsToUsd(num(plan.remaining)),
    onDemandPercent: percentFromUsedLimit(num(onDemand.used), num(onDemand.limit)),
    onDemandUsedUsd: centsToUsd(num(onDemand.used) ?? 0),
    onDemandLimitUsd: onDemand.limit == null ? null : centsToUsd(num(onDemand.limit)),
    billingCycleEnd: typeof summary.billingCycleEnd === 'string' ? summary.billingCycleEnd : null,
    membershipType: typeof summary.membershipType === 'string' ? summary.membershipType : null,
    requestsUsed: req.requestsUsed,
    requestsLimit: req.requestsLimit,
  };
}

function win(id, title, usedPercent, resetsAt) {
  if (usedPercent == null && !resetsAt) return null;
  return {
    id,
    title,
    usedPercent: usedPercent == null ? 0 : usedPercent,
    usageKnown: usedPercent != null,
    resetsAt: resetsAt || null,
    windowMinutes: null,
  };
}

/** 解析结果 → UsageMeter 统一快照。 */
function mapCursorUsage(parsed, { provider = null, email = null } = {}) {
  const resetsAt = parsed.billingCycleEnd || null;
  const windows = [];
  // 请求次数窗优先作为「会话」额度；否则用套餐总百分比
  const hasReq = parsed.requestsUsed != null && parsed.requestsLimit != null && parsed.requestsLimit > 0;
  const totalPct = hasReq
    ? percentFromUsedLimit(parsed.requestsUsed, parsed.requestsLimit)
    : parsed.planPercent;
  const session = win(
    hasReq ? 'session_requests' : 'plan_total',
    hasReq ? '会话 · 请求' : '套餐额度',
    totalPct,
    resetsAt,
  );
  if (session) windows.push(session);
  const auto = win('auto', 'Auto', parsed.autoPercent, resetsAt);
  const api = win('api', 'API', parsed.apiPercent, resetsAt);
  if (auto) windows.push(auto);
  if (api) windows.push(api);
  if (parsed.onDemandLimitUsd != null || (parsed.onDemandUsedUsd != null && parsed.onDemandUsedUsd > 0)) {
    const od = win('on_demand', '按需额度', parsed.onDemandPercent, null);
    if (od) windows.push(od);
  }
  const plan = formatCursorMembership(parsed.membershipType) || null;
  return {
    provider: 'cursor',
    id: (provider && provider.id) || 'cursor',
    email: email || null,
    plan,
    primary: windows[0] || null,
    windows,
    fetchedAt: new Date().toISOString(),
  };
}

async function cursorGetJson(url, sessionCookie) {
  const resp = await fetch(url, {
    method: 'GET',
    headers: { ...DEFAULT_HEADERS, Cookie: `WorkosCursorSessionToken=${sessionCookie}` },
  });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`${resp.status}：Cursor 登录失效，请在 Cursor IDE 重新登录`);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

/** 从 IDE / provider.credentials 取 accessToken。 */
function resolveCursorAccessToken(provider) {
  const c = (provider && provider.credentials) || {};
  if (c.access_token || c.session_token || c.sessionToken) {
    return c.access_token || c.session_token || c.sessionToken;
  }
  try {
    const ide = require('../cursor-ide-auth');
    const s = ide.readIdeCursorSession();
    // 仅用已解密/明文 JWT；密文不能拼 WorkosCursorSessionToken
    if (s && s.usable && s.accessToken) return s.accessToken;
  } catch { /* ignore */ }
  // 无 API 时仍可读 IDE 落盘的 membership，供展示兜底
  return null;
}

function readIdeMembershipFallback() {
  try {
    const ide = require('../cursor-ide-auth');
    return {
      membershipType: ide.readIdeItem('cursorAuth/stripeMembershipType'),
      email: ide.readIdeItem('cursorAuth/cachedEmail'),
    };
  } catch {
    return { membershipType: null, email: null };
  }
}

async function fetchCursorUsage(provider) {
  const accessToken = resolveCursorAccessToken(provider);
  const cookie = buildSessionCookieValue(accessToken);
  if (!cookie) {
    const fb = readIdeMembershipFallback();
    if (fb.membershipType) {
      // 有本地套餐名但无可用会话 Cookie：仍展示订阅情况，不阻断卡片
      return {
        provider: 'cursor',
        id: (provider && provider.id) || 'cursor',
        email: fb.email,
        plan: formatCursorMembership(fb.membershipType),
        primary: null,
        windows: [],
        fetchedAt: new Date().toISOString(),
      };
    }
    throw new Error('未检测到 Cursor 登录，请先打开 Cursor IDE 并登录');
  }

  const [summary, me] = await Promise.all([
    cursorGetJson(USAGE_SUMMARY_URL, cookie),
    cursorGetJson(AUTH_ME_URL, cookie).catch(() => null),
  ]);
  let requestUsage = null;
  const sub = (me && me.sub) || jwtSub(accessToken);
  if (sub) {
    try {
      requestUsage = await cursorGetJson(
        `${REQUEST_USAGE_URL}?user=${encodeURIComponent(sub)}`,
        cookie,
      );
    } catch { /* 请求额度可选 */ }
  }
  const parsed = parseUsageSummary(summary, { requestUsage });
  // IDE 里的 stripeMembershipType 可作 membership 兜底
  if (!parsed.membershipType) {
    const fb = readIdeMembershipFallback();
    if (fb.membershipType) parsed.membershipType = fb.membershipType;
  }
  const email = (me && me.email) || (provider && provider.credentials && provider.credentials.email) || null;
  return mapCursorUsage(parsed, { provider, email });
}

module.exports = {
  fetchCursorUsage,
  mapCursorUsage,
  parseUsageSummary,
  buildSessionCookieValue,
  formatCursorMembership,
  jwtSub,
};
