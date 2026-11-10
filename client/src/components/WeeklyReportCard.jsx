import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

const SECTION_KEYS = ['routes', 'savings', 'models', 'assets', 'rules'];

function fmtDay(ts, lang) {
  return new Date(ts).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric' });
}

/**
 * 盘点页顶部「周报」：最近一次定期自省的报告（自动处理了什么、有哪些建议）。
 * 没有报告或看护不可用时不显示。桌面版走 preload，Docker 走 webBridge。
 */
export default function WeeklyReportCard() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const api = typeof window !== 'undefined' ? window.electronAPI?.guardian : null;
  const [report, setReport] = useState(null);

  useEffect(() => {
    if (!api?.listReports) return;
    api.listReports().then((r) => setReport(r?.reports?.[0] || null)).catch(() => {});
  }, [api]);

  if (!report) return null;
  const lines = SECTION_KEYS.filter((k) => report.sections?.[k]?.summary);

  return (
    <div className="tb-soft-card rounded-2xl px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{t(`guardian.report.title.${['daily', 'monthly'].includes(report.frequency) ? report.frequency : 'weekly'}`)}</h2>
        <span className="text-[11px] text-zinc-400 tabular-nums">
          {fmtDay(report.since, lang)} – {fmtDay(report.at, lang)}
          {report.manual ? ` · ${t('guardian.report.manual')}` : ''}
        </span>
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {lines.map((k) => (
          <li key={k} className="flex gap-2 text-xs leading-relaxed">
            <span className="shrink-0 w-[4.5rem] text-zinc-400">{t(`guardian.scope.${k}`)}</span>
            <span className="min-w-0 text-zinc-700 dark:text-zinc-200">{report.sections[k].summary}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>{t('guardian.report.handled', { n: report.handled?.count || 0 })}</span>
        <span>{t('guardian.report.pending', { n: report.pending?.count || 0 })}</span>
        {report.stoppedForCap && <span className="text-amber-600 dark:text-amber-400">{t('guardian.report.capped')}</span>}
        <button type="button" onClick={() => navigate('/guardian')}
          className="ml-auto text-[11px] px-2.5 py-1 rounded-md border border-blue-200 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40">
          {t('guardian.report.open')} →
        </button>
      </div>
    </div>
  );
}
