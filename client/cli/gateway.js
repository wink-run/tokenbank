// client/cli/gateway.js
// CLI entry point — same gateway functionality as the Electron desktop app.
// Usage:
//   node gateway.js start [--port 11430] [--admin-port 11431]
//   node gateway.js status
//   node gateway.js restart
//   node gateway.js keys
//   node gateway.js help
'use strict';

const http = require('http');
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const deviceIdentity = require('../shared/device-identity');
const { ensureDeviceId } = require('../shared/device-id');
const pkg = require('../package.json');

const gateway  = require('../electron/local-gateway');
const configLoader = require('../electron/config-loader');
const adminApi = require('./admin-api');
const agentControl = require('./agent-control');
const reporter = require('../shared/device-reporter');
const { readLocalConfig, readAgentConfig, ensureLocalConfig } = require('../shared/config-loader');
const { defaultServerUrlFromEnv } = require('../shared/default-server-url');
const { refreshGatewayPeerModels } = require('../shared/peer-models-sync');
const { initGatewayTelemetry } = require('../shared/telemetry');
const {
  installShimLinkerResolvers,
  syncAllHostedClaudeCodeEndpoints,
  defaultGatewayOrigin,
} = require('../shared/shim-linker-bootstrap');

const PEER_MODELS_POLL_MS = 60_000;
let _peerModelsTimer = null;

// ── Arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { command: null, port: 11430, adminPort: 11431 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!args.command && !a.startsWith('--')) {
      args.command = a;
    } else if (a === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10);
    } else if (a === '--admin-port' && argv[i + 1]) {
      args.adminPort = parseInt(argv[++i], 10);
    }
  }
  return args;
}

// ── Helpers for remote commands ───────────────────────────────────────────────

function adminRequest(adminPort, method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: adminPort,
        path: urlPath,
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json' },
          token ? { Authorization: `Bearer ${token}` } : {},
          data ? { 'Content-Length': Buffer.byteLength(data) } : {}
        ),
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
          catch (_) { resolve({ status: res.statusCode, body: buf }); }
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getToken(adminPort) {
  const lc = readLocalConfig() || {};
  return lc.cloud_config?.token || '';
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStart(port, adminPort) {
  // 贡献 Agent 与网关同进程：转发必须走 loopback，X-P2P-Hop 才能阻断 P2P 回环
  process.env.TOKENBANK_CLI = '1';
  process.env.GATEWAY_PORT = String(port);

  // 首次启动自动创建 ~/.llm-agent/local-config.json（Docker 挂载目录同理）
  const lc = ensureLocalConfig();
  try { ensureDeviceId('cli'); } catch (e) {
    console.warn('[device-id] ensure skipped:', e.message);
  }
  // Docker 端口映射需监听 0.0.0.0；本机 CLI 默认仍用 127.0.0.1
  const bindHost = process.env.GATEWAY_BIND_HOST
    || (fs.existsSync('/.dockerenv') ? '0.0.0.0' : '127.0.0.1');

  // Build router map from scene_routes
  const routerMap = {};
  for (const r of (lc.scene_routes || [])) {
    if (r.model_key && r.steps?.length) {
      routerMap[r.model_key] = { steps: r.steps, scene_name: r.scene_name };
    }
  }
  gateway.setRouterModelMap(routerMap);
  // Claude Desktop 透明 mask 名（与 Electron main.js 一致）
  try { gateway.setClaudeModels(configLoader.claudeModels()); } catch {}

  // 云端模型和设备注册都不参与监听。先把端口打开，避免登录或拉模型把进程卡住。
  const cc = lc.cloud_config || {};
  const serverUrl = cc.url || defaultServerUrlFromEnv() || null;

  // 与 Electron main.js 一致：供 enabledProviders /v1/models 按个人页登记过滤付费 catalog 模板
  gateway.setLocalConfigReader(readLocalConfig);

  // 与桌面 main.js 一致：已绑路由的 shim 应用在 spawn 时注入 ANTHROPIC_AUTH_TOKEN
  installShimLinkerResolvers(readLocalConfig);
  try {
    syncAllHostedClaudeCodeEndpoints(readLocalConfig, {
      gatewayOrigin: defaultGatewayOrigin(),
    });
  } catch (e) {
    console.warn('[gateway] claude settings bootstrap:', e && e.message);
  }

  // Start HTTP gateway
  gateway.start(port, readAgentConfig, undefined, bindHost);
  console.log(`[gateway] HTTP gateway started on port ${port}`);

  // 本地统计 + 会话补录（与 Electron 共用 ~/.tokenbank/local-stats.db）
  const telemetry = initGatewayTelemetry(gateway);

  // Start admin API（传入 reporter 回调，供 Web 登录后启动心跳）
  const reporterGetStats = async () => {
    const s = gateway.getDailyStats();
    const base = {
      calls: s.calls || 0,
      errors: s.errors || 0,
      providers_active: Object.keys(s.by_provider || {}).length,
    };
    // Include inventory snapshot for cloud dashboard (works without browser)
    try {
      const { localStats } = require('../shared/telemetry');
      const { buildAccountsSummary } = require('../shared/accounts-summary');
      const { buildAccountsConfig } = require('../shared/account-config-sync');
      let billingMod;
      try { billingMod = require('../electron/billing-config'); } catch (_) { billingMod = null; }
      const [d1, d7, d30] = await Promise.all([
        Promise.resolve(localStats.queryDashboard(1)).catch(() => null),
        Promise.resolve(localStats.queryDashboard(7)).catch(() => null),
        Promise.resolve(localStats.queryDashboard(30)).catch(() => null),
      ]);
      let accountsSummary = null;
      let accountsConfig = null;
      if (billingMod?.getUserAccounts) {
        try {
          // CLI 供给源在 ~/.llm-agent/local-config.json（非 electron/config-loader）
          const cfg = readLocalConfig() || {};
          const accounts = billingMod.getUserAccounts(cfg);
          accountsSummary = buildAccountsSummary(accounts);
          const agentCfg = readAgentConfig() || {};
          accountsConfig = buildAccountsConfig(accounts, agentCfg.providers || [], {
            includeSecrets: !!agentCfg.sync_account_secrets,
            syncAccountSecrets: !!agentCfg.sync_account_secrets,
            syncAccountSecretsAt: Number(agentCfg.sync_account_secrets_at) || 0,
          });
        } catch (_) {}
      }
      const attach = (snap) => {
        if (!snap) return snap;
        if (accountsSummary) snap.accounts_summary = accountsSummary;
        if (accountsConfig) snap.accounts_config = accountsConfig;
        return snap;
      };
      const inv = {};
      if (d1)  inv['1']  = attach(d1);
      if (d7)  inv['7']  = attach(d7);
      if (d30) inv['30'] = attach(d30);
      // 还没有用量快照时也上报账户配置，方便另一台终端立刻能同步
      if (!inv['1'] && (accountsSummary || accountsConfig)) inv['1'] = attach({});
      if (Object.keys(inv).length) base.inventory = inv;
    } catch (_) {}
    return base;
  };

  adminApi.start(adminPort, gateway, bindHost, { reporterGetStats });
  console.log(`[gateway] Admin API started on port ${adminPort}`);

  // P2P 在线模型：后台拉，失败就保持空列表，不挡就绪
  refreshGatewayPeerModels(gateway, readLocalConfig, defaultServerUrlFromEnv, readAgentConfig).catch((e) => {
    console.warn('[gateway] fetchPeerModels failed:', e && e.message);
  });
  if (_peerModelsTimer) clearInterval(_peerModelsTimer);
  _peerModelsTimer = setInterval(
    () => refreshGatewayPeerModels(gateway, readLocalConfig, defaultServerUrlFromEnv, readAgentConfig),
    PEER_MODELS_POLL_MS,
  );

  // 内置看护（与桌面版共用 electron/guardian）：handler 经 ipc-bridge 注册，这里登记检查并挂网关失败事件
  try {
    require('./ipc-bridge').init();
    require('../electron/guardian/ipc').startGuardian({ gateway });
  } catch (e) { console.warn('[guardian] start:', e.message); }

  // Init device reporter（仅登录用户才向云端注册/心跳）
  const identity = deviceIdentity.collect({
    type: 'cli',
    port,
    version: pkg.version || '0.0.0',
  });
  const userJwt = lc.user_session?.jwt || null;
  gateway.setUserAuth(userJwt);
  // 注册和心跳走云端，失败不影响本机网关。贡献 WebSocket 同样延后，不在启动路径上等待握手。
  reporter.init({
    type: 'cli',
    name: identity.name,
    platform: identity.platform,
    version: identity.version,
    serverUrl: serverUrl,
    userJwt,
  }).then(() => {
    if (userJwt) reporter.start(reporterGetStats);
  }).catch((e) => {
    console.warn('[device-reporter] init:', e && e.message);
  });

  console.log(`[gateway] Ready. Gateway :${port}  Admin :${adminPort}`);
  console.log('[gateway] Press Ctrl+C to stop.');

  // 与桌面版一致：配置 auto_start 且已有 worker_key 时再连贡献 WebSocket。连不上也不影响网关。
  const agentCfg = readAgentConfig();
  if (agentCfg?.auto_start && agentCfg?.worker_key) {
    setImmediate(() => agentControl.startAgent());
  }

  // Graceful shutdown
  function shutdown() {
    console.log('\n[gateway] Shutting down...');
    if (_peerModelsTimer) clearInterval(_peerModelsTimer);
    agentControl.stopAgent();
    reporter.stop();
    telemetry.shutdown();
    gateway.stop();
    adminApi.stop();
    process.exit(0);
  }

  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdStatus(adminPort) {
  const token = getToken(adminPort);
  try {
    const r = await adminRequest(adminPort, 'GET', '/api/gateway/status', null, token);
    console.log('Gateway status:', JSON.stringify(r.body, null, 2));
  } catch (err) {
    console.error('Could not reach admin API:', err.message);
    process.exit(1);
  }
}

async function cmdRestart(adminPort) {
  const token = getToken(adminPort);
  try {
    const r = await adminRequest(adminPort, 'POST', '/api/gateway/restart', {}, token);
    console.log('Restart:', JSON.stringify(r.body, null, 2));
  } catch (err) {
    console.error('Could not reach admin API:', err.message);
    process.exit(1);
  }
}

async function cmdKeys(adminPort) {
  const token = getToken(adminPort);
  try {
    const r = await adminRequest(adminPort, 'GET', '/api/local-config', null, token);
    if (r.status !== 200) {
      console.error('Error fetching config:', r.status, r.body);
      process.exit(1);
    }
    const keys = (r.body.local_keys || []);
    if (!keys.length) {
      console.log('No local keys configured.');
      return;
    }
    console.log('Local keys:');
    for (const k of keys) {
      const binding = k.model_key ? `  [bound → ${k.model_key}]` : '  [unbound]';
      console.log(`  ${k.key}  note: ${k.note || '(none)'}${binding}`);
    }
  } catch (err) {
    console.error('Could not reach admin API:', err.message);
    process.exit(1);
  }
}

function cmdHelp() {
  console.log(`
Usage: node gateway.js <command> [options]

Commands:
  start         Start the gateway and admin API server
  status        Show gateway status (requires running instance)
  restart       Restart the gateway (requires running instance)
  keys          List local API keys (requires running instance)
  help          Show this help message

Options (start only):
  --port        Gateway port       (default: 11430)
  --admin-port  Admin API port     (default: 11431)
`.trim());
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'start':
      await cmdStart(args.port, args.adminPort);
      break;
    case 'status':
      await cmdStatus(args.adminPort);
      break;
    case 'restart':
      await cmdRestart(args.adminPort);
      break;
    case 'keys':
      await cmdKeys(args.adminPort);
      break;
    case 'help':
    case null:
    default:
      cmdHelp();
      if (!args.command) process.exit(1);
      break;
  }
})().catch((err) => {
  console.error('[gateway] Fatal error:', err.message);
  process.exit(1);
});
