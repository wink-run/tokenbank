// mcp-gateway-server.js
// 内置中转 MCP：按应用聚合已绑定的纳管 MCP（stdio + 远程 HTTP），对外暴露 HTTP 入口，
// 供无法直接写盘投射、或希望简化配置的应用一条配置接入。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { plainToolCallName, plainToolSchema, callPlainTool } = require('./plain-tool-call');

const TB_DIR = path.join(os.homedir(), '.tokenbank');
const INFO_PATH = path.join(TB_DIR, 'mcp-gateway.json');
/** 固定端口，便于用户复制配置；冲突时回退 0 */
const PREFERRED_PORT = 11431;

let server = null;
let endpoint = null;
/** 非内置 stdio MCP：全应用共享一份后端，按 id 复用 @type {Map<string, StdioBackend>} */
const backends = new Map();
/** 内置 prompts/resources/models：按应用 cid 各起一份（TB_CLIENT_ID=cid 门控可见集）@type {Map<string, StdioBackend>} */
const builtinBackends = new Map();
/** 当前可代理的路由行（stdio + 内置），id → row */
let routedRows = new Map();
let getRoutedServers = () => [];

/** 需按 cid 分别起后端的内置中转 MCP（其可见集随 TB_CLIENT_ID 变化） */
const BUILTIN_RELAY_IDS = new Set([
  'tokenbank-prompts',
  'tokenbank-models',
  'tokenbank-resources',
]);
function isBuiltinRelayId(id) {
  return BUILTIN_RELAY_IDS.has(String(id || ''));
}
/** 内置后端按 (id, cid) 唯一 */
function builtinKey(id, cid) {
  return `${id}::${cid || ''}`;
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function writeInfo(info) {
  fs.mkdirSync(TB_DIR, { recursive: true });
  fs.writeFileSync(INFO_PATH, JSON.stringify(info, null, 2), 'utf8');
  endpoint = info;
}

function getGatewayEndpoint() {
  if (endpoint?.url && endpoint?.token) return endpoint;
  try {
    if (fs.existsSync(INFO_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8'));
      if (parsed?.url && parsed?.token) {
        endpoint = parsed;
        return endpoint;
      }
    }
  } catch { /* ignore */ }
  return null;
}

/** 规范化应用 profile id（路径段） */
function safeClientId(raw) {
  const id = String(raw || '').trim();
  if (!/^[\w.-]{1,64}$/.test(id)) return '';
  return id;
}

/** 端点根：http://127.0.0.1:port */
function endpointBase(ep = getGatewayEndpoint()) {
  if (!ep?.url) return '';
  return String(ep.url).replace(/\/mcp\/?$/, '');
}

/**
 * 供 UI 复制：Token Bank 内置中转 MCP（json-mcp）
 * 不同应用使用不同 URL（/mcp/{appId}），工具集彼此隔离；配置名固定便于粘贴
 */
function buildClientConfigJson(ep = getGatewayEndpoint(), clientId = 'api') {
  if (!ep?.url || !ep?.token) return null;
  const cid = safeClientId(clientId) || 'api';
  const base = endpointBase(ep);
  const url = `${base}/mcp/${cid}`;
  return {
    mcpServers: {
      'tokenbank-relay': {
        url,
        headers: {
          Authorization: `Bearer ${ep.token}`,
        },
      },
    },
  };
}

/** 从请求路径解析应用 id：/mcp/:clientId */
function parseClientIdFromPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] !== 'mcp') return { ok: parts.length === 0, clientId: '' };
  if (parts.length === 1) return { ok: true, clientId: '' };
  if (parts.length === 2) {
    const clientId = safeClientId(parts[1]);
    return { ok: !!clientId, clientId };
  }
  return { ok: false, clientId: '' };
}

/** 某应用可见的后端（gateway_clients 含该 app）；内置按 cid 各起一份 */
function backendsForClient(clientId) {
  syncBackends();
  const cid = safeClientId(clientId);
  const visibleRows = [...routedRows.values()].filter((row) => {
    if (!cid) return true; // 未指定应用：返回全部（兼容旧 /mcp）
    const clients = Array.isArray(row?.gateway_clients) ? row.gateway_clients : [];
    if (clients.length) return clients.includes(cid);
    // 旧数据仅 gateway_routed：仅内置 MCP 对「通用」档可见
    if (!row?.gateway_routed) return false;
    return cid === 'api' && isBuiltinRelayId(row.id);
  });
  return visibleRows
    .map((row) => (isBuiltinRelayId(row.id) ? getBuiltinBackend(row, cid) : backends.get(row.id)))
    .filter(Boolean);
}

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 8 * 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function safePrefix(name) {
  return String(name || 'mcp')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'mcp';
}

/** stdio MCP 后端：按需拉起并复用连接 */
class StdioBackend {
  constructor(serverRow, clientId = '') {
    this.id = serverRow.id;
    this.clientId = String(clientId || ''); // 内置后端按此注入 TB_CLIENT_ID
    this.name = serverRow.name || serverRow.id;
    this.prefix = safePrefix(this.name);
    this.row = serverRow;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.toolsCache = null;
    this.ready = null;
  }

  async ensure() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    try {
      await this.ready;
    } catch (e) {
      this.ready = null;
      throw e;
    }
    return this.ready;
  }

  async _start() {
    // 通用：按纳管记录的 command/args/env 启动；内置占位符由 resolveGatewaySpawnConfig 展开
    let command = '';
    let args = [];
    let envExtra = {};
    try {
      const mcpManager = require('./mcp-manager');
      if (typeof mcpManager.resolveGatewaySpawnConfig === 'function') {
        const cfg = mcpManager.resolveGatewaySpawnConfig(this.row, this.clientId) || {};
        command = String(cfg.command || '').trim();
        args = Array.isArray(cfg.args) ? cfg.args : [];
        envExtra = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
      }
    } catch (e) {
      console.warn('[mcp-gateway] resolve launch failed:', e.message);
    }
    if (!command) {
      command = String(this.row.command || '').trim();
      args = Array.isArray(this.row.args) ? this.row.args : [];
      envExtra = this.row.env && typeof this.row.env === 'object' ? this.row.env : {};
    }
    if (!command || command === '__DYNAMIC_ELECTRON__') {
      throw new Error(`MCP ${this.name} 启动命令无效`);
    }

    const env = {
      ...process.env,
      ...envExtra,
    };

    this.proc = spawn(command, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    this.proc.on('error', (err) => {
      console.error(`[mcp-gateway:${this.name}] spawn error:`, err.message);
      this._failAll(err);
      this.proc = null;
      this.rl = null;
      this.ready = null;
      this.toolsCache = null;
    });
    this.proc.on('exit', () => {
      this._failAll(new Error(`MCP ${this.name} exited`));
      this.proc = null;
      this.rl = null;
      this.ready = null;
      this.toolsCache = null;
    });
    this.proc.stderr?.on('data', (buf) => {
      const line = String(buf || '').trim();
      if (line) console.warn(`[mcp-gateway:${this.name}]`, line.slice(0, 400));
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      const text = String(line || '').trim();
      if (!text) return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.id == null) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });

    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tokenbank-mcp-gateway', version: '0.5.4' },
    });
    this.notify('notifications/initialized', {});
    const listed = await this.request('tools/list', {});
    this.toolsCache = Array.isArray(listed?.tools) ? listed.tools : [];
  }

  notify(method, params) {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  request(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin) {
        reject(new Error(`MCP ${this.name} not running`));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name} ${method} timeout`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  _failAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  async listTools() {
    await this.ensure();
    if (!this.toolsCache) {
      const listed = await this.request('tools/list', {});
      this.toolsCache = Array.isArray(listed?.tools) ? listed.tools : [];
    }
    return this.toolsCache.map((tool) => ({
      ...tool,
      name: `${this.prefix}__${tool.name}`,
      description: `[${this.row.display_name || this.name}] ${tool.description || tool.name}`,
      _backendId: this.id,
      _rawName: tool.name,
    }));
  }

  async callTool(rawName, args) {
    await this.ensure();
    return this.request('tools/call', { name: rawName, arguments: args || {} }, 120000);
  }

  stop() {
    try { this.proc?.kill(); } catch { /* ignore */ }
    this.proc = null;
    this.rl = null;
    this.ready = null;
    this.toolsCache = null;
    this._failAll(new Error('stopped'));
  }
}

function isUrlMcpRow(row) {
  if (!row) return false;
  if (String(row.url || '').trim()) return true;
  const typ = String(row.type || '').toLowerCase();
  return typ === 'http' || typ === 'sse';
}

/** 解析 MCP Streamable HTTP 响应：JSON 或 SSE data: */
function parseMcpHttpBody(text) {
  const s = String(text || '').trim();
  if (!s) return {};
  if (s.startsWith('{') || s.startsWith('[')) {
    const msg = JSON.parse(s);
    if (msg && typeof msg === 'object' && !Array.isArray(msg) && msg.error) {
      throw new Error(msg.error.message || JSON.stringify(msg.error));
    }
    return msg?.result !== undefined ? msg.result : msg;
  }
  let last = null;
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { last = JSON.parse(payload); } catch { /* ignore */ }
  }
  if (!last) throw new Error('empty MCP HTTP response');
  if (last.error) throw new Error(last.error.message || JSON.stringify(last.error));
  return last.result !== undefined ? last.result : last;
}

/** 远程 HTTP/SSE MCP：按需 initialize，复用 session */
class HttpBackend {
  constructor(serverRow) {
    this.id = serverRow.id;
    this.name = serverRow.name || serverRow.id;
    this.prefix = safePrefix(this.name);
    this.row = serverRow;
    this.sessionId = null;
    this.nextId = 1;
    this.toolsCache = null;
    this.ready = null;
  }

  _endpoint() {
    return String(this.row.url || '').trim();
  }

  _headers() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const extra = (this.row.metadata && this.row.metadata.headers) || this.row.headers;
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      for (const [k, v] of Object.entries(extra)) {
        if (v == null || v === '') continue;
        h[k] = String(v);
      }
    }
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    return h;
  }

  async _post(payload, timeoutMs) {
    const url = this._endpoint();
    if (!url) throw new Error(`MCP ${this.name} 缺少 url`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`MCP ${this.name} HTTP ${res.status}: ${text.slice(0, 240)}`);
      }
      return parseMcpHttpBody(text);
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`MCP ${this.name} timeout`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async ensure() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    try {
      await this.ready;
    } catch (e) {
      this.ready = null;
      throw e;
    }
    return this.ready;
  }

  async _start() {
    await this._post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'tokenbank-mcp-gateway', version: '0.5.4' },
      },
    }, 30000);
    try {
      await this._post({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      }, 10000);
    } catch { /* 部分网关不接受无 id 通知 */ }
    const listed = await this._post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/list',
      params: {},
    }, 30000);
    this.toolsCache = Array.isArray(listed?.tools) ? listed.tools : [];
  }

  async listTools() {
    await this.ensure();
    if (!this.toolsCache) {
      const listed = await this._post({
        jsonrpc: '2.0',
        id: this.nextId++,
        method: 'tools/list',
        params: {},
      }, 30000);
      this.toolsCache = Array.isArray(listed?.tools) ? listed.tools : [];
    }
    return this.toolsCache.map((tool) => ({
      ...tool,
      name: `${this.prefix}__${tool.name}`,
      description: `[${this.row.display_name || this.name}] ${tool.description || tool.name}`,
      _backendId: this.id,
      _rawName: tool.name,
    }));
  }

  async callTool(rawName, args) {
    await this.ensure();
    return this._post({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name: rawName, arguments: args || {} },
    }, 120000);
  }

  stop() {
    this.sessionId = null;
    this.ready = null;
    this.toolsCache = null;
  }
}

function makeBackend(row) {
  return isUrlMcpRow(row) ? new HttpBackend(row) : new StdioBackend(row);
}

function syncBackends() {
  const rows = (typeof getRoutedServers === 'function' ? getRoutedServers() : []) || [];
  const want = new Map();
  for (const row of rows) {
    if (!row?.id || row.status !== 'active') continue;
    // stdio 需 command；远程 HTTP/SSE 需 url
    if (isUrlMcpRow(row)) {
      if (!String(row.url || '').trim()) continue;
    } else if (!row.command) {
      continue;
    }
    want.set(row.id, row);
  }
  routedRows = want;

  // 非内置：全应用共享一份，按 id 复用/重建/清理
  for (const [id, backend] of backends) {
    if (!want.has(id) || isBuiltinRelayId(id)) {
      backend.stop();
      backends.delete(id);
    }
  }
  for (const [id, row] of want) {
    if (isBuiltinRelayId(id)) continue; // 内置走 per-cid 惰性创建
    const existing = backends.get(id);
    if (!existing) {
      backends.set(id, makeBackend(row));
    } else {
      const sameKind = isUrlMcpRow(existing.row) === isUrlMcpRow(row);
      const sameCmd = existing.row.command === row.command
        && JSON.stringify(existing.row.args) === JSON.stringify(row.args)
        && String(existing.row.url || '') === String(row.url || '')
        && JSON.stringify(existing.row.metadata?.headers || {}) === JSON.stringify(row.metadata?.headers || {});
      if (!sameKind || !sameCmd) {
        existing.stop();
        backends.set(id, makeBackend(row));
      } else {
        existing.row = row;
        existing.name = row.name || row.id;
        existing.prefix = safePrefix(existing.name);
      }
    }
  }

  // 内置 per-cid：行已不再路由则回收对应的所有 cid 实例
  for (const [key, backend] of builtinBackends) {
    const rid = key.slice(0, key.indexOf('::'));
    if (!want.has(rid)) {
      backend.stop();
      builtinBackends.delete(key);
    } else {
      backend.row = want.get(rid);
    }
  }
}

/** 取/建某应用 cid 的内置后端（TB_CLIENT_ID=cid） */
function getBuiltinBackend(row, cid) {
  const key = builtinKey(row.id, cid);
  let b = builtinBackends.get(key);
  if (!b) {
    b = new StdioBackend(row, cid || '');
    builtinBackends.set(key, b);
  } else {
    b.row = row;
  }
  return b;
}

/** 已投射到该应用的 HTTP API / 本地 CLI。不拉起 MCP 进程，只挂到同一份工具列表。 */
function projectedPlainTools(clientId) {
  try {
    return require('./mcp-manager').listConfiguredPlainTools(clientId) || [];
  } catch {
    return [];
  }
}

async function aggregateTools(clientId = '') {
  const list = backendsForClient(clientId);
  const tools = [];
  const errors = [];
  for (const backend of list) {
    try {
      const listed = await backend.listTools();
      tools.push(...listed.map(({ _backendId, _rawName, ...rest }) => rest));
    } catch (e) {
      errors.push(`${backend.name}: ${e.message}`);
      console.warn('[mcp-gateway] listTools failed:', backend.name, e.message);
    }
  }
  if (errors.length && tools.length === 0) {
    tools.push({
      name: 'tb_gateway_status',
      description: `MCP 网关后端暂不可用：${errors.join('; ')}`,
      inputSchema: { type: 'object', properties: {} },
    });
  }
  // 已投射的 HTTP API / 本地 CLI 跟 MCP 出现在同一份工具列表里
  for (const tool of projectedPlainTools(clientId)) {
    tools.push(plainToolSchema(tool));
  }
  return tools;
}

async function routeToolCall(prefixedName, args, clientId = '') {
  const list = backendsForClient(clientId);
  for (const backend of list) {
    const prefix = `${backend.prefix}__`;
    if (prefixedName.startsWith(prefix)) {
      const raw = prefixedName.slice(prefix.length);
      return backend.callTool(raw, args);
    }
  }
  if (prefixedName === 'tb_gateway_status') {
    const ep = getGatewayEndpoint();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          clientId: clientId || null,
          url: clientId ? `${endpointBase(ep)}/mcp/${clientId}` : ep?.url,
          backends: list.map((b) => b.id),
          routed: list.map((b) => b.name || b.id),
        }, null, 2),
      }],
    };
  }
  const plain = projectedPlainTools(clientId)
    .find((tool) => prefixedName === plainToolCallName(tool));
  if (plain) {
    const text = await callPlainTool(plain, args);
    return { content: [{ type: 'text', text: String(text) }] };
  }
  throw new Error(`Unknown tool: ${prefixedName}`);
}

async function handleMcpMessage(msg, clientId = '') {
  if (!msg || typeof msg !== 'object') {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }

  // 通知无响应
  if (msg.id === undefined && msg.method) {
    return null;
  }

  const id = msg.id ?? null;
  const method = msg.method;
  const cid = safeClientId(clientId);

  try {
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: cid ? `tokenbank-mcp-gateway-${cid}` : 'tokenbank-mcp-gateway',
            version: '0.5.4',
          },
        },
      };
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
      const tools = await aggregateTools(cid);
      return { jsonrpc: '2.0', id, result: { tools } };
    }
    if (method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      const result = await routeToolCall(name, args, cid);
      return { jsonrpc: '2.0', id, result };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  } catch (e) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: e.message || String(e) },
    };
  }
}

function checkAuth(req, token) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerKey = String(req.headers['x-api-key'] || '');
  return bearer === token || headerKey === token;
}

/**
 * @param {() => object[]} listRoutedFn 返回 gateway_routed && active 的 server 行
 */
function startMcpGateway(listRoutedFn) {
  if (typeof listRoutedFn === 'function') getRoutedServers = listRoutedFn;
  if (server) {
    syncBackends();
    return getGatewayEndpoint();
  }

  const prev = getGatewayEndpoint();
  const token = prev?.token || generateToken();

  server = http.createServer(async (req, res) => {
    // CORS：部分远程客户端探测
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, x-api-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const host = req.headers.host || '127.0.0.1';
    const url = new URL(req.url || '/', `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        backends: [...backends.keys()],
        builtinBackends: [...builtinBackends.keys()],
        routed: (getRoutedServers() || []).length,
      });
      return;
    }

    if (!checkAuth(req, token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // Streamable HTTP / 简易 JSON-RPC：POST /mcp 或 /mcp/:appId
    const parsed = parseClientIdFromPath(url.pathname);
    const queryClient = safeClientId(url.searchParams.get('client') || url.searchParams.get('app'));
    const clientId = parsed.clientId || queryClient;
    const isMcpPost = req.method === 'POST' && (
      url.pathname === '/' || (parsed.ok && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')))
    );
    if (isMcpPost) {
      if (url.pathname.startsWith('/mcp/') && !parsed.ok) {
        sendJson(res, 404, { error: 'invalid app id' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        // 支持 batch
        if (Array.isArray(body)) {
          const out = [];
          for (const item of body) {
            const r = await handleMcpMessage(item, clientId);
            if (r) out.push(r);
          }
          sendJson(res, 200, out);
          return;
        }
        const result = await handleMcpMessage(body, clientId);
        if (result == null) {
          res.writeHead(202);
          res.end();
          return;
        }
        sendJson(res, 200, result);
      } catch (e) {
        sendJson(res, 400, { error: e.message || String(e) });
      }
      return;
    }

    if (req.method === 'GET' && parsed.ok && (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/'))) {
      if (url.pathname.startsWith('/mcp/') && !clientId) {
        sendJson(res, 404, { error: 'invalid app id' });
        return;
      }
      // SSE 握手占位：部分客户端先 GET；返回 endpoint 事件
      const epPath = clientId ? `/mcp/${clientId}` : '/mcp';
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: endpoint\ndata: ${epPath}\n\n`);
      const keep = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { clearInterval(keep); }
      }, 15000);
      req.on('close', () => clearInterval(keep));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });

  const onListening = () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : PREFERRED_PORT;
    writeInfo({
      url: `http://127.0.0.1:${port}/mcp`,
      token,
      port,
      startedAt: Date.now(),
    });
    syncBackends();
    console.log('[mcp-gateway] listening', endpoint.url);
  };

  server.once('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.warn('[mcp-gateway] port busy, fallback to random');
      server.listen(0, '127.0.0.1', onListening);
      return;
    }
    console.error('[mcp-gateway] start failed:', err.message);
    server = null;
  });
  server.listen(PREFERRED_PORT, '127.0.0.1', onListening);

  // 若上次已写过 info，先返回缓存；listening 后会刷新
  if (!endpoint) {
    writeInfo({
      url: `http://127.0.0.1:${PREFERRED_PORT}/mcp`,
      token,
      port: PREFERRED_PORT,
      startedAt: Date.now(),
      pending: true,
    });
  }
  return getGatewayEndpoint();
}

function reloadMcpGateway() {
  if (!server) return getGatewayEndpoint();
  syncBackends();
  return getGatewayEndpoint();
}

function stopMcpGateway() {
  for (const b of backends.values()) b.stop();
  backends.clear();
  for (const b of builtinBackends.values()) b.stop();
  builtinBackends.clear();
  if (server) {
    try { server.close(); } catch { /* ignore */ }
    server = null;
  }
}

function getGatewayStatus() {
  const ep = getGatewayEndpoint();
  const routed = (typeof getRoutedServers === 'function' ? getRoutedServers() : []) || [];
  /** @type {Record<string, object[]>} */
  const byClient = {};
  for (const s of routed) {
    const id = s.id || '';
    const isBuiltin = id === 'tokenbank-prompts'
      || id === 'tokenbank-models'
      || id === 'tokenbank-resources';
    const clients = Array.isArray(s.gateway_clients) && s.gateway_clients.length
      ? s.gateway_clients
      : (s.gateway_routed && isBuiltin ? ['api'] : []);
    for (const cid of clients) {
      if (!byClient[cid]) byClient[cid] = [];
      byClient[cid].push({
        id: s.id,
        name: s.name,
        display_name: s.display_name || s.name,
      });
    }
  }
  const profiles = Object.keys(byClient).sort().map((cid) => ({
    id: cid,
    url: ep?.url ? `${endpointBase(ep)}/mcp/${cid}` : '',
    routedCount: byClient[cid].length,
    configJson: buildClientConfigJson(ep, cid),
  }));
  return {
    running: !!server,
    endpoint: ep,
    /** 默认复制「通用 API」配置；UI 可按 profiles 切换应用 */
    configJson: buildClientConfigJson(ep, 'api'),
    routedCount: routed.length,
    routed: routed.map((s) => ({
      id: s.id,
      name: s.name,
      display_name: s.display_name || s.name,
      gateway_clients: Array.isArray(s.gateway_clients) ? s.gateway_clients : [],
    })),
    byClient,
    profiles,
    backends: [...backends.keys()],
  };
}

module.exports = {
  startMcpGateway,
  stopMcpGateway,
  reloadMcpGateway,
  getGatewayEndpoint,
  getGatewayStatus,
  buildClientConfigJson,
};
