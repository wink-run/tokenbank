'use strict';
// scope(来源) 过滤集成测试：personal=个人源集 / community=p2p。注入假源 + 假 localConfig。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const gw = require('../local-gateway');
const { buildStrategyCandidates } = gw;

// 假源：付费 glm-5(payg) / 免费 glm-5+qwen / 付费 gpt-4o(payg)
const CFG = { providers: [
  { id: 'paidglm', type: 'paid', enabled: true, base_url: 'http://p', source: 'payg', models: [{ name: 'glm-5', type: 'chat' }] },
  { id: 'freeglm', type: 'free', enabled: true, base_url: 'http://f',                 models: [{ name: 'glm-5', type: 'chat' }, { name: 'qwen', type: 'chat' }] },
  { id: 'paidgpt', type: 'paid', enabled: true, base_url: 'http://g', source: 'payg', models: [{ name: 'gpt-4o', type: 'chat' }] },
] };
// 个人源登记：仅 glm-5；paidgpt 账户使付费源可路由，gpt-4o 未记入个人模型集
const LOCALCFG = {
  user_payg_providers: [
    { id: 'pg1', provider_id: 'paidglm', models: ['glm-5'] },
    { id: 'pg2', provider_id: 'paidgpt', models: [] },
  ],
};
const RP = '/v1/chat/completions';

before(() => { gw.start(19872, () => CFG, null); gw.setLocalConfigReader(() => LOCALCFG); });
after(() => { gw.setLocalConfigReader(null); gw.stop(); });

const ids = (c) => c.map(x => x.providerId).sort();
const models = (c) => [...new Set(c.map(x => x.model))].sort();

test('scope=personal → 只出个人源集里的模型(glm-5，跨免费/付费两源)，排除 qwen/gpt-4o', () => {
  const c = buildStrategyCandidates('fallback', { scope: 'personal' }, RP, false, 'k');
  assert.deepStrictEqual(models(c), ['glm-5']);
  assert.deepStrictEqual(ids(c), ['freeglm', 'paidglm']);
});

test('scope=personal + tier=free → 个人源集 ∩ 免费层 = freeglm 的 glm-5', () => {
  const c = buildStrategyCandidates('fallback', { scope: 'personal', tier: 'free' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['freeglm']);
  assert.ok(c.every(x => x.model === 'glm-5' && x.providerTier === 'free'));
});

test('scope=personal + tier=paid → 个人源集 ∩ 付费层 = paidglm 的 glm-5', () => {
  const c = buildStrategyCandidates('fallback', { scope: 'personal', tier: 'paid' }, RP, false, 'k');
  assert.deepStrictEqual(ids(c), ['paidglm']);
});

test('scope=community → 无 p2p 源时为空（社区只收 p.type===p2p）', () => {
  const c = buildStrategyCandidates('fallback', { scope: 'community' }, RP, false, 'k');
  assert.deepStrictEqual(c, []);
});

test('无 scope → 不受个人源集限制（全模型候选）', () => {
  const c = buildStrategyCandidates('fallback', {}, RP, false, 'k');
  assert.deepStrictEqual(models(c), ['glm-5', 'gpt-4o', 'qwen']);
});
