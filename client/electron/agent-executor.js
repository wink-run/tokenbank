// client/electron/agent-executor.js
// Agent 聚合系统：统一的 Agent 执行器
'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const localStats = require('./local-stats');

/** Cursor Agent CLI 当前模型（~/.cursor/cli-config.json 的展示名）。default 不算具体模型。 */
function readCursorCliModelLabel() {
  try {
    const file = path.join(os.homedir(), '.cursor', 'cli-config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const displayName = String(raw?.model?.displayName || '').trim();
    const display = String(raw?.model?.displayModelId || '').trim();
    const selected = String(raw?.selectedModel?.modelId || raw?.model?.modelId || '').trim();
    const label = displayName || display || selected;
    if (!label || label === 'default') return '';
    return label;
  } catch {
    return '';
  }
}

/** 短随机 id（不用 nanoid：该包在 Vite 树里是 devDep，打进 asar 会缺模块导致打包版起不来） */
function nanoid(size = 8) {
  return crypto.randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size);
}

/** data URL / mime → 文件扩展名 */
function mimeToImageExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  return '.png';
}

/** 用魔数判定图片 MIME（勿只信扩展名，避免 vision API 400） */
function detectImageMime(buf, fallback = 'image/png') {
  if (!buf || buf.length < 12) return fallback;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return 'image/webp';
  }
  return fallback;
}

/**
 * 将游乐场附图落盘，并解析出可注入多模态消息的 base64 块。
 * - Claude Code：优先走 stdin image block（Read 工具读图不可靠，易幻觉）
 * - 其它 CLI：把路径写进 prompt，文件落在工作目录内便于沙箱读取
 */
function materializeAttachedImages(images, { taskId, workingDir } = {}) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return { paths: [], mediaParts: [], suffix: '', uploadDir: '' };

  const id = String(taskId || nanoid(8));
  const baseDir = workingDir && fs.existsSync(workingDir)
    ? path.join(path.resolve(workingDir), '.tokenbank-uploads', id)
    : path.join(os.tmpdir(), 'tokenbank-agent-uploads', id);
  fs.mkdirSync(baseDir, { recursive: true });

  const paths = [];
  const mediaParts = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const dataUrl = typeof item === 'string' ? item : (item?.dataUrl || '');
    const mm = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!mm) continue;
    let buf;
    try {
      buf = Buffer.from(mm[2], 'base64');
    } catch {
      continue;
    }
    if (!buf.length) continue;
    const declared = String(mm[1] || '').toLowerCase();
    const mediaType = detectImageMime(buf, declared.startsWith('image/') ? declared : 'image/png');
    const rawName = (typeof item === 'object' && item?.name) ? String(item.name) : '';
    const base = path.basename(rawName || `image-${i + 1}`).replace(/[^\w.\u4e00-\u9fff-]+/g, '_') || `image-${i + 1}`;
    const ext = path.extname(base) || mimeToImageExt(mediaType);
    const stem = path.basename(base, path.extname(base)) || `image-${i + 1}`;
    const fp = path.join(baseDir, `${stem}-${i + 1}${ext}`);
    try {
      fs.writeFileSync(fp, buf);
      paths.push(fp);
      mediaParts.push({ mediaType, data: buf.toString('base64'), path: fp });
    } catch (e) {
      console.warn('[AgentExecutor] attach image write failed:', e.message);
    }
  }
  if (!paths.length) return { paths: [], mediaParts: [], suffix: '', uploadDir: baseDir };

  const lines = paths.map((p, i) => `${i + 1}. ${p}`).join('\n');
  return {
    paths,
    mediaParts,
    uploadDir: baseDir,
    // 非 Claude：靠路径提示；明确要求视觉查看，禁止臆测
    suffix: `\n\n[Attached image files — you MUST visually inspect these image files (vision). Do NOT guess from filenames or prior chat.]\n${lines}\n`,
  };
}

/** 上传文件名：去掉路径，避免写出工作目录外 */
function safeUploadName(name, index) {
  let base = path.basename(String(name || `file-${index}`));
  base = base.replace(/[^\w.\u4e00-\u9fff-]+/g, '_');
  if (!base || base === '.' || base === '..') return `file-${index}`;
  return base.slice(0, 180);
}

/**
 * 普通附件落盘（pdf / 文本 / 压缩包等）。
 * 与图片共用同一上传目录，路径写进 prompt，由 Agent 自行读取。
 */
function materializeAttachedFiles(files, { taskId, workingDir, uploadDir } = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { paths: [], suffix: '', uploadDir: uploadDir || '' };

  const id = String(taskId || nanoid(8));
  const baseDir = uploadDir
    || (workingDir && fs.existsSync(workingDir)
      ? path.join(path.resolve(workingDir), '.tokenbank-uploads', id)
      : path.join(os.tmpdir(), 'tokenbank-agent-uploads', id));
  fs.mkdirSync(baseDir, { recursive: true });

  const paths = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const dataUrl = typeof item === 'string' ? item : (item?.dataUrl || '');
    const mm = /^data:[^;]*;base64,(.+)$/s.exec(String(dataUrl || ''));
    if (!mm) continue;
    let buf;
    try {
      buf = Buffer.from(mm[1], 'base64');
    } catch {
      continue;
    }
    if (!buf.length) continue;
    const base = safeUploadName(typeof item === 'object' ? item.name : '', i + 1);
    const ext = path.extname(base);
    const stem = path.basename(base, ext) || `file-${i + 1}`;
    let fp = path.join(baseDir, base);
    if (fs.existsSync(fp)) fp = path.join(baseDir, `${stem}-${i + 1}${ext}`);
    try {
      fs.writeFileSync(fp, buf);
      paths.push(fp);
    } catch (e) {
      console.warn('[AgentExecutor] attach file write failed:', e.message);
    }
  }
  if (!paths.length) return { paths: [], suffix: '', uploadDir: baseDir };

  const lines = paths.map((p, i) => `${i + 1}. ${p}`).join('\n');
  return {
    paths,
    uploadDir: baseDir,
    suffix: `\n\n[Attached files — read these files and use their contents. Do NOT guess from filenames.]\n${lines}\n`,
  };
}

/** Claude Code：把图作为首条 user message 的 image block（需 --input-format stream-json） */
function buildClaudeMultimodalStdin(prompt, mediaParts = []) {
  const content = [];
  const text = String(prompt || '').trim() || 'Please visually inspect the attached image(s).';
  content.push({ type: 'text', text });
  for (const p of mediaParts) {
    if (!p?.data) continue;
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: p.mediaType || 'image/png',
        data: p.data,
      },
    });
  }
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  })}\n`;
}

/** 给已有 Claude 参数补上 stream-json 输入（去掉尾部文本 prompt） */
function ensureClaudeMultimodalArgs(args) {
  const out = Array.isArray(args) ? [...args] : [];
  const valueFlags = new Set([
    '--append-system-prompt', '--output-format', '--input-format', '--resume',
    '--settings', '--mcp-config', '--model', '--agents', '--agent',
    '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools',
    '--add-dir', '--fallback-model', '--effort', '--betas', '--debug', '--debug-file',
    '--system-prompt', '--system-prompt-file', '--append-system-prompt-file',
    '--plugin-dir', '--file', '--json-schema',
  ]);
  // 先去掉末尾用户 prompt，再补 --input-format（避免 prompt 夹在中间）
  if (out.length) {
    const last = out[out.length - 1];
    const prev = out.length >= 2 ? out[out.length - 2] : '';
    if (typeof last === 'string' && !last.startsWith('-') && !valueFlags.has(prev)) {
      out.pop();
    }
  }
  if (!out.includes('--input-format')) {
    out.push('--input-format', 'stream-json');
  }
  return out;
}
const { STATS_DIR } = require('../shared/telemetry');
let shim = null;
let agentLinker = null;
let runProbe = null;
try { shim = require('./shim-installer'); } catch { /* optional in CLI */ }
try { agentLinker = require('./agent-linker'); } catch { /* optional in CLI */ }
try { runProbe = require('./detect-tools')._internal?.runProbe; } catch { /* optional in CLI */ }

/**
 * 打包后从 Finder 启动时，Electron cwd 常在 .app/Contents/MacOS 或 App Translocation。
 * 该目录对未签名的 node/npx 子进程 getcwd 会 EPERM（zsh: shell-init / job-working-directory）。
 */
function isUnsafeSpawnCwd(dir) {
  const n = path.resolve(String(dir || ''));
  if (!n) return true;
  if (/\.app\/Contents(\/|$)/i.test(n)) return true;
  if (/\/AppTranslocation\//i.test(n)) return true;
  return false;
}

function dirIsSpawnable(dir) {
  if (!dir) return false;
  try {
    const resolved = path.resolve(String(dir));
    if (isUnsafeSpawnCwd(resolved)) return false;
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return false;
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 选一个子进程能 getcwd 的目录：优先用户工作区，否则 home / tmp */
function safeAgentCwd(preferred) {
  let procCwd = null;
  try { procCwd = process.cwd(); } catch { /* ignore */ }
  const candidates = [
    preferred && String(preferred).trim() ? path.resolve(String(preferred).trim()) : null,
    procCwd,
    os.homedir(),
    os.tmpdir(),
  ].filter(Boolean);
  for (const c of candidates) {
    if (dirIsSpawnable(c)) return c;
  }
  return os.homedir();
}

/** GUI 精简 PATH 补上 Homebrew / nvm，并清掉会让 node 误跑成 Electron 的变量 */
function sanitizeAgentSpawnEnv(baseEnv, cwd) {
  const env = { ...(baseEnv || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  const resolved = path.resolve(String(cwd || os.homedir()));
  env.PWD = resolved;
  env.INIT_CWD = resolved;
  if (env.OLDPWD && isUnsafeSpawnCwd(env.OLDPWD)) delete env.OLDPWD;
  const sep = process.platform === 'win32' ? ';' : ':';
  let extra = [];
  try { extra = typeof shim?.npmGlobalBinDirs === 'function' ? shim.npmGlobalBinDirs() : []; } catch { extra = []; }
  const cur = String(env.PATH || env.Path || '');
  const seen = new Set();
  const parts = [];
  for (const p of [...extra, ...cur.split(sep)]) {
    if (!p) continue;
    let key = p;
    try { key = path.resolve(p); } catch { /* keep raw */ }
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(p);
  }
  const pathVal = parts.join(sep);
  env.PATH = pathVal;
  if (process.platform === 'win32') env.Path = pathVal;
  return env;
}
const { parseAgentOutputLine, summarizeAgentStdout, extractModifiedFiles, extractCliSessionId, normalizeCliSessionId, detectAgentExecutionFailure, formatAgentExitError, parseClaudeSyncStdout } = require('./agent-output-parser');
const mcpManager = require('./mcp-manager');
const {
  isAssistantAgentId,
  assistantResourceId,
  parseAssistantConfig,
  resolveAssistantContext,
  resolveAssistantRuntimeAgent,
  buildAssistantLaunch,
  ASSISTANT_ID_PREFIX,
  hasAssistantEnableProjection,
  resolveAssistantDisplayRuntime,
} = require('./resource-assistant');
const { applyRentalDefinition } = require('./agent-delivery-policy');

/**
 * Cursor Agent 无交互参数（对齐 Tutti：解析 cursor-agent / agent 二进制；
 * 游乐场用官方 -p stream-json，而非完整 ACP 会话层）。
 */
function buildCursorAgentArgs(prompt, {
  workingDir, continueSession, cliSessionId, model,
} = {}) {
  const args = [
    '-p',
    '--force', // 对齐 Tutti full-access / Claude skip-permissions
    '--approve-mcps',
    '--output-format', 'stream-json',
    '--sandbox', 'disabled',
  ];
  if (workingDir) args.push('--workspace', workingDir);
  if (continueSession) {
    const sid = normalizeCliSessionId(cliSessionId);
    if (sid) args.push('--resume', sid);
    else args.push('--continue');
  }
  const mdl = String(model || '').trim();
  if (mdl) args.push('--model', mdl);
  args.push(prompt);
  return args;
}

const AGENT_CLI = {
  'claude-code': {
    name: 'Claude Code',
    detectCommand: 'claude',
    // 用 stream-json 实时推送;勿用 syncOutput+json(进程结束才有步骤,UI 全程黑盒)
    buildArgs: (prompt, opts = {}) => buildClaudeCodeArgs(prompt, opts),
    capabilities: ['code', 'chat', 'edit', 'terminal'],
  },
  codex: {
    name: 'Codex',
    detectCommand: 'codex',
    // codex 可能仅通过 npx 安装
    npxPackage: '@openai/codex',
    // Debug 直调：JSONL 实时输出 + 默认信任所选工作目录
    buildArgs: (prompt, { workingDir, continueSession, cliSessionId } = {}) => {
      const base = ['exec'];
      // exec 全局 OPTIONS 必须在 resume 子命令之前（clap 否则把后续 flag 当 COMMAND 参数）
      if (workingDir) base.push('--cd', workingDir);
      // exec 无 --ask-for-approval；用 bypass 对齐 Claude skip-permissions（不弹窗、不沙箱）
      base.push(
        '--dangerously-bypass-approvals-and-sandbox',
        '--json', '--skip-git-repo-check',
      );
      if (continueSession) {
        base.push('resume');
        const sid = normalizeCliSessionId(cliSessionId);
        if (sid) base.push(sid);
        else base.push('--last');
      }
      base.push(prompt);
      return base;
    },
    capabilities: ['code', 'chat', 'edit'],
  },
  // Tutti: cursor-agent acp；此处同二进制 + headless -p（Debug 已有 stream-json 管线）
  // Cursor 走自有账号（login / CURSOR_API_KEY），不绑 Token Bank 网关路由
  cursor: {
    name: 'Cursor',
    detectCommand: 'cursor-agent',
    detectCommands: ['cursor-agent', 'agent'],
    buildArgs: (prompt, opts = {}) => buildCursorAgentArgs(prompt, opts),
    capabilities: ['code', 'chat', 'edit', 'terminal'],
    gatewayInject: false,
  },
  // Kimi Code：-p 非交互 + stream-json；二进制常在 ~/.kimi-code/bin
  'kimi-code': {
    name: 'Kimi Code',
    detectCommand: 'kimi',
    buildArgs: (prompt, opts = {}) => buildKimiCodeArgs(prompt, opts),
    capabilities: ['code', 'chat', 'edit', 'terminal'],
  },
  // Pi：--mode json 边生成边写 JSONL。text 模式要等整轮结束才吐正文，管道里界面会一直停在执行中。
  pi: {
    name: 'Pi',
    detectCommand: 'pi',
    buildArgs: (prompt, { continueSession, cliSessionId, model } = {}) => {
      const args = ['--mode', 'json'];
      const mdl = String(model || '').trim();
      if (mdl) args.push('--model', mdl);
      if (continueSession) {
        const sid = String(cliSessionId || '').trim();
        if (sid) args.push('--session', sid);
        else args.push('--continue');
      }
      args.push('--', prompt);
      return args;
    },
    capabilities: ['code', 'chat', 'edit', 'terminal'],
  },
};

/**
 * Kimi Code 无交互 prompt（-p / stream-json）。
 * 注意：官方 CLI 禁止 --prompt 与 --yolo / --auto 同用。
 */
function buildKimiCodeArgs(prompt, {
  continueSession, cliSessionId, model,
} = {}) {
  const args = ['--output-format', 'stream-json'];
  if (continueSession) {
    // Kimi session id 形如 session_<uuid>；-S 与提示里的 -r 等价
    const sid = String(cliSessionId || '').trim();
    if (sid) args.push('-S', sid);
    else args.push('-c');
  }
  const mdl = String(model || '').trim();
  if (mdl) args.push('-m', mdl);
  // -p <prompt> 为值参，须放在 flag 之后
  args.push('-p', prompt);
  return args;
}

/** 内置 CLI 的 id。app:claude-code 这类出租应用 id 也归到同一个 CLI。 */
function canonicalBuiltinAgentId(agentId) {
  const raw = String(agentId || '').trim();
  if (!raw) return '';
  if (AGENT_CLI[raw]) return raw;
  const lower = raw.toLowerCase();
  if (AGENT_CLI[lower]) return lower;
  const stripped = lower.replace(/^app:/, '');
  if (stripped !== lower && AGENT_CLI[stripped]) return stripped;
  return '';
}

/** Agent 列表探测缓存（避免每次进 Debug 都 spawn CLI） */
const AGENT_LIST_CACHE = { at: 0, agents: null, ttlMs: 45_000 };
/** 后台补版本 / 登录时递增，避免旧探测覆盖新一次快检 */
let _agentListEnrichGen = 0;

/** Claude Code 续接：须 continueSession；有 sessionId 用 --resume，否则 -c */
function buildClaudeContinueArgs({ continueSession, cliSessionId } = {}) {
  if (!continueSession) return [];
  const sid = normalizeCliSessionId(cliSessionId);
  if (sid) return ['--resume', sid];
  return ['-c'];
}

/** Codex 编排续接：resume 须放在全部 exec 全局参数（含 -p profile）之后，否则 -p 会被 resume 子命令误解析 */
function injectCodexResumeArgs(extraArgs, { continueSession, cliSessionId } = {}) {
  if (!continueSession) return extraArgs;
  const out = [...extraArgs];
  const sid = normalizeCliSessionId(cliSessionId);
  out.push('resume', sid || '--last');
  return out;
}

/** Claude Code 非交互启动公共参数:stream-json 按块推送(不用 partial,降低半截文本解析复杂度) */
function buildClaudeStreamFlags({ multimodalInput = false } = {}) {
  const flags = [
    '-p', '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  // 附图时用 stdin 注入 image content block（纯 -p 文本无法真看图）
  if (multimodalInput) flags.push('--input-format', 'stream-json');
  return flags;
}

function buildClaudeCodeArgs(prompt, { continueSession, cliSessionId, multimodalInput } = {}) {
  const args = [
    ...buildClaudeContinueArgs({ continueSession, cliSessionId }),
    ...buildClaudeStreamFlags({ multimodalInput: !!multimodalInput }),
  ];
  // 多模态：prompt 走 stdin，不再作为 argv 尾参
  if (!multimodalInput) args.push(prompt);
  return args;
}

function invalidateAgentListCache() {
  AGENT_LIST_CACHE.at = 0;
  AGENT_LIST_CACHE.agents = null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 云端回传的成品。优先用中转地址；旧的 data URL 仍可展示。不把出租方磁盘路径当本地文件。
 */
function normalizeCommunityArtifacts(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let total = 0;
  for (const item of raw) {
    if (out.length >= 16) break;
    if (!item || typeof item !== 'object') continue;
    const dataUrl = String(item.dataUrl || '').trim();
    const url = String(item.url || '').trim();
    const urlOk = /^https?:\/\/\S+\/media\/agent\/[A-Za-z0-9_-]+\/[^/?#\s]+$/i.test(url)
      || /^\/media\/agent\/[A-Za-z0-9_-]+\/[^/?#\s]+$/.test(url);
    const comma = dataUrl.indexOf(',');
    const dataOk = comma >= 0 && dataUrl.startsWith('data:') && dataUrl.slice(0, comma).endsWith(';base64');
    if (!urlOk && !dataOk) continue;
    if (dataOk && (dataUrl.length > 8_000_000 || total + dataUrl.length > 8_000_000)) {
      if (!urlOk) continue;
    }
    const name = String(item.name || 'file').replace(/\\/g, '/').split('/').pop().slice(0, 120) || 'file';
    let mime = String(item.mime || 'application/octet-stream').split(';')[0].trim().slice(0, 80);
    if (!mime.includes('/')) mime = 'application/octet-stream';
    const kind = mime.startsWith('image/') && !mime.includes('svg') ? 'image' : 'file';
    const file = { name, mime, kind };
    if (urlOk) file.url = url;
    if (dataOk && dataUrl.length <= 8_000_000 && total + dataUrl.length <= 8_000_000) {
      file.dataUrl = dataUrl;
      total += dataUrl.length;
    }
    out.push(file);
  }
  return out;
}

/**
 * Agent 执行器
 * 统一调用已纳管的 Agent（Claude Code, Codex, Cursor 等）
 */
class AgentExecutor extends EventEmitter {
  constructor() {
    super();
    this.runningTasks = new Map(); // taskId → { process, agent_id }
    // 任务元数据缓存：进程结束后仍可用于 IPC 事件路由
    this.taskMetaCache = new Map(); // taskId → { agentId, sessionKey, parentTaskId }
    /** stream-json content_block index → type（thinking / text） */
    this._streamState = new Map(); // taskId → { blockTypes: Map }
  }

  /**
   * 获取数据库实例
   */
  _getDb() {
    return localStats.requireDb(STATS_DIR);
  }

  /**
   * 解析 Agent 启动命令（executable + args 前缀），兼容 npx 安装的 Codex
   */
  _resolveLaunchSpec(agentId) {
    const cfg = AGENT_CLI[agentId];
    if (!cfg) return null;

    // Cursor 等：多候选二进制（cursor-agent → agent），对齐 Tutti 解析顺序
    const names = Array.isArray(cfg.detectCommands) && cfg.detectCommands.length
      ? cfg.detectCommands
      : [cfg.detectCommand].filter(Boolean);

    for (const name of names) {
      const resolved = shim?.resolveRealCommand?.(name);
      if (resolved) {
        return { executable: resolved, argPrefix: [], detectCommand: name };
      }
    }

    if (cfg.npxPackage) {
      const npx = shim?.resolveRealCommand?.('npx') || 'npx';
      return { executable: npx, argPrefix: ['-y', cfg.npxPackage], detectCommand: 'npx'};
    }

    const fallback = names[0] || cfg.detectCommand;
    return fallback ? { executable: fallback, argPrefix: [], detectCommand: fallback } : null;
  }

  _resolveExecutable(agentId) {
    return this._resolveLaunchSpec(agentId)?.executable || null;
  }

  /**
   * 将 MCP / 用户传入的 agent_id 规范化为 listAvailableAgents 中的 id
   * 支持 assistant:res-xxx、资源 name（如 python-expert）、显示名
   */
  async resolveAgentId(agentId) {
    const raw = String(agentId || '').trim();
    if (!raw) throw new Error('缺少 agent_id');

    // 内置 CLI（claude-code 等）不依赖列表缓存。缓存里暂时没有时也不应报未知。
    const builtin = canonicalBuiltinAgentId(raw);
    if (builtin) return builtin;
    if (require('./guardian/chat').isGuardianAgent(raw)) return raw;

    const {
      isCommunityAgentId,
      getHired,
      makeCommunityAgentId,
      parseCommunityAgentId,
    } = require('./hired-community-agents');

    // 社区雇佣武将：community:<assistant_id>[@用户名]，不带设备 id
    if (isCommunityAgentId(raw)) {
      const hired = getHired(raw);
      if (hired?.id) return makeCommunityAgentId(hired.assistant_id, hired.owner || hired.owner_nickname);
      const parsed = parseCommunityAgentId(raw);
      if (parsed?.assistant_id) {
        return makeCommunityAgentId(parsed.assistant_id, parsed.owner);
      }
    }

    const agents = await this.listAvailableAgents();
    const exact = agents.find(a => a.id === raw);
    if (exact) return exact.id;

    const lower = raw.toLowerCase();
    const assistants = agents.filter(a => a.type === 'assistant');

    for (const a of assistants) {
      if (a.name?.toLowerCase() === lower) return a.id;
      if (a.resourceId === raw || a.resourceId === raw.replace(/^assistant:/, '')) return a.id;
      if (raw.startsWith(ASSISTANT_ID_PREFIX) && a.id.endsWith(raw.slice(ASSISTANT_ID_PREFIX.length))) {
        return a.id;
      }
    }

    // 按显示名匹配已雇佣社区武将
    const community = agents.filter(a => a.type === 'community');
    for (const a of community) {
      if (a.name?.toLowerCase() === lower) return a.id;
      if (a.assistantId === raw) return a.id;
    }

    const resourceManager = require('./resource-manager');
    resourceManager.init();
    const byName = resourceManager._findByTypeName('assistant', raw);
    if (byName) return `${ASSISTANT_ID_PREFIX}${byName.id}`;

    const cli = agents.find(a => a.id === lower || a.name?.toLowerCase() === lower);
    if (cli) return cli.id;

    throw new Error(`未知 Agent: ${agentId}（请用 tb_list_agents 查看可用 id）`);
  }

  /**
   * 获取可用的 Agent 列表
   * CLI 四件套（Claude Code / Codex / Cursor / Kimi Code）始终返回；
   * 未安装的带 installed:false，游乐场侧栏显示为灰色。
   * @param {{ force?: boolean }} options - force 跳过缓存
   */
  async listAvailableAgents(options = {}) {
    const now = Date.now();
    const hiredEntries = () => require('./hired-community-agents').toAgentListEntries();
    if (!options.force && AGENT_LIST_CACHE.agents
      && (now - AGENT_LIST_CACHE.at) < AGENT_LIST_CACHE.ttlMs) {
      // 旧缓存无 installed 字段 → 视为过期，重新探测
      const stale = AGENT_LIST_CACHE.agents.some(
        (a) => a.type === 'cli' && typeof a.installed !== 'boolean',
      );
      if (!stale) {
        // 雇佣名单可能刚写入：缓存里刷新 community 段
        const base = AGENT_LIST_CACHE.agents.filter((a) => a.type !== 'community');
        return [...base, ...hiredEntries()];
      }
    }

    // 先只查命令是否存在就返回。--version 和 Cursor 登录会拖住整份列表（登录探测最长 45 秒）。
    const prevById = new Map((AGENT_LIST_CACHE.agents || []).filter(a => a.type === 'cli').map(a => [a.id, a]));
    const cliAgents = Object.entries(AGENT_CLI).map(([id, cfg]) => {
      const names = Array.isArray(cfg.detectCommands) && cfg.detectCommands.length
        ? cfg.detectCommands
        : [cfg.detectCommand].filter(Boolean);

      // 以 resolveRealCommand 命中为准（裸命令名回退不算已安装）
      let resolvedPath = null;
      let detectCommand = names[0] || cfg.detectCommand || id;
      for (const name of names) {
        const resolved = shim?.resolveRealCommand?.(name);
        if (resolved) {
          resolvedPath = resolved;
          detectCommand = name;
          break;
        }
      }
      const installed = !!resolvedPath;
      const prev = prevById.get(id);
      // 安装状态没变时先沿用上次的版本和登录，避免列表先闪成空白再补上
      const keepMeta = prev && prev.installed === installed;

      const launch = installed ? this._resolveLaunchSpec(id) : null;
      const entry = {
        id,
        name: cfg.name,
        type: 'cli',
        executable: launch?.executable || resolvedPath || null,
        capabilities: cfg.capabilities,
        version: installed && keepMeta ? (prev.version || null) : null,
        installed,
        status: installed ? 'active' : 'missing',
        _probeCmd: installed ? (resolvedPath || detectCommand) : null,
      };
      // Cursor：应用列表看 IDE；游乐场看 CLI 安装 + 登录（优先共享 IDE 会话）。
      if (id === 'cursor') {
        try {
          entry.idePresent = !!require('./resource-agent-targets').isAgentInstalled('cursor');
        } catch {
          entry.idePresent = false;
        }
        entry.modelLabel = readCursorCliModelLabel();
        if (!installed) {
          entry.canInstallCli = true;
          entry.cliLoggedIn = false;
        } else if (keepMeta && typeof prev.cliLoggedIn === 'boolean') {
          entry.cliLoggedIn = prev.cliLoggedIn;
          entry.needsCliLogin = !!prev.needsCliLogin;
        }
      }
      return entry;
    });

    // 自定义智能体：已安装 CLI，或具备 npx 包回退的运行时均可挂载
    const launchableCliIds = new Set();
    for (const a of cliAgents) {
      if (a.installed) {
        launchableCliIds.add(a.id);
        continue;
      }
      const cfg = AGENT_CLI[a.id];
      if (cfg?.npxPackage && shim?.resolveRealCommand?.('npx')) {
        launchableCliIds.add(a.id);
      }
    }
    this._launchableCliIds = launchableCliIds;
    let guardianEntry = null;
    try { guardianEntry = require('./guardian/chat').listEntry(launchableCliIds, AGENT_CLI); } catch { /* 智能管家不可用 */ }
    const agents = [
      ...cliAgents,
      // 智能管家：排在各应用（运行时）下面、自定义智能体前面
      ...(guardianEntry ? [guardianEntry] : []),
      ...this._listCustomAssistants(launchableCliIds),
      // 已雇佣的社区武将（远程执行，无正文）
      ...require('./hired-community-agents').toAgentListEntries(),
    ];

    // 探测命令只留给后台补版本，不发给界面
    const probeCmds = new Map(cliAgents.map(a => [a.id, a._probeCmd || null]));
    for (const a of cliAgents) delete a._probeCmd;

    AGENT_LIST_CACHE.at = now;
    AGENT_LIST_CACHE.agents = agents;
    this._enrichCliAgents(cliAgents.map(a => ({ ...a, _probeCmd: probeCmds.get(a.id) })), ++_agentListEnrichGen)
      .catch(() => {});
    return agents;
  }

  /**
   * 后台补 CLI 版本和 Cursor 登录。列表已经返回，这里完成后再推一次。
   * gen 对不上说明又开始了新一轮快检，丢掉这次结果。
   */
  async _enrichCliAgents(cliAgents, gen) {
    const enriched = await Promise.all(cliAgents.map(async (entry) => {
      const next = { ...entry };
      delete next._probeCmd;
      if (!entry.installed) return next;

      if (entry._probeCmd && runProbe) {
        try {
          const probe = await runProbe(entry._probeCmd, ['--version'], 1800);
          if (probe.ok) next.version = probe.stdout.match(/[\d.]+/)?.[0] || probe.stdout;
        } catch { /* 版本失败不影响已安装 */ }
      }

      if (entry.id === 'cursor') {
        try {
          const st = await require('./cursor-agent-install').getCursorAgentAuthStatus({ timeoutMs: 2500 });
          // 超时或探测失败时保留快检结果，避免误提示去登录
          if (st && st.ok) {
            next.cliLoggedIn = !!st.loggedIn;
            next.needsCliLogin = !st.loggedIn;
          }
        } catch { /* 保留进入后台前的登录标记 */ }
      }
      return next;
    }));

    if (gen !== _agentListEnrichGen) return;
    const byId = new Map(enriched.map(a => [a.id, a]));
    const current = AGENT_LIST_CACHE.agents || [];
    const next = current.map(a => (a.type === 'cli' && byId.has(a.id) ? byId.get(a.id) : a));
    const changed = next.some((a, i) => {
      const prev = current[i];
      if (!prev || a === prev) return false;
      return a.version !== prev.version
        || a.cliLoggedIn !== prev.cliLoggedIn
        || a.needsCliLogin !== prev.needsCliLogin;
    });
    AGENT_LIST_CACHE.agents = next;
    AGENT_LIST_CACHE.at = Date.now();
    if (changed) this.emit('list:updated', next);
  }

  /**
   * 投射到了应用、但现在跑不起来的智能体：运行它的应用不可用，或它要用的技能已经不在资产里。
   * 网关页挂在应用下显示「跑不起来」；游乐场列表不受影响。
   * @returns {{ id, resourceId, name, runtimeAgentId, reason: 'runtime'|'skills', missing: string[] }[]}
   */
  listBlockedAssistants() {
    const resourceManager = require('./resource-manager');
    resourceManager.init();
    const launchable = this._launchableCliIds || new Set();
    const skills = resourceManager.listResources({ type: 'skill' });
    const known = new Set();
    for (const r of skills) { known.add(r.id); known.add(String(r.name)); if (r.display_name) known.add(String(r.display_name)); }
    const out = [];
    for (const resource of resourceManager.listResources({ type: 'assistant' })) {
      const targets = [...new Set((resource.projections || []).map(p => p?.agentId || p?.agent_id).filter(id => AGENT_CLI[id]))];
      if (!targets.length) continue;
      const config = parseAssistantConfig(resource.content);
      const base = { id: `${ASSISTANT_ID_PREFIX}${resource.id}`, resourceId: resource.id, name: resource.display_name || resource.name };
      const runtime = resolveAssistantRuntimeAgent(config, resource.projections || [], launchable);
      if (!runtime || !launchable.has(runtime)) {
        out.push({ ...base, runtimeAgentId: targets[0], reason: 'runtime', missing: targets.map(id => AGENT_CLI[id]?.name || id) });
        continue;
      }
      const lost = (config.skills || []).filter(s => !known.has(String(s)));
      if (lost.length) out.push({ ...base, runtimeAgentId: runtime, reason: 'skills', missing: lost });
    }
    return out;
  }

  /** 已纳管 Assistant → Debug 自定义 Agent */
  _listCustomAssistants(availableCliIds) {
    const resourceManager = require('./resource-manager');
    resourceManager.init();
    const items = resourceManager.listResources({ type: 'assistant' });
    const list = [];

    for (const resource of items) {
      // 未投射则不进游乐场；投射目标决定运行时（Cursor 投射 → 真用 cursor-agent）
      if (!hasAssistantEnableProjection(resource.projections)) continue;

      const config = parseAssistantConfig(resource.content);
      const runtimeAgentId = resolveAssistantRuntimeAgent(
        config,
        resource.projections || [],
        availableCliIds,
      );
      if (!runtimeAgentId || !availableCliIds.has(runtimeAgentId)) continue;

      const execName = AGENT_CLI[runtimeAgentId]?.name || runtimeAgentId;
      const displayName = resolveAssistantDisplayRuntime(resource.projections, runtimeAgentId) || execName;
      const explicitModel = String(config.model || '').trim();
      list.push({
        id: `${ASSISTANT_ID_PREFIX}${resource.id}`,
        name: resource.display_name || resource.name,
        type: 'assistant',
        resourceId: resource.id,
        runtimeAgentId,
        runtimeName: displayName,
        execRuntimeName: execName,
        description: resource.description || '',
        skillCount: Array.isArray(config.skills) ? config.skills.length : 0,
        custom: true,
        // 显式模型优先；未写模型且运行时是 Cursor 时，用 CLI 当前选中模型
        modelLabel: explicitModel || (runtimeAgentId === 'cursor' ? readCursorCliModelLabel() : ''),
        capabilities: AGENT_CLI[runtimeAgentId]?.capabilities || ['chat'],
        status: 'active',
      });
    }

    return list;
  }

  _resolveAssistant(agentId) {
    if (!isAssistantAgentId(agentId)) {
      return { agentId, assistant: null };
    }
    const guardianChat = require('./guardian/chat');
    if (guardianChat.isGuardianAgent(agentId)) {
      const st = require('./guardian/engine').status();
      if (!st.ready || !AGENT_CLI[st.runtime]) throw new Error('智能管家还没有执行应用：到智能管家页设置一个');
      const launch = buildAssistantLaunch(st.runtime, guardianChat.systemText(), '');
      return { agentId: st.runtime, assistant: { virtualId: agentId, resource: null, config: {}, launch } };
    }

    const resourceManager = require('./resource-manager');
    resourceManager.init();
    const resource = resourceManager.getResource(assistantResourceId(agentId));
    if (!resource || resource.type !== 'assistant') {
      throw new Error('Assistant 资产不存在');
    }

    const config = parseAssistantConfig(resource.content);
    const runtimeAgentId = resolveAssistantRuntimeAgent(config, resource.projections || []);
    if (!runtimeAgentId || !AGENT_CLI[runtimeAgentId]) {
      throw new Error(`Assistant 运行时 Agent 不可用: ${runtimeAgentId || config.runtime_agent}`);
    }

    const systemText = resolveAssistantContext(config, resourceManager);
    // 本地智能体直接回答，不附产物落盘规则（出租接单另加）
    const launch = buildAssistantLaunch(runtimeAgentId, systemText, config.model);

    return {
      agentId: runtimeAgentId,
      assistant: { virtualId: agentId, resource, config, launch },
    };
  }

  /**
   * 执行 Agent 任务
   * @param {string} agentId - Agent ID
   * @param {string} prompt - 任务提示
   * @param {object} options - 选项
   * @returns {Promise<{taskId: string}>}
   */
  async execute(agentId, prompt, options = {}) {
    const db = this._getDb();
    const canonicalId = await this.resolveAgentId(agentId);
    const { workingDir = process.cwd(), assistantId, mcpProfile, mode = 'direct', mainAgentId } = options;

    // 创建任务记录
    const taskId = `task_${Date.now()}_${nanoid(8)}`;
    const sessionKey = options.sessionKey || canonicalId;

    db.prepare(`
      INSERT INTO agent_tasks (id, agent_id, prompt, context, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(
      taskId,
      canonicalId,
      prompt,
      JSON.stringify({
        workingDir,
        assistantId,
        mcpProfile,
        mode,
        mainAgentId,
        parentTaskId: options.parentTaskId || null,
        sessionKey,
        sessionInstanceId: options.sessionInstanceId || null,
        // 社区接单标记：本机游乐场列表/事件应忽略
        clientId: options.clientId || null,
        // local / owner = 本机，hired = 雇佣。来自请求 metadata.call_context。
        callContext: options.callContext || null,
      }),
      Date.now(),
    );

    // 异步执行（用户停止后勿再覆盖为 failed，以免丢掉 cliSessionId）
    this._executeAsync(taskId, canonicalId, prompt, { ...options, sessionKey }).catch(err => {
      console.error(`[AgentExecutor] Task ${taskId} failed:`, err);
      if (!this._isTaskCancelled(taskId)) {
        this._updateTaskStatus(taskId, 'failed', err.message);
      }
    });

    this.taskMetaCache.set(taskId, {
      agentId: canonicalId,
      sessionKey,
      parentTaskId: options.parentTaskId || null,
      sessionInstanceId: options.sessionInstanceId || null,
      clientId: options.clientId || null,
    });

    return { taskId };
  }

  /**
   * 派发子任务并阻塞等待完成（供 MCP tb_dispatch_agent 使用）
   */
  async dispatchAndWait(agentId, prompt, options = {}) {
    const parentTaskId = options.parentTaskId;
    const canonicalId = await this.resolveAgentId(agentId);

    // 社区雇佣武将：远程派发（对方本机执行，不下载正文）
    const { isCommunityAgentId } = require('./hired-community-agents');
    if (isCommunityAgentId(canonicalId)) {
      return this._dispatchCommunityAndWait(canonicalId, prompt, options);
    }

    // 召唤专业智能体：记命中并弹息票（与 tb_get_resource 点将对齐）
    if (isAssistantAgentId(canonicalId) && !require('./guardian/chat').isGuardianAgent(canonicalId)) {
      try {
        const resourceManager = require('./resource-manager');
        const rid = assistantResourceId(canonicalId);
        const cid = String(
          options.clientId
          || process.env.TB_CLIENT_ID
          || process.env.TB_MAIN_AGENT_ID
          || '',
        ).trim();
        resourceManager.recordResourceHit?.(rid, cid);
      } catch (e) {
        console.warn('[agent-executor] recordResourceHit on dispatch:', e.message);
      }
    }

    // 派发子任务：归属父窗口 session，继承父会话实例 ID
    let sessionKey = options.sessionKey || canonicalId;
    let sessionInstanceId = options.sessionInstanceId || null;
    if (parentTaskId) {
      const parentMeta = this._taskEventMeta(parentTaskId);
      const parentKey = options.parentSessionKey || parentMeta.sessionKey || null;
      if (parentKey) sessionKey = parentKey;
      sessionInstanceId = options.parentSessionInstanceId
        || parentMeta.sessionInstanceId
        || sessionInstanceId;
    }

    const { taskId } = await this.execute(canonicalId, prompt, {
      ...options,
      mode: options.mode || 'worker',
      sessionKey,
      sessionInstanceId,
      parentTaskId,
    });

    // 通知前端：子任务已派发，便于当前窗口展示派发卡片
    this.emit('task:dispatched', {
      parentTaskId,
      childTaskId: taskId,
      agentId: canonicalId,
      prompt,
      parentSessionKey: sessionKey,
      parentSessionInstanceId: sessionInstanceId,
      timestamp: Date.now(),
    });

    if (parentTaskId) {
      this.emit('task:step', {
        taskId: parentTaskId,
        stepType: 'delegation',
        phase: 'start',
        agentId: canonicalId,
        childTaskId: taskId,
        content: prompt,
        timestamp: Date.now(),
      });
    }

    const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
    const start = Date.now();

    try {
      while (Date.now() - start < timeoutMs) {
        const status = await this.getTaskStatus(taskId);
        if (['completed', 'failed', 'cancelled'].includes(status.status)) {
          if (parentTaskId) {
            const summary = status.result?.summary
              || status.result?.output
              || status.error
              || (status.status === 'completed' ? '(完成)' : status.status);
            this.emit('task:step', {
              taskId: parentTaskId,
              stepType: 'delegation',
              phase: 'complete',
              agentId: canonicalId,
              childTaskId: taskId,
              content: summary,
              status: status.status,
              timestamp: Date.now(),
            });
          }
          // 兜底：确保子 Agent 标签页收到完成事件（避免 UI 卡在 executing）
          this._notifyTaskTerminal(taskId, status);
          return status;
        }
        await sleep(400);
      }
      await this.cancel(taskId);
      throw new Error(`子任务超时 (${agentId})`);
    } catch (err) {
      if (parentTaskId) {
        this.emit('task:step', {
          taskId: parentTaskId,
          stepType: 'delegation',
          phase: 'complete',
          agentId,
          childTaskId: taskId,
          content: err.message,
          status: 'failed',
          timestamp: Date.now(),
        });
      }
      throw err;
    }
  }

  /**
   * 社区雇佣武将：经云端 /api/agent-tasks 在对方设备执行，只回结果
   */
  async _dispatchCommunityAndWait(canonicalId, prompt, options = {}) {
    const { getHired, parseCommunityAgentId } = require('./hired-community-agents');
    const { runCommunityAgentTask } = require('./community-agent-client');
    const hired = getHired(canonicalId);
    const parsed = parseCommunityAgentId(canonicalId) || {};
    const assistantId = hired?.assistant_id || parsed.assistant_id;
    // @用户名交给云端，在该出租者当前在线的设备里自动选，不钉设备
    const owner = parsed.owner || hired?.owner || hired?.owner_nickname || null;
    if (!assistantId) throw new Error(`无效社区智能体 id: ${canonicalId}`);

    const parentTaskId = options.parentTaskId;
    const taskId = `community-${Date.now().toString(36)}`;
    const sessionKey = options.sessionKey
      || options.parentSessionKey
      || canonicalId;

    this.emit('task:dispatched', {
      parentTaskId,
      childTaskId: taskId,
      agentId: canonicalId,
      prompt,
      parentSessionKey: sessionKey,
      parentSessionInstanceId: options.parentSessionInstanceId || null,
      timestamp: Date.now(),
    });

    if (parentTaskId) {
      this.emit('task:step', {
        taskId: parentTaskId,
        stepType: 'delegation',
        phase: 'start',
        agentId: canonicalId,
        childTaskId: taskId,
        content: prompt,
        timestamp: Date.now(),
      });
    }

    try {
      const progress = { text: '', tool: '' };
      const result = await runCommunityAgentTask({
        assistantId,
        prompt,
        owner,
        timeoutMs: options.timeoutMs,
        images: options.images,
        files: options.files,
        sessionKey: options.historyThreadId || options.parentSessionKey || '',
        stream: !!options.stream,
        onProgress: options.stream
          ? (ev) => this._noteCommunityProgress(parentTaskId || taskId, ev, progress)
          : undefined,
      });
      const ok = !!result?.ok;
      const artifacts = normalizeCommunityArtifacts(result?.artifacts);
      const status = {
        status: ok ? 'completed' : (result?.status || 'failed'),
        agent_id: canonicalId,
        error: ok ? null : (result?.error || result?.status || 'failed'),
        result: {
          output: result?.output || '',
          summary: result?.output || '',
          artifacts,
        },
        usage: result?.usage || null,
      };

      if (parentTaskId) {
        this.emit('task:step', {
          taskId: parentTaskId,
          stepType: 'delegation',
          phase: 'complete',
          agentId: canonicalId,
          childTaskId: taskId,
          content: status.result.summary || status.error || status.status,
          status: status.status,
          timestamp: Date.now(),
        });
      }
      this.emit('task:completed', { taskId, ...status, timestamp: Date.now() });
      return status;
    } catch (err) {
      if (parentTaskId) {
        this.emit('task:step', {
          taskId: parentTaskId,
          stepType: 'delegation',
          phase: 'complete',
          agentId: canonicalId,
          childTaskId: taskId,
          content: err.message,
          status: 'failed',
          timestamp: Date.now(),
        });
      }
      throw err;
    }
  }

  /** 把云端进度收成和本地智能体一样的 output / tool_call / tool_result 步骤。 */
  _noteCommunityProgress(taskId, ev, state) {
    if (!taskId || !ev || this._isTaskCancelled(taskId)) return;
    const parts = Array.isArray(ev.parts) && ev.parts.length ? ev.parts : null;
    if (parts) {
      this._noteCommunityParts(taskId, parts, state);
      return;
    }
    const text = String(ev.text || '');
    if (text && text !== state.text) {
      state.text = text;
      this.emit('task:step', {
        taskId,
        stepType: 'output',
        content: text,
        is_snapshot: true,
        timestamp: Date.now(),
        ...this._taskEventMeta(taskId),
      });
    }
    const tool = String(ev.tool || '').trim();
    if (tool && tool !== state.tool) {
      state.tool = tool;
      this.emit('task:step', {
        taskId,
        stepType: 'tool_call',
        tool_name: tool,
        content: tool,
        timestamp: Date.now(),
        ...this._taskEventMeta(taskId),
      });
    }
  }

  /**
   * 进度分段是累积快照。工具一旦后面有新段，或带 done，就补一条结果，
   * 避免收尾时把已经跑完的工具画成「未收到结果 / 失败」。
   */
  _noteCommunityParts(taskId, parts, state) {
    if (!state.partCursor) state.partCursor = [];
    const meta = this._taskEventMeta(taskId);
    parts.forEach((part, index) => {
      if (!part || typeof part !== 'object') return;
      const prev = state.partCursor[index] || {};
      const kind = String(part.type || '');
      if (kind === 'text' || kind === 'thinking') {
        const text = String(part.text || '');
        if (!text || prev.text === text) return;
        state.partCursor[index] = { text };
        this.emit('task:step', {
          taskId,
          stepType: kind === 'thinking' ? 'thinking' : 'output',
          content: text,
          is_snapshot: true,
          timestamp: Date.now(),
          ...meta,
        });
        return;
      }
      if (kind !== 'tool') return;
      const name = String(part.name || 'tool');
      const detail = String(part.detail || '');
      const id = `cpart-${index}`;
      if (!prev.called) {
        this.emit('task:step', {
          taskId,
          stepType: 'tool_call',
          tool_name: name,
          tool_use_id: id,
          content: detail || name,
          timestamp: Date.now(),
          ...meta,
        });
        prev.called = true;
        prev.callDetail = detail;
      }
      const finished = part.done === true || index < parts.length - 1;
      if (finished && !prev.done) {
        let result = String(part.result || '');
        if (!result && detail && prev.callDetail && detail !== prev.callDetail && detail.startsWith(prev.callDetail)) {
          result = detail.slice(prev.callDetail.length).trim();
        }
        this.emit('task:step', {
          taskId,
          stepType: 'tool_result',
          tool_name: name,
          tool_use_id: id,
          content: result || (part.error ? '(失败)' : '(完成)'),
          is_error: !!part.error,
          timestamp: Date.now(),
          ...meta,
        });
        prev.done = true;
      }
      state.partCursor[index] = prev;
    });
  }

  /**
   * 游乐场 execute：社区雇佣智能体走云端派发（对方设备执行）
   */
  async _runCommunityTaskForExecute(taskId, agentId, prompt, options = {}) {
    const db = this._getDb();
    const { getHired, parseCommunityAgentId, makeCommunityAgentId } = require('./hired-community-agents');
    const { runCommunityAgentTask, resolveCommunityOwner } = require('./community-agent-client');
    const hired = getHired(agentId);
    const parsed = parseCommunityAgentId(agentId) || {};
    const assistantId = hired?.assistant_id || parsed.assistant_id;
    if (!assistantId) throw new Error(`无效社区智能体 id: ${agentId}`);
    // 和接口同一套标识：community:<id>@<用户名>，云端自动选设备
    const owner = await resolveCommunityOwner(
      assistantId,
      parsed.owner || hired?.owner || hired?.owner_nickname,
    );
    const harnessId = makeCommunityAgentId(assistantId, owner);
    const progress = { text: '', tool: '' };

    this.emit('task:step', {
      taskId,
      stepType: 'system_event',
      system_subtype: 'process_started',
      content: harnessId,
      message: harnessId,
      timestamp: Date.now(),
      ...this._taskEventMeta(taskId),
    });

    const result = await runCommunityAgentTask({
      assistantId,
      prompt,
      owner,
      timeoutMs: options.timeoutMs,
      // 对方设备执行：附图 / 文件随任务下发，由对方落盘
      images: options.images,
      files: options.files,
      sessionKey: options.historyThreadId || '',
      stream: !!options.stream,
      onProgress: options.stream
        ? (ev) => this._noteCommunityProgress(taskId, ev, progress)
        : undefined,
    });

    if (this._isTaskCancelled(taskId)) {
      this.taskMetaCache.delete(taskId);
      return;
    }

    if (!result?.ok) {
      // 超时也留下已生成正文，桌面端才能自动续跑
      const errText = String(result?.error || result?.status || 'community task failed');
      const output = String(result?.output || progress.text || '');
      const artifacts = normalizeCommunityArtifacts(result?.artifacts);
      const payload = {
        success: false,
        summary: output,
        output,
        stderr: errText,
        error: errText,
        files: [],
        artifacts,
        stepCount: 0,
        usage: result?.usage || null,
      };
      try {
        db.prepare(`
          UPDATE agent_tasks
          SET status = 'failed', error = ?, result = ?, completed_at = ?
          WHERE id = ?
        `).run(errText, JSON.stringify(payload), Date.now(), taskId);
      } catch (e) {
        console.warn('[AgentExecutor] community task fail persist failed:', e.message);
        this._updateTaskStatus(taskId, 'failed', errText);
      }
      this.emit('task:failed', {
        taskId,
        error: errText,
        result: payload,
        status: 'failed',
        ...this._taskEventMeta(taskId),
      });
      this.taskMetaCache.delete(taskId);
      return;
    }

    const artifacts = normalizeCommunityArtifacts(result.artifacts);
    const payload = {
      success: true,
      summary: result.output || '',
      output: result.output || '',
      stderr: '',
      files: [],
      // 对方工作目录里的成品。本机没有这些路径，用 data URL 展示和下载
      artifacts,
      stepCount: 0,
      usage: result.usage || null,
    };
    try {
      db.prepare(`
        UPDATE agent_tasks
        SET status = 'completed', result = ?, completed_at = ?
        WHERE id = ?
      `).run(JSON.stringify(payload), Date.now(), taskId);
    } catch (e) {
      console.warn('[AgentExecutor] community task complete persist failed:', e.message);
      try {
        db.prepare(`
          UPDATE agent_tasks SET status = 'completed', completed_at = ? WHERE id = ?
        `).run(Date.now(), taskId);
      } catch { /* ignore */ }
    }

    this.emit('task:completed', {
      taskId,
      result: {
        success: true,
        summary: payload.summary,
        stderr: '',
        files: [],
        artifacts: payload.artifacts,
        stepCount: 0,
      },
      status: 'completed',
      ...this._taskEventMeta(taskId),
    });
    this.taskMetaCache.delete(taskId);
  }

  /**
   * 异步执行任务
   */
  async _executeAsync(taskId, agentId, prompt, options) {
    const db = this._getDb();
    
    // 更新状态为 running
    db.prepare(`
      UPDATE agent_tasks 
      SET status = 'running', started_at = ?
      WHERE id = ?
    `).run(Date.now(), taskId);

    let orchestratorCleanup = null;

    try {
      // 已雇佣社区智能体：远程派发，勿走本地 CLI
      const { isCommunityAgentId } = require('./hired-community-agents');
      if (isCommunityAgentId(agentId)) {
        await this._runCommunityTaskForExecute(taskId, agentId, prompt, options);
        return;
      }

      // 本地 CLI：附图落盘；Claude 走多模态 stdin，其它 Agent 拼路径进 prompt
      const { mode = 'direct', workingDir = process.cwd(), mcpProfile, continueSession, cliSessionId } = options;
      const { agentId: effectiveAgentId, assistant } = this._resolveAssistant(agentId);
      const { isContributeSessionKey, ensureLocalSessionDir } = require('./contribute-session');
      const confined = options.clientId === 'contribute' || isContributeSessionKey(options.sessionKey);
      const claudeFamily = effectiveAgentId === 'claude-code' || !!(assistant?.launch?.claudeExtraArgs);
      // 本机 Claude 按对话线程换目录。看图缓存跟着工作目录走，不再和这个项目里的其他会话挤在一起。
      // 用户选的项目仍用 --add-dir 放行。接单任务的目录已经按会话拆过，这里不再套一层。
      let runDir = workingDir;
      let projectDir = '';
      if (!confined && claudeFamily) {
        const isolated = ensureLocalSessionDir(workingDir, options.historyThreadId);
        if (isolated) {
          projectDir = workingDir;
          runDir = isolated;
        }
      }
      const imgInfo = options.images?.length
        ? materializeAttachedImages(options.images, { taskId, workingDir: runDir })
        : { paths: [], mediaParts: [], suffix: '', uploadDir: '' };
      const fileInfo = options.files?.length
        ? materializeAttachedFiles(options.files, {
          taskId,
          workingDir: runDir,
          uploadDir: imgInfo.uploadDir || '',
        })
        : { paths: [], suffix: '', uploadDir: '' };

      const claudeMultimodal = imgInfo.mediaParts.length > 0 && (
        effectiveAgentId === 'claude-code'
        || !!(assistant?.launch?.claudeExtraArgs)
      );

      let userPrompt = prompt;
      // 非 Claude：图片路径后缀；Claude 的图在 stdin。普通文件一律给路径。
      if (imgInfo.suffix && !claudeMultimodal) userPrompt = `${userPrompt}${imgInfo.suffix}`;
      if (fileInfo.suffix) userPrompt = `${userPrompt}${fileInfo.suffix}`;

      if (assistant && mode === 'orchestrator') {
        throw new Error('自定义 Assistant 请在其标签页直调使用，聚合入口请选 CLI Agent');
      }

      const cfg = AGENT_CLI[effectiveAgentId];
      if (!cfg) throw new Error(`Unsupported agent: ${agentId}`);

      const launch = this._resolveLaunchSpec(effectiveAgentId);
      if (!launch?.executable) {
        throw new Error(`${cfg.name} CLI 未安装（命令: ${cfg.detectCommand}）`);
      }

      let execPrompt = userPrompt;
      let args;
      let stdinPayload = null;

      if (mode === 'orchestrator') {
        if (!mcpManager.supportsOrchestrator(effectiveAgentId)) {
          throw new Error(`编排模式暂不支持 ${cfg.name}`);
        }
        const orch = mcpManager.buildOrchestratorLaunch({
          agentId: effectiveAgentId,
          taskId,
          workingDir: runDir,
          mainAgentId: options.mainAgentId,
          profileId: mcpProfile || mcpManager.DEVELOPMENT_PROFILE_ID || mcpManager.DEFAULT_PROFILE_ID,
          sessionKey: options.sessionKey || null,
          sessionInstanceId: options.sessionInstanceId || null,
        });
        orchestratorCleanup = orch.cleanup;
        if (orch.promptPrefix) execPrompt = orch.promptPrefix + userPrompt;
        if (effectiveAgentId === 'claude-code') {
          args = [
            ...launch.argPrefix,
            ...buildClaudeContinueArgs({ continueSession, cliSessionId }),
            ...orch.extraArgs,
          ];
          if (claudeMultimodal) {
            args = ensureClaudeMultimodalArgs(args);
            stdinPayload = buildClaudeMultimodalStdin(execPrompt, imgInfo.mediaParts);
          } else {
            args.push(execPrompt);
          }
        } else if (effectiveAgentId === 'codex') {
          args = [
            ...launch.argPrefix,
            ...injectCodexResumeArgs(orch.extraArgs, { continueSession, cliSessionId }),
            execPrompt,
          ];
        } else if (effectiveAgentId === 'cursor') {
          // 与直调同一套参数（含 --approve-mcps），编排说明已在 execPrompt 前缀里
          args = [...launch.argPrefix, ...cfg.buildArgs(execPrompt, {
            workingDir: runDir,
            continueSession,
            cliSessionId,
            model: String(options.model || '').trim(),
          })];
        } else if (effectiveAgentId === 'pi') {
          // 与直调同一套 --mode json，编排说明已在 execPrompt 前缀里
          args = [...launch.argPrefix, ...cfg.buildArgs(execPrompt, {
            continueSession,
            cliSessionId,
            model: String(options.model || '').trim(),
          })];
        } else {
          args = [...launch.argPrefix, ...orch.extraArgs, execPrompt];
        }
      } else if (assistant) {
        const { launch: asstLaunch } = assistant;
        if (asstLaunch.claudeExtraArgs) {
          args = [
            ...launch.argPrefix,
            ...buildClaudeContinueArgs({ continueSession, cliSessionId }),
            ...asstLaunch.claudeExtraArgs,
          ];
          if (claudeMultimodal) {
            args = ensureClaudeMultimodalArgs(args);
            stdinPayload = buildClaudeMultimodalStdin(userPrompt, imgInfo.mediaParts);
          } else {
            args.push(userPrompt);
          }
        } else {
          // Codex / Cursor：soul 作前缀；续聊与模型经 buildArgs
          execPrompt = (asstLaunch.promptPrefix || '') + userPrompt;
          args = [...launch.argPrefix, ...cfg.buildArgs(execPrompt, {
            workingDir: runDir,
            continueSession,
            cliSessionId,
            // 游乐场当场选的模型优先于智能体正文里保存的
            model: String(options.model || '').trim() || asstLaunch.model || assistant.config?.model,
          })];
        }
      } else if (effectiveAgentId === 'claude-code' && claudeMultimodal) {
        args = [...launch.argPrefix, ...cfg.buildArgs(userPrompt, {
          workingDir: runDir, continueSession, cliSessionId, multimodalInput: true,
        })];
        stdinPayload = buildClaudeMultimodalStdin(userPrompt, imgInfo.mediaParts);
      } else {
        args = [...launch.argPrefix, ...cfg.buildArgs(userPrompt, {
          workingDir: runDir,
          continueSession,
          cliSessionId,
          // 仅 Cursor / Kimi 的 buildArgs 会消费 model；Claude 走网关路由，不把路由 id 当 --model
          model: (effectiveAgentId === 'cursor' || effectiveAgentId === 'kimi-code')
            ? String(options.model || '').trim()
            : '',
        })];
      }

      // 允许 Claude 读上传目录（图在 stdin 时的兜底，以及普通文件）
      const claudeLike = effectiveAgentId === 'claude-code' || !!(assistant?.launch?.claudeExtraArgs);
      const attachDir = fileInfo.uploadDir || imgInfo.uploadDir;
      if (claudeLike && (claudeMultimodal || fileInfo.paths.length) && attachDir && !args.includes(attachDir)) {
        args.push('--add-dir', attachDir);
      }
      // 会话目录和用户选的项目不是同一个时，项目仍可读可写
      if (claudeLike && projectDir && !args.includes(projectDir)) {
        args.push('--add-dir', projectDir);
      }

      // 出租接单：系统定义里说明自己是在给雇佣方干活，不能报本机路径
      if (confined) {
        args = applyRentalDefinition(args);
      }

      const result = await this._runAgentProcess(taskId, effectiveAgentId, launch.executable, args, {
        ...options,
        workingDir: runDir,
        onCleanup: orchestratorCleanup,
        stdinPayload,
        virtualAgentId: agentId,
        gatewayAgentId: effectiveAgentId,
        sessionKey: options.sessionKey || null,
      });

      // 停止竞态：进程退出时任务可能已被标为 cancelled，只补写 sessionId
      if (this._isTaskCancelled(taskId) || result?.cancelled) {
        this._persistCancelledTask(taskId, result?.cliSessionId, { emitEvent: false });
        this.taskMetaCache.delete(taskId);
        return;
      }

      // 更新任务结果（失败也不阻断完成事件，避免 UI 卡在 executing）
      try {
        db.prepare(`
          UPDATE agent_tasks 
          SET status = 'completed', result = ?, completed_at = ?
          WHERE id = ?
        `).run(JSON.stringify(result), Date.now(), taskId);
      } catch (e) {
        console.warn('[AgentExecutor] task complete persist failed:', e.message);
        try {
          db.prepare(`
            UPDATE agent_tasks SET status = 'completed', completed_at = ? WHERE id = ?
          `).run(Date.now(), taskId);
        } catch {}
      }

      this.emit('task:completed', {
        taskId,
        result: {
          success: result.success,
          summary: result.summary,
          stderr: result.stderr,
          files: result.files,
          stepCount: result.stepCount,
          cliSessionId: result.cliSessionId,
        },
        status: 'completed',
        ...this._taskEventMeta(taskId),
      });
      this.taskMetaCache.delete(taskId);

      // 记录成本
      await this._recordCost(taskId, effectiveAgentId, result);
    } catch (error) {
      if (this._isTaskCancelled(taskId)) {
        this.taskMetaCache.delete(taskId);
        return;
      }
      this._updateTaskStatus(taskId, 'failed', error.message);
      this.emit('task:failed', { taskId, error: error.message, ...this._taskEventMeta(taskId) });
      this.taskMetaCache.delete(taskId);
      throw error;
    }
  }

  _isTaskCancelled(taskId) {
    try {
      const row = this._getDb().prepare('SELECT status FROM agent_tasks WHERE id = ?').get(taskId);
      return row?.status === 'cancelled';
    } catch {
      return false;
    }
  }

  /**
   * 从 DB / 缓存读取任务路由元数据（进程结束后仍可用）
   */
  _taskEventMeta(taskId) {
    const cached = this.taskMetaCache.get(taskId);
    const running = this.runningTasks.get(taskId);
    try {
      const db = localStats.getDb();
      if (db) {
        const row = db.prepare('SELECT agent_id, context FROM agent_tasks WHERE id = ?').get(taskId);
        let parentTaskId = cached?.parentTaskId || running?.parent_task_id || null;
        let sessionKey = cached?.sessionKey || running?.session_key || null;
        let sessionInstanceId = cached?.sessionInstanceId || running?.session_instance_id || null;
        try {
          const ctx = row?.context ? JSON.parse(row.context) : {};
          parentTaskId = parentTaskId || ctx.parentTaskId || null;
          sessionKey = sessionKey || ctx.sessionKey || null;
          sessionInstanceId = sessionInstanceId || ctx.sessionInstanceId || null;
        } catch {}
        return {
          agentId: row?.agent_id || cached?.agentId || running?.agent_id || null,
          parentTaskId,
          sessionKey,
          sessionInstanceId,
        };
      }
    } catch {}
    return {
      agentId: cached?.agentId || running?.agent_id || null,
      parentTaskId: cached?.parentTaskId || running?.parent_task_id || null,
      sessionKey: cached?.sessionKey || running?.session_key || null,
      sessionInstanceId: cached?.sessionInstanceId || running?.session_instance_id || null,
    };
  }

  /** 向前端广播任务终态（子 Agent 派发完成兜底） */
  _notifyTaskTerminal(taskId, status) {
    const meta = this._taskEventMeta(taskId);
    const payload = {
      taskId,
      agentId: status?.agent_id || meta.agentId,
      sessionKey: meta.sessionKey,
      sessionInstanceId: meta.sessionInstanceId,
      parentTaskId: meta.parentTaskId,
      result: status?.result || null,
      error: status?.error || null,
    };
    if (status?.status === 'completed') {
      this.emit('task:completed', payload);
    } else if (status?.status === 'failed') {
      this.emit('task:failed', payload);
    } else if (status?.status === 'cancelled') {
      this.emit('task:cancelled', payload);
    }
    this.taskMetaCache.delete(taskId);
  }

  /**
   * 启动 Agent 子进程并收集输出
   */
  async _runAgentProcess(taskId, agentId, executable, args, options) {
    const {
      workingDir = process.cwd(),
      onCleanup,
      virtualAgentId,
      gatewayAgentId = agentId,
      parentTaskId = null,
      sessionKey = null,
      sessionInstanceId = null,
      stdinPayload = null,
    } = options;

    const cliCfg = AGENT_CLI[gatewayAgentId] || {};
    // Cursor 等直连账号：不注入网关、不告警「未找到工具配置」
    const useGateway = cliCfg.gatewayInject !== false;
    // 已纳管的 Pi 若还没写过密钥，这里补上，避免一启动就因自带模型没有 API key 退出
    if (useGateway && (gatewayAgentId === 'pi' || gatewayAgentId === 'omo' || gatewayAgentId === 'prime' || gatewayAgentId === 'omp')) {
      try { await require('./app-config-write').ensurePiFamilyAuth(gatewayAgentId); }
      catch (e) { console.warn('[AgentExecutor] Pi 网关密钥补写失败:', e.message); }
    }
    let spawnEnv = useGateway && agentLinker
      ? agentLinker.buildSpawnEnv(gatewayAgentId, process.env)
      : { ...process.env };
    const spawnDiag = useGateway && agentLinker
      ? agentLinker.diagnoseGatewaySpawn(gatewayAgentId, process.env)
      : {
        toolId: gatewayAgentId,
        will_use_official_api: false,
        skip_reasons: ['direct_auth'],
      };

    // Cursor：解密 IDE 会话并共享给 CLI；失败时再依赖 agent login / CURSOR_API_KEY
    if (gatewayAgentId === 'cursor') {
      try {
        const { buildCursorSpawnEnv } = require('./cursor-ide-auth');
        const auth = buildCursorSpawnEnv(spawnEnv);
        spawnEnv = auth.env;
        if (auth.injected) {
          console.log('[AgentExecutor] Cursor 已共享 IDE 登录', auth.email || '(no email)', auth.reason);
        } else if (auth.reason === 'ide_token_not_shareable') {
          console.warn('[AgentExecutor] Cursor IDE 已登录但无法解密/共享给 CLI', auth.email || '');
        } else {
          console.warn('[AgentExecutor] 未共享 IDE 登录，将依赖 agent login / CURSOR_API_KEY', auth.reason);
        }
      } catch (e) {
        console.warn('[AgentExecutor] Cursor IDE 登录共享失败:', e.message);
      }
    }

    try {
      require('./api-retry-trace').traceAgentSpawnEnv({
        taskId,
        agentId: gatewayAgentId,
        ...spawnDiag,
      });
    } catch { /* ignore */ }
    if (useGateway && spawnDiag.will_use_official_api) {
      console.warn('[AgentExecutor] spawn 未注入网关 URL，CLI 可能直连官方 API', spawnDiag.skip_reasons);
    }

    return new Promise((resolve, reject) => {
      const resolvedCwd = safeAgentCwd(workingDir);
      if (!dirIsSpawnable(resolvedCwd)) {
        reject(new Error(`工作目录不可用: ${workingDir || resolvedCwd}`));
        return;
      }
      spawnEnv = sanitizeAgentSpawnEnv(spawnEnv, resolvedCwd);

      // 社区接单只能动自己的工作目录。沙箱挡目录外的读写，CLI 仍不弹确认框
      let command = executable;
      let commandArgs = args;
      let releaseSandbox = () => {};
      try {
        const { isContributeSessionKey } = require('./contribute-session');
        const confine = options.clientId === 'contribute' || isContributeSessionKey(options.sessionKey);
        if (confine) {
          // 会话目录太长。Claude 的临时路径超过 44 字节就会去打开共用的 claude-<uid>，沙箱会拒绝。
          const scratch = require('./workspace-sandbox').sessionTempDir(resolvedCwd);
          try { fs.mkdirSync(scratch, { recursive: true, mode: 0o700 }); } catch { /* 沙箱里再试 */ }
          spawnEnv.TMPDIR = scratch;
          spawnEnv.TMP = scratch;
          spawnEnv.TEMP = scratch;
          spawnEnv.CLAUDE_CODE_TMPDIR = scratch;
          const wrapped = require('./workspace-sandbox').wrapConfinedSpawn({
            executable,
            args,
            workingDir: resolvedCwd,
            env: spawnEnv,
          });
          if (wrapped) {
            command = wrapped.command;
            commandArgs = wrapped.args;
            releaseSandbox = wrapped.cleanup;
          }
        }
      } catch (e) {
        reject(e);
        return;
      }

      const proc = spawn(command, commandArgs, {
        cwd: resolvedCwd,
        env: spawnEnv,
        shell: process.platform === 'win32',
        // Unix：独立进程组，停止时可一并杀掉 MCP 子进程
        detached: process.platform !== 'win32',
        // 多模态附图：stdin 写入 stream-json user message
        stdio: [stdinPayload ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      if (process.platform !== 'win32' && proc.pid) {
        try { proc.unref(); } catch {}
      }

      if (stdinPayload && proc.stdin) {
        try {
          proc.stdin.write(stdinPayload);
          proc.stdin.end();
        } catch (e) {
          console.warn('[AgentExecutor] stdin write failed:', e.message);
        }
      }

      let stdout = '';
      let stderr = '';
      let stepCounter = 0;
      let outLineBuf = '';
      let errLineBuf = '';

      this.runningTasks.set(taskId, {
        process: proc,
        agent_id: virtualAgentId || agentId,
        parent_task_id: parentTaskId,
        gateway_agent_id: gatewayAgentId,
        session_key: sessionKey,
        session_instance_id: sessionInstanceId,
        spawn_diag: spawnDiag,
      });
      this.taskMetaCache.set(taskId, {
        agentId: virtualAgentId || agentId,
        sessionKey,
        parentTaskId,
        sessionInstanceId,
      });

      // 进程一启动就给 UI 一条系统事件,避免首包前纯黑盒
      this._emitSingleStep(taskId, stepCounter++, {
        stepType: 'system_event',
        content: `已启动 ${AGENT_CLI[gatewayAgentId]?.name || gatewayAgentId}，等待模型流式输出…`,
        system_subtype: 'process_started',
      }, gatewayAgentId);

      const cleanup = () => {
        try { releaseSandbox(); } catch { /* 沙箱描述文件已清 */ }
        if (typeof onCleanup === 'function') {
          try { onCleanup(); } catch {}
        }
      };

      const syncOutput = !!(AGENT_CLI[gatewayAgentId]?.syncOutput);

      const flushLines = (buf, chunk, stream = 'stdout') => {
        const combined = buf + chunk;
        const lines = combined.split('\n');
        const rest = lines.pop() ?? '';
        if (!syncOutput) {
          for (const line of lines) {
            if (!line.trim()) continue;
            this._parseAndEmitSteps(taskId, line, stepCounter++, gatewayAgentId, stream);
            const running = this.runningTasks.get(taskId);
            if (running && !running.cli_session_id) {
              const sid = normalizeCliSessionId(extractCliSessionId(`${line}\n`, gatewayAgentId));
              if (sid) {
                running.cli_session_id = sid;
                // 尽早通知前端，停止时也能 --resume
                this.emit('task:cliSession', {
                  taskId,
                  cliSessionId: sid,
                  ...this._taskEventMeta(taskId),
                });
              }
            }
          }
        }
        return rest;
      };

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        outLineBuf = flushLines(outLineBuf, chunk, 'stdout');
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        errLineBuf = flushLines(errLineBuf, chunk, 'stderr');
      });

      proc.on('close', (code, signal) => {
        try {
          if (!syncOutput) {
            if (outLineBuf.trim()) {
              this._parseAndEmitSteps(taskId, outLineBuf, stepCounter++, gatewayAgentId, 'stdout');
            }
            if (errLineBuf.trim()) {
              this._parseAndEmitSteps(taskId, errLineBuf, stepCounter++, gatewayAgentId, 'stderr');
            }
          } else {
            const parsed = parseClaudeSyncStdout(stdout);
            if (parsed.sessionId) {
              const running = this.runningTasks.get(taskId);
              if (running) running.cli_session_id = parsed.sessionId;
            }
            stepCounter = this._emitParsedSteps(taskId, stepCounter, parsed.steps, gatewayAgentId);
          }

          const running = this.runningTasks.get(taskId);
          const cliSid = normalizeCliSessionId(
            running?.cli_session_id || extractCliSessionId(stdout, gatewayAgentId),
          );
          this.runningTasks.delete(taskId);
          this._clearTaskStreamState(taskId);
          cleanup();

          // 用户已停止：勿 reject 成 failed，保留 session 供续接
          if (this._isTaskCancelled(taskId)) {
            resolve({
              success: false,
              cancelled: true,
              output: stdout,
              summary: summarizeAgentStdout(stdout, gatewayAgentId),
              stderr,
              files: [],
              stepCount: stepCounter,
              cliSessionId: cliSid,
            });
            return;
          }

          const execFail = detectAgentExecutionFailure(stdout);
          if (code === 0 && !execFail) {
            try {
              const modifiedFiles = this._parseModifiedFiles(stdout);
              this._recordModifiedFiles(taskId, modifiedFiles);
            } catch (e) {
              console.warn('[AgentExecutor] recordModifiedFiles failed:', e.message);
            }

            resolve({
              success: true,
              output: stdout,
              summary: summarizeAgentStdout(stdout, gatewayAgentId),
              stderr,
              files: [],
              stepCount: stepCounter,
              cliSessionId: cliSid,
            });
          } else {
            const errText = execFail || formatAgentExitError(stderr, stdout, code, gatewayAgentId, signal);
            reject(new Error(errText));
          }
        } catch (err) {
          this.runningTasks.delete(taskId);
          this._clearTaskStreamState(taskId);
          cleanup();
          reject(err);
        }
      });

      proc.on('error', (error) => {
        this.runningTasks.delete(taskId);
        this._clearTaskStreamState(taskId);
        cleanup();
        reject(new Error(`Failed to start agent: ${error.message}`));
      });
    });
  }

  /** 清理任务级 stream-json 块状态 */
  _clearTaskStreamState(taskId) {
    this._streamState.delete(taskId);
  }

  /** 将已解析步骤广播到 UI（同步 JSON 模式） */
  _emitParsedSteps(taskId, startNumber, steps, gatewayAgentId) {
    let n = startNumber;
    for (const step of steps || []) {
      this._emitSingleStep(taskId, n++, step, gatewayAgentId);
    }
    return n;
  }

  /**
   * 解析并发送实时步骤
   */
  _parseAndEmitSteps(taskId, line, stepNumber, agentIdForParse, stream = 'stdout') {
    const running = this.runningTasks.get(taskId);
    const parseAgent = agentIdForParse || running?.gateway_agent_id || running?.agent_id;
    if (!this._streamState.has(taskId)) {
      this._streamState.set(taskId, {
        blockTypes: new Map(),
        blockTexts: new Map(),
        streaming: false,
        messageId: null,
        lastThinking: '',
      });
    }
    const steps = parseAgentOutputLine(line, parseAgent, this._streamState.get(taskId), { stream });
    return this._emitParsedSteps(taskId, stepNumber, steps, parseAgent);
  }

  _emitSingleStep(taskId, stepNumber, step, gatewayAgentId) {
    try {
      const running = this.runningTasks.get(taskId);
      const stepType = step.stepType || 'output';
      let content = step.content || '';
      // tool_call / tool_result 即使内容为空也要发出（图片 Read 等），否则 UI 无法配对
      // output / thinking 的纯换行不能丢，否则 Markdown 标题、表格、列表会粘成一行
      if (!content.trim()) {
        if (stepType === 'tool_result') content = step.is_error ? '(失败)' : '(无输出)';
        else if (stepType === 'tool_call') content = '(无参数)';
        else if (stepType === 'output' || stepType === 'thinking') {
          if (!content) return;
        } else if (stepType !== 'system_event') return;
      }

      if (stepType === 'system_event' && step.system_subtype === 'api_retry') {
        try {
          const localGateway = require('./local-gateway');
          require('./api-retry-trace').traceCliApiRetry({
            taskId,
            agentId: gatewayAgentId,
            rawLine: '',
            step,
            spawn_diag: running?.spawn_diag || null,
            getRouteLog: () => localGateway.getLog(),
          });
        } catch (e) {
          console.warn('[AgentExecutor] api_retry trace failed:', e.message);
        }
      }

      let db;
      try { db = this._getDb(); } catch { db = null; }

      const stepId = `step_${Date.now()}_${nanoid(8)}`;
      if (db) {
        try {
          db.prepare(`
            INSERT INTO agent_task_steps
            (id, task_id, step_number, step_type, content, tool_name, tool_use_id, is_error, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            stepId,
            taskId,
            stepNumber,
            stepType,
            content,
            step.tool_name || null,
            step.tool_use_id || null,
            step.is_error ? 1 : 0,
            step.is_error ? 'error' : 'completed',
            Date.now(),
          );
        } catch (e) {
          // 旧库尚未迁移列时回退（避免步骤整段丢失）
          try {
            db.prepare(`
              INSERT INTO agent_task_steps
              (id, task_id, step_number, step_type, content, tool_name, status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
            `).run(stepId, taskId, stepNumber, stepType, content, step.tool_name || null, Date.now());
          } catch (e2) {
            console.warn('[AgentExecutor] step persist failed:', e2.message || e.message);
          }
        }
      }

      this.emit('task:step', {
        taskId,
        stepNumber,
        stepType,
        content,
        tool_name: step.tool_name || null,
        tool_use_id: step.tool_use_id || null,
        system_subtype: step.system_subtype || null,
        is_delta: !!step.is_delta,
        is_snapshot: !!step.is_snapshot,
        is_error: !!step.is_error,
        images: Array.isArray(step.images) && step.images.length ? step.images : undefined,
        attempt: step.attempt,
        max_retries: step.max_retries,
        retry_delay_ms: step.retry_delay_ms,
        error_status: step.error_status,
        timestamp: Date.now(),
        agentId: running?.agent_id || this.taskMetaCache.get(taskId)?.agentId || null,
        parentTaskId: running?.parent_task_id || this.taskMetaCache.get(taskId)?.parentTaskId || null,
        sessionKey: running?.session_key || this.taskMetaCache.get(taskId)?.sessionKey || null,
        sessionInstanceId: running?.session_instance_id || this.taskMetaCache.get(taskId)?.sessionInstanceId || null,
      });
    } catch (e) {
      console.warn('[AgentExecutor] emit step failed:', e.message);
    }
  }

  /**
   * 检测步骤类型（保留供测试 / 回退）
   */
  _detectStepType(line) {
    if (/thinking|analyzing|reasoning/i.test(line)) return 'thinking';
    if (/tool use|using tool|calling tool|tool:|^\s*⎿/i.test(line)) return 'tool_call';
    if (/edit:|modif|wrote|created|updated file/i.test(line)) return 'code_edit';
    if (/^\$\s|run:|execut|bash:|shell:/i.test(line)) return 'terminal';
    return 'output';
  }

  /** 解析修改的文件（stream-json tool_use + 纯文本 fallback） */
  _parseModifiedFiles(output) {
    return extractModifiedFiles(output);
  }

  /**
   * 记录修改的文件
   */
  _recordModifiedFiles(taskId, files) {
    const db = this._getDb();
    
    for (const file of files) {
      const fileId = `file_${Date.now()}_${nanoid(8)}`;
      db.prepare(`
        INSERT INTO agent_modified_files (id, task_id, file_path, operation, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(fileId, taskId, file.path, file.operation, Date.now());
    }
  }

  /**
   * 终止子进程（先 SIGTERM，超时后 SIGKILL）
   */
  _killProcess(proc) {
    if (!proc || proc.killed) return;
    try {
      if (process.platform !== 'win32' && proc.pid) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch { proc.kill('SIGTERM'); }
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      try { proc.kill('SIGKILL'); } catch {}
    }
  }

  /**
   * 取消时写入已解析的 CLI session，便于停止后续接上下文
   * 已是 cancelled 时仍可补写 sessionId（进程 close 竞态）
   */
  _persistCancelledTask(taskId, cliSessionId, { emitEvent = true } = {}) {
    const db = this._getDb();
    const row = db.prepare('SELECT status, result FROM agent_tasks WHERE id = ?').get(taskId);
    if (!row) return null;
    if (!['pending', 'running', 'cancelled'].includes(row.status)) return null;

    let resultObj = {};
    try {
      resultObj = row.result ? JSON.parse(row.result) : {};
    } catch {
      resultObj = {};
    }
    const sid = normalizeCliSessionId(cliSessionId || resultObj.cliSessionId);
    if (sid) resultObj.cliSessionId = sid;
    const wasRunning = ['pending', 'running'].includes(row.status);

    db.prepare(`
      UPDATE agent_tasks
      SET status = 'cancelled', result = ?, completed_at = COALESCE(completed_at, ?)
      WHERE id = ?
    `).run(JSON.stringify(resultObj), Date.now(), taskId);

    const payload = {
      taskId,
      result: { ...resultObj, cliSessionId: sid || null },
      ...this._taskEventMeta(taskId),
    };
    if (emitEvent && wasRunning) this.emit('task:cancelled', payload);
    return payload;
  }

  /**
   * 取消单个任务（进程已退出时也更新 DB 状态）
   */
  async cancel(taskId) {
    const task = this.runningTasks.get(taskId);
    const cliSid = normalizeCliSessionId(task?.cli_session_id);
    if (task?.process) {
      this._killProcess(task.process);
      this.runningTasks.delete(taskId);
      this._clearTaskStreamState(taskId);
    }

    const payload = this._persistCancelledTask(taskId, cliSid);
    if (payload) return { success: true, cliSessionId: payload.result?.cliSessionId || null };

    if (task) return { success: true, cliSessionId: cliSid || null };
    return { success: false, error: 'Task not found or already finished' };
  }

  /** 取消所有进行中的 Agent 任务（Debug 停止按钮） */
  async cancelAllActive() {
    const pending = [];
    for (const [taskId, task] of this.runningTasks.entries()) {
      pending.push({ taskId, cliSid: normalizeCliSessionId(task?.cli_session_id) });
      if (task?.process) this._killProcess(task.process);
      this.runningTasks.delete(taskId);
      this._clearTaskStreamState(taskId);
    }

    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id FROM agent_tasks WHERE status IN ('pending', 'running')
    `).all();
    const byId = new Map(pending.map(p => [p.taskId, p.cliSid]));
    let lastSid = null;
    for (const row of rows) {
      const payload = this._persistCancelledTask(row.id, byId.get(row.id));
      if (payload?.result?.cliSessionId) lastSid = payload.result.cliSessionId;
    }
    return { success: true, count: rows.length, cliSessionId: lastSid };
  }

  /**
   * 列出某 Agent 最近任务（切换标签页恢复历史）
   */
  async listRecentTasksForAgent(agentId, limit = 3) {
    const canonicalId = await this.resolveAgentId(agentId);
    const db = this._getDb();
    // 多取一些再过滤社区接单，避免本机标签被远程任务占满
    const fetchLimit = Math.max(limit * 8, 24);
    const rows = db.prepare(`
      SELECT id FROM agent_tasks
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(canonicalId, fetchLimit);

    const { isContributeSessionKey } = require('./contribute-session');
    const tasks = [];
    for (const row of rows) {
      try {
        const status = await this.getTaskStatus(row.id);
        const ctx = status.context || {};
        if (ctx.clientId === 'contribute' || isContributeSessionKey(ctx.sessionKey)) continue;
        tasks.push(status);
        if (tasks.length >= limit) break;
      } catch {
        // 忽略损坏记录
      }
    }
    return tasks;
  }

  /**
   * 列出进行中的任务（刷新页面只恢复界面，不取消进程）
   */
  async listActiveTasks() {
    const db = this._getDb();
    const rows = db.prepare(`
      SELECT id FROM agent_tasks
      WHERE status IN ('pending', 'running')
      ORDER BY created_at DESC
      LIMIT 40
    `).all();

    const { isContributeSessionKey } = require('./contribute-session');
    const tasks = [];
    for (const row of rows) {
      try {
        const status = await this.getTaskStatus(row.id);
        const ctx = status.context || {};
        // 社区接单不进入本机游乐场恢复列表
        if (ctx.clientId === 'contribute' || isContributeSessionKey(ctx.sessionKey)) continue;
        tasks.push(status);
        if (tasks.length >= 20) break;
      } catch {
        // 忽略已删除或损坏记录
      }
    }
    return tasks;
  }

  /**
   * 获取任务状态
   */
  /** 今日智能体任务（0 点起）。和模型补全的请求数分开计。 */
  todayTaskStats() {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const empty = { tasks: 0, running: 0, failed: 0, avg_duration_ms: null };
    let rows = [];
    try {
      rows = this._getDb().prepare(
        'SELECT agent_id, status, created_at, completed_at FROM agent_tasks WHERE created_at >= ?',
      ).all(start.getTime());
    } catch {
      return { ...empty, by_agent: {} };
    }
    const sum = (list) => {
      const done = list.filter(r => r.status === 'completed' && r.completed_at && r.created_at);
      return {
        tasks: list.length,
        ok: done.length,
        running: list.filter(r => r.status === 'pending' || r.status === 'running').length,
        failed: list.filter(r => r.status === 'failed' || r.status === 'cancelled').length,
        avg_duration_ms: done.length
          ? Math.round(done.reduce((s, r) => s + (r.completed_at - r.created_at), 0) / done.length)
          : null,
      };
    };
    // 应用列表里每个智能体一行「今天几个任务、成功几个、平均多久」
    const groups = {};
    for (const r of rows) (groups[r.agent_id] = groups[r.agent_id] || []).push(r);
    const byAgent = {};
    for (const [id, list] of Object.entries(groups)) byAgent[id] = sum(list);
    const all = sum(rows);
    return {
      tasks: all.tasks,
      running: all.running,
      failed: all.failed,
      avg_duration_ms: all.avg_duration_ms,
      by_agent: byAgent,
    };
  }

  async getTaskStatus(taskId) {
    const db = this._getDb();
    const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId);

    if (!task) {
      throw new Error('Task not found');
    }

    const steps = db.prepare(`
      SELECT * FROM agent_task_steps
      WHERE task_id = ?
      ORDER BY step_number
    `).all(taskId);

    const files = db.prepare(`
      SELECT * FROM agent_modified_files
      WHERE task_id = ?
    `).all(taskId);

    return {
      ...task,
      context: task.context ? JSON.parse(task.context) : {},
      result: task.result ? JSON.parse(task.result) : null,
      steps,
      files,
    };
  }

  /**
   * 更新任务状态
   */
  _updateTaskStatus(taskId, status, error = null) {
    const db = this._getDb();
    // 已取消的任务禁止被失败/完成覆盖（否则丢失 cliSessionId）
    if (status !== 'cancelled') {
      try {
        const row = db.prepare('SELECT status FROM agent_tasks WHERE id = ?').get(taskId);
        if (row?.status === 'cancelled') return;
      } catch { /* ignore */ }
    }
    db.prepare(`
      UPDATE agent_tasks
      SET status = ?, error = ?, completed_at = ?
      WHERE id = ?
    `).run(status, error, Date.now(), taskId);
  }

  /**
   * 记录成本
   */
  async _recordCost(taskId, agentId, result) {
    // TODO: 从 result 中提取 token 和 cost 信息
    // 目前简化处理
    const db = this._getDb();
    
    if (result.tokens || result.cost) {
      try {
        localStats.record({
          timestamp: Date.now(),
          model: `agent:${agentId}`,
          inputTokens: result.tokens?.input || 0,
          outputTokens: result.tokens?.output || 0,
          cost: result.cost || 0,
          agentId: agentId,
        });
      } catch (error) {
        console.error('[AgentExecutor] Failed to record cost:', error);
      }
    }
  }
}

module.exports = new AgentExecutor();
module.exports.AGENT_CLI = AGENT_CLI;
module.exports.canonicalBuiltinAgentId = canonicalBuiltinAgentId;
module.exports.invalidateAgentListCache = invalidateAgentListCache;
module.exports.buildClaudeCodeArgs = buildClaudeCodeArgs;
module.exports.buildClaudeContinueArgs = buildClaudeContinueArgs;
module.exports.buildClaudeStreamFlags = buildClaudeStreamFlags;
module.exports.buildCursorAgentArgs = buildCursorAgentArgs;
module.exports.buildKimiCodeArgs = buildKimiCodeArgs;
module.exports.materializeAttachedImages = materializeAttachedImages;
module.exports.materializeAttachedFiles = materializeAttachedFiles;
module.exports.buildClaudeMultimodalStdin = buildClaudeMultimodalStdin;
module.exports.ensureClaudeMultimodalArgs = ensureClaudeMultimodalArgs;
module.exports.detectImageMime = detectImageMime;
module.exports.safeAgentCwd = safeAgentCwd;
module.exports.dirIsSpawnable = dirIsSpawnable;
module.exports.sanitizeAgentSpawnEnv = sanitizeAgentSpawnEnv;
module.exports.isUnsafeSpawnCwd = isUnsafeSpawnCwd;
