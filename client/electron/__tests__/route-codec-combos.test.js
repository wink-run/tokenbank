'use strict';
// codec 组合当 model 传的支持：纯前缀 codec(auto:free / auto:personal / community / speed:paid …)
// 经 parsePureCodec → buildStrategyCandidates 路由到对应候选；带模型/真实模型不当纯 codec。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const gw = require('../local-gateway');
const { parsePureCodec, buildStrategyCandidates } = gw;

const CFG = { providers: [
  { id: 'paidglm', type: 'paid', enabled: true, base_url: 'http://p', source: 'payg', models: [{ name: 'glm-5', type: 'chat' }] },
  { id: 'freeglm', type: 'free', enabled: true, base_url: 'http://f',                 models: [{ name: 'glm-5', type: 'chat' }, { name: 'qwen', type: 'chat' }] },
  { id: 'paidgpt', type: 'paid', enabled: true, base_url: 'http://g', source: 'payg', models: [{ name: 'gpt-4o', type: 'chat' }] },
] };
// glm-5 为个人模型；paidgpt 仅登记账户（无 models）以便 gpt-4o 可出现在全量/付费候选
const LOCALCFG = {
  user_payg_providers: [
    { id: 'pg1', provider_id: 'paidglm', models: ['glm-5'] },
    { id: 'pg2', provider_id: 'paidgpt', models: [] },
  ],
};
const RP = '/v1/chat/completions';

before(() => { gw.start(19873, () => CFG, null); gw.setLocalConfigReader(() => LOCALCFG); });
after(() => { gw.setLocalConfigReader(null); gw.stop(); });

const ids = (c) => c.map(x => x.providerId).sort();
const models = (c) => [...new Set(c.map(x => x.model))].sort();

// 模拟 route() 对纯前缀 codec 的处理：解析 → 合成策略步 → 建候选
function routeCodec(codec) {
  const pc = parsePureCodec(codec);
  if (!pc) return null;
  return buildStrategyCandidates(pc.strategy || 'round-robin', { scope: pc.scope, tier: pc.tier }, RP, false, 'k');
}

test('parsePureCodec: 纯前缀识别，带模型/真实模型返回 null', () => {
  assert.deepStrictEqual(parsePureCodec('auto:free'), { strategy: 'auto', scope: null, tier: 'free', sharer: null });
  assert.deepStrictEqual(parsePureCodec('auto:personal'), { strategy: 'auto', scope: 'personal', tier: null, sharer: null });
  assert.strictEqual(parsePureCodec('auto:free:gpt-4o'), null);   // 带裸模型 → 非纯 codec
  assert.strictEqual(parsePureCodec('gpt-4o'), null);            // 真实模型
  assert.strictEqual(parsePureCodec(''), null);
});

test('codec auto:free → 只出免费候选(glm-5, qwen)', () => {
  assert.deepStrictEqual(models(routeCodec('auto:free')), ['glm-5', 'qwen']);
  assert.ok(routeCodec('auto:free').every(c => c.providerTier === 'free'));
});

test('codec auto:personal → 只出个人源集里的模型(glm-5，跨免费/付费源)', () => {
  assert.deepStrictEqual(models(routeCodec('auto:personal')), ['glm-5']);
  assert.deepStrictEqual(ids(routeCodec('auto:personal')), ['freeglm', 'paidglm']);
});

test('codec speed:paid → 只出付费候选(glm-5@paidglm, gpt-4o@paidgpt)', () => {
  assert.deepStrictEqual(ids(routeCodec('speed:paid')), ['paidglm', 'paidgpt']);
});

test('codec personal:free → 个人源 ∩ 免费 = freeglm 的 glm-5', () => {
  assert.deepStrictEqual(ids(routeCodec('personal:free')), ['freeglm']);
});

test('codec community → 无 p2p 源时为空(社区只收 p.type===p2p)', () => {
  assert.deepStrictEqual(routeCodec('community'), []);
});

test('codec round-robin(无过滤) → 全部候选', () => {
  assert.deepStrictEqual(models(routeCodec('round-robin')), ['glm-5', 'gpt-4o', 'qwen']);
});
