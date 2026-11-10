// client/electron/guardian/projection-heal.js
// 投射自愈：应用升级、目录被清理后，技能的软链 / 复制会失效，应用里就「看不到」了。
// 定期离线检查（只读文件系统，不碰任何请求）；auto 直接修复并可撤销，suggest 记一条建议。
'use strict';

const guardian = require('./index');

function judgment() {
  return require('./judgment');
}

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

/** 判断「原文件不见了 / 修不好」时的依据，学到的规则据此排除误报 */
function projectionFacts(r, p) {
  const fs = require('fs');
  const row = (r.projections || []).find(x => x.agentId === p.agentId) || {};
  const targetPath = row.targetPath || row.target_path || p.targetPath || '';
  const lst = (f) => { try { return fs.lstatSync(f); } catch { return null; } };
  const st = targetPath ? lst(targetPath) : null;
  let real = '';
  try { real = targetPath ? fs.realpathSync(targetPath) : ''; } catch { real = ''; }
  const authorityPath = r.metadata?.authorityPath || '';
  const src = String(r.source_url || '');
  return {
    resourceId: r.id,
    agentId: p.agentId,
    resourceName: r.name,
    projectionType: row.projectionType || row.projection_type || '',
    targetPath,
    targetExists: !!st,
    targetIsSymlink: !!(st && st.isSymbolicLink()),
    targetRealPath: real,
    targetRealHasSkillMd: !!real && ['SKILL.md', 'skill.md'].some(f => fs.existsSync(require('path').join(real, f))),
    authorityPath,
    authorityPathIsSymlink: !!(authorityPath && lst(authorityPath)?.isSymbolicLink()),
    sourceUrl: src,
    sourceUrlExists: !!src && src.startsWith('/') && fs.existsSync(src),
  };
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
  let gone = [];   // 原文件已被删除：修不了，合并成一条，一键撤下
  const excluded = new Set();   // 在应用里的那条按学到的规则排除了的技能（它在资产库内部的那条也不再单独提醒）
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
          countAsRepeat: false,
          title: `「${skillName(r)}」在 ${agentName(p.agentId)} 里的投射失效了`,
          detail: `原因：${REASON_TEXT[p.health.reason] || p.health.reason}`,
          actions: [{ label: '修复', done: '已修复', run: { type: 'repairProjection', data: { resourceId: r.id } } }],
          signature: `proj|${r.id}|${p.agentId}`,
          meta: { resourceId: r.id, agentId: p.agentId, reason: p.health.reason },
        });
      }
    }

    for (const p of notRepairable) {
      const sig = `proj-x|${r.id}|${p.agentId}|${p.health.reason}`;
      const facts = projectionFacts(r, p);
      const kind = p.health.reason === 'authority-missing' ? 'projection-gone' : 'projection-unrepairable';
      // 学到的规则说这种情况不算问题（之前误报过）：不提醒
      if (judgment().judge(kind, facts)) {
        guardian.resolveSignature(sig, '按学到的规则不算问题');
        broken--;
        if (!require('./diagnose').INTERNAL_TARGETS.has(p.agentId)) excluded.add(r.id);
        continue;
      }
      if (p.health.reason === 'authority-missing') {
        gone.push({ resourceId: r.id, agentId: p.agentId, name: skillName(r), facts });
        guardian.resolveSignature(sig, '合并到「原文件已被删除」');   // 旧版本一条一条记的，收起
        continue;
      }
      guardian.record({
        category: 'projection',
        kind: 'projection-unrepairable',
        status: 'info',
        countAsRepeat: false,
        title: `「${skillName(r)}」在 ${agentName(p.agentId)} 里用不了`,
        detail: `原因：${REASON_TEXT[p.health.reason] || p.health.reason}`,
        advice: '撤下后应用里就不会再出现这个坏掉的技能；资产还在，修好后可再启用。',
        signature: sig,
        facts,
        actions: [{ label: '从这个应用撤下', done: '已撤下', run: { type: 'unprojectMany', data: { items: [{ resourceId: r.id, agentId: p.agentId }] } } }],
        link: { to: '/resources', label: '诊断', state: { resourceType: 'skill', selectKey: `r-${r.id}` } },
        meta: { resourceId: r.id, agentId: p.agentId, reason: p.health.reason },
      });
    }
  }

  const internalIds = require('./diagnose').INTERNAL_TARGETS;
  gone = gone.filter(g => !(internalIds.has(g.agentId) && excluded.has(g.resourceId)));
  if (gone.length) {
    const names = [...new Set(gone.map(g => g.name))];
    const internal = require('./diagnose').INTERNAL_TARGETS;
    const apps = [...new Set(gone.filter(g => !internal.has(g.agentId)).map(g => agentName(g.agentId)))];
    const where = apps.length ? `在 ${apps.join('、')} 里用不了` : '用不了';
    await guardian.handle({
      category: 'projection',
      kind: 'projection-gone',
      status: 'suggested',
      countAsRepeat: false,
      title: names.length === 1
        ? `「${names[0]}」的原文件已被删除，${where}`
        : `${names.length} 个技能的原文件已被删除，${where}`,
      detail: names.slice(0, 12).join('、') + (names.length > 12 ? ' 等' : ''),
      advice: '撤下这些坏掉的链接，应用里就不会再看到它们；以后需要可以重新安装。',
      signature: 'proj-gone',
      factsList: gone.map(g => g.facts),
      actions: [{ label: '全部撤下', done: '已撤下坏掉的链接', auto: true, run: { type: 'unprojectMany', data: { items: gone.map(({ resourceId, agentId }) => ({ resourceId, agentId })) } } }],
      meta: { items: gone.map(({ facts, ...g }) => g) },
    });
  } else {
    guardian.resolveSignature('proj-gone');
  }
  return { ok: true, broken, repaired, suggested };
}

function register() {
  guardian.registerAction('unproject', ({ resourceId, agentId, projectionId }) => {
    const r = rm().unproject({ resourceId, agentId, projectionId });
    return r && r.success === false ? { ok: false, error: r.error } : { ok: true };
  });
  // 撤下修不好的投射（原文件没了，没法再投回去，所以不带撤销）
  guardian.registerAction('unprojectMany', ({ items = [] }) => {
    const m = rm();
    let n = 0;
    for (const it of items) {
      try { const r = m.unproject(it); if (!(r && r.success === false)) n++; } catch { /* 已撤下 */ }
    }
    return { ok: true, message: n ? '已撤下，应用里不会再看到这些坏掉的技能；需要的话可以重新安装' : '已经没有要撤下的了' };
  });
  guardian.registerAction('repairProjection', ({ resourceId }) => {
    const v = rm().verifyProjections(resourceId, { repair: true });
    const still = (v.projections || []).filter(p => p.health && !p.health.healthy && p.health.repairable);
    return still.length ? { ok: false, error: still.map(p => p.health.repairError || p.health.reason).join('; ') } : { ok: true };
  });
  guardian.registerCheck('projection', check, 30 * 60 * 1000);
}

module.exports = { register, check };
