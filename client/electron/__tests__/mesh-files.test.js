'use strict';
// 个人设备之间传文件：登记成凭证、经设备通道按需拉、校验 sha256；不走云存储
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mesh-files-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const files = require('../mesh/files');

/** 假的设备通道：把对方网关 serve 的输出接回来 */
function fakeProxy(tamper) {
  return async (_dev, req) => {
    const token = decodeURIComponent(req.path.split('/').pop());
    const res = new PassThrough();
    let status = 200;
    res.writeHead = (code) => { status = code; };
    files.serve(token, res);
    await new Promise((r) => setImmediate(r));
    async function* chunks() { for await (const c of res) yield tamper ? Buffer.from(String(c).replace('a', 'b')) : c; }
    return { status, headers: {}, chunks: chunks() };
  };
}

test('登记 → 拉取 → 校验通过存到本机；内容被改就不保存', async () => {
  const src = path.join(HOME, 'report.md');
  fs.writeFileSync(src, 'a'.repeat(1000));
  const entry = await files.offerFile(src, { taskId: 't1' });
  assert.equal(entry.size, 1000);
  assert.equal(entry.path, undefined, '清单里不带本机路径');
  const dest = path.join(HOME, 'in');
  const got = await files.pull({ proxy: fakeProxy(), deviceId: 'd', entry, destDir: dest });
  assert.equal(fs.readFileSync(got.path, 'utf8'), 'a'.repeat(1000));
  await assert.rejects(files.pull({ proxy: fakeProxy(true), deviceId: 'd', entry, destDir: dest }), /校验不对/);
  assert.ok(!fs.readdirSync(dest).some((n) => n.endsWith('.part')), '半截文件清掉');
});

test('dataUrl（游乐场带的图）也能登记；不存在的凭证拉不到', async () => {
  const e = await files.offerDataUrl(`data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`, 'shot');
  assert.equal(e.name, 'shot.png');
  assert.equal(e.mime, 'image/png');
  await assert.rejects(files.pull({ proxy: fakeProxy(), deviceId: 'd', entry: { ...e, token: 'nope-nope-nope' }, destDir: path.join(HOME, 'x') }), /不在了/);
});

test('只能经官方中继时超过 500MB 的不传', async () => {
  await assert.rejects(
    files.pull({ proxy: fakeProxy(), deviceId: 'd', entry: { token: 'tttttttttt', name: 'big.mp4', size: 600 * 1048576 }, destDir: HOME, viaOfficialRelay: true }),
    /官方中继.*超过 500MB/,
  );
});

test('开工快照之后新增、改过的文件才算产出；上传目录不算', () => {
  const cs = require('../contribute-session');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ws-'));
  fs.writeFileSync(path.join(ws, 'old.txt'), 'x');
  const before = cs.snapshotWorkspace(ws);
  fs.writeFileSync(path.join(ws, 'new.png'), 'y');
  fs.mkdirSync(path.join(ws, '.tokenbank-uploads', 'a'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.tokenbank-uploads', 'a', 'in.png'), 'z');
  const changed = cs.listChangedFiles(ws, before);
  assert.deepEqual(changed.map((f) => f.name), ['new.png']);
});
