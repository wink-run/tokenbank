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
};
const MODES = new Set(['auto', 'suggest', 'off']);
const RECORDS_MAX = 300;
const DEDUPE_MS = 30 * 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  modes: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.default])),
  // 规则解释不了的新报错，每天最多请模型分析几次（0 = 只用规则）
  modelExplainPerDay: 10,
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
  return { ...DEFAULT_SETTINGS, ...raw, modes };
}

function setSettings(patch = {}) {
  const cur = getSettings();
  const next = {
    ...cur,
    ...(typeof patch.enabled === 'boolean' ? { enabled: patch.enabled } : {}),
    ...(Number.isFinite(patch.modelExplainPerDay) ? { modelExplainPerDay: Math.max(0, Math.floor(patch.modelExplainPerDay)) } : {}),
    modes: { ...cur.modes },
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
 * 写一条记录。entry: { category, kind, title, detail?, status, signature?, undo?, apply?, meta? }
 * status: done（已自动处理，可撤销）| suggested（建议，等用户点）| info（提醒）| failed（尝试未成功）
 * 同签名在 30 分钟内重复出现 → 合并到原记录（count + 1），不刷屏
 */
function record(entry) {
  const now = Date.now();
  const list = listRecords({ limit: RECORDS_MAX });
  if (entry.signature) {
    const hit = list.find(r => r.signature === entry.signature
      && ['info', 'suggested', 'failed'].includes(r.status)
      && now - (r.lastAt || r.at) < DEDUPE_MS);
    if (hit) {
      hit.count = (hit.count || 1) + 1;
      hit.lastAt = now;
      if (entry.detail) hit.detail = entry.detail;
      saveRecords(list);
      return hit;
    }
  }
  const rec = { id: newId(), at: now, lastAt: now, count: 1, ...entry };
  saveRecords([rec, ...list]);
  return rec;
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
  if (rec.status !== 'suggested' || !rec.apply) return { ok: false, error: 'not-applicable' };
  const r = await runAction(rec.apply);
  updateRecord(id, r.ok
    ? { status: 'done', appliedAt: Date.now(), ...(rec.applyUndo ? { undo: rec.applyUndo } : {}) }
    : { lastError: r.error });
  return r;
}

function dismiss(id) {
  return !!updateRecord(id, { status: 'dismissed', dismissedAt: Date.now() });
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
  try {
    return (await c.fn()) || { ok: true };
  } catch (e) {
    console.warn(`[guardian] check ${name} failed:`, e.message);
    return { ok: false, error: e.message };
  }
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
  updateRecord,
  registerAction,
  undo,
  apply,
  dismiss,
  getRule,
  learnRule,
  on,
  emit,
  registerCheck,
  runCheck,
  runChecks,
  start,
  stop,
};
