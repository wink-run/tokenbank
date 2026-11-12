'use strict';
// 网关页应用列表要的数据：每个智能体今天的任务、应用今天的花费和用到的来源、要用户处理的来源问题
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-gw-app-list-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });

const localStats = require('../local-stats');
assert.ok(localStats.init(path.join(HOME, '.tokenbank'), { force: true }));
require('../../cli/ipc-bridge').installElectronStub();
const executor = require('../agent-executor');
const gw = require('../guardian/gateway-watch');

test('today task stats are also split per agent: tasks, succeeded, average time', () => {
  const db = localStats.getDb();
  const now = Date.now();
  const ins = db.prepare('INSERT INTO agent_tasks (id, agent_id, prompt, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('t1', 'assistant:weekly', 'p', 'completed', now - 5000, now - 1000);
  ins.run('t2', 'assistant:weekly', 'p', 'failed', now - 4000, now - 2000);
  ins.run('t3', 'codex', 'p', 'running', now - 3000, null);
  ins.run('t0', 'codex', 'p', 'completed', now - 3 * 86400 * 1000, now - 3 * 86400 * 1000 + 10);   // 不是今天
  const st = executor.todayTaskStats();
  assert.equal(st.tasks, 3);
  assert.equal(st.failed, 1);
  assert.deepEqual(st.by_agent['assistant:weekly'], { tasks: 2, ok: 1, running: 0, failed: 1, avg_duration_ms: 4000 });
  assert.equal(st.by_agent.codex.tasks, 1);
  assert.equal(st.by_agent.codex.running, 1);
});

test("an app's today stats carry its cost and the sources it used", () => {
  localStats.record({ api_key: 'k1', app_id: 'app-a', model: 'm1', provider_id: 'deepseek', tier: 'free', tokens: 10, input_tokens: 6, output_tokens: 4, data_source: 'proxy' });
  localStats.record({ api_key: 'k1', app_id: 'app-a', model: 'm1', provider_id: 'silicon', tier: 'free', tokens: 10, input_tokens: 6, output_tokens: 4, data_source: 'proxy' });
  const s = localStats.queryAppStatsToday({ appId: 'app-a', apiKey: 'k1' });
  assert.equal(s.calls, 2);
  assert.deepEqual(s.providers.sort(), ['deepseek', 'silicon']);
  assert.deepEqual(s.models, ['m1']);
  assert.equal(typeof s.cost, 'number');
});

test('a source with a bad key is remembered for the app list until it succeeds again', async () => {
  await gw.handleFailure('cooldown', { providerId: 'deepseek', providerLabel: 'DeepSeek', model: 'm1', status: 401, message: 'invalid api key' });
  const issues = gw.providerIssues();
  assert.equal(issues.deepseek.kind, 'auth');
  assert.deepEqual(issues.deepseek.models, ['m1']);
  assert.match(issues.deepseek.text, /DeepSeek.*Key 失效/);
  await gw.handleFailure('cooldown', { providerId: 'silicon', providerLabel: '硅基', model: 'm1', status: 402, message: 'insufficient quota' });
  assert.equal(gw.providerIssues().silicon.kind, 'quota');
  // 不需要用户动手的报错不记
  await gw.handleFailure('cooldown', { providerId: 'other', model: 'm1', status: 500, message: 'internal error' });
  assert.equal(gw.providerIssues().other, undefined);
  gw.noteSuccess({ providerId: 'deepseek', model: 'm1' });
  assert.equal(gw.providerIssues().deepseek, undefined);
  assert.ok(gw.providerIssues().silicon);
});

test("agents projected onto an app that can't run are listed with the reason", () => {
  const rm = require('../resource-manager');
  rm.init();
  const orig = rm.listResources.bind(rm);
  rm.listResources = ({ type } = {}) => {
    if (type === 'skill') return [{ id: 'res-skill-weekly', name: 'weekly-digest' }];
    if (type === 'assistant') return [
      { id: 'a-ok', name: 'ok', projections: [{ agentId: 'codex' }], content: JSON.stringify({ skills: ['weekly-digest'], runtime_agent: 'codex' }) },
      { id: 'a-lost', name: 'db-check', projections: [{ agentId: 'codex' }], content: JSON.stringify({ skills: ['weekly-digest', 'sql-check'], runtime_agent: 'codex' }) },
      { id: 'a-noapp', name: 'reviewer', projections: [{ agentId: 'claude-code' }], content: JSON.stringify({ runtime_agent: 'claude-code' }) },
      { id: 'a-none', name: 'not-projected', projections: [], content: '{}' },
    ];
    return [];
  };
  try {
    executor._launchableCliIds = new Set(['codex']);
    const out = executor.listBlockedAssistants();
    const byId = Object.fromEntries(out.map(x => [x.resourceId, x]));
    assert.equal(byId['a-ok'], undefined);
    assert.equal(byId['a-none'], undefined);
    assert.equal(byId['a-lost'].reason, 'skills');
    assert.deepEqual(byId['a-lost'].missing, ['sql-check']);
    assert.equal(byId['a-lost'].runtimeAgentId, 'codex');
    // 投射的应用没装，但还有别的能跑的命令行：会换到那个上面跑，不算跑不起来
    assert.equal(byId['a-noapp'], undefined);
    executor._launchableCliIds = new Set();
    const none = Object.fromEntries(executor.listBlockedAssistants().map(x => [x.resourceId, x]));
    assert.equal(none['a-noapp'].reason, 'runtime');
    assert.equal(none['a-noapp'].runtimeAgentId, 'claude-code');
    assert.equal(none['a-lost'].reason, 'runtime');
  } finally {
    rm.listResources = orig;
  }
});

test('per-app usage for one day starts at local midnight, like the dashboard total', () => {
  const db = localStats.getDb();
  const now = Math.floor(Date.now() / 1000);
  const midnight = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); })();
  const ins = db.prepare("INSERT INTO requests (ts, model, app_id, data_source, input_tokens, output_tokens, cache_create_tokens, cache_read_tokens, status_code) VALUES (?, 'm', 'app-day', 'proxy', 1, 1, 0, 0, 200)");
  ins.run(now - 10);
  ins.run(midnight - 60); // 昨天最后一分钟：今天不该算进来
  const st = localStats.queryAppStatsInPeriod({ appId: 'app-day', days: 1 });
  assert.equal(st.calls, 1);
  const wide = localStats.queryAppStatsInPeriod({ appId: 'app-day', days: 2 });
  assert.equal(wide.calls, 2);
});

test("the butler's own model calls stay on the user's own sources", () => {
  // 后台自己判断时不能花社区积分：默认路由只走个人来源
  assert.equal(require('../guardian/model-call').DEFAULT_MODEL, 'auto:personal');
});

test('codex exit message skips the start event and config warnings and shows the real error', () => {
  const { formatAgentExitError } = require('../agent-output-parser');
  const warn = '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Codex is ignoring 1 unrecognized configuration setting. Check for typos or deprecated settings."}}';
  const stdout = ['{"type":"thread.started","thread_id":"x"}', warn, '{"type":"error","message":"stream disconnected before completion: model gpt-9 not found"}'].join('\n');
  const msg = formatAgentExitError('', stdout, 1, 'codex');
  assert.match(msg, /model gpt-9 not found/);
  assert.doesNotMatch(msg, /thread\.started|unrecognized configuration/);
});
