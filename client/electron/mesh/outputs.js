// client/electron/mesh/outputs.js
// 任务的产出（设计 §8.4）。执行端：开工前准备工作区（子任务各用一个 git worktree）、拍快照；
// 结束后把改动记成一个提交（refs/tokenbank/mesh/<任务号>，不动用户的分支、暂存区和工作区），
// 列出改过的文件，非代码文件复制到 outbox。发起端：按需拉 git bundle 进本机分支、拉单个文件。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const MESH_DIR = () => path.join(os.homedir(), '.tokenbank', 'mesh');
const OUTBOX = () => path.join(MESH_DIR(), 'outbox');
const INBOX = () => path.join(MESH_DIR(), 'inbox');
const WORKTREES = () => path.join(MESH_DIR(), 'worktrees');
const KEEP_MS = 7 * 86400 * 1000;
const OUTBOX_TASK_MAX = 500 * 1024 * 1024;   // 单任务快照上限（D19）
const FILE_MAX = 200 * 1024 * 1024;          // 单个文件（§8.4.2）
const SNAPSHOT_MAX_FILES = 20000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.tokenbank-uploads', '.venv', '__pycache__', '.next', 'dist', 'build', '.cache']);
// 这些就算进了 git 提交也当「非代码产出」，复制进 outbox，结果里给清单
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip', '.tar', '.gz', '.mp4', '.mov', '.mp3', '.wav', '.csv', '.html', '.md']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.json': 'application/json',
  '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };

function git(cwd, args, { env, input, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile('git', args, { cwd, env: { ...process.env, ...env }, maxBuffer, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(Object.assign(err, { message: `git ${args[0]}：${String(stderr || err.message).trim().split('\n').pop()}` })); }
      resolve(String(stdout));
    });
    if (input != null) { p.stdin.end(input); }
  });
}

async function gitTop(dir) {
  try { return (await git(dir, ['rev-parse', '--show-toplevel'])).trim(); } catch { return null; }
}

function safeId(id) { return String(id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 96); }
function shortId(id) { return String(id || '').split(':').pop().replace(/^task_/, '').replace(/[^A-Za-z0-9]/g, '').slice(-10) || crypto.randomBytes(4).toString('hex'); }
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

/** 工作区快照：相对路径 → { size, mtimeMs }。跳过 .git、node_modules 等 */
function snapshot(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    if (out.size >= SNAPSHOT_MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.size >= SNAPSHOT_MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(path.join(dir, e.name)); out.set(r, { size: st.size, mtimeMs: st.mtimeMs }); } catch { /* 刚删 */ }
    }
  };
  walk(root, '');
  return out;
}

/** 清掉 7 天前的 outbox、工作树和 refs/tokenbank/mesh/*（已经合并的不受影响：提交还在用户的分支上） */
async function prune() {
  const now = Date.now();
  for (const base of [OUTBOX(), INBOX()]) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      const p = path.join(base, n);
      try { if (now - fs.statSync(p).mtimeMs > (base === INBOX() ? 30 * 86400 * 1000 : KEEP_MS)) fs.rmSync(p, { recursive: true, force: true }); } catch { /* 下次再清 */ }
    }
  }
  let wts = [];
  try { wts = fs.readdirSync(WORKTREES()); } catch { wts = []; }
  for (const n of wts) {
    const p = path.join(WORKTREES(), n);
    try {
      if (now - fs.statSync(p).mtimeMs < KEEP_MS) continue;
      const top = await gitTop(p);
      if (top) await git(top, ['worktree', 'remove', '--force', p]).catch(() => {});
      fs.rmSync(p, { recursive: true, force: true });
    } catch { /* 下次再清 */ }
  }
}

/**
 * 开工前：决定在哪跑、记下基准。
 * @param {{ cwd: string, isolate?: boolean, readonly?: boolean, branch?: string, parentId?: string,
 *           worktreeInit?: string, previous?: object, repoHint?: string }} q
 * @returns {Promise<{ cwd: string, info: object, snap: Map }>}
 */
async function prepare({ cwd, isolate = false, readonly = false, branch, parentId, worktreeInit, previous } = {}) {
  prune().catch(() => {});
  const top = await gitTop(cwd);
  const rel = top ? path.relative(top, cwd) : '';
  const info = { isGit: !!top, readonly: !!readonly, worktree: null, branch: null, base: null, repo: null, root: top || cwd };
  let runDir = cwd;
  if (top) {
    try { info.repo = require('./workspaces').repoSlug(top); } catch { info.repo = null; }
    info.base = (await git(top, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
    info.branch = (await git(top, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim() || null;
  }
  // 续上一轮：回到上一轮的工作树，基准不变（这样两轮的改动合在一起）
  if (previous?.worktree && fs.existsSync(previous.worktree)) {
    Object.assign(info, { worktree: previous.worktree, branch: previous.branch, base: previous.base, root: previous.worktree, repo: previous.repo || info.repo });
    runDir = path.join(previous.worktree, previous.rel || '');
    info.rel = previous.rel || '';
  } else if (top && isolate && !readonly && info.base) {
    // 并行的子任务各用一个工作树和分支，互不覆盖（D15）
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const wt = path.join(WORKTREES(), id);
    const br = String(branch || '').trim() || (parentId ? `tb/collab/${shortId(parentId)}/${id}` : `tb/mesh/${id}`);
    fs.mkdirSync(WORKTREES(), { recursive: true });
    await git(top, ['worktree', 'add', '-b', br, wt, info.base]);
    Object.assign(info, { worktree: wt, branch: br, root: wt, rel });
    runDir = path.join(wt, rel);
    if (worktreeInit) {
      // 工作区配置的初始化命令（如 npm ci）：失败只记下，不挡任务
      info.init = await new Promise((resolve) => {
        const p = spawn(worktreeInit, { cwd: runDir, shell: true, stdio: 'ignore' });
        const t = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'timeout' }); }, 10 * 60 * 1000);
        p.on('exit', (code) => { clearTimeout(t); resolve({ ok: code === 0, code }); });
        p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.message }); });
      });
    }
  }
  info.cwd = runDir;
  return { cwd: runDir, info, snap: snapshot(info.root) };
}

/** 改过的文件（和快照比） */
function changedFiles(root, before) {
  const after = snapshot(root);
  const out = [];
  for (const [rel, st] of after) {
    const b = before.get(rel);
    if (!b || b.size !== st.size || b.mtimeMs !== st.mtimeMs) out.push({ path: rel, size: st.size });
  }
  return out;
}

/**
 * 结束后：代码改动记成提交、列产出、复制非代码文件到 outbox。
 * @returns {Promise<{ git?: object, artifacts: object[] }>}
 */
async function finalize(prep, taskId) {
  const { info, snap } = prep;
  const root = info.root;
  const out = { artifacts: [] };
  const changed = changedFiles(root, snap);
  let committedPaths = new Set();
  if (info.isGit && info.base) {
    const g = { repo: info.repo, base: info.base, branch: info.branch, worktree: !!info.worktree, ref: null, head: info.base,
      commits: 0, files_changed: 0, insertions: 0, deletions: 0, changed: false };
    let head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    // 还有没提交的：临时索引生成一个提交，不动用户的暂存区和工作区（§8.4.3，git 2.43 验证）
    const dirty = (await git(root, ['status', '--porcelain'])).trim();
    if (dirty && !info.readonly) {
      const idx = path.join(os.tmpdir(), `tb-index-${crypto.randomBytes(6).toString('hex')}`);
      const env = { GIT_INDEX_FILE: idx };
      try {
        await git(root, ['read-tree', 'HEAD'], { env });
        await git(root, ['add', '-A'], { env });
        const tree = (await git(root, ['write-tree'], { env })).trim();
        const headTree = (await git(root, ['rev-parse', 'HEAD^{tree}'])).trim();
        if (tree !== headTree) {
          const who = { GIT_AUTHOR_NAME: 'TokenBank', GIT_AUTHOR_EMAIL: 'mesh@tokenbank.local', GIT_COMMITTER_NAME: 'TokenBank', GIT_COMMITTER_EMAIL: 'mesh@tokenbank.local' };
          head = (await git(root, ['commit-tree', tree, '-p', head, '-m', `tokenbank mesh ${taskId}`], { env: who })).trim();
        }
      } finally { try { fs.unlinkSync(idx); } catch { /* 没生成 */ } }
    }
    if (head !== info.base) {
      const ref = `refs/tokenbank/mesh/${safeId(taskId)}`;
      await git(root, ['update-ref', ref, head]);
      // 在独立工作树里：分支也指过去，这样在那台设备上也能直接看
      if (info.worktree && info.branch) await git(root, ['update-ref', `refs/heads/${info.branch}`, head]).catch(() => {});
      const short = (await git(root, ['diff', '--shortstat', info.base, head])).trim();
      const num = (re) => Number((short.match(re) || [])[1] || 0);
      Object.assign(g, {
        ref, head, changed: true,
        commits: Number((await git(root, ['rev-list', '--count', `${info.base}..${head}`])).trim()) || 0,
        files_changed: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/),
        stat: (await git(root, ['diff', '--stat=100', info.base, head])).split('\n').slice(-30).join('\n').trim(),
      });
      committedPaths = new Set((await git(root, ['diff', '--name-only', info.base, head])).split('\n').filter(Boolean));
    }
    out.git = g;
  }
  // 非代码产出：没进提交的（被 .gitignore 忽略的、或者不是 git 仓库），以及报告、图片这类文件
  const outbox = path.join(OUTBOX(), safeId(taskId));
  let total = 0;
  for (const f of changed.slice(0, 500)) {
    const ext = path.extname(f.path).toLowerCase();
    if (committedPaths.has(f.path) && !BINARY_EXT.has(ext)) continue;
    if (f.size > FILE_MAX) { out.artifacts.push({ path: f.path, size: f.size, too_large: true }); continue; }
    const src = path.join(root, f.path);
    let sha = null;
    try { sha = await sha256File(src); } catch { continue; }
    const art = { path: f.path, size: f.size, sha256: sha, mime: MIME[ext] || 'application/octet-stream' };
    if (total + f.size <= OUTBOX_TASK_MAX) {
      try {
        const dst = path.join(outbox, f.path);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        total += f.size;
        art.snapshot = true;
      } catch { /* 复制失败照样列出 */ }
    }
    out.artifacts.push(art);
    if (out.artifacts.length >= 200) break;
  }
  return out;
}

// ── 拉取（执行端） ──────────────────────────────────────────────────────────

/** git bundle：base..ref，写到 stdout。调用方把它接到 HTTP 响应上 */
function bundleStream(gitInfo, cwd) {
  if (!gitInfo?.ref || !gitInfo?.base) throw Object.assign(new Error('这个任务没有代码改动'), { status: 404 });
  const p = spawn('git', ['bundle', 'create', '-', `${gitInfo.base}..${gitInfo.ref}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  return p;
}

/**
 * 找产出文件：先看 outbox 快照，再看工作区原文件；sha256 对不上就是后来改过了（§8.4.4）
 * @returns {Promise<string>} 本机文件路径
 */
async function locateArtifact(taskId, root, relPath, sha) {
  const rel = String(relPath || '').replace(/^\/+/, '');
  const candidates = [path.join(OUTBOX(), safeId(taskId)), root].filter(Boolean);
  for (const base of candidates) {
    const file = path.resolve(base, rel);
    if (!insideDir(base, file)) throw Object.assign(new Error('路径不在任务目录里'), { status: 400 });
    if (!fs.existsSync(file)) continue;
    if (!sha || (await sha256File(file)) === sha) return file;
  }
  throw Object.assign(new Error('文件后来被改过或已删除（changed）'), { status: 409, code: 'changed' });
}

function insideDir(base, target) {
  let realBase = base;
  let real = target;
  try { realBase = fs.realpathSync(base); } catch { /* 还没建 */ }
  try { real = fs.realpathSync(target); } catch { real = path.resolve(target); }
  const r = path.relative(realBase, real);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

// ── 取回（发起端） ──────────────────────────────────────────────────────────

/**
 * 把 bundle 取进本机仓库的 tb/mesh/<任务号> 分支：只新建分支，不合并、不切换（§8.4.3）。
 * 本机找不到仓库时，bundle 留在收件箱。
 * @param {{ taskId, bundlePath, gitInfo, repoDirs: string[] }} q
 */
async function importBundle({ taskId, bundlePath, gitInfo, repoDirs = [] }) {
  let repo = null;
  for (const d of repoDirs) {
    if (!d || !fs.existsSync(d)) continue;
    const top = await gitTop(d);
    if (!top) continue;
    const slug = require('./workspaces').repoSlug(top);
    const hasBase = await git(top, ['cat-file', '-e', `${gitInfo.base}^{commit}`]).then(() => true, () => false);
    if (hasBase && (!gitInfo.repo || !slug || slug === gitInfo.repo)) { repo = top; break; }
  }
  if (!repo) {
    return { imported: false, bundle: bundlePath, reason: gitInfo.repo ? `本机没找到有基准提交的 ${gitInfo.repo} 仓库，改动放在收件箱，可以 git fetch 它` : '本机没找到对应的仓库，改动放在收件箱' };
  }
  try { await git(repo, ['bundle', 'verify', bundlePath]); } catch (e) {
    return { imported: false, bundle: bundlePath, repo, reason: `bundle 校验没过（本机仓库可能缺基准提交 ${String(gitInfo.base).slice(0, 10)}，先 git fetch）：${e.message}` };
  }
  const branch = `tb/mesh/${shortId(taskId)}`;
  await git(repo, ['fetch', bundlePath, `+${gitInfo.ref}:refs/heads/${branch}`]);
  return { imported: true, repo, branch, head: gitInfo.head, commits: gitInfo.commits, files_changed: gitInfo.files_changed };
}

function inboxPath(taskId, name) {
  const dir = path.join(INBOX(), safeId(taskId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, name);
}

// ── 远程只读查看（§8.4.5） ───────────────────────────────────────────────────

const READ_MAX = 1024 * 1024;

function resolveIn(root, rel) {
  const file = path.resolve(root, String(rel || '').replace(/^\/+/, ''));
  if (!insideDir(root, file)) throw Object.assign(new Error('路径不在工作区里'), { status: 400 });
  return file;
}

function listDir(root, rel) {
  const dir = resolveIn(root, rel);
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '.git')
    .slice(0, 1000)
    .map((e) => {
      let size = null;
      try { if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size; } catch { /* 刚删 */ }
      return { name: e.name, type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other', size };
    });
  return { path: path.relative(root, dir) || '.', entries };
}

function readFile(root, rel, offset = 0, limit = READ_MAX) {
  const file = resolveIn(root, rel);
  const st = fs.statSync(file);
  if (!st.isFile()) throw Object.assign(new Error('不是文件'), { status: 400 });
  const start = Math.max(0, Number(offset) || 0);
  const len = Math.min(READ_MAX, Math.max(0, Number(limit) || READ_MAX), Math.max(0, st.size - start));
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  const binary = buf.includes(0);
  return { path: path.relative(root, file), size: st.size, offset: start, length: len, encoding: binary ? 'base64' : 'utf8',
    content: binary ? buf.toString('base64') : buf.toString('utf8'), eof: start + len >= st.size };
}

async function diff(root, { base, head, rel } = {}) {
  const args = ['diff', '--no-color'];
  if (base) args.push(base);
  if (head) args.push(head);
  if (rel) args.push('--', String(rel));
  const text = await git(root, args);
  return { diff: text.length > READ_MAX ? `${text.slice(0, READ_MAX)}\n…（太长，截断了）` : text, truncated: text.length > READ_MAX };
}

async function log(root, limit = 20) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200);
  const text = await git(root, ['log', `-n${n}`, '--pretty=format:%H%x09%an%x09%ad%x09%s', '--date=iso']);
  return { commits: text.split('\n').filter(Boolean).map((l) => { const [hash, author, date, subject] = l.split('\t'); return { hash, author, date, subject }; }) };
}

module.exports = {
  prepare, finalize, bundleStream, locateArtifact, importBundle, inboxPath, prune,
  listDir, readFile, diff, log, gitTop,
  _internal: { snapshot, changedFiles, insideDir, shortId, safeId },
};
