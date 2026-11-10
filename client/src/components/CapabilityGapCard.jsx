import React, { useCallback, useEffect, useState } from 'react';
import { useLang } from '../store/lang';

/**
 * 发现页置顶「能力缺口」：最近常做却没有对应技能的事。数据来自看护（纯规则，不花 token）。
 * 有对得上的免费社区条目时可一键装上（可撤销）；也可以忽略（30 天内不再提）。
 */
export default function CapabilityGapCard({ onChanged, onSearch }) {
  const { t } = useLang();
  const api = typeof window !== 'undefined' ? window.electronAPI?.guardian : null;
  const [gaps, setGaps] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    if (!api?.capabilityGaps) return;
    try {
      const r = await api.capabilityGaps();
      setGaps(r?.gaps || []);
    } catch { /* 看护不可用时不显示 */ }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  if (!gaps.length) return null;

  const act = async (kind, g) => {
    setBusy(`${kind}:${g.id}`);
    setMsg('');
    try {
      const r = await api[kind](g.id);
      if (r && r.success === false) setMsg(r.error || t('guardian.actionFailed'));
      else if (kind === 'apply') setMsg(t('resources.gap.installed', { name: g.meta?.offer?.name || '' }));
      await load();
      if (kind === 'apply') onChanged?.();
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="tb-soft-card rounded-2xl px-4 py-3.5 border border-amber-200/70 dark:border-amber-900/50">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{t('resources.gap.title')}</h2>
        <span className="text-[11px] text-zinc-400">{t('resources.gap.hint')}</span>
      </div>
      <ul className="mt-2.5 space-y-2">
        {gaps.map((g) => (
          <li key={g.id} className="rounded-xl bg-white/60 dark:bg-white/[0.03] px-3 py-2">
            <div className="text-xs text-zinc-800 dark:text-zinc-100">{g.title}</div>
            {g.advice && <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{g.advice}</div>}
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {g.apply && (
                <button type="button" disabled={!!busy} onClick={() => act('apply', g)}
                  className="text-[11px] px-2.5 py-0.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                  {busy === `apply:${g.id}` ? t('resources.busy') : t('resources.gap.install', { name: g.meta?.offer?.name || '' })}
                </button>
              )}
              <button type="button" onClick={() => onSearch?.(g.meta?.offer?.name || g.meta?.label || '')}
                className="text-[11px] px-2.5 py-0.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800">
                {t('resources.gap.search')}
              </button>
              <button type="button" disabled={!!busy} onClick={() => act('dismiss', g)}
                className="text-[11px] px-2 py-0.5 rounded-md text-zinc-500 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
                {t('resources.gap.dismiss')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {msg && <p className="mt-2 text-[11px] text-zinc-500 dark:text-zinc-400">{msg}</p>}
    </section>
  );
}
