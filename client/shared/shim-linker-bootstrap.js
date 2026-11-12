// client/shared/shim-linker-bootstrap.js
// 桌面 main.js 与 Docker gateway.js 共用的 shim 密钥解析与 Claude Code settings 托管。
'use strict';

const os = require('os');

function expandHomeFallback(p) {
  const home = process.env.HOME || os.homedir();
  return String(p || '').replace(/^~(?=$|[/\\])/, home);
}

/** 已托管且绑路由的 shim 应用 → api_key（供 agentLinker.setKeyResolver） */
function resolveShimAppApiKeyForTool(apps, toolId) {
  const a = (apps || []).find((x) => x.link_method === 'shim' && x.agent_id === toolId);
  if (!a || a.hosted === false) return null;
  const hasRoute = !!(a.route_id || (Array.isArray(a.route_ids) && a.route_ids.length));
  if (!hasRoute) return null;
  return a.api_key || null;
}

/** 与桌面 main.js 一致：注入 key / instances 解析器 */
function installShimLinkerResolvers(readLocalConfigFn) {
  const agentLinker = require('../electron/agent-linker');
  const read = typeof readLocalConfigFn === 'function' ? readLocalConfigFn : () => ({ apps: [] });

  agentLinker.setKeyResolver((toolId) => {
    const cfg = read() || {};
    return resolveShimAppApiKeyForTool(cfg.apps, toolId);
  });

  agentLinker.setInstancesResolver((toolId) => {
    const apps = (read().apps || []);
    return apps
      .filter((x) => x.link_method === 'shim' && x.agent_id === toolId && x.instance && !x.instance.invalid)
      .map((x) => ({
        config_dir: x.instance.config_dir,
        api_key: x.api_key,
        dir_glob: x.instance.dir_glob,
        is_default: !!x.instance.is_default,
        routed: !!(x.hosted && (x.route_id || (Array.isArray(x.route_ids) && x.route_ids.length))),
      }));
  });
}

function defaultGatewayOrigin() {
  try {
    const cl = require('../electron/config-loader');
    return `http://${cl.gatewayCtx().reverse}`;
  } catch {
    const port = process.env.GATEWAY_PORT || 11430;
    return `http://127.0.0.1:${port}`;
  }
}

function resolveExpandHome(opts) {
  if (opts.expandHome) return opts.expandHome;
  try {
    return require('../electron/config-loader').expandHome;
  } catch {
    return expandHomeFallback;
  }
}

/** 同步 Claude Code shim 的 ~/.claude/settings.json（无 instance 时用默认目录） */
function syncShimClaudeEndpointConfig(app, opts = {}) {
  if (!app || app.link_method !== 'shim' || app.agent_id !== 'claude-code') return 'skip';
  const cl = require('../electron/cli-endpoint-config');
  return cl.syncCliInstanceEndpointConfig(app, {
    expandHome: resolveExpandHome(opts),
    gatewayOrigin: opts.gatewayOrigin || defaultGatewayOrigin(),
    forceDirect: opts.forceDirect,
  });
}

/** 启动时把已托管且绑路由的 Claude Code 应用 settings 补齐 */
function syncAllHostedClaudeCodeEndpoints(readLocalConfigFn, opts = {}) {
  const cfg = (typeof readLocalConfigFn === 'function' ? readLocalConfigFn() : null) || {};
  for (const app of cfg.apps || []) {
    if (app.link_method !== 'shim' || app.agent_id !== 'claude-code') continue;
    const hasRoute = !!(app.route_id || (Array.isArray(app.route_ids) && app.route_ids.length));
    if (!app.hosted || !hasRoute) continue;
    try {
      syncShimClaudeEndpointConfig(app, opts);
    } catch (e) {
      console.warn('[shim-linker] claude endpoint sync:', e && e.message);
    }
  }
}

module.exports = {
  resolveShimAppApiKeyForTool,
  installShimLinkerResolvers,
  syncShimClaudeEndpointConfig,
  syncAllHostedClaudeCodeEndpoints,
  defaultGatewayOrigin,
};
