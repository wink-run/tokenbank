#!/usr/bin/env node
// 雇佣走设备通道 · 端到端演示：两个账号、一个本机跑着的测试服务端、一个官方中继。
//   账号 H 的设备 A：雇佣方
//   账号 W 的设备 R「rentbox」：出租方，出租模拟的 Claude Code（app:claude-code）
// 检查：A 雇 R 时走设备通道（端到端加密，官方中继只看到密文），云端只签票、记账；
//       出租方关掉设备网络后，照旧走云端转发。
//
// 默认用服务端内置的官方中继（/mesh/ws），服务端什么都不用配。要检查中继只看到密文，服务端和演示用同一个转发记录文件：
//   MESH_RELAY_DUMP=/tmp/relay.dump uvicorn server:app --port 18000
//   MESH_RELAY_DUMP=/tmp/relay.dump MESH_CLOUD_SERVER=http://127.0.0.1:18000 node scripts/mesh-hire-demo.js
// 测独立的 mesh-relay：MESH_HIRE_RELAY=standalone，服务端另配 MESH_RELAY_URLS=ws://127.0.0.1:18790/mesh/ws MESH_RELAY_ACCESS_TOKEN=relay-secret
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { startRelayServer } = require('../electron/mesh/relay-server');

const CLIENT = path.resolve(__dirname, '..');
const SERVER = (process.env.MESH_CLOUD_SERVER || 'http://127.0.0.1:18000').replace(/\/+$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SERVER)) {
  console.error('只在本机的测试服务端上跑（会注册测试账号）：MESH_CLOUD_SERVER=http://127.0.0.1:<端口>');
  process.exit(2);
}
const RELAY_PORT = Number(process.env.MESH_HIRE_RELAY_PORT) || 18790;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mesh-hire-'));
const results = [];
const procs = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? `\n      ${detail}` : ''}`);
}
function freePort() {
  return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
async function freePair() {
  for (;;) { const p = await freePort(); if (p < 65000 && await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p + 1, '127.0.0.1', () => s.close(() => r(true))); })) return p; }
}
function req(url, method = 'GET', { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => { const text = Buffer.concat(parts).toString(); let json = null; try { json = JSON.parse(text); } catch { /* 纯文本 */ } resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
    r.setTimeout(120000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, step = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* 还没好 */ } await sleep(step); }
  return null;
}
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function writeFakeClaude(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.0.0 (Claude Code, mesh hire demo)'); process.exit(0); }
const text = '出租方收到：' + args[args.length - 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 's1', cwd: process.cwd() });
out({ type: 'assistant', session_id: 's1', message: { role: 'assistant', content: [{ type: 'text', text }] } });
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1' });
`);
  fs.chmodSync(file, 0o755);
}

async function account(tag) {
  const email = `hire-${tag}-${crypto.randomBytes(4).toString('hex')}@example.test`;
  await req(`${SERVER}/user/register`, 'POST', { body: { email, password: 'pw-123456', nickname: `${tag}${crypto.randomBytes(2).toString('hex')}` } });
  const r = await req(`${SERVER}/user/login`, 'POST', { body: { email, password: 'pw-123456' } });
  const jwt = r.json?.token;
  const profile = (await req(`${SERVER}/user/profile`, 'GET', { headers: { authorization: `Bearer ${jwt}` } })).json || {};
  return { jwt, profile };
}
const balance = async (a) => Number((await req(`${SERVER}/user/profile`, 'GET', { headers: { authorization: `Bearer ${a.jwt}` } })).json?.credits_balance);

function device({ label, home, port, jwt, name, agentCfg = {}, extraPath }) {
  writeJson(path.join(home, '.llm-agent', 'local-config.json'), { user_session: { jwt }, scene_routes: [], local_keys: [], cloud_config: { url: SERVER, token: jwt } });
  writeJson(path.join(home, '.llm-agent', 'config.json'), { name, providers: [], ...agentCfg });
  writeJson(path.join(home, '.tokenbank', 'mesh', 'config.json'), { enabled: true, lan_discovery: false, port: 0, presence_ms: 2000, cloud_sync_ms: 3000 });
  const log = fs.openSync(path.join(ROOT, `${label}.log`), 'a');
  const p = spawn(process.execPath, [path.join(CLIENT, 'cli', 'gateway.js'), 'start', '--port', String(port), '--admin-port', String(port + 1)], {
    cwd: CLIENT,
    env: { ...process.env, HOME: home, TOKENBANK_CLI: '1', TOKEN_SERVER_URL: SERVER, ...(extraPath ? { PATH: `${extraPath}:${process.env.PATH}` } : {}) },
    stdio: ['ignore', log, log],
  });
  procs.push(p);
  return { label, home, port, meshConfig: () => readJson(path.join(home, '.tokenbank', 'mesh', 'config.json')) || {} };
}
const agentKey = (d) => readJson(path.join(d.home, '.llm-agent', 'local-config.json'))?.agent_api_key || '';
const logOf = (d) => { try { return fs.readFileSync(path.join(ROOT, `${d.label}.log`), 'utf8'); } catch { return ''; } };

function startMcp(dev) {
  const p = spawn(process.execPath, [path.join(CLIENT, 'electron', 'tokenbank-mcp-stdio.js')], { cwd: CLIENT, env: { ...process.env, HOME: dev.home }, stdio: ['pipe', 'pipe', 'ignore'] });
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
  const rpc = (method, params = {}) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const call = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { text: (r.result?.content || []).map((c) => c.text).join('\n'), isError: !!r.result?.isError }; };
  return { rpc, call, stop: () => p.kill() };
}

function cleanup() { for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* 已退出 */ } } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

(async () => {
  console.log(`服务端：${SERVER}\n临时目录：${ROOT}\n`);
  if ((await req(`${SERVER}/docs`)).status !== 200) { console.error('连不上服务端'); process.exit(2); }

  const standalone = process.env.MESH_HIRE_RELAY === 'standalone';
  const dump = standalone ? path.join(ROOT, 'official-relay.dump') : (process.env.MESH_RELAY_DUMP || '');
  if (dump && !standalone) { try { fs.writeFileSync(dump, ''); } catch { /* 服务端会建 */ } }
  const relay = standalone ? await startRelayServer({
    port: RELAY_PORT, host: '127.0.0.1', dumpFile: dump, log: () => {},
    revocationsUrl: `${SERVER}/mesh/revoked-endpoints`, accessToken: process.env.MESH_RELAY_ACCESS_TOKEN || 'relay-secret',
  }) : null;
  if (relay) await until(() => relay.hub.opts.issuerKeys().length, 10000, 200);
  const RELAY_URL = standalone ? `ws://127.0.0.1:${RELAY_PORT}/mesh/ws` : `${SERVER.replace(/^http/, 'ws')}/mesh/ws`;

  console.log('[1] 两个账号各一台设备入网，出租方开着出租');
  const H = await account('hirer');
  const W = await account('owner');
  const binR = path.join(ROOT, 'binR');
  writeFakeClaude(binR);
  const [pa, pr] = [await freePair(), await freePair()];
  const R = device({
    label: 'R', home: path.join(ROOT, 'homeR'), port: pr, jwt: W.jwt, name: 'rentbox', extraPath: binR,
    agentCfg: { worker_key: W.profile.worker_key, server_url: `${SERVER.replace(/^http/, 'ws')}/ws/worker`, auto_start: true, contribute_assistants: [{ id: 'app:claude-code' }] },
  });
  const A = device({ label: 'A', home: path.join(ROOT, 'homeA'), port: pa, jwt: H.jwt, name: 'laptop' });
  const certs = await until(() => A.meshConfig().cert && R.meshConfig().cert, 60000);
  check('两台都领到设备证书（各自账号的第一台）', !!certs);
  check(standalone ? '独立中继地址随证书下发' : '没配任何中继，证书里带着服务端内置中继的地址', (A.meshConfig().relay_urls || []).includes(RELAY_URL), JSON.stringify(A.meshConfig().relay_urls));
  const capOn = await until(() => /register caps=agents,mesh_hire/.test(logOf(R)), 60000);
  check('出租方上报「能接设备通道的雇佣」', !!capOn, (logOf(R).match(/\[agent\] register caps=[^\n]*/g) || []).pop());
  const bal0 = [await balance(H), await balance(W)];

  console.log('\n[2] 雇佣走设备通道');
  const mcp = startMcp(A);
  await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mesh-hire-demo', version: '1' } });
  const secret = `SECRET-HIRE-${Date.now()}`;
  const hired = await mcp.call('tb_hire_community_agent', { assistant_id: 'app:claude-code', owner: W.profile.nickname, prompt: `${secret} 看一下` });
  check('A 雇 R 的 Claude Code，拿到结果', !hired.isError && hired.text.includes(`出租方收到：${secret}`), hired.text.slice(0, 160));
  const tid = (logOf(R).match(/接到雇佣 (at-[0-9a-f]+)（app:claude-code，经设备通道）/) || [])[1];
  check('出租方是经设备通道接到的（不是 /ws/worker）', !!tid, tid);
  if (dump) {
    const seen = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '';
    check('官方中继只看到密文：转发记录里没有提示词和结果', seen.length > 0 && !seen.includes(secret) && !seen.includes('出租方收到'), `转发记录 ${seen.length} 字节`);
  } else console.log('  · 没设 MESH_RELAY_DUMP，跳过「中继只看到密文」');
  const st = await req(`${SERVER}/mesh/hire/${tid}`, 'GET', { headers: { authorization: `Bearer ${H.jwt}` } });
  check('云端记账：这一单已结算', st.json?.status === 'completed', JSON.stringify(st.json));
  const bal1 = [await balance(H), await balance(W)];
  check('雇佣方扣 5 分，出租方得 5 分', bal1[0] === bal0[0] - 5 && bal1[1] === bal0[1] + 5, `雇佣方 ${bal0[0]} → ${bal1[0]}，出租方 ${bal0[1]} → ${bal1[1]}`);
  const forged = await req(`${SERVER}/mesh/hire/${tid}/settle`, 'POST', { body: { status: 'completed', sig: 'AAAA' } });
  check('没有出租方设备密钥，结算不了', forged.status === 403);

  console.log('\n[2b] 雇佣方取消：退款；出租方之后再来结算，不给分');
  const rDev = JSON.parse(Buffer.from(R.meshConfig().cert.split('.')[1], 'base64url')).device_id;
  const aDev = JSON.parse(Buffer.from(A.meshConfig().cert.split('.')[1], 'base64url')).device_id;
  const tk = await req(`${SERVER}/mesh/hire/ticket`, 'POST', { headers: { authorization: `Bearer ${H.jwt}` }, body: { assistant_id: 'app:claude-code', caller_device_id: aDev, owner: W.profile.nickname } });
  check('领到雇佣票，票上写着出租方的设备', tk.status === 200 && tk.json?.worker?.device_id === rDev && !!tk.json?.ticket, `任务 ${tk.json?.task_id}`);
  const balT = [await balance(H), await balance(W)];
  const cancel = await req(`${SERVER}/mesh/hire/${tk.json?.task_id}/cancel`, 'POST', { headers: { authorization: `Bearer ${H.jwt}` } });
  const balC = [await balance(H), await balance(W)];
  check('取消后退回 5 分', cancel.json?.status === 'cancelled' && balC[0] === balT[0] + 5, `雇佣方 ${balT[0]} → ${balC[0]}`);
  const keys = require('../electron/mesh/keys');
  const identity = require('../electron/mesh/identity');
  const rKey = keys.deviceKey(identity.loadOrCreateDeviceSecret(path.join(R.home, '.tokenbank', 'mesh')));
  const late = await req(`${SERVER}/mesh/hire/${tk.json?.task_id}/settle`, 'POST', { body: { status: 'completed', sig: keys.sign(rKey.privateKey, `tb-hire-settle|${tk.json?.task_id}|completed`) } });
  check('出租方之后来结算：告诉它已取消，不给分', late.json?.status === 'cancelled' && (await balance(W)) === balC[1], JSON.stringify(late.json));
  const own = await req(`${SERVER}/mesh/hire/ticket`, 'POST', { headers: { authorization: `Bearer ${W.jwt}` }, body: { assistant_id: 'app:claude-code', caller_device_id: rDev } });
  check('雇自己的设备：不给票（走「我的设备」）', own.status === 409, JSON.stringify(own.json?.detail));

  console.log('\n[3] 出租方关掉设备网络：照旧走云端转发');
  const off = await req(`http://127.0.0.1:${R.port}/v1/devices/self/settings`, 'PUT', { headers: { authorization: `Bearer ${agentKey(R)}` }, body: { enabled: false } });
  const capOff = await until(() => (logOf(R).match(/register caps=[^\n]*/g) || []).pop() === 'register caps=agents', 30000);
  check('出租方重新上报，不再接设备通道的雇佣', off.status === 200 && !!capOff);
  const before = (logOf(R).match(/接到雇佣/g) || []).length;
  const legacy = await mcp.call('tb_hire_community_agent', { assistant_id: 'app:claude-code', owner: W.profile.nickname, prompt: '走老路 看一下' });
  check('还是雇得到（经云端转发）', !legacy.isError && legacy.text.includes('出租方收到：走老路'), legacy.text.slice(0, 160));
  check('这一单没走设备通道', (logOf(R).match(/接到雇佣/g) || []).length === before);
  const bal2 = [await balance(H), await balance(W)];
  check('计费和设备通道一样', bal2[0] === bal1[0] - 5 && bal2[1] === bal1[1] + 5, `雇佣方 ${bal1[0]} → ${bal2[0]}，出租方 ${bal1[1]} → ${bal2[1]}`);
  mcp.stop();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过。日志：${ROOT}/A.log、${ROOT}/R.log`);
  cleanup();
  await relay?.close();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
