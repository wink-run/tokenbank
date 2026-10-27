'use strict';
/**
 * Claude 订阅用量额度抓取（移植自 CodexBar ClaudeOAuthUsageFetcher）。
 *
 * 与「网关转发后自己累加 token」不同：这里直接打 Anthropic 官方端点，
 * 拿订阅方口径的剩余额度 + 重置时间 + 订阅计划。复用 oauth.prepare 拿 fresh access_token。
 *
 * 端点：
 *   GET /api/oauth/usage   → 各窗口用量（utilization 直接是 0-100，resets_at 为 ISO8601）
 *   GET /api/oauth/profile → 账号 + 订阅计划（has_claude_max / organization.rate_limit_tier 等）
 * 窗口映射：five_hour→会话 / seven_day→本周 / seven_day_opus|sonnet→模型周窗 / extra_usage→月度额外用量。
 */
const oauth = require('../oauth');
const { num, anthropicOAuthGet, readCliCreds } = require('./shared');
const { claudePlanLabelFromParts } = require('./plan-labels');
const { fetchClaudeWebUsageRaw } = require('./claude-web');

/**
 * 从 /api/oauth/profile 推断订阅计划展示标签（对齐 token-monitor accountLabel）。
 * 优先 account 标志位定档，再结合 organization.rate_limit_tier 保留 Max 5x/20x。
 */
function inferClaudePlan(profile) {
  const acct = (profile && profile.account) || {};
  const org = (profile && profile.organization) || {};
  let subscriptionType = '';
  if (acct.has_claude_max) subscriptionType = 'max';
  else if (acct.has_claude_pro) subscriptionType = 'pro';
  else {
    const type = String(org.organization_type || org.rate_limit_tier || '').toLowerCase();
    if (type.includes('max')) subscriptionType = 'max';
    else if (type.includes('pro')) subscriptionType = 'pro';
    else if (type.includes('team')) subscriptionType = 'team';
    else if (type.includes('enterprise')) subscriptionType = 'enterprise';
  }
  const label = claudePlanLabelFromParts(subscriptionType, org.rate_limit_tier);
  return label || null;
}

/**
 * 从 profile 检测当前订阅档位（公共方法，可单测）。
 * 返回 subscription_plans 目录里的 plan_id（max5x / max20x / claude-pro），
 * 价格/label 交给目录，这里只负责「API 真值 → 档位 id」。无有效订阅返回 null。
 */
function detectClaudeSubscription(profile) {
  const acct = (profile && profile.account) || {};
  const org = (profile && profile.organization) || {};
  const status = org.subscription_status;
  if (status && status !== 'active') return null; // 已取消/过期不算
  const tier = String(org.rate_limit_tier || org.organization_type || '').toLowerCase();
  if (acct.has_claude_max || tier.includes('max')) {
    return { planId: tier.includes('20x') ? 'max20x' : 'max5x', source: 'api', tier: tier || null };
  }
  if (acct.has_claude_pro || tier.includes('pro')) {
    return { planId: 'claude-pro', source: 'api', tier: tier || null };
  }
  return null;
}

/** 单个 window：{ utilization, resets_at } → 统一窗口结构（null 表示该窗口不存在）。 */
function mapWindow(id, title, raw, windowMinutes) {
  if (!raw || typeof raw !== 'object') return null;
  const usedPercent = num(raw.utilization);
  if (usedPercent == null && !raw.resets_at) return null;
  return {
    id,
    title,
    usedPercent: usedPercent == null ? 0 : usedPercent,
    usageKnown: usedPercent != null, // 只有 reset 信息、无用量时为 false
    resetsAt: raw.resets_at || null,
    windowMinutes: windowMinutes == null ? null : windowMinutes,
  };
}

/** usage(+profile) → 统一快照（纯函数，可单测）。 */
function mapUsage(data, { profile = null, provider = null } = {}) {
  const d = data || {};
  const acct = (profile && profile.account) || {};
  const creds = (provider && provider.credentials) || {};
  const windows = [];

  const session = mapWindow('five_hour', '会话 · 5h', d.five_hour, 300);
  const weekly = mapWindow('seven_day', '本周 · 7d', d.seven_day, 10080);
  const opus = mapWindow('seven_day_opus', 'Opus · 7d', d.seven_day_opus, 10080);
  const sonnet = mapWindow('seven_day_sonnet', 'Sonnet · 7d', d.seven_day_sonnet, 10080);
  for (const w of [session, weekly, opus, sonnet]) if (w) windows.push(w);

  // 主窗口：会话窗口有用量时优先，否则回退本周窗（与 CodexBar 行为一致）。
  const primary = session && session.usageKnown ? session : weekly || session || null;

  let extra = null;
  const eu = d.extra_usage;
  if (eu && typeof eu === 'object' && (eu.is_enabled || eu.monthly_limit != null)) {
    extra = {
      enabled: !!eu.is_enabled,
      monthlyLimit: num(eu.monthly_limit),
      usedCredits: num(eu.used_credits),
      usedPercent: num(eu.utilization),
    };
  }

  return {
    provider: 'claude',
    id: (provider && provider.id) || 'claude',
    email: acct.email || creds.email || null,
    name: acct.display_name || acct.full_name || null,
    plan: inferClaudePlan(profile),
    subscription: detectClaudeSubscription(profile), // API 检测到的订阅档位（供个人中心自动登记）
    primary,
    windows,
    extra,
    fetchedAt: new Date().toISOString(),
  };
}

/** 仅凭钥匙串/本地落盘的 subscriptionType + rateLimitTier 展示订阅情况（无 access_token 时）。 */
function planOnlyFromCreds(creds, provider) {
  if (!creds) return null;
  const label = claudePlanLabelFromParts(creds.subscriptionType, creds.rateLimitTier);
  if (!label) return null;
  return {
    provider: 'claude',
    id: (provider && provider.id) || 'claude',
    email: creds.email || null,
    plan: label,
    subscription: null,
    primary: null,
    windows: [],
    extra: null,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * 解析可用 access_token：
 * 1) agent config OAuth（oauth.prepare，可刷新）
 * 2) Claude Code 文件 / macOS 钥匙串（直连 Desktop 卡常用）
 */
async function resolveClaudeAccess(provider, { getCfg, saveCfg, interactive } = {}) {
  const c = (provider && provider.credentials) || {};
  const cli = readCliCreds('claude', { interactive: !!interactive });

  // 直连虚拟条目：优先 CLI/钥匙串，避免无 refresh_token 时 oauth.prepare 直接抛错
  if (cli && cli.access_token && !(c.refresh_token || c.access_token)) {
    return {
      token: cli.access_token,
      provider: { ...(provider || {}), credentials: { ...c, ...cli } },
      creds: { ...cli, ...c },
    };
  }

  if (c.refresh_token || c.access_token) {
    try {
      const prepared = await oauth.prepare(provider, getCfg, saveCfg);
      const token = prepared.credentials && prepared.credentials.access_token;
      if (token) return { token, provider: prepared, creds: { ...cli, ...prepared.credentials } };
    } catch (e) {
      if (!/refresh_token|access_token/i.test(String(e && e.message))) {
        // 网络类错误：若 CLI 仍有 token 可继续
        if (!(cli && cli.access_token)) throw e;
      }
    }
  }

  if (cli && cli.access_token) {
    return {
      token: cli.access_token,
      provider: { ...(provider || {}), credentials: { ...c, ...cli } },
      creds: { ...c, ...cli },
    };
  }
  return { token: null, provider, creds: cli || null };
}

/** 从 Claude Web 组织对象推断套餐短标签（capability / rate_limit_tier）。 */
function planFromWebOrganization(org) {
  if (!org || typeof org !== 'object') return null;
  const caps = new Set(
    []
      .concat(org.capabilities || [])
      .concat((org.settings && org.settings.capabilities) || [])
      .map((c) => String(c || '').toLowerCase()),
  );
  let subscriptionType = '';
  if (caps.has('claude_max') || caps.has('max')) subscriptionType = 'max';
  else if (caps.has('claude_pro') || caps.has('pro')) subscriptionType = 'pro';
  else if (caps.has('raven')) {
    const raven = String(org.raven_type || '').toLowerCase();
    subscriptionType = raven === 'enterprise' ? 'enterprise' : 'team';
  }
  const tier = org.rate_limit_tier || org.rateLimitTier || '';
  return claudePlanLabelFromParts(subscriptionType, tier) || null;
}

/** Desktop Web 用量 → 统一快照（窗口形状与 OAuth /api/oauth/usage 一致）。 */
function mapWebUsage(raw, provider) {
  const usage = (raw && raw.usage) || {};
  const org = (raw && raw.organization) || {};
  const account = (raw && raw.account) || {};
  // 合成 profile，复用 inferClaudePlan / mapUsage
  const profile = {
    account: {
      email: account.email || account.email_address || null,
      display_name: account.display_name || account.name || null,
      has_claude_max: !!(org.capabilities || []).includes?.('claude_max')
        || (Array.isArray(org.capabilities) && org.capabilities.map(String).some((c) => /max/i.test(c))),
      has_claude_pro: Array.isArray(org.capabilities) && org.capabilities.map(String).some((c) => /pro/i.test(c) && !/max/i.test(c)),
    },
    organization: {
      rate_limit_tier: org.rate_limit_tier || null,
      organization_type: org.raven_type || org.organization_type || null,
      subscription_status: 'active',
    },
  };
  // capabilities 更准时覆盖 account 标志
  if (Array.isArray(org.capabilities)) {
    const lower = org.capabilities.map((c) => String(c).toLowerCase());
    profile.account.has_claude_max = lower.some((c) => c.includes('claude_max') || c === 'max');
    profile.account.has_claude_pro = lower.some((c) => c.includes('claude_pro') || c === 'pro');
  }
  const snap = mapUsage(usage, { profile, provider });
  snap.source = (raw && raw.source) || 'web';
  if (!snap.plan) snap.plan = planFromWebOrganization(org);
  if (raw && raw.warning) snap.warning = raw.warning;
  if (raw && raw.sampledAt && !snap.fetchedAt) snap.fetchedAt = raw.sampledAt;
  // 本地采样时间更贴近 Desktop 侧刷新点
  if (raw && raw.sampledAt && snap.source === 'local-history') {
    snap.fetchedAt = raw.sampledAt;
  }
  return snap;
}

/** 钥匙串未授权时返回给界面，由用户点「查看余额」再解锁 */
function keychainLockedSnap(provider, creds) {
  const soft = planOnlyFromCreds(creds, provider) || {
    provider: 'claude',
    id: (provider && provider.id) || 'claude',
    email: null,
    plan: null,
    subscription: null,
    primary: null,
    windows: [],
    extra: null,
    fetchedAt: new Date().toISOString(),
  };
  soft.needsKeychain = true;
  return soft;
}

/** 抓取 + 映射。无 OAuth 时回退 Claude Desktop Web Cookie（session 额度主路径）。 */
async function fetchClaudeUsage(provider, { getCfg, saveCfg, interactive } = {}) {
  const { token, provider: prepared, creds } = await resolveClaudeAccess(provider, { getCfg, saveCfg, interactive });
  const webDeps = { interactive: !!interactive };

  // 1) OAuth / Claude Code token
  if (token) {
    try {
      const [usage, profile] = await Promise.all([
        anthropicOAuthGet('/api/oauth/usage', token),
        anthropicOAuthGet('/api/oauth/profile', token).catch(() => null),
      ]);
      const snap = mapUsage(usage, { profile, provider: prepared });
      if (!snap.plan && creds) {
        snap.plan = claudePlanLabelFromParts(creds.subscriptionType, creds.rateLimitTier) || null;
      }
      snap.source = 'oauth';
      return snap;
    } catch (e) {
      // 已有 Claude Code token 时不再读 Desktop 钥匙串，避免输完密码又弹一次
      try {
        const raw = await fetchClaudeWebUsageRaw({ ...webDeps, interactive: false });
        const snap = mapWebUsage(raw, provider);
        if (!snap.plan && creds) {
          snap.plan = claudePlanLabelFromParts(creds.subscriptionType, creds.rateLimitTier) || null;
        }
        return snap;
      } catch {
        // 钥匙串已经解开并拿到 token，不要再回到「需要输入密码」
        const soft = planOnlyFromCreds(creds, provider);
        if (soft) {
          soft.warning = (e && e.message) || String(e);
          return soft;
        }
        const msg = (e && e.message) || String(e);
        if (/fetch failed|timeout|ENOTFOUND|ECONN/i.test(msg)) {
          throw new Error('无法连接 Anthropic 用量接口，请检查网络后重试');
        }
        throw e;
      }
    }
  }

  // 2) 无 OAuth token：Claude Desktop Cookie → Web usage（含 session 窗）
  try {
    const raw = await fetchClaudeWebUsageRaw(webDeps);
    const snap = mapWebUsage(raw, provider);
    if (!snap.plan && creds) {
      snap.plan = claudePlanLabelFromParts(creds.subscriptionType, creds.rateLimitTier) || null;
    }
    return snap;
  } catch (webErr) {
    if (webErr && webErr.code === 'needs_keychain') return keychainLockedSnap(provider, creds);
    const soft = planOnlyFromCreds(creds, provider);
    if (soft) {
      soft.warning = (webErr && webErr.message) || String(webErr);
      return soft;
    }
    throw new Error(
      (webErr && webErr.message)
      || '未检测到 Claude 登录，请打开 Claude Desktop 并登录后刷新',
    );
  }
}

module.exports = {
  fetchClaudeUsage, mapUsage, mapWindow, inferClaudePlan, detectClaudeSubscription,
  resolveClaudeAccess, planOnlyFromCreds, mapWebUsage, planFromWebOrganization,
};
