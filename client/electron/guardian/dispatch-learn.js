// client/electron/guardian/dispatch-learn.js
// 派发与汇总的纠正学习（游乐场）：
//  - 场景路由修正：用户把一类任务从 A 改派给 B（算一次纠正）。同一类任务改派够多、方向一致，
//    就给聚合入口的主 Agent 加一条派发偏好（「写提交信息这类子任务优先派给 Codex」）。纯规则，不调模型。
//  - 汇总失败复盘：用户对聚合入口的结果「重做」或追问纠错时，异步对照子智能体的原始结果，
//    找汇总里的遗漏和没说明的失败；同一原因反复出现，就给主 Agent 加一条汇总规则。
// 都只改「下一次任务」读到的说明，不动正在执行的任务；每条修正写进自动处理记录，可撤销。
'use strict';

const guardian = require('./index');
const store = require('./store');
const { topicsOf } = require('./capability-gaps');

const MAX_EVENTS = 500;
const PREF_MIN = 3;          // 同一类任务至少改派 3 次
const PREF_AGREE = 0.7;      // 其中至少 70% 改派到同一个智能体
const SUMMARY_MIN = 2;       // 同一汇总问题出现 2 次就加规则
const CORRECTION_RE = /不对|错了|漏了|遗漏|没提到|没有提到|没说|少了|不完整|重新(汇总|整理|总结)|你忘了|搞错|wrong|missing|missed|incomplete|you forgot|not what i asked/i;

const SUMMARY_RULES = {
  omission: '汇总时逐个列出每个子智能体的实际产出（文件路径、关键结论、数字），不要省略或合并掉。',
  'hidden-failure': '有子任务失败、超时或没完成时，必须在汇总里单独列出「失败 / 未完成」及原因，不能只报成功部分。',
  unclear: '汇总前先对照用户原始要求逐条检查是否都覆盖到了，没覆盖的明确说出来。',
};

function agentName(id) {
  try { return require('../config-loader').appEntityById(id)?.name || id; } catch { return id; }
}

function readEvents() {
  const r = store.readJson('dispatch-feedback.json', []);
  return Array.isArray(r) ? r : [];
}

function tuning() {
  const t = store.readJson('dispatch-tuning.json', {});
  return { prefs: t.prefs || {}, summaryRules: Array.isArray(t.summaryRules) ? t.summaryRules : [] };
}

function saveTuning(t) {
  store.writeJson('dispatch-tuning.json', t);
}

const off = () => guardian.modeOf('gateway') === 'off';

/** 主 Agent 每次启动时读：派发偏好 + 汇总规则（看护关掉或没有时为空） */
function orchestratorHints() {
  if (off()) return [];
  const t = tuning();
  const lines = [];
  const prefs = Object.entries(t.prefs);
  if (prefs.length) {
    lines.push('【派发偏好（Token Bank 看护根据用户的改派习惯总结，list 里有该智能体时优先）】');
    for (const [topic, p] of prefs) lines.push(`- 「${p.label || topic}」这类子任务优先派给 ${agentName(p.agentId)}（${p.agentId}）。`);
  }
  if (t.summaryRules.length) {
    lines.push('【汇总要求（看护根据用户对汇总的纠正总结）】');
    for (const code of t.summaryRules) if (SUMMARY_RULES[code]) lines.push(`- ${SUMMARY_RULES[code]}`);
  }
  return lines;
}

// ── 动作（采纳 / 撤销）──────────────────────────────────────────────────────
function setDispatchPref({ topic, label, agentId }) {
  const t = tuning();
  t.prefs[topic] = { agentId, label, at: Date.now() };
  saveTuning(t);
  return { ok: true };
}

function removeDispatchPref({ topic, prev }) {
  const t = tuning();
  if (prev) t.prefs[topic] = prev; else delete t.prefs[topic];
  saveTuning(t);
  return { ok: true };
}

function addSummaryRule({ code }) {
  const t = tuning();
  if (!t.summaryRules.includes(code)) t.summaryRules.push(code);
  saveTuning(t);
  return { ok: true };
}

function removeSummaryRule({ code }) {
  const t = tuning();
  t.summaryRules = t.summaryRules.filter(c => c !== code);
  saveTuning(t);
  return { ok: true };
}

// ── 场景路由修正 ────────────────────────────────────────────────────────────
function learnReassign(topic) {
  const events = readEvents().filter(e => e.type === 'reassign' && e.topic === topic.id).slice(0, 10);
  if (events.length < PREF_MIN) return null;
  const counts = {};
  for (const e of events) counts[e.to] = (counts[e.to] || 0) + 1;
  const [to, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (n < PREF_MIN || n / events.length < PREF_AGREE) return null;
  const t = tuning();
  if (t.prefs[topic.id]?.agentId === to) return null;
  const prev = t.prefs[topic.id] || null;
  const data = { topic: topic.id, label: topic.label, agentId: to };
  const title = `「${topic.label}」这类任务以后优先派给 ${agentName(to)}`;
  const advice = `你把这类任务改派给 ${agentName(to)} ${n} 次了。之后聚合入口派子任务时会优先选它（只影响下一次任务；你直接指定智能体时照你的来）。`;
  const sig = `dispatch-pref|${topic.id}|${to}`;
  if (guardian.modeOf('gateway') === 'auto') {
    setDispatchPref(data);
    return guardian.record({
      category: 'gateway', kind: 'dispatch-pref', status: 'done', title, advice, signature: sig,
      undo: { type: 'removeDispatchPref', data: { topic: topic.id, prev } },
      meta: data,
    });
  }
  return guardian.record({
    category: 'gateway', kind: 'dispatch-pref', status: 'suggested', title, advice, signature: sig,
    apply: { type: 'setDispatchPref', data },
    applyUndo: { type: 'removeDispatchPref', data: { topic: topic.id, prev } },
    meta: data,
  });
}

// ── 汇总失败复盘 ────────────────────────────────────────────────────────────
function db() {
  try { return require('../local-stats').getDb(); } catch { return null; }
}

function parseResult(raw) {
  try {
    const r = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    return String(r.summary || r.output || r.text || '');
  } catch { return String(raw || ''); }
}

/** 子结果里的「硬信息」：文件路径、链接、带单位或较长的数字 */
function keyFacts(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,6}\b|https?:\/\/[^\s)）]+|\b[\w-]+\.(?:md|js|ts|py|json|png|jpg|mp4|pdf|csv|xlsx|html)\b/g)) out.add(m[0]);
  for (const m of s.matchAll(/\b\d{3,}(?:\.\d+)?\s?(?:%|ms|s|MB|GB|KB|行|个|条|次|元)?/g)) out.add(m[0].trim());
  return [...out].slice(0, 20);
}

/** 对照主任务汇总和子任务原始结果，找遗漏和没说明的失败 */
function reviewSummary(parentTaskId) {
  const d = db();
  if (!d || !parentTaskId) return { causes: [], findings: [] };
  let parent = null;
  let children = [];
  try {
    parent = d.prepare('SELECT id, prompt, result, status FROM agent_tasks WHERE id = ?').get(parentTaskId);
    children = d.prepare("SELECT id, agent_id, status, result, error FROM agent_tasks WHERE context LIKE ?").all(`%"parentTaskId":"${parentTaskId}"%`);
  } catch { /* 旧库 */ }
  if (!parent) return { causes: [], findings: [] };
  const summary = parseResult(parent.result);
  const findings = [];
  const causes = new Set();
  for (const c of children) {
    const who = agentName(c.agent_id);
    if (c.status === 'failed' || c.status === 'cancelled') {
      if (!/失败|未完成|没完成|超时|出错|failed|error|timeout|incomplete/i.test(summary)) {
        causes.add('hidden-failure');
        findings.push(`${who} 的子任务${c.status === 'failed' ? '失败' : '被取消'}了，汇总里没有说明`);
      }
      continue;
    }
    const missing = keyFacts(parseResult(c.result)).filter(f => !summary.includes(f));
    if (missing.length) {
      causes.add('omission');
      findings.push(`${who} 的产出里有 ${missing.slice(0, 3).join('、')}${missing.length > 3 ? ` 等 ${missing.length} 项` : ''}，汇总里没提到`);
    }
  }
  if (!causes.size) causes.add('unclear');
  return { causes: [...causes], findings, children: children.length };
}

function learnSummary(evt) {
  const r = reviewSummary(evt.taskId);
  const counts = store.readJson('summary-causes.json', {});
  for (const c of r.causes) counts[c] = (counts[c] || 0) + 1;
  store.writeJson('summary-causes.json', counts);
  guardian.record({
    category: 'gateway', kind: 'summary-review', status: 'info',
    title: r.findings.length ? `汇总复盘：${r.findings[0]}` : '汇总复盘：子结果都在汇总里，可能是没对准你的要求',
    detail: r.findings.join('；') || undefined,
    advice: evt.type === 'redo' ? '你要求重做了这次汇总。' : '你在追问里指出了汇总的问题。',
    signature: `summary-review|${evt.taskId}`,
    meta: { taskId: evt.taskId, causes: r.causes, children: r.children },
  });
  const t = tuning();
  for (const code of r.causes) {
    const need = code === 'unclear' ? SUMMARY_MIN + 1 : SUMMARY_MIN;
    if ((counts[code] || 0) < need || t.summaryRules.includes(code)) continue;
    const title = `汇总规则：${SUMMARY_RULES[code]}`;
    const advice = `同类汇总问题已经出现 ${counts[code]} 次。加上后从下一次聚合入口任务开始生效。`;
    if (guardian.modeOf('gateway') === 'auto') {
      addSummaryRule({ code });
      guardian.record({ category: 'gateway', kind: 'summary-rule', status: 'done', title, advice, signature: `summary-rule|${code}`, undo: { type: 'removeSummaryRule', data: { code } }, meta: { code } });
    } else {
      guardian.record({ category: 'gateway', kind: 'summary-rule', status: 'suggested', title, advice, signature: `summary-rule|${code}`, apply: { type: 'addSummaryRule', data: { code } }, applyUndo: { type: 'removeSummaryRule', data: { code } }, meta: { code } });
    }
  }
  return r;
}

/**
 * 游乐场上报一次纠正。evt:
 *  - { type: 'reassign', from, to, prompt, taskId }   改派（单智能体页签）
 *  - { type: 'redo', mode, agentId, prompt, taskId }   要求重做
 *  - { type: 'followup', mode, prompt, prevTaskId }    聚合入口里的追问（含纠错词才算纠正）
 */
function feedback(evt = {}) {
  if (off()) return { ok: true, skipped: true };
  const type = evt.type;
  if (!['reassign', 'redo', 'followup'].includes(type)) return { ok: false, error: 'bad-type' };
  if (type === 'followup' && !(evt.mode === 'orchestrator' && CORRECTION_RE.test(String(evt.prompt || '')))) return { ok: true, skipped: true };
  const topic = topicsOf(evt.prompt)[0] || null;
  const e = {
    type, at: Date.now(), topic: topic?.id || null,
    from: evt.from || evt.agentId || null, to: evt.to || null, mode: evt.mode || 'direct',
    taskId: evt.taskId || evt.prevTaskId || null, prompt: String(evt.prompt || '').slice(0, 200),
  };
  store.writeJson('dispatch-feedback.json', [e, ...readEvents()].slice(0, MAX_EVENTS));
  guardian.learnRule(`dispatch|${type}`, { countDelta: 1 });
  let learned = null;
  if (type === 'reassign' && topic && e.to && e.to !== e.from) learned = learnReassign(topic);
  if ((type === 'redo' || type === 'followup') && e.mode === 'orchestrator' && e.taskId) {
    // 复盘放到下一拍，不占游乐场这次请求的时间
    setImmediate(() => { try { learnSummary(e); } catch (err) { console.warn('[guardian] summary review:', err.message); } });
  }
  return { ok: true, learned: !!learned };
}

function register() {
  guardian.registerAction('setDispatchPref', setDispatchPref);
  guardian.registerAction('removeDispatchPref', removeDispatchPref);
  guardian.registerAction('addSummaryRule', addSummaryRule);
  guardian.registerAction('removeSummaryRule', removeSummaryRule);
}

module.exports = { register, feedback, orchestratorHints, reviewSummary, keyFacts, SUMMARY_RULES, CORRECTION_RE, _internal: { learnSummary, tuning } };
