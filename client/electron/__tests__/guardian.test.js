'use strict';
// 内置看护：记录 / 撤销 / 模式、报错解读、安装修复、投射自愈、诊断
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');

const guardian = require('../guardian');
const explain = require('../guardian/explain');
const installFix = require('../guardian/install-fix');

test('records dedupe by signature and keep a count', () => {
  const a = guardian.record({ category: 'gateway', kind: 'x', status: 'info', title: 't', signature: 'sig-1' });
  const b = guardian.record({ category: 'gateway', kind: 'x', status: 'info', title: 't', signature: 'sig-1' });
  assert.equal(a.id, b.id);
  assert.equal(guardian.listRecords().find(r => r.id === a.id).count, 2);
});

test('undo runs the registered action and marks the record', async () => {
  let undone = null;
  guardian.registerAction('test-undo', (d) => { undone = d; return { ok: true }; });
  const r = guardian.record({ category: 'projection', kind: 'k', status: 'done', title: 'did it', undo: { type: 'test-undo', data: { n: 1 } } });
  const res = await guardian.undo(r.id);
  assert.equal(res.ok, true);
  assert.deepEqual(undone, { n: 1 });
  assert.equal(guardian.listRecords().find(x => x.id === r.id).status, 'undone');
  assert.equal((await guardian.undo(r.id)).ok, false, 'cannot undo twice');
});

test('apply turns a suggestion into done', async () => {
  guardian.registerAction('test-apply', () => ({ ok: true }));
  const r = guardian.record({ category: 'projection', kind: 'k', status: 'suggested', title: 'fix?', apply: { type: 'test-apply' } });
  assert.equal((await guardian.apply(r.id)).ok, true);
  assert.equal(guardian.listRecords().find(x => x.id === r.id).status, 'done');
});

test('in-place actions: pick a button on the record, failure keeps it open, undo from the action result', async () => {
  let ran = null;
  let undone = null;
  guardian.registerAction('test-pick', (d) => { ran = d; return { ok: true, message: 'done it', undo: { type: 'test-pick-undo', data: { back: d.which } } }; });
  guardian.registerAction('test-pick-undo', (d) => { undone = d; return { ok: true }; });
  guardian.registerAction('test-fail', () => ({ ok: false, error: 'nope' }));
  const r = guardian.record({
    category: 'assets', kind: 'k', status: 'info', title: 'pick one',
    actions: [{ label: 'A', run: { type: 'test-fail' } }, { label: 'B', done: 'B done', run: { type: 'test-pick', data: { which: 'b' } } }],
  });
  assert.equal((await guardian.act(r.id, 0)).ok, false);
  let cur = guardian.listRecords().find(x => x.id === r.id);
  assert.equal(cur.status, 'info');
  assert.equal(cur.lastError, 'nope');
  assert.equal((await guardian.act(r.id, 1)).ok, true);
  cur = guardian.listRecords().find(x => x.id === r.id);
  assert.equal(cur.status, 'done');
  assert.equal(cur.actedLabel, 'B done');
  assert.equal(cur.resultNote, 'done it');
  assert.deepEqual(ran, { which: 'b' });
  assert.equal((await guardian.act(r.id, 1)).ok, false, 'already handled');
  assert.equal((await guardian.undo(r.id)).ok, true);
  assert.deepEqual(undone, { back: 'b' });
});

test('handle: auto mode does safe undoable fixes right away; suggest mode waits; an undo is respected', async () => {
  let n = 0;
  guardian.registerAction('test-auto', () => { n++; return { ok: true, message: 'fixed', undo: { type: 'test-auto-undo' } }; });
  guardian.registerAction('test-auto-undo', () => ({ ok: true }));
  const entry = () => ({
    category: 'assets', kind: 'k', status: 'info', title: 'safe fix', signature: 'auto-sig',
    actions: [{ label: 'Fix', done: 'Fixed', auto: true, run: { type: 'test-auto' } }, { label: 'Other', run: { type: 'test-auto' } }],
  });
  guardian.setSettings({ modes: { assets: 'suggest' } });
  let r = await guardian.handle(entry());
  assert.equal(r.status, 'info');
  assert.equal(n, 0);
  guardian.setSettings({ modes: { assets: 'auto' } });
  r = await guardian.handle(entry());
  assert.equal(r.status, 'done');
  assert.equal(r.actedLabel, 'Fixed');
  assert.equal(r.resultNote, 'fixed');
  assert.equal(r.auto, true);
  assert.equal(n, 1);
  assert.equal(guardian.listRecords().filter(x => x.signature === 'auto-sig' && x.status === 'info').length, 0, 'the open suggestion is closed');
  assert.equal((await guardian.undo(r.id)).ok, true);
  r = await guardian.handle(entry());
  assert.equal(r.status, 'info', 'user undid it once → only suggest from now on');
  assert.equal(n, 1);
  // 没有 auto 按钮的（比如要用户做判断的）照常等用户点
  r = await guardian.handle({ category: 'assets', kind: 'k', status: 'info', title: 'judgement', signature: 'judge', actions: [{ label: 'A', run: { type: 'test-auto' } }] });
  assert.equal(r.status, 'info');
  assert.equal(n, 1);
});

test('modes: per category and global switch', () => {
  guardian.setSettings({ modes: { projection: 'suggest' } });
  assert.equal(guardian.modeOf('projection'), 'suggest');
  guardian.setSettings({ enabled: false });
  assert.equal(guardian.modeOf('gateway'), 'off');
  guardian.setSettings({ enabled: true, modes: { projection: 'auto', bogus: 'auto' } });
  assert.equal(guardian.modeOf('projection'), 'auto');
  assert.equal(guardian.getSettings().modes.bogus, undefined);
});

test('explain: known gateway errors map to a cause and a fix', () => {
  assert.equal(explain.classify({ status: 401, message: 'Unauthorized' }).kind, 'auth');
  assert.equal(explain.classify({ status: 402 }).kind, 'quota');
  assert.equal(explain.classify({ status: 400, message: 'You exceeded your current quota' }).kind, 'quota');
  assert.equal(explain.classify({ status: 429 }).kind, 'rate');
  assert.equal(explain.classify({ status: 400, message: "This model's maximum context length is 8192" }).kind, 'context');
  assert.equal(explain.classify({ message: 'connect ECONNREFUSED 127.0.0.1:9' }).kind, 'network');
  assert.equal(explain.classify({ status: 503 }).kind, 'upstream');
  assert.equal(explain.classify({ status: 418, message: 'teapot' }).kind, 'unknown');
  // 未知报错按规整后的内容归类，去掉 id 和数字
  assert.equal(
    explain.signatureOf({ providerId: 'p', status: 418, message: 'req_abc123 failed at 12:00' }, 'unknown'),
    explain.signatureOf({ providerId: 'p', status: 418, message: 'req_zzz999 failed at 13:30' }, 'unknown'),
  );
});

test('gateway failure becomes one explained record; off mode records nothing', async () => {
  guardian.setSettings({ modelExplainPerDay: 0 });
  const watch = require('../guardian/gateway-watch');
  await watch.handleFailure('cooldown', { providerId: 'deepseek', providerLabel: 'DeepSeek', model: 'm', status: 402, message: 'Insufficient Balance' });
  await watch.handleFailure('request-failed', { providerId: 'deepseek', providerLabel: 'DeepSeek', model: 'm', status: 402, message: 'Insufficient Balance' });
  const recs = guardian.listRecords().filter(r => r.category === 'gateway' && r.meta?.providerId === 'deepseek');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].kind, 'quota-alert');
  assert.equal(recs[0].count, 2);
  assert.match(recs[0].title, /额度/);

  guardian.setSettings({ modes: { gateway: 'off' } });
  await watch.handleFailure('cooldown', { providerId: 'other', status: 401 });
  assert.equal(guardian.listRecords().filter(r => r.meta?.providerId === 'other').length, 0);
  guardian.setSettings({ modes: { gateway: 'auto' } });
});

test('install: leftover staging is cleaned and retried once', async () => {
  let calls = 0;
  let swept = false;
  const r = await installFix.installWithRepair({
    id: 'pi', name: 'Pi', pkg: 'x',
    attempt: async () => (++calls === 1 ? { ok: false, error: 'npm ERR! code ENOTEMPTY' } : { ok: true }),
    sweep: async () => { swept = true; },
  });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
  assert.equal(swept, true);
  assert.equal(r.guardian.kind, 'staging');
  assert.ok(guardian.listRecords().some(x => x.kind === 'install-repaired'));
});

test('install: permission errors are not retried but explained', async () => {
  let calls = 0;
  const r = await installFix.installWithRepair({
    id: 'claude-code', pkg: 'y',
    attempt: async () => { calls++; return { ok: false, error: 'npm ERR! code EACCES permission denied' }; },
  });
  assert.equal(r.ok, false);
  assert.equal(calls, 1);
  assert.equal(r.guardian.kind, 'permission');
  assert.match(r.guardian.advice, /prefix/);
});

test('projection self-heal repairs a broken skill link and can undo it', async () => {
  // 纳管 Claude Code（shim），保证有可投射目标
  fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLM_AGENT_CONFIG_DIR, 'local-config.json'),
    JSON.stringify({ apps: [{ id: 'app-cc', agent_id: 'claude-code', link_method: 'shim', name: 'Claude Code' }] }));
  const targets = require('../resource-agent-targets');
  if (!targets.isAgentInstalled('claude-code')) return; // 无 Claude Code 的环境跳过（CI 机器）
  require('../../cli/ipc-bridge').installElectronStub();
  require('../mcp-gateway-targets').setAppsGetter(() => JSON.parse(fs.readFileSync(path.join(process.env.LLM_AGENT_CONFIG_DIR, 'local-config.json'), 'utf8')).apps);

  const rm = require('../resource-manager');
  rm.init();
  const saved = rm.saveResource({ type: 'skill', name: 'heal-me', display_name: 'Heal', description: 'heal test skill for guardian', content: '---\nname: heal-me\ndescription: heal test skill for guardian\n---\n# x' });
  const id = saved.resource.id;
  const proj = rm.projectToAgents(id, ['claude-code'], 'global', {});
  assert.equal(proj.success, true, proj.error);
  const link = path.join(HOME, '.claude', 'skills', 'heal-me');
  assert.ok(fs.existsSync(link));
  fs.rmSync(link, { recursive: true, force: true });   // 模拟应用升级清掉了技能目录

  const diagBefore = require('../guardian/diagnose').diagnoseResource(id);
  assert.ok(diagBefore.findings.some(f => f.code === 'broken-missing' && f.fix?.type === 'repair'));

  guardian.setSettings({ modes: { projection: 'auto' } });
  const res = await require('../guardian/projection-heal').check();
  assert.equal(res.repaired, 1);
  assert.ok(fs.existsSync(link), 'link restored');
  const rec = guardian.listRecords().find(r => r.kind === 'projection-repaired' && r.meta?.resourceId === id);
  assert.ok(rec);

  require('../guardian/projection-heal').register();
  assert.equal((await guardian.undo(rec.id)).ok, true);
  assert.ok(!(rm.getResource(id).projections || []).some(p => p.agentId === 'claude-code'), 'undo removes the Claude Code projection');

  const diagAfter = require('../guardian/diagnose').diagnoseResource(id);
  assert.ok(diagAfter.findings.some(f => f.code === 'not-projected'));
});

test('install: network errors are explained without an extra retry (npm already retried)', async () => {
  let calls = 0;
  const r = await installFix.installWithRepair({
    id: 'pi', pkg: 'z',
    attempt: async () => { calls++; return { ok: false, error: 'npm error code ECONNREFUSED\nnpm error FetchError: request failed' }; },
  });
  assert.equal(calls, 1);
  assert.equal(r.guardian.kind, 'network');
  assert.ok(guardian.listRecords().some(x => x.kind === 'install-failed' && x.meta?.cause === 'network'));
});

test('low attention: only real decisions need the user; one click handles the recommended fixes; FYI notices expire', async () => {
  const before = guardian.summary();
  let ran = 0;
  guardian.registerAction('la-fix', () => { ran++; return { ok: true, undo: { type: 'la-undo' } }; });
  guardian.registerAction('la-undo', () => ({ ok: true }));
  const withFix = guardian.record({ category: 'assets', kind: 'la-dup', status: 'info', title: 'dup', signature: 'la-1', actions: [{ label: 'Fix', run: { type: 'la-fix' } }, { label: 'Other', run: { type: 'la-fix' } }] });
  const fyi = guardian.record({ category: 'community', kind: 'la-share', status: 'suggested', title: 'share?', signature: 'la-2', link: { to: '/resources' } });
  const setup = guardian.record({ category: 'setup', kind: 'la-setup', status: 'suggested', title: 'no model', signature: 'la-3', link: { to: '/providers' } });
  const think = guardian.record({ category: 'assets', kind: 'judgment-rule', status: 'suggested', title: 'broad rule', signature: 'la-4', _judged: true, actions: [{ label: 'Adopt', run: { type: 'la-fix' } }] });
  assert.equal(guardian.needsUser(withFix), true);
  assert.equal(guardian.needsUser(fyi), false, 'a share tip is only FYI');
  assert.equal(guardian.needsUser(setup), true, 'missing setup needs the user');
  const s = guardian.summary();
  assert.equal(s.decide - before.decide, 3);
  assert.equal(s.fyi - before.fyi, 1);
  assert.equal(s.recommendable - before.recommendable, 1, 'rules that need thought are not batch-handled');

  const r = await guardian.actRecommended();
  assert.ok(r.done >= 1);
  assert.equal(guardian.listRecords({ limit: 300 }).find(x => x.id === withFix.id).status, 'done');
  assert.equal(guardian.listRecords({ limit: 300 }).find(x => x.id === think.id).status, 'suggested', 'left for the user');
  assert.equal((await guardian.undo(withFix.id)).ok, true, 'batch fixes stay undoable');

  // 供参考的 14 天没人理 → 自动收起；要你定的不过期
  const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
  guardian.updateRecord(fyi.id, { lastAt: old, at: old });
  guardian.updateRecord(setup.id, { lastAt: old, at: old });
  assert.ok(guardian.tidy().expired >= 1);
  assert.equal(guardian.listRecords({ limit: 300 }).find(x => x.id === fyi.id).status, 'resolved');
  assert.equal(guardian.listRecords({ limit: 300 }).find(x => x.id === setup.id).status, 'suggested');
});
