'use strict';
// 四期：定期自省（路由 / 派发 / 省钱 / 新模型评估 / 规则整理 / 报告）、派发失败复盘、按场景投射、提示词增强
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-introspect-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });

const localStats = require('../local-stats');
assert.ok(localStats.init(path.join(HOME, '.tokenbank'), { force: true }));
const guardian = require('../guardian');
const store = require('../guardian/store');
const review = require('../guardian/review-usage');
const taskWatch = require('../guardian/task-watch');
const modelCall = require('../guardian/model-call');
const introspect = require('../guardian/introspect');

const now = Math.floor(Date.now() / 1000);
function req(model, provider, { n = 1, fail = 0, latency = 800, tier = 'paid', cost = 0 } = {}) {
  for (let i = 0; i < n; i++) {
    localStats.record({
      model, provider_id: provider, tier, ts: now - 60 * 60 - i, data_source: 'proxy',
      input_tokens: 100, output_tokens: 50, latency_ms: latency,
      status_code: i < fail ? 502 : 200, error: i < fail ? 'upstream' : null,
      cost_usd: cost, billing_type: tier === 'free' ? null : 'api-key', request_id: `r-${model}-${provider}-${i}-${Math.random()}`,
    });
  }
}

test('settings: introspect defaults and validation', () => {
  const s = guardian.getSettings();
  assert.equal(s.introspect.frequency, 'weekly');
  assert.equal(s.introspect.window, 'idle');
  assert.equal(s.introspect.handling, 'report');
  const n = guardian.setSettings({ introspect: { frequency: 'daily', tokenCap: -5, scope: ['routes', 'bogus'], hour: 30 } });
  assert.equal(n.introspect.frequency, 'daily');
  assert.equal(n.introspect.tokenCap, 0);
  assert.deepEqual(n.introspect.scope, ['routes']);
  assert.equal(n.introspect.hour, 23);
  assert.equal(guardian.getSettings().introspect.window, 'idle', 'untouched fields keep their value');
  guardian.setSettings({ introspect: { frequency: 'weekly', tokenCap: 20000, scope: ['assets', 'routes', 'models', 'savings', 'rules'], hour: 3 } });
});

test('route review: unstable provider with better alternative, slower duplicate, failing agent', () => {
  req('glm-5', 'prov-a', { n: 12, fail: 6 });
  req('glm-5', 'prov-b', { n: 10, fail: 0 });
  req('qwen-max', 'fast', { n: 10, latency: 500 });
  req('qwen-max', 'slow', { n: 10, latency: 2000 });
  const db = localStats.getDb();
  const ins = db.prepare('INSERT INTO agent_tasks (id, agent_id, prompt, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 6; i++) ins.run(`t${i}`, 'codex', 'fix the bug', i < 4 ? 'failed' : 'completed', i < 4 ? 'Error: not logged in' : null, Date.now() - 1000);

  const r = review.reviewRoutes({ sinceSec: now - 86400 });
  assert.ok(r.items.some(i => /glm-5/.test(i.title) && /prov-b/.test(i.advice)), 'suggests the healthier provider');
  assert.ok(r.items.some(i => /qwen-max/.test(i.title) && /快 4\.0 倍/.test(i.title)));
  assert.ok(r.items.some(i => /codex/i.test(i.title) && /没登录/.test(i.advice)), JSON.stringify(r.items.map(i => [i.title, i.advice])));
  assert.equal(r.stats.calls, 42);
  const rec = guardian.listRecords().find(x => x.signature === 'review-route|glm-5|prov-a');
  assert.equal(rec.status, 'suggested');
  assert.equal(rec.link.to, '/gateway');
});

test('savings review: concentrated paid spend with a stable free model', () => {
  req('claude-opus', 'paid-p', { n: 5, cost: 1 });
  req('deepseek-free', 'free-p', { n: 8, tier: 'free' });
  const r = review.reviewSavings({ sinceSec: now - 86400, days: 7 });
  assert.ok(r.stats.cost >= 5);
  assert.ok(r.items.some(i => /claude-opus/.test(i.title) && /deepseek-free/.test(i.advice) && /按这段时间的用量约能省 \$2\.50/.test(i.advice)));
});

test('guardian own requests (caller key tb-guardian) are left out of the review', () => {
  const before = review.reviewRoutes({ sinceSec: now - 86400 }).stats.calls;
  localStats.record({ api_key: 'tb-guardian', model: 'trial-x', provider_id: 'p', tier: 'free', ts: now - 30, data_source: 'proxy', status_code: 200, request_id: `g-${Math.random()}` });
  assert.equal(review.reviewRoutes({ sinceSec: now - 86400 }).stats.calls, before);
});

test('task failure review: classify and capability suggestion with apply/undo', async () => {
  assert.equal(taskWatch.classify('spawn codex ENOENT').kind, 'runtime-missing');
  assert.equal(taskWatch.classify('Request timed out after 600s').kind, 'timeout');
  assert.equal(taskWatch.classify('429 rate limit exceeded').kind, 'quota');
  assert.equal(taskWatch.classify("I don't have a tool to browse the web").kind, 'capability');
  assert.equal(taskWatch.classify('weird').kind, 'unknown');

  require('../../cli/ipc-bridge').installElectronStub();
  const db = localStats.getDb();
  db.prepare('INSERT INTO agent_tasks (id, agent_id, prompt, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('cap1', 'claude-code', '按 Conventional Commits 规范生成 git commit 提交信息', 'failed', 'no suitable tool', Date.now());
  await taskWatch.handleFailed({ taskId: 'cap1', agentId: 'claude-code', error: "I don't have a tool for this" });
  const info = guardian.listRecords().find(r => r.signature === 'task-fail|claude-code|capability');
  assert.equal(info.status, 'info');
  const sug = guardian.listRecords().find(r => r.kind === 'task-capability');
  assert.ok(sug, 'suggests a matching free skill');
  assert.equal(sug.meta.catalogId, 'git-commit-skill');
  assert.equal(sug.apply.type, 'installSkillFor');
  assert.ok(sug.applyUndo);
});

test('new-model evaluation: baseline first, then evaluate new models within token cap', async () => {
  const cfg = (models) => fs.writeFileSync(path.join(process.env.LLM_AGENT_CONFIG_DIR, 'config.json'),
    JSON.stringify({ providers: [{ id: 'p', base_url: 'http://x/v1', enabled: true, models }] }));
  cfg(['old-a', { name: 'emb', type: 'embedding' }]);
  const orig = modelCall.chat;
  const calls = [];
  modelCall.chat = async ({ model, messages }) => {
    calls.push(model);
    const q = messages[0].content;
    const text = /isPalindrome/.test(q) ? 'function isPalindrome(s){s=s.toLowerCase();return s}' : (/JSON/.test(q) ? '{"city":"上海","temp":18}' : '缓存击穿是热点键失效瞬间大量请求打到数据库。');
    return { ok: true, text, tokens: 120, latencyMs: 300, status: 200 };
  };
  try {
    const rm = require('../guardian/review-models');
    const first = await rm.reviewModels({ budget: { used: 0, cap: 10000 } });
    assert.equal(first.stats.baseline, 1, 'embedding models are not chat models');
    assert.equal(calls.length, 0, 'baseline run does not spend tokens');

    cfg(['old-a', 'new-b', 'new-c']);
    const budget = { used: 0, cap: 1300 }; // 够跑 3 道题 + 一点
    const second = await rm.reviewModels({ budget });
    assert.equal(second.items.length, 1, 'stops when the token cap is reached');
    assert.ok(budget.stopped);
    const rec = guardian.listRecords().find(r => r.signature === 'model-eval|new-b');
    assert.match(rec.title, /适合中文问答、写代码、结构化输出/);
    const third = await rm.reviewModels({ budget: { used: 0, cap: 10000 } });
    assert.equal(third.items.length, 1, 'continues with the remaining model next time');
    assert.ok(!calls.includes('old-a'));
  } finally {
    modelCall.chat = orig;
  }
});

test('introspect run: report with sections, rules tidy undo, schedule', async () => {
  const rules = store.readJson('rules.json', {});
  rules['old|sig'] = { count: 1, firstAt: Date.now() - 200 * 864e5, lastAt: Date.now() - 200 * 864e5 };
  rules['fresh|sig'] = { count: 1, firstAt: Date.now(), lastAt: Date.now() };
  store.writeJson('rules.json', rules);
  guardian.setSettings({ introspect: { scope: ['routes', 'savings', 'rules', 'models'], tokenCap: 0 } });
  introspect.register();

  const r = await introspect.run({ manual: true });
  assert.equal(r.ok, true);
  const rep = r.report;
  assert.ok(rep.sections.routes.items.length >= 3);
  assert.ok(rep.sections.savings);
  assert.match(rep.sections.models.summary, /上限为 0/);
  assert.equal(rep.sections.assets, undefined, 'only the chosen scope runs');
  assert.equal(rep.sections.rules.stats.removed, 1);
  assert.ok(rep.pending.count >= 3);
  assert.equal(introspect.latestReport().id, rep.id);
  assert.ok(!store.readJson('rules.json', {})['old|sig']);

  const tidy = guardian.listRecords().find(x => x.kind === 'rules-tidy');
  assert.equal((await guardian.undo(tidy.id)).ok, true);
  assert.ok(store.readJson('rules.json', {})['old|sig'], 'undo restores removed rules');

  // 刚跑过：不到期；频率关闭：永不到期
  assert.equal(introspect.isDue(), false);
  store.writeJson('introspect-state.json', { lastRunAt: Date.now() - 8 * 864e5 });
  guardian.setSettings({ introspect: { window: 'idle' } });
  assert.equal(introspect.isDue(), true);
  guardian.setSettings({ introspect: { window: 'hour', hour: (new Date().getHours() + 1) % 24 } });
  assert.equal(introspect.isDue(), false, 'waits for the chosen hour');
  guardian.setSettings({ introspect: { frequency: 'off', window: 'idle' } });
  assert.equal(introspect.isDue(), false);
});

test('scene targets: prefer apps that actually use skills', () => {
  const st = require('../guardian/scene-targets');
  assert.equal(st.preferredTargets({ resourceType: 'skill', candidates: ['cursor', 'codex'] }), null, 'no usage → caller keeps defaults');
  localStats.recordSkillCalls([
    { ts: Date.now(), agent_id: 'codex', skill_key: 'a', call_uid: 'u1' },
    { ts: Date.now(), agent_id: 'codex', skill_key: 'b', call_uid: 'u2' },
    { ts: Date.now(), agent_id: 'pi', skill_key: 'a', call_uid: 'u3' },
  ]);
  const r = st.preferredTargets({ resourceType: 'skill', candidates: ['cursor', 'pi', 'codex'] });
  assert.deepEqual(r.agentIds, ['codex', 'pi']);
  assert.equal(st.preferredTargets({ resourceType: 'mcp', candidates: ['codex'] }), null);
});

test('prompt enhance: simple prompt flagged, enhanced with undo', async () => {
  const rm = require('../resource-manager');
  rm.init();
  rm.saveResource({ type: 'prompt', name: 'tiny', display_name: 'tiny', content: '帮我写周报' });
  const res = rm.listResources({ type: 'prompt' }).find(r => r.name === 'tiny');
  const d = require('../guardian/diagnose').diagnoseResource(res.id);
  assert.ok(d.findings.some(f => f.code === 'p-simple' && f.fix.type === 'enhancePrompt'));
  const orig = modelCall.chat;
  modelCall.chat = async () => ({ ok: true, text: '你是一名项目助理。根据 {{本周完成事项}} 写一份周报：分为完成、进行中、风险、下周计划四部分，每部分用要点列出。', tokens: 80 });
  try {
    const r = await require('../guardian/diagnose').fixResource(res.id, 'enhancePrompt');
    assert.equal(r.success, true, r.error);
  } finally {
    modelCall.chat = orig;
  }
  assert.match(rm.getResource(res.id).content, /项目助理/);
  require('../guardian/asset-checks').register();
  const done = guardian.listRecords().find(x => x.kind === 'prompt-enhanced');
  assert.equal((await guardian.undo(done.id)).ok, true);
  assert.equal(rm.getResource(res.id).content, '帮我写周报');
});
