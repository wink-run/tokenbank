// 智能体任务 HTTP。和模型补全分开挂在 /v1/agent，仍由本机网关进程处理。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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
  // 列任务：?parent_id=<父任务> 列它的子任务
  if (method === 'GET' && cleanPath === '/v1/agent/responses') return { op: 'list_responses' };
  const m = String(cleanPath || '').match(/^\/v1\/agent\/responses\/([^/]+)(?:\/(cancel))?$/);
  if (!m) return null;
  let id = m[1];
  try { id = decodeURIComponent(id); } catch { /* 保持原样 */ }
  if (method === 'GET' && !m[2]) return { op: 'get', id };
  if (method === 'POST' && m[2] === 'cancel') return { op: 'cancel', id };
  return null;
}

/** metadata.parent_id：这个任务是哪个任务派出来的（任务树） */
function parentIdFromBody(body) {
  const v = body?.metadata?.parent_id;
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null;
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
  const ctx = task?.context && typeof task.context === 'object' ? task.context : {};
  const metadata = { harness_id: task.agent_id || null };
  if (ctx.parentTaskId) metadata.parent_id = ctx.parentTaskId;
  const device = task?.result?.device || ctx.meshDevice;
  if (device) metadata.mesh_device = device;
  const response = {
    id: task.id,
    object: 'response',
    status: statusMap[task.status] || task.status || 'in_progress',
    metadata,
    output: text
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: String(text).slice(0, 20000) }] }]
      : [],
  };
  if (created && done && done >= created) response.usage = { duration_ms: done - created };
  // 进展：本机任务数步骤；跑在别的设备上的用那台设备报的
  if (Array.isArray(task?.steps)) response.step_count = task.steps.length;
  if (Number.isFinite(task?.result?.remoteSteps)) response.step_count = task.result.remoteSteps;
  return response;
}

/** 任务树里的一个节点：只要能看懂进度的几项，不带完整步骤 */
function taskNode(task) {
  const r = taskToResponse(task);
  delete r.step_count;
  return r;
}

/** children：直接的子任务；tree=true 时一直往下展开（最多 6 层、500 个） */
function attachChildren(executor, response, { tree = false } = {}) {
  let budget = 500;
  const walk = (node, depth) => {
    const kids = executor.listChildTasks(node.id).slice(0, Math.max(0, budget));
    budget -= kids.length;
    node.children = kids.map(taskNode);
    if (tree && depth < 6) for (const k of node.children) walk(k, depth + 1);
  };
  walk(response, 1);
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
  // 通用（本机装好的应用）、专业（投射的智能体，管家除外）、外部（自己注册进来的），再加智能体路由
  const out = [];
  for (const agent of agents) {
    if (!agent || agent.guardian) continue;
    if (agent.type === 'cli' && agent.installed) out.push({ id: agent.id, name: agent.name || agent.id, kind: 'app' });
    else if (agent.type === 'assistant') out.push({ id: agent.id, name: agent.name || agent.id, kind: 'assistant' });   // 对外不暴露它跑在哪个应用上
    else if (agent.type === 'external') out.push({ id: agent.id, name: agent.name || agent.id, kind: 'external', online: !!agent.online });
  }
  try {
    for (const r of require('./agent-routes').list()) out.push({ id: r.id, name: r.name, kind: 'route' });
  } catch { /* 路由读不到时只列智能体 */ }
  return out;
}

/** harness_id 是智能体路由时：交给这条路由的主智能体，以编排模式照规则派发 */
async function resolveHarness(executor, harnessId, preferredMain = '') {
  const routes = require('./agent-routes');
  if (!routes.isRouteId(harnessId)) return { agentId: harnessId, options: {} };
  const route = routes.get(harnessId);
  if (!route) throw Object.assign(new Error(`没有这条智能体路由：${harnessId}`), { status: 404 });
  await executor.listAvailableAgents();
  const launchable = executor._launchableCliIds || new Set();
  // 路由没指定谁来派时，用调用方带来的（游乐场传它设的主智能体），再没有就挑第一个装好的
  const main = routes.resolveMainAgent(route, launchable, preferredMain);
  if (!main) throw Object.assign(new Error('没有能派发的主智能体：先装好 Claude Code、Codex、Cursor 或 Pi 中的一个'), { status: 409 });
  return { agentId: main, options: { mode: 'orchestrator', mainAgentId: main, agentRouteId: route.id } };
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
  // 点名执行（/codex@设备）与执行设备
  if (info.designated) {
    entry.designated = String(info.designated);
    if (info.routeId) entry.route_id = String(info.routeId);
  }
  if (info.device) entry.device = String(info.device);
  // 子任务：哪个任务派出来的（任务树）
  if (info.parentId) entry.parent_id = String(info.parentId);
  if (!ok) entry.error = String(info.error || 'agent_error');
  return entry;
}

/**
 * 外部智能体的接口（不用网关 Key，用配对码 / 它自己的 token）：
 *   POST /v1/agent/external/register        { pairing_code, name, description } → { agent_id, token, status }
 *   GET  /v1/agent/external/tasks?wait=25   取派给它的任务 → { task: { id, input } | null }
 *   POST /v1/agent/external/tasks/:id/result { output, error }
 *   GET  /v1/agent/external/skill           tokenbank-connect 技能说明（Markdown）
 */
async function handleExternal(req, res, method, cleanPath) {
  if (!String(cleanPath || '').startsWith('/v1/agent/external/')) return false;
  const ext = require('./external-agents');
  try {
    if (method === 'GET' && cleanPath === '/v1/agent/external/skill') {
      req.resume();
      const { text, version } = ext.skillInfo();
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'X-TokenBank-Skill-Version': version });
      res.end(text);
      return true;
    }
    // 每个回给外部智能体的回答都带上当前技能版本，它发现和自己那份不同就重新下载
    const skillMeta = () => {
      try { return { skill_version: ext.skillInfo().version, skill_url: `http://${req.headers.host || '127.0.0.1:11430'}/v1/agent/external/skill` }; }
      catch { return {}; }
    };
    if (method === 'POST' && cleanPath === '/v1/agent/external/register') {
      const { body } = await readBody(req);
      const out = ext.register({ code: body.pairing_code || body.code, name: body.name, description: body.description });
      sendJson(res, 200, { ...out, ...skillMeta() });
      return true;
    }
    const qs = new URL(req.url || '/', 'http://x').searchParams;
    const isPull = method === 'GET' && cleanPath === '/v1/agent/external/tasks';
    const agent = ext.authenticate(callerKey(req), Date.now(), { heartbeat: isPull, intervalSec: Number(qs.get('interval')) || 0, skillVersion: qs.get('skill_version') || '' });
    if (!agent) {
      req.resume();
      if (ext.wasRemoved(callerKey(req))) {
        sendJson(res, 410, { error: { message: '用户已在 Token Bank 里移除了你：删掉保存的 token，停掉你这边和 Token Bank 有关的定时任务', type: 'removed' }, status: 'removed', ...skillMeta() });
      } else {
        sendJson(res, 401, { error: { message: 'invalid external agent token', type: 'auth_error' } });
      }
      return true;
    }
    if (agent.status !== 'active') {
      req.resume();
      sendJson(res, 403, { error: { message: agent.status === 'pending' ? '还在等用户允许' : '用户已停用你：暂停推送，降低取任务的频率，等用户重新启用', type: agent.status === 'pending' ? 'pending' : 'disabled' }, status: agent.status, ...skillMeta() });
      return true;
    }
    if (isPull) {
      req.resume();
      const wait = Number(qs.get('wait') ?? 25) * 1000;
      const task = await ext.pull(agent.id, wait);
      // 等的过程中被停用或移除：立刻告诉它
      if (task && task.status === 'disabled') {
        sendJson(res, 403, { error: { message: '用户已停用你：暂停推送，降低取任务的频率，等用户重新启用', type: 'disabled' }, status: 'disabled', ...skillMeta() });
      } else if (task && task.status === 'removed') {
        sendJson(res, 410, { error: { message: '用户已在 Token Bank 里移除了你：删掉保存的 token，停掉你这边和 Token Bank 有关的定时任务', type: 'removed' }, status: 'removed', ...skillMeta() });
      } else {
        sendJson(res, 200, { task: task ? { id: task.id, input: task.prompt } : null, status: 'active', interval: ext.pullIntervalSec(), ...skillMeta() });
      }
      return true;
    }
    const m = String(cleanPath).match(/^\/v1\/agent\/external\/tasks\/([^/]+)\/result$/);
    if (method === 'POST' && m) {
      const { body } = await readBody(req);
      const ok = ext.complete(agent.id, decodeURIComponent(m[1]), { output: body.output, error: body.error });
      sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: { message: 'no such task waiting', type: 'not_found' } });
      return true;
    }
    // 主动推送：就之前接过的任务再发一条（它自己的定时任务、后续进展）
    const mp = String(cleanPath).match(/^\/v1\/agent\/external\/tasks\/([^/]+)\/messages$/);
    if (method === 'POST' && mp) {
      const { body } = await readBody(req);
      const r = ext.pushDetailed(agent.id, decodeURIComponent(mp[1]), { output: body.output || body.text || body.content });
      sendJson(res, r.ok ? 200 : (r.reason === 'empty' ? 400 : r.reason === 'not_ready' ? 503 : 404),
        r.ok ? { ok: true, status: 'active' } : { ok: false, error: { message: r.message, type: r.reason }, status: 'active' });
      return true;
    }
    req.resume();
    sendJson(res, 404, { error: { message: 'not_found', type: 'invalid_request_error' } });
    return true;
  } catch (e) {
    sendJson(res, e.status || 500, { error: { message: e.message, type: e.status === 401 ? 'auth_error' : 'invalid_request_error' } });
    return true;
  }
}

async function handle(req, res, { method, cleanPath, knownKey, onCall }) {
  const started = Date.now();
  if (await handleExternal(req, res, method, cleanPath)) return true;
  const route = parseAgentRoute(method, cleanPath);
  if (!route && String(cleanPath || '').startsWith('/v1/agent')) {
    sendJson(res, 404, { error: { message: 'not_found', type: 'invalid_request_error' } });
    return true;
  }
  if (!route) return false;

  const key = callerKey(req);
  // 提前声明：401 也会记明细，那时还没读到 body。
  let callContext = '';
  // 路由明细的附加信息：点名（/codex@设备）、哪条路由、实际在哪台设备执行
  let logExtra = {};
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
        ...logExtra,
      });
    } catch { /* 明细写入失败不影响任务响应 */ }
  };
  // 智能体自己的 Key：只能调这一个智能体
  const boundAgent = require('./agent-keys').agentForKey(key);
  if (!key || (!boundAgent && typeof knownKey === 'function' && !knownKey(key))) {
    report({ ok: false, error: 'invalid api key' });
    sendJson(res, 401, { error: { message: 'invalid api key', type: 'auth_error' } });
    return true;
  }

  const executor = require('./agent-executor');
  const meshGlue = require('./mesh/glue');
  if (route.op !== 'create') req.resume();
  // 提前声明：任务中途抛错时，catch 仍能把已解析的提示词和智能体记进明细。
  let prompt = '';
  let harnessId = '';
  try {
    if (route.op === 'list') {
      const all = await listHarnesses();
      // 设备网络：我的其他设备上的应用和智能体（经隧道来的请求不再列）
      if (!meshGlue.isHop(req.headers)) all.push(...meshGlue.extraHarnesses());
      sendJson(res, 200, { object: 'list', data: boundAgent ? all.filter(h => h.id === boundAgent) : all });
      return true;
    }
    const query = new URL(req.url || '/', 'http://x').searchParams;
    const tree = ['1', 'true'].includes(String(query.get('tree') || ''));
    // mesh:<设备>:<任务号>：结果在那台设备上，转过去查；它派出的子任务记在本机，接在后面
    if (route.op === 'get' && meshGlue.parseMeshTaskId(route.id)) {
      const out = await meshGlue.fetchAgentTask(route.id, 'get');
      const code = out.status === 'unreachable' ? (out.httpStatus || 503) : (out.httpStatus || 200);
      delete out.httpStatus;
      if (code < 400) attachChildren(executor, out, { tree });
      sendJson(res, code, out);
      return true;
    }
    if (route.op === 'cancel' && meshGlue.parseMeshTaskId(route.id)) {
      // 走执行器：转给那台设备取消，本机镜像同时收尾
      const r = await executor.cancel(route.id);
      const out = r.unreachable
        ? { id: route.id, object: 'response', status: 'unreachable', error: { message: r.error, type: 'mesh_unreachable' } }
        : await meshGlue.fetchAgentTask(route.id, 'get');
      delete out.httpStatus;
      sendJson(res, out.status === 'unreachable' ? 503 : 200, out);
      return true;
    }
    if (route.op === 'get') {
      const task = await executor.getTaskStatus(route.id);
      const out = attachChildren(executor, taskToResponse(task), { tree });
      // ?steps_after=N：带上第 N 步之后的执行步骤（另一台设备的镜像靠它把过程同步过去）
      const after = query.get('steps_after');
      if (after !== null && Array.isArray(task.steps)) {
        out.steps = task.steps.slice(Math.max(0, Number(after) || 0), (Number(after) || 0) + 50).map((st) => ({
          step_number: st.step_number, step_type: st.step_type, content: String(st.content || '').slice(0, 8000),
          tool_name: st.tool_name || null, tool_use_id: st.tool_use_id || null, is_error: !!st.is_error,
        }));
      }
      sendJson(res, 200, out);
      return true;
    }
    if (route.op === 'list_responses') {
      const parentId = String(query.get('parent_id') || '').trim();
      if (!parentId) {
        sendJson(res, 400, { error: { message: 'parent_id is required', type: 'invalid_request_error' } });
        return true;
      }
      const limit = Math.min(Math.max(Number(query.get('limit')) || 200, 1), 500);
      const data = executor.listChildTasks(parentId, limit).map(taskNode);
      sendJson(res, 200, { object: 'list', parent_id: parentId, data });
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
    if (parentIdFromBody(body)) logExtra = { ...logExtra, parentId: parentIdFromBody(body) };
    callContext = callContextFromBody(body);
    // 经设备网络转来的都是本人的任务：完整权限，不审查、不脱敏、不计积分
    const fromMesh = meshGlue.isMeshRequest(req.headers);
    if (fromMesh) callContext = 'owner';
    // 其他设备派来的：本机已经满了就直说，让对方换一台（续上一轮的不算新活）
    const replay = idempotency.has(String(req.headers['idempotency-key'] || '').trim());
    if (fromMesh && !body.previous_response_id && !replay) {
      const load = meshGlue.selfLoad();
      if (load.running >= load.max) {
        report({ ok: false, error: 'busy', prompt, harnessId });
        sendJson(res, 429, { error: { message: `这台设备正在跑 ${load.running} 个任务，满了`, type: 'mesh_busy' } });
        return true;
      }
    }
    if (boundAgent) {
      if (!harnessId) harnessId = boundAgent;   // 用智能体自己的 Key 可以不写 harness_id
      if (harnessId !== boundAgent) {
        report({ ok: false, error: 'this key is for another agent', prompt, harnessId });
        sendJson(res, 403, { error: { message: `这个 Key 只能调用 ${boundAgent}`, type: 'forbidden' } });
        return true;
      }
    }
    // 智能体路由里点名执行者：「/codex 修一下」「/codex@bf54 …」。点名了就跳过主智能体的挑选
    let designation = null;
    if (!boundAgent && require('./agent-routes').isRouteId(harnessId)) {
      const node = meshGlue.getNode();
      designation = require('./agent-designation').resolveDesignation(prompt, {
        agents: await executor.listAvailableAgents(),
        devices: node ? node.directory.list() : [],
      });
      if (designation) {
        logExtra = { ...logExtra, designated: designation.raw, routeId: harnessId, device: designation.device || undefined };
        harnessId = designation.harnessId;
        prompt = designation.text;
        body.input = prompt;
      }
    }
    const designationMeta = designation ? { designated: designation.raw, route_id: logExtra.routeId } : null;
    // mine:<目标>[@设备]：在本人的设备里选一台。选到别的设备就整个请求转过去，选到本机就照常往下走
    if (String(harnessId).startsWith('mine:')) {
      const r = await meshGlue.routeAgentCreate({ harnessId, body, req, res, extraMeta: designationMeta });
      if (r.handled) {
        if (r.device) logExtra = { ...logExtra, device: r.device };
        // 本机记一行镜像：任务树里看得到它，GET 本机也能查
        if (r.ok && r.taskId) {
          try {
            executor.trackMeshTask(r.taskId, {
              agentId: `mine:${r.target}@${r.device}`,
              device: r.device,
              prompt,
              parentTaskId: parentIdFromBody(body),
              mode: 'direct',
              response: r.response,
            });
          } catch { /* 镜像失败不影响任务 */ }
        }
        report({ ok: !!r.ok, error: r.error, prompt, harnessId });
        return true;
      }
      harnessId = r.local;
    }
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
        // 异步重放只看当前状态，不在这里把连接挂到跑完
        if (body.background) {
          const task = await executor.getTaskStatus(prev.taskId);
          const response = taskToResponse(task);
          if (callContext) response.metadata.call_context = callContext;
          reportTask(task);
          sendJson(res, 200, response);
          return true;
        }
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

    let resolved;
    try {
      resolved = await resolveHarness(executor, harnessId, String(body.metadata?.main_agent_id || '').trim());
    } catch (e) {
      report({ ok: false, error: e.message, prompt, harnessId });
      sendJson(res, e.status || 400, { error: { message: e.message, type: 'invalid_request_error' } });
      return true;
    }
    // 工作区：metadata.workspace 是名字，路径只在本机。设备网络转来的任务没给名字时用默认工作区
    let workingDir = typeof body.metadata?.working_dir === 'string' ? body.metadata.working_dir : undefined;
    const workspaceName = typeof body.metadata?.workspace === 'string' ? body.metadata.workspace.trim() : '';
    if (workspaceName || fromMesh) {
      try {
        const p = meshGlue.resolveWorkspace(workspaceName);
        if (p) workingDir = p;
      } catch (e) {
        report({ ok: false, error: e.message, prompt, harnessId });
        sendJson(res, e.status || 400, { error: { message: e.message, type: 'invalid_request_error' } });
        return true;
      }
    }
    const { taskId } = await executor.execute(resolved.agentId, prompt, {
      ...resolved.options,
      continueSession,
      cliSessionId: cliSessionId || undefined,
      workingDir,
      // 只有请求显式打开 stream 才边收边推。background 马上返回，不占着连接。
      stream: !!body.stream && !body.background,
      callContext: callContext || undefined,
      parentTaskId: parentIdFromBody(body) || undefined,
      previousTaskId: body.previous_response_id || undefined,
    });
    // 等结果之前就记住键，连接断开后同样的请求接上这一单
    rememberIdempotency(idem, raw, null, taskId);

    const finishResponse = async (task) => {
      const response = taskToResponse(task);
      if (callContext) response.metadata.call_context = callContext;
      if (resolved.options.agentRouteId) {
        response.metadata.harness_id = harnessId;
        response.metadata.dispatched_by = resolved.agentId;
      }
      if (designationMeta) Object.assign(response.metadata, designationMeta);
      return response;
    };

    // 异步：立刻交出任务 id，调用方用 GET /v1/agent/responses/{id} 查结果
    if (body.background) {
      let task;
      try { task = await executor.getTaskStatus(taskId); }
      catch { task = { id: taskId, status: 'pending', agent_id: harnessId }; }
      const response = await finishResponse(task);
      reportTask(task);
      sendJson(res, 200, response);
      return true;
    }

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
    // 走路由时原样带回路由名，另写明是哪个主智能体派的
    if (resolved.options.agentRouteId) {
      response.metadata.harness_id = harnessId;
      response.metadata.dispatched_by = resolved.agentId;
    }
    if (designationMeta) Object.assign(response.metadata, designationMeta);
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
    const status = e.status || (message === 'Task not found' ? 404 : 400);
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
  resolveHarness,
  listHarnesses,
  parseAgentRoute,
  inputText,
  harnessIdFromBody,
  taskToResponse,
  outputStreamEvent,
  buildAgentRouteLog,
  normalizeCallContext,
  handle,
};
