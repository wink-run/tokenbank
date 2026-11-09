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
};
