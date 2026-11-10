import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { askGuardian, recordQuestion } from '../lib/askGuardian';
import { useLang } from '../store/lang';

const CATS = ['projection', 'gateway', 'install', 'assets', 'discover', 'setup', 'community'];
const MODES = ['auto', 'suggest', 'off'];
const FREQS = ['off', 'daily', 'weekly', 'monthly'];
const SCOPES = ['assets', 'routes', 'models', 'savings', 'rules'];
const SEG = 'inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/70';
const segBtn = (on) => `text-[11px] px-2.5 py-1 rounded-md ${on ? 'bg-white dark:bg-zinc-900 shadow-sm font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-500'}`;
const INPUT = 'px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-100';

const HEALTH_CLS = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/60',
  warn: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/60',
  off: 'bg-zinc-100 text-zinc-500 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700',
};
const DOT_CLS = { ok: 'bg-emerald-500', warn: 'bg-amber-500', off: 'bg-zinc-400' };

/** 运行状态徽标：运行正常 / 需要注意 / 已关闭 */
export function HealthBadge({ health, t }) {
  if (!health) return null;
  const lv = health.level || 'off';
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border ${HEALTH_CLS[lv]}`} role="status">
      <span className={`w-1.5 h-1.5 rounded-full ${DOT_CLS[lv]}`} aria-hidden />
      {lv === 'warn' ? t('guardian.health.warn', { n: health.issues.length }) : t(`guardian.health.${lv}`)}
    </span>
  );
}

/** 运行环境：执行应用（可选）、模型、后台检查，以及需要处理的问题 */
function RuntimeSection({ health, api, t, lang, navigate, onChanged, editable = true }) {
  const [busy, setBusy] = useState(false);
  if (!health) return null;
  const eng = health.engine || {};
  const last = eng.last;
  const pick = async (id) => {
    setBusy(true);
    try { await api.engineSetRuntime(id); await onChanged(); } finally { setBusy(false); }
  };
  const kindLabel = (k) => t(`guardian.engine.kind.${k}`);
  const lastText = last
    ? t(`guardian.engine.last.${last.status}`, { kind: kindLabel(last.kind), time: fmtTime(last.at, lang), error: last.error || '' })
    : t('guardian.engine.never');
  const model = health.model;
  const checks = health.checks || {};
  const row = 'grid grid-cols-[5.5rem_1fr] items-start gap-x-3 gap-y-0.5';
  return (
    <div className="px-5 py-3 space-y-2.5 border-b border-white/40 dark:border-white/[0.06]">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{t('guardian.runtime.title')}</div>
        <HealthBadge health={health} t={t} />
      </div>
      {health.busy?.length > 0 && (
        <div className="flex items-center gap-2 text-[11px] text-emerald-700 dark:text-emerald-300" role="status">
          <span className="w-3 h-3 rounded-full border-2 border-emerald-500 border-t-transparent animate-spin motion-reduce:animate-none" aria-hidden />
          {t('guardian.runtime.busy', { what: health.busy.join('、') })}
        </div>
      )}
      {health.issues?.length > 0 && (
        <ul className="space-y-1">
          {health.issues.map((it) => (
            <li key={it.code} className="flex flex-wrap items-center gap-2 text-[11px] text-amber-800 dark:text-amber-300">
              <span className="min-w-0">{it.text}</span>
              {it.link && (
                <button type="button" onClick={() => navigate(it.link.to)}
                  className="text-[11px] px-2 py-0.5 rounded-md border border-amber-300 dark:border-amber-800 hover:bg-amber-50 dark:hover:bg-amber-950/40">
                  {it.link.label} →
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2 text-[11px] text-zinc-500 dark:text-zinc-400">
        <div className={row}>
          <span>{t('guardian.runtime.app')}</span>
          <div className="space-y-0.5">
            {eng.runtimes?.length && !editable ? (
              <span className="text-zinc-800 dark:text-zinc-100">{(eng.runtimes.find((r) => r.id === eng.runtime) || {}).label || eng.runtime}</span>
            ) : eng.runtimes?.length ? (
              <select value={eng.runtime || ''} disabled={busy} onChange={(e) => pick(e.target.value)} aria-label={t('guardian.runtime.app')}
                className="px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-100">
                {eng.runtimes.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            ) : (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="text-amber-700 dark:text-amber-300">{t('guardian.runtime.noApp')}</span>
                <button type="button" onClick={() => navigate('/gateway')}
                  className="text-[11px] px-2 py-0.5 rounded-md border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40">
                  {t('guardian.runtime.goManage')} →
                </button>
              </span>
            )}
            <div className="text-zinc-400">{t('guardian.runtime.appHint')}</div>
            <div className={last?.status === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-500 dark:text-zinc-400'}>{lastText}</div>
          </div>
        </div>
        <div className={row}>
          <span>{t('guardian.runtime.model')}</span>
          <div className="space-y-0.5">
            <span className={model?.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>
              {model == null ? t('guardian.runtime.gatewayDown') : model.ok ? t('guardian.runtime.modelOk', { n: model.count }) : t('guardian.runtime.noModel')}
            </span>
            <div className="text-zinc-400">{t('guardian.runtime.modelHint')}</div>
          </div>
        </div>
        <div className={row}>
          <span>{t('guardian.runtime.checks')}</span>
          <span className={checks.failing?.length ? 'text-rose-600 dark:text-rose-400' : ''}>
            {!checks.lastAt ? t('guardian.runtime.checksNever')
              : checks.failing?.length ? t('guardian.runtime.checksFailing', { n: checks.failing.length, time: fmtTime(checks.lastAt, lang) })
                : t('guardian.runtime.checksOk', { time: fmtTime(checks.lastAt, lang) })}
          </span>
        </div>
      </div>
    </div>
  );
}

/** 设置页签：执行应用（看护在哪个应用里跑画像 / 发现 / 安装） */
function RunnerAppSetting({ health, api, t, navigate, onChanged }) {
  const [busy, setBusy] = useState(false);
  const eng = health?.engine || {};
  const pick = async (id) => {
    setBusy(true);
    try { await api.engineSetRuntime(id); await onChanged(); } finally { setBusy(false); }
  };
  return (
    <div className="px-5 py-3 border-b border-white/40 dark:border-white/[0.06] flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{t('guardian.runtime.app')}</div>
        <div className="text-[11px] text-zinc-400">{t('guardian.runtime.appHint')}</div>
      </div>
      {eng.runtimes?.length ? (
        <select value={eng.runtime || ''} disabled={busy} onChange={(e) => pick(e.target.value)} aria-label={t('guardian.runtime.app')}
          className="text-xs px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-100">
          {eng.runtimes.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
        </select>
      ) : (
        <button type="button" onClick={() => navigate('/gateway')}
          className="text-[11px] px-2 py-0.5 rounded-md border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40">
          {t('guardian.runtime.noApp')} · {t('guardian.runtime.goManage')} →
        </button>
      )}
    </div>
  );
}

/** 定期自省：频率、时段、token 上限、范围、结果处理、立即运行 */
function IntrospectSection({ settings, save, api, t, lang, onRan, view = 'all' }) {
  const c = settings.introspect || {};
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState(null);
  const [note, setNote] = useState('');
  const set = (patch) => save({ introspect: patch });

  useEffect(() => {
    api.listReports?.().then((r) => setLast(r?.reports?.[0] || null)).catch(() => {});
  }, [api]);

  const runNow = async () => {
    setBusy(true);
    setNote('');
    setTimeout(() => { try { window.dispatchEvent(new Event('tb-guardian-changed')); } catch { /* ignore */ } }, 300);
    try {
      const r = await api.introspectNow();
      if (r?.report) {
        setLast(r.report);
        const n = Object.values(r.report.sections || {}).reduce((s, x) => s + ((x && x.items) || []).length, 0);
        setNote(t('guardian.introspect.done', { n }));
      } else if (r && r.success === false) {
        setNote(r.error === 'running' ? t('guardian.introspect.running') : (r.error || t('guardian.actionFailed')));
      }
      await onRan();
    } finally {
      setBusy(false);
    }
  };

  const off = !settings.enabled || c.frequency === 'off';
  return (
    <div className="px-5 py-3 space-y-2.5 border-b border-white/40 dark:border-white/[0.06]">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{view === 'report' ? t('guardian.introspect.lastTitle') : t('guardian.introspect.title')}</div>
          <div className="text-[11px] text-zinc-400">{t('guardian.introspect.hint')}</div>
        </div>
        {/* 「立即自省」只放在运行情况里、挨着它产出的报告；设置页签只管配置 */}
        {view !== 'settings' && (
          <button type="button" onClick={runNow} disabled={busy || !settings.enabled}
            className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
            {busy ? t('guardian.introspect.running') : t('guardian.introspect.runNow')}
          </button>
        )}
      </div>
      {view !== 'report' && (
      <div className={`grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-[11px] text-zinc-500 dark:text-zinc-400 ${settings.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
        <span>{t('guardian.introspect.frequency')}</span>
        <div className={`${SEG} justify-self-start`} role="radiogroup" aria-label={t('guardian.introspect.frequency')}>
          {FREQS.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={c.frequency === f} onClick={() => set({ frequency: f })} className={segBtn(c.frequency === f)}>
              {t(`guardian.introspect.freq.${f}`)}
            </button>
          ))}
        </div>
        <span className={off ? 'opacity-50' : ''}>{t('guardian.introspect.window')}</span>
        <div className={`flex flex-wrap items-center gap-2 ${off ? 'opacity-50 pointer-events-none' : ''}`}>
          <div className={SEG} role="radiogroup" aria-label={t('guardian.introspect.window')}>
            {['idle', 'hour'].map((w) => (
              <button key={w} type="button" role="radio" aria-checked={c.window === w} onClick={() => set({ window: w })} className={segBtn(c.window === w)}>
                {t(`guardian.introspect.window.${w}`)}
              </button>
            ))}
          </div>
          {c.window === 'hour' && (
            <span className="inline-flex items-center gap-1">
              <input type="number" min="0" max="23" value={c.hour ?? 3} aria-label={t('guardian.introspect.window.hour')}
                onChange={(e) => set({ hour: Number(e.target.value) || 0 })} className={`w-14 ${INPUT}`} />
              {t('guardian.introspect.hourUnit')}
            </span>
          )}
        </div>
        <span>{t('guardian.introspect.tokenCap')}</span>
        <div className="flex flex-wrap items-center gap-2">
          <input type="number" min="0" step="1000" value={c.tokenCap ?? 20000} aria-label={t('guardian.introspect.tokenCap')}
            onChange={(e) => set({ tokenCap: Number(e.target.value) || 0 })} className={`w-24 ${INPUT}`} />
          <span className="text-zinc-400">{t('guardian.introspect.tokenCapHint')}</span>
        </div>
        <span>{t('guardian.introspect.scope')}</span>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {SCOPES.map((k) => {
            const on = (c.scope || []).includes(k);
            return (
              <label key={k} className="inline-flex items-center gap-1 cursor-pointer text-zinc-600 dark:text-zinc-300">
                <input type="checkbox" checked={on}
                  onChange={() => set({ scope: on ? c.scope.filter((x) => x !== k) : [...(c.scope || []), k] })} />
                {t(`guardian.scope.${k}`)}
              </label>
            );
          })}
        </div>
        <span>{t('guardian.introspect.handling')}</span>
        <div className={`${SEG} justify-self-start`} role="radiogroup" aria-label={t('guardian.introspect.handling')}>
          {['report', 'auto'].map((h) => (
            <button key={h} type="button" role="radio" aria-checked={c.handling === h} onClick={() => set({ handling: h })} className={segBtn(c.handling === h)}>
              {t(`guardian.introspect.handling.${h}`)}
            </button>
          ))}
        </div>
      </div>
      )}
      <div className="text-[11px] text-zinc-400">
        {last ? t('guardian.introspect.last', { time: fmtTime(last.at, lang) }) : t('guardian.introspect.never')}
        {note && <span className="ml-2 text-zinc-500 dark:text-zinc-300">{note}</span>}
      </div>
      {last && view !== 'settings' && (
        <ul className="space-y-1">
          {SCOPES.filter((k) => last.sections?.[k]?.summary).map((k) => (
            <li key={k} className="flex gap-2 text-[11px] leading-relaxed">
              <span className="shrink-0 w-[4.5rem] text-zinc-400">{t(`guardian.scope.${k}`)}</span>
              <span className="min-w-0 text-zinc-600 dark:text-zinc-300">{last.sections[k].summary}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const STATUS_CLS = {
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  suggested: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  info: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  failed: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  undone: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  dismissed: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  resolved: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

function fmtTime(ts, lang) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * 设置页「智能看护」：总开关、各类处理方式、自动处理记录（撤销 / 采纳 / 忽略）、立即检查。
 * 桌面版走 preload，Docker 走 webBridge，接口同名（window.electronAPI.guardian）。
 */
export default function GuardianPanel({ page = false }) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const api = typeof window !== 'undefined' ? window.electronAPI?.guardian : null;
  const [settings, setSettings] = useState(null);
  const [records, setRecords] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState(null);
  const [showHandled, setShowHandled] = useState(false);
  const [health, setHealth] = useState(null);
  // 看护页分两个页签：运行情况 / 设置（记住上次选的）
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('tokenbank.guardian.tab') === 'settings' ? 'settings' : 'status'; } catch { return 'status'; }
  });
  const switchTab = (v) => {
    setTab(v);
    try { localStorage.setItem('tokenbank.guardian.tab', v); } catch { /* ignore */ }
  };
  const location = useLocation();
  // 看护页常驻挂载：每次切回来都刷新状态和记录
  const pageActive = page && location.pathname === '/guardian';

  const load = useCallback(async () => {
    if (!api) return;
    const [s, r, h] = await Promise.all([
      api.getSettings(), api.listRecords({ limit: 50 }), api.health ? api.health().catch(() => null) : null,
    ]);
    if (s?.settings) setSettings(s.settings);
    setRecords(r?.records || []);
    if (h && h.success !== false) setHealth(h);
    try { window.dispatchEvent(new Event('tb-guardian-changed')); } catch { /* ignore */ }
  }, [api]);

  useEffect(() => { load().catch(() => {}); }, [load]);
  useEffect(() => { if (pageActive) load().catch(() => {}); }, [pageActive, load]);
  // 正在执行时每几秒刷新一次状态，结束后停
  const busyNow = (health?.busy || []).length > 0;
  useEffect(() => {
    if (!busyNow || !api?.health) return undefined;
    const timer = setInterval(() => {
      api.health().then((h) => { if (h && h.success !== false) setHealth(h); }).catch(() => {});
    }, 4000);
    return () => clearInterval(timer);
  }, [busyNow, api]);

  if (!api) return null;

  const save = async (patch) => {
    const r = await api.setSettings(patch);
    if (r?.settings) setSettings(r.settings);
    if (typeof patch.enabled === 'boolean') load().catch(() => {});
  };

  const act = async (kind, id, index) => {
    setBusy(index != null ? `${kind}:${id}:${index}` : `${kind}:${id}`);
    setMsg('');
    try {
      const r = kind === 'act' ? await api.act(id, index) : await api[kind](id);
      if (r && r.success === false) setMsg(r.error || t('guardian.actionFailed'));
      await load();
    } finally {
      setBusy('');
    }
  };

  const runChecks = async () => {
    setBusy('checks');
    setMsg('');
    setTimeout(() => { try { window.dispatchEvent(new Event('tb-guardian-changed')); } catch { /* ignore */ } }, 300);
    try {
      const r = await api.runChecks();
      const p = r?.results?.projection;
      const a = r?.results?.assets;
      const parts = [];
      if (p && !p.skipped) parts.push(t('guardian.checkDone', { broken: p.broken || 0, repaired: p.repaired || 0, suggested: p.suggested || 0 }));
      if (a && !a.skipped) parts.push(t('guardian.assetsDone', { skills: a.skills || 0, quality: a.quality || 0, risky: a.risky || 0, dups: a.duplicates || 0, updates: a.updates || 0 }));
      setMsg(parts.length ? parts.join('；') : t('guardian.checkDoneSimple'));
      await load();
    } finally {
      setBusy('');
    }
  };

  const OPEN = ['info', 'failed', 'suggested'];
  const pending = records.filter(r => OPEN.includes(r.status));
  const handled = records.filter(r => !OPEN.includes(r.status));
  const go = (link) => navigate(link.to, link.state ? { state: link.state } : undefined);

  const renderRecord = (r) => {
    const open = OPEN.includes(r.status);
    const acts = open && Array.isArray(r.actions) ? r.actions : [];
    const legacyApply = open && r.status === 'suggested' && r.apply && !acts.length;
    const hasButtons = (r.status === 'done' && r.undo) || open;
    return (
      <li key={r.id} className="rounded-xl px-2.5 py-2 hover:bg-white/60 dark:hover:bg-white/[0.03]">
        <div className="flex items-start gap-2">
          <span className={`shrink-0 mt-px text-[10px] px-1.5 py-px rounded ${STATUS_CLS[r.status] || STATUS_CLS.info}`}>
            {r.status === 'done' && r.actedLabel ? r.actedLabel : t(`guardian.status.${r.status}`)}
          </span>
          <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)} className="min-w-0 flex-1 text-left">
            <div className="text-xs text-zinc-800 dark:text-zinc-100">
              {r.title}
              {r.count > 1 && <span className="ml-1.5 text-[10px] text-zinc-400">×{r.count}</span>}
            </div>
            {open && r.advice && <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{r.advice}</div>}
            {r.status === 'done' && r.resultNote && <div className="text-[11px] text-emerald-700 dark:text-emerald-400 mt-0.5">{r.resultNote}</div>}
            {open && r.lastError && <div className="text-[11px] text-rose-600 dark:text-rose-400 mt-0.5">{r.lastError}</div>}
            {openId === r.id && r.detail && (
              <div className="text-[11px] font-mono text-zinc-400 mt-1 break-all">{r.detail}</div>
            )}
          </button>
          <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{fmtTime(r.lastAt || r.at, lang)}</span>
        </div>
        {hasButtons ? (
          <div className="flex flex-wrap gap-1.5 mt-1.5 pl-[3.25rem]">
            {r.status === 'done' && r.undo && (
              <button type="button" disabled={!!busy} onClick={() => act('undo', r.id)}
                className="text-[11px] px-2 py-0.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
                {busy === `undo:${r.id}` ? t('resources.busy') : t('guardian.undo')}
              </button>
            )}
            {acts.map((a, i) => (
              <button key={i} type="button" disabled={!!busy} onClick={() => act('act', r.id, i)}
                className={i === 0
                  ? 'text-[11px] px-2 py-0.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50'
                  : 'text-[11px] px-2 py-0.5 rounded-md border border-blue-200 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50'}>
                {busy === `act:${r.id}:${i}` ? t('resources.busy') : a.label}
              </button>
            ))}
            {legacyApply && (
              <button type="button" disabled={!!busy} onClick={() => act('apply', r.id)}
                className="text-[11px] px-2 py-0.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                {busy === `apply:${r.id}` ? t('resources.busy') : t('guardian.apply')}
              </button>
            )}
            {r.link && open && (
              <button type="button" onClick={() => go(r.link)}
                className={acts.length || legacyApply
                  ? 'text-[11px] px-2 py-0.5 rounded-md text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800'
                  : 'text-[11px] px-2 py-0.5 rounded-md border border-blue-200 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40'}>
                {r.link.label || t('guardian.go')} →
              </button>
            )}
            {open && (
              <button type="button" onClick={() => askGuardian(navigate, recordQuestion(r, lang))}
                className="text-[11px] px-2 py-0.5 rounded-md text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800">
                {t('guardian.ask')}
              </button>
            )}
            {open && (
              <button type="button" disabled={!!busy} onClick={() => act('dismiss', r.id)}
                className="text-[11px] px-2 py-0.5 rounded-md text-zinc-400 hover:text-zinc-600 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
                {t('guardian.dismiss')}
              </button>
            )}
          </div>
        ) : null}
      </li>
    );
  };

  const showStatus = page && tab === 'status';
  const showSettings = !page || tab === 'settings';

  return (
    <div className="tb-soft-card rounded-2xl overflow-hidden">
      {page && (
        <div className="px-5 pt-3 border-b border-white/40 dark:border-white/[0.06] flex items-center gap-1" role="tablist" aria-label={t('guardian.title')}>
          {['status', 'settings'].map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => switchTab(k)}
              className={`text-xs px-3 py-2 -mb-px border-b-2 ${tab === k ? 'border-zinc-800 dark:border-zinc-100 font-semibold text-zinc-900 dark:text-zinc-50' : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`}>
              {t(`guardian.tab.${k}`)}
              {k === 'status' && health?.level === 'warn' && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle" aria-hidden />}
            </button>
          ))}
        </div>
      )}

      {/* 运行情况：状态、正在执行、最近一次自省、自动处理记录 */}
      {showStatus && (settings?.enabled
        ? <RuntimeSection health={health} api={api} t={t} lang={lang} navigate={navigate} onChanged={load} />
        : (
          <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06] flex flex-wrap items-center gap-2 text-xs text-zinc-500">
            <HealthBadge health={health} t={t} />
            <span>{t('guardian.offHint')}</span>
            <button type="button" onClick={() => switchTab('settings')} className="text-blue-600 dark:text-blue-400 hover:underline">{t('guardian.tab.settings')} →</button>
          </div>
        ))}
      {showStatus && settings && api.introspectNow && (
        <IntrospectSection settings={settings} save={save} api={api} t={t} lang={lang} onRan={load} view="report" />
      )}

      {/* 设置：总开关、执行应用、各类处理方式、定期自省 */}
      {showSettings && (
        <>
          <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06] flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex flex-wrap items-center gap-2">
                {page ? t('guardian.masterSwitch') : t('guardian.title')}
                {/* 看护页里「运行环境」已显示状态，总开关这一行不再重复（关闭时仍显示「已关闭」） */}
                {(!page || !settings?.enabled) && <HealthBadge health={health} t={t} />}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">{t('guardian.hint')}</p>
            </div>
            {settings && (
              <label className="shrink-0 inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={!!settings.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
                {settings.enabled ? t('guardian.on') : t('guardian.off')}
              </label>
            )}
          </div>
          {settings?.enabled && page && <RunnerAppSetting health={health} api={api} t={t} navigate={navigate} onChanged={load} />}
          {!page && settings?.enabled && <RuntimeSection health={health} api={api} t={t} lang={lang} navigate={navigate} onChanged={load} />}
      {settings && (
        <div className="px-5 py-3 space-y-2.5 border-b border-white/40 dark:border-white/[0.06]">
          {CATS.map((c) => (
            <div key={c} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{t(`guardian.cat.${c}`)}</div>
                <div className="text-[11px] text-zinc-400">{t(`guardian.cat.${c}.hint`)}</div>
              </div>
              <div className={`inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/70 ${settings.enabled ? '' : 'opacity-50 pointer-events-none'}`} role="radiogroup" aria-label={t(`guardian.cat.${c}`)}>
                {MODES.map((m) => (
                  <button key={m} type="button" role="radio" aria-checked={settings.modes?.[c] === m}
                    onClick={() => save({ modes: { [c]: m } })}
                    className={`text-[11px] px-2.5 py-1 rounded-md ${settings.modes?.[c] === m ? 'bg-white dark:bg-zinc-900 shadow-sm font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-500'}`}>
                    {t(`guardian.mode.${m}`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span>{t('guardian.modelBudget')}</span>
            <input type="number" min="0" max="100" value={settings.modelExplainPerDay ?? 10}
              onChange={(e) => save({ modelExplainPerDay: Number(e.target.value) || 0 })}
              className="w-16 px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-100" />
            <span>{t('guardian.modelBudgetUnit')}</span>
          </div>
        </div>
      )}

          {settings && api.introspectNow && (
            <IntrospectSection settings={settings} save={save} api={api} t={t} lang={lang} onRan={load} view={page ? 'settings' : 'all'} />
          )}
        </>
      )}

      {(showStatus || !page) && (<>
      <div className="px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-200 whitespace-nowrap">{t('guardian.records')}</h3>
          <div className="text-[11px] text-zinc-400">{t('guardian.checkHint')}</div>
        </div>
        {msg && <span className="order-last basis-full text-[11px] text-zinc-500 dark:text-zinc-400">{msg}</span>}
        <button type="button" onClick={runChecks} disabled={busy === 'checks'}
          className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
          {busy === 'checks' ? t('guardian.checking') : t('guardian.checkNow')}
        </button>
      </div>
      {records.length === 0 ? (
        <p className="px-5 pb-4 text-[11px] text-zinc-400">{t('guardian.empty')}</p>
      ) : (
        <div className="px-3 pb-3 max-h-[480px] overflow-y-auto">
          {pending.length === 0 ? (
            <p className="px-2.5 py-2 text-[11px] text-zinc-400">{t('guardian.noPending')}</p>
          ) : (
            <>
              <div className="px-2.5 pt-1 pb-1 text-[10px] font-medium text-zinc-400">{t('guardian.pending', { n: pending.length })}</div>
              <ul className="space-y-1">{pending.map(renderRecord)}</ul>
            </>
          )}
          {handled.length > 0 && (
            <>
              <button type="button" onClick={() => setShowHandled(v => !v)}
                className="mt-2 px-2.5 py-1 text-[10px] font-medium text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                {showHandled ? '▾' : '▸'} {t('guardian.handled', { n: handled.length })}
              </button>
              {showHandled && <ul className="space-y-1">{handled.map(renderRecord)}</ul>}
            </>
          )}
        </div>
      )}
      </>)}
    </div>
  );
}
