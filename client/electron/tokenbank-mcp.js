// client/electron/tokenbank-mcp.js
// 把 Token Bank 的能力以 MCP 暴露给外部智能体（比如 GrokBot）：网关同一个端口上的 POST /v1/mcp（Streamable HTTP，JSON 回答）。
//
// 登录：外部智能体注册时拿到的 token（Authorization: Bearer tbx_…），不用新的凭据。
// 权限：用户在网关页给每个外部智能体单独打开，默认关闭：
//   read    看：智能体、模型、设备、任务状态、提示词、资源
//   operate 再加：派任务给智能体、直接调模型
//   full    再加：雇佣社区智能体（花积分）、调用 Token Bank 里纳管的其他 MCP 工具
// 工具复用本机各应用用的那几个 MCP（派活、模型、资源），只是换成在网关进程里直接调。
'use strict';

const LEVEL_TOOLS = {
  read: [
    'tb_capabilities', 'tb_list_agents', 'tb_task_status', 'tb_list_community_agents',
    'tb_list_models', 'tb_resolve_model', 'tb_list_devices',
    'tb_list_resources', 'tb_get_resource', 'tb_list_prompts', 'tb_get_prompt', 'tb_list_catalog', 'tb_list_gateway',
  ],
  operate: ['tb_dispatch_agent', 'tb_chat'],
  full: ['tb_hire_community_agent', 'tb_call_mcp'],
};
const LEVEL_ORDER = ['off', 'read', 'operate', 'full'];
const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY = 1024 * 1024;

function allowedTools(level) {
  const n = LEVEL_ORDER.indexOf(level);
  const out = new Set();
  for (const [lv, names] of Object.entries(LEVEL_TOOLS)) {
    if (LEVEL_ORDER.indexOf(lv) <= n && n > 0) for (const x of names) out.add(x);
  }
  return out;
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], isError: !!isError };
}

// ── 网关自己的两个工具：设备、直接调模型 ──────────────────────────────────────
const LOCAL_TOOLS = [
  {
    name: 'tb_list_devices',
    description: '列出我名下的设备（设备网络）：在不在线、怎么连、上面有哪些应用、模型和工作区。派活时可以用 mine:<应用>@<设备> 指定设备。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_chat',
    description: '直接调用 Token Bank 网关里的一个模型回答问题（不经过智能体）。model 用 tb_list_models 列出的 id。',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: '模型 id，例如 deepseek-v4-flash' },
        prompt: { type: 'string', description: '要问的话' },
        system: { type: 'string', description: '可选：系统提示' },
        max_tokens: { type: 'number', description: '可选：最多输出多少 token' },
      },
      required: ['model', 'prompt'],
    },
  },
];

async function callLocal(name, args, ctx) {
  if (name === 'tb_list_devices') {
    let view;
    try { view = require('./mesh/glue').devicesView(); } catch { view = { enabled: false, devices: [] }; }
    if (!view.enabled) return textResult('设备网络没开：只有这一台设备。');
    const lines = view.devices.map((d) => {
      const conn = d.self ? '本机' : !d.online ? '离线' : d.connection === 'relay' ? `在线（经${d.via?.label || '中继'}）` : '在线';
      const apps = (d.apps || []).map((a) => a.id).join(', ') || '—';
      const models = (d.models || []).slice(0, 12).join(', ') || '—';
      const ws = (d.workspaces || []).map((w) => w.name).join(', ') || '—';
      return `- ${d.label}（${conn}）\n  应用：${apps}\n  模型：${models}\n  工作区：${ws}`;
    });
    return textResult(lines.join('\n'));
  }
  if (name === 'tb_chat') {
    const model = String(args.model || '').trim();
    const prompt = String(args.prompt || '').trim();
    if (!model || !prompt) return textResult('需要 model 和 prompt', true);
    const messages = [...(args.system ? [{ role: 'system', content: String(args.system) }] : []), { role: 'user', content: prompt }];
    try {
      const r = await fetch(`http://127.0.0.1:${ctx.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(ctx.agentKey ? { Authorization: `Bearer ${ctx.agentKey}` } : {}) },
        body: JSON.stringify({ model, messages, stream: false, ...(args.max_tokens ? { max_tokens: Number(args.max_tokens) } : {}) }),
        signal: AbortSignal.timeout(180000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return textResult(`模型调用失败（HTTP ${r.status}）：${j?.error?.message || ''}`, true);
      return textResult(j?.choices?.[0]?.message?.content || '');
    } catch (e) {
      return textResult(`模型调用失败：${e.message}`, true);
    }
  }
  return null;
}

/** 这个权限下能用的工具（同名的只留一个：资源 → 派活 → 模型 → 网关自己的） */
function toolsFor(level) {
  const allow = allowedTools(level);
  const seen = new Set();
  const out = [];
  const sources = [require('./resources-mcp').TOOLS, require('./agent-dispatch-mcp').TOOLS, require('./models-mcp').TOOLS, LOCAL_TOOLS];
  for (const list of sources) {
    for (const tool of list || []) {
      if (!allow.has(tool.name) || seen.has(tool.name)) continue;
      seen.add(tool.name);
      out.push(tool);
    }
  }
  return out;
}

async function callTool(name, args, ctx) {
  if (!allowedTools(ctx.level).has(name)) {
    return textResult(`没有权限用 ${name}：请用户在 Token Bank 网关页给你更高的 MCP 权限`, true);
  }
  // 不能派活给自己：会自己叫醒自己、绕一圈
  if ((name === 'tb_dispatch_agent' || name === 'tb_hire_community_agent') && String(args.agent_id || '') === ctx.agentId) {
    return textResult('不能把任务派给你自己', true);
  }
  const local = await callLocal(name, args, ctx);
  if (local) return local;
  if (require('./resources-mcp').TOOLS.some((t) => t.name === name)) return require('./resources-mcp').handleToolCall(name, args);
  if (require('./agent-dispatch-mcp').TOOLS.some((t) => t.name === name)) return require('./agent-dispatch-mcp').handleToolCall(name, args);
  if (require('./models-mcp').TOOLS.some((t) => t.name === name)) return require('./models-mcp').handleToolCall(name, args);
  return textResult(`没有这个工具：${name}`, true);
}

async function handleRpc(msg, ctx) {
  const id = msg && msg.id;
  const isNotice = id === undefined || id === null;
  const reply = (result) => (isNotice ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, message) => (isNotice ? null : { jsonrpc: '2.0', id, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'invalid request');
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tokenbank', version: '1' },
        instructions: '操作用户的 Token Bank：看智能体、模型、设备，派任务、调模型。能用哪些工具由用户在网关页给你的权限决定。',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: toolsFor(ctx.level) });
    case 'tools/call': {
      const name = String(msg.params?.name || '');
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      try { require('./external-agents').recordMcpCall(ctx.agentId); } catch { /* 只是记录 */ }
      try { return reply(await callTool(name, args, ctx)); } catch (e) { return reply(textResult(`调用失败：${e.message}`, true)); }
    }
    default:
      if (msg.method.startsWith('notifications/')) return null;
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}

function bearer(req) {
  const raw = String(req.headers.authorization || '');
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
}

/**
 * POST /v1/mcp：外部智能体用自己的 token 调 Token Bank 的工具。
 * @param {{ port: number, agentKey?: string }} opts
 */
async function handle(req, res, { port, agentKey } = {}) {
  const ext = require('./external-agents');
  if (req.method === 'DELETE') { req.resume(); res.writeHead(200); res.end(); return; }
  if (req.method !== 'POST') {
    req.resume();
    sendJson(res, 405, { error: { message: '用 POST（MCP Streamable HTTP）', type: 'method_not_allowed' } }, { Allow: 'POST, DELETE' });
    return;
  }
  const agent = ext.authenticate(bearer(req), Date.now());
  if (!agent) {
    req.resume();
    sendJson(res, 401, { error: { message: '用你注册 Token Bank 时拿到的 token：Authorization: Bearer tbx_…', type: 'auth_error' } }, { 'WWW-Authenticate': 'Bearer' });
    return;
  }
  const level = ext.MCP_LEVELS.includes(agent.mcpLevel) ? agent.mcpLevel : 'off';
  if (agent.status !== 'active' || level === 'off') {
    req.resume();
    sendJson(res, 403, { error: { message: agent.status !== 'active' ? '你现在不能用 Token Bank（还没被允许，或被停用了）' : '用户还没允许你通过 MCP 操作 Token Bank：请用户在网关页「外部智能体」里点开你，打开「通过 MCP 操作 Token Bank」', type: 'mcp_not_allowed' } });
    return;
  }
  const parts = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { sendJson(res, 413, { error: { message: 'request too large', type: 'invalid_request_error' } }); return; }
    parts.push(c);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || 'null'); } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  // 模型列表按网关实际端口拉（模型 MCP 默认找 11430）
  const models = require('./models-mcp');
  models.setListModelsImpl(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`网关 /v1/models HTTP ${r.status}`);
    const j = await r.json();
    return (Array.isArray(j?.data) ? j.data : []).map(models.normalizeModel).filter(Boolean);
  });
  const ctx = { level, agentId: agent.id, port, agentKey };
  const list = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(list.map((m) => handleRpc(m, ctx)))).filter(Boolean);
  if (!out.length) { res.writeHead(202); res.end(); return; }
  sendJson(res, 200, Array.isArray(body) ? out : out[0]);
}

module.exports = { handle, toolsFor, allowedTools, LEVEL_TOOLS };
