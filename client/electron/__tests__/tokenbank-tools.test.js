'use strict';
// tokenbank MCP 的工具：一份定义，按权限给；资产按调用方（应用）的投射门控；智能管家多一组改资产的工具
const { test } = require('node:test');
const assert = require('node:assert/strict');

const tools = require('../tokenbank-tools');

const SAMPLE = [
  {
    id: 's1', type: 'skill', name: 'image-gen', display_name: 'image-gen',
    description: '图片生成', content: '# image-gen\nuse model', projections: [{ agentId: 'cursor' }],
  },
  {
    id: 'a1', type: 'assistant', name: 'writer', display_name: '写作助手', description: '写文章',
    content: JSON.stringify({ soul: '你是写作助手', skills: ['image-gen'], prompts: [], mcp: [], model: '', runtime_agent: 'claude-code' }),
    projections: [{ agentId: 'cursor' }],
  },
  {
    id: 'p1', type: 'prompt', name: 'code-review', display_name: '代码审查',
    description: '审查', content: '请审查 $ARGUMENTS', projections: [{ agentId: 'cursor' }],
  },
];

const projected = (r, cid) => !cid || (r.projections || []).some((p) => p.agentId === cid);

function mockRm() {
  const hits = [];
  const forClient = (type, cid) => SAMPLE.filter((r) => r.type === type && projected(r, cid))
    .map((r) => ({ id: r.id, name: r.name, display_name: r.display_name, description: r.description }));
  return {
    hits,
    listResources: ({ type } = {}) => SAMPLE.filter((r) => !type || r.type === type),
    listAssistantsForClient: (cid) => forClient('assistant', cid),
    listSkillsForClient: (cid) => forClient('skill', cid),
    listPromptsForClient: (cid) => forClient('prompt', cid),
    isResourceProjectedToClient: (id, cid) => projected(SAMPLE.find((x) => x.id === id) || {}, cid),
    resolveAssistantForClient(ref, cid) {
      const r = SAMPLE.find((x) => x.type === 'assistant' && (x.name === ref || x.display_name === ref));
      if (!r || !projected(r, cid)) return { found: false };
      return { found: true, id: r.id, name: r.name, resource: r, text: '你是写作助手\n\n## 可用技能\nimage-gen' };
    },
    resolvePromptForClient(ref, args, cid) {
      const r = SAMPLE.find((x) => x.type === 'prompt' && (x.name === ref || x.display_name === ref));
      if (!r || !projected(r, cid)) return { found: false };
      return { found: true, id: r.id, name: r.name, text: r.content.replace('$ARGUMENTS', args || '') };
    },
    recordResourceHit(id) { hits.push(id); return true; },
    getResource: (id) => SAMPLE.find((r) => r.id === id) || null,
    listCatalog: ({ type } = {}) => ({
      items: [
        { type: 'skill', name: 'git-commit', display_name: 'Git 提交', description: 'commit', installed: false },
        { type: 'prompt', name: 'api-design', display_name: 'API 设计', description: 'api', installed: true },
      ].filter((it) => !type || it.type === type),
    }),
  };
}

const PIPEWORX = [{ id: 'mcp-pipeworx', name: 'pipeworx', display_name: 'Pipeworx', description: '实时数据', tools: ['ask_pipeworx'], prefix: 'pipeworx' }];

/** 每个用例换一套注入，用完复原 */
async function withMocks({ rm = mockRm(), relayed = [], plain = [] } = {}, fn) {
  tools.setResourceManager(rm);
  tools.setRelayedMcpLister(() => relayed);
  tools.setPlainToolLister(() => plain);
  try {
    return await fn(rm);
  } finally {
    tools.setResourceManager(null);
    tools.setRelayedMcpLister(null);
    tools.setPlainToolLister(null);
  }
}

const call = (name, args, ctx = {}) => tools.callTool(name, args, { level: 'full', ...ctx });
const text = (r) => r.content.map((c) => c.text).join('\n');

test('十一个工具，名字不重复；按权限逐级放开', () => {
  const names = tools.TOOLS.map((t) => t.name);
  assert.equal(names.length, 11);
  assert.equal(new Set(names).size, 11);
  const at = (level) => tools.listTools({ level }).map((t) => t.name);
  assert.deepEqual(at('off'), []);
  assert.ok(at('read').includes('tb_list_resources') && !at('read').includes('tb_dispatch_agent'));
  assert.ok(at('operate').includes('tb_dispatch_agent') && at('operate').includes('tb_chat') && !at('operate').includes('tb_call_mcp'));
  assert.equal(at('full').length, 11);
  assert.ok(tools.listTools({ level: 'full' }).every((t) => !('level' in t)), '列表里不带内部的 level 字段');
});

test('说明里不再用内部黑话，编排规则放在 instructions 里只说一次', () => {
  const blob = tools.TOOLS.map((t) => `${t.description} ${JSON.stringify(t.inputSchema)}`).join(' ') + tools.INSTRUCTIONS;
  for (const word of ['点将', '兵器', '出战', '兵书', '武将']) assert.ok(!blob.includes(word), word);
  assert.match(tools.INSTRUCTIONS, /tb_dispatch_agent/);
});

test('权限不够、工具不存在都给出说明', async () => {
  const r = await tools.callTool('tb_dispatch_agent', { agent_id: 'codex', prompt: 'x' }, { level: 'read' });
  assert.equal(r.isError, true);
  assert.match(text(r), /没有权限/);
  const gone = await call('tb_get_prompt', { name: 'x' });
  assert.equal(gone.isError, true);
  assert.match(text(gone), /没有这个工具/);
});

test('tb_list_resources：智能体、技能、提示词看整个资产库（不按应用投射限制），可按类型、关键词筛', async () => {
  await withMocks({ relayed: PIPEWORX }, async () => {
    const mine = text(await call('tb_list_resources', {}, { clientId: 'cursor' }));
    assert.match(mine, /\[智能体\] writer/);
    assert.match(mine, /\[技能\] image-gen/);
    assert.match(mine, /\[提示词\] code-review/);
    assert.match(mine, /\[MCP\] pipeworx.*ask_pipeworx/);
    const other = text(await call('tb_list_resources', { type: 'skill' }, { clientId: 'codex' }));
    assert.match(other, /\[技能\] image-gen/, '没投射给 codex 也能用');
    const q = text(await call('tb_list_resources', { query: '审查' }, { clientId: 'cursor' }));
    assert.ok(q.includes('code-review') && !q.includes('image-gen'));
  });
});

test('tb_list_resources source=catalog 列社区目录', async () => {
  await withMocks({}, async () => {
    const t = text(await call('tb_list_resources', { source: 'catalog' }));
    assert.match(t, /\[技能\|未安装\] git-commit/);
    assert.match(t, /\[提示词\|已有\] api-design/);
  });
});

test('tb_get_resource：智能体给全文并记命中；任何应用都能用；summary 只给简介', async () => {
  await withMocks({}, async (rm) => {
    const r = await call('tb_get_resource', { type: 'assistant', name: 'writer' }, { clientId: 'cursor' });
    assert.equal(r.isError, false);
    assert.match(text(r), /你是写作助手/);
    assert.match(text(r), /assistant:a1/);
    assert.deepEqual(rm.hits, ['a1']);
    const other = await call('tb_get_resource', { type: 'assistant', name: 'writer' }, { clientId: 'codex' });
    assert.equal(other.isError, false);
    assert.equal((await call('tb_get_resource', { type: 'assistant', name: 'nobody' }, { clientId: 'codex' })).isError, true);
    const summary = JSON.parse(text(await call('tb_get_resource', { type: 'assistant', name: 'writer', mode: 'summary' }, { clientId: 'cursor' })));
    assert.equal(summary.dispatch_id, 'assistant:a1');
  });
});

test('tb_get_resource：提示词按名取正文并填 $ARGUMENTS（替代以前的 tb_get_prompt）', async () => {
  await withMocks({}, async () => {
    const r = await call('tb_get_resource', { name: '代码审查', args: 'main.js' }, { clientId: 'cursor' });
    assert.equal(text(r), '请审查 main.js');
    const typed = await call('tb_get_resource', { type: 'prompt', name: 'code-review' }, { clientId: 'cursor' });
    assert.equal(typed.isError, false);
  });
});

test('tb_get_resource：技能任何应用都能读，记下是哪个应用用的', async () => {
  await withMocks({}, async (rm) => {
    const ok = await call('tb_get_resource', { type: 'skill', name: 'image-gen' }, { clientId: 'codex' });
    assert.match(text(ok), /use model/);
    assert.deepEqual(rm.hits, ['s1']);
  });
});

test('tb_capabilities：只列你能用的工具，带第三方 MCP 和 API', async () => {
  const plain = [{ id: 't1', type: 'api', name: 'search', display_name: '搜索', method: 'POST', url: 'https://ex.test/s' }];
  await withMocks({ relayed: PIPEWORX, plain }, async () => {
    const full = text(await call('tb_capabilities', {}));
    assert.ok(full.includes('tb_dispatch_agent') && full.includes('Pipeworx') && full.includes('ask_pipeworx') && full.includes('https://ex.test/s'));
    assert.ok(full.includes('/v1/images/generations'));
    const read = text(await tools.callTool('tb_capabilities', {}, { level: 'read' }));
    assert.ok(!read.includes('tb_dispatch_agent'));
  });
});

test('tb_call_mcp：第三方 MCP 经调用方给的通道，名字自动加前缀；没接入的提示', async () => {
  await withMocks({ relayed: PIPEWORX }, async () => {
    const seen = [];
    const ctx = { callRelayed: async (name, args) => { seen.push([name, args]); return { content: [{ type: 'text', text: '4.2%' }] }; } };
    const r = await call('tb_call_mcp', { server: 'Pipeworx', tool: 'ask_pipeworx', arguments: { question: 'q' } }, ctx);
    assert.equal(text(r), '4.2%');
    assert.deepEqual(seen, [['pipeworx__ask_pipeworx', { question: 'q' }]]);
    const missing = await call('tb_call_mcp', { server: 'nope', tool: 'x' }, ctx);
    assert.equal(missing.isError, true);
    assert.match(text(missing), /没有接入这个 MCP/);
  });
});

test('tb_call_mcp：HTTP API 直接调用，参数覆盖模板里的示例值', async () => {
  const api = { id: 't1', type: 'api', name: 'fetcher', display_name: '抓取', method: 'POST', url: 'https://ex.test/fetch', headers: {}, body: '{"url":"https://example.org"}' };
  const orig = global.fetch;
  const bodies = [];
  global.fetch = async (_url, init) => { bodies.push(init.body); return { status: 200, text: async () => 'ok' }; };
  try {
    await withMocks({ plain: [api] }, async () => {
      const r = await call('tb_call_mcp', { server: '抓取', tool: 'call', arguments: { url: 'https://a.test' } });
      assert.equal(r.isError, false);
      assert.deepEqual(bodies, ['{"url":"https://a.test"}']);
    });
  } finally {
    global.fetch = orig;
  }
});

test('tb_list_models：按类型列；给 preferred 时检查并换成同类能用的', async () => {
  tools.setListModelsImpl(async () => [
    { id: 'deepseek-chat', owned_by: 'x', model_type: 'chat' },
    { id: 'gpt-image-1', owned_by: 'x', model_type: 'image' },
  ]);
  try {
    const list = text(await call('tb_list_models', { type: 'image' }));
    assert.ok(list.includes('gpt-image-1') && !list.includes('deepseek-chat'));
    const hit = JSON.parse(text(await call('tb_list_models', { preferred: 'deepseek-chat' })));
    assert.equal(hit.available, true);
    const alt = JSON.parse(text(await call('tb_list_models', { preferred: 'gpt-image-2' })));
    assert.equal(alt.available, false);
    assert.equal(alt.model, 'gpt-image-1');
  } finally {
    tools.setListModelsImpl(null);
  }
  assert.equal(tools.inferModelTypeFromName('text-embedding-3-small'), 'embedding');
  assert.equal(tools.inferModelTypeFromName('dall-e-3'), 'image');
});

test('不能把任务派给、雇佣自己', async () => {
  const ctx = { selfAgentId: 'external:grok-bot' };
  assert.match(text(await call('tb_dispatch_agent', { agent_id: 'external:grok-bot', prompt: 'x' }, ctx)), /不能把任务派给你自己/);
  assert.match(text(await call('tb_hire_community_agent', { assistant_id: 'external:grok-bot' }, ctx)), /不能雇你自己/);
});

test('改资产的工具只给智能管家；智能管家看的是资产库全表', async () => {
  assert.ok(!tools.listTools({ level: 'full' }).some((t) => t.name === 'tb_save_resource'));
  const refused = await call('tb_save_resource', { id: 'a1', skills: [] });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /只给智能管家/);
  const names = tools.listTools({ level: 'full', guardian: true }).map((t) => t.name);
  assert.ok(names.includes('tb_save_resource') && names.includes('tb_project_resource'));
  await withMocks({}, async () => {
    const ctx = { clientId: tools.GUARDIAN_CLIENT_ID, guardian: true };
    assert.match(text(await call('tb_list_resources', { type: 'assistant' }, ctx)), /writer/);
    const record = JSON.parse(text(await call('tb_get_resource', { type: 'assistant', name: 'writer' }, ctx)));
    assert.equal(record.soul, '你是写作助手');
    assert.deepEqual(record.skills, ['image-gen']);
  });
});

test('派活上下文：调用方给的优先，其次编排时为这个应用记下的任务，最后是应用的工作目录', () => {
  const d = tools.dispatchContext('no-such-app', { parentTaskId: 'p-1', cwd: '/work' });
  assert.equal(d.parentTaskId, 'p-1');
  assert.equal(d.workingDir, '/work');
});

const SLACK = [{ id: 'mcp-slack', name: 'slack', display_name: 'Slack', description: 'Slack 消息', tools: ['slack_post_message', 'slack_add_reaction'], prefix: 'slack' }];
const SLACK_DEFS = {
  slack: [
    { name: 'slack_post_message', description: 'Post a message', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, thread_ts: { type: 'string' } }, required: ['channel', 'text'] } },
    { name: 'slack_add_reaction', description: 'React to a message', inputSchema: { type: 'object', properties: { channel: { type: 'string' }, timestamp: { type: 'string' }, reaction: { type: 'string' } }, required: ['channel', 'timestamp', 'reaction'] } },
  ],
};

test('列出第三方 MCP 时带参数名：模型列出来就直接调，参数名不能让它猜', async () => {
  tools.setRelayedToolDefs(() => SLACK_DEFS);
  try {
    await withMocks({ relayed: SLACK }, async () => {
      const listed = text(await call('tb_list_resources', { type: 'mcp' }));
      assert.match(listed, /slack_post_message\(channel, text, thread_ts\?\)：Post a message/);
      assert.match(listed, /slack_add_reaction\(channel, timestamp, reaction\)/);
      const detail = JSON.parse(text(await call('tb_get_resource', { type: 'mcp', name: 'slack' })));
      assert.deepEqual(detail.tools[0].parameters.required, ['channel', 'text']);
      assert.match(text(await call('tb_capabilities', {})), /slack_post_message\(channel, text, thread_ts\?\)/);
    });
  } finally {
    tools.setRelayedToolDefs(null);
  }
});

test('tb_call_mcp 先按定义检查：参数名不对、工具名不对都不调用，告诉它正确写法；对了才发出去', async () => {
  tools.setRelayedToolDefs(() => SLACK_DEFS);
  const sent = [];
  const ctx = { callRelayed: async (name, args) => { sent.push([name, args]); return { content: [{ type: 'text', text: 'ok' }] }; } };
  try {
    await withMocks({ relayed: SLACK }, async () => {
      const badArgs = await call('tb_call_mcp', { server: 'slack', tool: 'slack_add_reaction', arguments: { channel: 'C1', timestamp: '1.2', emoji: 'tada' } }, ctx);
      assert.equal(badArgs.isError, true);
      assert.match(text(badArgs), /缺少 reaction；没有这些参数：emoji/);
      assert.match(text(badArgs), /slack_add_reaction\(channel, timestamp, reaction\)/);
      const badTool = await call('tb_call_mcp', { server: 'slack', tool: 'post_message', arguments: {} }, ctx);
      assert.match(text(badTool), /没有工具 post_message[\s\S]*slack_post_message\(channel, text, thread_ts\?\)/);
      assert.deepEqual(sent, [], '错的都没发出去');
      const ok = await call('tb_call_mcp', { server: 'slack', tool: 'slack__slack_post_message', arguments: { channel: '#release', text: '0.8.1' } }, ctx);
      assert.equal(ok.isError, false);
      assert.deepEqual(sent, [['slack__slack_post_message', { channel: '#release', text: '0.8.1' }]]);
    });
  } finally {
    tools.setRelayedToolDefs(null);
  }
});

test('拿不到工具定义时照旧调用（只是没法检查）', async () => {
  tools.setRelayedToolDefs(() => ({}));
  try {
    await withMocks({ relayed: SLACK }, async () => {
      const sent = [];
      await call('tb_call_mcp', { server: 'slack', tool: 'slack_post_message', arguments: { channel_id: 'x' } }, { callRelayed: async (n, a) => { sent.push(a); return { content: [] }; } });
      assert.deepEqual(sent, [{ channel_id: 'x' }]);
      assert.match(text(await call('tb_list_resources', { type: 'mcp' })), /\[工具: slack_post_message, slack_add_reaction\]/);
    });
  } finally {
    tools.setRelayedToolDefs(null);
  }
});

test('带关键词没找到时说「没找到相关的」，不说资产库是空的', async () => {
  await withMocks({}, async () => {
    const t = text(await call('tb_list_resources', { query: 'computer' }, { clientId: 'cursor' }));
    assert.match(t, /没有找到和「computer」相关的/);
    assert.doesNotMatch(t, /资产库里还没有/);
  });
});
