import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { HealthBadge } from './GuardianPanel';

/** 设置页里的「自我进化」入口：只显示状态，点「看护设置」到单独的看护页 */
export default function GuardianEntry() {
  const { t } = useLang();
  const navigate = useNavigate();
  const api = typeof window !== 'undefined' ? window.electronAPI?.guardian : null;
  const [health, setHealth] = useState(null);

  useEffect(() => {
    if (!api?.health) return;
    api.health().then((h) => { if (h && h.success !== false) setHealth(h); }).catch(() => {});
  }, [api]);

  if (!api) return null;
  return (
    <div className="tb-soft-card rounded-2xl px-5 py-4 flex flex-wrap items-center gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 flex flex-wrap items-center gap-2">
          {t('guardian.title')}
          <HealthBadge health={health} t={t} />
        </h2>
        <p className="text-xs text-gray-500 mt-0.5">{t('guardian.hint')}</p>
      </div>
      <button type="button" onClick={() => navigate('/guardian')}
        className="shrink-0 text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800">
        {t('guardian.openSettings')} →
      </button>
    </div>
  );
}
