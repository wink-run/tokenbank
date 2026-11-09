// client/cli/electron-stub.js
// CLI / Docker 没有 Electron：共用的 electron/ 模块（资产管理、智能体执行的 IPC handler 等）
// 顶部 require('electron') 时拿到这个替身。只实现这些模块真正用到的部分：
//  - ipcMain.handle 收集 handler，交给 ipc-bridge 按 HTTP 调用
//  - BrowserWindow.getAllWindows() 返回一个假窗口，webContents.send 转成 bridge 事件（SSE 推给 Web 界面）
//  - dialog / shell 在无桌面环境下返回「已取消 / 不支持」
'use strict';

const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const handlers = new Map();
const events = new EventEmitter();
events.setMaxListeners(0);

const ipcMain = {
  handle(channel, fn) { handlers.set(channel, fn); },
  handleOnce(channel, fn) { handlers.set(channel, fn); },
  removeHandler(channel) { handlers.delete(channel); },
  on() { return ipcMain; },
  once() { return ipcMain; },
  removeListener() { return ipcMain; },
  removeAllListeners() { return ipcMain; },
};

const webContents = {
  id: 0,
  send(channel, data) { events.emit('event', channel, data); },
  isDestroyed() { return false; },
};

const fakeWindow = {
  webContents,
  isDestroyed() { return false; },
  isVisible() { return true; },
  isMinimized() { return false; },
  show() {}, restore() {}, focus() {}, moveTop() {},
};

const BrowserWindow = {
  getAllWindows() { return [fakeWindow]; },
  getFocusedWindow() { return null; },
  fromWebContents() { return null; },
};

const NOT_SUPPORTED = 'Not supported in Docker / web mode';

const dialog = {
  async showOpenDialog() { return { canceled: true, filePaths: [] }; },
  async showSaveDialog() { return { canceled: true, filePath: undefined }; },
  async showMessageBox() { return { response: 0 }; },
  showErrorBox() {},
};

const shell = {
  async openPath() { return NOT_SUPPORTED; },
  showItemInFolder() {},
  async openExternal() {},
};

function configDir() {
  return process.env.LLM_AGENT_CONFIG_DIR || path.join(os.homedir(), '.llm-agent');
}

const app = {
  isPackaged: false,
  getPath(name) {
    if (name === 'home') return os.homedir();
    if (name === 'temp') return os.tmpdir();
    // skill-demand-miner 等从 userData 读 local-config.json；CLI 的同一份文件在配置目录
    return configDir();
  },
  getVersion() {
    try { return require('../package.json').version; } catch { return '0.0.0'; }
  },
  getName() { return 'Token Bank'; },
  whenReady() { return Promise.resolve(); },
  on() { return app; },
  once() { return app; },
};

module.exports = {
  ipcMain,
  BrowserWindow,
  dialog,
  shell,
  app,
  // 供 ipc-bridge 使用（非 Electron API）
  __handlers: handlers,
  __events: events,
  __NOT_SUPPORTED: NOT_SUPPORTED,
};
