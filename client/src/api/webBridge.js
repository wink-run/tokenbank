// client/src/api/webBridge.js
// Docker / CLI 的 Web 界面没有 Electron preload。admin-api 通过 /api/bridge 暴露与桌面版相同的
// 资产管理（resource:*）和命令行智能体（agent:* / community:*）IPC handler，这里按 preload.js 的同名方法
// 拼出 window.electronAPI.{resource, agent, llm, mcp}，让资产页、智能体和 MCP 页不改调用方式即可工作。
// 标记 __web: true —— isElectron() 据此仍判为非桌面，其余桌面专属能力（网关、配置等）照旧走 HTTP 适配。

const ADMIN_BASE = import.meta.env?.VITE_ADMIN_BASE ?? '';
const HEADERS = { 'Content-Type': 'application/json', 'X-TokenBank-Bridge': '1' };

async function invoke(channel, ...args) {
  const res = await fetch(`${ADMIN_BASE}/api/bridge/invoke`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ channel, args }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* 非 JSON */ }
  if (!body || !body.ok) throw new Error((body && body.error) || `bridge ${channel} failed (${res.status})`);
  return body.result;
}

// ── 事件：一个 EventSource，按 channel 分发 ─────────────────────────────────
const listeners = new Map();
let source = null;

function ensureSource() {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource(`${ADMIN_BASE}/api/bridge/events`);
  source.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const set = listeners.get(msg.channel);
    if (!set) return;
    for (const cb of [...set]) {
      try { cb(msg.data); } catch (err) { console.warn('[webBridge] listener', msg.channel, err); }
    }
  };
}

function on(channel) {
  return (cb) => {
    if (typeof cb !== 'function') return () => {};
    ensureSource();
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => { listeners.get(channel)?.delete(cb); };
  };
}

const call = (channel, fallback = undefined) => (arg) => invoke(channel, arg == null ? fallback : arg);
const call0 = (channel) => () => invoke(channel);

// 与 electron/preload.js 的 resource 段一一对应
const resource = {
  listCatalog: call('resource:listCatalog', {}),
  listResources: call('resource:listResources', {}),
  installCatalog: call('resource:installCatalog', {}),
  syncCommunityCatalog: call0('resource:syncCommunityCatalog'),
  upsertCommunitySkill: call('resource:upsertCommunitySkill', {}),
  ensureBuiltinAssistants: call0('resource:ensureBuiltinAssistants'),
  saveResource: call('resource:saveResource', {}),
  pickImportPath: call('resource:pickImportPath', {}),
  importFromPath: call('resource:importFromPath', {}),
  deleteResource: (resourceId, options) => invoke('resource:deleteResource', {
    resourceId, ...(options && typeof options === 'object' ? options : {}),
  }),
  project: call('resource:project', {}),
  unproject: call('resource:unproject', {}),
  verifyProjections: call('resource:verifyProjections', {}),
  listAgentTargets: call0('resource:listAgentTargets'),
  listScanRoots: call('resource:listScanRoots', {}),
  scanDiscovered: call('resource:scanDiscovered', {}),
  syncDiscovered: call('resource:syncDiscovered', {}),
  importDiscovered: call('resource:importDiscovered', {}),
  listAgentInstallations: call('resource:listAgentInstallations', {}),
  importFromAgent: call('resource:importFromAgent', {}),
  removeFromAgent: call('resource:removeFromAgent', {}),
  openPath: call('resource:openPath', {}),
  previewFile: call('resource:previewFile', {}),
  packSkillFiles: call('resource:packSkillFiles', {}),
  listIdleSkills: call('resource:listIdleSkills', {}),
  cleanupSkills: call('resource:cleanupSkills', {}),
  mineDemand: call('resource:mineDemand', {}),
  installSkillhub: call('resource:installSkillhub', {}),
  installGithubSkill: call('resource:installGithubSkill', {}),
  extractDescription: call('resource:extractDescription', {}),
  onHit: on('resource:hit'),
  pollHit: call0('resource:pollHit'),
  diagnose: call('resource:diagnose', {}),
  fixDiagnosis: call('resource:fixDiagnosis', {}),
};

// 与 preload.js 的 guardian 段一致
const guardian = {
  getSettings: call0('guardian:getSettings'),
  setSettings: call('guardian:setSettings', {}),
  listRecords: call('guardian:listRecords', {}),
  undo: (id) => invoke('guardian:undo', id),
  apply: (id) => invoke('guardian:apply', id),
  act: (id, index) => invoke('guardian:act', id, index),
  summary: () => invoke('guardian:summary'),
  actRecommended: () => invoke('guardian:actRecommended'),
  learnedRules: () => invoke('guardian:learnedRules'),
  removeLearnedRule: (id) => invoke('guardian:removeLearnedRule', id),
  dismiss: (id) => invoke('guardian:dismiss', id),
  runChecks: call0('guardian:runChecks'),
  assetFlags: call0('guardian:assetFlags'),
  preferredTargets: call('guardian:preferredTargets', {}),
  shareCheck: call('guardian:shareCheck', {}),
  capabilityGaps: call0('guardian:capabilityGaps'),
  health: call0('guardian:health'),
  dispatchFeedback: call('guardian:dispatchFeedback', {}),
  engineStatus: call0('guardian:engineStatus'),
  engineSetRuntime: (id) => invoke('guardian:engineSetRuntime', id),
  engineRun: call('guardian:engineRun', {}),
};

// preload 的 agent 段里「智能体聚合」部分；设备代理的 start/stop/getStatus/日志在 CLI 已有 /api/agent/*，不放这里
const agent = {
  listAgents: call('agent:list', {}),
  list: call('agent:list', {}),
  execute: (params) => invoke('agent:execute', params),
  cancel: (taskId) => invoke('agent:cancel', taskId),
  cancelAllActive: call0('agent:cancelAllActive'),
  getTaskStatus: (taskId) => invoke('agent:getStatus', taskId),
  listActiveTasks: call0('agent:listActiveTasks'),
  listRecentTasks: (opts) => invoke('agent:listRecentTasks', opts),
  taskStats: call0('agent:taskStats'),
  pickWorkingDir: (opts) => invoke('agent:pickWorkingDir', opts),
  pickFiles: (opts) => invoke('agent:pickFiles', opts),
  installCursorCli: call0('agent:installCursorCli'),
  cursorCliStatus: call0('agent:cursorCliStatus'),
  loginCursorCli: call0('agent:loginCursorCli'),
  listCursorModels: call0('agent:listCursorModels'),
  setCursorModel: call('agent:setCursorModel', {}),
  listHiredCommunity: call0('community:listHired'),
  hireCommunity: (card) => invoke('community:hire', card),
  unhireCommunity: (id) => invoke('community:unhire', id),
  onStep: on('agent:task:step'),
  onDispatched: on('agent:task:dispatched'),
  onCompleted: on('agent:task:completed'),
  onFailed: on('agent:task:failed'),
  onCancelled: on('agent:task:cancelled'),
  onCliSession: on('agent:task:cliSession'),
  onListUpdated: on('agent:listUpdated'),
};

// 与 electron/preload.js 的 mcp 段一一对应
const mcp = {
  listServers: call0('mcp:listServers'),
  listCatalog: call0('mcp:listCatalog'),
  installCatalog: call('mcp:installCatalog', {}),
  uninstallServer: (serverId) => invoke('mcp:uninstallServer', serverId),
  setServerStatus: call('mcp:setServerStatus', {}),
  saveServer: call('mcp:saveServer', {}),
  listProfiles: call0('mcp:listProfiles'),
  getProfile: (profileId) => invoke('mcp:getProfile', profileId),
  saveProfile: call('mcp:saveProfile', {}),
  syncClients: call('mcp:syncClients', {}),
  getSyncStatus: call0('mcp:getSyncStatus'),
  listAgentInstallations: call0('mcp:listAgentInstallations'),
  importFromClient: call('mcp:importFromClient', {}),
  importFromAgent: call('mcp:importFromAgent', {}),
  setServerSyncClients: call('mcp:setServerSyncClients', {}),
  toggleServerSyncClient: call('mcp:toggleServerSyncClient', {}),
  removeFromAgent: call('mcp:removeFromAgent', {}),
  setServerGatewayRouted: call('mcp:setServerGatewayRouted', {}),
  setServersGatewayRouted: call('mcp:setServersGatewayRouted', {}),
  getGatewayInfo: call0('mcp:getGatewayInfo'),
};

// 只能访问容器内本机网关（服务端限制）
const llm = {
  fetch: (url, options) => invoke('llm:fetch', { url, ...(options || {}) }),
};

/** 探测 admin-api 是否提供 bridge；提供则挂到 window.electronAPI（桌面版已有 preload 时不动） */
export async function installWebBridge({ timeoutMs = 1500 } = {}) {
  if (typeof window === 'undefined' || window.electronAPI) return false;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(`${ADMIN_BASE}/api/bridge/ping`, { headers: HEADERS, signal: ctrl?.signal });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    if (!body || !body.ok) return false;
    window.electronAPI = { __web: true, resource, agent, llm, guardian, mcp };
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 当前是否为 Docker / CLI Web 版的 bridge（非桌面） */
export function isWebBridge() {
  return typeof window !== 'undefined' && !!window.electronAPI?.__web;
}
