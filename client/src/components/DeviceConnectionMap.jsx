// client/src/components/DeviceConnectionMap.jsx
// 设置页「我的设备」里的连接图：这台电脑到我的每台设备现在怎么连的。
//   左边是这台电脑，右边是其他设备；
//   每台设备一行：线从这台电脑散开，到中间和那台设备同一高度，中间的标签写怎么连的——
//   直连画实线（局域网 / Tailscale / IPv6 / 公网 + 延迟），经中转画虚线（官方中继 / 经我另一台设备），离线画灰色点线。
// 设备和下面的设备列表是同一份（账号下的设备），连接状态来自设备网络的 /v1/devices（connection、addr_kind、via、rtt_ms），
// 每 10 秒刷新。没连上的也画出来并标明：在线但没连上设备网络、离线、本机没开设备网络。
import React from 'react';
import { useLang } from '../store/lang';
import { useMeshDevices } from '../api/meshDevices';

const W = 640;
const ROW = 58;
const PAD = 24;
const X_SELF = 92;
const X_MID = 320;
const X_DEV = 548;

const ADDR = { lan: 'lan', tailscale: 'tailscale', ipv6: 'ipv6', public: 'public' };

function Node({ x, y, title, sub, tone = 'normal', align = 'middle' }) {
  const box = tone === 'self'
    ? 'fill-blue-50 stroke-blue-400 dark:fill-blue-950/60 dark:stroke-blue-500'
    : tone === 'off'
      ? 'fill-zinc-50 stroke-zinc-300 dark:fill-zinc-900 dark:stroke-zinc-700'
      : tone === 'relay'
        ? 'fill-violet-50 stroke-violet-300 dark:fill-violet-950/50 dark:stroke-violet-600'
        : 'fill-white stroke-zinc-300 dark:fill-zinc-800 dark:stroke-zinc-600';
  const w = 150;
  const h = sub ? 40 : 30;
  return (
    <g>
      <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={10} className={`${box} stroke-[1.2]`} />
      <text x={x} y={sub ? y - 3 : y + 4} textAnchor={align} className={`text-[12px] font-medium ${tone === 'off' ? 'fill-zinc-400' : 'fill-zinc-800 dark:fill-zinc-100'}`}>
        {title.length > 16 ? `${title.slice(0, 15)}…` : title}
      </text>
      {sub && (
        <text x={x} y={y + 12} textAnchor={align} className="text-[10px] fill-zinc-500 dark:fill-zinc-400">{sub}</text>
      )}
    </g>
  );
}

function Pill({ x, y, text, tone }) {
  const w = Math.max(56, text.length * 11 + 16);
  const cls = tone === 'direct'
    ? 'fill-emerald-50 stroke-emerald-300 dark:fill-emerald-950/60 dark:stroke-emerald-700'
    : tone === 'relay'
      ? 'fill-violet-50 stroke-violet-300 dark:fill-violet-950/60 dark:stroke-violet-700'
      : tone === 'warn'
        ? 'fill-amber-50 stroke-amber-300 dark:fill-amber-950/50 dark:stroke-amber-700'
        : 'fill-zinc-50 stroke-zinc-200 dark:fill-zinc-900 dark:stroke-zinc-700';
  const tcls = tone === 'direct' ? 'fill-emerald-700 dark:fill-emerald-300'
    : tone === 'relay' ? 'fill-violet-700 dark:fill-violet-300'
      : tone === 'warn' ? 'fill-amber-700 dark:fill-amber-300' : 'fill-zinc-400';
  return (
    <g>
      <rect x={x - w / 2} y={y - 10} width={w} height={20} rx={10} className={`${cls} stroke-1`} />
      <text x={x} y={y + 4} textAnchor="middle" className={`text-[10.5px] ${tcls}`}>{text}</text>
    </g>
  );
}

const norm = (x) => String(x || '').trim().toLowerCase();

/**
 * @param {{ devices: object[], isSelf: (d: object) => boolean, titleOf: (d: object) => string }} props
 *   devices：账号下的设备（和下面的列表同一份）；isSelf：是不是这台电脑；titleOf：显示名
 */
export default function DeviceConnectionMap({ devices = [], isSelf = () => false, titleOf = (d) => d.name || d.device_id }) {
  const { t } = useLang();
  const mesh = useMeshDevices();
  const meshOthers = mesh.others || [];
  // 账号设备对上设备网络里的那台：按设备号，对不上再按名字
  const meshOf = (d) => {
    const ids = new Set((d.device_ids?.length ? d.device_ids : [d.device_id]).filter(Boolean).map(String));
    const names = new Set([titleOf(d), d.name, d.hostname].filter(Boolean).map(norm));
    return meshOthers.find((m) => ids.has(String(m.device_id)))
      || meshOthers.find((m) => names.has(norm(m.label)) || names.has(norm(m.name)) || (m.aliases || []).some((a) => names.has(norm(a))));
  };
  const self = mesh.self;
  // 认这台电脑：先按设备号（isSelf），认不出时按设备网络里本机的名字
  const selfNames = new Set([self?.label, self?.name, ...(self?.aliases || [])].filter(Boolean).map(norm));
  const selfAcc = devices.find(isSelf) || (selfNames.size ? devices.find((d) => selfNames.has(norm(titleOf(d))) || selfNames.has(norm(d.name))) : null);
  const isMe = (d) => (selfAcc ? d === selfAcc : isSelf(d));
  const used = new Set();
  const rows = devices.filter((d) => !isMe(d)).map((d) => {
    const m = meshOf(d);
    if (m) used.add(m.device_id);
    return { key: d.device_id, title: titleOf(d), online: !!d.online || !!m?.online, m };
  });
  // 设备网络里有、账号列表里没有的（比如还没同步上来）也画上
  for (const m of meshOthers) if (!used.has(m.device_id)) rows.push({ key: `mesh-${m.device_id}`, title: m.label || m.name || m.device_id, online: !!m.online, m });
  rows.sort((a, b) => (b.online - a.online) || a.title.localeCompare(b.title));
  if (!rows.length) {
    return <p className="m-0 text-xs text-zinc-400 dark:text-zinc-500">{t('profile.conn.empty')}</p>;
  }
  const others = rows;

  const kindOf = (r) => {
    const m = r.m;
    if (m && m.online && m.connection === 'direct') return 'direct';
    if (m && m.online && m.connection === 'relay') return m.via?.kind === 'official' ? 'official' : 'device';
    if (!r.online) return 'offline';
    if (!mesh.enabled) return 'meshOff';
    return 'notConnected';
  };
  const H = PAD * 2 + others.length * ROW;
  const yOf = (i) => PAD + ROW / 2 + i * ROW;
  const ySelf = H / 2;
  const rtt = (r) => (Number.isFinite(r.m?.rtt_ms) ? ` · ${Math.round(r.m.rtt_ms)}ms` : '');
  const addrText = (r) => t(`profile.conn.addr.${ADDR[r.m?.addr_kind] || 'lan'}`);
  const serving = Number(self?.relay?.sessions) || 0;

  // 从这台电脑散开，到中间时已经和那台设备同一高度，再直线连过去
  const path = (y) => `M ${X_SELF + 75} ${ySelf} C ${X_SELF + 150} ${ySelf}, ${X_MID - 150} ${y}, ${X_MID - 70} ${y} L ${X_DEV - 75} ${y}`;
  const label = (d, k) => (k === 'direct' ? `${addrText(d)}${rtt(d)}`
    : k === 'official' ? `${t('profile.conn.official')}${rtt(d)}`
      : k === 'device' ? `${t('profile.conn.viaDevice', { name: d.m?.via?.label || d.m?.via?.device_id || '?' })}${rtt(d)}`
        : k === 'offline' ? t('profile.conn.offline')
          : k === 'meshOff' ? t('profile.conn.meshOff') : t('profile.conn.notConnected'));

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto max-w-2xl" role="img" aria-label={t('profile.conn.title')}>
        {others.map((d, i) => {
          const k = kindOf(d);
          const stroke = k === 'direct' ? 'stroke-emerald-500'
            : k === 'official' || k === 'device' ? 'stroke-violet-400'
              : k === 'notConnected' || k === 'meshOff' ? 'stroke-amber-300 dark:stroke-amber-700'
                : 'stroke-zinc-300 dark:stroke-zinc-600';
          const dash = k === 'direct' ? undefined : k === 'official' || k === 'device' ? '6 5' : '2 5';
          return <path key={`l-${d.key}`} d={path(yOf(i))} fill="none" className={`${stroke} stroke-[1.6]`} strokeDasharray={dash} strokeLinecap="round" />;
        })}
        {others.map((d, i) => {
          const k = kindOf(d);
          return <Pill key={`p-${d.key}`} x={X_MID} y={yOf(i)} text={label(d, k)} tone={k === 'direct' ? 'direct' : k === 'official' || k === 'device' ? 'relay' : k === 'offline' ? 'off' : 'warn'} />;
        })}
        <Node x={X_SELF} y={ySelf} title={(selfAcc && titleOf(selfAcc)) || self?.label || self?.name || t('profile.thisDevice')}
          sub={serving ? t('profile.conn.serving', { n: serving }) : t('profile.thisDevice')} tone="self" />
        {others.map((d, i) => {
          const k = kindOf(d);
          return (
            <Node key={`n-${d.key}`} x={X_DEV} y={yOf(i)} title={d.title}
              sub={Number(d.m?.relay?.sessions) ? t('profile.conn.serving', { n: d.m.relay.sessions }) : ''}
              tone={k === 'offline' ? 'off' : 'normal'} />
          );
        })}
      </svg>
    </div>
  );
}
