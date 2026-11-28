// client/electron/mesh/node.js
// 设备网络节点：每台设备一个。
//
// 设备之间只有一种通道：WebSocket。
//   · 本机开一个入口 ws://<本机>:<端口>/mesh/ws（relay.js 的 RelayHub）：别的设备直连进来，开了中继时也替它们转发。
//   · 本机连出去：能直接连到对方就直连；连不到就经「我的中继」（我名下的某台设备，或官方中继），消息写上 to。
//   · 两台设备之间端到端加密（keys.js），中继只看到密文。
// 一个账号同一时间用同一个中继：手动指定的以最近一次为准，自动时大家挑同一台，都没有就用官方中继。
// 另外每台都尝试挂一条到官方中继的空闲连接当「碰头点」：哪怕两台一时选的中继不一样（比如一台还没登录），也总能互相找到。
// 这条连不上不影响服务：已经有自己的中继时，数据照旧先直连、再经那台设备，都不通才经官方中继。
// 上层只用 proxy(device, httpRequest)：把一次 HTTP 请求交给那台设备的本机网关，接口和以前一样。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const EventEmitter = require('events');
const WebSocket = require('ws');

const identity = require('./identity');
const keys = require('./keys');
const tunnel = require('./tunnel');
const { Directory, sanitizeDescriptor, deviceLabel } = require('./directory');
const { RelayHub } = require('./relay');
const { HireChannel } = require('./hire');

const DEFAULT_PORT = 41750;

/** 直连失败的原因，换成用户看得懂的话 */
function friendlyDialError(e) {
  const code = String(e?.code || e?.cause?.code || '');
  const msg = String(e?.message || e || '');
  if (code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return '对方没在这个地址等连接（设备网络没开，或端口变了）';
  if (/ETIMEDOUT|timeout|超时/i.test(code + msg)) return '超时：不在同一个网络，或被防火墙挡住了';
  if (/EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL/.test(code + msg)) return '网络不通：这个地址从这里到不了';
  if (/ENOTFOUND|EAI_AGAIN/.test(code + msg)) return '地址解析不出来';
  if (/cert|证书|unauthor|401|403|revoked|expired/i.test(msg)) return `对方不认这台的证书（${msg.slice(0, 60)}）`;
  if (/不是另一台设备/.test(msg)) return '这个地址连到的是本机自己';
  return msg.slice(0, 80) || '连不上';
}
const WS_PATH = '/mesh/ws';
const DIAL_RETRY_MS = 10000;
const FALLBACK_DIAL_AFTER_MS = 8000;
const CONNECT_TIMEOUT_MS = 4000;
const HANDSHAKE_TIMEOUT_MS = 8000;
const HEAD_TIMEOUT_MS = 120000;
const RELAY_CHECK_MS = 15000;
const PING_MS = 15000;
const HIGH_WATER = 4 * 1024 * 1024;

function stableJson(d) {
  const { seq, ...rest } = d || {};
  return JSON.stringify(rest);
}

function rid() { return crypto.randomBytes(8).toString('hex'); }

/** host:port → ws URL（IPv6 要方括号） */
function wsUrl(addr) {
  const a = String(addr || '');
  if (/^wss?:\/\//.test(a)) return a;
  return `ws://${a}${WS_PATH}`;
}

/** Docker 网桥地址（172.16.0.0/12）出了容器就没人连得上，不能写进地址簿 */
function dockerBridge(ip) {
  return /^172\.(1[6-9]|2\d|3[01])\./.test(String(ip || ''));
}

function inDocker() {
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
}

/** 本机网卡上的地址（局域网、Tailscale、全局 IPv6），给别的设备直连用 */
function localAddrs(port) {
  const docker = inDocker();
  const out = [];
  for (const list of Object.values(os.networkInterfaces() || {})) {
    for (const a of list || []) {
      if (a.internal) continue;
      if ((a.family === 'IPv4' || a.family === 4) && docker && dockerBridge(a.address)) continue;
      if (a.family === 'IPv4' || a.family === 4) out.push(`${a.address}:${port}`);
      else if ((a.family === 'IPv6' || a.family === 6) && !/^fe80:/i.test(a.address)) out.push(`[${a.address}]:${port}`);
    }
  }
  return out;
}

/** 地址的类别，给界面标连接方式 */
function addrKind(addr) {
  const host = String(addr || '').replace(/^wss?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'tailscale';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(host) || /^(fc|fd)/i.test(host) || host === '::1') return 'lan';
  if (host.includes(':')) return 'ipv6';
  return 'public';
}

// ── 连出去的一条 WebSocket ──────────────────────────────────────────────────

class Link {
  constructor(node, addr) {
    this.node = node;
    this.addr = addr;
    this.url = wsUrl(addr);
    this.ws = null;
    this.info = null;        // registered：{ kind, device_id, relay }
    this.peers = new Set();  // 经这条连接能到的设备（中继推来的 peers）
    this.rttMs = null;
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: CONNECT_TIMEOUT_MS, maxPayload: 16 * 1024 * 1024 });
      this.ws = ws;
      let settled = false;
      const done = (err, v) => { if (settled) return; settled = true; clearTimeout(t); err ? reject(err) : resolve(v); };
      const t = setTimeout(() => { done(new Error('连接超时')); try { ws.terminate(); } catch { /* 已断 */ } }, CONNECT_TIMEOUT_MS + 2000);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
        if (msg.type === 'challenge') {
          ws.send(JSON.stringify({ type: 'register', proto: 1, cert: this.node.opts.cert, sig: keys.sign(this.node.key.privateKey, `tb-mesh-register|${msg.nonce}`) }));
          return;
        }
        if (msg.type === 'registered') { this.info = msg; done(null, msg); return; }
        if (msg.type === 'error') { done(new Error(msg.message || '被拒绝')); return; }
        this.node._onLinkMessage(this, msg);
      });
      ws.on('close', () => { done(new Error('连接断开')); this.closed = true; this.node._onLinkClose(this); });
      ws.on('error', (e) => done(e));
    });
  }

  send(to, data, extra) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'relay', to, data, ...(extra || {}) }));
    return true;
  }

  ping() { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); }
  get buffered() { return this.ws ? this.ws.bufferedAmount : 0; }
  close() { this.closed = true; try { this.ws?.close(1000, 'bye'); } catch { /* 已断 */ } }
}

// ── 节点 ────────────────────────────────────────────────────────────────────

class MeshNode extends EventEmitter {
  /**
   * @param {{
   *   dir: string, userId: string|number, cert: string, issuerKeys: Array<{kid, x}>,
   *   peers?: Array<{ endpoint_id?, direct_addrs?: string[] }>, revoked?: string[],
   *   relayUrls?: string[],           官方中继（wss://…/mesh/ws）
   *   listen?: string|false,          入口监听的地址，默认 '::'（IPv4 和 IPv6）；false 表示不开入口、也不直连（只走中继）
   *   port?: number,                  入口端口，默认 41750
   *   publicAddr?: string,            手动填的公网地址 host:port
   *   relay?: { mode?: 'auto'|'on'|'off', pref?: 'auto'|'official'|string, prefAt?: number },
   *   gatewayPort: number, describeSelf: () => Promise<object>, presenceMs?: number,
   *   lanDiscovery?: boolean, lanPort?: number, relayDumpFile?: string, log?: Function,
   * }} opts
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.log = opts.log || ((m) => console.log(m));
    this.meshKey = `tbm_${crypto.randomBytes(24).toString('hex')}`;
    this.directory = new Directory();
    this.revoked = new Set(opts.revoked || []);
    this.sessions = new Map();     // device_id → 会话
    this.links = new Map();        // device_id → 连出去的 Link（直连，也可能同时是中继）
    this.inbound = new Map();      // device_id → 连进来的连接（RelayHub 的 conn）
    this.uplink = null;            // 经我的哪台设备中继（Link）；用官方中继时为空
    this.uplinkTarget = null;      // 'official' | device_id | 'self'
    this.official = null;          // 到官方中继的连接：一直挂着，当碰头点和最后的通路
    this.pending = new Map();      // req_id → 等对端响应
    this.serving = new Map();      // `${from}:${req_id}` → 本机正在处理
    this.knownPeers = new Map();   // 直连候选地址
    this.verifiedAddrs = [];       // 云端回拨验证过的本机地址
    this.relayStatus = null;       // 中继推来的状态
    this.seq = 0;
    this.lastSelf = '';
    this.timers = [];
    this.stopped = false;
    this.hire = new HireChannel(this);   // 雇佣：同一条通道，凭云端签的雇佣票跨账号
  }

  get selfClaims() {
    const v = identity.verifyCert(this.opts.cert, this.opts.issuerKeys);
    return v.ok ? v.claims : null;
  }

  get port() {
    if (this.server) {
      const a = this.server.address();
      if (a && typeof a === 'object') return a.port;
    }
    return this.sharedPort || 0;
  }

  async start() {
    const claims = this.selfClaims;
    if (!claims) throw new Error('本机设备证书无效或已过期');
    this.deviceId = String(claims.device_id);
    this.deviceName = claims.name || claims.device_id;
    this.key = keys.deviceKey(identity.loadOrCreateDeviceSecret(this.opts.dir));
    if (this.key.endpointId !== claims.endpoint_id) throw new Error('本机设备证书不是签给这把设备密钥的');
    this.hub = new RelayHub({
      kind: 'device',
      issuerKeys: () => this.opts.issuerKeys,
      isRevoked: (id) => this.revoked.has(id),
      selfUserId: String(this.opts.userId),
      relayEnabled: () => this.relayActive(),
      dumpFile: this.opts.relayDumpFile,
      log: this.log,
      self: {
        deviceId: this.deviceId,
        name: this.deviceName,
        deliver: (from, data) => this._onEnvelope(from, data),
        onConnect: (conn) => this._onInbound(conn),
        onDisconnect: (conn) => this._onInboundClose(conn),
      },
    });
    if (this.opts.listen !== false) {
      try {
        await this._listen();
      } catch (e) {
        // 入口绑不上（Docker 没开 IPv6、端口被占）不能把整网停掉，改成只走中继
        this.log(`[mesh] 入口开不了（${e.message}），改为只走中继`);
        try { this.server?.close(); } catch { /* 没听上 */ }
        this.server = null;
        this.wss = null;
        this.opts.listen = false;
      }
    }
    await this.refreshSelf();
    for (const p of this.opts.peers || []) this.ensurePeer(p, 'config');
    if (this.opts.listen !== false && this.opts.lanDiscovery !== false) {
      try {
        await this._startLanDiscovery();
      } catch (e) {
        this.log(`[mesh] 局域网发现没开起来：${e.message}`);
        try { this.lan?.stop(); } catch { /* 没开起来 */ }
        this.lan = null;
      }
    }
    const every = (ms, fn) => { const t = setInterval(() => { Promise.resolve(fn()).catch((e) => this.log(`[mesh] ${e.message}`)); }, ms); t.unref?.(); this.timers.push(t); };
    every(this.opts.presenceMs || 5000, () => this.tick());
    every(RELAY_CHECK_MS, () => this._evaluateRelay());
    every(PING_MS, () => this._pingAll());
    await this._evaluateRelay();
    this.log(`[mesh] 已启动 device=${this.deviceName} endpoint=${this.key.endpointId.slice(0, 10)} 入口=${this.opts.listen === false ? '关' : localAddrs(this.port).join(',')}`);
    return this;
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.lan?.stop();
    for (const l of this.links.values()) l.close();
    this.uplink?.close();
    this.official?.close();
    this.hub?.close();
    for (const p of this.pending.values()) p.fail(new Error('设备网络已停止'));
    if (this.wss) { try { this.wss.close(); } catch { /* 已经关了 */ } }
    // 挂在网关端口上时，这个 server 是网关的，不能关
    if (this.server && !this.opts.shareHttp) {
      await new Promise((r) => this.server.close(() => r()));
    }
  }

  /** 云端回拨、局域网探活：这个地址后面确实是这台设备 */
  _pong(req, res) {
    const path = String(req.url || '').split('?')[0];
    if (req.method !== 'GET' || path !== '/mesh/ping') return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ endpoint_id: this.key.endpointId, device_id: this.deviceId }));
    return true;
  }

  /** 容器把探活挂在网关已有端口上 */
  handleHttp(req, res) {
    if (!this.opts.shareHttp || this.stopped) return false;
    return this._pong(req, res);
  }

  /** 容器把 /mesh/ws 挂在网关已有端口上。接住了返回 true */
  handleUpgrade(req, socket, head) {
    if (!this.opts.shareHttp || !this.wss || this.stopped) return false;
    if (String(req.url || '').split('?')[0] !== WS_PATH) return false;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.hub.handle(ws, req));
    return true;
  }

  async _listen() {
    this.wss = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024 * 1024 });
    // 容器：不另开端口，探活和 WebSocket 由网关转过来
    if (this.opts.shareHttp) {
      this.sharedPort = this.opts.port;
      this.log(`[mesh] 入口挂在网关端口 ${this.sharedPort}，不再另开端口`);
      return;
    }
    this.server = http.createServer((req, res) => {
      if (this._pong(req, res)) return;
      res.writeHead(404); res.end();
    });
    this.server.on('upgrade', (req, socket, head) => {
      if (String(req.url || '').split('?')[0] !== WS_PATH) { socket.destroy(); return; }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.hub.handle(ws, req));
    });
    const host = this.opts.listen || '::';
    const listenOn = (h) => new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen({ host: h, port: this.opts.port ?? DEFAULT_PORT, ipv6Only: false }, () => { this.server.removeListener('error', reject); resolve(); });
    });
    try {
      await listenOn(host);
    } catch (e) {
      // 系统没开 IPv6：退回只听 IPv4
      if (host !== '::' || !['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(e.code)) throw e;
      await listenOn('0.0.0.0');
    }
  }

  /** 发给别的设备、写进地址簿的地址（host:port） */
  addrInfo() {
    if (this.opts.listen === false) return { endpoint_id: this.key.endpointId, relay_url: this.official?.url || null, direct_addrs: [] };
    const addrs = new Set(localAddrs(this.port));
    if (this.opts.publicAddr) addrs.add(this.opts.publicAddr);
    if (this.observedIp) addrs.add(this.observedIp.includes(':') ? `[${this.observedIp}]:${this.port}` : `${this.observedIp}:${this.port}`);
    return { endpoint_id: this.key.endpointId, relay_url: this.official?.url || null, direct_addrs: [...addrs] };
  }

  /** 云端回拨验证的结果：哪些地址从外面真的连得到 */
  setVerified(addrs = [], observedIp = '') {
    this.verifiedAddrs = (addrs || []).map(String);
    if (observedIp) this.observedIp = String(observedIp);
  }

  // ── 中继：本机能不能当、用哪个 ──────────────────────────────────────────────

  get cloudMode() { return !!this.opts.cloud; }

  /** 本机现在替别人转发吗 */
  relayActive() {
    const mode = this.opts.relay?.mode || 'auto';
    if (mode === 'off' || this.opts.listen === false) return false;
    if (mode === 'on') return true;
    // 自动：登录时要云端验证过能被连到；只在局域网里用时，开着入口就行
    return this.cloudMode ? this.verifiedAddrs.length > 0 : true;
  }

  _relayAddrs() {
    if (!this.relayActive()) return [];
    return this.cloudMode && this.verifiedAddrs.length ? this.verifiedAddrs : this.addrInfo().direct_addrs;
  }

  /** 手动指定的中继：本机和其他设备里最近一次的为准，大家用同一个 */
  _relayPref() {
    let best = { value: this.opts.relay?.pref || 'auto', at: Number(this.opts.relay?.prefAt) || 0 };
    for (const d of this.directory.list()) {
      if (d.self || !d.online) continue;
      const p = d.descriptor?.relay?.pref;
      if (p && Number(p.at) > best.at) best = { value: String(p.value), at: Number(p.at) };
    }
    return best;
  }

  /** 选中继：手动的那台；自动时在能当中继的设备里挑 device_id 最小的（大家算出来是同一台）；都没有用官方中继 */
  _pickRelay() {
    const cands = [];
    if (this.relayActive()) cands.push({ device_id: this.deviceId, self: true, addrs: [] });
    for (const d of this.directory.list()) {
      if (d.self || !d.online) continue;
      const r = d.descriptor?.relay;
      if (r?.enabled && Array.isArray(r.addrs) && r.addrs.length) cands.push({ device_id: d.device_id, addrs: r.addrs, verified: !!r.verified });
    }
    const pref = this._relayPref();
    if (pref.value === 'official') return { target: 'official', pref };
    if (pref.value && pref.value !== 'auto') {
      const hit = cands.find((c) => c.device_id === pref.value);
      return hit ? { target: hit.self ? 'self' : hit.device_id, addrs: hit.addrs, pref } : { target: 'official', pref, unavailable: pref.value };
    }
    const pool = this.cloudMode ? cands.filter((c) => c.self || c.verified) : cands;
    pool.sort((a, b) => (a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0));
    const hit = pool[0];
    if (!hit) return { target: 'official', pref };
    return { target: hit.self ? 'self' : hit.device_id, addrs: hit.addrs, pref };
  }

  async _evaluateRelay() {
    if (this.stopped) return;
    const pick = this._pickRelay();
    this.relayPick = pick;
    // 选的是自己的中继：先接上它。官方中继只在后台补连，超时或失败不挡这条路
    if (pick.target === 'official') await this._ensureOfficial();
    else this._ensureOfficial().catch(() => {});
    if (pick.target === 'self' || pick.target === 'official') {
      // 本机就是中继（别的设备连进来），或者用官方中继：都不需要再经我的设备
      this._dropUplink();
      this.uplinkTarget = pick.target === 'self' || this.official ? pick.target : null;
      return;
    }
    if (this.uplink && !this.uplink.closed && this.uplinkTarget === pick.target) return;
    // 已经直连着那台：直接把这条当中继用（同一台设备上不能有两条连接）
    const existing = this.links.get(pick.target);
    if (existing && !existing.closed) { this._setUplink(existing, pick.target); return; }
    for (const addr of pick.addrs || []) {
      const link = await this._dial(addr).catch(() => null);
      if (link && link.info?.device_id === pick.target) { this._setUplink(link, pick.target); return; }
      if (link && !this.links.has(link.info?.device_id)) link.close();
    }
    this._dropUplink();
    if (this.official && !this.official.closed) {
      this.log(`[mesh] 连不上中继 ${this._label(pick.target)}，改用官方中继`);
      this.uplinkTarget = 'official';
      return;
    }
    // 官方中继也没连上：留空，下一轮再试自己的中继，不把服务停在官方中继上
    this.log(`[mesh] 连不上中继 ${this._label(pick.target)}，过一会儿再试`);
    this.uplinkTarget = null;
  }

  /** 不再经我的设备中继；那条连接要是同时是直连就留着 */
  _dropUplink() {
    const old = this.uplink;
    this.uplink = null;
    this.relayStatus = null;
    if (old) {
      old.isUplink = false;
      if (![...this.links.values()].includes(old)) old.close();
    }
  }

  /** 到官方中继的连接：没有就连上 */
  async _ensureOfficial() {
    if (this.official && !this.official.closed) return;
    if (this._officialBusy) return;
    this._officialBusy = true;
    try {
      for (const url of this.opts.relayUrls || []) {
        const link = new Link(this, url);
        try {
          await link.open();
          link.isOfficial = true;
          this.official = link;
          for (const id of link.peers) this._greet(id);
          return;
        } catch (e) {
          // 有自己的中继时，官方中继只是碰头点，连不上不重复报成故障
          const now = Date.now();
          if (this._officialFailLogAt && now - this._officialFailLogAt < 60000) continue;
          this._officialFailLogAt = now;
          const own = this._pickRelay().target !== 'official';
          this.log(own
            ? `[mesh] 官方中继连不上（${e.message}）。本账号已有中继，设备之间照常走`
            : `[mesh] 官方中继连不上：${e.message}`);
        }
      }
    } finally { this._officialBusy = false; }
  }

  _setUplink(link, target) {
    if (this.uplink !== link) this._dropUplink();
    this.uplink = link;
    this.uplinkTarget = target;
    link.isUplink = true;
    this.log(`[mesh] 中继：${this._label(target)}`);
    // 经这个中继能到的设备：握手、交换描述
    for (const id of link.peers) this._greet(id);
  }

  _label(id) {
    const d = this.directory.get(id);
    return d ? deviceLabel(d) : id;
  }

  // ── 直连 ───────────────────────────────────────────────────────────────────

  /** 记下一个直连候选（配置、云端地址簿、局域网发现、对方描述里的地址），没连着就去连 */
  ensurePeer(peer, source = 'config') {
    if (!peer || this.stopped || this.opts.listen === false) return;
    const key = peer.endpoint_id || peer.device_id || (peer.direct_addrs || []).join(',');
    if (!key || peer.endpoint_id === this.key?.endpointId || peer.device_id === this.deviceId) return;
    const known = this.knownPeers.get(key);
    if (known) {
      known.direct_addrs = [...new Set([...(known.direct_addrs || []), ...(peer.direct_addrs || [])])];
      return;
    }
    const entry = { ...peer, direct_addrs: [...(peer.direct_addrs || [])], source, firstSeen: Date.now() };
    this.knownPeers.set(key, entry);
    if (source === 'lan') this.log(`[mesh] 局域网发现 ${peer.name || key.slice(0, 10)}（${entry.direct_addrs.join(',')}）`);
    const attempt = async () => {
      if (this.stopped) return;
      const linked = entry.device_id && (this.links.has(entry.device_id) || this.inbound.has(entry.device_id));
      // 两边同时连会建两条：约定 endpoint_id 小的一方连；对方迟迟不来时再自己连
      const mine = !entry.endpoint_id || this.key.endpointId < entry.endpoint_id || Date.now() - entry.firstSeen > FALLBACK_DIAL_AFTER_MS;
      // 每条路试的结果记下来：连不上时界面能说清楚试过哪些、各卡在哪
      entry.attempts = entry.attempts || {};
      if (linked) {
        entry.waiting = false;
      } else if (mine) {
        entry.waiting = false;
        for (const addr of entry.direct_addrs) {
          try {
            const link = await this._dial(addr);
            entry.device_id = link.info.device_id;
            entry.attempts[addr] = { ok: true, at: Date.now() };
            break;
          } catch (e) {
            entry.attempts[addr] = { ok: false, error: friendlyDialError(e), at: Date.now() };
          }
        }
      } else {
        // 约定由对方先连：还没等到
        entry.waiting = true;
      }
      const t = setTimeout(attempt, DIAL_RETRY_MS);
      t.unref?.();
      this.timers.push(t);
    };
    attempt();
  }

  /**
   * 连不上时的诊断：每台已知设备试过哪些直连地址、各自的结果，和官方中继的情况。
   * @returns {{ official: { configured: boolean, connected: boolean, peers: string[] }, peers: object[] }}
   */
  diagnose() {
    const official = {
      configured: (this.opts.relayUrls || []).length > 0,
      connected: !!(this.official && !this.official.closed),
      peers: this.official ? [...this.official.peers] : [],
    };
    const peers = [];
    for (const [key, e] of this.knownPeers) {
      peers.push({
        key,
        device_id: e.device_id || null,
        endpoint_id: e.endpoint_id || null,
        name: e.name || '',
        source: e.source,
        waiting: !!e.waiting,
        attempts: Object.entries(e.attempts || {}).map(([addr, a]) => ({ addr, ...a })),
        addrs: [...(e.direct_addrs || [])],
      });
    }
    return { official, peers };
  }

  /** 直连一个地址；连上的是本账号的另一台设备才留下 */
  async _dial(addr) {
    const link = new Link(this, addr);
    const info = await link.open();
    const id = info.device_id;
    if (!id || id === this.deviceId) { link.close(); throw new Error('不是另一台设备'); }
    const prev = this.links.get(id);
    if (prev && !prev.closed) { link.close(); return prev; }
    link.direct = true;
    this.links.set(id, link);
    link.peers.add(id);
    this.log(`[mesh] 直连 ${this._label(id)}（${addr}）`);
    this._greet(id);
    return link;
  }

  _onInbound(conn) {
    this.inbound.set(conn.deviceId, conn);
    this._greet(conn.deviceId);
  }

  _onInboundClose(conn) {
    if (this.inbound.get(conn.deviceId)?.ws === conn.ws) this.inbound.delete(conn.deviceId);
    this._refreshOnline(conn.deviceId);
  }

  _onLinkMessage(link, msg) {
    if (msg.type === 'relay') {
      // 跨账号（雇佣）的只会从官方中继来
      if (msg.from_user && String(msg.from_user) !== String(this.opts.userId)) {
        if (link === this.official) this.hire.onEnvelope(String(msg.from_user), String(msg.from), msg.data);
        return;
      }
      this._onEnvelope(String(msg.from), msg.data, link);
      return;
    }
    if (msg.type === 'peers') {
      link.peers = new Set((msg.devices || []).map((d) => String(d.device_id)));
      if (link.direct && link.info?.device_id) link.peers.add(link.info.device_id);
      for (const id of link.peers) this._greet(id);
      for (const d of this.directory.list()) if (!d.self) this._refreshOnline(d.device_id);
      return;
    }
    if (msg.type === 'peer_offline') {
      if (msg.to_user && String(msg.to_user) !== String(this.opts.userId)) { this.hire.onPeerOffline(String(msg.to_user), String(msg.to)); return; }
      this._refreshOnline(String(msg.to));
      return;
    }
    if (msg.type === 'relay_status') { if (link === this.uplink || (link === this.official && this.uplinkTarget === 'official')) this.relayStatus = msg; return; }
    if (msg.type === 'pong') { link.rttMs = Date.now() - Number(msg.t); }
  }

  _onLinkClose(link) {
    for (const [id, l] of this.links) if (l === link) this.links.delete(id);
    const official = this.official === link;
    if (official) this.official = null;
    if (this.uplink === link) {
      this.uplink = null;
      this.uplinkTarget = null;
      this.relayStatus = null;
    }
    if ((official || link.isUplink) && !this.stopped) setTimeout(() => this._evaluateRelay().catch(() => {}), official ? 2000 : 500).unref?.();
    for (const d of this.directory.list()) if (!d.self) this._refreshOnline(d.device_id);
  }

  /** 到某台设备怎么走：直连优先，其次经中继 */
  _route(id) {
    const link = this.links.get(id);
    if (link && !link.closed) return { kind: 'direct', addr: link.addr, send: (data) => link.send(id, data), buffered: () => link.buffered, link };
    const conn = this.inbound.get(id);
    if (conn && conn.ws.readyState === 1) {
      return { kind: 'direct', addr: conn.remote, send: (data) => this.hub.sendTo(String(this.opts.userId), id, data), buffered: () => conn.ws.bufferedAmount };
    }
    const up = this.uplink;
    if (up && !up.closed && up.peers.has(id)) return { kind: 'relay', send: (data) => up.send(id, data), buffered: () => up.buffered, link: up };
    const of = this.official;
    if (of && !of.closed && of.peers.has(id)) return { kind: 'relay', official: true, send: (data) => of.send(id, data), buffered: () => of.buffered, link: of };
    return null;
  }

  // ── 端到端会话 ─────────────────────────────────────────────────────────────

  /** 有通路了：跟它握手、交换描述（只由 device_id 小的一方主动，免得两边同时发起） */
  _greet(id) {
    if (!id || id === this.deviceId || this.sessions.get(id)?.ready) return;
    if (this.deviceId < id || this.links.has(id)) this._ensureSession(id).catch(() => {});
  }

  _ensureSession(id) {
    const cur = this.sessions.get(id);
    if (cur?.ready) return Promise.resolve(cur);
    if (cur?.promise) return cur.promise;
    const route = this._route(id);
    if (!route) return Promise.reject(Object.assign(new Error(`${this._label(id)} 离线`), { status: 404 }));
    const sid = rid() + rid();
    const eph = keys.ephemeral();
    const s = { sid, eph, initiator: true, ready: false, n: 0, seen: new Set() };
    s.promise = new Promise((resolve, reject) => {
      s.resolve = resolve;
      s.reject = reject;
      s.timer = setTimeout(() => { if (!s.ready) { this.sessions.delete(id); reject(new Error(`和 ${this._label(id)} 握手超时`)); } }, HANDSHAKE_TIMEOUT_MS);
      s.timer.unref?.();
    });
    s.promise.catch(() => {});
    this.sessions.set(id, s);
    route.send({ t: 'hello', sid, cert: this.opts.cert, eph: eph.pub, sig: keys.sign(this.key.privateKey, `tb-mesh-hello|${sid}|${eph.pub}|${id}`) });
    return s.promise;
  }

  /** 对方的证书：本账号、没被吊销、确实是那台设备；返回 claims 或 null */
  _checkPeerCert(cert, from) {
    const v = identity.verifyCert(cert, this.opts.issuerKeys);
    if (!v.ok) return null;
    const check = identity.checkPeer(cert, { issuerKeys: this.opts.issuerKeys, remoteEndpointId: v.claims.endpoint_id, selfUserId: this.opts.userId, revoked: this.revoked });
    if (!check.ok) { this.log(`[mesh] 拒绝 ${String(v.claims.device_id).slice(0, 10)}：${check.reason}`); this.emit('rejected', { device_id: v.claims.device_id, reason: check.reason }); return null; }
    if (String(check.claims.device_id) !== String(from)) return null;
    return check.claims;
  }

  _onEnvelope(from, data) {
    if (!data || typeof data !== 'object' || !from) return;
    if (data.t === 'hello') {
      const claims = this._checkPeerCert(data.cert, from);
      if (!claims || !keys.verify(claims.endpoint_id, `tb-mesh-hello|${data.sid}|${data.eph}|${this.deviceId}`, data.sig)) return;
      const cur = this.sessions.get(from);
      // 两边同时发起：endpoint_id 小的一方当发起方，另一方让开
      if (cur && !cur.ready && cur.initiator && this.key.endpointId < claims.endpoint_id) return;
      const eph = keys.ephemeral();
      const k = keys.sessionKeys({ privateKey: eph.privateKey, myPub: eph.pub, peerPub: data.eph, sid: data.sid, initiator: false });
      const s = { sid: data.sid, initiator: false, ready: true, send: k.send, recv: k.recv, n: 0, seen: new Set(), endpointId: claims.endpoint_id, claims };
      if (cur?.resolve) { clearTimeout(cur.timer); s.promise = Promise.resolve(s); cur.resolve(s); }
      this.sessions.set(from, s);
      const route = this._route(from);
      route?.send({ t: 'hello_ack', sid: data.sid, cert: this.opts.cert, eph: eph.pub, sig: keys.sign(this.key.privateKey, `tb-mesh-ack|${data.sid}|${data.eph}|${eph.pub}|${from}`) });
      this._onSessionReady(from, claims);
      return;
    }
    if (data.t === 'hello_ack') {
      const s = this.sessions.get(from);
      if (!s || s.ready || s.sid !== data.sid) return;
      const claims = this._checkPeerCert(data.cert, from);
      if (!claims || !keys.verify(claims.endpoint_id, `tb-mesh-ack|${data.sid}|${s.eph.pub}|${data.eph}|${this.deviceId}`, data.sig)) return;
      const k = keys.sessionKeys({ privateKey: s.eph.privateKey, myPub: s.eph.pub, peerPub: data.eph, sid: s.sid, initiator: true });
      Object.assign(s, { ready: true, send: k.send, recv: k.recv, endpointId: claims.endpoint_id, claims });
      clearTimeout(s.timer);
      s.resolve(s);
      this._onSessionReady(from, claims);
      return;
    }
    if (data.t === 'nosession') {
      const s = this.sessions.get(from);
      if (s && s.sid === data.sid) {
        this.sessions.delete(from);
        for (const p of this.pending.values()) if (p.device === from) p.fail(new Error(`${this._label(from)} 重启过，请重试`));
      }
      return;
    }
    if (data.t === 'box') {
      const s = this.sessions.get(from);
      if (!s || !s.ready || s.sid !== data.sid) { this._route(from)?.send({ t: 'nosession', sid: data.sid }); return; }
      if (s.seen.has(data.n)) return;
      const msg = keys.open(s.recv, data.n, data.c);
      if (!msg) return;
      s.seen.add(data.n);
      if (s.seen.size > 4096) s.seen = new Set([...s.seen].slice(-2048));
      this._dispatch(from, msg).catch((e) => this.log(`[mesh] 处理 ${msg.type} 出错：${e.message}`));
    }
  }

  _onSessionReady(id, claims) {
    if (this.revoked.has(claims.endpoint_id)) return;
    this.log(`[mesh] 已连上 ${claims.name || id}（${this._route(id)?.kind === 'relay' ? '经中继' : '直连'}）`);
    this._send(id, { type: 'presence', descriptor: this.directory.self }).catch(() => {});
    this.emit('peer', { device_id: id, name: claims.name });
  }

  async _send(id, obj) {
    const s = await this._ensureSession(id);
    const route = this._route(id);
    if (!route) throw Object.assign(new Error(`${this._label(id)} 离线`), { status: 404 });
    s.n += 1;
    route.send({ t: 'box', sid: s.sid, ...keys.seal(s.send, s.n, obj) });
    // 对方读得慢：等缓冲降下来再发，免得内存堆积
    while (route.buffered() > HIGH_WATER) await new Promise((r) => setTimeout(r, 20));
  }

  async _dispatch(from, m) {
    if (m.type === 'presence' && m.descriptor) {
      const s = this.sessions.get(from);
      let d;
      try { d = sanitizeDescriptor({ ...m.descriptor, device_id: from }); } catch { return; }
      this.directory.applyPresence({ endpoint_id: s?.endpointId, device_id: from }, d);
      for (const a of d.relay?.addrs || []) this.ensurePeer({ device_id: from, endpoint_id: s?.endpointId, direct_addrs: [a] }, 'presence');
      this._refreshOnline(from);
      return;
    }
    if (m.type === 'ping') { await this._send(from, { type: 'pong', t: m.t }); return; }
    if (m.type === 'pong') { const s = this.sessions.get(from); if (s) s.rttMs = Date.now() - Number(m.t); return; }
    if (m.type === 'http_request') { this._serve(from, m); return; }
    if (m.type === 'cancel') { this.serving.get(`${from}:${m.req_id}`)?.cancel(); return; }
    const p = this.pending.get(m.req_id);
    if (!p || p.device !== from) return;
    if (m.type === 'http_head') p.head(m.status, m.headers || {});
    else if (m.type === 'chunk') p.push(keys.fromB64u(m.d));
    else if (m.type === 'done') p.end();
    else if (m.type === 'error') p.fail(Object.assign(new Error(m.message || '对端出错'), { status: 502 }));
  }

  // ── HTTP 请求 ──────────────────────────────────────────────────────────────

  /**
   * 把一次 HTTP 请求交给某台设备的本机网关。
   * @returns {Promise<{ status, headers, chunks: AsyncIterable<Buffer> }>}
   */
  async proxy(deviceId, req) {
    const id = String(deviceId);
    const reqId = rid();
    const method = String(req.method || 'GET').toUpperCase();
    const pathOnly = String(req.path || '').split('?')[0];
    // 只详细记「派一个智能体任务」。后面每秒查进度不在这里打，避免刷屏
    const agentPost = method === 'POST' && pathOnly === '/v1/agent/responses';
    const route = this._route(id);
    const via = !route ? '没有通路' : route.official ? '经官方中继' : route.kind === 'relay' ? '经设备中继' : '直连';
    if (agentPost) this.log(`[mesh] 发出智能体任务 → ${this._label(id)}（${via}）`);
    const started = Date.now();
    let p;
    const queue = [];
    let wake = null;
    let ended = false;
    let failure = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    try {
      p = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(reqId); reject(Object.assign(new Error(`${this._label(id)} 没有响应`), { status: 504 })); }, HEAD_TIMEOUT_MS);
      timer.unref?.();
      const entry = {
        device: id,
        head: (status, headers) => {
          clearTimeout(timer);
          resolve({
            status, headers,
            chunks: (async function* gen() {
              for (;;) {
                if (queue.length) { yield queue.shift(); continue; }
                if (failure) throw failure;
                if (ended) return;
                await new Promise((r) => { wake = r; });
              }
            }()),
          });
        },
        push: (buf) => { queue.push(buf); notify(); },
        end: () => { ended = true; this.pending.delete(reqId); notify(); },
        fail: (e) => { failure = e; this.pending.delete(reqId); clearTimeout(timer); reject(e); notify(); },
      };
      this.pending.set(reqId, entry);
      const body = req.body ? Buffer.from(req.body) : Buffer.alloc(0);
      this._send(id, { type: 'http_request', req_id: reqId, method: req.method, path: req.path, headers: req.headers || {}, body: keys.b64u(body) })
        .catch((e) => entry.fail(e));
      });
    } catch (e) {
      // 查询进度失败由跟任务的那一侧记「状态变了才打」；派任务失败在这里记一次
      if (agentPost) this.log(`[mesh] 智能体任务没送到 ${this._label(id)}（${Date.now() - started}ms，${via}）：${e.message}`);
      throw e;
    }
    if (agentPost) this.log(`[mesh] ${this._label(id)} 已应答 HTTP ${p.status}（${Date.now() - started}ms，${via}）`);
    return p;
  }

  _serve(from, m) {
    const key = `${from}:${m.req_id}`;
    const send = (obj) => this._send(from, { ...obj, req_id: m.req_id });
    const handle = tunnel.serveLocal({ method: m.method, path: m.path, headers: m.headers, body: keys.fromB64u(m.body) }, {
      gatewayPort: this.opts.gatewayPort, meshKey: this.meshKey, fromDeviceId: from, log: this.log,
    }, {
      head: (status, headers) => { send({ type: 'http_head', status, headers }).catch(() => handle.cancel()); },
      chunk: (buf) => send({ type: 'chunk', d: keys.b64u(buf) }),
      done: () => { this.serving.delete(key); send({ type: 'done' }).catch(() => {}); },
      error: (message) => { this.serving.delete(key); send({ type: 'error', message }).catch(() => {}); },
    });
    this.serving.set(key, handle);
  }

  // ── 描述、在线状态 ─────────────────────────────────────────────────────────

  async refreshSelf() {
    const raw = await this.opts.describeSelf();
    const hubStatus = this.hub ? this.hub.status(String(this.opts.userId)) : null;
    const relay = {
      enabled: this.relayActive(),
      addrs: this._relayAddrs(),
      verified: this.cloudMode ? this.verifiedAddrs.length > 0 : false,
      sessions: hubStatus ? hubStatus.pairs.length : 0,
      serving: hubStatus ? hubStatus.pairs.map((p) => [p.a, p.b]) : [],
    };
    if (this.opts.relay?.prefAt) relay.pref = { value: this.opts.relay.pref || 'auto', at: Number(this.opts.relay.prefAt) };
    const draft = sanitizeDescriptor({ ...raw, device_id: this.deviceId, name: this.deviceName, seq: this.seq, relay });
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
    for (const [id, s] of this.sessions) {
      if (!s.ready) continue;
      if (changed) this._send(id, { type: 'presence', descriptor: this.directory.self }).catch(() => {});
      this._refreshOnline(id);
    }
    // 中继选择跟着描述变（谁开了中继、谁改了手动指定）
    const pick = this._pickRelay();
    if (pick.target !== this.uplinkTarget && !(pick.target === 'official' && !this.official)) await this._evaluateRelay();
    else if (pick.target === 'official' && (this.opts.relayUrls || []).length && !this.official) await this._ensureOfficial();
    else if ((this.opts.relayUrls || []).length && !this.official) this._ensureOfficial().catch(() => {});
  }

  _pathFor(id) {
    const r = this._route(id);
    const s = this.sessions.get(id);
    if (!r) return null;
    if (r.kind === 'direct') return { kind: 'direct', addr: r.addr, addr_kind: addrKind(r.addr), rttMs: s?.rttMs ?? r.link?.rttMs ?? null };
    const official = !!r.official;
    const dev = official ? null : r.link?.info?.device_id || this.uplinkTarget;
    return {
      kind: 'relay', relay_kind: official ? 'official' : 'device',
      relay_device: dev, via: official ? '官方中继' : this._label(dev), rttMs: s?.rttMs ?? null,
    };
  }

  _refreshOnline(id) {
    const d = this.directory.get(id);
    if (!d) return;
    const path = this._pathFor(id);
    if (path && this.sessions.get(id)?.ready) {
      if (!d.online) { d.online = true; d.lastSeen = Date.now(); }
      this.directory.setPath(id, path);
    } else if (d.online) {
      this.directory.markOffline(id);
      this.log(`[mesh] ${deviceLabel(d)} 断开`);
      this.emit('peer-offline', { device_id: id });
    }
  }

  _pingAll() {
    this.uplink?.ping();
    this.official?.ping();
    for (const l of this.links.values()) l.ping();
    for (const [id, s] of this.sessions) if (s.ready) this._send(id, { type: 'ping', t: Date.now() }).catch(() => {});
  }

  /** 本机作为中继，正在转发哪些设备之间的连接；本机用的中继是哪台 */
  relayInfo() {
    const hub = this.hub ? this.hub.status(String(this.opts.userId)) : { pairs: [] };
    return {
      active: this.relayActive(),
      serving: hub.pairs.map((p) => [p.a, p.b]),
      using: this.uplinkTarget,
      using_label: this.uplinkTarget === 'official' ? '官方中继' : this.uplinkTarget === 'self' ? '本机' : this.uplinkTarget ? this._label(this.uplinkTarget) : null,
      pref: this._relayPref(),
      unavailable: this.relayPick?.unavailable || null,
    };
  }

  /** 改手动指定的中继：记下时间，经描述发给其他设备，大家都换过去 */
  setRelayPref(value) {
    this.opts.relay = { ...(this.opts.relay || {}), pref: value || 'auto', prefAt: Date.now() };
    return this.tick();
  }

  setRelayMode(mode) {
    this.opts.relay = { ...(this.opts.relay || {}), mode: ['on', 'off'].includes(mode) ? mode : 'auto' };
    return this.tick();
  }

  // ── 证书、吊销、鉴权 ───────────────────────────────────────────────────────

  setRevoked(ids = []) {
    this.revoked = new Set((ids || []).map(String).filter(Boolean));
    for (const [id, s] of [...this.sessions]) {
      if (s.endpointId && this.revoked.has(s.endpointId)) {
        this.log(`[mesh] ${this._label(id)} 已被吊销，断开`);
        this.sessions.delete(id);
        this.links.get(id)?.close();
        try { this.inbound.get(id)?.ws.close(4003, 'revoked'); } catch { /* 已断 */ }
        this.directory.markOffline(id);
      }
    }
  }

  updateCert(cert, issuerKeys) {
    this.opts.cert = cert;
    if (Array.isArray(issuerKeys) && issuerKeys.length) this.opts.issuerKeys = issuerKeys;
  }

  /** 只有设备网络转进来的请求才带这把 Key；外部调用方拿不到 */
  isMeshKey(key) {
    const k = String(key || '');
    return k.length === this.meshKey.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(this.meshKey));
  }

  isMeshRequest(headers = {}) {
    const auth = String(headers.authorization || '');
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    return !!headers['x-tb-mesh-from'] && this.isMeshKey(key);
  }

  async _startLanDiscovery() {
    const { LanDiscovery } = require('./lan-discovery');
    this.lan = new LanDiscovery({
      endpointId: this.key.endpointId,
      meshPort: this.port,
      cert: this.opts.cert,
      selfUserId: this.opts.userId,
      issuerKeys: this.opts.issuerKeys,
      revoked: this.revoked,
      port: this.opts.lanPort,
      onPeer: (peer) => this.ensurePeer(peer, 'lan'),
      log: this.log,
    });
    await this.lan.start();
  }
}

module.exports = { MeshNode, Link, localAddrs, addrKind, wsUrl, DEFAULT_PORT, friendlyDialError };
