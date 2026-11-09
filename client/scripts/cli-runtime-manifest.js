// CLI / Docker 与桌面版共用的 electron 运行时清单（单一真相源）
'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT_ROOT = path.join(__dirname, '..');
const ELECTRON_ROOT = path.join(CLIENT_ROOT, 'electron');

/** CLI 入口（与 Dockerfile.cli / gateway 一致） */
const CLI_ENTRY_POINTS = [
  path.join(CLIENT_ROOT, 'cli', 'gateway.js'),
  path.join(CLIENT_ROOT, 'cli', 'admin-api.js'),
  path.join(CLIENT_ROOT, 'cli', 'agent-control.js'),
  path.join(CLIENT_ROOT, 'cli', 'ipc-bridge.js'),
  path.join(CLIENT_ROOT, 'cli', 'electron-stub.js'),
  // 资产管理与命令行智能体纳管：ipc-bridge 运行时才 require，静态扫描需显式列出
  path.join(CLIENT_ROOT, 'electron', 'ipc-handlers-resource.js'),
  path.join(CLIENT_ROOT, 'electron', 'ipc-handlers-agent.js'),
];

/**
 * 仅 Electron 桌面壳使用，CLI/Docker 镜像中可安全删除。
 * 桌面版 electron-builder 仍打包完整 electron 目录（含这些文件）。
 */
// detect-tools / agent-linker / shim-installer 等纯 Node 模块保留在 CLI：命令行智能体探测与接入网关要用
const DESKTOP_ONLY_FILES = new Set([
  'main.js',
  'preload.js',
  'entitlements.mac.plist',
  'entitlements.mac.inherit.plist',
]);

const DESKTOP_ONLY_DIRS = new Set([
  '__tests__',
]);

function isDesktopOnly(absPath) {
  const rel = path.relative(ELECTRON_ROOT, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep).filter(Boolean);
  if (!parts.length) return false;
  if (DESKTOP_ONLY_DIRS.has(parts[0])) return true;
  if (parts.length === 1 && DESKTOP_ONLY_FILES.has(parts[0])) return true;
  return false;
}

/** 解析 require 相对路径 → 绝对路径（仅处理 ./ ../） */
function resolveRequire(fromFile, reqPath) {
  if (!reqPath.startsWith('.')) return null;
  let base = path.resolve(path.dirname(fromFile), reqPath);
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    const idx = path.join(base, 'index.js');
    if (fs.existsSync(idx)) return idx;
  }
  if (fs.existsSync(base)) return base;
  if (fs.existsSync(`${base}.js`)) return `${base}.js`;
  if (fs.existsSync(`${base}.json`)) return `${base}.json`;
  return base.endsWith('.js') ? base : `${base}.js`;
}

/** 检查require语句是否在try-catch中（简单启发式） */
function isRequireOptional(src, requireIndex) {
  // 向后查找，计算未闭合的try块数量
  const before = src.substring(Math.max(0, requireIndex - 1000), requireIndex);
  
  // 统计try和对应的catch
  let openTries = 0;
  let lastTryPos = -1;
  
  // 查找所有try关键字
  const tryRe = /\btry\s*\{/g;
  let match;
  while ((match = tryRe.exec(before))) {
    openTries++;
    lastTryPos = match.index;
  }
  
  if (openTries === 0) return false;
  
  // 从最后一个try之后统计大括号平衡
  const afterLastTry = before.substring(lastTryPos);
  let braceCount = 0;
  for (let i = 0; i < afterLastTry.length; i++) {
    if (afterLastTry[i] === '{') braceCount++;
    else if (afterLastTry[i] === '}') braceCount--;
  }
  
  // 如果大括号还有未闭合的，说明require在try块内
  if (braceCount > 0) {
    // 检查后面是否有catch
    const after = src.substring(requireIndex, Math.min(src.length, requireIndex + 500));
    return /\}\s*catch|catch\s*[\({]/.test(after) || /catch/.test(after);
  }
  
  return false;
}

/** 静态扫描 require()，收集 CLI 运行时依赖的本地 JS 文件 */
function collectRequiredLocalFiles(entryPath, seen = new Set(), missing = []) {
  if (seen.has(entryPath)) return { seen, missing };
  if (!fs.existsSync(entryPath)) {
    missing.push({ from: entryPath, req: '(entry missing)' });
    return { seen, missing };
  }
  seen.add(entryPath);

  const src = fs.readFileSync(entryPath, 'utf8');
  const re = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const req = m[1];
    const resolved = resolveRequire(entryPath, req);
    if (!resolved) continue;
    // 只追踪 client 目录内的源码
    if (!resolved.startsWith(CLIENT_ROOT)) continue;
    if (!fs.existsSync(resolved)) {
      // 检查是否是可选依赖（在try-catch中）
      const optional = isRequireOptional(src, m.index);
      if (!optional) {
        missing.push({ from: entryPath, req, resolved });
      }
      continue;
    }
    if (resolved.endsWith('.js')) {
      collectRequiredLocalFiles(resolved, seen, missing);
    }
  }
  return { seen, missing };
}

/** 从 CLI 入口递归收集全部依赖 */
function collectCliRuntimeDeps() {
  const seen = new Set();
  const missing = [];
  for (const entry of CLI_ENTRY_POINTS) {
    collectRequiredLocalFiles(entry, seen, missing);
  }
  return { files: [...seen].sort(), missing };
}

/** 剪枝后 electron 目录应仍能满足 CLI 依赖 */
function validatePrunedElectron(electronRoot = ELECTRON_ROOT) {
  const { files, missing } = collectCliRuntimeDeps();
  const prunedMissing = [];
  for (const f of files) {
    if (!f.startsWith(electronRoot)) continue;
    if (isDesktopOnly(f)) continue;
    const rel = path.relative(electronRoot, f);
    const check = path.join(electronRoot, rel);
    if (!fs.existsSync(check)) prunedMissing.push(check);
  }
  return { missing, prunedMissing, requiredElectron: files.filter(f => f.startsWith(ELECTRON_ROOT)) };
}

module.exports = {
  CLIENT_ROOT,
  ELECTRON_ROOT,
  CLI_ENTRY_POINTS,
  DESKTOP_ONLY_FILES,
  DESKTOP_ONLY_DIRS,
  isDesktopOnly,
  collectCliRuntimeDeps,
  validatePrunedElectron,
};
