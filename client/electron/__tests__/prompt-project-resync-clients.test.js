'use strict';
// prompt 投射/取消后应触发对应 client 的 MCP 配置 re-sync
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resourceManager = require('../resource-manager');

test('提示词投射后：tokenbank 已常驻应用，不再重写 stdio 应用配置；没有 stdio 通道的挂到中转', () => {
  const mcpManager = require('../mcp-manager');
  const origSync = mcpManager.syncToClients;
  const origRoute = mcpManager.setServerGatewayRouted;
  let synced = 0;
  const routed = [];
  mcpManager.syncToClients = () => { synced += 1; return { success: true }; };
  mcpManager.setServerGatewayRouted = (id, on, cids) => { routed.push([id, on, cids]); return { success: true }; };
  try {
    resourceManager._resyncPromptClients([]);
    resourceManager._resyncPromptClients(['cursor']);
    assert.equal(synced, 0);
    assert.deepEqual(routed, []);
    resourceManager._resyncPromptClients(['trae-work']);
    assert.deepEqual(routed, [['tokenbank', true, ['trae-work']]]);
  } finally {
    mcpManager.syncToClients = origSync;
    mcpManager.setServerGatewayRouted = origRoute;
  }
});

test('listPromptAgentTargets 与 Skill 一致：已纳管(hosted) 且已安装 Agent', () => {
  const gw = require('../mcp-gateway-targets');
  const targets = require('../resource-agent-targets');
  const orig = gw.listHostedAgentIds;
  const origInstalled = targets.isAgentInstalled;
  // 与 Gateway 列表一致：须同时 hosted 且本机检测到
  gw.listHostedAgentIds = () => new Set(['claude-code', 'cursor', 'openclaw']);
  targets.isAgentInstalled = (id) => ['claude-code', 'cursor', 'openclaw'].includes(id);
  try {
    const r = resourceManager.listPromptAgentTargets();
    assert.deepEqual(r.map(x => x.id).sort(), ['claude-code', 'cursor', 'openclaw']);
    assert.ok(r.every(x => x.label));
  } finally {
    gw.listHostedAgentIds = orig;
    targets.isAgentInstalled = origInstalled;
  }
});

test('listPromptAgentTargets：hosted 但未安装(OpenCode 残留)不出现', () => {
  const gw = require('../mcp-gateway-targets');
  const targets = require('../resource-agent-targets');
  const orig = gw.listHostedAgentIds;
  const origInstalled = targets.isAgentInstalled;
  // opencode 有 hosted 残留记录，但本机未真正安装 → 与 Gateway 一致地排除
  gw.listHostedAgentIds = () => new Set(['cursor', 'opencode']);
  targets.isAgentInstalled = (id) => id === 'cursor';
  try {
    const r = resourceManager.listPromptAgentTargets();
    assert.deepEqual(r.map(x => x.id).sort(), ['cursor']);
  } finally {
    gw.listHostedAgentIds = orig;
    targets.isAgentInstalled = origInstalled;
  }
});

test('listPromptAgentTargets 未纳管则不出现', () => {
  const targets = require('../resource-agent-targets');
  const gw = require('../mcp-gateway-targets');
  const origInstalled = targets.isAgentInstalled;
  const origHosted = gw.listHostedAgentIds;
  // 无纳管、也无强信号安装 → 空
  gw.listHostedAgentIds = () => new Set();
  targets.isAgentInstalled = () => false;
  try {
    const r = resourceManager.listPromptAgentTargets();
    assert.deepEqual(r, []);
  } finally {
    targets.isAgentInstalled = origInstalled;
    gw.listHostedAgentIds = origHosted;
  }
});
