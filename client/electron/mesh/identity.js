// client/electron/mesh/identity.js
// 设备身份：设备密钥（32 字节 Ed25519 种子）和云端签发的设备证书。
// 证书是紧凑 JWS（EdDSA）。设备之间用内置的签发方公钥离线校验，不用联网问云端。
// 原型阶段由开发用签发方（dev issuer）在本机签发；正式版改由云端 POST /mesh/cert 签发，证书格式不变。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CERT_TYP = 'tokenbank-mesh-cert';
// 一期只签本人。不认识的 scope 一律拒绝，以后扩展到圈子时旧客户端不会误放行。
const KNOWN_SCOPES = new Set(['self']);
const CLOCK_SKEW_SEC = 300;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ── 设备密钥 ─────────────────────────────────────────────────────────────────

/** ~/.tokenbank/mesh/secret.key（只有本人可读）；没有就生成 */
function loadOrCreateDeviceSecret(dir) {
  const file = path.join(dir, 'secret.key');
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, 'hex');
  } catch { /* 第一次启动 */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(file, secret.toString('hex'), { mode: 0o600 });
  return secret;
}

// ── 签发方 ───────────────────────────────────────────────────────────────────

/** 生成签发方密钥对。kid 用公钥前 8 字节，便于轮换时区分 */
function generateIssuer() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  return {
    kid: fromB64url(x).subarray(0, 8).toString('hex'),
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: { kid: fromB64url(x).subarray(0, 8).toString('hex'), x },
  };
}

/**
 * 签发设备证书。
 * @param {{ privateKeyPem: string, kid: string }} issuer
 * @param {{ iss, sub, device_id, endpoint_id, name, ttlSec?, scope?, circles?, team? }} claims
 */
function issueCert(issuer, claims, now = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'EdDSA', typ: CERT_TYP, kid: issuer.kid };
  const payload = {
    typ: CERT_TYP,
    ver: 1,
    iss: claims.iss || 'tokenbank-dev',
    sub: String(claims.sub),
    device_id: String(claims.device_id),
    endpoint_id: String(claims.endpoint_id),
    name: String(claims.name || ''),
    iat: now,
    exp: now + (Number(claims.ttlSec) || 7 * 86400),
    // 预留：以后开放圈子 / 团队时才会签别的值
    scope: claims.scope || 'self',
    circles: Array.isArray(claims.circles) ? claims.circles : [],
    team: claims.team ?? null,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign(null, Buffer.from(signingInput), crypto.createPrivateKey(issuer.privateKeyPem));
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * 校验证书签名和有效期。
 * @param {string} token
 * @param {Array<{kid: string, x: string}>} issuerKeys 内置的签发方公钥（可多把）
 * @returns {{ ok: true, claims: object } | { ok: false, reason: string }}
 */
function verifyCert(token, issuerKeys, now = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  let header;
  let claims;
  try {
    header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
    claims = JSON.parse(fromB64url(parts[1]).toString('utf8'));
  } catch { return { ok: false, reason: 'malformed' }; }
  if (header.alg !== 'EdDSA' || header.typ !== CERT_TYP) return { ok: false, reason: 'wrong_type' };
  const key = (issuerKeys || []).find((k) => k && k.kid === header.kid);
  if (!key) return { ok: false, reason: 'unknown_issuer' };
  let valid = false;
  try {
    const pub = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' });
    valid = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), pub, fromB64url(parts[2]));
  } catch { valid = false; }
  if (!valid) return { ok: false, reason: 'bad_signature' };
  if (claims.typ !== CERT_TYP) return { ok: false, reason: 'wrong_type' };
  if (typeof claims.exp !== 'number' || claims.exp < now - CLOCK_SKEW_SEC) return { ok: false, reason: 'expired' };
  if (typeof claims.iat !== 'number' || claims.iat > now + 86400) return { ok: false, reason: 'not_yet_valid' };
  return { ok: true, claims };
}

/**
 * 连接建立后判断对方能不能进来。
 * @returns {{ ok: true, claims } | { ok: false, reason }}
 */
function checkPeer(token, { issuerKeys, remoteEndpointId, selfUserId, revoked, now } = {}) {
  const v = verifyCert(token, issuerKeys, now);
  if (!v.ok) return v;
  const c = v.claims;
  if (!KNOWN_SCOPES.has(c.scope)) return { ok: false, reason: 'unknown_scope' };
  if (String(c.endpoint_id) !== String(remoteEndpointId)) return { ok: false, reason: 'endpoint_mismatch' };
  if (String(c.sub) !== String(selfUserId)) return { ok: false, reason: 'other_user' };
  if (revoked && (revoked.has(c.endpoint_id) || revoked.has(c.device_id))) return { ok: false, reason: 'revoked' };
  return { ok: true, claims: c };
}

/** 证书还剩多少秒；解析不了返回 0 */
function certRemainingSec(token, now = Math.floor(Date.now() / 1000)) {
  try {
    const claims = JSON.parse(fromB64url(String(token).split('.')[1]).toString('utf8'));
    return Math.max(0, Number(claims.exp) - now);
  } catch { return 0; }
}

module.exports = {
  CERT_TYP,
  loadOrCreateDeviceSecret,
  generateIssuer,
  issueCert,
  verifyCert,
  checkPeer,
  certRemainingSec,
  _internal: { b64url, fromB64url },
};
