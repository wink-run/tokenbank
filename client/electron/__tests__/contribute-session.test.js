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

test('collectWorkspaceArtifacts ships video and subtitle, including paths over 4MB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-art-'));
  const outDir = path.join(root, 'outputs');
  fs.mkdirSync(outDir);
  const videoName = '轻记账技能-宣传片-16x9.mp4';
  const subName = '轻记账技能-宣传片-16x9.srt';
  const video = path.join(outDir, videoName);
  const sub = path.join(outDir, subName);
  fs.writeFileSync(video, Buffer.alloc(5 * 1024 * 1024, 1));
  fs.writeFileSync(sub, '1\n00:00:00,000 --> 00:00:01,000\n你好\n');
  const started = Date.now() - 1000;
  const text = `成片：${video}\n字幕：outputs/${subName}`;
  const arts = collectWorkspaceArtifacts(root, text, started);
  const names = arts.map((a) => a.name);
  assert.ok(names.includes(videoName));
  assert.ok(names.includes(subName));
  const mp4 = arts.find((a) => a.name === videoName);
  assert.equal(mp4.mime, 'video/mp4');
  assert.equal(mp4.kind, 'file');
  assert.ok(mp4.dataUrl.startsWith('data:video/mp4;base64,'));
  assert.equal(mp4.localPath, fs.realpathSync(video));
  fs.rmSync(root, { recursive: true, force: true });
});

test('collectWorkspaceArtifacts picks a cover named only by filename', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-art-'));
  const outDir = path.join(root, 'outputs');
  fs.mkdirSync(outDir);
  const cover = '轻记账技能-封面-16x9.png';
  fs.writeFileSync(path.join(outDir, cover), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const started = Date.now() - 1000;
  const arts = collectWorkspaceArtifacts(root, '封面图\n`轻记账技能-封面-16x9.png`', started);
  assert.ok(arts.some((a) => a.name === cover && a.mime === 'image/png'));
  fs.rmSync(root, { recursive: true, force: true });
});
