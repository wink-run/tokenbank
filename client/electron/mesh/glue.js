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
const { normalizeAliases, deviceLabel } = require('./directory');
const { MeshCloud, needsCert } = require('./cloud');

let node = null;
let cfg = null;

function meshDir() { return path.join(os.homedir(), '.tokenbank', 'mesh'); }

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(meshDir(), 'config.json'), 'utf8')); } catch { return null; }
}

function getNode() { return node; }

// ── 本机描述 ─────────────────────────────────────────────────────────────────

/** 同时接几个其他设备派来的任务（max_tasks，默认 2，1–16） */
function maxTasks() {
  const n = Number(readConfig()?.max_tasks);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : 2;
}

/** 本机负载：正在跑的智能体任务（不含派到别的设备的镜像） */
function selfLoad() {
  let running = 0;
  try {
    for (const id of require('../agent-executor').runningTasks.keys()) if (!String(id).startsWith('mesh:')) running += 1;
  } catch { running = 0; }
  return { running, max: maxTasks() };
}

async function describeSelf() {
  const out = { platform: process.platform, apps: [], assistants: [], externals: [], models: [], workspaces: [], sessions: [], load: selfLoad() };
  try { out.version = require('../../package.json').version; } catch { out.version = ''; }
  try {
    const agents = await require('../agent-executor').listAvailableAgents();
    for (const a of agents || []) {
      if (!a || a.guardian) continue;
      if (a.type === 'cli' && a.installed) out.apps.push({ id: a.id, name: a.name || a.id });
      else if (a.type === 'assistant') out.assistants.push({ id: a.id, name: a.name || a.id });
      // 外部智能体接在这台设备的网关上：别的设备派给它也要经这台
      else if (a.type === 'external' || String(a.id || '').startsWith('external:')) out.externals.push({ id: a.id, name: a.name || a.id });
    }
  } catch { /* 执行器不可用时只报模型 */ }
  const accepts = { agent_tasks: cfg?.accept_agent_tasks !== false, model_requests: !!cfg?.accept_model_requests };
  out.accepts = accepts;
  // 默认不把本机模型借给别的设备用，设备页打开后才上报
  if (accepts.model_requests) {
    try { out.models = require('../local-gateway').localModelNames(); } catch { out.models = []; }
    try { out.providers = require('../local-gateway').localProviderSummary(); } catch { out.providers = []; }
  }
  if (!accepts.agent_tasks) { out.apps = []; out.assistants = []; out.externals = []; }
  try { out.workspaces = workspaces.listPublic(meshDir()); } catch { out.workspaces = []; }
  // 设备名称：和交易页「设备名称」同一个字段（~/.llm-agent/config.json 的 name）。派活时 @名称 就认它
  out.aliases = [];
  try {
    const name = String(require('../../shared/config-loader').readAgentConfig()?.name || '').trim();
    if (name) out.aliases = normalizeAliases([name]);
  } catch { /* 名称不合规（有空格等）时只显示，不能用来 @ */ }
  return out;
}

// ── 生命周期 ─────────────────────────────────────────────────────────────────

const saved = { gatewayPort: null, log: null };
let cloud = null;            // MeshCloud：登录后才有
let cloudTimer = null;
const cloudState = { lastSync: 0, error: '', peers: 0, awaitingApproval: false, pending: [] };
let approvalTimer = null;
const CLOUD_SYNC_MS = 60 * 1000;

function logLine(m) { (saved.log || ((x) => console.log(x)))(m); }

/** 证书内容（不校验签名，只看要不要续） */
function certClaims(cert) {
  try { return JSON.parse(Buffer.from(String(cert).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

function selfName() {
  try {
    const n = String(require('../../shared/config-loader').readAgentConfig()?.name || '').trim();
    if (n) return n;
  } catch { /* 用电脑名 */ }
  return os.hostname();
}

/**
 * 没有证书、快到期、换了账号或设备时，向云端领一张。领到返回 true。
 * 写进 ~/.tokenbank/mesh/config.json（cloud: true 表示证书来自云端，退出登录时一起停）
 */
async function ensureCloudCert() {
  if (!cloud?.ready) return false;
  const identity = require('./identity');
  const { endpointIdFromSecret } = require('./keys');
  const endpointId = endpointIdFromSecret(identity.loadOrCreateDeviceSecret(meshDir()));
  const cur = readConfig() || {};
  const claims = certClaims(cur.cert);
  if (!needsCert(claims, { deviceId: cloud.deviceId, endpointId })) return false;
  const r = await cloud.requestCert({ endpointId, name: selfName() });
  const switchedUser = !!claims && String(claims.sub) !== String(r.user_id);
  const next = {
    ...cur,
    cloud: true,
    cert: r.cert,
    user_id: String(r.user_id),
    issuer_keys: r.issuer_keys || [],
    relay_urls: (r.relay_urls && r.relay_urls.length) ? r.relay_urls : (cur.relay_urls || []),
  };
  delete next.relay_token;
  // 云端地址簿取代手写的对端；局域网发现照常
  if (switchedUser) next.peers = [];
  writeConfig(next);
  logLine(`[mesh] 已领到设备证书（${new Date(r.expires_at * 1000).toLocaleDateString()} 到期）`);
  if (node) {
    if (switchedUser) { await stop(); await startFromConfig({}); } else node.updateCert(r.cert, r.issuer_keys);
  }
  return true;
}

/** 每分钟：续证书、报地址、拉吊销列表和地址簿 */
async function cloudSync() {
  if (!node || !cloud?.ready) return;
  try {
    await ensureCloudCert();
    if (!node) return;
    const a = node.addrInfo();
    // 云端回拨验证：从外面真的连得到的地址，才能自动当中继
    const pub = await cloud.publishAddress({ endpointId: a.endpoint_id, relayUrl: a.relay_url, directAddrs: a.direct_addrs });
    node.setVerified(pub?.verified || [], pub?.observed_ip || '');
    // 按密钥吊销：同一台设备重装后换了密钥，旧密钥作废，新的照常
    const revoked = await cloud.revocations();
    node.setRevoked(revoked.map((r) => r.endpoint_id));
    try { cloudState.pending = await cloud.pending(); } catch { /* 老服务端没有这个接口 */ }
    const peers = await cloud.peers();
    let n = 0;
    for (const p of peers) {
      if (!p.endpoint_id || p.endpoint_id === a.endpoint_id) continue;
      node.ensurePeer({ endpoint_id: p.endpoint_id, relay_url: p.relay_url, direct_addrs: p.direct_addrs || [], name: p.name }, 'cloud');
      n += 1;
    }
    Object.assign(cloudState, { lastSync: Date.now(), error: '', peers: n });
    try { require('../agent-worker').refreshMeshHireCap(); } catch { /* 没开出租 */ }
  } catch (e) {
    cloudState.error = e.message;
    logLine(`[mesh] 和云端同步失败：${e.message}`);
  }
}

function scheduleApprovalRetry() {
  if (approvalTimer) return;
  const ms = Number(readConfig()?.cloud_sync_ms);
  approvalTimer = setTimeout(async () => {
    approvalTimer = null;
    if (!node && cloud?.ready) {
      await startFromConfig({});
      if (node) { cloudState.awaitingApproval = false; stopCloudSync(); startCloudSync(); }
    }
  }, Number.isFinite(ms) && ms >= 1000 ? ms : 15000);
  approvalTimer.unref?.();
}

// ── 雇佣走设备通道 ─────────────────────────────────────────────────────────

/** 本机能不能接设备通道来的雇佣：设备网络开着、连着官方中继、登录了 */
function canServeHires() {
  return !!(node && node.official && !node.official.closed && cloud?.ready);
}

/** 出租方：雇佣票核对过的一单交给原来的出租逻辑；做完先结算再交结果 */
function attachHireHandlers(n) {
  n.hire.on('task', ({ claims, task, send }) => {
    const worker = require('../agent-worker');
    const { sign } = require('./keys');
    const settle = async (status, durationMs) => {
      if (!cloud?.ready) return null;
      const sig = sign(n.key.privateKey, `tb-hire-settle|${claims.tid}|${status}`);
      return cloud.settleHire(claims.tid, { status, sig, durationMs });
    };
    logLine(`[mesh] 接到雇佣 ${claims.tid}（${claims.aid}，经设备通道）`);
    worker.runHiredTask({ task, send, settle }).catch((e) => {
      logLine(`[mesh] 雇佣 ${claims.tid} 出错：${e.message}`);
      send({ type: 'agent_task_result', status: 'failed', error: e.message });
    });
  });
  n.hire.on('cancel', (tid) => { require('../agent-worker').cancelAgentTask(tid).catch(() => {}); });
}

/**
 * 雇佣方：领票 → 凭票经官方中继把任务交给出租方设备（端到端加密）→ 收结果。
 * 出租方没开设备网络、连不上时抛 code=mesh_unavailable（已退款），调用方照旧走云端转发。
 */
async function hireViaMesh({ assistantId, prompt, owner, workerId, timeoutMs, images, files, sessionKey, onProgress } = {}) {
  const unavailable = (msg) => Object.assign(new Error(msg), { code: 'mesh_unavailable' });
  if (!node || !cloud?.ready) throw unavailable('设备网络没开');
  if (!node.official) await node._ensureOfficial();
  if (!node.official) throw unavailable('连不上官方中继');
  let t;
  try {
    t = await cloud.hireTicket({ assistantId, owner, workerId, timeoutMs, sessionKey });
  } catch (e) {
    if (e.code === 'mesh_unavailable') throw unavailable(e.message);
    throw e;
  }
  let gotAny = false;
  const artifacts = [];
  let manifest = null;
  try {
    const r = await node.hire.run({
      ticket: t.ticket,
      task: { prompt, images, files, timeout_ms: timeoutMs },
      onEvent: (m) => {
        gotAny = true;
        if (m.type === 'agent_task_progress') { try { onProgress?.(m); } catch { /* 回调出错不影响任务 */ } }
        if (m.type === 'agent_task_output_manifest') manifest = m;
        if (m.type === 'agent_task_artifacts') artifacts.push(...(m.artifacts || []));
      },
    });
    const saved = checkHiredArtifacts(artifacts);
    return {
      ok: r.status === 'completed',
      task_id: t.task_id,
      status: r.status,
      output: String(r.output || ''),
      error: r.error || undefined,
      usage: r.usage || {},
      credits_charged: r.status === 'completed' ? t.credits_charged : 0,
      call_context: t.call_context,
      ...(saved.length ? { artifacts: saved } : {}),
      ...(manifest?.missing?.length ? { missing_artifacts: manifest.missing } : {}),
      via: 'mesh',
    };
  } catch (e) {
    // 没收到对方任何消息就失败：退款，交给调用方走老路
    if (!gotAny || e.code === 'timeout') {
      try { await cloud.cancelHire(t.task_id); } catch { /* 到期也会退 */ }
    }
    if (!gotAny && e.code === 'unreachable') throw unavailable(e.message);
    throw e;
  }
}

/** 出租方交来的产出文件：核对 sha256，按和云端转发一样的形状（dataUrl）交给调用方 */
function checkHiredArtifacts(list) {
  const out = [];
  for (const a of list || []) {
    const raw = String(a?.dataUrl || '');
    const comma = raw.indexOf(',');
    if (!raw.startsWith('data:') || comma < 0) continue;
    const buf = Buffer.from(raw.slice(comma + 1), 'base64');
    const sha = require('crypto').createHash('sha256').update(buf).digest('hex');
    if (a.sha256 && a.sha256 !== sha) continue;
    out.push({ name: path.basename(String(a.name || 'file')), mime: a.mime || undefined, size: buf.length, sha256: sha, dataUrl: raw });
  }
  return out;
}

/** 等批准的新设备（本机已入网时才有） */
function pendingDevices() {
  return node && cloud?.ready ? (cloudState.pending || []) : [];
}

/** 批准 / 拒绝新设备：本机用设备密钥签名，云端核对后才放行 */
async function decidePending(deviceId, approve) {
  if (!node || !cloud?.ready) throw Object.assign(new Error('本机还没入网，不能批准别的设备'), { status: 409 });
  const list = await cloud.pending();
  const p = list.find((x) => String(x.device_id) === String(deviceId));
  if (!p) throw Object.assign(new Error('没有这台等批准的设备'), { status: 404 });
  const { sign } = require('./keys');
  const sig = sign(node.key.privateKey, `tb-mesh-approve|${p.device_id}|${p.endpoint_id}|${approve ? 'approve' : 'reject'}`);
  await cloud.decide({ deviceId: p.device_id, approve, sig });
  logLine(`[mesh] ${approve ? '已批准' : '已拒绝'}新设备 ${p.name || p.device_id}`);
  cloudState.pending = await cloud.pending().catch(() => []);
  return { ok: true, pending: cloudState.pending };
}

function startCloudSync() {
  if (cloudTimer || !cloud?.ready) return;
  cloudSync();
  const ms = Number(readConfig()?.cloud_sync_ms);
  cloudTimer = setInterval(cloudSync, Number.isFinite(ms) && ms >= 1000 ? ms : CLOUD_SYNC_MS);
  cloudTimer.unref?.();
}

function stopCloudSync() {
  if (cloudTimer) clearInterval(cloudTimer);
  cloudTimer = null;
}

/**
 * 登录状态变了：{ serverUrl, token, deviceId }，退出登录传 null。
 * 登录后自动领证书、入网；退出登录时证书来自云端的节点一起停（手写配置的开发节点不动）。
 */
async function setCloud(ctx) {
  if (!ctx || !ctx.token || !ctx.serverUrl || !ctx.deviceId) {
    const had = !!cloud;
    cloud = null;
    if (approvalTimer) { clearTimeout(approvalTimer); approvalTimer = null; }
    Object.assign(cloudState, { awaitingApproval: false, pending: [] });
    if (node) node.opts.cloud = false;
    stopCloudSync();
    if (had && node && readConfig()?.cloud) {
      logLine('[mesh] 已退出登录，设备网络停止');
      await stop();
    }
    return;
  }
  if (cloud && cloud.token === ctx.token && cloud.deviceId === ctx.deviceId && cloud.serverUrl === String(ctx.serverUrl).replace(/\/+$/, '')) return;
  cloud = new MeshCloud(ctx);
  if (node) node.opts.cloud = true;
  if (!node) await startFromConfig({});
  if (node) { stopCloudSync(); startCloudSync(); }
}

async function startFromConfig({ gatewayPort, log } = {}) {
  if (gatewayPort) saved.gatewayPort = gatewayPort;
  if (log) saved.log = log;
  if (node) return node;
  // 网关还没起来：等它起来时再来
  if (!saved.gatewayPort) return null;
  cfg = readConfig();
  if (!cfg || !cfg.enabled) return null;
  if (cloud?.ready) {
    try {
      await ensureCloudCert();
      cloudState.awaitingApproval = false;
    } catch (e) {
      if (e.code === 'approval_pending') {
        // 新设备：等一台已入网的设备批准，批准后自动入网
        if (!cloudState.awaitingApproval) logLine('[mesh] 新设备，等我已入网的设备批准');
        cloudState.awaitingApproval = true;
        scheduleApprovalRetry();
        return null;
      }
      logLine(`[mesh] 领设备证书失败：${e.message}`);
    }
    cfg = readConfig();
  }
  if (!cfg.cert) {
    logLine('[mesh] 还没有设备证书：登录后自动领取');
    return null;
  }
  const { MeshNode } = require('./node');
  node = new MeshNode({
    dir: meshDir(),
    userId: cfg.user_id,
    cert: cfg.cert,
    issuerKeys: cfg.issuer_keys || [],
    peers: cfg.peers || [],
    revoked: cfg.revoked || [],
    relayUrls: cfg.relay_urls || [],
    // 入口：默认 [::]:41750；listen: false 表示不开入口、只走中继
    listen: cfg.listen === false ? false : (cfg.listen || '::'),
    port: Number.isInteger(cfg.port) ? cfg.port : 41750,
    publicAddr: cfg.public_addr || undefined,
    relay: { mode: cfg.relay_mode || 'auto', pref: cfg.relay_pref || 'auto', prefAt: Number(cfg.relay_pref_at) || 0 },
    cloud: !!cloud?.ready,
    relayDumpFile: cfg.relay_dump || undefined,
    gatewayPort: saved.gatewayPort,
    describeSelf,
    presenceMs: cfg.presence_ms || 5000,
    lanDiscovery: cfg.lan_discovery !== false,
    lanPort: cfg.lan_port,
    log: logLine,
  });
  try {
    await node.start();
  } catch (e) {
    logLine(`[mesh] 启动失败：${e.message}`);
    node = null;
    return null;
  }
  attachHireHandlers(node);
  // 接着跟上次没做完的远端任务
  try { require('../agent-executor').resumeMeshTasks(); } catch { /* 执行器没就绪 */ }
  if (cloud?.ready) startCloudSync();
  // 连上官方中继后，出租时告诉云端「本机能接设备通道的雇佣」
  const t = setTimeout(() => { try { require('../agent-worker').refreshMeshHireCap(); } catch { /* 没开出租 */ } }, 3000);
  t.unref?.();
  return node;
}

async function stop() {
  stopCloudSync();
  setTimeout(() => { try { require('../agent-worker').refreshMeshHireCap(); } catch { /* 没开出租 */ } }, 0).unref?.();
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
    relay: node.relayInfo(),
    devices: node.directory.list().map((d) => ({
      device_id: d.device_id,
      name: d.name,
      aliases: d.descriptor?.aliases || [],
      label: deviceLabel(d),
      self: !!d.self,
      online: !!d.online,
      last_seen_sec_ago: d.self ? 0 : Math.round((now - (d.lastSeen || now)) / 1000),
      // 连接方式：self / direct（addr_kind：lan、tailscale、ipv6、public）/ relay（via：经哪个中继）
      connection: d.self ? 'self' : !d.online ? 'offline' : (d.path ? d.path.kind : 'unknown'),
      addr_kind: d.path?.addr_kind || null,
      via: d.path?.kind === 'relay' ? { kind: d.path.relay_kind, device_id: d.path.relay_device, label: d.path.via } : null,
      rtt_ms: d.path && Number.isFinite(d.path.rttMs) ? d.path.rttMs : null,
      // 这台在当中继：正在替哪些设备转发（界面标「中继 · N」）
      relay: relayView(d),
      platform: d.descriptor?.platform || '',
      version: d.descriptor?.version || '',
      apps: d.descriptor?.apps || [],
      assistants: d.descriptor?.assistants || [],
      externals: d.descriptor?.externals || [],
      models: d.descriptor?.models || [],
      providers: d.descriptor?.providers || [],
      accepts: d.descriptor?.accepts || null,
      workspaces: d.descriptor?.workspaces || [],
      load: d.descriptor?.load || null,
    })),
  };
}

/** 设备描述里的中继信息，把设备号换成名字 */
function relayView(d) {
  const r = d.descriptor?.relay;
  if (!r) return null;
  const name = (id) => { const x = node.directory.get(id) || (String(id) === node.deviceId ? node.directory.list().find((y) => y.self) : null); return x ? deviceLabel(x) : id; };
  return {
    enabled: !!r.enabled,
    verified: !!r.verified,
    sessions: Number(r.sessions) || 0,
    serving: (r.serving || []).map(([a, b]) => [name(a), name(b)]),
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
      const label = deviceLabel(d);
      if (!have.has(m)) { have.add(m); out.push({ id: m, object: 'model', owned_by: `mine:${label}` }); }
      out.push({ id: `mine:${label}/${m}`, object: 'model', owned_by: `mine:${label}` });
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
    const items = [...(d.descriptor?.apps || []), ...(d.descriptor?.assistants || []), ...(d.descriptor?.externals || [])];
    for (const a of items) {
      if (!seen.has(a.id)) {
        seen.add(a.id);
        out.push({ id: `mine:${a.id}`, name: `${a.name}（我的设备，自动选）`, kind: 'mine', base: a.id });
      }
      const label = deviceLabel(d);
      out.push({ id: `mine:${a.id}@${label}`, name: `${a.name} @ ${label}`, kind: 'mine', base: a.id, device: label, online: true });
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
  // 没钉设备：交给网关的降级链（「我的设备」是其中一层，见 local-gateway withMeshProviders）
  if (!pin) return false;
  const wanted = pin ? pin.model : model;
  const candidates = scheduler.pickModelDevice({ model: wanted, device: pin?.device, devices: node.directory.list() });
  if (!candidates.length) {
    if (!pin) return false;
    sendJson(res, 404, { error: { message: `${pin.device} 不在线，或没有开放模型 ${pin.model}`, type: 'mesh_no_device' } });
    return true;
  }
  const payload = Buffer.from(JSON.stringify({ ...body, model: wanted }));
  // 没钉设备的已经排进网关的降级链（本机 → 我的设备 → 免费 → 社区 → 付费），这里只处理钉了设备的
  let lastErr = '';
  for (const dev of candidates) {
    try {
      const resp = await node.proxy(dev.device_id, {
        method: 'POST', path: cleanPath,
        headers: { 'content-type': 'application/json', accept: req.headers.accept || 'application/json' },
        body: payload,
      });
      if (resp.status >= 500 && dev !== candidates[candidates.length - 1]) {
        lastErr = `${deviceLabel(dev)}: HTTP ${resp.status}`;
        await tunnel.readAll(resp).catch(() => {});
        continue;
      }
      resp.headers['x-tb-mesh-device'] = encodeURIComponent(deviceLabel(dev));
      console.log(`[mesh] 模型 ${wanted} → ${deviceLabel(dev)}`);
      await tunnel.pipeTo(resp, res);
      return true;
    } catch (e) {
      lastErr = `${deviceLabel(dev)}: ${e.message}`;
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
    try {
      const obj = rewriteResponse(JSON.parse(line.slice(6)), deviceId, deviceName);
      // 记下任务号：流式派的也要在本机记镜像（任务树）
      const id = obj?.id || obj?.response?.id;
      if (!fn.taskId && typeof id === 'string' && id.startsWith('mesh:')) fn.taskId = id;
      return `data: ${JSON.stringify(obj)}`;
    } catch { return line; }
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
async function routeAgentCreate({ harnessId, body, req, res, extraMeta }) {
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
  // parent_id 是本机的任务号，那台设备不认识：任务树记在本机
  // parent_id 是本机的任务号，那台设备不认识：任务树记在本机
  const { parent_id: _parent, ...restMeta } = meta;
  const forward = { ...body, metadata: { ...restMeta, harness_id: target.id } };
  if (prev) forward.previous_response_id = prev.id;
  const headers = { 'content-type': 'application/json' };
  if (req.headers['idempotency-key']) headers['idempotency-key'] = req.headers['idempotency-key'];
  try {
    const resp = await node.proxy(dev.device_id, {
      method: 'POST', path: '/v1/agent/responses', headers, body: Buffer.from(JSON.stringify(forward)),
    });
    console.log(`[mesh] 智能体 ${target.id} → ${deviceLabel(dev)}`);
    if (body.stream && !body.background && String(resp.headers['content-type'] || '').includes('event-stream')) {
      const rw = sseRewriter(dev.device_id, deviceLabel(dev));
      await tunnel.pipeTo(resp, res, rw);
      return { handled: true, ok: true, device: deviceLabel(dev), taskId: rw.taskId, target: target.id };
    }
    const text = (await tunnel.readAll(resp)).toString('utf8');
    let obj;
    try { obj = JSON.parse(text); } catch { obj = null; }
    if (!obj) { res.writeHead(resp.status, { 'Content-Type': 'application/json' }); res.end(text); return { handled: true, ok: resp.status < 400, device: deviceLabel(dev) }; }
    const out = rewriteResponse(obj, dev.device_id, deviceLabel(dev));
    if (extraMeta && out.metadata && typeof out.metadata === 'object') Object.assign(out.metadata, extraMeta);
    sendJson(res, resp.status, out);
    return { handled: true, ok: resp.status < 400, error: obj.error?.message, device: deviceLabel(dev), taskId: resp.status < 400 ? out.id : undefined, status: out.status, target: target.id, response: out };
  } catch (e) {
    sendJson(res, e.status || 502, { error: { message: `${deviceLabel(dev)}：${e.message}`, type: 'mesh_error' } });
    return { handled: true, ok: false, error: e.message };
  }
}

// ── 程序内派活（执行器、MCP、游乐场用） ─────────────────────────────────────

/**
 * 把一个 mine: 任务交给某台设备，后台跑，马上返回任务号。
 * 选到本机时返回 { local: '<本机 harness>' }，由调用方照常在本机执行。
 * @returns {Promise<{ id: string, device: string, deviceId: string, response: object } | { local: string }>}
 */
async function submitAgentTask({ harnessId, input, metadata = {}, previousResponseId, idempotencyKey } = {}) {
  if (!node) throw Object.assign(new Error('设备网络没有启动'), { status: 503 });
  const target = scheduler.parseMineHarness(harnessId);
  if (!target) throw Object.assign(new Error(`不是设备网络的目标：${harnessId}`), { status: 400 });
  const prev = parseMeshTaskId(previousResponseId);
  if (prev) {
    const d = node.directory.get(prev.deviceId);
    if (d) target.device = d.name;
  }
  const picked = scheduler.pickDevice({ target, workspace: metadata.workspace, devices: node.directory.list() });
  if (!picked.device) throw Object.assign(new Error(picked.reason), { status: 404 });
  if (picked.device.self) return { local: target.id };
  const dev = picked.device;
  const forward = {
    input,
    background: true,
    metadata: { ...metadata, harness_id: target.id },
  };
  if (prev) forward.previous_response_id = prev.id;
  const headers = { 'content-type': 'application/json' };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  let resp;
  try {
    resp = await node.proxy(dev.device_id, {
      method: 'POST', path: '/v1/agent/responses', headers, body: Buffer.from(JSON.stringify(forward)),
    });
  } catch (e) {
    throw Object.assign(new Error(`${deviceLabel(dev)}：${e.message}`), { status: e.status || 502 });
  }
  const text = (await tunnel.readAll(resp)).toString('utf8');
  let obj = null;
  try { obj = JSON.parse(text); } catch { /* 下面报错 */ }
  if (!obj || resp.status >= 400 || !obj.id) {
    const msg = obj?.error?.message || text.slice(0, 200) || `HTTP ${resp.status}`;
    throw Object.assign(new Error(`${deviceLabel(dev)}：${msg}`), { status: resp.status >= 400 ? resp.status : 502 });
  }
  console.log(`[mesh] 智能体 ${target.id} → ${deviceLabel(dev)}（后台）`);
  const out = rewriteResponse(obj, dev.device_id, deviceLabel(dev));
  return { id: out.id, device: deviceLabel(dev), deviceId: dev.device_id, target: target.id, response: out };
}

/**
 * 查或取消另一台设备上的任务。连不上时 status 为 'unreachable'（结果还在那台设备上）。
 * @param {string} id mesh:<device_id>:<任务号>
 * @param {'get'|'cancel'} op
 */
async function fetchAgentTask(id, op = 'get', { stepsAfter } = {}) {
  const parsed = parseMeshTaskId(id);
  if (!parsed) throw Object.assign(new Error(`不是设备网络的任务号：${id}`), { status: 400 });
  if (!node) return { id, object: 'response', status: 'unreachable', error: { message: '设备网络没有启动', type: 'mesh_disabled' } };
  const dev = node.directory.get(parsed.deviceId);
  const label = dev ? deviceLabel(dev) : parsed.deviceId;
  const q = op !== 'cancel' && Number.isFinite(stepsAfter) ? `?steps_after=${stepsAfter}` : '';
  const p = `/v1/agent/responses/${encodeURIComponent(parsed.id)}${op === 'cancel' ? '/cancel' : ''}${q}`;
  try {
    const resp = await node.proxy(parsed.deviceId, { method: op === 'cancel' ? 'POST' : 'GET', path: p, headers: {} });
    const text = (await tunnel.readAll(resp)).toString('utf8');
    let obj = null;
    try { obj = JSON.parse(text); } catch { /* 下面处理 */ }
    if (!obj) return { id, object: 'response', status: 'unreachable', httpStatus: resp.status, error: { message: text.slice(0, 200), type: 'mesh_error' } };
    const out = rewriteResponse(obj, parsed.deviceId, label);
    if (resp.status >= 400) out.httpStatus = resp.status;
    return out;
  } catch (e) {
    return { id, object: 'response', status: 'unreachable', error: { message: `${label}：${e.message}`, type: 'mesh_unreachable' } };
  }
}

/** GET /v1/agent/responses/mesh:<设备>:<任务号>（以及 /cancel）转到那台设备 */
async function routeAgentById({ id, op, res }) {
  if (!parseMeshTaskId(id)) return false;
  const out = await fetchAgentTask(id, op);
  const status = out.status === 'unreachable' ? (out.httpStatus || 503) : (out.httpStatus || 200);
  delete out.httpStatus;
  sendJson(res, status, out);
  return true;
}

// ── 设备名称 ─────────────────────────────────────────────────────────────────
// 每台设备只有一个「设备名称」：盘点页显示它、派活时 @名称 认它、出租接单上报的也是它。
// 存在设备自己的 ~/.llm-agent/config.json 的 name（交易页原来的「供给名称」）。电脑名和 device_id 照样能用。

/** 名称不能和另一台在线设备的电脑名或设备名称重复 */
function nameConflict(name, selfId) {
  if (!node || !name) return null;
  for (const d of node.directory.list()) {
    if (String(d.device_id) === String(selfId) || (!d.self && !d.online)) continue;
    const taken = [d.name, ...(d.descriptor?.aliases || [])].map((x) => String(x || '').toLowerCase());
    if (taken.includes(name.toLowerCase())) return `名称「${name}」已经被 ${deviceLabel(d)} 用了`;
  }
  return null;
}

/** 校验一个名称；空字符串表示清掉，回到电脑名 */
function checkName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return '';
  return normalizeAliases([name])[0];
}

/** 改本机的设备名称：写进本机配置，马上推给其他设备 */
async function setSelfName(raw) {
  const name = checkName(raw);
  const selfId = node ? node.deviceId : null;
  const conflict = nameConflict(name, selfId);
  if (conflict) { const e = new Error(conflict); e.status = 409; throw e; }
  const loader = require('../../shared/config-loader');
  const cur = loader.readAgentConfig() || {};
  if (name) cur.name = name; else delete cur.name;
  loader.writeAgentConfig(cur);
  if (node) await node.tick();
  return { device_id: selfId, hostname: node ? node.deviceName : null, name: name || null };
}

/** 给某台设备改名：本机直接改；别的设备经隧道转过去，由那台设备自己保存 */
async function setName(deviceId, raw) {
  const id = String(deviceId || '');
  if (!id || id === 'self' || (node && id === node.deviceId)) return setSelfName(raw);
  if (!node) { const e = new Error('设备网络没有启动，只能改本机的名称'); e.status = 503; throw e; }
  const target = node.directory.list().find((d) => !d.self && (String(d.device_id) === id || deviceLabel(d) === id || d.name === id));
  if (!target) { const e = new Error(`没有这台设备：${id}`); e.status = 404; throw e; }
  if (!target.online) { const e = new Error(`${deviceLabel(target)} 离线，等它上线再改`); e.status = 409; throw e; }
  const name = checkName(raw);
  const conflict = nameConflict(name, target.device_id);
  if (conflict) { const e = new Error(conflict); e.status = 409; throw e; }
  const resp = await node.proxy(target.device_id, {
    method: 'PUT', path: '/v1/devices/self/name',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({ name })),
  });
  const text = (await tunnel.readAll(resp)).toString('utf8');
  let obj = null;
  try { obj = JSON.parse(text); } catch { /* 非 JSON */ }
  if (resp.status >= 400) { const e = new Error(obj?.error?.message || `那台设备没改成：HTTP ${resp.status}`); e.status = resp.status; throw e; }
  return obj;
}

/** 隧道转来的任务：metadata.workspace → 本机路径；都没给时用默认工作区 */
// ── 本机设置（盘点页选中本机时：接活、开放模型、工作区） ─────────────────────
// 只在本机改：路径不出本机，接口也不在隧道白名单里

function writeConfig(next) {
  fs.mkdirSync(meshDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(meshDir(), 'config.json'), JSON.stringify(next, null, 2), { mode: 0o600 });
  cfg = next;
}

function meshOff() {
  return Object.assign(new Error('设备网络没有开启'), { status: 503 });
}

/** 最近用过的目录（智能体任务的工作目录），给「从最近项目添加」用 */
function recentDirs(limit = 10) {
  const out = [];
  try {
    const db = require('../local-stats').getDb();
    const rows = db ? db.prepare(`
      SELECT json_extract(context, '$.workingDir') AS dir, MAX(created_at) AS ts
      FROM agent_tasks WHERE id NOT LIKE 'mesh:%' GROUP BY dir ORDER BY ts DESC LIMIT 200
    `).all() : [];
    const home = os.homedir();
    for (const r of rows) {
      const d = String(r.dir || '');
      if (!d || d === home || d === '/' || !path.isAbsolute(d)) continue;
      try { if (!fs.statSync(d).isDirectory()) continue; } catch { continue; }
      out.push(d);
      if (out.length >= limit) break;
    }
  } catch { /* 统计库不可用 */ }
  return out;
}

function getSelfSettings() {
  const c = readConfig();
  const cloudInfo = {
    connected: !!cloud?.ready, last_sync: cloudState.lastSync || null, error: cloudState.error || null, peers: cloudState.peers,
    awaiting_approval: !!cloudState.awaitingApproval, pending: pendingDevices(),
  };
  // can_enable：登录了就能一键开（证书自动领）；没登录时要有手写的证书
  if (!c || !c.enabled) return { enabled: false, can_enable: !!cloud?.ready || !!c?.cert, cloud: cloudInfo };
  const ws = workspaces.read(meshDir());
  return {
    enabled: true,
    running: !!node,
    accept_agent_tasks: c.accept_agent_tasks !== false,
    accept_model_requests: !!c.accept_model_requests,
    max_tasks: maxTasks(),
    load: selfLoad(),
    // 中继：本机当不当（auto / on / off）；用哪个（auto / official / 某台设备的 device_id），全账号同一个
    relay_mode: c.relay_mode || 'auto',
    relay_pref: node ? node.relayInfo().pref.value : (c.relay_pref || 'auto'),
    relay: node ? node.relayInfo() : null,
    default_workspace: ws.default || '',
    workspaces: Object.entries(ws.workspaces).map(([name, w]) => {
      const p = workspaces.expandHome(w && w.path);
      let exists = false;
      try { exists = !!p && fs.statSync(p).isDirectory(); } catch { exists = false; }
      return { name, path: String(w?.path || ''), exists, default: name === ws.default };
    }),
    recent: recentDirs(),
    has_cert: !!c.cert,
    cloud: cloudInfo,
  };
}

/** 改接活 / 开放模型 / 默认工作区；改完马上推给其他设备 */
async function updateSelfSettings(patch = {}) {
  // 开关设备网络本身：开了就领证书、入网；关了就断开
  if (typeof patch.enabled === 'boolean') {
    const cur = readConfig() || {};
    if (patch.enabled && !cur.cert && !cloud?.ready) {
      throw Object.assign(new Error('先登录 TokenBank：登录后自动领设备证书'), { status: 409 });
    }
    writeConfig({ ...cur, enabled: patch.enabled });
    if (patch.enabled) {
      await startFromConfig({});
      if (!node && !cloudState.awaitingApproval) throw Object.assign(new Error(cloudState.error || '设备网络没能启动，看一下日志'), { status: 500 });
    } else {
      await stop();
    }
    const { enabled: _e, ...rest } = patch;
    if (!Object.keys(rest).length) return getSelfSettings();
    patch = rest;
  }
  const c = readConfig();
  if (!c || !c.enabled) throw meshOff();
  const next = { ...c };
  if (typeof patch.accept_agent_tasks === 'boolean') next.accept_agent_tasks = patch.accept_agent_tasks;
  if (typeof patch.accept_model_requests === 'boolean') next.accept_model_requests = patch.accept_model_requests;
  if (patch.relay_mode !== undefined) {
    if (!['auto', 'on', 'off'].includes(patch.relay_mode)) throw Object.assign(new Error('relay_mode 只能是 auto、on、off'), { status: 400 });
    next.relay_mode = patch.relay_mode;
  }
  if (patch.relay_pref !== undefined) {
    const v = String(patch.relay_pref || 'auto');
    if (v !== 'auto' && v !== 'official' && !(node && node.directory.list().some((d) => String(d.device_id) === v))) {
      throw Object.assign(new Error('没有这台设备'), { status: 400 });
    }
    next.relay_pref = v;
    next.relay_pref_at = Date.now();
  }
  if (patch.max_tasks !== undefined) {
    const n = Number(patch.max_tasks);
    if (!Number.isInteger(n) || n < 1 || n > 16) throw Object.assign(new Error('同时接的任务数要在 1 到 16 之间'), { status: 400 });
    next.max_tasks = n;
  }
  writeConfig(next);
  if (typeof patch.default_workspace === 'string') {
    const ws = workspaces.read(meshDir());
    const name = patch.default_workspace.trim();
    if (name && !ws.workspaces[name]) throw Object.assign(new Error(`没有工作区 ${name}`), { status: 404 });
    ws.default = name;
    workspaces.write(meshDir(), ws);
  }
  if (node && patch.relay_mode !== undefined) await node.setRelayMode(next.relay_mode).catch(() => {});
  if (node && patch.relay_pref !== undefined) await node.setRelayPref(next.relay_pref).catch(() => {});
  try { await node?.tick?.(); } catch { /* 下一轮 presence 再推 */ }
  return getSelfSettings();
}

const WS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

async function addWorkspace({ name, path: dirPath } = {}) {
  const c = readConfig();
  if (!c || !c.enabled) throw meshOff();
  const p = String(dirPath || '').trim();
  if (!p) throw Object.assign(new Error('缺少目录'), { status: 400 });
  const abs = path.resolve(workspaces.expandHome(p));
  try { if (!fs.statSync(abs).isDirectory()) throw new Error(); } catch {
    throw Object.assign(new Error(`目录不存在：${p}`), { status: 400 });
  }
  const n = String(name || '').trim() || path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40);
  if (!WS_NAME.test(n)) throw Object.assign(new Error('工作区名只能用字母、数字、点、横线、下划线，最多 40 个字'), { status: 400 });
  const ws = workspaces.read(meshDir());
  if (ws.workspaces[n] && workspaces.expandHome(ws.workspaces[n].path) !== abs) {
    throw Object.assign(new Error(`工作区名「${n}」已经有了`), { status: 409 });
  }
  const home = os.homedir();
  ws.workspaces[n] = { path: abs.startsWith(home + path.sep) ? '~' + abs.slice(home.length) : abs };
  if (!ws.default) ws.default = n;
  workspaces.write(meshDir(), ws);
  try { await node?.tick?.(); } catch { /* 下一轮再推 */ }
  return getSelfSettings();
}

async function removeWorkspace(name) {
  const c = readConfig();
  if (!c || !c.enabled) throw meshOff();
  const ws = workspaces.read(meshDir());
  if (!ws.workspaces[name]) throw Object.assign(new Error(`没有工作区 ${name}`), { status: 404 });
  delete ws.workspaces[name];
  if (ws.default === name) ws.default = Object.keys(ws.workspaces)[0] || '';
  workspaces.write(meshDir(), ws);
  try { await node?.tick?.(); } catch { /* 下一轮再推 */ }
  return getSelfSettings();
}

function meshDirPath() { return meshDir(); }

/** 降级链里的「我的设备」层：每台开放了模型的在线设备一个虚拟源 */
function meshProviders() {
  if (!node) return [];
  const out = [];
  for (const d of node.directory.list()) {
    if (d.self || !d.online || !d.descriptor?.accepts?.model_requests) continue;
    const models = d.descriptor?.models || [];
    if (!models.length) continue;
    const label = deviceLabel(d);
    out.push({
      id: `mesh:${d.device_id}`, name: `${label}（我的设备）`, label: `${label}（我的设备）`, type: 'mesh', enabled: true,
      base_url: `mesh://${d.device_id}`, models: [...models], _meshDevice: d.device_id,
    });
  }
  return out;
}

function meshProviderLabel(via) {
  const id = String(via || '').replace(/^mesh:/, '');
  const d = node?.directory.get(id);
  return d ? deviceLabel(d) : id;
}

/** 经隧道转来的请求：是哪台设备发的（名称） */
function meshFromLabel(headers = {}) {
  if (!node || !node.isMeshRequest(headers)) return '';
  const id = String(headers['x-tb-mesh-from'] || '');
  const d = id ? node.directory.get(id) : null;
  return d ? deviceLabel(d) : id;
}

/** 工作区的配置（worktree_init 等）。没写名字时用默认工作区 */
function workspaceConfig(name) {
  try {
    const ws = workspaces.read(meshDir());
    const n = String(name || '').trim() || ws.default;
    return n ? { name: n, ...(ws.workspaces[n] || {}) } : null;
  } catch { return null; }
}

function isSelfDevice(name) {
  if (!node) return true;
  const self = node.directory.list().find((d) => d.self);
  return !!self && scheduler.matchesDevice(self, name);
}

function findDevice(name) {
  if (!node) return null;
  return node.directory.list().find((d) => !d.self && scheduler.matchesDevice(d, name)) || null;
}

/** 到某台设备现在怎么走，记进路由明细：{ kind: 'direct', addr_kind } 或 { kind: 'relay', via_kind, via } */
function meshPathOf(ref) {
  if (!node || !ref) return null;
  const id = String(ref).replace(/^mesh:/, '');
  const d = node.directory.get(id) || findDevice(id);
  const p = d?.path;
  if (!p) return null;
  return p.kind === 'relay' ? { kind: 'relay', via_kind: p.relay_kind, via: p.via } : { kind: 'direct', addr_kind: p.addr_kind || 'lan' };
}

function resolveWorkspace(name) {
  return workspaces.resolve(meshDir(), name);
}

module.exports = {
  setCloud, cloudStatus: () => ({ connected: !!cloud?.ready, ...cloudState }),
  getSelfSettings, updateSelfSettings, addWorkspace, removeWorkspace, selfLoad, pendingDevices, decidePending,
  canServeHires, hireViaMesh,
  meshDirPath, workspaceConfig, isSelfDevice, findDevice, meshProviders, meshProviderLabel, meshFromLabel, meshPathOf,
  submitAgentTask,
  fetchAgentTask,
  parseMeshTaskId,
  startFromConfig, stop, getNode,
  isMeshKey, isMeshRequest, isHop,
  devicesView, extraModels, extraHarnesses,
  routeChat, routeAgentCreate, routeAgentById, resolveWorkspace, setName, setSelfName,
  _internal: { sseRewriter, rewriteResponse, parseMeshTaskId, describeSelf },
};
