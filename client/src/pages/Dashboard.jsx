import { useState, useEffect, useCallback } from 'react';
import { isElectron } from '../api/adapter';
import { enrichDashboardBilling, enrichTrendWithSubscriptionCost, enrichAppsUsageBilling, enrichModelCostBilling, resolveBillableSubscriptions } from '../utils/billing-cost';
import { loadUserAccounts } from '../api/userAccounts';
import { useLang } from '../store/lang';
import { useCurrency } from '../store/currency';
import { RANGE_KEYS, RANGE_DAYS } from '../utils/ranges';
import { useAuth } from '../store/index';
import { fetchDashboardStats } from './TokenDashboard';
import { getTransactions } from '../api/client';
import { useNavigate } from 'react-router-dom';
import { formatDeviceTitle } from '../lib/device-display';

const PAID_PROVIDERS = ['openai', 'anthropic-paid', 'openrouter', 'anthropic'];
const P2P_PROVIDERS  = ['tokenbank-p2p'];

const fmtN    = n => n >= 1_000_000 ? (n/1e6).toFixed(2)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);




const APP_USAGE_COLORS = [
  'bg-indigo-500', 'bg-purple-500', 'bg-violet-500', 'bg-pink-500',
  'bg-amber-500', 'bg-emerald-500', 'bg-blue-500', 'bg-teal-500',
];



/** Skill / 工具 / MCP 调用排行 */
function SkillToolUsageSection({ skillUsage, toolUsage, mcpUsage, rangeLabel, loading, t }) {
  const skillItems = skillUsage?.items || [];
  const toolItems = toolUsage?.items || [];
  const mcpServers = mcpUsage?.servers || [];
  const skillTotal = skillUsage?.total || 0;
  const toolTotal = toolUsage?.total || 0;
  const mcpTotal = mcpUsage?.total || 0;
  const maxSkill = Math.max(...skillItems.map(r => r.calls), 1);
  const maxTool = Math.max(...toolItems.map(r => r.calls), 1);
  const maxMcp = Math.max(...mcpServers.map(r => r.calls), 1);

  const kindLabel = (kind) => {
    if (kind === 'mcp') return t('dashboard.toolKind.mcp');
    if (kind === 'dispatch') return t('dashboard.toolKind.dispatch');
    if (kind === 'builtin') return t('dashboard.toolKind.builtin');
    return null;
  };

  const RankList = ({ items, max, emptyKey, accent }) => {
    if (loading) {
      return <div className="py-8 text-center text-xs text-zinc-400">…</div>;
    }
    if (!items.length) {
      return <div className="py-8 text-center text-xs text-zinc-400">{t(emptyKey)}</div>;
    }
    return (
      <div className="space-y-2.5">
        {items.map((row, i) => {
          const pct = Math.round((row.calls / max) * 100);
          const kind = kindLabel(row.kind);
          return (
            <div key={row.key || row.name || i} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-zinc-700 dark:text-zinc-200" title={row.name}>
                  {row.name}
                  {row.mcp_server && (
                    <span className="ml-1.5 font-normal text-zinc-400">· {row.mcp_server}</span>
                  )}
                  {kind && !row.mcp_server && (
                    <span className="ml-1.5 font-normal text-zinc-400">· {kind}</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-zinc-500">{row.calls}</span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden bg-black/[0.06] dark:bg-white/[0.08]">
                <div className={`h-full rounded-full ${accent}`} style={{ width: `${Math.max(pct, 2)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  /** MCP：按 Server 汇总，展开 Top 工具名 */
  const McpServerList = () => {
    if (loading) {
      return <div className="py-8 text-center text-xs text-zinc-400">…</div>;
    }
    if (!mcpServers.length) {
      return <div className="py-8 text-center text-xs text-zinc-400">{t('dashboard.mcpUsageEmpty')}</div>;
    }
    return (
      <div className="space-y-3">
        {mcpServers.map((srv, i) => {
          const pct = Math.round((srv.calls / maxMcp) * 100);
          const topTools = (srv.tools || []).slice(0, 3).map((tool) => tool.name).join(', ');
          return (
            <div key={srv.key || srv.name || i} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-zinc-700 dark:text-zinc-200" title={srv.name}>
                  {srv.name}
                  {topTools && (
                    <span className="ml-1.5 font-normal text-zinc-400 truncate">· {topTools}</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-zinc-500">{srv.calls}</span>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden bg-black/[0.06] dark:bg-white/[0.08]">
                <div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.max(pct, 2)}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // 手机单列，宽屏仍三栏
  const Card = ({ title, hint, totalClass, total, children }) => (
    <div className="tb-soft-card min-w-0 rounded-xl overflow-hidden">
      <div className="px-3.5 py-2.5 border-b border-white/40 dark:border-white/[0.06] flex items-start justify-between gap-1.5">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 truncate">{title}</h2>
          <p className="text-[10px] leading-snug text-zinc-500 mt-0.5 line-clamp-2" title={hint}>{hint}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] text-zinc-400">{rangeLabel}</div>
          <div className={`text-[10px] mt-0.5 ${totalClass}`}>
            {t('dashboard.skillToolTotal', { n: total })}
          </div>
        </div>
      </div>
      <div className="px-3.5 py-3">{children}</div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <Card
        title={t('dashboard.skillUsage')}
        hint={t('dashboard.skillUsageHint')}
        totalClass="text-emerald-600 dark:text-emerald-400"
        total={skillTotal}
      >
        <RankList items={skillItems} max={maxSkill} emptyKey="dashboard.skillUsageEmpty" accent="bg-emerald-500" />
      </Card>
      <Card
        title={t('dashboard.toolUsage')}
        hint={t('dashboard.toolUsageHint')}
        totalClass="text-amber-600 dark:text-amber-400"
        total={toolTotal}
      >
        <RankList items={toolItems} max={maxTool} emptyKey="dashboard.toolUsageEmpty" accent="bg-amber-500" />
      </Card>
      <Card
        title={t('dashboard.mcpUsage')}
        hint={t('dashboard.mcpUsageHint')}
        totalClass="text-violet-600 dark:text-violet-400"
        total={mcpTotal}
      >
        <McpServerList />
      </Card>
    </div>
  );
}


function tierFromProvider(id = '') {
  if (P2P_PROVIDERS.includes(id))  return 'p2p';
  if (PAID_PROVIDERS.includes(id)) return 'paid';
  return 'free';
}


/** 趋势图：请求柱状 + Token/费用折线点叠加 */
function TrendBars({ mode = 'hourly', data = [], t, fmtCost, fmtN }) {
  const [tip, setTip] = useState(null);
  const H = 96;
  const nowH = new Date().getHours();

  const emptyHourly = () => Array.from({ length: 24 }, (_, hour) => ({
    hour, calls: 0, tokens: 0, cost_usd: 0, isNow: hour === nowH,
  }));

  const normalizeHourly = (raw) => {
    if (!Array.isArray(raw) || !raw.length) return emptyHourly();
    if (typeof raw[0] === 'number') {
      return raw.map((calls, hour) => ({
        hour, calls, tokens: 0, cost_usd: 0, isNow: hour === nowH,
      }));
    }
    return raw;
  };

  const items = mode === 'daily'
    ? (Array.isArray(data) ? data : [])
    : normalizeHourly(data);

  const n = items.length || 1;
  const maxCalls  = Math.max(...items.map(d => d.calls || 0), 1);
  const maxTokens = Math.max(...items.map(d => d.tokens || 0), 1);
  const maxCost   = Math.max(...items.map(d => d.cost_usd || 0), 1);

  const barH = (v) => Math.max(Math.round((v / maxCalls) * H), v > 0 ? 4 : 2);
  const lineY = (v, max) => H - (v / max) * H;

  const fmtDay = (dateStr) => {
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  };

  const renderTooltip = (item) => {
    const head = mode === 'daily'
      ? fmtDay(item.date)
      : t('dashboard.trendTipHour', { h: item.hour });
    return (
      <div className="space-y-0.5">
        <div>{head}</div>
        <div>{t('dashboard.trendTipCalls', { v: item.calls || 0 })}</div>
        <div>{t('dashboard.trendTipTokens', { v: fmtN(item.tokens || 0) })}</div>
        <div>{t('dashboard.trendTipCost', { v: fmtCost(item.cost_usd || 0) })}</div>
      </div>
    );
  };

  const labelIdx = mode === 'daily'
    ? (n <= 7 ? items.map((_, i) => i) : [0, Math.floor(n / 4), Math.floor(n / 2), Math.floor(n * 3 / 4), n - 1])
    : null;

  const tokenPts = items.map((item, i) => `${i + 0.5},${lineY(item.tokens || 0, maxTokens)}`).join(' ');
  const costPts  = items.map((item, i) => `${i + 0.5},${lineY(item.cost_usd || 0, maxCost)}`).join(' ');

  return (
    <div className="space-y-2">
      <div className="flex gap-4 text-xs text-zinc-500 dark:text-zinc-400">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-sm bg-blue-500" />
          {t('dashboard.trendLegendCalls')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-purple-500 rounded-full relative">
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-purple-500" />
          </span>
          {t('dashboard.trendLegendTokens')}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 bg-emerald-500 rounded-full relative">
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-emerald-500" />
          </span>
          {t('dashboard.trendLegendCost')}
        </span>
      </div>

      <div className="relative h-24">
        {/* 请求柱状图 */}
        <div className="absolute inset-0 flex items-end gap-0.5">
          {items.map((item, i) => {
            const highlight = mode === 'daily' ? item.isToday : item.isNow;
            const key = mode === 'daily' ? (item.date || i) : i;
            return (
              <div key={key} className="flex-1 min-w-0 flex items-end justify-center h-full">
                <div
                  className={`w-full max-w-[10px] rounded-sm transition-[background-color,height] duration-200 ease-out ${
                    highlight ? 'bg-blue-500' : 'bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-400 dark:hover:bg-zinc-500'
                  }`}
                  style={{ height: `${barH(item.calls || 0)}px` }}
                />
              </div>
            );
          })}
        </div>

        {/* Token / 费用折线（SVG）+ 圆点（HTML，避免拉伸变形） */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          viewBox={`0 0 ${n} ${H}`}
          preserveAspectRatio="none"
        >
          {maxTokens > 0 && (
            <polyline
              points={tokenPts}
              fill="none"
              stroke="rgb(168 85 247)"
              strokeWidth={0.12}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          )}
          {maxCost > 0 && (
            <polyline
              points={costPts}
              fill="none"
              stroke="rgb(16 185 129)"
              strokeWidth={0.12}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          )}
        </svg>
        {items.map((item, i) => {
          const left = ((i + 0.5) / n) * 100;
          const dots = [];
          if ((item.tokens || 0) > 0) {
            dots.push(
              <span
                key={`t-${i}`}
                className="absolute w-1.5 h-1.5 rounded-full bg-purple-500 ring-1 ring-white dark:ring-zinc-800 pointer-events-none"
                style={{ left: `${left}%`, bottom: `${((item.tokens || 0) / maxTokens) * 100}%`, transform: 'translate(-50%, 50%)' }}
              />
            );
          }
          if ((item.cost_usd || 0) > 0) {
            dots.push(
              <span
                key={`c-${i}`}
                className="absolute w-1.5 h-1.5 rounded-full bg-emerald-500 ring-1 ring-white dark:ring-zinc-800 pointer-events-none"
                style={{ left: `${left}%`, bottom: `${((item.cost_usd || 0) / maxCost) * 100}%`, transform: 'translate(-50%, 50%)' }}
              />
            );
          }
          return dots;
        })}

        {/* 悬停热区 + tooltip */}
        <div className="absolute inset-0 flex gap-0.5">
          {items.map((item, i) => {
            const key = mode === 'daily' ? (item.date || i) : i;
            return (
              <div
                key={`tip-${key}`}
                className="flex-1 min-w-0 cursor-default relative"
                onMouseEnter={() => setTip({ i, item })}
                onMouseLeave={() => setTip(null)}
              >
                {tip?.i === i && (
                  <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-10
                    bg-zinc-800 dark:bg-zinc-700 text-white text-xs rounded px-2 py-1
                    whitespace-nowrap pointer-events-none shadow">
                    {renderTooltip(item)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {mode === 'daily' ? (
        <div className="relative h-4">
          {labelIdx.map(i => {
            const item = items[i];
            if (!item) return null;
            const left = n <= 1 ? 0 : (i / (n - 1)) * 100;
            return (
              <span key={i} className="absolute text-xs text-zinc-700 dark:text-zinc-400 -translate-x-1/2"
                style={{ left: `${left}%` }}>
                {fmtDay(item.date)}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="flex justify-between px-0.5">
          {['0h', '6h', '12h', '18h', '24h'].map(l => (
            <span key={l} className="text-xs text-zinc-700 dark:text-zinc-400">{l}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { t } = useLang();
  const { fmtCost } = useCurrency();
  const [range, setRange]         = useState('today');
  const [localData, setLocalData] = useState(null);
  const [appsUsage, setAppsUsage] = useState([]);
  const [skillUsage, setSkillUsage] = useState({ total: 0, items: [] });
  const [toolUsage, setToolUsage] = useState({ total: 0, items: [] });
  const [mcpUsage, setMcpUsage] = useState({ total: 0, servers: [], items: [] });
  const [billableSubs, setBillableSubs] = useState([]);
  const [billingAccounts, setBillingAccounts] = useState({});
  const [usageSort, setUsageSort] = useState('calls');
  const [modelSort, setModelSort] = useState('calls');
  const [gwStatus, setGwStatus]   = useState(null);
  const [compStats, setCompStats] = useState(null);
  const [loading, setLoading]     = useState(true);
  const { user } = useAuth();
  // 登录后云端按设备合并的数（含这台电脑）。拿不到时整页只看这台电脑
  const [cloud, setCloud]         = useState(null);
  const [scopePick, setScopePick] = useState('all');  // 'all' 全部设备 | 'local' 这台电脑 | 其它设备 id
  const [thisDeviceId, setThisDeviceId] = useState('');
  const navigate = useNavigate();
  const [txs, setTxs] = useState([]);            // 积分流水（登录后）
  const [agentRows, setAgentRows] = useState([]); // 智能体今天的任务（谁用的）
  useEffect(() => {
    if (!user) { setTxs([]); return; }
    getTransactions().then(r => setTxs(r?.data?.transactions || [])).catch(() => setTxs([]));
  }, [user, range]);
  useEffect(() => {
    const api = window.electronAPI?.agent;
    if (!api?.taskStats) return;
    Promise.all([api.taskStats().catch(() => null), api.listAgents?.().catch(() => null)]).then(([st, list]) => {
      const by = st?.stats?.by_agent || {};
      const names = Object.fromEntries((list?.agents || []).map(a => [a.id, a]));
      setAgentRows(Object.entries(by).filter(([, v]) => v.tasks > 0).map(([id, v]) => ({
        id, name: names[id]?.name || id, runtime: names[id]?.runtimeName || '', tasks: v.tasks, ok: v.ok,
      })));
    });
  }, [range]);
  // 这台电脑在云端设备列表里的 id：和设备上报用的是同一个
  useEffect(() => {
    try {
      const id = window.electronAPI?.app?.getDeviceId?.();
      if (id) { setThisDeviceId(String(id)); return; }
    } catch { /* 走下面的网页接口 */ }
    fetch('/api/device-identity').then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.device_id) setThisDeviceId(String(d.device_id)); }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const days = RANGE_DAYS[range];
      let acct = {};
      let payg = [];
      let catalog = [];
      try {
        acct = await loadUserAccounts();
        payg = acct.user_payg_providers || [];
        catalog = acct.subscription_catalog || [];
      } catch { /* 无账户配置时回退 payg_usage_cost */ }
      setBillingAccounts(acct);
      const billableSubsList = resolveBillableSubscriptions(acct);
      setBillableSubs(billableSubsList);

      let data;
      if (window.electronAPI?.localStats) {
        data = await window.electronAPI.localStats.query(days);
        if (window.electronAPI.localStats.appsUsage) {
          const usage = await window.electronAPI.localStats.appsUsage(days);
          setAppsUsage(enrichAppsUsageBilling(usage || [], billableSubsList, days, catalog, acct));
        } else {
          setAppsUsage([]);
        }
        setSkillUsage(data.skill_usage || { total: 0, items: [] });
        setToolUsage(data.tool_usage || { total: 0, items: [] });
        setMcpUsage(data.mcp_usage || { total: 0, servers: [], items: [] });
      } else {
        const r = await fetch(`/api/local-stats?days=${days}`);
        if (!r.ok) throw new Error(`local-stats ${r.status}`);
        data = await r.json();
        setAppsUsage(enrichAppsUsageBilling(data.app_usage || [], billableSubsList, days, catalog, acct));
        setSkillUsage(data.skill_usage || { total: 0, items: [] });
        setToolUsage(data.tool_usage || { total: 0, items: [] });
        setMcpUsage(data.mcp_usage || { total: 0, servers: [], items: [] });
      }

      setLocalData(enrichDashboardBilling(data, payg, days, billableSubsList, catalog));

      // 登录后再取各设备合并的数；只认云端给的，退回本机的不算
      if (user) {
        fetchDashboardStats(days)
          .then(d => setCloud(d?.source === 'cloud' ? d : null))
          .catch(() => setCloud(null));
      } else {
        setCloud(null);
      }

      const fetchStatus = window.electronAPI?.gateway
        ? () => window.electronAPI.gateway.status().then(setGwStatus).catch(() => {})
        : () => fetch('/api/gateway/status').then(r => r.json()).then(setGwStatus).catch(() => {});
      fetchStatus();

      // 压缩比统计（本机：无损 JSON 压缩省下的 token）
      const cp = window.electronAPI?.localStats?.compression
        ? window.electronAPI.localStats.compression(days)
        : fetch(`/api/compression-stats?days=${days}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
      Promise.resolve(cp).then(s => setCompStats(s || null)).catch(() => setCompStats(null));
    } catch (e) {
      console.error('dashboard load', e);
    } finally {
      setLoading(false);
    }
  }, [range, user]);

  useEffect(() => { load(); }, [load]);

  // Skill/工具会话补录完成后刷新盘点（否则 WorkBuddy Skill 入库后仍显示 0）
  useEffect(() => {
    if (!window.electronAPI?.localStats?.onChanged) return undefined;
    return window.electronAPI.localStats.onChanged(() => { load(); });
  }, [load]);

  // ── 看哪些设备 ─────────────────────────────────────────────────────────────
  // 全部设备：云端合并；这台电脑：本机明细；其它设备：云端里那台的摘要
  const devices = cloud?.devices || [];
  const scope = !cloud ? 'local'
    : (scopePick === 'all' || scopePick === 'local' || devices.some(d => d.device_id === scopePick)) ? scopePick : 'all';
  const isThis = (d) => !!thisDeviceId && String(d?.device_id) === thisDeviceId;
  const pickedDevice = scope !== 'all' && scope !== 'local' ? devices.find(d => d.device_id === scope) : null;
  const useLocal = scope === 'local' || (pickedDevice && isThis(pickedDevice));
  const v = useLocal ? localData
    : scope === 'all' ? cloud
      : {
        total_calls: pickedDevice?.calls || 0, total_tokens: pickedDevice?.tokens || 0, total_cost: pickedDevice?.cost || 0,
        tiers: pickedDevice?.tiers || {}, providers: pickedDevice?.providers || [], models: pickedDevice?.models || [],
        app_usage: pickedDevice?.app_usage || [],
      };

  // ── Derived ───────────────────────────────────────────────────────────────
  const totalCalls  = v?.total_calls  ?? 0;
  const totalTokens = v?.total_tokens ?? 0;
  const totalCost   = v?.total_cost ?? 0;
  const subCost     = v?.subscription_cost ?? 0;
  const paygCost    = v?.payg_cost ?? 0;

  const freeCalls  = v?.tiers?.free  ?? 0;
  const p2pCalls   = v?.tiers?.p2p   ?? 0;
  const paidCalls  = v?.tiers?.paid  ?? 0;
  const freeRatio  = totalCalls > 0 ? Math.round(freeCalls / totalCalls * 100) : 0;

  const trendMode = range === 'today' ? 'hourly' : 'daily';
  const trendDays = RANGE_DAYS[range];
  // 趋势：选中的范围有逐时 / 逐日数据就用它，没有（单台其它设备、云端没给逐日）就用这台电脑的
  const trendOwn = (range === 'today' ? v?.hourly : v?.daily) || [];
  const trendFromLocal = !useLocal && !trendOwn.length;
  const trendDataRaw = trendFromLocal
    ? ((range === 'today' ? localData?.hourly : localData?.daily) ?? [])
    : trendOwn;
  const trendData = enrichTrendWithSubscriptionCost(
    trendDataRaw, trendMode, trendFromLocal ? (localData?.subscription_cost ?? 0) : subCost, trendDays,
  );
  const trendTitle = range === 'today'
    ? t('dashboard.trend')
    : range === '7d'
      ? t('dashboard.trend7d')
      : t('dashboard.trend30d');
  const byProvider = Object.fromEntries(
    (v?.providers ?? []).map(p => [p.id, { calls: p.calls, tier: p.tier }])
  );

  const modelStats    = [...(v?.models ?? [])].sort((a, b) => (b.calls || 0) - (a.calls || 0));
  // 费用：本机按账户折算订阅；云端已在汇总时算好
  const modelByCost   = useLocal ? enrichModelCostBilling(
    modelStats, billableSubs, RANGE_DAYS[range],
    billingAccounts.subscription_catalog || [],
    {
      api_subscription_catalog: billingAccounts.api_subscription_catalog || [],
      direct_source_billing: billingAccounts.direct_source_billing,
      direct_source_instances: billingAccounts.direct_source_instances,
      user_subscriptions: billingAccounts.user_subscriptions,
    },
  ) : modelStats.map(m => ({ ...m, cost_usd: Number(m.cost_usd) || 0 }));
  const appRows = useLocal ? appsUsage : (v?.app_usage || []);
  const comp = useLocal ? compStats : (scope === 'all' ? cloud?.compression : null);
  const localOnlyNote = useLocal ? '' : t('dashboard.localOnly');

  // 积分：选中时间段里的收入 / 支出（来自积分流水）
  const sinceMs = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    return range === 'today' ? d.getTime() : Date.now() - RANGE_DAYS[range] * 86400000;
  })();
  const txTime = (tx) => {
    const v = String(tx?.created_at || '');
    const ms = Date.parse(/[zZ+]|T.*-\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
    return Number.isFinite(ms) ? ms : 0;
  };
  const txInRange = txs.filter(tx => txTime(tx) >= sinceMs);
  const credit = txInRange.reduce((acc, tx) => {
    const d = Number(tx.delta) || 0;
    if (d > 0) acc.inc += d; else acc.out += -d;
    acc.net += d;
    return acc;
  }, { inc: 0, out: 0, net: 0 });
  const fmtCredit = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

  const rangeLabel = t(`profile.range.${range}`);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 bg-transparent text-zinc-900 dark:text-zinc-100 min-h-full">

      {/* Header：标题行放 Desktop 标签与日期选择，副标题单独一行 */}
      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-[17px] font-bold text-zinc-900 dark:text-zinc-100 tracking-tight shrink-0">{t('dashboard.title')}</h1>
            <span className="tb-tag tb-tag-muted !border-solid inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 shrink-0">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${gwStatus?.running !== false ? 'bg-green-500' : 'bg-zinc-400'}`}/>
              {isElectron() ? t('common.desktop') : t('common.cli')}
              {gwStatus?.port ? ` · :${gwStatus.port}` : ''}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 shrink-0">
            {t('dashboard.timeLabel')}
            <select value={range} onChange={e => setRange(e.target.value)}
              className="tb-soft-field text-xs px-2.5 py-1.5 rounded-lg text-zinc-800 dark:text-zinc-100">
              {RANGE_KEYS.map(r => <option key={r} value={r}>{t(`profile.range.${r}`)}</option>)}
            </select>
          </label>
        </div>
        {/* 看的是哪些设备：登录且云端有数时全部设备合在一起；在下面「设备」表里点一台只看它 */}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          {cloud ? (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              {t('dashboard.scopeMerged', { n: cloud.device_count ?? devices.length })}
            </span>
          ) : (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{t('dashboard.scopeThisDevice')}</span>
          )}
          <span className="text-zinc-400 dark:text-zinc-500">{t('dashboard.scopeNote')}</span>
          {cloud && scope !== 'all' && (
            <span className="inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">
              {t('dashboard.onlyThis', { name: scope === 'local' ? t('dashboard.scopeThisDevice') : formatDeviceTitle(pickedDevice) })}
              <button type="button" onClick={() => setScopePick('all')} className="text-blue-600 dark:text-blue-400 hover:underline">{t('dashboard.backToAll')}</button>
            </span>
          )}
        </div>
      </div>

      {/* Summary cards — 5列 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        {[
          {
            label: t('dashboard.estCost'),
            value: fmtCost(totalCost),
            valueCls: totalCost > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400',
            hint: totalCost > 0
              ? t('profile.costSub', { sub: subCost > 0 ? fmtCost(subCost) : '—', payg: paygCost > 0 ? fmtCost(paygCost) : '—' })
              : t('dashboard.estCostHint'),
          },
          {
            label: t('dashboard.totalRequests'),
            value: totalCalls,
            valueCls: 'text-zinc-900 dark:text-zinc-50',
            hint: scope === 'all' ? devices.slice(0, 3).map(d => `${isThis(d) ? t('dashboard.thisOne') : formatDeviceTitle(d)} ${(d.calls || 0).toLocaleString()}`).join(' · ') : pickedDevice && !useLocal ? t('dashboard.requestsHintDevice', { range: rangeLabel, name: formatDeviceTitle(pickedDevice) }) : t('dashboard.totalRequestsHint', { range: rangeLabel }),
          },
          {
            label: t('dashboard.tokenUsage'),
            value: fmtN(totalTokens),
            valueCls: 'text-purple-600 dark:text-purple-400',
            hint: t('dashboard.tokenHint', { range: rangeLabel }),
          },
          {
            label: t('dashboard.freeHitRate'),
            value: `${freeRatio}%`,
            valueCls: 'text-green-600 dark:text-green-400',
            hint: t('dashboard.freeHitHint', { free: freeCalls, p2p: p2pCalls, paid: paidCalls }),
          },
          {
            label: t('profile.compression.saved'),
            value: comp?.count > 0 ? fmtCost(comp.saved_usd || 0) : '—',
            valueCls: comp?.count > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400',
            hint: comp?.count > 0
              ? t('dashboard.compressHint', { n: comp.count, tokens: fmtN(comp.saved), ratio: ((comp.ratio || 0) * 100).toFixed(1) })
              : t('dashboard.compressEmpty'),
          },
          {
            label: t('dashboard.credits'),
            value: user ? `${credit.net >= 0 ? '+' : ''}${fmtCredit(credit.net)}` : '—',
            valueCls: !user ? 'text-zinc-400' : credit.net >= 0 ? 'text-zinc-900 dark:text-zinc-50' : 'text-violet-600 dark:text-violet-400',
            hint: user ? t('dashboard.creditsHint', { inc: fmtCredit(credit.inc), out: fmtCredit(credit.out) }) : t('dashboard.creditsLogin'),
          },
        ].map((c) => (
          <div key={c.label} className="tb-soft-card rounded-2xl px-3.5 py-3.5">
            <div className="text-[11px] text-zinc-400 dark:text-zinc-500">{c.label}</div>
            <div className={`text-[1.65rem] font-bold leading-none tabular-nums tracking-tight mt-2 ${c.valueCls}`}>{c.value}</div>
            <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-2 leading-snug">{c.hint}</div>
          </div>
        ))}
      </div>

      {/* Row: tier donut + trend bars */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <div className="md:col-span-2 tb-soft-card rounded-2xl p-5 flex flex-col gap-4">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('dashboard.requestMix')}</div>
          {(() => {
            const parts = [['free', freeCalls, 'bg-sky-300'], ['p2p', p2pCalls, 'bg-amber-500'], ['paid', paidCalls, 'bg-blue-900 dark:bg-blue-700']];
            const sum = parts.reduce((n, [, v]) => n + v, 0);
            return (
              <div className="space-y-2.5">
                <div className="flex h-5 w-full overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800" role="img"
                  aria-label={parts.map(([k, v]) => `${t(`dashboard.tier.${k}`)} ${sum ? Math.round(v / sum * 100) : 0}%`).join('，')}>
                  {sum > 0 && parts.map(([k, v, c]) => v > 0 && <span key={k} className={c} style={{ width: `${(v / sum) * 100}%` }} />)}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-300">
                  {parts.map(([k, v, c]) => (
                    <span key={k} className="inline-flex items-center gap-1.5">
                      <span className={`w-2.5 h-2.5 rounded-sm ${c}`} aria-hidden />
                      {t(`dashboard.tier.${k}`)} {sum ? Math.round(v / sum * 100) : 0}%
                      <span className="text-zinc-400 tabular-nums">{v.toLocaleString()}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
        <div className="md:col-span-3 tb-soft-card rounded-2xl p-5">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4">
            {trendTitle}
            {trendFromLocal && <span className="ml-2 text-[11px] font-normal text-zinc-400">{t('dashboard.localOnly')}</span>}
          </div>
          <TrendBars mode={trendMode} data={trendData} t={t} fmtCost={fmtCost} fmtN={fmtN} />
        </div>
      </div>

      {/* 谁用的：应用和跑在它们上面的智能体 */}
      <div className="tb-soft-card rounded-2xl p-5">
        <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-3">{t('dashboard.whoUsed')}</div>
        {appRows.length === 0 && agentRows.length === 0 ? (
          <p className="text-xs text-zinc-500">{t('dashboard.whoUsedEmpty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[11px] text-zinc-400 dark:text-zinc-500 text-left">
                  <th className="font-normal py-1.5 pr-3">{t('dashboard.col.who')}</th>
                  <th className="font-normal py-1.5 pr-3 text-right">{t('dashboard.col.calls')}</th>
                  <th className="font-normal py-1.5 pr-3 text-right">Token</th>
                  <th className="font-normal py-1.5 pr-3 text-right">{t('dashboard.col.cost')}</th>
                  <th className="font-normal py-1.5">{t('dashboard.col.from')}</th>
                </tr>
              </thead>
              <tbody>
                {[...appRows].sort((a, b) => (b.calls || 0) - (a.calls || 0)).map(r => {
                  const from = [r.proxyCalls > 0 ? t('dashboard.fromGateway', { n: r.proxyCalls.toLocaleString() }) : '', r.sessionCalls > 0 ? t('dashboard.fromSession', { n: r.sessionCalls.toLocaleString() }) : ''].filter(Boolean).join(' · ');
                  const cost = Number(r.cost ?? r.cost_usd) || 0;
                  return (
                    <tr key={r.id || r.name} className="border-t border-zinc-100 dark:border-white/[0.06]">
                      <td className="py-1.5 pr-3 text-zinc-800 dark:text-zinc-100">{r.name}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{(r.calls || 0).toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtN(r.tokens || 0)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{cost > 0 ? fmtCost(cost) : (r.subscription_cost > 0 ? t('dashboard.inSub') : '—')}</td>
                      <td className="py-1.5 text-zinc-500 dark:text-zinc-400">{from || '—'}</td>
                    </tr>
                  );
                })}
                {useLocal && range === 'today' && agentRows.map(a => (
                  <tr key={a.id} className="border-t border-zinc-100 dark:border-white/[0.06]">
                    <td className="py-1.5 pr-3 text-zinc-800 dark:text-zinc-100">{a.runtime ? t('dashboard.agentOn', { name: a.name, app: a.runtime }) : a.name}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{t('dashboard.tasks', { n: a.tasks })}</td>
                    <td className="py-1.5 pr-3 text-right text-zinc-400">—</td>
                    <td className="py-1.5 pr-3 text-right text-zinc-400">—</td>
                    <td className="py-1.5 text-zinc-500 dark:text-zinc-400">{t('dashboard.fromTasks', { ok: a.ok })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>


      {/* 用了哪些模型：一张表，可按调用 / Token / 费用排 */}
      {(() => {
        const costBy = Object.fromEntries(modelByCost.map(m => [m.model, m.cost_usd || 0]));
        const rows = [...modelStats].map(m => ({ ...m, cost: costBy[m.model] || 0 }));
        rows.sort((a, b) => (modelSort === 'tokens' ? (b.tokens || 0) - (a.tokens || 0)
          : modelSort === 'cost' ? b.cost - a.cost : (b.calls || 0) - (a.calls || 0)));
        const tierOf = (m) => {
          const tr = m.provider_id ? (byProvider[m.provider_id]?.tier || tierFromProvider(m.provider_id)) : null;
          return tr === 'free' || tr === 'p2p' || tr === 'paid' ? t(`dashboard.tier.${tr}`) : '—';
        };
        return (
          <div className="tb-soft-card rounded-2xl p-5">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('dashboard.modelsTable')}</div>
              <div className="ml-auto tb-glass-chip flex gap-0.5 rounded-xl p-0.5">
                {[['calls', t('dashboard.sortCalls')], ['tokens', t('dashboard.sortTokens')], ['cost', t('dashboard.sortCost')]].map(([k, label]) => (
                  <button key={k} type="button" onClick={() => setModelSort(k)} aria-pressed={modelSort === k}
                    className={`px-2.5 py-1 text-xs rounded-lg ${modelSort === k ? 'bg-white/80 dark:bg-white/10 font-semibold text-zinc-800 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400'}`}>{label}</button>
                ))}
              </div>
            </div>
            {rows.length === 0 ? (
              <p className="text-xs text-zinc-500">{t('common.noData')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[11px] text-zinc-400 dark:text-zinc-500 text-left">
                      <th className="font-normal py-1.5 pr-3">{t('dashboard.col.model')}</th>
                      <th className="font-normal py-1.5 pr-3">{t('dashboard.col.source')}</th>
                      <th className="font-normal py-1.5 pr-3">{t('dashboard.col.tier')}</th>
                      <th className="font-normal py-1.5 pr-3 text-right">{t('dashboard.col.calls')}</th>
                      <th className="font-normal py-1.5 pr-3 text-right">Token</th>
                      <th className="font-normal py-1.5 text-right">{t('dashboard.col.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(m => (
                      <tr key={m.model} className="border-t border-zinc-100 dark:border-white/[0.06]">
                        <td className="py-1.5 pr-3 font-mono text-zinc-800 dark:text-zinc-100 max-w-[16rem] truncate" title={m.model}>{m.model}</td>
                        <td className="py-1.5 pr-3 text-zinc-600 dark:text-zinc-300 max-w-[12rem] truncate" title={(m.provider_ids || []).join('、')}>
                          {m.provider_id || '—'}{(m.provider_ids || []).length > 1 ? t('dashboard.moreSources', { n: m.provider_ids.length - 1 }) : ''}
                        </td>
                        <td className="py-1.5 pr-3 text-zinc-500 dark:text-zinc-400">{tierOf(m)}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{(m.calls || 0).toLocaleString()}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{fmtN(m.tokens || 0)}</td>
                        <td className="py-1.5 text-right tabular-nums">{m.cost > 0 ? fmtCost(m.cost) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}


      <SkillToolUsageSection
        skillUsage={skillUsage}
        toolUsage={toolUsage}
        mcpUsage={mcpUsage}
        rangeLabel={localOnlyNote ? `${rangeLabel} · ${localOnlyNote}` : rangeLabel}
        loading={loading}
        t={t}
      />

      {/* 设备：各台用了多少，点一行只看那台 */}
      {cloud && devices.length > 0 && (
        <div className="tb-soft-card rounded-2xl p-5">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-3">{t('dashboard.devices')}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[11px] text-zinc-400 dark:text-zinc-500 text-left">
                  <th className="font-normal py-1.5 pr-3">{t('dashboard.col.device')}</th>
                  <th className="font-normal py-1.5 pr-3">{t('dashboard.col.state')}</th>
                  <th className="font-normal py-1.5 pr-3 text-right">{t('dashboard.col.calls')}</th>
                  <th className="font-normal py-1.5 pr-3 text-right">Token</th>
                  <th className="font-normal py-1.5 pr-3 text-right">{t('dashboard.col.cost')}</th>
                  <th className="font-normal py-1.5 text-right">{t('dashboard.col.share')}</th>
                </tr>
              </thead>
              <tbody>
                {devices.map(d => {
                  const id = isThis(d) ? 'local' : d.device_id;
                  return (
                    <tr key={d.device_id} onClick={() => setScopePick(id)}
                      className={`border-t border-zinc-100 dark:border-white/[0.06] cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04] ${scope === id ? 'bg-emerald-50/60 dark:bg-emerald-900/10' : ''}`}>
                      <td className="py-1.5 pr-3 text-zinc-800 dark:text-zinc-100">
                        {formatDeviceTitle(d)}{isThis(d) && <span className="ml-1.5 text-[10px] text-zinc-400">{t('dashboard.thisOne')}</span>}
                      </td>
                      <td className="py-1.5 pr-3">
                        <span className={`inline-flex items-center gap-1 ${d.online ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${d.online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
                          {d.online ? t('profile.online') : t('profile.offline')}
                        </span>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{(d.calls || 0).toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{fmtN(d.tokens || 0)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{d.cost > 0 ? fmtCost(d.cost) : '—'}</td>
                      <td className="py-1.5 text-right tabular-nums">{d.share_pct ?? 0}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 订阅：月付按天折算 */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="tb-soft-card rounded-2xl p-5">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-3">{t('dashboard.subs')}</div>
          {billableSubs.length === 0 ? (
            <p className="text-xs text-zinc-500">{t('dashboard.subsEmpty')}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[11px] text-zinc-400 dark:text-zinc-500 text-left">
                  <th className="font-normal py-1.5 pr-3">{t('dashboard.col.sub')}</th>
                  <th className="font-normal py-1.5 pr-3">{t('dashboard.col.kind')}</th>
                  <th className="font-normal py-1.5 pr-3 text-right">{t('dashboard.col.monthly')}</th>
                  <th className="font-normal py-1.5 text-right">{t('dashboard.col.share2')}</th>
                </tr>
              </thead>
              <tbody>
                {billableSubs.map((sub, i) => (
                  <tr key={sub.id || i} className="border-t border-zinc-100 dark:border-white/[0.06]">
                    <td className="py-1.5 pr-3 text-zinc-800 dark:text-zinc-100">{sub.plan_label ? `${sub.app_name || sub.name} ${sub.plan_label}` : (sub.app_name || sub.name || sub.agent_id)}</td>
                    <td className="py-1.5 pr-3 text-zinc-500">{sub.subscription_kind === 'api' ? t('dashboard.subApi') : t('dashboard.subApp')}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{fmtCost(Number(sub.monthly_usd) || 0)}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtCost((Number(sub.monthly_usd) || 0) / 30 * RANGE_DAYS[range])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-2 text-[11px] text-zinc-400">{t('dashboard.subsNote')}</p>
        </div>

        {/* 积分进出：最近几笔 */}
        <div className="tb-soft-card rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('dashboard.creditFlow')}</div>
            <button type="button" onClick={() => navigate('/account')} className="ml-auto text-[11px] text-blue-600 dark:text-blue-400 hover:underline">{t('dashboard.creditFlowLink')}</button>
          </div>
          {!user ? (
            <p className="text-xs text-zinc-500">{t('dashboard.creditsLogin')}</p>
          ) : txInRange.length === 0 ? (
            <p className="text-xs text-zinc-500">{t('dashboard.creditFlowEmpty')}</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {txInRange.slice(0, 8).map((tx, i) => {
                  const d = Number(tx.delta) || 0;
                  const when = new Date(txTime(tx));
                  const what = tx.note || (tx.model_name ? `${t(`dashboard.tx.${tx.type}`) === `dashboard.tx.${tx.type}` ? tx.type : t(`dashboard.tx.${tx.type}`)} · ${tx.model_name}` : (t(`dashboard.tx.${tx.type}`) === `dashboard.tx.${tx.type}` ? tx.type : t(`dashboard.tx.${tx.type}`)));
                  return (
                    <tr key={tx.id || i} className="border-t first:border-t-0 border-zinc-100 dark:border-white/[0.06]">
                      <td className="py-1.5 pr-3 text-zinc-500 tabular-nums whitespace-nowrap">{`${when.getMonth() + 1}-${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`}</td>
                      <td className="py-1.5 pr-3 text-zinc-800 dark:text-zinc-100 max-w-[16rem] truncate" title={what}>{what}</td>
                      <td className={`py-1.5 text-right tabular-nums font-medium ${d > 0 ? 'text-emerald-700 dark:text-emerald-300' : d < 0 ? 'text-violet-700 dark:text-violet-300' : 'text-zinc-400'}`}>
                        {d > 0 ? t('dashboard.txIn', { n: fmtCredit(d) }) : d < 0 ? t('dashboard.txOut', { n: fmtCredit(-d) }) : t('dashboard.txZero')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

    </div>
  );
}
