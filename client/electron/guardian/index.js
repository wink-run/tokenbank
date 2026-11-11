// client/electron/guardian/index.js
// Token Bank 内置智能管家（看不见的智能层）核心：桌面版 main.js 与 Docker（cli/gateway.js）共用。
//
// 原则（见方案文档）：
//  - 不在业务链路上：模型分发、智能体调用照常运行；这里只接收「已经发生」的失败事件，异步处理
//  - 只管 Token Bank 自己：改投射、记录、给建议；不替用户做业务
//  - 分级：auto = 有把握且可撤销就直接做；suggest = 记一条建议等用户点；off = 不处理
//  - 每个动作写进「自动处理记录」，可撤销；同类问题按签名去重
'use strict';

const store = require('./store');

const CATEGORIES = {
  projection: { default: 'auto' },  // 投射自愈
  gateway: { default: 'auto' },     // 供给源失败解读、额度预警
  install: { default: 'auto' },     // 智能体应用安装失败修复
  assets: { default: 'auto' },      // 资产体检：质量、安全、重复、新版本（只给建议，改内容要用户点）
  setup: { default: 'auto' },       // 配置提醒：装了没纳管的应用、还没接模型
  community: { default: 'auto' },   // 分享与多设备：分享推荐、分享前整理、设备间资产差异（对外发布永远要用户点）
  discover: { default: 'auto' },    // 发现页：能力缺口、记住不感兴趣的推荐和对画像的修改（关掉后不提醒、不学习）
};
const MODES = new Set(['auto', 'suggest', 'off']);
const RECORDS_MAX = 300;
const DISMISS_QUIET_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  modes: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.default])),
};

const listeners = new Map();   // event type → Set<fn>
const actions = new Map();     // action type → fn(data) → { ok, error? }
const checks = new Map();      // name → { fn, intervalMs, timer }
let started = false;

// ── 设置 ────────────────────────────────────────────────────────────────────
function getSettings() {
  const raw = store.readJson('settings.json', {});
  const modes = { ...DEFAULT_SETTINGS.modes, ...(raw.modes || {}) };
  for (const k of Object.keys(modes)) if (!MODES.has(modes[k])) modes[k] = CATEGORIES[k]?.default || 'auto';
  return { enabled: raw.enabled !== false, modes };
}

function setSettings(patch = {}) {
  const cur = getSettings();
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : cur.enabled,
    modes: { ...cur.modes },
  };
  for (const [k, v] of Object.entries(patch.modes || {})) {
    if (CATEGORIES[k] && MODES.has(v)) next.modes[k] = v;
  }
  store.writeJson('settings.json', next);
  return next;
}

/** 智能管家开着就直接处理（'auto'），关了就什么都不做（'off'）。不再有「只给建议」 */
function modeOf() {
  return getSettings().enabled ? 'auto' : 'off';
}

// ── 自动处理记录 ─────────────────────────────────────────────────────────────
function listRecords({ limit = 100 } = {}) {
  const all = store.readJson('records.json', []);
  return Array.isArray(all) ? all.slice(0, limit) : [];
}

function saveRecords(list) {
  store.writeJson('records.json', list.slice(0, RECORDS_MAX));
}

function newId() {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * 写一条记录。entry: { category, kind, title, detail?, advice?, status, signature?, undo?, apply?, actions?, link?, meta? }
 * actions: [{ label, run: { type, data }, undo?: { type, data }, done? }] —— 在记录上就地处理的按钮（不用跳转）；
 *   点了跑 run，成功后记录变「已处理」，可撤销的带上 undo（动作返回的 undo 优先，适合执行时才知道怎么撤）。
 * status: done（已自动处理，可撤销）| suggested（建议，等用户点）| info（提醒）| failed（尝试未成功）
 * 同签名还没处理的记录 → 合并（count + 1）并移到最前，不刷屏；用户忽略过的，7 天内不再提（返回 null）
 */
function record(entry) {
  // 自我进化：先照学到的规则判一遍 —— 不算问题就不提醒
  if (!entry._judged) {
    let j = { entry };
    try { j = require('./judgment').apply(entry); } catch (e) { console.warn('[guardian] judgment:', e.message); }
    if (j.skip) {
      if (entry.signature) resolveSignature(entry.signature, `按学到的规则不算问题：${j.rule.reason}`);
      return null;
    }
    entry = j.entry;
  }
  entry = { ...entry };
  delete entry._judged;
  // 没有「待处理」：需要用户的事由智能管家在对话里说一句；只是告诉一声的不说；记录里只留做过的事
  if (entry.status === 'info' || entry.status === 'suggested') {
    if (needsUser(entry)) speak(entry);
    return null;
  }
  const now = Date.now();
  const list = listRecords({ limit: RECORDS_MAX });
  if (entry.signature) {
    const idx = list.findIndex(r => r.signature === entry.signature && ['info', 'suggested', 'failed'].includes(r.status));
    if (idx >= 0) {
      const hit = list[idx];
      const merged = {
        ...hit, ...entry, id: hit.id, at: hit.at, lastAt: now,
        count: (hit.count || 1) + (entry.countAsRepeat === false ? 0 : 1),
      };
      delete merged.countAsRepeat;
      list.splice(idx, 1);
      saveRecords([merged, ...list]);
      return merged;
    }
    const quiet = list.find(r => r.signature === entry.signature && r.status === 'dismissed'
      && now - (r.dismissedAt || r.lastAt || r.at) < (r.quietDays ? r.quietDays * 24 * 60 * 60 * 1000 : DISMISS_QUIET_MS));
    if (quiet) return null;
  }
  const rec = { id: newId(), at: now, lastAt: now, count: 1, ...entry };
  delete rec.countAsRepeat;
  saveRecords([rec, ...list]);
  return rec;
}

/** 某签名的问题已经不存在了：把还开着的记录收起（不删除，留痕） */
function resolveSignature(signature, note) {
  const list = listRecords({ limit: RECORDS_MAX });
  let changed = false;
  for (const r of list) {
    if (r.signature === signature && ['info', 'suggested', 'failed'].includes(r.status)) {
      r.status = 'resolved';
      r.resolvedAt = Date.now();
      if (note) r.resolvedNote = note;
      changed = true;
    }
  }
  if (changed) saveRecords(list);
  return changed;
}

function updateRecord(id, patch) {
  const list = listRecords({ limit: RECORDS_MAX });
  const idx = list.findIndex(r => r.id === id);
  if (idx < 0) return null;
  list[idx] = { ...list[idx], ...patch };
  saveRecords(list);
  return list[idx];
}

function registerAction(type, fn) {
  actions.set(type, fn);
}

async function runAction(spec) {
  const fn = spec && actions.get(spec.type);
  if (!fn) return { ok: false, error: 'unknown-action' };
  try {
    const r = await fn(spec.data || {});
    return r && typeof r === 'object' ? r : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** 撤销一条已自动处理的记录 */
async function undo(id) {
  const rec = listRecords({ limit: RECORDS_MAX }).find(r => r.id === id);
  if (!rec) return { ok: false, error: 'not-found' };
  if (rec.status !== 'done' || !rec.undo) return { ok: false, error: 'not-undoable' };
  const r = await runAction(rec.undo);
  if (r.ok) {
    updateRecord(id, { status: 'undone', undoneAt: Date.now() });
    // 进化：撤销就是「这次处理错了」。记成案例；是按规矩做的，就给那条规矩记一笔
    try {
      const rules = require('./rules');
      if (rec.byRule) rules.noteUndo(rec.byRule);
      if (rec.byJudge && rec.caseEvent) { try { require('./judge').forgetEvent(rec.caseEvent); } catch { /* ignore */ } }
      if (rec.caseEvent && rec.facts) rules.addCase({ event: rec.caseEvent, facts: rec.facts, expect: 'ignore', note: `用户撤销了：${rec.title}` });
    } catch { /* ignore */ }
  }
  return r;
}

/** 采纳一条建议 */
async function apply(id) {
  const rec = listRecords({ limit: RECORDS_MAX }).find(r => r.id === id);
  if (!rec) return { ok: false, error: 'not-found' };
  if (!rec.apply && Array.isArray(rec.actions) && rec.actions.length) return act(id, 0);
  if (rec.status !== 'suggested' || !rec.apply) return { ok: false, error: 'not-applicable' };
  const r = await runAction(rec.apply);
  updateRecord(id, r.ok
    ? { status: 'done', appliedAt: Date.now(), ...(rec.applyUndo ? { undo: rec.applyUndo } : {}) }
    : { lastError: r.error });
  return r;
}

/** 就地处理：点记录上的第 index 个按钮 */
async function act(id, index) {
  const rec = listRecords({ limit: RECORDS_MAX }).find(r => r.id === id);
  if (!rec) return { ok: false, error: 'not-found' };
  const a = Array.isArray(rec.actions) ? rec.actions[Number(index) || 0] : null;
  if (!a || !a.run || !['info', 'suggested', 'failed'].includes(rec.status)) return { ok: false, error: 'not-applicable' };
  const r = await runAction(a.run);
  if (!r.ok) { updateRecord(id, { lastError: r.error }); return r; }
  const undoSpec = r.undo || a.undo || null;
  updateRecord(id, {
    status: 'done', appliedAt: Date.now(), actedLabel: a.done || a.label, lastError: null,
    ...(r.message ? { resultNote: String(r.message).slice(0, 300) } : {}),
    ...(undoSpec ? { undo: undoSpec } : { undo: null }),
  });
  return r;
}

/** 同签名的自动处理被用户撤销过：尊重用户，之后只提建议、不再自动做 */
function wasUndone(signature) {
  return !!signature && listRecords({ limit: RECORDS_MAX }).some(r => r.signature === signature && r.status === 'undone');
}

/**
 * 记一条带就地按钮的记录；该类是「自动处理」且有标了 auto 的按钮（没风险、可撤销）时直接做，
 * 记成「已处理」并带撤销；做不成或用户撤销过，就照常留一条待处理。
 */
async function handle(entry) {
  // 自我进化：照学到的规则判一遍（record() 就不再判第二次）
  try {
    const j = require('./judgment').apply(entry);
    if (j.skip) {
      if (entry.signature) resolveSignature(entry.signature, `按学到的规则不算问题：${j.rule.reason}`);
      return null;
    }
    entry = { ...j.entry, _judged: true };
  } catch (e) { console.warn('[guardian] judgment:', e.message); }
  const idx = Array.isArray(entry.actions) ? entry.actions.findIndex(a => a && a.auto) : -1;
  if (idx >= 0 && modeOf(entry.category) === 'auto' && !wasUndone(entry.signature)) {
    const a = entry.actions[idx];
    const r = await runAction(a.run);
    if (r.ok) {
      if (entry.signature) resolveSignature(entry.signature, '已自动处理');
      const { actions, countAsRepeat, ...rest } = entry;
      const undoSpec = r.undo || a.undo || null;
      return record({
        ...rest, status: 'done', auto: true, appliedAt: Date.now(), actedLabel: a.done || a.label,
        ...(r.message ? { resultNote: String(r.message).slice(0, 300) } : {}),
        ...(undoSpec ? { undo: undoSpec } : {}),
      });
    }
    entry = { ...entry, lastError: r.error };
  }
  return record(entry);
}

// ── 需要用户的事：在对话里说一句，带几个快捷回复 ───────────────────────────────
const OPEN_STATUS = ['info', 'suggested', 'failed'];

/** 只有用户能决定或动手的才开口：有处理方式可选的，或明确标了 needsUser 的 */
function needsUser(e) {
  if (!e) return false;
  return (Array.isArray(e.actions) && e.actions.length > 0) || !!e.apply || e.needsUser === true;
}

function speak(entry) {
  const log = { category: entry.category, kind: entry.kind, title: entry.title, signature: entry.signature, meta: entry.meta };
  const replies = [];
  for (const a of entry.actions || []) {
    replies.push({ label: a.label, op: a.run, undo: a.undo || null, done: a.doneText || null, log: { ...log, actedLabel: a.done || a.label }, confirmOnly: !!a.confirmOnly, match: a.match || [] });
  }
  if (entry.apply) replies.push({ label: entry.applyLabel || '好，就这样做', op: entry.apply, undo: entry.applyUndo || null, log });
  if (entry.link) replies.push({ label: entry.link.label || '带我去看', nav: { to: entry.link.to, state: entry.link.state || null } });
  if (entry.remind) replies.push({ label: entry.remind.label || '晚点提醒我', remind: { text: entry.remind.text || entry.title, minutes: entry.remind.minutes || 240, nav: entry.link ? { to: entry.link.to, state: entry.link.state || null } : null, navLabel: entry.link ? entry.link.label : null } });
  if (!entry.noMute) replies.push({ label: '这类不用告诉我', mute: entry.kind });
  const text = [entry.say || `${entry.title}。`, entry.advice].filter(Boolean).join('');
  try {
    return require('./convo').push({ text, replies, mergeKey: entry.signature || null, topic: entry.kind });
  } catch (e) {
    console.warn('[guardian] speak:', e.message);
    return null;
  }
}

/** 老版本留下的「待处理」记录：收起（现在需要用户的事在对话里说） */
function tidy() {
  const now = Date.now();
  const list = listRecords({ limit: RECORDS_MAX });
  let n = 0;
  for (const r of list) {
    if (r.status !== 'info' && r.status !== 'suggested') continue;
    r.status = 'resolved';
    r.resolvedAt = now;
    r.resolvedNote = '改为在对话里说';
    n++;
  }
  if (n) saveRecords(list);
  return { ok: true, expired: n };
}

function dismiss(id) {
  return !!updateRecord(id, { status: 'dismissed', dismissedAt: Date.now() });
}

// ── 事件：异步分发，绝不阻塞调用方 ──────────────────────────────────────────
function on(type, fn) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(fn);
  return () => listeners.get(type)?.delete(fn);
}

function emit(type, payload) {
  const set = listeners.get(type);
  if (!set || !set.size) return;
  setImmediate(() => {
    for (const fn of [...set]) {
      Promise.resolve()
        .then(() => fn(payload))
        .catch(e => console.warn(`[guardian] ${type} handler failed:`, e.message));
    }
  });
}

// ── 检查：没有定时器。只在事件发生时（启动、应用变化）或用户在对话里要求时跑 ──────────
function registerCheck(name, fn) {
  checks.set(name, { fn });
}

async function runCheck(name) {
  const c = checks.get(name);
  if (!c) return { ok: false, error: 'unknown-check' };
  let r;
  runningChecks.add(name);
  try {
    r = (await c.fn()) || { ok: true };
  } catch (e) {
    console.warn(`[guardian] check ${name} failed:`, e.message);
    r = { ok: false, error: e.message };
  } finally {
    runningChecks.delete(name);
  }
  noteCheck(name, r);
  return r;
}

// 正在跑的检查（侧边栏小圆点据此显示「正在执行」的动效）
const runningChecks = new Set();
function runningCheckNames() {
  return [...runningChecks];
}

// ── 运行状态：每项检查最近一次的结果（设置页「运行是否正常」据此显示）────────
function noteCheck(name, r) {
  try {
    const h = store.readJson('health.json', {});
    h[name] = { at: Date.now(), ok: r.ok !== false, error: r.ok === false ? String(r.error || 'failed').slice(0, 200) : null };
    store.writeJson('health.json', h);
  } catch { /* 记不下来不影响检查 */ }
}

function checkHealth() {
  const h = store.readJson('health.json', {});
  const names = [...checks.keys()];
  const runs = names.map(n => ({ name: n, ...(h[n] || { at: null, ok: null, error: null }) }));
  const lastAt = runs.reduce((m, r) => Math.max(m, r.at || 0), 0) || null;
  return { lastAt, failing: runs.filter(r => r.ok === false), total: names.length };
}

async function runChecks() {
  const out = {};
  for (const name of checks.keys()) out[name] = await runCheck(name);
  return out;
}

/** 启动事件：把上次运行期间可能坏掉的投射看一遍（只这一次，不是定时） */
function start({ initialDelayMs = 30000 } = {}) {
  if (started) return;
  started = true;
  const t = setTimeout(() => { if (checks.has('projection')) runCheck('projection').catch(() => {}); }, initialDelayMs);
  if (t.unref) t.unref();
}

function stop() {
  started = false;
}

module.exports = {
  CATEGORIES,
  getSettings,
  setSettings,
  modeOf,
  listRecords,
  record,
  resolveSignature,
  updateRecord,
  registerAction,
  undo,
  apply,
  act,
  needsUser,
  runAction,
  tidy,
  handle,
  wasUndone,
  dismiss,
  on,
  emit,
  registerCheck,
  runCheck,
  runChecks,
  checkHealth,
  runningCheckNames,
  start,
  stop,
};
