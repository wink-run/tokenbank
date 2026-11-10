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
  ipcMain.handle('guardian:apply', safe(async (id) => {
    const r = await guardian.apply(id);
    return { success: !!r.ok, error: r.error };
  }));
  ipcMain.handle('guardian:act', safe(async (id, index) => {
    const r = await guardian.act(id, index);
    return { success: !!r.ok, error: r.error, message: r.message };
  }));
  // 自我进化：学到的规则（看、删）
  ipcMain.handle('guardian:learnedRules', safe(() => ({ success: true, rules: require('./judgment').list() })));
  ipcMain.handle('guardian:removeLearnedRule', safe((id) => ({ success: !!require('./judgment').removeRule({ id }).ok })));
  ipcMain.handle('guardian:dismiss', safe((id) => ({ success: guardian.dismiss(id) })));
  ipcMain.handle('guardian:runChecks', safe(async () => ({ success: true, results: await guardian.runChecks() })));
  // 资产列表的小标签：质量 / 安全 / 重复 / 新版本
  ipcMain.handle('guardian:assetFlags', safe(() => ({ success: true, flags: require('./asset-checks').getFlags() })));

  // 定期自省：立即运行、报告
  ipcMain.handle('guardian:introspectNow', safe(async () => {
    const r = await require('./introspect').run({ manual: true });
    return r.ok ? { success: true, report: r.report } : { success: false, error: r.error };
  }));
  ipcMain.handle('guardian:listReports', safe(() => ({
    success: true, reports: require('./introspect').listReports(), running: require('./introspect').isRunning(),
  })));
  // 按场景投射：新技能启用时该投到哪些应用
  ipcMain.handle('guardian:preferredTargets', safe((opts) => ({
    success: true, ...(require('./scene-targets').preferredTargets(opts || {}) || { agentIds: [] }),
  })));

  // 分享与多设备：分享前整理、资产清单、立即对比设备差异
  ipcMain.handle('guardian:shareCheck', safe((input) => {
    if (guardian.modeOf('community') === 'off') return { success: true, findings: [], changed: false, ...(input || {}) };
    return { success: true, ...require('./share-check').sanitize(input || {}) };
  }));
  ipcMain.handle('guardian:assetSnapshot', safe(() => ({ success: true, assets: require('./device-sync').snapshot() })));

  // 说一句话就办：先解析给界面确认，确认后再执行
  ipcMain.handle('guardian:commandParse', safe(async ({ text, allowModel } = {}) => ({ success: true, plan: await require('./command').parse(text, { allowModel: allowModel !== false }) })));
  ipcMain.handle('guardian:commandRun', safe(async (plan) => {
    const r = await require('./command').run(plan || {});
    return r.ok ? { success: true, message: r.message, link: r.link } : { success: false, error: r.error };
  }));
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
  ipcMain.handle('guardian:capabilityGaps', safe(async () => ({ success: true, gaps: await require('./capability-gaps').listOpen() })));
  ipcMain.handle('guardian:recoFeedback', safe((input) => {
    const r = require('./discover-learn').recoFeedback(input || {});
    return { success: !!r.ok, error: r.error };
  }));
  ipcMain.handle('guardian:recoState', safe((opts) => ({ success: true, ...require('./discover-learn').recoState(opts || {}) })));
  ipcMain.handle('guardian:portraitFeedback', safe((input) => {
    const r = require('./discover-learn').portraitFeedback(input || {});
    return { success: !!r.ok, error: r.error };
  }));
  ipcMain.handle('guardian:portraitConstraints', safe(() => ({ success: true, lines: require('./discover-learn').portraitConstraints() })));

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
  try { require('./setup-check').register(); } catch (e) { console.warn('[guardian] setup-check:', e.message); }
  try { require('./share-suggest').register(); } catch (e) { console.warn('[guardian] share-suggest:', e.message); }
  try { require('./device-sync').register(); } catch (e) { console.warn('[guardian] device-sync:', e.message); }
  try { require('./discover-learn').register(); } catch (e) { console.warn('[guardian] discover-learn:', e.message); }
  try { require('./dispatch-learn').register(); } catch (e) { console.warn('[guardian] dispatch-learn:', e.message); }
  try { require('./command').register(); } catch (e) { console.warn('[guardian] command:', e.message); }
  try { require('./capability-gaps').register(); } catch (e) { console.warn('[guardian] capability-gaps:', e.message); }
  try { require('./agent-api').start(); } catch (e) { console.warn('[guardian] agent-api:', e.message); }
  try { require('./judgment').register(); } catch (e) { console.warn('[guardian] judgment:', e.message); }
  try { require('./review-usage').register(); } catch (e) { console.warn('[guardian] review-usage:', e.message); }
  try { require('./introspect').register(); } catch (e) { console.warn('[guardian] introspect:', e.message); }
  try { require('./task-watch').attach(); } catch (e) { console.warn('[guardian] task-watch:', e.message); }
  try { if (gateway) require('./gateway-watch').attach(gateway); } catch (e) { console.warn('[guardian] gateway-watch:', e.message); }
  guardian.start({ initialDelayMs });
  console.log('[guardian] started');
}

module.exports = { registerGuardianHandlers, startGuardian };
