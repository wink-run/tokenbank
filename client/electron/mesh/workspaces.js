// client/electron/mesh/workspaces.js
// 命名工作区：本机配置「名字 → 路径」。别的设备只传名字，路径不出本机。
// ~/.tokenbank/mesh/workspaces.json
//   { "default": "tokenbank", "workspaces": { "tokenbank": { "path": "~/code/tokenbank" } } }
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function file(dir) { return path.join(dir, 'workspaces.json'); }

function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

function read(dir) {
  try {
    const d = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    return {
      default: typeof d.default === 'string' ? d.default : '',
      workspaces: d.workspaces && typeof d.workspaces === 'object' ? d.workspaces : {},
    };
  } catch { return { default: '', workspaces: {} }; }
}

function write(dir, cfg) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(dir), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** git 远程地址 → owner/name，用于跨设备按仓库匹配同一个项目 */
function repoSlug(dirPath) {
  try {
    const url = execFileSync('git', ['-C', dirPath, 'config', '--get', 'remote.origin.url'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
    const m = url.replace(/\.git$/, '').match(/[/:]([^/:]+)\/([^/]+)$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

/** 给设备目录用：只有名字和仓库标识，没有路径 */
function listPublic(dir) {
  const cfg = read(dir);
  return Object.entries(cfg.workspaces).map(([name, w]) => {
    const p = expandHome(w && w.path);
    return { name, repo: p ? repoSlug(p) : null, default: name === cfg.default };
  });
}

/**
 * 名字 → 本机路径。
 * 没传名字时用默认工作区；都没有返回 null（调用方决定用家目录还是报错）。
 * 传了名字但没配，抛错。
 */
function resolve(dir, name) {
  const cfg = read(dir);
  const wanted = String(name || '').trim() || cfg.default;
  if (!wanted) return null;
  const hit = cfg.workspaces[wanted];
  if (!hit || !hit.path) {
    const err = new Error(`这台设备没有工作区 ${wanted}`);
    err.status = 404;
    throw err;
  }
  const p = path.resolve(expandHome(hit.path));
  if (!fs.existsSync(p)) {
    const err = new Error(`工作区 ${wanted} 的目录不存在`);
    err.status = 409;
    throw err;
  }
  return p;
}

module.exports = { read, write, listPublic, resolve, repoSlug, expandHome };
