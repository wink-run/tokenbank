import React, { useEffect, useState } from 'react';
import { getTransactions } from '../api/client';
import { useLang } from '../store/lang';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = 'community-skill:';

function parseTs(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v);
  return Date.parse(/[zZ+]|T.*-\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`);
}

/** 只读：近 7 天自己分享的资产被纳管了几次、拿了多少积分（来自积分流水） */
export function summarizeEarnings(transactions = [], now = Date.now()) {
  const byItem = new Map();
  let n = 0;
  let credits = 0;
  for (const tx of transactions) {
    const model = String(tx?.model_name || '');
    if (tx?.type !== 'contribute' || !model.startsWith(PREFIX)) continue;
    const ts = parseTs(tx.created_at);
    if (!Number.isFinite(ts) || now - ts > WEEK_MS) continue;
    const delta = Number(tx.delta) || 0;
    if (delta <= 0) continue;
    const id = model.slice(PREFIX.length);
    const cur = byItem.get(id) || { id, n: 0, credits: 0 };
    cur.n += 1;
    cur.credits += delta;
    byItem.set(id, cur);
    n += 1;
    credits += delta;
  }
  const top = [...byItem.values()].sort((a, b) => b.credits - a.credits).slice(0, 3);
  return { n, credits, top };
}

export default function CommunityEarningsCard() {
  const { t } = useLang();
  const [data, setData] = useState(null);
  const [names, setNames] = useState({});

  useEffect(() => {
    if (!localStorage.getItem('token')) return;
    getTransactions()
      .then((r) => setData(summarizeEarnings(r?.data?.transactions || [])))
      .catch(() => {});
    window.electronAPI?.resource?.listCatalog?.({})
      .then((r) => {
        const map = {};
        for (const c of r?.items || []) map[c.catalogId] = c.display_name || c.name;
        setNames(map);
      })
      .catch(() => {});
  }, []);

  if (!data) return null;
  const fmt = (x) => x.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <div className="tb-soft-card rounded-2xl px-5 py-4 mb-4">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{t('trade.earnings.title')}</h2>
        <span className="text-[11px] text-zinc-400">{t('trade.earnings.hint')}</span>
      </div>
      <p className="mt-2 text-xs text-zinc-700 dark:text-zinc-200">
        {data.n ? t('trade.earnings.week', { n: data.n, credits: fmt(data.credits) }) : t('trade.earnings.none')}
      </p>
      {data.top.length > 0 && (
        <ul className="mt-2 space-y-1">
          {data.top.map((it) => (
            <li key={it.id} className="flex items-center gap-2 text-[11px]">
              <span className="text-zinc-400 shrink-0">{t('trade.earnings.top')}</span>
              <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-200">{names[it.id] || it.id}</span>
              <span className="ml-auto tabular-nums text-green-600 dark:text-green-400">+{fmt(it.credits)} · ×{it.n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
