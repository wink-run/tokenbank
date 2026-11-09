// agent-dispatch-client.js
// bridge MCP 子进程侧：优先走主进程 HTTP 派发，无 TB_DISPATCH_URL 时回退本地模块（单测用）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const agentExecutor = require('./agent-executor');
const resourceManager = require('./resource-manager');

const INFO_PATH = path.join(os.homedir(), '.tokenbank', 'dispatch-server.json');

/**
 * 每次调用再读端点。启动脚本里的 TB_DISPATCH_URL 在客户端重启后会过期
 * （端口是 listen(0) 随机分配的），以 dispatch-server.json 为准。
 */
function currentDispatchEndpoint() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8'));
    const url = String(parsed?.url || '').replace(/\/$/, '');
    const token = String(parsed?.token || '');
    if (url && token) return { url, token };
  } catch { /* 文件还没写出来时用启动脚本里的值 */ }
  const url = String(process.env.TB_DISPATCH_URL || '').replace(/\/$/, '');
  const token = String(process.env.TB_DISPATCH_TOKEN || '');
  if (url && token) return { url, token };
  return null;
}

function useHttpDispatch() {
  return !!currentDispatchEndpoint();
}

async function httpRequest(method, pathWithQuery, body) {
  const ep = currentDispatchEndpoint();
  if (!ep) throw new Error('派发服务未启动');
  const headers = {
    Authorization: `Bearer ${ep.token}`,
  };
  let bodyStr;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${ep.url}${pathWithQuery}`, {
      method,
      headers,
      body: bodyStr,
    });
  } catch (e) {
    const cause = e?.cause?.code || e?.cause?.message || '';
    throw new Error(`无法连接派发服务 ${ep.url}${cause ? ` (${cause})` : ''}。请确认 Token Bank 客户端在运行。`);
  }

  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(data.error || `dispatch HTTP ${res.status}`);
  }
  return data;
}

async function listAgents() {
  if (useHttpDispatch()) {
    const data = await httpRequest('GET', '/agents');
    return data.agents || [];
  }
  return agentExecutor.listAvailableAgents();
}

async function dispatchAndWait(agentId, prompt, options = {}) {
  if (useHttpDispatch()) {
    const data = await httpRequest('POST', '/dispatch', {
      agentId,
      prompt,
      workingDir: options.workingDir,
      parentTaskId: options.parentTaskId,
      parentSessionKey: options.parentSessionKey,
      parentSessionInstanceId: options.parentSessionInstanceId,
    });
    return data.status;
  }
  return agentExecutor.dispatchAndWait(agentId, prompt, options);
}

function resolvePrompt(ref, args, clientId = '') {
  if (useHttpDispatch()) {
    const q = new URLSearchParams({ name: ref, args: args || '', clientId: clientId || '' });
    return httpRequest('GET', `/prompt?${q.toString()}`);
  }
  return resourceManager.resolvePromptForClient(ref, args, clientId);
}

module.exports = {
  useHttpDispatch,
  listAgents,
  dispatchAndWait,
  resolvePrompt,
};
