'use strict';
// 场景路由修正、汇总失败复盘、说一句话就办
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-dispatch-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });

const localStats = require('../local-stats');
assert.ok(localStats.init(path.join(HOME, '.tokenbank'), { force: true }));
require('../../cli/ipc-bridge').installElectronStub();
const guardian = require('../guardian');
const learn = require('../guardian/dispatch-learn');
const command = require('../guardian/command');
learn.register();
command.register();
require('../guardian/capability-gaps').register();   // 撤销安装用的 removeInstalled

const tick = () => new Promise((r) => setImmediate(r));
let t_restore = () => {};

test('scene route correction: consistent reassigns become a dispatch preference (auto, undoable)', async () => {
  for (let i = 0; i < 2; i++) learn.feedback({ type: 'reassign', from: 'claude-code', to: 'codex', prompt: '帮我按 Conventional Commits 写提交信息' });
  assert.deepEqual(learn.orchestratorHints(), [], 'two times is not enough');
  learn.feedback({ type: 'reassign', from: 'cursor', to: 'codex', prompt: '写一下这次的 commit message' });
  const hints = learn.orchestratorHints().join('\n');
  assert.match(hints, /「写提交信息」这类子任务优先派给 .*codex/i);
  const rec = guardian.listRecords().find(r => r.kind === 'dispatch-pref');
  assert.equal(rec.status, 'done');
  // 主 Agent 的启动说明里带上了
  assert.match(require('../mcp-manager').orchestratorSystem(), /派发偏好/);
  assert.equal((await guardian.undo(rec.id)).ok, true);
  assert.deepEqual(learn.orchestratorHints(), []);
  assert.doesNotMatch(require('../mcp-manager').orchestratorSystem(), /派发偏好/);
});

test('scene route correction in suggest mode, mixed directions, and off', async () => {
  guardian.setSettings({ modes: { gateway: 'suggest' } });
  for (const to of ['codex', 'cursor', 'codex']) learn.feedback({ type: 'reassign', from: 'claude-code', to, prompt: '写测试用例，补单元测试' });
  assert.equal(guardian.listRecords().filter(r => r.kind === 'dispatch-pref' && r.meta.topic === 'test').length, 0, '2 of 3 is below 70% agreement');
  learn.feedback({ type: 'reassign', from: 'claude-code', to: 'codex', prompt: '给这个函数写单元测试' });
  learn.feedback({ type: 'reassign', from: 'claude-code', to: 'codex', prompt: '补一下 e2e tests' });
  const sug = guardian.listRecords().find(r => r.kind === 'dispatch-pref' && r.meta.topic === 'test');
  assert.equal(sug.status, 'suggested');
  assert.deepEqual(learn.orchestratorHints(), [], 'suggest mode waits for the user');
  assert.equal((await guardian.apply(sug.id)).ok, true);
  assert.match(learn.orchestratorHints().join('\n'), /写测试/);
  guardian.setSettings({ modes: { gateway: 'off' } });
  assert.deepEqual(learn.orchestratorHints(), []);
  assert.equal(learn.feedback({ type: 'reassign', from: 'a', to: 'b', prompt: 'x' }).skipped, true);
  guardian.setSettings({ modes: { gateway: 'auto' } });
});

test('summary review: finds omissions and unmentioned failures, then adds a summary rule', async () => {
  const d = localStats.getDb();
  const ins = d.prepare('INSERT INTO agent_tasks (id, agent_id, prompt, context, status, result, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const mk = (pid, n) => {
    ins.run(pid, 'claude-code', '做竞品分析并出报告', '{}', 'completed', JSON.stringify({ summary: `已完成竞品分析 ${n}，详见报告。` }), null, Date.now());
    ins.run(`${pid}-a`, 'codex', 'x', JSON.stringify({ parentTaskId: pid }), 'completed', JSON.stringify({ summary: '生成了 reports/compare.md 和 charts/share.png，样本 1200 条' }), null, Date.now());
    ins.run(`${pid}-b`, 'cursor', 'y', JSON.stringify({ parentTaskId: pid }), 'failed', null, 'timeout', Date.now());
  };
  mk('p1', 1);
  const r = learn.reviewSummary('p1');
  assert.deepEqual(r.causes.sort(), ['hidden-failure', 'omission']);
  assert.ok(r.findings.some(f => /reports\/compare\.md/.test(f)));
  assert.ok(r.findings.some(f => /失败/.test(f)));

  // 追问里没有纠错词：不算
  assert.equal(learn.feedback({ type: 'followup', mode: 'orchestrator', prompt: '再加一个对比维度', prevTaskId: 'p1' }).skipped, true);
  learn.feedback({ type: 'followup', mode: 'orchestrator', prompt: '你漏了图表，汇总不完整', prevTaskId: 'p1' });
  await tick();
  assert.ok(guardian.listRecords().some(x => x.kind === 'summary-review' && x.meta.taskId === 'p1'));
  assert.ok(!guardian.listRecords().some(x => x.kind === 'summary-rule'), 'one time is not a pattern yet');
  mk('p2', 2);
  learn.feedback({ type: 'redo', mode: 'orchestrator', agentId: 'claude-code', prompt: '做竞品分析并出报告', taskId: 'p2' });
  await tick();
  const rules = guardian.listRecords().filter(x => x.kind === 'summary-rule');
  assert.deepEqual(rules.map(x => x.meta.code).sort(), ['hidden-failure', 'omission']);
  assert.match(require('../mcp-manager').orchestratorSystem(), /汇总要求[\s\S]*失败 \/ 未完成/);
  assert.equal((await guardian.undo(rules[0].id)).ok, true);
  assert.equal(learn._internal.tuning().summaryRules.length, 1);
});

test('command parse: management intents, business requests, unknown', async () => {
  const cases = {
    '看护状态': 'status', '体检一下': 'check', '自省': 'introspect', '用 Codex 跑': 'runtime', '清理闲置技能': 'idle',
    '安装 anthropics/skills': 'install', '为什么 git-commit 不生效': 'diagnose', '把 git-commit 投射到 Codex': 'project',
    '把 git-commit 从 Codex 撤下': 'unproject', '把前端技能整理一下': 'tidy', '帮我写一个登录页面': 'business', '今天天气': 'unknown',
  };
  for (const [s, a] of Object.entries(cases)) assert.equal(command.parseRules(s).action, a, s);
  assert.equal(command.parseRules('把 git-commit 启用到 Claude Code 上').agent, 'claude-code');
  const p = await command.parse('诊断 nothing-here', { allowModel: false });
  assert.equal(p.action, 'unknown');
  assert.match(p.reason, /没找到/);
  assert.equal((await command.parse('看护状态', { allowModel: false })).readOnly, true);
});

test('command run: install from catalog with undo, project / unproject with undo, business, status', async () => {
  const rm = require('../resource-manager');
  rm.init();
  // 不纳管时给出明白的话
  rm.installFromCatalog('git-commit-skill');
  let r0 = await command.run(await command.parse('把 git-commit 投射到 Codex', { allowModel: false }));
  assert.equal(r0.ok, false);
  assert.match(r0.error, /还没有纳管/);
  rm.deleteResource(rm.listResources({ type: 'skill' }).find(x => x.name === 'git-commit').id, { force: true });
  const targets = require('../resource-agent-targets');
  const origT = targets.listManagedResourceAgentIds;
  targets.listManagedResourceAgentIds = () => ['codex'];
  t_restore = () => { targets.listManagedResourceAgentIds = origT; };
  let r = await command.run(await command.parse('安装 git-commit', { allowModel: false }));
  assert.equal(r.ok, true, r.error);
  const res = rm.listResources({ type: 'skill' }).find(x => x.name === 'git-commit');
  assert.ok(res);

  r = await command.run(await command.parse('把 git-commit 投射到 Codex', { allowModel: false }));
  assert.equal(r.ok, true, r.error);
  assert.ok(rm.getResource(res.id).projections.some(p => p.agentId === 'codex'));
  const projRec = guardian.listRecords().find(x => x.kind === 'command' && /启用到/.test(x.title));
  assert.equal((await guardian.undo(projRec.id)).ok, true);
  assert.ok(!rm.getResource(res.id).projections.some(p => p.agentId === 'codex'), 'undo unprojects');

  await command.run(await command.parse('把 git-commit 投射到 Codex', { allowModel: false }));
  r = await command.run(await command.parse('把 git-commit 从 Codex 撤下', { allowModel: false }));
  assert.equal(r.ok, true, r.error);
  assert.ok(!rm.getResource(res.id).projections.some(p => p.agentId === 'codex'));

  const installRec = guardian.listRecords().find(x => x.kind === 'command' && /已安装/.test(x.title));
  assert.equal((await guardian.undo(installRec.id)).ok, true);
  assert.ok(!rm.listResources({ type: 'skill' }).some(x => x.name === 'git-commit'), 'undo removes the installed skill');

  r = await command.run(await command.parse('帮我写一个登录页面', { allowModel: false }));
  assert.equal(r.link.to, '/debug');
  assert.equal(r.link.state.prompt, '帮我写一个登录页面');
  r = await command.run({ action: 'status' });
  assert.equal(r.ok, true);
  t_restore();
  r = await command.run(await command.parse('用 Codex 跑', { allowModel: false }));
  assert.equal(r.ok, false, 'codex is not managed in the test home');
});
