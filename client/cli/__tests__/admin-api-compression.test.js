// client/cli/__tests__/admin-api-compression.test.js
// 验证 admin-api 静态资源 HTTP 压缩功能
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const path = require('path');
const fs = require('fs');

const adminApi = require('../admin-api');

let server;
let port;
const mockGateway = {
  getStatus: () => ({ running: true, port: 11430 }),
  setRouterModelMap: () => {},
  setAppControls: () => {},
  setKeySceneMap: () => {},
  setClaudeModels: () => {},
  setBackendConfig: () => {},
  setUserAuth: () => {},
  setPeerModels: () => {},
  getLog: () => [],
  getDailyStats: () => ({ calls: 0 }),
};

function makeRequest(path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function setupServer() {
  return new Promise((resolve) => {
    const testServer = http.createServer();
    testServer.listen(0, '127.0.0.1', () => {
      port = testServer.address().port;
      testServer.close(() => {
        server = adminApi.start(port, mockGateway, '127.0.0.1');
        setTimeout(resolve, 100);
      });
    });
  });
}

function teardownServer() {
  return new Promise((resolve) => {
    if (server) {
      adminApi.stop();
      setTimeout(resolve, 100);
    } else {
      resolve();
    }
  });
}

test('JS 文件应该被 gzip 压缩', async () => {
  await setupServer();
  
  const res = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'gzip' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  assert.strictEqual(res.headers['vary'], 'Accept-Encoding');
  assert.strictEqual(parseInt(res.headers['content-length']), res.body.length);
  
  const decompressed = zlib.gunzipSync(res.body);
  const originalSize = decompressed.length;
  const compressedSize = res.body.length;
  
  assert.ok(compressedSize < originalSize, `压缩应该减少大小: ${compressedSize} >= ${originalSize}`);
  console.log(`  JS: ${originalSize}B → ${compressedSize}B (${(compressedSize / originalSize * 100).toFixed(1)}%)`);
  
  await teardownServer();
});

test('CSS 文件应该被 gzip 压缩', async () => {
  await setupServer();
  
  const res = await makeRequest('/assets/test-style.css', { 'Accept-Encoding': 'gzip' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /css/);
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  assert.strictEqual(res.headers['vary'], 'Accept-Encoding');
  
  const decompressed = zlib.gunzipSync(res.body);
  const originalSize = decompressed.length;
  const compressedSize = res.body.length;
  
  assert.ok(compressedSize < originalSize);
  console.log(`  CSS: ${originalSize}B → ${compressedSize}B (${(compressedSize / originalSize * 100).toFixed(1)}%)`);
  
  await teardownServer();
});

test('gzip 解码后内容应该与原始文件相同', async () => {
  await setupServer();
  
  const originalFile = fs.readFileSync(path.join(__dirname, '../../dist/assets/test-B4DzBrva.js'));
  const res = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'gzip' });
  
  const decompressed = zlib.gunzipSync(res.body);
  assert.ok(Buffer.compare(decompressed, originalFile) === 0, '解码内容应该与原文件完全一致');
  
  await teardownServer();
});

test('HEAD 请求应该返回正确的头且无 body', async () => {
  await setupServer();
  
  const headRes = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'gzip' }, 'HEAD');
  const getRes = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'gzip' }, 'GET');
  
  assert.strictEqual(headRes.statusCode, 200);
  assert.strictEqual(headRes.headers['content-encoding'], getRes.headers['content-encoding']);
  assert.strictEqual(headRes.headers['content-length'], getRes.headers['content-length']);
  assert.strictEqual(headRes.body.length, 0, 'HEAD 响应不应该有 body');
  
  await teardownServer();
});

test('Accept-Encoding: gzip;q=0 应该拒绝压缩', async () => {
  await setupServer();
  
  const res = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'gzip;q=0' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-encoding'], undefined);
  assert.strictEqual(res.headers['vary'], 'Accept-Encoding');
  
  const originalFile = fs.readFileSync(path.join(__dirname, '../../dist/assets/test-B4DzBrva.js'));
  assert.ok(Buffer.compare(res.body, originalFile) === 0);
  
  await teardownServer();
});

test('Accept-Encoding: identity 应该返回未压缩内容', async () => {
  await setupServer();
  
  const res = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'identity' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-encoding'], undefined);
  assert.strictEqual(res.headers['vary'], 'Accept-Encoding');
  
  await teardownServer();
});

test('Accept-Encoding: gzip;q=0.8, identity;q=0.5 应该选择 gzip', async () => {
  await setupServer();
  
  const res = await makeRequest('/assets/test-B4DzBrva.js', { 
    'Accept-Encoding': 'gzip;q=0.8, identity;q=0.5' 
  });
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  
  await teardownServer();
});

test('没有 Accept-Encoding 应该返回未压缩内容', async () => {
  await setupServer();
  
  const res = await makeRequest('/assets/test-B4DzBrva.js');
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-encoding'], undefined);
  
  await teardownServer();
});

test('小文件(<1KB)不应该被压缩但设置 Vary', async () => {
  await setupServer();
  
  const res = await makeRequest('/', { 'Accept-Encoding': 'gzip' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-encoding'], undefined, 'HTML 太小不应压缩');
  assert.strictEqual(res.headers['vary'], 'Accept-Encoding', '应该设置 Vary 头');
  assert.match(res.body.toString(), /<!doctype html>/i);
  
  await teardownServer();
});

test('API 响应不应该被压缩', async () => {
  await setupServer();
  
  const res = await makeRequest('/api/gateway/status', { 'Accept-Encoding': 'gzip' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /json/);
  assert.strictEqual(res.headers['content-encoding'], undefined);
  
  const body = JSON.parse(res.body.toString());
  assert.ok('running' in body);
  
  await teardownServer();
});

test('Content-Length 应该与实际响应体大小匹配', async () => {
  await setupServer();
  
  const res = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'gzip' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseInt(res.headers['content-length'], 10), res.body.length);
  
  await teardownServer();
});

test('Vary 头应该在可压缩类型上正确设置', async () => {
  await setupServer();
  
  const res1 = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'gzip' });
  assert.strictEqual(res1.headers['vary'], 'Accept-Encoding');

  const res2 = await makeRequest('/assets/test-B4DzBrva.js', { 'Accept-Encoding': 'identity' });
  assert.strictEqual(res2.headers['vary'], 'Accept-Encoding');
  
  await teardownServer();
});
