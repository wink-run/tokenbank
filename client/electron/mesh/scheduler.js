// client/electron/mesh/scheduler.js
// 在发起设备本地选执行设备。纯函数，不碰网络。
'use strict';

const MINE = 'mine:';

/**
 * 解析智能体目标。
 *   mine:codex                 → { kind: 'app', id: 'codex' }
 *   mine:codex@mac-mini        → { kind: 'app', id: 'codex', device: 'mac-mini' }
 *   mine:assistant:res-1@mini  → { kind: 'assistant', id: 'assistant:res-1', device: 'mini' }
 * 不是 mine: 开头返回 null。
 */
function parseMineHarness(harnessId) {
  const raw = String(harnessId || '').trim();
  if (!raw.startsWith(MINE)) return null;
  let rest = raw.slice(MINE.length);
  let device = null;
  const at = rest.lastIndexOf('@');
  if (at > 0) { device = rest.slice(at + 1) || null; rest = rest.slice(0, at); }
  if (!rest) return null;
  if (rest.startsWith('assistant:')) return { kind: 'assistant', id: rest, device };
  if (rest.startsWith('session:')) return { kind: 'session', id: rest, device };
  if (rest.startsWith('external:')) return { kind: 'external', id: rest, device };
  return { kind: 'app', id: rest, device };
}

/** mine:mac-mini/qwen3-32b → { device: 'mac-mini', model: 'qwen3-32b' } */
function parseMineModel(model) {
  const raw = String(model || '').trim();
  if (!raw.startsWith(MINE)) return null;
  const rest = raw.slice(MINE.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) return null;
  return { device: rest.slice(0, slash), model: rest.slice(slash + 1) };
}

function sameName(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/** 设备名、别名或 device_id 都能指定设备 */
function matchesDevice(dev, wanted) {
  const aliases = (dev && dev.descriptor && dev.descriptor.aliases) || [];
  return sameName(dev.name, wanted) || String(dev.device_id) === String(wanted)
    || aliases.some((a) => sameName(a, wanted));
}

function hasTarget(dev, target) {
  const d = dev.descriptor || {};
  if (target.kind === 'app') return (d.apps || []).some((a) => a.id === target.id);
  if (target.kind === 'assistant') return (d.assistants || []).some((a) => a.id === target.id);
  if (target.kind === 'external') return (d.externals || []).some((a) => a.id === target.id);
  if (target.kind === 'session') return (d.sessions || []).some((s) => `session:${s.agent}:${s.id}` === target.id);
  return false;
}

function hasWorkspace(dev, workspace) {
  if (!workspace) return true;
  return ((dev.descriptor || {}).workspaces || []).some((w) => w.name === workspace);
}

function busy(dev) {
  const load = (dev.descriptor || {}).load || {};
  const max = Number(load.max) || 0;
  return max > 0 && Number(load.running || 0) >= max;
}

/**
 * 选执行设备。
 * @param {{ target, workspace?, devices: Array<{ device_id, name, self?, online, descriptor, path?: {kind, rttMs} }>, priorities?: Record<string, number> }} q
 * @returns {{ device: object } | { device: null, reason: string }}
 */
function pickDevice({ target, workspace, devices, priorities = {} }) {
  if (!target) return { device: null, reason: '目标写法不对' };
  let pool = (devices || []).filter((d) => d && (d.self || d.online));
  if (target.device) {
    const named = (devices || []).filter((d) => matchesDevice(d, target.device));
    if (!named.length) return { device: null, reason: `没有叫 ${target.device} 的设备` };
    if (named.length > 1) return { device: null, reason: `有 ${named.length} 台设备都叫 ${target.device}，改个别名区分一下` };
    pool = named.filter((d) => d.self || d.online);
    if (!pool.length) return { device: null, reason: `${target.device} 离线` };
  }
  const capable = pool.filter((d) => hasTarget(d, target));
  if (!capable.length) {
    return { device: null, reason: target.device ? `${target.device} 上没有 ${target.id}` : `没有在线设备装了 ${target.id}` };
  }
  const withWs = capable.filter((d) => hasWorkspace(d, workspace));
  if (!withWs.length) return { device: null, reason: `没有设备配了工作区 ${workspace}` };
  // 点名了设备（或续上一轮）就交给它，满不满由它自己说（满了回 429）；自动挑才避开满负载的。
  // 负载是几秒前报的，刚做完的设备可能还显示满
  const free = target.device ? withWs : withWs.filter((d) => !busy(d));
  if (!free.length) return { device: null, reason: '能做的设备都满负载' };

  const prio = (d) => Number(priorities[d.device_id] ?? 0);
  const relay = (d) => (d.path && d.path.kind === 'relay' ? 1 : 0);
  const rtt = (d) => (d.path && Number.isFinite(d.path.rttMs) ? d.path.rttMs : 1e9);
  const running = (d) => Number(((d.descriptor || {}).load || {}).running || 0);
  free.sort((a, b) =>
    (b.self ? 1 : 0) - (a.self ? 1 : 0)     // 本机能做就在本机做
    || prio(b) - prio(a)                     // 用户设的优先级
    || running(a) - running(b)               // 负载低的
    || relay(a) - relay(b)                   // 直连优先于中继
    || rtt(a) - rtt(b));                     // 延迟低的
  return { device: free[0] };
}

/** 模型：本机没有时，找有这个模型的在线设备（指定设备时只看那一台） */
function pickModelDevice({ model, device, devices }) {
  let pool = (devices || []).filter((d) => d && !d.self && d.online);
  if (device) pool = pool.filter((d) => matchesDevice(d, device));
  const hits = pool.filter((d) => ((d.descriptor || {}).models || []).includes(model));
  const relay = (d) => (d.path && d.path.kind === 'relay' ? 1 : 0);
  hits.sort((a, b) => relay(a) - relay(b));
  return hits;
}

module.exports = { parseMineHarness, parseMineModel, pickDevice, pickModelDevice, matchesDevice };
