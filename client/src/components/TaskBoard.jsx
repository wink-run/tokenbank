// 游乐场任务板：主任务派出的子任务（含其他设备上的），看状态、回答提问、改派、叫停、取回改动（E4-7）
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from '../store/lang';
import { DeviceChip } from './DeviceChips';

const RUNNING = new Set(['pending', 'running']);

function api() { return typeof window !== 'undefined' ? window.electronAPI?.agent : null; }

function StatusBadge({ status, t }) {
  const map = {
    pending: ['bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300', t('board.status.pending')],
    running: ['bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300', t('board.status.running')],
    requires_input: ['bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300', t('board.status.waiting')],
    completed: ['bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300', t('board.status.done')],
    failed: ['bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300', t('board.status.failed')],
    cancelled: ['bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400', t('board.status.cancelled')],
  };
  const [cls, label] = map[status] || map.pending;
  return <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

function Card({ c, parentTaskId, agents, nameOf, onChanged, t }) {
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const running = RUNNING.has(c.status);
  const waiting = c.status === 'requires_input';
  const run = async (fn) => {
    setBusy(true); setNote('');
    try { const r = await fn(); if (r && r.success === false) setNote(r.error || t('board.failed')); }
    catch (e) { setNote(e.message || String(e)); }
    setBusy(false);
    onChanged();
  };
  const device = c.device ? { label: c.device, online: true, self: false, device_id: c.device } : null;
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs space-y-1.5 ${waiting ? 'border-amber-300 bg-amber-50/60 dark:border-amber-700/60 dark:bg-amber-900/10' : 'border-zinc-200 dark:border-zinc-700/70 bg-white/60 dark:bg-zinc-900/40'}`}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate">{nameOf(c.agentId)}</span>
        {device && <DeviceChip device={device} small />}
        <StatusBadge status={c.status} t={t} />
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {running && (
            <button type="button" disabled={busy} onClick={() => run(() => api()?.cancel(c.id))}
              className="text-[11px] text-zinc-500 hover:text-red-500">{t('board.stop')}</button>
          )}
          {!running && (
            <label className="relative inline-flex items-center text-[11px] text-blue-600 dark:text-blue-400 cursor-pointer" title={t('board.reassignHint')}>
              {t('board.reassign')} ▾
              <select value="" disabled={busy} aria-label={t('board.reassign')}
                onChange={(e) => {
                  const to = e.target.value;
                  if (!to) return;
                  run(() => api()?.execute({ agentId: to, prompt: c.prompt, options: { parentTaskId, mode: 'worker' } }));
                }}
                className="absolute inset-0 opacity-0 cursor-pointer">
                <option value="" />
                {agents.filter((a) => a.id !== c.agentId).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}{a.mesh?.device ? ` @ ${a.mesh.device.label}` : ''}</option>
                ))}
              </select>
            </label>
          )}
          {c.git?.changed && !running && (
            <button type="button" disabled={busy} title={t('board.collectHint')}
              onClick={() => run(async () => {
                const r = await api()?.collect(c.id);
                if (r?.success) setNote(r.imported ? t('board.collected', { branch: r.branch }) : r.reason);
                return r?.success ? null : r;
              })}
              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline">{t('board.collect')}</button>
          )}
        </span>
      </div>
      <p className="m-0 text-zinc-500 dark:text-zinc-400 line-clamp-2" title={c.prompt}>{c.prompt}</p>
      {(c.git?.changed || c.artifacts > 0) && (
        <p className="m-0 text-[11px] text-zinc-500 dark:text-zinc-400">
          {c.git?.changed ? t('board.changes', { n: c.git.files, add: c.git.insertions, del: c.git.deletions }) : ''}
          {c.git?.changed && c.artifacts > 0 ? ' · ' : ''}
          {c.artifacts > 0 ? t('board.files', { n: c.artifacts }) : ''}
        </p>
      )}
      {!running && !waiting && c.summary && (
        <p className="m-0 text-[11px] text-zinc-600 dark:text-zinc-300 line-clamp-3 whitespace-pre-wrap">{c.summary}</p>
      )}
      {waiting && (
        <form className="space-y-1.5" onSubmit={(e) => {
          e.preventDefault();
          const text = reply.trim();
          if (!text) return;
          run(() => api()?.execute({ agentId: c.agentId, prompt: text, options: { previousTaskId: c.id, parentTaskId, mode: 'worker', continueSession: true } }))
            .then(() => setReply(''));
        }}>
          <p className="m-0 text-[12px] text-amber-900 dark:text-amber-200 whitespace-pre-wrap">{c.question}</p>
          <div className="flex gap-1.5">
            <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t('board.replyPh')}
              className="tb-soft-field flex-1 min-w-0 text-xs px-2.5 py-1.5 rounded-lg" />
            <button type="submit" disabled={busy || !reply.trim()}
              className="shrink-0 px-2.5 rounded-lg text-xs font-medium bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-60">{t('board.reply')}</button>
          </div>
        </form>
      )}
      {note && <p className="m-0 text-[11px] text-zinc-500 dark:text-zinc-400">{note}</p>}
    </div>
  );
}

/**
 * @param {{ parentTaskId: string, agents: object[] }} props
 */
export default function TaskBoard({ parentTaskId, agents = [] }) {
  const { t } = useLang();
  const [children, setChildren] = useState([]);
  const [open, setOpen] = useState(true);
  const timer = useRef(null);

  const load = useCallback(async () => {
    if (!parentTaskId || !api()?.children) return;
    try {
      const r = await api().children(parentTaskId);
      if (r?.success) setChildren(r.children || []);
    } catch { /* 下一轮再试 */ }
  }, [parentTaskId]);

  useEffect(() => {
    setChildren([]);
    load();
  }, [load]);

  // 有子任务在跑或在等回答时 2 秒刷一次，否则 10 秒
  const active = children.some((c) => RUNNING.has(c.status) || c.status === 'requires_input');
  useEffect(() => {
    clearInterval(timer.current);
    timer.current = setInterval(load, active ? 2000 : 10000);
    return () => clearInterval(timer.current);
  }, [load, active]);

  if (!parentTaskId || children.length === 0) return null;
  const nameOf = (id) => {
    const a = agents.find((x) => x.id === id);
    if (a) return a.name;
    const m = String(id || '').match(/^mine:([^@]+)/);
    const base = m ? m[1] : id;
    return agents.find((x) => x.id === base)?.name || base;
  };
  const waitingN = children.filter((c) => c.status === 'requires_input').length;
  const runningN = children.filter((c) => RUNNING.has(c.status)).length;
  return (
    <div className="mx-4 mb-2 rounded-xl border border-zinc-200 dark:border-zinc-700/70 bg-zinc-50/80 dark:bg-zinc-900/60">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">{t('board.title', { n: children.length })}</span>
        {runningN > 0 && <span className="text-[11px] text-blue-600 dark:text-blue-400">{t('board.runningN', { n: runningN })}</span>}
        {waitingN > 0 && <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">{t('board.waitingN', { n: waitingN })}</span>}
        <span className="ml-auto text-xs text-zinc-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 grid gap-2 sm:grid-cols-2 max-h-[40vh] overflow-y-auto">
          {children.map((c) => (
            <Card key={c.id} c={c} parentTaskId={parentTaskId} agents={agents} nameOf={nameOf} onChanged={load} t={t} />
          ))}
        </div>
      )}
    </div>
  );
}
