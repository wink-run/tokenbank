// Token Bank 能力体系（供 MCP 总览与编排提示共用）
// 分域暴露：编排 / 提示词 / 模型 / 资源发现，各有同步策略，勿合并成单一巨型 MCP
'use strict';

/** 能力域与工具对照（体系入口） */
const CAPABILITY_DOMAINS = [
  {
    id: 'overview',
    mcp: 'tokenbank-resources',
    title: '能力总览与资源发现（含智能体点将）',
    tools: ['tb_capabilities', 'tb_list_resources', 'tb_get_resource', 'tb_get_prompt', 'tb_list_prompts', 'tb_list_catalog', 'tb_list_gateway', 'tb_call_mcp'],
    when: '不确定能力时先 tb_capabilities；智能体：tb_list_resources(type=assistant)→tb_get_resource 取正文后在当前会话执行；提示词优先本 MCP 的 tb_get_prompt；skill 为兵器；MCP 为资源：tb_list_resources(type=mcp)→tb_get_resource→tb_call_mcp；社区目录用 tb_list_catalog',
  },
  {
    id: 'models',
    mcp: 'tokenbank-models',
    title: '模型资源',
    tools: ['tb_list_models', 'tb_resolve_model'],
    when: '调聊天/图像/embedding 前确认可用模型；skill 硬编码模型不存在时用 tb_resolve_model 切换',
  },
  {
    id: 'prompts',
    mcp: 'tokenbank-prompts',
    title: '提示词（专用 MCP，与 resources 同名工具等价）',
    tools: ['tb_list_prompts', 'tb_get_prompt'],
    when: '用户提到「用某某提示词」时 list/get；亦可在 tokenbank-resources 上调同名工具',
  },
  {
    id: 'dispatch',
    mcp: 'tokenbank-agent-bridge',
    title: 'Agent 派发（仅编排/游乐场）',
    tools: ['tb_list_agents', 'tb_dispatch_agent', 'tb_list_community_agents', 'tb_hire_community_agent'],
    when: '仅 Token Bank 编排：tb_list_agents 返回本地智能体、已雇佣社区智能体和本机 CLI；tb_list_community_agents 只返回已雇佣的 community:*。用 tb_dispatch_agent 派发。新雇佣在「交易」页操作；日常直连会话请用点将，勿默认派发',
  },
];

/** 本地网关能力面（只读发现，实际调用走 HTTP） */
const GATEWAY_ENDPOINTS = [
  { method: 'GET', path: '/v1/models', capability: 'models', note: '列出可用模型；亦可用 tb_list_models' },
  { method: 'POST', path: '/v1/chat/completions', capability: 'chat', note: 'OpenAI 兼容聊天' },
  { method: 'POST', path: '/v1/messages', capability: 'chat', note: 'Anthropic Messages' },
  { method: 'POST', path: '/v1/images/generations', capability: 'image', note: '文生图；model 须在 tb_list_models(type=image) 中' },
  { method: 'POST', path: '/v1/embeddings', capability: 'embedding', note: '向量嵌入' },
  { method: 'POST', path: '/v1/audio/speech', capability: 'tts', note: '语音合成 TTS' },
  { method: 'GET', path: '/health', capability: 'health', note: '网关健康检查' },
];

function gatewayBaseUrl() {
  if (process.env.TB_GATEWAY_URL) {
    return String(process.env.TB_GATEWAY_URL).replace(/\/$/, '');
  }
  const port = process.env.TB_GATEWAY_PORT || process.env.GATEWAY_PORT || '11430';
  return `http://127.0.0.1:${port}`;
}

/** 生成给 Agent 阅读的能力总览正文 */
function formatCapabilitiesOverview() {
  const base = gatewayBaseUrl();
  const lines = [
    '# Token Bank 能力体系',
    '',
    '本软件通过内置 MCP 暴露资源与能力。不确定时先读本总览，再按域调用对应工具。',
    '',
    '## 能力域',
    '',
  ];
  for (const d of CAPABILITY_DOMAINS) {
    lines.push(`### ${d.title}（MCP: ${d.mcp}）`);
    lines.push(`- 工具: ${d.tools.join(', ')}`);
    lines.push(`- 何时用: ${d.when}`);
    lines.push('');
  }
  lines.push('## 推荐工作流');
  lines.push('1. tb_capabilities → 了解全貌');
  lines.push('2. 任务需模型 → tb_list_models / tb_resolve_model（勿假设 skill 里的模型名一定存在）');
  lines.push('3. 点将（日常直连会话）→ tb_list_resources(type=agent) → tb_get_resource(type=agent) 取全文 → 当前会话按正文执行');
  lines.push('4. 兵器：skill → tb_list_resources/tb_get_resource；提示词 → tb_get_prompt / tb_list_prompts；MCP → tb_list_resources(type=mcp) / tb_get_resource(type=mcp) / tb_call_mcp；HTTP API / 本地 CLI → tb_list_resources(type=api|cli) / tb_get_resource');
  lines.push('5. 社区未安装项 → tb_list_catalog（安装/启用请用户在 Token Bank UI 操作）');
  lines.push('6. 仅编排/游乐场才派发 → tb_list_agents / tb_dispatch_agent');
  lines.push('7. 直连网关 API → tb_list_gateway 查路径，base = ' + base);
  lines.push('8. 用户点名 Pipeworx 等 MCP 时：tb_list_resources(type=mcp) 确认 → tb_call_mcp 调用（不在本机工具列表里找原始名）');
  lines.push('');
  lines.push('## 原则');
  lines.push('- 智能体：点将=取正文同会话执行；智能体不能自己冲锋');
  lines.push('- 只读发现优先；安装/投射/改配置留给 Token Bank 客户端 UI');
  lines.push('- skill 硬编码模型失败时，用 tb_resolve_model 切换到网关实际可用模型');
  lines.push('- 禁止臆造 prompt/skill/agent 正文；以 MCP 取回内容为准');
  lines.push('- 用户点名已中转 MCP（如 Using Pipeworx…）时必须 tb_call_mcp，勿在本机工具列表里找原始名');
  return lines.join('\n');
}

/** 中转 MCP 段落（由 resources-mcp 按当前 TB_CLIENT_ID 注入） */
function formatRelayedMcpSection(servers) {
  const lines = [
    '## 中转 MCP（第三方，经 Token Bank 网关）',
    '',
    '这些服务未写进本 Agent 的 mcp.json，因此不会出现在标准工具列表里。',
    '发现：tb_list_resources(type=mcp)；详情：tb_get_resource(type=mcp)；调用：tb_call_mcp(server, tool, arguments)。例如用户问「Using Pipeworx, what was the US unemployment rate last month?」→ tb_call_mcp(server="pipeworx", tool="ask_pipeworx", arguments={question:...})。',
    '',
  ];
  const list = Array.isArray(servers) ? servers : [];
  if (!list.length) {
    lines.push('当前应用暂无已中转的第三方 MCP。请用户在 Token Bank「资产 → MCP 工具」把该 MCP 投射到此应用。');
    return lines.join('\n');
  }
  for (const s of list) {
    const title = s.display_name && s.display_name !== s.name
      ? `${s.display_name}（${s.name}）`
      : (s.display_name || s.name || s.id);
    lines.push(`### ${title}`);
    if (s.description) lines.push(`- 说明: ${s.description}`);
    const tools = (s.tools || []).filter(Boolean);
    lines.push(`- 工具: ${tools.length ? tools.join(', ') : '(以 tb_list_resources(type=mcp) 为准)'}`);
    const example = tools[0] || 'tool_name';
    lines.push(`- 调用: tb_call_mcp(server="${s.name || s.id}", tool="${example}", arguments={...})`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 用户在「资产 → 工具」登记的 HTTP API / 本地 CLI（不是 MCP） */
function formatConfiguredToolsSection(tools) {
  const lines = [
    '## 已配置的 HTTP API 与本地 CLI',
    '',
    '这些工具写在 Token Bank「资产 → 工具」里，投射方式与 MCP 相同。',
    '下面只列出已投射到当前应用的。调用：tb_call_mcp(server=名称, tool="call", arguments={字段:实际值})。传入的字段会覆盖请求体模板。',
    '',
  ];
  const list = Array.isArray(tools) ? tools : [];
  if (!list.length) {
    lines.push('当前没有已启用的 HTTP API 或本地 CLI。');
    return lines.join('\n');
  }
  for (const s of list) {
    const title = s.display_name && s.display_name !== s.name
      ? `${s.display_name}（${s.name}）`
      : (s.display_name || s.name || s.id);
    lines.push(`### ${title} [${s.type}]`);
    if (s.description) lines.push(`- 说明: ${s.description}`);
    if (s.type === 'api') lines.push(`- 请求: ${s.method || 'POST'} ${s.url || ''}`);
    else lines.push(`- 命令: ${[s.command, ...(s.args || [])].filter(Boolean).join(' ')}`);
    lines.push(`- 详情: tb_get_resource(type="${s.type}", name="${s.name || s.id}")`);
    lines.push('');
  }
  return lines.join('\n');
}

/** 编排层系统提示中的精简能力指引 */
function formatOrchestratorCapabilityHint() {
  return [
    '- 不确定本软件能力时先 tb_capabilities；模型用 tb_list_models / tb_resolve_model；',
    '  点将：tb_list_resources(type=agent)→tb_get_resource；提示词用 tb_list_prompts / tb_get_prompt；',
    '  MCP 是资源：tb_list_resources(type=mcp) / tb_call_mcp；HTTP API 与本地 CLI 用 tb_list_resources(type=api|cli)；编排派发才用 tb_dispatch_agent。',
  ].join('\n');
}

module.exports = {
  CAPABILITY_DOMAINS,
  GATEWAY_ENDPOINTS,
  gatewayBaseUrl,
  formatCapabilitiesOverview,
  formatRelayedMcpSection,
  formatConfiguredToolsSection,
  formatOrchestratorCapabilityHint,
};
