// 雇佣走设备通道：凭雇佣票跨账号、端到端加密、出租方只认票上的任务
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const keys = require('../mesh/keys');
const identity = require('../mesh/identity');
const { startRelayServer } = require('../mesh/relay-server');
const { MeshNode } = require('../mesh/node');

const issuer = identity.generateIssuer();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mesh-hire-test-'));

function device(name, deviceId, userId) {
  const dir = path.join(tmp, name);
  const secret = identity.loadOrCreateDeviceSecret(dir);
  const endpointId = keys.endpointIdFromSecret(secret);
  const cert = identity.issueCert(issuer, { sub: userId, device_id: deviceId, endpoint_id: endpointId, name });
  return { dir, cert, userId, deviceId, endpointId };
}

const wait = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

async function setup() {
  const dump = path.join(tmp, `dump-${Date.now()}`);
  const relay = await startRelayServer({ port: 0, host: '127.0.0.1', issuerKeys: [issuer.publicKey], dumpFile: dump, log: () => {} });
  const mk = (dev) => new MeshNode({
    dir: dev.dir, userId: dev.userId, cert: dev.cert, issuerKeys: [issuer.publicKey], listen: false, lanDiscovery: false,
    relayUrls: [`ws://127.0.0.1:${relay.port}/mesh/ws`], gatewayPort: 1, presenceMs: 300, describeSelf: async () => ({}), log: () => {},
  });
  const H = device(`h${Date.now()}`, 'hirer-dev', '100');
  const W = device(`w${Date.now()}`, 'worker-dev', '200');
  const hirer = mk(H);
  const worker = mk(W);
  await hirer.start();
  await worker.start();
  await wait(() => hirer.official && worker.official);
  const ticket = (over = {}) => identity.issueHireTicket(issuer, {
    tid: 'at-1', aid: 'claude-code', sub: H.userId, hd: H.deviceId, he: H.endpointId,
    wu: W.userId, wd: W.deviceId, we: W.endpointId, ck: 'u:100', ...over,
  });
  return { relay, dump, hirer, worker, H, W, ticket, close: async () => { await hirer.stop(); await worker.stop(); await relay.close(); } };
}

test('凭票雇佣：任务号、智能体、隔离键取自票；进度和结果原路回来；中继只看到密文', async () => {
  const t = await setup();
  try {
    const got = [];
    t.worker.hire.on('task', ({ task, send }) => {
      got.push(task);
      send({ type: 'agent_task_progress', text: '做到一半' });
      send({ type: 'agent_task_result', status: 'completed', output: `完成：${task.prompt}` });
    });
    const events = [];
    const r = await t.hirer.hire.run({
      ticket: t.ticket(),
      task: { prompt: 'SECRET-PROMPT 改一下首页', task_id: 'at-forged', assistant_id: 'other-agent' },
      onEvent: (m) => events.push(m.type),
    });
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.output, '完成：SECRET-PROMPT 改一下首页');
    assert.deepStrictEqual(events, ['agent_task_progress', 'agent_task_result']);
    assert.strictEqual(got.length, 1);
    assert.deepStrictEqual([got[0].task_id, got[0].assistant_id, got[0].consumer_key, got[0].call_context], ['at-1', 'claude-code', 'u:100', 'hired']);
    const seen = fs.readFileSync(t.dump, 'utf8');
    assert.ok(seen.length > 0 && !seen.includes('SECRET-PROMPT') && !seen.includes('完成'), '中继看不到明文');
    // 同一张票只做一单
    const again = t.hirer.hire.run({ ticket: t.ticket(), task: { prompt: 'x' }, timeoutMs: 800 });
    await assert.rejects(again, /时限/);
    assert.strictEqual(got.length, 1);
  } finally { await t.close(); }
});

test('票不是签给这台雇佣设备的、没有票：中继不转，出租方收不到', async () => {
  const t = await setup();
  try {
    let tasks = 0;
    t.worker.hire.on('task', () => { tasks += 1; });
    await assert.rejects(() => t.hirer.hire.run({ ticket: t.ticket({ hd: 'someone-else' }), task: { prompt: 'x' } }), /不是签给这台设备/);
    // 票上的出租方公钥对不上（比如出租方换过密钥）：中继不放行
    await assert.rejects(() => t.hirer.hire.run({ ticket: t.ticket({ tid: 'at-2', we: 'ab'.repeat(32) }), task: { prompt: 'x' } }), /没有回应|不在线/);
    // 不带票直接发：中继回 peer_offline
    t.hirer.official.send(t.W.deviceId, { t: 'hello' }, { to_user: t.W.userId });
    await new Promise((r) => setTimeout(r, 300));
    // 伪造签名的票
    const forged = identity.issueHireTicket(identity.generateIssuer(), { tid: 'at-3', aid: 'a', sub: '100', hd: 'hirer-dev', he: t.H.endpointId, wu: '200', wd: 'worker-dev', we: t.W.endpointId });
    await assert.rejects(() => t.hirer.hire.run({ ticket: forged, task: { prompt: 'x' } }), /雇佣票无效/);
    assert.strictEqual(tasks, 0);
  } finally { await t.close(); }
});

test('雇来的连接上发 http_request（想当本人用本机网关）：不认', async () => {
  const t = await setup();
  try {
    let tasks = 0;
    t.worker.hire.on('task', () => { tasks += 1; });
    const c = identity.verifyHireTicket(t.ticket(), [issuer.publicKey]).claims;
    const key = `${c.wu}:${c.wd}`;
    await t.hirer.hire._handshake(key, c, t.ticket());
    let served = 0;
    const orig = t.worker._serve.bind(t.worker);
    t.worker._serve = (...a) => { served += 1; return orig(...a); };
    t.hirer.hire._sendBox(key, { type: 'http_request', req_id: 'r1', method: 'GET', path: '/v1/models', headers: {}, body: '' });
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(served, 0);
    assert.strictEqual(tasks, 0);
    // 雇佣方的设备不会出现在出租方的「我的设备」里
    assert.ok(!t.worker.directory.get('hirer-dev'));
  } finally { await t.close(); }
});
