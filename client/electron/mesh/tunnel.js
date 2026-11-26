// client/electron/mesh/tunnel.js
// 设备之间转一次 HTTP 请求：发起端把请求原样发过去；接收端校验路径白名单、换掉鉴权头，
// 转给自己本机的网关 127.0.0.1:<端口>。这样调用另一台设备，就等于调用那台设备自己的 :11430，接口完全一样。
// 消息怎么走（直连、经中继）由 node.js 管，这里只管 HTTP 这一层。
'use strict';

const http = require('http');

const MAX_REQUEST_BODY = 32 * 1024 * 1024;

// 对端只接受这些路径。别的一律 403，不能把隧道当通用代理用。
const ALLOWED = [
  ['GET', /^\/v1\/models$/],
  ['POST', /^\/v1\/chat\/completions$/],
  ['POST', /^\/v1\/messages$/],
  ['GET', /^\/v1\/agent\/harnesses$/],
  ['POST', /^\/v1\/agent\/responses$/],
  ['GET', /^\/v1\/agent\/responses\/[^/]+$/],
  ['POST', /^\/v1\/agent\/responses\/[^/]+\/cancel$/],
  ['PUT', /^\/v1\/devices\/self\/name$/],
];

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer']);

function isAllowed(method, rawPath) {
  const p = String(rawPath || '').split('?')[0];
  if (p.includes('..') || p.includes('//')) return false;
  return ALLOWED.some(([m, re]) => m === String(method).toUpperCase() && re.test(p));
}

/** 接收端转给本机网关时用的请求头：外来的鉴权和 x-tb-mesh-* 一律去掉，换成本机设备网络 Key */
function inboundHeaders(headers, { meshKey, fromDeviceId }) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key === 'host' || key === 'content-length') continue;
    if (key === 'authorization' || key === 'x-api-key' || key.startsWith('x-tb-mesh-')) continue;
    out[key] = v;
  }
  out.authorization = `Bearer ${meshKey}`;
  out['x-tb-mesh-from'] = String(fromDeviceId);
  out['x-tb-mesh-hop'] = '1';
  return out;
}

function responseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

// ── 发起端 ───────────────────────────────────────────────────────────────────
// 响应的形状：{ status, headers, chunks }，chunks 是逐块到达的 Buffer（异步迭代器）

async function readAll(resp) {
  const parts = [];
  for await (const c of resp.chunks) parts.push(c);
  return Buffer.concat(parts);
}

/** 原样（或经 transform 逐块改写）写回给本机调用方 */
async function pipeTo(resp, res, transform) {
  const headers = responseHeaders(resp.headers);
  if (transform) delete headers['content-length'];
  if (!res.headersSent) res.writeHead(resp.status, headers);
  try {
    for await (const c of resp.chunks) {
      const out = transform ? transform(c) : c;
      if (out && out.length) res.write(out);
    }
    if (transform && transform.flush) {
      const tail = transform.flush();
      if (tail && tail.length) res.write(tail);
    }
  } finally {
    res.end();
  }
}

// ── 接收端 ───────────────────────────────────────────────────────────────────

/**
 * 把对端的一次请求转给本机网关，响应逐块回调。
 * @param {{ method, path, headers, body: Buffer }} req
 * @param {{ gatewayPort, meshKey, fromDeviceId, log? }} ctx
 * @param {{ head(status, headers), chunk(buf): Promise|void, done(), error(message) }} out
 * @returns {{ cancel(): void }}
 */
function serveLocal(req, ctx, out) {
  if (!isAllowed(req.method, req.path)) {
    ctx.log?.(`[mesh] 拒绝 ${req.method} ${req.path}（不在白名单）`);
    out.head(403, { 'content-type': 'application/json' });
    out.chunk(Buffer.from(JSON.stringify({ error: { message: 'path not allowed over device mesh', type: 'forbidden' } })));
    out.done();
    return { cancel() {} };
  }
  const body = req.body || Buffer.alloc(0);
  const method = String(req.method || 'GET').toUpperCase();
  const pathOnly = String(req.path || '').split('?')[0];
  // 对方派来一个智能体任务：记下谁来的、本机网关回了什么。每秒来查进度不打
  const agentPost = method === 'POST' && pathOnly === '/v1/agent/responses';
  if (agentPost) ctx.log?.(`[mesh] 收到来自 ${ctx.fromDeviceId} 的智能体任务（${body.length} 字节）`);
  if (body.length > MAX_REQUEST_BODY) {
    if (agentPost) ctx.log?.(`[mesh] 拒了来自 ${ctx.fromDeviceId} 的智能体任务：正文太大（${body.length} 字节）`);
    out.head(413, { 'content-type': 'application/json' });
    out.chunk(Buffer.from(JSON.stringify({ error: { message: 'request body too large' } })));
    out.done();
    return { cancel() {} };
  }
  const headers = inboundHeaders(req.headers, ctx);
  headers['content-length'] = String(body.length);
  const r = http.request({ host: '127.0.0.1', port: ctx.gatewayPort, method: req.method, path: req.path, headers }, (res) => {
    if (agentPost) ctx.log?.(`[mesh] 本机网关应答 HTTP ${res.statusCode}（来自 ${ctx.fromDeviceId} 的智能体任务）`);
    out.head(res.statusCode, responseHeaders(res.headers));
    let chain = Promise.resolve();
    res.on('data', (c) => {
      res.pause();
      chain = chain.then(() => out.chunk(c)).then(() => res.resume(), () => res.destroy());
    });
    res.on('end', () => { chain.then(() => out.done(), () => {}); });
    res.on('error', (e) => { chain.then(() => out.error(e.message), () => {}); });
  });
  r.on('error', (e) => {
    if (agentPost) ctx.log?.(`[mesh] 转给本机网关失败（来自 ${ctx.fromDeviceId}）：${e.message}`);
    out.error(`本机网关不可用：${e.message}`);
  });
  r.end(body);
  return { cancel() { try { r.destroy(); } catch { /* 已结束 */ } } };
}

module.exports = { readAll, pipeTo, serveLocal, isAllowed, inboundHeaders, responseHeaders, ALLOWED, MAX_REQUEST_BODY };
