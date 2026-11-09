'use strict';
/**
 * 供给源 OAuth —— 单文件统一实现。
 *
 * 设计：一张 PROVIDERS 配置表 + 统一的 PKCE / 设备码 / token 刷新 / needsRefresh，
 * 真正因 provider 而异的部分（请求头/体注入 applyAuth、非标准刷新 refresh）作为表里的小钩子。
 * 新增一个 OAuth 供给源 = 往 PROVIDERS 加一条，而不是开一个新文件。
 *
 * provider 配置（存 config.json 的 provider 条目）：
 *   auth_type: 'oauth'
 *   oauth_provider: 'claude' | 'codex' | 'google' | 'copilot'
 *   credentials: { access_token, refresh_token, expires_at, ... }
 *
 * 对外接口（被 main.js / local-gateway.js 使用，保持稳定）：
 *   getModule(name) -> { mode, startLogin, completeLogin, poll }   // main.js 登录流用
 *   isOauthProvider(provider) / prepare(provider, getConfig, saveConfig)   // 网关代理前用
 */
const crypto = require('crypto');
const { claudeModelInfo, normalizeClaudeOAuthBody } = require('../claude-models');
const http = require('http');
const https = require('https');
const { resolveOutboundProxyAgent } = require('../../shared/outbound-proxy');

const REFRESH_SKEW_SEC = 180;
const OAUTH_HTTP_TIMEOUT_MS = 60_000;

/** 可选：由 main 注入，读取设置里的 network_proxy（与网关探测一致） */
let _getNetworkProxy = null;
function setNetworkProxyGetter(fn) {
  _getNetworkProxy = typeof fn === 'function' ? fn : null;
}
function currentNetworkProxy() {
  try { return _getNetworkProxy ? _getNetworkProxy() : null; } catch { return null; }
}

/** 将 DNS/代理/TLS 等底层错误转成可读提示（避免只剩 TypeError: fetch failed） */
function formatOauthNetworkError(err) {
  const msg = (err && err.message) || String(err || 'unknown');
  const hint = '请检查网络代理（设置中的网络代理，或 HTTPS_PROXY/HTTP_PROXY）后重试';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|socket hang up|certificate|UNABLE_TO|Request timeout|network/i.test(msg)) {
    return `连接 OAuth 失败：${msg}。${hint}`;
  }
  return msg;
}

/**
 * OAuth 出站请求：走 provider/network_proxy/环境变量代理（Node 原生 fetch 不读 HTTPS_PROXY）。
 * 返回 { status, text, ok }。
 */
function oauthHttp(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };
  const body = opts.body != null ? String(opts.body) : null;
  if (body && headers['Content-Length'] == null && headers['content-length'] == null) {
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  const agent = resolveOutboundProxyAgent({
    urlStr: url,
    networkProxy: currentNetworkProxy(),
  });
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method,
      headers,
      timeout: OAUTH_HTTP_TIMEOUT_MS,
      ...(agent ? { agent } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode || 0;
        resolve({ status, text, ok: status >= 200 && status < 300 });
      });
      res.on('error', (e) => reject(new Error(formatOauthNetworkError(e))));
    });
    req.on('error', (e) => reject(new Error(formatOauthNetworkError(e))));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(formatOauthNetworkError(new Error('Request timeout'))));
    });
    if (body) req.write(body);
    req.end();
  });
}
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CLI_VERSION = '2.1.161';
const CLAUDE_BILLING_PREFIX = 'x-anthropic-billing-header:';
const CLAUDE_BILLING_FINGERPRINT_SALT = '59cf53e54c78';
const CLAUDE_DEFAULT_HEADERS = {
  'User-Agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
  'X-Stainless-Lang': 'js',
  'X-Stainless-Package-Version': '0.94.0',
  'X-Stainless-OS': 'Linux',
  'X-Stainless-Arch': 'arm64',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Runtime-Version': 'v24.3.0',
  'X-Stainless-Retry-Count': '0',
  'X-Stainless-Timeout': '600',
  'X-App': 'cli',
  'anthropic-dangerous-direct-browser-access': 'true',
};
const CLAUDE_BETA =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14';

// ── per-provider 配置表 ────────────────────────────────────────────────────────
const PROVIDERS = {
  claude: {
    mode: 'pkce',
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    redirectUri: 'https://platform.claude.com/oauth/code/callback',
    scopeFull:
      'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    scopeSetup: 'user:inference',
    setupTokenExpiresIn: 31536000,
    tokenEncoding: 'json',
    tokenUserAgent: 'axios/1.13.6',
    upstream: 'https://api.anthropic.com',
    // 因 provider 而异：注入 Bearer + Claude Code 指纹头 + system 提示
    applyAuth(creds, headers, body) {
      const h = { ...CLAUDE_DEFAULT_HEADERS, ...headers };
      h['Content-Type'] = 'application/json';
      h['Accept'] = 'application/json';
      h['Authorization'] = `Bearer ${creds.access_token}`;
      h['anthropic-version'] = '2023-06-01';
      h['anthropic-beta'] = claudeModelInfo(body?.model)?.adaptiveOnly
        ? 'claude-code-20250219,oauth-2025-04-20' : CLAUDE_BETA;
      h['x-client-request-id'] = crypto.randomUUID();
      delete h['x-api-key'];
      const userAgent = h['user-agent'] || h['User-Agent'];
      const cliVersion = /^claude-cli\/(\d+\.\d+\.\d+)\b/.exec(userAgent || '')?.[1] || CLAUDE_CLI_VERSION;
      return { headers: h, body: injectClaudeSystem(normalizeClaudeOAuthBody(body), cliVersion), baseUrl: 'https://api.anthropic.com' };
    },
  },
  // codex / copilot / google 后续以同样结构加入（device 流 / 特殊刷新 / 各自 applyAuth）
};

// ── 通用工具 ───────────────────────────────────────────────────────────────────
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// 与本地 sub2api 的 billing attribution 格式一致；版本跟随出站 CLI UA。
// 只描述客户端归因信号，不假定上游会因此接受请求或采用特定计费方式。
function claudeBillingText(body, cliVersion) {
  const firstUser = Array.isArray(body?.messages) ? body.messages.find((m) => m?.role === 'user') : null;
  const content = firstUser?.content;
  const text = typeof content === 'string' ? content
    : (Array.isArray(content) ? content.find((b) => b?.type === 'text')?.text : '') || '';
  // 保持与 sub2api 的 UTF-8 字节取样一致，缺少的位置使用 ASCII '0'。
  const bytes = Buffer.from(typeof text === 'string' ? text : '', 'utf8');
  const sample = Buffer.from([4, 7, 20].map((i) => bytes[i] ?? 48));
  const fingerprint = crypto.createHash('sha256')
    .update(CLAUDE_BILLING_FINGERPRINT_SALT).update(sample).update(cliVersion)
    .digest('hex').slice(0, 3);
  return `${CLAUDE_BILLING_PREFIX} cc_version=${cliVersion}.${fingerprint}; cc_entrypoint=cli;`;
}

function injectClaudeSystem(body, cliVersion = CLAUDE_CLI_VERSION) {
  const cc = { type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT };
  const blocks = [{ type: 'text', text: claudeBillingText(body, cliVersion) }, cc];
  const sys = body && body.system;
  const items = typeof sys === 'string' ? [sys] : Array.isArray(sys) ? sys : [];
  for (const item of items) {
    const block = typeof item === 'string' ? { type: 'text', text: item } : item;
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text !== 'string') { blocks.push(block); continue; }
    // 去掉旧的前置计费行，保留同一块中后续的用户指令及 cache_control。
    // 不删除正文中间提到的 billing-header 字样，也不改写输入对象。
    let text = block.text;
    while (text.trimStart().startsWith(CLAUDE_BILLING_PREFIX)) {
      text = text.trimStart().replace(/^x-anthropic-billing-header:[^\r\n]*(?:\r\n|\r|\n)?/, '');
    }
    if (!text.trim() || text.trim() === CLAUDE_CODE_SYSTEM_PROMPT) continue;
    blocks.push(text === block.text ? block : { ...block, text });
  }
  return { ...body, system: blocks };
}

function normalizeToken(data, fallbackRefresh) {
  const expiresIn = parseInt(data.expires_in || 3600, 10);
  const creds = {
    access_token: data.access_token || '',
    refresh_token: data.refresh_token || fallbackRefresh || '',
    token_type: data.token_type || 'Bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    scope: data.scope || '',
  };
  const email = data.account && data.account.email_address;
  if (email) creds.email = email;
  return creds;
}

/** 统一过期判定（基于 expires_at，与 provider 无关）。 */
function needsRefresh(creds, skew = REFRESH_SKEW_SEC) {
  if (!creds || !creds.access_token) return true;
  if (!creds.expires_at) return true;
  return (creds.expires_at - Date.now() / 1000) < skew;
}

/** 按 cfg.tokenEncoding 编码并 POST token 端点。 */
async function postToken(cfg, params) {
  const isJson = cfg.tokenEncoding !== 'form';
  const headers = { Accept: 'application/json, text/plain, */*' };
  if (cfg.tokenUserAgent) headers['User-Agent'] = cfg.tokenUserAgent;
  let body;
  if (isJson) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(params); }
  else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(params).toString(); }
  const resp = await oauthHttp(cfg.tokenUrl, { method: 'POST', headers, body });
  if (!resp.ok) throw new Error(`token endpoint HTTP ${resp.status}: ${resp.text}`);
  try { return JSON.parse(resp.text || '{}'); }
  catch (e) { throw new Error(`token endpoint 返回非 JSON：${(resp.text || '').slice(0, 200)}`); }
}

/** 通用请求，返回 { status, json, text }（设备码流要看状态码/error 字段判断 pending）。 */
async function fetchStatus(url, opts = {}) {
  const resp = await oauthHttp(url, opts);
  let json = null;
  try { json = resp.text ? JSON.parse(resp.text) : null; } catch {}
  return { status: resp.status, json, text: resp.text };
}

/** 解码 JWT payload（不验签，仅取声明，如 Codex 的 chatgpt_account_id）。 */
function decodeJwt(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return {};
    const b = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b + '='.repeat((4 - (b.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch { return {}; }
}

/** 从 Codex 的 id_token/access_token 提取 chatgpt_account_id 与 email。 */
function extractCodexIdentity(tokens) {
  const id = decodeJwt(tokens.id_token);
  const ac = decodeJwt(tokens.access_token);
  const authNs = id['https://api.openai.com/auth'] || ac['https://api.openai.com/auth'] || {};
  const account_id = id.chatgpt_account_id || authNs.chatgpt_account_id
    || (Array.isArray(id.organizations) && id.organizations[0] && id.organizations[0].id)
    || ac.chatgpt_account_id || null;
  return { account_id, email: id.email || ac.email || null };
}

// ── 追加的 OAuth 供给源（设备码流 / 粘贴流，各自怪异处用钩子封装）─────────────────

// OpenAI Codex（ChatGPT 订阅）：设备码流 → 授权码换 token；上游 chatgpt backend。
const CODEX = {
  mode: 'device',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  usercodeUrl: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.openai.com/api/accounts/deviceauth/token',
  oauthTokenUrl: 'https://auth.openai.com/oauth/token',
  verificationUrl: 'https://auth.openai.com/codex/device',
  redirectUri: 'https://auth.openai.com/deviceauth/callback',
  userAgent: 'cc-switch-codex-oauth',
  async startLogin() {
    const r = await fetchStatus(CODEX.usercodeUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CODEX.userAgent },
      body: JSON.stringify({ client_id: CODEX.clientId }) });
    if (r.status >= 400 || !r.json) throw new Error('codex usercode HTTP ' + r.status);
    return { userCode: r.json.user_code, verificationUrl: CODEX.verificationUrl,
      session: { name: 'codex', deviceAuthId: r.json.device_auth_id, userCode: r.json.user_code, interval: r.json.interval || 5 } };
  },
  async poll(session) {
    const r = await fetchStatus(CODEX.deviceTokenUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': CODEX.userAgent },
      body: JSON.stringify({ device_auth_id: session.deviceAuthId, user_code: session.userCode }) });
    if (r.status === 403 || r.status === 404) return { status: 'pending' };
    if (r.status === 410) throw new Error('设备码已过期，请重新登录');
    if (r.status >= 400 || !r.json) throw new Error('codex poll HTTP ' + r.status);
    if (!r.json.authorization_code) return { status: 'pending' };
    const tok = await fetchStatus(CODEX.oauthTokenUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CODEX.userAgent },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: r.json.authorization_code,
        redirect_uri: CODEX.redirectUri, client_id: CODEX.clientId, code_verifier: r.json.code_verifier }).toString() });
    if (tok.status >= 400 || !tok.json) throw new Error('codex token HTTP ' + tok.status);
    const creds = normalizeToken(tok.json, tok.json.refresh_token);
    const ident = extractCodexIdentity(tok.json);
    if (ident.account_id) creds.account_id = ident.account_id;
    if (ident.email) creds.email = ident.email;
    return { credentials: creds };
  },
  async refresh(creds) {
    if (!creds.refresh_token) throw new Error('缺少 refresh_token，请重新登录');
    const r = await fetchStatus(CODEX.oauthTokenUrl, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': CODEX.userAgent },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refresh_token,
        client_id: CODEX.clientId, scope: 'openid profile email' }).toString() });
    if (r.status >= 400 || !r.json) throw new Error('codex refresh HTTP ' + r.status);
    const next = normalizeToken(r.json, creds.refresh_token);
    if (creds.account_id) next.account_id = creds.account_id;
    if (creds.email && !next.email) next.email = creds.email;
    return next;
  },
  applyAuth(creds, headers, body) {
    const h = { ...headers };
    h['Authorization'] = `Bearer ${creds.access_token}`;
    if (creds.account_id) h['chatgpt-account-id'] = creds.account_id;
    h['originator'] = 'codex_cli_rs';
    h['Content-Type'] = 'application/json';
    delete h['x-api-key'];
    return {
      headers: h, body, baseUrl: 'https://chatgpt.com/backend-api/codex',
      // The subscription token does not grant public API model-list scopes.
      // Reuse the read-only quota endpoint from usage/codex.js: success proves
      // authentication/connectivity, not inference availability or remaining quota.
      testUrl: 'https://chatgpt.com/backend-api/wham/usage',
    };
  },
};

// GitHub Copilot：设备码流 → GitHub token → 换 Copilot token；上游 githubcopilot（OpenAI 格式）。
const COPILOT = {
  mode: 'device',
  clientId: 'Iv1.b507a08c87ecfe98',
  deviceCodeUrl: 'https://github.com/login/device/code',
  oauthTokenUrl: 'https://github.com/login/oauth/access_token',
  copilotTokenUrl: 'https://api.github.com/copilot_internal/v2/token',
  userUrl: 'https://api.github.com/user',
  verificationUrl: 'https://github.com/login/device',
  userAgent: 'GitHubCopilotChat/0.38.2',
  async startLogin() {
    const r = await fetchStatus(COPILOT.deviceCodeUrl, { method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': COPILOT.userAgent },
      body: new URLSearchParams({ client_id: COPILOT.clientId, scope: 'read:user' }).toString() });
    if (r.status >= 400 || !r.json) throw new Error('copilot device code HTTP ' + r.status);
    return { userCode: r.json.user_code, verificationUrl: r.json.verification_uri || COPILOT.verificationUrl,
      session: { name: 'copilot', deviceCode: r.json.device_code, interval: r.json.interval || 5 } };
  },
  async poll(session) {
    const r = await fetchStatus(COPILOT.oauthTokenUrl, { method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': COPILOT.userAgent },
      body: new URLSearchParams({ client_id: COPILOT.clientId, device_code: session.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }).toString() });
    const d = r.json || {};
    if (d.error === 'authorization_pending' || d.error === 'slow_down') return { status: d.error };
    if (d.error) throw new Error('copilot oauth: ' + d.error);
    if (!d.access_token) return { status: 'pending' };
    return { credentials: await COPILOT._exchangeCopilot(d.access_token) };
  },
  async _exchangeCopilot(githubToken) {
    const t = await fetchStatus(COPILOT.copilotTokenUrl, { method: 'GET',
      headers: { Authorization: `token ${githubToken}`, 'User-Agent': COPILOT.userAgent,
        'Editor-Version': 'vscode/1.110.1', 'Editor-Plugin-Version': 'copilot-chat/0.38.2' } });
    if (t.status === 403) throw new Error('该 GitHub 账号未订阅 Copilot');
    if (t.status >= 400 || !t.json) throw new Error('copilot token HTTP ' + t.status);
    const creds = { access_token: t.json.token, expires_at: t.json.expires_at, github_token: githubToken, token_type: 'Bearer' };
    try {
      const u = await fetchStatus(COPILOT.userUrl, { method: 'GET',
        headers: { Authorization: `token ${githubToken}`, 'User-Agent': COPILOT.userAgent } });
      if (u.json && u.json.login) creds.email = u.json.login;
    } catch {}
    return creds;
  },
  async refresh(creds) {
    if (!creds.github_token) throw new Error('缺少 GitHub 授权，请重新登录');
    return COPILOT._exchangeCopilot(creds.github_token);
  },
  applyAuth(creds, headers, body) {
    const h = { ...headers };
    h['Authorization'] = `Bearer ${creds.access_token}`;
    h['editor-version'] = 'vscode/1.110.1';
    h['editor-plugin-version'] = 'copilot-chat/0.38.2';
    h['copilot-integration-id'] = 'vscode-chat';
    h['x-github-api-version'] = '2025-10-01';
    h['Content-Type'] = 'application/json';
    delete h['x-api-key'];
    return { headers: h, body, baseUrl: 'https://api.githubcopilot.com' };
  },
};

// 注：Gemini 走 API Key（其 OpenAI 兼容端点不支持 OAuth），故不在此注册 OAuth provider。

Object.assign(PROVIDERS, { codex: CODEX, copilot: COPILOT });

// ── 统一登录 / 刷新 ────────────────────────────────────────────────────────────
// 怪异的流程（设备码 / 粘贴凭证）放在各 provider 配置里以 startLogin/completeLogin/poll 覆盖；
// 标准 PKCE 授权码流由下方内置实现共用。

function startLogin(name, opts = {}) {
  const cfg = PROVIDERS[name];
  if (!cfg) throw new Error('unsupported oauth provider: ' + name);
  if (typeof cfg.startLogin === 'function') return cfg.startLogin(opts);
  if (cfg.mode === 'pkce') {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(32));
    const scope = opts.setupToken ? cfg.scopeSetup : cfg.scopeFull;
    const params = new URLSearchParams({
      code: 'true', client_id: cfg.clientId, response_type: 'code',
      redirect_uri: cfg.redirectUri, scope, code_challenge: challenge,
      code_challenge_method: 'S256', state,
    });
    return { authUrl: `${cfg.authorizeUrl}?${params.toString()}`, session: { name, verifier, isSetupToken: !!opts.setupToken } };
  }
  // device 流（codex/copilot）将在此分支实现
  throw new Error(`login mode '${cfg.mode}' not implemented yet for ${name}`);
}

async function completeLogin(name, session, code) {
  const cfg = PROVIDERS[name];
  if (typeof cfg.completeLogin === 'function') return cfg.completeLogin(session, code);
  if (cfg.mode === 'pkce') {
    let authCode = String(code || '').trim();
    let codeState = null;
    const hash = authCode.indexOf('#');
    if (hash !== -1) { codeState = authCode.slice(hash + 1); authCode = authCode.slice(0, hash); }
    const params = {
      code: authCode, grant_type: 'authorization_code', client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri, code_verifier: session.verifier,
    };
    if (codeState) params.state = codeState;
    if (session.isSetupToken && cfg.setupTokenExpiresIn) params.expires_in = cfg.setupTokenExpiresIn;
    const data = await postToken(cfg, params);
    return normalizeToken(data, data.refresh_token);
  }
  throw new Error(`completeLogin mode '${cfg.mode}' not implemented for ${name}`);
}

async function poll(name, session) {
  const cfg = PROVIDERS[name];
  if (typeof cfg.poll === 'function') return cfg.poll(session);
  throw new Error(`poll not implemented for ${name}`);
}

/** 统一 token 刷新；provider 可用 cfg.refresh 覆盖（如 Copilot 的非标准刷新）。 */
async function refresh(name, creds) {
  const cfg = PROVIDERS[name];
  if (!cfg) throw new Error('unsupported oauth provider: ' + name);
  if (typeof cfg.refresh === 'function') return cfg.refresh(creds, cfg);
  if (!creds || !creds.refresh_token) throw new Error('缺少 refresh_token，请重新登录');
  const params = { grant_type: 'refresh_token', refresh_token: creds.refresh_token, client_id: cfg.clientId };
  if (cfg.refreshExtra) Object.assign(params, cfg.refreshExtra);
  const data = await postToken(cfg, params);
  return normalizeToken(data, creds.refresh_token);
}

function applyAuth(name, { headers, body, credentials }) {
  return PROVIDERS[name].applyAuth(credentials, headers || {}, body);
}

// ── 对外接口 ───────────────────────────────────────────────────────────────────
/** 返回绑定到 name 的轻量门面（供 main.js 登录流调用）。 */
function getModule(name) {
  const cfg = PROVIDERS[name];
  if (!cfg) return null;
  return {
    id: name, mode: cfg.mode,
    startLogin: (opts) => startLogin(name, opts),
    completeLogin: (session, code) => completeLogin(name, session, code),
    poll: (session) => poll(name, session),
  };
}

function isOauthProvider(provider) {
  return !!(provider && provider.auth_type === 'oauth' && provider.oauth_provider && PROVIDERS[provider.oauth_provider]);
}

/**
 * 代理前调用：确保 access_token 有效（必要时统一刷新并回写 config），
 * 返回带 `_oauth`（含 applyAuth）与最新 credentials 的 provider 克隆；非 OAuth 原样返回。
 */
// opts.skew：额外的提前量(秒)——后台定时刷新用，在过期前 skew 秒就主动刷新（叠加在常规判定之上），
// 保证 token 不断供、不依赖"被使用/被查看"才刷。
async function prepare(provider, getConfig, saveConfig, opts = {}) {
  if (!isOauthProvider(provider)) return provider;
  const name = provider.oauth_provider;
  const cfg = PROVIDERS[name];
  let creds = provider.credentials || {};
  let stale = typeof cfg.needsRefresh === 'function' ? cfg.needsRefresh(creds) : needsRefresh(creds);
  if (!stale && opts.skew != null) stale = needsRefresh(creds, opts.skew);   // 后台提前刷新
  if (stale) {
    creds = await refresh(name, creds);
    try {
      const cfg = getConfig ? getConfig() : null;
      if (cfg && Array.isArray(cfg.providers) && saveConfig) {
        saveConfig({
          ...cfg,
          providers: cfg.providers.map((p) => (p.id === provider.id ? { ...p, credentials: creds } : p)),
        });
      }
    } catch (e) {
      console.warn('[oauth] persist refreshed credentials failed:', e && e.message);
    }
  }
  // _oauth.applyAuth 绑定到该 provider name，网关代理路径直接调用
  return { ...provider, credentials: creds, _oauth: { applyAuth: (args) => applyAuth(name, args) } };
}

module.exports = {
  PROVIDERS, getModule, isOauthProvider, prepare,
  startLogin, completeLogin, poll, refresh, needsRefresh, applyAuth, oauthHttp,
  setNetworkProxyGetter,
};
