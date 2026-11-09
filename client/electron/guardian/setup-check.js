// client/electron/guardian/setup-check.js
// 配置提醒（首次使用最常见的卡点）：装了智能体应用却没纳管、还没有任何可用的模型来源。
// 纳管会改变应用的连接方式，影响大，所以只给建议 + 一键跳到对应页面，不自动改。
'use strict';

const guardian = require('./index');

const AGENT_IDS = ['claude-code', 'codex', 'cursor', 'kimi-code', 'opencode', 'hermes', 'openclaw', 'workbuddy', 'pi'];

function agentName(id) {
  try { return require('../config-loader').appEntityById(id)?.name || id; } catch { return id; }
}

function installedAgents() {
  const out = [];
  let targets = null;
  try { targets = require('../resource-agent-targets'); } catch { /* ignore */ }
  for (const id of AGENT_IDS) {
    let ok = false;
    try { ok = !!targets?.isAgentInstalled(id); } catch { /* ignore */ }
    if (!ok && id === 'pi') {
      try {
        const pi = require('../pi-config').profileForEntity('pi');
        ok = !!(pi && require('../shim-installer').resolveRealCommand(pi.command));
      } catch { /* ignore */ }
    }
    if (ok) out.push(id);
  }
  return out;
}

function managedIds() {
  const ids = new Set();
  try {
    for (const a of require('../mcp-gateway-targets').listManagedAppTargetIds()) ids.add(a);
  } catch { /* ignore */ }
  return ids;
}

function hasModelSource() {
  try {
    const { readAgentConfig } = require('../../shared/config-loader');
    const providers = (readAgentConfig() || {}).providers || [];
    return providers.some(p => p && p.enabled !== false && (p.base_url || p.type === 'p2p'));
  } catch {
    return true; // 读不到配置时不打扰
  }
}

async function check() {
  if (guardian.modeOf('setup') === 'off') return { ok: true, skipped: true };
  const installed = installedAgents();
  const managed = managedIds();
  const unmanaged = installed.filter(id => !managed.has(id));
  if (unmanaged.length) {
    guardian.record({
      category: 'setup', kind: 'setup-unmanaged', status: 'suggested', countAsRepeat: false,
      title: `检测到 ${unmanaged.map(agentName).join('、')}，还没有纳管`,
      advice: '纳管后，技能和提示词才能投射进去，用量也会统一记录。',
      signature: 'setup-unmanaged',
      link: { to: '/gateway', label: '去纳管' },
      meta: { agents: unmanaged },
    });
  } else {
    guardian.resolveSignature('setup-unmanaged');
  }
  const model = hasModelSource();
  if (!model) {
    guardian.record({
      category: 'setup', kind: 'setup-no-model', status: 'suggested', countAsRepeat: false,
      title: '还没有可用的模型来源',
      advice: '添加一个模型来源（自己的 Key、订阅或社区共享）后，网关和一句话生成、自动打标签等智能功能才能用。',
      signature: 'setup-no-model',
      link: { to: '/providers', label: '去添加' },
    });
  } else {
    guardian.resolveSignature('setup-no-model');
  }
  return { ok: true, unmanaged, hasModel: model };
}

function register() {
  guardian.registerCheck('setup', check, 6 * 60 * 60 * 1000);
}

module.exports = { register, check };
