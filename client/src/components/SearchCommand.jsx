import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

/**
 * 说一句话就办：资产页搜索框按回车后，如果这句话是管理类指令（安装、启用、停用、诊断、体检、自省、换执行应用、整理、清理闲置），
 * 在搜索框下方弹出确认；确认后由看护执行。做事的请求引导到游乐场。普通搜索词不弹。
 */
export function useSearchCommand() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.guardian : null;
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  /** 回车时调用；返回 true 表示当成指令处理了 */
  const tryCommand = async (text) => {
    const s = String(text || '').trim();
    if (!api?.commandParse || s.length < 2) return false;
    setResult(null);
    try {
      // 短词多半是在搜索，不去问模型
      const r = await api.commandParse({ text: s, allowModel: s.length >= 6 });
      const p = r?.plan;
      if (!p || (p.action === 'unknown' && !p.reason)) { setPlan(null); return false; }
      setPlan(p);
      return true;
    } catch { return false; }
  };

  const run = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const r = await api.commandRun(plan);
      setResult(r?.success ? { ok: true, message: r.message, link: r.link } : { ok: false, message: r?.error || '' });
      try { window.dispatchEvent(new Event('tb-guardian-changed')); } catch { /* ignore */ }
    } finally {
      setBusy(false);
    }
  };

  const close = () => { setPlan(null); setResult(null); };
  return { plan, result, busy, tryCommand, run, close };
}

export default function SearchCommandPanel({ cmd, onSearchOnly }) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { plan, result, busy, run, close } = cmd;
  if (!plan) return null;
  const unknown = plan.action === 'unknown';
  const go = (link) => { close(); navigate(link.to, link.state ? { state: link.state } : undefined); };

  return (
    <div className="absolute right-0 top-full mt-1.5 z-30 w-[22rem] max-w-[80vw] rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg p-3 space-y-2" role="dialog" aria-label={t('resources.cmd.title')}>
      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden />
        {t('resources.cmd.title')}
        {plan.source === 'model' && <span className="ml-1">· {t('resources.cmd.byModel')}</span>}
      </div>
      {!result ? (
        <>
          <p className={`text-xs ${unknown ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-800 dark:text-zinc-100'}`}>
            {unknown || plan.action === 'business' ? plan.describe : t('resources.cmd.confirm', { what: plan.describe })}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {!unknown && plan.action !== 'business' && (
              <button type="button" onClick={run} disabled={busy}
                className="text-[11px] px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50">
                {busy ? t('resources.busy') : plan.readOnly ? t('resources.cmd.view') : t('resources.cmd.run')}
              </button>
            )}
            {plan.action === 'business' && (
              <button type="button" onClick={() => go({ to: '/debug', state: { prompt: plan.text } })}
                className="text-[11px] px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-500">
                {t('resources.cmd.toPlayground')} →
              </button>
            )}
            <button type="button" onClick={() => { close(); onSearchOnly?.(); }}
              className="text-[11px] px-2.5 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              {t('resources.cmd.searchOnly')}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className={`text-xs whitespace-pre-wrap ${result.ok ? 'text-zinc-800 dark:text-zinc-100' : 'text-rose-600 dark:text-rose-400'}`}>{result.message}</p>
          <div className="flex flex-wrap gap-1.5">
            {result.link && (
              <button type="button" onClick={() => go(result.link)}
                className="text-[11px] px-2.5 py-1 rounded-md border border-blue-200 dark:border-blue-900/60 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/40">
                {result.link.label} →
              </button>
            )}
            <button type="button" onClick={close}
              className="text-[11px] px-2.5 py-1 rounded-md text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              {t('resources.cmd.close')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
