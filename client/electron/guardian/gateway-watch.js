// client/electron/guardian/gateway-watch.js
// 供给源失败：网关本身已经做了冷却与切换，这里只在「必须用户自己动手」时提醒（Key 失效、额度用完）。
// 只读网关推来的失败事件，不改路由、不重试请求、不调模型。
'use strict';

const guardian = require('./index');
const explain = require('./explain');

let attached = false;

// 同一来源 + 模型连续失败的次数（成功一次就清零）。到阈值就把它排到后面，事件驱动，不查库、不定时
const STREAK_DEFAULT = 5;
const streaks = new Map();

function streakKey(info) {
  return `${info.providerId}::${info.model}`;
}

function noteSuccess(info = {}) {
  if (info.providerId && info.model) streaks.delete(streakKey(info));
}

function threshold(info) {
  const t = require('./store').readJson('thresholds.json', {});
  const v = Number(t[streakKey(info)] ?? t.default);
  return Number.isFinite(v) && v >= 2 && v <= 50 ? v : STREAK_DEFAULT;
}

function noteStreak(info) {
  if (!info.providerId || !info.model) return;
  const k = streakKey(info);
  const n = (streaks.get(k) || 0) + 1;
  streaks.set(k, n);
  if (n !== threshold(info)) return;
  const review = require('./review-usage');
  if (review.isDemoted(info.providerId, info.model)) return;
  const who = info.providerLabel || info.providerId;
  const sig = `route-demote|${info.model}|${info.providerId}`;
  if (guardian.wasUndone(sig)) return;   // 用户撤销过：不再自动下沉这一对
  const r = review.demote({ provider: info.providerId, model: info.model });
  if (!r.ok) return;
  guardian.record({
    category: 'gateway', kind: 'route-demoted', status: 'done',
    title: `${info.model} 在「${who}」上连续失败 ${n} 次，我把它排到了后面（其他来源都不行时仍会用它）`,
    signature: sig,
    undo: { type: 'undemoteRoute', data: { provider: info.providerId, model: info.model } },
    facts: { provider: info.providerId, model: info.model, streak: n },
    meta: { provider: info.providerId, model: info.model },
  });
}

async function handleFailure(type, info = {}) {
  if (guardian.modeOf('gateway') === 'off') return;
  const base = explain.classify(info);
  if (type === 'attempt-failed') { noteStreak(info); return; }
  if (base.kind !== 'auth' && base.kind !== 'quota') return;   // 其它的网关已经自动换源，不打扰
  const who = info.providerLabel || info.providerId || '供给源';
  guardian.record({
    category: 'gateway',
    kind: base.kind === 'quota' ? 'quota-alert' : 'provider-failure',
    status: 'info',
    needsUser: true,
    title: `${who}：${base.title}`,
    say: base.kind === 'quota'
      ? `「${who}」的额度用完了。请求会先走其他来源，暂时不影响使用。`
      : `「${who}」的 Key 失效了。请求会先走其他来源，暂时不影响使用，但其他来源一出问题就没有退路了。`,
    detail: [info.model && `模型 ${info.model}`, info.status && `HTTP ${info.status}`, info.message && String(info.message).slice(0, 300)]
      .filter(Boolean).join(' · '),
    signature: explain.signatureOf(info, base.kind),
    link: { to: '/providers', label: base.kind === 'quota' ? '带我去看额度' : '带我去换 Key' },
    meta: { providerId: info.providerId, model: info.model, kind: base.kind, event: type, until: info.until || null },
  });
}

/** 挂到网关模块上（桌面版 main.js / Docker cli/gateway.js 启动时调用） */
function attach(gatewayModule) {
  if (attached || !gatewayModule || typeof gatewayModule.setGuardianListener !== 'function') return false;
  attached = true;
  gatewayModule.setGuardianListener((type, info) => guardian.emit(`gateway:${type}`, info));
  guardian.on('gateway:cooldown', (info) => handleFailure('cooldown', info));
  guardian.on('gateway:request-failed', (info) => handleFailure('request-failed', info));
  guardian.on('gateway:attempt-failed', (info) => handleFailure('attempt-failed', info));
  guardian.on('gateway:request-ok', (info) => noteSuccess(info));
  return true;
}

module.exports = { attach, handleFailure, noteSuccess, _internal: { streaks } };
