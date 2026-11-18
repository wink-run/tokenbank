import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

/**
 * 应用里看不到这个资产时，点这一行直接交给智能管家查原因并修。
 */
export default function DiagnosePanel({ resourceId, resourceName, why }) {
  const { t } = useLang();
  const navigate = useNavigate();
  if (!resourceId) return null;
  const problem = String(why || '').trim();

  return (
    <button
      type="button"
      onClick={() => navigate('/guardian', {
        state: {
          autoSend: true,
          prompt: t('resources.diagnose.askPrompt', {
            name: resourceName || resourceId,
            id: resourceId,
            why: problem || t('resources.diagnose.question'),
          }),
        },
      })}
      className="w-full flex items-center gap-2 rounded-xl border border-rose-200/80 dark:border-rose-900/50 bg-rose-50/70 dark:bg-rose-950/20 px-3 py-2 text-left hover:bg-rose-50 dark:hover:bg-rose-950/40"
    >
      <span className="text-[11px] text-rose-700 dark:text-rose-300 flex-1 min-w-0 truncate">{problem || t('resources.diagnose.question')}</span>
      <span className="shrink-0 text-[11px] text-blue-600 dark:text-blue-400">{t('resources.diagnose.ask')} →</span>
    </button>
  );
}
