// client/cli/ipc-bridge.js
// Docker / CLI 补齐资产管理与命令行智能体纳管：
// 复用桌面版的 IPC handler（electron/ipc-handlers-resource.js、ipc-handlers-agent.js），
// 通过 admin-api 以 HTTP 暴露给 Web 界面，前端 src/api/webBridge.js 按 preload 同名方法调用。
//
//   POST /api/bridge/invoke   { channel, args: [] }  → { ok, result } | { ok:false, error }
//   GET  /api/bridge/events   SSE：handler 推给窗口的事件（agent:task:step 等）
//   GET  /api/bridge/ping     → { ok, channels }
//
// 安全：admin-api 本身不做鉴权（由运维控制绑定地址），但这里能执行命令行智能体，
// 所以只接受同源请求：必须带 X-TokenBank-Bridge 头（跨站请求会被 CORS 预检拦下），
// 有 Origin 时必须与 Host 一致，响应不带 Access-Control-Allow-Origin。
'use strict';

const Module = require('module');
const http = require('http');
const https = require('https');
const path = require('path');

const STUB_PATH = path.join(__dirname, 'electron-stub.js');
const ALLOWED_PREFIXES = ['resource:', 'agent:', 'community:'];
const LOCAL_ONLY_CHANNELS = new Set(['llm:fetch']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

let _installed = false;
let _ready = false;
let _initError = null;
let stub = null;
let _appsGetter = null;

/** admin-api 注入网关页同口径的应用列表（已保存 + 检测到的命令行智能体） */
function setAppsGetter(fn) { _appsGetter = typeof fn === 'function' ? fn : null; }

/** 让共用模块里的 require('electron') 拿到替身（只装一次，须在加载 handler 之前） */
function installElectronStub() {
  if (_installed) return;
  _installed = true;
  const orig = Module._resolveFilename;
  Module._resolveFilename = function resolveWithStub(request, ...rest) {
    if (request === 'electron') return STUB_PATH;
    return orig.call(this, request, ...rest);
  };
  stub = require(STUB_PATH);
}

/** 与桌面版 main.js 的 llm:fetch 同形，但只允许访问本机（容器内网关） */
function llmFetch(_event, { url, method = 'GET', headers = {}, body, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(String(url || '')); } catch { resolve({ status: 0, body: '', error: 'invalid url' }); return; }
    if (!/^https?:$/.test(u.protocol) || !LOOPBACK_HOSTS.has(u.hostname)) {
      resolve({ status: 0, body: '', error: 'llm.fetch only reaches the local gateway in Docker / web mode' });
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method,
      headers,
      timeout: timeoutMs || 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 加载并注册与桌面版相同的 handler；失败不影响网关其它功能 */
function init() {
  if (_ready || _initError) return _ready;
  try {
    installElectronStub();
    require('../electron/ipc-handlers-resource').registerResourceHandlers();
    require('../electron/ipc-handlers-agent').registerAgentHandlers();
    stub.__handlers.set('llm:fetch', llmFetch);
    // 没有系统文件对话框：选工作目录 = 校验 Web 界面填写的路径，默认 /workspace（挂载的项目目录）
    stub.__handlers.set('agent:pickWorkingDir', async (_event, opts = {}) => {
      const fs = require('fs');
      const fallback = process.env.TOKENBANK_WORKDIR || process.cwd();
      const wanted = String((opts && opts.defaultPath) || '').trim() || fallback;
      const abs = path.resolve(fallback, wanted);
      try {
        if (fs.statSync(abs).isDirectory()) return { success: true, path: abs };
      } catch { /* 不存在 */ }
      return { success: false, error: `目录不存在：${abs}` };
    });
    // 已纳管应用与 Web 界面「网关」页同源：admin-api 注入（含检测到的命令行智能体），否则读 local-config
    try {
      const { readLocalConfig } = require('../shared/config-loader');
      require('../electron/mcp-gateway-targets').setAppsGetter(() => {
        try { return _appsGetter ? _appsGetter() : (readLocalConfig()?.apps || []); } catch { return []; }
      });
    } catch { /* 回退到默认路径读取 */ }
    try { require('../electron/resource-manager').ensureBuiltinAssistants(); } catch { /* 无可投射目标时只纳管 */ }
    _ready = true;
  } catch (e) {
    _initError = e;
    console.warn('[ipc-bridge] init failed:', e.message);
  }
  return _ready;
}

function channelAllowed(channel) {
  const ch = String(channel || '');
  if (LOCAL_ONLY_CHANNELS.has(ch)) return true;
  return ALLOWED_PREFIXES.some((p) => ch.startsWith(p));
}

/** 只接受同源：自定义头 + Origin 与 Host 一致 */
function sameOrigin(req, { requireHeader = true } = {}) {
  if (requireHeader && req.headers['x-tokenbank-bridge'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function send(res, status, body) {
  res.removeHeader('Access-Control-Allow-Origin');
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 20 * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** @returns {boolean} 是否处理了该请求 */
async function handle(req, res, url, method) {
  if (!url.startsWith('/api/bridge/')) return false;

  if (url === '/api/bridge/ping' && method === 'GET') {
    if (!sameOrigin(req)) { send(res, 403, { ok: false, error: 'forbidden' }); return true; }
    const ok = init();
    send(res, 200, {
      ok,
      error: ok ? undefined : (_initError && _initError.message),
      channels: ok ? [...stub.__handlers.keys()].filter(channelAllowed) : [],
    });
    return true;
  }

  if (url === '/api/bridge/invoke' && method === 'POST') {
    if (!sameOrigin(req)) { send(res, 403, { ok: false, error: 'forbidden' }); return true; }
    if (!init()) { send(res, 503, { ok: false, error: (_initError && _initError.message) || 'bridge unavailable' }); return true; }
    let body;
    try { body = await readJson(req); } catch (e) { send(res, 400, { ok: false, error: e.message }); return true; }
    const channel = String(body.channel || '');
    const fn = channelAllowed(channel) ? stub.__handlers.get(channel) : null;
    if (!fn) { send(res, 404, { ok: false, error: `unknown channel: ${channel}` }); return true; }
    const args = Array.isArray(body.args) ? body.args : [];
    try {
      const result = await fn({ sender: stub.BrowserWindow.getAllWindows()[0].webContents }, ...args);
      send(res, 200, { ok: true, result: result === undefined ? null : result });
    } catch (e) {
      send(res, 200, { ok: false, error: e.message || String(e) });
    }
    return true;
  }

  if (url === '/api/bridge/events' && method === 'GET') {
    // EventSource 不能带自定义头：只校验 Origin
    if (!sameOrigin(req, { requireHeader: false })) { send(res, 403, { ok: false, error: 'forbidden' }); return true; }
    if (!init()) { send(res, 503, { ok: false, error: 'bridge unavailable' }); return true; }
    res.removeHeader('Access-Control-Allow-Origin');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    const onEvent = (channel, data) => {
      try { res.write(`data: ${JSON.stringify({ channel, data })}\n\n`); } catch { /* 连接已断 */ }
    };
    stub.__events.on('event', onEvent);
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
    req.on('close', () => { clearInterval(beat); stub.__events.off('event', onEvent); });
    return true;
  }

  send(res, 404, { ok: false, error: 'not_found' });
  return true;
}

module.exports = { handle, init, installElectronStub, setAppsGetter, _internal: { channelAllowed, sameOrigin } };
