// 跨终端账户配置：心跳上报可合并的账户快照（不含 Key），本机点「同步」时按 id 并入。
// 浏览器 ESM 副本：client/src/lib/account-config-sync.js（逻辑保持一致）
'use strict';

const SENSITIVE_KEYS = new Set([
  'token', 'credentials', 'api_key', 'password', 'secret', 'refresh_token', 'access_token',
]);

// 网关 provider 只带走地址等非凭证字段。模型在账户记录上，避免把整份目录打进心跳。
const GATEWAY_KEYS = ['id', 'base_url', 'api_format', 'type', 'tier', 'enabled', 'label', 'name', 'handler'];

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

/** 账户行：同 id 保留本机，并补上对方多出来的模型；没有的 id 整行追加 */
function mergeRows(localList, remoteList, countRef) {
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
    const merged = unionModels(out[i].models, row.models);
    if (merged.changed) {
      out[i] = { ...out[i], models: merged.models };
      countRef.n += 1;
    }
  }
  return out;
}

/** 直连计费：按 agent_id，本机已有则只补模型 */
function mergeDirect(local, remote, countRef) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  for (const [k, v] of Object.entries(remote || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (!out[k]) {
      out[k] = { ...v };
      countRef.n += 1;
      continue;
    }
    const merged = unionModels(out[k].models, v.models);
    if (merged.changed) {
      out[k] = { ...out[k], models: merged.models };
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
 * providers 为网关 agent config 里的供给源，只带非凭证字段。
 * 不上传 subscription_plans：快照里那份是「默认目录 + 用户覆盖」的合并结果，写回去会把默认套餐落成用户配置。
 */
function buildAccountsConfig(accounts = {}, providers = []) {
  const wanted = referencedGatewayIds(accounts);
  const gateway = [];
  for (const p of (Array.isArray(providers) ? providers : [])) {
    if (!p || !p.id || p.type === 'p2p' || !wanted.has(p.id)) continue;
    const row = {};
    for (const k of GATEWAY_KEYS) {
      if (p[k] !== undefined && p[k] !== null) row[k] = scrubValue(p[k]);
    }
    if (row.id) gateway.push(row);
  }
  return {
    user_subscriptions: scrubValue(accounts.user_subscriptions || []),
    user_payg_providers: scrubValue(accounts.user_payg_providers || []),
    provider_pricing_overrides: scrubValue(accounts.provider_pricing_overrides || {}),
    direct_source_billing: scrubValue(accounts.direct_source_billing || {}),
    source_template_overrides: scrubValue(accounts.source_template_overrides || {}),
    custom_source_templates: scrubValue(accounts.custom_source_templates || {}),
    gateway_providers: gateway,
  };
}

/**
 * 把其他终端的 accounts_config 并入本机快照。
 * 同 id 以本机为准，只追加缺失账户并补齐模型；返回 count 供界面提示。
 */
function mergeRemoteAccountConfigs(local = {}, remotes = []) {
  const countRef = { n: 0 };
  let subs = Array.isArray(local.user_subscriptions) ? local.user_subscriptions : [];
  let payg = Array.isArray(local.user_payg_providers) ? local.user_payg_providers : [];
  let pricing = local.provider_pricing_overrides || {};
  let direct = local.direct_source_billing || {};
  let tpl = local.source_template_overrides || {};
  let custom = local.custom_source_templates || {};
  const gatewayLists = [];
  for (const remote of (Array.isArray(remotes) ? remotes : [])) {
    if (!remote || typeof remote !== 'object') continue;
    subs = mergeRows(subs, remote.user_subscriptions, countRef);
    payg = mergeRows(payg, remote.user_payg_providers, countRef);
    pricing = mergePricing(pricing, remote.provider_pricing_overrides, countRef);
    direct = mergeDirect(direct, remote.direct_source_billing, countRef);
    tpl = mergeMissingKeys(tpl, remote.source_template_overrides, countRef);
    custom = mergeMissingKeys(custom, remote.custom_source_templates, countRef);
    if (Array.isArray(remote.gateway_providers) && remote.gateway_providers.length) {
      gatewayLists.push(remote.gateway_providers);
    }
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

/**
 * 把其他终端的网关源（无凭证）补进本机 providers。
 * 已有源不改 token / 已填的 base_url，只在本地为空时补地址和模型。
 */
function mergeGatewayProviders(local = [], lists = []) {
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
          enabled: row.enabled !== false,
          token: '',
          credentials: null,
          auth_type: 'api_key',
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
      if (!cur.base_url && row.base_url) {
        cur.base_url = row.base_url;
        changed = true;
      }
      if ((!cur.models || !cur.models.length) && Array.isArray(row.models) && row.models.length) {
        cur.models = row.models;
        changed = true;
      }
    }
  }
  return { providers: out, changed };
}

module.exports = {
  buildAccountsConfig,
  mergeRemoteAccountConfigs,
  mergeGatewayProviders,
  scrubValue,
};
