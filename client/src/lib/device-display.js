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

/** 还没读到电脑名时的占位。同一台 Mac 会先后记成 CLI 和「桌面设备」。 */
const PLACEHOLDER_NAMES = new Set(['cli', '桌面设备', 'cli 设备']);

function normalizedTitle(device) {
  return formatDeviceTitle(device).trim().toLowerCase();
}

/** Chromium 把 macOS 冻在 10.15.7；剥掉之后只剩「macOS」，不能当成另一台机器。 */
function isFrozenMacPlatform(platform) {
  const p = formatLegacyPlatform(platform).trim().toLowerCase();
  return p === 'macos' || p === 'macos 10.15.7' || p === 'macos 10.15' || p === 'macintel';
}

function isMacPlatform(platform) {
  const p = formatLegacyPlatform(platform).trim().toLowerCase();
  return p === 'macos' || p.startsWith('macos ') || p.startsWith('darwin');
}

/** 旧上报：占位名 + 冻结的 macOS 版本。机器其实还在，只是改用了新的设备 id。 */
function isLegacyMacPlaceholder(device) {
  return PLACEHOLDER_NAMES.has(normalizedTitle(device)) && isFrozenMacPlatform(device?.platform);
}

/** 同一台机器的归并键：展示名 + 系统。版本号不同仍视为同一台。 */
export function deviceIdentityKey(device) {
  const name = normalizedTitle(device);
  const platform = formatLegacyPlatform(device?.platform).trim().toLowerCase();
  if (!name) return '';
  // CLI / 10.15.7 与「桌面设备 / macOS」是同一台 Mac 换 id 前后的两条记录
  if (isLegacyMacPlaceholder(device)) return 'legacy-mac';
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
  const merged = order.map((key) => {
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
  return adoptOfflineLegacyMac(merged);
}

/**
 * 电脑名已经改成真实名称后，旧的「CLI / 10.15.7」不再能靠名字并进去。
 * 只要这台 Mac 仍有在线记录，就把这些停更的占位行收进来，避免列表里多出一台假离线。
 */
function adoptOfflineLegacyMac(devices) {
  const legacy = [];
  const rest = [];
  for (const d of devices) {
    if (!d.online && isLegacyMacPlaceholder(d)) legacy.push(d);
    else rest.push(d);
  }
  if (!legacy.length) return devices;
  const host = rest.find(d => d.online && isMacPlatform(d.platform));
  if (!host) return devices;
  const ids = [
    ...(host.device_ids?.length ? host.device_ids : [host.device_id]),
    ...legacy.flatMap(d => (d.device_ids?.length ? d.device_ids : [d.device_id])),
  ].filter(Boolean);
  host.device_ids = [...new Set(ids)];
  host.today_calls = (Number(host.today_calls) || 0) + legacy.reduce((n, d) => n + (Number(d.today_calls) || 0), 0);
  host.today_errors = (Number(host.today_errors) || 0) + legacy.reduce((n, d) => n + (Number(d.today_errors) || 0), 0);
  return rest;
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
