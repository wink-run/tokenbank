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
