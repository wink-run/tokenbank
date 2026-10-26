'use strict';

/**
 * 场景路由与服务端目录合并（含同步删除）。
 *
 * 服务端目录是系统路由的唯一来源：非用户自建、且本次目录里没有的，一律删掉
 * （含旧版本地内置的 strategy-* / route-*，不再因为「没打 from_server」而留下）。
 * 用户自建 / 本地改过的路由（user_owned）→ 不删、不被服务端覆盖。
 */

/** 客户端「新建路由」形态（供测试/诊断） */
function isLocalUserRoute(r) {
  const id = String(r?.id || '');
  const mk = String(r?.model_key || '');
  return /^[0-9a-f]{8}$/i.test(id) && /^llm-router-[0-9a-f]{6}$/i.test(mk);
}

function isUserOwned(r) {
  if (!r) return false;
  if (r.user_owned) return true;
  // 兼容升级前已自建、尚未打标的路由
  return isLocalUserRoute(r) && !r.from_server;
}

/**
 * @param {object[]} local 本地 scene_routes
 * @param {object[]} serverRoutes 服务端 scene_routes
 * @param {{ prevSyncedIds?: string[], now?: string }} [opts]
 * @returns {{ routes, addedRoutes, removedRoutes, syncedIds, removedDefaultIds }}
 */
function mergeSceneRoutesReplace(local, serverRoutes, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const list = Array.isArray(local) ? local : [];
  const server = (Array.isArray(serverRoutes) ? serverRoutes : []).filter(r => r && r.id);
  const serverIds = new Set(server.map(r => r.id));

  const addedRoutes = [];
  const removedRoutes = [];
  const removedDefaultIds = [];
  const byId = new Map();

  for (const r of list) {
    if (!r?.id) continue;
    // 用户配置永不因同步删除
    if (isUserOwned(r)) {
      byId.set(r.id, r);
      continue;
    }
    // 目录里没有的系统路由删掉（旧版内置路由同样删，只留用户自建）
    if (!serverIds.has(r.id)) {
      removedRoutes.push(r.scene_name || r.model_key || r.id);
      removedDefaultIds.push(r.id);
      continue;
    }
    byId.set(r.id, r);
  }

  for (const r of server) {
    const existing = byId.get(r.id);
    // 用户配置优先：不覆盖、不标 from_server
    if (existing && isUserOwned(existing)) continue;

    // 系统下发（含 strategy-*）：整对象替换，名称/步骤等以服务端为准，清掉本地残留字段
    if (existing) {
      const created_at = existing.created_at || r.created_at || now;
      byId.set(r.id, { ...r, from_server: true, created_at });
    } else {
      byId.set(r.id, { ...r, from_server: true, created_at: r.created_at || now });
      addedRoutes.push(r.scene_name || r.model_key || r.id);
    }
  }

  return {
    routes: [...byId.values()],
    addedRoutes,
    removedRoutes,
    syncedIds: [...serverIds],
    removedDefaultIds,
  };
}

module.exports = { isLocalUserRoute, isUserOwned, mergeSceneRoutesReplace };
