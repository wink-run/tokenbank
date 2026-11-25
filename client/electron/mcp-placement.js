// client/electron/mcp-placement.js
// 每个 MCP 只记「给哪些应用用」（metadata.gateway_clients），应用配置里只有一条 tokenbank。
// 在哪里跑由这里判断：
//   - app：要用应用自己的项目目录或系统权限（文件、git、浏览器、终端、电脑操作）→ 应用里的 tokenbank 桥接起子进程
//   - gateway：其它的在 Token Bank 网关里起，一份进程给所有应用用
// 应用专属（metadata.exclusive_to）：从某个应用导入、又依赖那个应用自己东西的 MCP（命令在那个应用的目录或程序包里，
// 或地址是那个应用在本机开的服务），只能给那个应用，免得别的应用起不来或者连错。
'use strict';

const os = require('os');
const path = require('path');

/** 要用应用环境的本地 MCP：名字、包名里带这些词（和界面上的判断一致） */
const APP_CONTEXT_MCP = /(^|[-_\s/@.])(filesystem|files?|fs|git|puppeteer|playwright|browser|chrome|shell|terminal|desktop-commander|desktop|computer-use|computer_use|computer|sqlite|obsidian)([-_\s/]|$)/i;

function isUrlRow(row) {
  return !!String(row?.url || '').trim() || ['http', 'sse'].includes(String(row?.type || '').toLowerCase());
}

function argsOf(row) {
  if (Array.isArray(row?.args)) return row.args;
  try { const a = JSON.parse(row?.args || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

function metaOf(row) {
  const m = row?.metadata;
  if (m && typeof m === 'object') return m;
  try { return JSON.parse(m || '{}') || {}; } catch { return {}; }
}

function needsAppContext(row) {
  if (!row) return false;
  if (isUrlRow(row)) return false;
  const meta = metaOf(row);
  const kind = meta.tool_kind;
  if (kind === 'api' || kind === 'cli') return false;
  if (meta.categoryGroup === 'filesystem') return true;
  return APP_CONTEXT_MCP.test(`${row.id || ''} ${row.name || ''} ${argsOf(row).join(' ')}`);
}

/** 'app' | 'gateway'。远程地址只能在网关里连；用户手动指定过的（metadata.runs_in）为准 */
function runsIn(row) {
  if (!row) return 'gateway';
  if (isUrlRow(row)) return 'gateway';
  const forced = metaOf(row).runs_in;
  if (forced === 'app' || forced === 'gateway') return forced;
  return needsAppContext(row) ? 'app' : 'gateway';
}

/** 各应用自己的目录（配置所在目录；是家目录本身的不算，比如 ~/.claude.json） */
function appHomeDirs() {
  const out = [];
  let targets = {};
  try { targets = require('./mcp-agent-targets').AGENT_MCP_TARGETS || {}; } catch { /* 没有 */ }
  const home = path.resolve(os.homedir());
  for (const [id, t] of Object.entries(targets)) {
    let paths = [];
    try { paths = typeof t.getPaths === 'function' ? t.getPaths() : []; } catch { paths = []; }
    for (const p of paths) {
      const dir = path.resolve(path.dirname(String(p || '')));
      if (!dir || dir === home || dir === path.parse(dir).root) continue;
      out.push({ id, label: t.label || id, dir });
    }
  }
  return out;
}

function labelsOf() {
  try {
    const targets = require('./mcp-agent-targets').AGENT_MCP_TARGETS || {};
    return Object.entries(targets).map(([id, t]) => ({ id, label: String(t.label || id) }));
  } catch { return []; }
}

function isLocalHost(u) {
  try {
    const h = new URL(String(u)).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
  } catch { return false; }
}

function isTokenbankUrl(u, gatewayPorts = []) {
  try {
    const url = new URL(String(u));
    if (/\/mcp(\/|$)/.test(url.pathname) && gatewayPorts.map(String).includes(String(url.port))) return true;
  } catch { /* 不是地址 */ }
  return false;
}

/** 路径 p 是否在 dir 里（大小写按平台） */
function under(p, dir) {
  const a = path.resolve(String(p));
  const b = path.resolve(String(dir));
  const norm = (s) => (process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s);
  const rel = path.relative(norm(b), norm(a));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 看这个 MCP 是不是某个应用专属的，返回应用 id；不是返回 ''。
 * @param {object} row  command/args/url/metadata（cwd、originAgents）
 * @param {{ gatewayPorts?: number[] }} [opts]
 */
function detectExclusiveOwner(row, opts = {}) {
  if (!row) return '';
  const meta = metaOf(row);
  const origins = Array.isArray(meta.originAgents) ? meta.originAgents.filter(Boolean).map(String) : [];
  // 本机服务：只有开着它的那个应用才连得上（WorkBuddy 的 connector-proxy 这类）
  if (isUrlRow(row)) {
    const u = String(row.url || meta.url || '');
    if (origins.length && isLocalHost(u) && !isTokenbankUrl(u, opts.gatewayPorts || [])) return origins[0];
    return '';
  }
  const blobs = [String(row.command || ''), String(meta.cwd || ''), ...argsOf(row).map(String)].filter(Boolean);
  // 命令、工作目录在某个应用自己的目录里（~/.codex/plugins/... 这类）
  for (const { id, dir } of appHomeDirs()) {
    if (blobs.some((b) => path.isAbsolute(b) && under(b, dir))) return id;
  }
  // 命令在某个应用的程序包里（/Applications/Codex.app/...、Windows 的 Programs\Cursor\...）
  for (const { id, label } of labelsOf()) {
    const name = label.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!name || name.length < 3) continue;
    const hit = blobs.some((b) => {
      const s = b.toLowerCase();
      return s.split(/[\\/]/).some((seg) => {
        const bare = seg.replace(/\.app$/, '').replace(/[^a-z0-9]+/g, '');
        return bare === name && (seg.endsWith('.app') || /[\\/]programs[\\/]/.test(s));
      });
    });
    if (hit) return id;
  }
  return '';
}

/** 专属的 MCP 给这个应用行不行（含别名：codex / codex-desktop 算一个） */
function allowedFor(row, clientId) {
  const owner = String(metaOf(row).exclusive_to || '').trim();
  if (!owner) return true;
  const cid = String(clientId || '').trim();
  if (!cid) return false;
  let same = [cid];
  try { same = [cid, ...require('./mcp-agent-targets').expandMcpClientMatchIds(cid)]; } catch { /* 无别名 */ }
  let ownerIds = [owner];
  try { ownerIds = [owner, ...require('./mcp-agent-targets').expandMcpClientMatchIds(owner)]; } catch { /* 无别名 */ }
  return same.some((x) => ownerIds.includes(x));
}

function appLabel(id) {
  return labelsOf().find((x) => x.id === id)?.label || id;
}

module.exports = {
  APP_CONTEXT_MCP,
  needsAppContext,
  runsIn,
  detectExclusiveOwner,
  allowedFor,
  appHomeDirs,
  appLabel,
  isUrlRow,
};
