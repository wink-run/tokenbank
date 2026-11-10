import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

const POLL_MS = 60 * 1000;
const BUSY_POLL_MS = 4 * 1000;   // 正在执行时勤快一点，结束后动效及时停
// 两颗饱满四角星，小尺寸也能看清。颜色仍区分状态。
const SPARK = 'M12 .8C13.1 6.2 15.2 8.6 21.2 9.6 15.2 10.6 13.1 13 12 18.4 10.9 13 8.8 10.6 2.8 9.6 8.8 8.6 10.9 6.2 12 .8ZM18.4 13.2C18.9 15.4 19.8 16.4 22 17 19.8 17.6 18.9 18.6 18.4 20.8 17.9 18.6 17 17.6 14.8 17 17 16.4 17.9 15.4 18.4 13.2Z';
const TONE = {
  ok: 'text-amber-500 drop-shadow-[0_0_4px_rgba(245,158,11,0.85)]',
  warn: 'text-amber-600 drop-shadow-[0_0_4px_rgba(217,119,6,0.8)]',
  off: 'text-zinc-400 dark:text-zinc-500',
};

function SparkIcon({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d={SPARK} />
    </svg>
  );
}

/**
 * 侧边栏 Logo 旁的 AI 火花：正在被看护（金）/ 需要注意（深金）/ 看护已关闭（灰）。
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

  const busy = (health?.busy || []).length > 0;
  useEffect(() => {
    load();
    const timer = setInterval(load, busy ? BUSY_POLL_MS : POLL_MS);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    // 设置页改了开关 / 执行应用后立即刷新
    window.addEventListener('tb-guardian-changed', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('tb-guardian-changed', onFocus);
    };
  }, [load, busy]);

  if (!api?.health || !health) return null;
  const lv = health.level || 'off';
  const label = busy
    ? t('guardian.dot.busy', { what: health.busy.join('、') })
    : lv === 'warn'
      ? t('guardian.dot.warn', { n: health.issues?.length || 0, first: health.issues?.[0]?.text || '' })
      : t(`guardian.dot.${lv}`);

  return (
    <button
      type="button"
      onClick={() => navigate('/guardian')}
      title={label}
      aria-label={label}
      className="electron-no-drag relative inline-flex items-center justify-center w-4 h-4 shrink-0 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
    >
      {/* 看护开着时只做轻微缩放，不把颜色呼吸淡掉。正在执行时更快 */}
      <style>{'@keyframes tb-spark-breathe{0%,100%{transform:scale(.94)}50%{transform:scale(1.06)}}.tb-spark-breathe{animation:tb-spark-breathe 2.8s ease-in-out infinite;transform-origin:center}.tb-spark-breathe-busy{animation-duration:1.5s}@media (prefers-reduced-motion:reduce){.tb-spark-breathe{animation:none}}'}</style>
      <SparkIcon className={`relative w-4 h-4 origin-center ${TONE[lv]} ${lv === 'off' ? '' : `tb-spark-breathe${busy ? ' tb-spark-breathe-busy' : ''}`}`} />
    </button>
  );
}
