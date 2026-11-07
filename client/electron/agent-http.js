// 智能体任务 HTTP。和模型补全分开挂在 /v1/agent，仍由本机网关进程处理。
'use strict';

const crypto = require('crypto');

// 内部gateway请求token（由agent-worker设置，用于验证loopback请求）
let _internalGatewayToken = null;

function setInternalGatewayToken(token) {
  _internalGatewayToken = token;
}

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

/**
 * 提取发起方标识（类似模型网关的 app_id）。
 * 用于统计和日志，区分不同来源的调用（网页聊天、API、直接调用等）。
 */
function initiatorFromBody(body) {
  const meta = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  // 支持 app_id 或 source，优先 app_id（与模型网关对齐）
  const initiator = String(meta.app_id || meta.source || '').trim();
  return initiator || 'direct'; // 默认 'direct' 表示直接调用
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
  
  // 携带产物（图片、文件等），供服务端改写本地路径为可访问URL
  if (task?.result?.artifacts) {
    response.artifacts = task.result.artifacts;
  }
  
  // 会话绑定：供云端记录并用于下次续会话
  if (task?.result?.cliSessionId) {
    response.metadata.cli_session_id = task.result.cliSessionId;
  }
  if (task?.result?.workspaceSessionId) {
    response.metadata.workspace_session_id = task.result.workspaceSessionId;
  }
  
  // hired模式：传递session root供服务端路径脱敏
  try {
    const context = task?.context ? JSON.parse(task.context) : null;
    const callContext = context?.callContext;
    if (callContext === 'hired' && context?.workingDir) {
      response.metadata.session_root = context.workingDir;
    }
  } catch (e) {
    // context解析失败不影响主流程
  }
  
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
  // 鉴权：若提供了 knownKey 函数（WebSocket已认证），优先用它；否则检查密钥
  if (typeof knownKey === 'function') {
    if (!knownKey(key)) {
      sendJson(res, 401, { error: { message: 'invalid api key', type: 'auth_error' } });
      return true;
    }
  } else if (!key) {
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
    const initiator = initiatorFromBody(body);
    
    if (!prompt || !harnessId) {
      sendJson(res, 400, { error: { message: 'input and metadata.harness_id are required', type: 'invalid_request_error' } });
      return true;
    }
    
    // 附件：图片和文件（data URL格式）
    const attachImages = Array.isArray(body.images) ? body.images : [];
    const attachFiles = Array.isArray(body.files) ? body.files : [];
    
    // 记录发起方到日志（类似模型网关的应用归因）
    console.log(`[agent-http] POST /v1/agent/responses harness=${harnessId} initiator=${initiator}`);

    // 调用上下文：hired=雇佣调用（收集产物），local=本机调用（不收集）
    // 安全验证：metadata.call_context也可被HTTP用户伪造，必须验证请求来源
    
    // 1. 验证内部gateway请求token（只有WS gateway_request通过loopback才有此token）
    const internalToken = req.headers['x-internal-gateway-token'];
    const isInternalRequest = internalToken && internalToken === _internalGatewayToken;
    
    // 2. 根据请求来源决定call_context
    let callContext;
    const requestedContext = String(body.metadata?.call_context || 'local').trim().toLowerCase();
    
    if (isInternalRequest) {
      // 内部可信请求：使用metadata.call_context（由服务端dispatch_agent.py设置）
      callContext = requestedContext;
      console.log(`[agent-http] Internal request, trusted call_context=${callContext}`);
    } else {
      // 外部HTTP请求：不可信
      if (requestedContext === 'hired') {
        // 外部请求试图使用hired模式：拒绝（hired必须通过服务端dispatch）
        console.warn('[agent-http] Rejected external HTTP request attempting hired mode');
        sendJson(res, 403, { 
          error: { 
            message: 'hired mode requires trusted server dispatch, not direct HTTP', 
            type: 'permission_error' 
          } 
        });
        return;
      }
      // 外部请求local模式或未指定：允许，强制为local
      callContext = 'local';
      if (requestedContext !== 'local') {
        console.log(`[agent-http] External request, forced call_context=local (requested=${requestedContext})`);
      }
    }
    
    // 3. 拒绝用户尝试通过顶层call_context绕过（额外防御层）
    if (body.call_context && body.call_context !== body.metadata?.call_context) {
      console.warn('[agent-http] Rejected call_context override attempt in body');
      sendJson(res, 403, { 
        error: { 
          message: 'call_context must be set by trusted dispatcher', 
          type: 'permission_error' 
        } 
      });
      return;
    }
    
    // hired调用必须提供assistant_id和consumer_key
    const currentAssistantId = body.metadata?.assistant_id;
    const currentConsumerKey = body.metadata?.consumer_key;
    if (callContext === 'hired' && (!currentAssistantId || !currentConsumerKey)) {
      sendJson(res, 400, { 
        error: { 
          message: 'hired context requires metadata.assistant_id and metadata.consumer_key', 
          type: 'invalid_request_error' 
        } 
      });
      return true;
    }

    let continueSession = false;
    let cliSessionId = '';
    let workspaceSessionId = '';
    if (body.previous_response_id) {
      try {
        const prev = await executor.getTaskStatus(body.previous_response_id);
        
        // 完整授权检查：续会话必须匹配assistant、consumer、call_context
        // getTaskStatus已经解析过context，不需要再JSON.parse
        const prevContext = prev?.context || {};
        const prevAssistantId = prevContext?.assistantId || prev?.agent_id;
        const prevConsumerKey = prevContext?.consumerKey;
        const prevCallContext = prevContext?.callContext;
        
        // 验证1: assistant_id必须匹配（公共智能体标识，但必须是同一个）
        if (prevAssistantId && currentAssistantId && prevAssistantId !== currentAssistantId) {
          console.warn(`[agent-http] 拒绝续用其他assistant的会话: prev=${prevAssistantId}, current=${currentAssistantId}, prev_response=${body.previous_response_id}`);
          sendJson(res, 403, { 
            error: { 
              message: 'Cannot resume session from different assistant', 
              type: 'permission_error' 
            } 
          });
          return true;
        }
        // 验证2: consumer_key必须匹配（用户身份，不能跨用户）
        else if (prevConsumerKey && currentConsumerKey && prevConsumerKey !== currentConsumerKey) {
          console.warn(`[agent-http] 拒绝续用其他consumer的会话: prev=${prevConsumerKey}, current=${currentConsumerKey}, prev_response=${body.previous_response_id}`);
          sendJson(res, 403, { 
            error: { 
              message: 'Cannot resume session from different consumer', 
              type: 'permission_error' 
            } 
          });
          return true;
        }
        // 验证3: call_context必须匹配（hired不能用local会话，反之亦然）
        else if (prevCallContext && prevCallContext !== callContext) {
          console.warn(`[agent-http] 拒绝跨context续用会话: prev=${prevCallContext}, current=${callContext}, prev_response=${body.previous_response_id}`);
          sendJson(res, 403, { 
            error: { 
              message: `Cannot resume ${prevCallContext} session in ${callContext} context`, 
              type: 'permission_error' 
            } 
          });
          return true;
        }
        // 验证4: 旧数据缺失授权信息时拒绝（防止利用旧任务绕过）
        else if (!prevAssistantId || !prevConsumerKey || !prevCallContext) {
          console.warn(`[agent-http] 旧任务缺失授权信息，拒绝续用: assistantId=${!!prevAssistantId}, consumerKey=${!!prevConsumerKey}, callContext=${!!prevCallContext}, prev_response=${body.previous_response_id}`);
          sendJson(res, 403, { 
            error: { 
              message: 'Previous session missing authorization context', 
              type: 'permission_error' 
            } 
          });
          return true;
        }
        // 全部验证通过：允许续用
        else {
          cliSessionId = prev?.result?.cliSessionId || '';
          workspaceSessionId = prev?.result?.workspaceSessionId || '';
          continueSession = true;
        }
      } catch (e) {
        console.warn(`[agent-http] previous_response_id查询失败: ${e.message}`);
        // previous_response_id不存在或查询失败，返回400而不是静默作为新会话
        sendJson(res, 400, { 
          error: { 
            message: `Previous response not found: ${e.message}`, 
            type: 'invalid_request_error' 
          } 
        });
        return true;
      }
    }
    const collectArtifacts = callContext === 'hired';
    
    // 工作目录策略：
    // 1. hired: 强制contribute workspace（显式working_dir须在其内，防逃逸）
    //    - 基础隔离：assistant + consumer
    //    - 会话隔离：续会话时复用同一目录（通过workspaceSessionId）
    //    - 新会话：创建新的会话子目录（安全增强）
    // 2. local: 显式working_dir优先，否则executor默认（agent配置或process.cwd()）
    let workingDir = undefined;
    const explicitDir = typeof body.metadata?.working_dir === 'string' ? body.metadata.working_dir : undefined;
    if (callContext === 'hired') {
      // hired强制contribute workspace，防止逃逸到出租者项目目录
      const assistantId = body.metadata?.assistant_id;
      const consumerKey = body.metadata?.consumer_key;
      if (assistantId && consumerKey) {
        try {
          const { ensureContributeWorkspace } = require('./contribute-session');
          const baseDir = ensureContributeWorkspace(assistantId, consumerKey);
          const path = require('path');
          const crypto = require('crypto');
          const fs = require('fs');
          
          // 会话级子目录：防止同消费者跨会话文件泄漏
          // - 续会话：复用workspaceSessionId确保目录一致
          // - 新会话：生成stable sessionId（返回给云端，供下次续用）
          if (workspaceSessionId && continueSession) {
            // 续会话：使用已有会话目录
            const sessionDir = path.join(baseDir, 'sessions', workspaceSessionId);
            fs.mkdirSync(sessionDir, { recursive: true });
            workingDir = sessionDir;
          } else {
            // 新会话：生成stable session ID（6字节随机，12字符hex）
            workspaceSessionId = crypto.randomBytes(6).toString('hex');
            const sessionDir = path.join(baseDir, 'sessions', workspaceSessionId);
            fs.mkdirSync(sessionDir, { recursive: true });
            workingDir = sessionDir;
          }
          
          // 验证explicitDir（如果提供）必须在当前sessionDir内（防止访问其他会话）
          if (explicitDir) {
            let explicitReal;
            try {
              explicitReal = fs.realpathSync(explicitDir);
            } catch {
              console.warn(`[agent-http] hired explicitDir不存在: ${explicitDir}`);
            }
            if (explicitReal) {
              // 必须在当前会话目录内，不能访问其他会话
              const rel = path.relative(workingDir, explicitReal);
              const contained = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
              if (contained) {
                // 显式目录在当前会话目录内，允许（如子目录）
                workingDir = explicitReal;
              } else {
                console.warn(`[agent-http] hired拒绝会话外目录: ${explicitDir} (session: ${workingDir})`);
                // 保持默认sessionDir，拒绝访问其他会话
              }
            }
          }
        } catch (e) {
          console.warn('[agent-http] ensureContributeWorkspace failed:', e.message);
        }
      }
    } else {
      // local: 优先explicitDir，否则undefined（executor默认）
      workingDir = explicitDir;
    }
    
    const { taskId } = await executor.execute(harnessId, prompt, {
      continueSession,
      cliSessionId: cliSessionId || undefined,
      workingDir,
      // 会话级目录标识（供续会话复用）
      workspaceSessionId: workspaceSessionId || undefined,
      // 记录完整授权上下文（供续会话权限验证）
      assistantId: body.metadata?.assistant_id || undefined,
      consumerKey: body.metadata?.consumer_key || undefined,
      callContext: callContext,
      // 只有请求显式打开 stream 才边收边推
      stream: !!body.stream,
      // 发起方标识（用于统计和日志）
      initiator,
      // 雇佣调用才收集产物
      collectArtifacts,
      // 附件：图片和文件（输入附件local也支持，仅输出产物区分）
      images: attachImages.length ? attachImages : undefined,
      files: attachFiles.length ? attachFiles : undefined,
    });

    let detachStream = () => {};
    if (body.stream && !res.headersSent) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      writeEvent(res, 'response.created', { id: taskId, status: 'in_progress', metadata: { harness_id: harnessId } });
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
    rememberIdempotency(idem, raw, response);
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
      writeEvent(res, 'response.tool', {
        tool: step.tool_name,
        tool_use_id: step.tool_use_id || null,
        detail: step.content || '',
        status: 'running'
      });
      return;
    }
    if (step.stepType === 'tool_result' && step.tool_name) {
      writeEvent(res, 'response.tool', {
        tool: step.tool_name,
        tool_use_id: step.tool_use_id || null,
        result: step.content || '',
        status: step.is_error ? 'error' : 'completed'
      });
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
  handle,
  setInternalGatewayToken,
};
