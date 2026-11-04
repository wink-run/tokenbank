// 前端 ESM 入口（逻辑与 shared/route-binding.js 保持同步）
// 应用 route_id 绑定：场景路由 or tier:model（同模型跨层时区分 P2P / 付费 / 免费）

const TIER_ROUTE_RE = /^(free|p2p|paid):(.+)$/;

// ── 分层路由 codec：strategy:scope:tier:sharer:provider:model（与 shared/route-binding.js 同步）──
// scope=来源（personal 个人源 / community 社区），与 tier=价格（free/paid）正交、可组合。
export const STRATEGY_NAMES = ['auto', 'adaptive', 'cost', 'speed', 'round-robin', 'weighted', 'fallback', 'direct'];
export const SCOPE_NAMES    = ['personal', 'community'];   // 来源维度（与 tier 价格维度正交）
export const TIER_NAMES     = ['free', 'p2p', 'paid'];     // p2p 保留兼容旧数据；新数据社区走 scope
export const SHARER_RE      = /^s_[a-z0-9]+$/i;

const _STRAT_SET = new Set(STRATEGY_NAMES);
const _SCOPE_SET = new Set(SCOPE_NAMES);
const _TIER_SET  = new Set(TIER_NAMES);

/** 规范化编码：固定顺序 strategy:scope:tier:sharer:provider:model，空层跳过。 */
export function encodeRoute(parts = {}) {
  const { strategy, scope, tier, sharer, provider, model } = parts;
  return [strategy, scope, tier, sharer, provider, model].filter(Boolean).join(':');
}

/** 解析规范串 → { strategy, scope, tier, sharer, provider, model }（缺省 null）。
 *  与 shared/route-binding.js 逻辑保持一致（双路径）：
 *   - 传入 knownProviders 白名单时：从左消费已知 codec/provider 段，首个未知段起整段作 model，
 *     模型名内含 ':'（Ollama name:tag，如 qwen2.5:32b）不被截断；
 *   - 不传白名单时：按位置解析（含 / 的段起整段作 model；否则末段=model、前导未识别段作 provider）。 */
export function parseRoute(str, knownProviders = null) {
  const out = { strategy: null, scope: null, tier: null, sharer: null, provider: null, model: null };
  const s = String(str == null ? '' : str).trim();
  if (!s) return out;
  const provSet = knownProviders instanceof Set ? knownProviders
    : (Array.isArray(knownProviders) ? new Set(knownProviders) : null);
  const segs = s.split(':');
  if (segs.length === 1) {
    const seg = segs[0];
    if (_STRAT_SET.has(seg))      out.strategy = seg;
    else if (_SCOPE_SET.has(seg)) out.scope = seg;
    else if (_TIER_SET.has(seg))  out.tier = seg;
    else if (SHARER_RE.test(seg)) out.sharer = seg;
    else                          out.model = seg;
    return out;
  }

  if (provSet) {
    let i = 0;
    for (; i < segs.length - 1; i++) {
      const seg = segs[i];
      if (_STRAT_SET.has(seg) && !out.strategy)      { out.strategy = seg; continue; }
      if (_SCOPE_SET.has(seg) && !out.scope)         { out.scope = seg; continue; }
      if (_TIER_SET.has(seg) && !out.tier)           { out.tier = seg; continue; }
      if (SHARER_RE.test(seg) && !out.sharer)        { out.sharer = seg; continue; }
      if (provSet.has(seg) && !out.provider)         { out.provider = seg; continue; }
      break;
    }
    out.model = segs.slice(i).join(':');
    return out;
  }

  // OpenRouter 等：模型段含 org/name，后缀可再带 :free → 不能「末段=model」
  let modelStart = -1;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].includes('/')) { modelStart = i; break; }
  }
  if (modelStart >= 0) {
    out.model = segs.slice(modelStart).join(':');
    for (const seg of segs.slice(0, modelStart)) {
      if (_STRAT_SET.has(seg) && !out.strategy)      out.strategy = seg;
      else if (_SCOPE_SET.has(seg) && !out.scope)    out.scope = seg;
      else if (_TIER_SET.has(seg) && !out.tier)      out.tier = seg;
      else if (SHARER_RE.test(seg) && !out.sharer)   out.sharer = seg;
      else if (!out.provider)                        out.provider = seg;
    }
    return out;
  }

  out.model = segs[segs.length - 1];
  for (const seg of segs.slice(0, -1)) {
    if (_STRAT_SET.has(seg) && !out.strategy)      out.strategy = seg;
    else if (_SCOPE_SET.has(seg) && !out.scope)    out.scope = seg;
    else if (_TIER_SET.has(seg) && !out.tier)      out.tier = seg;
    else if (SHARER_RE.test(seg) && !out.sharer)   out.sharer = seg;
    else if (!out.provider)                        out.provider = seg;
  }
  return out;
}

export function encodeTierModelRoute(tier, modelId) {
  if (!modelId) return '';
  if (!tier) return modelId;
  return `${tier}:${modelId}`;
}

/** 解析 route_id → { routeId, modelId, tier, isScene, scene? } */
export function parseRouteBinding(routeId, routes = []) {
  if (!routeId) {
    return { routeId: '', modelId: '', tier: null, isScene: false, scene: null };
  }
  const scene = routes.find(r => r.model_key === routeId || r.id === routeId);
  if (scene) {
    return { routeId, modelId: '', tier: null, isScene: true, scene };
  }
  const m = TIER_ROUTE_RE.exec(routeId);
  if (m) {
    return { routeId, modelId: m[2], tier: m[1], isScene: false, scene: null };
  }
  return { routeId, modelId: routeId, tier: null, isScene: false, scene: null };
}

export function modelIdFromRoute(routeId, routes = []) {
  const p = parseRouteBinding(routeId, routes);
  if (p.isScene) return '';
  return parseRoute(p.modelId || routeId).model || '';
}

/** 下拉框 value：场景路由用 model_key；单层模型用 tier:id；legacy 纯 id 尽量还原 */
export function routeSelectValue(routeId, availableModels = [], routes = []) {
  if (!routeId) return '';
  const scene = routes.find(r => r.model_key === routeId || r.id === routeId);
  if (scene) return scene.model_key || routeId;
  // paid:/free: 是纯模型，不收成同名降级链
  if (TIER_ROUTE_RE.test(routeId)) return routeId;
  const matches = availableModels.filter(m => m.id === routeId);
  if (matches.length >= 1) {
    // 与网关 defaultRouteId 一致：同名模型优先社区 P2P，避免 legacy 纯 id 误显示为付费层
    const order = { p2p: 0, paid: 1, free: 2 };
    const pick = [...matches].sort((a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9))[0];
    return encodeTierModelRoute(pick.tier, routeId);
  }
  return routeId;
}

export function isKnownRouteSelectValue(val, availableModels = [], routes = []) {
  if (!val) return false;
  if (routes.some(r => r.model_key === val || r.id === val)) return true;
  return availableModels.some(m => encodeTierModelRoute(m.tier, m.id) === val);
}
