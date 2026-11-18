// 本地网关可选模型：统一从 /v1/models 拉取（OpenAI 列表格式），网关页与调试页共用
import { readHiddenModels } from '../lib/hidden-models';
import { getConfig, getGateway, getLocalConfig, getApps, isElectron } from './adapter';
import { getServerUrl, normalizeServerBase } from '../config';
import { loadUserAccounts } from './userAccounts';
import { fetchServerCommunityModels } from '../lib/communityModels';
import { claudeMaskModelSet } from '../lib/claudeMaskModels';
import {
  collectPersonalAvailableModels,
  enrichProvidersForRouting,
  mergeAccountsForGateway,
} from '../lib/personalAvailableModels';

const modelId = (m) => (typeof m === 'string' ? m : (m?.name || m?.id || ''));

/** Claude Desktop 透明 mask 名：下拉不展示（Electron IPC / CLI admin-api / 内置默认） */
async function loadClaudeMaskModelSet() {
  try {
    const extra = await getApps().claudeModels?.();
    if (Array.isArray(extra) && extra.length) return claudeMaskModelSet(extra);
  } catch {}
  return claudeMaskModelSet();
}

function filterClaudeMaskModels(models, maskSet) {
  if (!maskSet?.size) return models || [];
  // 只屏蔽"透明 mask 名"：仅 Claude Desktop 内部校验用的透明名（来自 /v1/models、无 personal 标识）。
  // 保留：① 社区 P2P 真实提供的同名 claude（可路由目标）；② 用户显式注册的个人源 claude（personal 标识），
  // 否则个人 anthropic 源的 claude-opus-4-8 等会被同名透明名连带误删。
  return (models || []).filter(m => m.tier === 'p2p' || m.personal || !maskSet.has(m.id));
}

/** 本地 gateway HTTP 主机名：Electron 固定 127.0.0.1；Docker/CLI Web 用浏览器 hostname，便于远程调试 */
export function resolveLocalGatewayHost() {
  if (isElectron()) return '127.0.0.1';
  const h = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';
  if (!h || h === 'localhost' || h === '127.0.0.1') return '127.0.0.1';
  return h;
}

/** 本地 gateway OpenAI 兼容 base URL（含 /v1 后缀） */
export function resolveLocalGatewayBase(port) {
  const p = port || 11430;
  return `http://${resolveLocalGatewayHost()}:${p}/v1`;
}

/** 根据 /v1/models 条目的 owned_by 推断 free | p2p | paid */
function tierFromOwnedBy(owned, provById = {}) {
  const ob = String(owned || '').trim();
  // Claude 透明名：仅供 Claude Desktop 校验，下拉不展示
  if (!ob || ob === 'anthropic') return null;
  if (ob === 'p2p' || ob === 'tokenbank-p2p' || ob === 'local') return 'p2p';
  const prov = provById[ob];
  if (prov?.type === 'free') return 'free';
  if (prov?.type === 'p2p') return 'p2p';
  if (prov?.type === 'paid') return 'paid';
  // 网关已暴露、配置里能匹配到 provider id → 视为个人付费层
  if (prov) return 'paid';
  return null;
}

/**
 * 解析 OpenAI 风格模型列表：{ object: 'list', data: [{ id, owned_by, ... }] }
 * @returns {Array<{ id: string, tier: 'free'|'p2p'|'paid' }>}
 */
export function parseV1ModelsResponse(json, provById = {}) {
  const out = [];
  const seen = new Set();
  for (const m of json?.data || []) {
    const id = m?.id;
    if (!id) continue;
    const tier = tierFromOwnedBy(m.owned_by, provById);
    if (!tier) continue;
    const owner = String(m.owned_by || '').trim();
    // 同一模型挂在多家供给源上时各留一条，下拉才能写成 providerId:模型名
    const k = `${tier}:${owner}:${id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const mtype = m?.model_type;
    out.push({
      id,
      tier,
      // 供给源 id（owned_by）：游乐场据此识别「仅透传客户端凭证」的源（如 Claude Code 订阅）
      ...(m.owned_by ? { owner: m.owned_by } : {}),
      ...(mtype && mtype !== 'chat' ? { type: mtype } : {}),
    });
  }
  return out;
}

async function fetchV1ModelsJson(baseUrl, headers = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, { headers });
  if (!res.ok) return null;
  return res.json();
}

/** 拉取前先同步云端 P2P 模型到本地 gateway 缓存（社区源关闭时跳过） */
async function refreshPeerModelsCache(cfg) {
  if (cfg && !isCommunityP2pEnabled(cfg)) return;
  try {
    if (isElectron() && window.electronAPI?.gateway?.refreshPeerModels) {
      await window.electronAPI.gateway.refreshPeerModels();
    } else {
      await fetch('/api/gateway/refresh-peer-models', { method: 'POST' });
    }
  } catch {}
}

/** 读取本地 gateway 原始 /v1/models JSON（网关未启动时返回 null） */
async function fetchLocalGatewayV1ModelsJson() {
  // CLI / Docker Web：优先走 admin-api 同源代理，避免跨端口失败误回退云端社区列表
  if (!isElectron()) {
    try {
      const base = import.meta.env?.VITE_ADMIN_BASE ?? '';
      const res = await fetch(`${base}/api/gateway/v1-models`);
      if (res.ok) {
        const json = await res.json();
        if (json && typeof json === 'object') return json;
      }
    } catch {}
  }

  let gwPort = null;
  let gwRunning = false;
  try {
    const gw = await getGateway().status();
    gwPort = gw?.port || null;
    gwRunning = !!gw?.running;
  } catch {}
  if (!gwPort || !gwRunning) return null;

  try {
    const host = resolveLocalGatewayHost();
    return await fetchV1ModelsJson(`http://${host}:${gwPort}`);
  } catch {
    return null;
  }
}

/** 仅本地网关的 /v1/models 原始 JSON，不回退云端（智能功能可用性检测用） */
export function fetchLocalGatewayModelsJsonOnly() {
  return fetchLocalGatewayV1ModelsJson();
}

/** 本地网关 /v1/models（网关未启动时返回 null） */
async function fetchLocalGatewayV1Models(provById) {
  const json = await fetchLocalGatewayV1ModelsJson();
  if (!json) return null;
  const models = parseV1ModelsResponse(json, provById);
  // 本地网关已响应时不再回退云端（空列表亦如此），避免 CLI Web 误注入社区模型
  if (json.object === 'list') return models;
  return models.length ? models : null;
}

/**
 * 云端 /v1/models（网关未运行时回退，主要为社区 P2P）。
 * 仅接受 cloud_config API Key，不能用登录 JWT。
 */
async function fetchCloudV1ModelsJson() {
  try {
    const cfg = await getLocalConfig().get().catch(() => null);
    const base = normalizeServerBase(cfg?.cloud_config?.url || getServerUrl());
    const apiKey = cfg?.cloud_config?.token;
    if (!base || !apiKey) return null;

    if (typeof window !== 'undefined' && window.electronAPI?.auth?.request) {
      const r = await window.electronAPI.auth.request({
        base, method: 'GET', path: '/v1/models', token: apiKey,
      });
      if (r.status < 200 || r.status >= 300 || !r.body) return null;
      return JSON.parse(r.body);
    }

    return await fetchV1ModelsJson(base, { Authorization: `Bearer ${apiKey}` });
  } catch {
    return null;
  }
}

async function fetchCloudV1Models(provById) {
  const json = await fetchCloudV1ModelsJson();
  return json ? parseV1ModelsResponse(json, provById) : [];
}

/** 按 tier + 供给源 + id 合并。同名模型可以挂在多家供给源上。 */
function mergeModelEntriesByTier(existing, additions) {
  const entryKey = (m) => `${m.tier}:${m.owner || ''}:${m.id}`;
  const byKey = new Map(existing.map(m => [entryKey(m), m]));
  for (const m of additions) {
    const key = entryKey(m);
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, ...m, type: m.type || prev.type } : m);
  }
  return [...byKey.values()];
}

/** 补全供给源登记的个人模型（与 /v1/models 并存，不覆盖同 id 的社区层） */
function mergePersonalModelsFromAccounts(models, cfg, acc) {
  const mergedAccounts = mergeAccountsForGateway(cfg || {}, acc || {});
  const personal = collectPersonalAvailableModels(cfg || {}, mergedAccounts)
    .filter(m => m.tier !== 'p2p');
  return mergeModelEntriesByTier(models, personal);
}

/** 与网关下拉同源：优先本地 /v1/models，否则云端 */
export async function fetchGatewayV1ModelsJson() {
  let cfg = null;
  try { cfg = await getConfig().read().catch(() => null); } catch {}
  if (isCommunityP2pEnabled(cfg)) await refreshPeerModelsCache(cfg);
  const local = await fetchLocalGatewayV1ModelsJson();
  if (local && local.object === 'list') return local;
  if (local?.data?.length) return local;
  return fetchCloudV1ModelsJson();
}

/** 社区分享网络（tokenbank-p2p）是否在供给源中启用 */
export function isCommunityP2pEnabled(cfg) {
  const p = (cfg?.providers || []).find(x => x.id === 'tokenbank-p2p' || x.type === 'p2p');
  if (!p) return true;
  return p.enabled !== false;
}

/**
 * 网关下拉可选模型：优先本地网关 /v1/models，与 OpenAI 列表接口一致。
 * @param {{ includeCommunity?: boolean }} [opts] includeCommunity=false 时排除社区 P2P 层（未登录或已关闭社区源）
 * @returns {Promise<Array<{ id: string, tier: 'free'|'p2p'|'paid' }>>}
 */
export async function loadGatewayAvailableModels(opts = {}) {
  let cfg = null;
  let acc = null;
  let provById = {};
  const maskSet = await loadClaudeMaskModelSet();
  try {
    [cfg, acc] = await Promise.all([
      getConfig().read().catch(() => null),
      loadUserAccounts({ localOnly: true }).catch(() => null),
    ]);
    provById = Object.fromEntries((cfg?.providers || []).map(p => [p.id, p]));
  } catch {}

  const includeCommunity = (opts.includeCommunity !== false) && isCommunityP2pEnabled(cfg);

  if (includeCommunity) await refreshPeerModelsCache(cfg);
  const local = await fetchLocalGatewayV1Models(provById);
  let models = local != null ? local : [];

  if (local == null) {
    try {
      models = await fetchCloudV1Models(provById);
    } catch (e) {
      console.error('loadGatewayAvailableModels', e);
      models = [];
    }
  }

  // 补全 /v1/models 未覆盖的个人登记模型（如仅写在刊例价覆盖里、或与社区同名）
  models = mergePersonalModelsFromAccounts(models, cfg, acc);

  // 社区层与云端 /v1/models 一致（worker 可见性由服务端处理）；个人层仍来自本地 /v1/models
  if (includeCommunity) {
    try {
      const { entries } = await fetchServerCommunityModels();
      models = mergeModelEntriesByTier(models.filter(m => m.tier !== 'p2p'), entries);
    } catch { /* 离线时保留本地解析的 p2p */ }
  } else {
    models = models.filter(m => m.tier !== 'p2p');
  }
  models = filterClaudeMaskModels(models, maskSet);
  // 模型页里关了「在别处可选」的模型：选模型时不列出（个人和社区来源都算）
  if (!opts.includeHidden) {
    const hidden = readHiddenModels(cfg);
    if (hidden.size) models = models.filter(m => !hidden.has(modelId(m)));
  }
  return attachProviderNames(enrichModelsWithType(models, cfg, acc), provById);
}

/** 记下供给源显示名。下拉文案用 owner（provider id），不用这个显示名。 */
function attachProviderNames(models, provById = {}) {
  const skip = new Set(['p2p', 'tokenbank-p2p', 'local', 'anthropic', 'tokenbank']);
  return (models || []).map(m => {
    const owner = String(m?.owner || '').trim();
    if (!owner || skip.has(owner)) return m;
    const p = provById[owner];
    const providerName = String(p?.displayName || p?.label || owner).trim();
    if (!providerName) return m;
    return { ...m, providerName };
  });
}

/** 模型名启发式推断模态（账户/供给源未标注时兜底） */
export function inferModelTypeFromName(id) {
  const n = String(id || '').toLowerCase();
  if (/(?:^|[\-_/])image(?:[\-_/]|$|\d)|gpt-image|dall-e|stable-diffusion|flux-|midjourney/.test(n)) {
    return 'image';
  }
  if (/embed|text-embedding|bge-|e5-/.test(n)) return 'embedding';
  return 'chat';
}

function ingestModelType(map, m) {
  const id = modelId(m);
  if (!id) return;
  const t = typeof m === 'string' ? null : (m.type || m.modality);
  if (t && t !== 'chat') map[id] = t;
}

/** 供给源 models 列表 → id → type 映射（含账户登记模型） */
export function buildModelTypeMap(providers = [], accounts = null) {
  const map = {};
  for (const p of providers) {
    for (const m of p.models || []) ingestModelType(map, m);
  }
  if (accounts) {
    for (const p of accounts.user_payg_providers || []) {
      for (const m of p.models || []) ingestModelType(map, m);
    }
    for (const s of accounts.user_subscriptions || []) {
      for (const m of s.models || []) ingestModelType(map, m);
    }
    for (const d of Object.values(accounts.direct_source_billing || {})) {
      for (const m of d.models || []) ingestModelType(map, m);
    }
  }
  return map;
}

/** 个人源页 / 路由下拉共用的 type 映射 */
export function buildPersonalModelTypeMap(cfg, accounts) {
  const merged = mergeAccountsForGateway(cfg || {}, accounts || {});
  const providers = enrichProvidersForRouting(cfg?.providers || [], merged);
  return buildModelTypeMap(providers, merged);
}

/** 社区 P2P 模型（与云端 /v1/models 同源） */
export async function loadCommunityP2pModels(opts = {}) {
  let cfg = null;
  try { cfg = await getConfig().read().catch(() => null); } catch {}
  const includeCommunity = (opts.includeCommunity !== false) && isCommunityP2pEnabled(cfg);
  if (!includeCommunity) return [];
  const { entries } = await fetchServerCommunityModels();
  return entries;
}

/** 从供给源配置解析模型类型（chat / image / embedding） */
export function resolveGatewayModelType(id, cfg, accounts = null) {
  const typeMap = buildPersonalModelTypeMap(cfg, accounts);
  return typeMap[id] || inferModelTypeFromName(id);
}

/** 为下拉条目补全模态（供给源 + 账户 + 名称推断） */
export function enrichModelsWithType(models, cfg, accounts = null) {
  const typeMap = buildPersonalModelTypeMap(cfg, accounts);
  return (models || []).map(m => {
    const type = m.type || typeMap[m.id] || inferModelTypeFromName(m.id);
    if (type === 'chat') return m;
    return { ...m, type };
  });
}
