// community-agent-client.js
// 主进程调用云端社区武将 API（名片列表 / 远程派发），不拉正文
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');

function agentConfigPath() {
  return path.join(os.homedir(), '.llm-agent', 'config.json');
}

/**
 * local-config.json 候选路径（与 mcp-gateway-targets / main.localConfigPath 对齐）。
 * 必须优先 Electron userData——Windows 正式包为 %APPDATA%\\Token Bank，
 * 开发态多为 %APPDATA%\\llm-proxy-client；硬编码漏路径会导致读不到 cloud_config.token。
 */
function candidateLocalConfigPaths() {
  const paths = [];
  if (process.env.TB_USER_DATA) {
    paths.push(path.join(process.env.TB_USER_DATA, 'local-config.json'));
  }
  try {
    const electron = require('electron');
    const app = electron.app || electron.default?.app;
    if (app && typeof app.getPath === 'function') {
      paths.push(path.join(app.getPath('userData'), 'local-config.json'));
    }
  } catch { /* 非 Electron / 未 ready */ }

  const home = os.homedir();
  if (process.platform === 'darwin') {
    paths.push(
      path.join(home, 'Library/Application Support/Token Bank/local-config.json'),
      path.join(home, 'Library/Application Support/Token Bank-dev/local-config.json'),
      path.join(home, 'Library/Application Support/llm-proxy-client/local-config.json'),
    );
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    paths.push(
      path.join(appData, 'Token Bank', 'local-config.json'),
      path.join(appData, 'Token Bank-dev', 'local-config.json'),
      path.join(appData, 'llm-proxy-client', 'local-config.json'),
    );
  } else {
    paths.push(
      path.join(home, '.config/Token Bank/local-config.json'),
      path.join(home, '.config/token-bank/local-config.json'),
      path.join(home, '.config/llm-proxy-client/local-config.json'),
    );
  }
  return [...new Set(paths.filter(Boolean))];
}

function readJson(p) {
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* ignore */ }
  return null;
}

/** ws://host:port/ws/worker → http://host:port */
function wsToHttpBase(serverUrl) {
  const s = String(serverUrl || '').trim();
  if (!s) return '';
  return s
    .replace(/^ws/i, 'http')
    .replace(/\/ws\/worker\/?$/i, '')
    .replace(/\/$/, '');
}

/**
 * 解析云端 base + token（与模型/P2P 一致：优先 cloud_config.token = API Key）
 * @returns {{ base: string, token: string }}
 */
function resolveCloudAuth() {
  const agentCfg = readJson(agentConfigPath()) || {};
  const agentBase = wsToHttpBase(agentCfg.server_url);

  // 与模型转发同源：local-config.cloud_config.{url, token}
  for (const p of candidateLocalConfigPaths()) {
    const cfg = readJson(p);
    if (!cfg) continue;
    const cc = cfg.cloud_config || {};
    const token = String(cc.token || '').trim();
    if (!token) continue;
    let base = String(cc.url || '').trim()
      .replace(/\/$/, '')
      .replace(/\/(api|v\d+)(\/.*)?$/, '');
    if (!base) base = agentBase;
    if (base) {
      return { base: base.replace(/\/$/, ''), token };
    }
  }

  // 回退：仅有 agent 服务地址时仍返回 base（无 token 由上层报错）
  return { base: agentBase.replace(/\/$/, ''), token: '' };
}

function httpJson(method, url, { token, body, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch (e) { reject(new Error(`invalid url: ${url}`)); return; }

    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: timeoutMs || 30_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
        if (res.statusCode >= 400) {
          const detail = data?.detail ?? data?.error ?? text ?? `HTTP ${res.statusCode}`;
          const msg = (detail && typeof detail === 'object' && typeof detail.error === 'string')
            ? detail.error
            : (typeof detail === 'string' ? detail : JSON.stringify(detail));
          const err = new Error(msg);
          err.status = res.statusCode;
          err.data = data;
          reject(err);
          return;
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 在线社区武将名片 */
async function listOnlineCommunityAgents() {
  const { base, token } = resolveCloudAuth();
  if (!base) throw new Error('未配置 Token Bank 服务地址');
  if (token) {
    try {
      const r = await httpJson('GET', `${base}/api/agents`, { token, timeoutMs: 15_000 });
      return {
        agents: r.data?.agents || [],
        credits_per_task: r.data?.credits_per_task,
      };
    } catch (e) {
      if (e.status !== 401) throw e;
    }
  }
  const r = await httpJson('GET', `${base}/public/agents`, { timeoutMs: 15_000 });
  return { agents: r.data?.agents || [], credits_per_task: null };
}

/** 从 SSE 缓冲里取出完整 data 事件。 */
function takeSseEvents(buffer) {
  const events = [];
  let rest = buffer;
  while (true) {
    const idx = rest.indexOf('\n\n');
    if (idx < 0) break;
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch { /* 半截 JSON 留给下一帧 */ }
  }
  return { events, rest };
}

/**
 * 云端任务：stream=true 时边收进度边回调，结束返回和普通 JSON 一样的结果。
 * 服务端若仍回整包 JSON，也按最终结果处理。
 */
function postAgentTask(base, { token, body, timeoutMs, onProgress }) {
  return new Promise((resolve, reject) => {
    let parsed;
    const url = `${base}/api/agent-tasks`;
    try { parsed = new URL(url); }
    catch (e) { reject(new Error(`invalid url: ${url}`)); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        Accept: 'text/event-stream, application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs || 620_000,
    }, (res) => {
      const ctype = String(res.headers['content-type'] || '');
      const sse = ctype.includes('text/event-stream');
      let buf = '';
      let finalEvent = null;
      const fail = (message, data) => {
        const err = new Error(message || `HTTP ${res.statusCode}`);
        err.status = res.statusCode;
        err.data = data;
        reject(err);
      };
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (!sse) return;
        const taken = takeSseEvents(buf);
        buf = taken.rest;
        for (const ev of taken.events) {
          if (ev.event === 'progress') onProgress?.(ev);
          else finalEvent = ev;
        }
      });
      res.on('end', () => {
        if (sse) {
          const tail = takeSseEvents(`${buf}\n\n`);
          for (const ev of tail.events) {
            if (ev.event === 'progress') onProgress?.(ev);
            else finalEvent = ev;
          }
          if (res.statusCode >= 400 && !finalEvent) {
            fail(`HTTP ${res.statusCode}`);
            return;
          }
          resolve(finalEvent || { ok: false, error: 'empty stream', status: 'failed' });
          return;
        }
        let data = null;
        try { data = buf ? JSON.parse(buf) : null; } catch { data = { detail: buf }; }
        if (res.statusCode >= 400) {
          const detail = data?.detail ?? data?.error ?? buf;
          const msg = (detail && typeof detail === 'object' && typeof detail.error === 'string')
            ? detail.error
            : (typeof detail === 'string' ? detail : JSON.stringify(detail));
          fail(msg, data);
          return;
        }
        resolve(data);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('request timeout'));
    });
    req.write(payload);
    req.end();
  });
}

/** 雇佣记录没有用户名时，从当前在线名片补一个。多名出租者同时在线则不猜。 */
async function resolveCommunityOwner(assistantId, owner) {
  const known = String(owner || '').trim().replace(/^@+/, '').replace(/@/g, '');
  if (known && !/^[0-9a-f]{8}$/i.test(known)) return known;
  const aid = String(assistantId || '').trim();
  if (!aid) return null;
  try {
    const { agents } = await listOnlineCommunityAgents();
    const owners = new Set();
    for (const card of agents || []) {
      if (String(card?.id || '') !== aid) continue;
      const nick = String(card.owner_nickname || '').trim().replace(/@/g, '');
      if (nick) owners.add(nick);
    }
    if (owners.size === 1) return [...owners][0];
  } catch { /* 目录不可用时仍按已有用户名派发 */ }
  return null;
}

/**
 * 远程雇佣执行。stream 为 true 才向云端要 SSE，进度经 onProgress 吐出；否则等整段结果。
 * @returns {Promise<object>}
 */
async function runCommunityAgentTask({ assistantId, prompt, owner, timeoutMs, images, files, stream, onProgress, appId } = {}) {
  const { base, token } = resolveCloudAuth();
  if (!base) throw new Error('未配置 Token Bank 服务地址');
  if (!token) throw new Error('请先登录并启用转发 Key（与模型社区源同一套 cloud_config.token）');
  const aid = String(assistantId || '').trim();
  const text = String(prompt || '').trim();
  if (!aid || !text) throw new Error('assistant_id and prompt required');
  const who = await resolveCommunityOwner(aid, owner);
  // stream 开关：打开才向云端要 SSE，否则等整段结果
  const wantStream = !!stream;
  // 发起方标识：调用方显式传递（不从 stream 推断）
  const caller = String(appId || '').trim();
  const taskBody = {
    assistant_id: aid,
    prompt: text,
    owner: who || undefined,
    timeout_ms: timeoutMs || undefined,
    images: Array.isArray(images) && images.length ? images : undefined,
    files: Array.isArray(files) && files.length ? files : undefined,
    ...(wantStream ? { stream: true } : {}),
    ...(caller ? { app_id: caller } : {}),
  };
  const waitMs = timeoutMs || 620_000;
  const data = wantStream
    ? await postAgentTask(base, { token, timeoutMs: waitMs, onProgress, body: taskBody })
    : (await httpJson('POST', `${base}/api/agent-tasks`, { token, timeoutMs: waitMs, body: taskBody })).data;
  if (who) {
    try { require('./hired-community-agents').rememberOwner(aid, who); } catch { /* 名单只是缓存 */ }
  }
  return data;
}

/** 雇佣上报：服务端真实被雇次数 +1（失败不影响本机雇佣） */
async function reportCommunityAgentHire({ assistantId, workerId } = {}) {
  const { base, token } = resolveCloudAuth();
  if (!base || !token) return null;
  const aid = String(assistantId || '').trim();
  if (!aid) return null;
  try {
    const r = await httpJson('POST', `${base}/api/agents/hire`, {
      token,
      timeoutMs: 8_000,
      body: {
        assistant_id: aid,
        worker_id: workerId || undefined,
      },
    });
    return r.data;
  } catch {
    return null;
  }
}

module.exports = {
  resolveCloudAuth,
  listOnlineCommunityAgents,
  runCommunityAgentTask,
  resolveCommunityOwner,
  reportCommunityAgentHire,
  wsToHttpBase,
};
