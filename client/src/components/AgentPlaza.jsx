// client/src/components/AgentPlaza.jsx
// 智能体广场：首屏价值主张 + 差异化卖点 + 精选。列表 / 雇佣逻辑仍在 Contribute.jsx。
import React, { useEffect, useMemo, useState } from 'react';
import { useLang } from '../store/lang';

const WHY_KEY = 'tokenbank.plaza.whyCollapsed';

function readBool(key) {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}
function writeBool(key, v) {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
  });
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return undefined; }
    const on = (e) => setReduced(e.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/* ───────────────────────── 图标 ───────────────────────── */

const ico = {
  xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
};
const Icons = {
  ride: (c) => (
    <svg {...ico} className={c}><path d="M5 16.5h14M6.5 16.5l1.3-4.6A2 2 0 0 1 9.7 10.5h4.6a2 2 0 0 1 1.9 1.4l1.3 4.6" /><path d="M4.5 16.5v2.25M19.5 16.5v2.25" /><circle cx="8" cy="16.5" r="1" /><circle cx="16" cy="16.5" r="1" /><path d="M12 3.5v3M9.5 5h5" /></svg>
  ),
  devices: (c) => (
    <svg {...ico} className={c}><rect x="2.75" y="4.5" width="12.5" height="9" rx="1.5" /><path d="M6 17h6M9 13.5V17" /><rect x="16.5" y="8" width="4.75" height="10.5" rx="1.2" /><path d="M18.9 16.4h.01" /></svg>
  ),
  split: (c) => (
    <svg {...ico} className={c}><circle cx="12" cy="12" r="8.25" /><path d="M12 3.75V12l6 5.6" /><path d="M12 12 6 17.6" /></svg>
  ),
  lock: (c) => (
    <svg {...ico} className={c}><rect x="4.5" y="10.5" width="15" height="9.75" rx="2" /><path d="M8 10.5V7.75a4 4 0 0 1 8 0v2.75" /><path d="M12 14.25v2.25" /></svg>
  ),
  link: (c) => (
    <svg {...ico} className={c}><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></svg>
  ),
  search: (c) => (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className={c}><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5 17 17" strokeLinecap="round" /></svg>
  ),
  arrow: (c) => (
    <svg {...ico} className={c}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
  ),
  check: (c) => (
    <svg {...ico} strokeWidth={2} className={c}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
  ),
  minus: (c) => (
    <svg {...ico} strokeWidth={2} className={c}><path d="M6 12h12" /></svg>
  ),
};
export const PlazaIcons = Icons;

/* ───────────────────────── 首屏：网络星图 ───────────────────────── */

/** 右侧动效：中间是「你」，外圈是各地设备上的智能体，任务包沿连线往返 */
function PlazaConstellation({ reduced }) {
  const nodes = [
    { x: 58, y: 44, r: 5 }, { x: 206, y: 30, r: 6 }, { x: 262, y: 112, r: 4.5 },
    { x: 228, y: 196, r: 6 }, { x: 96, y: 206, r: 5 }, { x: 28, y: 128, r: 4 },
    { x: 150, y: 14, r: 3.5 }, { x: 286, y: 54, r: 3 },
  ];
  const hub = { x: 150, y: 118 };
  return (
    <svg viewBox="0 0 300 230" className="w-full h-full" aria-hidden>
      <defs>
        <radialGradient id="plz-hub" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#a5f3fc" />
          <stop offset="55%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="plz-line" x1="0" x2="1">
          <stop offset="0%" stopColor="#67e8f9" stopOpacity="0.05" />
          <stop offset="50%" stopColor="#a78bfa" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#67e8f9" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {/* 轨道 */}
      <ellipse cx={hub.x} cy={hub.y} rx="118" ry="88" fill="none" stroke="rgb(255 255 255 / 0.06)" strokeDasharray="2 5" />
      <ellipse cx={hub.x} cy={hub.y} rx="70" ry="52" fill="none" stroke="rgb(255 255 255 / 0.08)" strokeDasharray="2 4" />
      {/* 连线 + 任务包 */}
      {nodes.slice(0, 6).map((n, i) => {
        const d = `M${hub.x} ${hub.y} L${n.x} ${n.y}`;
        return (
          <g key={`l${i}`}>
            <path d={d} stroke="url(#plz-line)" strokeWidth="1" fill="none" />
            {!reduced && (
              <circle r="2" fill={i % 2 ? '#67e8f9' : '#c4b5fd'}>
                <animateMotion dur={`${2.4 + i * 0.45}s`} repeatCount="indefinite" path={d} keyPoints={i % 2 ? '0;1' : '1;0'} keyTimes="0;1" calcMode="linear" begin={`${i * 0.35}s`} />
                <animate attributeName="opacity" values="0;1;1;0" dur={`${2.4 + i * 0.45}s`} repeatCount="indefinite" begin={`${i * 0.35}s`} />
              </circle>
            )}
          </g>
        );
      })}
      {/* 外圈节点 = 别人 / 你的设备上的智能体 */}
      {nodes.map((n, i) => (
        <g key={`n${i}`}>
          <circle cx={n.x} cy={n.y} r={n.r * 2.6} fill={i % 3 === 0 ? 'rgb(103 232 249 / 0.10)' : 'rgb(167 139 250 / 0.10)'}>
            {!reduced && <animate attributeName="r" values={`${n.r * 2};${n.r * 3};${n.r * 2}`} dur={`${3 + (i % 3)}s`} repeatCount="indefinite" />}
          </circle>
          <circle cx={n.x} cy={n.y} r={n.r} fill={i % 3 === 0 ? '#67e8f9' : '#a78bfa'} stroke="rgb(255 255 255 / 0.5)" strokeWidth="0.75" />
        </g>
      ))}
      {/* 中心：你 */}
      <circle cx={hub.x} cy={hub.y} r="34" fill="url(#plz-hub)" opacity="0.55">
        {!reduced && <animate attributeName="opacity" values="0.35;0.7;0.35" dur="3.2s" repeatCount="indefinite" />}
      </circle>
      <circle cx={hub.x} cy={hub.y} r="15" fill="#0b1020" stroke="#a5b4fc" strokeWidth="1.25" />
      <text x={hub.x} y={hub.y + 3.5} textAnchor="middle" fontSize="10" fontWeight="600" fill="#e0e7ff">YOU</text>
    </svg>
  );
}

/* ───────────────────────── 首屏 Hero ───────────────────────── */

export function PlazaHero({ query, onQuery, online = 0, idle = 0, hired = 0, credits = null, onSuggest }) {
  const { t } = useLang();
  const reduced = useReducedMotion();
  const suggestions = [t('plaza.suggest.1'), t('plaza.suggest.2'), t('plaza.suggest.3'), t('plaza.suggest.4')];
  const stats = [
    { label: t('plaza.stat.online'), value: online, live: true },
    { label: t('plaza.stat.idle'), value: idle },
    { label: t('plaza.stat.cost'), value: credits != null ? credits : '—', unit: credits != null ? t('plaza.stat.costUnit') : '' },
    { label: t('plaza.stat.hired'), value: hired },
  ];
  return (
    <section className="tb-plaza-hero relative overflow-hidden rounded-3xl text-white ring-1 ring-white/10 shadow-xl shadow-indigo-950/20">
      {/* 背景：深空 + 极光 + 网格 */}
      <div className="absolute inset-0 bg-[#070a16]" aria-hidden />
      <div className="absolute -top-24 -left-16 w-[420px] h-[420px] rounded-full bg-indigo-600/30 blur-3xl" aria-hidden />
      <div className="absolute -bottom-32 right-10 w-[380px] h-[380px] rounded-full bg-cyan-500/20 blur-3xl" aria-hidden />
      <div className="absolute top-10 right-1/3 w-[220px] h-[220px] rounded-full bg-fuchsia-500/10 blur-3xl" aria-hidden />
      <div className="tb-plaza-grid absolute inset-0 opacity-60" aria-hidden />

      <div className="relative grid lg:grid-cols-[minmax(0,1fr)_300px] gap-6 px-6 sm:px-8 pt-7 pb-6">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] pl-1.5 pr-3 py-1 text-[11px] text-indigo-100/90 backdrop-blur">
            <span className="rounded-full bg-gradient-to-r from-cyan-400 to-indigo-400 px-2 py-px text-[10px] font-semibold tracking-wider text-[#070a16]">AGENT PLAZA</span>
            {t('plaza.eyebrow')}
          </div>
          <h2 className="mt-4 text-[26px] sm:text-[30px] leading-[1.15] font-semibold tracking-tight">
            {t('plaza.title.a')}
            <span className="bg-gradient-to-r from-cyan-300 via-indigo-300 to-fuchsia-300 bg-clip-text text-transparent">{t('plaza.title.b')}</span>
          </h2>
          <p className="mt-3 max-w-xl text-[13px] leading-relaxed text-indigo-100/70">{t('plaza.subtitle')}</p>

          {/* 搜索：广场的主入口 */}
          <div className="mt-5 max-w-xl">
            <div className="group relative rounded-2xl p-px bg-gradient-to-r from-cyan-400/50 via-indigo-400/40 to-fuchsia-400/50 focus-within:from-cyan-300 focus-within:via-indigo-300 focus-within:to-fuchsia-300 transition-colors">
              <div className="relative flex items-center rounded-[15px] bg-[#0b1022]/95">
                <span className="pl-4 text-indigo-200/70" aria-hidden>{Icons.search('w-4 h-4')}</span>
                <input
                  value={query}
                  onChange={(e) => onQuery?.(e.target.value)}
                  placeholder={t('plaza.searchPlaceholder')}
                  aria-label={t('plaza.searchPlaceholder')}
                  className="flex-1 min-w-0 bg-transparent px-3 py-3 text-[13px] text-white placeholder-indigo-200/40 focus:outline-none"
                />
                {query && (
                  <button type="button" onClick={() => onQuery?.('')} className="mr-2 w-7 h-7 rounded-lg text-indigo-200/60 hover:text-white hover:bg-white/10" aria-label={t('plaza.clearSearch')}>×</button>
                )}
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className="text-indigo-200/45">{t('plaza.tryLabel')}</span>
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => onSuggest?.(s)}
                  className="tb-press rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-indigo-100/80 hover:bg-white/10 hover:text-white">
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="hidden lg:block relative h-[230px] -my-2" aria-hidden>
          <PlazaConstellation reduced={reduced} />
        </div>
      </div>

      {/* 实时指标 */}
      <div className="relative grid grid-cols-2 sm:grid-cols-4 border-t border-white/[0.07] bg-white/[0.02]">
        {stats.map((s, i) => (
          <div key={s.label} className={`px-6 sm:px-8 py-3.5 ${i > 0 ? 'sm:border-l border-white/[0.07]' : ''} ${i % 2 ? 'border-l sm:border-l border-white/[0.07]' : ''}`}>
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-indigo-200/50">
              {s.live && (
                <span className="relative flex w-1.5 h-1.5">
                  {!reduced && <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-70 animate-ping" />}
                  <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-400" />
                </span>
              )}
              {s.label}
            </div>
            <div className="mt-0.5 text-[20px] font-semibold tabular-nums tracking-tight">
              {s.value}
              {s.unit && <span className="ml-1 text-[11px] font-normal text-indigo-200/60">{s.unit}</span>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ───────────────────────── 为什么在这里用 ───────────────────────── */

/** 主卡插画：一次「叫车」—— 你下单 → 高手的智能体在它的设备上执行 → 结果回到你手里 */
function RideFlow() {
  const { t } = useLang();
  const steps = [
    { k: 'you', label: t('plaza.flow.you'), sub: t('plaza.flow.youSub') },
    { k: 'agent', label: t('plaza.flow.agent'), sub: t('plaza.flow.agentSub') },
    { k: 'result', label: t('plaza.flow.result'), sub: t('plaza.flow.resultSub') },
  ];
  return (
    <div className="mt-4 flex items-stretch gap-2">
      {steps.map((s, i) => (
        <React.Fragment key={s.k}>
          <div className={`flex-1 min-w-0 rounded-xl border px-3 py-2.5 ${
            s.k === 'agent'
              ? 'border-indigo-300/60 dark:border-indigo-400/30 bg-indigo-50/80 dark:bg-indigo-500/10'
              : 'border-zinc-200/80 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03]'
          }`}>
            <div className="text-[12px] font-semibold text-zinc-900 dark:text-zinc-50 truncate">{s.label}</div>
            <div className="mt-0.5 text-[10.5px] leading-snug text-zinc-500 dark:text-zinc-400">{s.sub}</div>
          </div>
          {i < steps.length - 1 && (
            <div className="self-center shrink-0 text-indigo-400 dark:text-indigo-300/70" aria-hidden>{Icons.arrow('w-3.5 h-3.5')}</div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function WhyCard({ icon, tone, kicker, title, desc, metric, cta, onCta, className = '', children }) {
  const tones = {
    indigo: 'from-indigo-500 to-violet-500 shadow-indigo-500/25',
    cyan: 'from-cyan-500 to-sky-500 shadow-cyan-500/25',
    emerald: 'from-emerald-500 to-teal-500 shadow-emerald-500/25',
    amber: 'from-amber-500 to-orange-500 shadow-amber-500/25',
    fuchsia: 'from-fuchsia-500 to-pink-500 shadow-fuchsia-500/25',
  };
  return (
    <div className={`tb-plaza-card group relative overflow-hidden rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-white/65 dark:bg-zinc-900/45 p-4 flex flex-col ${className}`}>
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br ${tones[tone]} text-white flex items-center justify-center shadow-md`} aria-hidden>
          {icon('w-[18px] h-[18px]')}
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{kicker}</div>
          <div className="text-[14px] font-semibold leading-snug text-zinc-900 dark:text-zinc-50">{title}</div>
        </div>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">{desc}</p>
      {children}
      <div className="mt-auto pt-3 flex items-center justify-between gap-2">
        {metric ? (
          <span className="text-[10.5px] font-medium px-2 py-0.5 rounded-md bg-zinc-100/90 dark:bg-white/[0.06] text-zinc-600 dark:text-zinc-300">{metric}</span>
        ) : <span />}
        {cta && (
          <button type="button" onClick={onCta}
            className="tb-press inline-flex items-center gap-1 text-[11px] font-medium text-indigo-600 dark:text-indigo-300 hover:text-indigo-800 dark:hover:text-indigo-200">
            {cta}{Icons.arrow('w-3 h-3 transition-transform group-hover:translate-x-0.5')}
          </button>
        )}
      </div>
    </div>
  );
}

function CompareTable() {
  const { t } = useLang();
  const rows = [1, 2, 3, 4, 5, 6].map((i) => ({
    dim: t(`plaza.cmp.${i}.dim`),
    them: t(`plaza.cmp.${i}.them`),
    us: t(`plaza.cmp.${i}.us`),
  }));
  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-white/60 dark:bg-zinc-900/40">
      <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)] sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)] text-[11px]">
        <div className="px-4 py-2.5 text-zinc-400 border-b border-zinc-100 dark:border-white/[0.05]" />
        <div className="px-4 py-2.5 text-zinc-500 dark:text-zinc-400 border-b border-zinc-100 dark:border-white/[0.05]">
          <div className="font-medium">{t('plaza.cmp.them')}</div>
          <div className="text-[10px] text-zinc-400 dark:text-zinc-500">{t('plaza.cmp.themHint')}</div>
        </div>
        <div className="px-4 py-2.5 border-b border-indigo-100 dark:border-indigo-400/15 bg-gradient-to-b from-indigo-50/90 to-indigo-50/40 dark:from-indigo-500/15 dark:to-indigo-500/5">
          <div className="font-semibold text-indigo-700 dark:text-indigo-200">{t('plaza.cmp.us')}</div>
          <div className="text-[10px] text-indigo-500/80 dark:text-indigo-300/60">{t('plaza.cmp.usHint')}</div>
        </div>
        {rows.map((r, i) => (
          <React.Fragment key={r.dim}>
            <div className={`px-4 py-2.5 font-medium text-zinc-700 dark:text-zinc-200 ${i < rows.length - 1 ? 'border-b border-zinc-100 dark:border-white/[0.05]' : ''}`}>{r.dim}</div>
            <div className={`px-4 py-2.5 flex gap-1.5 text-zinc-500 dark:text-zinc-400 ${i < rows.length - 1 ? 'border-b border-zinc-100 dark:border-white/[0.05]' : ''}`}>
              <span className="mt-0.5 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden>{Icons.minus('w-3 h-3')}</span>{r.them}
            </div>
            <div className={`px-4 py-2.5 flex gap-1.5 text-zinc-800 dark:text-zinc-100 bg-indigo-50/30 dark:bg-indigo-500/[0.04] ${i < rows.length - 1 ? 'border-b border-indigo-100/70 dark:border-indigo-400/10' : ''}`}>
              <span className="mt-0.5 shrink-0 text-emerald-500" aria-hidden>{Icons.check('w-3 h-3')}</span>{r.us}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/**
 * 差异化：通用 AI 助手给你一个空白对话框；这里给你一群调好的专家 + 一张自己的智能体网络。
 * onGo('supply' | 'circles') 跳到对应页签。
 */
export function PlazaWhy({ onGo }) {
  const { t } = useLang();
  const [collapsed, setCollapsed] = useState(() => readBool(WHY_KEY));
  const [showCmp, setShowCmp] = useState(false);
  function toggle() {
    setCollapsed((v) => { writeBool(WHY_KEY, !v); return !v; });
  }

  const pills = useMemo(() => [
    { icon: Icons.ride, text: t('plaza.why.ride.kicker') },
    { icon: Icons.devices, text: t('plaza.why.devices.kicker') },
    { icon: Icons.split, text: t('plaza.why.split.kicker') },
    { icon: Icons.lock, text: t('plaza.why.lock.kicker') },
    { icon: Icons.link, text: t('plaza.why.link.kicker') },
  ], [t]);

  return (
    <section aria-labelledby="plaza-why-title">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h3 id="plaza-why-title" className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('plaza.why.title')}</h3>
          {!collapsed && <p className="mt-0.5 text-[11.5px] text-zinc-500 dark:text-zinc-400">{t('plaza.why.subtitle')}</p>}
        </div>
        <div className="flex items-center gap-1">
          {!collapsed && (
            <button type="button" onClick={() => setShowCmp((v) => !v)} aria-expanded={showCmp}
              className={`tb-press text-[11px] px-2.5 py-1 rounded-lg border ${showCmp
                ? 'border-indigo-300 dark:border-indigo-400/40 bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-200'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800'}`}>
              {showCmp ? t('plaza.cmp.hide') : t('plaza.cmp.show')}
            </button>
          )}
          <button type="button" onClick={toggle} aria-expanded={!collapsed}
            className="tb-press text-[11px] px-2.5 py-1 rounded-lg text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-white/70 dark:hover:bg-zinc-800">
            {collapsed ? t('plaza.why.expand') : t('plaza.why.collapse')}
          </button>
        </div>
      </div>

      {collapsed ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {pills.map((p) => (
            <span key={p.text} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200/80 dark:border-white/[0.08] bg-white/60 dark:bg-zinc-900/40 px-2.5 py-1 text-[11px] text-zinc-600 dark:text-zinc-300">
              <span className="text-indigo-500 dark:text-indigo-300" aria-hidden>{p.icon('w-3.5 h-3.5')}</span>{p.text}
            </span>
          ))}
        </div>
      ) : (
        <>
          {showCmp && <CompareTable />}
          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <WhyCard
              className="md:col-span-2 xl:row-span-2 tb-plaza-card--hero"
              icon={Icons.ride} tone="indigo"
              kicker={t('plaza.why.ride.kicker')}
              title={t('plaza.why.ride.title')}
              desc={t('plaza.why.ride.desc')}
              metric={t('plaza.why.ride.metric')}
            >
              <RideFlow />
              <ul className="mt-3 grid grid-cols-3 gap-2 text-center">
                {['noKey', 'noEnv', 'noPrompt'].map((k) => (
                  <li key={k} className="rounded-lg bg-zinc-50/90 dark:bg-white/[0.03] px-2 py-2">
                    <div className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50 line-through decoration-indigo-400/70 decoration-2">{t(`plaza.why.ride.${k}`)}</div>
                    <div className="text-[10px] text-zinc-400 mt-0.5">{t('plaza.why.ride.notNeeded')}</div>
                  </li>
                ))}
              </ul>
            </WhyCard>
            <WhyCard
              icon={Icons.devices} tone="cyan"
              kicker={t('plaza.why.devices.kicker')}
              title={t('plaza.why.devices.title')}
              desc={t('plaza.why.devices.desc')}
              metric={t('plaza.why.devices.metric')}
              cta={t('plaza.why.devices.cta')} onCta={() => onGo?.('supply')}
            />
            <WhyCard
              icon={Icons.split} tone="emerald"
              kicker={t('plaza.why.split.kicker')}
              title={t('plaza.why.split.title')}
              desc={t('plaza.why.split.desc')}
              metric={t('plaza.why.split.metric')}
              cta={t('plaza.why.split.cta')} onCta={() => onGo?.('supply')}
            />
            <WhyCard
              icon={Icons.lock} tone="amber"
              kicker={t('plaza.why.lock.kicker')}
              title={t('plaza.why.lock.title')}
              desc={t('plaza.why.lock.desc')}
              metric={t('plaza.why.lock.metric')}
            />
            <WhyCard
              icon={Icons.link} tone="fuchsia"
              kicker={t('plaza.why.link.kicker')}
              title={t('plaza.why.link.title')}
              desc={t('plaza.why.link.desc')}
              metric={t('plaza.why.link.metric')}
              cta={t('plaza.why.link.cta')} onCta={() => onGo?.('circles')}
            />
          </div>
        </>
      )}
    </section>
  );
}

/* ───────────────────────── 精选 ───────────────────────── */

/**
 * 精选卡片（热度前三）。renderIcon / parse 由调用方传入，避免与 Contribute 循环依赖。
 * items: [{ agent, name, owner, hired, busy, hires, isPublic, runtimeName }]
 */
export function PlazaSpotlight({ items, renderIcon, onOpen, onHire, onCopyLink, copiedId, busy }) {
  const { t } = useLang();
  if (!items?.length) return null;
  return (
    <section aria-labelledby="plaza-spot-title">
      <div className="flex items-end gap-2">
        <h3 id="plaza-spot-title" className="text-[15px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('plaza.spot.title')}</h3>
        <span className="pb-0.5 text-[11px] text-zinc-400">{t('plaza.spot.hint')}</span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((it, idx) => {
          const a = it.agent;
          return (
            <div key={`${a.worker_id}:${a.id}`}
              role="button" tabIndex={0}
              onClick={() => onOpen?.(a)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(a); } }}
              className="tb-plaza-spot group relative cursor-pointer overflow-hidden rounded-2xl p-px bg-gradient-to-br from-indigo-300/60 via-zinc-200/40 to-cyan-300/50 dark:from-indigo-400/30 dark:via-white/[0.06] dark:to-cyan-400/25">
              <div className="relative h-full rounded-[15px] bg-white/90 dark:bg-zinc-900/85 p-4 flex flex-col">
                <div className="absolute -top-10 -right-10 w-32 h-32 rounded-full bg-indigo-400/10 dark:bg-indigo-400/10 blur-2xl transition-opacity opacity-60 group-hover:opacity-100" aria-hidden />
                <div className="relative flex items-start gap-3">
                  {renderIcon(a, it.name)}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-semibold tabular-nums text-indigo-500 dark:text-indigo-300">#{idx + 1}</span>
                      {it.hired && <span className="text-[10px] px-1.5 py-px rounded font-medium bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300">✓ {t('contribute.hiredBadge')}</span>}
                      {!it.isPublic && <span className="text-[10px] px-1.5 py-px rounded font-medium bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300">◎ {t('contribute.scope.circleTag')}</span>}
                    </div>
                    <div className="mt-0.5 text-[14px] font-semibold text-zinc-900 dark:text-zinc-50 truncate">{it.name}</div>
                    {it.owner && <div className="text-[11px] text-zinc-400 truncate">{t('plaza.spot.by', { owner: it.owner })}</div>}
                  </div>
                </div>
                <p className="relative mt-2.5 text-[11.5px] leading-relaxed text-zinc-600 dark:text-zinc-400 line-clamp-2 min-h-[2.6em]">
                  {String(a.description || '').trim() || t('plaza.spot.noDesc')}
                </p>
                <div className="relative mt-3 mb-0.5 flex items-center gap-3 text-[10.5px] text-zinc-500 dark:text-zinc-400">
                  <span className="inline-flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${it.busy ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden />
                    {it.busy ? t('network.busy') : t('network.idle')}
                  </span>
                  {it.runtimeName && <span className="truncate">{it.runtimeName}</span>}
                  <span className="ml-auto tabular-nums">{it.hires > 0 ? `🔥 ${t('contribute.hiresN', { n: it.hires })}` : t('contribute.newListing')}</span>
                </div>
                <div className="relative mt-auto pt-3 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <button type="button" disabled={!!busy || it.hired} onClick={() => onHire?.(a)}
                    className="tb-press flex-1 text-[11.5px] font-medium px-3 py-1.5 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-sm shadow-indigo-600/25 hover:from-indigo-500 hover:to-violet-500 disabled:opacity-50 disabled:from-zinc-400 disabled:to-zinc-400 dark:disabled:from-zinc-700 dark:disabled:to-zinc-700">
                    {it.hired ? t('plaza.spot.hired') : t('plaza.spot.hire')}
                  </button>
                  {it.isPublic && onCopyLink && (
                    <button type="button" onClick={() => onCopyLink(a)} title={t('plaza.share.title')}
                      className="tb-press inline-flex items-center gap-1 text-[11.5px] px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800">
                      {Icons.link('w-3.5 h-3.5')}
                      {copiedId === a.id ? t('plaza.share.copied') : t('plaza.share.short')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ───────────────────────── 空广场 ───────────────────────── */

export function PlazaEmpty({ onGo }) {
  const { t } = useLang();
  return (
    <div className="relative overflow-hidden rounded-2xl border border-dashed border-indigo-200 dark:border-indigo-400/20 bg-gradient-to-br from-indigo-50/70 via-white/60 to-cyan-50/50 dark:from-indigo-500/[0.06] dark:via-zinc-900/30 dark:to-cyan-500/[0.04] px-6 py-10 text-center">
      <div className="mx-auto w-11 h-11 rounded-2xl bg-gradient-to-br from-indigo-500 to-cyan-500 text-white flex items-center justify-center shadow-md shadow-indigo-500/25" aria-hidden>
        {Icons.devices('w-5 h-5')}
      </div>
      <p className="mt-3 text-[14px] font-semibold text-zinc-900 dark:text-zinc-50">{t('plaza.empty.title')}</p>
      <p className="mt-1 text-[11.5px] text-zinc-500 dark:text-zinc-400 max-w-md mx-auto leading-relaxed">{t('plaza.empty.desc')}</p>
      <div className="mt-4 flex justify-center gap-2">
        <button type="button" onClick={() => onGo?.('supply')}
          className="tb-press text-[12px] font-medium px-3.5 py-2 rounded-lg bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-sm shadow-indigo-600/25 hover:from-indigo-500 hover:to-violet-500">
          {t('plaza.empty.cta')}
        </button>
        <button type="button" onClick={() => onGo?.('circles')}
          className="tb-press text-[12px] px-3.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800">
          {t('plaza.empty.cta2')}
        </button>
      </div>
    </div>
  );
}
