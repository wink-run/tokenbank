// contribute-assistants.js
// 贡献武将：白名单规范化、资格校验、注册名片（不含正文）
'use strict';

const {
  parseAssistantConfig,
  resolveAssistantRuntimeAgent,
  hasAssistantEnableProjection,
  ASSISTANT_RUNTIME_IDS,
  listAvailableAssistantRuntimeIds,
} = require('./resource-assistant');

const VISIBILITIES = new Set(['public', 'circle']);

/** 本机应用对外名片 id：app:<cli>，和资源 id 分开，雇佣后仍是 community:app:<cli>@用户名 */
const APP_ID_PREFIX = 'app:';

/** 可直接出租的本机应用。名字与游乐场里的 CLI 一致。 */
const RENTABLE_APPS = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'kimi-code': 'Kimi Code',
  pi: 'Pi',
};

/** app:claude-code → claude-code；不是可出租应用则返回空串 */
function contributedAppRuntime(id) {
  const raw = String(id || '').trim();
  if (!raw.startsWith(APP_ID_PREFIX)) return '';
  const runtime = raw.slice(APP_ID_PREFIX.length);
  return Object.prototype.hasOwnProperty.call(RENTABLE_APPS, runtime) ? runtime : '';
}

function isContributedAppId(id) {
  return !!contributedAppRuntime(id);
}

/** Token Bank 内置智能体：不可对外贡献，也不应出现在贡献列表 */
function isBuiltinAssistantResource(resource) {
  if (!resource || resource.type !== 'assistant') return false;
  if (resource.source === 'builtin') return true;
  if (resource.metadata && resource.metadata.builtin) return true;
  const url = String(resource.source_url || '');
  if (url.startsWith('builtin:')) return true;
  return false;
}

/**
 * @param {object} cfg agent config
 * @returns {{ id: string, visibility: 'public'|'circle' }[]}
 */
function normalizeContributeAssistants(cfg = {}) {
  const raw = Array.isArray(cfg.contribute_assistants) ? cfg.contribute_assistants : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let id = '';
    let visibility = 'public';
    if (typeof item === 'string') {
      id = item.trim();
    } else if (item && typeof item === 'object') {
      id = String(item.id || item.resource_id || '').trim();
      const v = String(item.visibility || 'public').trim().toLowerCase();
      visibility = VISIBILITIES.has(v) ? v : 'public';
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, visibility });
  }
  return out;
}

/**
 * 是否允许对外贡献该武将
 * @param {object} resource listResources 行（含 projections / content）
 * @param {{ isRuntimeAvailable?: (id: string) => boolean }} [opts]
 */
function validateAssistantEligible(resource, opts = {}) {
  if (!resource || resource.type !== 'assistant') {
    return { ok: false, reason: 'not_assistant' };
  }
  // 内置（资产发现/安装等）仅供本机，不参与社区贡献
  if (isBuiltinAssistantResource(resource)) {
    return { ok: false, reason: 'builtin' };
  }
  if (!hasAssistantEnableProjection(resource.projections || [])) {
    return { ok: false, reason: 'not_projected' };
  }
  let config = {};
  try {
    config = parseAssistantConfig(resource.content) || {};
  } catch {
    config = {};
  }
  const runtimeId = resolveAssistantRuntimeAgent(config, resource.projections || []);
  // 静态白名单：须是可 spawn 的 runtime 族
  if (!runtimeId || !ASSISTANT_RUNTIME_IDS.has(runtimeId)) {
    return { ok: false, reason: 'no_runtime' };
  }
  // 安装探测：调用方传入 isRuntimeAvailable 时以其为准（CI 可 stub）；否则查本机已装 runtime
  const check = opts.isRuntimeAvailable;
  if (typeof check === 'function') {
    if (!check(runtimeId)) {
      return { ok: false, reason: 'runtime_unavailable', runtime: runtimeId };
    }
  } else if (!listAvailableAssistantRuntimeIds().has(runtimeId)) {
    return { ok: false, reason: 'no_runtime' };
  }
  return { ok: true, runtime: runtimeId };
}

/**
 * 名片简介：优先资源 description；否则从 soul 摘一句；再否则给运行时兜底说明。
 * 只上报短简介，不上报完整正文。
 */
function buildAgentCardDescription(resource, config = {}, runtime = '') {
  const meta = String(resource?.description || '').trim().replace(/\s+/g, ' ');
  if (meta) return meta.slice(0, 200);

  const soul = String(config.soul || '').trim().replace(/\s+/g, ' ');
  if (soul) {
    const snippet = soul.slice(0, 160);
    return snippet + (soul.length > 160 ? '…' : '');
  }

  const name = resource?.display_name || resource?.name || '智能体';
  const rt = runtime || config.runtime_agent || '';
  return rt
    ? `${name}：对方设备上由 ${rt} 执行，适合委托同类任务（不下载正文）`
    : `${name}：在对方设备执行任务，雇佣后可在游乐场 / MCP 调用`;
}

/**
 * 构建上报名片（禁止带正文）
 * @param {{ id: string, visibility: string }[]} entries
 * @param {object[]} resources assistant 资源列表
 * @param {{ isRuntimeAvailable?: (id: string) => boolean }} [opts]
 */
function buildAgentCards(entries, resources, opts = {}) {
  const byId = new Map();
  for (const r of resources || []) {
    if (r?.id) byId.set(r.id, r);
  }
  const cards = [];
  for (const e of normalizeContributeAssistants({ contribute_assistants: entries })) {
    // 本机应用走 buildAppCards，不拿资源库校验
    if (isContributedAppId(e.id)) continue;
    const resource = byId.get(e.id);
    if (!resource) continue;
    const v = validateAssistantEligible(resource, opts);
    if (!v.ok) continue;
    let config = {};
    try { config = parseAssistantConfig(resource.content) || {}; } catch { /* ignore */ }
    const runtime = v.runtime || config.runtime_agent || '';
    cards.push({
      id: resource.id,
      name: resource.name,
      display_name: resource.display_name || resource.name,
      description: buildAgentCardDescription(resource, config, runtime),
      visibility: e.visibility,
      runtime,
    });
  }
  return cards;
}

/**
 * 本机应用名片。形式与智能体相同（id / 简介 / runtime / visibility），不含任何本机配置。
 * 必须传入 isRuntimeAvailable，未安装的不上报。
 */
function buildAppCards(entries, opts = {}) {
  const check = opts.isRuntimeAvailable;
  if (typeof check !== 'function') return [];
  const cards = [];
  for (const e of normalizeContributeAssistants({ contribute_assistants: entries })) {
    const runtime = contributedAppRuntime(e.id);
    if (!runtime || !check(runtime)) continue;
    const name = RENTABLE_APPS[runtime];
    cards.push({
      id: `${APP_ID_PREFIX}${runtime}`,
      name: runtime,
      display_name: name,
      description: `${name}：在出租者本机的该应用里执行，调用方只拿结果，不接触配置与密钥`,
      visibility: e.visibility,
      runtime,
    });
  }
  return cards;
}

function assertAssistantContributed(cfg, assistantId) {
  const id = String(assistantId || '').trim();
  const ok = normalizeContributeAssistants(cfg).some((e) => e.id === id);
  if (!ok) throw new Error(`assistant not contributed: ${id || '(empty)'}`);
}

module.exports = {
  VISIBILITIES,
  isBuiltinAssistantResource,
  normalizeContributeAssistants,
  validateAssistantEligible,
  buildAgentCardDescription,
  buildAgentCards,
  buildAppCards,
  APP_ID_PREFIX,
  RENTABLE_APPS,
  contributedAppRuntime,
  isContributedAppId,
  assertAssistantContributed,
};
