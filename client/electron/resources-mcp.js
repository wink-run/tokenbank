#!/usr/bin/env node
// Token Bank 资源发现 MCP（stdio）
// 常驻同步：能力总览、已纳管资源、社区目录、网关 API——把本软件能力体系暴露给 Agent
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  CAPABILITY_DOMAINS,
  GATEWAY_ENDPOINTS,
  gatewayBaseUrl,
  formatCapabilitiesOverview,
  formatRelayedMcpSection,
  formatConfiguredToolsSection,
} = require('./tb-capabilities');
const { resolveAuthorityDir } = require('./resource-canonical');
const { parseAssistantConfig } = require('./resource-assistant');

function clientId() {
  return process.env.TB_CLIENT_ID || process.env.TB_MAIN_AGENT_ID || '';
}

const TOOLS = [
  {
    name: 'tb_capabilities',
    description:
      'Token Bank 能力体系总览：有哪些内置 MCP、工具、推荐工作流，以及当前应用已中转的第三方 MCP（如 Pipeworx）。'
      + '不确定能做什么、该用哪个工具时，先调本工具。MCP 是资源：tb_list_resources(type=mcp) 列出，tb_call_mcp 调用。'
      + '用户配置的 HTTP API / 本地 CLI：tb_list_resources(type=api|cli)，tb_get_resource 看用法。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_list_resources',
    description:
      '列出 Token Bank 已纳管的资源。assistant=可点智能体（仅投射给当前 Agent 的可见）；'
      + 'skill/prompt=兵器；mcp=已中转到当前 Agent 的第三方 MCP（如 Pipeworx）；'
      + 'api/cli=用户在「资产 → 工具」登记的 HTTP API 与本地命令。'
      + '点将前用 type=assistant；取 MCP 详情用 tb_get_resource(type=mcp)，调用用 tb_call_mcp。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '资源类型：skill | assistant | prompt | mcp | api | cli | all（默认 all）',
          enum: ['skill', 'assistant', 'prompt', 'mcp', 'api', 'cli', 'all'],
        },
        query: {
          type: 'string',
          description: '可选关键词，匹配名称/显示名/描述',
        },
      },
    },
  },
  {
    name: 'tb_get_resource',
    description:
      '取回资源详情。type=assistant 时为点将：返回该智能体出战全文（soul+绑定兵器），'
      + '请在当前会话按正文执行；仅编排场景才用 tb_dispatch_agent。'
      +       'skill 返回正文；prompt 返回全文（投射门控，等同 tb_get_prompt）；'
      + 'mcp 返回已中转 MCP 的工具列表与调用方式；'
      + 'api/cli 返回用户配置的请求或命令，按详情直接使用。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '资源类型：skill | assistant | prompt | mcp | api | cli（按名查找时建议提供）',
          enum: ['skill', 'assistant', 'prompt', 'mcp', 'api', 'cli'],
        },
        name: {
          type: 'string',
          description: '资源 name / 显示名，或 #<id>',
        },
        mode: {
          type: 'string',
          description: 'assistant 专用：activate=出战全文（默认）| summary=轻量摘要',
          enum: ['activate', 'summary'],
        },
      },
      required: ['name'],
    },
  },
  {
    // 与 tokenbank-prompts 同名别名：模型常误在本 MCP 上调 tb_get_prompt，直接可用可避免 No such tool
    name: 'tb_get_prompt',
    description:
      '按名称或显示名取回已投射提示词正文（支持 $ARGUMENTS）。'
      + '用户说「用某某提示词」时用本工具；也可用 tokenbank-prompts 同名工具。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '提示词 name / 显示名，或 #<id>' },
        args: { type: 'string', description: '可选参数，填充模板里的 $ARGUMENTS' },
      },
      required: ['name'],
    },
  },
  {
    name: 'tb_list_prompts',
    description: '列出当前 Agent 已投射的提示词（name/显示名/描述）。取正文前可先 list。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_list_catalog',
    description:
      '列出社区/内置推荐目录中的资源（未必已纳管）。'
      + '发现未安装项后，请提示用户在 Token Bank 客户端安装，本工具不执行安装。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '目录类型：skill | assistant | prompt | all',
          enum: ['skill', 'assistant', 'prompt', 'all'],
        },
        query: { type: 'string', description: '可选关键词' },
      },
    },
  },
  {
    name: 'tb_list_gateway',
    description:
      '列出 Token Bank 本地网关可调用的 HTTP API（chat / image / embedding / tts 等）。'
      + '模型列表请用 tb_list_models；此处只说明端点与用途。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tb_call_mcp',
    description:
      '调用当前 Agent 已中转的第三方 MCP 工具。先 tb_list_resources(type=mcp) 或 tb_get_resource(type=mcp) 确认。'
      + '用户说 Using Pipeworx / 用某某 MCP 时用本工具。server 填 MCP 名（pipeworx），tool 填原始工具名（ask_pipeworx）。',
    inputSchema: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: 'MCP 名称 / 显示名 / id，如 pipeworx、Pipeworx、mcp-pipeworx',
        },
        tool: {
          type: 'string',
          description: '该 MCP 的原始工具名，如 ask_pipeworx；或网关前缀名 pipeworx__ask_pipeworx',
        },
        arguments: {
          type: 'object',
          description: '传给该工具的参数对象',
        },
        args: {
          type: 'object',
          description: 'arguments 的别名',
        },
      },
      required: ['server', 'tool'],
    },
  },
];

/** 可注入：单测 mock resource-manager */
let _resourceManager = null;
/** 可注入：单测 mock 中转 MCP 列表 */
let _relayedMcpLister = null;
/** 可注入：单测 mock 已配置的 API / CLI */
let _plainToolLister = null;
/** 可注入：单测 mock 网关 JSON-RPC */
let _relayRpc = null;

function setResourceManager(rm) {
  _resourceManager = rm || null;
}

function setRelayedMcpLister(fn) {
  _relayedMcpLister = typeof fn === 'function' ? fn : null;
}

function setPlainToolLister(fn) {
  _plainToolLister = typeof fn === 'function' ? fn : null;
}

function setRelayRpc(fn) {
  _relayRpc = typeof fn === 'function' ? fn : null;
}

function getResourceManager() {
  if (_resourceManager) return _resourceManager;
  return require('./resource-manager');
}

function listRelayedMcpsSafe() {
  try {
    if (_relayedMcpLister) return _relayedMcpLister(clientId()) || [];
    return require('./mcp-manager').listRelayedMcpsForClient(clientId()) || [];
  } catch {
    return [];
  }
}

function listPlainToolsSafe() {
  try {
    const cid = clientId();
    if (_plainToolLister) return _plainToolLister(cid) || [];
    return require('./mcp-manager').listConfiguredPlainTools(cid) || [];
  } catch {
    return [];
  }
}

function plainToolRows(type) {
  return listPlainToolsSafe().filter((s) => !type || s.type === type).map((s) => ({ ...s, type: s.type }));
}

function resolvePlainTool(ref, type) {
  const raw = String(ref || '').trim().toLowerCase();
  if (!raw) return null;
  return plainToolRows(type).find((s) => s.id?.toLowerCase() === raw
    || s.name?.toLowerCase() === raw
    || String(s.display_name || '').toLowerCase() === raw) || null;
}

function mcpResourceRows() {
  return listRelayedMcpsSafe().map((s) => ({
    type: 'mcp',
    id: s.id,
    name: s.name,
    display_name: s.display_name,
    description: s.description,
    tools: s.tools,
    prefix: s.prefix,
  }));
}

function resolveRelayedMcpSafe(ref) {
  try {
    if (_relayedMcpLister) {
      const raw = String(ref || '').trim().toLowerCase();
      const list = _relayedMcpLister(clientId()) || [];
      return list.find((s) => s.id?.toLowerCase() === raw
        || s.name?.toLowerCase() === raw
        || String(s.display_name || '').toLowerCase() === raw
        || s.prefix?.toLowerCase() === raw) || null;
    }
    return require('./mcp-manager').resolveRelayedMcpForClient(clientId(), ref);
  } catch {
    return null;
  }
}

function relayGatewayTarget(cid) {
  const { getGatewayEndpoint } = require('./mcp-gateway-server');
  const ep = getGatewayEndpoint();
  if (!ep?.url || !ep?.token) return null;
  const base = String(ep.url).replace(/\/mcp\/?$/, '');
  const path = cid ? `/mcp/${cid}` : '/mcp';
  return { url: `${base}${path}`, token: ep.token };
}

async function relayRpc(method, params) {
  if (_relayRpc) return _relayRpc(method, params, clientId());
  const cid = clientId();
  const gw = relayGatewayTarget(cid);
  if (!gw) throw new Error('内置中转尚未就绪，请确认 Token Bank 正在运行');
  const res = await fetch(gw.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${gw.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`中转 HTTP ${res.status}: ${text.slice(0, 240)}`);
  let msg;
  try { msg = JSON.parse(text); } catch {
    throw new Error(`中转响应无法解析: ${text.slice(0, 240)}`);
  }
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  return msg.result;
}

function asToolResult(raw) {
  if (raw && Array.isArray(raw.content)) {
    return { ...raw, isError: !!raw.isError };
  }
  if (typeof raw === 'string') return textResult(raw);
  if (raw == null) return textResult('(无返回)');
  return textResult(typeof raw === 'object' ? JSON.stringify(raw, null, 2) : String(raw));
}

function parseToolArgs(args) {
  const raw = args?.arguments !== undefined ? args.arguments : args?.args;
  if (raw == null) return {};
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return { input: raw }; }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  return {};
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function textResult(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    isError: !!isError,
  };
}

function readSkillBody(resource) {
  try {
    const dir = resolveAuthorityDir(resource);
    if (dir) {
      const skillMd = path.join(dir, 'SKILL.md');
      if (fs.existsSync(skillMd)) return fs.readFileSync(skillMd, 'utf8');
    }
  } catch { /* ignore */ }
  return String(resource.content || '');
}

function findManagedResource(rm, type, ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  if (raw.startsWith('#')) {
    const byId = rm.getResource(raw.slice(1).trim());
    if (byId && (!type || byId.type === type)) return byId;
    return null;
  }
  const matchName = (r) => r.name === raw || r.id === raw
    || (r.display_name && r.display_name === raw);
  if (type) {
    const list = rm.listResources({ type });
    const hit = list.find(matchName);
    if (hit) return hit;
  }
  // 未指定 type：按 id 再按各类型名/显示名尝试
  const byId = rm.getResource(raw);
  if (byId) return byId;
  for (const t of ['skill', 'assistant', 'prompt']) {
    const list = rm.listResources({ type: t });
    const hit = list.find(matchName);
    if (hit) return hit;
  }
  if (!type || type === 'mcp') {
    const mcp = resolveRelayedMcpSafe(raw);
    if (mcp) return { ...mcp, type: 'mcp' };
  }
  if (!type || type === 'api' || type === 'cli') {
    const tool = resolvePlainTool(raw, type && type !== 'all' ? type : '');
    if (tool) return tool;
  }
  return null;
}

function formatResourceLine(r) {
  const disp = r.display_name && r.display_name !== r.name ? ` (${r.display_name})` : '';
  const desc = r.description ? `: ${String(r.description).slice(0, 120)}` : '';
  const proj = Array.isArray(r.projections) && r.projections.length
    ? ` [投射→${r.projections.map(p => p.agentId || p.agent_id).filter(Boolean).join(',')}]`
    : '';
  const tools = r.type === 'mcp' && Array.isArray(r.tools) && r.tools.length
    ? ` [tools: ${r.tools.join(', ')}]`
    : '';
  const access = r.type === 'api'
    ? ` ${r.method || 'POST'} ${r.url || ''}`.trimEnd()
    : r.type === 'cli'
      ? ` ${[r.command, ...(r.args || [])].filter(Boolean).join(' ')}`.trimEnd()
      : '';
  return `- [${r.type}] ${r.name}${disp}${desc}${access ? ` ${access}` : ''}${proj}${tools}`;
}

function formatResourceDetail(r) {
  if (r.type === 'skill') {
    const body = readSkillBody(r);
    return [
      `# Skill: ${r.name}`,
      r.description ? `描述: ${r.description}` : '',
      r.authorityPath ? `路径: ${r.authorityPath}` : '',
      '',
      body || '(无正文)',
    ].filter(Boolean).join('\n');
  }
  if (r.type === 'assistant') {
    const cfg = parseAssistantConfig(r.content);
    return JSON.stringify({
      type: 'assistant',
      id: r.id,
      name: r.name,
      display_name: r.display_name,
      description: r.description,
      dispatch_id: `assistant:${r.id}`,
      soul_preview: String(cfg.soul || '').slice(0, 400),
      skills: cfg.skills,
      prompts: cfg.prompts,
      mcp: cfg.mcp,
      model: cfg.model || null,
      runtime_agent: cfg.runtime_agent,
      hint: '点将请用 mode=activate（默认）取全文并在当前会话执行；仅编排才 tb_dispatch_agent',
    }, null, 2);
  }
  if (r.type === 'mcp') {
    const tools = (r.tools || []).filter(Boolean);
    const example = tools[0] || 'tool_name';
    return JSON.stringify({
      type: 'mcp',
      id: r.id,
      name: r.name,
      display_name: r.display_name,
      description: r.description,
      tools,
      prefix: r.prefix,
      hint: `经 Token Bank 中转；调用 tb_call_mcp(server="${r.name}", tool="${example}", arguments={...})`,
    }, null, 2);
  }
  if (r.type === 'api') {
    return JSON.stringify({
      type: 'api',
      id: r.id,
      name: r.name,
      display_name: r.display_name,
      description: r.description,
      method: r.method || 'POST',
      url: r.url || '',
      headers: r.headers || {},
      body: r.body || '',
      timeout_ms: r.timeout_ms || null,
      hint: '已投射到当前应用。tb_call_mcp(server="' + r.name + '", tool="call", arguments={字段:实际值})。arguments 里的字段会覆盖请求体模板，例如抓取时传 url，不要沿用模板里的示例地址。',
    }, null, 2);
  }
  if (r.type === 'cli') {
    return JSON.stringify({
      type: 'cli',
      id: r.id,
      name: r.name,
      display_name: r.display_name,
      description: r.description,
      command: r.command || '',
      args: r.args || [],
      cwd: r.cwd || '',
      env: r.env || {},
      hint: '已投射到当前应用。调用 tb_call_mcp(server="' + r.name + '", tool="call", arguments={...})。命令以已保存的配置为准。',
    }, null, 2);
  }
  // prompt 元数据（全文由 handleToolCall 走 resolvePromptForClient）
  return JSON.stringify({
    type: 'prompt',
    id: r.id,
    name: r.name,
    display_name: r.display_name,
    description: r.description,
    hint: '取正文请用 tb_get_prompt，或 tb_get_resource(type=prompt)',
  }, null, 2);
}

async function handleToolCall(name, args = {}) {
  if (name === 'tb_capabilities') {
    const domainLines = CAPABILITY_DOMAINS.map(
      d => `- ${d.id}: ${d.mcp} → ${d.tools.join(', ')}`,
    ).join('\n');
    const relayed = listRelayedMcpsSafe();
    const plain = listPlainToolsSafe();
    return textResult(
      `${formatCapabilitiesOverview()}\n\n${formatRelayedMcpSection(relayed)}\n\n${formatConfiguredToolsSection(plain)}\n\n## 域速查\n${domainLines}`,
    );
  }

  if (name === 'tb_list_gateway') {
    const base = gatewayBaseUrl();
    const lines = GATEWAY_ENDPOINTS.map(
      e => `- ${e.method} ${base}${e.path}  [${e.capability}] ${e.note}`,
    );
    return textResult(
      `网关 base: ${base}\n模型请用 tb_list_models；鉴权用本机 Agent/应用已配置的 API Key。\n${lines.join('\n')}`,
    );
  }

  if (name === 'tb_call_mcp') {
    const serverRef = String(args.server || args.mcp || '').trim();
    const tool = String(args.tool || args.name || '').trim();
    if (!serverRef || !tool) {
      return textResult('请提供 server（MCP 名，如 pipeworx）和 tool（如 ask_pipeworx）', true);
    }
    const plain = resolvePlainTool(serverRef);
    if (plain) {
      try {
        const { callPlainTool } = require('./plain-tool-call');
        const text = await callPlainTool(plain, parseToolArgs(args));
        return textResult(String(text));
      } catch (e) {
        return textResult(`调用 ${plain.display_name || plain.name} 失败: ${e.message}`, true);
      }
    }
    const hit = resolveRelayedMcpSafe(serverRef);
    if (!hit) {
      const names = listRelayedMcpsSafe().map((s) => s.display_name || s.name).join('、') || '无';
      return textResult(
        `当前应用未中转 MCP: ${serverRef}。已中转: ${names}。请用户到 Token Bank「资产 → MCP 工具」把它投射到此应用，或先 tb_list_resources(type=mcp)。`,
        true,
      );
    }
    const prefixed = tool.includes('__') ? tool : `${hit.prefix}__${tool}`;
    try {
      const result = await relayRpc('tools/call', {
        name: prefixed,
        arguments: parseToolArgs(args),
      });
      return asToolResult(result);
    } catch (e) {
      return textResult(`调用中转 MCP ${hit.display_name || hit.name}.${tool} 失败: ${e.message}`, true);
    }
  }

  const rm = getResourceManager();
  const cid = clientId();

  // 提示词：与 tokenbank-prompts 同实现，避免模型误挂在本 MCP 上 No such tool
  if (name === 'tb_get_prompt' || name === 'tb_list_prompts') {
    const promptMcp = require('./prompt-mcp');
    return promptMcp.handleToolCall(name, args);
  }

  if (name === 'tb_list_resources') {
    try {
      const type = String(args.type || 'all').toLowerCase();
      const query = String(args.query || '').trim().toLowerCase();
      let rows = [];

      // 投射门控资源 + 当前应用已中转的 MCP
      if (type === 'assistant') {
        rows = (rm.listAssistantsForClient(cid) || []).map((r) => ({ ...r, type: 'assistant' }));
      } else if (type === 'skill') {
        rows = (rm.listSkillsForClient(cid) || []).map((r) => ({ ...r, type: 'skill' }));
      } else if (type === 'prompt') {
        rows = (rm.listPromptsForClient(cid) || []).map((r) => ({ ...r, type: 'prompt' }));
      } else if (type === 'mcp') {
        rows = mcpResourceRows();
      } else if (type === 'api' || type === 'cli') {
        rows = plainToolRows(type);
      } else {
        const skills = (rm.listSkillsForClient(cid) || []).map((r) => ({ ...r, type: 'skill' }));
        const prompts = (rm.listPromptsForClient(cid) || []).map((r) => ({ ...r, type: 'prompt' }));
        const assistants = (rm.listAssistantsForClient(cid) || []).map((r) => ({ ...r, type: 'assistant' }));
        rows = [...assistants, ...skills, ...prompts, ...mcpResourceRows(), ...plainToolRows()];
      }

      if (query) {
        rows = rows.filter((r) => {
          const blob = `${r.name || ''} ${r.display_name || ''} ${r.description || ''} ${(r.tools || []).join(' ')}`.toLowerCase();
          return blob.includes(query);
        });
      }

      if (!rows.length) {
        if (type === 'mcp') {
          return textResult(
            '（当前 Agent 暂无已中转的 MCP。用户点名 Pipeworx 等服务时，请提示用户到 Token Bank「资产 → MCP 工具」把该 MCP 投射到此应用。）',
          );
        }
        if (type === 'api' || type === 'cli') {
          const label = type === 'api' ? 'HTTP API' : '本地 CLI';
          return textResult(`（当前应用没有已投射的${label}。请用户到 Token Bank「资产 → 工具」把它投射到此应用。）`);
        }
        const label = type === 'assistant' ? '智能体' : (type !== 'all' ? type : '资源');
        return textResult(
          `（当前 Agent 暂无已投射的${label}；请先在 Token Bank 投射/启用到本 Agent，或用 tb_list_catalog 查看社区目录）`,
        );
      }
      const counts = { skill: 0, assistant: 0, prompt: 0, mcp: 0, api: 0, cli: 0 };
      for (const r of rows) {
        if (counts[r.type] != null) counts[r.type] += 1;
      }
      const summary = type === 'assistant'
        ? `可点智能体 ${rows.length} 个（已投射给当前 Agent）`
        : type === 'mcp'
          ? `已中转 MCP ${rows.length} 个（当前 Agent 可用；调用用 tb_call_mcp）`
          : type === 'api'
            ? `已投射 HTTP API ${rows.length} 个（tb_call_mcp(server=名称, tool="call")）`
            : type === 'cli'
              ? `已投射本地 CLI ${rows.length} 个（tb_call_mcp(server=名称, tool="call")）`
              : `已纳管 ${rows.length} 项：skill=${counts.skill} assistant=${counts.assistant} prompt=${counts.prompt} mcp=${counts.mcp} api=${counts.api} cli=${counts.cli}`;
      const lines = rows.map(formatResourceLine);
      return textResult(`${summary}\n${lines.join('\n')}`);
    } catch (e) {
      return textResult(`列出资源失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_get_resource') {
    const ref = String(args.name || args.ref || '').trim();
    if (!ref) return textResult('缺少 name', true);
    const type = args.type ? String(args.type).toLowerCase() : '';
    const mode = String(args.mode || 'activate').toLowerCase();
    try {
      if (type === 'mcp') {
        const hit = resolveRelayedMcpSafe(ref);
        if (!hit) {
          return textResult(
            `未找到或未中转给当前 Agent 的 MCP: ${ref}。可先 tb_list_resources(type=mcp)。`,
            true,
          );
        }
        return textResult(formatResourceDetail({ ...hit, type: 'mcp' }));
      }
      if (type === 'api' || type === 'cli') {
        const hit = resolvePlainTool(ref, type);
        if (!hit) {
          const label = type === 'api' ? 'HTTP API' : '本地 CLI';
          return textResult(
            `未找到或未投射给当前应用的${label}: ${ref}。可先 tb_list_resources(type=${type})。`,
            true,
          );
        }
        return textResult(formatResourceDetail(hit));
      }
      // 显式点将，或命中 assistant 资源时走投射门控 + 出战全文
      if (type === 'assistant' && typeof rm.resolveAssistantForClient === 'function') {
        const resolved = rm.resolveAssistantForClient(ref, cid);
        if (!resolved.found) {
          return textResult(
            `未找到或未投射给当前 Agent 的智能体: ${ref}。可先 tb_list_resources(type=assistant)。`,
            true,
          );
        }
        if (mode === 'summary' && resolved.resource) {
          return textResult(formatResourceDetail(resolved.resource));
        }
        try { rm.recordResourceHit?.(resolved.id, cid); } catch { /* ignore */ }
        const title = resolved.resource?.display_name || resolved.name;
        return textResult([
          `dispatch_id: assistant:${resolved.id}`,
          `# 智能体出战：${title}`,
          '（请在当前会话按下列正文执行；仅编排/游乐场才使用 tb_dispatch_agent）',
          '',
          resolved.text || '(无出战正文)',
        ].join('\n'));
      }

      // 显式取提示词全文（name / 显示名均可）
      if (type === 'prompt' && typeof rm.resolvePromptForClient === 'function') {
        const resolved = rm.resolvePromptForClient(ref, '', cid);
        if (!resolved.found) {
          return textResult(
            `未找到或未投射给当前 Agent 的提示词: ${ref}。可先 tb_list_prompts。`,
            true,
          );
        }
        try { rm.recordResourceHit?.(resolved.id, cid); } catch { /* ignore */ }
        return textResult(resolved.text || '');
      }

      const r = findManagedResource(rm, type || null, ref);
      if (!r) {
        return textResult(
          `未找到资源: ${ref}${type ? ` (type=${type})` : ''}。可先 tb_list_resources 或 tb_list_catalog。`,
          true,
        );
      }
      if (r.type === 'assistant' && typeof rm.resolveAssistantForClient === 'function') {
        const resolved = rm.resolveAssistantForClient(r.name || ref, cid);
        if (!resolved.found) {
          return textResult(
            `智能体未投射给当前 Agent: ${ref}。请先在 Token Bank 启用到本 Agent。`,
            true,
          );
        }
        if (mode === 'summary') return textResult(formatResourceDetail(resolved.resource || r));
        try { rm.recordResourceHit?.(resolved.id, cid); } catch { /* ignore */ }
        const title = resolved.resource?.display_name || resolved.name;
        return textResult([
          `dispatch_id: assistant:${resolved.id}`,
          `# 智能体出战：${title}`,
          '（请在当前会话按下列正文执行；仅编排/游乐场才使用 tb_dispatch_agent）',
          '',
          resolved.text || '(无出战正文)',
        ].join('\n'));
      }
      // prompt：直接返回全文（投射门控），与 tb_get_prompt 一致，减少二次误调
      if (r.type === 'prompt' && typeof rm.resolvePromptForClient === 'function') {
        const resolved = rm.resolvePromptForClient(r.name || ref, '', cid);
        if (!resolved.found) {
          return textResult(
            `提示词未投射给当前 Agent: ${ref}。请先在 Token Bank 投射到本 Agent，或 tb_list_prompts。`,
            true,
          );
        }
        try { rm.recordResourceHit?.(resolved.id || r.id, cid); } catch { /* ignore */ }
        if (mode === 'summary') return textResult(formatResourceDetail(r));
        return textResult(resolved.text || '');
      }
      if (r.type === 'skill') {
        // Skill 与 prompt/assistant 一致:未投射给当前 Agent 则不可读
        if (!rm.isResourceProjectedToClient(r.id, cid)) {
          return textResult(
            `Skill 未投射给当前 Agent: ${ref}。请先在 Token Bank 投射到本 Agent，或 tb_list_resources(type=skill)。`,
            true,
          );
        }
        try { rm.recordResourceHit?.(r.id, cid); } catch { /* ignore */ }
      }
      return textResult(formatResourceDetail(r));
    } catch (e) {
      return textResult(`读取资源失败: ${e.message}`, true);
    }
  }

  if (name === 'tb_list_catalog') {
    try {
      const type = String(args.type || 'all').toLowerCase();
      const query = String(args.query || '').trim();
      const filters = {};
      if (type && type !== 'all') filters.type = type;
      if (query) filters.query = query;
      const { items } = rm.listCatalog(filters);
      if (!items.length) return textResult('（社区目录为空）');
      const lines = items.map((it) => {
        const flag = it.installed ? '已纳管' : '未安装';
        const disp = it.display_name && it.display_name !== it.name ? ` (${it.display_name})` : '';
        const desc = it.description ? `: ${String(it.description).slice(0, 100)}` : '';
        return `- [${it.type}|${flag}] ${it.name}${disp}${desc}`;
      });
      return textResult(
        `社区/内置目录 ${items.length} 项（未安装请在 Token Bank 客户端安装）\n${lines.join('\n')}`,
      );
    } catch (e) {
      return textResult(`列出目录失败: ${e.message}`, true);
    }
  }

  return textResult(`未知工具: ${name}`, true);
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'tokenbank-resources', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    handleToolCall(params?.name, params?.arguments || {})
      .then(result => send({ jsonrpc: '2.0', id, result }))
      .catch(err => send({
        jsonrpc: '2.0',
        id,
        result: textResult(err.message, true),
      }));
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      handleMessage(JSON.parse(t));
    } catch (e) {
      // 忽略非法行
    }
  });
}

module.exports = {
  TOOLS,
  handleToolCall,
  handleMessage,
  setResourceManager,
  setRelayedMcpLister,
  setPlainToolLister,
  setRelayRpc,
  findManagedResource,
  formatResourceDetail,
};
