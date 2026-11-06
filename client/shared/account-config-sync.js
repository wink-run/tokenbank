// 跨终端账户配置：心跳上报可合并的账户快照（不含 Key），本机点「同步」时按 id 并入。
// 浏览器 ESM 副本：client/src/lib/account-config-sync.js（逻辑保持一致）
'use strict';

const SENSITIVE_KEYS = new Set([
  'token', 'credentials', 'api_key', 'password', 'secret', 'refresh_token', 'access_token',
]);

// 网关 provider 默认只带走地址等非凭证字段。模型在账户记录上，避免把整份目录打进心跳。
const GATEWAY_KEYS = ['id', 'base_url', 'api_format', 'type', 'tier', 'enabled', 'label', 'name', 'handler'];
// 设置页打开「同步账户密钥」后才附加这些字段
const SECRET_GATEWAY_KEYS = ['token', 'credentials', 'auth_type'];

// 离线超过此时长的设备快照不参与账户同步（避免重装/卸载残留把已删账户拉回来）
const STALE_DEVICE_MS = 7 * 24 * 60 * 60 * 1000;
// 墓碑保留时长；过期后不再阻止同 id 重新同步
const REMOVED_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function scrubValue(value) {
  if (Array.isArray(value)) return value.map(scrubValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k)) continue;
    out[k] = scrubValue(v);
  }
  return out;
}

function modelKey(m) {
  if (typeof m === 'string') return m.trim();
  if (m && typeof m === 'object') return String(m.name || m.id || m.model || '').trim();
  return '';
}

/** 模型列表按名称并集，本机已有项保留 */
function unionModels(localModels, remoteModels) {
  const out = Array.isArray(localModels) ? localModels.slice() : [];
  const seen = new Set(out.map(modelKey).filter(Boolean));
  let changed = false;
  for (const m of (Array.isArray(remoteModels) ? remoteModels : [])) {
    const k = modelKey(m);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(m);
    changed = true;
  }
  return { models: out, changed };
}

/** 合并后的行：密钥以本机为准，对方带来的删掉 */
function keepLocalSecrets(localList, mergedList) {
  const byId = new Map();
  for (const row of (Array.isArray(localList) ? localList : [])) {
    if (row && row.id) byId.set(row.id, row);
  }
  return (Array.isArray(mergedList) ? mergedList : []).map((row) => {
    if (!row || typeof row !== 'object') return row;
    const local = row.id ? byId.get(row.id) : null;
    const next = { ...row };
    for (const k of SENSITIVE_KEYS) {
      if (local && secretPresent(local[k])) next[k] = local[k];
      else delete next[k];
    }
    return next;
  });
}

function keepLocalDirectSecrets(localDirect, mergedDirect) {
  const local = localDirect && typeof localDirect === 'object' ? localDirect : {};
  const out = {};
  for (const [k, row] of Object.entries(mergedDirect || {})) {
    if (!row || typeof row !== 'object') { out[k] = row; continue; }
    const prev = local[k];
    const next = { ...row };
    for (const sk of SENSITIVE_KEYS) {
      if (prev && secretPresent(prev[sk])) next[sk] = prev[sk];
      else delete next[sk];
    }
    out[k] = next;
  }
  return out;
}

function secretPresent(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

/** 只补本机还没有的密钥，已有的不覆盖 */
function fillMissingSecrets(localRow, remoteRow) {
  const next = { ...localRow };
  let changed = false;
  for (const k of SENSITIVE_KEYS) {
    if (!secretPresent(next[k]) && secretPresent(remoteRow[k])) {
      next[k] = remoteRow[k];
      changed = true;
    }
  }
  // 补上了对方的登录凭证时，一并带上 auth_type（本机已有密钥则不改）
  if (changed && remoteRow.auth_type && !secretPresent(localRow.credentials) && secretPresent(next.credentials)) {
    next.auth_type = remoteRow.auth_type;
  } else if (changed && !localRow.auth_type && remoteRow.auth_type) {
    next.auth_type = remoteRow.auth_type;
  }
  return { row: next, changed };
}

/** 删除墓碑：id → 删除时间戳；丢掉过期项 */
function normalizeRemovedMap(raw, now = Date.now()) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, at] of Object.entries(raw)) {
    const key = String(id || '').trim();
    if (!key) continue;
    const ts = Number(at) || 0;
    if (!ts || now - ts > REMOVED_TTL_MS) continue;
    out[key] = ts;
  }
  return out;
}

/** 多份墓碑按较新时间合并 */
function mergeRemovedMaps(...maps) {
  const out = {};
  for (const m of maps) {
    for (const [id, at] of Object.entries(normalizeRemovedMap(m))) {
      if (!out[id] || at > out[id]) out[id] = at;
    }
  }
  return out;
}

/** 本机又重新加回的 id，从墓碑里清掉 */
function pruneRemovedAgainstPresent(removed, presentIds) {
  const out = normalizeRemovedMap(removed);
  for (const id of presentIds || []) {
    const key = String(id || '').trim();
    if (key && out[key] != null) delete out[key];
  }
  return out;
}

function presentAccountIds(accounts = {}) {
  const ids = [];
  for (const row of accounts.user_subscriptions || []) {
    if (row && row.id) ids.push(row.id);
  }
  for (const row of accounts.user_payg_providers || []) {
    if (row && row.id) ids.push(row.id);
  }
  return ids;
}

function presentDirectIds(accounts = {}) {
  return Object.keys(accounts.direct_source_billing || {}).filter(Boolean);
}

/** 记一次删除（订阅 / 按量账户 id） */
function noteRemovedAccountIds(prev, ids, at = Date.now()) {
  const out = normalizeRemovedMap(prev, at);
  for (const id of (Array.isArray(ids) ? ids : [ids])) {
    const key = String(id || '').trim();
    if (!key) continue;
    out[key] = at;
  }
  return out;
}

/** 记一次直连源删除 */
function noteRemovedDirectIds(prev, ids, at = Date.now()) {
  return noteRemovedAccountIds(prev, ids, at);
}

/** 是否有可供合并的账户载荷（空对象 {} 不算） */
function hasAccountsConfigPayload(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if ((cfg.user_subscriptions || []).length) return true;
  if ((cfg.user_payg_providers || []).length) return true;
  if (Object.keys(cfg.direct_source_billing || {}).length) return true;
  if ((cfg.gateway_providers || []).length) return true;
  if (Object.keys(cfg.provider_pricing_overrides || {}).length) return true;
  if (Object.keys(cfg.source_template_overrides || {}).length) return true;
  if (Object.keys(cfg.custom_source_templates || {}).length) return true;
  if (Object.keys(normalizeRemovedMap(cfg.removed_account_ids)).length) return true;
  if (Object.keys(normalizeRemovedMap(cfg.removed_direct_ids)).length) return true;
  // 仅有密钥开关也算有效上报（给其它终端对齐开关）
  if (Object.prototype.hasOwnProperty.call(cfg, 'sync_account_secrets')) return true;
  return false;
}

function parseLastSeenMs(lastSeen) {
  if (lastSeen == null || lastSeen === '') return 0;
  if (typeof lastSeen === 'number' && Number.isFinite(lastSeen)) return lastSeen;
  const ms = Date.parse(String(lastSeen));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * 挑选可参与同步的其他终端配置。
 * 优先只用在线设备；若都离线，则退回 7 天内见过面的设备。
 * 更老的离线残留不参与，避免把已删除的 test 等账户重新并进来。
 */
function selectRemoteAccountConfigs(devices = [], myId = '', opts = {}) {
  const now = Number(opts.now) || Date.now();
  const staleMs = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : STALE_DEVICE_MS;
  const others = (Array.isArray(devices) ? devices : []).filter((d) => (
    d && d.device_id && (!myId || d.device_id !== myId) && hasAccountsConfigPayload(d.accounts_config)
  ));
  const online = others.filter((d) => !!d.online);
  const pool = online.length
    ? online
    : others.filter((d) => {
      const seen = parseLastSeenMs(d.last_seen);
      return seen > 0 && (now - seen) <= staleMs;
    });
  return pool.map((d) => d.accounts_config);
}

/** 有账户 / 供给源可以合并。仅有「同步密钥」开关不算，避免空心跳占掉名额。 */
function hasSyncableAccounts(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if ((cfg.user_subscriptions || []).length) return true;
  if ((cfg.user_payg_providers || []).length) return true;
  if (Object.keys(cfg.direct_source_billing || {}).length) return true;
  if ((cfg.gateway_providers || []).length) return true;
  if (Object.keys(cfg.provider_pricing_overrides || {}).length) return true;
  if (Object.keys(cfg.source_template_overrides || {}).length) return true;
  if (Object.keys(cfg.custom_source_templates || {}).length) return true;
  return false;
}

function deviceSeenRecently(device, now, staleMs) {
  if (device && device.online) return true;
  const seen = parseLastSeenMs(device && device.last_seen);
  return seen > 0 && (now - seen) <= staleMs;
}

/**
 * 可让用户挑选的其他终端。
 * 在线和 7 天内见过的离线设备都保留，多台时由用户选一台，而不是只合并当前在线的那份。
 */
function selectSyncableDevices(devices = [], myId = '', opts = {}) {
  const now = Number(opts.now) || Date.now();
  const staleMs = Number(opts.staleMs) > 0 ? Number(opts.staleMs) : STALE_DEVICE_MS;
  const others = (Array.isArray(devices) ? devices : []).filter((d) => (
    d && d.device_id && (!myId || d.device_id !== myId)
    && hasSyncableAccounts(d.accounts_config)
    && deviceSeenRecently(d, now, staleMs)
  ));
  return others.slice().sort((a, b) => {
    const online = (b.online ? 1 : 0) - (a.online ? 1 : 0);
    if (online) return online;
    return parseLastSeenMs(b.last_seen) - parseLastSeenMs(a.last_seen);
  });
}

/** 账户行：同 id 保留本机，并补上对方多出来的模型；没有的 id 整行追加（墓碑 id 不追加） */
function mergeRows(localList, remoteList, countRef, includeSecrets, blockedIds) {
  const out = (Array.isArray(localList) ? localList : []).map(x => (
    x && typeof x === 'object' ? { ...x } : x
  ));
  const index = new Map();
  out.forEach((x, i) => { if (x && x.id) index.set(x.id, i); });
  for (const row of (Array.isArray(remoteList) ? remoteList : [])) {
    if (!row || !row.id) continue;
    const i = index.get(row.id);
    if (i == null) {
      // 本机或其它端已删除的 id，不再从残留快照复活
      if (blockedIds && blockedIds.has(row.id)) continue;
      out.push({ ...row });
      index.set(row.id, out.length - 1);
      countRef.n += 1;
      continue;
    }
    let next = out[i];
    let changed = false;
    const merged = unionModels(next.models, row.models);
    if (merged.changed) {
      next = { ...next, models: merged.models };
      changed = true;
    }
    if (includeSecrets) {
      const filled = fillMissingSecrets(next, row);
      if (filled.changed) {
        next = filled.row;
        changed = true;
      }
    }
    if (changed) {
      out[i] = next;
      countRef.n += 1;
    }
  }
  return out;
}

/** 直连计费：按 agent_id，本机已有则只补模型 */
function mergeDirect(local, remote, countRef, includeSecrets, blockedIds) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  for (const [k, v] of Object.entries(remote || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (!out[k]) {
      if (blockedIds && blockedIds.has(k)) continue;
      out[k] = { ...v };
      countRef.n += 1;
      continue;
    }
    let next = out[k];
    let changed = false;
    const merged = unionModels(next.models, v.models);
    if (merged.changed) {
      next = { ...next, models: merged.models };
      changed = true;
    }
    if (includeSecrets) {
      const filled = fillMissingSecrets(next, v);
      if (filled.changed) {
        next = filled.row;
        changed = true;
      }
    }
    if (changed) {
      out[k] = next;
      countRef.n += 1;
    }
  }
  return out;
}

/** 刊例价覆盖：本机已有的模型价不覆盖，只补缺失的 provider / 模型 */
function mergePricing(local, remote, countRef) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  for (const [pid, models] of Object.entries(remote || {})) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue;
    if (!out[pid]) {
      out[pid] = { ...models };
      countRef.n += 1;
      continue;
    }
    const per = { ...out[pid] };
    let added = false;
    for (const [mk, mv] of Object.entries(models)) {
      if (per[mk] == null) {
        per[mk] = mv;
        added = true;
      }
    }
    if (added) {
      out[pid] = per;
      countRef.n += 1;
    }
  }
  return out;
}

/** 字典：本机已有键不动，只补对方独有的键（模板覆盖 / 套餐） */
function mergeMissingKeys(local, remote, countRef) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  for (const [k, v] of Object.entries(remote || {})) {
    if (v == null || out[k] != null) continue;
    out[k] = v;
    countRef.n += 1;
  }
  return out;
}

/** 账户记录关联的网关 id（只上报这些源，不把无关供给源带上） */
function referencedGatewayIds(accounts = {}) {
  const ids = new Set();
  const add = (v) => { if (v) ids.add(v); };
  for (const p of accounts.user_payg_providers || []) {
    add(p && p.gateway_id);
    add(p && p.provider_id);
    add(p && p.id);
  }
  for (const s of accounts.user_subscriptions || []) {
    add(s && s.gateway_id);
    add(s && s.plan_provider_id);
    add(s && s.source_id);
  }
  return ids;
}

/**
 * 从本机账户快照抽出可上报的配置。
 * providers 为网关 agent config 里的供给源。默认去掉密钥；includeSecrets 为真时带上 token / credentials。
 * 不上传 subscription_plans：快照里那份是「默认目录 + 用户覆盖」的合并结果，写回去会把默认套餐落成用户配置。
 */
function buildAccountsConfig(accounts = {}, providers = [], opts = {}) {
  const includeSecrets = !!opts.includeSecrets;
  const copy = includeSecrets ? (v) => v : scrubValue;
  const gwKeys = includeSecrets ? GATEWAY_KEYS.concat(SECRET_GATEWAY_KEYS) : GATEWAY_KEYS;
  const wanted = referencedGatewayIds(accounts);
  const gateway = [];
  for (const p of (Array.isArray(providers) ? providers : [])) {
    if (!p || !p.id || p.type === 'p2p' || !wanted.has(p.id)) continue;
    const row = {};
    for (const k of gwKeys) {
      if (p[k] !== undefined && p[k] !== null) row[k] = copy(p[k]);
    }
    if (row.id) gateway.push(row);
  }
  // 本机仍挂着的账户，不再带对应墓碑
  const removedAccounts = pruneRemovedAgainstPresent(
    accounts.removed_account_ids,
    presentAccountIds(accounts),
  );
  const removedDirect = pruneRemovedAgainstPresent(
    accounts.removed_direct_ids,
    presentDirectIds(accounts),
  );
  return {
    user_subscriptions: copy(accounts.user_subscriptions || []),
    user_payg_providers: copy(accounts.user_payg_providers || []),
    provider_pricing_overrides: copy(accounts.provider_pricing_overrides || {}),
    direct_source_billing: copy(accounts.direct_source_billing || {}),
    source_template_overrides: copy(accounts.source_template_overrides || {}),
    custom_source_templates: copy(accounts.custom_source_templates || {}),
    gateway_providers: gateway,
    removed_account_ids: removedAccounts,
    removed_direct_ids: removedDirect,
    // 同一账户各终端共用：是否同步密钥，以及这次修改的时间（较新的为准）
    sync_account_secrets: !!opts.syncAccountSecrets,
    sync_account_secrets_at: Number(opts.syncAccountSecretsAt) || 0,
  };
}

/**
 * 把其他终端的 accounts_config 并入本机快照。
 * 同 id 以本机为准，只追加缺失账户并补齐模型；已删除（墓碑）的 id 不复活。
 * 返回 count 供界面提示。
 */
function mergeRemoteAccountConfigs(local = {}, remotes = [], opts = {}) {
  const includeSecrets = !!opts.includeSecrets;
  const countRef = { n: 0 };
  let subs = Array.isArray(local.user_subscriptions) ? local.user_subscriptions : [];
  let payg = Array.isArray(local.user_payg_providers) ? local.user_payg_providers : [];
  let pricing = local.provider_pricing_overrides || {};
  let direct = local.direct_source_billing || {};
  let tpl = local.source_template_overrides || {};
  let custom = local.custom_source_templates || {};
  const remoteList = Array.isArray(remotes) ? remotes : [];

  // 本机 + 各端墓碑并集：阻止已删账户从任一残留快照加回来
  let removedAccounts = normalizeRemovedMap(local.removed_account_ids);
  let removedDirect = normalizeRemovedMap(local.removed_direct_ids);
  for (const raw of remoteList) {
    if (!raw || typeof raw !== 'object') continue;
    removedAccounts = mergeRemovedMaps(removedAccounts, raw.removed_account_ids);
    removedDirect = mergeRemovedMaps(removedDirect, raw.removed_direct_ids);
  }
  const blockedAccountIds = new Set(Object.keys(removedAccounts));
  const blockedDirectIds = new Set(Object.keys(removedDirect));

  const gatewayLists = [];
  for (const raw of remoteList) {
    // 本机没开「同步账户密钥」时，即使对方上报了密钥也不写入
    const remote = !raw || typeof raw !== 'object' ? raw : (includeSecrets ? raw : scrubValue(raw));
    if (!remote || typeof remote !== 'object') continue;
    subs = mergeRows(subs, remote.user_subscriptions, countRef, includeSecrets, blockedAccountIds);
    payg = mergeRows(payg, remote.user_payg_providers, countRef, includeSecrets, blockedAccountIds);
    pricing = mergePricing(pricing, remote.provider_pricing_overrides, countRef);
    direct = mergeDirect(direct, remote.direct_source_billing, countRef, includeSecrets, blockedDirectIds);
    tpl = mergeMissingKeys(tpl, remote.source_template_overrides, countRef);
    custom = mergeMissingKeys(custom, remote.custom_source_templates, countRef);
    if (Array.isArray(remote.gateway_providers) && remote.gateway_providers.length) {
      gatewayLists.push(remote.gateway_providers);
    }
  }
  // 开关关闭时，合并结果里的密钥只保留本机原来就有的
  if (!includeSecrets) {
    subs = keepLocalSecrets(local.user_subscriptions, subs);
    payg = keepLocalSecrets(local.user_payg_providers, payg);
    direct = keepLocalDirectSecrets(local.direct_source_billing, direct);
  }

  // 只保留合并后账户真正引用的网关源，避免已删账户的残留 gateway 被加进来
  const wantedGw = referencedGatewayIds({ user_subscriptions: subs, user_payg_providers: payg });
  const filteredGatewayLists = gatewayLists
    .map((list) => (Array.isArray(list) ? list.filter((p) => p && p.id && wantedGw.has(p.id)) : []))
    .filter((list) => list.length);

  // 本机又挂上的账户清掉墓碑；其余墓碑继续上报，阻止其它端再推回来
  removedAccounts = pruneRemovedAgainstPresent(removedAccounts, presentAccountIds({
    user_subscriptions: subs,
    user_payg_providers: payg,
  }));
  removedDirect = pruneRemovedAgainstPresent(removedDirect, presentDirectIds({
    direct_source_billing: direct,
  }));

  return {
    user_subscriptions: subs,
    user_payg_providers: payg,
    provider_pricing_overrides: pricing,
    direct_source_billing: direct,
    source_template_overrides: tpl,
    custom_source_templates: custom,
    removed_account_ids: removedAccounts,
    removed_direct_ids: removedDirect,
    gateway_provider_lists: filteredGatewayLists,
    count: countRef.n,
    changed: countRef.n > 0,
  };
}

/**
 * 把其他终端的网关源（无凭证）补进本机 providers。
 * 已有源不改 token / 已填的 base_url，只在本地为空时补地址和模型。
 */
function mergeGatewayProviders(local = [], lists = [], opts = {}) {
  const includeSecrets = !!opts.includeSecrets;
  const allowedIds = opts.allowedIds instanceof Set ? opts.allowedIds : null;
  const out = (Array.isArray(local) ? local : []).map(p => ({ ...p }));
  const byId = new Map(out.filter(p => p && p.id).map(p => [p.id, p]));
  let changed = false;
  for (const list of (Array.isArray(lists) ? lists : [])) {
    for (const row of (Array.isArray(list) ? list : [])) {
      if (!row || !row.id || row.type === 'p2p') continue;
      if (allowedIds && !allowedIds.has(row.id)) continue;
      const cur = byId.get(row.id);
      if (!cur) {
        const added = {
          id: row.id,
          type: row.type || row.tier || 'paid',
          tier: row.tier || row.type || 'paid',
          // 从其他终端同步进来的源默认打开，不沿用对方的关闭状态
          enabled: true,
          token: includeSecrets && row.token ? row.token : '',
          credentials: includeSecrets && row.credentials ? row.credentials : null,
          auth_type: (includeSecrets && row.auth_type) || 'api_key',
          base_url: row.base_url || '',
          api_format: row.api_format || 'openai',
          models: Array.isArray(row.models) ? row.models : [],
          ...(row.label ? { label: row.label } : {}),
          ...(row.name ? { name: row.name } : {}),
          ...(row.handler ? { handler: row.handler } : {}),
        };
        out.push(added);
        byId.set(row.id, added);
        changed = true;
        continue;
      }
      let rowChanged = false;
      if (!cur.base_url && row.base_url) {
        cur.base_url = row.base_url;
        rowChanged = true;
      }
      if (includeSecrets) {
        const filled = fillMissingSecrets(cur, row);
        if (filled.changed) {
          Object.assign(cur, filled.row);
          rowChanged = true;
        }
      }
      if ((!cur.models || !cur.models.length) && Array.isArray(row.models) && row.models.length) {
        cur.models = row.models;
        rowChanged = true;
      }
      // 这次同步补过的源默认打开
      if (rowChanged && cur.enabled === false) {
        cur.enabled = true;
        rowChanged = true;
      }
      if (rowChanged) changed = true;
    }
  }
  return { providers: out, changed };
}

/**
 * 同一账户的「同步账户密钥」对齐。
 * 本机是关：保持关，不用其它终端更晚的「打开」把它打开（否则关着开关仍会写入密钥）。
 * 其它终端更晚的「关闭」会把本机打开的开关关掉。没有时间戳的旧上报不参与比较。
 */
function pickSyncAccountSecrets(local = {}, remotes = []) {
  let best = {
    value: !!local.value,
    at: Number(local.at) || 0,
  };
  for (const raw of (Array.isArray(remotes) ? remotes : [])) {
    if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'sync_account_secrets')) continue;
    const at = Number(raw.sync_account_secrets_at) || 0;
    if (!(at > best.at)) continue;
    // 本机没打开时，不接受其它终端把开关打开
    if (!best.value && raw.sync_account_secrets) continue;
    best = { value: !!raw.sync_account_secrets, at };
  }
  return best;
}

module.exports = {
  buildAccountsConfig,
  mergeRemoteAccountConfigs,
  mergeGatewayProviders,
  pickSyncAccountSecrets,
  scrubValue,
  hasAccountsConfigPayload,
  hasSyncableAccounts,
  selectRemoteAccountConfigs,
  selectSyncableDevices,
  noteRemovedAccountIds,
  noteRemovedDirectIds,
  mergeRemovedMaps,
  pruneRemovedAgainstPresent,
  normalizeRemovedMap,
  referencedGatewayIds,
  STALE_DEVICE_MS,
  REMOVED_TTL_MS,
};
