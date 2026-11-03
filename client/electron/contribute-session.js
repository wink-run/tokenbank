/**
 * 社区接单：按调用方隔离 CLI session / 工作目录，避免多用户互相污染本机游乐场。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONTRIBUTE_SESSION_PREFIX = 'contribute:';
const WORKSPACE_ROOT = path.join(os.homedir(), '.tokenbank', 'contribute-workspaces');

/** 路径段安全化（保留字母数字与少量分隔符） */
function safeSegment(raw, fallback = 'x') {
  let s = String(raw || '')
    .trim()
    .replace(/[^A-Za-z0-9._@+-]+/g, '_')
    .replace(/^\.+/, '') // 去掉前导 . 防 ../
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (!s || s === '.' || s === '..') s = fallback;
  return s;
}

/**
 * 调用方隔离键：优先用云端下发的 consumer_key；否则回退 uid / task。
 * @returns {string} 如 u12 / gabc123 / task-at-xxx
 */
function resolveConsumerKey(msg = {}) {
  const fromMsg = String(msg.consumer_key || '').trim();
  if (fromMsg) return safeSegment(fromMsg, 'anon');
  if (msg.consumer_user_id != null && String(msg.consumer_user_id).trim() !== '') {
    return safeSegment(`u${msg.consumer_user_id}`, 'anon');
  }
  const taskId = String(msg.task_id || msg.req_id || '').trim();
  return safeSegment(taskId ? `task-${taskId}` : 'anon', 'anon');
}

/** 游乐场 sessionKey：contribute:<assistant>:<consumer> */
function contributeSessionKey(assistantId, consumerKey) {
  return `${CONTRIBUTE_SESSION_PREFIX}${safeSegment(assistantId)}:${safeSegment(consumerKey)}`;
}

/** 是否社区接单 session（本机游乐场应忽略） */
function isContributeSessionKey(sessionKey) {
  return String(sessionKey || '').startsWith(CONTRIBUTE_SESSION_PREFIX);
}

/**
 * 为该调用方准备独立工作目录（同用户可复用，跨用户不共用）。
 */
function ensureContributeWorkspace(assistantId, consumerKey) {
  const dir = path.join(
    WORKSPACE_ROOT,
    safeSegment(assistantId, 'assistant'),
    safeSegment(consumerKey, 'anon'),
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 回传给调用方的成品：图片和视频可直接看，字幕等其它文件可下载。
// 短视频常见 5–20MB，旧的 4MB 上限会把成片留在出租方磁盘上。
const ARTIFACT_MAX = 8;
const ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const ARTIFACT_TOTAL_CHARS = 64_000_000;
const ARTIFACT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.srt': 'text/plain',
  '.vtt': 'text/vtt',
};
const ARTIFACT_EXT = Object.keys(ARTIFACT_MIME).map((ext) => ext.slice(1)).join('|').replace('jpeg|', 'jpe?g|');

/** 真实路径必须落在工作目录内，挡掉符号链接和工作目录外的路径。 */
function containedFile(rootReal, candidate) {
  let st;
  try { st = fs.lstatSync(candidate); } catch { return null; }
  if (st.isSymbolicLink() || !st.isFile()) return null;
  let real;
  try { real = fs.realpathSync(candidate); } catch { return null; }
  const rel = path.relative(rootReal, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segs = rel.split(path.sep);
  if (segs.some((seg) => seg.startsWith('.') || seg === 'node_modules')) return null;
  return { real, size: st.size, mtimeMs: st.mtimeMs, name: path.basename(real) };
}

/** 从回复正文里找出工作目录内的文件路径（绝对路径或相对路径）。 */
function mentionedPaths(text, workingDir) {
  const raw = String(text || '');
  const found = [];
  const absRe = new RegExp(
    String.raw`(?:^|[^\w./\\~])((?:\/|~\/|[A-Za-z]:[\\/])[^\s'"\`<>|*?\u0000]+?\.(?:${ARTIFACT_EXT}))`,
    'gim',
  );
  let m;
  while ((m = absRe.exec(raw))) {
    let p = m[1];
    if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
    found.push(p);
  }
  // 目录和文件名可以是中文，例如 outputs/宣传片.srt
  const relRe = new RegExp(
    String.raw`(?:^|[\s'"\`（(])((?:[^\s'"\`<>|*?\u0000/\\]+[\\/])+[^\s'"\`<>|*?\u0000/\\]+\.(?:${ARTIFACT_EXT}))`,
    'gim',
  );
  while ((m = relRe.exec(raw))) {
    const rel = m[1];
    if (rel.split(/[\\/]/).includes('..')) continue;
    found.push(path.resolve(workingDir, rel));
  }
  return found;
}

function walkRecentFiles(dir, rootReal, startedAt, acc, depth) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      walkRecentFiles(full, rootReal, startedAt, acc, depth + 1);
      continue;
    }
    if (!ent.isFile()) continue;
    const info = containedFile(rootReal, full);
    if (!info) continue;
    // 本轮新写的文件；给 2 秒时钟误差
    if (startedAt && info.mtimeMs + 2000 < startedAt) continue;
    acc.push(info);
  }
}

/**
 * 收集本轮成品。正文点名的文件优先；此外带上工作目录里本轮新写出的允许类型。
 * 不读工作目录以外的路径。
 */
function collectWorkspaceArtifacts(workingDir, text, startedAt = 0) {
  if (!workingDir || !fs.existsSync(workingDir)) return [];
  let rootReal;
  try { rootReal = fs.realpathSync(workingDir); } catch { return []; }

  const picked = [];
  const seen = new Set();
  let totalChars = 0;

  const pushFile = (abs) => {
    if (picked.length >= ARTIFACT_MAX) return;
    const info = containedFile(rootReal, abs);
    if (!info || seen.has(info.real)) return;
    const ext = path.extname(info.name).toLowerCase();
    const mime = ARTIFACT_MIME[ext];
    if (!mime) return;
    if (info.size <= 0 || info.size > ARTIFACT_MAX_BYTES) return;
    const dataUrl = `data:${mime};base64,${fs.readFileSync(info.real).toString('base64')}`;
    if (totalChars + dataUrl.length > ARTIFACT_TOTAL_CHARS) return;
    seen.add(info.real);
    totalChars += dataUrl.length;
    const kind = mime.startsWith('image/') && ext !== '.svg' ? 'image' : 'file';
    picked.push({
      name: info.name.slice(0, 120),
      mime,
      kind,
      dataUrl,
      // 服务端用它把正文里的本机路径换成中转地址，不会原样发给调用方
      localPath: info.real,
    });
  };

  for (const p of mentionedPaths(text, rootReal)) pushFile(p);
  const recent = [];
  walkRecentFiles(rootReal, rootReal, Number(startedAt) || 0, recent, 0);
  recent.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of recent) pushFile(item.real);
  return picked;
}

module.exports = {
  CONTRIBUTE_SESSION_PREFIX,
  WORKSPACE_ROOT,
  safeSegment,
  resolveConsumerKey,
  contributeSessionKey,
  isContributeSessionKey,
  ensureContributeWorkspace,
  collectWorkspaceArtifacts,
};
