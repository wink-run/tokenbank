/** 个人页设备列表：标题与副标题格式化（兼容旧 MacIntel / hostname.local 数据） */

const TYPE_LABEL = { desktop: '桌面版', cli: '命令行版' };

function stripLocalSuffix(name) {
  return String(name || '').trim().replace(/\.local$/i, '');
}

/** 旧版 navigator.platform 等无效平台字符串 → 可读文案 */
export function formatLegacyPlatform(platform) {
  if (!platform) return '';
  const p = String(platform).trim();
  if (p === 'MacIntel' || p === 'MacPPC') return 'macOS';
  if (p === 'Win32') return 'Windows';
  if (/^darwin\//i.test(p)) return p.replace(/^darwin\//i, 'macOS ');
  return p;
}

/** 设备主标题：去掉 .local 与历史 CLI 端口后缀 */
export function formatDeviceTitle(device) {
  let raw = device?.name || device?.device_id || '';
  raw = raw.replace(/\s·\sCLI\s:\d+$/, '');
  return stripLocalSuffix(raw) || raw;
}

/** 同一台机器的归并键：展示名 + 系统。版本号不同仍视为同一台。 */
export function deviceIdentityKey(device) {
  const name = formatDeviceTitle(device).trim().toLowerCase();
  const platform = formatLegacyPlatform(device?.platform).trim().toLowerCase();
  if (!name) return '';
  return `${name}\0${platform}`;
}

function _versionScore(version) {
  const v = String(version || '').trim();
  if (!v || v === '0.0.0') return 0;
  return 1;
}

/**
 * 相同设备合成一条。在线优先，其次保留真实版本号。
 * 今日次数相加；device_ids 留给删除时一次清掉全部重复记录。
 */
export function mergeSameDevices(devices) {
  const groups = new Map();
  const order = [];
  for (const d of devices || []) {
    const key = deviceIdentityKey(d) || `id:${d.device_id || ''}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(d);
  }
  return order.map((key) => {
    const list = groups.get(key);
    if (list.length === 1) return list[0];
    const ranked = [...list].sort((a, b) => {
      const online = (b.online ? 1 : 0) - (a.online ? 1 : 0);
      if (online) return online;
      const ver = _versionScore(b.version) - _versionScore(a.version);
      if (ver) return ver;
      return String(b.last_seen || '').localeCompare(String(a.last_seen || ''));
    });
    const primary = ranked[0];
    const sum = (field) => list.reduce((n, d) => n + (Number(d[field]) || 0), 0);
    return {
      ...primary,
      online: list.some(d => d.online),
      today_calls: sum('today_calls'),
      today_errors: sum('today_errors'),
      today_providers: Math.max(...list.map(d => Number(d.today_providers) || 0)),
      device_ids: list.map(d => d.device_id).filter(Boolean),
    };
  });
}

/** 展示用设备类型（DB 未及时刷新时根据名称推断） */
export function effectiveDeviceType(device) {
  if (device?.type === 'desktop') return 'desktop';
  const name = String(device?.name || '');
  if (/\s·\sCLI\s:\d+$/.test(name)) return 'cli';
  return device?.type || 'desktop';
}

/** 设备副标题：类型 · 版本 · 平台 */
export function formatDeviceSubtitle(device, { lastSeen } = {}) {
  const parts = [];
  const typeLabel = TYPE_LABEL[device?.type] || device?.type;
  if (typeLabel) parts.push(typeLabel);
  if (device?.version) parts.push(`v${device.version}`);
  const plat = formatLegacyPlatform(device?.platform);
  if (plat) parts.push(plat);
  if (lastSeen) parts.push(lastSeen);
  return parts.join(' · ');
}
