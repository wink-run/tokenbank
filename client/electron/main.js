const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, clipboard, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { autoUpdater } = require('electron-updater');
const {
  findLatestReleaseTag,
  feedUrlForTag,
  isRemoteNewer,
} = require('./updater-release');
// GUI 启动通常无 shell 的 HTTP(S)_PROXY；启动前注入系统代理环境变量，供出站请求使用
try {
  const injected = require('../shared/inject-proxy-env').injectProxyEnv();
  if (injected) console.log('[proxy-env] injected', injected);
} catch (e) {
  console.warn('[proxy-env] inject failed:', e && e.message);
}
// HTTP 代理拦不住 QUIC；直连 chatgpt.com 等会被中间盒用过期/伪造证书掐握手（net_error -201）
try { app.commandLine.appendSwitch('disable-quic'); } catch { /* ignore */ }
const agent = require('./agent-worker');
const gateway = require('./local-gateway');
const localStats = require('./local-stats');
const sessionImport = require('./session-import');
const sessionBrowser = require('./session-browser');
const { STATS_DIR, computeImportSkip } = require('../shared/telemetry');
const { defaultServerUrlFromEnv } = require('../shared/default-server-url');
const deviceIdentity = require('../shared/device-identity');
const detectTools = require('./detect-tools');
const agentLinker = require('./agent-linker');
const cursorHooks = require('./cursor-hooks');
const sessionOffthread = require('./session-offthread');
const trayPopover = require('./tray-popover');
const { brandIconForApp } = require('./brand-icons');

/** 会话补录：派到 worker，不阻塞主线程（托盘刷新 / 打开盘点时曾会假死） */
let _lastSessionTelemetrySync = 0;
const SESSION_TELEMETRY_SYNC_MS = 20_000;
function notifyTelemetryImported(r) {
  if (!r || r.skipped) return;
  const n = (r.hookImported || 0) + (r.sessionImported || 0) + (r.skillRecorded || 0) + (r.toolsRecorded || 0);
  if (n <= 0) return;
  try { require('./session-manager').invalidateSessionsCache(); } catch {}
  try {
    mainWindow?.webContents?.send('apps:changed');
    mainWindow?.webContents?.send('localStats:changed');
  } catch {}
}
function scheduleSessionTelemetry(opts = {}) {
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (!force && _lastSessionTelemetrySync && (now - _lastSessionTelemetrySync) < SESSION_TELEMETRY_SYNC_MS) {
    return Promise.resolve({ skipped: true });
  }
  _lastSessionTelemetrySync = now;
  return sessionOffthread.runTelemetry({ statsDir: STATS_DIR, force })
    .then((r) => { notifyTelemetryImported(r); return r; })
    .catch((e) => {
      console.error('[session-telemetry]', e && e.message);
      return { error: e && e.message };
    });
}
function maybeSyncSessionTelemetry() {
  scheduleSessionTelemetry();
}
// device-reporter is used by the CLI only; desktop registration is handled
// by useDeviceReporter in the renderer (which has access to the JWT).

const isDev = !app.isPackaged;
// 打包后 Finder/Dock 启动 cwd 常是 Contents/MacOS；Agent 子进程 getcwd 会 Operation not permitted
if (app.isPackaged) {
  try { process.chdir(os.homedir()); } catch { /* ignore */ }
}
// 与 vite.config.js server.port 保持一致；可用环境变量覆盖
const VITE_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
// macOS 菜单栏显示名（dev 下系统设置里通常显示 Electron）
if (process.platform === 'darwin') app.setName('Token Bank');
const AGENT_CONFIG_PATH = path.join(os.homedir(), '.llm-agent', 'config.json');
const TB_YAML = path.join(os.homedir(), '.tokenbank', 'tokenbank.yaml');
// Claude Desktop 3p 配置目录（按平台）：
//   Windows → %LOCALAPPDATA%\Claude-3p\configLibrary
//   macOS   → ~/Library/Application Support/Claude-3p/configLibrary
//   Linux   → ~/.config/Claude-3p/configLibrary
const CLAUDE_3P_CONFIG_DIR = (() => {
  const home = os.homedir();
  if (process.platform === 'win32')  return path.join(home, 'AppData', 'Local', 'Claude-3p', 'configLibrary');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude-3p', 'configLibrary');
  return path.join(home, '.config', 'Claude-3p', 'configLibrary');
})();

// Claude Desktop 数据目录（原生 1P + 3P 各一份 claude_desktop_config.json）
function claudeDesktopDataDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const base = path.join(home, 'AppData', 'Local');
    return [path.join(base, 'Claude'), path.join(base, 'Claude-3p')];
  }
  if (process.platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [path.join(base, 'Claude'), path.join(base, 'Claude-3p')];
  }
  const base = path.join(home, '.config');
  return [path.join(base, 'Claude'), path.join(base, 'Claude-3p')];
}

// 既有配置文件是否已是 tokenbank 写入的托管配置（网关配置带 _configManagedBy:tokenbank 标记）。
// 用途：备份时绝不把"自己的托管配置"存成 .tokenbank-bak；还原时坏备份视同无备份，避免把网关配置写回。
function isTokenbankManagedConfig(file) {
  try {
    if (!file || !fs.existsSync(file)) return false;
    const txt = fs.readFileSync(file, 'utf8');
    if (/\.json$/i.test(file)) {
      try { return JSON.parse(txt)?._configManagedBy === 'tokenbank'; } catch { return false; }
    }
    return /_configManagedBy['"\s:=]+tokenbank/i.test(txt);
  } catch { return false; }
}

// 还原 Claude Desktop 到官方 1P：除 configLibrary 外还需清 deploymentMode=3p、修补破损 _meta
function revertClaudeDesktopOfficialExtras() {
  for (const dir of claudeDesktopDataDirs()) {
    const cfg = path.join(dir, 'claude_desktop_config.json');
    try {
      if (!fs.existsSync(cfg)) continue;
      const obj = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      if (obj.deploymentMode !== '3p') continue;
      delete obj.deploymentMode;
      fs.writeFileSync(cfg, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) { console.warn('[claude] clear deploymentMode', cfg, e.message); }
  }
  try {
    if (!fs.existsSync(CLAUDE_3P_CONFIG_DIR)) return;
    // 删除/还原仍残留的 gateway 配置
    for (const f of fs.readdirSync(CLAUDE_3P_CONFIG_DIR)) {
      if (!f.endsWith('.json') || f === '_meta.json') continue;
      const p = path.join(CLAUDE_3P_CONFIG_DIR, f);
      try {
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        // 只回退 tokenbank 自己写入的配置；用户/Claude 自建的 gateway 配置绝不动，
        // 否则会清空 configLibrary，导致开发者模式被误判为「未启用」、纳管按钮回弹。
        if (c._configManagedBy !== 'tokenbank') continue;
        const bak = p + '.tokenbank-bak';
        // 坏备份保护：备份若本身就是 tokenbank 网关配置（历史 bug：re-管理时把自己的配置备份了），
        // 视同无原始配置 → 删除托管文件回到官方直连，并清掉坏备份，避免下次还原又写回网关。
        if (fs.existsSync(bak) && !isTokenbankManagedConfig(bak)) {
          fs.copyFileSync(bak, p);
        } else {
          try { fs.unlinkSync(p); } catch {}
          try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch {}
        }
      } catch {}
    }
    // _meta.appliedId 指向已删文件时 Claude 会卡在 3P 半残状态
    const metaPath = path.join(CLAUDE_3P_CONFIG_DIR, '_meta.json');
    if (!fs.existsSync(metaPath)) return;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const entries = (meta.entries || []).filter(e => fs.existsSync(path.join(CLAUDE_3P_CONFIG_DIR, e.id + '.json')));
    if (!entries.length) {
      try { fs.unlinkSync(metaPath); } catch {}
    } else {
      meta.entries = entries;
      if (!entries.some(e => e.id === meta.appliedId)) meta.appliedId = entries[0].id;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    }
  } catch (e) { console.warn('[claude] revert configLibrary extras', e.message); }
}

function isClaude3pConfigLibraryFile(file) {
  if (!file || typeof file !== 'string') return false;
  try {
    const base = path.basename(file);
    return path.resolve(file).startsWith(path.resolve(CLAUDE_3P_CONFIG_DIR) + path.sep)
      && base.endsWith('.json') && base !== '_meta.json';
  } catch { return false; }
}

// 纳管写入前解析目标路径；configLibrary 无既有配置时生成新 UUID 文件
function resolveClaude3pWriteTarget(file) {
  fs.mkdirSync(CLAUDE_3P_CONFIG_DIR, { recursive: true });
  if (isClaude3pConfigLibraryFile(file)) {
    return { file, configId: path.basename(file, '.json') };
  }
  const configId = require('crypto').randomUUID();
  return { file: path.join(CLAUDE_3P_CONFIG_DIR, configId + '.json'), configId };
}

// Claude 只读 _meta.appliedId 指向的配置；写入后必须确保 _meta 存在且 appliedId 对齐
function ensureClaude3pMeta(configId, name = 'Token Bank') {
  if (!configId || configId === '_meta') return;
  fs.mkdirSync(CLAUDE_3P_CONFIG_DIR, { recursive: true });
  const metaPath = path.join(CLAUDE_3P_CONFIG_DIR, '_meta.json');
  let meta = { appliedId: configId, entries: [{ id: configId, name }] };
  try {
    if (fs.existsSync(metaPath)) {
      const existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const entries = Array.isArray(existing.entries) ? existing.entries.filter(e => e && e.id) : [];
      const idx = entries.findIndex(e => e.id === configId);
      if (idx >= 0) entries[idx] = { ...entries[idx], name: entries[idx].name || name };
      else entries.push({ id: configId, name });
      meta = { ...existing, appliedId: configId, entries };
    }
  } catch {}
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

function isClaudeDesktopApp(app_id) {
  if (String(app_id || '').includes('claude-desktop')) return true;
  try {
    const app = (readLocalConfig()?.apps || []).find(a => a.id === app_id);
    return app?.preset_id === 'claude-desktop';
  } catch { return false; }
}

function isCodexDesktopApp(app_id) {
  if (String(app_id || '').includes('codex-desktop')) return true;
  try {
    const { canonicalAppEntityId } = require('./app-handlers');
    const app = (readLocalConfig()?.apps || []).find(a => a.id === app_id);
    const pid = app?.preset_id || app?.agent_id;
    // 统一实体 id=codex（兼容旧 preset_id=codex-desktop）
    return canonicalAppEntityId(pid) === 'codex' && (app?.link_method === 'api-key' || !!app?.config_file);
  } catch { return false; }
}

function isTraeApp(app_id) {
  const { isTraeWorkEntity } = require('./app-handlers');
  if (isTraeWorkEntity(app_id)) return true;
  if (String(app_id || '').toLowerCase().includes('trae')) return true;
  try {
    const app = (readLocalConfig()?.apps || []).find(a => a.id === app_id);
    return isTraeWorkEntity(app?.preset_id) || isTraeWorkEntity(app?.agent_id);
  } catch { return false; }
}

function isDshApp(app_id) {
  if (String(app_id || '').includes('deepseek-harness')) return true;
  try {
    const app = (readLocalConfig()?.apps || []).find(a => a.id === app_id);
    const pid = app?.preset_id || app?.agent_id;
    return pid === 'deepseek-harness' || pid === 'deepseek-harness-cli';
  } catch { return false; }
}

/** 还原 config-file 应用配置（与 apps:revertConfigFile IPC 共用） */
function revertAppConfigFile(app_id, config_file) {
  if (isClaudeDesktopApp(app_id)) runClaude3pSync('revert');
  const cl = require('./config-loader');
  let file = cl.expandHome(cl.resolvePlaceholders(String(config_file || ''), {}));
  // Codex Desktop：精确删除我们写的段(保留 config.toml 其他更新)+ 删 catalog，不动 auth.json
  if (isCodexDesktopApp(app_id) && file) {
    const codexCfg = require('./codex-config');
    codexCfg.revertCodexProvider(file);
    codexCfg.removeCodexCatalog(path.dirname(file));
    // 会话归一回 openai：threads(Desktop 列表) + rollout 一并归一，直连态也看到全部
    try { codexCfg.syncCodexSessionProvider(path.dirname(file), 'openai'); } catch {}
    return;
  }
  if (isTraeApp(app_id) && file) {
    require('./trae-config').revertTraeModels(file);
    return;
  }
  // DeepSeek Harness：settings.yaml 由下方通用分支从 .tokenbank-bak 整份还原；
  // 这里只清我们写入的网关 key，合并保留用户其他凭证（不整份删 .credentials.yaml）。
  if (isDshApp(app_id) && file) {
    try { require('./dsh-config').revertDshCredentials(path.dirname(file)); } catch {}
  }
  if (file) {
    const bak = file + '.tokenbank-bak';
    // 坏备份保护：备份本身就是 tokenbank 网关配置时，视同无备份（否则会把网关配置写回，还原后仍走网关）。
    if (fs.existsSync(bak) && !isTokenbankManagedConfig(bak)) {
      try { fs.copyFileSync(bak, file); } catch {}
    } else {
      // 无有效原始备份（或备份是坏的 tokenbank 网关配置）：清掉坏备份，只删 tokenbank 自己写入的配置。
      // Claude Desktop 的 configLibrary 里可能是用户/Claude 自建的配置（纳管前 config_file 就指向它），
      // 删了会清空 configLibrary、让开发者模式被误判为未启用——所以未标记 _configManagedBy:tokenbank 的一律不动。
      try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch {}
      try {
        let managed = true;
        if (isClaudeDesktopApp(app_id) && fs.existsSync(file)) {
          try { managed = JSON.parse(fs.readFileSync(file, 'utf8'))._configManagedBy === 'tokenbank'; }
          catch { managed = false; }
        }
        if (managed && fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }
  }
  if (isClaudeDesktopApp(app_id)) revertClaudeDesktopOfficialExtras();
}

// Claude Code CLI 的 settings.json 托管（核心逻辑见 ./cli-endpoint-config）。
// settings.json 的 env 压过 shim → 选路由时写入 PROXY_MANAGED + 网关 BASE_URL，占住配置防其他代理改写。
// 对齐 cc-switch：托管只写 BASE_URL + TOKEN，不硬编码上下文窗口 env。
function syncCliInstanceEndpointConfig(app, opts = {}) {
  try {
    const cl = require('./config-loader');
    return require('./cli-endpoint-config').syncCliInstanceEndpointConfig(app, {
      expandHome: (p) => cl.expandHome(p),
      gatewayOrigin: `http://${cl.gatewayCtx().reverse}`,
      ...opts,
    });
  } catch (e) { console.warn('[cli-instance] endpoint settings sync error:', e && e.message); }
}
// 取消托管 / 退出：把某工具（或全部）Claude Code 实例的 settings.json 强制还原
function revertCliInstanceEndpointConfigs(agentId) {
  try {
    for (const a of (readLocalConfig().apps || [])) {
      if (a.link_method === 'shim' && a.instance && (!agentId || a.agent_id === agentId)) {
        syncCliInstanceEndpointConfig(a, { forceDirect: true });
      }
    }
  } catch (e) { console.warn('[cli-instance] revert endpoint configs:', e && e.message); }
}

function shouldUseClaude3pConfigWrite({ app_id, config_file, file }) {
  if (isClaudeDesktopApp(app_id)) return true;
  if (isClaude3pConfigLibraryFile(file)) return true;
  const cf = String(config_file || '');
  return cf.includes('CLAUDE_3P') || cf.includes('Claude-3p/configLibrary');
}

// 已有 gateway 配置但缺 _meta 时补齐（如历史写入未命中 app_id 判断）
function repairClaude3pMetaIfNeeded() {
  try {
    if (!fs.existsSync(CLAUDE_3P_CONFIG_DIR)) return;
    const configs = fs.readdirSync(CLAUDE_3P_CONFIG_DIR)
      .filter(f => f.endsWith('.json') && f !== '_meta.json');
    if (!configs.length) return;
    const metaPath = path.join(CLAUDE_3P_CONFIG_DIR, '_meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const id = meta.appliedId || (meta.entries && meta.entries[0] && meta.entries[0].id);
      if (id && fs.existsSync(path.join(CLAUDE_3P_CONFIG_DIR, id + '.json'))) return;
    }
    for (const f of configs) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CLAUDE_3P_CONFIG_DIR, f), 'utf8'));
        if (c.inferenceProvider === 'gateway' || c._configManagedBy === 'tokenbank') {
          ensureClaude3pMeta(path.basename(f, '.json'));
          console.log('[claude] repaired _meta.json for', f);
          return;
        }
      } catch {}
    }
    ensureClaude3pMeta(path.basename(configs[0], '.json'));
    console.log('[claude] repaired _meta.json for', configs[0]);
  } catch (e) { console.warn('[claude] repair _meta', e.message); }
}

// Claude Desktop 开发者模式状态：configLibrary 目录是否存在。
// Claude 在启用 Developer Mode（Help → Troubleshooting → Enable Developer Mode）时创建该目录。
// 只看「目录在不在」而非「里面有没有 .json」——内容可能为空（Claude 会清掉空的 Default、
// 「回官方」也会清空内容），但目录仍在即代表开发者模式开过；写配置时缺文件会自动新建。
// Token Bank 自己只在写配置（纳管动作，此前提为 dev_mode_ready）时才 mkdir，不会凭空创建该目录。
function claudeDevModeReady() {
  try { return fs.existsSync(CLAUDE_3P_CONFIG_DIR); }
  catch { return false; }
}

// 获取 Claude Desktop 当前【激活】的 3p 配置文件路径。
// Claude 读取 _meta.json.appliedId 指向的那个配置；必须写进它，否则改了不生效。
// 若 configLibrary 为空（开发者模式未启用）→ 返回 null（由调用方提示用户先启用）。
function getClaudeCloudConfig() {
  try {
    if (!claudeDevModeReady()) return null;

    // 1) 优先用 _meta.json.appliedId 指向的激活配置（Claude 真正读取的那个）
    const metaPath = path.join(CLAUDE_3P_CONFIG_DIR, '_meta.json');
    let appliedId = null;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      appliedId = meta.appliedId || (meta.entries && meta.entries[0] && meta.entries[0].id) || null;
    } catch {}
    if (appliedId) {
      return path.join(CLAUDE_3P_CONFIG_DIR, appliedId + '.json');
    }

    // 2) 回退：已有 gateway 配置 → 用它
    const files = fs.readdirSync(CLAUDE_3P_CONFIG_DIR).filter(f => f.endsWith('.json') && f !== '_meta.json');
    for (const f of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(CLAUDE_3P_CONFIG_DIR, f), 'utf8'));
        if (c.inferenceProvider === 'gateway') return path.join(CLAUDE_3P_CONFIG_DIR, f);
      } catch {}
    }
    // 3) 再回退：第一个配置文件
    if (files.length) return path.join(CLAUDE_3P_CONFIG_DIR, files[0]);
    return null;
  } catch (e) {
    console.error('[main] getClaudeCloudConfig failed:', e.message);
    return null;
  }
}

let mainWindow = null;
let tray = null;

// ── 单实例锁 ──────────────────────────────────────────────────────────────────
// 正式包：只允许一个桌面实例；第二个拿不到锁就退出，已有实例靠 second-instance 拉前台。
// 开发态：不抢 SingletonLock，与正式包共用 …/Token Bank 配置目录，避免 npm electron
// 占锁后点 Token Bank.app「闪退」，也避免为隔离目录导致配置像「丢失」。
// 注：无头 CLI（cli/gateway.js）是另一入口，不受此锁影响。
if (!isDev) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
  }
  app.on('second-instance', () => {
    try {
      const focusWin = (win) => {
        if (!win || win.isDestroyed()) return false;
        if (win.isMinimized()) win.restore();
        if (!win.isVisible()) win.show();
        win.focus();
        return true;
      };
      if (focusWin(mainWindow)) return;
      if (typeof createWindow === 'function') {
        createWindow();
        focusWin(mainWindow);
        return;
      }
      for (const w of BrowserWindow.getAllWindows()) {
        if (focusWin(w)) return;
      }
    } catch (e) {
      console.warn('[main] second-instance:', e.message);
    }
  });
}
/** 菜单栏是否显示 ↑↓Token 两行文字（仅 macOS）。持久化在 localConfig.tray_show_tokens，默认开 */
let showTrayTokens = true;
/** macOS 点关闭仅隐藏窗口；托盘/Cmd+Q 退出时设为 true，避免 close 拦截 quit */
let isQuitting = false;
/** 菜单栏语言（由渲染层通过 tray:lang IPC 同步，默认 zh） */
let _trayLang = 'zh';
/** 用户是否已登录（由渲染层通过 tray:auth IPC 同步，初始从 cloud_config.token 推断） */
let _trayUserLoggedIn = false;

const TRAY_LABELS = {
  zh: {
    gatewayRunning:   (port) => `网关运行中 :${port}`,
    gatewayStopped:   '网关已停止',
    todayToken:       (l1, l2, n) => `今日 Token  ${l1}  ${l2}  (${n}次)`,
    agentRunning:     '贡献 Agent 运行中',
    agentStopped:     '贡献 Agent 已停止',
    showWindow:       '显示主窗口',
    showTokens:       '菜单栏显示 Token 上下行',
    startAgent:       '开启贡献 Agent',
    stopAgent:        '停止贡献 Agent',
    notLoggedIn:      '（需登录后使用）',
    quit:             '退出',
  },
  en: {
    gatewayRunning:   (port) => `Gateway running :${port}`,
    gatewayStopped:   'Gateway stopped',
    todayToken:       (l1, l2, n) => `Today  ${l1}  ${l2}  (${n} calls)`,
    agentRunning:     'Contribute Agent running',
    agentStopped:     'Contribute Agent stopped',
    showWindow:       'Show main window',
    showTokens:       'Show token usage in menu bar',
    startAgent:       'Start Contribute Agent',
    stopAgent:        'Stop Contribute Agent',
    notLoggedIn:      '(login required)',
    quit:             'Quit',
  },
};

// ── Icons ──────────────────────────────────────────────────────────────────────

/** 内置托盘图标（assets/ 未生成时的兜底） */
const TRAY_ICON_B64 = {
  running: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAe0lEQVR4AbXBSREDMQxFwfcNRTTEReDMRTRMRZmDD1OpWeNKN39nGcUFccAyihPDu9gRXyyjuDG8i0nsWEbx0PAuNmKyjOKl4V2NRY1FYmMZxY/EZBnFS8O7Gosai8SOZRQPDe9iI75YRnFjeBeTOGAZxYnhXbxhGcWFDxeUJt5X+1QaAAAAAElFTkSuQmCC',
  stopped: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAd0lEQVR4AbXBuxHDMAxEwXdsFxkquAqYsV5YAQONxvqZ413+LtLFBfFFpIsTo1vsiINIFzdGt5jETqSLh0a32Igp0sVLo1uNRY1FYhPp4kdiinTx0uhWY1FjkdiJdPHQ6BYbcRDp4sboFpP4ItLFidEt3oh0ceEDwVknJpkY6XgAAAAASUVORK5CYII=',
};


function getTrayIcon(state) {
  // macOS：黑白 Template 图标（tray-mac.png + @2x）。Template 模式下系统自动适配深/浅菜单栏。
  if (process.platform === 'darwin') {
    const macIcon = path.join(__dirname, '..', 'assets', 'tray-mac.png');
    if (fs.existsSync(macIcon)) {
      const img = nativeImage.createFromPath(macIcon);
      img.setTemplateImage(true);
      if (!img.isEmpty()) return img;
    }
    return nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64.stopped, 'base64'));
  }
  // Windows / Linux：彩色品牌 logo（纯色圆点会被当成状态灯，认不出 Token Bank）
  // 优先 electron/assets（随 asar 打包）；其次 client/assets 开发态
  const candidates = [
    path.join(__dirname, 'assets', 'tray-win@2x.png'),
    path.join(__dirname, 'assets', 'tray-win.png'),
    path.join(__dirname, '..', 'assets', 'tray-win@2x.png'),
    path.join(__dirname, '..', 'assets', 'tray-win.png'),
  ];
  for (const iconPath of candidates) {
    if (!fs.existsSync(iconPath)) continue;
    try {
      const raw = nativeImage.createFromPath(iconPath);
      if (raw.isEmpty()) continue;
      // @2x 文件按 2 倍缩放因子交给托盘，高分屏更清晰
      if (/@2x\.png$/i.test(iconPath)) {
        return nativeImage.createFromBuffer(raw.toPNG(), { scaleFactor: 2 });
      }
      return raw;
    } catch { /* try next */ }
  }
  // 极端兜底：旧纯色圆（几乎不该走到）
  const running = state === 'running';
  return nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64[running ? 'running' : 'stopped'], 'base64'));
}

// ── Window ────────────────────────────────────────────────────────────────────

// 用系统默认浏览器打开外链；失败（如 Linux 缺 xdg-open）则复制链接 + 提示手动访问
function openExternalSafe(url) {
  Promise.resolve(shell.openExternal(url)).catch(() => {
    try { clipboard.writeText(url); } catch {}
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: '无法打开系统浏览器',
      detail: `链接已复制到剪贴板，请手动在浏览器中访问：\n${url}`,
      buttons: ['好的'],
    });
  });
}

/** 渲染进程主题偏好（与 localStorage theme 对齐），供 Windows 标题栏启动前恢复 */
function uiThemePath() {
  return path.join(app.getPath('userData'), 'ui-theme.json');
}
function readSavedUiTheme() {
  try {
    const t = JSON.parse(fs.readFileSync(uiThemePath(), 'utf8'))?.theme;
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch { /* ignore */ }
  return 'system';
}
/** 与 .tb-app-shell 底色一致，Windows 标题栏叠层不另起一套色 */
function titleBarOverlayOpts(dark) {
  return {
    color: dark ? '#09090b' : '#e8e9ec',
    symbolColor: dark ? '#e4e4e7' : '#52525b',
    height: 36,
  };
}
function shellBackgroundColor(dark) {
  return dark ? '#09090b' : '#e8e9ec';
}
/** 同步 Electron nativeTheme + Windows titleBarOverlay，与应用 light/dark 一致 */
function applyNativeThemeSource(source) {
  const theme = (source === 'light' || source === 'dark' || source === 'system') ? source : 'system';
  try { nativeTheme.themeSource = theme; } catch { /* ignore */ }
  try {
    fs.writeFileSync(uiThemePath(), JSON.stringify({ theme }, null, 2), 'utf8');
  } catch { /* ignore */ }
  const dark = !!nativeTheme.shouldUseDarkColors;
  if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
    try {
      mainWindow.setBackgroundColor(shellBackgroundColor(dark));
      mainWindow.setTitleBarOverlay(titleBarOverlayOpts(dark));
    } catch { /* ignore */ }
  }
  return { ok: true, themeSource: theme, shouldUseDarkColors: dark };
}

function createWindow() {
  // 屏蔽默认应用菜单栏（File / Edit / View / Window / Help）
  Menu.setApplicationMenu(null);
  // 启动前恢复上次主题，避免 Windows 标题栏先按系统深色闪一下
  applyNativeThemeSource(readSavedUiTheme());
  const winDark = nativeTheme.shouldUseDarkColors;
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    // 默认以最小宽高打开；略大于 900，避免 Windows 上网关列表出现横向滚动条
    width: 920,
    height: 600,
    minWidth: 920,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: shellBackgroundColor(winDark),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    // macOS：hiddenInset + 交通灯；Windows：hidden + overlay，颜色跟壳层，去掉系统黑条
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          vibrancy: 'sidebar',
          visualEffectState: 'active',
          backgroundColor: '#00000000',
        }
      : isWin
        ? {
            titleBarStyle: 'hidden',
            titleBarOverlay: titleBarOverlayOpts(winDark),
          }
        : { titleBarStyle: 'default' }),
    show: false,
  });

  // 外链（target="_blank" / window.open）走系统默认浏览器，不在 app 内开内置窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) openExternalSafe(url);
    return { action: 'deny' };
  });
  // 防止 app 内直接导航到外部地址（保持单页应用本身可正常路由）
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (/^https?:\/\//i.test(url) && url !== VITE_URL && !url.startsWith(VITE_URL)) {
      e.preventDefault();
      openExternalSafe(url);
    }
  });

  if (isDev) {
    let devLoadRetries = 0;
    const loadDevUrl = () => mainWindow.loadURL(VITE_URL);
    // Vite 尚未就绪或端口冲突时 loadURL 会失败 → 白屏；自动重试并打日志
    mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      if (!isDev || code === -3) return; // ERR_ABORTED
      if (url !== VITE_URL && !String(url).startsWith(VITE_URL)) return;
      if (devLoadRetries >= 8) {
        console.error('[main] dev load failed:', code, desc, url);
        return;
      }
      devLoadRetries += 1;
      console.warn(`[main] dev load failed (${code}), retry ${devLoadRetries}/8 in 1s…`);
      setTimeout(() => { try { loadDevUrl(); } catch {} }, 1000);
    });
    loadDevUrl();
  } else {
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 启动时按设置恢复 Dock（默认显示，避免被误藏）
    try {
      const cfg = readAgentConfig();
      applyDockIconVisibility(!!cfg?.hide_dock_icon);
    } catch {
      applyDockIconVisibility(false);
    }
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
    // 窗口可见后再自动启动贡献 Agent，避免拖慢应用启动
    try {
      const cfg = readAgentConfig();
      if (cfg?.auto_start && cfg?.worker_key) {
        setImmediate(() => startAgent());
      }
    } catch {}
  });

  // 关闭 / 最小化 → 隐藏到托盘（全平台；仅「退出」才真正结束进程）
  // 注意：不在此处隐藏 Dock，Dock 可见性仅由设置 hide_dock_icon 控制
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('minimize', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ── Tray ──────────────────────────────────────────────────────────────────────

let trayStatsTimer = null;

/** macOS 26 Tahoe：菜单栏白名单设置页（Allow in the Menu Bar） */
const MENU_BAR_SETTINGS_URL = 'x-apple.systempreferences:com.apple.MenuBarSettings';
const TAHOE_HINT_PATH = path.join(os.homedir(), '.tokenbank', 'tahoe-menu-bar-hint.json');
const TAHOE_HINT_INTERVAL_MS = 24 * 60 * 60 * 1000;

function getMacOSMajorVersion() {
  try {
    const { execSync } = require('child_process');
    return parseInt(execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim().split('.')[0], 10);
  } catch { return 0; }
}

/** dev 模式在系统设置里叫 Electron，打包后叫 Token Bank */
function menuBarSettingsAppName() {
  return isDev ? 'Electron' : 'Token Bank';
}

function readTahoeHintState() {
  try {
    if (fs.existsSync(TAHOE_HINT_PATH)) return JSON.parse(fs.readFileSync(TAHOE_HINT_PATH, 'utf8'));
  } catch { /* ignore */ }
  return { lastShown: 0 };
}

function writeTahoeHintShown() {
  try {
    fs.mkdirSync(path.dirname(TAHOE_HINT_PATH), { recursive: true });
    fs.writeFileSync(TAHOE_HINT_PATH, JSON.stringify({ lastShown: Date.now() }));
  } catch { /* ignore */ }
}

/** macOS 26 可能拦截菜单栏图标，引导用户到系统设置开启 */
function showTahoeMenuBarGuidance(reason) {
  if (process.platform !== 'darwin' || getMacOSMajorVersion() < 26) return;
  const state = readTahoeHintState();
  if (Date.now() - (state.lastShown || 0) < TAHOE_HINT_INTERVAL_MS) return;

  const appName = menuBarSettingsAppName();
  writeTahoeHintShown();
  dialog.showMessageBox({
    type: 'warning',
    title: '菜单栏 Token 未显示',
    message: 'macOS Tahoe 没能在菜单栏给图标分配位置',
    detail: [
      '常见原因（按可能性排序）：',
      '1) 菜单栏图标太多——刘海屏放不下时，macOS 会直接丢弃放不下的项，',
      '   且没有溢出入口。请减少其它菜单栏图标，或安装 Ice / Bartender 做溢出收纳。',
      '2) 系统设置 → 菜单栏 → 允许在菜单栏中显示，确认已开启对应 App。',
      isDev ? '（开发模式下名字是 Electron）' : `（名字是「${appName}」）`,
      reason || '',
    ].filter(Boolean).join('\n'),
    buttons: ['打开菜单栏设置', '知道了'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) shell.openExternal(MENU_BAR_SETTINGS_URL);
  }).catch(() => {});
}

/**
 * 检测托盘是否被系统隐藏/未真正落位。Tahoe 上有两种已知情况：
 *  1) y<0（26.5 已知 y=-17，被放到屏外）；
 *  2) 幻影项：状态项必然在屏幕右侧（刘海右侧的状态区），若 getBounds 报的 x
 *     落在屏幕左半区，说明系统没给它真正的菜单栏槽位（菜单栏已满放不下），
 *     此时图标其实没被画出来——但 y/宽高都正常，老逻辑会误判为"可见"。
 */
function isTrayLikelyHidden() {
  if (!tray || tray.isDestroyed?.()) return true;
  try {
    const bounds = tray.getBounds();
    console.log('[tray] getBounds=', bounds);
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return true;
    if (bounds.y < 0) return true;
    if (process.platform === 'darwin') {
      const disp = require('electron').screen.getPrimaryDisplay();
      // 状态项落在左半区 = 没拿到右侧真实槽位（幻影），视为隐藏
      if (bounds.x < disp.workArea.width / 2) return true;
    }
  } catch (e) {
    console.warn('[tray] getBounds failed:', e.message);
  }
  return false;
}

function checkTrayVisibilityAndHint() {
  if (process.platform !== 'darwin' || getMacOSMajorVersion() < 26) return;
  if (isTrayLikelyHidden()) {
    showTahoeMenuBarGuidance('菜单栏项位置异常或被系统隐藏');
  }
}

function destroyTray() {
  if (trayStatsTimer) { clearInterval(trayStatsTimer); trayStatsTimer = null; }
  try { trayPopover.destroy(); } catch { /* ignore */ }
  if (tray && !tray.isDestroyed?.()) {
    tray.removeAllListeners();
    tray.destroy();
  }
  tray = null;
  if (trayRenderWin && !trayRenderWin.isDestroyed()) trayRenderWin.destroy();
  trayRenderWin = null; trayRenderReady = null;
}

/** 紧凑格式化 Token 数（托盘/状态栏共用） */
function fmtTrayTokens(n) {
  n = n || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function getTodayTokenSummary() {
  try { return localStats.queryTodaySummary(); }
  catch { return { inTok: 0, outTok: 0, calls: 0 }; }
}

/**
 * 托盘用：解析应用实体元数据（与 apps:list / apps:stats 一致）。
 * 持久化 apps[] 往往没有 linked_data_sources，必须从 preset/agent 实体补齐。
 */
function trayResolveAppMeta(app) {
  if (!app) return { ent: null, caps: null };
  try {
    const cl = require('./config-loader');
    // preset_id 优先（Codex Desktop 等），再试 agent_id（shim CLI）
    const ids = [...new Set([app.preset_id, app.agent_id].filter(Boolean))];
    let ent = null;
    let caps = null;
    for (const id of ids) {
      const e = cl.appEntityById(id);
      if (!e) continue;
      const c = cl.appCapabilities(id);
      // 优先选带会话用量源的实体
      if (!ent || (e.linked_data_sources || []).length > (ent.linked_data_sources || []).length) {
        ent = e;
        caps = c;
      }
      if ((e.linked_data_sources || []).length) break;
    }
    return { ent, caps };
  } catch {
    return { ent: null, caps: null };
  }
}

/**
 * 托盘用：应用关联的会话 data_source（与 resolveAppDataSources / apps:stats 对齐）。
 * 含直连（仅会话补录）应用的 session-* 来源。
 */
function trayAppDataSources(app) {
  if (!app) return { dataSources: [], usageImport: false };
  const { ent, caps } = trayResolveAppMeta(app);
  const usageImport = !!(
    app.session_usage_import
    ?? caps?.session_usage_import
    ?? ent?.session_usage_import
  );
  if (!usageImport) return { dataSources: [], usageImport: false };

  if (Array.isArray(app.linked_data_sources) && app.linked_data_sources.length) {
    return { dataSources: app.linked_data_sources, usageImport: true };
  }
  if (Array.isArray(ent?.linked_data_sources) && ent.linked_data_sources.length) {
    return { dataSources: ent.linked_data_sources, usageImport: true };
  }

  // 回退：按 agent / activity_agent 匹配 session_sources
  try {
    const cl = require('./config-loader');
    const agentKey = app.agent_id || ent?.activity_agent_id || ent?.trace_agent_id;
    if (agentKey) {
      for (const s of (cl.sessionSources() || [])) {
        if (s?.agent_id === agentKey && s.data_source) {
          return { dataSources: [s.data_source], usageImport: true };
        }
      }
    }
  } catch { /* ignore */ }
  return { dataSources: [], usageImport: true };
}

/** 单个应用当天 token / 调用次数（网关 proxy + 会话补录，与面板 apps:stats 同源） */
function trayAppTodayStats(app) {
  try {
    const { dataSources, usageImport } = trayAppDataSources(app);
    return localStats.queryAppStatsToday({
      appId: app.id,
      apiKey: app.api_key,
      dataSources,
      includeSessionImport: usageImport,
    });
  } catch {
    return { calls: 0, tokens: 0, lastTs: null };
  }
}

/**
 * 托盘是否展示该应用：与 apps:list 一致——
 * shim/direct/session 须本机真检测到；排除 hosted 但未安装的残留（如 OpenCode）。
 */
function trayAppIsPresent(app) {
  if (!app) return false;
  const method = app.link_method;
  if (method !== 'shim' && method !== 'direct' && method !== 'session') return true;
  const aid = app.agent_id || app.preset_id;
  if (!aid) return true;
  try {
    return !!require('./resource-agent-targets').isAgentInstalled(aid);
  } catch {
    return true;
  }
}

/** 单个应用近 N 天 token / 调用（托盘活跃度过滤） */
function trayAppPeriodStats(app, days = 3) {
  try {
    const { dataSources, usageImport } = trayAppDataSources(app);
    return localStats.queryAppStatsInPeriod({
      appId: app.id,
      apiKey: app.api_key,
      dataSources,
      days,
      includeSessionImport: usageImport,
    });
  } catch {
    return { calls: 0, tokens: 0, lastTs: null };
  }
}

/** 托盘悬浮窗：当前已纳管应用 + 绑定的路由/模型（logo 用 lobehub 默认品牌图）
 *  仅保留近 3 天有用量的应用，按调用次数倒序。 */
function getActiveAppsForTray(lang = 'zh') {
  const zh = lang !== 'en';
  const ACTIVITY_DAYS = 3;
  try {
    const cfg = readLocalConfig();
    const apps = (cfg.apps || []).filter(a => a && !a.draft);
    const routes = cfg.scene_routes || [];
    const routeByKey = new Map();
    for (const r of routes) {
      if (r?.id) routeByKey.set(r.id, r);
      if (r?.model_key) routeByKey.set(r.model_key, r);
    }

    const items = [];
    for (const app of apps) {
      // 活跃 = 已纳管（shim 默认 hosted!==false；其余须 hosted===true）
      const isShim = app.link_method === 'shim';
      const managed = isShim ? app.hosted !== false : app.hosted === true;
      if (!managed) continue;
      if (app.needs_dev_mode) continue;
      // 未安装残留（如 OpenCode hosted 记录）不展示
      if (!trayAppIsPresent(app)) continue;

      // 近 3 天无请求则不进托盘列表
      const period = trayAppPeriodStats(app, ACTIVITY_DAYS);
      if (!(period.calls > 0)) continue;

      const routeIds = (Array.isArray(app.route_ids) && app.route_ids.length)
        ? app.route_ids
        : (app.route_id ? [app.route_id] : []);

      const routeLabels = [];
      const probeModels = [];
      for (const rid of routeIds) {
        const r = routeByKey.get(rid);
        if (r) {
          routeLabels.push(r.scene_name || r.model_key || rid);
          probeModels.push(String(r.model_key || r.id || rid));
          continue;
        }
        // tier:model 或裸模型 id
        const raw = String(rid);
        const colon = raw.indexOf(':');
        routeLabels.push(colon > 0 ? raw.slice(colon + 1) : raw);
        probeModels.push(raw);
      }

      // 取该应用绑定模型中最好（最低）的 TTFT；全失败则标连接失败
      let bestTtft = null;
      let bestBucket = 'unknown';
      let anyOk = false;
      let anyFail = false;
      for (const mid of probeModels) {
        const key = normSpeedKey(mid);
        const probed = key ? _trayProbeCache.get(key) : null;
        if (probed) {
          if (probed.ok) anyOk = true;
          else anyFail = true;
        }
        const hit = lookupModelTtft(mid);
        if (!hit || hit.ttftMs == null) continue;
        if (bestTtft == null || hit.ttftMs < bestTtft) {
          bestTtft = hit.ttftMs;
          bestBucket = hit.bucket || 'unknown';
        }
      }

      let ttftLabel = '';
      let speedBucket = bestBucket;
      if (bestTtft != null) {
        ttftLabel = formatTtftLabel(zh ? 'zh' : 'en', bestTtft);
      } else if (anyFail && !anyOk) {
        // 探针失败 →「连接失败」，不要显示「待测速」
        ttftLabel = zh ? '连接失败' : 'Failed';
        speedBucket = 'fail';
      }

      // 当天该应用 token 消耗（与盘点页 apps:stats 同源）
      const today = trayAppTodayStats(app);
      const todayTokens = today.tokens || 0;
      const todayCalls = today.calls || 0;

      const viaGateway = routeLabels.length > 0;
      items.push({
        id: String(app.id || app.agent_id || app.preset_id || ''),
        name: String(app.name || app.agent_id || app.preset_id || 'App'),
        agentId: String(app.agent_id || app.preset_id || ''),
        linkMethod: String(app.link_method || ''),
        iconUrl: brandIconForApp(app) || '',
        emoji: (typeof app.icon === 'string' && !app.icon.startsWith('icon:')) ? app.icon : '',
        viaGateway,
        // 路由/模型文案；无绑定则官方直连
        routeLabel: viaGateway
          ? routeLabels.join(' · ')
          : (zh ? '官方直连' : 'Official'),
        tag: viaGateway ? 'ROUTE' : 'DIRECT',
        statusLabel: viaGateway
          ? (zh ? '经网关' : 'Gateway')
          : (zh ? '直连' : 'Direct'),
        ttftMs: bestTtft != null ? Math.round(bestTtft) : null,
        ttftLabel,
        speedBucket,
        speedFailed: speedBucket === 'fail',
        todayTokens,
        todayCalls,
        todayTokensLabel: fmtTrayTokens(todayTokens),
        activityCalls: period.calls || 0,
        activityTokens: period.tokens || 0,
        activityLastTs: period.lastTs || null,
        active: true,
      });
    }

    // 与面板 apps:list 一致：同一 agent 只保留一行（api-key/manual > shim > session/direct）
    // Codex Desktop/CLI 按 canonical id 合并，避免重复展示
    const { canonicalAppEntityId } = require('./app-handlers');
    const LINK_PRI = { 'api-key': 3, manual: 3, shim: 2, session: 1, direct: 1 };
    const bestByAgent = new Map();
    const noAgent = [];
    for (const item of items) {
      const aid = canonicalAppEntityId(item.agentId);
      if (!aid) { noAgent.push(item); continue; }
      const pri = LINK_PRI[item.linkMethod] || (item.viaGateway ? 3 : 0);
      const cur = bestByAgent.get(aid);
      if (!cur) {
        const named = aid === 'codex' ? { ...item, agentId: aid, name: 'Codex' } : { ...item, agentId: aid };
        bestByAgent.set(aid, named);
        continue;
      }
      const curPri = LINK_PRI[cur.linkMethod] || (cur.viaGateway ? 3 : 0);
      let keep = cur;
      let drop = item;
      if (pri > curPri
        || (pri === curPri && item.viaGateway && !cur.viaGateway)
        || (pri === curPri && item.viaGateway === cur.viaGateway && item.todayTokens > cur.todayTokens)) {
        keep = item;
        drop = cur;
      }
      // 合并重复行的今日用量与近 3 天活跃度
      const mergedTokens = Math.max(keep.todayTokens || 0, drop.todayTokens || 0);
      const mergedCalls = Math.max(keep.todayCalls || 0, drop.todayCalls || 0);
      const mergedActCalls = (keep.activityCalls || 0) + (drop.activityCalls || 0);
      const mergedActTok = (keep.activityTokens || 0) + (drop.activityTokens || 0);
      const mergedLast = Math.max(keep.activityLastTs || 0, drop.activityLastTs || 0) || null;
      bestByAgent.set(aid, {
        ...keep,
        agentId: aid,
        name: aid === 'codex' ? 'Codex' : keep.name,
        todayTokens: mergedTokens,
        todayCalls: mergedCalls,
        todayTokensLabel: fmtTrayTokens(mergedTokens),
        activityCalls: mergedActCalls,
        activityTokens: mergedActTok,
        activityLastTs: mergedLast,
      });
    }
    const deduped = [...noAgent, ...bestByAgent.values()]
      .filter((a) => (a.activityCalls || 0) > 0);

    // 按近 3 天活跃度倒序（调用次数 → 最近使用时间）
    deduped.sort((a, b) => {
      const dc = (b.activityCalls || 0) - (a.activityCalls || 0);
      if (dc) return dc;
      return (b.activityLastTs || 0) - (a.activityLastTs || 0);
    });
    return deduped;
  } catch (e) {
    console.warn('[tray] getActiveAppsForTray failed:', e.message);
    return [];
  }
}

/** 托盘：抓取各供给源官方额度（订阅窗 / 余额），供悬浮窗展示 */
async function getProvidersUsageForTray(lang = 'zh') {
  const zh = lang !== 'en';
  const usageMod = require('./usage');
  const deps = { getCfg: readAgentConfig, saveCfg: writeAgentConfig };
  const LABEL = {
    claude: 'Claude',
    codex: 'Codex',
    cursor: 'Cursor',
    copilot: 'Copilot',
    gemini: 'Gemini',
    volcengine: zh ? '火山引擎 · 订阅' : 'Volcengine · Plan',
    'volcengine-ark': zh ? '火山引擎 · 按量' : 'Volcengine · PAYG',
    openrouter: 'OpenRouter',
    deepseek: 'DeepSeek',
    siliconflow: zh ? '硅基流动' : 'SiliconFlow',
    'kimi-code': 'Kimi Code',
    minimax: 'MiniMax',
    zhipu: zh ? '智谱' : 'Zhipu',
    'agnes-ai': 'Agnes AI',
  };

  const seen = new Set();
  const snaps = [];

  const pushSnap = (r) => {
    if (!r || r.error && !(r.windows || []).length && !r.credits) return;
    const key = String(r.provider || r.id || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    snaps.push(r);
  };

  try {
    for (const r of await usageMod.fetchAllUsage(deps)) pushSnap(r);
  } catch (e) {
    console.warn('[tray] fetchAllUsage:', e.message);
  }

  // 直连 App 可能无 gateway 启用条目：补抓 CLI/IDE 凭证
  for (const k of ['claude', 'codex', 'cursor', 'copilot', 'gemini']) {
    if (seen.has(k)) continue;
    const syn = usageMod.syntheticProvider(k);
    if (!syn || !usageMod.hasCredential(syn)) continue;
    try { pushSnap(await usageMod.fetchUsage(syn, deps)); } catch { /* ignore */ }
  }

  const fmtBal = (c) => {
    if (!c) return null;
    if (c.unlimited) {
      const u = c.used != null ? Number(c.used) : null;
      if (u == null || !Number.isFinite(u)) return zh ? '无限' : 'Unlimited';
      if (c.currency === 'CNY') return `${zh ? '已用 ¥' : 'Used ¥'}${u.toFixed(2).replace(/\.?0+$/, '')}`;
      return `${zh ? '已用 $' : 'Used $'}${u.toFixed(2)}`;
    }
    const v = c.remaining != null ? c.remaining : c.total;
    if (v == null || !Number.isFinite(Number(v))) return null;
    const n = Number(v);
    if (c.currency === 'CNY') return `¥${n.toFixed(2).replace(/\.?0+$/, '')}`;
    if (c.currency === 'USD') return `$${n.toFixed(2)}`;
    return String(n);
  };

  const out = [];
  for (const r of snaps) {
    const key = String(r.provider || r.id || '');
    const wins = (r.windows || []).filter((w) => w && w.usageKnown && w.usedPercent != null);
    const primary = r.primary || wins[0] || null;
    const pct = primary && primary.usageKnown ? Number(primary.usedPercent) : null;
    const bal = fmtBal(r.credits);
    // 紧凑摘要：优先主窗口百分比，否则余额
    let summary = '';
    if (pct != null && Number.isFinite(pct)) summary = `${Math.round(pct)}%`;
    else if (bal) summary = bal;
    else continue;

    // 多窗口时附加短标签（5h / 周）
    let detail = '';
    if (wins.length >= 2) {
      detail = wins.slice(0, 3).map((w) => {
        const t = w.id === 'five_hour' || w.windowMinutes === 300 ? '5h'
          : (w.id === 'seven_day' || w.id === 'weekly' ? (zh ? '周' : 'wk')
            : (w.id === 'monthly' ? (zh ? '月' : 'mo') : (w.title || '').slice(0, 4)));
        return `${t} ${Math.round(w.usedPercent)}%`;
      }).join(' · ');
    }

    const nearLimit = (pct != null && pct >= 80)
      || wins.some((w) => Number(w.usedPercent) >= 80);

    out.push({
      id: key,
      label: LABEL[key] || r.plan || key,
      plan: r.plan ? String(r.plan) : '',
      summary,
      detail,
      usedPercent: pct != null && Number.isFinite(pct) ? pct : null,
      nearLimit: !!nearLimit,
    });
  }

  // 近 3 天本地请求活跃度：映射到 usage key，过滤无活跃项并倒序
  const ACTIVITY_DAYS = 3;
  const actByKey = new Map(); // usageKey → { calls, tokens, lastTs }
  try {
    const cfg = readAgentConfig() || {};
    const idToKey = new Map();
    for (const p of (cfg.providers || [])) {
      if (!p || !p.id) continue;
      const uk = usageMod.usageProviderName(p);
      if (uk) idToKey.set(String(p.id), uk);
    }
    for (const row of localStats.queryProviderActivity(ACTIVITY_DAYS)) {
      const pid = row.providerId;
      let uk = idToKey.get(pid)
        || usageMod.normalizeUsageKey(pid)
        || usageMod.usageProviderName({ id: pid })
        || null;
      // acct-* 等自定义 id 已通过 idToKey；normalize 可能原样返回无抓取器的 id
      if (uk && !usageMod.USAGE_FETCHERS[uk] && !LABEL[uk]) {
        // 仍按原始 id 聚合，便于与 snap.id 对上
        uk = pid;
      }
      if (!uk) continue;
      const cur = actByKey.get(uk) || { calls: 0, tokens: 0, lastTs: null };
      cur.calls += row.calls || 0;
      cur.tokens += row.tokens || 0;
      cur.lastTs = Math.max(cur.lastTs || 0, row.lastTs || 0) || null;
      actByKey.set(uk, cur);
      // 同时记在原始 provider_id 上，方便 snap.id 为网关 id 时命中
      if (pid !== uk) {
        const raw = actByKey.get(pid) || { calls: 0, tokens: 0, lastTs: null };
        raw.calls += row.calls || 0;
        raw.tokens += row.tokens || 0;
        raw.lastTs = Math.max(raw.lastTs || 0, row.lastTs || 0) || null;
        actByKey.set(pid, raw);
      }
    }
  } catch (e) {
    console.warn('[tray] provider activity:', e.message);
  }

  const withAct = out.map((u) => {
    const act = actByKey.get(u.id) || { calls: 0, tokens: 0, lastTs: null };
    return {
      ...u,
      activityCalls: act.calls || 0,
      activityLastTs: act.lastTs || null,
    };
  }).filter((u) => (u.activityCalls || 0) > 0);

  withAct.sort((a, b) => {
    const dc = (b.activityCalls || 0) - (a.activityCalls || 0);
    if (dc) return dc;
    return (b.activityLastTs || 0) - (a.activityLastTs || 0);
  });
  return withAct;
}

/** 活跃应用已选路由/模型 → 测速探针目标（去重） */
function collectProbeModelsFromActiveApps() {
  try {
    const cfg = readLocalConfig();
    const apps = (cfg.apps || []).filter(a => a && !a.draft);
    const routes = cfg.scene_routes || [];
    const routeByKey = new Map();
    for (const r of routes) {
      if (r?.id) routeByKey.set(r.id, r);
      if (r?.model_key) routeByKey.set(r.model_key, r);
    }
    const models = new Set();
    for (const app of apps) {
      const isShim = app.link_method === 'shim';
      const managed = isShim ? app.hosted !== false : app.hosted === true;
      if (!managed || app.needs_dev_mode) continue;
      if (!trayAppIsPresent(app)) continue;
      const routeIds = (Array.isArray(app.route_ids) && app.route_ids.length)
        ? app.route_ids
        : (app.route_id ? [app.route_id] : []);
      for (const rid of routeIds) {
        if (!rid) continue;
        const scene = routeByKey.get(rid);
        if (scene) {
          // 场景路由：网关按 model_key 拦截
          const key = scene.model_key || scene.id;
          if (key) models.add(String(key));
          continue;
        }
        models.add(String(rid));
      }
    }
    return [...models];
  } catch (e) {
    console.warn('[tray] collectProbeModels failed:', e.message);
    return [];
  }
}

/** 归一化测速 key（与 provider-speed.normKey 一致） */
function normSpeedKey(id) {
  if (!id) return '';
  let s = String(id).trim().toLowerCase();
  const slash = s.lastIndexOf('/');
  if (slash >= 0) s = s.slice(slash + 1);
  return s;
}

// 托盘测速结果缓存：model → { ttftMs, latencyMs, ok, ts }
const _trayProbeCache = new Map();

/** 查某模型首字延迟：优先刚测完的探针缓存，其次 gateway-speed 持久表 */
function lookupModelTtft(modelId) {
  const key = normSpeedKey(modelId);
  if (!key) return null;
  const probed = _trayProbeCache.get(key);
  // 最近一次探针失败 → 不回落历史测速，交给上层显示「连接失败」
  if (probed && probed.ok === false) return null;
  if (probed && probed.ok && probed.ttftMs != null) {
    return { ttftMs: probed.ttftMs, bucket: ttftBucket(probed.ttftMs), source: 'probe' };
  }
  try {
    const map = require('./provider-speed').getSpeedMap();
    const sp = map[key];
    if (sp && sp.ttft_ms != null) {
      return { ttftMs: sp.ttft_ms, bucket: sp.bucket || ttftBucket(sp.ttft_ms), source: 'speed' };
    }
    // 无 TTFT 时用总延迟兜底展示
    if (sp && sp.lat_ms != null) {
      return { ttftMs: sp.lat_ms, bucket: sp.bucket || ttftBucket(sp.lat_ms), source: 'lat' };
    }
  } catch { /* ignore */ }
  if (probed && probed.ok && probed.latencyMs != null) {
    return { ttftMs: probed.latencyMs, bucket: ttftBucket(probed.latencyMs), source: 'probe-lat' };
  }
  return null;
}

function ttftBucket(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return 'unknown';
  if (v > 4000) return 'slow';
  return 'fast';
}

function formatTtftLabel(lang, ttftMs) {
  if (ttftMs == null || !Number.isFinite(ttftMs)) return '';
  const ms = Math.round(ttftMs);
  // 中英文统一用 TTFT，避免「首字 / TTFT」混用
  return `TTFT ${ms}ms`;
}

/** 对活跃应用绑定的模型/路由逐个发探针测速 */
async function probeActiveAppModels() {
  const targets = collectProbeModelsFromActiveApps();
  const results = [];
  for (const model of targets) {
    try {
      const r = await probeModelViaGateway(model);
      const key = normSpeedKey(model);
      const ttftMs = (r && r.firstTokenMs != null) ? Number(r.firstTokenMs) : null;
      const latencyMs = (r && r.latencyMs != null) ? Number(r.latencyMs) : null;
      if (key) {
        _trayProbeCache.set(key, {
          ttftMs: Number.isFinite(ttftMs) ? ttftMs : null,
          latencyMs: Number.isFinite(latencyMs) ? latencyMs : null,
          ok: !!(r && r.ok),
          ts: Date.now(),
        });
      }
      // 探针拿到真实首字后，立刻写入 speed 表，UI 与供给源页一致
      // record() 要求 total-ttft>50 才认作真实 TTFT，探针短回复时补一点余量
      if (r?.ok && Number.isFinite(ttftMs) && Number.isFinite(latencyMs)) {
        try {
          require('./provider-speed').record(model, {
            firstTokenMs: ttftMs,
            outputTokens: 1,
            totalMs: Math.max(latencyMs, ttftMs + 60),
            streaming: true,
          });
        } catch { /* ignore */ }
      }
      results.push({ model, ...(r || {}), ttftMs });
    } catch (e) {
      const key = normSpeedKey(model);
      if (key) {
        _trayProbeCache.set(key, { ttftMs: null, latencyMs: null, ok: false, ts: Date.now() });
      }
      results.push({ model, ok: false, error: e.message });
    }
  }
  return { ok: true, total: targets.length, results };
}

// 圈子帖子数量缓存（托盘第三胶囊）
let _circlePostsCache = { count: 0, fetchedAt: 0, ok: false, loggedIn: false };

/** 解析 nodeRequest 的 JSON body；失败返回 null */
function parseNodeJson(res) {
  if (!res || res.status < 200 || res.status >= 300 || !res.body) return null;
  try { return JSON.parse(res.body); } catch { return null; }
}

/** 拉取用户已加入圈子的帖子总数（托盘第三胶囊，替代 Agent 状态） */
async function refreshCirclePostsCache() {
  try {
    const cfg = readLocalConfig();
    const base = String(cfg?.cloud_config?.url || '').replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
    const token = cfg?.cloud_config?.token || '';
    if (!base || !token) {
      _circlePostsCache = { count: 0, fetchedAt: Date.now(), ok: false, loggedIn: false };
      return _circlePostsCache;
    }
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const joinedRes = await nodeRequest(`${base}/user/circles/joined`, 'GET', headers, null, { timeoutMs: 8000 });
    const joined = parseNodeJson(joinedRes);
    if (!joined) {
      // 401 等视为未登录
      const loggedIn = joinedRes?.status !== 401 && joinedRes?.status !== 403;
      _circlePostsCache = { count: 0, fetchedAt: Date.now(), ok: false, loggedIn };
      return _circlePostsCache;
    }
    const circles = Array.isArray(joined.circles) ? joined.circles : [];
    let count = 0;
    // 限制并发：最多扫 8 个圈子，避免托盘卡顿
    const slice = circles.slice(0, 8);
    await Promise.all(slice.map(async (c) => {
      if (!c?.id) return;
      try {
        const detailRes = await nodeRequest(`${base}/user/circles/${c.id}`, 'GET', headers, null, { timeoutMs: 8000 });
        const detail = parseNodeJson(detailRes);
        const posts = Array.isArray(detail?.posts) ? detail.posts : [];
        count += posts.length;
      } catch { /* ignore single circle */ }
    }));
    _circlePostsCache = { count, fetchedAt: Date.now(), ok: true, loggedIn: true };
    return _circlePostsCache;
  } catch (e) {
    console.warn('[tray] circle posts fetch failed:', e.message);
    _circlePostsCache = {
      count: _circlePostsCache.count || 0,
      fetchedAt: Date.now(),
      ok: false,
      loggedIn: !!_circlePostsCache.loggedIn,
    };
    return _circlePostsCache;
  }
}

function getCirclePostsSummary() {
  return {
    count: _circlePostsCache.count || 0,
    ok: !!_circlePostsCache.ok,
    loggedIn: !!_circlePostsCache.loggedIn,
    fetchedAt: _circlePostsCache.fetchedAt || 0,
  };
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** 构建托盘右键菜单（每次弹出时现建，避免 setContextMenu 清掉 macOS 标题） */
function buildTrayContextMenu() {
  const running = agent.isRunning();
  const gw = gateway.getStatus?.() || {};
  const { inTok, outTok, calls } = getTodayTokenSummary();
  const L = TRAY_LABELS[_trayLang] || TRAY_LABELS.zh;
  return Menu.buildFromTemplate([
    { label: gw.running ? L.gatewayRunning(gw.port) : L.gatewayStopped, enabled: false },
    { label: L.todayToken(`↑${fmtTrayTokens(inTok)}`, `↓${fmtTrayTokens(outTok)}`, calls), enabled: false },
    { label: running ? L.agentRunning : L.agentStopped, enabled: false },
    { type: 'separator' },
    { label: L.showWindow, click: showMainWindow },
    ...(process.platform === 'darwin' ? [{
      label: L.showTokens,
      type: 'checkbox',
      checked: showTrayTokens,
      click: (mi) => {
        showTrayTokens = mi.checked;
        try { const c = readLocalConfig(); c.tray_show_tokens = mi.checked; writeLocalConfig(c); } catch {}
        refreshTray();
      },
    }] : []),
    { type: 'separator' },
    {
      label: L.startAgent,
      enabled: !running,
      click: () => {
        if (!_trayUserLoggedIn) {
          showMainWindow();
          mainWindow?.webContents?.send('app:navigate', '/login');
        } else {
          startAgent();
        }
      },
    },
    { label: L.stopAgent, enabled: running, click: stopAgent },
    { type: 'separator' },
    { label: L.quit, click: () => { isQuitting = true; app.quit(); } },
  ]);
}


// ── macOS 菜单栏：离屏 canvas 把「黑底白字 T 徽标 + 两行小字」画成彩色图 ──────────────
// setTitle 不能调字号，所以自己画成图。徽标固定黑底白 T；两行数字按系统深/浅色切换颜色
// （深色菜单栏白字、浅色黑字），两种菜单栏下都清楚。用隐藏窗口的 Chromium canvas 渲染，零额外依赖。
let trayRenderWin = null;
let trayRenderReady = null;
function ensureTrayRenderWin() {
  if (trayRenderWin && !trayRenderWin.isDestroyed()) return trayRenderReady;
  trayRenderWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  trayRenderReady = trayRenderWin.webContents.loadURL('about:blank').then(() => trayRenderWin);
  return trayRenderReady;
}

/** 画出托盘彩色图：黑底白 T 徽标 +（showText 时）↑in / ↓out 两行小字。返回 nativeImage（@2x）。 */
async function renderTrayImage(line1, line2, showText, dark) {
  const win = await ensureTrayRenderWin();
  const js = `(() => {
    const S = 2;
    const H = 22 * S, padX = 1 * S, gap = 4 * S;
    const r = 9 * S, txtFs = 8.5 * S;
    const show = ${showText ? 'true' : 'false'};
    const fg = ${dark ? "'#fff'" : "'#000'"};
    const L1 = ${JSON.stringify(line1)}, L2 = ${JSON.stringify(line2)};
    let c = document.createElement('canvas'), x = c.getContext('2d');
    x.font = '600 ' + txtFs + 'px ui-monospace,Menlo,monospace';
    const tW = show ? Math.ceil(Math.max(x.measureText(L1).width, x.measureText(L2).width)) : 0;
    c.width = padX + 2 * r + (show ? gap + tW : 0) + padX;
    c.height = H;
    x = c.getContext('2d');
    x.textBaseline = 'middle';
    const cx = padX + r, cy = H / 2;
    // SVG 设计基准：viewBox 32×32，圆心(16,16)，外圈 r=14.5
    // 映射比例：canvas r=9*S → SVG r=14.5，scale = (r-1)/14.5
    const sc = (r - 1) / 14.5;
    // 粗圈
    x.strokeStyle = fg; x.lineWidth = 2.2 * S;
    x.beginPath(); x.arc(cx, cy, r - 1.5, 0, Math.PI * 2); x.stroke();
    // 三节点位置：与 SVG 一致（顶1底2）
    // SVG: top(16,4) bl(5.5,22) br(26.5,22)，相对中心(16,16)
    const nodes = [
      [cx + (16 - 16) * sc, cy + (4  - 16) * sc],  // top
      [cx + (5.5 - 16) * sc, cy + (22 - 16) * sc], // bottom-left
      [cx + (26.5- 16) * sc, cy + (22 - 16) * sc], // bottom-right
    ];
    // 连线（节点间 + 节点→中心）
    x.strokeStyle = fg; x.lineWidth = 0.65 * S; x.globalAlpha = 0.65; x.lineCap = 'round';
    [[0,1],[0,2],[1,2]].forEach(([a,b]) => {
      x.beginPath(); x.moveTo(nodes[a][0], nodes[a][1]); x.lineTo(nodes[b][0], nodes[b][1]); x.stroke();
    });
    nodes.forEach(([nx, ny]) => {
      x.beginPath(); x.moveTo(nx, ny); x.lineTo(cx, cy); x.stroke();
    });
    x.globalAlpha = 1;
    // 外节点实心点
    x.fillStyle = fg;
    nodes.forEach(([nx, ny]) => { x.beginPath(); x.arc(nx, ny, 1.4 * S, 0, Math.PI * 2); x.fill(); });
    // 中心圆
    x.beginPath(); x.arc(cx, cy, 7.5 * sc, 0, Math.PI * 2); x.fill();
    // 中心 T（镂空）
    x.globalCompositeOperation = 'destination-out';
    x.strokeStyle = 'rgba(0,0,0,1)'; x.lineCap = 'round'; x.lineWidth = 1.5 * S;
    const tw = 2.4 * S;
    x.beginPath(); x.moveTo(cx - tw, cy - 2.0 * S); x.lineTo(cx + tw, cy - 2.0 * S); x.stroke();
    x.beginPath(); x.moveTo(cx, cy - 2.0 * S); x.lineTo(cx, cy + 2.8 * S); x.stroke();
    x.globalCompositeOperation = 'source-over';
    // 两行数字
    if (show) {
      x.fillStyle = fg;
      x.font = '600 ' + txtFs + 'px ui-monospace,Menlo,monospace';
      x.textAlign = 'left'; x.textBaseline = 'middle';
      const tx = padX + 2 * r + gap;
      x.fillText(L1, tx, H * 0.32);
      x.fillText(L2, tx, H * 0.72);
    }
    return c.toDataURL('image/png');
  })()`;
  const dataURL = await win.webContents.executeJavaScript(js);
  const buf = Buffer.from(dataURL.split(',')[1], 'base64');
  const img = nativeImage.createFromBuffer(buf, { scaleFactor: 2 });
  img.setTemplateImage(false);
  return img;
}

/**
 * 统一刷新托盘外观。
 * macOS：图标+两行小字渲染成单色模板图（字号自定、深浅色自适应），开关关掉时只画 T。
 * 其它平台：绿/灰图标 + tooltip。
 */
let _lastTrayImportTs = 0;
function refreshTray() {
  if (!tray || tray.isDestroyed?.()) return;
  // 同步 session import，保证与 modal 数据一致；每 60s 最多跑一次
  const now = Date.now();
  if (now - _lastTrayImportTs > 60000) {
    try { scheduleSessionTelemetry(); } catch {}
    _lastTrayImportTs = now;
  }
  const gw = gateway.getStatus?.() || {};
  const active = agent.isRunning() || gw.running;
  // 自定义悬浮窗：不再每次 refresh 绑定原生 Context Menu（左键改为 popover）
  try { trayPopover.refresh(); } catch { /* ignore */ }
  if (process.platform === 'darwin') {
    const { inTok, outTok } = getTodayTokenSummary();
    const k = (n) => { n = n || 0; return n >= 1e6 ? `${Math.round(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`; };
    const l1 = `↑${k(inTok)}`, l2 = `↓${k(outTok)}`;
    tray.setToolTip(`Token Bank · 今日 ${l1} ${l2}`);
    renderTrayImage(l1, l2, showTrayTokens, nativeTheme.shouldUseDarkColors)
      .then((img) => { if (tray && !tray.isDestroyed?.()) { tray.setImage(img); tray.setTitle(''); } })
      .catch((e) => {
        // 渲染失败兜底：退回系统字号 setTitle
        console.warn('[tray] render image failed, fallback to setTitle:', e.message);
        if (tray && !tray.isDestroyed?.()) tray.setTitle(showTrayTokens ? `${l1}\n${l2}` : '', { fontType: 'monospacedDigit' });
      });
  } else {
    const { inTok, outTok } = getTodayTokenSummary();
    const gwHint = gw.running ? `网关 :${gw.port}` : '网关已停止';
    tray.setImage(getTrayIcon(active ? 'running' : 'stopped'));
    tray.setToolTip(`Token Bank · ${gwHint} · 今日 ↑${fmtTrayTokens(inTok)} ↓${fmtTrayTokens(outTok)}`);
  }
}

/**
 * 极简托盘（参考 clawd-on-desk / AIUsage）：Template 图标 + 自定义毛玻璃悬浮窗。
 * 左键弹出 tray-popover；右键保留原生菜单作兜底。
 */
function createTray() {
  if (tray && !tray.isDestroyed?.()) { refreshTray(); return; }
  try { showTrayTokens = readLocalConfig().tray_show_tokens !== false; } catch {}
  try { _trayUserLoggedIn = !!readLocalConfig().cloud_config?.token; } catch {}

  // 注入依赖，供悬浮窗读写状态 / 触发动作
  trayPopover.init({
    getGatewayStatus: () => gateway.getStatus?.() || {},
    getTodaySummary: getTodayTokenSummary,
    isAgentRunning: () => agent.isRunning(),
    getLang: () => _trayLang,
    getShowTokens: () => showTrayTokens,
    setShowTokens: (v) => {
      showTrayTokens = !!v;
      try {
        const c = readLocalConfig();
        c.tray_show_tokens = !!v;
        writeLocalConfig(c);
      } catch { /* ignore */ }
    },
    fmtTokens: fmtTrayTokens,
    showMainWindow,
    quitApp: () => { isQuitting = true; app.quit(); },
    startAgent,
    stopAgent,
    isUserLoggedIn: () => _trayUserLoggedIn,
    navigateLogin: () => {
      showMainWindow();
      try { mainWindow?.webContents?.send('app:navigate', '/login'); } catch { /* ignore */ }
    },
    refreshTrayIcon: () => { try { refreshTray(); } catch { /* ignore */ } },
    // 托盘刷新只读本地统计，不触发 session 全量导入
    syncStats: () => {},
    getActiveApps: () => getActiveAppsForTray(_trayLang),
    getProvidersUsage: () => getProvidersUsageForTray(_trayLang),
    probeActiveModels: () => probeActiveAppModels(),
    refreshCirclePosts: () => refreshCirclePostsCache(),
    getCirclePosts: () => getCirclePostsSummary(),
    // 托盘「资源」：今日取用 + 快捷口令
    getGeneralsSlice: () => {
      try {
        const resourceManager = require('./resource-manager');
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const todayCount = resourceManager.countResourceHitsSince(start.getTime(), ['assistant']);
        const lang = _trayLang === 'en' ? 'en' : 'zh';
        const quickInvokes = [];
        for (const cid of ['cursor', 'claude-code', 'codex']) {
          const rows = resourceManager.listQuickInvokeAssistants(cid, 3) || [];
          for (const row of rows) {
            if (quickInvokes.some((q) => q.id === row.id)) continue;
            const name = row.display_name || row.name;
            const invokeText = lang === 'en'
              ? `Summon the "${name}" agent from Token Bank to complete this task.`
              : `召唤 Token Bank 中的「${name}」智能体来完成当前任务。`;
            quickInvokes.push({
              id: row.id,
              displayName: name,
              clientId: cid,
              invokeText,
            });
            if (quickInvokes.length >= 3) break;
          }
          if (quickInvokes.length >= 3) break;
        }
        return { todayCount, quickInvokes };
      } catch (e) {
        console.warn('[tray] getGeneralsSlice:', e.message);
        return { todayCount: 0, quickInvokes: [] };
      }
    },
    copyText: (text) => {
      try { require('electron').clipboard.writeText(String(text || '')); } catch { /* ignore */ }
    },
    navigateResources: () => {
      showMainWindow();
      try { mainWindow?.webContents?.send('app:navigate', '/resources'); } catch { /* ignore */ }
    },
  });

  try {
    // macOS：黑底白字 T 图标（左）+ 两行 Token 文字（右，可由菜单开关关掉）；其它平台：绿/灰圆点
    const icon = getTrayIcon(agent.isRunning() ? 'running' : 'stopped');
    tray = new Tray(icon && !icon.isEmpty() ? icon : nativeImage.createEmpty());
  } catch (e) {
    console.error('[tray] create failed:', e.message);
    return;
  }
  if (process.platform === 'darwin') tray.setIgnoreDoubleClickEvents(true);
  tray.on('double-click', showMainWindow);
  // 左键：自定义悬浮窗（各平台一致）
  tray.on('click', () => {
    // 只弹窗 + 刷圈子；不在此处跑 session 导入（已有 30s 定时任务，避免反复扫盘）
    trayPopover.toggle(tray);
    setTimeout(() => {
      refreshCirclePostsCache().then(() => { try { trayPopover.refresh(); } catch {} }).catch(() => {});
    }, 50);
  });
  // 右键：原生菜单兜底
  tray.on('right-click', (_e, bounds) => {
    try {
      tray.popUpContextMenu(buildTrayContextMenu(), bounds);
    } catch {
      try { tray.popUpContextMenu(buildTrayContextMenu()); } catch { /* ignore */ }
    }
  });
  refreshTray();
  // 预热悬浮窗，消除首次打开的 loadFile 延迟
  setTimeout(() => { try { trayPopover.warmup(); } catch {} }, 800);
  trayStatsTimer = setInterval(refreshTray, 30000);
  // 系统深/浅色切换时重画（数字颜色要跟着变）
  if (process.platform === 'darwin') {
    nativeTheme.removeAllListeners('updated');
    nativeTheme.on('updated', refreshTray);
    setTimeout(checkTrayVisibilityAndHint, 2500);
  }
}

/** 兼容旧调用：状态/用量变化时刷新托盘 */
function updateTrayMenu() { refreshTray(); }

// ── Agent ─────────────────────────────────────────────────────────────────────

const _agentLogBuf = [];   // keep last 200 lines for late-mounting pages
const AGENT_LOG_MAX = 200;

// 安全给渲染层发消息：窗口/ webContents 在退出时可能已销毁（?. 只挡 null，挡不住「已销毁」），
// 直接 send 会抛 "Object has been destroyed" 崩主进程（尤其 before-quit → agent.stop → log → onLog）。
function safeSend(channel, ...args) {
  try {
    const wc = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
  } catch { /* 退出时窗口已拆除，忽略 */ }
}

function startAgent() {
  console.log('[main] startAgent called, isRunning=', agent.isRunning());
  agent.start({
    onLog: (line) => {
      console.log('[agent-log]', line);
      _agentLogBuf.push(line);
      if (_agentLogBuf.length > AGENT_LOG_MAX) _agentLogBuf.shift();
      safeSend('agent:log', line);
    },
    onStatus: (status) => {
      console.log('[main] agent status', status);
      safeSend('agent:status', status);
      updateTrayMenu();
    },
  });
  updateTrayMenu();
}

function stopAgent() {
  agent.stop();
  updateTrayMenu();
}

// ── Auto updater ──────────────────────────────────────────────────────────────

/** 已下载、待用户重启安装的版本（侧栏标识用） */
let pendingUpdateReady = null;
let updaterRendererReady = false;
const pendingUpdateEvents = [];
let updaterEventsBound = false;

function pushUpdateEvent(channel, data) {
  if (updaterRendererReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
    return;
  }
  pendingUpdateEvents.push({ channel, data });
}

function markUpdaterRendererReady() {
  updaterRendererReady = true;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const { channel, data } of pendingUpdateEvents) {
    mainWindow.webContents.send(channel, data);
  }
  pendingUpdateEvents.length = 0;
}

/** 是否接收 beta/alpha/rc 预发布（用户可在设置页覆盖） */
function readUpdaterAllowPrerelease() {
  try {
    const v = readLocalConfig().updater_allow_prerelease;
    if (typeof v === 'boolean') return v;
  } catch { /* 首次启动无配置 */ }
  // 未显式设置时：当前安装包为预发布则默认可升预发布
  return /-(alpha|beta|rc)/i.test(String(app.getVersion() || ''));
}

function applyUpdaterAllowPrerelease(allow) {
  const v = allow != null ? !!allow : readUpdaterAllowPrerelease();
  autoUpdater.allowPrerelease = v;
  return v;
}

function persistUpdaterAllowPrerelease(allow) {
  const cfg = readLocalConfig();
  cfg.updater_allow_prerelease = !!allow;
  writeLocalConfig(cfg);
  return applyUpdaterAllowPrerelease(!!allow);
}

function resetUpdaterFeedDefault(allowPrerelease) {
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'wink-run',
    repo: 'tokenbank',
  });
  autoUpdater.allowPrerelease = allowPrerelease;
}

/**
 * 通过 GitHub API 解析最新 release，并指向具体 tag 的 yml。
 * 修复 0.4.9-betaN 版本号导致 electron-updater channel 匹配失败的问题。
 */
async function prepareUpdaterFeed() {
  const allowPrerelease = applyUpdaterAllowPrerelease();
  const current = app.getVersion();
  try {
    const latestTag = await findLatestReleaseTag(allowPrerelease);
    if (!latestTag || !isRemoteNewer(current, latestTag)) {
      resetUpdaterFeedDefault(allowPrerelease);
      return { allowPrerelease, hasUpdate: false, latestTag };
    }
    autoUpdater.setFeedURL(feedUrlForTag(latestTag));
    autoUpdater.allowPrerelease = allowPrerelease;
    console.info('[updater] targeting release:', latestTag);
    return { allowPrerelease, hasUpdate: true, latestTag };
  } catch (err) {
    console.warn('[updater] resolve latest release failed:', err.message);
    resetUpdaterFeedDefault(allowPrerelease);
    return { allowPrerelease, hasUpdate: null, error: err.message };
  }
}

function bindUpdaterEvents() {
  if (updaterEventsBound) return;
  updaterEventsBound = true;

  autoUpdater.on('update-available', (info) => {
    console.info('[updater] update available:', info.version);
    pushUpdateEvent('update:available', {
      version: info.version,
      releaseNotes: info.releaseNotes ?? null,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    pushUpdateEvent('update:progress', {
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.info('[updater] update downloaded:', info.version);
    pendingUpdateReady = { version: info.version };
    pushUpdateEvent('update:downloaded', { version: info.version });
  });

  autoUpdater.on('update-not-available', (info) => {
    console.info('[updater] already on latest:', app.getVersion(), '(remote:', info?.version, ')');
    pushUpdateEvent('update:not-available', { version: app.getVersion() });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] error:', err.message);
    if (!pendingUpdateReady) {
      pushUpdateEvent('update:error', { message: err.message });
    }
  });
}

async function runUpdaterCheck() {
  const prep = await prepareUpdaterFeed();
  if (prep.hasUpdate === false) {
    console.info('[updater] already on latest:', app.getVersion());
    return null;
  }
  return autoUpdater.checkForUpdates().catch((err) => {
    console.error('[updater] checkForUpdates error:', err.message);
    throw err;
  });
}

/** 手动检查：等待 available / not-available / error 其一 */
async function checkForUpdatesAndWait(timeoutMs = 60000) {
  const prep = await prepareUpdaterFeed();
  if (prep.hasUpdate === false) {
    return { status: 'latest', version: app.getVersion() };
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      autoUpdater.removeListener('update-available', onAvail);
      autoUpdater.removeListener('update-not-available', onNotAvail);
      autoUpdater.removeListener('error', onErr);
      resolve(payload);
    };
    const onAvail = (info) => finish({ status: 'available', version: info.version });
    const onNotAvail = () => finish({ status: 'latest', version: app.getVersion() });
    const onErr = (err) => finish({ status: 'error', message: err?.message || String(err) });
    const timer = setTimeout(() => finish({ status: 'error', message: 'check timeout' }), timeoutMs);
    autoUpdater.once('update-available', onAvail);
    autoUpdater.once('update-not-available', onNotAvail);
    autoUpdater.once('error', onErr);
    autoUpdater.checkForUpdates().catch((e) => finish({ status: 'error', message: e.message }));
  });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  // macOS：MacUpdater 在 autoInstallOnAppQuit=true 时会在下载后预取 Squirrel；
  // 预取失败时 UI 已显示「就绪」，但 quitAndInstall 不会再次 checkForUpdates → 立即重启无反应。
  // 设为 false，让「立即重启」时再触发 Squirrel 拉取并安装。普通退出本身也不会装包。
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'darwin';
  autoUpdater.logger = console;
  applyUpdaterAllowPrerelease();
  bindUpdaterEvents();

  const CHECK_DELAY_MS = 3000;
  const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

  function scheduleInitialCheck() {
    setTimeout(() => {
      markUpdaterRendererReady();
      runUpdaterCheck();
    }, CHECK_DELAY_MS);
  }

  // 等页面加载 + React 挂载 listener 后再检查；若 init 较慢导致 did-finish-load 已触发则立即排期
  if (mainWindow && !mainWindow.isDestroyed()) {
    const wc = mainWindow.webContents;
    if (wc.isLoading()) {
      wc.once('did-finish-load', scheduleInitialCheck);
    } else {
      scheduleInitialCheck();
    }
  } else {
    scheduleInitialCheck();
  }

  setInterval(() => runUpdaterCheck(), CHECK_INTERVAL_MS);
}

/** 清理失效的 ShipIt 状态，避免卡住后续自动安装 */
function clearStaleShipItState() {
  if (process.platform !== 'darwin') return;
  try {
    const statePath = path.join(os.homedir(), 'Library/Caches', 'com.tokenbank.app.ShipIt', 'ShipItState.plist');
    if (!fs.existsSync(statePath)) return;
    const raw = fs.readFileSync(statePath, 'utf8').trim();
    let state = null;
    try { state = JSON.parse(raw); } catch { /* 旧版可能是 XML plist */ }
    const updateUrl = state?.updateBundleURL || '';
    if (!updateUrl.startsWith('file://')) return;
    const localPath = decodeURIComponent(updateUrl.replace(/^file:\/\//, ''));
    if (localPath && !fs.existsSync(localPath)) {
      console.warn('[updater] clearing stale ShipItState pointing to missing', localPath);
      fs.unlinkSync(statePath);
    }
  } catch (e) {
    console.warn('[updater] clearStaleShipItState:', e.message);
  }
}

/** 退出前清理：托盘驻留 / 关窗隐藏会拦住 quitAndInstall */
function prepareQuitForUpdateInstall() {
  isQuitting = true;
  app.removeAllListeners('window-all-closed');
  try { destroyTray(); } catch (e) {
    console.warn('[updater] destroyTray before install:', e.message);
  }
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (win.isDestroyed()) continue;
      win.removeAllListeners('close');
      win.removeAllListeners('minimize');
      win.close();
    } catch { /* ignore */ }
  }
}

function runExitCleanupForUpdate() {
  try { agent.stop(); } catch { /* ignore */ }
  try { gateway.stop(); } catch { /* ignore */ }
  try { localStats.close(); } catch { /* ignore */ }
  try { revertCliInstanceEndpointConfigs(); } catch { /* ignore */ }
  try { agentLinker.revertEverythingOnExit(); } catch { /* ignore */ }
}

/** 自动安装卡住时，打开对应 dmg 供手动覆盖安装 */
function openManualUpdateDmg(version) {
  const ver = String(version || '').replace(/^v/i, '');
  if (!ver) return;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const url = `https://github.com/wink-run/tokenbank/releases/download/v${ver}/Token-Bank-${ver}-${arch}.dmg`;
  console.warn('[updater] opening manual update dmg:', url);
  shell.openExternal(url).catch((e) => console.error('[updater] open dmg failed:', e.message));
}

// ── Agent config helpers ──────────────────────────────────────────────────────

// Claude Desktop ↔ 3p 会话同步（启动/接管/定期共用；增量去重，无新增时近乎零成本）
function sync3pDebugLog(msg) {
  try {
    const p = require('electron').app.getPath('userData') + '/3p-sync-debug.log';
    fs.appendFileSync(p, new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}

function runClaude3pSync(reason) {
  try {
    const sync = require('./claude-3p-session-sync');
    const code = sync.syncCodeSessionsBidirectional();
    const cowork = sync.syncCoworkSessionsBidirectional();
    const copied = ((code.toP3 && code.toP3.copied) || 0) + ((code.toNative && code.toNative.copied) || 0)
      + (cowork.toP3 || 0) + (cowork.toNative || 0);
    const line = `[3p-sync] ${reason}: code →3p ${(code.toP3 && code.toP3.copied) || 0}/→native ${(code.toNative && code.toNative.copied) || 0}`
      + ` | dirs native=${code.nativeDir ? 'ok' : 'NULL'} p3=${code.p3Dir ? 'ok' : 'NULL'} skip=${code.skipped || '-'}`;
    // 定期同步只在真有新增时打日志，避免刷屏
    if (copied > 0 || reason !== 'interval') console.log(line);
    sync3pDebugLog(line);
  } catch (e) {
    console.warn(`[3p-sync] ${reason} failed:`, e && e.message);
    sync3pDebugLog(`FAILED ${reason}: ${e && e.message}`);
  }
}

function readAgentConfig() {
  try { return JSON.parse(fs.readFileSync(AGENT_CONFIG_PATH, 'utf-8')); }
  catch { return null; }
}

function writeAgentConfig(cfg) {
  fs.mkdirSync(path.dirname(AGENT_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  // 不在每次写配置时动 Dock：app.dock.show() 会导致窗口整体闪一下；
  // Dock 可见性仅在启动 / 用户切换 hide_dock_icon 时应用。
}

/** macOS：按用户设置显示/隐藏 Dock 图标（默认显示，不随托盘/浮窗自动隐藏） */
let _dockHiddenApplied = null;
function applyDockIconVisibility(hide) {
  if (process.platform !== 'darwin' || !app.dock) return;
  const wantHide = !!hide;
  // 状态未变则跳过，避免重复 show/hide 触发窗口闪动
  if (_dockHiddenApplied === wantHide) return;
  _dockHiddenApplied = wantHide;
  try {
    if (wantHide) app.dock.hide();
    else app.dock.show();
  } catch (e) {
    console.warn('[dock] apply failed:', e.message);
  }
}

/** 账户/刊例价模型 → agent config provider.models（启动与保存账户时调用） */
function syncAgentProviderModelsFromAccounts() {
  try {
    const billingConfig = require('./billing-config');
    const localCfg = readLocalConfig();
    const agentCfg = readAgentConfig() || { providers: [] };
    const { cfg, changed } = billingConfig.syncGatewayProvidersFromAccounts(agentCfg, localCfg);
    if (changed) {
      writeAgentConfig(cfg);
      console.log('[main] synced provider.models from personal accounts');
    }
  } catch (e) {
    console.warn('[main] sync provider models skipped:', e.message);
  }
}

// ── Local Config helpers (stored in userData) ────────────────────────────────

function localConfigPath() {
  return path.join(app.getPath('userData'), 'local-config.json');
}

// 默认策略组（首次使用 / 配置里没有时的初始值）
const DEFAULT_POLICIES = [
  { id: 'default-policy',       name: '默认',     strategy: 'fallback',    providers: [], created_at: '' },
  { id: 'code-policy',          name: '代码助手',  strategy: 'fallback',    providers: [], created_at: '' },
  { id: 'chat-policy',          name: '普通对话',  strategy: 'round-robin', providers: [], created_at: '' },
  { id: 'long-context-policy',  name: '长上下文',  strategy: 'fallback',    providers: [], created_at: '' },
];

// 从默认 yaml 文件加载某段数据（首次初始化用）
function loadDefaultYamlSection(filename, section) {
  try {
    const yamlLib = require('js-yaml');
    const filePath = path.join(__dirname, 'config', filename);
    if (!fs.existsSync(filePath)) return null;
    const doc = yamlLib.load(fs.readFileSync(filePath, 'utf8')) || {};
    return doc[section] || null;
  } catch { return null; }
}

function applyEnvServerDefault(cfg) {
  const url = defaultServerUrlFromEnv();
  if (!url) return cfg;
  if (!cfg.cloud_config) cfg.cloud_config = {};
  if (!cfg.cloud_config.url) cfg.cloud_config.url = url;
  return cfg;
}

function readLocalConfig() {
  try {
    const p = localConfigPath();
    if (fs.existsSync(p)) {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      // 补齐 policies 字段（老配置没有时用默认值）
      if (!cfg.policies) cfg.policies = DEFAULT_POLICIES.map(p => ({ ...p, created_at: new Date().toISOString() }));
      // 迁移 local_keys → apps（向后兼容）
      if (!cfg.apps) {
        cfg.apps = (cfg.local_keys || []).map(k => ({
          id: 'app-' + k.id,
          name: k.note || '未命名应用',
          icon: '🔑',
          link_method: 'api-key',
          api_key: k.key,
          route_id: k.model_key || null,
          description: '',
          allowed_models: [],
          max_rpm: null,
          max_concurrent: null,
          allow_stream: true,
          created_at: k.created_at || new Date().toISOString(),
        }));
      }
      // 首次启动但 scene_routes 为空：从默认 routes 文件加载
      if (!cfg.initialized_routes && (!cfg.scene_routes || cfg.scene_routes.length === 0)) {
        const defaultRoutes = loadDefaultYamlSection('tokenbank.routes.default.yaml', 'scene_routes');
        if (defaultRoutes && defaultRoutes.length > 0) {
          cfg.scene_routes = defaultRoutes.map(r => ({
            ...r, created_at: r.created_at || new Date().toISOString(),
          }));
          cfg.initialized_routes = true;
        }
      }
      // 内置默认路由随版本补齐：老配置缺失的默认路由（策略路由 + 预定义模型链路由）都补上，
      // 但跳过用户显式删除过的（记在 removed_default_routes，尊重删除意图，不复活）。
      try {
        const have = new Set((cfg.scene_routes || []).map(r => r.id));
        const removed = new Set(Array.isArray(cfg.removed_default_routes) ? cfg.removed_default_routes : []);
        const defRoutes = loadDefaultYamlSection('tokenbank.routes.default.yaml', 'scene_routes') || [];
        const missing = defRoutes.filter(r => !have.has(r.id) && !removed.has(r.id));
        if (missing.length) {
          cfg.scene_routes = cfg.scene_routes || [];
          for (const sr of missing) cfg.scene_routes.push({ ...sr, created_at: new Date().toISOString() });
        }
        // 未同步过的内置 strategy-*：用默认 yaml 刷新显示名/图标；
        // 已服务端下发(from_server)或用户改过(user_owned)的，以服务端/用户为准，勿覆盖。
        const defById = new Map(defRoutes.map(r => [r.id, r]));
        for (const r of (cfg.scene_routes || [])) {
          if (!String(r.id || '').startsWith('strategy-') || !defById.has(r.id)) continue;
          if (r.from_server || r.user_owned) continue;
          const d = defById.get(r.id);
          if (d.scene_name) r.scene_name = d.scene_name;
          if (d.icon) r.icon = d.icon;
        }
      } catch {}
      // 用户显式取消托管的 agent_id 列表（自动托管会跳过这些）
      if (!Array.isArray(cfg.auto_host_disabled)) cfg.auto_host_disabled = [];
      return applyEnvServerDefault(cfg);
    }
  } catch {}
  // 全新安装：从默认文件初始化（场景路由从 routes 默认文件）
  const defaultRoutes = loadDefaultYamlSection('tokenbank.routes.default.yaml', 'scene_routes') || [];
  return applyEnvServerDefault({
    scene_routes: defaultRoutes.map(r => ({ ...r, created_at: new Date().toISOString() })),
    local_keys: [], apps: [],
    policies: DEFAULT_POLICIES.map(p => ({ ...p, created_at: new Date().toISOString() })),
    initialized_routes: defaultRoutes.length > 0,
    auto_host_disabled: [],
  });
}

function writeLocalConfig(cfg) {
  fs.writeFileSync(localConfigPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

// ── API Key 应用（只能 config-file / API Key 托管，无法透明托管）──────────────────
// 定义来自 yaml 的 api_key_apps 段（config-loader）；{BASE}/{KEY} 由前端按应用解析。
// Appx 包检测 + 对应配置文件注入信息。未配置该段则返回 []（无 API Key 应用检测）。
function getApiKeyApps() {
  try {
    const apps = require('./config-loader').apiKeyApps() || [];
    return apps
      // enable_3p: false → 该 3p 应用被管理员禁用，不提供接入
      .filter(app => app.enable_3p !== false)
      // 处理 Claude Desktop 的动态配置路径
      .map(app => {
        if (app.id === 'claude-desktop' && app.config_file === '{CLAUDE_3P_CONFIG}') {
          const resolved = getClaudeCloudConfig();  // 有激活配置=其路径；configLibrary 空时=null（写入时再新建）
          // config_file_optional：本质是 config-file 应用，但目标路径依赖 Claude 开发者模式；
          // dev_mode_ready 只看开发者模式是否开过（configLibrary 目录在否），与「当前有没有 profile」解耦——
          // 否则清空/回官方后会误报「需启用开发者模式」。UI 据此决定是否显示启用引导。
          return { ...app, config_file: resolved, config_file_optional: true, dev_mode_ready: claudeDevModeReady() };
        }
        return app;
      });
  }
  catch { return []; }
}

let _appxCache = { ts: 0, map: {} };
function appxInstalled(name) {
  if (process.platform !== 'win32' || !name) return false;
  const now = Date.now();
  if (now - _appxCache.ts > 30000) _appxCache = { ts: now, map: {} };  // 30s 缓存，避免频繁 PS 调用
  if (name in _appxCache.map) return _appxCache.map[name];
  try {
    const out = require('child_process').execFileSync('powershell', ['-NoProfile', '-Command',
      `if (Get-AppxPackage -Name '*${name}*') { 'yes' } else { 'no' }`],
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return (_appxCache.map[name] = out === 'yes');
  } catch { return (_appxCache.map[name] = false); }
}

// 命令是否可执行（api_key_apps 里 CLI 工具用 command 检测，替代 appx）
function commandInstalled(cmd) {
  if (!cmd) return false;
  try { return !!require('./shim-installer').resolveRealCommand(cmd); }
  catch { return false; }
}

// 解析配置文件路径（{占位}+~）
function resolveCfgPath(p) {
  try { const cl = require('./config-loader'); return cl.expandHome(cl.resolvePlaceholders(String(p || ''), {})); }
  catch { return String(p || ''); }
}

/** config_file 检测：文件存在=弱信号；state.vscdb=强。
 * 弱信号不可单独用于「已安装/自动纳管」——配置可能由本程序启动时误写。
 */
function configFileDetect(d) {
  try {
    const f = resolveCfgPath(d.config_file);
    if (!f) return { hit: false, strong: false, weak: false };
    const fileOk = fs.existsSync(f);
    const strong = fileOk && /state\.vscdb$/i.test(f);
    return { hit: fileOk, strong, weak: fileOk };
  } catch { return { hit: false, strong: false, weak: false }; }
}

/** Windows：按 appx 末段探测桌面端 userData（APPDATA / LOCALAPPDATA） */
function winDesktopAppDataPresent(appx) {
  if (process.platform !== 'win32' || !appx) return false;
  const appName = String(appx).split('.').pop();
  if (!appName) return false;
  const bases = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  for (const base of bases) {
    try {
      if (fs.existsSync(path.join(base, appName))) return true;
      // Codex Desktop 数据目录常为 Codex（与 OpenAI.Codex 包名末段不完全一致）
      if (/codex/i.test(appName) && fs.existsSync(path.join(base, 'Codex'))) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * WorkBuddy 强信号：真实会话痕迹或桌面端 userData。
 * 不用 ~/.workbuddy/models.json / 空目录——MCP 投射会建目录，易在未安装机误判已纳管。
 */
function workbuddyStrongPresent() {
  try {
    return !!require('./resource-agent-targets').isWorkbuddyPresent?.();
  } catch {
    return false;
  }
}

/** Codex Desktop 强信号：桌面 userData / App bundle（不用 config.toml） */
function codexDesktopStrongPresent() {
  try {
    if (require('./resource-agent-targets').isCodexDesktopPresent?.()) return true;
  } catch { /* ignore */ }
  return commandInstalled('codex');
}

/**
 * 配置文件缺失时是否允许新建。
 * 前提：该应用安装探测已只认强信号，自写 config 不会反证「已安装」。
 * Claude Desktop：设计上就在 configLibrary 新建 UUID 配置。
 */
function allowCreateMissingProxyConfig(handlerId, { isClaudeDesktop } = {}) {
  if (isClaudeDesktop || handlerId === 'claude-desktop-api') return true;
  if (handlerId === 'workbuddy-stats') return workbuddyStrongPresent();
  if (handlerId === 'openclaw-api') return commandInstalled('openclaw');
  if (handlerId === 'codex-desktop-api') return codexDesktopStrongPresent();
  // DeepSeek Harness：settings.yaml 首次运行才有；检测口径 isDshPresent()（profiles/sessions/storages），
  // 不认 settings.yaml/cordis.patch.yml 本身（那些是纳管时我们写的）→ 无自证循环，允许新建
  if (handlerId === 'deepseek-harness-cli') {
    try {
      const { isDshPresent } = require('./resource-agent-targets');
      if (isDshPresent() || commandInstalled('dsh')) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/** 确保代理配置可写：缺文件时按策略建父目录（整份覆盖路径随后 writeFileSync，勿预写空文件以免误备份） */
function ensureProxyConfigWritable(file, { allowCreate } = {}) {
  if (fs.existsSync(file)) return { ok: true };
  if (!allowCreate) return { ok: false, error: 'config-missing', file };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { ok: true, created: true };
  } catch (e) {
    return { ok: false, error: e.message || 'mkdir-failed', file };
  }
}

// api_key 应用是否检测到（跨平台）：
//   Windows → appx 包 / CLI 命令 / 桌面 userData
//   macOS   → /Applications/<App>.app / CLI 命令 / Application Support
//   Linux   → CLI 命令
/** macOS：按 appx 末段探测桌面应用是否已装（.app / Application Support / 嵌入式 Framework） */
function macDesktopAppPresent(appx) {
  if (process.platform !== 'darwin' || !appx) return false;
  const appName = String(appx).split('.').pop();
  if (!appName) return false;
  for (const base of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    try { if (fs.existsSync(path.join(base, `${appName}.app`))) return true; } catch {}
  }
  // Electron 系：无独立 .app 时，user-data 目录是强信号（区别于 CLI 的 ~/.<name>）
  // Codex Desktop 现嵌入 ChatGPT.app，数据在 ~/Library/Application Support/Codex
  try {
    if (fs.existsSync(path.join(os.homedir(), 'Library', 'Application Support', appName))) return true;
  } catch {}
  // Codex Desktop 嵌在 ChatGPT.app 内的 Framework
  if (/codex/i.test(appName)) {
    try {
      if (fs.existsSync('/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework')) return true;
    } catch {}
  }
  return false;
}

function apiKeyAppDetected(d) {
  const det = apiKeyDetect(d);
  // 已定义强信号（appx/command/专用探测）：只认强，避免残留 config.toml / models.json 误显示「已纳管」
  if (det.strongDefined) return !!det.strong;
  return !!(det.strong || det.weak);
}

// 分强/弱信号检测（供 apps:supported 用）：
//   强信号 strong = 命令/appx/mac-app 现在确实装着；strongDefined 表示该应用配了强信号可判。
//   弱信号 weak   = 残留的配置目录（应用卸载后目录常仍在，不足以证明"已安装"）。
// 卸载（尤其 npm uninstall 只删命令、不删 ~/.<app> 目录）后，强信号立即转 false，
// 上层"有强信号只认强信号"即可正确变灰，不被残留目录误判为已安装。
function apiKeyDetect(d) {
  let strongDefined = false, strong = false;
  if (d.appx) {
    strongDefined = true;
    if (appxInstalled(d.appx)) strong = true;
    if (!strong && macDesktopAppPresent(d.appx)) strong = true;
    if (!strong && winDesktopAppDataPresent(d.appx)) strong = true;
  }
  if (d.command) { strongDefined = true; if (commandInstalled(d.command)) strong = true; }
  // WorkBuddy：强制走强信号，忽略单独 models.json
  if (d.id === 'workbuddy') {
    strongDefined = true;
    if (workbuddyStrongPresent()) strong = true;
  }
  // DeepSeek Harness：dsh 装在 ~/.dsh/profiles/node_modules 而非 PATH（GUI Electron PATH 精简常探不到命令）。
  // ~/.dsh 下 dsh 自建目录(profiles/sessions/storages)= 强信号；settings.yaml/cordis.patch.yml 是纳管时我们自己会写的，刻意不认。
  if (d.id === 'deepseek-harness') {
    strongDefined = true;
    try {
      const { isDshPresent } = require('./resource-agent-targets');
      if (isDshPresent()) strong = true;
    } catch { /* ignore */ }
  }
  let weak = false;
  if (d.config_file) {
    const cf = configFileDetect(d);
    if (cf.weak) weak = true;
    // state.vscdb 已生成 → 强信号（Trae 未在 /Applications 也可能已安装使用过）
    if (cf.strong) { strongDefined = true; strong = true; }
  }
  return { strongDefined, strong, weak };
}

// 递归解析 patch/env 中的 {BASE}/{KEY}/{REVERSE}（WorkBuddy models.json 等嵌套结构）
function resolvePatchDeep(obj, ctx = {}) {
  const cl = require('./config-loader');
  if (typeof obj === 'string') {
    return cl.resolvePlaceholders(obj, {
      reverse: ctx.reverse,
      mitm: ctx.mitm,
      caPath: ctx.caPath,
    })
      .replace(/\{BASE\}/g, ctx.base || '')
      .replace(/\{KEY\}/g, ctx.key || '');
  }
  if (Array.isArray(obj)) return obj.map(v => resolvePatchDeep(v, ctx));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = resolvePatchDeep(v, ctx);
    return out;
  }
  return obj;
}

// dot-path patch（a.b.c）→ 嵌套对象（用于整份写出 JSON / YAML 配置）
function patchToObject(patch) {
  const obj = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const parts = String(k).split('.'); let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] == null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return obj;
}

// dot-path patch → 完整 TOML 文本（顶层标量 + [表] 分组）。整份写出我们的配置。
function patchToToml(patch) {
  const tomlVal = (v) => (v === true || v === false || v === 'true' || v === 'false' || /^-?\d+(\.\d+)?$/.test(String(v)))
    ? String(v) : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const top = []; const tables = new Map();
  for (const [k, v] of Object.entries(patch || {})) {
    const i = String(k).lastIndexOf('.');
    if (i < 0) { top.push([k, v]); continue; }
    const tbl = k.slice(0, i), key = k.slice(i + 1);
    if (!tables.has(tbl)) tables.set(tbl, []);
    tables.get(tbl).push([key, v]);
  }
  let out = top.map(([k, v]) => `${k} = ${tomlVal(v)}`).join('\n');
  if (out) out += '\n';
  for (const [tbl, kvs] of tables) {
    out += `\n[${tbl}]\n` + kvs.map(([k, v]) => `${k} = ${tomlVal(v)}`).join('\n') + '\n';
  }
  return out;
}


// ── LLM config scanner ────────────────────────────────────────────────────────

const BASE_URL_KEYS = [
  'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE',
  'LLM_BASE_URL', 'API_BASE_URL', 'OLLAMA_HOST',
];
const TOKEN_KEYS = [
  'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
  'LLM_TOKEN', 'LLM_API_KEY', 'API_KEY',
];
const MODEL_KEYS = ['MODELS', 'LLM_MODELS', 'DEFAULT_MODEL'];
// keys like ANTHROPIC_DEFAULT_HAIKU_MODEL whose values are model IDs
const ANTHROPIC_MODEL_KEYS = /^ANTHROPIC_DEFAULT_\w+_MODEL$/;

const SCAN_FILES = [
  { rel: '.claude/settings.json',       fmt: 'json-env' },
  { rel: '.claude/settings.local.json', fmt: 'json-env' },
  { rel: '.env',                         fmt: 'dotenv'   },
  { rel: '.config/openai/credentials',  fmt: 'dotenv'   },
  { rel: '.zshrc',                       fmt: 'shell'    },
  { rel: '.bashrc',                      fmt: 'shell'    },
  { rel: '.profile',                     fmt: 'shell'    },
  { rel: '.bash_profile',                fmt: 'shell'    },
  // openclaw / common agent tools
  { rel: '.openclaw/config.json',        fmt: 'json-flat' },
  { rel: '.config/openclaw/config.json', fmt: 'json-flat' },
  { rel: '.llm/config.json',             fmt: 'json-flat' },
  { rel: '.config/llm/config.json',      fmt: 'json-flat' },
];

function parseDotenv(content) {
  const map = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?([^"'\n#]*)["']?/);
    if (m) map[m[1]] = m[2].trim();
  }
  return map;
}

// ── Provider key import（从本机环境/工具导入已有 key）────────────────────────
// 命名环境变量 / 配置键 → 供给源 id（强提示，免试探）。只收来源明确的，
// 故意不收 GITHUB_TOKEN、通用 API_KEY 等易误导入的泛化名。
const ENV_PROVIDER_MAP = {
  OPENAI_API_KEY: 'openai',
  ANTHROPIC_API_KEY: 'anthropic-paid',
  ANTHROPIC_AUTH_TOKEN: 'anthropic-paid',
  GROQ_API_KEY: 'groq',
  DEEPSEEK_API_KEY: 'deepseek',
  OPENROUTER_API_KEY: 'openrouter',
  MISTRAL_API_KEY: 'mistral',
  TOGETHER_API_KEY: 'together',
  TOGETHER_AI_API_KEY: 'together',
  XAI_API_KEY: 'xai',
  GROK_API_KEY: 'xai',
  FIREWORKS_API_KEY: 'fireworks',
  CEREBRAS_API_KEY: 'cerebras',
  NVIDIA_API_KEY: 'nvidia',
  NVIDIA_NIM_API_KEY: 'nvidia',
  COHERE_API_KEY: 'cohere',
  SILICONFLOW_API_KEY: 'siliconflow',
  MINIMAX_API_KEY: 'minimax',
  ZHIPU_API_KEY: 'zhipu',
  ZHIPUAI_API_KEY: 'zhipu',
  BIGMODEL_API_KEY: 'zhipu',
  HUGGINGFACE_API_KEY: 'huggingface',
  HUGGINGFACE_HUB_TOKEN: 'huggingface',
  HF_TOKEN: 'huggingface',
};

// cc-switch 等结构未知的 JSON，靠值的形态判断是否是 key
const KEY_PREFIX_RE = /^(sk-|gsk_|csk-|nvapi-|xai-|fw_|tgp_v1_|ghp_|github_pat_|hf_)/;
function looksLikeKey(name, value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length < 20 || /\s/.test(v)) return false;
  if (KEY_PREFIX_RE.test(v)) return true;
  return /api[_-]?key|token|auth/i.test(name) && /^[A-Za-z0-9_.\-]+$/.test(v);
}

function collectKeysDeep(obj, source, push, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') { if (looksLikeKey(k, v)) push(v, null, source); }
    else if (v && typeof v === 'object') collectKeysDeep(v, source, push, depth + 1);
  }
}

// 返回 [{ key, providerId|null, source }]，仅本机扫描、绝不写日志/上传
function scanProviderKeys() {
  const out = [];
  const seen = new Set();
  const push = (key, providerId, source) => {
    if (typeof key !== 'string') return;
    const k = key.trim();
    if (k.length < 8) return;
    const dedupe = `${k}|${providerId || ''}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    out.push({ key: k, providerId: providerId || null, source });
  };

  // 1) 环境变量（命名即来源）
  for (const [envName, pid] of Object.entries(ENV_PROVIDER_MAP)) {
    if (process.env[envName]) push(process.env[envName], pid, `env:${envName}`);
  }

  // 2) 已知配置文件里的命名 key（复用 SCAN_FILES 的解析）
  const home = os.homedir();
  for (const { rel, fmt } of SCAN_FILES) {
    const fp = path.join(home, rel);
    if (!fs.existsSync(fp)) continue;
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      let envMap = {};
      if (fmt === 'json-env')       envMap = JSON.parse(content).env || {};
      else if (fmt === 'json-flat') envMap = JSON.parse(content);
      else                          envMap = parseDotenv(content);
      for (const [name, pid] of Object.entries(ENV_PROVIDER_MAP)) {
        if (envMap[name]) push(envMap[name], pid, `file:${rel}`);
      }
    } catch {}
  }

  // 3) cc-switch（结构按版本变化，深度遍历兜底）
  try {
    const ccPath = path.join(home, '.cc-switch', 'config.json');
    if (fs.existsSync(ccPath)) {
      collectKeysDeep(JSON.parse(fs.readFileSync(ccPath, 'utf-8')), 'file:.cc-switch/config.json', push);
    }
  } catch {}

  return out;
}

function scanLLMConfigs() {
  const home = os.homedir();
  const results = [];

  for (const { rel, fmt } of SCAN_FILES) {
    const filePath = path.join(home, rel);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      let envMap = {};

      if (fmt === 'json-env') {
        const json = JSON.parse(content);
        envMap = json.env || {};
      } else if (fmt === 'json-flat') {
        const json = JSON.parse(content);
        // accept both camelCase and UPPER_SNAKE_CASE keys
        for (const k of Object.keys(json)) envMap[k.toUpperCase().replace(/([a-z])([A-Z])/g, '$1_$2')] = json[k];
        Object.assign(envMap, json);
      } else {
        envMap = parseDotenv(content);
      }

      const base_url = BASE_URL_KEYS.map(k => envMap[k]).find(v => v && v.startsWith('http'));
      const token    = TOKEN_KEYS.map(k => envMap[k]).find(Boolean);

      // collect model names: explicit MODELS key (comma-sep) or ANTHROPIC_DEFAULT_*_MODEL values
      let models = [];
      const modelsStr = MODEL_KEYS.map(k => envMap[k]).find(Boolean);
      if (modelsStr) models = modelsStr.split(',').map(s => s.trim()).filter(Boolean);
      if (!models.length) {
        const anthropicModels = Object.entries(envMap)
          .filter(([k]) => ANTHROPIC_MODEL_KEYS.test(k))
          .map(([, v]) => v.trim())
          .filter(Boolean);
        models = [...new Set(anthropicModels)];
      }
      // also pick up json-flat "models" array
      if (!models.length && fmt === 'json-flat') {
        try {
          const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (Array.isArray(json.models)) models = json.models.filter(m => typeof m === 'string');
        } catch {}
      }

      if (base_url || token) {
        results.push({ source: rel, base_url: base_url || null, token: token || null, models });
      }
    } catch {}
  }

  return results;
}

// ── Node-side HTTP proxy (avoids CORS in renderer) ───────────────────────────

function nodeRequest(url, method, headers, body, agentOrOpts) {
  let agent = null;
  let timeoutMs = 120_000;
  if (agentOrOpts != null) {
    if (typeof agentOrOpts === 'object' && (agentOrOpts.timeoutMs != null || agentOrOpts.agent != null)) {
      agent = agentOrOpts.agent || null;
      if (agentOrOpts.timeoutMs != null) timeoutMs = agentOrOpts.timeoutMs;
    } else if (agentOrOpts instanceof http.Agent || agentOrOpts instanceof https.Agent) {
      agent = agentOrOpts;
    }
  }
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method, headers, timeout: timeoutMs,
      ...(agent ? { agent } : {}),
    };
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', (e) => resolve({ status: 0, body: e.message }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'Request timeout' }); });
    if (body) req.write(body);
    req.end();
  });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

function registerIPC() {
  // Agent 聚合系统 IPC handlers
  const { registerAgentHandlers } = require('./ipc-handlers-agent');
  registerAgentHandlers();
  try {
    const agentExecutor = require('./agent-executor');
    const resourceManager = require('./resource-manager');
    const { startDispatchServer, setResourceHitHandler } = require('./agent-dispatch-server');
    startDispatchServer(agentExecutor, resourceManager);
    try {
      const mcpManager = require('./mcp-manager');
      const { startMcpGateway } = require('./mcp-gateway-server');
      const { setAppsGetter } = require('./mcp-gateway-targets');
      // 与 Gateway「API 应用」同源：延迟取 getApps（同函数内后文声明，运行时已就绪）
      setAppsGetter(() => {
        try { return getApps(); } catch { return []; }
      });
      mcpManager.init();
      startMcpGateway(() => mcpManager.listGatewayRoutedServers());
    } catch (gwErr) {
      console.warn('[mcp-gateway] start skipped:', gwErr.message);
    }
    setResourceHitHandler((evt) => {
      // React ResourceHitToast（徽记卡牌特效）：IPC + CustomEvent 双投；勿再 DOM 硬注卡片
      const payload = evt && typeof evt === 'object' ? evt : {};
      const deliverTo = (win) => {
        if (!win || win.isDestroyed()) return;
        try {
          if (!win.isVisible()) win.show();
          if (win.isMinimized()) win.restore();
          try { win.focus(); } catch { /* ignore */ }
          try { win.moveTop(); } catch { /* ignore */ }
          // 短暂置顶，避免被 Cursor 挡住看不见卡牌
          try {
            win.setAlwaysOnTop(true, 'floating');
            setTimeout(() => {
              try { if (!win.isDestroyed()) win.setAlwaysOnTop(false); } catch { /* ignore */ }
            }, 4500);
          } catch { /* ignore */ }

          win.webContents.send('resource:hit', payload);
          // CustomEvent 不依赖 preload；清残留 DOM；一次性解除误点的「不再提示」
          const js = `(() => {
  try {
    if (localStorage.getItem('tokenbank.resourceHitToast.fxReset') !== 'v2') {
      localStorage.removeItem('tokenbank.resourceHitToast.dismissed');
      localStorage.setItem('tokenbank.resourceHitToast.fxReset', 'v2');
    }
  } catch (e) {}
  try {
    var n = document.getElementById('tb-hit-force');
    if (n) n.remove();
  } catch (e) {}
  try {
    window.dispatchEvent(new CustomEvent('tb-resource-hit', { detail: ${JSON.stringify(payload)} }));
  } catch (e) {}
  return true;
})();`;
          win.webContents.executeJavaScript(js, true).catch(() => {});
        } catch (e) {
          console.warn('[resource-hit] deliver:', e && e.message);
        }
      };

      if (mainWindow && !mainWindow.isDestroyed()) {
        deliverTo(mainWindow);
      } else {
        try {
          const { BrowserWindow } = require('electron');
          const win = BrowserWindow.getAllWindows().find((w) => {
            try {
              const u = w.webContents.getURL();
              return u.startsWith('http://localhost:') || u.includes('index.html');
            } catch { return false; }
          });
          if (win) deliverTo(win);
        } catch (e) {
          console.warn('[resource-hit] no window:', e.message);
        }
      }
    });
  } catch (e) {
    console.warn('[dispatch-server] start skipped:', e.message);
  }
  const { registerMcpHandlers } = require('./ipc-handlers-mcp');
  registerMcpHandlers();
  const { registerResourceHandlers } = require('./ipc-handlers-resource');
  registerResourceHandlers();
  
  const billingConfigMod = require('./billing-config');
  ipcMain.on('tray:lang',  (_e, lang)      => { _trayLang = lang === 'en' ? 'en' : 'zh'; refreshTray(); });
  ipcMain.on('tray:auth',  (_e, loggedIn)  => {
    _trayUserLoggedIn = !!loggedIn;
    if (!loggedIn) {
      gateway.setUserAuth(null);
      stopAgent();
    }
    refreshTray();
  });
  ipcMain.handle('gateway:setUserAuth', (_e, jwt) => {
    gateway.setUserAuth(jwt || null);
    try {
      const cfg = readLocalConfig();
      if (jwt) cfg.user_session = { jwt };
      else delete cfg.user_session;
      writeLocalConfig(cfg);
    } catch {}
    return { ok: true };
  });
  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });
  ipcMain.on('app:defaultServerUrl', (e) => { e.returnValue = defaultServerUrlFromEnv(); });
  // 设备注册用：系统电脑名 + macOS/Windows 版本说明
  ipcMain.on('app:getDeviceIdentity', (e, opts) => {
    e.returnValue = deviceIdentity.collect({
      type: 'desktop',
      version: app.getVersion(),
      customName: opts?.customName || '',
    });
  });
  ipcMain.handle('agent:start',   () => { startAgent(); return { running: agent.isRunning() }; });
  ipcMain.handle('agent:stop',    () => { stopAgent();  return { running: false }; });
  ipcMain.handle('agent:status',  () => ({ running: agent.isRunning() }));
  ipcMain.handle('agent:getLogs', () => [..._agentLogBuf]);
  ipcMain.handle('config:read',  () => readAgentConfig());
  ipcMain.handle('config:write', (_e, cfg) => { writeAgentConfig(cfg); return { ok: true }; });
  require('./decision-management').registerIpc(ipcMain, {
    getConfig: readAgentConfig, saveConfig: writeAgentConfig,
    getYamlRouting: () => require('./config-loader').routing(),
  });
  // 单独切换 Dock 可见性（设置页即时生效，无需等整页保存）
  ipcMain.handle('app:setHideDockIcon', (_e, hide) => {
    const cfg = readAgentConfig() || {};
    cfg.hide_dock_icon = !!hide;
    writeAgentConfig(cfg);
    applyDockIconVisibility(!!hide);
    return { ok: true, hide_dock_icon: !!cfg.hide_dock_icon };
  });
  // 同步渲染进程主题 → Windows 原生标题栏 / 系统 chrome（light 模式下标题栏不再留黑）
  ipcMain.handle('app:setThemeSource', (_e, source) => applyNativeThemeSource(source));
  ipcMain.handle('config:scan',  () => scanLLMConfigs());
  ipcMain.handle('config:importKeys', () => scanProviderKeys());

  // ── 供给源 OAuth 订阅登录（Claude / Codex / Google / Copilot）──────────────
  // PKCE 流：start 返回 authUrl，用户浏览器授权后粘贴 code，exchange 换 credentials。
  // 设备码流（codex/copilot）：start 返回 userCode+verificationUrl，poll 轮询。
  const oauthMod = require('./oauth');
  // OAuth 换 token / 设备码请求与网关一样走 network_proxy / HTTPS_PROXY
  oauthMod.setNetworkProxyGetter(() => {
    try { return (readAgentConfig() || {}).network_proxy || null; } catch { return null; }
  });
  const _oauthSessions = new Map(); // sessionId -> { provider, session, created }
  function gcOauthSessions() {
    const now = Date.now();
    for (const [k, v] of _oauthSessions) if (now - v.created > 30 * 60 * 1000) _oauthSessions.delete(k);
  }
  ipcMain.handle('oauth:start', async (_e, { provider, setupToken } = {}) => {
    gcOauthSessions();
    const mod = oauthMod.getModule(provider);
    if (!mod) throw new Error('unsupported oauth provider: ' + provider);
    try {
      const r = await mod.startLogin({ setupToken });
      const sessionId = require('crypto').randomUUID();
      _oauthSessions.set(sessionId, { provider, session: r.session, created: Date.now() });
      return { sessionId, mode: mod.mode, authUrl: r.authUrl || null,
               userCode: r.userCode || null, verificationUrl: r.verificationUrl || null };
    } catch (e) {
      throw new Error((e && e.message) || String(e));
    }
  });
  ipcMain.handle('oauth:exchange', async (_e, { sessionId, code } = {}) => {
    const s = _oauthSessions.get(sessionId);
    if (!s) throw new Error('session 不存在或已过期，请重新登录');
    const mod = oauthMod.getModule(s.provider);
    try {
      const credentials = await mod.completeLogin(s.session, code);
      _oauthSessions.delete(sessionId);
      return { ok: true, oauth_provider: s.provider, credentials, email: credentials.email || '' };
    } catch (e) {
      // 保留可读网络/代理提示，避免 IPC 只剩 TypeError: fetch failed
      throw new Error((e && e.message) || String(e));
    }
  });
  // 设备码流轮询（codex/copilot 用；PKCE 流不需要）
  ipcMain.handle('oauth:poll', async (_e, { sessionId } = {}) => {
    const s = _oauthSessions.get(sessionId);
    if (!s) throw new Error('session 不存在或已过期');
    const mod = oauthMod.getModule(s.provider);
    if (typeof mod.poll !== 'function') throw new Error('provider 不支持轮询');
    try {
      const result = await mod.poll(s.session);
      if (result && result.credentials) {
        _oauthSessions.delete(sessionId);
        return { ok: true, done: true, oauth_provider: s.provider, credentials: result.credentials, email: result.credentials.email || '' };
      }
      return { ok: true, done: false, status: (result && result.status) || 'pending' };
    } catch (e) {
      throw new Error((e && e.message) || String(e));
    }
  });
  ipcMain.handle('oauth:openExternal', (_e, { url } = {}) => { if (url) shell.openExternal(url); return { ok: true }; });

  // ChatGPT 网页源（原生 port）：内嵌浏览器 + 本地 Responses server + provider.token 回写
  try {
    require('./chatgpt-web').registerIpc(ipcMain, { readAgentConfig, writeAgentConfig });
  } catch (e) { console.warn('[chatgpt-web] IPC 注册失败:', e && e.message); }

  // 订阅用量额度抓取（复用 oauth 凭证；provider 条目存在 agent config ~/.llm-agent/config.json）
  const usageMod = require('./usage');
  const usageDeps = { getCfg: readAgentConfig, saveCfg: writeAgentConfig };
  ipcMain.handle('usage:fetch', async (_e, { provider } = {}) => {
    const cfg = readAgentConfig() || {};
    const list = Array.isArray(cfg.providers) ? cfg.providers : [];
    const findEntry = (id) => list.find(p => p && (p.id === id
      || (p.auth_type === 'oauth' && p.oauth_provider === id)));
    let entry = findEntry(provider);
    // 订阅模板别名（api-volcengine）常无凭证；回退到抓取键同名网关条目（volcengine）
    const usageKey = usageMod.normalizeUsageKey(provider);
    if (usageKey && usageKey !== provider) {
      const byKey = findEntry(usageKey);
      if (byKey) {
        if (!entry) entry = byKey;
        else if (!usageMod.hasCredential(entry) && usageMod.hasCredential(byKey)) entry = byKey;
      }
    }
    // 直连 App（Cursor/Codex）可能无 gateway 条目：用虚拟 provider + IDE/CLI 凭证
    if (!entry) entry = usageMod.syntheticProvider(provider);
    if (!entry) return { error: 'provider_not_found' };
    return usageMod.fetchUsage(entry, usageDeps);
  });
  ipcMain.handle('usage:fetchAll', async () => usageMod.fetchAllUsage(usageDeps));
  // 应用列表切换路由（纳管/还原 Claude Desktop）时前端可主动触发一次会话同步（不等 30s 定时）
  ipcMain.handle('claude3p:sync', () => { runClaude3pSync('app-switch'); return { ok: true }; });

  // Write Claude Code config into ~/.claude/settings.json（用户级设置；Claude Code 实际读取的就是这个，
  // settings.local.json 是「项目级」约定，写在 ~/.claude 下不会被读取）
  // AUTH_TOKEN 写 PROXY_MANAGED 占位：占住 settings.env（优先级高于其他代理/shim），不暴露真实 key
  // 对齐 cc-switch：不写 CLAUDE_CODE_MAX_CONTEXT_TOKENS / AUTO_COMPACT_WINDOW（窗口随上游模型变）
  ipcMain.handle('claude:configure', async (_e, { baseUrl, models = [] }) => {
    const { PROXY_MANAGED_TOKEN } = require('./cli-endpoint-config');
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    let settings = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
    settings.env = settings.env || {};
    settings.env.ANTHROPIC_BASE_URL = baseUrl || 'http://127.0.0.1:11430';
    // 占位标记：占住 settings.env（优先级高于其他代理），真实 key 不写入
    settings.env.ANTHROPIC_AUTH_TOKEN = PROXY_MANAGED_TOKEN;
    // 清掉历史硬编码窗口，避免误伤大上下文模型
    delete settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
    delete settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

    // Map available models to Claude tier env vars
    // Claude Code uses these to select models per task complexity
    if (models.length > 0) {
      const fast   = models[0];
      const mid    = models[Math.min(1, models.length - 1)];
      const heavy  = models[Math.min(2, models.length - 1)];
      settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL   = fast;
      settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL  = mid;
      settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL    = heavy;
      // Also write MODELS so other tools can discover them
      settings.env.MODELS = models.join(',');
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    return { ok: true };
  });

  // Read current Claude Code config status
  ipcMain.handle('claude:status', () => {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return { configured: !!(s.env?.ANTHROPIC_BASE_URL && s.env?.ANTHROPIC_AUTH_TOKEN) };
    } catch { return { configured: false }; }
  });

  // Buffered HTTP request (for models list, non-streaming chat)
  ipcMain.handle('llm:fetch', async (_e, { url, method = 'GET', headers = {}, body, timeoutMs }) => {
    return nodeRequest(url, method, headers, body, timeoutMs != null ? { timeoutMs } : undefined);
  });

  // 登录 / 注册 / profile：走主进程 HTTP，避免系统代理拦截
  ipcMain.handle('auth:request', async (_e, { base, method = 'GET', path, body, token }) => {
    const url = `${String(base).replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = body != null ? JSON.stringify(body) : null;
    return nodeRequest(url, method, headers, payload);
  });

  // Streaming HTTP request — sends chunks back via webContents events
  ipcMain.on('llm:stream', (event, { reqId, url, method, headers, body }) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method, headers, timeout: 120000,
    };
    const send = (ch, data) => { if (!event.sender.isDestroyed()) event.sender.send(ch, data); };
    const req = mod.request(opts, (res) => {
      const status = res.statusCode || 0;
      // 非 2xx：缓冲后以 stream-error 上报，避免前端当成空成功回复
      if (status >= 400) {
        let errBuf = '';
        res.on('data', (chunk) => { errBuf += chunk.toString(); });
        res.on('end', () => {
          let detail = errBuf.slice(0, 400).trim() || `status ${status}`;
          try {
            const j = JSON.parse(errBuf);
            const raw = j.error?.message || j.message || j.detail || detail;
            detail = typeof raw === 'string' ? raw : JSON.stringify(raw).slice(0, 400);
          } catch { /* 非 JSON 错误体，沿用原文 */ }
          send('llm:stream-error', { reqId, error: `HTTP ${status}: ${detail}` });
        });
        res.on('error', (e) => send('llm:stream-error', { reqId, error: e.message }));
        return;
      }
      res.on('data', (chunk) => send('llm:stream-chunk', { reqId, data: chunk.toString() }));
      res.on('end', () => send('llm:stream-done', { reqId }));
      res.on('error', (e) => send('llm:stream-error', { reqId, error: e.message }));
    });
    req.on('error', (e) => send('llm:stream-error', { reqId, error: e.message }));
    req.on('timeout', () => { req.destroy(); send('llm:stream-error', { reqId, error: 'Request timeout' }); });
    if (body) req.write(body);
    req.end();
  });

  ipcMain.handle('update:install', () => {
    const version = pendingUpdateReady?.version || '';
    pendingUpdateReady = null;
    setImmediate(() => {
      try {
        clearStaleShipItState();
        prepareQuitForUpdateInstall();

        // macOS：quitAndInstall 常只关窗不退出；且须等 Squirrel 拉完包
        if (process.platform === 'darwin') {
          try {
            const { autoUpdater: nativeUpdater } = require('electron');
            nativeUpdater.once('before-quit-for-update', () => {
              runExitCleanupForUpdate();
              app.exit(0);
            });
          } catch (e) {
            console.warn('[updater] before-quit-for-update hook:', e.message);
          }
        }

        autoUpdater.quitAndInstall(false, true);

        // 仍存活：自动安装未生效 → 打开 dmg 手动覆盖，再强制退出
        setTimeout(() => {
          console.warn('[updater] quitAndInstall stalled, falling back to manual dmg');
          openManualUpdateDmg(version);
          runExitCleanupForUpdate();
          app.exit(0);
        }, 4000);
      } catch (e) {
        console.error('[updater] quitAndInstall failed:', e.message);
        openManualUpdateDmg(version);
        app.exit(0);
      }
    });
    return { ok: true, version };
  });

  ipcMain.handle('updater:status', () => ({
    ready: !!pendingUpdateReady,
    version: pendingUpdateReady?.version ?? null,
  }));

  ipcMain.handle('updater:getSettings', () => ({
    enabled: !isDev,
    currentVersion: app.getVersion(),
    allowPrerelease: readUpdaterAllowPrerelease(),
    ready: !!pendingUpdateReady,
    pendingVersion: pendingUpdateReady?.version ?? null,
  }));

  ipcMain.handle('updater:setAllowPrerelease', (_e, allow) => ({
    allowPrerelease: persistUpdaterAllowPrerelease(!!allow),
  }));

  ipcMain.handle('updater:checkNow', async () => {
    if (isDev) return { status: 'dev', message: 'dev mode' };
    if (!updaterEventsBound) {
      applyUpdaterAllowPrerelease();
      bindUpdaterEvents();
    } else {
      applyUpdaterAllowPrerelease();
    }
    return checkForUpdatesAndWait();
  });

  ipcMain.handle('gateway:status',        () => gateway.getStatus());
  ipcMain.handle('gateway:getLog',        () => gateway.getLog());
  // 失败候选冷却表（供供给源页展示「冷却中」）。key 拆成 provider_id::model::sharer；
  // 个人直连源冷却键就是 provider_id（整源），故 model/sharer 为空。
  ipcMain.handle('gateway:cooldowns',     () => {
    try {
      const byId = {};
      try { for (const p of (readLocalConfig().providers || [])) byId[p.id] = p; } catch {}
      const parts = (k) => String(k || '').split('::');
      return require('./gateway-cooldown').list().map(e => {
        const [provider_id, model = null, sharer = null] = parts(e.key);
        const p = byId[provider_id] || {};
        // 联 provider 补展示/匹配字段：个人直连源按 agent_id/source_id 归卡，其余按 provider_id
        return { ...e, provider_id, model, sharer,
                 label: p.label || p.name || provider_id, agent_id: p.agent_id || null, source_id: p.source_id || null };
      });
    } catch { return []; }
  });
  ipcMain.handle('gateway:clearCooldown', (_e, key) => {
    try { require('./gateway-cooldown').clear(key); return { ok: true }; }
    catch (e) { return { ok: false, error: e && e.message }; }
  });
  // OpenRouter 模型目录：手动刷新 / 查状态（供给源页 openrouter 卡：启用时拉一次、把模型写进配置状态）
  ipcMain.handle('openrouter:refreshModels', async () => {
    try {
      const oc = require('./openrouter-catalog');
      const r = await oc.refresh();
      return { ...r, models: oc.getModels().map(m => m.name) };
    } catch (e) { return { ok: false, error: e && e.message, models: [] }; }
  });
  ipcMain.handle('openrouter:modelsStatus', () => {
    try { const oc = require('./openrouter-catalog'); return { count: oc.getModels().length, fetched_at: oc.getFetchedAt(), models: oc.getModels().map(m => m.name) }; }
    catch { return { count: 0, fetched_at: 0, models: [] }; }
  });
  ipcMain.handle('gateway:speedMap',      () => {
    try {
      const ps = require('./provider-speed');
      let latency = {};
      try { latency = localStats.queryModelProviderLatency(localStats.sinceTsForDays(7)); } catch {}
      return ps.getSpeedMapWithLatency(latency);   // 被动/探针测速 + 历史请求延迟兜底
    } catch { return {}; }
  });

  // 导出诊断日志：聚合版本/网关状态/路由日志/冷却/测速/场景路由/配置(脱敏)/同步日志，
  // 密钥类字段一律遮蔽，弹保存对话框让用户自选位置。给 troubleshooting 用。
  ipcMain.handle('diagnostics:export', async () => {
    const fs = require('fs'), path = require('path'), os = require('os');
    // 密钥类字段名（用词边界避免误伤 model_key / 普通标识）；命中的标量值才遮蔽，容器仍递归保结构。
    const SECRET_KEY = /(api[_-]?key|secret|token|password|passwd|jwt|bearer|credential|private[_-]?key|access[_-]?key|\bauth\b|\bkey\b)/i;
    const maskVal = (v) => (typeof v !== 'string' || !v) ? '***' : (v.length <= 8 ? '***' : v.slice(0, 4) + '…' + v.slice(-4) + `(${v.length})`);
    // 值里夹带的密钥样式(sk-*/Bearer/JWT)也顺手刮掉，防漏在非密钥名的字段里
    const scrubStr = (s) => String(s)
      .replace(/sk-[A-Za-z0-9_-]{12,}/g, m => m.slice(0, 5) + '…' + m.slice(-4))
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g, 'eyJ…JWT…')
      .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer …');
    const redact = (o) => {
      if (Array.isArray(o)) return o.map(redact);
      if (o && typeof o === 'object') {
        const out = {};
        for (const k of Object.keys(o)) {
          const v = o[k];
          // 键名命中且是标量(字符串/数字) → 遮蔽；对象/数组即使键名命中也递归，保留结构只遮里面的标量密钥
          out[k] = (SECRET_KEY.test(k) && (typeof v === 'string' || typeof v === 'number')) ? maskVal(v) : redact(v);
        }
        return out;
      }
      return typeof o === 'string' ? scrubStr(o) : o;
    };
    const tailFile = (p, maxBytes = 256 * 1024) => {
      try {
        const st = fs.statSync(p); const fd = fs.openSync(p, 'r');
        const start = Math.max(0, st.size - maxBytes);
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
        return (start > 0 ? `…（已截断，仅保留末 ${Math.round(maxBytes / 1024)}KB / 全长 ${st.size} 字节）\n` : '') + scrubStr(buf.toString('utf8'));
      } catch (e) { return `（读取失败: ${e.message}）`; }
    };
    const safe = (fn, dflt) => { try { return fn(); } catch (e) { return dflt !== undefined ? dflt : { error: e && e.message }; } };

    const ud = app.getPath('userData');
    const cfg = safe(() => readLocalConfig(), {});
    // 原始日志全量读取(脱敏)；超大(>8MB)只留尾部，防 zip 过大
    const readScrubbed = (p, maxBytes = 8 * 1024 * 1024) => {
      try {
        const st = fs.statSync(p);
        return st.size > maxBytes ? tailFile(p, maxBytes) : scrubStr(fs.readFileSync(p, 'utf8'));
      } catch (e) { return `（读取失败: ${e.message}）`; }
    };

    const summary = {
      generated_at: new Date().toISOString(),
      app: { version: app.getVersion(), platform: process.platform, arch: process.arch,
             electron: process.versions.electron, node: process.versions.node, os: `${os.type()} ${os.release()}` },
      gateway: {
        status: safe(() => gateway.getStatus()),
        cooldowns: safe(() => require('./gateway-cooldown').list(), []),
        speed_map: safe(() => require('./provider-speed').getSpeedMap(), {}),
      },
      scene_routes: (cfg.scene_routes || []).map(r => ({
        id: r.id, scene_name: r.scene_name, flow: r.flow, model_key: r.model_key,
        steps: (r.steps || []).map(s => s.model || s.strategy || s.tier || s.scope || '?'),
      })),
      files: ['route-log.json', 'config.redacted.json', '3p-sync-debug.log', 'apps-list-debug.json'],
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出诊断日志',
      defaultPath: path.join(app.getPath('downloads'), `tokenbank-diagnostics-${stamp}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    try {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      const add = (name, content) => zip.addFile(name, Buffer.from(
        typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8'));
      add('summary.json', summary);                                       // 概览 + 网关状态/冷却/测速/路由
      add('route-log.json', safe(() => gateway.getLog(), []));            // 完整路由日志
      add('config.redacted.json', redact(cfg));                          // 完整配置(脱敏)
      add('3p-sync-debug.log', readScrubbed(path.join(ud, '3p-sync-debug.log')));  // 完整同步日志(脱敏)
      const appsList = safe(() => fs.readFileSync(path.join(ud, 'apps-list-debug.json'), 'utf8'), null);
      if (appsList) add('apps-list-debug.json', scrubStr(appsList));
      zip.writeZip(res.filePath);
      return { ok: true, file: res.filePath, bytes: fs.statSync(res.filePath).size };
    } catch (e) { console.error('[diagnostics:export]', e.message); return { error: e.message }; }
  });
  // 主动测速探针：发个极小请求走本地网关（按真实模型名路由，非 claude 名不会被 keyScene 改写），
  // 请求跑完网关内部自动 record 记速。返回 {ok,status,latencyMs}。会消耗一次真实调用（P2P 扣积分）。
  ipcMain.handle('gateway:probeModel', (_e, model) => probeModelViaGateway(model));
  ipcMain.handle('gateway:restart',       () => gateway.restart());

  // 已移除「全局路由策略」——无全局默认概念：路由由 app 绑定生效，未绑请求走直连。
  ipcMain.handle('localStats:compression', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    try {
      const since = localStats.sinceTsForDays(d);
      const rates = localStats.queryGatewayInputCostRate(since);
      return require('./compression-report').readCompressionSummary(d, rates);
    }
    catch (e) { console.error('[localStats:compression]', e.message); return { count: 0, before: 0, after: 0, saved: 0, ratio: 0, saved_usd: 0, models: [] }; }
  });
  ipcMain.handle('localStats:todaySummary', () => {
    try { return localStats.queryTodaySummary(); }
    catch (e) { console.error('[localStats:todaySummary]', e.message); return { inTok: 0, outTok: 0, totalTokens: 0, calls: 0 }; }
  });
  ipcMain.handle('localStats:query', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    // 打开盘点页时先补录 Skill/工具（WorkBuddy trace 等），避免「会话有 Skill、盘点却是 0」
    try { scheduleSessionTelemetry(); } catch {}
    const data = localStats.queryDashboard(d);
    // 按应用聚合（合并网关实时 + 会话补录），供「应用用量分布」按应用分组、判定网关/订阅/混合徽章
    try {
      const apps = getApps().filter(a => !a.draft);
      data.app_usage = apps.map(app => {
        const st = localStats.queryAppStatsInPeriod({
          appId: app.id,
          apiKey: app.api_key,
          dataSources: resolveAppDataSources(app),
          days: d,
        });
        return {
          id: app.id,
          name: app.name,
          icon: app.icon || '🔧',
          calls: st.calls,
          tokens: st.tokens,
          proxyCalls: st.proxyCalls,
          sessionCalls: st.sessionCalls,
        };
      }).filter(a => a.calls > 0).sort((a, b) => b.calls - a.calls);
    } catch { data.app_usage = []; }
    // Skill / 工具调用排行（会话补录）
    try {
      data.skill_usage = localStats.querySkillUsageStats({ days: d, limit: 20 });
      data.tool_usage = localStats.queryToolUsageStats({ days: d, limit: 20 });
      data.mcp_usage = localStats.queryMcpUsageStats({ days: d, limit: 20 });
    } catch {
      data.skill_usage = { total: 0, items: [] };
      data.tool_usage = { total: 0, items: [] };
      data.mcp_usage = { total: 0, servers: [], items: [] };
    }
    return data;
  });
  ipcMain.handle('localStats:skillUsage', (_e, daysOrOpts) => {
    const opts = (daysOrOpts && typeof daysOrOpts === 'object') ? daysOrOpts : { days: daysOrOpts };
    const d = Math.max(1, Math.min(365, parseInt(opts.days, 10) || 1));
    const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 20));
    try { return localStats.querySkillUsageStats({ days: d, limit }); }
    catch (e) { console.error('[localStats:skillUsage]', e.message); return { total: 0, items: [] }; }
  });
  ipcMain.handle('localStats:toolUsage', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    try { return localStats.queryToolUsageStats({ days: d, limit: 20 }); }
    catch (e) { console.error('[localStats:toolUsage]', e.message); return { total: 0, items: [] }; }
  });
  ipcMain.handle('localStats:mcpUsage', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    try { return localStats.queryMcpUsageStats({ days: d, limit: 20 }); }
    catch (e) { console.error('[localStats:mcpUsage]', e.message); return { total: 0, servers: [], items: [] }; }
  });
  ipcMain.handle('localStats:modelLatency', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 7));
    try {
      const since = localStats.sinceTsForDays(d);
      return localStats.queryModelProviderLatency(since);
    } catch (e) {
      console.error('[localStats:modelLatency]', e.message);
      return {};
    }
  });
  ipcMain.handle('localStats:reassignProviderTier', (_e, providerId, tier) => {
    try {
      const result = localStats.reassignProviderTier(providerId, tier);
      if (result.updated > 0) {
        try { mainWindow?.webContents?.send('localStats:changed'); } catch {}
      }
      return result;
    } catch (e) {
      console.error('[localStats:reassignProviderTier]', e.message);
      return { updated: 0, error: e.message };
    }
  });
  // 手动触发会话文件补录（扫 ~/.claude、~/.codex、~/.gemini），返回各来源计数
  ipcMain.handle('sessionImport:run', () => scheduleSessionTelemetry({ force: true }));
  // 探测本机 AI 工具/本地服务，返回是否已接入网关的清单
  ipcMain.handle('detectTools:scan', async () => {
    const r = await detectTools.scan();
    return { ...r, scannedAt: Math.floor(Date.now() / 1000) };
  });
  // ── CLI 透明接入（配置驱动）：list/apply/revert ──
  // 记录/解除用户对某 agent 的「取消自动托管」标记
  function setAutoHostDisabled(agentId, disabled) {
    const cfg = readLocalConfig();
    const set = new Set(cfg.auto_host_disabled || []);
    if (disabled) set.add(agentId); else set.delete(agentId);
    cfg.auto_host_disabled = [...set];
    writeLocalConfig(cfg);
  }

  ipcMain.handle('agents:list',    () => agentLinker.list());
  // 手动托管：清除禁用标记后接入
  ipcMain.handle('agents:apply',   (_e, id) => {
    setAutoHostDisabled(id, false);
    const r = agentLinker.applyById(id);
    // 路由态实例：重申 settings.json 网关占位（PROXY_MANAGED），防止其他代理改写后纳管失效
    try {
      for (const a of (readLocalConfig().apps || [])) {
        if (a.link_method === 'shim' && a.agent_id === id && a.instance) {
          syncCliInstanceEndpointConfig(a);
        }
      }
    } catch (e) { console.warn('[cli-instance] endpoint sync (apply):', e && e.message); }
    return r;
  });
  // 手动取消托管：打上禁用标记，自动托管不再重新接入
  ipcMain.handle('agents:revert',  (_e, id) => { setAutoHostDisabled(id, true); try { revertCliInstanceEndpointConfigs(id); } catch {} return agentLinker.revertById(id); });
  ipcMain.handle('agents:applyAll',  () => {
    // 一键托管：清空所有禁用标记后全部接入
    const cfg = readLocalConfig();
    cfg.auto_host_disabled = [];
    writeLocalConfig(cfg);
    return agentLinker.applyAll();
  });
  ipcMain.handle('agents:revertAll', () => {
    // 全部取消托管：把所有工具加入禁用标记
    const cfg = readLocalConfig();
    cfg.auto_host_disabled = agentLinker.list().map(t => t.id);
    writeLocalConfig(cfg);
    try { revertCliInstanceEndpointConfigs(); } catch {}
    return agentLinker.revertAll();
  });

  // ── 配置导入（统一格式，tools 段 + scene_routes 段，各自写入对应存储）────────
  // 格式：{ version, tools, protocols, mitm, routing, scene_routes, ... }
  // tools/protocols/mitm/routing 段 → ~/.tokenbank/tokenbank.yaml（config-loader）
  // scene_routes 段               → local-config.scene_routes
  const configLoader = require('./config-loader');
  const TB_TOOLS_YAML = path.join(os.homedir(), '.tokenbank', 'tokenbank.tools.yaml');
  const USER_REGISTRY_YAML = path.join(os.homedir(), '.tokenbank', 'providers.registry.yaml');
  // 应用段 → tokenbank.yaml；源目录 → providers.registry.yaml（废弃 tokenbank.tools.yaml）
  const APP_SECTIONS = new Set(['version', 'gateway', 'mitm', 'claude_models', 'app_entities', 'session_scans', 'handlers']);
  const SOURCE_SECTIONS = new Set(['subscription_plans', 'subscription_apps', 'api_subscription_apps', 'payg_providers']);
  const ROUTES_SECTIONS = new Set(['scene_routes']);

  /** 写入云端下发的 providers.registry.yaml，并删除旧 tokenbank.tools.yaml */
  function applyRegistryDoc(parsed, opts = {}) {
    const yamlLib = require('js-yaml');
    const tbDir = path.join(os.homedir(), '.tokenbank');
    if (!fs.existsSync(tbDir)) fs.mkdirSync(tbDir, { recursive: true });
    // 服务端旧库可能只有 providers，补全 billing_sources 避免个人源目录为空
    let doc = parsed && typeof parsed === 'object' ? { ...parsed } : {};
    try {
      const existing = fs.existsSync(USER_REGISTRY_YAML)
        ? yamlLib.load(fs.readFileSync(USER_REGISTRY_YAML, 'utf8')) || {}
        : {};
      const builtin = yamlLib.load(
        fs.readFileSync(path.join(__dirname, 'config', 'providers.registry.yaml'), 'utf8'),
      ) || {};
      if (!Array.isArray(doc.billing_sources) || !doc.billing_sources.length) {
        doc.billing_sources = (existing.billing_sources?.length && existing.billing_sources)
          || builtin.billing_sources
          || [];
      }
    } catch (e) {
      console.warn('[config] merge billing_sources failed:', e.message);
    }
    fs.writeFileSync(USER_REGISTRY_YAML, yamlLib.dump(doc, { lineWidth: 120 }), 'utf8');
    try { if (fs.existsSync(TB_TOOLS_YAML)) fs.unlinkSync(TB_TOOLS_YAML); } catch {}
    configLoader.reloadRegistryDoc();
    try {
      const cfg = readLocalConfig();
      const { cfg: pruned, changed } = billingConfigMod.pruneLocalBillingAgainstServer(cfg);
      if (changed) {
        applyUserBillingCfg(pruned);
        console.log('[config] 已按服务端 registry 清理本地过期计费数据');
      }
    } catch (e) {
      console.warn('[config] prune local billing failed:', e.message);
    }
    try { mainWindow?.webContents?.send('billing:changed'); } catch {}
    try { mainWindow?.webContents?.send('catalog:updated'); } catch {}
    return { ok: true, applied: { registry: true } };
  }

  function applyConfigDoc(parsed, source, opts = {}) {
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: '无效的 yaml 格式' };
    const yamlLib = require('js-yaml');
    const replace = opts.replace === true;
    const applied = { tools: false, routes: false, registry: false };
    const addedApps = [];   // 本次同步「新增」的工具/应用（id 之前没有、现在有）

    // providers.registry 格式（云端唯一下发源目录）
    const isRegistryDoc = Array.isArray(parsed.providers) || Array.isArray(parsed.billing_sources);
    const hasAppSection = Object.keys(parsed).some(k => APP_SECTIONS.has(k) && k !== 'version');
    if (isRegistryDoc && !hasAppSection) {
      const r = applyRegistryDoc(parsed, opts);
      applied.registry = true;
      // 同文件内若带 scene_routes 继续处理（少见）
      if (Array.isArray(parsed.scene_routes) && parsed.scene_routes.length > 0) {
        // fall through to routes handling below — 简化：registry 下发通常不含 routes
      } else {
        return { ...r, applied, addedApps, addedRoutes: [], removedRoutes: [] };
      }
    }

    // 应用段 → tokenbank.yaml
    const hasSourceSection = Object.keys(parsed).some(k => SOURCE_SECTIONS.has(k));
    if (hasAppSection || hasSourceSection) {
      const tbDir = path.join(os.homedir(), '.tokenbank');
      if (!fs.existsSync(tbDir)) fs.mkdirSync(tbDir, { recursive: true });
      // 应用前：记录现有工具 + api-key 应用的 id 集合（用于算新增）
      const beforeIds = new Set();
      try {
        for (const t of configLoader.tools()) beforeIds.add('tool:' + t.id);
        for (const a of (configLoader.apiKeyApps() || [])) beforeIds.add('app:' + a.id);
        for (const s of (configLoader.sessionSources() || [])) {
          if (s.direct_only) beforeIds.add('direct:' + s.id);
        }
      } catch {}
      // replace=true：服务端全量覆盖；否则与本地文件合并
      const writeMerged = (file, sectionSet) => {
        let doc;
        if (replace) {
          doc = { version: parsed.version || 1 };
          for (const k of Object.keys(parsed)) {
            if (sectionSet.has(k) || k === 'version') doc[k] = parsed[k];
          }
        } else {
          let existing = {};
          try { if (fs.existsSync(file)) existing = yamlLib.load(fs.readFileSync(file, 'utf8')) || {}; } catch {}
          doc = { ...existing };
          for (const k of Object.keys(parsed)) {
            if (sectionSet.has(k) || k === 'version') doc[k] = parsed[k];
          }
        }
        fs.writeFileSync(file, yamlLib.dump(doc, { lineWidth: 120 }), 'utf8');
      };
      if (hasAppSection) writeMerged(TB_YAML, APP_SECTIONS);
      // 旧 tokenbank.tools.yaml 格式已废弃，不再写入；请通过 GET /config/providers 同步
      if (hasSourceSection) {
        console.warn('[config] 收到旧 config.sources 格式，已忽略；请升级服务端并使用 /config/providers');
      }
      configLoader.load();
      applied.tools = true;

      // 应用后：算出新增的工具/应用（id 在 before 集合里没有的）
      try {
        for (const t of configLoader.tools()) if (!beforeIds.has('tool:' + t.id)) addedApps.push(t.name || t.id);
        for (const a of (configLoader.apiKeyApps() || [])) if (!beforeIds.has('app:' + a.id)) addedApps.push(a.name || a.id);
        for (const s of (configLoader.sessionSources() || [])) {
          if (s.direct_only && !beforeIds.has('direct:' + s.id)) addedApps.push(s.app_name || s.id);
        }
      } catch {}

      // 通知渲染进程刷新应用列表（让新的可配置行 / 托管状态立即显示）
      try { mainWindow?.webContents?.send('apps:changed'); } catch {}
    }

    // （已移除全局默认策略下发：无全局默认概念）

    // 路由配置（scene_routes）→ 写入 local-config
    // replace 时空数组也要处理：服务端删光目录时客户端同步删除系统下发路由
    const hasScenes = Array.isArray(parsed.scene_routes)
      && (parsed.scene_routes.length > 0 || opts.replace === true);
    const addedRoutes = [];     // 本次同步「新增」的场景路由（本地没有、server 有）
    const removedRoutes = [];   // 本次同步「删除」的系统下发路由（server 已无、本地有）
    if (hasScenes) {
      const cfg = readLocalConfig();
      const now = new Date().toISOString();
      const local = cfg.scene_routes || [];
      const localKeys = new Set();
      for (const r of local) { if (r.id) localKeys.add(r.id); if (r.model_key) localKeys.add(r.model_key); }
      // replace=true（服务端全量同步）：按 id 合并更新；系统下发已删的从本地移除；保留用户自建
      if (opts.replace === true) {
        const { mergeSceneRoutesReplace } = require('./scene-routes-sync');
        const merged = mergeSceneRoutesReplace(local, parsed.scene_routes, {
          prevSyncedIds: cfg.synced_server_route_ids,
          now,
        });
        for (const name of merged.addedRoutes) addedRoutes.push(name);
        for (const name of merged.removedRoutes) removedRoutes.push(name);
        cfg.scene_routes = merged.routes;
        cfg.synced_server_route_ids = merged.syncedIds;
        // 同步删掉的默认路由记入 tombstone，避免启动补齐复活
        if (merged.removedDefaultIds.length) {
          cfg.removed_default_routes = Array.isArray(cfg.removed_default_routes)
            ? cfg.removed_default_routes : [];
          for (const id of merged.removedDefaultIds) {
            if (!cfg.removed_default_routes.includes(id)) cfg.removed_default_routes.push(id);
          }
        }
      } else {
        const newFromServer = parsed.scene_routes
          .filter(r => !localKeys.has(r.id) && !localKeys.has(r.model_key))
          .map(r => ({ ...r, from_server: true, created_at: r.created_at || now }));
        for (const r of newFromServer) addedRoutes.push(r.scene_name || r.model_key || r.id);
        cfg.scene_routes = [...local, ...newFromServer];
        // 增量同步也记下已见过的服务端 id，便于下次 replace 能正确删
        const seen = new Set(Array.isArray(cfg.synced_server_route_ids) ? cfg.synced_server_route_ids : []);
        for (const r of parsed.scene_routes || []) { if (r?.id) seen.add(r.id); }
        cfg.synced_server_route_ids = [...seen];
      }
      cfg.initialized_routes = true;
      writeLocalConfig(cfg);
      syncGatewayFromConfig(cfg);
      applied.routes = true;
    }

    // 工具配置变更后（claude_models / 计费目录可能更新）→ 同步给网关与刊例价
    if (applied.tools) {
      try { gateway.setClaudeModels(configLoader.claudeModels()); } catch {}
      try {
        const cfg = readLocalConfig();
        require('./billing-config').applyPricingOverrides(cfg.provider_pricing_overrides || {});
      } catch {}
      // 通知前端刷新个人页报价 / 订阅目录
      try { mainWindow?.webContents?.send('billing:changed'); } catch {}
    }

    if (!applied.tools && !applied.routes) {
      return { ok: false, error: '文件中未找到可识别的配置段（app_entities / scene_routes）' };
    }
    return { ok: true, source, applied, addedApps, addedRoutes, removedRoutes };
  }

  function fetchYaml(url, token) {
    const https = require('https'); const http = require('http');
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      // /config/apps 公开；sources/scenes 等仍可选带 JWT
      const opts = { timeout: 10000, headers: token ? { Authorization: `Bearer ${token}` } : {} };
      mod.get(url, opts, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            const hint = res.statusCode === 401
              ? '请确认已登录（此接口需要鉴权）'
              : '请确认服务器已上传配置';
            reject(new Error(`服务器返回 HTTP ${res.statusCode}（${hint}）`));
          } else {
            resolve(data);
          }
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  ipcMain.handle('toolsConfig:load', () => {
    try {
      if (fs.existsSync(TB_YAML)) return { ok: true, source: 'user', text: fs.readFileSync(TB_YAML, 'utf8') };
      const def = path.join(__dirname, 'config', 'tokenbank.default.yaml');
      return { ok: true, source: 'default', text: fs.existsSync(def) ? fs.readFileSync(def, 'utf8') : '' };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 选目录（CLI 实例生效目录 dir_glob）
  ipcMain.handle('dialog:selectDirectory', async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(mainWindow, { title: '选择生效目录', properties: ['openDirectory'] });
    return (r.canceled || !r.filePaths.length) ? null : r.filePaths[0];
  });

  ipcMain.handle('toolsConfig:importFile', async () => {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入配置文件（工具 / 路由）', filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    try {
      const text = fs.readFileSync(result.filePaths[0], 'utf8');
      const parsed = require('js-yaml').load(text);
      return applyConfigDoc(parsed, result.filePaths[0]);
    } catch (e) { return { ok: false, error: e.message }; }
  });

  /** 从 Token Bank 服务端拉取 apps / providers.registry / scenes 配置 */
  async function pullServerConfig(serverUrl, token, { replace = false } = {}) {
    const base = String(serverUrl || '').replace(/\/$/, '').replace(/\/(api|v\d+)(\/.*)?$/, '');
    if (!base) return { ok: false, error: 'missing_server' };
    const results = [];
    for (const ep of ['/api/config/apps', '/api/config/providers', '/api/config/scenes']) {
      const url = base + ep;
      const isPublicApps = ep === '/api/config/apps';
      if (!isPublicApps && !token) {
        results.push({ endpoint: ep, ok: false, error: 'missing_auth' });
        continue;
      }
      try {
        const text = await fetchYaml(url, isPublicApps ? (token || null) : token);
        const parsed = require('js-yaml').load(text);
        const shouldReplace = replace && (ep.includes('/apps') || ep.includes('/providers') || ep.includes('/scenes'));
        const r = applyConfigDoc(parsed, url, { replace: shouldReplace });
        results.push({ endpoint: ep, ...r });
      } catch (e) {
        results.push({ endpoint: ep, ok: false, error: e.message });
      }
    }
    return { ok: results.some(r => r.ok), results };
  }

  ipcMain.handle('toolsConfig:importUrl', async (_e, arg) => {
    // 兼容旧签名（字符串 url）与新签名（{ url, token, replace }）
    const url     = typeof arg === 'string' ? arg : arg?.url;
    const token   = typeof arg === 'string' ? null : arg?.token;
    const replace = typeof arg === 'string' ? false : !!arg?.replace;
    try {
      const text = await fetchYaml(url, token);
      const parsed = require('js-yaml').load(text);
      const u = String(url || '');
      // apps / providers / scenes 均为服务端权威目录：全量合并（含同步删除）
      const isServerCatalog = u.includes('/config/apps') || u.includes('/config/providers') || u.includes('/config/scenes');
      return applyConfigDoc(parsed, url, { replace: replace || isServerCatalog });
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('toolsConfig:syncRemote', async (_e, { token, serverUrl, replace = true } = {}) => {
    return pullServerConfig(serverUrl, token, { replace });
  });

  ipcMain.handle('toolsConfig:reset', () => {
    try {
      if (fs.existsSync(TB_YAML)) fs.unlinkSync(TB_YAML);
      configLoader.load();
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('gateway:setStrategy', (_e, strategy) => {
    if (strategy !== 'cost' && strategy !== 'quality') return { ok: false, error: 'invalid_strategy' };
    gateway.setStrategy(strategy);
    return { ok: true };
  });

  // ── Local Config (scene routes + local keys, stored in userData) ─────────────

  function rndHex(bytes) {
    return require('crypto').randomBytes(bytes).toString('hex');
  }

  function syncGatewayFromConfig(cfg) {
    const routes = cfg.scene_routes || [];
    const apps   = cfg.apps         || [];
    // llm-router-* → scene steps / 策略路由（从 scene_routes 生成）
    const routerMap = {};
    for (const r of routes) {
      // 策略/过滤路由：无 steps/rules，但有 strategy / flow / scope / tier —— 模型无关，
      // 网关按类型扫候选 + 策略排序(stratStepOf 识别 flow/scope/tier)。综合最优/免费源/社区源/个人源 皆此类。
      if (r.model_key && (r.strategy || r.flow || r.scope || r.tier) && !(r.steps?.length || r.rules?.length)) {
        const entry = { scene_name: r.scene_name, id: r.id || r.model_key,
          ...(r.strategy ? { strategy: r.strategy } : {}),
          ...(r.flow ? { flow: r.flow } : {}),
          ...(r.scope ? { scope: r.scope } : {}),
          ...(r.tier ? { tier: r.tier } : {}) };
        routerMap[r.model_key] = entry;
        if (r.id && r.id !== r.model_key) routerMap[r.id] = entry;
        // scene_name 别名兜底：已部署的应用配置可能直接发中文显示名（如 Codex config.toml 里 model="综合最优"），无需重纳管也能解析
        if (r.scene_name && !routerMap[r.scene_name]) routerMap[r.scene_name] = entry;
        continue;
      }
      if (r.model_key && (r.steps?.length || r.rules?.length)) {
        // 带 steps/rules 的路由也要带上路由级 scope/tier/flow，否则"路由级过滤 + 模型链"会丢过滤
        const entry = { steps: r.steps || [], scene_name: r.scene_name, rules: r.rules || null, classifier: r.classifier || null,
          ...(r.flow ? { flow: r.flow } : {}), ...(r.scope ? { scope: r.scope } : {}), ...(r.tier ? { tier: r.tier } : {}) };
        routerMap[r.model_key] = entry;
        if (r.id && r.id !== r.model_key) routerMap[r.id] = entry;
        if (r.scene_name && !routerMap[r.scene_name]) routerMap[r.scene_name] = entry;
      }
    }
    // manual / api-key apps: if model_intercept is set, redirect that incoming model name to the configured route
    const { parseRouteBinding } = require('../shared/route-binding');
    for (const app of apps) {
      if (app.model_intercept && app.route_id) {
        const parsed = parseRouteBinding(app.route_id, routes);
        if (parsed.isScene && parsed.scene) {
          const s = parsed.scene;
          // 带上路由级 flow/scope/tier，否则 model_intercept 绑到策略/过滤路由（收费源/个人源等）会丢过滤
          routerMap[app.model_intercept] = { steps: s.steps || [], scene_name: s.scene_name, rules: s.rules || null, classifier: s.classifier || null,
            ...(s.flow ? { flow: s.flow } : {}), ...(s.scope ? { scope: s.scope } : {}), ...(s.tier ? { tier: s.tier } : {}) };
        } else {
          const modelId = parsed.modelId || app.route_id;
          routerMap[app.model_intercept] = { steps: [{ model: modelId, ...(parsed.tier ? { tier: parsed.tier } : {}) }], scene_name: app.name || modelId, rules: null, classifier: null };
        }
      }
    }
    gateway.setRouterModelMap(routerMap);
    // api key → route（从 apps 生成，替代旧的 local_keys）
    // ── 请求控制：api-key 按 key 匹配，shim 按协议路径匹配 ──────────────────────
    const PROTOCOL_PATH = {
      anthropic: '/v1/messages',
      responses: '/v1/responses',
      openai:    '/v1/chat/completions',
      gemini:    '/v1beta',
    };
    // agent_id → protocol（来自 tools 配置）
    const toolProto = {};
    let appEntityById = () => null;
    try {
      const cl = require('./config-loader');
      appEntityById = (id) => cl.appEntityById(id);
      for (const t of cl.tools()) toolProto[t.id] = t.protocol;
    } catch {}

    const appControls = [];
    const keyScene = {};
    let claudeShimScene = null;    // Claude Code CLI（anthropic shim）绑定的路由（按「非 api-key 调用方」生效）
    const codexGptFallback = {};   // Codex 内建 gpt-* 辅助模型 → 兜底到该应用绑定的主路由（按 api_key）
    const { bindClaudeRoutesToKeyScene, bindClaudeCliRouteToKeyScene, bindRouteToKeyScene } = require('../shared/route-binding');
    for (const app of apps) {
      const ctrl = { app_id: app.id, app_name: app.name };
      const aid = app.agent_id || app.preset_id;
      const ent = aid ? appEntityById(aid) : null;
      const caps = aid ? (() => { try { return require('./config-loader').appCapabilities(aid); } catch { return null; } })() : null;
      const gwProxy = caps ? !!caps.gateway_proxy : !!ent?.gateway_proxy;
      // 与 apps:list 的 resolveRouteBindable 一致：无 preset 的 manual 应用仍可按 route_id 绑路由
      const routeBindable = (() => {
        if (!aid) return app.route_bindable !== false;
        if (app.link_method === 'api-key' || app.link_method === 'manual' || app.link_method === 'shim') {
          return gwProxy && (ent ? ent.route_bindable !== false : app.route_bindable !== false);
        }
        if (app.link_method === 'session') {
          const sessCaps = caps || ent?.capabilities || {};
          return !!(sessCaps.session_trace || sessCaps.session_usage_import)
            && (ent ? ent.route_bindable !== false : app.route_bindable !== false);
        }
        return ent ? ent.route_bindable !== false : app.route_bindable !== false;
      })();
      if ((app.link_method === 'api-key' || app.link_method === 'manual' || app.link_method === 'session') && app.api_key) {
        appControls.push({ ...ctrl, match: { key: app.api_key } });
        const appRouteIds = (Array.isArray(app.route_ids) && app.route_ids.length)
          ? app.route_ids
          : (app.route_id ? [app.route_id] : []);
        if (appRouteIds.length && routeBindable) {
          // Claude Desktop：claude-* 名（inferenceModels.name）→ 绑定的 route；api_key 仅识别应用，不改写 model
          if (isClaudeDesktopApp(app.id)) {
            const cms = (() => { try { return require('./config-loader').claudeModels(); } catch { return []; } })();
            bindClaudeRoutesToKeyScene(keyScene, app.api_key, appRouteIds, routes, cms);
          }
          // Codex：多选路由按「模型名 → 对应 route」写入 keyScene，请求 gpt-5.6-luna 就走 luna；
          // 同时保留 gpt-* 兜底：Codex 内建辅助模型（标题/分类等，非用户配置）仍落到主路由。
          // 跳过 Claude Desktop 透明 mask 名：与真实模型同名时自指绑定会污染路由详情，且 Responses 常 400。
          {
            const { canonicalAppEntityId, routeModelId } = require('./app-handlers');
            if (canonicalAppEntityId(app.preset_id || app.agent_id) === 'codex'
              || String(app.preset_id || app.agent_id || app.id || '').includes('codex')) {
              const maskNames = new Set(
                (() => { try { return require('./config-loader').claudeModels() || []; } catch { return []; } })()
              );
              const sub = keyScene[app.api_key] || (keyScene[app.api_key] = {});
              for (const rid of appRouteIds) {
                const mid = routeModelId(rid, routes);
                if (!mid || maskNames.has(mid)) continue;
                bindRouteToKeyScene(sub, mid, rid, routes);
              }
              const primary = appRouteIds.find(rid => {
                const mid = routeModelId(rid, routes);
                return mid && !maskNames.has(mid);
              }) || appRouteIds[0];
              bindRouteToKeyScene(codexGptFallback, app.api_key, primary, routes);
            }
          }
        }
      } else if (app.link_method === 'shim' && app.agent_id) {
        if (!routeBindable || !toolProto[app.agent_id]) continue;
        const path = PROTOCOL_PATH[toolProto[app.agent_id]];
        if (path) appControls.push({ ...ctrl, match: { path } });
        // Claude Code CLI（anthropic shim）双通道：
        //  A) 旧行为兜底：shim 只注 base_url、claude 发自己的 claude.ai OAuth（无 app key）时，
        //     按 claudeShimScene 绑定（网关对「非 api-key 调用方」的 claude-* 请求用它）。
        //  B) per-app：shim 若注入了 app key（ANTHROPIC_AUTH_TOKEN={KEY}），claude 就成了 api-key 调用方，
        //     注册 match.key + 建 keyScene[key][claude模型名]。注意：CLI 客户端会发任意 claude-* 名
        //     （sonnet/haiku…，不受我们控制），所以把选中的单条 route 绑到【所有】claude 名上，
        //     而非像 Desktop 那样按 inferenceModels.name 顺序 1:1 绑（否则只有 cms[0] 命中、其余 404）。
        if (toolProto[app.agent_id] === 'anthropic') {
          const appRouteIds = (Array.isArray(app.route_ids) && app.route_ids.length)
            ? app.route_ids : (app.route_id ? [app.route_id] : []);
          if (appRouteIds.length) {
            const tmp = {};
            bindRouteToKeyScene(tmp, '_shim', appRouteIds[0], routes);
            claudeShimScene = tmp._shim || null;
            if (app.api_key) {
              appControls.push({ ...ctrl, match: { key: app.api_key } });
              const cms = (() => { try { return require('./config-loader').claudeModels(); } catch { return []; } })();
              bindClaudeCliRouteToKeyScene(keyScene, app.api_key, appRouteIds[0], routes, cms);
            }
          }
        }
      }
    }
    gateway.setAppControls(appControls);
    gateway.setKeySceneMap(keyScene);
    gateway.setClaudeShimScene(claudeShimScene);
    gateway.setCodexGptFallback(codexGptFallback);

    // P2P backend config（登出时也要清空，避免残留 token 继续上报）
    const cc = cfg.cloud_config || {};
    gateway.setBackendConfig({ url: cc.url || null, token: cc.token || null });
    const userJwt = cfg.user_session?.jwt || null;
    gateway.setUserAuth(userJwt);
  }

  // Fetch currently active P2P model names from /v1/models (requires auth, reflects live workers)
  async function fetchPeerModels(backendUrl, cloudToken) {
    if (!backendUrl || !cloudToken) {
      gateway.setPeerModels([]);
      return;
    }
    const url = backendUrl.replace(/\/$/, '') + '/v1/models';
    try {
      const r = await nodeRequest(url, 'GET', { Authorization: `Bearer ${cloudToken}` }, null);
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const names = (data.data || []).map(m => m.id).filter(Boolean);
        gateway.setPeerModels(names);
      } else {
        console.warn('[main] fetchPeerModels: status', r.status);
        gateway.setPeerModels([]);
      }
    } catch (err) {
      console.warn('[main] fetchPeerModels failed:', err.message);
    }
  }

  // Sync on startup
  const _initCfg = readLocalConfig();
  try {
        require('./billing-config').applyPricingOverrides(_initCfg.provider_pricing_overrides || {});
  } catch {}
  syncGatewayFromConfig(_initCfg);
  fetchPeerModels(_initCfg.cloud_config?.url, _initCfg.cloud_config?.token);
  // 启动扫描 CLI 多账号实例（迁移旧记录 + 补新账号，幂等）
  try { const r = reconcileCliInstancesIntoApps(); if (r.changed) console.log('[cli-instances] startup reconcile: +' + r.added); } catch {}

  ipcMain.handle('localConfig:get', () => readLocalConfig());
  // 手动/百宝箱装完后重扫 CLI 多账号实例
  ipcMain.handle('cli:rescanInstances', () => reconcileCliInstancesIntoApps());
  // 账户下拉：本机扫到的账户（标已建记录的 config_dir），供「手工新建 CLI 实例」选择
  ipcMain.handle('cli:scanAccounts', (_e, tool) => {
    try {
      const cli = require('./cli-instances');
      const apps = getApps();
      const existing = new Set(apps.filter(a => a.link_method === 'shim' && a.agent_id === tool && a.instance)
        .map(a => path.resolve(a.instance.config_dir || '')));
      return cli.mergeAccountOptions(cli.scanCliInstances(tool), [], existing);
    } catch (e) { return []; }
  });
  // 手工新建一个 CLI 实例记录（指定账户 config_dir + 生效目录 + 路由），并重生成 shim 分发
  ipcMain.handle('cli:addInstance', (_e, opts = {}) => {
    try {
      const { tool, config_dir, account_email, subscription, dir_glob, route_id } = opts;
      if (!tool || !config_dir) return { ok: false, error: 'missing tool/config_dir' };
      const apps = getApps();
      if (apps.some(a => a.link_method === 'shim' && a.agent_id === tool && a.instance
        && path.resolve(a.instance.config_dir || '') === path.resolve(config_dir))) {
        return { ok: false, error: 'exists' };   // 该 config_dir 已有实例
      }
      const label = account_email ? String(account_email).split('@')[0] : path.basename(config_dir);
      const prefix = tool === 'codex' ? 'Codex CLI' : 'Claude Code CLI';
      const used = new Set(apps.map(a => a.name).filter(Boolean));
      let name = `${prefix} · ${label}`;
      for (let n = 2; used.has(name); n++) name = `${prefix} · ${label} (${n})`;
      const rec = {
        id: `app-shim-${tool}-${rndHex(6)}`, name, icon: 'icon:cube',
        link_method: 'shim', agent_id: tool, api_key: 'sk-local-' + rndHex(16),
        route_id: route_id || null, hosted: true,
        instance: { config_dir, is_default: false, account_email: account_email || null,
          subscription: subscription || null, has_credentials: true, invalid: false, dir_glob: dir_glob || null },
        created_at: new Date().toISOString(),
      };
      apps.push(rec);
      saveApps(apps);
      // 该 shim 若已托管 → 重生成以纳入新实例的目录分发
      try {
        const t = require('./config-loader').tools().find(x => x.id === tool);
        const cmd = (t && t.detect && t.detect.command) || tool;
        if (require('./shim-installer').shimExists(cmd)) agentLinker.applyById(tool);
      } catch {}
      return { ok: true, app: rec };
    } catch (e) { return { ok: false, error: e && e.message }; }
  });

  // 供给源目录：后台拉 /api/catalog 写 yaml，UI 读本地 yaml
  const catalogSync = require('./catalog-sync');

  function notifyCatalogUpdated() {
    try { mainWindow?.webContents?.send('catalog:updated'); } catch {}
    try { mainWindow?.webContents?.send('billing:changed'); } catch {}
  }

  ipcMain.handle('localConfig:getProviderCatalog', () => catalogSync.readCatalogFromYaml());
  ipcMain.handle('localConfig:getBuiltinCatalog', () => {
    const configLoader = require('./config-loader');
    return configLoader.builtinCatalogPayload();
  });
  ipcMain.handle('localConfig:syncProviderCatalog', async () => {
    const cfg = readLocalConfig();
    const result = await catalogSync.syncCatalogToRegistry({
      readLocalConfig,
      applyUserBillingCfg,
      onApplied: notifyCatalogUpdated,
      token: cfg?.user_session?.jwt || null,
      serverUrl: resolveBillingServerUrl(),
    });
    return result;
  });

  // 个人页计费：云端同步辅助
  const cloudBilling = require('./cloud-billing-sync');

  /** 解析 Token Bank 服务地址：优先调用方传入，其次 cloud_config.url，最后 env */
  function resolveBillingServerUrl(serverUrl) {
    const explicit = cloudBilling.normalizeBase(serverUrl);
    if (explicit) return explicit;
    const cfg = readLocalConfig();
    const fromCfg = cloudBilling.normalizeBase(cfg?.cloud_config?.url);
    if (fromCfg) return fromCfg;
    return defaultServerUrlFromEnv();
  }

  function applyUserBillingCfg(cfg, overrides) {
    billingConfigMod.applyPricingOverrides(overrides || cfg.provider_pricing_overrides || {});
    writeLocalConfig(cfg);
    syncAgentProviderModelsFromAccounts();
  }

  // 启动时后台拉 /api/catalog 同步供给源（非阻塞；无 cloud_config 时用 env 默认地址）
  catalogSync.scheduleBackgroundSync({
    readLocalConfig,
    applyUserBillingCfg,
    onApplied: notifyCatalogUpdated,
    token: _initCfg.user_session?.jwt || null,
    serverUrl: resolveBillingServerUrl(),
  });

  async function pullUserBilling(_auth = {}) {
    const cfg = readLocalConfig();
    applyUserBillingCfg(cfg);
    return cfg;
  }

  async function pushUserBilling({ token, serverUrl, ...patch } = {}) {
    let cfg = readLocalConfig();
    if (Array.isArray(patch.user_subscriptions)) cfg.user_subscriptions = patch.user_subscriptions;
    if (Array.isArray(patch.user_payg_providers)) cfg.user_payg_providers = patch.user_payg_providers;
    if (patch.subscription_plans && typeof patch.subscription_plans === 'object') {
      cfg.subscription_plans = patch.subscription_plans;
    }
    if (patch.provider_pricing_overrides && typeof patch.provider_pricing_overrides === 'object') {
      cfg.provider_pricing_overrides = patch.provider_pricing_overrides;
    }
    if (patch.source_template_overrides && typeof patch.source_template_overrides === 'object') {
      cfg.source_template_overrides = patch.source_template_overrides;   // 本地模板覆盖
    }
    if (patch.custom_source_templates && typeof patch.custom_source_templates === 'object') {
      cfg.custom_source_templates = patch.custom_source_templates;       // 自定义源模板（纯本地）
    }
    if (patch.direct_source_billing && typeof patch.direct_source_billing === 'object') {
      cfg.direct_source_billing = patch.direct_source_billing;           // 直连应用计费
    }
    // 个人供给源仅写本机；账户摘要由设备心跳单向上报
    applyUserBillingCfg(cfg);
    return cfg;
  }

  // 订阅套餐 + 模型刊例价（个人页管理）
  ipcMain.handle('localConfig:getBilling', async (_e, auth = {}) => {
    const cfg = await pullUserBilling(auth);
    return billingConfigMod.getBillingSettings(cfg);
  });
  ipcMain.handle('localConfig:setBilling', async (_e, payload = {}) => {
    const { token, serverUrl, subscription_plans, provider_pricing_overrides } = payload;
    const cfg = await pushUserBilling({
      token, serverUrl, subscription_plans, provider_pricing_overrides,
    });
    return billingConfigMod.getBillingSettings(cfg);
  });
  ipcMain.handle('localConfig:resetBilling', async (_e, payload = {}) => {
    const { token, serverUrl, scope } = payload;
    const patch = {};
    if (scope === 'pricing' || scope === 'all') patch.provider_pricing_overrides = {};
    if (scope === 'plans' || scope === 'all') patch.subscription_plans = {};
    const cfg = await pushUserBilling({ token, serverUrl, ...patch });
    return billingConfigMod.getUserAccounts(cfg, { boundDirectAgentIds: boundDirectAgentIds() });
  });

  // 个人页：积分 / 订阅 / 按量付费账户
  // 已绑路由（走网关）的直连应用 agent_id —— 这些从「直连源」里移除（已变成路由源）；
  // 其余 direct_only 源默认都展示，可在「个人源」里设计费。
  function boundDirectAgentIds() {
    try {
      return getApps()
        .filter(a => a && a.link_method === 'direct' && a.route_id)
        .map(a => a.agent_id).filter(Boolean);
    } catch { return []; }
  }
  ipcMain.handle('localConfig:setLiveCatalog', async (_e, payload = {}) => {
    billingConfigMod.setLiveCatalogPayload(payload);
    // 不广播 billing:changed，避免 Providers 页 catalog 拉取 ↔ 账户重载死循环
    return { ok: true };
  });
  ipcMain.handle('localConfig:getUserAccounts', async () => {
    let cfg = readLocalConfig();
    const { cfg: pruned, changed } = billingConfigMod.pruneLocalBillingAgainstServer(cfg);
    if (changed) applyUserBillingCfg(pruned);
    cfg = pruned;
    return billingConfigMod.getUserAccounts(cfg, { boundDirectAgentIds: boundDirectAgentIds() });
  });
  ipcMain.handle('localConfig:setUserAccounts', async (_e, payload = {}) => {
    const cfg = await pushUserBilling(payload);
    return billingConfigMod.getUserAccounts(cfg, { boundDirectAgentIds: boundDirectAgentIds() });
  });
  /** 账户摘要随设备心跳上报；不再 PUT /user/accounts 同步配置 */
  ipcMain.handle('localConfig:pushUserAccountsToCloud', async () => {
    const cfg = readLocalConfig();
    return billingConfigMod.getUserAccounts(cfg, { boundDirectAgentIds: boundDirectAgentIds() });
  });

  ipcMain.handle('localConfig:createSceneRoute', (_e, { scene_name, icon, steps, rules, classifier, flow, caveman_level, scope, tier }) => {
    const cfg   = readLocalConfig();
    const route = {
      id: rndHex(8), scene_name, icon: icon || '🔀',
      steps: steps || [],             // 每步可选带 when 条件（统一后不再单独存 rules）
      rules: rules || null,           // 兼容旧条件路由规则（when → steps）
      classifier: classifier || null, // 语义分类器配置
      flow: flow || null,             // 链级流转策略
      scope: scope || null,           // 路由级来源过滤(personal/community)
      tier: tier || null,             // 路由级价格过滤(free/paid)
      caveman_level: caveman_level || null, // 输出风格
      model_key: 'llm-router-' + rndHex(6),
      user_owned: true,               // 用户自建：在线同步不删、不覆盖
      created_at: new Date().toISOString(),
    };
    cfg.scene_routes.push(route);
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return route;
  });

  ipcMain.handle('localConfig:updateSceneRoute', (_e, { id, scene_name, icon, steps, rules, classifier, flow, caveman_level, scope, tier }) => {
    const cfg = readLocalConfig();
    const idx = cfg.scene_routes.findIndex(r => r.id === id);
    if (idx === -1) return null;
    // 用户本地改过 → 标记为自有配置，在线同步不删、不覆盖
    const prev = cfg.scene_routes[idx];
    const next = {
      ...prev, scene_name, icon, steps, rules: rules || null, classifier: classifier || null,
      flow: flow || null, caveman_level: caveman_level || null, scope: scope || null, tier: tier || null,
      user_owned: true,
    };
    delete next.from_server;
    cfg.scene_routes[idx] = next;
    if (Array.isArray(cfg.synced_server_route_ids)) {
      cfg.synced_server_route_ids = cfg.synced_server_route_ids.filter(x => x !== id);
    }
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return cfg.scene_routes[idx];
  });

  ipcMain.handle('localConfig:deleteSceneRoute', (_e, id) => {
    const cfg = readLocalConfig();
    cfg.scene_routes = cfg.scene_routes.filter(r => r.id !== id);
    // 若删的是「默认路由」，记下来，避免下次启动自动补齐时复活（尊重用户删除意图）
    try {
      const defIds = new Set((loadDefaultYamlSection('tokenbank.routes.default.yaml', 'scene_routes') || []).map(r => r.id));
      if (defIds.has(id)) {
        cfg.removed_default_routes = Array.isArray(cfg.removed_default_routes) ? cfg.removed_default_routes : [];
        if (!cfg.removed_default_routes.includes(id)) cfg.removed_default_routes.push(id);
      }
    } catch {}
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('localConfig:createKey', (_e, { note }) => {
    const cfg = readLocalConfig();
    const key = {
      id: rndHex(8),
      key: 'sk-local-' + rndHex(16),
      note: note || '',
      model_key: null,
      created_at: new Date().toISOString(),
    };
    cfg.local_keys.push(key);
    writeLocalConfig(cfg);
    return key;
  });

  ipcMain.handle('localConfig:deleteKey', (_e, id) => {
    const cfg = readLocalConfig();
    cfg.local_keys = cfg.local_keys.filter(k => k.id !== id);
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('localConfig:bindKey', (_e, { id, model_key }) => {
    const cfg = readLocalConfig();
    const key = cfg.local_keys.find(k => k.id === id);
    if (!key) return null;
    key.model_key = model_key || null;
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    return key;
  });

  // ── 策略组 CRUD（policies[]，UI 管理，存 local-config）─────────────────────
  // 数据结构：{ id, name, strategy, providers: [{id, weight?}], created_at }
  // strategy 枚举：fallback | round-robin | weighted | latency | direct

  function getPolicies() { return readLocalConfig().policies || []; }
  function savePolicies(policies) {
    const cfg = readLocalConfig();
    cfg.policies = policies;
    writeLocalConfig(cfg);
  }

  ipcMain.handle('policies:list', () => getPolicies());

  ipcMain.handle('policies:create', (_e, { name, strategy, providers }) => {
    const policies = getPolicies();
    const policy = {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),   // name → kebab-case id
      name: name || 'untitled',
      strategy: strategy || 'fallback',
      providers: (providers || []).map(p =>
        typeof p === 'string' ? { id: p, weight: 1 } : p
      ),
      created_at: new Date().toISOString(),
    };
    // id 冲突时加后缀
    const existing = policies.find(p => p.id === policy.id);
    if (existing) policy.id = policy.id + '-' + rndHex(3);
    policies.push(policy);
    savePolicies(policies);
    return policy;
  });

  ipcMain.handle('policies:update', (_e, { id, name, strategy, providers }) => {
    const policies = getPolicies();
    const idx = policies.findIndex(p => p.id === id);
    if (idx === -1) return { ok: false, error: 'not-found' };
    policies[idx] = {
      ...policies[idx],
      ...(name      !== undefined && { name }),
      ...(strategy  !== undefined && { strategy }),
      ...(providers !== undefined && {
        providers: providers.map(p => typeof p === 'string' ? { id: p, weight: 1 } : p)
      }),
    };
    savePolicies(policies);
    return policies[idx];
  });

  ipcMain.handle('policies:delete', (_e, id) => {
    const policies = getPolicies().filter(p => p.id !== id);
    savePolicies(policies);
    return { ok: true };
  });

  // ── 应用管理 CRUD（apps[]，统一管理托管和API Key应用）────────────────────────
  // 应用结构：{ id, name, icon, link_method(shim|api-key|manual), api_key, route_id,
  //             description, allowed_models[], max_rpm, max_concurrent,
  //             allow_stream, created_at }

  function getApps() {
    const cfg = readLocalConfig();
    return cfg.apps || [];
  }
  // 确保 MCP 网关绑定目标与 Gateway 应用列表同源（含「New app」等 API 应用）
  try {
    require('./mcp-gateway-targets').setAppsGetter(() => getApps());
  } catch { /* ignore */ }
  function saveApps(apps) {
    const cfg = readLocalConfig();
    cfg.apps = apps;
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
  }

  // 扫描 CLI 多账号 CONFIG_DIR，与已存 app 记录对账，把新账号补成实例记录、旧记录迁移出 instance 段。
  // 仅对「用户已纳管过的工具」(该 agent 已有 shim 记录) 自动建新实例，避免给没碰过的工具凭空造记录。
  // 主路径：扫出即完成，默认官方订阅不走网关(route_id:null)，用户可选绑路由。返回 { added, changed }。
  function reconcileCliInstancesIntoApps() {
    try {
      const cli = require('./cli-instances');
      const apps = getApps();
      const scanned = [...cli.scanCliInstances('claude-code'), ...cli.scanCliInstances('codex')];
      if (!scanned.length) return { added: 0, changed: false };
      const activeTools = new Set(apps.filter(a => a.link_method === 'shim' && a.agent_id).map(a => a.agent_id));
      const usedNames = new Set(apps.map(a => a.name).filter(Boolean));   // 全局唯一保护
      const makeRecord = (inst) => {
        if (!activeTools.has(inst.tool)) return null;   // 该工具未纳管 → 不自动建，交给正常检测/纳管
        // 名字：前缀带 CLI（区分 Desktop）+ 标签（默认账号=默认，否则邮箱前缀/目录后缀）；全局唯一，冲突加序号
        const prefix = inst.tool === 'codex' ? 'Codex CLI' : 'Claude Code CLI';
        const email = inst.account_email || '';
        const suffix = path.basename(inst.config_dir).replace(/^\.(claude|codex)-?/, '');
        const label = inst.is_default ? '默认' : (email ? email.split('@')[0] : (suffix || 'account'));
        let name = `${prefix} · ${label}`;
        for (let n = 2; usedNames.has(name); n++) name = `${prefix} · ${label} (${n})`;
        usedNames.add(name);
        return {
          id: `app-shim-${inst.tool}-${rndHex(6)}`,
          name,
          icon: 'icon:cube',
          link_method: 'shim',
          agent_id: inst.tool,
          api_key: 'sk-local-' + rndHex(16),
          route_id: null,          // 默认官方订阅不走网关
          hosted: true,
          instance: {
            config_dir: inst.config_dir, is_default: inst.is_default,
            account_email: inst.account_email, subscription: inst.subscription,
            has_credentials: inst.has_credentials, invalid: false, dir_glob: null,
          },
          created_at: new Date().toISOString(),
        };
      };
      const { apps: out, added } = cli.reconcileCliInstances(apps, scanned, makeRecord);
      const changed = JSON.stringify(apps) !== JSON.stringify(out);
      if (changed) saveApps(out);
      return { added: added.length, changed };
    } catch (e) {
      console.warn('[cli-instances] reconcile error:', e && e.message);
      return { added: 0, changed: false, error: e && e.message };
    }
  }
  // 应用「纳管」状态完全跟随用户操作（持久化在条目里，不靠扫描/匹配配置文件内容）
  function syncCursorHookState(apps) {
    try {
      const appsList = apps || getApps();
      cursorHooks.syncForApps(appsList, process.execPath);
      const cursor = appsList.find(a => a.link_method === 'direct' && a.agent_id === 'cursor');
      // hook 纳管后：清掉 transcript 0 token 脏数据并立即导入已有 hook 事件
      if (cursor?.hosted && cursorHooks.isInstalled()) {
        cursorHooks.purgeTranscriptZeroTokens(localStats);
        const n = cursorHooks.importEvents(localStats);
        if (n > 0) { try { mainWindow?.webContents?.send('apps:changed'); } catch {} }
      }
    } catch (e) {
      console.error('[cursor-hooks] sync failed:', e.message);
    }
  }
  function setAppHosted(appId, hosted) {
    if (!appId) return;
    const apps = getApps();
    const idx = apps.findIndex(a => a.id === appId);
    if (idx === -1) return;
    apps[idx] = { ...apps[idx], hosted: !!hosted };
    saveApps(apps);
    if (apps[idx].agent_id === 'cursor' && apps[idx].link_method === 'direct') {
      syncCursorHookState(apps);
    }
  }

  // 「支持的应用」总览：列出我们支持纳管的全部应用 + 本机是否已安装 + 未装时的官方安装链接。
  // 数据驱动：CLI 工具(tools) / 桌面应用(api_key_apps) / 仅统计(direct_only 会话源) 三类清单并集，
  // 各自复用既有检测逻辑判定 installed；install_url 集中维护官方下载页（无把握的留 null → 前端灰显不可点）。
  ipcMain.handle('apps:supported', () => {
    const configLoader = require('./config-loader');
    const entityMeta = (id) => {
      try { return configLoader.appEntityById(id); } catch { return null; }
    };
    const INSTALL_URLS = configLoader.appInstallUrls();
    const UNINSTALL_URLS = configLoader.appUninstallUrls();
    const INSTALL_GUIDES = configLoader.appInstallGuides();
    const UNINSTALL_GUIDES = configLoader.appUninstallGuides();
    const NPM_PACKAGES = configLoader.appNpmPackages();
    const guide = (map, id) => configLoader.resolveGuide(map[id]);
    // 按 id 合并三分支（CLI / 桌面 / 会话）：同一应用可同时出现在多条分支，
    // 不再"先到先得"丢弃后来的证据 —— 按 id 合并三分支、元数据补空，
    // npm_package 统一按 id 查（任何分支的应用都可能是 npm 命令行装的），有包即可命令行装卸。
    // installed 分强/弱信号聚合：强信号=命令/appx/app 现在确实装着；弱信号=残留配置/会话目录。
    // 有强信号只认强信号（卸载后立即变灰）；无强信号才用弱信号兜底（如纯会话源 WorkBuddy/cursor）。
    const byId = new Map();
    const KIND_RANK = { cli: 3, desktop: 2, session: 1, direct: 1 };
    const merge = (o) => {
      if (!o || !o.id) return;
      if (!o.npm_package) o.npm_package = NPM_PACKAGES[o.id] || null;
      const ex = byId.get(o.id);
      if (!ex) { byId.set(o.id, o); return; }
      ex.sStrongDefined = ex.sStrongDefined || o.sStrongDefined;
      ex.sStrong = ex.sStrong || o.sStrong;
      ex.sWeak = ex.sWeak || o.sWeak;
      for (const k of ['name', 'icon', 'capabilities', 'install_url', 'uninstall_url',
                       'install_guide', 'uninstall_guide', 'npm_package']) {
        if ((ex[k] == null || ex[k] === '') && o[k] != null) ex[k] = o[k];
      }
      if ((KIND_RANK[o.kind] || 0) > (KIND_RANK[ex.kind] || 0)) ex.kind = o.kind;
    };
    try {
      // ① CLI 工具（shim 托管，命令在 PATH）：命令检测=强信号
      for (const tool of agentLinker.list()) {
        const ent = entityMeta(tool.id);
        merge({ id: tool.id, name: ent?.name || tool.name || tool.id, icon: ent?.icon || '🤖',
              capabilities: ent?.capabilities || tool.capabilities || null,
              sStrongDefined: true, sStrong: !!tool.installed, sWeak: false,
              install_url: INSTALL_URLS[tool.id] || null,
              uninstall_url: UNINSTALL_URLS[tool.id] || null,
              install_guide: guide(INSTALL_GUIDES, tool.id),
              uninstall_guide: guide(UNINSTALL_GUIDES, tool.id),
              npm_package: NPM_PACKAGES[tool.id] || null,
              kind: 'cli' });
      }
      // ② 桌面应用（写配置文件）：被管理员禁用(enable_3p:false)的不展示
      for (const d of (configLoader.apiKeyApps() || [])) {
        if (d.enable_3p === false) continue;
        const ent = entityMeta(d.id);
        const det = apiKeyDetect(d);
        merge({ id: d.id, name: ent?.name || d.name || d.id, icon: ent?.icon || d.icon || '🖥️',
              capabilities: ent?.capabilities || d.capabilities || null,
              sStrongDefined: det.strongDefined, sStrong: det.strong, sWeak: det.weak,
              install_url: INSTALL_URLS[d.id] || null,
              uninstall_url: UNINSTALL_URLS[d.id] || null,
              install_guide: guide(INSTALL_GUIDES, d.id),
              uninstall_guide: guide(UNINSTALL_GUIDES, d.id),
              npm_package: NPM_PACKAGES[d.id] || null,
              kind: 'desktop' });
      }
      // ③ 会话统计源：direct_only 与可绑路由两类，目录存在=弱信号（残留数据，不足证明已安装）
      for (const s of (configLoader.sessionSources() || [])) {
        if (!s || !s.agent_id) continue;
        let weak = false;
        try { weak = !!s.root && fs.existsSync(configLoader.expandHome(s.root)); } catch {}
        merge({ id: s.agent_id, name: s.app_name || entityMeta(s.agent_id)?.name || s.agent_id,
              icon: s.app_icon || entityMeta(s.agent_id)?.icon || '🖱',
              capabilities: entityMeta(s.agent_id)?.capabilities || null,
              sStrongDefined: false, sStrong: false, sWeak: weak,
              install_url: INSTALL_URLS[s.agent_id] || null,
              uninstall_url: UNINSTALL_URLS[s.agent_id] || null,
              install_guide: guide(INSTALL_GUIDES, s.agent_id),
              uninstall_guide: guide(UNINSTALL_GUIDES, s.agent_id),
              npm_package: NPM_PACKAGES[s.agent_id] || null,
              kind: s.direct_only ? 'direct' : 'session' });
      }
    } catch (e) { console.error('[apps:supported] failed:', e.message); }
    const out = [...byId.values()].map(r => {
      // 有强信号只认强信号（命令/appx 卸载即变灰）；否则用弱信号（残留目录）兜底
      r.installed = r.sStrongDefined ? r.sStrong : r.sWeak;
      delete r.sStrongDefined; delete r.sStrong; delete r.sWeak;
      return r;
    });
    // 已安装靠前（彩色在左），其次有安装链接的，最后无链接的小众工具
    out.sort((a, b) => (Number(b.installed) - Number(a.installed)) || ((b.install_url ? 1 : 0) - (a.install_url ? 1 : 0)));
    return out;
  });

  // 稳健解析 npm 可执行文件：GUI 启动的 electron 主进程 PATH 有时不含 Node 目录，
  // 裸 'npm.cmd' 会找不到导致一键安装静默失败 → 先 resolveRealCommand，再探常见安装位置，最后回退裸命令。
  const resolveNpmCmd = () => {
    const isWin = process.platform === 'win32';
    try {
      const p = require('./shim-installer').resolveRealCommand(isWin ? 'npm.cmd' : 'npm');
      if (p && fs.existsSync(p)) return p;
    } catch {}
    const cands = isWin
      ? ['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files (x86)\\nodejs\\npm.cmd',
         path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'npm.cmd')]
      : ['/usr/local/bin/npm', '/opt/homebrew/bin/npm', '/usr/bin/npm'];
    for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
    return isWin ? 'npm.cmd' : 'npm';
  };

  // npm 全局包安装根目录（<prefix>/lib/node_modules）。
  const npmGlobalRoot = (npmCmd) => new Promise((resolve) => {
    try {
      require('child_process').exec(`${npmCmd} root -g`, { timeout: 20000, windowsHide: true },
        (err, stdout) => resolve(err ? null : (String(stdout || '').trim() || null)));
    } catch { resolve(null); }
  });

  // 清理 npm 原子装/卸中断留下的暂存目录：包目录的兄弟项 .<最后一段>-<hash>（scoped 与裸名都适用）。
  // 这类残留会让下次 `npm uninstall -g` 的 rename 撞上 ENOTEMPTY。返回包目录路径供兜底删。
  const sweepNpmStaging = (root, pkg) => {
    try {
      if (!root || !pkg) return null;
      const pkgDir = path.join(root, pkg);
      const parent = path.dirname(pkgDir);
      const base = path.basename(pkgDir);
      if (fs.existsSync(parent)) {
        for (const f of fs.readdirSync(parent)) {
          if (f.startsWith('.' + base + '-')) {
            try { fs.rmSync(path.join(parent, f), { recursive: true, force: true }); } catch {}
          }
        }
      }
      return pkgDir;
    } catch { return null; }
  };

  // 一键安装/更新 CLI 工具：跑 npm i -g <包>@latest（用户级全局，无需管理员）。
  // 异步 exec，不阻塞主进程；装完前端刷新检测状态。
  ipcMain.handle('apps:npmGlobalInstall', async (_e, { id } = {}) => {
    const pkg = (require('./config-loader').appNpmPackages() || {})[id];
    if (!pkg) return { ok: false, error: 'no-npm-package' };
    const npmCmd = `"${resolveNpmCmd()}"`;
    return await new Promise((resolve) => {
      try {
        require('child_process').exec(`${npmCmd} i -g ${pkg}@latest`, { timeout: 300000, windowsHide: true },
          (err, _stdout, stderr) => {
            if (err) resolve({ ok: false, error: (String(stderr || '') || err.message).slice(0, 400) });
            else {
              // 清命令探测缓存，使前端刷新时立即检测到刚装的工具（不等 30s TTL）
              try { require('./shim-installer').clearCommandCache(); } catch {}
              // 通知前端应用列表刷新（新装的工具即时出现在应用列表虚拟条目）
              try { mainWindow?.webContents?.send('apps:changed'); } catch {}
              resolve({ ok: true, pkg });
            }
          });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });

  // 一键卸载 CLI 工具：跑 npm uninstall -g <包>。与安装对称，装完/卸完都清命令缓存。
  // 加固：npm 用「原子重命名到 .<name>-<hash> 暂存目录再删」的方式卸载，上次装/卸中断留下的暂存
  // 目录会让本次 rename 撞上 ENOTEMPTY。故先清残留暂存；npm 仍失败(ENOTEMPTY/EEXIST)时兜底直接
  // 删包目录 + npm bin 软链(目标本就是移除)。对所有 npm CLI(claude-code/codex/opencode/openclaw)统一生效。
  ipcMain.handle('apps:npmGlobalUninstall', async (_e, { id } = {}) => {
    const pkg = (require('./config-loader').appNpmPackages() || {})[id];
    if (!pkg) return { ok: false, error: 'no-npm-package' };
    const npmBin = resolveNpmCmd();
    const npmCmd = `"${npmBin}"`;
    const root = await npmGlobalRoot(npmCmd);
    sweepNpmStaging(root, pkg);   // 卸载前先清残留暂存目录，避免 rename ENOTEMPTY

    const toolCmd = (() => {
      try {
        const tool = (require('./config-loader').tools() || []).find(t => t.id === id);
        return tool && tool.detect && tool.detect.command;
      } catch { return null; }
    })();
    const afterRemoved = () => {
      // 顺带清掉 Token Bank 托管的 shim（命令名取自 detect.command，如 claude/codex/opencode）；
      // api_key 应用无 shim，跳过。再清命令探测缓存 + 通知前端刷新。
      try { if (toolCmd) require('./shim-installer').removeShim(toolCmd); } catch {}
      try { require('./shim-installer').clearCommandCache(); } catch {}
      try { mainWindow?.webContents?.send('apps:changed'); } catch {}
    };

    // 卸载后校验：命令若仍能解析，说明它装在 npm 配置 prefix 够不到的位置——常见于用户设了
    // prefix=~/.npm-global，但历史用 sudo 把 CLI 装进了默认的 /usr/local（root 所有）。`npm -g`
    // 只动配置 prefix → 卸载成了 no-op。此时别假装成功（否则界面「点了没反应、也没卸载」），
    // 回报真实路径 + 手动删除提示。
    const lingeringCmdPath = () => {
      try {
        if (!toolCmd) return null;
        require('./shim-installer').clearCommandCache(toolCmd);
        return require('./shim-installer').resolveRealCommand(toolCmd) || null;
      } catch { return null; }
    };
    const finish = (resolve, base) => {
      afterRemoved();
      const left = lingeringCmdPath();
      if (left) {
        return resolve({ ok: false, pkg, lingeringPath: left, error:
          `已执行 npm 全局卸载，但命令 ${toolCmd} 仍存在于 ${left}——它装在 npm 配置 prefix 之外` +
          `（可能是另一个 prefix 或 root/系统安装，如 /usr/local）。需手动删除：sudo rm -rf ${left}` });
      }
      resolve({ ok: true, pkg, ...(base || {}) });
    };

    return await new Promise((resolve) => {
      try {
        require('child_process').exec(`${npmCmd} uninstall -g ${pkg}`, { timeout: 300000, windowsHide: true },
          (err, _stdout, stderr) => {
            const errText = String(stderr || '') || (err && err.message) || '';
            if (err && /ENOTEMPTY|EEXIST|ENOENT/i.test(errText)) {
              // 兜底：残留/树损坏导致 npm rename/unlink 失败(ENOTEMPTY/EEXIST/ENOENT) → 再清一次暂存
              //       + 直接删包目录 + npm bin 软链（目标本就是移除，直接删最可靠）
              const pkgDir = sweepNpmStaging(root, pkg) || (root ? path.join(root, pkg) : null);
              try { if (pkgDir) fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
              // 删 npm 生成的 bin 入口(不存在则静默跳过)。布局按平台不同:
              //  unix: root=<prefix>/lib/node_modules → bin 在 <prefix>/bin/<cmd>(软链)
              //  win : root=<prefix>\node_modules      → shim 在 <prefix>\<cmd>.cmd/.ps1(及无扩展)
              try {
                if (root && toolCmd) {
                  const isWin = process.platform === 'win32';
                  const files = isWin
                    ? [toolCmd + '.cmd', toolCmd + '.ps1', toolCmd].map(f => path.join(path.resolve(root, '..'), f))
                    : [path.join(path.resolve(root, '..', '..'), 'bin', toolCmd)];
                  for (const f of files) { try { fs.rmSync(f, { force: true }); } catch {} }
                }
              } catch {}
              return finish(resolve, { note: 'removed-after-cleanup' });
            }
            if (err) return resolve({ ok: false, error: errText.slice(0, 400) });
            finish(resolve);
          });
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });
  });

  ipcMain.handle('apps:list', () => {
    const configLoader = require('./config-loader');
    const INSTALL_GUIDES = configLoader.appInstallGuides();
    const INSTALL_URLS = configLoader.appInstallUrls();
    const guideFor = (id) => (id ? configLoader.resolveGuide(INSTALL_GUIDES[id]) : null);
    const entityMeta = (id) => {
      try { return configLoader.appEntityById(id); } catch { return null; }
    };
    const sessionSrcOf = (agentId) => (configLoader.sessionSources() || []).find(s => s.agent_id === agentId);
    const toolIds = new Set((configLoader.tools() || []).map(t => t.id));
    const apiKeyIds = new Set((configLoader.apiKeyApps() || []).map(a => a.id));

    /** 是否允许绑路由：api-key/shim/manual 须 gateway_proxy；session 须会话能力 */
    const resolveRouteBindable = (app, fallback = true) => {
      const aid = app.agent_id || app.preset_id;
      if (!aid) return fallback !== false;

      const ent = entityMeta(aid);
      const caps = configLoader.appCapabilities(aid);
      const gwProxy = caps ? !!caps.gateway_proxy : !!ent?.gateway_proxy;

      if (app.link_method === 'shim' || app.link_method === 'api-key' || app.link_method === 'manual') {
        return gwProxy;
      }
      if (app.link_method === 'session') {
        const sessCaps = caps || ent?.capabilities || {};
        return !!(sessCaps.session_trace || sessCaps.session_usage_import) && (ent?.route_bindable !== false);
      }

      if (app.link_method === 'shim') return gwProxy && toolIds.has(aid);
      if (app.link_method === 'api-key' || app.preset_id) return gwProxy && apiKeyIds.has(app.preset_id || aid);
      if (app.link_method === 'session') {
        const src = sessionSrcOf(aid);
        return !!(src && !src.direct_only);
      }
      return fallback !== false;
    };

    // 按云端实体能力同步本地持久化应用：取消路由能力时清空 route_id
    try {
      const cur = getApps();
      let mutated = false;
      for (const app of cur) {
        const bindable = resolveRouteBindable(app, app.route_bindable);
        if (app.route_bindable !== bindable) { app.route_bindable = bindable; mutated = true; }
        if (!bindable && (app.route_id || (app.route_ids && app.route_ids.length))) {
          app.route_id = null;
          app.route_ids = null;
          mutated = true;
          if (app.link_method === 'shim' && app.agent_id) {
            try { agentLinker.revertById(app.agent_id); } catch {}
            // Claude Code：路由能力被取消 → 还原该实例 settings.json
            try { syncCliInstanceEndpointConfig(app); } catch {}
          }
          // 取消网关能力时还原 config-file 应用（如 Claude Desktop）
          if ((app.link_method === 'api-key' || app.host_method === 'config-file') && app.config_file && app.hosted) {
            try { revertAppConfigFile(app.id, app.config_file); } catch {}
          }
        }
      }
      if (mutated) {
        saveApps(cur);
        try { syncGatewayFromConfig(readLocalConfig()); } catch {}
      }
    } catch (e) { console.warn('[apps:list] sync route_bindable:', e.message); }

    // 检测到的 api-key 应用 → 自动建立「离线」持久条目（生成 key、不写配置文件），
    // 使其与透明托管(shim)一致：始终是真实条目、有完整的下拉/编辑/测试控件，
    // 「纳管」只是再写一次配置文件。去重以「目标配置文件」为准（同一文件不重复建）。
    try {
      const { canonicalAppEntityId } = require('./app-handlers');
      const cur = getApps();
      const norm = (p) => { try { return path.resolve(resolveCfgPath(p)).toLowerCase(); } catch { return String(p || '').toLowerCase(); } };
      const savedPresets  = new Set(cur.filter(a => a.preset_id).map(a => canonicalAppEntityId(a.preset_id)));
      const managedFiles  = new Set(cur.filter(a => a.config_file).map(a => norm(a.config_file)));
      let mutated = false;
      for (const d of getApiKeyApps()) {
        const cid = canonicalAppEntityId(d.id);
        if (savedPresets.has(cid)) continue;
        if (!apiKeyAppDetected(d)) continue;
        const nf = norm(resolveCfgPath(d.config_file));
        if (managedFiles.has(nf)) continue;
        cur.push({
          id: 'app-apikey-' + cid,
          name: cid === 'codex' ? 'Codex' : d.name, icon: d.icon, link_method: 'api-key', agent_id: null,
          api_key: 'sk-local-' + rndHex(16), route_id: null,
          description: '', allowed_models: [], max_rpm: null, max_concurrent: null, allow_stream: true,
          env: d.env || null, preset_id: cid, inject: 'config-file',
          config_file: d.config_file || null, patch: d.patch || null,
          hosted: true,    // 默认纳管+直连：只读会话日志统计，不写配置/不走网关（绑路由才走网关）
          created_at: new Date().toISOString(),
        });
        savedPresets.add(cid); managedFiles.add(nf); mutated = true;
      }
      if (mutated) { saveApps(cur); try { syncGatewayFromConfig(readLocalConfig()); } catch {} }
    } catch (e) { console.error('[apps:list] materialize api-key failed:', e.message); }

    // direct_only 会话源 → 仅当本机会话数据目录存在时才创建并展示（未安装不显示）。
    // 非 direct_only 的会话源 → 可绑路由（link_method: session），仍只读 trace 不走网关代理。
    const directInstalled = (agentId) => {
      const src = sessionSrcOf(agentId);
      if (!src?.root) return false;
      try {
        const root = configLoader.resolvePlaceholders
          ? configLoader.resolvePlaceholders(String(src.root))
          : configLoader.expandHome(src.root);
        return fs.existsSync(root);
      } catch { return false; }
    };
    try {
      const cur = getApps();
      let mutated = false;
      // 按最新 session_sources 同步已持久化条目（云端改 direct_only 后本地须跟着变）
      for (let i = 0; i < cur.length; i++) {
        const app = cur[i];
        if (!app.agent_id || (app.link_method !== 'direct' && app.link_method !== 'session')) continue;
        const src = sessionSrcOf(app.agent_id);
        if (!src) continue;
        const wantDirect = !!src.direct_only;
        if (wantDirect && app.link_method !== 'direct') {
          app.link_method = 'direct';
          app.route_bindable = false;
          app.direct_only = true;
          app.route_id = null;
          mutated = true;
        } else if (!wantDirect && app.link_method === 'direct') {
          app.link_method = 'session';
          app.route_bindable = resolveRouteBindable(app, true);
          app.direct_only = false;
          mutated = true;
        }
        if (src.app_name && app.name !== src.app_name) { app.name = src.app_name; mutated = true; }
        if (src.app_icon && app.icon !== src.app_icon) { app.icon = src.app_icon; mutated = true; }
      }
      const haveAgent = new Set(cur.filter(a => a.agent_id && (a.link_method === 'direct' || a.link_method === 'session')).map(a => a.agent_id));
      // 已有 shim / api-key 的 agent_id 不再为附属 session 单独建条目
      const proxyAgentIds = new Set([
        ...cur.filter(a => a.link_method === 'shim' || a.link_method === 'api-key').map(a => a.agent_id || a.preset_id),
        ...((configLoader.tools() || []).map(t => t.id)),
        ...((configLoader.apiKeyApps() || []).map(a => a.id)),
      ]);
      for (const s of (configLoader.sessionSources() || [])) {
        if (!s || !s.agent_id) continue;
        // standalone=false：附属统计，挂到已有 CLI/API 实体，不单独占百宝箱一行
        if (s.standalone === false) continue;
        if (proxyAgentIds.has(s.agent_id)) continue;
        if (haveAgent.has(s.agent_id)) continue;
        if (!directInstalled(s.agent_id)) continue;
        if (s.direct_only) {
          cur.push({
            id: 'app-direct-' + s.agent_id,
            name: s.app_name || s.agent_id, icon: s.app_icon || '🖱',
            link_method: 'direct', agent_id: s.agent_id,
            api_key: 'sk-local-' + rndHex(16), route_id: null,
            route_bindable: false, direct_only: true,
            hosted: true,
            created_at: new Date().toISOString(),
          });
        } else {
          cur.push({
            id: 'app-session-' + s.agent_id,
            name: s.app_name || s.agent_id, icon: s.app_icon || '🖱',
            link_method: 'session', agent_id: s.agent_id,
            api_key: 'sk-local-' + rndHex(16), route_id: null,
            route_bindable: resolveRouteBindable({ agent_id: s.agent_id, link_method: 'session' }, true),
            direct_only: false,
            hosted: true,
            created_at: new Date().toISOString(),
          });
        }
        haveAgent.add(s.agent_id);
        mutated = true;
      }
      if (mutated) saveApps(cur);
    } catch (e) { console.error('[apps:list] materialize session failed:', e.message); }

    // Trae Work：手工配置模型，统一为 session（可绑路由选参考模型，不写 state.vscdb）
    try {
      const { isTraeWorkEntity } = require('./app-handlers');
      const cur = getApps();
      let migrated = false;
      for (const app of cur) {
        const traeLike = isTraeWorkEntity(app.preset_id) || isTraeWorkEntity(app.agent_id)
          || String(app.id || '').toLowerCase().includes('trae');
        if (!traeLike) continue;
        app.agent_id = 'trae-work';
        app.preset_id = 'trae-work';
        if (app.link_method === 'direct' || app.link_method === 'api-key') {
          app.link_method = 'session';
          app.direct_only = false;
          app.route_bindable = true;
          app.host_method = 'session';
          delete app.config_file;
          delete app.patch;
          delete app.inject;
          migrated = true;
        }
        if (!app.api_key) { app.api_key = 'sk-local-' + rndHex(16); migrated = true; }
      }
      if (migrated) saveApps(cur);
    } catch (e) { console.error('[apps:list] migrate trae-work failed:', e.message); }

    // Codex：CLI(shim) 与 Desktop(api-key) 合并为单一应用（写 ~/.codex/config.toml）
    try {
      const { canonicalAppEntityId } = require('./app-handlers');
      const cur = getApps();
      const groups = new Map(); // canonical -> apps[]
      for (const app of cur) {
        const aid = canonicalAppEntityId(app.agent_id || app.preset_id);
        if (aid !== 'codex') continue;
        if (!groups.has(aid)) groups.set(aid, []);
        groups.get(aid).push(app);
      }
      if (groups.has('codex')) {
        const list = groups.get('codex');
        const PRI = { 'api-key': 3, manual: 3, shim: 2, session: 1, direct: 1 };
        let best = null;
        for (const a of list) {
          if (!best || (PRI[a.link_method] || 0) > (PRI[best.link_method] || 0)) best = a;
        }
        // 优先保留 api-key；其余从持久化列表移除（展示层也会再去重）
        const dropIds = new Set(list.filter(a => a !== best).map(a => a.id));
        let mutated = false;
        if (best) {
          if (best.preset_id === 'codex-desktop' || best.agent_id === 'codex') {
            if (best.link_method === 'api-key' || best.config_file) {
              if (best.preset_id !== 'codex') { best.preset_id = 'codex'; mutated = true; }
              if (best.agent_id) { best.agent_id = null; mutated = true; }
            } else if (best.link_method === 'shim') {
              // 仅有 shim：若本机有 api-key 预设，下次 materialize 会建 api-key；此处先改名
            }
          }
          if (best.name === 'Codex (CLI)' || best.name === 'Codex Desktop') {
            best.name = 'Codex'; mutated = true;
          }
        }
        if (dropIds.size) {
          const next = cur.filter(a => !dropIds.has(a.id));
          saveApps(next);
          try { syncGatewayFromConfig(readLocalConfig()); } catch {}
        } else if (mutated) {
          saveApps(cur);
          try { syncGatewayFromConfig(readLocalConfig()); } catch {}
        }
      }
    } catch (e) { console.error('[apps:list] migrate codex merge failed:', e.message); }

    // direct / shim / session 应用：补全 API Key（写入配置、网关识别、手工接入）
    try {
      const cur = getApps();
      let keyMutated = false;
      for (const app of cur) {
        if ((app.link_method === 'direct' || app.link_method === 'shim' || app.link_method === 'session') && !app.api_key) {
          app.api_key = 'sk-local-' + rndHex(16);
          keyMutated = true;
        }
      }
      if (keyMutated) {
        saveApps(cur);
        try { syncGatewayFromConfig(readLocalConfig()); } catch {}
      }
    } catch (e) { console.error('[apps:list] backfill api_key failed:', e.message); }

    // 被管理员禁用（enable_3p:false）的 api_key 应用预设 id —— 这些应用整条隐藏
    const disabledPresets = new Set(
      (() => { try { return (require('./config-loader').apiKeyApps() || []).filter(a => a.enable_3p === false).map(a => a.id); } catch { return []; } })()
    );
    const savedApps = getApps().filter(a => !(a.preset_id && disabledPresets.has(a.preset_id)));
    const agentTools = agentLinker.list();

    // 把 yaml tools 里有、但 apps[] 里还没有 shim 记录的 agent，动态补入。
    // 仅未安装则不虚拟展示（与 api-key/session 虚拟条目一致：卸载后即从应用列表消失，
    // 装回自动出现）；已被用户显式纳管的 shim 记录在 savedApps，不受此过滤，始终保留。
    const { canonicalAppEntityId } = require('./app-handlers');
    const shimIds = new Set(savedApps.filter(a => a.link_method === 'shim').map(a => a.agent_id));
    // 已有 api-key（含别名）的应用不再虚拟 shim（Codex CLI 与 Desktop 共用）
    const apiKeyCanonical = new Set([
      ...savedApps.filter(a => a.link_method === 'api-key' && a.preset_id).map(a => canonicalAppEntityId(a.preset_id)),
      ...[...apiKeyIds].map(id => canonicalAppEntityId(id)),
    ]);
    const virtualShimApps = agentTools
      .filter(t => t.installed)
      .filter(t => !shimIds.has(t.id))
      .filter(t => toolIds.has(t.id))
      .filter(t => !apiKeyCanonical.has(canonicalAppEntityId(t.id)))
      .filter(t => {
        const caps = configLoader.appCapabilities(t.id);
        if (caps) return !!caps.gateway_proxy;
        return true;
      })
      .map(t => {
        const ent = entityMeta(t.id);
        return {
        id: 'app-shim-' + t.id,
        name: ent?.name || t.name || t.id,
        icon: ent?.icon || '🤖',
        capabilities: ent?.capabilities || t.capabilities || null,
        link_method: 'shim',
        agent_id: t.id,
        api_key: null,
        route_id: null,
        description: '',
        type: t.type || 'cli',
        needs_ca: !!t.needs_ca,
        route_bindable: ent ? ent.route_bindable !== false : (t.route_bindable !== false),
        unsupported: !!t.unsupported,
        note: t.note || null,
        installed: t.installed,
        linked: t.linked,
        hosted: true,
        _virtual: true,
      }; });

    // 合并：持久化的 app + 虚拟的 shim app
    const allApps = [...savedApps, ...virtualShimApps];

    // shim 工具的自动配置详情（环境变量 / 自动写入文件），占位符已解析
    let toolDetails = [];
    try { toolDetails = require('./config-loader').tools(); } catch {}
    const autoConfigOf = (agentId) => {
      const t = toolDetails.find(x => x.id === agentId);
      if (!t) return null;
      return {
        strategy:    t.strategy || null,
        protocol:    t.protocol || null,
        env:         (t.inject && t.inject.env) || {},          // 注入的环境变量
        config_file: t['config-file'] || null,                  // 自动写入的配置文件
        patch:       t.patch || {},                             // 写入文件的字段
      };
    };

    const entityDerived = (aid) => {
      const ent = entityMeta(aid);
      if (!ent) return {};
      return {
        activity_agent_id: ent.activity_agent_id,
        trace_agent_id: ent.trace_agent_id,
        linked_data_sources: ent.linked_data_sources || [],
        pricing_provider_id: ent.pricing_provider_id,
        integrations: ent.integrations || {},
        handoff_target: !!ent.handoff_target,
        session_import: !!ent.session_import,
        session_usage_import: ent.session_usage_import,
        session_trace: ent.session_trace,
        gateway_proxy: ent.gateway_proxy,
        route_multi_select: !!ent.route_multi_select,
      };
    };

    // 注入实时托管状态 + 自动配置详情
    const rows = allApps
      .map(app => {
        const aid = app.agent_id || app.preset_id;
        const caps = aid ? configLoader.appCapabilities(aid) : null;
        const ent = entityMeta(aid);
        const derived = entityDerived(aid);
        const routeBindable = resolveRouteBindable(app, app.route_bindable);
        const withCaps = {
          ...app,
          ...derived,
          capabilities: caps || ent?.capabilities || app.capabilities || null,
          handler: ent?.handler || app.handler,
          route_bindable: routeBindable,
        };
        // 「仅直连·只统计」应用（cursor 等）：只读会话日志，不绑路由/不走网关。
        if (app.link_method === 'direct') {
          const src = sessionSrcOf(app.agent_id);
          if (src && !src.direct_only) {
            return { ...withCaps, linked: false, installed: true,
                     hosted: app.hosted === true,
                     direct_only: false, route_bindable: routeBindable,
                     link_method: 'session', host_method: 'session' };
          }
          return { ...withCaps, linked: false, installed: true,
                   hosted: app.hosted === true,
                   direct_only: true, route_bindable: false, host_method: 'direct' };
        }
        if (app.link_method === 'session') {
          return { ...withCaps, linked: false, installed: directInstalled(app.agent_id),
                   hosted: app.hosted === true,
                   direct_only: false, route_bindable: routeBindable, host_method: 'session' };
        }
        if (app.link_method === 'shim') {
          const tool = agentTools.find(t => t.id === app.agent_id);
          return {
            ...withCaps,
            linked: tool ? tool.linked : false,
            installed: tool ? tool.installed : false,
            hosted: app.hosted !== false,   // 默认纳管+直连（检测到即统计），仅显式取消纳管(false)才停扫
            type: tool ? tool.type : (app.type || 'cli'),
            note: tool ? tool.note : (app.note || null),
            route_bindable: tool ? (resolveRouteBindable(app, tool.route_bindable)) : routeBindable,
            auto_config: autoConfigOf(app.agent_id),
          };
        }
        // config-file 类 api-key 应用：标记 host_method + 是否已纳管（状态跟随用户操作，
        // 持久化在 app.hosted，不再扫描/匹配配置文件内容）。
        const def = getApiKeyApps().find(d =>
          d.id === app.preset_id
          || (app.preset_id && canonicalAppEntityId(d.id) === canonicalAppEntityId(app.preset_id))
        );
        // 从最新 yaml 预设刷新 patch/env/config_file（让 yaml 改动对已添加应用也生效；
        // config_file 对 Claude Desktop 是动态的，必须用预设解析后的最新路径=激活配置）
        const freshConfigFile = def?.config_file || app.config_file;
        const freshPatch       = def?.patch || app.patch;
        const freshEnv         = def?.env  ?? app.env;
        // config-file 预设即使当前解析不到路径（Claude Desktop 开发者模式未就绪）仍按 config-file 归类，
        // 避免掉进危险的「删除」分支；needs_dev_mode 让 UI 显示「启用开发者模式」引导。
        const isConfigFileApp = !!freshConfigFile || def?.config_file_optional === true;
        const needsDevMode = def?.config_file_optional === true && def?.dev_mode_ready === false;
        // 在线(经网关) = 纳管 且 绑了路由；纳管但直连(无 route_id) = 仅读文件、不走网关
        // installed：以强信号探测为准，避免残留配置把未安装应用标成已纳管
        const detected = def ? apiKeyAppDetected(def) : true;
        // 已纳管 dsh：旧 apiKeyEnv=TOKENBANK_API_KEY 会继承 Codex 的 shell env，用量记到 Codex
        if (app.hosted === true && app.api_key && isDshApp(app.id) && freshConfigFile) {
          try {
            require('./dsh-config').syncDshGatewayKey(resolveCfgPath(freshConfigFile), app.api_key);
          } catch (e) { console.warn('[dsh] sync gateway key failed:', e.message); }
        }
        return { ...withCaps, linked: true, installed: detected,
                 hosted: app.hosted === true,
                 configured: !!(app.hosted && (app.route_id || (app.route_ids && app.route_ids.length))),
                 config_file: freshConfigFile, patch: freshPatch, env: freshEnv,
                 route_bindable: def ? resolveRouteBindable({ ...app, preset_id: app.preset_id }, def.route_bindable) : routeBindable,
                 route_multi_select: !!(def?.route_multi_select ?? ent?.route_multi_select),
                 allow_direct: def ? def.allow_direct !== false : (app.allow_direct !== false),  // 无本地用量源的桌面壳=false
                 host_method: isConfigFileApp ? 'config-file' : 'api-key',
                 needs_dev_mode: needsDevMode };
      })
      // 机器上没有的 shim / direct / session / 预设 api-key 应用不展示
      .filter(app => app.link_method !== 'shim' || app.installed)
      .filter(app => app.link_method !== 'direct' || directInstalled(app.agent_id))
      .filter(app => app.link_method !== 'session' || directInstalled(app.agent_id))
      .filter(app => {
        // 用户手工 API / 虚拟待添加行保留；预设 api-key 须本机真正装过
        if (app.link_method === 'manual' || app._virtual_apikey) return true;
        if (app.link_method !== 'api-key') return true;
        return app.installed !== false;
      });

    // 同一 agent 去重（含别名：codex-desktop→codex）：api-key(持久) > shim > session/direct。
    // 例外——多账号 shim 实例：每个独立 CONFIG_DIR 各占一行（否则两个账号会被折叠成一行）。
    const PRI = { 'api-key': 3, manual: 3, shim: 2, session: 1, direct: 1 };
    const byAgent = new Map();
    const noAgentRows = [];
    for (const app of rows) {
      const aid = canonicalAppEntityId(app.agent_id || app.preset_id);
      if (!aid) { noAgentRows.push(app); continue; }
      if (!byAgent.has(aid)) byAgent.set(aid, []);
      byAgent.get(aid).push(app);
    }
    const dedupedRows = [...noAgentRows];
    for (const [cid, group] of byAgent.entries()) {
      const instanceRows = group.filter(a => a.link_method === 'shim' && a.instance && a.instance.config_dir);
      if (instanceRows.length) {
        // 每个 config_dir 保留一行（防重复扫描），同 agent 的非实例行让位给实例行
        const seenDirs = new Set();
        for (const a of instanceRows) {
          const key = path.resolve(a.instance.config_dir);
          if (!seenDirs.has(key)) { seenDirs.add(key); dedupedRows.push(a); }
        }
        continue;
      }
      // 其余：同 canonical agent 只保留优先级最高的一行
      let best = null;
      for (const a of group) {
        if (!best || (PRI[a.link_method] || 0) > (PRI[best.link_method] || 0)) best = a;
      }
      if (best) {
        // 归一 preset/agent 与展示名，避免 UI 仍显示「Codex Desktop / Codex (CLI)」
        const normalized = { ...best };
        if (cid === 'codex') {
          normalized.name = 'Codex';
          if (normalized.preset_id) normalized.preset_id = 'codex';
          if (normalized.link_method === 'shim') normalized.agent_id = 'codex';
        }
        dedupedRows.push(normalized);
      }
    }

    // 追加：检测到、但还没"添加"过的 API Key 应用（虚拟行，显示「添加」）
    // 去重以「目标配置文件」为准：配置文件才是应用的真实身份（同一文件不可能托管两次）。
    // 例如 Claude Code（含桌面版）与 Claude Desktop 都写 ~/.claude/settings.json。
    const norm = (p) => { try { return path.resolve(resolveCfgPath(p)).toLowerCase(); } catch { return String(p || '').toLowerCase(); } };
    const managedFiles = new Set(savedApps.filter(a => a.config_file).map(a => norm(a.config_file)));
    const linkedApiKey = new Set(savedApps.filter(a => a.preset_id).map(a => canonicalAppEntityId(a.preset_id)));
    // 已在 dedupedRows 出现的 canonical id（含 shim 行）也不再追加虚拟 api-key
    for (const a of dedupedRows) {
      const cid = canonicalAppEntityId(a.agent_id || a.preset_id);
      if (cid) linkedApiKey.add(cid);
    }
    for (const d of getApiKeyApps()) {
      if (!apiKeyAppDetected(d)) continue;
      const cid = canonicalAppEntityId(d.id);
      const file = resolveCfgPath(d.config_file);
      if (linkedApiKey.has(cid) || managedFiles.has(norm(file))) continue;
      dedupedRows.push({
        id: 'app-apikey-' + cid,
        name: cid === 'codex' ? 'Codex' : d.name, icon: d.icon,
        link_method: 'api-key', host_method: 'config-file',
        needs_dev_mode: d.config_file_optional === true && !file,
        _virtual_apikey: true,
        preset_id: cid,
        ...entityDerived(cid),
        route_bindable: resolveRouteBindable({ preset_id: cid, link_method: 'api-key' }, d.route_bindable),
        route_multi_select: !!entityDerived(cid).route_multi_select,
        config_file: file, patch: d.patch, env: d.env || null,
        configured: false,
        installed: true, linked: false, api_key: null, route_id: null,
      });
      linkedApiKey.add(cid);
    }
    return dedupedRows.map(app => {
      const aid = app.agent_id || app.preset_id;
      return {
        ...app,
        install_guide: guideFor(aid) || app.install_guide || null,
        install_url: INSTALL_URLS[aid] || app.install_url || null,
      };
    });
  });

  ipcMain.handle('apps:create', (_e, data) => {
    const apps = getApps();
    const app = {
      id: 'app-' + rndHex(8),
      name: data.name || '未命名应用',
      icon: data.icon || '🔧',
      link_method: data.link_method || 'api-key',
      agent_id: data.agent_id || null,           // shim 类专用，对应 tool id
      api_key: (data.link_method === 'api-key' || data.link_method === 'manual')
        ? ('sk-local-' + rndHex(16)) : null,
      route_id: data.route_id || null,
      description: data.description || '',
      allowed_models: data.allowed_models || [],
      max_rpm: data.max_rpm || null,
      max_concurrent: data.max_concurrent || null,
      allow_stream: data.allow_stream !== false,
      env: data.env || null,                     // 需写入工具的环境变量模板（{BASE}/{KEY} 占位）
      preset_id: data.preset_id || null,         // 来自哪个预设
      inject: data.inject || (data.env ? 'env' : null),  // env | config-file
      config_file: data.config_file || null,     // config-file 注入：目标配置文件
      patch: data.patch || null,                 // config-file 注入：写入的字段（{BASE}/{KEY} 占位）
      draft: data.draft === true,                // 草稿：新建面板未保存前的临时条目，列表不显示，保存时清除
      created_at: new Date().toISOString(),
    };
    apps.push(app);
    saveApps(apps);
    return app;
  });

  ipcMain.handle('apps:update', (_e, { id, ...patch }) => {
    const apps = getApps();
    const idx = apps.findIndex(a => a.id === id);
    if (idx === -1) return { ok: false, error: 'not-found' };
    // 不允许外部覆盖 api_key（通过 apps:regenKey 单独操作）
    const { api_key: _drop, ...safePatch } = patch;
    apps[idx] = { ...apps[idx], ...safePatch };
    saveApps(apps);
    try { syncGatewayFromConfig(readLocalConfig()); } catch {}
    const updated = apps[idx];
    if (updated.agent_id === 'cursor' && updated.link_method === 'direct' && Object.prototype.hasOwnProperty.call(patch, 'hosted')) {
      syncCursorHookState(apps);
    }
    // 路由相关字段变化 → 直接触发 Claude Desktop ↔ 3p 会话同步（不依赖前端主动调 claude3p:sync）。
    // runClaude3pSync 增量去重、无变化近乎零成本，多调无害。
    if (['route_id', 'route_ids', 'hosted'].some(k => Object.prototype.hasOwnProperty.call(patch, k))) {
      try { runClaude3pSync('apps-update'); } catch (e) { console.warn('[3p-sync] apps:update trigger error:', e && e.message); }
    }
    // 实例 dir_glob 变化 → 该 shim 若已托管，重生成 shim 以更新目录分发（不改变托管状态）
    if (Object.prototype.hasOwnProperty.call(patch, 'instance') && updated.link_method === 'shim' && updated.agent_id) {
      try {
        const tool = require('./config-loader').tools().find(t => t.id === updated.agent_id);
        const cmd = (tool && tool.detect && tool.detect.command) || updated.agent_id;
        if (require('./shim-installer').shimExists(cmd)) agentLinker.applyById(updated.agent_id);
      } catch (e) { console.warn('[cli-instances] shim re-apply error:', e && e.message); }
    }
    // Claude Code 实例：选路由/直连切换 → 改写 or 还原 settings.json（占住 env，防其他代理覆盖）
    if (updated.link_method === 'shim'
      && ['route_id', 'route_ids', 'hosted', 'instance'].some(k => Object.prototype.hasOwnProperty.call(patch, k))) {
      try { syncCliInstanceEndpointConfig(updated); } catch (e) { console.warn('[cli-instance] endpoint sync (update):', e && e.message); }
    }
    return updated;
  });

  ipcMain.handle('apps:delete', (_e, id) => {
    const apps = getApps();
    const doomed = apps.find(a => a.id === id);
    const remaining = apps.filter(a => a.id !== id);
    saveApps(remaining);
    try { syncGatewayFromConfig(readLocalConfig()); } catch {}
    // 删除应用后同步解除 MCP 写盘投射、中转、资源投射，避免 MCP 页仍显示已删的「New app」
    const leftoverIds = [id];
    const agentId = doomed?.agent_id || doomed?.preset_id;
    if (agentId && !remaining.some(a => a.agent_id === agentId || a.preset_id === agentId)) {
      leftoverIds.push(agentId);
    }
    for (const cid of leftoverIds) {
      try { require('./mcp-manager').unbindClient(cid); } catch (e) {
        console.warn('[apps:delete] mcp unbind:', e.message);
      }
      try { require('./resource-manager').unprojectAllForClient(cid); } catch (e) {
        console.warn('[apps:delete] resource unproject:', e.message);
      }
    }
    return { ok: true };
  });

  ipcMain.handle('apps:regenKey', (_e, id) => {
    const apps = getApps();
    const idx = apps.findIndex(a => a.id === id);
    const lm = idx >= 0 ? apps[idx].link_method : null;
    const regenOk = lm === 'api-key' || lm === 'manual' || lm === 'direct' || lm === 'shim' || lm === 'session';
    if (idx === -1 || !regenOk) return { ok: false };
    apps[idx].api_key = 'sk-local-' + rndHex(16);
    saveApps(apps);
    try { syncGatewayFromConfig(readLocalConfig()); } catch {}
    // shim 已接入时须重写脚本，否则 env 里仍是旧 Key
    const app = apps[idx];
    if (app.link_method === 'shim' && app.agent_id) {
      try {
        const tools = require('./config-loader').tools() || [];
        const tool = tools.find(t => t.id === app.agent_id);
        if (tool && agentLinker.status(tool)) agentLinker.apply(tool);
      } catch (e) { console.warn('[apps:regenKey] shim re-apply:', e.message); }
    }
    return { ok: true, api_key: app.api_key };
  });

  // 写入环境变量到系统（让目标工具下次启动时指向网关）。
  // Windows: setx 持久化用户环境变量；macOS/Linux: 写入 shell rc 的托管块。
  ipcMain.handle('apps:writeEnv', async (_e, env) => {
    if (!env || typeof env !== 'object') return { ok: false, error: 'no-env' };
    const entries = Object.entries(env).filter(([k]) => k && k.trim());
    if (!entries.length) return { ok: false, error: 'empty' };
    try {
      if (process.platform === 'win32') {
        const { execFileSync } = require('child_process');
        for (const [k, v] of entries) {
          execFileSync('setx', [k, String(v)], { stdio: ['ignore', 'ignore', 'ignore'] });
        }
      } else {
        const home = os.homedir();
        const candidates = ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map(f => path.join(home, f));
        const targets = candidates.filter(f => fs.existsSync(f));
        if (!targets.length) targets.push(path.join(home, '.profile'));
        const block = '\n# >>> tokenbank env >>>\n'
          + entries.map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`).join('\n')
          + '\n# <<< tokenbank env <<<\n';
        for (const f of targets) {
          let txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
          txt = txt.replace(/\n?# >>> tokenbank env >>>[\s\S]*?# <<< tokenbank env <<<\n?/g, '');
          fs.writeFileSync(f, txt + block, 'utf8');
        }
      }
      return { ok: true, count: entries.length };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 「添加应用」预设（来自 yaml app_presets，可选）。已识别的 CLI/桌面应用都在
  // 应用列表里直接托管，不再用预设面板；无配置时返回空。
  ipcMain.handle('apps:presets', () => {
    try {
      const list = require('./config-loader').appPresets();
      if (Array.isArray(list)) return list;
    } catch {}
    return [];
  });

  // 写入工具配置文件（config-file 注入：如 Codex Desktop API 模式改 ~/.codex/config.toml）。
  // 前端已把 {BASE}/{KEY} 解析进 patch/env；这里解析路径占位符 + 展开 ~ 后写入。
  ipcMain.handle('apps:writeConfigFile', async (_e, { app_id, config_file, patch, env, route_id, route_ids } = {}) => {
    try {
      const cl = require('./config-loader');
      let file = cl.resolvePlaceholders(String(config_file || ''), {});
      file = cl.expandHome(file);
      const isClaudeDesktop = shouldUseClaude3pConfigWrite({ app_id, config_file, file });
      let claudeConfigId = null;
      if (isClaudeDesktop) {
        const resolved = resolveClaude3pWriteTarget(file);
        file = resolved.file;
        claudeConfigId = resolved.configId;
      } else if (!file) {
        return { ok: false, error: 'no-config-file' };
      }
      // 兜底：前端未解析的 {BASE}/{KEY} 在此用本机网关地址 + 应用 api_key 替换
      const gctx = cl.gatewayCtx();
      const appRec = (getApps() || []).find(a => a.id === app_id);
      const patchCtx = {
        ...gctx,
        base: `http://${gctx.reverse}`,
        key: appRec?.api_key || '',
      };
      let resolvedPatch = resolvePatchDeep(patch || {}, patchCtx);
      const resolvedEnv = resolvePatchDeep(env || {}, patchCtx);
      // handler.patch_route：绑路由时改写 patch（如 WorkBuddy models.json id/name）
      const { applyRouteToProxyPatch, resolveHandlerId } = require('./app-handlers');
      const handlerId = resolveHandlerId(appRec);
      const effectiveRouteId = route_id ?? appRec?.route_id;
      const routeIds = Array.isArray(route_ids) && route_ids.length
        ? route_ids
        : (Array.isArray(appRec?.route_ids) && appRec.route_ids.length
          ? appRec.route_ids
          : (effectiveRouteId ? [effectiveRouteId] : []));
      if (handlerId && routeIds.length) {
        let claudeName = 'claude-sonnet-4-5';
        let claudeModels = [];
        try {
          const cms = require('./config-loader').claudeModels?.() || [];
          if (cms.length) { claudeModels = cms; claudeName = cms[0]; }
        } catch {}
        const def = getApiKeyApps().find(d => d.id === appRec?.preset_id);
        resolvedPatch = applyRouteToProxyPatch(handlerId, resolvedPatch, {
          routeIds,
          routes: readLocalConfig().scene_routes || [],
          // 供给源模型（含 type=vision 图文标志）存于 agent config（~/.llm-agent/config.json，
          // 与网关同源），不在 userData/local-config.json —— 供 workbuddy supportsImages 取值
          providers: (readAgentConfig() || {}).providers || [],
          marker: def?.marker || appRec?.marker,
          claudeName,
          // 多路由时每条按 claude_models 列表依次分配独立 name（与 keyScene 绑定顺序一致）
          claudeModels,
        });
      }
      // Codex Desktop：走合并写入(保留 config.toml 其他段)，不整份重写、不写系统环境变量。
      // 生成 model_catalog(绑定路由的模型) + requires_openai_auth=true + experimental_bearer_token，
      // 并保留 auth.json 官方登录态(Desktop 门控放行自定义模型的前提)。
      if (handlerId === 'codex-desktop-api') {
        const codexCfg = require('./codex-config');
        const { getRouteCatalogModels } = require('./app-handlers');
        const codexHome = path.dirname(file);
        // 缺 config.toml：强信号已确认安装时可新建（探测不认 config.toml，不会自证循环）
        const allowCreate = allowCreateMissingProxyConfig(handlerId);
        if (!fs.existsSync(file)) {
          if (!allowCreate) return { ok: false, error: 'config-missing', file };
          try { fs.mkdirSync(codexHome, { recursive: true }); }
          catch (e) { return { ok: false, error: e.message || 'mkdir-failed', file }; }
        }
        const baseUrl = resolvedPatch['model_providers.tokenbank.base_url'] || `${patchCtx.base}/v1`;
        // 供给源「图文」或场景配备识图增强 → catalog.input_modalities 含 image，Codex 才能附图。
        // 每条路由的 context_window 按其候选模型窗口取最小值（感知模型，避免一律 128k）——见 getRouteCatalogModels。
        const providersCfg = (readAgentConfig() || {}).providers || [];
        const sceneRoutes = readLocalConfig().scene_routes || [];
        const catalogModels = getRouteCatalogModels(appRec, sceneRoutes, providersCfg)
          // Claude Desktop 透明 mask 名不进 Codex catalog（与 keyScene 跳过一致）
          .filter((m) => {
            try { return !(require('./config-loader').claudeModels() || []).includes(m.name); }
            catch { return true; }
          });
        const model = resolvedPatch['model'] || (catalogModels[0] && catalogModels[0].name) || '';
        codexCfg.writeCodexCatalog(codexHome, catalogModels, codexCfg.CATALOG_FILE, providersCfg);
        const applied = codexCfg.applyCodexProvider(file, {
          providerId: 'tokenbank', name: 'Tokenbank',
          baseUrl, model, bearerToken: appRec?.api_key || '', catalogFile: codexCfg.CATALOG_FILE,
          allowCreate,
        });
        if (!applied?.ok) return { ok: false, error: applied?.error || 'codex-write-failed', file };
        codexCfg.cleanupThirdPartyAuthKey(codexHome);   // 清第三方残留 key，不动官方 tokens.*
        // 会话归一到 tokenbank：threads(Desktop 列表) + rollout 一并归一，纳管态看到全部
        try { codexCfg.syncCodexSessionProvider(codexHome, 'tokenbank'); } catch {}
        setAppHosted(app_id, true);
        const officialLogin = codexCfg.codexHasOfficialLogin(codexHome);
        // 缺官方登录 → Desktop 门控会藏掉自定义模型，回传提示让前端引导登录
        return { ok: true, file, envCount: 0, codex: true, officialLogin,
          ...(officialLogin ? {} : { warning: 'codex-no-official-login' }) };
      }
      // DeepSeek Harness：settings.yaml 是 dsh 活文档（hot-reload + web Models 页也写），
      // 必须合并式写入（保留 ui-onboarding 等用户段），并动态注入全量网关模型到
      // llm-pi-ai.providers.tokenbank.models；key 写 $DSH_HOME/.credentials.yaml（扁平 mapping）。
      if (handlerId === 'deepseek-harness-cli') {
        const yaml = require('js-yaml');
        const dshHome = path.dirname(file);
        if (!fs.existsSync(file)) {
          if (!allowCreateMissingProxyConfig(handlerId)) return { ok: false, error: 'config-missing', file };
          try { fs.mkdirSync(dshHome, { recursive: true }); }
          catch (e) { return { ok: false, error: e.message || 'mkdir-failed', file }; }
        }
        // 备份原始 settings.yaml（仅首次、非托管态），供取消纳管整份还原
        const bak = file + '.tokenbank-bak';
        if (fs.existsSync(file) && !fs.existsSync(bak) && !isTokenbankManagedConfig(file)) {
          try { fs.copyFileSync(file, bak); } catch {}
        }
        const deepSetDot = (obj, dotKey, val) => {
          const parts = String(dotKey).split('.');
          let cur = obj;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
            cur = cur[parts[i]];
          }
          cur[parts[parts.length - 1]] = val;
        };
        // 读现有文档（保留用户段）；settings.yaml 是普通 YAML（!!js 只在 cordis.patch.yml）
        let doc = {};
        try { if (fs.existsSync(file)) doc = yaml.load(fs.readFileSync(file, 'utf8')) || {}; } catch {}
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};
        for (const [k, v] of Object.entries(resolvedPatch || {})) deepSetDot(doc, k, v);
        // 旧云端快照可能仍带 TOKENBANK_API_KEY；强制独立名，避免撞 Codex 的 shell env
        deepSetDot(doc, 'llm-pi-ai.providers.tokenbank.apiKeyEnv', require('./dsh-config').DSH_API_KEY_ENV);
        // 模型列表：绑了路由（patch_route 策略 tokenbank_models 已填 models）→ 保留所选；
        // 未绑路由 → 兜底注入全量网关模型（/v1/models 按模态重复，须去重后写 [{ id }]）。
        if (!resolvedPatch['llm-pi-ai.providers.tokenbank.models']) {
          try {
            const res = await fetch(`${patchCtx.base}/v1/models`, {
              headers: patchCtx.key ? { Authorization: `Bearer ${patchCtx.key}` } : {},
            });
            if (res.ok) {
              const json = await res.json();
              const ids = [...new Set(
                (Array.isArray(json?.data) ? json.data : [])
                  .map(m => m?.id).filter(x => typeof x === 'string' && x.trim()),
              )];
              if (ids.length) deepSetDot(doc, 'llm-pi-ai.providers.tokenbank.models', ids.map(id => ({ id })));
            }
          } catch (e) { console.warn('[dsh] fetch /v1/models failed:', e.message); }
        }
        // key → $DSH_HOME/.credentials.yaml（独立 TOKENBANK_DSH_API_KEY，避免撞 Codex 的 shell env）
        if (patchCtx.key) {
          try { require('./dsh-config').writeDshCredentials(dshHome, patchCtx.key); }
          catch (e) { console.warn('[dsh] write .credentials.yaml failed:', e.message); }
        }
        fs.writeFileSync(file, yaml.dump(doc, { lineWidth: 120 }), 'utf8');
        setAppHosted(app_id, true);
        return { ok: true, file, envCount: 0 };
      }
      // Trae：模型配置由用户在 IDE 内手工填写，此处不写入 state.vscdb
      // 纳管 = 备份原配置文件（整份，仅首次），再写入我们的配置（整份替换）。
      // 不合并、不检测冲突、不预扫描内容——状态完全跟随用户操作。
      // 缺配置默认不新建（避免自写后再被判已安装）；强信号应用（WorkBuddy /
      // OpenClaw / Claude Desktop）允许首次创建——探测已不认这些配置文件。
      {
        const ensured = ensureProxyConfigWritable(file, {
          allowCreate: allowCreateMissingProxyConfig(handlerId, { isClaudeDesktop }),
        });
        if (!ensured.ok) return { ok: false, error: ensured.error || 'config-missing', file };
      }
      const bak = file + '.tokenbank-bak';
      // 只备份"真正的原始配置"：既有文件若已是 tokenbank 托管配置，绝不备份——否则会把网关配置
      // 存成 .tokenbank-bak，还原时又写回网关配置，导致 Claude Desktop 还原后仍走网关。
      if (!fs.existsSync(bak) && !isTokenbankManagedConfig(file)) {
        try { fs.copyFileSync(file, bak); } catch {}
      }
      if (/\.json$/i.test(file)) {
        fs.writeFileSync(file, JSON.stringify(patchToObject(resolvedPatch), null, 2), 'utf8');
      } else if (/\.ya?ml$/i.test(file)) {
        fs.writeFileSync(file, require('js-yaml').dump(patchToObject(resolvedPatch), { lineWidth: 120 }), 'utf8');
      } else {
        fs.writeFileSync(file, patchToToml(resolvedPatch), 'utf8');
      }
      // 附带的环境变量（如存放 key 的 env_key）一并写入系统
      let envCount = 0;
      const entries = Object.entries(resolvedEnv || {}).filter(([k]) => k && k.trim());
      if (entries.length) {
        if (process.platform === 'win32') {
          const { execFileSync } = require('child_process');
          for (const [k, v] of entries) execFileSync('setx', [k, String(v)], { stdio: ['ignore', 'ignore', 'ignore'] });
        } else {
          const home = os.homedir();
          const targets = ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map(f => path.join(home, f)).filter(f => fs.existsSync(f));
          if (!targets.length) targets.push(path.join(home, '.profile'));
          const block = '\n# >>> tokenbank env >>>\n' + entries.map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`).join('\n') + '\n# <<< tokenbank env <<<\n';
          for (const f of targets) {
            let txt = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
            txt = txt.replace(/\n?# >>> tokenbank env >>>[\s\S]*?# <<< tokenbank env <<<\n?/g, '');
            fs.writeFileSync(f, txt + block, 'utf8');
          }
        }
        envCount = entries.length;
      }
      // 状态跟随操作：标记该应用已纳管
      setAppHosted(app_id, true);
      // Claude Desktop：写入后补齐 _meta.json，否则网关配置 Claude 读不到
      if (isClaudeDesktop || isClaude3pConfigLibraryFile(file)) {
        ensureClaude3pMeta(claudeConfigId || path.basename(file, '.json'));
      }
      // Claude Desktop 接管后立即同步一次（定期同步另有 30s 兜底）
      if (isClaudeDesktop) runClaude3pSync('takeover');
      return { ok: true, file, envCount };
    } catch (e) { return { ok: false, error: (e.stderr ? e.stderr.toString() : e.message).slice(0, 300) }; }
  });

  // 取消纳管：用备份整份还原原配置文件（保留备份与应用条目，不删除）。状态跟随操作。
  ipcMain.handle('apps:revertConfigFile', (_e, { app_id, config_file } = {}) => {
    try {
      revertAppConfigFile(app_id, config_file);
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  // 注册来自 toolsConfig 的 shim 托管 app（透明托管时自动创建或更新 app 记录）
  // shim agent_id → data_source 对应关系
  // agent_id → data_source（从 session_sources 配置派生，不再硬编码）
  const AGENT_DATA_SOURCE = (() => {
    const m = {};
    try {
      for (const s of (require('./config-loader').sessionSources() || [])) {
        if (s && s.agent_id && s.data_source) m[s.agent_id] = s.data_source;
      }
    } catch {}
    return m;
  })();

  /** 应用关联的全部会话 data_source（含 linked_data_sources，如 session-claude-desktop） */
  function resolveAppDataSources(app) {
    if (!app) return [];
    const aid = app.agent_id || app.preset_id;
    const ent = aid ? configLoader.appEntityById(aid) : null;
    const caps = aid ? configLoader.appCapabilities(aid) : null;
    const usageImport = app.session_usage_import ?? caps?.session_usage_import ?? ent?.session_usage_import;
    if (!usageImport) return [];
    const linked = app.linked_data_sources?.length ? app.linked_data_sources
      : (ent?.linked_data_sources?.length ? ent.linked_data_sources : []);
    if (linked.length) return linked;
    if (app.agent_id && AGENT_DATA_SOURCE[app.agent_id]) return [AGENT_DATA_SOURCE[app.agent_id]];
    return [];
  }

  /** @deprecated 用 resolveAppDataSources；保留兼容只取首个 */
  function appSessionDataSource(app) {
    const ds = resolveAppDataSources(app);
    return ds[0] || null;
  }

  ipcMain.handle('apps:detail', (_e, { app, days } = {}) => {
    // 打开明细时强制增量补录，避免节流窗口内看不到会话补录
    try { scheduleSessionTelemetry({ force: true }); } catch {}
    // Cursor：打开明细时立即清 transcript 0 token 占位（节流窗口内也能刷新列表）
    if (app?.agent_id === 'cursor') {
      try { cursorHooks.purgeTranscriptZeroTokens(localStats); } catch {}
    }
    const aid = app?.agent_id || app?.preset_id;
    const ent = configLoader.appEntityById(aid);
    const caps = configLoader.appCapabilities(aid);
    const usageImport = !!(caps?.session_usage_import ?? ent?.session_usage_import ?? app?.session_usage_import);
    const sessionTrace = !!(caps?.session_trace ?? ent?.session_trace ?? app?.session_trace);
    const detail = localStats.queryAppDetail({
      appId: app && app.id, apiKey: app && app.api_key,
      dataSources: resolveAppDataSources(app),
      days: days || 30, includeSessionImport: usageImport,
    });
    const activityAgentId = app?.activity_agent_id || ent?.activity_agent_id || app?.trace_agent_id || app?.agent_id;
    if (sessionTrace && ent) {
      const scanned = sessionBrowser.listActivityForEntity(ent, {
        limit: 50, sinceDays: days || 30,
      });
      if (scanned.length) {
        detail.activity = sessionBrowser.mergeActivityWithStats(
          scanned, usageImport ? detail.sessions : [],
        ).map(a => sessionBrowser.normalizeActivityRow(a, activityAgentId));
      }
      if (detail.recent?.length) {
        detail.recent = sessionBrowser.enrichRecentDetail(activityAgentId, detail.recent, detail.activity);
      }
    }
    detail.hasModelStats = configLoader.agentHasModelStats(
      app?.activity_agent_id || app?.agent_id || app?.preset_id,
    );
    return detail;
  });

  ipcMain.handle('apps:handoffTargets', () => {
    try { return configLoader.handoffTargets(); } catch { return []; }
  });

  ipcMain.handle('apps:sessionTrace', (_e, { agent_id, session_id } = {}) => {
    if (!agent_id || !session_id) return { error: 'missing_params', steps: [] };
    const ent = configLoader.appEntityById(agent_id);
    const trace = ent
      ? sessionBrowser.getTraceForEntity(ent, session_id)
      : sessionBrowser.getTrace(agent_id, session_id);
    const hookOnly = !!(ent?.integrations?.editor_hook);
    const dbRow = localStats.querySessionDetail(session_id, { hookOnly });
    return sessionBrowser.enrichTraceWithDb(trace, dbRow);
  });

  // ── 会话管理：跨 agent 聚合 + 叠加层 + 导出 ──────────────────────────────
  const sessionManager = require('./session-manager');
  const _sessionDeps = { sessionBrowser, localStats };

  ipcMain.handle('sessions:listAll', async (_e, opts = {}) => {
    try {
      // 列表在 worker 扫盘；补录后台跑，都不占主线程
      scheduleSessionTelemetry();
      return await sessionManager.getSessionsAsync(_sessionDeps, opts);
    }
    catch (e) { console.error('[sessions:listAll]', e.message); return []; }
  });

  ipcMain.handle('sessions:setMeta', (_e, payload = {}) => {
    try {
      const r = localStats.setSessionMeta(payload);
      try { sessionManager.invalidateSessionsCache(); } catch {}
      return r;
    }
    catch (e) { console.error('[sessions:setMeta]', e.message); return null; }
  });

  ipcMain.handle('sessions:export', (_e, payload = {}) => {
    try { return sessionManager.exportSession(_sessionDeps, payload); }
    catch (e) { console.error('[sessions:export]', e.message); return { error: 'export_failed' }; }
  });

  ipcMain.handle('sessions:continue', async (_e, payload = {}) => {
    try { return await sessionManager.continueSession(_sessionDeps, payload); }
    catch (e) { console.error('[sessions:continue]', e.message); return { error: 'continue_failed' }; }
  });

  // 知识提炼：后台异步任务。点击 start 立即返回，合成在后台跑；result 拿当前状态/结果。
  // 状态：idle（没跑过）/ running（生成中）/ ready（已完成，含成功或兜底）/ error（异常）。
  let _knowledgeJob = { status: 'idle', ok: false, content: '', model: null, scanned: 0, error: null, projectPaths: {}, finishedAt: 0 };
  function _startKnowledgeJob(model) {
    if (_knowledgeJob.status === 'running') return;
    _knowledgeJob = { status: 'running', ok: false, content: '', model: null, scanned: 0, error: null, projectPaths: {}, finishedAt: 0 };
    sessionManager.synthesizeKnowledge(_sessionDeps, model ? { model } : {})
      .then(r => {
        _knowledgeJob = {
          status: 'ready', ok: !!r.ok, content: r.content || '', model: r.model || null,
          scanned: r.scanned || 0, error: r.error || null, projectPaths: r.projectPaths || {}, finishedAt: Date.now(),
        };
      })
      .catch(e => {
        console.error('[knowledgeJob]', e.message);
        _knowledgeJob = { status: 'error', ok: false, content: '', model: null, scanned: 0, error: 'mine_failed', finishedAt: Date.now() };
      });
  }
  ipcMain.handle('sessions:knowledgeStart', (_e, { model } = {}) => { _startKnowledgeJob(model); return { status: _knowledgeJob.status }; });
  ipcMain.handle('sessions:knowledgeResult', () => ({ ..._knowledgeJob }));
  // 保存 AGENTS.md：弹保存对话框让用户自选位置。写入 UI 传来的（可能已编辑的）content。
  ipcMain.handle('sessions:saveAgentsMd', async (_e, { content, defaultPath } = {}) => {
    try {
      const text = typeof content === 'string' ? content : '';
      // 项目 tab 传来项目目录 → 默认定位到 <项目>/AGENTS.md；否则回退家目录。
      const fallback = require('path').join(require('os').homedir(), 'AGENTS.md');
      const def = typeof defaultPath === 'string' && defaultPath ? defaultPath : fallback;
      const res = await dialog.showSaveDialog(mainWindow, {
        title: 'Save AGENTS.md',
        defaultPath: def,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      require('fs').writeFileSync(res.filePath, text, 'utf8');
      return { ok: true, file: res.filePath };
    } catch (e) { console.error('[sessions:saveAgentsMd]', e.message); return { error: 'save_failed' }; }
  });

  // 统一“打开对应应用 + 粘贴”模式：用 open -a 拉起目标 agent 的桌面应用，不注入 prompt。
  // Cursor 等编辑器可带工作区/交接文件参数；Claude/Codex 等聊天应用只拉起 App，brief 已在剪贴板。
  const _AGENT_APP = { 'claude-code': 'Claude', codex: 'Codex', cursor: 'Cursor' };
  const _EDITOR_AGENTS = new Set(['cursor']);

  function _appInstalled(appName) {
    const fs = require('fs');
    const home = require('os').homedir();
    return [`/Applications/${appName}.app`, `${home}/Applications/${appName}.app`]
      .some(p => { try { return fs.existsSync(p); } catch { return false; } });
  }

  ipcMain.handle('sessions:launch', (_e, { target_agent, cwd, handoffFile } = {}) => {
    try {
      if (process.platform !== 'darwin') return { error: 'launch_unsupported_platform' };
      const app = _AGENT_APP[target_agent];
      if (!app) return { error: 'unsupported_target' };
      if (!_appInstalled(app)) return { error: 'app_not_found', app };

      const args = ['-a', app];
      if (_EDITOR_AGENTS.has(target_agent)) {
        if (cwd) args.push(cwd);
        if (handoffFile) args.push(handoffFile);
      }
      require('child_process').execFile('open', args, err => {
        if (err) console.error('[sessions:launch] open', err.message);
      });
      return { ok: true, app };
    } catch (e) {
      console.error('[sessions:launch]', e.message);
      return { error: 'launch_failed' };
    }
  });

  // 批量查所有应用的统计（调一次，合并进 apps:list 或单独查询）
  ipcMain.handle('apps:stats', (_e, appList) => {
    try { scheduleSessionTelemetry(); } catch {}
    const stats = {};
    for (const app of (appList || [])) {
      const dataSources = resolveAppDataSources(app);
      const aid = app.agent_id || app.preset_id;
      const caps = aid ? configLoader.appCapabilities(aid) : null;
      const ent = aid ? configLoader.appEntityById(aid) : null;
      const usageImport = !!(app.session_usage_import ?? caps?.session_usage_import ?? ent?.session_usage_import);
      let s;
      if (app.link_method === 'api-key' || app.link_method === 'manual') {
        s = localStats.queryAppStatsToday({
          appId: app.id,
          apiKey: app.api_key,
          dataSources,
          includeSessionImport: usageImport,
        });
      } else if ((app.link_method === 'shim' || app.link_method === 'direct' || app.link_method === 'session') && app.agent_id) {
        s = localStats.queryAppStatsToday({
          appId: app.id,
          apiKey: app.api_key,
          dataSources,
          includeSessionImport: usageImport,
        });
      } else {
        s = { calls: 0, tokens: 0, lastTs: null };
      }
      stats[app.id] = s;
    }
    return stats;
  });

  // 盘点页：按网关应用聚合用量（合并原「工具来源 + 场景应用」）
  ipcMain.handle('localStats:appsUsage', (_e, days) => {
    const d = Math.max(1, Math.min(365, parseInt(days, 10) || 1));
    try { scheduleSessionTelemetry(); } catch {}
    const apps = getApps().filter(a => !a.draft);
    return apps.map(app => {
      const dataSources = resolveAppDataSources(app);
      const st = localStats.queryAppStatsInPeriod({
        appId: app.id,
        apiKey: app.api_key,
        dataSources,
        days: d,
      });
      return {
        id: app.id,
        name: app.name,
        icon: app.icon || '🔧',
        link_method: app.link_method,
        agent_id: app.agent_id || null,
        preset_id: app.preset_id || null,
        ...st,
      };
    })
      .filter(a => a.calls > 0)
      .sort((a, b) => b.calls - a.calls);
  });

  ipcMain.handle('apps:ensureShimApp', (_e, { agent_id, name, icon }) => {
    const apps = getApps();
    const existing = apps.find(a => a.agent_id === agent_id && a.link_method === 'shim');
    if (existing) return existing;
    const app = {
      id: 'app-shim-' + agent_id,
      name, icon: icon || '🤖',
      link_method: 'shim', agent_id,
      // shim 鉴权 key，仅用于识别应用（appControls）；模型由请求体指定
      api_key: 'sk-local-' + rndHex(16), route_id: null,
      description: '', allowed_models: [], max_rpm: null,
      max_concurrent: null, allow_stream: true,
      created_at: new Date().toISOString(),
    };
    apps.push(app);
    saveApps(apps);
    return app;
  });

  // Save cloud API config (url + user API key) for P2P forwarding
  ipcMain.handle('localConfig:setCloudConfig', (_e, { url, token } = {}) => {
    const cfg = readLocalConfig();
    cfg.cloud_config = { url: url || null, token: token || null };
    writeLocalConfig(cfg);
    syncGatewayFromConfig(cfg);
    // Refresh active P2P model list using authenticated /v1/models
    fetchPeerModels(url, token);
    // 登录后写入 cloud_config 时补拉供给源（启动时可能尚无 url）
    if (url) {
      catalogSync.scheduleBackgroundSync({
        readLocalConfig,
        applyUserBillingCfg,
        onApplied: notifyCatalogUpdated,
      });
    }
    return { ok: true };
  });

  ipcMain.handle('gateway:setKeySceneMap', (_e, map) => {
    gateway.setKeySceneMap(map);
    return { ok: true };
  });

  ipcMain.handle('gateway:setRouterModelMap', (_e, map) => {
    gateway.setRouterModelMap(map);
    return { ok: true };
  });

  // Claude 客户端模型名（Anthropic 名）：Claude Desktop 的 inferenceModels 只接受这些名字
  ipcMain.handle('apps:claudeModels', () => {
    try { return require('./config-loader').claudeModels() || []; } catch { return []; }
  });

  // Claude Desktop 开发者模式状态：configLibrary 是否就绪（决定能否自动配置）
  ipcMain.handle('apps:claudeDevModeStatus', () => {
    return {
      installed: appxInstalled('Claude'),
      dev_mode_ready: claudeDevModeReady(),
      config_dir: CLAUDE_3P_CONFIG_DIR,
    };
  });

  ipcMain.handle('gateway:testProvider', async (_e, p = {}) => {
    const base_url = p.base_url;
    if (!base_url || typeof base_url !== 'string') return { ok: false, error: 'base_url required' };
    try {
      const { providerTestTargets, logProviderTestProbe, parseProviderProbeError } = require('../shared/provider-test');
      const { resolveOutboundProxyAgent } = require('../shared/outbound-proxy');

      const agentCfg = readAgentConfig() || {};
      const ctx = { id: p.id, api_format: p.api_format, base_url: p.base_url };
      console.log('[provider-test] start', ctx);

      /** 解析响应体中的错误详情 */
      function parseProbeError(body, status) {
        const raw = String(body || '').trim();
        if (!raw) return status ? `HTTP ${status}` : 'Connection failed';
        try {
          const j = JSON.parse(raw);
          return j.error?.message || j.message || raw.slice(0, 300);
        } catch {
          return raw.slice(0, 300);
        }
      }

      // OAuth 供给源：刷新凭证后用 provider 注入头探测
      if (p.auth_type === 'oauth' && p.oauth_provider) {
        let headers = {};
        const ready = await oauthMod.prepare(
          { id: p.id, auth_type: 'oauth', oauth_provider: p.oauth_provider, credentials: p.credentials },
          readAgentConfig, writeAgentConfig,
        );
        if (ready._oauth) {
          const ap = ready._oauth.applyAuth({ headers: {}, body: {}, credentials: ready.credentials });
          headers = { ...ap.headers };
          delete headers['Content-Type'];
          delete headers['Content-Length'];
        }
        const base = base_url.replace(/\/$/, '');
        const oauthTargets = [`${base}/models`, `${base}/v1/models`];
        let result = null;
        for (const probeUrl of oauthTargets) {
          logProviderTestProbe(ctx, { url: probeUrl, headers }, 'request');
          const agent = resolveOutboundProxyAgent({
            provider: { proxy: p.proxy },
            urlStr: probeUrl,
            networkProxy: agentCfg.network_proxy,
          });
          result = await nodeRequest(probeUrl, 'GET', headers, null, agent);
          const ok = result.status >= 200 && result.status < 400;
          logProviderTestProbe(ctx, { url: probeUrl, headers }, 'response', {
            ok,
            status: result.status,
            error: ok ? undefined : parseProbeError(result.body, result.status),
          });
          if (ok || (result.status !== 404 && probeUrl === oauthTargets[0])) break;
        }
        const ok = result.status >= 200 && result.status < 400;
        return { ok, status: result.status, error: ok ? undefined : parseProbeError(result.body, result.status) };
      }

      const { targets, error } = providerTestTargets({
        base_url,
        token: p.token,
        api_format: p.api_format,
      });
      if (error === 'missing_api_key') return { ok: false, error: 'API Key required' };
      if (error === 'invalid_base_url') return { ok: false, error: 'Invalid Base URL' };

      let last = { ok: false, status: 0, error: 'Connection failed' };
      for (const target of targets) {
        logProviderTestProbe(ctx, target, 'request');
        const method = target.method || 'GET';
        const payload = target.body ? JSON.stringify(target.body) : null;
        const agent = resolveOutboundProxyAgent({
          provider: { proxy: p.proxy },
          urlStr: target.url,
          networkProxy: agentCfg.network_proxy,
        });
        const result = await nodeRequest(target.url, method, target.headers, payload, agent);
        const ok = result.status >= 200 && result.status < 400;
        last = { ok, status: result.status, error: ok ? undefined : parseProviderProbeError(result.body, result.status) };
        logProviderTestProbe(ctx, target, 'response', last);
        if (ok) return last;
      }
      return last;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Periodically refresh P2P model list so newly available models are detected
  ipcMain.handle('gateway:refreshPeerModels', async () => {
    const cc = readLocalConfig().cloud_config || {};
    await fetchPeerModels(cc.url, cc.token);
    return gateway.getStatus();
  });

  setInterval(async () => {
    const cc = readLocalConfig().cloud_config || {};
    if (cc.url && cc.token) await fetchPeerModels(cc.url, cc.token);
    seedRandomSpeedForSources();   // 社区节点/个人源新增的模型补随机初始速率（已有则不动）
  }, 60_000);
}

// 主动测速探针：向本地网关发一次极小请求，网关在结束时 record 记速。
// chat 走流式 /v1/chat/completions 并捕获首包 → firstTokenMs；嵌入走 /v1/embeddings（非流式，总延迟当测速点）。
// gateway:probeModel IPC 与「启动自动测速」共用。
function probeModelViaGateway(model) {
  return new Promise((resolve) => {
    try {
      if (!model || typeof model !== 'string') return resolve({ ok: false, error: 'no-model' });
      const cfg = readLocalConfig();
      const key = (cfg.apps || []).map(a => a.api_key).find(Boolean);
      if (!key) return resolve({ ok: false, error: 'no-api-key' });
      const gctx = require('./config-loader').gatewayCtx();
      const [rawHost, portStr] = String(gctx.reverse || '127.0.0.1:11430').split(':');
      // 客户端不能拨 0.0.0.0/::（监听地址≠可连接地址）：macOS/Linux 内核会兜到回环，Windows 直接
      // WSAEADDRNOTAVAIL 失败 → 探针在 Windows 上永远拿不到数据。统一回退回环。
      const host = (!rawHost || rawHost === '0.0.0.0' || rawHost === '::' || rawHost === '*') ? '127.0.0.1' : rawHost;

      let isEmbed = false;
      try {
        const { parseRoute } = require('../shared/route-binding');
        const { inferModelTypeFromName } = require('./models-mcp');
        const pr = parseRoute(model);
        const type = inferModelTypeFromName(pr.model || model);
        // 生图测一次就要真出图，耗时长且计费，测速直接跳过
        if (type === 'image') return resolve({ ok: true, skipped: 'image' });
        isEmbed = type === 'embedding';
      } catch { /* 推断失败则按 chat */ }

      const payload = JSON.stringify(isEmbed
        ? { model, input: 'hi' }
        : { model, max_tokens: 12, stream: true, messages: [{ role: 'user', content: 'hi' }] });
      const start = Date.now();
      let firstTokenMs = null;
      let buf = '';
      const req = http.request({
        host, port: parseInt(portStr, 10) || 11430,
        path: isEmbed ? '/v1/embeddings' : '/v1/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Content-Length': Buffer.byteLength(payload) },
        timeout: 30000,
      }, (res) => {
        res.on('data', (chunk) => {
          // 必须读完流，网关才会在结束时 record 记速
          const text = chunk.toString();
          buf += text;
          if (isEmbed || firstTokenMs != null) return;
          // 首 token：SSE 里出现 content/text 增量，或首个 data:{...} 事件
          if (/"(?:content|text)"\s*:\s*"[^"]/.test(buf)
            || /"delta"\s*:\s*\{[^}]*"(?:content|text)"/.test(buf)
            || /data:\s*\{/.test(buf)) {
            firstTokenMs = Date.now() - start;
          }
        });
        res.on('end', () => {
          const latencyMs = Date.now() - start;
          const ok = res.statusCode < 400;
          resolve({
            ok,
            status: res.statusCode,
            latencyMs,
            firstTokenMs: isEmbed ? (ok ? latencyMs : null) : (firstTokenMs != null ? firstTokenMs : null),
          });
        });
        res.on('error', () => resolve({ ok: false, error: 'stream-error' }));
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ ok: false, error: 'timeout' }); });
      req.end(payload);
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// 个人源可测速模型名（用于随机初始化速率）。
function collectPersonalModelsMain() {
  // 委托 billing-config 的共享实现 → 与网关 scope=personal 过滤、供给源页保持单一真源
  try { return require('./billing-config').collectPersonalModelNames(readLocalConfig()); }
  catch { return []; }
}

// 为社区源(p2p) + 个人源模型「随机初始化」一个测速速率：不发真实探针、不花积分/账单。
// 已有测速数据（随机种子或真实值）则不动 —— 满足"第一次加时随机给一个速率，已有则不变"。
// 新模型（社区节点变化 / 新增个人源）会在下次调用（60s 定时器）时补种子。
function seedRandomSpeedForSources() {
  try {
    const speed = require('./provider-speed');
    // 社区源不再随机初始化：颜色全走服务端 stars（前端 networkModelStats 读 /public/network）。
    // 仅个人源保留随机种子（下拉/列表视图用 speedMap）。
    const personal = collectPersonalModelsMain();
    let n = 0;
    for (const m of personal) if (speed.seedIfMissing(m)) n++;
    if (n) console.log(`[speed] 首次为 ${n} 个个人源模型随机初始化测速`);
  } catch (e) { console.warn('[speed] 随机初始化测速失败:', e.message); }
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  try {
    const { session } = require('electron');
    require('./chromium-session-proxy').applySessionProxy(session.defaultSession, 'default');
  } catch (e) { console.warn('[chromium-proxy] defaultSession:', e && e.message); }
  // 尽早注册菜单栏托盘：macOS 把新状态项插在已有第三方项的「左侧」（刘海侧，最先被挤掉），
  // 越早创建越靠右、越不容易在菜单栏满时被遮挡。数据读取已做空安全，2s 定时器随后补真实值。
  createTray();
  // IPC 须在 createWindow 之前注册，避免 preload sendSync 时 handler 未就绪导致白屏
  registerIPC();
  // SQLite 须早于窗口与 MCP 启动同步，避免渲染进程 IPC 与 syncToClients 竞态
  localStats.init(STATS_DIR);
  try { require('./route-policy-runtime').init(STATS_DIR); } catch (e) { console.error('[route-policy] init failed:', e.message); }
  createWindow();
  repairClaude3pMetaIfNeeded();
  // Claude Desktop ↔ 3p 会话同步：启动一次 + 每 30s 一次（覆盖运行期间新建的会话，修复"新会话纳管后不同步"）
  console.log('[3p-sync] ==== BOOT v2 (reconcile + 双向 watch) 已加载，开始同步 ====');
  sync3pDebugLog('==== BOOT app.whenReady, pid=' + process.pid + ' ====');
  runClaude3pSync('startup');
  // 启动后为社区源+个人源模型随机初始化测速速率（已有则不动）；延迟 10s 等 p2p peer 模型拉到
  setTimeout(() => { seedRandomSpeedForSources(); }, 10000);
  // 文件监听兜底：native / 3p 任一 claude-code-sessions 目录有新/变更文件就立即同步（实时）。
  // 必须双向监听——3p 建的 session 只会改 3p 目录、native 建的只改 native 目录。
  // 只监 account/org 目录（findSessionDir 动态定位）。account/org 变化靠每 60s 重建 watcher 兜底。
  let watchTimer;
  function watchSessions() {
    try {
      const sync = require('./claude-3p-session-sync');
      const dirs = [
        sync.findSessionDir(sync.nativeCodeSessionsRoot()),
        sync.findSessionDir(sync.p3CodeSessionsRoot()),
      ].filter(Boolean);
      // 清除旧 watchers（account/org 变化时重建）
      if (global.__sessionWatchers) for (const w of global.__sessionWatchers) { try { w.close(); } catch {} }
      global.__sessionWatchers = [];
      for (const dir of dirs) {
        const w = fs.watch(dir, (eventType, filename) => {
          sync3pDebugLog(`watch event: evt=${eventType} file=${JSON.stringify(filename)}`);
          if (!filename || !/^local_.+\.json$/.test(filename)) return;
          clearTimeout(watchTimer);
          watchTimer = setTimeout(() => runClaude3pSync('watch'), 2000); // 2s 防抖
        });
        global.__sessionWatchers.push(w);
      }
      console.log(`[3p-sync] watchers armed: ${dirs.length} 个目录`, dirs);
      sync3pDebugLog(`watchers armed: ${dirs.length} dirs: ${JSON.stringify(dirs)}`);
      // 重建 watcher 时顺带对账一次：兜底 fs.watch 漏事件 / 新 account 目录的存量会话。
      // 取代原来独立的 30s 轮询——本函数每 60s 跑一次，即 60s 安全网（实时同步仍靠上面的 watch）。
      runClaude3pSync('watch-rebuild');
    } catch (e) { console.warn('[3p-sync] watch setup failed:', e.message); }
  }
  watchSessions();
  setInterval(watchSessions, 60000); // 每 60s 重建，覆盖 account/org 目录变化
  try { require('./mcp-manager').init(); } catch (e) {
    console.warn('[mcp-manager] init skipped:', e.message);
  }
  try { require('./mcp-manager').syncToClients(); } catch (e) {
    console.warn('[mcp-client-sync] startup sync skipped:', e.message);
  }
  try { cursorHooks.syncForApps(readLocalConfig().apps || [], process.execPath); } catch (e) {
    console.warn('[cursor-hooks] startup sync skipped:', e.message);
  }
  // 一次性迁移：hook 已装时清掉历史 transcript 0 token 行并导入 hook 事件
  try {
    const MIG = '__migrate_cursor_hook_purge_v1__';
    if (!localStats.getImportState(MIG) && cursorHooks.isInstalled()) {
      cursorHooks.purgeTranscriptZeroTokens(localStats);
      cursorHooks.importEvents(localStats);
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[cursor-hooks] migrate purge', e.message); }
  gateway.setStatsRecorder((...args) => {
    const ok = localStats.record(...args);
    if (ok) {
      try { mainWindow?.webContents?.send('localStats:changed'); } catch {}
    }
  });
  gateway.setLocalStats(localStats);
  gateway.setLocalConfigReader(readLocalConfig);   // 供策略组调度查 policies[]
  // 清理旧版付费供给源预填数据（须在 gateway 启动前）
  try {
    const billingConfig = require('./billing-config');
    const localCfg = readLocalConfig();
    const agentCfg = readAgentConfig() || { providers: [] };
    const { cfg: migrated, changed } = billingConfig.migrateAgentProviders({
      ...localCfg,
      providers: agentCfg.providers,
    });
    if (changed) {
      writeAgentConfig({ ...agentCfg, providers: migrated.providers });
      console.log('[main] migrated agent providers: removed stale paid/custom entries');
    }
    syncAgentProviderModelsFromAccounts();
  } catch (e) { console.warn('[main] provider migration skipped:', e.message); }
  // shim 写脚本时按 toolId 取该 shim 应用的 api_key（解析 inject.env 的 {KEY}）
  agentLinker.setKeyResolver((toolId) => {
    const apps = readLocalConfig().apps || [];
    const a = apps.find(x => x.link_method === 'shim' && x.agent_id === toolId);
    if (!a || a.hosted === false) return null;
    // 未绑路由 = 纳管但直连，不走网关（与 apps:list configured 口径一致）
    const hasRoute = !!(a.route_id || (Array.isArray(a.route_ids) && a.route_ids.length));
    if (!hasRoute) return null;
    return a.api_key || null;
  });
  // 多账号实例列表（供 shim 目录分发）：该工具所有带 instance 段的 shim 记录
  agentLinker.setInstancesResolver((toolId) => {
    const apps = readLocalConfig().apps || [];
    return apps
      .filter(x => x.link_method === 'shim' && x.agent_id === toolId && x.instance && !x.instance.invalid)
      .map(x => ({
        config_dir: x.instance.config_dir, api_key: x.api_key, dir_glob: x.instance.dir_glob,
        is_default: !!x.instance.is_default,
        // 路由态：已托管 + 绑了路由 → 走网关；否则直连（shim 只切账号、不注网关）
        routed: !!(x.hosted && (x.route_id || (Array.isArray(x.route_ids) && x.route_ids.length))),
      }));
  });
  // 端口占用检测：被占则弹框提示 + 退出，避免网关静默起不来后 app 假装在运行。
  const GATEWAY_PORT = 11430;
  let _portFatalShown = false;
  function gatewayPortOccupied() {
    if (_portFatalShown) return; _portFatalShown = true;
    try {
      dialog.showMessageBoxSync({
        type: 'error', noLink: true, buttons: ['退出'], defaultId: 0,
        title: '端口被占用，无法启动',
        message: `Token Bank 网关端口 ${GATEWAY_PORT} 已被占用`,
        detail: `可能是另一个 Token Bank 实例，或其他程序正在使用端口 ${GATEWAY_PORT}。\n请关闭占用该端口的程序后，重新启动 Token Bank。`,
      });
    } catch {}
    app.quit();
  }
  (async () => {
    // 先探测：能自己 listen 上说明空闲；EADDRINUSE 说明被占。
    const free = await new Promise((resolve) => {
      const tester = require('net').createServer()
        .once('error', (err) => resolve(err && err.code !== 'EADDRINUSE'))   // 仅 EADDRINUSE 判占用；其它错误放行交给真正 start
        .once('listening', () => tester.close(() => resolve(true)))
        .listen(GATEWAY_PORT, '127.0.0.1');
    });
    if (!free) { gatewayPortOccupied(); return; }
    // 探测与真正 bind 之间存在竞态：listen 若仍 EADDRINUSE，由回调兜底
    gateway.start(GATEWAY_PORT, readAgentConfig, writeAgentConfig, '127.0.0.1', (err) => {
      if (err && err.code === 'EADDRINUSE') gatewayPortOccupied();
    });
  })();

  // OpenRouter 模型目录：启动拉一次(无缓存/过期时) + 每 1h 定时刷新，供网关合并进 openrouter 源模型。
  // 前端源卡显示由前端主导（启用时 refresh + 拿模型写进自己的配置状态，见 Providers.persistProviderEnabled）。
  try { require('./openrouter-catalog').start(); } catch {}

  // ChatGPT 网页源：仅当用户已启用时自启本地 server（未启用不开浏览器/不占端口）
  try { require('./chatgpt-web').maybeStart(); } catch (e) { console.warn('[chatgpt-web] maybeStart:', e && e.message); }

  // OAuth token 后台定时刷新：之前只在"用 Claude/看用量卡片"时懒刷新，不用就会过期。
  // 每 30min 扫一遍 oauth 源，过期前 45min 主动刷新回写，保证 token 不断供（Claude/Gemini 等）。
  try {
    const oauthMod = require('./oauth');
    const AHEAD_SEC = 45 * 60;
    const tickOauthRefresh = async () => {
      let cfg; try { cfg = readAgentConfig(); } catch { return; }
      for (const p of (cfg.providers || [])) {
        if (p && p.auth_type === 'oauth' && p.oauth_provider && p.credentials) {
          try { await oauthMod.prepare(p, readAgentConfig, writeAgentConfig, { skew: AHEAD_SEC }); }
          catch (e) { console.warn('[oauth-refresh]', p.id, e && e.message); }
        }
      }
    };
    tickOauthRefresh();
    const _oauthTimer = setInterval(tickOauthRefresh, 30 * 60 * 1000);
    if (_oauthTimer.unref) _oauthTimer.unref();
  } catch (e) { console.warn('[oauth-refresh] init:', e && e.message); }

  // 注入 Claude 客户端模型名（内部透明逻辑，来自 yaml config-loader）
  try { gateway.setClaudeModels(require('./config-loader').claudeModels()); } catch {}

  // 不再启动自动托管：已安装的 CLI 工具在应用列表里显示，由用户手动托管。

  // 补录「不走网关、直连官方」的会话用量：启动跑一次 + 每 30s 增量扫一次。
  // 与网关实时记录靠 request_id 跨来源去重，不会重复计。
  // 有新增就通知前端刷新——否则直连用量要等重启重新挂载才显示，不像网关那样"实时"。
  const runSessionImport = () => { scheduleSessionTelemetry(); };
  // 一次性迁移：历史 Claude 会话用量都存成 session-claude（混了 cli / claude-desktop）。
  // 删掉重扫，按 entrypoint 重新拆分（cli→session-claude、claude-desktop→session-claude-desktop、sdk-cli 跳过）。
  try {
    const MIG = '__migrate_claude_entrypoint_v1__';
    if (!localStats.getImportState(MIG)) {
      localStats.resetSessionData(['session-claude', 'session-claude-desktop'], '%.claude%projects%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate', e.message); }
  // 一次性迁移：早期 cursor 源要求 message.usage（Cursor 不记 usage）→ 旧版扫到 0 条仍标记文件已处理，
  // 导致改成「按请求数计」后文件被当作未变跳过。清掉 cursor 导入状态，让其按新规则重扫。
  try {
    const MIG = '__migrate_cursor_requests_v1__';
    if (!localStats.getImportState(MIG)) {
      localStats.resetSessionData(['session-cursor'], '%.cursor%agent-transcripts%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate cursor', e.message); }
  // 一次性迁移：claude-desktop-3p 曾误归 session-claude → 重扫按 entrypoint 拆分
  try {
    const MIG = '__migrate_claude_desktop_3p_v1__';
    if (!localStats.getImportState(MIG)) {
      localStats.resetSessionData(['session-claude', 'session-claude-desktop'], '%.claude%projects%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate desktop-3p', e.message); }
  // 一次性迁移：Debug/聚合 spawn 的 sdk-cli 会话此前被 skip，导致纳管应用网关用量缺失
  try {
    const MIG = '__migrate_sdk_cli_session_import_v1__';
    if (!localStats.getImportState(MIG)) {
      localStats.resetSessionData(['session-claude'], '%.claude%projects%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate sdk-cli import', e.message); }
  // 一次性迁移：proxy 占位行占 request_id 导致会话补录被 IGNORE → 清 import_state 触发 enrich 重扫
  try {
    const MIG = '__migrate_session_enrich_rescan_v1__';
    if (!localStats.getImportState(MIG)) {
      localStats.resetImportState('%.claude%projects%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate enrich rescan', e.message); }
  // 一次性迁移：tokenbank.yaml 仍将 sdk-cli 列入 skip → 会话有记录但用量永不落库
  try {
    const MIG = '__migrate_unskip_sdk_cli_v2__';
    if (!localStats.getImportState(MIG)) {
      try {
        if (fs.existsSync(TB_YAML)) {
          const yaml = require('js-yaml');
          const doc = yaml.load(fs.readFileSync(TB_YAML, 'utf8')) || {};
          const cl = doc.session_scans && doc.session_scans.claude;
          if (cl && cl.data_source_map) {
            const dsm = cl.data_source_map;
            dsm.map = { ...(dsm.map || {}), 'sdk-cli': 'session-claude', 'sdk-ts': 'session-claude', cli: 'session-claude' };
            if (Array.isArray(dsm.skip)) dsm.skip = dsm.skip.filter((ep) => ep !== 'sdk-cli' && ep !== 'sdk-ts' && ep !== 'cli');
            fs.writeFileSync(TB_YAML, yaml.dump(doc), 'utf8');
            configLoader.load();
            console.log('[session-import] patched tokenbank.yaml: unskip sdk-cli/cli');
          }
        }
      } catch (e) { console.warn('[session-import] patch tokenbank.yaml:', e.message); }
      localStats.resetImportState('%.claude%projects%');
      localStats.setImportState(MIG, 1, 0);
    }
  } catch (e) { console.error('[session-import] migrate unskip sdk-cli', e.message); }
  // 延后到 didFinishLaunching 返回之后：同步扫 DSH zstd 会卡住启动，且曾在该通知栈上 SIGTRAP
  setImmediate(runSessionImport);
  setInterval(runSessionImport, 30_000);

  if (!isDev) setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

// 关闭窗口后驻留托盘，不退出进程
app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  destroyTray();
  agent.stop(); gateway.stop(); localStats.close();
  // 退出即还原所有接入：删 shim / 还原 PATH / 还原配置文件 / 停 MITM，绝不残留
  try { revertCliInstanceEndpointConfigs(); } catch (e) { console.error('[cli-instance] revert on exit failed:', e.message); }
  try { agentLinker.revertEverythingOnExit(); } catch (e) { console.error('[agent-linker] revert on exit failed:', e.message); }
});
