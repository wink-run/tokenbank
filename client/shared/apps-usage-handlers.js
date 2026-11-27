// apps-usage-handlers.js — 应用用量明细 / 统计（Electron IPC 与 Docker admin-api 共用）
'use strict';

const configLoader = require('../electron/config-loader');
const sessionBrowser = require('../electron/session-browser');
const { syncSessionTelemetry } = require('../electron/session-telemetry-sync');

let _lastSessionTelemetrySync = 0;
const SESSION_TELEMETRY_SYNC_MS = 20_000;

function buildAgentDataSource() {
  const m = {};
  try {
    for (const s of (configLoader.sessionSources() || [])) {
      if (s && s.agent_id && s.data_source) m[s.agent_id] = s.data_source;
    }
  } catch {}
  return m;
}

const AGENT_DATA_SOURCE = buildAgentDataSource();

/** 应用关联的全部会话 data_source（须启用 session_usage_import） */
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

/** @deprecated 用 resolveAppDataSources */
function appSessionDataSource(app) {
  const ds = resolveAppDataSources(app);
  return ds[0] || null;
}

function maybeSyncSessionTelemetry(localStats) {
  const now = Date.now();
  if (now - _lastSessionTelemetrySync < SESSION_TELEMETRY_SYNC_MS) return;
  _lastSessionTelemetrySync = now;
  try { syncSessionTelemetry(localStats); } catch {}
}

/** 单个应用用量明细（与 Electron apps:detail 一致） */
function getAppDetail(localStats, app, days) {
  maybeSyncSessionTelemetry(localStats);
  const aid = app?.agent_id || app?.preset_id;
  const ent = configLoader.appEntityById(aid);
  const caps = configLoader.appCapabilities(aid);
  const usageImport = !!(caps?.session_usage_import ?? ent?.session_usage_import ?? app?.session_usage_import);
  const sessionTrace = !!(caps?.session_trace ?? ent?.session_trace ?? app?.session_trace);
  const detail = localStats.queryAppDetail({
    appId: app && app.id,
    apiKey: app && app.api_key,
    dataSources: resolveAppDataSources(app),
    days: days || 30,
    includeSessionImport: usageImport,
  });
  const activityAgentId = app?.activity_agent_id || ent?.activity_agent_id || app?.trace_agent_id || app?.agent_id;
  if (sessionTrace && ent) {
    const scanned = sessionBrowser.listActivityForEntity(ent, {
      limit: 50,
      sinceDays: days || 30,
    });
    if (scanned.length) {
      detail.activity = sessionBrowser.mergeActivityWithStats(
        scanned,
        usageImport ? detail.sessions : [],
      ).map(a => sessionBrowser.normalizeActivityRow(a, activityAgentId));
    }
    if (detail.recent?.length) {
      detail.recent = sessionBrowser.enrichRecentDetail(activityAgentId, detail.recent, detail.activity);
    }
  }
  detail.hasModelStats = configLoader.agentHasModelStats(
    app?.activity_agent_id || app?.agent_id || app?.preset_id,
  );
  // 派到我其他设备上跑的任务：会话文件在那台设备上，这里用同步回来的步骤列出来，也能看 Trace
  try { detail.meshActivity = require('../electron/mesh-task-trace').listActivity([aid, activityAgentId], days || 30); } catch { detail.meshActivity = []; }
  return detail;
}

/** 批量查应用今日统计（与 Electron apps:stats 一致） */
function getAppStats(localStats, appList) {
  try { syncSessionTelemetry(localStats); } catch {}
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
    } else if ((app.link_method === 'shim' || app.link_method === 'direct') && app.agent_id) {
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
}

/** Session trace（与 Electron apps:sessionTrace 一致） */
function getSessionTrace(localStats, agent_id, session_id) {
  if (!agent_id || !session_id) return { error: 'missing_params', steps: [] };
  // 跨设备执行的任务：用同步回来的步骤拼 Trace
  try {
    const meshTrace = require('../electron/mesh-task-trace');
    if (meshTrace.isMeshSession(session_id)) return meshTrace.getTrace(session_id);
  } catch { /* 没有就照常 */ }
  const ent = configLoader.appEntityById(agent_id);
  const trace = ent
    ? sessionBrowser.getTraceForEntity(ent, session_id)
    : sessionBrowser.getTrace(agent_id, session_id);
  const hookOnly = !!(ent?.integrations?.editor_hook);
  const dbRow = localStats.querySessionDetail(session_id, { hookOnly });
  return sessionBrowser.enrichTraceWithDb(trace, dbRow);
}

function getHandoffTargets() {
  try { return configLoader.handoffTargets(); } catch { return []; }
}

module.exports = {
  getAppDetail,
  getAppStats,
  getSessionTrace,
  getHandoffTargets,
  appSessionDataSource,
  resolveAppDataSources,
  maybeSyncSessionTelemetry,
};
