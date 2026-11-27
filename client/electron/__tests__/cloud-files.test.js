// 云端转发的雇佣文件走 COS 引用：直传、引用、下载校验；没配 COS 时照旧 base64
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const cloudFiles = require('../cloud-files');

/** 假的服务端 + 假的 COS：/api/agent-files/upload 发直传地址，PUT 存进内存，GET 取回 */
function fakeCloud({ cos = true } = {}) {
  const store = new Map();
  const asks = [];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = Buffer.concat(parts);
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/agent-files/upload') {
      if (!cos) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"detail":{"error":"cos_unavailable"}}'); return; }
      const ask = JSON.parse(body.toString('utf8'));
      asks.push({ ...ask, auth: req.headers.authorization });
      const key = `agent-media/hire/${crypto.randomBytes(12).toString('base64url')}/${ask.name}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cos_key: key, upload_url: `http://127.0.0.1:${server.address().port}/cos/${encodeURIComponent(key)}`, headers: { 'Content-Type': ask.mime } }));
      return;
    }
    if (u.pathname.startsWith('/cos/')) {
      const key = decodeURIComponent(u.pathname.slice(5));
      if (req.method === 'PUT') { store.set(key, body); res.writeHead(200); res.end(); return; }
      const got = store.get(key);
      if (!got) { res.writeHead(404); res.end(); return; }
      res.writeHead(200); res.end(got);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    server, store, asks, base: `http://127.0.0.1:${server.address().port}`,
    urlOf: (key) => `http://127.0.0.1:${server.address().port}/cos/${encodeURIComponent(key)}`,
  })));
}

test('雇佣方：附件先传 COS，任务里只带引用；没配 COS 时照旧 base64', async () => {
  cloudFiles._reset();
  const c = await fakeCloud();
  try {
    const data = Buffer.from('hello report');
    const refs = await cloudFiles.uploadInputs([{ name: 'r.txt', dataUrl: `data:text/plain;base64,${data.toString('base64')}` }], { base: c.base, token: 'tk' });
    assert.equal(refs.length, 1);
    assert.ok(refs[0].cos_key.startsWith('agent-media/hire/'));
    assert.equal(refs[0].dataUrl, undefined, '不再带整份文件');
    assert.equal(refs[0].size, data.length);
    assert.equal(refs[0].sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.equal(c.asks[0].auth, 'Bearer tk');
    assert.deepEqual(c.store.get(refs[0].cos_key), data);
  } finally { c.server.close(); }

  cloudFiles._reset();
  const off = await fakeCloud({ cos: false });
  try {
    const items = [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }];
    assert.deepEqual(await cloudFiles.uploadInputs(items, { base: off.base, token: 'tk' }), items);
  } finally { off.server.close(); cloudFiles._reset(); }
});

test('出租方：下载项拉到本机并校验；小图仍给多模态，文本带内容给安全审查', async () => {
  const c = await fakeCloud();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const txt = Buffer.from('rm -rf / 这种内容要被审到');
    const zip = Buffer.alloc(2048, 7);
    c.store.set('k/png', png); c.store.set('k/txt', txt); c.store.set('k/zip', zip);
    const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
    const got = await cloudFiles.fetchInputs(
      [{ name: '图.png', mime: 'image/png', size: png.length, sha256: sha(png), url: c.urlOf('k/png') }],
      [
        { name: 'a.txt', mime: 'text/plain', size: txt.length, sha256: sha(txt), url: c.urlOf('k/txt') },
        { name: 'b.zip', mime: 'application/zip', size: zip.length, url: c.urlOf('k/zip') },
      ],
    );
    assert.equal(got.images[0].dataUrl, `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(got.files[0].data, `data:text/plain;base64,${txt.toString('base64')}`);
    assert.deepEqual(fs.readFileSync(got.files[1].path), zip);
    assert.equal(got.files[1].data, undefined, '二进制不读进来');

    c.store.set('k/bad', Buffer.from('tampered'));
    await assert.rejects(
      cloudFiles.fetchInputs([], [{ name: 'x.txt', mime: 'text/plain', sha256: 'f'.repeat(64), url: c.urlOf('k/bad') }]),
      /校验不对/,
    );
    // 没有下载项：原样返回，不建目录
    const plain = [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }];
    assert.deepEqual(await cloudFiles.fetchInputs(plain, []), { images: plain, files: [], dir: '' });
  } finally { c.server.close(); }
});

test('出租方：产出直传 COS 交引用', async () => {
  cloudFiles._reset();
  const c = await fakeCloud();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cf-'));
  const prevCfg = require('../community-agent-client').resolveCloudAuth;
  try {
    const film = path.join(dir, '成片.mp4');
    fs.writeFileSync(film, Buffer.alloc(4096, 1));
    require('../community-agent-client').resolveCloudAuth = () => ({ base: c.base, token: 'tk' });
    const up = await cloudFiles.uploadArtifacts([{ name: '成片.mp4', mime: 'video/mp4', kind: 'file', path: film, localPath: film }]);
    assert.equal(up.failed.length, 0);
    assert.equal(up.artifacts[0].localPath, film);
    assert.equal(up.artifacts[0].size, 4096);
    assert.deepEqual(c.store.get(up.artifacts[0].cos_key), fs.readFileSync(film));
  } finally {
    require('../community-agent-client').resolveCloudAuth = prevCfg;
    c.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    cloudFiles._reset();
  }
});

test('执行器：本机路径的附件挪进上传目录，写进提示', () => {
  const { materializeAttachedFiles } = require('../agent-executor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cf-'));
  try {
    const src = path.join(dir, 'in.zip');
    fs.writeFileSync(src, 'zip');
    const work = path.join(dir, 'work');
    fs.mkdirSync(work);
    const r = materializeAttachedFiles([{ name: 'b.zip', path: src }], { taskId: 't1', workingDir: work });
    assert.equal(r.paths.length, 1);
    assert.ok(r.paths[0].startsWith(path.join(work, '.tokenbank-uploads')));
    assert.equal(fs.readFileSync(r.paths[0], 'utf8'), 'zip');
    assert.ok(!fs.existsSync(src));
    assert.match(r.suffix, /b\.zip/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
