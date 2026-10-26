'use strict';

/** 是否 Gemini 原生 / OpenAI 兼容端点 */
function isGeminiProvider(p = {}) {
  const fmt = String(p.api_format || '').toLowerCase();
  const url = String(p.base_url || '');
  return fmt === 'gemini' || /generativelanguage\.googleapis\.com/i.test(url);
}

function isAnthropicProvider(p = {}) {
  const fmt = String(p.api_format || '').toLowerCase();
  const url = String(p.base_url || '');
  return fmt === 'anthropic' || /anthropic/i.test(url);
}

/** Ollama 本地实例不校验 API Key，探测时也不附带 Authorization */
function isOllamaProvider(p = {}) {
  if (String(p.id || '').toLowerCase() === 'ollama') return true;
  return /(?:^|\/\/)(?:127\.0\.0\.1|localhost):11434(?:\/|$)/i.test(String(p.base_url || ''));
}

/**
 * 供给源连通性探测：统一 GET /models（Gemini 用 x-goog-api-key；其余 Bearer / x-api-key）。
 * 出站代理由调用方通过 resolveOutboundProxyAgent 注入，与网关转发一致。
 * @returns {{ targets: Array<{ url: string, headers: object }>, error?: string }}
 */
function providerTestTargets(p = {}) {
  const base = String(p.base_url || '').replace(/\/$/, '');
  if (!base) return { targets: [], error: 'missing_base_url' };
  // Ollama 不需要密钥：即使本地存了 token 也不带上，避免被当成鉴权失败
  const token = isOllamaProvider(p) ? '' : String(p.token || '').trim();
  const targets = [];

  if (isGeminiProvider(p)) {
    if (!token) return { targets: [], error: 'missing_api_key' };
    try {
      const root = new URL(base);
      const path = root.pathname.replace(/\/openai\/?$/, '').replace(/\/$/, '') || '';
      const modelsUrl = new URL(root.origin + `${path}/models`);
      modelsUrl.searchParams.set('key', token);
      targets.push({
        url: modelsUrl.toString(),
        headers: { 'x-goog-api-key': token },
      });
      if (!/\/openai/i.test(base)) {
        targets.push({
          url: `${base}/openai/v1/models`,
          headers: { Authorization: `Bearer ${token}` },
        });
      }
    } catch {
      return { targets: [], error: 'invalid_base_url' };
    }
    return { targets };
  }

  let headers = {};
  if (token) {
    headers = isAnthropicProvider(p)
      ? { 'x-api-key': token, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${token}` };
  }
  targets.push({ url: `${base}/models`, headers });
  if (!/\/v\d+$/.test(base)) {
    targets.push({ url: `${base}/v1/models`, headers });
  }
  return { targets };
}

/** 日志脱敏：仅保留首尾各 4 位 */
function maskProviderTestSecret(value) {
  const s = String(value || '');
  if (!s) return '(empty)';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** URL 中 ?key= 脱敏 */
function sanitizeProviderTestUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.searchParams.has('key')) {
      u.searchParams.set('key', maskProviderTestSecret(u.searchParams.get('key')));
    }
    return u.toString();
  } catch {
    return urlStr;
  }
}

/** 请求头中的 token / key 脱敏 */
function sanitizeProviderTestHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'authorization' || lk === 'x-api-key' || lk === 'x-goog-api-key') {
      const raw = String(v);
      out[k] = raw.startsWith('Bearer ')
        ? `Bearer ${maskProviderTestSecret(raw.slice(7))}`
        : maskProviderTestSecret(raw);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 打印供给源连通性探测日志（token 已脱敏） */
function logProviderTestProbe(ctx = {}, target = {}, phase, result) {
  const tag = ctx.id || ctx.api_format || ctx.base_url || '-';
  const url = sanitizeProviderTestUrl(target.url || '');
  const headers = sanitizeProviderTestHeaders(target.headers);
  if (phase === 'request') {
    console.log('[provider-test] GET', url, { provider: tag, headers });
    return;
  }
  const status = result?.status ?? 0;
  const detail = result?.ok ? 'ok' : (result?.error || 'failed');
  console.log('[provider-test] GET', url, { provider: tag, status, result: detail });
}

/** 解析探测响应错误详情 */
function parseProviderProbeError(body, status) {
  const raw = String(body || '').trim();
  let msg = '';
  if (!raw) {
    msg = status ? `HTTP ${status}` : 'Connection failed';
  } else {
    try {
      const j = JSON.parse(raw);
      msg = String(j.error?.message || j.message || raw).slice(0, 400);
    } catch {
      msg = raw.slice(0, 400);
    }
  }
  // Kimi Code 等：403 + membership → 订阅失效，勿当普通「连接失败」
  if (Number(status) === 403 && /membership|会员|订阅|benefits/i.test(`${msg}\n${raw}`)) {
    return '订阅已失效或未开通，请续费或确认会员状态后重试';
  }
  return msg;
}

module.exports = {
  providerTestTargets,
  isGeminiProvider,
  isAnthropicProvider,
  isOllamaProvider,
  logProviderTestProbe,
  parseProviderProbeError,
  sanitizeProviderTestUrl,
  sanitizeProviderTestHeaders,
};
