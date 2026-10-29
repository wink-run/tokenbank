// client/electron/billing-config.js
// 订阅/按量目录来自 providers.registry.yaml（billing_sources）；刊例价按 provider 独立配置。
'use strict';

const configLoader = require('./config-loader');

const FALLBACK_SUBSCRIPTION_PLANS = {
  'anthropic-paid': [
    { id: 'claude-pro', label: 'Claude Pro', monthly_usd: 20 },
    { id: 'max5x', label: 'Claude Max (5×)', monthly_usd: 100 },
    { id: 'max20x', label: 'Claude Max (20×)', monthly_usd: 200 },
  ],
  openai: [
    { id: 'chatgpt-plus', label: 'ChatGPT Plus', monthly_usd: 20 },
    { id: 'chatgpt-team', label: 'ChatGPT Team', monthly_usd: 25 },
    { id: 'chatgpt-pro', label: 'ChatGPT Pro', monthly_usd: 200 },
  ],
  gemini: [
    { id: 'gemini-advanced', label: 'Gemini Advanced', monthly_usd: 20 },
    { id: 'google-one-ai', label: 'Google One AI', monthly_usd: 20 },
  ],
  'github-copilot': [
    { id: 'copilot-pro', label: 'GitHub Copilot Pro', monthly_usd: 10 },
    { id: 'copilot-business', label: 'Copilot Business', monthly_usd: 19 },
  ],
  cursor: [
    { id: 'cursor-pro', label: 'Cursor Pro', monthly_usd: 20 },
    { id: 'cursor-ultra', label: 'Cursor Ultra', monthly_usd: 200 },
  ],
  volcengine: [
    { id: 'coding-lite', label: 'Coding Plan Lite · 40元/月', monthly_usd: 5.71 },
    { id: 'coding-pro', label: 'Coding Plan Pro · 200元/月', monthly_usd: 28.57 },
  ],
};

function normPlan(p) {
  if (Array.isArray(p)) return { id: p[0], label: p[1], monthly_usd: null };
  if (!p || typeof p !== 'object') return null;
  return {
    id: String(p.id || ''),
    label: String(p.label || p.id || ''),
    monthly_usd: p.monthly_usd != null && p.monthly_usd !== '' ? Number(p.monthly_usd) : null,
  };
}

const PRICING_META_KEYS = new Set(['_excluded_models', 'excluded_models']);

function inferModalityFromPricing(rates) {
  if (!rates || typeof rates !== 'object') return 'chat';
  if (rates.image != null && rates.in == null && rates.out == null && rates.cacheRead == null) return 'image';
  return 'chat';
}

/** models 与 pricing 键对齐（与 server sync_catalog_models_pricing 一致） */
function syncModelsPricing(models = [], pricing = {}) {
  const pricingOut = {};
  for (const [k, v] of Object.entries(pricing || {})) {
    const kn = String(k || '').trim();
    if (!kn || PRICING_META_KEYS.has(kn)) continue;
    pricingOut[kn] = (v && typeof v === 'object') ? { ...v } : {};
  }
  const modelsOut = [];
  const seen = new Set();
  for (const m of models || []) {
    const n = String(m || '').trim();
    if (!n || PRICING_META_KEYS.has(n) || seen.has(n)) continue;
    seen.add(n);
    modelsOut.push(n);
    if (!pricingOut[n]) pricingOut[n] = {};
  }
  for (const k of Object.keys(pricingOut)) {
    if (seen.has(k)) continue;
    seen.add(k);
    modelsOut.push(k);
  }
  return { models: modelsOut, pricing: pricingOut };
}

/** 渲染进程 /api/catalog 快照；模板与刊例价以之为准，覆盖本地 billing_sources 漂移 */
let _liveCatalogById = {};
let _liveSubscriptionSources = [];

function setLiveCatalogProviders(providers) {
  _liveCatalogById = {};
  for (const p of providers || []) {
    if (!p?.id) continue;
    const names = [];
    const modelTypes = {};
    for (const m of p.models || []) {
      const n = typeof m === 'string' ? m : (m.name || m.id || m.model);
      if (!n) continue;
      const name = String(n).trim();
      names.push(name);
      if (typeof m === 'object') modelTypes[name] = m.type || m.modality || 'chat';
    }
    const synced = syncModelsPricing(names, p.pricing || {});
    for (const name of synced.models) {
      if (!modelTypes[name]) {
        modelTypes[name] = inferModalityFromPricing(synced.pricing[name]);
      }
    }
    _liveCatalogById[p.id] = {
      models: synced.models,
      pricing: synced.pricing,
      model_types: modelTypes,
      label: p.label || p.id,
      icon: p.icon || '🔧',
      base_url: p.base_url || '',
      api_format: p.api_format || 'openai',
      payg: p.payg === true,
      type: p.type || 'paid',
    };
  }
}

/** 写入 /api/catalog 完整响应（providers + subscription_sources） */
function setLiveCatalogPayload(payload = {}) {
  const doc = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { providers: payload };
  setLiveCatalogProviders(doc.providers || []);
  _liveSubscriptionSources = Array.isArray(doc.subscription_sources) ? doc.subscription_sources : [];
}

/** 已被 APP/API 订阅引用的 plan_provider_id（如 volcengine），不应再作为独立按量模板 */
function referencedPlanProviderIds() {
  const ids = new Set();
  for (const s of configLoader.billingSourcesList()) {
    if (s.category !== 'app_sub' && s.category !== 'api_sub') continue;
    const pp = s.plan_provider_id;
    if (pp) ids.add(pp);
  }
  for (const s of _liveSubscriptionSources) {
    if (s.plan_provider_id) ids.add(s.plan_provider_id);
  }
  return ids;
}

function liveCatalogPaygEntry(entry) {
  const id = entry.provider_id || entry.id;
  const live = id && _liveCatalogById[id];
  if (!live) return entry;
  return { ...entry, models: [...live.models], pricing: { ...live.pricing } };
}

/** 归一化 payg_providers 条目：models 列表 + 该 provider 独立 pricing */
function normPaygEntry(p) {
  const id = String(p.id || p.provider_id || '');
  const models = [];
  const pricing = {};
  // pricing 段：model → rates
  if (p.pricing && typeof p.pricing === 'object') {
    for (const [m, rates] of Object.entries(p.pricing)) {
      if (rates && typeof rates === 'object') pricing[m] = { ...rates };
    }
  }
  // models 可为字符串或带 inline 报价的对象
  if (Array.isArray(p.models)) {
    for (const m of p.models) {
      if (typeof m === 'string') {
        models.push(m);
      } else if (m && typeof m === 'object') {
        const mid = m.id || m.model || m.name;
        if (!mid) continue;
        models.push(mid);
        const { id: _i, model: _m, name: _n, type: _t, ...rates } = m;
        if (rates.in != null || rates.out != null || rates.cacheRead != null) {
          pricing[mid] = { ...(pricing[mid] || {}), ...rates };
        }
      }
    }
  }
  const synced = syncModelsPricing(models, pricing);
  return {
    id,
    provider_id: id,
    label: p.label || p.name || id,
    icon: p.icon || '🔧',
    aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [],
    api_format: p.api_format || 'openai',
    handler: p.handler || 'openai',
    base_url: p.base_url || '',
    // 目录默认路由层（free/paid/p2p）
    tier: p.tier === 'free' || p.tier === 'p2p' || p.tier === 'paid' ? p.tier : undefined,
    models: synced.models,
    pricing: synced.pricing,
  };
}

/** registry 中按 provider id 查 base_url（订阅/API 源常通过 plan_provider_id 关联） */
function registryBaseUrl(providerId) {
  if (!providerId) return '';
  const reg = configLoader.registryProviders().find(p => p.id === providerId);
  return reg?.base_url || '';
}

function getSubscriptionPlans(cfg = {}) {
  const yamlDefaults = configLoader.subscriptionPlansDefaults();
  const user = cfg.subscription_plans || {};
  const ids = new Set([...Object.keys(FALLBACK_SUBSCRIPTION_PLANS), ...Object.keys(yamlDefaults), ...Object.keys(user)]);
  const out = {};
  for (const pid of ids) {
    const raw = user[pid] ?? yamlDefaults[pid] ?? FALLBACK_SUBSCRIPTION_PLANS[pid] ?? [];
    out[pid] = (Array.isArray(raw) ? raw : []).map(normPlan).filter(pl => pl && pl.id);
  }
  return out;
}

/** 合并 registry 与 payg_providers 目录条目；billing_sources（next）为模型/报价权威源 */
function mergeCatalogEntries(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  const merged = {
    ...prev,
    ...next,
    label: next.label || prev.label,
    icon: next.icon || prev.icon,
    base_url: next.base_url || prev.base_url || '',
  };
  // 以 billing_sources 为准，不把 registry 里已下线模型并回来
  const pricing = { ...(next.pricing || {}) };
  for (const m of (next.models || [])) {
    if (!pricing[m]) pricing[m] = { ...(prev.pricing?.[m] || {}) };
  }
  const synced = syncModelsPricing(next.models || [], pricing);
  merged.models = synced.models;
  merged.pricing = synced.pricing;
  return merged;
}

function paygProviderCatalog() {
  const byId = new Map();
  // registry 打底（models/pricing 解析用，不进「可选源模板」列表）
  for (const p of configLoader.registryProviders()) {
    const norm = normPaygEntry(p);
    if (norm.provider_id) byId.set(norm.provider_id, norm);
  }
  // billing_sources 中的 payg 条目覆盖 registry（模板列表以 billing_sources 为准）
  for (const p of configLoader.paygProviders()) {
    const norm = normPaygEntry(p);
    if (!norm.provider_id) continue;
    byId.set(norm.provider_id, mergeCatalogEntries(byId.get(norm.provider_id), norm));
  }
  // /api/catalog 优先于本地 registry 漂移
  for (const [id, live] of Object.entries(_liveCatalogById)) {
    const cur = byId.get(id);
    if (cur) byId.set(id, { ...cur, models: live.models, pricing: live.pricing });
  }
  return [...byId.values()];
}

/** 源目录 payg 列表（billing_sources 中 category=payg，与云端模板数一致） */
function paygSourcesCatalog() {
  return configLoader.billingSourcesList()
    .filter(s => s.category === 'payg')
    .map(s => {
      const details = configLoader.modelsFromBillingSource(s);
      const modelTypes = {};
      for (const m of details) modelTypes[m.id] = m.modality || 'chat';
      const norm = normPaygEntry({
        id: s.id,
        provider_id: s.id,
        label: s.label,
        icon: s.icon,
        aliases: s.aliases,
        models: details.map(m => m.id),
        pricing: s.pricing,
        api_format: s.api_format,
        base_url: s.base_url,
        tier: s.tier,
      });
      return liveCatalogPaygEntry({ ...norm, tier: s.tier, model_types: modelTypes });
    })
    .filter(p => p.provider_id);
}

/** yaml + registry 合并后的按 provider 刊例价 */
function getYamlProviderPricing() {
  const out = {};
  for (const norm of paygProviderCatalog()) {
    if (norm.provider_id && Object.keys(norm.pricing).length) {
      out[norm.provider_id] = norm.pricing;
    }
  }
  return out;
}

/** 三层合并刊例价：服务端 catalog < 模板覆盖 pricing < 运行时 provider_pricing_overrides */
function getProviderPricing(cfg = {}) {
  const yaml = getYamlProviderPricing();
  const tplOv = cfg.source_template_overrides || {};        // 模板覆盖（中间层）
  const overrides = cfg.provider_pricing_overrides || {};   // 运行时覆盖（最高优先级）
  const tplPricingOf = (pid) => (tplOv[pid] && typeof tplOv[pid].pricing === 'object' ? tplOv[pid].pricing : {});
  const ids = new Set([...Object.keys(yaml), ...Object.keys(tplOv), ...Object.keys(overrides)]);
  const merged = {};
  for (const pid of ids) {
    merged[pid] = { ...(yaml[pid] || {}) };
    for (const [model, rates] of Object.entries(tplPricingOf(pid))) {
      merged[pid][model] = { ...(merged[pid][model] || {}), ...rates };
    }
    for (const [model, rates] of Object.entries(overrides[pid] || {})) {
      if (model === '_excluded_models') continue;
      if (!rates || typeof rates !== 'object' || Array.isArray(rates)) continue;
      merged[pid][model] = { ...(merged[pid][model] || {}), ...rates };
    }
  }
  return merged;
}

/** 将用量记录里的 provider_id 解析为 payg 定价键（支持 aliases） */
function resolvePricingProviderId(providerId) {
  if (!providerId) return null;
  const pid = String(providerId).toLowerCase();
  for (const p of paygProviderCatalog()) {
    const key = String(p.provider_id || p.id || '').toLowerCase();
    if (key === pid) return p.provider_id;
    if ((p.aliases || []).some(a => String(a).toLowerCase() === pid)) return p.provider_id;
  }
  return providerId;
}

function getBillingSettings(cfg = {}) {
  const yamlPlans = configLoader.subscriptionPlansDefaults();
  return {
    subscription_plans: getSubscriptionPlans(cfg),
    provider_pricing: getProviderPricing(cfg),
    provider_pricing_overrides: cfg.provider_pricing_overrides || {},
    provider_labels: buildProviderLabels(),
    defaults: {
      subscription_plans: { ...FALLBACK_SUBSCRIPTION_PLANS, ...yamlPlans },
      provider_pricing: getProviderPricing({}),
    },
  };
}

function buildProviderLabels() {
  const labels = {};
  for (const p of paygProviderCatalog()) {
    const id = p.provider_id || p.id;
    if (id) labels[id] = p.label || id;
  }
  return labels;
}

/** 同步运行时定价表 */
function applyPricingOverrides(overrides = {}) {
  const pricing = require('./pricing');
  const merged = getProviderPricing({ provider_pricing_overrides: overrides });
  if (typeof pricing.applyProviderPricing === 'function') {
    pricing.applyProviderPricing(merged);
  }
}

function subscriptionAppCatalog(cfg = {}) {
  const plans = getSubscriptionPlans(cfg);
  return configLoader.subscriptionApps().map(a => {
    const planKey = a.plan_provider_id || a.provider_id || null;
    const appPlans = Array.isArray(a.plans) && a.plans.length
      ? a.plans.map(normPlan).filter(Boolean)
      : (planKey && plans[planKey] ? plans[planKey] : []);
    return {
      source_id: a.source_id || a.id || a.agent_id,
      agent_id: a.agent_id,
      provider_id: a.provider_id,
      plan_provider_id: planKey,
      // 订阅是否可转为 API 供给源（yaml subscription_to_api，默认 false）
      subscription_to_api: a.subscription_to_api === true,
      app_name: a.app_name || a.name || a.agent_id,
      app_icon: a.app_icon || a.icon || '🔧',
      plans: appPlans,
      api_format: a.api_format || null,
      base_url: a.base_url || registryBaseUrl(planKey) || '',
      models: Array.isArray(a.models) ? a.models : [],
      pricing: (a.pricing && typeof a.pricing === 'object') ? a.pricing : {},
    };
  });
}

/** 预置 API 订阅目录（ChatGPT、Claude 等；与供给源页 provider 列表分离） */
function apiSubscriptionCatalog(cfg = {}) {
  const plans = getSubscriptionPlans(cfg);
  return configLoader.apiSubscriptionApps().map(a => {
    const planKey = a.plan_provider_id || null;
    const appPlans = Array.isArray(a.plans) && a.plans.length
      ? a.plans.map(normPlan).filter(Boolean)
      : (planKey && plans[planKey] ? plans[planKey] : []);
    return {
      source_id: a.source_id || a.id,
      plan_provider_id: planKey,
      app_name: a.app_name || a.name || a.source_id,
      app_icon: a.app_icon || a.icon || '🔑',
      plans: appPlans,
      api_format: a.api_format || null,
      base_url: a.base_url || registryBaseUrl(planKey) || '',
      models: Array.isArray(a.models) ? a.models : [],
      pricing: (a.pricing && typeof a.pricing === 'object') ? a.pricing : {},
    };
  });
}

/**
 * 个人页已登记的付费供给源 id（订阅 + 按量，含仅统计类）：
 * - 订阅账户 → subscription_catalog.plan_provider_id
 * - 按量账户 → user_payg_providers.provider_id
 */
function resolveUserPaidProviderIds(cfg = {}) {
  const ids = new Set();
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  for (const sub of cfg.user_subscriptions || []) {
    const gid = subscriptionGatewayId(sub, catalogBySource);
    if (gid) ids.add(gid);
  }
  for (const p of cfg.user_payg_providers || []) {
    const gid = paygGatewayId(p);
    if (gid) ids.add(gid);
  }
  return [...ids];
}

/** 单条订阅是否启用「订阅转 API」：用户登记优先，否则 yaml 目录默认 */
function resolveSubUseApi(sub, catalogBySource) {
  if (sub?.subscription_kind === 'api') return true;
  if (sub?.subscription_to_api != null) return sub.subscription_to_api === true;
  const cat = catalogBySource[sub?.source_id];
  return cat?.subscription_to_api === true;
}

/** 单条按量账户对应的网关 provider id（多实例时各用独立 gateway_id） */
function paygGatewayId(p) {
  return (p && p.gateway_id) || p?.provider_id || null;
}

/** 单条订阅对应的网关 provider id（未写 gateway_id 时走旧逻辑） */
function subscriptionGatewayId(sub, catalogBySource) {
  if (sub?.gateway_id) return sub.gateway_id;
  if (sub.custom) return sub.source_id || sub.plan_provider_id || null;
  if (sub.subscription_kind === 'api') return sub.plan_provider_id || sub.source_id || null;
  if (!resolveSubUseApi(sub, catalogBySource)) return sub.gateway_id || null;
  return subscriptionGatewayProviderId(sub, catalogBySource);
}

/** 订阅转 API 时对应的供给源 id（自定义订阅固定用 source_id） */
function subscriptionGatewayProviderId(sub, catalogBySource) {
  if (!sub) return null;
  if (sub.custom) return sub.source_id || sub.plan_provider_id || null;
  if (sub.subscription_kind === 'api') return sub.plan_provider_id || null;
  const cat = catalogBySource[sub.source_id];
  return cat?.plan_provider_id || null;
}

/** 订阅转 API 的验证方式：APP 目录 OAuth；API 订阅与自定义均 API Key */
function subscriptionGatewayAuthMode(sub, catalogBySource) {
  if (!resolveSubUseApi(sub, catalogBySource)) return null;
  if (sub.subscription_kind === 'api') return 'api_key';
  if (sub.custom) return 'api_key';
  const cat = catalogBySource[sub.source_id];
  return cat?.plan_provider_id ? 'oauth' : 'api_key';
}

/** 订阅登记且 subscription_to_api=true 的供给源 id */
function resolveSubscriptionGatewayProviderIds(cfg = {}) {
  const ids = new Set();
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  for (const sub of cfg.user_subscriptions || []) {
    const pid = subscriptionGatewayId(sub, catalogBySource);
    if (pid && resolveSubUseApi(sub, catalogBySource)) ids.add(pid);
  }
  return [...ids];
}

/** 个人页按量账户对应的供给源 id */
function resolveGatewayPaygProviderIds(cfg = {}) {
  const ids = new Set();
  for (const p of cfg.user_payg_providers || []) {
    const id = paygGatewayId(p);
    if (id) ids.add(id);
  }
  return [...ids];
}

/** 各 provider 在供给源页的验证方式：oauth（订阅转 API）/ api_key（按量）/ both */
function resolveProviderGatewayAuthMap(cfg = {}) {
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  const modes = {};

  for (const sub of cfg.user_subscriptions || []) {
    const pid = subscriptionGatewayId(sub, catalogBySource);
    const auth = subscriptionGatewayAuthMode(sub, catalogBySource);
    if (!pid || !auth) continue;
    if (modes[pid] && modes[pid] !== auth) modes[pid] = 'both';
    else modes[pid] = auth;
  }

  for (const p of cfg.user_payg_providers || []) {
    const id = paygGatewayId(p);
    if (!id) continue;
    if (modes[id] === 'oauth') modes[id] = 'both';
    else modes[id] = 'api_key';
  }
  return modes;
}

/** 供给源选择器条目（与 Providers 页展示一致） */
function buildGatewayPickerEntries(cfg = {}) {
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  const entries = [];

  for (const sub of cfg.user_subscriptions || []) {
    if (!resolveSubUseApi(sub, catalogBySource)) continue;
    if (sub.custom) {
      entries.push({
        providerId: sub.source_id,
        pickerKey: `sub:${sub.source_id}`,
        label: sub.app_name || sub.source_id,
        icon: sub.app_icon || '🔧',
        authMode: 'api_key',
        source: 'subscription',
        custom: true,
        personalTag: sub.subscription_kind === 'api' ? 'api_sub' : 'sub_to_api',
      });
      continue;
    }
    if (sub.subscription_kind === 'api') {
      const pid = sub.plan_provider_id || sub.source_id;
      if (!pid) continue;
      entries.push({
        providerId: pid,
        pickerKey: `sub:${sub.source_id || `api-${pid}`}`,
        label: sub.app_name || pid,
        icon: sub.app_icon || '🔑',
        authMode: 'api_key',
        source: 'subscription',
        custom: true,
        personalTag: 'api_sub',
      });
      continue;
    }
    const cat = catalogBySource[sub.source_id];
    const pid = cat?.plan_provider_id;
    if (!pid) continue;
    entries.push({
      providerId: pid,
      pickerKey: `sub:${sub.source_id}`,
      label: sub.app_name || cat?.app_name || pid,
      icon: sub.app_icon || cat?.app_icon || '🔷',
      authMode: 'oauth',
      source: 'subscription',
      personalTag: 'sub_to_api',
    });
  }

  for (const payg of cfg.user_payg_providers || []) {
    const pid = payg.provider_id;
    if (!pid) continue;
    entries.push({
      providerId: pid,
      pickerKey: `payg:${pid}`,
      label: payg.label || pid,
      icon: payg.icon || '🔧',
      authMode: 'api_key',
      source: 'payg',
      personalTag: 'payg',
    });
  }
  return entries;
}

/** 可在供给源页接入的 id：订阅转 API + 按量账户 */
function resolveUserGatewayProviderIds(cfg = {}) {
  return [...new Set([
    ...resolveSubscriptionGatewayProviderIds(cfg),
    ...resolveGatewayPaygProviderIds(cfg),
  ])];
}

/** 仅用量统计、不能在供给源页接入的 provider（订阅未开启 subscription_to_api） */
function resolveStatsOnlyProviderIds(cfg = {}) {
  const gateway = new Set(resolveUserGatewayProviderIds(cfg));
  const paygIds = new Set(
    (cfg.user_payg_providers || []).map(p => p.provider_id).filter(Boolean),
  );
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(cfg).map(c => [c.source_id, c]),
  );
  const statsOnly = new Set();
  for (const sub of cfg.user_subscriptions || []) {
    const cat = catalogBySource[sub.source_id];
    const pid = cat?.plan_provider_id;
    // 有订阅映射但未开 subscription_to_api，且未单独登记按量 → 仅统计
    if (pid && !gateway.has(pid) && !paygIds.has(pid)) statsOnly.add(pid);
  }
  return [...statsOnly];
}

/** provider_pricing_overrides 中的非模型键（勿当作模型名） */
const PRICING_OVERRIDE_META_KEYS = new Set(['_excluded_models']);

function isValidModelName(name) {
  const n = String(name || '').trim();
  return !!n && !PRICING_OVERRIDE_META_KEYS.has(n) && n !== 'excluded_models';
}

/** 提取 provider.models 条目中的模型名 */
function modelEntryId(m) {
  if (typeof m === 'string') return isValidModelName(m) ? m : '';
  if (m && typeof m === 'object') {
    const n = String(m.name || m.id || m.model || '').trim();
    return isValidModelName(n) ? n : '';
  }
  return '';
}

/** 某网关 provider 在账户/刊例价中登记的全部模型名（与供给源页按模型视图一致） */
function collectModelsForGatewayProvider(gatewayId, localCfg = {}) {
  const names = new Set();
  const addName = (m) => {
    const n = modelEntryId(m);
    if (n) names.add(n);
  };
  if (!gatewayId) return names;

  const userPayg = localCfg.user_payg_providers || [];
  const userSubs = localCfg.user_subscriptions || [];
  const pricingOvr = localCfg.provider_pricing_overrides || {};
  const catalogBySource = Object.fromEntries(
    subscriptionAppCatalog(localCfg).map(c => [c.source_id, c]),
  );

  for (const p of userPayg) {
    if (paygGatewayId(p) !== gatewayId) continue;
    for (const m of p.models || []) addName(m);
    for (const k of Object.keys(pricingOvr[p.provider_id] || {})) addName(k);
  }
  for (const s of userSubs) {
    if (subscriptionGatewayId(s, catalogBySource) !== gatewayId) continue;
    const isApi = s.subscription_kind === 'api' || resolveSubUseApi(s, catalogBySource);
    if (!isApi) continue;
    for (const m of s.models || []) addName(m);
    const pid = s.plan_provider_id || subscriptionGatewayProviderId(s, catalogBySource) || s.source_id;
    for (const k of Object.keys(pricingOvr[pid] || {})) addName(k);
  }
  return names;
}

function mergeProviderModelEntries(existingModels, extraNames) {
  const names = new Set((existingModels || []).map(modelEntryId).filter(Boolean));
  for (const n of extraNames) if (n) names.add(n);
  return [...names].sort().map(name => {
    const prev = (existingModels || []).find(m => modelEntryId(m) === name);
    return prev && typeof prev === 'object' ? prev : { name, type: 'chat' };
  });
}

/** 运行时合并账户登记模型到 provider.models（网关路由 /v1/models 用） */
function enrichProvidersFromAccounts(providers, localCfg) {
  if (!localCfg || !Array.isArray(providers)) return providers || [];
  // provider id → 计费来源（subscription/payg），供路由策略区分（订阅 → 免费 → 按量；同档比速度）。
  // 同 id 既订阅又按量时以订阅为准。
  const srcMap = {};
  for (const s of (localCfg.user_subscriptions || [])) { if (s.gateway_id) srcMap[s.gateway_id] = 'subscription'; }
  for (const p of (localCfg.user_payg_providers || [])) { const g = paygGatewayId(p); if (g && !srcMap[g]) srcMap[g] = 'payg'; }
  // 模型基底用服务端 registry，再并上用户账户里登记的模型（不再灌入 OpenRouter 全量免费目录）
  return providers.map(p => {
    let next = p;
    const extra = collectModelsForGatewayProvider(p.id, localCfg);
    if (extra.size) {
      const merged = mergeProviderModelEntries(p.models, extra);
      const before = (p.models || []).map(modelEntryId).filter(Boolean).sort().join('\0');
      const after = merged.map(modelEntryId).filter(Boolean).sort().join('\0');
      if (before !== after) next = { ...next, models: merged };
    }
    const src = srcMap[p.id];
    if (src && next.source !== src) next = { ...next, source: src };
    return next;
  });
}

/** 将账户/刊例价模型写回 agent config（不改 enabled，由供给源页开关控制） */
function syncGatewayProvidersFromAccounts(agentCfg, localCfg) {
  if (!agentCfg || !Array.isArray(agentCfg.providers)) return { cfg: agentCfg, changed: false };
  const gatewayIds = new Set(resolveUserGatewayProviderIds(localCfg));
  let changed = false;
  const providers = agentCfg.providers.map(p => {
    let next = { ...p };
    if (gatewayIds.has(p.id)) {
      const extra = collectModelsForGatewayProvider(p.id, localCfg);
      if (extra.size) {
        const merged = mergeProviderModelEntries(next.models, extra);
        const before = (next.models || []).map(modelEntryId).filter(Boolean).sort().join('\0');
        const after = merged.map(modelEntryId).filter(Boolean).sort().join('\0');
        if (before !== after) {
          next = { ...next, models: merged };
          changed = true;
        }
      }
    }
    return next;
  });
  if (!changed) return { cfg: agentCfg, changed: false };
  return { cfg: { ...agentCfg, providers }, changed: true };
}

/** @deprecated 使用 syncGatewayProvidersFromAccounts */
function syncProviderModelsFromAccounts(agentCfg, localCfg) {
  return syncGatewayProvidersFromAccounts(agentCfg, localCfg);
}

/**
 * 清理旧逻辑遗留的供给源配置：
 * - 移除未在个人页登记的 custom-* 供给源
 * - 未启用的付费源清空 models（去掉 yaml 预填）
 * - 已启用但不在个人页登记列表的付费源强制禁用
 */
function migrateAgentProviders(cfg = {}) {
  const gatewayIds = new Set(resolveUserGatewayProviderIds(cfg));
  if (!Array.isArray(cfg.providers)) return { cfg, changed: false };
  let changed = false;
  const next = [];
  for (const raw of cfg.providers) {
    const p = { ...raw };
    if (p.type === 'paid') {
      if (String(p.id || '').startsWith('custom-') && !gatewayIds.has(p.id)) {
        changed = true;
        continue;
      }
      if (!p.enabled) {
        if (Array.isArray(p.models) && p.models.length) {
          p.models = [];
          changed = true;
        }
      } else if (!gatewayIds.has(p.id)) {
        p.enabled = false;
        p.models = [];
        changed = true;
      }
    }
    next.push(p);
  }
  if (changed) cfg.providers = next;
  return { cfg, changed };
}

// ── 源模板（catalog + 本地模板覆盖）/ 直连源 / 同步差异 / 账户统计 ────────────────

/** 稳定序列化（键排序），供模板快照哈希 */
function stableStringify(obj) {
  if (obj == null) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(obj).sort()
    .map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** djb2 短哈希（非加密，仅用于「服务端模板是否变过」比对） */
function stableHash(obj) {
  const s = stableStringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 服务端下发的 catalog 键集合（含 billing_sources + live catalog 补全的模板） */
function serverCatalogKeySets() {
  const templates = serverTemplatesByKey({});
  const paygIds = new Set(
    Object.entries(templates).filter(([, t]) => t.kind === 'payg').map(([k]) => k),
  );
  const appSubIds = new Set(
    subscriptionAppCatalog({}).map(a => a.source_id).filter(Boolean),
  );
  const apiSubIds = new Set(
    apiSubscriptionCatalog({}).map(a => a.source_id).filter(Boolean),
  );
  const allTemplateKeys = new Set([...paygIds, ...appSubIds, ...apiSubIds]);
  const pricingProviderIds = new Set(paygIds);
  for (const a of subscriptionAppCatalog({})) {
    if (a.plan_provider_id) pricingProviderIds.add(a.plan_provider_id);
  }
  for (const a of apiSubscriptionCatalog({})) {
    if (a.plan_provider_id) pricingProviderIds.add(a.plan_provider_id);
  }
  return { paygIds, appSubIds, apiSubIds, allTemplateKeys, pricingProviderIds };
}

/** 订阅型 APP 源（不走按量模板补全） */
const SUBSCRIPTION_ONLY_CATALOG_IDS = new Set([
  'openai', 'anthropic-paid', 'gemini', 'github-copilot', 'cursor',
]);

/** 仅服务端 catalog 的源模板（可选账户类型以此为准） */
function serverTemplatesByKey(cfg = {}) {
  const m = {};
  const paygByKey = {};
  for (const p of paygSourcesCatalog()) {
    const k = p.provider_id || p.id;
    if (k) {
      m[k] = { kind: 'payg', key: k, label: p.label || k, icon: p.icon || '🔧',
        // 目录 tier（free/paid）供供给源 stub 默认路由层使用
        tier: p.tier === 'free' || p.tier === 'p2p' ? p.tier : 'paid',
        api_format: p.api_format || 'openai',
        base_url: p.base_url || registryBaseUrl(k) || '',
        models: p.models || [], pricing: p.pricing || {},
        model_types: p.model_types || {} };
      paygByKey[k] = m[k];
    }
  }
  // /api/catalog 有、billing_sources 未收录、且显式 payg 的 registry 供给源
  const planPids = referencedPlanProviderIds();
  for (const [id, live] of Object.entries(_liveCatalogById)) {
    if (m[id] || SUBSCRIPTION_ONLY_CATALOG_IDS.has(id) || planPids.has(id)) continue;
    const reg = configLoader.registryProviders().find(r => r.id === id);
    if (reg?.payg === false) continue;
    if (!(live.payg || reg?.payg === true)) continue;
    const modelTypes = { ...(live.model_types || {}) };
    for (const name of live.models || []) {
      if (!modelTypes[name]) modelTypes[name] = inferModalityFromPricing(live.pricing?.[name]);
    }
    const liveTier = live.type || reg?.tier;
    m[id] = {
      kind: 'payg', key: id,
      label: live.label || reg?.label || id,
      icon: live.icon || reg?.icon || '🔧',
      tier: liveTier === 'free' || liveTier === 'p2p' ? liveTier : 'paid',
      api_format: live.api_format || reg?.api_format || 'openai',
      base_url: live.base_url || reg?.base_url || registryBaseUrl(id) || '',
      models: live.models || [], pricing: live.pricing || {},
      model_types: modelTypes,
    };
    paygByKey[id] = m[id];
  }
  // 云端 billing_sources 滞后时：内置/本地 registry 显式 payg 仍进模板库
  for (const reg of configLoader.registryProviders()) {
    const id = reg && reg.id;
    if (!id || m[id] || SUBSCRIPTION_ONLY_CATALOG_IDS.has(id) || planPids.has(id)) continue;
    if (reg.payg !== true) continue;
    const details = Array.isArray(reg.models) ? reg.models : [];
    const modelNames = details.map((x) => (typeof x === 'string' ? x : (x && (x.name || x.id)))).filter(Boolean);
    const modelTypes = {};
    for (const x of details) {
      if (x && typeof x === 'object' && (x.name || x.id)) {
        modelTypes[x.name || x.id] = x.type || x.modality || 'chat';
      }
    }
    m[id] = {
      kind: 'payg', key: id,
      label: reg.label || id,
      icon: reg.icon || '🔧',
      tier: reg.tier === 'free' || reg.tier === 'p2p' ? reg.tier : 'paid',
      api_format: reg.api_format || 'openai',
      base_url: reg.base_url || '',
      models: modelNames,
      pricing: reg.pricing || {},
      model_types: modelTypes,
    };
    paygByKey[id] = m[id];
  }
  const fillSub = (models, pricing, planPid) => {
    if ((Array.isArray(models) && models.length) || Object.keys(pricing || {}).length) {
      return { models: models || [], pricing: pricing || {} };
    }
    const pp = planPid && paygByKey[planPid];
    return pp ? { models: pp.models || [], pricing: pp.pricing || {} } : { models: models || [], pricing: pricing || {} };
  };
  for (const a of subscriptionAppCatalog(cfg)) {
    const k = a.source_id;
    if (k) {
      const f = fillSub(a.models, a.pricing, a.plan_provider_id);
      m[k] = { kind: 'app_sub', key: k, label: a.app_name, icon: a.app_icon, agent_id: a.agent_id,
        subscription_to_api: a.subscription_to_api === true, plans: a.plans || [],
        plan_provider_id: a.plan_provider_id,
        api_format: a.api_format || (a.plan_provider_id && paygByKey[a.plan_provider_id]?.api_format) || 'openai',
        base_url: a.base_url || registryBaseUrl(a.plan_provider_id) || '',
        models: f.models, pricing: f.pricing };
    }
  }
  for (const a of apiSubscriptionCatalog(cfg)) {
    const k = a.source_id;
    if (k) {
      const f = fillSub(a.models, a.pricing, a.plan_provider_id);
      m[k] = { kind: 'api_sub', key: k, label: a.app_name, icon: a.app_icon,
        plan_provider_id: a.plan_provider_id, plans: a.plans || [],
        api_format: a.api_format || (a.plan_provider_id && paygByKey[a.plan_provider_id]?.api_format) || 'openai',
        base_url: a.base_url || registryBaseUrl(a.plan_provider_id) || '',
        models: f.models, pricing: f.pricing };
    }
  }
  // /api/catalog 下发的 APP/API 订阅（补全 billing_sources 未同步的新增项）
  for (const s of _liveSubscriptionSources) {
    const k = s.id;
    if (!k || m[k]) continue;
    const modelNames = (s.models || []).map(x => (typeof x === 'string' ? x : (x.name || x.id))).filter(Boolean);
    const pricing = s.pricing || {};
    const f = fillSub(modelNames, pricing, s.plan_provider_id);
    if (s.kind === 'api_sub') {
      m[k] = { kind: 'api_sub', key: k, label: s.label || k, icon: s.icon || '🔑',
        plan_provider_id: s.plan_provider_id, plans: s.plans || [],
        api_format: s.api_format || 'openai',
        base_url: s.base_url || registryBaseUrl(s.plan_provider_id) || '',
        models: f.models, pricing: f.pricing };
    } else if (s.kind === 'app_sub') {
      m[k] = { kind: 'app_sub', key: k, label: s.label || k, icon: s.icon || '🖱',
        agent_id: s.agent_id || k,
        subscription_to_api: s.subscription_to_api === true,
        plan_provider_id: s.plan_provider_id, plans: s.plans || [],
        api_format: s.api_format || 'openai',
        base_url: s.base_url || registryBaseUrl(s.plan_provider_id) || '',
        models: f.models, pricing: f.pricing };
    }
  }
  return m;
}

/** 服务端各 provider 允许的模型名集合（billing_sources 为准） */
function catalogModelSetsByProvider() {
  const out = {};
  for (const p of paygSourcesCatalog()) {
    const id = p.provider_id || p.id;
    if (!id) continue;
    const synced = syncModelsPricing(p.models || [], p.pricing || {});
    out[id] = new Set(synced.models);
  }
  return out;
}

/** 裁剪 override 里服务端已删除的模型 */
function pruneOverrideModels(override, allowed) {
  if (!override || typeof override !== 'object' || !allowed) return { next: override, changed: false };
  let changed = false;
  const next = { ...override };
  if (override.pricing && typeof override.pricing === 'object') {
    const pr = { ...override.pricing };
    for (const k of Object.keys(pr)) {
      if (!allowed.has(k)) { delete pr[k]; changed = true; }
    }
    next.pricing = pr;
  }
  if (Array.isArray(override.models)) {
    const ms = override.models.filter(m => allowed.has(m));
    if (ms.length !== override.models.length) { next.models = ms; changed = true; }
  }
  return { next, changed };
}

/** 服务端目录 ∪ 用户改过价的自配模型。账户里抄下来的旧目录不再算「允许」，否则服务端删模型后本地去不掉。 */
function allowedModelsForProvider(cfg, providerId, catalogSet) {
  const allowed = new Set(catalogSet || []);
  if (!providerId) return allowed;
  const ovr = cfg.provider_pricing_overrides?.[providerId];
  if (ovr && typeof ovr === 'object') {
    for (const k of Object.keys(ovr)) {
      if (!PRICING_OVERRIDE_META_KEYS.has(k)) allowed.add(k);
    }
  }
  return allowed;
}

/** 裁剪 provider 级 pricing override 里已下线的模型键 */
function prunePricingMap(map, allowed) {
  if (!map || typeof map !== 'object' || !allowed) return { next: map, changed: false };
  let changed = false;
  const next = { ...map };
  for (const k of Object.keys(next)) {
    if (k === '_excluded_models' || k === 'excluded_models') continue;
    if (!allowed.has(k)) { delete next[k]; changed = true; }
  }
  return { next, changed };
}

/**
 * 源目录同步后清理本地垃圾：自定义模板/实例、catalog 外条目、失效覆盖。
 * 可选账户类型以服务端 catalog 为准。
 */
function pruneLocalBillingAgainstServer(cfg = {}) {
  const modelSets = catalogModelSetsByProvider();
  const { paygIds, appSubIds, apiSubIds, allTemplateKeys, pricingProviderIds } = serverCatalogKeySets();
  let changed = false;

  if (cfg.custom_source_templates && Object.keys(cfg.custom_source_templates).length) {
    cfg.custom_source_templates = {};
    changed = true;
  }

  if (cfg.source_template_overrides && typeof cfg.source_template_overrides === 'object') {
    const next = {};
    for (const [k, v] of Object.entries(cfg.source_template_overrides)) {
      if (!allTemplateKeys.has(k)) { changed = true; continue; }
      const { next: pruned, changed: c } = pruneOverrideModels(v, modelSets[k]);
      if (c) changed = true;
      next[k] = pruned;
    }
    cfg.source_template_overrides = next;
  }

  const keepSub = (s) => {
    if (!s || typeof s !== 'object') return false;
    if (s.custom) return true; // 自定义实例纯本地，不参与 catalog 裁剪
    const sid = s.source_id;
    if (!sid) return false;
    if (s.subscription_kind === 'api') return apiSubIds.has(sid);
    return appSubIds.has(sid);
  };
  const nextSubs = (cfg.user_subscriptions || []).filter(keepSub);
  if (nextSubs.length !== (cfg.user_subscriptions || []).length) {
    cfg.user_subscriptions = nextSubs;
    changed = true;
  }

  const keepPayg = (p) => {
    if (!p || typeof p !== 'object') return false;
    if (p.custom) return true;
    const pid = p.provider_id;
    return !!(pid && paygIds.has(pid));
  };
  const nextPayg = (cfg.user_payg_providers || []).filter(keepPayg);
  if (nextPayg.length !== (cfg.user_payg_providers || []).length) {
    cfg.user_payg_providers = nextPayg;
    changed = true;
  }

  if (cfg.provider_pricing_overrides && typeof cfg.provider_pricing_overrides === 'object') {
    const next = {};
    for (const [k, v] of Object.entries(cfg.provider_pricing_overrides)) {
      if (!pricingProviderIds.has(k)) { changed = true; continue; }
      const allowed = allowedModelsForProvider(cfg, k, modelSets[k]);
      const { next: pruned, changed: c } = prunePricingMap(v, allowed);
      if (c) changed = true;
      next[k] = pruned;
    }
    cfg.provider_pricing_overrides = next;
  }

  // 按量 / API 订阅实例：去掉服务端已下线的模型，保留用户改过价的自配模型
  const nextSubsWithModels = (cfg.user_subscriptions || []).map(s => {
    if (!s || s.custom) return s;
    const pid = s.plan_provider_id || s.source_id;
    if (!pid || !modelSets[pid]) return s;
    const allowed = allowedModelsForProvider(cfg, pid, modelSets[pid]);
    const ms = (s.models || []).filter(m => allowed.has(typeof m === 'string' ? m : (m.id || m.name || m.model)));
    if (ms.length === (s.models || []).length) return s;
    changed = true;
    return { ...s, models: ms };
  });
  if (nextSubsWithModels !== cfg.user_subscriptions) cfg.user_subscriptions = nextSubsWithModels;

  const nextPaygWithModels = (cfg.user_payg_providers || []).map(p => {
    if (!p || p.custom || !p.provider_id || !modelSets[p.provider_id]) return p;
    const allowed = allowedModelsForProvider(cfg, p.provider_id, modelSets[p.provider_id]);
    const ms = (p.models || []).filter(m => allowed.has(typeof m === 'string' ? m : (m.id || m.name || m.model)));
    if (ms.length === (p.models || []).length) return p;
    changed = true;
    return { ...p, models: ms };
  });
  if (nextPaygWithModels !== cfg.user_payg_providers) cfg.user_payg_providers = nextPaygWithModels;

  if (Array.isArray(cfg.providers)) {
    const nextProviders = cfg.providers.map(p => {
      if (!p?.id || !modelSets[p.id]) return p;
      const allowed = allowedModelsForProvider(cfg, p.id, modelSets[p.id]);
      const ms = (p.models || []).filter(m => {
        const n = typeof m === 'string' ? m : (m.name || m.id || m.model);
        return n && allowed.has(n);
      });
      if (ms.length === (p.models || []).length) return p;
      changed = true;
      return { ...p, models: ms };
    });
    cfg.providers = nextProviders;
  }

  const mig = migrateAgentProviders(cfg);
  if (mig.changed) changed = true;

  return { cfg, changed };
}

/** 服务端原始模板（未应用本地覆盖），按 templateKey 索引：payg→provider_id；app_sub/api_sub→source_id */
function baseTemplatesByKey(cfg = {}) {
  // 可选账户类型：仅服务端 catalog（本地 custom 不再参与）
  return serverTemplatesByKey(cfg);
}

/** 模板「可覆盖字段」快照（diff/hash 基准） */
function templateSnapshot(base) {
  return {
    label: base.label, icon: base.icon,
    subscription_to_api: base.subscription_to_api,
    models: base.models, pricing: base.pricing, plans: base.plans,
  };
}

/** 在服务端模板上叠加本地覆盖，标 _override / _serverHash */
function applyTemplateOverride(base, override) {
  const serverHash = stableHash(templateSnapshot(base));
  if (!override || typeof override !== 'object') {
    return { ...base, _override: false, _serverHash: serverHash };
  }
  const merged = { ...base };
  if (override.label != null) merged.label = override.label;
  if (override.icon != null) merged.icon = override.icon;
  if (override.subscription_to_api != null) merged.subscription_to_api = override.subscription_to_api === true;
  if (Array.isArray(override.models)) merged.models = override.models;
  if (Array.isArray(override.plans)) merged.plans = override.plans;
  if (override.pricing && typeof override.pricing === 'object') {
    const allowed = new Set([...(base.models || []), ...Object.keys(base.pricing || {})]);
    merged.pricing = {};
    for (const k of allowed) {
      merged.pricing[k] = {
        ...((base.pricing || {})[k] || {}),
        ...((override.pricing || {})[k] || {}),
      };
    }
    merged.models = [...allowed];
  }
  return { ...merged, _override: true, _serverHash: serverHash, _baseHash: override._baseHash || null };
}

/** 源模板库：服务端 catalog + 本地模板覆盖（含 _override 标记），供「源模板库」网格/编辑 */
function getSourceTemplates(cfg = {}) {
  const ov = cfg.source_template_overrides || {};
  const bases = baseTemplatesByKey(cfg);
  return Object.keys(bases).map(key => applyTemplateOverride(bases[key], ov[key]));
}

/** 直连源实例（session_sources 里 direct_only + 用户为其设的 direct_source_billing）。
 *  activeAgentIds：仅保留这些 agent_id（main 进程按 apps 过滤「仍直连、未绑路由」的）；null=不过滤 */
function directSourceInstances(cfg = {}, excludeAgentIds = []) {
  const fs = require('fs');
  const billing = cfg.direct_source_billing || {};
  const exclude = new Set(excludeAgentIds || []);
  const out = [];
  for (const s of (configLoader.sessionSources() || [])) {
    if (!s || !s.direct_only || !s.agent_id) continue;
    if (exclude.has(s.agent_id)) continue;   // 已绑路由（走网关）的不再算「直连源」
    // 仅显示本机已安装的直连应用（会话数据目录存在）
    let installed = false;
    try { installed = !!s.root && fs.existsSync(configLoader.expandHome(s.root)); } catch {}
    if (!installed) continue;
    const b = billing[s.agent_id] || {};
    const pricing = (b.pricing && typeof b.pricing === 'object') ? b.pricing : {};
    // 计费类型与上面账户一致：订阅(月费) / API(按模型)。显式 mode 优先，否则按已填内容推断（兼容旧数据）。
    const mode = (b.mode === 'subscription' || b.mode === 'api')
      ? b.mode
      : (Object.keys(pricing).length > 0 && b.monthly_usd == null ? 'api' : 'subscription');
    const hasPricing = mode === 'api'
      ? Object.keys(pricing).length > 0
      : (b.monthly_usd != null);
    out.push({
      kind: 'direct',
      agent_id: s.agent_id,
      source_id: s.provider_id || s.agent_id,
      name: b.name || s.app_name || s.agent_id,
      label: s.app_name || s.agent_id,
      icon: s.app_icon || '🖱',
      mode,                                           // 'subscription' | 'api'
      monthly_usd: b.monthly_usd ?? null,             // 订阅型直连（如 Cursor）按月费估算
      // 模型：用户配了价就用配的，否则回退到应用默认支持的模型（yaml session_sources.models）
      models: Object.keys(pricing).length ? Object.keys(pricing) : (Array.isArray(s.models) ? s.models : []),
      pricing,
      has_pricing: hasPricing,                        // 对应类型没设价 → 红警告
    });
  }
  return out;
}

/** 逐字段比较「本地覆盖值」vs「服务端原始模板」，返回具体差异 */
function diffTemplateFields(override, base) {
  const changed = [];
  const cmp = (field, mine, server) => {
    if (mine === undefined) return;
    if (stableStringify(mine) !== stableStringify(server)) changed.push({ field, mine, server });
  };
  cmp('subscription_to_api', override.subscription_to_api, base.subscription_to_api);
  cmp('label', override.label, base.label);
  cmp('models', Array.isArray(override.models) ? override.models : undefined, base.models);
  cmp('plans', Array.isArray(override.plans) ? override.plans : undefined, base.plans);
  if (override.pricing && typeof override.pricing === 'object') {
    for (const [model, rates] of Object.entries(override.pricing)) {
      const serverRates = (base.pricing || {})[model];
      if (stableStringify(rates) !== stableStringify(serverRates)) {
        changed.push({ field: 'pricing', model, mine: rates, server: serverRates || null });
      }
    }
  }
  return changed;
}

/** 同步差异：① 自定义源同名→服务端已官方支持（迁移建议）；② 模板覆盖 vs 当前服务端模板（字段差异） */
function computeSyncDiff(cfg = {}) {
  const ov = cfg.source_template_overrides || {};
  const bases = baseTemplatesByKey(cfg);

  const officialByLabel = {};
  for (const [key, b] of Object.entries(bases)) {
    if (String(key).startsWith('custom-')) continue;
    const lbl = String(b.label || '').toLowerCase().trim();
    if (lbl) officialByLabel[lbl] = key;
  }
  const migrations = [];
  const pushMig = (kind, id, label, curKey) => {
    const hit = officialByLabel[String(label || '').toLowerCase().trim()];
    if (hit && hit !== curKey) migrations.push({ instanceKind: kind, instanceId: id, label, toTemplateKey: hit });
  };
  for (const s of (cfg.user_subscriptions || [])) if (s.custom) pushMig('subscription', s.id, s.app_name || s.name, s.source_id);
  for (const p of (cfg.user_payg_providers || [])) if (p.custom) pushMig('payg', p.id, p.label || p.name, p.provider_id);

  const overrideDrifts = [];
  for (const [key, o] of Object.entries(ov)) {
    if (!o || typeof o !== 'object') continue;
    const base = bases[key];
    if (!base) continue;            // 模板已下线
    const changed = diffTemplateFields(o, base);
    const serverChanged = !!(o._baseHash && o._baseHash !== stableHash(templateSnapshot(base)));
    if (changed.length) overrideDrifts.push({ templateKey: key, label: base.label, serverChanged, changedFields: changed });
  }

  return { migrations, overrideDrifts };
}

/** 账户统计：订阅（App+API 订阅）/ API（按量 + 直连） */
function accountStats(cfg = {}, directInstances = []) {
  const subs = Array.isArray(cfg.user_subscriptions) ? cfg.user_subscriptions : [];
  const payg = Array.isArray(cfg.user_payg_providers) ? cfg.user_payg_providers : [];
  // 直连源按各自计费类型计入订阅 / API，与上面账户两类规则一致
  let dSub = 0, dApi = 0;
  for (const d of (directInstances || [])) {
    if (d && d.mode === 'api') dApi++; else dSub++;
  }
  const subscription = subs.length + dSub;
  const api = payg.length + dApi;
  return { subscription, api, total: subscription + api };
}

function getUserAccounts(cfg = {}, opts = {}) {
  const billing = getBillingSettings(cfg);
  const paidIds = resolveUserPaidProviderIds(cfg);
  const gatewaySubIds = resolveSubscriptionGatewayProviderIds(cfg);
  const gatewayPaygIds = resolveGatewayPaygProviderIds(cfg);
  const directInstances = directSourceInstances(cfg, opts.boundDirectAgentIds || []);
  return {
    subscription_catalog: subscriptionAppCatalog(cfg),
    api_subscription_catalog: apiSubscriptionCatalog(cfg),
    payg_provider_catalog: paygProviderCatalog(),
    user_subscriptions: Array.isArray(cfg.user_subscriptions) ? cfg.user_subscriptions : [],
    user_payg_providers: Array.isArray(cfg.user_payg_providers) ? cfg.user_payg_providers : [],
    paid_provider_ids: paidIds,
    gateway_provider_ids: resolveUserGatewayProviderIds(cfg),
    gateway_subscription_provider_ids: gatewaySubIds,
    gateway_payg_provider_ids: gatewayPaygIds,
    provider_gateway_auth: resolveProviderGatewayAuthMap(cfg),
    gateway_picker_entries: buildGatewayPickerEntries(cfg),
    stats_only_provider_ids: resolveStatsOnlyProviderIds(cfg),
    // ── 个人源体系重构新增 ──
    source_templates: getSourceTemplates(cfg),
    source_template_overrides: cfg.source_template_overrides || {},
    custom_source_templates: cfg.custom_source_templates || {},
    direct_source_instances: directInstances,
    direct_source_billing: cfg.direct_source_billing || {},
    sync_diff: computeSyncDiff(cfg),
    account_stats: accountStats(cfg, directInstances),
    ...billing,
  };
}

/**
 * 个人源模型名集合（与供给源页「按模型视图」一致的唯一真源）：
 * 用户订阅 + payg + direct(api) 登记的模型名。路由 scope=personal 用它过滤候选。
 * 与 main.js 的 collectPersonalModelsMain 逻辑一致——后者委托本函数，保证单一真源。
 */
function collectPersonalModelNames(lc = {}) {
  const out = new Set();
  const add = (models) => {
    for (const m of (models || [])) {
      const n = typeof m === 'string' ? m : (m && (m.name || m.id));
      if (n) out.add(n);
    }
  };
  for (const s of (lc.user_subscriptions || [])) add(s.models);
  for (const p of (lc.user_payg_providers || [])) add(p.models);
  for (const [, d] of Object.entries(lc.direct_source_billing || {})) {
    if (d && d.mode === 'api') add(d.models);
  }
  return [...out];
}

module.exports = {
  FALLBACK_SUBSCRIPTION_PLANS,
  collectPersonalModelNames,
  getSubscriptionPlans,
  getProviderPricing,
  getBillingSettings,
  getUserAccounts,
  subscriptionAppCatalog,
  apiSubscriptionCatalog,
  paygProviderCatalog,
  paygSourcesCatalog,
  resolveUserPaidProviderIds,
  resolveUserGatewayProviderIds,
  resolveSubscriptionGatewayProviderIds,
  resolveGatewayPaygProviderIds,
  resolveProviderGatewayAuthMap,
  buildGatewayPickerEntries,
  subscriptionGatewayProviderId,
  resolveSubUseApi,
  migrateAgentProviders,
  modelEntryId,
  collectModelsForGatewayProvider,
  enrichProvidersFromAccounts,
  syncGatewayProvidersFromAccounts,
  syncProviderModelsFromAccounts,
  resolveStatsOnlyProviderIds,
  resolvePricingProviderId,
  applyPricingOverrides,
  normPlan,
  normPaygEntry,
  // 个人源体系重构
  getSourceTemplates,
  baseTemplatesByKey,
  directSourceInstances,
  computeSyncDiff,
  accountStats,
  stableHash,
  templateSnapshot,
  serverCatalogKeySets,
  serverTemplatesByKey,
  pruneLocalBillingAgainstServer,
  setLiveCatalogProviders,
  setLiveCatalogPayload,
  liveCatalogPaygEntry,
  catalogModelSetsByProvider,
};
