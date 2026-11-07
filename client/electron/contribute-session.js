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
// 一批图常见十几张。少传的文件会在正文里留下出租方本机文件名。
const ARTIFACT_MAX = 16;
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

/** 文件名两侧的标点。中文冒号、句号也要切开，否则「封面：图.png。」对不上磁盘上的文件。 */
const MENTION_STOP = '：:，。、；;！!？?）)】》」』';

function mentionName(raw) {
  return String(raw || '').normalize('NFC').replace(/[)\]】》」』，。、；：,.!?;:]+$/u, '');
}

/** 从回复正文里找出工作目录内的文件路径（绝对路径或相对路径）。 */
function mentionedPaths(text, workingDir) {
  const raw = String(text || '').normalize('NFC');
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
  // 文件名本体。标点不算进名字，中文也能当名字。反引号单独放进字符类，避免 u 标志把转义判错。
  const piece = `[^\\s'"\`<>|*?\\u0000/\\\\${MENTION_STOP}]{1,120}`;
  // 目录和文件名可以是中文，例如 outputs/宣传片.srt
  const relRe = new RegExp(
    `((?:${piece}[\\\\/])+${piece}\\.(?:${ARTIFACT_EXT}))`,
    'gi',
  );
  while ((m = relRe.exec(raw))) {
    const rel = mentionName(m[1]);
    if (!rel || rel.split(/[\\/]/).includes('..')) continue;
    if (/^[a-z]+:/i.test(rel)) continue;
    found.push(path.resolve(workingDir, rel));
  }
  // 封面常只写文件名，例如 封面：轻记账.png。没有目录、也没有反引号，也要能找到。
  const bareRe = new RegExp(
    `(?<![\\w\\u4e00-\\u9fff._/-])(${piece}\\.(?:${ARTIFACT_EXT}))`,
    'gi',
  );
  const bareNames = [];
  while ((m = bareRe.exec(raw))) bareNames.push(mentionName(m[1]));
  for (const name of bareNames) {
    if (!name) continue;
    for (const hit of findByBasename(workingDir, name)) found.push(hit);
  }
  return found;
}

/** 在工作目录里按文件名查找，深度与最近文件扫描一致。 */
function findByBasename(root, base) {
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 4 || hits.length >= 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (hits.length >= 4) return;
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && ent.name.normalize('NFC') === String(base || '').normalize('NFC')) hits.push(full);
    }
  };
  walk(root, 0);
  return hits;
}

function visitWorkspaceFiles(dir, rootReal, depth, visit) {
  if (depth > 4) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) {
      visitWorkspaceFiles(full, rootReal, depth + 1, visit);
      continue;
    }
    if (!ent.isFile()) continue;
    const info = containedFile(rootReal, full);
    if (info) visit(info);
  }
}

function fileStamp(info) {
  return `${info.size}:${info.mtimeMs}`;
}

/** 任务开始前记下工作目录。结束时用这份对照，不靠正文猜哪些文件是这轮写的。 */
function snapshotWorkspace(workingDir) {
  const index = new Map();
  if (!workingDir || !fs.existsSync(workingDir)) return index;
  let rootReal;
  try { rootReal = fs.realpathSync(workingDir); } catch { return index; }
  visitWorkspaceFiles(rootReal, rootReal, 0, (info) => {
    index.set(info.real, fileStamp(info));
  });
  return index;
}

/**
 * 收集本轮成品。正文点名的文件优先；有开工快照时，多出来或改过的文件都算交付。
 * 没有快照时仍按修改时间。不读工作目录以外的路径。
 */
function collectWorkspaceArtifacts(workingDir, text, startedAt = 0, before = null) {
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
      name: info.name.normalize('NFC').slice(0, 120),
      mime,
      kind,
      dataUrl,
      // 服务端用它把正文里的本机路径换成中转地址，不会原样发给调用方
      localPath: info.real,
    });
  };

  for (const p of mentionedPaths(text, rootReal)) pushFile(p);
  const produced = [];
  const started = Number(startedAt) || 0;
  const hasBefore = before instanceof Map;
  visitWorkspaceFiles(rootReal, rootReal, 0, (info) => {
    if (hasBefore) {
      if (before.get(info.real) !== fileStamp(info)) produced.push(info);
      return;
    }
    // 没有快照时，只带本轮新写的文件，给 2 秒时钟误差
    if (started && info.mtimeMs + 2000 < started) return;
    produced.push(info);
  });
  produced.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of produced) pushFile(item.real);
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
  snapshotWorkspace,
};
