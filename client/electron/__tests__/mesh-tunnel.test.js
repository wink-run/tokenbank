'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { memoryPair } = require('../mesh/frames');
const tunnel = require('../mesh/tunnel');

/** 假的「对端本机网关」：记下收到的请求头，/sse 按块推送 */
function fakeGateway() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts).toString() });
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"n":1}\n\n');
        setTimeout(() => { res.write('data: {"n":2}\n\n'); res.end(); }, 30);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, port: server.address().port })));
}

test('tunnel: 白名单', () => {
  assert.equal(tunnel.isAllowed('POST', '/v1/chat/completions'), true);
  assert.equal(tunnel.isAllowed('GET', '/v1/agent/responses/abc'), true);
  assert.equal(tunnel.isAllowed('POST', '/v1/agent/responses/abc/cancel'), true);
  assert.equal(tunnel.isAllowed('GET', '/api/local-stats'), false);
  assert.equal(tunnel.isAllowed('POST', '/v1/agent/external/register'), false);
  assert.equal(tunnel.isAllowed('GET', '/v1/agent/responses/../../etc'), false);
  assert.equal(tunnel.isAllowed('DELETE', '/v1/models'), false);
});

test('tunnel: 外来的鉴权头和 x-tb-mesh-* 被换掉', () => {
  const h = tunnel.inboundHeaders({ Authorization: 'Bearer evil', 'x-tb-mesh-from': 'fake', 'x-api-key': 'k', accept: 'x', host: 'h' }, { meshKey: 'tbm_1', fromDeviceId: 'dev-a' });
  assert.equal(h.authorization, 'Bearer tbm_1');
  assert.equal(h['x-tb-mesh-from'], 'dev-a');
  assert.equal(h['x-tb-mesh-hop'], '1');
  assert.equal(h['x-api-key'], undefined);
  assert.equal(h.host, undefined);
  assert.equal(h.accept, 'x');
});

test('tunnel: 请求穿过隧道到对端网关，流式响应逐块到达', async () => {
  const gw = await fakeGateway();
  const [a, b] = memoryPair();
  const served = tunnel.serve(b, { gatewayPort: gw.port, meshKey: 'tbm_k', fromDeviceId: 'dev-a' });
  const resp = await tunnel.request(a, {
    method: 'POST', path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', authorization: 'Bearer caller' },
    body: Buffer.from('{"model":"m","stream":true}'),
  });
  assert.equal(resp.status, 200);
  const chunks = [];
  for await (const c of resp.chunks) chunks.push(c.toString());
  await served;
  assert.ok(chunks.length >= 2, '流式响应应当分块到达，而不是攒成一块');
  assert.equal(chunks.join(''), 'data: {"n":1}\n\ndata: {"n":2}\n\n');
  const got = gw.seen[0];
  assert.equal(got.headers.authorization, 'Bearer tbm_k');
  assert.equal(got.headers['x-tb-mesh-from'], 'dev-a');
  assert.equal(got.body, '{"model":"m","stream":true}');
  gw.server.close();
});

test('tunnel: 白名单外的路径在对端直接 403，不会到达网关', async () => {
  const gw = await fakeGateway();
  const [a, b] = memoryPair();
  const served = tunnel.serve(b, { gatewayPort: gw.port, meshKey: 'k', fromDeviceId: 'd' });
  const resp = await tunnel.request(a, { method: 'GET', path: '/api/local-stats', headers: {} });
  assert.equal(resp.status, 403);
  await tunnel.readAll(resp);
  await served;
  assert.equal(gw.seen.length, 0);
  gw.server.close();
});

test('tunnel: 对端网关不可用时返回 502', async () => {
  const [a, b] = memoryPair();
  const served = tunnel.serve(b, { gatewayPort: 1, meshKey: 'k', fromDeviceId: 'd' });
  const resp = await tunnel.request(a, { method: 'GET', path: '/v1/models', headers: {} });
  assert.equal(resp.status, 502);
  await tunnel.readAll(resp);
  await served;
});
