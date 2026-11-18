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

// ── 局域网发现 ───────────────────────────────────────────────────────────────

const lan = require('../mesh/lan-discovery');

test('lan: 本账号设备的广播被接受，地址取来源 IP + 广播里的端口', () => {
  const { keys, cert } = setup();
  const pkt = lan.buildAnnouncement({ endpointId: 'EP_A', port: 41641, cert });
  const peer = lan.parseAnnouncement(pkt, { address: '192.168.1.20', port: 41700 }, { selfEndpointId: 'EP_SELF', selfUserId: '42', issuerKeys: keys });
  assert.deepEqual(peer, { endpoint_id: 'EP_A', device_id: 'dev-a', name: 'mac-mini', direct_addrs: ['192.168.1.20:41641'] });
});

test('lan: 自己的、别人账号的、乱写的广播都不理', () => {
  const { keys, cert } = setup();
  const opts = { selfEndpointId: 'EP_SELF', selfUserId: '42', issuerKeys: keys };
  const rinfo = { address: '192.168.1.20', port: 41700 };
  assert.equal(lan.parseAnnouncement(lan.buildAnnouncement({ endpointId: 'EP_SELF', port: 1, cert }), rinfo, opts), null);
  assert.equal(lan.parseAnnouncement(lan.buildAnnouncement({ endpointId: 'EP_A', port: 1, cert }), rinfo, { ...opts, selfUserId: '43' }).rejected, 'other_user');
  // 拿别人的证书配上自己的 endpoint_id：证书对不上
  assert.equal(lan.parseAnnouncement(lan.buildAnnouncement({ endpointId: 'EP_EVIL', port: 1, cert }), rinfo, opts).rejected, 'endpoint_mismatch');
  assert.equal(lan.parseAnnouncement(lan.buildAnnouncement({ endpointId: 'EP_A', port: 70000, cert }), rinfo, opts), null);
  assert.equal(lan.parseAnnouncement(Buffer.from('not json'), rinfo, opts), null);
  assert.equal(lan.parseAnnouncement(Buffer.from('{"t":"other"}'), rinfo, opts), null);
});

// ── 点名执行者（/codex@设备）───────────────────────────────────────────────

const designation = require('../agent-designation');

test('designation: 拆出 /名字@设备 和任务', () => {
  assert.deepEqual(designation.parseDesignation('/codex@mini 修一下登录页'), { name: 'codex', device: 'mini', text: '修一下登录页', raw: '/codex@mini' });
  assert.deepEqual(designation.parseDesignation('/写诗专家 写一首秋天'), { name: '写诗专家', device: null, text: '写一首秋天', raw: '/写诗专家' });
  assert.equal(designation.parseDesignation('/codex'), null);            // 没有任务内容
  assert.equal(designation.parseDesignation('修一下 /codex'), null);     // 不在开头
  assert.equal(designation.parseDesignation('/usr/bin/env node 跑一下'), null);
});

const AGENTS = [
  { id: 'claude-code', name: 'Claude Code', type: 'cli', installed: true },
  { id: 'cursor', name: 'Cursor', type: 'cli', installed: false },
  { id: 'assistant:res-poem', name: '写诗专家', type: 'assistant' },
];
const DEVICES = [
  { device_id: 'dev-a', name: 'macbook', self: true, online: true, descriptor: { apps: [{ id: 'claude-code' }] } },
  { device_id: 'dev-b', name: 'mini', online: true, descriptor: { apps: [{ id: 'codex' }, { id: 'claude-code' }] } },
];

test('designation: 本机有就本机，本机没有去我的设备，带 @ 就钉设备', () => {
  const r = (p) => designation.resolveDesignation(p, { agents: AGENTS, devices: DEVICES });
  assert.equal(r('/claude 看看').harnessId, 'claude-code');                 // 简称
  assert.equal(r('/写诗专家 写一首').harnessId, 'assistant:res-poem');        // 专业智能体按名字
  assert.equal(r('/codex 修一下').harnessId, 'mine:codex');                  // 本机没有，其他设备有
  assert.equal(r('/claude-code@mini 修一下').harnessId, 'mine:claude-code@mini');
  assert.equal(r('/claude-code@本机 修一下').harnessId, 'claude-code');
  assert.equal(r('/cursor 改一下'), null);                                   // 本机没装，也没有设备有：不算点名
  assert.equal(r('/nobody 你好'), null);
  assert.equal(r('/codex 修一下').text, '修一下');
});

// ── 设备别名 ─────────────────────────────────────────────────────────────────

const { normalizeAliases, deviceLabel } = require('../mesh/directory');

test('aliases: 校验和去重', () => {
  assert.deepEqual(normalizeAliases([' studio ', 'Studio', '公司']), ['studio', '公司']);
  assert.throws(() => normalizeAliases(['my mini']), /不能有空格/);
  assert.throws(() => normalizeAliases(['a@b']), /不能用/);
  assert.throws(() => normalizeAliases(['本机']), /不能用/);
  assert.equal(deviceLabel({ name: '172.18.0.2 · bf54', descriptor: { aliases: ['studio'] } }), 'studio');
  assert.equal(deviceLabel({ name: 'mini', descriptor: { aliases: [] } }), 'mini');
});

test('aliases: 别名能指定设备，重名时给出原因', () => {
  const target = { kind: 'app', id: 'codex', device: 'studio' };
  const b = dev('b', { name: '172.18.0.2 · bf54', descriptor: { ...dev('b').descriptor, aliases: ['studio'] } });
  assert.equal(scheduler.pickDevice({ target, devices: [dev('a'), b] }).device.device_id, 'b');
  const c = dev('c', { descriptor: { ...dev('c').descriptor, aliases: ['studio'] } });
  assert.match(scheduler.pickDevice({ target, devices: [b, c] }).reason, /2 台设备都叫 studio/);
  const r = designation.resolveDesignation('/codex@studio 修一下', { agents: AGENTS, devices: [{ ...b, descriptor: { ...b.descriptor, apps: [{ id: 'codex' }] } }] });
  assert.equal(r.harnessId, 'mine:codex@studio');
});
