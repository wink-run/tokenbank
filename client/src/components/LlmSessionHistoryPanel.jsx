// LLM Playground：本地历史会话面板（浏览 / 恢复 / 删除）
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  deleteLlmSessionSnapshot,
  formatSessionTime,
  sessionLastSpokenAt,
  listLlmSessionSnapshots,
} from '../lib/debug-session-history';
import { useLang } from '../store/lang';

export default function LlmSessionHistoryPanel({ open, onClose, onRestore }) {
  const { t } = useLang();
  const [items, setItems] = useState([]);

  const refresh = useCallback(() => {
    setItems(listLlmSessionSnapshots());
  }, []);

  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  function handleRestore(item) {
    onRestore?.({
      conversation: item.conversation || [],
      systemPrompt: item.systemPrompt || '',
      imageMode: !!item.imageMode,
    });
    onClose?.();
  }

  function handleDelete(e, id) {
    e.stopPropagation();
    deleteLlmSessionSnapshot(id);
    refresh();
  }

  if (!open) return null;

  return createPortal(
    <div
      className="electron-no-drag fixed inset-0 z-[9998] flex items-end sm:items-center justify-center bg-black/40 p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md max-h-[75vh] bg-white dark:bg-zinc-900 rounded-t-2xl sm:rounded-2xl border border-zinc-200 dark:border-zinc-700 shadow-xl flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t('debug.history.title')}</h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">{t('debug.history.llmLabel')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {!items.length && (
            <p className="text-center text-sm text-zinc-400 py-10">{t('debug.history.empty')}</p>
          )}

          {items.length > 0 && (
            <section>
              <p className="px-2 py-1 text-[10px] font-medium text-zinc-400 uppercase tracking-wide">{t('debug.history.saved')}</p>
              <ul className="space-y-1">
                {items.map(item => (
                  <li key={item.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => handleRestore(item)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleRestore(item);
                        }
                      }}
                      className="w-full text-left px-3 py-2.5 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors group cursor-pointer"
                    >
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-zinc-800 dark:text-zinc-200 truncate">{item.title}</p>
                          <p className="text-[11px] text-zinc-400 mt-0.5">
                            {formatSessionTime(sessionLastSpokenAt(item))}
                            {item.turnCount > 1 ? t('debug.history.turns', { n: item.turnCount }) : ''}
                            {item.imageMode ? ` · ${t('debug.modeImage')}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          title={t('debug.history.delete')}
                          onClick={e => handleDelete(e, item.id)}
                          className="opacity-0 group-hover:opacity-100 shrink-0 text-zinc-400 hover:text-red-500 text-xs px-1"
                        >
                          {t('debug.history.delete')}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
