// client/electron/guardian/ipc.js
// 看护的 IPC：桌面版 main.js 注册；Docker 经 cli/ipc-bridge.js 以 HTTP 暴露（同一组 handler）。
'use strict';

const { ipcMain } = require('electron');
const guardian = require('./index');

let startedOnce = false;

function safe(fn) {
  return async (_event, ...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      console.error('[guardian] ipc error:', e.message);
      return { success: false, error: e.message };
    }
  };
}

function registerGuardianHandlers() {
  ipcMain.handle('guardian:getSettings', safe(() => ({ success: true, settings: guardian.getSettings() })));
  ipcMain.handle('guardian:setSettings', safe((patch) => ({ success: true, settings: guardian.setSettings(patch || {}) })));
  ipcMain.handle('guardian:listRecords', safe((opts) => ({ success: true, records: guardian.listRecords(opts || {}) })));
  ipcMain.handle('guardian:undo', safe(async (id) => {
    const r = await guardian.undo(id);
    return { success: !!r.ok, error: r.error };
  }));
  // 自我进化：学到的规则（看、删）
  ipcMain.handle('guardian:learnedRules', safe(() => ({ success: true, rules: require('./judgment').list() })));
  ipcMain.handle('guardian:removeLearnedRule', safe((id) => ({ success: !!require('./judgment').removeRule({ id }).ok })));
  // 对话：打开（问候 / 简报 / 标已读）、说一句、点快捷回复、未读数、换执行应用
  ipcMain.handle('guardian:convoOpen', safe(() => ({ success: true, ...require('./convo').open() })));
  ipcMain.handle('guardian:convoList', safe(() => ({ success: true, messages: require('./convo').list(), runtime: require('./engine').status() })));
  ipcMain.handle('guardian:convoSay', safe(async (text) => { const r = await require('./convo').say(text); return { success: !!r.ok, ...r }; }));
  ipcMain.handle('guardian:convoQuick', safe(async (id, index) => { const r = await require('./convo').quick(id, index); return { success: !!r.ok, ...r }; }));
  ipcMain.handle('guardian:convoUnread', safe(() => ({ success: true, unread: require('./convo').unread() })));
  ipcMain.handle('guardian:convoRuntime', safe(() => { require('./convo').chooseRuntime(); return { success: true }; }));
  ipcMain.handle('guardian:runChecks', safe(async () => ({ success: true, results: await guardian.runChecks() })));
  // 资产列表的小标签：质量 / 安全 / 重复 / 新版本
  ipcMain.handle('guardian:assetFlags', safe(() => ({ success: true, flags: require('./asset-checks').getFlags() })));

  ipcMain.handle('guardian:preferredTargets', safe((opts) => ({
    success: true, ...(require('./scene-targets').preferredTargets(opts || {}) || { agentIds: [] }),
  })));

  // 分享与多设备：分享前整理、资产清单、立即对比设备差异
  ipcMain.handle('guardian:shareCheck', safe((input) => {
    if (guardian.modeOf('community') === 'off') return { success: true, findings: [], changed: false, ...(input || {}) };
    return { success: true, ...require('./share-check').sanitize(input || {}) };
  }));

  // 说一句话就办：先解析给界面确认，确认后再执行
  // 游乐场的纠正：改派、重做、追问纠错（场景路由修正 / 汇总失败复盘）
  ipcMain.handle('guardian:dispatchFeedback', safe((evt) => {
    const r = require('./dispatch-learn').feedback(evt || {});
    return { success: !!r.ok, learned: !!r.learned, error: r.error };
  }));

  // 运行状态：设置页顶部的标志
  ipcMain.handle('guardian:health', safe(async () => ({ success: true, ...(await require('./health').health()) })));
  // 看护执行引擎：兴趣画像 / 资产发现 / 资产安装交给一个已纳管的应用在后台跑
  ipcMain.handle('guardian:engineStatus', safe(() => ({ success: true, ...require('./engine').status() })));
  ipcMain.handle('guardian:engineSetRuntime', safe((id) => {
    const r = require('./engine').setRuntime(id);
    return { success: !!r.ok, error: r.error, runtime: r.runtime };
  }));
  ipcMain.handle('guardian:engineRun', safe(async (input) => {
    const r = await require('./engine').run(input || {});
    return r.ok ? { success: true, taskId: r.taskId, runtime: r.runtime } : { success: false, error: r.error };
  }));

  // 发现页：能力缺口、推荐反馈、画像修改

  // 资产一键诊断与修复
  ipcMain.handle('resource:diagnose', safe(({ resourceId } = {}) => require('./diagnose').diagnoseResource(resourceId)));
  ipcMain.handle('resource:fixDiagnosis', safe(({ resourceId, type } = {}) => require('./diagnose').fixResource(resourceId, type)));
}

/** 启动看护：登记各项检查、挂网关失败事件、开定时。gatewayModule 为 electron/local-gateway */
function startGuardian({ gateway, initialDelayMs } = {}) {
  if (startedOnce) return;
  startedOnce = true;
  try { require('./projection-heal').register(); } catch (e) { console.warn('[guardian] projection-heal:', e.message); }
  try { require('./asset-checks').register(); } catch (e) { console.warn('[guardian] asset-checks:', e.message); }
  try { require('./dispatch-learn').register(); } catch (e) { console.warn('[guardian] dispatch-learn:', e.message); }
  try { require('./command').register(); } catch (e) { console.warn('[guardian] command:', e.message); }
  try { guardian.tidy(); } catch (e) { console.warn('[guardian] tidy:', e.message); }
  try { require('./agent-api').start(); } catch (e) { console.warn('[guardian] agent-api:', e.message); }
  try { require('./hire-guard').register(); } catch (e) { console.warn('[guardian] hire-guard:', e.message); }
  try { require('./judgment').register(); } catch (e) { console.warn('[guardian] judgment:', e.message); }
  try { require('./review-usage').register(); } catch (e) { console.warn('[guardian] review-usage:', e.message); }
  try { require('./task-watch').attach(); } catch (e) { console.warn('[guardian] task-watch:', e.message); }
  try { if (gateway) require('./gateway-watch').attach(gateway); } catch (e) { console.warn('[guardian] gateway-watch:', e.message); }
  guardian.start({ initialDelayMs });
  console.log('[guardian] started');
}

module.exports = { registerGuardianHandlers, startGuardian };
