// client/electron/guardian/judgment.js
// 自我进化：智能管家学到的规则（数据，不是代码）。误报不用等发版本修。
//
//  - 冷启动：没有任何学到的规则时，内置规则照样能发现问题
//  - 随反馈进化：用户说「不是问题 / 误报」，或智能管家排查时发现自己判错了，就学一条规则：
//    「这类结论在这些条件下不算问题」。以后同类不再提
//  - 规则只能排除提醒，不能执行任何东西；会排除一整类的宽规则一定等用户确认；都能撤销
//
// 每条智能管家记录下结论时带着「事实」：kind、category、记录 meta 里的简单值，加上检查专门给的 facts。
// 智能管家每写一条记录前先照规则判一遍（index.js 的 record()）。
'use strict';

const store = require('./store');

function guardian() {
  return require('./index');
}

// 已知结论类型的事实说明（给智能体看；没列在这里的类型，用智能管家实际见过的事实名）
const FACTS = {
  'projection-gone': {
    label: '投射：原文件不见了',
    facts: {
      resourceId: '资产 id', agentId: '应用 id（codex / claude-code / cursor …）', resourceName: '技能名',
      projectionType: '投射方式（symlink / copy / scan / origin）', targetPath: '应用里的技能路径',
      targetExists: '应用里的路径还在（布尔）', targetIsSymlink: '应用里的路径是软链（布尔）',
      targetRealPath: '软链最终指向的真实路径', targetRealHasSkillMd: '真实路径下有 SKILL.md（布尔）',
      authorityPath: '资产记录里登记的原文件位置', authorityPathIsSymlink: '登记的原文件位置本身是软链（布尔）',
      sourceUrl: '资产记录的 source_url', sourceUrlExists: 'source_url 指向的文件还在（布尔）',
    },
  },
  'projection-unrepairable': { label: '投射：修不好', facts: null },
  'asset-duplicate': {
    label: '资产：两个技能内容重复',
    facts: { nameA: '技能 A 名', nameB: '技能 B 名', similarity: '相似度 0~1', sameRealDir: '两个技能其实是同一个目录（布尔）' },
  },
  'asset-security': {
    label: '资产：包含高风险操作',
    facts: { resourceId: '资产 id', resourceName: '技能名', codes: '命中的规则代码，逗号分隔', files: '命中的文件，逗号分隔' },
  },
  'asset-quality': {
    label: '资产：描述需要完善（按技能）',
    facts: { resourceName: '技能名', codes: '质量问题代码，逗号分隔', descriptionLength: '描述长度' },
  },
  'review-route-unstable': {
    label: '路由：某来源上失败多',
    facts: { model: '模型', provider: '供给源 id', calls: '请求数', fails: '失败数', failRate: '失败率 0~1' },
  },
};
FACTS['projection-unrepairable'].facts = FACTS['projection-gone'].facts;

const OPS = new Set(['eq', 'ne', 'in', 'notIn', 'exists', 'match', 'gt', 'lt']);
const MAX_RULES = 200;
const SAMPLE_PER_KIND = 40;
const SKIP_KINDS = new Set(['judgment-rule']);

function rules() {
  const r = store.readJson('judgment-rules.json', []);
  return Array.isArray(r) ? r : [];
}

function saveRules(list) {
  store.writeJson('judgment-rules.json', list.slice(0, MAX_RULES));
}

// ── 事实 ─────────────────────────────────────────────────────────────────────

/** 一条记录的事实：kind、category、meta 里的简单值，再加检查专门给的 facts */
function factsOf(entry) {
  const out = {};
  for (const [k, v] of Object.entries(entry.meta || {})) {
    if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 300) continue;
    // meta 里也叫 kind / category 的（比如供给源报错的类型），改名留着，不顶掉记录自己的类型
    out[k === 'kind' ? 'subKind' : k === 'category' ? 'subCategory' : k] = v;
  }
  return { ...out, ...(entry.facts || {}), kind: entry.kind, category: entry.category };
}

function samples(kind) {
  return (store.readJson('judgment-facts.json', {})[kind]) || [];
}

function noteFacts(kind, facts) {
  if (!kind || !facts || SKIP_KINDS.has(kind)) return;
  const all = store.readJson('judgment-facts.json', {});
  const key = JSON.stringify(facts);
  const list = (all[kind] || []).filter(f => JSON.stringify(f) !== key);
  all[kind] = [facts, ...list].slice(0, SAMPLE_PER_KIND);
  store.writeJson('judgment-facts.json', all);
}

/** 这一类结论能用哪些事实：说明表里的 + 智能管家实际见过的 + kind / category */
function allowedFacts(kind) {
  const set = new Set(['kind', 'category', ...Object.keys(FACTS[kind]?.facts || {})]);
  for (const f of samples(kind)) Object.keys(f).forEach(k => set.add(k));
  return set;
}

function knownKinds() {
  return [...new Set([...Object.keys(FACTS), ...Object.keys(store.readJson('judgment-facts.json', {}))])].filter(k => !SKIP_KINDS.has(k));
}

// ── 匹配 ─────────────────────────────────────────────────────────────────────

function test(cond, facts) {
  const v = facts[cond.fact];
  switch (cond.op) {
    case 'eq': return v === cond.value;
    case 'ne': return v !== cond.value;
    case 'in': return Array.isArray(cond.value) && cond.value.includes(v);
    case 'notIn': return Array.isArray(cond.value) && !cond.value.includes(v);
    case 'exists': return (v !== undefined && v !== null && v !== '') === (cond.value !== false);
    case 'match': try { return new RegExp(String(cond.value).slice(0, 200)).test(String(v ?? '')); } catch { return false; }
    case 'gt': return Number(v) > Number(cond.value);
    case 'lt': return Number(v) < Number(cond.value);
    default: return false;
  }
}

function matches(rule, facts) {
  const w = rule.when || {};
  const all = Array.isArray(w.all) ? w.all : [];
  const any = Array.isArray(w.any) ? w.any : [];
  if (!all.length && !any.length) return false;
  return all.every(c => test(c, facts)) && (!any.length || any.some(c => test(c, facts)));
}

/** 命中一条「不算问题」的规则就返回它 */
function judge(kind, facts) {
  if (!kind || !facts || SKIP_KINDS.has(kind)) return null;
  noteFacts(kind, facts);
  const list = rules();
  const hit = list.find(r => r.kind === kind && r.enabled !== false && matches(r, facts));
  if (hit) {
    hit.hits = (hit.hits || 0) + 1;
    hit.lastHitAt = Date.now();
    saveRules(list);
  }
  return hit || null;
}

/** 写记录前照学到的规则判一遍（index.js 的 record() 调用）。{ skip, rule } 表示不算问题 */
function apply(entry) {
  if (!entry || !entry.kind || SKIP_KINDS.has(entry.kind) || !['info', 'suggested', 'failed'].includes(entry.status)) return { entry };
  const rule = judge(entry.kind, factsOf(entry));
  return rule ? { skip: true, rule } : { entry };
}

// ── 校验与采纳 ───────────────────────────────────────────────────────────────

function validate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '不是 JSON 对象' };
  const kinds = knownKinds();
  if (!kinds.includes(raw.kind)) return { ok: false, error: `不认识的结论类型：${raw.kind}（可用：${kinds.join('、')}）` };
  const allowed = allowedFacts(raw.kind);
  const conds = [...(raw.when?.all || []), ...(raw.when?.any || [])];
  if (!conds.length) return { ok: false, error: '至少要有一个条件（when.all 或 when.any）' };
  if (conds.length > 12) return { ok: false, error: '条件太多（最多 12 个）' };
  for (const c of conds) {
    if (!c || !allowed.has(c.fact)) return { ok: false, error: `「${raw.kind}」没有事实「${c?.fact}」（可用：${[...allowed].join('、')}）` };
    if (!OPS.has(c.op)) return { ok: false, error: `不支持的比较：${c.op}` };
    if (c.op === 'match') { try { new RegExp(String(c.value)); } catch { return { ok: false, error: `正则写错了：${c.value}` }; } }
  }
  const reason = String(raw.reason || '').trim().slice(0, 300);
  if (!reason) return { ok: false, error: '要写清楚 reason：为什么这种情况不算问题' };
  return {
    ok: true,
    rule: {
      id: `jr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: raw.kind,
      when: { ...(raw.when.all ? { all: raw.when.all } : {}), ...(raw.when.any ? { any: raw.when.any } : {}) },
      verdict: 'ignore',
      reason,
      source: ['user', 'agent', 'feedback'].includes(raw.source) ? raw.source : 'agent',
      createdAt: Date.now(),
      hits: 0,
    },
  };
}

function coverage(rule) {
  const s = samples(rule.kind);
  return { matched: s.filter(f => matches(rule, f)).length, total: s.length };
}

function categoryOf(kind) {
  const r = guardian().listRecords({ limit: 300 }).find(x => x.kind === kind);
  return r?.category || (kind.startsWith('projection') ? 'projection' : kind.startsWith('review') ? 'gateway' : 'assets');
}

/** 采纳后：还开着的、现在按规则不算问题的记录收起来 */
function resolveMatching(rule) {
  const g = guardian();
  let internal = new Set();
  try { internal = require('./diagnose').INTERNAL_TARGETS; } catch { /* ignore */ }
  let n = 0;
  for (const r of g.listRecords({ limit: 300 })) {
    if (r.kind !== rule.kind || !['info', 'suggested', 'failed'].includes(r.status) || !r.signature) continue;
    const list = Array.isArray(r.factsList) && r.factsList.length
      ? r.factsList.filter(f => !(f && f.agentId && internal.has(f.agentId))).map(f => ({ kind: r.kind, category: r.category, ...f }))
      : [factsOf(r)];
    if (!list.length || !list.every(f => matches(rule, f))) continue;
    g.resolveSignature(r.signature, `按学到的规则不算问题：${rule.reason}`);
    n++;
  }
  return n;
}

function addRule({ rule }) {
  const list = rules().filter(r => r.id !== rule.id);
  saveRules([{ ...rule, enabled: true }, ...list]);
  const n = resolveMatching(rule);
  return { ok: true, message: n ? `已收起 ${n} 条按这条规则不算问题的提醒` : '下次检查起照这条规则判断' };
}

function removeRule({ id }) {
  saveRules(rules().filter(r => r.id !== id));
  return { ok: true };
}

function kindLabel(kind) {
  if (FACTS[kind]) return FACTS[kind].label;
  const r = guardian().listRecords({ limit: 300 }).find(x => x.kind === kind);
  return r ? `「${r.title.slice(0, 30)}」这类` : kind;
}

function describe(rule) {
  const conds = [...(rule.when.all || []), ...(rule.when.any || [])]
    .map(c => `${c.fact} ${c.op} ${JSON.stringify(c.value)}`).join('，');
  return `${kindLabel(rule.kind)}：${conds} 时不算问题`;
}

/** 新学到一条规则（提议或反馈）：校验 → 估计范围 → 按该类权限采纳或留作建议 */
async function propose(raw, { forceSuggest = false } = {}) {
  const g = guardian();
  const v = validate(raw);
  if (!v.ok) return v;
  const rule = v.rule;
  const cov = coverage(rule);
  const tooBroad = forceSuggest || (cov.total >= 3 && cov.matched === cov.total);
  await g.handle({
    category: categoryOf(rule.kind), kind: 'judgment-rule', status: 'suggested', countAsRepeat: false,
    title: `学到新规则：${describe(rule)}`,
    advice: `${rule.reason}${cov.total ? `（最近 ${cov.total} 条同类结论里会影响 ${cov.matched} 条）` : ''}${tooBroad ? '。它会影响这一整类，需要你确认' : ''}`,
    signature: `judgment|${rule.id}`,
    actions: [{
      label: '采纳这条规则', done: '已采纳', auto: !tooBroad,
      run: { type: 'addJudgmentRule', data: { rule } }, undo: { type: 'removeJudgmentRule', data: { id: rule.id } },
    }],
    meta: { ruleId: rule.id, ruleSource: rule.source },
  });
  return { ok: true, rule };
}

/** 用户在对话里明确要求的规则：直接生效，记一条「已处理」可撤销 */
async function adoptConfirmed(raw) {
  const v = validate({ ...raw, source: 'user' });
  if (!v.ok) return v;
  const rule = v.rule;
  const r = addRule({ rule });
  guardian().record({
    category: categoryOf(rule.kind), kind: 'judgment-rule', status: 'done', _judged: true,
    title: `学到新规则：${describe(rule)}`, advice: rule.reason, actedLabel: '已采纳', resultNote: r.message,
    signature: `judgment|${rule.id}`, undo: { type: 'removeJudgmentRule', data: { id: rule.id } },
    meta: { ruleId: rule.id, ruleSource: 'user' },
  });
  return { ok: true, rule, adopted: true, message: r.message };
}

/** 给智能管家的说明：工作原则 + 怎么写规则 */
function agentGuide() {
  const kinds = knownKinds().map((k) => {
    const doc = FACTS[k]?.facts || {};
    const names = [...allowedFacts(k)].map(f => (doc[f] ? `${f}=${doc[f]}` : f)).join('；');
    return `- ${k}（${kindLabel(k)}）事实：${names}`;
  }).join('\n');
  return [
    '工作原则（自我进化）：冷启动就能发现问题；用户说「不是问题 / 误报」或你排查发现自己判错了，就学一条规则，以后同类不再提，不等发版本。',
    '学规则的方法：',
    '1. 先核实（真实文件、链接、配置、日志都看过）。条件尽量具体，只覆盖确认过的那种情况。',
    '2. 用 learn 操作提交（见上面的命令）；用户明确要求的写 "source":"user"，立即生效；你自己发现的写 "source":"agent"，会排除一整类的要用户确认。格式：',
    '   {"kind":"projection-gone","when":{"all":[{"fact":"targetIsSymlink","op":"eq","value":true},{"fact":"targetRealHasSkillMd","op":"eq","value":true}]},"reason":"应用里是指向真身的软链、真身完好"}',
    '   op 可用：eq ne in notIn exists match gt lt。规则只能让某类提醒不再出现，不能执行任何东西。',
    '已知的结论类型和事实：',
    kinds,
  ].join('\n');
}

function list() {
  return rules().map(r => ({ ...r, text: describe(r) }));
}

function register() {
  const g = guardian();
  g.registerAction('addJudgmentRule', addRule);
  g.registerAction('removeJudgmentRule', removeRule);
}

module.exports = {
  FACTS, register, judge, apply, factsOf, validate, matches, coverage, propose,
  adoptConfirmed, agentGuide, rules, list, removeRule, describe,
};
