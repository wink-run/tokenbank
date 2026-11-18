'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { FrameStream, memoryPair } = require('../mesh/frames');
const identity = require('../mesh/identity');
const scheduler = require('../mesh/scheduler');
const { Directory, sanitizeDescriptor } = require('../mesh/directory');
const glue = require('../mesh/glue');

// ── 分帧 ──────────────────────────────────────────────────────────────────────

test('frames: JSON 和字节帧按顺序到达，写完后读到 null', async () => {
  const [a, b] = memoryPair();
  const w = new FrameStream(a);
  const r = new FrameStream(b);
  const big = Buffer.alloc(200 * 1024, 3);   // 超过单块大小，会被切开
  await w.writeJson({ t: 'http', path: '/v1/models' });
  await w.writeData(big);
  await w.finish();
  assert.deepEqual(await r.nextJson(), { t: 'http', path: '/v1/models' });
  const got = [];
  for (let f = await r.next(); f; f = await r.next()) got.push(f.value);
  assert.equal(Buffer.concat(got).length, big.length);
  assert.equal(await r.next(), null);
});

// ── 证书 ──────────────────────────────────────────────────────────────────────

function setup() {
  const issuer = identity.generateIssuer();
  const keys = [issuer.publicKey];
  const cert = identity.issueCert(issuer, { sub: '42', device_id: 'dev-a', endpoint_id: 'EP_A', name: 'mac-mini' });
  return { issuer, keys, cert };
}

test('identity: 本人、签名正确、endpoint 对得上才放行', () => {
  const { keys, cert } = setup();
  const ok = identity.checkPeer(cert, { issuerKeys: keys, remoteEndpointId: 'EP_A', selfUserId: '42' });
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.device_id, 'dev-a');
  assert.equal(ok.claims.scope, 'self');
  assert.deepEqual(ok.claims.circles, []);
});

test('identity: 各种不该放行的情况', () => {
  const { issuer, keys, cert } = setup();
  const base = { issuerKeys: keys, remoteEndpointId: 'EP_A', selfUserId: '42' };
  assert.equal(identity.checkPeer(cert, { ...base, selfUserId: '43' }).reason, 'other_user');
  assert.equal(identity.checkPeer(cert, { ...base, remoteEndpointId: 'EP_B' }).reason, 'endpoint_mismatch');
  assert.equal(identity.checkPeer(cert, { ...base, revoked: new Set(['dev-a']) }).reason, 'revoked');
  assert.equal(identity.checkPeer(cert, { ...base, issuerKeys: [identity.generateIssuer().publicKey] }).reason, 'unknown_issuer');
  const expired = identity.issueCert(issuer, { sub: '42', device_id: 'dev-a', endpoint_id: 'EP_A', ttlSec: 1 }, 1000);
  assert.equal(identity.checkPeer(expired, base).reason, 'expired');
  const circle = identity.issueCert(issuer, { sub: '42', device_id: 'dev-a', endpoint_id: 'EP_A', scope: 'circle', circles: [7] });
  assert.equal(identity.checkPeer(circle, base).reason, 'unknown_scope');
  const parts = cert.split('.');
  const forged = `${parts[0]}.${identity._internal.b64url(JSON.stringify({ ...JSON.parse(identity._internal.fromB64url(parts[1])), sub: '99' }))}.${parts[2]}`;
  assert.equal(identity.checkPeer(forged, { ...base, selfUserId: '99' }).reason, 'bad_signature');
  assert.equal(identity.checkPeer('garbage', base).reason, 'malformed');
});

// ── 调度 ──────────────────────────────────────────────────────────────────────

test('scheduler: 解析 mine: 写法', () => {
  assert.deepEqual(scheduler.parseMineHarness('mine:codex'), { kind: 'app', id: 'codex', device: null });
  assert.deepEqual(scheduler.parseMineHarness('mine:codex@mac-mini'), { kind: 'app', id: 'codex', device: 'mac-mini' });
  assert.deepEqual(scheduler.parseMineHarness('mine:assistant:res-1@mini'), { kind: 'assistant', id: 'assistant:res-1', device: 'mini' });
  assert.equal(scheduler.parseMineHarness('codex'), null);
  assert.deepEqual(scheduler.parseMineModel('mine:mac-mini/qwen3-32b'), { device: 'mac-mini', model: 'qwen3-32b' });
  assert.equal(scheduler.parseMineModel('qwen3-32b'), null);
});

function dev(id, extra = {}) {
  return {
    device_id: id, name: id, online: true, self: false,
    descriptor: { apps: [{ id: 'codex' }], workspaces: [{ name: 'tb' }], load: { running: 0, max: 2 }, models: [] },
    path: { kind: 'direct', rttMs: 5 },
    ...extra,
  };
}

test('scheduler: 排序 本机 > 优先级 > 负载 > 直连 > 延迟', () => {
  const target = { kind: 'app', id: 'codex' };
  const self = dev('self', { self: true });
  const a = dev('a');
  const b = dev('b', { path: { kind: 'relay', rttMs: 1 } });
  assert.equal(scheduler.pickDevice({ target, devices: [a, b, self] }).device.device_id, 'self');
  assert.equal(scheduler.pickDevice({ target, devices: [b, a] }).device.device_id, 'a');           // 直连优先
  assert.equal(scheduler.pickDevice({ target, devices: [a, b], priorities: { b: 5 } }).device.device_id, 'b');
  const busyA = dev('a', { descriptor: { ...a.descriptor, load: { running: 1, max: 2 } } });
  const c = dev('c', { path: { kind: 'direct', rttMs: 50 } });
  assert.equal(scheduler.pickDevice({ target, devices: [busyA, c] }).device.device_id, 'c');      // 负载低的
});

test('scheduler: 失败时给出原因', () => {
  const target = { kind: 'app', id: 'codex' };
  assert.match(scheduler.pickDevice({ target: { ...target, device: 'x' }, devices: [dev('a')] }).reason, /没有叫 x/);
  assert.match(scheduler.pickDevice({ target: { ...target, device: 'a' }, devices: [dev('a', { online: false })] }).reason, /离线/);
  assert.match(scheduler.pickDevice({ target: { kind: 'app', id: 'cursor' }, devices: [dev('a')] }).reason, /没有在线设备装了 cursor/);
  assert.match(scheduler.pickDevice({ target, workspace: 'nope', devices: [dev('a')] }).reason, /没有设备配了工作区 nope/);
  const full = dev('a', { descriptor: { ...dev('a').descriptor, load: { running: 2, max: 2 } } });
  assert.match(scheduler.pickDevice({ target, devices: [full] }).reason, /满负载/);
});

// ── 目录 ──────────────────────────────────────────────────────────────────────

test('directory: 描述里不能出现本机路径', () => {
  assert.throws(() => sanitizeDescriptor({ device_id: 'd', workspaces: [{ name: '/Users/me/code' }] }), /本机路径/);
  assert.throws(() => sanitizeDescriptor({ device_id: 'd', sessions: [{ title: 'fix ~/code/x' }] }), /本机路径/);
  const ok = sanitizeDescriptor({ device_id: 'd', name: 'mini', secret: 'x', workspaces: [{ name: 'tb', path: 'ignored' }] });
  assert.equal(ok.secret, undefined);
  assert.equal(ok.workspaces[0].path, undefined);
});

test('directory: 旧 seq 丢弃，断线保留最后一次描述', () => {
  const d = new Directory();
  assert.equal(d.applyPresence({ endpoint_id: 'E' }, { device_id: 'x', name: 'x', seq: 2 }), true);
  assert.equal(d.applyPresence({ endpoint_id: 'E' }, { device_id: 'x', name: 'x', seq: 1 }), false);
  d.markOffline('x');
  assert.equal(d.get('x').online, false);
  assert.equal(d.get('x').descriptor.seq, 2);
  // 重连后同样的 seq 也接受
  assert.equal(d.applyPresence({ endpoint_id: 'E' }, { device_id: 'x', name: 'x', seq: 2 }), true);
});

// ── 任务号改写 ───────────────────────────────────────────────────────────────

test('glue: 远端任务号改写成 mesh:<设备>:<任务号>，SSE 跨块也能改', () => {
  const { sseRewriter, parseMeshTaskId } = glue._internal;
  const rw = sseRewriter('dev-b', 'mini');
  const line = `event: response.completed\ndata: ${JSON.stringify({ id: 't1', object: 'response', metadata: {} })}\n\n`;
  const out = Buffer.concat([rw(Buffer.from(line.slice(0, 30))), rw(Buffer.from(line.slice(30))), rw.flush() || Buffer.alloc(0)]).toString();
  const data = JSON.parse(out.split('\n').find((l) => l.startsWith('data: ')).slice(6));
  assert.equal(data.id, 'mesh:dev-b:t1');
  assert.equal(data.metadata.mesh_device, 'mini');
  assert.deepEqual(parseMeshTaskId('mesh:dev-b:t1'), { deviceId: 'dev-b', id: 't1' });
  assert.equal(parseMeshTaskId('t1'), null);
});
