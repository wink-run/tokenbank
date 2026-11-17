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

test('stores values, masks them, writes shell file and Claude settings', () => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { KEEP_ME: '1' } }));
  const skill = { id: 'r1', name: 'ark', content: '---\nenv: [ARK_API_KEY]\n---\n' };
  assert.deepEqual(env.describe(skill, null).missing, ['ARK_API_KEY']);
  env.setValue(skill, 'ARK_API_KEY', 'sk-secret-1234');
  const d = env.describe(skill, null);
  assert.deepEqual(d.missing, []);
  assert.equal(d.vars[0].preview, '••••1234');
  assert.equal(env.allEnv().ARK_API_KEY, 'sk-secret-1234');
  assert.match(fs.readFileSync(env.shellFile(), 'utf8'), /export ARK_API_KEY='sk-secret-1234'/);
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.env, { KEEP_ME: '1', ARK_API_KEY: 'sk-secret-1234' });
  // 清空后从 Claude 配置里拿掉，自己的键不动
  env.setValue(skill, 'ARK_API_KEY', '');
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(after.env, { KEEP_ME: '1' });
  assert.throws(() => env.setValue(skill, 'ANTHROPIC_API_KEY', 'x'));
  assert.throws(() => env.setValue(skill, 'bad-name', 'x'));
});
