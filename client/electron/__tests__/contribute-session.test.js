'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveConsumerKey,
  contributeSessionKey,
  isContributeSessionKey,
  ensureContributeWorkspace,
  collectWorkspaceArtifacts,
  safeSegment,
} = require('../contribute-session');

test('resolveConsumerKey prefers consumer_key then uid then task', () => {
  assert.equal(resolveConsumerKey({ consumer_key: 'u42' }), 'u42');
  assert.equal(resolveConsumerKey({ consumer_user_id: 7 }), 'u7');
  assert.equal(resolveConsumerKey({ task_id: 'at-abc' }), 'task-at-abc');
  assert.equal(resolveConsumerKey({}), 'anon');
});

test('contributeSessionKey isolates users', () => {
  const a = contributeSessionKey('poetry', 'u1');
  const b = contributeSessionKey('poetry', 'u2');
  assert.equal(a, 'contribute:poetry:u1');
  assert.equal(b, 'contribute:poetry:u2');
  assert.notEqual(a, b);
  assert.equal(isContributeSessionKey(a), true);
  assert.equal(isContributeSessionKey('assistant:poetry'), false);
});

test('ensureContributeWorkspace creates per-user dirs', () => {
  const root = path.join(os.homedir(), '.tokenbank', 'contribute-workspaces');
  const d1 = ensureContributeWorkspace('asst-demo', 'u1');
  const d2 = ensureContributeWorkspace('asst-demo', 'u2');
  assert.ok(d1.startsWith(root));
  assert.ok(fs.existsSync(d1));
  assert.ok(fs.existsSync(d2));
  assert.notEqual(d1, d2);
  assert.equal(path.basename(d1), 'u1');
  assert.equal(path.basename(d2), 'u2');
});

test('safeSegment strips unsafe path chars', () => {
  assert.equal(safeSegment('../evil name!!'), 'evil_name');
});

test('collectWorkspaceArtifacts keeps in-workspace outputs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-art-'));
  const outDir = path.join(root, 'out');
  fs.mkdirSync(outDir);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const img = path.join(outDir, 'kuafu-hero-ink.png');
  const note = path.join(outDir, 'notes.txt');
  const old = path.join(outDir, 'old.png');
  fs.writeFileSync(img, png);
  fs.writeFileSync(note, 'hello');
  fs.writeFileSync(old, png);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(old, past, past);
  const outside = path.join(os.tmpdir(), `tb-secret-${Date.now()}.txt`);
  fs.writeFileSync(outside, 'nope');
  const started = Date.now() - 1000;
  const arts = collectWorkspaceArtifacts(root, `成品\n${img}\n也看 ${outside}`, started);
  const names = arts.map((a) => a.name);
  assert.ok(names.includes('kuafu-hero-ink.png'));
  assert.ok(names.includes('notes.txt'));
  assert.equal(names.includes('old.png'), false);
  assert.equal(names.includes(path.basename(outside)), false);
  const image = arts.find((a) => a.name === 'kuafu-hero-ink.png');
  assert.equal(image.kind, 'image');
  assert.ok(image.dataUrl.startsWith('data:image/png;base64,'));
  fs.rmSync(root, { recursive: true, force: true });
  fs.unlinkSync(outside);
});
