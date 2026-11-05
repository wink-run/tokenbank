import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { useAuth } from '../store/index';
import { useLang } from '../store/lang';
import { useCurrency } from '../store/currency';
import { getTransactions, checkin, getCheckinStatus, getPurchaseOrders, createPurchaseOrder, spin, getSpinStatus, getUserDevices, deleteDevice, getInventoryStats, getProviderCatalog } from '../api/client';
import UserAccountsPanel from '../components/UserAccountsPanel';
import { billingAccountsFromDevices } from '../lib/accountsSummary';
import { enrichBillingCost, resolveBillableSubscriptions } from '../utils/billing-cost';
import { loadUserAccounts } from '../api/userAccounts';
import { formatDeviceTitle, formatLegacyPlatform, effectiveDeviceType } from '../lib/device-display';
import { isAppIcon, appIconSvg } from '../lib/appIcons';

/** 从云端拉取各设备聚合盘点；失败时回退本机数据，并合并订阅折算 + 按量费用 */
async function fetchDashboardStats(days) {
  let raw = null;
  try {
    const r = await getInventoryStats(days);
    if (r.data) raw = { ...r.data, source: 'cloud' };
  } catch {
    // 未登录或云端不可用时回退
  }
  if (!raw) {
    if (window.electronAPI?.localStats) {
      const local = await window.electronAPI.localStats.query(days);
      raw = { ...local, source: 'local', devices: [] };
    } else {
      const r = await fetch(`/api/local-stats?days=${days}`);
      if (!r.ok) throw new Error(`local-stats ${r.status}`);
      const local = await r.json();
      raw = { ...local, source: 'local', devices: [] };
    }
  }

  let payg = [];
  let catalog = [];
  try {
    const acct = await loadUserAccounts();
    catalog = acct.subscription_catalog || [];
    // 云端：各设备上报摘要按 config_fp 去重后计订阅/按量费用，避免同配置重复计费
    if (raw.source === 'cloud' && (raw.devices || []).length) {
      const cloudAcct = billingAccountsFromDevices(raw.devices, formatDeviceTitle);
      payg = cloudAcct.user_payg_providers || [];
      return enrichBillingCost(raw, resolveBillableSubscriptions(cloudAcct), payg, days, catalog);
    }
    payg = acct.user_payg_providers || [];
    return enrichBillingCost(raw, resolveBillableSubscriptions(acct), payg, days, catalog);
  } catch { /* 无账户配置时仅显示按量 token 费用 */ }

  return enrichBillingCost(raw, [], payg, days, catalog);
}

// 颜色 palette，按 provider id hash 分配，避免写死 provider 列表
const BAR_PALETTE = [
  'bg-blue-500','bg-emerald-500','bg-violet-500','bg-orange-500','bg-rose-500',
  'bg-teal-500','bg-amber-500','bg-cyan-500','bg-fuchsia-500','bg-lime-500',
];
function providerBarBg(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BAR_PALETTE[h % BAR_PALETTE.length];
}
// 运行时由 catalog 填充，避免写死
let _catalogMeta = {};
function getProviderMeta(id, t) {
  const c = _catalogMeta[id];
  return { bg: providerBarBg(id), label: c?.label || providerLabel(id, t), type: c?.type || 'paid' };
}

const ORDER_STATUS_KEYS = { pending: 'profile.order.pending', approved: 'profile.order.approved', rejected: 'profile.order.rejected' };

const RANGE_KEYS = ['today', '7d', '30d'];
const RANGE_DAYS = { today: 1, '7d': 7, '30d': 30 };

/** 个人页统一卡片与分段控件（与 Dashboard zinc 体系一致） */
const PROFILE_CARD = 'tb-soft-card rounded-2xl';
const RANGE_PILL_WRAP = 'tb-glass-chip flex gap-0.5 rounded-lg p-0.5 shrink-0';
const rangePillClass = (active) => active
  ? 'px-2.5 py-1 text-xs rounded-md bg-white/80 dark:bg-white/10 text-zinc-900 dark:text-zinc-100 font-semibold shadow-sm transition-colors'
  : 'px-2.5 py-1 text-xs rounded-md text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors';

/** 工具来源展示名 */
function sourceLabel(source, t) {
  if (!source) return t('profile.unknown');
  const key = `profile.source.${source}`;
  if (t(key) !== key) return t(key);
  if (source.startsWith('session-')) {
    const name = source.slice('session-'.length).replace(/-/g, ' ');
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return source;
}

/** 供给源展示名 */
function providerLabel(id, t) {
  if (!id) return t('profile.unknown');
  const i18nKey = `profile.provider.${id}`;
  if (t(i18nKey) !== i18nKey) return t(i18nKey);
  if (_catalogMeta[id]?.label) return _catalogMeta[id].label;
  if (id === 'cursor') return 'Cursor';
  if (id === 'claude-cli') return 'Claude CLI';
  if (id === 'codex-cli') return 'Codex CLI';
  if (id.startsWith('custom-')) return `${t('accounts.custom')} ${id.slice(7, 15)}…`;
  return id;
}

/** 按筛选端取分布数据（全部 / 单端） */
function pickDistData(localData, devices, filterId) {
  if (!filterId || filterId === 'all') {
    return {
      agent_sources: localData?.agent_sources || [],
      app_usage: localData?.app_usage || [],
      providers: localData?.providers || [],
      models: localData?.models || [],
      total_calls: localData?.total_calls || 0,
      scopeLabelKey: 'all',
      scopeName: '',
    };
  }
  const dev = (devices || []).find(d => d.device_id === filterId);
  if (!dev) {
    return { agent_sources: [], app_usage: [], providers: [], models: [], total_calls: 0, scopeLabelKey: '', scopeName: '' };
  }
  return {
    agent_sources: dev.agent_sources || dev.top_sources || [],
    app_usage: dev.app_usage || [],
    providers: dev.providers || dev.top_providers || [],
    models: dev.models || dev.top_models || [],
    total_calls: dev.calls || 0,
    scopeLabelKey: 'device',
    scopeName: formatDeviceTitle(dev),
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

const SESSION_PROVIDERS = new Set([
  'claude-cli', 'cursor', 'codex-cli', 'opencode-cli',
  'github-copilot', 'qwen-cli', 'antigravity', 'grok',
]);

function ProviderBar({ id, calls, totalCalls, tier }) {
  const { t } = useLang();
  const meta  = getProviderMeta(id, t);
  const pct   = totalCalls > 0 ? (calls / totalCalls) * 100 : 0;
  const isDirect = SESSION_PROVIDERS.has(id);
  const type  = isDirect ? 'direct' : (tier || meta.type || 'paid');
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="w-28 shrink-0 text-xs text-zinc-600 dark:text-zinc-400 truncate" title={id}>{meta.label}</div>
      <div className="flex-1 bg-zinc-100 dark:bg-zinc-700 rounded-full h-2 overflow-hidden">
        <div className={`h-2 rounded-full ${meta.bg}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="shrink-0 text-right whitespace-nowrap pl-2">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{calls} {t('profile.times')} {Math.round(pct)}%</span>
      </div>
      <span className={`shrink-0 text-xs px-1.5 py-0.5 rounded-full ${
        type === 'free'   ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' :
        type === 'p2p'    ? 'bg-blue-100  dark:bg-blue-900/30  text-blue-700  dark:text-blue-400'  :
        type === 'direct' ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400' :
                            'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-400'
      }`}>
        {type === 'free' ? t('profile.tier.free') : type === 'p2p' ? t('profile.tier.p2p') : type === 'direct' ? t('profile.tier.direct') : t('profile.tier.paid')}
      </span>
    </div>
  );
}

function CheckinCard({ onSuccess }) {
  const { t } = useLang();
  const [status,   setStatus]   = useState(null);
  const [checking, setChecking] = useState(false);
  const [msg,      setMsg]      = useState('');

  useEffect(() => { getCheckinStatus().then(r => setStatus(r.data)).catch(() => {}); }, []);

  async function handleCheckin() {
    setChecking(true); setMsg('');
    try {
      const r = await checkin();
      setMsg(`+${r.data.credits} ${t('credits.unit')}`);
      setStatus(s => ({ ...s, checked_in_today: true }));
      onSuccess?.();
    } catch (e) { setMsg(e.response?.data?.detail || t('profile.checkin.failed')); }
    finally { setChecking(false); }
  }

  const done = status?.checked_in_today;
  return (
    <div className="tb-soft-card rounded-xl px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xl select-none">📅</span>
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('profile.checkin.title')}</p>
      </div>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        {status === null ? t('profile.checkin.loading') : done ? t('profile.checkin.done', { n: status.credits_today }) : t('profile.checkin.reward', { n: status.reward })}
      </p>
      {msg && <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</span>}
      <button onClick={handleCheckin} disabled={checking || done}
        className={`py-1.5 rounded-lg text-sm font-medium transition-colors ${done ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-400 cursor-default' : 'bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 text-white'} disabled:opacity-60`}>
        {checking ? t('profile.checkin.checking') : done ? t('profile.checkin.doneBtn') : t('profile.checkin.btn')}
      </button>
    </div>
  );
}

function SpinCard({ onSuccess }) {
  const { t } = useLang();
  const [status,  setStatus]  = useState(null);
  const [spinning,setSpinning]= useState(false);
  const [msg,     setMsg]     = useState('');

  useEffect(() => { getSpinStatus().then(r => setStatus(r.data)).catch(() => {}); }, []);

  async function handleSpin() {
    if (spinning || status?.spins_left === 0) return;
    setSpinning(true); setMsg('');
    try {
      const r = await spin();
      setMsg(`+${r.data.credits} ${t('credits.unit')}`);
      setStatus(s => ({ ...s, spins_left: r.data.spins_left }));
      onSuccess?.();
    } catch (e) { setMsg(e.response?.data?.detail || t('profile.spin.failed')); }
    finally { setSpinning(false); }
  }

  const exhausted = status?.spins_left === 0;
  return (
    <div className="tb-soft-card rounded-xl px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xl select-none">🎡</span>
        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">{t('profile.spin.title')}</p>
      </div>
      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        {status === null ? t('profile.checkin.loading') : exhausted ? t('profile.spin.exhausted') : t('profile.spin.left', { n: status.spins_left })}
      </p>
      {msg && <span className={`text-xs font-medium ${msg.startsWith('+') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</span>}
      <button onClick={handleSpin} disabled={spinning || exhausted || !status}
        className={`py-1.5 rounded-lg text-sm font-medium transition-colors ${exhausted ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-400 cursor-default' : 'bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 text-white'} disabled:opacity-60`}>
        {spinning ? t('profile.spin.spinning') : exhausted ? t('profile.spin.tomorrow') : t('profile.spin.btn')}
      </button>
    </div>
  );
}

const DEVICE_ICON = { desktop: '💻', cli: '🖥' };
const DEVICE_PIE_COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4'];

/** Token 数量：>=100万显示 M，>=1000 显示 K */
function fmtNum(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** 全部设备：各端调用 / Token / 费用占比饼图 */
function DeviceSharePies({ devices, rangeLabel }) {
  const { t } = useLang();
  const { fmtCost } = useCurrency();
  const list = devices || [];
  const hasAny = list.some(d => (d.calls || 0) > 0 || (d.tokens || 0) > 0 || (d.cost || 0) > 0);
  if (!hasAny) return null;

  function PieBlock({ title, dataKey, formatValue }) {
    const data = list
      .filter(d => (d[dataKey] || 0) > 0)
      .map(d => ({ id: d.device_id, name: formatDeviceTitle(d), value: d[dataKey] }));
    if (data.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[200px] text-xs text-zinc-400">
          <p className="font-medium text-zinc-500 dark:text-zinc-400 mb-1">{title}</p>
          <p>{t('profile.noData')}</p>
        </div>
      );
    }
    const total = data.reduce((s, x) => s + x.value, 0);

    return (
      <div className="flex flex-col">
        <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300 mb-2 text-center">{title}</p>
        <ResponsiveContainer width="100%" height={160}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={36}
              outerRadius={64}
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="none"
            >
              {data.map((entry, i) => (
                <Cell key={entry.id} fill={DEVICE_PIE_COLORS[i % DEVICE_PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v, _n, props) => {
                const pct = total > 0 ? Math.round(v / total * 100) : 0;
                const val = formatValue ? formatValue(v) : v;
                return [`${val} (${pct}%)`, props.payload.name];
              }}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-1 mt-1">
          {data.map((d, i) => (
            <div key={d.id} className="flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: DEVICE_PIE_COLORS[i % DEVICE_PIE_COLORS.length] }} />
                <span className="truncate" title={d.name}>{d.name}</span>
              </span>
              <span className="shrink-0 tabular-nums">{Math.round(d.value / total * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className={`${PROFILE_CARD} p-5 space-y-4`}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{t('profile.deviceShare')}</h2>
        <span className="text-xs text-zinc-400">{t('profile.allDevicesTotal')} · {rangeLabel}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <PieBlock title={t('profile.callsShare')} dataKey="calls" formatValue={fmtNum} />
        <PieBlock title={t('profile.tokensShare')} dataKey="tokens" formatValue={fmtNum} />
        <PieBlock
          title={t('profile.costShare')}
          dataKey="cost"
          formatValue={fmtCost}
        />
      </div>
    </section>
  );
}

// ── 用量分布（工具 / 供给 / 模型），支持按端筛选 ─────────────────────────────
function UsageDistributionPanel({ localData, devices, rangeLabel, filterId, onFilterChange }) {
  const { t } = useLang();
  const dist = pickDistData(localData, devices, filterId);
  const { agent_sources, app_usage, providers, models, total_calls, scopeLabelKey, scopeName } = dist;
  const scopeLabel = scopeLabelKey === 'all' ? t('profile.allDevicesTotal') : scopeName;

  const providerEntries = [...providers].sort((a, b) => b.calls - a.calls);
  const modelList = [...models].sort((a, b) => b.calls - a.calls);
  const hasDevices = (devices || []).length > 0;

  return (
    <div className="space-y-4">
      {/* 按端筛选 */}
      {hasDevices && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => onFilterChange('all')}
            className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
              filterId === 'all'
                ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-medium'
                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
            }`}>
            {t('profile.allDevices')}
          </button>
          {(devices || []).map(d => (
            <button key={d.device_id} type="button" onClick={() => onFilterChange(d.device_id)}
              className={`px-2.5 py-1 text-xs rounded-lg transition-colors truncate max-w-[140px] ${
                filterId === d.device_id
                  ? 'bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-medium'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
              }`}
              title={formatDeviceTitle(d)}>
              {DEVICE_ICON[effectiveDeviceType(d)] || '🖥'} {formatDeviceTitle(d)}
            </button>
          ))}
        </div>
      )}

      {/* 全部设备：各端占比饼图 */}
      {filterId === 'all' && hasDevices && (
        <DeviceSharePies devices={devices} rangeLabel={rangeLabel} />
      )}

      {/* 应用用量分布（按应用聚合：网关实时 + 会话补录合并，徽章区分 网关/订阅/混合）*/}
      {(app_usage?.length > 0 || agent_sources?.length > 0) && (
        <section className={`${PROFILE_CARD} p-5 space-y-3`}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{t('profile.appUsage')}</h2>
            <span className="text-xs text-zinc-400">{scopeLabel} · {rangeLabel}</span>
          </div>
          <DistBarList
            items={(app_usage?.length > 0 ? app_usage : agent_sources).map(s => {
              // app_usage：按应用聚合，含 proxy/session 拆分；agent_sources：按来源（旧/设备视图）回退
              const isApp = s.id != null;
              const proxy = isApp ? (s.proxyCalls || 0) : (s.source === 'proxy' ? s.calls : 0);
              const session = isApp ? (s.sessionCalls || 0) : (s.source === 'proxy' ? 0 : s.calls);
              const tier = proxy > 0 && session > 0 ? 'both' : proxy > 0 ? 'proxy' : 'direct';
              return {
                key: isApp ? s.id : s.source,
                label: isApp ? (
                  <span className="inline-flex items-center gap-1 min-w-0">
                    {isAppIcon(s.icon) ? appIconSvg(s.icon, 'w-3.5 h-3.5 shrink-0') : <span className="shrink-0">{s.icon || '🔧'}</span>}
                    <span className="truncate">{s.name}</span>
                  </span>
                ) : sourceLabel(s.source, t),
                title: isApp ? s.name : s.source,
                calls: s.calls,
                tier,
              };
            })}
            total={total_calls}
            barClass="bg-emerald-400"
          />
        </section>
      )}

      {/* 供给来源 */}
      <section className={`${PROFILE_CARD} p-5 space-y-3`}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{t('profile.providerUsage')}</h2>
          <span className="text-xs text-zinc-400">{scopeLabel} · {rangeLabel}</span>
        </div>
        {providerEntries.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('profile.noData')}</p>
        ) : (
          <div className="space-y-2.5">
            {providerEntries.map(p => (
              <ProviderBar key={p.id} id={p.id} calls={p.calls} totalCalls={total_calls} tier={p.tier} />
            ))}
          </div>
        )}
      </section>

      {/* 模型使用 */}
      <section className={`${PROFILE_CARD} p-5 space-y-3`}>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">{t('profile.modelUsage')}</h2>
          <span className="text-xs text-zinc-400">{scopeLabel} · {rangeLabel}</span>
        </div>
        {modelList.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('profile.noData')}</p>
        ) : (
          <DistBarList
            items={modelList.slice(0, 8).map(m => ({
              key: m.model,
              label: m.model,
              title: m.model,
              calls: m.calls,
              mono: true,
              tier: m.tier,
            }))}
            total={total_calls}
            barClass="bg-zinc-500 dark:bg-zinc-400"
          />
        )}
      </section>
    </div>
  );
}

/** 通用横向分布条 */
function DistBarList({ items, total, barClass }) {
  const { t } = useLang();
  const maxCalls = Math.max(...items.map(i => i.calls), 1);
  return (
    <div className="space-y-2.5">
      {items.map(item => {
        const barPct = Math.round(item.calls / maxCalls * 100);
        const share  = total > 0 ? Math.round(item.calls / total * 100) : 0;
        const tier   = item.tier;
        const tierBadge = tier === 'both'
          ? <span className="shrink-0 text-xs px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">{t('profile.tier.mixed')}</span>
          : tier === 'proxy'
          ? <span className="shrink-0 text-xs px-1.5 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">{t('profile.tier.gw')}</span>
          : <span className="shrink-0 text-xs px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-700/50 text-zinc-500 dark:text-zinc-400">{t('profile.tier.direct')}</span>;
        return (
          <div key={item.key} className="flex items-center gap-2 text-sm">
            <div
              className={`w-32 shrink-0 text-xs text-zinc-600 dark:text-zinc-400 truncate ${item.mono ? 'font-mono' : ''}`}
              title={item.title || item.label}
            >
              {item.label}
            </div>
            <div className="flex-1 bg-zinc-100 dark:bg-zinc-700 rounded-full h-2 overflow-hidden">
              <div className={`h-2 rounded-full ${barClass} transition-[width] duration-200 ease-out`} style={{ width: `${barPct}%` }} />
            </div>
            <span className="shrink-0 text-right text-xs text-zinc-500 dark:text-zinc-400 whitespace-nowrap pl-1">
              {item.calls} <span className="text-zinc-400">{share}%</span>
            </span>
            {tierBadge}
          </div>
        );
      })}
    </div>
  );
}

// ── 我的设备（简洁列表）────────────────────────────────────────────────────
function DevicesSection() {
  const { t } = useLang();
  const [devices, setDevices] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getUserDevices()
        .then(r => {
          if (!alive) return;
          const raw = r.data?.devices || [];
          const normalised = raw.map(d => ({ ...d, device_id: d.device_id || d.id || null }));
          const seen = new Set();
          const clean = normalised.filter(d => {
            if (!d.device_id || seen.has(d.device_id)) return false;
            seen.add(d.device_id);
            return true;
          });
          setDevices(clean);
        })
        .catch(() => { if (alive) setDevices([]); });
    };
    load();
    // 心跳会改写机器名和系统版本，稍后再拉一次，避免停在旧的 CLI / 10.15.7
    const timer = setTimeout(load, 2500);
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  async function handleRemove(deviceId) {
    try {
      await deleteDevice(deviceId);
      setDevices(prev => prev.filter(d => d.device_id !== deviceId));
    } catch {}
  }

  if (devices === null) return null;
  if (devices.length === 0) return null;

  return (
    <section className={`${PROFILE_CARD} p-5 space-y-3`}>
      <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('profile.devicesTitle')}</h2>
      <div className="space-y-2">
        {devices.map((d, i) => (
          <div key={`${d.device_id ?? ''}-${i}`}
            className="tb-soft-tile flex items-center gap-3 px-3 py-2.5 rounded-xl">
            <span className="text-base select-none shrink-0">{DEVICE_ICON[effectiveDeviceType(d)] || '🖥'}</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${d.online ? 'bg-green-500' : 'bg-zinc-400'}`} />
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{formatDeviceTitle(d)}</span>
                {d.version && <span className="text-xs text-zinc-400 shrink-0">v{d.version}</span>}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-zinc-400 truncate">{formatLegacyPlatform(d.platform)}</span>
                {(d.today_calls > 0 || d.today_errors > 0) && (
                  <span className="text-xs text-zinc-400 shrink-0">
                    {t('profile.todayCalls', { n: d.today_calls })}
                    {d.today_errors > 0 && <span className="text-red-400 ml-1">{t('profile.todayErrors', { n: d.today_errors })}</span>}
                  </span>
                )}
              </div>
            </div>
            <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full ${
              d.online
                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'
            }`}>
              {d.online ? t('profile.online') : t('profile.offline')}
            </span>
            {!d.online && (
              <button onClick={() => handleRemove(d.device_id)}
                className="shrink-0 text-xs text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors px-1">
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TokenDashboard() {
  const { user, guest, refreshUser } = useAuth();
  const { t } = useLang();
  const { fmtCost } = useCurrency();
  const location = useLocation();
  const navigate = useNavigate();
  const accountsTab = location.state?.accountsTab;
  const [txs,      setTxs]      = useState([]);
  const [orders,   setOrders]   = useState([]);
  const [adminInfo,setAdminInfo]= useState('');
  const [contact,  setContact]  = useState('');
  const [note,     setNote]     = useState('');
  const [submitting,setSubmitting]=useState(false);
  const [orderMsg, setOrderMsg] = useState('');
  const [orderMsgOk,setOrderMsgOk]=useState(false);
  const [creditsOpen,setCreditsOpen]=useState(false);
  const [range,       setRange]      = useState('today');
  const [rangeStats,  setRangeStats] = useState({ calls: 0, tokens: 0, free: 0, p2p: 0, paid: 0 });
  const [localData,   setLocalData]  = useState(null);
  const [compStats,   setCompStats]  = useState(null);
  const [dataSource,  setDataSource]  = useState('cloud');
  const [deviceList,  setDeviceList]  = useState([]);
  const [distFilter,  setDistFilter]  = useState('all');
  useEffect(() => {
    if (user) {   // 账号相关数据仅登录时拉取；游客跳过（统计走本地 fetchDashboardStats）
      refreshUser();
      getTransactions().then(r => setTxs(r.data.transactions || [])).catch(() => {});
      getPurchaseOrders().then(r => { setOrders(r.data.orders || []); if (r.data.contact_info) setAdminInfo(String(r.data.contact_info)); }).catch(() => {});
    }
    const loadCatalogMeta = async () => {
      try {
        const api = window.electronAPI?.localConfig;
        const providers = api?.getProviderCatalog
          ? (await api.getProviderCatalog())?.providers
          : (await getProviderCatalog()).data?.providers;
        const map = {};
        for (const p of providers || []) map[p.id] = { label: p.label, type: p.type };
        _catalogMeta = map;
      } catch {}
    };
    loadCatalogMeta();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const days = RANGE_DAYS[range];
    fetchDashboardStats(days).then(data => {
      setLocalData(data);
      setDataSource(data.source || 'cloud');
      setRangeStats({
        calls:  data.total_calls  || 0,
        tokens: data.total_tokens || 0,
        free:   data.tiers?.free  || 0,
        p2p:    data.tiers?.p2p   || 0,
        paid:   data.tiers?.paid  || 0,
      });
      setDeviceList(data.devices || []);
      setDistFilter('all');
      // 压缩比：个人页优先用云端各端汇总（merge 后的 inventory 带 compression）；
      // 云端不可用回退到本机日志。
      if (data.compression) {
        setCompStats(data.compression);
      } else {
        const cp = window.electronAPI?.localStats?.compression
          ? window.electronAPI.localStats.compression(days)
          : fetch(`/api/compression-stats?days=${days}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
        Promise.resolve(cp).then(s => setCompStats(s || null)).catch(() => setCompStats(null));
      }
    }).catch(() => {});
  }, [range]);

  if (!user && !guest) return null;

  const heroTotal   = rangeStats.calls;
  const heroFree    = rangeStats.free;

  const localTotalCalls = localData?.total_calls ?? 0;

  const fmtRangeCalls  = heroTotal >= 1000 ? `${(heroTotal / 1000).toFixed(1)}K` : String(heroTotal);
  const fmtRangeTokens = fmtNum(rangeStats.tokens);
  const deviceCount    = localData?.device_count ?? localData?.devices?.length ?? 0;
  const onlineCount    = (localData?.devices || []).filter(d => d.online).length;

  const rangeLabel = t(`profile.range.${range}`);

  async function handleOrder(e) {
    e.preventDefault();
    if (submitting || !contact.trim()) return;
    setSubmitting(true); setOrderMsg('');
    try {
      const r = await createPurchaseOrder(0, `联系方式：${contact.trim()}${note.trim() ? `；${note.trim()}` : ''}`);
      setOrderMsgOk(true); setOrderMsg(t('profile.purchase.success'));
      if (r.data.contact_info) setAdminInfo(String(r.data.contact_info));
      setOrders(prev => [r.data.order, ...prev]); setContact(''); setNote('');
    } catch (err) {
      setOrderMsgOk(false); setOrderMsg(err.response?.data?.detail || t('profile.purchase.failed'));
    } finally { setSubmitting(false); }
  }

  const subCostStr = localData?.subscription_cost > 0
    ? fmtCost(localData.subscription_cost)
    : ' —';
  const paygCostStr = localData?.payg_cost > 0
    ? fmtCost(localData.payg_cost)
    : ' —';

  return (
    <div className="px-4 py-4 space-y-4">

      {/* Hero */}
      {user ? (
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-zinc-800 dark:bg-zinc-600 flex items-center justify-center text-sm font-bold text-white shrink-0">
          {(user.nickname || user.email || '?')[0].toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[17px] font-bold text-zinc-900 dark:text-zinc-100 tracking-tight leading-tight">{user.nickname}</p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate mt-0.5">{user.email}</p>
        </div>
        {user.credits_balance != null && (
          <div className="shrink-0 flex items-center gap-1.5 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-full px-3 py-1.5">
            <span className="text-sm">💎</span>
            <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-200 tabular-nums">
              {Math.floor(user.credits_balance ?? 0).toLocaleString()}
            </span>
            <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('credits.unit')}</span>
          </div>
        )}
      </div>
      ) : (
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-zinc-200 dark:bg-zinc-700 flex items-center justify-center text-sm shrink-0">👤</div>
        <div className="flex-1 min-w-0">
          <p className="text-[17px] font-bold text-zinc-900 dark:text-zinc-100 tracking-tight leading-tight">{t('profile.guestTitle')}</p>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 truncate mt-0.5">{t('profile.guestSub')}</p>
        </div>
        <button onClick={() => navigate('/login')} className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 text-white transition-colors">{t('profile.guestLogin')}</button>
      </div>
      )}

      {/* 用量总览 */}
      <div className={`${PROFILE_CARD} p-6`}>
        <div className="flex items-center justify-between mb-4 gap-3">
          <p className="text-sm font-medium text-zinc-600 dark:text-zinc-400">{t('profile.overview', { range: rangeLabel })}</p>
          <div className={RANGE_PILL_WRAP}>
            {RANGE_KEYS.map(r => (
              <button key={r} type="button" onClick={() => setRange(r)} className={rangePillClass(range === r)}>
                {t(`profile.range.${r}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t('profile.calls')}</p>
            <p className="text-3xl sm:text-4xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">{fmtRangeCalls}</p>
            {heroTotal > 0 && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                {t('profile.freeBreakdown', {
                  free: heroFree,
                  pct: Math.round(heroFree / heroTotal * 100),
                  p2p: rangeStats.p2p,
                  paid: rangeStats.paid,
                })}
              </p>
            )}
            {deviceCount > 0 && (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
                {onlineCount > 0
                  ? t('profile.devicesOnline', { count: deviceCount, online: onlineCount })
                  : t('profile.devicesCount', { count: deviceCount })}
              </p>
            )}
          </div>
          <div className="border-l border-zinc-200 dark:border-zinc-800 pl-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t('profile.tokens')}</p>
            <p className="text-3xl sm:text-4xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">{fmtRangeTokens}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
              {dataSource === 'cloud'
                ? t('profile.cloudTotal', { range: rangeLabel })
                : t('profile.localTotal', { range: rangeLabel })}
            </p>
          </div>
          <div className="border-l border-zinc-200 dark:border-zinc-800 pl-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">{t('profile.cost')}</p>
            <p className="text-3xl sm:text-4xl font-bold text-zinc-900 dark:text-zinc-100 font-mono tabular-nums">
              {localData?.total_cost > 0
                ? fmtCost(localData.total_cost)
                : '—'}
            </p>
            {localData?.total_cost > 0 && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                {t('profile.costSub', { sub: subCostStr, payg: paygCostStr })}
              </p>
            )}
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">{t('profile.costEstimate')}</p>
          </div>
        </div>
      </div>

      {/* 我的设备（仅登录） */}
      {user && <DevicesSection />}

      {/* 三类账户：积分 / 订阅 / 按量付费（仅登录） */}
      {user && (
      <UserAccountsPanel
        initialTab={accountsTab === 'subscription' || accountsTab === 'payg' ? accountsTab : 'p2p'}
        user={user}
        txs={txs}
        creditsOpen={creditsOpen}
        onCreditsToggle={() => setCreditsOpen(v => !v)}
        onRefreshUser={refreshUser}
        CheckinCard={CheckinCard}
        SpinCard={SpinCard}
        purchaseForm={(
          <div className="border-t border-zinc-100 dark:border-zinc-700 pt-4 space-y-3">
            <h3 className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{t('profile.purchase.title')}</h3>
            <form onSubmit={handleOrder} className="space-y-2">
              <input value={contact} onChange={e => setContact(e.target.value)} placeholder={t('profile.purchase.contact')} required
                className="w-full bg-zinc-100 dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-900 dark:focus:border-zinc-100 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400" />
              <input value={note} onChange={e => setNote(e.target.value)} placeholder={t('profile.purchase.note')}
                className="w-full bg-zinc-100 dark:bg-zinc-700 border border-zinc-200 dark:border-zinc-600 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-zinc-900 dark:focus:border-zinc-100 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400" />
              <button type="submit" disabled={submitting || !contact.trim()}
                className="w-full py-2 rounded-lg text-sm font-medium bg-zinc-900 hover:bg-zinc-800 dark:bg-zinc-100 dark:hover:bg-white dark:text-zinc-900 disabled:opacity-50 text-white">
                {submitting ? t('profile.purchase.submitting') : t('profile.purchase.submit')}
              </button>
            </form>
            {orderMsg && <p className={`text-sm ${orderMsgOk ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{orderMsg}</p>}
            {adminInfo && <div className="text-xs text-zinc-600 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-900 rounded-lg px-3 py-2 whitespace-pre-wrap">{adminInfo}</div>}
          </div>
        )}
      />
      )}

      {/* 用量分布：工具 / 供给 / 模型（可按端筛选） */}
      <UsageDistributionPanel
        localData={localData}
        devices={deviceList.length ? deviceList : localData?.devices}
        rangeLabel={rangeLabel}
        filterId={distFilter}
        onFilterChange={setDistFilter}
      />

      {/* 压缩节省（无损 JSON 压缩） */}
      {compStats && (
        <div className={`${PROFILE_CARD} p-5`}>
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('profile.compression.title')}</h2>
          </div>
          {compStats.count > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">{t('profile.compression.requests')}</p>
                <p className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{compStats.count}</p>
              </div>
              <div className="border-l border-zinc-200/70 dark:border-zinc-700/70 pl-4">
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">{t('profile.compression.saved')}</p>
                <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
                  {fmtNum(compStats.saved)}
                </p>
              </div>
              <div className="border-l border-zinc-200/70 dark:border-zinc-700/70 pl-4">
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">{t('profile.compression.savedCost')}</p>
                <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{fmtCost(compStats.saved_usd || 0)}</p>
              </div>
              <div className="border-l border-zinc-200/70 dark:border-zinc-700/70 pl-4">
                <p className="text-xs text-zinc-400 dark:text-zinc-500 mb-1">{t('profile.compression.ratio')}</p>
                <p className="text-2xl font-bold text-zinc-800 dark:text-zinc-100">{(compStats.ratio * 100).toFixed(1)}%</p>
              </div>
            </div>
          ) : (
            <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('profile.compression.empty')}</p>
          )}
        </div>
      )}


    </div>
  );
}
