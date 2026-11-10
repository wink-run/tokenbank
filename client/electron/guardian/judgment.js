// client/electron/guardian/judgment.js
// 判断规则（数据，不是代码）：看护判错了（误报），不用等发版本修。
//
//  - 每项检查在下结论时把依据写成「事实」（facts），比如投射：目标是不是软链、链接指向哪、真身在不在
//  - 判断规则 = 「某类结论 + 事实满足这些条件 → 不算问题」，存成 JSON，下次检查就照着判
//  - 规则从哪来：用户点「误报」→ 内置看护智能体核实 → 写一份提议到 proposed-rules/；
//    智能体在对话里自己发现误报，也走同一条路。看护校验后采纳（或留作建议），都能撤销
//  - 只能「排除误报」，不能执行任何东西；太宽（会把这类结论全部排除）的规则不自动采纳
'use strict';

const fs = require('fs');
const path = require('path');
const guardian = require('./index');
const store = require('./store');

// 每类结论有哪些事实可用（智能体写规则时照着这份写；不在表里的事实名一律拒收）
const FACTS = {
  'projection-gone': {
    category: 'projection',
    label: '投射：原文件不见了',
    facts: {
      agentId: '应用 id（codex / claude-code / cursor …）',
      resourceName: '技能名',
      projectionType: '投射方式（symlink / copy / scan / origin）',
      targetPath: '应用里的技能路径',
      targetExists: '应用里的路径还在（布尔）',
      targetIsSymlink: '应用里的路径是软链（布尔）',
      targetRealPath: '软链最终指向的真实路径',
      targetRealHasSkillMd: '真实路径下有 SKILL.md（布尔）',
      authorityPath: '资产记录里登记的原文件位置（metadata.authorityPath）',
      authorityPathIsSymlink: '登记的原文件位置本身是软链（布尔）',
      sourceUrl: '资产记录的 source_url',
      sourceUrlExists: 'source_url 指向的文件还在（布尔）',
    },
  },
  'projection-unrepairable': { category: 'projection', label: '投射：修不好', facts: null },   // 同上
  'asset-duplicate': {
    category: 'assets',
    label: '资产：两个技能内容重复',
    facts: {
      nameA: '技能 A 名', nameB: '技能 B 名', similarity: '相似度 0~1',
      sameRealDir: '两个技能其实是同一个目录（布尔）',
    },
  },
  'asset-security': {
    category: 'assets',
    label: '资产：包含高风险操作',
    facts: { resourceName: '技能名', codes: '命中的规则代码，逗号分隔', files: '命中的文件，逗号分隔' },
  },
  'asset-quality': {
    category: 'assets',
    label: '资产：描述需要完善（按技能）',
    facts: { resourceName: '技能名', codes: '质量问题代码，逗号分隔', descriptionLength: '描述长度' },
  },
  'review-route-unstable': {
    category: 'gateway',
    label: '路由：某来源上失败多',
    facts: { model: '模型', provider: '供给源 id', calls: '请求数', fails: '失败数', failRate: '失败率 0~1' },
  },
};
FACTS['projection-unrepairable'].facts = FACTS['projection-gone'].facts;

const OPS = new Set(['eq', 'ne', 'in', 'notIn', 'exists', 'match', 'gt', 'lt']);
const MAX_RULES = 200;
const SAMPLE_PER_KIND = 40;

function inboxDir() {
  return path.join(store.dir(), 'proposed-rules');
}

function rules() {
  const r = store.readJson('judgment-rules.json', []);
  return Array.isArray(r) ? r : [];
}

function saveRules(list) {
  store.writeJson('judgment-rules.json', list.slice(0, MAX_RULES));
}

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

/** 校验一条规则；返回 { ok, error?, rule } */
function validate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '不是 JSON 对象' };
  const spec = FACTS[raw.kind];
  if (!spec) return { ok: false, error: `不认识的结论类型：${raw.kind}（可用：${Object.keys(FACTS).join('、')}）` };
  const conds = [...(raw.when?.all || []), ...(raw.when?.any || [])];
  if (!conds.length) return { ok: false, error: '至少要有一个条件（when.all 或 when.any）' };
  if (conds.length > 12) return { ok: false, error: '条件太多（最多 12 个）' };
  for (const c of conds) {
    if (!c || !Object.prototype.hasOwnProperty.call(spec.facts, c.fact)) return { ok: false, error: `「${raw.kind}」没有事实「${c?.fact}」` };
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
      source: ['user', 'agent'].includes(raw.source) ? raw.source : 'agent',
      example: raw.example && typeof raw.example === 'object' ? raw.example : null,
      createdAt: Date.now(),
      hits: 0,
    },
  };
}

// ── 事实样本：最近见过的结论（用来估计一条规则会排除多少）─────────────────
function noteFacts(kind, facts) {
  if (!FACTS[kind] || !facts) return;
  const all = store.readJson('judgment-facts.json', {});
  const list = (all[kind] || []).filter(f => JSON.stringify(f) !== JSON.stringify(facts));
  all[kind] = [facts, ...list].slice(0, SAMPLE_PER_KIND);
  store.writeJson('judgment-facts.json', all);
}

/** 这条结论按判断规则该不该排除；排除就返回规则 */
function judge(kind, facts) {
  if (!facts || !FACTS[kind]) return null;
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

/** 规则会排除最近见过的多少条同类结论 */
function coverage(rule) {
  const samples = (store.readJson('judgment-facts.json', {})[rule.kind]) || [];
  const n = samples.filter(f => matches(rule, f)).length;
  return { matched: n, total: samples.length };
}

/** 采纳后：还开着的、现在会被排除的记录收起来 */
function resolveMatching(rule) {
  let n = 0;
  for (const r of guardian.listRecords({ limit: 300 })) {
    if (!['info', 'suggested', 'failed'].includes(r.status)) continue;
    let internal = new Set();
    try { internal = require('./diagnose').INTERNAL_TARGETS; } catch { /* ignore */ }
    // 资产库内部的那条（agentId 是内部目标）跟着同一技能走，不单独算
    const items = (r.kind === rule.kind && r.facts ? [r.facts] : (Array.isArray(r.factsList) && r.kind === rule.kind ? r.factsList : []))
      .filter(f => !(f && f.agentId && internal.has(f.agentId)));
    if (items.length && items.every(f => matches(rule, f)) && r.signature) {
      guardian.resolveSignature(r.signature, `按判断规则排除：${rule.reason}`);
      n++;
    }
  }
  return n;
}

function addRule({ rule }) {
  const list = rules().filter(r => r.id !== rule.id);
  saveRules([{ ...rule, enabled: true }, ...list]);
  const resolved = resolveMatching(rule);
  return { ok: true, message: resolved ? `已收起 ${resolved} 条按这条规则不算问题的提醒` : '下次检查起照这条规则判断' };
}

function removeRule({ id }) {
  saveRules(rules().filter(r => r.id !== id));
  return { ok: true };
}

function describe(rule) {
  const conds = [...(rule.when.all || []), ...(rule.when.any || [])].map(c => `${c.fact} ${c.op} ${JSON.stringify(c.value)}`).join('，');
  return `${FACTS[rule.kind]?.label || rule.kind}：${conds} 时不算问题`;
}

/** 收提议：proposed-rules/*.json（智能体写的，或用户点「误报」后智能体核实写的） */
async function takeProposals() {
  const dir = inboxDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.json')); } catch { return { ok: true, taken: 0 }; }
  let taken = 0;
  for (const n of names) {
    const file = path.join(dir, n);
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { raw = { _parseError: e.message }; }
    // 处理过的提议改名留档，不再重复收
    try { fs.renameSync(file, `${file}.taken`); } catch { /* ignore */ }
    taken++;
    const v = raw && !raw._parseError ? validate(raw) : { ok: false, error: `JSON 解析失败：${raw?._parseError}` };
    if (!v.ok) {
      guardian.record({
        category: 'assets', kind: 'judgment-rejected', status: 'info', countAsRepeat: false,
        title: '看护智能体提议的判断规则没通过校验', detail: v.error, advice: '可以在游乐场让内置看护智能体按格式重写一份。',
        signature: `judgment-rejected|${n}`,
      });
      continue;
    }
    const rule = v.rule;
    const cov = coverage(rule);
    const tooBroad = cov.total >= 3 && cov.matched === cov.total;
    const entry = {
      category: FACTS[rule.kind].category, kind: 'judgment-rule', status: 'suggested', countAsRepeat: false,
      title: `新判断规则：${describe(rule)}`,
      advice: `${rule.reason}${cov.total ? `（最近 ${cov.total} 条同类提醒里会排除 ${cov.matched} 条）` : ''}${tooBroad ? '。它会排除这一类的全部提醒，范围可能太宽，需要你确认' : ''}`,
      signature: `judgment|${rule.id}`,
      actions: [{
        label: '采纳这条规则', done: '已采纳', auto: !tooBroad,
        run: { type: 'addJudgmentRule', data: { rule } }, undo: { type: 'removeJudgmentRule', data: { id: rule.id } },
      }],
      meta: { rule, coverage: cov },
    };
    await guardian.handle(entry);
  }
  return { ok: true, taken };
}

/** 给内置看护智能体的说明：怎么写判断规则 */
function agentGuide() {
  const kinds = Object.entries(FACTS).map(([k, v]) =>
    `- ${k}（${v.label}）事实：${Object.entries(v.facts).map(([f, d]) => `${f}=${d}`).join('；')}`).join('\n');
  return [
    '发现看护误报（用户说的，或你排查时自己发现的）时，按下面的格式写一条判断规则，看护下次检查就照着判，不用等发版本：',
    `1. 先核实确实是误报（真实文件、链接、配置都看过），向用户说清原因；规则只排除这一种误判，条件尽量具体，不要把这一类结论全部排除。`,
    `2. 把规则写成一个 JSON 文件放到 ${inboxDir()}/（文件名随意，.json 结尾），格式：`,
    '{"kind":"projection-gone","when":{"all":[{"fact":"targetIsSymlink","op":"eq","value":true},{"fact":"targetRealHasSkillMd","op":"eq","value":true}]},"reason":"应用里是指向真身的软链、真身完好，不算原文件丢失","source":"agent","example":{...触发误报的那条事实...}}',
    '   op 可用：eq ne in notIn exists match gt lt。只能写「不算问题」的规则，不能执行任何东西。',
    '3. 看护会校验并告诉用户（看护页里能看到、能撤销）；范围太宽的规则要用户确认。',
    '可用的结论类型和事实：',
    kinds,
  ].join('\n');
}

function register() {
  guardian.registerAction('addJudgmentRule', addRule);
  guardian.registerAction('removeJudgmentRule', removeRule);
  guardian.registerCheck('judgment', takeProposals, 5 * 60 * 1000);
}

module.exports = { FACTS, register, judge, validate, matches, coverage, takeProposals, agentGuide, rules, inboxDir, describe };
