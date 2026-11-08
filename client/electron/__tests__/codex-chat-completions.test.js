'use strict';
// Codex OAuth subscriptions speak Responses at chatgpt.com/backend-api/codex/responses.
// A Chat Completions client used to be proxied to .../codex/v1/chat/completions and 404.
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { EventEmitter } = require('events');
const { test, mock, before, after } = require('node:test');
const assert = require('node:assert/strict');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-codex-chat-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  delete process.env[key];
}

const oauth = require('../oauth');
const {
  chatToCodexResponses,
  ResponsesToChatStream,
  createResponsesSseDecoder,
  CODEX_DEFAULT_INSTRUCTIONS,
} = require('../codex-transform');
const { resolveUpstreamUrl, start, stop, getStatus } = require('../local-gateway');

const TINY_PNG = 'data:image/png;base64,AAAA';
const IDENTIFY_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
  additionalProperties: false,
};

function codexProvider() {
  return {
    id: 'openai',
    type: 'subscription',
    billing_type: 'subscription',
    source: 'subscription',
    base_url: 'https://api.openai.com/v1',
    auth_type: 'oauth',
    oauth_provider: 'codex',
    enabled: true,
    models: ['gpt-5.4-mini'],
    credentials: {
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      account_id: 'acct_test',
      expires_at: Math.floor(Date.now() / 1000) + 86400,
    },
  };
}

function apiKeyProvider() {
  return {
    id: 'openai-key',
    type: 'paid',
    billing_type: 'payg',
    base_url: 'https://api.openai.com/v1',
    auth_type: 'api_key',
    api_format: 'openai',
    token: 'sk-test',
    enabled: true,
    models: ['gpt-5.4-mini'],
  };
}

function claudeProvider() {
  return {
    id: 'claude',
    type: 'paid',
    base_url: 'https://api.anthropic.com',
    api_format: 'anthropic',
    auth_type: 'api_key',
    token: 'sk-ant-test',
    enabled: true,
    models: ['claude-sonnet'],
  };
}

function okSse(text = 'ok') {
  return [
    { type: 'response.created', response: { id: 'resp_ok', model: 'gpt-5.4-mini', created_at: 1700000000, status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: {
      id: 'resp_ok', model: 'gpt-5.4-mini', created_at: 1700000000, status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 2 } },
    } },
  ];
}

function encodeSse(events) {
  return events.map((evt) => `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`).join('') + 'data: [DONE]\n\n';
}

test('original failure: Codex OAuth base plus chat path is not a Codex endpoint', () => {
  const auth = oauth.applyAuth('codex', {
    headers: { 'Content-Type': 'application/json' },
    body: { model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'reply ok' }] },
    credentials: { access_token: 'test-access-token', account_id: 'acct_test' },
  });
  assert.equal(auth.baseUrl, 'https://chatgpt.com/backend-api/codex');
  assert.equal(auth.headers.Authorization, 'Bearer test-access-token');
  assert.equal(auth.headers['chatgpt-account-id'], 'acct_test');
  assert.equal(auth.headers.originator, 'codex_cli_rs');
  // This is the URL a generic chat proxy built, and the subscription returned 404.
  assert.equal(
    resolveUpstreamUrl(auth.baseUrl, '/v1/chat/completions'),
    'https://chatgpt.com/backend-api/codex/v1/chat/completions',
  );
  assert.equal(
    resolveUpstreamUrl(auth.baseUrl, '/v1/responses'),
    'https://chatgpt.com/backend-api/codex/responses',
  );
});

test('chatToCodexResponses keeps system text, images, tools, and json schema', () => {
  const converted = chatToCodexResponses({
    model: 'gpt-5.4-mini',
    temperature: 0,
    max_tokens: 128,
    messages: [
      { role: 'system', content: 'Identify the plant.' },
      { role: 'user', content: 'what is this?' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"leaf"}' },
      }], reasoning_content: 'check the leaf' },
      { role: 'tool', tool_call_id: 'call_1', content: 'maple' },
      { role: 'user', content: [
        { type: 'text', text: 'confirm' },
        { type: 'image_url', image_url: { url: TINY_PNG, detail: 'high' } },
      ] },
    ],
    tools: [{ type: 'function', function: {
      name: 'lookup', description: 'Look up a plant', parameters: { type: 'object', properties: { q: { type: 'string' } } }, strict: true,
    } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
    response_format: { type: 'json_schema', json_schema: { name: 'identification', strict: true, schema: IDENTIFY_SCHEMA } },
  });
  assert.equal(converted.model, 'gpt-5.4-mini');
  assert.equal(converted.instructions, 'Identify the plant.');
  assert.equal(converted.stream, true);
  assert.equal(converted.store, false);
  assert.equal(converted.temperature, 0);
  assert.equal(converted.max_output_tokens, undefined);
  assert.equal(converted.max_tokens, undefined);
  assert.equal(converted.tools[0].name, 'lookup');
  assert.equal(converted.tools[0].parameters.properties.q.type, 'string');
  assert.equal(converted.tools[0].strict, true);
  assert.deepEqual(converted.tool_choice, { type: 'function', name: 'lookup' });
  assert.equal(converted.text.format.type, 'json_schema');
  assert.equal(converted.text.format.name, 'identification');
  assert.equal(converted.text.format.strict, true);
  assert.deepEqual(converted.text.format.schema, IDENTIFY_SCHEMA);
  assert.equal(converted.input[0].content[0].text, 'what is this?');
  assert.equal(converted.input[1].type, 'reasoning');
  assert.equal(converted.input[2].type, 'function_call');
  assert.equal(converted.input[2].call_id, 'call_1');
  assert.equal(converted.input[2].arguments, '{"q":"leaf"}');
  assert.equal(converted.input[3].type, 'function_call_output');
  assert.equal(converted.input[3].output, 'maple');
  const image = converted.input[4].content.find((part) => part.type === 'input_image');
  assert.equal(image.image_url, TINY_PNG);
  assert.equal(image.detail, 'high');
  assert.equal(converted.input[4].content[0].text, 'confirm');
});

test('chatToCodexResponses preserves developer guidance and does not invent a prompt over it', () => {
  const both = chatToCodexResponses({
    model: 'gpt-5.4-mini',
    messages: [
      { role: 'developer', content: 'Schema only.' },
      { role: 'system', content: 'Identify the plant.' },
      { role: 'user', content: 'reply ok' },
    ],
  });
  assert.match(both.instructions, /\[developer\]\nSchema only\./);
  assert.match(both.instructions, /\[system\]\nIdentify the plant\./);
  assert.equal(both.instructions.includes(CODEX_DEFAULT_INSTRUCTIONS), false);

  const developerOnly = chatToCodexResponses({
    model: 'gpt-5.4-mini',
    messages: [
      { role: 'developer', content: 'Schema only.' },
      { role: 'user', content: 'reply ok' },
    ],
  });
  assert.equal(developerOnly.instructions, 'Schema only.');
});

test('chatToCodexResponses uses a default instruction only when the client sent none', () => {
  const converted = chatToCodexResponses({
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'reply ok' }],
  });
  assert.equal(converted.instructions, CODEX_DEFAULT_INSTRUCTIONS);
  assert.deepEqual(converted.input, [{
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'reply ok' }],
  }]);
});

test('chatToCodexResponses rejects content it cannot represent', () => {
  assert.throws(() => chatToCodexResponses({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA' } }] }],
  }), /input_audio/);
  assert.throws(() => chatToCodexResponses({
    model: 'm',
    messages: [{ role: 'system', content: [{ type: 'image_url', image_url: { url: TINY_PNG } }] }],
  }), /system messages/);
  assert.throws(() => chatToCodexResponses({
    model: 'm', n: 2,
    messages: [{ role: 'user', content: 'hi' }],
  }), /parameter n/);
  assert.throws(() => chatToCodexResponses({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'web_search' }],
  }), /web_search/);
  assert.throws(() => chatToCodexResponses({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    response_format: { type: 'json_schema', json_schema: { schema: {} } },
  }), /name and schema/);
  assert.throws(() => chatToCodexResponses({
    model: 'm', stop: ['END'],
    messages: [{ role: 'user', content: 'hi' }],
  }), /parameter stop/);
});

test('Responses SSE aggregates deltas once and keeps tool arguments and usage', () => {
  const sm = new ResponsesToChatStream({ model: 'gpt-5.4-mini', streaming: false, includeUsage: true });
  const decoder = createResponsesSseDecoder();
  const raw = encodeSse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"maple"}' },
    { type: 'response.completed', response: {
      id: 'resp_tool', model: 'gpt-5.4-mini', created_at: 1700000000, status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"maple"}' }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    } },
  ]);
  const split = raw.length / 2;
  for (const evt of decoder.push(raw.slice(0, split))) sm.handleEvent(evt);
  for (const evt of decoder.push(raw.slice(split))) sm.handleEvent(evt);
  for (const evt of decoder.flush()) sm.handleEvent(evt);
  const chat = sm.toChatCompletion();
  assert.equal(chat.object, 'chat.completion');
  assert.equal(chat.id, 'chatcmpl-tool');
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
  assert.equal(chat.choices[0].message.tool_calls[0].id, 'call_1');
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'lookup');
  assert.equal(chat.choices[0].message.tool_calls[0].function.arguments, '{"q":"maple"}');
  const live = new ResponsesToChatStream({ model: 'gpt-5.4-mini', streaming: true, includeUsage: true });
  let toolSse = '';
  const toolDecoder = createResponsesSseDecoder();
  const toolRaw = encodeSse([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"q":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"maple"}' },
    { type: 'response.completed', response: {
      id: 'resp_tool', model: 'gpt-5.4-mini', created_at: 1700000000, status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"maple"}' }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    } },
  ]);
  for (const evt of toolDecoder.push(toolRaw)) toolSse += live.handleEvent(evt);
  toolSse += live.finish();
  const argPieces = [];
  for (const line of toolSse.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const calls = JSON.parse(line.slice(6)).choices[0].delta.tool_calls;
    if (calls && calls[0].function && calls[0].function.arguments) argPieces.push(calls[0].function.arguments);
  }
  assert.equal(argPieces.join(''), '{"q":"maple"}');
  assert.equal(chat.usage.prompt_tokens, 8);
  assert.equal(chat.usage.completion_tokens, 3);
  assert.equal(chat.choices[0].message.content, null);

  const streamed = new ResponsesToChatStream({ model: 'gpt-5.4-mini', streaming: true, includeUsage: true });
  let out = '';
  for (const evt of okSse('{"name":"maple"}')) out += streamed.handleEvent(evt);
  out += streamed.finish();
  const deltas = [];
  for (const line of out.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const choice = JSON.parse(line.slice(6)).choices[0];
    if (choice.delta && choice.delta.content) deltas.push(choice.delta.content);
    if (choice.finish_reason) assert.equal(choice.finish_reason, 'stop');
  }
  assert.deepEqual(deltas, ['{"name":"maple"}']);
  assert.match(out, /"object":"chat.completion.chunk"/);
  assert.match(out, /"prompt_tokens":5/);
  assert.match(out, /data: \[DONE\]/);
  const failed = new ResponsesToChatStream({ streaming: true });
  failed.handleEvent({ type: 'response.failed', response: { status: 'failed', error: { message: 'quota', type: 'insufficient_quota', code: 'insufficient_quota' } } });
  assert.equal(failed.failure.message, 'quota');
  assert.equal(failed.failure.code, 'insufficient_quota');
});

test.describe('codex oauth gateway', { concurrency: 1 }, () => {
let providers = [];
let saves = 0;
let port = 0;
let requests = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const chosen = server.address().port;
      server.close(() => resolve(chosen));
    });
  });
}

function installUpstream(handler) {
  requests = [];
  mock.method(https, 'request', (opts, cb) => {
    const req = new EventEmitter();
    const chunks = [];
    const rec = { url: '', headers: opts.headers, body: null, destroyed: false };
    req.write = (chunk) => { chunks.push(Buffer.from(chunk)); return true; };
    req.destroy = () => {
      rec.destroyed = true;
      if (!req.emittedError) {
        req.emittedError = true;
        process.nextTick(() => req.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
      }
    };
    req.end = () => {
      rec.url = `https://${opts.hostname}${opts.path}`;
      rec.body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
      requests.push(rec);
      const outcome = handler(rec) || { status: 200, raw: '{}' };
      if (outcome.hold) return;
      const res = new EventEmitter();
      res.statusCode = outcome.status || 200;
      res.headers = outcome.headers || {};
      process.nextTick(() => {
        if (req.emittedError) return;
        cb(res);
        const payload = outcome.raw != null ? outcome.raw : JSON.stringify(outcome.json || {});
        res.emit('data', Buffer.from(payload));
        res.emit('end');
      });
    };
    req.setTimeout = () => {};
    return req;
  });
}

function startPost(urlPath, body) {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({
    host: '127.0.0.1',
    port,
    path: urlPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      Authorization: 'Bearer local-caller-key',
    },
  });
  const done = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch { /* SSE */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
  });
  req.end(data);
  return { req, done };
}

async function post(urlPath, body) {
  const { done } = startPost(urlPath, body);
  return done;
}

async function waitFor(fn, label) {
  const startAt = Date.now();
  while (Date.now() - startAt < 2000) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timeout waiting for ${label}`);
}

before(async () => {
  port = await freePort();
  start(port, () => ({ providers }), () => { saves += 1; });
  await waitFor(() => getStatus().running, 'gateway listen');
});

after(() => {
  mock.restoreAll();
  stop();
});

test('fixed gateway: minimal chat uses Codex /responses and returns one chat completion', async () => {
  providers = [codexProvider()];
  saves = 0;
  installUpstream(() => ({ status: 200, raw: encodeSse(okSse('ok')) }));
  const res = await post('/v1/chat/completions', {
    model: 'openai:gpt-5.4-mini',
    messages: [{ role: 'user', content: 'reply ok' }],
  });
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(req.url.includes('/chat/completions'), false);
  assert.equal(req.body.model, 'gpt-5.4-mini');
  assert.equal(req.body.stream, true);
  assert.equal(req.body.store, false);
  assert.equal(req.body.instructions, CODEX_DEFAULT_INSTRUCTIONS);
  assert.equal(req.body.input[0].content[0].text, 'reply ok');
  assert.equal(req.body.messages, undefined);
  assert.equal(req.body.max_output_tokens, undefined);
  assert.equal(req.headers.Authorization, 'Bearer test-access-token');
  assert.equal(req.headers['chatgpt-account-id'], 'acct_test');
  assert.equal(req.headers.originator, 'codex_cli_rs');
  assert.equal(req.headers.Authorization.includes('local-caller-key'), false);
  assert.equal(res.status, 200);
  assert.equal(res.json.object, 'chat.completion');
  assert.equal(res.json.choices[0].message.content, 'ok');
  assert.equal(res.json.choices[0].finish_reason, 'stop');
  assert.equal(res.json.usage.prompt_tokens, 5);
  assert.equal(res.json.usage.prompt_tokens_details.cached_tokens, 2);
  assert.equal(saves, 0);
  mock.restoreAll();
});

test('fixed gateway: image_url and json_schema identification survive the Codex request', async () => {
  providers = [codexProvider()];
  installUpstream(() => ({ status: 200, raw: encodeSse(okSse('{"name":"maple"}')) }));
  const res = await post('/v1/chat/completions', {
    model: 'openai:gpt-5.4-mini',
    temperature: 0,
    max_tokens: 128,
    messages: [
      { role: 'system', content: 'Identify the plant.' },
      { role: 'developer', content: 'Schema only.' },
      { role: 'user', content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: TINY_PNG, detail: 'high' } },
      ] },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'identification', strict: true, schema: IDENTIFY_SCHEMA },
    },
  });
  const body = requests[0].body;
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.match(body.instructions, /Identify the plant\./);
  assert.match(body.instructions, /Schema only\./);
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.temperature, 0);
  assert.equal(body.text.format.name, 'identification');
  assert.deepEqual(body.text.format.schema, IDENTIFY_SCHEMA);
  const image = body.input[0].content.find((part) => part.type === 'input_image');
  assert.equal(image.image_url, TINY_PNG);
  assert.equal(image.detail, 'high');
  assert.equal(res.status, 200);
  assert.equal(res.json.choices[0].message.content, '{"name":"maple"}');
  mock.restoreAll();
});

test('fixed gateway: streaming chat frames include usage and a single [DONE]', async () => {
  providers = [codexProvider()];
  installUpstream(() => ({ status: 200, raw: encodeSse(okSse('ok')) }));
  const res = await post('/v1/chat/completions', {
    model: 'gpt-5.4-mini',
    stream: true,
    messages: [{ role: 'user', content: 'reply ok' }],
  });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.equal(res.raw.split('"content":"ok"').length - 1, 1);
  assert.match(res.raw, /"finish_reason":"stop"/);
  assert.match(res.raw, /"prompt_tokens":5/);
  assert.match(res.raw, /data: \[DONE\]/);
  assert.equal(requests[0].body.stream, true);
  mock.restoreAll();
});

test('upstream Codex error stays a chat error and does not call the old chat URL', async () => {
  providers = [codexProvider()];
  installUpstream(() => ({ status: 404, raw: JSON.stringify({ detail: 'Not found' }) }));
  const res = await post('/v1/chat/completions', {
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'reply ok' }],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(res.status, 404);
  assert.equal(res.json.error, 'all_providers_failed');
  assert.match(res.json.detail, /HTTP_404: Not found/);
  mock.restoreAll();
});

test('unsupported chat input fails locally and does not call Codex', async () => {
  providers = [codexProvider()];
  installUpstream(() => { throw new Error('upstream should not be called'); });
  const res = await post('/v1/chat/completions', {
    model: 'gpt-5.4-mini',
    n: 2,
    messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA' } }] }],
  });
  assert.equal(requests.length, 0);
  assert.equal(res.status, 400);
  assert.match(res.json.detail, /input_audio|parameter n/);
  mock.restoreAll();
});

test('native Responses passthrough, API-key chat, and Claude stay on their own endpoints', async () => {
  providers = [codexProvider()];
  installUpstream(() => ({ status: 200, raw: encodeSse(okSse('native')) }));
  const native = await post('/v1/responses', {
    model: 'openai:gpt-5.4-mini',
    instructions: 'be brief',
    input: 'reply ok',
    stream: true,
    store: false,
  });
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(requests[0].body.input, 'reply ok');
  assert.equal(requests[0].body.instructions, 'be brief');
  assert.equal(requests[0].body.messages, undefined);
  assert.equal(requests[0].body.stream, true);
  assert.match(native.raw, /response\.output_text\.delta/);
  assert.equal(native.raw.includes('chat.completion.chunk'), false);
  mock.restoreAll();

  providers = [apiKeyProvider()];
  installUpstream(() => ({
    status: 200,
    json: {
      id: 'chatcmpl-key', object: 'chat.completion', created: 1, model: 'gpt-5.4-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  }));
  const keyed = await post('/v1/chat/completions', {
    model: 'gpt-5.4-mini',
    temperature: 0.2,
    messages: [{ role: 'user', content: 'reply ok' }],
  });
  assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(requests[0].body.messages[0].content, 'reply ok');
  assert.equal(requests[0].body.input, undefined);
  assert.equal(requests[0].body.temperature, 0.2);
  assert.equal(requests[0].headers.Authorization, 'Bearer sk-test');
  assert.equal(requests[0].headers['chatgpt-account-id'], undefined);
  assert.equal(requests[0].headers.originator, undefined);
  assert.equal(keyed.json.choices[0].message.content, 'ok');
  mock.restoreAll();

  providers = [claudeProvider()];
  installUpstream(() => ({
    status: 200,
    json: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet',
      content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  }));
  const claude = await post('/v1/messages', {
    model: 'claude-sonnet',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(requests[0].body.messages[0].content, 'hello');
  assert.equal(requests[0].body.input, undefined);
  assert.equal(requests[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(claude.json.id, 'msg_1');
  assert.equal(claude.json.type, 'message');
  mock.restoreAll();
});

test('Codex failure still falls through to a later API-key provider', async () => {
  providers = [codexProvider(), apiKeyProvider()];
  installUpstream((rec) => {
    if (rec.url.includes('chatgpt.com')) return { status: 500, raw: JSON.stringify({ error: { message: 'subscription down' } }) };
    return {
      status: 200,
      json: {
        id: 'chatcmpl-fallback', object: 'chat.completion', created: 1, model: 'gpt-5.4-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'from-key' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    };
  });
  const res = await post('/v1/chat/completions', {
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'reply ok' }],
  });
  assert.deepEqual(requests.map((req) => req.url), [
    'https://chatgpt.com/backend-api/codex/responses',
    'https://api.openai.com/v1/chat/completions',
  ]);
  assert.equal(requests[1].body.messages[0].content, 'reply ok');
  assert.equal(requests[1].headers.Authorization, 'Bearer sk-test');
  assert.equal(res.status, 200);
  assert.equal(res.json.choices[0].message.content, 'from-key');
  mock.restoreAll();
});

test('client cancellation stops the Codex request and does not fall through', async () => {
  providers = [codexProvider(), apiKeyProvider()];
  installUpstream(() => ({ hold: true }));
  const { req, done } = startPost('/v1/chat/completions', {
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'reply ok' }],
  });
  const settled = done.then(() => 'response', () => 'closed');
  await waitFor(() => requests.length === 1, 'upstream request');
  req.destroy();
  await waitFor(() => requests[0].destroyed, 'upstream destroyed');
  await settled;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  mock.restoreAll();
});
});
