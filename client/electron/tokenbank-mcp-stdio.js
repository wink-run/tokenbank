#!/usr/bin/env node
// client/electron/tokenbank-mcp-stdio.js
// 写进各应用 MCP 配置的 tokenbank 条目（stdio），应用配置里只有这一条。
//  - Token Bank 的工具和在网关里跑的第三方 MCP：消息转给网关 /mcp/<应用>（tokenbank-tools.js 是同一份实现）
//  - 要用应用自己项目目录或系统权限的 MCP（文件、git、浏览器、电脑操作）：在这里起子进程（tokenbank-mcp-local.js），
//    工具一起列给模型；Token Bank 没开时也能用
//
// 环境变量：
//   TB_CLIENT_ID      哪个应用（决定看到哪些投射的资产、用哪一档权限）
//   TB_PARENT_TASK_ID 可选：派出的子任务挂在这个任务下面（脚本用；Token Bank 编排时网关按应用 id 自己找）
// 另外带上应用的工作目录，派活默认在那儿做。
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');

const INFO_PATH = path.join(os.homedir(), '.tokenbank', 'mcp-gateway.json');
const PROTOCOL_VERSION = '2025-03-26';
const NOT_RUNNING = 'Token Bank 没在运行：请先打开 Token Bank（或启动命令行版），再重试。';

function clientId() {
  return String(process.env.TB_CLIENT_ID || process.env.TB_MAIN_AGENT_ID || '').trim();
}

/** 每次都重读：Token Bank 重启后端口和 Key 可能变 */
function gateway() {
  try {
    const info = JSON.parse(fs.readFileSync(INFO_PATH, 'utf8'));
    const base = String(info?.url || '').replace(/\/mcp\/?$/, '');
    if (base && info?.token) return { base, token: String(info.token) };
  } catch { /* 还没启动过 */ }
  return null;
}

/** 父任务（可选）和应用的工作目录 */
function dispatchHeader() {
  return encodeURIComponent(JSON.stringify({ parentTaskId: process.env.TB_PARENT_TASK_ID || '', cwd: process.cwd() }));
}

/** 用 http 而不是 fetch：派活会等很久（tb_dispatch_agent 默认等做完），fetch 五分钟没回头就断 */
function forward(msg) {
  const gw = gateway();
  if (!gw) return Promise.reject(new Error(NOT_RUNNING));
  const cid = clientId();
  const url = new URL(`${gw.base}/mcp${cid ? `/${encodeURIComponent(cid)}` : ''}`);
  const body = JSON.stringify(msg);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
        Authorization: `Bearer ${gw.token}`,
        // 给这个应用的第三方 MCP 也原样列出来（不藏在 tb_call_mcp 后面），模型选工具、填参数都更准
        'X-TB-Scope': 'app',
        'X-TB-Dispatch': dispatchHeader(),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 202) return resolve(null);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(res.statusCode === 401 ? NOT_RUNNING : `Token Bank 返回 HTTP ${res.statusCode}：${text.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error('Token Bank 的回答看不懂')); }
      });
    });
    req.on('error', () => reject(new Error(NOT_RUNNING)));
    req.end(body);
  });
}

let localHost = null;
function local() {
  if (!localHost) {
    const { createLocalHost } = require('./tokenbank-mcp-local');
    localHost = createLocalHost({ clientId: clientId(), gateway });
  }
  return localHost;
}

function send(msg) {
  if (msg) process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const id = msg?.id;
  const isNotice = id === undefined || id === null;
  // initialize / ping 本地答：Token Bank 没开时应用也能连上，之后打开就能用
  if (msg?.method === 'initialize') {
    const { INSTRUCTIONS } = require('./tokenbank-tools');
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tokenbank', version: '2' },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }
  if (msg?.method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (isNotice) { forward(msg).catch(() => {}); return; }
  if (msg?.method === 'tools/list' && clientId()) {
    // 网关的和在应用里起的一起列；在应用里起的慢也不拖：先用上次存的工具列表
    const [remote, mine] = await Promise.all([
      forward(msg).then((r) => ({ r }), (e) => ({ e })),
      local().listTools().catch(() => []),
    ]);
    let tools;
    if (remote.r && Array.isArray(remote.r.result?.tools)) tools = remote.r.result.tools;
    else if (remote.r) { send(remote.r); return; }
    else {
      // 没连上时先给完整列表，调用时再提示打开 Token Bank
      const tb = require('./tokenbank-tools');
      tools = tb.listTools({ level: 'full', guardian: clientId() === tb.GUARDIAN_CLIENT_ID });
    }
    const taken = new Set(tools.map((t) => t.name));
    send({ jsonrpc: '2.0', id, result: { ...(remote.r?.result || {}), tools: [...tools, ...mine.filter((t) => !taken.has(t.name))] } });
    return;
  }
  if (msg?.method === 'tools/call' && clientId()) {
    let mine = null;
    try { await local().load(); mine = local().owner(msg.params?.name); } catch { /* 没有本地的 */ }
    if (mine) {
      try {
        send({ jsonrpc: '2.0', id, result: await local().call(msg.params?.name, msg.params?.arguments) });
      } catch (e) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
      }
      return;
    }
  }
  try {
    send(await forward(msg));
  } catch (e) {
    if (msg.method === 'tools/list') {
      // 没连上时先给完整列表，调用时再提示打开 Token Bank
      const tools = require('./tokenbank-tools');
      send({ jsonrpc: '2.0', id, result: { tools: tools.listTools({ level: 'full', guardian: clientId() === tools.GUARDIAN_CLIENT_ID }) } });
    } else if (msg.method === 'tools/call') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
    }
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg;
    try { msg = JSON.parse(t); } catch { return; }
    handle(msg);
  });
  // 应用关掉连接：在应用里起的子进程一起退
  const bye = () => { try { localHost?.stopAll(); } catch { /* ignore */ } process.exit(0); };
  rl.on('close', bye);
  process.on('SIGTERM', bye);
}

module.exports = { handle, forward, gateway };
