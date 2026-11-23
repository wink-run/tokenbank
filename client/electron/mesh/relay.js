// client/electron/mesh/relay.js
// 中继：每个 app 的设备网络入口里都有一份，TokenBank 官方中继跑的也是这一份（relay-server.js）。
//
// 一条 WebSocket 连上来：
//   中继 → {type:'challenge', nonce, kind, device_id}
//   设备 → {type:'register', proto:1, cert, sig}      sig = 设备密钥签 `tb-mesh-register|<nonce>`
//   中继 → {type:'registered', kind, device_id, relay} | {type:'error', message}
// 之后：
//   设备 → {type:'relay', to, data}       中继按 to 转给同账号的那台：{type:'relay', from, data}
//                                         to 是中继所在的设备本身时，交给本机（这就是「直连」）
//   雇佣：{type:'relay', to, to_user, ticket, data}   跨账号只在官方中继上、只凭云端签的雇佣票：
//         票上写明雇佣方设备 → 出租方设备，到期前这两台之间双向放行；转过去的带 from_user
//   中继 → {type:'peers', devices}         同账号里连着这个中继的设备，有变化就推
//   中继 → {type:'peer_offline', to}       to 不在这个中继上
//   中继 → {type:'relay_status', ...}      正在转发哪些设备之间的连接（界面标「中继 · N」）
//   双向 {type:'ping'} / {type:'pong'}
// data 是两台设备之间端到端加密的内容，中继不解开。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const identity = require('./identity');
const keys = require('./keys');

const REGISTER_TIMEOUT_MS = 10000;
const MAX_FRAME = 16 * 1024 * 1024;
const STATUS_MS = 10000;
const PAIR_TTL_MS = 60000;

function sendJson(ws, obj) {
  if (ws.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

class RelayHub {
  /**
   * @param {{
   *   kind: 'device' | 'official',
   *   issuerKeys: () => Array<{kid, x}>,
   *   isRevoked?: (endpointId: string) => boolean,
   *   selfUserId?: string,            设备上的中继：只接本账号的设备
   *   self?: { deviceId, deliver(from, data, conn), onConnect(conn), onDisconnect(conn) },  设备上的中继：给本机的消息
   *   relayEnabled?: () => boolean,   设备上的中继：开了才替别人转
   *   maxPerUser?: number,
   *   dumpFile?: string,              测试用：把转发的 data 原样写下来，验证中继看不到明文
   *   log?: Function,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.conns = new Map();   // `${user}:${device}` → conn
    this.pairs = new Map();   // `${user}:${a}|${b}` → { user, a, b, at, bytes }
    this.grants = new Map();  // `${userA}:${devA}>${userB}:${devB}` → 到期时间（秒）：雇佣票放行的跨账号设备对
    this.timer = setInterval(() => this._status(), STATUS_MS);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.conns.values()) { try { c.ws.close(1001, 'relay shutdown'); } catch { /* 已断 */ } }
    this.conns.clear();
  }

  /** 接一条 WebSocket 连接（ws 库的 socket） */
  handle(ws, req) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const conn = { ws, user: null, deviceId: null, endpointId: null, name: '', remote: req?.socket?.remoteAddress || '' };
    const timeout = setTimeout(() => { if (!conn.deviceId) ws.close(4001, 'register timeout'); }, REGISTER_TIMEOUT_MS);
    timeout.unref?.();
    sendJson(ws, { type: 'challenge', nonce, kind: this.opts.kind, device_id: this.opts.self?.deviceId || null });
    ws.on('message', (raw, isBinary) => {
      if (isBinary || raw.length > MAX_FRAME) { ws.close(1009, 'frame too large'); return; }
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (!conn.deviceId) { this._register(conn, msg, nonce, timeout); return; }
      this._onMessage(conn, msg, raw.length);
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (!conn.deviceId) return;
      const key = `${conn.user}:${conn.deviceId}`;
      if (this.conns.get(key) === conn) {
        this.conns.delete(key);
        this.opts.self?.onDisconnect?.(conn);
        this._announce(conn.user);
      }
    });
    ws.on('error', () => {});
  }

  _register(conn, msg, nonce, timeout) {
    const fail = (message, code = 4003) => {
      this.log(`[mesh] 拒绝 ${conn.remote || '对方'} 接入中继：${message}`);
      sendJson(conn.ws, { type: 'error', message });
      conn.ws.close(code, message.slice(0, 100));
    };
    if (msg.type !== 'register') return fail('先注册');
    const v = identity.verifyCert(msg.cert, this.opts.issuerKeys());
    if (!v.ok) return fail(`证书无效：${v.reason}`);
    const c = v.claims;
    if (c.scope !== 'self') return fail('unknown_scope');
    if (this.opts.selfUserId && String(c.sub) !== String(this.opts.selfUserId)) return fail('other_user');
    if (this.opts.isRevoked?.(c.endpoint_id)) return fail('revoked');
    if (!keys.verify(c.endpoint_id, `tb-mesh-register|${nonce}`, msg.sig)) return fail('bad_signature');
    if (this.opts.maxPerUser) {
      const n = [...this.conns.values()].filter((x) => x.user === String(c.sub)).length;
      if (n >= this.opts.maxPerUser) return fail('too_many_devices', 4029);
    }
    clearTimeout(timeout);
    Object.assign(conn, { user: String(c.sub), deviceId: String(c.device_id), endpointId: c.endpoint_id, name: c.name || '', claims: c });
    const key = `${conn.user}:${conn.deviceId}`;
    const old = this.conns.get(key);
    if (old && old !== conn) { try { old.ws.close(4000, 'replaced'); } catch { /* 已断 */ } }
    this.conns.set(key, conn);
    sendJson(conn.ws, {
      type: 'registered', kind: this.opts.kind, device_id: this.opts.self?.deviceId || null,
      relay: this.opts.kind === 'official' || !!this.opts.relayEnabled?.(),
    });
    this.opts.self?.onConnect?.(conn);
    this._announce(conn.user);
  }

  _onMessage(conn, msg, size) {
    if (msg.type === 'ping') { sendJson(conn.ws, { type: 'pong', t: msg.t }); return; }
    if (msg.type !== 'relay') return;
    const to = String(msg.to || '');
    if (this.opts.self && to === this.opts.self.deviceId) {
      this.opts.self.deliver(conn.deviceId, msg.data, conn);
      return;
    }
    const toUser = msg.to_user ? String(msg.to_user) : conn.user;
    if (toUser !== conn.user) {
      // 跨账号：只有官方中继、只凭雇佣票
      const target = this.opts.kind === 'official' ? this.conns.get(`${toUser}:${to}`) : null;
      if (!target || !this._hireAllowed(conn, target, msg.ticket)) { sendJson(conn.ws, { type: 'peer_offline', to, to_user: toUser }); return; }
      if (this.opts.dumpFile) { try { fs.appendFileSync(this.opts.dumpFile, `${JSON.stringify(msg.data)}\n`); } catch { /* 测试用 */ } }
      sendJson(target.ws, { type: 'relay', from: conn.deviceId, from_user: conn.user, data: msg.data });
      return;
    }
    const canRelay = this.opts.kind === 'official' || this.opts.relayEnabled?.();
    const target = canRelay ? this.conns.get(`${conn.user}:${to}`) : null;
    if (!target) { sendJson(conn.ws, { type: 'peer_offline', to }); return; }
    if (this.opts.dumpFile) { try { fs.appendFileSync(this.opts.dumpFile, `${JSON.stringify(msg.data)}\n`); } catch { /* 测试用 */ } }
    sendJson(target.ws, { type: 'relay', from: conn.deviceId, data: msg.data });
    const [a, b] = [conn.deviceId, to].sort();
    const pk = `${conn.user}:${a}|${b}`;
    const p = this.pairs.get(pk) || { user: conn.user, a, b, bytes: 0 };
    p.at = Date.now();
    p.bytes += size;
    this.pairs.set(pk, p);
  }

  /** 跨账号这一对放不放行：已有没过期的放行，或者这条带的雇佣票正好写着这两台 */
  _hireAllowed(from, to, ticket) {
    const now = Math.floor(Date.now() / 1000);
    const key = (a, b) => `${a.user}:${a.deviceId}>${b.user}:${b.deviceId}`;
    const exp = this.grants.get(key(from, to));
    if (exp && exp > now) return true;
    if (!ticket) return false;
    const v = identity.verifyHireTicket(ticket, this.opts.issuerKeys(), now);
    if (!v.ok) return false;
    const c = v.claims;
    const ok = String(c.sub) === from.user && String(c.hd) === from.deviceId && String(c.he) === from.endpointId
      && String(c.wu) === to.user && String(c.wd) === to.deviceId && String(c.we) === to.endpointId
      && !this.opts.isRevoked?.(c.he) && !this.opts.isRevoked?.(c.we);
    if (!ok) return false;
    this.grants.set(key(from, to), c.exp);
    this.grants.set(key(to, from), c.exp);
    if (this.grants.size > 10000) for (const [k, e] of this.grants) if (e <= now) this.grants.delete(k);
    return true;
  }

  /** 本机（设备上的中继）发给连着它的某台设备 */
  sendTo(user, deviceId, data) {
    const c = this.conns.get(`${user}:${deviceId}`);
    return c ? sendJson(c.ws, { type: 'relay', from: this.opts.self?.deviceId, data }) : false;
  }

  connected(user) {
    return [...this.conns.values()].filter((c) => c.user === String(user)).map((c) => ({ device_id: c.deviceId, name: c.name }));
  }

  /** 同账号的设备列表变了：推给它们（设备上的中继把自己也算进去） */
  _announce(user) {
    const list = this.connected(user);
    if (this.opts.self) list.push({ device_id: this.opts.self.deviceId, name: this.opts.self.name || '', self: true });
    for (const c of this.conns.values()) {
      if (c.user !== user) continue;
      sendJson(c.ws, { type: 'peers', devices: list.filter((d) => d.device_id !== c.deviceId) });
    }
  }

  /** 最近一分钟在转发的设备对 */
  status(user) {
    const now = Date.now();
    const pairs = [];
    for (const [k, p] of this.pairs) {
      if (now - p.at > PAIR_TTL_MS) { this.pairs.delete(k); continue; }
      if (!user || p.user === String(user)) pairs.push({ a: p.a, b: p.b, bytes: p.bytes });
    }
    return { kind: this.opts.kind, relay_device: this.opts.self?.deviceId || null, pairs };
  }

  _status() {
    const users = new Set([...this.conns.values()].map((c) => c.user));
    for (const user of users) {
      const s = this.status(user);
      for (const c of this.conns.values()) if (c.user === user) sendJson(c.ws, { type: 'relay_status', ...s });
    }
  }
}

module.exports = { RelayHub };
