import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import ServiceIcon from '../components/ServiceIcon';
import { LIB_LIST_CLS, libRowCls, LibraryRowTitle, LibraryPanel } from '../components/LibraryControls';
import { getNetwork, getProfile, listKeys, createKey, deleteKey, getInventoryStats } from '../api/client';
import { modelStatsForIds, workersForModel, normalizeNetworkPayload } from '../lib/networkModelStats';
import { fetchServerCommunityModels } from '../lib/communityModels';
import { loadUserAccounts, saveUserAccounts, syncProviderCatalog } from '../api/userAccounts';
import { DirectSourceCard, PersonalSourceModelView, PricingTable, CollapsibleBillingPanel, buildInstancePatch, buildDirectSourcePatch, buildDirectSourceRemovePatch, TemplateEditModal, SyncDiffBanner, accountInstanceAddedOrder, inferModalityFromPricing, priceFieldsForModality, healthFromStatus, QualityBadge, fmtCooldownRemain, cooldownMeta } from '../components/PersonalSources';
import { getServerUrl, normalizeServerBase, syncCloudConfigUrl } from '../config';
import { getGateway, getLocalConfig, getConfig, getOauth, isElectron } from '../api/adapter';
import { speedDotClass, speedTitle, useSpeedMap, speedFor, bucketFromMs, statusDotBucket } from '../lib/speed';
import { useLang } from '../store/lang';
import { useAuth } from '../store/index';
import { resolveModelsForModelView } from '../lib/personalAvailableModels';
import { buildPersonalModelTypeMap, inferModelTypeFromName } from '../api/gatewayModels';
import { encodeRoute } from '../lib/route-binding';
import { avatarColor } from '../components/UserAvatar';
import { mergeRemoteAccountConfigs, mergeGatewayProviders } from '../lib/account-config-sync';
import { isOllamaProvider } from '../../shared/provider-test.js';
import UsageMeter, { UsageInline, usageProviderForDirect } from '../components/UsageMeter';

/** 按当前语言覆盖 meta 中的 label / hint / getKey / oauth.label */
function localizeProviderMeta(metaMap, t) {
  const out = { ...metaMap };
  for (const [id, m] of Object.entries(out)) {
    const next = { ...m };
    const labelKey = `providers.meta.${id}.label`;
    const hintKey = `providers.meta.${id}.hint`;
    const getKeyKey = `providers.meta.${id}.getKey`;
    if (t(labelKey) !== labelKey) next.label = t(labelKey);
    if (t(hintKey) !== hintKey) next.hint = t(hintKey);
    // 覆盖「去领 key」链接文案（如 jimeng-api 指向说明文档）
    if (t(getKeyKey) !== getKeyKey) next.getKeyLabel = t(getKeyKey);
    if (m.oauth?.provider) {
      const oauthKey = `providers.oauth.${m.oauth.provider}`;
      if (t(oauthKey) !== oauthKey) next.oauth = { ...m.oauth, label: t(oauthKey) };
    }
    out[id] = next;
  }
  return out;
}

function getTierConfig(t) {
  return {
    local: { dot: 'bg-emerald-500', label: t('providers.group.local'), hint: t('providers.group.localHint') },
    free: { dot: 'bg-green-500', label: t('providers.tier.free.label'), hint: t('providers.tier.free.hint'), cols: 'grid-cols-2' },
    p2p:  { dot: 'bg-blue-500',  label: t('providers.tier.p2p.label'),  hint: t('providers.tier.p2p.hint'),  cols: 'grid-cols-1' },
    paid: { dot: 'bg-amber-400', label: t('providers.tier.paid.label'), hint: t('providers.tier.paid.hint'), cols: 'grid-cols-2' },
  };
}

/** 供给源分区标题：圆点 + 名称 + 说明，独立于下方 panel */
function SourceSectionHeader({ dot, title, hint, trailing, className = '' }) {
  return (
    <div className={`relative flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 ${className}`}>
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />
      <h2 className="text-sm font-bold text-zinc-800 dark:text-zinc-200">{title}</h2>
      {hint && <span className="text-xs text-zinc-400 dark:text-zinc-500">{hint}</span>}
      {trailing}
    </div>
  );
}

function getOAuthById(t) {
  return {
    'anthropic-paid': { provider: 'claude',  label: t('providers.oauth.claude') },
    openai:           { provider: 'codex',   label: t('providers.oauth.codex') },
    'github-copilot': { provider: 'copilot', label: t('providers.oauth.copilot') },
  };
}

// 目录由后端 /api/catalog 下发（server/catalog.py），此处不再写死列表。
// OAuth 能力仍由客户端声明（服务端不知道哪些 OAuth 模块已安装）。
const FALLBACK_PROVIDER_META = {};
const FALLBACK_PROVIDERS = [];

/** 社区 P2P（tokenbank-p2p）：不属于个人源 catalog，仅从 agent 网关配置合并 */
const BUILTIN_P2P_PROVIDER = {
  id: 'tokenbank-p2p',
  type: 'p2p',
  enabled: true,
  token: '',
  base_url: '',
  models: [],
};

function mergeCommunityP2PProvider(providerList, agentCfg) {
  const list = [...providerList];
  if (list.some(p => p.type === 'p2p' || p.id === 'tokenbank-p2p')) return list;
  const saved = agentCfg?.providers?.find(p => p.id === 'tokenbank-p2p');
  list.push(saved ? { ...BUILTIN_P2P_PROVIDER, ...saved } : { ...BUILTIN_P2P_PROVIDER });
  return list;
}

// 把后端下发的 catalog 拆成展示 meta 映射 + 默认 provider 列表（与本地配置合并的种子）
/** catalog models 归一化为 { name, type }[]；无 models 时从 pricing 键推导 */
function parseCatalogModels(entry) {
  const models = [];
  const seen = new Set();
  const push = (name, type = 'chat') => {
    const n = String(name || '').trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    models.push({ name: n, type: type || 'chat' });
  };
  for (const m of entry?.models || []) {
    if (typeof m === 'string') push(m);
    else if (m && typeof m === 'object') push(m.name || m.id || m.model, m.type);
  }
  // models 与 pricing 取并集，与服务端 sync_catalog_models_pricing 一致
  if (entry?.pricing && typeof entry.pricing === 'object') {
    for (const k of Object.keys(entry.pricing)) {
      if (k && k !== '_excluded_models' && k !== 'excluded_models') push(k);
    }
  }
  return models;
}

/** 从 catalog 提取 provider_id → pricing 映射（models 与 pricing 键严格对齐） */
function catalogPricingFromProviders(providers) {
  const out = {};
  for (const p of providers || []) {
    if (!p?.id) continue;
    const pricing = { ...(p.pricing && typeof p.pricing === 'object' ? p.pricing : {}) };
    for (const m of parseCatalogModels(p)) {
      const n = typeof m === 'string' ? m : m?.name;
      if (!n || n === '_excluded_models' || n === 'excluded_models') continue;
      if (!(n in pricing)) pricing[n] = {};
    }
    for (const k of Object.keys(pricing)) {
      if (k === '_excluded_models' || k === 'excluded_models') delete pricing[k];
    }
    if (Object.keys(pricing).length) out[p.id] = pricing;
  }
  return out;
}

function catalogToState(catalog, oauthById) {
  const meta = {};
  const defaults = [];
  for (const p of catalog?.providers || []) {
    if (!p?.id) continue;
    meta[p.id] = {
      icon: p.icon, label: p.label, hint: p.hint, keyless: !!p.keyless,
      key_prefix: Array.isArray(p.key_prefix) ? p.key_prefix : [],
      signup_url: p.signup_url || '',
      api_format: p.api_format || 'openai',
      base_url: p.base_url || '',
      // OAuth 能力以客户端为准（仅客户端有对应 oauth 模块）；不信任远端 catalog 的 oauth 字段，
      // 否则远端未重新部署时会下发已废弃的能力（如 gemini 的 google 登录）。
      oauth: oauthById[p.id] || null,
    };
    defaults.push({
      id: p.id,
      type: p.type,
      enabled: !!p.enabled_default || !!p.keyless, // 免 key 供给源默认启用（已存本地配置在合并时优先，不覆盖用户手动禁用）
      token: '',
      base_url: p.base_url || '',
      api_format: p.api_format || 'openai',
      models: parseCatalogModels(p),
    });
  }
  // 后端目录里缺失的 OAuth 预设（如 gemini / github-copilot）从内置兜底补出来
  for (const id of Object.keys(oauthById)) {
    if (!meta[id]) {
      if (FALLBACK_PROVIDER_META[id]) meta[id] = { ...FALLBACK_PROVIDER_META[id] };
      const fb = FALLBACK_PROVIDERS.find(p => p.id === id);
      if (fb) defaults.push({ ...fb });
    } else if (!meta[id].oauth) {
      meta[id].oauth = oauthById[id];
    }
  }
  return { meta, defaults };
}

/** 从本机 yaml / admin-api 读取供给源 catalog（Docker CLI Web UI 走 /api/provider-catalog） */
async function readProviderCatalogFromYaml() {
  const api = window.electronAPI?.localConfig;
  if (api?.getProviderCatalog) return api.getProviderCatalog();
  if (api?.getBuiltinCatalog) return api.getBuiltinCatalog();
  if (!isElectron()) {
    try {
      const base = import.meta.env?.VITE_ADMIN_BASE ?? '';
      const res = await fetch(`${base}/api/provider-catalog`);
      if (res.ok) return await res.json();
    } catch {}
  }
  return { providers: [] };
}

function buildCatalogSeed(data, oauthById, t, fromNetwork) {
  if (!data?.providers?.length) return null;
  const s = catalogToState(data, oauthById);
  return {
    defaults: s.defaults,
    meta: localizeProviderMeta(s.meta, t),
    fromNetwork,
    pricing: catalogPricingFromProviders(data.providers),
  };
}

/** 从个人页登记 / meta 解析供给源展示名（优先于 URL hostname） */
function resolveProviderDisplayName(id, provider, userPayg = [], userSubs = [], metaMap = {}) {
  const payg = userPayg.find(u => u.provider_id === id);
  if (payg?.label) return payg.label;
  const sub = userSubs.find(s => s.custom && s.source_id === id);
  if (sub?.app_name) return sub.app_name;
  if (metaMap[id]?.label) return metaMap[id].label;
  return provider?.displayName || provider?.label || '';
}

function withProviderDisplayName(provider, userPayg, userSubs, metaMap) {
  const name = resolveProviderDisplayName(provider.id, provider, userPayg, userSubs, metaMap);
  return name ? { ...provider, displayName: name } : provider;
}

/** 合并个人页按量账户中的自定义供给源到本地 providers 列表 */
function mergeUserPaygIntoProviders(resolved, metaMap, userPayg = [], t) {
  const providers = [...resolved];
  const meta = { ...metaMap };
  for (const p of userPayg) {
    const id = p.provider_id;
    if (!id) continue;
    const existing = providers.find(x => x.id === id);
    if (existing) {
      if (p.label) existing.displayName = p.label;
      // 个人页模型仅作初始参考；本地已有配置则保留（供给源页可独立增删）
      if (!(existing.models && existing.models.length) && (p.models || []).length) {
        existing.models = [...p.models];
      }
      if (!meta[id]) {
        meta[id] = {
          icon: p.icon || '🔧',
          label: p.label || id,
          hint: t('providers.hint.userPayg'),
          keyless: false,
          key_prefix: [],
          signup_url: '',
        };
      } else if (p.label) {
        meta[id] = { ...meta[id], label: p.label };
      }
      continue;
    }
    providers.push({
      id,
      type: 'paid',
      enabled: true,
      token: '',
      base_url: '',
      models: [...(p.models || [])],
      displayName: p.label || id,
    });
    if (!meta[id]) {
      meta[id] = {
        icon: p.icon || '🔧',
        label: p.label || id,
        hint: t('providers.hint.userPayg'),
        keyless: false,
        key_prefix: [],
        signup_url: '',
      };
    }
  }
  return { providers, meta };
}

// OAuth 订阅 source_id(=oauth provider) → catalog provider id
const OAUTH_SUB_SOURCE_TO_PID = { claude: 'anthropic-paid', codex: 'openai', copilot: 'github-copilot' };

/** 按量账户实例的网关 provider id（多实例时各用独立 gateway_id） */
function paygInstGatewayId(p) {
  return (p && p.gateway_id) || p?.provider_id || null;
}

/** 订阅账户实例的网关 provider id（未写 gateway_id 时走旧逻辑） */
function subInstGatewayId(s) {
  if (s?.gateway_id) return s.gateway_id;
  if (s.custom) return s.source_id || s.plan_provider_id || null;
  if (s.subscription_kind === 'api') return s.plan_provider_id || s.source_id || null;
  if (!s.subscription_to_api) return null;
  return OAUTH_SUB_SOURCE_TO_PID[s.source_id] || s.plan_provider_id || s.source_id;
}

/** 个人页按量账户（用于识别按量供给源，按 gateway_id 匹配） */
function resolvePaygAccount(providerId, userPayg = []) {
  return (userPayg || []).find(p => paygInstGatewayId(p) === providerId) || null;
}

function isPaygManagedProvider(providerId, userPayg = []) {
  return !!resolvePaygAccount(providerId, userPayg);
}

/** 个人页按量账户已配置的模型；无登记时回退服务端刊例价目录 */
function buildPaygProfileModels(providerId, userPayg = [], providerPricing = {}, paygCatalog = []) {
  const payg = resolvePaygAccount(providerId, userPayg);
  const catalogId = payg?.provider_id || providerId;
  const names = new Set();
  const add = (m) => {
    const n = typeof m === 'string' ? m.trim() : String(m?.name || m?.id || '').trim();
    if (n) names.add(n);
  };
  for (const m of payg?.models || []) add(m);
  if (!payg?.models?.length) {
    const cat = (paygCatalog || []).find(p => (p.provider_id || p.id) === catalogId);
    for (const m of cat?.models || []) add(m);
    for (const k of Object.keys(providerPricing?.[catalogId] || {})) {
      if (k && !PRICING_OVERRIDE_META_KEYS.has(k)) names.add(k);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** 模型输入候选：非按量供给源可用刊例价目录；按量仅用 buildPaygProfileModels */
function buildModelSuggestions(providerId, userPayg = [], providerPricing = {}, paygCatalog = []) {
  const names = new Set();
  const add = (m) => {
    const n = typeof m === 'string' ? m.trim() : String(m?.name || '').trim();
    if (n) names.add(n);
  };

  const payg = resolvePaygAccount(providerId, userPayg);
  const catalogId = payg?.provider_id || providerId;
  for (const m of payg?.models || []) add(m);

  const cat = (paygCatalog || []).find(p => (p.provider_id || p.id) === catalogId);
  for (const m of cat?.models || []) add(m);
  for (const m of Object.keys(cat?.pricing || {})) add(m);

  for (const m of Object.keys(providerPricing[catalogId] || {})) add(m);

  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * 个人页登记的供给源 → 付费层可选列表。
 * 跨 free/paid 层匹配（个人页按量登记的源优先在付费层接入）。
 */
function buildPersonalPaidPool(allProviders, paidIds, userPayg = [], userSubs = []) {
  const pool = [];
  const seen = new Set();

  for (const id of paidIds || []) {
    if (!id || seen.has(id)) continue;
    const live = allProviders.find(p => p.id === id);
    const payg = userPayg.find(u => paygInstGatewayId(u) === id);
    const sub = (userSubs || []).find(s => s.custom && subInstGatewayId(s) === id);
    const displayName = sub?.app_name || payg?.label;
    if (live) {
      // 保留用户配置的 type/tier，不再强制 paid
      const enriched = displayName ? { ...live, displayName } : live;
      pool.push(enriched);
      seen.add(id);
      continue;
    }
    const fb = FALLBACK_PROVIDERS.find(p => p.id === id);
    if (payg || sub || id.startsWith('custom-') || fb) {
      pool.push({
        ...(fb || { id, type: 'paid', enabled: true, token: '', base_url: '', models: [] }),
        id,
        type: 'paid',
        enabled: true,
        models: [...(payg?.models || fb?.models || [])],
        displayName,
      });
      seen.add(id);
    }
  }
  return pool;
}

/** 个人页登记项 → 供给源选择器条目（渲染端回退；Electron 优先用 billing-config 下发） */
function buildGatewayPickerEntries(userSubs, userPayg, subscriptionCatalog) {
  const catalogBySource = Object.fromEntries(
    (subscriptionCatalog || []).map(c => [c.source_id, c]),
  );
  const entries = [];

  for (const sub of userSubs || []) {
    if (sub.custom) {
      const useApi = sub.subscription_kind === 'api'
        || sub.subscription_to_api === true
        || catalogBySource[sub.source_id]?.subscription_to_api === true;
      if (!useApi) continue;
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

    const useApi = sub.subscription_to_api != null
      ? sub.subscription_to_api === true
      : catalogBySource[sub.source_id]?.subscription_to_api === true;
    if (!useApi) continue;

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

  for (const payg of userPayg || []) {
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

/** 是否为个人页登记的 API 订阅 / 自定义订阅供给源（走 API Key 卡片） */
function isCustomSubscriptionGatewayId(id, userSubs = []) {
  return (userSubs || []).some(s => {
    if (s.custom && (s.source_id === id || s.gateway_id === id)) return true;
    if (s.subscription_kind === 'api' && (s.plan_provider_id === id || s.source_id === id || s.gateway_id === id)) return true;
    return false;
  });
}

/** Claude/Codex/Copilot 等 OAuth 订阅转 API 实例 */
function isOAuthSubToApiInstance(inst) {
  return inst?.tag === 'sub_to_api' && !!OAUTH_SUB_SOURCE_TO_PID[inst?.source_id];
}

/** CustomProviderCard 仅用于自定义 URL+API Key；OAuth 订阅转 API 必须走 ProviderCard */
function shouldUseCustomProviderCard(gwId, userSubs, inst, cardMeta) {
  if (isOAuthSubToApiInstance(inst)) return false;
  return isCustomSubscriptionGatewayId(gwId, userSubs) || !cardMeta?.label;
}

/** 已启用卡片：按账户类型 / 网关登记解析验证方式 */
function resolveCardAuthMode(provider, gatewayAuth, accountInst) {
  // 账户实例类型优先：订阅转 API 固定 OAuth，API 订阅/按量固定 API Key
  if (accountInst?.tag === 'sub_to_api') return 'oauth';
  if (accountInst?.tag === 'api_sub' || accountInst?.tag === 'payg') return 'api_key';
  if (gatewayAuth === 'oauth' || gatewayAuth === 'api_key') return gatewayAuth;
  if (gatewayAuth === 'both') {
    if (provider.auth_type === 'oauth' || provider.credentials?.refresh_token) return 'oauth';
    if (provider.token) return 'api_key';
    return 'oauth';
  }
  if (provider.auth_type === 'oauth' || provider.credentials?.refresh_token) return 'oauth';
  return null;
}

/** 个人源 API/订阅 分类：OAuth 接入 / 订阅计费 → 订阅；其余 api-key 接入（免费 + 按量付费）→ API。
 *  说明：oauth-capable 源若已以 api-key 方式配置（按量付费），归 API 而非订阅。 */
function isSubscriptionProvider(provider, metaMap = {}) {
  if (!provider) return false;
  if (provider.billing_type === 'subscription') return true;
  if (provider.auth_type === 'oauth') return true;
  if (provider.credentials?.refresh_token) return true;
  if (metaMap[provider.id]?.oauth && provider.auth_type !== 'api_key' && !provider.token) return true;
  return false;
}

/** 合并个人页 API 订阅 / 自定义订阅到 providers 列表 */
function mergeCustomSubscriptionProviders(resolved, metaMap, userSubs, paidIds = [], t) {
  const providers = [...resolved];
  const meta = { ...metaMap };
  const allow = new Set(paidIds || []);

  for (const sub of userSubs || []) {
    const isApiSub = sub.subscription_kind === 'api';
    if (!sub.custom && !isApiSub) continue;
    const id = isApiSub ? (sub.plan_provider_id || sub.source_id) : sub.source_id;
    if (!id) continue;
    const useApi = isApiSub || sub.subscription_to_api === true;
    if (!useApi || !allow.has(id)) continue;

    if (!providers.find(p => p.id === id)) {
      providers.push({
        id,
        type: 'paid',
        enabled: true,
        token: '',
        base_url: '',
        models: [],
        displayName: sub.app_name || id,
      });
    } else {
      const existing = providers.find(p => p.id === id);
      if (sub.app_name) existing.displayName = sub.app_name;
    }
    if (!meta[id]) {
      meta[id] = {
        icon: sub.app_icon || '🔧',
        label: sub.app_name || id,
        hint: t(isApiSub ? 'providers.hint.apiSub' : 'providers.hint.customSub'),
        keyless: false,
        key_prefix: [],
        signup_url: '',
      };
    }
  }
  return { providers, meta };
}

/** 是否为 API 类订阅供给源 */
function isApiSubscriptionProviderId(id, userSubs = []) {
  return (userSubs || []).some(s =>
    s.subscription_kind === 'api'
    && (s.plan_provider_id === id || s.source_id === id),
  );
}

/** 已启用供给源的分类（路由 Tier 以 provider.type 为准） */
function getPersonalSourceTag(provider, metaMap, userPayg, userSubs) {
  const id = provider?.id;
  if (!id) return 'free';
  // 用户显式 free 层：图标与路由一致，不受按量登记推断覆盖
  if (provider.type === 'free') return 'free';
  if (isPaygManagedProvider(id, userPayg)) return 'payg';
  if (isApiSubscriptionProviderId(id, userSubs)) return 'api_sub';
  if (isCustomSubscriptionGatewayId(id, userSubs)) return 'sub_to_api';
  if (isSubscriptionProvider(provider, metaMap)) return 'sub_to_api';
  if (metaMap[id]?.keyless) return 'free';
  return 'payg';
}

/** 目录声明的免费层（tier=free），用于选择器「免费」标识与筛选 */
function isFreeTierTemplate(tpl) {
  return tpl?.tier === 'free';
}

function getPickerEntryTag(entry) {
  // 免费账户优先归入 free，便于筛选与发现（即使 kind=payg）
  if (isFreeTierTemplate(entry.template) || entry.personalTag === 'free') return 'free';
  if (entry.personalTag) return entry.personalTag;
  if (entry.source === 'payg') return 'payg';
  if (entry.source === 'subscription') return 'sub_to_api';
  return 'free';
}

/** 添加供给源选择器：与列表区筛选标签对齐 */
function pickerItemMatchesFilter(tag, filter) {
  if (filter === 'all') return true;
  if (filter === 'subscription') return ['app_sub', 'api_sub', 'sub_to_api'].includes(tag);
  if (filter === 'api') return tag === 'payg';
  return tag === filter;
}

/** 由源模板库条目生成供给源选择器项（展示全部账户类型） */
function buildPickerEntryFromTemplate(tpl, subscriptionCatalog = []) {
  const catalogBySource = Object.fromEntries(
    (subscriptionCatalog || []).map(c => [c.source_id, c]),
  );

  if (tpl.kind === 'payg') {
    const free = isFreeTierTemplate(tpl);
    return {
      providerId: tpl.key,
      pickerKey: `payg:${tpl.key}`,
      label: tpl.label || tpl.key,
      icon: tpl.icon || '🔧',
      authMode: 'api_key',
      source: 'payg',
      // 免费账户单独打标，选择器显示「免费」并参与免费筛选
      personalTag: free ? 'free' : 'payg',
      templateKey: tpl.key,
      template: tpl,
      gatewayAddable: true,
    };
  }

  if (tpl.kind === 'api_sub') {
    const pid = tpl.plan_provider_id || tpl.key;
    return {
      providerId: pid,
      pickerKey: `sub:${tpl.key}`,
      label: tpl.label || tpl.key,
      icon: tpl.icon || '🔑',
      authMode: 'api_key',
      source: 'subscription',
      personalTag: 'api_sub',
      templateKey: tpl.key,
      template: tpl,
      custom: tpl.custom === true,
      gatewayAddable: true,
    };
  }

  // app_sub：一律先登记直连源；目录开启「可转 API」时在卡片内转换到供给源区
  const cat = catalogBySource[tpl.key];
  const canConvertToApi = tpl.subscription_to_api === true || cat?.subscription_to_api === true;
  return {
    providerId: cat?.plan_provider_id || OAUTH_SUB_SOURCE_TO_PID[tpl.key] || tpl.key,
    pickerKey: `tpl:${tpl.key}`,
    label: tpl.label || tpl.key,
    icon: tpl.icon || '🔷',
    authMode: canConvertToApi ? 'sub' : 'stats',
    source: 'subscription',
    personalTag: 'app_sub',
    templateKey: tpl.key,
    template: tpl,
    directAgentId: tpl.agent_id || tpl.key,
    canConvertToApi,
    statsOnly: !canConvertToApi,
    gatewayAddable: false,
    custom: tpl.custom === true,
  };
}

function buildTemplatePickerEntries(templates, subscriptionCatalog) {
  const entries = [];
  const seen = new Set();
  for (const tpl of templates || []) {
    const entry = buildPickerEntryFromTemplate(tpl, subscriptionCatalog);
    if (!entry || seen.has(entry.pickerKey)) continue;
    seen.add(entry.pickerKey);
    entries.push(entry);
  }
  return entries;
}

/** legacy：尚未写入 direct_source_billing 的纯 APP 订阅，合成直连源卡片数据 */
function legacyAppSubAsDirect(subs, directInstances) {
  const seen = new Set((directInstances || []).map(d => d.agent_id));
  return (subs || [])
    .filter(s => s.subscription_kind !== 'api' && !s.subscription_to_api)
    .filter(s => {
      const aid = s.agent_id || s.source_id;
      return aid && !seen.has(aid);
    })
    .map(s => {
      const agentId = s.agent_id || s.source_id;
      return {
        kind: 'direct',
        agent_id: agentId,
        source_id: s.source_id,
        name: s.name || s.app_name || agentId,
        label: s.app_name || agentId,
        icon: s.app_icon || '🖱',
        mode: 'subscription',
        monthly_usd: s.monthly_usd ?? null,
        models: [],
        pricing: {},
        has_pricing: s.monthly_usd != null,
      };
    });
}

/** 已登记 direct_source_billing、但尚未被 directInstances 扫到的条目（如未安装） */
function billingOnlyDirect(billing, directInstances, templates) {
  const seen = new Set((directInstances || []).map(d => d.agent_id));
  const tplByAgent = Object.fromEntries(
    (templates || []).filter(t => t.agent_id || t.key).map(t => [t.agent_id || t.key, t]),
  );
  const out = [];
  for (const [agentId, b] of Object.entries(billing || {})) {
    if (!b || typeof b !== 'object' || seen.has(agentId)) continue;
    const tpl = tplByAgent[agentId] || tplByAgent[b.source_id];
    const mode = b.mode === 'api' ? 'api' : 'subscription';
    const pricing = (b.pricing && typeof b.pricing === 'object') ? b.pricing : {};
    const hasPricing = mode === 'api'
      ? Object.keys(pricing).length > 0
      : (b.monthly_usd != null);
    out.push({
      kind: 'direct',
      agent_id: agentId,
      source_id: b.source_id || tpl?.key || agentId,
      name: b.name || tpl?.label || agentId,
      label: tpl?.label || b.name || agentId,
      icon: tpl?.icon || '🖱',
      mode,
      monthly_usd: b.monthly_usd ?? null,
      models: Object.keys(pricing).length ? Object.keys(pricing) : (tpl?.models || []),
      pricing,
      has_pricing: hasPricing,
    });
  }
  return out;
}

/** 该直连源是否已「转 API」并在供给源区登记 */
function isDirectConvertedToGateway(subs, inst) {
  return (subs || []).some(s => {
    if (s.subscription_kind === 'api') return false;
    if (!s.subscription_to_api) return false;
    const aid = s.agent_id || s.source_id;
    return aid === inst.agent_id || s.source_id === inst.source_id;
  });
}

/** 合并：已安装直连 + 仅计费登记 + legacy 订阅（已转 API 的不再展示于直连区） */
function mergeDirectInstances(directInstances, billing, subs, templates, subscriptionCatalog = []) {
  const bill = billing || {};
  const merged = (directInstances || []).filter(d => bill[d.agent_id] != null);
  const seen = new Set(merged.map(d => d.agent_id));
  for (const d of billingOnlyDirect(bill, merged, templates)) {
    if (!seen.has(d.agent_id)) { merged.push(d); seen.add(d.agent_id); }
  }
  for (const d of legacyAppSubAsDirect(subs, merged)) {
    if (!seen.has(d.agent_id)) { merged.push(d); seen.add(d.agent_id); }
  }
  return enrichDirectWithCatalog(merged, templates, subscriptionCatalog)
    .filter(d => !isDirectConvertedToGateway(subs, d));
}

/** 注入目录能力：可转 API / 是否允许直连区内切换 API 计费估算 */
function enrichDirectWithCatalog(instances, templates, subscriptionCatalog) {
  const tplByKey = Object.fromEntries((templates || []).map(t => [t.key, t]));
  const tplByAgent = Object.fromEntries(
    (templates || []).filter(t => t.agent_id || t.key).map(t => [t.agent_id || t.key, t]),
  );
  const catBySource = Object.fromEntries((subscriptionCatalog || []).map(c => [c.source_id, c]));
  return (instances || []).map(d => {
    const tpl = tplByAgent[d.agent_id] || tplByKey[d.source_id];
    const cat = catBySource[d.source_id] || catBySource[tpl?.key];
    const canConvertToApi = tpl?.kind === 'app_sub'
      && (tpl?.subscription_to_api === true || cat?.subscription_to_api === true);
    // 非 APP 订阅模板的纯会话直连（无目录条目）才允许切换按模型计费估算
    const allowApiBilling = !canConvertToApi && !tpl?.kind;
    const mode = allowApiBilling && d.mode === 'api' ? 'api' : 'subscription';
    const apiFormat = tpl?.api_format || cat?.api_format
      || (tpl?.plan_provider_id && tplByKey[tpl.plan_provider_id]?.api_format)
      || 'openai';
    return {
      ...d,
      can_convert_to_api: canConvertToApi,
      allow_api_billing: allowApiBilling,
      mode,
      api_format: apiFormat,
      ...(mode === 'subscription' ? { pricing: {} } : {}),
    };
  });
}

/** 是否应在个人源页展示网关配置卡片（Base URL / API Key） */
function isGatewayAccountInstance(inst) {
  if (!inst || inst.kind === 'direct') return false;
  if (inst.kind === 'payg') return true;
  if (inst.kind === 'sub') return inst.tag !== 'app_sub';
  return false;
}

function tagMatchesFilter(tag, filter) {
  return filter === 'all' || tag === filter;
}

/** 供给源类型图标与配色（卡片 icon / 筛选按钮共用） */
const PERSONAL_TYPE_BADGE = {
  free: {
    filterKey: 'free',
    className: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800/50',
  },
  app_sub: {
    filterKey: 'appSub',
    className: 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/50',
  },
  api_sub: {
    filterKey: 'apiSub',
    className: 'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 border-violet-200 dark:border-violet-800/50',
  },
  sub_to_api: {
    filterKey: 'subToApi',
    className: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800/50',
  },
  payg: {
    filterKey: 'payg',
    className: 'bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400 border-sky-200 dark:border-sky-800/50',
  },
};

function PersonalTypeIcon({ tag, className = 'w-3 h-3 shrink-0' }) {
  const props = { className, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true };
  switch (tag) {
    case 'free':
      return (
        <svg {...props}>
          <path d="M8 2v12M4.5 5.5h7M4.5 5.5a2 2 0 0 1-2-2c0-1.1.9-2 2-2 .7 0 1.3.4 1.7 1M11.5 5.5a2 2 0 0 0 2-2c0-1.1-.9-2-2-2-.7 0-1.3.4-1.7 1" strokeLinecap="round" />
        </svg>
      );
    case 'app_sub':
      return (
        <svg {...props}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
          <circle cx="8" cy="8" r="2" />
        </svg>
      );
    case 'api_sub':
      return (
        <svg {...props}>
          <circle cx="5.5" cy="10.5" r="2.5" />
          <path d="M7.5 8.5L11 5M11 5h-2.5M11 5v2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'sub_to_api':
      return (
        <svg {...props}>
          <path d="M2 5h8M8 5l-2-2M8 5l-2 2M14 11H6M6 11l2-2M6 11l2 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <rect x="2" y="4" width="12" height="8" rx="1.5" />
          <path d="M2 7h12" strokeLinecap="round" />
        </svg>
      );
  }
}

/** 卡片上展示类型 icon；免费/按量源可点击切换路由 Tier（free/paid） */
function PersonalSourceTypeBadge({ tag, t, provider, tierEditable, onTierChange }) {
  const cfg = PERSONAL_TYPE_BADGE[tag] || PERSONAL_TYPE_BADGE.payg;
  const label = t(`providers.filter.${cfg.filterKey}`);
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const currentTier = provider?.tier === 'paid' || provider?.type === 'paid' ? 'paid' : 'free';
  const canEdit = tierEditable && provider && typeof onTierChange === 'function';

  const closeMenu = useCallback(() => {
    setOpen(false);
    setMenuPos(null);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      const t = e.target;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      closeMenu();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, closeMenu]);

  const shellClass = `inline-flex items-center justify-center w-5 h-5 rounded-md border shrink-0 ${cfg.className}`;

  if (!canEdit) {
    return (
      <span className={shellClass} title={label} aria-label={label}>
        <PersonalTypeIcon tag={tag} />
      </span>
    );
  }

  const openMenu = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setMenuPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
  };

  const pickTier = (tier) => {
    closeMenu();
    if (tier !== currentTier) onTierChange(tier);
  };

  const menu = open && menuPos && createPortal(
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[7.5rem] py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg"
      style={{ top: menuPos.top, left: menuPos.left }}
      role="menu"
    >
      {(['free', 'paid']).map(tier => {
        const tierTag = tier === 'free' ? 'free' : 'payg';
        const tierCfg = PERSONAL_TYPE_BADGE[tierTag];
        const active = tier === currentTier;
        return (
          <button
            key={tier}
            type="button"
            role="menuitem"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pickTier(tier)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors ${
              active
                ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50'
            }`}
          >
            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-md border shrink-0 ${tierCfg.className}`}>
              <PersonalTypeIcon tag={tierTag} />
            </span>
            <span>{t(tier === 'free' ? 'providers.tierChange.free' : 'providers.tierChange.paid')}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? closeMenu() : openMenu())}
        className={`${shellClass} cursor-pointer hover:brightness-95 dark:hover:brightness-110 transition-[filter,box-shadow] ${open ? 'ring-2 ring-blue-400/60' : ''}`}
        title={t('providers.tierChange.clickHint')}
        aria-label={t('providers.tierChange.clickHint')}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <PersonalTypeIcon tag={tag} />
      </button>
      {menu}
    </>
  );
}

/** 顶部筛选标签栏（类型项：icon + 文案） */
function PersonalFilterBar({ value, onChange, t }) {
  const items = [
    { id: 'all', label: t('providers.filter.all') },
    { id: 'app_sub', label: t('providers.filter.appSub') },
    { id: 'api_sub', label: t('providers.filter.apiSub') },
    { id: 'sub_to_api', label: t('providers.filter.subToApi') },
    { id: 'payg', label: t('providers.filter.payg') },
  ];
  return (
    <div className="tb-glass-chip inline-flex flex-wrap rounded-lg p-0.5 gap-0.5">
      {items.map(item => (
        <button
          key={item.id}
          type="button"
          onClick={() => onChange(item.id)}
          className={`tb-press inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-colors ${
            value === item.id
              ? 'bg-white/90 dark:bg-white/10 text-zinc-900 dark:text-zinc-100 shadow-sm font-medium'
              : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
          }`}
        >
          {item.id !== 'all' && <PersonalTypeIcon tag={item.id} />}
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 由网关 provider id 反查对应账户类型模板 */
function resolveTemplateForProvider(providerId, templates = [], userSubs = [], userPayg = []) {
  const direct = templates.find(t => t.key === providerId);
  if (direct) return direct;
  // 多实例 acct-* 网关 id → 反查 source_id / provider_id
  if (String(providerId || '').startsWith('acct-')) {
    const payg = userPayg.find(p => paygInstGatewayId(p) === providerId);
    if (payg) return templates.find(t => t.key === payg.provider_id);
    const sub = userSubs.find(s => subInstGatewayId(s) === providerId);
    if (sub) return templates.find(t => t.key === sub.source_id);
  }
  for (const [srcId, pid] of Object.entries(OAUTH_SUB_SOURCE_TO_PID)) {
    if (pid === providerId) return templates.find(t => t.key === srcId);
  }
  const sub = userSubs.find(s => subInstGatewayId(s) === providerId
    || s.plan_provider_id === providerId || s.source_id === providerId);
  if (sub) return templates.find(t => t.key === sub.source_id);
  const payg = userPayg.find(p => paygInstGatewayId(p) === providerId || p.provider_id === providerId);
  if (payg) return templates.find(t => t.key === payg.provider_id);
  return templates.find(t => t.plan_provider_id === providerId) || null;
}

/** 多实例 gateway（acct-* 或与模板 catalog id 不同）= 独立供给源，不继承同类型凭证 */
function isIndependentGatewayInstance(gatewayId, catalogId) {
  if (!gatewayId) return false;
  if (String(gatewayId).startsWith('acct-')) return true;
  return !!catalogId && gatewayId !== catalogId;
}

/** 新实例默认凭证（空） */
const FRESH_PROVIDER_CREDENTIALS = {
  token: '',
  credentials: null,
  oauth_provider: '',
  auth_type: 'api_key',
  test_verified: false,
};

/** 目录默认为空 Base URL 的自定义兼容源：新增不得继承历史/同类型地址 */
function isBlankCompatibleSourceId(id) {
  return id === 'openai-compatible' || id === 'anthropic-compatible';
}

/** 添加供给源时从模板 / catalog / 已有 provider 解析 base_url */
function resolveSeedBaseUrl(entry, { providers = [], paygCatalog = [], meta = {} } = {}) {
  const tpl = entry?.template;
  const catalogId = tpl?.key || entry?.providerId;
  // OpenAI/Anthropic Compatible：始终从空地址起填，避免带上上次自定义的历史 URL
  if (isBlankCompatibleSourceId(catalogId) || isBlankCompatibleSourceId(entry?.providerId)) {
    return tpl?.base_url || '';
  }
  if (tpl?.base_url) return tpl.base_url;
  const sibling = providers.find(p => p.id === catalogId || p.id === entry?.providerId);
  if (sibling?.base_url) return sibling.base_url;
  const payg = (paygCatalog || []).find(x => (x.provider_id || x.id) === catalogId);
  if (payg?.base_url) return payg.base_url;
  return meta[catalogId]?.base_url || meta[entry?.providerId]?.base_url || '';
}

/** 账户实例 → 供给源卡片数据（acct-* 从 catalog 模板克隆） */
function resolveProviderStubForInstance(inst, providers, meta, userPayg, userSubs) {
  const gwId = inst.gateway_id;
  const existing = providers.find(p => p.id === gwId);
  const instModels = seedModelsFromNames(inst.models);
  if (existing) {
    const live = withProviderDisplayName(existing, userPayg, userSubs, meta);
    // provider 尚未配置模型时，从账户实例模板预填
    if ((!live.models || !live.models.length) && instModels.length) {
      return { ...live, models: instModels };
    }
    return live;
  }
  const catalogId = inst.source_id;
  const fb = FALLBACK_PROVIDERS.find(p => p.id === gwId)
    || FALLBACK_PROVIDERS.find(p => p.id === catalogId);
  const sibling = providers.find(p => p.id === catalogId);
  const m = meta[gwId] || meta[catalogId] || {};
  const independent = isIndependentGatewayInstance(gwId, catalogId);
  const fallbackModels = instModels;
  const blankCompat = isBlankCompatibleSourceId(catalogId);
  return {
    ...(fb || { type: 'paid', enabled: false, base_url: '', models: [] }),
    id: gwId,
    type: 'paid',
    enabled: independent ? true : (sibling?.enabled ?? fb?.enabled ?? false),
    ...(independent ? FRESH_PROVIDER_CREDENTIALS : {
      token: sibling?.token || '',
      credentials: sibling?.credentials ?? null,
      oauth_provider: sibling?.oauth_provider || '',
      auth_type: sibling?.auth_type || 'api_key',
      test_verified: sibling?.test_verified === true,
    }),
    // 自定义兼容源：不继承 sibling 历史 base_url
    base_url: blankCompat
      ? (fb?.base_url || m.base_url || '')
      : (fb?.base_url || m.base_url || sibling?.base_url || ''),
    api_format: fb?.api_format || m.api_format || sibling?.api_format || 'openai',
    models: fallbackModels,
    displayName: inst.name,
  };
}

/** 供给源卡片 meta：网关 id 优先，订阅转 API 按 source_id 补 OAuth 能力 */
function resolveMetaForGateway(gwId, meta, inst, oauthById = {}) {
  const direct = meta[gwId] || meta[inst?.source_id];
  if (direct?.oauth) return direct;
  const oauthPid = inst?.source_id && OAUTH_SUB_SOURCE_TO_PID[inst.source_id];
  const fromPid = oauthPid && meta[oauthPid];
  if (fromPid?.oauth) return { ...direct, ...fromPid };
  if (oauthPid && oauthById[oauthPid]) {
    return {
      ...(direct || fromPid || {}),
      oauth: oauthById[oauthPid],
      label: direct?.label || fromPid?.label || inst?.name || inst?.label,
      icon: direct?.icon || fromPid?.icon || inst?.icon,
      hint: direct?.hint || fromPid?.hint,
    };
  }
  const fallback = direct || fromPid || {};
  if (!fallback.label && (inst?.name || inst?.label)) {
    return { ...fallback, label: inst.name || inst.label, icon: inst.icon || fallback.icon };
  }
  return fallback;
}

function Toggle({ enabled, onChange, disabled = false }) {
  return (
    <div onClick={disabled ? undefined : onChange}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
        disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${enabled ? 'bg-blue-600' : 'bg-zinc-600'}`}>
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </div>
  );
}

// ── P2P Network Card ──────────────────────────────────────────────────────────

function P2PNetworkCard({ provider, onUpdate, onPersistEnabled, cooldowns = [], onRetryCooldown = null }) {
  // 钉选 worker 冷却：只取 tokenbank-p2p 带 sharer 的条目，键 `${model}::${sharer}`（对齐 /public/network 的 w.sharer）。
  // 未钉选的池条目（无 sharer）是 45s 瞬时，不在这展示。
  const workerCooldowns = useMemo(() => {
    const m = {};
    for (const c of (cooldowns || [])) {
      if (c.provider_id === 'tokenbank-p2p' && c.sharer && c.model) m[`${c.model}::${c.sharer}`] = c;
    }
    return m;
  }, [cooldowns]);
  const workerCd = (modelName, sharer) => (sharer ? workerCooldowns[`${modelName}::${sharer}`] : null) || null;
  const { t } = useLang();
  const { user } = useAuth();
  const needsLogin = !user;
  const navigate   = useNavigate();
  const [probing, setProbing] = useState(null);     // null | { done, total, current }
  const probeAbortRef = useRef(false);
  const [network,        setNetwork]        = useState(null);
  const [balance,        setBalance]        = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [circleModelMap, setCircleModelMap] = useState({});
  const [communityIds,   setCommunityIds]   = useState([]);
  const [expandedModel,  setExpandedModel]  = useState(null);
  const [latencyMap,     setLatencyMap]     = useState({});   // 我们的请求历史(含 tokenbank-p2p)：社区速度+服务质量同源

  // P2P gateway API key config
  const [showKeyConfig, setShowKeyConfig] = useState(false);
  const [apiKeys,       setApiKeys]       = useState([]);   // [{id, key, note, is_active}]
  const [selectedKey,   setSelectedKey]   = useState('');   // key string currently selected
  const [savedKey,      setSavedKey]      = useState('');   // key string saved in local-config
  const [keySaving,     setKeySaving]     = useState(false);
  const [keySaved,      setKeySaved]      = useState(false);
  const [keysLoading,   setKeysLoading]   = useState(false);
  const [newNote,       setNewNote]       = useState('');
  const [creating,      setCreating]      = useState(false);
  const [deletingId,    setDeletingId]    = useState(null);

  // Load saved key from local-config, and backend keys when section opens
  useEffect(() => {
    getLocalConfig().get().then(cfg => {
      const t = cfg.cloud_config?.token || '';
      setSavedKey(t);
      if (t) setSelectedKey(t);
    }).catch(() => {});
  }, []);

  function reloadKeys(preselectKey) {
    setKeysLoading(true);
    listKeys()
      .then(r => {
        const keys = (r.data?.keys || r.data || []).filter(k => k.is_active);
        setApiKeys(keys);
        const target = preselectKey || selectedKey;
        if (keys.length > 0 && !keys.some(k => k.key === target)) {
          setSelectedKey(keys[0].key);
        } else if (preselectKey) {
          setSelectedKey(preselectKey);
        }
      })
      .catch(() => {})
      .finally(() => setKeysLoading(false));
  }

  useEffect(() => {
    if (!showKeyConfig || needsLogin) return;
    reloadKeys();
  }, [showKeyConfig, needsLogin]);

  async function handleCreate() {
    if (needsLogin) return;
    setCreating(true);
    try {
      const r = await createKey(newNote.trim() || undefined);
      const newKey = r.data?.key || r.data;
      setNewNote('');
      reloadKeys(newKey?.key || newKey);
    } catch (e) {
      alert(t('providers.err.createFailed', { msg: e.message || t('providers.err.unknown') }));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(keyId, keyStr) {
    setDeletingId(keyId);
    try {
      await deleteKey(keyId);
      const remaining = apiKeys.filter(k => k.id !== keyId);
      setApiKeys(remaining);
      if (selectedKey === keyStr) setSelectedKey(remaining[0]?.key || '');
      if (savedKey === keyStr) setSavedKey('');
    } catch (e) {
      alert(t('providers.err.deleteFailed', { msg: e.message || t('providers.err.unknown') }));
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSaveKey() {
    if (needsLogin || !selectedKey) return;
    setKeySaving(true);
    try {
      await getLocalConfig().setCloudConfig({
        url:   normalizeServerBase(getServerUrl()),
        token: selectedKey,
      });
      await syncCloudConfigUrl(getServerUrl());
      setSavedKey(selectedKey);
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 2000);
    } catch (e) {
      alert(t('providers.err.saveFailed', { msg: e.message }));
    } finally {
      setKeySaving(false);
    }
  }

  // 拉取 network + 余额 + 社区目录 + 我们的请求历史(速度/服务质量同源)。可被"全部测速"复用即刻刷新。
  const loadNetwork = React.useCallback(async () => {
    try {
      const [netRes, profRes, communityRes, latRes] = await Promise.allSettled([
        getNetwork(), getProfile(), fetchServerCommunityModels(),
        getGateway().getModelProviderLatency(7).catch(() => ({})),
      ]);
      if (netRes.status === 'fulfilled') setNetwork(normalizeNetworkPayload(netRes.value?.data ?? netRes.value));
      if (profRes.status === 'fulfilled') setBalance(profRes.value?.data?.credits_balance ?? null);
      if (latRes.status === 'fulfilled' && latRes.value && typeof latRes.value === 'object') setLatencyMap(latRes.value);
      if (communityRes.status === 'fulfilled') {
        const v = communityRes.value;
        setCommunityIds(Array.isArray(v?.ids) ? v.ids : []);
        setCircleModelMap(v?.circleMap && typeof v.circleMap === 'object' ? v.circleMap : {});
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    loadNetwork();
    const id = setInterval(loadNetwork, 15000);
    return () => clearInterval(id);
  }, [loadNetwork]);

  // 与 /v1/models 一致；节点数从 workers 补充
  const modelStats = React.useMemo(() => {
    try {
      return modelStatsForIds(communityIds, network);
    } catch {
      return [];
    }
  }, [network, communityIds]);

  // 社区某模型在"我们请求历史"里的 tokenbank-p2p 记录(速度+服务质量同源，别名兼容)
  const commRow = (name) => {
    const lm = latencyMap || {};
    let byp = lm[name];
    if (!byp) {
      const lower = String(name || '').toLowerCase();
      for (const k of Object.keys(lm)) {
        if (k.toLowerCase() === lower || k.endsWith(`/${name}`) || k.toLowerCase().endsWith(`/${lower}`)) { byp = lm[k]; break; }
      }
    }
    return byp?.['tokenbank-p2p'] || null;
  };
  // 折叠卡速度与展开 worker 第一行同源：有我们的探针用探针，否则用最快节点上报
  function fastestWorkerMs(name) {
    try {
      const n = workersForModel(name, network)?.[0]?.last_ttft_ms;
      return n > 0 ? n : null;
    } catch { return null; }
  }
  function p2pCardSpeed(m) {
    // 生图不测速：忽略历史 chat 探针的失败，避免红点
    if (inferModelTypeFromName(m?.name) === 'image') {
      return { ms: null, failed: false, ok: false, skipped: true };
    }
    const row = commRow(m?.name);
    const code = row?.last_status_code ?? null;
    const failed = code != null && (code < 200 || code >= 300);
    const localMs = !failed && (row?.last_ttft_ms > 0 ? row.last_ttft_ms : (row?.avg_ttft_ms > 0 ? row.avg_ttft_ms : null));
    const netMs = fastestWorkerMs(m?.name);
    if (failed && !(localMs > 0)) return { ms: null, failed: true, ok: false };
    if (localMs > 0) return { ms: localMs, failed: false, ok: true };
    return { ms: netMs > 0 ? netMs : null, failed: false, ok: false };
  }
  // 按网络速度(最快 worker 的 ttft)升序排；无节点排后面。与折叠点/worker 点同源。
  const sortedModelStats = React.useMemo(() => {
    const spd = (m) => (m.minLatency > 0 ? m.minLatency : 9e9);
    return [...modelStats].sort((a, b) => spd(a) - spd(b));
  }, [modelStats]);
  // 探针顺序跟网格一致；生图跳过
  const orderedProbeTargets = React.useMemo(() => (
    (sortedModelStats || [])
      .filter(m => m && (m.nodes ?? 0) > 0 && inferModelTypeFromName(m.name) !== 'image')
      .map(m => m.name)
  ), [sortedModelStats]);

  const refreshP2pLatency = async () => {
    try {
      const map = await getGateway().getModelProviderLatency(7);
      if (map && typeof map === 'object') setLatencyMap({ ...map });
    } catch { /* 网关未就绪时忽略 */ }
  };

  const probeAllSpeed = async () => {
    if (probing) return;
    const targets = orderedProbeTargets;
    if (!targets.length) return;
    probeAbortRef.current = false;
    setProbing({ done: 0, total: targets.length, current: targets[0] });
    for (let i = 0; i < targets.length; i++) {
      if (probeAbortRef.current) break;
      setProbing({ done: i, total: targets.length, current: targets[i] });
      // p2p: 前缀强制走社区层；网关按裸名记速
      try { await window.electronAPI?.gateway?.probeModel?.('p2p:' + targets[i]); } catch { /* ignore */ }
      try { await refreshP2pLatency(); } catch { /* ignore */ }
      if (probeAbortRef.current) break;
      setProbing({ done: i + 1, total: targets.length, current: targets[i + 1] || null });
    }
    try { await refreshP2pLatency(); } catch { /* ignore */ }
    if (!probeAbortRef.current) setProbing(null);
    probeAbortRef.current = false;
  };
  const cancelProbe = () => {
    probeAbortRef.current = true;
    setProbing(null);
  };

  const totalNodes = network?.summary?.online_workers ?? 0;


  function ModelSub({ m }) {
    if (!m || m.nodes === 0) return <span className="text-zinc-600">{t('providers.p2p.unavailable')}</span>;

    let nodes = [];
    try {
      nodes = workersForModel(m.name, network);
    } catch { /* ignore */ }

    const total = nodes.length || m.nodes;
    const MAX_SHOW = 5;
    const shown = nodes.slice(0, MAX_SHOW);
    const overflow = total > MAX_SHOW;
    const { ms: fastMs, failed } = p2pCardSpeed(m);

    return (
      <span className="inline-flex items-center gap-1 min-w-0">
        <span className="inline-flex items-center -space-x-1 shrink-0">
          {shown.map((w, i) => (
            <span
              key={`${w.worker_id || w.name || 'n'}:${i}`}
              title={w.name}
              className={`inline-flex items-center justify-center w-4 h-4 rounded-full ring-1 ring-white dark:ring-zinc-800 text-[8px] font-bold text-white ${avatarColor(w.worker_id || w.name || '')} ${w.status === 'busy' ? 'ring-amber-400' : ''}`}
            >
              {(w.name || '?').replace(/\*/g, '')[0] || '?'}
            </span>
          ))}
          {overflow && (
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full ring-1 ring-white dark:ring-zinc-800 bg-zinc-200 dark:bg-zinc-600 text-[10px] leading-none text-zinc-500 dark:text-zinc-300">
              …
            </span>
          )}
        </span>
        {overflow && (
          <span className="text-[10px] text-zinc-400 whitespace-nowrap shrink-0">
            {t('providers.p2p.nodesTotal', { n: total })}
          </span>
        )}
        {fastMs != null && !failed ? (
          <span className="text-zinc-500 text-[10px] tabular-nums shrink-0">
            · {t('providers.p2p.ttftShort', { s: (fastMs / 1000).toFixed(1) })}
          </span>
        ) : failed ? null : (
          <span className="text-green-600 dark:text-green-400 text-[10px] shrink-0">{t('providers.p2p.idle')}</span>
        )}
        {(() => {
          const n = Object.keys(workerCooldowns).filter(k => k.startsWith(`${m.name}::`)).length;
          return n > 0 ? <span title={t('psrc.cooldown.workerCoolingHint')} className="text-blue-600 dark:text-blue-400 text-[10px] shrink-0">❄{n}</span> : null;
        })()}
      </span>
    );
  }

  // 冷却标记（在线行与离线合成行共用）：❄倒计时 + 解冻链接。
  function cooldownMark(cd) {
    if (!cd) return null;
    const cm = cooldownMeta(cd.reason);
    return (
      <>
        <span title={`${t(cm.label)} · ${cd.note || ''}`}
          className={`shrink-0 inline-flex items-center gap-0.5 px-1 rounded ${cm.blue ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20' : 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20'}`}>
          <span aria-hidden>{cm.icon}</span>{fmtCooldownRemain(cd.until, t)}
        </span>
        {onRetryCooldown && (
          <button type="button" onClick={() => onRetryCooldown(cd.key)}
            className="shrink-0 text-blue-500 hover:text-blue-600 dark:text-blue-400">{t('psrc.cooldown.retry')}</button>
        )}
      </>
    );
  }
  function ModelNodeList({ modelName }) {
    let nodes = [];
    try {
      nodes = workersForModel(modelName, network);
    } catch {
      nodes = [];
    }
    // 冷却中但当前不在在线列表的钉选 worker（掉线/未上报）→ 合成离线行，冷却态仍可见+可解冻。
    const onlineSharers = new Set(nodes.map(w => w.sharer).filter(Boolean));
    const offlineCooled = Object.entries(workerCooldowns)
      .filter(([k]) => k.startsWith(`${modelName}::`))
      .map(([, cd]) => cd)
      .filter(cd => !onlineSharers.has(cd.sharer));
    if (!nodes.length && !offlineCooled.length) {
      return <p className="text-[10px] text-zinc-500 py-0.5">{t('providers.p2p.noProviderNodes')}</p>;
    }
    // 服务质量：来自我们请求历史的模型级(tokenbank-p2p)，服务端暂不分 worker，故同模型各 worker 同值。
    const skipped = inferModelTypeFromName(modelName) === 'image';
    const mr = skipped ? null : commRow(modelName);
    const mHealth = mr?.last_status_code == null ? null : healthFromStatus(mr.last_status_code);
    const cardSpd = p2pCardSpeed({ name: modelName });
    // 每行：速度点+ms+城市 · 忙闲点+文字 · 质量点+文字 · 流量。文字不着色。
    return (<>
      {nodes.map((w, i) => {
        const cd = workerCd(modelName, w.sharer);   // 钉选该 worker 且在冷却
        // 有我们的测速时与折叠行同一数字；否则各节点用自己上报的 TTFT
        const ms = skipped ? w.last_ttft_ms
          : ((cardSpd.ok && cardSpd.ms > 0) ? cardSpd.ms : w.last_ttft_ms);
        const failed = skipped ? false : cardSpd.failed;
        return (
        <div key={`${w.worker_id || w.name || 'node'}:${i}`}
          className={`flex items-center justify-between gap-2 text-[10px] text-zinc-500 dark:text-zinc-400 ${cd ? 'opacity-60' : ''}`}>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`w-2 h-2 rounded-full shrink-0 ${speedDotClass(statusDotBucket({ ms, failed, ok: !failed && ms > 0 }))}`} title="速度" />
            <span className="shrink-0 tabular-nums">{ms > 0 ? `${(ms / 1000).toFixed(1)}s` : '—'}</span>
            <span className="truncate text-zinc-700 dark:text-zinc-300">{w.name}</span>
            {w.geo?.city && <span className="truncate text-zinc-400">· {w.geo.city}</span>}
            {cooldownMark(cd)}
          </div>
          <div className="flex items-center gap-1.5 shrink-0 tabular-nums">
            <QualityBadge health={mHealth} />
            {w.active_requests > 0 && <span title="在途请求(流量)">⇅{w.active_requests}</span>}
          </div>
        </div>
      );})}
      {offlineCooled.map((cd, i) => (
        <div key={`offc:${cd.sharer}:${i}`} className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 opacity-60">
          <span className="w-2 h-2 rounded-full shrink-0 bg-zinc-300 dark:bg-zinc-600" title="离线" />
          <span className="truncate text-zinc-700 dark:text-zinc-300">{cd.sharer}</span>
          <span className="shrink-0 text-zinc-400">· {t('providers.p2p.offline') || '离线'}</span>
          {cooldownMark(cd)}
        </div>
      ))}
    </>);
  }

  return (
    <div className="tb-soft-tile rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <div className="w-9 h-9 rounded-xl bg-zinc-100/70 dark:bg-zinc-800/70 backdrop-blur-sm flex items-center justify-center text-base shrink-0">🌐</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{t('providers.meta.tokenbank-p2p.label')}</span>
              {!needsLogin && provider.enabled && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/50 text-green-600 dark:text-green-400 border border-green-300 dark:border-green-800/50">
                  {t('providers.p2p.running')}
                </span>
              )}
            </div>
            <Toggle
              enabled={provider.enabled}
              disabled={needsLogin}
              onChange={() => {
                const next = !provider.enabled;
                onUpdate('tokenbank-p2p', { enabled: next });
                onPersistEnabled?.('tokenbank-p2p', next);
              }}
            />
          </div>
          {!loading && (
            <p className="text-xs text-zinc-500 mt-1">
              {!needsLogin && balance !== null ? t('providers.p2p.balance', { n: Math.round(balance) }) : ''}
              {!needsLogin && balance !== null && totalNodes > 0 ? ' · ' : ''}
              {totalNodes > 0 ? t('providers.p2p.nodes', { n: totalNodes }) : t('providers.p2p.fetchingNodes')}
            </p>
          )}
          {loading && <p className="text-xs text-zinc-600 mt-1">{t('providers.p2p.loading')}</p>}
        </div>
      </div>

      {/* Model grid：未登录也可浏览社区节点模型；启用转发需登录 */}
      <div className="px-4 pb-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500">
            {t('providers.p2p.modelsTitle', { n: modelStats.length })} <span className="text-zinc-700">{t('providers.p2p.modelsSub')}</span>
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={probing ? cancelProbe : probeAllSpeed} disabled={!probing && orderedProbeTargets.length === 0}
              title={probing ? t('providers.probe.cancelHint') : t('providers.probe.titleP2p')}
              className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 disabled:opacity-50 flex items-center gap-1 whitespace-nowrap">
              {probing ? t('providers.probe.running', { done: probing.done, total: probing.total }) : t('providers.probe.all')}
            </button>
            <button onClick={() => navigate('/network')}
              className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 flex items-center gap-1 whitespace-nowrap">
              {t('providers.p2p.globalNetwork')}
            </button>
          </div>
        </div>
        {modelStats.length === 0 && !loading ? (
          <p className="text-xs text-zinc-600 py-2">{t('providers.p2p.noNodes')}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2">
            {(sortedModelStats.length > 0 ? sortedModelStats : Array(4).fill(null)).map((m, i) => (
              m ? (
                <div key={m.name || `model-${i}`} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => setExpandedModel(prev => (prev === m.name ? null : m.name))}
                    className={`w-full bg-zinc-100 dark:bg-zinc-800 border rounded-lg px-2.5 py-1.5 flex items-center justify-between gap-1.5 min-w-0 text-left transition-colors ${
                      expandedModel === m.name
                        ? 'border-blue-300 dark:border-blue-700/60 ring-1 ring-blue-200/60 dark:ring-blue-800/40'
                        : 'border-zinc-300/50 dark:border-zinc-700/50 hover:border-zinc-400 dark:hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {(() => {
                        const online = m.nodes > 0;
                        const probingThis = !!(probing?.current && probing.current === m.name);
                        const { ms, failed, ok, skipped } = p2pCardSpeed(m);
                        const bucket = probingThis ? 'fast' : skipped ? 'unknown' : statusDotBucket({ ms, failed, ok: ok && !!ms });
                        return <span
                          className={`w-2 h-2 rounded-full shrink-0 ${!online ? 'bg-zinc-300 dark:bg-zinc-600' : probingThis ? 'bg-green-400 tb-probe-pulse' : speedDotClass(bucket)}`}
                          title={probingThis ? '测速中' : (!online ? t('providers.p2p.unavailable') : (skipped ? t('providers.probe.skipImage') : (failed ? '最近请求失败' : (ms ? `最快 ${(ms / 1000).toFixed(1)}s` : '暂无速度'))))}
                        />;
                      })()}
                      <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{m.name}</span>
                      {circleModelMap?.[m.name] && (
                        <span
                          title={circleModelMap[m.name]?.circle_name || '圈子'}
                          className="shrink-0 text-[10px] leading-none px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 cursor-default"
                        >
                          ⊙
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-xs text-zinc-500"><ModelSub m={m} /></span>
                      <span className="text-[10px] text-zinc-400">{expandedModel === m.name ? '▾' : '▸'}</span>
                    </div>
                  </button>
                  {expandedModel === m.name && (
                    <div className="mt-1 ml-1 pl-2 border-l border-zinc-200 dark:border-zinc-700 space-y-1">
                      <ModelNodeList modelName={m.name} />
                    </div>
                  )}
                </div>
              ) : (
                <div key={i} className="bg-zinc-100/50 dark:bg-zinc-800/50 border border-zinc-300/30 dark:border-zinc-700/30 rounded-lg py-1.5 h-7 animate-pulse" />
              )
            ))}
          </div>
          </>
        )}
      </div>

      {/* Gateway API Key config（需登录） */}
      <div className="border-t border-zinc-100 dark:border-zinc-800">
          {needsLogin ? (
            <div className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-xs text-zinc-500">
              <span className="flex items-center gap-2 min-w-0">
                <span>{t('providers.p2p.gatewayKey')}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40 shrink-0">
                  {t('providers.p2p.loginBadge')}
                </span>
              </span>
              <button type="button" onClick={() => navigate('/login', { state: { from: '/providers' } })}
                className="shrink-0 text-xs font-medium px-2.5 py-1 rounded-lg border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors">
                {t('profile.guestLogin')}
              </button>
            </div>
          ) : (
          <>
          <button
            onClick={() => setShowKeyConfig(v => !v)}
            className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/30 transition-colors"
          >
            <span className="flex items-center gap-2">
              <span>{t('providers.p2p.gatewayKey')}</span>
              {savedKey
                ? <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 border border-green-200 dark:border-green-800/40">{t('providers.p2p.configured')}</span>
                : <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800/40">{t('providers.p2p.notConfigured')}</span>
              }
            </span>
            <span className="text-zinc-400">{showKeyConfig ? '▲' : '▼'}</span>
          </button>

          {showKeyConfig && (
            <div className="px-4 pb-4 space-y-3">
              <p className="text-xs text-zinc-500">{t('providers.p2p.keyHint')}</p>

              {keysLoading ? (
                <p className="text-xs text-zinc-400">{t('providers.common.loading')}</p>
              ) : (
                <div className="space-y-2">
                  {/* Key list */}
                  {apiKeys.length === 0 ? (
                    <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('providers.p2p.noKeys')}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {apiKeys.map(k => (
                        <div key={k.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                          selectedKey === k.key
                            ? 'border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/20'
                            : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 hover:border-zinc-300 dark:hover:border-zinc-600'
                        }`} onClick={() => { setSelectedKey(k.key); setKeySaved(false); }}>
                          <div className="flex-1 min-w-0">
                            {k.note && <p className="text-xs text-zinc-700 dark:text-zinc-300 truncate">{k.note}</p>}
                            <p className="text-xs font-mono text-zinc-400 dark:text-zinc-500">
                              {k.key.slice(0, 14)}…
                              {k.key === savedKey && <span className="ml-1.5 text-green-500">{t('providers.p2p.inUse')}</span>}
                            </p>
                          </div>
                          <button
                            onClick={e => { e.stopPropagation(); handleDelete(k.id, k.key); }}
                            disabled={deletingId === k.id}
                            className="text-zinc-400 hover:text-red-500 dark:hover:text-red-400 text-sm leading-none disabled:opacity-40 shrink-0 transition-colors"
                          >
                            {deletingId === k.id ? '…' : '×'}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Save selected */}
                  {selectedKey && selectedKey !== savedKey && (
                    <button onClick={handleSaveKey} disabled={keySaving}
                      className="w-full px-3 py-1.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors">
                      {keySaving ? t('providers.p2p.saving') : keySaved ? t('providers.p2p.savedKey') : t('providers.p2p.setGatewayKey')}
                    </button>
                  )}

                  {/* Create new key */}
                  <div className="flex gap-2 pt-1 border-t border-zinc-100 dark:border-zinc-800">
                    <input
                      value={newNote}
                      onChange={e => setNewNote(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleCreate()}
                      placeholder={t('providers.p2p.notePlaceholder')}
                      className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500"
                    />
                    <button onClick={handleCreate} disabled={creating}
                      className="px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 text-xs text-zinc-700 dark:text-zinc-300 rounded-lg transition-colors whitespace-nowrap">
                      {creating ? t('providers.p2p.creating') : t('providers.p2p.newKey')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          </>
          )}
        </div>
      </div>
  );
}

function StatusBadge({ verified, cooling = false }) {
  const { t } = useLang();
  // 冷却中优先：不要用绿色「已通过」误导可用性
  if (cooling) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-sky-600 dark:text-sky-400" title={t('providers.badge.cooling')}>
        <span className="w-2 h-2 rounded-full bg-sky-400 shrink-0" aria-hidden />
      </span>
    );
  }
  if (verified) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400" title={t('providers.badge.verified')}>
        <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" aria-hidden />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="w-2 h-2 rounded-full bg-zinc-400 dark:bg-zinc-500 shrink-0" aria-hidden />
      <span>{t('providers.badge.needsConfig')}</span>
    </span>
  );
}

/** 修改凭证相关字段时清除 test 通过标记 */
const CREDENTIAL_PATCH_KEYS = ['token', 'auth_type', 'oauth_provider', 'credentials', 'base_url', 'api_format'];
function patchClearsTestVerified(patch) {
  return CREDENTIAL_PATCH_KEYS.some(k => Object.prototype.hasOwnProperty.call(patch, k));
}

/** catalog / 账户重载时保留内存里尚未 debounce 落盘的字段，避免 base_url 等被磁盘旧值覆盖 */
const PROVIDER_RELOAD_PRESERVE_KEYS = [
  ...CREDENTIAL_PATCH_KEYS,
  'enabled', 'test_verified', 'billing_type', 'sub_mode', 'type', 'tier',
];

function mergeProviderAfterReload(disk, mem) {
  if (!mem) return disk;
  const normBase = u => String(u || '').trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
  const patch = {};
  for (const k of PROVIDER_RELOAD_PRESERVE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(mem, k) || mem[k] === disk[k]) continue;
    // 仅差 /v1 尾缀时以 catalog 对齐后的磁盘值为准（避免旧本地值覆盖服务端 base_url）
    if (k === 'base_url' && normBase(mem[k]) === normBase(disk[k])) continue;
    patch[k] = mem[k];
  }
  let out = Object.keys(patch).length ? { ...disk, ...patch } : { ...disk };
  if (!mem.models?.length) return out;
  const diskM = (out.models || []).map(normModel);
  const memM = (mem.models || []).map(normModel);
  const mergedModels = diskM.map(d => {
    const hit = memM.find(m => m.name === d.name);
    return hit ? { ...d, type: hit.type || d.type } : d;
  });
  const changed = mergedModels.some((m, i) => m.type !== diskM[i]?.type);
  return changed ? { ...out, models: mergedModels } : out;
}

/** 合并 catalog 默认与用户保存：本地仅存去掉 /v1 的旧 base_url 时，对齐 catalog 完整值 */
function pickBaseUrlOnCatalogMerge(def, saved, metaEntry) {
  const savedUrl = saved?.base_url || '';
  const catalogUrl = def?.base_url || metaEntry?.base_url || '';
  if (!savedUrl) return catalogUrl;
  if (!catalogUrl) return savedUrl;
  const norm = u => String(u || '').trim().replace(/\/v1\/?$/, '').replace(/\/$/, '');
  if (norm(savedUrl) === norm(catalogUrl) && savedUrl !== catalogUrl) return catalogUrl;
  return savedUrl;
}

function buildCatalogDefaultsById(defaults) {
  const out = {};
  for (const d of defaults || []) {
    if (d?.id) out[d.id] = d;
  }
  return out;
}

/** 落盘前规范化 base_url：catalog 源保留/对齐完整 URL；仅自定义源去掉 /v1 */
function normalizeProviderBaseUrlForSave(provider, defaultsById, meta) {
  const def = defaultsById[provider.id];
  const metaEntry = meta[provider.id];
  const isCatalog = !!(def || metaEntry?.base_url);
  if (isCatalog) {
    return { ...provider, base_url: pickBaseUrlOnCatalogMerge(def, provider, metaEntry) };
  }
  // catalog 尚未加载时不 strip，避免 Agnes 等预设源在首屏保存时被误删 /v1
  if (!Object.keys(defaultsById).length) return provider;
  return {
    ...provider,
    base_url: (provider.base_url || '').replace(/\/v1\/?$/, '').replace(/\/$/, ''),
  };
}

/** provider_pricing_overrides 中非模型字段（历史遗留，不再写入） */
const PRICING_OVERRIDE_META_KEYS = new Set(['_excluded_models']);

function isValidModelName(name) {
  const n = String(name || '').trim();
  return !!n && !PRICING_OVERRIDE_META_KEYS.has(n) && n !== 'excluded_models';
}

function sanitizePricingOverrides(overrides) {
  if (!overrides || typeof overrides !== 'object') return {};
  let changed = false;
  const next = {};
  for (const [pid, ovr] of Object.entries(overrides)) {
    if (!ovr || typeof ovr !== 'object') continue;
    if (ovr._excluded_models != null) changed = true;
    const perPid = { ...ovr };
    delete perPid._excluded_models;
    if (pricingOverrideModelKeys(perPid).length) next[pid] = perPid;
  }
  return changed ? next : overrides;
}

function pricingOverrideModelKeys(ovr) {
  return Object.keys(ovr || {}).filter(k => isValidModelName(k));
}

/** 从 provider 列表剔除误写入的伪模型名（如 _excluded_models） */
function sanitizeProviderModels(list) {
  return (list || []).map(p => {
    const models = (p.models || []).map(normModel).filter(m => m.name);
    const before = (p.models || []).map(modelEntryName).filter(Boolean).join('\0');
    const after = models.map(m => m.name).join('\0');
    return before === after ? p : { ...p, models };
  });
}

// Normalize a model entry to {name, type} — handles both string and object formats.
// 模态四类：chat(文本) / vision(图文) / image(生图) / embedding(嵌入)。
function normModel(m) {
  if (typeof m === 'string') return { name: isValidModelName(m) ? m : '', type: 'chat' };
  let type = m.type || 'chat';
  if (type === 'chat' && m.vision) type = 'vision';   // 迁移旧的 vision 标志 → 独立 vision 类型
  return { name: isValidModelName(m.name) ? m.name : '', type };
}

/** 以 catalog 为准裁剪本地已配置模型（去掉服务端已下线的；不自动填入 catalog 全量） */
function mergeModelsFromCatalog(catalogModels, savedModels) {
  const saved = (savedModels || [])
    .map(m => normModel(typeof m === 'string' ? { name: m } : m))
    .filter(m => m.name);
  if (!catalogModels?.length) return saved;
  const catalogByName = new Map(
    catalogModels.map(m => {
      const c = normModel(typeof m === 'string' ? { name: m } : m);
      return [c.name, c];
    }).filter(([name]) => name),
  );
  return saved
    .filter(m => catalogByName.has(m.name))
    .map(m => {
      const c = catalogByName.get(m.name);
      return { name: m.name, type: m.type || c?.type || 'chat' };
    });
}

/** 模板/账户实例上的模型名 → 供给源卡片可编辑格式 */
function seedModelsFromNames(names) {
  return (names || []).map(normModel).filter(m => m.name);
}

/** 按量供给源：剔除个人页未配置的模型（含服务端刊例价目录） */
function filterPaygModels(models, providerId, userPayg, providerPricing = {}, paygCatalog = []) {
  const allowed = new Set(buildPaygProfileModels(providerId, userPayg, providerPricing, paygCatalog));
  return (models || []).map(normModel).filter(m => allowed.has(m.name));
}

function ModelListEditor({ models = [], onChange, scrollable = false, suggestions = [], profileOnly = false }) {
  const { t } = useLang();
  const [input,     setInput]     = useState('');
  const [inputType, setInputType] = useState('chat');
  const [open,      setOpen]      = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [menuStyle, setMenuStyle] = useState(null);
  const inputRef = useRef(null);
  const [speedMap] = useSpeedMap();   // modelId → {ttft_ms,tps,bucket,samples}

  const normalized = models.map(normModel);
  const existingNames = useMemo(() => new Set(normalized.map(m => m.name)), [normalized]);
  const allowedSet = useMemo(() => new Set(suggestions || []), [suggestions]);

  const filteredSuggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    return (suggestions || [])
      .filter(name => !existingNames.has(name))
      .filter(name => !q || name.toLowerCase().includes(q))
      .slice(0, 10);
  }, [suggestions, input, existingNames]);

  const showSuggestions = open && filteredSuggestions.length > 0;

  function canAdd(name) {
    const n = (name ?? input).trim();
    if (!n || existingNames.has(n)) return false;
    if (profileOnly && !allowedSet.has(n)) return false;
    return true;
  }

  // 下拉挂到 body，避免被卡片 overflow-hidden 裁切
  const updateMenuPosition = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const maxH = 160;
    const gap = 4;
    const spaceBelow = window.innerHeight - rect.bottom - gap;
    const spaceAbove = rect.top - gap;
    const openUp = spaceBelow < Math.min(maxH, filteredSuggestions.length * 32) && spaceAbove > spaceBelow;
    const height = Math.min(maxH, openUp ? spaceAbove : spaceBelow);
    setMenuStyle({
      left: rect.left,
      width: rect.width,
      top: openUp ? rect.top - gap - height : rect.bottom + gap,
      maxHeight: Math.max(height, 80),
    });
  }, [filteredSuggestions.length]);

  useEffect(() => {
    setActiveIdx(0);
  }, [filteredSuggestions.length, input]);

  useEffect(() => {
    if (!showSuggestions) {
      setMenuStyle(null);
      return;
    }
    updateMenuPosition();
    window.addEventListener('scroll', updateMenuPosition, true);
    window.addEventListener('resize', updateMenuPosition);
    return () => {
      window.removeEventListener('scroll', updateMenuPosition, true);
      window.removeEventListener('resize', updateMenuPosition);
    };
  }, [showSuggestions, updateMenuPosition]);

  function add(nameOverride) {
    const n = (nameOverride ?? input).trim();
    if (!canAdd(n)) { setInput(''); setOpen(false); return; }
    onChange([...normalized, { name: n, type: inputType }]);
    setInput('');
    setOpen(false);
  }

  function remove(name)     { onChange(normalized.filter(m => m.name !== name)); }
  function toggleType(name) {
    // 单徽章循环：文本(chat) → 图文(vision) → 生图(image) → 嵌入(embedding) → 文本
    const cycle = { chat: 'vision', vision: 'image', image: 'embedding', embedding: 'chat' };
    onChange(normalized.map(m => m.name === name ? { name, type: cycle[m.type] || 'vision' } : m));
  }

  function handleInputKeyDown(e) {
    if (!open || filteredSuggestions.length === 0) {
      if (e.key === 'Enter') { e.preventDefault(); if (canAdd()) add(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => (i + 1) % filteredSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => (i - 1 + filteredSuggestions.length) % filteredSuggestions.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      add(filteredSuggestions[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const suggestionMenu = showSuggestions && menuStyle && createPortal(
    <ul
      style={{ position: 'fixed', left: menuStyle.left, top: menuStyle.top, width: menuStyle.width, maxHeight: menuStyle.maxHeight, zIndex: 9999 }}
      className="overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg py-1"
      role="listbox"
    >
      {filteredSuggestions.map((name, i) => (
        <li key={name} role="option" aria-selected={i === activeIdx}>
          <button
            type="button"
            onMouseDown={e => { e.preventDefault(); add(name); }}
            className={`w-full text-left px-3 py-1.5 text-xs font-mono transition-colors ${
              i === activeIdx
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800'
            }`}
          >
            {name}
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  );

  return (
    <div className="space-y-2">
      {/* existing model tags */}
      {normalized.length > 0 && (
        <div className={scrollable ? 'max-h-36 overflow-y-auto pr-1' : ''}>
          <div className="flex flex-wrap gap-1.5">
            {normalized.map(m => (
              <span key={m.name} className="inline-flex items-center gap-0 text-xs bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-lg overflow-hidden font-mono">
                <span className="pl-2 pr-1 py-0.5 flex items-center gap-1.5">
                  <span title={speedTitle(speedFor(speedMap, m.name))}
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${speedDotClass(speedFor(speedMap, m.name)?.bucket)}`} />
                  {m.name}
                </span>
                <button
                  onClick={() => toggleType(m.name)}
                  title={t('providers.models.toggleType')}
                  className={`px-1.5 py-0.5 text-xs font-sans border-l border-zinc-300 dark:border-zinc-700 transition-colors ${
                    m.type === 'image'
                      ? 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-800/60'
                      : m.type === 'embedding'
                        ? 'bg-teal-50 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-900/40'
                        : m.type === 'vision'
                          ? 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/40'
                          : 'bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40'
                  }`}>
                  {m.type === 'image' ? t('providers.models.typeImage')
                    : m.type === 'embedding' ? t('providers.models.typeEmbedding')
                      : m.type === 'vision' ? t('providers.models.typeVision')
                        : t('providers.models.typeText')}
                </button>
                <button onClick={() => remove(m.name)} className="px-1.5 py-0.5 border-l border-zinc-300 dark:border-zinc-700 text-zinc-400 hover:text-red-500 dark:hover:text-red-400 leading-none">×</button>
              </span>
            ))}
          </div>
        </div>
      )}
      {/* add input with type picker + suggestions */}
      <div className="flex gap-2">
        <div className="relative flex-1 min-w-0">
          <input
            ref={inputRef}
            value={input}
            onChange={e => { setInput(e.target.value); setOpen(true); requestAnimationFrame(updateMenuPosition); }}
            onFocus={() => { setOpen(true); requestAnimationFrame(updateMenuPosition); }}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={handleInputKeyDown}
            placeholder={profileOnly ? t('providers.models.paygPickPlaceholder') : t('providers.models.placeholder')}
            className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-blue-500"
            autoComplete="off"
            role="combobox"
            aria-expanded={showSuggestions}
            aria-autocomplete="list"
          />
          {suggestionMenu}
        </div>
        <select value={inputType} onChange={e => setInputType(e.target.value)}
          className="shrink-0 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-700 dark:text-zinc-300 focus:outline-none focus:border-blue-500">
          <option value="chat">{t('providers.models.typeText')}</option>
          <option value="vision">{t('providers.models.typeVision')}</option>
          <option value="image">{t('providers.models.typeImage')}</option>
          <option value="embedding">{t('providers.models.typeEmbedding')}</option>
        </select>
        <button
          onClick={() => add()}
          disabled={!canAdd()}
          className="px-3 py-1.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 text-xs text-zinc-700 dark:text-zinc-300 rounded-lg transition-colors whitespace-nowrap"
        >
          {t('providers.models.add')}
        </button>
      </div>
      {profileOnly && suggestions.length === 0 && (
        <p className="text-xs text-zinc-400">{t('providers.models.paygNoProfileModels')}</p>
      )}
      {normalized.length === 0 && !profileOnly && (
        <p className="text-xs text-zinc-400">{t('providers.models.emptyHint')}</p>
      )}
    </div>
  );
}

/** 用户手工添加模型时的默认刊例价（USD / 百万 Token） */
const DEFAULT_MODEL_PRICING = { in: 1, out: 5, cacheRead: 0.1 };
const DEFAULT_IMAGE_PRICING = { image: 0.04 };
const DEFAULT_EMBEDDING_PRICING = { in: 0.1, out: 0.1 };
/** 独立供给源（无账户实例，如 Ollama）添加模型时的默认定价 */
const STANDALONE_MODEL_PRICING = { in: 0, out: 0, cacheRead: 0 };

function defaultPricingForType(type, standalone = false) {
  if (type === 'image') return standalone ? { image: 0 } : { ...DEFAULT_IMAGE_PRICING };
  if (type === 'embedding') return standalone ? { in: 0, out: 0 } : { ...DEFAULT_EMBEDDING_PRICING };
  return standalone ? { ...STANDALONE_MODEL_PRICING } : { ...DEFAULT_MODEL_PRICING };
}

function billingHintKey({ standalone, isPayg, modelTypeMap, modelNames }) {
  if (standalone) return 'providers.billing.standaloneHint';
  if (!isPayg) return null;
  const types = new Set((modelNames || []).map(n => modelTypeMap[n] || 'chat'));
  if (types.size === 1) {
    const only = [...types][0];
    if (only === 'image') return 'providers.billing.paygHintImage';
    if (only === 'embedding') return 'providers.billing.paygHintEmbedding';
  }
  if (types.has('image') && types.size > 1) return 'providers.billing.paygHintMixed';
  return 'providers.billing.paygHint';
}

function modelEntryName(m) {
  let n = '';
  if (typeof m === 'string') n = m.trim();
  else n = String(m?.name || m?.id || '').trim();
  return isValidModelName(n) ? n : '';
}

/** 实例级已隐藏的云预置模型（与模板 catalog 分离，新实例不受影响） */
function getInstanceExcludedList({ standalone, provider, paygRec, subRec }) {
  if (standalone) return Array.isArray(provider?.excluded_models) ? provider.excluded_models : [];
  if (paygRec) return Array.isArray(paygRec.excluded_models) ? paygRec.excluded_models : [];
  if (subRec) return Array.isArray(subRec.excluded_models) ? subRec.excluded_models : [];
  return [];
}

function withInstanceExcludedAdded(list, modelName) {
  const prev = list || [];
  return prev.includes(modelName) ? prev : [...prev, modelName];
}

function withInstanceExcludedRemoved(list, modelName) {
  return (list || []).filter(m => m !== modelName);
}

/** 合并 provider 下各模型刊例价（服务端默认 + 用户覆盖） */
function pricingRowsForProvider(providerId, models, merged, overrides, excludedModels = []) {
  const base = merged[providerId] || {};
  const ovr = overrides[providerId] || {};
  const excluded = new Set(excludedModels);
  // 仅展示账户已添加的模型名，不回退 catalog 全量键
  const names = new Set(models || []);
  for (const k of excluded) names.delete(k);
  for (const k of [...names]) if (!isValidModelName(k)) names.delete(k);
  return [...names].sort().map(model => ({
    model,
    ...base[model],
    ...ovr[model],
    _override: !!(ovr[model] && Object.keys(ovr[model]).length),
  }));
}

/**
 * 供给源卡片计费区：按账户类型区分展示
 * - api_sub / sub_to_api：订阅月费 + 可手工添加模型及按模型估价
 * - payg：按模型刊例价
 */
function ProviderCardBillingSection({
  billingTag, accountInst, provider, userPayg, userSubscriptions,
  providerPricing, pricingOverrides, onSaveAccounts, onOverridesChange, onUpdate, onPersistModels, t,
  standalone = false, paygCatalog = [], cooldown = null, onRetryCooldown = null,
}) {
  const isPayg = billingTag === 'payg';
  const isSubBilling = billingTag === 'api_sub' || billingTag === 'sub_to_api';
  const paygRec = isPayg && accountInst ? userPayg.find(p => p.id === accountInst?.id) : null;
  const subRec = isSubBilling ? userSubscriptions.find(s => s.id === accountInst?.id) : null;
  const subSourceId = subRec?.source_id || accountInst?.source_id;
  const pricingPid = standalone
    ? provider.id
    : isPayg
      ? (paygRec?.provider_id || accountInst?.source_id)
      : (subRec?.plan_provider_id || OAUTH_SUB_SOURCE_TO_PID[subSourceId] || subSourceId);

  const userModelNames = useMemo(() => {
    const names = new Set();
    if (standalone) {
      for (const m of provider?.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      for (const k of Object.keys(pricingOverrides?.[pricingPid] || {})) {
        if (k && !PRICING_OVERRIDE_META_KEYS.has(k)) names.add(k);
      }
      return names;
    }
    if (isPayg) {
      for (const m of paygRec?.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      // 账户尚无模型时，展示服务端下发的刊例价目录
      if (!paygRec?.models?.length) {
        const catalogPricing = providerPricing?.[pricingPid];
        if (catalogPricing && typeof catalogPricing === 'object') {
          for (const k of Object.keys(catalogPricing)) {
            if (k && !PRICING_OVERRIDE_META_KEYS.has(k)) names.add(k);
          }
        }
      }
      for (const k of Object.keys(pricingOverrides?.[pricingPid] || {})) {
        if (k && !PRICING_OVERRIDE_META_KEYS.has(k)) names.add(k);
      }
    } else {
      // API 订阅：仅账户实例登记的 models + 用户自定义刊例价，不读 catalog 全量
      for (const m of subRec?.models || []) { const n = modelEntryName(m); if (n) names.add(n); }
      for (const k of Object.keys(pricingOverrides?.[pricingPid] || {})) {
        if (k && !PRICING_OVERRIDE_META_KEYS.has(k)) names.add(k);
      }
    }
    return names;
  }, [standalone, isPayg, paygRec, subRec, provider?.models, pricingOverrides, pricingPid, providerPricing]);

  const instanceExcluded = useMemo(
    () => getInstanceExcludedList({ standalone, provider, paygRec, subRec }),
    [standalone, provider?.excluded_models, paygRec?.excluded_models, subRec?.excluded_models],
  );

  // 表格行：按量 / API 订阅均仅展示账户已添加的模型
  const modelNames = useMemo(() => {
    const excluded = new Set(instanceExcluded);
    return [...userModelNames].filter(n => !excluded.has(n)).sort();
  }, [userModelNames, instanceExcluded]);

  const baseMonthly = subRec?.monthly_usd ?? accountInst?.monthly_usd;
  const [monthly, setMonthly] = useState(baseMonthly != null ? String(baseMonthly) : '');
  const pricingSaveTimer = useRef(null);

  useEffect(() => {
    setMonthly(baseMonthly != null ? String(baseMonthly) : '');
  }, [baseMonthly, subRec?.id]);

  // 加载时自动清理历史脏数据（_excluded_models 误入 provider.models / overrides）
  useEffect(() => {
    const badModels = (provider.models || []).some(m => !isValidModelName(modelEntryName(m)));
    const badOverrides = pricingOverrides?.[pricingPid]?._excluded_models != null;
    if (!badModels && !badOverrides) return;
    (async () => {
      if (badModels) {
        const cleaned = (provider.models || []).map(normModel).filter(m => m.name);
        onUpdate(provider.id, { models: cleaned });
        if (onPersistModels) await onPersistModels(provider.id, cleaned);
      }
      if (badOverrides) {
        const next = sanitizePricingOverrides(pricingOverrides);
        onOverridesChange?.(next);
        await onSaveAccounts({ provider_pricing_overrides: next });
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅实例/pricingPid 切换时迁移一次
  }, [provider.id, pricingPid, subRec?.id, paygRec?.id]);

  const rows = useMemo(() => {
    const raw = pricingRowsForProvider(pricingPid, modelNames, providerPricing, pricingOverrides, instanceExcluded);
    if (!standalone) return raw;
    // 独立源未写覆盖时展示 0，便于与账户卡片 UI 一致
    return raw.map(r => ({
      ...r,
      in: r.in ?? STANDALONE_MODEL_PRICING.in,
      out: r.out ?? STANDALONE_MODEL_PRICING.out,
      cacheRead: r.cacheRead ?? STANDALONE_MODEL_PRICING.cacheRead,
      image: r.image ?? 0,
    }));
  }, [standalone, pricingPid, modelNames, providerPricing, pricingOverrides, instanceExcluded]);

  /** 供给源 gateway + 服务端目录里的模型模态 */
  const modelTypeMap = useMemo(() => {
    const map = {};
    const catalogId = paygRec?.provider_id || pricingPid;
    const cat = (paygCatalog || []).find(p => (p.provider_id || p.id) === catalogId);
    if (cat?.model_types) Object.assign(map, cat.model_types);
    for (const m of provider?.models || []) {
      const n = normModel(m);
      if (n.name) map[n.name] = n.type || map[n.name] || 'chat';
    }
    for (const name of modelNames) {
      if (map[name]) continue;
      const rates = providerPricing?.[pricingPid]?.[name] || {};
      map[name] = inferModalityFromPricing(rates);
    }
    return map;
  }, [provider?.models, paygRec?.provider_id, pricingPid, paygCatalog, modelNames, providerPricing]);

  function mergeModelList(name, type = 'chat') {
    const cur = (provider.models || []).map(normModel);
    if (cur.some(m => m.name === name)) {
      return cur.map(m => (m.name === name ? { ...m, type } : m));
    }
    return [...cur, { name, type }];
  }

  async function persistModels(nextList) {
    const normalized = nextList.map(normModel).filter(m => m.name);
    // 计费区添加模型时跳过 payg 裁剪（账户 state 尚未刷新）
    onUpdate(provider.id, { models: normalized, _fromBilling: true });
    if (onPersistModels) await onPersistModels(provider.id, normalized);
  }

  async function toggleModelType(name) {
    // 文本(chat) → 图文(vision) → 生图(image) → 嵌入(embedding) → 文本
    const cycle = { chat: 'vision', vision: 'image', image: 'embedding', embedding: 'chat' };
    const cur = (provider.models || []).map(normModel);
    const hit = cur.find(m => m.name === name);
    const prevType = hit?.type || modelTypeMap[name] || 'chat';
    const nextType = cycle[prevType] || 'vision';
    const next = hit
      ? cur.map(m => (m.name === name ? { name, type: nextType } : m))
      : [...cur, { name, type: nextType }];
    await persistModels(next);
    // 切换模态时重置该模型刊例价字段结构
    const nextOverrides = { ...pricingOverrides };
    const perPid = { ...(nextOverrides[pricingPid] || {}) };
    perPid[name] = { ...defaultPricingForType(nextType, standalone) };
    nextOverrides[pricingPid] = perPid;
    onOverridesChange?.(nextOverrides);
    await onSaveAccounts({ provider_pricing_overrides: nextOverrides });
  }

  function buildOverridesWithModel(name, type = 'chat') {
    const baseRow = (providerPricing[pricingPid] || {})[name] || {};
    const ovrRow = (pricingOverrides[pricingPid] || {})[name] || {};
    const fields = priceFieldsForModality(type);
    const hasPricing = fields.some(f => ovrRow[f] != null || baseRow[f] != null);
    if (hasPricing) return pricingOverrides;
    const defaults = defaultPricingForType(type, standalone);
    return {
      ...pricingOverrides,
      [pricingPid]: {
        ...(pricingOverrides[pricingPid] || {}),
        [name]: { ...defaults },
      },
    };
  }

  function updatePricingCell(model, field, val) {
    const num = val === '' ? null : Number(val);
    const next = {
      ...pricingOverrides,
      [pricingPid]: {
        ...(pricingOverrides[pricingPid] || {}),
        [model]: { ...(pricingOverrides[pricingPid]?.[model] || {}), [field]: num },
      },
    };
    onOverridesChange?.(next);
    if (pricingSaveTimer.current) clearTimeout(pricingSaveTimer.current);
    pricingSaveTimer.current = setTimeout(() => {
      onSaveAccounts({ provider_pricing_overrides: next });
    }, 400);
  }

  async function saveMonthly() {
    if (!subRec) return;
    const num = monthly.trim() === '' ? null : Number(monthly);
    const monthly_usd = (num != null && Number.isFinite(num)) ? num : null;
    const nextSubs = userSubscriptions.map(s => (
      s.id === subRec.id ? { ...s, monthly_usd } : s
    ));
    await onSaveAccounts({ user_subscriptions: nextSubs });
  }

  async function addModel(name, type = 'chat') {
    const n = (name || '').trim();
    if (!n || modelNames.includes(n)) return;
    const nextOverrides = buildOverridesWithModel(n, type);
    onOverridesChange?.(nextOverrides);
    const excluded_models = withInstanceExcludedRemoved(
      getInstanceExcludedList({ standalone, provider, paygRec, subRec }), n,
    );

    if (isPayg && paygRec) {
      const modelEntry = type === 'chat' ? n : { name: n, type };
      const nextPayg = userPayg.map(p => {
        if (p.id !== paygRec.id) return p;
        const patch = { ...p, models: [...(p.models || []), modelEntry] };
        if (excluded_models.length) patch.excluded_models = excluded_models;
        else delete patch.excluded_models;
        return patch;
      });
      const nextModels = mergeModelList(n, type);
      // 先写账户，再落盘 gateway models（避免 filterPaygModels 用旧 userPayg 删掉新模型）
      await onSaveAccounts({
        user_payg_providers: nextPayg,
        ...(nextOverrides !== pricingOverrides ? { provider_pricing_overrides: nextOverrides } : {}),
      });
      await persistModels(nextModels);
      return;
    }
    const nextModels = mergeModelList(n, type);
    const accountsPatch = { provider_pricing_overrides: nextOverrides };
    if (subRec) {
      accountsPatch.user_subscriptions = userSubscriptions.map(s => {
        if (s.id !== subRec.id) return s;
        const patch = {
          ...s,
          models: [...(s.models || []), n],
        };
        if (excluded_models.length) patch.excluded_models = excluded_models;
        else delete patch.excluded_models;
        return patch;
      });
    } else if (standalone) {
      onUpdate(provider.id, {
        excluded_models: excluded_models.length ? excluded_models : undefined,
      });
    }
    // 先写账户再落盘 gateway models（与按量路径一致，避免裁剪时序问题）
    await onSaveAccounts(accountsPatch);
    await persistModels(nextModels);
  }

  async function removeModel(name) {
    if (!name) return;

    // 清理历史脏数据：_excluded_models 被误写入 provider.models / overrides
    if (PRICING_OVERRIDE_META_KEYS.has(name)) {
      const nextModels = (provider.models || []).map(normModel).filter(m => m.name && m.name !== name);
      let nextOverrides = { ...pricingOverrides };
      let dirty = false;
      if (nextOverrides[pricingPid]?._excluded_models != null) {
        const perPid = { ...nextOverrides[pricingPid] };
        delete perPid._excluded_models;
        if (pricingOverrideModelKeys(perPid).length) nextOverrides[pricingPid] = perPid;
        else delete nextOverrides[pricingPid];
        dirty = true;
      }
      if (nextModels.length !== (provider.models || []).map(normModel).filter(m => m.name).length) dirty = true;
      if (dirty) {
        onOverridesChange?.(nextOverrides);
        await persistModels(nextModels);
        await onSaveAccounts({ provider_pricing_overrides: nextOverrides });
      }
      return;
    }

    const nextModels = (provider.models || []).map(normModel).filter(m => m.name !== name);
    let nextOverrides = pricingOverrides;
    if (pricingOverrides[pricingPid]?.[name]) {
      nextOverrides = { ...pricingOverrides };
      const perPid = { ...(nextOverrides[pricingPid] || {}) };
      delete perPid[name];
      if (pricingOverrideModelKeys(perPid).length) nextOverrides[pricingPid] = perPid;
      else delete nextOverrides[pricingPid];
      onOverridesChange?.(nextOverrides);
    }
    const excluded_models = withInstanceExcludedAdded(
      getInstanceExcludedList({ standalone, provider, paygRec, subRec }), name,
    );

    if (isPayg && paygRec) {
      const nextPayg = userPayg.map(p => {
        if (p.id !== paygRec.id) return p;
        const patch = {
          ...p,
          models: (p.models || []).filter(m => modelEntryName(m) !== name),
        };
        if (excluded_models.length) patch.excluded_models = excluded_models;
        else delete patch.excluded_models;
        return patch;
      });
      await persistModels(nextModels);
      await onSaveAccounts({
        user_payg_providers: nextPayg,
        ...(nextOverrides !== pricingOverrides ? { provider_pricing_overrides: nextOverrides } : {}),
      });
      return;
    }
    await persistModels(nextModels);
    const accountsPatch = nextOverrides !== pricingOverrides
      ? { provider_pricing_overrides: nextOverrides }
      : {};
    if (subRec) {
      accountsPatch.user_subscriptions = userSubscriptions.map(s => {
        if (s.id !== subRec.id) return s;
        const patch = {
          ...s,
          models: (s.models || []).filter(m => modelEntryName(m) !== name),
        };
        if (excluded_models.length) patch.excluded_models = excluded_models;
        else delete patch.excluded_models;
        return patch;
      });
      await onSaveAccounts(accountsPatch);
      return;
    }
    if (standalone) {
      onUpdate(provider.id, {
        models: nextModels,
        excluded_models: excluded_models.length ? excluded_models : undefined,
      });
      if (nextOverrides !== pricingOverrides) await onSaveAccounts({ provider_pricing_overrides: nextOverrides });
      return;
    }
    if (nextOverrides !== pricingOverrides) await onSaveAccounts(accountsPatch);
  }

  const hintKey = billingHintKey({ standalone, isPayg, modelTypeMap, modelNames })
    || (standalone ? 'providers.billing.standaloneHint'
    : billingTag === 'sub_to_api' ? 'providers.billing.subToApiHint'
    : 'providers.billing.subHint');

  const billingSummary = (() => {
    const parts = [];
    if (isSubBilling && monthly.trim()) parts.push(`$${monthly.trim()}${t('psrc.direct.monthlyUnit')}`);
    if (rows.length) parts.push(t('providers.billing.modelCount', { n: rows.length }));
    if (accountInst?.plan_label && !isSubBilling) parts.push(accountInst.plan_label);
    return parts.join(' · ') || null;
  })();

  return (
    <CollapsibleBillingPanel t={t} hint={t(hintKey)} summary={billingSummary} cooldown={cooldown} onRetryCooldown={onRetryCooldown}>
      {isSubBilling && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-zinc-500 dark:text-zinc-400">{t('providers.billing.subMonthly')}</label>
          <span className="text-xs text-zinc-400">$</span>
          <input type="text" inputMode="decimal" value={monthly} placeholder="0"
            onChange={e => setMonthly(e.target.value)}
            onBlur={saveMonthly}
            className="w-24 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 tabular-nums" />
          <span className="text-xs text-zinc-400">{t('psrc.direct.monthlyUnit')}</span>
          {accountInst?.plan_label && (
            <span className="text-xs text-zinc-400">· {accountInst.plan_label}</span>
          )}
        </div>
      )}
      {rows.length === 0 && (
        <p className="text-xs text-zinc-400 text-center py-1">{t('providers.billing.noModels')}</p>
      )}
      <PricingTable
        rows={rows}
        onCell={updatePricingCell}
        onAddModel={addModel}
        onRemoveModel={removeModel}
        withModality
        modelTypes={modelTypeMap}
        onToggleType={toggleModelType}
        t={t}
      />
    </CollapsibleBillingPanel>
  );
}

/** 供给源卡片内模型区；按量模型来自账户类型默认定价，可展开编辑 */
function ProviderModelSection({ provider, userPayg, onUpdate, scrollable = false, providerPricing = {}, paygCatalog = [], profileOnly = false }) {
  const { t } = useLang();
  const [modelsOpen, setModelsOpen] = useState(false);
  const isPayg = isPaygManagedProvider(provider.id, userPayg);
  const models = provider.models || [];
  const modelCount = models.length;
  const profileModels = useMemo(
    () => (isPayg ? buildPaygProfileModels(provider.id, userPayg, providerPricing, paygCatalog) : []),
    [isPayg, provider.id, userPayg, providerPricing, paygCatalog],
  );
  const suggestions = useMemo(
    () => (isPayg || profileOnly
      ? profileModels
      : buildModelSuggestions(provider.id, userPayg, providerPricing, paygCatalog)),
    [isPayg, profileOnly, provider.id, userPayg, providerPricing, paygCatalog, profileModels],
  );

  function handleModelsChange(next) {
    let out = next;
    if (isPayg || profileOnly) {
      const allowed = new Set(profileModels);
      out = next.map(normModel).filter(m => allowed.has(m.name));
    }
    onUpdate(provider.id, { models: out });
  }

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs text-zinc-500">{t('providers.models.list')}</span>
          {modelCount > 0
            ? <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40">{t('providers.models.count', { n: modelCount })}</span>
            : <span className="text-xs text-zinc-400">{t('providers.models.unlimited')}</span>
          }
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setModelsOpen(v => !v)}
            aria-expanded={modelsOpen}
            className="tb-press text-xs px-2.5 py-1 rounded-lg border border-zinc-300/80 dark:border-zinc-700 bg-white/50 dark:bg-zinc-800/60 backdrop-blur-sm text-zinc-600 dark:text-zinc-400 hover:bg-white/80 dark:hover:bg-zinc-700/80 transition-colors"
          >
            {modelsOpen ? t('providers.models.collapse') : t('providers.models.expand')}
          </button>
        </div>
      </div>
      {modelsOpen && (
        <>
          <ModelListEditor
            models={models}
            onChange={handleModelsChange}
            scrollable={scrollable}
            suggestions={suggestions}
            profileOnly={isPayg || profileOnly}
          />
          {(isPayg || profileOnly) && profileModels.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{t('providers.models.paygNoProfileModels')}</p>
          )}
        </>
      )}
    </div>
  );
}

/** 格式化测试反馈文案；失败保留至下次测试，成功 3s 后清除 */
function formatProviderTestMsg(result, t) {
  if (result?.ok) return { ok: true, msg: t('providers.test.success') };
  const detail = (result?.error && String(result.error).trim())
    || (result?.status ? `HTTP ${result.status}` : '');
  return {
    ok: false,
    msg: t('providers.test.failed', { detail: detail || t('providers.test.failedGeneric') }),
  };
}

/** 单行 code + 复制按钮（终端/端点/授权码用） */
function CodeCopy({ value, className = '' }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try { navigator.clipboard?.writeText(String(value)); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ }
  };
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <code className="font-mono text-[11px] px-1.5 py-0.5 rounded-md bg-white/55 dark:bg-zinc-900/45 border border-white/55 dark:border-white/10 text-zinc-700 dark:text-zinc-200">{value}</code>
      <button onClick={copy} title="复制" aria-label="复制"
        className="inline-flex items-center justify-center w-5 h-5 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-white/50 dark:hover:bg-white/10 transition">
        {copied ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        )}
      </button>
    </span>
  );
}

/**
 * ChatGPT 网页「单实例」卡：一张卡 = 一个 ChatGPT 账户(独立浏览器分区+端口)。
 * 用 provider.id(chatgpt-web-<n>) 调各自的 IPC；× 删除该实例；无开关(加/删即启停)。
 */
function ChatGptCard({ provider, onRemove }) {
  const api = (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.chatgptWeb) || null;
  const instId = provider.id;
  const n = provider.chatgpt_web_instance || (/(\d+)$/.exec(instId) || [])[1] || '';
  const [st, setSt] = useState({ running: false, loggedIn: false, port: null });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const modelName = (m) => (typeof m === 'string' ? m : (m && (m.name || m.id)) || '');
  const webModels = (provider.models || []).map(modelName).filter(Boolean);

  const refresh = useCallback(async () => {
    if (!api) return;
    try { setSt(await api.status(instId)); } catch { /* ignore */ }
  }, [api, instId]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const doLogin = async () => {
    if (!api) return;
    setBusy('login'); setMsg('');
    try { await api.login(instId); await refresh(); } catch (e) { setMsg('✗ ' + (e.message || 'login failed')); }
    setBusy('');
  };
  const doTest = async () => {
    if (!api) return;
    setBusy('test'); setMsg('');
    try {
      const r = await api.test(instId);
      setMsg(r.ok ? '✓ ' + (r.text || 'ok') : '✗ ' + (r.message || r.code || 'failed'));
    } catch (e) { setMsg('✗ ' + (e.message || 'error')); }
    setBusy(''); refresh();
  };

  const btnPrimary = 'inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-blue-600 dark:text-blue-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors';
  const btnGhost = 'inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors';

  return (
    <div className="tb-soft-tile rounded-2xl overflow-hidden">
      <div className="p-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl flex items-center justify-center text-lg shrink-0 bg-gradient-to-br from-amber-400/25 to-orange-500/20 border border-white/50 dark:border-white/10 shadow-sm">🌐</div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">ChatGPT 网页 {n}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">实验性</span>
            </div>
            <div className="text-[11px] text-zinc-400 mt-0.5">账户 {n} · 独立登录会话</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full ${st.loggedIn ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400' : 'bg-zinc-500/10 text-zinc-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${st.loggedIn ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
              {st.loggedIn ? '已登录' : '未登录'}
            </span>
            <button onClick={() => onRemove && onRemove(instId)} title="删除该账户实例"
              className="text-zinc-400 hover:text-red-500 dark:hover:text-red-400 text-lg leading-none transition-colors">×</button>
          </div>
        </div>

        <div className="mt-3 space-y-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={doLogin} disabled={busy === 'login'} className={btnPrimary}>
              {busy === 'login' ? '打开登录窗口…' : (st.loggedIn ? '重新登录' : '登录 ChatGPT')}
            </button>
            <button onClick={doTest} disabled={busy === 'test' || !st.running} className={btnGhost} title={!st.running ? '启动中' : '测试'}>
              {busy === 'test' ? '测试中…' : '测试'}
            </button>
            {msg && <span className={`text-[11px] ${msg.startsWith('✓') ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>{msg}</span>}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>本地端点</span>
            {st.running ? <CodeCopy value={`http://127.0.0.1:${st.port}`} /> : <span className="text-zinc-400">启动中…</span>}
          </div>
          {webModels.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              <span className="text-[10px] text-zinc-400 mr-0.5">模型</span>
              {webModels.map(m => (
                <span key={m} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-700 dark:text-amber-300">{m}</span>
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-snug text-amber-700/85 dark:text-amber-300/75">
          <svg className="shrink-0 mt-0.5" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          <span>浏览器自动化·非官方 API，仅登录你自己的会话、供个人自用；把订阅当 API 可能违反 ChatGPT 使用条款，风险自担。</span>
        </div>
      </div>
    </div>
  );
}

function CustomProviderCard({ provider, onUpdate, onRemove, onTest, onSilentPersist, onPersistEnabled, userPayg = [], userSubscriptions = [], onEditPricing, providerPricing = {}, paygCatalog = [], accountInst = null, pricingOverrides = {}, onSaveAccounts, onOverridesChange, onPersistModels, onPersistTier, cooldown = null, onRetryCooldown = null }) {
  const { t } = useLang();
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const testClearTimer = useRef(null);
  // API Key 本地草稿：失焦静默落盘，不走 onUpdate（避免整表 setProviders 闪动）
  const [tokenDraft, setTokenDraft] = useState(() => provider.token || '');
  const tokenFocusedRef = useRef(false);
  useEffect(() => {
    if (!tokenFocusedRef.current) setTokenDraft(provider.token || '');
  }, [provider.id, provider.token]);

  function commitTokenDraft() {
    tokenFocusedRef.current = false;
    const next = tokenDraft || '';
    if (next === (provider.token || '')) return;
    if (onSilentPersist) onSilentPersist(provider.id, { token: next });
    else onUpdate(provider.id, { token: next });
  }

  // API 订阅（如 Volcengine）走本卡：需把 plan_provider_id 映射到 usage 抓取键
  const usageProvider = (() => {
    const pid = accountInst?.plan_provider_id || accountInst?.source_id || provider.id;
    if (pid && pid !== provider.id) return { ...provider, id: pid };
    return provider;
  })();
  const isVolcCustom = (() => {
    const id = String(usageProvider?.id || provider?.id || '').toLowerCase();
    const sid = String(accountInst?.source_id || '').toLowerCase();
    return id === 'volcengine' || id === 'api-volcengine' || id === 'volcengine-ark'
      || sid === 'api-volcengine' || sid === 'volcengine-ark' || sid.includes('volc');
  })();
  const isVolcPayg = (() => {
    const id = String(usageProvider?.id || provider?.id || '').toLowerCase();
    const sid = String(accountInst?.source_id || '').toLowerCase();
    const base = String(provider?.base_url || '').toLowerCase();
    return id === 'volcengine-ark' || sid === 'volcengine-ark'
      || (/ark\.cn-beijing\.volces\.com/.test(base) && /\/api\/v3/.test(base) && !/\/coding\//.test(base));
  })();
  const [akDraft, setAkDraft] = useState(() => provider.credentials?.access_key_id || '');
  const [skDraft, setSkDraft] = useState(() => provider.credentials?.secret_access_key || '');
  useEffect(() => {
    setAkDraft(provider.credentials?.access_key_id || '');
    setSkDraft(provider.credentials?.secret_access_key || '');
  }, [provider.id, provider.credentials?.access_key_id, provider.credentials?.secret_access_key]);

  function commitVolcAkSk() {
    if (!isVolcCustom) return;
    const ak = (akDraft || '').trim();
    const sk = (skDraft || '').trim();
    const prevAk = provider.credentials?.access_key_id || '';
    const prevSk = provider.credentials?.secret_access_key || '';
    if (ak === prevAk && sk === prevSk) return;
    const credentials = {
      ...(provider.credentials || {}),
      access_key_id: ak || undefined,
      secret_access_key: sk || undefined,
    };
    if (!ak) delete credentials.access_key_id;
    if (!sk) delete credentials.secret_access_key;
    if (onSilentPersist) onSilentPersist(provider.id, { credentials });
    else onUpdate(provider.id, { credentials });
  }

  const displayLabel = provider.displayName || provider.label || (() => {
    try { const h = new URL(provider.base_url || '').hostname; return h || t('providers.custom.defaultName'); } catch { return t('providers.custom.defaultName'); }
  })();
  const personalTag = getPersonalSourceTag(provider, {}, userPayg, userSubscriptions);
  const tierEditable = personalTag === 'free' || personalTag === 'payg';

  async function handleTest() {
    if (!provider.base_url) { setTestMsg(t('providers.test.needBaseUrl')); return; }
    // Ollama 本地实例无需 API Key，直接探测连通性
    const ollama = isOllamaProvider(provider);
    // 优先用输入框草稿；点「测试」时先落盘，避免失焦竞态读到空的 provider.token
    const key = (tokenDraft || provider.token || '').trim();
    if (!ollama && !key && provider.auth_type !== 'oauth') {
      setTestMsg(t('providers.test.needToken'));
      return;
    }
    if (!ollama) commitTokenDraft();
    setTesting(true);
    if (testClearTimer.current) clearTimeout(testClearTimer.current);
    setTestMsg('');
    try {
      const result = await onTest({ ...provider, token: ollama ? '' : (key || provider.token) });
      if (result.ok) onUpdate(provider.id, { test_verified: true });
      else onUpdate(provider.id, { test_verified: false });
      const { ok, msg } = formatProviderTestMsg(result, t);
      setTestMsg(msg);
      if (ok) testClearTimer.current = setTimeout(() => setTestMsg(''), 3000);
    } catch (e) {
      onUpdate(provider.id, { test_verified: false });
      setTestMsg(t('providers.test.failed', { detail: e.message || t('providers.err.unknown') }));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={`tb-soft-tile rounded-2xl overflow-hidden ${provider.enabled === false ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3 p-4">
        <ServiceIcon
          id={accountInst?.source_id || provider.id}
          name={displayLabel}
          icon="🔗"
          baseUrl={provider.base_url}
          boxClass="w-9 h-9 !rounded-xl !bg-zinc-100/70 dark:!bg-zinc-800/70 backdrop-blur-sm"
          imgClass="w-5 h-5"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium truncate text-zinc-800 dark:text-zinc-200">
                {displayLabel}
              </span>
              <StatusBadge verified={provider.test_verified === true} cooling={!!cooldown} />
              <PersonalSourceTypeBadge
                tag={personalTag}
                t={t}
                provider={provider}
                tierEditable={tierEditable}
                onTierChange={(tier) => (onPersistTier || ((id, t) => onUpdate(id, { type: t, tier: t })))(provider.id, tier)}
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Toggle
                enabled={provider.enabled !== false}
                onChange={() => {
                  const next = provider.enabled === false;
                  onUpdate(provider.id, { enabled: next });
                  onPersistEnabled?.(provider.id, next);
                }}
              />
              {provider.base_url && (
                <button onClick={handleTest} disabled={testing}
                  className="text-xs px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors">
                  {testing ? '…' : t('providers.common.test')}
                </button>
              )}
              <button onClick={() => onRemove(provider.id)}
                title={t('providers.custom.removeTitle')}
                className="text-zinc-400 hover:text-red-500 dark:hover:text-red-400 text-lg leading-none transition-colors">×</button>
            </div>
          </div>

          {testMsg && (
            <p className={`text-xs mt-1 ${testMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400 font-medium'}`} role={testMsg.startsWith('✓') ? undefined : 'alert'}>{testMsg}</p>
          )}

          {/* Base URL + Token inputs */}
          <div className="mt-3 space-y-2">
            <input
              value={provider.base_url || ''}
              onChange={e => onUpdate(provider.id, { base_url: e.target.value })}
              onBlur={e => {
                const v = e.target.value.replace(/\/v1\/?$/, '').replace(/\/$/, '');
                if (v !== e.target.value) onUpdate(provider.id, { base_url: v });
              }}
              placeholder={t('providers.custom.baseUrlPlaceholder')}
              className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-blue-500"
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">{t('providers.card.apiFormat')}</span>
              <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden text-xs">
                {['openai', 'anthropic', 'gemini'].map(fmt => (
                  <button key={fmt}
                    onClick={() => onUpdate(provider.id, { api_format: fmt })}
                    className={(provider.api_format || 'openai') === fmt
                      ? 'px-2.5 py-1 bg-blue-600 text-white'
                      : 'px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'}>
                    {t(`providers.card.apiFormat${fmt.charAt(0).toUpperCase() + fmt.slice(1)}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-2">
              <input
                value={tokenDraft}
                onChange={e => setTokenDraft(e.target.value)}
                onFocus={() => { tokenFocusedRef.current = true; }}
                onBlur={commitTokenDraft}
                type={showKey ? 'text' : 'password'}
                placeholder={t('providers.custom.apiKeyOptional')}
                autoComplete="off"
                className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-blue-500"
              />
              <button type="button" onClick={() => setShowKey(v => !v)}
                className="shrink-0 px-2.5 text-xs rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors">
                {showKey ? t('providers.common.hide') : t('providers.common.show')}
              </button>
            </div>
            {/* 火山：AccessKey + 订阅额度同卡；额度条默认展开 */}
            {isVolcCustom ? (
              <UsageMeter
                provider={usageProvider}
                planHint={accountInst?.plan_label || null}
                defaultOpen
                accessKey={{
                  ak: akDraft,
                  sk: skDraft,
                  showSecret: showKey,
                  onAkChange: setAkDraft,
                  onSkChange: setSkDraft,
                  onCommit: commitVolcAkSk,
                  emptyHint: isVolcPayg
                    ? '填写 AccessKey 以查询按量余额'
                    : '填写 AccessKey 以查询 Coding Plan 额度',
                }}
              />
            ) : (
              <UsageMeter
                provider={usageProvider}
                planHint={accountInst?.plan_label || null}
              />
            )}
          </div>
        </div>
      </div>

      {/* 计费 / 模型列表 */}
      {onSaveAccounts && (
        (accountInst && ['payg', 'api_sub', 'sub_to_api'].includes(accountInst.tag)) || !accountInst
      ) ? (
        <ProviderCardBillingSection
          billingTag={accountInst?.tag || 'payg'}
          accountInst={accountInst}
          provider={provider}
          userPayg={userPayg}
          userSubscriptions={userSubscriptions}
          providerPricing={providerPricing}
          pricingOverrides={pricingOverrides}
          onSaveAccounts={onSaveAccounts}
          onOverridesChange={onOverridesChange}
          onUpdate={onUpdate}
          onPersistModels={onPersistModels}
          standalone={!accountInst}
          paygCatalog={paygCatalog}
          cooldown={cooldown}
          onRetryCooldown={onRetryCooldown}
          t={t}
        />
      ) : accountInst ? (
        <ProviderModelSection
          provider={provider}
          userPayg={userPayg}
          onUpdate={onUpdate}
          scrollable
          providerPricing={providerPricing}
          paygCatalog={paygCatalog}
        />
      ) : null}
    </div>
  );
}

// 订阅额度 / 用量条见 components/UsageMeter.jsx（供给源卡与直连 App 订阅卡共用）

/** Agnes：按 base_url 区分中国站 / 国际站，标签展示在链接后 */
function agnesSiteLabel(provider) {
  const id = String(provider?.id || '').toLowerCase();
  const base = String(provider?.base_url || '').toLowerCase();
  if (!(id.includes('agnes') || /agnes-ai\.(com|cn)/.test(base))) return null;
  if (/\.cn(\/|$|:)/.test(base) || base.includes('agnes-ai.cn')) return '中国站';
  if (base.includes('agnes-ai.com') || !base) return '国际站';
  return null;
}

function ProviderCard({ provider, meta, onUpdate, onRemove, onTest, onSilentPersist, onPersistEnabled, initialExpanded = false, gatewayAuthMode = null, userPayg = [], userSubscriptions = [], onEditPricing, providerPricing = {}, paygCatalog = [], subscriptionCatalog = [], displayName = null, displayIcon = null, lockTemplate = false, accountInst = null, pricingOverrides = {}, onSaveAccounts, onOverridesChange, onPersistModels, onPersistBaseUrl, onPersistTier, cooldown = null, onRetryCooldown = null }) {
  const { t } = useLang();
  const [showKey,    setShowKey]    = useState(false);
  const [expanded,   setExpanded]   = useState(initialExpanded);
  const [testing,    setTesting]    = useState(false);
  const [testMsg,    setTestMsg]    = useState('');
  const testClearTimer = useRef(null);
  // API Key 本地草稿：失焦静默落盘，不走 onUpdate
  const [tokenDraft, setTokenDraft] = useState(() => provider.token || '');
  const [tokenEditing, setTokenEditing] = useState(false);
  const tokenFocusedRef = useRef(false);
  useEffect(() => {
    if (!tokenFocusedRef.current) setTokenDraft(provider.token || '');
  }, [provider.id, provider.token]);

  function commitTokenDraft() {
    tokenFocusedRef.current = false;
    const next = tokenDraft || '';
    if (next !== (provider.token || '')) {
      if (onSilentPersist) onSilentPersist(provider.id, { token: next, auth_type: 'api_key' });
      else onUpdate(provider.id, { token: next, auth_type: 'api_key' });
    }
    setTokenEditing(false);
  }

  // 火山 Coding Plan / 按量余额查询用 AccessKey（与推理 API Key 不同）
  const isVolcengine = provider.id === 'volcengine' || provider.id === 'api-volcengine'
    || provider.id === 'volcengine-ark'
    || accountInst?.plan_provider_id === 'volcengine'
    || accountInst?.source_id === 'api-volcengine'
    || accountInst?.source_id === 'volcengine-ark';
  const isVolcPayg = provider.id === 'volcengine-ark'
    || accountInst?.source_id === 'volcengine-ark'
    || (() => {
      const base = String(provider.base_url || '').toLowerCase();
      return /ark\.cn-beijing\.volces\.com/.test(base) && /\/api\/v3/.test(base) && !/\/coding\//.test(base);
    })();
  const agnesSite = agnesSiteLabel(provider);
  const [akDraft, setAkDraft] = useState(() => provider.credentials?.access_key_id || '');
  const [skDraft, setSkDraft] = useState(() => provider.credentials?.secret_access_key || '');
  useEffect(() => {
    setAkDraft(provider.credentials?.access_key_id || '');
    setSkDraft(provider.credentials?.secret_access_key || '');
  }, [provider.id, provider.credentials?.access_key_id, provider.credentials?.secret_access_key]);

  function commitVolcAkSk() {
    if (!isVolcengine) return;
    const ak = (akDraft || '').trim();
    const sk = (skDraft || '').trim();
    const prevAk = provider.credentials?.access_key_id || '';
    const prevSk = provider.credentials?.secret_access_key || '';
    if (ak === prevAk && sk === prevSk) return;
    const credentials = {
      ...(provider.credentials || {}),
      access_key_id: ak || undefined,
      secret_access_key: sk || undefined,
    };
    if (!ak) delete credentials.access_key_id;
    if (!sk) delete credentials.secret_access_key;
    if (onSilentPersist) onSilentPersist(provider.id, { credentials });
    else onUpdate(provider.id, { credentials });
  }

  meta = meta || {};
  const isP2P    = provider.type === 'p2p';
  const isSubToApiInst = accountInst?.tag === 'sub_to_api';
  const oauthCap = meta.oauth || null;                 // 该预设支持的 OAuth 登录（可选）
  const forceOauth  = gatewayAuthMode === 'oauth' || isSubToApiInst;
  const forceApiKey = gatewayAuthMode === 'api_key';
  const isOauthCfg = forceOauth || provider.auth_type === 'oauth';
  const hasOauth = !!(provider.credentials && provider.credentials.refresh_token);
  // 草稿也算已填 Key（静默保存不推父级时仍能正确显示配置态）
  const hasKey   = !isOauthCfg && !!(tokenDraft || provider.token);
  const billingType    = forceApiKey ? 'api-key' : (provider.billing_type || 'api-key');
  const subMode        = isSubToApiInst ? 'api-proxy' : (forceOauth ? 'api-proxy' : (provider.sub_mode || 'accounting'));
  const isSubscription = forceOauth || isSubToApiInst || billingType === 'subscription';
  // 付费层：订阅转 API 走 OAuth；按量 / API 订阅走 API Key
  const configured = forceOauth
    ? hasOauth
    : forceApiKey
      ? hasKey
      : ((meta.keyless && !oauthCap) || hasKey || hasOauth || (isSubscription && subMode === 'accounting'));
  const canApiKey = !meta.keyless && !forceOauth && !isSubToApiInst;
  const showOauthUi = (forceOauth || isSubToApiInst) ? !!oauthCap : (oauthCap && (!forceApiKey));
  const showApiKeyUi = !forceOauth && !isSubToApiInst && (forceApiKey || canApiKey);
  // 是否支持订阅计费方式：yaml subscription_apps 中有 plan_provider_id 匹配且 subscription_to_api=true
  const hasSubscriptionOption = subscriptionCatalog.some(c => c.plan_provider_id === provider.id && c.subscription_to_api === true);
  const personalTag = getPersonalSourceTag(provider, { [provider.id]: meta }, userPayg, userSubscriptions);
  const tierEditable = !isP2P && (personalTag === 'free' || personalTag === 'payg');
  // 正在编辑 Key 时保持展开表单，避免首字符后 configured=true 立刻折叠
  const showSetupPanel = !isP2P && (showApiKeyUi || showOauthUi) && (!configured || expanded || tokenEditing);

  // 添加方式：api_key / oauth（按量可切换；订阅转 API 固定 OAuth）
  const [method, setMethod] = useState(forceOauth || isOauthCfg ? 'oauth' : 'api_key');
  const [oauth, setOauth] = useState({ sessionId: '', code: '', busy: false, msg: '', started: false, mode: '', userCode: '' });
  const pollRef = useRef(false);

  function resetOauth() { setOauth({ sessionId: '', code: '', busy: false, msg: '', started: false, mode: '', userCode: '' }); }

  function saveOauthCreds(r) {
    onUpdate(provider.id, {
      auth_type: 'oauth', oauth_provider: r.oauth_provider,
      credentials: r.credentials, token: '', enabled: true,
    });
    resetOauth();
    setExpanded(false);
  }

  async function startOauth() {
    if (!oauthCap) return;
    setOauth(o => ({ ...o, busy: true, msg: '' }));
    try {
      const api = getOauth();
      const r = await api.start(oauthCap.provider, {});
      if (r.mode === 'device' || r.mode === 'loopback') {
        const openUrl = r.verificationUrl || r.authUrl;
        if (openUrl) await api.openExternal(openUrl);
        setOauth(o => ({ ...o, busy: false, started: true, mode: r.mode, sessionId: r.sessionId, userCode: r.userCode || '' }));
        pollRef.current = true;
        pollDevice(r.sessionId);
      } else if (r.mode === 'paste') {
        setOauth(o => ({ ...o, busy: false, started: true, mode: 'paste', sessionId: r.sessionId }));
      } else {
        if (r.authUrl) await api.openExternal(r.authUrl);
        setOauth(o => ({ ...o, busy: false, started: true, mode: 'pkce', sessionId: r.sessionId }));
      }
    } catch (e) { setOauth(o => ({ ...o, busy: false, msg: e.message || t('providers.err.loginFailed') })); }
  }

  async function pollDevice(sessionId) {
    const api = getOauth();
    for (let i = 0; i < 60 && pollRef.current; i++) {
      await new Promise(res => setTimeout(res, 5000));
      if (!pollRef.current) return;
      let r;
      try { r = await api.poll(sessionId); }
      catch (e) { pollRef.current = false; setOauth(o => ({ ...o, msg: e.message || t('providers.err.pollFailed'), started: false })); return; }
      if (r.done) { pollRef.current = false; saveOauthCreds(r); return; }
    }
  }

  // pkce 粘贴 code / paste 粘贴凭证：都走 exchange
  async function finishOauth() {
    setOauth(o => ({ ...o, busy: true, msg: '' }));
    try {
      const r = await getOauth().exchange(oauth.sessionId, oauth.code.trim());
      saveOauthCreds(r);
    } catch (e) { setOauth(o => ({ ...o, busy: false, msg: e.message || t('providers.err.exchangeFailed') })); }
  }

  function cancelOauth() { pollRef.current = false; resetOauth(); }

  function clearOauth() {
    pollRef.current = false;
    onUpdate(provider.id, { auth_type: 'api_key', oauth_provider: '', credentials: null });
    setMethod('api_key');
  }

  async function handleTest() {
    if (!provider.base_url) { setTestMsg(t('providers.test.needBaseUrl')); return; }
    // Ollama 本地实例无需 API Key，直接探测连通性
    const ollama = isOllamaProvider(provider);
    // 优先用输入框草稿；点「测试」时先落盘，避免失焦竞态读到空的 provider.token
    const key = (tokenDraft || provider.token || '').trim();
    if (!ollama && !key && provider.auth_type !== 'oauth') {
      setTestMsg(t('providers.test.needToken'));
      return;
    }
    if (!ollama) commitTokenDraft();
    setTesting(true);
    if (testClearTimer.current) clearTimeout(testClearTimer.current);
    setTestMsg('');
    try {
      const result = await onTest({ ...provider, token: ollama ? '' : (key || provider.token) });
      if (result.ok) onUpdate(provider.id, { test_verified: true });
      else onUpdate(provider.id, { test_verified: false });
      const { ok, msg } = formatProviderTestMsg(result, t);
      setTestMsg(msg);
      if (ok) testClearTimer.current = setTimeout(() => setTestMsg(''), 3000);
    } catch (e) {
      onUpdate(provider.id, { test_verified: false });
      setTestMsg(t('providers.test.failed', { detail: e.message || t('providers.err.unknown') }));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={`tb-soft-tile rounded-2xl overflow-hidden ${provider.enabled === false ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-3 p-3.5">
        {/* Icon：本地品牌 / 供给源 logo，失败回退 emoji */}
        <ServiceIcon
          id={accountInst?.source_id || accountInst?.provider_id || provider.id}
          name={displayName || meta.label}
          icon={displayIcon || meta.icon}
          baseUrl={provider.base_url}
          signupUrl={meta.signup_url}
          boxClass="w-8 h-8 !bg-zinc-100/70 dark:!bg-zinc-800/70 backdrop-blur-sm mt-0.5"
          imgClass="w-5 h-5"
        />
        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                {displayName || meta.label}
              </span>
              {/* 账户登记的套餐名（静态）；实时订阅档位见下方 UsageMeter 徽章 */}
              {accountInst?.plan_label && (
                <span className="text-[11px] px-1.5 py-0.5 rounded-md bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/50 truncate max-w-[8rem]">
                  {accountInst.plan_label}
                </span>
              )}
              <StatusBadge verified={provider.test_verified === true} cooling={!!cooldown} />
              <PersonalSourceTypeBadge
                tag={personalTag}
                t={t}
                provider={provider}
                tierEditable={tierEditable}
                onTierChange={(tier) => (onPersistTier || ((id, t) => onUpdate(id, { type: t, tier: t })))(provider.id, tier)}
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {!isP2P && (
                <Toggle
                  enabled={provider.enabled !== false}
                  onChange={() => {
                    const next = provider.enabled === false;
                    onUpdate(provider.id, { enabled: next });
                    onPersistEnabled?.(provider.id, next);
                  }}
                />
              )}
              {!isP2P && (
                <button onClick={handleTest} disabled={testing}
                  className="text-xs px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors">
                  {testing ? '…' : t('providers.common.test')}
                </button>
              )}
              {!isP2P && onRemove && (
                <button onClick={() => onRemove(provider.id)}
                  title={t('providers.custom.removeTitle')}
                  className="text-zinc-400 hover:text-red-500 dark:hover:text-red-400 text-lg leading-none transition-colors">×</button>
              )}
            </div>
          </div>

          {/* Hint / status text */}
          {testMsg ? (
            <p className={`text-xs mt-1 ${testMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400 font-medium'}`} role={testMsg.startsWith('✓') ? undefined : 'alert'}>{testMsg}</p>
          ) : (
            <p className="text-xs text-zinc-500 mt-1">
              {forceOauth ? t('providers.card.hint.oauth') : forceApiKey ? t('providers.card.hint.apiKey') : meta.hint}
            </p>
          )}

          {/* Configured (collapsed) row */}
          {!isP2P && !(meta.keyless && !oauthCap) && configured && !expanded && !tokenEditing && (
            <div className="mt-2 space-y-1">
              <div className="flex items-center gap-2">
                {isSubscription ? (
                  <code className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 px-2 py-1 rounded font-mono">
                    {t('providers.card.sub')}{subMode === 'accounting' ? t('providers.card.subAccounting') : t('providers.card.subApiProxy')}
                  </code>
                ) : isOauthCfg ? (
                  <code className="text-xs text-purple-600 dark:text-purple-300 bg-purple-50 dark:bg-purple-900/30 px-2 py-1 rounded font-mono">
                    {t('providers.card.loggedIn')}{provider.credentials?.email ? ' · ' + provider.credentials.email : ''}
                  </code>
                ) : (
                  <code className="text-xs text-zinc-500 bg-zinc-100 dark:bg-zinc-800 px-2 py-1 rounded font-mono">
                    {hasKey ? provider.token.slice(0, 4) + '•'.repeat(12) : t('providers.card.notConfigured')}
                  </code>
                )}
                <button onClick={() => { setExpanded(true); setMethod(isOauthCfg ? 'oauth' : 'api_key'); }} className="text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-300">{t('providers.common.edit')}</button>
              </div>
              {provider.base_url && (
                <p className="text-xs text-zinc-400 dark:text-zinc-600 font-mono break-all">
                  {provider.base_url}
                  {agnesSite && (
                    <span className="ml-1.5 inline-block align-middle font-sans not-italic text-[11px] px-1.5 py-0.5 rounded-md bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/50">
                      {agnesSite}
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Inline setup / edit panel */}
          {showSetupPanel && (
            <div className="mt-3 space-y-2">
              {/* 计费方式切换（转API）：模板锁定时只读，由模板的「能否转API」决定 */}
              {hasSubscriptionOption && canApiKey && !forceOauth && !forceApiKey && !lockTemplate && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">{t('providers.card.billingMode')}</span>
                  <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden text-xs">
                    <button onClick={() => onUpdate(provider.id, { billing_type: 'api-key' })}
                      className={billingType === 'api-key' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}>API Key</button>
                    <button onClick={() => onUpdate(provider.id, { billing_type: 'subscription' })}
                      className={isSubscription ? 'px-3 py-1 bg-amber-500 text-white' : 'px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}>{t('providers.card.subscription')}</button>
                  </div>
                </div>
              )}

              {/* 订阅接入方式（转API/仅记账）：模板锁定时只读 */}
              {isSubscription && !forceApiKey && !forceOauth && oauthCap && !lockTemplate && (
                <div className="space-y-2 pl-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500 shrink-0">{t('providers.card.accessMode')}</span>
                    <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden text-xs">
                      <button onClick={() => onUpdate(provider.id, { sub_mode: 'accounting' })}
                        className={subMode === 'accounting' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}>{t('providers.card.accountingOnly')}</button>
                      <button onClick={() => onUpdate(provider.id, { sub_mode: 'api-proxy' })}
                        className={subMode === 'api-proxy' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}>{t('providers.card.subToApi')}</button>
                    </div>
                  </div>
                  {subMode === 'accounting' && (
                    <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('providers.card.accountingHint')}</p>
                  )}
                </div>
              )}

              {/* API Key / OAuth 切换（同时登记订阅与按量时） */}
              {!isSubscription && canApiKey && oauthCap && !forceOauth && !forceApiKey && (
                <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden text-xs">
                  <button onClick={() => setMethod('api_key')}
                    className={method === 'api_key' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}>API Key</button>
                  <button onClick={() => setMethod('oauth')}
                    className={method === 'oauth' ? 'px-3 py-1 bg-blue-600 text-white' : 'px-3 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'}>{oauthCap.label}</button>
                </div>
              )}

              {/* API Key 方式 */}
              {showApiKeyUi && !isSubscription && (!oauthCap || method === 'api_key' || forceApiKey) && (
                <>
                  <div className="flex gap-2">
                    <input
                      value={tokenDraft}
                      onChange={e => {
                        setTokenDraft(e.target.value);
                        setExpanded(true);
                      }}
                      onFocus={() => {
                        tokenFocusedRef.current = true;
                        setTokenEditing(true);
                        setExpanded(true);
                      }}
                      onBlur={commitTokenDraft}
                      type={showKey ? 'text' : 'password'}
                      placeholder={t('providers.card.pasteApiKey')}
                      autoComplete="off"
                      className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                    />
                    <button type="button" onClick={() => setShowKey(v => !v)}
                      className="shrink-0 px-2.5 text-xs rounded-lg border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors">
                      {showKey ? t('providers.common.hide') : t('providers.common.show')}
                    </button>
                  </div>
                  <div className="flex items-center gap-3">
                    {meta.signup_url && (
                      <a href={meta.signup_url} target="_blank" rel="noreferrer"
                        className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{meta.getKeyLabel || t('providers.card.getKey')}</a>
                    )}
                  </div>
                </>
              )}

              {/* OAuth 订阅登录 */}
              {showOauthUi && (!canApiKey || method === 'oauth' || (isSubscription && subMode === 'api-proxy') || forceOauth) && (
                <div className="space-y-2">
                  {forceOauth && !oauthCap && (
                    <p className="text-xs text-amber-600 dark:text-amber-400">{t('providers.card.oauthUnsupported')}</p>
                  )}
                  {hasOauth && (
                    <p className="text-xs text-green-600 dark:text-green-400">
                      {t('providers.card.oauthLoggedIn')}{provider.credentials?.email ? ' · ' + provider.credentials.email : ''}
                      <button onClick={clearOauth} className="ml-2 text-zinc-500 hover:text-red-500">{t('providers.card.logout')}</button>
                    </p>
                  )}
                  {!oauth.started && (
                    <button onClick={startOauth} disabled={oauth.busy}
                      className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-blue-600 dark:text-blue-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50">
                      {oauth.busy ? '…' : (hasOauth ? t('providers.card.relogin') : t('providers.card.login', { label: oauthCap?.label || 'OAuth' }))}
                    </button>
                  )}

                  {/* 设备码流（Codex / Copilot）+ loopback 流（Gemini）：自动轮询完成 */}
                  {oauth.started && (oauth.mode === 'device' || oauth.mode === 'loopback') && (
                    <div className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1">
                      {oauth.userCode ? (
                        <>
                          <p>{t('providers.card.deviceCodeHint')}</p>
                          <p className="font-mono text-base tracking-widest text-blue-600 dark:text-blue-400 select-all">{oauth.userCode}</p>
                        </>
                      ) : (
                        <p>{t('providers.card.browserAuthHint')}</p>
                      )}
                      <p className="text-zinc-400">{t('providers.card.autoLoginHint')}<button onClick={cancelOauth} className="ml-2 text-zinc-500 hover:text-red-500">{t('providers.common.cancel')}</button></p>
                    </div>
                  )}

                  {/* PKCE 流（Claude）：粘贴回调 code */}
                  {oauth.started && oauth.mode === 'pkce' && (
                    <div className="flex gap-2">
                      <input value={oauth.code} onChange={e => setOauth(o => ({ ...o, code: e.target.value }))}
                        placeholder={t('providers.card.codePlaceholder')}
                        className="flex-1 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-500" />
                      <button onClick={finishOauth} disabled={oauth.busy || !oauth.code.trim()}
                        className="shrink-0 px-3 text-xs rounded-lg bg-blue-600 text-white disabled:opacity-50">{t('providers.card.finishStep')}</button>
                    </div>
                  )}

                  {/* 粘贴流（Gemini）：粘贴 ya29 token 或 oauth_creds.json */}
                  {oauth.started && oauth.mode === 'paste' && (
                    <div className="space-y-2">
                      <textarea value={oauth.code} onChange={e => setOauth(o => ({ ...o, code: e.target.value }))}
                        placeholder={t('providers.card.pasteTokenPlaceholder')} rows={3}
                        className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm font-mono focus:outline-none focus:border-blue-500" />
                      <button onClick={finishOauth} disabled={oauth.busy || !oauth.code.trim()}
                        className="px-3 py-1 text-xs rounded-lg bg-blue-600 text-white disabled:opacity-50">{t('providers.card.finish')}</button>
                    </div>
                  )}

                  {oauth.msg && <p className="text-xs text-red-500">{oauth.msg}</p>}
                </div>
              )}

              {/* Base URL override */}
              <div className="space-y-1">
                <label className="text-xs text-zinc-500 dark:text-zinc-400">Base URL</label>
                <input
                  value={provider.base_url || ''}
                  onChange={e => onUpdate(provider.id, { base_url: e.target.value })}
                  onBlur={e => onPersistBaseUrl?.(provider.id, e.target.value)}
                  type="text"
                  placeholder={t('providers.card.defaultBaseUrl')}
                  autoComplete="off"
                  className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-blue-500"
                />
                {provider.base_url && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">{t('providers.card.apiFormat')}</span>
                    <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden text-xs">
                      {['openai', 'anthropic', 'gemini'].map(fmt => (
                        <button key={fmt}
                          onClick={() => onUpdate(provider.id, { api_format: fmt })}
                          className={(provider.api_format || 'openai') === fmt
                            ? 'px-2.5 py-1 bg-blue-600 text-white'
                            : 'px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700'}>
                          {t(`providers.card.apiFormat${fmt.charAt(0).toUpperCase() + fmt.slice(1)}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {expanded && (
                <button onClick={() => setExpanded(false)} className="text-xs text-zinc-600 hover:text-zinc-600 dark:text-zinc-400">{t('providers.common.cancel')}</button>
              )}
            </div>
          )}

          {/* 订阅额度：折叠/展开都显示；火山卡把 AccessKey 并入同卡且额度默认展开 */}
          {!isP2P && configured && (
            isVolcengine ? (
              <UsageMeter
                provider={(() => {
                  // API 订阅卡：凭证在 plan_provider_id（volcengine）网关条目上
                  const pid = accountInst?.plan_provider_id || provider.id;
                  return pid && pid !== provider.id ? { ...provider, id: pid } : provider;
                })()}
                planHint={accountInst?.plan_label || null}
                defaultOpen
                accessKey={{
                  ak: akDraft,
                  sk: skDraft,
                  showSecret: showKey,
                  onAkChange: setAkDraft,
                  onSkChange: setSkDraft,
                  onCommit: commitVolcAkSk,
                  emptyHint: isVolcPayg
                    ? '填写 AccessKey 以查询按量余额'
                    : '填写 AccessKey 以查询 Coding Plan 额度',
                }}
              />
            ) : (
              <UsageMeter
                provider={(() => {
                  const pid = accountInst?.plan_provider_id || provider.id;
                  return pid && pid !== provider.id ? { ...provider, id: pid } : provider;
                })()}
                planHint={accountInst?.plan_label || null}
              />
            )
          )}

          {/* P2P info */}
          {isP2P && (
            <p className="text-xs text-zinc-500 mt-1">
              {t('providers.p2p.creditsHint')}
            </p>
          )}
        </div>
      </div>

      {/* 计费 / 模型列表：账户实例或独立供给源（无账户实例时默认定价 0） */}
      {!isP2P && onSaveAccounts && (
        (accountInst && ['payg', 'api_sub', 'sub_to_api'].includes(accountInst.tag)) || !accountInst
      ) ? (
        <ProviderCardBillingSection
          billingTag={accountInst?.tag || 'payg'}
          accountInst={accountInst}
          provider={provider}
          userPayg={userPayg}
          userSubscriptions={userSubscriptions}
          providerPricing={providerPricing}
          pricingOverrides={pricingOverrides}
          onSaveAccounts={onSaveAccounts}
          onOverridesChange={onOverridesChange}
          onUpdate={onUpdate}
          onPersistModels={onPersistModels}
          standalone={!accountInst}
          paygCatalog={paygCatalog}
          cooldown={cooldown}
          onRetryCooldown={onRetryCooldown}
          t={t}
        />
      ) : !isP2P && accountInst ? (
        <ProviderModelSection
          provider={provider}
          userPayg={userPayg}
          onUpdate={onUpdate}
          scrollable
          providerPricing={providerPricing}
          paygCatalog={paygCatalog}
          profileOnly={lockTemplate && isPaygManagedProvider(provider.id, userPayg)}
        />
      ) : null}
    </div>
  );
}


export default function Providers() {
  const { t } = useLang();
  const navigate = useNavigate();
  const tierConfig = useMemo(() => getTierConfig(t), [t]);
  const oauthById = useMemo(() => getOAuthById(t), [t]);
  const [providers, setProviders] = useState(FALLBACK_PROVIDERS);
  const [meta,      setMeta]      = useState(FALLBACK_PROVIDER_META);
  const [paidAllowlist, setPaidAllowlist] = useState(null);  // null=加载中
  const [providerGatewayAuth, setProviderGatewayAuth] = useState({});
  const [userSubscriptions, setUserSubscriptions] = useState([]);
  const [subscriptionCatalog, setSubscriptionCatalog] = useState([]);
  const [statsOnlyIds, setStatsOnlyIds] = useState([]);
  const [userPayg, setUserPayg] = useState([]);
  const [providerPricing, setProviderPricing] = useState({});
  const [catalogPricing, setCatalogPricing] = useState({}); // 服务端 catalog 刊例价（发布后立即生效）
  const [pricingOverrides, setPricingOverrides] = useState({});
  const [paygCatalog, setPaygCatalog] = useState([]);
  const [directInstances, setDirectInstances] = useState([]);   // 直连源实例（仅统计的应用）
  const [directBilling, setDirectBilling] = useState({});        // 直连源计费（按 agent_id）
  const [accountsData, setAccountsData] = useState(null);        // 完整账户快照（统计视图用）
  const [sourcesView, setSourcesView] = useState('model');       // 个人源视图：model | list（账户）
  const [accountSyncing, setAccountSyncing] = useState(false);
  const [accountSyncHint, setAccountSyncHint] = useState('');
  const [credModalKey, setCredModalKey] = useState(null);        // 添加实例后弹出的凭证配置弹窗（source key）
  // Track the last value written/loaded so we skip the initial load trigger
  const lastSaved = useRef(null);
  const [gatewayPickerEntries, setGatewayPickerEntries] = useState([]);
  const [templateEditing, setTemplateEditing] = useState(null);
  const [catalogSeed, setCatalogSeed] = useState(null); // { defaults, meta, fromNetwork }

  // catalog 预设 + 按量刊例目录（Docker 无 yaml 时 paygCatalog 补全 base_url）
  const catalogDefaultsById = useMemo(() => {
    const out = buildCatalogDefaultsById(catalogSeed?.defaults);
    for (const p of paygCatalog || []) {
      const id = p.provider_id || p.id;
      if (!id) continue;
      if (!out[id]?.base_url && p.base_url) {
        out[id] = { ...(out[id] || { id }), base_url: p.base_url };
      }
    }
    return out;
  }, [catalogSeed?.defaults, paygCatalog]);

  const { user } = useAuth();

  const loadUserPaidAccounts = useCallback(async () => {
    try {
      // 个人源始终读本机 local-config，与是否登录无关
      const r = await loadUserAccounts({ localOnly: true });
      setPaidAllowlist(r.gateway_provider_ids || []);
      setProviderGatewayAuth(r.provider_gateway_auth || {});
      setUserSubscriptions(r.user_subscriptions || []);
      setSubscriptionCatalog(r.subscription_catalog || []);
      const baseEntries = r.gateway_picker_entries?.length
        ? r.gateway_picker_entries
        : buildGatewayPickerEntries(r.user_subscriptions, r.user_payg_providers, r.subscription_catalog);
      // catalog 缺 plan_provider_id 映射时，已登记的 OAuth 订阅(Claude/Codex/Copilot)仍补进 picker，可直接登录
      const havePid = new Set(baseEntries.map(e => e.providerId));
      const oauthFallback = (r.user_subscriptions || [])
        .filter(s => s.subscription_to_api && s.subscription_kind !== 'api' && !s.custom
          && OAUTH_SUB_SOURCE_TO_PID[s.source_id] && !havePid.has(OAUTH_SUB_SOURCE_TO_PID[s.source_id]))
        .map(s => ({
          providerId: OAUTH_SUB_SOURCE_TO_PID[s.source_id],
          pickerKey: `sub:${s.source_id}`,
          label: s.app_name || s.source_id,
          icon: s.app_icon || '🔷',
          authMode: 'oauth',
          source: 'subscription',
        }));
      setGatewayPickerEntries([...baseEntries, ...oauthFallback]);
      setStatsOnlyIds(r.stats_only_provider_ids || []);
      setUserPayg(r.user_payg_providers || []);
      setProviderPricing(r.provider_pricing || {});
      const sanitizedOverrides = sanitizePricingOverrides(r.provider_pricing_overrides || {});
      setPricingOverrides(sanitizedOverrides);
      if (sanitizedOverrides !== (r.provider_pricing_overrides || {})) {
        saveUserAccounts({ provider_pricing_overrides: sanitizedOverrides }).catch(() => {});
      }
      setPaygCatalog(r.payg_provider_catalog || []);
      setDirectInstances(r.direct_source_instances || []);
      setDirectBilling(r.direct_source_billing || {});
      setAccountsData(r);
    } catch {
      setPaidAllowlist([]);
      setUserPayg([]);
      setProviderPricing({});
      setPaygCatalog([]);
    }
  }, []);

  /** catalog 刊例价（服务端）+ 本地 yaml 费率覆盖；模型键以 catalog 为准，不把本地残留并回来 */
  const mergedProviderPricing = useMemo(() => {
    const out = { ...catalogPricing };
    for (const [pid, local] of Object.entries(providerPricing || {})) {
      const catalogKeys = catalogPricing[pid] ? new Set(Object.keys(catalogPricing[pid])) : null;
      const clean = {};
      for (const [k, v] of Object.entries(local || {})) {
        if (!isValidModelName(k)) continue;
        if (catalogKeys && !catalogKeys.has(k)) continue;
        clean[k] = v;
      }
      out[pid] = { ...(out[pid] || {}), ...clean };
    }
    for (const pid of Object.keys(out)) {
      for (const k of Object.keys(out[pid] || {})) {
        if (!isValidModelName(k)) delete out[pid][k];
      }
    }
    return out;
  }, [catalogPricing, providerPricing]);

  useEffect(() => {
    loadUserPaidAccounts();
    const unsub = window.electronAPI?.localConfig?.onBillingChanged?.(loadUserPaidAccounts);
    return () => unsub?.();
  }, [loadUserPaidAccounts, user?.id ?? null]);

  // 首屏：先渲染本机 agent.providers，不等待远端 catalog
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await getConfig().read();
        if (cancelled || !cfg?.providers?.length) return;
        const local = sanitizeProviderModels(mergeCommunityP2PProvider(cfg.providers, cfg));
        lastSaved.current = local;
        setProviders(local);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // 为每个 gateway_id 确保存在 provider stub（多实例 acct-* 从 catalog 克隆）
  // 新建 stub 默认启用；已有条目尊重用户开关，勿强制改回 enabled
  useEffect(() => {
    if (!paidAllowlist?.length) return;
    setProviders(prev => {
      let changed = false;
      const next = [...prev];
      for (const gid of paidAllowlist) {
        if (next.some(p => p.id === gid)) continue;
        const payg = userPayg.find(p => paygInstGatewayId(p) === gid);
        const sub = userSubscriptions.find(s => subInstGatewayId(s) === gid);
        const catalogId = payg?.provider_id || sub?.source_id || sub?.plan_provider_id || gid;
        const tpl = resolveTemplateForProvider(gid, accountsData?.source_templates, userSubscriptions, userPayg);
        const catDef = catalogDefaultsById?.[catalogId] || catalogDefaultsById?.[gid];
        const fb = FALLBACK_PROVIDERS.find(p => p.id === gid) || FALLBACK_PROVIDERS.find(p => p.id === catalogId);
        const sibling = next.find(p => p.id === catalogId);
        const instModels = seedModelsFromNames(payg?.models || sub?.models || []);
        // 目录 tier=free 时默认进免费层（如 jimeng-api），避免个人页按量登记强制 paid
        const seedType = catDef?.type || tpl?.tier || fb?.type || 'paid';
        const blankCompat = isBlankCompatibleSourceId(catalogId);
        next.push({
          ...(fb || { type: seedType, enabled: true, base_url: '', models: [] }),
          id: gid,
          type: seedType,
          tier: seedType,
          enabled: true,
          ...FRESH_PROVIDER_CREDENTIALS,
          models: instModels,
          base_url: blankCompat
            ? (fb?.base_url || tpl?.base_url || catDef?.base_url || '')
            : (fb?.base_url || tpl?.base_url || catDef?.base_url || sibling?.base_url || ''),
          api_format: fb?.api_format || tpl?.api_format || catDef?.api_format || sibling?.api_format || 'openai',
        });
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [paidAllowlist, userPayg, userSubscriptions, accountsData?.source_templates, catalogDefaultsById]);

  const openTemplateEdit = useCallback((tplOrKey) => {
    const tpl = typeof tplOrKey === 'string'
      ? (accountsData?.source_templates || []).find(t => t.key === tplOrKey)
      : tplOrKey;
    if (tpl) setTemplateEditing(tpl);
  }, [accountsData]);

  const openTemplateEditForProvider = useCallback((providerId) => {
    const tpl = resolveTemplateForProvider(
      providerId, accountsData?.source_templates, userSubscriptions, userPayg,
    );
    if (tpl) setTemplateEditing(tpl);
  }, [accountsData, userSubscriptions, userPayg]);

  /** 本机设备 id，同步时跳过自己刚上报的那份配置 */
  async function resolveLocalDeviceId() {
    try {
      const id = window.electronAPI?.app?.getDeviceId?.();
      if (id) return id;
    } catch { /* 非桌面端 */ }
    try {
      const cfg = await getConfig().read();
      if (cfg?.device_id) return cfg.device_id;
    } catch { /* 配置未就绪 */ }
    try {
      const r = await fetch('/api/device-identity');
      if (r.ok) {
        const j = await r.json();
        if (j.device_id) return j.device_id;
      }
    } catch { /* CLI 未开 admin-api */ }
    return '';
  }

  // 从其他终端心跳上报的账户配置合并进本机（不含 Key；同 id 以本机为准）
  async function syncAccountsFromOtherDevices() {
    if (accountSyncing) return;
    setAccountSyncing(true);
    setAccountSyncHint('');
    try {
      const inv = await getInventoryStats(1);
      const devices = inv?.data?.devices || [];
      const myId = await resolveLocalDeviceId();
      const remotes = devices
        .filter(d => d && d.device_id && d.device_id !== myId && d.accounts_config)
        .map(d => d.accounts_config);
      const local = accountsData || await loadUserAccounts({ localOnly: true });
      const merged = mergeRemoteAccountConfigs(local, remotes);
      // 用当前列表计算，避免在 setState 里写副作用（Strict Mode 会跑两次）
      const gw = mergeGatewayProviders(providers, merged.gateway_provider_lists);
      if (gw.changed) setProviders(gw.providers);
      if (!merged.changed && !gw.changed) {
        setAccountSyncHint(t('psrc.model.syncEmpty'));
        return;
      }
      if (merged.changed) {
        await saveAccountsPatch({
          user_subscriptions: merged.user_subscriptions,
          user_payg_providers: merged.user_payg_providers,
          provider_pricing_overrides: merged.provider_pricing_overrides,
          direct_source_billing: merged.direct_source_billing,
          source_template_overrides: merged.source_template_overrides,
          custom_source_templates: merged.custom_source_templates,
        });
      }
      const n = merged.count || (gw.changed ? 1 : 0);
      setAccountSyncHint(t('psrc.model.syncDone', { n }));
    } catch {
      setAccountSyncHint(t('psrc.model.syncFail'));
    } finally {
      setAccountSyncing(false);
    }
  }

  async function saveAccountsPatch(patch) {
    if (patch.provider_pricing_overrides) setPricingOverrides(patch.provider_pricing_overrides);
    // 乐观更新，避免计费区添加模型后被 filterPaygModels 用旧账户列表裁掉
    if (Array.isArray(patch.user_payg_providers)) setUserPayg(patch.user_payg_providers);
    if (Array.isArray(patch.user_subscriptions)) setUserSubscriptions(patch.user_subscriptions);
    if (patch.direct_source_billing && typeof patch.direct_source_billing === 'object') {
      setDirectBilling(patch.direct_source_billing);
    }
    await saveUserAccounts(patch);
    // 刊例价 / 直连计费已乐观写入本地 state：再整页 reload 会打断输入框焦点并闪动
    const structuralKeys = Object.keys(patch).filter((k) => (
      k !== 'provider_pricing_overrides'
      && k !== 'direct_source_billing'
      && k !== 'token'
      && k !== 'serverUrl'
    ));
    if (structuralKeys.length > 0) {
      await loadUserPaidAccounts();
    }
  }

  function adoptServerTemplate(key) {
    const next = { ...(accountsData?.source_template_overrides || {}) };
    delete next[key];
    saveAccountsPatch({ source_template_overrides: next });
  }

  // 同步 openrouter 免费模型目录：openrouter 若是 payg 账户源，模型列表由 payg 账户 models 决定
  // （直接写 provider.models 会被 filterPaygModels 裁掉），故写进 payg 账户 models——合并去重、不覆盖
  // 用户已注册的付费模型；非 payg 源才写 provider.models。
  async function syncOpenrouterModels() {
    try {
      const r = await window.electronAPI?.gateway?.refreshOpenrouterModels?.();
      const names = (r && r.models) || [];
      if (!names.length) return;
      const acct = resolvePaygAccount('openrouter', userPayg);
      if (acct) {
        const have = new Set((acct.models || []).map(m => (typeof m === 'string' ? m : (m && m.name))).filter(Boolean));
        const add = names.filter(n => !have.has(n));
        if (!add.length) return;
        const nextPayg = userPayg.map(p => (p.id === acct.id ? { ...p, models: [...(p.models || []), ...add] } : p));
        await saveAccountsPatch({ user_payg_providers: nextPayg });
      } else {
        setProviders(prev => prev.map(p => (p.id === 'openrouter'
          ? { ...p, models: names.map(n => ({ name: n, type: 'chat' })) } : p)));
      }
    } catch { /* ignore */ }
  }

  useEffect(() => {
    let cancelled = false;
    const emptySeed = {
      defaults: FALLBACK_PROVIDERS,
      meta: localizeProviderMeta(FALLBACK_PROVIDER_META, t),
      fromNetwork: false,
    };

    const applySeed = (seed) => {
      if (cancelled || !seed) return;
      setCatalogPricing(seed.pricing || {});
      setCatalogSeed({ defaults: seed.defaults, meta: seed.meta, fromNetwork: seed.fromNetwork });
      setMeta(seed.meta);
    };

    const loadFromYaml = async () => {
      try {
        const data = await readProviderCatalogFromYaml();
        applySeed(buildCatalogSeed(data, oauthById, t, false));
      } catch {}
      if (!cancelled) setCatalogSeed(prev => prev || emptySeed);
    };

    loadFromYaml();

    // 进入供给源页：后台拉云端目录写 yaml，完成后刷新模板
    (async () => {
      try {
        await syncProviderCatalog();
        if (!cancelled) {
          await loadFromYaml();
          loadUserPaidAccounts();
        }
      } catch {}
    })();

    const unsubCatalog = window.electronAPI?.localConfig?.onCatalogUpdated?.(() => {
      loadFromYaml();
      loadUserPaidAccounts();
    });
    const unsubBilling = window.electronAPI?.localConfig?.onBillingChanged?.(() => {
      loadFromYaml();
    });
    return () => {
      cancelled = true;
      unsubCatalog?.();
      unsubBilling?.();
    };
  }, [t, oauthById, loadUserPaidAccounts]);

  // 与本地配置 / 个人源账户合并（不重复拉 /api/catalog）
  useEffect(() => {
    if (!catalogSeed) return;
    let cancelled = false;
    (async () => {
      const { defaults, meta: seedMeta } = catalogSeed;
      const cfg = await getConfig().read();
      if (cancelled) return;
      let resolved;
      if (cfg?.providers?.length) {
        const defaultIds = new Set(defaults.map(p => p.id));
        const mapped = defaults.map(def => {
          const saved = cfg.providers.find(p => p.id === def.id);
          if (!saved) return def;
          const models = mergeModelsFromCatalog(def.models, saved.models);
          const base_url = pickBaseUrlOnCatalogMerge(def, saved, seedMeta[def.id]);
          return { ...def, ...saved, base_url, models };
        });
        const custom = cfg.providers.filter(p => !defaultIds.has(p.id)).map(p =>
          normalizeProviderBaseUrlForSave(p, catalogDefaultsById, seedMeta),
        );
        resolved = sanitizeProviderModels([...mapped, ...custom]);
        // 将 catalog 对齐后的 base_url / 模型裁剪写回 agent config
        let configDirty = false;
        const nextConfigProviders = (cfg.providers || []).map(saved => {
          if (!defaultIds.has(saved.id)) {
            const next = normalizeProviderBaseUrlForSave(saved, catalogDefaultsById, seedMeta);
            if ((saved.base_url || '') !== (next.base_url || '')) configDirty = true;
            return next;
          }
          const def = defaults.find(d => d.id === saved.id);
          const base_url = pickBaseUrlOnCatalogMerge(def, saved, seedMeta[saved.id]);
          const merged = mergeModelsFromCatalog(def?.models, saved.models);
          if ((saved.base_url || '') !== base_url) configDirty = true;
          const before = (saved.models || []).map(m => normModel(m).name).join('\0');
          const after = merged.map(m => m.name).join('\0');
          if (before !== after) configDirty = true;
          return { ...saved, base_url, models: merged };
        });
        if (configDirty) getConfig().write({ ...cfg, providers: nextConfigProviders }).catch(() => {});
      } else {
        resolved = defaults;
      }
      resolved = mergeCommunityP2PProvider(resolved, cfg);
      const merged = mergeUserPaygIntoProviders(resolved, seedMeta, userPayg, t);
      const withCustomSubs = mergeCustomSubscriptionProviders(
        merged.providers, merged.meta, userSubscriptions, paidAllowlist || [], t,
      );
      // 账户实例 models 与 provider.models 对齐，去掉 catalog 预填
      const subModelsByGateway = new Map();
      for (const s of userSubscriptions) {
        const isApi = s.subscription_kind === 'api' || s.subscription_to_api;
        if (!isApi) continue;
        const gwId = subInstGatewayId(s);
        if (!gwId) continue;
        const set = subModelsByGateway.get(gwId) || new Set();
        for (const m of s.models || []) {
          const n = normModel(typeof m === 'string' ? { name: m } : m).name;
          if (n) set.add(n);
        }
        subModelsByGateway.set(gwId, set);
      }
      withCustomSubs.providers = withCustomSubs.providers.map(p => {
        const payg = userPayg.find(x => paygInstGatewayId(x) === p.id);
        if (payg) {
          const accountModels = (payg.models || []).map(normModel).filter(m => m.name);
          const before = (p.models || []).map(m => normModel(m).name).join('\0');
          const after = accountModels.map(m => m.name).join('\0');
          return before === after ? p : { ...p, models: accountModels };
        }
        if (subModelsByGateway.has(p.id)) {
          const accountModels = [...subModelsByGateway.get(p.id)]
            .sort()
            .map(name => ({ name, type: 'chat' }));
          const before = (p.models || []).map(m => normModel(m).name).join('\0');
          const after = accountModels.map(m => m.name).join('\0');
          return before === after ? p : { ...p, models: accountModels };
        }
        return p;
      });
      if (cancelled) return;
      lastSaved.current = withCustomSubs.providers;
      setProviders(prev => {
        const loaded = withCustomSubs.providers;
        const next = loaded.map(p => mergeProviderAfterReload(p, prev.find(x => x.id === p.id)));
        // 内容未变则保留原引用，避免账户重载/保存后整表闪动
        if (prev.length === next.length
          && prev.every((p, i) => (
            p === next[i]
            || (p.id === next[i].id
              && (p.token || '') === (next[i].token || '')
              && (p.base_url || '') === (next[i].base_url || '')
              && !!p.enabled === !!next[i].enabled
              && p.test_verified === next[i].test_verified
              && (p.models || []).map(m => normModel(m).name).join('\0')
                === (next[i].models || []).map(m => normModel(m).name).join('\0'))
          ))) {
          return prev;
        }
        return next;
      });
      setMeta(localizeProviderMeta(withCustomSubs.meta, t));
    })();
    return () => { cancelled = true; };
  }, [catalogSeed, catalogDefaultsById, userPayg, userSubscriptions, paidAllowlist, t]);

  // 语言切换时刷新 meta 文案
  useEffect(() => {
    setMeta(prev => localizeProviderMeta(prev, t));
  }, [t]);

  // Auto-save with 500 ms debounce; skip initial load
  // 静默落盘：只写磁盘，绝不 setProviders，避免整表闪动
  useEffect(() => {
    if (lastSaved.current === null || providers === lastSaved.current) return;
    const timer = setTimeout(async () => {
      try {
        const cfg = (await getConfig().read()) || {};
        const snapshot = providers;
        const normalizedProviders = snapshot.map(p => {
          const base = normalizeProviderBaseUrlForSave(p, catalogDefaultsById, meta);
          if (isPaygManagedProvider(p.id, userPayg)) {
            return { ...base, models: filterPaygModels(base.models, p.id, userPayg, mergedProviderPricing, paygCatalog) };
          }
          return base;
        });
        await getConfig().write({ ...cfg, providers: normalizedProviders });
        // 以当前 UI 引用标记已保存，磁盘侧规范化差异下次写时再对齐
        lastSaved.current = snapshot;
      } catch {}
    }, 500);
    return () => clearTimeout(timer);
  }, [providers, meta, catalogDefaultsById, t, userPayg, mergedProviderPricing, paygCatalog]);

  /** 立即落盘 Tier，避免 debounce / catalog 重载覆盖；同步回溯盘点 tier */
  const persistProviderTier = useCallback(async (id, tier) => {
    const patch = { type: tier, tier };
    setProviders(prev => {
      const i = prev.findIndex(p => p.id === id);
      if (i < 0) {
        return [...prev, { id, enabled: true, token: '', base_url: '', models: [], ...patch }];
      }
      return prev.map(p => (p.id === id ? { ...p, ...patch } : p));
    });
    try {
      const cfg = (await getConfig().read()) || {};
      const list = [...(cfg.providers || [])];
      const i = list.findIndex(p => p.id === id);
      if (i >= 0) list[i] = { ...list[i], ...patch };
      else list.push({ id, enabled: true, token: '', base_url: '', models: [], ...patch });
      await getConfig().write({ ...cfg, providers: list });
      lastSaved.current = list;
      // 回溯更新 SQLite 历史请求的 tier / 费用，触发盘点页刷新
      if (isElectron() && window.electronAPI?.localStats?.reassignProviderTier) {
        await window.electronAPI.localStats.reassignProviderTier(id, tier);
      }
    } catch { /* 离线时仍保留内存态 */ }
  }, []);

  const updateProvider = useCallback((id, patch) => {
    const fromBilling = patch._fromBilling === true;
    if (fromBilling) {
      const { _fromBilling, ...rest } = patch;
      patch = rest;
    }
    if (!fromBilling && isPaygManagedProvider(id, userPayg) && patch.models != null) {
      patch = { ...patch, models: filterPaygModels(patch.models, id, userPayg, mergedProviderPricing, paygCatalog) };
    }
    if (patchClearsTestVerified(patch) && patch.test_verified === undefined) {
      patch = { ...patch, test_verified: false };
    }
    setProviders(prev => {
      const i = prev.findIndex(p => p.id === id);
      if (i < 0) {
        return [...prev, { id, type: 'paid', enabled: true, token: '', base_url: '', models: [], ...patch }];
      }
      return prev.map(p => (p.id === id ? { ...p, ...patch } : p));
    });
  }, [userPayg, mergedProviderPricing, paygCatalog]);

  /**
   * 静默落盘凭证：写磁盘 + 就地补丁内存，setState 返回原引用以跳过重渲染。
   * API Key / base_url 失焦保存走此路径，避免整表闪动。
   */
  const silentPersistProviderPatch = useCallback(async (id, patch) => {
    let cleared = patch;
    if (patchClearsTestVerified(patch) && patch.test_verified === undefined) {
      cleared = { ...patch, test_verified: false };
    }
    try {
      const cfg = (await getConfig().read()) || {};
      const list = [...(cfg.providers || [])];
      const i = list.findIndex(p => p.id === id);
      if (i >= 0) list[i] = { ...list[i], ...cleared };
      else list.push({ id, type: 'paid', enabled: true, token: '', base_url: '', models: [], ...cleared });
      await getConfig().write({ ...cfg, providers: list });
    } catch { /* 离线时仍写内存 */ }
    // 同引用返回 → React 不重渲染；对象就地更新供后续读盘/合并使用
    setProviders(prev => {
      const idx = prev.findIndex(p => p.id === id);
      if (idx >= 0) Object.assign(prev[idx], cleared);
      else prev.push({ id, type: 'paid', enabled: true, token: '', base_url: '', models: [], ...cleared });
      lastSaved.current = prev;
      return prev;
    });
  }, []);

  // ChatGPT 网页多实例：从添加器加一个账户实例（后端起独立 server+分区+provider），回读配置刷新
  const addChatgptWebInstance = useCallback(async () => {
    if (!isElectron() || !window.electronAPI?.chatgptWeb) return;
    try {
      await window.electronAPI.chatgptWeb.add();
      const cfg = (await getConfig().read()) || {};
      lastSaved.current = cfg.providers || [];
      setProviders(cfg.providers || []);
    } catch (e) { console.warn('[chatgpt-web] add failed:', e?.message); }
  }, []);
  const removeChatgptWebInstance = useCallback(async (instId) => {
    try { await window.electronAPI?.chatgptWeb?.remove(instId); } catch (e) { console.warn('[chatgpt-web] remove failed:', e?.message); }
    try {
      const cfg = (await getConfig().read()) || {};
      lastSaved.current = cfg.providers || [];
      setProviders(cfg.providers || []);
    } catch { setProviders(prev => prev.filter(p => p.id !== instId)); }
  }, []);

  /** 立即落盘 enabled，避免 debounce 未完成时网关页仍读到旧开关 */
  const persistProviderEnabled = useCallback(async (id, enabled) => {
    const stub = id === 'tokenbank-p2p'
      ? { ...BUILTIN_P2P_PROVIDER, enabled: !!enabled }
      : { id, type: 'paid', enabled: !!enabled, token: '', base_url: '', models: [] };
    try {
      const cfg = (await getConfig().read()) || {};
      const list = [...(cfg.providers || [])];
      const i = list.findIndex(p => p.id === id);
      if (i >= 0) list[i] = { ...list[i], enabled: !!enabled };
      else list.push(stub);
      await getConfig().write({ ...cfg, providers: list });
      lastSaved.current = list;
      setProviders(prev => prev.map(p => (p.id === id ? { ...p, enabled: !!enabled } : p)));
      // 启用 openrouter 的模型同步由下方 effect 统一处理（providers 变化触发，能拿到 fresh userPayg）
    } catch { /* 离线时仍保留内存态 */ }
  }, []);

  // openrouter 若已启用：进页(启动)或刚启用时，拉一次免费模型目录同步（payg 感知，见 syncOpenrouterModels）。
  // 一次性(ref 守卫)：openrouter 从未启用→启用时 providers 变化会重跑此 effect，拿到 fresh userPayg。
  const orSyncedRef = useRef(false);
  useEffect(() => {
    if (orSyncedRef.current) return;
    if (!accountsData) return;   // 等账户(userPayg)加载完再判 payg，否则会走错分支
    const or = providers.find(p => p.id === 'openrouter');
    if (!or || !or.enabled) return;
    orSyncedRef.current = true;
    syncOpenrouterModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, accountsData]);

  /** 立即落盘 provider.models，避免 saveAccounts 触发重载时被 debounce 旧配置覆盖 */
  const persistProviderModels = useCallback(async (id, models) => {
    const normalized = (models || []).map(normModel).filter(m => m.name);
    try {
      const cfg = (await getConfig().read()) || {};
      const list = [...(cfg.providers || [])];
      const i = list.findIndex(p => p.id === id);
      if (i >= 0) {
        list[i] = { ...list[i], models: normalized };
      } else {
        list.push({ id, type: 'paid', enabled: true, token: '', base_url: '', models: normalized });
      }
      // 同步贡献列表同名模型的 type，全球网络试用页才能显示「图文」
      const typeByName = Object.fromEntries(normalized.map(m => [m.name, m.type || 'chat']));
      const syncEntry = (m) => {
        if (typeof m === 'string') {
          return typeByName[m] ? { name: m, type: typeByName[m] } : m;
        }
        const n = m?.name;
        if (n && typeByName[n]) return { ...m, name: n, type: typeByName[n] };
        return m;
      };
      const next = { ...cfg, providers: list };
      if (Array.isArray(cfg.models)) next.models = cfg.models.map(syncEntry);
      if (Array.isArray(cfg.model_groups)) {
        next.model_groups = cfg.model_groups.map(g => ({
          ...g,
          models: (g.models || []).map(syncEntry),
        }));
      }
      await getConfig().write(next);
      // 贡献节点在跑时热重连，立刻把新 type 报到服务端
      try {
        const st = await window.electronAPI?.agent?.getStatus?.();
        if (st?.running) await window.electronAPI.agent.start();
      } catch { /* ignore */ }
    } catch { /* 离线时仍保留内存态 */ }
  }, []);

  /** 立即落盘 base_url（静默，不触发整表重渲染） */
  const persistProviderBaseUrl = useCallback(async (id, base_url) => {
    const cur = providers.find(p => p.id === id) || { id, type: 'paid', enabled: true, token: '', models: [] };
    const normalized = normalizeProviderBaseUrlForSave({ ...cur, base_url }, catalogDefaultsById, meta);
    await silentPersistProviderPatch(id, { base_url: normalized.base_url });
  }, [providers, catalogDefaultsById, meta, silentPersistProviderPatch]);

  /** 选中选择器条目：每次点击登记新实例（支持同类型多账户），配置在上方列表卡片完成 */
  const selectPickerEntry = useCallback(async (entry) => {
    const tpl = entry.template;
    let patch = null;

    if (tpl) {
      try {
        // APP 订阅：先写入直连源；可转 API 的在卡片内再转到供给源区
        if (tpl.kind === 'app_sub') {
          patch = buildDirectSourcePatch(tpl, { billing: directBilling });
        } else {
          patch = buildInstancePatch(tpl, { payg: userPayg, subs: userSubscriptions });
        }
        await saveUserAccounts(patch);
        await loadUserPaidAccounts();
      } catch {
        return;
      }
    }

    // APP 订阅 / 纯直连：不自动创建网关 provider
    if (tpl?.kind === 'app_sub' || entry.statsOnly || entry.gatewayAddable === false) return;

    // 新建实例的 gateway_id（多账户时 acct-*）
    let newGwId = entry.providerId;
    let seedModels = [];
    if (patch?.user_payg_providers?.length) {
      const added = patch.user_payg_providers[patch.user_payg_providers.length - 1];
      newGwId = paygInstGatewayId(added) || entry.providerId;
      seedModels = seedModelsFromNames(added.models);
    } else if (patch?.user_subscriptions?.length) {
      const added = patch.user_subscriptions[patch.user_subscriptions.length - 1];
      newGwId = subInstGatewayId(added) || entry.providerId;
      seedModels = seedModelsFromNames(added.models);
    }
    // 模板有模型但账户未写入时（兼容旧数据）仍预填网关
    if (!seedModels.length && tpl?.models?.length) {
      seedModels = seedModelsFromNames(tpl.models);
    }

    const base = {
      id: newGwId,
      type: 'paid',
      enabled: true,
      ...FRESH_PROVIDER_CREDENTIALS,
      base_url: resolveSeedBaseUrl(entry, { providers, paygCatalog, meta }),
      models: seedModels,
      displayName: entry.label,
    };
    if (entry.authMode === 'oauth') {
      updateProvider(newGwId, {
        ...base,
        auth_type: 'oauth',
        billing_type: 'subscription',
        sub_mode: 'api-proxy',
        credentials: null,
        token: '',
      });
    } else {
      updateProvider(newGwId, {
        ...base,
        billing_type: 'api-key',
      });
    }
  }, [updateProvider, userSubscriptions, userPayg, directBilling, loadUserPaidAccounts, saveUserAccounts, providers, paygCatalog, meta]);

  /** 直连源「转 API 供给源」→ 登记订阅实例并启用上方供给源卡片 */
  const convertDirectToApi = useCallback(async (instance) => {
    const tpl = (accountsData?.source_templates || []).find(
      t => t.key === instance.source_id || t.agent_id === instance.agent_id,
    );
    if (!tpl) return;
    const b = directBilling[instance.agent_id] || {};
    const patch = buildInstancePatch(
      { ...tpl, subscription_to_api: true },
      { payg: userPayg, subs: userSubscriptions, planId: b.plan_id || undefined },
    );
    await saveUserAccounts(patch);
    await loadUserPaidAccounts();

    const added = patch.user_subscriptions?.[patch.user_subscriptions.length - 1];
    const newGwId = subInstGatewayId(added) || OAUTH_SUB_SOURCE_TO_PID[instance.source_id];
    if (!newGwId) return;
    const oauthPid = OAUTH_SUB_SOURCE_TO_PID[instance.source_id];
    const base = {
      id: newGwId,
      type: 'paid',
      enabled: true,
      token: '',
      base_url: tpl.base_url || resolveSeedBaseUrl({ providerId: newGwId, template: tpl }, { providers, paygCatalog, meta }),
      models: [],
      displayName: instance.name || tpl.label,
    };
    if (oauthPid) {
      const oauthMeta = getOAuthById(t)[oauthPid];
      updateProvider(newGwId, {
        ...base,
        auth_type: 'oauth',
        oauth_provider: oauthMeta?.provider || 'claude',
        billing_type: 'subscription',
        sub_mode: 'api-proxy',
      });
    } else {
      updateProvider(newGwId, {
        ...base,
        auth_type: 'api_key',
        billing_type: 'api-key',
        credentials: null,
        oauth_provider: '',
      });
    }
  }, [accountsData, directBilling, userPayg, userSubscriptions, loadUserPaidAccounts, saveUserAccounts, updateProvider, providers, paygCatalog, meta]);

  /** 从个人源列表移除：预设源标记为未添加，自定义源直接删除；同时清空 models 避免删后重加仍显示 catalog 预填 */
  const removePersonalProvider = useCallback((id) => {
    if (isCustomSubscriptionGatewayId(id, userSubscriptions) || !meta[id]) {
      setProviders(prev => prev.filter(p => p.id !== id));
    } else {
      setProviders(prev => prev.map(p => (p.id === id ? { ...p, enabled: false, models: [] } : p)));
    }
    persistProviderModels(id, []).catch(() => {});
  }, [userSubscriptions, meta, persistProviderModels]);

  const paidAccountsLoaded = paidAllowlist !== null;
  const hasPersonalPaid = paidAccountsLoaded && (paidAllowlist.length > 0 || statsOnlyIds.length > 0);
  const hasGatewayPaid = paidAccountsLoaded && paidAllowlist.length > 0;

  async function testProvider(p) {
    const result = await getGateway().testProvider({
      id: p.id, base_url: p.base_url, token: p.token, api_format: p.api_format,
      proxy: p.proxy,
      auth_type: p.auth_type, oauth_provider: p.oauth_provider, credentials: p.credentials,
    });
    // OpenRouter：点击测试后顺带同步一次免费模型目录（公开端点，不依赖测试成败）
    if (p.id === 'openrouter') syncOpenrouterModels().catch(() => {});
    return result;
  }

  const [pickerOpen, setPickerOpen] = useState(false);
  const [personalFilter, setPersonalFilter] = useState('all');
  /** 个人源列表选中行（右侧详情放原配置卡） */
  const [selectedSourceKey, setSelectedSourceKey] = useState(null);
  /** 「谁在用它」：场景路由 + 绑定了模型的智能体（打开详情时加载） */
  const [dependents, setDependents] = useState({ routes: [], assistants: [] });
  const provLocation = useLocation();
  const [personalLatencyMap, setPersonalLatencyMap] = useState({});

  const loadPersonalLatency = useCallback(async () => {
    try {
      const map = await getGateway().getModelProviderLatency(7);
      if (!map || typeof map !== 'object') return;
      // 内容未变则不 setState，避免 5s 轮询打断计费输入框
      setPersonalLatencyMap((prev) => {
        const prevKeys = Object.keys(prev || {});
        const nextKeys = Object.keys(map);
        if (prevKeys.length === nextKeys.length
          && nextKeys.every((k) => prev[k] === map[k] || JSON.stringify(prev[k]) === JSON.stringify(map[k]))) {
          return prev;
        }
        return { ...map };
      });
    } catch { /* 网关未就绪 */ }
  }, []);

  // 个人源延迟：5s 轮询 + 落账事件 + 页签重新可见时刷新（与网关页统计同源）
  useEffect(() => {
    loadPersonalLatency();
    const id = setInterval(loadPersonalLatency, 5000);
    const onVis = () => { if (document.visibilityState === 'visible') loadPersonalLatency(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [loadPersonalLatency]);

  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.localStats?.onChanged) return undefined;
    return window.electronAPI.localStats.onChanged(loadPersonalLatency);
  }, [loadPersonalLatency]);

  // 个人源统一列表（不再分 API / 订阅两段）
  const liveStateOf = (p) => withProviderDisplayName(providers.find(x => x.id === p.id) || p, userPayg, userSubscriptions, meta);
  const personalPaidPool = buildPersonalPaidPool(providers, paidAllowlist || [], userPayg, userSubscriptions);
  const personalPoolAll = (() => {
    const seen = new Set(personalPaidPool.map(p => p.id));
    return [...providers.filter(p => p.type === 'free' && !seen.has(p.id)), ...personalPaidPool];
  })();
  const personalEnabledAll = personalPoolAll.filter(p => liveStateOf(p).enabled);
  const personalEnabledFiltered = personalFilter === 'all'
    ? personalEnabledAll
    : personalEnabledAll.filter(p => tagMatchesFilter(
        getPersonalSourceTag(liveStateOf(p), meta, userPayg, userSubscriptions),
        personalFilter,
      ));
  const sourceTemplates = accountsData?.source_templates || [];
  const directAll = mergeDirectInstances(directInstances, directBilling, userSubscriptions, sourceTemplates, subscriptionCatalog);
  const bill = directBilling || {};
  // 统一的「账户实例」集：订阅 + 按量 + 直连，按添加顺序排列
  const accountInstances = [...[
    ...userSubscriptions.map(s => {
      const pid = s.plan_provider_id || s.source_id;
      const gw = subInstGatewayId(s);
      const tag = s.subscription_kind === 'api' ? 'api_sub' : (s.subscription_to_api ? 'sub_to_api' : 'app_sub');
      return {
        kind: 'sub', billing_type: 'subscription', tag,
        id: s.id, source_id: s.source_id, gateway_id: gw,
        name: s.name || s.app_name, label: s.app_name, icon: s.app_icon,
        models: (Array.isArray(s.models) && s.models.length) ? s.models : [],
        plan_label: s.plan_label, monthly_usd: s.monthly_usd ?? null,
        added_at: s.added_at,
      };
    }),
    ...userPayg.map(p => ({
      kind: 'payg', billing_type: 'api', tag: 'payg',
      id: p.id, source_id: p.provider_id, gateway_id: paygInstGatewayId(p),
      name: p.name || p.label, label: p.label, icon: p.icon,
      models: (p.models && p.models.length) ? p.models : [],
      added_at: p.added_at,
    })),
    ...directAll.map(d => ({
      kind: 'direct', billing_type: d.mode === 'api' ? 'api' : 'subscription',
      tag: d.mode === 'api' ? 'payg' : 'app_sub',
      id: d.agent_id, source_id: d.source_id,
      name: d.name, label: d.label, icon: d.icon,
      models: d.models || [],
      added_at: bill[d.agent_id]?.added_at,
    })),
  ].sort((a, b) => {
    const ka = accountInstanceAddedOrder(a, bill);
    const kb = accountInstanceAddedOrder(b, bill);
    return ka - kb || String(a.id || '').localeCompare(String(b.id || ''));
  })];
  const directByAgent = useMemo(
    () => Object.fromEntries(directAll.map(d => [d.agent_id, d])),
    [directAll],
  );
  // 按模型视图：仅已启用供给源；不回退 catalog 刊例价
  const modelViewInstances = useMemo(() => {
    const base = accountInstances.flatMap(inst => {
      const gwId = inst.gateway_id;
      const prov = gwId ? providers.find(p => p.id === gwId) : null;
      // 有对应网关源且已停用 → 不进入模型列表
      if (prov && prov.enabled === false) return [];
      return [{
        ...inst,
        test_verified: prov?.test_verified === true,
        models: resolveModelsForModelView(
          inst, providers, userPayg, userSubscriptions, pricingOverrides, directByAgent,
        ),
      }];
    });
    // ChatGPT 网页多实例：每个 chatgpt-web-<n> 并入模型视图
    if (isElectron() && window.electronAPI?.chatgptWeb) {
      for (const cw of providers.filter(p => /^chatgpt-web-\d+$/.test(p.id) && p.enabled !== false)) {
        base.push({
          id: cw.id, gateway_id: cw.id, source_id: cw.id,
          name: cw.label || cw.id, icon: '🌐', tag: 'free',
          test_verified: false,
          models: Array.isArray(cw.models) ? cw.models : [],
        });
      }
    }
    return base;
  }, [accountInstances, providers, userPayg, userSubscriptions, pricingOverrides, directByAgent]);
  // 个人源「全部测速」：每个账户×模型钉 provider，避免同模型多账户只打中其中一个（展开会显示「无请求」）
  const personalProbeTargets = useMemo(() => {
    const seen = new Set(); const out = [];
    for (const inst of modelViewInstances) {
      const prov = inst.gateway_id ? providers.find(p => p.id === inst.gateway_id) : null;
      const tier = prov?.type === 'free' ? 'free' : 'paid';
      const provider = inst.gateway_id || undefined;
      for (const m of (inst.models || [])) {
        const name = typeof m === 'string' ? m.trim() : String(m?.name || m?.id || '').trim();
        if (!name) continue;
        const explicit = typeof m === 'object' ? (m.type || m.modality) : null;
        if (explicit === 'image' || inferModelTypeFromName(name) === 'image') continue;
        const key = encodeRoute({ tier, provider, model: name });
        if (!key || seen.has(key)) continue;
        seen.add(key); out.push(key);
      }
    }
    return out;
  }, [modelViewInstances, providers]);
  // 个人源模型模态（图/嵌），供按模型视图与路由下拉同源
  const personalModelTypeMap = useMemo(() => {
    const cfg = { providers, provider_pricing_overrides: pricingOverrides };
    const accounts = {
      ...(accountsData || {}),
      user_payg_providers: userPayg,
      user_subscriptions: userSubscriptions,
      direct_source_billing: directBilling,
      provider_pricing_overrides: pricingOverrides,
    };
    const map = buildPersonalModelTypeMap(cfg, accounts);
    for (const inst of modelViewInstances) {
      for (const name of inst.models || []) {
        const n = typeof name === 'string' ? name : (name?.name || name?.id || '');
        if (!n || (map[n] && map[n] !== 'chat')) continue;
        const inferred = inferModelTypeFromName(n);
        if (inferred !== 'chat') map[n] = inferred;
      }
    }
    return map;
  }, [providers, accountsData, userPayg, userSubscriptions, directBilling, pricingOverrides, modelViewInstances]);
  // 「已接入网关」= 对应 provider 真正 enabled（不是 gateway_provider_ids 那种「已登记可接入」）。
  // 接入的由上面 ProviderCard 展示；未接入的在这里补充展示，使列表数目与统计一致。
  // 顶部筛选：按账户实例的类型 tag（app订阅 / api订阅 / 订阅转API / API）；
  // 统计方块点击用粗粒度组：'subscription'=三种订阅，'api'=按量
  const SUB_TAGS = ['app_sub', 'api_sub', 'sub_to_api'];
  const matchFilter = (tag) => {
    if (personalFilter === 'all') return true;
    if (personalFilter === 'subscription') return SUB_TAGS.includes(tag);
    if (personalFilter === 'api') return tag === 'payg';
    return tag === personalFilter;
  };
  const hasAcct = (id) => accountInstances.some(i => i.gateway_id === id);
  // 已启用但未登记账户实例的供给源（如 Ollama），与账户卡片同一网格展示
  const extraEnabledSources = personalEnabledAll.filter(p => {
    if (p.type === 'p2p' || hasAcct(p.id)) return false;
    if (/^chatgpt-web-\d+$/.test(p.id) || p.id === 'chatgpt-web') return false; // 网页实例走专用卡，不进通用渲染
    return matchFilter(getPersonalSourceTag(liveStateOf(p), meta, userPayg, userSubscriptions));
  });
  // 列表视图：网关 / 直连 / 无账户实例的免费源，统一按添加顺序渲染
  const personalSourceRows = useMemo(() => {
    const rows = [];
    const extraBase = accountInstances.reduce((max, inst) => {
      const o = accountInstanceAddedOrder(inst, bill);
      return o > max ? o : max;
    }, 0) + 1;
    for (const inst of accountInstances) {
      if (!matchFilter(inst.tag)) continue;
      if (inst.kind === 'direct') {
        const d = directByAgent[inst.id];
        if (d) rows.push({ order: accountInstanceAddedOrder(inst, bill), type: 'direct', inst, direct: d });
      } else if (isGatewayAccountInstance(inst)) {
        rows.push({ order: accountInstanceAddedOrder(inst, bill), type: 'gateway', inst });
      }
    }
    extraEnabledSources.forEach((p, i) => {
      rows.push({ order: extraBase + i, type: 'extra', provider: p });
    });
    rows.sort((a, b) => a.order - b.order);
    // ChatGPT 网页多实例：每个 chatgpt-web-<n> 源一张专用卡（默认无实例；从添加器加）
    if (isElectron() && window.electronAPI?.chatgptWeb) {
      const insts = providers.filter(p => /^chatgpt-web-\d+$/.test(p.id) && p.enabled !== false)
        .sort((a, b) => (a.chatgpt_web_instance || 0) - (b.chatgpt_web_instance || 0));
      insts.forEach((p, i) => rows.unshift({ order: -1000 + i, type: 'chatgptweb', provider: p }));
    }
    return rows;
  }, [accountInstances, directByAgent, bill, extraEnabledSources, personalFilter, providers]);

  // 删除单个账户实例：仅删对应 user_payg/sub 行；无其他实例共用 gateway_id 时才停用 provider
  const removeAccountInstance = async (inst) => {
    const gwId = inst.gateway_id;
    let nextPayg = userPayg;
    let nextSubs = userSubscriptions;
    if (inst.kind === 'payg') nextPayg = nextPayg.filter(p => p.id !== inst.id);
    else if (inst.kind === 'sub') nextSubs = nextSubs.filter(s => s.id !== inst.id);
    const patch = { user_payg_providers: nextPayg, user_subscriptions: nextSubs };
    await saveUserAccounts(patch);
    const stillUsed = nextPayg.some(p => paygInstGatewayId(p) === gwId)
      || nextSubs.some(s => subInstGatewayId(s) === gwId);
    if (!stillUsed) removePersonalProvider(gwId);
    loadUserPaidAccounts();
  };

  const removeAccountSource = async (providerId) => {
    const inst = accountInstances.find(i => i.gateway_id === providerId);
    if (inst && inst.kind !== 'direct') return removeAccountInstance(inst);
    removePersonalProvider(providerId);
  };

  /** 删除直连源：清除计费登记，并移除 legacy 纯 APP 订阅 */
  const removeDirectSource = async (instance) => {
    const agentId = instance.agent_id;
    const sourceId = instance.source_id;
    const billingPatch = buildDirectSourceRemovePatch(agentId, directBilling);
    const nextSubs = userSubscriptions.filter(s => {
      if (s.subscription_kind === 'api' || s.subscription_to_api) return true;
      const aid = s.agent_id || s.source_id;
      return aid !== agentId && s.source_id !== sourceId;
    });
    await saveUserAccounts({
      ...billingPatch,
      ...(nextSubs.length !== userSubscriptions.length ? { user_subscriptions: nextSubs } : {}),
    });
    loadUserPaidAccounts();
  };

  const templatePickerEntries = buildTemplatePickerEntries(
    accountsData?.source_templates,
    subscriptionCatalog,
  );
  const pickerEntries = templatePickerEntries.length
    ? templatePickerEntries
    : gatewayPickerEntries;
  const freeAddableProviders = (() => {
    const oauthPids = new Set(Object.values(OAUTH_SUB_SOURCE_TO_PID));
    const entryPids = new Set(pickerEntries.map(e => e.providerId));
    return providers.filter(pr => !pr.enabled
      && (pr.type === 'free' || pr.type === 'paid')
      && !oauthPids.has(pr.id) && !entryPids.has(pr.id));
  })();
  const pickerItems = [
    ...pickerEntries.map(entry => ({
      kind: 'entry', tag: getPickerEntryTag(entry), entry, key: entry.pickerKey,
    })),
    // 有服务端模板目录时不再混入 registry 免费源（可选类型以服务端为准）
    ...(templatePickerEntries.length ? [] : freeAddableProviders.map(pr => ({
      kind: 'free', tag: 'free', provider: pr, key: `free:${pr.id}`,
    }))),
  ];
  // ChatGPT 网页：始终显示为「添加账户实例」入口（每点加一个独立账户），带已添加数量
  const chatgptWebCount = providers.filter(p => /^chatgpt-web-\d+$/.test(p.id) && p.enabled !== false).length;
  if (isElectron() && window.electronAPI?.chatgptWeb
      && !pickerItems.some(it => it.provider && it.provider.id === 'chatgpt-web')) {
    pickerItems.push({ kind: 'chatgptweb', tag: 'free',
      provider: { id: 'chatgpt-web', type: 'free', label: 'ChatGPT 网页', icon: '🌐' },
      count: chatgptWebCount, key: 'free:chatgpt-web' });
  }
  // 免费账户置顶，便于发现
  const pickerItemsFiltered = pickerItems
    .filter(item => pickerItemMatchesFilter(item.tag, personalFilter))
    .sort((a, b) => Number(b.tag === 'free') - Number(a.tag === 'free'));

  function togglePicker() {
    setPickerOpen(v => !v);
  }

  // 「添加供给源」入口在下方「个人源」区
  // 失败候选冷却：网关按 provider.id（个人直连源为整源）冷却，主进程联表补了 agent_id/source_id，
  // 卡片按 provider_id 或 agent_id 匹配。低频轮询（10s，倒计时用粗粒度显示，无需秒级）。
  const [cooldowns, setCooldowns] = useState([]);
  const loadCooldowns = useCallback(async () => {
    try {
      const next = (await window.electronAPI?.gateway?.cooldowns?.()) || [];
      setCooldowns((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    loadCooldowns();
    const id = setInterval(loadCooldowns, 10000);
    return () => clearInterval(id);
  }, [loadCooldowns]);
  const cooldownMaps = useMemo(() => {
    const byProv = {}, byAgent = {};
    for (const c of cooldowns) {
      if (c.provider_id && !byProv[c.provider_id]) byProv[c.provider_id] = c;
      if (c.agent_id && !byAgent[c.agent_id]) byAgent[c.agent_id] = c;
    }
    return { byProv, byAgent };
  }, [cooldowns]);
  const cooldownFor = useCallback((...ids) => {
    for (const id of ids) {
      if (!id) continue;
      const c = cooldownMaps.byProv[id] || cooldownMaps.byAgent[id];
      if (c) return c;
    }
    return null;
  }, [cooldownMaps]);

  // 打开详情时加载「谁在用它」：场景路由（本地配置）+ 绑定模型的智能体（桌面版资源库）
  useEffect(() => {
    if (!selectedSourceKey) return undefined;
    let alive = true;
    (async () => {
      let routes = [];
      let assistants = [];
      try { routes = (await getLocalConfig().get())?.scene_routes || []; } catch { /* ignore */ }
      try {
        const res = await window.electronAPI?.resource?.listResources?.({ type: 'assistant' });
        assistants = (res?.resources || []).map(a => {
          let model = '';
          try {
            const obj = typeof a.content === 'string' ? JSON.parse(a.content || '{}') : (a.content || {});
            model = String(obj.model || obj.parameters?.model || '').trim();
          } catch { /* ignore */ }
          return { id: a.id, name: a.display_name || a.name, model };
        });
      } catch { /* 网页版无资源库 */ }
      if (alive) setDependents({ routes, assistants });
    })();
    return () => { alive = false; };
  }, [selectedSourceKey]);

  // 从资源页「查看供给源」跳来：切到账户列表并选中提供该模型的来源
  useEffect(() => {
    const model = provLocation.state?.focusModel;
    if (!model) return;
    const hit = personalSourceRows.map(sourceSummary).find(sm => (sm.modelNames || []).includes(model));
    // 账户尚未加载完：保留跳转请求，等数据到了再定位
    if (!hit && !accountsData) return;
    setSourcesView('list');
    if (hit) setSelectedSourceKey(hit.key);
    navigate(provLocation.pathname, { replace: true, state: null });
  }, [provLocation.state, personalSourceRows, accountsData]); // eslint-disable-line react-hooks/exhaustive-deps
  const handleRetryCooldown = useCallback(async (key) => {
    try { await window.electronAPI?.gateway?.clearCooldown?.(key); } catch { /* ignore */ }
    loadCooldowns();
  }, [loadCooldowns]);

  const accountBillingProps = {
    pricingOverrides,
    onSaveAccounts: saveAccountsPatch,
    onOverridesChange: setPricingOverrides,
    onPersistModels: persistProviderModels,
    onPersistBaseUrl: persistProviderBaseUrl,
    onRetryCooldown: handleRetryCooldown,
    onSilentPersist: silentPersistProviderPatch,
  };

  function renderAddSourcePicker() {
    return (
      <div className="space-y-3">
        <button type="button" onClick={togglePicker}
          className={`w-full flex flex-col items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed py-4 transition-colors ${
            pickerOpen
              ? 'border-blue-400 dark:border-blue-600 text-blue-500 dark:text-blue-400 bg-blue-50/50 dark:bg-blue-950/10'
              : 'border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600 hover:text-zinc-500'
          }`}>
          <span className="text-xl leading-none">{pickerOpen ? '×' : '+'}</span>
          <span className="text-xs font-medium">{pickerOpen ? t('providers.add.collapse') : t('providers.add.expand')}</span>
          {!pickerOpen && (
            <span className="text-xs text-zinc-300 dark:text-zinc-600">
              {pickerEntries.length > 0
                ? t('providers.add.availableCount', { n: pickerEntries.length })
                : t('providers.add.allTypesHint')}
            </span>
          )}
        </button>

        {pickerOpen && (
          <div className="space-y-3">
            {!paidAccountsLoaded && (
              <p className="text-xs text-zinc-400">{t('providers.add.loadingAccounts')}</p>
            )}
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('providers.add.unifiedHint')}</p>
            <div className="grid grid-cols-3 gap-3">
              {pickerItemsFiltered.map(item => {
                if (item.kind === 'entry') return renderPickerButton(item.entry);
                const pr = item.provider;
                const m = meta[pr.id] || {};
                const isChatgptWeb = item.kind === 'chatgptweb';
                return (
                  <button key={item.key} type="button" title={m.hint || ''} onClick={() => {
                    // ChatGPT 网页：每点加一个独立账户实例（保持添加器打开，可连续加）
                    if (isChatgptWeb) addChatgptWebInstance();
                    else updateProvider(pr.id, { enabled: true });
                  }}
                    className="tb-soft-tile w-full flex items-center gap-2.5 px-3 py-3 rounded-xl text-left text-sm font-medium text-zinc-600 dark:text-zinc-400">
                    <span className="text-lg shrink-0">{m.icon || pr.icon || '🔌'}</span>
                    <span className="min-w-0 flex-1 truncate">{m.label || pr.label || pr.id}</span>
                    {isChatgptWeb ? (
                      item.count > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 shrink-0">{t('providers.add.instanceCount', { n: item.count })}</span>
                    ) : (m.keyless || pr.type === 'free') && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 shrink-0">{t('providers.add.freeTag')}</span>
                    )}
                  </button>
                );
              })}
              {pickerItemsFiltered.length === 0 && paidAccountsLoaded && (
                <p className="col-span-3 text-xs text-zinc-400 text-center py-4">{t('providers.filter.pickerEmpty')}</p>
              )}
            </div>
            {pickerItems.length === 0 && hasGatewayPaid && (
              <p className="text-xs text-zinc-400">{t('providers.add.allAdded')}</p>
            )}
          </div>
        )}
      </div>
    );
  }

  function pickerInstanceCount(entry) {
    const k = entry.templateKey;
    if (!k) return 0;
    // APP 订阅：直连登记或已转 API 均算已添加
    if (entry.template?.kind === 'app_sub' || entry.statsOnly || entry.authMode === 'stats' || entry.authMode === 'sub') {
      const agentId = entry.directAgentId || entry.template?.agent_id || k;
      const converted = userSubscriptions.some(
        s => s.source_id === k && s.subscription_to_api && s.subscription_kind !== 'api',
      );
      if (converted) return 1;
      return (directBilling && directBilling[agentId]) ? 1 : 0;
    }
    return userSubscriptions.filter(s => s.source_id === k).length
      + userPayg.filter(p => p.provider_id === k).length;
  }

  function renderPickerButton(entry) {
    const count = pickerInstanceCount(entry);
    const isFree = isFreeTierTemplate(entry.template) || entry.personalTag === 'free';
    const authTag = entry.authMode === 'oauth' ? 'OAuth'
      : entry.authMode === 'stats' ? t('providers.add.statsTag')
      : entry.authMode === 'sub' ? t('psrc.direct.subTag')
      : 'Key';
    return (
      <button key={entry.pickerKey} type="button" onClick={() => selectPickerEntry(entry)}
        className="tb-soft-tile w-full flex items-center gap-2.5 px-3 py-3 rounded-xl text-left">
        <ServiceIcon
          id={entry.providerId || entry.templateKey}
          name={entry.label}
          icon={entry.icon}
          baseUrl={entry.template?.base_url}
          signupUrl={entry.template?.signup_url}
          boxClass="w-10 h-10"
          imgClass="w-6 h-6"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium truncate text-zinc-800 dark:text-zinc-200">
            {entry.label}
          </span>
          <span className="flex flex-wrap items-center gap-1 mt-0.5">
            {/* 免费仅用标签区分，不再套青绿描边（与玻璃边冲突） */}
            {isFree && (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-emerald-100/90 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
                {t('providers.add.freeTag')}
              </span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              entry.authMode === 'oauth'
                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                : entry.authMode === 'stats'
                  ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
                  : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
            }`}>{authTag}</span>
            {count > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                {t('providers.add.instanceCount', { n: count })}
              </span>
            )}
          </span>
        </span>
      </button>
    );
  }

  /** 个人源列表行摘要：名称 / 图标 / 类型 / 模型数 / 状态（配置细节仍在原卡片里） */
  function sourceSummary(row) {
    if (row.type === 'chatgptweb') {
      const p = row.provider;
      return {
        key: `cw:${p.id}`, row, name: p.label || p.id, iconProps: { id: p.id, icon: '🌐' },
        tag: 'free', enabled: p.enabled !== false, models: (p.models || []).length, cooldown: null, verified: false,
        gwIds: [p.id], modelNames: modelNameList(p.models),
      };
    }
    if (row.type === 'extra') {
      const p = liveStateOf(row.provider);
      const inst = accountInstances.find(i => i.gateway_id === p.id);
      const m = resolveMetaForGateway(p.id, meta, inst, oauthById) || {};
      return {
        key: `x:${p.id}`, row, name: m.label || p.label || p.id,
        iconProps: { id: p.id, icon: m.icon, baseUrl: p.base_url },
        tag: getPersonalSourceTag(p, meta, userPayg, userSubscriptions),
        enabled: p.enabled !== false, models: (p.models || []).length,
        cooldown: cooldownFor(p.id, inst?.gateway_id, inst?.source_id), verified: p.test_verified === true,
        gwIds: [p.id], modelNames: modelNameList(p.models),
        usageProvider: usageProviderOf(p, inst),
      };
    }
    const inst = row.inst;
    const gw = inst.gateway_id;
    const prov = gw ? providers.find(p => p.id === gw) : null;
    // 模型数：直接按账户解析（模型视图会跳过已停用源，这里停用也要显示已登记数）
    const models = resolveModelsForModelView(inst, providers, userPayg, userSubscriptions, pricingOverrides, directByAgent) || [];
    const direct = row.type === 'direct' ? row.direct : null;
    return {
      key: `i:${inst.id}`, row, name: inst.name || inst.label || gw || inst.id,
      iconProps: { id: inst.source_id || inst.provider_id || gw, icon: inst.icon, baseUrl: prov?.base_url },
      tag: inst.tag,
      enabled: direct ? true : prov?.enabled !== false,
      models: models.length,
      cooldown: direct ? cooldownFor(direct.agent_id, direct.source_id, direct.id) : cooldownFor(gw, prov?.id, inst.source_id),
      verified: prov?.test_verified === true,
      gwIds: [gw, prov?.id, direct?.agent_id].filter(Boolean), modelNames: modelNameList(models),
      usageProvider: direct ? usageProviderForDirect(inst) : (prov ? usageProviderOf(prov, inst) : null),
    };
  }

  /** 与卡片内 UsageMeter 同口径：API 订阅按 plan_provider_id 抓取 */
  function usageProviderOf(provider, inst) {
    const pid = inst?.plan_provider_id || provider.id;
    return pid && pid !== provider.id ? { ...provider, id: pid } : provider;
  }

  function modelNameList(list) {
    return (list || [])
      .map(m => (typeof m === 'string' ? m : (m?.name || m?.id || '')))
      .map(n => String(n).trim())
      .filter(Boolean);
  }

  /** 依赖本源的场景路由 / 智能体（按供给源 id 钉选或按模型名匹配） */
  function dependentsOf(sm) {
    const ids = new Set(sm.gwIds || []);
    const names = new Set(sm.modelNames || []);
    const routes = (dependents.routes || []).filter(r => (r.steps || []).some(st => (
      (st.provider && ids.has(st.provider)) || names.has(st.model || st.label || '')
    )));
    const assistants = (dependents.assistants || []).filter(a => a.model && names.has(a.model));
    return { routes, assistants };
  }

  function renderDependents(sm) {
    const { routes, assistants } = dependentsOf(sm);
    return (
      <section className="mb-3 rounded-xl border border-zinc-100 dark:border-white/[0.06] px-3 py-2.5">
        <h3 className="text-[11px] font-medium text-zinc-400 mb-2">{t('providers.link.usedBy')}</h3>
        {routes.length === 0 && assistants.length === 0 ? (
          <p className="text-[11px] text-zinc-400">{t('providers.link.unused')}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {routes.map(r => (
              <button key={`r-${r.id || r.model_key}`} type="button"
                onClick={() => navigate('/gateway', { state: { gatewayTab: 'routes' } })}
                title={t('providers.link.routeHint')}
                className="text-[11px] px-2 py-0.5 rounded-md bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 hover:underline">
                {t('providers.link.route')} · {r.scene_name || r.model_key || r.id}
              </button>
            ))}
            {assistants.map(a => (
              <button key={`a-${a.id}`} type="button"
                onClick={() => navigate('/resources', { state: { resourceType: 'assistant', selectKey: `r-${a.id}` } })}
                className="text-[11px] px-2 py-0.5 rounded-md bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 hover:underline">
                {t('providers.link.assistant')} · {a.name}
              </button>
            ))}
          </div>
        )}
        {!sm.enabled || routes.length + assistants.length === 0 ? null : (
          <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-2">{t('providers.link.disableWarn')}</p>
        )}
      </section>
    );
  }

  function sourceStatus(sm) {
    if (sm.cooldown) return { dot: 'bg-amber-400', label: t('providers.list.cooling') };
    if (!sm.enabled) return { dot: 'bg-zinc-300 dark:bg-zinc-600', label: t('providers.list.disabled') };
    if (sm.verified) return { dot: 'bg-emerald-500', label: t('providers.list.ready') };
    return { dot: 'bg-sky-400', label: t('providers.list.enabled') };
  }

  function renderSourceRow(sm, sel) {
    const st = sourceStatus(sm);
    return (
      <li
        key={sm.key}
        role="option"
        aria-selected={sel}
        onClick={() => setSelectedSourceKey(sel ? null : sm.key)}
        className={`${libRowCls(sel)} grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_9rem_4rem_6.5rem]`}
      >
        <LibraryRowTitle
          logo={(
            <ServiceIcon
              id={sm.iconProps.id}
              name={sm.name}
              icon={sm.iconProps.icon}
              baseUrl={sm.iconProps.baseUrl}
              boxClass="w-9 h-9 !bg-zinc-100/80 dark:!bg-zinc-800/80 !rounded-xl"
              imgClass="w-5 h-5"
            />
          )}
          name={sm.name}
          chips={!sm.cooldown && sm.usageProvider && sm.enabled ? (
            <span className="ml-1.5 shrink-0 text-[11px] text-zinc-500 dark:text-zinc-400 empty:hidden">
              <UsageInline provider={sm.usageProvider} />
            </span>
          ) : undefined}
          sub={sm.cooldown ? t('providers.list.coolingHint') : undefined}
          subClass="text-amber-600 dark:text-amber-400"
        />
        <div className="hidden md:flex items-center gap-1.5 min-w-0 text-[11px] text-zinc-600 dark:text-zinc-300">
          <PersonalTypeIcon tag={sm.tag} />
          <span className="truncate">{t(`providers.filter.${(PERSONAL_TYPE_BADGE[sm.tag] || PERSONAL_TYPE_BADGE.payg).filterKey}`)}</span>
        </div>
        <span className="hidden md:block text-right text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">{sm.models || '—'}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
          <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} aria-hidden />
          {st.label}
        </span>
      </li>
    );
  }

  /** 原配置卡（详情面板内展示，保留全部编辑 / 测速 / 计费逻辑） */
  function renderSourceCard(row) {
    if (row.type === 'chatgptweb') {
      return <ChatGptCard key={row.provider.id} provider={row.provider} onRemove={removeChatgptWebInstance} />;
    }
    if (row.type === 'direct') {
      const d = row.direct;
      return (
        <DirectSourceCard key={d.agent_id} instance={{ ...d, _allBilling: directBilling }} t={t}
          allowApiBilling={d.allow_api_billing === true}
          canConvertToApi={d.can_convert_to_api === true}
          onConvertToApi={convertDirectToApi}
          cooldown={cooldownFor(d.agent_id, d.source_id, d.id)}
          onRetryCooldown={handleRetryCooldown}
          onSave={async (patch) => { await saveAccountsPatch(patch); }}
          onRemove={removeDirectSource} />
      );
    }
    if (row.type === 'extra') {
      const p = row.provider;
      const live = liveStateOf(p);
      const extraInst = accountInstances.find(i => i.gateway_id === live.id);
      const extraMeta = resolveMetaForGateway(live.id, meta, extraInst, oauthById);
      const useCustomCard = shouldUseCustomProviderCard(live.id, userSubscriptions, extraInst, extraMeta);
      return !useCustomCard
        ? <ProviderCard initialExpanded key={live.id} provider={live} meta={extraMeta} onUpdate={updateProvider} onRemove={removePersonalProvider} onTest={testProvider} onPersistEnabled={persistProviderEnabled} onPersistTier={persistProviderTier} gatewayAuthMode={resolveCardAuthMode(live, providerGatewayAuth[live.id], extraInst)} userPayg={userPayg} userSubscriptions={userSubscriptions} onEditPricing={openTemplateEditForProvider} providerPricing={mergedProviderPricing} paygCatalog={paygCatalog} subscriptionCatalog={subscriptionCatalog} accountInst={extraInst} cooldown={cooldownFor(live.id, extraInst?.gateway_id, extraInst?.source_id)} {...accountBillingProps} />
        : <CustomProviderCard key={live.id} provider={live} onUpdate={updateProvider} onRemove={removePersonalProvider} onTest={testProvider} onPersistEnabled={persistProviderEnabled} onPersistTier={persistProviderTier} userPayg={userPayg} userSubscriptions={userSubscriptions} onEditPricing={openTemplateEditForProvider} providerPricing={mergedProviderPricing} paygCatalog={paygCatalog} accountInst={extraInst} cooldown={cooldownFor(live.id, extraInst?.gateway_id, extraInst?.source_id)} {...accountBillingProps} />;
    }
    const inst = row.inst;
    const gwId = inst.gateway_id;
    const live = resolveProviderStubForInstance(inst, providers, meta, userPayg, userSubscriptions);
    const cardMeta = resolveMetaForGateway(gwId, meta, inst, oauthById);
    const useCustomCard = shouldUseCustomProviderCard(gwId, userSubscriptions, inst, cardMeta);
    return !useCustomCard
      ? <ProviderCard initialExpanded key={inst.id} provider={live} meta={cardMeta} onUpdate={updateProvider} onRemove={() => removeAccountInstance(inst)} onTest={testProvider} onPersistEnabled={persistProviderEnabled} onPersistTier={persistProviderTier} gatewayAuthMode={resolveCardAuthMode(live, providerGatewayAuth[gwId], inst)} userPayg={userPayg} userSubscriptions={userSubscriptions} onEditPricing={openTemplateEditForProvider} providerPricing={mergedProviderPricing} paygCatalog={paygCatalog} subscriptionCatalog={subscriptionCatalog} displayName={inst.name} displayIcon={inst.icon} lockTemplate accountInst={inst} cooldown={cooldownFor(gwId, live.id, inst.source_id)} {...accountBillingProps} />
      : <CustomProviderCard key={inst.id} provider={live} onUpdate={updateProvider} onRemove={() => removeAccountInstance(inst)} onTest={testProvider} onPersistEnabled={persistProviderEnabled} onPersistTier={persistProviderTier} userPayg={userPayg} userSubscriptions={userSubscriptions} onEditPricing={openTemplateEditForProvider} providerPricing={mergedProviderPricing} paygCatalog={paygCatalog} accountInst={inst} cooldown={cooldownFor(gwId, live.id, inst.source_id)} {...accountBillingProps} />;
    return null;
  }

  function renderSourcesViewTabs() {
    return (
      <div className="inline-flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden text-xs shrink-0">
        <button type="button" onClick={() => setSourcesView('model')}
          className={`px-2.5 py-1 ${sourcesView === 'model' ? 'bg-zinc-100 dark:bg-zinc-700 font-medium' : 'text-zinc-400'}`}>{t('psrc.view.model')}</button>
        <button type="button" onClick={() => setSourcesView('list')}
          className={`px-2.5 py-1 ${sourcesView === 'list' ? 'bg-zinc-100 dark:bg-zinc-700 font-medium' : 'text-zinc-400'}`}>{t('psrc.view.list')}</button>
      </div>
    );
  }

  return (
    <div className="px-4 py-4 space-y-5">

      {/* Header：与资源页同构（标题 + 副标题 + 下划线 Tab） */}
      <div>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50 tracking-tight">{t('providers.title')}</h1>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
          {t('providers.subtitle')}
        </p>
      </div>

      <>
      {/* 个人源：标题独立于 panel；统计 + 已添加卡片 + 添加源 */}
      <section className="space-y-3">
        <SourceSectionHeader
          dot={tierConfig.local.dot}
          title={tierConfig.local.label}
          hint={tierConfig.local.hint}
        />

        {/* 不套外层玻璃：子卡直接浮在主区，立体与毛玻璃才看得见（Apple：勿叠浅色半透明） */}
        <div className="space-y-4">
        {sourcesView !== 'model' && (
          <div className="flex items-center justify-between gap-x-3 gap-y-2 min-w-0 flex-wrap">
            <PersonalFilterBar value={personalFilter} onChange={setPersonalFilter} t={t} />
            {renderSourcesViewTabs()}
          </div>
        )}

        {accountsData && (
          <SyncDiffBanner syncDiff={accountsData.sync_diff} t={t}
            onAdoptServer={adoptServerTemplate} onDismissDrift={adoptServerTemplate} />
        )}

        {accountSyncHint && (
          <p className="text-xs text-zinc-500">{accountSyncHint}</p>
        )}
        {sourcesView === 'model' ? (
          <PersonalSourceModelView
            instances={modelViewInstances}
            t={t}
            modelTypeMap={personalModelTypeMap}
            latencyMap={personalLatencyMap}
            onRefreshLatency={loadPersonalLatency}
            trailing={renderSourcesViewTabs()}
            probeTargets={personalProbeTargets}
            cooldownFor={cooldownFor}
            onEmptyAdd={() => { setSourcesView('list'); setPickerOpen(true); }}
            onEmptySync={syncAccountsFromOtherDevices}
            syncing={accountSyncing}
          />
        ) : (
        <>
        {(() => {
          const summaries = personalSourceRows.map(sourceSummary);
          const sel = summaries.find(x => x.key === selectedSourceKey);
          return (
            <div className="flex gap-4 items-start">
              <div className="flex-1 min-w-0">
                {summaries.length === 0 ? (
                  <div className={`${LIB_LIST_CLS} text-xs text-zinc-400 text-center py-8`}>{t('providers.filter.empty')}</div>
                ) : (
                  <div className={LIB_LIST_CLS}>
                    <div className="hidden md:grid md:grid-cols-[minmax(0,1fr)_9rem_4rem_6.5rem] gap-3 px-4 py-2 text-[11px] text-zinc-400 border-b border-zinc-100 dark:border-white/[0.05]">
                      <span>{t('providers.list.name')}</span>
                      <span>{t('providers.list.type')}</span>
                      <span className="text-right">{t('providers.list.models')}</span>
                      <span>{t('providers.list.status')}</span>
                    </div>
                    <ul role="listbox" aria-label={tierConfig.local.label}>
                      {summaries.map(sm => renderSourceRow(sm, sm.key === selectedSourceKey))}
                    </ul>
                  </div>
                )}
              </div>
              {sel && (
                <LibraryPanel title={t('providers.list.detail')} closeLabel={t('providers.list.close')} onClose={() => setSelectedSourceKey(null)}>
                  {renderDependents(sel)}
                  {renderSourceCard(sel.row)}
                </LibraryPanel>
              )}
            </div>
          );
        })()}
        {renderAddSourcePicker()}
        </>
        )}
        </div>
      </section>

      {/* 社区源：未登录可浏览，启用/配置 Key 需登录 */}
      <section className="space-y-3 pt-4">
        <SourceSectionHeader
          dot={tierConfig.p2p.dot}
          title={t('providers.group.remote')}
          hint={tierConfig.p2p.hint}
        />
        <div className={`grid ${tierConfig.p2p.cols} gap-3`}>
          {providers.filter(p => p.type === 'p2p').map(p => (
            <P2PNetworkCard key={p.id} provider={p} onUpdate={updateProvider} onPersistEnabled={persistProviderEnabled}
              cooldowns={cooldowns} onRetryCooldown={handleRetryCooldown} />
          ))}
        </div>
      </section>
      </>

      {/* 添加实例后：凭证配置弹窗（复用 ProviderCard 的 API key / OAuth 配置，含 Claude 粘 code）*/}
      {credModalKey && (() => {
        const gwId = OAUTH_SUB_SOURCE_TO_PID[credModalKey] || credModalKey;
        const p = personalPoolAll.find(pr => pr.id === gwId) || providers.find(pr => pr.id === gwId);
        const live = p ? liveStateOf(p) : null;
        const acct = live && (
          accountInstances.find(i => i.gateway_id === live.id)
          || accountInstances.find(i => OAUTH_SUB_SOURCE_TO_PID[i.source_id] === live.id)
        );
        const credMeta = resolveMetaForGateway(gwId, meta, acct, oauthById);
        const useCustomCard = live && shouldUseCustomProviderCard(live.id, userSubscriptions, acct, credMeta);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setCredModalKey(null)}>
            <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-lg p-5 space-y-3 max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('providers.cred.title')}</h3>
              <p className="text-xs text-zinc-400">{t('providers.cred.hint')}</p>
              {!live ? (
                <p className="text-xs text-zinc-400 py-6 text-center">{t('providers.add.loadingAccounts')}</p>
              ) : !useCustomCard ? (
                <ProviderCard provider={live} meta={credMeta} onUpdate={updateProvider} onRemove={removeAccountSource} onTest={testProvider} onPersistEnabled={persistProviderEnabled} onPersistTier={persistProviderTier} initialExpanded lockTemplate gatewayAuthMode={resolveCardAuthMode(live, providerGatewayAuth[gwId], acct)} userPayg={userPayg} userSubscriptions={userSubscriptions} onEditPricing={openTemplateEditForProvider} providerPricing={mergedProviderPricing} paygCatalog={paygCatalog} subscriptionCatalog={subscriptionCatalog} displayName={acct?.name} displayIcon={acct?.icon} accountInst={acct} {...accountBillingProps} />
              ) : (
                <CustomProviderCard provider={live} onUpdate={updateProvider} onRemove={removeAccountSource} onTest={testProvider} onPersistEnabled={persistProviderEnabled} onPersistTier={persistProviderTier} userPayg={userPayg} userSubscriptions={userSubscriptions} onEditPricing={openTemplateEditForProvider} providerPricing={mergedProviderPricing} paygCatalog={paygCatalog} accountInst={acct} {...accountBillingProps} />
              )}
              <div className="flex justify-end pt-1">
                <button type="button" onClick={() => setCredModalKey(null)} className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 text-white">{t('providers.cred.done')}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 定价策略编辑（账户类型级，影响该类型下所有实例的计费基准） */}
      {templateEditing && (
        <TemplateEditModal template={templateEditing}
          overrides={accountsData?.source_template_overrides || {}}
          payg={userPayg} subs={userSubscriptions}
          customTemplates={accountsData?.custom_source_templates || {}}
          paygCatalog={paygCatalog}
          editOnly
          onSave={(patch) => saveAccountsPatch(patch)}
          onClose={() => setTemplateEditing(null)} t={t} />
      )}
    </div>
  );
}
