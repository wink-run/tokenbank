// client/electron/guardian/asset-checks.js
// 资产体检（离线、纯规则，定期 + 立即检查）：质量、安全、重复、新版本。
// 只给建议：改内容（更新版本、补全描述）都要用户点，点了也能撤销。
// 结论另存一份按资产索引的标记（asset-flags.json），资产列表据此显示小标签，不改资产本身。
'use strict';

const http = require('http');
const guardian = require('./index');
const store = require('./store');
const checks = require('./skill-checks');

const DUP_THRESHOLD = 0.8;
const DUP_MIN_SHINGLES = 25;

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

function authorityDir(resource) {
  try { return require('../resource-canonical').resolveAuthorityDir(resource); } catch { return null; }
}

function judgment() {
  return require('./judgment');
}

function label(r) {
  return r.display_name || r.name;
}

/** 投射到了哪些应用（不含 Token Bank 自己的内部目标） */
function projectedApps(r) {
  let internal = new Set();
  try { internal = require('./diagnose').INTERNAL_TARGETS; } catch { /* ignore */ }
  return [...new Set((r.projections || []).map(p => p.agentId).filter(id => id && !internal.has(id)))];
}

/** 最近 30 天各技能被调用的次数（自动停用重复技能时，留下用得多的那个） */
function useCounts() {
  try {
    const d = require('../local-stats').getDb();
    const rows = d.prepare('SELECT LOWER(skill_key) AS k, COUNT(*) AS n FROM skill_calls WHERE ts >= ? GROUP BY LOWER(skill_key)').all(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return new Map(rows.map(r => [r.k, r.n]));
  } catch { return new Map(); }
}

function findingsKey(findings) {
  return (findings || []).filter(x => x.level === 'high').map(x => `${x.code}|${x.file}|${x.line}`).sort().join(';');
}

/** 用户点过「信任它」的高风险技能：内容（命中的位置）不变就不再提醒，也不再在投射前拦 */
function isTrusted(resourceId, findings) {
  const t = store.readJson('trusted-skills.json', {});
  return !!t[resourceId] && t[resourceId].key === findingsKey(findings);
}

function getFlags() {
  return store.readJson('asset-flags.json', {});
}

/** 比较 a.b.c 版本号：a > b 返回正数 */
function cmpVersion(a, b) {
  const pa = String(a || '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function catalogIdOf(resource) {
  const url = String(resource.source_url || '');
  if (url.startsWith('catalog:')) return url.slice('catalog:'.length);
  return resource.metadata?.catalogId || null;
}

async function check() {
  const mode = guardian.modeOf('assets');
  if (mode === 'off') return { ok: true, skipped: true };
  const m = rm();
  const skills = m.listResources({ type: 'skill' }).filter(r => !(r.metadata && r.metadata.builtin));
  const flags = {};
  const qualityNeeds = [];
  let risky = 0;
  const bodies = [];

  for (const r of skills) {
    const files = checks.readSkillFiles(authorityDir(r));
    const f = {};
    // 原文件整个不见了：投射自愈那边会处理（撤下坏链接），这里不再重复提醒「描述要完善」
    const q = files.length ? checks.qualityCheck(r, files) : [];
    const worst = q.some(x => x.level === 'warn') ? 'warn' : (q.length ? 'info' : null);
    if (worst) { f.quality = worst; f.qualityCodes = q.map(x => x.code); }
    const qFacts = { resourceName: r.name, codes: q.map(x => x.code).join(','), descriptionLength: String(r.description || '').length };
    if (worst === 'warn' && !judgment().judge('asset-quality', qFacts)) qualityNeeds.push({ name: label(r), id: r.id, fixable: q.some(x => x.fix && x.fix.type === 'completeDescription'), facts: qFacts });

    const sec = checks.securityScan(files);
    if (sec.risk !== 'none') f.security = sec.risk;
    const secSig = `asset-security|${r.id}`;
    // 高风险只打标签；启用到应用的那一刻会当场确认一次（securityGate），事后不再提醒
    if (sec.risk === 'high') risky++;

    const md = files.find(x => /^skill\.md$/i.test(x.rel));
    if (md) bodies.push({ r, sh: checks.shingles(md.text) });
    if (Object.keys(f).length) flags[r.id] = f;
  }

  // 质量：只给资产列表打小标签（详情里的「诊断」可以手动补全描述），不单独提醒、不自动改内容

  // 重复：内容高度相似的两两成对给建议
  let dups = 0;
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      if (a.sh.size < DUP_MIN_SHINGLES || b.sh.size < DUP_MIN_SHINGLES) continue;
      const sim = checks.jaccard(a.sh, b.sh);
      if (sim < DUP_THRESHOLD) continue;
      dups++;
      (flags[a.r.id] = flags[a.r.id] || {}).duplicateOf = [...((flags[a.r.id] || {}).duplicateOf || []), b.r.id];
      (flags[b.r.id] = flags[b.r.id] || {}).duplicateOf = [...((flags[b.r.id] || {}).duplicateOf || []), a.r.id];
    }
  }

  // 新版本：从社区目录安装的资产，对比已同步目录里的版本
  let updates = 0;
  let getCatalogItem = null;
  try { getCatalogItem = require('../resource-catalog').getCatalogItem; } catch { /* ignore */ }
  for (const r of m.listResources({})) {
    const cid = catalogIdOf(r);
    if (!cid || !getCatalogItem || (r.metadata && r.metadata.builtin)) continue;
    let item = null;
    try { item = getCatalogItem(cid); } catch { /* ignore */ }
    const latest = item?.metadata?.version;
    const current = r.metadata?.version;
    if (!item || !latest || !current || cmpVersion(latest, current) <= 0) continue;
    updates++;
    (flags[r.id] = flags[r.id] || {}).updateAvailable = { from: current, to: latest, catalogId: cid };
  }

  store.writeJson('asset-flags.json', flags);
  return { ok: true, skills: skills.length, quality: qualityNeeds.length, risky, duplicates: dups, updates };
}

// ── 用户点了之后才执行的动作 ───────────────────────────────────────────────

/**
 * 改技能内容：除了数据库，还要写回磁盘上的 SKILL.md（应用读的是磁盘）。
 * resource-manager.saveResource 对已有技能只登记路径、不回写原文，这里显式同步。
 */
function saveSkillContent(m, data) {
  const res = m.saveResource(data);
  if (res && res.success === false) return res;
  const saved = m.getResource(data.id);
  if (saved && saved.type === 'skill') m._persistSkillAuthority(saved.id, saved, { syncContent: true });
  return res;
}

function snapshot(r) {
  return {
    id: r.id, type: r.type, name: r.name, display_name: r.display_name,
    description: r.description, content: r.content, metadata: r.metadata || {},
  };
}

/** 更新为社区目录里的新版本；撤销数据 = 更新前的完整快照 */
function updateFromCatalog({ resourceId, catalogId }) {
  const m = rm();
  const r = m.getResource(resourceId);
  const item = require('../resource-catalog').getCatalogItem(catalogId);
  if (!r || !item) return { ok: false, error: '资产或社区条目不存在' };
  const before = snapshot(r);
  const res = saveSkillContent(m, {
    ...before,
    description: item.description || before.description,
    content: item.content != null ? item.content : before.content,
    metadata: { ...before.metadata, ...(item.metadata || {}), version: item.metadata?.version || before.metadata.version },
  });
  if (res && res.success === false) return { ok: false, error: res.error };
  guardian.record({
    category: 'assets', kind: 'asset-updated', status: 'done',
    title: `已把「${label(r)}」更新到 ${item.metadata?.version || '新版本'}`,
    undo: { type: 'restoreSnapshot', data: { snapshot: before } },
    meta: { resourceId },
  });
  return { ok: true };
}

function restoreSnapshot({ snapshot: snap }) {
  if (!snap || !snap.id) return { ok: false, error: 'no-snapshot' };
  const res = saveSkillContent(rm(), snap);
  return res && res.success === false ? { ok: false, error: res.error } : { ok: true };
}

/** 请本机网关的模型为技能写 description（用户点击才调用） */
function askDescription(name, body) {
  let reverse = '127.0.0.1:11430';
  try { reverse = require('../config-loader').gatewayCtx().reverse || reverse; } catch { /* 默认端口 */ }
  const [host, port] = String(reverse).split(':');
  const prompt = [
    '为下面这个 AI 编程助手的技能（SKILL.md）写一句 description，用于让助手判断「什么时候该用这个技能」。',
    '要求：中文或与原文同语言；60~160 字；先说它做什么，再说在什么场景下使用；只输出这一句，不要引号和前缀。',
    `技能名：${name}`,
    '正文：',
    String(body || '').slice(0, 6000),
  ].join('\n');
  const payload = JSON.stringify({ model: 'auto', temperature: 0.2, max_tokens: 300, messages: [{ role: 'user', content: prompt }] });
  return new Promise((resolve) => {
    const req = http.request({
      host: host || '127.0.0.1', port: Number(port) || 11430, path: '/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-TokenBank-Guardian': '1', Authorization: 'Bearer tb-guardian' },
      timeout: 60000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const text = String(JSON.parse(buf)?.choices?.[0]?.message?.content || '').trim().replace(/^["'「]|["'」]$/g, '');
          resolve(res.statusCode < 400 && text ? text.split('\n')[0].slice(0, 400) : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(payload);
  });
}

/** 补全 / 改写 description：写回 SKILL.md 头部；可撤销 */
async function completeDescription({ resourceId, quiet = false }) {
  const m = rm();
  const r = m.getResource(resourceId);
  if (!r || r.type !== 'skill') return { ok: false, error: '只支持技能' };
  const files = checks.readSkillFiles(authorityDir(r));
  const md = files.find(x => /^skill\.md$/i.test(x.rel));
  const text = md ? md.text : (r.content || '');
  const body = text.replace(/^\s*---[\s\S]*?\n---\s*/, '');
  const desc = await askDescription(r.name, body);
  if (!desc) return { ok: false, error: '没能生成描述：需要先在「模型」页接入一个可用的模型' };
  const esc = desc.replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
  let next;
  if (/^\s*---\s*\n[\s\S]*?\n---/.test(text)) {
    next = text.replace(/^(\s*---\s*\n)([\s\S]*?)(\n---)/, (all, a, head, c) => {
      const lines = head.split('\n').filter(l => !/^description\s*:/.test(l));
      if (!lines.some(l => /^name\s*:/.test(l))) lines.unshift(`name: ${r.name}`);
      return `${a}${[...lines, `description: "${esc}"`].join('\n')}${c}`;
    });
  } else {
    next = `---\nname: ${r.name}\ndescription: "${esc}"\n---\n\n${text}`;
  }
  const before = snapshot(r);
  const res = saveSkillContent(m, { ...before, description: desc, content: next });
  if (res && res.success === false) return { ok: false, error: res.error };
  if (quiet) return { ok: true, description: desc, snapshot: before };
  guardian.record({
    category: 'assets', kind: 'asset-description', status: 'done',
    title: `已为「${label(r)}」补全描述`,
    detail: desc,
    undo: { type: 'restoreSnapshot', data: { snapshot: before } },
    meta: { resourceId },
  });
  return { ok: true, description: desc };
}

// 提示词短于这个长度，多半只有一句话，模型很难照着做好
const SIMPLE_PROMPT_CHARS = 60;

function isSimplePrompt(r) {
  return !!r && r.type === 'prompt' && String(r.content || '').trim().length > 0
    && String(r.content || '').trim().length < SIMPLE_PROMPT_CHARS;
}

/** 改写增强：请本机网关的模型把过于简单的提示词写完整；原版存进记录，可撤销 */
async function enhancePrompt({ resourceId }) {
  const m = rm();
  const r = m.getResource(resourceId);
  if (!r || r.type !== 'prompt') return { ok: false, error: '只支持提示词' };
  const original = String(r.content || '').trim();
  if (!original) return { ok: false, error: '提示词是空的' };
  const res = await require('./model-call').chat({
    temperature: 0.3, maxTokens: 800, timeoutMs: 60000,
    messages: [{ role: 'user', content: [
      '把下面这条过于简单的提示词改写成一条完整、可直接使用的提示词：写清角色、要做的事、输入是什么、输出格式和注意事项。',
      '保持原来的意图和语言，不要扩展成别的任务；可以用 {{变量}} 表示需要用户填的内容。只输出改写后的提示词本身。',
      `原提示词：${original.slice(0, 2000)}`,
    ].join('\n') }],
  });
  const next = String(res.text || '').trim().replace(/^```[a-z]*\n?|```$/g, '').trim();
  if (!res.ok || next.length <= original.length) return { ok: false, error: '没能生成增强版：需要先在「模型」页接入一个可用的模型' };
  const before = snapshot(r);
  const saved = m.saveResource({ ...before, content: next });
  if (saved && saved.success === false) return { ok: false, error: saved.error };
  guardian.record({
    category: 'assets', kind: 'prompt-enhanced', status: 'done',
    title: `已增强提示词「${label(r)}」`,
    detail: `原版：${original}`,
    undo: { type: 'restoreSnapshot', data: { snapshot: before } },
    meta: { resourceId },
  });
  return { ok: true, content: next };
}

/** 投射前的安全确认：高风险技能需要用户明确同意（用户信任过、内容没变的放行） */
function securityGate(resource) {
  if (!resource || resource.type !== 'skill') return null;
  if (guardian.modeOf('assets') === 'off') return null;
  const sec = checks.securityScan(checks.readSkillFiles(authorityDir(resource)));
  return sec.risk === 'high' && !isTrusted(resource.id, sec.findings) ? sec : null;
}

// ── 记录上就地处理的动作 ─────────────────────────────────────────────────

/** 停用 = 从所有应用撤下（资产保留）；撤销 = 重新启用到原来那些应用 */
function disableSkill({ resourceId }) {
  const m = rm();
  const r = m.getResource(resourceId);
  if (!r) return { ok: false, error: '资产不存在' };
  const apps = projectedApps(r);
  if (!apps.length) return { ok: true, message: '它已经没有启用到任何应用' };
  for (const id of apps) { try { m.unproject({ resourceId, agentId: id }); } catch { /* 已撤下 */ } }
  return { ok: true, message: `已从 ${apps.length} 个应用撤下，资产还在`, undo: { type: 'commandProject', data: { resourceId, agentIds: apps } } };
}

function trustSkill({ resourceId }) {
  const r = rm().getResource(resourceId);
  if (!r) return { ok: false, error: '资产不存在' };
  const sec = checks.securityScan(checks.readSkillFiles(authorityDir(r)));
  const t = store.readJson('trusted-skills.json', {});
  t[resourceId] = { key: findingsKey(sec.findings), at: Date.now() };
  store.writeJson('trusted-skills.json', t);
  return { ok: true, message: '以后不再提醒；它的内容变了会重新检查' };
}

function untrustSkill({ resourceId }) {
  const t = store.readJson('trusted-skills.json', {});
  delete t[resourceId];
  store.writeJson('trusted-skills.json', t);
  return { ok: true };
}

function register() {
  guardian.registerAction('updateFromCatalog', updateFromCatalog);
  guardian.registerAction('restoreSnapshot', restoreSnapshot);
  // 老版本「一键补全」的撤销：恢复那一批快照
  guardian.registerAction('restoreSnapshots', ({ snapshots = [] }) => {
    const errs = snapshots.map(snap => restoreSnapshot({ snapshot: snap })).filter(r => !r.ok);
    return errs.length ? { ok: false, error: errs[0].error } : { ok: true };
  });
  guardian.registerAction('disableSkill', disableSkill);
  guardian.registerAction('trustSkill', trustSkill);
  guardian.registerAction('untrustSkill', untrustSkill);
  guardian.registerCheck('assets', check);
}

module.exports = { register, check, getFlags, updateFromCatalog, completeDescription, enhancePrompt, isSimplePrompt, securityGate, cmpVersion };
