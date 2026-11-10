// client/electron/app-config-write.js
// 「写配置文件」类应用的纳管逻辑中，桌面版（main.js）与 Docker（cli/admin-api.js）共用的部分。
// 目前覆盖 Pi 家族（pi / omo / prime / omp）：只合并 tokenbank 提供商，默认模型写 settings.json。
// 其余应用（Codex Desktop、DeepSeek Harness、Claude Desktop…）仍在 main.js，按需逐个迁入。
'use strict';

const fs = require('fs');
const path = require('path');

/** 递归解析 patch/env 中的 {BASE}/{KEY}/{REVERSE}（嵌套结构同样处理） */
function resolvePatchDeep(obj, ctx = {}) {
  const cl = require('./config-loader');
  if (typeof obj === 'string') {
    return cl.resolvePlaceholders(obj, {
      reverse: ctx.reverse,
      mitm: ctx.mitm,
      caPath: ctx.caPath,
    })
      .replace(/\{BASE\}/g, ctx.base || '')
      .replace(/\{KEY\}/g, ctx.key || '');
  }
  if (Array.isArray(obj)) return obj.map(v => resolvePatchDeep(v, ctx));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolvePatchDeep(v, ctx);
    return out;
  }
  return obj;
}

/** 目标配置文件不存在时：允许新建则建好目录，否则报 config-missing */
function ensureProxyConfigWritable(file, { allowCreate } = {}) {
  if (fs.existsSync(file)) return { ok: true };
  if (!allowCreate) return { ok: false, error: 'config-missing', file };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { ok: true, created: true };
  } catch (e) {
    return { ok: false, error: e.message || 'mkdir-failed', file };
  }
}

function commandInstalled(cmd) {
  if (!cmd) return false;
  try { return !!require('./shim-installer').resolveRealCommand(cmd); } catch { return false; }
}

/** Pi 家族：探测认命令或已有 agent 目录，不认 models.json / models.yml（那是纳管时我们写的） */
function piAllowCreate(handlerId) {
  try {
    const pi = require('./pi-config');
    const profile = pi.profileForHandler(handlerId);
    if (!profile) return false;
    return commandInstalled(profile.command) || !!pi.familyReady(profile);
  } catch {
    return false;
  }
}

/** 网关 /v1/models 的模型 id（去重）；未绑路由时作为兜底全量写入 */
async function fetchGatewayModelIds(base, key) {
  try {
    const res = await fetch(`${base}/v1/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) return [];
    const json = await res.json();
    return [...new Set(
      (Array.isArray(json?.data) ? json.data : [])
        .map(m => m?.id).filter(x => typeof x === 'string' && x.trim()),
    )];
  } catch (e) {
    console.warn('[pi] fetch /v1/models failed:', e.message);
    return [];
  }
}

/**
 * Pi 家族写入。handlerId 不属于 Pi 家族时返回 null（调用方继续走其它分支）。
 * @returns {Promise<null | { ok: boolean, file?: string, error?: string, envCount?: number }>}
 */
async function writePiFamilyConfig(handlerId, resolvedPatch, { base, key, allowCreate } = {}) {
  const piCfg = require('./pi-config');
  const profile = piCfg.profileForHandler(handlerId);
  if (!profile) return null;
  const file = piCfg.modelsFile(profile);
  const ensured = ensureProxyConfigWritable(file, {
    allowCreate: allowCreate == null ? piAllowCreate(handlerId) : allowCreate,
  });
  if (!ensured.ok) return { ok: false, error: ensured.error || 'config-missing', file };
  let modelIds = piCfg.modelIdsFromPatch(resolvedPatch);
  if (!modelIds.length) modelIds = await fetchGatewayModelIds(base, key);
  piCfg.applyFamily(profile, { patch: resolvedPatch, modelIds });
  return { ok: true, file, envCount: 0 };
}

const PI_FAMILY_IDS = new Set(['pi', 'omo', 'prime', 'omp']);

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** 已经指向 tokenbank 且带上密钥、默认模型，就不必每次启动重写。 */
function piAuthReady(profile) {
  const piCfg = require('./pi-config');
  const dir = piCfg.agentDir(profile);
  if (profile.kind === 'yaml') {
    let config = null;
    try {
      const yaml = require('js-yaml');
      const yml = fs.existsSync(path.join(dir, 'config.yml'))
        ? path.join(dir, 'config.yml')
        : path.join(dir, 'config.yaml');
      if (fs.existsSync(yml)) config = yaml.load(fs.readFileSync(yml, 'utf8'));
    } catch { /* 读不到就当没配 */ }
    const role = config?.modelRoles?.default;
    if (typeof role !== 'string' || !role.startsWith('tokenbank/')) return false;
  } else {
    const settings = readJsonFile(path.join(dir, 'settings.json'));
    if (settings?.defaultProvider !== 'tokenbank' || !settings?.defaultModel) return false;
  }
  const models = profile.kind === 'yaml'
    ? null
    : readJsonFile(piCfg.modelsFile(profile));
  if (profile.kind !== 'yaml') return !!models?.providers?.tokenbank?.apiKey;
  // omp 的密钥在 models.yml
  try {
    const yaml = require('js-yaml');
    const file = piCfg.modelsFile(profile);
    if (!fs.existsSync(file)) return false;
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    return !!doc?.providers?.tokenbank?.apiKey;
  } catch {
    return false;
  }
}

/**
 * 游乐场启动 Pi 前补写网关密钥。
 * 纳管只标记了 hosted、还没写 models.json 时，Pi 会用自带模型并因没有 API key 退出。
 * 不是 Pi 家族、或还没有纳管出的 api_key，则什么都不做。
 */
async function ensurePiFamilyAuth(agentId) {
  const raw = String(agentId || '').replace(/^app:/, '');
  if (!PI_FAMILY_IDS.has(raw)) return { ok: true, skipped: true };
  const piCfg = require('./pi-config');
  const profile = piCfg.profileForEntity(raw);
  if (!profile) return { ok: true, skipped: true };
  if (piAuthReady(profile)) return { ok: true, skipped: true };
  let lc = null;
  try { lc = require('../shared/config-loader').readLocalConfig(); } catch { /* 没有本地配置 */ }
  const app = (lc?.apps || []).find((a) => {
    if (!a || a.hosted === false || !a.api_key) return false;
    return String(a.preset_id || a.agent_id || '') === raw;
  });
  if (!app) return { ok: false, skipped: true, error: 'no-hosted-app' };
  const g = require('./config-loader').gatewayCtx();
  const base = g?.reverse ? `http://${g.reverse}` : '';
  const fallbackPatch = {
    'providers.tokenbank.name': 'Token Bank',
    'providers.tokenbank.baseUrl': '{BASE}/v1',
    'providers.tokenbank.api': 'openai-completions',
    'providers.tokenbank.apiKey': '{KEY}',
    'providers.tokenbank.authHeader': true,
  };
  let patch = resolvePatchDeep(app.patch || fallbackPatch, { base, key: app.api_key });
  const routeIds = (Array.isArray(app.route_ids) && app.route_ids.length)
    ? app.route_ids
    : (app.route_id ? [app.route_id] : []);
  if (routeIds.length) {
    try {
      const { applyRouteToProxyPatch } = require('./app-handlers');
      patch = applyRouteToProxyPatch(profile.handlerId, patch, {
        routeIds,
        routes: lc.scene_routes || [],
      });
    } catch (e) {
      console.warn('[pi] apply route patch failed:', e.message);
    }
  }
  return writePiFamilyConfig(profile.handlerId, patch, {
    base,
    key: app.api_key,
    allowCreate: true,
  });
}

/** Pi 家族还原：只删 tokenbank 提供商并交回原默认模型。不是 Pi 家族返回 false */
function revertPiFamilyConfig(appId, appRec) {
  const piCfg = require('./pi-config');
  const profile = piCfg.profileForEntity(appId)
    || piCfg.profileForEntity(appRec?.preset_id || appRec?.agent_id);
  if (!profile) return false;
  piCfg.revertFamily(profile);
  return true;
}

module.exports = {
  resolvePatchDeep,
  ensureProxyConfigWritable,
  piAllowCreate,
  fetchGatewayModelIds,
  writePiFamilyConfig,
  revertPiFamilyConfig,
  ensurePiFamilyAuth,
};
