// client/electron/mesh/cloud.js
// 和 TokenBank 云端打交道：领证书、报地址、拉地址簿和吊销列表。内容不经过云端。
// 服务端见 server/mesh_router.py。
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');

function inDocker() {
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
}

/**
 * 不用全局 fetch。Docker 里 undici 常走 HTTP/2 或 IPv6，连不上就报 This operation was aborted。
 * 和设备注册同一条 HTTP/1.1；容器里只走 IPv4。
 */
function nodeFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const body = init.body ? Buffer.from(init.body) : null;
    const headers = { ...(init.headers || {}) };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (init.signal) init.signal.removeEventListener('abort', onAbort);
      if (err) reject(err); else resolve(value);
    };
    const onAbort = () => { try { req.destroy(); } catch { /* 已经断了 */ } finish(Object.assign(new Error('超时'), { name: 'AbortError' })); };
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: init.method || 'GET',
      headers,
      // 容器里没有 IPv6 出口时，不要先去连一个没有回应的地址
      family: inDocker() ? 4 : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish(null, {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          json: async () => { try { return JSON.parse(text || 'null'); } catch { return null; } },
        });
      });
    });
    if (init.signal) {
      if (init.signal.aborted) { onAbort(); return; }
      init.signal.addEventListener('abort', onAbort);
    }
    req.on('error', (e) => finish(e));
    if (body) req.write(body);
    req.end();
  });
}

class MeshCloud {
  /**
   * @param {{ serverUrl: string, token: string, deviceId: string, fetchImpl?: Function, timeoutMs?: number }} opts
   */
  constructor({ serverUrl, token, deviceId, fetchImpl, timeoutMs = 10000 } = {}) {
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.deviceId = deviceId;
    this.fetch = fetchImpl || nodeFetch;
    this.timeoutMs = timeoutMs;
  }

  get ready() { return !!(this.serverUrl && this.token && this.deviceId); }

  async call(method, path, body, timeoutMs) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || this.timeoutMs);
    t.unref?.();
    let res;
    try {
      res = await this.fetch(`${this.serverUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      const msg = e.name === 'AbortError' || /aborted/i.test(String(e.message || '')) ? '超时' : e.message;
      throw Object.assign(new Error(`连不上云端：${msg}`), { status: 0 });
    } finally {
      clearTimeout(t);
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    if (!res.ok) {
      const detail = json?.detail || json?.error?.message || `HTTP ${res.status}`;
      if (detail && typeof detail === 'object') throw Object.assign(new Error(detail.message || JSON.stringify(detail)), { status: res.status, code: detail.code });
      throw Object.assign(new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)), { status: res.status });
    }
    return json || {};
  }

  /** @returns {Promise<{ cert, expires_at, user_id, issuer_keys, relay_urls }>} */
  requestCert({ endpointId, name }) {
    return this.call('POST', '/mesh/cert', { device_id: this.deviceId, endpoint_id: endpointId, name: name || '' });
  }

  publishAddress({ endpointId, relayUrl, directAddrs }) {
    // 云端要回拨验证地址，比别的请求慢一点
    return this.call('POST', '/mesh/address', {
      device_id: this.deviceId, endpoint_id: endpointId, relay_url: relayUrl || '', direct_addrs: directAddrs || [],
    }, 20000);
  }

  async peers() { return (await this.call('GET', '/mesh/peers')).peers || []; }

  async revocations() { return (await this.call('GET', '/mesh/revocations')).revoked || []; }

  /** 吊销列表和现在的签发公钥 */
  async revocationsAndKeys() {
    const j = await this.call('GET', '/mesh/revocations');
    return { revoked: j.revoked || [], issuerKeys: Array.isArray(j.issuer_keys) ? j.issuer_keys : null };
  }

  // ── 雇佣走设备通道：云端只签票、记账 ──
  /** 领雇佣票：云端选好出租方设备、扣好积分 */
  hireTicket({ assistantId, owner, workerId, timeoutMs, sessionKey }) {
    return this.call('POST', '/mesh/hire/ticket', {
      assistant_id: assistantId, caller_device_id: this.deviceId, owner: owner || undefined, worker_id: workerId || undefined,
      timeout_ms: timeoutMs || undefined, session_key: sessionKey || undefined,
    });
  }

  /** 出租方结算：sig 是本机设备密钥签的 `tb-hire-settle|<task_id>|<status>`（不靠登录也能结） */
  settleHire(taskId, { status, sig, durationMs }) {
    return this.call('POST', `/mesh/hire/${encodeURIComponent(taskId)}/settle`, { status, sig, duration_ms: durationMs || undefined });
  }

  cancelHire(taskId) { return this.call('POST', `/mesh/hire/${encodeURIComponent(taskId)}/cancel`, {}); }

  /** 等批准的新设备 */
  async pending() { return (await this.call('GET', '/mesh/pending')).pending || []; }

  /** 本机（已入网）批准 / 拒绝一台新设备；sig 是本机设备密钥签的 `tb-mesh-approve|<新设备>|<它的 endpoint_id>|approve|reject` */
  decide({ deviceId, approve, sig }) {
    return this.call('POST', '/mesh/approve', { device_id: deviceId, approver_device_id: this.deviceId, approve: !!approve, sig });
  }
}

/**
 * 要不要（重新）领证书：没有、快到期（不到 7 天）、或者证书上的账号 / 设备 / 密钥对不上
 * @param {object|null} claims 当前证书解出来的内容（不校验签名）
 */
function needsCert(claims, { userId, deviceId, endpointId, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!claims) return true;
  if (Number(claims.exp) - now < 7 * 86400) return true;
  if (userId && String(claims.sub) !== String(userId)) return true;
  if (deviceId && String(claims.device_id) !== String(deviceId)) return true;
  if (endpointId && String(claims.endpoint_id) !== String(endpointId)) return true;
  return false;
}

module.exports = { MeshCloud, needsCert };
