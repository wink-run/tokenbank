import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

const POLL_MS = 60 * 1000;
const DOT = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  off: 'bg-zinc-400 dark:bg-zinc-500',
};

/**
 * 侧边栏 Logo 旁的小圆点：正在被看护（绿）/ 需要注意（黄）/ 看护已关闭（灰）。
 * 悬停看原因，点击跳到设置页的「智能看护」。看护不可用（老版本 / 无接口）时不显示。
 */
export default function GuardianDot() {
  const { t } = useLang();
  const navigate = useNavigate();
  const api = typeof window !== 'undefined' ? window.electronAPI?.guardian : null;
  const [health, setHealth] = useState(null);

  const load = useCallback(async () => {
    if (!api?.health) return;
    try {
      const h = await api.health();
      if (h && h.success !== false) setHealth(h);
    } catch { /* 拿不到就保持上一次 */ }
  }, [api]);

  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    // 设置页改了开关 / 执行应用后立即刷新
    window.addEventListener('tb-guardian-changed', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('tb-guardian-changed', onFocus);
    };
  }, [load]);

  if (!api?.health || !health) return null;
  const lv = health.level || 'off';
  const label = lv === 'warn'
    ? t('guardian.dot.warn', { n: health.issues?.length || 0, first: health.issues?.[0]?.text || '' })
    : t(`guardian.dot.${lv}`);

  return (
    <button
      type="button"
      onClick={() => navigate('/config', { state: { focus: 'guardian' } })}
      title={label}
      aria-label={label}
      className="electron-no-drag relative inline-flex items-center justify-center w-4 h-4 shrink-0 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
    >
      {lv === 'ok' && <span className={`absolute inline-flex w-2.5 h-2.5 rounded-full ${DOT.ok} opacity-60 animate-ping motion-reduce:animate-none`} aria-hidden />}
      <span className={`relative inline-flex w-2 h-2 rounded-full ${DOT[lv]} ring-2 ring-white/80 dark:ring-zinc-900/80`} aria-hidden />
    </button>
  );
}
