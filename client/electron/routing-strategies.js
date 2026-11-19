'use strict';
// 路由策略注册表 —— 每个策略一个 JS 函数，按名字派发（照搬 app-handlers.js 的 PATCH_ROUTE_STRATEGIES 模式）。
// 服务端只下发「策略名」（声明式，如 policy.strategy / routing.global_strategy），JS 实现全在客户端此表里，
// 不 eval / 不 new Function 任何下发代码（与全项目一致，安全）。
//
// 契约：strategy(candidates, ctx) => 排序后的 candidates（provider 对象数组，route() 依次尝试 = failover）
//   candidates: 能服务当前请求模型的 enabled provider 对象
//   ctx: { model, latencyMap, rrKey } —— 排序所需运行时信号
//
// 供给源排序类（全局策略，不涉及具体模型）：cost / speed / fallback / round-robin / weighted / direct。
// 模型链类（用户选模型）：scene_steps —— 由 route() 先解析 steps 产出多模型链，每步的候选源再套本表排序。

/**
 * 计费档位（越小越先）：订阅 → 免费 → 预付 → 未知 → 按量。
 * 同模型多源默认按此序，再比速度。
 */
function costRank(p) {
  const src = String(p.source || p.billing_type || '').toLowerCase();
  // 订阅（OAuth / API 订阅账户）优先于一切免费与按量
  if (src === 'subscription' || src === 'sub') return 0;
  // 本机 → 我的设备 → 免费 → 社区 → 付费（E2-2）：本机跑的源（Ollama 等）、我的其他设备排在免费之前
  if (p.is_local) return 0.5;
  if (p.type === 'mesh') return 0.8;
  if (p.type === 'free') return 1;
  if (src === 'prepaid') return 2;
  if (src === 'payg' || src === 'api' || src === 'api-key' || src === 'api_key') return 4;
  // paid/p2p 未标注 source 时按按量处理，避免误插到订阅档
  if (p.type === 'paid' || p.type === 'p2p') return 4;
  return 3;
}

// 稳定排序辅助：sort 不保证稳定的 tie 处理 —— 用原索引兜底保持相对顺序
function stableSort(arr, cmp) {
  return arr.map((v, i) => [v, i]).sort((a, b) => cmp(a[0], b[0]) || (a[1] - b[1])).map(x => x[0]);
}

function _speedScore(p, ctx) {
  const lat = ctx.latencyMap || {};
  // 优先 ctx.speedByProvider[providerId]（同模型分源 TTFT），再 latencyMap
  const byProv = ctx.speedByProvider || {};
  const v = byProv[p.id] != null ? byProv[p.id] : lat[p.id];
  return (v == null || !Number.isFinite(Number(v)) ? Infinity : Number(v));
}

function orderCost(cands) {
  return stableSort(cands, (a, b) => costRank(a) - costRank(b));
}

function orderSpeed(cands, ctx) {
  return stableSort(cands, (a, b) => _speedScore(a, ctx) - _speedScore(b, ctx));
}

/** 默认同模型多源：先计费档，再同档比速度（学习到的 TTFT） */
function orderBillingThenSpeed(cands, ctx = {}) {
  return stableSort(cands, (a, b) => (
    (costRank(a) - costRank(b)) || (_speedScore(a, ctx) - _speedScore(b, ctx))
  ));
}

// round-robin 轮转起点（按 key 记忆，其余作 failover 备用）
const _rr = new Map();
function orderRoundRobin(cands, ctx) {
  if (cands.length <= 1) return [...cands];
  const key = ctx.rrKey || 'default';
  const idx = (_rr.get(key) || 0) % cands.length;
  _rr.set(key, idx + 1);
  return [...cands.slice(idx), ...cands.slice(0, idx)];
}

function orderWeighted(cands) {
  const total = cands.reduce((s, p) => s + (p.weight || 1), 0);
  if (!total || cands.length <= 1) return [...cands];
  let rand = Math.random() * total;   // 主进程可用 Math.random（非 workflow 沙箱）
  let chosen = cands.length - 1;
  for (let i = 0; i < cands.length; i++) { rand -= (cands[i].weight || 1); if (rand <= 0) { chosen = i; break; } }
  return [cands[chosen], ...cands.filter((_, i) => i !== chosen)];
}

const ROUTING_STRATEGIES = {
  fallback:      (cands) => [...cands],                    // 按候选原顺序依次 failover
  cost:          (cands, ctx) => orderBillingThenSpeed(cands, ctx), // 订阅→免费→按量，同类再比速度
  speed:         (cands, ctx) => orderSpeed(cands, ctx),   // 速度优先：低延迟先，不通再慢的
  latency:       (cands, ctx) => orderSpeed(cands, ctx),   // 别名（兼容旧 policy 的 latency）
  'round-robin': (cands, ctx) => orderRoundRobin(cands, ctx),
  weighted:      (cands) => orderWeighted(cands),
  direct:        (cands) => cands.slice(0, 1),             // 只用第一个，不 failover
};

/** 派发：按名字取策略函数排序候选源；未知名字回退 fallback；策略抛错不影响请求。 */
function orderCandidates(strategyName, candidates, ctx = {}) {
  const fn = ROUTING_STRATEGIES[strategyName] || ROUTING_STRATEGIES.fallback;
  try { return fn(candidates || [], ctx) || []; }
  catch { return candidates || []; }
}

// ── 策略路由用：对 (供给源, 模型) 候选按策略排序（模型无关，扫某类型下所有候选） ──
// candidate: { providerId, providerTier, source, model, price, speedMs, weight }
//   providerTier: 供给源层 'free'|'paid'|'p2p'；source: 计费来源 'subscription'|'payg'|…
//   price: 模型刊例价（可空，cost 的次级排序）；speedMs: 实测延迟（可空，speed 用）
function _costRankCand(c) {
  const s = String(c.source || '').toLowerCase();
  if (s === 'subscription' || s === 'sub') return 0;
  if (c.providerTier === 'free') return 1;
  if (s === 'prepaid') return 2;
  if (s === 'payg' || s === 'api' || s === 'api-key' || s === 'api_key') return 4;
  if (c.providerTier === 'paid' || c.providerTier === 'p2p') return 4;
  return 3;
}
function orderModelCandidates(strategyName, cands, ctx = {}) {
  const arr = [...(cands || [])];
  const n = (v, d) => (v == null || !Number.isFinite(Number(v)) ? d : Number(v));
  try {
    switch (strategyName) {
      case 'auto':          // 综合最优：计费档优先，再比实测延迟（避免同模型反复走慢源）
        return stableSort(arr, (a, b) => (
          (_costRankCand(a) - _costRankCand(b))
          || (n(a.speedMs, Infinity) - n(b.speedMs, Infinity))
        ));
      case 'cost':          // 订阅→免费→按量；同类先比速度，再比刊例价
        return stableSort(arr, (a, b) => (
          (_costRankCand(a) - _costRankCand(b))
          || (n(a.speedMs, Infinity) - n(b.speedMs, Infinity))
          || (n(a.price, Infinity) - n(b.price, Infinity))
        ));
      case 'speed':         // 实测延迟低的先，无数据最后
        return stableSort(arr, (a, b) => n(a.speedMs, Infinity) - n(b.speedMs, Infinity));
      case 'adaptive': {    // 自适应：Thompson 采样从历史结果学出每类请求最优模型；冷启动退综合最优
        try {
          const rp = require('./route-policy-runtime');
          const out = rp.rankCandidates(arr, ctx.reqCtx || null);
          if (out && out.length) return out;
        } catch { /* 运行时不可用 → 退 auto */ }
        return orderModelCandidates('auto', arr, ctx);
      }
      case 'round-robin':   return orderRoundRobin(arr, ctx);
      case 'weighted':      return orderWeighted(arr);
      case 'fallback':
      default:              return arr;
    }
  } catch { return arr; }
}

/** 已注册的全局供给源排序策略名（供 UI 下拉/校验）。scene_steps 不在此列（属模型链类）。 */
const GLOBAL_STRATEGY_NAMES = ['auto', 'adaptive', 'cost', 'speed', 'fallback', 'round-robin', 'weighted'];

module.exports = {
  ROUTING_STRATEGIES, orderCandidates, orderModelCandidates, costRank,
  orderBillingThenSpeed, orderCost, orderSpeed, GLOBAL_STRATEGY_NAMES,
};
