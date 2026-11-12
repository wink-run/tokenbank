import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { encodeRoute, modelIdFromRoute, parseRoute } from '../lib/route-binding';
import { prefixModelRoutes } from '../lib/model-prefix-routes';
import { modelVendor } from '../lib/model-vendor';
import { modelTypeLabel, modelTypeBtnClass } from './PersonalSources';
import ServiceIcon from './ServiceIcon';
import { speedDotClass, speedTitle, useSpeedMap, speedFor, bucketFromMs, normModelKey } from '../lib/speed';
import { getNetwork } from '../api/client';
import { buildNetworkModelStatsMap, normalizeNetworkPayload } from '../lib/networkModelStats';

// 社区(p2p)模型速度：拉一次 /public/network，按模型名 → 最快 worker 的 TTFT。与供给源卡同源。
function useCommunitySpeed() {
  const [map, setMap] = useState({});
  useEffect(() => {
    let alive = true;
    getNetwork()
      .then(r => {
        const stats = buildNetworkModelStatsMap(normalizeNetworkPayload(r?.data ?? r));
        const out = {};
        for (const [model, v] of Object.entries(stats)) out[normModelKey(model)] = v.minLatency || 0;
        if (alive) setMap(out);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  return map;
}

function encodeTierModelRoute(tier, modelId) {
  if (!modelId) return '';
  if (!tier) return modelId;
  return `${tier}:${modelId}`;
}

function modelTierKey(m) {
  return encodeTierModelRoute(m.tier, m.id);
}

const BARE_PROVIDER_IDS = new Set(['p2p', 'tokenbank-p2p', 'local', 'anthropic', 'tokenbank']);

/** 下拉里要画图标的供给源 id。社区源和降级链不画。 */
function dropdownProviderId(m) {
  const provider = String(m?.owner || '').trim();
  if (!provider || BARE_PROVIDER_IDS.has(provider)) return '';
  return provider;
}

/** 普通模型钉到具体供给源。降级链另有一行，值是链 id。 */
/** 一个模型在下拉框里的默认值（和下拉框选中标记一致）；游乐场等处设默认选中时用 */
export function routeOptionValue(m) {
  if (m?.tier === 'p2p') return modelTierKey(m);
  const owner = String(m?.owner || '').trim();
  if (!owner || BARE_PROVIDER_IDS.has(owner)) return modelTierKey(m);
  return encodeRoute({ tier: m.tier || 'paid', provider: owner, model: m.id });
}

function sceneRouteAllSteps(route) {
  return [...(route?.steps || []), ...(route?.rules || []).flatMap(r => r.steps || [])];
}

/** 钉死模型在本地不可用 → 与场景路由列表「需重新设置」同口径 */
function sceneRouteNeedsReset(route, avail) {
  return sceneRouteAllSteps(route).some(s => (s.model || s.label) && !avail.has(s.model || s.label));
}

function isUsableSceneRoute(route, avail) {
  if (sceneRouteNeedsReset(route, avail)) return false;
  if (route.strategy || route.flow) return true;
  return sceneRouteAllSteps(route).some(s =>
    s.strategy || s.scope || s.tier || s.provider || s.sharer || avail.has(s.model || s.label)
  );
}

/** 可绑到应用的场景路由。降级链不出现在场景路由里。 */
export function usableSceneRoutes(routes, availableModels) {
  const avail = new Set((availableModels || []).map(m => m.id || m.name));
  return (routes || []).filter(r => !r.list_route && isUsableSceneRoute(r, avail));
}

/** 场景路由 + 模型分层选项（供其他原生 <select> 复用） */
export function routeSelectChildren({ routes, availableModels, t, showOfficial, showGatewayRoutes, isManual }) {
  const usable = usableSceneRoutes(routes, availableModels);
  const showRoutes = showGatewayRoutes !== false;
  return (
    <>
      {isManual
        ? null
        : (showOfficial !== false ? <option value="">{t('gateway.app.routeOfficial')}</option> : null)}
      {showRoutes && usable.length > 0 && (
        <optgroup label={t('gateway.app.sceneRoutes')}>
          {usable.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon && !r.icon.startsWith('icon:') ? r.icon + ' ' : ''}{r.scene_name}</option>)}
        </optgroup>
      )}
      {showRoutes && tierOptgroups(availableModels, t)}
    </>
  );
}

export function tierOptgroups(availableModels, t) {
  const local = (availableModels || []).filter(m => m.tier === 'free' || m.tier === 'paid');
  const remote = (availableModels || []).filter(m => m.tier === 'p2p');
  const grp = (key, models) => (models.length ? (
    <optgroup key={key} label={t(`gateway.app.tier.${key}`)}>
      {models.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{modelOptionLabel(m, t)}</option>)}
    </optgroup>
  ) : null);
  return [grp('local', local), grp('remote', remote)];
}

/**
 * 与模型页同一套隐藏规则：
 * 已写进某条降级链、且不是链头的模型不再单独列出；移出后恢复。
 * 还没保存过的自动前缀链，同样只留链头。前缀只在本地模型之间合并，避免社区模型被顺带收走。
 */
function chainListState(routes, availableModels) {
  const heads = new Set();
  const hidden = new Set();
  const savedHeads = new Set();
  for (const route of routes || []) {
    if (!route?.list_route) continue;
    const head = String(route.model_key || '').trim();
    if (!head) continue;
    savedHeads.add(head);
    heads.add(head);
    for (const step of route.steps || []) {
      const name = String(step?.model || '').trim();
      if (name && name !== head) hidden.add(name);
    }
  }
  const localIds = (availableModels || [])
    .filter(m => m.tier === 'free' || m.tier === 'paid')
    .map(m => m.id);
  const { extras, folded } = prefixModelRoutes(localIds);
  for (const [head, extra] of extras) {
    if (extra?.length) heads.add(head);
    // 链头已经有用户保存的步骤时，以保存结果为准，被移出的模型重新出现。
    // v4.1 / v4-1 不是用户移出的，始终跟链头走。
    if (savedHeads.has(head)) {
      for (const name of extra) {
        if (folded?.has(name)) hidden.add(name);
      }
      continue;
    }
    for (const name of extra) hidden.add(name);
  }
  return { heads, hidden };
}

/** 弹出菜单条目 */
function buildRouteMenuItems({ routes, availableModels, t, showGatewayRoutes, isManual, showOfficial, chainHeads, hiddenModels }) {
  const items = [];
  if (!isManual && showOfficial !== false) {
    items.push({ kind: 'option', value: '', label: t('gateway.app.routeOfficial') });
  }
  if (showGatewayRoutes === false) return items;

  const usable = usableSceneRoutes(routes, availableModels);
  if (usable.length) {
    items.push({ kind: 'group', label: t('gateway.app.sceneRoutes') });
    for (const r of usable) {
      const icon = r.icon && !String(r.icon).startsWith('icon:') ? `${r.icon} ` : '';
      items.push({ kind: 'option', value: r.model_key || r.id, label: `${icon}${r.scene_name}` });
    }
  }
  const listed = (m) => !hiddenModels?.has(m.id);
  const local = (availableModels || []).filter(m => (m.tier === 'free' || m.tier === 'paid') && listed(m));
  const remote = (availableModels || []).filter(m => m.tier === 'p2p' && listed(m));
  // 每个模型只列一次：个人账户和社区合在一起，后面写有哪些来源；按厂商分组
  const byId = new Map();
  const entry = (m) => {
    if (!byId.has(m.id)) byId.set(m.id, { id: m.id, locals: [], remote: null, type: m.type });
    return byId.get(m.id);
  };
  for (const m of local) if (m?.id) entry(m).locals.push(m);
  for (const m of remote) if (m?.id) { const e = entry(m); e.remote = m; e.type = e.type || m.type; }
  const sourceName = (m) => String(m?.providerName || m?.owner || '').trim();
  const groups = new Map();
  for (const e of byId.values()) {
    const v = modelVendor(e.id);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(e);
  }
  const ordered = [...groups.entries()].sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]));
  const seenValues = new Set(items.filter(it => it.kind === 'option').map(it => it.value));
  for (const [vendor, list] of ordered) {
    list.sort((a, b) => ((chainHeads?.has(b.id) ? 1 : 0) - (chainHeads?.has(a.id) ? 1 : 0)) || String(a.id).localeCompare(String(b.id)));
    const rows = [];
    for (const e of list) {
      const chain = !!chainHeads?.has(e.id);
      const communityOnly = !e.locals.length;
      // 默认值：降级链用链头；只有社区有用社区；其它用第一个个人账户（不会悄悄扣积分）
      const value = chain ? e.id : (communityOnly ? modelTierKey(e.remote) : routeOptionValue(e.locals[0]));
      if (seenValues.has(value)) continue;
      seenValues.add(value);
      const names = [...new Set(e.locals.map(sourceName).filter(Boolean))];
      const sources = [...names, ...(e.remote ? [t('gateway.app.sourceCommunity')] : [])];
      // 多个来源时可以展开，指定只用某一个
      const pins = [];
      if (!communityOnly && (e.locals.length > 1 || e.remote)) {
        for (const m of e.locals) {
          const v = routeOptionValue(m);
          if (v !== value && !pins.some(p => p.value === v)) pins.push({ value: v, label: t('gateway.app.pinOnly', { name: sourceName(m) || m.owner }) });
        }
        if (e.remote) pins.push({ value: modelTierKey(e.remote), label: t('gateway.app.pinCommunity'), community: true });
        if (!chain && e.locals.length) {
          pins.unshift({ value, label: t('gateway.app.pinOnly', { name: sourceName(e.locals[0]) || e.locals[0].owner }), isDefault: true });
        }
      }
      rows.push({
        kind: 'option', value, label: String(e.id), modelId: e.id, type: e.type, chain,
        owner: '', tier: communityOnly ? 'p2p' : undefined,
        sub: sources.join(' · '), communityOnly, pins: pins.filter(p => p.value !== value || p.isDefault),
      });
    }
    if (rows.length) {
      items.push({ kind: 'group', label: vendor });
      items.push(...rows);
    }
  }
  return items;
}

// 触发器底色跟随所在行/主题，避免实心白块贴在灰色表格上
export const ROUTE_SELECT_COMPACT = 'w-full min-w-0 max-w-full text-[11px] bg-transparent border border-zinc-200/80 dark:border-white/10 rounded-[6px] px-1.5 py-1 outline-none text-zinc-700 dark:text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed transition-[border-color,box-shadow,background-color] duration-200';
export const ROUTE_SELECT_NORMAL = 'w-full text-sm bg-transparent border border-zinc-200/80 dark:border-white/10 rounded-lg px-3 py-1.5 outline-none text-zinc-800 dark:text-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-[border-color,box-shadow,background-color] duration-200';
export const ROUTE_SELECT_OPEN = 'bg-white/35 dark:bg-white/[0.06] ring-[2px] ring-[#007AFF]/25 border-[#007AFF]/30 shadow-[0_0_0_1px_rgba(0,122,255,0.12)]';

const PANEL_MAX_H = 240;
const PANEL_MARGIN = 8;
const PANEL_FOOTER_H = 28;

/** 独立顶层 Portal，避免被 #root / 表格 overflow 遮挡 */
function getPortalRoot() {
  let el = document.getElementById('route-select-portal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'route-select-portal';
    el.style.cssText = 'position:fixed;inset:0;z-index:99990;pointer-events:none;';
    document.body.appendChild(el);
  }
  return el;
}

/** 根据视口空间计算弹出位置，不足时向上展开 */
function computePanelPos(triggerEl) {
  const r = triggerEl.getBoundingClientRect();
  const width = Math.max(r.width, 200);
  let left = r.left;
  if (left + width > window.innerWidth - PANEL_MARGIN) left = window.innerWidth - width - PANEL_MARGIN;
  if (left < PANEL_MARGIN) left = PANEL_MARGIN;

  const footerH = PANEL_FOOTER_H;
  const spaceBelow = window.innerHeight - r.bottom - PANEL_MARGIN;
  const spaceAbove = r.top - PANEL_MARGIN;
  const openDown = spaceBelow >= 120 + footerH || spaceBelow >= spaceAbove;

  if (openDown) {
    return {
      top: r.bottom + 4,
      bottom: null,
      left,
      width,
      maxHeight: Math.min(PANEL_MAX_H + footerH, Math.max(96 + footerH, spaceBelow)),
      openUp: false,
    };
  }
  return {
    top: null,
    bottom: window.innerHeight - r.top + 4,
    left,
    width,
    maxHeight: Math.min(PANEL_MAX_H + footerH, Math.max(96 + footerH, spaceAbove)),
    openUp: true,
  };
}

/** 毛玻璃弹出层主题 */
const POPUP_THEME = {
  compact: {
    panel: [
      'font-[system-ui,-apple-system,BlinkMacSystemFont,"SF_Pro_Text","Segoe_UI",sans-serif]',
      'antialiased subpixel-antialiased',
      'text-[11px] leading-[16px] tracking-[-0.01em]',
      'rounded-[12px]',
      'border border-zinc-200/80 dark:border-white/[0.12]',
      'bg-white/95 dark:bg-zinc-900/95',
      'backdrop-blur-3xl backdrop-saturate-[200%]',
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_0_0_0.5px_rgba(255,255,255,0.35),0_8px_32px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.06)]',
      'py-1.5',
    ].join(' '),
    row: 'flex items-center min-h-[22px] py-[3px] pl-2 pr-2.5 mx-1 rounded-[7px] cursor-default select-none transition-[background-color,color,box-shadow] duration-100 ease-out',
    rowActive: 'bg-[#007AFF]/75 backdrop-blur-md text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]',
    rowIdle: 'text-zinc-800/90 dark:text-zinc-100/90',
    check: 'w-[15px] shrink-0 flex items-center justify-center',
    group: 'mx-1 px-2 pt-1 pb-0.5 text-[11px] font-semibold text-zinc-500/80 dark:text-zinc-400/80 cursor-default select-none',
    chevron: 'w-2.5 h-2.5 shrink-0 text-zinc-500/70 dark:text-zinc-400/70',
    footer: 'shrink-0 flex items-center justify-between gap-2 border-t border-white/35 dark:border-white/[0.08] px-2 py-1',
    footerSingle: 'shrink-0 flex items-center border-t border-white/35 dark:border-white/[0.08] px-2 py-1',
    selectedHint: 'text-[10px] text-zinc-500/90 dark:text-zinc-400/90 tabular-nums shrink-0',
    confirmBtn: 'rounded-[5px] bg-[#007AFF] hover:bg-[#0066E0] active:bg-[#005BD0] text-white text-[10px] font-medium px-2 py-0.5 leading-none transition-colors shrink-0',
  },
  normal: {
    panel: [
      'font-[system-ui,-apple-system,BlinkMacSystemFont,"SF_Pro_Text","Segoe_UI",sans-serif]',
      'antialiased subpixel-antialiased',
      'text-[13px] leading-[18px] tracking-[-0.01em]',
      'rounded-[14px]',
      'border border-zinc-200/80 dark:border-white/[0.12]',
      'bg-white/95 dark:bg-zinc-900/95',
      'backdrop-blur-3xl backdrop-saturate-[200%]',
      'shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_0_0_0.5px_rgba(255,255,255,0.35),0_12px_40px_rgba(0,0,0,0.14),0_4px_12px_rgba(0,0,0,0.06)]',
      'py-2',
    ].join(' '),
    row: 'flex items-center min-h-[28px] py-[4px] pl-2.5 pr-3 mx-1.5 rounded-[8px] cursor-default select-none transition-[background-color,color,box-shadow] duration-100 ease-out',
    rowActive: 'bg-[#007AFF]/75 backdrop-blur-md text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.28)]',
    rowIdle: 'text-zinc-800/90 dark:text-zinc-100/90',
    check: 'w-[18px] shrink-0 flex items-center justify-center',
    group: 'mx-1.5 px-2.5 pt-1 pb-0.5 text-[13px] font-semibold text-zinc-500/80 dark:text-zinc-400/80 cursor-default select-none',
    chevron: 'w-3 h-3 shrink-0 text-zinc-500/70 dark:text-zinc-400/70',
    footer: 'shrink-0 flex items-center justify-between gap-2 border-t border-white/35 dark:border-white/[0.08] px-2.5 py-1',
    footerSingle: 'shrink-0 flex items-center border-t border-white/35 dark:border-white/[0.08] px-2.5 py-1',
    selectedHint: 'text-[11px] text-zinc-500/90 dark:text-zinc-400/90 tabular-nums shrink-0',
    confirmBtn: 'rounded-md bg-[#007AFF] hover:bg-[#0066E0] active:bg-[#005BD0] text-white text-[11px] font-medium px-2.5 py-1 leading-none transition-colors shrink-0',
  },
};

/** 下拉里只留一个「链」，悬停再看完整名称。选中行改成浅色字，避免糊在蓝底上。 */
function ChainBadge({ t, active, compact }) {
  const activeCls = active
    ? 'border border-white/45 bg-white/20 text-white'
    : 'bg-zinc-200/80 dark:bg-zinc-700 text-zinc-500 border border-transparent';
  return (
    <span
      title={t('psrc.route.custom')}
      className={`shrink-0 font-sans leading-none rounded ${compact ? 'text-[9px] px-1 py-px' : 'text-[10px] px-1.5 py-0.5'} ${activeCls}`}
    >
      {t('psrc.route.chainMark')}
    </span>
  );
}

/** 生图 / 嵌入模型在列表项右侧显示的模态标识 */
function ModelTypeBadge({ type, t, active, compact }) {
  if (!type || type === 'chat') return null;
  const label = modelTypeLabel(type, t);
  const idle = modelTypeBtnClass(type);
  const activeCls = active
    ? 'border border-white/45 bg-white/20 text-white'
    : `${idle} border border-transparent`;
  return (
    <span
      className={`shrink-0 font-sans leading-none rounded ${compact ? 'text-[9px] px-1 py-px' : 'text-[10px] px-1.5 py-0.5'} ${activeCls}`}
      title={type === 'image' ? t('providers.models.image') : t('providers.models.embedding')}
    >
      {label}
    </span>
  );
}

/** 下拉文案。降级链只留模型名；其余写成 providerId:模型名。 */
export function formatModelDropdownLabel(m, { chain = false } = {}) {
  const id = String(m?.id || m?.name || '').trim();
  if (!id || chain) return id;
  const provider = String(m?.owner || '').trim();
  if (!provider || BARE_PROVIDER_IDS.has(provider)) return id;
  return `${provider}:${id}`;
}

function modelOptionLabel(m, t) {
  const name = formatModelDropdownLabel(m);
  if (!m?.type || m.type === 'chat') return name;
  const badge = modelTypeLabel(m.type, t);
  return `${name} · ${badge}`;
}

function isChainRouteValue(routeId, routes) {
  const bare = modelIdFromRoute(routeId, routes) || String(routeId || '');
  return (routes || []).some(r => r?.list_route && (
    r.model_key === routeId || r.model_key === bare || r.id === routeId
  ));
}

function routeOptionDisplayLabel(routeId, routes, availableModels) {
  const scene = (routes || []).find(r => !r.list_route && (r.model_key === routeId || r.id === routeId));
  if (scene) {
    const icon = scene.icon && !String(scene.icon).startsWith('icon:') ? `${scene.icon} ` : '';
    return `${icon}${scene.scene_name}`;
  }
  const bare = modelIdFromRoute(routeId, routes) || routeId || '';
  // 降级链的选中值就是链头模型名，不加供给源
  if (isChainRouteValue(routeId, routes)) return bare;
  const owners = (availableModels || []).map(m => m.owner).filter(Boolean);
  const parsed = parseRoute(String(routeId || ''), owners);
  if (parsed.provider && parsed.model && !BARE_PROVIDER_IDS.has(parsed.provider)) {
    return parsed.model;
  }
  const m = (availableModels || []).find(x => modelTierKey(x) === routeId)
    || (availableModels || []).find(x => x.id === bare);
  return m?.id || bare;
}

/** 选中值对应的供给源 id，用来在触发器上画图标。降级链没有。 */
function routeOptionProvider(routeId, routes, availableModels) {
  if (!routeId || isChainRouteValue(routeId, routes)) return '';
  const owners = (availableModels || []).map(m => m.owner).filter(Boolean);
  const parsed = parseRoute(String(routeId || ''), owners);
  if (parsed.provider && !BARE_PROVIDER_IDS.has(parsed.provider)) return parsed.provider;
  const bare = modelIdFromRoute(routeId, routes) || routeId || '';
  const m = (availableModels || []).find(x => modelTierKey(x) === routeId)
    || (availableModels || []).find(x => x.id === bare);
  return dropdownProviderId(m);
}

function resolveTriggerLabel({ multi, value, values, routes, availableModels, t, isManual, displayText }) {
  const labelOf = (id) => routeOptionDisplayLabel(id, routes, availableModels);
  if (multi) {
    const selected = (values || []).filter(Boolean);
    if (isManual && selected.length === 0) return '—';
    if (selected.length === 0) return t('gateway.app.routeOfficial');
    if (selected.length > 1 && displayText) return displayText;
    if (selected.length === 1) return labelOf(selected[0]);
    return isManual ? '—' : t('gateway.app.routeOfficial');
  }
  if (isManual && !value) return '—';
  if (!value) return t('gateway.app.routeOfficial');
  return labelOf(value) || (isManual ? '—' : t('gateway.app.routeOfficial'));
}

function RouteChevron({ className, open }) {
  return (
    <svg
      className={`${className} transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 单选：✓ 标记 */
function RouteCheckIcon({ marked, active, compact }) {
  if (!marked) return null;
  const stroke = active ? '#ffffff' : '#007AFF';
  const size = compact ? 11 : 13;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true" className="drop-shadow-[0_0.5px_0_rgba(255,255,255,0.4)]">
      <path
        d="M2.5 6.2 5 8.7 9.5 3.8"
        stroke={stroke}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 多选：checkbox + 勾，暗示可多选 */
function RouteCheckboxIcon({ marked, active, compact }) {
  const box = compact ? 'w-3 h-3 rounded-[3px]' : 'w-3.5 h-3.5 rounded-[4px]';
  const tick = compact ? 8 : 9;
  const idleBox = 'border border-zinc-400/55 dark:border-zinc-500/65 bg-white/40 dark:bg-white/[0.06]';
  const hoverBox = 'border border-white/75 bg-white/25';
  const checkedBox = active
    ? 'border border-white bg-white shadow-[inset_0_0_0_1px_rgba(0,122,255,0.15)]'
    : 'border border-[#007AFF] bg-[#007AFF]';
  const tickStroke = active ? '#007AFF' : '#ffffff';

  return (
    <span
      className={`${box} shrink-0 flex items-center justify-center transition-colors duration-75 ${
        marked ? checkedBox : (active ? hoverBox : idleBox)
      }`}
      aria-hidden="true"
    >
      {marked && (
        <svg width={tick} height={tick} viewBox="0 0 10 10" fill="none">
          <path
            d="M2 5.2 4.2 7.4 8 2.8"
            stroke={tickStroke}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

/** 供给源小图标，悬停仍能看到 provider id。 */
function ProviderGlyph({ id, compact }) {
  if (!id) return null;
  const box = compact ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const img = compact ? 'w-3 h-3' : 'w-3.5 h-3.5';
  return (
    <span className="inline-flex shrink-0 mr-1">
      <ServiceIcon
        id={id}
        name={id}
        title={id}
        boxClass={`${box} !rounded-sm !bg-transparent`}
        imgClass={img}
        className="!bg-transparent"
      />
    </span>
  );
}

function RouteMenuRow({ mark, label, owner, modelType, chain, active, theme, compact, multi, t, onEnter, onClick, isModel, speed, sub = '', communityOnly = false, canExpand = false, expanded = false, onToggle = null, indent = false }) {
  return (
    <div
      role={multi ? 'menuitemcheckbox' : 'option'}
      aria-checked={multi ? !!mark : undefined}
      aria-selected={multi ? undefined : !!mark}
      className={`${theme.row} ${active ? theme.rowActive : theme.rowIdle}`}
      onMouseEnter={onEnter}
      // 按下就选中。等 click 时，外层 mousedown 可能已经把浮层卸掉，选不中。
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick?.();
      }}
    >
      <span className={theme.check}>
        {multi
          ? <RouteCheckboxIcon marked={mark} active={active} compact={compact} />
          : <RouteCheckIcon marked={mark} active={active} compact={compact} />}
      </span>
      {isModel && (
        <span title={speed?.title || speedTitle(speed)} className={`w-1.5 h-1.5 rounded-full shrink-0 mr-1.5 ${speedDotClass(speed?.bucket)}`} />
      )}
      {owner ? <ProviderGlyph id={owner} compact={compact} /> : null}
      <span className={`flex-1 min-w-0 ${indent ? 'pl-3' : ''}`}>
        <span className="block truncate">{label}</span>
        {sub ? <span className={`block truncate text-[10px] ${active ? 'text-white/80' : 'text-zinc-500 dark:text-zinc-400'}`}>{sub}</span> : null}
      </span>
      {(chain || communityOnly || (modelType && modelType !== 'chat')) && (
        <span className="flex items-center gap-1 shrink-0 ml-1.5">
          {communityOnly && <span className={`text-[10px] leading-none px-1 py-0.5 rounded ${active ? 'bg-white/25 text-white' : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'}`}>{t('gateway.app.communityOnly')}</span>}
          {chain && <ChainBadge t={t} active={active} compact={compact} />}
          <ModelTypeBadge type={modelType} t={t} active={active} compact={compact} />
        </span>
      )}
      {canExpand && (
        <button type="button" aria-expanded={expanded} aria-label={t('gateway.app.pinExpand')}
          className={`shrink-0 ml-1 w-6 h-6 flex items-center justify-center rounded ${active ? 'text-white hover:bg-white/20' : 'text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-white/10'}`}
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onToggle?.(); }}>
          {expanded ? '▾' : '▸'}
        </button>
      )}
    </div>
  );
}

/**
 * 路由下拉（单选 / 多选共用同款触发器 + 弹出层）
 */
export default function RouteSelect({
  multi = false,
  value = '',
  values = [],
  onChange,
  routes,
  availableModels,
  t,
  showGatewayRoutes = true,
  showOfficial = true,
  isManual = false,
  disabled = false,
  compact = false,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [hoverKey, setHoverKey] = useState(null);
  const [panelPos, setPanelPos] = useState(null);
  const [panelVisible, setPanelVisible] = useState(false);
  /** 多选草稿：点「确定」后才 onChange */
  const [draftSelected, setDraftSelected] = useState([]);
  const [query, setQuery] = useState('');
  const [expandedKey, setExpandedKey] = useState(null);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const theme = compact ? POPUP_THEME.compact : POPUP_THEME.normal;
  const cls = `${compact ? ROUTE_SELECT_COMPACT : ROUTE_SELECT_NORMAL} ${className}`.trim();
  const chainState = useMemo(() => chainListState(routes, availableModels), [routes, availableModels]);
  const menuItems = useMemo(
    () => buildRouteMenuItems({
      routes,
      availableModels,
      t,
      showGatewayRoutes,
      isManual,
      showOfficial,
      chainHeads: chainState.heads,
      hiddenModels: chainState.hidden,
    }),
    [routes, availableModels, t, showGatewayRoutes, isManual, showOfficial, chainState],
  );
  const [speedMap] = useSpeedMap();
  const communitySpeed = useCommunitySpeed();
  // 每个模型项的圆点数据：社区(p2p)走服务端最快 worker 的 TTFT，其余走我们测速 speedMap。
  const speedForItem = (item) => {
    if (!item.modelId) return null;
    if (item.tier === 'p2p') {
      const ms = communitySpeed[normModelKey(item.modelId)] || 0;
      return { bucket: bucketFromMs(ms), title: ms > 0 ? `最快 ${(ms / 1000).toFixed(1)}s` : '暂无测速' };
    }
    return speedFor(speedMap, item.modelId);
  };
  const selected = multi ? (values || []).filter(Boolean) : [];
  const workingSelected = multi && open ? draftSelected : selected;
  const singleValue = multi ? null : (value ?? '');
  const officialActive = !isManual && (multi ? workingSelected.length === 0 : !singleValue);
  const multiSelectedCount = multi
    ? (isManual ? workingSelected.length : (officialActive ? 1 : workingSelected.length))
    : 0;
  const routeOptionCount = menuItems.filter(item => item.kind === 'option').length;
  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return menuItems;
    const out = [];
    let group = null;
    for (const it of menuItems) {
      if (it.kind === 'group') { group = it; continue; }
      const hay = `${it.label || ''} ${it.sub || ''}`.toLowerCase();
      if (!hay.includes(q)) continue;
      if (group) { out.push(group); group = null; }
      out.push(it);
    }
    return out;
  }, [menuItems, query]);

  const displayText = multi && !officialActive && selected.length > 1
    ? t('gateway.app.routeMultiSummary', {
      first: routeOptionDisplayLabel(selected[0], routes, availableModels),
      n: selected.length - 1,
    })
    : null;

  const triggerLabel = resolveTriggerLabel({
    multi, value: singleValue, values, routes, availableModels, t, isManual, displayText,
  });
  const triggerRouteId = multi ? (selected.length === 1 ? selected[0] : '') : (singleValue || '');
  const triggerProvider = triggerRouteId
    ? routeOptionProvider(triggerRouteId, routes, availableModels)
    : '';
  const triggerTitle = multi && selected.length > 1
    ? selected.map(v => routeOptionDisplayLabel(v, routes, availableModels)).join(', ')
    : (triggerProvider ? `${triggerProvider} · ${triggerLabel}` : undefined);

  const updatePanelPos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    setPanelPos(computePanelPos(el));
  }, []);

  useEffect(() => {
    if (!open) { setHoverKey(null); setPanelVisible(false); setQuery(''); setExpandedKey(null); return; }
    updatePanelPos();
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPanelVisible(true)));
    const onDoc = (e) => {
      const t = e.target;
      if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => updatePanelPos();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, updatePanelPos]);

  const pickOfficial = () => {
    if (multi) setDraftSelected([]);
    else { onChange(null); setOpen(false); }
  };

  const pickRoute = (val) => {
    if (!val) return;
    if (multi) {
      setDraftSelected(prev => {
        if (!isManual && prev.length === 0) return [val];
        if (prev.includes(val)) return prev.filter(v => v !== val);
        return [...prev, val];
      });
    } else {
      onChange(val);
      setOpen(false);
    }
  };

  const confirmMulti = () => {
    onChange(draftSelected);
    setOpen(false);
  };

  const isMarked = (itemValue) => {
    if (itemValue === '') return officialActive;
    return multi ? workingSelected.includes(itemValue) : singleValue === itemValue;
  };

  const popupPanel = open && !disabled && panelPos && createPortal(
    <div
      ref={panelRef}
      className={[
        'electron-no-drag fixed pointer-events-auto flex flex-col overflow-hidden',
        theme.panel,
        '!pb-0',
        'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]',
        panelVisible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-[0.97] translate-y-[-3px]',
        panelPos.openUp ? 'origin-bottom' : 'origin-top',
      ].join(' ')}
      style={{
        ...(panelPos.top != null ? { top: panelPos.top } : {}),
        ...(panelPos.bottom != null ? { bottom: panelPos.bottom } : {}),
        left: panelPos.left,
        width: panelPos.width,
        maxHeight: panelPos.maxHeight,
        zIndex: 99999,
      }}
      onMouseLeave={() => setHoverKey(null)}
    >
      {routeOptionCount > 8 && (
        <div className="shrink-0 px-2 pb-1.5">
          <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder={t('gateway.app.searchModel')}
            onMouseDown={e => e.stopPropagation()}
            className="w-full min-h-[28px] px-2 rounded-md border border-zinc-200 dark:border-white/10 bg-white/80 dark:bg-zinc-800/80 text-xs text-zinc-800 dark:text-zinc-100 outline-none" />
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${multi ? '' : 'py-0'}`}>
      {visibleItems.map((item, i) => {
        if (item.kind === 'group') {
          return <div key={`grp-${item.label}`} className={theme.group}>{item.label}</div>;
        }
        const key = item.value || '__official__';
        const isOfficial = item.value === '';
        const pins = item.pins || [];
        const pinMarked = pins.some(p => isMarked(p.value));
        const expanded = expandedKey === key || (expandedKey == null && pinMarked);
        return (
          <React.Fragment key={key}>
          <RouteMenuRow
            key={key}
            sub={item.sub}
            communityOnly={!!item.communityOnly}
            canExpand={pins.length > 0}
            expanded={expanded}
            onToggle={() => setExpandedKey(expanded ? '' : key)}
            compact={compact}
            multi={multi}
            theme={theme}
            t={t}
            mark={isMarked(item.value)}
            label={item.label}
            owner={item.owner}
            modelType={item.type}
            chain={!!item.chain}
            isModel={!!item.modelId}
            speed={speedForItem(item)}
            active={hoverKey === key}
            onEnter={() => setHoverKey(key)}
            onClick={() => (isOfficial ? pickOfficial() : pickRoute(item.value))}
          />
          {expanded && pins.map(p => (
            <RouteMenuRow
              key={key + '>' + p.value}
              compact={compact}
              multi={multi}
              theme={theme}
              t={t}
              indent
              mark={isMarked(p.value)}
              label={p.label}
              sub={p.community ? t('gateway.app.pinCommunityHint') : (p.isDefault ? t('gateway.app.pinDefault') : '')}
              active={hoverKey === key + '>' + p.value}
              onEnter={() => setHoverKey(key + '>' + p.value)}
              onClick={() => pickRoute(p.value)}
            />
          ))}
          </React.Fragment>
        );
      })}
      {visibleItems.every(it => it.kind === 'group') && (
        <div className="px-3 py-3 text-center text-[11px] text-zinc-400">{t('gateway.app.searchNone')}</div>
      )}
      </div>
      {multi ? (
        <div className={theme.footer}>
          <span className={theme.selectedHint}>
            {t('gateway.app.routeMultiSelected', { total: routeOptionCount, selected: multiSelectedCount })}
          </span>
          <button type="button" className={theme.confirmBtn} onMouseDown={e => e.preventDefault()} onClick={confirmMulti}>
            {t('gateway.app.routeMultiConfirm')}
          </button>
        </div>
      ) : (
        <div className={theme.footerSingle}>
          <span className={theme.selectedHint}>
            {t('gateway.app.routeTotal', { total: routeOptionCount })}
          </span>
        </div>
      )}
    </div>,
    getPortalRoot(),
  );

  return (
    <div ref={rootRef} className={`relative min-w-0 ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        title={triggerTitle}
        className={`${cls} ${open ? ROUTE_SELECT_OPEN : ''} electron-no-drag flex items-center justify-between gap-1 text-left ${disabled ? '' : 'cursor-pointer'}`}
        onClick={() => {
          if (disabled) return;
          if (!open) {
            if (multi) setDraftSelected((values || []).filter(Boolean));
            updatePanelPos();
          }
          setOpen(v => !v);
        }}
      >
        <span className="truncate flex-1 min-w-0 flex items-center">
          {triggerProvider ? <ProviderGlyph id={triggerProvider} compact={compact} /> : null}
          <span className="truncate">{triggerLabel}</span>
        </span>
        <RouteChevron className={theme.chevron} open={open} />
      </button>
      {popupPanel}
    </div>
  );
}
