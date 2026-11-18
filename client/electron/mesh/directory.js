// client/electron/mesh/directory.js
// 设备目录：本机描述 + 各对端推来的描述。描述里只放名字和能力，不放路径和密钥。
'use strict';

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
    models: (d.models || []).map(String),
    workspaces: (d.workspaces || []).map((w) => ({ name: String(w.name), repo: w.repo ? String(w.repo) : null, default: !!w.default })),
    sessions: (d.sessions || []).slice(0, 20).map((s) => ({
      agent: String(s.agent || ''), id: String(s.id || ''), title: String(s.title || '').slice(0, 80),
      workspace: s.workspace ? String(s.workspace) : null, updated_at: Number(s.updated_at) || 0,
    })),
    accepts: { agent_tasks: d.accepts?.agent_tasks !== false, model_requests: !!d.accepts?.model_requests },
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

module.exports = { Directory, sanitizeDescriptor };
