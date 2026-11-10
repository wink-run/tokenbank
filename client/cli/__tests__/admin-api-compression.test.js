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

// 初始化测试服务器
async function setupServer() {
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

// 清理测试服务器
async function teardownServer() {
  return new Promise((resolve) => {
    if (server) {
      adminApi.stop();
      setTimeout(resolve, 100);
    } else {
      resolve();
    }
  });
}

function makeRequest(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
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

test('应该在 Accept-Encoding: gzip 时压缩 HTML', async () => {
  await setupServer();
  
  const res = await makeRequest('/', { 'Accept-Encoding': 'gzip' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  assert.strictEqual(res.headers['vary'], 'Accept-Encoding');
  assert.strictEqual(res.headers['content-length'], String(res.body.length));
  
  const decompressed = zlib.gunzipSync(res.body);
  assert.match(decompressed.toString(), /<!doctype html>/i);
  
  await teardownServer();
});

test('应该在 Accept-Encoding: gzip 时压缩 JS', async () => {
  await setupServer();
  
  const distDir = path.resolve(__dirname, '..', '..', 'dist');
  const assetsDir = path.join(distDir, 'assets');
  const files = fs.readdirSync(assetsDir);
  const jsFile = files.find(f => f.endsWith('.js'));
  
  if (!jsFile) {
    console.log('跳过 JS 测试：未找到文件');
    await teardownServer();
    return;
  }

  const res = await makeRequest(`/assets/${jsFile}`, { 'Accept-Encoding': 'gzip' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  assert.strictEqual(res.headers['vary'], 'Accept-Encoding');
  
  const decompressed = zlib.gunzipSync(res.body);
  const originalSize = decompressed.length;
  const compressedSize = res.body.length;
  
  assert.ok(compressedSize < originalSize * 0.9, '压缩应该减少至少 10% 大小');
  console.log(`JS 压缩: ${originalSize} -> ${compressedSize} (${(compressedSize / originalSize * 100).toFixed(1)}%)`);
  
  await teardownServer();
});

test('应该在不支持 gzip 时返回未压缩内容', async () => {
  await setupServer();
  
  const res = await makeRequest('/', { 'Accept-Encoding': 'identity' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.strictEqual(res.headers['content-encoding'], undefined);
  assert.strictEqual(res.headers['vary'], 'Accept-Encoding');
  assert.match(res.body.toString(), /<!doctype html>/i);
  
  await teardownServer();
});

test('应该在没有 Accept-Encoding 时返回未压缩内容', async () => {
  await setupServer();
  
  const res = await makeRequest('/');
  
  assert.strictEqual(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.strictEqual(res.headers['content-encoding'], undefined);
  assert.match(res.body.toString(), /<!doctype html>/i);
  
  await teardownServer();
});

test('应该正确处理 Accept-Encoding: gzip;q=0 (拒绝 gzip)', async () => {
  await setupServer();
  
  const res = await makeRequest('/', { 'Accept-Encoding': 'gzip;q=0' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-encoding'], undefined);
  assert.match(res.body.toString(), /<!doctype html>/i);
  
  await teardownServer();
});

test('应该正确处理 Accept-Encoding: gzip, deflate', async () => {
  await setupServer();
  
  const res = await makeRequest('/', { 'Accept-Encoding': 'gzip, deflate' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.headers['content-encoding'], 'gzip');
  
  const decompressed = zlib.gunzipSync(res.body);
  assert.match(decompressed.toString(), /<!doctype html>/i);
  
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
  
  const res = await makeRequest('/', { 'Accept-Encoding': 'gzip' });
  
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(parseInt(res.headers['content-length'], 10), res.body.length);
  
  await teardownServer();
});

test('Vary 头应该被正确设置', async () => {
  await setupServer();
  
  const res1 = await makeRequest('/', { 'Accept-Encoding': 'gzip' });
  assert.strictEqual(res1.headers['vary'], 'Accept-Encoding');

  const res2 = await makeRequest('/', { 'Accept-Encoding': 'identity' });
  assert.strictEqual(res2.headers['vary'], 'Accept-Encoding');
  
  await teardownServer();
});
