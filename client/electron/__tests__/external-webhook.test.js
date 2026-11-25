'use strict';
// 外部智能体的 Webhook 唤醒：有新任务时网关主动 POST 一条通知，叫它来取（不带任务内容和凭据）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ext-webhook-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const ext = require('../external-agents');

const hits = [];
let reply = 200;
let server;
let base;
test.before(async () => {
  server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      hits.push({ auth: req.headers.authorization || '', ua: req.headers['user-agent'], body: JSON.parse(Buffer.concat(parts).toString() || '{}') });
      res.writeHead(reply); res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { ext._internal.reset(); server.close(); });

const wait = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

function newAgent(name) {
  const { code } = ext.newPairingCode();
  const reg = ext.register({ code, name });
  ext.approve(reg.agent_id);
  return reg;
}

test('派任务时叫醒它：带 Bearer 密钥，通知里没有任务内容；几个任务合成一次', async () => {
  const { agent_id: id } = newAgent('GrokBot');
  ext.setWebhook(id, { url: `${base}/hook`, secret: 'Bearer s3cret' });   // 整行贴进来也认
  hits.length = 0;
  const a = ext.dispatch(id, 'SECRET-PROMPT 写一条推文', { timeoutMs: 20000 });
  const b = ext.dispatch(id, '第二件', { timeoutMs: 20000 });
  assert.ok(await wait(() => hits.length >= 1));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hits.length, 1, '两个任务只叫一次');
  assert.equal(hits[0].auth, 'Bearer s3cret');
  assert.equal(hits[0].ua, 'TokenBank-Gateway');
  assert.deepEqual(Object.keys(hits[0].body).sort(), ['agent_id', 'event', 'queued', 'sent_at']);
  assert.equal(hits[0].body.event, 'tokenbank.task_queued');
  assert.equal(hits[0].body.queued, 2);
  assert.ok(!JSON.stringify(hits[0]).includes('SECRET-PROMPT'));
  // 它取一个、做完；还有排队的，再叫一次
  const t1 = await ext.pull(id, 0);
  ext.complete(id, t1.id, { output: 'done' });
  assert.ok(await wait(() => hits.length >= 2));
  assert.equal(hits[1].body.queued, 1);
  const t2 = await ext.pull(id, 0);
  ext.complete(id, t2.id, { output: 'done' });
  await Promise.all([a, b]);
  const v = ext.get(id).webhook;
  assert.equal(v.sent, 2);
  assert.equal(v.hasSecret, true);
  assert.equal(v.secretTail, 'cret');
  assert.ok(!JSON.stringify(ext.list()).includes('s3cret'), '列表里不带密钥');
});

test('它正在长轮询等着：任务直接给它，不发通知；没设 Webhook 的不发', async () => {
  const { agent_id: id } = newAgent('Poller');
  ext.setWebhook(id, { url: `${base}/hook` });
  hits.length = 0;
  const pulling = ext.pull(id, 2000);
  const done = ext.dispatch(id, 'x', { timeoutMs: 5000 });
  const task = await pulling;
  ext.complete(id, task.id, { output: 'ok' });
  await done;
  const { agent_id: plain } = newAgent('Plain');
  const p2 = ext.dispatch(plain, 'y', { timeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(hits.length, 0);
  const t = await ext.pull(plain, 0);
  ext.complete(plain, t.id, { output: 'ok' });
  await p2;
});

test('对方拒绝或连不上：记下原因并重试；任务被轮询取走后就不再发', async () => {
  const { agent_id: id } = newAgent('Flaky');
  ext.setWebhook(id, { url: `${base}/hook`, secret: 'wrong' });
  const orig = [...ext._internal.WEBHOOK_RETRY_MS];
  ext._internal.WEBHOOK_RETRY_MS.splice(0, 3, 300, 300, 300);
  hits.length = 0;
  reply = 401;
  try {
    const done = ext.dispatch(id, 'z', { timeoutMs: 20000 });
    assert.ok(await wait(() => hits.length >= 2), '失败后重试');
    assert.match(ext.get(id).webhook.lastError.message, /401.*密钥/);
    const t = await ext.pull(id, 0);   // 轮询兜底取走了
    const n = hits.length;
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(hits.length, n, '取走后不再发');
    ext.complete(id, t.id, { output: 'ok' });
    await done;
  } finally {
    reply = 200;
    ext._internal.WEBHOOK_RETRY_MS.splice(0, 3, ...orig);
  }
});

test('测试通知、清除；外部智能体自己设时只认 https', async () => {
  const { agent_id: id } = newAgent('Tester');
  ext.setWebhook(id, { url: `${base}/hook`, secret: 'k' });
  hits.length = 0;
  const r = await ext.testWebhook(id);
  assert.equal(r.ok, true);
  assert.equal(hits[0].body.event, 'tokenbank.test');
  assert.throws(() => ext.setWebhook(id, { url: `${base}/hook`, fromAgent: true }), /https/);
  assert.throws(() => ext.setWebhook(id, { url: 'http://example.com/h' }), /https/);
  ext.setWebhook(id, { url: 'https://example.com/h', fromAgent: true });
  assert.equal(ext.get(id).webhook.hasSecret, true, '密钥留空沿用原来的');
  ext.setWebhook(id, { clear: true });
  assert.equal(ext.get(id).webhook, null);
});

test('注册时带上 Webhook：自动写入并发测试；通了就不轮询，不通自动回到轮询', async () => {
  hits.length = 0;
  const { code } = ext.newPairingCode();
  // 外部智能体自己写入只认 https：测试里把本机地址当 https 不行，先看格式不对时注册照样成功
  const bad = ext.register({ code, name: 'NoHook', webhook: { url: 'http://127.0.0.1:1/x' } });
  assert.equal(bad.status, 'pending');
  assert.match(bad.webhook_error, /https/);
  ext.approve(bad.agent_id);
  assert.equal(ext.get(bad.agent_id).webhook, null);
  assert.equal(ext.get(bad.agent_id).pollIntervalSec, 300, '没有 Webhook：照常 5 分钟轮询');

  // 用网关页的方式写入本机接收端，模拟「写入后发测试」
  const { agent_id: id } = newAgent('AutoHook');
  ext.setWebhook(id, { url: `${base}/hook`, secret: 'k1' });
  assert.equal(ext.get(id).pollIntervalSec, 0, '设了、还没失败过：不轮询');
  assert.equal(ext.get(id).receive, 'webhook');
  assert.equal((await ext.testWebhook(id)).ok, true);
  assert.equal(ext.get(id).webhook.healthy, true);
  // 对方开始拒绝：记下失败，改回短间隔
  reply = 403;
  try {
    assert.equal((await ext.testWebhook(id)).ok, false);
    const v = ext.get(id);
    assert.equal(v.webhook.healthy, false);
    assert.equal(v.pollIntervalSec, 300, 'Webhook 不通：退回正常轮询');
  } finally { reply = 200; }
  // 又通了：恢复兜底间隔
  assert.equal((await ext.testWebhook(id)).ok, true);
  assert.equal(ext.get(id).pollIntervalSec, 0);
  ext.setWebhook(id, { clear: true });
});

test('它要用 Webhook 但拿不到地址：注册时说明，网关页提醒你填；填好后就用 Webhook', async () => {
  const { code } = ext.newPairingCode();
  const reg = ext.register({ code, name: 'CursorBot', webhook: { manual: true } });
  assert.equal(reg.webhook_waiting_user, true);
  ext.approve(reg.agent_id);
  let v = ext.get(reg.agent_id);
  assert.equal(v.webhookWanted, true, '网关页提醒你填');
  assert.equal(v.pollIntervalSec, 300, '填好之前先轮询');
  // 用户在网关页填好
  ext.setWebhook(reg.agent_id, { url: `${base}/hook`, secret: 'k' });
  v = ext.get(reg.agent_id);
  assert.equal(v.webhookWanted, false);
  assert.equal(v.webhook.by, 'user');
  assert.equal(v.pollIntervalSec, 0);
  // 已经注册过的，也可以之后再说明
  const { agent_id: later } = newAgent('Later');
  ext.setWebhook(later, { manual: true, fromAgent: true });
  assert.equal(ext.get(later).webhookWanted, true);
  ext.setWebhook(later, { clear: true });
  assert.equal(ext.get(later).webhookWanted, false, '取消后不再提醒');
});

test('手动配好 Webhook 后马上通知它：tokenbank.webhook_configured，不带任务内容', async () => {
  const { code } = ext.newPairingCode();
  const reg = ext.register({ code, name: 'NeedsUser', webhook: { manual: true } });
  ext.approve(reg.agent_id);
  hits.length = 0;
  ext.setWebhook(reg.agent_id, { url: `${base}/hook`, secret: 'sec9' });
  const r = await ext.notifyWebhookConfigured(reg.agent_id);
  assert.equal(r.ok, true);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].body.event, 'tokenbank.webhook_configured');
  assert.equal(hits[0].auth, 'Bearer sec9');
  assert.deepEqual(Object.keys(hits[0].body).sort(), ['agent_id', 'event', 'queued', 'sent_at']);
  const v = ext.get(reg.agent_id);
  assert.equal(v.webhookWanted, false);
  assert.equal(v.webhook.healthy, true);
  assert.equal(v.pollIntervalSec, 0, '通知发通了：不再轮询');
});
