// client/electron/mesh/keys.js
// 设备密钥和端到端加密，只用 Node 自带的 crypto。
//
// 设备身份：~/.tokenbank/mesh/secret.key 里的 32 字节种子 → Ed25519 密钥对。endpoint_id 是公钥的 hex，
// 和原来 iroh 的 endpoint id 一样，所以已经签发的设备证书照样能用。
//
// 端到端会话（两台设备之间，不管经不经中继）：双方各出一个临时 X25519 公钥，用自己的设备密钥签名；
// ECDH + HKDF 得出两个方向各一把 AES-256-GCM 密钥。中继只看到密文。
'use strict';

const crypto = require('crypto');

// Ed25519 私钥的 PKCS#8 DER 前缀，后面接 32 字节种子
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function fromB64u(s) { return Buffer.from(String(s || ''), 'base64url'); }

/** 种子 → { privateKey, publicKey, endpointId } */
function deviceKey(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('设备密钥必须是 32 字节');
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = crypto.createPublicKey(privateKey);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicKey, endpointId: raw.toString('hex') };
}

function endpointIdFromSecret(seed) { return deviceKey(seed).endpointId; }

function sign(privateKey, text) { return b64u(crypto.sign(null, Buffer.from(String(text)), privateKey)); }

/** 用 endpoint_id（Ed25519 公钥 hex）验签 */
function verify(endpointId, text, sig) {
  try {
    const raw = Buffer.from(String(endpointId || ''), 'hex');
    if (raw.length !== 32) return false;
    const pub = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(String(text)), pub, fromB64u(sig));
  } catch { return false; }
}

/** 临时 X25519 密钥：{ privateKey, pub（32 字节 base64url） } */
function ephemeral() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return { privateKey, pub: b64u(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)) };
}

/**
 * 两边的临时公钥 → 两个方向的密钥。initiator 是发起握手的一方。
 * @returns {{ send: Buffer, recv: Buffer }}
 */
function sessionKeys({ privateKey, myPub, peerPub, sid, initiator }) {
  const peer = crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, fromB64u(peerPub)]), format: 'der', type: 'spki' });
  const shared = crypto.diffieHellman({ privateKey, publicKey: peer });
  const [a, b] = initiator ? [myPub, peerPub] : [peerPub, myPub];
  const okm = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(String(sid)), Buffer.from(`tb-mesh-v1|${a}|${b}`), 64));
  const ab = okm.subarray(0, 32);   // 发起方 → 应答方
  const ba = okm.subarray(32, 64);
  return initiator ? { send: ab, recv: ba } : { send: ba, recv: ab };
}

function nonce(n) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(n), 4);
  return iv;
}

/** 加密一条消息（对象 → { n, c }） */
function seal(key, n, obj) {
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce(n));
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj))), cipher.final(), cipher.getAuthTag()]);
  return { n, c: b64u(body) };
}

/** 解密；被改过或密钥不对返回 null */
function open(key, n, c) {
  try {
    const buf = fromB64u(c);
    if (buf.length < 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce(n));
    decipher.setAuthTag(buf.subarray(buf.length - 16));
    const plain = Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch { return null; }
}

module.exports = { deviceKey, endpointIdFromSecret, sign, verify, ephemeral, sessionKeys, seal, open, b64u, fromB64u };
