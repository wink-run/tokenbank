'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { claudeOAuthModels, withClaudeOAuthModels, normalizeClaudeOAuthBody } = require('../claude-models');
const { mergeRegistryDoc } = require('../config-loader');
const { resolveContextWindow } = require('../model-context-window');
const oauth = require('../oauth');

test('public active catalog includes latest and legacy models, excluding retired/invitation-only', () => {
  const list = claudeOAuthModels();
  const names = new Set(list.map((m) => m.name));
  assert.equal(names.size, 15);
  for (const name of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001']) assert.ok(names.has(name), name);
  assert.ok(list.every((m) => m.vision && m.type === 'chat'));
  assert.ok(list.every((m) => !/mythos|claude-opus-4-2025|claude-sonnet-4-2025/.test(m.name)));
  list[0].name = 'mutated';
  assert.equal(claudeOAuthModels()[0].name, 'claude-opus-5-5');
});

test('empty runtime and registry OAuth lists recover the same catalog; explicit models stay selected', () => {
  const runtime = { oauth_provider: 'claude', models: [] };
  const registry = { id: 'claude-code', oauth: { provider: 'claude' }, models: [] };
  assert.deepEqual(withClaudeOAuthModels(runtime).models, withClaudeOAuthModels(registry).models);
  assert.deepEqual(runtime.models, []);
  const selected = { ...runtime, models: [{ name: 'claude-haiku-4-5-20251001' }] };
  assert.equal(withClaudeOAuthModels(selected), selected);
  const apiKey = { auth_type: 'api_key', base_url: 'https://api.anthropic.com/v1', models: [] };
  assert.equal(withClaudeOAuthModels(apiKey), apiKey);
  const impostor = { auth_type: 'oauth', base_url: 'https://api.anthropic.com.evil.test', models: [] };
  assert.equal(withClaudeOAuthModels(impostor), impostor);
  const legacy = { auth_type: 'oauth', base_url: 'https://api.anthropic.com/v1', models: [] };
  assert.equal(withClaudeOAuthModels(legacy).models.length, 15);
  const doc = mergeRegistryDoc({ providers: [registry] });
  assert.deepEqual(doc.providers.find((p) => p.id === 'claude-code').models, claudeOAuthModels());
});

test('context lookup distinguishes new 1M models from Haiku and 4.5, with explicit limits preferred', () => {
  for (const model of ['claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
    assert.equal(resolveContextWindow(model), 1000000, model);
  }
  assert.equal(resolveContextWindow('claude-haiku-4-5'), 200000);
  assert.equal(resolveContextWindow('claude-sonnet-4-5-20250929'), 200000);
  assert.equal(resolveContextWindow({ name: 'claude-opus-5', context_window: 200000 }), 200000);
});

test('modern OAuth requests migrate old sampling/thinking and cap output, preserving input', () => {
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8', 'claude-opus-4-7']) {
    const body = { model, max_tokens: 1000000, temperature: 0.2, top_p: 0.8, top_k: 10, thinking: { type: 'enabled', budget_tokens: 4096, display: 'summarized' }, output_config: { effort: 'high' }, messages: [{ role: 'user', content: 'test' }] };
    const before = structuredClone(body);
    const { body: out, headers } = oauth.applyAuth('claude', { body, headers: {}, credentials: { access_token: 'test-token' } });
    assert.equal(out.model, model);
    assert.equal(out.max_tokens, 128000);
    assert.equal(out.temperature, undefined);
    assert.equal(out.top_p, undefined);
    assert.equal(out.top_k, undefined);
    assert.deepEqual(out.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(out.output_config, body.output_config);
    assert.match(out.system[0].text, /cc_entrypoint=cli/);
    assert.equal(headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20');
    assert.deepEqual(body, before);
  }
});

test('Fable always-on thinking does not silently weaken forced tools or alter signed history', () => {
  const body = { model: 'claude-fable-5-1', thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'submit' }, messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'signed-history' }] }] };
  const out = normalizeClaudeOAuthBody(body);
  assert.deepEqual(out.thinking, { type: 'adaptive' });
  assert.deepEqual(out.tool_choice, body.tool_choice);
  assert.deepEqual(out.messages, body.messages);
  assert.deepEqual(normalizeClaudeOAuthBody({ model: 'claude-opus-5', thinking: { type: 'disabled' } }).thinking, { type: 'disabled' });
});

test('legacy and unknown models retain their existing thinking and sampling behavior', () => {
  for (const model of ['claude-haiku-4-5-20251001', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-sonnet-4-6', 'custom-model']) {
    const body = { model, max_tokens: 4096, temperature: 0.2, top_p: 0.8, thinking: { type: 'enabled', budget_tokens: 1024 } };
    assert.deepEqual(normalizeClaudeOAuthBody(body), body);
  }
});

test('整份同步过的旧清单补上之后发布的新模型；只挑了几个的、自定义的不动', () => {
  const OLD = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-4-8',
    'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929'];
  const stale = { oauth_provider: 'claude', models: OLD.map((name) => ({ name })) };
  const got = withClaudeOAuthModels(stale).models.map((m) => m.name);
  assert.deepEqual(got.slice(0, 4), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2']);
  assert.deepEqual(got.slice(4), OLD, '原来保存的照旧');
  // 删掉了几个旧的：不会被加回来
  const trimmed = { oauth_provider: 'claude', models: OLD.slice(0, 8).map((name) => ({ name })) };
  assert.ok(!withClaudeOAuthModels(trimmed).models.some((m) => m.name === 'claude-sonnet-4-6'));
  // 已经是新目录：不重复加
  const current = { oauth_provider: 'claude', models: claudeOAuthModels() };
  assert.equal(withClaudeOAuthModels(current), current);
  const custom = { oauth_provider: 'claude', models: [{ name: 'my-proxy-model' }] };
  assert.equal(withClaudeOAuthModels(custom), custom);
});

test('新模型关不掉思考、不收采样参数', () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']) {
    const out = normalizeClaudeOAuthBody({ model, temperature: 0.2, max_tokens: 200000, thinking: { type: 'disabled' } });
    assert.equal(out.temperature, undefined, model);
    assert.equal(out.max_tokens, 128000, model);
    assert.deepEqual(out.thinking, { type: 'adaptive' }, model);
  }
  const haiku = normalizeClaudeOAuthBody({ model: 'claude-haiku-5-5', top_p: 0.9, thinking: { type: 'disabled' } });
  assert.equal(haiku.top_p, undefined);
  assert.deepEqual(haiku.thinking, { type: 'disabled' });
});

test('Claude 订阅：清单里没有的 claude-* 也交给它试，别的源不受影响（不去拉模型列表）', () => {
  const { _providerHasModel } = require('../local-gateway');
  const sub = { oauth_provider: 'claude', models: [{ name: 'claude-opus-5' }] };
  assert.equal(_providerHasModel(sub, 'claude-opus-7'), true);
  assert.equal(_providerHasModel(sub, 'gpt-5.5'), false);
  const paid = { type: 'paid', base_url: 'https://x', models: [{ name: 'claude-opus-5' }] };
  assert.equal(_providerHasModel(paid, 'claude-opus-7'), false);
});

test('上游报新模型的约束：去掉采样参数、换自适应思考、按上限截 max_tokens', () => {
  const hints = require('../gateway-upstream-hints');
  assert.deepEqual(hints.parseBodyConstraintError({ status: 400, message: 'HTTP_400: temperature is not supported for this model' }).strip, ['temperature']);
  assert.deepEqual(hints.parseBodyConstraintError({ status: 400, message: 'HTTP_400: `top_p` is deprecated for this model' }).strip, ['top_p']);
  assert.deepEqual(hints.parseBodyConstraintError({ status: 400, message: 'HTTP_400: thinking type "disabled" is not supported for this model' }).set.thinking, { type: 'adaptive' });
  assert.equal(hints.parseBodyConstraintError({ status: 400, message: 'HTTP_400: max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-x' }).set.max_tokens, 128000);
  assert.equal(hints.parseBodyConstraintError({ status: 429, message: 'HTTP_429: rate limited' }), null);
});
