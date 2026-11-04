'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  DELIVERY_POLICY,
  withDeliveryPolicyPrompt,
  withClaudeDeliverySystemArgs,
} = require('../agent-delivery-policy');
const { buildClaudeCodeArgs } = require('../agent-executor');
const { buildAssistantLaunch } = require('../resource-assistant');
const mcpManager = require('../mcp-manager');

test('DELIVERY_POLICY forbids paste-script and internal cache paths', () => {
  assert.ok(DELIVERY_POLICY.includes('一键保存'));
  assert.ok(DELIVERY_POLICY.includes('codex-runtimes') || DELIVERY_POLICY.includes('artifact_tool'));
  assert.ok(DELIVERY_POLICY.includes('工作目录'));
});

test('withDeliveryPolicyPrompt prefixes once', () => {
  const once = withDeliveryPolicyPrompt('做个 PPT');
  assert.ok(once.startsWith('【Token Bank 产物交付】'));
  assert.ok(once.includes('做个 PPT'));
  assert.equal(withDeliveryPolicyPrompt(once), once);
});

test('withClaudeDeliverySystemArgs appends system prompt', () => {
  const args = withClaudeDeliverySystemArgs(['-p', '--verbose']);
  assert.ok(args.includes('--append-system-prompt'));
  const i = args.indexOf('--append-system-prompt');
  assert.ok(String(args[i + 1]).includes('【Token Bank 产物交付】'));
});

test('buildClaudeCodeArgs injects delivery policy', () => {
  const args = buildClaudeCodeArgs('hello');
  assert.ok(args.includes('--append-system-prompt'));
  const i = args.indexOf('--append-system-prompt');
  assert.ok(String(args[i + 1]).includes('产物交付'));
  assert.ok(!String(args[i + 1]).includes('【Token Bank 出租】'));
});

test('rental definition tells the agent it is hired out', () => {
  const { RENTAL_CONTEXT, applyRentalDefinition } = require('../agent-delivery-policy');
  assert.ok(RENTAL_CONTEXT.includes('上架出租'));
  assert.ok(RENTAL_CONTEXT.includes('雇佣方'));
  assert.ok(RENTAL_CONTEXT.includes('Finder'));
  assert.ok(RENTAL_CONTEXT.includes('绝对路径'));

  const claude = applyRentalDefinition(['--append-system-prompt', DELIVERY_POLICY, '做封面']);
  const sys = claude[claude.indexOf('--append-system-prompt') + 1];
  assert.ok(sys.includes('产物交付'));
  assert.ok(sys.indexOf('【Token Bank 出租】') > sys.indexOf('【Token Bank 产物交付】'));
  assert.equal(applyRentalDefinition(claude)[claude.indexOf('--append-system-prompt') + 1], sys);

  const cursor = applyRentalDefinition([withDeliveryPolicyPrompt('做封面')]);
  assert.ok(cursor[0].includes('【Token Bank 出租】'));
  assert.ok(cursor[0].indexOf('【Token Bank 出租】') > cursor[0].indexOf('【Token Bank 产物交付】'));
  assert.equal(applyRentalDefinition(cursor)[0], cursor[0]);
});

test('buildAssistantLaunch injects policy for claude and codex', () => {
  const cc = buildAssistantLaunch('claude-code', 'soul text');
  const idx = cc.claudeExtraArgs.indexOf('--append-system-prompt');
  assert.ok(String(cc.claudeExtraArgs[idx + 1]).includes('soul text'));
  assert.ok(String(cc.claudeExtraArgs[idx + 1]).includes('产物交付'));

  const cx = buildAssistantLaunch('codex', 'soul text');
  assert.ok(cx.promptPrefix.includes('soul text'));
  assert.ok(cx.promptPrefix.includes('产物交付'));
});

test('buildAssistantLaunch: 画像分析可关闭产物落盘规则', () => {
  const cc = buildAssistantLaunch('claude-code', '画像 soul', '', { includeDelivery: false });
  const idx = cc.claudeExtraArgs.indexOf('--append-system-prompt');
  assert.ok(String(cc.claudeExtraArgs[idx + 1]).includes('画像 soul'));
  assert.ok(!String(cc.claudeExtraArgs[idx + 1]).includes('产物交付'));

  const cx = buildAssistantLaunch('codex', '画像 soul', '', { includeDelivery: false });
  assert.ok(cx.promptPrefix.includes('画像 soul'));
  assert.ok(!cx.promptPrefix.includes('产物交付'));
});

test('orchestrator system includes delivery policy', () => {
  const { DELIVERY_POLICY: pol } = require('../agent-delivery-policy');
  assert.ok(pol.includes('直接写入'));
  assert.ok(typeof mcpManager.buildOrchestratorLaunch === 'function');
});

test('orchestrator prefers specialized assistants before CLI fallback', () => {
  const { ORCHESTRATOR_SYSTEM } = require('../mcp-manager');
  assert.ok(ORCHESTRATOR_SYSTEM.includes('社区智能体'));
  assert.ok(ORCHESTRATOR_SYSTEM.includes('community:'));
  assert.ok(ORCHESTRATOR_SYSTEM.includes('必须') && ORCHESTRATOR_SYSTEM.includes('派发'));
  assert.ok(ORCHESTRATOR_SYSTEM.includes('不是默认执行者'));
  // 分析 / 派发 / 汇总 流水线
  assert.ok(ORCHESTRATOR_SYSTEM.includes('分析'));
  assert.ok(ORCHESTRATOR_SYSTEM.includes('汇总'));
  // 异常兜底
  assert.ok(ORCHESTRATOR_SYSTEM.includes('异常兜底'));
  assert.ok(ORCHESTRATOR_SYSTEM.includes('降级') || ORCHESTRATOR_SYSTEM.includes('自行'));
  assert.ok(ORCHESTRATOR_SYSTEM.includes('重试'));
});
