'use strict';
// tokenbank-resources: 能力总览 + 已纳管资源 / 社区目录 / 网关发现 / 武将点将
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mcp = require('../resources-mcp');

const SAMPLE = [
  {
    id: 's1', type: 'skill', name: 'image-gen', display_name: 'image-gen',
    description: '图片生成', content: '# image-gen\nuse model',
    projections: [{ agentId: 'cursor' }],
    authorityPath: null,
  },
  {
    id: 'a1', type: 'assistant', name: 'writer', display_name: '写作助手',
    description: '写文章', content: JSON.stringify({
      soul: '你是写作助手', skills: ['image-gen'], prompts: [], mcp: [], model: '',
      runtime_agent: 'claude-code',
    }),
    projections: [{ agentId: 'cursor' }],
  },
  {
    id: 'p1', type: 'prompt', name: 'code-review', display_name: '代码审查',
    description: '审查', content: '请审查 $ARGUMENTS', projections: [],
  },
];

function mockRm() {
  const hits = [];
  return {
    hits,
    listResources(filters = {}) {
      let rows = SAMPLE;
      if (filters.type) rows = rows.filter(r => r.type === filters.type);
      if (filters.query) {
        const q = filters.query.toLowerCase();
        rows = rows.filter(r =>
          r.name.includes(q) || (r.description || '').toLowerCase().includes(q));
      }
      return rows;
    },
    listAssistantsForClient(clientId) {
      return this._listForClient('assistant', clientId);
    },
    listSkillsForClient(clientId) {
      return this._listForClient('skill', clientId);
    },
    listPromptsForClient(clientId) {
      return this._listForClient('prompt', clientId);
    },
    _listForClient(type, clientId) {
      const cid = String(clientId || '').trim();
      const rows = SAMPLE.filter(r => r.type === type);
      const picked = cid
        ? rows.filter(r => (r.projections || []).some(p => p.agentId === cid))
        : rows;
      return picked.map(r => ({
        id: r.id, name: r.name, display_name: r.display_name, description: r.description,
      }));
    },
    isResourceProjectedToClient(id, clientId) {
      const cid = String(clientId || '').trim();
      if (!cid) return true;
      const r = SAMPLE.find(x => x.id === id);
      return !!(r && (r.projections || []).some(p => p.agentId === cid));
    },
    resolveAssistantForClient(ref, clientId) {
      const cid = String(clientId || '').trim();
      const r = SAMPLE.find(x => x.type === 'assistant'
        && (x.name === ref || x.display_name === ref || x.id === ref || `#${x.id}` === ref));
      if (!r) return { found: false };
      if (cid && !(r.projections || []).some(p => p.agentId === cid)) return { found: false };
      return {
        found: true,
        id: r.id,
        name: r.name,
        resource: r,
        text: '你是写作助手\n\n## 可用 Skill\n请在任务中按需遵循以下 Skill：image-gen',
      };
    },
    recordResourceHit(id) { hits.push(id); return true; },
    getResource(id) {
      return SAMPLE.find(r => r.id === id) || null;
    },
    listCatalog(filters = {}) {
      const items = [
        { type: 'skill', name: 'git-commit', display_name: 'Git 提交', description: 'commit', installed: false },
        { type: 'prompt', name: 'api-design', display_name: 'API 设计', description: 'api', installed: true },
      ].filter(it => !filters.type || filters.type === 'all' || it.type === filters.type);
      return { items };
    },
  };
}

test('TOOLS 含能力总览与资源/目录/网关/提示词别名', () => {
  const names = mcp.TOOLS.map(t => t.name).sort();
  assert.deepEqual(names, [
    'tb_call_mcp',
    'tb_capabilities',
    'tb_get_prompt',
    'tb_get_resource',
    'tb_list_catalog',
    'tb_list_gateway',
    'tb_list_prompts',
    'tb_list_resources',
  ]);
});

test('tb_capabilities 描述分域体系与点将工作流', async () => {
  const r = await mcp.handleToolCall('tb_capabilities', {});
  assert.equal(r.isError, false);
  const text = r.content[0].text;
  assert.ok(text.includes('tokenbank-models'));
  assert.ok(text.includes('tb_list_models'));
  assert.ok(text.includes('tb_list_resources'));
  assert.ok(text.includes('推荐工作流'));
  assert.ok(text.includes('assistant') || text.includes('智能体') || text.includes('点将'));
  assert.ok(text.includes('中转 MCP'));
  assert.ok(text.includes('tb_call_mcp'));
});

test('tb_list_resources 可按 type 过滤', async () => {
  mcp.setResourceManager(mockRm());
  try {
    const all = await mcp.handleToolCall('tb_list_resources', {});
    assert.ok(all.content[0].text.includes('image-gen'));
    assert.ok(all.content[0].text.includes('writer'));

    const skills = await mcp.handleToolCall('tb_list_resources', { type: 'skill' });
    assert.ok(skills.content[0].text.includes('image-gen'));
    assert.ok(!skills.content[0].text.includes('[assistant]'));
  } finally {
    mcp.setResourceManager(null);
  }
});

test('tb_list_resources type=assistant 按 TB_CLIENT_ID 投射过滤', async () => {
  const rm = mockRm();
  mcp.setResourceManager(rm);
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'cursor';
    const ok = await mcp.handleToolCall('tb_list_resources', { type: 'assistant' });
    assert.ok(ok.content[0].text.includes('writer'));
    assert.ok(ok.content[0].text.includes('智能体') || ok.content[0].text.includes('writer'));

    process.env.TB_CLIENT_ID = 'codex';
    const empty = await mcp.handleToolCall('tb_list_resources', { type: 'assistant' });
    assert.ok(empty.content[0].text.includes('暂无') || !empty.content[0].text.includes('[assistant] writer'));
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_list_resources type=skill 按 TB_CLIENT_ID 投射过滤', async () => {
  mcp.setResourceManager(mockRm());
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'cursor';
    const ok = await mcp.handleToolCall('tb_list_resources', { type: 'skill' });
    assert.ok(ok.content[0].text.includes('image-gen'));

    process.env.TB_CLIENT_ID = 'codex';
    const empty = await mcp.handleToolCall('tb_list_resources', { type: 'skill' });
    assert.ok(!empty.content[0].text.includes('[skill] image-gen'));
    assert.ok(empty.content[0].text.includes('暂无'));
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_get_resource: skill 投射门控（未投射→isError，已投射→正文）', async () => {
  const rm = mockRm();
  mcp.setResourceManager(rm);
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'codex';
    const denied = await mcp.handleToolCall('tb_get_resource', { type: 'skill', name: 'image-gen' });
    assert.equal(denied.isError, true);
    assert.deepEqual(rm.hits, []);

    process.env.TB_CLIENT_ID = 'cursor';
    const ok = await mcp.handleToolCall('tb_get_resource', { type: 'skill', name: 'image-gen' });
    assert.equal(ok.isError, false);
    assert.ok(ok.content[0].text.includes('use model'));
    assert.deepEqual(rm.hits, ['s1']);
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_get_resource: assistant 返回出战全文并记命中', async () => {
  const rm = mockRm();
  mcp.setResourceManager(rm);
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'cursor';
    const r = await mcp.handleToolCall('tb_get_resource', { type: 'assistant', name: 'writer' });
    assert.equal(r.isError, false);
    const text = r.content[0].text;
    assert.ok(text.includes('dispatch_id: assistant:a1'));
    assert.ok(text.includes('你是写作助手'));
    assert.ok(text.includes('当前会话'));
    assert.ok(!text.trim().startsWith('{'), '默认不应只返回 JSON 摘要');
    assert.deepEqual(rm.hits, ['a1']);
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_get_resource: assistant 未投射 → isError', async () => {
  mcp.setResourceManager(mockRm());
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'codex';
    const r = await mcp.handleToolCall('tb_get_resource', { type: 'assistant', name: 'writer' });
    assert.equal(r.isError, true);
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_get_resource: mode=summary 仍可取摘要', async () => {
  mcp.setResourceManager(mockRm());
  const prev = process.env.TB_CLIENT_ID;
  try {
    process.env.TB_CLIENT_ID = 'cursor';
    const r = await mcp.handleToolCall('tb_get_resource', {
      type: 'assistant', name: 'writer', mode: 'summary',
    });
    assert.equal(r.isError, false);
    const body = JSON.parse(r.content[0].text);
    assert.equal(body.dispatch_id, 'assistant:a1');
  } finally {
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
    mcp.setResourceManager(null);
  }
});

test('tb_list_catalog 区分已纳管/未安装', async () => {
  mcp.setResourceManager(mockRm());
  try {
    const r = await mcp.handleToolCall('tb_list_catalog', { type: 'skill' });
    assert.ok(r.content[0].text.includes('未安装'));
    assert.ok(r.content[0].text.includes('git-commit'));
  } finally {
    mcp.setResourceManager(null);
  }
});

test('tb_list_gateway 含图像与 TTS 端点', async () => {
  const r = await mcp.handleToolCall('tb_list_gateway', {});
  assert.ok(r.content[0].text.includes('/v1/images/generations'));
  assert.ok(r.content[0].text.includes('/v1/audio/speech'));
  assert.ok(r.content[0].text.includes('11430') || r.content[0].text.includes('http'));
});

test('tb_get_prompt 在 resources MCP 上可用（别名，避免 No such tool）', async () => {
  const rm = require('../resource-manager');
  const orig = rm.resolvePromptForClient;
  rm.resolvePromptForClient = (ref, _args, cid) =>
    ref === '小黑' && cid === 'cursor'
      ? { found: true, id: 'p1', name: 'xiaohei', text: '黑猫正文' }
      : { found: false };
  const prev = process.env.TB_CLIENT_ID;
  process.env.TB_CLIENT_ID = 'cursor';
  try {
    const r = await mcp.handleToolCall('tb_get_prompt', { name: '小黑' });
    assert.equal(r.isError, false);
    assert.equal(r.content[0].text, '黑猫正文');
  } finally {
    rm.resolvePromptForClient = orig;
    if (prev == null) delete process.env.TB_CLIENT_ID;
    else process.env.TB_CLIENT_ID = prev;
  }
});

test('initialize 返回 tokenbank-resources', () => {
  const sent = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { sent.push(String(s)); return true; };
  try {
    mcp.handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(JSON.parse(sent[0]).result.serverInfo.name, 'tokenbank-resources');
});

const PIPEWORX = [{
  id: 'mcp-pipeworx',
  name: 'pipeworx',
  display_name: 'Pipeworx',
  description: '实时数据',
  tools: ['ask_pipeworx', 'discover_tools'],
  prefix: 'pipeworx',
}];

test('tb_capabilities 列出当前应用已中转的 MCP', async () => {
  mcp.setRelayedMcpLister(() => PIPEWORX);
  try {
    const r = await mcp.handleToolCall('tb_capabilities', {});
    const text = r.content[0].text;
    assert.ok(text.includes('Pipeworx'));
    assert.ok(text.includes('ask_pipeworx'));
    assert.ok(text.includes('tb_call_mcp'));
  } finally {
    mcp.setRelayedMcpLister(null);
  }
});

test('tb_list_resources type=mcp 列出中转 MCP', async () => {
  mcp.setResourceManager(mockRm());
  mcp.setRelayedMcpLister(() => PIPEWORX);
  try {
    const all = await mcp.handleToolCall('tb_list_resources', {});
    assert.ok(all.content[0].text.includes('[mcp] pipeworx'));
    assert.ok(all.content[0].text.includes('ask_pipeworx'));

    const only = await mcp.handleToolCall('tb_list_resources', { type: 'mcp' });
    assert.ok(only.content[0].text.includes('pipeworx'));
    assert.ok(only.content[0].text.includes('ask_pipeworx'));
    assert.ok(!only.content[0].text.includes('[skill]'));
  } finally {
    mcp.setRelayedMcpLister(null);
    mcp.setResourceManager(null);
  }
});

test('tb_get_resource type=mcp 返回调用方式', async () => {
  mcp.setRelayedMcpLister(() => PIPEWORX);
  try {
    const r = await mcp.handleToolCall('tb_get_resource', { type: 'mcp', name: 'Pipeworx' });
    assert.equal(r.isError, false);
    assert.ok(r.content[0].text.includes('ask_pipeworx'));
    assert.ok(r.content[0].text.includes('tb_call_mcp'));
  } finally {
    mcp.setRelayedMcpLister(null);
  }
});

test('tb_call_mcp 经网关调用中转工具', async () => {
  mcp.setRelayedMcpLister(() => PIPEWORX);
  mcp.setRelayRpc(async (method, params) => {
    assert.equal(method, 'tools/call');
    assert.equal(params.name, 'pipeworx__ask_pipeworx');
    assert.equal(params.arguments.question, 'US unemployment rate last month');
    return { content: [{ type: 'text', text: '4.2%' }] };
  });
  try {
    const r = await mcp.handleToolCall('tb_call_mcp', {
      server: 'Pipeworx',
      tool: 'ask_pipeworx',
      arguments: { question: 'US unemployment rate last month' },
    });
    assert.equal(r.isError, false);
    assert.equal(r.content[0].text, '4.2%');
  } finally {
    mcp.setRelayedMcpLister(null);
    mcp.setRelayRpc(null);
  }
});

const PLAIN = [
  {
    id: 'tool-api-search',
    type: 'api',
    name: 'deepseek-search',
    display_name: 'DeepSeek搜索',
    description: '按 query 搜索网页',
    method: 'POST',
    url: 'https://api.deepseek.com/v1/tools/search',
    headers: { Authorization: 'Bearer sk-test' },
    body: '{"query":""}',
    timeout_ms: 60000,
  },
  {
    id: 'tool-cli-echo',
    type: 'cli',
    name: 'echo-hi',
    display_name: '回声',
    description: '打印一行',
    command: 'echo',
    args: ['hi'],
    cwd: '/tmp',
    env: {},
  },
];

test('tb_list_resources 把 HTTP API 和本地 CLI 暴露给智能体', async () => {
  mcp.setResourceManager(mockRm());
  mcp.setPlainToolLister(() => PLAIN);
  try {
    const all = await mcp.handleToolCall('tb_list_resources', {});
    assert.ok(all.content[0].text.includes('[api] deepseek-search'));
    assert.ok(all.content[0].text.includes('[cli] echo-hi'));
    assert.ok(all.content[0].text.includes('api=1'));

    const apis = await mcp.handleToolCall('tb_list_resources', { type: 'api' });
    assert.ok(apis.content[0].text.includes('DeepSeek搜索'));
    assert.ok(!apis.content[0].text.includes('[cli]'));

    const detail = await mcp.handleToolCall('tb_get_resource', { type: 'api', name: 'DeepSeek搜索' });
    assert.equal(detail.isError, false);
    assert.ok(detail.content[0].text.includes('https://api.deepseek.com/v1/tools/search'));
    assert.ok(detail.content[0].text.includes('Bearer sk-test'));
    assert.ok(detail.content[0].text.includes('tb_call_mcp'));

    const caps = await mcp.handleToolCall('tb_capabilities', {});
    assert.ok(caps.content[0].text.includes('DeepSeek搜索'));
    assert.ok(caps.content[0].text.includes('type=api'));
  } finally {
    mcp.setPlainToolLister(null);
    mcp.setResourceManager(null);
  }
});

test('tb_call_mcp 直接调用已投射的 HTTP API', async () => {
  mcp.setPlainToolLister(() => PLAIN);
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.deepseek.com/v1/tools/search?q=jobs');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer sk-test');
    assert.equal(init.body, '{"query":"jobs"}');
    return { status: 200, text: async () => '{"ok":true}' };
  };
  try {
    const r = await mcp.handleToolCall('tb_call_mcp', {
      server: 'DeepSeek搜索',
      tool: 'call',
      arguments: { query: { q: 'jobs' }, body: { query: 'jobs' } },
    });
    assert.equal(r.isError, false);
    assert.ok(r.content[0].text.includes('HTTP 200'));
    assert.ok(r.content[0].text.includes('"ok":true'));
  } finally {
    global.fetch = orig;
    mcp.setPlainToolLister(null);
  }
});

test('tb_call_mcp 用调用参数覆盖 HTTP 模板，避免每次打到示例地址', async () => {
  const fetchTool = {
    id: 'tool-api-fetch',
    type: 'api',
    name: 'deepseek_fetch',
    display_name: 'DeepSeek抓取',
    description: '抓取网页',
    method: 'POST',
    url: 'https://api.deepseek.com/v1/tools/fetch',
    headers: { Authorization: 'Bearer sk-test' },
    body: '{"url":"https://api-docs.deepseek.com"}',
  };
  mcp.setPlainToolLister(() => [fetchTool]);
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (_url, init) => {
    seen.push(init.body);
    return { status: 200, text: async () => init.body };
  };
  try {
    const first = await mcp.handleToolCall('tb_call_mcp', {
      server: 'deepseek_fetch',
      tool: 'call',
      arguments: { url: 'https://example.com' },
    });
    const second = await mcp.handleToolCall('tb_call_mcp', {
      server: 'deepseek_fetch',
      tool: 'call',
      arguments: { url: 'https://en.wikipedia.org/wiki/URL' },
    });
    assert.equal(first.isError, false);
    assert.equal(seen[0], '{"url":"https://example.com"}');
    assert.equal(seen[1], '{"url":"https://en.wikipedia.org/wiki/URL"}');
    assert.ok(!second.content[0].text.includes('api-docs.deepseek.com'));
  } finally {
    global.fetch = orig;
    mcp.setPlainToolLister(null);
  }
});

test('tb_call_mcp 表单和地址上的示例值也会被调用参数替换', async () => {
  const formTool = {
    id: 'tool-api-form',
    type: 'api',
    name: 'form_fetch',
    display_name: '表单抓取',
    method: 'POST',
    url: 'https://ex.test/fetch',
    headers: {},
    body: 'url=https://api-docs.deepseek.com',
  };
  const queryTool = {
    id: 'tool-api-query',
    type: 'api',
    name: 'query_fetch',
    display_name: '查询抓取',
    method: 'POST',
    url: 'https://ex.test/fetch?url=https://api-docs.deepseek.com',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  };
  const seen = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init.body, type: init.headers['Content-Type'] });
    return { status: 200, text: async () => 'ok' };
  };
  try {
    mcp.setPlainToolLister(() => [formTool]);
    await mcp.handleToolCall('tb_call_mcp', {
      server: 'form_fetch',
      tool: 'call',
      arguments: { url: 'https://example.com' },
    });
    mcp.setPlainToolLister(() => [queryTool]);
    await mcp.handleToolCall('tb_call_mcp', {
      server: 'query_fetch',
      tool: 'call',
      arguments: { url: 'https://example.com' },
    });
    assert.equal(seen[0].body, 'url=https%3A%2F%2Fexample.com');
    assert.equal(seen[0].type, 'application/x-www-form-urlencoded');
    assert.ok(seen[1].url.includes('url=https%3A%2F%2Fexample.com') || seen[1].url.includes('url=https://example.com'));
    assert.ok(!seen[1].url.includes('api-docs.deepseek.com'));
    assert.ok(!String(seen[1].body).includes('api-docs.deepseek.com'));
  } finally {
    global.fetch = orig;
    mcp.setPlainToolLister(null);
  }
});

test('tb_call_mcp 未中转时给出提示', async () => {
  mcp.setRelayedMcpLister(() => PIPEWORX);
  try {
    const r = await mcp.handleToolCall('tb_call_mcp', { server: 'unknown-mcp', tool: 'foo' });
    assert.equal(r.isError, true);
    assert.ok(r.content[0].text.includes('未中转'));
  } finally {
    mcp.setRelayedMcpLister(null);
  }
});

