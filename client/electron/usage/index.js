'use strict';
/**
 * 用量额度抓取注册表 —— 一个 provider 对应一个 usage 抓取器。
 *
 * 设计与 oauth/index.js 同构：新增一家 = 往 USAGE_FETCHERS 加一条。
 * 这一层只负责「订阅方官方口径的剩余额度/重置窗口/余额」，与网关的 token 统计互补。
 *
 * 注册 key 规则（usageProviderName）：
 *   - OAuth 类按 oauth_provider（如 claude）—— 凭证走 oauth.prepare。
 *   - 其余按 provider.id（如 openrouter / deepseek）—— 凭证走 provider.token（API key）。
 *
 * 形态：抓取器统一返回 { provider, id, primary, windows[], ... }，按需附带：
 *   - 窗口配额型：windows 带 usedPercent + resetsAt（Claude）。
 *   - 余额型：credits { total, currency, usedPercent? }（OpenRouter/DeepSeek）。
 */
const { readCliCreds } = require('./shared');
const { fetchClaudeUsage } = require('./claude');
const { fetchOpenRouterUsage } = require('./openrouter');
const { fetchDeepSeekUsage } = require('./deepseek');
const { fetchCodexUsage } = require('./codex');
const { fetchCopilotUsage } = require('./copilot');
const { fetchGeminiUsage } = require('./gemini');
const { fetchGroqUsage } = require('./groq');
const { fetchVolcengineUsage } = require('./volcengine');
const { fetchVolcengineArkUsage } = require('./volcengine-ark');
const { fetchCursorUsage } = require('./cursor');
const { fetchSiliconFlowUsage } = require('./siliconflow');
const { fetchKimiCodeUsage } = require('./kimi-code');
const { fetchMiniMaxUsage } = require('./minimax');
const { fetchZhipuUsage } = require('./zhipu');
const { fetchAgnesUsage } = require('./agnes');

const USAGE_FETCHERS = {
  claude: fetchClaudeUsage, // OAuth 窗口型
  codex: fetchCodexUsage, // OAuth 窗口型（ChatGPT wham/usage；回退 ~/.codex/auth.json）
  cursor: fetchCursorUsage, // IDE state.vscdb JWT → cursor.com usage-summary
  copilot: fetchCopilotUsage, // OAuth 窗口型（用 github_token）
  gemini: fetchGeminiUsage, // Google OAuth 窗口型（回退 ~/.gemini/oauth_creds.json + 自动刷新）
  volcengine: fetchVolcengineUsage, // Coding/Agent Plan 订阅窗口
  'volcengine-ark': fetchVolcengineArkUsage, // 方舟按量：费用中心余额
  openrouter: fetchOpenRouterUsage, // API key 余额型
  deepseek: fetchDeepSeekUsage, // API key 余额型
  siliconflow: fetchSiliconFlowUsage, // API key 余额型（/v1/user/info）
  'kimi-code': fetchKimiCodeUsage, // Coding 订阅窗口（/coding/v1/usages）
  minimax: fetchMiniMaxUsage, // Coding/Token Plan + 现金余额
  zhipu: fetchZhipuUsage, // Coding Plan 配额 + 按量余额
  'agnes-ai': fetchAgnesUsage, // 国际站 / 中国站 billing（密钥与站点绑定）
  groq: fetchGroqUsage, // API key 指标型（无额度概念）
};

// 前端 UsageMeter 也需要判断「该 provider 是否支持额度抓取」，导出 key 列表保持单一真相源。
const SUPPORTED_KEYS = Object.keys(USAGE_FETCHERS);

/** 订阅模板 id / 别名 → 抓取器 key（api-volcengine → volcengine）。 */
function normalizeUsageKey(raw) {
  const k = String(raw || '').trim().toLowerCase();
  if (!k) return null;
  // 按量方舟须先于 volcengine 前缀匹配
  if (k === 'volcengine-ark' || k === 'ark-payg' || k === 'volcengine-payg') return 'volcengine-ark';
  if (k === 'api-volcengine' || k === 'doubao' || k === 'ark') return 'volcengine';
  if (k === 'api-kimi-code' || k === 'kimicode' || k === 'kimi_code') return 'kimi-code';
  if (k === 'api-minimax' || k === 'minimaxi') return 'minimax';
  if (k === 'api-zhipu' || k === 'zhipuai' || k === 'bigmodel' || k === 'glm') return 'zhipu';
  if (k === 'api-agnes' || k === 'api-agnes-ai' || k === 'agnes' || k === 'agnesai') return 'agnes-ai';
  return k;
}

/** 返回该 provider 条目对应的抓取器 key（不支持则 null）。 */
function usageProviderName(provider) {
  if (!provider) return null;
  const raw = provider.auth_type === 'oauth' && provider.oauth_provider
    ? provider.oauth_provider
    : provider.id;
  let key = normalizeUsageKey(raw);
  if (key && USAGE_FETCHERS[key]) return key;
  // 多实例 acct-*：按 base_url 分流 Coding 订阅 vs 方舟按量
  const base = String(provider.base_url || '').toLowerCase();
  if (/volces\.com|volcengine/.test(base)) {
    if (/\/api\/v3/.test(base) && !/\/coding\//.test(base)) key = 'volcengine-ark';
    else key = 'volcengine';
    return USAGE_FETCHERS[key] ? key : null;
  }
  return null;
}

/** 直连 App 订阅无 gateway provider 条目时，构造虚拟条目走 CLI/IDE 凭证。 */
function syntheticProvider(key) {
  const k = normalizeUsageKey(key);
  if (!k || !USAGE_FETCHERS[k]) return null;
  if (k === 'cursor') return { id: 'cursor' };
  if (k === 'codex') return { id: 'codex', auth_type: 'oauth', oauth_provider: 'codex' };
  if (k === 'claude') return { id: 'claude', auth_type: 'oauth', oauth_provider: 'claude' };
  if (k === 'gemini') return { id: 'gemini', auth_type: 'oauth', oauth_provider: 'gemini' };
  if (k === 'copilot') return { id: 'github-copilot', auth_type: 'oauth', oauth_provider: 'copilot' };
  if (k === 'volcengine') return { id: 'volcengine' };
  if (k === 'volcengine-ark') return { id: 'volcengine-ark' };
  return { id: k };
}

/** provider 是否已具备可用凭证（agent config 的 OAuth token / API key，或 CLI 落盘的凭证）。 */
function hasCredential(provider) {
  if (!provider) return false;
  const c = provider.credentials || {};
  // 火山 IAM AccessKey 也可查额度（与推理 API Key 不同）
  if (c.access_key_id && c.secret_access_key) return true;
  if (c.access_token || c.refresh_token || c.api_key || c.key || c.session_token || c.sessionToken || provider.token) return true;
  const name = usageProviderName(provider);
  if (name === 'cursor') {
    try {
      // 只看 IDE 是否落了 token，不解密，避免一进账户页就弹 Cursor 钥匙串
      const ide = require('../cursor-ide-auth');
      const raw = ide.readIdeItem && ide.readIdeItem('cursorAuth/accessToken');
      return !!(raw && String(raw).length >= 20);
    } catch { return false; }
  }
  // Claude：OAuth / 套餐元数据 / Desktop Cookie / 本地用量采样均可展示
  if (name === 'claude') {
    const cli = readCliCreds('claude', { interactive: false });
    if (cli && (cli.access_token || cli.refresh_token || cli.subscriptionType)) return true;
    try {
      const fs = require('fs');
      const web = require('./claude-web');
      // 只看文件在不在，不解密 Cookie，避免一进账户页就弹钥匙串
      if (typeof web.claudeCookiesPath === 'function' && fs.existsSync(web.claudeCookiesPath())) return true;
      if (web.readClaudePlanUsageHistory()) return true;
    } catch { /* ignore */ }
    return false;
  }
  // agent config 里没存凭证时，回退看对应 CLI 是否已登录（codex/gemini/claude 自维护 token 文件）。
  return !!(name && readCliCreds(name));
}

/** 抓单个 provider 条目；失败不抛，返回 { error }，便于前端逐条展示。 */
async function fetchUsage(provider, deps) {
  const name = usageProviderName(provider);
  const id = provider && provider.id;
  if (!name) return { id, provider: provider && (provider.oauth_provider || provider.id), error: 'unsupported' };
  // 默认不弹钥匙串；界面点「查看余额」时才传 interactive
  const d = { ...(deps || {}), interactive: !!(deps && deps.interactive) };
  try {
    return await USAGE_FETCHERS[name](provider, d);
  } catch (e) {
    return { id, provider: name, error: (e && e.message) || String(e) };
  }
}

/** 抓 config 里所有「已启用 + 支持 + 有凭证」的 provider。 */
async function fetchAllUsage(deps) {
  const cfg = deps && deps.getCfg ? deps.getCfg() : null;
  const providers = (cfg && Array.isArray(cfg.providers) ? cfg.providers : []).filter(
    (p) => p && p.enabled !== false && usageProviderName(p) && hasCredential(p),
  );
  const out = [];
  for (const p of providers) out.push(await fetchUsage(p, deps)); // 顺序执行，避免并发刷新同一 OAuth token
  return out;
}

module.exports = {
  fetchUsage, fetchAllUsage, usageProviderName, hasCredential, syntheticProvider,
  normalizeUsageKey,
  USAGE_FETCHERS, SUPPORTED_KEYS,
};
