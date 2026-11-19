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
  if (url) {
    const pull = async () => {
      try {
        const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!r.ok) return;
        const j = await r.json();
        revoked = new Set((j.endpoints || []).map(String));
        if (Array.isArray(j.issuer_keys) && j.issuer_keys.length) keys = j.issuer_keys;
      } catch (e) { log(`[relay] 拉吊销列表失败：${e.message}`); }
    };
    pull();
    poll = setInterval(pull, 60000);
    poll.unref?.();
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, edition: 'official', proto: 1, devices: hub.conns.size }));
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
      close: () => new Promise((r) => { clearInterval(poll); hub.close(); wss.close(); server.close(() => r()); }),
    });
  }));
}

if (require.main === module) {
  startRelayServer().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { startRelayServer, parseKeys };
