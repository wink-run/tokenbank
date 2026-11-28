// client/src/components/DeviceConnectionMap.jsx
// 设置页「我的设备」：一张图里看全我的设备和它们现在怎么连的（不再另外列一份设备列表）。
//   左边是这台电脑，右边一行一台设备（卡片里带名字、系统、设备号、改名 / 移除），
//   中间的线和标签写这台电脑到它现在怎么连：
//   直连画绿色实线（局域网 / Tailscale / IPv6 / 公网 + 延迟），经中转画紫色虚线（官方中继 / 经我另一台设备），
//   在线但没连上设备网络、本机没开设备网络画橙色点线，离线画灰色点线。
// 设备是账号下的那份；连接状态来自设备网络的 /v1/devices（connection、addr_kind、via、rtt_ms），每 10 秒刷新。
import React, { useState } from 'react';
import { useLang } from '../store/lang';
import { useMeshDevices } from '../api/meshDevices';

const ROW = 76;          // 每台设备一行的高度（卡片高度固定，线才对得上）
const LINK_W = 72;       // 这台电脑到标签之间画曲线的宽度
const ADDR = { lan: 'lan', tailscale: 'tailscale', ipv6: 'ipv6', public: 'public' };
const norm = (x) => String(x || '').trim().toLowerCase();
/** 离线超过这么多天的收起来（重装、重建留下的旧记录），可以一键清理 */
const STALE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;
function lastSeenMs(d) {
  const v = d?.last_seen || d?.last_heartbeat || d?.last_seen_at || null;
  if (!v) return 0;
  const n = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

/** 连接图还没拿到设备或通路时占位：左边这台电脑、中间虚线、右边一台设备，中间转圈 */
export function DeviceConnectionMapLoading() {
  const { t } = useLang();
  return (
    <div className="relative flex items-center min-w-0 min-h-[76px]" role="status" aria-live="polite">
      <div className="shrink-0 w-56 sm:w-64 h-[60px] rounded-xl bg-zinc-100 dark:bg-zinc-800/80 animate-pulse" />
      <svg className="hidden sm:block shrink-0 text-zinc-300 dark:text-zinc-600" width="72" height="76" aria-hidden>
        <path d="M 0 38 C 40 38, 32 22, 72 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="4 4" strokeLinecap="round">
          <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="0.8s" repeatCount="indefinite" />
        </path>
        <path d="M 0 38 C 40 38, 32 54, 72 54" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="4 4" strokeLinecap="round">
          <animate attributeName="stroke-dashoffset" from="0" to="-16" dur="0.8s" repeatCount="indefinite" />
        </path>
      </svg>
      <div className="hidden sm:block flex-1 h-[60px] ml-2 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 animate-pulse" />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="inline-flex items-center gap-2 rounded-full bg-white/90 dark:bg-zinc-900/90 px-3 py-1 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="w-4 h-4 border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin" aria-hidden />
          {t('profile.conn.loading')}
        </span>
      </div>
    </div>
  );
}

const TONE = {
  direct: { line: 'stroke-emerald-500', dash: undefined, pill: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800', bar: 'border-emerald-500 border-solid' },
  relay: { line: 'stroke-violet-400', dash: '6 5', pill: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:border-violet-800', bar: 'border-violet-400 border-dashed' },
  warn: { line: 'stroke-amber-300 dark:stroke-amber-700', dash: '2 5', pill: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800', bar: 'border-amber-300 dark:border-amber-700 border-dotted' },
  off: { line: 'stroke-zinc-300 dark:stroke-zinc-600', dash: '2 5', pill: 'bg-zinc-50 text-zinc-400 border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700', bar: 'border-zinc-300 dark:border-zinc-600 border-dotted' },
};

/**
 * @param {{ devices: object[], isSelf: (d) => boolean, titleOf: (d) => string,
 *   renderSelf: (selfDevice: object|null, info: { serving: number }) => React.ReactNode,
 *   renderCard: (row: { key, device, title, online, kind }) => React.ReactNode }} props
 */
export default function DeviceConnectionMap({ devices = [], isSelf = () => false, titleOf = (d) => d.name || d.device_id, renderSelf, renderCard, onCleanStale }) {
  const { t } = useLang();
  const mesh = useMeshDevices();
  const [why, setWhy] = useState('');          // 点开了哪一行「为什么没连上」
  const [showStale, setShowStale] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  // 设备网络的通路还没回来：先出加载图，避免线闪成「没连上」再改口
  if (mesh.loading) return <DeviceConnectionMapLoading />;
  const meshOthers = mesh.others || [];
  const self = mesh.self;

  // 认这台电脑：先按设备号（isSelf），认不出时按设备网络里本机的名字
  const selfNames = new Set([self?.label, self?.name, ...(self?.aliases || [])].filter(Boolean).map(norm));
  const selfAcc = devices.find(isSelf) || (selfNames.size ? devices.find((d) => selfNames.has(norm(titleOf(d))) || selfNames.has(norm(d.name))) : null);
  const isMe = (d) => (selfAcc ? d === selfAcc : isSelf(d));

  // 账号设备对上设备网络里的那台：按设备号，对不上再按名字
  const meshOf = (d) => {
    const ids = new Set((d.device_ids?.length ? d.device_ids : [d.device_id]).filter(Boolean).map(String));
    const names = new Set([titleOf(d), d.name, d.hostname].filter(Boolean).map(norm));
    return meshOthers.find((m) => ids.has(String(m.device_id)))
      || meshOthers.find((m) => names.has(norm(m.label)) || names.has(norm(m.name)) || (m.aliases || []).some((a) => names.has(norm(a))));
  };
  const used = new Set();
  const rows = devices.filter((d) => !isMe(d)).map((d) => {
    const m = meshOf(d);
    if (m) used.add(m.device_id);
    return { key: d.device_id, device: d, title: titleOf(d), online: !!d.online || !!m?.online, m };
  });
  // 设备网络里有、账号列表里还没有的（还没同步上来）也画上
  for (const m of meshOthers) if (!used.has(m.device_id)) rows.push({ key: `mesh-${m.device_id}`, device: null, title: m.label || m.name || m.device_id, online: !!m.online, m });
  rows.sort((a, b) => (b.online - a.online) || a.title.localeCompare(b.title));
  // 很久没出现的收起来：离线、最后一次在线超过 STALE_DAYS 天
  const now = Date.now();
  const isStale = (r) => !r.online && r.device && lastSeenMs(r.device) && now - lastSeenMs(r.device) > STALE_DAYS * DAY;
  const stale = rows.filter(isStale);
  const shown = showStale ? rows : rows.filter((r) => !isStale(r));

  const kindOf = (r) => {
    const m = r.m;
    if (m && m.online && m.connection === 'direct') return 'direct';
    if (m && m.online && m.connection === 'relay') return m.via?.kind === 'official' ? 'official' : 'device';
    if (!r.online) return 'offline';
    if (!mesh.enabled) return 'meshOff';
    // 开关是开的，节点还在连（Docker 走官方中继，不靠容器里的局域网地址）
    if (mesh.ready === false) return 'starting';
    return 'notConnected';
  };
  const rtt = (r) => (Number.isFinite(r.m?.rtt_ms) ? ` · ${Math.round(r.m.rtt_ms)}ms` : '');
  const label = (r, k) => (k === 'direct' ? `${t(`profile.conn.addr.${ADDR[r.m?.addr_kind] || 'lan'}`)}${rtt(r)}`
    : k === 'official' ? `${t('profile.conn.official')}${rtt(r)}`
      : k === 'device' ? `${t('profile.conn.viaDevice', { name: r.m?.via?.label || r.m?.via?.device_id || '?' })}${rtt(r)}`
        : k === 'offline' ? t('profile.conn.offline')
          : k === 'meshOff' ? t('profile.conn.meshOff')
            : k === 'starting' ? t('profile.conn.starting') : t('profile.conn.notConnected'));
  const toneOf = (k) => (k === 'direct' ? 'direct' : k === 'official' || k === 'device' ? 'relay' : k === 'offline' ? 'off' : 'warn');
  const serving = Number(self?.relay?.sessions) || 0;

  const H = Math.max(shown.length, 1) * ROW;
  const ySelf = H / 2;

  /** 为什么没连上：一条条写出来（试过哪些路、各卡在哪） */
  const reasonsOf = (r, k) => {
    const out = [];
    if (k === 'offline') {
      const ms = lastSeenMs(r.device);
      out.push(ms ? t('profile.conn.whyOfflineSince', { when: new Date(ms).toLocaleString() }) : t('profile.conn.whyOffline'));
      return out;
    }
    if (k === 'meshOff') { out.push(t('profile.conn.whyMeshOff')); return out; }
    if (k === 'starting') { out.push(mesh.error || t('profile.conn.whyStarting')); return out; }
    const d = r.m?.diag || (mesh.unreached || []).find((u) => (u.device_id && r.m && u.device_id === r.m.device_id) || norm(u.name) === norm(r.title)) || null;
    if (!r.m && !d) out.push(t('profile.conn.whyNotInMesh'));
    if (d?.waiting) out.push(t('profile.conn.whyWaiting'));
    for (const a of d?.attempts || []) out.push(a.ok ? t('profile.conn.whyTriedOk', { addr: a.addr }) : t('profile.conn.whyTried', { addr: a.addr, error: a.error }));
    if (d && !(d.attempts || []).length && !d.waiting) out.push(t('profile.conn.whyNoAddr'));
    const off = mesh.official;
    // 已有自己的中继时，官方中继连不上不代表这条路走不通
    const ownRelay = (mesh.relay && mesh.relay.using && mesh.relay.using !== 'official')
      || (mesh.devices || []).some((x) => x.relay?.enabled);
    if (!ownRelay && off && off.configured && !off.connected) out.push(t('profile.conn.whyOfficialDown'));
    else if (!ownRelay && off && off.connected && d && !d.on_official) out.push(t('profile.conn.whyNotOnOfficial'));
    return out.length ? out : [t('profile.conn.whyUnknown')];
  };
  const whyRow = shown.find((r) => r.key === why);
  return (
    <div className="space-y-2 min-w-0">
    <div className="flex items-stretch min-w-0">
      {/* 这台电脑 */}
      <div className="shrink-0 w-56 sm:w-64 flex items-center" style={{ minHeight: ROW }}>
        <div className="w-full">{renderSelf?.(selfAcc || null, { serving })}</div>
      </div>
      {shown.length === 0 ? (
        <div className="flex items-center pl-4 text-xs text-zinc-400 dark:text-zinc-500">{t('profile.conn.empty')}</div>
      ) : (
        <>
          {/* 从这台电脑散开的线 */}
          <svg className="hidden sm:block shrink-0" width={LINK_W} height={H} viewBox={`0 0 ${LINK_W} ${H}`} aria-hidden>
            {shown.map((r, i) => {
              const y = i * ROW + ROW / 2;
              const tone = TONE[toneOf(kindOf(r))];
              return <path key={r.key} d={`M 0 ${ySelf} C ${LINK_W * 0.55} ${ySelf}, ${LINK_W * 0.45} ${y}, ${LINK_W} ${y}`} fill="none" className={`${tone.line} stroke-[1.6]`} strokeDasharray={tone.dash} strokeLinecap="round" />;
            })}
          </svg>
          {/* 每台设备一行：怎么连的 —— 设备卡片 */}
          <div className="flex-1 min-w-0 pl-2 sm:pl-0">
            {shown.map((r) => {
              const k = kindOf(r);
              const tone = TONE[toneOf(k)];
              const canWhy = k === 'notConnected' || k === 'offline' || k === 'meshOff' || k === 'starting';
              return (
                <div key={r.key} className="flex items-center min-w-0" style={{ height: ROW }}>
                  {/* 标签列定宽：右边卡片对齐；标签两侧的线补满 */}
                  <span className="shrink-0 w-48 flex items-center">
                    <span className={`hidden sm:block flex-1 border-t-[1.6px] ${tone.bar}`} aria-hidden />
                    {canWhy ? (
                      <button type="button" onClick={() => setWhy(why === r.key ? '' : r.key)} aria-expanded={why === r.key}
                        title={t('profile.conn.whyTitle')}
                        className={`shrink-0 text-[11px] whitespace-nowrap px-2.5 py-0.5 rounded-full border ${tone.pill} hover:brightness-95`}>
                        {label(r, k)} <span className="opacity-60">?</span>
                      </button>
                    ) : (
                      <span className={`shrink-0 text-[11px] whitespace-nowrap px-2.5 py-0.5 rounded-full border ${tone.pill}`}>{label(r, k)}</span>
                    )}
                    <span className={`hidden sm:block flex-1 border-t-[1.6px] ${tone.bar}`} aria-hidden />
                  </span>
                  <span className={`hidden sm:block w-4 shrink-0 border-t-[1.6px] ${tone.bar}`} aria-hidden />
                  <div className="flex-1 min-w-0 ml-2 sm:ml-0">{renderCard?.({ ...r, kind: k })}</div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
    {whyRow && (
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 px-3 py-2 space-y-1">
        <p className="m-0 text-xs font-medium text-zinc-700 dark:text-zinc-200">{t('profile.conn.whyOf', { name: whyRow.title })}</p>
        <ul className="m-0 pl-4 space-y-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
          {reasonsOf(whyRow, kindOf(whyRow)).map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </div>
    )}
    {stale.length > 0 && (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span>{t('profile.conn.stale', { n: stale.length, names: stale.slice(0, 3).map((r) => r.title).join('、'), days: Math.max(...stale.map((r) => Math.floor((now - lastSeenMs(r.device)) / DAY))) })}</span>
        <button type="button" onClick={() => setShowStale((v) => !v)} className="text-blue-600 dark:text-blue-400 hover:underline">
          {showStale ? t('profile.conn.staleHide') : t('profile.conn.staleShow')}
        </button>
        {onCleanStale && (
          <button type="button" disabled={cleaning}
            onClick={async () => { setCleaning(true); try { await onCleanStale(stale.map((r) => r.device)); } finally { setCleaning(false); } }}
            className="text-red-500 hover:underline disabled:opacity-50">
            {cleaning ? t('profile.conn.staleCleaning') : t('profile.conn.staleClean')}
          </button>
        )}
      </div>
    )}
    </div>
  );
}
