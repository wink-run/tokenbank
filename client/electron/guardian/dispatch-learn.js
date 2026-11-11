// client/electron/guardian/dispatch-learn.js
// 派发偏好学习（游乐场）：用户把一类任务从 A 改派给 B（算一次纠正）。同一类任务改派够多、方向一致，
// 就给聚合入口的主 Agent 加一条派发偏好（「写提交信息这类子任务优先派给 Codex」）。纯规则，不调模型。
// 只改「下一次任务」读到的说明，不动正在执行的任务；每条修正写进处理记录，可撤销。
'use strict';

const guardian = require('./index');
const store = require('./store');
const { topicsOf } = require('./capability-gaps');

const MAX_EVENTS = 500;
const PREF_MIN = 3;          // 同一类任务至少改派 3 次
const PREF_AGREE = 0.7;      // 其中至少 70% 改派到同一个智能体
function agentName(id) {
  try { return require('../config-loader').appEntityById(id)?.name || id; } catch { return id; }
}

function readEvents() {
  const r = store.readJson('dispatch-feedback.json', []);
  return Array.isArray(r) ? r : [];
}

function tuning() {
  const t = store.readJson('dispatch-tuning.json', {});
  return { ...t, prefs: t.prefs || {} };
}

function saveTuning(t) {
  store.writeJson('dispatch-tuning.json', t);
}

const off = () => guardian.modeOf('gateway') === 'off';

/** 主 Agent 每次启动时读：派发偏好（智能管家关掉或没有时为空） */
function orchestratorHints() {
  if (off()) return [];
  const t = tuning();
  const lines = [];
  const prefs = Object.entries(t.prefs);
  if (prefs.length) {
    lines.push('【派发偏好（Token Bank 智能管家根据用户的改派习惯总结，list 里有该智能体时优先）】');
    for (const [topic, p] of prefs) lines.push(`- 「${p.label || topic}」这类子任务优先派给 ${agentName(p.agentId)}（${p.agentId}）。`);
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

/**
 * 游乐场上报一次改派。evt: { type: 'reassign', from, to, prompt, taskId }
 * （重做、追问这类上报不再处理，直接忽略）
 */
function feedback(evt = {}) {
  if (off()) return { ok: true, skipped: true };
  if (evt.type !== 'reassign') return { ok: true, skipped: true };
  const topic = topicsOf(evt.prompt)[0] || null;
  const e = {
    type: 'reassign', at: Date.now(), topic: topic?.id || null,
    from: evt.from || evt.agentId || null, to: evt.to || null,
    taskId: evt.taskId || null, prompt: String(evt.prompt || '').slice(0, 200),
  };
  store.writeJson('dispatch-feedback.json', [e, ...readEvents()].slice(0, MAX_EVENTS));
  const learned = topic && e.to && e.to !== e.from ? learnReassign(topic) : null;
  return { ok: true, learned: !!learned };
}

function register() {
  guardian.registerAction('setDispatchPref', setDispatchPref);
  guardian.registerAction('removeDispatchPref', removeDispatchPref);
  // 老版本加过的汇总要求：撤销时清掉
  guardian.registerAction('removeSummaryRule', () => ({ ok: true }));
}

module.exports = { register, feedback, orchestratorHints, _internal: { tuning } };
