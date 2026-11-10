'use strict';
// 误报：根因修复（登记的原文件位置是软链）+ 判断规则（数据，不发版本就能改进判断）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-judgment-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });

const guardian = require('../guardian');
const judgment = require('../guardian/judgment');
const canonical = require('../resource-canonical');
const { verifyProjection } = require('../resource-projector');
judgment.register();

const md = (name) => `---\nname: ${name}\ndescription: "x"\n---\n# ${name}\n`;

test('authority path recorded as a symlink: follow it to the real skill instead of reporting it missing', () => {
  // 真身 ~/.tokenbank/skills/nuwa-skill；应用里 ~/.claude/skills/huashu-nuwa 是指向它的软链
  const real = path.join(HOME, '.tokenbank', 'skills', 'nuwa-skill');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'SKILL.md'), md('huashu-nuwa'));
  const link = path.join(HOME, '.claude', 'skills', 'huashu-nuwa');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  const resource = {
    type: 'skill', name: 'huashu-nuwa',
    source_url: path.join(real, 'SKILL.md'),
    metadata: { authorityPath: link, scannedFrom: link },
  };
  assert.equal(canonical.resolveAuthorityDir(resource), fs.realpathSync(real));
  assert.equal(verifyProjection(resource, 'claude-code', 'symlink', link).healthy, true);
  // 扫描型投射（应用目录被当成原位置），后来换成了软链：真身在就健康
  assert.equal(verifyProjection(resource, 'codex', 'scan', link).healthy, true);
  // 真的没了才报
  const gone = { type: 'skill', name: 'gone', metadata: { authorityPath: path.join(HOME, 'nope') } };
  assert.equal(canonical.resolveAuthorityDir(gone), null);
  assert.equal(verifyProjection(gone, 'codex', 'scan', path.join(HOME, 'nope')).reason, 'authority-missing');
});

test('rules: validation refuses unknown kinds, facts and empty conditions', () => {
  assert.match(judgment.validate({ kind: 'nope', when: { all: [{ fact: 'x', op: 'eq', value: 1 }] }, reason: 'r' }).error, /不认识/);
  assert.match(judgment.validate({ kind: 'projection-gone', when: { all: [] }, reason: 'r' }).error, /至少要有一个条件/);
  assert.match(judgment.validate({ kind: 'projection-gone', when: { all: [{ fact: 'evil', op: 'eq', value: 1 }] }, reason: 'r' }).error, /没有事实/);
  assert.match(judgment.validate({ kind: 'projection-gone', when: { all: [{ fact: 'targetIsSymlink', op: 'exec', value: 1 }] }, reason: 'r' }).error, /不支持/);
  assert.match(judgment.validate({ kind: 'projection-gone', when: { all: [{ fact: 'targetIsSymlink', op: 'eq', value: true }] } }).error, /reason/);
  assert.equal(judgment.validate({ kind: 'projection-gone', when: { all: [{ fact: 'targetIsSymlink', op: 'eq', value: true }] }, reason: 'ok' }).ok, true);
});

test('a proposed rule is checked, adopted (undoable) and closes the false positives it covers', async () => {
  const fp = { agentId: 'codex', resourceName: 'apple-design', projectionType: 'scan', targetPath: '/x/apple-design', targetExists: true, targetIsSymlink: true, targetRealPath: '/r/apple-design', targetRealHasSkillMd: true, authorityPath: '/x/apple-design', authorityPathIsSymlink: true, sourceUrl: '', sourceUrlExists: false };
  const real = { ...fp, resourceName: 'agent-sdk-x', targetExists: false, targetIsSymlink: false, targetRealPath: '', targetRealHasSkillMd: false };
  // 看护先后见过这几条（误报 1 条 + 真没了 2 条）
  assert.equal(judgment.judge('projection-gone', fp), null);
  judgment.judge('projection-gone', real);
  judgment.judge('projection-gone', { ...real, resourceName: 'apps-y' });
  const open = guardian.record({ needsUser: true, category: 'projection', kind: 'projection-unrepairable', status: 'info', title: '「apple-design」在 Codex 里用不了', signature: 'proj-x|a|codex|authority-missing', facts: fp });
  void open;

  // 智能体写的提议（误报只排除「是软链且真身有 SKILL.md」这一种）
  fs.mkdirSync(judgment.inboxDir(), { recursive: true });
  fs.writeFileSync(path.join(judgment.inboxDir(), 'p1.json'), JSON.stringify({
    kind: 'projection-unrepairable', reason: '应用里是指向真身的软链、真身完好，不算原文件丢失', source: 'agent',
    when: { all: [{ fact: 'targetIsSymlink', op: 'eq', value: true }, { fact: 'targetRealHasSkillMd', op: 'eq', value: true }] },
  }));
  fs.writeFileSync(path.join(judgment.inboxDir(), 'bad.json'), '{ not json');
  const r = await judgment.takeProposals();
  assert.equal(r.taken, 2);
  assert.ok(fs.existsSync(path.join(judgment.inboxDir(), 'p1.json.taken')), 'processed proposals are kept, not re-read');
  const rec = guardian.listRecords().find(x => x.kind === 'judgment-rule');
  assert.equal(rec.status, 'done', 'auto mode adopts a narrow rule');
  assert.equal(rec.auto, true);
  assert.match(fs.readFileSync(path.join(judgment.inboxDir(), 'bad.json.rejected'), 'utf8'), /JSON/, 'the reason is left next to the proposal for the agent');
  assert.ok(!guardian.listRecords().some(x => x.kind === 'judgment-rejected'), 'the user is not bothered with it');
  assert.equal(judgment.rules().length, 1);
  // 采纳后：这条误报的提醒被收起；同类真问题照报
  assert.equal(guardian.listRecords({ limit: 300 }).find(x => x.signature === 'proj-x|a|codex|authority-missing').status, 'resolved');
  assert.ok(judgment.judge('projection-unrepairable', fp));
  assert.equal(judgment.judge('projection-unrepairable', real), null);
  // 撤销 → 规则没了
  assert.equal((await guardian.undo(rec.id)).ok, true);
  assert.equal(judgment.rules().length, 0);
  assert.equal(judgment.judge('projection-unrepairable', fp), null);
});

test('adopting a rule closes a grouped notice even when it also lists the asset library\'s own copy', async () => {
  const internal = [...require('../guardian/diagnose').INTERNAL_TARGETS][0];
  const app = { agentId: 'codex', resourceName: 'kept', projectionType: 'symlink', targetPath: '/x', targetExists: true, targetIsSymlink: true, targetRealPath: '', targetRealHasSkillMd: false, authorityPath: '', authorityPathIsSymlink: false, sourceUrl: '', sourceUrlExists: false };
  guardian.record({ needsUser: true, category: 'projection', kind: 'projection-gone', status: 'suggested', title: '「kept」的原文件已被删除', signature: 'proj-gone', factsList: [app, { ...app, agentId: internal }] });
  fs.writeFileSync(path.join(judgment.inboxDir(), 'p3.json'), JSON.stringify({
    kind: 'projection-gone', reason: '用户有意移走的', when: { all: [{ fact: 'resourceName', op: 'eq', value: 'kept' }] },
  }));
  await judgment.takeProposals();
  assert.equal(guardian.listRecords({ limit: 300 }).find(x => x.signature === 'proj-gone').status, 'resolved');
});

test('a rule that would hide every notice of its kind waits for the user', async () => {
  for (const n of ['a', 'b', 'c']) judgment.judge('asset-duplicate', { nameA: n, nameB: `${n}2`, similarity: 0.9, sameRealDir: false });
  fs.writeFileSync(path.join(judgment.inboxDir(), 'p2.json'), JSON.stringify({
    kind: 'asset-duplicate', reason: '相似度 0.9 都不算', when: { all: [{ fact: 'similarity', op: 'gt', value: 0.5 }] },
  }));
  const before = judgment.rules().length;
  await judgment.takeProposals();
  const rec = guardian.listRecords().find(x => x.kind === 'judgment-rule' && /asset-duplicate|重复/.test(x.title));
  assert.equal(rec.status, 'suggested');
  assert.match(rec.advice, /需要你确认/);
  assert.equal(judgment.rules().length, before);
  assert.equal((await guardian.act(rec.id, 0)).ok, true, 'the user can still adopt it');
  assert.equal(judgment.rules().length, before + 1);
});

test('learned fix: an act rule adds a safe, undoable fix to matching records and runs it in auto mode', async () => {
  for (const r of judgment.rules()) if (r.kind === 'asset-duplicate') judgment.removeRule({ id: r.id });   // 上一个用例采纳的宽规则
  const ran = [];
  guardian.registerAction('disableSkill', (d) => { ran.push(d); return { ok: true, undo: { type: 'noop-undo', data: {} } }; });
  guardian.registerAction('noop-undo', () => ({ ok: true }));
  judgment.judge('asset-duplicate', { kind: 'asset-duplicate', category: 'assets', resourceId: 'r0', nameA: 'x', nameB: 'y', similarity: 0.95, sameRealDir: false });
  assert.match(judgment.validate({ kind: 'asset-duplicate', verdict: 'act', action: { type: 'rmrf', data: {} }, when: { all: [{ fact: 'nameA', op: 'eq', value: 'a' }] }, reason: 'r' }).error, /只能用/);
  assert.match(judgment.validate({ kind: 'asset-duplicate', verdict: 'act', action: { type: 'disableSkill', data: {} }, when: { all: [{ fact: 'nameA', op: 'eq', value: 'a' }] }, reason: 'r' }).error, /resourceId/);
  const v = judgment.validate({
    kind: 'asset-duplicate', verdict: 'act', reason: '同名 -copy 的是复制出来的，停用它',
    action: { type: 'disableSkill', data: { resourceId: '${resourceId}' } },
    when: { all: [{ fact: 'nameB', op: 'match', value: '-copy$' }] },
  });
  assert.equal(v.ok, true, v.error);
  const pr = await judgment.propose({ kind: 'asset-duplicate', verdict: 'act', reason: '同名 -copy 的是复制出来的，停用它', action: { type: 'disableSkill', data: { resourceId: '${resourceId}' } }, when: { all: [{ fact: 'nameB', op: 'match', value: '-copy$' }] } });
  assert.equal(pr.ok, true, pr.error);
  assert.ok(judgment.rules().some(r => r.verdict === 'act'), 'a narrow rule is adopted in auto mode');
  const rec = guardian.record({ needsUser: true, category: 'assets', kind: 'asset-duplicate', status: 'info', title: 'dup', signature: 'dup|a|b', facts: { resourceId: 'res-b', nameA: 'review', nameB: 'review-copy', similarity: 0.99, sameRealDir: false } });
  assert.equal(rec.actions[0].learned != null, true);
  assert.deepEqual(rec.actions[0].run, { type: 'disableSkill', data: { resourceId: 'res-b' } });
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(ran, [{ resourceId: 'res-b' }], 'auto mode runs the learned fix');
  const after = guardian.listRecords().find(x => x.id === rec.id);
  assert.equal(after.status, 'done');
  assert.equal(after.actedLabel, '已按学到的规则处理');
  // 不匹配的照常只是提醒
  const other = guardian.record({ needsUser: true, category: 'assets', kind: 'asset-duplicate', status: 'info', title: 'dup2', signature: 'dup|c|d', facts: { resourceId: 'res-d', nameA: 'c', nameB: 'd', similarity: 0.9, sameRealDir: false } });
  assert.ok(!(other.actions || []).some(a => a.learned));
});

test('any kind can learn: facts come from the record itself; repeated dismissals turn into a rule after the user confirms', async () => {
  const mk = (i) => guardian.record({ category: 'setup', kind: 'setup-unmanaged', status: 'suggested', title: `装了 app${i} 还没纳管`, signature: `setup-unmanaged|app${i}`, meta: { agentId: `app${i}` } });
  const recs = [mk(1), mk(2), mk(3)];
  assert.ok(judgment.validate({ kind: 'setup-unmanaged', when: { all: [{ fact: 'agentId', op: 'eq', value: 'app1' }] }, reason: 'r' }).ok, 'facts from meta are usable');
  for (const r of recs) guardian.dismiss(r.id);
  await new Promise(r => setTimeout(r, 50));
  const ask = guardian.listRecords().find(x => x.kind === 'judgment-rule' && x.meta?.ruleSource === 'feedback');
  assert.ok(ask, 'asks whether to stop this kind of reminder');
  assert.equal(ask.status, 'suggested', 'a whole-kind rule always waits for the user');
  assert.match(ask.advice, /忽略了 3 条/);
  assert.equal((await guardian.act(ask.id, 0)).ok, true);
  assert.equal(mk(4), null, 'from now on this kind is not raised');
  assert.equal((await guardian.undo(ask.id)).ok, true);
  assert.ok(mk(5), 'undo brings it back');
});

test('the built-in guardian agent is told how to write rules', () => {
  const g = judgment.agentGuide();
  assert.match(g, /工作原则/);
  assert.match(g, /setup-unmanaged/, 'kinds it has seen are listed too');
  assert.match(g, /proposed-rules/);
  assert.match(g, /projection-gone/);
  assert.match(g, /targetRealHasSkillMd/);
});

test('a meta field also named kind does not hide the record\'s own kind', () => {
  const f = judgment.factsOf({ kind: 'provider-failure', category: 'gateway', meta: { kind: 'network', model: 'm' } });
  assert.equal(f.kind, 'provider-failure');
  assert.equal(f.subKind, 'network');
  assert.equal(f.model, 'm');
});
