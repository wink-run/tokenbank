// client/electron/ipc-handlers-agent.js
// Agent 聚合系统的 IPC 处理器
'use strict';

const { ipcMain, BrowserWindow, dialog } = require('electron');
const agentExecutor = require('./agent-executor');

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
