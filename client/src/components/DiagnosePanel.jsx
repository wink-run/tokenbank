import React, { useEffect, useState } from 'react';
import { useLang } from '../store/lang';

const DOT = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-400',
  error: 'bg-rose-500',
};

/**
 * 一键诊断：为什么应用里看不到这个资产。结果逐条列出，能修的给「修复」按钮（看护的 resource:diagnose）。
 */
export default function DiagnosePanel({ resourceId, onChanged }) {
  const { t } = useLang();
  const [state, setState] = useState({ loading: false, findings: null, error: '' });
  const [fixing, setFixing] = useState('');
  const api = typeof window !== 'undefined' ? window.electronAPI?.resource : null;

  useEffect(() => { setState({ loading: false, findings: null, error: '' }); }, [resourceId]);

  if (!api?.diagnose || !resourceId) return null;

  const run = async () => {
    setState({ loading: true, findings: null, error: '' });
    try {
      const r = await api.diagnose({ resourceId });
      setState({ loading: false, findings: r?.findings || [], error: r?.ok === false && !r?.findings ? (r?.error || '') : '' });
    } catch (e) {
      setState({ loading: false, findings: null, error: e.message || String(e) });
    }
  };

  const fix = async (type) => {
    setFixing(type);
    try {
      const r = await api.fixDiagnosis({ resourceId, type });
      if (r && r.success === false) setState(s => ({ ...s, error: r.error || t('resources.diagnose.fixFailed') }));
      await onChanged?.();
      await run();
    } finally {
      setFixing('');
    }
  };

  return (
    <div className="rounded-xl border border-zinc-200/80 dark:border-white/[0.08] bg-zinc-50/60 dark:bg-white/[0.02] px-3 py-2 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex-1 min-w-0">{t('resources.diagnose.question')}</span>
        <button type="button" onClick={run} disabled={state.loading || !!fixing}
          className="shrink-0 text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
          {state.loading ? t('resources.diagnose.running') : (state.findings ? t('resources.diagnose.again') : t('resources.diagnose.run'))}
        </button>
      </div>
      {state.error && <p className="text-[11px] text-rose-600 dark:text-rose-400">{state.error}</p>}
      {state.findings && (
        <ul className="space-y-1.5">
          {state.findings.map((f) => (
            <li key={f.code} className="flex items-start gap-2 text-[11px] leading-relaxed">
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${DOT[f.level] || 'bg-zinc-300'}`} aria-hidden />
              <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">{f.text}</span>
              {f.fix && (
                <button type="button" onClick={() => fix(f.fix.type)} disabled={!!fixing}
                  className="shrink-0 px-2 py-0.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                  {fixing === f.fix.type ? t('resources.busy') : f.fix.label}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
