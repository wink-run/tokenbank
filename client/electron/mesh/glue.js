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

function runningInDocker() {
  try { return fs.existsSync('/.dockerenv'); } catch { return false; }
}

/**
 * 容器不另开端口：设备网络挂在网关已有端口上（/mesh/ws、/mesh/ping），和官方中继挂在 API 端口上一样。
 * 有公网 IP 时云端回拨这个端口，验过就能当中继。172.x 网桥地址不会写进地址簿。局域网组播出不了容器网桥，默认关掉。
 * 公网地址：MESH_PUBLIC_ADDR 或 config 的 public_addr；不填就用云端看到的出口 IP。
 */
function meshRuntimeOpts(cfg, gatewayPort) {
  const docker = runningInDocker();
  const lanDiscovery = docker ? cfg.lan_discovery === true : cfg.lan_discovery !== false;
  if (docker && cfg.listen !== false && gatewayPort) {
    return { listen: 'shared', lanDiscovery, port: gatewayPort, shareHttp: true };
  }
  const listen = cfg.listen === false ? false : (cfg.listen || '::');
  return { listen, lanDiscovery, port: Number.isInteger(cfg.port) ? cfg.port : 41750, shareHttp: false };
}

function publicAddrOf(cfg, port) {
  const raw = String(process.env.MESH_PUBLIC_ADDR || cfg.public_addr || '').trim();
  if (!raw) return undefined;
  const p = port || (Number.isInteger(cfg.port) ? cfg.port : 41750);
  // 只写了 IPv4 时补上入口端口
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return `${raw}:${p}`;
  return raw;
}

/** 网关已有端口上的探活。容器把设备网络挂在这里，不另开端口 */
function handleHttp(req, res) {
  if (!node || typeof node.handleHttp !== 'function') return false;
  return node.handleHttp(req, res);
}

/** 网关已有端口上的 /mesh/ws。不是这条路径就不动 */
function handleUpgrade(req, socket, head) {
  const path = String(req.url || '').split('?')[0];
  if (path !== '/mesh/ws') return false;
  if (node && typeof node.handleUpgrade === 'function' && node.handleUpgrade(req, socket, head)) return true;
  try { socket.destroy(); } catch { /* 已经断了 */ }
  return true;
}

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
  // 先确认能不能跑再报：跑不起来的照样列出，标上 ready:false 和原因，别的设备不会往这儿派（借鉴 agentmesh 发布前先探活）
  try {
    const executor = require('../agent-executor');
    const agents = await executor.listAvailableAgents();
    let blocked = new Map();
    try { blocked = new Map((executor.listBlockedAssistants() || []).map((b) => [b.id, b])); } catch { /* 查不了就都当能跑 */ }
    for (const a of agents || []) {
      if (!a || a.guardian) continue;
      if (a.type === 'cli' && a.installed) out.apps.push({ id: a.id, name: a.name || a.id });
      else if (a.type === 'assistant') {
        const b = blocked.get(a.id);
        out.assistants.push(b
          ? { id: a.id, name: a.name || a.id, ready: false, why: b.reason === 'skills' ? `缺技能：${(b.missing || []).join('、')}` : `运行它的应用不可用：${(b.missing || []).join('、')}` }
          : { id: a.id, name: a.name || a.id });
      }
      // 外部智能体接在这台设备的网关上：别的设备派给它也要经这台
      else if (a.type === 'external' || String(a.id || '').startsWith('external:')) {
        out.externals.push(a.online === false ? { id: a.id, name: a.name || a.id, ready: false, why: '它现在不在线' } : { id: a.id, name: a.name || a.id });
      }
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

function logLine(m) {
  (saved.log || ((x) => console.log(x)))(m);
  // 桌面应用的控制台不容易打开，同一行再落到文件里，卡住时直接看这个
  try {
    const file = path.join(os.homedir(), '.tokenbank', 'mesh.log');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFile(file, `${new Date().toISOString()} ${m}\n`, () => {});
  } catch { /* 写日志失败不影响调用 */ }
}

/** 目录里看到的通路，用来对照「发出去时实际走的那条」 */
function reachNote(dev) {
  if (!dev) return '不在目录里';
  if (!dev.online && !dev.self) return '目录里标成离线';
  const p = dev.path;
  if (!p) return '在线，还没有通路';
  if (p.kind === 'relay') return `在线，经${p.via || '中继'}`;
  if (p.kind === 'direct') return '在线，直连';
  return '在线';
}

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
/** 证书是哪把签发钥匙签的（JWS 头里的 kid） */
function certKid(cert) {
  try { return JSON.parse(Buffer.from(String(cert).split('.')[0], 'base64url').toString('utf8')).kid || ''; } catch { return ''; }
}

async function ensureCloudCert({ force = false } = {}) {
  if (!cloud?.ready) return false;
  const identity = require('./identity');
  const { endpointIdFromSecret } = require('./keys');
  const endpointId = endpointIdFromSecret(identity.loadOrCreateDeviceSecret(meshDir()));
  const cur = readConfig() || {};
  const claims = certClaims(cur.cert);
  if (!force && !needsCert(claims, { deviceId: cloud.deviceId, endpointId })) return false;
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
    // 每一步各自出错各自记，不让报地址慢了拖住吊销列表、批准名单和地址簿
    const errors = [];
    try {
      // 云端回拨验证：从外面真的连得到的地址，才能自动当中继
      let pub = await cloud.publishAddress({ endpointId: a.endpoint_id, relayUrl: a.relay_url, directAddrs: a.direct_addrs });
      node.setVerified(pub?.verified || [], pub?.observed_ip || '');
      // 容器网卡上没有公网地址：云端看到的出口 IP 补进地址簿后再报一次，这一轮就能回拨验证、当中继
      const again = node.addrInfo();
      const known = new Set(a.direct_addrs || []);
      if ((again.direct_addrs || []).some((x) => !known.has(x))) {
        pub = await cloud.publishAddress({ endpointId: again.endpoint_id, relayUrl: again.relay_url, directAddrs: again.direct_addrs });
        node.setVerified(pub?.verified || [], pub?.observed_ip || '');
      }
      rememberAddrs([node.deviceId, a.endpoint_id], [node.observedIp, ...(node.verifiedAddrs || []), ...(node.addrInfo().direct_addrs || [])]);
    } catch (e) { errors.push(`报地址：${e.message}`); }
    // 按密钥吊销：同一台设备重装后换了密钥，旧密钥作废，新的照常
    try {
      const { revoked, issuerKeys } = await cloud.revocationsAndKeys();
      node.setRevoked(revoked.map((r) => r.endpoint_id));
      // 服务端换了签发钥匙：本机证书不是现在这几把签的，马上重领、重连（不然中继和别的设备都不认）
      if (issuerKeys && issuerKeys.length && !issuerKeys.some((k) => k.kid === certKid(node.opts.cert))) {
        logLine('[mesh] 云端换了签发钥匙，重新领设备证书');
        await ensureCloudCert({ force: true });
        await stop();
        await startFromConfig({});
        return;
      }
    } catch (e) { errors.push(`吊销列表：${e.message}`); }
    try { cloudState.pending = await cloud.pending(); } catch { /* 老服务端没有这个接口 */ }
    let peers = [];
    try { peers = await cloud.peers(); } catch (e) { errors.push(`地址簿：${e.message}`); }
    let n = 0;
    for (const p of peers) {
      rememberAddrs([p.device_id, p.endpoint_id], p.direct_addrs || []);
      if (!p.endpoint_id || p.endpoint_id === a.endpoint_id) continue;
      node.ensurePeer({ endpoint_id: p.endpoint_id, device_id: p.device_id, relay_url: p.relay_url, direct_addrs: p.direct_addrs || [], name: p.name }, 'cloud');
      n += 1;
    }
    Object.assign(cloudState, { lastSync: Date.now(), error: errors.join('；'), peers: n });
    if (errors.length) logLine(`[mesh] 和云端同步有一步失败：${errors.join('；')}`);
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
      cloudState.error = e.message;
      logLine(`[mesh] 领设备证书失败：${e.message}`);
    }
    cfg = readConfig();
  }
  if (!cfg.cert) {
    if (!cloudState.error) cloudState.error = '还没有设备证书：登录后自动领取';
    logLine(`[mesh] ${cloudState.error}`);
    if (cloud?.ready) scheduleApprovalRetry();
    return null;
  }
  const runtime = meshRuntimeOpts(cfg, saved.gatewayPort);
  const { MeshNode } = require('./node');
  node = new MeshNode({
    dir: meshDir(),
    userId: cfg.user_id,
    cert: cfg.cert,
    issuerKeys: cfg.issuer_keys || [],
    peers: cfg.peers || [],
    revoked: cfg.revoked || [],
    relayUrls: cfg.relay_urls || [],
    // 桌面默认 [::]:41750。容器 shareHttp：挂在网关端口上，不再另开。listen: false 表示不开入口、只走中继
    listen: runtime.listen === 'shared' ? '0.0.0.0' : runtime.listen,
    port: runtime.port,
    shareHttp: runtime.shareHttp,
    publicAddr: publicAddrOf(cfg, runtime.port),
    relay: { mode: cfg.relay_mode || 'auto', pref: cfg.relay_pref || 'auto', prefAt: Number(cfg.relay_pref_at) || 0 },
    cloud: !!cloud?.ready,
    relayDumpFile: cfg.relay_dump || undefined,
    gatewayPort: saved.gatewayPort,
    describeSelf,
    presenceMs: cfg.presence_ms || 5000,
    lanDiscovery: runtime.lanDiscovery,
    lanPort: cfg.lan_port,
    log: logLine,
  });
  try {
    await node.start();
    cloudState.error = '';
  } catch (e) {
    logLine(`[mesh] 启动失败：${e.message}`);
    cloudState.error = e.message;
    try { await node?.stop(); } catch { /* 没开起来 */ }
    node = null;
    if (cloud?.ready) scheduleApprovalRetry();
    return null;
  }
  attachHireHandlers(node);
  // 接着跟上次没做完的远端任务
  try { require('../agent-executor').resumeMeshTasks(); } catch { /* 执行器没就绪 */ }
  // 某台设备重新上线：它身上没做完的、标过失联的任务再查一次
  node.on('peer', ({ device_id: id }) => {
    try { require('../agent-executor').resumeMeshTasks(id); } catch { /* 执行器没就绪 */ }
  });
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
/** 离线超过这么久的设备不再列出（重装、重建留下的旧记录）；它再上线会自动回来 */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** host:port 或 ws://host:port/mesh/ws 里的 IP */
function hostOf(addr) {
  let s = String(addr || '').replace(/^wss?:\/\//, '').replace(/\/.*$/, '');
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end > 1 ? s.slice(1, end) : '';
  }
  return s.replace(/:\d+$/, '');
}

// 云端地址簿：device_id / endpoint_id → 地址。经官方中继连上时直连地址不在通路上，卡片仍要显示
const addrBook = new Map();

function rememberAddrs(ids, addrs) {
  const list = [...new Set((addrs || []).map((a) => String(a || '').trim()).filter(Boolean))];
  if (!list.length) return;
  for (const id of ids) if (id) addrBook.set(String(id), list);
}

function bookedAddrs(d) {
  if (!d) return [];
  return [
    ...(d.device_id ? addrBook.get(String(d.device_id)) || [] : []),
    ...(d.endpoint_id ? addrBook.get(String(d.endpoint_id)) || [] : []),
  ];
}

/** 卡片上放一个 IP：公网优先，其次局域网 / Tailscale */
function pickIp(addrs) {
  const hosts = [];
  for (const a of addrs || []) {
    const h = hostOf(a);
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  const pub = hosts.find((h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) && !/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h));
  if (pub) return pub;
  const lan = hosts.find((h) => /^(10\.|192\.168\.|100\.)/.test(h));
  return lan || hosts[0] || '';
}

function deviceIp(d) {
  if (!node || !d) return '';
  const known = [];
  try {
    for (const p of node.diagnose().peers || []) {
      if ((p.device_id && p.device_id === d.device_id) || (p.endpoint_id && p.endpoint_id === d.endpoint_id)) known.push(...(p.addrs || []));
    }
  } catch { /* 没有诊断 */ }
  // 本机：云端看到的出口 IP（容器网卡只有 172.x，地址簿里才有公网地址）
  const selfAddrs = d.self ? [node.observedIp, ...(node.verifiedAddrs || []), ...(node.addrInfo().direct_addrs || [])] : [d.path?.addr];
  return pickIp([...selfAddrs, ...bookedAddrs(d), ...known, ...(d.descriptor?.relay?.addrs || [])]);
}

function devicesView() {
  // 开关开着但节点还没起来（Docker 里常见：入口绑失败、证书还在领）不能当成「没开设备网络」
  if (!node) {
    const on = !!(readConfig()?.enabled);
    return { enabled: on, ready: false, error: on ? (cloudState.error || '') : '', devices: [] };
  }
  const now = Date.now();
  // 连不上的原因：每台试过哪些直连地址、结果如何，官方中继的情况（借鉴 agentmesh 失败时说清楚每条路）
  let diag = { official: null, peers: [] };
  try { diag = node.diagnose(); } catch { /* 老节点没有诊断 */ }
  const diagOf = (d) => diag.peers.find((p) => (p.device_id && p.device_id === d.device_id) || (p.endpoint_id && p.endpoint_id === d.endpoint_id)) || null;
  const listed = node.directory.list().filter((d) => d.self || d.online || !d.lastSeen || now - d.lastSeen < STALE_MS);
  const known = new Set(listed.map((d) => d.device_id));
  const knownEp = new Set(listed.map((d) => d.endpoint_id).filter(Boolean));
  return {
    enabled: true,
    ready: true,
    relay: node.relayInfo(),
    official: diag.official ? { configured: diag.official.configured, connected: diag.official.connected } : null,
    // 地址簿里有、但从来没连上过的设备（还不在目录里）：给界面说明为什么没连上
    unreached: diag.peers
      .filter((p) => !(p.device_id && known.has(p.device_id)) && !(p.endpoint_id && knownEp.has(p.endpoint_id)))
      .map((p) => ({ name: p.name, device_id: p.device_id, waiting: p.waiting, attempts: p.attempts, on_official: !!(p.device_id && diag.official?.peers.includes(p.device_id)) })),
    devices: listed.map((d) => ({
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
      // 卡片上显示的 IP：直连用正在走的地址，否则用地址簿里的；本机优先公网
      ip: deviceIp(d),
      via: d.path?.kind === 'relay' ? { kind: d.path.relay_kind, device_id: d.path.relay_device, label: d.path.via } : null,
      rtt_ms: d.path && Number.isFinite(d.path.rttMs) ? d.path.rttMs : null,
      // 这台在当中继：正在替哪些设备转发（界面标「中继 · N」）
      relay: relayView(d),
      ...(d.self || (d.online && d.path) ? {} : (() => {
        const p = diagOf(d);
        return { diag: { waiting: !!p?.waiting, attempts: p?.attempts || [], on_official: !!(diag.official?.peers || []).includes(d.device_id) } };
      })()),
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
 * 别的设备派来的活：执行前在本机再核实一次（设备描述只是线索，可能已经过时）。
 * 目标应用没装、智能体跑不起来、外部智能体不在线、工作区不在，直接说原因，不跑到一半才失败。
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
async function checkIncoming({ harnessId, workspace } = {}) {
  const id = String(harnessId || '').trim();
  if (workspace) {
    try {
      if (!resolveWorkspace(String(workspace))) return { ok: false, message: `这台设备上没有工作区「${workspace}」` };
    } catch (e) {
      // 工作区没配、目录被删了：resolve 会抛出带原因的错
      if (e && e.status) return { ok: false, message: e.message };
    }
  }
  if (!id || id.startsWith('session:') || id.startsWith('mine:')) return { ok: true };
  try {
    const self = await describeSelf();
    const all = [...self.apps, ...self.assistants, ...self.externals];
    const hit = all.find((a) => a.id === id);
    if (!hit) {
      if (!self.accepts?.agent_tasks) return { ok: false, message: '这台设备没打开「接我其他设备派来的活」' };
      return { ok: false, message: `这台设备上没有 ${id}（没装或已经删了）` };
    }
    if (hit.ready === false) return { ok: false, message: `${hit.name} 在这台设备上暂时跑不了：${hit.why}` };
  } catch { /* 查不了就不拦，照常执行 */ }
  return { ok: true };
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
    if (d && !d.self && !d.online) {
      const e = prevOfflineError(target, d);
      sendJson(res, 409, { error: { message: e.message, type: e.code, device: e.device, alternatives: e.alternatives } });
      return { handled: true, ok: false, error: e.message };
    }
    if (d) target.device = d.name;
  }
  const picked = scheduler.pickDevice({ target, workspace: meta.workspace, devices: node.directory.list() });
  if (!picked.device) {
    logLine(`[mesh] 调不到 ${harnessId}：${picked.reason}`);
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
  logLine(`[mesh] 调用 ${target.id} → ${deviceLabel(dev)}（${reachNote(dev)}）`);
  try {
    const resp = await node.proxy(dev.device_id, {
      method: 'POST', path: '/v1/agent/responses', headers, body: Buffer.from(JSON.stringify(forward)),
    });
    const streaming = body.stream && !body.background && String(resp.headers['content-type'] || '').includes('event-stream');
    logLine(`[mesh] ${deviceLabel(dev)} 应答 HTTP ${resp.status}${streaming ? '，流式' : ''}（${target.id}）`);
    if (streaming) {
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
    const replyLen = require('../agent-executor').meshOutputText(out).length;
    logLine(`[mesh] ${deviceLabel(dev)} 这次返回正文 ${replyLen} 字（${target.id}，HTTP ${resp.status}）`);
    sendJson(res, resp.status, out);
    return { handled: true, ok: resp.status < 400, error: obj.error?.message, device: deviceLabel(dev), taskId: resp.status < 400 ? out.id : undefined, status: out.status, target: target.id, response: out };
  } catch (e) {
    logLine(`[mesh] 调用 ${target.id} → ${deviceLabel(dev)} 失败：${e.message}`);
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
/**
 * 本机的项目目录在那台设备上对应哪个工作区：按目录名找同名的（不分大小写）。
 * @returns {{ workspace: string|null, note: string }}
 */
function mapWorkspace(dev, localDir) {
  const label = deviceLabel(dev);
  const dirName = path.basename(String(localDir || '').replace(/[\\/]+$/, ''));
  if (!dirName) return { workspace: null, note: '' };
  const list = (dev.descriptor || {}).workspaces || [];
  const hit = list.find((w) => String(w.name || '').toLowerCase() === dirName.toLowerCase());
  if (hit) return { workspace: hit.name, note: `在 ${label} 的工作区「${hit.name}」里跑（对应本机的 ${dirName}）` };
  return { workspace: null, note: `${label} 上没有「${dirName}」工作区，在它的默认工作区里跑。要对上，在那台设备「我的设备 → 工作区」里加一个同名的` };
}

/**
 * 上一轮在哪台设备，这一轮就去哪台；那台离线了不硬等：报清楚，并列出还能接着做的设备。
 * 换设备是新会话，之前的对话上下文带不过去，由调用方跟用户说明。
 */
function prevOfflineError(target, prevDev, devices = node ? node.directory.list() : []) {
  const label = deviceLabel(prevDev);
  const alternatives = [];
  for (const d of devices) {
    if (d.device_id === prevDev.device_id || !(d.self || d.online)) continue;
    const name = d.self ? null : deviceLabel(d);
    const ok = scheduler.pickDevice({ target: { ...target, device: d.self ? null : name }, devices: d.self ? [d] : devices });
    if (ok.device && ok.device.device_id === d.device_id) {
      alternatives.push({ device: d.self ? '本机' : name, self: !!d.self, harnessId: d.self ? target.id : `mine:${target.id}@${name}` });
    }
  }
  const tail = alternatives.length
    ? `可以换到 ${alternatives.map((a) => a.device).join('、')} 接着做，但那是新会话，之前的对话上下文带不过去`
    : '现在没有别的在线设备能做，等它上线再接着聊';
  return Object.assign(new Error(`上一轮在 ${label} 上跑，${label} 现在离线。${tail}`), {
    status: 409, code: 'mesh_prev_offline', device: label, alternatives,
  });
}

async function submitAgentTask({ harnessId, input, metadata = {}, previousResponseId, idempotencyKey, localDir } = {}) {
  if (!node) throw Object.assign(new Error('设备网络没有启动'), { status: 503 });
  const target = scheduler.parseMineHarness(harnessId);
  if (!target) throw Object.assign(new Error(`不是设备网络的目标：${harnessId}`), { status: 400 });
  const prev = parseMeshTaskId(previousResponseId);
  if (prev) {
    const d = node.directory.get(prev.deviceId);
    if (d && !d.self && !d.online) throw prevOfflineError(target, d);
    if (d) target.device = d.name;
  }
  const picked = scheduler.pickDevice({ target, workspace: metadata.workspace, devices: node.directory.list() });
  if (!picked.device) {
    logLine(`[mesh] 调不到 ${harnessId}：${picked.reason}`);
    throw Object.assign(new Error(picked.reason), { status: 404 });
  }
  if (picked.device.self) return { local: target.id };
  const dev = picked.device;
  // 本机选的项目目录：那台设备上找同名工作区；找不到就在它的默认工作区里跑，并说清楚
  let workspaceNote = '';
  if (!metadata.workspace && localDir) {
    const mapped = mapWorkspace(dev, localDir);
    if (mapped.workspace) metadata = { ...metadata, workspace: mapped.workspace };
    workspaceNote = mapped.note;
  }
  const forward = {
    input,
    background: true,
    metadata: { ...metadata, harness_id: target.id },
  };
  if (prev) forward.previous_response_id = prev.id;
  const headers = { 'content-type': 'application/json' };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  logLine(`[mesh] 后台调用 ${target.id} → ${deviceLabel(dev)}（${reachNote(dev)}）`);
  let resp;
  try {
    resp = await node.proxy(dev.device_id, {
      method: 'POST', path: '/v1/agent/responses', headers, body: Buffer.from(JSON.stringify(forward)),
    });
  } catch (e) {
    logLine(`[mesh] 后台调用 ${target.id} → ${deviceLabel(dev)} 失败：${e.message}`);
    throw Object.assign(new Error(`${deviceLabel(dev)}：${e.message}`), { status: e.status || 502 });
  }
  const text = (await tunnel.readAll(resp)).toString('utf8');
  let obj = null;
  try { obj = JSON.parse(text); } catch { /* 下面报错 */ }
  if (!obj || resp.status >= 400 || !obj.id) {
    const msg = obj?.error?.message || text.slice(0, 200) || `HTTP ${resp.status}`;
    logLine(`[mesh] 后台调用 ${target.id} → ${deviceLabel(dev)} 失败：HTTP ${resp.status} ${msg}`);
    throw Object.assign(new Error(`${deviceLabel(dev)}：${msg}`), { status: resp.status >= 400 ? resp.status : 502 });
  }
  const out = rewriteResponse(obj, dev.device_id, deviceLabel(dev));
  const replyLen = require('../agent-executor').meshOutputText(out).length;
  logLine(`[mesh] 后台任务已交给 ${deviceLabel(dev)}（${target.id}，HTTP ${resp.status}，正文 ${replyLen} 字）`);
  return { id: out.id, device: deviceLabel(dev), deviceId: dev.device_id, target: target.id, response: out, workspaceNote };
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

/**
 * 从另一台设备拉一个登记过的文件（mesh/files.js）。只能经官方中继时，大文件按上限拒绝。
 * @returns {Promise<{ path: string, size: number }>}
 */
async function pullFile({ deviceId, entry, destDir }) {
  if (!node) throw new Error('设备网络没有启动');
  const dev = node.directory.get(deviceId);
  if (!dev || !dev.online) throw new Error(`${dev ? deviceLabel(dev) : '那台设备'}不在线，文件还在它那里，等它上线再拉`);
  const p = dev.path || {};
  const viaOfficialRelay = p.kind === 'relay' && p.relay_kind === 'official';
  return require('./files').pull({ proxy: (id, r) => node.proxy(id, r), deviceId, entry, destDir, viaOfficialRelay });
}

/**
 * 接活方：开工前把派活方带来的图片、附件拉过来。图片交给智能体（dataUrl），其它附件放进工作目录，路径写进任务说明。
 * @returns {Promise<{ images: string[], note: string, dir: string }>}
 */
async function pullInputs({ deviceId, inputs, workingDir }) {
  const files = require('./files');
  const fsx = require('fs');
  const sub = require('crypto').randomBytes(6).toString('hex');
  const dir = workingDir && fsx.existsSync(workingDir) ? path.join(workingDir, '.tokenbank-uploads', sub) : files.inboxDir(`in-${sub}`);
  const images = [];
  const others = [];
  for (const entry of inputs || []) {
    const got = await pullFile({ deviceId, entry, destDir: dir });
    const mime = String(entry.mime || files.mimeOf(got.path));
    if (mime.startsWith('image/') && !mime.includes('svg') && got.size <= 20 * 1024 * 1024) {
      images.push(`data:${mime};base64,${fsx.readFileSync(got.path).toString('base64')}`);
    } else {
      others.push(got.path);
    }
  }
  const note = others.length ? `\n\n附件已放在这台设备上：\n${others.map((p) => `- ${p}`).join('\n')}` : '';
  return { images, note, dir };
}

/** 本机的设备号（文件清单里写「在哪台」） */
function selfDeviceId() { return node ? node.deviceId : ''; }

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
  startFromConfig, stop, getNode, logLine, handleHttp, handleUpgrade,
  isMeshKey, isMeshRequest, isHop, checkIncoming, mapWorkspace, prevOfflineError, pullFile, pullInputs, selfDeviceId,
  devicesView, extraModels, extraHarnesses,
  routeChat, routeAgentCreate, routeAgentById, resolveWorkspace, setName, setSelfName,
  _internal: { sseRewriter, rewriteResponse, parseMeshTaskId, describeSelf },
};
