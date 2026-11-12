'use strict';
// 每个智能体自己的接口 Key：首次查看时生成，重新生成后旧的作废
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-agent-keys-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const keys = require('../agent-keys');

test('each agent gets its own stable key; regenerate revokes the old one', () => {
  const a = keys.get('assistant:res-weekly');
  const b = keys.get('external:muse');
  assert.match(a, /^tbk_[0-9a-f]{40}$/);
  assert.notEqual(a, b);
  assert.equal(keys.get('assistant:res-weekly'), a, 'same key on second look');
  assert.equal(keys.agentForKey(a), 'assistant:res-weekly');
  assert.equal(keys.agentForKey(b), 'external:muse');
  const a2 = keys.regenerate('assistant:res-weekly');
  assert.notEqual(a2, a);
  assert.equal(keys.agentForKey(a), null, 'old key no longer works');
  assert.equal(keys.agentForKey(a2), 'assistant:res-weekly');
  assert.equal(keys.agentForKey('sk-local-whatever'), null);
  assert.equal((fs.statSync(keys._internal.file()).mode & 0o777), 0o600);
});
