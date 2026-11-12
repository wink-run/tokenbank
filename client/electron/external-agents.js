// client/electron/external-agents.js
// 外部智能体（Muse、GrokBot 等）：不在本机运行，装了 tokenbank-connect 技能后用配对码自己注册进来，
// 用户在网关页点「允许」后，它定时来网关取派给它的任务，做完把结果送回。
// 存在 ~/.tokenbank/external-agents.json；排队中的任务只在内存里（网关重启后外部智能体重新来取即可）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'external:';
const PAIR_TTL_MS = 10 * 60 * 1000;
const ONLINE_MS = 90 * 1000;          // 这么久内来取过任务算在线
const MAX_WAIT_MS = 25 * 1000;        // 取任务的长轮询最多等这么久
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

const queue = new Map();      // agentId → [{ id, prompt, createdAt }]
const waiting = new Map();    // taskId → { resolve, timer, agentId }
const pollers = new Map();    // agentId → [resolve] 正在长轮询的取任务请求

function file() { return path.join(os.homedir(), '.tokenbank', 'external-agents.json'); }

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { pairing: d.pairing || null, agents: Array.isArray(d.agents) ? d.agents : [] };
  } catch { return { pairing: null, agents: [] }; }
}

function write(d) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2), { mode: 0o600 });
}

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

function slug(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || crypto.randomBytes(3).toString('hex');
}

/** 网关页展示用：不带 token */
function publicView(a, now = Date.now()) {
  return {
    id: a.id,
    name: a.name,
    description: a.description || '',
    status: a.status,
    createdAt: a.createdAt,
    lastSeenAt: a.lastSeenAt || 0,
    online: a.status === 'active' && !!a.lastSeenAt && now - a.lastSeenAt < ONLINE_MS,
    queued: (queue.get(a.id) || []).length,
    pairingCode: a.status === 'pending' ? a.pairingCode : undefined,
  };
}

function list() { return read().agents.map(a => publicView(a)); }

function get(id) {
  const a = read().agents.find(x => x.id === id);
  return a ? publicView(a) : null;
}

/** 给外部智能体的一次性配对码：10 分钟有效，用一次就作废 */
function newPairingCode(now = Date.now()) {
  const d = read();
  const code = `TB-${String(crypto.randomInt(0, 10000)).padStart(4, '0')}`;
  d.pairing = { code, expiresAt: now + PAIR_TTL_MS };
  write(d);
  return { code, expiresAt: d.pairing.expiresAt };
}

function currentPairing(now = Date.now()) {
  const p = read().pairing;
  return p && p.expiresAt > now ? p : null;
}

/** 外部智能体用配对码注册：先是「等你允许」，用户允许后才收任务 */
function register({ code, name, description } = {}, now = Date.now()) {
  const d = read();
  const p = d.pairing;
  if (!p || p.expiresAt <= now || String(code || '').trim().toUpperCase() !== p.code) {
    const err = new Error('配对码不对或已过期：请在 Token Bank 网关页「接入外部智能体」里拿一个新的');
    err.status = 401;
    throw err;
  }
  const cleanName = String(name || '').trim().slice(0, 40);
  if (!cleanName) { const err = new Error('缺少 name'); err.status = 400; throw err; }
  let id = PREFIX + slug(cleanName);
  while (d.agents.some(a => a.id === id)) id = `${PREFIX}${slug(cleanName)}-${crypto.randomBytes(2).toString('hex')}`;
  const token = `tbx_${crypto.randomBytes(24).toString('hex')}`;
  d.agents.push({
    id, name: cleanName,
    description: String(description || '').trim().slice(0, 300),
    status: 'pending', pairingCode: p.code,
    tokenHash: hashToken(token), createdAt: now, lastSeenAt: 0,
  });
  d.pairing = null;   // 用过即作废
  write(d);
  return { agent_id: id, token, status: 'pending' };
}

function setStatus(id, status) {
  const d = read();
  const a = d.agents.find(x => x.id === id);
  if (!a) return null;
  a.status = status;
  if (status !== 'pending') delete a.pairingCode;
  write(d);
  if (status !== 'active') failQueued(id, status === 'disabled' ? '外部智能体已停用' : '外部智能体不可用');
  return publicView(a);
}

function approve(id) { return setStatus(id, 'active'); }
function disable(id) { return setStatus(id, 'disabled'); }
function enable(id) { return setStatus(id, 'active'); }

function remove(id) {
  const d = read();
  const next = d.agents.filter(a => a.id !== id);
  if (next.length === d.agents.length) return false;
  d.agents = next;
  write(d);
  failQueued(id, '外部智能体已移除');
  return true;
}

/** 用 token 认出是哪个外部智能体；顺带记下「最近来过」 */
function authenticate(token, now = Date.now()) {
  if (!token) return null;
  const h = hashToken(token);
  const d = read();
  const a = d.agents.find(x => x.tokenHash === h);
  if (!a) return null;
  a.lastSeenAt = now;
  write(d);
  return a;
}

function failQueued(id, error) {
  for (const t of queue.get(id) || []) finish(t.id, { ok: false, error });
  queue.delete(id);
}

function finish(taskId, result) {
  const w = waiting.get(taskId);
  if (!w) return false;
  clearTimeout(w.timer);
  waiting.delete(taskId);
  w.resolve(result);
  return true;
}

/** 派给外部智能体：排进它的队列，等它取走并回传；超时算失败 */
function dispatch(agentId, prompt, { timeoutMs = DEFAULT_TASK_TIMEOUT_MS, taskId } = {}) {
  const a = read().agents.find(x => x.id === agentId);
  if (!a) return Promise.resolve({ ok: false, error: `没有这个外部智能体：${agentId}` });
  if (a.status !== 'active') {
    return Promise.resolve({ ok: false, error: a.status === 'pending' ? '还没允许这个外部智能体接任务' : '外部智能体已停用' });
  }
  const id = taskId || `ext_${crypto.randomBytes(8).toString('hex')}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const q = queue.get(agentId) || [];
      queue.set(agentId, q.filter(t => t.id !== id));
      finish(id, { ok: false, error: '外部智能体没有在限定时间内完成（它可能离线了）' });
    }, timeoutMs);
    waiting.set(id, { resolve, timer, agentId });
    const task = { id, prompt: String(prompt || ''), createdAt: Date.now() };
    const pending = pollers.get(agentId);
    if (pending && pending.length) {
      pending.shift()(task);   // 正在等的取任务请求直接拿走
    } else {
      const q = queue.get(agentId) || [];
      q.push(task);
      queue.set(agentId, q);
    }
  });
}

/** 外部智能体来取任务：有就立刻给，没有就最多等 waitMs */
function pull(agentId, waitMs = MAX_WAIT_MS) {
  const q = queue.get(agentId) || [];
  if (q.length) return Promise.resolve(q.shift());
  const wait = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0));
  if (!wait) return Promise.resolve(null);
  return new Promise((resolve) => {
    const list = pollers.get(agentId) || [];
    let done = false;
    const hand = (task) => { if (!done) { done = true; resolve(task); } };
    list.push(hand);
    pollers.set(agentId, list);
    setTimeout(() => {
      const cur = pollers.get(agentId) || [];
      pollers.set(agentId, cur.filter(f => f !== hand));
      hand(null);
    }, wait);
  });
}

/** 外部智能体回传结果 */
function complete(agentId, taskId, { output, error } = {}) {
  const w = waiting.get(taskId);
  if (!w || w.agentId !== agentId) return false;
  return finish(taskId, error ? { ok: false, error: String(error).slice(0, 2000), output: String(output || '') } : { ok: true, output: String(output || '') });
}

/** 执行器的智能体列表里用：只列允许接任务的 */
function listForAgents() {
  return list().filter(a => a.status === 'active').map(a => ({
    id: a.id, name: a.name, type: 'external', description: a.description, online: a.online, installed: true, status: 'active',
  }));
}

function isExternalId(id) { return typeof id === 'string' && id.startsWith(PREFIX); }

module.exports = {
  PREFIX, isExternalId,
  list, get, listForAgents,
  newPairingCode, currentPairing, register,
  approve, disable, enable, remove,
  authenticate, dispatch, pull, complete,
  _internal: { file, queue, waiting, pollers, ONLINE_MS },
};
