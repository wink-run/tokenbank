// client/electron/guardian/task-watch.js
// 派发失败复盘：智能体任务失败后（任务已经结束），异步归因并给出处理办法；
// 失败像是「缺能力」时，从社区目录里找一个对得上的免费技能，建议绑定给这个智能体（用户点了才装）。
// 只监听执行器的 task:failed 事件，不改正在执行的任务、不重跑任务。
'use strict';

const guardian = require('./index');

const KINDS = {
  'runtime-missing': { title: '智能体应用没装好', advice: '到「网关」页重新检测或安装这个应用。', link: { to: '/gateway', label: '去检查' } },
  'not-logged-in': { title: '没登录或 Key 失效', advice: '在这个应用里重新登录一次，或检查它使用的 Key。', link: { to: '/gateway', label: '去检查' } },
  permission: { title: '没有权限访问工作目录', advice: '换一个有读写权限的工作目录，或检查目录权限。' },
  timeout: { title: '任务超时', advice: '把任务拆小一点再派，或换一个更快的智能体。' },
  quota: { title: '模型额度或频率受限', advice: '稍后再试，或给它换一个模型来源。', link: { to: '/providers', label: '去看模型' } },
  context: { title: '上下文太长', advice: '缩小任务范围，或换上下文更长的模型。' },
  capability: { title: '缺少需要的能力', advice: '可以给它绑定一个相关的技能。' },
  unknown: { title: '原因不明', advice: '可以换一个智能体再试。' },
};

const RULES = [
  ['runtime-missing', /spawn\s+\S+\s+ENOENT|command not found|not installed|找不到命令|未安装|no such file or directory.*(bin|cli)/i],
  ['not-logged-in', /not logged in|login required|please (run .*)?log ?in|unauthori[sz]ed|\b401\b|invalid (api )?key|authentication (failed|required)|未登录|请先登录/i],
  ['permission', /EACCES|EPERM|permission denied|权限不足|没有权限/i],
  ['quota', /rate.?limit|\b429\b|quota|insufficient (balance|credit)|余额不足|额度/i],
  ['context', /context (length|window)|maximum context|too many tokens|prompt is too long|上下文.*(过长|超出)/i],
  ['timeout', /timed?\s?out|timeout|ETIMEDOUT|超时/i],
  ['capability', /don'?t have (access to |a |the )?(tool|ability|capabilit)|no (suitable )?tool|unable to (access|browse|open|fetch)|cannot (access|browse|open the web)|不支持该|无法(访问|打开|浏览|联网)|没有.{0,6}(工具|能力)/i],
];

function classify(errorText) {
  const s = String(errorText || '');
  for (const [kind, re] of RULES) if (re.test(s)) return { kind, ...KINDS[kind] };
  return { kind: 'unknown', ...KINDS.unknown };
}

function agentName(id) {
  if (require('./chat').isGuardianAgent(id)) {
    const rt = require('./engine').status().runtime;
    return `内置看护智能体${rt ? `（${agentName(rt)}）` : ''}`;
  }
  try { return require('../config-loader').appEntityById(id)?.name || id; } catch { return id; }
}

function taskPrompt(taskId) {
  try {
    const d = require('../local-stats').getDb();
    return d?.prepare('SELECT prompt FROM agent_tasks WHERE id = ?').get(taskId)?.prompt || '';
  } catch { return ''; }
}

// 与资产页「免费替代」同一套打分：双字 + 英文词重合
function grams(s) {
  const t = String(s || '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    if (/\S\S/.test(g)) set.add(g);
  }
  t.split(/[^a-z0-9]+/).filter(w => w.length > 2).forEach(w => set.add(w));
  return set;
}

const isPaid = (item) => !!(item?.metadata?.user_recommended && item?.metadata?.recommender_user_id);

/** 为一段任务描述找社区里最对得上的免费技能（还没装的） */
function matchSkill(prompt) {
  const mine = grams(prompt);
  if (mine.size < 4) return null;
  let catalog = [];
  try { catalog = require('../resource-catalog').listCatalogItems({ type: 'skill' }); } catch { return null; }
  let installed = new Set();
  try {
    const m = require('../resource-manager');
    m.init();
    installed = new Set(m.listResources({ type: 'skill' }).map(r => r.name));
  } catch { /* ignore */ }
  let best = null;
  for (const c of catalog) {
    if (isPaid(c) || installed.has(c.name)) continue;
    const g = grams(`${c.name} ${c.display_name || ''} ${c.description || ''}`);
    let n = 0;
    g.forEach(x => { if (mine.has(x)) n++; });
    const score = n / Math.max(6, Math.min(mine.size, g.size));
    if (score >= 0.3 && (!best || score > best.score)) best = { item: c, score };
  }
  return best && best.item;
}

/** 采纳「补能力」：装技能并只投射给这个智能体；撤销 = 从这个智能体撤下（技能留在资产库） */
function installSkillFor({ catalogId, agentId }) {
  const m = require('../resource-manager');
  m.init();
  const inst = m.installFromCatalog(catalogId);
  if (!inst || inst.success === false) return { ok: false, error: inst?.error || '安装失败' };
  const resourceId = inst.resource?.id;
  const proj = m.projectToAgents(resourceId, [agentId], 'global', { force: false });
  if (proj && proj.success === false) return { ok: false, error: proj.error || '投射失败' };
  return { ok: true, resourceId };
}

function unprojectSkill({ catalogId, agentId }) {
  const m = require('../resource-manager');
  m.init();
  const item = require('../resource-catalog').getCatalogItem(catalogId);
  const r = item && m.listResources({ type: 'skill' }).find(x => x.name === item.name);
  if (!r) return { ok: true };
  const res = m.unproject({ resourceId: r.id, agentId });
  return res && res.success === false ? { ok: false, error: res.error } : { ok: true };
}

async function handleFailed(evt = {}) {
  if (guardian.modeOf('gateway') === 'off') return;
  const agentId = evt.agentId || null;
  if (!agentId) return;
  const error = String(evt.error || evt.result?.error || '');
  const c = classify(error);
  const who = agentName(agentId);
  guardian.record({
    category: 'gateway', kind: 'task-failed', status: 'info',
    title: `派给 ${who} 的任务失败：${c.title}`,
    detail: error.slice(0, 300),
    advice: c.advice,
    signature: `task-fail|${agentId}|${c.kind}`,
    // 只有要用户自己动手的（应用没装好、没登录）才提；超时、上下文太长这类留给自省复盘
    needsUser: c.kind === 'runtime-missing' || c.kind === 'not-logged-in',
    ...(c.link ? { link: c.link } : {}),
    meta: { agentId, kind: c.kind, taskId: evt.taskId || null },
  });

  if (c.kind !== 'capability') return;
  const skill = matchSkill(taskPrompt(evt.taskId));
  if (!skill) return;
  guardian.record({
    category: 'gateway', kind: 'task-capability', status: 'suggested',
    title: `给 ${who} 补一个技能：${skill.display_name || skill.name}`,
    advice: `刚才失败的任务需要它没有的能力；社区里免费的「${skill.display_name || skill.name}」对得上。采纳后只装给 ${who}，可撤销。`,
    signature: `task-capability|${agentId}|${skill.catalogId}`,
    apply: { type: 'installSkillFor', data: { catalogId: skill.catalogId, agentId } },
    applyUndo: { type: 'unprojectSkill', data: { catalogId: skill.catalogId, agentId } },
    meta: { agentId, catalogId: skill.catalogId },
  });
}

let attached = false;
function attach(executor) {
  if (attached) return false;
  let ex = executor;
  if (!ex) { try { ex = require('../agent-executor'); } catch { return false; } }
  if (!ex || typeof ex.on !== 'function') return false;
  attached = true;
  guardian.registerAction('installSkillFor', installSkillFor);
  guardian.registerAction('unprojectSkill', unprojectSkill);
  // 执行器同步 emit：转成看护的异步事件，不占执行器的时间
  ex.on('task:failed', (evt) => guardian.emit('task:failed', evt));
  guardian.on('task:failed', handleFailed);
  return true;
}

module.exports = { attach, classify, matchSkill, handleFailed, KINDS, _internal: { installSkillFor, unprojectSkill, agentName } };
