// client/electron/tokenbank-mcp-local.js
// 应用里的 tokenbank 桥起的 MCP：要用应用自己的项目目录或系统权限的（文件、git、浏览器、终端、电脑操作），
// 不能在 Token Bank 进程里跑，就由桥在应用里起子进程，工具和网关给的一起列给模型。
//
// 清单从网关 GET /mcp/<应用>/local 取，存一份在 ~/.tokenbank/mcp/app-local/<应用>.json：
// Token Bank 没开时照样能起、能用；工具列表也存着，应用连上时马上给出来，不等子进程起完。
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const CACHE_DIR = path.join(os.homedir(), '.tokenbank', 'mcp', 'app-local');

function cachePath(cid) {
  return path.join(CACHE_DIR, `${String(cid || 'default').replace(/[^\w.-]/g, '_')}.json`);
}

function readCache(cid) {
  try {
    const j = JSON.parse(fs.readFileSync(cachePath(cid), 'utf8'));
    return { servers: Array.isArray(j?.servers) ? j.servers : [], tools: j?.tools && typeof j.tools === 'object' ? j.tools : {} };
  } catch { return { servers: [], tools: {} }; }
}

function writeCache(cid, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(cid), JSON.stringify(data, null, 2), 'utf8');
  } catch { /* 写不了就下次再取 */ }
}

function signature(s) {
  return JSON.stringify([s.command || '', s.args || [], s.cwd || '', s.env || {}]);
}

/** 从网关取清单；没开 / 超时返回 null（用缓存） */
function fetchServers(gw, cid, timeoutMs = 2000) {
  if (!gw || !cid) return Promise.resolve(null);
  return new Promise((resolve) => {
    let url;
    try { url = new URL(`${gw.base}/mcp/${encodeURIComponent(cid)}/local`); } catch { resolve(null); return; }
    const req = http.request(url, { method: 'GET', headers: { Authorization: `Bearer ${gw.token}`, Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(Array.isArray(j?.servers) ? j.servers : null);
        } catch { resolve(null); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** 一个子进程 MCP（换行分隔的 JSON-RPC） */
class LocalChild {
  constructor(server) {
    this.server = server;
    this.prefix = server.prefix || 'mcp';
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.ready = null;
    this.tools = null;
  }

  ensure() {
    if (!this.ready) {
      this.ready = this._start().catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  async _start() {
    const s = this.server;
    if (!s.command) throw new Error(`${s.name} 没有启动命令`);
    let command = s.command;
    if (/^\.{1,2}[\\/]/.test(command) && s.cwd) command = path.resolve(s.cwd, command);
    // 在应用的项目目录里起（插件类的命令自带目录的，在它自己的目录里起）
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : process.cwd();
    this.proc = spawn(command, Array.isArray(s.args) ? s.args : [], {
      cwd,
      env: { ...process.env, ...(s.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && !/\.(exe|com)$/i.test(command),
      windowsHide: true,
    });
    const fail = (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    };
    this.proc.on('error', (e) => fail(new Error(`${s.name} 起不来：${e.message}`)));
    this.proc.on('exit', () => fail(new Error(`${s.name} 退出了`)));
    // 子进程的日志不能混进应用读的 stdout
    this.proc.stderr?.on('data', (b) => { try { process.stderr.write(`[${s.name}] ${b}`); } catch { /* ignore */ } });
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(String(line || '').trim()); } catch { return; }
      if (msg?.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tokenbank', version: '2' },
    }, 30000);
    this.notify('notifications/initialized', {});
    const listed = await this.request('tools/list', {}, 30000);
    this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
  }

  notify(method, params) {
    try { this.proc?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* 已退出 */ }
  }

  request(method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) { reject(new Error(`${this.server.name} 没在运行`)); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.server.name} ${method} 超时`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async call(rawName, args) {
    await this.ensure();
    return this.request('tools/call', { name: rawName, arguments: args || {} });
  }

  stop() {
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
    this.ready = null;
  }
}

function present(child, tools) {
  return (tools || []).map((t) => ({
    ...t,
    name: `${child.prefix}__${t.name}`,
    description: t.description || t.name,
  }));
}

/**
 * 管一个应用里的这些子进程。
 * @param {{ clientId: string, gateway: () => ({base,token}|null) }} opts
 */
function createLocalHost({ clientId, gateway }) {
  const cid = String(clientId || '').trim();
  const children = new Map(); // id → LocalChild
  let cache = readCache(cid);
  let loaded = null;

  function apply(servers) {
    const want = new Map((servers || []).filter((s) => s?.id && s.command).map((s) => [s.id, s]));
    for (const [id, child] of children) {
      if (!want.has(id) || signature(want.get(id)) !== signature(child.server)) { child.stop(); children.delete(id); }
    }
    for (const [id, s] of want) if (!children.has(id)) children.set(id, new LocalChild(s));
  }

  /** 取清单（Token Bank 没开用上次存的） */
  async function refresh() {
    const fresh = await fetchServers(typeof gateway === 'function' ? gateway() : null, cid);
    if (fresh) {
      const keep = {};
      for (const s of fresh) if (cache.tools[s.id] && cache.tools[s.id].sig === signature(s)) keep[s.id] = cache.tools[s.id];
      cache = { servers: fresh, tools: keep };
      writeCache(cid, cache);
    }
    apply(cache.servers);
  }

  function load() {
    if (!loaded) loaded = refresh().catch(() => apply(cache.servers));
    return loaded;
  }

  /** 列工具：等子进程最多 waitMs，没起完的先用上次存的工具列表，后台接着起 */
  async function listTools(waitMs = 3000) {
    loaded = null; // 每次列工具都重取清单：在 Token Bank 里改了，应用重连就生效
    await load();
    const out = [];
    await Promise.all([...children.values()].map(async (child) => {
      const started = child.ensure().then(() => {
        cache.tools[child.server.id] = { sig: signature(child.server), tools: child.tools || [] };
        writeCache(cid, cache);
        return child.tools || [];
      });
      started.catch(() => {});
      let timer;
      const tools = await Promise.race([
        started.catch(() => null),
        new Promise((r) => { timer = setTimeout(() => r(null), waitMs); }),
      ]);
      clearTimeout(timer);
      const use = tools || cache.tools[child.server.id]?.tools || [];
      out.push(...present(child, use));
    }));
    return out;
  }

  /** 这个工具名是不是本地子进程的：是就返回 { child, raw } */
  function owner(name) {
    const n = String(name || '');
    for (const child of children.values()) {
      const p = `${child.prefix}__`;
      if (n.startsWith(p)) return { child, raw: n.slice(p.length) };
    }
    return null;
  }

  async function call(name, args) {
    await load();
    const hit = owner(name);
    if (!hit) return null;
    return hit.child.call(hit.raw, args);
  }

  function stopAll() {
    for (const child of children.values()) child.stop();
  }

  return { load, listTools, owner, call, stopAll, _children: children };
}

module.exports = { createLocalHost, readCache, cachePath, LocalChild };
