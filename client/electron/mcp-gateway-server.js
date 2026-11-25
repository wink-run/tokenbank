// mcp-gateway-server.js
// 本机应用的 MCP 入口：网关 11430 的 /mcp/<应用>（凭中转 Key）。
//   Token Bank 自己的工具（tokenbank-tools.js）在这个进程里直接执行，按这个应用的权限给；
//   投射给这个应用的第三方 MCP（stdio / 远程 HTTP）由这里拉起、加前缀聚合进来。
// 写进应用配置的 tokenbank 条目（tokenbank-mcp-stdio.js）也转到这里：一个条目里既有 Token Bank 的工具，也有给这个应用的第三方 MCP。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { plainToolCallName, plainToolSchema, callPlainTool } = require('./plain-tool-call');

const TB_DIR = path.join(os.homedir(), '.tokenbank');
const INFO_PATH = path.join(TB_DIR, 'mcp-gateway.json');
/** Token Bank 自己那一条（工具在进程内执行，不拉进程） */
const BUILTIN_ID = 'tokenbank';

let endpoint = null;
/** 第三方 MCP：全应用共享一份后端，按 id 复用 @type {Map<string, StdioBackend|HttpBackend>} */
const backends = new Map();
/** 当前可代理的第三方 MCP，id → row */
let routedRows = new Map();
let getRoutedServers = () => [];
let routedFnSet = false;   // 桌面版启动时会传进来；命令行版没有，挂到网关时自己取

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

/** 应用 id 和它的别名（codex / codex-desktop 等算同一个应用） */
function clientIdsOf(cid) {
  try { return new Set([cid, ...require('./mcp-agent-targets').expandMcpClientMatchIds(cid)]); } catch { return new Set([cid]); }
}

/**
 * 某应用可见的第三方 MCP 后端（给了这个应用的；不指定应用时全部）。
 * 已经直接写进这个应用配置的不再经网关列一遍，免得同一组工具出现两次。
 */
function backendsForClient(clientId) {
  syncBackends();
  const cid = safeClientId(clientId);
  const ids = cid ? clientIdsOf(cid) : null;
  const has = (list) => Array.isArray(list) && list.some((id) => ids.has(id));
  return [...routedRows.values()]
    .filter((row) => !ids || (has(row?.gateway_clients) && !has(row?.sync_clients)))
    .map((row) => backends.get(row.id))
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
  constructor(serverRow) {
    this.id = serverRow.id;
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
        const cfg = mcpManager.resolveGatewaySpawnConfig(this.row) || {};
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
    if (!row?.id || row.status !== 'active' || row.id === BUILTIN_ID) continue;
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
    if (!want.has(id)) {
      backend.stop();
      backends.delete(id);
    }
  }
  for (const [id, row] of want) {
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
}

/** 已投射到该应用的 HTTP API / 本地 CLI。不拉起 MCP 进程，只挂到同一份工具列表。 */
function projectedPlainTools(clientId) {
  try {
    return require('./mcp-manager').listConfiguredPlainTools(clientId) || [];
  } catch {
    return [];
  }
}

/** 一起拉各个第三方 MCP 的工具；慢的（比如第一次 npx 下载）最多等 timeoutMs，不拖住应用启动 */
async function aggregateTools(clientId = '', timeoutMs = 15000) {
  const list = backendsForClient(clientId);
  const tools = [];
  const errors = [];
  const results = await Promise.all(list.map(async (backend) => {
    let timer;
    try {
      const listed = await Promise.race([
        backend.listTools(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('启动超时')), timeoutMs); }),
      ]);
      return { listed };
    } catch (e) {
      console.warn('[mcp-gateway] listTools failed:', backend.name, e.message);
      return { error: `${backend.name}: ${e.message}` };
    } finally {
      clearTimeout(timer);
    }
  }));
  for (const r of results) {
    if (r.listed) tools.push(...r.listed.map(({ _backendId, _rawName, ...rest }) => rest));
    else errors.push(r.error);
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

/** 这个应用能用的 Token Bank 工具的调用上下文 */
function tokenbankContext(cid, { port, agentKey, dispatch } = {}) {
  const tools = require('./tokenbank-tools');
  const gwPort = port || attachedPort || 11430;
  return {
    clientId: cid,
    level: require('./mcp-access').appLevel(cid),
    guardian: cid === tools.GUARDIAN_CLIENT_ID,
    gatewayUrl: `http://127.0.0.1:${gwPort}`,
    gatewayKey: agentKey || '',
    dispatch: tools.dispatchContext(cid, dispatch || {}),
    callRelayed: (name, args) => routeToolCall(name, args, cid),
  };
}

/**
 * @param {object} msg JSON-RPC
 * @param {string} clientId 应用 id（路径 /mcp/<应用>）
 * @param {{ scope?: string, port?: number, agentKey?: string, dispatch?: object }} opts
 *   scope='tokenbank'：只要 Token Bank 自己的工具；其它（包括写进应用配置的 tokenbank 条目转过来的）
 *   还带上给这个应用的第三方 MCP，原样列出（模型直接看到工具名和参数，比藏在 tb_call_mcp 后面准）
 */
async function handleMcpMessage(msg, clientId = '', opts = {}) {
  const tools = require('./tokenbank-tools');
  const cid = safeClientId(clientId);
  const ctx = tokenbankContext(cid, opts);
  const onlyTokenbank = opts.scope === 'tokenbank';
  return require('./tokenbank-mcp').rpc(msg, {
    list: async () => [
      ...tools.listTools(ctx),
      ...(onlyTokenbank ? [] : await aggregateTools(cid)),
    ],
    call: (name, args) => (tools.isToolName(name) || onlyTokenbank
      ? tools.callTool(name, args, ctx)
      : routeToolCall(name, args, cid)),
  });
}

function checkAuth(req, token) {
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerKey = String(req.headers['x-api-key'] || '');
  return bearer === token || headerKey === token;
}

/**
 * 中转 MCP 的 HTTP 处理：网关 11430 的 /mcp、/mcp/:appId（现在的入口），和旧的 11431 独立端口共用这一份。
 */
async function handleRelayRequest(req, res, { port, agentKey } = {}) {
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
      routed: (getRoutedServers() || []).length,
    });
    return;
  }

  if (!checkAuth(req, relayToken())) {
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
    let dispatch = {};
    try { dispatch = JSON.parse(decodeURIComponent(String(req.headers['x-tb-dispatch'] || '')) || '{}') || {}; } catch { /* 没带 */ }
    const opts = { scope: String(req.headers['x-tb-scope'] || ''), port: port || attachedPort, agentKey, dispatch };
    try {
      const body = await readJsonBody(req);
      // 支持 batch
      if (Array.isArray(body)) {
        const out = [];
        for (const item of body) {
          const r = await handleMcpMessage(item, clientId, opts);
          if (r) out.push(r);
        }
        sendJson(res, 200, out);
        return;
      }
      const result = await handleMcpMessage(body, clientId, opts);
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
}

let relayTokenValue = '';
/** 所有应用共用的中转 Key：沿用上次的，没有就生成 */
function relayToken() {
  if (!relayTokenValue) relayTokenValue = getGatewayEndpoint()?.token || generateToken();
  return relayTokenValue;
}

let attachedPort = 0;
function advertisedUrl(port) {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * 挂到网关上：应用配置里写的地址都是网关的端口（默认 11430）。
 * @param {{ port: number, listRoutedFn?: () => object[] }} opts
 */
function attachToGateway({ port, listRoutedFn } = {}) {
  if (typeof listRoutedFn === 'function') { getRoutedServers = listRoutedFn; routedFnSet = true; }
  if (!port) return getGatewayEndpoint();
  if (attachedPort === Number(port) && routedFnSet) return getGatewayEndpoint();
  attachedPort = Number(port);
  if (!routedFnSet) {
    routedFnSet = true;
    getRoutedServers = () => {
      try { const m = require('./mcp-manager'); m.init(); return m.listGatewayRoutedServers(); } catch { return []; }
    };
  }
  writeInfo({ url: advertisedUrl(attachedPort), token: relayToken(), port: attachedPort, startedAt: Date.now() });
  try { syncBackends(); } catch { /* 后端起不来不影响网关 */ }
  return getGatewayEndpoint();
}

/** 桌面版：告诉中转怎么取已纳管的第三方 MCP（网关起来后会自己挂上） */
function startMcpGateway(listRoutedFn) {
  attachToGateway({ listRoutedFn });
  try { syncBackends(); } catch { /* 后端起不来不影响网关 */ }
  return getGatewayEndpoint();
}

/** 纳管的 MCP 变了：重建后端 */
function reloadMcpGateway() {
  syncBackends();
  return getGatewayEndpoint();
}

function stopMcpGateway() {
  for (const b of backends.values()) b.stop();
  backends.clear();
}

/**
 * 投射给这个应用的第三方 MCP 每个工具的定义（原名、说明、参数），按前缀分组。
 * tb_list_resources 用它列出参数名、tb_call_mcp 用它检查参数；起不来或太慢的跳过（只给工具名）。
 * @returns {Promise<Record<string, { name: string, description: string, inputSchema: object }[]>>}
 */
async function relayedToolDefs(clientId = '', timeoutMs = 8000) {
  const out = {};
  await Promise.all(backendsForClient(clientId).map(async (b) => {
    let timer;
    try {
      const listed = await Promise.race([
        b.listTools(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
      ]);
      out[b.prefix] = listed.map((t) => ({
        name: t._rawName,
        description: String(t.description || '').replace(/^\[[^\]]*\]\s*/, ''),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : {},
      }));
    } catch { /* 拿不到就只给工具名 */ } finally {
      clearTimeout(timer);
    }
  }));
  return out;
}

/** tb_call_mcp 用：调用投射给这个应用的第三方 MCP 工具（带前缀的名字） */
function callRelayedTool(prefixedName, args, clientId = '') {
  return routeToolCall(prefixedName, args, clientId);
}

function getGatewayStatus() {
  const ep = getGatewayEndpoint();
  const routed = (typeof getRoutedServers === 'function' ? getRoutedServers() : []) || [];
  /** @type {Record<string, object[]>} */
  const byClient = {};
  for (const s of routed) {
    const id = s.id || '';
    const isBuiltin = id === BUILTIN_ID;
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
    running: !!attachedPort,
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
  BUILTIN_ID,
  callRelayedTool,
  relayedToolDefs,
  handleMcpMessage,
  startMcpGateway,
  attachToGateway,
  handleRelayRequest,
  stopMcpGateway,
  reloadMcpGateway,
  getGatewayEndpoint,
  getGatewayStatus,
  buildClientConfigJson,
};
