'use strict';
// 不用用户提 Token Bank：工具说明里直接写上现在有的智能体、提示词、模型、能接活的智能体，模型碰到合适的任务自己会用
const test = require('node:test');
const assert = require('node:assert/strict');
const tools = require('../tokenbank-tools');
const executor = require('../agent-executor');

test('工具说明附上现有的智能体、提示词、模型和能接活的智能体', async () => {
  tools.setResourceManager({
    listAssistantsForClient: () => [{ name: 'ppt-maker', display_name: 'PPT 生成', description: '把大纲做成 PPT' }],
    listPromptsForClient: () => Array.from({ length: 15 }, (_, i) => ({ name: `p${i}`, display_name: i === 0 ? '翻译成日文' : `提示词${i}` })),
    listSkillsForClient: () => [],
  });
  tools.setListModelsImpl(async () => [{ id: 'deepseek-v4' }, { id: 'gpt-image-1', model_type: 'image' }, { id: 'text-embedding-3', model_type: 'embedding' }]);
  const orig = executor.listDispatchTargets;
  executor.listDispatchTargets = async () => [{ id: 'assistant:1', name: '论文润色', description: '润色学术论文', type: 'assistant' }, { id: 'g', name: '管家', guardian: true }];
  try {
    const list = await tools.listToolsWithHints({ clientId: 'hint-test', level: 'full' });
    const d = Object.fromEntries(list.map((t) => [t.name, t.description]));
    assert.match(d.tb_get_resource, /PPT 生成（把大纲做成 PPT）/);
    assert.match(d.tb_get_resource, /翻译成日文/);
    assert.match(d.tb_get_resource, /共 15 个/, '多了只列前面的，写总数');
    assert.match(d.tb_list_models, /图像：gpt-image-1/);
    assert.match(d.tb_list_models, /向量：text-embedding-3/);
    assert.match(d.tb_dispatch_agent, /论文润色/);
    assert.doesNotMatch(d.tb_dispatch_agent, /管家/);
    assert.match(tools.INSTRUCTIONS, /不用等用户提 Token Bank/);
  } finally {
    executor.listDispatchTargets = orig;
    tools.setResourceManager(null);
    tools.setListModelsImpl(null);
  }
});

test('取不到数据也不拖慢工具列表', async () => {
  tools.setResourceManager({ listAssistantsForClient: () => [], listPromptsForClient: () => [] });
  tools.setListModelsImpl(() => new Promise(() => {})); // 永远不回
  const orig = executor.listDispatchTargets;
  executor.listDispatchTargets = () => new Promise(() => {});
  try {
    const t = Date.now();
    const list = await tools.listToolsWithHints({ clientId: 'hint-slow', level: 'full' });
    assert.ok(Date.now() - t < 1500, `用了 ${Date.now() - t}ms`);
    assert.ok(list.some((x) => x.name === 'tb_capabilities'));
  } finally {
    executor.listDispatchTargets = orig;
    tools.setResourceManager(null);
    tools.setListModelsImpl(null);
  }
});
