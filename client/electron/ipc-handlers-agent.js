// client/electron/ipc-handlers-agent.js
// Agent 聚合系统的 IPC 处理器
'use strict';

const { ipcMain, BrowserWindow, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const agentExecutor = require('./agent-executor');

const ATTACH_READ_MAX_BYTES = 20 * 1024 * 1024;

/** 按扩展名给 data URL 一个 MIME，未知类型用二进制 */
function mimeFromFileName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.json') return 'application/json';
  if (ext === '.csv' || ext === '.txt' || ext === '.md' || ext === '.log') return 'text/plain';
  return 'application/octet-stream';
}

/**
 * macOS 27 上 Electron / 网页 file input 会把 allowedContentTypes 设成空数组，
 * 文件变成灰色无法点选。系统「选取文件」不套类型过滤。
 */
function pickFilesMac(defaultPath) {
  const start = defaultPath && fs.existsSync(defaultPath) ? defaultPath : os.homedir();
  const script = `
on run argv
  set startPath to item 1 of argv
  set theFiles to choose file with prompt "选择附件" with multiple selections allowed default location (POSIX file startPath)
  set out to ""
  repeat with f in theFiles
    set out to out & POSIX path of (f as alias) & linefeed
  end repeat
  return out
end run
`;
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, start], { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const msg = `${err?.message || ''} ${stderr || ''}`;
      if (err && /-128|User canceled|用户已取消/.test(msg)) {
        resolve({ canceled: true, filePaths: [] });
        return;
      }
      if (err) {
        reject(err);
        return;
      }
      const filePaths = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      resolve({ canceled: filePaths.length === 0, filePaths });
    });
  });
}

/**
 * 注册 Agent 相关的 IPC handlers
 */
function registerAgentHandlers() {
  /**
   * 获取可用的 Agent 列表
   */
  ipcMain.handle('agent:list', async (_event, opts = {}) => {
    try {
      const agents = await agentExecutor.listAvailableAgents({ force: !!opts.force });
      return { success: true, agents };
    } catch (error) {
      console.error('[IPC] agent:list error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 执行 Agent 任务
   */
  ipcMain.handle('agent:execute', async (event, { agentId, prompt, options = {} }) => {
    try {
      const result = await agentExecutor.execute(agentId, prompt, options);
      return { success: true, ...result };
    } catch (error) {
      console.error('[IPC] agent:execute error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 取消 Agent 任务
   */
  ipcMain.handle('agent:cancel', async (event, taskId) => {
    try {
      const result = await agentExecutor.cancel(taskId);
      return result;
    } catch (error) {
      console.error('[IPC] agent:cancel error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('agent:cancelAllActive', async () => {
    try {
      return await agentExecutor.cancelAllActive();
    } catch (error) {
      console.error('[IPC] agent:cancelAllActive error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 选择工作目录
   */
  ipcMain.handle('agent:pickWorkingDir', async (_event, opts = {}) => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const defaultPath = opts.defaultPath && String(opts.defaultPath).trim();
      const result = await dialog.showOpenDialog(win, {
        title: '选择 Agent 工作目录',
        properties: ['openDirectory', 'createDirectory'],
        ...(defaultPath ? { defaultPath } : {}),
      });
      if (result.canceled || !result.filePaths?.length) {
        return { success: false, canceled: true };
      }
      return { success: true, path: result.filePaths[0] };
    } catch (error) {
      console.error('[IPC] agent:pickWorkingDir error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 选择附件。用系统对话框且不加文件类型过滤，避免网页 file input 只能选图片。
   */
  ipcMain.handle('agent:pickFiles', async (event, opts = {}) => {
    try {
      const defaultPath = opts.defaultPath && String(opts.defaultPath).trim();
      // macOS 不用 Electron 的打开面板：空的类型列表会把 zip 等文件置灰
      const result = process.platform === 'darwin'
        ? await pickFilesMac(defaultPath)
        : await (async () => {
          const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
          const dialogOpts = {
            title: '选择附件',
            buttonLabel: '添加',
            properties: ['openFile', 'multiSelections'],
            ...(defaultPath ? { defaultPath } : {}),
          };
          return win
            ? dialog.showOpenDialog(win, dialogOpts)
            : dialog.showOpenDialog(dialogOpts);
        })();
      if (result.canceled || !result.filePaths?.length) {
        return { success: false, canceled: true };
      }
      const files = [];
      for (const fp of result.filePaths) {
        const name = path.basename(fp);
        const mime = mimeFromFileName(name);
        try {
          const size = fs.statSync(fp).size;
          if (size > ATTACH_READ_MAX_BYTES) {
            files.push({ name, size, mime, tooBig: true });
            continue;
          }
          const buf = fs.readFileSync(fp);
          files.push({
            name,
            size,
            mime,
            dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
          });
        } catch (e) {
          files.push({ name, size: 0, mime, error: e.message });
        }
      }
      return { success: true, files };
    } catch (error) {
      console.error('[IPC] agent:pickFiles error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 获取任务状态
   */
  ipcMain.handle('agent:getStatus', async (event, taskId) => {
    try {
      const status = await agentExecutor.getTaskStatus(taskId);
      return { success: true, status };
    } catch (error) {
      console.error('[IPC] agent:getStatus error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('agent:listActiveTasks', async () => {
    try {
      const tasks = await agentExecutor.listActiveTasks();
      return { success: true, tasks };
    } catch (error) {
      console.error('[IPC] agent:listActiveTasks error:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('agent:listRecentTasks', async (_event, { agentId, limit } = {}) => {
    try {
      const tasks = await agentExecutor.listRecentTasksForAgent(agentId, limit || 3);
      return { success: true, tasks };
    } catch (error) {
      console.error('[IPC] agent:listRecentTasks error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 一键安装 Cursor Agent CLI（游乐场运行时；官方 install 脚本）
   */
  ipcMain.handle('agent:installCursorCli', async () => {
    try {
      const { installCursorAgentCli } = require('./cursor-agent-install');
      const result = await installCursorAgentCli();
      if (result.ok) {
        try { require('./shim-installer').clearCommandCache(); } catch { /* ignore */ }
        // 强制刷新 listAvailableAgents 缓存
        try { await agentExecutor.listAvailableAgents({ force: true }); } catch { /* ignore */ }
      }
      return { success: !!result.ok, ...result };
    } catch (error) {
      console.error('[IPC] agent:installCursorCli error:', error);
      return { success: false, error: error.message };
    }
  });

  /** Agent CLI 登录状态（与 Cursor IDE 登录无关） */
  ipcMain.handle('agent:cursorCliStatus', async () => {
    try {
      const { getCursorAgentAuthStatus } = require('./cursor-agent-install');
      const result = await getCursorAgentAuthStatus();
      return { success: true, ...result };
    } catch (error) {
      console.error('[IPC] agent:cursorCliStatus error:', error);
      return { success: false, loggedIn: false, error: error.message };
    }
  });

  /** 游乐场调整 Cursor 模型：列出账号可用模型 */
  ipcMain.handle('agent:listCursorModels', async () => {
    try {
      const { listCursorCliModels } = require('./cursor-agent-install');
      const result = await listCursorCliModels();
      return { success: !!result.ok, models: result.models || [], error: result.error };
    } catch (error) {
      console.error('[IPC] agent:listCursorModels error:', error);
      return { success: false, models: [], error: error.message };
    }
  });

  /** 写入 ~/.cursor/cli-config.json，作为 Cursor Agent 的当前模型 */
  ipcMain.handle('agent:setCursorModel', async (_event, { id, name } = {}) => {
    try {
      const { setCursorCliModel } = require('./cursor-agent-install');
      const result = setCursorCliModel(id, name);
      if (result.ok) {
        try { require('./agent-executor').invalidateAgentListCache(); } catch { /* 列表缓存可稍后过期 */ }
      }
      return { success: !!result.ok, ...result };
    } catch (error) {
      console.error('[IPC] agent:setCursorModel error:', error);
      return { success: false, error: error.message };
    }
  });

  /** 打开浏览器登录 Agent CLI（agent login） */
  ipcMain.handle('agent:loginCursorCli', async () => {
    try {
      const { loginCursorAgentCli } = require('./cursor-agent-install');
      const result = await loginCursorAgentCli();
      return { success: !!result.ok, ...result };
    } catch (error) {
      console.error('[IPC] agent:loginCursorCli error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * 监听实时步骤事件
   */
  const { isContributeSessionKey } = require('./contribute-session');
  const shouldBroadcastToUi = (data) => {
    if (!data) return true;
    if (data.clientId === 'contribute') return false;
    if (isContributeSessionKey(data.sessionKey)) return false;
    return true;
  };

  agentExecutor.on('task:step', (stepData) => {
    if (!shouldBroadcastToUi(stepData)) return;
    // 广播给所有窗口
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:task:step', stepData);
    });
  });

  agentExecutor.on('task:dispatched', (data) => {
    if (!shouldBroadcastToUi(data)) return;
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:task:dispatched', data);
    });
  });

  /**
   * 监听任务完成事件
   */
  agentExecutor.on('task:completed', (data) => {
    if (!shouldBroadcastToUi(data)) return;
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:task:completed', data);
    });
  });

  /**
   * 监听任务失败事件
   */
  agentExecutor.on('task:failed', (data) => {
    if (!shouldBroadcastToUi(data)) return;
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:task:failed', data);
    });
  });

  /**
   * 监听任务取消事件
   */
  agentExecutor.on('task:cancelled', (data) => {
    if (!shouldBroadcastToUi(data)) return;
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:task:cancelled', data);
    });
  });

  /** 流式解析到 CLI sessionId 时尽早同步前端（停止后续接用） */
  agentExecutor.on('task:cliSession', (data) => {
    if (!shouldBroadcastToUi(data)) return;
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('agent:task:cliSession', data);
    });
  });

  // ── 社区武将雇佣（名片本地名单，无正文）────────────────────────────────
  ipcMain.handle('community:listHired', () => {
    try {
      const { listHired } = require('./hired-community-agents');
      return { success: true, hired: listHired() };
    } catch (e) {
      return { success: false, error: e.message, hired: [] };
    }
  });

  ipcMain.handle('community:hire', async (_e, card) => {
    try {
      const { hire } = require('./hired-community-agents');
      const entry = hire(card || {});
      // 异步上报真实被雇次数，不阻塞本机雇佣结果
      try {
        const { reportCommunityAgentHire } = require('./community-agent-client');
        reportCommunityAgentHire({
          assistantId: entry.assistant_id,
          workerId: entry.worker_id,
        }).catch(() => {});
      } catch { /* ignore */ }
      return { success: true, hired: entry };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('community:unhire', (_e, id) => {
    try {
      const { unhire } = require('./hired-community-agents');
      return { success: true, removed: unhire(id) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  console.log('[IPC] Agent handlers registered');
}

// 需要 BrowserWindow（事件广播）
// dialog / BrowserWindow 已在顶部引入

module.exports = { registerAgentHandlers };
