// client/src/hooks/useDeviceReporter.js
// Registers the current device with the backend and sends periodic heartbeats.
// Runs in the renderer where the JWT (localStorage 'token') is available.
import { useEffect, useRef } from 'react';
import { isElectron, getGateway, getConfig } from '../api/adapter';
import { registerDevice, heartbeatDevice } from '../api/client';
import { buildAccountsSummary } from '../lib/accountsSummary';
import { buildAccountsConfig } from '../lib/account-config-sync';

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60s（服务端 2 分钟无心跳会标离线，须小于该阈值）
const RECONNECT_INTERVAL_MS = 30 * 1000;      // retry interval while offline
const MAX_FAILURES_BEFORE_RECONNECT = 2;       // failures before trying re-register

// Module-level singleton — prevents concurrent registrations.
// Keyed by user id so a real user-switch still re-registers.
let _registeredForUserId = null;
let _registrationPromise = null;
let _deviceId            = null;
let _deviceMeta          = { name: '', platform: '', version: '', type: 'desktop' }; // 心跳同步用
let _heartbeatTimer      = null;
let _consecutiveFailures = 0;
let _reregistering       = false; // guard against concurrent re-register attempts

/** 解析本机唯一设备 ID：桌面版用 ~/.tokenbank/device-id（主进程 IPC） */
async function _resolveDeviceId(cfg) {
  if (isElectron() && window.electronAPI?.app?.getDeviceId) {
    const id = window.electronAPI.app.getDeviceId();
    if (id && id !== cfg?.device_id) {
      getConfig().write({ ...(cfg || {}), device_id: id }).catch(() => {});
    }
    return id;
  }

  // Docker / CLI Web：经 admin-api 读 ~/.tokenbank/device-id
  try {
    const r = await fetch('/api/device-identity');
    if (r.ok) {
      const j = await r.json();
      if (j.device_id) {
        if (j.device_id !== cfg?.device_id) {
          getConfig().write({ ...(cfg || {}), device_id: j.device_id }).catch(() => {});
        }
        return j.device_id;
      }
    }
  } catch {}

  const fallback = String(cfg?.device_id || '').trim();
  if (fallback) return fallback;

  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const id = `dev-${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
  await getConfig().write({ ...(cfg || {}), device_id: id }).catch(() => {});
  return id;
}

/** 浏览器 / Docker Web 环境下的平台说明（非 Electron） */
function _browserPlatform() {
  const ua = navigator.userAgent || '';
  const mac = ua.match(/Mac OS X (\d+[._]\d+(?:[._]\d+)?)/);
  if (mac) return `macOS ${mac[1].replace(/_/g, '.')}`;
  const win = ua.match(/Windows NT (\d+\.\d+)/);
  if (win) return parseFloat(win[1]) >= 10 ? 'Windows' : `Windows NT ${win[1]}`;
  return navigator.userAgentData?.platform || navigator.platform || 'Web';
}

/** 解析应用版本：优先 Electron preload 注入的 package.json 版本，勿用 agent 配置里的 version */
function _resolveAppVersion(identityVersion) {
  if (isElectron() && window.electronAPI?.version) {
    return window.electronAPI.version;
  }
  if (identityVersion) return identityVersion;
  return '0.0.0';
}

/** 采集设备名称 / 平台 / 版本（注册与心跳共用） */
async function _collectDeviceMeta(port, cfg) {
  const type = isElectron() ? 'desktop' : 'cli';
  let name;
  let platform;
  let version;

  if (isElectron() && window.electronAPI?.app?.getDeviceIdentity) {
    const identity = window.electronAPI.app.getDeviceIdentity({ customName: cfg?.name || '' });
    name     = identity?.name || cfg?.name || '桌面设备';
    platform = identity?.platform || _browserPlatform();
    version  = _resolveAppVersion(identity?.version);
  } else {
    let identity = null;
    try {
      const r = await fetch('/api/device-identity');
      if (r.ok) identity = await r.json();
    } catch {}
    if (identity?.name) {
      name     = identity.name;
      platform = identity.platform || _browserPlatform();
      version  = _resolveAppVersion(identity.version);
    } else {
      const host = (cfg?.name || 'CLI').replace(/\.local$/i, '');
      name     = `${host} · CLI :${port}`;
      platform = _browserPlatform();
      version  = _resolveAppVersion(null);
    }
  }

  return { type, name, platform, version };
}

async function _doRegister() {
  try {
    const gwStatus = await getGateway().status().catch(() => null);
    const port     = gwStatus?.port || 11430;

    const cfg = await getConfig().read().catch(() => ({}));
    const storedId = await _resolveDeviceId(cfg);

    const { type, name, platform, version } = await _collectDeviceMeta(port, cfg);
    _deviceMeta = { name, platform, version, type };

    const res   = await registerDevice({ device_id: storedId, type, name, platform, version, gateway_port: port });
    // Backend returns the devices table row: primary key column is "id", not "device_id"
    const newId = res.data?.id || res.data?.device_id;
    if (!newId) return;
    _deviceId = newId;
    if (newId !== cfg?.device_id) {
      getConfig().write({ ...(cfg || {}), device_id: newId }).catch(() => {});
    }
  } catch {
    // Not logged in, backend down — silent
  }
}

/** 读本机账户：摘要（个人页展示）+ 可同步配置（不含 Key，供其他终端拉取） */
async function _loadAccountsBundle() {
  let accounts = null;
  const getUA = window.electronAPI?.localConfig?.getUserAccounts;
  if (getUA) {
    try { accounts = await getUA(); } catch { /* 离线 */ }
  }
  // CLI / Docker Web：经 admin-api 读 ~/.llm-agent/local-config.json
  if (!accounts) {
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch('/api/user-accounts', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) accounts = await res.json();
    } catch { /* 未登录或网关未就绪 */ }
  }
  if (!accounts) return { summary: null, config: null };
  let providers = [];
  let includeSecrets = false;
  try {
    const cfg = await getConfig().read();
    if (Array.isArray(cfg?.providers)) providers = cfg.providers;
    // 设置页「同步账户密钥」默认关，打开后心跳才带上 Key
    includeSecrets = !!cfg?.sync_account_secrets;
  } catch { /* 网关配置未就绪 */ }
  return {
    summary: buildAccountsSummary(accounts),
    config: buildAccountsConfig(accounts, providers, { includeSecrets }),
  };
}

/** 采集本机 1/7/30 天盘点快照，随心跳上报云端 */
async function _collectInventory() {
  const query = window.electronAPI?.localStats?.query;
  const comp  = window.electronAPI?.localStats?.compression;
  const { summary: accountsSummary, config: accountsConfig } = await _loadAccountsBundle();
  const attach = (snap) => {
    if (!snap) return snap;
    if (accountsSummary) snap.accounts_summary = accountsSummary;
    // 有配置才带上，避免一次失败的空对象把云端已有配置冲掉
    if (accountsConfig) snap.accounts_config = accountsConfig;
    return snap;
  };
  if (query) {
    const [d1, d7, d30] = await Promise.all([
      query(1).catch(() => null),
      query(7).catch(() => null),
      query(30).catch(() => null),
    ]);
    // 压缩比 summary 一并随快照上报，供云端各端汇总
    const [c1, c7, c30] = await Promise.all([
      comp ? comp(1).catch(() => null) : Promise.resolve(null),
      comp ? comp(7).catch(() => null) : Promise.resolve(null),
      comp ? comp(30).catch(() => null) : Promise.resolve(null),
    ]);
    const inv = {};
    if (d1) { if (c1) d1.compression = c1; inv['1'] = attach(d1); }
    if (d7) { if (c7) d7.compression = c7; inv['7'] = attach(d7); }
    if (d30) { if (c30) d30.compression = c30; inv['30'] = attach(d30); }
    // 还没有用量快照时也上报账户配置，方便另一台终端立刻能同步
    if (!inv['1'] && (accountsSummary || accountsConfig)) inv['1'] = attach({});
    return inv;
  }
  const d1 = await getGateway().getDailyStats().catch(() => ({}));
  const snap = d1?.total_calls != null ? attach({ ...d1 }) : (accountsSummary ? attach({}) : null);
  return snap ? { '1': snap } : {};
}

async function _sendHeartbeat() {
  if (!_deviceId) return;
  try {
    const inv = await _collectInventory();
    const d1 = inv['1'] || {};
    await heartbeatDevice(_deviceId, {
      type             : _deviceMeta.type,
      version          : _deviceMeta.version,
      name             : _deviceMeta.name,
      platform         : _deviceMeta.platform,
      calls            : d1?.total_calls  || 0,
      errors           : 0,  // not tracked in local stats
      providers_active : (d1?.providers || []).length,
      inventory        : inv,
    });
    // Successful heartbeat — reset failure counter
    _consecutiveFailures = 0;
  } catch {
    // Heartbeat failed — count failures and attempt re-registration once threshold reached
    _consecutiveFailures += 1;
    if (_consecutiveFailures >= MAX_FAILURES_BEFORE_RECONNECT && !_reregistering) {
      _reregistering = true;
      _doRegister().then(() => {
        _reregistering       = false;
        _consecutiveFailures = 0;
        // Immediately send a heartbeat so the device shows online again
        _sendHeartbeat();
      }).catch(() => { _reregistering = false; });
    }
  }
}

export function useDeviceReporter(user) {
  const timerRef = useRef(null);

  useEffect(() => {
    if (!user) return;

    const uid = user.id;

    // 用户切换时重置；每次挂载都重新 register，确保版本号等与 package.json 同步
    if (_registeredForUserId !== uid) {
      _registeredForUserId = uid;
      _deviceId            = null;
      _consecutiveFailures = 0;
    }
    _registrationPromise = _doRegister();

    let active = true;

    _registrationPromise.then(() => {
      if (!active) return;
      // Immediate heartbeat → device shows online right away
      _sendHeartbeat();
      // Periodic heartbeat — one global timer
      if (!_heartbeatTimer) {
        _heartbeatTimer = setInterval(_sendHeartbeat, HEARTBEAT_INTERVAL_MS);
      }
      timerRef.current = _heartbeatTimer;
    });

    return () => { active = false; };
  }, [user?.id]);
}
