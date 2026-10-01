// server.js — ChatGPT 网页源本地 Responses 端点（多实例）。
// 每个实例 = 一个 ChatGPT 账户 = 独立 http server(端口) + 独立 Bearer + 独立浏览器分区。
// 每个 server 绑定 instanceId，请求转 host.runTurn(id, ...) 驱动该账户的网页会话。
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

const host = require('./host');
let transform = null;
try { transform = require('../codex-transform'); } catch { /* 测试环境可缺省 */ }

const CONF_PATH = path.join(os.homedir(), '.tokenbank', 'chatgpt-web.json');
const DEFAULT_PORT = 17841;
const WEB_MODELS = ['chatgpt-web', 'chatgpt-web-thinking'];
const MAX_INPUT_IMAGES = 10; // ChatGPT 单条消息附图上限
const IMAGE_ONLY_PROMPT = '请查看附图并据此完成任务。';

const servers = new Map(); // instanceId -> { server, port, token }

function log(...a) { console.log('[chatgpt-web:server]', ...a); }

function loadConf() {
  try { const c = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8')); return c && typeof c === 'object' ? c : {}; }
  catch { return {}; }
}
function saveConf(c) {
  try { fs.mkdirSync(path.dirname(CONF_PATH), { recursive: true }); fs.writeFileSync(CONF_PATH, JSON.stringify(c, null, 2), 'utf8'); }
  catch (e) { log('写配置失败', e.message); }
}
function id(prefix) { return `${prefix}_${crypto.randomBytes(16).toString('hex')}`; }

// ---- 请求解析：Responses `input` 或 Chat `messages` → 文本 + 图片 ----
function imageUrlOfPart(p) {
  if (!p || typeof p !== 'object') return '';
  if (p.type === 'image_url') {
    const u = p.image_url;
    return (typeof u === 'string' ? u : (u && u.url)) || '';
  }
  if (p.type === 'input_image') {
    const u = p.image_url;
    return (typeof u === 'string' ? u : (u && u.url)) || '';
  }
  if (p.type === 'image' && p.source) {
    if (p.source.type === 'base64' && p.source.data) {
      return `data:${p.source.media_type || 'image/jpeg'};base64,${p.source.data}`;
    }
    return p.source.url || '';
  }
  return '';
}

// 抽文本，同时把图片 URL 按出现顺序推进 images
function harvestContent(content, images) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    const url = imageUrlOfPart(content);
    if (url) { images.push(url); return ''; }
    return content?.text || '';
  }
  const texts = [];
  for (const p of content) {
    if (typeof p === 'string') { texts.push(p); continue; }
    const url = imageUrlOfPart(p);
    if (url) { images.push(url); continue; }
    if (p && p.text) texts.push(p.text);
  }
  return texts.join('');
}

function flattenToTurn(body) {
  const parts = [];
  const images = [];
  let src = body || {};
  if (transform && Array.isArray(src.input)) {
    try { src = transform.responsesToChat(src) || src; } catch { /* 保持原 body */ }
  }
  if (src.instructions) parts.push(String(src.instructions).trim());
  else if (body && body.instructions) parts.push(String(body.instructions).trim());
  const items = Array.isArray(src.messages) ? src.messages
    : Array.isArray(body && body.input) ? body.input
    : Array.isArray(body && body.messages) ? body.messages : null;
  if (items) {
    for (const m of items) {
      if (typeof m === 'string') { parts.push(m); continue; }
      if (!m || typeof m !== 'object') continue;
      const topUrl = imageUrlOfPart(m);
      if (m.type === 'input_image' && topUrl) { images.push(topUrl); continue; }
      const text = harvestContent(m.content, images).trim();
      if (!text) continue;
      const role = m.role || 'user';
      if (role === 'system' || role === 'developer') parts.push(text);
      else if (role === 'assistant') parts.push(`（助手先前回复）${text}`);
      else parts.push(text);
    }
  } else if (typeof (body && body.input) === 'string') {
    parts.push(body.input);
  }
  const dropped = Math.max(0, images.length - MAX_INPUT_IMAGES);
  const kept = images.slice(-MAX_INPUT_IMAGES).map((url) => ({ url }));
  if (dropped) parts.push(`[有 ${dropped} 张较早的图未附上：ChatGPT 每条最多 ${MAX_INPUT_IMAGES} 张]`);
  const prompt = parts.filter(Boolean).join('\n\n') || (kept.length ? IMAGE_ONLY_PROMPT : '');
  return { prompt, images: kept };
}
function flattenToPrompt(body) { return flattenToTurn(body).prompt; }

function sse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function baseResponse(respId, model, status, output) {
  return { id: respId, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model, output: output || [], usage: null, metadata: {} };
}
function sendJson(res, status, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleResponses(instId, res, body, wantStream) {
  const model = body.model || 'chatgpt-web';
  const turn = flattenToTurn(body);
  const prompt = turn.prompt;
  if (!prompt) { sendJson(res, 400, { error: { message: 'empty input' } }); return; }
  const respId = id('resp'); const itemId = id('msg');
  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    sse(res, 'response.created', { type: 'response.created', response: baseResponse(respId, model, 'in_progress', []) });
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    sse(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item });
    sse(res, 'response.content_part.added', { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    let full = '';
    try {
      const out = await host.runTurn(instId, prompt, { images: turn.images, onDelta: (delta) => { full += delta; sse(res, 'response.output_text.delta', { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta }); } });
      full = out.text || full;
    } catch (e) {
      sse(res, 'response.failed', { type: 'response.failed', response: { ...baseResponse(respId, model, 'failed', []), error: { code: e.code || 'error', message: e.message } } });
      res.end(); return;
    }
    sse(res, 'response.output_text.done', { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text: full });
    const doneItem = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: full, annotations: [] }] };
    sse(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: doneItem });
    sse(res, 'response.completed', { type: 'response.completed', response: baseResponse(respId, model, 'completed', [doneItem]) });
    res.end();
    return;
  }
  try {
    const out = await host.runTurn(instId, prompt, { images: turn.images });
    const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: out.text || '', annotations: [] }] };
    sendJson(res, 200, baseResponse(respId, model, 'completed', [item]));
  } catch (e) { sendJson(res, e.code === 'NOT_LOGGED_IN' ? 401 : 502, { error: { code: e.code || 'error', message: e.message } }); }
}

async function handleChat(instId, res, body, wantStream) {
  const model = body.model || 'chatgpt-web';
  const turn = flattenToTurn(body);
  const prompt = turn.prompt;
  if (!prompt) { sendJson(res, 400, { error: { message: 'empty messages' } }); return; }
  const cid = id('chatcmpl');
  if (wantStream) {
    // Do not commit a successful stream before the browser produces output.
    // Login/submit/time-out failures can then return an actual HTTP error.
    const begin = () => {
      if (res.headersSent) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      chunk({ role: 'assistant' });
    };
    const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id: cid, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish || null }] })}\n\n`);
    try {
      let emitted = false;
      const out = await host.runTurn(instId, prompt, { images: turn.images, onDelta: (d) => {
        if (!d) return;
        begin(); emitted = true; chunk({ content: d });
      } });
      begin();
      if (!emitted && out.text) chunk({ content: out.text });
      chunk({}, 'stop');
    } catch (e) {
      const status = e.code === 'NOT_LOGGED_IN' ? 401 : 502;
      const error = { type: status === 401 ? 'authentication_error' : 'api_error', code: e.code || 'error', message: e.message };
      if (!res.headersSent) sendJson(res, status, { error });
      else { res.write(`data: ${JSON.stringify({ error })}\n\n`); res.end(); }
      return;
    }
    res.write('data: [DONE]\n\n'); res.end();
    return;
  }
  try {
    const out = await host.runTurn(instId, prompt, { images: turn.images });
    sendJson(res, 200, { id: cid, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: out.text || '' }, finish_reason: 'stop' }] });
  } catch (e) { sendJson(res, e.code === 'NOT_LOGGED_IN' ? 401 : 502, { error: { code: e.code || 'error', message: e.message } }); }
}

function bearerOk(req, token) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m || !token) return false;
  const a = Buffer.from(m[1]); const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function makeOnRequest(instId) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname.replace(/\/+$/, '');
    if (p === '/health' || p === '') { sendJson(res, 200, { ok: true, running: true, instance: instId }); return; }
    const s = servers.get(instId);
    if (!bearerOk(req, s && s.token)) { sendJson(res, 401, { error: { message: 'invalid bearer' } }); return; }
    if (p === '/v1/models' || p === '/models') { sendJson(res, 200, { object: 'list', data: WEB_MODELS.map((m) => ({ id: m, object: 'model', owned_by: 'chatgpt-web' })) }); return; }
    if (req.method !== 'POST') { sendJson(res, 405, { error: { message: 'method not allowed' } }); return; }
    let body;
    try { body = await readBody(req); } catch { sendJson(res, 400, { error: { message: 'bad json' } }); return; }
    const wantStream = body.stream === true;
    try {
      if (p === '/responses' || p === '/v1/responses') return await handleResponses(instId, res, body, wantStream);
      if (p === '/chat/completions' || p === '/v1/chat/completions') return await handleChat(instId, res, body, wantStream);
      sendJson(res, 404, { error: { message: 'unknown path ' + p } });
    } catch (e) { if (!res.headersSent) sendJson(res, 500, { error: { message: e.message } }); else res.end(); }
  };
}

function listenOn(handler, port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

function portInUse(port) {
  for (const v of servers.values()) if (v.port === port) return true;
  return false;
}

// 启动某实例的 server（幂等）；conf 里存过端口/token 则沿用，否则新分配
async function start(instId) {
  if (servers.has(instId)) return statusOf(instId);
  const conf = loadConf();
  conf.instances = conf.instances || {};
  const saved = conf.instances[instId] || {};
  let port = saved.port || DEFAULT_PORT;
  while (portInUse(port)) port += 1;
  const token = saved.token || id('cgw');
  const handler = makeOnRequest(instId);
  let srv = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { srv = await listenOn(handler, port); break; }
    catch (e) { if (e.code === 'EADDRINUSE') { port += 1; continue; } throw e; }
  }
  if (!srv) throw new Error('无可用端口');
  servers.set(instId, { server: srv, port, token });
  conf.instances[instId] = { port, token };
  saveConf(conf);
  log(`实例 ${instId} 监听 127.0.0.1:${port}`);
  return statusOf(instId);
}

function stop(instId) {
  const s = servers.get(instId);
  if (s && s.server) { try { s.server.close(); } catch {} }
  servers.delete(instId);
}
function stopAll() { for (const k of [...servers.keys()]) stop(k); }

// 彻底移除实例：停 server + 从 conf 删除记录
function forget(instId) {
  stop(instId);
  const conf = loadConf();
  if (conf.instances && conf.instances[instId]) { delete conf.instances[instId]; saveConf(conf); }
}

function statusOf(instId) {
  const s = servers.get(instId);
  return { id: instId, running: !!s, port: s ? s.port : null, token: s ? s.token : null, models: WEB_MODELS };
}
function status() { return { instances: [...servers.keys()].map(statusOf), models: WEB_MODELS, confPath: CONF_PATH }; }

module.exports = {
  start, stop, stopAll, forget, statusOf, status, DEFAULT_PORT, WEB_MODELS,
  flattenToTurn, flattenToPrompt, MAX_INPUT_IMAGES, IMAGE_ONLY_PROMPT,
  handleChat,
};
