import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ServiceIcon from './ServiceIcon';

/** 按锚点按钮位置计算 fixed 弹层坐标；下方空间不足时向上弹出 */
function popoverPos(anchor, estH, align = 'left') {
  const r = anchor.getBoundingClientRect();
  const up = r.bottom + estH + 8 > window.innerHeight && r.top > estH;
  return {
    ...(align === 'right'
      ? { right: Math.max(8, window.innerWidth - r.right) }
      : { left: Math.min(r.left, window.innerWidth - 240) }),
    ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
  };
}

/** 弹层开关：点外部 / Esc / 滚动 / 窗口变化时关闭 */
function usePopover() {
  const [pos, setPos] = useState(null);
  const anchorRef = useRef(null);
  const popRef = useRef(null);
  useEffect(() => {
    if (!pos) return undefined;
    const close = (e) => {
      if (popRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      setPos(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setPos(null); };
    const onScroll = (e) => { if (!popRef.current?.contains(e.target)) setPos(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', () => setPos(null), { once: true });
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [pos]);
  return { pos, setPos, anchorRef, popRef };
}

const POP_CLS = 'electron-no-drag z-[10040] py-1 rounded-xl border border-zinc-200/90 dark:border-zinc-700 '
  + 'bg-white/95 dark:bg-zinc-900/95 backdrop-blur shadow-xl shadow-black/[0.08] max-h-[60vh] overflow-y-auto';

/**
 * 筛选下拉（Linear 风格）：未选时显示「标签 ▾」，选中后高亮为「标签：值 ×」。
 * options: [{ value, label, count?, dot?, icon? }]；value='' 代表全部。
 */
export function FilterMenu({ label, value, options, onChange, allLabel, align = 'left', clearable = true, neutral = false }) {
  const { pos, setPos, anchorRef, popRef } = usePopover();
  const current = options.find(o => o.value === value);
  // neutral：排序等始终有值的选择，不做「已筛选」高亮
  const active = !!value && !neutral;
  const open = () => {
    if (pos) { setPos(null); return; }
    setPos(popoverPos(anchorRef.current, Math.min(options.length * 34 + 12, 400), align));
  };
  return (
    <>
      <span
        ref={anchorRef}
        className={`inline-flex items-center rounded-lg border text-xs transition-colors ${
          active
            ? 'border-blue-200 dark:border-blue-900 bg-blue-50/80 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
            : 'border-zinc-200/90 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/40 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800'
        }`}
      >
        <button type="button" onClick={open} aria-haspopup="listbox" aria-expanded={!!pos}
          className="tb-press inline-flex items-center gap-1.5 pl-2.5 pr-2 py-1.5">
          {current?.icon}
          <span className={active ? '' : 'text-zinc-500 dark:text-zinc-400'}>{label}</span>
          {(active || (neutral && current)) && (
            <span className={`font-medium max-w-[9rem] truncate ${neutral ? 'text-zinc-800 dark:text-zinc-100' : ''}`}>{current?.label}</span>
          )}
          {!active && <span className="opacity-50 text-[10px]">▾</span>}
        </button>
        {active && clearable && (
          <button type="button" onClick={() => onChange('')} aria-label="clear"
            className="pr-2 pl-0.5 py-1.5 opacity-60 hover:opacity-100">×</button>
        )}
      </span>
      {pos && createPortal(
        <div ref={popRef} role="listbox" style={{ position: 'fixed', ...pos }} className={`${POP_CLS} min-w-[11rem]`}>
          {[...(allLabel != null ? [{ value: '', label: allLabel }] : []), ...options].map(o => {
            const sel = o.value === value;
            return (
              <button key={o.value || '__all'} type="button" role="option" aria-selected={sel}
                onClick={() => { setPos(null); onChange(o.value); }}
                className={`w-full flex items-center gap-2 text-left text-xs px-3 py-2 transition-colors ${
                  sel ? 'text-blue-700 dark:text-blue-300 bg-blue-50/70 dark:bg-blue-950/30' : 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                }`}>
                {o.dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${o.dot}`} aria-hidden />}
                {o.icon}
                <span className="flex-1 truncate">{o.label}</span>
                {o.count != null && <span className="tabular-nums text-zinc-400">{o.count}</span>}
                <span className={`w-3 text-right ${sel ? '' : 'invisible'}`}>✓</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 主按钮 + 下拉：主操作一键直达，次要创建方式收进菜单 */
export function SplitButton({ label, onClick, disabled, items, menuLabel = 'More' }) {
  const { pos, setPos, anchorRef, popRef } = usePopover();
  const list = (items || []).filter(Boolean);
  return (
    <>
      <span ref={anchorRef} className="inline-flex rounded-lg shadow-sm shadow-blue-600/20">
        <button type="button" onClick={onClick} disabled={disabled}
          className="tb-press text-xs font-medium pl-3.5 pr-3 py-1.5 rounded-l-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
          {label}
        </button>
        <button type="button" aria-label={menuLabel} aria-haspopup="menu" aria-expanded={!!pos}
          onClick={() => (pos ? setPos(null) : setPos(popoverPos(anchorRef.current, list.length * 36 + 12, 'right')))}
          className="tb-press text-[10px] px-2 py-1.5 rounded-r-lg bg-blue-600 text-white/90 hover:bg-blue-500 border-l border-white/25">
          ▾
        </button>
      </span>
      {pos && createPortal(
        <div ref={popRef} role="menu" style={{ position: 'fixed', ...pos }} className={`${POP_CLS} min-w-[13rem]`}>
          {list.map(it => (
            <button key={it.key} type="button" role="menuitem" disabled={it.disabled}
              onClick={() => { setPos(null); it.onClick?.(); }}
              className="w-full text-left px-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-45">
              <div className="text-xs text-zinc-800 dark:text-zinc-100">{it.label}</div>
              {it.hint && <div className="text-[11px] text-zinc-400 mt-0.5">{it.hint}</div>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** 投射到的应用：图标叠放（最多 4 个 + 余数），悬停看全部名称 */
export function AppIconStack({ apps, emptyLabel, max = 4 }) {
  if (!apps.length) {
    return <span className="text-[11px] text-zinc-300 dark:text-zinc-600">{emptyLabel}</span>;
  }
  const shown = apps.slice(0, max);
  const rest = apps.length - shown.length;
  return (
    <span className="inline-flex items-center" title={apps.map(a => a.label).join('、')}>
      {shown.map((a, i) => (
        <span key={a.id} className={`inline-flex rounded-md ring-2 ring-white dark:ring-zinc-900 ${i ? '-ml-1.5' : ''}`}>
          <ServiceIcon id={a.id} name={a.label} boxClass="w-5 h-5" imgClass="w-3 h-3" className="!rounded-md" />
        </span>
      ))}
      {rest > 0 && <span className="ml-1 text-[10px] text-zinc-400 tabular-nums">+{rest}</span>}
    </span>
  );
}

/** 生命周期状态：色点 + 文案 */
export const LIFE_DOT = {
  active: 'bg-emerald-500',
  pending: 'bg-amber-400',
  dormant: 'bg-orange-400',
  cold: 'bg-zinc-400',
  shelf: 'bg-zinc-300 dark:bg-zinc-600',
  exempt: 'bg-sky-400',
};

/** 资产库 / 推荐 / 社区共用的列表容器 */
export const LIB_LIST_CLS = 'rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-white/55 dark:bg-zinc-900/40 overflow-hidden';

/** 列表行底样式（列布局由调用方给 grid-cols-*） */
export function libRowCls(sel) {
  return `group grid items-center gap-3 px-4 py-2.5 cursor-pointer border-b last:border-b-0 border-zinc-100/90 dark:border-white/[0.05] transition-colors ${
    sel ? 'bg-blue-50/80 dark:bg-blue-950/30' : 'hover:bg-zinc-50/90 dark:hover:bg-white/[0.03]'
  }`;
}

/** 列表区块标题：标题 + 计数 + 右侧附加信息 */
export function LibrarySectionHead({ title, count, extra }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-1 mb-2">
      <h3 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{title}</h3>
      {count != null && <span className="text-[11px] text-zinc-400 tabular-nums">{count}</span>}
      {extra && <div className="ml-auto flex items-center gap-2 text-[11px] text-zinc-400">{extra}</div>}
    </div>
  );
}

/** 行内：名称 + 徽标 / 副标题（两行） */
export function LibraryRowTitle({ logo, name, chips, sub, subClass = 'text-zinc-500 dark:text-zinc-400' }) {
  return (
    <div className="flex flex-nowrap items-center gap-3 min-w-0">
      {logo}
      <div className="min-w-0">
        <div className="flex flex-nowrap items-center gap-1.5 min-w-0">
          <span className="text-[13px] font-medium text-zinc-900 dark:text-zinc-50 truncate">{name}</span>
          {chips}
        </div>
        {sub && <p className={`text-[11px] truncate mt-0.5 empty:hidden ${subClass}`}>{sub}</p>}
      </div>
    </div>
  );
}

/** 详情面板分节 */
export function InspectorSection({ title, children }) {
  return (
    <section className="px-4 py-3 border-t border-zinc-100 dark:border-white/[0.06]">
      <h3 className="text-[11px] font-medium text-zinc-400 mb-2">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 右侧详情面板：宽屏 sticky 贴边，窄屏浮层抽屉。
 * stats: [[label, value], ...]（最多 3 格）；footer 固定在面板底部。
 */
export function LibraryInspector({ logo, title, chips, desc, stats, onClose, closeLabel = 'Close', children, footer }) {
  return (
    <aside
      className="fixed inset-y-3 right-3 z-40 w-[min(360px,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-zinc-200/80 dark:border-white/[0.08] bg-white/95 dark:bg-zinc-900/95 backdrop-blur shadow-2xl lg:sticky lg:top-0 lg:inset-auto lg:right-auto lg:z-auto lg:w-[340px] lg:shrink-0 lg:max-h-[calc(100vh-12rem)] lg:shadow-sm lg:bg-white/80 lg:dark:bg-zinc-900/70"
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <div className="flex items-start gap-3 p-4">
        {logo}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 break-all">{title}</h2>
          {chips && <div className="flex flex-wrap items-center gap-1.5 mt-1">{chips}</div>}
        </div>
        <button type="button" onClick={onClose} aria-label={closeLabel}
          className="shrink-0 w-6 h-6 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800">×</button>
      </div>
      {desc && <p className="px-4 pb-3 -mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{desc}</p>}
      {stats && stats.length > 0 && (
        <div className="grid border-t border-zinc-100 dark:border-white/[0.06]" style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0, 1fr))` }}>
          {stats.map(([k, v], i) => (
            <div key={k} className={`px-4 py-2.5 ${i ? 'border-l border-zinc-100 dark:border-white/[0.06]' : ''}`}>
              <div className="text-[10px] text-zinc-400">{k}</div>
              <div className="text-sm font-semibold tabular-nums text-zinc-800 dark:text-zinc-100 mt-0.5 truncate">{v}</div>
            </div>
          ))}
        </div>
      )}
      {children}
      {footer && (
        <div className="sticky bottom-0 flex flex-wrap gap-1.5 px-4 py-3 border-t border-zinc-100 dark:border-white/[0.06] bg-white/95 dark:bg-zinc-900/95">
          {footer}
        </div>
      )}
    </aside>
  );
}

/** 详情内的正文预览 */
export function InspectorPreview({ text }) {
  return (
    <pre className="text-[11px] leading-relaxed p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950 text-zinc-600 dark:text-zinc-300 max-h-72 overflow-auto whitespace-pre-wrap break-words">
      {text}
    </pre>
  );
}

/**
 * 通用详情抽屉：与 LibraryInspector 同位置/尺寸规则，但内容完全由调用方提供
 * （如供给源页直接放入原有配置卡，复用其全部编辑逻辑）。
 */
export function LibraryPanel({ title, onClose, closeLabel = 'Close', children }) {
  return (
    <aside
      className="fixed inset-y-3 right-3 z-40 w-[min(440px,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-zinc-200/80 dark:border-white/[0.08] bg-white/95 dark:bg-zinc-900/95 backdrop-blur shadow-2xl lg:sticky lg:top-0 lg:inset-auto lg:right-auto lg:z-auto lg:w-[420px] lg:shrink-0 lg:max-h-[calc(100vh-10rem)] lg:shadow-sm lg:bg-white/80 lg:dark:bg-zinc-900/70"
    >
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-2.5 border-b border-zinc-100 dark:border-white/[0.06] bg-white/95 dark:bg-zinc-900/95">
        <h2 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 truncate">{title}</h2>
        <button type="button" onClick={onClose} aria-label={closeLabel}
          className="shrink-0 w-6 h-6 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800">×</button>
      </div>
      <div className="p-3">{children}</div>
    </aside>
  );
}
