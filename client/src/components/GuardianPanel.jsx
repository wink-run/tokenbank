import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../store/lang';

const CATS = ['projection', 'gateway', 'install'];
const MODES = ['auto', 'suggest', 'off'];

const STATUS_CLS = {
  done: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  suggested: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  info: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  failed: 'bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300',
  undone: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  dismissed: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
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
      setMsg(p && !p.skipped
        ? t('guardian.checkDone', { broken: p.broken || 0, repaired: p.repaired || 0, suggested: p.suggested || 0 })
        : t('guardian.checkDoneSimple'));
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

      <div className="px-5 py-3 flex items-center gap-3">
        <h3 className="text-xs font-semibold text-zinc-700 dark:text-zinc-200 flex-1">{t('guardian.records')}</h3>
        {msg && <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{msg}</span>}
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
              {(r.status === 'done' && r.undo) || r.status === 'suggested' || ['info', 'failed', 'suggested'].includes(r.status) ? (
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
