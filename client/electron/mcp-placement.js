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
  const norm = (x) => (process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() : x);
  const rel = path.relative(norm(b), norm(a));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 通用的运行时 / 命令行：在程序包里也不算某个应用自己的东西（Docker.app 里的 docker 等） */
const GENERIC_BIN = /^(node|nodejs|npx|npm|pnpm|yarn|bun|bunx|deno|python\d*(\.\d+)?|pip\d*|uv|uvx|pipx|ruby|java|go|docker|podman|git|bash|sh|zsh|pwsh|powershell|cmd)(\.exe|\.cmd)?$/i;

const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * 命令 / 工作目录在哪个程序包或应用私有目录里。返回 { private: bool, appId: '' }：
 * private = 在某个 .app 程序包、Windows 的 Programs\X、或某个应用自己的目录里（不是通用运行时）；
 * appId   = 能从目录名直接认出是哪个应用时给出（~/.codex、Codex.app、Codex Computer Use.app…）
 */
function locate(row) {
  const meta = metaOf(row);
  const cmd = String(row.command || '');
  const cwd = String(meta.cwd || '');
  if (!cmd && !cwd) return { private: false, appId: '' };
  const relCmd = /^\.{1,2}[\\/]/.test(cmd);
  const paths = [cwd && relCmd ? path.resolve(cwd, cmd) : cmd, cwd].filter((x) => x && path.isAbsolute(x));
  if (!paths.length) return { private: false, appId: '' };
  if (GENERIC_BIN.test(path.basename(cmd)) && !relCmd) return { private: false, appId: '' };
  // 应用自己的目录（~/.codex、~/.cursor、~/.claude…）
  for (const { id, dir } of appHomeDirs()) {
    if (paths.some((x) => under(x, dir))) return { private: true, appId: id };
  }
  const home = path.resolve(os.homedir());
  const names = labelsOf().map(({ id, label }) => ({ id, names: [...new Set([norm(label), norm(id)])].filter((n) => n.length >= 4) }));
  let inBundle = false;
  for (const x of paths) {
    const rest = under(x, home) ? path.relative(home, x) : x;
    const segs = rest.split(/[\\/]+/).filter(Boolean);
    const lower = rest.toLowerCase();
    const bundle = segs.some((g) => /\.app$/i.test(g)) || /[\\/]programs[\\/]|program files/.test(lower) || /application support/.test(lower);
    if (!bundle) continue;
    inBundle = true;
    for (const g of segs) {
      const n = norm(g.replace(/\.app$/i, ''));
      const tail = norm(g.split('.').pop());
      for (const a of names) {
        if (a.names.some((m) => n === m || tail === m || (/\.app$/i.test(g) && n.startsWith(m)))) return { private: true, appId: a.id };
      }
    }
  }
  return { private: inBundle, appId: '' };
}

/**
 * 看这个 MCP 是不是某个应用专属的，返回应用 id；不是返回 ''。
 * @param {object} row  command/args/url/metadata（cwd、originAgents）
 * @param {{ gatewayPorts?: number[], holders?: string[] }} [opts]
 *   holders：现在自己配置里有这一条的应用（不算 Token Bank 写进去的），以它为准，导入记录可能过时
 */
function detectExclusiveOwner(row, opts = {}) {
  if (!row) return '';
  const meta = metaOf(row);
  const origins = Array.isArray(meta.originAgents) ? meta.originAgents.filter(Boolean).map(String) : [];
  const holders = Array.isArray(opts.holders) ? opts.holders.filter(Boolean).map(String) : [];
  const pick = () => holders[0] || origins[0] || '';
  // 本机服务：只有开着它的那个应用才连得上（WorkBuddy 的 connector-proxy 这类）
  if (isUrlRow(row)) {
    const u = String(row.url || meta.url || '');
    if (isLocalHost(u) && !isTokenbankUrl(u, opts.gatewayPorts || [])) return pick();
    return '';
  }
  // 命令在某个应用的程序包 / 私有目录里：能认出是谁的就是谁的；
  // 认不出（比如 Codex 的工具装在 ChatGPT.app 里）就归现在配置里有它的那个应用
  const where = locate(row);
  if (!where.private) return '';
  if (where.appId && (!holders.length || holders.includes(where.appId))) return where.appId;
  return pick() || where.appId;
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
