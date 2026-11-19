#!/usr/bin/env node
// 设备网络吞吐基准（E1-8）：同一台机器上两个 iroh 端点直连，测原始流和分帧（隧道用的）两种吞吐。
//   node scripts/mesh-bench.js [MB，默认 50]
// 结论写进 electron/mesh/README.md「M0 验证结果」。
'use strict';

const crypto = require('crypto');
const { Transport } = require('../electron/mesh/transport');
const { FrameStream } = require('../electron/mesh/frames');

const MB = Number(process.argv[2]) || 50;
const TOTAL = MB * 1024 * 1024;
const CHUNK = 256 * 1024;

async function pair() {
  const a = await Transport.create({ secret: crypto.randomBytes(32), bindAddr: '127.0.0.1:0' });
  const b = await Transport.create({ secret: crypto.randomBytes(32), bindAddr: '127.0.0.1:0' });
  let resolveConn;
  const incoming = new Promise((r) => { resolveConn = r; });
  b.acceptLoop((conn) => { resolveConn(conn); return new Promise(() => {}); });
  const info = b.addrInfo();
  const conn = await a.dial({ endpoint_id: info.endpoint_id, direct_addrs: info.direct_addrs.filter((x) => x.startsWith('127.')) });
  return { a, b, conn, server: await incoming };
}

async function rawStream(conn, server) {
  const payload = crypto.randomBytes(CHUNK);
  const recv = (async () => {
    const io = await server.acceptStream();
    let got = 0;
    for (;;) { const c = await io.read(1024 * 1024); if (!c) break; got += c.length; }
    return got;
  })();
  const io = await conn.openStream();
  const t0 = process.hrtime.bigint();
  for (let sent = 0; sent < TOTAL; sent += CHUNK) await io.write(payload);
  await io.finish();
  const got = await recv;
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: got };
}

async function framed(conn, server) {
  const payload = crypto.randomBytes(CHUNK);
  const recv = (async () => {
    const fsm = new FrameStream(await server.acceptStream());
    let got = 0;
    for (;;) { const f = await fsm.next(); if (!f) break; if (f.kind === 'data') got += f.value.length; }
    return got;
  })();
  const fsm = new FrameStream(await conn.openStream());
  const t0 = process.hrtime.bigint();
  for (let sent = 0; sent < TOTAL; sent += CHUNK) await fsm.writeData(payload);
  await fsm.finish();
  const got = await recv;
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: got };
}

(async () => {
  const { a, b, conn, server } = await pair();
  console.log(`连接方式：${conn.pathInfo().kind}，每次 ${MB} MB`);
  const rate = (r) => `${(r.bytes / 1024 / 1024 / (r.ms / 1000)).toFixed(1)} MB/s（${(r.ms / 1000).toFixed(1)} 秒，收到 ${(r.bytes / 1024 / 1024).toFixed(0)} MB）`;
  const r1 = await rawStream(conn, server);
  console.log(`原始双向流：${rate(r1)}`);
  const r2 = await framed(conn, server);
  console.log(`分帧（隧道里用的）：${rate(r2)}`);
  conn.close();
  await a.close();
  await b.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
