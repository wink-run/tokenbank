// client/electron/cloud-files.js
// 云端转发的雇佣任务里的文件：不再整份 base64 塞进任务消息，先直传 COS，消息里只带引用 { cos_key, name, mime, size, sha256 }。
//   · 雇佣方：带的图片、附件发出前上传（uploadInputs）
//   · 出租方：收到的引用换成本机文件（fetchInputs），做完的产出上传后交引用（uploadArtifacts）
// 对象私有、路径随机，单个 500MB 以内，7 天后删除。服务端没配 COS 时要不到上传地址，照旧带 base64。
// 个人设备之间不走这里（经设备通道，mesh/files.js）。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const MAX_BYTES = 500 * 1024 * 1024;
/** 下载下来的图片多大以内仍当图片给智能体看（多模态），更大的当普通文件 */
const IMAGE_INLINE_BYTES = 20 * 1024 * 1024;
/** 文本类附件多大以内读进来给安全审查一起看 */
const SCAN_TEXT_BYTES = 1024 * 1024;
/** 服务端说没配 COS：这么久之内不再问 */
const NO_COS_TTL_MS = 10 * 60 * 1000;

let noCosUntil = 0;

function request(method, url, { headers = {}, body, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error(`invalid url: ${url}`)); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: timeoutMs,
    }, (res) => resolve(res));
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    if (body && typeof body.pipe === 'function') body.pipe(req);
    else req.end(body);
  });
}

async function readBody(res) {
  const parts = [];
  for await (const c of res) parts.push(c);
  return Buffer.concat(parts).toString('utf8');
}

function authOf() {
  const { resolveCloudAuth } = require('./community-agent-client');
  return resolveCloudAuth();
}

function decodeDataUrl(dataUrl) {
  const m = /^data:([^;,]*)?(?:;[^,]*)?;base64,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  return { mime: String(m[1] || 'application/octet-stream'), buf: Buffer.from(m[2], 'base64') };
}

/**
 * 传一份到 COS。没配 COS 返回 null（调用方回退 base64）；超上限、传失败抛错。
 * @param {{ name: string, mime?: string, buf?: Buffer, file?: string }} f
 */
async function upload(f, auth = authOf()) {
  if (Date.now() < noCosUntil) return null;
  const { base, token } = auth || {};
  if (!base || !token) return null;
  const size = f.buf ? f.buf.length : fs.statSync(f.file).size;
  if (size > MAX_BYTES) throw new Error(`「${f.name}」有 ${Math.round(size / 1048576)}MB，超过 ${MAX_BYTES / 1048576}MB，传不了`);
  const mime = f.mime || 'application/octet-stream';
  const ask = JSON.stringify({ name: f.name, size, mime });
  const res = await request('POST', `${base}/api/agent-files/upload`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ask) },
    body: ask,
  });
  const text = await readBody(res);
  if (res.statusCode === 503 || res.statusCode === 404) {
    // 没配 COS，或者服务端还是旧版本
    noCosUntil = Date.now() + NO_COS_TTL_MS;
    return null;
  }
  let ticket = null;
  try { ticket = JSON.parse(text); } catch { /* 下面报错 */ }
  if (res.statusCode >= 400 || !ticket?.upload_url) {
    const msg = ticket?.detail?.error || ticket?.detail || text.slice(0, 200) || `HTTP ${res.statusCode}`;
    throw new Error(`「${f.name}」上传失败：${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
  }
  const sha = f.buf
    ? crypto.createHash('sha256').update(f.buf).digest('hex')
    : await new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(f.file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
    });
  const put = await request('PUT', ticket.upload_url, {
    headers: { ...(ticket.headers || {}), 'Content-Length': String(size) },
    body: f.buf || fs.createReadStream(f.file),
    timeoutMs: 30 * 60_000,
  });
  const putText = await readBody(put);
  if (put.statusCode >= 300) throw new Error(`「${f.name}」上传失败：HTTP ${put.statusCode} ${putText.slice(0, 120)}`);
  return { cos_key: ticket.cos_key, name: f.name, mime, size, sha256: sha };
}

/**
 * 雇佣方：任务里的图片、附件换成 COS 引用。没配 COS 时原样返回（base64）。
 * @param {Array<{ dataUrl?: string, name?: string, path?: string }>} items
 */
async function uploadInputs(items, auth) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const name = String(it?.name || `file-${i + 1}`);
    const decoded = typeof it === 'string' ? decodeDataUrl(it) : (it?.dataUrl ? decodeDataUrl(it.dataUrl) : null);
    const file = !decoded && it?.path ? String(it.path) : null;
    if (!decoded && !file) { out.push(it); continue; }
    const ref = await upload(decoded ? { name, mime: decoded.mime, buf: decoded.buf } : { name, mime: it.mime, file }, auth);
    if (!ref) return list;   // 没配 COS：整批照旧走 base64
    out.push(ref);
  }
  return out;
}

const TEXT_MIME = /^(text\/|application\/(json|x-sh|javascript|x-yaml|x-python))/i;

/**
 * 出租方：任务里的下载项（服务端换好的 { name, mime, size, url, sha256 }）拉到本机。
 * 图片小的仍转成 dataUrl（给多模态）；其余给本机路径；文本类小文件另带 data 给安全审查。
 * @returns {Promise<{ images: object[], files: object[], dir: string }>}
 */
async function fetchInputs(images, files) {
  const imgs = Array.isArray(images) ? images : [];
  const fls = Array.isArray(files) ? files : [];
  const remote = (x) => x && typeof x === 'object' && x.url && !x.dataUrl && /^https?:\/\//.test(String(x.url));
  if (!imgs.some(remote) && !fls.some(remote)) return { images: imgs, files: fls, dir: '' };
  const dir = path.join(os.tmpdir(), 'tokenbank-hire-in', crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const outImages = [];
  const outFiles = [];
  const all = [...imgs.map((x) => ({ x, image: true })), ...fls.map((x) => ({ x, image: false }))];
  for (let i = 0; i < all.length; i++) {
    const { x, image } = all[i];
    if (!remote(x)) { (image ? outImages : outFiles).push(x); continue; }
    const name = path.basename(String(x.name || `file-${i + 1}`)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || `file-${i + 1}`;
    const dest = path.join(dir, `${i + 1}-${name}`);
    await download(x, dest);
    const size = fs.statSync(dest).size;
    const mime = String(x.mime || '');
    if (image && size <= IMAGE_INLINE_BYTES) {
      outImages.push({ name, dataUrl: `data:${mime || 'image/png'};base64,${fs.readFileSync(dest).toString('base64')}` });
      fs.rmSync(dest, { force: true });
      continue;
    }
    const entry = { name, path: dest, mime, size };
    if (TEXT_MIME.test(mime) && size <= SCAN_TEXT_BYTES) entry.data = `data:${mime};base64,${fs.readFileSync(dest).toString('base64')}`;
    outFiles.push(entry);
  }
  return { images: outImages, files: outFiles, dir };
}

async function download(x, dest) {
  const res = await request('GET', String(x.url), { timeoutMs: 30 * 60_000 });
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`附件「${x.name}」下载失败：HTTP ${res.statusCode}`);
  }
  const h = crypto.createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  try {
    for await (const c of res) {
      size += c.length;
      if (size > MAX_BYTES) throw new Error(`附件「${x.name}」超过 ${MAX_BYTES / 1048576}MB`);
      h.update(c);
      if (!out.write(c)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    out.destroy();
    fs.rmSync(dest, { force: true });
    throw e;
  }
  if ((x.sha256 && h.digest('hex') !== String(x.sha256)) || (Number(x.size) > 0 && size !== Number(x.size))) {
    fs.rmSync(dest, { force: true });
    throw new Error(`附件「${x.name}」下载不完整（校验不对）`);
  }
}

/**
 * 出租方：产出上传 COS，交引用（{ name, mime, kind, cos_key, size, sha256, localPath }）。
 * 没配 COS 返回 null，调用方照旧带 base64。单个文件传失败只记下，不拖累其他文件。
 * @param {Array<{ name: string, mime: string, kind: string, path: string, localPath: string }>} items
 */
async function uploadArtifacts(items, { log } = {}) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const failed = [];
  for (const it of list) {
    try {
      const ref = await upload({ name: it.name, mime: it.mime, file: it.path });
      if (!ref) return null;
      out.push({ ...ref, kind: it.kind, localPath: it.localPath || it.path });
    } catch (e) {
      failed.push(it.name);
      log?.(`[agent] artifact upload failed: ${e.message}`);
    }
  }
  return { artifacts: out, failed };
}

module.exports = {
  upload, uploadInputs, fetchInputs, uploadArtifacts, MAX_BYTES,
  _reset: () => { noCosUntil = 0; },
};
