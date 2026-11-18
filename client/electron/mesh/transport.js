// client/electron/mesh/transport.js
// iroh 传输层。整个设备网络只有这个文件直接依赖 @number0/iroh，换实现（比如 Rust 独立进程）只改这里。
// 配置：不用 n0 的公共发现和中继；中继只用 TokenBank 服务端的（原型阶段可以不配，只走直连）。
'use strict';

const ALPN = [...Buffer.from('tokenbank/mesh/1')];
const WRITE_CHUNK = 64 * 1024;

let _iroh = null;
function iroh() {
  if (_iroh) return _iroh;
  try {
    _iroh = require('@number0/iroh');
  } catch (e) {
    throw new Error(`设备网络需要 @number0/iroh：${e.message}`);
  }
  return _iroh;
}

/** 32 字节设备密钥 → endpoint_id（base32 公钥） */
function endpointIdFromSecret(secret) {
  return iroh().SecretKey.fromBytes([...secret]).public().toString();
}

/** iroh 的 BiStream → 分帧层要的 { write, finish, read } */
function adaptBi(bi) {
  return {
    async write(buf) {
      for (let i = 0; i < buf.length; i += WRITE_CHUNK) {
        await bi.send.writeAll(Array.from(buf.subarray(i, i + WRITE_CHUNK)));
      }
    },
    async finish() { await bi.send.finish(); },
    async read(max) {
      const arr = await bi.recv.read(max);
      if (!arr || arr.length === 0) return null;
      return Buffer.from(arr);
    },
  };
}

class Conn {
  constructor(conn) { this.conn = conn; }
  remoteId() { return this.conn.remoteId().toString(); }
  async openStream() { return adaptBi(await this.conn.openBi()); }
  async acceptStream() { return adaptBi(await this.conn.acceptBi()); }
  /** 当前选中的路径：直连还是中继，以及往返延迟 */
  pathInfo() {
    try {
      const sel = (this.conn.paths() || []).find((p) => p.isSelected) || (this.conn.paths() || [])[0];
      if (!sel) return { kind: 'unknown', rttMs: null };
      return { kind: sel.isRelay ? 'relay' : 'direct', rttMs: sel.rttMs, remoteAddr: sel.isRelay ? null : sel.remoteAddr };
    } catch { return { kind: 'unknown', rttMs: null }; }
  }
  closed() { return this.conn.closed(); }
  close(reason = 'bye') { try { this.conn.close(0n, [...Buffer.from(reason)]); } catch { /* 已经关了 */ } }
}

class Transport {
  /**
   * @param {{ secret: Buffer, relayUrls?: string[], relayToken?: string, bindAddr?: string }} opts
   */
  static async create({ secret, relayUrls = [], relayToken, bindAddr } = {}) {
    const I = iroh();
    const b = I.Endpoint.builder();
    // minimal：只有加密，没有 n0 的 DNS 发现，设备地址不交给第三方
    b.applyMinimal();
    b.secretKey([...secret]);
    b.alpns([ALPN]);
    if (relayUrls.length) {
      const map = I.RelayMap.empty();
      for (const url of relayUrls) map.insert(relayToken ? { url, authToken: relayToken } : { url });
      b.relayMode(I.RelayMode.custom(map));
    } else {
      b.relayMode(I.RelayMode.disabled());
    }
    if (bindAddr) b.bindAddr(bindAddr);
    const ep = await b.bind();
    return new Transport(ep);
  }

  constructor(ep) { this.ep = ep; }

  id() { return this.ep.id().toString(); }

  /** 写进地址簿的内容：endpoint_id、中继、直连地址 */
  addrInfo() {
    const a = this.ep.addr();
    let relay = null;
    try { relay = a.relayUrl ? a.relayUrl() : null; } catch { relay = null; }
    return { endpoint_id: this.id(), relay_url: relay, direct_addrs: a.directAddresses() };
  }

  async dial({ endpoint_id, relay_url, direct_addrs }) {
    const I = iroh();
    const addr = new I.EndpointAddr(I.EndpointId.fromString(endpoint_id), relay_url || null, direct_addrs || []);
    return new Conn(await this.ep.connect(addr, ALPN));
  }

  /** 循环接受进来的连接；handler 自己决定留不留 */
  acceptLoop(handler, onError) {
    let stopped = false;
    (async () => {
      while (!stopped) {
        let inc;
        try { inc = await this.ep.acceptNext(); } catch (e) { if (!stopped) onError?.(e); break; }
        if (!inc) break;
        (async () => {
          try {
            const acc = await inc.accept();
            const conn = await acc.connect();
            await handler(new Conn(conn));
          } catch (e) { onError?.(e); }
        })();
      }
    })();
    return () => { stopped = true; };
  }

  async close() { try { await this.ep.close(); } catch { /* 已经关了 */ } }
}

module.exports = { Transport, endpointIdFromSecret, ALPN };
