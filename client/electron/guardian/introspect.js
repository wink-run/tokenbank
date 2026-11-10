// client/electron/guardian/introspect.js
// 定期自省：实时只修失败；需要看整体数据的整理和进化放在这里离线跑一次，频率由用户在设置里定。
// 不经过模型分发和智能体调用的请求链路；只有「新模型评估」会花 token，超过单次上限就停下，只交付已完成的部分。
// 每次产出一份报告（reports.json），盘点页的「周报」卡片和设置页都读它。
'use strict';

const guardian = require('./index');
const store = require('./store');

const DAY = 24 * 60 * 60 * 1000;
const PERIOD = { daily: DAY, weekly: 7 * DAY, monthly: 30 * DAY };
const REPORTS_MAX = 12;
const TICK_MS = 15 * 60 * 1000;
const IDLE_WINDOW_SEC = 10 * 60;
const IDLE_MAX_REQUESTS = 3;
const RULE_STALE_MS = 90 * DAY;

let running = null;

function config() {
  return guardian.getSettings().introspect;
}

function state() {
  return store.readJson('introspect-state.json', {});
}

function saveState(patch) {
  store.writeJson('introspect-state.json', { ...state(), ...patch });
}

function listReports() {
  const r = store.readJson('reports.json', []);
  return Array.isArray(r) ? r : [];
}

function latestReport() {
  return listReports()[0] || null;
}

/** 网关最近 10 分钟几乎没有请求、也没有智能体任务在跑 = 闲置 */
function isIdle() {
  try {
    const d = require('../local-stats').getDb();
    if (!d) return true;
    const since = Math.floor(Date.now() / 1000) - IDLE_WINDOW_SEC;
    const n = d.prepare("SELECT COUNT(*) AS n FROM requests WHERE ts >= ? AND data_source = 'proxy' AND COALESCE(api_key, '') != 'tb-guardian'").get(since)?.n || 0;
    if (n >= IDLE_MAX_REQUESTS) return false;
    try {
      const busy = d.prepare("SELECT COUNT(*) AS n FROM agent_tasks WHERE status IN ('running','pending')").get()?.n || 0;
      if (busy > 0) return false;
    } catch { /* 没有任务表 */ }
    return true;
  } catch {
    return true;
  }
}

/** 到时间了、并且在允许的时段里 */
function isDue(now = Date.now()) {
  const c = config();
  const period = PERIOD[c.frequency];
  if (!period) return false;
  const s = state();
  const from = s.lastRunAt || s.createdAt;
  if (!from) { saveState({ createdAt: now }); return false; }
  if (now - from < period) return false;
  if (c.window === 'hour') return new Date(now).getHours() === c.hour;
  return isIdle();
}

// ── 规则库整理：淘汰长期不命中的规则（这一步就是「进化」）──────────────────
function tidyRules({ handling }) {
  const rules = store.readJson('rules.json', {});
  const now = Date.now();
  const stale = Object.entries(rules).filter(([, v]) => now - (v.lastAt || v.firstAt || 0) > RULE_STALE_MS && (v.count || 0) < 3);
  const total = Object.keys(rules).length;
  if (!stale.length) return { summary: `规则库共 ${total} 条，都还在用。`, items: [], stats: { total, removed: 0 } };
  const removed = Object.fromEntries(stale);
  const keep = Object.fromEntries(Object.entries(rules).filter(([k]) => !removed[k]));
  store.writeJson('rules.json', keep);
  const title = `规则库淘汰了 ${stale.length} 条超过 90 天没再遇到的规则`;
  const rec = guardian.record({
    category: 'gateway', kind: 'rules-tidy', status: 'done',
    title, detail: stale.map(([k]) => k).slice(0, 20).join('、'),
    undo: { type: 'restoreRules', data: { rules: removed } },
    meta: { removed: stale.length, handling },
  });
  return { summary: `规则库 ${total} 条，淘汰 ${stale.length} 条长期不命中的。`, items: [{ title, recordId: rec?.id || null }], stats: { total, removed: stale.length } };
}

function restoreRules({ rules }) {
  const cur = store.readJson('rules.json', {});
  store.writeJson('rules.json', { ...(rules || {}), ...cur });
  return { ok: true };
}

// ── 资产整理：体检（质量 / 安全 / 重复 / 新版本）+ 闲置统计 ─────────────────
async function reviewAssets({ since = 0 } = {}) {
  const a = await require('./asset-checks').check();
  if (a && a.skipped) return { summary: '资产体检已在设置里关闭。', items: [], stats: {} };
  let idle = 0;
  try {
    const m = require('../resource-manager');
    m.init();
    const r = m.listIdleSkills({ days: 30 });
    idle = Array.isArray(r) ? r.length : ((r && (r.items || r.skills || r.idle)) || []).length;
  } catch { /* ignore */ }
  const parts = [`体检了 ${a.skills || 0} 个技能`];
  if (a.quality) parts.push(`${a.quality} 个需要完善`);
  if (a.risky) parts.push(`${a.risky} 个有高风险操作`);
  if (a.duplicates) parts.push(`${a.duplicates} 对内容重复`);
  if (a.updates) parts.push(`${a.updates} 个有新版本`);
  if (idle) parts.push(`${idle} 个 30 天没用过`);
  // 能力缺口 + 发现页推荐的采纳情况
  let gaps = 0;
  try { gaps = (await require('./capability-gaps').check()).gaps || 0; } catch { /* ignore */ }
  if (gaps) parts.push(`${gaps} 类常做的事还没有对应技能`);
  const reco = require('./discover-learn').recoStats(since);
  if (reco.rate != null) parts.push(`发现页推荐采纳 ${reco.adopt} 个、不感兴趣 ${reco.dismiss} 个（采纳率 ${Math.round(reco.rate * 100)}%）`);
  return { summary: `${parts.join('，')}。`, items: [], stats: { ...a, idle, gaps, reco } };
}

const AUTO_APPLY_OK = new Set(['updateFromCatalog']);

/** 结果处理 = 可撤销的自动采纳：只采纳本次产生、能撤销的建议 */
async function autoApply(sinceTs) {
  let n = 0;
  for (const r of guardian.listRecords({ limit: 300 })) {
    if (r.status !== 'suggested' || (r.lastAt || r.at) < sinceTs || !r.apply) continue;
    if (!r.applyUndo && !AUTO_APPLY_OK.has(r.apply.type)) continue;
    const res = await guardian.apply(r.id);
    if (res.ok) n++;
  }
  return n;
}

const SECTION_ORDER = ['assets', 'routes', 'savings', 'rules', 'models'];

/** 跑一次自省。manual = 用户点了「立即自省」 */
async function run({ manual = false } = {}) {
  if (running) return { ok: false, error: 'running' };
  const c = config();
  const startedAt = Date.now();
  const s = state();
  const fallbackSpan = PERIOD[c.frequency] || PERIOD.weekly;
  const since = s.lastRunAt ? Math.max(s.lastRunAt, startedAt - 30 * DAY) : startedAt - fallbackSpan;
  const days = Math.max(1, Math.min(30, Math.round((startedAt - since) / DAY)));
  const budget = { used: 0, cap: c.tokenCap, stopped: false };
  const scope = new Set(c.scope);

  running = (async () => {
    const sections = {};
    const review = require('./review-usage');
    for (const key of SECTION_ORDER) {
      if (!scope.has(key)) continue;
      try {
        if (key === 'assets') sections.assets = await reviewAssets({ since });
        else if (key === 'routes') sections.routes = await review.reviewRoutes({ sinceSec: Math.floor(since / 1000) });
        else if (key === 'savings') sections.savings = review.reviewSavings({ sinceSec: Math.floor(since / 1000), days });
        else if (key === 'rules') sections.rules = tidyRules({ handling: c.handling });
        else if (key === 'models') {
          if (budget.cap <= 0) sections.models = { summary: '单次 token 上限为 0，跳过新模型试跑。', items: [], stats: {} };
          else sections.models = await require('./review-models').reviewModels({ budget });
        }
      } catch (e) {
        sections[key] = { summary: `这一项没跑完：${e.message}`, items: [], error: true };
      }
    }
    const applied = c.handling === 'auto' ? await autoApply(startedAt) : 0;

    const all = guardian.listRecords({ limit: 300 });
    const handled = all.filter(r => r.status === 'done' && r.at >= since && r.at < startedAt);
    const pending = all.filter(r => r.status === 'suggested');
    const report = {
      id: `rpt-${startedAt.toString(36)}`,
      at: startedAt, finishedAt: Date.now(), since, days, manual,
      tokensUsed: budget.used, tokenCap: budget.cap, stoppedForCap: budget.stopped,
      frequency: c.frequency, handling: c.handling, autoApplied: applied,
      handled: { count: handled.length, titles: handled.slice(0, 5).map(r => r.title) },
      pending: { count: pending.length, titles: pending.slice(0, 5).map(r => r.title) },
      sections,
    };
    store.writeJson('reports.json', [report, ...listReports()].slice(0, REPORTS_MAX));
    saveState({ lastRunAt: startedAt, lastReportId: report.id });
    return report;
  })();
  try {
    const report = await running;
    return { ok: true, report };
  } finally {
    running = null;
  }
}

async function tick() {
  if (!guardian.getSettings().enabled || running) return { ok: true, skipped: true };
  if (!isDue()) return { ok: true, due: false };
  const r = await run({ manual: false });
  return { ok: r.ok, ran: true };
}

function register() {
  guardian.registerAction('restoreRules', restoreRules);
  guardian.registerCheck('introspect', tick, TICK_MS);
}

module.exports = { register, run, tick, isDue, isIdle, listReports, latestReport, isRunning: () => !!running, _internal: { tidyRules, PERIOD } };
