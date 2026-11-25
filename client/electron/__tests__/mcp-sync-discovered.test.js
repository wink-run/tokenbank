'use strict';
// 扫描即纳管：客户端配置 MCP 文案与来源标记
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mcpClientSync = require('../mcp-client-sync');

test('inferClientMcpDescription 只写包名 / 命令，不写来源', () => {
  const withPkg = mcpClientSync.inferClientMcpDescription({
    command: 'npx',
    args: ['-y', '@example/foo-mcp'],
  });
  assert.equal(withPkg, '@example/foo-mcp');
  assert.doesNotMatch(withPkg, /未纳管/);

  const fallback = mcpClientSync.inferClientMcpDescription({ command: 'node', args: [] });
  assert.equal(fallback, 'node');
  assert.doesNotMatch(fallback, /未纳管/);

  const empty = mcpClientSync.inferClientMcpDescription({});
  assert.equal(empty, '');
});
