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

const { formatOrchestratorCapabilityHint } = require('./tb-capabilities');

/** 编排层系统提示（Claude / Codex 共用） */
const ORCHESTRATOR_SYSTEM = [
  '你是 Token Bank 聚合入口的主 Agent（编排层），不是默认执行者。',
  '核心职责：分析任务 → 匹配并派发本地或已雇佣智能体 → 汇总交付。少废话、少空转、结果导向。',
  '',
  '【标准流程 — 按序执行】',
  '1. 分析：用 1～3 句拆解目标、约束（路径/格式/语言）、成功标准；复杂任务拆成可独立派发的子步骤（依赖清晰：可并行则并行，有先后则串行）。',
  '2. 发现：立刻 tb_list_agents（本地智能体 assistant:*、已雇佣社区 community:*、本机 CLI）；禁止先在 shell 里 which/npm/跑 CLI。',
  '3. 匹配：只根据本次 tb_list_agents 返回的名称、能力和描述来选，不要假设存在某个固定智能体。本地优先于社区，社区优先于 CLI。任务已有工程、时间线或指定工具链时，选描述里覆盖这条链路的；不要因为名字更泛（如「生成」）就派给另一个。',
  '4. 派发：有匹配必须 tb_dispatch_agent（本地在本机执行，社区在对方设备执行）；禁止自己做本可派发的专业活。',
  '   子任务 prompt 要自洽：目标 + 输入/上下文 + 约束 + 期望产出（路径/格式）；勿丢用户关键细节。',
  '   互不依赖的子任务并行：每个都用 tb_dispatch_agent(background=true) 先派出去，再反复 tb_task_status(ids, wait="any") 收结果；要返工时带 previous_task_id 接着原来的会话。',
  '5. 汇总：综合各子结果，用清晰结构回复用户（结论 → 关键产出/路径 → 未完成项）；去掉过程噪音。',
  '',
  '【决策优先级】',
  'A. 本地智能体（assistant:*）＞ B. 已雇佣社区智能体（community:*）＞ C. 本机 CLI ＞ D. 自己动手。',
  'D 仅当 list 为空或无匹配；须简述「无人可派」原因；新雇佣请用户到 Token Bank 「交易」页操作。',
  '',
  '【异常兜底】',
  '- list 失败/为空：重试一次 list；仍空则自行完成，并告知用户暂无可用智能体。',
  '- 派发失败/超时/子任务 error：换相近智能体重试一次；仍失败再自行补全，并向用户说明。',
  '- 子结果残缺/跑偏：可带更明确约束再派发一次纠偏；仍不行则自己补全或请用户补充。',
  '- 多步中某步失败：保留已成功步骤产出，仅重试/降级失败步，最后汇总「已完成 / 失败 / 待办」。',
  '- 工具/MCP 不可用：跳过该路径，改用可用工具或降级执行，并在汇总中注明限制。',
  '',
  '【效率与表达】',
  '- 简单单域任务：list → 一次派发 → 短汇总；不要为流程而流程。',
  '- 禁止把「分析」写成冗长独白；对用户可见回复以最终交付为主，过程点到为止。',
  formatOrchestratorCapabilityHint(),
].join('\n');

/**
 * 本次启动用的编排说明：固定部分 + 看护根据用户纠正学到的派发偏好 / 汇总要求（只影响下一次任务）。
 * 看护不可用或没有学到东西时与 ORCHESTRATOR_SYSTEM 相同。
 */
function orchestratorSystemBase() {
  let extra = [];
  try { extra = require('./guardian/dispatch-learn').orchestratorHints() || []; } catch { /* 看护不可用 */ }
  return extra.length ? `${ORCHESTRATOR_SYSTEM}\n\n${extra.join('\n')}` : ORCHESTRATOR_SYSTEM;
}

/** 支持 MCP 编排的主 Agent（Pi 用已写入的 mcp.json，说明放进 prompt） */
const ORCHESTRATOR_AGENTS = new Set(['claude-code', 'codex', 'cursor', 'pi']);

/** Token Bank 自己的 MCP：只有这一条，工具见 tokenbank-tools.js */
const BUILTIN_ID = 'tokenbank';
/** 以前拆成四条，升级时合进 BUILTIN_ID 并从应用配置里清掉 */
const LEGACY_BUILTIN_IDS = ['tokenbank-agent-bridge', 'tokenbank-prompts', 'tokenbank-models', 'tokenbank-resources'];

function isTokenbankBuiltinRelayId(serverId) {
  return serverId === BUILTIN_ID;
}

/**
 * 每个 MCP 在哪里跑（应用里 / 网关里）、是不是某个应用专属的：见 mcp-placement.js。
 * 应用配置里只有一条 tokenbank；要用应用环境的 MCP 由那条桥在应用里起，其它的在网关里起。
 */
const placement = require('./mcp-placement');
/** 认专属的规则版本：改了规则就加一，升级时把没手动标过的重认一遍 */
const EXCLUSIVE_RULE = 2;
const { needsAppContext } = placement;

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
    agentRouteId: ctx.agentRouteId || '',
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
/** 写进应用配置的 stdio 入口：把消息转给网关，工具在网关进程里执行 */
const STDIO_SCRIPT = path.join(__dirname, 'tokenbank-mcp-stdio.js');

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
 * 写进应用 MCP 配置的 tokenbank 启动脚本。Codex 等外部进程拉起 Electron 时未必透传 env，
 * 缺 ELECTRON_RUN_AS_NODE 会崩，所以写成脚本（Windows 写 .cmd）。只带应用 id：
 * 编排时的当前任务由网关按应用 id 去 bridge-context.json 里取。
 */
function writeTokenbankLauncher({ clientId = '', mcpDir, platform = process.platform } = {}) {
  return writeElectronAsNodeLauncher({
    name: `tokenbank-${clientId || 'default'}`,
    scriptPath: STDIO_SCRIPT,
    env: { TB_CLIENT_ID: clientId || '' },
    platform,
    mcpDir,
  });
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

    this._ensureBuiltin(now);

    const profiles = [
      {
        id: DEFAULT_PROFILE_ID,
        name: 'orchestrator-default',
        display_name: '编排默认',
        description: '聚合入口默认 Profile，含 Agent 派发桥',
        rules: JSON.stringify({ include: ['tokenbank'], servers: [BUILTIN_ID] }),
      },
      {
        id: 'orchestrator-minimal',
        name: 'orchestrator-minimal',
        display_name: '编排精简',
        description: '仅 Agent 派发桥，不含外部 MCP',
        rules: JSON.stringify({ include: [BUILTIN_ID], servers: [BUILTIN_ID] }),
      },
      {
        id: DEVELOPMENT_PROFILE_ID,
        name: 'development',
        display_name: '开发模式',
        description: 'Agent 派发 + 已纳管的工具 MCP',
        rules: JSON.stringify({ include: ['*'], servers: [BUILTIN_ID] }),
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

    // 每个 Profile 都带 Token Bank 自己的工具
    for (const profileId of [DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID]) {
      this._linkServerToProfile(profileId, BUILTIN_ID);
    }

    // 通用中转档默认只挂 Token Bank 内置 MCP
    this._ensureBuiltinGatewayApiClients();
    this._seeded = true;
    // seeded 之后再默认投射，避免 sync→listManagedServers→init 重入未完成的 seed
    this._ensureBuiltinDefaultProjection();
    // 清掉已删除 API 应用残留的中转/投射，避免 MCP 页仍显示「New app」
    this.pruneStaleDeletedAppBindings();
    const healed = this._healImportedCwd();
    const unified = this._unifyPlacement();
    if (healed || unified) this._autoSyncClients();
    if (this._legacyMigrated) {
      this._legacyMigrated = false;
      this._autoSyncClients();
    }
  }

  /**
   * Token Bank 的工具：默认投射到本机已安装可写 Agent。
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
      for (const serverId of [BUILTIN_ID]) {
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

  /** Token Bank 的工具默认绑到通用中转档（api）；并清掉非内置上的 api 绑定 */
  _ensureBuiltinGatewayApiClients() {
    const db = this._getDb();
    const ids = [BUILTIN_ID];
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

  /**
   * 确保 Token Bank 自己那一条 MCP 存在、启用。
   * 升级：以前的四条（派发 / 提示词 / 模型 / 资源）合进来——投射到哪些应用、中转给哪些应用取并集，然后删掉旧的。
   */
  _ensureBuiltin(now = Date.now()) {
    const db = this._getDb();
    const legacy = LEGACY_BUILTIN_IDS
      .map((id) => db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(id))
      .filter(Boolean);
    const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(BUILTIN_ID);
    const prev = this._parseJson(row?.metadata, {});
    const union = (key) => {
      const lists = [prev[key], ...legacy.map((r) => this._parseJson(r.metadata, {})[key])].filter(Array.isArray);
      return lists.length ? [...new Set(lists.flat())] : undefined;
    };
    const meta = {
      ...prev,
      description: '派活给智能体、用模型、取资产（智能体 / 技能 / 提示词）、调第三方 MCP',
      tools: require('./tokenbank-tools').TOOLS.map((t) => t.name),
    };
    if (legacy.length) {
      const sync = union('sync_clients');
      const gw = union('gateway_clients');
      if (sync) meta.sync_clients = sync;
      if (gw) { meta.gateway_clients = gw; meta.gateway_routed = gw.length > 0; }
    }
    if (!row) {
      db.prepare(`
        INSERT INTO mcp_servers
        (id, name, display_name, type, command, args, env, builtin, status, metadata, created_at, updated_at)
        VALUES (?, ?, ?, 'stdio', ?, ?, ?, 1, 'active', ?, ?, ?)
      `).run(
        BUILTIN_ID,
        BUILTIN_ID,
        'Token Bank',
        '__DYNAMIC_ELECTRON__',
        JSON.stringify([STDIO_SCRIPT]),
        JSON.stringify({ ELECTRON_RUN_AS_NODE: '1' }),
        JSON.stringify(meta),
        now,
        now,
      );
    } else {
      db.prepare('UPDATE mcp_servers SET status = ?, display_name = ?, args = ?, metadata = ?, updated_at = ? WHERE id = ?')
        .run('active', 'Token Bank', JSON.stringify([STDIO_SCRIPT]), JSON.stringify(meta), now, BUILTIN_ID);
    }
    for (const r of legacy) {
      db.prepare('DELETE FROM mcp_profile_servers WHERE server_id = ?').run(r.id);
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(r.id);
    }
    // 应用配置里的四条旧条目指向已删的脚本：seed 完成后重写一遍
    if (legacy.length) this._legacyMigrated = true;
    for (const profileId of [DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID]) {
      if (db.prepare('SELECT id FROM mcp_profiles WHERE id = ?').get(profileId)) this._linkServerToProfile(profileId, BUILTIN_ID);
    }
    return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(BUILTIN_ID);
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
    if (serverId === BUILTIN_ID) throw new Error('Token Bank 自己的 MCP 不可卸载');
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
    if (data.id === BUILTIN_ID) throw new Error('Token Bank 自己的 MCP 不可修改');

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

    // mcp=协议服务；api / cli 只是可配置的工具，不写入应用的 MCP 配置
    const requestedKind = data.tool_kind || data.metadata?.tool_kind || prevMeta.tool_kind || 'mcp';
    const toolKind = requestedKind === 'api' || requestedKind === 'cli' ? requestedKind : 'mcp';
    nextMeta.tool_kind = toolKind;
    if (toolKind === 'api') {
      const method = String(data.method || data.metadata?.method || prevMeta.method || 'POST').toUpperCase();
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        throw new Error('不支持的 HTTP 方法');
      }
      nextMeta.method = method;
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
    const plainTool = toolKind === 'api' || toolKind === 'cli';
    if (plainTool) {
      // 与 MCP 同一套投射名单（gateway_clients）。不写应用 MCP 配置，也不进 MCP 协议中转。
      if (!existing && !Array.isArray(prevMeta.gateway_clients)) {
        const clientIds = this._listManagedRelayClientIds();
        sync = clientIds.length
          ? this.setServerGatewayRouted(id, true, clientIds)
          : { success: true, skipped: true, reason: 'no_apps' };
      } else {
        sync = { success: true, skipped: true, reason: 'not_mcp' };
      }
    } else if (!data.skipAutoSync) {
      if (data.syncInstalled) {
        // 改了命令 / 地址：应用配置里只有 tokenbank，不用重写；让网关和应用里的桥按新配置重起
        try { require('./mcp-gateway-server').reloadMcpGateway(); } catch { /* 网关没起 */ }
        sync = { success: true, results: [], skipped: true };
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
      // Token Bank 的工具必须保留在编排 Profile 里
      const ids = [...new Set(serverIds)];
      if ([DEFAULT_PROFILE_ID, 'orchestrator-minimal', DEVELOPMENT_PROFILE_ID].includes(profileId)) {
        if (!ids.includes(BUILTIN_ID)) ids.unshift(BUILTIN_ID);
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
      if (s.metadata?.tool_kind === 'api' || s.metadata?.tool_kind === 'cli') return false;
      // 要在应用里跑的由应用里的 tokenbank 起，网关不起
      if (s.runs_in === 'app') return false;
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
    const row = db.prepare('SELECT id, name, type, command, args, url, metadata FROM mcp_servers WHERE id = ?').get(serverId);
    if (!row) throw new Error('Server not found');
    // API / CLI 与 MCP 共用这份应用名单，但只决定资源可见性，不进入 MCP 协议中转。

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
        throw new Error('通用档只能绑定 Token Bank 自己的 MCP');
      }
    }
    if (enabled) {
      if (!targets.length) {
        throw new Error('请指定要绑定的应用（含 API 应用；不同应用可绑定不同 MCP）');
      }
      const full = { ...row, metadata };
      const name = this._displayName(serverId);
      const notMine = targets.filter((id) => !placement.allowedFor(full, id));
      if (notMine.length) {
        targets = targets.filter((id) => placement.allowedFor(full, id));
        if (!targets.length) {
          throw new Error(`「${name}」是 ${placement.appLabel(metadata.exclusive_to)} 专属的，要用它自己的东西，不能给别的应用`);
        }
      }
      if (placement.runsIn(full) === 'app') {
        targets = targets.filter((id) => this._hasBridge(id));
        if (!targets.length) {
          throw new Error(`「${name}」要在应用里跑（用应用的项目目录和权限），只能给本机装了 tokenbank 的应用`);
        }
      }
      clients = this._canonicalClients([...clients, ...targets]);
    } else if (targets.length) {
      // 连同别名一起撤（claude-desktop 是 Claude Code 的别名，列表里不单独显示；只撤 claude-code 时它还在，工具照样给）
      const { expandMcpClientMatchIds } = require('./mcp-agent-targets');
      const remove = new Set(targets.flatMap((id) => [id, ...expandMcpClientMatchIds(id)]));
      clients = clients.filter((id) => !remove.has(id) && !expandMcpClientMatchIds(id).some((x) => remove.has(x)));
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
   * 把 Token Bank 的工具绑到指定中转应用（幂等；不递归调 setServerGatewayRouted）
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
    const builtinIds = [BUILTIN_ID];
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
    // 只有 tokenbank 自己写进应用配置；其它 MCP 改「给哪些应用用」
    if (!isTokenbankBuiltinRelayId(serverId)) return this._setAppsForServer(serverId, clientIds, options.syncClientIds);
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

    if (isTokenbankBuiltinRelayId(serverId)) {
      // 取消 Token Bank 对该 Agent 的同步分配并重写配置
      const set = new Set(server.sync_clients || []);
      set.delete(clientId);
      this.setServerSyncClients(serverId, [...set], { syncClientIds: [clientId] });
    } else {
      this.setServerGatewayRouted(serverId, false, [clientId]);
    }

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
    if (!serverId || isTokenbankBuiltinRelayId(serverId)) return null;
    const db = this._getDb();
    const row = db.prepare('SELECT id, name, type, command, args, url, builtin, metadata FROM mcp_servers WHERE id = ?').get(serverId);
    if (!row || row.builtin) return null;
    const meta = this._parseJson(row.metadata, {});
    if (Array.isArray(meta.gateway_clients)) return null;
    const full = { ...row, args: this._asArray(row.args, []), metadata: meta };
    // 专属的只给它的应用；要在应用里跑的只给装了 tokenbank 桥的应用（API 应用在别处，起不了）
    const clientIds = this._listManagedRelayClientIds()
      .filter((id) => placement.allowedFor(full, id))
      .filter((id) => placement.runsIn(full) !== 'app' || this._hasBridge(id));
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
   * 已投射到该应用的 HTTP API / 本地 CLI。名单与 MCP 相同（gateway_clients），
   * 但不进入 MCP 协议中转。
   */
  listConfiguredPlainTools(clientId) {
    this.init();
    const db = this._getDb();
    return db.prepare(`
      SELECT id, name, display_name, type, command, args, url, env, builtin, status, metadata
      FROM mcp_servers WHERE status = 'active'
    `).all().map((row) => this._formatServerRow(row)).flatMap((s) => {
      const kind = s?.metadata?.tool_kind;
      if (kind !== 'api' && kind !== 'cli') return [];
      if (!this._clientMatchesRelay(s.gateway_clients, clientId)) return [];
      return [this._summarizePlainTool(s, kind)];
    });
  }

  _summarizePlainTool(s, kind) {
    const name = s.name || s.id;
    const base = {
      id: s.id,
      type: kind,
      name,
      display_name: s.display_name || name,
      description: s.metadata?.description || '',
    };
    if (kind === 'api') {
      return {
        ...base,
        method: s.metadata?.method || 'POST',
        url: s.url || '',
        headers: s.metadata?.headers && typeof s.metadata.headers === 'object' ? s.metadata.headers : {},
        body: s.metadata?.body || '',
        timeout_ms: s.metadata?.timeout_ms || null,
      };
    }
    return {
      ...base,
      command: s.command || '',
      args: Array.isArray(s.args) ? s.args : [],
      cwd: s.metadata?.cwd || '',
      env: s.env && typeof s.env === 'object' ? s.env : {},
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
      if (!s || isTokenbankBuiltinRelayId(s.id)) continue;
      // API / CLI 走资源列表，不伪装成可 tb_call_mcp 的中转 MCP
      if (s.metadata?.tool_kind === 'api' || s.metadata?.tool_kind === 'cli') continue;
      if (!this._clientMatchesRelay(s.gateway_clients, clientId)) continue;
      // 在应用里跑的：应用的工具列表里本来就有，网关也调不到
      if (s.runs_in === 'app') continue;
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
  /** 导入的 MCP 补上原应用配置里的工作目录（插件类的命令是相对路径，离开那个目录起不来） */
  _fillImportedCwd(serverId, entry) {
    const cwd = String(entry?.cwd || '').trim();
    if (!cwd) return false;
    const db = this._getDb();
    const row = db.prepare('SELECT metadata FROM mcp_servers WHERE id = ?').get(serverId);
    if (!row) return false;
    const meta = this._parseJson(row.metadata, {});
    if (meta.cwd === cwd) return false;
    db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...meta, cwd }), Date.now(), serverId);
    return true;
  }

  /**
   * 统一成只经 tokenbank：以前直接写进应用配置的（sync_clients）并进「给哪些应用用」（gateway_clients），
   * 之后同步会把 Token Bank 写过的那些条目从应用配置里清掉。顺带给导入的 MCP 认一次专属。
   * 返回是否要重新同步应用配置。
   */
  _unifyPlacement() {
    let resync = false;
    try {
      const db = this._getDb();
      const { expandMcpClientMatchIds } = require('./mcp-agent-targets');
      const ports = this._gatewayPorts();
      for (const row of db.prepare('SELECT id, name, type, command, args, url, builtin, metadata FROM mcp_servers').all()) {
        if (isTokenbankBuiltinRelayId(row.id)) continue;
        const meta = this._parseJson(row.metadata, {});
        const next = { ...meta };
        let changed = false;
        const sync = Array.isArray(meta.sync_clients) ? meta.sync_clients.filter(Boolean) : [];
        if (sync.length) {
          const gw = Array.isArray(meta.gateway_clients) ? meta.gateway_clients : [];
          const covered = new Set(gw.flatMap((g) => [g, ...expandMcpClientMatchIds(g)]));
          next.gateway_clients = [...gw, ...sync.filter((id) => !covered.has(id))];
          next.sync_clients = [];
          changed = true;
          resync = true;
        } else if (Array.isArray(meta.sync_clients) && meta.sync_clients.length) {
          next.sync_clients = [];
          changed = true;
        }
        // 以前导入时描述写成「客户端自配 · xxx」：来源不再区分，只留后面的
        if (/^客户端自配/.test(String(meta.description || ''))) {
          next.description = String(meta.description).replace(/^客户端自配\s*(·\s*)?/, '').replace(/^MCP$/, '').trim();
          changed = true;
        }
        // 认专属：规则改过就重认一次（手动标过的不动）
        if (meta.exclusive_checked !== EXCLUSIVE_RULE && !meta.exclusive_manual) {
          const full = { ...row, args: this._asArray(row.args, []), metadata: meta };
          const owner = placement.detectExclusiveOwner(full, { gatewayPorts: ports, holders: this._holdersOf(full) });
          next.exclusive_checked = EXCLUSIVE_RULE;
          if (owner) next.exclusive_to = owner;
          else delete next.exclusive_to;
          changed = true;
        }
        if (Array.isArray(next.gateway_clients)) {
          const canon = this._canonicalClients(next.gateway_clients);
          if (canon.length !== next.gateway_clients.length || canon.some((id, i) => id !== next.gateway_clients[i])) {
            next.gateway_clients = canon;
            changed = true;
          }
          const full = { ...row, args: this._asArray(row.args, []), metadata: next };
          // 专属的只留它的应用；在应用里跑的只留有 tokenbank 桥的应用（API 应用起不了）
          const kept = next.gateway_clients.filter((id) => placement.allowedFor(full, id)
            && (placement.runsIn(full) !== 'app' || this._hasBridge(id)));
          if (kept.length !== next.gateway_clients.length) { next.gateway_clients = kept; changed = true; }
        }
        if (!changed) continue;
        if (Array.isArray(next.gateway_clients)) next.gateway_routed = next.gateway_clients.length > 0;
        db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(next), Date.now(), row.id);
      }
      // 应用配置里还留着 Token Bank 以前写的其它 MCP 条目：同步一次清掉
      if (!resync) {
        const { getSyncStatus } = require('./mcp-client-sync');
        const state = getSyncStatus()?.state || {};
        resync = Object.values(state.clients || {}).some((c) => (c.bindings || []).some((b) => b.serverId && !isTokenbankBuiltinRelayId(b.serverId)));
      }
    } catch (e) {
      console.warn('[mcp-manager] 统一 MCP 接入方式失败:', e.message);
    }
    return resync;
  }

  /**
   * 现在自己配置里有这一条的应用（按名字或同样的命令 / 地址；Token Bank 写进去的不算）。
   * 认专属以它为准：导入记录里的应用可能是以前 Token Bank 写过去的副本。
   */
  _holdersOf(row) {
    try {
      const { scanAllClientMcps, getTbManagedClientKeys } = require('./mcp-client-sync');
      const tbKeys = getTbManagedClientKeys();
      const meta = this._parseJson(row.metadata, {});
      const keys = new Set([row.name, meta.importedFrom].filter(Boolean));
      const url = String(row.url || '').trim();
      const cmd = String(row.command || '').trim();
      const isTb = (e) => /[\\/]\.tokenbank[\\/]mcp[\\/]/.test(`${e?.command || ''} ${(Array.isArray(e?.args) ? e.args : []).join(' ')}`);
      const out = [];
      for (const x of scanAllClientMcps() || []) {
        if (tbKeys.has(`${x.clientId}:${x.clientKey}`) || isTb(x.entry)) continue;
        const same = keys.has(x.clientKey)
          || (url && String(x.entry?.url || '').trim() === url)
          || (cmd && !/^(npx|node|uvx|python3?|docker)$/i.test(cmd) && String(x.entry?.command || '').trim() === cmd);
        if (same && !out.includes(x.clientId)) out.push(x.clientId);
      }
      return out;
    } catch { return []; }
  }

  /** Token Bank 网关端口（判断本机地址是不是自己） */
  _gatewayPorts() {
    const ports = [11430, 11431];
    try {
      const info = JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(), '.tokenbank', 'mcp-gateway.json'), 'utf8'));
      const p = new URL(String(info?.url || '')).port;
      if (p) ports.push(Number(p));
    } catch { /* 没启动过 */ }
    return ports;
  }

  _displayName(serverId) {
    try {
      const r = this._getDb().prepare('SELECT name, display_name FROM mcp_servers WHERE id = ?').get(serverId);
      return r?.display_name || r?.name || serverId;
    } catch { return serverId; }
  }

  /** 应用 id 统一成一个（codex-desktop → codex、claude-desktop → claude-code），去重 */
  _canonicalClients(ids) {
    const { resolveMcpSyncClientId } = require('./mcp-agent-targets');
    return [...new Set((ids || []).filter(Boolean).map((id) => resolveMcpSyncClientId(id) || id))];
  }

  /** 这个应用里有没有 tokenbank 桥（能写配置的本机应用才有；API 应用没有） */
  _hasBridge(clientId) {
    try {
      const { listSyncEnabledClientIds, expandMcpClientMatchIds } = require('./mcp-agent-targets');
      const writable = new Set(listSyncEnabledClientIds());
      return [clientId, ...expandMcpClientMatchIds(clientId)].some((id) => writable.has(id));
    } catch { return false; }
  }

  /**
   * 用户自己在这个应用配置里配过这一条（不是 Token Bank 写的）：不再经 tokenbank 重复给一遍
   * @param {string} clientId
   * @param {object} server  name / metadata.importedFrom
   */
  ownConfigHas(clientId, server) {
    const cid = String(clientId || '').trim();
    if (!cid || !server) return false;
    try {
      const { scanAllClientMcps } = require('./mcp-client-sync');
      const { expandMcpClientMatchIds } = require('./mcp-agent-targets');
      const ids = new Set([cid, ...expandMcpClientMatchIds(cid)]);
      const meta = this._parseJson(server.metadata, {});
      const keys = new Set([server.name, meta.importedFrom].filter(Boolean));
      const isTb = (e) => /[\\/]\.tokenbank[\\/]mcp[\\/]/.test(`${e?.command || ''} ${(Array.isArray(e?.args) ? e.args : []).join(' ')}`);
      return (scanAllClientMcps() || []).some((x) => ids.has(x.clientId) && keys.has(x.clientKey) && !isTb(x.entry));
    } catch { return false; }
  }

  /**
   * 这个应用里要由 tokenbank 桥起的 MCP（给了它、要在应用里跑、不是别的应用专属、它自己配置里也没有）。
   * 网关 GET /mcp/<应用>/local 给桥用。
   */
  listAppLocalServers(clientId) {
    this.init();
    const cid = String(clientId || '').trim();
    if (!cid) return [];
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id, name, display_name, type, command, args, url, env, builtin, status, metadata
      FROM mcp_servers WHERE status = 'active'
    `).all().map((row) => this._formatServerRow(row));
    const out = [];
    for (const s of rows) {
      if (!s || isTokenbankBuiltinRelayId(s.id) || s.runs_in !== 'app' || !s.command) continue;
      if (s.metadata?.tool_kind === 'api' || s.metadata?.tool_kind === 'cli') continue;
      if (!this._clientMatchesRelay(s.gateway_clients, cid)) continue;
      if (!placement.allowedFor(s, cid)) continue;
      if (this.ownConfigHas(cid, s)) continue;
      const cwd = String(s.metadata?.cwd || '').trim();
      let command = s.command === 'npx' ? (shim?.resolveRealCommand?.('npx') || 'npx') : s.command;
      if (cwd && /^\.{1,2}[\\/]/.test(command)) command = require('path').resolve(cwd, command);
      out.push({
        id: s.id,
        name: s.name || s.id,
        prefix: mcpToolPrefix(s.name || s.id),
        command,
        args: Array.isArray(s.args) ? s.args : [],
        env: s.env && typeof s.env === 'object' ? s.env : {},
        cwd,
      });
    }
    return out;
  }

  /**
   * 「给哪些应用用」整体设成 clientIds（只改 affected 里的应用；不传则按全部能写配置的应用比对）。
   * 以前的「写进应用配置」入口也走这里。
   */
  _setAppsForServer(serverId, clientIds, affected) {
    const server = this.getServer(serverId);
    if (!server) throw new Error('Server not found');
    const want = [...new Set((clientIds || []).filter(Boolean))];
    const scope = Array.isArray(affected) && affected.length ? affected : null;
    const { expandMcpClientMatchIds } = require('./mcp-agent-targets');
    const same = (a, b) => [a, ...expandMcpClientMatchIds(a)].includes(b);
    const remove = (server.gateway_clients || []).filter((g) => (!scope || scope.some((x) => same(x, g)))
      && !want.some((w) => same(w, g)));
    if (remove.length) this.setServerGatewayRouted(serverId, false, remove);
    const add = want.filter((w) => !(server.gateway_clients || []).some((g) => same(w, g)));
    if (add.length) this.setServerGatewayRouted(serverId, true, add);
    return { success: true, server: this.getServer(serverId) };
  }

  /**
   * 手动标 / 取消「应用专属」。标上后已给别的应用的一并撤掉。
   * @param {string} serverId
   * @param {string} owner 应用 id；空 = 取消
   */
  setServerExclusive(serverId, owner) {
    this.init();
    if (isTokenbankBuiltinRelayId(serverId)) throw new Error('Token Bank 自己的 MCP 所有应用都能用');
    const db = this._getDb();
    const row = db.prepare('SELECT id, metadata FROM mcp_servers WHERE id = ?').get(serverId);
    if (!row) throw new Error('Server not found');
    const meta = this._parseJson(row.metadata, {});
    const id = String(owner || '').trim();
    const next = { ...meta, exclusive_checked: EXCLUSIVE_RULE, exclusive_manual: true };
    if (id) {
      if (!/^[\w.-]{1,64}$/.test(id)) throw new Error('应用 id 不对');
      next.exclusive_to = id;
      if (Array.isArray(meta.gateway_clients)) {
        next.gateway_clients = meta.gateway_clients.filter((g) => placement.allowedFor({ metadata: next }, g));
        next.gateway_routed = next.gateway_clients.length > 0;
      }
    } else {
      delete next.exclusive_to;
    }
    db.prepare('UPDATE mcp_servers SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), Date.now(), serverId);
    try { require('./mcp-gateway-server').reloadMcpGateway(); } catch { /* 网关没起 */ }
    return { success: true, server: this.getServer(serverId) };
  }

  /** 启动时补一遍：命令是相对路径、又没记工作目录的导入 MCP，去原应用配置里找 */
  _healImportedCwd() {
    try {
      const db = this._getDb();
      const rows = db.prepare("SELECT id, name, command, metadata FROM mcp_servers WHERE builtin = 0").all();
      const broken = rows.filter((r) => /^\.{1,2}[\\/]/.test(String(r.command || '')) && !this._parseJson(r.metadata, {}).cwd);
      if (!broken.length) return 0;
      const { scanAllClientMcps } = require('./mcp-client-sync');
      const scanned = scanAllClientMcps() || [];
      let n = 0;
      for (const r of broken) {
        const meta = this._parseJson(r.metadata, {});
        const key = meta.importedFrom || meta.clientKey || r.name;
        const hit = scanned.find((x) => x.clientKey === key && x.entry?.cwd);
        if (hit && this._fillImportedCwd(r.id, hit.entry)) n += 1;
      }
      return n;
    } catch (e) {
      console.warn('[mcp-manager] 补工作目录失败:', e.message);
      return 0;
    }
  }

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
      // 以前导入时没带工作目录（相对路径的命令起不来）：这次补上
      this._fillImportedCwd(existing.id, found.entry);
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
        ...(found.entry.cwd ? { cwd: found.entry.cwd } : {}),
        // 依赖这个应用自己东西的（命令在它目录 / 程序包里，或是它在本机开的服务）：只给它用
        ...(() => {
          const full = { name: key, ...found.entry, metadata: { cwd: found.entry.cwd, originAgents: agents, importedFrom: key } };
          const owner = placement.detectExclusiveOwner(full, { gatewayPorts: this._gatewayPorts(), holders: this._holdersOf(full) });
          return owner ? { exclusive_to: owner, exclusive_checked: EXCLUSIVE_RULE } : { exclusive_checked: EXCLUSIVE_RULE };
        })(),
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
  buildOrchestratorLaunch({ agentId, taskId, workingDir, mainAgentId, profileId = DEFAULT_PROFILE_ID, sessionKey, sessionInstanceId, agentRouteId = '' }) {
    this.init();
    // 智能体路由：把这条路由的派发规则接在编排说明后面；名单由 tb_list_agents 按路由过滤
    let routeRules = '';
    if (agentRouteId) {
      try {
        const routes = require('./agent-routes');
        const route = routes.get(agentRouteId);
        if (route) routeRules = routes.rulesText(route);
      } catch { /* 路由读不到就按默认编排 */ }
    }
    const orchestratorSystem = () => (routeRules ? `${orchestratorSystemBase()}\n\n${routeRules}` : orchestratorSystemBase());

    if (!this.supportsOrchestrator(agentId)) {
      throw new Error(`编排模式暂不支持 Agent: ${agentId}`);
    }

    // Token Bank 的工具已写在客户端配置里，编排只记下当前任务，派出的子任务挂在它下面
    writeBridgeActiveContext({ taskId, workingDir, mainAgentId, sessionKey, sessionInstanceId, agentRouteId });

    if (agentId === 'claude-code') {
      return {
        extraArgs: [
          '-p',
          '--dangerously-skip-permissions',
          '--output-format', 'stream-json',
          '--verbose',
          '--append-system-prompt', orchestratorSystem(),
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
        promptPrefix: `${orchestratorSystem()}\n\n`,
        cleanup: () => {},
      };
    }

    // Cursor 没有 --append-system-prompt，编排说明放进 prompt；MCP 用已写入的 ~/.cursor/mcp.json
    if (agentId === 'cursor') {
      return {
        extraArgs: [],
        promptPrefix: `${orchestratorSystem()}\n\n`,
        cleanup: () => {},
      };
    }

    // Pi 同样没有系统提示参数；派发桥在 ~/.pi/agent/mcp.json，说明放进 prompt
    if (agentId === 'pi') {
      return {
        extraArgs: [],
        promptPrefix: `${orchestratorSystem()}\n\n`,
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

  /** 中转网关拉起第三方 MCP：原样用 command/args/env（Token Bank 自己那条不拉进程，在网关里直接执行） */
  resolveGatewaySpawnConfig(serverRow) {
    return {
      command: String(serverRow?.command || '').trim(),
      args: this._asArray(serverRow?.args, []),
      env: { ...this._asObject(serverRow?.env, {}) },
    };
  }

  _formatServerRow(row) {
    const metadata = this._parseJson(row.metadata, {});
    const { listSyncEnabledClientIds } = require('./mcp-agent-targets');
    const syncAllowed = listSyncEnabledClientIds();
    // 未显式配置 sync_clients → 空列表（不默认投射到全部 Agent）
    // 只有 tokenbank 自己写进应用配置；其它 MCP 都经它（给哪些应用用记在 gateway_clients）
    const sync_clients = isTokenbankBuiltinRelayId(row.id) && Array.isArray(metadata.sync_clients)
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
      runs_in: isTokenbankBuiltinRelayId(row.id) ? 'app' : placement.runsIn({ ...row, metadata }),
      exclusive_to: String(metadata.exclusive_to || ''),
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
module.exports.orchestratorSystem = orchestratorSystemBase;
module.exports.DEFAULT_PROFILE_ID = DEFAULT_PROFILE_ID;
module.exports.DEVELOPMENT_PROFILE_ID = DEVELOPMENT_PROFILE_ID;
module.exports.BUILTIN_ID = BUILTIN_ID;
module.exports.LEGACY_BUILTIN_IDS = LEGACY_BUILTIN_IDS;
module.exports.needsAppContext = needsAppContext;
module.exports.writeTokenbankLauncher = writeTokenbankLauncher;
module.exports.writeBridgeActiveContext = writeBridgeActiveContext;
module.exports.writeElectronAsNodeLauncher = writeElectronAsNodeLauncher;
module.exports.mcpStdioFromLauncher = mcpStdioFromLauncher;
module.exports.resolveElectronBinary = resolveElectronBinary;
module.exports.shellQuote = shellQuote;
