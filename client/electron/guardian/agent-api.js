// client/electron/guardian/agent-api.js
// 智能管家（游乐场里的「智能管家」）就是智能管家本身：对话里能做智能管家页上能做的一切。
// 它跑在一个应用（Claude Code / Codex …）里，靠这里的本机接口操作智能管家：
//   - 只监听 127.0.0.1、随机端口、带令牌；端点写在 ~/.tokenbank/guardian/agent-api.json（只有本机这个用户能读）
//   - 智能管家页上的操作，加上资产页那一批保存 / 删除 / 投射 / 导入 / 安装（和用户点的是同一条接口）
//   - 附带一个小脚本 ~/.tokenbank/guardian/tb-guardian.js，智能体用 `node <脚本> <操作> '<JSON>'` 调用
// 桌面版与 Docker 共用（startGuardian 里启动）。
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');

let server = null;

function guardian() {
  return require('./index');
}

function infoPath() {
  return path.join(store.dir(), 'agent-api.json');
}

function helperPath() {
  return path.join(store.dir(), 'tb-guardian.js');
}

function brief(r) {
  return {
    id: r.id, status: r.status, kind: r.kind, category: r.category, title: r.title,
    advice: r.advice || null, detail: r.detail ? String(r.detail).slice(0, 400) : null,
    actions: (r.actions || []).map((a, i) => ({ index: i, label: a.label })),
    canUndo: r.status === 'done' && !!r.undo, link: r.link?.label || null,
    // 规则能用的事实（和学到的规则匹配时用的是同一份）
    facts: Array.isArray(r.factsList) && r.factsList.length ? r.factsList.slice(0, 5) : require('./judgment').factsOf(r),
    count: r.count || 1, at: r.lastAt || r.at,
  };
}

const ok = (o = {}) => ({ ok: true, ...o });
const fail = (r) => ({ ok: false, error: r?.error || 'failed' });

// 操作表：名字 → { 说明, 处理 }；智能体的说明直接由这张表生成
const OPS = {
  status: {
    desc: '运行状态（是否正常、执行应用、正在跑什么、问题）',
    run: () => ok({ health: require('./health').health() }),
  },
  records: {
    desc: '我做过的事（处理日志，每条说明能不能撤销）。{"limit":30}',
    run: ({ open = false, limit = 30 } = {}) => {
      void open;
      const list = guardian().listRecords({ limit: 300 }).slice(0, limit);
      return ok({ records: list.map(brief) });
    },
  },
  undo: {
    desc: '撤销一条已处理的记录。{"id":"g-…"}',
    run: async ({ id }) => { const r = await guardian().undo(id); return r.ok ? ok() : fail(r); },
  },
  check: {
    desc: '现在检查一遍投射和资产（用户要求时才跑；只用规则，不花 token）',
    run: async () => ok({ results: await guardian().runChecks() }),
  },
  settings: {
    desc: '看设置；改设置传 {"set":{...}}，例：{"set":{"modes":{"assets":"suggest"}}}、{"set":{"enabled":false}}。modes 取值 auto / suggest / off',
    run: ({ set } = {}) => ok({ settings: set ? guardian().setSettings(set) : guardian().getSettings(), categories: Object.keys(guardian().CATEGORIES) }),
  },
  runtime: {
    desc: '执行应用：看当前和可选；改传 {"set":"codex"}',
    run: ({ set } = {}) => {
      const engine = require('./engine');
      if (set) { const r = engine.setRuntime(set); if (!r.ok) return fail(r); }
      return ok({ engine: engine.status() });
    },
  },
  diagnose: {
    desc: '诊断一个资产为什么在应用里看不到/用不了。{"resourceId":"res-skill-…"}',
    run: ({ resourceId }) => ok({ diagnosis: require('./diagnose').diagnoseResource(resourceId) }),
  },
  command: {
    desc: '说一句话就办（安装技能、启用/撤下到某应用、清理闲置、整理、换执行应用…）。{"text":"把 git-commit 投射到 Codex"}；先看 plan 再加 "run":true 执行',
    run: async ({ text, run = false }) => {
      const command = require('./command');
      const plan = await command.parse(String(text || ''), { allowModel: false });
      if (!run || !plan || plan.action === 'unknown') return ok({ plan });
      const r = await command.run(plan);
      return r.ok ? ok({ plan, message: r.message || null }) : fail(r);
    },
  },
  hire: {
    desc: '雇佣任务：最近拦截的任务、被拒接的雇佣者、规则文件位置。拒接 {"refuse":"<雇佣者>"}；恢复 {"allow":"<雇佣者>"}。放宽审查规则只能由用户自己改规则文件，你不能替他改',
    run: ({ refuse, allow } = {}) => {
      const h = require('./hire-guard');
      if (refuse) return ok(h.refuseHirer({ consumer: refuse }));
      if (allow) return ok(h.allowHirer({ consumer: allow }));
      return ok({ blocks: store.readJson('hire-blocks.json', []).slice(0, 20), refused: h._internal.refused(), rulesFile: h.skillFile(), sandbox: h.hasSandbox() });
    },
  },
  rule: {
    desc: '用户教的规矩（事件 + 条件 + 处理）。看全部：{}；加一条：{"add":{...}}（格式见下）；删：{"remove":"er-…"}',
    run: ({ add, remove } = {}) => {
      const r = require('./rules');
      if (add) return r.add(add);
      if (remove) return ok(r.remove({ id: remove }));
      return ok({ rules: r.list() });
    },
  },
  threshold: {
    desc: '连续失败几次才把来源排到后面（默认 5）。{"provider":"来源 id","model":"模型","value":10}；不带 provider 就是改默认值。范围 2~50',
    run: ({ provider, model, value } = {}) => {
      const v = Number(value);
      if (!Number.isFinite(v) || v < 2 || v > 50) return { ok: false, error: 'value 要在 2 到 50 之间' };
      const t = store.readJson('thresholds.json', {});
      t[provider && model ? `${provider}::${model}` : 'default'] = Math.round(v);
      store.writeJson('thresholds.json', t);
      return ok({ thresholds: t });
    },
  },
  pattern: {
    desc: '记一个报错识别模式，下次能直接认出原因。{"match":"报错里的一段文字或正则","kind":"auth|quota|rate|context|model|network|upstream"}',
    run: (args = {}) => require('./explain').learnPattern(args),
  },
  skill: {
    desc: '装给你的技能。看全部：{}；提出装一个：{"propose":"技能名","auto":true}（会在对话里请用户确认）；移除：{"detach":"资产 id"}',
    run: ({ propose, auto, perDay, detach } = {}) => {
      const s = require('./skills');
      if (propose) return s.propose({ name: propose, auto: !!auto, perDay });
      if (detach) return ok(s.detach({ resourceId: detach }));
      return ok({ skills: s.list() });
    },
  },
  remind: {
    desc: '你说了「到时候再提醒你」就必须记下来。{"text":"提醒什么","minutes":240}；取消全部：{"cancel":true}',
    run: ({ text, minutes, cancel } = {}) => {
      const c = require('./convo');
      return cancel ? ok(c.cancelReminders()) : c.remind({ text, minutes });
    },
  },
  rules: {
    desc: '「这种情况不算问题」的规则列表（老的那一套；新规矩用 rule）',
    run: () => ok({ rules: require('./judgment').list() }),
  },
  learn: {
    desc: '学一条规则（格式见下）。{"rule":{...}}。用户在对话里明确要求的，rule 里写 "source":"user"，会直接生效',
    run: async ({ rule }) => {
      const j = require('./judgment');
      const r = rule && rule.source === 'user' ? await j.adoptConfirmed(rule) : await j.propose(rule || {});
      return r.ok ? ok({ rule: r.rule, text: r.rule ? j.describe(r.rule) : null, adopted: r.adopted !== false, message: r.message || null }) : fail(r);
    },
  },
  forget: {
    desc: '删掉一条学到的规则。{"id":"jr-…"}',
    run: ({ id }) => ok(require('./judgment').removeRule({ id })),
  },
  library: {
    desc: '资产库全表，和资产页看到的是同一份（不受投射限制）。{"type":"assistant|skill|prompt","query":""}',
    run: (args = {}) => listManagedResources(args),
  },
  get: {
    desc: '读一条资产的正文，和资产页编辑器打开的是同一份。{"id":"res-…"} 或 {"name":"…","type":"assistant"}',
    run: (args = {}) => getManagedResource(args),
  },
  save: {
    desc: '新建或修改资产，和资产页点保存同一条接口。{"id":"res-assistant-…","skills":["a","b"]} 只换技能清单，人设和其它字段保留；也可传 name、type、display_name、description、content、metadata、soul、prompts、runtime_agent。不传 id 就是新建。指纹和时间戳由接口更新。禁止直接改数据库',
    run: (args = {}) => saveManagedResource(args),
  },
  delete: {
    desc: '删除一条资产，和资产页删除同一条接口。{"id":"res-…"}。技能还有投射时先撤下，或 {"force":true} 连投射一起卸。内置智能体删不掉',
    run: (args = {}) => deleteManagedResource(args),
  },
  project: {
    desc: '投射到应用，和资产页启用同一条接口。{"id":"res-…","agentIds":["codex","claude-code"]}。高风险技能先返回 security-risk，用户确认后再带 "allowRisky":true。同名目录冲突时先看 conflicts，用户确认后再 "force":true',
    run: (args = {}) => projectManagedResource(args),
  },
  unproject: {
    desc: '撤下投射，资产还在。{"id":"res-…","agentId":"codex"} 或 {"projectionId":"…"}',
    run: (args = {}) => unprojectManagedResource(args),
  },
  verify: {
    desc: '检查投射是否还在；{"id":"res-…","repair":true} 时修好能修的软链',
    run: (args = {}) => verifyManagedResource(args),
  },
  sync: {
    desc: '重新扫描本机技能目录并纳管，和新技能进资产库的那次扫描同一条接口。不改数据库文件',
    run: (args = {}) => syncManagedSkills(args),
  },
  import: {
    desc: '从本机路径导入，和资产页导入同一条接口。{"sourcePath":"~/skills/foo","type":"skill"}',
    run: (args = {}) => importManagedResource(args),
  },
  install: {
    desc: '安装技能，和资产页安装同一条接口。GitHub：{"source":"owner/repo"}；目录条目：{"catalogId":"…"} 或 {"source":"技能名"}。付费社区条目不在这里装，让用户在资产页确认',
    run: (args = {}) => installManagedResource(args),
  },
};

function manager() {
  const rm = require('../resource-manager');
  rm.init();
  return rm;
}

function asList(value) {
  if (Array.isArray(value)) return value.map(s => String(s).trim()).filter(Boolean);
  if (value == null || value === '') return [];
  return String(value).split(/[,，\s]+/).map(s => s.trim()).filter(Boolean);
}

/** 按 id / name / 显示名找资产，和资产页选中一条是同一份记录。 */
function findManaged(rm, { id, name, type } = {}) {
  const ref = String(id || name || '').replace(/^#/, '').trim();
  if (!ref) return null;
  let resource = rm.getResource(ref);
  if (!resource) {
    const rows = rm.listResources(type ? { type } : {}) || [];
    resource = rows.find(r => r.id === ref || r.name === ref || r.display_name === ref) || null;
  }
  return resource;
}

function skillNamesOf(resource) {
  if (!resource || resource.type !== 'assistant') return undefined;
  try { return JSON.parse(resource.content || '{}').skills || []; } catch { return []; }
}

/** 列表用的短记录，不含正文。 */
function briefResource(resource) {
  if (!resource) return null;
  return {
    id: resource.id,
    name: resource.name,
    type: resource.type,
    display_name: resource.display_name,
    description: resource.description ? String(resource.description).slice(0, 200) : '',
    hash: resource.hash || null,
    updated_at: resource.updated_at || null,
    skills: skillNamesOf(resource),
    projections: (resource.projections || []).map(p => p.agentId || p.agent_id).filter(Boolean),
  };
}

/** 编辑器用的完整记录，和资产页打开编辑器看到的字段一致。 */
function detailResource(resource) {
  const detail = {
    ...briefResource(resource),
    description: resource.description || '',
    content: resource.content || '',
    metadata: resource.metadata || {},
  };
  if (resource.type === 'assistant') {
    try {
      const cfg = JSON.parse(resource.content || '{}');
      detail.soul = cfg.soul || '';
      detail.prompts = cfg.prompts || [];
      detail.runtime_agent = cfg.runtime_agent || '';
    } catch { /* 正文不是 JSON 时原样留在 content */ }
  }
  return detail;
}

/**
 * 在智能体 JSON 上改技能 / 人设等字段，其余键保留。
 * 正文不是 JSON 时返回 null。
 */
function patchAssistantContent(content, patch = {}) {
  let parsed = {};
  const text = String(content || '').trim();
  if (text) {
    try { parsed = JSON.parse(text); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  if (patch.soul != null) parsed.soul = String(patch.soul);
  if (Array.isArray(patch.skills)) parsed.skills = patch.skills.map(s => String(s).trim()).filter(Boolean);
  if (Array.isArray(patch.prompts)) parsed.prompts = patch.prompts.map(s => String(s).trim()).filter(Boolean);
  if (patch.runtime_agent != null) parsed.runtime_agent = String(patch.runtime_agent).trim();
  if (patch.parameters && typeof patch.parameters === 'object' && !Array.isArray(patch.parameters)) {
    parsed.parameters = patch.parameters;
  }
  return JSON.stringify(parsed);
}

function assistantPatch(args = {}) {
  const patch = {};
  if (Array.isArray(args.skills)) patch.skills = args.skills;
  if (Array.isArray(args.prompts)) patch.prompts = args.prompts;
  if (args.soul != null) patch.soul = args.soul;
  if (args.runtime_agent != null) patch.runtime_agent = args.runtime_agent;
  if (args.parameters && typeof args.parameters === 'object') patch.parameters = args.parameters;
  return Object.keys(patch).length ? patch : null;
}

function savedBrief(saved) {
  const resource = saved && saved.resource;
  if (!saved || saved.success === false || !resource) {
    return { ok: false, error: saved?.error || '保存失败' };
  }
  return ok({ ...briefResource(resource), skills: skillNamesOf(resource) });
}

function listManagedResources({ type, query } = {}) {
  const rm = manager();
  const kind = String(type || '').trim();
  let rows = rm.listResources(kind && kind !== 'all' ? { type: kind } : {}) || [];
  rows = rows.filter(r => ['skill', 'assistant', 'prompt'].includes(r.type));
  const q = String(query || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter(r => `${r.name} ${r.display_name || ''} ${r.description || ''}`.toLowerCase().includes(q));
  }
  return ok({ resources: rows.map(briefResource) });
}

function getManagedResource(args = {}) {
  const resource = findManaged(manager(), args);
  if (!resource) return { ok: false, error: '资产库里没有这一条' };
  if (args.type && resource.type !== args.type) return { ok: false, error: `类型是 ${resource.type}，不是 ${args.type}` };
  return ok({ resource: detailResource(resource) });
}

/** 经资产库保存接口新建或修改。和资产页 saveResource 同一条路，不写 sqlite。 */
function saveManagedResource(args = {}) {
  const rm = manager();
  const resource = findManaged(rm, args);
  const patch = assistantPatch(args);
  if (args.type && resource && resource.type !== args.type) {
    return { ok: false, error: `类型是 ${resource.type}，不是 ${args.type}` };
  }

  if (!resource) {
    const type = args.type || (patch ? 'assistant' : '');
    const name = String(args.name || '').trim();
    if (!name || !type) return { ok: false, error: '新建要给出 name 和 type（assistant、skill 或 prompt）' };
    let content = args.content != null ? String(args.content) : '';
    if (patch) {
      content = patchAssistantContent(content || '{}', patch);
      if (content == null) return { ok: false, error: '正文不是 JSON，不能改技能清单或人设' };
    }
    if (!content) return { ok: false, error: '新建要给出 content；智能体可以给 soul 或 skills' };
    return savedBrief(rm.saveResource({
      type,
      name,
      display_name: args.display_name,
      description: args.description || '',
      content,
      metadata: args.metadata || {},
      source: args.source || 'local',
    }));
  }

  const changing = args.content != null || patch || args.display_name != null
    || args.description != null || args.metadata != null || (args.name && args.name !== resource.name);
  if (!changing) return { ok: false, error: '要给出要改的字段（skills、content、display_name、description、metadata 等）' };

  let content = args.content != null ? String(args.content) : resource.content;
  if (patch && (resource.type === 'assistant' || args.type === 'assistant')) {
    content = patchAssistantContent(args.content != null ? args.content : resource.content, patch);
    if (content == null) return { ok: false, error: '现有正文不是 JSON，不能只换技能清单' };
  }
  return savedBrief(rm.saveResource({
    id: resource.id,
    type: resource.type,
    name: args.name || resource.name,
    display_name: args.display_name != null ? args.display_name : resource.display_name,
    description: args.description != null ? args.description : resource.description,
    content,
    metadata: args.metadata != null ? args.metadata : (resource.metadata || {}),
    source: resource.source,
  }));
}

/** 和资产页删除同一条接口。内置智能体不开放删除。 */
function deleteManagedResource({ id, name, type, force = false } = {}) {
  const rm = manager();
  const resource = findManaged(rm, { id, name, type });
  if (!resource) return { ok: false, error: '资产不存在' };
  const result = rm.deleteResource(resource.id, { force: !!force, allowBuiltin: false });
  if (result && result.success === false) return { ok: false, error: result.error || '删除失败' };
  return ok({ id: resource.id, name: resource.name, type: resource.type, deleted: true });
}

/** 和资产页投射同一条接口。高风险先拦住，等用户确认。 */
function projectManagedResource({ id, name, type, agentIds, agentId, scope, force = false, allowRisky = false } = {}) {
  const rm = manager();
  const resource = findManaged(rm, { id, name, type });
  if (!resource) return { ok: false, error: '资产不存在' };
  const ids = asList(agentIds).concat(asList(agentId));
  if (!ids.length) return { ok: false, error: '要给出 agentIds，例如 ["codex","claude-code"]' };
  if (!allowRisky) {
    const risk = require('./asset-checks').securityGate(resource);
    if (risk) return { ok: false, error: 'security-risk', securityFindings: risk.findings || [] };
  }
  const result = rm.projectToAgents(resource.id, ids, scope || 'global', { force: !!force });
  if (result && result.success === false) return { ok: false, error: result.error || '投射失败' };
  return ok({
    resource: briefResource(result.resource || rm.getResource(resource.id)),
    hint: result.hint || null,
    conflicts: (result.conflicts || []).map(c => c.agentId).filter(Boolean),
    missingDependencies: result.missingDependencies || [],
  });
}

/** 和资产页撤下投射同一条接口。 */
function unprojectManagedResource({ id, name, type, agentId, agentIds, projectionId } = {}) {
  const rm = manager();
  if (projectionId && !agentId && !agentIds) {
    const result = rm.unproject({ projectionId, byUser: true });
    if (result && result.success === false) return { ok: false, error: result.error || '撤下失败' };
    return ok({ resource: briefResource(result.resource) });
  }
  const resource = findManaged(rm, { id, name, type });
  if (!resource) return { ok: false, error: '资产不存在' };
  const ids = asList(agentIds).concat(asList(agentId));
  if (!ids.length) return { ok: false, error: '要给出 agentId 或 projectionId' };
  let last = null;
  for (const one of ids) last = rm.unproject({ resourceId: resource.id, agentId: one, byUser: true });
  return ok({ resource: briefResource((last && last.resource) || rm.getResource(resource.id)), agentIds: ids });
}

/** 和资产页检查投射同一条接口。 */
function verifyManagedResource({ id, name, type, repair = false } = {}) {
  const rm = manager();
  const resource = findManaged(rm, { id, name, type });
  if (!resource) return { ok: false, error: '资产不存在' };
  const result = rm.verifyProjections(resource.id, { repair: !!repair });
  if (result && result.success === false) return { ok: false, error: result.error || '检查失败' };
  return ok({
    resource: briefResource(result.resource || resource),
    projections: (result.projections || []).map(p => ({
      agentId: p.agentId,
      healthy: !!(p.health && p.health.healthy),
      repairable: !!(p.health && p.health.repairable),
      repaired: !!p.repaired,
      repairError: (p.health && p.health.repairError) || null,
    })),
  });
}

/** 经资产库接口把磁盘上的新技能扫进库。 */
function syncManagedSkills(filters = {}) {
  const rm = manager();
  const r = rm.syncDiscoveredSkills(filters && typeof filters === 'object' ? filters : {}) || {};
  return ok({ imported: r.imported || 0, updated: r.updated || 0 });
}

/** 和资产页从路径导入同一条接口。 */
function importManagedResource({ sourcePath, path: filePath, type } = {}) {
  const src = String(sourcePath || filePath || '').trim();
  if (!src) return { ok: false, error: '要给出 sourcePath' };
  const result = manager().importFromPath({ sourcePath: src, type: type || undefined });
  if (result && result.success === false) return { ok: false, error: result.error || '导入失败' };
  return ok({
    resource: briefResource(result.resource),
    alreadyInstalled: !!result.alreadyInstalled,
    hint: result.hint || null,
  });
}

/** 和资产页安装同一条接口。付费社区条目留给用户在资产页确认。 */
async function installManagedResource({ source, url, slug, catalogId, force = false, description = '' } = {}) {
  const rm = manager();
  if (catalogId) {
    const result = rm.installFromCatalog(catalogId);
    if (result && result.success === false) return { ok: false, error: result.error || '安装失败' };
    return ok({ resource: briefResource(result.resource), alreadyInstalled: !!result.alreadyInstalled });
  }
  const target = String(source || url || slug || '').trim();
  if (!target) return { ok: false, error: '要给出 source（GitHub 地址、owner/repo 或技能名）或 catalogId' };
  const isGithub = /github\.com\/|^[\w.-]+\/[\w.-]+$/.test(target);
  if (isGithub) {
    const result = await rm.installGithubSkill(target, { force: !!force, description: description || '' });
    if (!result || result.success === false) return { ok: false, error: result?.error || '安装失败' };
    return ok({ resource: briefResource(result.resource), skillName: result.skillName || null });
  }
  let catalog = [];
  try { catalog = require('../resource-catalog').listCatalogItems({}); } catch { /* 离线目录 */ }
  const q = target.toLowerCase();
  const hit = catalog.find(c => c.name?.toLowerCase() === q || String(c.display_name || '').toLowerCase() === q);
  if (hit && hit.metadata?.user_recommended && hit.metadata?.recommender_user_id) {
    return { ok: false, error: '这是付费的社区条目，请到资产页确认后再装' };
  }
  if (hit) {
    const result = rm.installFromCatalog(hit.catalogId);
    if (result && result.success === false) return { ok: false, error: result.error || '安装失败' };
    return ok({ resource: briefResource(result.resource), alreadyInstalled: !!result.alreadyInstalled });
  }
  const result = await rm.installSkillhubSkill(target, { force: !!force, description: description || '' });
  if (!result || result.success === false) return { ok: false, error: result?.error || '安装失败' };
  return ok({ resource: briefResource(result.resource), skillName: result.skillName || target });
}

async function handle(op, args) {
  const spec = OPS[op];
  if (!spec) return { ok: false, error: `没有这个操作：${op}（可用：${Object.keys(OPS).join('、')}）` };
  try {
    return await spec.run(args && typeof args === 'object' ? args : {});
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

const HELPER = `#!/usr/bin/env node
// Token Bank 智能管家的本机接口（智能管家用）。用法：node tb-guardian.js <操作> '<JSON 参数>'
const fs = require('fs'); const http = require('http'); const path = require('path');
const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent-api.json'), 'utf8'));
const [op = 'help', raw = '{}'] = process.argv.slice(2);
const body = JSON.stringify({ op, args: JSON.parse(raw) });
const u = new URL(info.url + '/op');
const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: 'Bearer ' + info.token } },
  (res) => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { process.stdout.write(b + '\\n'); process.exitCode = res.statusCode < 400 ? 0 : 1; }); });
req.on('error', (e) => { console.error('智能管家接口连不上（Token Bank 没在运行？）', e.message); process.exitCode = 1; });
req.end(body);
`;

function start() {
  if (server) return;
  const token = crypto.randomBytes(24).toString('hex');
  server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (String(req.headers.authorization || '') !== `Bearer ${token}`) return send(401, { ok: false, error: 'unauthorized' });
    if (req.method !== 'POST' || !String(req.url || '').startsWith('/op')) return send(404, { ok: false, error: 'not found' });
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 256 * 1024) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(buf || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
      send(200, await handle(String(body.op || ''), body.args));
    });
  });
  server.on('error', (e) => console.warn('[guardian] agent api:', e.message));
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    try {
      fs.mkdirSync(store.dir(), { recursive: true });
      fs.writeFileSync(infoPath(), JSON.stringify({ url: `http://127.0.0.1:${port}`, token }), { mode: 0o600 });
      fs.writeFileSync(helperPath(), HELPER, { mode: 0o700 });
    } catch (e) { console.warn('[guardian] agent api info:', e.message); }
  });
  if (server.unref) server.unref();
}

function stop() {
  if (server) { server.close(); server = null; }
}

/** 给智能管家的说明：怎么在对话里操作智能管家 */
function agentGuide() {
  return [
    '你在对话里能做智能管家页和资产页上能做的事，用这个命令（Token Bank 在运行时可用）：',
    `  node "${helperPath()}" <操作> '<JSON 参数>'`,
    '操作：',
    ...Object.entries(OPS).map(([k, v]) => `- ${k}：${v.desc}`),
    '先用 records / status 看清楚再动手。用户明确要求的直接做，做完用一两句话告诉他结果和怎么撤销；你自己想做的改动先说清楚再做。',
  ].join('\n');
}

module.exports = {
  start, stop, handle, agentGuide, OPS, infoPath, helperPath,
  saveManagedResource, syncManagedSkills, patchAssistantContent,
  listManagedResources, getManagedResource, deleteManagedResource,
  projectManagedResource, unprojectManagedResource, verifyManagedResource,
  importManagedResource, installManagedResource,
};
