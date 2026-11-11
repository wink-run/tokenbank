// client/electron/guardian/review-usage.js
// 路由检查（离线）：读最近 7 天的网关请求记录，某模型在某来源上总失败或明显更慢，就把它排到后面（可撤销）。
// 只读 local-stats 里已经落库的数据，不发请求；下沉只是调整候选顺序，仍可兜底。
'use strict';

const guardian = require('./index');

const MIN_CALLS = 10;
const BAD_FAIL_RATE = 0.3;
const GOOD_FAIL_RATE = 0.1;
const SLOW_RATIO = 2;

function cooldown() {
  try { return require('../gateway-cooldown'); } catch { return null; }
}

/** 这一对（供给源 + 模型）用户已经让看护下沉过了：不用再提 */
function isDemoted(provider, model) {
  const c = cooldown();
  return !!(c && c.entryOf(c.demoteKey(provider, model)));
}

function demoteAction(provider, model, label) {
  return {
    label, done: '已下沉', auto: true,
    run: { type: 'demoteRoute', data: { provider, model } },
    undo: { type: 'undemoteRoute', data: { provider, model } },
  };
}

function db() {
  try { return require('../local-stats').getDb(); } catch { return null; }
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

function providerName(id) {
  try {
    const { readAgentConfig } = require('../../shared/config-loader');
    const p = ((readAgentConfig() || {}).providers || []).find(x => x && x.id === id);
    return (p && (p.name || p.label)) || id;
  } catch { return id; }
}

/** 按模型 + 供给源汇总（只看网关实时记录，不含会话补录） */
function routeStats(sinceSec) {
  const d = db();
  if (!d) return [];
  try {
    return d.prepare(`
      SELECT model, provider_id AS provider, tier,
        COUNT(*) AS calls,
        SUM(CASE WHEN (status_code >= 400) OR (error IS NOT NULL AND error != '') THEN 1 ELSE 0 END) AS fails,
        AVG(CASE WHEN status_code < 400 AND latency_ms > 0 THEN latency_ms END) AS avgLatency,
        SUM(COALESCE(cost_usd, 0)) AS cost,
        SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) AS tokens
      FROM requests
      WHERE ts >= ? AND data_source = 'proxy' AND model IS NOT NULL AND provider_id IS NOT NULL
        AND COALESCE(api_key, '') != 'tb-guardian'
      GROUP BY model, provider_id, tier`).all(sinceSec);
  } catch (e) {
    console.warn('[guardian] routeStats failed:', e.message);
    return [];
  }
}

/** 网关路由：哪个模型在哪个来源上不稳、同一模型哪个来源更快；智能体派发：哪个运行时常失败 */
async function reviewRoutes({ sinceSec }) {
  const items = [];
  const rows = routeStats(sinceSec);
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }

  for (const [model, list] of byModel) {
    for (const r of list) {
      if (r.calls < MIN_CALLS) continue;
      const rate = r.fails / r.calls;
      if (rate < BAD_FAIL_RATE || isDemoted(r.provider, model)) continue;
      const routeFacts = { model, provider: r.provider, calls: r.calls, fails: r.fails, failRate: Math.round(rate * 100) / 100 };
      if (require('./judgment').judge('review-route-unstable', routeFacts)) continue;
      const better = list
        .filter(x => x !== r && x.calls >= 5 && x.fails / x.calls <= GOOD_FAIL_RATE)
        .sort((a, b) => a.fails / a.calls - b.fails / b.calls)[0];
      const advice = better
        ? `同一个模型在「${providerName(better.provider)}」上失败率只有 ${pct(better.fails / better.calls)}。下沉后请求先走其它来源，这个只在都失败时兜底。`
        : '下沉后请求先走其它来源，这个只在都失败时兜底（不会删除）；没有其它来源的话，建议给这个模型加一个。';
      const title = `${model} 在「${providerName(r.provider)}」上 ${r.calls} 次请求失败 ${r.fails} 次（${pct(rate)}）`;
      // 下沉没风险、可撤销：「供给源」是自动处理就直接做
      const rec = await guardian.handle({
        category: 'gateway', kind: 'review-route-unstable', status: 'suggested', countAsRepeat: false,
        title, advice, signature: `review-route|${model}|${r.provider}`, facts: routeFacts,
        actions: [demoteAction(r.provider, model, '下沉这个来源')],
        link: { to: '/gateway', label: '查看路由' },
        meta: { model, provider: r.provider, calls: r.calls, fails: r.fails, better: better?.provider || null },
      });
      items.push({ title, advice: rec?.status === 'done' ? `已自动下沉，可在看护里撤销。${advice}` : advice, recordId: rec?.id || null });
    }

    const healthy = list.filter(x => x.calls >= MIN_CALLS && x.fails / x.calls <= GOOD_FAIL_RATE && x.avgLatency > 0);
    if (healthy.length >= 2) {
      healthy.sort((a, b) => a.avgLatency - b.avgLatency);
      const fast = healthy[0];
      const slow = healthy[healthy.length - 1];
      if (slow.avgLatency / fast.avgLatency >= SLOW_RATIO && !isDemoted(slow.provider, model)) {
        const title = `${model}：「${providerName(fast.provider)}」比「${providerName(slow.provider)}」快 ${(slow.avgLatency / fast.avgLatency).toFixed(1)} 倍`;
        const advice = `平均耗时 ${Math.round(fast.avgLatency)}ms 对 ${Math.round(slow.avgLatency)}ms，两边都很稳，建议让快的先上。`;
        const rec = await guardian.handle({
          category: 'gateway', kind: 'review-route-slow', status: 'suggested', countAsRepeat: false,
          title, advice, signature: `review-route-slow|${model}`,
          actions: [demoteAction(slow.provider, model, `让「${providerName(fast.provider)}」先上`)],
          link: { to: '/gateway', label: '查看路由' },
          meta: { model, fast: fast.provider, slow: slow.provider },
        });
        items.push({ title, advice, recordId: rec?.id || null });
      }
    }
  }

  const totalCalls = rows.reduce((s, r) => s + r.calls, 0);
  const totalFails = rows.reduce((s, r) => s + r.fails, 0);
  return {
    summary: totalCalls
      ? `这段时间网关处理 ${totalCalls} 次请求，失败 ${totalFails} 次（${pct(totalFails / totalCalls)}）；${items.length ? `${items.length} 条调整建议` : '路由没发现需要调整的地方'}。`
      : '这段时间网关没有请求记录。',
    stats: { calls: totalCalls, fails: totalFails },
    items,
  };
}

const DEMOTE_DAYS = 14;

/** 把这一对（来源 + 模型）排到候选末尾 14 天；仍可兜底，不删除 */
function demote({ provider, model }) {
  const c = cooldown();
  if (!c || !provider || !model) return { ok: false, error: '网关不可用' };
  c.demote(provider, model, DEMOTE_DAYS * 24 * 60 * 60 * 1000, 'guardian');
  return { ok: true, message: `${DEMOTE_DAYS} 天内请求先走其它来源，这个只在都失败时兜底` };
}

function register() {
  // 下沉：这一对排到候选末尾 14 天（仍可兜底，不删除）；撤销 = 恢复原来的顺序
  guardian.registerAction('demoteRoute', demote);
  guardian.registerAction('undemoteRoute', ({ provider, model }) => {
    const c = cooldown();
    if (c) c.undemote(provider, model);
    return { ok: true };
  });
}

const WINDOW_DAYS = 7;

async function check() {
  if (guardian.modeOf('gateway') === 'off') return { ok: true, skipped: true };
  const r = await reviewRoutes({ sinceSec: Math.floor(Date.now() / 1000) - WINDOW_DAYS * 24 * 60 * 60 });
  return { ok: true, calls: r.stats.calls, fails: r.stats.fails, items: r.items.length };
}

module.exports = { register, check, reviewRoutes, demote, isDemoted, _internal: { routeStats, providerName } };
