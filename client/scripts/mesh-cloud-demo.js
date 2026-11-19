#!/usr/bin/env node
// 设备网络 · 云端模式演示：不手写证书、不写对端地址、关掉局域网发现，
// 两台设备只靠云端（server/mesh_router.py）领证书、查地址簿找到彼此，删除设备后连接被拒，退出登录后停。
//
// 要一个本机跑着的 TokenBank 服务端（会在上面注册两个测试账号，所以只允许 127.0.0.1 / localhost）：
//   MESH_CLOUD_SERVER=http://127.0.0.1:18000 node scripts/mesh-cloud-demo.js
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CLIENT = path.resolve(__dirname, '..');
const SERVER = (process.env.MESH_CLOUD_SERVER || 'http://127.0.0.1:18000').replace(/\/+$/, '');
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SERVER)) {
  console.error('只在本机的测试服务端上跑（会注册测试账号）：MESH_CLOUD_SERVER=http://127.0.0.1:<端口>');
  process.exit(2);
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mesh-cloud-'));
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
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers }, timeout: 120000 }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(buf); } catch { /* 不是 JSON */ } resolve({ status: res.statusCode, json, text: buf }); });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 30000, step = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}
function writeJson(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function writeFakeClaude(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'claude');
  fs.writeFileSync(file, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.0.0 (Claude Code, mesh cloud demo)'); process.exit(0); }
const text = '设备 B 收到：' + args[args.length - 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'system', subtype: 'init', session_id: 's1', cwd: process.cwd() });
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1' });
`);
  fs.chmodSync(file, 0o755);
}

async function account() {
  const email = `mesh-${crypto.randomBytes(4).toString('hex')}@example.test`;
  await req(`${SERVER}/user/register`, 'POST', { body: { email, password: 'pw-123456' } });
  const r = await req(`${SERVER}/user/login`, 'POST', { body: { email, password: 'pw-123456' } });
  return r.json?.token;
}

function device({ label, home, port, jwt, name, extraPath }) {
  writeJson(path.join(home, '.llm-agent', 'local-config.json'), { user_session: { jwt }, scene_routes: [], local_keys: [] });
  writeJson(path.join(home, '.llm-agent', 'config.json'), { name, providers: [] });
  // 只开设备网络：不写证书、不写对端，局域网发现关掉，同步快一点
  writeJson(path.join(home, '.tokenbank', 'mesh', 'config.json'), { enabled: true, lan_discovery: false, port: 0, presence_ms: 2000, cloud_sync_ms: 3000 });
  const log = fs.openSync(path.join(ROOT, `${label}.log`), 'a');
  const p = spawn(process.execPath, [path.join(CLIENT, 'cli', 'gateway.js'), 'start', '--port', String(port), '--admin-port', String(port + 1)], {
    cwd: CLIENT,
    env: { ...process.env, HOME: home, TOKENBANK_CLI: '1', TOKEN_SERVER_URL: SERVER, ...(extraPath ? { PATH: `${extraPath}:${process.env.PATH}` } : {}) },
    stdio: ['ignore', log, log],
  });
  procs.push(p);
  return { label, home, port, jwt, name, proc: p, meshConfig: () => readJson(path.join(home, '.tokenbank', 'mesh', 'config.json')) || {} };
}
const agentKey = (d) => readJson(path.join(d.home, '.llm-agent', 'local-config.json'))?.agent_api_key || '';
const logOf = (d) => { try { return fs.readFileSync(path.join(ROOT, `${d.label}.log`), 'utf8'); } catch { return ''; } };
const devicesOf = async (d) => (await req(`http://127.0.0.1:${d.port}/v1/devices`, 'GET', { headers: { authorization: `Bearer ${agentKey(d)}` } })).json || {};

function cleanup() { for (const p of procs) { try { p.kill('SIGTERM'); } catch { /* 已退出 */ } } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

(async () => {
  console.log(`服务端：${SERVER}\n临时目录：${ROOT}\n`);
  const health = await req(`${SERVER}/docs`);
  if (health.status !== 200) { console.error('连不上服务端'); process.exit(2); }

  console.log('[1] 登录后自动领证书');
  const jwt = await account();
  const [pa, pb] = [await freePair(), await freePair()];
  const binB = path.join(ROOT, 'binB');
  writeFakeClaude(binB);
  const A = device({ label: 'A', home: path.join(ROOT, 'homeA'), port: pa, jwt, name: 'laptop' });
  const B = device({ label: 'B', home: path.join(ROOT, 'homeB'), port: pb, jwt, name: 'studio', extraPath: binB });
  const certs = await until(() => A.meshConfig().cert && B.meshConfig().cert, 60000);
  check('两台都从云端领到了设备证书（没手写）', !!certs && A.meshConfig().cloud === true && B.meshConfig().cloud === true,
    `A user_id=${A.meshConfig().user_id} issuer=${(A.meshConfig().issuer_keys || []).map((k) => k.kid).join(',')}`);

  console.log('\n[2] 地址簿：关掉局域网发现，只靠云端找到对方');
  const peers = await until(async () => {
    const r = await req(`${SERVER}/mesh/peers`, 'GET', { headers: { authorization: `Bearer ${jwt}` } });
    const list = r.json?.peers || [];
    return list.length >= 2 && list.every((p) => p.direct_addrs.length) ? list : null;
  }, 30000);
  check('云端地址簿里有两台，都报了直连地址', !!peers, (peers || []).map((p) => `${p.name}: ${p.direct_addrs.slice(0, 2).join(',')}`).join(' | '));
  const bOnA = await until(async () => (await devicesOf(A)).data?.find((d) => !d.self && d.online), 40000);
  check('A 看到 B 在线（没配对端地址，局域网发现关着）', !!bOnA && !/局域网发现/.test(logOf(A) + logOf(B)), bOnA ? `${bOnA.label} 连接方式=${bOnA.connection}` : '');

  // 云端回拨：只验证公网地址；本机测试里两台都只有内网地址，所以都不算「验证过」，自动模式下不给别人当中继
  const viewA = await devicesOf(A);
  const bRelay = viewA.data?.find((d) => !d.self)?.relay;
  check('云端回拨不验证内网地址：两台都没被标成可用中继（自动模式）', viewA.relay?.active === false && bRelay && bRelay.verified === false && bRelay.enabled === false,
    `A 本机中继=${JSON.stringify(viewA.relay)}  B=${JSON.stringify(bRelay)}`);

  console.log('\n[3] 派活');
  const run = await req(`http://127.0.0.1:${A.port}/v1/agent/responses`, 'POST', {
    headers: { authorization: `Bearer ${agentKey(A)}` },
    body: { input: '云端模式派活', metadata: { harness_id: 'mine:claude-code@studio' } },
  });
  const text = run.json?.output?.[0]?.content?.[0]?.text || '';
  check('A 派给 studio 的任务在 B 上完成', run.status === 200 && text.includes('设备 B 收到'), text || JSON.stringify(run.json));

  console.log('\n[4] 吊销：在云端删掉 B');
  const bId = bOnA?.device_id;
  const del = await req(`${SERVER}/device/${encodeURIComponent(bId)}`, 'DELETE', { headers: { authorization: `Bearer ${jwt}` } });
  const gone = await until(async () => !(await devicesOf(A)).data?.find((d) => d.device_id === bId && d.online), 30000);
  check('删除设备后，A 拉到吊销列表就断开 B', del.status === 200 && !!gone && /已被吊销/.test(logOf(A)), (logOf(A).match(/\[mesh\][^\n]*吊销[^\n]*/) || [''])[0]);
  const rv = await req(`${SERVER}/mesh/revoked-endpoints`, 'GET', { headers: { authorization: 'Bearer relay-secret' } });
  const rvNo = await req(`${SERVER}/mesh/revoked-endpoints`);
  check('官方中继拉得到吊销列表（要中继的访问令牌）', rv.status === 200 && (rv.json?.endpoints || []).length > 0 && (rv.json?.issuer_keys || []).length > 0 && rvNo.status === 401,
    `吊销 ${(rv.json?.endpoints || []).length} 个，不带令牌 HTTP ${rvNo.status}`);
  const rejected = await until(() => /revoked/.test(logOf(A)) || /被 [0-9a-f]+ 拒绝：revoked/.test(logOf(B)), 30000);
  check('B 再连 A 时被拒（revoked）', !!rejected);

  console.log('\n[5] 退出登录');
  const out = await req(`http://127.0.0.1:${A.port + 1}/api/user-session`, 'DELETE');
  const stopped = await until(async () => (await devicesOf(A)).enabled === false, 15000);
  check('A 退出登录后设备网络停止', out.status === 200 && !!stopped, (logOf(A).match(/\[mesh\] 已退出登录[^\n]*/) || [''])[0]);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过。日志：${path.join(ROOT, 'A.log')}、${path.join(ROOT, 'B.log')}`);
  cleanup();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); cleanup(); process.exit(1); });
