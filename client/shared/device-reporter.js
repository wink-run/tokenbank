// client/shared/device-reporter.js
// Works in both Electron main process and Node.js CLI — no Electron imports.
'use strict';

const https  = require('https');
const http   = require('http');
const os     = require('os');
const { readAgentConfig, writeAgentConfig } = require('./config-loader');
const deviceIdentity = require('./device-identity');
const { ensureDeviceId, readDeviceId, writeDeviceId } = require('./device-id');

const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60s（服务端 2 分钟无心跳会标离线）

// ── Module state ──────────────────────────────────────────────────────────────

let _config   = null;  // { type, name, platform, version, serverUrl, userJwt, device_id }
let _timer    = null;
let _getStats = null;  // () => { calls, errors, providers_active }  (may be async)
let _inventoryExtra = null;  // () => 附加到 inventory 的字段（如看护的资产清单），可为空

// ── Low-level HTTP helper ─────────────────────────────────────────────────────

/**
 * POST JSON body to url, authenticated with Bearer token.
 * Resolves to { status, body } or rejects on network/timeout error.
 */
function _post(url, body, token) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const mod  = u.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);

    const req = mod.request({
      hostname : u.hostname,
      port     : u.port || (u.protocol === 'https:' ? 443 : 80),
      path     : u.pathname,
      method   : 'POST',
      headers  : {
        'Content-Type'   : 'application/json',
        'Content-Length' : Buffer.byteLength(data),
        'Authorization'  : `Bearer ${token}`,
      },
      timeout: 10000,
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });

    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

/** 读取/生成本机唯一设备 ID（~/.tokenbank/device-id 或 device-id-cli） */
function _ensureLocalDeviceId(_existing, kind = 'desktop') {
  const persisted = readDeviceId(kind);
  if (persisted) return persisted;
  // 不把 config.json 里的 id 写回文件，那份配置可能是另一台 Mac 同步过来的
  return ensureDeviceId(kind);
}

/**
 * POST to /device/register → returns device_id string.
 * 失败时沿用已持久化的本地 ID，避免每次启动随机生成新设备。
 */
async function _register() {
  const persisted = _config?.device_id || '';

  // 心跳/注册须用户登录 JWT，不能用 P2P API Key
  if (!_config?.serverUrl || !_config?.userJwt) return persisted;

  try {
    const res = await _post(
      `${_config.serverUrl}/device/register`,
      {
        type         : _config.type,
        name         : _config.name,
        platform     : _config.platform,
        version      : _config.version,
        gateway_port : 11430,
        device_id    : persisted,
      },
      _config.userJwt
    );

    if (res.status >= 200 && res.status < 300) {
      const json = JSON.parse(res.body);
      // 服务端 devices 表主键字段为 id
      const id = json?.id || json?.device_id;
      if (id) return id;
    }
  } catch (_) {
    // Network or parse error — keep persisted id
  }

  return persisted;
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

/** POST to /device/heartbeat — never throws. */
async function _sendHeartbeat(online = true) {
  if (!_config?.serverUrl || !_config?.userJwt) return;

  let stats = { calls: 0, errors: 0, providers_active: 0 };
  try {
    if (typeof _getStats === 'function') {
      const result = await Promise.resolve(_getStats());
      if (result && typeof result === 'object') stats = { ...stats, ...result };
    }
  } catch (_) {
    // getStats failure is non-fatal
  }

  // Extract inventory from stats if provided, keep stats clean for server
  let inventory = stats.inventory || null;
  const { inventory: _inv, ...statsClean } = stats;
  try {
    const extra = typeof _inventoryExtra === 'function' ? _inventoryExtra() : null;
    if (extra && typeof extra === 'object') inventory = { ...(inventory || {}), ...extra };
  } catch (_) { /* 附加字段失败不影响心跳 */ }

  try {
      await _post(
      `${_config.serverUrl}/device/heartbeat`,
      {
        device_id: _config.device_id,
        online,
        type     : _config.type || '',
        version  : _config.version || '',
        name     : _config.name || '',
        platform : _config.platform || '',
        stats    : { ...statsClean, inventory },
      },
      _config.userJwt
    );
  } catch (_) {
    // Heartbeat is best-effort; swallow all errors
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call once on startup.
 * options: { type: 'desktop'|'cli', name, platform, version, serverUrl, userJwt }
 * 设备 id 只认本机文件。云端返回了另一个 id 时不写回。
 */
async function init(options) {
  // Merge options with any existing agent config
  const existing = readAgentConfig() || {};

  const deviceKind = options.type === 'cli' ? 'cli' : 'desktop';
  const localDeviceId = _ensureLocalDeviceId(existing.device_id || null, deviceKind);

  const identity = deviceIdentity.collect({
    type     : options.type || 'desktop',
    port     : options.port || options.gateway_port || null,
    version  : options.version || '0.0.0',
    customName: options.name || '',
  });

  _config = {
    type      : options.type     || 'desktop',
    name      : options.name     || identity.name,
    platform  : options.platform || identity.platform,
    version   : options.version  || identity.version,
    serverUrl : options.serverUrl || existing.serverUrl || null,
    userJwt   : options.userJwt  || null,
    device_id : localDeviceId,
  };

  // 未登录不注册。已登录也只在后台注册：云端慢或不可达时，启动方继续用本机 device_id。
  if (!_config.userJwt) return;
  _register().then((registeredId) => {
    if (!_config) return;
    // 桌面版：服务端若按名字并到另一台，忽略那个 id，继续用本机文件里的。
    // CLI / Docker：容器重建会换一个新 id，服务端指回已有的那台时要写回本机文件。
    if (registeredId && registeredId !== localDeviceId && deviceKind !== 'cli') {
      _config.device_id = localDeviceId;
    } else if (registeredId) {
      _config.device_id = registeredId;
    }
    if (_config.device_id) writeDeviceId(_config.device_id, deviceKind);
    const cfg = readAgentConfig() || {};
    cfg.device_id = _config.device_id;
    try { writeAgentConfig(cfg); } catch (_) {}
  }).catch(() => {});
}

/**
 * Start the 60-second heartbeat loop.
 * getStats: optional async/sync () => { calls, errors, providers_active }
 */
function start(getStats) {
  if (!_config?.userJwt) return;
  _getStats = getStats || null;

  // Immediate heartbeat (best-effort, don't block)
  _sendHeartbeat(true).catch(() => {});

  // Clear any existing timer before starting a new one
  if (_timer) clearInterval(_timer);
  _timer = setInterval(() => {
    _sendHeartbeat(true).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  // Allow the process to exit even if this timer is running
  if (_timer.unref) _timer.unref();
}

/**
 * Stop the heartbeat loop and send a final offline heartbeat (best-effort).
 */
function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_config?.userJwt) _sendHeartbeat(false).catch(() => {});
}

/** 登录/登出时更新 JWT；登出后停止心跳 */
function setUserJwt(jwt) {
  if (_config) _config.userJwt = jwt || null;
  if (!jwt && _timer) {
    clearInterval(_timer);
    _timer = null;
    return;
  }
  // 网关先起来、后登录时，init 没能注册。CLI 在这里把新 id 换成云端已有的那条。
  if (jwt && _config && _config.type === 'cli') {
    _register().then((registeredId) => {
      if (!registeredId || !_config || registeredId === _config.device_id) return;
      _config.device_id = registeredId;
      writeDeviceId(registeredId, 'cli');
    }).catch(() => {});
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

/** 心跳 inventory 里追加的字段（多设备资产清单等）；传 null 取消 */
function setInventoryExtra(fn) {
  _inventoryExtra = typeof fn === 'function' ? fn : null;
}

module.exports = { init, start, stop, setUserJwt, setInventoryExtra };
