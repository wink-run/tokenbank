// client/electron/pricing.js
// USD per million tokens — 全局兜底 + 按 provider 独立刊例价（payg_providers.pricing）
'use strict';

const PRICING = {
  // Anthropic
  'claude-opus-4-7':   { in: 5.00,  out: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  },
  'claude-opus-4-6':   { in: 5.00,  out: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  },
  'claude-opus-4-5':   { in: 5.00,  out: 25.00, cacheRead: 0.50,  cacheWrite: 6.25  },
  'claude-opus-4-1':   { in: 15.00, out: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-opus-4':     { in: 15.00, out: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  'claude-sonnet-4-6': { in: 3.00,  out: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-sonnet-4-5': { in: 3.00,  out: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-sonnet-4':   { in: 3.00,  out: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-haiku-4-5':  { in: 1.00,  out: 5.00,  cacheRead: 0.10,  cacheWrite: 1.25  },
  'claude-haiku-4.5':  { in: 1.00,  out: 5.00,  cacheRead: 0.10,  cacheWrite: 1.25  },
  'claude-3-5-sonnet': { in: 3.00,  out: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-3.5-sonnet': { in: 3.00,  out: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-3.5-haiku':  { in: 0.80,  out: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  // OpenAI
  'gpt-5.5-pro':       { in: 30.00, out: 180.00, cacheRead: 3.00, cacheWrite: 37.50 },
  'gpt-5.5':           { in: 5.00,  out: 30.00,  cacheRead: 0.50, cacheWrite: 6.25  },
  'gpt-5-5':           { in: 5.00,  out: 30.00,  cacheRead: 0.50, cacheWrite: 6.25  },
  'gpt-5.4-mini':      { in: 0.75,  out: 4.50,   cacheRead: 0.075, cacheWrite: 0.94 },
  'gpt-5-4-mini':      { in: 0.75,  out: 4.50,   cacheRead: 0.075, cacheWrite: 0.94 },
  'gpt-5.4':           { in: 2.50,  out: 15.00,  cacheRead: 0.25, cacheWrite: 3.13  },
  'gpt-5-4':           { in: 2.50,  out: 15.00,  cacheRead: 0.25, cacheWrite: 3.13  },
  'gpt-5-mini':        { in: 0.15,  out: 0.60,   cacheRead: 0.015, cacheWrite: 0.19 },
  'gpt-5':             { in: 1.25,  out: 10.00,  cacheRead: 0.125, cacheWrite: 1.56 },
  'gpt-4.1':           { in: 2.50,  out: 10.00,  cacheRead: 1.25, cacheWrite: 3.13  },
  'gpt-4o-mini':       { in: 0.15,  out: 0.60,   cacheRead: 0.075, cacheWrite: 0.19 },
  'gpt-4o':            { in: 2.50,  out: 10.00,  cacheRead: 1.25, cacheWrite: 3.13  },
  // Google Gemini
  'gemini-3.1-pro':    { in: 2.00,  out: 12.00,  cacheRead: 0.20,  cacheWrite: 2.50 },
  'gemini-3.1-flash':  { in: 0.25,  out: 1.50,   cacheRead: 0.025, cacheWrite: 0.31 },
  'gemini-3-pro':      { in: 2.00,  out: 12.00,  cacheRead: 0.20,  cacheWrite: 2.50 },
  'gemini-3-flash':    { in: 0.25,  out: 1.50,   cacheRead: 0.025, cacheWrite: 0.31 },
  'gemini-2.5-pro':    { in: 1.25,  out: 10.00,  cacheRead: 0.125, cacheWrite: 1.56 },
  'gemini-2.5-flash':  { in: 0.30,  out: 2.50,   cacheRead: 0.03,  cacheWrite: 0.38 },
  'gemini-2.0-flash':  { in: 0.075, out: 0.30,   cacheRead: 0.0075, cacheWrite: 0.094},
  'gemini':            { in: 1.25,  out: 5.00,   cacheRead: 0.125, cacheWrite: 1.56 },
  // DeepSeek
  'deepseek-flash':    { in: 0.15,  out: 0.60,   cacheRead: 0.003, cacheWrite: null  },
  'deepseek-v4-flash': { in: 0.15,  out: 0.60,   cacheRead: 0.003, cacheWrite: null  },
  'deepseek-chat':     { in: 0.15,  out: 0.60,   cacheRead: 0.003, cacheWrite: null  },
  'deepseek-reasoner': { in: 0.15,  out: 0.60,   cacheRead: 0.003, cacheWrite: null  },
  'deepseek-v4-pro':   { in: 0.66,  out: 1.98,   cacheRead: 0.022, cacheWrite: null  },
  // Grok
  'grok-4.7':          { in: 2.00,  out: 6.00,   cacheRead: 0.50,  cacheWrite: null  },
  'grok-4.6':          { in: 2.00,  out: 6.00,   cacheRead: 0.50,  cacheWrite: null  },
  'grok-4.5':          { in: 2.00,  out: 6.00,   cacheRead: 0.30,  cacheWrite: null  },
  'grok-4.3':          { in: 1.25,  out: 2.50,   cacheRead: 0.20,  cacheWrite: null  },
  'grok-3-mini':       { in: 0.30,  out: 0.50,   cacheRead: null,  cacheWrite: null  },
  'grok-3':            { in: 3.00,  out: 15.00,  cacheRead: null,  cacheWrite: null  },
  'grok-build':        { in: 0.20,  out: 1.50,   cacheRead: null,  cacheWrite: null  },
  // Kimi / Moonshot
  'kimi-k2.6':         { in: 0.95,  out: 4.00,   cacheRead: 0.16,  cacheWrite: 1.19 },
  'kimi-k2.5':         { in: 0.60,  out: 3.00,   cacheRead: 0.10,  cacheWrite: 0.75 },
  'kimi-k2':           { in: 0.60,  out: 2.50,   cacheRead: 0.15,  cacheWrite: 0.75 },
  'moonshot-v1-128k':  { in: 2.00,  out: 5.00,   cacheRead: null,  cacheWrite: null  },
  'moonshot-v1-32k':   { in: 1.00,  out: 3.00,   cacheRead: null,  cacheWrite: null  },
  'moonshot-v1-8k':    { in: 0.20,  out: 2.00,   cacheRead: null,  cacheWrite: null  },
  // GLM / Zhipu
  'glm-5.3':           { in: 1.14,  out: 3.99,   cacheRead: 0.29,  cacheWrite: null  },
  'glm-5.2':           { in: 1.14,  out: 3.99,   cacheRead: 0.29,  cacheWrite: null  },
  'glm-5.1':           { in: 0.86,  out: 3.42,   cacheRead: 0.19,  cacheWrite: null  },
  'glm-5':             { in: 0.57,  out: 2.57,   cacheRead: 0.14,  cacheWrite: null  },
  'glm-4.7':           { in: 0.29,  out: 1.14,   cacheRead: 0.06,  cacheWrite: null  },
  'glm-4.6':           { in: 0.86,  out: 3.14,   cacheRead: 0.16,  cacheWrite: null  },
  // Qwen
  'qwen3-max':         { in: 1.20,  out: 6.00,   cacheRead: null,  cacheWrite: null  },
  'qwen3':             { in: 0.40,  out: 1.60,   cacheRead: null,  cacheWrite: null  },
  // MiniMax
  'minimax-m3.1-flash':{ in: 0.15,  out: 0.60,   cacheRead: 0.015, cacheWrite: null  },
  'minimax-m3':        { in: 0.30,  out: 1.20,   cacheRead: 0.06,  cacheWrite: null  },
  'minimax-m2.7':      { in: 0.30,  out: 1.20,   cacheRead: 0.06,  cacheWrite: 0.38 },
  'minimax-m2.5':      { in: 0.30,  out: 1.20,   cacheRead: 0.03,  cacheWrite: 0.38 },
  // Mimo
  'mimo-v2-flash':     { in: 0.10,  out: 0.30,   cacheRead: 0.01,  cacheWrite: 0.13 },
  'mimo-v2-pro':       { in: 1.00,  out: 3.00,   cacheRead: 0.20,  cacheWrite: 1.25 },
  // Groq / Meta Llama
  'llama-3.3-70b':     { in: 0.59,  out: 0.79,   cacheRead: null,  cacheWrite: null  },
  'llama-3.1-8b':      { in: 0.05,  out: 0.08,   cacheRead: null,  cacheWrite: null  },
  // Mistral
  'devstral-2':        { in: 0.40,  out: 0.90,   cacheRead: 0.04,  cacheWrite: 0.50 },
  // auto / default
  'auto':              { in: 3.00,  out: 15.00,  cacheRead: 0.30,  cacheWrite: 3.75 },
  '_default':          { in: 2.00,  out: 10.00,  cacheRead: 0.50,  cacheWrite: 2.50 },
};

const _BASE_PRICING = JSON.parse(JSON.stringify(PRICING));

// Sorted by key length descending for prefix-match fallback
let _sortedKeys = Object.keys(PRICING)
  .filter(k => k !== '_default')
  .sort((a, b) => b.length - a.length);

// providerId → { model → rates }
let PROVIDER_PRICING = {};
let _providerSortedKeys = {};

function _lookupGlobal(model) {
  if (!model) return PRICING['_default'];
  const m = String(model).toLowerCase();
  if (PRICING[m]) return PRICING[m];
  for (const k of _sortedKeys) {
    if (m.includes(k)) return PRICING[k];
  }
  return PRICING['_default'];
}

function _lookupProvider(providerId, model) {
  if (!providerId || !model) return null;
  const pid = String(providerId).toLowerCase();
  const table = PROVIDER_PRICING[pid];
  if (!table) return null;
  const m = String(model).toLowerCase();
  if (table[m]) return table[m];
  const keys = _providerSortedKeys[pid] || [];
  for (const k of keys) {
    if (m.includes(k)) return table[k];
  }
  return null;
}

/** provider 是否配置了该模型的刊例价 */
function hasProviderPricing(providerId, model) {
  return !!_lookupProvider(providerId, model);
}

/** 按 provider 刊例价（yaml + 用户覆盖） */
function applyProviderPricing(byProvider = {}) {
  PROVIDER_PRICING = {};
  _providerSortedKeys = {};
  for (const [pid, models] of Object.entries(byProvider || {})) {
    const key = String(pid).toLowerCase();
    PROVIDER_PRICING[key] = {};
    for (const [m, v] of Object.entries(models || {})) {
      if (!v || typeof v !== 'object') continue;
      PROVIDER_PRICING[key][String(m).toLowerCase()] = { ...v };
    }
    _providerSortedKeys[key] = Object.keys(PROVIDER_PRICING[key]).sort((a, b) => b.length - a.length);
  }
}

/** 全局刊例价覆盖（无 provider 时回退） */
function applyOverrides(overrides = {}) {
  for (const k of Object.keys(PRICING)) delete PRICING[k];
  Object.assign(PRICING, JSON.parse(JSON.stringify(_BASE_PRICING)));
  if (overrides && typeof overrides === 'object') {
    for (const [k, v] of Object.entries(overrides)) {
      if (!v || typeof v !== 'object') continue;
      PRICING[k.toLowerCase()] = { ...(PRICING[k.toLowerCase()] || {}), ...v };
    }
  }
  _sortedKeys = Object.keys(PRICING).filter(k => k !== '_default').sort((a, b) => b.length - a.length);
}

// 兼容旧名
function _lookup(model) { return _lookupGlobal(model); }

/**
 * Estimate USD cost for one request.
 * All token counts are raw counts (not millions).
 * Returns 0 for unknown/zero-token requests.
 */
function estimateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, providerId) {
  const p = _lookupProvider(providerId, model) || _lookupGlobal(model);
  const inCost = ((inputTokens      || 0) / 1e6) * (p.in  || 0);
  const outCost= ((outputTokens     || 0) / 1e6) * (p.out || 0);
  const cwCost = ((cacheWriteTokens || 0) / 1e6) * (p.cacheWrite || p.in * 1.25 || 0);
  const crCost = ((cacheReadTokens  || 0) / 1e6) * (p.cacheRead  != null ? p.cacheRead : p.in * 0.10);
  return inCost + outCost + cwCost + crCost;
}

/**
 * 按量刊例价估算：仅使用 provider 独立刊例价，无配置则返回 0（不回退全局价）。
 * 用于盘点等费用展示。
 */
function estimatePaygCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, providerId) {
  const p = _lookupProvider(providerId, model);
  if (!p) return 0;
  const inCost = ((inputTokens      || 0) / 1e6) * (p.in  || 0);
  const outCost= ((outputTokens     || 0) / 1e6) * (p.out || 0);
  const cwCost = ((cacheWriteTokens || 0) / 1e6) * (p.cacheWrite || p.in * 1.25 || 0);
  const crCost = ((cacheReadTokens  || 0) / 1e6) * (p.cacheRead  != null ? p.cacheRead : p.in * 0.10);
  return inCost + outCost + cwCost + crCost;
}

module.exports = { estimateCost, estimatePaygCost, hasProviderPricing, PRICING, applyOverrides, applyProviderPricing };
