// client/electron/tokenbank-mcp.js
// Token Bank 的 MCP 协议层（Streamable HTTP，JSON 回答）。工具本身在 tokenbank-tools.js。
//
// 网关 11430 上只有一个 MCP 入口，按凭据分流（local-gateway.js）：
//   外部智能体（GrokBot 等）：Authorization: Bearer tbx_… → 这里的 handle()，权限是用户给它设的，默认关闭
//   本机应用：中转 Key → mcp-gateway-server.js，同一套工具 + 投射给它的第三方 MCP，权限默认完全控制
'use strict';

const tools = require('./tokenbank-tools');

const PROTOCOL_VERSION = '2025-03-26';
const MAX_BODY = 1024 * 1024;

/**
 * 一条 JSON-RPC 消息 → 回答（通知返回 null）。本机应用和外部智能体共用。
 * @param {object} msg
 * @param {{ list: () => Promise<object[]>|object[], call: (name: string, args: object) => Promise<object>,
 *   serverName?: string, instructions?: string, onCall?: (name: string) => void }} server
 */
async function rpc(msg, server) {
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
        serverInfo: { name: server.serverName || 'tokenbank', version: '2' },
        instructions: server.instructions || tools.INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      try { return reply({ tools: await server.list() }); } catch (e) { return fail(-32000, e.message); }
    case 'tools/call': {
      const name = String(msg.params?.name || '');
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      try { server.onCall?.(name); } catch { /* 只是记录 */ }
      try { return reply(await server.call(name, args)); } catch (e) { return reply(tools.textResult(`调用失败：${e.message}`, true)); }
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

/** 读 JSON 正文；超大或解析失败时已回答，返回 undefined */
async function readBody(req, res) {
  const parts = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { sendJson(res, 413, { error: { message: 'request too large', type: 'invalid_request_error' } }); return undefined; }
    parts.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8') || 'null');
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return undefined;
  }
}

/** 单条或批量消息一起答；全是通知时 202 */
async function answer(res, body, server) {
  const list = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(list.map((m) => rpc(m, server)))).filter(Boolean);
  if (!out.length) { res.writeHead(202); res.end(); return; }
  sendJson(res, 200, Array.isArray(body) ? out : out[0]);
}

function bearer(req) {
  const raw = String(req.headers.authorization || '');
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
}

/**
 * 外部智能体：凭注册时拿到的 token 调 Token Bank 的工具。
 * 它没有自己的投射，看的是整个资产库（用户给了权限才看得到）。
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
  const level = tools.normalizeLevel(agent.mcpLevel);
  if (agent.status !== 'active' || level === 'off') {
    req.resume();
    sendJson(res, 403, {
      error: {
        message: agent.status !== 'active'
          ? '你现在不能用 Token Bank（还没被允许，或被停用了）'
          : '用户还没允许你通过 MCP 操作 Token Bank：请用户在网关页「智能体 → 外部智能体」里点开你、打开「通过 MCP 操作 Token Bank」，或在「资产 → 工具 → TokenBank 内置」里给你设权限',
        type: 'mcp_not_allowed',
      },
    });
    return;
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  const ctx = {
    clientId: '',
    level,
    selfAgentId: agent.id,
    gatewayUrl: `http://127.0.0.1:${port}`,
    gatewayKey: agentKey,
    dispatch: tools.dispatchContext(''),
    callRelayed: (name, args) => require('./mcp-gateway-server').callRelayedTool(name, args, ''),
  };
  await answer(res, body, {
    list: () => tools.listToolsWithHints(ctx),
    call: (name, args) => tools.callTool(name, args, ctx),
    onCall: () => ext.recordMcpCall(agent.id),
  });
}

module.exports = { handle, rpc, answer, readBody, sendJson };
