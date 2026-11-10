// client/electron/resource-canonical.js
// Skill 权威目录：用户安装位置（不复制到 ~/.tokenbank）
'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolvePath(p) {
  return path.resolve(p);
}

function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 路径是否同一位置（Windows 忽略大小写） */
function pathsEqual(a, b) {
  if (!a || !b) return false;
  const left = resolvePath(a);
  const right = resolvePath(b);
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/** 将路径规范为 Skill 目录（兼容旧版 SKILL.md 路径） */
function normalizeSkillDirPath(targetPath, resourceName) {
  if (!targetPath) return null;
  const base = path.basename(targetPath);
  if (/^skill\.md$/i.test(base)) return path.dirname(targetPath);
  return targetPath;
}

function isRealSkillDir(dir) {
  if (!dir || !pathExists(dir)) return false;
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return ['SKILL.md', 'skill.md', 'meta.json'].some(f => fs.existsSync(path.join(dir, f)));
}

/**
 * 真实技能目录：本身是真实目录就用它；是软链就顺着链接找到真身再判断。
 * 软链本身永远不当权威（撤投射会删掉它），但它指向的真实目录可以。
 */
function realSkillDir(dir) {
  if (!dir) return null;
  if (isRealSkillDir(dir)) return resolvePath(dir);
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) {
      const real = fs.realpathSync(dir);
      if (isRealSkillDir(real)) return real;
    }
  } catch { /* 断链 */ }
  return null;
}

/** 从 metadata 解析权威目录（兼容旧 canonicalPath；记录里存成软链位置的，顺着链接找真身；最后看 source_url） */
function resolveAuthorityDir(resource) {
  const meta = resource?.metadata || {};
  const src = String(resource?.source_url || '');
  const hints = [meta.authorityPath, meta.scannedFrom, meta.canonicalPath,
    (src.startsWith('/') || /^[A-Za-z]:[\\/]/.test(src)) ? src : null].filter(Boolean);
  for (const hint of hints) {
    const dir = realSkillDir(normalizeSkillDirPath(hint, resource?.name));
    if (dir) return dir;
  }
  return null;
}

/** 递归复制目录（软链失败回退用） */
function copyDirRecursive(src, dest) {
  ensureDir(dest);
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, ent.name);
    const destPath = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 推荐打包时跳过的目录。与 resource-skill-scanner 的 SKIP_DIR_NAMES 对齐，
 * 并加上版本库目录，避免把整个 git 仓库或依赖树塞进社区目录。
 */
const SKILL_PACK_SKIP_DIRS = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', '.next', '__pycache__', '.cache',
  '.venv', 'venv', 'target', 'coverage', '.turbo', '.pnpm-store', 'Pods',
  '.idea', '.vscode', 'DerivedData', 'out', '.output',
  '.svn', '.hg',
]);
const SKILL_PACK_SKIP_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
// 体检扫描的 256KB 只覆盖文本，会丢掉字体和图片。这里放宽到单文件 2MB、合计 8MB。
const SKILL_PACK_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SKILL_PACK_MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const SKILL_PACK_MAX_FILES = 200;
const SKILL_PACK_MAX_DEPTH = 8;

/** 根上的 SKILL.md 以 content 为准，不从 files 再写一遍 */
function isRootSkillMarkdown(rel) {
  return /^skill\.md$/i.test(String(rel || ''));
}

/**
 * metadata.files[].path：技能目录下的相对 POSIX 路径。
 * 拒绝绝对路径、盘符、反斜杠、空段、`.` 和 `..`。
 */
function isSafeSkillRelativePath(rel) {
  if (typeof rel !== 'string') return false;
  if (!rel || rel.length > 512) return false;
  if (rel.includes('\\') || rel.includes('\0')) return false;
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split('/');
  if (!parts.length) return false;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return false;
  }
  return true;
}

/** 相对路径是否仍落在 root 真实目录之内（含 .. 前缀与绝对路径） */
function staysInside(root, target) {
  const rel = path.relative(root, target);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * 解析到技能根目录之内。
 * 已存在的祖先目录若是指向外部的符号链接，也拒绝（mkdir 会跟着链写出去）。
 */
function resolveSkillFile(root, relPosix) {
  if (!isSafeSkillRelativePath(relPosix)) return null;
  const dest = path.resolve(root, ...relPosix.split('/'));
  if (!staysInside(root, dest)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    let cursor = path.dirname(dest);
    while (!fs.existsSync(cursor)) {
      const next = path.dirname(cursor);
      if (next === cursor) return null;
      cursor = next;
    }
    const realCursor = fs.realpathSync(cursor);
    if (realCursor !== realRoot && !staysInside(realRoot, realCursor)) return null;
  } catch {
    return null;
  }
  return dest;
}

/** encoding 省略或 utf8 为文本；base64 为二进制。其它编码拒绝。 */
function decodeCompanionContent(file) {
  if (!file || typeof file !== 'object') return null;
  const encoding = file.encoding == null || file.encoding === ''
    ? 'utf8'
    : String(file.encoding).toLowerCase();
  const raw = file.content == null ? '' : String(file.content);
  if (encoding === 'utf8' || encoding === 'utf-8') return Buffer.from(raw, 'utf8');
  if (encoding === 'base64') return Buffer.from(raw, 'base64');
  return null;
}

/**
 * 把 metadata.files 写进技能目录。
 * onlyMissing：已存在的文件保留（再次纳管只补缺）。
 * 根目录 SKILL.md 一律跳过，正文仍以 content 为准。
 */
function writeSkillCompanionFiles(skillDir, files, { onlyMissing = false } = {}) {
  const written = [];
  const skipped = [];
  const rejected = [];
  if (!Array.isArray(files) || !files.length || !skillDir) {
    return { written, skipped, rejected };
  }
  const root = resolvePath(skillDir);
  try { ensureDir(root); } catch {
    return { written, skipped, rejected };
  }
  for (const file of files) {
    const rel = file && typeof file.path === 'string' ? file.path.trim() : '';
    if (!rel) {
      rejected.push('(empty)');
      continue;
    }
    if (isRootSkillMarkdown(rel)) {
      skipped.push(rel);
      continue;
    }
    const dest = resolveSkillFile(root, rel);
    if (!dest) {
      rejected.push(rel);
      continue;
    }
    const buf = decodeCompanionContent(file);
    if (!buf) {
      rejected.push(rel);
      continue;
    }
    try {
      if (fs.existsSync(dest)) {
        const st = fs.lstatSync(dest);
        if (st.isDirectory() || st.isSymbolicLink()) {
          skipped.push(rel);
          continue;
        }
        if (onlyMissing) {
          skipped.push(rel);
          continue;
        }
      }
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, buf);
      written.push(rel);
    } catch {
      rejected.push(rel);
    }
  }
  if (rejected.length) {
    console.warn('[resource-canonical] 跳过无法写入的技能配套路径:', rejected.join(', '));
  }
  return { written, skipped, rejected };
}

/** 只补磁盘上还没有的配套文件，不覆盖用户已有内容 */
function fillMissingSkillFiles(skillDir, files) {
  return writeSkillCompanionFiles(skillDir, files, { onlyMissing: true });
}

function bufferIsBinary(buf) {
  if (buf.includes(0)) return true;
  return !buf.equals(Buffer.from(buf.toString('utf8'), 'utf8'));
}

/**
 * 从技能目录（含 SKILL.md 的那一层）收集配套文件，供推荐接口的 metadata.files。
 * 不包含根上的 SKILL.md，不跟随符号链接，跳过 .git / node_modules 等。
 * @returns {Array<{path: string, content: string, encoding?: string}>}
 */
function packSkillCompanionFiles(skillDir) {
  const normalized = normalizeSkillDirPath(skillDir);
  if (!normalized) return [];
  let root;
  try {
    root = fs.realpathSync(normalized);
    if (!fs.statSync(root).isDirectory()) return [];
  } catch {
    return [];
  }

  const out = [];
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > SKILL_PACK_MAX_DEPTH || out.length >= SKILL_PACK_MAX_FILES) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of ents) {
      if (out.length >= SKILL_PACK_MAX_FILES) return;
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKILL_PACK_SKIP_DIRS.has(ent.name)) continue;
        walk(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (SKILL_PACK_SKIP_FILES.has(ent.name.toLowerCase())) continue;
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!isSafeSkillRelativePath(rel) || isRootSkillMarkdown(rel)) continue;
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile() || st.size > SKILL_PACK_MAX_FILE_BYTES) continue;
      if (total + st.size > SKILL_PACK_MAX_TOTAL_BYTES) continue;
      let buf;
      try { buf = fs.readFileSync(abs); } catch { continue; }
      total += buf.length;
      if (bufferIsBinary(buf)) {
        out.push({ path: rel, content: buf.toString('base64'), encoding: 'base64' });
      } else {
        out.push({ path: rel, content: buf.toString('utf8') });
      }
    }
  };
  walk(root, 0);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * 在目标 Agent 首次安装目录写入 Skill（仅目录市场纳管、尚无本机副本时）。
 * files 为 metadata.files；根上的 SKILL.md 只写 content。
 */
function materializeSkillDir(skillDir, content, files) {
  ensureDir(skillDir);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content || '', 'utf8');
  writeSkillCompanionFiles(skillDir, files, { onlyMissing: false });
  return resolvePath(skillDir);
}

/** 将 DB 内容同步到已有权威目录（SKILL.md + 配套文件；不新建 TB 副本） */
function syncSkillContentToAuthority(authorityDir, content, files) {
  if (!authorityDir || !isRealSkillDir(authorityDir)) return null;
  fs.writeFileSync(path.join(authorityDir, 'SKILL.md'), content || '', 'utf8');
  writeSkillCompanionFiles(authorityDir, files, { onlyMissing: false });
  return resolvePath(authorityDir);
}

module.exports = {
  realSkillDir,
  normalizeSkillDirPath,
  resolveAuthorityDir,
  isRealSkillDir,
  materializeSkillDir,
  syncSkillContentToAuthority,
  writeSkillCompanionFiles,
  fillMissingSkillFiles,
  packSkillCompanionFiles,
  isSafeSkillRelativePath,
  copyDirRecursive,
  resolvePath,
  pathExists,
  pathsEqual,
  SKILL_PACK_MAX_FILE_BYTES,
  SKILL_PACK_SKIP_DIRS,
};
