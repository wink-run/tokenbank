// client/electron/guardian/index.js
// Token Bank 内置看护（看不见的智能层）核心：桌面版 main.js 与 Docker（cli/gateway.js）共用。
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
  // 规则解释不了的新报错，每天最多请模型分析几次（0 = 只用规则）
  modelExplainPerDay: 10,
  // 定期自省（离线）：频率、运行时段、单次 token 上限、范围、结果处理
  introspect: {
    frequency: 'weekly',        // off | daily | weekly | monthly
    window: 'idle',             // idle（闲置时）| hour（指定时间）
    hour: 3,
    tokenCap: 20000,
    scope: ['assets', 'routes', 'models', 'savings', 'rules'],
    handling: 'report',         // report（只出报告）| auto（可撤销的自动采纳）
  },
};
const INTROSPECT_FREQ = new Set(['off', 'daily', 'weekly', 'monthly']);
const INTROSPECT_SCOPE = new Set(DEFAULT_SETTINGS.introspect.scope);

function normalizeIntrospect(raw = {}, base = DEFAULT_SETTINGS.introspect) {
  const out = { ...base };
  if (INTROSPECT_FREQ.has(raw.frequency)) out.frequency = raw.frequency;
  if (raw.window === 'idle' || raw.window === 'hour') out.window = raw.window;
  if (Number.isFinite(raw.hour)) out.hour = Math.min(23, Math.max(0, Math.floor(raw.hour)));
  if (Number.isFinite(raw.tokenCap)) out.tokenCap = Math.min(1000000, Math.max(0, Math.floor(raw.tokenCap)));
  if (Array.isArray(raw.scope)) out.scope = raw.scope.filter(x => INTROSPECT_SCOPE.has(x));
  if (raw.handling === 'report' || raw.handling === 'auto') out.handling = raw.handling;
  return out;
}

const listeners = new Map();   // event type → Set<fn>
const actions = new Map();     // action type → fn(data) → { ok, error? }
const checks = new Map();      // name → { fn, intervalMs, timer }
let started = false;

// ── 设置 ────────────────────────────────────────────────────────────────────
function getSettings() {
  const raw = store.readJson('settings.json', {});
  const modes = { ...DEFAULT_SETTINGS.modes, ...(raw.modes || {}) };
  for (const k of Object.keys(modes)) if (!MODES.has(modes[k])) modes[k] = CATEGORIES[k]?.default || 'auto';
  return { ...DEFAULT_SETTINGS, ...raw, modes, introspect: normalizeIntrospect(raw.introspect || {}) };
}

function setSettings(patch = {}) {
  const cur = getSettings();
  const next = {
    ...cur,
    ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
    ...(Number.isFinite(patch.modelExplainPerDay) ? { modelExplainPerDay: Math.max(0, Math.floor(patch.modelExplainPerDay)) } : {}),
    modes: { ...cur.modes },
    introspect: patch.introspect && typeof patch.introspect === 'object'
      ? normalizeIntrospect(patch.introspect, cur.introspect)
      : cur.introspect,
  };
  for (const [k, v] of Object.entries(patch.modes || {})) {
    if (CATEGORIES[k] && MODES.has(v)) next.modes[k] = v;
  }
  store.writeJson('settings.json', next);
  return next;
}

/** 该类处理当前的模式；看护整体关闭时一律 off */
function modeOf(category) {
  const s = getSettings();
  if (!s.enabled) return 'off';
  return s.modes[category] || CATEGORIES[category]?.default || 'off';
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
  // 自我进化：先照学到的规则判一遍 —— 不算问题就不提醒；有学到的处理就加上按钮（自动处理时直接做）
  let scheduleAuto = false;
  if (!entry._judged) {
    let j = { entry };
    try { j = require('./judgment').apply(entry); } catch (e) { console.warn('[guardian] judgment:', e.message); }
    if (j.skip) {
      if (entry.signature) resolveSignature(entry.signature, `按学到的规则不算问题：${j.rule.reason}`);
      return null;
    }
    entry = j.entry;
    scheduleAuto = !!entry.learnedRule;
  }
  entry = { ...entry };
  delete entry._judged;
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
      if (scheduleAuto) autoLearned(merged);
      return merged;
    }
    const quiet = list.find(r => r.signature === entry.signature && r.status === 'dismissed'
      && now - (r.dismissedAt || r.lastAt || r.at) < (r.quietDays ? r.quietDays * 24 * 60 * 60 * 1000 : DISMISS_QUIET_MS));
    if (quiet) return null;
  }
  const rec = { id: newId(), at: now, lastAt: now, count: 1, ...entry };
  delete rec.countAsRepeat;
  saveRecords([rec, ...list]);
  if (scheduleAuto) autoLearned(rec);
  return rec;
}

/** 学到的处理：该类是自动处理、用户没撤销过 → 稍后直接做（不阻塞写记录的调用方） */
function autoLearned(rec) {
  if (modeOf(rec.category) !== 'auto' || wasUndone(rec.signature)) return;
  setImmediate(() => { act(rec.id, 0).catch(() => {}); });
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
  if (r.ok) updateRecord(id, { status: 'undone', undoneAt: Date.now() });
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

function dismiss(id) {
  const rec = updateRecord(id, { status: 'dismissed', dismissedAt: Date.now() });
  // 自我进化：同一类提醒忽略多了，问要不要以后不提这一类
  if (rec) setImmediate(() => { Promise.resolve(require('./judgment').learnFromDismiss(rec)).catch(() => {}); });
  return !!rec;
}

// ── 规则库（报错签名 → 次数 / 解释 / 效果）──────────────────────────────────
function getRule(signature) {
  const rules = store.readJson('rules.json', {});
  return rules[signature] || null;
}

function learnRule(signature, patch) {
  const rules = store.readJson('rules.json', {});
  const now = Date.now();
  const cur = rules[signature] || { count: 0, firstAt: now };
  rules[signature] = { ...cur, ...patch, count: (cur.count || 0) + (patch.countDelta || 0), lastAt: now };
  delete rules[signature].countDelta;
  store.writeJson('rules.json', rules);
  return rules[signature];
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

// ── 定期检查（轻量、离线；只看 Token Bank 自己的状态）────────────────────────
function registerCheck(name, fn, intervalMs) {
  checks.set(name, { fn, intervalMs, timer: null });
  if (started) scheduleCheck(name);
}

function scheduleCheck(name) {
  const c = checks.get(name);
  if (!c || !c.intervalMs) return;
  if (c.timer) clearInterval(c.timer);
  c.timer = setInterval(() => runCheck(name).catch(() => {}), c.intervalMs);
  if (c.timer.unref) c.timer.unref();
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

function start({ initialDelayMs = 30000 } = {}) {
  if (started) return;
  started = true;
  for (const name of checks.keys()) scheduleCheck(name);
  const t = setTimeout(() => runChecks().catch(() => {}), initialDelayMs);
  if (t.unref) t.unref();
}

function stop() {
  for (const c of checks.values()) if (c.timer) clearInterval(c.timer);
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
  handle,
  wasUndone,
  dismiss,
  getRule,
  learnRule,
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
