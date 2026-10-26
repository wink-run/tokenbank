// client/electron/shim-installer.js
// 透明拦截层：在 PATH 最前放同名 shim 脚本，用户敲命令先命中它，
// shim 设好环境变量后 exec 真程序、原样转发参数。跨平台（mac/linux/win）。
// 关键：写死真实路径防递归；所有改动带标记块，可精确还原。
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');
const { clearExecRestrictions } = require('./host-exec');

const TB_DIR  = path.join(os.homedir(), '.tokenbank');
const BIN_DIR = path.join(TB_DIR, 'bin');
const IS_WIN  = process.platform === 'win32';

const MARK_BEGIN = '# >>> tokenbank managed >>>';
const MARK_END   = '# <<< tokenbank managed <<<';

function ensureBinDir() {
  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
}

// 探测命令真实路径（此时 shim 目录不应在 PATH 最前，避免探到自己）。
// 返回绝对路径或 null。结果缓存 30s —— apps:list 每次拉列表都要对每个 CLI 工具
// 跑一次 where/command -v 子进程，切 tab 反复拉列表会很慢；缓存后避免重复 spawn。
const _cmdCache = new Map();   // command -> { ts, path }
const CMD_TTL = 30000;

// 已知的 npm 全局 bin / 常见 CLI 安装目录。GUI 启动的 electron 主进程 PATH 常被精简：
// mac（Finder/Dock 启动）不含 Homebrew 的 /opt/homebrew/bin、/usr/local/bin；
// Windows 有时不含 %APPDATA%\npm。导致 where/command -v 找不到明明装好的 npm CLI，
// 应用被误判"未安装"、一键装/卸按钮显示不对。这些目录追加进查询 PATH + 直接查目录兜底。
// Node 版本管理器（nvm/fnm/volta/asdf）的 node bin 目录。GUI 启动的 electron PATH 精简，且
// 探测用 `sh -c`（不用 login shell，避免 ~/.profile 把 BIN_DIR 拼回 PATH 探到 shim 自身），
// 也不加载用户 zsh/bash rc（nvm 就在 rc 里初始化），故这些目录既不在 PATH 也探不到 →
// 只装了 nvm/fnm 的用户会「找不到 npm」→ 一键装/卸报 ENOENT。这里把它们直接补进搜索目录。
function nodeVersionManagerBinDirs() {
  const home = os.homedir();
  const dirs = [];
  // sub: 非空字符串=版本目录下的子路径；'' =版本目录本身(win nvm 的 npm.cmd 就在这一级)；
  //      undefined/null =默认 'bin'(unix 版本目录下的 bin)
  const pushVersioned = (base, sub) => {
    try {
      if (!fs.existsSync(base)) return;
      const vers = fs.readdirSync(base)
        .filter(v => /^v?\d/.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));  // 新版本优先
      for (const v of vers) dirs.push(sub === '' ? path.join(base, v) : path.join(base, v, sub || 'bin'));
    } catch {}
  };
  if (IS_WIN) {
    // Windows：node 版本管理器的 npm.cmd 直接放在版本目录下(无 bin 子目录)。
    const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const ad = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(la, 'Volta', 'bin'));                 // volta
    if (process.env.NVM_SYMLINK) dirs.push(process.env.NVM_SYMLINK);  // nvm-windows 当前激活软链
    pushVersioned(process.env.NVM_HOME || path.join(ad, 'nvm'), '');  // nvm-windows 各版本目录根
    for (const fd of [process.env.FNM_DIR, path.join(ad, 'fnm'), path.join(la, 'fnm')].filter(Boolean)) {
      pushVersioned(path.join(fd, 'node-versions'), 'installation');  // fnm(win 无 bin 子目录)
    }
    return dirs.filter(Boolean);
  }
  // volta / asdf shims（固定路径）
  dirs.push(path.join(home, '.volta', 'bin'), path.join(home, '.asdf', 'shims'));
  // nvm：默认别名优先，其余按版本降序
  const nvmNode = path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node');
  pushVersioned(nvmNode);
  try {
    const def = fs.readFileSync(path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'alias', 'default'), 'utf8').trim();
    const hit = dirs.find(d => d.includes(path.sep + def + path.sep) || d.includes(path.sep + 'v' + def + path.sep));
    if (hit) { dirs.splice(dirs.indexOf(hit), 1); dirs.unshift(hit); }
  } catch {}
  // fnm（多个候选安装位）
  for (const fd of [process.env.FNM_DIR, path.join(home, '.fnm'),
                    path.join(home, 'Library', 'Application Support', 'fnm'),
                    path.join(home, '.local', 'share', 'fnm')].filter(Boolean)) {
    pushVersioned(path.join(fd, 'node-versions'), path.join('installation', 'bin'));
  }
  return dirs;
}

function npmGlobalBinDirs() {
  const home = os.homedir();
  // Kimi Code 默认装到 ~/.kimi-code/bin（仅写进 shell rc，GUI 进程 PATH 常没有）
  const kimiBin = path.join(home, '.kimi-code', 'bin');
  // Cursor Agent CLI：官方安装到 ~/.local/bin（agent / cursor-agent 软链）
  const localBin = path.join(home, '.local', 'bin');
  if (IS_WIN) {
    return [
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
      localBin, // 官方 Win 安装脚本同样落在 %USERPROFILE%\.local\bin
      kimiBin,
    ];
  }
  return [
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    path.join(home, '.npm-global', 'bin'),
    localBin,
    kimiBin,
    ...nodeVersionManagerBinDirs(),
  ];
}

/**
 * Codex CLI 常不进 PATH：嵌在 ChatGPT.app，或由 config.toml 的 CODEX_CLI_PATH 指定。
 * 仅作 resolveRealCommand('codex') 的兜底，避免 Desktop 已装却被标成「未安装」。
 */
function resolveBundledCodexPath() {
  const candidates = [];
  const envPath = (process.env.CODEX_CLI_PATH || '').trim();
  if (envPath) candidates.push(envPath);
  try {
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    const m = toml.match(/^\s*CODEX_CLI_PATH\s*=\s*["']([^"']+)["']/m);
    if (m?.[1]) candidates.push(m[1].trim());
  } catch { /* 无 config 忽略 */ }
  if (!IS_WIN) {
    candidates.push('/Applications/ChatGPT.app/Contents/Resources/codex');
    candidates.push(path.join(os.homedir(), '.codex', 'plugins', '.plugin-appserver', 'codex'));
  }
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Cursor Agent CLI（游乐场用）：官方装到 ~/.local/bin/{agent,cursor-agent}，
 * 真身在 ~/.local/share/cursor-agent/versions/<ver>/cursor-agent。
 * GUI 启动的 Electron PATH 常缺 ~/.local/bin；软链损坏时直接扫 versions 兜底。
 * 仅作 resolveRealCommand('cursor-agent'|'agent') 的兜底——装了 Cursor IDE ≠ 装了本 CLI。
 */
function resolveBundledCursorAgentPath() {
  const home = os.homedir();
  const candidates = [];
  const envPath = (process.env.CURSOR_AGENT_PATH || '').trim();
  if (envPath) candidates.push(envPath);

  const localBin = path.join(home, '.local', 'bin');
  const binNames = IS_WIN
    ? ['cursor-agent.exe', 'cursor-agent.cmd', 'agent.exe', 'agent.cmd', 'cursor-agent', 'agent']
    : ['cursor-agent', 'agent'];
  for (const name of binNames) candidates.push(path.join(localBin, name));

  // 官方安装器写入的版本目录：取最新一份里的 cursor-agent
  const versionsDir = path.join(home, '.local', 'share', 'cursor-agent', 'versions');
  try {
    if (fs.existsSync(versionsDir)) {
      const vers = fs.readdirSync(versionsDir)
        .filter((v) => v && !v.startsWith('.'))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of vers) {
        candidates.push(path.join(versionsDir, v, IS_WIN ? 'cursor-agent.exe' : 'cursor-agent'));
        if (IS_WIN) candidates.push(path.join(versionsDir, v, 'cursor-agent.cmd'));
      }
    }
  } catch { /* ignore */ }

  for (const p of candidates) {
    try {
      if (!p || !fs.existsSync(p)) continue;
      // 解析软链；断链 / 指向不存在目标则跳过
      let real = p;
      try { real = fs.realpathSync(p); } catch { continue; }
      if (!fs.existsSync(real)) continue;
      return real;
    } catch { /* ignore */ }
  }
  return null;
}

/** 路径是否像官方 Cursor Agent（避免 PATH 上无关的 `agent` 误判） */
function looksLikeCursorAgent(filePath) {
  if (!filePath) return false;
  const n = String(filePath).replace(/\\/g, '/').toLowerCase();
  return n.includes('cursor-agent') || n.includes('/cursor-agent/')
    || n.includes('/share/cursor-agent/') || n.includes('\\cursor-agent\\');
}

function ownShimPath(command) {
  return IS_WIN ? path.join(BIN_DIR, command + '.cmd') : path.join(BIN_DIR, command);
}

// 候选路径是否就是我们写的 shim（含 symlink）。命中则不能当 realPath，否则 exec 自己死循环。
function isOwnShimPath(command, candidate) {
  if (!candidate) return false;
  const own = ownShimPath(command);
  try {
    return fs.realpathSync(candidate) === fs.realpathSync(own);
  } catch {
    return path.resolve(candidate) === path.resolve(own);
  }
}

function resolveRealCommand(command) {
  const now = Date.now();
  const cached = _cmdCache.get(command);
  if (cached && (now - cached.ts) < CMD_TTL) return cached.path;
  // 把 BIN_DIR 从 PATH 里剔除再查，确保不命中自己的 shim；并追加已知 npm 全局 bin 目录。
  const sep = IS_WIN ? ';' : ':';
  const extraDirs = npmGlobalBinDirs();
  const cleanPath = [...(process.env.PATH || '').split(sep), ...extraDirs]
    .filter(p => p && path.resolve(p) !== path.resolve(BIN_DIR)).join(sep);
  let result = null;
  try {
    if (IS_WIN) {
      // stdio 静音 stderr（命令不存在时 where 会往 stderr 打 INFO，无需显示）
      const out = execFileSync('where', [command], {
        env: { ...process.env, PATH: cleanPath },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      const first = out.split(/\r?\n/).find(l => l.trim());
      result = first ? first.trim() : null;
    } else {
      // 不用 -l：login shell 会读 ~/.profile，把 BIN_DIR 又拼回 PATH，command -v 探到 shim 自身。
      const out = execFileSync('sh', ['-c', `command -v ${command}`], {
        env: { ...process.env, PATH: cleanPath },
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toString();
      result = out.trim() || null;
    }
  } catch { result = null; }
  if (result && isOwnShimPath(command, result)) result = null;
  // 兜底：where/command -v 没命中就直接查 npm 全局 bin 目录里有没有该命令（最可靠，不依赖进程 PATH）
  if (!result) {
    const exts = IS_WIN ? ['.cmd', '.exe', '.ps1', ''] : [''];
    outer:
    for (const dir of extraDirs) {
      for (const ext of exts) {
        const p = path.join(dir, command + ext);
        try {
          if (fs.existsSync(p) && !isOwnShimPath(command, p)) { result = p; break outer; }
        } catch {}
      }
    }
  }
  // Codex Desktop（ChatGPT.app）内嵌 CLI：PATH 里通常没有 `codex`
  if (!result && command === 'codex') {
    result = resolveBundledCodexPath();
  }
  // Cursor Agent CLI：`agent` 过泛——PATH 命中但非 cursor-agent 时改走官方安装位
  if (command === 'cursor-agent' || command === 'agent') {
    if (result && command === 'agent') {
      let checkPath = result;
      try { checkPath = fs.realpathSync(result); } catch { /* 断链则下面判否 */ }
      if (!looksLikeCursorAgent(checkPath) && !looksLikeCursorAgent(result)) {
        result = null;
      }
    }
    if (!result) {
      result = resolveBundledCursorAgentPath();
    }
  }
  _cmdCache.set(command, { ts: now, path: result });
  return result;
}

// 清命令探测缓存（一键安装/卸载后调，使下次检测立即重查，不等 30s TTL）。
function clearCommandCache(command) {
  if (command) _cmdCache.delete(command);
  else _cmdCache.clear();
}

// 生成一个工具的 shim。envMap = {KEY: value}（要注入的环境变量）。
// realPath = 真实可执行文件绝对路径（已探测、写死）。
// 从注入的 env 值里取网关 origin（http://host:port），用于探活
function probeOrigin(envMap) {
  for (const v of Object.values(envMap || {})) {
    const m = String(v).match(/^(https?:\/\/[^/]+)/);
    if (m) return m[1];
  }
  return null;
}

// 探活成功后 10s 内复用缓存，避免 CLI 短时连启把 /health 打成刷屏。
// 失败则清缓存，下次立刻重试（网关刚启动时能马上接上）。
const GW_ALIVE_TTL_SEC = 10;
function unixHealthProbeLines(origin) {
  const ttl = GW_ALIVE_TTL_SEC;
  return [
    '_TB_GW_CACHE="$HOME/.tokenbank/gw-alive"',
    '_TB_GW_OK=0',
    'if [ -f "$_TB_GW_CACHE" ]; then',
    '  _TB_TS=`cat "$_TB_GW_CACHE" 2>/dev/null`',
    '  _TB_NOW=`date +%s`',
    `  if [ -n "$_TB_TS" ] && [ "$_TB_NOW" -le $((_TB_TS + ${ttl})) ] 2>/dev/null; then _TB_GW_OK=1; fi`,
    'fi',
    'if [ "$_TB_GW_OK" -eq 0 ]; then',
    `  if curl -s -o /dev/null -m 1 "${origin}/health" 2>/dev/null; then`,
    '    mkdir -p "$HOME/.tokenbank" 2>/dev/null',
    '    date +%s > "$_TB_GW_CACHE" 2>/dev/null',
    '    _TB_GW_OK=1',
    '  else',
    '    rm -f "$_TB_GW_CACHE" 2>/dev/null',
    '  fi',
    'fi',
  ];
}

// shim 注入网关 env，但先探活：网关 /health 通才注入（否则直接调真程序走官方）。
// 这样网关没启动时 shim 不会把工具指向死端口 —— 透明托管对“网关未运行”自动回落。
// dispatch（可选）：[{ dir, env }]，按 $PWD 前缀匹配（首个命中胜出，调用方按 dir 长度降序传入）
// 时用该项的 env 覆盖基础 envMap（如 CLAUDE_CONFIG_DIR/ANTHROPIC_AUTH_TOKEN）——按启动目录选不同 CLI 实例。
// dispatch 为空 → 生成的 shim 与不带分发时字节一致（单实例/无 dir_glob 零改动）。
// dispatch 项结构（多账号）：{ dir, selectEnv, gatewayEnv }
//   selectEnv  —— 「选账号」env（如 CLAUDE_CONFIG_DIR），【永远执行、不受探活门控】，
//                 因为按目录选账号跟网关无关，TokenBank 没运行时也必须切对账号；
//   gatewayEnv —— 「走网关」env（base_url + token），【探活通过才注入】；
//                 为 null 表示该实例是「直连」——在探活块里 unset 掉基础网关 env（envMap 的键），
//                 让它退回自己 config-dir 的配置（兼容端点读 settings.json / OAuth 读登录态）。
// baseSelectEnv —— 默认实例的「选账号」env（如自定义 CONFIG_DIR），同样永远执行。
// opts.defaultDirect —— 默认实例是「直连」（未绑路由）：未匹配任何目录时（=走默认账号）
//   在探活块的兜底处 unset 基础网关 env，让默认账号走自己 config-dir 的配置，而非被指向网关。
function writeShim(command, realPath, envMap, dispatch = [], baseSelectEnv = {}, opts = {}) {
  ensureBinDir();
  // 写死真实路径防递归：realPath 绝不能是 BIN_DIR 里的 shim 自己
  if (!realPath || isOwnShimPath(command, realPath)) {
    throw new Error(`shim realPath 不能是自身: ${realPath || '(empty)'}`);
  }
  const defaultDirect = !!(opts && opts.defaultDirect);
  const exports = Object.entries(envMap || {});
  const baseSel = Object.entries(baseSelectEnv || {});
  const origin  = probeOrigin(envMap);
  const disp = (Array.isArray(dispatch) ? dispatch : []).filter(d => d && d.dir && (d.selectEnv || 'gatewayEnv' in d));
  const gwKeys = Object.keys(envMap || {});   // 直连实例要 unset 的基础网关键（base_url + token）
  let shimPath;
  if (IS_WIN) {
    shimPath = path.join(BIN_DIR, command + '.cmd');
    let lines;
    if (origin && exports.length && disp.length) {
      lines = [
        '@echo off',
        'REM ' + MARK_BEGIN,
        'set "_tbc=%CD%\\"',
        // 1) 选账号：永远执行（不受探活门控）
        ...baseSel.map(([k, v]) => `set "${k}=${v}"`),
        ...disp.filter(d => d.selectEnv && Object.keys(d.selectEnv).length).map(d => {
          const needle = d.dir.replace(/[\\/]+$/, '') + '\\';
          const setEnv = Object.entries(d.selectEnv).map(([k, v]) => `set "${k}=${v}"`).join(' & ');
          return `if /i "%_tbc:~0,${needle.length}%"=="${needle}" ( ${setEnv} & goto tbsel )`;
        }),
        ':tbsel',
        // 2) 走网关：探活通过才注入；按目录给路由态实例覆盖 token，直连态实例 unset 网关 env
        `curl.exe -s -o NUL -m 1 "${origin}/health" >NUL 2>NUL`,
        'if not %errorlevel%==0 goto tbrun',
        ...exports.map(([k, v]) => `set "${k}=${v}"`),
        ...disp.map(d => {
          const needle = d.dir.replace(/[\\/]+$/, '') + '\\';
          const gw = ('gatewayEnv' in d) ? d.gatewayEnv : null;
          const setEnv = gw
            ? Object.entries(gw).map(([k, v]) => `set "${k}=${v}"`).join(' & ')
            : gwKeys.map(k => `set "${k}="`).join(' & ');   // 直连：清空网关 env
          return `if /i "%_tbc:~0,${needle.length}%"=="${needle}" ( ${setEnv} & goto tbrun )`;
        }),
        // 兜底（未匹配任何目录 = 走默认账号）：默认直连则清空网关 env，退回默认 config-dir 自身配置
        ...(defaultDirect ? [gwKeys.map(k => `set "${k}="`).join(' & ')] : []),
        ':tbrun',
        `"${realPath}" %*`,
        'REM ' + MARK_END,
      ];
    } else if (origin && exports.length) {
      lines = [
        '@echo off',
        'REM ' + MARK_BEGIN,
        // 探活：curl 通(exit 0)才注入网关 env；不通则跳过 → 走官方
        `curl.exe -s -o NUL -m 1 "${origin}/health" >NUL 2>NUL`,
        'if %errorlevel%==0 (',
        ...exports.map(([k, v]) => `  set "${k}=${v}"`),
        ')',
        `"${realPath}" %*`,
        'REM ' + MARK_END,
      ];
    } else {
      lines = ['@echo off', 'REM ' + MARK_BEGIN, `"${realPath}" %*`, 'REM ' + MARK_END];
    }
    fs.writeFileSync(shimPath, lines.join('\r\n'));
  } else {
    shimPath = path.join(BIN_DIR, command);
    let lines;
    if (origin && exports.length && disp.length) {
      const selDisp = disp.filter(d => d.selectEnv && Object.keys(d.selectEnv).length);
      lines = [
        '#!/bin/sh',
        MARK_BEGIN,
        // 1) 选账号：永远执行（不受探活门控）——按目录选 CONFIG_DIR，跟网关无关
        ...baseSel.map(([k, v]) => `export ${k}="${v}"`),
        ...(selDisp.length ? [
          'case "$PWD/" in',
          ...selDisp.map(d => {
            const dir = d.dir.replace(/\/+$/, '');
            const setEnv = Object.entries(d.selectEnv).map(([k, v]) => `export ${k}="${v}"`).join('; ');
            return `  "${dir}/"*) ${setEnv} ;;`;
          }),
          'esac',
        ] : []),
        // 2) 走网关：探活通过才注入；路由态实例覆盖 token，直连态实例 unset 网关 env
        ...unixHealthProbeLines(origin),
        'if [ "$_TB_GW_OK" -eq 1 ]; then',
        ...exports.map(([k, v]) => `  export ${k}="${v}"`),
        '  case "$PWD/" in',
        ...disp.map(d => {
          const dir = d.dir.replace(/\/+$/, '');
          const gw = ('gatewayEnv' in d) ? d.gatewayEnv : null;
          const setEnv = gw
            ? Object.entries(gw).map(([k, v]) => `export ${k}="${v}"`).join('; ')
            : `unset ${gwKeys.join(' ')}`;   // 直连：清掉网关 env，退回 config-dir 自身配置
          return `    "${dir}/"*) ${setEnv} ;;`;
        }),
        // 兜底（未匹配 = 走默认账号）：默认直连则清空网关 env，退回默认 config-dir 自身配置
        ...(defaultDirect ? [`    *) unset ${gwKeys.join(' ')} ;;`] : []),
        '  esac',
        'fi',
        `exec "${realPath}" "$@"`,
        MARK_END,
      ];
    } else if (origin && exports.length) {
      lines = [
        '#!/bin/sh',
        MARK_BEGIN,
        ...unixHealthProbeLines(origin),
        'if [ "$_TB_GW_OK" -eq 1 ]; then',
        ...exports.map(([k, v]) => `  export ${k}="${v}"`),
        'fi',
        `exec "${realPath}" "$@"`,
        MARK_END,
      ];
    } else {
      lines = ['#!/bin/sh', MARK_BEGIN, `exec "${realPath}" "$@"`, MARK_END];
    }
    fs.writeFileSync(shimPath, lines.join('\n'));
    fs.chmodSync(shimPath, 0o755);
  }
  clearExecRestrictions(shimPath);
  return shimPath;
}

function removeShim(command) {
  const p = IS_WIN ? path.join(BIN_DIR, command + '.cmd') : path.join(BIN_DIR, command);
  try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
}

function shimExists(command) {
  const p = IS_WIN ? path.join(BIN_DIR, command + '.cmd') : path.join(BIN_DIR, command);
  return fs.existsSync(p);
}

// ── PATH 管理 ────────────────────────────────────────────────────────────────
// 把 BIN_DIR 加到 PATH 最前。mac/linux 写 rc 文件（标记块）；win 改用户环境变量。

function shellRcFiles() {
  const home = os.homedir();
  // 覆盖常见 shell；存在哪个就写哪个，都不存在则写 .profile
  const candidates = ['.zshrc', '.bashrc', '.profile', '.bash_profile'].map(f => path.join(home, f));
  const existing = candidates.filter(f => fs.existsSync(f));
  return existing.length ? existing : [path.join(home, '.profile')];
}

function pathBlock() {
  return `${MARK_BEGIN}\nexport PATH="${BIN_DIR}:$PATH"\n${MARK_END}\n`;
}

function enablePath() {
  ensureBinDir();
  if (IS_WIN) {
    // 读当前用户 PATH，前置 BIN_DIR（去重），用 setx 持久化
    let cur = '';
    try { cur = execFileSync('powershell', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','User')"]).toString().trim(); } catch {}
    const parts = cur.split(';').filter(Boolean);
    if (parts.map(p => p.toLowerCase()).includes(BIN_DIR.toLowerCase())) return { changed: false };
    const next = [BIN_DIR, ...parts].join(';');
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `[Environment]::SetEnvironmentVariable('Path', '${next.replace(/'/g, "''")}', 'User')`]);
      return { changed: true, scope: 'win-user-path' };
    } catch (e) { return { changed: false, error: e.message }; }
  } else {
    const written = [];
    for (const rc of shellRcFiles()) {
      let txt = '';
      try { txt = fs.readFileSync(rc, 'utf8'); } catch {}
      if (txt.includes(MARK_BEGIN)) continue;         // 已有标记块，跳过
      fs.appendFileSync(rc, '\n' + pathBlock());
      written.push(rc);
    }
    return { changed: written.length > 0, files: written };
  }
}

function disablePath() {
  if (IS_WIN) {
    let cur = '';
    try { cur = execFileSync('powershell', ['-NoProfile', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','User')"]).toString().trim(); } catch {}
    const parts = cur.split(';').filter(Boolean).filter(p => p.toLowerCase() !== BIN_DIR.toLowerCase());
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `[Environment]::SetEnvironmentVariable('Path', '${parts.join(';').replace(/'/g, "''")}', 'User')`]);
      return { changed: true };
    } catch (e) { return { changed: false, error: e.message }; }
  } else {
    const cleaned = [];
    for (const rc of shellRcFiles()) {
      let txt = '';
      try { txt = fs.readFileSync(rc, 'utf8'); } catch { continue; }
      if (!txt.includes(MARK_BEGIN)) continue;
      // 删除标记块（含块内所有行）
      const re = new RegExp(`\\n?${escapeRe(MARK_BEGIN)}[\\s\\S]*?${escapeRe(MARK_END)}\\n?`, 'g');
      const next = txt.replace(re, '\n');
      fs.writeFileSync(rc, next);
      cleaned.push(rc);
    }
    return { changed: cleaned.length > 0, files: cleaned };
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = {
  resolveRealCommand, clearCommandCache, writeShim, removeShim, shimExists,
  enablePath, disablePath, npmGlobalBinDirs,
  resolveBundledCursorAgentPath, looksLikeCursorAgent,
  paths: { BIN_DIR }, MARK_BEGIN, MARK_END,
};
