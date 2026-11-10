// client/electron/guardian/discover-learn.js
// 发现页的学习：
//  - 推荐：记下「采纳」和「不感兴趣」。不感兴趣的 30 天内不再推；同一类被忽略 2 次以上，这类往后排；
//    下一轮发现时把它们写进提示里，让发现智能体避开。采纳率进自省报告。
//  - 画像：用户删掉的画像条目、改过的一句话画像，下次生成画像时作为约束带进去，不再生成回来。
// 只存在本机（~/.tokenbank/guardian），不上传。
'use strict';

const store = require('./store');

const DAY = 24 * 60 * 60 * 1000;
const HIDE_DAYS = 30;
const DOWN_RANK_AFTER = 2;
const MAX_ENTRIES = 500;

function readReco() {
  const r = store.readJson('reco-feedback.json', { entries: [] });
  return Array.isArray(r.entries) ? r : { entries: [] };
}

/** action: adopt | dismiss | undismiss */
function recoFeedback({ action, key, name = '', type = '', category = '' } = {}) {
  if (!key || !['adopt', 'dismiss', 'undismiss'].includes(action)) return { ok: false, error: 'bad-input' };
  const r = readReco();
  let entries = r.entries.filter(e => !(e.key === key && e.type === type && (action !== 'adopt' || e.action === 'adopt')));
  if (action !== 'undismiss') entries.unshift({ key, name: String(name).slice(0, 120), type, category: String(category).slice(0, 60), action, at: Date.now() });
  entries = entries.slice(0, MAX_ENTRIES);
  store.writeJson('reco-feedback.json', { entries });
  return { ok: true };
}

/** 发现页用：要藏起来的、要往后排的类别、写进提示的避开清单 */
function recoState({ type = '', now = Date.now() } = {}) {
  const entries = readReco().entries.filter(e => !type || e.type === type);
  const dismissed = entries.filter(e => e.action === 'dismiss' && now - e.at < HIDE_DAYS * DAY);
  const byCat = {};
  for (const e of dismissed) if (e.category) byCat[e.category] = (byCat[e.category] || 0) + 1;
  return {
    hidden: dismissed.map(e => e.key),
    downCategories: Object.keys(byCat).filter(c => byCat[c] >= DOWN_RANK_AFTER),
    avoid: dismissed.slice(0, 20).map(e => e.name || e.key),
  };
}

/** 自省用：这段时间的采纳 / 忽略次数 */
function recoStats(sinceMs = 0) {
  const entries = readReco().entries.filter(e => e.at >= sinceMs);
  const adopt = entries.filter(e => e.action === 'adopt').length;
  const dismiss = entries.filter(e => e.action === 'dismiss').length;
  return { adopt, dismiss, rate: adopt + dismiss ? adopt / (adopt + dismiss) : null };
}

// ── 画像 ────────────────────────────────────────────────────────────────────
const FIELDS = new Set(['traits', 'goals', 'extensions', 'needs', 'persona']);

/** action: remove（field + text）| edit（persona：from → to） */
function portraitFeedback({ action, field, text = '', from = '', to = '' } = {}) {
  if (!FIELDS.has(field)) return { ok: false, error: 'bad-field' };
  const p = store.readJson('portrait-feedback.json', { removed: [], persona: null });
  if (action === 'remove' && String(text).trim()) {
    const t = String(text).trim().slice(0, 120);
    p.removed = [{ field, text: t, at: Date.now() }, ...(p.removed || []).filter(x => !(x.field === field && x.text === t))].slice(0, 60);
  } else if (action === 'edit' && field === 'persona' && String(to).trim()) {
    p.persona = { from: String(from).slice(0, 200), to: String(to).trim().slice(0, 200), at: Date.now() };
  } else {
    return { ok: false, error: 'bad-input' };
  }
  store.writeJson('portrait-feedback.json', p);
  return { ok: true };
}

/** 生成画像时附加的约束（中文提示行）；没有修改记录时为空数组 */
function portraitConstraints() {
  const p = store.readJson('portrait-feedback.json', { removed: [], persona: null });
  const lines = [];
  if (p.persona && p.persona.to) lines.push(`- 我亲自把一句话画像改成了：「${p.persona.to}」。persona 沿这个方向写，不要改回原来的说法。`);
  const label = { traits: '性格与风格', goals: '能力域', extensions: '延伸兴趣', needs: '资源方向' };
  const removed = (p.removed || []).slice(0, 20);
  if (removed.length) {
    lines.push('- 我删掉过这些画像条目，说明它们不符合我，不要再生成相同或相近的内容：');
    for (const r of removed) lines.push(`  · ${label[r.field] || r.field}：${r.text}`);
  }
  return lines;
}

module.exports = { recoFeedback, recoState, recoStats, portraitFeedback, portraitConstraints, HIDE_DAYS };
