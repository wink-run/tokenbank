// catalog-sync.js — 后台拉 /api/catalog 写入 providers.registry.yaml；UI 只读 yaml
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const yaml = require('js-yaml');

const configLoader = require('./config-loader');
const { defaultServerUrlFromEnv } = require('../shared/default-server-url');

const USER_REGISTRY_YAML = path.join(os.homedir(), '.tokenbank', 'providers.registry.yaml');
const USER_COMMUNITY_CATALOG = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');
const COMMUNITY_SECTIONS = ['mcp', 'prompts', 'skills', 'assistants'];
const FETCH_TIMEOUT_MS = 12000;

let _syncInFlight = null;

function normalizeBase(url) {
  if (!url) return '';
  return String(url).trim().replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
}

/** 解析同步用的服务端根地址（设置页 URL 优先于 cloud_config，避免 CLI 指向旧服务器） */
function resolveSyncServerUrl(opts = {}) {
  const readCfg = opts.readLocalConfig || (() => ({}));
  return normalizeBase(
    opts.baseUrl
    || opts.serverUrl
    || readCfg()?.cloud_config?.url
    || process.env.TOKEN_SERVER_URL
    || process.env.TOKENBANK_SERVER_URL
    || defaultServerUrlFromEnv(),
  );
}

/** GET /api/config/providers → registry yaml 文档（需登录 JWT） */
function fetchRegistryYaml(baseUrl, token) {
  const base = normalizeBase(baseUrl);
  if (!base || !token) return Promise.resolve(null);
  const url = `${base}/api/config/providers`;
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          resolve(null);
          return;
        }
        try { resolve(yaml.load(data) || null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** 写入完整 registry yaml（与 Electron applyRegistryDoc 对齐） */
function applyRegistryDoc(parsed, opts = {}) {
  if (!parsed || typeof parsed !== 'object') return false;
  let doc = { ...parsed };
  try {
    if (Array.isArray(doc.providers)) {
      doc.providers = mergeProvidersFromCatalog(null, doc.providers);
    }
  } catch (e) {
    console.warn('[catalog-sync] merge registry doc failed:', e.message);
  }
  writeRegistryDoc(doc);
  return true;
}

function finishSyncSideEffects(baseUrl, opts, extra = {}) {
  return fetchCatalogJson(baseUrl).then((catalogPayload) => {
    if (catalogPayload) {
      try {
        const billingConfig = require('./billing-config');
        billingConfig.setLiveCatalogPayload(catalogPayload);
      } catch {}
    }
    try {
      const billingConfig = require('./billing-config');
      const readLocalConfig = opts.readLocalConfig;
      const applyUserBillingCfg = opts.applyUserBillingCfg;
      if (readLocalConfig && applyUserBillingCfg) {
        const cfg = readLocalConfig();
        const { cfg: pruned, changed } = billingConfig.pruneLocalBillingAgainstServer(cfg);
        if (changed) applyUserBillingCfg(pruned);
      }
    } catch (e) {
      console.warn('[catalog-sync] prune billing failed:', e.message);
    }
    if (typeof opts.onApplied === 'function') opts.onApplied();
    return { ok: true, updated: true, ...extra };
  });
}

/** GET /api/catalog → JSON */
function fetchCatalogJson(baseUrl) {
  const base = normalizeBase(baseUrl);
  if (!base) return Promise.resolve(null);
  const url = `${base}/api/catalog`;
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) {
          resolve(null);
          return;
        }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** GET /api/community-catalog → JSON(公开,失败返回 null) */
function fetchCommunityCatalog(baseUrl) {
  const base = normalizeBase(baseUrl);
  if (!base) return Promise.resolve(null);
  const url = `${base}/api/community-catalog`;
  const mod = url.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = mod.get(url, { timeout: FETCH_TIMEOUT_MS }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode >= 400) { resolve(null); return; }
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** payload 至少一段非空才写缓存;写成功返回 true */
function writeCommunityCatalogCache(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const hasContent = COMMUNITY_SECTIONS.some(k => Array.isArray(payload[k]) && payload[k].length);
  if (!hasContent) return false;
  // 纠正误写的 type=agent，避免下次同步又污染本机库
  const assistants = (Array.isArray(payload.assistants) ? payload.assistants : []).map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.type !== 'agent') return item;
    return { ...item, type: 'assistant' };
  });
  const doc = {
    version: payload.version || 1,
    mcp: Array.isArray(payload.mcp) ? payload.mcp : [],
    prompts: Array.isArray(payload.prompts) ? payload.prompts : [],
    skills: Array.isArray(payload.skills) ? payload.skills : [],
    assistants,
  };
  const dir = path.dirname(USER_COMMUNITY_CATALOG);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(USER_COMMUNITY_CATALOG, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
  return true;
}

/** 后台拉社区目录并落缓存(失败静默) */
async function syncCommunityCatalog(opts = {}) {
  const baseUrl = resolveSyncServerUrl(opts);
  if (!baseUrl) return { ok: false };
  const payload = await fetchCommunityCatalog(baseUrl);
  const wrote = writeCommunityCatalogCache(payload);
  if (wrote) {
    try { require('./mcp-catalog').resetCatalogCache(); } catch {}
    try { require('./resource-catalog').resetCatalogCache(); } catch {}
  }
  return { ok: !!payload, wrote };
}

/** 将单条社区项（推荐/结算返回）立即写入本机社区缓存，便于纳管 */
function upsertCommunitySkillItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return false;
  const catalogId = String(rawItem.catalog_id || rawItem.catalogId || '').trim();
  const name = String(rawItem.name || '').trim();
  if (!catalogId || !name) return false;
  let rtype = String(rawItem.type || 'skill').trim().toLowerCase();
  if (rtype === 'agent') rtype = 'assistant';
  const section = rtype === 'prompt' ? 'prompts'
    : rtype === 'assistant' ? 'assistants'
      : 'skills';
  let doc = { version: 1, mcp: [], prompts: [], skills: [], assistants: [] };
  try {
    if (fs.existsSync(USER_COMMUNITY_CATALOG)) {
      const cur = yaml.load(fs.readFileSync(USER_COMMUNITY_CATALOG, 'utf8')) || {};
      doc = {
        version: cur.version || 1,
        mcp: Array.isArray(cur.mcp) ? cur.mcp : [],
        prompts: Array.isArray(cur.prompts) ? cur.prompts : [],
        skills: Array.isArray(cur.skills) ? cur.skills : [],
        assistants: Array.isArray(cur.assistants) ? cur.assistants : [],
      };
    }
  } catch { /* 用空文档 */ }
  const item = {
    catalog_id: catalogId,
    type: section === 'prompts' ? 'prompt' : (section === 'assistants' ? 'assistant' : 'skill'),
    name,
    display_name: rawItem.display_name || rawItem.displayName || name,
    description: rawItem.description || '',
    content: rawItem.content || '',
    metadata: rawItem.metadata && typeof rawItem.metadata === 'object' ? rawItem.metadata : {},
  };
  const bucket = (doc[section] || []).slice();
  const idx = bucket.findIndex(s => String(s?.catalog_id || s?.catalogId || '') === catalogId);
  if (idx >= 0) bucket[idx] = item;
  else bucket.push(item);
  doc[section] = bucket;
  return writeCommunityCatalogCache(doc);
}

/** catalog provider → registry.providers 条目 */
function catalogProviderToRegistry(p) {
  if (!p?.id) return null;
  const models = [];
  for (const m of p.models || []) {
    if (typeof m === 'string') {
      models.push({ id: m, modality: 'chat' });
    } else if (m && typeof m === 'object') {
      const id = String(m.name || m.id || m.model || '').trim();
      if (id) models.push({ id, modality: m.type || m.modality || 'chat' });
    }
  }
  // pricing 键补全 models
  const pricing = { ...(p.pricing && typeof p.pricing === 'object' ? p.pricing : {}) };
  for (const k of Object.keys(pricing)) {
    if (!k || k === '_excluded_models' || k === 'excluded_models') continue;
    const rates = pricing[k];
    const modality = (rates && typeof rates === 'object' && rates.image != null
      && rates.in == null && rates.out == null) ? 'image' : 'chat';
    if (!models.some(x => x.id === k)) models.push({ id: k, modality });
  }
  const out = {
    id: p.id,
    label: p.label || p.id,
    icon: p.icon || '🔧',
    tier: p.type || 'paid',
    hint: p.hint || '',
    base_url: p.base_url || '',
    handler: p.handler || 'openai',
    api_format: p.api_format || 'openai',
    enabled_default: !!p.enabled_default,
    keyless: !!p.keyless,
    key_prefix: Array.isArray(p.key_prefix) ? p.key_prefix : [],
    signup_url: p.signup_url || '',
    models,
    pricing,
  };
  if (p.payg) out.payg = true;
  if (p.modalities && typeof p.modalities === 'object') out.modalities = p.modalities;
  return out;
}

/** catalog 按量 provider → billing_sources 条目（个人源模板列表以 billing_sources 为准） */
function catalogProviderToBilling(p, existing) {
  if (!p?.id) return null;
  const pricing = { ...(p.pricing && typeof p.pricing === 'object' ? p.pricing : {}) };
  const models = [];
  const seen = new Set();
  const push = (id, modality = 'chat') => {
    const n = String(id || '').trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    models.push({ id: n, modality, pricing: pricing[n] || {} });
  };
  for (const m of p.models || []) {
    if (typeof m === 'string') push(m);
    else if (m && typeof m === 'object') push(m.name || m.id, m.type || m.modality || 'chat');
  }
  for (const k of Object.keys(pricing)) {
    const rates = pricing[k];
    const mod = (rates && typeof rates === 'object' && rates.image != null
      && rates.in == null && rates.out == null) ? 'image' : 'chat';
    push(k, mod);
  }
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    id: p.id,
    source_id: p.id,
    category: 'payg',
    label: p.label || existing?.label || p.id,
    icon: p.icon || existing?.icon || '🔧',
    tier: p.type || existing?.tier || 'paid',
    base_url: p.base_url || existing?.base_url || '',
    auth: existing?.auth || 'api_key',
    api_format: p.api_format || existing?.api_format || 'openai',
    handler: p.handler || existing?.handler || 'openai',
    hint: p.hint || existing?.hint || '',
    keyless: !!p.keyless,
    key_prefix: Array.isArray(p.key_prefix) ? p.key_prefix : (existing?.key_prefix || []),
    signup_url: p.signup_url || existing?.signup_url || '',
    enabled_default: !!p.enabled_default,
    models: models.length ? models : (existing?.models || []),
    pricing: Object.keys(pricing).length ? pricing : (existing?.pricing || {}),
    sort_order: existing?.sort_order ?? 0,
  };
}

/** catalog subscription_sources → billing_sources 条目 */
function subscriptionSourceToBilling(s, existing) {
  const sid = s.id;
  if (!sid) return null;
  const pricing = { ...(s.pricing && typeof s.pricing === 'object' ? s.pricing : {}) };
  const models = [];
  const seen = new Set();
  const push = (id, modality = 'chat') => {
    const n = String(id || '').trim();
    if (!n || seen.has(n)) return;
    seen.add(n);
    models.push({ id: n, modality, pricing: pricing[n] || {} });
  };
  for (const m of s.models || []) {
    if (typeof m === 'string') push(m);
    else if (m && typeof m === 'object') push(m.name || m.id, m.type || m.modality || 'chat');
  }
  for (const k of Object.keys(pricing)) {
    const rates = pricing[k];
    const mod = (rates && typeof rates === 'object' && rates.image != null
      && rates.in == null && rates.out == null) ? 'image' : 'chat';
    push(k, mod);
  }
  const kind = s.kind === 'api_sub' ? 'api_sub' : 'app_sub';
  return {
    ...(existing && typeof existing === 'object' ? existing : {}),
    id: existing?.id || sid,
    source_id: sid,
    category: kind,
    label: s.label || existing?.label || sid,
    icon: s.icon || existing?.icon || '🔧',
    agent_id: s.agent_id || existing?.agent_id || sid,
    plan_provider_id: s.plan_provider_id ?? existing?.plan_provider_id,
    subscription_to_api: s.subscription_to_api === true,
    base_url: s.base_url || existing?.base_url || '',
    api_format: s.api_format || existing?.api_format || 'openai',
    models: models.length ? models : (existing?.models || []),
    pricing: Object.keys(pricing).length ? pricing : (existing?.pricing || {}),
    plans: Array.isArray(s.plans) && s.plans.length ? s.plans : (existing?.plans || []),
    sort_order: existing?.sort_order ?? 0,
  };
}

/** 服务端 catalog 有列表时整表替换，不再并入内置 yaml。 */
function mergeProvidersFromCatalog(existingProviders, catalogProviders) {
  if (Array.isArray(catalogProviders) && catalogProviders.length) return catalogProviders;
  return existingProviders || [];
}

/** 合并 /api/catalog 到 registry yaml 文档 */
function mergeCatalogIntoRegistryDoc(existingDoc, catalogPayload) {
  const existing = existingDoc && typeof existingDoc === 'object' ? existingDoc : {};
  const catalogProviders = (catalogPayload?.providers || [])
    .map(catalogProviderToRegistry)
    .filter(Boolean);
  const providers = catalogProviders.length
    ? mergeProvidersFromCatalog(existing.providers, catalogProviders)
    : (existing.providers || []);

  // 服务端完整 billing_sources（与 admin 发布条数一致，避免仅 payg 标记/订阅段合并丢项）
  if (Array.isArray(catalogPayload?.billing_sources) && catalogPayload.billing_sources.length) {
    return {
      version: existing.version || catalogPayload?.version || 1,
      providers,
      billing_sources: [...catalogPayload.billing_sources].sort(
        (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
      ),
    };
  }

  const billingByKey = {};
  const existingPayg = {};
  // 订阅源：保留本地非 payg；payg 元数据单独保留 sort_order / auth 等字段
  for (const s of existing.billing_sources || []) {
    const k = s.source_id || s.id;
    if (!k) continue;
    if (s.category === 'payg') existingPayg[k] = { ...s };
    else billingByKey[k] = { ...s };
  }
  for (const sub of catalogPayload?.subscription_sources || []) {
    const k = sub.id;
    if (!k) continue;
    const merged = subscriptionSourceToBilling(sub, billingByKey[k]);
    if (merged) billingByKey[k] = merged;
  }
  // 按量源：从 catalog.providers（payg=true）同步到 billing_sources
  for (const p of catalogPayload?.providers || []) {
    if (!p?.id || !p.payg) continue;
    const k = p.id;
    const merged = catalogProviderToBilling(p, existingPayg[k]);
    if (merged) billingByKey[k] = merged;
  }

  return {
    version: existing.version || catalogPayload?.version || 1,
    providers,
    billing_sources: Object.values(billingByKey).sort(
      (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
    ),
  };
}

function readExistingRegistryDoc() {
  try {
    if (fs.existsSync(USER_REGISTRY_YAML)) {
      return configLoader.mergeRegistryDoc(yaml.load(fs.readFileSync(USER_REGISTRY_YAML, 'utf8')) || {});
    }
  } catch {}
  return { version: 1, providers: [], billing_sources: [] };
}

/** 写入 ~/.tokenbank/providers.registry.yaml 并刷新内存缓存 */
function writeRegistryDoc(doc) {
  const tbDir = path.dirname(USER_REGISTRY_YAML);
  if (!fs.existsSync(tbDir)) fs.mkdirSync(tbDir, { recursive: true });
  fs.writeFileSync(USER_REGISTRY_YAML, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
  configLoader.reloadRegistryDoc();
}

/**
 * 拉远端 catalog 写入 yaml；成功返回 { ok, updated }。
 * @param {{ baseUrl?: string, readLocalConfig?: () => object, onApplied?: () => void }} opts
 */
async function syncCatalogToRegistry(opts = {}) {
  const readCfg = opts.readLocalConfig || (() => ({}));
  const baseUrl = resolveSyncServerUrl(opts);
  if (!baseUrl) return { ok: false, error: 'no_server_url' };

  const token = opts.token || readCfg()?.user_session?.jwt || null;

  // 已登录：优先拉完整 registry YAML（含全部 billing_sources，与 Electron syncRemote 一致）
  if (token) {
    const yamlDoc = await fetchRegistryYaml(baseUrl, token);
    if (yamlDoc && (yamlDoc.billing_sources?.length || yamlDoc.providers?.length)) {
      applyRegistryDoc(yamlDoc, opts);
      return finishSyncSideEffects(baseUrl, opts, { source: 'registry_yaml' });
    }
  }

  const catalogPayload = await fetchCatalogJson(baseUrl);
  if (!catalogPayload?.providers?.length) {
    return { ok: false, error: 'catalog_fetch_failed', serverUrl: baseUrl };
  }

  const merged = mergeCatalogIntoRegistryDoc(readExistingRegistryDoc(), catalogPayload);
  writeRegistryDoc(merged);

  return finishSyncSideEffects(baseUrl, opts, { source: 'catalog_json' });
}

/** 非阻塞后台同步（去重） */
function scheduleBackgroundSync(opts = {}) {
  if (_syncInFlight) return _syncInFlight;
  _syncInFlight = syncCatalogToRegistry(opts)
    .then(async (res) => {
      try { await syncCommunityCatalog(opts); }
      catch (e) { console.warn('[catalog-sync] community sync failed:', e?.message || e); }
      return res;
    })
    .catch(err => {
      console.warn('[catalog-sync] background sync failed:', err?.message || err);
      return { ok: false, error: String(err?.message || err) };
    })
    .finally(() => { _syncInFlight = null; });
  return _syncInFlight;
}

/** UI 读取：始终从 yaml 生成 catalog 快照 */
function readCatalogFromYaml() {
  return configLoader.builtinCatalogPayload();
}

module.exports = {
  syncCatalogToRegistry,
  scheduleBackgroundSync,
  readCatalogFromYaml,
  resolveSyncServerUrl,
  mergeCatalogIntoRegistryDoc,
  mergeProvidersFromCatalog,
  fetchCatalogJson,
  fetchRegistryYaml,
  applyRegistryDoc,
  catalogProviderToBilling,
  fetchCommunityCatalog,
  writeCommunityCatalogCache,
  syncCommunityCatalog,
  upsertCommunitySkillItem,
};
