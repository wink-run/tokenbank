// client/electron/mcp-manager.js
// MCP 供给源管理：Server 注册、Profile 裁剪、编排模式配置生成
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const localStats = require('./local-stats');
const { STATS_DIR } = require('../shared/telemetry');
let shim = null;
try { shim = require('./shim-installer'); } catch { /* optional in CLI */ }
const { getCatalogItem, listCatalogItems, listCatalogGrouped, MCP_CATEGORY_GROUPS } = require('./mcp-catalog');
const { clearExecRestrictions, mcpStdioFromLauncher } = require('./host-exec');

const { DELIVERY_POLICY } = require('./agent-delivery-policy');
const { formatOrchestratorCapabilityHint } = require('./tb-capabilities');

/** 编排层系统提示（Claude / Codex 共用） */
const ORCHESTRATOR_SYSTEM = [
  '你是 Token Bank 聚合入口的主 Agent（编排层），不是默认执行者。',
  '核心职责：分析任务 → 匹配并派发已雇佣社区智能体 → 汇总交付。少废话、少空转、结果导向。',
  '',
  '【标准流程 — 按序执行】',
  '1. 分析：用 1～3 句拆解目标、约束（路径/格式/语言）、成功标准；复杂任务拆成可独立派发的子步骤（依赖清晰：可并行则并行，有先后则串行）。',
  '2. 发现：立刻 tb_list_agents（仅返回本机已雇佣的 community:*，列表刻意精简）；禁止先在 shell 里 which/npm/跑 CLI。',
  '3. 匹配：按名称/能力/描述选最合适的已雇佣社区智能体。',
  '4. 派发：有匹配必须 tb_dispatch_agent（对方设备执行）；禁止自己做本可派发的专业活。',
  '   子任务 prompt 要自洽：目标 + 输入/上下文 + 约束 + 期望产出（路径/格式）；勿丢用户关键细节。',
  '5. 汇总：综合各子结果，用清晰结构回复用户（结论 → 关键产出/路径 → 未完成项）；去掉过程噪音。',
  '',
  '【决策优先级】',
  'A. 已雇佣社区智能体（community:*）＞ B. 自己动手。',
  'B 仅当 list 为空或无匹配；须简述「无人可派」原因；新雇佣请用户到 Token Bank 「交易」页操作。',
  '',
  '【异常兜底】',
  '- list 失败/为空：重试一次 list；仍空则自行完成，并告知用户暂无已雇佣智能体。',
  '- 派发失败/超时/子任务 error：换相近已雇智能体重试一次；仍失败再自行补全，并向用户说明。',
  '- 子结果残缺/跑偏：可带更明确约束再派发一次纠偏；仍不行则自己补全或请用户补充。',
  '- 多步中某步失败：保留已成功步骤产出，仅重试/降级失败步，最后汇总「已完成 / 失败 / 待办」。',
  '- 工具/MCP 不可用：跳过该路径，改用可用工具或降级执行，并在汇总中注明限制。',
  '',
  '【效率与表达】',
  '- 简单单域任务：list → 一次派发 → 短汇总；不要为流程而流程。',
  '- 禁止把「分析」写成冗长独白；对用户可见回复以最终交付为主，过程点到为止。',
  '- PPT/文件等产物：要求子 Agent 或自身直接写入工作目录，禁止让用户粘贴一键保存脚本。',
  formatOrchestratorCapabilityHint(),
  '',
  DELIVERY_POLICY,
].join('\n');

/** 支持 MCP 编排的主 Agent */
const ORCHESTRATOR_AGENTS = new Set(['claude-code', 'codex', 'cursor']);

const BUILTIN_BRIDGE_ID = 'tokenbank-agent-bridge';
const BUILTIN_PROMPTS_ID = 'tokenbank-prompts';
const BUILTIN_MODELS_ID = 'tokenbank-models';
const BUILTIN_RESOURCES_ID = 'tokenbank-resources';

/** 可进「通用」中转档、并默认同步到 Agent 的 Token Bank 内置 MCP（含派发桥） */
function isTokenbankBuiltinRelayId(serverId) {
  return serverId === BUILTIN_BRIDGE_ID
    || serverId === BUILTIN_PROMPTS_ID
    || serverId === BUILTIN_MODELS_ID
    || serverId === BUILTIN_RESOURCES_ID;
}

/** 当前任务上下文，供已写入配置的派发 MCP 在调用时读取（不再为每次派发单独写临时 MCP） */
function writeBridgeActiveContext(ctx = {}) {
  const dir = path.join(os.homedir(), '.tokenbank', 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'bridge-context.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cur = {}; }
  if (!cur.byClient || typeof cur.byClient !== 'object') cur.byClient = {};
  const clientId = String(ctx.mainAgentId || '').trim() || 'default';
  cur.byClient[clientId] = {
    parentTaskId: ctx.taskId || '',
    parentSessionKey: ctx.sessionKey || '',
    parentSessionInstance: ctx.sessionInstanceId || '',
    workingDir: ctx.workingDir || '',
    mainAgentId: clientId,
    at: Date.now(),
  };
  fs.writeFileSync(file, JSON.stringify(cur, null, 2));
}

/** 与网关聚合工具名前缀一致（name → pipeworx__ask_pipeworx） */
function mcpToolPrefix(name) {
  return String(name || 'mcp')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'mcp';
}
/** 默认即开发模式（含 Agent 桥 + 已纳管工具 MCP），不再做多 Profile 选择 */
const DEVELOPMENT_PROFILE_ID = 'development';
const DEFAULT_PROFILE_ID = DEVELOPMENT_PROFILE_ID;
const DISPATCH_SCRIPT = path.join(__dirname, 'agent-dispatch-mcp.js');
const PROMPTS_SCRIPT = path.join(__dirname, 'prompt-mcp.js');
const MODELS_SCRIPT = path.join(__dirname, 'models-mcp.js');
const RESOURCES_SCRIPT = path.join(__dirname, 'resources-mcp.js');

/** shell 单引号转义（用于 Unix launcher） */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Windows cmd 双引号转义（路径/参数） */
function winCmdQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** Windows `set "KEY=value"`：% 需加倍，避免被当成环境变量展开 */
function winCmdSet(key, value) {
  const safe = String(value).replace(/%/g, '%%').replace(/"/g, '');
  return `set "${key}=${safe}"`;
}

/**
 * 解析 Electron 可执行文件路径。
 * 主进程 / ELECTRON_RUN_AS_NODE 下用 process.execPath；
 * 若被系统 Node 误调用（如单测、脚本同步），回退到 electron 包二进制，避免把 node 写进 launcher。
 */
function resolveElectronBinary() {
  if (process.versions.electron) return process.execPath;
  const exec = process.execPath || '';
  if (/[/\\]Electron(\.app)?[/\\]|[/\\]electron([/\\.]|$)/i.test(exec)) return exec;
  try {
    // 在纯 Node 中 require('electron') 返回二进制路径字符串
    const electronPkg = require('electron');
    if (typeof electronPkg === 'string' && fs.existsSync(electronPkg)) return electronPkg;
  } catch { /* ignore */ }
  const platformRel = process.platform === 'darwin'
    ? path.join('electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
    : process.platform === 'win32'
      ? path.join('electron', 'dist', 'electron.exe')
      : path.join('electron', 'dist', 'electron');
  const candidates = [
    path.join(__dirname, '..', 'node_modules', platformRel),
    path.join(process.cwd(), 'node_modules', platformRel),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return exec;
}

/**
 * 写入 Electron-as-node 启动脚本。
 * Codex 等客户端常不透传 mcp_servers.*.env，直接 spawn Electron 会进 GUI 并 SIGABRT；
 * 脚本内固定 ELECTRON_RUN_AS_NODE，并用 env 再写一遍作双保险。
 * Windows 写 .cmd（Agent 无法执行 bash .sh）。
 * @param {{ name: string, scriptPath: string, env?: object, platform?: string, mcpDir?: string }} opts
 */
function writeElectronAsNodeLauncher({ name, scriptPath, env = {}, platform = process.platform, mcpDir } = {}) {
  const dir = mcpDir || path.join(os.homedir(), '.tokenbank', 'mcp');
  fs.mkdirSync(dir, { recursive: true });
  const electronBin = resolveElectronBinary();
  const absScript = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(scriptPath);
  const isWin = platform === 'win32';
  const launcherPath = path.join(dir, `${name}${isWin ? '.cmd' : '.sh'}`);

  if (isWin) {
    const envSets = Object.entries(env || {}).map(([k, v]) => winCmdSet(k, v));
    const lines = [
      '@echo off',
      'setlocal',
      winCmdSet('ELECTRON_RUN_AS_NODE', '1'),
      ...envSets,
      // electron.exe 直接调用（勿用 call，call 主要用于批处理）
      `${winCmdQuote(electronBin)} ${winCmdQuote(absScript)} %*`,
      '',
    ];
    fs.writeFileSync(launcherPath, lines.join('\r\n'), 'utf8');
    clearExecRestrictions(launcherPath);
    return launcherPath;
  }

  const envExports = Object.entries(env || {}).map(
    ([k, v]) => `export ${k}=${shellQuote(String(v))}`,
  );
  const lines = [
    '#!/bin/sh',
    'export ELECTRON_RUN_AS_NODE=1',
    ...envExports,
    `exec env ELECTRON_RUN_AS_NODE=1 ${shellQuote(electronBin)} ${shellQuote(absScript)}`,
    '',
  ];
  fs.writeFileSync(launcherPath, lines.join('\n'), { mode: 0o755 });
  clearExecRestrictions(launcherPath);
  return launcherPath;
}

/**
 * 写入 bridge MCP 启动脚本：Codex 等外部进程拉起 Electron 时未必透传 env，
 * 缺 ELECTRON_RUN_AS_NODE 会触发 NSApplication 注册并 SIGABRT 崩溃。
 * Windows 写 .cmd。
 */
function writeBridgeMcpLauncher({
  taskId,
  workingDir,
  mainAgentId,
  sessionKey,
  sessionInstanceId,
  mcpDir,
  platform = process.platform,
}) {
  const dispatchEnv = {};
  try {
    const { getDispatchEndpoint } = require('./agent-dispatch-server');
    const ep = getDispatchEndpoint();
    // 走主进程 HTTP 派发，避免 Codex 沙箱内子进程写 SQLite 报 readonly database
    if (ep?.url && ep?.token) {
      dispatchEnv.TB_DISPATCH_URL = ep.url;
      dispatchEnv.TB_DISPATCH_TOKEN = ep.token;
    }
  } catch { /* 单测或未启动主进程时回退本地派发 */ }

  const env = {
    TB_PARENT_TASK_ID: taskId || '',
    TB_PARENT_SESSION_KEY: sessionKey || '',
    TB_PARENT_SESSION_INSTANCE: sessionInstanceId || '',
    TB_WORKING_DIR: workingDir || process.cwd(),
    TB_MAIN_AGENT_ID: mainAgentId || '',
    TB_CLIENT_ID: mainAgentId || '',
    ...dispatchEnv,
  };

  return writeElectronAsNodeLauncher({
    name: `bridge-${taskId}`,
    scriptPath: DISPATCH_SCRIPT,
    env,
    platform,
    mcpDir,
  });
}

/** 生成 Codex 编排临时 profile（完整 [mcp_servers.*] 表，避免 -c 局部覆盖导致 invalid transport） */
function buildCodexOrchestratorProfileToml(servers, ctx, buildRuntimeConfig) {
  const lines = ['# Token Bank orchestrator MCP profile (ephemeral)'];
  for (const srv of servers) {
    const cfg = buildRuntimeConfig(srv, ctx);
    const name = srv.name;
    const isBridge = srv.id === BUILTIN_BRIDGE_ID || srv.name === BUILTIN_BRIDGE_ID;
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`command = ${JSON.stringify(cfg.command)}`);
    lines.push(`args = ${JSON.stringify(cfg.args || [])}`);
    lines.push('enabled = true');
    // 内置 bridge 必须启动，否则编排层无法派发子 Agent
    if (isBridge) lines.push('required = true');
    if (cfg.env && Object.keys(cfg.env).length) {
      lines.push('');
      lines.push(`[mcp_servers.${name}.env]`);
      for (const [k, v] of Object.entries(cfg.env)) {
        lines.push(`${k} = ${JSON.stringify(String(v))}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

class MCPManager {
  constructor() {
    this._seeded = false;
  }

  _getDb() {
    return localStats.requireDb(STATS_DIR);
  }

  /** 初始化内置 MCP Server 与默认 Profile（幂等） */
  init() {
    if (this._seeded) return;
    const db = this._getDb();
    const now = Date.now();

    this._ensureBuiltinBridge(now);
    this._ensureBuiltinPrompts(now);
    this._ensureBuiltinModels(now);
    this._ensureBuiltinResources(now);

    const profiles = [
      {
        id: DEFAULT_PROFILE_ID,
        name: 'orchestrator-default',
        display_name: '编排默认',
        description: '聚合入口默认 Profile，含 Agent 派发桥',
        rules: JSON.stringify({ include: ['tokenbank-*'], servers: [BUILTIN_BRIDGE_ID] }),
      },
      {
        id: 'orchestrator-minimal',
        name: 'orchestrator-minimal',
        display_name: '编排精简',
        description: '仅 Agent 派发桥，不含外部 MCP',
        rules: JSON.stringify({ include: [BUILTIN_BRIDGE_ID], servers: [BUILTIN_BRIDGE_ID] }),
      },
      {
        id: DEVELOPMENT_PROFILE_ID,
        name: 'development',
        display_name: '开发模式',
        description: 'Agent 派发 + 已纳管的工具 MCP',
        rules: JSON.stringify({ include: ['*'], servers: [BUILTIN_BRIDGE_ID] }),
      },
    ];

    for (const p of profiles) {
      const row = db.prepare('SELECT id FROM mcp_profiles WHERE id = ?').get(p.id);
      if (!row) {
        db.prepare(`
          INSERT INTO mcp_profiles (id, name, display_name, description, rules, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(p.id, p.name, p.display_name, p.description, p.rules, now);
      }
    }

    // Profile ↔ Server 绑定（默认 Profile 均含 bridge；models 进默认/开发 Profile）
    for (const profileId of [DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID]) {
      this._linkBuiltinBridgeToProfile(profileId);
    }
    for (const profileId of [DEFAULT_PROFILE_ID, DEVELOPMENT_PROFILE_ID]) {
      this._linkServerToProfile(profileId, BUILTIN_MODELS_ID);
      this._linkServerToProfile(profileId, BUILTIN_RESOURCES_ID);
    }

    // 通用中转档默认只挂 Token Bank 内置 MCP
    this._ensureBuiltinGatewayApiClients();
    this._seeded = true;
    // seeded 之后再默认投射，避免 sync→listManagedServers→init 重入未完成的 seed
    this._ensureBuiltinDefaultProjection();
    // 清掉已删除 API 应用残留的中转/投射，避免 MCP 页仍显示「New app」
    this.pruneStaleDeletedAppBindings();
  }

  /**
   * 内置 prompts/models/resources：默认投射到本机已安装可写 Agent。
   * 显式清空（sync_clients=[]）= 用户意图不投射，跳过；否则每次探测到新装 Agent
   * （如 deepseek-harness 刚被识别）就追加进列表，让新纳管应用自动拿到内置 MCP。
   */
  _ensureBuiltinDefaultProjection() {
    if (this._ensuringBuiltinProjection) return { updated: [] };
    this._ensuringBuiltinProjection = true;
    try {
      const { listInstalledClientIds } = require('./mcp-agent-targets');
      const installed = listInstalledClientIds();
      if (!installed.length) return { updated: [] };

      const db = this._getDb();
      const now = Date.now();
      const updated = [];
      for (const serverId of [BUILTIN_BRIDGE_ID, BUILTIN_PROMPTS_ID, BUILTIN_MODELS_ID, BUILTIN_RESOURCES_ID]) {
        const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(serverId);
        if (!row) continue;
        const metadata = this._parseJson(row.metadata, {});
        const cur = Array.isArray(metadata.sync_clients) ? metadata.sync_clients : [];
        // 显式清空 = 用户意图不投射 → 跳过；非空（含旧版自动投射）→ 仅追加新增，不删既有
        if (Array.isArray(metadata.sync_clients) && cur.length === 0) continue;
        const added = installed.filter(id => !cur.includes(id));
        if (!added.length) continue;
        const nextMeta = {
          ...metadata,
          sync_clients: [...cur, ...added],
          builtin_default_projected_at: now,
        };
        db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(nextMeta), now, serverId);
        updated.push(serverId);
      }
      if (updated.length) {
        try {
          this.syncToClients({ clientIds: installed });
        } catch (e) {
          console.warn('[mcp-manager] builtin default projection sync failed:', e.message);
        }
      }
      return { updated };
    } finally {
      this._ensuringBuiltinProjection = false;
    }
  }

  /** 将内置 prompts/models/resources 默认绑到通用中转档（api）；并清掉非内置上的 api 绑定 */
  _ensureBuiltinGatewayApiClients() {
    const db = this._getDb();
    const ids = [BUILTIN_BRIDGE_ID, BUILTIN_PROMPTS_ID, BUILTIN_MODELS_ID, BUILTIN_RESOURCES_ID];
    const now = Date.now();
    for (const serverId of ids) {
      const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(serverId);
      if (!row) continue;
      const metadata = this._parseJson(row.metadata, {});
      let clients = Array.isArray(metadata.gateway_clients)
        ? metadata.gateway_clients.filter((id) => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id))
        : [];
      if (!Array.isArray(metadata.gateway_clients) && metadata.gateway_routed) {
        clients = ['api'];
      }
      if (clients.includes('api')) continue;
      clients = [...clients, 'api'];
      const nextMeta = {
        ...metadata,
        gateway_clients: clients,
        gateway_routed: true,
      };
      db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(nextMeta), now, serverId);
    }

    // 非内置 MCP：从通用档移除（历史误绑）
    const rows = db.prepare('SELECT id, metadata FROM mcp_servers').all();
    for (const row of rows) {
      if (isTokenbankBuiltinRelayId(row.id)) continue;
      const metadata = this._parseJson(row.metadata, {});
      if (!Array.isArray(metadata.gateway_clients) || !metadata.gateway_clients.includes('api')) continue;
      const clients = metadata.gateway_clients.filter((id) => id !== 'api');
      const nextMeta = {
        ...metadata,
        gateway_clients: clients,
        gateway_routed: clients.length > 0,
      };
      db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(nextMeta), now, row.id);
    }
  }

  /** 确保内置 Prompts MCP 存在 */
  _ensureBuiltinPrompts(now = Date.now()) {
    const db = this._getDb();
    const prompts = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(BUILTIN_PROMPTS_ID);
    const prev = this._parseJson(prompts?.metadata, {});
    const meta = JSON.stringify({
      ...prev,
      description: '内置提示词服务：tb_get_prompt / tb_list_prompts（须先投射提示词到该 Agent）',
      tools: ['tb_get_prompt', 'tb_list_prompts'],
    });
    if (!prompts) {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'stdio', ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        BUILTIN_PROMPTS_ID,
        BUILTIN_PROMPTS_ID,
        'Token Bank Prompts',
        '__DYNAMIC_ELECTRON__',
        JSON.stringify([PROMPTS_SCRIPT]),
        JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
        meta,
        now,
        now,
      );
    } else {
      db.prepare('UPDATE mcp_servers SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run('active', meta, now, BUILTIN_PROMPTS_ID);
    }
  }

  /** 确保内置 Models MCP 存在（常驻：查可用模型 / 动态切换） */
  _ensureBuiltinModels(now = Date.now()) {
    const db = this._getDb();
    const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(BUILTIN_MODELS_ID);
    const prev = this._parseJson(row?.metadata, {});
    const meta = JSON.stringify({
      ...prev,
      description: '内置模型资源：tb_list_models / tb_resolve_model（查询网关可用模型并动态切换）',
      tools: ['tb_list_models', 'tb_resolve_model'],
    });
    if (!row) {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'stdio', ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        BUILTIN_MODELS_ID,
        BUILTIN_MODELS_ID,
        'Token Bank Models',
        '__DYNAMIC_ELECTRON__',
        JSON.stringify([MODELS_SCRIPT]),
        JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
        meta,
        now,
        now,
      );
    } else {
      db.prepare('UPDATE mcp_servers SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run('active', meta, now, BUILTIN_MODELS_ID);
    }
    for (const profileId of [DEFAULT_PROFILE_ID, DEVELOPMENT_PROFILE_ID]) {
      this._linkServerToProfile(profileId, BUILTIN_MODELS_ID);
    }
  }

  /** 确保内置 Resources MCP 存在（能力总览 + 已纳管/社区资源发现） */
  _ensureBuiltinResources(now = Date.now()) {
    const db = this._getDb();
    const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(BUILTIN_RESOURCES_ID);
    const prev = this._parseJson(row?.metadata, {});
    const meta = JSON.stringify({
      ...prev,
      description: '内置资源发现：能力总览 / 资源 / 中转 MCP / tb_get_prompt / 目录 / 网关',
      tools: ['tb_capabilities', 'tb_list_resources', 'tb_get_resource', 'tb_get_prompt', 'tb_list_prompts', 'tb_list_catalog', 'tb_list_gateway', 'tb_call_mcp'],
    });
    if (!row) {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'stdio', ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        BUILTIN_RESOURCES_ID,
        BUILTIN_RESOURCES_ID,
        'Token Bank Resources',
        '__DYNAMIC_ELECTRON__',
        JSON.stringify([RESOURCES_SCRIPT]),
        JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
        meta,
        now,
        now,
      );
    } else {
      db.prepare('UPDATE mcp_servers SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run('active', meta, now, BUILTIN_RESOURCES_ID);
    }
    for (const profileId of [DEFAULT_PROFILE_ID, DEVELOPMENT_PROFILE_ID]) {
      this._linkServerToProfile(profileId, BUILTIN_RESOURCES_ID);
    }
  }

  /** 确保内置 Agent Bridge 存在、启用，并绑定到编排默认 Profile */
  _ensureBuiltinBridge(now = Date.now()) {
    const db = this._getDb();
    const bridge = db.prepare('SELECT id, status, metadata FROM mcp_servers WHERE id = ?').get(BUILTIN_BRIDGE_ID);
    const bridgeMeta = JSON.stringify({
      description: '内置 Agent 派发桥：tb_list_agents / tb_dispatch_agent',
      tools: ['tb_list_agents', 'tb_dispatch_agent'],
    });
    if (!bridge) {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'stdio', ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        BUILTIN_BRIDGE_ID,
        BUILTIN_BRIDGE_ID,
        'Token Bank Agent Bridge',
        '__DYNAMIC_ELECTRON__',
        JSON.stringify([DISPATCH_SCRIPT]),
        JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
        bridgeMeta,
        now,
        now,
      );
    } else {
      // 刷新元数据（去掉误挂在 bridge 上的 tb_get_prompt）并确保 active
      db.prepare('UPDATE mcp_servers SET status = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run('active', bridgeMeta, now, BUILTIN_BRIDGE_ID);
    }

    for (const profileId of [DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID]) {
      this._linkBuiltinBridgeToProfile(profileId);
    }

    return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(BUILTIN_BRIDGE_ID);
  }

  _linkBuiltinBridgeToProfile(profileId) {
    const db = this._getDb();
    const link = db.prepare(
      'SELECT profile_id, enabled FROM mcp_profile_servers WHERE profile_id = ? AND server_id = ?',
    ).get(profileId, BUILTIN_BRIDGE_ID);
    if (!link) {
      db.prepare(`
        INSERT INTO mcp_profile_servers (profile_id, server_id, enabled)
        VALUES (?, ?, 1)
      `).run(profileId, BUILTIN_BRIDGE_ID);
    } else if (!link.enabled) {
      db.prepare(`
        UPDATE mcp_profile_servers SET enabled = 1
        WHERE profile_id = ? AND server_id = ?
      `).run(profileId, BUILTIN_BRIDGE_ID);
    }
  }

  /** 常见 MCP 目录 + 安装状态 */
  listCatalog() {
    this.init();
    const installed = new Map(this.listManagedServers().map(s => [s.id, s]));
    const enrich = (item) => {
      const row = installed.get(item.id);
      return {
        ...item,
        installed: !!row || !!item.alwaysInstalled,
        status: row?.status || (item.alwaysInstalled ? 'active' : 'inactive'),
        server: row || null,
      };
    };
    return listCatalogItems().map(enrich);
  }

  /** 按分类分组的常见 MCP 目录 */
  listCatalogGrouped() {
    this.init();
    const installed = new Map(this.listManagedServers().map(s => [s.id, s]));
    const enrich = (item) => {
      const row = installed.get(item.id);
      return {
        ...item,
        installed: !!row || !!item.alwaysInstalled,
        status: row?.status || (item.alwaysInstalled ? 'active' : 'inactive'),
        server: row || null,
      };
    };
    return listCatalogGrouped().map(group => ({
      ...group,
      items: group.items.map(enrich),
    }));
  }

  /**
   * 从目录一键纳管 MCP Server
   * @param {string} catalogId
   * @param {Record<string,string>} config 用户填写的配置项
   */
  installFromCatalog(catalogId, config = {}) {
    this.init();
    const item = getCatalogItem(catalogId);
    if (!item) throw new Error(`未知 MCP 目录项: ${catalogId}`);
    if (item.alwaysInstalled) {
      return { success: true, server: this.getServer(item.id), alreadyInstalled: true };
    }

    const db = this._getDb();
    const now = Date.now();
    const args = [...(item.args || [])];
    const env = { ...(item.env || {}) };
    const headers = {
      ...(item.metadata?.headers && typeof item.metadata.headers === 'object' ? item.metadata.headers : {}),
    };

    for (const field of item.configFields || []) {
      const val = String(config[field.key] ?? field.defaultValue ?? '').trim();
      if (field.appendArg && val) {
        args.push(val);
      }
      if (field.envKey && val) {
        env[field.envKey] = val;
      }
      if (field.headerKey && val) {
        headers[field.headerKey] = val;
      }
      if (field.required && !val) {
        throw new Error(`请填写: ${field.label}`);
      }
    }

    const command = item.command === 'npx'
      ? (shim?.resolveRealCommand?.('npx') || 'npx')
      : (item.command || '');
    // 远程 HTTP/SSE 目录项（如 Pipeworx）写入 url，由内置网关中转
    const url = item.url && String(item.url).trim() ? String(item.url).trim() : null;
    const type = item.type || (url ? 'http' : 'stdio');
    if ((type === 'sse' || type === 'http') && !url) {
      throw new Error('URL 模式需填写 url');
    }
    const metadataObj = { ...item.metadata, catalogId: item.catalogId };
    if (Object.keys(headers).length) metadataObj.headers = headers;

    const existing = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(item.id);
    if (existing) {
      const prevMeta = this._parseJson(existing.metadata, {});
      // 重装目录项时保留用户投射/中转勾选与已填 headers
      if (Array.isArray(prevMeta.sync_clients)) metadataObj.sync_clients = prevMeta.sync_clients;
      if (Array.isArray(prevMeta.gateway_clients)) metadataObj.gateway_clients = prevMeta.gateway_clients;
      if (prevMeta.gateway_routed != null) metadataObj.gateway_routed = prevMeta.gateway_routed;
      if (!Object.keys(headers).length && prevMeta.headers) metadataObj.headers = prevMeta.headers;
    }
    const metadata = JSON.stringify(metadataObj);
    if (existing) {
      db.prepare(`
        UPDATE mcp_servers
        SET type = ?, command = ?, args = ?, url = ?, env = ?, status = 'active', metadata = ?, updated_at = ?
        WHERE id = ?
      `).run(
        type,
        command,
        JSON.stringify(args),
        url,
        JSON.stringify(env),
        metadata,
        now,
        item.id,
      );
    } else {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, url, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, ?, ?)
      `).run(
        item.id,
        item.name,
        item.display_name,
        type,
        command,
        JSON.stringify(args),
        url,
        JSON.stringify(env),
        metadata,
        now,
        now,
      );
    }

    this._linkServerToProfile(DEVELOPMENT_PROFILE_ID, item.id);
    const sync = this._defaultRelayToManagedApps(item.id) || this._autoSyncClients();
    return { success: true, server: this.getServer(item.id), sync };
  }

  /**
   * 卸载前从各 Agent 配置文件删掉该 MCP。
   * 客户端自配条目不在 TB sync-state 里，只删库会被「扫描即纳管」立刻再导入。
   */
  _removeUninstalledServerFromAgents(server) {
    if (!server) return;
    const mcpClientSync = require('./mcp-client-sync');
    const { CLIENT_TARGETS } = mcpClientSync;
    const keys = new Set([server.name].filter(Boolean));
    const clientIds = new Set([
      ...(Array.isArray(server.metadata?.originAgents) ? server.metadata.originAgents : []),
      ...(Array.isArray(server.sync_clients) ? server.sync_clients : []),
    ].filter(Boolean));

    try {
      const [enriched] = mcpClientSync.enrichServersWithClientInstalls([server]);
      for (const inst of enriched?.clientInstalls || []) {
        if (inst.clientId) clientIds.add(inst.clientId);
        if (inst.clientKey) keys.add(inst.clientKey);
      }
    } catch (e) {
      console.warn('[mcp-manager] uninstall scan installs:', e.message);
    }

    // 旧数据可能没有 originAgents；按 name 在各 Agent 上尝试删除（找不到则跳过）
    const targets = clientIds.size ? clientIds : new Set(Object.keys(CLIENT_TARGETS));
    for (const clientId of targets) {
      if (!CLIENT_TARGETS[clientId]) continue;
      for (const key of keys) {
        try {
          mcpClientSync.removeRawClientMcpEntry(clientId, key, { ignoreMissing: true });
        } catch (e) {
          console.warn('[mcp-manager] uninstall remove from agent:', clientId, key, e.message);
        }
      }
    }
  }

  /** 卸载（非内置）MCP Server：删库 + 从各 Agent 配置移除 */
  uninstallServer(serverId) {
    this.init();
    if (serverId === BUILTIN_BRIDGE_ID) {
      throw new Error('内置 Agent Bridge 不可卸载');
    }
    if (serverId === BUILTIN_PROMPTS_ID || serverId === BUILTIN_MODELS_ID || serverId === BUILTIN_RESOURCES_ID) {
      throw new Error('内置 MCP 不可卸载');
    }
    // 先读出安装位置，再删库（删库后就扫不到 originAgents / sync_clients）
    const server = this.getServer(serverId);
    if (server) this._removeUninstalledServerFromAgents(server);

    const db = this._getDb();
    db.prepare('DELETE FROM mcp_profile_servers WHERE server_id = ?').run(serverId);
    db.prepare('DELETE FROM mcp_servers WHERE id = ? AND builtin = 0').run(serverId);
    const sync = this._autoSyncClients();
    return { success: true, sync };
  }

  setServerStatus(serverId, status) {
    this.init();
    const allowed = new Set(['active', 'inactive']);
    if (!allowed.has(status)) throw new Error(`无效状态: ${status}`);
    const db = this._getDb();
    const info = db.prepare('UPDATE mcp_servers SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), serverId);
    if (!info.changes) throw new Error('Server not found');
    const sync = this._autoSyncClients();
    return { success: true, server: this.getServer(serverId), sync };
  }

  /** 保存自定义 / 编辑 MCP Server */
  saveServer(data) {
    this.init();
    const db = this._getDb();
    const now = Date.now();
    const id = data.id || `mcp-custom-${Date.now()}`;
    if (data.id === BUILTIN_BRIDGE_ID) throw new Error('不可修改内置 Bridge');

    const existing = db.prepare('SELECT id, builtin, metadata, status, type FROM mcp_servers WHERE id = ?').get(id);
    if (existing?.builtin) throw new Error('内置 Server 不可覆盖');

    const prevMeta = this._parseJson(existing?.metadata, {});
    const nextMeta = { ...prevMeta, ...(data.metadata || {}) };
    // 未显式传入时保留原 sync_clients / 中转绑定
    if (data.metadata?.sync_clients === undefined && Array.isArray(prevMeta.sync_clients)) {
      nextMeta.sync_clients = prevMeta.sync_clients;
    }
    if (data.metadata?.gateway_clients === undefined && Array.isArray(prevMeta.gateway_clients)) {
      nextMeta.gateway_clients = prevMeta.gateway_clients;
    }
    if (data.metadata?.gateway_routed === undefined && prevMeta.gateway_routed != null) {
      nextMeta.gateway_routed = prevMeta.gateway_routed;
    }

    const type = data.type || existing?.type || 'stdio';
    const payload = {
      name: String(data.name || id).trim(),
      display_name: String(data.display_name || data.name || id).trim(),
      type,
      command: String(data.command ?? '').trim(),
      args: JSON.stringify(Array.isArray(data.args) ? data.args : []),
      url: data.url != null && String(data.url).trim() ? String(data.url).trim() : null,
      env: JSON.stringify(data.env && typeof data.env === 'object' ? data.env : {}),
      status: data.status || existing?.status || 'active',
      metadata: JSON.stringify(nextMeta),
    };

    if (payload.type === 'stdio' && !payload.command) {
      throw new Error('CLI 模式需填写 command');
    }
    if ((payload.type === 'sse' || payload.type === 'http') && !payload.url) {
      throw new Error('URL 模式需填写 url');
    }

    if (existing) {
      db.prepare(`
        UPDATE mcp_servers
        SET name = ?, display_name = ?, type = ?, command = ?, args = ?, url = ?, env = ?,
            status = ?, metadata = ?, updated_at = ?
        WHERE id = ?
      `).run(
        payload.name, payload.display_name, payload.type, payload.command,
        payload.args, payload.url, payload.env, payload.status, payload.metadata, now, id,
      );
    } else {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, url, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(
        id, payload.name, payload.display_name, payload.type, payload.command,
        payload.args, payload.url, payload.env, payload.status, payload.metadata, now, now,
      );
    }

    let sync = null;
    if (!data.skipAutoSync) {
      if (data.syncInstalled) {
        // 仅推送到已分配 / 已安装的 Agent
        const enriched = this.listManagedServers().find(s => s.id === id);
        const clientIds = [...new Set([
          ...(enriched?.sync_clients || []),
          ...(enriched?.clientTargets || []).filter(c => c.installed).map(c => c.id),
        ])];
        if (clientIds.length) {
          // 保证 filterServersForClient 能下发：把目标写入 sync_clients
          const prev = enriched?.sync_clients || [];
          const merged = [...new Set([...prev, ...clientIds])];
          if (merged.length !== prev.length) {
            this._persistServerSyncClients(id, merged);
          }
          sync = this.syncToClients({ clientIds });
        } else {
          sync = { success: true, results: [], skipped: true };
        }
      } else if (!existing) {
        // 新建自定义 MCP：默认中转到全部已纳管应用
        sync = this._defaultRelayToManagedApps(id) || this._autoSyncClients();
      } else {
        sync = this._autoSyncClients();
      }
    }
    return { success: true, server: this.getServer(id), sync };
  }

  /** 更新 Profile 绑定的 Server 列表 */
  saveProfile(profileId, { serverIds, display_name, description, rules } = {}) {
    this.init();
    const db = this._getDb();
    const profile = db.prepare('SELECT id FROM mcp_profiles WHERE id = ?').get(profileId);
    if (!profile) throw new Error('Profile not found');

    if (display_name != null || description != null || rules != null) {
      const row = db.prepare('SELECT * FROM mcp_profiles WHERE id = ?').get(profileId);
      db.prepare(`
        UPDATE mcp_profiles
        SET display_name = ?, description = ?, rules = ?
        WHERE id = ?
      `).run(
        display_name ?? row.display_name,
        description ?? row.description,
        rules != null ? JSON.stringify(rules) : row.rules,
        profileId,
      );
    }

    if (Array.isArray(serverIds)) {
      // bridge 必须保留在 orchestrator profiles
      const ids = [...new Set(serverIds)];
      if ([DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID].includes(profileId)) {
        if (!ids.includes(BUILTIN_BRIDGE_ID)) ids.unshift(BUILTIN_BRIDGE_ID);
      }
      db.prepare('DELETE FROM mcp_profile_servers WHERE profile_id = ?').run(profileId);
      const insert = db.prepare(`
        INSERT INTO mcp_profile_servers (profile_id, server_id, enabled) VALUES (?, ?, 1)
      `);
      for (const sid of ids) {
        const srv = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(sid);
        if (srv) insert.run(profileId, sid);
      }
    }

    return { success: true, profile: this.getProfile(profileId) };
  }

  _linkServerToProfile(profileId, serverId) {
    const db = this._getDb();
    const link = db.prepare(
      'SELECT profile_id FROM mcp_profile_servers WHERE profile_id = ? AND server_id = ?',
    ).get(profileId, serverId);
    if (!link) {
      db.prepare(`
        INSERT INTO mcp_profile_servers (profile_id, server_id, enabled)
        VALUES (?, ?, 1)
      `).run(profileId, serverId);
    }
  }

  /** 同步已纳管 MCP 到 Agent 客户端（可按 Agent / MCP 分别指定） */
  syncToClients(options = {}) {
    this.init();
    const mcpClientSync = require('./mcp-client-sync');
    const { serverIds, clientIds } = options;

    // 勾选 MCP + 目标 Agent：以本次勾选为准整体替换 sync_clients（取消勾选 = 从该 Agent 移除）
    if (Array.isArray(serverIds) && serverIds.length && Array.isArray(clientIds)) {
      const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
      const allowed = new Set(listSyncEnabledClientIds());
      const agents = clientIds.filter(id => allowed.has(id));
      for (const serverId of serverIds) {
        const server = this.getServer(serverId);
        if (!server || server.status !== 'active') continue;
        this._persistServerSyncClients(serverId, agents);
      }
      // 全量重写各 Agent 配置，确保被取消勾选的 Agent 也会删掉条目
      return mcpClientSync.syncAll(this.listManagedServers(), {});
    }

    return mcpClientSync.syncAll(this.listManagedServers(), options);
  }

  /** 仅更新 metadata.sync_clients，不触发同步 */
  _persistServerSyncClients(serverId, clientIds) {
    const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
    const allowed = new Set(listSyncEnabledClientIds());
    const ids = [...new Set((clientIds || []).filter(id => allowed.has(id)))];

    const db = this._getDb();
    const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(serverId);
    if (!row) throw new Error('Server not found');

    const metadata = { ...this._parseJson(row.metadata, {}), sync_clients: ids };
    db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), Date.now(), serverId);
  }

  /** 网关可绑定的应用 id（Agent + API 应用 + 通用 api） */
  _isAllowedGatewayClient(id) {
    const { isAllowedGatewayClientId } = require('./mcp-gateway-targets');
    return isAllowedGatewayClientId(id);
  }

  /** 经内置 MCP 网关代理的服务器列表（active + 已绑定应用；stdio 或远程 HTTP） */
  listGatewayRoutedServers() {
    this.init();
    return this.listManagedServers().filter((s) => {
      if (!s || s.status !== 'active' || !s.gateway_routed) return false;
      const isUrl = !!(s.url) || s.type === 'http' || s.type === 'sse';
      if (isUrl) return !!String(s.url || '').trim();
      return !!s.command;
    });
  }

  /**
   * 按应用绑定/解绑网关代理（必须写入 gateway_clients，不能只靠旧布尔 gateway_routed）
   * @param {string} serverId
   * @param {boolean} enabled
   * @param {string[]} [clientIds] 目标应用；开启时必填；关闭且不传则清空全部绑定
   */
  setServerGatewayRouted(serverId, enabled, clientIds) {
    this.init();
    const db = this._getDb();
    const row = db.prepare('SELECT id, type, command, url, metadata FROM mcp_servers WHERE id = ?').get(serverId);
    if (!row) throw new Error('Server not found');

    // 中转：stdio 需 command；远程 HTTP/SSE 需 url。通用档仍仅内置 MCP。
    const isUrl = !!(String(row.url || '').trim()) || row.type === 'sse' || row.type === 'http';
    if (!isUrl && !row.command) {
      throw new Error('仅 stdio 或 URL 型 MCP 可加入内置中转');
    }

    const metadata = this._parseJson(row.metadata, {});
    let clients = Array.isArray(metadata.gateway_clients)
      ? metadata.gateway_clients.filter((id) => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id))
      : [];
    // 旧数据：仅 gateway_routed 布尔 → 内置 MCP 落入通用档，其余不自动归通用
    if (!Array.isArray(metadata.gateway_clients) && metadata.gateway_routed) {
      clients = isTokenbankBuiltinRelayId(serverId) ? ['api'] : [];
    }

    const rawIds = Array.isArray(clientIds) ? clientIds : (clientIds ? [clientIds] : []);
    // 开启：校验目标；关闭：允许解绑已删除的 API 应用
    let targets = [...new Set(rawIds.filter((id) => (
      typeof id === 'string'
      && /^[\w.-]{1,64}$/.test(id)
      && (!enabled || this._isAllowedGatewayClient(id))
    )))];
    // 通用档（api）仅允许 Token Bank 内置 MCP
    if (enabled && targets.includes('api') && !isTokenbankBuiltinRelayId(serverId)) {
      targets = targets.filter((id) => id !== 'api');
      if (!targets.length) {
        throw new Error('通用档仅可绑定 Token Bank 内置 MCP（prompts / models / resources）');
      }
    }
    if (enabled) {
      if (!targets.length) {
        throw new Error('请指定要绑定的应用（含 API 应用；不同应用可绑定不同 MCP）');
      }
      clients = [...new Set([...clients, ...targets])];
    } else if (targets.length) {
      const remove = new Set(targets);
      clients = clients.filter((id) => !remove.has(id));
    } else {
      clients = [];
    }

    const nextMeta = {
      ...metadata,
      gateway_clients: clients,
      gateway_routed: clients.length > 0,
    };
    db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nextMeta), Date.now(), serverId);

    // 回读校验：确保 gateway_clients 已落库
    const verify = db.prepare('SELECT metadata FROM mcp_servers WHERE id = ?').get(serverId);
    const verifyMeta = this._parseJson(verify?.metadata, {});
    const written = Array.isArray(verifyMeta.gateway_clients) ? verifyMeta.gateway_clients : [];
    if (enabled && targets.some((id) => !written.includes(id))) {
      console.error('[mcp-manager] gateway_clients write verify failed', {
        serverId, targets, written, verifyMeta,
      });
      throw new Error('中转绑定写入失败，请重启 Token Bank 后重试');
    }

    // 任意 MCP 加入某应用的中转时，默认一并挂上 Token Bank 内置 MCP
    if (enabled && targets.length) {
      this._ensureBuiltinRelayBoundToClients(targets);
    }

    try {
      const gw = require('./mcp-gateway-server');
      gw.reloadMcpGateway();
    } catch (e) {
      console.warn('[mcp-manager] reload gateway:', e.message);
    }
    const server = this.getServer(serverId);
    return {
      success: true,
      server,
      gateway_clients: server?.gateway_clients || written,
    };
  }

  /**
   * 将 prompts/models/resources 绑到指定中转应用（幂等；不递归调 setServerGatewayRouted）
   * @param {string[]} clientIds
   */
  _ensureBuiltinRelayBoundToClients(clientIds) {
    const targets = [...new Set((clientIds || []).filter((id) => (
      typeof id === 'string'
      && /^[\w.-]{1,64}$/.test(id)
      && this._isAllowedGatewayClient(id)
    )))];
    if (!targets.length) return;

    const db = this._getDb();
    const now = Date.now();
    const builtinIds = [BUILTIN_PROMPTS_ID, BUILTIN_MODELS_ID, BUILTIN_RESOURCES_ID];
    for (const bid of builtinIds) {
      const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(bid);
      if (!row) continue;
      const metadata = this._parseJson(row.metadata, {});
      let clients = Array.isArray(metadata.gateway_clients)
        ? metadata.gateway_clients.filter((id) => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id))
        : [];
      if (!Array.isArray(metadata.gateway_clients) && metadata.gateway_routed) {
        clients = ['api'];
      }
      const next = [...new Set([...clients, ...targets])];
      if (next.length === clients.length && targets.every((id) => clients.includes(id))) continue;
      const nextMeta = {
        ...metadata,
        gateway_clients: next,
        gateway_routed: true,
      };
      db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(nextMeta), now, bid);
    }
  }

  /** 批量按应用设置网关路由 */
  setServersGatewayRouted(serverIds, enabled, clientIds) {
    this.init();
    const ids = [...new Set((serverIds || []).filter(Boolean))];
    const results = [];
    let ok = 0;
    for (const id of ids) {
      try {
        const r = this.setServerGatewayRouted(id, enabled, clientIds);
        results.push(r);
        if (r?.success) ok += 1;
      } catch (e) {
        results.push({ success: false, serverId: id, error: e.message });
      }
    }
    try {
      require('./mcp-gateway-server').reloadMcpGateway();
    } catch { /* ignore */ }
    return {
      success: ok > 0 || ids.length === 0,
      ok,
      failed: results.filter((r) => !r.success).length,
      results,
      gateway: this.getGatewayInfo(),
      error: ok === 0 && ids.length
        ? (results.find((r) => r.error)?.error || '绑定失败')
        : undefined,
    };
  }

  /**
   * 从所有 MCP 的中转（gateway_clients）与写盘投射（sync_clients）去掉指定 client。
   * 删除 Gateway 应用时调用；clientId=app-xxx 或 agent_id。
   */
  unbindClient(clientId) {
    if (!clientId || clientId === 'api') return { updated: 0 };
    this.init();
    const db = this._getDb();
    const now = Date.now();
    const rows = db.prepare('SELECT id, metadata FROM mcp_servers').all();
    let updated = 0;
    const syncAffected = [];
    for (const row of rows) {
      const metadata = this._parseJson(row.metadata, {});
      let changed = false;
      if (Array.isArray(metadata.gateway_clients) && metadata.gateway_clients.includes(clientId)) {
        metadata.gateway_clients = metadata.gateway_clients.filter((id) => id !== clientId);
        metadata.gateway_routed = metadata.gateway_clients.length > 0;
        changed = true;
      }
      if (Array.isArray(metadata.sync_clients) && metadata.sync_clients.includes(clientId)) {
        metadata.sync_clients = metadata.sync_clients.filter((id) => id !== clientId);
        changed = true;
        syncAffected.push(clientId);
      }
      if (!changed) continue;
      db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(metadata), now, row.id);
      updated += 1;
    }
    if (syncAffected.length) {
      try { this.syncToClients({ clientIds: [...new Set(syncAffected)] }); } catch (e) {
        console.warn('[mcp-manager] unbindClient sync:', e.message);
      }
    }
    if (updated) {
      try { require('./mcp-gateway-server').reloadMcpGateway(); } catch { /* ignore */ }
    }
    return { updated };
  }

  /** 清掉已从 Gateway 删除的 app-* 在中转/投射里的残留 */
  pruneStaleDeletedAppBindings() {
    if (this._pruningStale) return { updated: 0 };
    this._pruningStale = true;
    try {
      const { isDeletedAppClientId } = require('./mcp-gateway-targets');
      const db = this._getDb();
      const rows = db.prepare('SELECT id, metadata FROM mcp_servers').all();
      const stale = new Set();
      for (const row of rows) {
        const metadata = this._parseJson(row.metadata, {});
        for (const id of [...(metadata.gateway_clients || []), ...(metadata.sync_clients || [])]) {
          if (isDeletedAppClientId(id)) stale.add(id);
        }
      }
      let updated = 0;
      for (const id of stale) updated += this.unbindClient(id).updated || 0;
      try { require('./resource-manager').pruneStaleDeletedAppProjections(); } catch (e) {
        console.warn('[mcp-manager] prune resource projections:', e.message);
      }
      return { updated, stale: [...stale] };
    } finally {
      this._pruningStale = false;
    }
  }

  getGatewayInfo() {
    try {
      const gw = require('./mcp-gateway-server');
      const { listGatewayBindTargets, listGatewayApiApps } = require('./mcp-gateway-targets');
      const status = gw.getGatewayStatus();
      const bindTargets = listGatewayBindTargets();
      const ep = status.endpoint;
      const byClient = status.byClient || {};
      // 为每个可绑定目标补齐 profile（含 0 个 MCP 的 API 应用）
      const profiles = bindTargets.map((t) => ({
        id: t.id,
        label: t.label,
        kind: t.kind,
        url: ep?.url ? String(ep.url).replace(/\/mcp\/?$/, '') + `/mcp/${t.id}` : '',
        routedCount: (byClient[t.id] || []).length,
        configJson: gw.buildClientConfigJson(ep, t.id),
      }));
      return {
        ...status,
        bindTargets,
        apiApps: listGatewayApiApps(),
        profiles,
      };
    } catch (e) {
      return { running: false, error: e.message };
    }
  }

  /** 设置 MCP 同步到哪些 Agent（可分别指定）；未传 syncClientIds 时同步「旧+新」相关 Agent，确保取消勾选的会被移除 */
  setServerSyncClients(serverId, clientIds, options = {}) {
    this.init();
    const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
    const allowed = new Set(listSyncEnabledClientIds());
    const ids = [...new Set((clientIds || []).filter(id => allowed.has(id)))];

    const prev = this.getServer(serverId)?.sync_clients || [];
    this._persistServerSyncClients(serverId, ids);

    // 同步旧分配 ∪ 新分配，使取消勾选的 Agent 配置被重写并删掉该 MCP
    const affected = Array.isArray(options.syncClientIds) && options.syncClientIds.length
      ? options.syncClientIds.filter(id => allowed.has(id))
      : [...new Set([...prev, ...ids])];
    const sync = this.syncToClients(
      affected.length ? { clientIds: affected } : {},
    );
    return { success: true, server: this.getServer(serverId), sync };
  }

  /** 切换某 MCP 是否同步到指定 Agent */
  toggleServerSyncClient(serverId, clientId) {
    this.init();
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    const set = new Set(server.sync_clients || []);
    if (set.has(clientId)) set.delete(clientId);
    else set.add(clientId);
    return this.setServerSyncClients(serverId, [...set], { syncClientIds: [clientId] });
  }

  /**
   * 从指定 Agent 移除此 MCP（不影响 Token Bank 纳管及其他 Agent）
   * @param {string} serverId 已纳管 MCP id；客户端自配时可省略
   * @param {string} clientId Agent id
   * @param {string} [clientKey] 客户端配置键名
   */
  removeFromAgent({ serverId, clientId, clientKey, external = false }) {
    this.init();
    const mcpClientSync = require('./mcp-client-sync');
    const key = String(clientKey || '').trim();

    // 客户端自配 MCP：直接从 Agent 配置文件删除
    if (external || !serverId || String(serverId).startsWith('client-external:')) {
      if (!key) throw new Error('缺少 clientKey');
      const result = mcpClientSync.removeRawClientMcpEntry(clientId, key);
      return { success: true, ...result };
    }

    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');

    const resolvedKey = key
      || server.clientInstalls?.find(i => i.clientId === clientId)?.clientKey
      || server.name;

    // 取消 Token Bank 对该 Agent 的同步分配并重写配置
    const set = new Set(server.sync_clients || []);
    set.delete(clientId);
    this.setServerSyncClients(serverId, [...set], { syncClientIds: [clientId] });

    // 若客户端里仍有同名自配条目（非 TB 写入），一并删除
    try {
      mcpClientSync.removeRawClientMcpEntry(clientId, resolvedKey, { ignoreMissing: true });
    } catch (e) {
      console.warn('[mcp-manager] remove raw client entry:', e.message);
    }

    return { success: true, server: this.getServer(serverId) };
  }

  getClientSyncStatus() {
    return require('./mcp-client-sync').getSyncStatus();
  }

  /** 各 Agent 配置文件中的 MCP 安装情况（含 TB 同步 / 扫描 / 客户端自配） */
  listAgentInstallations() {
    this.init();
    // 与 listServers 一致：先扫描即纳管，再汇总各 Agent 安装情况
    this.syncDiscoveredMcps();
    const agents = require('./mcp-client-sync').listAgentInstallations(this.listManagedServers());
    return { agents };
  }

  _autoSyncClients() {
    try {
      return this.syncToClients();
    } catch (e) {
      console.warn('[mcp-manager] auto sync clients failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  /** 已纳管应用中可中转的 client id（含 Trae / API 应用，不含通用档 api） */
  _listManagedRelayClientIds() {
    const { listManagedAppTargetIds, isAllowedGatewayClientId } = require('./mcp-gateway-targets');
    const { resolveMcpSyncClientId } = require('./mcp-agent-targets');
    const ids = [];
    const seen = new Set();
    const add = (id) => {
      const s = String(id || '').trim();
      if (!s || s === 'api' || seen.has(s) || !isAllowedGatewayClientId(s)) return;
      seen.add(s);
      ids.push(s);
    };
    let managed = new Set();
    try { managed = listManagedAppTargetIds(); } catch (e) {
      console.warn('[mcp-manager] listManagedAppTargetIds failed:', e.message);
    }
    for (const raw of managed) {
      const mapped = resolveMcpSyncClientId(raw);
      add(mapped || raw);
    }
    return ids;
  }

  /**
   * 目录/自定义纳管后：默认中转到全部已纳管应用（含不能写盘的 API / Trae）。
   * 已有 gateway_clients（含用户清空的 []）不覆盖。
   */
  _defaultRelayToManagedApps(serverId) {
    if (!serverId || serverId === BUILTIN_BRIDGE_ID) return null;
    if (isTokenbankBuiltinRelayId(serverId)) return null;
    const db = this._getDb();
    const row = db.prepare('SELECT id, builtin, metadata FROM mcp_servers WHERE id = ?').get(serverId);
    if (!row || row.builtin) return null;
    const meta = this._parseJson(row.metadata, {});
    if (Array.isArray(meta.gateway_clients)) return null;
    const clientIds = this._listManagedRelayClientIds();
    if (!clientIds.length) return this._autoSyncClients();
    return this.setServerGatewayRouted(serverId, true, clientIds);
  }

  /** 中转绑定是否覆盖该应用（含 claude-desktop ↔ claude-code 别名） */
  _clientMatchesRelay(gatewayClients, clientId) {
    const clients = Array.isArray(gatewayClients) ? gatewayClients : [];
    if (!clients.length) return false;
    const cid = String(clientId || '').trim();
    if (!cid) return true;
    const { expandMcpClientMatchIds } = require('./mcp-agent-targets');
    const want = new Set([cid, ...expandMcpClientMatchIds(cid)]);
    return clients.some((id) => want.has(id)
      || expandMcpClientMatchIds(id).some((x) => want.has(x)));
  }

  _summarizeRelayedServer(s) {
    let tools = Array.isArray(s.metadata?.tools) ? s.metadata.tools.filter(Boolean) : [];
    if (!tools.length) {
      try {
        const catalogId = s.metadata?.catalogId;
        if (catalogId) {
          const it = getCatalogItem(catalogId);
          tools = (it?.metadata?.tools || []).filter(Boolean);
        }
      } catch { /* ignore */ }
    }
    const name = s.name || s.id;
    return {
      id: s.id,
      name,
      display_name: s.display_name || name,
      description: s.metadata?.description || '',
      tools,
      prefix: mcpToolPrefix(name),
    };
  }

  /**
   * 当前应用已中转的第三方 MCP（不含内置 prompts/models/resources/Bridge）。
   * 供 tb_capabilities / tb_list_resources(type=mcp)：Agent 工具列表里看不到这些服务时据此发现。
   */
  listRelayedMcpsForClient(clientId) {
    this.init();
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id, name, display_name, type, command, args, url, env, builtin, status, metadata
      FROM mcp_servers WHERE status = 'active'
    `).all().map((row) => this._formatServerRow(row));
    const out = [];
    for (const s of rows) {
      if (!s || s.id === BUILTIN_BRIDGE_ID || isTokenbankBuiltinRelayId(s.id)) continue;
      if (!this._clientMatchesRelay(s.gateway_clients, clientId)) continue;
      out.push(this._summarizeRelayedServer(s));
    }
    return out;
  }

  /** 按 id / name / 显示名 / 前缀解析当前应用的中转 MCP */
  resolveRelayedMcpForClient(clientId, ref) {
    const raw = String(ref || '').trim().toLowerCase();
    if (!raw) return null;
    const list = this.listRelayedMcpsForClient(clientId);
    const exact = list.find((s) => s.id.toLowerCase() === raw
      || s.name.toLowerCase() === raw
      || String(s.display_name || '').toLowerCase() === raw
      || s.prefix.toLowerCase() === raw);
    if (exact) return exact;
    return list.find((s) => s.name.toLowerCase().includes(raw)
      || String(s.display_name || '').toLowerCase().includes(raw)) || null;
  }

  /** Token Bank 数据库中已纳管的 MCP（不含客户端自配） */
  listManagedServers() {
    this.init();
    // 首次无 Agent / 后装 Agent：补齐内置 MCP 默认投射
    this._ensureBuiltinDefaultProjection();
    this.pruneStaleDeletedAppBindings();
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id, name, display_name, type, command, args, url, env, builtin, status, metadata, created_at, updated_at
      FROM mcp_servers
      ORDER BY builtin DESC, display_name ASC, name ASC
    `).all().map(row => this._formatServerRow(row));
    const { enrichServersWithClientInstalls } = require('./mcp-client-sync');
    return enrichServersWithClientInstalls(rows);
  }

  /**
   * 将 Agent 上扫描到的 MCP 纳管进 Token Bank（不改动该 Agent 原配置、不自动同步到其他 Agent）
   * 纳管后可在「已纳管」页选择中转到其他应用
   */
  importFromAgent({ clientId, clientKey, originAgents }) {
    this.init();
    const key = String(clientKey || '').trim();
    if (!clientId || !key) throw new Error('缺少 clientId 或 clientKey');

    const {
      getClientMcpEntryForAgent,
      inferClientMcpDescription,
      CLIENT_TARGETS,
    } = require('./mcp-client-sync');
    const found = getClientMcpEntryForAgent(clientId, key);
    if (!found) {
      const label = CLIENT_TARGETS[clientId]?.label || clientId;
      throw new Error(`未在 ${label} 配置中找到 MCP: ${key}`);
    }

    const db = this._getDb();
    const existing = db.prepare('SELECT id FROM mcp_servers WHERE name = ?').get(key);
    if (existing) {
      return {
        success: true,
        server: this.getServer(existing.id),
        alreadyInstalled: true,
        hint: '该 MCP 已在 Token Bank 纳管；可在「资产 → MCP 工具」中投射到其他应用。',
      };
    }

    const agents = [...new Set(
      (Array.isArray(originAgents) && originAgents.length ? originAgents : [clientId])
        .map(id => String(id || '').trim())
        .filter(Boolean),
    )];

    const safeId = `mcp-import-${key.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}`;
    const result = this.saveServer({
      id: safeId,
      name: key,
      display_name: key,
      type: found.entry.url ? (found.entry.type === 'http' ? 'http' : 'sse') : 'stdio',
      command: found.entry.command || '',
      args: found.entry.args,
      env: found.entry.env,
      url: found.entry.url,
      skipAutoSync: true,
      metadata: {
        category: 'imported',
        origin: 'client_scan',
        importedFrom: key,
        originAgents: agents,
        // 空列表：不自动推送到其他 Agent，保留各客户端原配置
        sync_clients: [],
        description: inferClientMcpDescription(found.entry),
        ...(found.entry.headers ? { headers: found.entry.headers } : {}),
      },
    });
    this._linkServerToProfile(DEVELOPMENT_PROFILE_ID, safeId);
    return {
      ...result,
      alreadyInstalled: false,
      hint: '已纳管客户端 MCP。本 Agent 保留原配置；可在「已纳管」页安装到其他 Agent。',
    };
  }

  /**
   * 扫描即纳管：把各 Agent 配置里尚未入库的 MCP 静默导入 Token Bank。
   * 不改写客户端配置、不同步到其他 Agent；用 origin=client_scan 与 TB 安装区分。
   * 短防抖：listServers 与其它 IPC 连打时不重复全量扫描导入。
   */
  syncDiscoveredMcps() {
    const now = Date.now();
    if (this._lastDiscoverAt && (now - this._lastDiscoverAt) < 5_000) {
      return { success: true, imported: 0, total: 0, skipped: true };
    }
    this._lastDiscoverAt = now;
    this.init();
    const { discoverExternalMcps } = require('./mcp-client-sync');
    // 仅用 DB 行做去重，避免为「发现」先 enrich（全量扫盘）再 listManagedServers 再扫一遍
    const db = this._getDb();
    const bare = db.prepare(`
      SELECT id, name, display_name, type, command, args, url, env, builtin, status, metadata, created_at, updated_at
      FROM mcp_servers
      ORDER BY name ASC
    `).all().map(row => this._formatServerRow(row));
    const external = discoverExternalMcps(bare);
    let imported = 0;
    for (const ext of external) {
      const clients = ext.clientInstalls || [];
      if (!clients.length) continue;
      try {
        const res = this.importFromAgent({
          clientId: clients[0].clientId,
          clientKey: ext.name,
          originAgents: clients.map(c => c.clientId),
        });
        if (res.success && !res.alreadyInstalled) imported += 1;
      } catch (e) {
        console.warn(`[mcp-manager] syncDiscovered ${ext.name}:`, e.message);
      }
    }
    return { success: true, imported, total: external.length };
  }

  /** 已纳管 MCP（扫描即纳管后返回最新列表） */
  listServers() {
    this.syncDiscoveredMcps();
    return this.listManagedServers();
  }

  /** 将客户端自配 MCP 导入 Token Bank（取首个匹配的 Agent） */
  importFromClient(clientKey) {
    this.init();
    const key = String(clientKey || '').trim();
    if (!key) throw new Error('缺少 clientKey');

    const { getClientMcpEntry } = require('./mcp-client-sync');
    const found = getClientMcpEntry(key);
    if (!found) throw new Error(`未在客户端配置中找到 MCP: ${key}`);
    return this.importFromAgent({ clientId: found.clientId, clientKey: key });
  }

  getServer(serverId) {
    this.init();
    const db = this._getDb();
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(serverId);
    return row ? this._formatServerRow(row) : null;
  }

  listProfiles() {
    this.init();
    const db = this._getDb();
    const profiles = db.prepare(`
      SELECT id, name, display_name, description, rules, created_at
      FROM mcp_profiles
      ORDER BY name ASC
    `).all();

    return profiles.map(p => ({
      ...p,
      rules: this._parseJson(p.rules, {}),
      servers: this._getProfileServerIds(p.id),
    }));
  }

  getProfile(profileId) {
    this.init();
    const db = this._getDb();
    const row = db.prepare('SELECT * FROM mcp_profiles WHERE id = ?').get(profileId);
    if (!row) return null;
    return {
      ...row,
      rules: this._parseJson(row.rules, {}),
      servers: this._getProfileServerIds(row.id),
    };
  }

  /** 是否支持编排模式 */
  supportsOrchestrator(agentId) {
    return ORCHESTRATOR_AGENTS.has(agentId);
  }

  /**
   * 为编排任务生成 Agent 启动参数
   * @returns {{ extraArgs: string[], promptPrefix?: string, cleanup: Function }}
   */
  buildOrchestratorLaunch({ agentId, taskId, workingDir, mainAgentId, profileId = DEFAULT_PROFILE_ID, sessionKey, sessionInstanceId }) {
    this.init();
    this._ensureBuiltinBridge();

    if (!this.supportsOrchestrator(agentId)) {
      throw new Error(`编排模式暂不支持 Agent: ${agentId}`);
    }

    // 派发桥和其它内置 MCP 已写在客户端配置里，编排不再另写一份临时 MCP
    writeBridgeActiveContext({ taskId, workingDir, mainAgentId, sessionKey, sessionInstanceId });

    if (agentId === 'claude-code') {
      return {
        extraArgs: [
          '-p',
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          '--verbose',
          '--append-system-prompt', ORCHESTRATOR_SYSTEM,
        ],
        cleanup: () => {},
      };
    }

    if (agentId === 'codex') {
      const extraArgs = ['exec'];
      if (workingDir) extraArgs.push('--cd', workingDir);
      extraArgs.push(
        '--dangerously-bypass-approvals-and-sandbox',
        '--json', '--skip-git-repo-check',
      );
      return {
        extraArgs,
        promptPrefix: `${ORCHESTRATOR_SYSTEM}\n\n`,
        cleanup: () => {},
      };
    }

    // Cursor 没有 --append-system-prompt，编排说明放进 prompt；MCP 用已写入的 ~/.cursor/mcp.json
    if (agentId === 'cursor') {
      return {
        extraArgs: [],
        promptPrefix: `${ORCHESTRATOR_SYSTEM}\n\n`,
        cleanup: () => {},
      };
    }

    throw new Error(`Unsupported orchestrator agent: ${agentId}`);
  }

  _getProfileServerIds(profileId) {
    const db = this._getDb();
    return db.prepare(`
      SELECT s.id, s.name, s.display_name, s.type, s.builtin, s.status
      FROM mcp_profile_servers ps
      JOIN mcp_servers s ON s.id = ps.server_id
      WHERE ps.profile_id = ? AND ps.enabled = 1
      ORDER BY s.builtin DESC, s.display_name ASC
    `).all(profileId);
  }

  _resolveProfileServers(profileId) {
    const db = this._getDb();
    const profile = db.prepare('SELECT id FROM mcp_profiles WHERE id = ?').get(profileId);
    const effectiveId = profile ? profileId : DEFAULT_PROFILE_ID;

    const servers = db.prepare(`
      SELECT s.*
      FROM mcp_profile_servers ps
      JOIN mcp_servers s ON s.id = ps.server_id
      WHERE ps.profile_id = ? AND ps.enabled = 1 AND s.status = 'active'
      ORDER BY s.builtin DESC, s.name ASC
    `).all(effectiveId);

    // 编排层内置 bridge 始终默认启动（即使用户 Profile 未勾选）
    const bridge = this._ensureBuiltinBridge();
    let out = servers;
    if (bridge && !out.some(s => s.id === BUILTIN_BRIDGE_ID)) {
      out = [bridge, ...out];
    }
    // 模型资源 MCP：默认 Profile 始终可用，便于 skill 动态选模
    this._ensureBuiltinModels();
    const models = this.getServer(BUILTIN_MODELS_ID);
    if (models && models.status === 'active' && !out.some(s => s.id === BUILTIN_MODELS_ID)) {
      out = [...out, models];
    }
    // 资源发现 MCP：能力总览 + skill/assistant 列表
    this._ensureBuiltinResources();
    const resources = this.getServer(BUILTIN_RESOURCES_ID);
    if (resources && resources.status === 'active' && !out.some(s => s.id === BUILTIN_RESOURCES_ID)) {
      out = [...out, resources];
    }
    return out;
  }

  /** 运行时 Server 配置（内置 bridge 注入 task 上下文） */
  _buildRuntimeServerConfig(serverRow, ctx) {
    const { taskId, workingDir, mainAgentId, sessionKey, sessionInstanceId } = ctx;
    const baseEnv = this._asObject(serverRow.env, {});

    if (serverRow.id === BUILTIN_BRIDGE_ID || serverRow.name === BUILTIN_BRIDGE_ID) {
      // 编排模式优先走 shell launcher（env 写在脚本内，Codex MCP 子进程更可靠）
      if (ctx.bridgeLauncher) {
        return mcpStdioFromLauncher(ctx.bridgeLauncher);
      }
      return {
        command: resolveElectronBinary(),
        args: [DISPATCH_SCRIPT],
        env: {
          ...baseEnv,
          ELECTRON_RUN_AS_NODE: '1',
          TB_PARENT_TASK_ID: taskId || '',
          TB_PARENT_SESSION_KEY: sessionKey || '',
          TB_PARENT_SESSION_INSTANCE: sessionInstanceId || '',
          TB_WORKING_DIR: workingDir || process.cwd(),
          TB_MAIN_AGENT_ID: mainAgentId || '',
          TB_CLIENT_ID: mainAgentId || '',
        },
      };
    }

    if (serverRow.id === BUILTIN_PROMPTS_ID || serverRow.name === BUILTIN_PROMPTS_ID) {
      if (ctx.promptsLauncher) {
        return mcpStdioFromLauncher(ctx.promptsLauncher);
      }
      return mcpStdioFromLauncher(writeElectronAsNodeLauncher({
        name: `prompts-${mainAgentId || 'default'}`,
        scriptPath: PROMPTS_SCRIPT,
        env: { TB_CLIENT_ID: mainAgentId || '' },
      }));
    }

    if (serverRow.id === BUILTIN_MODELS_ID || serverRow.name === BUILTIN_MODELS_ID) {
      if (ctx.modelsLauncher) {
        return mcpStdioFromLauncher(ctx.modelsLauncher);
      }
      return mcpStdioFromLauncher(writeElectronAsNodeLauncher({
        name: `models-${mainAgentId || 'default'}`,
        scriptPath: MODELS_SCRIPT,
        env: {},
      }));
    }

    if (serverRow.id === BUILTIN_RESOURCES_ID || serverRow.name === BUILTIN_RESOURCES_ID) {
      if (ctx.resourcesLauncher) {
        return mcpStdioFromLauncher(ctx.resourcesLauncher);
      }
      return mcpStdioFromLauncher(writeElectronAsNodeLauncher({
        name: `resources-${mainAgentId || 'default'}`,
        scriptPath: RESOURCES_SCRIPT,
        env: { TB_CLIENT_ID: mainAgentId || '' },
      }));
    }

    let command = serverRow.command;
    // 已 format 的行 args 可能是数组；兼容 DB 原始 JSON 字符串
    const args = this._asArray(serverRow.args, []);
    if (command === 'npx') {
      command = shim?.resolveRealCommand?.('npx') || 'npx';
    }

    return {
      command,
      args,
      env: { ...baseEnv },
    };
  }

  /**
   * 中转网关启动配置：第三方 MCP 原样使用 command/args/env（不做 npx/env 等特判）；
   * 仅展开 Token Bank 内置的 __DYNAMIC_ELECTRON__ 占位符。
   */
  resolveGatewaySpawnConfig(serverRow, clientId = '') {
    this.init();
    const command = String(serverRow?.command || '').trim();
    const needsBuiltinLaunch = command === '__DYNAMIC_ELECTRON__'
      || isTokenbankBuiltinRelayId(serverRow?.id)
      || serverRow?.id === BUILTIN_BRIDGE_ID;
    if (needsBuiltinLaunch) {
      // clientId 作为 TB_CLIENT_ID：内置 prompts/resources 按「投射到该应用」的集合门控可见性。
      // 中转网关对每个应用 cid 各起一份内置后端，故此处必须透传 cid（默认空 = 通用/全部）。
      return this._buildRuntimeServerConfig(serverRow, {
        taskId: 'gateway',
        workingDir: process.cwd(),
        mainAgentId: String(clientId || ''),
        sessionKey: '',
        sessionInstanceId: '',
      });
    }
    return {
      command,
      args: this._asArray(serverRow?.args, []),
      env: { ...this._asObject(serverRow?.env, {}) },
    };
  }

  _formatServerRow(row) {
    const metadata = this._parseJson(row.metadata, {});
    const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
    const syncAllowed = listSyncEnabledClientIds();
    // 未显式配置 sync_clients → 空列表（不默认投射到全部 Agent）
    const sync_clients = Array.isArray(metadata.sync_clients)
      ? metadata.sync_clients.filter((id) => syncAllowed.includes(id))
      : [];

    // 网关按应用绑定；兼容旧 gateway_routed 布尔（仅内置 MCP 归入通用档）
    let gateway_clients = Array.isArray(metadata.gateway_clients)
      ? metadata.gateway_clients.filter((id) => typeof id === 'string' && /^[\w.-]{1,64}$/.test(id))
      : [];
    if (!Array.isArray(metadata.gateway_clients) && metadata.gateway_routed) {
      gateway_clients = isTokenbankBuiltinRelayId(row.id) ? ['api'] : [];
    }
    // 非内置 MCP 不允许出现在通用档
    if (!isTokenbankBuiltinRelayId(row.id)) {
      gateway_clients = gateway_clients.filter((id) => id !== 'api');
    }
    // 已删除的 API 应用不在列表展示（落库清理由 prune / unbindClient）
    try {
      const { isDeletedAppClientId } = require('./mcp-gateway-targets');
      gateway_clients = gateway_clients.filter((id) => !isDeletedAppClientId(id));
    } catch { /* ignore */ }

    return {
      ...row,
      args: this._parseJson(row.args, []),
      env: this._parseJson(row.env, {}),
      metadata,
      sync_clients,
      gateway_clients,
      gateway_routed: gateway_clients.length > 0,
      builtin: !!row.builtin,
    };
  }

  _parseJson(raw, fallback) {
    if (raw == null || raw === '') return fallback;
    // 已是对象/数组（format 后再解析）时直接返回，避免 JSON.parse(array) 得到 []
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  _asArray(raw, fallback = []) {
    if (Array.isArray(raw)) return raw;
    const parsed = this._parseJson(raw, null);
    return Array.isArray(parsed) ? parsed : fallback;
  }

  _asObject(raw, fallback = {}) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    const parsed = this._parseJson(raw, null);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  }
}

module.exports = new MCPManager();
module.exports.ORCHESTRATOR_SYSTEM = ORCHESTRATOR_SYSTEM;
module.exports.DEFAULT_PROFILE_ID = DEFAULT_PROFILE_ID;
module.exports.DEVELOPMENT_PROFILE_ID = DEVELOPMENT_PROFILE_ID;
module.exports.BUILTIN_BRIDGE_ID = BUILTIN_BRIDGE_ID;
module.exports.BUILTIN_PROMPTS_ID = BUILTIN_PROMPTS_ID;
module.exports.BUILTIN_MODELS_ID = BUILTIN_MODELS_ID;
module.exports.BUILTIN_RESOURCES_ID = BUILTIN_RESOURCES_ID;
module.exports.buildCodexOrchestratorProfileToml = buildCodexOrchestratorProfileToml;
module.exports.writeBridgeMcpLauncher = writeBridgeMcpLauncher;
module.exports.writeBridgeActiveContext = writeBridgeActiveContext;
module.exports.writeElectronAsNodeLauncher = writeElectronAsNodeLauncher;
module.exports.mcpStdioFromLauncher = mcpStdioFromLauncher;
module.exports.resolveElectronBinary = resolveElectronBinary;
module.exports.shellQuote = shellQuote;
