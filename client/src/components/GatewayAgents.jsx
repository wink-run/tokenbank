// 网关页「智能体」「路由」两个标签里新加的部分：专业智能体、外部智能体、智能体路由，以及智能体接口的钥匙。
// 宽屏一行一条（像表格），窄屏每条一张卡片，按钮至少 44px 高。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { getConfig, getLocalConfig } from '../api/adapter';
import { resolveBrandIcon } from '../lib/brandIcons';
import { buildInvokeText, copyText } from '../lib/resource-enable';
import { useMeshDevices, devicesHaving, remoteOnly } from '../api/meshDevices';
import DeviceChips from './DeviceChips';

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
// 专业 / 外部同一套列：智能体 | 状态 | 今天 | 各自一列 | 操作。切换时表头不跳动
const AGENT_GRID = 'md:grid-cols-[minmax(9rem,1.4fr)_6rem_11rem_minmax(8rem,1fr)_11rem]';
// 我有多台设备时，「状态」后面多一列「所在设备」
const AGENT_GRID_DEV = 'md:grid-cols-[minmax(9rem,1.4fr)_6rem_minmax(6.5rem,1fr)_11rem_minmax(8rem,1fr)_11rem]';

/** 本机的「所在设备」标签（外部智能体接在本机网关上） */
function useDeviceColumn() {
  const mesh = useMeshDevices();
  const showDev = mesh.enabled && mesh.devices.length > 1;
  return { mesh, showDev, GRID: showDev ? AGENT_GRID_DEV : AGENT_GRID };
}
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

const AVATAR_TONES = ['bg-violet-500', 'bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-indigo-500', 'bg-teal-500'];
/** 名字前的首字头像：和通用智能体每行的应用图标同一位置、同一大小 */
function Avatar({ name }) {
  const s = String(name || '?').trim() || '?';
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return (
    <span className={`w-[18px] h-[18px] shrink-0 rounded-full ${AVATAR_TONES[h % AVATAR_TONES.length]} text-white text-[10px] font-semibold leading-none flex items-center justify-center`} aria-hidden>
      {[...s][0].toUpperCase()}
    </span>
  );
}

/** 状态：圆点 + 中粗字，和通用智能体的「已纳管」一样 */
const STATUS_TONE = {
  ok: ['bg-emerald-500', 'text-emerald-700 dark:text-emerald-400'],
  bad: ['bg-red-500', 'text-red-700 dark:text-red-300'],
  warn: ['bg-amber-500', 'text-amber-800 dark:text-amber-300'],
  off: ['bg-zinc-300 dark:bg-zinc-600', 'text-zinc-500 dark:text-zinc-400'],
};
function Status({ tone = 'off', children }) {
  const [dot, text] = STATUS_TONE[tone] || STATUS_TONE.off;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} aria-hidden />
      <span className={`text-xs font-medium truncate ${text}`}>{children}</span>
    </span>
  );
}

/** 名字列：头像 + 名字 + 一行小字 */
function NameCell({ name, meta, children }) {
  return (
    <span className="min-w-0 flex items-start gap-2.5">
      <span className="mt-px"><Avatar name={name} /></span>
      <span className="min-w-0 flex-1">
        <span className={`block ${NAME}`} title={name}>{name}</span>
        {meta ? <span className={`block ${META}`}>{meta}</span> : null}
        {children}
      </span>
    </span>
  );
}

const BTN_SIDE = 'flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-colors bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700';

function Code({ children }) {
  return <code className="inline-block max-w-full overflow-x-auto whitespace-nowrap align-middle font-mono text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{children}</code>;
}

function CopyText({ text, t, small = false }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className={small ? 'text-xs px-2 py-0.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-500 transition-colors' : BTN} onClick={() => {
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
export function AgentApiKey({ inline = false, bare = false } = {}) {
  const { t } = useLang();
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  useEffect(() => {
    Promise.resolve(getLocalConfig().get()).then(c => setKey(String(c?.agent_api_key || ''))).catch(() => {});
  }, []);
  if (!key) return null;
  return (
    <div className={`${inline ? '' : 'mt-1.5 '}flex items-center gap-2 min-w-0 text-xs text-zinc-500 dark:text-zinc-400`}>
      {!bare && <span className="shrink-0">{t('gw2.agentKey')}</span>}
      <Code>{show ? key : `${key.slice(0, 12)}••••••••`}</Code>
      <button type="button" className="shrink-0 min-h-[32px] px-1.5 text-blue-600 dark:text-blue-400 hover:underline" onClick={() => setShow(v => !v)}>
        {show ? t('gw2.hide') : t('gw2.show')}
      </button>
      <CopyText text={key} t={t} small={bare} />
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
function AgentApiInline({ harnessId, note, t }) {
  const gw = gatewayBase();
  const [key, setKey] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    Promise.resolve(agentApi().keyGet?.(harnessId)).then(r => { if (r?.success) setKey(r.key); else setErr(r?.error || ''); }).catch(() => {});
  }, [harnessId]);
  const regen = async () => {
    if (!window.confirm(t('gw2.api.regenConfirm'))) return;
    const r = await agentApi().keyRegenerate?.(harnessId);
    if (r?.success) setKey(r.key); else setErr(r?.error || '');
  };
  // 与通用智能体同一套：同步等到跑完；异步马上返回 id，再用 GET 查
  const syncPayload = JSON.stringify({ input: '看一下当前仓库', metadata: { harness_id: harnessId } });
  const asyncPayload = JSON.stringify({ input: '看一下当前仓库', background: true, metadata: { harness_id: harnessId } });
  const quote = (body) => `'${body.replace(/'/g, `'\\''`)}'`;
  const syncCurl = `curl ${gw}/v1/agent/responses \\\n  -H "Authorization: Bearer ${key || '…'}" \\\n  -H "content-type: application/json" \\\n  -d ${quote(syncPayload)}`;
  const asyncCurl = `curl ${gw}/v1/agent/responses \\\n  -H "Authorization: Bearer ${key || '…'}" \\\n  -H "content-type: application/json" \\\n  -d ${quote(asyncPayload)}`;
  const getCurl = `curl ${gw}/v1/agent/responses/TASK_ID \\\n  -H "Authorization: Bearer ${key || '…'}"`;
  const chip = 'min-w-0 truncate font-mono text-[11px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300';
  const example = (title, badge, path, text) => (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{title}</div>
        <span className={`text-[10px] leading-none px-1.5 py-0.5 rounded-full border ${badge === 'async'
          ? 'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-800/60'
          : 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800/60'}`}>
          {badge === 'async' ? t('gateway.app.async') : t('gateway.app.sync')}
        </span>
      </div>
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
        <div className="flex items-center bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-700 px-3 py-2">
          <span className="text-xs font-medium text-zinc-500">{path}</span>
          <div className="flex-1" />
          {key && <CopyText text={text} t={t} />}
        </div>
        <pre className="m-0 px-4 py-3 text-xs font-mono leading-relaxed text-zinc-700 dark:text-zinc-300 bg-zinc-50/30 dark:bg-zinc-900/30 whitespace-pre-wrap break-words">{text}</pre>
      </div>
    </div>
  );
  return (
    <div className="tb-table-row px-3 md:px-2.5 py-3 bg-zinc-50/60 dark:bg-white/[0.02] space-y-2 text-xs text-zinc-600 dark:text-zinc-300">
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-zinc-500 w-16 shrink-0">API Key</span>
          <code title={key} className={`flex-1 ${chip}`}>{key || '…'}</code>
          {key && <CopyText text={key} t={t} small />}
          <button type="button" className="text-xs px-2 py-0.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-amber-400 hover:text-amber-600 shrink-0" onClick={regen}>{t('gw2.api.regen')}</button>
        </div>
        <div className="flex items-center gap-2 shrink-0 max-w-[46%]">
          <span className="text-zinc-500 shrink-0">harness_id</span>
          <code title={harnessId} className={`max-w-[14rem] ${chip}`}>{harnessId}</code>
          <CopyText text={harnessId} t={t} small />
        </div>
      </div>
      <p className="m-0 text-zinc-400 dark:text-zinc-500">{t('gw2.api.keyOnly')}{note ? ` ${note}` : ''}</p>
      {err && <p className="m-0 text-red-600 dark:text-red-400">{err}</p>}
      {example(t('gateway.app.callAgent'), 'sync', 'POST /v1/agent/responses', syncCurl)}
      {example(t('gateway.app.callAgent'), 'async', 'POST /v1/agent/responses', asyncCurl)}
      {example(t('gateway.app.callAgentGet'), 'async', 'GET /v1/agent/responses/{id}', getCurl)}
      <p className="m-0 text-zinc-500 dark:text-zinc-400">{t('gw2.api.hint')}</p>
    </div>
  );
}

const TASK_PILL = {
  completed: 'bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400',
  running: 'bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400',
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-900/25 dark:text-amber-300',
  failed: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
  cancelled: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
};

/** 「今天」那一列：有任务才能点，点开弹窗（同通用智能体点用量） */
function TodayCell({ st, onOpen, t }) {
  const text = st.tasks ? t('gw2.tasks', { n: st.tasks, ok: st.ok || 0 }) : t('gw2.noTasks');
  const cls = 'text-xs tabular-nums whitespace-nowrap';
  if (!st.tasks) return <span className={`${cls} text-zinc-600 dark:text-zinc-300`}>{text}</span>;
  return (
    <button type="button" title={t('gw2.tasksOpen')}
      className={`${cls} text-left text-zinc-600 dark:text-zinc-300 rounded px-1 -mx-1 hover:bg-zinc-500/[0.06] dark:hover:bg-white/[0.06] cursor-pointer`}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}>
      {text}
    </button>
  );
}

/** 和用量明细一样的小节标题 */
function TaskSection({ n, title, hint, children }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="w-4 h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-bold text-zinc-500 dark:text-zinc-400 flex items-center justify-center shrink-0">{n}</span>
        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">{title}</h4>
        {hint ? <span className="text-xs text-zinc-400 font-normal">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** 今天的任务弹窗：先概览和列表，点明细再看输入输出 */
function TodayTaskList({ agentId, name, onClose, t }) {
  const [tasks, setTasks] = useState(null);
  const [err, setErr] = useState('');
  const [openId, setOpenId] = useState('');
  const [days, setDays] = useState(1);
  useEffect(() => {
    let live = true;
    setOpenId('');
    setTasks(null);
    setErr('');
    Promise.resolve(agentApi().listTodayTasks?.({ agentId, days }))
      .then((r) => {
        if (!live) return;
        if (r?.success) setTasks(r.tasks || []);
        else setErr(r?.error || t('gw2.task.failedLoad'));
      })
      .catch(() => { if (live) setErr(t('gw2.task.failedLoad')); });
    return () => { live = false; };
  }, [agentId, days, t]);
  const when = (ms) => {
    if (!ms) return '—';
    try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return '—'; }
  };
  // 执行时间：完成减开始；还在跑就用到现在为止
  const durationOf = (task) => {
    const start = task.started_at || task.created_at;
    const end = task.completed_at || ((task.status === 'running' || task.status === 'pending') ? Date.now() : null);
    if (!start || !end || end < start) return '—';
    const ms = end - start;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m}m${String(s).padStart(2, '0')}s`;
  };
  const statusText = (status) => {
    const key = `gw2.task.${status}`;
    const text = t(key);
    return text === key ? (status || '—') : text;
  };
  const list = tasks || [];
  const ok = list.filter((task) => task.status === 'completed').length;
  const running = list.filter((task) => task.status === 'running' || task.status === 'pending').length;
  const failed = list.filter((task) => task.status === 'failed' || task.status === 'cancelled').length;
  const GRID = 'grid grid-cols-[minmax(0,1fr)_4.5rem_3.5rem_3.5rem_4rem_3.5rem] gap-2';
  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl mx-4 max-h-[92vh] overflow-y-auto flex flex-col"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 bg-white dark:bg-zinc-800 z-10">
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1 min-w-0 truncate">{t('gw2.task.title', { name: name || agentId })}</h3>
          <select value={days} onChange={(e) => setDays(+e.target.value)}
            className="text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 outline-none text-zinc-600 dark:text-zinc-300">
            <option value={1}>{t('gateway.detail.days1')}</option>
            <option value={7}>{t('gateway.detail.days7')}</option>
            <option value={30}>{t('gateway.detail.days30')}</option>
            <option value={90}>{t('gateway.detail.days90')}</option>
          </select>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg">✕</button>
        </div>
        {err ? (
          <div className="py-16 text-center text-xs text-red-600 dark:text-red-400">{err}</div>
        ) : tasks == null ? (
          <div className="py-16 flex flex-col items-center gap-2 text-xs text-zinc-400">
            <div className="w-5 h-5 border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin" />{t('gw2.task.loading')}
          </div>
        ) : tasks.length === 0 ? (
          <div className="py-16 text-center text-xs text-zinc-400">{t('gw2.task.empty')}</div>
        ) : (
          <div className="p-5 space-y-6">
            <TaskSection n="1" title={t('gw2.task.overview')}>
              <div className="grid grid-cols-4 gap-2">
                {[
                  [t('gw2.task.total'), list.length],
                  [t('gw2.task.completed'), ok],
                  [t('gw2.task.running'), running],
                  [t('gw2.task.failed'), failed],
                ].map(([label, value]) => (
                  <div key={label} className="bg-zinc-50 dark:bg-zinc-800/50 rounded-xl p-3">
                    <div className="text-xs text-zinc-400 dark:text-zinc-500">{label}</div>
                    <div className="text-lg font-bold text-zinc-800 dark:text-zinc-100 mt-0.5">{value}</div>
                  </div>
                ))}
              </div>
            </TaskSection>
            <TaskSection n="2" title={t('gw2.task.list')} hint={t('gw2.task.detailHint')}>
              <div className="tb-table-shell rounded-lg overflow-x-auto">
                <div className={`tb-table-head ${GRID} px-3 py-1.5`}>
                  <span>{t('gw2.task.colContent')}</span>
                  <span>{t('gw2.col.state')}</span>
                  <span>{t('gw2.task.start')}</span>
                  <span>{t('gw2.task.end')}</span>
                  <span>{t('gw2.task.duration')}</span>
                  <span className="text-right">{t('gw2.task.detail')}</span>
                </div>
                <div className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-80 overflow-y-auto">
                  {list.map((task) => {
                    const open = openId === task.id;
                    const result = task.output || task.error || t('gw2.task.noResultYet');
                    return (
                      <div key={task.id || task.created_at}>
                        <div className={`${GRID} px-3 py-2 text-xs items-center ${open ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300 truncate min-w-0" title={task.prompt}>{task.prompt || '—'}</span>
                          <span className={`px-1 rounded w-fit ${TASK_PILL[task.status] || TASK_PILL.cancelled}`}>{statusText(task.status)}</span>
                          <span className="text-zinc-400 tabular-nums">{when(task.started_at || task.created_at)}</span>
                          <span className="text-zinc-400 tabular-nums">{when(task.completed_at)}</span>
                          <span className="text-zinc-600 dark:text-zinc-300 tabular-nums">{durationOf(task)}</span>
                          <span className="text-right">
                            <button type="button" onClick={() => setOpenId(open ? '' : task.id)}
                              className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400">
                              {t('gw2.task.detail')}
                            </button>
                          </span>
                        </div>
                        {open && (
                          <div className="bg-zinc-50 dark:bg-zinc-800/30 px-4 py-3 space-y-3 text-xs">
                            <div>
                              <div className="text-zinc-400 mb-1">{t('gw2.task.input')}</div>
                              <div className="whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-200">{task.prompt || '—'}</div>
                            </div>
                            <div>
                              <div className="text-zinc-400 mb-1">{t('gw2.task.output')}</div>
                              <div className="whitespace-pre-wrap break-words max-h-48 overflow-y-auto text-zinc-700 dark:text-zinc-200">{result}</div>
                            </div>
                            <div className="text-zinc-400 break-all">
                              {t('gw2.task.start')} {when(task.started_at || task.created_at)}
                              <span className="mx-1.5">·</span>
                              {t('gw2.task.end')} {when(task.completed_at)}
                              <span className="mx-1.5">·</span>
                              {t('gw2.task.duration')} {durationOf(task)}
                              {task.id ? <><span className="mx-1.5">·</span><span className="font-mono">{t('gw2.task.id')} {task.id}</span></> : null}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </TaskSection>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 专业智能体：资产里配好、投射到某个应用上跑的；按它跑在哪个应用上分组 */
export function ProfessionalAgents() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const location = useLocation();
  const [reload, setReload] = useState(0);
  const { agents, blocked, stats, rentIds } = useAgentData(reload);
  const onGateway = location.pathname === '/gateway';
  const wasOnGateway = useRef(onGateway);
  // 去资产里改完技能清单再回来：重拉「跑不起来」，不用重启
  useEffect(() => {
    const cameBack = onGateway && !wasOnGateway.current;
    wasOnGateway.current = onGateway;
    if (cameBack) setReload((v) => v + 1);
  }, [onGateway]);
  const [apiFor, setApiFor] = useState('');   // 哪一行展开了「接口示例」
  const [tasksFor, setTasksFor] = useState(null);   // 弹窗里看哪个智能体今天的任务
  const [runtimeErr, setRuntimeErr] = useState('');
  // 试一下：游乐场，或复制口令贴到投射的应用
  const [tryMenu, setTryMenu] = useState(null);
  const [tryNote, setTryNote] = useState('');
  useEffect(() => {
    if (!tryMenu) return undefined;
    const close = (e) => {
      if (e.target?.closest?.('[data-try-menu]')) return;
      setTryMenu(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setTryMenu(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [tryMenu]);
  const openTryMenu = (e, a) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ids = (a.projectedRuntimes && a.projectedRuntimes.length)
      ? a.projectedRuntimes
      : (a.runtimeAgentId ? [a.runtimeAgentId] : []);
    setTryMenu((prev) => (prev?.id === a.id ? null : {
      id: a.id,
      name: a.name,
      apps: ids.map((id) => ({ id, name: appName(id) })),
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    }));
  };
  const pasteOnApp = async (menu, app) => {
    const text = buildInvokeText(
      { type: 'assistant', name: menu.name, display_name: menu.name },
      lang === 'en' ? 'en' : 'zh',
    );
    setTryMenu(null);
    const ok = await copyText(text);
    setTryNote(ok
      ? t('gw2.pro.tryCopied', { app: app || t('gw2.pro.tryApp') })
      : t('gw2.pro.tryCopyFailed'));
  };
  useEffect(() => {
    if (!tryNote) return undefined;
    const id = setTimeout(() => setTryNote(''), 2800);
    return () => clearTimeout(id);
  }, [tryNote]);
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
  const { mesh, showDev, GRID } = useDeviceColumn();
  // 只在我的其他设备上的专业智能体：那边新建的，这里只能派活
  const remoteAssistants = showDev ? remoteOnly(mesh.devices, 'assistants', rows.map(a => a.id)) : [];
  return (
    <section className="px-2.5 py-3 min-w-0">
      <Toolbar main={<button type="button" className={BTN_MAIN} onClick={() => navigate('/resources', { state: { resourceType: 'assistant' } })}>{t('gw2.pro.newPlus')}</button>}
        hint={t('gw2.pro.hint')}
        right={<button type="button" className={BTN_SIDE} onClick={() => navigate('/resources', { state: { resourceType: 'assistant' } })}>{t('gw2.pro.templates')}</button>} />
      {rows.length === 0 && remoteAssistants.length === 0 ? (
        <div className="py-6 text-center text-xs text-zinc-400">{t('gw2.pro.empty')}</div>
      ) : (
        <div className="space-y-3">
          {runtimeErr && <p className="m-0 px-1 text-xs text-red-600 dark:text-red-400">{runtimeErr}</p>}
          <div className={SHELL}>
          <div className={`${HEAD} ${GRID}`}>
            <span>{t('gw2.col.agent')}</span><span>{t('gw2.col.state')}</span>{showDev && <span>{t('mesh.colDevice')}</span>}<span>{t('gw2.col.today')}</span><span>{t('gw2.col.rent')}</span><span className="text-right">{t('gw2.col.actions')}</span>
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
                    <div
                      className={`${ROW} ${GRID} ${b ? 'bg-red-50/50 dark:bg-red-950/10' : 'cursor-pointer'}`}
                      onClick={b ? undefined : () => setApiFor(apiFor === a.id ? '' : a.id)}
                    >
                      {/* 投射到多个应用时，名称下面只留「默认在哪跑」 */}
                      <NameCell name={a.name} meta={(a.projectedRuntimes || []).length > 1 ? (
                        <span className="flex flex-nowrap items-center gap-1 min-w-0">
                          <label className="flex flex-nowrap items-center gap-0.5 min-w-0" title={t('gw2.pro.defaultHint')} onClick={e => e.stopPropagation()}>
                            <span className="shrink-0 whitespace-nowrap">{t('gw2.pro.defaultOn')}</span>
                            {/* 去掉原生外观：选中的应用名后面直接跟一个小箭头 */}
                            <span className="relative inline-flex items-center min-w-0 text-blue-600 dark:text-blue-400">
                              <span className="truncate text-[11px] font-medium">{appName(a.runtimeAgentId)}</span>
                              <span aria-hidden className="ml-0.5 text-[9px]">▾</span>
                              <select value={a.runtimeAgentId} onChange={e => setDefaultApp(a, e.target.value)}
                                aria-label={t('gw2.pro.defaultOn')}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer appearance-none">
                                {a.projectedRuntimes.map(id => <option key={id} value={id}>{appName(id)}</option>)}
                              </select>
                            </span>
                          </label>
                        </span>
                      ) : null} />
                      <span className="min-w-0">
                        {b ? (
                          <>
                            <Status tone="bad">{t('gw2.pro.cantRun')}</Status>
                            <span className={`block pl-3.5 ${META}`}>{b.reason === 'skills' ? t('gw2.pro.missing', { s: b.missing.join('、') }) : t('gw2.pro.noApp')}</span>
                          </>
                        ) : <Status tone="ok">{t('gw2.pro.ok')}</Status>}
                      </span>
                      {showDev && <span className="min-w-0"><DeviceChips devices={devicesHaving(mesh.devices, 'assistants', a.id)} /></span>}
                      <span className="min-w-0" onClick={e => e.stopPropagation()}>
                        <TodayCell st={st} onOpen={() => setTasksFor({ id: a.id, name: a.name })} t={t} />
                      </span>
                      <span className={`text-xs ${renting ? 'text-emerald-700 dark:text-emerald-400 font-medium' : 'text-zinc-500 dark:text-zinc-400'}`}>
                        {renting ? t('gw2.pro.renting') : t('gw2.pro.selfOnly')}
                      </span>
                      <span className="flex gap-2 md:justify-end [&>*]:flex-1 md:[&>*]:flex-none" onClick={e => e.stopPropagation()}>
                        {b ? (
                          <button type="button" className={BTN_PRIMARY}
                            // 缺技能也进这条智能体模板去改，不跳到技能列表
                            onClick={() => navigate('/resources', { state: { resourceType: 'assistant', selectKey: a.resourceId ? `r-${a.resourceId}` : undefined } })}>
                            {t('gw2.pro.fix')}
                          </button>
                        ) : (
                          <>
                            <button type="button" data-try-menu className={BTN} aria-expanded={tryMenu?.id === a.id} onClick={(e) => openTryMenu(e, a)}>{t('gw2.pro.try')}</button>
                            <button type="button" className={BTN} onClick={() => navigate('/resources', { state: { resourceType: 'assistant', selectKey: a.resourceId ? `r-${a.resourceId}` : undefined } })}>{t('gw2.pro.edit')}</button>
                          </>
                        )}
                      </span>
                    </div>
                    {apiFor === a.id && !b && <AgentApiInline harnessId={a.id} note={t('gw2.proApi.runsOn', { name: a.name, app: appName(a.runtimeAgentId) })} t={t} />}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
          {remoteAssistants.length > 0 && (
            <>
              <div className="tb-table-row flex flex-wrap items-center gap-x-2 gap-y-1 px-3 md:px-2.5 py-2.5 bg-zinc-50/60 dark:bg-white/[0.02]">
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-100">{t('mesh.otherDevices')}</span>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('gw2.pro.groupN', { n: remoteAssistants.length })}</span>
                <span className="basis-full md:basis-auto md:ml-auto text-[11px] text-zinc-500 dark:text-zinc-400">{t('mesh.otherDevicesHint')}</span>
              </div>
              {remoteAssistants.map(ra => {
                const anyOnline = ra.devices.some(d => d.online);
                const target = ra.devices.length === 1 ? `mine:${ra.id}@${ra.devices[0].label}` : `mine:${ra.id}`;
                return (
                  <div key={'mesh-' + ra.id} className={`${ROW} ${GRID}`}>
                    <NameCell name={ra.name} />
                    <span className="min-w-0">{anyOnline ? <Status tone="ok">{t('mesh.statusRemote')}</Status> : <Status tone="off">{t('mesh.statusOffline')}</Status>}</span>
                    <span className="min-w-0"><DeviceChips devices={ra.devices} /></span>
                    <span className={META}>—</span>
                    <span className={META}>{t('mesh.routeOnDevice')}</span>
                    <span className="flex gap-2 md:justify-end [&>*]:flex-1 md:[&>*]:flex-none">
                      <button type="button" className={BTN} disabled={!anyOnline} onClick={() => navigate('/debug', { state: { agentId: target } })}>{t('gw2.pro.tryPlay')}</button>
                    </span>
                  </div>
                );
              })}
            </>
          )}
          </div>
        </div>
      )}
      {tryMenu && (
        <div
          data-try-menu
          className="fixed z-50 min-w-[11rem] max-w-[16rem] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg py-1 text-xs"
          style={{ top: tryMenu.top, right: tryMenu.right }}
        >
          <button type="button" className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            onClick={() => { setTryMenu(null); navigate('/debug', { state: { agentId: tryMenu.id } }); }}>
            {t('gw2.pro.tryPlay')}
          </button>
          <button type="button" className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            onClick={() => { setApiFor(tryMenu.id); setTryMenu(null); }}>
            {t('gw2.pro.tryApi')}
          </button>
          {(tryMenu.apps && tryMenu.apps.length ? tryMenu.apps : [{ id: '', name: '' }]).map((app) => (
            <button key={app.id || 'app'} type="button" className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 truncate"
              onClick={() => pasteOnApp(tryMenu, app.name)}>
              {t('gw2.pro.tryPaste', { app: app.name || t('gw2.pro.tryApp') })}
            </button>
          ))}
        </div>
      )}
      {tasksFor && <TodayTaskList agentId={tasksFor.id} name={tasksFor.name} onClose={() => setTasksFor(null)} t={t} />}
      {tryNote && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-[min(24rem,calc(100vw-2rem))] px-3 py-2 rounded-lg bg-zinc-900 text-white text-xs shadow-lg text-center">
          {tryNote}
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
  const location = useLocation();
  const setTab = onTab;
  const [counts, setCounts] = useState({ pro: 0, broken: 0, ext: 0, pending: 0 });
  const onGateway = location.pathname === '/gateway';
  useEffect(() => {
    if (!onGateway) return undefined;
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
    return undefined;
  }, [tab, onGateway]);
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

/** 外部智能体的 Webhook 唤醒：有新任务时网关主动通知它来取，不用等下一次轮询 */
function WebhookInline({ agent, t, onSaved }) {
  const wh = agent.webhook || null;
  const [url, setUrl] = useState(wh?.url || '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);   // { ok, text }
  const call = async (action, extra) => {
    setBusy(action); setMsg(null);
    try {
      const r = await agentApi().externalSet?.(agent.id, action, extra);
      if (!r?.success) throw new Error(r?.error || 'failed');
      return r;
    } catch (e) { setMsg({ ok: false, text: e.message || String(e) }); return null; } finally { setBusy(''); }
  };
  const save = async () => {
    const r = await call('webhook', { url: url.trim(), secret });
    if (r) { setSecret(''); setMsg({ ok: true, text: t('gw2.ext.whSaved') }); onSaved?.(); }
  };
  const clear = async () => {
    const r = await call('webhook', { clear: true });
    if (r) { setUrl(''); setSecret(''); setMsg({ ok: true, text: t('gw2.ext.whCleared') }); onSaved?.(); }
  };
  const test = async () => {
    const r = await call('webhookTest');
    if (r) { setMsg(r.result?.ok ? { ok: true, text: t('gw2.ext.whTestOk', { status: r.result.status || 200 }) } : { ok: false, text: r.result?.message || 'failed' }); onSaved?.(); }
  };
  const id = `wh-${agent.id.replace(/[^a-z0-9-]/gi, '')}`;
  return (
    <div className="px-3 py-2.5 border-t border-zinc-100 dark:border-white/[0.06] text-xs space-y-2" onClick={e => e.stopPropagation()}>
      <p className="m-0 font-semibold text-zinc-700 dark:text-zinc-200">{t('gw2.ext.whTitle')}</p>
      <p className="m-0 text-zinc-500 dark:text-zinc-400">{t('gw2.ext.whHint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-url`} className="shrink-0 w-14 text-zinc-500 dark:text-zinc-400">{t('gw2.ext.whUrl')}</label>
        <input id={`${id}-url`} value={url} onChange={e => setUrl(e.target.value)} placeholder="https://…"
          className="tb-soft-field flex-1 min-w-[14rem] text-xs px-3 py-1.5 rounded-lg font-mono" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-secret`} className="shrink-0 w-14 text-zinc-500 dark:text-zinc-400">{t('gw2.ext.whSecret')}</label>
        <input id={`${id}-secret`} type="password" autoComplete="off" value={secret} onChange={e => setSecret(e.target.value)}
          placeholder={wh?.hasSecret ? t('gw2.ext.whSecretKeep', { tail: wh.secretTail }) : t('gw2.ext.whSecretPh')}
          className="tb-soft-field flex-1 min-w-[14rem] text-xs px-3 py-1.5 rounded-lg font-mono" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={!!busy || !url.trim()} onClick={save}>{t('common.save')}</button>
        {wh && <button type="button" className={BTN} disabled={!!busy} onClick={test}>{busy === 'webhookTest' ? t('gw2.ext.whTesting') : t('gw2.ext.whTest')}</button>}
        {wh && <button type="button" className={BTN} disabled={!!busy} onClick={clear}>{t('gw2.ext.whClear')}</button>}
        {msg && <span className={msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>{msg.text}</span>}
      </div>
      {wh && (
        <p className="m-0 text-zinc-500 dark:text-zinc-400">
          {wh.lastError ? <span className="text-red-600 dark:text-red-400">{t('gw2.ext.whLastError', { msg: wh.lastError.message, when: agoText(t, wh.lastError.at) })}</span>
            : wh.lastOkAt ? t('gw2.ext.whLastOk', { n: wh.sent, when: agoText(t, wh.lastOkAt) }) : t('gw2.ext.whNever')}
        </p>
      )}
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
  const navigate = useNavigate();
  const [list, setList] = useState([]);
  const [pairing, setPairing] = useState(null);
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState({});
  const [busy, setBusy] = useState('');
  const [apiFor, setApiFor] = useState('');
  const [tasksFor, setTasksFor] = useState(null);
  const [tryMenu, setTryMenu] = useState(null);
  const [intervalMin, setIntervalMin] = useState(3);   // 拉取频率，默认 3 分钟
  useEffect(() => {
    if (!tryMenu) return undefined;
    const close = (e) => {
      if (e.target?.closest?.('[data-try-menu]')) return;
      setTryMenu(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setTryMenu(null); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [tryMenu]);
  const openTryMenu = (e, a) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTryMenu((prev) => (prev?.id === a.id ? null : {
      id: a.id,
      top: rect.bottom + 4,
      right: Math.max(8, window.innerWidth - rect.right),
    }));
  };
  const load = useCallback(() => {
    Promise.resolve(agentApi().externalList?.()).then(r => {
      if (r?.success) {
        setList(r.agents || []);
        setPairing(r.pairing || null);
        if (r.pullIntervalSec) setIntervalMin(Math.max(1, Math.round(r.pullIntervalSec / 60)));
      }
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
  const saveInterval = async (raw) => {
    const min = Math.max(1, Math.min(360, Math.round(Number(raw) || 3)));
    setIntervalMin(min);
    const r = await agentApi().externalSet?.('', 'interval', { seconds: min * 60 });
    if (r?.pullIntervalSec) setIntervalMin(Math.max(1, Math.round(r.pullIntervalSec / 60)));
  };
  const pendingN = list.filter(a => a.status === 'pending').length;
  const rows = [...list].sort((a, b) => (b.status === 'pending') - (a.status === 'pending'));
  const gateway = (() => { try { return `${window.location.protocol}//${window.location.hostname}:11430`; } catch { return 'http://127.0.0.1:11430'; } })();
  const skillUrl = `${gateway}/v1/agent/external/skill`;
  const { mesh, showDev, GRID } = useDeviceColumn();
  const remoteExternals = showDev ? remoteOnly(mesh.devices, 'externals', list.map(a => a.id)) : [];
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
            <label className="flex flex-wrap items-center gap-2 text-zinc-600 dark:text-zinc-300">
              <span>{t('gw2.ext.interval')}</span>
              <input
                type="number"
                min="1"
                max="360"
                value={intervalMin}
                onChange={(e) => setIntervalMin(e.target.value)}
                onBlur={(e) => saveInterval(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                className="w-16 text-right font-mono text-sm px-2 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100"
              />
              <span>{t('gw2.ext.intervalUnit')}</span>
              <span className="text-zinc-400">{t('gw2.ext.intervalHint')}</span>
            </label>
            {[
              ['gw2.ext.apiPull', `GET ${gateway}/v1/agent/external/tasks?wait=25&interval=${Math.max(1, Math.round(Number(intervalMin) || 3)) * 60}`],
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

      {rows.length === 0 && remoteExternals.length === 0 ? (
        <div className="py-6 text-center text-xs text-zinc-400">{t('gw2.ext.empty')}</div>
      ) : (
        <div className={SHELL} style={{ overflowX: 'auto' }}>
          <div className={`${HEAD} ${GRID}`}>
            <span>{t('gw2.col.agent')}</span><span>{t('gw2.col.state')}</span>{showDev && <span>{t('mesh.colDevice')}</span>}<span>{t('gw2.col.today')}</span>
            <span>{t('gw2.col.can')}</span><span className="text-right">{t('gw2.col.actions')}</span>
          </div>
          {rows.map(a => {
            const st = stats[a.id] || {};
            const pending = a.status === 'pending';
            return (
              <React.Fragment key={a.id}>
              <div
                className={`${ROW} ${GRID} ${pending ? 'bg-amber-50/50 dark:bg-amber-950/10' : ''} ${a.status === 'active' ? 'cursor-pointer' : ''}`}
                onClick={a.status === 'active' ? () => setApiFor(apiFor === a.id ? '' : a.id) : undefined}
              >
                <NameCell name={a.name} meta={pending ? t('gw2.ext.applied', { code: a.pairingCode || '' }) : t('gw2.ext.since', { when: new Date(a.createdAt).toLocaleDateString() })} />
                <span className="min-w-0 text-xs">
                  {pending ? <Status tone="warn">{t('gw2.ext.pending')}</Status>
                    : a.status === 'disabled' ? <Status tone="off">{t('gw2.ext.disabled')}</Status>
                    : a.online ? <Status tone="ok">{t('gw2.ext.online')}</Status>
                    : <Status tone="off">{t('gw2.ext.offline')}</Status>}
                  {!pending && <span className={`block pl-3.5 ${META}`}>{t('gw2.ext.lastPull', { when: agoText(t, a.lastSeenAt) })}</span>}
                  {!pending && (a.pushOk > 0 || a.lastPushError) && (
                    <span className={`block pl-3.5 ${META}`}>{a.pushOk > 0 ? t('gw2.ext.pushes', { n: a.pushOk, when: agoText(t, a.lastPushAt) }) : ''}</span>
                  )}
                  {a.lastPushError && (
                    <span className="block text-red-600 dark:text-red-400" title={a.lastPushError.taskId}>{t('gw2.ext.pushRejected', { msg: a.lastPushError.message, when: agoText(t, a.lastPushError.at) })}</span>
                  )}
                  {a.skillOutdated && <span className="block text-amber-700 dark:text-amber-400" title={t('gw2.ext.skillOldHint')}>{t('gw2.ext.skillOld')}</span>}
                  {a.webhook && (
                    <span className={`block pl-3.5 ${a.webhook.lastError ? 'text-red-600 dark:text-red-400' : META}`} title={a.webhook.url}>
                      {a.webhook.healthy ? t('gw2.ext.whBadge.on', { min: Math.round((a.webhook.fallbackPullSec || 900) / 60) }) : t('gw2.ext.whBadge.err')}
                    </span>
                  )}
                </span>
                {showDev && <span className="min-w-0"><DeviceChips devices={devicesHaving(mesh.devices, 'externals', a.id)} /></span>}
                <span className="min-w-0" onClick={e => e.stopPropagation()}>
                  <TodayCell st={st} onOpen={() => setTasksFor({ id: a.id, name: a.name })} t={t} />
                </span>
                <span className="text-xs text-zinc-600 dark:text-zinc-300 min-w-0">{a.description ? t('gw2.ext.says', { d: a.description }) : '—'}</span>
                <span className="flex gap-2 md:justify-end [&>*]:flex-1 md:[&>*]:flex-none" onClick={e => e.stopPropagation()}>
                  {pending ? (
                    <>
                      <button type="button" className={BTN_PRIMARY} disabled={!!busy} onClick={() => act(a.id, 'approve')}>{t('gw2.ext.allow')}</button>
                      <button type="button" className={BTN} disabled={!!busy} onClick={() => act(a.id, 'remove')}>{t('gw2.ext.deny')}</button>
                    </>
                  ) : (
                    <>
                      {a.status === 'active' && (
                        <button type="button" data-try-menu className={BTN} aria-expanded={tryMenu?.id === a.id} onClick={(e) => openTryMenu(e, a)}>{t('gw2.pro.try')}</button>
                      )}
                      {a.status === 'disabled'
                        ? <button type="button" className={BTN} disabled={!!busy} onClick={() => act(a.id, 'enable')}>{t('gw2.ext.enable')}</button>
                        : <button type="button" className={BTN} disabled={!!busy} onClick={() => act(a.id, 'disable')}>{t('gw2.ext.disable')}</button>}
                      <button type="button" className={BTN_DANGER} disabled={!!busy} onClick={() => act(a.id, 'remove')}>{t('gw2.ext.remove')}</button>
                    </>
                  )}
                </span>
              </div>
              {apiFor === a.id && <AgentApiInline harnessId={a.id} note={t('gw2.api.extNote', { name: a.name })} t={t} />}
              {apiFor === a.id && <WebhookInline agent={a} t={t} onSaved={load} />}
              </React.Fragment>
            );
          })}
          {/* 接在我其他设备上的外部智能体：在那台设备上管理，这里能直接派活 */}
          {remoteExternals.map(ra => {
            const anyOnline = ra.devices.some(d => d.online);
            const target = ra.devices.length === 1 ? `mine:${ra.id}@${ra.devices[0].label}` : `mine:${ra.id}`;
            return (
              <div key={'mesh-' + ra.id} className={`${ROW} ${GRID}`}>
                <NameCell name={ra.name} meta={t('mesh.otherDevices')} />
                <span className="min-w-0">{anyOnline ? <Status tone="ok">{t('mesh.statusRemote')}</Status> : <Status tone="off">{t('mesh.statusOffline')}</Status>}</span>
                <span className="min-w-0"><DeviceChips devices={ra.devices} /></span>
                <span className={META}>—</span>
                <span className={META}>{t('mesh.routeOnDevice')}</span>
                <span className="flex gap-2 md:justify-end [&>*]:flex-1 md:[&>*]:flex-none">
                  <button type="button" className={BTN} disabled={!anyOnline} onClick={() => navigate('/debug', { state: { agentId: target } })}>{t('gw2.pro.tryPlay')}</button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      {tryMenu && (
        <div
          data-try-menu
          className="fixed z-50 min-w-[11rem] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg py-1 text-xs"
          style={{ top: tryMenu.top, right: tryMenu.right }}
        >
          <button type="button" className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            onClick={() => { setTryMenu(null); navigate('/debug', { state: { agentId: tryMenu.id } }); }}>
            {t('gw2.pro.tryPlay')}
          </button>
          <button type="button" className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700"
            onClick={() => { setApiFor(tryMenu.id); setTryMenu(null); }}>
            {t('gw2.pro.tryApi')}
          </button>
        </div>
      )}
      {tasksFor && <TodayTaskList agentId={tasksFor.id} name={tasksFor.name} onClose={() => setTasksFor(null)} t={t} />}
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
  const [apiFor, setApiFor] = useState('');
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
  return (
    <section className="px-2.5 py-3 min-w-0 space-y-3">
      <Toolbar main={<button type="button" className={BTN_MAIN} onClick={() => setEditing(editing === 'new' ? null : 'new')}>{t('gw2.route.newPlus')}</button>}
        hint={t('gw2.route.hint')} />
      {err && <p className="px-1 text-xs text-red-600 dark:text-red-400">{err}</p>}
      {editing === 'new' && (
        <RouteEditor route={{ id: '', name: '', rules: [], candidates: null, allowHired: false, whenNone: 'self', mainAgentId: '' }}
          agents={agents} t={t} onSave={save} onCancel={() => setEditing(null)} />
      )}
      {/* 和模型路由同一种卡片：箭头 · 图标 · 状态点 · 名字 · 路由 id + 复制 ……… 右侧操作；点整行展开编辑 */}
      <div className="space-y-2">
        {routes.map(r => {
          const open = editing === r.id;
          const inPlay = r.id === playRoute;
          return (
            <div key={r.id}>
              <div className="tb-soft-tile flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer"
                onClick={() => setEditing(open ? null : r.id)} title={t('gw2.route.edit')}>
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                  className={`w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
                  <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
                {/* 分派图标：一分为三 */}
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
                  className="w-5 h-5 shrink-0 text-violet-500" aria-hidden>
                  <circle cx="5" cy="12" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="12" r="2" /><circle cx="19" cy="19" r="2" />
                  <path d="M7 12h10M7 11l10-5M7 13l10 5" />
                </svg>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${inPlay ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`}
                      title={inPlay ? t('gw2.route.playUses') : ''} />
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{r.name}</span>
                    {inPlay && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/40 text-emerald-600 dark:text-emerald-400 shrink-0">
                        {t('gw2.route.playUses')}
                      </span>
                    )}
                    <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-zinc-100/70 dark:bg-zinc-800/60 text-zinc-400 dark:text-zinc-500 shrink-0">{r.id}</span>
                    <span onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(r.id); }}
                      className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer transition-colors shrink-0">{t('gateway.common.copy')}</span>
                    {r.rules.length > 0 && (
                      <span className="text-xs px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 text-indigo-600 dark:text-indigo-400 shrink-0">
                        {t('gateway.route.rulesCount', { n: r.rules.length })}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 truncate" title={describe(r)}>{describe(r)}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                  <button type="button" className={`${BTN} hidden sm:inline-flex`} onClick={() => navigate('/debug', { state: { hubRoute: r.id } })}>{t('gw2.route.try')}</button>
                  <button type="button" className={`${BTN} ${apiFor === r.id ? '!border-blue-400 !text-blue-500' : ''}`} aria-expanded={apiFor === r.id}
                    onClick={() => setApiFor(apiFor === r.id ? '' : r.id)}>{apiFor === r.id ? t('gw2.pro.apiClose') : t('gw2.pro.api')}</button>
                  {!r.builtin && (
                    <button type="button" onClick={() => remove(r)}
                      className="text-xs px-2 py-1 rounded-lg border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                      {t('gateway.common.delete')}
                    </button>
                  )}
                </div>
              </div>
              {apiFor === r.id && <div className="mt-2"><AgentApiInline harnessId={r.id} note={t('gw2.api.routeNote', { name: r.name })} t={t} /></div>}
              {open && <div className="mt-2"><RouteEditor route={r} agents={agents} t={t} onSave={save} onCancel={() => setEditing(null)} /></div>}
            </div>
          );
        })}
        {routes.length === 0 && <div className="px-5 py-8 text-xs text-zinc-400 text-center">{t('gateway.route.empty')}</div>}
      </div>
    </section>
  );
}
