// client/electron/agent-routes.js
// 智能体路由：和游乐场「聚合入口」同一套派发。一条路由 = 谁来派（主智能体）+ 派发规则 + 可以派给谁。
// 调用方把 harness_id 写成路由 id，网关以编排模式启动主智能体，主智能体照规则从名单里挑人派活。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_ID = 'agent-router-default';
const PREFIX = 'agent-router-';
// 能当主智能体的应用（和编排模式支持的一致）
const MAIN_AGENT_IDS = ['claude-code', 'codex', 'cursor', 'pi'];

function file() {
  return path.join(os.homedir(), '.tokenbank', 'agent-routes.json');
}

function defaultRoute() {
  return {
    id: DEFAULT_ID,
    name: '默认派发',
    builtin: true,
    mainAgentId: '',      // 空：跟游乐场设的主智能体，没有就挑第一个能编排的
    rules: [],            // 用户写的规则，按顺序；自带规则另外附在最后
    candidates: null,     // null：全部本机智能体（专业、通用、外部）
    allowHired: false,    // 雇来的社区智能体会扣积分，默认不进名单
    whenNone: 'self',     // 名单里都不合适：self 主智能体自己做 / error 报错
  };
}

function readAll() {
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(raw?.routes)) list = raw.routes;
  } catch { /* 还没有文件 */ }
  list = list.filter(r => r && typeof r.id === 'string' && r.id.startsWith(PREFIX)).map(normalize);
  if (!list.some(r => r.id === DEFAULT_ID)) list.unshift(defaultRoute());
  return list;
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ routes: list }, null, 2));
}

function normalize(r) {
  const base = r.id === DEFAULT_ID ? defaultRoute() : {};
  const rules = Array.isArray(r.rules) ? r.rules.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20) : [];
  const candidates = Array.isArray(r.candidates) ? [...new Set(r.candidates.map(String).filter(Boolean))] : null;
  return {
    ...base,
    id: r.id,
    name: String(r.name || base.name || r.id).trim().slice(0, 40),
    builtin: r.id === DEFAULT_ID,
    mainAgentId: MAIN_AGENT_IDS.includes(r.mainAgentId) ? r.mainAgentId : '',
    rules,
    candidates,
    allowHired: !!r.allowHired,
    whenNone: r.whenNone === 'error' ? 'error' : 'self',
    updatedAt: Number(r.updatedAt) || 0,
  };
}

function isRouteId(id) {
  return typeof id === 'string' && id.startsWith(PREFIX);
}

function list() { return readAll(); }

function get(id) {
  return readAll().find(r => r.id === id) || null;
}

/** 新建或修改；没有 id 时生成 agent-router-xxxxxx */
function save(input = {}) {
  const all = readAll();
  let id = String(input.id || '').trim();
  if (!id) {
    do { id = PREFIX + crypto.randomBytes(3).toString('hex'); } while (all.some(r => r.id === id));
  }
  if (!isRouteId(id)) throw new Error('路由 id 要以 agent-router- 开头');
  const next = normalize({ ...input, id, updatedAt: Date.now() });
  const i = all.findIndex(r => r.id === id);
  if (i >= 0) all[i] = next; else all.push(next);
  writeAll(all);
  return next;
}

function remove(id) {
  if (id === DEFAULT_ID) throw new Error('默认派发不能删，只能修改');
  const all = readAll();
  const next = all.filter(r => r.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}

/** 谁来派：路由指定的；没指定用 fallback（游乐场的主智能体）；都没有就挑第一个装好的能编排应用 */
function resolveMainAgent(route, launchableIds = new Set(), fallback = '') {
  const can = (id) => id && MAIN_AGENT_IDS.includes(id) && launchableIds.has(id);
  if (can(route?.mainAgentId)) return route.mainAgentId;
  if (can(fallback)) return fallback;
  return MAIN_AGENT_IDS.find(id => launchableIds.has(id)) || '';
}

function isCommunity(a) {
  return a?.type === 'community' || a?.community === true || String(a?.id || '').startsWith('community:');
}

/** 名单：路由里勾的；没勾就是全部本机智能体。雇来的只在打开开关时进。管家从来不进 */
function filterAgents(route, agents = []) {
  const pick = Array.isArray(route?.candidates) ? new Set(route.candidates) : null;
  return (agents || []).filter((a) => {
    if (!a || !a.id || a.guardian) return false;
    if (isCommunity(a)) return !!route?.allowHired && (!pick || pick.has(a.id));
    return !pick || pick.has(a.id);
  });
}

function canDispatchTo(route, agentId, agents = []) {
  return filterAgents(route, agents).some(a => a.id === agentId);
}

/** 给主智能体看的派发规则：用户的在前，自带的在后 */
function rulesText(route) {
  const own = (route?.rules || []).map((r, i) => `${i + 1}. ${r}`);
  const n = own.length;
  const builtin = [
    `${n + 1}. 名单里有对得上的专业智能体（assistant:*）就必须派它，不要自己做。`,
    `${n + 2}. 其次外部智能体（external:*）${route?.allowHired ? '和已雇佣的社区智能体（community:*，会扣积分）' : ''}。`,
    `${n + 3}. 最后才是通用应用（codex / claude-code / cursor 等）。`,
    `${n + 4}. 只能从 tb_list_agents 给的名单里选。` + (route?.whenNone === 'error'
      ? '名单里都不合适时，不要自己做，直接回复「没有合适的智能体」并说明原因。'
      : '名单里都不合适时，你自己完成。'),
  ];
  return [`【派发规则 · ${route?.name || '默认派发'}】`, ...own, ...builtin].join('\n');
}

module.exports = {
  DEFAULT_ID, PREFIX, MAIN_AGENT_IDS,
  isRouteId, list, get, save, remove,
  resolveMainAgent, filterAgents, canDispatchTo, rulesText,
  _internal: { file, normalize },
};
