// client/electron/mesh/lan-discovery.js
// 局域网发现：不靠云端地址簿，在同一个局域网里找到本账号的其他设备。断网时也能用。
// 每台设备定时用 UDP 组播（再加一份广播兜底，有的路由器屏蔽组播）喊一声：我的 endpoint_id、设备网络入口端口、设备证书。
// 收到的一方先校验证书，确认是本账号的设备，才把「来源 IP:端口」交给节点去拨。
// 安全：广播内容谁都能伪造或重放，但没用。拨号时 QUIC 握手会验证对方确实持有这把设备密钥，
// 连上之后还要再交换一次证书。伪造的广播最多让我们白拨一次。
'use strict';

const dgram = require('dgram');
const identity = require('./identity');

const GROUP = '239.255.77.77';
const DEFAULT_PORT = 41700;
const ANNOUNCE_MS = 5000;
const MAX_PACKET = 8 * 1024;
const MSG_TYPE = 'tb-mesh-announce';

/** 纯函数：解析并校验一条广播；不该理就返回 null */
function parseAnnouncement(buf, rinfo, { selfEndpointId, selfUserId, issuerKeys, revoked, now } = {}) {
  if (!buf || buf.length > MAX_PACKET) return null;
  let msg;
  try { msg = JSON.parse(buf.toString('utf8')); } catch { return null; }
  if (!msg || msg.t !== MSG_TYPE || msg.v !== 1) return null;
  const endpointId = String(msg.endpoint_id || '');
  const port = Number(msg.port);
  if (!endpointId || endpointId === selfEndpointId) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const check = identity.checkPeer(msg.cert, { issuerKeys, remoteEndpointId: endpointId, selfUserId, revoked, now });
  if (!check.ok) return { rejected: check.reason, endpoint_id: endpointId };
  return {
    endpoint_id: endpointId,
    device_id: check.claims.device_id,
    name: check.claims.name,
    direct_addrs: [`${rinfo.address}:${port}`],
  };
}

function buildAnnouncement({ endpointId, port, cert }) {
  return Buffer.from(JSON.stringify({ t: MSG_TYPE, v: 1, endpoint_id: endpointId, port, cert }));
}

class LanDiscovery {
  /**
   * @param {{ endpointId: string, meshPort: number, cert: string, selfUserId, issuerKeys, revoked?: Set,
   *   port?: number, onPeer: (peer) => void, log?: Function }} opts
   */
  constructor(opts) {
    this.opts = opts;
    this.port = opts.port || DEFAULT_PORT;
    this.sock = null;
    this.timer = null;
    this.seenRejected = new Set();
  }

  start() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('message', (buf, rinfo) => {
      const peer = parseAnnouncement(buf, rinfo, {
        selfEndpointId: this.opts.endpointId,
        selfUserId: this.opts.selfUserId,
        issuerKeys: this.opts.issuerKeys,
        revoked: this.opts.revoked,
      });
      if (!peer) return;
      if (peer.rejected) {
        // 别的账号的设备也在这个局域网里很正常，每台只记一次
        if (!this.seenRejected.has(peer.endpoint_id)) {
          this.seenRejected.add(peer.endpoint_id);
          this.opts.log?.(`[mesh] 局域网里有一台不能接入的设备 ${peer.endpoint_id.slice(0, 10)}：${peer.rejected}`);
        }
        return;
      }
      this.opts.onPeer(peer);
    });
    // bind 失败要拒绝，不能一直等回调：Docker 里 UDP 端口经常绑不上，否则整个设备网络卡在启动
    return new Promise((resolve, reject) => {
      let opened = false;
      sock.on('error', (e) => {
        this.opts.log?.(`[mesh] 局域网发现出错：${e.message}`);
        if (!opened) reject(e);
      });
      sock.bind(this.port, () => {
        opened = true;
        try { sock.addMembership(GROUP); } catch (e) { this.opts.log?.(`[mesh] 加入组播失败，只用广播：${e.message}`); }
        try { sock.setMulticastTTL(1); sock.setMulticastLoopback(true); sock.setBroadcast(true); } catch { /* 部分平台不支持 */ }
        this.announce();
        this.timer = setInterval(() => this.announce(), ANNOUNCE_MS);
        this.timer.unref?.();
        resolve(this);
      });
    });
  }

  announce() {
    if (!this.sock) return;
    const pkt = buildAnnouncement({ endpointId: this.opts.endpointId, port: this.opts.meshPort, cert: this.opts.cert });
    this.sock.send(pkt, this.port, GROUP, () => {});
    this.sock.send(pkt, this.port, '255.255.255.255', () => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.sock?.close(); } catch { /* 已关闭 */ }
    this.sock = null;
  }
}

module.exports = { LanDiscovery, parseAnnouncement, buildAnnouncement, GROUP, DEFAULT_PORT };
