'use strict';
// 统一步骤路由集成测试：每步可选带 when 条件。pickSteps = 无条件(兜底) + 命中条件的步，保持顺序。
// 兼容旧 rules 格式（摊平成带 rule.when 的步 + 默认步）。
const { test } = require('node:test');
const assert = require('node:assert');
const { pickSteps, evalWhen } = require('../local-gateway');

const modelOf = (steps) => steps.map(s => s.model).join(',');

// 新格式：一个步骤列表，每步可选带 when；无条件步=兜底
const uniScene = {
  scene_name: '统一步骤路由',
  steps: [
    { model: 'gemini-2.5-pro', when: { type: 'input_tokens', op: 'gt', value: 50000 } },
    { model: 'gpt-4o',         when: { type: 'keyword', op: 'contains', value: 'GPT' } },
    { model: 'dall-e-3',       when: { type: 'request_type', op: 'is', value: 'image' } },
    { model: 'deepseek-chat' },   // 无条件 = 兜底
  ],
};

// 旧格式：rules + 默认 steps（网关 unifySteps 摊平后应等价）
const legacyScene = {
  scene_name: '旧规则路由',
  steps: [{ model: 'deepseek-chat' }],
  rules: [
    { when: { type: 'input_tokens', op: 'gt', value: 50000 }, steps: [{ model: 'gemini-2.5-pro' }] },
    { when: { type: 'keyword', op: 'contains', value: 'GPT' }, steps: [{ model: 'gpt-4o' }] },
    { when: { type: 'request_type', op: 'is', value: 'image' }, steps: [{ model: 'dall-e-3' }] },
  ],
};

for (const [name, scene] of [['新格式(步带 when)', uniScene], ['旧格式(rules)', legacyScene]]) {
  test(`${name} · token>50000 → 命中的 gemini + 兜底 deepseek`, () => {
    assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 80000, keyword_text: '', modality: 'chat' })),
      'gemini-2.5-pro,deepseek-chat');
  });
  test(`${name} · 含关键字 GPT(大小写不敏感) → gpt-4o + 兜底`, () => {
    assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 100, keyword_text: '帮我用 gpt 写个函数', modality: 'chat' })),
      'gpt-4o,deepseek-chat');
  });
  test(`${name} · 图像请求 → dall-e-3 + 兜底`, () => {
    assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 100, keyword_text: '', modality: 'image' })),
      'dall-e-3,deepseek-chat');
  });
  test(`${name} · 都不命中 → 只有兜底 deepseek`, () => {
    assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 100, keyword_text: '你好', modality: 'chat' })),
      'deepseek-chat');
  });
  test(`${name} · 同时命中 token 和 GPT → 两步都进 + 兜底(保持顺序)`, () => {
    assert.strictEqual(modelOf(pickSteps(scene, { input_tokens: 90000, keyword_text: '用 GPT 分析这段长文', modality: 'chat' })),
      'gemini-2.5-pro,gpt-4o,deepseek-chat');
  });
}

test('无条件步的场景 → 直接兜底', () => {
  assert.strictEqual(modelOf(pickSteps({ steps: [{ model: 'x' }] }, { input_tokens: 999999 })), 'x');
});

// evalWhen 各 op 覆盖
test('evalWhen: 数值比较 gt/lt/gte/lte', () => {
  assert.strictEqual(evalWhen({ type: 'input_tokens', op: 'gt', value: 100 }, { input_tokens: 200 }), true);
  assert.strictEqual(evalWhen({ type: 'input_tokens', op: 'gt', value: 100 }, { input_tokens: 50 }), false);
  assert.strictEqual(evalWhen({ type: 'input_tokens', op: 'lte', value: 100 }, { input_tokens: 100 }), true);
});

test('evalWhen: keyword contains / match(正则)', () => {
  assert.strictEqual(evalWhen({ type: 'keyword', op: 'contains', value: 'python' }, { keyword_text: '写段 Python 代码' }), true);
  assert.strictEqual(evalWhen({ type: 'keyword', op: 'match', value: '^bug' }, { keyword_text: 'BUG in auth' }), true);
  assert.strictEqual(evalWhen({ type: 'keyword', op: 'contains', value: 'java' }, { keyword_text: '写段 python' }), false);
});

test('evalWhen: in（枚举）/ is / not', () => {
  assert.strictEqual(evalWhen({ type: 'model', op: 'in', value: ['gpt-4o', 'claude'] }, { model: 'gpt-4o' }), true);
  assert.strictEqual(evalWhen({ type: 'request_type', op: 'is', value: 'image' }, { modality: 'image' }), true);
  assert.strictEqual(evalWhen({ type: 'request_type', op: 'not', value: 'image' }, { modality: 'chat' }), true);
});

test('evalWhen: 无效/缺字段 → false，不抛', () => {
  assert.strictEqual(evalWhen(null, {}), false);
  assert.strictEqual(evalWhen({ type: 'has_tools' }, { has_tools: true }), true);
  assert.strictEqual(evalWhen({ type: 'has_tools' }, { has_tools: false }), false);
  assert.strictEqual(modelOf(pickSteps({
    rules: [{ when: { type: 'has_tools' }, steps: [{ model: 'code-model' }] }],
    steps: [{ model: 'deepseek-v4-pro' }],
  }, { has_tools: true })), 'code-model,deepseek-v4-pro');
  assert.strictEqual(modelOf(pickSteps({
    rules: [{ when: { type: 'has_tools' }, steps: [{ model: 'code-model' }] }],
    steps: [{ model: 'deepseek-v4-pro' }],
  }, { has_tools: false })), 'deepseek-v4-pro');
  assert.strictEqual(evalWhen({ type: 'unknown' }, {}), false);
  assert.strictEqual(evalWhen({ type: 'keyword', op: 'match', value: '[' }, { keyword_text: 'x' }), false);
});
