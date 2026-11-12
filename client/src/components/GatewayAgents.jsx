// 网关页「智能体」「路由」两个标签里新加的部分：专业智能体、外部智能体、智能体路由，以及智能体接口的钥匙。
// 宽屏一行一条（像表格），窄屏每条一张卡片，按钮至少 44px 高。
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { getConfig, getLocalConfig } from '../api/adapter';
import { resolveBrandIcon } from '../lib/brandIcons';

const agentApi = () => window.electronAPI?.agent || {};

// 样式和「通用智能体」的应用表一致：表格卡片 tb-table-shell、表头 tb-table-head、行 tb-table-row、小边框按钮
const BTN = 'max-md:min-h-[40px] text-[11px] px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-500 transition-colors disabled:opacity-40';
const BTN_PRIMARY = 'max-md:min-h-[40px] text-[11px] px-2 py-1 rounded-lg border border-blue-500 bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:border-[#3f6699] text-white font-medium transition-colors disabled:opacity-40';
const BTN_DANGER = 'max-md:min-h-[40px] text-[11px] px-2 py-1 rounded-lg border border-red-200 dark:border-red-900/60 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors';
// 工具栏主按钮：同「新建应用」
const BTN_MAIN = 'max-md:min-h-[40px] text-xs px-3 py-1.5 rounded-xl bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 text-white transition-colors font-medium shadow-sm shadow-blue-500/20';
const SHELL = 'tb-table-shell rounded-xl overflow-hidden';
// 一行：窄屏上下排，宽屏按列排
const ROW = 'tb-table-row flex flex-col gap-1.5 px-3 py-3 md:grid md:items-center md:gap-x-2 md:px-2.5';
const HEAD = 'tb-table-head hidden md:grid md:items-center md:gap-x-2 px-2.5 py-2.5';
const NAME = 'text-xs font-medium tracking-tight text-zinc-800 dark:text-zinc-100 truncate';
const META = 'tb-table-cell-meta';

/** 工具栏：主按钮 + 一句说明，同「通用智能体」的「新建应用」那一行 */
function Toolbar({ main, hint, right }) {
  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap">
      {main}
      {hint ? <span className="text-xs text-zinc-400 dark:text-zinc-500">{hint}</span> : null}
      {right ? <span className="ml-auto">{right}</span> : null}
    </div>
  );
}

function Code({ children }) {
  return <code className="inline-block max-w-full overflow-x-auto whitespace-nowrap align-middle font-mono text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{children}</code>;
}

function CopyText({ text, t }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={BTN} onClick={() => {
      navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); }).catch(() => {});
    }}>{done ? t('gw2.copied') : t('gw2.copy')}</button>
  );
}

function GroupHead({ title, hint, badge, badgeTone = 'red', right }) {
  const tone = badgeTone === 'amber'
    ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
    : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pt-2">
      <h3 className="m-0 text-sm font-semibold text-zinc-800 dark:text-zinc-100">{title}</h3>
      {badge ? <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${tone}`}>{badge}</span> : null}
      {hint ? <span className="text-xs text-zinc-500 dark:text-zinc-400 basis-full md:basis-auto">{hint}</span> : null}
      {right ? <span className="md:ml-auto flex gap-2 w-full md:w-auto [&>*]:flex-1 md:[&>*]:flex-none">{right}</span> : null}
    </div>
  );
}

/** 智能体接口的本机钥匙：外部系统调用 /v1/agent 时用 */
export function AgentApiKey() {
  const { t } = useLang();
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  useEffect(() => {
    Promise.resolve(getLocalConfig().get()).then(c => setKey(String(c?.agent_api_key || ''))).catch(() => {});
  }, []);
  if (!key) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2 min-w-0 text-xs text-zinc-500 dark:text-zinc-400">
      <span className="shrink-0">{t('gw2.agentKey')}</span>
      <Code>{show ? key : `${key.slice(0, 12)}••••••••`}</Code>
      <button type="button" className="shrink-0 min-h-[32px] px-1.5 text-blue-600 dark:text-blue-400 hover:underline" onClick={() => setShow(v => !v)}>
        {show ? t('gw2.hide') : t('gw2.show')}
      </button>
      <CopyText text={key} t={t} />
    </div>
  );
}

function useAgentData(refreshKey) {
  const [agents, setAgents] = useState([]);
  const [blocked, setBlocked] = useState({});
  const [stats, setStats] = useState({});
  const [rentIds, setRentIds] = useState(new Set());
  useEffect(() => {
    const api = agentApi();
    Promise.resolve(api.listAgents?.()).then(r => { if (r?.success) setAgents(r.agents || []); }).catch(() => {});
    Promise.resolve(api.listBlocked?.()).then(r => {
      if (r?.success) setBlocked(Object.fromEntries((r.agents || []).map(a => [a.id, a])));
    }).catch(() => {});
    Promise.resolve(api.taskStats?.()).then(r => { if (r?.success) setStats(r.stats?.by_agent || {}); }).catch(() => {});
    Promise.resolve(getConfig().read()).then(cfg => {
      setRentIds(new Set((cfg?.contribute_assistants || []).map(x => (typeof x === 'string' ? x : x?.id)).filter(Boolean)));
    }).catch(() => {});
  }, [refreshKey]);
  return { agents, blocked, stats, rentIds };
}

function gatewayBase() {
  try { return `${window.location.protocol}//${window.location.hostname}:11430`; } catch { return 'http://127.0.0.1:11430'; }
}

/** 某个专业智能体怎么从接口调用：在它那一行下面展开 */
function ProApiInline({ agent, appName, t }) {
  const gw = gatewayBase();
  const curl = `curl ${gw}/v1/agent/responses \\
  -H "Authorization: Bearer [智能体接口 Key]" \\
  -H "Content-Type: application/json" \\
  -d '{"input": "你的任务", "metadata": {"harness_id": "${agent.id}"}}'`;
  return (
    <div className="tb-table-row px-3 md:px-2.5 py-3 bg-zinc-50/60 dark:bg-white/[0.02] space-y-2 text-xs text-zinc-600 dark:text-zinc-300">
      <div className="flex flex-wrap items-center gap-2 min-w-0">
        <span className="text-zinc-500">harness_id</span><Code>{agent.id}</Code><CopyText text={agent.id} t={t} />
        <span className="text-zinc-500 dark:text-zinc-400">{t('gw2.proApi.runsOn', { name: agent.name, app: appName(agent.runtimeAgentId) })}</span>
      </div>
      <div className="relative">
        <pre className="m-0 p-3 pr-16 rounded-xl bg-zinc-900 text-zinc-100 text-[11px] leading-relaxed overflow-x-auto">{curl}</pre>
        <span className="absolute top-2 right-2"><CopyText text={curl} t={t} /></span>
      </div>
      <p className="m-0 text-zinc-500 dark:text-zinc-400">{t('gw2.proApi.inlineHint', { url: `${gw}/v1/agent/harnesses` })}</p>
    </div>
  );
}

/** 专业智能体：资产里配好、投射到某个应用上跑的；按它跑在哪个应用上分组 */
export function ProfessionalAgents() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [reload, setReload] = useState(0);
  const { agents, blocked, stats, rentIds } = useAgentData(reload);
  const [apiFor, setApiFor] = useState('');   // 哪一行展开了「接口示例」
  const [runtimeErr, setRuntimeErr] = useState('');
  const setDefaultApp = async (a, runtimeAgentId) => {
    setRuntimeErr('');
    const r = await agentApi().setAssistantRuntime?.(a.resourceId, runtimeAgentId);
    if (!r?.success) setRuntimeErr(r?.error || t('gw2.pro.runtimeFailed'));
    setReload(v => v + 1);
  };
  const rows = useMemo(() => {
    const list = agents.filter(a => a.type === 'assistant' && !a.guardian && a.id !== 'assistant:tb-guardian');
    const seen = new Set(list.map(a => a.id));
    // 跑不起来的不在可用列表里，单独补上
    for (const b of Object.values(blocked)) if (!seen.has(b.id)) list.push({ id: b.id, name: b.name, resourceId: b.resourceId, runtimeAgentId: b.runtimeAgentId, type: 'assistant' });
    return list.sort((a, b) => (!!blocked[b.id] - !!blocked[a.id]) || String(a.name).localeCompare(String(b.name)));
  }, [agents, blocked]);
  const appOf = (id) => agents.find(a => a.id === id);
  const appName = (id) => appOf(id)?.name || id || '—';
  const groups = useMemo(() => {
    const m = new Map();
    for (const r of rows) {
      const k = r.runtimeAgentId || '';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    // 有跑不起来的组排前面，其余按数量
    return [...m.entries()].sort((a, b) => (b[1].some(r => blocked[r.id]) - a[1].some(r => blocked[r.id])) || b[1].length - a[1].length);
  }, [rows, blocked]);
  const brokenN = rows.filter(a => blocked[a.id]).length;
  const GRID = 'md:grid-cols-[minmax(0,1.6fr)_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.8fr)_15rem]';
  return (
    <section className="px-2.5 py-3 min-w-0">
      <Toolbar main={<button type="button" className={BTN_MAIN} onClick={() => navigate('/resources', { state: { resourceType: 'assistant' } })}>{t('gw2.pro.newPlus')}</button>}
        hint={t('gw2.pro.hint')} />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-xs text-zinc-400">{t('gw2.pro.empty')}</div>
      ) : (
        <div className="space-y-3">
          {runtimeErr && <p className="m-0 px-1 text-xs text-red-600 dark:text-red-400">{runtimeErr}</p>}
          <div className={SHELL}>
          <div className={`${HEAD} ${GRID}`}>
            <span>{t('gw2.col.agent')}</span><span>{t('gw2.col.state')}</span><span>{t('gw2.col.today')}</span><span>{t('gw2.col.rent')}</span><span className="text-right">{t('gw2.col.actions')}</span>
          </div>
          {groups.map(([appId, list]) => {
            const app = appOf(appId);
            const appOk = !!app && app.installed !== false;
            const icon = resolveBrandIcon(`${appId} ${app?.name || ''}`);
            return (
              <React.Fragment key={appId || 'none'}>
                {/* 组头行：它们跑在哪个应用上（同应用表里多账号的父行） */}
                <div className="tb-table-row flex flex-wrap items-center gap-x-2 gap-y-1 px-3 md:px-2.5 py-2.5 bg-zinc-50/60 dark:bg-white/[0.02]">
                  {icon ? <img src={icon} alt="" className="w-4 h-4 shrink-0" /> : <span className="w-4 h-4 shrink-0 rounded bg-zinc-200 dark:bg-zinc-700" />}
                  <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{t('gw2.pro.onApp', { app: appName(appId) })}</span>
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('gw2.pro.groupN', { n: list.length })}</span>
                  <span className={`text-[11px] ${appOk ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>● {appOk ? t('gw2.pro.appOk') : t('gw2.pro.appMissing')}</span>
                  <span className="basis-full md:basis-auto md:ml-auto text-[11px] text-zinc-500 dark:text-zinc-400">{t('gw2.pro.groupHint', { app: appName(appId) })}</span>
                </div>
                {list.map(a => {
                  const b = blocked[a.id];
                  const st = stats[a.id] || {};
                  const renting = a.resourceId && rentIds.has(a.resourceId);
                  return (
                    <React.Fragment key={a.id}>
                    <div className={`${ROW} ${GRID} ${b ? 'bg-red-50/50 dark:bg-red-950/10' : ''}`}>
                      <span className="min-w-0">
                        <span className={`block ${NAME}`} title={a.name}>{a.name}</span>
                        <span className={`block ${META}`}>{a.skillCount ? t('gw2.pro.skills', { n: a.skillCount }) : t('gw2.pro.noSkills')}</span>
                        {(a.projectedRuntimes || []).length > 1 && (
                          <label className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                            {t('gw2.pro.defaultOn')}
                            <select value={a.runtimeAgentId} onChange={e => setDefaultApp(a, e.target.value)}
                              title={t('gw2.pro.defaultHint')}
                              className="min-h-[44px] md:min-h-[26px] px-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm md:text-[11px] text-zinc-800 dark:text-zinc-100">
                              {a.projectedRuntimes.map(id => <option key={id} value={id}>{appName(id)}</option>)}
                            </select>
                          </label>
                        )}
                      </span>
                      <span className="text-xs min-w-0">
                        {b ? (
                          <>
                            <span className="font-semibold text-red-700 dark:text-red-300">● {t('gw2.pro.cantRun')}</span>
                            <span className="block text-zinc-600 dark:text-zinc-300">{b.reason === 'skills' ? t('gw2.pro.missing', { s: b.missing.join('、') }) : t('gw2.pro.noApp')}</span>
                          </>
                        ) : <span className="text-emerald-700 dark:text-emerald-400">● {t('gw2.pro.ok')}</span>}
                      </span>
                      <span className="text-xs tabular-nums text-zinc-600 dark:text-zinc-300">{st.tasks ? t('gw2.tasks', { n: st.tasks, ok: st.ok || 0 }) : t('gw2.noTasks')}</span>
                      <span className={`text-xs ${renting ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-zinc-500 dark:text-zinc-400'}`}>
                        {renting ? t('gw2.pro.renting') : t('gw2.pro.selfOnly')}
                      </span>
                      <span className="flex gap-2 md:justify-end [&>*]:flex-1 md:[&>*]:flex-none">
                        {b ? (
                          <button type="button" className={BTN_PRIMARY}
                            onClick={() => navigate('/resources', { state: { resourceType: b.reason === 'skills' ? 'skill' : 'assistant', selectKey: b.reason === 'skills' ? undefined : `r-${a.resourceId}` } })}>
                            {t('gw2.pro.fix')}
                          </button>
                        ) : (
                          <>
                            <button type="button" className={BTN} onClick={() => navigate('/debug', { state: { agentId: a.id } })}>{t('gw2.pro.try')}</button>
                            <button type="button" className={`${BTN} ${apiFor === a.id ? '!border-blue-400 !text-blue-500' : ''}`} aria-expanded={apiFor === a.id}
                              onClick={() => setApiFor(apiFor === a.id ? '' : a.id)}>{apiFor === a.id ? t('gw2.pro.apiClose') : t('gw2.pro.api')}</button>
                            <button type="button" className={BTN} onClick={() => navigate('/resources', { state: { resourceType: 'assistant', selectKey: a.resourceId ? `r-${a.resourceId}` : undefined } })}>{t('gw2.pro.edit')}</button>
                          </>
                        )}
                      </span>
                    </div>
                    {apiFor === a.id && !b && <ProApiInline agent={a} appName={appName} t={t} />}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
          </div>
        </div>
      )}
    </section>
  );
}

/** 下划线式标签栏：网关页「智能体」三个分组和「路由」里两个分组共用 */
export function SubTabBar({ items, value, onChange }) {
  return (
    <div role="tablist" className="flex gap-1 px-2.5 pt-2.5 border-b border-zinc-100 dark:border-white/[0.06] overflow-x-auto">
      {items.map(it => (
        <button key={it.id} type="button" role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}
          className={`${it.right ? 'ml-auto ' : ''}shrink-0 inline-flex items-center gap-1.5 min-h-[44px] md:min-h-[36px] px-3 -mb-px border-b-2 text-xs font-medium ${value === it.id
            ? 'border-blue-500 text-zinc-900 dark:text-white'
            : 'border-transparent text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'}`}>
          {it.label}
          {it.badge ? <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${it.tone === 'amber' ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300'}`}>{it.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** 工具栏主按钮样式（同「新建应用」），给网关页其它地方复用 */
export const MAIN_BUTTON_CLASS = BTN_MAIN;

/** 「智能体」标签里的三个分组：一次只看一组，页面不会太长 */
export function AgentsSubTabs({ tab, onTab, renderApps, renderRoutes }) {
  const { t } = useLang();
  const setTab = onTab;
  const [counts, setCounts] = useState({ pro: 0, broken: 0, ext: 0, pending: 0 });
  useEffect(() => {
    const api = agentApi();
    Promise.all([
      Promise.resolve(api.listAgents?.()).catch(() => null),
      Promise.resolve(api.listBlocked?.()).catch(() => null),
      Promise.resolve(api.externalList?.()).catch(() => null),
    ]).then(([l, bl, ex]) => {
      const blockedIds = new Set((bl?.agents || []).map(a => a.id));
      const pros = new Set((l?.agents || []).filter(a => a.type === 'assistant' && !a.guardian && a.id !== 'assistant:tb-guardian').map(a => a.id));
      for (const id of blockedIds) pros.add(id);
      const ext = ex?.agents || [];
      setCounts({ pro: pros.size, broken: blockedIds.size, ext: ext.length, pending: ext.filter(a => a.status === 'pending').length });
    });
  }, [tab]);
  const items = [
    { id: 'apps', label: t('gw2.generic.title'), hint: t('gw2.generic.hint') },
    { id: 'pro', label: t('gw2.sub.pro', { n: counts.pro }), badge: counts.broken ? t('gw2.pro.broken', { n: counts.broken }) : '', tone: 'red' },
    { id: 'ext', label: t('gw2.sub.ext', { n: counts.ext }), badge: counts.pending ? t('gw2.ext.pendingN', { n: counts.pending }) : '', tone: 'amber' },
    // 路由放在最右侧
    { id: 'routes', label: t('gw2.tab.routes'), right: true },
  ];
  return (
    <div>
      <SubTabBar items={items} value={tab} onChange={setTab} />
      {tab === 'apps' && (
        <div>
          {renderApps()}
        </div>
      )}
      {tab === 'pro' && <div className="pt-1"><ProfessionalAgents /></div>}
      {tab === 'ext' && <div className="pt-1"><ExternalAgents /></div>}
      {tab === 'routes' && renderRoutes && renderRoutes()}
    </div>
  );
}

function agoText(t, ts) {
  if (!ts) return t('gw2.ext.never');
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return t('gw2.ext.secAgo', { n: s });
  if (s < 3600) return t('gw2.ext.minAgo', { n: Math.floor(s / 60) });
  return t('gw2.ext.hourAgo', { n: Math.floor(s / 3600) });
}

/** 外部智能体：自己注册进来、来网关取任务 */
export function ExternalAgents() {
  const { t } = useLang();
  const [list, setList] = useState([]);
  const [pairing, setPairing] = useState(null);
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState({});
  const [busy, setBusy] = useState('');
  const load = useCallback(() => {
    Promise.resolve(agentApi().externalList?.()).then(r => {
      if (r?.success) { setList(r.agents || []); setPairing(r.pairing || null); }
    }).catch(() => {});
    Promise.resolve(agentApi().taskStats?.()).then(r => { if (r?.success) setStats(r.stats?.by_agent || {}); }).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 10000);   // 在线状态会变，过一会儿刷新一次
    return () => clearInterval(id);
  }, [load]);
  const act = async (id, action) => {
    if (action === 'remove' && !window.confirm(t('gw2.ext.removeConfirm'))) return;
    setBusy(id + action);
    try { await agentApi().externalSet?.(id, action); } finally { setBusy(''); load(); }
  };
  const newCode = async () => {
    const r = await agentApi().externalPair?.();
    if (r?.success) setPairing(r.pairing);
    setOpen(true);
  };
  const pendingN = list.filter(a => a.status === 'pending').length;
  const rows = [...list].sort((a, b) => (b.status === 'pending') - (a.status === 'pending'));
  const gateway = (() => { try { return `${window.location.protocol}//${window.location.hostname}:11430`; } catch { return 'http://127.0.0.1:11430'; } })();
  const skillUrl = `${gateway}/v1/agent/external/skill`;
  const GRID = 'md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,1.6fr)_10.5rem]';
  return (
    <section className="px-2.5 py-3 min-w-0">
      <Toolbar main={<button type="button" className={BTN_MAIN} aria-expanded={open} onClick={() => (open ? setOpen(false) : newCode())}>{t('gw2.ext.connectPlus')}</button>}
        hint={t('gw2.ext.hint')} />

      {open && (
        <div className="mb-3 rounded-xl border border-sky-200/80 dark:border-sky-900/50 bg-sky-50/70 dark:bg-sky-950/20 px-3 py-2.5 space-y-2 text-xs text-zinc-700 dark:text-zinc-200">
          <ol className="m-0 pl-4 space-y-2 leading-relaxed">
            <li>{t('gw2.ext.step1')} <Code>tokenbank-connect</Code>
              <span className="flex flex-wrap items-center gap-2 mt-1"><Code>{skillUrl}</Code><CopyText text={skillUrl} t={t} /></span>
            </li>
            <li>{t('gw2.ext.step2')}
              <span className="flex flex-wrap items-center gap-2 mt-1">
                <strong className="text-base tracking-wider">{pairing?.code || '—'}</strong>
                {pairing?.code && <CopyText text={pairing.code} t={t} />}
                <button type="button" className={BTN} onClick={newCode}>{t('gw2.ext.newCode')}</button>
                <span className="text-zinc-500">{t('gw2.ext.codeTtl')}</span>
              </span>
            </li>
            <li>{t('gw2.ext.step3')}</li>
          </ol>
          <div className="space-y-1">
            <p className="m-0 font-semibold">{t('gw2.ext.apiTitle')}</p>
            {[
              ['gw2.ext.apiPull', `GET ${gateway}/v1/agent/external/tasks?wait=25&interval=300`],
              ['gw2.ext.apiResult', `POST ${gateway}/v1/agent/external/tasks/{task_id}/result  {"output": "…"}`],
              ['gw2.ext.apiPush', `POST ${gateway}/v1/agent/external/tasks/{task_id}/messages  {"output": "…"}`],
            ].map(([k, line]) => (
              <div key={k} className="flex flex-col md:flex-row md:items-center gap-1 md:gap-2 min-w-0">
                <span className="shrink-0 md:w-28 text-zinc-500 dark:text-zinc-400">{t(k)}</span>
                <Code>{line}</Code>
              </div>
            ))}
            <p className="m-0 text-zinc-500 dark:text-zinc-400">{t('gw2.ext.apiNote')}</p>
          </div>
          <p className="m-0 text-zinc-500 dark:text-zinc-400">{t('gw2.ext.network', { gw: gateway })}</p>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="py-6 text-center text-xs text-zinc-400">{t('gw2.ext.empty')}</div>
      ) : (
        <div className={SHELL}>
          <div className={`${HEAD} ${GRID}`}>
            <span>{t('gw2.col.agent')}</span><span>{t('gw2.col.link')}</span><span>{t('gw2.col.today')}</span>
            <span>harness_id</span><span>{t('gw2.col.can')}</span><span className="text-right">{t('gw2.col.actions')}</span>
          </div>
          {rows.map(a => {
            const st = stats[a.id] || {};
            const pending = a.status === 'pending';
            return (
              <div key={a.id} className={`${ROW} ${GRID} ${pending ? 'bg-amber-50/50 dark:bg-amber-950/10' : ''}`}>
                <span className="min-w-0">
                  <span className={`block ${NAME}`}>{a.name}</span>
                  <span className={`block ${META}`}>{pending ? t('gw2.ext.applied', { code: a.pairingCode || '' }) : t('gw2.ext.since', { when: new Date(a.createdAt).toLocaleDateString() })}</span>
                </span>
                <span className="text-xs">
                  {pending ? <span className="font-semibold text-amber-800 dark:text-amber-300">● {t('gw2.ext.pending')}</span>
                    : a.status === 'disabled' ? <span className="text-zinc-500">● {t('gw2.ext.disabled')}</span>
                    : a.online ? <span className="text-emerald-700 dark:text-emerald-400">● {t('gw2.ext.online')}</span>
                    : <span className="text-zinc-500">● {t('gw2.ext.offline')}</span>}
                  {!pending && <span className="block text-zinc-500 dark:text-zinc-400">{t('gw2.ext.lastPull', { when: agoText(t, a.lastSeenAt) })}</span>}
                  {!pending && (a.pushOk > 0 || a.lastPushError) && (
                    <span className="block text-zinc-500 dark:text-zinc-400">{a.pushOk > 0 ? t('gw2.ext.pushes', { n: a.pushOk, when: agoText(t, a.lastPushAt) }) : ''}</span>
                  )}
                  {a.lastPushError && (
                    <span className="block text-red-600 dark:text-red-400" title={a.lastPushError.taskId}>{t('gw2.ext.pushRejected', { msg: a.lastPushError.message, when: agoText(t, a.lastPushError.at) })}</span>
                  )}
                  {a.skillOutdated && <span className="block text-amber-700 dark:text-amber-400" title={t('gw2.ext.skillOldHint')}>{t('gw2.ext.skillOld')}</span>}
                </span>
                <span className="text-xs tabular-nums text-zinc-600 dark:text-zinc-300">{st.tasks ? t('gw2.tasks', { n: st.tasks, ok: st.ok || 0 }) : t('gw2.noTasks')}</span>
                <span className="flex items-center gap-2 min-w-0"><Code>{a.id}</Code></span>
                <span className="text-xs text-zinc-600 dark:text-zinc-300 min-w-0">{a.description ? t('gw2.ext.says', { d: a.description }) : '—'}</span>
                <span className="flex gap-2 md:justify-end [&>*]:flex-1 md:[&>*]:flex-none">
                  {pending ? (
                    <>
                      <button type="button" className={BTN_PRIMARY} disabled={!!busy} onClick={() => act(a.id, 'approve')}>{t('gw2.ext.allow')}</button>
                      <button type="button" className={BTN} disabled={!!busy} onClick={() => act(a.id, 'remove')}>{t('gw2.ext.deny')}</button>
                    </>
                  ) : (
                    <>
                      {a.status === 'disabled'
                        ? <button type="button" className={BTN} disabled={!!busy} onClick={() => act(a.id, 'enable')}>{t('gw2.ext.enable')}</button>
                        : <button type="button" className={BTN} disabled={!!busy} onClick={() => act(a.id, 'disable')}>{t('gw2.ext.disable')}</button>}
                      <button type="button" className={BTN_DANGER} disabled={!!busy} onClick={() => act(a.id, 'remove')}>{t('gw2.ext.remove')}</button>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const MAIN_CHOICES = ['', 'claude-code', 'codex', 'cursor', 'pi'];

function RouteEditor({ route, agents, onSave, onCancel, t }) {
  const [name, setName] = useState(route.name || '');
  const [mainAgentId, setMain] = useState(route.mainAgentId || '');
  const [rules, setRules] = useState(route.rules?.length ? route.rules : []);
  const [draft, setDraft] = useState('');
  const [all, setAll] = useState(!Array.isArray(route.candidates));
  const [picked, setPicked] = useState(new Set(route.candidates || []));
  const [allowHired, setAllowHired] = useState(!!route.allowHired);
  const [whenNone, setWhenNone] = useState(route.whenNone || 'self');
  const [saving, setSaving] = useState(false);
  const pickable = agents.filter(a => a && !a.guardian && a.id !== 'assistant:tb-guardian' && a.type !== 'community' && !(a.type === 'cli' && a.installed === false));
  const kindOf = (a) => (a.type === 'assistant' ? t('gw2.kind.pro') : a.type === 'external' ? t('gw2.kind.ext') : t('gw2.kind.app'));
  const addRule = () => { const r = draft.trim(); if (r) { setRules([...rules, r]); setDraft(''); } };
  const save = async () => {
    setSaving(true);
    try {
      await onSave({ ...route, name: name.trim() || route.name, mainAgentId, rules, candidates: all ? null : [...picked], allowHired, whenNone });
    } finally { setSaving(false); }
  };
  const label = 'block text-xs font-semibold text-zinc-700 dark:text-zinc-200';
  return (
    <div className="mt-2 md:mt-0 md:mx-3 md:mb-3 p-3 rounded-xl border border-blue-200 dark:border-blue-900/50 bg-white/80 dark:bg-zinc-900/60 space-y-3 text-xs">
      <div className="flex flex-col md:flex-row md:flex-wrap md:items-center gap-3">
        <label className="flex flex-col md:flex-row md:items-center gap-1.5 text-zinc-500">{t('gw2.route.name')}
          <input value={name} onChange={e => setName(e.target.value)} disabled={route.builtin}
            className="min-h-[44px] md:min-h-[32px] md:w-44 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm md:text-xs text-zinc-900 dark:text-zinc-100 disabled:opacity-60" />
        </label>
        {route.id && <span className="flex items-center gap-2 text-zinc-500 min-w-0">harness_id <Code>{route.id}</Code><CopyText text={route.id} t={t} /></span>}
        <label className="flex flex-col md:flex-row md:items-center gap-1.5 text-zinc-500">{t('gw2.route.main')}
          <select value={mainAgentId} onChange={e => setMain(e.target.value)}
            className="min-h-[44px] md:min-h-[32px] px-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm md:text-xs text-zinc-900 dark:text-zinc-100">
            {MAIN_CHOICES.map(id => <option key={id || 'auto'} value={id}>{id ? (agents.find(a => a.id === id)?.name || id) : t('gw2.route.mainAuto')}</option>)}
          </select>
        </label>
      </div>

      <div className="space-y-1.5">
        <span className={label}>{t('gw2.route.rules')} <span className="font-normal text-zinc-500">{t('gw2.route.rulesHint')}</span></span>
        <ol className="m-0 pl-4 space-y-1.5">
          {rules.map((r, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 px-2.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-100">{r}</span>
              <button type="button" aria-label={t('gw2.route.delRule')} className="min-h-[44px] md:min-h-[30px] px-2 text-zinc-500 hover:text-red-600" onClick={() => setRules(rules.filter((_, j) => j !== i))}>{t('gw2.route.del')}</button>
            </li>
          ))}
          <li className="flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
            <span className="flex-1 px-2.5 py-2 rounded-lg border border-dashed border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-800/40">{t('gw2.route.builtinRule')}</span>
            <span className="text-[11px] whitespace-nowrap">{t('gw2.route.builtin')}</span>
          </li>
        </ol>
        <div className="flex flex-col md:flex-row gap-2">
          <input value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addRule(); } }}
            placeholder={t('gw2.route.rulePh')}
            className="flex-1 min-h-[44px] md:min-h-[32px] px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm md:text-xs text-zinc-900 dark:text-zinc-100" />
          <button type="button" className={BTN} onClick={addRule} disabled={!draft.trim()}>{t('gw2.route.addRule')}</button>
        </div>
      </div>

      <div className="space-y-1.5">
        <span className={label}>{t('gw2.route.can')} <span className="font-normal text-zinc-500">{t('gw2.route.canHint')}</span></span>
        <label className="flex items-center gap-2 min-h-[44px] md:min-h-[28px]"><input type="checkbox" className="w-[18px] h-[18px] md:w-4 md:h-4" checked={all} onChange={e => setAll(e.target.checked)} />{t('gw2.route.all')}</label>
        {!all && (
          <div className="flex flex-wrap gap-1.5">
            {pickable.map(a => {
              const on = picked.has(a.id);
              return (
                <label key={a.id} className={`inline-flex items-center gap-1.5 min-h-[44px] md:min-h-[32px] px-2.5 rounded-lg border ${on ? 'border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30' : 'border-zinc-200 dark:border-zinc-700'}`}>
                  <input type="checkbox" className="w-[18px] h-[18px] md:w-4 md:h-4" checked={on} onChange={() => {
                    const n = new Set(picked); if (on) n.delete(a.id); else n.add(a.id); setPicked(n);
                  }} />
                  {a.name}<span className="text-zinc-400">{kindOf(a)}</span>
                </label>
              );
            })}
          </div>
        )}
        <label className="flex items-center gap-2 min-h-[44px] md:min-h-[28px]">
          <input type="checkbox" className="w-[18px] h-[18px] md:w-4 md:h-4" checked={allowHired} onChange={e => setAllowHired(e.target.checked)} />
          {t('gw2.route.hired')} <span className="text-amber-700 dark:text-amber-400">{t('gw2.route.hiredCost')}</span>
        </label>
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-1 md:gap-3 text-zinc-700 dark:text-zinc-200">
        <span className="text-zinc-500">{t('gw2.route.none')}</span>
        <label className="flex items-center gap-2 min-h-[44px] md:min-h-[28px]"><input type="radio" className="w-[18px] h-[18px] md:w-4 md:h-4" checked={whenNone === 'self'} onChange={() => setWhenNone('self')} />{t('gw2.route.noneSelf')}</label>
        <label className="flex items-center gap-2 min-h-[44px] md:min-h-[28px]"><input type="radio" className="w-[18px] h-[18px] md:w-4 md:h-4" checked={whenNone === 'error'} onChange={() => setWhenNone('error')} />{t('gw2.route.noneError')}</label>
      </div>

      <div className="flex flex-col md:flex-row md:items-center gap-2 pt-2 border-t border-zinc-100 dark:border-white/[0.06]">
        <span className="text-zinc-500 dark:text-zinc-400 md:flex-1">{t('gw2.route.seeInPlay')}</span>
        <div className="flex gap-2 [&>*]:flex-1 md:[&>*]:flex-none">
          <button type="button" className={BTN} onClick={onCancel}>{t('gw2.cancel')}</button>
          <button type="button" className={BTN_PRIMARY} onClick={save} disabled={saving}>{saving ? '…' : t('gw2.save')}</button>
        </div>
      </div>
    </div>
  );
}

/** 智能体路由：和游乐场「聚合入口」同一套派发 */
export function AgentRoutesPanel() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [routes, setRoutes] = useState([]);
  const [agents, setAgents] = useState([]);
  const [editing, setEditing] = useState(null);   // 路由 id，或 'new'
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    Promise.resolve(agentApi().routesList?.()).then(r => { if (r?.success) setRoutes(r.routes || []); }).catch(() => {});
    Promise.resolve(agentApi().listAgents?.()).then(r => { if (r?.success) setAgents(r.agents || []); }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  const playRoute = (() => { try { return localStorage.getItem('tb.play.hubRoute') || 'agent-router-default'; } catch { return 'agent-router-default'; } })();
  const nameOf = (id) => agents.find(a => a.id === id)?.name || id;
  const save = async (route) => {
    setErr('');
    const r = await agentApi().routesSave?.(route);
    if (!r?.success) { setErr(r?.error || t('gw2.route.saveFailed')); return; }
    setEditing(null);
    load();
  };
  const remove = async (route) => {
    if (!window.confirm(t('gw2.route.removeConfirm', { name: route.name }))) return;
    const r = await agentApi().routesRemove?.(route.id);
    if (!r?.success) setErr(r?.error || '');
    load();
  };
  const describe = (r) => {
    const main = r.mainAgentId ? nameOf(r.mainAgentId) : t('gw2.route.mainAutoShort');
    const can = Array.isArray(r.candidates) ? (r.candidates.length ? r.candidates.map(nameOf).join('、') : t('gw2.route.nobody')) : t('gw2.route.allShort');
    return t('gw2.route.desc', { main, n: r.rules.length, can }) + (r.allowHired ? t('gw2.route.descHired') : '');
  };
  const GRID = 'md:grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)_minmax(0,0.9fr)_17rem]';
  const gateway = (() => { try { return `${window.location.protocol}//${window.location.hostname}:11430`; } catch { return 'http://127.0.0.1:11430'; } })();
  const curl = `curl ${gateway}/v1/agent/responses \\\n  -H "Authorization: Bearer [智能体接口 Key]" \\\n  -H "Content-Type: application/json" \\\n  -d '{"input": "帮我评审这个 PR", "metadata": {"harness_id": "${routes[1]?.id || 'agent-router-default'}"}}'`;
  return (
    <section className="px-2.5 py-3 min-w-0 space-y-3">
      <Toolbar main={<button type="button" className={BTN_MAIN} onClick={() => setEditing(editing === 'new' ? null : 'new')}>{t('gw2.route.newPlus')}</button>}
        hint={t('gw2.route.hint')} />
      {err && <p className="px-1 text-xs text-red-600 dark:text-red-400">{err}</p>}
      {editing === 'new' && (
        <RouteEditor route={{ id: '', name: '', rules: [], candidates: null, allowHired: false, whenNone: 'self', mainAgentId: '' }}
          agents={agents} t={t} onSave={save} onCancel={() => setEditing(null)} />
      )}
      <div className={SHELL}>
        <div className={`${HEAD} ${GRID}`}>
          <span>{t('gw2.route.name')}</span><span>{t('gw2.route.how')}</span><span>{t('gw2.route.who')}</span><span className="text-right">{t('gw2.col.actions')}</span>
        </div>
        {routes.map(r => (
          <React.Fragment key={r.id}>
            <div className={`${ROW} ${GRID}`}>
              <span className="min-w-0">
                <span className="block text-sm md:text-xs font-medium text-zinc-800 dark:text-zinc-100">{r.name}</span>
                <span className="flex items-center gap-2 mt-0.5"><Code>{r.id}</Code><span className="md:hidden"><CopyText text={r.id} t={t} /></span></span>
              </span>
              <span className="text-xs text-zinc-600 dark:text-zinc-300 min-w-0">{describe(r)}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">{r.id === playRoute ? t('gw2.route.playUses') : <span className="hidden md:inline">—</span>}</span>
              <span className="flex gap-2 md:justify-end [&>*]:flex-1 md:[&>*]:flex-none">
                <button type="button" className={BTN} aria-expanded={editing === r.id} onClick={() => setEditing(editing === r.id ? null : r.id)}>
                  {editing === r.id ? t('gw2.route.close') : t('gw2.route.edit')}
                </button>
                <button type="button" className={BTN} onClick={() => navigate('/debug', { state: { hubRoute: r.id } })}>{t('gw2.route.try')}</button>
                {!r.builtin && <button type="button" className={BTN_DANGER} onClick={() => remove(r)}>{t('gw2.route.remove')}</button>}
              </span>
            </div>
            {editing === r.id && <RouteEditor route={r} agents={agents} t={t} onSave={save} onCancel={() => setEditing(null)} />}
          </React.Fragment>
        ))}
      </div>
      <div className="pt-2 space-y-1.5">
        <p className="m-0 px-1 text-xs text-zinc-500 dark:text-zinc-400">{t('gw2.route.curlHint')}</p>
        <pre className="m-0 p-3 rounded-xl bg-zinc-900 text-zinc-100 text-[11px] leading-relaxed overflow-x-auto">{curl}</pre>
      </div>
    </section>
  );
}
