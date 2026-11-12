// client/electron/external-agents.js
// 外部智能体（Muse、GrokBot 等）：不在本机运行，装了 tokenbank-connect 技能后用配对码自己注册进来，
// 用户在网关页点「允许」后，它定时来网关取派给它的任务，做完把结果送回。
// 智能体存在 ~/.tokenbank/external-agents.json；派给它们的任务存在 external-tasks.json，
// 应用重启后排队的任务照样等它来取，取走还没回的结果照样收（结果交给 setResultHandler 登记的处理）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'external:';
const PAIR_TTL_MS = 10 * 60 * 1000;
const ONLINE_MS = 90 * 1000;          // 最短的在线判断时长
const MIN_INTERVAL_MS = 25 * 1000;    // 心跳间隔至少按这么长算
const MAX_INTERVAL_MS = 6 * 3600 * 1000;
const GRACE_MS = 30 * 1000;
const MAX_WAIT_MS = 25 * 1000;        // 取任务的长轮询最多等这么久
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000;

const queue = new Map();      // agentId → [{ id, prompt, createdAt }]
const waiting = new Map();    // taskId → { resolve, timer, agentId }
const pollers = new Map();    // agentId → [resolve] 正在长轮询的取任务请求

function file() { return path.join(os.homedir(), '.tokenbank', 'external-agents.json'); }
function tasksFile() { return path.join(os.homedir(), '.tokenbank', 'external-tasks.json'); }

// ── 派出去的任务落盘：{ id, agentId, prompt, createdAt, deadline, takenAt } ──
let resultHandler = null;   // (taskId, result) => void：没有人在等时（比如应用重启过）交给它记下
let pushHandler = null;     // (agentId, taskId, text) => boolean：任务结束后它主动推来的消息（比如它自己的定时任务）
let restored = false;
const deadlineTimers = new Map();

function readTasks() {
  try { const d = JSON.parse(fs.readFileSync(tasksFile(), 'utf8')); return Array.isArray(d.tasks) ? d.tasks : []; }
  catch { return []; }
}
function writeTasks(tasks) {
  fs.mkdirSync(path.dirname(tasksFile()), { recursive: true });
  fs.writeFileSync(tasksFile(), JSON.stringify({ tasks }, null, 2), { mode: 0o600 });
}
function saveTask(t) { writeTasks([...readTasks().filter(x => x.id !== t.id), t]); }
function dropTask(id) {
  const all = readTasks();
  const hit = all.find(x => x.id === id);
  if (hit) writeTasks(all.filter(x => x.id !== id));
  const tm = deadlineTimers.get(id);
  if (tm) { clearTimeout(tm); deadlineTimers.delete(id); }
  return hit || null;
}
function markTaken(id, now = Date.now()) {
  const all = readTasks();
  const t = all.find(x => x.id === id);
  if (t) { t.takenAt = now; writeTasks(all); }
}
function armDeadline(t) {
  const ms = Math.max(0, (t.deadline || 0) - Date.now());
  const tm = setTimeout(() => {
    deadlineTimers.delete(t.id);
    const q = queue.get(t.agentId) || [];
    queue.set(t.agentId, q.filter(x => x.id !== t.id));
    finish(t.id, { ok: false, error: '外部智能体没有在限定时间内完成（它可能离线了）' });
  }, ms);
  if (tm.unref) tm.unref();
  deadlineTimers.set(t.id, tm);
}

/** 应用启动后：把上次没做完的任务接回来（排队的重新排队，已取走的继续等结果） */
function restore() {
  if (restored) return;
  restored = true;
  for (const t of readTasks()) {
    if (!t.takenAt && !(queue.get(t.agentId) || []).some(x => x.id === t.id)) {
      const q = queue.get(t.agentId) || [];
      q.push({ id: t.id, prompt: t.prompt, createdAt: t.createdAt });
      queue.set(t.agentId, q);
    }
    if (!deadlineTimers.has(t.id)) armDeadline(t);
  }
}

function setResultHandler(fn) { resultHandler = typeof fn === 'function' ? fn : null; restore(); }
function setPushHandler(fn) { pushHandler = typeof fn === 'function' ? fn : null; }

/** 外部智能体就之前接过的任务再推一条消息（定时发的、后续进展）；不限次数，存进任务记录 */
function push(agentId, taskId, { output } = {}) {
  const text = String(output || '').trim();
  if (!text || !pushHandler) return false;
  try { return !!pushHandler(agentId, taskId, text.slice(0, 20000)); } catch { return false; }
}

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
/** 心跳间隔：智能体自己报的优先，否则按最近几次来取的间隔取中位数 */
function intervalOf(a) {
  const declared = Number(a.declaredIntervalMs) || 0;
  let ms = declared;
  if (!ms && Array.isArray(a.gaps) && a.gaps.length) {
    const g = [...a.gaps].sort((x, y) => x - y);
    ms = g[Math.floor(g.length / 2)];
  }
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms || 0));
}

/** 两次心跳都没来才算离线；正在长轮询等任务的算在线 */
function isOnline(a, now = Date.now()) {
  if (a.status !== 'active' || !a.lastSeenAt) return false;
  if ((pollers.get(a.id) || []).length) return true;
  return now - a.lastSeenAt <= Math.max(ONLINE_MS, 2 * intervalOf(a) + GRACE_MS);
}

function publicView(a, now = Date.now()) {
  return {
    id: a.id,
    name: a.name,
    description: a.description || '',
    status: a.status,
    createdAt: a.createdAt,
    lastSeenAt: a.lastSeenAt || 0,
    online: isOnline(a, now),
    intervalMs: a.lastSeenAt ? intervalOf(a) : 0,
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

/** 用 token 认出是哪个外部智能体；顺带记下「最近来过」。
 *  heartbeat：这次是来取任务，记下和上次的间隔；intervalSec：它自己报的心跳间隔 */
function authenticate(token, now = Date.now(), { heartbeat = false, intervalSec = 0 } = {}) {
  if (!token) return null;
  const h = hashToken(token);
  const d = read();
  const a = d.agents.find(x => x.tokenHash === h);
  if (!a) return null;
  if (heartbeat) {
    if (a.lastPollAt) {
      const gap = now - a.lastPollAt;
      if (gap > 1000 && gap < MAX_INTERVAL_MS) a.gaps = [...(a.gaps || []), gap].slice(-5);
    }
    a.lastPollAt = now;
    const iv = Number(intervalSec) || 0;
    if (iv > 0) a.declaredIntervalMs = Math.min(MAX_INTERVAL_MS, iv * 1000);
  }
  a.lastSeenAt = now;
  write(d);
  return a;
}

function failQueued(id, error) {
  for (const t of queue.get(id) || []) finish(t.id, { ok: false, error });
  queue.delete(id);
  // 已取走的也一起结束
  for (const t of readTasks()) if (t.agentId === id) finish(t.id, { ok: false, error });
}

function finish(taskId, result) {
  const rec = dropTask(taskId);
  const w = waiting.get(taskId);
  if (w) {
    waiting.delete(taskId);
    w.resolve(result);
    return true;
  }
  // 没人在等（应用重启过）：交给执行器记到任务里
  if (rec && resultHandler) {
    try { resultHandler(taskId, result, rec.agentId); } catch { /* 记不下也不影响外部智能体 */ }
    return true;
  }
  return !!rec;
}

/** 派给外部智能体：排进它的队列，等它取走并回传；超时算失败 */
function dispatch(agentId, prompt, { timeoutMs = DEFAULT_TASK_TIMEOUT_MS, taskId } = {}) {
  const a = read().agents.find(x => x.id === agentId);
  if (!a) return Promise.resolve({ ok: false, error: `没有这个外部智能体：${agentId}` });
  if (a.status !== 'active') {
    return Promise.resolve({ ok: false, error: a.status === 'pending' ? '还没允许这个外部智能体接任务' : '外部智能体已停用' });
  }
  restore();
  const id = taskId || `ext_${crypto.randomBytes(8).toString('hex')}`;
  return new Promise((resolve) => {
    const task = { id, prompt: String(prompt || ''), createdAt: Date.now() };
    const rec = { id, agentId, prompt: task.prompt, createdAt: task.createdAt, deadline: task.createdAt + timeoutMs, takenAt: 0 };
    saveTask(rec);
    armDeadline(rec);
    waiting.set(id, { resolve, agentId });
    const pending = pollers.get(agentId);
    if (pending && pending.length) {
      markTaken(id);
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
  restore();
  const q = queue.get(agentId) || [];
  if (q.length) { const t = q.shift(); markTaken(t.id); return Promise.resolve(t); }
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
  restore();
  const w = waiting.get(taskId);
  const rec = readTasks().find(x => x.id === taskId);
  // 任务已经结束：再送来的结果当作一条推送
  if (w ? w.agentId !== agentId : (!rec || rec.agentId !== agentId)) return push(agentId, taskId, { output: output || error });
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
  setResultHandler, setPushHandler, push, restore, isOnline,
  _internal: { file, tasksFile, queue, waiting, pollers, ONLINE_MS, reset() { restored = false; resultHandler = null; pushHandler = null; for (const t of deadlineTimers.values()) clearTimeout(t); deadlineTimers.clear(); } },
};
