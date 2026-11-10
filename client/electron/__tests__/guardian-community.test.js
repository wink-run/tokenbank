'use strict';
// 五期：分享前整理、分享推荐、多设备资产差异与同步、心跳带资产清单
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-community-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });

const localStats = require('../local-stats');
assert.ok(localStats.init(path.join(HOME, '.tokenbank'), { force: true }));
require('../../cli/ipc-bridge').installElectronStub();
const guardian = require('../guardian');
const shareCheck = require('../guardian/share-check');

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('share check: private paths, keys, emails, internal and company hosts', () => {
  const r = shareCheck.sanitize({
    content: [
      'cd /Users/jason/work && ls /home/user/demo',
      'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
      'api_key: "${API_KEY}"',
      'password = hunter2hunter2hunter2',
      'mail jason@acme-corp.com, bot noreply@github.com, sample a@example.com',
      'git clone https://git.acme-corp.com/team/repo ; see https://github.com/x/y',
      'ssh 10.2.3.4 or 192.168.1.20 and db.prod.internal',
      'ssh deploy@10.8.0.12',
      'C:\\Users\\Jason\\proj',
    ].join('\n'),
    description: 'Ask jason@acme-corp.com',
  });
  assert.ok(r.changed);
  assert.match(r.content, /cd ~\/work/);
  assert.match(r.content, /\/home\/user\/demo/, 'placeholder user names stay');
  assert.match(r.content, /OPENAI_API_KEY=<YOUR_API_KEY>/);
  assert.match(r.content, /api_key: "\$\{API_KEY\}"/, 'env references stay');
  assert.match(r.content, /password = <YOUR_SECRET>/);
  assert.match(r.content, /noreply@github\.com/);
  assert.match(r.content, /a@example\.com/);
  assert.match(r.content, /https:\/\/<company-domain>\/team\/repo/);
  assert.match(r.content, /https:\/\/github\.com\/x\/y/);
  assert.match(r.content, /<internal-ip> or <internal-ip> and <internal-host>/);
  assert.match(r.content, /ssh deploy@<internal-ip>/, 'user@ip is an ssh address, not an email');
  assert.match(r.content, /%USERPROFILE%\\proj/);
  assert.equal(r.description, 'Ask <your-email>');
  const kinds = new Set(r.findings.map(f => f.kind));
  for (const k of ['path', 'secret', 'email', 'internal', 'company']) assert.ok(kinds.has(k), k);
  assert.ok(!JSON.stringify(r.findings).includes('abcdefghijklmnop'), 'samples are masked');
  assert.equal(shareCheck.sanitize({ content: 'just a normal skill body' }).changed, false);
});

