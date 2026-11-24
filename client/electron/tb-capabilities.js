// Token Bank 能力总览：tb_capabilities 的正文和编排提示里的一小段，共用这一份
'use strict';

/** 网关接口（只用来告诉模型地址，实际调用走 HTTP） */
const GATEWAY_ENDPOINTS = [
  { method: 'GET', path: '/v1/models', note: '模型列表（也可以用 tb_list_models）' },
  { method: 'POST', path: '/v1/chat/completions', note: '聊天，OpenAI 格式' },
  { method: 'POST', path: '/v1/messages', note: '聊天，Anthropic 格式' },
  { method: 'POST', path: '/v1/images/generations', note: '生成图片；model 用 tb_list_models(type=image) 里的' },
  { method: 'POST', path: '/v1/embeddings', note: '向量' },
  { method: 'POST', path: '/v1/audio/speech', note: '语音合成' },
];

function gatewayBaseUrl() {
  if (process.env.TB_GATEWAY_URL) return String(process.env.TB_GATEWAY_URL).replace(/\/$/, '');
  const port = process.env.TB_GATEWAY_PORT || process.env.GATEWAY_PORT || '11430';
  return `http://127.0.0.1:${port}`;
}

/** 总览：你现在能用的工具 + 网关接口 */
function formatCapabilitiesOverview({ tools = [], gatewayUrl = gatewayBaseUrl() } = {}) {
  const lines = ['# Token Bank 能给你什么', '', '## 工具'];
  for (const t of tools) lines.push(`- ${t.name}：${t.description}`);
  if (!tools.length) lines.push('（用户还没给你权限）');
  lines.push('', `## 网关接口（${gatewayUrl}，用你这个应用在 Token Bank 里配好的 Key）`);
  for (const e of GATEWAY_ENDPOINTS) lines.push(`- ${e.method} ${e.path}：${e.note}`);
  return lines.join('\n');
}

/** 接入到这个应用的第三方 MCP（不在你的工具列表里，经 tb_call_mcp 调） */
function formatRelayedMcpSection(servers) {
  const list = Array.isArray(servers) ? servers : [];
  const lines = ['## 第三方 MCP（经 tb_call_mcp 调用）'];
  if (!list.length) {
    lines.push('还没有。用户可以在 Token Bank「资产 → 工具」把 MCP 投射到这个应用。');
    return lines.join('\n');
  }
  for (const s of list) {
    const title = s.display_name && s.display_name !== s.name ? `${s.display_name}（${s.name}）` : (s.display_name || s.name || s.id);
    const tools = (s.tools || []).filter(Boolean);
    lines.push(`- ${title}${s.description ? `：${s.description}` : ''}`);
    lines.push(`  工具：${tools.length ? tools.join(', ') : '用 tb_get_resource(type=mcp) 查'}`);
    lines.push(`  例：tb_call_mcp(server="${s.name || s.id}", tool="${tools[0] || '<工具名>'}", arguments={...})`);
  }
  return lines.join('\n');
}

/** 用户登记的 HTTP API / 本地命令 */
function formatConfiguredToolsSection(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const lines = ['## HTTP API 和本地命令（经 tb_call_mcp 调用，tool 填 call）'];
  if (!list.length) {
    lines.push('还没有。');
    return lines.join('\n');
  }
  for (const s of list) {
    const title = s.display_name && s.display_name !== s.name ? `${s.display_name}（${s.name}）` : (s.display_name || s.name || s.id);
    const how = s.type === 'api' ? `${s.method || 'POST'} ${s.url || ''}` : [s.command, ...(s.args || [])].filter(Boolean).join(' ');
    lines.push(`- ${title} [${s.type === 'api' ? 'API' : '命令'}] ${how}${s.description ? `：${s.description}` : ''}`);
  }
  lines.push('详情用 tb_get_resource(type=api|cli, name=...)；arguments 里的字段会覆盖请求体模板里的同名字段。');
  return lines.join('\n');
}

/** 编排说明里的一段 */
function formatOrchestratorCapabilityHint() {
  return '- 其它：不确定能做什么先 tb_capabilities；要用模型 tb_list_models；资产（智能体、技能、提示词、MCP、API、命令）用 tb_list_resources / tb_get_resource，第三方 MCP 用 tb_call_mcp。';
}

module.exports = {
  GATEWAY_ENDPOINTS,
  gatewayBaseUrl,
  formatCapabilitiesOverview,
  formatRelayedMcpSection,
  formatConfiguredToolsSection,
  formatOrchestratorCapabilityHint,
};
