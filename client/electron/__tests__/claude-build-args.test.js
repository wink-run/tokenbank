'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildClaudeCodeArgs,
  buildClaudeContinueArgs,
  buildClaudeStreamFlags,
} = require('../agent-executor');

const VALID_SID = '5550fa92-351c-4adb-aaf8-1f654c4b8bd7';

test('buildClaudeContinueArgs uses --resume when continuing with session id', () => {
  assert.deepEqual(
    buildClaudeContinueArgs({ continueSession: true, cliSessionId: VALID_SID }),
    ['--resume', VALID_SID],
  );
});

test('buildClaudeContinueArgs falls back to -c when continuing without session id', () => {
  assert.deepEqual(
    buildClaudeContinueArgs({ continueSession: true }),
    ['-c'],
  );
});

test('buildClaudeContinueArgs ignores stale session id when not continuing', () => {
  assert.deepEqual(
    buildClaudeContinueArgs({ continueSession: false, cliSessionId: VALID_SID }),
    [],
  );
});

test('buildClaudeStreamFlags uses stream-json without partial messages', () => {
  assert.deepEqual(buildClaudeStreamFlags(), [
    '-p', '--dangerously-skip-permissions',
    '--output-format', 'stream-json',
    '--verbose',
  ]);
  assert.ok(!buildClaudeStreamFlags().includes('--include-partial-messages'));
});

test('buildClaudeStreamFlags multimodal adds input-format stream-json', () => {
  const flags = buildClaudeStreamFlags({ multimodalInput: true });
  assert.ok(flags.includes('--input-format'));
  assert.equal(flags[flags.indexOf('--input-format') + 1], 'stream-json');
});

test('buildClaudeCodeArgs streams instead of sync json', () => {
  const args = buildClaudeCodeArgs('hello', { continueSession: false });
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--append-system-prompt'));
  assert.equal(args[args.length - 1], 'hello');
  const i = args.indexOf('--append-system-prompt');
  assert.ok(String(args[i + 1]).includes('产物交付'));
});

test('buildClaudeCodeArgs multimodal omits argv prompt (stdin carries images)', () => {
  const args = buildClaudeCodeArgs('hello', { continueSession: false, multimodalInput: true });
  assert.ok(args.includes('--input-format'));
  assert.ok(!args.includes('hello'));
});

test('buildClaudeCodeArgs includes resume before print flags', () => {
  const args = buildClaudeCodeArgs('hello', { continueSession: true, cliSessionId: VALID_SID });
  assert.deepEqual(args.slice(0, 2), ['--resume', VALID_SID]);
  assert.ok(args.includes('--append-system-prompt'));
  assert.equal(args[args.length - 1], 'hello');
});

test('buildClaudeMultimodalStdin embeds image blocks', () => {
  const {
    buildClaudeMultimodalStdin,
    ensureClaudeMultimodalArgs,
    detectImageMime,
  } = require('../agent-executor');
  const line = buildClaudeMultimodalStdin('看图', [
    { mediaType: 'image/png', data: 'AAA' },
  ]);
  const msg = JSON.parse(line.trim());
  assert.equal(msg.type, 'user');
  assert.equal(msg.message.content[0].type, 'text');
  assert.equal(msg.message.content[1].type, 'image');
  assert.equal(msg.message.content[1].source.media_type, 'image/png');

  const stripped = ensureClaudeMultimodalArgs([
    '-p', '--output-format', 'stream-json', 'user prompt text',
  ]);
  assert.ok(stripped.includes('--input-format'));
  assert.ok(!stripped.includes('user prompt text'));

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(detectImageMime(jpeg), 'image/jpeg');
});

test('materializeAttachedFiles keeps the basename inside the upload dir', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { materializeAttachedFiles } = require('../agent-executor');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-attach-'));
  try {
    const payload = Buffer.from('hello file').toString('base64');
    const info = materializeAttachedFiles(
      [{ name: '../notes.txt', dataUrl: `data:text/plain;base64,${payload}` }],
      { taskId: 't1', workingDir: dir },
    );
    assert.equal(info.paths.length, 1);
    assert.ok(info.paths[0].startsWith(dir));
    assert.ok(info.paths[0].endsWith(`${path.sep}notes.txt`));
    assert.equal(fs.readFileSync(info.paths[0], 'utf8'), 'hello file');
    assert.match(info.suffix, /Attached files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
