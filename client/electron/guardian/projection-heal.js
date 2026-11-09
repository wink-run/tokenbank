// client/electron/guardian/projection-heal.js
// 投射自愈：应用升级、目录被清理后，技能的软链 / 复制会失效，应用里就「看不到」了。
// 定期离线检查（只读文件系统，不碰任何请求）；auto 直接修复并可撤销，suggest 记一条建议。
'use strict';

const guardian = require('./index');

const REASON_TEXT = {
  missing: '应用的技能目录里找不到它',
  'not-symlink': '应用目录里的同名文件不是指向 Token Bank 的链接',
  'authority-missing': 'Token Bank 资产库里的原文件不见了',
  'unknown-target': '找不到这个应用的技能目录',
};

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

function agentName(agentId) {
  if (require('./diagnose').INTERNAL_TARGETS.has(agentId)) return 'Token Bank 资产库';
  try { return require('../config-loader').appEntityById(agentId)?.name || agentId; } catch { return agentId; }
}

function skillName(r) {
  return r.display_name || r.name;
}

async function check() {
  const mode = guardian.modeOf('projection');
  if (mode === 'off') return { ok: true, skipped: true };
  const m = rm();
  let repaired = 0;
  let suggested = 0;
  let broken = 0;
  for (const r of m.listResources({ type: 'skill' })) {
    if (!(r.projections || []).length) continue;
    let v;
    try { v = m.verifyProjections(r.id); } catch { continue; }
    const bad = (v.projections || []).filter(p => p.health && !p.health.healthy);
    if (!bad.length) continue;
    broken += bad.length;
    const repairable = bad.filter(p => p.health.repairable);
    const notRepairable = bad.filter(p => !p.health.repairable);

    if (repairable.length && mode === 'auto') {
      let after;
      try { after = m.verifyProjections(r.id, { repair: true }); } catch (e) { after = { projections: [] }; }
      for (const p of after.projections || []) {
        if (!repairable.some(b => b.agentId === p.agentId)) continue;
        const before = repairable.find(b => b.agentId === p.agentId);
        if (p.repaired && p.health?.healthy) {
          repaired++;
          guardian.record({
            category: 'projection',
            kind: 'projection-repaired',
            status: 'done',
            title: `已修复「${skillName(r)}」在 ${agentName(p.agentId)} 里的投射`,
            detail: `原因：${REASON_TEXT[before.health.reason] || before.health.reason}`,
            undo: { type: 'unproject', data: { resourceId: r.id, agentId: p.agentId, projectionId: p.projectionId || p.id } },
            meta: { resourceId: r.id, agentId: p.agentId, reason: before.health.reason },
          });
        } else {
          guardian.record({
            category: 'projection',
            kind: 'projection-repair-failed',
            status: 'failed',
            title: `「${skillName(r)}」在 ${agentName(p.agentId)} 里的投射修复失败`,
            detail: p.health?.repairError || REASON_TEXT[p.health?.reason] || p.health?.reason || '',
            advice: '到资产页打开这个技能，点「诊断」查看原因。',
            signature: `proj-fail|${r.id}|${p.agentId}`,
            meta: { resourceId: r.id, agentId: p.agentId },
          });
        }
      }
    } else if (repairable.length) {
      for (const p of repairable) {
        suggested++;
        guardian.record({
          category: 'projection',
          kind: 'projection-broken',
          status: 'suggested',
          title: `「${skillName(r)}」在 ${agentName(p.agentId)} 里的投射失效了`,
          detail: `原因：${REASON_TEXT[p.health.reason] || p.health.reason}`,
          apply: { type: 'repairProjection', data: { resourceId: r.id } },
          signature: `proj|${r.id}|${p.agentId}`,
          meta: { resourceId: r.id, agentId: p.agentId, reason: p.health.reason },
        });
      }
    }

    for (const p of notRepairable) {
      guardian.record({
        category: 'projection',
        kind: 'projection-unrepairable',
        status: 'info',
        title: `「${skillName(r)}」在 ${agentName(p.agentId)} 里用不了`,
        detail: `原因：${REASON_TEXT[p.health.reason] || p.health.reason}`,
        advice: p.health.reason === 'authority-missing' ? '原文件已被删除，重新安装这个技能即可。' : '到资产页打开这个技能，点「诊断」查看原因。',
        signature: `proj-x|${r.id}|${p.agentId}|${p.health.reason}`,
        meta: { resourceId: r.id, agentId: p.agentId, reason: p.health.reason },
      });
    }
  }
  return { ok: true, broken, repaired, suggested };
}

function register() {
  guardian.registerAction('unproject', ({ resourceId, agentId, projectionId }) => {
    const r = rm().unproject({ resourceId, agentId, projectionId });
    return r && r.success === false ? { ok: false, error: r.error } : { ok: true };
  });
  guardian.registerAction('repairProjection', ({ resourceId }) => {
    const v = rm().verifyProjections(resourceId, { repair: true });
    const still = (v.projections || []).filter(p => p.health && !p.health.healthy && p.health.repairable);
    return still.length ? { ok: false, error: still.map(p => p.health.repairError || p.health.reason).join('; ') } : { ok: true };
  });
  guardian.registerCheck('projection', check, 30 * 60 * 1000);
}

module.exports = { register, check };
