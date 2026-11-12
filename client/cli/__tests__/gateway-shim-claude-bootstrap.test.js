'use strict';
// Docker gateway 须在启动路径接入 shim key 解析与 Claude settings 引导
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('gateway.js 在 start 前调用 installShimLinkerResolvers 与 syncAllHostedClaudeCodeEndpoints', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'gateway.js'), 'utf8');
  assert.match(
    src,
    /installShimLinkerResolvers\s*\(\s*readLocalConfig\s*\)/,
    '须注入与桌面一致的 setKeyResolver',
  );
  assert.match(
    src,
    /syncAllHostedClaudeCodeEndpoints\s*\(\s*readLocalConfig/,
    '启动时应补齐已托管 Claude Code 的 settings.json',
  );
});
