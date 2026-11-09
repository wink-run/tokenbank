import React, { useRef, useState } from 'react';
import { useLang } from '../store/lang';
import { copyMessageContent, messageImageSrcs } from '../lib/copy-message';

const TONE = {
  soft: 'bg-zinc-100/90 dark:bg-zinc-700/90 text-zinc-500 dark:text-zinc-300 border border-zinc-200/80 dark:border-zinc-600',
  onBlue: 'bg-white/20 hover:bg-white/30 text-white',
};

/** 悬停出现。点一下把这条消息的文字和图片都放进剪贴板。 */
export default function CopyMessageButton({ text = '', images, artifacts, tone = 'soft' }) {
  const { t } = useLang();
  const [done, setDone] = useState(false);
  const timer = useRef(null);
  const srcs = messageImageSrcs(images, artifacts);
  if (!String(text || '').trim() && !srcs.length) return null;

  const onClick = async (event) => {
    event.stopPropagation();
    event.preventDefault();
    const ok = await copyMessageContent({ text, images: srcs });
    if (!ok) return;
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`absolute top-2 right-2 px-2 py-0.5 text-[11px] rounded-lg opacity-0 group-hover:opacity-100 transition-opacity ${TONE[tone] || TONE.soft}`}
    >
      {done ? t('debug.copied') : t('debug.copy')}
    </button>
  );
}
