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

test('relative output path becomes the proxy url and stays stable', async () => {
  const { presentRemoteAgentText } = await load();
  const name = '轻记账技能-宣传片-16x9.mp4';
  const url = `https://tokenbank.wink.run/media/agent/at-33da2dfede1f/${name}`;
  const text = `成片：/Users/ully/.tokenbank/contribute-workspaces/res-assistant-video-gen-agent/u1/outputs/${name}\n字幕：outputs/轻记账技能-宣传片-16x9.srt`;
  const out = presentRemoteAgentText(text, [
    { name, url },
    { name: '轻记账技能-宣传片-16x9.srt', url: 'https://tokenbank.wink.run/media/agent/at-33da2dfede1f/clip.srt' },
  ]);
  assert.equal(out.includes('/Users/ully'), false);
  assert.equal(out.includes(url), true);
  assert.equal(out.includes('https://tokenbank.wink.run/media/agent/at-33da2dfede1f/clip.srt'), true);
  assert.equal(out.includes('outputs/'), false);
  assert.equal(presentRemoteAgentText(out, [
    { name, url },
    { name: '轻记账技能-宣传片-16x9.srt', url: 'https://tokenbank.wink.run/media/agent/at-33da2dfede1f/clip.srt' },
  ]), out);
});

test('unrelayed lessor path keeps only the file name', async () => {
  const { presentRemoteAgentText } = await load();
  const out = presentRemoteAgentText(`写入 ${LOCAL}`, []);
  assert.equal(out, '写入 pelican.svg');
  assert.equal(out.includes('/Users/wink'), false);
});
