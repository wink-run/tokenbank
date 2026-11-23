// 设备标识：生成可读的设备名与平台说明（Electron 主进程 / CLI 共用）
'use strict';

const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

/** 设备类型展示文案 */
const TYPE_LABEL = { desktop: '桌面客户端', cli: 'CLI 网关' };

/** 去掉 Bonjour 后缀，便于阅读 */
function stripLocalSuffix(host) {
  const h = String(host || '').trim();
  return h.replace(/\.local$/i, '');
}

/** 是否为 IPv4 地址 */
function isIpAddress(value) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(value || '').trim());
}

/** Docker / K8s 等容器环境 */
function isLikelyContainer() {
  try {
    if (fs.existsSync('/.dockerenv')) return true;
  } catch (_) {}
  if (process.env.KUBERNETES_SERVICE_HOST) return true;
  if (process.env.CONTAINER || process.env.DOCKER_CONTAINER) return true;
  return false;
}

/** 读取首个可用的非内网回环 IPv4（Docker 等无电脑名时作设备标识） */
function readPrimaryIp() {
  const nets = os.networkInterfaces();
  const candidates = [];

  for (const [ifName, addrs] of Object.entries(nets)) {
    if (!addrs || ifName === 'lo') continue;
    for (const net of addrs) {
      const family = net.family === 'IPv4' || net.family === 4;
      if (family && !net.internal) {
        candidates.push({ ifName, address: net.address });
      }
    }
  }

  // 优先常见物理/容器网卡
  const prefer = ['eth0', 'en0', 'wlan0', 'enp', 'bond0'];
  for (const pref of prefer) {
    const hit = candidates.find(c => c.ifName === pref || c.ifName.startsWith(pref));
    if (hit) return hit.address;
  }

  return candidates[0]?.address || '';
}

/** hostname 是否为容器随机 ID 等无意义名称 */
function isGenericHostname(host) {
  const h = stripLocalSuffix(host).toLowerCase();
  if (!h || h === 'localhost') return true;
  if (isIpAddress(h)) return false;
  // Docker 默认 12 位 hex 容器 ID
  if (/^[a-f0-9]{12}$/.test(h)) return true;
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(h)) return true;
  if (isLikelyContainer() && /^[a-f0-9-]+$/.test(h)) return true;
  return false;
}

/** 读取系统「电脑名称」（macOS ComputerName / Windows COMPUTERNAME） */
function readComputerName() {
  try {
    if (process.platform === 'darwin') {
      const name = execFileSync('scutil', ['--get', 'ComputerName'], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
      if (name) return name;
    }
    if (process.platform === 'win32') {
      const name = String(process.env.COMPUTERNAME || '').trim();
      if (name) return name;
    }
  } catch (_) {}
  return '';
}

/** macOS 产品版本（如 15.5） */
function readMacOsVersion() {
  try {
    if (process.platform === 'darwin') {
      return execFileSync('sw_vers', ['-productVersion'], {
        encoding: 'utf8',
        timeout: 2000,
      }).trim();
    }
  } catch (_) {}
  return '';
}

/** 将 OS 信息格式化为可读平台说明 */
function formatOsPlatform(platform, release) {
  const p = platform || process.platform;
  const rel = release || os.release();
  const arch = os.arch();

  if (p === 'darwin') {
    const macVer = readMacOsVersion();
    const chip = arch === 'arm64' ? 'Apple Silicon' : (arch === 'x64' ? 'Intel' : arch);
    return macVer ? `macOS ${macVer} · ${chip}` : `macOS · ${chip}`;
  }
  if (p === 'win32') {
    const build = parseInt(String(rel).split('.')[2] || '0', 10);
    const winLabel = build >= 22000 ? 'Windows 11' : 'Windows 10';
    return `${winLabel} · ${arch}`;
  }
  if (p === 'linux') {
    return `Linux ${rel} · ${arch}`;
  }
  return `${p}/${rel}`;
}

/** 判断 name 是否仅为 hostname / 电脑名（应生成更友好的展示名） */
function looksLikeRawHostname(name, computerName, hostname) {
  const n = stripLocalSuffix(name).toLowerCase();
  if (!n) return true;
  const h = stripLocalSuffix(hostname || os.hostname()).toLowerCase();
  const c = String(computerName ?? readComputerName()).trim().toLowerCase();
  if (n === h) return true;
  if (c && n === c) return true;
  return false;
}

/** 无电脑名时：TB_DEVICE_NAME → 有意义 hostname →（容器里）「Docker 网关」→ IP → 默认文案 */
function resolveDisplayBase({ computerName, hostname, type } = {}) {
  const fromEnv = String(process.env.TB_DEVICE_NAME || '').trim();
  if (fromEnv) return fromEnv.slice(0, 64);

  const comp = String(computerName ?? readComputerName()).trim();
  if (comp) return comp;

  const host = stripLocalSuffix(hostname || os.hostname());
  if (host && !isGenericHostname(host)) return host;

  // 容器每次重建 IP 都会变，拿它当名字会在盘点里堆出一串没用的设备：用固定的名字
  if (isLikelyContainer()) return 'Docker 网关';

  const ip = readPrimaryIp();
  if (ip) return ip;

  return type === 'desktop' ? '桌面设备' : 'CLI 设备';
}

/** 组装注册/展示用设备名 */
function buildDeviceName({ computerName, hostname, type, port, customName } = {}) {
  const host = stripLocalSuffix(hostname || os.hostname());
  const comp = String(computerName ?? readComputerName()).trim();

  // 用户自定义名称（非 hostname 形式）优先
  if (customName && !looksLikeRawHostname(customName, comp, hostname || os.hostname())) {
    return String(customName).trim();
  }

  const base = resolveDisplayBase({ computerName: comp, hostname: host, type });

  // 同机多 CLI 实例：附加端口区分
  if (type === 'cli' && port) {
    return `${base} · CLI :${port}`;
  }

  return base;
}

/**
 * 采集本机设备标识。
 * options: { type, port, version, customName }
 */
function collect(options = {}) {
  const {
    type = 'desktop',
    port = null,
    version = '0.0.0',
    customName = '',
  } = options;
  const hostname = os.hostname();
  const computerName = readComputerName();
  const ip = readPrimaryIp();

  return {
    name: buildDeviceName({ computerName, hostname, type, port, customName }),
    hostname: stripLocalSuffix(hostname),
    computerName,
    ip,
    platform: formatOsPlatform(process.platform, os.release()),
    version,
    typeLabel: TYPE_LABEL[type] || type,
  };
}

/** 兼容旧数据：MacIntel / Win32 等浏览器 platform 字符串 */
function formatLegacyPlatform(platform) {
  if (!platform) return '';
  const p = String(platform).trim();
  if (p === 'MacIntel' || p === 'MacPPC') return 'macOS';
  if (p === 'Win32') return 'Windows';
  if (/^darwin\//i.test(p)) {
    return p.replace(/^darwin\//i, 'macOS ');
  }
  return p;
}

module.exports = {
  TYPE_LABEL,
  stripLocalSuffix,
  readComputerName,
  readPrimaryIp,
  isLikelyContainer,
  isGenericHostname,
  resolveDisplayBase,
  formatOsPlatform,
  buildDeviceName,
  collect,
  formatLegacyPlatform,
};
