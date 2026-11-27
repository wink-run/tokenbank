// 新的 Claude 模型不用改代码：模型列表从 Anthropic 拿，清单里没有的 claude-* 照样交给订阅，请求约束按上游报错自动学
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
// 缓存写到临时目录，不碰本机的 ~/.tokenbank
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-claude-live-'));
process.env.USERPROFILE = process.env.HOME;

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../claude-live-models');
const { claudeModelInfo, claudeOAuthModels, withClaudeOAuthModels } = require('../claude-models');
const hints = require('../gateway-upstream-hints');

test('拿到 Anthropic 的模型列表：新模型进目录、排在前面，上下文和最大输出用列表里的', async () => {
  live._setForTests({
    models: null,
    fetch: async (token) => {
      assert.equal(token, 'tk');
      return { data: [
        { id: 'claude-opus-6', created_at: '2027-03-01T00:00:00Z', max_input_tokens: 2000000, max_tokens: 256000 },
        { id: 'claude-opus-5-5', created_at: '2026-11-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000 },
        { id: 'not-claude', created_at: '2027-04-01T00:00:00Z' },
      ] };
    },
  });
  try {
    assert.equal(await live.refresh({ getToken: async () => 'tk', force: true }), true);
    assert.deepEqual(claudeModelInfo('claude-opus-6'), { name: 'claude-opus-6', context_window: 2000000, max_output_tokens: 256000 });
    assert.equal(claudeModelInfo('claude-opus-5-5').alwaysThinking, true, '内置目录里已知的约束保留');
    const names = claudeOAuthModels().map((m) => m.name);
    assert.equal(names[0], 'claude-opus-6');
    assert.ok(names.includes('claude-sonnet-4-6'), '内置目录里有、列表里没有的照样在');
    assert.ok(!names.includes('not-claude'));
    // 旧的整份同步清单：补上新发布的
    const stale = { oauth_provider: 'claude', models: names.slice(2).map((name) => ({ name })) };
    assert.deepEqual(withClaudeOAuthModels(stale).models.slice(0, 2).map((m) => m.name), ['claude-opus-6', 'claude-opus-5-5']);
    // 没有 token：不刷
    assert.equal(await live.refresh({ getToken: async () => null, force: true }), false);
  } finally {
    live._setForTests({ models: [] });
  }
});

test('Claude 订阅：清单里没有的 claude-* 也交给它，别的源不受影响', () => {
  live._setForTests({ models: [], fetch: async () => ({ data: [] }) });
  const { _providerHasModel } = require('../local-gateway');
  const sub = { oauth_provider: 'claude', models: [{ name: 'claude-opus-5' }] };
  assert.equal(_providerHasModel(sub, 'claude-opus-7'), true);
  assert.equal(_providerHasModel(sub, 'gpt-5.5'), false);
  const paid = { type: 'paid', base_url: 'https://x', models: [{ name: 'claude-opus-5' }] };
  assert.equal(_providerHasModel(paid, 'claude-opus-7'), false);
});

test('上游报新模型的约束：去掉采样参数、换自适应思考、按上限截 max_tokens', () => {
  assert.deepEqual(hints.parseBodyConstraintError({ status: 400, message: 'HTTP_400: temperature is not supported for this model' }).strip, ['temperature']);
  assert.deepEqual(hints.parseBodyConstraintError({ status: 400, message: 'HTTP_400: `top_p` is deprecated for this model' }).strip, ['top_p']);
  assert.deepEqual(hints.parseBodyConstraintError({ status: 400, message: 'HTTP_400: thinking type "disabled" is not supported for this model' }).set.thinking, { type: 'adaptive' });
  assert.equal(hints.parseBodyConstraintError({ status: 400, message: 'HTTP_400: max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-x' }).set.max_tokens, 128000);
  const fixed = hints.applyMutations({ model: 'm', temperature: 0.3, thinking: { type: 'disabled' }, max_tokens: 200000 },
    { strip: ['temperature'], set: { thinking: { type: 'adaptive' }, max_tokens: 128000 } });
  assert.deepEqual(fixed, { model: 'm', thinking: { type: 'adaptive' }, max_tokens: 128000 });
  assert.equal(hints.parseBodyConstraintError({ status: 429, message: 'HTTP_429: rate limited' }), null);
});
