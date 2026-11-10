// client/electron/resource-agent-targets.js
// Agent Skill / Prompt / 智能体 投射与 runtime 目标
// - 投射列表：Gateway「已纳管」应用（强信号已安装）
// - resource_project：可作为游乐场 / 贡献的 runtime（不再表示「可投射智能体」）
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let shimInstaller = null;
try { shimInstaller = require('./shim-installer'); } catch { /* optional in CLI */ }

/** 支持 Skill 投射的 Agent */
const AGENT_RESOURCE_TARGETS = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    getSkillRoot: () => path.join(os.homedir(), '.claude', 'skills'),
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    getSkillRoot: () => path.join(os.homedir(), '.codex', 'skills'),
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    getSkillRoot: () => {
      const candidates = [
        path.join(os.homedir(), '.cursor', 'skills'),
        path.join(os.homedir(), '.cursor', 'skills-cursor'),
      ];
      return candidates.find(p => fs.existsSync(p)) || candidates[0];
    },
  },
  'kimi-code': {
    id: 'kimi-code',
    label: 'Kimi Code',
    getSkillRoot: () => path.join(os.homedir(), '.kimi-code', 'skills'),
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    getSkillRoot: () => {
      const candidates = [
        path.join(os.homedir(), '.config', 'opencode', 'skills'),
        path.join(os.homedir(), '.opencode', 'skills'),
      ];
      return candidates.find(p => fs.existsSync(p)) || candidates[0];
    },
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes',
    getSkillRoot: () => path.join(os.homedir(), '.hermes', 'skills'),
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    getSkillRoot: () => path.join(os.homedir(), '.openclaw', 'skills'),
  },
  workbuddy: {
    id: 'workbuddy',
    label: 'WorkBuddy',
    getSkillRoot: () => path.join(os.homedir(), '.workbuddy', 'skills'),
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    // 与 MCP 写盘同一 agent 目录：<agent-dir>/skills
    getSkillRoot: () => {
      try {
        const dir = require('./pi-config').defaultAgentDir();
        if (dir) return path.join(dir, 'skills');
      } catch { /* 回退默认目录 */ }
      return path.join(os.homedir(), '.pi', 'agent', 'skills');
    },
  },
};

/** 从应用目录读取勾选了 resource_project（可作为游乐场/贡献 runtime）的实体 id */
function listResourceProjectableAppIds() {
  const allowed = new Set();
  try {
    const cl = require('./config-loader');
    const expanded = cl.appEntitiesExpanded?.() || [];
    for (const e of expanded) {
      if (!e?.id) continue;
      const caps = e.capabilities || {};
      if (caps.resource_project || e.resource_project) allowed.add(String(e.id));
    }
    if (!allowed.size) {
      const { expandEntity } = require('./app-handlers');
      for (const compact of cl.appEntities?.() || []) {
        if (!compact?.id || !compact?.handler) continue;
        try {
          const e = expandEntity(compact);
          if (e.resource_project || e.capabilities?.resource_project) allowed.add(String(e.id));
        } catch { /* skip unknown handler */ }
      }
    }
  } catch { /* config 未就绪 */ }
  return allowed;
}

/** macOS：/Applications 或 ~/Applications 下是否有 <Name>.app */
function macAppExists(appName) {
  if (process.platform !== 'darwin' || !appName) return false;
  for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    try {
      if (fs.existsSync(path.join(base, `${appName}.app`))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** Codex Desktop：App / Application Support / Windows userData（不用 config.toml——可被本程序自写） */
function isCodexDesktopPresent() {
  try {
    if (fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', 'Codex'))) return true;
  } catch { /* ignore */ }
  try {
    if (fs.existsSync('/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework')) return true;
  } catch { /* ignore */ }
  if (process.platform === 'win32') {
    for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)) {
      try {
        if (fs.existsSync(path.join(base, 'Codex'))) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

/**
 * WorkBuddy 强信号：会话痕迹或桌面 userData（不用 mcp.json / 空目录——可被本程序自建）
 */
function isWorkbuddyPresent() {
  const home = os.homedir();
  try {
    const traces = path.join(home, '.workbuddy', 'traces');
    if (fs.existsSync(traces)) {
      for (const name of fs.readdirSync(traces)) {
        if (name.startsWith('.')) continue;
        return true;
      }
    }
  } catch { /* ignore */ }
  if (process.platform === 'darwin') {
    try {
      if (fs.existsSync(path.join(home, 'Library', 'Application Support', 'WorkBuddy'))) return true;
    } catch { /* ignore */ }
  }
  if (process.platform === 'win32') {
    for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)) {
      try {
        if (fs.existsSync(path.join(base, 'WorkBuddy'))) return true;
      } catch { /* ignore */ }
    }
  }
  return false;
}

/**
 * DeepSeek Harness 强信号：$DSH_HOME（默认 ~/.dsh）下 dsh 自建目录 profiles / sessions / storages
 * 含非隐藏内容即算已安装并跑过。
 * 不认 settings.yaml / cordis.patch.yml —— 那两个 tokenbank 纳管时自己会写，用它们反推会自证循环。
 */
function isDshPresent() {
  const raw = process.env.DSH_HOME;
  const home = raw
    ? String(raw).replace(/^~(?=\/|$)/, os.homedir())
    : path.join(os.homedir(), '.dsh');
  for (const sub of ['profiles', 'sessions', 'storages']) {
    try {
      const dir = path.join(home, sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * 本机是否已安装该 Agent（投射目标用）：
 * 只认 CLI / App bundle / 桌面 userData 等强信号。
 * 禁止用「配置文件或父目录存在」反推——启动自写 config 会造成假已安装。
 *
 * 短缓存：MCP 页 loadAll 会对每个 server×client 反复探测；旧实现每次调
 * agentLinker.list() 会给全部工具跑 installed+linked，首屏极慢。
 */
const _installedCache = new Map(); // id -> { ts, v }
const INSTALLED_TTL_MS = 8_000;

function _probeAgentInstalled(id) {
  // 单工具探测：禁止 list()（会扫全部工具的 status/linked）
  try {
    const cl = require('./config-loader');
    const tools = typeof cl.tools === 'function' ? cl.tools() : [];
    const tool = Array.isArray(tools) ? tools.find((t) => t && t.id === id) : null;
    const cmd = tool?.detect?.command;
    if (cmd && shimInstaller?.resolveRealCommand?.(cmd)) return true;

    const ent = cl.appEntityById?.(id);
    if (ent?.detect_command && shimInstaller?.resolveRealCommand?.(ent.detect_command)) return true;
    if (ent?.proxy_mode === 'api_key') {
      if (ent.detect_type === 'command' && ent.detect_value) {
        if (shimInstaller?.resolveRealCommand?.(ent.detect_value)) return true;
      }
      if (ent.detect_type === 'appx' && ent.detect_value) {
        const appName = String(ent.detect_value).split('.').pop();
        if (macAppExists(appName)) return true;
        try {
          if (fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', appName))) return true;
        } catch { /* ignore */ }
        if (process.platform === 'win32') {
          for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)) {
            try {
              if (fs.existsSync(path.join(base, appName))) return true;
            } catch { /* ignore */ }
          }
        }
        if (/codex/i.test(appName) && isCodexDesktopPresent()) return true;
      }
    }
  } catch { /* ignore */ }

  if (id === 'cursor') {
    if (macAppExists('Cursor')) return true;
    if (shimInstaller?.resolveRealCommand?.('cursor')) return true;
    if (process.platform === 'win32') {
      for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean)) {
        try {
          if (fs.existsSync(path.join(base, 'Programs', 'cursor'))) return true;
          if (fs.existsSync(path.join(base, 'Cursor'))) return true;
        } catch { /* ignore */ }
      }
    }
  }

  if (id === 'codex' || id === 'codex-desktop') {
    if (shimInstaller?.resolveRealCommand?.('codex')) return true;
    if (isCodexDesktopPresent()) return true;
  }

  if (id === 'workbuddy') {
    if (isWorkbuddyPresent()) return true;
  }

  // DeepSeek Harness：PATH 上的 `dsh` 命令，或 $DSH_HOME 下 dsh 自建目录。
  if (id === 'deepseek-harness') {
    if (shimInstaller?.resolveRealCommand?.('dsh')) return true;
    if (isDshPresent()) return true;
  }

  // Pi：PATH 上的 `pi`，或 agent 目录里已有 settings / auth / sessions。
  // 不把本程序写入的 mcp.json / models.json 当成安装证据。
  if (id === 'pi') {
    if (shimInstaller?.resolveRealCommand?.('pi')) return true;
    try {
      const piCfg = require('./pi-config');
      if (piCfg.piAgentReady(piCfg.defaultAgentDir())) return true;
    } catch { /* ignore */ }
  }

  // 注意：不再用「Skill 根目录非空」反推安装 —— TB 投射会往该目录写内容，
  // 会把本程序自建的目录误判为已安装（自证循环），且与 Gateway 列表口径不一致。
  return false;
}

function isAgentInstalled(agentId) {
  const id = String(agentId || '');
  if (!id) return false;
  const now = Date.now();
  const hit = _installedCache.get(id);
  if (hit && (now - hit.ts) < INSTALLED_TTL_MS) return hit.v;
  const v = _probeAgentInstalled(id);
  _installedCache.set(id, { ts: now, v });
  return v;
}

/** 批量预热安装探测缓存（enrich 前调用，避免 N×M 重复探测） */
function warmAgentInstalledCache(ids) {
  for (const id of ids || []) isAgentInstalled(id);
}

function invalidateAgentInstalledCache() {
  _installedCache.clear();
}

function getAgentTarget(agentId) {
  return AGENT_RESOURCE_TARGETS[agentId] || null;
}

const api = {
  AGENT_RESOURCE_TARGETS,
  listResourceProjectableAppIds,
  isAgentInstalled,
  warmAgentInstalledCache,
  invalidateAgentInstalledCache,
  isCodexDesktopPresent,
  isWorkbuddyPresent,
  isDshPresent,
  getAgentTarget,

  /**
   * 资源投射目标（prompt / skill / 智能体共用）：与 Gateway「已纳管」列表完全一致。
   * Gateway 列表口径 = hosted（已纳管）且本机真检测到（apps:list 会滤掉未安装记录）。
   * 因此这里同样两个条件都要满足：
   *   1) isAgentInstalled —— 排除「hosted 但未安装」的残留记录（如 OpenCode 只有旧配置）；
   *   2) hosted —— 排除「装了但未纳管」（含 TB 自建 skill 目录造成的误判）。
   * 严格模式：能读到 hosted 集（即使为空）即以它为准；仅当 hosted 彻底读不到（抛错）时，
   * 回退为仅按安装探测，避免列表意外变空。
   */
  listManagedResourceAgentIds() {
    let hosted = null;
    try {
      hosted = require('./mcp-gateway-targets').listHostedAgentIds();
    } catch { /* 配置不可读：回退强信号 */ }
    return Object.keys(AGENT_RESOURCE_TARGETS).filter((id) => {
      if (!api.isAgentInstalled(id)) return false;
      return hosted ? hosted.has(id) : true;
    });
  },

  /** Skill 投射 → 已纳管应用 */
  listSkillProjectableAgentIds() {
    return api.listManagedResourceAgentIds();
  },

  /**
   * 游乐场 / 贡献可用的 runtime 应用：
   * handler 勾选 resource_project，且本机已安装（旧名「可投射智能体」）。
   */
  listAssistantRuntimeAgentIds() {
    const allowed = listResourceProjectableAppIds();
    return Object.keys(AGENT_RESOURCE_TARGETS)
      .filter((id) => {
        if (!api.isAgentInstalled(id)) return false;
        if (allowed.has(id)) return true;
        if (id === 'codex' && allowed.has('codex-desktop')) return true;
        return false;
      });
  },

  /** @deprecated 旧名；现表示 runtime 可用性，投射请用 listManagedResourceAgentIds */
  listAssistantProjectableAgentIds() {
    return api.listAssistantRuntimeAgentIds();
  },

  /** @deprecated 兼容旧名 → 已纳管投射 */
  listProjectableAgentIds() {
    return api.listManagedResourceAgentIds();
  },

  /** prompt 投射 → 已纳管应用（与 Skill / 智能体一致） */
  listPromptProjectableAgentIds() {
    return api.listManagedResourceAgentIds();
  },
};

module.exports = api;
