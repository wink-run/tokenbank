// 历史会话面板：每个历史对话即一个可继续的 session（单一列表，不再分「已保存 / 最近任务」）
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  deleteAgentSessionSnapshot,
  formatSessionTime,
  hideAgentHistoryTasks,
  isAgentHistoryTaskHidden,
  listAgentSessionSnapshots,
  saveAgentSessionSnapshot,
} from '../lib/debug-session-history';
import { closePendingToolSteps, stepsFromTaskStatus, workingDirBasename } from '../lib/debug-agent-store';
import { useLang } from '../store/lang';

function taskMatchesSessionKey(task, sessionKey) {
  const ctx = task?.context || {};
  const sk = ctx.sessionKey || task?.agent_id;
  if (sessionKey === '__hub__') {
    return sk === '__hub__' || ctx.mode === 'orchestrator';
  }
  return sk === sessionKey;
}

/** 把尚未进本地历史的 DB 单任务，提升为可继续的单轮 session 条目 */
function dbTaskToSessionItem(task, untitled) {
  const turns = [{
    user: String(task.prompt || untitled).trim() || untitled,
    steps: [],
    delegations: {},
    result: null,
    status: task.status === 'cancelled' ? 'failed' : (task.status || 'completed'),
    taskId: task.id,
    timestamp: task.completed_at || task.created_at || Date.now(),
  }];
  return {
    id: `db_${task.id}`,
    source: 'db',
    taskId: task.id,
    title: String(task.prompt || untitled).trim().slice(0, 52) || untitled,
    savedAt: task.completed_at || task.created_at || Date.now(),
    turnCount: 1,
    status: task.status,
    conversationTurns: turns,
    sessionWorkingDir: task.context?.workingDir || '',
    cliSessionId: task.result?.cliSessionId || null,
    sessionKey: task.id ? `task:${task.id}` : null,
  };
}

export default function AgentSessionHistoryPanel({
  open,
  onClose,
  agentKey,
  agentLabel,
  listAgentId,
  onRestore,
  onDeleted,
}) {
  const { t } = useLang();
  const [localItems, setLocalItems] = useState([]);
  const [orphanDbItems, setOrphanDbItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const refreshLocal = useCallback(() => {
    setLocalItems(listAgentSessionSnapshots(agentKey));
  }, [agentKey]);

  const loadOrphanDbSessions = useCallback(async () => {
    if (!open || !window.electronAPI?.agent?.listRecentTasks || !listAgentId) {
      setOrphanDbItems([]);
      return;
    }
    setLoading(true);
    try {
      const res = await window.electronAPI.agent.listRecentTasks({ agentId: listAgentId, limit: 25 });
      if (!res.success || !res.tasks?.length) {
        setOrphanDbItems([]);
        return;
      }
      const untitled = t('debug.history.untitled');
      let locals = listAgentSessionSnapshots(agentKey);
      const localTaskIds = new Set(
        locals.flatMap(
          it => (it.conversationTurns || []).map(tr => tr.taskId).filter(Boolean),
        ),
      );

      const orphans = [];
      for (const task of res.tasks) {
        if (!taskMatchesSessionKey(task, agentKey)) continue;
        if (isAgentHistoryTaskHidden(task.id) || localTaskIds.has(task.id)) continue;

        // 每次循环用最新本地列表，便于同会话连续并入多条 DB 任务
        locals = listAgentSessionSnapshots(agentKey);
        const cliId = String(task.result?.cliSessionId || '').trim();
        const dir = String(task.context?.workingDir || '').replace(/[\\/]+$/, '');
        const mergeTarget = cliId
          ? locals.find(it => String(it.cliSessionId || '').trim() === cliId)
          : null;

        if (mergeTarget?.conversationTurns?.length) {
          saveAgentSessionSnapshot(agentKey, {
            conversationTurns: [
              ...(mergeTarget.conversationTurns || []),
              {
                user: String(task.prompt || untitled).trim() || untitled,
                steps: [],
                delegations: {},
                result: task.result || null,
                status: task.status === 'cancelled' ? 'failed' : (task.status || 'completed'),
                taskId: task.id,
                timestamp: task.completed_at || task.created_at || Date.now(),
              },
            ],
            sessionWorkingDir: mergeTarget.sessionWorkingDir || dir,
            cliSessionId: mergeTarget.cliSessionId || cliId || null,
            historyThreadId: mergeTarget.sessionKey || null,
          });
          localTaskIds.add(task.id);
          continue;
        }

        orphans.push(dbTaskToSessionItem(task, untitled));
      }
      setOrphanDbItems(orphans);
      refreshLocal();
    } catch {
      setOrphanDbItems([]);
    } finally {
      setLoading(false);
    }
  }, [open, agentKey, listAgentId, t, refreshLocal]);

  useEffect(() => {
    if (!open) return;
    refreshLocal();
    loadOrphanDbSessions();
  }, [open, refreshLocal, loadOrphanDbSessions]);

  // 统一会话列表：本地多轮优先，孤儿 DB 任务并入同一列表（按时间）
  const sessions = useMemo(() => {
    const local = (localItems || []).map(it => ({ ...it, source: 'local' }));
    const merged = [...local, ...(orphanDbItems || [])];
    return merged.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  }, [localItems, orphanDbItems]);

  async function handleRestore(item) {
    if (item.source === 'local') {
      onRestore?.({
        conversationTurns: item.conversationTurns || [],
        sessionWorkingDir: item.sessionWorkingDir || '',
        cliSessionId: item.cliSessionId || null,
        sessionKey: item.sessionKey || null,
        historyThreadId: item.sessionKey || null,
      });
      onClose?.();
      return;
    }

    // DB 孤儿任务：拉全量步骤后写入本地 session，便于之后当普通会话继续
    if (!item.taskId || !window.electronAPI?.agent?.getTaskStatus) return;
    try {
      const res = await window.electronAPI.agent.getTaskStatus(item.taskId);
      if (!res.success || !res.status) return;
      const status = res.status;
      const stepsRaw = stepsFromTaskStatus(status);
      const steps = ['running', 'pending'].includes(status.status)
        ? stepsRaw
        : closePendingToolSteps(
          stepsRaw,
          status.status === 'cancelled' ? t('debug.agent.aborted') : t('debug.agent.noResult'),
        );
      const conversationTurns = [{
        user: status.prompt || item.title,
        steps,
        delegations: {},
        result: status.result || null,
        status: status.status === 'cancelled' ? 'failed' : (status.status || 'completed'),
        taskId: status.id,
        timestamp: status.completed_at || status.created_at || Date.now(),
      }];
      const sessionWorkingDir = status.context?.workingDir || '';
      const cliSessionId = status.result?.cliSessionId || null;
      const sessionKey = `task:${status.id}`;

      // 提升为本地 session，列表里不再出现「最近任务」分区
      saveAgentSessionSnapshot(agentKey, {
        conversationTurns,
        sessionWorkingDir,
        cliSessionId,
        historyThreadId: sessionKey,
      });

      onRestore?.({
        conversationTurns,
        sessionWorkingDir,
        cliSessionId,
        sessionKey,
        historyThreadId: sessionKey,
      });
      onClose?.();
    } catch {
      // ignore
    }
  }

  function taskIdsOf(item) {
    const ids = (item?.conversationTurns || []).map(t => t?.taskId).filter(Boolean);
    if (item?.taskId) ids.push(item.taskId);
    return ids;
  }

  function handleDelete(e, item) {
    e.stopPropagation();
    // 数据库里的单轮任务没有本地快照，记下 id 才不会下次又冒出来
    hideAgentHistoryTasks(taskIdsOf(item));
    if (item.source === 'local') {
      deleteAgentSessionSnapshot(item.id);
      refreshLocal();
    } else {
      setOrphanDbItems(prev => prev.filter(x => x.id !== item.id));
    }
    // 删的是当前窗口这场时，对话区也清掉，避免历史没了气泡还在
    onDeleted?.(item);
  }

  if (!open) return null;

  const empty = !sessions.length && !loading;

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
            <p className="text-[11px] text-zinc-500 mt-0.5">{agentLabel || agentKey}</p>
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
          {empty && (
            <p className="text-center text-sm text-zinc-400 py-10">{t('debug.history.empty')}</p>
          )}
          {loading && !sessions.length && (
            <p className="text-center text-sm text-zinc-400 py-6">{t('debug.history.loading')}</p>
          )}

          {sessions.length > 0 && (
            <ul className="space-y-1">
              {sessions.map(item => (
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
                        <p
                          className="text-[11px] text-zinc-400 mt-0.5 truncate"
                          title={item.sessionWorkingDir || undefined}
                        >
                          {formatSessionTime(item.savedAt)}
                          {item.turnCount > 1
                            ? t('debug.history.turns', { n: item.turnCount })
                            : (item.status ? ` · ${item.status}` : '')}
                          {workingDirBasename(item.sessionWorkingDir)
                            ? t('debug.history.dir', { dir: workingDirBasename(item.sessionWorkingDir) })
                            : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        title={t('debug.history.delete')}
                        onClick={e => handleDelete(e, item)}
                        className="shrink-0 text-zinc-400 hover:text-red-500 text-xs px-1"
                      >
                        {t('debug.history.delete')}
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
