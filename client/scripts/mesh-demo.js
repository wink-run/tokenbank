#!/usr/bin/env node
// client/scripts/mesh-demo.js
// 设备网络原型的端到端演示：在一台电脑上用两个独立的 HOME 起两个 CLI 网关，当作两台设备。
//   设备 A「macbook」：发起方，没有模型、没有可用的智能体
//   设备 B「mini」   ：有一个模拟的本地模型 demo-model，装了（模拟的）Claude Code，配了工作区 demo
// 设备之间走 WebSocket（局域网直连），证书由开发用签发方签发。
// 另外起一个官方中继（relay-server.js）和一台只能连中继的设备 C「phone」，验证：经我的设备中继、手动改官方中继、中继设备掉线回落官方中继。
// 用法：node scripts/mesh-demo.js [--keep]   （--keep 跳过断线测试、跑完不退出，两台设备保持在线，方便手动 curl 或打开管理界面）
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const CLIENT = path.resolve(__dirname, '..');
const identity = require('../electron/mesh/identity');
const keys = require('../electron/mesh/keys');
const { startRelayServer } = require('../electron/mesh/relay-server');
const WebSocket = require('ws');

const KEEP = process.argv.includes('--keep');
let LAN_PORT = 41700;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mesh-demo-'));
const results = [];
const procs = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? '  ✔' : '  ✘'} ${name}${detail ? `\n      ${detail}` : ''}`);
}

function freePort() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

function req(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        let json = null;
        try { json = JSON.parse(text); } catch { /* SSE 或纯文本 */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, step = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* 还没好 */ }
    await sleep(step);
  }
  return null;
}

// ── 准备两台「设备」 ──────────────────────────────────────────────────────────

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** 模拟的本地模型（OpenAI 兼容），只在设备 B 上配 */
function startMockModel(who = '设备 B') {
  const server = http.createServer((rq, rs) => {
    const parts = [];
    rq.on('data', (c) => parts.push(c));
    rq.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(parts).toString()); } catch { /* 空 */ }
      const words = ['你好，', `我是${who} `, '上的本地模型 ', body.model, '。'];
      if (body.stream) {
        rs.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const t = setInterval(() => {
          if (i < words.length) {
            rs.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: words[i++] } }] })}\n\n`);
          } else {
            clearInterval(t);
            rs.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
            rs.end('data: [DONE]\n\n');
          }
        }, 40);
        return;
      }
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify({ id: 'c2', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: words.join('') }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/** 模拟的 Claude Code：在当前目录写一个证明文件，用 stream-json 汇报 */
function writeFakeClaude(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.0.0 (Claude Code, mesh demo)'); process.exit(0); }
const prompt = args[args.length - 1];
const ri = args.indexOf('--resume');
const resumed = ri >= 0 ? args[ri + 1] : '';
const sid = resumed || crypto.randomUUID();
// 提示词里带 SLOW 就先等 3 秒，用来看几个子任务是不是并行跑
if (prompt.includes('SLOW')) { const end = Date.now() + 3000; while (Date.now() < end) {} }
fs.writeFileSync(path.join(process.cwd(), 'mesh-proof.txt'), 'written on device B for: ' + prompt + '\\n');
// CODE：改一处代码；REPORT：出一份报告（非代码产出）
if (prompt.includes('CODE')) fs.writeFileSync(path.join(process.cwd(), 'feature.js'), 'export const feature = ' + JSON.stringify(prompt) + ';\\n');
if (prompt.includes('REPORT')) fs.writeFileSync(path.join(process.cwd(), 'report.pdf'), '%PDF-1.4 report for ' + prompt + '\\n');
const files = fs.readdirSync(process.cwd()).filter((f) => !f.startsWith('.')).sort();
const text = (resumed ? '（续上会话 ' + resumed + '）' : '') + '已在设备 B 的工作区执行「' + prompt + '」。工作目录：' + process.cwd() + '。目录里现在有：' + files.join(', ');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd() });
out({ type: 'assistant', session_id: sid, message: { role: 'assistant', content: [{ type: 'text', text }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid });
`);
  fs.chmodSync(file, 0o755);
}

async function prepareDevice({ name, deviceId, home, gwPort, meshPort, issuer, userId, extra = {} }) {
  const meshDir = path.join(home, '.tokenbank', 'mesh');
  const secret = identity.loadOrCreateDeviceSecret(meshDir);
  const endpointId = keys.endpointIdFromSecret(secret);
  const cert = identity.issueCert(issuer, { sub: userId, device_id: deviceId, endpoint_id: endpointId, name });
  return { name, deviceId, home, gwPort, meshPort, meshDir, endpointId, cert, userId, ...extra };
}

function writeMeshConfig(dev, peers, issuer, extra = {}) {
  writeJson(path.join(dev.meshDir, 'config.json'), {
    enabled: true,
    user_id: dev.userId,
    cert: dev.cert,
    issuer_keys: [issuer.publicKey],
    port: dev.meshPort,
    peers: peers.map((p) => ({ endpoint_id: p.endpointId, direct_addrs: [`127.0.0.1:${p.meshPort}`] })),
    lan_port: LAN_PORT,
    presence_ms: 2000,
    ...extra,
  });
}

function startGateway(dev, envExtra = {}) {
  const log = fs.openSync(path.join(ROOT, `${dev.name}.log`), 'a');
  const p = spawn(process.execPath, [path.join(CLIENT, 'cli', 'gateway.js'), 'start', '--port', String(dev.gwPort), '--admin-port', String(dev.gwPort + 1)], {
    cwd: CLIENT,
    // 默认不连云端；MESH_DEMO_REAL_SERVER=1 时用正式服务端（要在界面上登录看真实数据时用）
    env: { ...process.env, HOME: dev.home, TOKENBANK_CLI: '1', ...(process.env.MESH_DEMO_REAL_SERVER === '1' ? {} : { TOKEN_SERVER_URL: 'http://127.0.0.1:9' }), ...envExtra },
    stdio: ['ignore', log, log],
  });
  procs.push(p);
  return p;
}

/** 起一个派发 MCP（和主智能体用的同一个 stdio 进程），按 JSON-RPC 调工具 */
function startMcp(dev, env = {}) {
  const p = spawn(process.execPath, [path.join(CLIENT, 'electron', 'agent-dispatch-mcp.js')], {
    cwd: CLIENT, env: { ...process.env, HOME: dev.home, ...env }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  procs.push(p);
  let buf = '';
  let nextId = 1;
  const waiting = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const w = waiting.get(msg.id); if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: (r.result?.content || []).map((c) => c.text).join('\n'), isError: !!r.result?.isError };
  };
  return { rpc, call, stop: () => p.kill() };
}

function agentKey(dev) {
  try { return JSON.parse(fs.readFileSync(path.join(dev.home, '.llm-agent', 'local-config.json'), 'utf8')).agent_api_key || ''; } catch { return ''; }
}

function logOf(dev) { try { return fs.readFileSync(path.join(ROOT, `${dev.name}.log`), 'utf8'); } catch { return ''; } }

function cleanup() {
  for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* 已退出 */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

// ── 主流程 ───────────────────────────────────────────────────────────────────

(async () => {
  console.log(`演示目录：${ROOT}\n`);
  const issuer = identity.generateIssuer();
  const [gwA, gwB, gwC, meshA, meshB, meshC, relayPort] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];
  LAN_PORT = await freePort();   // 每次演示用自己的广播端口，不和本机别的节点串

  const A = await prepareDevice({ name: 'macbook', deviceId: 'dev-a', home: path.join(ROOT, 'homeA'), gwPort: gwA, meshPort: meshA, issuer, userId: '1001' });
  const B = await prepareDevice({ name: 'mini', deviceId: 'dev-b', home: path.join(ROOT, 'homeB'), gwPort: gwB, meshPort: meshB, issuer, userId: '1001' });
  // 设备 C「phone」：不开入口（像在运营商 NAT 后面），只能经中继；有自己的本地模型 phone-model
  const C = await prepareDevice({ name: 'phone', deviceId: 'dev-c', home: path.join(ROOT, 'homeC'), gwPort: gwC, meshPort: meshC, issuer, userId: '1001' });

  // 官方中继：和每个 app 里的中继同一份代码；把转发的内容写进文件，验证它看不到明文
  const officialDump = path.join(ROOT, 'official-relay.dump');
  const relayB = path.join(ROOT, 'mini-relay.dump');
  const official = await startRelayServer({ port: relayPort, host: '127.0.0.1', issuerKeys: [issuer.publicKey], dumpFile: officialDump, log: () => {} });
  const relayUrls = [`ws://127.0.0.1:${official.port}/mesh/ws`];

  // 设备 B：模拟本地模型 + 模拟 Claude Code + 一个 git 工作区
  const mock = await startMockModel();
  writeJson(path.join(B.home, '.llm-agent', 'config.json'), {
    providers: [{ id: 'mock-local', name: '模拟本地模型', type: 'free', base_url: `http://127.0.0.1:${mock.address().port}/v1`, models: ['demo-model'], enabled: true }],
  });
  const binB = path.join(ROOT, 'binB');
  writeFakeClaude(binB);
  const work = path.join(B.home, 'code', 'demo-repo');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, 'README.md'), '# demo repo on device B\n');
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'demo', GIT_AUTHOR_EMAIL: 'demo@example.test', GIT_COMMITTER_NAME: 'demo', GIT_COMMITTER_EMAIL: 'demo@example.test' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: work });
  fs.writeFileSync(path.join(work, '.gitignore'), 'mesh-proof.txt\n');
  execFileSync('git', ['add', '-A'], { cwd: work });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: work, env: gitEnv });
  writeJson(path.join(B.meshDir, 'workspaces.json'), { default: 'demo', workspaces: { demo: { path: work } } });

  // 不写对端地址：两台设备只靠局域网广播找到对方
  // A 是笔记本，不给别人当中继；B 自动当中继；C 只连中继
  writeMeshConfig(A, [], issuer, { relay_urls: relayUrls, relay_mode: 'off' });
  writeMeshConfig(B, [], issuer, { accept_model_requests: true, relay_urls: relayUrls, relay_dump: relayB });
  writeMeshConfig(C, [], issuer, { accept_model_requests: true, relay_urls: relayUrls, listen: false });
  const mockC = await startMockModel('设备 C');
  writeJson(path.join(C.home, '.llm-agent', 'config.json'), {
    providers: [{ id: 'mock-phone', name: '手机上的模型', type: 'free', base_url: `http://127.0.0.1:${mockC.address().port}/v1`, models: ['phone-model'], enabled: true }],
  });

  console.log('启动三台设备的网关…');
  // B 的 PATH 最前面放模拟的 claude；下面派活时钉到 @mini，A 本机有没有 claude 都不影响
  startGateway(A, {});
  startGateway(B, { PATH: `${binB}:${process.env.PATH}` });
  startGateway(C, {});

  const upA = await until(() => req(gwA, 'GET', '/v1/devices').then((r) => r.status === 200));
  const upB = await until(() => req(gwB, 'GET', '/v1/devices').then((r) => r.status === 200));
  const upC = await until(() => req(gwC, 'GET', '/v1/devices').then((r) => r.status === 200));
  check('三台网关都启动了', upA && upB && upC);
  if (!upA || !upB) { console.log(logOf(A).slice(-2000), logOf(B).slice(-2000)); process.exit(1); }

  // 1. 入网与设备目录
  console.log('\n[1] 入网与设备纳管');
  const seen = await until(async () => {
    const r = await req(gwA, 'GET', '/v1/devices');
    const b = (r.json?.data || []).find((d) => d.device_id === 'dev-b');
    return b && b.online && (b.apps || []).length ? r.json : null;
  }, 40000);
  const devB = seen?.data?.find((d) => d.device_id === 'dev-b');
  check('A 的 /v1/devices 里看到 B 在线', !!devB, devB ? `连接方式=${devB.connection} 延迟=${devB.rtt_ms}ms 应用=${devB.apps.map((a) => a.id).join(',')} 模型=${devB.models.join(',')} 工作区=${devB.workspaces.map((w) => w.name).join(',')}` : '');
  const fromB = await req(gwB, 'GET', '/v1/devices');
  check('B 也看到 A（对等）', (fromB.json?.data || []).some((d) => d.device_id === 'dev-a' && d.online));
  check('两台都没配对端地址，靠局域网广播找到彼此', /局域网发现 (mini|macbook)/.test(logOf(A) + logOf(B)), ((logOf(A) + logOf(B)).match(/\[mesh\] 局域网发现[^\n]*/) || [''])[0]);
  check('设备目录里没有本机路径', !JSON.stringify(seen || {}).includes(B.home));

  // 2. 模型统一入口
  console.log('\n[2] 模型：在 A 上调用只有 B 才有的模型');
  const models = await req(gwA, 'GET', '/v1/models');
  const ids = (models.json?.data || []).map((m) => m.id);
  check('A 的 /v1/models 列出 demo-model 和 mine:mini/demo-model', ids.includes('demo-model') && ids.includes('mine:mini/demo-model'));
  const chat = await req(gwA, 'POST', '/v1/chat/completions', { body: { model: 'demo-model', stream: true, messages: [{ role: 'user', content: 'hi' }] } });
  const streamed = chat.text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => { try { return JSON.parse(l.slice(6)).choices[0].delta.content || ''; } catch { return ''; } }).join('');
  check('流式对话由 B 的本地模型返回', chat.status === 200 && streamed.includes('设备 B'), `回复：${streamed}  执行设备：${chat.headers['x-tb-mesh-device'] || '-'}`);
  // 统计（E2-3）：A 记下「在哪台做」，B 记下「从哪台来」
  const logA = await until(async () => {
    const r = await req(gwA + 1, 'GET', '/api/gateway/log');
    return (r.json?.log || []).find((e) => e.route === 'mesh' && e.requested_model === 'demo-model' && e.status === 'ok') || null;
  }, 8000);
  const logB = await until(async () => {
    const r = await req(gwB + 1, 'GET', '/api/gateway/log');
    return (r.json?.log || []).find((e) => e.from_device === 'macbook' && e.requested_model === 'demo-model') || null;
  }, 8000);
  check('路由明细：A 记下交给了 mini（我的设备层），B 记下是 macbook 发来的', !!logA && logA.device === 'mini' && !!logB,
    logA ? `A: via=${logA.via} device=${logA.device} | B: from=${logB?.from_device}` : '');
  const pinned = await req(gwA, 'POST', '/v1/chat/completions', { body: { model: 'mine:mini/demo-model', messages: [{ role: 'user', content: 'hi' }] } });
  check('mine:mini/demo-model 钉设备（非流式）', pinned.status === 200 && /设备 B/.test(pinned.json?.choices?.[0]?.message?.content || ''));

  // 3. 智能体统一入口
  console.log('\n[3] 智能体：在 A 上派活，B 在自己的工作区里执行');
  const keyA = agentKey(A);
  const auth = { authorization: `Bearer ${keyA}` };
  const harnesses = await req(gwA, 'GET', '/v1/agent/harnesses', { headers: auth });
  const hIds = (harnesses.json?.data || []).map((h) => h.id);
  check('A 的 /v1/agent/harnesses 列出 mine:claude-code@mini', hIds.includes('mine:claude-code@mini'), hIds.filter((x) => x.startsWith('mine:')).join(', '));

  const created = await req(gwA, 'POST', '/v1/agent/responses', {
    headers: { ...auth, 'idempotency-key': 'demo-1' },
    body: { input: '看看仓库里有什么，并留下证明文件', background: true, metadata: { harness_id: 'mine:claude-code@mini', workspace: 'demo' } },
  });
  const taskId = created.json?.id || '';
  check('异步提交拿到 mesh:<设备>:<任务号>', created.status === 200 && taskId.startsWith('mesh:dev-b:'), `任务号：${taskId}  状态：${created.json?.status}`);
  const done = await until(async () => {
    const r = await req(gwA, 'GET', `/v1/agent/responses/${encodeURIComponent(taskId)}`, { headers: auth });
    return ['completed', 'failed', 'cancelled'].includes(r.json?.status) ? r.json : null;
  }, 60000, 800);
  const text = done?.output?.[0]?.content?.[0]?.text || '';
  check('在 A 上查到 B 执行完成的结果', done?.status === 'completed', text.slice(0, 160));
  check('任务在 B 的真实工作区里执行（不是沙箱）', fs.existsSync(path.join(work, 'mesh-proof.txt')) && text.includes(work));
  check('结果标注了执行设备', done?.metadata?.mesh_device === 'mini');
  const replay = await req(gwA, 'POST', '/v1/agent/responses', {
    headers: { ...auth, 'idempotency-key': 'demo-1' },
    body: { input: '看看仓库里有什么，并留下证明文件', background: true, metadata: { harness_id: 'mine:claude-code@mini', workspace: 'demo' } },
  });
  check('同一个幂等键重放，返回同一个任务', replay.json?.id === taskId);

  const streamed2 = await req(gwA, 'POST', '/v1/agent/responses', {
    headers: auth,
    body: { input: '再看一次', stream: true, metadata: { harness_id: 'mine:claude-code@mini', workspace: 'demo' } },
  });
  const lastEvent = streamed2.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean).pop();
  check('流式调用：SSE 穿过隧道，任务号同样改写', String(streamed2.headers['content-type'] || '').includes('event-stream') && String(lastEvent?.id || '').startsWith('mesh:dev-b:'), `最后一个事件：${lastEvent?.status} ${lastEvent?.id}`);

  // 智能体路由里点名执行者：/claude-code@mini 跳过主智能体的挑选，直接交给 mini
  const pinnedRoute = await req(gwA, 'POST', '/v1/agent/responses', {
    headers: auth,
    body: { input: '/claude-code@mini 看看仓库里有什么', metadata: { harness_id: 'agent-router-default', workspace: 'demo' } },
  });
  const pinnedText = pinnedRoute.json?.output?.[0]?.content?.[0]?.text || '';
  check('智能体路由里 /claude-code@mini 点名：跳过主智能体，直接在 mini 上执行',
    pinnedRoute.status === 200 && pinnedRoute.json?.metadata?.designated === '/claude-code@mini'
      && String(pinnedRoute.json?.id || '').startsWith('mesh:dev-b:') && pinnedText.includes('「看看仓库里有什么」'),
    `designated=${pinnedRoute.json?.metadata?.designated} route=${pinnedRoute.json?.metadata?.route_id} 任务号=${pinnedRoute.json?.id}`);
  const log = await req(gwA + 1, 'GET', '/api/gateway/log');
  const logged = (log.json?.log || []).find((e) => e.designated === '/claude-code@mini');
  check('路由明细记下点名、路由和执行设备', !!logged && logged.route_id === 'agent-router-default' && logged.device === 'mini',
    logged ? `route_id=${logged.route_id} designated=${logged.designated} device=${logged.device}` : `admin log HTTP ${log.status}`);

  const noWs = await req(gwA, 'POST', '/v1/agent/responses', { headers: auth, body: { input: 'x', metadata: { harness_id: 'mine:claude-code', workspace: 'nope' } } });
  check('没有这个工作区时给出明确原因', noWs.status === 404 && /工作区 nope/.test(noWs.json?.error?.message || ''), noWs.json?.error?.message);

  // 3b. 设备名称（和交易页「设备名称」同一个字段）
  console.log('\n[3b] 设备名称');
  const setAlias = await req(gwA, 'PUT', '/v1/devices/dev-b/name', { headers: auth, body: { name: 'studio' } });
  check('在 A 上把 B 改名为 studio', setAlias.status === 200 && setAlias.json?.name === 'studio', JSON.stringify(setAlias.json));
  const storedOnB = (() => { try { return JSON.parse(fs.readFileSync(path.join(B.home, '.llm-agent', 'config.json'), 'utf8')); } catch { return {}; } })();
  check('名称保存在 B 自己的配置里（交易页「设备名称」那个字段），原有配置不丢', storedOnB.name === 'studio' && Array.isArray(storedOnB.providers) && storedOnB.providers.length > 0);
  const seenAlias = await until(async () => {
    const r = await req(gwA, 'GET', '/v1/devices');
    const d = (r.json?.data || []).find((x) => x.device_id === 'dev-b');
    return d && d.label === 'studio' ? d : null;
  }, 15000);
  check('A 的设备目录里 B 显示为 studio', !!seenAlias, seenAlias ? `name=${seenAlias.name} aliases=${seenAlias.aliases.join(',')}` : '');
  const hs = await req(gwA, 'GET', '/v1/agent/harnesses', { headers: auth });
  check('智能体列表里出现 mine:claude-code@studio', (hs.json?.data || []).some((h) => h.id === 'mine:claude-code@studio'));
  const byAlias = await req(gwA, 'POST', '/v1/agent/responses', {
    headers: auth,
    body: { input: '/claude-code@studio 用别名派一次', metadata: { harness_id: 'agent-router-default', workspace: 'demo' } },
  });
  check('/claude-code@studio 用新名称点名，在 B 上执行', byAlias.status === 200 && String(byAlias.json?.id || '').startsWith('mesh:dev-b:') && byAlias.json?.metadata?.mesh_device === 'studio',
    `任务号=${byAlias.json?.id} 执行设备=${byAlias.json?.metadata?.mesh_device}`);
  const byAliasHarness = await req(gwA, 'POST', '/v1/agent/responses', { headers: auth, body: { input: '再来一次', metadata: { harness_id: 'mine:claude-code@studio', workspace: 'demo' } } });
  check('mine:claude-code@studio 同样可用', byAliasHarness.status === 200 && String(byAliasHarness.json?.id || '').startsWith('mesh:dev-b:'));
  const oldName = await req(gwA, 'POST', '/v1/agent/responses', { headers: auth, body: { input: '用电脑名', metadata: { harness_id: 'mine:claude-code@mini', workspace: 'demo' } } });
  check('原来的电脑名 mini 照样能用', oldName.status === 200 && String(oldName.json?.id || '').startsWith('mesh:dev-b:'));
  const clash = await req(gwA, 'PUT', '/v1/devices/self/name', { headers: auth, body: { name: 'studio' } });
  check('名称和别的设备重复时拒绝', clash.status === 409, clash.json?.error?.message);
  const bad = await req(gwA, 'PUT', '/v1/devices/self/name', { headers: auth, body: { name: 'my mini' } });
  check('名称带空格时拒绝', bad.status === 400, bad.json?.error?.message);
  const noKey = await req(gwA, 'PUT', '/v1/devices/self/name', { body: { name: 'x' } });
  check('没有 Key 不能改名称', noKey.status === 401);

  // 3c. 主智能体在 A 上用 MCP 派活给 B：同步、后台并行、续上一轮、任务树
  console.log('\n[3c] 派活：MCP 派到其他设备、后台并行、任务树');
  const parentId = taskId;   // 拿前面那个任务当「父任务」，子任务都挂在它下面
  const mcp = startMcp(A, { TB_PARENT_TASK_ID: parentId });
  await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mesh-demo', version: '1' } });
  const toolList = await mcp.rpc('tools/list');
  const toolNames = (toolList.result?.tools || []).map((t) => t.name);
  const dispatchSchema = (toolList.result?.tools || []).find((t) => t.name === 'tb_dispatch_agent')?.inputSchema?.properties || {};
  check('MCP 有 tb_task_status，tb_dispatch_agent 有 background / previous_task_id',
    toolNames.includes('tb_task_status') && !!dispatchSchema.background && !!dispatchSchema.previous_task_id, toolNames.join(', '));
  const listed = await mcp.call('tb_list_agents');
  check('tb_list_agents 列出我的其他设备上的智能体', /mine:claude-code@studio: .*\[我的设备\]/.test(listed.text),
    (listed.text.split('\n').find((l) => l.includes('mine:claude-code@studio')) || '').trim());

  const syncRun = await mcp.call('tb_dispatch_agent', { agent_id: 'mine:claude-code@studio', prompt: 'MCP 同步派活' });
  check('tb_dispatch_agent 派到 studio 并等到结果（执行器认识 mine:）', !syncRun.isError && /已在设备 B/.test(syncRun.text), syncRun.text.slice(0, 120));

  const t0 = Date.now();
  const bg1 = await mcp.call('tb_dispatch_agent', { agent_id: 'mine:claude-code@studio', prompt: 'SLOW 子任务一', background: true });
  const bg2 = await mcp.call('tb_dispatch_agent', { agent_id: 'mine:claude-code@studio', prompt: 'SLOW 子任务二', background: true });
  const idOf = (t) => (t.match(/任务号：(mesh:\S+)/) || [])[1] || '';
  const id1 = idOf(bg1.text);
  const id2 = idOf(bg2.text);
  check('background=true 马上返回任务号', !!id1 && !!id2 && Date.now() - t0 < 2500, `${id1}  ${id2}  用时 ${Date.now() - t0}ms`);
  const anyDone = await mcp.call('tb_task_status', { ids: [id1, id2], wait: 'any', timeout_seconds: 30 });
  check('tb_task_status(wait="any") 有一个做完就返回', /完成/.test(anyDone.text), anyDone.text.split('\n').slice(0, 2).join(' | '));
  const allDone = await mcp.call('tb_task_status', { ids: [id1, id2], wait: 'all', timeout_seconds: 30 });
  const both = (allDone.text.match(/\] 完成/g) || []).length === 2;
  const took = Date.now() - t0;
  check('两个各要 3 秒的子任务并行跑完（总用时不到 6 秒）', both && took < 5800, `总用时 ${took}ms`);

  const again = await mcp.call('tb_dispatch_agent', { agent_id: 'mine:claude-code@studio', prompt: '按反馈再改一版', previous_task_id: id1 });
  check('previous_task_id：在同一台设备上续上原来的会话', !again.isError && /续上会话/.test(again.text), again.text.slice(0, 120));
  mcp.stop();

  const viaHttp = await req(gwA, 'POST', '/v1/agent/responses', {
    headers: auth,
    body: { input: 'HTTP 派的子任务', metadata: { harness_id: 'mine:claude-code@studio', parent_id: parentId } },
  });
  check('HTTP 接口带 metadata.parent_id 派子任务', viaHttp.status === 200 && viaHttp.json?.status === 'completed');
  const parentView = await req(gwA, 'GET', `/v1/agent/responses/${encodeURIComponent(parentId)}`, { headers: auth });
  const kids = parentView.json?.children || [];
  check('GET 父任务带 children（MCP 和 HTTP 派的都在，都已完成，标着设备）', kids.length === 5 && kids.every((k) => k.status === 'completed' && k.metadata?.parent_id === parentId && k.metadata?.mesh_device === 'studio'),
    kids.map((k) => `${k.id.slice(-8)} ${k.status} @${k.metadata?.mesh_device}`).join(' | '));
  const byParent = await req(gwA, 'GET', `/v1/agent/responses?parent_id=${encodeURIComponent(parentId)}`, { headers: auth });
  check('GET /v1/agent/responses?parent_id= 列出子任务', byParent.status === 200 && (byParent.json?.data || []).length === 5);
  const treeView = await req(gwA, 'GET', `/v1/agent/responses/${encodeURIComponent(parentId)}?tree=1`, { headers: auth });
  check('?tree=1 返回整棵树', Array.isArray(treeView.json?.children) && treeView.json.children.every((k) => Array.isArray(k.children)));

  // 3d. 本机设置：接活开关、开放模型的源、工作区（盘点页选中本机时改的就是这些）
  console.log('\n[3d] 本机设置：接活、开放模型、工作区');
  const authB = { authorization: `Bearer ${agentKey(B)}` };
  const devOnA = async () => ((await req(gwA, 'GET', '/v1/devices', { headers: auth })).json?.data || []).find((d) => d.device_id === 'dev-b');
  const bShared = await devOnA();
  check('B 开放模型时，A 看到 B 的模型源（名字、类型、模型数，没有地址和密钥）',
    (bShared?.providers || []).length > 0 && !JSON.stringify(bShared.providers).includes('http'), JSON.stringify(bShared?.providers || []));
  const offTasks = await req(gwB, 'PUT', '/v1/devices/self/settings', { headers: authB, body: { accept_agent_tasks: false } });
  const hidden = await until(async () => { const d = await devOnA(); return d && d.apps.length === 0 ? d : null; }, 15000);
  check('B 关掉「接我其他设备派来的活」后，A 看不到 B 上的应用', offTasks.status === 200 && offTasks.json?.accept_agent_tasks === false && !!hidden);
  await req(gwB, 'PUT', '/v1/devices/self/settings', { headers: authB, body: { accept_agent_tasks: true } });
  await until(async () => { const d = await devOnA(); return d && d.apps.length > 0; }, 15000);
  const site = path.join(B.home, 'code', 'site');
  fs.mkdirSync(site, { recursive: true });
  const addWs = await req(gwB, 'POST', '/v1/devices/self/workspaces', { headers: authB, body: { path: site } });
  check('在 B 上添加工作区：名字取目录名，路径存成 ~/…', addWs.status === 200 && (addWs.json?.workspaces || []).some((w) => w.name === 'site' && w.path === '~/code/site'),
    JSON.stringify((addWs.json?.workspaces || []).map((w) => `${w.name}=${w.path}`)));
  const seenWs = await until(async () => { const d = await devOnA(); return d && d.workspaces.some((w) => w.name === 'site') ? d : null; }, 15000);
  check('A 只看到工作区的名字，看不到 B 上的路径', !!seenWs && !JSON.stringify(seenWs.workspaces).includes(B.home), JSON.stringify(seenWs?.workspaces || []));
  const viaTunnel = await req(gwA, 'GET', '/v1/devices/self/settings', { headers: { authorization: 'Bearer x' } });
  check('本机设置要本机的 Key', viaTunnel.status === 401);
  // 并发上限：B 只接 1 个，第二个点名给它的活直接回「满了」
  await req(gwB, 'PUT', '/v1/devices/self/settings', { headers: authB, body: { max_tasks: 1 } });
  const slow1 = await req(gwA, 'POST', '/v1/agent/responses', { headers: auth, body: { input: 'SLOW 占着', background: true, metadata: { harness_id: 'mine:claude-code@studio' } } });
  await sleep(500);
  const slow2 = await req(gwA, 'POST', '/v1/agent/responses', { headers: auth, body: { input: 'SLOW 再来一个', background: true, metadata: { harness_id: 'mine:claude-code@studio' } } });
  check('B 设成同时接 1 个时，第二个活回 429「满了」', slow1.status === 200 && slow2.status === 429, slow2.json?.error?.message);
  const loadSeen = await until(async () => { const d = await devOnA(); return d && d.load?.max === 1 ? d.load : null; }, 15000);
  check('A 看到 B 报的真实负载和上限', !!loadSeen, JSON.stringify(loadSeen));
  await until(async () => (await req(gwA, 'GET', `/v1/agent/responses/${encodeURIComponent(slow1.json?.id || '')}`, { headers: auth })).json?.status === 'completed', 20000);
  await req(gwB, 'PUT', '/v1/devices/self/settings', { headers: authB, body: { max_tasks: 2 } });
  const delWs = await req(gwB, 'DELETE', '/v1/devices/self/workspaces/site', { headers: authB });
  check('删除工作区', delWs.status === 200 && !(delWs.json?.workspaces || []).some((w) => w.name === 'site'));

  // 4. 防回环与边界
  console.log('\n[4] 安全边界');
  const loop = await req(gwB, 'POST', '/v1/agent/responses', { headers: { authorization: `Bearer ${agentKey(B)}`, 'x-tb-mesh-hop': '1' }, body: { input: 'x', metadata: { harness_id: 'mine:claude-code' } } });
  check('经隧道转来的请求不能再转进设备网络', loop.status === 409);
  const spoof = await req(gwB, 'GET', '/v1/agent/harnesses', { headers: { authorization: 'Bearer tbm_guess', 'x-tb-mesh-from': 'dev-a' } });
  check('外部伪造设备网络头没有用', spoof.status === 401);

  // 另一个账号的设备想连 B：证书校验不过，连接被拒；连官方中继可以，但到不了别人的设备
  const X = await prepareDevice({ name: 'stranger', deviceId: 'dev-x', home: path.join(ROOT, 'homeX'), gwPort: 1, meshPort: 1, issuer, userId: '2002' });
  const xKey = keys.deviceKey(identity.loadOrCreateDeviceSecret(X.meshDir));
  const wsTry = (url, after) => new Promise((resolve) => {
    const ws = new WebSocket(url);
    const seen = [];
    const t = setTimeout(() => { ws.terminate(); resolve(seen); }, 5000);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      seen.push(m);
      if (m.type === 'challenge') ws.send(JSON.stringify({ type: 'register', proto: 1, cert: X.cert, sig: keys.sign(xKey.privateKey, `tb-mesh-register|${m.nonce}`) }));
      else if (m.type === 'registered' && after) after(ws);
      else if (m.type === 'error' || m.type === 'peer_offline') { clearTimeout(t); ws.close(); resolve(seen); }
    });
    ws.on('error', () => { clearTimeout(t); resolve(seen); });
  });
  const toB = await wsTry(`ws://127.0.0.1:${B.meshPort}/mesh/ws`);
  check('其他账号的设备连不进 B', toB.some((m) => m.type === 'error' && m.message === 'other_user') && /拒绝[^\n]*other_user/.test(logOf(B)), (logOf(B).match(/\[mesh\] 拒绝[^\n]*/) || [''])[0]);
  const toOfficial = await wsTry(relayUrls[0], (ws) => ws.send(JSON.stringify({ type: 'relay', to: 'dev-b', data: { t: 'hello' } })));
  check('其他账号连得上官方中继，但发给我的设备只会得到 peer_offline', toOfficial.some((m) => m.type === 'registered') && toOfficial.some((m) => m.type === 'peer_offline'),
    toOfficial.map((m) => m.type).join(' → '));

  // 4b. 中继：C 不开入口，经 B 中继；手动改官方中继；改回自动
  console.log('\n[4b] 中继');
  const secret = `SECRET-${Date.now()}`;
  const viewA = async () => (await req(gwA, 'GET', '/v1/devices', { headers: auth })).json || {};
  const cOnA = async () => (await viewA()).data?.find((d) => d.device_id === 'dev-c');
  const viaB = await until(async () => { const d = await cOnA(); return d?.online && d.connection === 'relay' && d.via?.device_id === 'dev-b' ? d : null; }, 45000);
  check('A 看到 C 在线，经 B 中继（自动选：A 关了中继，C 没开入口，只有 B 能当）', !!viaB, JSON.stringify(viaB ? { connection: viaB.connection, via: viaB.via } : await cOnA()));
  const relayOfA = (await viewA()).relay;
  check('A 的 /v1/devices 标明本机在用哪个中继', relayOfA?.using === 'dev-b', JSON.stringify(relayOfA));
  const chatC = await req(gwA, 'POST', '/v1/chat/completions', { body: { model: 'phone-model', messages: [{ role: 'user', content: secret }] } });
  check('在 A 上调用只有 C 才有的模型，经中继返回', chatC.status === 200 && /设备 C/.test(chatC.json?.choices?.[0]?.message?.content || ''), chatC.json?.choices?.[0]?.message?.content || chatC.text.slice(0, 200));
  const bServing = await until(async () => {
    const d = (await viewA()).data?.find((x) => x.device_id === 'dev-b');
    return d?.relay?.sessions > 0 ? d.relay : null;
  }, 20000);
  check('B 被标成中继设备，A 看得到它在替哪些设备转发', !!bServing && bServing.serving.some((p) => p.includes('phone')), JSON.stringify(bServing));
  const dumpB = fs.existsSync(relayB) ? fs.readFileSync(relayB, 'utf8') : '';
  check('经 B 中继的内容是密文：B 的转发记录里没有提示词', dumpB.length > 0 && !dumpB.includes(secret) && !dumpB.includes('设备 C'), `转发记录 ${dumpB.length} 字节`);

  const setOfficial = await req(gwA, 'PUT', '/v1/devices/self/settings', { headers: auth, body: { relay_pref: 'official' } });
  const viaOfficial = await until(async () => { const d = await cOnA(); return d?.online && d.connection === 'relay' && d.via?.kind === 'official' ? d : null; }, 45000);
  check('在 A 上手动改成官方中继，C 跟着换过去', setOfficial.status === 200 && !!viaOfficial, JSON.stringify(viaOfficial?.via || (await cOnA())?.via));
  const bUsing = await until(async () => { const r = (await req(gwB, 'GET', '/v1/devices')).json?.relay; return r?.using === 'official' ? r : null; }, 20000);
  check('手动指定同步到同账号其他设备（B 也改用官方中继）', !!bUsing, JSON.stringify(bUsing));
  const chatC2 = await req(gwA, 'POST', '/v1/chat/completions', { body: { model: 'phone-model', messages: [{ role: 'user', content: secret }] } });
  check('经官方中继调用 C 的模型', chatC2.status === 200 && /设备 C/.test(chatC2.json?.choices?.[0]?.message?.content || ''));
  const dumpO = fs.existsSync(officialDump) ? fs.readFileSync(officialDump, 'utf8') : '';
  check('官方中继也只看到密文', dumpO.length > 0 && !dumpO.includes(secret) && !dumpO.includes('设备 C'), `转发记录 ${dumpO.length} 字节`);
  await req(gwA, 'PUT', '/v1/devices/self/settings', { headers: auth, body: { relay_pref: 'auto' } });
  const back = await until(async () => { const d = await cOnA(); return d?.online && d.via?.device_id === 'dev-b' ? d : null; }, 45000);
  check('改回自动：又经 B 中继', !!back, JSON.stringify((await cOnA())?.via));

  if (KEEP) {
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n结果：${passed}/${results.length} 通过（--keep：跳过断线测试，两台设备保持在线）`);
    console.log(`设备 A 管理界面：http://127.0.0.1:${gwA + 1}/   网关：http://127.0.0.1:${gwA}`);
    console.log(`设备 B 管理界面：http://127.0.0.1:${gwB + 1}/   网关：http://127.0.0.1:${gwB}`);
    console.log(`A 的智能体 Key：${keyA}`);
    console.log('按 Ctrl+C 退出');
    return;
  }

  // 5. 断线与恢复
  console.log('\n[5] 断线');
  const pB = procs[1];
  pB.kill('SIGTERM');
  const off = await until(async () => {
    const r = await req(gwA, 'GET', '/v1/devices');
    const b = (r.json?.data || []).find((d) => d.device_id === 'dev-b');
    return b && !b.online ? b : null;
  }, 30000);
  check('B 关掉后 A 显示它离线，并保留最后一次描述', !!off && off.apps.length > 0, off ? `离线 ${off.last_seen_sec_ago}s，仍记得 ${off.apps.map((a) => a.id).join(',')}` : '');
  const offlineCall = await req(gwA, 'POST', '/v1/agent/responses', { headers: auth, body: { input: 'x', metadata: { harness_id: 'mine:claude-code@mini' } } });
  check('B 离线时派活返回明确原因', offlineCall.status === 404 && /离线/.test(offlineCall.json?.error?.message || ''), offlineCall.json?.error?.message);
  const fallback = await until(async () => { const d = await cOnA(); return d?.online && d.via?.kind === 'official' ? d : null; }, 45000);
  check('中继设备 B 掉线后，A 和 C 回落到官方中继', !!fallback, JSON.stringify((await cOnA())?.via));
  const chatC3 = await req(gwA, 'POST', '/v1/chat/completions', { body: { model: 'phone-model', messages: [{ role: 'user', content: 'hi' }] } });
  check('回落后照样能调 C 的模型', chatC3.status === 200 && /设备 C/.test(chatC3.json?.choices?.[0]?.message?.content || ''));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过。日志：${ROOT}/macbook.log、${ROOT}/mini.log、${ROOT}/phone.log`);
  mock.close();
  mockC.close();
  await official.close();
  cleanup();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
