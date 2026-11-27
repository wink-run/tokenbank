// client/electron/agent-team.js
// 一批任务（团队）：智能体路由接到一件事、拆成子任务派给各处的智能体，这一整批算一个团队。
// 团队号就是路由那一轮任务的任务号（返工的轮次也归到同一个团队）。存在 ~/.tokenbank/teams/<团队号>.json：
//   · plan      派发计划：子任务、依赖、状态（tb_plan 写；状态按子任务的真实进度刷新）
//   · notes     协作区留言：成员之间对接口、说阻塞（tb_notes）
//   · counts    派了几次、雇了几次（路由预算）
//   · attempts  每一轮交付和它的验收结果；验收不过就带着原因在原会话里返工
// 只记团队层面的东西，任务本身仍在 agent_tasks 里。轻量实现：验收在本进程里跟，应用重启时没跟完的由智能管家收尾。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
const WATCH_MAX_MS = 12 * 60 * 60 * 1000;
const VERIFY_CMD_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINAL = ['completed', 'failed', 'cancelled'];

function dir() { return path.join(os.homedir(), '.tokenbank', 'teams'); }
function fileOf(id) { return path.join(dir(), `${String(id).replace(/[^\w:.-]/g, '_')}.json`); }

function read(id) {
  if (!id) return null;
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; }
}

function write(team) {
  team.updatedAt = Date.now();
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fileOf(team.id), JSON.stringify(team, null, 2));
  } catch { /* 写不了就算了，团队信息只是辅助 */ }
  return team;
}

function update(id, fn) {
  const team = read(id);
  if (!team) return null;
  fn(team);
  return write(team);
}

function prune(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(dir()); } catch { return; }
  for (const n of names) {
    const p = path.join(dir(), n);
    try { if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
  }
}

function list({ routeId, limit = 20 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir()).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8'));
      if (!routeId || t.routeId === routeId) out.push(t);
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit);
}

function db() { return require('./agent-executor')._getDb(); }

function taskRow(id) {
  try { return db().prepare('SELECT id, agent_id, prompt, context, result, status, error, created_at, started_at, completed_at FROM agent_tasks WHERE id = ?').get(id) || null; } catch { return null; }
}

function parseJson(raw) { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }

/** 这个任务属于哪个团队：自己就是团队，或者往上找派它的那一层 */
function teamOf(taskId, depth = 0) {
  if (!taskId || depth > 6) return null;
  if (read(taskId)) return taskId;
  const row = taskRow(taskId);
  if (!row) return null;
  const ctx = parseJson(row.context);
  if (ctx.teamId && read(ctx.teamId)) return ctx.teamId;
  return ctx.parentTaskId ? teamOf(ctx.parentTaskId, depth + 1) : null;
}

function route(team) {
  try { return require('./agent-routes').get(team.routeId) || null; } catch { return null; }
}

// ── 计划 ──────────────────────────────────────────────────────────────────

function cleanStep(s, i) {
  const id = String(s?.id || `s${i + 1}`).trim().slice(0, 40);
  return {
    id,
    title: String(s?.title || s?.name || id).trim().slice(0, 200),
    agent: String(s?.agent || s?.agent_id || '').trim().slice(0, 120) || null,
    depends_on: (Array.isArray(s?.depends_on) ? s.depends_on : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 20),
    status: 'pending',
    taskId: null,
  };
}

function setPlan(teamId, steps) {
  return update(teamId, (t) => {
    const prev = new Map((t.plan || []).map((s) => [s.id, s]));
    t.plan = (Array.isArray(steps) ? steps : []).slice(0, 50).map((s, i) => {
      const c = cleanStep(s, i);
      const old = prev.get(c.id);
      return old ? { ...c, status: old.status, taskId: old.taskId } : c;
    });
    t.events.push({ at: Date.now(), type: 'plan', text: `计划 ${t.plan.length} 步` });
  });
}

function linkStep(teamId, stepId, taskId, agentId) {
  return update(teamId, (t) => {
    const s = (t.plan || []).find((x) => x.id === stepId);
    if (!s) return;
    s.taskId = taskId;
    s.status = 'running';
    if (agentId) s.agent = agentId;
  });
}

/** 计划的当前样子：子任务状态按真实进度刷新，依赖都完成的待办标成「可以派了」 */
function planView(teamId) {
  const team = read(teamId);
  if (!team) return null;
  let changed = false;
  for (const s of team.plan || []) {
    if (!s.taskId || TERMINAL.includes(s.status)) continue;
    const row = taskRow(s.taskId);
    if (row && row.status !== s.status) { s.status = row.status; changed = true; }
  }
  if (changed) write(team);
  const done = new Set((team.plan || []).filter((s) => s.status === 'completed').map((s) => s.id));
  const steps = (team.plan || []).map((s) => ({
    ...s,
    ready: s.status === 'pending' && s.depends_on.every((d) => done.has(d)),
  }));
  return { teamId, steps };
}

function planText(view) {
  if (!view || !view.steps.length) return '（还没有计划：拆完任务后用 tb_plan(steps=[...]) 记下来）';
  const mark = { completed: '✓', failed: '✗', cancelled: '✗', running: '…', pending: '○' };
  const lines = view.steps.map((s) => {
    const dep = s.depends_on.length ? ` ← 依赖 ${s.depends_on.join('、')}` : '';
    const who = s.agent ? ` [${s.agent}]` : '';
    const task = s.taskId ? ` 任务 ${s.taskId}` : '';
    return `${mark[s.status] || '○'} ${s.id} ${s.title}${who}${task}${dep}${s.ready ? '  ← 可以派了' : ''}`;
  });
  return lines.join('\n');
}

// ── 协作区留言 ─────────────────────────────────────────────────────────────

function addNote(teamId, { from, to, text }) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return null;
  const note = { at: Date.now(), from: String(from || '').slice(0, 80) || '某成员', to: String(to || '').slice(0, 80) || null, text: t };
  update(teamId, (team) => {
    team.notes = [...(team.notes || []), note].slice(-200);
    team.events.push({ at: note.at, type: 'note', text: `${note.from}${note.to ? ` @${note.to}` : ''}：${t.slice(0, 120)}` });
  });
  return note;
}

function notes(teamId, { limit = 30 } = {}) {
  return (read(teamId)?.notes || []).slice(-limit);
}

// ── 预算 ──────────────────────────────────────────────────────────────────

/** 派之前查预算；超了抛错（说清楚是哪条限制） */
function checkBudget(teamId, agentId) {
  const team = read(teamId);
  if (!team) return;
  const b = route(team)?.budget || {};
  const hire = String(agentId || '').startsWith('community:');
  if (b.maxDispatches > 0 && (team.counts?.dispatch || 0) >= b.maxDispatches) {
    throw new Error(`这批任务已经派了 ${team.counts.dispatch} 次，到了路由设的上限 ${b.maxDispatches}：剩下的请自己完成或收尾汇总`);
  }
  if (hire && b.maxHires > 0 && (team.counts?.hire || 0) >= b.maxHires) {
    throw new Error(`这批任务已经雇了 ${team.counts.hire} 次社区智能体，到了路由设的上限 ${b.maxHires}`);
  }
}

function noteDispatch(teamId, { taskId, agentId, step }) {
  update(teamId, (t) => {
    t.counts = t.counts || { dispatch: 0, hire: 0 };
    t.counts.dispatch += 1;
    if (String(agentId || '').startsWith('community:')) t.counts.hire += 1;
    t.events.push({ at: Date.now(), type: 'dispatch', text: `派给 ${agentId}${step ? `（计划 ${step}）` : ''}`, taskId });
  });
  if (step) linkStep(teamId, step, taskId, agentId);
}

/** 派给子任务的提示里补一句：有协作区可以用 */
function childPromptSuffix(teamId) {
  return `\n\n[协作区] 你是一批任务里的一员（团队 ${teamId}）。需要和其他成员对接口、说明阻塞或交代产出时，用 tb_notes(team="${teamId}") 留言或查看；别人 @ 你的消息也在那里。`;
}

// ── 路由任务：开始、跟进、验收、返工 ─────────────────────────────────────────

const watching = new Set();

/**
 * 执行器开了一轮路由任务（mode=orchestrator 且带 agentRouteId）时调用。
 * 第一轮建团队；返工的轮次（带 teamId）归到原团队。之后在后台跟到它结束，再验收。
 */
function onRouteTask(executor, taskId, { prompt, options = {} } = {}) {
  prune();
  const teamId = options.teamId || taskId;
  if (!read(teamId)) {
    write({
      id: teamId,
      routeId: options.agentRouteId,
      mainAgentId: options.mainAgentId || null,
      prompt: String(prompt || '').slice(0, 4000),
      createdAt: Date.now(),
      status: 'running',
      plan: [], notes: [], counts: { dispatch: 0, hire: 0 }, attempts: [],
      events: [{ at: Date.now(), type: 'start', text: '开始', taskId }],
      run: {
        workingDir: options.workingDir || null,
        sessionKey: options.sessionKey || null,
        sessionInstanceId: options.sessionInstanceId || null,
        mcpProfile: options.mcpProfile || null,
        clientId: options.clientId || null,
      },
    });
  } else {
    update(teamId, (t) => {
      t.status = 'running';
      t.events.push({ at: Date.now(), type: 'rework', text: `第 ${t.attempts.length + 1} 轮`, taskId });
    });
  }
  watch(executor, teamId, taskId);
  return teamId;
}

function watch(executor, teamId, taskId) {
  if (watching.has(taskId)) return;
  watching.add(taskId);
  const started = Date.now();
  const tick = async () => {
    let status = null;
    try { status = await executor.getTaskStatus(taskId); } catch { status = null; }
    if (status && TERMINAL.includes(status.status)) {
      watching.delete(taskId);
      try { await finish(executor, teamId, taskId, status); } catch (e) { console.warn('[team] finish:', e.message); }
      return;
    }
    if (Date.now() - started > WATCH_MAX_MS) { watching.delete(taskId); return; }
    const t = setTimeout(tick, 3000);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, 3000);
  if (t.unref) t.unref();
}

function runCommand(cmd, cwd) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: cwd || process.cwd(), timeout: VERIFY_CMD_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({ ok: !err, detail: (err && !out ? err.message : out).slice(-3000) });
    });
  });
}

/** 审查型智能体的结论：最后写「验收：通过」或「验收：不通过：原因」 */
function parseVerdict(text) {
  const s = String(text || '');
  const m = /验收\s*[:：]\s*(不通过|通过)\s*[:：]?\s*([^\n]*)/.exec(s);
  if (m) return { ok: m[1] === '通过', detail: (m[2] || '').trim() || s.slice(-1500) };
  if (/\bVERDICT\s*:\s*PASS\b/i.test(s)) return { ok: true, detail: '' };
  if (/\bVERDICT\s*:\s*FAIL\b/i.test(s)) return { ok: false, detail: s.slice(-1500) };
  return { ok: false, detail: `审查没给出明确结论：${s.slice(-800)}` };
}

async function verify(executor, team, taskId, status) {
  const v = route(team)?.verify || {};
  const cwd = parseJson(taskRow(taskId)?.context).workingDir || team.run?.workingDir || undefined;
  if (v.command) {
    const r = await runCommand(v.command, cwd);
    return { ok: r.ok, how: `验收命令 ${v.command}`, detail: r.detail };
  }
  if (v.reviewer) {
    const output = String(status.result?.summary || status.result?.output || '').slice(0, 12000);
    const prompt = [
      '请验收下面这批任务的交付是否达到要求。只检查，不要修改任何文件。',
      '', '原始需求：', team.prompt, '', '交付汇总：', output || '（没有汇总文字，请直接看工作目录里的改动）', '',
      '检查需求是否都做到、产出是否真的存在且可用（能跑的就跑一下）。',
      '最后单独一行写「验收：通过」，或「验收：不通过：<具体原因和要改的地方>」。',
    ].join('\n');
    try {
      const r = await executor.dispatchAndWait(v.reviewer, prompt, { workingDir: cwd, parentTaskId: taskId, mode: 'worker', teamId: team.id });
      if (r.status !== 'completed') return { ok: false, how: `审查智能体 ${v.reviewer}`, detail: `审查没做成：${r.error || r.status}` };
      const verdict = parseVerdict(r.result?.output || r.result?.summary);
      return { ...verdict, how: `审查智能体 ${v.reviewer}` };
    } catch (e) {
      return { ok: false, how: `审查智能体 ${v.reviewer}`, detail: `审查没做成：${e.message}` };
    }
  }
  return null;
}

async function finish(executor, teamId, taskId, status) {
  const team = read(teamId);
  if (!team) return;
  const r = route(team);
  let result = null;
  if (status.status === 'completed') {
    update(teamId, (t) => t.events.push({ at: Date.now(), type: 'delivered', text: '这一轮交付了', taskId }));
    result = await verify(executor, team, taskId, status);
  }
  const ok = status.status === 'completed' && (!result || result.ok);
  const attempt = { taskId, at: Date.now(), status: status.status, verify: result };
  const next = update(teamId, (t) => {
    t.attempts.push(attempt);
    if (result) t.events.push({ at: Date.now(), type: 'verify', text: `${result.how}：${result.ok ? '通过' : '不通过'}`, taskId });
  });
  if (result) {
    try { executor.setTaskResultExtra(taskId, { verify: { ok: result.ok, how: result.how, detail: String(result.detail || '').slice(0, 1500) } }); } catch { /* 只是附加信息 */ }
  }
  const maxRework = Math.max(0, Math.min(5, Number(r?.verify?.maxRework ?? 1)));
  const reworks = next.attempts.length - 1;
  if (result && !result.ok && status.status === 'completed' && reworks < maxRework && next.mainAgentId) {
    const prompt = [
      `上一轮交付没有通过验收（${result.how}）：`, String(result.detail || '').slice(0, 3000), '',
      '请在原来的基础上修正（需要时继续派给合适的成员），修好后重新汇总。', '', '原始需求：', team.prompt,
    ].join('\n');
    try {
      await executor.execute(next.mainAgentId, prompt, {
        ...(team.run || {}),
        mode: 'orchestrator', mainAgentId: next.mainAgentId, agentRouteId: team.routeId,
        teamId, previousTaskId: taskId,
      });
      return;
    } catch (e) {
      update(teamId, (t) => t.events.push({ at: Date.now(), type: 'rework-failed', text: `返工没开起来：${e.message}` }));
    }
  }
  update(teamId, (t) => {
    t.status = ok ? 'delivered' : (status.status === 'cancelled' ? 'cancelled' : 'failed');
    t.endedAt = Date.now();
    t.events.push({ at: Date.now(), type: 'end', text: ok ? '交付完成' : (result && !result.ok ? '验收没通过，返工次数用完' : `结束：${status.status}`) });
  });
  learn(teamId, ok);
}

/** 智能管家学：这批里每个成员做的哪类活、最后成没成（成 = 子任务完成且整体验收通过） */
function learn(teamId, teamOk) {
  try {
    const learnMod = require('./guardian/dispatch-learn');
    if (typeof learnMod.noteOutcome !== 'function') return;
    for (const n of tree(teamId).filter((x) => x.depth > 0 && !x.reviewer)) {
      learnMod.noteOutcome({ prompt: n.prompt, agentId: n.agent_id, ok: n.status === 'completed' && teamOk, teamId });
    }
  } catch (e) { console.warn('[team] learn:', e.message); }
}

// ── 协作过程（给界面） ─────────────────────────────────────────────────────

function children(parentId) {
  try {
    return db().prepare(`
      SELECT id, agent_id, prompt, context, result, status, error, created_at, started_at, completed_at,
             (SELECT COUNT(*) FROM agent_task_steps s WHERE s.task_id = agent_tasks.id) AS steps,
             (SELECT MAX(created_at) FROM agent_task_steps s WHERE s.task_id = agent_tasks.id) AS last_step_at
      FROM agent_tasks WHERE json_extract(context, '$.parentTaskId') = ? ORDER BY created_at ASC LIMIT 200
    `).all(parentId);
  } catch { return []; }
}

function nodeOf(row, depth) {
  const result = parseJson(row.result);
  const usage = result.usage || {};
  const tokens = Number(usage.total_tokens || 0) || (Number(usage.input_tokens || usage.prompt_tokens || 0) + Number(usage.output_tokens || usage.completion_tokens || 0));
  return {
    id: row.id, depth, agent_id: row.agent_id, status: row.status,
    prompt: String(row.prompt || '').slice(0, 300),
    device: result.device || parseJson(row.context).meshDevice || null,
    created_at: row.created_at, completed_at: row.completed_at || null,
    steps: Number(row.steps) || 0, last_step_at: Number(row.last_step_at) || null,
    tokens, verify: result.verify || null,
    reviewer: /请验收下面这批任务的交付/.test(String(row.prompt || '')),
  };
}

/** 团队里所有任务（每一轮路由任务和它派出去的子任务），按层级平铺 */
function tree(teamId) {
  const team = read(teamId);
  if (!team) return [];
  const roots = [...new Set([team.id, ...(team.attempts || []).map((a) => a.taskId), ...(team.events || []).filter((e) => e.type === 'rework' || e.type === 'start').map((e) => e.taskId)])].filter(Boolean);
  const out = [];
  const seen = new Set();
  const walk = (row, depth) => {
    if (!row || seen.has(row.id) || out.length > 300) return;
    seen.add(row.id);
    out.push(nodeOf(row, depth));
    for (const c of children(row.id)) walk(c, depth + 1);
  };
  for (const id of roots) {
    const row = taskRow(id);
    if (!row) continue;
    let r = { ...row, steps: 0, last_step_at: null };
    try {
      const s = db().prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM agent_task_steps WHERE task_id = ?').get(id);
      r = { ...row, steps: s?.n || 0, last_step_at: s?.last || null };
    } catch { /* ignore */ }
    walk(r, 0);
  }
  return out;
}

/** 界面用：团队概况 + 任务树 + 计划 + 留言 + 时间线（按时间排，界面可以逐条回放） */
function view(teamId) {
  const team = read(teamId);
  if (!team) return null;
  const nodes = tree(teamId);
  const timeline = [...(team.events || [])];
  for (const n of nodes) {
    if (n.depth > 0) timeline.push({ at: n.created_at, type: 'task', text: `${n.agent_id} 开始${n.device ? `（在 ${n.device}）` : ''}`, taskId: n.id });
    if (n.completed_at && n.depth > 0) timeline.push({ at: n.completed_at, type: 'task-end', text: `${n.agent_id} ${n.status === 'completed' ? '完成' : n.status}`, taskId: n.id });
  }
  timeline.sort((a, b) => (a.at || 0) - (b.at || 0));
  return {
    id: team.id, routeId: team.routeId, status: team.status, prompt: team.prompt,
    createdAt: team.createdAt, endedAt: team.endedAt || null,
    counts: team.counts, tokens: nodes.reduce((s, n) => s + (n.tokens || 0), 0),
    attempts: team.attempts, plan: planView(teamId)?.steps || [], notes: team.notes || [],
    nodes, timeline,
  };
}

/** 最后一次有动静的时间：团队记录、任务树里的步骤和完成时间 */
function lastActivity(teamId) {
  const team = read(teamId);
  if (!team) return 0;
  let last = team.updatedAt || team.createdAt || 0;
  for (const n of tree(teamId)) last = Math.max(last, n.created_at || 0, n.completed_at || 0, n.last_step_at || 0);
  return last;
}

module.exports = {
  read, list, teamOf, setPlan, planView, planText, linkStep, addNote, notes, checkBudget, noteDispatch,
  childPromptSuffix, onRouteTask, tree, view, lastActivity, parseVerdict, update,
  _internal: { finish, verify, write, dir },
};
