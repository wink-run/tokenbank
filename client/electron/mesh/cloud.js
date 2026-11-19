// client/electron/mesh/cloud.js
// 和 TokenBank 云端打交道：领证书、报地址、拉地址簿和吊销列表。内容不经过云端。
// 服务端见 server/mesh_router.py。
'use strict';

class MeshCloud {
  /**
   * @param {{ serverUrl: string, token: string, deviceId: string, fetchImpl?: Function, timeoutMs?: number }} opts
   */
  constructor({ serverUrl, token, deviceId, fetchImpl, timeoutMs = 10000 } = {}) {
    this.serverUrl = String(serverUrl || '').replace(/\/+$/, '');
    this.token = token;
    this.deviceId = deviceId;
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  get ready() { return !!(this.serverUrl && this.token && this.deviceId); }

  async call(method, path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
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
      throw Object.assign(new Error(`连不上云端：${e.message}`), { status: 0 });
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
    return this.call('POST', '/mesh/address', {
      device_id: this.deviceId, endpoint_id: endpointId, relay_url: relayUrl || '', direct_addrs: directAddrs || [],
    });
  }

  async peers() { return (await this.call('GET', '/mesh/peers')).peers || []; }

  async revocations() { return (await this.call('GET', '/mesh/revocations')).revoked || []; }

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
