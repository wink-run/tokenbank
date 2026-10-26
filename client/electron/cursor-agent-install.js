// client/electron/cursor-agent-install.js
// 一键安装官方 Cursor Agent CLI（游乐场运行时；与 Cursor IDE 无关）
// mac/linux: curl https://cursor.com/install -fsS | bash
// windows:   irm 'https://cursor.com/install?win32=true' | iex
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

function resolveInstalledPath() {
  try {
    const shim = require('./shim-installer');
    shim.clearCommandCache?.('cursor-agent');
    shim.clearCommandCache?.('agent');
    return shim.resolveRealCommand('cursor-agent')
      || shim.resolveRealCommand('agent')
      || null;
  } catch {
    return null;
  }
}

function ensureLocalBinOnPath(env) {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  const sep = process.platform === 'win32' ? ';' : ':';
  const parts = String(env.PATH || env.Path || '').split(sep).filter(Boolean);
  if (!parts.some((p) => path.resolve(p) === path.resolve(localBin))) {
    parts.unshift(localBin);
  }
  const next = { ...env, PATH: parts.join(sep) };
  if (process.platform === 'win32') next.Path = next.PATH;
  return next;
}

function runInstallCommand() {
  return new Promise((resolve) => {
    const env = ensureLocalBinOnPath({ ...process.env });
    let child;
    try {
      if (process.platform === 'win32') {
        const ps = process.env.SystemRoot
          ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : 'powershell.exe';
        child = execFile(
          ps,
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            "irm 'https://cursor.com/install?win32=true' | iex"],
          { timeout: INSTALL_TIMEOUT_MS, windowsHide: true, env, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              resolve({
                ok: false,
                error: String(stderr || err.message || 'install failed').slice(0, 600),
              });
            } else {
              resolve({ ok: true, stdout: String(stdout || '').slice(0, 400) });
            }
          },
        );
      } else {
        // 官方安装脚本；用 bash -lc 以便 curl 在精简 PATH 下仍可用
        const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
        child = execFile(
          bash,
          ['-lc', 'curl -fsSL https://cursor.com/install | bash'],
          { timeout: INSTALL_TIMEOUT_MS, env, maxBuffer: 4 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err) {
              resolve({
                ok: false,
                error: String(stderr || err.message || 'install failed').slice(0, 600),
              });
            } else {
              resolve({ ok: true, stdout: String(stdout || '').slice(0, 400) });
            }
          },
        );
      }
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) });
      return;
    }
    child?.on?.('error', (e) => {
      resolve({ ok: false, error: e.message || String(e) });
    });
  });
}

/**
 * 安装官方 Cursor Agent CLI。已装则直接返回路径。
 * @returns {Promise<{ ok: boolean, already?: boolean, path?: string|null, error?: string }>}
 */
async function installCursorAgentCli() {
  const existing = resolveInstalledPath();
  if (existing) {
    return { ok: true, already: true, path: existing };
  }

  const result = await runInstallCommand();
  if (!result.ok) return result;

  const installed = resolveInstalledPath();
  if (!installed) {
    return {
      ok: false,
      error: '安装脚本已执行，但未找到 agent/cursor-agent。请确认 ~/.local/bin 可写后重试。',
    };
  }
  return { ok: true, already: false, path: installed };
}

/**
 * 探测 Agent CLI 是否已登录（`agent status`）。
 * 先尝试把 Cursor IDE 登录解密并写入 CLI 凭证，实现共享登录。
 */
async function getCursorAgentAuthStatus() {
  const bin = resolveInstalledPath();
  if (!bin) return { ok: false, loggedIn: false, reason: 'cli_not_installed' };

  // IDE → CLI 共享登录（解密 encryption-at-rest + 写钥匙串/auth.json）
  let shared = null;
  try {
    shared = require('./cursor-ide-auth').shareIdeLoginWithCli();
  } catch {
    try { require('./cursor-ide-auth').scrubInvalidAuthJson(); } catch { /* ignore */ }
  }

  return await new Promise((resolve) => {
    const env = ensureLocalBinOnPath({ ...process.env });
    // 若刚共享到 JWT，status 探测也带上 CURSOR_AUTH_TOKEN（非 darwin 主要靠此）
    if (shared?.ok && shared.accessToken) {
      env.CURSOR_AUTH_TOKEN = shared.accessToken;
    }
    execFile(bin, ['status'], {
      timeout: 45000,
      windowsHide: true,
      env,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const text = `${stdout || ''}\n${stderr || ''}`.trim();
      const lower = text.toLowerCase();
      if (/not logged in|not authenticated|authentication required/i.test(text)) {
        resolve({ ok: true, loggedIn: false, reason: 'not_logged_in', detail: text.slice(0, 200), shared });
        return;
      }
      if (err && !text) {
        resolve({ ok: false, loggedIn: false, reason: 'status_failed', error: err.message, shared });
        return;
      }
      // status 成功且非 Not logged in → 视为已登录（文案因版本而异）
      const loggedIn = !err && !/not logged in/i.test(lower);
      resolve({
        ok: true,
        loggedIn,
        reason: loggedIn
          ? (shared?.ok ? 'shared_ide_login' : 'logged_in')
          : 'unknown',
        detail: text.slice(0, 200),
        shared,
      });
    });
  });
}

/**
 * 打开浏览器走官方 `agent login`（共享 IDE 登录失败时的兜底）。
 * @returns {Promise<{ ok: boolean, already?: boolean, error?: string }>}
 */
async function loginCursorAgentCli() {
  const bin = resolveInstalledPath();
  if (!bin) return { ok: false, error: 'cli_not_installed' };

  // 优先共享 IDE 登录，避免再弹浏览器
  try {
    const shared = require('./cursor-ide-auth').shareIdeLoginWithCli();
    if (shared.ok) {
      const afterShare = await getCursorAgentAuthStatus();
      if (afterShare.loggedIn) return { ok: true, already: true, via: 'ide_share' };
    }
  } catch { /* ignore */ }

  const st = await getCursorAgentAuthStatus();
  if (st.loggedIn) return { ok: true, already: true };

  return await new Promise((resolve) => {
    const env = ensureLocalBinOnPath({ ...process.env });
    // 允许弹浏览器；Electron 下由系统打开登录页
    delete env.NO_OPEN_BROWSER;
    execFile(bin, ['login'], {
      timeout: INSTALL_TIMEOUT_MS,
      windowsHide: true,
      env,
      maxBuffer: 2 * 1024 * 1024,
    }, async (err, stdout, stderr) => {
      const after = await getCursorAgentAuthStatus();
      if (after.loggedIn) {
        resolve({ ok: true, already: false });
        return;
      }
      const msg = String(stderr || stdout || err?.message || 'login failed').slice(0, 600);
      resolve({ ok: false, error: msg });
    });
  });
}

module.exports = {
  installCursorAgentCli,
  getCursorAgentAuthStatus,
  loginCursorAgentCli,
  resolveInstalledPath,
  ensureLocalBinOnPath,
  INSTALL_TIMEOUT_MS,
};
