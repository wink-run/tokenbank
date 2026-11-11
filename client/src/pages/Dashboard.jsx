import { useState, useEffect, useCallback } from 'react';
import { isElectron } from '../api/adapter';
import { enrichDashboardBilling, enrichTrendWithSubscriptionCost, enrichAppsUsageBilling, enrichModelCostBilling, resolveBillableSubscriptions } from '../utils/billing-cost';
import { loadUserAccounts } from '../api/userAccounts';
import { useLang } from '../store/lang';
import { useCurrency } from '../store/currency';
import { RANGE_KEYS, RANGE_DAYS } from '../utils/ranges';
import { isAppIcon, appIconSvg } from '../lib/appIcons';
import { brandIconFor } from '../lib/brandIcons';
import { useAuth } from '../store/index';
import { MultiDeviceUsage } from './TokenDashboard';

const PAID_PROVIDERS = ['openai', 'anthropic-paid', 'openrouter', 'anthropic'];
const P2P_PROVIDERS  = ['tokenbank-p2p'];

const fmtN    = n => n >= 1_000_000 ? (n/1e6).toFixed(2)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);

function linkMethodLabel(method, t) {
  if (method === 'manual' || method === 'api-key') return t('common.linkApi');
  return t('common.linkApp');
}

function appSourceLabel(row, t) {
  if (row.proxyCalls > 0 && row.sessionCalls > 0) return t('common.mixedSource');
  if (row.proxyCalls > 0) return t('common.sourceGateway');
  if (row.sessionCalls > 0) return t('common.sourceSession');
  return '';
}

/** 应用图标：与网关页一致 — 品牌 logo → icon:xxx SVG → emoji */
function AppIconDisplay({ app, icon, className = 'w-[18px] h-[18px]' }) {
  const row = app || {};
  const brand = brandIconFor(row);
  if (brand) return <img src={brand} alt="" className={`${className} object-contain shrink-0`} />;
  const ic = icon ?? row.icon;
  if (isAppIcon(ic)) return appIconSvg(ic, `${className} shrink-0`);
  return <span className="text-base shrink-0">{ic || '🔧'}</span>;
}

const APP_USAGE_COLORS = [
  'bg-indigo-500', 'bg-purple-500', 'bg-violet-500', 'bg-pink-500',
  'bg-amber-500', 'bg-emerald-500', 'bg-blue-500', 'bg-teal-500',
];

/** 来源构成：网关实时 vs 会话补录 */
function SourceMixBar({ proxy, session, total, className = 'h-2', t }) {
  const tot = total || proxy + session || 1;
  const pPct = Math.round((proxy / tot) * 100);
  const sPct = Math.max(0, 100 - pPct);
  if (!proxy && !session) {
    return <div className={`flex-1 rounded-full bg-black/[0.06] dark:bg-white/[0.08] ${className}`} />;
  }
  return (
    <div className={`flex-1 flex rounded-full overflow-hidden bg-black/[0.04] dark:bg-white/[0.05] ${className}`} title={t('dashboard.sourceMixTitle', { proxy, session })}>
      {pPct > 0 && <div className="bg-blue-500 h-full" style={{ width: `${pPct}%` }} />}
      {sPct > 0 && <div className="bg-violet-400/80 h-full" style={{ width: `${sPct}%` }} />}
    </div>
  );
}

/** 应用占比总览条（参考 tokentelemetry agent share） */
function AppShareStrip({ rows, metric = 'tokens' }) {
  if (!rows?.length) return null;
  const total = rows.reduce((s, r) => s + (r[metric] || 0), 0) || 1;
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-black/[0.06] dark:bg-white/[0.08] ring-1 ring-inset ring-black/[0.04] dark:ring-white/[0.06]">
        {rows.map((r, i) => {
          const v = r[metric] || 0;
          if (!v) return null;
          const pct = Math.max((v / total) * 100, 0.5);
          return (
            <div
              key={r.id}
              className={`h-full ${APP_USAGE_COLORS[i % APP_USAGE_COLORS.length]}`}
              style={{ width: `${pct}%` }}
              title={`${r.name} · ${fmtN(v)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {rows.slice(0, 8).map((r, i) => (
          <span key={r.id} className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
            <span className={`w-2 h-2 rounded-full shrink-0 ${APP_USAGE_COLORS[i % APP_USAGE_COLORS.length]}`} />
            <span className="truncate max-w-[8rem] inline-flex items-center gap-1">
              <AppIconDisplay app={r} className="w-3.5 h-3.5" />
              {r.name}
            </span>
            <span className="text-zinc-400">{Math.round(((r[metric] || 0) / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

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

function AppUsageSection({ rows, rangeLabel, loading, sortBy, onSortBy, t }) {
  const { fmtCost } = useCurrency();
  const maxCalls = Math.max(...(rows || []).map(r => r.calls), 1);
  const maxTokens = Math.max(...(rows || []).map(r => r.tokens), 1);
  const sorted = [...(rows || [])].sort((a, b) =>
    sortBy === 'tokens' ? (b.tokens - a.tokens) : (b.calls - a.calls));

  return (
    <div className="tb-soft-panel rounded-2xl overflow-hidden">
      <div className="px-4 py-3.5 border-b border-white/40 dark:border-white/[0.06] space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('dashboard.appUsage')}</h2>
            <p className="text-xs text-zinc-500 mt-0.5">{t('dashboard.appUsageHint')}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">{rangeLabel}</span>
            <div className="tb-glass-chip flex gap-0.5 rounded-lg p-0.5">
              {[['calls', t('common.sortCalls')], ['tokens', t('common.sortTokens')]].map(([k, label]) => (
                <button key={k} type="button" onClick={() => onSortBy(k)}
                  className={`px-2 py-0.5 text-xs rounded-md transition-colors ${
                    sortBy === k
                      ? 'bg-white/80 dark:bg-white/10 text-zinc-800 dark:text-zinc-100 font-semibold shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
                  }`}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        {!loading && sorted.length > 0 && <AppShareStrip rows={sorted} metric={sortBy} />}
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" />{t('common.sourceProxy')}</span>
          <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-violet-400" />{t('common.sourceSessionImport')}</span>
        </div>
      </div>
      {loading ? (
        <div className="px-4 py-8 text-xs text-zinc-600 text-center">{t('common.loading')}</div>
      ) : sorted.length === 0 ? (
        <div className="px-4 py-8 text-xs text-zinc-600 text-center">
          {t('dashboard.appUsageEmpty')}
        </div>
      ) : (
        /* 内嵌表格：保留 glass 边/阴影，避免 !border-0 叠成实色白块 */
        <div className="px-3 pb-3 pt-1">
          <div className="tb-table-shell rounded-xl">
            <div className="tb-table-head hidden sm:grid grid-cols-[minmax(0,1.4fr)_4.5rem_4.5rem_4rem_minmax(0,1fr)] gap-3 px-3.5 py-2">
              <span>{t('dashboard.colApp')}</span>
              <span className="text-right">{t('dashboard.colRequests')}</span>
              <span className="text-right">{t('dashboard.colTokens')}</span>
              <span className="text-right">{t('dashboard.colCost')}</span>
              <span>{t('dashboard.colSourceMix')}</span>
            </div>
            {sorted.map((r, i) => (
              <div key={r.id} className="tb-table-row px-3.5 py-3">
                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1.4fr)_4.5rem_4.5rem_4rem_minmax(0,1fr)] gap-3 items-center">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-1 h-8 rounded-full shrink-0 ${APP_USAGE_COLORS[i % APP_USAGE_COLORS.length]}`} />
                    <AppIconDisplay app={r} />
                    <div className="min-w-0">
                      <div className="tb-table-cell-primary truncate">{r.name}</div>
                      <div className="tb-table-cell-meta truncate">
                        {linkMethodLabel(r.link_method, t)}
                        {appSourceLabel(r, t)}
                      </div>
                    </div>
                  </div>
                  <div className="sm:text-right">
                    <div className="text-sm font-semibold tabular-nums">{r.calls.toLocaleString()}</div>
                    <div className="mt-1 h-1 rounded-full overflow-hidden hidden sm:block bg-black/[0.06] dark:bg-white/[0.08]">
                      <div className={`h-full rounded-full ${APP_USAGE_COLORS[i % APP_USAGE_COLORS.length]}`}
                        style={{ width: `${Math.round(r.calls / maxCalls * 100)}%` }} />
                    </div>
                  </div>
                  <div className="sm:text-right">
                    <div className="text-sm font-semibold tabular-nums text-purple-600 dark:text-purple-400">{fmtN(r.tokens)}</div>
                    <div className="mt-1 h-1 rounded-full overflow-hidden hidden sm:block bg-black/[0.06] dark:bg-white/[0.08]">
                      <div className="h-full rounded-full bg-purple-500"
                        style={{ width: `${Math.round((r.tokens || 0) / maxTokens * 100)}%` }} />
                    </div>
                  </div>
                  <div className="sm:text-right text-xs text-emerald-600 dark:text-emerald-400 tabular-nums">{fmtCost(r.cost)}</div>
                  <SourceMixBar
                    proxy={sortBy === 'tokens' ? r.proxyTokens : r.proxyCalls}
                    session={sortBy === 'tokens' ? r.sessionTokens : r.sessionCalls}
                    total={sortBy === 'tokens' ? r.tokens : r.calls}
                    t={t}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function tierFromProvider(id = '') {
  if (P2P_PROVIDERS.includes(id))  return 'p2p';
  if (PAID_PROVIDERS.includes(id)) return 'paid';
  return 'free';
}

function TierDonut({ byProvider = {}, t }) {
  let free = 0, p2p = 0, paid = 0, total = 0;
  for (const [id, v] of Object.entries(byProvider)) {
    const t = v.tier || tierFromProvider(id);
    const n = v.calls || 0;
    if (t === 'free') free += n;
    else if (t === 'p2p') p2p += n;
    else paid += n;
    total += n;
  }
  if (!total) return (
    <div className="flex items-center justify-center h-full text-xs text-zinc-600">{t('common.noData')}</div>
  );

  const r = 36, circ = 2 * Math.PI * r;
  const fPct = free / total, pPct = p2p / total, aPct = paid / total;
  const fLen = fPct * circ, p2pLen = pPct * circ, aLen = aPct * circ;
  const fOff = circ * 0.25;
  const p2pOff = fOff - fLen;
  const aOff = p2pOff - p2pLen;

  return (
    <div className="flex items-center gap-5">
      <div className="relative shrink-0">
        <svg width="100" height="100" viewBox="0 0 100 100" className="-rotate-90">
          <circle cx="50" cy="50" r={r} fill="none" stroke="#1f2937" strokeWidth="12"/>
          {fLen > 0 && <circle cx="50" cy="50" r={r} fill="none" stroke="#22c55e" strokeWidth="12"
            strokeDasharray={`${fLen} ${circ}`} strokeDashoffset={fOff}/>}
          {p2pLen > 0 && <circle cx="50" cy="50" r={r} fill="none" stroke="#3b82f6" strokeWidth="12"
            strokeDasharray={`${p2pLen} ${circ}`} strokeDashoffset={p2pOff}/>}
          {aLen > 0 && <circle cx="50" cy="50" r={r} fill="none" stroke="#f59e0b" strokeWidth="12"
            strokeDasharray={`${aLen} ${circ}`} strokeDashoffset={aOff}/>}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="text-base font-bold text-green-600 dark:text-green-400">{Math.round(fPct * 100)}%</div>
          <div className="text-xs text-zinc-600">{t('common.free')}</div>
        </div>
      </div>
      <div className="space-y-2.5 flex-1">
        {[
          { color: 'bg-green-500', label: t('common.tier.free'), count: free },
          { color: 'bg-blue-500',  label: t('common.tier.p2p'),  count: p2p  },
          { color: 'bg-amber-500', label: t('common.tier.paid'), count: paid  },
        ].map(row => (
          <div key={row.label} className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className={`w-2.5 h-2.5 rounded-full ${row.color} shrink-0`}/>
              <span className="text-xs text-zinc-700 dark:text-zinc-300 truncate">{row.label}</span>
            </div>
            <span className="text-xs whitespace-nowrap shrink-0 text-zinc-700 dark:text-zinc-200">
              <span className="font-semibold">{row.count}</span>
              <span className="text-zinc-400 ml-1">{total ? Math.round(row.count / total * 100) : 0}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
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
  const [gwStatus, setGwStatus]   = useState(null);
  const [compStats, setCompStats] = useState(null);
  const [loading, setLoading]     = useState(true);
  const { user } = useAuth();
  const [merged, setMerged]       = useState(null);   // 登录后：多台设备合并的数（云端）

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
        setAppsUsage([]);
        setSkillUsage(data.skill_usage || { total: 0, items: [] });
        setToolUsage(data.tool_usage || { total: 0, items: [] });
        setMcpUsage(data.mcp_usage || { total: 0, servers: [], items: [] });
      }

      setLocalData(enrichDashboardBilling(data, payg, days, billableSubsList, catalog));

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
  }, [range]);

  useEffect(() => { load(); }, [load]);

  // Skill/工具会话补录完成后刷新盘点（否则 WorkBuddy Skill 入库后仍显示 0）
  useEffect(() => {
    if (!window.electronAPI?.localStats?.onChanged) return undefined;
    return window.electronAPI.localStats.onChanged(() => { load(); });
  }, [load]);

  // ── Derived ───────────────────────────────────────────────────────────────
  const totalCalls  = localData?.total_calls  ?? 0;
  const totalTokens = localData?.total_tokens ?? 0;
  const totalCost   = localData?.total_cost ?? 0;
  const subCost     = localData?.subscription_cost ?? 0;
  const paygCost    = localData?.payg_cost ?? 0;

  const freeCalls  = localData?.tiers?.free  ?? 0;
  const p2pCalls   = localData?.tiers?.p2p   ?? 0;
  const paidCalls  = localData?.tiers?.paid  ?? 0;
  const freeRatio  = totalCalls > 0 ? Math.round(freeCalls / totalCalls * 100) : 0;

  const trendMode = range === 'today' ? 'hourly' : 'daily';
  const trendDays = RANGE_DAYS[range];
  const trendDataRaw = range === 'today'
    ? (localData?.hourly ?? [])
    : (localData?.daily ?? []);
  const trendData = enrichTrendWithSubscriptionCost(
    trendDataRaw, trendMode, subCost, trendDays,
  );
  const trendTitle = range === 'today'
    ? t('dashboard.trend')
    : range === '7d'
      ? t('dashboard.trend7d')
      : t('dashboard.trend30d');
  const byProvider = Object.fromEntries(
    (localData?.providers ?? []).map(p => [p.id, { calls: p.calls, tier: p.tier }])
  );

  const modelStats    = localData?.models ?? [];
  const maxModel      = modelStats[0]?.calls || 1;
  const modelByTokens = [...modelStats].filter(m => m.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const maxModelTokens = modelByTokens[0]?.tokens || 1;
  const modelByCost   = enrichModelCostBilling(
    modelStats, billableSubs, RANGE_DAYS[range],
    billingAccounts.subscription_catalog || [],
    {
      api_subscription_catalog: billingAccounts.api_subscription_catalog || [],
      direct_source_billing: billingAccounts.direct_source_billing,
      direct_source_instances: billingAccounts.direct_source_instances,
      user_subscriptions: billingAccounts.user_subscriptions,
    },
  );
  const maxModelCost  = modelByCost[0]?.cost_usd || 1;

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
          <div className="tb-glass-chip flex gap-0.5 rounded-xl p-0.5 shrink-0">
            {RANGE_KEYS.map(r => (
              <button key={r} onClick={() => setRange(r)}
                className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                  range === r
                    ? 'bg-white/80 dark:bg-white/10 text-zinc-800 dark:text-zinc-100 font-semibold shadow-sm'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'
                }`}>{t(`profile.range.${r}`)}</button>
            ))}
          </div>
        </div>
        <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">
          {t('dashboard.subtitle')}
          {' · '}
          {user && merged?.source === 'cloud'
            ? t('dashboard.scopeMerged', { n: merged.device_count ?? (merged.devices || []).length ?? 0 })
            : t('dashboard.scopeLocal')}
        </p>
      </div>

      {/* 登录后：多台设备合并（云端汇总），按设备看分布 */}
      {/* 云端取不到时它会退回这台电脑的数，和下面重复，所以只在拿到云端数据时显示 */}
      {user && (
        <div className={merged?.source === 'cloud' ? '' : 'hidden'}>
          <MultiDeviceUsage range={range} onData={setMerged} />
        </div>
      )}
      {user && merged?.source === 'cloud' && (
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 pt-2">{t('dashboard.thisDevice')}</h2>
      )}

      {/* Summary cards — 5列 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
        {[
          {
            label: t('dashboard.totalRequests'),
            value: totalCalls,
            valueCls: 'text-zinc-900 dark:text-zinc-50',
            hint: t('dashboard.totalRequestsHint', { range: rangeLabel }),
          },
          {
            label: t('dashboard.freeHitRate'),
            value: `${freeRatio}%`,
            valueCls: 'text-green-600 dark:text-green-400',
            hint: t('dashboard.freeHitHint', { free: freeCalls, p2p: p2pCalls, paid: paidCalls }),
          },
          {
            label: t('dashboard.tokenUsage'),
            value: fmtN(totalTokens),
            valueCls: 'text-purple-600 dark:text-purple-400',
            hint: t('dashboard.tokenHint', { range: rangeLabel }),
          },
          {
            label: t('dashboard.paidCalls'),
            value: paidCalls + p2pCalls,
            valueCls: 'text-amber-600 dark:text-amber-400',
            hint: t('dashboard.paidCallsHint', { paid: paidCalls, p2p: p2pCalls }),
          },
          {
            label: t('dashboard.estCost'),
            value: fmtCost(totalCost),
            valueCls: totalCost > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400',
            hint: totalCost > 0
              ? t('profile.costSub', { sub: subCost > 0 ? fmtCost(subCost) : '—', payg: paygCost > 0 ? fmtCost(paygCost) : '—' })
              : t('dashboard.estCostHint'),
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
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('dashboard.tierDist')}</div>
          <TierDonut byProvider={byProvider} t={t} />
        </div>
        <div className="md:col-span-3 tb-soft-card rounded-2xl p-5">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4">{trendTitle}</div>
          <TrendBars mode={trendMode} data={trendData} t={t} fmtCost={fmtCost} fmtN={fmtN} />
        </div>
      </div>

      <AppUsageSection
        rows={appsUsage}
        rangeLabel={rangeLabel}
        loading={loading}
        sortBy={usageSort}
        onSortBy={setUsageSort}
        t={t}
      />

      <SkillToolUsageSection
        skillUsage={skillUsage}
        toolUsage={toolUsage}
        mcpUsage={mcpUsage}
        rangeLabel={rangeLabel}
        loading={loading}
        t={t}
      />

      {/* 压缩节省（无损 JSON 压缩，本机实测） */}
      {compStats && (
        <div className="tb-soft-card rounded-2xl p-5">
          <div className="mb-3">
            <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('profile.compression.title')}</div>
          </div>
          {compStats.count > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <div className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">{t('profile.compression.requests')}</div>
                <div className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{compStats.count}</div>
              </div>
              <div className="border-l border-zinc-200/70 dark:border-zinc-700/70 pl-4">
                <div className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">{t('profile.compression.saved')}</div>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{fmtN(compStats.saved)}</div>
              </div>
              <div className="border-l border-zinc-200/70 dark:border-zinc-700/70 pl-4">
                <div className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">{t('profile.compression.savedCost')}</div>
                <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{fmtCost(compStats.saved_usd || 0)}</div>
              </div>
              <div className="border-l border-zinc-200/70 dark:border-zinc-700/70 pl-4">
                <div className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">{t('profile.compression.ratio')}</div>
                <div className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{(compStats.ratio * 100).toFixed(1)}%</div>
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('profile.compression.empty')}</p>
          )}
        </div>
      )}

      {/* Model rankings — 3 columns */}
      <div className="grid grid-cols-3 gap-4">
        {/* Call count */}
        <div className="tb-soft-card rounded-2xl p-5">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4">{t('dashboard.modelRank')}</div>
          {modelStats.length === 0 ? (
            <p className="text-xs text-zinc-600">{t('common.noData')}</p>
          ) : (
            <div className="space-y-3">
              {modelStats.map(m => (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-zinc-700 dark:text-zinc-300 truncate max-w-[140px]" title={m.model}>{m.model}</span>
                    <span className="text-xs text-zinc-600 dark:text-zinc-400 shrink-0 ml-2">{m.calls} {t('common.times')}</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden bg-black/[0.06] dark:bg-white/[0.08]">
                    <div className="h-full rounded-full transition-[width] duration-200 ease-out bg-green-500"
                      style={{ width: `${Math.round(m.calls / maxModel * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Token consumption */}
        <div className="tb-soft-card rounded-2xl p-5">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4">{t('dashboard.modelTokenRank')}</div>
          {modelByTokens.length === 0 ? (
            <p className="text-xs text-zinc-600">{t('common.noData')}</p>
          ) : (
            <div className="space-y-3">
              {modelByTokens.map(m => (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-zinc-700 dark:text-zinc-300 truncate max-w-[140px]" title={m.model}>{m.model}</span>
                    <span className="text-xs text-purple-600 dark:text-purple-400 shrink-0 ml-2">{fmtN(m.tokens)} tok</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden bg-black/[0.06] dark:bg-white/[0.08]">
                    <div className="h-full rounded-full transition-[width] duration-200 ease-out bg-purple-500"
                      style={{ width: `${Math.round((m.tokens||0) / maxModelTokens * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cost ranking */}
        <div className="tb-soft-card rounded-2xl p-5">
          <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-4">{t('dashboard.modelCostRank')}</div>
          {modelByCost.length === 0 ? (
            <p className="text-xs text-zinc-600 dark:text-zinc-500">{t('dashboard.modelCostEmpty')}</p>
          ) : (
            <div className="space-y-3">
              {modelByCost.map(m => (
                <div key={m.model}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-mono text-zinc-700 dark:text-zinc-300 truncate max-w-[140px]" title={m.model}>{m.model}</span>
                    <span className="text-xs text-emerald-600 dark:text-emerald-400 shrink-0 ml-2">{fmtCost(m.cost_usd)}</span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden bg-black/[0.06] dark:bg-white/[0.08]">
                    <div className="h-full rounded-full transition-[width] duration-200 ease-out bg-emerald-500"
                      style={{ width: `${Math.round((m.cost_usd||0) / maxModelCost * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
