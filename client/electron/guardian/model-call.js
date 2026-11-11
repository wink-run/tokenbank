// client/electron/guardian/model-call.js
// 智能管家自己的模型请求：走本机网关，带 X-TokenBank-Guardian 标记，返回正文和用量，失败返回 ok:false 不抛错。
// 只给离线的自省 / 用户点击的修复用，不在任何业务请求链路上。
// 固定的调用方 Key（tb-guardian）让这些请求在用量记录里能被认出来，自省复盘时不把自己的试跑算进去。
'use strict';

const http = require('http');

function gatewayAddr() {
  let reverse = '127.0.0.1:11430';
  try { reverse = require('../config-loader').gatewayCtx().reverse || reverse; } catch { /* 默认端口 */ }
  const [host, port] = String(reverse).split(':');
  return { host: host || '127.0.0.1', port: Number(port) || 11430 };
}

/**
 * @param {{ model?: string, messages: Array, maxTokens?: number, temperature?: number, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, text: string, status: number, latencyMs: number, tokens: number, error?: string }>}
 */
function chat({ model = 'auto', messages, maxTokens = 300, temperature = 0, timeoutMs = 60000 } = {}) {
  const { host, port } = gatewayAddr();
  const payload = JSON.stringify({ model, temperature, max_tokens: maxTokens, messages });
  const t0 = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ latencyMs: Date.now() - t0, tokens: 0, text: '', status: 0, ...r }); } };
    const req = http.request({
      host, port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-TokenBank-Guardian': '1', Authorization: 'Bearer tb-guardian' },
      timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(buf); } catch { /* 非 JSON */ }
        const text = String(j?.choices?.[0]?.message?.content || '');
        const u = j?.usage || {};
        const tokens = (u.total_tokens || 0) || ((u.prompt_tokens || u.input_tokens || 0) + (u.completion_tokens || u.output_tokens || 0));
        const ok = res.statusCode < 400 && !!text;
        done({ ok, text, status: res.statusCode, tokens, ...(ok ? {} : { error: j?.error?.message || j?.error || `HTTP ${res.statusCode}` }) });
      });
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, error: e.message }));
    req.end(payload);
  });
}

/** 估算一段文本的 token（没有 usage 时兜底：中文约 1 字 1 token，英文约 4 字符 1 token） */
function estimateTokens(text) {
  const s = String(text || '');
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

/** 本机网关有没有可用的对话模型（智能管家的「模型」是否就绪）；网关没起来返回 null */
function modelStatus({ timeoutMs = 5000 } = {}) {
  const { host, port } = gatewayAddr();
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/v1/models', method: 'GET', timeout: timeoutMs,
      headers: { 'X-TokenBank-Guardian': '1', Authorization: 'Bearer tb-guardian' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const list = (JSON.parse(buf).data || []).filter(m => (m.id || m.name) && String(m.model_type || m.type || 'chat') !== 'image');
          resolve({ ok: list.length > 0, count: list.length });
        } catch { resolve({ ok: false, count: 0 }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

module.exports = { chat, estimateTokens, gatewayAddr, modelStatus };
