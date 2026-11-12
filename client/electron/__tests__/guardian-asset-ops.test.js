'use strict';
// 智能管家改智能体正文：只换技能清单时保留人设。不碰数据库。
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { patchAssistantContent, OPS } = require('../guardian/agent-api');

test('技能清单补丁保留人设和提示词', () => {
  const next = patchAssistantContent(JSON.stringify({
    soul: '你是写作助手',
    skills: ['a'],
    prompts: ['review'],
    runtime_agent: 'claude-code',
  }), { skills: ['b', ' c '] });
  const parsed = JSON.parse(next);
  assert.equal(parsed.soul, '你是写作助手');
  assert.deepEqual(parsed.skills, ['b', 'c']);
  assert.deepEqual(parsed.prompts, ['review']);
  assert.equal(parsed.runtime_agent, 'claude-code');
});

test('资产操作和资产页是同一批名字', () => {
  for (const name of ['library', 'get', 'save', 'delete', 'project', 'unproject', 'verify', 'sync', 'import', 'install']) {
    assert.equal(typeof OPS[name].run, 'function', name);
  }
});
