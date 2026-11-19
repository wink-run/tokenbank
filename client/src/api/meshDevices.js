// client/src/api/meshDevices.js
// 设备网络：本人名下各台设备上有什么（应用、专业智能体、模型源），给各页的「所在设备」列用。
// 数据来自本机网关 GET /v1/devices；本机设置（接活、开放模型、工作区）也经本机网关改。
import { useCallback, useEffect, useState } from 'react';
import { getGateway, getLocalConfig } from './adapter';
import { resolveLocalGatewayBase } from './gatewayModels';

async function gatewayJson(method, path, body) {
  let port = 11430;
  try { port = (await getGateway().status())?.port || port; } catch { /* 用默认端口 */ }
  let key = '';
  try { key = String((await getLocalConfig().get())?.agent_api_key || ''); } catch { key = ''; }
  const res = await fetch(`${resolveLocalGatewayBase(port)}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/** @returns {Promise<{ enabled: boolean, devices: object[], relay: object|null }>} relay：本机在用哪个中继（using：'official' / 'self' / device_id） */
export async function fetchDevices() {
  try {
    const json = await gatewayJson('GET', '/devices');
    return { enabled: !!json?.enabled, devices: Array.isArray(json?.data) ? json.data : [], relay: json?.relay || null };
  } catch {
    return { enabled: false, devices: [], relay: null };
  }
}

// 几个页面同时用：共享一份，10 秒刷新一次
let cache = { enabled: false, devices: [], relay: null };
let loadedAt = 0;
let inflight = null;
const listeners = new Set();

function load(force = false) {
  if (!force && Date.now() - loadedAt < 5000) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetchDevices().then((v) => {
    cache = v;
    loadedAt = Date.now();
    inflight = null;
    listeners.forEach((fn) => fn(v));
    return v;
  });
  return inflight;
}

/**
 * 我的设备。没开设备网络时 enabled=false，各页不显示「所在设备」。
 * @returns {{ enabled: boolean, devices: object[], self: object|null, others: object[], relay: object|null, refresh: () => Promise }}
 */
export function useMeshDevices({ intervalMs = 10000 } = {}) {
  const [state, setState] = useState(cache);
  useEffect(() => {
    let alive = true;
    const fn = (v) => { if (alive) setState(v); };
    listeners.add(fn);
    load().then(fn);
    const timer = setInterval(() => load(true), intervalMs);
    return () => { alive = false; listeners.delete(fn); clearInterval(timer); };
  }, [intervalMs]);
  const refresh = useCallback(() => load(true), []);
  const devices = state.devices || [];
  return {
    enabled: !!state.enabled,
    devices,
    self: devices.find((d) => d.self) || null,
    others: devices.filter((d) => !d.self),
    relay: state.relay || null,
    refresh,
  };
}

/** 这台设备是不是账号现在用的中继；是的话返回 { sessions }（正在转发几对设备） */
export function relayBadge(device, relay) {
  if (!device || !relay) return null;
  const using = relay.using === 'self' ? (device.self ? device.device_id : null) : relay.using;
  if (!using || using === 'official' || device.device_id !== using) return null;
  return { sessions: Number(device.relay?.sessions) || 0 };
}

/** 设备显示名：设备名称优先，没有就用电脑名 */
export function deviceLabel(d) {
  return String(d?.label || (d?.aliases || [])[0] || d?.name || d?.device_id || '');
}

/**
 * 某个应用 / 专业智能体在哪几台设备上。kind 是 'apps' 或 'assistants'。
 * 本机总排第一（includeSelf 为 true 时）；其他设备只列描述里有它的。
 */
export function devicesHaving(devices, kind, id, { includeSelf = true } = {}) {
  const out = [];
  for (const d of devices || []) {
    if (d.self) {
      if (includeSelf) out.push({ label: deviceLabel(d), self: true, online: true, device_id: d.device_id });
      continue;
    }
    if ((d[kind] || []).some((x) => x.id === id)) {
      out.push({ label: deviceLabel(d), self: false, online: !!d.online, device_id: d.device_id });
    }
  }
  return out;
}

/** 只在其他设备上的应用 / 专业智能体：本机列表里没有的 → [{ id, name, devices }] */
export function remoteOnly(devices, kind, localIds) {
  const local = new Set(localIds || []);
  const byId = new Map();
  for (const d of devices || []) {
    if (d.self) continue;
    for (const x of d[kind] || []) {
      if (!x?.id || local.has(x.id)) continue;
      if (!byId.has(x.id)) byId.set(x.id, { id: x.id, name: x.name || x.id, devices: [] });
      byId.get(x.id).devices.push({ label: deviceLabel(d), self: false, online: !!d.online, device_id: d.device_id });
    }
  }
  return [...byId.values()];
}

/** 其他设备开放出来的模型源 → [{ key, name, type, models, device }] */
export function remoteProviders(devices) {
  const out = [];
  for (const d of devices || []) {
    if (d.self || !d.accepts?.model_requests) continue;
    for (const p of d.providers || []) {
      out.push({ key: `${d.device_id}:${p.id}`, id: p.id, name: p.name, type: p.type, models: p.models,
        device: { label: deviceLabel(d), self: false, online: !!d.online, device_id: d.device_id } });
    }
  }
  return out;
}

// ── 本机设置 ───────────────────────────────────────────────────────────────

export async function getSelfSettings() {
  try { return await gatewayJson('GET', '/devices/self/settings'); }
  catch { return { enabled: false }; }
}

export function updateSelfSettings(patch) {
  return gatewayJson('PUT', '/devices/self/settings', patch).finally(() => load(true));
}

export function addWorkspace(name, path) {
  return gatewayJson('POST', '/devices/self/workspaces', { name, path }).finally(() => load(true));
}

export function removeWorkspace(name) {
  return gatewayJson('DELETE', `/devices/self/workspaces/${encodeURIComponent(name)}`).finally(() => load(true));
}

/** 批准 / 拒绝一台等入网的新设备（本机要已入网） */
export function decidePendingDevice(deviceId, approve) {
  return gatewayJson('POST', `/devices/pending/${encodeURIComponent(deviceId)}`, { approve: !!approve }).finally(() => load(true));
}

/**
 * 游乐场列表：本机的智能体后面，接上我的其他设备上的（id 是 mine:<id>@<设备>）。
 * 同一个应用 / 专业智能体紧跟在本机那一项后面；本机没有的放到同类最后。
 */
export function withMeshAgents(localAgents, devices) {
  const list = [...(localAgents || [])];
  const others = (devices || []).filter((d) => !d.self);
  if (!others.length) return list;
  for (const d of others) {
    const label = deviceLabel(d);
    const device = { label, self: false, online: !!d.online, device_id: d.device_id };
    const add = (x, kind) => {
      const entry = {
        id: `mine:${x.id}@${label}`,
        name: x.name || x.id,
        type: kind === 'apps' ? 'cli' : kind === 'externals' ? 'external' : 'assistant',
        custom: kind === 'assistants' ? true : undefined,
        installed: true,
        mesh: { base: x.id, device },
        description: '',
      };
      if (list.some((a) => a.id === entry.id)) return;
      // 紧跟在同一个东西（本机那项或别的设备那项）后面
      let at = -1;
      list.forEach((a, i) => { if (a.id === x.id || a.mesh?.base === x.id) at = i; });
      if (at < 0) list.forEach((a, i) => { if (a.type === entry.type) at = i; });
      list.splice(at + 1, 0, entry);
    };
    for (const x of d.apps || []) add(x, 'apps');
    for (const x of d.assistants || []) add(x, 'assistants');
    for (const x of d.externals || []) add(x, 'externals');
  }
  return list;
}
