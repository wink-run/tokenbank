// client/electron/mesh/tunnel.js
// 隧道：一条设备网络的流承载一次 HTTP 请求。
// 发起端把请求原样发过去；接收端校验路径白名单、换掉鉴权头，转给自己本机的网关 127.0.0.1:<端口>。
// 这样调用另一台设备，就等于调用那台设备自己的 :11430，接口完全一样。
'use strict';

const http = require('http');
const { FrameStream } = require('./frames');

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
  ['PUT', /^\/v1\/devices\/self\/aliases$/],
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

/**
 * 在一条流上发一次请求，返回响应头和逐块读取响应体的迭代器。
 * @returns {Promise<{ status: number, headers: object, chunks: AsyncGenerator<Buffer> }>}
 */
async function request(io, { method, path, headers, body }) {
  const fsm = new FrameStream(io);
  await fsm.writeJson({ t: 'http', method, path, headers: headers || {} });
  if (body && body.length) await fsm.writeData(Buffer.isBuffer(body) ? body : Buffer.from(body));
  await fsm.finish();
  const head = await fsm.nextJson();
  if (!head || head.t !== 'head') throw new Error('对端没有返回响应');
  async function* chunks() {
    for (;;) {
      const f = await fsm.next();
      if (!f) return;
      if (f.kind === 'data') yield f.value;
      else if (f.value && f.value.t === 'error') throw new Error(f.value.message || '对端响应中断');
    }
  }
  return { status: head.status, headers: head.headers || {}, chunks: chunks() };
}

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
 * 处理对端开来的一条流。
 * @param {object} io 流适配器
 * @param {{ gatewayPort: number, meshKey: string, fromDeviceId: string, log?: Function }} ctx
 */
async function serve(io, ctx) {
  const fsm = new FrameStream(io);
  const reply = async (status, obj) => {
    await fsm.writeJson({ t: 'head', status, headers: { 'content-type': 'application/json' } });
    await fsm.writeData(Buffer.from(JSON.stringify(obj)));
    await fsm.finish();
  };
  const head = await fsm.nextJson();
  if (!head || head.t !== 'http') return;
  if (!isAllowed(head.method, head.path)) {
    ctx.log?.(`[mesh] 拒绝 ${head.method} ${head.path}（不在白名单）`);
    await reply(403, { error: { message: 'path not allowed over device mesh', type: 'forbidden' } });
    return;
  }
  const parts = [];
  let size = 0;
  for (;;) {
    const f = await fsm.next();
    if (!f) break;
    if (f.kind !== 'data') continue;
    size += f.value.length;
    if (size > MAX_REQUEST_BODY) { await reply(413, { error: { message: 'request body too large' } }); return; }
    parts.push(f.value);
  }
  const body = Buffer.concat(parts);
  const headers = inboundHeaders(head.headers, ctx);
  headers['content-length'] = String(body.length);

  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: ctx.gatewayPort, method: head.method, path: head.path, headers,
    }, (res) => {
      // 按顺序写回，写不完就先停住读，免得内存堆积
      let chain = fsm.writeJson({ t: 'head', status: res.statusCode, headers: responseHeaders(res.headers) });
      res.on('data', (c) => {
        res.pause();
        chain = chain.then(() => fsm.writeData(c)).then(() => res.resume(), () => res.destroy());
      });
      res.on('end', () => { chain.then(() => fsm.finish()).catch(() => {}).finally(resolve); });
      res.on('error', () => { chain.then(() => fsm.finish()).catch(() => {}).finally(resolve); });
    });
    req.on('error', (e) => {
      reply(502, { error: { message: `本机网关不可用：${e.message}`, type: 'mesh_upstream' } }).catch(() => {}).finally(resolve);
    });
    req.end(body);
  });
}

module.exports = { request, readAll, pipeTo, serve, isAllowed, inboundHeaders, ALLOWED };
