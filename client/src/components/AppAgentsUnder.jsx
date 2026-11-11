// 网关页应用行下面：投射在这个应用上的智能体。默认收起成一句话；展开后每个智能体一行。
// 应用本身就是通用智能体；投射了技能、提示词的智能体跑在它上面，所以挂在它下面看。
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';

const SHOW_FIRST = 5;
const OPEN_KEY = 'tb.gw.agentsOpen';

function readOpen() {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) || '[]')); } catch { return new Set(); }
}
function writeOpen(set) {
  try { localStorage.setItem(OPEN_KEY, JSON.stringify([...set])); } catch { /* 存不了就只在本次生效 */ }
}

/**
 * @param {{ appKey: string, agents: Array<{ id, name, resourceId?, skillCount?, builtin?: boolean }>,
 *           stats: Record<string, { tasks, ok }>, rentIds: Set<string> }} props
 */
export default function AppAgentsUnder({ appKey, agents, stats = {}, rentIds = new Set() }) {
  const { t } = useLang();
  const navigate = useNavigate();
  const [open, setOpen] = useState(() => readOpen().has(appKey));
  const [all, setAll] = useState(false);
  if (!agents?.length) return null;

  const statOf = (a) => stats[a.id] || { tasks: 0, ok: 0 };
  const blockedN = agents.filter(a => a.blocked).length;
  const renting = (a) => !!a.resourceId && rentIds.has(a.resourceId);
  // 跑不起来的在前，其次按今天的任务数
  const sorted = [...agents].sort((a, b) => (!!b.blocked - !!a.blocked) || statOf(b).tasks - statOf(a).tasks || String(a.name).localeCompare(String(b.name)));
  const rentN = sorted.filter(renting).length;
  const taskN = sorted.reduce((s, a) => s + statOf(a).tasks, 0);
  const shown = all ? sorted : sorted.slice(0, SHOW_FIRST);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    const set = readOpen();
    if (next) set.add(appKey); else set.delete(appKey);
    writeOpen(set);
  };

  return (
    <div className="ml-[1.4rem] mr-2.5 mb-2 pl-4 border-l-2 border-zinc-200 dark:border-zinc-700">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-h-[36px] text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className={open ? 'font-medium text-zinc-700 dark:text-zinc-200' : ''}>
          {t('gateway.apps.agents.summary', { n: sorted.length })}
          {!open && rentN > 0 ? t('gateway.apps.agents.summaryRent', { n: rentN }) : ''}
          {!open && taskN > 0 ? t('gateway.apps.agents.summaryTasks', { n: taskN }) : ''}
        </span>
        {!open && blockedN > 0 && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {t('gateway.apps.agents.blockedCount', { n: blockedN })}
          </span>
        )}
        <button type="button" onClick={toggle} aria-expanded={open}
          className="ml-auto px-2 py-1 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20">
          {open ? t('gateway.apps.agents.collapse') : t('gateway.apps.agents.expand')}
        </button>
      </div>
      {open && (
        <ul className="list-none m-0 p-0">
          {shown.map(a => {
            const st = statOf(a);
            if (a.blocked) {
              const why = a.blocked.reason === 'runtime'
                ? t('gateway.apps.agents.blockedRuntime', { apps: a.blocked.missing.join('、') })
                : t('gateway.apps.agents.blockedSkills', { skills: a.blocked.missing.join('、') });
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 py-1.5 border-t border-zinc-100 dark:border-zinc-800 text-[11px]">
                  <span className="flex-[2_1_10rem] min-w-0 truncate font-medium text-zinc-800 dark:text-zinc-100" title={a.name}>{a.name}</span>
                  <span className="flex-[6_1_18rem] min-w-0 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">{t('gateway.apps.agents.blocked')}</span>
                    <span className="text-zinc-600 dark:text-zinc-300">{why}</span>
                  </span>
                  <button type="button"
                    onClick={() => navigate('/resources', { state: { resourceType: a.blocked.reason === 'skills' ? 'skill' : 'assistant', selectKey: a.blocked.reason === 'skills' ? undefined : `r-${a.resourceId}` } })}
                    className="shrink-0 px-1.5 py-1 rounded-md font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                    {t('gateway.apps.agents.fix')}
                  </button>
                </li>
              );
            }
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 py-1.5 border-t border-zinc-100 dark:border-zinc-800 text-[11px]">
                <span className="flex-[2_1_10rem] min-w-0 truncate font-medium text-zinc-800 dark:text-zinc-100" title={a.name}>{a.name}</span>
                <span className="flex-[1_1_6rem] min-w-0 text-zinc-500 dark:text-zinc-400">
                  {a.builtin ? t('gateway.apps.agents.builtin') : t('gateway.apps.agents.skills', { n: a.skillCount || 0 })}
                </span>
                <span className="flex-[2_1_9rem] min-w-0 text-zinc-600 dark:text-zinc-300 tabular-nums">
                  {st.tasks > 0 ? t('gateway.apps.agents.tasks', { n: st.tasks, ok: st.ok }) : t('gateway.apps.agents.noTasks')}
                </span>
                <span className="flex-[1_1_6rem] min-w-0">
                  {a.builtin ? null : renting(a) ? (
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">{t('gateway.apps.agents.renting')}</span>
                  ) : (
                    <button type="button" onClick={() => navigate('/contribute', { state: { tradeTab: 'supply', offerAssistant: a.resourceId } })}
                      className="px-1.5 py-1 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                      {t('gateway.apps.agents.rent')}
                    </button>
                  )}
                </span>
                <button type="button"
                  onClick={() => (a.builtin ? navigate('/guardian') : navigate('/debug', { state: { agentId: a.id } }))}
                  className="shrink-0 px-1.5 py-1 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                  {a.builtin ? t('gateway.apps.agents.chat') : t('gateway.apps.agents.try')}
                </button>
              </li>
            );
          })}
          {!all && sorted.length > SHOW_FIRST && (
            <li className="border-t border-zinc-100 dark:border-zinc-800">
              <button type="button" onClick={() => setAll(true)}
                className="px-1.5 py-1.5 text-[11px] text-blue-600 dark:text-blue-400 hover:underline">
                {t('gateway.apps.agents.showAll', { n: sorted.length - SHOW_FIRST })}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
