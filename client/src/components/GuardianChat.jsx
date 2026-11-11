import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

function Spark({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z" />
    </svg>
  );
}

/**
 * 看护对话页：像管家一样说话，不是表单。
 * 看护主动说的话、简报、用户的话都在一条对话里；只有最后一条看护消息下面有快捷回复（可不用，直接打字）。
 * 桌面版走 preload，Docker 走 webBridge（window.electronAPI.guardian.convo*）。
 */
export default function GuardianChat() {
  const { t } = useLang();
  const navigate = useNavigate();
  const api = typeof window !== 'undefined' ? window.electronAPI?.guardian : null;
  const [messages, setMessages] = useState([]);
  const [runtime, setRuntime] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);
  const location = useLocation();

  // 从别的页面带着问题过来（比如资产诊断里的「问问看护」）：放进输入框，用户自己发
  useEffect(() => {
    const p = location.state?.prompt;
    if (typeof p === 'string' && p.trim()) {
      setText(p);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useCallback((r) => {
    if (!r || r.success === false) return;
    if (Array.isArray(r.messages)) setMessages(r.messages);
    if (r.runtime) setRuntime(r.runtime);
  }, []);

  const refresh = useCallback(async () => {
    if (!api?.convoList) return;
    try { apply(await api.convoList()); } catch { /* 保持上一次 */ }
  }, [api, apply]);

  // 打开：问候 / 简报，并把消息标成已读（侧边栏的未读标记随之清掉）
  useEffect(() => {
    if (!api?.convoOpen) return;
    api.convoOpen().then((r) => {
      apply(r);
      try { window.dispatchEvent(new Event('tb-guardian-changed')); } catch { /* ignore */ }
    }).catch(() => {});
  }, [api, apply]);

  // 有回答在路上时轮询；平时慢一点看有没有新推送
  const waiting = messages.some(m => m.pending);
  useEffect(() => {
    const timer = setInterval(refresh, waiting ? 1500 : 15000);
    return () => clearInterval(timer);
  }, [refresh, waiting]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [messages.length, waiting]);

  if (!api?.convoOpen) return null;

  const after = async (r) => {
    await refresh();
    if (r && r.nav && r.nav.to) navigate(r.nav.to, r.nav.state ? { state: r.nav.state } : undefined);
  };

  const send = async (value) => {
    const v = String(value == null ? text : value).trim();
    if (!v || sending) return;
    setSending(true);
    setText('');
    setMessages(list => [...list, { id: `local-${Date.now()}`, from: 'user', text: v }]);
    try { await after(await api.convoSay(v)); } finally { setSending(false); }
  };

  const pick = async (m, i) => {
    if (sending) return;
    setSending(true);
    try { await after(await api.convoQuick(m.id, i)); } finally { setSending(false); }
  };

  const changeRuntime = async () => {
    await api.convoRuntime();
    await refresh();
  };

  // 只有最后一条、还没回答的看护消息显示快捷回复
  const last = messages[messages.length - 1];
  const cur = runtime && (runtime.runtimes || []).find(r => r.id === runtime.runtime);

  return (
    <div className="flex flex-col h-full w-full max-w-[720px] mx-auto px-4 py-4">
      <header className="flex items-center gap-2 pb-3">
        <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('guardian.chat.title')}</h1>
        <button type="button" onClick={changeRuntime}
          className="ml-auto text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 px-1 py-2">
          {cur ? t('guardian.chat.poweredBy', { name: cur.label }) : t('guardian.chat.noRuntime')} · <span className="text-blue-600 dark:text-blue-400">{t('guardian.chat.change')}</span>
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-5 pb-4" role="log" aria-live="polite">
        {messages.map((m) => (m.from === 'user' ? (
          <div key={m.id} className="flex justify-end">
            <div className="max-w-[78%] rounded-2xl bg-blue-600 text-white px-4 py-2 text-[15px] leading-relaxed whitespace-pre-wrap">{m.text}</div>
          </div>
        ) : (
          <div key={m.id} className="flex items-start gap-3">
            <span className="shrink-0 mt-0.5 w-7 h-7 rounded-full bg-white dark:bg-zinc-800 flex items-center justify-center text-amber-600 dark:text-amber-400">
              <Spark className="w-3.5 h-3.5" />
            </span>
            <div className="min-w-0 space-y-2">
              {m.pending ? (
                <p className="text-[15px] leading-relaxed text-zinc-400">{t('guardian.chat.thinking')}</p>
              ) : (
                <p className="text-[15px] leading-[1.75] text-zinc-900 dark:text-zinc-100 whitespace-pre-wrap">{m.text}</p>
              )}
              {m === last && !m.answered && (m.replies || []).length > 0 && (
                <div className="flex flex-wrap gap-2 pt-0.5">
                  {m.replies.map((r, i) => (
                    <button key={i} type="button" disabled={sending} onClick={() => pick(m, i)}
                      className="min-h-[36px] px-4 rounded-full border border-zinc-300 dark:border-zinc-600 text-sm text-zinc-800 dark:text-zinc-100 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50">
                      {r.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )))}
        <div ref={endRef} />
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(); }}
        className="flex items-end gap-2 rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200/70 dark:border-zinc-700 pl-4 pr-2 py-2">
        <label htmlFor="guardian-say" className="sr-only">{t('guardian.chat.placeholder')}</label>
        <textarea id="guardian-say" rows={1} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          placeholder={t('guardian.chat.placeholder')}
          className="flex-1 resize-none bg-transparent outline-none text-[15px] leading-relaxed py-1.5 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400" />
        <button type="submit" disabled={sending || !text.trim()} aria-label={t('guardian.chat.send')}
          className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center disabled:opacity-40">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </form>
    </div>
  );
}
