// 设备通道：密钥、端到端加密、中继（同一份代码跑在 app 里和官方中继）、经中继的一次 HTTP 请求
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const keys = require('../mesh/keys');
const identity = require('../mesh/identity');
const { startRelayServer } = require('../mesh/relay-server');
const { MeshNode } = require('../mesh/node');

test('设备密钥：签名可验，换了内容或公钥就不通过', () => {
  const k = keys.deviceKey(Buffer.alloc(32, 7));
  assert.match(k.endpointId, /^[0-9a-f]{64}$/);
  const sig = keys.sign(k.privateKey, 'tb-mesh-register|abc');
  assert.ok(keys.verify(k.endpointId, 'tb-mesh-register|abc', sig));
  assert.ok(!keys.verify(k.endpointId, 'tb-mesh-register|abd', sig));
  assert.ok(!keys.verify(keys.deviceKey(Buffer.alloc(32, 8)).endpointId, 'tb-mesh-register|abc', sig));
  assert.ok(!keys.verify('zz', 'x', sig));
});

test('端到端会话：两边算出对应的密钥，改过的密文打不开', () => {
  const a = keys.ephemeral();
  const b = keys.ephemeral();
  const ka = keys.sessionKeys({ privateKey: a.privateKey, myPub: a.pub, peerPub: b.pub, sid: 's1', initiator: true });
  const kb = keys.sessionKeys({ privateKey: b.privateKey, myPub: b.pub, peerPub: a.pub, sid: 's1', initiator: false });
  assert.ok(ka.send.equals(kb.recv) && ka.recv.equals(kb.send));
  assert.ok(!ka.send.equals(ka.recv));
  const box = keys.seal(ka.send, 1, { hi: '你好' });
  assert.ok(!box.c.includes('你好'));
  assert.deepStrictEqual(keys.open(kb.recv, 1, box.c), { hi: '你好' });
  assert.strictEqual(keys.open(kb.recv, 2, box.c), null, '计数器不对');
  const bad = Buffer.from(box.c, 'base64url'); bad[0] ^= 1;
  assert.strictEqual(keys.open(kb.recv, 1, bad.toString('base64url')), null, '被改过');
});

// ── 起一个官方中继和几台只连中继的设备 ────────────────────────────────────────
const issuer = identity.generateIssuer();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mesh-relay-test-'));

function device(name, deviceId, userId) {
  const dir = path.join(tmp, name);
  const secret = identity.loadOrCreateDeviceSecret(dir);
  const cert = identity.issueCert(issuer, { sub: userId, device_id: deviceId, endpoint_id: keys.endpointIdFromSecret(secret), name });
  return { dir, cert, key: keys.deviceKey(secret), userId };
}

function register(url, dev) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const seen = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      seen.push(m);
      if (m.type === 'challenge') ws.send(JSON.stringify({ type: 'register', proto: 1, cert: dev.cert, sig: keys.sign(dev.key.privateKey, `tb-mesh-register|${m.nonce}`) }));
      if (m.type === 'registered' || m.type === 'error') resolve({ ws, msg: m, seen });
    });
    ws.on('error', () => resolve({ ws, msg: { type: 'error', message: 'socket' }, seen }));
  });
}

test('中继：要设备密钥签名；只在同一账号的设备之间转发', async () => {
  const relay = await startRelayServer({ port: 0, host: '127.0.0.1', issuerKeys: [issuer.publicKey], log: () => {} });
  const url = `ws://127.0.0.1:${relay.port}/mesh/ws`;
  try {
    const a = device('ra', 'r-a', '1');
    const b = device('rb', 'r-b', '1');
    const x = device('rx', 'r-x', '2');
    // 拿别人的证书、自己的密钥签：不通过
    const forged = await register(url, { ...a, key: x.key });
    assert.deepStrictEqual([forged.msg.type, forged.msg.message], ['error', 'bad_signature']);

    const ca = await register(url, a);
    assert.strictEqual(ca.msg.type, 'registered');
    const got = new Promise((r) => ca.ws.on('message', (raw) => { const m = JSON.parse(raw.toString()); if (m.type === 'relay') r(m); }));
    const cb = await register(url, b);
    const cx = await register(url, x);
    cb.ws.send(JSON.stringify({ type: 'relay', to: 'r-a', data: { t: 'box', c: 'xyz' } }));
    const m = await got;
    assert.deepStrictEqual([m.from, m.data.c], ['r-b', 'xyz']);
    const offline = new Promise((r) => cx.ws.on('message', (raw) => { const v = JSON.parse(raw.toString()); if (v.type === 'peer_offline') r(v); }));
    cx.ws.send(JSON.stringify({ type: 'relay', to: 'r-a', data: {} }));
    assert.strictEqual((await offline).to, 'r-a', '别的账号到不了');
    assert.deepStrictEqual(relay.hub.status('1').pairs.map((p) => [p.a, p.b]), [['r-a', 'r-b']]);
    for (const c of [ca, cb, cx, forged]) c.ws.close();
  } finally {
    await relay.close();
  }
});

test('两台只连官方中继的设备：握手、交换描述，经中继转一次 HTTP 请求，中继只看到密文', async () => {
  const dump = path.join(tmp, 'relay.dump');
  const relay = await startRelayServer({ port: 0, host: '127.0.0.1', issuerKeys: [issuer.publicKey], dumpFile: dump, log: () => {} });
  const gw = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, from: req.headers['x-tb-mesh-from'], body: Buffer.concat(parts).toString() }));
    });
  });
  await new Promise((r) => gw.listen(0, '127.0.0.1', r));
  const mk = (dev) => new MeshNode({
    dir: dev.dir, userId: dev.userId, cert: dev.cert, issuerKeys: [issuer.publicKey], listen: false, lanDiscovery: false,
    relayUrls: [`ws://127.0.0.1:${relay.port}/mesh/ws`], gatewayPort: gw.address().port, presenceMs: 300,
    describeSelf: async () => ({ models: ['m1'] }), log: () => {},
  });
  const na = mk(device('na', 'n-a', '7'));
  const nb = mk(device('nb', 'n-b', '7'));
  try {
    await na.start();
    await nb.start();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !(na.directory.get('n-b')?.online && nb.directory.get('n-a')?.online)) await new Promise((r) => setTimeout(r, 100));
    assert.ok(na.directory.get('n-b')?.online, 'A 看到 B 在线');
    assert.deepStrictEqual(na.directory.get('n-b').path.relay_kind, 'official');
    const secret = 'PLAINTEXT-PROMPT-42';
    const r = await na.proxy('n-b', { method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' }, body: Buffer.from(secret) });
    const parts = [];
    for await (const c of r.chunks) parts.push(c);
    const j = JSON.parse(Buffer.concat(parts).toString());
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual([j.path, j.from, j.body], ['/v1/chat/completions', 'n-a', secret]);
    const seen = fs.readFileSync(dump, 'utf8');
    assert.ok(seen.length > 0 && !seen.includes(secret) && !seen.includes('/v1/chat'), '中继看不到明文');
    await assert.rejects(() => na.proxy('n-zzz', { method: 'GET', path: '/' }), /离线/);
  } finally {
    await na.stop();
    await nb.stop();
    gw.close();
    await relay.close();
  }
});
