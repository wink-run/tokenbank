'use strict';
// 网关「上游适配」学习表
//
// 两类失败走不同路径（互补，不互相替代）：
//
// 1) 报文约束（本模块）—— HTTP 400 且可从错误文案推出改参：
//    - set：字段只能为固定值（例：invalid temperature: only 1 is allowed）
//    - strip：上游不认的顶层字段（例：context_management: Extra inputs are not permitted）
//    记入并落盘后，后续同键首包即改写，避免每次「400 → 同源重试」。
//
// 2) 硬错误降级（gateway-cooldown）—— 429/401/403/402：
//    记冷却 + 候选下沉（sink），下次优先试别的源；有 Retry-After/reset 则冷到点。
//    本模块不处理这类错误（返回 null → 外层 failover + noteCooldown）。
//
// 键：providerId::model；strip 类约束额外写 providerId::*，同供给源其它模型共享。

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_FILE = path.join(os.homedir(), '.tokenbank', 'gateway-upstream-hints.json');
let FILE = DEFAULT_FILE;

/** @typedef {{ set?: Record<string, number|string|boolean>, strip?: string[], updated_at?: number }} Hint */

/** @type {Map<string, Hint>} */
const _map = new Map();
let _loaded = false;

function hintKey(providerId, model) {
  return `${providerId || ''}::${model || ''}`;
}

function _normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const set = {};
  const strip = new Set();
  // 兼容旧版 { temperature: 1 }
  if (raw.temperature != null && Number.isFinite(Number(raw.temperature))) {
    set.temperature = Number(raw.temperature);
  }
  if (raw.set && typeof raw.set === 'object') {
    for (const [k, v] of Object.entries(raw.set)) {
      if (k && v !== undefined) set[k] = v;
    }
  }
  const stripArr = Array.isArray(raw.strip) ? raw.strip : [];
  for (const f of stripArr) {
    if (typeof f === 'string' && f) strip.add(f);
  }
  if (!Object.keys(set).length && !strip.size) return null;
  return {
    set: Object.keys(set).length ? set : undefined,
    strip: strip.size ? [...strip] : undefined,
    updated_at: raw.updated_at || 0,
  };
}

function _load() {
  if (_loaded) return;
  _loaded = true;
  if (!FILE) return;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : null);
    if (!arr) return;
    for (const e of arr) {
      if (!e || !e.key) continue;
      const entry = _normalizeEntry(e);
      if (entry) _map.set(e.key, entry);
    }
  } catch { /* 无文件 / 坏 JSON：空表起步 */ }
}

function _save() {
  if (!FILE) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const entries = [];
    for (const [key, e] of _map) {
      const n = _normalizeEntry(e);
      if (!n) continue;
      entries.push({ key, set: n.set, strip: n.strip, updated_at: n.updated_at || 0 });
    }
    fs.writeFileSync(FILE, JSON.stringify({ version: 2, entries }));
  } catch { /* 落盘失败不影响主路径 */ }
}

function get(providerId, model) {
  _load();
  return _map.get(hintKey(providerId, model)) || null;
}

/** 合并 provider 级通配 (*) 与具体 model 的 hint */
function getMerged(providerId, model) {
  _load();
  const wild = _map.get(hintKey(providerId, '*'));
  const specific = model && model !== '*' ? _map.get(hintKey(providerId, model)) : null;
  if (!wild && !specific) return null;
  return mergeHints(wild, specific);
}

function mergeHints(a, b) {
  const set = { ...(a && a.set), ...(b && b.set) };
  const strip = new Set([...(a && a.strip) || [], ...(b && b.strip) || []]);
  const out = {};
  if (Object.keys(set).length) out.set = set;
  if (strip.size) out.strip = [...strip];
  out.updated_at = Math.max((a && a.updated_at) || 0, (b && b.updated_at) || 0);
  return (out.set || out.strip) ? out : null;
}

function hintsEqual(a, b) {
  const ja = JSON.stringify({ set: (a && a.set) || {}, strip: [...((a && a.strip) || [])].sort() });
  const jb = JSON.stringify({ set: (b && b.set) || {}, strip: [...((b && b.strip) || [])].sort() });
  return ja === jb;
}

/** 合并写入；mutations: { set?, strip? }。strip 同时落到 provider::* */
function noteHints(providerId, model, mutations) {
  if (!providerId || !mutations) return null;
  const patch = _normalizeEntry(mutations);
  if (!patch) return null;
  _load();
  const now = Date.now();
  const write = (mod) => {
    const key = hintKey(providerId, mod);
    const prev = _map.get(key);
    const merged = mergeHints(prev, { ...patch, updated_at: now });
    if (prev && hintsEqual(prev, merged)) return prev;
    const entry = { ...merged, updated_at: now };
    _map.set(key, entry);
    return entry;
  };
  const specific = model ? write(model) : null;
  // strip 多为 API schema 级：同供给源其它模型共享
  if (patch.strip && patch.strip.length) write('*');
  _save();
  return specific || get(providerId, '*');
}

/** @deprecated 兼容旧调用 */
function noteFixedTemperature(providerId, model, value) {
  return noteHints(providerId, model, { set: { temperature: value } });
}

/**
 * 把 hint / mutations 应用到 body。
 * set：仅当字段已存在且值不同时改写（不凭空注入）。
 * strip：删除出现的顶层字段。
 * 无改动则返回原 body 引用。
 */
function applyMutations(body, mutations) {
  const m = _normalizeEntry(mutations);
  if (!m || !body || typeof body !== 'object') return body;
  let out = body;
  let changed = false;
  if (m.strip) {
    for (const f of m.strip) {
      if (Object.prototype.hasOwnProperty.call(out, f)) {
        if (!changed) { out = { ...body }; changed = true; }
        delete out[f];
      }
    }
  }
  if (m.set) {
    for (const [k, v] of Object.entries(m.set)) {
      if (out[k] == null) continue; // 未带该字段不注入
      if (out[k] === v || Number(out[k]) === Number(v)) continue;
      if (!changed) { out = { ...out }; changed = true; }
      out[k] = typeof v === 'number' || (typeof out[k] === 'number' && Number.isFinite(Number(v)))
        ? Number(v)
        : v;
    }
  }
  return out;
}

function applyHints(body, providerId, model) {
  return applyMutations(body, getMerged(providerId, model));
}

/** @deprecated 兼容旧调用 */
function applyTemperatureHint(body, providerId, model) {
  return applyHints(body, providerId, model);
}

/**
 * 从上游 400 文案解析可自动修复的报文约束。无法修复（含 429 等）返回 null。
 * @returns {{ set?: Record<string, number>, strip?: string[] } | null}
 */
function parseBodyConstraintError(err) {
  const status = err && err.status;
  const text = [err && err.message, err && err.body].filter(Boolean).join('\n');
  if (!text) return null;
  // 硬错误交给 cooldown，不在此改参
  if (status === 429 || status === 401 || status === 403 || status === 402) return null;
  if (/HTTP_(429|401|403|402)\b/.test(text) && !/HTTP_400\b/.test(text)) return null;

  const set = {};
  const strip = [];

  // invalid temperature: only 1 is allowed for this model（及 top_p 等）
  const reOnly = /invalid\s+([a-z_][a-z0-9_]*)\b[\s\S]*?\bonly\s+([\d.]+)\s+is\s+allowed/gi;
  let m;
  while ((m = reOnly.exec(text))) {
    const field = m[1];
    const val = Number(m[2]);
    if (field && Number.isFinite(val)) set[field] = val;
  }
  // 兜底：temperature ... only N is allowed for this model
  if (set.temperature == null) {
    const t = /\btemperature\b[\s\S]*?\bonly\s+([\d.]+)\s+is\s+allowed\s+for\s+this\s+model/i.exec(text);
    if (t && Number.isFinite(Number(t[1]))) set.temperature = Number(t[1]);
  }

  // field: Extra inputs are not permitted
  const reExtra = /(?:^|[\s"'`])([a-z_][a-z0-9_]*)\s*:\s*Extra inputs are not permitted/gi;
  while ((m = reExtra.exec(text))) {
    if (m[1] && !strip.includes(m[1])) strip.push(m[1]);
  }
  // Unsupported / Unknown parameter: 'field' | "field"
  const reUnsup = /(?:unsupported|unknown)\s+parameter\s*[:\s]+['"]([a-z_][a-z0-9_]*)['"]/gi;
  while ((m = reUnsup.exec(text))) {
    if (m[1] && !strip.includes(m[1])) strip.push(m[1]);
  }
  // 'field' is not supported / not permitted
  const reNotSup = /['"]([a-z_][a-z0-9_]*)['"]\s+is\s+not\s+(?:supported|permitted|allowed)/gi;
  while ((m = reNotSup.exec(text))) {
    if (m[1] && !strip.includes(m[1])) strip.push(m[1]);
  }

  // 新模型不收采样参数：「temperature is not supported / deprecated / cannot be set for this model」之类
  const reSampling = /\b(temperature|top_p|top_k)\b[^\n]{0,80}?\b(not\s+supported|unsupported|deprecated|not\s+allowed|no\s+longer|removed|cannot\s+be|can\s*not\s+be|may\s+not\s+be)/gi;
  while ((m = reSampling.exec(text))) {
    if (!strip.includes(m[1])) strip.push(m[1]);
  }
  // 关不掉思考 / 不收 budget_tokens：换成自适应思考
  if (/\bthinking\b/i.test(text) && /(disabled|budget_tokens|type\s*[:=]?\s*["']?enabled)/i.test(text)
    && /(not\s+supported|unsupported|cannot|can\s*not|must|only|not\s+allowed|deprecated|invalid)/i.test(text)) {
    set.thinking = { type: 'adaptive' };
  }
  // max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for …
  const mt = /max_tokens\D{0,10}(\d+)\s*>\s*(\d+)[^\n]{0,40}maximum/i.exec(text);
  if (mt && Number(mt[2]) > 0) set.max_tokens = Number(mt[2]);

  const out = {};
  if (Object.keys(set).length) out.set = set;
  if (strip.length) out.strip = strip;
  return (out.set || out.strip) ? out : null;
}

/** 描述 mutations，供日志一行输出 */
function describeMutations(mutations) {
  const m = _normalizeEntry(mutations);
  if (!m) return '';
  const parts = [];
  if (m.set) for (const [k, v] of Object.entries(m.set)) parts.push(`${k}→${v}`);
  if (m.strip) for (const f of m.strip) parts.push(`strip:${f}`);
  return parts.join(',');
}

/** 单测用：清空内存表；file=null 禁用落盘 */
function _resetForTests(file = null) {
  _map.clear();
  FILE = file;
  _loaded = true;
}

module.exports = {
  get FILE() { return FILE; },
  DEFAULT_FILE,
  hintKey,
  get,
  getMerged,
  mergeHints,
  noteHints,
  noteFixedTemperature,
  applyMutations,
  applyHints,
  applyTemperatureHint,
  parseBodyConstraintError,
  describeMutations,
  _resetForTests,
  _normalizeEntry,
};
