// client/electron/mcp-agent-targets.js
// Token Bank 纳管 Agent 的 MCP 配置扫描/同步目标
'use strict';

const os = require('os');
const path = require('path');

function expandHome(p) {
  if (!p) return p;
  return String(p).replace(/^~(?=\/|$)/, os.homedir());
}

/**
 * 各 Agent 的 MCP 配置文件定义
 * format:
 *   json-mcp        — { mcpServers: { key: { command, args, env, url } } }
 *   toml-mcp        — [mcp_servers.key] 段（Codex）
 *   yaml-mcp-servers — config.yaml 顶层 mcp_servers（Hermes）
 *   json-nested     — 嵌套路径如 mcp.servers（OpenClaw）
 *   cordis-mcp-client — $DSH_HOME/cordis.patch.yml 里的 @deepseek-ai/dsh-mcp-client 插件行（DeepSeek Harness）
 */
const AGENT_MCP_TARGETS = {
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    getPaths: () => [path.join(os.homedir(), '.cursor', 'mcp.json')],
    format: 'json-mcp',
    sync: true,
  },
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    // Claude Code 用户级 MCP 在 ~/.claude.json 的 mcpServers（不是 ~/.claude/mcp.json）
    // CLAUDE_CONFIG_DIR 若设置，则写到 $CLAUDE_CONFIG_DIR/.claude.json
    getPaths: () => {
      const configDir = process.env.CLAUDE_CONFIG_DIR;
      if (configDir) return [path.join(expandHome(configDir), '.claude.json')];
      return [path.join(os.homedir(), '.claude.json')];
    },
    format: 'json-mcp',
    sync: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    getPaths: () => [path.join(os.homedir(), '.codex', 'config.toml')],
    format: 'toml-mcp',
    sync: true,
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    getPaths: () => [path.join(os.homedir(), '.hermes', 'config.yaml')],
    format: 'yaml-mcp-servers',
    sync: true,
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    getPaths: () => {
      const paths = [];
      if (process.env.OPENCLAW_CONFIG_PATH) {
        paths.push(expandHome(process.env.OPENCLAW_CONFIG_PATH));
      }
      paths.push(
        path.join(os.homedir(), '.openclaw', 'openclaw.json'),
        path.join(os.homedir(), '.config', 'openclaw', 'openclaw.json'),
      );
      return [...new Set(paths)];
    },
    format: 'json-nested',
    nestedKey: 'mcp.servers',
    // OpenClaw 不作为 MCP 写盘投射目标（仍可纳管/扫描）
    sync: false,
  },
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    // 官方主配置为 mcp.json；.mcp.json 亦可能含 connector-proxy 等条目，扫描时一并读取
    getPaths: () => [
      path.join(os.homedir(), '.workbuddy', 'mcp.json'),
      path.join(os.homedir(), '.workbuddy', '.mcp.json'),
    ],
    format: 'json-mcp',
    sync: true,
  },
  'gemini-cli': {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    getPaths: () => [path.join(os.homedir(), '.gemini', 'settings.json')],
    format: 'json-mcp',
    sync: true,
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    getPaths: () => [
      path.join(os.homedir(), '.config', 'opencode', 'opencode.json'),
      path.join(os.homedir(), '.opencode', 'opencode.json'),
    ],
    format: 'json-mcp',
    sync: true,
  },
  'kimi-code': {
    id: 'kimi-code',
    label: 'Kimi Code',
    // 独立 mcp.json，避免改写 config.toml
    getPaths: () => [path.join(os.homedir(), '.kimi-code', 'mcp.json')],
    format: 'json-mcp',
    sync: true,
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    // 用户级 MCP：~/.pi/agent/mcp.json（PI_CODING_AGENT_DIR 优先），格式与 Claude / Cursor 相同
    getPaths: () => {
      try {
        const dir = require('./pi-config').defaultAgentDir();
        if (dir) return [path.join(dir, 'mcp.json')];
      } catch { /* 回退默认目录 */ }
      return [path.join(os.homedir(), '.pi', 'agent', 'mcp.json')];
    },
    format: 'json-mcp',
    sync: true,
  },
  'deepseek-harness': {
    id: 'deepseek-harness',
    label: 'DeepSeek Harness',
    // MCP 不落 mcpServers map，而是 home 级 cordis.patch.yml 里的 dsh-mcp-client 插件行（对所有 profile 生效）
    getPaths: () => {
      const home = process.env.DSH_HOME ? expandHome(process.env.DSH_HOME) : path.join(os.homedir(), '.dsh');
      return [path.join(home, 'cordis.patch.yml')];
    },
    format: 'cordis-mcp-client',
    sync: true,
  },
};

/**
 * Gateway 应用 id（preset/agent）→ 实际写盘的 MCP client id。
 * - Codex Desktop 与 Codex CLI 共用 ~/.codex/config.toml
 * - Claude Desktop 与 Claude Code 共用 ~/.claude.json（投射列表不单独展示 Desktop）
 */
const MCP_SYNC_ID_ALIASES = {
  'codex-desktop': 'codex',
  'claude-desktop': 'claude-code',
};

/** 投射/中转勾选列表中隐藏：与 CLI 复用写盘、无需单独一行 */
const MCP_PROJECT_LIST_HIDDEN_IDS = new Set(['claude-desktop']);

/** 解析可写盘的 sync client id；不支持写盘时返回 null */
function resolveMcpSyncClientId(id) {
  const raw = String(id || '').trim();
  if (!raw) return null;
  const mapped = MCP_SYNC_ID_ALIASES[raw] || raw;
  const t = CLIENT_TARGETS[mapped];
  if (!t || t.sync === false) return null;
  return mapped;
}

/** 筛选/已投射匹配：filter id 与 sync id 互通（codex ↔ codex-desktop） */
function expandMcpClientMatchIds(id) {
  const raw = String(id || '').trim();
  if (!raw) return [];
  const ids = new Set([raw]);
  const resolved = resolveMcpSyncClientId(raw);
  if (resolved) ids.add(resolved);
  for (const [from, to] of Object.entries(MCP_SYNC_ID_ALIASES)) {
    if (from === raw || to === raw || (resolved && (from === resolved || to === resolved))) {
      ids.add(from);
      ids.add(to);
    }
  }
  return [...ids];
}

/** 兼容旧 CLIENT_TARGETS 结构（mcp-client-sync 内部使用） */
const CLIENT_TARGETS = Object.fromEntries(
  Object.entries(AGENT_MCP_TARGETS).map(([id, t]) => [
    id,
    {
      id,
      label: t.label,
      getPath: () => t.getPaths()[0],
      getPaths: t.getPaths,
      format: t.format,
      nestedKey: t.nestedKey,
      sync: t.sync !== false,
    },
  ]),
);

function listAgentMcpTargets() {
  return Object.values(AGENT_MCP_TARGETS);
}

/** 支持 Token Bank 写入 MCP 配置的 Agent id 列表 */
function listSyncEnabledClientIds() {
  return Object.entries(CLIENT_TARGETS)
    .filter(([, t]) => t.sync !== false)
    .map(([id]) => id);
}

/** 本机已安装、可作为 MCP 同步目标的 Agent */
function listInstalledClientIds() {
  const { isAgentInstalled } = require('./resource-agent-targets');
  return listSyncEnabledClientIds().filter(id => isAgentInstalled(id));
}

module.exports = {
  AGENT_MCP_TARGETS,
  CLIENT_TARGETS,
  MCP_SYNC_ID_ALIASES,
  MCP_PROJECT_LIST_HIDDEN_IDS,
  listAgentMcpTargets,
  listSyncEnabledClientIds,
  listInstalledClientIds,
  resolveMcpSyncClientId,
  expandMcpClientMatchIds,
  expandHome,
};
