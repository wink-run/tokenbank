// 与供给源页「按模型视图」一致的可用模型列表（网关应用路由下拉复用）

import {
  CODEX_LISTED_MODELS,
  filterCodexChatModels,
  isCodexChatGptSubscription,
} from '../../shared/codex-subscription-models.mjs';

const OAUTH_SUB_SOURCE_TO_PID = { claude: 'anthropic-paid', codex: 'openai', copilot: 'github-copilot' };
const PRICING_OVERRIDE_META_KEYS = new Set(['_excluded_models']);

function isValidModelName(name) {
  const n = String(name || '').trim();
  return !!n && !PRICING_OVERRIDE_META_KEYS.has(n) && n !== 'excluded_models';
}

function modelEntryName(m) {
  if (typeof m === 'string') return isValidModelName(m) ? m.trim() : '';
  const n = String(m?.name || m?.id || '').trim();
  return isValidModelName(n) ? n : '';
}

function instanceExcludedSet(inst, userPayg, userSubs) {
  if (inst?.kind === 'payg') {
    const p = userPayg.find(x => x.id === inst.id);
    return new Set((p?.excluded_models || []).filter(isValidModelName));
  }
  if (inst?.kind === 'sub') {
    const s = userSubs.find(x => x.id === inst.id);
    return new Set((s?.excluded_models || []).filter(isValidModelName));
  }
  return new Set();
}

function finalizeModelNames(names, excluded = new Set()) {
  return [...names].filter(n => isValidModelName(n) && !excluded.has(n));
}

function paygInstGatewayId(p) {
  return (p && p.gateway_id) || p?.provider_id || null;
}

function subInstGatewayId(s) {
  if (s?.gateway_id) return s.gateway_id;
  if (s.custom) return s.source_id || s.plan_provider_id || null;
  if (s.subscription_kind === 'api') return s.plan_provider_id || s.source_id || null;
  if (!s.subscription_to_api) return null;
  return OAUTH_SUB_SOURCE_TO_PID[s.source_id] || s.plan_provider_id || s.source_id;
}

function configuredModelsFromOverrides(pricingPid, pricingOverrides) {
  const names = [];
  if (!pricingPid || !pricingOverrides) return names;
  for (const k of Object.keys(pricingOverrides[pricingPid] || {})) {
    if (isValidModelName(k)) names.push(k);
  }
  return names;
}

function catalogEntryName(m) {
  if (typeof m === 'string') return isValidModelName(m) ? m.trim() : '';
  const n = String(m?.name || m?.id || m?.model || '').trim();
  return isValidModelName(n) ? n : '';
}

/** 账户卡片刊例价用的目录模型：payg 目录 models/pricing + 服务端刊例价键。 */
function serverCatalogModelNames(catalogId, providerPricing = {}, paygCatalog = []) {
  const names = new Set();
  if (!catalogId) return names;
  const cat = (paygCatalog || []).find(p => (p.provider_id || p.id) === catalogId);
  for (const m of cat?.models || []) {
    const n = catalogEntryName(m);
    if (n) names.add(n);
  }
  for (const k of Object.keys(cat?.pricing || {})) {
    if (isValidModelName(k)) names.add(k);
  }
  for (const k of Object.keys(providerPricing?.[catalogId] || {})) {
    if (isValidModelName(k)) names.add(k);
  }
  return names;
}

/**
 * 模型视图与账户刊例价同一批名字。
 * 账户 models + 手工刊例价，再并上服务端目录。
 * Docker 往往没有本地 yaml，账户 models 是空的，目录只在 paygCatalog 里。
 * catalog 可传 { paygCatalog, providerPricing }。
 */
export function resolveModelsForModelView(
  inst, providers, userPayg, userSubscriptions, pricingOverrides, directByAgent,
  catalog = {},
) {
  const fromArr = (arr) => (arr || []).map(modelEntryName).filter(Boolean);
  const excluded = instanceExcludedSet(inst, userPayg, userSubscriptions);
  const paygCatalog = catalog.paygCatalog || catalog.payg_provider_catalog || [];
  const providerPricing = catalog.providerPricing || catalog.provider_pricing || {};

  // 目录里的名字即使被标过隐藏也保留，和账户刊例价表格一致
  const keepVisible = (names, serverNames) => [...names].filter(n => (
    isValidModelName(n) && (serverNames.has(n) || !excluded.has(n))
  ));

  if (inst.kind === 'payg') {
    const p = userPayg.find(x => x.id === inst.id);
    const pricingPid = p?.provider_id || inst.source_id;
    const serverNames = serverCatalogModelNames(pricingPid, providerPricing, paygCatalog);
    const names = new Set([
      ...serverNames,
      ...fromArr(p?.models),
      ...configuredModelsFromOverrides(pricingPid, pricingOverrides),
    ]);
    return keepVisible(names, serverNames);
  }
  if (inst.kind === 'sub') {
    if (inst.tag === 'app_sub') return [];
    const s = userSubscriptions.find(x => x.id === inst.id);
    // ChatGPT Codex 订阅不展示 OpenAI 按量目录。名单来自账户实时列表，失败时用固定的 8 个对话模型。
    if (isCodexChatGptSubscription(s) || isCodexChatGptSubscription({ source_id: inst.source_id })) {
      const live = catalog.codexSubscriptionModels;
      const names = Array.isArray(live) && live.length
        ? filterCodexChatModels(live)
        : CODEX_LISTED_MODELS;
      return finalizeModelNames(new Set(names), excluded);
    }
    const pricingPid = s?.plan_provider_id
      || OAUTH_SUB_SOURCE_TO_PID[s?.source_id]
      || s?.source_id
      || inst.source_id;
    const serverNames = serverCatalogModelNames(pricingPid, providerPricing, paygCatalog);
    const names = new Set([
      ...serverNames,
      ...fromArr(s?.models),
      ...configuredModelsFromOverrides(pricingPid, pricingOverrides),
    ]);
    return keepVisible(names, serverNames);
  }
  if (inst.kind === 'direct') {
    const d = directByAgent[inst.id];
    if (!d || d.mode !== 'api') return [];
    return finalizeModelNames(new Set(fromArr(d.models)), excluded);
  }
  return [];
}

function subTag(s) {
  if (s.subscription_kind === 'api') return 'api_sub';
  if (s.subscription_to_api) return 'sub_to_api';
  return 'app_sub';
}

function buildAccountInstances(accounts) {
  const userPayg = accounts?.user_payg_providers || [];
  const userSubs = accounts?.user_subscriptions || [];
  const directBilling = accounts?.direct_source_billing || {};
  const instances = [
    ...userSubs.map(s => ({
      kind: 'sub',
      id: s.id,
      source_id: s.source_id,
      gateway_id: subInstGatewayId(s),
      tag: subTag(s),
    })),
    ...userPayg.map(p => ({
      kind: 'payg',
      id: p.id,
      source_id: p.provider_id,
      gateway_id: paygInstGatewayId(p),
    })),
    ...Object.entries(directBilling).map(([agentId, d]) => ({
      kind: 'direct',
      id: agentId,
      source_id: d?.source_id || agentId,
      gateway_id: null,
    })),
  ];
  return { instances, userPayg, userSubs, directBilling };
}

function tierForInstance(inst, providers) {
  const provById = Object.fromEntries((providers || []).map(p => [p.id, p]));
  const gwId = inst.gateway_id;
  if (gwId && provById[gwId]) {
    return provById[gwId].type === 'free' ? 'free' : 'paid';
  }
  return 'paid';
}

/** 账户登记的全部 gateway provider id（含未写 gateway_id 的订阅回退逻辑） */
export function buildGatewayIdsFromAccounts(accounts = {}) {
  const ids = new Set(accounts.gateway_provider_ids || []);
  for (const p of accounts.user_payg_providers || []) {
    const gid = paygInstGatewayId(p);
    if (gid) ids.add(gid);
  }
  for (const s of accounts.user_subscriptions || []) {
    const gid = subInstGatewayId(s);
    if (gid) ids.add(gid);
  }
  return ids;
}

/**
 * 合并 cfg + accounts 为网关路由用的账户快照（刊例价覆盖以 local-config 为准）
 */
export function mergeAccountsForGateway(cfg = {}, accounts = {}) {
  return {
    ...(accounts || {}),
    provider_pricing_overrides: {
      ...(accounts?.provider_pricing_overrides || {}),
      ...(cfg?.provider_pricing_overrides || {}),
    },
  };
}

/** 供给源是否启用（未写字段默认启用） */
export function isProviderEnabled(provider) {
  if (!provider) return false;
  return provider.enabled !== false;
}

/**
 * 收集个人源可用模型（与供给源页 PersonalSourceModelView 同源）
 * @returns {Array<{ id: string, tier: 'free'|'paid' }>}
 */
export function collectPersonalAvailableModels(cfg = {}, accounts = {}) {
  const providers = cfg?.providers || [];
  const provById = Object.fromEntries(providers.map(p => [p.id, p]));
  // 刊例价覆盖存于 local-config（accounts），agent config 可能未同步
  const pricingOverrides = {
    ...(accounts?.provider_pricing_overrides || {}),
    ...(cfg?.provider_pricing_overrides || {}),
  };
  const { instances, userPayg, userSubs, directBilling } = buildAccountInstances(accounts);
  const out = [];
  const seen = new Set();

  for (const inst of instances) {
    // 网关供给源：仅统计已启用的；直连无 gateway_id，始终计入
    const gwId = inst.gateway_id;
    if (gwId) {
      const prov = provById[gwId];
      if (prov && !isProviderEnabled(prov)) continue;
    }
    const models = resolveModelsForModelView(
      inst, providers, userPayg, userSubs, pricingOverrides, directBilling,
      {
        paygCatalog: accounts?.payg_provider_catalog || [],
        providerPricing: accounts?.provider_pricing || {},
        codexSubscriptionModels: accounts?.codex_subscription_models,
      },
    );
    const tier = tierForInstance(inst, providers);
    // owner 是 provider id，下拉写成 providerId:模型名
    const owner = gwId || inst.source_id || '';
    for (const id of models) {
      if (!isValidModelName(id)) continue;
      const k = `${tier}:${owner}:${id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // personal 标识：用户显式注册的个人源模型，用于豁免 Claude 透明名 mask（只 mask 内部校验的透明名）
      out.push({ id, tier, personal: true, ...(owner ? { owner } : {}) });
    }
  }
  return out;
}

/** 合并账户模型到 provider（路由校验）。目录模型一并带上，避免列表里有、请求被拒。 */
export function enrichProvidersForRouting(providers = [], accounts = {}) {
  const userPayg = accounts.user_payg_providers || [];
  const userSubs = accounts.user_subscriptions || [];
  const pricingOverrides = accounts.provider_pricing_overrides || {};
  const paygCatalog = accounts.payg_provider_catalog || [];
  const providerPricing = accounts.provider_pricing || {};

  function extraNames(gatewayId) {
    const names = new Set();
    if (!gatewayId) return names;
    for (const p of userPayg) {
      if (paygInstGatewayId(p) !== gatewayId) continue;
      for (const m of p.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      for (const k of configuredModelsFromOverrides(p.provider_id, pricingOverrides)) names.add(k);
      for (const n of serverCatalogModelNames(p.provider_id, providerPricing, paygCatalog)) names.add(n);
    }
    for (const s of userSubs) {
      if (subInstGatewayId(s) !== gatewayId) continue;
      const isApi = s.subscription_kind === 'api' || s.subscription_to_api;
      if (!isApi) continue;
      if (isCodexChatGptSubscription(s)) {
        const live = accounts.codex_subscription_models;
        const list = Array.isArray(live) && live.length ? filterCodexChatModels(live) : CODEX_LISTED_MODELS;
        for (const n of list) names.add(n);
        continue;
      }
      for (const m of s.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      const pid = s.plan_provider_id || OAUTH_SUB_SOURCE_TO_PID[s.source_id] || s.source_id;
      for (const k of configuredModelsFromOverrides(pid, pricingOverrides)) names.add(k);
      for (const n of serverCatalogModelNames(pid, providerPricing, paygCatalog)) names.add(n);
    }
    return names;
  }

  return providers.map(p => {
    if (p && p.auth_type === 'oauth' && p.oauth_provider === 'codex') {
      const live = accounts.codex_subscription_models;
      const names = Array.isArray(live) && live.length ? filterCodexChatModels(live) : CODEX_LISTED_MODELS;
      return { ...p, models: names.map(name => ({ name, type: 'chat' })) };
    }
    const extra = extraNames(p.id);
    if (!extra.size) return p;
    const names = new Set((p.models || []).map(modelEntryName).filter(Boolean));
    for (const n of extra) names.add(n);
    return {
      ...p,
      models: [...names].sort().map(name => {
        const prev = (p.models || []).find(m => modelEntryName(m) === name);
        return prev && typeof prev === 'object' ? prev : { name, type: 'chat' };
      }),
    };
  });
}

function providerCanServeModel(provider, modelId, gatewayIds) {
  // 显式关闭一律不可用；未写 enabled 时仍可用 gatewayIds / enabled 判定
  if (!provider || provider.enabled === false) return false;
  const active = provider.enabled || (gatewayIds && gatewayIds.has(provider.id));
  if (!active || !provider.base_url || provider.type === 'p2p') return false;
  const list = provider.models || [];
  if (!list.length) return true;
  return list.some(m => modelEntryName(m) === modelId);
}

/** 仅保留已启用供给源可路由的模型（避免下拉可选但请求失败） */
export function filterRoutablePersonalModels(entries, providers = [], gatewayIds = null) {
  const gwSet = gatewayIds instanceof Set ? gatewayIds : null;
  return entries.filter(({ id, tier }) =>
    providers.some(p => {
      if (tier === 'free' && p.type !== 'free') return false;
      if (tier === 'paid' && p.type !== 'free' && p.type !== 'paid') return false;
      return providerCanServeModel(p, id, gwSet);
    }),
  );
}
