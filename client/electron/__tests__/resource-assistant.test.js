'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAssistantConfig,
  buildAssistantLaunch,
  isAssistantAgentId,
  assistantResourceId,
} = require('../resource-assistant');

test('parseAssistantConfig reads soul field', () => {
  const config = parseAssistantConfig(JSON.stringify({
    soul: '你是 Python 专家',
    runtime_agent: 'codex',
    prompts: ['code-review'],
    skills: ['git-commit'],
  }));
  assert.equal(config.soul, '你是 Python 专家');
  assert.equal(config.runtime_agent, 'codex');
  assert.deepEqual(config.prompts, ['code-review']);
});

test('parseAssistantConfig accepts legacy system_prompt', () => {
  const config = parseAssistantConfig(JSON.stringify({
    system_prompt: 'legacy prompt',
  }));
  assert.equal(config.soul, 'legacy prompt');
});

test('buildAssistantLaunch for claude-code uses stream-json and append-system-prompt', () => {
  const launch = buildAssistantLaunch('claude-code', 'hello');
  assert.ok(launch.claudeExtraArgs.includes('--append-system-prompt'));
  assert.ok(launch.claudeExtraArgs.includes('stream-json'));
  assert.ok(!launch.claudeExtraArgs.includes('--include-partial-messages'));
});

test('resolveAssistantRuntimeAgent prefers projection over default runtime', () => {
  const { resolveAssistantRuntimeAgent } = require('../resource-assistant');
  const config = parseAssistantConfig(JSON.stringify({ soul: 'x', runtime_agent: 'claude-code' }));
  assert.equal(
    resolveAssistantRuntimeAgent(config, [{ agentId: 'codex' }]),
    'codex',
  );
});

test('cursor projection uses real Cursor runtime (not Claude fallback)', () => {
  const {
    hasAssistantEnableProjection,
    resolveAssistantRuntimeAgent,
    resolveAssistantDisplayRuntime,
    buildAssistantLaunch,
  } = require('../resource-assistant');
  const projs = [{ agentId: 'cursor' }];
  assert.equal(hasAssistantEnableProjection(projs), true);
  const config = parseAssistantConfig(JSON.stringify({ soul: 'x', runtime_agent: 'claude-code' }));
  // 投射 Cursor → 运行时就是 cursor
  assert.equal(resolveAssistantRuntimeAgent(config, projs), 'cursor');
  assert.equal(
    resolveAssistantRuntimeAgent(config, projs, new Set(['cursor', 'claude-code'])),
    'cursor',
  );
  // Cursor CLI 用不了时不换到没投射过的应用上：算跑不起来（网关页会写明原因）
  assert.equal(
    resolveAssistantRuntimeAgent(config, projs, new Set(['codex'])),
    null,
  );
  assert.equal(resolveAssistantDisplayRuntime(projs, 'cursor'), 'Cursor');
  const launch = buildAssistantLaunch('cursor', '你是写作教练');
  assert.ok(launch.promptPrefix.includes('你是写作教练'));
});

test('pi projection enables playground runtime', () => {
  const {
    hasAssistantEnableProjection,
    resolveAssistantRuntimeAgent,
    resolveAssistantDisplayRuntime,
    buildAssistantLaunch,
    ASSISTANT_RUNTIME_IDS,
  } = require('../resource-assistant');
  const projs = [{ agentId: 'pi' }];
  assert.ok(ASSISTANT_RUNTIME_IDS.has('pi'));
  assert.equal(hasAssistantEnableProjection(projs), true);
  const config = parseAssistantConfig(JSON.stringify({ soul: 'x', runtime_agent: 'claude-code' }));
  assert.equal(resolveAssistantRuntimeAgent(config, projs, new Set(['pi'])), 'pi');
  assert.equal(resolveAssistantDisplayRuntime(projs, 'pi'), 'Pi');
  const launch = buildAssistantLaunch('pi', '你是看护', 'gateway-model');
  assert.ok(launch.promptPrefix.includes('你是看护'));
  assert.equal(launch.model, 'gateway-model');
});

test('kimi-code projection enables playground runtime', () => {
  const {
    hasAssistantEnableProjection,
    resolveAssistantRuntimeAgent,
    resolveAssistantDisplayRuntime,
    buildAssistantLaunch,
    ASSISTANT_RUNTIME_IDS,
  } = require('../resource-assistant');
  const projs = [{ agentId: 'kimi-code' }];
  assert.ok(ASSISTANT_RUNTIME_IDS.has('kimi-code'));
  assert.equal(hasAssistantEnableProjection(projs), true);
  const config = parseAssistantConfig(JSON.stringify({ soul: 'x', runtime_agent: 'claude-code' }));
  assert.equal(resolveAssistantRuntimeAgent(config, projs), 'kimi-code');
  assert.equal(resolveAssistantDisplayRuntime(projs, 'kimi-code'), 'Kimi Code');
  const launch = buildAssistantLaunch('kimi-code', '你是助手');
  assert.ok(launch.promptPrefix.includes('你是助手'));
});

test('resolveAssistantRuntimeAgent keeps configured runtime if still projected', () => {
  const { resolveAssistantRuntimeAgent } = require('../resource-assistant');
  const config = parseAssistantConfig(JSON.stringify({ soul: 'x', runtime_agent: 'claude-code' }));
  assert.equal(
    resolveAssistantRuntimeAgent(config, [{ agentId: 'codex' }, { agentId: 'claude-code' }]),
    'claude-code',
  );
});

test('withAssistantRuntimeAgent writes runtime_agent', () => {
  const { withAssistantRuntimeAgent, parseAssistantConfig: parse } = require('../resource-assistant');
  const out = withAssistantRuntimeAgent(JSON.stringify({ soul: 'hi' }), 'codex');
  assert.equal(parse(out).runtime_agent, 'codex');
  assert.equal(parse(out).soul, 'hi');
});

test('formatAssistantContent migrates system_prompt to soul', () => {
  const { formatAssistantContent } = require('../resource-assistant');
  const out = formatAssistantContent(JSON.stringify({
    system_prompt: 'hello',
    prompts: ['a'],
  }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.soul, 'hello');
  assert.equal(parsed.system_prompt, undefined);
  assert.deepEqual(parsed.prompts, ['a']);
});

test('assistant agent id prefix', () => {
  assert.ok(isAssistantAgentId('assistant:res-assistant-x'));
  assert.equal(assistantResourceId('assistant:res-assistant-x'), 'res-assistant-x');
});

test('runs only on apps it is projected onto: default first, then another projected app, else none', () => {
  const { resolveAssistantRuntimeAgent, projectedRuntimeIds } = require('../resource-assistant');
  const proj = [{ agentId: 'claude-code' }, { agentId: 'codex' }];
  const cfg = { runtime_agent: 'codex' };
  assert.equal(resolveAssistantRuntimeAgent(cfg, proj, new Set(['claude-code', 'codex'])), 'codex', 'the chosen default');
  assert.equal(resolveAssistantRuntimeAgent(cfg, proj, new Set(['claude-code', 'cursor'])), 'claude-code', 'default unavailable → other projected app');
  assert.equal(resolveAssistantRuntimeAgent(cfg, proj, new Set(['cursor'])), null, 'never an app it was not projected onto');
  assert.deepEqual(projectedRuntimeIds([...proj, { agentId: 'workbuddy' }], new Set(['codex'])), ['codex']);
  // 只投射到不能跑它的应用（如 WorkBuddy）：仍然借本机一个能用的应用跑
  assert.equal(resolveAssistantRuntimeAgent({ runtime_agent: 'claude-code' }, [{ agentId: 'workbuddy' }], new Set(['codex'])), 'codex');
});
