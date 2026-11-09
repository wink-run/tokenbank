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

/** metadata.call_context：local / owner 本机，hired 雇佣到对方设备。非法值忽略。 */
function normalizeCallContext(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'local' || text === 'owner' || text === 'hired') return text;
  return '';
}

function callContextFromBody(body) {
  const meta = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  return normalizeCallContext(body?.call_context || meta.call_context);
}

/** WebSocket 派发是远程；直接打 /v1/agent 是本地。 */
function placeForAgentCall(channel) {
  return channel === 'ws' ? 'remote' : 'local';
}

/**
 * 把一步输出收成 SSE 事件。快照只发新增片段；整段被替换时发 snapshot。
 * @returns {{ prev: string, event: string|null, data: object|null }}
 */
function outputStreamEvent(prev, step) {
  const prior = String(prev || '');
  if (!step || step.stepType !== 'output') return { prev: prior, event: null, data: null };
  const text = String(step.content || '');
  if (step.is_delta) {
    if (!text) return { prev: prior, event: null, data: null };
    return { prev: prior + text, event: 'response.output_text.delta', data: { delta: text } };
  }
  if (!text || text === prior) return { prev: prior, event: null, data: null };
  if (text.startsWith(prior)) {
    const delta = text.slice(prior.length);
    if (!delta) return { prev: text, event: null, data: null };
    return { prev: text, event: 'response.output_text.delta', data: { delta } };
  }
  return { prev: text, event: 'response.output_text.snapshot', data: { text } };
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

function rememberIdempotency(key, raw, response, taskId) {
  if (!key) return;
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  const prev = idempotency.get(key);
  idempotency.set(key, {
    digest,
    response: response || prev?.response || null,
    taskId: taskId || prev?.taskId || '',
  });
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

/** 路由明细用的一条智能体调用。列表和状态轮询不记。 */
function buildAgentRouteLog(info = {}) {
  const text = String(info.prompt || '').replace(/\s+/g, ' ').trim();
  const harness = String(info.harnessId || '').trim() || 'agent';
  const latency = Math.max(0, Number(info.latencyMs) || 0);
  const ok = !!info.ok;
  const entry = {
    kind: 'agent',
    ts: Number(info.ts) || Date.now(),
    requested_model: harness,
    model: harness,
    via: 'agent',
    prompt_preview: text.slice(0, 20),
    latency_ms: latency,
    status: ok ? 'ok' : 'error',
  };
  const callContext = normalizeCallContext(info.callContext);
  entry.place = placeForAgentCall(info.channel);
  if (callContext) entry.call_context = callContext;
  if (!ok) entry.error = String(info.error || 'agent_error');
  return entry;
}

async function handle(req, res, { method, cleanPath, knownKey, onCall }) {
  const started = Date.now();
  const route = parseAgentRoute(method, cleanPath);
  if (!route && String(cleanPath || '').startsWith('/v1/agent')) {
    sendJson(res, 404, { error: { message: 'not_found', type: 'invalid_request_error' } });
    return true;
  }
  if (!route) return false;

  const key = callerKey(req);
  // 提前声明：401 也会记明细，那时还没读到 body。
  let callContext = '';
  // 只记发起任务。拉取列表、查询状态会一直打，不进路由明细。
  const report = (fields = {}) => {
    if (route.op !== 'create' || typeof onCall !== 'function') return;
    try {
      onCall({
        ts: started,
        latencyMs: Date.now() - started,
        callerKey: key,
        prompt: fields.prompt || '',
        harnessId: fields.harnessId || '',
        callContext,
        ok: !!fields.ok,
        error: fields.error,
      });
    } catch { /* 明细写入失败不影响任务响应 */ }
  };
  if (!key || (typeof knownKey === 'function' && !knownKey(key))) {
    report({ ok: false, error: 'invalid api key' });
    sendJson(res, 401, { error: { message: 'invalid api key', type: 'auth_error' } });
    return true;
  }

  const executor = require('./agent-executor');
  if (route.op !== 'create') req.resume();
  // 提前声明：任务中途抛错时，catch 仍能把已解析的提示词和智能体记进明细。
  let prompt = '';
  let harnessId = '';
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
    prompt = inputText(body.input);
    harnessId = harnessIdFromBody(body);
    callContext = callContextFromBody(body);
    const reportTask = (task, fallbackError) => {
      const failed = task?.status === 'failed' || task?.status === 'cancelled';
      report({
        ok: !failed,
        error: failed ? (task.error || task.status || fallbackError) : undefined,
        prompt,
        harnessId: harnessId || task?.agent_id || '',
      });
    };
    const idem = String(req.headers['idempotency-key'] || '').trim();
    if (idem && idempotency.has(idem)) {
      const prev = idempotency.get(idem);
      const digest = crypto.createHash('sha256').update(raw).digest('hex');
      if (prev.digest !== digest) {
        report({ ok: false, error: 'idempotency key reused with a different body', prompt, harnessId });
        sendJson(res, 409, { error: { message: 'idempotency key reused with a different body', type: 'invalid_request_error' } });
        return true;
      }
      if (!prev.response && prev.taskId) {
        const task = await waitTask(executor, prev.taskId);
        const response = taskToResponse(task);
        if (callContext) response.metadata.call_context = callContext;
        rememberIdempotency(idem, raw, response, prev.taskId);
        reportTask(task);
        if (body.stream) {
          writeSse(res, response);
          return true;
        }
        sendJson(res, 200, response);
        return true;
      }
      reportTask({ status: prev.response?.status, error: prev.response?.error, agent_id: harnessId });
      if (body.stream) {
        writeSse(res, prev.response);
        return true;
      }
      sendJson(res, 200, prev.response);
      return true;
    }

    if (!prompt || !harnessId) {
      report({ ok: false, error: 'input and metadata.harness_id are required', prompt, harnessId });
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
      // 只有请求显式打开 stream 才边收边推
      stream: !!body.stream,
      callContext: callContext || undefined,
    });
    // 等结果之前就记住键，连接断开后同样的请求接上这一单
    rememberIdempotency(idem, raw, null, taskId);

    let detachStream = () => {};
    if (body.stream && !res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      writeEvent(res, 'response.created', {
        id: taskId,
        status: 'in_progress',
        metadata: { harness_id: harnessId, ...(callContext ? { call_context: callContext } : {}) },
      });
      // 社区任务的正文是整段快照，这里拆成 delta，调用方可以边收边显示
      detachStream = pipeTaskStream(executor, taskId, res);
    }

    let task;
    try {
      task = await waitTask(executor, taskId);
    } finally {
      detachStream();
    }
    const response = taskToResponse(task);
    if (callContext) response.metadata.call_context = callContext;
    rememberIdempotency(idem, raw, response);
    reportTask(task);
    if (body.stream) {
      if (!res.writableEnded) {
        writeEvent(res, 'response.completed', response);
        res.end();
      }
      return true;
    }
    sendJson(res, 200, response);
    return true;
  } catch (e) {
    const message = e.message || 'agent_error';
    report({ ok: false, error: message, prompt, harnessId });
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

function writeEvent(res, event, data) {
  if (!res || res.writableEnded) return;
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* 调用方已断开 */ }
}

/** 把执行器的步骤转成 SSE。返回取消订阅。 */
function pipeTaskStream(executor, taskId, res) {
  let prev = '';
  const onStep = (step) => {
    if (!step || step.taskId !== taskId) return;
    if (step.stepType === 'tool_call' && step.tool_name) {
      writeEvent(res, 'response.tool', { tool: step.tool_name });
      return;
    }
    const next = outputStreamEvent(prev, step);
    prev = next.prev;
    if (next.event) writeEvent(res, next.event, next.data);
  };
  executor.on('task:step', onStep);
  return () => {
    try { executor.off('task:step', onStep); } catch { /* ignore */ }
  };
}

function writeSse(res, response) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  writeEvent(res, 'response.completed', response);
  res.end();
}

module.exports = {
  parseAgentRoute,
  inputText,
  harnessIdFromBody,
  taskToResponse,
  outputStreamEvent,
  buildAgentRouteLog,
  normalizeCallContext,
  handle,
};
