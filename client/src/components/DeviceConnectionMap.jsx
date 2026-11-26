// client/src/components/DeviceConnectionMap.jsx
// 设置页「我的设备」里的连接图：这台电脑到我的每台设备现在怎么连的。
//   左边是这台电脑，右边是其他设备；
//   每台设备一行：线从这台电脑散开，到中间和那台设备同一高度，中间的标签写怎么连的——
//   直连画实线（局域网 / Tailscale / IPv6 / 公网 + 延迟），经中转画虚线（官方中继 / 经我另一台设备），离线画灰色点线。
// 数据来自设备网络的 /v1/devices（connection、addr_kind、via、rtt_ms），每 10 秒刷新。
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
      : 'fill-zinc-50 stroke-zinc-200 dark:fill-zinc-900 dark:stroke-zinc-700';
  const tcls = tone === 'direct' ? 'fill-emerald-700 dark:fill-emerald-300'
    : tone === 'relay' ? 'fill-violet-700 dark:fill-violet-300' : 'fill-zinc-400';
  return (
    <g>
      <rect x={x - w / 2} y={y - 10} width={w} height={20} rx={10} className={`${cls} stroke-1`} />
      <text x={x} y={y + 4} textAnchor="middle" className={`text-[10.5px] ${tcls}`}>{text}</text>
    </g>
  );
}

export default function DeviceConnectionMap() {
  const { t } = useLang();
  const mesh = useMeshDevices();
  if (!mesh.enabled) return null;
  const self = mesh.self;
  const others = [...(mesh.others || [])].sort((a, b) => (b.online - a.online) || String(a.label || a.name).localeCompare(String(b.label || b.name)));
  if (!others.length) {
    return <p className="m-0 text-xs text-zinc-400 dark:text-zinc-500">{t('profile.conn.empty')}</p>;
  }

  const kindOf = (d) => {
    if (!d.online || d.connection === 'offline') return 'offline';
    if (d.connection === 'direct') return 'direct';
    if (d.connection === 'relay') return d.via?.kind === 'official' ? 'official' : 'device';
    return 'unknown';
  };
  const H = PAD * 2 + others.length * ROW;
  const yOf = (i) => PAD + ROW / 2 + i * ROW;
  const ySelf = H / 2;
  const rtt = (d) => (Number.isFinite(d.rtt_ms) ? ` · ${Math.round(d.rtt_ms)}ms` : '');
  const addrText = (d) => t(`profile.conn.addr.${ADDR[d.addr_kind] || 'lan'}`);
  const serving = Number(self?.relay?.sessions) || 0;

  // 从这台电脑散开，到中间时已经和那台设备同一高度，再直线连过去
  const path = (y) => `M ${X_SELF + 75} ${ySelf} C ${X_SELF + 150} ${ySelf}, ${X_MID - 150} ${y}, ${X_MID - 70} ${y} L ${X_DEV - 75} ${y}`;
  const label = (d, k) => (k === 'direct' ? `${addrText(d)}${rtt(d)}`
    : k === 'official' ? `${t('profile.conn.official')}${rtt(d)}`
      : k === 'device' ? `${t('profile.conn.viaDevice', { name: d.via?.label || d.via?.device_id || '?' })}${rtt(d)}`
        : k === 'offline' ? t('profile.conn.offline') : t('profile.conn.unknown'));

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto max-w-2xl" role="img" aria-label={t('profile.conn.title')}>
        {others.map((d, i) => {
          const k = kindOf(d);
          const stroke = k === 'direct' ? 'stroke-emerald-500'
            : k === 'official' || k === 'device' ? 'stroke-violet-400'
              : 'stroke-zinc-300 dark:stroke-zinc-600';
          const dash = k === 'direct' ? undefined : k === 'offline' || k === 'unknown' ? '2 5' : '6 5';
          return <path key={`l-${d.device_id}`} d={path(yOf(i))} fill="none" className={`${stroke} stroke-[1.6]`} strokeDasharray={dash} strokeLinecap="round" />;
        })}
        {others.map((d, i) => {
          const k = kindOf(d);
          return <Pill key={`p-${d.device_id}`} x={X_MID} y={yOf(i)} text={label(d, k)} tone={k === 'direct' ? 'direct' : k === 'official' || k === 'device' ? 'relay' : 'off'} />;
        })}
        <Node x={X_SELF} y={ySelf} title={self?.label || self?.name || t('profile.thisDevice')}
          sub={serving ? t('profile.conn.serving', { n: serving }) : t('profile.thisDevice')} tone="self" />
        {others.map((d, i) => {
          const k = kindOf(d);
          return (
            <Node key={`n-${d.device_id}`} x={X_DEV} y={yOf(i)} title={d.label || d.name || d.device_id}
              sub={Number(d.relay?.sessions) ? t('profile.conn.serving', { n: d.relay.sessions }) : ''}
              tone={k === 'offline' ? 'off' : 'normal'} />
          );
        })}
      </svg>
    </div>
  );
}
