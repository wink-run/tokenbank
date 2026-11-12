// client/electron/cli-endpoint-config.js
// Claude Code CLI 的 settings.json 托管。
//
// 背景：claude 合并 env 是 {...process.env, ...settings.env} —— settings.json 的 env 永远
// 压过 shim 注入。若其他代理/工具改写了 settings.json 的 ANTHROPIC_BASE_URL，shim 再怎么
// 注入也会被盖掉 → TokenBank 纳管失效。因此选路由(hosted 且有 route)时主动占住 settings：
//   env.ANTHROPIC_BASE_URL   = 本机网关
//   env.ANTHROPIC_AUTH_TOKEN = PROXY_MANAGED（占位标记，不暴露真实 sk-local key；
//     网关按「非 api-key 调用方」走 claudeShimScene）
//   去掉写死的 model；原始配置备份到 .tokenbank-bak。
// 直连/还原(无 route / forceDirect) → 从 .tokenbank-bak 还原；无备份则清掉托管 env 键。
// 「已托管」靠 base_url 是否指向本机网关判定。
'use strict';

const fs = require('fs');
const path = require('path');

/** settings.json 里的托管占位 token（不写真实 api_key，避免被其他工具抄走/覆盖语义） */
const PROXY_MANAGED_TOKEN = 'PROXY_MANAGED';

function isGatewayBaseUrl(u) {
  return /(?:127\.0\.0\.1|localhost):11430/.test(String(u || ''));
}
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** 构造 TokenBank 托管用的 env 段（对齐 cc-switch：代理接管只占 BASE_URL + TOKEN）。
 * 不写 CLAUDE_CODE_MAX_CONTEXT_TOKENS / AUTO_COMPACT_WINDOW —— 窗口随上游模型变化，
 * 硬编码进 settings.json 会误伤大窗口或过早压缩；由 Claude Code / 上游自行决定。
 */
function managedEnv(gatewayOrigin) {
  return {
    ANTHROPIC_AUTH_TOKEN: PROXY_MANAGED_TOKEN,
    ANTHROPIC_BASE_URL: gatewayOrigin || 'http://127.0.0.1:11430',
  };
}

/** 解析 settings.json 所在目录：多实例用 instance.config_dir，否则 Docker/单实例用 ~/.claude */
function resolveClaudeSettingsDir(app, opts = {}) {
  const expandHome = opts.expandHome || ((p) => p);
  if (app.instance && app.instance.config_dir) {
    return expandHome(String(app.instance.config_dir));
  }
  if (app.agent_id === 'claude-code') {
    return path.join(expandHome('~'), '.claude');
  }
  return null;
}

/**
 * 同步单个 Claude Code 实例的 settings.json（OAuth / 兼容端点统一处理）。
 * @param app  应用记录（link_method==='shim'；目录见 resolveClaudeSettingsDir）
 * @param opts { expandHome:(p)=>string, gatewayOrigin:string, forceDirect?:boolean }
 * @returns 'routed' | 'direct' | 'skip'（便于测试与日志）
 */
function syncCliInstanceEndpointConfig(app, opts = {}) {
  if (!app || app.link_method !== 'shim') return 'skip';
  // 目前仅 Claude Code 读 settings.json 的 ANTHROPIC_*；Codex 走 CODEX_HOME，勿误写
  if (app.agent_id && app.agent_id !== 'claude-code') return 'skip';

  const dir = resolveClaudeSettingsDir(app, opts);
  if (!dir) return 'skip';
  const file = path.join(dir, 'settings.json');
  const bak = file + '.tokenbank-bak';

  const curObj = fs.existsSync(file) ? readJsonSafe(file) : null;
  const curManaged = isGatewayBaseUrl(curObj && curObj.env && curObj.env.ANTHROPIC_BASE_URL);
  const bakObj = fs.existsSync(bak) ? readJsonSafe(bak) : null;
  const bakManaged = isGatewayBaseUrl(bakObj && bakObj.env && bakObj.env.ANTHROPIC_BASE_URL);
  // 原始配置：优先未托管的 bak；否则当前文件（尚未被托管时）
  const orig = (bakObj && !bakManaged) ? bakObj : (curObj && !curManaged ? curObj : null);

  const routed = !opts.forceDirect
    && !!app.hosted && !!(app.route_id || (Array.isArray(app.route_ids) && app.route_ids.length));

  if (routed) {
    // 备份原始（仅首次；当前已是托管配置则不备份，避免把网关配置存成 bak）
    if (curObj && !curManaged && !fs.existsSync(bak)) {
      try { fs.copyFileSync(file, bak); } catch {}
    }
    // 保留顶层非 env 键（theme / permissions / enabledPlugins 等，对齐 cc-switch 不全量抹掉）
    // env 整段换成托管最小集，清掉兼容端点残留及历史窗口硬编码
    const next = { ...(orig || curObj || {}) };
    next.env = managedEnv(opts.gatewayOrigin);
    delete next.model;   // 顶层写死的 model 去掉，路由交给网关
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    return 'routed';
  }

  // 直连/还原：优先从 bak 整份恢复
  if (bakObj && !bakManaged) {
    try { fs.copyFileSync(bak, file); } catch {}
    return 'direct';
  }
  // 无有效 bak（如 OAuth 原本无 settings、由我们新建）：清掉托管 env 键
  if (curManaged && curObj) {
    const next = { ...curObj };
    if (next.env && typeof next.env === 'object') {
      const env = { ...next.env };
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
      if (Object.keys(env).length) next.env = env;
      else delete next.env;
    }
    if (!Object.keys(next).length) {
      try { fs.unlinkSync(file); } catch {}
    } else {
      try { fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8'); } catch {}
    }
    return 'direct';
  }
  return 'skip';
}

module.exports = {
  syncCliInstanceEndpointConfig,
  resolveClaudeSettingsDir,
  isGatewayBaseUrl,
  readJsonSafe,
  PROXY_MANAGED_TOKEN,
  managedEnv,
};
