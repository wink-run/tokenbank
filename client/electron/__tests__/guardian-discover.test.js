'use strict';
// 发现页：能力缺口、推荐反馈（不感兴趣 / 采纳）、画像修改学习
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-discover-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });

const localStats = require('../local-stats');
assert.ok(localStats.init(path.join(HOME, '.tokenbank'), { force: true }));
require('../../cli/ipc-bridge').installElectronStub();
const guardian = require('../guardian');
const gaps = require('../guardian/capability-gaps');

function addTasks(prompts) {
  const ins = localStats.getDb().prepare('INSERT INTO agent_tasks (id, agent_id, prompt, status, created_at) VALUES (?, ?, ?, ?, ?)');
  prompts.forEach((p, i) => ins.run(`t-${Math.random()}-${i}`, 'claude-code', p, 'completed', Date.now() - i * 1000));
}

test('topics: requests and assets map to the same topic table', () => {
  assert.deepEqual(gaps.topicsOf('帮我按 Conventional Commits 写一下提交信息').map(t => t.id), ['commit']);
  assert.ok(gaps.topicsOf('写一份本周周报给老板').some(t => t.id === 'report'));
  assert.ok(gaps.topicsOf('Review this PR and list issues').some(t => t.id === 'review'));
  assert.deepEqual(gaps.topicsOf('今天天气不错'), []);
});

test('findGaps: frequent topic without owned asset; covered topics and rare topics skipped', () => {
  const requests = ['写周报', '帮我写本周周报', '整理成周报格式', 'fix this bug', '翻译成英文'];
  const owned = [{ type: 'skill', name: 'bug-hunter', description: 'debug stack traces and fix the bug' }];
  const catalog = [
    { catalogId: 'paid-report', type: 'skill', name: 'report-pro', description: '写周报', metadata: { user_recommended: true, recommender_user_id: 7 } },
    { catalogId: 'free-report', type: 'prompt', name: 'weekly', description: '周报模板', metadata: {} },
  ];
  const out = gaps.findGaps({ requests, owned, catalog });
  assert.equal(out.length, 1);
  assert.equal(out[0].topic.id, 'report');
  assert.equal(out[0].times, 3);
  assert.equal(out[0].offer.catalogId, 'free-report', 'paid items are never offered');
});

test('check: records gap with catalog offer, apply installs, undo removes, covered gap resolves', async () => {
  gaps.register();
  addTasks(['按 Conventional Commits 规范写提交信息', '帮我写 commit message', '把这些改动写成提交信息', '帮我写本周周报', '周报', '再写一版周报']);
  const r = await gaps.check();
  assert.equal(r.ok, true);
  const recs = guardian.listRecords().filter(x => x.kind === 'capability-gap');
  const commit = recs.find(x => x.meta.topic === 'commit');
  const report = recs.find(x => x.meta.topic === 'report');
  assert.ok(commit, JSON.stringify(recs.map(x => x.title)));
  assert.match(commit.title, /3 次在「写提交信息」/);
  assert.equal(commit.apply.data.catalogId, 'git-commit-skill');
  assert.equal(commit.link.state.viewTab, 'recommend');
  assert.equal(report, undefined, 'no community item → nothing the user can do, so it is not raised');

  const open = await gaps.listOpen();
  assert.equal(open.length, 1);

  assert.equal((await guardian.apply(commit.id)).ok, true);
  const rm = require('../resource-manager');
  assert.ok(rm.listResources({ type: 'skill' }).some(x => x.name === 'git-commit'));
  await gaps.check();
  assert.ok(!guardian.listRecords().some(x => x.kind === 'capability-gap' && x.meta.topic === 'commit' && x.status === 'suggested'), 'covered topic no longer a gap');

  const filled = guardian.listRecords().find(x => x.kind === 'gap-filled');
  assert.equal((await guardian.undo(filled.id)).ok, true);
  assert.ok(!rm.listResources({ type: 'skill' }).some(x => x.name === 'git-commit'), 'undo removes the installed item');
});

test('dismissed gap stays quiet for 30 days', async () => {
  await gaps.check();   // 撤销后缺口又出现
  const rec = guardian.listRecords().find(x => x.kind === 'capability-gap' && x.meta.topic === 'commit' && x.status === 'suggested');
  guardian.dismiss(rec.id);
  // 当成 10 天前忽略的：7 天的默认静默已过，缺口用 30 天
  guardian.updateRecord(rec.id, { dismissedAt: Date.now() - 10 * 864e5 });
  await gaps.check();
  assert.ok(!guardian.listRecords().some(x => x.kind === 'capability-gap' && x.meta.topic === 'commit' && x.status === 'suggested'));
});

test('a dispatched task that also shows up in the agent session counts once', () => {
  const { recentRequests } = gaps._internal;
  const before = recentRequests(0, { collect: () => ({ dialogues: [] }) }).length;
  const out = recentRequests(0, { collect: () => ({ dialogues: [
    { goal: '按 Conventional Commits 规范写提交信息', notes: [] },   // 同一条任务在会话里又出现
    { goal: '直接在 Claude Code 里问的：写个周报', notes: [] },        // 只在会话里出现
  ] }) });
  assert.equal(out.length, before + 1);
});

