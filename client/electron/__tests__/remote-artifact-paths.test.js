'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const LOCAL = '/Users/wink/tokenbank/contribute/workspaces/apps/claude-code/u1/pelican.svg';
const URL = 'https://tokenbank.wink.run/media/agent/at-33da2dfede1f/pelican.svg';

async function load() {
  // 页面按 ESM 加载；测试文件本身仍是 CommonJS
  return import('../../shared/remote-artifact-paths.js');
}

test('remote path becomes the proxy url', async () => {
  const { presentRemoteAgentText } = await load();
  const text = `文件路径：${LOCAL}`;
  const out = presentRemoteAgentText(text, [{ name: 'pelican.svg', url: URL }]);
  assert.equal(out, `文件路径：${URL}`);
  assert.equal(presentRemoteAgentText(out, [{ name: 'pelican.svg', url: URL }]), out);
});

test('unrelayed lessor path keeps only the file name', async () => {
  const { presentRemoteAgentText } = await load();
  const out = presentRemoteAgentText(`写入 ${LOCAL}`, []);
  assert.equal(out, '写入 pelican.svg');
  assert.equal(out.includes('/Users/wink'), false);
});
