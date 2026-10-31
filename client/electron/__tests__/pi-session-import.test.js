'use strict';
// Pi 会话补录：assistant / 独立 usage 计入，用户行和走网关的 tokenbank 行不计。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandEntity, handlerOps } = require('../app-handlers');
const { importSource } = require('../session-import');

const SRC = {
  id: 'pi',
  data_source: 'session-pi',
  provider_id: 'pi-cli',
  tier: 'paid',
  billing_type: 'api-key',
  format: 'jsonl',
  glob: '**/*.jsonl',
  skip_if_zero: true,
  require_request_id: true,
  request_id: 'pi:{session_id}:{id}',
  meta: [
    { filter: { field: 'type', equals: 'session' }, set: { session_id: 'id' } },
    { filter: { field: 'type', equals: 'model_change' }, set: { model: 'modelId' } },
  ],
  record_filter: {
    all: [
      { any: [
        { all: [
          { field: 'type', equals: 'message' },
          { field: 'message.role', in: ['assistant', 'toolResult'] },
        ] },
        { field: 'type', in: ['usage', 'compaction', 'branch_summary'] },
      ] },
      { field: 'message.provider', not_equals: 'tokenbank' },
      { field: 'provider', not_equals: 'tokenbank' },
    ],
  },
  fields: {
    ts: 'timestamp',
    model: ['message.model', 'model'],
    input_tokens: ['message.usage.input', 'usage.input'],
    output_tokens: ['message.usage.output', 'usage.output'],
    cache_read_tokens: ['message.usage.cacheRead', 'usage.cacheRead'],
    cache_create_tokens: ['message.usage.cacheWrite', 'usage.cacheWrite'],
  },
};

function stubStats() {
  const rows = [];
  return {
    rows,
    getImportState: () => null,
    setImportState: () => {},
    record: (row) => { rows.push(row); return true; },
  };
}

test('百宝箱按现行包名安装 Pi', () => {
  const ops = handlerOps('pi-cli');
  assert.equal(ops.npm_package, '@earendil-works/pi-coding-agent');
  assert.equal(ops.npm_install_args, '--ignore-scripts');
  assert.match(ops.install_guide.mac, /install\.sh/);
  assert.match(ops.install_guide.win, /install\.ps1/);
});

test('Pi 实体默认打开会话补录', () => {
  const ent = expandEntity({ id: 'pi', handler: 'pi-cli', vars: {} });
  assert.equal(ent.session_usage_import, true);
  assert.equal(ent.data_source, 'session-pi');
  assert.ok(ent.linked_data_sources.includes('session-pi'));
});

test('Pi 会话文件只补录直连用量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sess-'));
  const file = path.join(dir, '2026-10-31_abc.jsonl');
  const lines = [
    { type: 'session', version: 3, id: 'sess-1', timestamp: '2026-10-31T00:00:00.000Z' },
    { type: 'model_change', id: 'm1', timestamp: '2026-10-31T00:00:01.000Z', provider: 'anthropic', modelId: 'claude' },
    { type: 'message', id: 'u1', timestamp: '2026-10-31T00:00:02.000Z', message: { role: 'user', content: 'hi' } },
    { type: 'message', id: 'a1', timestamp: '2026-10-31T00:00:03.000Z', message: {
      role: 'assistant', provider: 'anthropic', model: 'claude-sonnet',
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 3, reasoning: 1 },
    } },
    { type: 'usage', id: 'w1', timestamp: '2026-10-31T00:00:04.000Z', provider: 'anthropic', model: 'claude-sonnet',
      usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { type: 'message', id: 'gw1', timestamp: '2026-10-31T00:00:05.000Z', message: {
      role: 'assistant', provider: 'tokenbank', model: 'gpt',
      usage: { input: 99, output: 99 },
    } },
    { type: 'compaction', id: 'c1', timestamp: '2026-10-31T00:00:06.000Z', usage: { input: 7, output: 1 } },
  ];
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');

  const stats = stubStats();
  const result = importSource(stats, { ...SRC, root: dir });
  assert.equal(result.imported, 3);
  const byId = Object.fromEntries(stats.rows.map(r => [r.request_id, r]));
  assert.equal(byId['pi:sess-1:a1'].input_tokens, 10);
  assert.equal(byId['pi:sess-1:a1'].output_tokens, 4);
  assert.equal(byId['pi:sess-1:a1'].cache_read_tokens, 2);
  assert.equal(byId['pi:sess-1:a1'].cache_create_tokens, 3);
  assert.equal(byId['pi:sess-1:a1'].model, 'claude-sonnet');
  assert.equal(byId['pi:sess-1:w1'].input_tokens, 5);
  assert.equal(byId['pi:sess-1:c1'].model, 'claude');
  assert.equal(byId['pi:sess-1:c1'].input_tokens, 7);
  assert.equal(byId['pi:sess-1:gw1'], undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
