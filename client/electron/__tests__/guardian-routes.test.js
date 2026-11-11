'use strict';
// 路由检查（总失败 / 明显更慢的来源排到后面）、任务失败分类与补能力建议、按场景投射、提示词增强
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

test('guardian own requests (caller key tb-guardian) are left out of the review', async () => {
  const before = (await review.reviewRoutes({ sinceSec: now - 86400 })).stats.calls;
  localStats.record({ api_key: 'tb-guardian', model: 'trial-x', provider_id: 'p', tier: 'free', ts: now - 30, data_source: 'proxy', status_code: 200, request_id: `g-${Math.random()}` });
  assert.equal((await review.reviewRoutes({ sinceSec: now - 86400 })).stats.calls, before);
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
