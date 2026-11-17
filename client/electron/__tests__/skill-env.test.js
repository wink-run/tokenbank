'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-env-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
const env = require('../skill-env');

test('reads declared env from SKILL.md front matter', () => {
  const md = '---\nname: ark\nmetadata: {"openclaw":{"requires":{"env":["ARK_API_KEY","VMP_ENDPOINT"]},"primaryEnv":"ARK_API_KEY"}}\n---\nbody';
  assert.deepEqual(env.declaredEnv(md).sort(), ['ARK_API_KEY', 'VMP_ENDPOINT']);
  assert.deepEqual(env.declaredEnv('---\nenv:\n  - FOO_TOKEN\n  - BAR_URL\n---\n'), ['FOO_TOKEN', 'BAR_URL']);
});

test('finds key-like names in text, skips reserved ones', () => {
  const found = env.mentionedEnv('先 export VOLC_ACCESS_KEY=xx 和 `VOLC_SECRET_KEY`，ANTHROPIC_API_KEY 不算，PATH 也不算');
  assert.deepEqual(found.sort(), ['VOLC_ACCESS_KEY', 'VOLC_SECRET_KEY']);
});

test('detects from files in the skill dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-dir-'));
  fs.mkdirSync(path.join(dir, 'references'));
  fs.writeFileSync(path.join(dir, 'references', 'alert.md'), '需要 VMP_ALERT_TOKEN');
  const got = env.detectRequiredEnv({ content: '---\nenv: [ARK_API_KEY]\n---\n', dir });
  assert.deepEqual(got, [{ name: 'ARK_API_KEY', declared: true }, { name: 'VMP_ALERT_TOKEN', declared: false }]);
});

test('stores values masked, writes the skill .env and the shell file, not app configs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-dir-'));
  const skill = { id: 'r1', name: 'ark', content: '---\nenv: [ARK_API_KEY]\n---\n' };
  assert.deepEqual(env.describe(skill, dir).missing, ['ARK_API_KEY']);
  assert.equal(env.setValue(skill, 'ARK_API_KEY', 'sk-secret-1234', dir), 'written');
  const d = env.describe(skill, dir);
  assert.deepEqual(d.missing, []);
  assert.equal(d.vars[0].preview, '••••1234');
  assert.equal(d.dotenv, 'written');
  assert.equal(env.allEnv().ARK_API_KEY, 'sk-secret-1234');
  assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'), /ARK_API_KEY="sk-secret-1234"/);
  assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(env.shellFile(), 'utf8'), /export ARK_API_KEY='sk-secret-1234'/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'settings.json')), false);
  // 清空后 .env 删掉
  assert.equal(env.setValue(skill, 'ARK_API_KEY', '', dir), 'none');
  assert.equal(fs.existsSync(path.join(dir, '.env')), false);
  assert.throws(() => env.setValue(skill, 'ANTHROPIC_API_KEY', 'x'));
  assert.throws(() => env.setValue(skill, 'bad-name', 'x'));
});

test('leaves a .env the skill author wrote alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-dir-'));
  fs.writeFileSync(path.join(dir, '.env'), 'MINE=1\n');
  assert.equal(env.setValue({ id: 'r2', name: 'other' }, 'OTHER_TOKEN', 'v', dir), 'foreign');
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), 'MINE=1\n');
});

test('adds the source line to shell profiles once', () => {
  fs.writeFileSync(path.join(home, '.zshrc'), 'export A=1\n');
  assert.equal(env.shellHookInstalled(), false);
  env.installShellHook();
  env.installShellHook();
  const txt = fs.readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.equal(txt.split('Token Bank skill keys >>>').length - 1, 1);
  assert.match(txt, /\. "\$HOME\/\.tokenbank\/skill-env\.sh"/);
  assert.equal(env.shellHookInstalled(), true);
});

test('cleans keys an older version wrote into Claude settings', () => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { KEEP_ME: '1', OLD_KEY: 'x' } }));
  const f = path.join(home, '.tokenbank', 'skill-env.json');
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  data.__claudeManaged = ['OLD_KEY'];
  fs.writeFileSync(f, JSON.stringify(data));
  env.syncOutputs();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).env, { KEEP_ME: '1' });
  assert.equal('__claudeManaged' in JSON.parse(fs.readFileSync(f, 'utf8')), false);
});

test('sharing a skill never packs its .env', () => {
  const { packSkillCompanionFiles } = require('../resource-canonical');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-pack-'));
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# s');
  fs.writeFileSync(path.join(dir, '.env'), 'K=1');
  fs.writeFileSync(path.join(dir, '.env.local'), 'K=1');
  fs.writeFileSync(path.join(dir, '.env.example'), 'K=');
  fs.writeFileSync(path.join(dir, 'run.sh'), 'echo');
  assert.deepEqual(packSkillCompanionFiles(dir).map(f => f.path).sort(), ['.env.example', 'run.sh']);
});
