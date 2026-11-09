import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

/**
 * 智能功能缺前置条件时的提醒，与内置智能体（安装助手）的 needAgent 提示同一套样式与动作。
 * @param model / agent  来自 useAiReadiness：false 才提示，null（未知）不打扰
 * @param feature        受影响的功能名，如「一句话生成」
 * @param compact        一行版：用于面板里的附加说明
 */
export default function AiNeedNotice({ model, agent, feature, compact = false, onRetry, onDismiss, className = '' }) {
  const { t } = useLang();
  const navigate = useNavigate();
  const needModel = model === false;
  const needAgent = agent === false;
  if (!needModel && !needAgent) return null;

  const what = needModel && needAgent ? 'both' : needModel ? 'model' : 'agent';
  const title = feature
    ? t(`resources.aiNeed.title.${what}`, { feature })
    : t(`resources.aiNeed.titleAll.${what}`);

  const actions = (
    <>
      {needModel && (
        <button type="button" onClick={() => navigate('/providers')}
          className="px-2.5 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700">
          {t('resources.aiNeed.goModel')}
        </button>
      )}
      {needAgent && (
        <button type="button" onClick={() => navigate('/gateway')}
          className={needModel
            ? 'px-2.5 py-1 rounded-md border border-amber-400/80 text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-950/40'
            : 'px-2.5 py-1 rounded-md bg-amber-600 text-white hover:bg-amber-700'}>
          {t('resources.aiNeed.goAgent')}
        </button>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry}
          className="px-2.5 py-1 rounded-md text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-950/40">
          {t('resources.aiNeed.retry')}
        </button>
      )}
    </>
  );

  if (compact) {
    return (
      <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/80 dark:bg-amber-900/15 px-2.5 py-1.5 text-[11px] ${className}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 text-amber-800 dark:text-amber-200">{title}</span>
        {actions}
      </div>
    );
  }

  return (
    <div className={`rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs space-y-2 ${className}`}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-amber-800 dark:text-amber-200 font-medium">{title}</p>
        {onDismiss && (
          <button type="button" onClick={onDismiss} aria-label={t('resources.aiNeed.dismiss')}
            className="shrink-0 -mt-0.5 text-amber-700/70 hover:text-amber-900 dark:text-amber-300/70 px-1">×</button>
        )}
      </div>
      {needModel && <p className="text-amber-700/80 dark:text-amber-300/70">{t('resources.aiNeed.modelHint')}</p>}
      {needAgent && <p className="text-amber-700/80 dark:text-amber-300/70">{t('resources.aiNeed.agentHint')}</p>}
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}
