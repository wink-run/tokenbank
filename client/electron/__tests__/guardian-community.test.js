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

test('share suggestion: often-used own skill, not catalog installs or community twins', async () => {
  const rm = require('../resource-manager');
  rm.init();
  const md = (n, d) => `---\nname: ${n}\ndescription: "${d}"\n---\n\nbody of ${n}`;
  rm.saveResource({ type: 'skill', name: 'sql-tuner', display_name: 'sql-tuner', description: 'Tune slow PostgreSQL queries with EXPLAIN', content: md('sql-tuner', 'Tune slow PostgreSQL queries') });
  rm.saveResource({ type: 'skill', name: 'rarely-used', display_name: 'rarely-used', description: 'x', content: md('rarely-used', 'x') });
  rm.saveResource({ type: 'skill', name: 'git-commit-mine', display_name: 'Git 提交规范', description: '生成符合 Conventional Commits 的提交信息', content: md('git-commit-mine', 'commits') });
  const inst = rm.installFromCatalog('git-commit-skill');
  assert.equal(inst.success, true);
  const calls = [];
  let i = 0;
  for (const k of ['sql-tuner', 'git-commit-mine', 'git-commit']) for (let j = 0; j < 6; j++) calls.push({ ts: Date.now(), agent_id: 'claude-code', skill_key: k, call_uid: `c${i++}` });
  calls.push({ ts: Date.now(), agent_id: 'claude-code', skill_key: 'rarely-used', call_uid: 'c-r' });
  localStats.recordSkillCalls(calls);

  const r = await require('../guardian/share-suggest').check();
  assert.equal(r.ok, true);
  const recs = guardian.listRecords().filter(x => x.kind === 'share-suggest');
  assert.equal(recs.length, 1, JSON.stringify(recs.map(x => x.title)));
  assert.match(recs[0].title, /sql-tuner.*6 次/);
  assert.equal(recs[0].link.to, '/resources');
  assert.equal(recs[0].apply, undefined, 'sharing is never applied automatically');
});

test('device diff: missing and changed assets, skips self and stale devices', () => {
  const ds = require('../guardian/device-sync');
  const mine = [{ t: 'skill', n: 'a', h: '111', s: 'local' }, { t: 'skill', n: 'b', h: '222', s: 'local' }];
  const devices = [
    { id: 'me', assets_reported: true, assets: [{ t: 'skill', n: 'zzz', h: '9' }] },
    { id: 'mac', name: 'MacBook', assets_reported: true, last_seen: new Date().toISOString(),
      assets: [{ t: 'skill', n: 'a', h: '111' }, { t: 'skill', n: 'b', h: '999' }, { t: 'skill', n: 'c', h: '3', s: 'catalog:x' }] },
    { id: 'old', name: 'Old', assets_reported: true, last_seen: '2020-01-01 00:00:00', assets: [{ t: 'skill', n: 'q' }] },
    { id: 'vps', name: 'VPS', assets_reported: false, assets: [] },
  ];
  const out = ds.diff(devices, mine, new Set(['me']));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].missing.map(a => a.n), ['c']);
  assert.deepEqual(out[0].changed.map(c => c.mine.n), ['b']);
});

test('device sync: check against server, apply installs catalog items, undo removes', async () => {
  const ds = require('../guardian/device-sync');
  ds.register();
  const rm = require('../resource-manager');
  // 本机已有 git-commit（上一个测试装的）；另一台多了 code-review 系的社区技能和一个本地技能
  const catalog = require('../resource-catalog').listCatalogItems({ type: 'skill' });
  const other = catalog.find(c => c.catalogId !== 'git-commit-skill' && !rm.listResources({ type: 'skill' }).some(r => r.name === c.name));
  assert.ok(other, 'needs a second catalog skill');
  let auth = '';
  const srv = await serve((req, res) => {
    auth = req.headers.authorization;
    if (req.url !== '/user/devices/assets') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ devices: [
      { id: 'mac', name: 'MacBook', online: true, last_seen: new Date().toISOString(), assets_reported: true, assets: [
        { t: 'skill', n: other.name, d: other.display_name, h: 'x', s: `catalog:${other.catalogId}` },
        { t: 'skill', n: 'mac-only-notes', d: 'mac-only-notes', h: 'y', s: 'local' },
      ] },
    ] }));
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  fs.writeFileSync(path.join(process.env.LLM_AGENT_CONFIG_DIR, 'local-config.json'), JSON.stringify({ user_session: { jwt: 'jwt-1' }, cloud_config: { url } }));
  try {
    const r = await ds.check();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.differing, 1);
    assert.equal(auth, 'Bearer jwt-1');
  } finally {
    srv.close();
  }
  const rec = guardian.listRecords().find(x => x.signature === 'device-missing|mac');
  assert.equal(rec.status, 'suggested');
  assert.match(rec.title, /MacBook.*2 个技能/);
  assert.match(rec.advice, /1 个来自社区或 GitHub.*1 个是在那台上自己写的/);
  assert.deepEqual(rec.apply.data.items.map(i => i.n), [other.name]);

  assert.equal((await guardian.apply(rec.id)).ok, true);
  assert.ok(rm.listResources({ type: 'skill' }).some(x => x.name === other.name), 'installed on this device');
  const done = guardian.listRecords().find(x => x.kind === 'device-synced');
  assert.equal((await guardian.undo(done.id)).ok, true);
  assert.ok(!rm.listResources({ type: 'skill' }).some(x => x.name === other.name), 'undo removes what sync installed');

  // 未登录：不请求
  fs.writeFileSync(path.join(process.env.LLM_AGENT_CONFIG_DIR, 'local-config.json'), '{}');
  assert.equal((await ds.check()).reason, 'not-logged-in');
});

test('heartbeat carries the asset snapshot (CLI / Docker reporter)', async () => {
  const beats = [];
  const srv = await serve((req, res, body) => {
    if (req.url === '/device/register') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ device_id: 'dev-cli' })); return; }
    if (req.url === '/device/heartbeat') beats.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
  });
  const reporter = require('../../shared/device-reporter');
  try {
    await reporter.init({ type: 'cli', serverUrl: `http://127.0.0.1:${srv.address().port}`, userJwt: 'jwt-1', name: 'box' });
    reporter.start(() => ({ calls: 1 }));
    for (let i = 0; i < 40 && !beats.length; i++) await new Promise(r => setTimeout(r, 50));
  } finally {
    reporter.setUserJwt(null);
    srv.close();
  }
  assert.ok(beats.length);
  const assets = beats[0].stats.inventory.assets;
  assert.ok(Array.isArray(assets) && assets.some(a => a.n === 'sql-tuner' && a.s === 'local' && a.h.length === 12));
  assert.ok(assets.some(a => a.n === 'git-commit' && a.s === 'catalog:git-commit-skill'));
  assert.ok(!JSON.stringify(assets).includes('body of'), 'no content is uploaded');
});
