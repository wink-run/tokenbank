// client/electron/guardian/device-sync.js
// 多设备差异：每台设备在心跳里上报一份资产清单（类型、名字、来源、内容摘要，不含正文），
// 这里取回同账号其它设备的清单对比：别的设备有、这台没有的，从社区目录或 GitHub 来的可以一键装上（可撤销）；
// 自己写的只能提醒（正文不上传）。Docker 实例也算一台设备。
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const guardian = require('./index');

const SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const STALE_DEVICE_MS = 30 * 24 * 60 * 60 * 1000;
const TYPES = new Set(['skill', 'prompt', 'assistant']);

let cache = { at: 0, assets: null };

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

function sourceOf(r) {
  const url = String(r.source_url || '');
  if (url.startsWith('catalog:')) return url;
  if (r.metadata?.github_source) return `github:${r.metadata.github_source}`;
  return 'local';
}

/** 本机资产清单（10 分钟内复用） */
function snapshot({ fresh = false } = {}) {
  if (!fresh && cache.assets && Date.now() - cache.at < SNAPSHOT_TTL_MS) return cache.assets;
  let list = [];
  try {
    list = rm().listResources({})
      .filter(r => TYPES.has(r.type) && !(r.metadata && r.metadata.builtin) && r.source !== 'builtin')
      .slice(0, 500)
      .map(r => ({
        t: r.type, n: r.name, d: r.display_name || '',
        h: crypto.createHash('sha1').update(String(r.content || '')).digest('hex').slice(0, 12),
        s: sourceOf(r), v: String(r.metadata?.version || ''),
      }));
  } catch { /* 资产库不可用 */ }
  cache = { at: Date.now(), assets: list };
  return list;
}

function cloudAuth() {
  try {
    const { readLocalConfig } = require('../../shared/config-loader');
    const lc = readLocalConfig() || {};
    const jwt = lc.user_session?.jwt || null;
    const { defaultServerUrlFromEnv, normalizeServerBase } = require('../../shared/default-server-url');
    const url = normalizeServerBase(lc.cloud_config?.url || '') || defaultServerUrlFromEnv();
    return jwt && url ? { jwt, url } : null;
  } catch { return null; }
}

function selfDeviceIds() {
  const ids = new Set();
  try {
    const { readDeviceId } = require('../../shared/device-id');
    for (const k of ['desktop', 'cli']) { const id = readDeviceId(k); if (id) ids.add(id); }
  } catch { /* ignore */ }
  try {
    const id = require('../../shared/config-loader').readAgentConfig()?.device_id;
    if (id) ids.add(id);
  } catch { /* ignore */ }
  return ids;
}

function getJson(url, token) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ status: 0 }); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
      method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 15000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { let body = null; try { body = JSON.parse(buf); } catch { /* ignore */ } resolve({ status: res.statusCode, body }); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

const typeLabel = { skill: '技能', prompt: '提示词', assistant: '智能体' };

function describe(items) {
  const names = items.slice(0, 4).map(a => a.d || a.n).join('、');
  return items.length > 4 ? `${names} 等 ${items.length} 个` : names;
}

/** 对比：devices 为服务端 /user/devices/assets 的返回 */
function diff(devices, mine, selfIds, now = Date.now()) {
  const key = (a) => `${a.t}|${a.n}`;
  const mineMap = new Map(mine.map(a => [key(a), a]));
  const out = [];
  for (const d of devices || []) {
    if (!d || selfIds.has(d.id) || !d.assets_reported) continue;
    const seen = d.last_seen ? Date.parse(String(d.last_seen).replace(' ', 'T') + (/[zZ+]/.test(String(d.last_seen)) ? '' : 'Z')) : now;
    if (Number.isFinite(seen) && now - seen > STALE_DEVICE_MS) continue;
    const missing = [];
    const changed = [];
    for (const a of d.assets || []) {
      const m = mineMap.get(key(a));
      if (!m) missing.push(a);
      else if (a.h && m.h && a.h !== m.h && (!a.v || !m.v || a.v !== m.v)) changed.push({ theirs: a, mine: m });
    }
    if (missing.length || changed.length) out.push({ device: d, missing, changed });
  }
  return out;
}

async function check() {
  if (guardian.modeOf('community') === 'off') return { ok: true, skipped: true };
  const auth = cloudAuth();
  if (!auth) return { ok: true, skipped: true, reason: 'not-logged-in' };
  const r = await getJson(`${auth.url}/user/devices/assets`, auth.jwt);
  if (r.status !== 200 || !Array.isArray(r.body?.devices)) return { ok: true, skipped: true, reason: `server-${r.status}` };
  const mine = snapshot({ fresh: true });
  const result = diff(r.body.devices, mine, selfDeviceIds());
  const seenSigs = new Set();
  for (const { device, missing, changed } of result) {
    const who = device.name || device.id;
    if (missing.length) {
      const syncable = missing.filter(a => a.s.startsWith('catalog:') || a.s.startsWith('github:'));
      const local = missing.filter(a => !syncable.includes(a));
      const sig = `device-missing|${device.id}`;
      seenSigs.add(sig);
      guardian.record({
        category: 'community', kind: 'device-missing', status: syncable.length ? 'suggested' : 'info', countAsRepeat: false,
        title: `「${who}」上有 ${missing.length} 个${missing.every(a => a.t === missing[0].t) ? typeLabel[missing[0].t] || '资产' : '资产'}这台没有：${describe(missing)}`,
        advice: syncable.length
          ? `其中 ${syncable.length} 个来自社区或 GitHub，可以一键装到这台${local.length ? `；另外 ${local.length} 个是在那台上自己写的，需要在那台分享或手动拷过来` : ''}。`
          : '这些是在那台设备上自己写的，正文不会上传；可以在那台分享到社区，或手动拷过来。',
        signature: sig,
        ...(syncable.length ? {
          apply: { type: 'syncFromDevice', data: { items: syncable.map(a => ({ t: a.t, n: a.n, s: a.s })), device: who } },
        } : {}),
        meta: { deviceId: device.id, missing: missing.map(a => a.n), syncable: syncable.length },
      });
    } else {
      guardian.resolveSignature(`device-missing|${device.id}`);
    }
    if (changed.length) {
      const sig = `device-changed|${device.id}`;
      seenSigs.add(sig);
      guardian.record({
        category: 'community', kind: 'device-changed', status: 'info', countAsRepeat: false,
        title: `和「${who}」有 ${changed.length} 个同名资产内容不一样：${describe(changed.map(c => c.mine))}`,
        advice: '两台各改过一份。确认哪份是对的，在另一台更新或重新安装。',
        signature: sig,
        meta: { deviceId: device.id, changed: changed.map(c => c.mine.n) },
      });
    } else {
      guardian.resolveSignature(`device-changed|${device.id}`);
    }
  }
  return { ok: true, devices: (r.body.devices || []).length, differing: result.length };
}

/** 采纳：把别的设备上来自社区 / GitHub 的资产装到这台；撤销 = 删掉这次装上的 */
async function syncFromDevice({ items = [] }) {
  const m = rm();
  const created = [];
  const failed = [];
  for (const it of items) {
    if (m.listResources({ type: it.t }).some(r => r.name === it.n)) continue;
    try {
      let res = null;
      if (it.s.startsWith('catalog:')) res = m.installFromCatalog(it.s.slice('catalog:'.length));
      else if (it.s.startsWith('github:')) res = await m.installGithubSkill(it.s.slice('github:'.length));
      if (res && res.success !== false && res.resource?.id) created.push(res.resource.id);
      else failed.push(it.n);
    } catch (e) {
      failed.push(`${it.n}（${e.message}）`);
    }
  }
  cache.assets = null;
  if (!created.length) return { ok: false, error: failed.length ? `没装上：${failed.join('、')}` : '这些已经在这台上了' };
  guardian.record({
    category: 'community', kind: 'device-synced', status: 'done',
    title: `已从其它设备同步 ${created.length} 个资产到这台`,
    detail: failed.length ? `没装上：${failed.join('、')}` : undefined,
    undo: { type: 'removeSynced', data: { ids: created } },
  });
  return { ok: true, created: created.length, failed };
}

function removeSynced({ ids = [] }) {
  const m = rm();
  for (const id of ids) {
    try { m.deleteResource(id, {}); } catch { /* 已经删了 */ }
  }
  cache.assets = null;
  return { ok: true };
}

let reporterHooked = false;
function register() {
  guardian.registerAction('syncFromDevice', syncFromDevice);
  guardian.registerAction('removeSynced', removeSynced);
  guardian.registerCheck('device-sync', check, 6 * 60 * 60 * 1000);
  // CLI / Docker：心跳由 shared/device-reporter 发，带上资产清单（桌面版由渲染进程的心跳带）
  if (!reporterHooked) {
    reporterHooked = true;
    try { require('../../shared/device-reporter').setInventoryExtra?.(() => ({ assets: snapshot() })); } catch { /* ignore */ }
  }
}

module.exports = { register, check, snapshot, diff, syncFromDevice, removeSynced, _internal: { cloudAuth, selfDeviceIds } };
