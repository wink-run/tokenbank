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
const DEFAULT_PULL_SEC = 300;         // 轮询的默认频率：每 5 分钟来取一次
const MIN_PULL_SEC = 60;
const MAX_PULL_SEC = 6 * 3600;
const WEBHOOK_DEBOUNCE_MS = 1500;                    // 一下子派好几个：合成一次唤醒
const WEBHOOK_RETRY_MS = [15000, 60000, 300000];     // 发不出去时再试三次；任务被取走就不再发
const WEBHOOK_TIMEOUT_MS = 10000;
// Webhook 通的时候轮询只是兜底：至少 15 分钟一次（任务默认 30 分钟超时，Webhook 坏了也来得及取走）
const WEBHOOK_FALLBACK_PULL_SEC = 15 * 60;

const queue = new Map();      // agentId → [{ id, prompt, createdAt }]
const waiting = new Map();    // taskId → { resolve, timer, agentId }
const pollers = new Map();    // agentId → [resolve] 正在长轮询的取任务请求
const wakeTimers = new Map(); // agentId → 等着发的 Webhook 唤醒

function file() { return path.join(os.homedir(), '.tokenbank', 'external-agents.json'); }
function tasksFile() { return path.join(os.homedir(), '.tokenbank', 'external-tasks.json'); }

// ── 派出去的任务落盘：{ id, agentId, prompt, createdAt, deadline, takenAt } ──
let resultHandler = null;   // (taskId, result) => void：没有人在等时（比如应用重启过）交给它记下
let takenHandler = null;    // (taskId, agentId) => void：它把任务取走了
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
  if (t && takenHandler) { try { takenHandler(id, t.agentId); } catch { /* 只是通知 */ } }
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
  // 重启前还排着队的：配了 Webhook 的叫醒它来取
  for (const [agentId, q] of queue) if (q.length) wake(agentId);
}

function setResultHandler(fn) { resultHandler = typeof fn === 'function' ? fn : null; restore(); }
function setPushHandler(fn) { pushHandler = typeof fn === 'function' ? fn : null; }
function setTakenHandler(fn) { takenHandler = typeof fn === 'function' ? fn : null; }

/** 外部智能体就之前接过的任务再推一条消息（定时发的、后续进展）；不限次数，存进任务记录 */
function push(agentId, taskId, opts = {}) { return pushDetailed(agentId, taskId, opts).ok; }

/** 推送并说明结果：{ ok, reason? }；每次都记下来，网关页能看到它推了多少、最近一次有没有被拒 */
function pushDetailed(agentId, taskId, { output } = {}) {
  const text = String(output || '').trim();
  let res;
  if (!text) res = { ok: false, reason: 'empty', message: '推送内容是空的' };
  else if (!pushHandler) res = { ok: false, reason: 'not_ready', message: 'Token Bank 还没准备好，稍后再推' };
  else {
    let r;
    try { r = pushHandler(agentId, taskId, text.slice(0, 20000)); } catch (e) { r = String(e.message || 'error'); }
    if (r === true) res = { ok: true };
    else if (r === 'not_yours') res = { ok: false, reason: 'not_yours', message: '这个任务不是派给你的（你可能重新配对过，换了身份）' };
    else res = { ok: false, reason: 'task_not_found', message: '没有这个任务：task_id 不对' };
  }
  recordPush(agentId, taskId, res);
  return res;
}

function recordPush(agentId, taskId, res, now = Date.now()) {
  try {
    const d = read();
    const a = d.agents.find(x => x.id === agentId);
    if (!a) return;
    if (res.ok) {
      a.pushOk = (a.pushOk || 0) + 1;
      a.lastPushAt = now;
    } else {
      a.lastPushError = { at: now, taskId: String(taskId || '').slice(0, 80), reason: res.reason, message: res.message };
    }
    write(d);
  } catch { /* 只是记录 */ }
}

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const out = { pairing: d.pairing || null, agents: Array.isArray(d.agents) ? d.agents : [], removed: Array.isArray(d.removed) ? d.removed : [] };
    // 拉取频率写在文件顶层，读的时候要带上，否则设完再读仍是默认 3 分钟
    if (d.pullIntervalSec != null) out.pullIntervalSec = d.pullIntervalSec;
    return out;
  } catch { return { pairing: null, agents: [], removed: [] }; }
}

function write(d) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2), { mode: 0o600 });
}

/** tokenbank-connect 技能：版本号就是内容的哈希，改了技能就自动变；外部智能体发现版本不同会重新下载 */
function skillInfo() {
  const raw = fs.readFileSync(path.join(__dirname, 'skills', 'tokenbank-connect', 'SKILL.md'), 'utf8');
  const version = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8);
  const text = raw.replace(/^(---\r?\nname: [^\n]*\n)/, `$1version: ${version}\n`);
  return { version, text };
}

function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

function slug(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || crypto.randomBytes(3).toString('hex');
}

/** 网关页展示用：不带 token */
/** 用户在网关页设的拉取频率（秒）。没设过就是 5 分钟。 */
function pullIntervalSec() {
  const n = Number(read().pullIntervalSec);
  if (n >= MIN_PULL_SEC && n <= MAX_PULL_SEC) return Math.round(n);
  return DEFAULT_PULL_SEC;
}

function setPullInterval(seconds) {
  const d = read();
  const n = Math.round(Number(seconds));
  // 不到 1 分钟或超过 6 小时：不记，界面仍显示默认的 5 分钟
  if (!(n >= MIN_PULL_SEC && n <= MAX_PULL_SEC)) {
    delete d.pullIntervalSec;
    write(d);
    return DEFAULT_PULL_SEC;
  }
  d.pullIntervalSec = n;
  write(d);
  return n;
}

/** 心跳间隔：用户设过的频率优先，否则用它自己报的，再否则按最近几次来取的间隔 */
/** Webhook 设了、最近一次没失败：网关会主动叫醒它 */
function webhookHealthy(a) {
  const w = a && a.webhook;
  if (!w || !w.url) return false;
  return !(w.lastError && (!w.lastOkAt || w.lastError.at > w.lastOkAt));
}

/** 告诉这个外部智能体多久来取一次：Webhook 通的时候放长到兜底频率，不通时用网关页设的 */
function pullIntervalFor(a) {
  const base = pullIntervalSec();
  return webhookHealthy(a) ? Math.max(base, WEBHOOK_FALLBACK_PULL_SEC) : base;
}

function intervalOf(a) {
  const configured = Number(read().pullIntervalSec);
  let ms = configured >= MIN_PULL_SEC ? pullIntervalFor(a) * 1000 : (webhookHealthy(a) ? WEBHOOK_FALLBACK_PULL_SEC * 1000 : 0);
  if (!ms) {
    ms = Number(a.declaredIntervalMs) || 0;
    if (!ms && Array.isArray(a.gaps) && a.gaps.length) {
      const g = [...a.gaps].sort((x, y) => x - y);
      ms = g[Math.floor(g.length / 2)];
    }
  }
  if (!ms) ms = DEFAULT_PULL_SEC * 1000;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms));
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
    skillVersion: a.skillVersion || '',
    pushOk: a.pushOk || 0,
    lastPushAt: a.lastPushAt || 0,
    // 最近一次推送被拒、且之后没有成功过：网关页标红
    lastPushError: a.lastPushError && (!a.lastPushAt || a.lastPushError.at > a.lastPushAt) ? a.lastPushError : null,
    webhook: webhookView(a),
    // 它要用 Webhook、但地址和密钥得你来填，还没填
    webhookWanted: !!a.webhookWanted && !(a.webhook && a.webhook.url),
    pollIntervalSec: pullIntervalFor(a),
    // 它报的技能版本和当前不一样：说明它还在用旧说明（没报过的不算）
    skillOutdated: !!a.skillVersion && (() => { try { return a.skillVersion !== skillInfo().version; } catch { return false; } })(),
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
function register({ code, name, description, webhook } = {}, now = Date.now()) {
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
  const out = { agent_id: id, token, status: 'pending' };
  // 用 Webhook 但自己拿不到地址：记下来，网关页引导用户填；填好之前它先轮询
  if (webhook && typeof webhook === 'object' && webhook.manual && !webhook.url) {
    setWebhook(id, { manual: true, fromAgent: true });
    out.webhook = null;
    out.webhook_waiting_user = true;
  }
  // 注册时顺带交了 Webhook：自动存下并发一条测试，用户不用再配；格式不对也不影响注册，照常轮询
  if (webhook && typeof webhook === 'object' && webhook.url) {
    try { out.webhook = setWebhook(id, { url: webhook.url, secret: webhook.secret, fromAgent: true }); }
    catch (e) { out.webhook = null; out.webhook_error = e.message; }
  }
  return out;
}

/** 正在长轮询的取任务请求立刻收到状态变化（停用、移除），不用等到超时 */
function notifyPollers(id, status) {
  const list = pollers.get(id) || [];
  pollers.delete(id);
  for (const hand of list) hand({ status });
}

function setStatus(id, status) {
  const d = read();
  const a = d.agents.find(x => x.id === id);
  if (!a) return null;
  a.status = status;
  if (status !== 'pending') delete a.pairingCode;
  write(d);
  if (status !== 'active') {
    failQueued(id, status === 'disabled' ? '外部智能体已停用' : '外部智能体不可用');
    notifyPollers(id, status);
  }
  return publicView(a);
}

function approve(id) { return setStatus(id, 'active'); }
function disable(id) { return setStatus(id, 'disabled'); }
function enable(id) { return setStatus(id, 'active'); }

function remove(id, now = Date.now()) {
  const d = read();
  const gone = d.agents.find(a => a.id === id);
  if (!gone) return false;
  d.agents = d.agents.filter(a => a.id !== id);
  // 记下移除过的 token：它再来时告诉它「你被移除了」，而不是笼统的认证失败
  d.removed = [...(d.removed || []).filter(r => r.tokenHash !== gone.tokenHash), { tokenHash: gone.tokenHash, id, removedAt: now }].slice(-100);
  write(d);
  failQueued(id, '外部智能体已移除');
  notifyPollers(id, 'removed');
  const wt = wakeTimers.get(id);
  if (wt) { clearTimeout(wt); wakeTimers.delete(id); }
  return true;
}

/** 这个 token 对应的智能体被移除过吗 */
function wasRemoved(token) {
  if (!token) return false;
  const h = hashToken(token);
  return read().removed.some(r => r.tokenHash === h);
}

/** 用 token 认出是哪个外部智能体；顺带记下「最近来过」。
 *  heartbeat：这次是来取任务，记下和上次的间隔；intervalSec：它自己报的心跳间隔 */
function authenticate(token, now = Date.now(), { heartbeat = false, intervalSec = 0, skillVersion = '' } = {}) {
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
    const sv = String(skillVersion || '').trim().slice(0, 16);
    if (sv) a.skillVersion = sv;
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
      wake(agentId);   // 它没在等：配了 Webhook 就马上叫醒它，不用等下一次轮询
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
  const done = finish(taskId, error ? { ok: false, error: String(error).slice(0, 2000), output: String(output || '') } : { ok: true, output: String(output || '') });
  // 它一次只取一个：做完这个后还有排队的，再叫醒一次
  if ((queue.get(agentId) || []).length) wake(agentId);
  return done;
}

// ── Webhook 唤醒 ────────────────────────────────────────────────────────────
// 有新任务时网关主动 POST 一条通知，外部智能体被叫醒后照常来取任务（GET /tasks）。
// 通知里只有「有新任务」，不带任务内容、token 和网关地址；定时轮询照旧兜底。

function err(status, message) { return Object.assign(new Error(message), { status }); }

/** 本机、局域网、Tailscale：可以用 http */
function isLocalHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h);
}

function checkWebhookUrl(raw, { allowLocalHttp = true } = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw err(400, 'Webhook 地址不对：要以 https:// 开头'); }
  if (u.username || u.password) throw err(400, 'Webhook 地址里不要带账号密码，密钥填在「密钥」里');
  if (u.protocol === 'http:') {
    if (!allowLocalHttp) throw err(400, 'Webhook 地址要用 https（本机和局域网的 http 地址只能由用户在网关页里设）');
    if (!isLocalHost(u.hostname)) throw err(400, 'Webhook 地址要用 https（本机和局域网的地址可以用 http）');
  } else if (u.protocol !== 'https:') {
    throw err(400, 'Webhook 地址要以 https:// 开头');
  }
  if (u.href.length > 1000) throw err(400, 'Webhook 地址太长');
  return u.href;
}

function webhookView(a) {
  const w = a && a.webhook;
  if (!w || !w.url) return null;
  return {
    url: w.url,
    by: w.by === 'user' ? 'user' : 'agent',
    healthy: webhookHealthy(a),
    fallbackPullSec: pullIntervalFor(a),
    hasSecret: !!w.secret,
    secretTail: w.secret ? String(w.secret).slice(-4) : '',
    sent: w.sent || 0,
    lastOkAt: w.lastOkAt || 0,
    lastError: w.lastError && (!w.lastOkAt || w.lastError.at > w.lastOkAt) ? w.lastError : null,
  };
}

/**
 * 设置 / 清除某个外部智能体的 Webhook。secret 留空表示沿用原来的；clear 清掉。
 * fromAgent：外部智能体自己用 token 设的，只认 https（不让它把网关指向本机和局域网里的服务）
 */
function setWebhook(id, { url, secret, clear = false, fromAgent = false, manual = false } = {}) {
  const d = read();
  const a = d.agents.find(x => x.id === id);
  if (!a) throw err(404, `没有这个外部智能体：${id}`);
  // 它说「我用 Webhook，但地址和密钥要请用户填」：只记下这个意愿，网关页引导用户填
  if (manual && !url) {
    a.webhookWanted = true;
    write(d);
    return webhookView(a);
  }
  if (clear) {
    delete a.webhook;
    delete a.webhookWanted;
    write(d);
    const t = wakeTimers.get(id);
    if (t) { clearTimeout(t); wakeTimers.delete(id); }
    return webhookView(a);
  }
  const href = checkWebhookUrl(url, { allowLocalHttp: !fromAgent });
  const prev = a.webhook || {};
  const changed = prev.url !== href || (secret != null && String(secret).trim() !== '' && String(secret).trim().replace(/^bearer\s+/i, '') !== prev.secret);
  let sec = secret == null || String(secret).trim() === '' ? (prev.secret || '') : String(secret).trim();
  if (/[\r\n]/.test(sec) || sec.length > 1000) throw err(400, '密钥格式不对');
  // 有人把整行「Bearer xxx」贴进来了：只留后面的
  sec = sec.replace(/^bearer\s+/i, '');
  const by = fromAgent ? 'agent' : 'user';   // 谁写入的：它自己（默认），还是用户在网关页手动设的
  a.webhook = changed
    ? { url: href, secret: sec, setAt: Date.now(), sent: 0, by }
    : { ...prev, url: href, secret: sec, by };
  write(d);
  // 外部智能体自己写入的、地址或密钥变了：马上发一条测试，通了才放长轮询间隔，不通就照常轮询
  if (fromAgent && changed) sendWebhook(id, { test: true }).catch(() => {});
  return webhookView(a);
}

function recordWebhook(agentId, res, now = Date.now()) {
  try {
    const d = read();
    const a = d.agents.find(x => x.id === agentId);
    if (!a || !a.webhook) return;
    if (res.ok) { a.webhook.sent = (a.webhook.sent || 0) + 1; a.webhook.lastOkAt = now; }
    else a.webhook.lastError = { at: now, message: String(res.message || '发送失败').slice(0, 200) };
    write(d);
  } catch { /* 只是记录 */ }
}

/** 发一次通知：{ ok, status?, message? } */
async function sendWebhook(agentId, { test = false } = {}) {
  const a = read().agents.find(x => x.id === agentId);
  const w = a && a.webhook;
  if (!w || !w.url) return { ok: false, message: '没有设置 Webhook' };
  const body = {
    event: test ? 'tokenbank.test' : 'tokenbank.task_queued',
    agent_id: agentId,
    queued: (queue.get(agentId) || []).length,
    sent_at: new Date().toISOString(),
  };
  let res;
  try {
    const r = await fetch(w.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TokenBank-Gateway', ...(w.secret ? { Authorization: `Bearer ${w.secret}` } : {}) },
      body: JSON.stringify(body),
      redirect: 'manual',   // 不跟跳转：通知只发到用户设的那个地址
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    try { await r.arrayBuffer(); } catch { /* 不关心回了什么 */ }
    res = r.status >= 200 && r.status < 300 ? { ok: true, status: r.status }
      : { ok: false, status: r.status, message: r.status === 401 || r.status === 403 ? `对方拒绝了（HTTP ${r.status}）：检查密钥` : `对方回 HTTP ${r.status}` };
  } catch (e) {
    const why = e?.name === 'TimeoutError' ? '超时' : (e?.cause?.code || e?.message || '连不上');
    res = { ok: false, message: `发不出去：${why}` };
  }
  recordWebhook(agentId, res);
  return res;
}

function scheduleWake(agentId, attempt, delay) {
  const t = setTimeout(async () => {
    wakeTimers.delete(agentId);
    if (!(queue.get(agentId) || []).length) return;   // 已经被取走了
    const r = await sendWebhook(agentId);
    if (!r.ok && attempt < WEBHOOK_RETRY_MS.length && !wakeTimers.has(agentId)) scheduleWake(agentId, attempt + 1, WEBHOOK_RETRY_MS[attempt]);
  }, delay);
  if (t.unref) t.unref();
  wakeTimers.set(agentId, t);
}

/** 有任务在排队、它又没在长轮询：配了 Webhook 就叫醒它 */
function wake(agentId) {
  if (wakeTimers.has(agentId)) return;
  const a = read().agents.find(x => x.id === agentId);
  if (!a || a.status !== 'active' || !a.webhook || !a.webhook.url) return;
  scheduleWake(agentId, 0, WEBHOOK_DEBOUNCE_MS);
}

/** 网关页「发一条测试」 */
function testWebhook(id) {
  if (!read().agents.some(x => x.id === id)) return Promise.resolve({ ok: false, message: `没有这个外部智能体：${id}` });
  return sendWebhook(id, { test: true });
}

/** 执行器的智能体列表里用：只列允许接任务的 */
function listForAgents() {
  return list().filter(a => a.status === 'active').map(a => ({
    id: a.id, name: a.name, type: 'external', description: a.description, online: a.online, installed: true, status: 'active',
    intervalMs: a.intervalMs || 0, lastSeenAt: a.lastSeenAt || 0,
  }));
}

function isExternalId(id) { return typeof id === 'string' && id.startsWith(PREFIX); }

module.exports = {
  PREFIX, isExternalId,
  list, get, listForAgents,
  pullIntervalSec, setPullInterval,
  newPairingCode, currentPairing, register,
  approve, disable, enable, remove,
  authenticate, dispatch, pull, complete,
  setResultHandler, setPushHandler, setTakenHandler, push, pushDetailed, restore, isOnline, skillInfo, wasRemoved,
  setWebhook, testWebhook, checkWebhookUrl, webhookHealthy, pullIntervalFor,
  _internal: { file, tasksFile, queue, waiting, pollers, wakeTimers, ONLINE_MS, WEBHOOK_RETRY_MS, reset() { restored = false; resultHandler = null; pushHandler = null; takenHandler = null; for (const t of deadlineTimers.values()) clearTimeout(t); deadlineTimers.clear(); for (const t of wakeTimers.values()) clearTimeout(t); wakeTimers.clear(); } },
};
