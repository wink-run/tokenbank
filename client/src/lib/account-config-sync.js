// 跨终端账户配置（浏览器 ESM）。逻辑与 shared/account-config-sync.js 保持一致。

const SENSITIVE_KEYS = new Set([
  'token', 'credentials', 'api_key', 'password', 'secret', 'refresh_token', 'access_token',
]);

const GATEWAY_KEYS = ['id', 'base_url', 'api_format', 'type', 'tier', 'enabled', 'label', 'name', 'handler'];
// 设置页打开「同步账户密钥」后才附加这些字段
const SECRET_GATEWAY_KEYS = ['token', 'credentials', 'auth_type'];

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

function mergeRows(localList, remoteList, countRef, includeSecrets) {
  const out = (Array.isArray(localList) ? localList : []).map(x => (
    x && typeof x === 'object' ? { ...x } : x
  ));
  const index = new Map();
  out.forEach((x, i) => { if (x && x.id) index.set(x.id, i); });
  for (const row of (Array.isArray(remoteList) ? remoteList : [])) {
    if (!row || !row.id) continue;
    const i = index.get(row.id);
    if (i == null) {
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

function mergeDirect(local, remote, countRef, includeSecrets) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  for (const [k, v] of Object.entries(remote || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (!out[k]) {
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

function mergeMissingKeys(local, remote, countRef) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  for (const [k, v] of Object.entries(remote || {})) {
    if (v == null || out[k] != null) continue;
    out[k] = v;
    countRef.n += 1;
  }
  return out;
}

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

/** 本机账户 + 关联网关源 → 心跳上报的账户配置。默认剔除凭证；includeSecrets 时带上密钥。 */
export function buildAccountsConfig(accounts = {}, providers = [], opts = {}) {
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
  return {
    user_subscriptions: copy(accounts.user_subscriptions || []),
    user_payg_providers: copy(accounts.user_payg_providers || []),
    provider_pricing_overrides: copy(accounts.provider_pricing_overrides || {}),
    direct_source_billing: copy(accounts.direct_source_billing || {}),
    source_template_overrides: copy(accounts.source_template_overrides || {}),
    custom_source_templates: copy(accounts.custom_source_templates || {}),
    gateway_providers: gateway,
    // 同一账户各终端共用：是否同步密钥，以及这次修改的时间（较新的为准）
    sync_account_secrets: !!opts.syncAccountSecrets,
    sync_account_secrets_at: Number(opts.syncAccountSecretsAt) || 0,
  };
}

/** 其他终端的 accounts_config 并入本机：同 id 保留本机，补缺失账户和模型 */
export function mergeRemoteAccountConfigs(local = {}, remotes = [], opts = {}) {
  const includeSecrets = !!opts.includeSecrets;
  const countRef = { n: 0 };
  let subs = Array.isArray(local.user_subscriptions) ? local.user_subscriptions : [];
  let payg = Array.isArray(local.user_payg_providers) ? local.user_payg_providers : [];
  let pricing = local.provider_pricing_overrides || {};
  let direct = local.direct_source_billing || {};
  let tpl = local.source_template_overrides || {};
  let custom = local.custom_source_templates || {};
  const gatewayLists = [];
  for (const raw of (Array.isArray(remotes) ? remotes : [])) {
    // 本机没开「同步账户密钥」时，即使对方上报了密钥也不写入
    const remote = !raw || typeof raw !== 'object' ? raw : (includeSecrets ? raw : scrubValue(raw));
    if (!remote || typeof remote !== 'object') continue;
    subs = mergeRows(subs, remote.user_subscriptions, countRef, includeSecrets);
    payg = mergeRows(payg, remote.user_payg_providers, countRef, includeSecrets);
    pricing = mergePricing(pricing, remote.provider_pricing_overrides, countRef);
    direct = mergeDirect(direct, remote.direct_source_billing, countRef, includeSecrets);
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
  return {
    user_subscriptions: subs,
    user_payg_providers: payg,
    provider_pricing_overrides: pricing,
    direct_source_billing: direct,
    source_template_overrides: tpl,
    custom_source_templates: custom,
    gateway_provider_lists: gatewayLists,
    count: countRef.n,
    changed: countRef.n > 0,
  };
}

/** 网关源补齐：不覆盖本机已有的 token 和 base_url */
export function mergeGatewayProviders(local = [], lists = [], opts = {}) {
  const includeSecrets = !!opts.includeSecrets;
  const out = (Array.isArray(local) ? local : []).map(p => ({ ...p }));
  const byId = new Map(out.filter(p => p && p.id).map(p => [p.id, p]));
  let changed = false;
  for (const list of (Array.isArray(lists) ? lists : [])) {
    for (const row of (Array.isArray(list) ? list : [])) {
      if (!row || !row.id || row.type === 'p2p') continue;
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
 * local / remote: { value, at }
 */
export function pickSyncAccountSecrets(local = {}, remotes = []) {
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
