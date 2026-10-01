'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');

// Exercise the real route/proxy functions without opening a gateway listener or
// touching the user's logs/config. Only local mock upstreams receive requests.
const tmpRoot = fs.realpathSync(os.tmpdir());
const home = fs.mkdtempSync(path.join(tmpRoot, 'tb-st-routing-'));
const realHome = os.homedir;
os.homedir = () => home;
const filename = require.resolve('../local-gateway');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testRoute = route; module.exports.testConfig = (cfg) => { _getConfig = () => cfg; };', filename);
const gw = mod.exports;
const oauth = require('../oauth');
after(async () => {
  await new Promise(resolve => setTimeout(resolve, 1200)); // allow log flush timers
  os.homedir = realHome;
  assert.ok(fs.realpathSync(home).startsWith(tmpRoot + path.sep));
  fs.rmSync(home, { recursive: true, force: true });
});

function response() {
  return {
    headersSent: false, statusCode: null, text: '', writableEnded: false,
    writeHead(status) { this.statusCode = status; this.headersSent = true; },
    write(data) { this.text += data; },
    end(data = '') { this.text += data; this.writableEnded = true; },
    destroy() { this.writableEnded = true; },
  };
}
async function upstream(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const model = 'claude-sonnet-5';
const scene = { scene_name: 'shim-test', steps: [{ model: 'chatgpt-web-thinking' }] };

test('legacy shim fallback excludes Chat Completions and Responses', () => {
  for (const reqPath of ['/v1/chat/completions', '/v1/responses', '/responses']) {
    assert.equal(gw.resolveClaudeShimScene({ reqPath, origModel: model, isApiKeyCaller: false, scene }), null);
  }
  assert.equal(gw.resolveClaudeShimScene({ reqPath: '/v1/messages', origModel: model, isApiKeyCaller: false, scene }), scene);
  assert.equal(gw.resolveClaudeShimScene({ reqPath: '/v1/messages', origModel: model, isApiKeyCaller: true, scene }), null);
});

test('official Claude OAuth ignores stale OpenAI protocol; API-key sources do not', () => {
  const p = { auth_type: 'oauth', oauth_provider: 'claude', api_format: 'openai', base_url: 'https://api.anthropic.com/v1' };
  assert.equal(gw.providerApiFormat(p), 'anthropic');
  assert.equal(gw.providerApiFormat({ ...p, auth_type: 'api_key' }), 'openai');
  const converted = gw.oaiRequestToAnthropic({ model, n: 1, messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(converted.model, model);
  assert.equal(Object.hasOwn(converted, 'n'), false);
  assert.throws(() => gw.oaiRequestToAnthropic({ model, n: 3, messages: [] }), e => e.status === 400 && /n=1/.test(e.message));
});

test('ST explicit Claude model bypasses global shim, including on regeneration', async (t) => {
  const seen = [];
  const base_url = await upstream(t, (req, res) => {
    let raw = ''; req.on('data', b => raw += b);
    req.on('end', () => {
      seen.push(JSON.parse(raw).model);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
  });
  gw.testConfig({ providers: [{ id: 'st-claude-test', enabled: true, type: 'free', api_format: 'openai', base_url, models: [model, 'chatgpt-web-thinking'] }] });
  gw.setClaudeShimScene(scene);
  t.after(() => gw.setClaudeShimScene(null));
  for (let i = 0; i < 2; i++) {
    const res = response();
    await gw.testRoute(model, '/v1/chat/completions', { model, n: 1, stream: true, messages: [{ role: 'user', content: 'hello' }] }, res, 'test-unregistered-key');
    assert.equal(res.statusCode, 200);
    assert.equal(gw.getLog()[0].model, model);
    assert.equal(gw.getLog()[0].claude_from, null);
  }
  assert.deepEqual(seen, [model, model]);
});

test('stale OAuth OpenAI config actually sends native Messages and bridges back to ST', async (t) => {
  const seen = [];
  const base_url = await upstream(t, (req, res) => {
    let raw = ''; req.on('data', b => raw += b);
    req.on('end', () => {
      seen.push({ path: req.url, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"native reply"}}\n\ndata: {"type":"message_stop"}\n\n');
    });
  });
  // No real credentials or refresh: the test upstream only exercises protocol selection.
  t.mock.method(oauth, 'prepare', async p => p);
  gw.testConfig({ providers: [{ id: 'st-native-test', enabled: true, type: 'free', auth_type: 'oauth', oauth_provider: 'claude', api_format: 'openai', base_url, models: [model] }] });
  const res = response();
  await gw.testRoute(model, '/v1/chat/completions', { model, n: 1, stream: true, messages: [{ role: 'user', content: 'hello' }] }, res, 'test-key');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/v1/messages');
  assert.equal(seen[0].body.model, model);
  assert.equal(Object.hasOwn(seen[0].body, 'n'), false);
  assert.match(res.text, /native reply/);
  assert.match(res.text, /chat.completion.chunk/);
  assert.equal(gw.getLog()[0].status, 'ok');
});

test('native Claude stream error is propagated, without a successful stop', async (t) => {
  const base_url = await upstream(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"mock rate limit"}}\n\n');
  });
  gw.testConfig({ providers: [{ id: 'st-native-error', enabled: true, type: 'free', api_format: 'anthropic', base_url, models: [model] }] });
  const res = response();
  await gw.testRoute(model, '/v1/chat/completions', { model, stream: true, messages: [{ role: 'user', content: 'hello' }] }, res, 'test-key');
  assert.match(res.text, /mock rate limit/);
  assert.equal(res.text.includes('[DONE]'), false);
  assert.equal(gw.getLog()[0].status, 'error');
  assert.match(gw.getLog()[0].error, /HTTP_429/);
});

test('native Claude HTTP error retains its explanation', async (t) => {
  const base_url = await upstream(t, (_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'mock missing user message' } }));
  });
  gw.testConfig({ providers: [{ id: 'st-native-http-error', enabled: true, type: 'free', api_format: 'anthropic', base_url, models: [model] }] });
  for (const stream of [true, false]) {
    const res = response();
    await gw.testRoute(model, '/v1/chat/completions', { model, stream, messages: [{ role: 'user', content: 'hello' }] }, res, 'test-key');
    assert.equal(res.statusCode, 400);
    assert.match(res.text, /mock missing user message/);
  }
});

test('explicit model failure does not retry an unrelated model', async (t) => {
  const seen = [];
  const base_url = await upstream(t, (req, res) => {
    let raw = ''; req.on('data', b => raw += b);
    req.on('end', () => {
      seen.push(JSON.parse(raw).model);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'test upstream unavailable' } }));
    });
  });
  gw.testConfig({ providers: [{ id: 'st-fail-test', enabled: true, type: 'free', base_url, models: [model, 'chatgpt-web-thinking'] }] });
  gw.setClaudeShimScene(scene);
  t.after(() => gw.setClaudeShimScene(null));
  const res = response();
  await gw.testRoute(model, '/v1/chat/completions', { model, stream: true, messages: [{ role: 'user', content: 'hello' }] }, res, 'test-unregistered-key');
  assert.deepEqual(seen, [model]);
  assert.equal(res.statusCode, 502);
  assert.equal(gw.getLog()[0].status, 'error');
});

test('SSE error after partial output is logged as failure, not success', async (t) => {
  const base_url = await upstream(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    res.write('data: {"error":{"type":"api_error","message":"browser ');
    res.end('disconnected"}}\n\n');
  });
  gw.testConfig({ providers: [{ id: 'st-stream-error', enabled: true, type: 'free', base_url, models: ['chatgpt-web-thinking'] }] });
  const res = response();
  await gw.testRoute('chatgpt-web-thinking', '/v1/chat/completions', { model: 'chatgpt-web-thinking', stream: true, messages: [{ role: 'user', content: 'hello' }] }, res, 'test-key');
  assert.match(res.text, /browser disconnected/);
  assert.equal(res.writableEnded, true);
  assert.equal(gw.getLog()[0].status, 'error');
  assert.match(gw.getLog()[0].error, /browser disconnected/);
});
