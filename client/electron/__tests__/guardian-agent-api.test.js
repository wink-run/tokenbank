'use strict';
// 内置看护智能体就是看护本身：对话里通过本机接口做看护页上能做的一切
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-api-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });

const localStats = require('../local-stats');
assert.ok(localStats.init(path.join(HOME, '.tokenbank'), { force: true }));
require('../../cli/ipc-bridge').installElectronStub();
const guardian = require('../guardian');
const api = require('../guardian/agent-api');
require('../guardian/judgment').register();

test('operations: records, act / undo / dismiss, settings, unknown op', async () => {
  guardian.registerAction('t-fix', () => ({ ok: true, message: 'fixed', undo: { type: 't-unfix' } }));
  guardian.registerAction('t-unfix', () => ({ ok: true }));
  const a = guardian.record({ category: 'assets', kind: 'k-a', status: 'info', title: 'A', signature: 'a', actions: [{ label: 'Fix', run: { type: 't-fix' } }] });
  const b = guardian.record({ needsUser: true, category: 'assets', kind: 'k-b', status: 'info', title: 'B', signature: 'b' });
  let r = await api.handle('records', { open: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.records.find(x => x.id === a.id).actions, [{ index: 0, label: 'Fix' }]);
  r = await api.handle('act', { id: a.id, index: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.message, 'fixed');
  assert.equal((await api.handle('records', {})).records.find(x => x.id === a.id).canUndo, true);
  assert.equal((await api.handle('undo', { id: a.id })).ok, true);
  assert.equal((await api.handle('dismiss', { id: b.id })).ok, true);
  assert.equal(guardian.listRecords().find(x => x.id === b.id).status, 'dismissed');
  r = await api.handle('settings', { set: { modes: { assets: 'suggest' } } });
  assert.equal(r.settings.modes.assets, 'suggest');
  assert.equal((await api.handle('status')).ok, true);
  assert.match((await api.handle('rm-rf')).error, /没有这个操作/);
  guardian.setSettings({ modes: { assets: 'auto' } });
});

test('a rule the user asked for in the chat takes effect at once (even in suggest mode) and can be undone', async () => {
  guardian.setSettings({ modes: { projection: 'suggest' } });
  const facts = { resourceId: 'res-skill-huashu-nuwa', agentId: 'workbuddy', resourceName: 'huashu-nuwa', projectionType: 'symlink', targetPath: '/h/.workbuddy/skills/huashu-nuwa', targetExists: true, targetIsSymlink: true, targetRealPath: '/h/.tokenbank/skills/nuwa-skill', targetRealHasSkillMd: true, authorityPath: '/h/.claude/skills/huashu-nuwa', authorityPathIsSymlink: true, sourceUrl: '', sourceUrlExists: false };
  const open = guardian.record({ needsUser: true, category: 'projection', kind: 'projection-unrepairable', status: 'info', title: '「huashu-nuwa」在 WorkBuddy 里用不了', signature: 'proj-x|h|workbuddy', facts });
  const r = await api.handle('learn', { rule: {
    kind: 'projection-unrepairable', verdict: 'ignore', source: 'user', reason: '应用里是指向真身的软链，真身完好',
    when: { all: [{ fact: 'targetIsSymlink', op: 'eq', value: true }, { fact: 'targetRealHasSkillMd', op: 'eq', value: true }] },
  } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.adopted, true);
  assert.equal(guardian.listRecords({ limit: 300 }).find(x => x.id === open.id).status, 'resolved', 'the notice is closed right away');
  assert.equal(guardian.record({ needsUser: true, category: 'projection', kind: 'projection-unrepairable', status: 'info', title: 'again', signature: 'proj-x|h|workbuddy', facts }), null, 'not raised again');
  const rec = guardian.listRecords().find(x => x.kind === 'judgment-rule' && x.status === 'done');
  assert.equal((await guardian.undo(rec.id)).ok, true);
  assert.ok(guardian.record({ needsUser: true, category: 'projection', kind: 'projection-unrepairable', status: 'info', title: 'back', signature: 'proj-x|h|workbuddy', facts }), 'undo brings it back');
  assert.equal((await api.handle('rules')).rules.length, 0);
  guardian.setSettings({ modes: { projection: 'auto' } });
});

test('the local endpoint: token required, and the helper script the agent runs works', async () => {
  api.start();
  for (let i = 0; i < 50 && !fs.existsSync(api.infoPath()); i++) await new Promise(r => setTimeout(r, 20));
  const info = JSON.parse(fs.readFileSync(api.infoPath(), 'utf8'));
  assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const bad = await fetch(`${info.url}/op`, { method: 'POST', body: '{"op":"status"}', headers: { Authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);
  const out = await new Promise((resolve, reject) => {
    require('child_process').execFile(process.execPath, [api.helperPath(), 'records', '{"open":true}'], (e, so) => (e ? reject(e) : resolve(so)));
  });
  assert.equal(JSON.parse(out).ok, true);
  const guide = api.agentGuide();
  assert.match(guide, /tb-guardian\.js/);
  for (const op of ['act', 'undo', 'dismiss', 'check', 'settings', 'runtime', 'diagnose', 'command', 'learn', 'forget']) assert.match(guide, new RegExp(`- ${op}：`));
  api.stop();
  void execFileSync;
});

test('the agent knows it is the guardian itself and acts directly', () => {
  const text = require('../guardian/chat').systemText();
  assert.match(text, /你就是 Token Bank 的看护（自我进化）本身/);
  assert.match(text, /直接用 learn 学一条规则（不用问）/);
  assert.match(text, /node ".*tb-guardian\.js"/);
});
