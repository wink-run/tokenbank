import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

const CATS = ['projection', 'gateway', 'install', 'assets', 'discover', 'setup', 'community'];
const MODES = ['auto', 'suggest', 'off'];
const FREQS = ['off', 'daily', 'weekly', 'monthly'];
const SCOPES = ['assets', 'routes', 'models', 'savings', 'rules'];
const SEG = 'inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/70';
const segBtn = (on) => `text-[11px] px-2.5 py-1 rounded-md ${on ? 'bg-white dark:bg-zinc-900 shadow-sm font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-500'}`;
const INPUT = 'px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-zinc-800 dark:text-zinc-100';

/** 定期自省：频率、时段、token 上限、范围、结果处理、立即运行 */
function IntrospectSection({ settings, save, api, t, lang, onRan }) {
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
          <div className="text-xs font-medium text-zinc-800 dark:text-zinc-100">{t('guardian.introspect.title')}</div>
          <div className="text-[11px] text-zinc-400">{t('guardian.introspect.hint')}</div>
        </div>
        <button type="button" onClick={runNow} disabled={busy || !settings.enabled}
          className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
          {busy ? t('guardian.introspect.running') : t('guardian.introspect.runNow')}
        </button>
      </div>
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
      <div className="text-[11px] text-zinc-400">
        {last ? t('guardian.introspect.last', { time: fmtTime(last.at, lang) }) : t('guardian.introspect.never')}
        {note && <span className="ml-2 text-zinc-500 dark:text-zinc-300">{note}</span>}
      </div>
      {last && (
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
export default function GuardianPanel() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const api = typeof window !== 'undefined' ? window.electronAPI?.guardian : null;
  const [settings, setSettings] = useState(null);
  const [records, setRecords] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [openId, setOpenId] = useState(null);

  const load = useCallback(async () => {
    if (!api) return;
    const [s, r] = await Promise.all([api.getSettings(), api.listRecords({ limit: 50 })]);
    if (s?.settings) setSettings(s.settings);
    setRecords(r?.records || []);
  }, [api]);

  useEffect(() => { load().catch(() => {}); }, [load]);

  if (!api) return null;

  const save = async (patch) => {
    const r = await api.setSettings(patch);
    if (r?.settings) setSettings(r.settings);
  };

  const act = async (kind, id) => {
    setBusy(`${kind}:${id}`);
    setMsg('');
    try {
      const r = await api[kind](id);
      if (r && r.success === false) setMsg(r.error || t('guardian.actionFailed'));
      await load();
    } finally {
      setBusy('');
    }
  };

  const runChecks = async () => {
    setBusy('checks');
    setMsg('');
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

  return (
    <div className="tb-soft-card rounded-2xl overflow-hidden">
      <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06] flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('guardian.title')}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{t('guardian.hint')}</p>
        </div>
        {settings && (
          <label className="shrink-0 inline-flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={!!settings.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
            {settings.enabled ? t('guardian.on') : t('guardian.off')}
          </label>
        )}
      </div>

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
        <IntrospectSection settings={settings} save={save} api={api} t={t} lang={lang} onRan={load} />
      )}

      <div className="px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-200 flex-1 whitespace-nowrap">{t('guardian.records')}</h3>
        {msg && <span className="order-last basis-full text-[11px] text-zinc-500 dark:text-zinc-400">{msg}</span>}
        <button type="button" onClick={runChecks} disabled={busy === 'checks'}
          className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
          {busy === 'checks' ? t('guardian.checking') : t('guardian.checkNow')}
        </button>
      </div>
      {records.length === 0 ? (
        <p className="px-5 pb-4 text-[11px] text-zinc-400">{t('guardian.empty')}</p>
      ) : (
        <ul className="px-3 pb-3 space-y-1 max-h-[420px] overflow-y-auto">
          {records.map((r) => (
            <li key={r.id} className="rounded-xl px-2.5 py-2 hover:bg-white/60 dark:hover:bg-white/[0.03]">
              <div className="flex items-start gap-2">
                <span className={`shrink-0 mt-px text-[10px] px-1.5 py-px rounded ${STATUS_CLS[r.status] || STATUS_CLS.info}`}>{t(`guardian.status.${r.status}`)}</span>
                <button type="button" onClick={() => setOpenId(openId === r.id ? null : r.id)} className="min-w-0 flex-1 text-left">
                  <div className="text-xs text-zinc-800 dark:text-zinc-100">
                    {r.title}
                    {r.count > 1 && <span className="ml-1.5 text-[10px] text-zinc-400">×{r.count}</span>}
                  </div>
                  {r.advice && <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{r.advice}</div>}
                  {openId === r.id && r.detail && (
                    <div className="text-[11px] font-mono text-zinc-400 mt-1 break-all">{r.detail}</div>
                  )}
                </button>
                <span className="shrink-0 text-[10px] text-zinc-400 tabular-nums">{fmtTime(r.lastAt || r.at, lang)}</span>
              </div>
              {(r.status === 'done' && r.undo) || r.link || ['info', 'failed', 'suggested'].includes(r.status) ? (
                <div className="flex gap-1.5 mt-1.5 pl-[3.25rem]">
                  {r.status === 'done' && r.undo && (
                    <button type="button" disabled={!!busy} onClick={() => act('undo', r.id)}
                      className="text-[11px] px-2 py-0.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
                      {busy === `undo:${r.id}` ? t('resources.busy') : t('guardian.undo')}
                    </button>
                  )}
                  {r.status === 'suggested' && r.apply && (
                    <button type="button" disabled={!!busy} onClick={() => act('apply', r.id)}
                      className="text-[11px] px-2 py-0.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                      {busy === `apply:${r.id}` ? t('resources.busy') : t('guardian.apply')}
                    </button>
                  )}
                  {r.link && ['info', 'failed', 'suggested'].includes(r.status) && (
                    <button type="button" onClick={() => navigate(r.link.to, r.link.state ? { state: r.link.state } : undefined)}
                      className="text-[11px] px-2 py-0.5 rounded-md border border-blue-200 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40">
                      {r.link.label || t('guardian.go')} →
                    </button>
                  )}
                  {['info', 'failed', 'suggested'].includes(r.status) && (
                    <button type="button" disabled={!!busy} onClick={() => act('dismiss', r.id)}
                      className="text-[11px] px-2 py-0.5 rounded-md text-zinc-500 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
                      {t('guardian.dismiss')}
                    </button>
                  )}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
