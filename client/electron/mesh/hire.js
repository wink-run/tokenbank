// client/electron/mesh/hire.js
// 雇佣走设备通道：和本人设备之间是同一条通道、同一套握手和加密，只是多一张云端签的雇佣票。
//
//   雇佣方  ──官方中继（凭票跨账号放行）──▶  出租方
//   hello {sid, cert, eph, sig, ticket}      出租方核对：票是云端签的、写的是本机、对方证书就是票上的那台设备
//   hello_ack {sid, cert, eph, sig}          雇佣方核对：对方证书就是票上的出租方设备
//   box: agent_task                       → 出租方用原来的出租逻辑执行（安全审查、脱敏、按调用方隔离目录都在本机）
//   box: agent_task_progress / _output_manifest / _artifacts / _result ←
//   box: agent_task_cancel                →
//
// 和以前 /ws/worker 的消息词汇一样，区别是内容端到端加密，云端只签票、记账，看不到提示词和结果。
// 权限只看连接身份：任务号、智能体、调用方隔离键、调用关系都从票里取，消息里写的不算。
'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const identity = require('./identity');
const keys = require('./keys');

const HANDSHAKE_TIMEOUT_MS = 10000;

function rid() { return crypto.randomBytes(16).toString('hex'); }

class HireChannel extends EventEmitter {
  /** @param {import('./node').MeshNode} node */
  constructor(node) {
    super();
    this.node = node;
    this.sessions = new Map();   // `${user}:${device}` → 会话
    this.byTask = new Map();     // 雇佣方：tid → { resolve, reject, onEvent, key }
    this.served = new Set();     // 出租方：已经接过的 tid（一张票只做一单）
  }

  get log() { return this.node.log; }

  _official() {
    const l = this.node.official;
    return l && !l.closed ? l : null;
  }

  _sendRaw(user, device, data, ticket) {
    const l = this._official();
    if (!l) return false;
    return l.send(device, data, { to_user: user, ...(ticket ? { ticket } : {}) });
  }

  _sendBox(key, obj) {
    const s = this.sessions.get(key);
    if (!s || !s.ready) return false;
    s.n += 1;
    return this._sendRaw(s.user, s.device, { t: 'box', sid: s.sid, ...keys.seal(s.send, s.n, obj) }, s.ticket);
  }

  // ── 雇佣方 ────────────────────────────────────────────────────────────────

  /**
   * 凭票把一单交给出租方的设备。
   * @param {{ ticket: string, task: object, onEvent?: (msg) => void, timeoutMs?: number }} p
   * @returns {Promise<object>} agent_task_result
   */
  async run({ ticket, task, onEvent, timeoutMs }) {
    const v = identity.verifyHireTicket(ticket, this.node.opts.issuerKeys);
    if (!v.ok) throw new Error(`雇佣票无效：${v.reason}`);
    const c = v.claims;
    if (String(c.hd) !== this.node.deviceId || String(c.he) !== this.node.key.endpointId) throw new Error('雇佣票不是签给这台设备的');
    if (!this._official()) await this.node._ensureOfficial();
    if (!this._official()) throw Object.assign(new Error('连不上官方中继'), { code: 'no_relay' });
    const key = `${c.wu}:${c.wd}`;
    const s = await this._handshake(key, c, ticket);
    return new Promise((resolve, reject) => {
      const ms = timeoutMs || Math.max(30000, (c.exp * 1000) - Date.now());
      const timer = setTimeout(() => { this.byTask.delete(c.tid); reject(Object.assign(new Error('出租方没有在时限内交回结果'), { code: 'timeout' })); }, ms);
      timer.unref?.();
      this.byTask.set(c.tid, {
        key,
        onEvent,
        resolve: (r) => { clearTimeout(timer); this.byTask.delete(c.tid); resolve(r); },
        reject: (e) => { clearTimeout(timer); this.byTask.delete(c.tid); reject(e); },
      });
      // 任务号、智能体由票决定；这里只带正文
      this._sendBox(key, {
        type: 'agent_task', task_id: c.tid, prompt: task.prompt,
        images: task.images || null, files: task.files || null, timeout_ms: task.timeout_ms || null,
      });
      s.lastTid = c.tid;
    });
  }

  cancel(tid) {
    const p = this.byTask.get(tid);
    if (p) this._sendBox(p.key, { type: 'agent_task_cancel', task_id: tid });
  }

  _handshake(key, c, ticket) {
    const cur = this.sessions.get(key);
    if (cur?.ready && cur.ticket === ticket) return Promise.resolve(cur);
    const sid = rid();
    const eph = keys.ephemeral();
    const s = { key, user: String(c.wu), device: String(c.wd), endpoint: String(c.we), sid, eph, ticket, initiator: true, ready: false, n: 0, seen: new Set(), claims: c };
    const promise = new Promise((resolve, reject) => {
      s.resolve = resolve;
      s.timer = setTimeout(() => { if (!s.ready) { this.sessions.delete(key); reject(Object.assign(new Error('出租方设备没有回应（可能不在线或没开设备网络）'), { code: 'unreachable' })); } }, HANDSHAKE_TIMEOUT_MS);
      s.timer.unref?.();
      s.reject = reject;
    });
    this.sessions.set(key, s);
    this._sendRaw(s.user, s.device, {
      t: 'hello', sid, cert: this.node.opts.cert, eph: eph.pub, ticket,
      sig: keys.sign(this.node.key.privateKey, `tb-mesh-hello|${sid}|${eph.pub}|${s.device}`),
    }, ticket);
    return promise;
  }

  // ── 收到跨账号的消息 ───────────────────────────────────────────────────────

  onEnvelope(fromUser, from, data) {
    if (!data || typeof data !== 'object') return;
    const key = `${fromUser}:${from}`;
    if (data.t === 'hello') return this._onHello(fromUser, from, key, data);
    if (data.t === 'hello_ack') return this._onAck(key, data);
    if (data.t === 'box') {
      const s = this.sessions.get(key);
      if (!s || !s.ready || s.sid !== data.sid || s.seen.has(data.n)) return;
      const msg = keys.open(s.recv, data.n, data.c);
      if (!msg) return;
      s.seen.add(data.n);
      if (s.role === 'worker') this._onWorkerMessage(key, s, msg);
      else this._onHirerMessage(msg);
    }
  }

  /** 雇佣方断了（中继说对方不在） */
  onPeerOffline(user, device) {
    const key = `${user}:${device}`;
    const s = this.sessions.get(key);
    if (s && !s.ready) { clearTimeout(s.timer); this.sessions.delete(key); s.reject?.(Object.assign(new Error('出租方设备不在线'), { code: 'unreachable' })); }
    for (const p of this.byTask.values()) if (p.key === key) p.reject(Object.assign(new Error('出租方设备断开了'), { code: 'unreachable' }));
  }

  /** 出租方：有人凭票来找本机 */
  _onHello(fromUser, from, key, data) {
    const node = this.node;
    const v = identity.verifyHireTicket(data.ticket, node.opts.issuerKeys);
    if (!v.ok) { this.log(`[mesh] 拒绝雇佣连接：票无效（${v.reason}）`); return; }
    const c = v.claims;
    const cert = identity.verifyCert(data.cert, node.opts.issuerKeys);
    const h = cert.ok ? cert.claims : null;
    const fits = h && String(c.wu) === String(node.opts.userId) && String(c.wd) === node.deviceId && String(c.we) === node.key.endpointId
      && String(c.sub) === String(fromUser) && String(c.hd) === String(from)
      && String(h.sub) === String(c.sub) && String(h.device_id) === String(c.hd) && String(h.endpoint_id) === String(c.he)
      && !node.revoked.has(c.he);
    if (!fits || !keys.verify(c.he, `tb-mesh-hello|${data.sid}|${data.eph}|${node.deviceId}`, data.sig)) {
      this.log('[mesh] 拒绝雇佣连接：票和对方设备对不上');
      return;
    }
    const eph = keys.ephemeral();
    const k = keys.sessionKeys({ privateKey: eph.privateKey, myPub: eph.pub, peerPub: data.eph, sid: data.sid, initiator: false });
    const s = { key, user: String(fromUser), device: String(from), sid: data.sid, role: 'worker', ready: true, send: k.send, recv: k.recv, n: 0, seen: new Set(), claims: c, name: h.name || '' };
    this.sessions.set(key, s);
    this._sendRaw(s.user, s.device, {
      t: 'hello_ack', sid: data.sid, cert: node.opts.cert, eph: eph.pub,
      sig: keys.sign(node.key.privateKey, `tb-mesh-ack|${data.sid}|${data.eph}|${eph.pub}|${from}`),
    });
  }

  /** 雇佣方：出租方回了握手 */
  _onAck(key, data) {
    const s = this.sessions.get(key);
    if (!s || s.ready || s.sid !== data.sid) return;
    const cert = identity.verifyCert(data.cert, this.node.opts.issuerKeys);
    const w = cert.ok ? cert.claims : null;
    if (!w || String(w.sub) !== s.user || String(w.device_id) !== s.device || String(w.endpoint_id) !== s.endpoint) return;
    if (!keys.verify(s.endpoint, `tb-mesh-ack|${s.sid}|${s.eph.pub}|${data.eph}|${this.node.deviceId}`, data.sig)) return;
    const k = keys.sessionKeys({ privateKey: s.eph.privateKey, myPub: s.eph.pub, peerPub: data.eph, sid: s.sid, initiator: true });
    Object.assign(s, { ready: true, send: k.send, recv: k.recv, role: 'hirer' });
    clearTimeout(s.timer);
    s.resolve(s);
  }

  _onHirerMessage(msg) {
    const p = this.byTask.get(String(msg.task_id || ''));
    if (!p) return;
    try { p.onEvent?.(msg); } catch { /* 回调出错不影响收结果 */ }
    if (msg.type === 'agent_task_result') p.resolve(msg);
  }

  /** 出租方：只接 agent_task / agent_task_cancel；别的（比如 http_request）一律不认 */
  _onWorkerMessage(key, s, msg) {
    const c = s.claims;
    if (msg.type === 'agent_task_cancel') { this.emit('cancel', c.tid); return; }
    if (msg.type !== 'agent_task') return;
    if (this.served.has(c.tid)) return;
    if (c.exp * 1000 < Date.now()) return;
    this.served.add(c.tid);
    const leftMs = c.exp * 1000 - Date.now() - 30000;
    const task = {
      type: 'agent_task',
      task_id: c.tid,
      assistant_id: c.aid,
      consumer_key: c.ck,
      session_key: c.sk || null,
      call_context: c.ctx || 'hired',
      hirer_name: s.name,
      prompt: String(msg.prompt || '').slice(0, 50000),
      images: Array.isArray(msg.images) ? msg.images : null,
      files: Array.isArray(msg.files) ? msg.files : null,
      timeout_ms: Math.max(30000, Math.min(Number(msg.timeout_ms) || leftMs, leftMs)),
      via: 'mesh',
    };
    this.emit('task', { claims: c, task, send: (obj) => this._sendBox(key, { ...obj, task_id: c.tid }) });
  }
}

module.exports = { HireChannel };
