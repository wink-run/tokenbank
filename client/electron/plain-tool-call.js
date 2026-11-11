'use strict';

// 已投射的 HTTP API / 本地 CLI：按保存的配置执行。
// 接口地址固定。调用参数里的字段会覆盖请求体模板，避免每次都发出示例值。
const { spawn } = require('child_process');

const OUTPUT_CAP = 20000;

function toolPrefix(name) {
  return String(name || 'tool')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'tool';
}

/** 网关工具名：与 MCP 一样用「名称__call」 */
function plainToolCallName(tool) {
  return `${toolPrefix(tool?.name || tool?.id)}__call`;
}

function contentTypeOf(tool) {
  const headers = tool?.headers || {};
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type');
  return key ? String(headers[key]) : '';
}

/** 请求体模板若是 JSON 对象，取出字段，供工具参数声明使用。 */
function bodyTemplateObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* 非 JSON 模板保持原样 */ }
  return null;
}

/** curl 导入的 a=b&c=d。调用参数按同名字段覆盖，不改成 JSON。 */
function formTemplateObject(raw, contentType) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  if (/json/i.test(contentType || '')) return null;
  const text = raw.trim();
  const declaredForm = /application\/x-www-form-urlencoded/i.test(contentType || '');
  const looksForm = text.includes('=') && !text.includes('\n') && !text.startsWith('{') && !text.startsWith('[');
  if (!declaredForm && !looksForm) return null;
  const out = {};
  for (const part of text.split('&')) {
    if (!part) continue;
    const idx = part.indexOf('=');
    const key = decodeURIComponent((idx < 0 ? part : part.slice(0, idx)).replace(/\+/g, ' '));
    const value = idx < 0 ? '' : decodeURIComponent(part.slice(idx + 1).replace(/\+/g, ' '));
    if (key) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

function encodeForm(fields) {
  return Object.entries(fields).map(([key, value]) => (
    `${encodeURIComponent(key)}=${encodeURIComponent(value == null ? '' : String(value))}`
  )).join('&');
}

function urlQueryKeys(rawUrl) {
  try {
    return new Set(new URL(rawUrl).searchParams.keys());
  } catch {
    return new Set();
  }
}

/** query / body / headers 是封装字段，其余都是接口自己的参数。 */
function looseFields(extra) {
  const out = {};
  for (const [key, value] of Object.entries(extra || {})) {
    if (key === 'query' || key === 'body' || key === 'headers' || value == null) continue;
    out[key] = value;
  }
  return out;
}

function plainToolSchema(tool) {
  const api = tool?.type === 'api';
  const fields = {};
  const addField = (key, value) => {
    if (!key || fields[key]) return;
    const prop = { description: '调用时传入实际值，会覆盖模板或地址里的同名示例' };
    if (typeof value === 'string') prop.type = 'string';
    else if (typeof value === 'number') prop.type = 'number';
    else if (typeof value === 'boolean') prop.type = 'boolean';
    fields[key] = prop;
  };
  for (const [key, value] of Object.entries(bodyTemplateObject(tool?.body) || {})) addField(key, value);
  for (const [key, value] of Object.entries(formTemplateObject(tool?.body, contentTypeOf(tool)) || {})) addField(key, value);
  for (const key of urlQueryKeys(tool?.url)) addField(key, '');
  return {
    name: plainToolCallName(tool),
    description: tool?.description
      || (api
        ? `${tool?.display_name || tool?.name}: ${tool?.method || 'POST'} ${tool?.url || ''}`
        : `${tool?.display_name || tool?.name}: ${tool?.command || ''}`),
    inputSchema: api
      ? {
        type: 'object',
        additionalProperties: true,
        properties: {
          ...fields,
          query: { type: 'object', description: '追加到地址上的查询参数' },
          body: { description: '完整请求体。对象会与模板合并，字符串则原样发送' },
          headers: { type: 'object', description: '额外请求头，不能覆盖已保存的头' },
        },
      }
      : {
        type: 'object',
        properties: {
          args: { type: 'array', items: { type: 'string' }, description: '追加到命令后的参数' },
          input: { type: 'string', description: '写入标准输入' },
        },
      },
  };
}

function headerHas(headers, name) {
  const want = String(name || '').toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === want);
}

function clip(text) {
  const s = String(text || '');
  return s.length > OUTPUT_CAP ? `${s.slice(0, OUTPUT_CAP)}\n…(truncated)` : s;
}

function queryValue(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * 模板只提供缺省字段。调用时传入的同名字段覆盖它。
 * consumed 是已经写进地址查询参数的字段，不再重复放进请求体。
 */
function resolveApiBody(tool, extra, consumed) {
  const loose = looseFields(extra);
  for (const key of consumed || []) delete loose[key];
  const explicit = extra.body && typeof extra.body === 'object' && !Array.isArray(extra.body)
    ? extra.body
    : null;
  const form = formTemplateObject(tool.body, contentTypeOf(tool));
  if (form && typeof extra.body !== 'string') {
    return encodeForm({ ...form, ...loose, ...(explicit || {}) });
  }
  const template = bodyTemplateObject(tool.body);
  const merged = { ...(template || {}), ...loose, ...(explicit || {}) };
  if (Object.keys(merged).length) return JSON.stringify(merged);
  if (typeof extra.body === 'string') return extra.body;
  if (typeof tool.body === 'string') return tool.body;
  return '';
}

async function callConfiguredApi(tool, args) {
  const extra = args && typeof args === 'object' ? args : {};
  const loose = looseFields(extra);
  const url = new URL(tool.url);
  const method = String(tool.method || 'POST').toUpperCase();
  const consumedByQuery = new Set();
  if (extra.query && typeof extra.query === 'object') {
    for (const [key, value] of Object.entries(extra.query)) {
      if (value == null) continue;
      url.searchParams.set(key, queryValue(value));
      consumedByQuery.add(key);
    }
  }
  for (const [key, value] of Object.entries(loose)) {
    // 地址上已有的示例参数，或 GET/HEAD 的接口字段，都改查询参数
    if (method === 'GET' || method === 'HEAD' || url.searchParams.has(key)) {
      url.searchParams.set(key, queryValue(value));
      consumedByQuery.add(key);
    }
  }
  const headers = { ...(tool.headers || {}) };
  if (extra.headers && typeof extra.headers === 'object') {
    for (const [key, value] of Object.entries(extra.headers)) {
      if (value == null || headerHas(headers, key)) continue;
      headers[key] = String(value);
    }
  }
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    const body = resolveApiBody(tool, extra, consumedByQuery);
    if (body) {
      init.body = body;
      if (!headerHas(headers, 'content-type')) {
        const form = body.includes('=') && !body.trim().startsWith('{') && !body.trim().startsWith('[');
        headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
      }
    }
  }
  const timeout = Number(tool.timeout_ms) > 0 ? Number(tool.timeout_ms) : 30000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  init.signal = ctl.signal;
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return `HTTP ${res.status}\n${clip(text)}`;
  } finally {
    clearTimeout(timer);
  }
}

function callConfiguredCli(tool, args) {
  const extra = args && typeof args === 'object' ? args : {};
  const more = Array.isArray(extra.args) ? extra.args.map((item) => String(item)) : [];
  return new Promise((resolve, reject) => {
    const child = spawn(tool.command, [...(tool.args || []), ...more], {
      cwd: tool.cwd || undefined,
      env: { ...process.env, ...(tool.env || {}) },
      shell: false,
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (buf) => { if (out.length < OUTPUT_CAP) out += buf.toString(); });
    child.stderr?.on('data', (buf) => { if (err.length < OUTPUT_CAP) err += buf.toString(); });
    if (extra.input != null) child.stdin?.end(String(extra.input));
    else child.stdin?.end();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('命令超时'));
    }, 60000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = [out.trim(), err.trim() && `stderr:\n${err.trim()}`].filter(Boolean).join('\n');
      if (code !== 0) reject(new Error(text || `exit ${code}`));
      else resolve(text || '(no output)');
    });
  });
}

async function callPlainTool(tool, args) {
  if (!tool) throw new Error('缺少工具');
  if (tool.type === 'api') {
    if (!tool.url) throw new Error('未配置 URL');
    return callConfiguredApi(tool, args);
  }
  if (tool.type === 'cli') {
    if (!tool.command) throw new Error('未配置命令');
    return callConfiguredCli(tool, args);
  }
  throw new Error('不是 HTTP API 或本地 CLI');
}

module.exports = {
  toolPrefix,
  plainToolCallName,
  plainToolSchema,
  callPlainTool,
};
