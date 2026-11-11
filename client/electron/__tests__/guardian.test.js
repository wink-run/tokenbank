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

