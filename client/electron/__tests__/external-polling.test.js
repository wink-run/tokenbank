'use strict';
// 轮询要花外部智能体的 token：Webhook 通就不轮询；轮询时空闲自动放慢、回答尽量短、能只看不取
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ext-poll-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const ext = require('../external-agents');
const agentHttp = require('../agent-http');

const hooks = [];
let hookServer;
let api;
let apiBase;
test.before(async () => {
  hookServer = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => { hooks.push(JSON.parse(Buffer.concat(parts).toString() || '{}')); res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  api = http.createServer((req, res) => {
    const cleanPath = new URL(req.url, 'http://x').pathname;
    agentHttp.handle(req, res, { method: req.method, cleanPath, knownKey: () => false });
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  apiBase = `http://127.0.0.1:${api.address().port}`;
});
test.after(() => { ext._internal.reset(); hookServer.close(); api.close(); });

const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

function newAgent(name) {
  const { code } = ext.newPairingCode();
  const reg = ext.register({ code, name });
  ext.approve(reg.agent_id);
  return reg;
}

function backdate(id, field, ms) {
  const file = ext._internal.file();
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = d.agents.find((x) => x.id === id);
  a[field] = Date.now() - ms;
  fs.writeFileSync(file, JSON.stringify(d));
}

test('空闲越久轮询越慢，一派任务就恢复；等它来取的时间不算进超时', async () => {
  const { agent_id: id } = newAgent('Idle Bot');
  assert.deepEqual(ext.pollPlan(JSON.parse(fs.readFileSync(ext._internal.file(), 'utf8')).agents.find((x) => x.id === id)).intervalSec, 300);
  backdate(id, 'createdAt', 3 * 3600 * 1000);
  assert.equal(ext.get(id).pollIntervalSec, 15 * 60);
  assert.equal(ext.get(id).pollSlowed, true);
  backdate(id, 'createdAt', 30 * 3600 * 1000);
  assert.equal(ext.get(id).pollIntervalSec, 60 * 60);
  ext.dispatch(id, '做点事', { timeoutMs: 1000 });
  const rec = JSON.parse(fs.readFileSync(ext._internal.tasksFile(), 'utf8')).tasks.find((t) => t.agentId === id);
  assert.ok(rec.deadline - rec.createdAt >= 1000 + 3600 * 1000, '它一小时来一次：超时加上这一小时');
  assert.equal(ext.get(id).pollIntervalSec, 300, '派过任务就恢复');
  assert.equal(ext.get(id).pollSlowed, false);
});

test('Webhook 通：不轮询，算在线；批准时用 Webhook 叫醒它，不用它来看', async () => {
  const { code } = ext.newPairingCode();
  const reg = ext.register({ code, name: 'Hook Bot' });
  ext.setWebhook(reg.agent_id, { url: `http://127.0.0.1:${hookServer.address().port}/h`, secret: 's' });
  assert.equal(ext.get(reg.agent_id).receive, 'webhook');
  assert.equal(ext.get(reg.agent_id).pollIntervalSec, 0);
  hooks.length = 0;
  ext.approve(reg.agent_id);
  assert.ok(await waitFor(() => hooks.some((h) => h.event === 'tokenbank.status_active')));
  assert.equal(ext.get(reg.agent_id).online, true, 'Webhook 叫得醒就算在线，不靠轮询心跳');
});

test('HTTP：取任务的回答带 poll；peek 只看不取；版本一样时不带 skill_url', async () => {
  const { agent_id: id, token } = newAgent('Peek Bot');
  const get = async (p) => (await fetch(`${apiBase}${p}`, { headers: { authorization: `Bearer ${token}` } })).json();
  const version = ext.skillInfo().version;
  const empty = await get(`/v1/agent/external/tasks?wait=0&skill_version=${version}`);
  assert.deepEqual(Object.keys(empty).sort(), ['interval', 'poll', 'skill_version', 'status', 'task']);
  assert.equal(empty.poll, true);
  assert.equal(empty.interval, 300);
  const old = await get('/v1/agent/external/tasks?wait=0&skill_version=old');
  assert.ok(old.skill_url, '版本不一样才给下载地址');
  ext.dispatch(id, '看一眼', { timeoutMs: 5000 });
  const peek = await get(`/v1/agent/external/tasks/peek?skill_version=${version}`);
  assert.equal(peek.queued, 1);
  assert.equal(peek.poll, true);
  const again = await get('/v1/agent/external/tasks/peek');
  assert.equal(again.queued, 1, 'peek 不取走');
  const took = await get(`/v1/agent/external/tasks?wait=0&skill_version=${version}`);
  assert.equal(took.task.input, '看一眼');
});
