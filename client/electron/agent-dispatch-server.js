// agent-dispatch-server.js
// 主进程本地 HTTP 派发服务：供 Codex 沙箱内的 bridge MCP 子进程调用，避免子进程写 SQLite。
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const TB_DIR = path.join(os.homedir(), '.tokenbank');
const INFO_PATH = path.join(TB_DIR, 'dispatch-server.json');

let server = null;
let endpoint = null;
/** 主进程注册：MCP 命中后弹息票 */
let onResourceHit = null;

function setResourceHitHandler(fn) {
  onResourceHit = typeof fn === 'function' ? fn : null;
}

/** 主进程内直达息票（避免 /dispatch 处理中再 HTTP 回环） */
function deliverResourceHitLocal(evt) {
  if (typeof onResourceHit !== 'function') return false;
  try {
    onResourceHit(evt || {});
    return true;
  } catch (e) {
    console.warn('[dispatch-server] deliverResourceHitLocal:', e.message);
    return false;
  }
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function writeInfo(info) {
  fs.mkdirSync(TB_DIR, { recursive: true });
  fs.writeFileSync(INFO_PATH, JSON.stringify(info, null, 2), 'utf8');
  endpoint = info;
}

/** 供 bridge launcher 读取派发端点（url + token） */
function getDispatchEndpoint() {
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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 2 * 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/**
 * 启动派发 HTTP 服务（仅监听 127.0.0.1）
 * @param {import('./agent-executor')} agentExecutor
 * @param {import('./resource-manager')} resourceManager
 */
function startDispatchServer(agentExecutor, resourceManager) {
  if (server) return getDispatchEndpoint();

  const token = generateToken();

  server = http.createServer(async (req, res) => {
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (bearer !== token) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    try {
      const host = req.headers.host || '127.0.0.1';
      const url = new URL(req.url || '/', `http://${host}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/agents') {
        let agents = await agentExecutor.listAvailableAgents();
        // 按智能体路由收窄名单：只给主智能体看这条路由允许派的
        const routeId = url.searchParams.get('route') || '';
        if (routeId) {
          const routes = require('./agent-routes');
          const route = routes.get(routeId);
          if (route) agents = routes.filterAgents(route, agents);
        }
        sendJson(res, 200, { agents });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/prompt') {
        const name = url.searchParams.get('name') || '';
        const args = url.searchParams.get('args') || '';
        const clientId = url.searchParams.get('clientId') || '';
        const result = resourceManager.resolvePromptForClient(name, args, clientId);
        if (result?.found && result.id) {
          try { resourceManager.recordResourceHit?.(result.id, clientId); } catch { /* ignore */ }
        }
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/dispatch') {
        const body = await readJsonBody(req);
        const agentId = String(body.agentId || body.agent_id || '').trim();
        const prompt = String(body.prompt || '').trim();
        if (!agentId || !prompt) {
          sendJson(res, 400, { error: 'missing agentId or prompt' });
          return;
        }
        // 路由的名单之外的不派（尤其是没打开开关的雇来的社区智能体，会扣积分）
        const routeId = String(body.route || '').trim();
        if (routeId) {
          const routes = require('./agent-routes');
          const route = routes.get(routeId);
          if (route && !routes.canDispatchTo(route, agentId, await agentExecutor.listAvailableAgents())) {
            sendJson(res, 403, { error: `「${route.name}」的名单里没有 ${agentId}，只能派给 tb_list_agents 列出的智能体` });
            return;
          }
        }

        const status = await agentExecutor.dispatchAndWait(agentId, prompt, {
          workingDir: body.workingDir || body.working_dir,
          parentTaskId: body.parentTaskId || body.parent_task_id,
          parentSessionKey: body.parentSessionKey || body.parent_session_key,
          parentSessionInstanceId: body.parentSessionInstanceId || body.parent_session_instance_id,
          clientId: body.clientId || body.client_id || process.env.TB_CLIENT_ID || '',
          mode: 'worker',
        });
        sendJson(res, 200, { status });
        return;
      }

      // 点将/取用命中 → 主窗口息票（不挡 MCP）
      if (req.method === 'POST' && url.pathname === '/resource-hit') {
        const body = await readJsonBody(req);
        try { onResourceHit?.(body || {}); } catch (e) {
          console.warn('[dispatch-server] resource-hit handler:', e.message);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[dispatch-server] request failed:', e.message);
      sendJson(res, 500, { error: e.message || 'internal error' });
    }
  });

  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    writeInfo({ url: `http://127.0.0.1:${port}`, token });
    console.log(`[dispatch-server] listening on ${endpoint.url}`);
  });

  return getDispatchEndpoint();
}

function stopDispatchServer() {
  if (server) {
    try { server.close(); } catch {}
    server = null;
  }
  try { if (fs.existsSync(INFO_PATH)) fs.unlinkSync(INFO_PATH); } catch {}
  endpoint = null;
}

module.exports = {
  startDispatchServer,
  stopDispatchServer,
  getDispatchEndpoint,
  setResourceHitHandler,
  deliverResourceHitLocal,
  INFO_PATH,
};
