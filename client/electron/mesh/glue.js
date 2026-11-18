// client/electron/mesh/glue.js
// 把设备网络接进本地网关：启动节点、生成本机描述，以及网关和智能体接口里用到的几个入口。
// 原型阶段从 ~/.tokenbank/mesh/config.json 读配置（enabled 为 true 才启动），
// 证书和对端地址先手工写进去；正式版改成登录后向云端申请证书、从地址簿取对端。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const scheduler = require('./scheduler');
const tunnel = require('./tunnel');
const workspaces = require('./workspaces');

let node = null;
let cfg = null;

function meshDir() { return path.join(os.homedir(), '.tokenbank', 'mesh'); }

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(meshDir(), 'config.json'), 'utf8')); } catch { return null; }
}

function getNode() { return node; }

// ── 本机描述 ─────────────────────────────────────────────────────────────────

async function describeSelf() {
  const out = { platform: process.platform, apps: [], assistants: [], models: [], workspaces: [], sessions: [], load: { running: 0, max: 2 } };
  try { out.version = require('../../package.json').version; } catch { out.version = ''; }
  try {
    const agents = await require('../agent-executor').listAvailableAgents();
    for (const a of agents || []) {
      if (!a || a.guardian) continue;
      if (a.type === 'cli' && a.installed) out.apps.push({ id: a.id, name: a.name || a.id });
      else if (a.type === 'assistant') out.assistants.push({ id: a.id, name: a.name || a.id });
    }
  } catch { /* 执行器不可用时只报模型 */ }
  const accepts = { agent_tasks: cfg?.accept_agent_tasks !== false, model_requests: !!cfg?.accept_model_requests };
  out.accepts = accepts;
  // 默认不把本机模型借给别的设备用，设备页打开后才上报
  if (accepts.model_requests) {
    try { out.models = require('../local-gateway').localModelNames(); } catch { out.models = []; }
  }
  if (!accepts.agent_tasks) { out.apps = []; out.assistants = []; }
  try { out.workspaces = workspaces.listPublic(meshDir()); } catch { out.workspaces = []; }
  return out;
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────

async function startFromConfig({ gatewayPort, log } = {}) {
  if (node) return node;
  cfg = readConfig();
  if (!cfg || !cfg.enabled) return null;
  const { MeshNode } = require('./node');
  node = new MeshNode({
    dir: meshDir(),
    userId: cfg.user_id,
    cert: cfg.cert,
    issuerKeys: cfg.issuer_keys || [],
    peers: cfg.peers || [],
    revoked: cfg.revoked || [],
    relayUrls: cfg.relay_urls || [],
    relayToken: cfg.relay_token,
    bindAddr: cfg.bind_addr,
    gatewayPort,
    describeSelf,
    presenceMs: cfg.presence_ms || 5000,
    log: log || ((m) => console.log(m)),
  });
  try {
    await node.start();
  } catch (e) {
    (log || console.log)(`[mesh] 启动失败：${e.message}`);
    node = null;
    return null;
  }
  return node;
}

async function stop() {
  const n = node;
  node = null;
  if (n) await n.stop();
}

// ── 网关用到的入口 ───────────────────────────────────────────────────────────

function isMeshKey(key) { return !!node && node.isMeshKey(key); }
function isMeshRequest(headers) { return !!node && node.isMeshRequest(headers || {}); }
function isHop(headers) { return !!(headers && headers['x-tb-mesh-hop']); }

/** /v1/devices */
function devicesView() {
  if (!node) return { enabled: false, devices: [] };
  const now = Date.now();
  return {
    enabled: true,
    devices: node.directory.list().map((d) => ({
      device_id: d.device_id,
      name: d.name,
      self: !!d.self,
      online: !!d.online,
      last_seen_sec_ago: d.self ? 0 : Math.round((now - (d.lastSeen || now)) / 1000),
      connection: d.path ? d.path.kind : 'unknown',
      rtt_ms: d.path && Number.isFinite(d.path.rttMs) ? d.path.rttMs : null,
      platform: d.descriptor?.platform || '',
      version: d.descriptor?.version || '',
      apps: d.descriptor?.apps || [],
      assistants: d.descriptor?.assistants || [],
      models: d.descriptor?.models || [],
      workspaces: d.descriptor?.workspaces || [],
      load: d.descriptor?.load || null,
    })),
  };
}

/** /v1/models 追加：别的设备独有的模型 */
function extraModels(existingIds) {
  if (!node) return [];
  const have = new Set(existingIds || []);
  const out = [];
  for (const d of node.directory.list()) {
    if (d.self || !d.online) continue;
    for (const m of d.descriptor?.models || []) {
      if (!have.has(m)) { have.add(m); out.push({ id: m, object: 'model', owned_by: `mine:${d.name}` }); }
      out.push({ id: `mine:${d.name}/${m}`, object: 'model', owned_by: `mine:${d.name}` });
    }
  }
  return out;
}

/** /v1/agent/harnesses 追加：mine:<应用> 和 mine:<应用>@<设备> */
function extraHarnesses() {
  if (!node) return [];
  const out = [];
  const seen = new Set();
  for (const d of node.directory.list()) {
    if (d.self || !d.online) continue;
    const items = [...(d.descriptor?.apps || []), ...(d.descriptor?.assistants || [])];
    for (const a of items) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        out.push({ id: `mine:${a.id}`, name: `${a.name}（我的设备，自动选）`, kind: 'mine' });
      }
      out.push({ id: `mine:${a.id}@${d.name}`, name: `${a.name} @ ${d.name}`, kind: 'mine', device: d.name, online: true });
    }
  }
  return out;
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * 模型请求：mine:<设备>/<模型> 钉到那台设备；普通模型名在本机没有任何供给源时，交给有这个模型的设备。
 * 首个字节之前失败就换下一台。
 * @returns {Promise<boolean>} true 表示已经处理（已写响应）
 */
async function routeChat({ model, cleanPath, body, req, res, localHasModel }) {
  if (!node || isHop(req.headers)) return false;
  const pin = scheduler.parseMineModel(model);
  if (!pin && (!model || localHasModel(model))) return false;
  const wanted = pin ? pin.model : model;
  const candidates = scheduler.pickModelDevice({ model: wanted, device: pin?.device, devices: node.directory.list() });
  if (!candidates.length) {
    if (!pin) return false;
    sendJson(res, 404, { error: { message: `${pin.device} 不在线，或没有开放模型 ${pin.model}`, type: 'mesh_no_device' } });
    return true;
  }
  const payload = Buffer.from(JSON.stringify({ ...body, model: wanted }));
  let lastErr = '';
  for (const dev of candidates) {
    try {
      const resp = await node.proxy(dev.device_id, {
        method: 'POST', path: cleanPath,
        headers: { 'content-type': 'application/json', accept: req.headers.accept || 'application/json' },
        body: payload,
      });
      if (resp.status >= 500 && dev !== candidates[candidates.length - 1]) {
        lastErr = `${dev.name}: HTTP ${resp.status}`;
        await tunnel.readAll(resp).catch(() => {});
        continue;
      }
      resp.headers['x-tb-mesh-device'] = dev.name;
      console.log(`[mesh] 模型 ${wanted} → ${dev.name}`);
      await tunnel.pipeTo(resp, res);
      return true;
    } catch (e) {
      lastErr = `${dev.name}: ${e.message}`;
    }
  }
  sendJson(res, 502, { error: { message: `我的设备都没能处理：${lastErr}`, type: 'mesh_error' } });
  return true;
}

// ── 智能体 ───────────────────────────────────────────────────────────────────

const MESH_ID = /^mesh:([^:]+):(.+)$/;

function meshTaskId(deviceId, id) { return `mesh:${deviceId}:${id}`; }
function parseMeshTaskId(id) {
  const m = String(id || '').match(MESH_ID);
  return m ? { deviceId: m[1], id: m[2] } : null;
}

function rewriteResponse(obj, deviceId, deviceName) {
  if (!obj || typeof obj !== 'object') return obj;
  if (typeof obj.id === 'string' && !obj.id.startsWith('mesh:')) obj.id = meshTaskId(deviceId, obj.id);
  if (obj.response) rewriteResponse(obj.response, deviceId, deviceName);
  if (obj.metadata && typeof obj.metadata === 'object') obj.metadata.mesh_device = deviceName;
  return obj;
}

/** SSE 逐行改写任务号 */
function sseRewriter(deviceId, deviceName) {
  let carry = '';
  const fix = (line) => {
    if (!line.startsWith('data: ')) return line;
    try { return `data: ${JSON.stringify(rewriteResponse(JSON.parse(line.slice(6)), deviceId, deviceName))}`; } catch { return line; }
  };
  const fn = (chunk) => {
    const text = carry + chunk.toString('utf8');
    const lines = text.split('\n');
    carry = lines.pop();
    return Buffer.from(lines.map(fix).map((l) => `${l}\n`).join(''));
  };
  fn.flush = () => (carry ? Buffer.from(fix(carry)) : null);
  return fn;
}

/**
 * 智能体任务：harness 是 mine: 开头时调用。
 * 选到本机返回 { local: '<本机 harness>' }，由 agent-http 照常执行；否则转到那台设备并写好响应。
 */
async function routeAgentCreate({ harnessId, body, req, res }) {
  if (!node) {
    sendJson(res, 503, { error: { message: '设备网络没有启动', type: 'mesh_disabled' } });
    return { handled: true, ok: false, error: 'mesh disabled' };
  }
  if (isHop(req.headers)) {
    sendJson(res, 409, { error: { message: '经设备网络转来的任务不能再转给设备网络', type: 'mesh_loop' } });
    return { handled: true, ok: false, error: 'mesh loop' };
  }
  const target = scheduler.parseMineHarness(harnessId);
  const meta = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
  // 续上一轮：上一轮在哪台设备，这一轮就去哪台
  const prev = parseMeshTaskId(body.previous_response_id);
  if (prev && target) {
    const d = node.directory.get(prev.deviceId);
    if (d) target.device = d.name;
  }
  const picked = scheduler.pickDevice({ target, workspace: meta.workspace, devices: node.directory.list() });
  if (!picked.device) {
    sendJson(res, 404, { error: { message: picked.reason, type: 'mesh_no_device' } });
    return { handled: true, ok: false, error: picked.reason };
  }
  if (picked.device.self) return { handled: false, local: target.id };

  const dev = picked.device;
  const forward = { ...body, metadata: { ...meta, harness_id: target.id } };
  if (prev) forward.previous_response_id = prev.id;
  const headers = { 'content-type': 'application/json' };
  if (req.headers['idempotency-key']) headers['idempotency-key'] = req.headers['idempotency-key'];
  try {
    const resp = await node.proxy(dev.device_id, {
      method: 'POST', path: '/v1/agent/responses', headers, body: Buffer.from(JSON.stringify(forward)),
    });
    console.log(`[mesh] 智能体 ${target.id} → ${dev.name}`);
    if (body.stream && !body.background && String(resp.headers['content-type'] || '').includes('event-stream')) {
      await tunnel.pipeTo(resp, res, sseRewriter(dev.device_id, dev.name));
      return { handled: true, ok: true };
    }
    const text = (await tunnel.readAll(resp)).toString('utf8');
    let obj;
    try { obj = JSON.parse(text); } catch { obj = null; }
    if (!obj) { res.writeHead(resp.status, { 'Content-Type': 'application/json' }); res.end(text); return { handled: true, ok: resp.status < 400 }; }
    sendJson(res, resp.status, rewriteResponse(obj, dev.device_id, dev.name));
    return { handled: true, ok: resp.status < 400, error: obj.error?.message };
  } catch (e) {
    sendJson(res, e.status || 502, { error: { message: `${dev.name}：${e.message}`, type: 'mesh_error' } });
    return { handled: true, ok: false, error: e.message };
  }
}

/** GET /v1/agent/responses/mesh:<设备>:<任务号>（以及 /cancel）转到那台设备 */
async function routeAgentById({ id, op, res }) {
  const parsed = parseMeshTaskId(id);
  if (!parsed) return false;
  if (!node) { sendJson(res, 503, { error: { message: '设备网络没有启动', type: 'mesh_disabled' } }); return true; }
  const dev = node.directory.get(parsed.deviceId);
  const p = `/v1/agent/responses/${encodeURIComponent(parsed.id)}${op === 'cancel' ? '/cancel' : ''}`;
  try {
    const resp = await node.proxy(parsed.deviceId, { method: op === 'cancel' ? 'POST' : 'GET', path: p, headers: {} });
    const text = (await tunnel.readAll(resp)).toString('utf8');
    let obj;
    try { obj = JSON.parse(text); } catch { obj = null; }
    if (!obj) { res.writeHead(resp.status, { 'Content-Type': 'application/json' }); res.end(text); return true; }
    sendJson(res, resp.status, rewriteResponse(obj, parsed.deviceId, dev?.name || parsed.deviceId));
  } catch (e) {
    // 那台设备暂时连不上：结果还在它那里，稍后再查
    sendJson(res, 503, { id, object: 'response', status: 'unreachable', error: { message: `${dev?.name || parsed.deviceId}：${e.message}`, type: 'mesh_unreachable' } });
  }
  return true;
}

/** 隧道转来的任务：metadata.workspace → 本机路径；都没给时用默认工作区 */
function resolveWorkspace(name) {
  return workspaces.resolve(meshDir(), name);
}

module.exports = {
  startFromConfig, stop, getNode,
  isMeshKey, isMeshRequest, isHop,
  devicesView, extraModels, extraHarnesses,
  routeChat, routeAgentCreate, routeAgentById, resolveWorkspace,
  _internal: { sseRewriter, rewriteResponse, parseMeshTaskId, describeSelf },
};
