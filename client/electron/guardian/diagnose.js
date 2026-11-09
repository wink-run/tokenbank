// client/electron/guardian/diagnose.js
// 一键诊断：回答「为什么应用里看不到这个资产」。逐项检查，给出结论；能修的给一键修复。
// 只读检查 + 用户点击后的修复，不自动改动。桌面版与 Docker 共用（经 resource:diagnose 调用）。
'use strict';

const fs = require('fs');
const path = require('path');

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

/** Token Bank 自己的落盘 / 公共目录，不是应用（与 resource-manager 的卸载豁免一致） */
const INTERNAL_TARGETS = new Set(['agents-hub', 'tokenbank', 'custom', 'aweskill']);

function agentName(agentId) {
  try { return require('../config-loader').appEntityById(agentId)?.name || agentId; } catch { return agentId; }
}

/** 解析 SKILL.md 头部的 name / description */
function readSkillHeader(dir) {
  for (const f of ['SKILL.md', 'skill.md']) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^\s*---\s*\n([\s\S]*?)\n---/);
    if (!m) return { file, hasHeader: false };
    const pick = (k) => {
      const mm = m[1].match(new RegExp(`^${k}\\s*:\\s*(.*)$`, 'm'));
      return mm ? mm[1].trim().replace(/^["']|["']$/g, '') : '';
    };
    return { file, hasHeader: true, name: pick('name'), description: pick('description') };
  }
  return null;
}

const HEALTH_TEXT = {
  missing: '应用的技能目录里找不到它（可能被清理或应用升级后重置了目录）',
  'not-symlink': '应用目录里有个同名文件挡住了，不是指向 Token Bank 的链接',
  'authority-missing': 'Token Bank 资产库里的原文件不见了',
  'unknown-target': '找不到这个应用的技能目录',
};

/**
 * @returns {{ ok: boolean, resource?: object, findings: Array<{ level: 'ok'|'warn'|'error', code: string, text: string, fix?: { type: string, label: string } }> }}
 */
function diagnoseResource(resourceId) {
  const m = rm();
  const resource = m.getResource(resourceId);
  if (!resource) return { ok: false, findings: [{ level: 'error', code: 'not-found', text: '资产不存在' }] };
  const findings = [];
  const targets = require('../resource-agent-targets');
  const projections = (resource.projections || []).filter(p => !INTERNAL_TARGETS.has(p.agentId));

  if (!projections.length) {
    findings.push({ level: 'error', code: 'not-projected', text: '还没有投射到任何应用，应用里自然看不到。', fix: { type: 'enable', label: '启用到常用应用' } });
  }

  let managed = new Set();
  try {
    managed = resource.type === 'skill'
      ? new Set(targets.listManagedResourceAgentIds())
      : require('../mcp-gateway-targets').listManagedAppTargetIds();
  } catch { /* ignore */ }

  let health = [];
  if (projections.length) {
    try { health = m.verifyProjections(resourceId).projections || []; } catch { /* ignore */ }
  }
  for (const p of projections) {
    const who = agentName(p.agentId);
    if (targets.getAgentTarget(p.agentId) && !targets.isAgentInstalled(p.agentId)) {
      findings.push({ level: 'error', code: 'agent-missing', text: `${who} 在这台机器上没有检测到（可能已卸载）。` });
      continue;
    }
    if (managed.size && !managed.has(p.agentId)) {
      findings.push({ level: 'warn', code: 'agent-unmanaged', text: `${who} 当前没有被纳管，到「网关」页纳管后投射才会生效。` });
    }
    const h = health.find(x => x.agentId === p.agentId)?.health;
    if (h && !h.healthy) {
      findings.push({
        level: 'error', code: `broken-${h.reason}`,
        text: `${who}：${HEALTH_TEXT[h.reason] || h.reason}。`,
        ...(h.repairable ? { fix: { type: 'repair', label: '修复投射' } } : {}),
      });
    }
  }

  if (resource.type === 'skill') {
    let dir = null;
    try { dir = require('../resource-canonical').resolveAuthorityDir(resource); } catch { /* ignore */ }
    const header = dir ? readSkillHeader(dir) : null;
    if (!header) {
      findings.push({ level: 'error', code: 'no-skill-md', text: '找不到 SKILL.md，应用无法识别这个技能。' });
    } else if (!header.hasHeader) {
      findings.push({ level: 'warn', code: 'no-header', text: 'SKILL.md 缺少开头的 name / description，应用可能不会加载它。' });
    } else {
      if (!header.description) {
        findings.push({ level: 'warn', code: 'no-description', text: 'SKILL.md 没有 description，应用不知道什么时候该用它。' });
      } else if (header.description.length < 15) {
        findings.push({ level: 'warn', code: 'short-description', text: `description 太短（「${header.description}」），应用可能很少主动调用；写清它做什么、什么时候用。` });
      }
      if (header.name && header.name !== resource.name) {
        findings.push({ level: 'warn', code: 'name-mismatch', text: `SKILL.md 里的 name（${header.name}）和目录名（${resource.name}）不一致，部分应用会按目录名识别。` });
      }
    }
  }

  if (!findings.some(f => f.level === 'error')) {
    findings.push({
      level: 'ok', code: 'looks-fine',
      text: projections.length
        ? '投射正常。应用通常要新开会话或重启后才会读到新技能 / 提示词。'
        : '检查完成。',
    });
  }
  return { ok: true, resource: m.getResource(resourceId), findings };
}

/** 诊断结果里的一键修复 */
function fixResource(resourceId, type) {
  const m = rm();
  if (type === 'repair') {
    const v = m.verifyProjections(resourceId, { repair: true });
    const still = (v.projections || []).filter(p => p.health && !p.health.healthy && p.health.repairable);
    return still.length ? { success: false, error: still.map(p => p.health.repairError || p.health.reason).join('; ') } : { success: true };
  }
  if (type === 'enable') {
    const r = m.getResource(resourceId);
    const targets = require('../resource-agent-targets');
    const ids = r?.type === 'skill'
      ? targets.listManagedResourceAgentIds()
      : [...require('../mcp-gateway-targets').listManagedAppTargetIds()];
    if (!ids.length) return { success: false, error: '还没有纳管任何应用，先到「网关」页纳管一个。' };
    return m.projectToAgents(resourceId, ids, 'global', { force: false });
  }
  return { success: false, error: 'unknown-fix' };
}

module.exports = { diagnoseResource, fixResource, readSkillHeader, INTERNAL_TARGETS };
