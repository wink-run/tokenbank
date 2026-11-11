// client/electron/guardian/rules.js
// 用户教给智能管家的事件规则，以及「处理错了下次改对」的进化。
//
//  规则 = 事件 + 条件 + 动作。事件和动作都是固定清单，规则只能组合它们，不能执行任意命令。
//  来源：用户在对话里说的（"以后装了新技能自动启用到 Codex"），或管家从纠正里总结的。
//  安全：会降低保护的规则（让雇佣任务审查放行、让管家别管某类安全事件）不能只靠对话生效，
//        必须用户本人确认（由程序核对「确认放宽」，不由模型判断）。
//  进化：每次纠正存成一个案例（当时的事实 + 应该怎么处理）。新规则生效前把案例重放一遍，
//        会让以前处理对的案例变错的规则不生效，交给用户定。规则触发后被撤销多次 → 自动停用。
'use strict';

const store = require('./store');

function guardian() {
  return require('./index');
}

// 事件清单：名字 → 说明、事实、能用的动作
const EVENTS = {
  'skill-installed': {
    label: '装了新技能',
    facts: { resourceId: '资产 id', name: '技能名', source: '来源（local / catalog / github …）' },
    actions: ['project', 'ignore'],
  },
  'app-upgraded': {
    label: '应用升级了',
    facts: { agentId: '应用 id（codex / claude-code / cursor …）', from: '旧版本', to: '新版本' },
    actions: ['repair', 'ignore'],
  },
  'projection-broken': {
    label: '技能在应用里的链接坏了',
    facts: { resourceId: '资产 id', name: '技能名', agentId: '应用 id', reason: '原因（missing / not-symlink / authority-missing …）' },
    actions: ['repair', 'unproject', 'ignore'],
  },
  'route-failed': {
    label: '某来源上的请求失败',
    facts: { provider: '来源 id', model: '模型', streak: '连续失败次数', hour: '几点（0-23）', status: 'HTTP 状态码' },
    actions: ['demote', 'ignore'],
  },
  'task-failed': {
    label: '游乐场任务失败',
    facts: { agentId: '应用 id', kind: '原因类型（not-logged-in / runtime-missing / timeout / quota …）' },
    actions: ['ignore'],
  },
  'hire-task': {
    label: '别人下发的雇佣任务到达',
    facts: { consumer: '雇佣者', text: '任务文字', hits: '命中的审查规则 id，逗号分隔（没命中为空）' },
    actions: ['block', 'refuse', 'allow'],
  },
};

// 动作清单：都是现成的、可撤销或无损的
const ACTIONS = {
  project: { label: '启用到应用', needs: ['agentIds'] },
  unproject: { label: '从应用撤下', needs: [] },
  repair: { label: '重新投射', needs: [] },
  demote: { label: '把这个来源排到后面', needs: [] },
  block: { label: '拦截这个任务', needs: [] },
  refuse: { label: '拒接这个雇佣者', needs: [] },
  allow: { label: '放行（不拦）', needs: [], lowers: true },
  ignore: { label: '不处理', needs: [] },
};

const OPS = new Set(['eq', 'ne', 'in', 'notIn', 'exists', 'match', 'gt', 'lt']);
const MAX_RULES = 100;
const MAX_CASES = 200;
const DISABLE_AFTER_UNDOS = 2;

function all() {
  const r = store.readJson('event-rules.json', []);
  return Array.isArray(r) ? r : [];
}

function save(list) {
  store.writeJson('event-rules.json', list.slice(0, MAX_RULES));
}

function cases() {
  const c = store.readJson('cases.json', []);
  return Array.isArray(c) ? c : [];
}

function test(cond, facts) {
  const v = facts[cond.fact];
  switch (cond.op) {
    case 'eq': return v === cond.value;
    case 'ne': return v !== cond.value;
    case 'in': return Array.isArray(cond.value) && cond.value.includes(v);
    case 'notIn': return Array.isArray(cond.value) && !cond.value.includes(v);
    case 'exists': return (v !== undefined && v !== null && v !== '') === (cond.value !== false);
    case 'match': try { return new RegExp(String(cond.value).slice(0, 200), 'i').test(String(v ?? '')); } catch { return false; }
    case 'gt': return Number(v) > Number(cond.value);
    case 'lt': return Number(v) < Number(cond.value);
    default: return false;
  }
}

function matches(rule, facts) {
  const conds = (rule.when && rule.when.all) || [];
  return conds.every(c => test(c, facts));
}

/** 规则会不会降低保护：放行雇佣任务，或让管家别管安全相关的事 */
function lowersProtection(rule) {
  return !!ACTIONS[rule.action?.type]?.lowers;
}

const FACT_WORD = {
  resourceId: '资产', name: '技能名', source: '来源', agentId: '应用', from: '旧版本', to: '新版本', reason: '原因',
  provider: '来源', model: '模型', streak: '连续失败次数', hour: '时间（几点）', status: '状态码', kind: '原因类型',
  consumer: '雇佣者', text: '任务内容', hits: '命中的审查项',
};
const OP_WORD = { eq: '是', ne: '不是', in: '是其中之一：', notIn: '不在其中：', match: '含有', gt: '大于', lt: '小于' };

function condText(c) {
  if (c.op === 'exists') return `${c.value === false ? '没有' : '有'}${FACT_WORD[c.fact] || c.fact}`;
  const v = Array.isArray(c.value) ? c.value.join('、') : String(c.value);
  return `${FACT_WORD[c.fact] || c.fact}${OP_WORD[c.op] || c.op}「${v}」`;
}

/** 用人话说一条规矩：什么时候、怎么处理 */
function describe(rule) {
  const ev = EVENTS[rule.event];
  const conds = ((rule.when && rule.when.all) || []).map(condText).join('、');
  const act = ACTIONS[rule.action?.type];
  const extra = rule.action?.type === 'project' ? `（${(rule.action.data?.agentIds || []).join('、')}）` : '';
  return `${ev ? ev.label : rule.event}${conds ? `（${conds}）` : ''}时，${act ? act.label : rule.action?.type}${extra}`;
}

function validate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '不是 JSON 对象' };
  const ev = EVENTS[raw.event];
  if (!ev) return { ok: false, error: `没有这个事件：${raw.event}。可用：${Object.keys(EVENTS).join('、')}。不在清单里的事现在做不到，要等 Token Bank 出新版本` };
  const type = raw.action && raw.action.type;
  if (!ACTIONS[type]) return { ok: false, error: `没有这个处理：${type}。我能用的只有：${Object.entries(ACTIONS).map(([k, v]) => `${k}（${v.label}）`).join('、')}。执行命令这类不在里面，要等新版本` };
  if (!ev.actions.includes(type)) return { ok: false, error: `「${ev.label}」这个事件不能用「${ACTIONS[type].label}」。它能用：${ev.actions.join('、')}` };
  const data = raw.action.data && typeof raw.action.data === 'object' ? raw.action.data : {};
  for (const k of ACTIONS[type].needs) {
    if (!data[k] || (Array.isArray(data[k]) && !data[k].length)) return { ok: false, error: `「${ACTIONS[type].label}」需要 ${k}` };
  }
  const conds = (raw.when && raw.when.all) || [];
  if (!Array.isArray(conds) || conds.length > 10) return { ok: false, error: '条件写在 when.all 里，最多 10 个' };
  for (const c of conds) {
    if (!c || !Object.prototype.hasOwnProperty.call(ev.facts, c.fact)) return { ok: false, error: `「${ev.label}」没有事实「${c?.fact}」。可用：${Object.keys(ev.facts).join('、')}` };
    if (!OPS.has(c.op)) return { ok: false, error: `不支持的比较：${c.op}` };
    if (c.op === 'match') { try { new RegExp(String(c.value)); } catch { return { ok: false, error: `正则写错了：${c.value}` }; } }
  }
  if (type === 'allow' && !conds.length) return { ok: false, error: '放行规则必须带条件，不能把雇佣任务全部放行' };
  const reason = String(raw.reason || '').trim().slice(0, 300);
  if (!reason) return { ok: false, error: '要写清楚 reason：用户为什么要这样' };
  return {
    ok: true,
    rule: {
      id: `er-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      event: raw.event, when: { all: conds }, action: { type, data },
      reason, source: raw.source === 'correction' ? 'correction' : 'user',
      createdAt: Date.now(), hits: 0, undos: 0, enabled: true,
    },
  };
}

/** 这个事件按规则该怎么处理（第一条命中的）。没有规则命中返回 null，调用方照默认做 */
function decide(event, facts) {
  const list = all();
  const hit = list.find(r => r.enabled !== false && r.event === event && matches(r, facts));
  if (!hit) return null;
  hit.hits = (hit.hits || 0) + 1;
  hit.lastHitAt = Date.now();
  save(list);
  return { rule: hit, action: hit.action.type, data: hit.action.data || {} };
}

/** 案例回放：加上这条规则后，以前定过的案例会不会被处理成别的样子 */
function replay(rule) {
  const conflicts = [];
  const list = [rule, ...all().filter(r => r.enabled !== false)];
  for (const c of cases()) {
    if (c.event !== rule.event) continue;
    const hit = list.find(r => r.event === c.event && matches(r, c.facts));
    const got = hit ? hit.action.type : 'default';
    if (hit === rule && got !== c.expect) conflicts.push({ at: c.at, note: c.note || '', expect: c.expect, got, facts: c.facts });
  }
  return { checked: cases().filter(c => c.event === rule.event).length, conflicts };
}

/** 记一个案例：这种情况应该这样处理（expect 是动作名，或 'default' 表示照默认做） */
function addCase({ event, facts, expect, note }) {
  if (!EVENTS[event] || !facts || !expect) return { ok: false, error: '案例需要 event、facts、expect' };
  store.writeJson('cases.json', [{ at: Date.now(), event, facts, expect, note: String(note || '').slice(0, 200) }, ...cases()].slice(0, MAX_CASES));
  return { ok: true };
}

function install(rule) {
  save([rule, ...all().filter(r => r.id !== rule.id)]);
  guardian().record({
    category: 'assets', kind: 'event-rule', status: 'done',
    title: `记下一条规矩：${describe(rule)}`,
    signature: `event-rule|${rule.id}`,
    undo: { type: 'removeEventRule', data: { id: rule.id } },
    meta: { ruleId: rule.id },
  });
  return rule;
}

/**
 * 加一条规则。{ rule, example? }
 *  - 会降低保护：不生效，在对话里请用户亲口确认
 *  - 和以前的案例冲突：不生效，把冲突告诉调用方（管家去问用户按哪个）
 *  - 其余：立即生效
 */
function add(raw, { force = false } = {}) {
  const v = validate(raw);
  if (!v.ok) return v;
  const rule = v.rule;
  if (lowersProtection(rule) && !force) {
    try {
      require('./convo').push({
        text: `这件事我得听你亲口确认，因为它是在放松对别人任务的防护：${describe(rule)}。\n确定的话，回我一句"确认放宽"。`,
        replies: [
          { label: '不放宽，保持拦截', done: '好，保持原样。' },
          { label: '确认放宽', op: { type: 'confirmEventRule', data: { raw: { ...raw, source: raw.source } } }, done: '好，放开了。想收回的时候说一声。', confirmOnly: true },
        ],
        mergeKey: `confirm-rule|${rule.event}|${JSON.stringify(rule.when)}`, topic: 'confirm-rule',
      });
    } catch { /* ignore */ }
    return { ok: true, pending: true, message: '这条会降低保护，已经请用户确认；用户亲口确认后才生效。你不要替用户确认。' };
  }
  const rp = replay(rule);
  if (rp.conflicts.length && !force) {
    return { ok: false, conflict: true, error: `这条规则和以前定过的 ${rp.conflicts.length} 个案例冲突`, conflicts: rp.conflicts.slice(0, 3), checked: rp.checked };
  }
  if (raw.example && typeof raw.example === 'object') addCase({ event: rule.event, facts: raw.example, expect: rule.action.type, note: rule.reason });
  install(rule);
  return { ok: true, rule, text: describe(rule), checked: rp.checked, message: rp.checked ? `已经生效。对照了以前的 ${rp.checked} 个案例，没有冲突。` : '已经生效。' };
}

function remove({ id }) {
  save(all().filter(r => r.id !== id));
  return { ok: true };
}

/** 规则触发的处理被用户撤销了：记一笔；撤销多了就停用这条规则 */
function noteUndo(ruleId) {
  const list = all();
  const r = list.find(x => x.id === ruleId);
  if (!r) return;
  r.undos = (r.undos || 0) + 1;
  if (r.undos >= DISABLE_AFTER_UNDOS && r.enabled !== false) {
    r.enabled = false;
    try {
      require('./convo').push({
        text: `「${describe(r)}」这条规矩，按它做的事你已经撤销了 ${r.undos} 次，我先把它停用了。要恢复或者改成别的，告诉我。`,
        mergeKey: `rule-disabled|${r.id}`, topic: 'rule-disabled',
      });
    } catch { /* ignore */ }
  }
  save(list);
}

function list() {
  return all().map(r => ({ ...r, text: describe(r) }));
}

/** 给智能管家的说明：怎么把用户的话记成规则 */
function agentGuide() {
  const evs = Object.entries(EVENTS).map(([k, v]) => `- ${k}（${v.label}）事实：${Object.entries(v.facts).map(([f, d]) => `${f}=${d}`).join('；')}。能用的处理：${v.actions.join('、')}`).join('\n');
  return [
    '用户告诉你「以后遇到某种情况就这样处理」，或指出你某次处理错了：用 rule 操作记成一条规矩，以后事件发生时程序照着做（不经过你，也不花 token）。',
    '格式：{"add":{"event":"skill-installed","when":{"all":[]},"action":{"type":"project","data":{"agentIds":["claude-code","codex"]}},"reason":"用户要新技能自动启用到这两个应用"}}',
    '是在纠正某次处理时，带上当时的情况作为案例："source":"correction","example":{...当时的事实...}。',
    '条件 op 可用：eq ne in notIn exists match gt lt。处理只能从该事件的清单里选；用户要的事不在清单里（比如执行命令、重装依赖），就直说做不到、要等新版本，不要假装记下了，再说你现在能做的替代办法。',
    '返回 conflict 时：这条规矩会让以前处理对的案例变错。把冲突的案例用人话告诉用户，问按哪个，不要自己决定。',
    '返回 pending 时：这条会降低保护（放行雇佣任务），程序已经请用户亲口确认。你只要告诉用户需要他回一句"确认放宽"，不要替他确认，也不要改规则文件绕过。',
    '连续失败几次才把来源排到后面，用 threshold 操作调（2~50）。认不出的报错，问清楚原因后用 pattern 操作记下来，下次就能认出。',
    '事件清单：',
    evs,
  ].join('\n');
}

function register() {
  const g = guardian();
  g.registerAction('removeEventRule', remove);
  g.registerAction('confirmEventRule', ({ raw }) => {
    const r = add(raw, { force: true });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });
}

module.exports = { EVENTS, ACTIONS, register, add, remove, decide, replay, addCase, noteUndo, list, describe, validate, agentGuide, lowersProtection, _internal: { all, cases } };
