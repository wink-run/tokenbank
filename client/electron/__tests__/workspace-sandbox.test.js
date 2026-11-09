'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSeatbeltProfile } = require('../workspace-sandbox');

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
