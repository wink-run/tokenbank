// 外部智能体交文件：和跨设备同一套。
// 对方给一个用户这台电脑能直接 GET 的地址；10MB 以内马上拉回，更大的只登记，点了再拉。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { AUTO_PULL_BYTES, RELAY_MAX_BYTES, inboxDir } = require('./mesh/files');

const MAX_FILES = 20;
const MAX_REDIRECTS = 3;

function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120);
  return base && base !== '.' && base !== '..' ? base : 'file';
}

/** 回环和云元数据不算「用户那台电脑能直接打开」 */
function blockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true;
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true;
  return /^127\./.test(h);
}

/**
 * 收下外部智能体报的文件清单。本机路径、file://、需要它那边才能打开的地址丢掉。
 * @returns {{ token: string, name: string, size: number|null, url: string, sha256: string }[]}
 */
function acceptFiles(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list.slice(0, MAX_FILES)) {
    if (!raw || typeof raw !== 'object') continue;
    let u;
    try { u = new URL(String(raw.url || '')); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (u.username || u.password || blockedHost(u.hostname)) continue;
    const size = Number(raw.size);
    const sha = String(raw.sha256 || '').trim().toLowerCase();
    out.push({
      token: crypto.randomBytes(9).toString('base64url'),
      name: safeName(raw.name || path.basename(u.pathname) || 'file'),
      size: Number.isFinite(size) && size >= 0 ? size : null,
      url: u.toString(),
      sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : '',
    });
  }
  return out;
}

/** 知道大小、且不超过自动拉取上限，才在回传时下载。没报大小的先不拉 */
function pullNow(entry) {
  if (entry == null || entry.size == null || entry.size === '') return false;
  const n = Number(entry.size);
  return Number.isFinite(n) && n >= 0 && n <= AUTO_PULL_BYTES;
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; fs.existsSync(p); i += 1) p = path.join(dir, `${stem}-${i}${ext}`);
  return p;
}

function requestOnce(url, method, timeoutMs, allowLocal) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || (!allowLocal && blockedHost(u.hostname))) {
      reject(new Error('这个地址不能从这台电脑直接打开'));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method,
      headers: { 'User-Agent': 'TokenBank' },
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        try { resolve({ redirect: new URL(res.headers.location, url).toString() }); }
        catch (e) { reject(e); }
        return;
      }
      resolve({ status: code, headers: res.headers, res });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
    req.end();
  });
}

/** 跟着跳转，每一跳都重新检查地址 */
async function openUrl(url, method, timeoutMs, allowLocal) {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const got = await requestOnce(current, method, timeoutMs, allowLocal);
    if (!got.redirect) return got;
    current = got.redirect;
  }
  throw new Error('跳转太多次');
}

/**
 * 把一个 http(s) 文件拉到 destDir。Content-Length 超过上限时不读正文。
 * @returns {Promise<{ path: string, size: number }>}
 */
async function pullUrl(entry, destDir, { maxBytes = RELAY_MAX_BYTES, timeoutMs = 120000, allowLocal = false } = {}) {
  if (!entry || !entry.url) throw new Error('没有下载地址');
  const declared = Number(entry.size);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`「${entry.name}」超过 ${Math.round(maxBytes / 1048576)}MB，不代拉`);
  const head = await openUrl(entry.url, 'HEAD', Math.min(timeoutMs, 20000), allowLocal).catch(() => null);
  const headLen = head && head.status === 200 ? Number(head.headers['content-length']) : NaN;
  if (Number.isFinite(headLen) && headLen > maxBytes) throw new Error(`「${entry.name}」超过 ${Math.round(maxBytes / 1048576)}MB，不代拉`);
  const got = await openUrl(entry.url, 'GET', timeoutMs, allowLocal);
  if (got.status !== 200 || !got.res) {
    if (got.res) got.res.destroy();
    throw new Error(`拉「${entry.name}」失败：HTTP ${got.status || 0}`);
  }
  const len = Number(got.headers['content-length']);
  if (Number.isFinite(len) && len > maxBytes) {
    got.res.destroy();
    throw new Error(`「${entry.name}」超过 ${Math.round(maxBytes / 1048576)}MB，不代拉`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const final = uniquePath(destDir, safeName(entry.name));
  const tmp = `${final}.part`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  let settled = false;
  const fail = (reject, err) => {
    if (settled) return;
    settled = true;
    try { got.res.destroy(); } catch { /* 已经断了 */ }
    reject(err);
  };
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { mode: 0o600 });
      got.res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          out.destroy();
          fail(reject, new Error(`「${entry.name}」超过 ${Math.round(maxBytes / 1048576)}MB，不代拉`));
          return;
        }
        hash.update(c);
        if (!out.write(c)) got.res.pause();
      });
      out.on('drain', () => { try { got.res.resume(); } catch { /* 已结束 */ } });
      got.res.on('end', () => {
        if (settled) return;
        settled = true;
        out.end(resolve);
      });
      got.res.on('error', (e) => fail(reject, e));
      out.on('error', (e) => fail(reject, e));
    });
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 半截删掉 */ }
    throw e;
  }
  const sha = hash.digest('hex');
  if (entry.sha256 && sha !== entry.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`「${entry.name}」校验不对，没有保存`);
  }
  fs.renameSync(tmp, final);
  return { path: final, size };
}

module.exports = {
  acceptFiles, pullNow, pullUrl, inboxDir, AUTO_PULL_BYTES, RELAY_MAX_BYTES,
};
