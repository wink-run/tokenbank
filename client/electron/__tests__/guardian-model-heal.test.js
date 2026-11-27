'use strict';
// 智能管家：应用要的模型用不了时自己处理——刷新列表认出新模型，或改道到同一系列能用的，可撤销
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-heal-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const guardian = require('../guardian/index');
const heal = require('../guardian/model-heal');
const redirects = require('../model-redirects');

const missing = (model, extra = {}) => ({ providerId: 'claude-sub', model, requestedModel: model, status: 404, message: `HTTP_404: Model '${model}' is not available`, ...extra });


test('同一系列：Claude 按 opus/sonnet/haiku，其他按去掉版本号的前缀', () => {
  assert.equal(heal.familyOf('claude-opus-5-5'), 'claude:opus');
  assert.equal(heal.familyOf('claude-sonnet-4-5-20250929'), 'claude:sonnet');
  assert.equal(heal.familyOf('gpt-5.5-pro'), 'gpt');
  assert.equal(heal.pickReplacement('claude-opus-9', ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5']), 'claude-opus-5-5');
  assert.equal(heal.pickReplacement('claude-opus-9', ['gpt-5.5']), null);
});

test('改道到同一系列能用的最新一个，记录可撤销；撤销后不再自动改', async () => {
  heal._reset(); redirects._reset();
  const deps = { gateway: { localModelNames: () => ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5'] } };
  const r = await heal.heal(missing('claude-opus-9'), deps);
  assert.deepEqual(r, { action: 'redirected', target: 'claude-opus-5-5' });
  assert.equal(redirects.resolve('claude-opus-9'), 'claude-opus-5-5');
  const rec = guardian.listRecords().find((x) => x.signature === 'model-redirect|claude-opus-9');
  assert.ok(rec && rec.status === 'done' && rec.undo?.type === 'removeModelRedirect');
  // 同一个名字再失败：已经改道了，不重复处理
  assert.equal(await heal.heal(missing('claude-opus-9'), deps), null);

  // 用户撤销
  heal.attach();
  const undone = await guardian.runAction({ type: 'removeModelRedirect', data: { from: 'claude-opus-9' } });
  assert.equal(undone.ok, true);
  assert.equal(redirects.resolve('claude-opus-9'), 'claude-opus-9');
});

test('找不到能顶上的：告诉用户；应用绑了别的模型、或已经是改道后的请求，不动', async () => {
  heal._reset(); redirects._reset();
  const deps = { gateway: { localModelNames: () => ['gpt-5.5'] } };
  assert.equal((await heal.heal(missing('claude-haiku-9'), deps)).action, 'told');
  // 要用户动手的不进记录列表，由智能管家在对话里说一句
  assert.equal(redirects.get('claude-haiku-9'), null);
  heal._reset();
  assert.equal(await heal.heal(missing('deepseek-v9', { requestedModel: 'claude-opus-5-5' }), deps), null, '路由改写过的不管');
  assert.equal(await heal.heal(missing('claude-opus-7', { redirectedFrom: 'claude-opus-9' }), deps), null);
  assert.equal(await heal.heal({ model: 'claude-opus-7', status: 429, message: 'rate limited' }, deps), null, '不是缺模型的报错不管');
});

test('网关入口按改道表换模型名，只转一跳', () => {
  redirects._reset();
  redirects.set('a', 'b', { by: 'guardian' });
  redirects.set('b', 'c', { by: 'guardian' });
  assert.equal(redirects.resolve('a'), 'b');
  assert.equal(redirects.set('x', 'x'), false);
});
