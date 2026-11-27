// client/electron/claude-live-models.js
// Claude 订阅能用哪些模型：用订阅自己的 token 问 Anthropic 的模型列表（GET /v1/models），每天一次。
// 新模型发布后不用改代码：上下文窗口、最大输出都从这里来；claude-models.js 里的内置目录只是拿不到时的兜底。
// 存在 ~/.tokenbank/claude-models-live.json，启动时先读文件，网络不通也有上一次的结果。
'use strict';

const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const REFRESH_MS = 24 * 60 * 60 * 1000;
/** 请求里出现没见过的 claude-* 名字时提前刷新，但这么久之内只刷一次 */
const EAGER_MIN_MS = 10 * 60 * 1000;

let cache = null;      // { fetchedAt, models: [{ id, display_name, created_at, max_input_tokens, max_tokens }] }
let inflight = null;
let lastEager = 0;
let fetcher = defaultFetch;

function file() { return path.join(os.homedir(), '.tokenbank', 'claude-models-live.json'); }

function load() {
  if (cache) return cache;
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = j && Array.isArray(j.models) ? j : { fetchedAt: 0, models: [] };
  } catch { cache = { fetchedAt: 0, models: [] }; }
  return cache;
}

function save(next) {
  cache = next;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next), { mode: 0o600 });
  } catch { /* 写不了就只在内存里 */ }
}

/** 拿到的模型，新的在前 */
function list() {
  return [...load().models].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function get(id) {
  const want = String(id || '').toLowerCase();
  return load().models.find((m) => String(m.id).toLowerCase() === want) || null;
}

function defaultFetch(token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/models?limit=1000', method: 'GET', timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        if (res.statusCode !== 200) { reject(new Error(`HTTP_${res.statusCode}: ${text.slice(0, 200)}`)); return; }
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/**
 * 刷新一次。getToken 返回订阅的 access_token（没有就返回空，什么都不做）。
 * @param {{ getToken: () => Promise<string|null>, force?: boolean }} q
 * @returns {Promise<boolean>} 是否拿到了新列表
 */
async function refresh({ getToken, force = false } = {}) {
  if (!force && Date.now() - (load().fetchedAt || 0) < REFRESH_MS) return false;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const token = await getToken();
      if (!token) return false;
      const body = await fetcher(token);
      const models = (Array.isArray(body?.data) ? body.data : [])
        .filter((m) => m && /^claude-/i.test(String(m.id || '')))
        .map((m) => ({
          id: String(m.id),
          display_name: m.display_name || null,
          created_at: m.created_at || null,
          max_input_tokens: Number(m.max_input_tokens) || null,
          max_tokens: Number(m.max_tokens) || null,
        }));
      if (!models.length) return false;
      save({ fetchedAt: Date.now(), models });
      return true;
    } catch (e) {
      console.warn('[claude-models] 拿不到模型列表，先用上次的:', e.message);
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** 请求里见到列表里没有的 claude-* 名字：可能是刚发布的，提前刷一次（不等结果） */
function noteUnknown(model, getToken) {
  if (!/^claude-/i.test(String(model || '')) || get(model)) return;
  if (Date.now() - lastEager < EAGER_MIN_MS) return;
  lastEager = Date.now();
  refresh({ getToken, force: true }).catch(() => {});
}

module.exports = {
  list, get, refresh, noteUnknown, REFRESH_MS,
  _setForTests: ({ models, fetch } = {}) => {
    if (models !== undefined) cache = { fetchedAt: models ? Date.now() : 0, models: models || [] };
    if (fetch) fetcher = fetch;
    lastEager = 0;
    inflight = null;
  },
};
