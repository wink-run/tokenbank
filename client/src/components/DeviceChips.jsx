// 「所在设备」：一台设备一个小标签，绿点在线、灰点离线
import React from 'react';
import { useLang } from '../store/lang';

/** 连接方式的说明：直连（局域网 / Tailscale / 公网）或经哪个中继 */
export function connectionText(device, t) {
  if (!device || device.self || !device.online) return '';
  if (device.connection === 'relay') return device.via?.kind === 'official' ? t('mesh.viaOfficial') : t('mesh.viaDevice', { name: device.via?.label || '' });
  if (device.connection === 'direct') return t(`mesh.direct.${device.addr_kind || 'lan'}`);
  return '';
}

export function DeviceChip({ device, small = false }) {
  const { t } = useLang();
  const label = device.self ? t('mesh.self') : device.label;
  const conn = connectionText(device, t);
  const relayed = !device.self && device.online && device.connection === 'relay';
  const title = device.self
    ? t('mesh.selfTitle')
    : (device.online ? t('mesh.onlineTitle', { name: device.label }) + (conn ? ` · ${conn}` : '') : t('mesh.offlineTitle', { name: device.label }));
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-[5px] border border-zinc-900/10 dark:border-white/10 bg-white/70 dark:bg-white/[0.04] whitespace-nowrap max-w-full ${small ? 'px-[5px] text-[10px] leading-[14px]' : 'px-1.5 py-px text-[11px] leading-4'} ${device.online ? 'text-zinc-600 dark:text-zinc-300' : 'text-zinc-400 dark:text-zinc-500'}`}
    >
      <span className={`w-[5px] h-[5px] rounded-full shrink-0 ${device.online ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
      <span className="truncate">{label}</span>
      {relayed && <span className="shrink-0 opacity-60">{device.via?.kind === 'official' ? t('mesh.viaOfficialShort') : t('mesh.viaDeviceShort', { name: device.via?.label || '' })}</span>}
    </span>
  );
}

/** 一组设备标签；没有设备时显示 — */
export default function DeviceChips({ devices = [], small = false, className = '' }) {
  if (!devices.length) return <span className="text-zinc-400 text-xs">—</span>;
  return (
    <span className={`flex flex-wrap items-center gap-1 min-w-0 ${className}`}>
      {devices.map((d) => <DeviceChip key={d.device_id || d.label} device={d} small={small} />)}
    </span>
  );
}
