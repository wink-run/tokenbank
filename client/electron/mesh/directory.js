// client/electron/mesh/directory.js
// 设备目录：本机描述 + 各对端推来的描述。描述里只放名字和能力，不放路径和密钥。
'use strict';

// 设备别名：派活时用（mine:codex@studio、/codex@studio）。不能有空格、@、/，不能叫「本机」
const RESERVED_ALIASES = new Set(['本机', 'local', 'self', 'localhost']);
function normalizeAliases(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const a = String(raw || '').trim();
    if (!a) continue;
    if (a.length > 32 || /[\s@/\\]/.test(a) || RESERVED_ALIASES.has(a.toLowerCase())) {
      const err = new Error(`别名「${a}」不能用：最多 32 个字，不能有空格、@、/，也不能叫「本机」`);
      err.status = 400;
      throw err;
    }
    if (!out.some((x) => x.toLowerCase() === a.toLowerCase())) out.push(a);
  }
  return out.slice(0, 5);
}

/** 界面上显示的设备名：有别名用第一个别名，否则用设备名 */
function deviceLabel(d) {
  const aliases = (d && (d.descriptor?.aliases || d.aliases)) || [];
  return aliases[0] || (d && d.name) || (d && d.device_id) || '';
}

// 描述里出现这种字符串就当成泄露了本机路径
const PATH_LIKE = /(^|[\s"'])(\/(Users|home|root|var|tmp|private)\/|[A-Za-z]:\\|~\/)/;

/** 本机描述在发出去之前过一遍：去掉不该出现的字段，发现像路径的值直接抛错（开发期尽早暴露） */
function sanitizeDescriptor(d) {
  const out = {
    device_id: String(d.device_id || ''),
    name: String(d.name || ''),
    platform: String(d.platform || ''),
    version: String(d.version || ''),
    seq: Number(d.seq) || 0,
    load: { running: Number(d.load?.running) || 0, max: Number(d.load?.max) || 0 },
    apps: (d.apps || []).map((a) => ({ id: String(a.id), name: String(a.name || a.id) })),
    assistants: (d.assistants || []).map((a) => ({ id: String(a.id), name: String(a.name || a.id) })),
    externals: (d.externals || []).slice(0, 50).map((a) => ({ id: String(a.id), name: String(a.name || a.id) })),
    models: (d.models || []).map(String),
    providers: (d.providers || []).slice(0, 50).map((p) => ({
      id: String(p.id || ''), name: String(p.name || ''), type: String(p.type || ''), models: Number(p.models) || 0,
    })),
    workspaces: (d.workspaces || []).map((w) => ({ name: String(w.name), repo: w.repo ? String(w.repo) : null, default: !!w.default })),
    sessions: (d.sessions || []).slice(0, 20).map((s) => ({
      agent: String(s.agent || ''), id: String(s.id || ''), title: String(s.title || '').slice(0, 80),
      workspace: s.workspace ? String(s.workspace) : null, updated_at: Number(s.updated_at) || 0,
    })),
    accepts: { agent_tasks: d.accepts?.agent_tasks !== false, model_requests: !!d.accepts?.model_requests },
    aliases: (() => { try { return normalizeAliases(d.aliases); } catch { return []; } })(),
  };
  const text = JSON.stringify(out);
  if (PATH_LIKE.test(text)) throw new Error('设备描述里出现了本机路径');
  return out;
}

class Directory {
  constructor() {
    this.self = null;
    this.peers = new Map();   // device_id → { device_id, name, online, descriptor, path, lastSeen, endpoint_id }
  }

  setSelf(descriptor) { this.self = descriptor; }

  /** 收到对端的描述。seq 不比已有的新就丢弃（乱序到达的旧消息） */
  applyPresence(info, descriptor, now = Date.now()) {
    const id = String(descriptor.device_id || info.device_id || '');
    if (!id) return false;
    const prev = this.peers.get(id);
    if (prev && prev.descriptor && Number(descriptor.seq) <= Number(prev.descriptor.seq) && prev.online) return false;
    this.peers.set(id, {
      ...(prev || {}),
      device_id: id,
      name: descriptor.name || prev?.name || id,
      endpoint_id: info.endpoint_id || prev?.endpoint_id,
      online: true,
      descriptor,
      lastSeen: now,
    });
    return true;
  }

  setPath(deviceId, pathInfo) {
    const p = this.peers.get(deviceId);
    if (p) p.path = pathInfo;
  }

  /** 断线：标离线，保留最后一次描述，界面显示「多久前在线」 */
  markOffline(deviceId, now = Date.now()) {
    const p = this.peers.get(deviceId);
    if (p) { p.online = false; p.lastSeen = now; }
  }

  get(deviceId) { return this.peers.get(deviceId) || null; }

  /** 给调度和 /v1/devices 用：本机在前 */
  list() {
    const out = [];
    if (this.self) {
      out.push({ device_id: this.self.device_id, name: this.self.name, self: true, online: true, descriptor: this.self, path: { kind: 'self', rttMs: 0 } });
    }
    for (const p of this.peers.values()) out.push({ ...p, self: false });
    return out;
  }
}

module.exports = { Directory, sanitizeDescriptor, normalizeAliases, deviceLabel };
