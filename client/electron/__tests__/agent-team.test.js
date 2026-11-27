'use strict';
// 一批任务（团队）：计划、协作区留言、预算、交付验收和返工、智能管家盯停滞、按交付结果学派发偏好
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-team-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const executor = require('../agent-executor');
const team = require('../agent-team');
const routes = require('../agent-routes');

const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL, context TEXT,
    status TEXT NOT NULL, result TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER);
  CREATE TABLE agent_task_steps (id TEXT PRIMARY KEY, task_id TEXT, step_number INTEGER, step_type TEXT, content TEXT, created_at INTEGER);
`);
executor._getDb = () => db;
const addTask = (id, ctx, status = 'running', agent = 'claude-code', prompt = 'x') =>
  db.prepare('INSERT OR REPLACE INTO agent_tasks (id, agent_id, prompt, context, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, agent, prompt, JSON.stringify(ctx), status, Date.now(), status === 'running' ? null : Date.now());

/** 假执行器：只记调用，状态从内存库读 */
function fakeExecutor() {
  const calls = { execute: [], extra: {} };
  return {
    calls,
    getTaskStatus: async (id) => { const r = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id); return r ? { ...r, result: JSON.parse(r.result || '{}') } : null; },
    setTaskResultExtra: (id, x) => { calls.extra[id] = x; },
    execute: async (agent, prompt, opts) => { calls.execute.push({ agent, prompt, opts }); return { taskId: 'next' }; },
    dispatchAndWait: async () => ({ status: 'completed', result: { output: '看过了。\n验收：不通过：缺少 README' } }),
  };
}

test('计划：写下步骤，子任务状态按真实进度刷新，依赖都完成的标「可以派了」', () => {
  routes.save({ id: 'agent-router-t1', name: 't1' });
  addTask('root1', { agentRouteId: 'agent-router-t1' });
  team.onRouteTask(fakeExecutor(), 'root1', { prompt: '做个网站', options: { agentRouteId: 'agent-router-t1', mainAgentId: 'claude-code' } });
  assert.equal(team.teamOf('root1'), 'root1');
  team.setPlan('root1', [{ id: 'api', title: '后端接口' }, { id: 'web', title: '前端页面', depends_on: ['api'] }]);
  addTask('c1', { parentTaskId: 'root1' }, 'running', 'codex', '写接口');
  team.noteDispatch('root1', { taskId: 'c1', agentId: 'codex', step: 'api' });
  assert.equal(team.teamOf('c1'), 'root1', '子任务往上找到团队');
  let v = team.planView('root1');
  assert.equal(v.steps[0].status, 'running');
  assert.equal(v.steps[1].ready, false);
  db.prepare("UPDATE agent_tasks SET status = 'completed' WHERE id = 'c1'").run();
  v = team.planView('root1');
  assert.equal(v.steps[0].status, 'completed');
  assert.equal(v.steps[1].ready, true);
  assert.match(team.planText(v), /web 前端页面.*可以派了/);
  // 再写一次计划：已派出的步骤保留进度
  team.setPlan('root1', [{ id: 'api', title: '后端接口 v2' }, { id: 'web', title: '前端页面', depends_on: ['api'] }]);
  assert.equal(team.planView('root1').steps[0].status, 'completed');
});

test('协作区留言、子任务提示里带上团队号', () => {
  team.addNote('root1', { from: 'codex', to: 'cursor', text: '/orders 多了 status 字段' });
  assert.equal(team.notes('root1')[0].to, 'cursor');
  assert.match(team.childPromptSuffix('root1'), /tb_notes\(team="root1"\)/);
});

test('预算：派到上限就拒绝，雇佣单独计数', () => {
  routes.save({ id: 'agent-router-t2', name: 't2', budget: { maxDispatches: 2, maxHires: 1 } });
  addTask('root2', {});
  team.onRouteTask(fakeExecutor(), 'root2', { prompt: 'p', options: { agentRouteId: 'agent-router-t2' } });
  team.checkBudget('root2', 'community:a@x');
  team.noteDispatch('root2', { taskId: 'h1', agentId: 'community:a@x' });
  assert.throws(() => team.checkBudget('root2', 'community:b@y'), /雇了 1 次/);
  team.checkBudget('root2', 'codex');
  team.noteDispatch('root2', { taskId: 'd2', agentId: 'codex' });
  assert.throws(() => team.checkBudget('root2', 'codex'), /派了 2 次/);
});

test('验收命令通过：团队交付；不通过：带着原因在原会话返工，返工次数用完就结束', async () => {
  routes.save({ id: 'agent-router-ok', name: 'ok', mainAgentId: 'claude-code', verify: { command: 'node -e "process.exit(0)"' } });
  addTask('r-ok', {}, 'completed');
  const ex = fakeExecutor();
  team.onRouteTask(ex, 'r-ok', { prompt: 'p', options: { agentRouteId: 'agent-router-ok', mainAgentId: 'claude-code' } });
  await team._internal.finish(ex, 'r-ok', 'r-ok', { status: 'completed', result: { summary: 'done' } });
  assert.equal(team.read('r-ok').status, 'delivered');
  assert.equal(ex.calls.extra['r-ok'].verify.ok, true);

  routes.save({ id: 'agent-router-bad', name: 'bad', mainAgentId: 'claude-code', verify: { command: 'node -e "console.log(\'2 tests failed\');process.exit(1)"', maxRework: 1 } });
  addTask('r-bad', {}, 'completed');
  const ex2 = fakeExecutor();
  team.onRouteTask(ex2, 'r-bad', { prompt: '修好登录', options: { agentRouteId: 'agent-router-bad', mainAgentId: 'claude-code', workingDir: HOME } });
  await team._internal.finish(ex2, 'r-bad', 'r-bad', { status: 'completed', result: {} });
  assert.equal(ex2.calls.execute.length, 1, '返工一轮');
  const call = ex2.calls.execute[0];
  assert.equal(call.opts.previousTaskId, 'r-bad', '接着原来的会话');
  assert.equal(call.opts.teamId, 'r-bad');
  assert.equal(call.opts.mode, 'orchestrator');
  assert.match(call.prompt, /2 tests failed/);
  assert.match(call.prompt, /修好登录/);
  assert.equal(team.read('r-bad').status, 'running');
  // 返工那一轮还是没过：次数用完，结束
  addTask('r-bad-2', { teamId: 'r-bad' }, 'completed');
  await team._internal.finish(ex2, 'r-bad', 'r-bad-2', { status: 'completed', result: {} });
  assert.equal(ex2.calls.execute.length, 1, '不再返工');
  assert.equal(team.read('r-bad').status, 'failed');
});

test('审查智能体的结论', async () => {
  assert.deepEqual(team.parseVerdict('看完了\n验收：通过'), { ok: true, detail: team.parseVerdict('看完了\n验收：通过').detail });
  assert.equal(team.parseVerdict('验收：不通过：缺 README').ok, false);
  assert.match(team.parseVerdict('验收：不通过：缺 README').detail, /缺 README/);
  assert.equal(team.parseVerdict('VERDICT: PASS').ok, true);
  assert.equal(team.parseVerdict('嗯……').ok, false, '没结论按不通过');
  routes.save({ id: 'agent-router-rv', name: 'rv', mainAgentId: 'claude-code', verify: { reviewer: 'assistant:qa', maxRework: 0 } });
  addTask('r-rv', {}, 'completed');
  const ex = fakeExecutor();
  team.onRouteTask(ex, 'r-rv', { prompt: 'p', options: { agentRouteId: 'agent-router-rv', mainAgentId: 'claude-code' } });
  await team._internal.finish(ex, 'r-rv', 'r-rv', { status: 'completed', result: { summary: 's' } });
  const t = team.read('r-rv');
  assert.equal(t.attempts[0].verify.ok, false);
  assert.match(t.attempts[0].verify.detail, /缺少 README/);
  assert.equal(t.status, 'failed', 'maxRework=0 不返工');
});

test('协作过程：任务树、时间线按时间排', () => {
  const v = team.view('root1');
  assert.deepEqual(v.nodes.map((n) => [n.id, n.depth]), [['root1', 0], ['c1', 1]]);
  assert.ok(v.timeline.length >= 3);
  for (let i = 1; i < v.timeline.length; i++) assert.ok(v.timeline[i].at >= v.timeline[i - 1].at);
  assert.equal(v.notes.length, 1);
});

test('智能管家：一批任务很久没进展就提醒，能一键取消', async () => {
  const watch = require('../guardian/team-watch');
  const guardian = require('../guardian/index');
  addTask('root-s', {});
  team.onRouteTask(fakeExecutor(), 'root-s', { prompt: '卡住的任务', options: { agentRouteId: 'agent-router-t1' } });
  const fakeTeam = { ...team, lastActivity: () => Date.now() - watch.STALL_MS - 60000, list: () => [team.read('root-s')] };
  const r = await watch.check({ team: fakeTeam });
  assert.deepEqual(r.stalled, ['root-s']);
  let cancelled = [];
  const origCancel = executor.cancel;
  executor.cancel = async (id) => { cancelled.push(id); };
  try {
    await watch.cancelTeam({ teamId: 'root-s' });
  } finally { executor.cancel = origCancel; }
  assert.deepEqual(cancelled, ['root-s']);
  assert.equal(team.read('root-s').status, 'cancelled');
  void guardian;
});

test('按交付结果学派发偏好：同一类活谁成功率明显高，就优先派给谁', () => {
  const learn = require('../guardian/dispatch-learn');
  const prompt = '把这段英文翻译成中文';
  for (let i = 0; i < 3; i++) learn.noteOutcome({ prompt, agentId: 'assistant:translator', ok: true });
  for (let i = 0; i < 3; i++) learn.noteOutcome({ prompt, agentId: 'codex', ok: false });
  const prefs = learn._internal.tuning().prefs;
  const hit = Object.values(prefs).find((p) => p.agentId === 'assistant:translator');
  assert.ok(hit, JSON.stringify(prefs));
  assert.ok(learn.orchestratorHints().some((l) => l.includes('assistant:translator')));
});

test('工具入口：派活方写计划、留言；子任务凭团队号看留言；超预算的派发被拦下', async () => {
  const tools = require('../tokenbank-tools');
  const ctx = { level: 'full', dispatch: { parentTaskId: 'root1' } };
  const r1 = await tools.callTool('tb_plan', { steps: [{ id: 'a', title: '调研' }, { id: 'b', title: '实现', depends_on: ['a'] }] }, ctx);
  assert.match(r1.content[0].text, /a 调研/);
  const r2 = await tools.callTool('tb_notes', { post: '接口改成分页了', to: 'cursor' }, ctx);
  assert.match(r2.content[0].text, /接口改成分页了/);
  const child = await tools.callTool('tb_notes', { team: 'root1' }, { level: 'full', dispatch: {} });
  assert.match(child.content[0].text, /接口改成分页了/);
  const none = await tools.callTool('tb_plan', {}, { level: 'full', dispatch: {} });
  assert.equal(none.isError, true);
  const over = await tools.callTool('tb_dispatch_agent', { agent_id: 'codex', prompt: 'x', background: true }, { level: 'full', dispatch: { parentTaskId: 'root2' } });
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /上限/);
});

test('@ 提及：在干活的下次调用工具时收到；已经做完的被叫醒接着原来的会话；派活方知道新任务号', async () => {
  routes.save({ id: 'agent-router-at', name: 'at' });
  addTask('root-at', {});
  const ex = fakeExecutor();
  const dispatched = [];
  ex.dispatch = async (agent, prompt, opts) => { dispatched.push({ agent, prompt, opts }); return { taskId: `wake-${dispatched.length}` }; };
  team.onRouteTask(ex, 'root-at', { prompt: '做个下单页', options: { agentRouteId: 'agent-router-at' } });
  addTask('w-cursor', { parentTaskId: 'root-at', workingDir: HOME }, 'running', 'cursor', '写前端');
  addTask('w-codex', { parentTaskId: 'root-at', workingDir: HOME }, 'completed', 'mine:codex@mini', '写接口');

  assert.deepEqual(team.mentionsOf('', '@mine:codex@mini 少个字段，@派活方 知悉'), ['mine:codex@mini', '派活方']);

  // cursor 在 @ codex（已做完）和派活方
  const note = team.addNote('root-at', { from: 'cursor', text: '@codex /orders 少一个 status 字段，能加吗？@派活方 前端在等这个' });
  const r = await team.deliver(ex, 'root-at', note);
  assert.deepEqual(r.notified, ['派活方']);
  assert.deepEqual(r.woke.map((w) => w.agent), ['mine:codex@mini'], '按基础名 codex 认出 mine:codex@mini');
  assert.equal(dispatched[0].opts.previousTaskId, 'w-codex', '接着原来的会话');
  assert.equal(dispatched[0].opts.parentTaskId, 'root-at');
  assert.match(dispatched[0].prompt, /cursor @ 了你/);
  assert.equal(team.read('root-at').counts.dispatch, 1, '叫醒算一次派发');
  const forLead = team.takeInbox('root-at');
  assert.equal(forLead.length, 2);
  assert.match(team.inboxText(forLead), /前端在等这个/);
  assert.match(team.inboxText(forLead), /已叫醒 mine:codex@mini.*wake-1/);
  assert.deepEqual(team.takeInbox('root-at'), [], '取过就清空');

  // codex 回 @cursor（还在干活）：进 cursor 的收件箱，cursor 调任何工具时带上
  const back = team.addNote('root-at', { from: 'mine:codex@mini', to: 'cursor', text: '加好了，status 取值 paid/unpaid' });
  const r2 = await team.deliver(ex, 'root-at', back);
  assert.deepEqual(r2.notified, ['cursor']);
  const tools = require('../tokenbank-tools');
  const res = await tools.callTool('tb_plan', {}, { level: 'full', dispatch: { parentTaskId: 'w-cursor' } });
  assert.match(res.content[0].text, /mine:codex@mini @ 你：加好了/);
  const again = await tools.callTool('tb_plan', {}, { level: 'full', dispatch: { parentTaskId: 'w-cursor' } });
  assert.doesNotMatch(again.content[0].text, /@ 你/, '只送一次');

  // 自己 @ 自己不算；叫醒有上限
  assert.deepEqual(team.recipients('root-at', { from: 'cursor', text: '@cursor 自言自语' }), []);
  team.update('root-at', (t) => { t.wakes = team.MAX_WAKES; });
  db.prepare("UPDATE agent_tasks SET status = 'completed' WHERE id = 'w-cursor'").run();
  const r3 = await team.deliver(ex, 'root-at', team.addNote('root-at', { from: 'mine:codex@mini', text: '@cursor 再看一下' }));
  assert.deepEqual(r3.skipped, ['cursor']);
});
