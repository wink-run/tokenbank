// Hit-or-Exit：按命中把资源分成「在用 / 未打穿 / 沉睡 / 冷藏」
// 阈值对齐反囤积规格：48h 轻推口令、7 日建议撤投射、30 日休眠公函
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

const THRESHOLDS = {
  nudgeHours: 48,
  dormantDays: 7,
  coldDays: 30,
};

const HIT_EVENTS_PATH = path.join(os.homedir(), '.tokenbank', 'resource-hit-events.jsonl');
/** 最近一次命中（渲染进程可轮询，防 IPC 丢事件） */
const HIT_LATEST_PATH = path.join(os.homedir(), '.tokenbank', 'resource-hit-latest.json');

/**
 * Token Bank 内置智能体不参与 Hit-or-Exit / 闲置评估
 * （source=builtin 或 metadata.builtin / builtin: source_url）
 */
function isLifecycleExempt(resource) {
  if (!resource || resource.type !== 'assistant') return false;
  if (resource.source === 'builtin') return true;
  if (resource.metadata && resource.metadata.builtin) return true;
  const url = String(resource.source_url || '');
  if (url.startsWith('builtin:')) return true;
  // 内置安装/发现智能体 name 兜底（旧数据可能未标 builtin）
  const name = String(resource.name || '');
  if (name === 'resource-installer' || name === 'resource-finder' || name === 'resource-portrait') return true;
  return false;
}

/** 从资源行 / metadata 取命中字段 */
function readHitMeta(resource) {
  const meta = resource?.metadata && typeof resource.metadata === 'object'
    ? resource.metadata
    : {};
  const useCount = Math.max(
    0,
    Number(resource?.use_count ?? meta.use_count ?? 0) || 0,
  );
  const lastUsedRaw = resource?.last_used_at ?? meta.last_used_at ?? null;
  const lastUsedAt = lastUsedRaw != null ? Number(lastUsedRaw) || 0 : 0;
  const createdAt = Number(resource?.created_at || 0) || 0;
  const projections = Array.isArray(resource?.projections) ? resource.projections : [];
  let enabledAt = 0;
  for (const p of projections) {
    const t = Number(p.createdAt || p.created_at || 0) || 0;
    if (t && (!enabledAt || t < enabledAt)) enabledAt = t;
  }
  if (!enabledAt) enabledAt = createdAt;
  return { useCount, lastUsedAt, createdAt, enabledAt, projectionCount: projections.length };
}

/**
 * @returns {{
 *   layer: 'exempt'|'active'|'pending'|'dormant'|'cold'|'shelf',
 *   nudge: null|'invoke'|'unproject'|'cold_letter',
 *   ageMs: number,
 *   useCount: number,
 *   lastUsedAt: number,
 *   projectionCount: number,
 * }}
 */
function classifyLifecycle(resource, now = Date.now()) {
  // 内置智能体不参与评估
  if (isLifecycleExempt(resource)) {
    const meta = readHitMeta(resource);
    return {
      layer: 'exempt',
      nudge: null,
      ageMs: 0,
      useCount: meta.useCount,
      lastUsedAt: meta.lastUsedAt,
      projectionCount: meta.projectionCount,
    };
  }

  const { useCount, lastUsedAt, enabledAt, projectionCount } = readHitMeta(resource);
  const ageMs = Math.max(0, Number(now) - (enabledAt || Number(now)));

  if (useCount > 0) {
    return {
      layer: 'active',
      nudge: null,
      ageMs,
      useCount,
      lastUsedAt,
      projectionCount,
    };
  }

  // 仅入库、未投射：不算启用成功，沉底
  if (projectionCount === 0) {
    return {
      layer: 'shelf',
      nudge: null,
      ageMs,
      useCount,
      lastUsedAt,
      projectionCount,
    };
  }

  if (ageMs >= THRESHOLDS.coldDays * MS_DAY) {
    return {
      layer: 'cold',
      nudge: 'cold_letter',
      ageMs,
      useCount,
      lastUsedAt,
      projectionCount,
    };
  }
  if (ageMs >= THRESHOLDS.dormantDays * MS_DAY) {
    return {
      layer: 'dormant',
      nudge: 'unproject',
      ageMs,
      useCount,
      lastUsedAt,
      projectionCount,
    };
  }
  if (ageMs >= THRESHOLDS.nudgeHours * MS_HOUR) {
    return {
      layer: 'pending',
      nudge: 'invoke',
      ageMs,
      useCount,
      lastUsedAt,
      projectionCount,
    };
  }
  return {
    layer: 'pending',
    nudge: null,
    ageMs,
    useCount,
    lastUsedAt,
    projectionCount,
  };
}

/** 列表排序权重：在用靠前，冷藏/货架靠后；豁免不参与沉底惩罚 */
function lifecycleSortRank(layer) {
  switch (layer) {
    case 'exempt': return 0;
    case 'active': return 0;
    case 'pending': return 1;
    case 'dormant': return 2;
    case 'cold': return 3;
    case 'shelf': return 4;
    default: return 5;
  }
}

/**
 * 选出需要轻推的条目（默认：48h+ 未命中且已投射；跳过内置智能体）
 * @param {object[]} resources
 * @param {{ now?: number, limit?: number }} [opts]
 */
function listLifecycleNudges(resources, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 5));
  const items = [];
  for (const r of resources || []) {
    if (!r || (r.type !== 'assistant' && r.type !== 'skill' && r.type !== 'prompt')) continue;
    if (isLifecycleExempt(r)) continue;
    const life = classifyLifecycle(r, now);
    if (!life.nudge) continue;
    items.push({
      id: r.id,
      type: r.type,
      name: r.name,
      display_name: r.display_name || r.name,
      layer: life.layer,
      nudge: life.nudge,
      useCount: life.useCount,
      ageMs: life.ageMs,
      projectionCount: life.projectionCount,
    });
  }
  items.sort((a, b) => b.ageMs - a.ageMs);
  return items.slice(0, limit);
}

/** 追加命中事件到 jsonl（主进程可旁路消费） */
function appendHitEvent(evt) {
  try {
    const dir = path.dirname(HIT_EVENTS_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(HIT_EVENTS_PATH, `${JSON.stringify(evt)}\n`, 'utf8');
  } catch { /* ignore */ }
  // 同步写 latest，供渲染进程轮询（IPC 偶发丢事件时兜底）
  try {
    fs.writeFileSync(HIT_LATEST_PATH, JSON.stringify(evt), 'utf8');
  } catch { /* ignore */ }
}

/** 读取最近一次命中（供 IPC 轮询） */
function readLatestHit() {
  try {
    if (!fs.existsSync(HIT_LATEST_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(HIT_LATEST_PATH, 'utf8'));
    if (!raw || !raw.id) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 主进程注册：资产被用到时弹息票 */
let onResourceHit = null;
function setResourceHitHandler(fn) {
  onResourceHit = typeof fn === 'function' ? fn : null;
}

/**
 * 通知主窗口弹出息票。工具都在网关进程里执行，这里直接交给主进程注册的处理函数；
 * 命令行版没有窗口，只记事件。
 */
function notifyResourceHit(payload) {
  const evt = {
    ts: Date.now(),
    id: String(payload?.id || ''),
    name: payload?.name || '',
    displayName: payload?.displayName || payload?.display_name || payload?.name || '',
    type: payload?.type || '',
    useCount: Number(payload?.useCount || 0) || 0,
    clientId: payload?.clientId || '',
  };
  if (!evt.id) return;
  appendHitEvent(evt);
  if (typeof onResourceHit !== 'function') return;
  setImmediate(() => {
    try { onResourceHit(evt); } catch (e) { console.warn('[resource-hit]', e.message); }
  });
}

module.exports = {
  THRESHOLDS,
  HIT_EVENTS_PATH,
  HIT_LATEST_PATH,
  isLifecycleExempt,
  readHitMeta,
  classifyLifecycle,
  lifecycleSortRank,
  listLifecycleNudges,
  appendHitEvent,
  readLatestHit,
  notifyResourceHit,
  setResourceHitHandler,
};
