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
});
