'use strict';

// 桌面版与 Docker 共用的「写配置文件」纳管核心路径。
// 覆盖 Pi 家族、DeepSeek Harness、OpenClaw、WorkBuddy 等 config-file 应用：
// 把 patch/env 解析 {BASE}/{KEY} 后写入目标配置文件，并按 handler.patch_route 策略把
// 当前绑定的路由注入模型列表/默认模型。还原时恢复首次纳管前的备份。
// Claude Desktop / Codex Desktop / Trae 等桌面专属逻辑仍由 electron/main.js 特化处理。

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const { readAgentConfig, readLocalConfig } = require('../shared/config-loader');
const configLoader = require('./config-loader');
const appHandlers = require('./app-handlers');
const dshConfig = require('./dsh-config');
const piConfig = require('./pi-config');
const {
  resolvePatchDeep,
  ensureProxyConfigWritable,
  writePiFamilyConfig,
  revertPiFamilyConfig,
  fetchGatewayModelIds,
} = require('./app-config-write');

/** config_file 字段或 inject='config-file' 即视为配置文件类应用 */
function isConfigFileApp(appRec) {
  return !!(appRec && (appRec.config_file || appRec.inject === 'config-file'));
}

/** 解析配置文件路径中的占位符与 ~ */
function resolveConfigFilePath(config_file) {
  if (!config_file) return null;
  return configLoader.expandHome(configLoader.resolvePlaceholders(String(config_file), {}));
}

/** 用当前网关地址 + 应用 api_key 构造 patch/env 解析上下文 */
function buildPatchContext(appRec) {
  const gctx = configLoader.gatewayCtx();
  return {
    ...gctx,
    base: `http://${gctx.reverse}`,
    key: appRec?.api_key || '',
  };
}

/** 目标文件是否已是 tokenbank 自己写入的托管配置（用于备份/还原保护） */
function isTokenbankManagedConfig(file) {
  try {
    if (!file || !fs.existsSync(file)) return false;
    const txt = fs.readFileSync(file, 'utf8');
    if (/\.json$/i.test(file)) {
      try { return JSON.parse(txt)?._configManagedBy === 'tokenbank'; } catch { return false; }
    }
    return /_configManagedBy['"\s:=]+tokenbank/i.test(txt);
  } catch { return false; }
}

/** dot-path patch 转嵌套对象（写 JSON/YAML 用） */
function patchToObject(patch) {
  const obj = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const parts = String(k).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] == null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return obj;
}

/** dot-path patch 转 TOML 文本 */
function patchToToml(patch) {
  const tomlVal = (v) => (v === true || v === false || v === 'true' || v === 'false' || /^-?\d+(\.\d+)?$/.test(String(v)))
    ? String(v) : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const top = [];
  const tables = new Map();
  for (const [k, v] of Object.entries(patch || {})) {
    const i = String(k).lastIndexOf('.');
    if (i < 0) { top.push([k, v]); continue; }
    const tbl = k.slice(0, i);
    const key = k.slice(i + 1);
    if (!tables.has(tbl)) tables.set(tbl, []);
    tables.get(tbl).push([key, v]);
  }
  let out = top.map(([k, v]) => `${k} = ${tomlVal(v)}`).join('\n');
  if (out) out += '\n';
  for (const [tbl, kvs] of tables) {
    out += `\n[${tbl}]\n` + kvs.map(([k, v]) => `${k} = ${tomlVal(v)}`).join('\n') + '\n';
  }
  return out;
}

/** DeepSet 工具：按点号路径写入嵌套对象 */
function deepSetDot(obj, dotKey, val) {
  const parts = String(dotKey).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

/** 判断 handlerId 是否属于 Pi 家族 */
function isPiFamilyHandler(handlerId) {
  const profile = piConfig.profileForHandler(handlerId);
  return !!profile;
}

/** 解析有效路由列表：显式参数 > appRec.route_ids > appRec.route_id */
function resolveRouteIds({ route_id, route_ids, appRec }) {
  if (Array.isArray(route_ids) && route_ids.length) return route_ids;
  const recIds = Array.isArray(appRec?.route_ids) && appRec.route_ids.length ? appRec.route_ids : null;
  if (recIds) return recIds;
  const recId = route_id ?? appRec?.route_id;
  return recId ? [recId] : [];
}

/** 把当前绑定路由按 handler.patch_route 策略注入 patch */
function applyRouteToPatch(handlerId, resolvedPatch, routeIds, appRec) {
  if (!handlerId || !routeIds.length) return resolvedPatch;
  const def = (configLoader.apiKeyApps() || []).find(
    (d) => d.id === appRec?.preset_id || appHandlers.canonicalAppEntityId(d.id) === appHandlers.canonicalAppEntityId(appRec?.preset_id),
  );
  let claudeName = 'claude-sonnet-4-5';
  let claudeModels = [];
  try {
    const cms = configLoader.claudeModels?.() || [];
    if (cms.length) { claudeModels = cms; claudeName = cms[0]; }
  } catch {}
  return appHandlers.applyRouteToProxyPatch(handlerId, resolvedPatch, {
    routeIds,
    routes: (readLocalConfig() || {}).scene_routes || [],
    providers: (readAgentConfig() || {}).providers || [],
    marker: def?.marker || appRec?.marker,
    claudeName,
    claudeModels,
  });
}

/** 把 env 条目写入系统环境（Electron 用；Docker 不传 injectEnv） */
function injectEnvEntries(resolvedEnv) {
  const entries = Object.entries(resolvedEnv || {}).filter(([k]) => k && k.trim());
  if (!entries.length) return 0;
  if (process.platform === 'win32') {
    const { execFileSync } = require('child_process');
    for (const [k, v] of entries) {
      execFileSync('setx', [k, String(v)], { stdio: ['ignore', 'ignore', 'ignore'] });
    }
  } else {
    const home = os.homedir();
    const targets = ['.zshrc', '.bashrc', '.bash_profile', '.profile']
      .map((f) => path.join(home, f))
      .filter((f) => fs.existsSync(f));
    if (!targets.length) targets.push(path.join(home, '.profile'));
    const block = '\n# >>> tokenbank env >>>\n'
      + entries.map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`).join('\n')
      + '\n# <<< tokenbank env <<<\n';
    for (const f of targets) {
      let txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      txt = txt.replace(/\n?# >>> tokenbank env >>>[\s\S]*?# <<< tokenbank env <<<\n?/g, '');
      fs.writeFileSync(f, txt + block, 'utf8');
    }
  }
  return entries.length;
}

/** DeepSeek Harness：合并式写入 settings.yaml + 独立 credentials */
async function writeDshConfig(file, resolvedPatch, patchCtx, { allowCreate } = {}) {
  const dshHome = path.dirname(file);
  if (!fs.existsSync(file)) {
    if (!allowCreate) return { ok: false, error: 'config-missing', file };
    try { fs.mkdirSync(dshHome, { recursive: true }); }
    catch (e) { return { ok: false, error: e.message || 'mkdir-failed', file }; }
  }
  // 首次且非托管态才备份，避免把自己的网关配置存成备份
  const bak = file + '.tokenbank-bak';
  if (fs.existsSync(file) && !fs.existsSync(bak) && !isTokenbankManagedConfig(file)) {
    try { fs.copyFileSync(file, bak); } catch {}
  }
  let doc = {};
  try { if (fs.existsSync(file)) doc = yaml.load(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
  for (const [k, v] of Object.entries(resolvedPatch || {})) deepSetDot(doc, k, v);
  // 独立 env key，避免与 Codex shell env 撞车
  deepSetDot(doc, 'llm-pi-ai.providers.tokenbank.apiKeyEnv', dshConfig.DSH_API_KEY_ENV);
  // 未绑路由时兜底注入全量网关模型
  if (!resolvedPatch['llm-pi-ai.providers.tokenbank.models']) {
    const ids = await fetchGatewayModelIds(patchCtx.base, patchCtx.key);
    if (ids.length) deepSetDot(doc, 'llm-pi-ai.providers.tokenbank.models', ids.map((id) => ({ id })));
  }
  if (patchCtx.key) {
    try { dshConfig.writeDshCredentials(dshHome, patchCtx.key); }
    catch (e) { console.warn('[dsh] write credentials failed:', e.message); }
  }
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
  return { ok: true, file, envCount: 0, dsh: true };
}

/** 还原 DSH：用备份恢复，并清理独立 credentials */
function revertDshConfig(file) {
  if (!file) return { ok: false, error: 'no-config-file' };
  const dshHome = path.dirname(file);
  const bak = file + '.tokenbank-bak';
  if (fs.existsSync(bak) && !isTokenbankManagedConfig(bak)) {
    try { fs.copyFileSync(bak, file); } catch (e) { return { ok: false, error: e.message }; }
  } else {
    // 无有效备份：删除 tokenbank 注入的 models，保留用户其它段
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8')) || {};
      if (doc?.['llm-pi-ai']?.providers?.tokenbank) {
        delete doc['llm-pi-ai'].providers.tokenbank;
        fs.writeFileSync(file, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
      }
    } catch {}
  }
  try { dshConfig.revertDshCredentials(dshHome); } catch {}
  return { ok: true };
}

/** 通用 JSON/YAML/TOML 配置文件写入（OpenClaw / WorkBuddy 等） */
function writeGenericConfigFile(file, resolvedPatch, resolvedEnv, { allowCreate, injectEnv } = {}) {
  const ensured = ensureProxyConfigWritable(file, { allowCreate });
  if (!ensured.ok) return { ok: false, error: ensured.error || 'config-missing', file };
  const bak = file + '.tokenbank-bak';
  if (fs.existsSync(file) && !fs.existsSync(bak) && !isTokenbankManagedConfig(file)) {
    try { fs.copyFileSync(file, bak); } catch {}
  }
  // 标记为托管配置，避免重复备份自己的网关配置
  const markedPatch = { ...resolvedPatch, _configManagedBy: 'tokenbank' };
  if (/\.json$/i.test(file)) {
    fs.writeFileSync(file, JSON.stringify(patchToObject(markedPatch), null, 2), 'utf8');
  } else if (/\.ya?ml$/i.test(file)) {
    fs.writeFileSync(file, yaml.dump(patchToObject(markedPatch), { lineWidth: 120 }), 'utf8');
  } else {
    fs.writeFileSync(file, patchToToml(markedPatch), 'utf8');
  }
  const envCount = injectEnv ? injectEnvEntries(resolvedEnv) : 0;
  return { ok: true, file, envCount };
}

/** 通用还原：备份恢复 */
function revertGenericConfigFile(file) {
  if (!file) return { ok: false, error: 'no-config-file' };
  const bak = file + '.tokenbank-bak';
  if (fs.existsSync(bak) && !isTokenbankManagedConfig(bak)) {
    try { fs.copyFileSync(bak, file); } catch (e) { return { ok: false, error: e.message }; }
  } else {
    try { fs.unlinkSync(file); } catch {}
  }
  return { ok: true };
}

/**
 * 统一写入某 config-file 应用的本地配置文件。
 * @param {object} opts
 * @param {object} opts.appRec      本地应用记录（含 preset_id / api_key / route_id / route_ids）
 * @param {string} [opts.config_file] 目标配置文件路径（可选，默认取 appRec.config_file）
 * @param {object} [opts.patch]     原始 patch（可含 {BASE}/{KEY}）；缺省用 appRec.patch
 * @param {object} [opts.env]       原始 env（可含 {BASE}/{KEY}）；缺省用 appRec.env
 * @param {string} [opts.route_id]  本次要写入的首路由
 * @param {string[]} [opts.route_ids] 本次要写入的路由列表
 * @param {boolean} [opts.allowCreate] 是否允许新建缺失文件
 * @param {boolean} [opts.injectEnv]   是否把 env 条目写入系统 shell 配置（仅 Electron）
 * @returns {Promise<{ok:boolean, file?:string, error?:string, envCount?:number}>}
 */
async function writeConfigFile({ appRec, config_file, patch, env, route_id, route_ids, allowCreate = false, injectEnv = false } = {}) {
  const file = resolveConfigFilePath(config_file || appRec?.config_file);
  if (!file) return { ok: false, error: 'no-config-file' };
  const patchCtx = buildPatchContext(appRec);
  const sourcePatch = patch || appRec?.patch || {};
  const sourceEnv = env || appRec?.env || {};
  let resolvedPatch = resolvePatchDeep(sourcePatch, patchCtx);
  const resolvedEnv = resolvePatchDeep(sourceEnv, patchCtx);
  const handlerId = appHandlers.resolveHandlerId(appRec);
  const routeIds = resolveRouteIds({ route_id, route_ids, appRec });
  resolvedPatch = applyRouteToPatch(handlerId, resolvedPatch, routeIds, appRec);

  // Pi 家族：走 app-config-write（已覆盖 pi/omo/prime/omp）
  if (isPiFamilyHandler(handlerId)) {
    const r = await writePiFamilyConfig(handlerId, resolvedPatch, {
      base: patchCtx.base,
      key: patchCtx.key,
      allowCreate,
    });
    if (r) return { ...r, envCount: r.envCount ?? 0 };
  }

  // DeepSeek Harness
  if (handlerId === 'deepseek-harness-cli') {
    const r = await writeDshConfig(file, resolvedPatch, patchCtx, { allowCreate });
    if (injectEnv && resolvedEnv && typeof resolvedEnv === 'object') {
      r.envCount = (r.envCount || 0) + injectEnvEntries(resolvedEnv);
    }
    return r;
  }

  // OpenClaw / WorkBuddy / 其它通用 config-file 应用
  return writeGenericConfigFile(file, resolvedPatch, resolvedEnv, { allowCreate, injectEnv });
}

/**
 * 统一还原 config-file 应用到纳管前状态。
 * @returns {{ok:boolean, error?:string}}
 */
function revertConfigFile({ appRec, config_file } = {}) {
  const file = resolveConfigFilePath(config_file || appRec?.config_file);
  if (!file) return { ok: false, error: 'no-config-file' };
  const handlerId = appHandlers.resolveHandlerId(appRec);
  if (isPiFamilyHandler(handlerId)) {
    const ok = revertPiFamilyConfig(appRec?.id || appRec?.preset_id, appRec);
    return { ok: !!ok };
  }
  if (handlerId === 'deepseek-harness-cli') {
    return revertDshConfig(file);
  }
  return revertGenericConfigFile(file);
}

module.exports = {
  isConfigFileApp,
  resolveConfigFilePath,
  buildPatchContext,
  resolveRouteIds,
  applyRouteToPatch,
  isTokenbankManagedConfig,
  patchToObject,
  patchToToml,
  writeConfigFile,
  revertConfigFile,
};
