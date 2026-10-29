// client/cli/admin-api.js
// Admin HTTP API server for the CLI gateway.
// Mirrors all Electron IPC handlers as REST endpoints.
// Also serves the React frontend from ../dist/.
'use strict';

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { readAgentConfig, writeAgentConfig, readLocalConfig, writeLocalConfig } = require('../shared/config-loader');
const { isCommunityP2pEnabled } = require('../shared/community-p2p');
const { defaultServerUrlFromEnv } = require('../shared/default-server-url');
const deviceIdentity = require('../shared/device-identity');
const { ensureDeviceId } = require('../shared/device-id');
const { refreshGatewayPeerModels } = require('../shared/peer-models-sync');
const { bindClaudeRoutesToKeyScene } = require('../shared/route-binding');
const { localStats } = require('../shared/telemetry');
const billingConfig = require('../electron/billing-config');
const catalogSync = require('../electron/catalog-sync');
const cloudBilling = require('../electron/cloud-billing-sync');
const configLoader = require('../electron/config-loader');
const appsUsage = require('../shared/apps-usage-handlers');
const compressionReport = require('../electron/compression-report');
const agentControl = require('./agent-control');
const reporter = require('../shared/device-reporter');

// ── Module state ──────────────────────────────────────────────────────────────

let _gateway = null;
let _server  = null;
let _reporterGetStats = null;

const DIST_DIR = path.resolve(__dirname, '..', 'dist');

// ── Helpers ───────────────────────────────────────────────────────────────────

function rndHex(n) {
  return crypto.randomBytes(n).toString('hex');
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 1_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (!buf) { resolve({}); return; }
      try { resolve(JSON.parse(buf)); }
      catch (_) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function parseBody(req, res) {
  try {
    return await readBody(req);
  } catch (_) {
    json(res, 400, { error: 'invalid JSON or body too large' });
    return null;
  }
}

// Serve a static file from DIST_DIR; returns false if file not found.
function serveStatic(res, relPath) {
  const filePath = path.join(DIST_DIR, relPath);

  // Prevent path traversal outside dist dir
  if (!filePath.startsWith(DIST_DIR + path.sep) && filePath !== DIST_DIR) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.mjs':  'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf':  'font/ttf',
  };
  const ct = mimeMap[ext] || 'application/octet-stream';

  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return false; // file not found or unreadable
  }
  res.writeHead(200, { 'Content-Type': ct, 'Content-Length': data.length });
  res.end(data);
  return true;
}

// ── Apps（local-config.apps[]，与 Electron apps:* IPC 同结构）──────────────────

function readAppsCfg() {
  const cfg = readLocalConfig() || { scene_routes: [], local_keys: [] };
  if (!Array.isArray(cfg.apps)) cfg.apps = [];
  return cfg;
}

function persistAppsCfg(cfg) {
  writeLocalConfig(cfg);
  syncGateway(cfg);
  return cfg;
}

function createAppRecord(data = {}) {
  return {
    id: 'app-' + rndHex(8),
    name: data.name || '未命名应用',
    icon: data.icon || '🔧',
    link_method: data.link_method || 'api-key',
    agent_id: data.agent_id || null,
    api_key: (data.link_method === 'api-key' || data.link_method === 'manual')
      ? ('sk-local-' + rndHex(16)) : null,
    route_id: data.route_id || null,
    description: data.description || '',
    allowed_models: data.allowed_models || [],
    max_rpm: data.max_rpm || null,
    max_concurrent: data.max_concurrent || null,
    allow_stream: data.allow_stream !== false,
    env: data.env || null,
    preset_id: data.preset_id || null,
    inject: data.inject || (data.env ? 'env' : null),
    config_file: data.config_file || null,
    patch: data.patch || null,
    hosted: data.hosted === true,
    draft: data.draft === true,
    created_at: new Date().toISOString(),
  };
}

// ── syncGateway ───────────────────────────────────────────────────────────────

function syncGateway(lc) {
  if (!_gateway) return;
  const routes = lc.scene_routes || [];
  const apps = lc.apps || [];
  const routerMap = {};
  for (const r of routes) {
    if (r.model_key && (r.steps?.length || r.rules?.length)) {
      const entry = {
        steps: r.steps || [],
        scene_name: r.scene_name,
        rules: r.rules || null,
        classifier: r.classifier || null,
      };
      routerMap[r.model_key] = entry;
      // 兼容 route_id 存 UUID 的旧数据
      if (r.id && r.id !== r.model_key) routerMap[r.id] = entry;
    }
  }
  _gateway.setRouterModelMap(routerMap);

  // 应用 api_key / shim → 路由改写（与 Electron syncGatewayFromConfig 一致）
  const PROTOCOL_PATH = {
    anthropic: '/v1/messages',
    responses: '/v1/responses',
    openai:    '/v1/chat/completions',
    gemini:    '/v1beta',
  };
  const toolProto = {};
  try {
    for (const t of require('../electron/config-loader').tools()) {
      toolProto[t.id] = t.protocol;
    }
  } catch {}

  const appControls = [];
  const keyScene = {};
  for (const app of apps) {
    const ctrl = { app_id: app.id, app_name: app.name };
    if ((app.link_method === 'api-key' || app.link_method === 'manual') && app.api_key) {
      appControls.push({ ...ctrl, match: { key: app.api_key } });
      const appRouteIds = (Array.isArray(app.route_ids) && app.route_ids.length)
        ? app.route_ids
        : (app.route_id ? [app.route_id] : []);
      if (appRouteIds.length) {
        // Claude Desktop：claude-* 名 → route；api_key 仅识别应用
        if (String(app.preset_id || app.id).includes('claude-desktop')) {
          const cms = (() => { try { return configLoader.claudeModels(); } catch { return []; } })();
          bindClaudeRoutesToKeyScene(keyScene, app.api_key, appRouteIds, routes, cms);
        }
      }
    } else if (app.link_method === 'shim' && app.agent_id) {
      const p = PROTOCOL_PATH[toolProto[app.agent_id]];
      if (p) appControls.push({ ...ctrl, match: { path: p } });
    }
  }
  _gateway.setAppControls(appControls);
  _gateway.setKeySceneMap(keyScene);
  // Claude Desktop 透明 mask 名（与 Electron syncGatewayFromConfig 一致）
  try { _gateway.setClaudeModels(configLoader.claudeModels()); } catch {}

  const cc = lc.cloud_config || {};
  const serverUrl = cc.url || defaultServerUrlFromEnv() || '';
  _gateway.setBackendConfig({ url: serverUrl || null, token: cc.token || null });
  const userJwt = lc.user_session?.jwt || null;
  if (_gateway.setUserAuth) _gateway.setUserAuth(userJwt);
}

/** 用户 JWT（个人页登录 token，非 P2P cloud_config.token） */
function userBearerToken(req) {
  if (!req?.headers) return '';
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

function resolveBillingServerUrl(req) {
  const hdr = req?.headers?.['x-tokenbank-server'] || req?.headers?.['X-TokenBank-Server'];
  if (hdr) {
    const fromHdr = cloudBilling.normalizeBase(String(hdr));
    if (fromHdr) return fromHdr;
  }
  const cfg = readLocalConfig() || {};
  return cloudBilling.normalizeBase(cfg.cloud_config?.url) || defaultServerUrlFromEnv() || '';
}

function applyUserBillingCfg(cfg) {
  try { billingConfig.applyPricingOverrides(cfg.provider_pricing_overrides || {}); } catch {}
  writeLocalConfig(cfg);
  syncAgentProviderModelsFromAccounts();
}

/** 后台拉 /api/catalog 写入 ~/.tokenbank/providers.registry.yaml（与 Electron 对齐） */
function catalogSyncOpts(req, body = {}) {
  const serverUrl = catalogSync.resolveSyncServerUrl({
    baseUrl: body.serverUrl || resolveBillingServerUrl(req),
    readLocalConfig,
  });
  const token = userBearerToken(req) || readLocalConfig()?.user_session?.jwt || null;
  // 设置页 URL 与 cloud_config 不一致时，以本次同步地址为准写回
  if (serverUrl) {
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    const cur = cloudBilling.normalizeBase(lc.cloud_config?.url || '');
    if (cur !== serverUrl) {
      lc.cloud_config = { ...(lc.cloud_config || {}), url: serverUrl };
      writeLocalConfig(lc);
    }
  }
  return { readLocalConfig, applyUserBillingCfg, baseUrl: serverUrl, serverUrl, token };
}

function scheduleCatalogSync(req) {
  return catalogSync.scheduleBackgroundSync(catalogSyncOpts(req));
}

async function syncProviderCatalogApi(req, body = {}) {
  return catalogSync.syncCatalogToRegistry(catalogSyncOpts(req, body));
}

/** 账户/刊例价模型 → agent config（与 Electron main 对齐） */
function syncAgentProviderModelsFromAccounts() {
  try {
    const agentCfg = readAgentConfig() || { providers: [] };
    const localCfg = readLocalConfig() || {};
    const { cfg, changed } = billingConfig.syncGatewayProvidersFromAccounts(agentCfg, localCfg);
    if (changed) writeAgentConfig(cfg);
  } catch (e) {
    console.warn('[admin-api] sync provider models skipped:', e.message);
  }
}

async function pullUserBillingApi(_token, _req) {
  configLoader.reloadRegistryDoc();
  const cfg = readLocalConfig() || { scene_routes: [], local_keys: [] };
  applyUserBillingCfg(cfg);
  return billingConfig.getUserAccounts(cfg);
}

async function pushUserBillingApi(token, req, patch) {
  let cfg = readLocalConfig() || { scene_routes: [], local_keys: [] };
  if (Array.isArray(patch.user_subscriptions)) cfg.user_subscriptions = patch.user_subscriptions;
  if (Array.isArray(patch.user_payg_providers)) cfg.user_payg_providers = patch.user_payg_providers;
  if (patch.subscription_plans && typeof patch.subscription_plans === 'object') {
    cfg.subscription_plans = patch.subscription_plans;
  }
  if (patch.provider_pricing_overrides && typeof patch.provider_pricing_overrides === 'object') {
    cfg.provider_pricing_overrides = patch.provider_pricing_overrides;
  }
  if (patch.source_template_overrides && typeof patch.source_template_overrides === 'object') {
    cfg.source_template_overrides = patch.source_template_overrides;
  }
  if (patch.custom_source_templates && typeof patch.custom_source_templates === 'object') {
    cfg.custom_source_templates = patch.custom_source_templates;
  }
  if (patch.direct_source_billing && typeof patch.direct_source_billing === 'object') {
    cfg.direct_source_billing = patch.direct_source_billing;
  }
  writeLocalConfig(cfg);
  syncGateway(cfg);
  applyUserBillingCfg(cfg);
  return billingConfig.getUserAccounts(cfg);
}

const { providerTestTargets, logProviderTestProbe, parseProviderProbeError } = require('../shared/provider-test');
const { resolveOutboundProxyAgent } = require('../shared/outbound-proxy');

// ── testProvider ─────────────────────────────────────────────────────────────

function probeProviderTarget(target, ctx = {}) {
  logProviderTestProbe(ctx, target, 'request');
  const method = String(target.method || 'GET').toUpperCase();
  const bodyStr = target.body ? JSON.stringify(target.body) : '';
  const headers = { ...(target.headers || {}) };
  if (bodyStr) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
  }
  const agent = resolveOutboundProxyAgent({
    provider: ctx.provider,
    urlStr: target.url,
    networkProxy: ctx.networkProxy,
  });
  return new Promise((resolve) => {
    let url;
    try { url = new URL(target.url); }
    catch (_) { resolve({ ok: false, status: 0, error: 'Invalid URL' }); return; }

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method,
        headers,
        timeout: 30000,
        ...(agent ? { agent } : {}),
      },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; if (body.length > 400) body = body.slice(0, 400); });
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          let errDetail = body.trim();
          if (!ok && errDetail) {
            try {
              const j = JSON.parse(body);
              errDetail = j.error?.message || j.message || errDetail;
            } catch { /* 非 JSON 则保留原文 */ }
          }
          resolve({
            ok,
            status: res.statusCode,
            error: ok ? undefined : (errDetail || `HTTP ${res.statusCode}`),
          });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  }).then((out) => {
    logProviderTestProbe(ctx, target, 'response', out);
    return out;
  });
}

async function testProvider(p = {}) {
  const agentCfg = readAgentConfig() || {};
  const ctx = {
    id: p.id,
    api_format: p.api_format,
    base_url: p.base_url,
    provider: { proxy: p.proxy },
    networkProxy: agentCfg.network_proxy,
  };
  console.log('[provider-test] start', { id: ctx.id, api_format: ctx.api_format, base_url: ctx.base_url });
  const { targets, error } = providerTestTargets(p);
  if (error === 'missing_api_key') return { ok: false, error: 'API Key required' };
  if (error === 'missing_base_url') return { ok: false, error: 'Base URL required' };
  if (error === 'invalid_base_url') return { ok: false, error: 'Invalid Base URL' };
  if (!targets.length) return { ok: false, error: 'No probe target' };

  let last = { ok: false, status: 0, error: 'Connection failed' };
  for (const target of targets) {
    last = await probeProviderTarget(target, ctx);
    if (last.ok) return last;
  }
  return last;
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function checkAuth(_req, _res) {
  // The admin API is a local management interface — access control is left to
  // the operator (firewall / bind address).  Using cloud_config.token as an
  // admin password was a design mistake: it is a P2P connection credential,
  // not a local secret, and creates a circular dependency when trying to set
  // it for the first time via the UI.
  return true;
}

// ── Request router ────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  setCors(res);

  // Auth check (runs for all methods including OPTIONS)
  if (!checkAuth(req, res)) return;

  // OPTIONS preflight — after auth so unauthenticated clients don't probe the API
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url    = req.url.split('?')[0];
  const method = req.method.toUpperCase();

  // ── Gateway routes ──────────────────────────────────────────────────────────

  if (method === 'GET' && url === '/api/gateway/status') {
    return json(res, 200, _gateway.getStatus());
  }

  // Docker / CLI Web：设备注册用标识（无电脑名时回退 IP）
  if (method === 'GET' && url === '/api/device-identity') {
    const st = _gateway.getStatus();
    let pkgVer = '0.0.0';
    try { pkgVer = require('../package.json').version || pkgVer; } catch (_) {}
    return json(res, 200, {
      ...deviceIdentity.collect({
        type: 'cli',
        port: st?.port || 11430,
        version: pkgVer,
      }),
      device_id: ensureDeviceId('cli'),
    });
  }

  if (method === 'POST' && url === '/api/gateway/refresh-peer-models') {
    try {
      if (!isCommunityP2pEnabled(readAgentConfig())) {
        _gateway?.setPeerModels?.([]);
        return json(res, 200, { ok: true, peerModels: [] });
      }
      const names = await refreshGatewayPeerModels(_gateway, readLocalConfig, defaultServerUrlFromEnv, readAgentConfig);
      return json(res, 200, { ok: true, peerModels: names });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // CLI Web：同源代理本地 /v1/models，避免浏览器跨端口拉取失败后误回退云端社区列表
  if (method === 'GET' && url === '/api/gateway/v1-models') {
    const st = _gateway?.getStatus?.() || {};
    if (!st.running || !st.port) return json(res, 200, { object: 'list', data: [] });
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${st.port}/v1/models`, (r) => {
        let buf = '';
        r.on('data', (c) => { buf += c; });
        r.on('end', () => {
          try { json(res, 200, JSON.parse(buf)); }
          catch { json(res, 200, { object: 'list', data: [] }); }
          resolve();
        });
      }).on('error', () => {
        json(res, 200, { object: 'list', data: [] });
        resolve();
      });
    });
  }

  // 网关测速表代理（CLI/Docker Web 无 electronAPI，前端 useSpeedMap 走这里取速）
  if (method === 'GET' && url === '/api/gateway/speed') {
    const st = _gateway?.getStatus?.() || {};
    if (!st.running || !st.port) return json(res, 200, {});
    return new Promise((resolve) => {
      http.get(`http://127.0.0.1:${st.port}/speed`, (r) => {
        let buf = '';
        r.on('data', (c) => { buf += c; });
        r.on('end', () => {
          try { json(res, 200, JSON.parse(buf)); }
          catch { json(res, 200, {}); }
          resolve();
        });
      }).on('error', () => { json(res, 200, {}); resolve(); });
    });
  }

  if (method === 'GET' && url === '/api/gateway/log') {
    return json(res, 200, { log: _gateway.getLog() });
  }

  if (method === 'GET' && url === '/api/gateway/stats') {
    return json(res, 200, _gateway.getDailyStats());
  }

  // 本地 SQLite 统计（Dashboard / Profile / 盘点页；与 gateway :11430 同源逻辑）
  if (method === 'GET' && url.startsWith('/api/local-stats')) {
    const qs = new URL('http://x' + req.url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 1));
    try { appsUsage.maybeSyncSessionTelemetry(localStats); } catch {}
    const data = (localStats && typeof localStats.queryDashboard === 'function')
      ? localStats.queryDashboard(days)
      : {
          total_calls: 0, total_tokens: 0, total_cost: 0,
          tiers: { free: 0, p2p: 0, paid: 0 },
          hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, tokens: 0, cost_usd: 0, isNow: false })),
          daily: [],
          models: [], keys: [], providers: [], agent_sources: [],
        };
    return json(res, 200, data);
  }

  if (method === 'GET' && url.startsWith('/api/model-provider-latency')) {
    const qs = new URL('http://x' + req.url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 7));
    try {
      const since = localStats.sinceTsForDays(days);
      return json(res, 200, localStats.queryModelProviderLatency(since));
    } catch {
      return json(res, 200, {});
    }
  }

  // 压缩比统计（盘点页 / Dashboard；与 local-gateway :11430 同源）
  if (method === 'GET' && url.startsWith('/api/compression-stats')) {
    const qs = new URL('http://x' + req.url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 1));
    let summary = { count: 0, before: 0, after: 0, saved: 0, ratio: 0, saved_usd: 0, models: [] };
    try {
      let rates = null;
      if (localStats?.sinceTsForDays && localStats?.queryGatewayInputCostRate) {
        rates = localStats.queryGatewayInputCostRate(localStats.sinceTsForDays(days));
      }
      summary = compressionReport.readCompressionSummary(days, rates);
    } catch {}
    return json(res, 200, summary);
  }

  if (method === 'POST' && url === '/api/gateway/restart') {
    _gateway.restart();
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && url === '/api/gateway/test-provider') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const result = await testProvider(body);
    return json(res, 200, result);
  }

  // ── Agent config routes ─────────────────────────────────────────────────────

  if (method === 'GET' && url === '/api/config') {
    return json(res, 200, readAgentConfig() || {});
  }

  if (method === 'POST' && url === '/api/config') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const existing = readAgentConfig() || {};
    const merged = { ...existing, ...body };
    if (Array.isArray(body.providers)) merged.providers = body.providers;
    writeAgentConfig(merged);
    syncAgentProviderModelsFromAccounts();
    try { syncGateway(readLocalConfig() || {}); } catch {}
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && url === '/api/provider-catalog') {
    configLoader.reloadRegistryDoc();
    return json(res, 200, configLoader.builtinCatalogPayload());
  }

  if (method === 'POST' && url === '/api/provider-catalog/sync') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const result = await syncProviderCatalogApi(req, body || {});
    const payload = {
      ...result,
      serverUrl: catalogSync.resolveSyncServerUrl(catalogSyncOpts(req, body || {})),
      catalog: configLoader.builtinCatalogPayload(),
      template_count: (configLoader.billingSourcesList() || []).length,
    };
    return json(res, result.ok ? 200 : 502, payload);
  }

  // ── P2P 贡献 Agent（Docker / CLI，对应 Electron agent:* IPC）────────────────

  if (method === 'GET' && url === '/api/agent/status') {
    return json(res, 200, { running: agentControl.isRunning() });
  }

  if (method === 'GET' && url === '/api/agent/logs') {
    return json(res, 200, { logs: agentControl.getLogs() });
  }

  if (method === 'POST' && url === '/api/agent/start') {
    agentControl.startAgent();
    return json(res, 200, { running: agentControl.isRunning() });
  }

  if (method === 'POST' && url === '/api/agent/stop') {
    agentControl.stopAgent();
    return json(res, 200, { running: false });
  }

  // ── Local config routes ─────────────────────────────────────────────────────

  if (method === 'GET' && url === '/api/local-config') {
    return json(res, 200, readLocalConfig() || {});
  }

  if (method === 'POST' && url === '/api/local-config/cloud-config') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    lc.cloud_config = { url: body.url || '', token: body.token || '' };
    writeLocalConfig(lc);
    syncGateway(lc);
    refreshGatewayPeerModels(_gateway, readLocalConfig, defaultServerUrlFromEnv, readAgentConfig).catch(() => {});
    scheduleCatalogSync(req);
    return json(res, 200, { ok: true });
  }

  // 登录态同步：供 CLI 网关进程获知用户 JWT（心跳 / 用量上报）
  if (method === 'POST' && url === '/api/user-session') {
    const jwt = userBearerToken(req);
    if (!jwt) return json(res, 401, { error: 'Not authenticated' });
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    lc.user_session = { jwt };
    writeLocalConfig(lc);
    if (_gateway?.setUserAuth) _gateway.setUserAuth(jwt);
    reporter.setUserJwt(jwt);
    if (_reporterGetStats) reporter.start(_reporterGetStats);
    scheduleCatalogSync(req);
    return json(res, 200, { ok: true });
  }

  if (method === 'DELETE' && url === '/api/user-session') {
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    delete lc.user_session;
    writeLocalConfig(lc);
    if (_gateway?.setUserAuth) _gateway.setUserAuth(null);
    reporter.setUserJwt(null);
    reporter.stop();
    agentControl.stopAgent();
    try {
      const ac = readAgentConfig() || {};
      delete ac.worker_key;
      delete ac.server_url;
      writeAgentConfig(ac);
    } catch {}
    return json(res, 200, { ok: true });
  }

  // 个人页：订阅 / 按量（与 Electron 相同，经云端 /user/accounts 同步）
  if (method === 'GET' && url === '/api/user-accounts') {
    const data = await pullUserBillingApi(userBearerToken(req), req);
    return json(res, 200, data);
  }

  if (method === 'PUT' && url === '/api/user-accounts') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const data = await pushUserBillingApi(userBearerToken(req), req, body);
    return json(res, 200, data);
  }

  // ── Apps（Docker Web UI 新建/编辑应用）──────────────────────────────────────

  if (method === 'GET' && url === '/api/apps') {
    const cfg = readAppsCfg();
    return json(res, 200, cfg.apps);
  }

  if (method === 'GET' && url === '/api/apps/claude-models') {
    try { return json(res, 200, configLoader.claudeModels() || []); }
    catch { return json(res, 200, []); }
  }

  if (method === 'POST' && url === '/api/apps/stats') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const list = body.apps || body.list || [];
    return json(res, 200, appsUsage.getAppStats(localStats, list));
  }

  if (method === 'POST' && url === '/api/apps/detail') {
    const body = await parseBody(req, res);
    if (body === null) return;
    return json(res, 200, appsUsage.getAppDetail(localStats, body.app, body.days));
  }

  if (method === 'POST' && url === '/api/apps/session-trace') {
    const body = await parseBody(req, res);
    if (body === null) return;
    return json(res, 200, appsUsage.getSessionTrace(localStats, body.agent_id, body.session_id));
  }

  if (method === 'GET' && url === '/api/apps/handoff-targets') {
    return json(res, 200, appsUsage.getHandoffTargets());
  }

  if (method === 'POST' && url === '/api/apps') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const cfg = readAppsCfg();
    const app = createAppRecord(body);
    cfg.apps.push(app);
    persistAppsCfg(cfg);
    return json(res, 200, app);
  }

  const appMatch = url.match(/^\/api\/apps\/([^/]+)(\/regen-key)?$/);
  if (appMatch) {
    const appId = decodeURIComponent(appMatch[1]);
    const regen = !!appMatch[2];

    if (method === 'PUT') {
      const body = await parseBody(req, res);
      if (body === null) return;
      const cfg = readAppsCfg();
      const idx = cfg.apps.findIndex(a => a.id === appId);
      if (idx === -1) return json(res, 404, { error: 'not found' });
      const { api_key: _drop, id: _id, ...patch } = body;
      cfg.apps[idx] = { ...cfg.apps[idx], ...patch };
      persistAppsCfg(cfg);
      return json(res, 200, cfg.apps[idx]);
    }

    if (method === 'DELETE') {
      const cfg = readAppsCfg();
      cfg.apps = cfg.apps.filter(a => a.id !== appId);
      persistAppsCfg(cfg);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && regen) {
      const cfg = readAppsCfg();
      const idx = cfg.apps.findIndex(a => a.id === appId);
      if (idx === -1) return json(res, 404, { error: 'not found' });
      if (!(cfg.apps[idx].link_method === 'api-key' || cfg.apps[idx].link_method === 'manual')) {
        return json(res, 400, { error: 'not-key-app' });
      }
      cfg.apps[idx].api_key = 'sk-local-' + rndHex(16);
      persistAppsCfg(cfg);
      return json(res, 200, { ok: true, api_key: cfg.apps[idx].api_key });
    }
  }

  // ── Scene routes ────────────────────────────────────────────────────────────

  if (method === 'POST' && url === '/api/local-config/routes') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    if (!lc.scene_routes) lc.scene_routes = [];
    const key = String(body.model_key || '').trim();
    if (key) {
      const idx = lc.scene_routes.findIndex((r) => r && r.model_key === key);
      if (idx !== -1) {
        lc.scene_routes[idx] = Object.assign({}, lc.scene_routes[idx], {
          scene_name: body.scene_name || lc.scene_routes[idx].scene_name,
          icon: body.icon || lc.scene_routes[idx].icon,
          steps: body.steps === undefined ? lc.scene_routes[idx].steps : (body.steps || []),
          rules: body.rules === undefined ? lc.scene_routes[idx].rules : (body.rules || null),
          flow: body.flow === undefined ? lc.scene_routes[idx].flow : (body.flow || null),
          list_route: body.list_route === undefined ? !!lc.scene_routes[idx].list_route : !!body.list_route,
          user_owned: true,
        });
        writeLocalConfig(lc);
        syncGateway(lc);
        return json(res, 200, lc.scene_routes[idx]);
      }
    }
    const route = {
      id: rndHex(8),
      scene_name: body.scene_name || '',
      icon: body.icon || '\u{1F500}',
      steps: body.steps || [],
      rules: body.rules || null,
      flow: body.flow || null,
      model_key: key || ('llm-router-' + rndHex(6)),
      list_route: !!body.list_route,
      user_owned: true,
      created_at: new Date().toISOString(),
    };
    lc.scene_routes.push(route);
    writeLocalConfig(lc);
    syncGateway(lc);
    return json(res, 200, route);
  }

  const routeUpdateMatch = url.match(/^\/api\/local-config\/routes\/([^/]+)$/);
  if (routeUpdateMatch) {
    const id = routeUpdateMatch[1];

    if (method === 'PUT') {
      const body = await parseBody(req, res);
      if (body === null) return;
      const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
      const idx = (lc.scene_routes || []).findIndex((r) => r.id === id);
      if (idx === -1) return json(res, 404, { error: 'not found' });
      lc.scene_routes[idx] = Object.assign({}, lc.scene_routes[idx], {
        scene_name: body.scene_name,
        icon: body.icon,
        steps: body.steps,
        ...(body.rules !== undefined ? { rules: body.rules || null } : {}),
        ...(body.flow !== undefined ? { flow: body.flow || null } : {}),
        ...(body.list_route !== undefined ? { list_route: !!body.list_route } : {}),
      });
      writeLocalConfig(lc);
      syncGateway(lc);
      return json(res, 200, lc.scene_routes[idx]);
    }

    if (method === 'DELETE') {
      const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
      lc.scene_routes = (lc.scene_routes || []).filter((r) => r.id !== id);
      writeLocalConfig(lc);
      syncGateway(lc);
      return json(res, 200, { ok: true });
    }
  }

  // ── Local keys ──────────────────────────────────────────────────────────────

  if (method === 'POST' && url === '/api/local-config/keys') {
    const body = await parseBody(req, res);
    if (body === null) return;
    const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
    if (!lc.local_keys) lc.local_keys = [];
    const key = {
      id: rndHex(8),
      key: 'sk-local-' + rndHex(16),
      note: body.note || '',
      model_key: null,
      created_at: new Date().toISOString(),
    };
    lc.local_keys.push(key);
    writeLocalConfig(lc);
    syncGateway(lc);
    return json(res, 200, key);
  }

  const keyMatch = url.match(/^\/api\/local-config\/keys\/([^/]+)(\/bind)?$/);
  if (keyMatch) {
    const id   = keyMatch[1];
    const bind = !!keyMatch[2];

    if (method === 'DELETE' && !bind) {
      const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
      lc.local_keys = (lc.local_keys || []).filter((k) => k.id !== id);
      writeLocalConfig(lc);
      syncGateway(lc);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && bind) {
      const body = await parseBody(req, res);
      if (body === null) return;
      const lc = readLocalConfig() || { scene_routes: [], local_keys: [] };
      const key = (lc.local_keys || []).find((k) => k.id === id);
      if (!key) return json(res, 404, { error: 'not found' });
      key.model_key = body.model_key || null;
      writeLocalConfig(lc);
      syncGateway(lc);
      return json(res, 200, key);
    }
  }

  // ── Static file serving (SPA) ───────────────────────────────────────────────

  if (!fs.existsSync(DIST_DIR)) {
    return json(res, 404, { error: 'Frontend not built. Run: npm run build' });
  }

  // Try to serve the exact path first
  const relPath = url === '/' ? 'index.html' : url.replace(/^\//, '');
  if (serveStatic(res, relPath)) return;

  // 未实现的 /api/* 返回 JSON 404，避免 SPA index.html 被 fetch().json() 误解析
  if (url.startsWith('/api/')) {
    return json(res, 404, { error: 'Not found' });
  }

  // SPA fallback — serve index.html for non-asset paths
  if (!url.startsWith('/assets/')) {
    if (serveStatic(res, 'index.html')) return;
  }

  json(res, 404, { error: 'Not found' });
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Start the admin API server.
 * @param {number} port
 * @param {object} gatewayInstance  — the local-gateway module
 * @returns {http.Server}
 */
function start(port, gatewayInstance, bindHost = '127.0.0.1', opts = {}) {
  _gateway = gatewayInstance;
  _reporterGetStats = opts.reporterGetStats || null;

  _server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[admin-api] unhandled error:', err.message);
      try { json(res, 500, { error: 'Internal server error' }); } catch (_) {}
    });
  });

  _server.listen(port, bindHost, () => {
    console.log(`[admin-api] listening on ${bindHost}:${port}`);
    scheduleCatalogSync(null);
  });

  return _server;
}

/**
 * Stop the admin API server.
 */
function stop() {
  agentControl.stopAgent();
  if (_server) {
    _server.close();
    _server = null;
  }
}

module.exports = { start, stop };
