// client/electron/mesh/files.js
// 个人设备之间传文件：不走云存储，经设备通道（端到端加密）按需拉取。
//   · 发出方把文件「登记」成一个随机凭证（offerFile / offerBuffer），消息里只带清单 { token, name, size, sha256, mime }
//   · 拿到清单的设备凭凭证经设备通道 GET /v1/mesh/files/<token> 流式拉取，校验 sha256 后存到本机
//   · 只能拉登记过的文件，凭证 7 天后作废；只认本人名下设备（设备通道本身只连本人的设备）
// 派活时的输入（图片、附件）和执行完的产出文件都用这一套。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 这么大以内的产出自动拉回来；更大的点了再拉 */
const AUTO_PULL_BYTES = 10 * 1024 * 1024;
/** 只能经官方中继时单个文件的上限（流量走我们的中继服务器） */
const RELAY_MAX_BYTES = 500 * 1024 * 1024;

function meshDir() {
  return path.join(os.homedir(), '.tokenbank', 'mesh');
}
function indexPath() { return path.join(meshDir(), 'files.json'); }
function outboxDir() { return path.join(meshDir(), 'outbox'); }

let cache = null;
function readIndex() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}
function writeIndex(idx) {
  cache = idx;
  try {
    fs.mkdirSync(meshDir(), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify(idx), { mode: 0o600 });
  } catch { /* 写不了就只在内存里 */ }
}

/** 过期的凭证清掉；outbox 里替它们暂存的文件一起删 */
function prune(now = Date.now()) {
  const idx = readIndex();
  let changed = false;
  for (const [token, e] of Object.entries(idx)) {
    if (now - (Number(e.at) || 0) <= TTL_MS) continue;
    if (e.temp) { try { fs.rmSync(path.dirname(e.path), { recursive: true, force: true }); } catch { /* 已删 */ } }
    delete idx[token];
    changed = true;
  }
  if (changed) writeIndex(idx);
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function mimeOf(name) { return MIME[path.extname(String(name || '')).toLowerCase()] || 'application/octet-stream'; }

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : 'file';
}

/** 清单里给别人看的部分（不含本机路径） */
function publicEntry(token, e) {
  return { token, name: e.name, size: e.size, sha256: e.sha256, mime: e.mime };
}

/**
 * 登记本机一个文件，返回清单项
 * @param {string} file 绝对路径
 * @param {{ taskId?: string, name?: string, temp?: boolean }} [opts]
 */
async function offerFile(file, { taskId = '', name, temp = false } = {}) {
  prune();
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('不是文件');
  const token = crypto.randomBytes(18).toString('base64url');
  const e = {
    path: path.resolve(file), name: safeName(name || path.basename(file)), size: st.size,
    sha256: await sha256File(file), mime: mimeOf(name || file), taskId: String(taskId || ''), at: Date.now(), temp: !!temp,
  };
  const idx = readIndex();
  idx[token] = e;
  writeIndex(idx);
  return publicEntry(token, e);
}

/** 内存里的内容（比如游乐场带的图片）：先存进 outbox 再登记 */
async function offerBuffer(buf, name, { taskId = '' } = {}) {
  const dir = path.join(outboxDir(), crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safeName(name));
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return offerFile(file, { taskId, name, temp: true });
}

/** dataUrl（data:image/png;base64,…）→ 登记 */
async function offerDataUrl(dataUrl, name, opts) {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/s.exec(String(dataUrl || ''));
  if (!m) throw new Error('不是 dataUrl');
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[String(m[1] || '').toLowerCase()] || '';
  const n = safeName(name || `file${ext}`);
  return offerBuffer(Buffer.from(m[2], 'base64'), path.extname(n) ? n : `${n}${ext}`, opts);
}

/** 凭证对应的本机文件；过期、不存在、被改过都返回 null */
function lookup(token) {
  prune();
  const e = readIndex()[String(token || '')];
  if (!e) return null;
  try {
    const st = fs.statSync(e.path);
    if (!st.isFile() || st.size !== e.size) return null;
  } catch { return null; }
  return e;
}

/** 网关路由 GET /v1/mesh/files/<token>：流式发出去 */
function serve(token, res) {
  const e = lookup(token);
  if (!e) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: '文件不在了（过期或已删除）', type: 'not_found' } }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': e.mime || 'application/octet-stream',
    'Content-Length': String(e.size),
    'X-TB-File-Sha256': e.sha256,
  });
  fs.createReadStream(e.path).pipe(res);
}

/**
 * 从另一台设备拉一个文件，校验 sha256 后存到 destDir。
 * @param {{ proxy: (deviceId, req) => Promise<{status, headers, chunks}>, deviceId: string, entry: object,
 *   destDir: string, viaOfficialRelay?: boolean }} q
 * @returns {Promise<{ path: string, size: number }>}
 */
async function pull({ proxy, deviceId, entry, destDir, viaOfficialRelay = false }) {
  if (!entry || !entry.token) throw new Error('清单不完整');
  if (viaOfficialRelay && Number(entry.size) > RELAY_MAX_BYTES) {
    throw new Error(`「${entry.name}」有 ${Math.round(entry.size / 1048576)}MB，两台设备没直连，只能经官方中继，超过 ${RELAY_MAX_BYTES / 1048576}MB 的不传`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const final = uniquePath(destDir, safeName(entry.name));
  const tmp = `${final}.part`;
  const resp = await proxy(deviceId, { method: 'GET', path: `/v1/mesh/files/${encodeURIComponent(entry.token)}`, headers: {} });
  if (resp.status !== 200) {
    let msg = `HTTP ${resp.status}`;
    try {
      const parts = [];
      for await (const c of resp.chunks) parts.push(c);
      msg = JSON.parse(Buffer.concat(parts).toString('utf8'))?.error?.message || msg;
    } catch { /* 用状态码 */ }
    throw new Error(`拉「${entry.name}」失败：${msg}`);
  }
  const h = crypto.createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  try {
    for await (const c of resp.chunks) {
      size += c.length;
      h.update(c);
      if (!out.write(c)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  } catch (e) {
    try { out.destroy(); fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  const sha = h.digest('hex');
  if ((entry.sha256 && sha !== entry.sha256) || (Number.isFinite(Number(entry.size)) && size !== Number(entry.size))) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`「${entry.name}」传输不完整（校验不对），没有保存`);
  }
  fs.renameSync(tmp, final);
  return { path: final, size };
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem}-${i}${ext}`);
  return p;
}

/** 本机存放从别的设备拉回来的文件的目录 */
function inboxDir(taskId) {
  return path.join(os.homedir(), '.tokenbank', 'mesh-files', String(taskId || 'misc').replace(/[^\w.-]/g, '_'));
}

module.exports = {
  offerFile, offerBuffer, offerDataUrl, lookup, serve, pull, inboxDir, mimeOf,
  AUTO_PULL_BYTES, RELAY_MAX_BYTES, TTL_MS, _reset: () => { cache = null; },
};
