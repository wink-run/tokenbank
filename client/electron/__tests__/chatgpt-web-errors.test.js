'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const host = require('../chatgpt-web/host');
const { handleChat } = require('../chatgpt-web/server');

function response() {
  return {
    headersSent: false, statusCode: null, text: '', ended: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
    write(data) { assert.equal(this.ended, false); this.text += data; },
    end(data = '') { this.text += data; this.ended = true; },
  };
}
const body = { model: 'chatgpt-web-thinking', messages: [{ role: 'user', content: 'hello' }] };

test('browser submit timeout before any text returns HTTP 502, not assistant text', async (t) => {
  const res = response();
  t.mock.method(host, 'runTurn', async () => {
    assert.equal(res.headersSent, false);
    throw new Error('提交后未出现新的 assistant 回合');
  });
  await handleChat('test', res, body, true);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.text).error.message, /assistant/);
  assert.equal(res.text.includes('[错误]'), false);
  assert.equal(res.text.includes('[DONE]'), false);
  assert.equal(res.ended, true);
});

test('login error before first delta returns 401', async (t) => {
  t.mock.method(host, 'runTurn', async () => { throw Object.assign(new Error('login required'), { code: 'NOT_LOGGED_IN' }); });
  const res = response();
  await handleChat('test', res, body, true);
  assert.equal(res.statusCode, 401);
  assert.equal(JSON.parse(res.text).error.type, 'authentication_error');
});

test('midstream browser failure emits SSE error without successful stop or DONE', async (t) => {
  t.mock.method(host, 'runTurn', async (_id, _prompt, { onDelta }) => {
    onDelta('partial'); throw new Error('browser disconnected');
  });
  const res = response();
  await handleChat('test', res, body, true);
  const events = res.text.trim().split('\n\n').map(line => JSON.parse(line.slice(6)));
  assert.equal(res.statusCode, 200);
  assert.equal(events[1].choices[0].delta.content, 'partial');
  assert.equal(events[2].error.message, 'browser disconnected');
  assert.equal(res.text.includes('"finish_reason":"stop"'), false);
  assert.equal(res.text.includes('[DONE]'), false);
  assert.equal(res.ended, true);
});

test('successful streaming keeps role, content, stop and DONE', async (t) => {
  t.mock.method(host, 'runTurn', async (_id, _prompt, { onDelta }) => {
    onDelta('hello'); onDelta(' world'); return { text: 'hello world' };
  });
  const res = response();
  await handleChat('test', res, body, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.text, /"role":"assistant"/);
  assert.match(res.text, /"content":"hello"/);
  assert.match(res.text, /"content":" world"/);
  assert.match(res.text, /"finish_reason":"stop"/);
  assert.ok(res.text.endsWith('data: [DONE]\n\n'));
});

test('successful final-only host output is not lost', async (t) => {
  t.mock.method(host, 'runTurn', async () => ({ text: 'final' }));
  const res = response();
  await handleChat('test', res, body, true);
  assert.match(res.text, /"content":"final"/);
});

test('nonstream browser failure remains HTTP 502', async (t) => {
  t.mock.method(host, 'runTurn', async () => { throw new Error('failed'); });
  const res = response();
  await handleChat('test', res, body, false);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.text).error.message, 'failed');
});
