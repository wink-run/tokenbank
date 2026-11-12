'use strict';
// 外部智能体：配对码注册 → 等允许 → 取任务 → 回传结果
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ext-agents-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const ext = require('../external-agents');

test('a pairing code registers once, as pending, and nothing is dispatched until approved', async () => {
  const { code } = ext.newPairingCode();
  assert.match(code, /^TB-\d{4}$/);
  const reg = ext.register({ code, name: 'Muse', description: '画图、做海报' });
  assert.equal(reg.agent_id, 'external:muse');
  assert.equal(reg.status, 'pending');
  assert.match(reg.token, /^tbx_/);
  assert.throws(() => ext.register({ code, name: 'Again' }), /配对码不对或已过期/);
  assert.equal(ext.listForAgents().length, 0);
  const r = await ext.dispatch('external:muse', 'hi', { timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /还没允许/);
  // token 不会出现在给界面看的列表里
  assert.equal(JSON.stringify(ext.list()).includes(reg.token), false);
});

test('after approval the agent pulls the task and its result comes back', async () => {
  const token = (() => { const { code } = ext.newPairingCode(); return ext.register({ code, name: 'GrokBot' }).token; })();
  ext.approve('external:grokbot');
  const me = ext.authenticate(token);
  assert.equal(me.id, 'external:grokbot');
  assert.equal(ext.get('external:grokbot').online, true);
  const waiting = ext.dispatch('external:grokbot', '写一条推文', { timeoutMs: 5000 });
  const task = await ext.pull('external:grokbot', 1000);
  assert.equal(task.prompt, '写一条推文');
  assert.ok(ext.complete('external:grokbot', task.id, { output: '好的，推文如下' }));
  assert.deepEqual(await waiting, { ok: true, output: '好的，推文如下' });
});

test('a waiting pull receives a task dispatched later', async () => {
  const pulling = ext.pull('external:grokbot', 3000);
  const waiting = ext.dispatch('external:grokbot', '第二件事', { timeoutMs: 5000 });
  const task = await pulling;
  assert.equal(task.prompt, '第二件事');
  ext.complete('external:grokbot', task.id, { error: '做不了' });
  const r = await waiting;
  assert.equal(r.ok, false);
  assert.equal(r.error, '做不了');
});

test('disabling fails queued tasks; a wrong token is not recognised', async () => {
  const waiting = ext.dispatch('external:grokbot', '排队中', { timeoutMs: 5000 });
  ext.disable('external:grokbot');
  const r = await waiting;
  assert.equal(r.ok, false);
  assert.match(r.error, /停用/);
  assert.equal(ext.authenticate('tbx_wrong'), null);
  assert.ok(ext.remove('external:grokbot'));
  assert.equal(ext.get('external:grokbot'), null);
});

test('online until two heartbeats are missed, using the observed pull interval', () => {
  const { code } = ext.newPairingCode();
  const { token } = ext.register({ code, name: 'Cron' });
  ext.approve('external:cron');
  const t0 = 1_000_000_000_000;
  const MIN = 60 * 1000;
  // 每 5 分钟来取一次
  for (let i = 0; i < 3; i++) ext.authenticate(token, t0 + i * 5 * MIN, { heartbeat: true });
  const a = JSON.parse(fs.readFileSync(ext._internal.file(), 'utf8')).agents.find(x => x.id === 'external:cron');
  const last = t0 + 10 * MIN;
  assert.equal(ext.isOnline(a, last + 4 * MIN), true, 'a gap shorter than one interval is not offline');
  assert.equal(ext.isOnline(a, last + 9 * MIN), true, 'one missed heartbeat is still online');
  assert.equal(ext.isOnline(a, last + 11 * MIN), false, 'two missed heartbeats → offline');
  // 自己报了间隔的按报的算
  ext.authenticate(token, last + 12 * MIN, { heartbeat: true, intervalSec: 1800 });
  const b = JSON.parse(fs.readFileSync(ext._internal.file(), 'utf8')).agents.find(x => x.id === 'external:cron');
  assert.equal(ext.isOnline(b, last + 12 * MIN + 50 * MIN), true);
  assert.equal(ext.isOnline(b, last + 12 * MIN + 61 * MIN), false);
});

test('after an app restart, queued tasks are still delivered and late results are recorded', async () => {
  const { code } = ext.newPairingCode();
  ext.register({ code, name: 'Later' });
  ext.approve('external:later');
  // 派两件：一件被取走，一件还在排队；然后「重启」（清掉内存里的一切）
  ext.dispatch('external:later', '已取走的', { timeoutMs: 60000, taskId: 't-taken' });
  ext.dispatch('external:later', '还在排队', { timeoutMs: 60000, taskId: 't-queued' });
  const taken = await ext.pull('external:later', 0);
  assert.equal(taken.id, 't-taken');
  ext._internal.queue.clear(); ext._internal.waiting.clear(); ext._internal.pollers.clear(); ext._internal.reset();

  const got = [];
  ext.setResultHandler((taskId, result) => got.push([taskId, result]));
  const next = await ext.pull('external:later', 0);
  assert.equal(next && next.id, 't-queued', 'the queued task is delivered after restart');
  assert.ok(ext.complete('external:later', 't-taken', { output: '重启前取走的做完了' }));
  assert.ok(ext.complete('external:later', 't-queued', { output: '重启后取的也做完了' }));
  assert.deepEqual(got, [
    ['t-taken', { ok: true, output: '重启前取走的做完了' }],
    ['t-queued', { ok: true, output: '重启后取的也做完了' }],
  ]);
  assert.equal(ext.complete('external:later', 't-taken', { output: 'again' }), false, 'a result is taken once');
  ext._internal.reset();
});

test('after a task ends, the agent can push more messages to it; a re-sent result counts as a push', async () => {
  const { code } = ext.newPairingCode();
  ext.register({ code, name: 'Poet' });
  ext.approve('external:poet');
  const pushed = [];
  ext.setPushHandler((agentId, taskId, text) => {
    if (taskId !== 't-poem') return false;   // 只认派给它的任务
    pushed.push([agentId, text]);
    return true;
  });
  const waiting = ext.dispatch('external:poet', '每 5 分钟发一首诗', { timeoutMs: 5000, taskId: 't-poem' });
  const task = await ext.pull('external:poet', 0);
  assert.ok(ext.complete('external:poet', task.id, { output: '好，设好了' }));
  assert.deepEqual(await waiting, { ok: true, output: '好，设好了' });
  assert.equal(ext.push('external:poet', 't-poem', { output: '《五点的窗》' }), true);
  assert.equal(ext.complete('external:poet', 't-poem', { output: '《晚饭前》' }), true);
  assert.equal(ext.push('external:poet', 't-other', { output: 'x' }), false);
  assert.equal(ext.push('external:poet', 't-poem', { output: '   ' }), false);
  assert.deepEqual(pushed, [['external:poet', '《五点的窗》'], ['external:poet', '《晚饭前》']]);
  ext._internal.reset();
});
