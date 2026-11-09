'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildSeatbeltProfile,
  sessionTempDir,
  claudeUidTempName,
  CLAUDE_TEMP_PATH_MAX,
} = require('../workspace-sandbox');

test('沙箱只允许写工作目录和工具自己的状态目录', () => {
  const home = '/Users/demo';
  const workspace = '/Users/demo/.tokenbank/contribute-workspaces/app/u1';
  const profile = buildSeatbeltProfile({
    workspace,
    home,
    pathEnv: '/usr/bin:/opt/homebrew/bin',
  });
  assert.match(profile, /\(deny default\)/);
  assert.match(profile, /file-read-metadata \(subpath "\/"\)/);
  assert.match(profile, /file-write\* \(subpath "\/Users\/demo\/\.tokenbank\/contribute-workspaces\/app\/u1"\)/);
  assert.match(profile, /file-read\* \(subpath "\/usr\/bin"\)/);
  assert.match(profile, /file-write\* \(subpath "\/Users\/demo\/\.claude"\)/);
  assert.doesNotMatch(profile, /file-write\* \(subpath "\/Users\/demo"\)/);
  assert.doesNotMatch(profile, /\.ssh/);
  // 整个 /tmp、/private 不能读也不能写，否则能翻到别的会话的看图缓存
  assert.doesNotMatch(profile, /file-write\* \(subpath "\/tmp"\)/);
  assert.doesNotMatch(profile, /file-write\* \(subpath "\/private\/tmp"\)/);
  assert.doesNotMatch(profile, /file-read\* \(subpath "\/private"\)/);
  assert.match(profile, /claude-/);
});

test('会话临时目录短到 Claude 不会退回共用的 claude-uid', () => {
  const workspace = '/Users/demo/.tokenbank/contribute-workspaces/res-assistant-content-creator/u1/share-abc';
  const dir = sessionTempDir(workspace);
  const claudeDir = `${dir}/${claudeUidTempName()}`;
  assert.ok(Buffer.byteLength(dir) <= CLAUDE_TEMP_PATH_MAX);
  assert.ok(Buffer.byteLength(claudeDir) <= CLAUDE_TEMP_PATH_MAX);
  assert.notEqual(sessionTempDir(workspace + '-other'), dir);
  const profile = buildSeatbeltProfile({
    workspace,
    home: '/Users/demo',
    tmpDir: dir,
  });
  assert.match(profile, new RegExp(`file-write\\* \\(subpath "${dir}"\\)`));
  // 可以写本会话的子目录，但不能写共用的 claude-<uid> 这一层
  assert.doesNotMatch(profile, /file-write\* \(subpath "\/tmp\/claude-\d+"\)/);
  assert.doesNotMatch(profile, /file-write\* \(subpath "\/private\/tmp\/claude-\d+"\)/);
});
