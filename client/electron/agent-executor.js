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
  projectedRuntimeIds,
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

const TERMINAL = ['completed', 'failed', 'cancelled'];
/** 远端响应状态 → 本机任务状态 */
/** 连续这么久连不上执行它的设备，就标失联（设备回来再补） */
const MESH_LOST_AFTER_MS = 30 * 60 * 1000;
/** 跟了这么久还没做完，也先停下标失联 */
const MESH_TRACK_MAX_MS = 48 * 3600 * 1000;
const MESH_STATUS = { in_progress: 'running', queued: 'pending', completed: 'completed', failed: 'failed', cancelled: 'cancelled' };
function isMeshTarget(id) { return String(id || '').trim().startsWith('mine:'); }
function isMeshTaskId(id) { return String(id || '').startsWith('mesh:'); }
function safeJson(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }
/** 远端响应里的正文 */
function meshOutputText(resp) {
  const parts = [];
  for (const item of Array.isArray(resp?.output) ? resp.output : []) {
    for (const c of Array.isArray(item?.content) ? item.content : []) {
      if (typeof c?.text === 'string') parts.push(c.text);
    }
  }
  return parts.join('\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 子任务还要不要等。
 * 停住超过 idleMs，或从开始算超过 hardMs，就不再等。
 * 中间一直有新进展时，由调用方把 lastActivity 往后推。
 */
function taskWaitAlive({ now, start, lastActivity, idleMs, hardMs }) {
  if (now - start >= hardMs) return false;
  if (now - lastActivity >= idleMs) return false;
  return true;
}

/** 这一轮有没有新进展：新步骤、步骤内容变长、或已经有输出 */
function taskActivityMark(status) {
  const steps = Array.isArray(status?.steps) ? status.steps : [];
  const last = steps[steps.length - 1];
  const tail = last ? String(last.content || '').length : 0;
  const out = String(status?.result?.output || status?.result?.summary || '').length;
  const remote = status?.result?.remoteSteps ?? '';
  return `${status?.status || ''}|${steps.length}|${last?.id || ''}|${tail}|${out}|${remote}`;
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
    // 应用重启后接回派给外部智能体、还没做完的任务
    setImmediate(() => this._watchExternalResults());
    this.runningTasks = new Map(); // taskId → { process, agent_id }
    // 任务元数据缓存：进程结束后仍可用于 IPC 事件路由
    this.taskMetaCache = new Map(); // taskId → { agentId, sessionKey, parentTaskId }
    /** stream-json content_block index → type（thinking / text） */
    this._streamState = new Map(); // taskId → { blockTypes: Map }
    /** 设备网络：派到其他设备的任务，本机有一行镜像，由轮询跟着远端更新 */
    this._meshPollers = new Map(); // taskId → { stop }
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
    // 外部智能体：按 id 原样执行（是否允许接任务由 external-agents 判断）
    if (require('./external-agents').isExternalId(raw)) return raw;

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
        // 雇佣名单、外部智能体可能刚变：缓存里刷新这两段
        const base = AGENT_LIST_CACHE.agents.filter((a) => a.type !== 'community' && a.type !== 'external');
        let externals = [];
        try { externals = require('./external-agents').listForAgents(); } catch { /* 外部智能体不可用 */ }
        return [...base, ...hiredEntries(), ...externals];
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
      // 外部智能体（Muse、GrokBot 等）：自己注册进来、用户允许过的，来网关取任务
      ...(() => { try { return require('./external-agents').listForAgents(); } catch { return []; } })(),
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
        // 它投射过、本机能用的应用：多于一个时网关页让用户选默认在哪跑
        projectedRuntimes: projectedRuntimeIds(resource.projections || [], availableCliIds),
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
      // 智能管家的回复要边生成边显示，所以打开 partial messages
      const launch = buildAssistantLaunch(st.runtime, guardianChat.systemText(), '', { includePartial: true });
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
    // mine:<智能体>[@设备]：交给我的某台设备。选到本机就照常往下走
    if (isMeshTarget(agentId)) {
      if (options.previousTaskId) this._lockSession(options.previousTaskId);
      const r = await this._submitMeshTask(agentId, prompt, options);
      if (!r.local) return { taskId: r.taskId, device: r.device };
      agentId = r.local;
    }
    const db = this._getDb();
    const canonicalId = await this.resolveAgentId(agentId);
    // 同一个会话同时只能有一轮：上一轮还在跑，或者已经有人在接着它做，就不再开（E4-5）
    if (options.previousTaskId) this._lockSession(options.previousTaskId);
    // 接着上一轮（previousTaskId 是本机任务号）：同一个 CLI 会话续上
    if (options.previousTaskId && !options.cliSessionId && !isMeshTaskId(options.previousTaskId)) {
      try {
        const prev = await this.getTaskStatus(options.previousTaskId);
        if (prev?.result?.cliSessionId) {
          options = { ...options, continueSession: true, cliSessionId: prev.result.cliSessionId };
        }
      } catch { /* 找不到上一轮就当新任务 */ }
    }
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
        previousTaskId: options.previousTaskId || null,
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
    const { isCommunityAgentId } = require('./hired-community-agents');
    if (!isMeshTarget(agentId)) {
      const canonicalId = await this.resolveAgentId(agentId);
      // 社区雇佣武将：远程派发（对方本机执行，不下载正文）
      if (isCommunityAgentId(canonicalId)) {
        return this._dispatchCommunityAndWait(canonicalId, prompt, options);
      }
    }
    const started = await this._startDispatch(agentId, prompt, options);
    return this._waitDispatch(started, options);
  }

  /**
   * 派发子任务，不等结果（MCP tb_dispatch_agent background=true）。
   * 后台照样等它做完，好把「派发卡片」收尾；调用方用 getTaskStatus / waitTasks 查。
   * @returns {Promise<{ taskId: string, agentId: string, device?: string }>}
   */
  async dispatch(agentId, prompt, options = {}) {
    // 社区智能体也一样：execute 会建一行任务、在对方设备上跑（_runCommunityTaskForExecute），这里只是不等
    const started = await this._startDispatch(agentId, prompt, options);
    this._waitDispatch(started, options).catch((e) => {
      console.warn(`[AgentExecutor] 后台子任务 ${started.taskId}：${e.message}`);
    });
    return { taskId: started.taskId, agentId: started.canonicalId, device: started.device };
  }

  /** 建子任务、发「已派发」事件。本机智能体、mine: 目标都走这里 */
  async _startDispatch(agentId, prompt, options = {}) {
    const parentTaskId = options.parentTaskId;
    const mesh = isMeshTarget(agentId);
    const canonicalId = mesh ? String(agentId).trim() : await this.resolveAgentId(agentId);

    // 召唤专业智能体：记命中并弹息票（与 tb_get_resource 点将对齐）
    if (!mesh && isAssistantAgentId(canonicalId) && !require('./guardian/chat').isGuardianAgent(canonicalId)) {
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

    const { taskId, device } = await this.execute(canonicalId, prompt, {
      ...options,
      mode: options.mode || 'worker',
      sessionKey,
      sessionInstanceId,
      parentTaskId,
    });

    // 进程启动后马上听步骤。stdout 在下一个事件循环才到，这里还赶得上第一个字
    let stepListener = null;
    if (typeof options.onStep === 'function') {
      stepListener = (evt) => {
        if (!evt || evt.taskId !== taskId) return;
        try { options.onStep(evt); } catch { /* 流式回调失败不影响任务 */ }
      };
      this.on('task:step', stepListener);
    }

    // 通知前端：子任务已派发，便于当前窗口展示派发卡片
    this.emit('task:dispatched', {
      parentTaskId,
      childTaskId: taskId,
      agentId: canonicalId,
      device: device || undefined,
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
        device: device || undefined,
        content: prompt,
        timestamp: Date.now(),
      });
    }
    return { taskId, canonicalId, agentId, parentTaskId, device, stepListener };
  }

  /** 等子任务到终态；空闲或总时长超时就取消 */
  async _waitDispatch({ taskId, canonicalId, agentId, parentTaskId, stepListener }, options = {}) {
    // 空闲超时：一直有新步骤就续上，避免查到一半被墙钟掐掉。停住超过 idleMs，或总时长到 hardMs，才取消。
    const idleMs = options.timeoutMs || 10 * 60 * 1000;
    const hardMs = options.hardTimeoutMs || idleMs * 3;
    const start = Date.now();
    let lastActivity = start;
    let lastMark = '';

    try {
      while (taskWaitAlive({ now: Date.now(), start, lastActivity, idleMs, hardMs })) {
        const status = await this.getTaskStatus(taskId);
        const mark = taskActivityMark(status);
        if (mark !== lastMark) {
          lastMark = mark;
          lastActivity = Date.now();
        }
        if (TERMINAL.includes(status.status)) {
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
        if (typeof options.onProgress === 'function') {
          try { options.onProgress(status); } catch { /* 进度写失败不影响任务本身 */ }
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
    } finally {
      if (stepListener) this.off('task:step', stepListener);
    }
  }

  /**
   * 等几个任务：wait='any' 有一个到终态就返回，'all' 全部到终态，'none' 立刻返回。
   * @returns {Promise<Array<object>>} 和 ids 同序的任务状态（查不到的给 { id, status: 'not_found' }）
   */
  async waitTasks(ids = [], { wait = 'none', timeoutMs = 60 * 1000 } = {}) {
    const list = [...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 50);
    const read = async () => Promise.all(list.map(async (id) => {
      try { return await this.getTaskStatus(id); }
      catch { return { id, status: 'not_found' }; }
    }));
    const deadline = Date.now() + Math.max(0, Math.min(Number(timeoutMs) || 0, 10 * 60 * 1000));
    for (;;) {
      const all = await read();
      const done = all.filter((t) => TERMINAL.includes(t.status) || t.status === 'not_found');
      if (wait === 'none' || !list.length) return all;
      if (wait === 'any' && done.length > 0) return all;
      if (wait === 'all' && done.length === all.length) return all;
      if (Date.now() >= deadline) return all;
      await sleep(400);
    }
  }

  // ── 会话锁 ─────────────────────────────────────────────────────────────────

  /** 续上一轮之前：上一轮还在跑、或者已经有一轮在接着它做 → 报「进行中」（409），免得两个进程同时续同一个会话 */
  _lockSession(prevId) {
    const db = this._getDb();
    const prev = db.prepare('SELECT status, context FROM agent_tasks WHERE id = ?').get(prevId);
    if (!prev) return;
    if (['pending', 'running'].includes(prev.status)) {
      throw Object.assign(new Error('上一轮还在进行中，等它结束再续'), { status: 409 });
    }
    const busy = db.prepare(`
      SELECT id FROM agent_tasks
      WHERE json_extract(context, '$.previousTaskId') = ? AND status IN ('pending', 'running')
      LIMIT 1
    `).get(prevId);
    if (busy) throw Object.assign(new Error(`已经有一轮在接着它做（${busy.id}），等它结束`), { status: 409 });
  }

  // ── 设备网络（mine: 目标、mesh: 任务号） ───────────────────────────────────

  /** 交给另一台设备；选到本机时返回 { local } */
  async _submitMeshTask(agentId, prompt, options = {}) {
    const glue = require('./mesh/glue');
    const metadata = {};
    if (options.workspace) metadata.workspace = options.workspace;
    // 带的图片、附件：登记成清单，那台设备开工前经设备通道拉过去（不走云存储）
    const inputs = await this._offerMeshInputs(options);
    if (inputs.length) {
      metadata.mesh_inputs = inputs;
      metadata.mesh_from = glue.selfDeviceId();
    }
    let prevMesh = isMeshTaskId(options.previousTaskId) ? options.previousTaskId : undefined;
    // 游乐场「接着聊」：同一个会话里上一轮派到其他设备的任务，就接着那台设备上的会话
    if (!prevMesh && options.continueSession) {
      try {
        const row = this._getDb().prepare(`
          SELECT id FROM agent_tasks
          WHERE id LIKE 'mesh:%' AND agent_id = ? AND json_extract(context, '$.sessionKey') = ?
          ORDER BY created_at DESC LIMIT 1
        `).get(String(agentId).trim(), options.sessionKey || String(agentId).trim());
        if (row?.id) prevMesh = row.id;
      } catch { /* 找不到就开新会话 */ }
    }
    const r = await glue.submitAgentTask({
      harnessId: agentId,
      input: prompt,
      metadata,
      previousResponseId: prevMesh,
      idempotencyKey: options.idempotencyKey,
      // 续上一轮时那台设备的会话已经在它自己的目录里，不再按本机目录映射
      localDir: prevMesh ? undefined : (options.workingDir || undefined),
    });
    if (r.local) return { local: r.local };
    this.trackMeshTask(r.id, {
      agentId: `mine:${r.target}@${r.device}`,
      device: r.device,
      prompt,
      parentTaskId: options.parentTaskId || null,
      sessionKey: options.sessionKey || String(agentId).trim(),
      sessionInstanceId: options.sessionInstanceId || null,
      workingDir: options.workingDir || null,
      mode: options.mode || 'direct',
      previousTaskId: options.previousTaskId || null,
      response: r.response,
    });
    // 在哪个工作区跑：写成任务的第一步，游乐场和 Trace 里都看得到
    if (r.workspaceNote) {
      try { this._emitSingleStep(r.id, -1, { stepType: 'system_event', content: r.workspaceNote }, null); } catch { /* 只是说明 */ }
    }
    return { taskId: r.id, device: r.device, workspaceNote: r.workspaceNote || '' };
  }

  /** 往任务结果里补几项（不动状态） */
  setTaskResultExtra(taskId, extra = {}) {
    const db = this._getDb();
    const row = db.prepare('SELECT result FROM agent_tasks WHERE id = ?').get(taskId);
    if (!row) return false;
    let prev = {};
    try { prev = row.result ? JSON.parse(row.result) : {}; } catch { prev = {}; }
    db.prepare('UPDATE agent_tasks SET result = ? WHERE id = ?').run(JSON.stringify({ ...prev, ...extra }), taskId);
    return true;
  }

  /**
   * 跑在别的设备上的任务做完了：产出文件 10MB 以内自动经设备通道拉回本机，大的列着等点了再拉。
   * 拉到的写进结果的 files（name、size、path），没拉的标 pending 或写原因。
   */
  async _pullMeshOutputs(taskId) {
    const files = require('./mesh/files');
    const glue = require('./mesh/glue');
    const parsed = glue.parseMeshTaskId(taskId);
    if (!parsed) return;
    const row = this._getDb().prepare('SELECT result FROM agent_tasks WHERE id = ?').get(taskId);
    let result = {};
    try { result = row?.result ? JSON.parse(row.result) : {}; } catch { result = {}; }
    const remote = Array.isArray(result.remoteFiles) ? result.remoteFiles : [];
    if (!remote.length) return;
    const have = new Map((result.files || []).map((f) => [f.token, f]));
    const out = [];
    for (const entry of remote) {
      const cur = have.get(entry.token) || { token: entry.token, name: entry.name, size: entry.size, rel: entry.rel || '' };
      if (!cur.path && Number(entry.size) <= files.AUTO_PULL_BYTES) {
        try {
          const got = await glue.pullFile({ deviceId: parsed.deviceId, entry, destDir: files.inboxDir(taskId) });
          cur.path = got.path; delete cur.error; delete cur.pending;
        } catch (e) { cur.error = e.message; }
      } else if (!cur.path) {
        cur.pending = true;   // 大文件：点了再拉
      }
      out.push(cur);
    }
    // 输出末尾写一段「产出文件」：游乐场、父任务、tb_task_status 拿到的结果里都能看到文件在哪
    const mb = (n) => `${(Number(n) / 1048576).toFixed(1)}MB`;
    const lines = out.map((f) => (f.path ? `- ${f.name} → ${f.path}`
      : f.pending ? `- ${f.name}（${mb(f.size)}，还在那台设备上，任务详情里点「下载到本机」）`
        : `- ${f.name}：没拉回来（${f.error || '原因不明'}）`));
    const note = `\n\n产出文件（从 ${glue.parseMeshTaskId(taskId)?.deviceId ? (result.device || '那台设备') : '那台设备'} 拉回本机）：\n${lines.join('\n')}`;
    const base = String(result.output || '').split('\n\n产出文件（')[0];
    this.setTaskResultExtra(taskId, { files: out, output: base + note, summary: base + note });
    return out;
  }

  /** 手动拉一个大的产出文件（界面上点「下载到本机」） */
  async pullMeshTaskFile(taskId, token) {
    const files = require('./mesh/files');
    const glue = require('./mesh/glue');
    const parsed = glue.parseMeshTaskId(taskId);
    if (!parsed) throw new Error('不是跑在其他设备上的任务');
    const row = this._getDb().prepare('SELECT result FROM agent_tasks WHERE id = ?').get(taskId);
    let result = {};
    try { result = row?.result ? JSON.parse(row.result) : {}; } catch { result = {}; }
    const entry = (result.remoteFiles || []).find((f) => f.token === token);
    if (!entry) throw new Error('没有这个文件');
    const got = await glue.pullFile({ deviceId: parsed.deviceId, entry, destDir: files.inboxDir(taskId) });
    const list = (result.files || []).map((f) => (f.token === token ? { ...f, path: got.path, pending: false, error: undefined } : f));
    this.setTaskResultExtra(taskId, { files: list });
    return { path: got.path, size: got.size };
  }

  /** 派到其他设备时带的图片、附件 → 登记成清单（mesh/files.js） */
  async _offerMeshInputs(options = {}) {
    const files = require('./mesh/files');
    const out = [];
    const items = [
      ...(Array.isArray(options.images) ? options.images.map((x, i) => ({ x, def: `image-${i + 1}` })) : []),
      ...(Array.isArray(options.files) ? options.files.map((x, i) => ({ x, def: `file-${i + 1}` })) : []),
    ];
    for (const { x, def } of items) {
      try {
        const dataUrl = typeof x === 'string' ? x : (x?.dataUrl || '');
        const name = (x && typeof x === 'object' && x.name) || def;
        if (dataUrl.startsWith('data:')) out.push(await files.offerDataUrl(dataUrl, name));
        else if (x && typeof x === 'object' && x.path && fs.existsSync(x.path)) out.push(await files.offerFile(x.path, { name }));
      } catch (e) {
        console.warn('[mesh] 附件登记失败：', e.message);
      }
    }
    return out;
  }

  /**
   * 在本机记下一个跑在别的设备上的任务，并跟着远端更新状态和结果。
   * 这样任务树（父子关系）、游乐场、getTaskStatus 都和本机任务一样用。
   */
  trackMeshTask(taskId, info = {}) {
    const db = this._getDb();
    const now = Date.now();
    db.prepare(`
      INSERT OR IGNORE INTO agent_tasks (id, agent_id, prompt, context, status, created_at, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?)
    `).run(
      taskId,
      info.agentId || 'mine:',
      String(info.prompt || ''),
      JSON.stringify({
        mesh: true,
        meshDevice: info.device || null,
        workingDir: info.workingDir || null,
        mode: info.mode || 'direct',
        parentTaskId: info.parentTaskId || null,
        sessionKey: info.sessionKey || info.agentId || null,
        sessionInstanceId: info.sessionInstanceId || null,
        previousTaskId: info.previousTaskId || null,
        callContext: 'owner',
      }),
      now,
      now,
    );
    this.taskMetaCache.set(taskId, {
      agentId: info.agentId,
      sessionKey: info.sessionKey || info.agentId,
      parentTaskId: info.parentTaskId || null,
      sessionInstanceId: info.sessionInstanceId || null,
      clientId: null,
    });
    if (info.response) this._applyMeshResponse(taskId, info.response);
    this._pollMeshTask(taskId);
  }

  /** 把远端的响应写进本机镜像行。返回是否到了终态 */
  _applyMeshResponse(taskId, resp) {
    if (!resp || resp.status === 'unreachable') return false;
    // 那台设备上的执行步骤：照本机步骤一样存下、推给游乐场（边做边看）
    if (Array.isArray(resp.steps)) {
      for (const st of resp.steps) {
        this._emitSingleStep(taskId, Number(st.step_number) || 0, {
          stepType: st.step_type || 'output', content: st.content || '', tool_name: st.tool_name || undefined,
          tool_use_id: st.tool_use_id || undefined, is_error: !!st.is_error,
        }, null);
      }
    }
    const status = MESH_STATUS[resp.status] || 'running';
    const text = meshOutputText(resp);
    const db = this._getDb();
    const row = db.prepare('SELECT status, result FROM agent_tasks WHERE id = ?').get(taskId);
    if (!row) return true;
    let prev = {};
    try { prev = row.result ? JSON.parse(row.result) : {}; } catch { prev = {}; }
    // 标过「失联」的：那台设备回来了，用真实结果补上；其它终态不再改
    if (TERMINAL.includes(row.status) && !prev.lost) return true;
    if (prev.lost) { delete prev.lost; delete prev.lostReason; }
    const result = {
      ...prev,
      output: text,
      summary: text,
      device: (resp.metadata?.mesh_device || resp.metadata?.device) || prev.device || null,
      remoteHarness: resp.metadata?.harness_id || prev.remoteHarness || null,
      remoteSteps: Number.isFinite(resp.step_count) ? resp.step_count : (prev.remoteSteps ?? null),
      // 那台设备的产出文件清单（文件还在那台，按需拉）
      ...(Array.isArray(resp.metadata?.mesh_files) ? { remoteFiles: resp.metadata.mesh_files } : {}),
    };
    if (TERMINAL.includes(status)) {
      const error = status === 'completed' ? null : (resp.error?.message || text || status);
      db.prepare('UPDATE agent_tasks SET status = ?, result = ?, error = ?, completed_at = ? WHERE id = ?')
        .run(status, JSON.stringify(result), error, Date.now(), taskId);
      return true;
    }
    db.prepare("UPDATE agent_tasks SET status = 'running', result = ? WHERE id = ?").run(JSON.stringify(result), taskId);
    return false;
  }

  /**
   * 远端任务标「失联」：连续一段时间连不上那台设备，或跟了太久还没做完。
   * 不是最终结果：那台设备回来（重新上线、设备网络重连、应用重启）时会再查，用真实结果补上。
   */
  _markMeshLost(taskId, reason) {
    const db = this._getDb();
    const row = db.prepare('SELECT status, result FROM agent_tasks WHERE id = ?').get(taskId);
    if (!row) return false;
    let prev = {};
    try { prev = row.result ? JSON.parse(row.result) : {}; } catch { prev = {}; }
    if (TERMINAL.includes(row.status) && !prev.lost) return false;
    const already = !!prev.lost;
    const result = { ...prev, lost: true, lostReason: reason };
    db.prepare("UPDATE agent_tasks SET status = 'failed', result = ?, error = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?")
      .run(JSON.stringify(result), reason, Date.now(), taskId);
    return !already;
  }

  /** 每秒查一次远端，连不上时慢慢放宽；连续 30 分钟连不上或跟了 48 小时还没完就标失联，设备回来再补 */
  _pollMeshTask(taskId) {
    if (this._meshPollers.has(taskId)) return;
    const glue = require('./mesh/glue');
    const started = Date.now();
    let unreachableSince = 0;
    let lastError = '';
    let delay = 1000;
    let timer = null;
    let stopped = false;
    const stop = () => { stopped = true; if (timer) clearTimeout(timer); this._meshPollers.delete(taskId); };
    const tick = async () => {
      if (stopped) return;
      let terminal = false;
      try {
        let have = 0;
        // 第 -1 步是本机加的说明（在哪个工作区跑），不算远端的（远端从第 0 步数起）
        try { have = this._getDb().prepare('SELECT COUNT(*) AS n FROM agent_task_steps WHERE task_id = ? AND step_number >= 0').get(taskId)?.n || 0; } catch { have = 0; }
        const resp = await glue.fetchAgentTask(taskId, 'get', { stepsAfter: have });
        if (resp.status === 'unreachable') {
          delay = Math.min(delay * 2, 15000);
          unreachableSince = unreachableSince || Date.now();
          lastError = resp.error?.message || lastError;
        } else {
          delay = 1000;
          unreachableSince = 0;
          terminal = this._applyMeshResponse(taskId, resp);
        }
      } catch (e) {
        delay = Math.min(delay * 2, 15000);
        unreachableSince = unreachableSince || Date.now();
        lastError = e.message || lastError;
      }
      if (terminal) {
        // 产出文件：小的先拉回本机，再通知（等着它的父任务拿到的结果里就有本机路径）
        try { await this._pullMeshOutputs(taskId); } catch (e) { console.warn('[mesh] 拉产出文件失败：', e.message); }
        try { this._notifyTaskTerminal(taskId, await this.getTaskStatus(taskId)); } catch { /* 行没了 */ }
        stop();
        return;
      }
      const now = Date.now();
      const lostFor = unreachableSince ? now - unreachableSince : 0;
      if (lostFor > MESH_LOST_AFTER_MS || now - started > MESH_TRACK_MAX_MS) {
        const reason = lostFor > MESH_LOST_AFTER_MS
          ? `失联：${Math.round(lostFor / 60000)} 分钟连不上执行它的设备${lastError ? `（${lastError}）` : ''}。那台设备回来后会自动补上结果`
          : '失联：跟了 48 小时还没做完，先停下。那台设备回来后会再查一次';
        if (this._markMeshLost(taskId, reason)) {
          try { this._notifyTaskTerminal(taskId, await this.getTaskStatus(taskId)); } catch { /* 行没了 */ }
        }
        stop();
        return;
      }
      timer = setTimeout(tick, delay);
      timer.unref?.();
    };
    this._meshPollers.set(taskId, { stop });
    timer = setTimeout(tick, delay);
    timer.unref?.();
  }

  /**
   * 应用重启、设备网络重新连上、或某台设备重新上线后，接着跟还没做完的远端任务；
   * 最近 7 天标过失联的也再查一次，用真实结果补上。
   * @param {string} [deviceId] 只看这台设备上的
   */
  resumeMeshTasks(deviceId) {
    try {
      const since = Date.now() - 7 * 24 * 3600 * 1000;
      const prefix = deviceId ? `mesh:${deviceId}:%` : 'mesh:%';
      const rows = this._getDb().prepare(`
        SELECT id FROM agent_tasks
        WHERE id LIKE ? AND (status IN ('pending', 'running')
          OR (status = 'failed' AND json_extract(result, '$.lost') = 1 AND created_at >= ?))
      `).all(prefix, since);
      for (const r of rows) this._pollMeshTask(r.id);
      return rows.length;
    } catch {
      return 0;
    }
  }

  /** 子任务（直接的孩子），按创建时间排 */
  listChildTasks(parentId, limit = 200) {
    if (!parentId) return [];
    try {
      return this._getDb().prepare(`
        SELECT * FROM agent_tasks
        WHERE json_extract(context, '$.parentTaskId') = ?
        ORDER BY created_at ASC
        LIMIT ?
      `).all(String(parentId), limit).map((t) => ({
        ...t,
        context: t.context ? safeJson(t.context, {}) : {},
        result: t.result ? safeJson(t.result, null) : null,
      }));
    } catch {
      return [];
    }
  }

  /** 派发目标：本机智能体 + 我的其他设备上的（mine:x、mine:x@设备） */
  async listDispatchTargets(options = {}) {
    const local = await this.listAvailableAgents(options);
    let mesh = [];
    try {
      mesh = require('./mesh/glue').extraHarnesses().map((h) => ({
        id: h.id,
        name: h.name,
        type: 'mine',
        base: h.base || null,
        device: h.device || null,
        description: h.device ? `在我的设备「${h.device}」上执行` : '在我的设备里自动挑一台在线的执行',
      }));
    } catch { /* 设备网络没启动 */ }
    return [...local, ...mesh];
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

  /** 外部智能体的任务：和社区任务一样只记结果，不在本机跑 */
  async _runExternalTaskForExecute(taskId, agentId, prompt, options = {}) {
    this._watchExternalResults();
    // 外部智能体不是马上开始：先排队等它来取，界面据此显示「等它来取」而不是「执行中」
    const ext = require('./external-agents');
    const info = ext.get(agentId) || {};
    this.emit('task:step', {
      taskId, stepType: 'system_event', system_subtype: 'external_queued',
      content: info.name || agentId, message: info.name || agentId,
      external: { name: info.name || agentId, online: !!info.online, intervalMs: info.intervalMs || 0, lastSeenAt: info.lastSeenAt || 0, receive: info.webhook && info.webhook.healthy ? 'webhook' : 'poll' },
      timestamp: Date.now(), ...this._taskEventMeta(taskId),
    });
    const result = await require('./external-agents').dispatch(agentId, prompt, { timeoutMs: options.timeoutMs, taskId });
    this._finishExternalTask(taskId, result);
  }

  /** 外部智能体回来的结果：派出时在等的、和应用重启后才回来的，都走这里记进任务 */
  _finishExternalTask(taskId, result) {
    if (this._isTaskCancelled(taskId)) { this.taskMetaCache.delete(taskId); return; }
    const db = this._getDb();
    const output = String(result?.output || '');
    if (!result?.ok) {
      const errText = String(result?.error || 'external agent failed');
      const payload = { success: false, summary: output, output, stderr: errText, error: errText, files: [], stepCount: 0 };
      try {
        db.prepare("UPDATE agent_tasks SET status = 'failed', error = ?, result = ?, completed_at = ? WHERE id = ?")
          .run(errText, JSON.stringify(payload), Date.now(), taskId);
      } catch { this._updateTaskStatus(taskId, 'failed', errText); }
      this.emit('task:failed', { taskId, error: errText, result: payload, status: 'failed', ...this._taskEventMeta(taskId) });
      this.taskMetaCache.delete(taskId);
      return;
    }
    const payload = { success: true, summary: output, output, stderr: '', files: [], stepCount: 0 };
    try {
      db.prepare("UPDATE agent_tasks SET status = 'completed', result = ?, completed_at = ? WHERE id = ?")
        .run(JSON.stringify(payload), Date.now(), taskId);
    } catch { /* 记不下结果也照常通知 */ }
    this.emit('task:completed', {
      taskId, result: { success: true, summary: output, stderr: '', files: [], stepCount: 0 },
      status: 'completed', ...this._taskEventMeta(taskId),
    });
    this.taskMetaCache.delete(taskId);
  }

  /** 接上次没做完的外部任务：排队的继续等它来取，取走的结果回来时记进任务；任务结束后它推来的消息也记下 */
  _watchExternalResults() {
    if (this._externalWatched) return;
    this._externalWatched = true;
    try {
      const ext = require('./external-agents');
      ext.setPushHandler((agentId, taskId, text) => this.recordTaskMessage(agentId, taskId, text));
      ext.setTakenHandler((taskId, agentId) => {
        const info = ext.get(agentId) || {};
        this.emit('task:step', {
          taskId, stepType: 'system_event', system_subtype: 'external_taken',
          content: info.name || agentId, message: info.name || agentId,
          external: { name: info.name || agentId },
          timestamp: Date.now(), ...this._taskEventMeta(taskId),
        });
      });
      ext.setResultHandler((taskId, result) => this._finishExternalTask(taskId, result));
    } catch (e) { console.warn('[agent] external tasks restore failed:', e.message); }
  }

  _ensureTaskMessagesTable(db) {
    if (this._taskMessagesReady) return;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_task_messages (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, root_task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_task_messages_root ON agent_task_messages(root_task_id, created_at)');
    this._taskMessagesReady = true;
  }

  /** 外部智能体就它接过的任务推来一条消息：只认派给它的任务；记到最上层的那个任务下（游乐场按它显示） */
  recordTaskMessage(agentId, taskId, text) {
    const db = this._getDb();
    const row = db.prepare('SELECT id, agent_id, context FROM agent_tasks WHERE id = ?').get(taskId);
    if (!row) return 'not_found';
    if (row.agent_id !== agentId) return 'not_yours';
    this._ensureTaskMessagesTable(db);
    let root = row;
    for (let i = 0; i < 5; i++) {
      let parent = '';
      try { parent = JSON.parse(root.context || '{}').parentTaskId || ''; } catch { parent = ''; }
      const up = parent ? db.prepare('SELECT id, agent_id, context FROM agent_tasks WHERE id = ?').get(parent) : null;
      if (!up) break;
      root = up;
    }
    const msg = {
      id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      task_id: taskId, root_task_id: root.id, agent_id: agentId, content: String(text), created_at: Date.now(),
    };
    db.prepare('INSERT INTO agent_task_messages (id, task_id, root_task_id, agent_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(msg.id, msg.task_id, msg.root_task_id, msg.agent_id, msg.content, msg.created_at);
    this.emit('task:message', { taskId, rootTaskId: root.id, agentId, content: msg.content, timestamp: msg.created_at });
    return true;
  }

  /** 某个外部智能体 since 之后推来的所有消息（游乐场里和它的当前对话显示用），带上来源任务的标题 */
  listAgentMessagesSince(agentId, since = 0) {
    if (!agentId) return [];
    const db = this._getDb();
    this._ensureTaskMessagesTable(db);
    const rows = db.prepare(`SELECT m.*, t.prompt AS root_prompt FROM agent_task_messages m
      LEFT JOIN agent_tasks t ON t.id = m.root_task_id
      WHERE m.agent_id = ? AND m.created_at >= ? ORDER BY m.created_at LIMIT 500`).all(String(agentId), Number(since) || 0);
    return rows.map(r => ({
      id: r.id, taskId: r.task_id, rootTaskId: r.root_task_id, agentId: r.agent_id,
      content: r.content, timestamp: r.created_at, source: String(r.root_prompt || '').slice(0, 40),
    }));
  }

  /** 这些任务（或它们的子任务）收到的推送，按传进来的任务 id 分组 */
  listTaskMessages(taskIds = []) {
    const ids = [...new Set((taskIds || []).filter(Boolean).map(String))].slice(0, 500);
    if (!ids.length) return {};
    const db = this._getDb();
    this._ensureTaskMessagesTable(db);
    const ph = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM agent_task_messages WHERE root_task_id IN (${ph}) OR task_id IN (${ph}) ORDER BY created_at`).all(...ids, ...ids);
    const want = new Set(ids);
    const out = {};
    for (const r of rows) {
      const key = want.has(r.root_task_id) ? r.root_task_id : r.task_id;
      (out[key] = out[key] || []).push({ id: r.id, agentId: r.agent_id, content: r.content, timestamp: r.created_at });
    }
    return out;
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
      // 外部智能体：排进它的队列，等它来取、做完回传
      if (require('./external-agents').isExternalId(agentId)) {
        await this._runExternalTaskForExecute(taskId, agentId, prompt, options);
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
          agentRouteId: options.agentRouteId || '',
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

      // 智能管家跑在任何一个已纳管的执行应用上，都带上 Token Bank 的接口。不改用户自己的配置。
      if (require('./guardian/chat').isGuardianAgent(agentId)) {
        try {
          const attached = require('./guardian/mcp-launch').attach(effectiveAgentId, args, { workingDir: runDir });
          args = attached.args;
          if (attached.cwd) runDir = attached.cwd;
        } catch (e) {
          console.warn('[guardian] attach mcp:', e.message);
        }
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

      const doneStatus = 'completed';

      // 更新任务结果（失败也不阻断完成事件，避免 UI 卡在 executing）
      try {
        db.prepare(`
          UPDATE agent_tasks 
          SET status = ?, result = ?, completed_at = ?
          WHERE id = ?
        `).run(doneStatus, JSON.stringify(result), Date.now(), taskId);
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
        status: doneStatus,
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

    // 技能要用的 Key（资产页里配的）：带进这次任务的进程环境，技能里的脚本直接读得到
    try {
      const skillEnv = require('./skill-env').allEnv();
      Object.assign(spawnEnv, skillEnv);
    } catch (e) { console.warn('[AgentExecutor] 技能配置注入失败:', e.message); }

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
    if (isMeshTaskId(taskId)) {
      const resp = await require('./mesh/glue').fetchAgentTask(taskId, 'cancel');
      this._applyMeshResponse(taskId, resp);
      this._meshPollers.get(taskId)?.stop();
      const payload = this._persistCancelledTask(taskId, null);
      if (resp.status === 'unreachable') {
        return { success: !!payload, error: resp.error?.message, unreachable: true };
      }
      return { success: true, cliSessionId: null };
    }
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

  /**
   * 这个智能体一段时间内的任务。days=1 从本地 0 点起，和今天的数字一致；
   * 7 / 30 / 90 从现在往前推，和用量明细的窗口一样。
   * 带开始、完成时间，以及返回正文（不带步骤和文件）。
   */
  listTodayTasks(agentId, limit = 50, days = 1) {
    const id = String(agentId || '');
    if (!id) return [];
    const span = [1, 7, 30, 90].includes(Number(days)) ? Number(days) : 1;
    const since = span === 1
      ? (() => { const start = new Date(); start.setHours(0, 0, 0, 0); return start.getTime(); })()
      : Date.now() - span * 86400000;
    const n = Math.min(Math.max(Number(limit) || 50, 1), span === 1 ? 100 : 200);
    let rows = [];
    try {
      rows = this._getDb().prepare(`
        SELECT id, agent_id, prompt, status, error, created_at, started_at, completed_at, result
        FROM agent_tasks
        WHERE (agent_id = ? OR agent_id LIKE ?) AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(id, `mine:${id}@%`, since, n);
    } catch {
      return [];
    }
    // 派到我其他设备上跑的（mine:<它>@<设备>）也算它的任务，标上设备，带产出文件
    return rows.map((r) => {
      let result = {};
      try { result = r.result ? JSON.parse(r.result) : {}; } catch { result = {}; }
      const mesh = String(r.agent_id || '').startsWith('mine:');
      return {
        id: r.id,
        prompt: r.prompt,
        status: r.status,
        error: r.error || '',
        created_at: r.created_at,
        started_at: r.started_at || null,
        completed_at: r.completed_at || null,
        output: taskResultText(r.result),
        ...(mesh ? { device: result.device || String(r.agent_id).split('@').pop() || null } : {}),
        ...(Array.isArray(result.files) && result.files.length ? { files: result.files.map((f) => ({ token: f.token, name: f.name, size: f.size, path: f.path || null, pending: !!f.pending, error: f.error || '' })) } : {}),
      };
    });
  }

  async getTaskStatus(taskId) {
    const db = this._getDb();
    const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId);

    if (!task && isMeshTaskId(taskId)) {
      // 本机没有镜像（比如别的入口派的）：直接问那台设备
      const resp = await require('./mesh/glue').fetchAgentTask(taskId, 'get');
      if (resp.httpStatus === 404) throw new Error('Task not found');
      const text = meshOutputText(resp);
      return {
        id: taskId,
        agent_id: resp.metadata?.harness_id ? `mine:${resp.metadata.harness_id}` : 'mine:',
        prompt: '',
        context: { mesh: true, meshDevice: (resp.metadata?.mesh_device || resp.metadata?.device) || null },
        status: resp.status === 'unreachable' ? 'unreachable' : (MESH_STATUS[resp.status] || 'running'),
        result: text ? { output: text, summary: text, device: (resp.metadata?.mesh_device || resp.metadata?.device) || null } : null,
        error: resp.error?.message || null,
        steps: [],
        files: [],
      };
    }
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

/** 像事件流（一行一个 JSON）而不是给人看的正文 */
function looksLikeEventStream(text) {
  const s = String(text || '').trim();
  return s.startsWith('{') && (s.includes('"type"') || s.includes('\n{'));
}

function clipTaskText(text) {
  return String(text || '').slice(0, 8000);
}

/** 任务结果里给人看的正文。优先 summary；output 若是原始事件流则再整理一次。 */
function taskResultText(raw) {
  if (!raw) return '';
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return clipTaskText(raw); }
  }
  if (!obj || typeof obj !== 'object') return clipTaskText(obj);
  const summary = String(obj.summary || '').trim();
  const output = String(obj.output || obj.text || '').trim();
  if (summary && summary !== '(无输出)' && !looksLikeEventStream(summary)) return clipTaskText(summary);
  if (output && !looksLikeEventStream(output)) return clipTaskText(output);
  if (output) {
    const summarized = String(summarizeAgentStdout(output, 'claude-code') || '').trim();
    if (summarized && summarized !== '(无输出)' && !looksLikeEventStream(summarized)) return clipTaskText(summarized);
  }
  return '';
}

module.exports = new AgentExecutor();
module.exports.AGENT_CLI = AGENT_CLI;
module.exports.canonicalBuiltinAgentId = canonicalBuiltinAgentId;
module.exports.invalidateAgentListCache = invalidateAgentListCache;
module.exports.taskWaitAlive = taskWaitAlive;
module.exports.taskActivityMark = taskActivityMark;
module.exports.isMeshTarget = isMeshTarget;
module.exports.isMeshTaskId = isMeshTaskId;
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
