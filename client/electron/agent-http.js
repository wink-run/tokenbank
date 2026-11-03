// 智能体任务 HTTP。和模型补全分开挂在 /v1/agent，仍由本机网关进程处理。
'use strict';

const crypto = require('crypto');

const WAIT_MS = 10 * 60 * 1000;
const idempotency = new Map();

function callerKey(req) {
  const raw = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const text = Array.isArray(raw) ? raw[0] : String(raw);
  return text.startsWith('Bearer ') ? text.slice(7).trim() : text.trim();
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({ raw, body: {} });
      try { resolve({ raw, body: JSON.parse(raw) }); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** @returns {{op:'list'}|{op:'create'}|{op:'get',id:string}|{op:'cancel',id:string}|null} */
function parseAgentRoute(method, cleanPath) {
  if (method === 'GET' && cleanPath === '/v1/agent/harnesses') return { op: 'list' };
  if (method === 'POST' && cleanPath === '/v1/agent/responses') return { op: 'create' };
  const m = String(cleanPath || '').match(/^\/v1\/agent\/responses\/([^/]+)(?:\/(cancel))?$/);
  if (!m) return null;
  let id = m[1];
  try { id = decodeURIComponent(id); } catch { /* 保持原样 */ }
  if (method === 'GET' && !m[2]) return { op: 'get', id };
  if (method === 'POST' && m[2] === 'cancel') return { op: 'cancel', id };
  return null;
}

function inputText(input) {
  if (typeof input === 'string') return input.trim();
  if (!Array.isArray(input)) return '';
  return input.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return '';
  }).filter(Boolean).join('\n').trim();
}

function harnessIdFromBody(body) {
  const meta = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  return String(meta.harness_id || body?.harness_id || '').trim();
}

function taskToResponse(task) {
  const statusMap = {
    pending: 'in_progress',
    running: 'in_progress',
    completed: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  };
  const text = task?.result?.summary || task?.result?.output || task?.error || '';
  const created = Number(task?.created_at) || 0;
  const done = Number(task?.completed_at) || 0;
  const response = {
    id: task.id,
    object: 'response',
    status: statusMap[task.status] || task.status || 'in_progress',
    metadata: { harness_id: task.agent_id || null },
    output: text
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: String(text).slice(0, 20000) }] }]
      : [],
  };
  if (created && done && done >= created) response.usage = { duration_ms: done - created };
  return response;
}

function rememberIdempotency(key, raw, response) {
  if (!key) return;
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  idempotency.set(key, { digest, response });
  if (idempotency.size > 200) {
    const oldest = idempotency.keys().next().value;
    idempotency.delete(oldest);
  }
}

async function listHarnesses() {
  const executor = require('./agent-executor');
  const agents = await executor.listAvailableAgents();
  // 只列本机已经装好、执行器能拉起的命令行应用。
  return agents
    .filter((agent) => agent.type === 'cli' && agent.installed)
    .map((agent) => ({ id: agent.id, name: agent.name || agent.id, kind: 'app' }));
}

async function waitTask(executor, taskId) {
  const start = Date.now();
  while (Date.now() - start < WAIT_MS) {
    const task = await executor.getTaskStatus(taskId);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 400));
  }
  return executor.getTaskStatus(taskId);
}

async function handle(req, res, { method, cleanPath, knownKey }) {
  const route = parseAgentRoute(method, cleanPath);
  if (!route && String(cleanPath || '').startsWith('/v1/agent')) {
    sendJson(res, 404, { error: { message: 'not_found', type: 'invalid_request_error' } });
    return true;
  }
  if (!route) return false;

  const key = callerKey(req);
  if (!key || (typeof knownKey === 'function' && !knownKey(key))) {
    sendJson(res, 401, { error: { message: 'invalid api key', type: 'auth_error' } });
    return true;
  }

  const executor = require('./agent-executor');
  if (route.op !== 'create') req.resume();
  try {
    if (route.op === 'list') {
      sendJson(res, 200, { object: 'list', data: await listHarnesses() });
      return true;
    }
    if (route.op === 'get') {
      const task = await executor.getTaskStatus(route.id);
      sendJson(res, 200, taskToResponse(task));
      return true;
    }
    if (route.op === 'cancel') {
      await executor.cancel(route.id);
      const task = await executor.getTaskStatus(route.id);
      sendJson(res, 200, taskToResponse(task));
      return true;
    }

    const { raw, body } = await readBody(req);
    const idem = String(req.headers['idempotency-key'] || '').trim();
    if (idem && idempotency.has(idem)) {
      const prev = idempotency.get(idem);
      const digest = crypto.createHash('sha256').update(raw).digest('hex');
      if (prev.digest !== digest) {
        sendJson(res, 409, { error: { message: 'idempotency key reused with a different body', type: 'invalid_request_error' } });
        return true;
      }
      if (body.stream) {
        writeSse(res, prev.response);
        return true;
      }
      sendJson(res, 200, prev.response);
      return true;
    }

    const prompt = inputText(body.input);
    const harnessId = harnessIdFromBody(body);
    if (!prompt || !harnessId) {
      sendJson(res, 400, { error: { message: 'input and metadata.harness_id are required', type: 'invalid_request_error' } });
      return true;
    }

    let continueSession = false;
    let cliSessionId = '';
    if (body.previous_response_id) {
      try {
        const prev = await executor.getTaskStatus(body.previous_response_id);
        cliSessionId = prev?.result?.cliSessionId || '';
        continueSession = true;
      } catch { /* 找不到上一轮就当新任务 */ }
    }

    const { taskId } = await executor.execute(harnessId, prompt, {
      continueSession,
      cliSessionId: cliSessionId || undefined,
      workingDir: typeof body.metadata?.working_dir === 'string' ? body.metadata.working_dir : undefined,
    });

    if (body.stream && !res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: response.created\ndata: ${JSON.stringify({ id: taskId, status: 'in_progress', metadata: { harness_id: harnessId } })}\n\n`);
    }

    const task = await waitTask(executor, taskId);
    const response = taskToResponse(task);
    rememberIdempotency(idem, raw, response);
    if (body.stream) {
      if (!res.writableEnded) {
        res.write(`event: response.completed\ndata: ${JSON.stringify(response)}\n\n`);
        res.end();
      }
      return true;
    }
    sendJson(res, 200, response);
    return true;
  } catch (e) {
    const message = e.message || 'agent_error';
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: { message } })}\n\n`);
        res.end();
      }
      return true;
    }
    const status = message === 'Task not found' ? 404 : 400;
    sendJson(res, status, { error: { message, type: 'invalid_request_error' } });
    return true;
  }
}

function writeSse(res, response) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(`event: response.completed\ndata: ${JSON.stringify(response)}\n\n`);
  res.end();
}

module.exports = {
  parseAgentRoute,
  inputText,
  harnessIdFromBody,
  taskToResponse,
  handle,
};
