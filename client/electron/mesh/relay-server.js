#!/usr/bin/env node
// TokenBank 官方中继：和每个 app 里的中继是同一份代码（relay.js），只是配置不同：
// 服务所有账号，但只在同一账号的设备之间转发；不当任何设备的「本机」。
//
//   PORT=8790 MESH_ISSUER_PUBLIC_KEYS=<kid>:<x>[,<kid>:<x>] node relay-server.js
//
// 可选：MESH_REVOCATIONS_URL + MESH_RELAY_ACCESS_TOKEN —— 每分钟从服务端拉一次被吊销的设备密钥
//       MESH_RELAY_MAX_PER_USER —— 每个账号最多同时连几台（默认 20）
//       MESH_RELAY_DUMP —— 测试用：把转发的内容原样写进这个文件，验证中继看不到明文
'use strict';

const http = require('http');
const WebSocket = require('ws');
const { RelayHub } = require('./relay');

function parseKeys(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf(':');
    return { kid: s.slice(0, i), x: s.slice(i + 1) };
  }).filter((k) => k.kid && k.x);
}

function startRelayServer({ port = Number(process.env.PORT) || 8790, host = '0.0.0.0', issuerKeys, revocationsUrl, accessToken, maxPerUser, dumpFile, log = console.log } = {}) {
  let keys = issuerKeys || parseKeys(process.env.MESH_ISSUER_PUBLIC_KEYS);
  let revoked = new Set();
  const hub = new RelayHub({
    kind: 'official',
    issuerKeys: () => keys,
    isRevoked: (id) => revoked.has(id),
    maxPerUser: maxPerUser || Number(process.env.MESH_RELAY_MAX_PER_USER) || 20,
    dumpFile: dumpFile || process.env.MESH_RELAY_DUMP || undefined,
    log,
  });
  const url = revocationsUrl || process.env.MESH_REVOCATIONS_URL;
  const token = accessToken || process.env.MESH_RELAY_ACCESS_TOKEN;
  let poll = null;
  if (!url && !keys.length) log('[relay] 没配 MESH_REVOCATIONS_URL，也没配 MESH_ISSUER_PUBLIC_KEYS：没有签发公钥，所有设备都会被拒绝');
  if (url) {
    let ok = false;
    const pull = async () => {
      try {
        const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10000) });
        if (!r.ok) {
          log(`[relay] 拉签发公钥和吊销列表失败：${url} 回 HTTP ${r.status}${r.status === 401 ? '（MESH_RELAY_ACCESS_TOKEN 和服务端的不一样，或服务端没配）' : ''}`);
          return;
        }
        const j = await r.json();
        revoked = new Set((j.endpoints || []).map(String));
        if (Array.isArray(j.issuer_keys) && j.issuer_keys.length) keys = j.issuer_keys;
        if (!ok) log(`[relay] 已从 ${url} 拉到 ${keys.length} 把签发公钥、${revoked.size} 个吊销`);
        ok = true;
      } catch (e) {
        const why = e.cause ? `${e.cause.code || ''} ${e.cause.message || ''}`.trim() : e.message;
        log(`[relay] 拉签发公钥和吊销列表失败：${url}：${why}${keys.length ? '（先用手上的公钥）' : '（手上没有签发公钥，设备都会被拒绝）'}`);
      }
    };
    // 拉到之前每 10 秒重试一次，之后每分钟一次
    const loop = async () => { await pull(); poll = setTimeout(loop, ok ? 60000 : 10000); poll.unref?.(); };
    loop();
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, edition: 'official', proto: 1, devices: hub.conns.size, issuer_keys: keys.length, revoked: revoked.size }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (String(req.url || '').split('?')[0] !== '/mesh/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => hub.handle(ws, req));
  });
  return new Promise((resolve) => server.listen(port, host, () => {
    log(`[relay] 官方中继在 :${server.address().port}/mesh/ws`);
    resolve({
      server, hub, port: server.address().port,
      close: () => new Promise((r) => { clearTimeout(poll); hub.close(); wss.close(); server.close(() => r()); }),
    });
  }));
}

if (require.main === module) {
  startRelayServer().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { startRelayServer, parseKeys };
