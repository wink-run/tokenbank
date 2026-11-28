// 外部智能体交文件：只收能直接打开的地址；大的不预拉
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');
const files = require('../external-files');

test('清单丢掉本机路径，只留 http(s)', () => {
  const got = files.acceptFiles([
    { name: 'a.mp4', size: 10, url: '/workspace/toutiao/a.mp4' },
    { name: 'b.mp4', size: 10, url: 'file:///workspace/b.mp4' },
    { name: 'c.jpg', size: 10, url: 'http://127.0.0.1/c.jpg' },
    { name: 'ok.mp4', size: 42, url: 'https://example.com/ok.mp4' },
  ]);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'ok.mp4');
  assert.equal(got[0].url, 'https://example.com/ok.mp4');
});

test('10MB 以内才在回传时拉，更大或没报大小的先不拉', () => {
  assert.equal(files.pullNow({ size: 1024 }), true);
  assert.equal(files.pullNow({ size: files.AUTO_PULL_BYTES }), true);
  assert.equal(files.pullNow({ size: files.AUTO_PULL_BYTES + 1 }), false);
  assert.equal(files.pullNow({ size: null }), false);
  assert.equal(files.pullNow({}), false);
});

test('小文件拉下来；报了超限的 Content-Length 时不读正文', async () => {
  let bigSent = 0;
  const server = http.createServer((req, res) => {
    const big = req.url !== '/small.txt';
    const len = big ? files.AUTO_PULL_BYTES + 10 : 5;
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Length': len });
      res.end();
      return;
    }
    if (!big) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 5 });
      res.end('hello');
      return;
    }
    const body = Buffer.alloc(64, 1);
    res.writeHead(200, { 'Content-Length': len });
    res.write(body);
    bigSent += body.length;
    req.on('close', () => res.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-ext-'));
  try {
    // 127.0.0.1 在清单里会被拒绝；拉文件时直接给地址，测试只验证下载本身
    const small = await files.pullUrl(
      { name: 'small.txt', size: 5, url: `http://127.0.0.1:${port}/small.txt` },
      dir,
      { maxBytes: files.AUTO_PULL_BYTES, allowLocal: true },
    );
    assert.equal(fs.readFileSync(small.path, 'utf8'), 'hello');
    await assert.rejects(
      files.pullUrl(
        { name: 'big.bin', size: null, url: `http://127.0.0.1:${port}/big.bin` },
        dir,
        { maxBytes: files.AUTO_PULL_BYTES, allowLocal: true },
      ),
      /不代拉/,
    );
    assert.ok(bigSent < 1024, '超限后不再把正文读完');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
