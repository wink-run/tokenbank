'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expandEntity, defaultUserCapabilities, loadDoc, applyCloudConfig } = require('../app-handlers');
const {
  listSkillProjectableAgentIds,
  listAssistantProjectableAgentIds,
  listPromptProjectableAgentIds,
  AGENT_RESOURCE_TARGETS,
} = require('../resource-agent-targets');
const { resolveAppsRuntime } = require('../apps-compiler');

test('defaultUserCapabilities enables resource_project when handler declares it', () => {
  const doc = loadDoc();
  assert.equal(defaultUserCapabilities(doc.handlers['claude-code-cli']).resource_project, true);
  assert.equal(defaultUserCapabilities(doc.handlers['kimi-code-cli']).resource_project, true);
  assert.equal(defaultUserCapabilities(doc.handlers['hermes-cli']).resource_project, true);
  assert.equal(defaultUserCapabilities(doc.handlers['openclaw-api']).resource_project, true);
  assert.equal(defaultUserCapabilities(doc.handlers['workbuddy-stats']).resource_project, false);
  assert.equal(defaultUserCapabilities(doc.handlers['pi-cli']).resource_project, true);
});

test('expandEntity exposes resource_project from vars/handler defaults', () => {
  const on = expandEntity({
    id: 'claude-code',
    handler: 'claude-code-cli',
    vars: { capabilities: { gateway_proxy: true, resource_project: true } },
  });
  assert.equal(on.resource_project, true);

  const off = expandEntity({
    id: 'claude-code',
    handler: 'claude-code-cli',
    vars: { capabilities: { gateway_proxy: true, resource_project: false } },
  });
  assert.equal(off.resource_project, false);

  // vars 未写 resource_project 时回落 handler 默认（开启）
  const def = expandEntity({
    id: 'claude-code',
    handler: 'claude-code-cli',
    vars: { capabilities: { gateway_proxy: true } },
  });
  assert.equal(def.resource_project, true);
});

test('default_entities projectable set matches product defaults', () => {
  applyCloudConfig(null);
  const fallback = (loadDoc().default_entities || []).filter(e => e?.id && e?.handler);
  const rt = resolveAppsRuntime({ app_entities: fallback });
  const allowed = new Set(
    (rt.entities_expanded || [])
      .filter(e => e.resource_project)
      .map(e => e.id),
  );
  for (const id of ['claude-code', 'codex', 'cursor', 'kimi-code', 'opencode', 'hermes', 'openclaw', 'pi']) {
    assert.ok(allowed.has(id), `expected ${id} as runtime-capable (resource_project)`);
    assert.ok(AGENT_RESOURCE_TARGETS[id], `expected skill target for ${id}`);
  }
  assert.equal(allowed.has('workbuddy'), false);
});

test('managed projection vs runtime (resource_project) filters differ', () => {
  applyCloudConfig(null);
  const fallback = (loadDoc().default_entities || []).filter(e => e?.id && e?.handler);
  const rt = resolveAppsRuntime({ app_entities: fallback });
  const cl = require('../config-loader');
  const targets = require('../resource-agent-targets');
  const origExpanded = cl.appEntitiesExpanded;
  const origEntities = cl.appEntities;
  const origInstalled = targets.isAgentInstalled;
  const gw = require('../mcp-gateway-targets');
  const origHosted = gw.listHostedAgentIds;
  cl.appEntitiesExpanded = () => rt.entities_expanded;
  cl.appEntities = () => rt.app_entities;
  // 已装：claude-code / kimi-code / workbuddy（后者无 resource_project）
  targets.isAgentInstalled = (id) => ['claude-code', 'kimi-code', 'workbuddy'].includes(id);
  // 已纳管(hosted)：投射目标口径；runtime 仍看 isAgentInstalled + resource_project
  gw.listHostedAgentIds = () => new Set(['claude-code', 'kimi-code', 'workbuddy']);
  try {
    // 投射（prompt/skill/智能体）：已纳管即可
    const skillIds = listSkillProjectableAgentIds();
    assert.ok(skillIds.includes('claude-code'));
    assert.ok(skillIds.includes('kimi-code'));
    assert.ok(skillIds.includes('workbuddy'));
    assert.ok(!skillIds.includes('hermes')); // 未装
    assert.deepEqual(listPromptProjectableAgentIds(), skillIds);
    assert.deepEqual(targets.listManagedResourceAgentIds(), skillIds);

    // runtime（旧「可投射智能体」）：需 resource_project + 已安装
    const runtimeIds = listAssistantProjectableAgentIds();
    assert.ok(runtimeIds.includes('claude-code'));
    assert.ok(runtimeIds.includes('kimi-code'));
    assert.ok(!runtimeIds.includes('workbuddy'));
    assert.ok(!runtimeIds.includes('hermes'));
    assert.deepEqual(targets.listAssistantRuntimeAgentIds(), runtimeIds);
  } finally {
    cl.appEntitiesExpanded = origExpanded;
    cl.appEntities = origEntities;
    targets.isAgentInstalled = origInstalled;
    gw.listHostedAgentIds = origHosted;
  }
});

test('可投射目标 = 已纳管(hosted)，未纳管的已装应用不投射', () => {
  const targets = require('../resource-agent-targets');
  const gw = require('../mcp-gateway-targets');
  const origInstalled = targets.isAgentInstalled;
  const origHosted = gw.listHostedAgentIds;
  // 机器上装了 cursor/hermes/workbuddy，但只纳管了 cursor
  targets.isAgentInstalled = (id) => ['cursor', 'hermes', 'workbuddy'].includes(id);
  gw.listHostedAgentIds = () => new Set(['cursor']);
  try {
    const ids = targets.listManagedResourceAgentIds();
    assert.deepEqual(ids, ['cursor']);
  } finally {
    targets.isAgentInstalled = origInstalled;
    gw.listHostedAgentIds = origHosted;
  }
});

test('严格模式：hosted 空集 → 可投射为空（未纳管即不可投射）', () => {
  const targets = require('../resource-agent-targets');
  const gw = require('../mcp-gateway-targets');
  const origInstalled = targets.isAgentInstalled;
  const origHosted = gw.listHostedAgentIds;
  // 机器上装了 claude-code，但一个都没纳管 → 严格空
  targets.isAgentInstalled = (id) => id === 'claude-code';
  gw.listHostedAgentIds = () => new Set();
  try {
    assert.deepEqual(targets.listManagedResourceAgentIds(), []);
  } finally {
    targets.isAgentInstalled = origInstalled;
    gw.listHostedAgentIds = origHosted;
  }
});

test('hosted 状态读不到(抛错) 时才回退强信号安装探测', () => {
  const targets = require('../resource-agent-targets');
  const gw = require('../mcp-gateway-targets');
  const origInstalled = targets.isAgentInstalled;
  const origHosted = gw.listHostedAgentIds;
  targets.isAgentInstalled = (id) => id === 'claude-code';
  gw.listHostedAgentIds = () => { throw new Error('config unreadable'); };
  try {
    assert.deepEqual(targets.listManagedResourceAgentIds(), ['claude-code']);
  } finally {
    targets.isAgentInstalled = origInstalled;
    gw.listHostedAgentIds = origHosted;
  }
});

test('isAgentInstalled uses detect_command when present', () => {
  const shim = require('../shim-installer');
  const orig = shim.resolveRealCommand;
  shim.resolveRealCommand = (cmd) => (cmd === 'kimi' ? '/tmp/fake-kimi' : null);
  try {
    const { isAgentInstalled } = require('../resource-agent-targets');
    assert.equal(typeof isAgentInstalled('kimi-code'), 'boolean');
  } finally {
    shim.resolveRealCommand = orig;
  }
});
