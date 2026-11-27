// client/electron/guardian/model-heal.js
// 应用要的模型用不了（请求最终失败，报「没有这个模型 / 不可用」）：智能管家自己处理，不让用户对着报错发愣。
//   1. Claude 的模型先刷新一次 Anthropic 的模型列表：刚发布的新模型，刷新后就认识了
//   2. 还是没有：在能用的模型里找同一系列最新的（Opus 找 Opus、Sonnet 找 Sonnet、gpt 找 gpt），
//      把这个名字改道过去（model-redirects），记一条可撤销的记录
//   3. 找不到能顶上的：告诉用户，带去模型页
// 只看已经发生的失败，不重试那次请求；同一个模型名 10 分钟内只处理一次。
'use strict';

const guardian = require('./index');
const explain = require('./explain');

const RECENT_MS = 10 * 60 * 1000;
const recent = new Map();

const CLAUDE_FAMILY = /(opus|sonnet|haiku|fable|mythos)/i;

/** 同一系列：Claude 按 opus/sonnet/haiku/fable；其他按去掉版本号后的名字前缀（gpt-5.5 → gpt） */
function familyOf(model) {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('claude-')) {
    const f = CLAUDE_FAMILY.exec(m);
    return f ? `claude:${f[1].toLowerCase()}` : 'claude';
  }
  return m.replace(/[-_.]?\d.*$/, '').replace(/[-_.]+$/, '') || m;
}

function looksMissing(info) {
  const base = explain.classify(info);
  if (base.kind === 'model') return true;
  return /model\b[^\n]{0,60}(not\s+available|not\s+found|does\s+not\s+exist|no\s+access|not\s+supported)/i.test(String(info.message || ''));
}

/**
 * 挑一个能顶上的：同一系列里排在最前（模型列表新的在前）的。
 * @param {string} model 用不了的
 * @param {string[]} available 能用的（网关所有启用的来源的模型名）
 */
function pickReplacement(model, available) {
  const fam = familyOf(model);
  const redirects = require('../model-redirects').all();
  return (available || []).find((x) => x && x !== model && familyOf(x) === fam && !redirects[x]) || null;
}

async function heal(info = {}, deps = {}) {
  if (guardian.modeOf('gateway') === 'off') return null;
  const model = String(info.requestedModel || info.model || '').trim();
  if (!model || !looksMissing(info)) return null;
  // 请求名被应用绑定的路由改写成了别的模型（比如 claude-* → 用户指定的模型）：那是用户的选择，不改道
  if (info.requestedModel && info.model && info.requestedModel !== info.model) return null;
  if (info.redirectedFrom) return null;   // 已经是改道后的请求
  const redirects = deps.redirects || require('../model-redirects');
  if (redirects.get(model)) return null;   // 已经改道过（再失败是目标的问题，交给常规的换源和提醒）
  if (Date.now() - (recent.get(model) || 0) < RECENT_MS) return null;
  recent.set(model, Date.now());
  const sig = `model-redirect|${model}`;
  if (guardian.wasUndone(sig)) return null;   // 用户撤销过：不再自动改道这个名字

  const gateway = deps.gateway || require('../local-gateway');
  // 1. Claude：先刷新模型列表，可能只是刚发布、本机还不认识
  if (/^claude-/i.test(model)) {
    const live = deps.live || require('../claude-live-models');
    try { await live.refresh({ getToken: gateway.claudeSubscriptionToken, force: true }); } catch { /* 刷不了照样往下 */ }
    if (live.get(model)) {
      guardian.record({
        category: 'gateway', kind: 'model-refreshed', status: 'done',
        title: `${model} 刚才没认出来，我刷新了 Claude 的模型列表，现在有了。再发一次就行`,
        signature: `model-refreshed|${model}`,
        meta: { model },
      });
      return { action: 'refreshed' };
    }
  }

  // 2. 找同一系列能用的
  let available = [];
  try { available = gateway.localModelNames(); } catch { available = []; }
  const target = pickReplacement(model, available);
  const why = String(info.message || '').slice(0, 300);
  if (target) {
    redirects.set(model, target, { by: 'guardian', reason: why });
    guardian.record({
      category: 'gateway', kind: 'model-redirect', status: 'done',
      title: `应用要的 ${model} 用不了，我把它转到了 ${target}（同一系列里能用的最新一个）。之后再要 ${model} 都会用 ${target}`,
      detail: why,
      signature: sig,
      undo: { type: 'removeModelRedirect', data: { from: model } },
      meta: { model, target, providerId: info.providerId || null },
    });
    return { action: 'redirected', target };
  }

  // 3. 顶不上：告诉用户
  guardian.record({
    category: 'gateway', kind: 'model-missing', status: 'info', needsUser: true,
    title: `应用要的 ${model} 用不了，也没找到同一系列能顶上的模型`,
    say: `应用要的 ${model} 现在所有来源都用不了。可以在应用里换个模型，或者在「模型」页加一个提供它的来源。`,
    detail: why,
    signature: `model-missing|${model}`,
    link: { to: '/providers', label: '带我去模型页' },
    meta: { model },
  });
  return { action: 'told' };
}

function attach() {
  guardian.registerAction('removeModelRedirect', ({ from }) => {
    const ok = require('../model-redirects').remove(from);
    return ok ? { ok: true, message: `${from} 不再改道，按原名请求` } : { ok: false, message: '这条改道已经不在了' };
  });
  guardian.on('gateway:request-failed', (info) => { heal(info).catch(() => {}); });
}

module.exports = { attach, heal, familyOf, pickReplacement, looksMissing, _reset: () => recent.clear() };
