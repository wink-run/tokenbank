// client/electron/mesh/node.js
// 设备网络节点：每台设备一个。负责连上本账号的其他设备、交换证书和设备描述、
// 把对端开来的流交给隧道转到本机网关，并提供「把一次请求发到某台设备」的能力。
'use strict';

const crypto = require('crypto');
const http = require('http');
const EventEmitter = require('events');

const identity = require('./identity');
const { FrameStream } = require('./frames');
const tunnel = require('./tunnel');
const { Directory, sanitizeDescriptor } = require('./directory');

const DIAL_RETRY_MS = 5000;
const FALLBACK_DIAL_AFTER_MS = 8000;

function stableJson(d) {
  const { seq, ...rest } = d || {};
  return JSON.stringify(rest);
}

class MeshNode extends EventEmitter {
  /**
   * @param {{
   *   dir: string, userId: string|number, cert: string, issuerKeys: Array<{kid, x}>,
   *   peers?: Array<{ endpoint_id, relay_url?, direct_addrs?: string[] }>, revoked?: string[],
   *   relayUrls?: string[], relayToken?: string, bindAddr?: string,
   *   gatewayPort: number, describeSelf: () => Promise<object>, presenceMs?: number, log?: Function,
   *   transportFactory?: Function,
   * }} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.log = opts.log || ((m) => console.log(m));
    this.meshKey = `tbm_${crypto.randomBytes(24).toString('hex')}`;
    this.directory = new Directory();
    this.conns = new Map();         // device_id → { conn, endpointId, control, claims }
    this.byEndpoint = new Map();    // endpoint_id → device_id
    this.revoked = new Set(opts.revoked || []);
    this.seq = 0;
    this.lastSelf = '';
    this.timers = [];
    this.startedAt = Date.now();
    this.loopback = null;
    this.loopbackPort = 0;
    this.stopped = false;
  }

  get selfClaims() {
    const v = identity.verifyCert(this.opts.cert, this.opts.issuerKeys);
    return v.ok ? v.claims : null;
  }

  async start() {
    const claims = this.selfClaims;
    if (!claims) throw new Error('本机设备证书无效或已过期');
    this.deviceId = claims.device_id;
    this.deviceName = claims.name || claims.device_id;
    const secret = identity.loadOrCreateDeviceSecret(this.opts.dir);
    const { Transport } = require('./transport');
    const factory = this.opts.transportFactory || ((o) => Transport.create(o));
    this.transport = await factory({ secret, relayUrls: this.opts.relayUrls, relayToken: this.opts.relayToken, bindAddr: this.opts.bindAddr });
    if (this.transport.id() !== claims.endpoint_id) {
      throw new Error('本机设备证书不是签给这把设备密钥的');
    }
    await this.refreshSelf();
    this.stopAccept = this.transport.acceptLoop((conn) => this.onConnection(conn, false), (e) => this.log(`[mesh] 接入失败：${e.message}`));
    await this.startLoopback();
    this.scheduleDials();
    await this.startLanDiscovery();
    const tick = setInterval(() => this.tick().catch((e) => this.log(`[mesh] 刷新失败：${e.message}`)), this.opts.presenceMs || 5000);
    tick.unref?.();
    this.timers.push(tick);
    this.log(`[mesh] 已启动 device=${this.deviceName} endpoint=${this.transport.id().slice(0, 10)} 地址=${this.transport.addrInfo().direct_addrs.join(',')}`);
    return this;
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t), clearTimeout(t);
    this.stopAccept?.();
    this.lan?.stop();
    for (const c of this.conns.values()) c.conn.close('shutdown');
    this.conns.clear();
    if (this.loopback) await new Promise((r) => this.loopback.close(() => r()));
    await this.transport?.close();
  }

  addrInfo() { return this.transport.addrInfo(); }

  /** 换上新吊销列表（endpoint_id / device_id）：已连着的被吊销设备马上断开 */
  setRevoked(ids = []) {
    this.revoked = new Set((ids || []).map(String).filter(Boolean));
    for (const [deviceId, c] of [...this.conns]) {
      if (this.revoked.has(c.endpointId) || this.revoked.has(String(deviceId))) {
        this.log(`[mesh] ${c.claims?.name || deviceId} 已被吊销，断开`);
        try { c.conn.close('revoked'); } catch { /* 已断 */ }
        this.conns.delete(deviceId);
        this.byEndpoint.delete(c.endpointId);
        this.directory.markOffline(deviceId);
      }
    }
  }

  /** 证书续期：之后的握手用新证书；已连着的不受影响 */
  updateCert(cert, issuerKeys) {
    this.opts.cert = cert;
    if (Array.isArray(issuerKeys) && issuerKeys.length) this.opts.issuerKeys = issuerKeys;
  }

  /** 只有隧道转进来的请求才带这把 Key；外部调用方拿不到 */
  isMeshKey(key) {
    const k = String(key || '');
    return k.length === this.meshKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(this.meshKey));
  }

  isMeshRequest(headers = {}) {
    const auth = String(headers.authorization || '');
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    return !!headers['x-tb-mesh-from'] && this.isMeshKey(key);
  }

  // ── 本机描述 ───────────────────────────────────────────────────────────────

  async refreshSelf() {
    const raw = await this.opts.describeSelf();
    const draft = sanitizeDescriptor({ ...raw, device_id: this.deviceId, name: this.deviceName, seq: this.seq });
    if (stableJson(draft) !== this.lastSelf) {
      this.seq += 1;
      this.lastSelf = stableJson(draft);
      draft.seq = this.seq;
      this.directory.setSelf(draft);
      return true;
    }
    return false;
  }

  async tick() {
    if (this.stopped) return;
    const changed = await this.refreshSelf();
    for (const [deviceId, c] of this.conns) {
      this.directory.setPath(deviceId, c.conn.pathInfo());
      if (changed) c.control.writeJson({ t: 'presence', descriptor: this.directory.self }).catch(() => {});
    }
  }

  // ── 连接 ───────────────────────────────────────────────────────────────────

  scheduleDials() {
    this.knownPeers = new Map();   // endpoint_id → { endpoint_id, relay_url, direct_addrs, source, firstSeen }
    for (const peer of this.opts.peers || []) this.ensurePeer(peer, 'config');
  }

  /**
   * 记下一个对端地址（来自配置、云端地址簿或局域网发现），没在拨的话开始拨。
   * 同一台设备的地址会合并，已经连上的不会重复拨。
   */
  ensurePeer(peer, source = 'config') {
    if (!peer || !peer.endpoint_id || peer.endpoint_id === this.transport.id() || this.stopped) return;
    const known = this.knownPeers.get(peer.endpoint_id);
    if (known) {
      const addrs = new Set([...(known.direct_addrs || []), ...(peer.direct_addrs || [])]);
      known.direct_addrs = [...addrs];
      if (peer.relay_url) known.relay_url = peer.relay_url;
      return;
    }
    const entry = { endpoint_id: peer.endpoint_id, relay_url: peer.relay_url || null, direct_addrs: [...(peer.direct_addrs || [])], source, firstSeen: Date.now() };
    this.knownPeers.set(peer.endpoint_id, entry);
    if (source === 'lan') this.log(`[mesh] 局域网发现 ${peer.name || peer.endpoint_id.slice(0, 10)}（${entry.direct_addrs.join(',')}）`);
    const attempt = async () => {
      if (this.stopped) return;
      const connected = this.byEndpoint.has(entry.endpoint_id) && this.conns.has(this.byEndpoint.get(entry.endpoint_id));
      // 两边同时拨会建两条连接：约定 id 小的一方拨；对方迟迟不来时再自己拨
      const mine = this.transport.id() < entry.endpoint_id || Date.now() - entry.firstSeen > FALLBACK_DIAL_AFTER_MS;
      if (!connected && mine) {
        try {
          const conn = await this.transport.dial(entry);
          await this.onConnection(conn, true);
        } catch (e) {
          this.log(`[mesh] 连不上 ${entry.endpoint_id.slice(0, 10)}：${e.message}`);
        }
      }
      const t = setTimeout(attempt, DIAL_RETRY_MS);
      t.unref?.();
      this.timers.push(t);
    };
    attempt();
  }

  async startLanDiscovery() {
    if (this.opts.lanDiscovery === false) return;
    const { LanDiscovery } = require('./lan-discovery');
    this.lan = new LanDiscovery({
      endpointId: this.transport.id(),
      irohPort: this.transport.boundPort(),
      cert: this.opts.cert,
      selfUserId: this.opts.userId,
      issuerKeys: this.opts.issuerKeys,
      revoked: this.revoked,
      port: this.opts.lanPort,
      onPeer: (peer) => this.ensurePeer(peer, 'lan'),
      log: this.log,
    });
    try { await this.lan.start(); } catch (e) { this.log(`[mesh] 局域网发现没有启动：${e.message}`); this.lan = null; }
  }

  async onConnection(conn, dialer) {
    const remote = conn.remoteId();
    const hello = { t: 'hello', cert: this.opts.cert, descriptor: this.directory.self };
    let control;
    let peerHello;
    try {
      if (dialer) {
        control = new FrameStream(await conn.openStream());
        await control.writeJson(hello);
        peerHello = await control.nextJson();
      } else {
        control = new FrameStream(await conn.acceptStream());
        peerHello = await control.nextJson();
      }
    } catch (e) {
      this.log(`[mesh] 握手失败 ${remote.slice(0, 10)}：${e.message}`);
      conn.close('handshake');
      return;
    }
    if (!peerHello || peerHello.t !== 'hello') {
      if (peerHello && peerHello.t === 'reject') this.log(`[mesh] 被 ${remote.slice(0, 10)} 拒绝：${peerHello.reason}`);
      conn.close('handshake');
      return;
    }
    const check = identity.checkPeer(peerHello.cert, {
      issuerKeys: this.opts.issuerKeys, remoteEndpointId: remote, selfUserId: this.opts.userId, revoked: this.revoked,
    });
    if (!check.ok) {
      this.log(`[mesh] 拒绝 ${remote.slice(0, 10)}：${check.reason}`);
      // 只回一个原因码，不带本机任何信息
      try { await control.writeJson({ t: 'reject', reason: check.reason }); await control.finish(); } catch { /* 对方已断 */ }
      setTimeout(() => conn.close('rejected'), 200);
      this.emit('rejected', { endpoint_id: remote, reason: check.reason });
      return;
    }
    if (!dialer) await control.writeJson(hello);
    const deviceId = check.claims.device_id;
    if (this.conns.has(deviceId)) { conn.close('duplicate'); return; }
    this.conns.set(deviceId, { conn, endpointId: remote, control, claims: check.claims });
    this.byEndpoint.set(remote, deviceId);
    if (peerHello.descriptor) this.directory.applyPresence({ endpoint_id: remote }, peerHello.descriptor);
    this.directory.setPath(deviceId, conn.pathInfo());
    this.log(`[mesh] 已连上 ${check.claims.name || deviceId}（${conn.pathInfo().kind}）`);
    this.emit('peer', { device_id: deviceId, name: check.claims.name });

    // 控制流：对方推来的描述更新
    (async () => {
      try {
        for (;;) {
          const msg = await control.nextJson();
          if (!msg) break;
          if (msg.t === 'presence' && msg.descriptor && String(msg.descriptor.device_id) === String(deviceId)) {
            this.directory.applyPresence({ endpoint_id: remote }, msg.descriptor);
          }
        }
      } catch { /* 断线由下面处理 */ }
    })();

    // 对方开来的其他流都是隧道请求
    (async () => {
      for (;;) {
        let io;
        try { io = await conn.acceptStream(); } catch { break; }
        tunnel.serve(io, { gatewayPort: this.opts.gatewayPort, meshKey: this.meshKey, fromDeviceId: deviceId, log: this.log })
          .catch((e) => this.log(`[mesh] 隧道请求出错：${e.message}`));
      }
    })();

    conn.closed().catch(() => {}).finally(() => {
      const cur = this.conns.get(deviceId);
      if (cur && cur.conn === conn) {
        this.conns.delete(deviceId);
        this.byEndpoint.delete(remote);
        this.directory.markOffline(deviceId);
        this.log(`[mesh] ${check.claims.name || deviceId} 断开`);
        this.emit('peer-offline', { device_id: deviceId });
      }
    });
  }

  // ── 把请求发到某台设备 ─────────────────────────────────────────────────────

  async proxy(deviceId, req) {
    const c = this.conns.get(deviceId);
    if (!c) {
      const err = new Error('那台设备不在线');
      err.status = 503;
      throw err;
    }
    const io = await c.conn.openStream();
    return tunnel.request(io, req);
  }

  /** 回环代理：http://127.0.0.1:<port>/peer/<device_id>/<原路径>，方便 curl 和以后的 mesh 虚拟供给源 */
  async startLoopback() {
    this.loopback = http.createServer(async (req, res) => {
      const m = String(req.url || '').match(/^\/peer\/([^/]+)(\/.*)$/);
      if (!m) { res.writeHead(404); res.end(); return; }
      const deviceId = decodeURIComponent(m[1]);
      const parts = [];
      req.on('data', (c) => parts.push(c));
      req.on('end', async () => {
        try {
          const headers = { ...req.headers };
          delete headers.host;
          const resp = await this.proxy(deviceId, { method: req.method, path: m[2], headers, body: Buffer.concat(parts) });
          await tunnel.pipeTo(resp, res);
        } catch (e) {
          if (!res.headersSent) res.writeHead(e.status || 502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message, type: 'mesh_error' } }));
        }
      });
    });
    await new Promise((r) => this.loopback.listen(0, '127.0.0.1', r));
    this.loopbackPort = this.loopback.address().port;
  }
}

module.exports = { MeshNode };
