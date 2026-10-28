// client/electron/mcp-client-sync.js
// 将 Token Bank 已纳管 MCP 同步到各 Agent 客户端，并扫描客户端已有 MCP 配置
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
let shim = null;
try { shim = require('./shim-installer'); } catch { /* optional in CLI */ }
const { BUILTIN_BRIDGE_ID, BUILTIN_PROMPTS_ID, BUILTIN_MODELS_ID, BUILTIN_RESOURCES_ID, writeElectronAsNodeLauncher, mcpStdioFromLauncher } = require('./mcp-manager');
const { CLIENT_TARGETS } = require('./mcp-agent-targets');

const STATE_PATH = path.join(os.homedir(), '.tokenbank', 'mcp', 'client-sync-state.json');
const TB_MCP_MARKER = 'tokenbank-mcp';
const PROMPTS_SCRIPT = path.join(__dirname, 'prompt-mcp.js');
const MODELS_SCRIPT = path.join(__dirname, 'models-mcp.js');
const RESOURCES_SCRIPT = path.join(__dirname, 'resources-mcp.js');
const DISPATCH_SCRIPT = path.join(__dirname, 'agent-dispatch-mcp.js');

/** 并发 IPC（listServers + getSyncStatus）共用短缓存，避免重复读盘 */
const SCAN_CACHE_TTL_MS = 2500;
let _scanAllCache = null;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 解析 Agent MCP 配置文件路径（优先已存在的文件；WorkBuddy 固定为 ~/.workbuddy/mcp.json） */
function resolveTargetConfigPath(target) {
  const paths = target.getPaths ? target.getPaths() : [target.getPath()];
  return paths.find(p => fs.existsSync(p)) || paths[0];
}

function readState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    }
  } catch {}
  return { clients: {} };
}

function writeState(state) {
  ensureDir(STATE_PATH);
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

/** 将 DB 中的 server 转为 MCP JSON 条目。派发桥与其它内置 MCP 一样写成常驻 launcher。 */
function serverToEntry(serverRow, clientId) {
  if (!serverRow || serverRow.status !== 'active') return null;

  if (serverRow.id === BUILTIN_BRIDGE_ID || serverRow.name === BUILTIN_BRIDGE_ID) {
    const env = {
      TB_CLIENT_ID: clientId || '',
      TB_MAIN_AGENT_ID: clientId || '',
    };
    try {
      const { getDispatchEndpoint } = require('./agent-dispatch-server');
      const ep = getDispatchEndpoint();
      if (ep?.url && ep?.token) {
        env.TB_DISPATCH_URL = ep.url;
        env.TB_DISPATCH_TOKEN = ep.token;
      }
    } catch { /* 未起派发服务时，桥在调用时再读 bridge-context */ }
    const launcher = writeElectronAsNodeLauncher({
      name: `bridge-${clientId || 'default'}`,
      scriptPath: DISPATCH_SCRIPT,
      env,
    });
    return mcpStdioFromLauncher(launcher);
  }

  // 内置提示词 MCP：用 shell launcher（内嵌 ELECTRON_RUN_AS_NODE），
  // 避免 Codex 等不透传 mcp_servers.*.env 时 Electron GUI 崩溃
  if (serverRow.id === BUILTIN_PROMPTS_ID || serverRow.name === BUILTIN_PROMPTS_ID) {
    const launcher = writeElectronAsNodeLauncher({
      name: `prompts-${clientId || 'default'}`,
      scriptPath: PROMPTS_SCRIPT,
      env: { TB_CLIENT_ID: clientId || '' },
    });
    return mcpStdioFromLauncher(launcher);
  }

  // 内置模型资源 MCP：始终可查网关可用模型
  if (serverRow.id === BUILTIN_MODELS_ID || serverRow.name === BUILTIN_MODELS_ID) {
    const launcher = writeElectronAsNodeLauncher({
      name: `models-${clientId || 'default'}`,
      scriptPath: MODELS_SCRIPT,
      env: {},
    });
    return mcpStdioFromLauncher(launcher);
  }

  // 内置资源发现 MCP：能力总览 + skill/assistant/社区目录
  // 必须带 TB_CLIENT_ID，否则 listAssistantsForClient 空 client 会回退列出全部武将
  if (serverRow.id === BUILTIN_RESOURCES_ID || serverRow.name === BUILTIN_RESOURCES_ID) {
    const launcher = writeElectronAsNodeLauncher({
      name: `resources-${clientId || 'default'}`,
      scriptPath: RESOURCES_SCRIPT,
      env: { TB_CLIENT_ID: clientId || '' },
    });
    return mcpStdioFromLauncher(launcher);
  }

  // URL / HTTP / SSE MCP（如 WorkBuddy connector-proxy）
  const url = serverRow.url
    || (serverRow.metadata && serverRow.metadata.url)
    || null;
  if (url) {
    const entry = { url: String(url) };
    const typ = String(serverRow.type || '').toLowerCase();
    if (typ === 'http' || typ === 'sse') entry.type = typ;
    const headers = serverRow.metadata?.headers
      || (serverRow.headers && typeof serverRow.headers === 'object' ? serverRow.headers : null);
    if (headers && typeof headers === 'object' && Object.keys(headers).length) {
      entry.headers = headers;
    }
    return entry;
  }

  let command = serverRow.command;
  if (command === '__DYNAMIC_ELECTRON__') return null;
  if (command === 'npx') {
    command = shim?.resolveRealCommand?.('npx') || 'npx';
  }

  let args = [];
  let env = {};
  if (Array.isArray(serverRow.args)) args = serverRow.args;
  else {
    try { args = JSON.parse(serverRow.args || '[]'); } catch {}
  }
  if (serverRow.env && typeof serverRow.env === 'object' && !Array.isArray(serverRow.env)) {
    env = serverRow.env;
  } else {
    try { env = JSON.parse(serverRow.env || '{}'); } catch {}
  }

  if (!command) return null;

  const entry = { command, args: Array.isArray(args) ? args : [] };
  if (env && Object.keys(env).length) entry.env = env;
  return entry;
}

/** 指向 Token Bank 写出 launcher 的条目（含 /bin/sh 或 cmd.exe 包装） */
function isTokenbankMcpEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const blob = `${entry.command || ''} ${(Array.isArray(entry.args) ? entry.args : []).join(' ')}`;
  return blob.includes('.tokenbank/mcp/') || blob.includes('.tokenbank\\mcp\\');
}

function ownedKeyCandidates(serverRow) {
  const base = serverRow.name || serverRow.id;
  return [...new Set([base, `tb-${base}`, `tb-${serverRow.id}`].filter(Boolean))];
}

/** 客户端里使用的 server 键名（避免覆盖用户自配 MCP） */
function clientKeyForServer(serverRow, existingKeys, prevTbKeys) {
  const base = serverRow.name || serverRow.id;
  if (prevTbKeys.includes(base)) return base;
  // leftover 清掉旧 TB 条目后规范键空闲：回到 tokenbank-*，不要永远停在 tb- 前缀
  if (!existingKeys.has(base)) return base;
  const alt = `tb-${base}`;
  if (prevTbKeys.includes(alt)) return alt;
  if (!existingKeys.has(alt)) return alt;
  return `tb-${serverRow.id}`;
}

function loadJsonMcp(filePath) {
  if (!fs.existsSync(filePath)) return { mcpServers: {} };
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { mcpServers: {} };
  // 必须保留原文件其它顶层字段（如 ~/.claude.json 状态），否则同步会整文件被覆盖清空
  if (raw.mcpServers && typeof raw.mcpServers === 'object') return raw;
  if (raw.servers && typeof raw.servers === 'object') {
    return { ...raw, mcpServers: raw.servers };
  }
  return { ...raw, mcpServers: {} };
}

function syncJsonClient(clientId, filePath, servers, { allowCreate = false } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  // 安装探测已不依赖配置文件是否存在；已确认安装的 Agent 允许首次创建 mcp 配置
  // （否则 Windows 上 WorkBuddy / Kimi 等常因缺 mcp.json 静默跳过）
  if (!fs.existsSync(filePath)) {
    if (!allowCreate) {
      return { synced: [], keys: [], path: filePath, skipped: true, reason: 'config-missing' };
    }
    ensureDir(filePath);
    fs.writeFileSync(filePath, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, 'utf8');
  }
  const prev = readState().clients[clientId]?.keys || [];
  const doc = loadJsonMcp(filePath);
  const existingKeys = new Set(Object.keys(doc.mcpServers || {}));

  // 移除上次由 Token Bank 写入的条目
  for (const key of prev) {
    delete doc.mcpServers[key];
    existingKeys.delete(key);
  }

  // 状态丢失时仍清掉指向 ~/.tokenbank/mcp 的旧键，避免直接 spawn 被隔离脚本，也不叠 tb- 重复
  for (const srv of list) {
    for (const key of ownedKeyCandidates(srv)) {
      if (prev.includes(key)) continue;
      if (!isTokenbankMcpEntry(doc.mcpServers[key])) continue;
      delete doc.mcpServers[key];
      existingKeys.delete(key);
    }
  }

  const newKeys = [];
  const synced = [];

  for (const srv of list) {
    const entry = serverToEntry(srv, clientId);
    if (!entry) continue;
    const key = clientKeyForServer(srv, existingKeys, prev);
    doc.mcpServers[key] = entry;
    existingKeys.add(key);
    newKeys.push(key);
    synced.push({ id: srv.id, name: srv.display_name || srv.name, clientKey: key });
  }

  // 无变更且无待清：不落盘
  if (!newKeys.length && !prev.length) {
    return { synced: [], keys: [], path: filePath, skipped: true };
  }

  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
  return { synced, keys: newKeys, path: filePath };
}

/** 从 Codex config.toml 移除 Token Bank 写入的 mcp_servers 段 */
function stripCodexTbMcpSections(text, prevKeys) {
  let lines = text.split(/\r?\n/);
  for (const key of prevKeys) {
    const headRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(key)}\\]\\s*$`);
    const envRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(key)}\\.env\\]\\s*$`);
    let i = 0;
    while (i < lines.length) {
      if (headRe.test(lines[i]) || envRe.test(lines[i])) {
        let j = i + 1;
        while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
        lines.splice(i, j - i);
        continue;
      }
      i++;
    }
  }
  return lines.join('\n');
}

/**
 * 清掉 tokenbank-mcp 托管块（含残缺开/闭标记）。
 * 旧逻辑只匹配「成对」标记：一旦缺开或缺闭，残留行清不掉，下次同步会再追加 → 标记刷屏。
 */
function stripCodexManagedMcpBlock(text) {
  let out = String(text || '');
  // 1) 成对块（允许文件开头无前导换行；非贪心 + 全局，可清多段）
  out = out.replace(
    /(?:^|\n)[ \t]*# >>> tokenbank-mcp managed >>>[ \t]*\r?\n[\s\S]*?# <<< tokenbank-mcp managed <<<[ \t]*(?:\r?\n|$)/g,
    '\n',
  );
  // 2) 残留的开/闭标记行（成对匹配失败后的孤儿）
  out = out.replace(/^[ \t]*# >>> tokenbank-mcp managed >>>[ \t]*\r?\n/gm, '');
  out = out.replace(/^[ \t]*# <<< tokenbank-mcp managed <<<[ \t]*\r?\n/gm, '');
  out = out.replace(/^[ \t]*# >>> tokenbank-mcp managed >>>[ \t]*$/gm, '');
  out = out.replace(/^[ \t]*# <<< tokenbank-mcp managed <<<[ \t]*$/gm, '');
  // 压缩多余空行
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tomlQuote(v) {
  return JSON.stringify(String(v));
}

function buildCodexMcpSections(entries) {
  const blocks = [];
  for (const { key, entry } of entries) {
    blocks.push(`[mcp_servers.${key}]`);
    if (entry.url) {
      // Codex 支持 url 型远程 MCP
      blocks.push(`url = ${tomlQuote(entry.url)}`);
      if (entry.headers && typeof entry.headers === 'object' && Object.keys(entry.headers).length) {
        blocks.push('');
        blocks.push(`[mcp_servers.${key}.http_headers]`);
        for (const [hk, hv] of Object.entries(entry.headers)) {
          blocks.push(`${hk} = ${tomlQuote(hv)}`);
        }
      }
    } else {
      blocks.push(`command = ${tomlQuote(entry.command)}`);
      blocks.push(`args = ${JSON.stringify(entry.args || [])}`);
      if (entry.env && Object.keys(entry.env).length) {
        blocks.push('');
        blocks.push(`[mcp_servers.${key}.env]`);
        for (const [k, v] of Object.entries(entry.env)) {
          blocks.push(`${k} = ${tomlQuote(v)}`);
        }
      }
    }
    blocks.push('');
  }
  return blocks;
}

function syncCodexClient(clientId, filePath, servers, prevKeys, { allowCreate = false } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const prev = Array.isArray(prevKeys) ? prevKeys : [];
  // 与 json 同理：强信号已装时可新建空 config.toml（否则 Desktop 新装无法投射 MCP）
  if (!fs.existsSync(filePath)) {
    if (!allowCreate) {
      return { synced: [], keys: [], path: filePath, skipped: true, reason: 'config-missing' };
    }
    ensureDir(filePath);
    fs.writeFileSync(filePath, '# Created by Token Bank for MCP sync\n', 'utf8');
  }
  const original = fs.readFileSync(filePath, 'utf8');
  // 先清托管标记块（含孤儿开/闭行），再按 prevKeys 删旧 mcp 段，避免标记残留叠加
  let text = stripCodexManagedMcpBlock(original);
  text = stripCodexTbMcpSections(text, prev);

  const entries = [];
  const synced = [];
  const newKeys = [];

  for (const srv of list) {
    const entry = serverToEntry(srv, clientId);
    if (!entry) continue;
    const key = clientKeyForServer(srv, new Set(), prev);
    entries.push({ key, entry });
    newKeys.push(key);
    synced.push({ id: srv.id, name: srv.display_name || srv.name, clientKey: key });
  }

  if (entries.length) {
    const marker = `\n# >>> ${TB_MCP_MARKER} managed >>>\n`;
    const body = buildCodexMcpSections(entries).join('\n');
    const end = `# <<< ${TB_MCP_MARKER} managed <<<\n`;
    text = text.trimEnd() + marker + body + end;
  }

  // 内容无实质变化则不写盘
  const next = text.endsWith('\n') ? text : text + '\n';
  if (next === (original.endsWith('\n') ? original : original + '\n')) {
    return { synced, keys: newKeys, path: filePath, skipped: true };
  }

  fs.writeFileSync(filePath, next, 'utf8');
  return { synced, keys: newKeys, path: filePath };
}

// ── DeepSeek Harness（cordis-mcp-client）────────────────────────────────────
// dsh 的 MCP 不是 mcpServers map，而是 $DSH_HOME/cordis.patch.yml 顶层 patch 列表里的
// 一个 `@deepseek-ai/dsh-mcp-client` 插件行（每 server 一行）。文件可能含 `!!js` 自定义
// 标签，整文件 YAML round-trip 不安全 → 沿用 Codex 的「托管标记块」文本策略：只在块内增删。
const DSH_MCP_CLIENT_NAME = '@deepseek-ai/dsh-mcp-client';

/** serverToEntry 的结果（stdio {command,args,env} 或 http {url,headers}）→ dsh 插件行 */
function dshRowFromEntry(key, entry) {
  const config = { serverName: key };
  if (entry.url) {
    config.transport = 'streamable-http';
    config.url = String(entry.url);
    if (entry.headers && typeof entry.headers === 'object' && Object.keys(entry.headers).length) {
      config.headers = entry.headers;
    }
  } else {
    config.transport = 'stdio';
    config.command = String(entry.command);
    config.args = Array.isArray(entry.args) ? entry.args : [];
    if (entry.env && Object.keys(entry.env).length) config.env = entry.env;
  }
  return { id: `tb-mcp-${key}`, name: DSH_MCP_CLIENT_NAME, config };
}

/** 渲染顶层 patch 列表项：`- insert:\n    - id: ...` */
function buildCordisInsertBlock(rows) {
  return require('js-yaml').dump([{ insert: rows }], { lineWidth: 200, noRefs: true });
}

/** 清掉 tokenbank-mcp 托管块（含残缺开/闭标记），与 Codex 逻辑对齐 */
function stripCordisManagedBlock(text) {
  let out = String(text || '');
  out = out.replace(
    /(?:^|\n)[ \t]*# >>> tokenbank-mcp managed >>>[ \t]*\r?\n[\s\S]*?# <<< tokenbank-mcp managed <<<[ \t]*(?:\r?\n|$)/g,
    '\n',
  );
  out = out.replace(/^[ \t]*# >>> tokenbank-mcp managed >>>[ \t]*\r?\n/gm, '');
  out = out.replace(/^[ \t]*# <<< tokenbank-mcp managed <<<[ \t]*\r?\n/gm, '');
  out = out.replace(/^[ \t]*# >>> tokenbank-mcp managed >>>[ \t]*$/gm, '');
  out = out.replace(/^[ \t]*# <<< tokenbank-mcp managed <<<[ \t]*$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

function syncCordisClient(clientId, filePath, servers, prevKeys, { allowCreate = false } = {}) {
  const list = Array.isArray(servers) ? servers : [];
  const prev = Array.isArray(prevKeys) ? prevKeys : [];
  if (!fs.existsSync(filePath)) {
    if (!allowCreate) {
      return { synced: [], keys: [], path: filePath, skipped: true, reason: 'config-missing' };
    }
    ensureDir(filePath);
    fs.writeFileSync(filePath, '# Created by Token Bank for DeepSeek Harness MCP sync\n', 'utf8');
  }
  const original = fs.readFileSync(filePath, 'utf8');
  const text0 = stripCordisManagedBlock(original);

  const rows = [];
  const synced = [];
  const newKeys = [];
  for (const srv of list) {
    const entry = serverToEntry(srv, clientId);
    if (!entry) continue;
    const key = clientKeyForServer(srv, new Set(), prev);
    rows.push(dshRowFromEntry(key, entry));
    newKeys.push(key);
    synced.push({ id: srv.id, name: srv.display_name || srv.name, clientKey: key });
  }

  let text = text0;
  if (rows.length) {
    const marker = `\n# >>> ${TB_MCP_MARKER} managed >>>\n`;
    const body = buildCordisInsertBlock(rows);
    const end = `# <<< ${TB_MCP_MARKER} managed <<<\n`;
    text = text0.trimEnd() + marker + (body.endsWith('\n') ? body : body + '\n') + end;
  }

  const next = text.endsWith('\n') ? text : text + '\n';
  if (next === (original.endsWith('\n') ? original : original + '\n')) {
    return { synced, keys: newKeys, path: filePath, skipped: true };
  }
  fs.writeFileSync(filePath, next, 'utf8');
  return { synced, keys: newKeys, path: filePath };
}

/** 解析 cordis.patch.yml 托管块内的 dsh-mcp-client 行 → [{clientKey, entry}]（仅读 TB 托管块，避开用户 !!js） */
function parseCordisMcpClientSections(text) {
  const results = [];
  const m = String(text || '').match(
    /# >>> tokenbank-mcp managed >>>[ \t]*\r?\n([\s\S]*?)# <<< tokenbank-mcp managed <<</,
  );
  if (!m) return results;
  let ops;
  try { ops = require('js-yaml').load(m[1]); } catch { return results; }
  if (!Array.isArray(ops)) return results;
  for (const op of ops) {
    const insertRows = op && Array.isArray(op.insert) ? op.insert : [];
    for (const row of insertRows) {
      if (!row || row.name !== DSH_MCP_CLIENT_NAME) continue;
      const cfg = row.config || {};
      const key = String(cfg.serverName || '').trim();
      if (!key) continue;
      const entry = (cfg.transport === 'streamable-http' || cfg.url)
        ? { command: '', args: [], env: {}, url: String(cfg.url || ''), headers: cfg.headers || undefined }
        : { command: String(cfg.command || ''), args: Array.isArray(cfg.args) ? cfg.args : [], env: cfg.env || {} };
      results.push({ clientKey: key, entry });
    }
  }
  return results;
}

/** 从 cordis.patch.yml 删除单个 serverName 的 dsh-mcp-client 行（块空则整块移除） */
function stripCordisMcpKey(text, key) {
  const re = /(# >>> tokenbank-mcp managed >>>[ \t]*\r?\n)([\s\S]*?)(# <<< tokenbank-mcp managed <<<[ \t]*\r?\n?)/;
  const m = String(text || '').match(re);
  if (!m) return text;
  let ops;
  try { ops = require('js-yaml').load(m[2]); } catch { return text; }
  if (!Array.isArray(ops)) return text;

  let changed = false;
  for (const op of ops) {
    if (op && Array.isArray(op.insert)) {
      const before = op.insert.length;
      op.insert = op.insert.filter(
        (r) => !(r && r.name === DSH_MCP_CLIENT_NAME && String((r.config || {}).serverName || '') === key),
      );
      if (op.insert.length !== before) changed = true;
    }
  }
  if (!changed) return text;

  const remaining = ops.filter((op) => !(op && Array.isArray(op.insert) && op.insert.length === 0));
  if (!remaining.length) {
    return text.replace(re, '').replace(/\n{3,}/g, '\n\n');
  }
  const body = require('js-yaml').dump(remaining, { lineWidth: 200, noRefs: true });
  return text.replace(re, `${m[1]}${body}${m[3]}`);
}

/**
 * 同步 active MCP 到 Agent 客户端（可按 Agent 分别写入）
 * @param {object[]} servers 来自 mcpManager.listManagedServers()
 * @param {{ clientIds?: string[] }} options 指定 Agent；缺省仅同步本机已安装应用
 */
function syncAll(servers, options = {}) {
  const {
    listInstalledClientIds,
    listSyncEnabledClientIds,
    resolveMcpSyncClientId,
  } = require('./mcp-agent-targets');
  const state = readState();
  const results = [];
  const allSyncIds = listSyncEnabledClientIds();
  const installedIds = new Set(listInstalledClientIds());
  const explicit = Array.isArray(options.clientIds) && options.clientIds.length > 0;
  // 未指定：仅已安装；显式指定（UI 已按 Gateway 纳管过滤）：允许写盘，并解析别名（codex-desktop→codex）
  const requested = explicit
    ? [...new Set(
      options.clientIds
        .map((id) => resolveMcpSyncClientId(id) || id)
        .filter((id) => allSyncIds.includes(id)),
    )]
    : [...installedIds];
  const clientIds = explicit ? requested : requested.filter((id) => installedIds.has(id));

  for (const clientId of clientIds) {
    const target = CLIENT_TARGETS[clientId];
    try {
      const filePath = resolveTargetConfigPath(target);
      const prevKeys = state.clients[clientId]?.keys || [];
      const clientServers = filterServersForClient(servers, clientId);
      // 仅同步已安装 / UI 显式指定的目标；探测已不靠配置文件，可安全建盘
      const allowCreate = true;
      let result;

      if (target.format === 'json-mcp') {
        result = syncJsonClient(clientId, filePath, clientServers, { allowCreate });
      } else if (target.format === 'toml-mcp') {
        result = syncCodexClient(clientId, filePath, clientServers, prevKeys, { allowCreate });
      } else if (target.format === 'cordis-mcp-client') {
        result = syncCordisClient(clientId, filePath, clientServers, prevKeys, { allowCreate });
      } else {
        continue;
      }

      // 配置文件不存在且未允许创建：跳过，保留旧 state
      if (result.skipped && result.reason === 'config-missing') {
        results.push({
          clientId,
          label: target.label,
          success: false,
          skipped: true,
          reason: 'config-missing',
          error: 'config-missing',
          path: result.path,
          synced: [],
          count: 0,
          syncEnabled: true,
        });
        continue;
      }

      state.clients[clientId] = {
        keys: result.keys,
        bindings: result.synced.map(s => ({ serverId: s.id, clientKey: s.clientKey })),
        lastSync: Date.now(),
        path: result.path,
        count: result.synced.length,
      };

      results.push({
        clientId,
        label: target.label,
        success: true,
        path: result.path,
        synced: result.synced,
        count: result.synced.length,
        syncEnabled: true,
      });
    } catch (e) {
      results.push({
        clientId,
        label: target.label,
        success: false,
        error: e.message,
        syncEnabled: true,
      });
    }
  }

  state.lastSync = Date.now();
  writeState(state);
  invalidateScanCache();
  return { success: results.every(r => r.success), results, state };
}

/** 读取 MCP 应同步到哪些 Agent（须显式投射，且仅本机已安装） */
function getServerSyncClients(server) {
  const { listSyncEnabledClientIds, listInstalledClientIds } = require('./mcp-agent-targets');
  const allowed = listSyncEnabledClientIds();
  const installed = new Set(listInstalledClientIds());
  let ids = [];
  if (Array.isArray(server?.sync_clients)) {
    ids = server.sync_clients.filter((id) => allowed.includes(id));
  } else if (Array.isArray(server?.metadata?.sync_clients)) {
    ids = server.metadata.sync_clients.filter((id) => allowed.includes(id));
  }
  // 未显式配置 sync_clients → 不下发（避免启动时往未安装应用写配置）
  return ids.filter((id) => installed.has(id));
}

/** 筛选应写入指定 Agent 的 MCP 列表 */
function filterServersForClient(servers, clientId) {
  return (servers || []).filter(s => {
    if (s.status !== 'active' || s.source === 'client') return false;

    // prompts：显式 sync_clients 按下发名单；未配置则懒下发（仅已有 prompt 投射的 Agent）
    if (s.id === BUILTIN_PROMPTS_ID) {
      const explicit = Array.isArray(s.sync_clients) || Array.isArray(s.metadata?.sync_clients);
      if (explicit) return getServerSyncClients(s).includes(clientId);
      try { return require('./resource-manager').hasPromptProjections(clientId); }
      catch { return false; }
    }

    // 其它 MCP：须在该 Agent 的同步分配列表中（取消勾选 = 不再下发）
    if (!getServerSyncClients(s).includes(clientId)) return false;
    return true;
  });
}

/** 统计各 Agent 配置文件中扫描到的 MCP 数量 */
function buildScanIndex() {
  const index = {};
  for (const item of scanAllClientMcps()) {
    if (!index[item.clientId]) index[item.clientId] = new Map();
    index[item.clientId].set(item.clientKey, item);
  }
  return index;
}

function getSyncStatus() {
  const state = readState();
  const scanIndex = buildScanIndex();
  let isAgentInstalled = () => false;
  let warmInstalled = () => {};
  try {
    const targets = require('./resource-agent-targets');
    isAgentInstalled = targets.isAgentInstalled;
    warmInstalled = targets.warmAgentInstalledCache || (() => {});
  } catch { /* ignore */ }
  // 预热各 Agent 安装探测，避免 targets.map 里反复 spawn
  warmInstalled(Object.keys(CLIENT_TARGETS));

  return {
    state,
    agents: Object.entries(CLIENT_TARGETS).map(([id, t]) => ({ id, label: t.label })),
    targets: Object.entries(CLIENT_TARGETS).map(([id, t]) => {
      const paths = t.getPaths ? t.getPaths() : [t.getPath()];
      const existingPath = paths.find(p => fs.existsSync(p)) || paths[0];
      const scannedKeys = scanIndex[id] ? [...scanIndex[id].keys()] : [];
      const syncedCount = state.clients[id]?.count || 0;
      const installed = !!isAgentInstalled(id);

      return {
        id,
        label: t.label,
        path: existingPath,
        paths,
        exists: paths.some(p => fs.existsSync(p)),
        lastSync: state.clients[id]?.lastSync || null,
        count: Math.max(syncedCount, scannedKeys.length),
        scannedCount: scannedKeys.length,
        syncedCount,
        syncEnabled: t.sync !== false,
        // 与 Skill/Prompt 一致：仅展示本机已纳管的应用
        installed,
        bindings: state.clients[id]?.bindings || [],
        scannedKeys,
      };
    }),
  };
}

/** serverId → 各 Agent 客户端安装记录 */
function getServerInstallMap() {
  const state = readState();
  const map = {};
  for (const [clientId, clientState] of Object.entries(state.clients || {})) {
    const label = CLIENT_TARGETS[clientId]?.label || clientId;
    for (const b of clientState.bindings || []) {
      if (!b.serverId) continue;
      if (!map[b.serverId]) map[b.serverId] = [];
      map[b.serverId].push({
        clientId,
        label,
        clientKey: b.clientKey,
      });
    }
  }
  return map;
}

/** 为 server 列表附加各 Agent 安装情况（同步写入 + 配置文件扫描） */
function enrichServersWithClientInstalls(servers) {
  const installMap = getServerInstallMap();
  const scanIndex = buildScanIndex();
  const allClients = Object.entries(CLIENT_TARGETS).map(([id, t]) => ({ id, label: t.label }));
  let isAgentInstalled = () => false;
  try {
    const targets = require('./resource-agent-targets');
    isAgentInstalled = targets.isAgentInstalled;
    // 一次预热：避免 servers×clients 笛卡尔积重复探测
    if (typeof targets.warmAgentInstalledCache === 'function') {
      targets.warmAgentInstalledCache(allClients.map((c) => c.id));
    }
  } catch { /* ignore */ }
  // 每客户端只算一次
  const installedByClient = new Map(allClients.map((c) => [c.id, !!isAgentInstalled(c.id)]));

  return (servers || []).map(s => {
    // 以配置文件扫描为准：sync-state 残留绑定若文件已删，不算「已安装」
    const installs = [];
    const inConfigSet = new Set();

    for (const inst of (installMap[s.id] || [])) {
      const keyMap = scanIndex[inst.clientId];
      if (!keyMap) continue;
      const keys = [inst.clientKey, s.name].filter(Boolean);
      if (!keys.some(k => keyMap.has(k))) continue;
      installs.push(inst);
      inConfigSet.add(inst.clientId);
    }

    // 扫描匹配：按 server.name 或已绑定的 clientKey 在各 Agent 配置中查找
    const matchKeys = new Set([s.name].filter(Boolean));
    for (const inst of installs) {
      if (inst.clientKey) matchKeys.add(inst.clientKey);
    }

    for (const [clientId, keyMap] of Object.entries(scanIndex)) {
      if (inConfigSet.has(clientId)) continue;
      const target = CLIENT_TARGETS[clientId];
      for (const key of matchKeys) {
        if (keyMap.has(key)) {
          installs.push({
            clientId,
            label: target?.label || clientId,
            clientKey: key,
            source: 'scan',
          });
          inConfigSet.add(clientId);
          break;
        }
      }
    }

    return {
      ...s,
      sync_clients: getServerSyncClients(s),
      clientInstalls: installs,
      clientTargets: allClients.map(c => {
        const inConfig = inConfigSet.has(c.id);
        const agentOk = !!installedByClient.get(c.id);
        return {
          ...c,
          syncAssigned: getServerSyncClients(s).includes(c.id) && CLIENT_TARGETS[c.id]?.sync !== false,
          syncEnabled: CLIENT_TARGETS[c.id]?.sync !== false,
          // 仅本机已纳管的应用算「已投射」；配置残留但未安装的不展示
          inConfig,
          installed: inConfig && agentOk,
          synced: installs.some(i => i.clientId === c.id && i.source !== 'scan'),
          clientKey: installs.find(i => i.clientId === c.id)?.clientKey || null,
        };
      }),
    };
  });
}

/** 安装完成后的提示文案（按目标 Agent 区分） */
function getPostSyncHint(options = {}) {
  const { clientIds, results } = options;
  const syncedIds = new Set([
    ...(Array.isArray(clientIds) ? clientIds : []),
    ...(Array.isArray(results) ? results.filter(r => r.success).map(r => r.clientId) : []),
  ]);

  const lines = ['已写入客户端配置文件。'];

  if (syncedIds.has('workbuddy')) {
    lines.push(
      'WorkBuddy 目前仅写入配置，还需手动信任后才会真正激活：请到 WorkBuddy 右上角「连接器管理」，对每个新出现的 MCP 服务器点击「Trust」启用。',
    );
  }

  const needReload = ['cursor', 'codex'].filter(id => syncedIds.has(id));
  if (needReload.length) {
    lines.push(`${needReload.map(id => CLIENT_TARGETS[id]?.label || id).join(' / ')} 需重启或 Reload Window 后才会扫描到新 MCP。`);
  }

  return lines.join('\n');
}

/** Token Bank 上次写入各客户端的 MCP 键名 */
function getTbManagedClientKeys() {
  const state = readState();
  const set = new Set();
  for (const [clientId, clientState] of Object.entries(state.clients || {})) {
    for (const key of clientState.keys || []) {
      set.add(`${clientId}:${key}`);
    }
  }
  return set;
}

function normalizeMcpEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.enabled === false) return null;

  const url = raw.url || raw.httpUrl || raw.sseUrl || null;
  const entry = {
    command: raw.command ? String(raw.command) : '',
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : {},
    url: url ? String(url) : null,
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : undefined,
  };
  if (!entry.command && !entry.url) return null;
  return entry;
}

function deepGet(obj, dotKey) {
  const parts = dotKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return null;
  }
  return cur;
}

/** 读取 JSON/JSON5 配置文件 */
function readJsonConfig(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    // OpenClaw 等可能使用 JSON5 注释，尽力剥离 //
    const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(stripped);
  }
}

/** 从 Agent 配置文件解析 MCP 条目 → [[clientKey, raw], ...] */
function parseMcpEntriesFromFile(filePath, target) {
  const format = target.format;

  if (format === 'json-mcp') {
    const doc = loadJsonMcp(filePath);
    return Object.entries(doc.mcpServers || {});
  }

  if (format === 'yaml-mcp-servers') {
    const yaml = require('js-yaml').load(fs.readFileSync(filePath, 'utf8')) || {};
    return Object.entries(yaml.mcp_servers || {});
  }

  if (format === 'json-nested') {
    const doc = readJsonConfig(filePath);
    const nested = deepGet(doc, target.nestedKey || 'mcp.servers');
    return Object.entries(nested && typeof nested === 'object' ? nested : {});
  }

  if (format === 'toml-mcp') {
    return parseCodexMcpSections(fs.readFileSync(filePath, 'utf8'))
      .map(({ clientKey, entry }) => [clientKey, entry]);
  }

  if (format === 'cordis-mcp-client') {
    return parseCordisMcpClientSections(fs.readFileSync(filePath, 'utf8'))
      .map(({ clientKey, entry }) => [clientKey, entry]);
  }

  return [];
}

function parseTomlScalar(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    try { return JSON.parse(s); } catch { return s; }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}

/** 解析 Codex config.toml 中的 mcp_servers.* 段（含 Token Bank 与用户自配） */
function parseCodexMcpSections(text) {
  const entries = [];
  const lines = String(text || '').split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const head = lines[i].match(/^\s*\[mcp_servers\.([^\].]+)\]\s*$/);
    if (head) {
      const key = head[1];
      const entry = { command: '', args: [], env: {} };
      i += 1;
      while (i < lines.length && !/^\s*\[/.test(lines[i])) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#')) {
          const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
          if (kv) {
            const val = parseTomlScalar(kv[2]);
            if (kv[1] === 'command') entry.command = String(val || '');
            else if (kv[1] === 'args') entry.args = Array.isArray(val) ? val.map(String) : [];
          }
        }
        i += 1;
      }
      if (entry.command) entries.push({ clientKey: key, entry });
      continue;
    }

    const envHead = lines[i].match(/^\s*\[mcp_servers\.([^\].]+)\.env\]\s*$/);
    if (envHead) {
      const key = envHead[1];
      let target = entries.find(e => e.clientKey === key);
      if (!target) {
        target = { clientKey: key, entry: { command: '', args: [], env: {} } };
        entries.push(target);
      }
      i += 1;
      while (i < lines.length && !/^\s*\[/.test(lines[i])) {
        const line = lines[i].trim();
        if (line && !line.startsWith('#')) {
          const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
          if (kv) target.entry.env[kv[1]] = String(parseTomlScalar(kv[2]) || '');
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }

  return entries.filter(e => e.entry.command);
}

/** 扫描各 Agent 客户端配置文件中的 MCP 条目 */
function scanAllClientMcps() {
  // 短缓存：同一次页面加载会并发 listServers + getSyncStatus，避免重复读盘解析
  const now = Date.now();
  if (_scanAllCache && (now - _scanAllCache.at) < SCAN_CACHE_TTL_MS) {
    return _scanAllCache.items;
  }

  const results = [];

  for (const [clientId, target] of Object.entries(CLIENT_TARGETS)) {
    const paths = target.getPaths ? target.getPaths() : [target.getPath()];

    for (const filePath of paths) {
      if (!fs.existsSync(filePath)) continue;

      try {
        const pairs = parseMcpEntriesFromFile(filePath, target);
        for (const [clientKey, raw] of pairs) {
          const entry = normalizeMcpEntry(raw);
          if (!entry) continue;
          results.push({
            clientId,
            clientKey,
            entry,
            label: target.label,
            path: filePath,
          });
        }
      } catch (e) {
        console.warn(`[mcp-client-sync] scan ${clientId} (${filePath}) failed:`, e.message);
      }
    }
  }

  _scanAllCache = { at: now, items: results };
  return results;
}

/** 写盘后清扫描缓存，保证下次读到最新配置 */
function invalidateScanCache() {
  _scanAllCache = null;
}

function inferClientMcpDescription(entry) {
  const args = entry?.args || [];
  const pkg = args.find(a => typeof a === 'string' && (a.includes('/') || a.includes('-mcp')));
  if (pkg) return `客户端自配 · ${pkg}`;
  if (entry?.url) return `客户端自配 · ${entry.url}`;
  if (entry?.command) return `客户端自配 · ${path.basename(entry.command)}`;
  return '客户端自配 MCP';
}

/**
 * 发现客户端配置中存在、但未被 Token Bank 同步管理的 MCP
 * @param {object[]} managedServers 来自 DB 的已纳管列表
 */
function discoverExternalMcps(managedServers = []) {
  const tbKeys = getTbManagedClientKeys();
  const state = readState();

  // 已由 Token Bank 纳管的 MCP 在客户端可能使用的键名（避免与已纳管条目重复展示）
  const managedClientKeys = new Set();
  for (const srv of managedServers || []) {
    if (srv.name) managedClientKeys.add(srv.name);
  }
  for (const clientState of Object.values(state.clients || {})) {
    for (const b of clientState.bindings || []) {
      if (b.clientKey) managedClientKeys.add(b.clientKey);
    }
  }

  const byKey = new Map();

  for (const item of scanAllClientMcps()) {
    if (tbKeys.has(`${item.clientId}:${item.clientKey}`)) continue;
    if (managedClientKeys.has(item.clientKey)) continue;

    if (!byKey.has(item.clientKey)) {
      byKey.set(item.clientKey, {
        clientKey: item.clientKey,
        entry: item.entry,
        clients: [],
      });
    }
    const group = byKey.get(item.clientKey);
    if (!group.clients.some(c => c.clientId === item.clientId)) {
      group.clients.push({
        clientId: item.clientId,
        label: item.label,
        path: item.path,
      });
    }
  }

  const allClients = Object.entries(CLIENT_TARGETS).map(([id, t]) => ({ id, label: t.label }));
  let isAgentInstalled = () => false;
  try {
    const targets = require('./resource-agent-targets');
    isAgentInstalled = targets.isAgentInstalled;
    if (typeof targets.warmAgentInstalledCache === 'function') {
      targets.warmAgentInstalledCache(allClients.map((c) => c.id));
    }
  } catch { /* ignore */ }
  const installedByClient = new Map(allClients.map((c) => [c.id, !!isAgentInstalled(c.id)]));

  return Array.from(byKey.values())
    .map(group => {
      const inConfigSet = new Set(group.clients.map(c => c.clientId));
      return {
        id: `client-external:${group.clientKey}`,
        name: group.clientKey,
        display_name: group.clientKey,
        type: group.entry.url ? 'sse' : 'stdio',
        command: group.entry.command,
        args: group.entry.args,
        env: group.entry.env,
        url: group.entry.url || null,
        builtin: false,
        status: 'active',
        source: 'client',
        managed: false,
        metadata: {
          description: inferClientMcpDescription(group.entry),
          category: 'client',
          clientKey: group.clientKey,
        },
        clientInstalls: group.clients.map(c => ({
          clientId: c.clientId,
          label: c.label,
          clientKey: group.clientKey,
        })),
        clientTargets: allClients.map(c => {
          const inConfig = inConfigSet.has(c.id);
          return {
            ...c,
            inConfig,
            installed: inConfig && !!installedByClient.get(c.id),
            clientKey: inConfig ? group.clientKey : null,
          };
        }),
      };
    })
    .sort((a, b) => a.display_name.localeCompare(b.display_name, 'zh-CN'));
}

/** 读取指定 clientKey 的客户端 MCP 配置（用于纳管导入） */
function getClientMcpEntry(clientKey) {
  for (const item of scanAllClientMcps()) {
    if (item.clientKey === clientKey) return item;
  }
  return null;
}

/** 读取指定 Agent 上的 MCP 配置（纳管时不改动该 Agent 原配置） */
function getClientMcpEntryForAgent(clientId, clientKey) {
  const key = String(clientKey || '').trim();
  if (!clientId || !key) return null;
  for (const item of scanAllClientMcps()) {
    if (item.clientId === clientId && item.clientKey === key) return item;
  }
  return null;
}

/** 从 sync-state 去掉某 Agent 上的指定 MCP 键（与配置文件删除保持一致） */
function pruneClientSyncStateKey(clientId, clientKey) {
  const state = readState();
  const client = state.clients?.[clientId];
  if (!client) return;
  const key = String(clientKey || '').trim();
  if (!key) return;
  const nextKeys = (client.keys || []).filter(k => k !== key);
  const nextBindings = (client.bindings || []).filter(b => b.clientKey !== key);
  if (nextKeys.length === (client.keys || []).length
    && nextBindings.length === (client.bindings || []).length) {
    return;
  }
  state.clients[clientId] = {
    ...client,
    keys: nextKeys,
    bindings: nextBindings,
    count: nextKeys.length,
  };
  writeState(state);
}

/** 从 Agent 配置文件删除指定 MCP 条目（用户自配或非 TB 写入） */
function removeRawClientMcpEntry(clientId, clientKey, { ignoreMissing = false } = {}) {
  const target = CLIENT_TARGETS[clientId];
  if (!target) throw new Error(`未知 Agent: ${clientId}`);
  const key = String(clientKey || '').trim();
  if (!key) throw new Error('缺少 clientKey');

  const paths = target.getPaths ? target.getPaths() : [target.getPath()];
  let removedPath = null;

  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;

    try {
      if (target.format === 'json-mcp') {
        const doc = loadJsonMcp(filePath);
        if (!doc.mcpServers[key]) continue;
        delete doc.mcpServers[key];
        fs.writeFileSync(filePath, JSON.stringify(doc, null, 2));
        removedPath = filePath;
        break;
      }

      if (target.format === 'yaml-mcp-servers') {
        const yaml = require('js-yaml');
        const doc = yaml.load(fs.readFileSync(filePath, 'utf8')) || {};
        if (!doc.mcp_servers?.[key]) continue;
        delete doc.mcp_servers[key];
        if (!Object.keys(doc.mcp_servers).length) delete doc.mcp_servers;
        fs.writeFileSync(filePath, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
        removedPath = filePath;
        break;
      }

      if (target.format === 'json-nested') {
        const doc = readJsonConfig(filePath);
        const nested = deepGet(doc, target.nestedKey || 'mcp.servers');
        if (!nested || !nested[key]) continue;
        delete nested[key];
        fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
        removedPath = filePath;
        break;
      }

      if (target.format === 'toml-mcp') {
        const original = fs.readFileSync(filePath, 'utf8');
        const stripped = stripCodexMcpKey(original, key);
        if (stripped === original) continue;
        fs.writeFileSync(filePath, stripped.endsWith('\n') ? stripped : stripped + '\n', 'utf8');
        removedPath = filePath;
        break;
      }

      if (target.format === 'cordis-mcp-client') {
        const original = fs.readFileSync(filePath, 'utf8');
        const stripped = stripCordisMcpKey(original, key);
        if (stripped === original) continue;
        fs.writeFileSync(filePath, stripped.endsWith('\n') ? stripped : stripped + '\n', 'utf8');
        removedPath = filePath;
        break;
      }
    } catch (e) {
      console.warn(`[mcp-client-sync] remove ${clientId}/${key} from ${filePath}:`, e.message);
    }
  }

  // 无论文件是否已删，都清 sync-state，避免「已安装于」残留
  pruneClientSyncStateKey(clientId, key);
  invalidateScanCache();

  if (removedPath) return { clientId, clientKey: key, path: removedPath };
  if (ignoreMissing) return { clientId, clientKey: key, path: null, skipped: true };
  throw new Error(`未在 ${target.label} 配置中找到: ${key}`);
}

/**
 * 按 Agent 维度汇总配置文件中的 MCP（通过 TB 安装 / 客户端自配）
 * @param {object[]} managedServers Token Bank 已纳管列表
 */
function listAgentInstallations(managedServers = []) {
  const state = readState();
  const scanIndex = buildScanIndex();
  const installMap = getServerInstallMap();
  const managedById = new Map((managedServers || []).map(s => [s.id, s]));

  function findManagedByClientKey(clientKey, agentId) {
    for (const s of managedServers || []) {
      if (s.name === clientKey) return s;
      const installs = installMap[s.id] || [];
      if (installs.some(i => i.clientId === agentId && i.clientKey === clientKey)) return s;
    }
    return null;
  }

  let isAgentInstalled = () => false;
  try { isAgentInstalled = require('./resource-agent-targets').isAgentInstalled; } catch { /* ignore */ }

  return Object.entries(CLIENT_TARGETS).map(([agentId, target]) => {
    const paths = target.getPaths ? target.getPaths() : [target.getPath()];
    const existingPath = paths.find(p => fs.existsSync(p)) || paths[0];
    const keyMap = scanIndex[agentId] || new Map();
    const bindings = state.clients[agentId]?.bindings || [];
    const bindingByKey = new Map(bindings.map(b => [b.clientKey, b]));
    const installed = !!isAgentInstalled(agentId);

    const items = [];
    for (const [clientKey, scanItem] of keyMap) {
      const binding = bindingByKey.get(clientKey);
      const managed = findManagedByClientKey(clientKey, agentId);
      let source = 'client';
      let serverId = null;
      let displayName = clientKey;

      if (binding?.serverId) {
        source = 'tb_sync';
        serverId = binding.serverId;
        const srv = managedById.get(serverId);
        displayName = srv?.display_name || srv?.name || clientKey;
      } else if (managed) {
        source = 'tb_scanned';
        serverId = managed.id;
        displayName = managed.display_name || managed.name;
      }

      items.push({
        clientKey,
        displayName,
        serverId,
        managed: !!managed || source === 'tb_sync',
        source,
        type: scanItem.entry?.url ? 'sse' : 'stdio',
        command: scanItem.entry?.command || '',
        args: scanItem.entry?.args || [],
        description: source === 'client'
          ? inferClientMcpDescription(scanItem.entry)
          : (managedById.get(serverId)?.metadata?.description || displayName),
      });
    }

    items.sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN'));

    return {
      id: agentId,
      label: target.label,
      path: existingPath,
      paths,
      exists: paths.some(p => fs.existsSync(p)),
      syncEnabled: target.sync !== false,
      installed,
      count: items.length,
      items,
    };
  });
}

/** 从 Codex config.toml 删除单个 mcp_servers.* 段 */
function stripCodexMcpKey(text, key) {
  let lines = String(text || '').split(/\r?\n/);
  const headRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(key)}\\]\\s*$`);
  const envRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(key)}\\.env\\]\\s*$`);
  let i = 0;
  while (i < lines.length) {
    if (headRe.test(lines[i]) || envRe.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
      lines.splice(i, j - i);
      continue;
    }
    i += 1;
  }
  return lines.join('\n');
}

module.exports = {
  syncAll,
  getSyncStatus,
  getPostSyncHint,
  getServerInstallMap,
  enrichServersWithClientInstalls,
  discoverExternalMcps,
  listAgentInstallations,
  getClientMcpEntry,
  getClientMcpEntryForAgent,
  removeRawClientMcpEntry,
  scanAllClientMcps,
  invalidateScanCache,
  inferClientMcpDescription,
  getServerSyncClients,
  filterServersForClient,
  CLIENT_TARGETS,
  serverToEntry,
  syncJsonClient,
  syncCodexClient,
  stripCodexManagedMcpBlock,
  syncCordisClient,
  parseCordisMcpClientSections,
  stripCordisManagedBlock,
  stripCordisMcpKey,
  dshRowFromEntry,
};
