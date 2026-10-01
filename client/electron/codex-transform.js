// client/electron/codex-transform.js
// OpenAI Responses API ↔ Chat Completions API 双向转换。
//
// 用途：Codex 客户端走 Responses 协议（/v1/responses），而很多第三方模型只暴露
// Chat Completions（/v1/chat/completions）。本模块把 Responses 请求转成 Chat 请求转发上游，
// 再把上游 Chat 响应（流式 SSE 或非流式 JSON）转回 Responses 格式回给 Codex。
//
// 移植自 cc-switch 的 transform_codex_chat.rs + streaming_codex_chat.rs + codex_chat_common.rs，
// 保留 reasoning（思考）、tool calls（工具调用）、缓存 token 等高级语义。纯函数/纯状态机，便于单测。
'use strict';

const crypto = require('crypto');

// ── canonical JSON：对象 key 递归排序后序列化（与 cc-switch 的 canonicalize 行为一致）──
// 工具调用参数在流式分片拼接后可能是 `{ "b":2, "a":1 }`，需归一成稳定的 `{"a":1,"b":2}`，
// 否则 Codex 端按字符串比对历史会错乱。
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

// 把工具参数（可能是字符串化 JSON，也可能是对象）归一为字符串。无法解析时原样返回。
function canonicalizeArgs(args) {
  if (args == null) return '';
  if (typeof args === 'string') {
    const s = args.trim();
    if (!s) return '';
    try { return JSON.stringify(canonicalize(JSON.parse(s))); }
    catch { return args; } // 流式未拼完整时保持原样
  }
  try { return JSON.stringify(canonicalize(args)); } catch { return String(args); }
}

// ── <think> 块解析（codex_chat_common.rs 的 split_leading_think_block）──
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

// 返回 [reasoning, answer]，若开头不是 <think> 返回 null。
function splitLeadingThinkBlock(text) {
  const trimmed = text.replace(/^\s+/, '');
  const wsLen = text.length - trimmed.length;
  if (!trimmed.startsWith(THINK_OPEN)) return null;
  const bodyStart = wsLen + THINK_OPEN.length;
  const closeRel = text.indexOf(THINK_CLOSE, bodyStart);
  if (closeRel < 0) return null;
  const answerStart = closeRel + THINK_CLOSE.length;
  return [
    text.slice(bodyStart, closeRel).trim(),
    text.slice(answerStart).replace(/^[\r\n\t ]+/, ''),
  ];
}

function stripLeadingThinkOpenTag(text) {
  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed.startsWith(THINK_OPEN)) return null;
  return trimmed.slice(THINK_OPEN.length).trim();
}

// 从一个对象里抽 reasoning 文本：reasoning_content > reasoning(字符串/对象) > reasoning_details。
function extractReasoningFieldText(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['reasoning_content', 'reasoning']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  const r = value.reasoning;
  if (r && typeof r === 'object') {
    for (const key of ['content', 'text', 'summary']) {
      if (typeof r[key] === 'string' && r[key]) return r[key];
    }
  }
  const details = value.reasoning_details;
  if (details != null) {
    const t = extractReasoningDetailsText(details);
    if (t) return t;
  }
  return null;
}

function extractReasoningDetailsText(value) {
  if (typeof value === 'string') return value || null;
  if (Array.isArray(value)) {
    const t = value.map(extractReasoningDetailPartText).filter(Boolean).join('\n\n');
    return t || null;
  }
  if (value && typeof value === 'object') return extractReasoningDetailPartText(value);
  return null;
}

function extractReasoningDetailPartText(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['text', 'content', 'summary']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  if (Array.isArray(value.parts)) {
    const t = value.parts.map(extractReasoningDetailPartText).filter(Boolean).join('\n\n');
    return t || null;
  }
  return null;
}

// 从 Responses 的 reasoning item 抽文本（summary 数组/字符串）。
function extractReasoningSummaryText(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['reasoning_content', 'content', 'text']) {
    if (typeof value[key] === 'string' && value[key]) return value[key];
  }
  const summary = value.summary;
  if (summary == null) return null;
  if (typeof summary === 'string') return summary || null;
  if (Array.isArray(summary)) {
    const t = summary
      .map(p => (typeof p === 'string' ? p : (p && (p.text || p.content)) || ''))
      .filter(Boolean)
      .join('\n\n');
    return t || null;
  }
  return null;
}

function responseIdFromChatId(id) {
  const base = id || 'llmproxy';
  return base.startsWith('resp_') ? base : `resp_${base}`;
}

// message 条目 id 必须以 'msg' 开头（Responses API 校验），不能沿用 resp_ 前缀。
// 由 responseId 去掉 resp_ 前缀后加 msg_ 得出，保证与该轮响应可对应。
function messageIdFromResponseId(responseId) {
  const base = String(responseId || '').replace(/^resp_/, '') || 'llmproxy';
  return `msg_${base}`;
}

// 纠正 Responses 请求 input 里被污染的 message 条目 id：官方要求 message 条目 id 以 'msg'
// 开头，历史里旧版本写成了 resp_..._msg，多轮回传会被官方以 invalid_id_prefix 拒收。
// 直通给原生 Responses 上游前调用，把这类坏 id 就地纠正回 msg_ 前缀。
function sanitizeResponsesInputIds(body) {
  if (!body || !Array.isArray(body.input)) return body;
  for (const item of body.input) {
    if (item && item.type === 'message' && typeof item.id === 'string' && !item.id.startsWith('msg')) {
      item.id = 'msg_' + item.id.replace(/^resp_/, '').replace(/_msg$/, '');
    }
  }
  return body;
}

function responseStatusFromFinish(finishReason) {
  return finishReason === 'length' ? 'incomplete' : 'completed';
}

// 构造 Responses function_call output item（codex_chat_common.rs 的 response_function_call_item）。
function responseFunctionCallItem(itemId, status, callId, name, args, reasoning, namespace) {
  const item = { id: itemId, type: 'function_call', status, call_id: callId, name, arguments: args };
  if (namespace) item.namespace = namespace;
  const r = reasoning && reasoning.trim();
  if (r) item.reasoning_content = r;
  return item;
}

/** 构造 Responses custom_tool_call（freeform 工具回写给 Codex） */
function responseCustomToolCallItem(itemId, status, callId, name, input, reasoning) {
  const item = {
    id: itemId, type: 'custom_tool_call', status, call_id: callId, name,
    input: input == null ? '' : String(input),
  };
  const r = reasoning && reasoning.trim();
  if (r) item.reasoning_content = r;
  return item;
}

/** 构造 Responses tool_search_call（Codex 0.142+ 动态加载工具） */
function responseToolSearchCallItem(callId, status, argumentsStr, reasoning) {
  let parsed = {};
  try { parsed = JSON.parse(argumentsStr || '{}'); } catch { parsed = {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  const item = {
    type: 'tool_search_call', call_id: callId, status, execution: 'client', arguments: parsed,
  };
  const r = reasoning && reasoning.trim();
  if (r) item.reasoning_content = r;
  return item;
}

/**
 * Chat function.arguments → custom_tool_call.input。
 * 转换时把 freeform 包成 {input:"..."}；若模型直接吐纯文本/其它 JSON，尽量还原。
 */
function freeformInputFromArgs(args) {
  const raw = typeof args === 'string' ? args : canonicalizeArgs(args);
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.input === 'string') return obj.input;
    if (typeof obj === 'string') return obj;
  } catch { /* 非 JSON：整段当 freeform 文本 */ }
  return raw;
}

// ── Codex 工具上下文（对齐 cc-switch CodexToolContext）────────────────────────
// Codex 0.142+ 用 namespace / tool_search / custom 扩展；Chat 上游只认扁平 function。
// 请求侧展平，响应侧按 chat_name 还原 namespace/custom/tool_search，否则 Codex 匹配不到工具会中断。
const TOOL_SEARCH_PROXY_NAME = 'tool_search';
const CUSTOM_TOOL_INPUT_FIELD = 'input';
const CHAT_TOOL_NAME_MAX_LEN = 64;
// Codex 0.147+ 把内置工具包进默认 namespace "functions"；客户端 registry 仍按
// ToolName::plain(name)（namespace=None）注册。展平名 functions__exec 若原样回写，
// 会变成 unsupported call。
const DEFAULT_FUNCTION_NAMESPACE = 'functions';
const DEFAULT_FUNCTION_NAMESPACE_PREFIX = `${DEFAULT_FUNCTION_NAMESPACE}__`;
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Preserve formatting exactly and follow the original tool definition embedded in the description.';
const CUSTOM_TOOL_PRESERVED_METADATA_HEADING = 'Original tool definition:';

const CodexToolKind = { Function: 'function', Namespace: 'namespace', Custom: 'custom', ToolSearch: 'tool_search' };

function shortSha256Hex(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/** namespace__child；超长名按 cc-switch 截断并附短 hash */
function flattenNamespaceToolName(namespace, name) {
  const full = `${namespace}__${name}`;
  if (full.length <= CHAT_TOOL_NAME_MAX_LEN) return full;
  const hash = shortSha256Hex(full);
  const suffix = `__${hash}`;
  const prefixLen = Math.max(0, CHAT_TOOL_NAME_MAX_LEN - suffix.length);
  return full.slice(0, prefixLen) + suffix;
}

/** 剥掉默认 functions__ 前缀（模型常按展平名回调内置工具） */
function stripDefaultNamespacePrefix(chatName) {
  const n = String(chatName || '');
  if (n.startsWith(DEFAULT_FUNCTION_NAMESPACE_PREFIX)
      && n.length > DEFAULT_FUNCTION_NAMESPACE_PREFIX.length) {
    return n.slice(DEFAULT_FUNCTION_NAMESPACE_PREFIX.length);
  }
  return n;
}

/** Chat 上游要求 parameters.type 必须是 "object"；Responses 常带 null / 缺 type */
function normalizeFunctionParameters(params) {
  let out;
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    out = { ...params };
  } else {
    out = { type: 'object', properties: {} };
  }
  if (out.type !== 'object') out.type = 'object';
  return out;
}

function responsesToolName(tool) {
  const n = (tool && tool.function && tool.function.name) || (tool && tool.name);
  if (typeof n !== 'string') return null;
  const t = n.trim();
  return t || null;
}

function responsesCustomToolDescription(tool) {
  return `${CUSTOM_TOOL_PRESERVED_METADATA_HEADING}\n\`\`\`json\n${JSON.stringify(canonicalize(tool))}\n\`\`\``;
}

class CodexToolContext {
  constructor() {
    this._chatTools = [];
    this._seen = new Set();
    this._chatNameToSpec = new Map();
    this._namespaceNameToChatName = new Map(); // key: `${ns}\0${name}`
  }

  chatTools() { return this._chatTools; }

  lookupChatName(chatName) {
    const direct = this._chatNameToSpec.get(chatName);
    if (direct) return direct;
    const stripped = stripDefaultNamespacePrefix(chatName);
    if (stripped !== chatName) return this._chatNameToSpec.get(stripped) || null;
    return null;
  }

  isCustomToolChatName(chatName) {
    const s = this.lookupChatName(chatName);
    return !!(s && s.kind === CodexToolKind.Custom);
  }

  freeformToolNames() {
    const names = new Set();
    for (const [chatName, spec] of this._chatNameToSpec) {
      if (spec.kind === CodexToolKind.Custom) names.add(chatName);
    }
    return names;
  }

  chatNameForResponseFunction(name, namespace) {
    if (namespace) {
      const mapped = this._namespaceNameToChatName.get(`${namespace}\0${name}`);
      if (mapped) return mapped;
      // 默认 functions 命名空间：历史调用按 plain name 对齐 Chat tools
      if (namespace === DEFAULT_FUNCTION_NAMESPACE) return name;
      return flattenNamespaceToolName(namespace, name);
    }
    const stripped = stripDefaultNamespacePrefix(name);
    if (stripped !== name && this._chatNameToSpec.has(stripped)) return stripped;
    return name;
  }

  /** 记录 functions\0name → plain，便于历史 function_call 带 namespace 时展平对齐 */
  _bindDefaultNamespace(originalName) {
    if (!originalName) return;
    this._namespaceNameToChatName.set(`${DEFAULT_FUNCTION_NAMESPACE}\0${originalName}`, originalName);
  }

  _addChatTool(chatName, spec, chatTool) {
    if (this._seen.has(chatName)) return;
    this._seen.add(chatName);
    this._chatNameToSpec.set(chatName, spec);
    if (spec.namespace) {
      this._namespaceNameToChatName.set(`${spec.namespace}\0${spec.name}`, chatName);
    }
    this._chatTools.push(chatTool);
  }

  addFunctionTool(tool, namespace) {
    const originalName = responsesToolName(tool);
    if (!originalName) return;
    const chatName = namespace
      ? flattenNamespaceToolName(namespace, originalName)
      : originalName;
    const chatTool = responsesFunctionToolToChatTool(tool, chatName);
    if (!chatTool) return;
    this._addChatTool(chatName, {
      kind: namespace ? CodexToolKind.Namespace : CodexToolKind.Function,
      name: originalName,
      namespace: namespace || null,
    }, chatTool);
  }

  addCustomTool(tool) {
    const name = responsesToolName(tool);
    if (!name) return;
    const chatTool = {
      type: 'function',
      function: {
        name,
        description: responsesCustomToolDescription(tool),
        parameters: {
          type: 'object',
          properties: {
            [CUSTOM_TOOL_INPUT_FIELD]: {
              type: 'string',
              description: CUSTOM_TOOL_INPUT_DESCRIPTION,
            },
          },
          required: [CUSTOM_TOOL_INPUT_FIELD],
        },
      },
    };
    this._addChatTool(name, { kind: CodexToolKind.Custom, name, namespace: null }, chatTool);
  }

  addLocalShellTool(tool) {
    // cc-switch 未映射 local_shell；我们保留，否则 shell 工具整轮丢失
    const chatTool = {
      type: 'function',
      function: {
        name: 'local_shell',
        description: (tool && tool.description) || 'Run a command in the local shell',
        parameters: {
          type: 'object',
          properties: {
            command: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'string' } },
              ],
              description: 'Shell command (string or argv array)',
            },
            working_directory: { type: 'string' },
            timeout_ms: { type: 'number' },
            env: { type: 'object', additionalProperties: { type: 'string' } },
          },
          required: ['command'],
          additionalProperties: true,
        },
      },
    };
    this._addChatTool('local_shell', {
      kind: CodexToolKind.Function, name: 'local_shell', namespace: null,
    }, chatTool);
  }

  addToolSearchTool() {
    const chatTool = {
      type: 'function',
      function: {
        name: TOOL_SEARCH_PROXY_NAME,
        description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query for tools or connectors to load.' },
            limit: { type: 'integer', description: 'Maximum number of tool groups to return.' },
          },
          required: ['query'],
        },
      },
    };
    this._addChatTool(TOOL_SEARCH_PROXY_NAME, {
      kind: CodexToolKind.ToolSearch, name: TOOL_SEARCH_PROXY_NAME, namespace: null,
    }, chatTool);
  }

  addNamespaceTool(namespaceTool) {
    const namespace = namespaceTool && namespaceTool.name;
    if (!namespace || typeof namespace !== 'string') return;
    const children = namespaceTool.tools || namespaceTool.children;
    if (!Array.isArray(children)) return;
    // 默认 functions：解开包装，保留 exec/wait 原名；MCP 等其它 namespace 仍展平
    const unwrap = namespace === DEFAULT_FUNCTION_NAMESPACE;
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      const t = child.type;
      if (t === 'function') {
        this.addFunctionTool(child, unwrap ? null : namespace);
        if (unwrap) this._bindDefaultNamespace(responsesToolName(child));
      } else if (t === 'custom') {
        // 旧实现只展开 function 子项，把 custom exec 整颗丢掉 → 模型只能空口调 functions__exec
        this.addCustomTool(child);
        if (unwrap) this._bindDefaultNamespace(responsesToolName(child));
      } else if (t === 'local_shell') {
        this.addLocalShellTool(child);
      } else if (t === 'namespace') {
        this.addNamespaceTool(child);
      }
    }
  }

  addResponseTool(tool) {
    if (typeof tool === 'string') {
      this.addCustomTool({ type: 'custom', name: tool });
      return;
    }
    if (!tool || typeof tool !== 'object') return;
    switch (tool.type) {
      case 'function': this.addFunctionTool(tool, null); break;
      case 'custom': this.addCustomTool(tool); break;
      case 'tool_search': this.addToolSearchTool(); break;
      case 'namespace': this.addNamespaceTool(tool); break;
      case 'local_shell': this.addLocalShellTool(tool); break;
      default: break; // web_search 等跳过，避免上游 400
    }
  }
}

function responsesFunctionToolToChatTool(tool, chatName) {
  if (!tool || tool.type !== 'function') return null;
  if (tool.function && typeof tool.function === 'object') {
    const fn = { ...tool.function, name: chatName };
    fn.parameters = normalizeFunctionParameters(fn.parameters);
    if (tool.strict !== undefined && fn.strict === undefined) fn.strict = tool.strict;
    return { type: 'function', function: fn };
  }
  const fn = {
    name: chatName,
    description: tool.description ?? null,
    parameters: normalizeFunctionParameters(tool.parameters),
  };
  if (tool.strict !== undefined) fn.strict = tool.strict;
  return { type: 'function', function: fn };
}

function collectToolSearchOutputTools(value, context) {
  if (Array.isArray(value)) {
    for (const item of value) collectToolSearchOutputTools(item, context);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (value.type === 'tool_search_output' && Array.isArray(value.tools)) {
    for (const t of value.tools) context.addResponseTool(t);
  }
  // Codex Desktop 把 exec 等运行时工具挂在 input 的 additional_tools 载体里，
  // 不提升进 tools 则上游看不到 → 模型只能空口说「我去抓取」然后 task_complete（无工具日志）
  if (value.type === 'additional_tools' && Array.isArray(value.tools)) {
    for (const t of value.tools) context.addResponseTool(t);
  }
  for (const v of Object.values(value)) collectToolSearchOutputTools(v, context);
}

/** 从 Responses 请求体构建工具上下文（请求展平 + 响应还原共用） */
function buildCodexToolContext(body) {
  const context = new CodexToolContext();
  if (body && Array.isArray(body.tools)) {
    for (const tool of body.tools) context.addResponseTool(tool);
  }
  if (body && body.input !== undefined) collectToolSearchOutputTools(body.input, context);
  return context;
}

/** Codex Desktop 常见 freeform 工具：上下文缺失时仍按 custom_tool_call 回写 */
const KNOWN_CUSTOM_TOOL_NAMES = new Set(['exec', 'apply_patch', 'write_stdin']);

/** 兼容旧 API：仅收集 custom 工具名 */
function collectFreeformToolNames(tools) {
  return buildCodexToolContext({ tools }).freeformToolNames();
}

/** 按 chat 工具名还原 Responses output item（namespace / custom / tool_search） */
function responseToolCallItemFromChatName(itemId, status, callId, chatName, args, reasoning, toolContext) {
  const spec = toolContext && toolContext.lookupChatName(chatName);
  if (spec && spec.kind === CodexToolKind.ToolSearch) {
    return responseToolSearchCallItem(callId, status, args, reasoning);
  }
  if (spec && spec.kind === CodexToolKind.Custom) {
    return responseCustomToolCallItem(
      itemId || `ctc_${callId}`, status, callId, spec.name, freeformInputFromArgs(args), reasoning);
  }
  if (spec) {
    // functions 默认命名空间不要带回，否则 Codex 按 {name, namespace} 精确匹配失败
    const ns = spec.namespace === DEFAULT_FUNCTION_NAMESPACE ? null : spec.namespace;
    return responseFunctionCallItem(
      itemId || `fc_${callId}`, status, callId, spec.name, canonicalizeArgs(args), reasoning, ns);
  }
  const stripped = stripDefaultNamespacePrefix(chatName);
  // 无上下文但名字是 Codex 已知 freeform（含 functions__exec）→ 仍回写 custom
  if (KNOWN_CUSTOM_TOOL_NAMES.has(chatName) || KNOWN_CUSTOM_TOOL_NAMES.has(stripped)) {
    const name = KNOWN_CUSTOM_TOOL_NAMES.has(chatName) ? chatName : stripped;
    return responseCustomToolCallItem(
      itemId || `ctc_${callId}`, status, callId, name, freeformInputFromArgs(args), reasoning);
  }
  return responseFunctionCallItem(
    itemId || `fc_${callId}`, status, callId, stripped, canonicalizeArgs(args), reasoning);
}

function itemIdFromChatName(callId, chatName, toolContext) {
  if (toolContext && toolContext.isCustomToolChatName(chatName)) return `ctc_${callId}`;
  const stripped = stripDefaultNamespacePrefix(chatName);
  if (KNOWN_CUSTOM_TOOL_NAMES.has(chatName) || KNOWN_CUSTOM_TOOL_NAMES.has(stripped)) return `ctc_${callId}`;
  return `fc_${callId}`;
}

/** 摘要：入站 tools / additional_tools 类型统计（写网关调试日志用） */
function summarizeResponsesTools(body) {
  const types = {};
  const bump = (t) => { types[t || '?'] = (types[t || '?'] || 0) + 1; };
  if (body && Array.isArray(body.tools)) {
    for (const t of body.tools) bump(t && t.type);
  }
  let additional = 0;
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    if (v.type === 'additional_tools' && Array.isArray(v.tools)) {
      additional += v.tools.length;
      for (const t of v.tools) bump(`additional:${(t && t.type) || '?'}`);
    }
  };
  if (body) walk(body.input);
  return { top_level: (body && body.tools && body.tools.length) || 0, additional, types };
}

// ════════════════════════════════════════════════════════════════════════════
// 1) 请求转换：Responses → Chat Completions
// ════════════════════════════════════════════════════════════════════════════

const EXTRA_PASSTHROUGH = [
  // 刻意不透传 n / temperature / top_p：Kimi Coding 等上游对采样参数固定，乱传会 400 中断工具轮
  'logit_bias', 'logprobs', 'metadata',
  'presence_penalty', 'response_format', 'seed',
  'service_tier', 'stop', 'stream_options', 'top_logprobs', 'user',
];

function instructionText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(p => (typeof p === 'string' ? p : (p && p.text) || ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return value == null ? '' : String(value);
}

function responsesRoleToChat(role) {
  switch (role) {
    case 'system': case 'developer': return 'system';
    case 'assistant': return 'assistant';
    case 'tool': return 'tool';
    default: return 'user'; // user / latest_reminder / 未知 → user
  }
}

// Responses content 数组 → Chat content（纯文本时折叠成字符串，含图片时保留数组）。
function responsesContentToChat(content) {
  if (content == null || typeof content === 'string') return content;
  if (!Array.isArray(content)) return content;
  const parts = [];
  let hasNonText = false;
  for (const part of content) {
    const t = (part && part.type) || '';
    if (t === 'input_text' || t === 'output_text' || t === 'text') {
      if (part.text) parts.push({ type: 'text', text: part.text });
    } else if (t === 'refusal') {
      if (part.refusal) parts.push({ type: 'text', text: part.refusal });
    } else if (t === 'input_image') {
      if (part.image_url != null) {
        const imageUrl = (part.image_url && typeof part.image_url === 'object')
          ? part.image_url : { url: String(part.image_url) };
        parts.push({ type: 'image_url', image_url: imageUrl });
        hasNonText = true;
      }
    }
  }
  if (!hasNonText) {
    return parts.map(p => p.text).filter(Boolean).join('\n');
  }
  return parts;
}

/** 单工具转换（单测用）；完整路径走 CodexToolContext */
function responsesToolToChat(tool) {
  const ctx = new CodexToolContext();
  ctx.addResponseTool(tool);
  return ctx.chatTools()[0] || null;
}

function responsesToolChoiceToChat(tc, toolContext) {
  if (tc && typeof tc === 'object') {
    if (tc.type === 'function') {
      const chatName = toolContext
        ? toolContext.chatNameForResponseFunction(tc.name || '', tc.namespace)
        : (tc.name || '');
      return { type: 'function', function: { name: chatName } };
    }
    if (tc.type === 'tool_search') {
      return { type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME } };
    }
    if (tc.type === 'custom' && tc.name) {
      return { type: 'function', function: { name: tc.name } };
    }
    // namespace 形态的 tool_choice Chat 上游不认，丢弃（对齐 cc-switch 中和逻辑）
    if (tc.type === 'namespace') return 'auto';
  }
  return tc;
}

/** 把 Responses 工具调用参数规范成 Chat tool_calls.function.arguments 字符串 */
function toolCallArgsFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  // function_call / tool_search_call：arguments；custom_tool_call：input；local_shell_call：action
  if (item.type === 'custom_tool_call') {
    const input = item.input == null ? '' : item.input;
    return canonicalizeArgs({ [CUSTOM_TOOL_INPUT_FIELD]: input });
  }
  if (item.type === 'tool_search_call') {
    if (item.arguments !== undefined) return canonicalizeArgs(item.arguments);
    return '{}';
  }
  if (item.arguments !== undefined) return canonicalizeArgs(item.arguments);
  if (typeof item.input === 'string') return canonicalizeArgs({ input: item.input });
  if (item.input != null && typeof item.input === 'object') return canonicalizeArgs(item.input);
  if (item.action != null) return canonicalizeArgs(item.action);
  return '';
}

// 把 reasoning 文本追加到一条 assistant chat 消息的 reasoning_content 字段。
function appendReasoningContent(message, reasoning) {
  const r = (reasoning || '').trim();
  if (!r) return;
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
    message.reasoning_content += '\n\n' + r;
  } else {
    message.reasoning_content = r;
  }
}

// 把所有 system 消息合并到队首（MiniMax 等要求 system 只能首条）。
function collapseSystemToHead(messages) {
  const sys = [];
  const rest = [];
  for (const m of messages) {
    if (m.role === 'system' && typeof m.content === 'string') {
      if (m.content.trim()) sys.push(m.content);
      continue;
    }
    rest.push(m);
  }
  const out = [];
  if (sys.length) out.push({ role: 'system', content: sys.join('\n\n') });
  return out.concat(rest);
}

// 把 Responses input（字符串/单 item/数组）展开为 Chat messages。
function appendInputAsChatMessages(input, messages, toolContext) {
  const pendingToolCalls = [];
  let pendingReasoning = null;       // 暂存、待挂到下一条 assistant
  let lastAssistantIndex = null;

  const flushTools = () => {
    if (!pendingToolCalls.length) return;
    const msg = { role: 'assistant', content: null, tool_calls: pendingToolCalls.splice(0) };
    if (pendingReasoning) { appendReasoningContent(msg, pendingReasoning); pendingReasoning = null; }
    lastAssistantIndex = messages.length;
    messages.push(msg);
  };

  const handleItem = (item) => {
    if (item == null || typeof item !== 'object') {
      if (typeof item === 'string') messages.push({ role: 'user', content: item });
      return;
    }
    const type = item.type;
    // function_call / custom_tool_call / tool_search_call / local_shell_call → Chat assistant.tool_calls
    if (type === 'function_call' || type === 'custom_tool_call'
        || type === 'tool_search_call' || type === 'local_shell_call') {
      const r = extractReasoningFieldText(item);
      if (r && (!pendingReasoning || !pendingReasoning.includes(r.trim()))) {
        pendingReasoning = pendingReasoning ? pendingReasoning + '\n\n' + r.trim() : r.trim();
      }
      const callId = (item.call_id || item.id || '');
      let name;
      if (type === 'local_shell_call') {
        name = item.name || 'local_shell';
      } else if (type === 'tool_search_call') {
        name = TOOL_SEARCH_PROXY_NAME;
      } else if (type === 'function_call' && toolContext) {
        // 带 namespace 的历史调用必须展平为 chat 名，否则上游对不上已声明 tools
        name = toolContext.chatNameForResponseFunction(item.name || '', item.namespace);
      } else {
        name = item.name || '';
      }
      pendingToolCalls.push({
        id: callId, type: 'function',
        function: { name, arguments: toolCallArgsFromItem(item) },
      });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output'
        || type === 'local_shell_call_output' || type === 'tool_search_output') {
      // 工具结果回灌：必须保留，否则多轮工具调用历史断裂 → 上游 400 / 客户端中断
      // tool_search_output：工具清单已在 buildCodexToolContext 里收集；这里仍回灌文本结果
      flushTools();
      const callId = item.call_id || '';
      let output = '';
      if (typeof item.output === 'string') {
        try { output = JSON.stringify(canonicalize(JSON.parse(item.output))); } catch { output = item.output; }
      } else if (item.output != null) {
        output = JSON.stringify(canonicalize(item.output));
      } else if (type === 'tool_search_output' && Array.isArray(item.tools)) {
        // 无 output 字段时用工具列表摘要，保证 tool 消息非空
        output = JSON.stringify(canonicalize({ tools: item.tools.map(t => t && (t.name || t.type)) }));
      }
      messages.push({ role: 'tool', tool_call_id: callId, content: output });
    } else if (type === 'additional_tools') {
      // Codex 扩展 item：中途声明额外工具，带 role 但无 content。
      // 落到通用分支会产出 {role, content:null} → kimi/DeepSeek 400。跳过。
      return;
    } else if (type === 'reasoning') {
      const reasoning = extractReasoningSummaryText(item);
      const r = reasoning && reasoning.trim();
      if (r) {
        // 优先回挂到上一条 assistant（无 pending tool call 时）
        if (!pendingToolCalls.length && lastAssistantIndex != null
            && messages[lastAssistantIndex] && messages[lastAssistantIndex].role === 'assistant') {
          appendReasoningContent(messages[lastAssistantIndex], r);
        } else {
          pendingReasoning = pendingReasoning ? pendingReasoning + '\n\n' + r : r;
        }
      }
    } else if (type && type !== 'message') {
      // 未知 Responses item（如 web_search_call）：勿当成对话消息，避免 content:null 触发上游 400
      return;
    } else { // 'message' 或无 type
      flushTools();
      if (item.role !== undefined || item.content !== undefined) {
        const chatRole = responsesRoleToChat(item.role || 'user');
        const content = item.content !== undefined ? responsesContentToChat(item.content) : null;
        const msg = { role: chatRole, content };
        if (chatRole === 'assistant') {
          const embedded = extractReasoningFieldText(item);
          if (embedded) pendingReasoning = pendingReasoning ? pendingReasoning + '\n\n' + embedded.trim() : embedded.trim();
          if (pendingReasoning) { appendReasoningContent(msg, pendingReasoning); pendingReasoning = null; }
          lastAssistantIndex = messages.length;
        } else {
          pendingReasoning = null;
          lastAssistantIndex = (chatRole === 'tool') ? lastAssistantIndex : null;
        }
        messages.push(msg);
      }
    }
  };

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) handleItem(item);
  } else if (input && typeof input === 'object') {
    handleItem(input);
  }
  flushTools();

  // 末端兜底：带 tool_calls 的 assistant 必须有非空 reasoning_content（kimi/DeepSeek 要求）
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (!(typeof m.reasoning_content === 'string' && m.reasoning_content.trim())) {
        m.reasoning_content = 'tool call';
      }
    }
  }
}

// reasoning.effort 透传（简化版：直接映射顶层 reasoning_effort，未带 provider 能力声明）。
function applyReasoningOptions(result, body) {
  const effort = body.reasoning && typeof body.reasoning === 'object' ? body.reasoning.effort : undefined;
  if (typeof effort === 'string') {
    const low = effort.trim().toLowerCase();
    if (!['none', 'off', 'disabled'].includes(low)) result.reasoning_effort = effort;
  }
}

/**
 * Responses 请求 → Chat Completions 请求。
 * @param {object} body Responses 格式请求体
 * @returns {object} Chat Completions 请求体
 */
function responsesToChat(body) {
  const result = {};
  if (body.model !== undefined) result.model = body.model;

  // 先建工具上下文：展平 namespace / custom / tool_search，并供 input 历史名映射
  const toolContext = buildCodexToolContext(body);

  const messages = [];
  if (body.instructions !== undefined) {
    const it = instructionText(body.instructions);
    if (it) messages.push({ role: 'system', content: it });
  }
  if (body.input !== undefined) appendInputAsChatMessages(body.input, messages, toolContext);
  result.messages = collapseSystemToHead(messages);

  if (body.max_output_tokens !== undefined) result.max_tokens = body.max_output_tokens;
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) result.max_completion_tokens = body.max_completion_tokens;

  // 只透传 stream；temperature/top_p 不转发（Kimi Coding 等要求采样参数保持默认，否则工具轮 400）
  if (body.stream !== undefined) result.stream = body.stream;

  applyReasoningOptions(result, body);

  const tools = toolContext.chatTools();
  if (tools.length) result.tools = tools;
  if (body.tool_choice !== undefined) {
    result.tool_choice = responsesToolChoiceToChat(body.tool_choice, toolContext);
  }
  // parallel_tool_calls：多数 Coding API 不支持并行，强制 false 避免上游拒识
  if (result.tools) result.parallel_tool_calls = false;

  for (const k of EXTRA_PASSTHROUGH) {
    if (body[k] !== undefined) result[k] = body[k];
  }

  // 严格 Chat 上游在无 tools 时拒收 tool_choice / parallel_tool_calls
  if (!result.tools || !result.tools.length) {
    delete result.tool_choice;
    delete result.parallel_tool_calls;
  }

  // 流式必须显式 include_usage，否则第三方上游不在 SSE 末尾返回 usage（token 全漏记）。
  if (result.stream === true) {
    if (result.stream_options && typeof result.stream_options === 'object') {
      result.stream_options = { ...result.stream_options, include_usage: true };
    } else {
      result.stream_options = { include_usage: true };
    }
  }

  // 挂在结果上供网关回写时还原（不发给上游）
  result._codexToolContext = toolContext;
  return result;
}

// ════════════════════════════════════════════════════════════════════════════
// 2) 非流式响应转换：Chat Completions → Responses
// ════════════════════════════════════════════════════════════════════════════

function chatReasoningText(message) {
  const r = extractReasoningFieldText(message);
  if (r) return r;
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    if (split && split[0]) return split[0];
  }
  return null;
}

function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  }
  const inTok = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outTok = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const total = usage.total_tokens ?? (inTok + outTok);
  const out = { input_tokens: inTok, output_tokens: outTok, total_tokens: total };
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
  if (cached != null) out.input_tokens_details = { cached_tokens: cached };
  if (usage.completion_tokens_details !== undefined) out.output_tokens_details = usage.completion_tokens_details;
  if (usage.cache_read_input_tokens !== undefined) out.cache_read_input_tokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens !== undefined) out.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  return out;
}

function chatMessageToResponseItem(message, responseId) {
  const content = [];
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    const text = split ? split[1] : message.content;
    if (text) content.push({ type: 'output_text', text, annotations: [] });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const t = (part && part.type) || '';
      if (t === 'text' || t === 'output_text') {
        if (part.text) content.push({ type: 'output_text', text: part.text, annotations: [] });
      } else if (t === 'refusal') {
        if (part.refusal) content.push({ type: 'refusal', refusal: part.refusal });
      }
    }
  }
  if (typeof message.refusal === 'string' && message.refusal) {
    content.push({ type: 'refusal', refusal: message.refusal });
  }
  if (!content.length) return null;
  return { id: messageIdFromResponseId(responseId), type: 'message', status: 'completed', role: 'assistant', content };
}

function chatToolCallsToResponseItems(message, reasoning, toolContext, freeformToolNames) {
  const freeform = freeformToolNames instanceof Set
    ? freeformToolNames
    : new Set(freeformToolNames || []);
  const out = [];
  const pushOne = (callId, name, args) => {
    const n = (name || '').trim();
    if (!n) return; // 空名工具对 Codex 无效，丢弃（对齐 cc-switch）
    if (toolContext) {
      out.push(responseToolCallItemFromChatName(
        itemIdFromChatName(callId, n, toolContext),
        'completed', callId, n, args, reasoning, toolContext));
      return;
    }
    // 无 toolContext：freeform 集合 + Codex 已知 freeform 名（含 functions__exec）
    const stripped = stripDefaultNamespacePrefix(n);
    if (freeform.has(n) || KNOWN_CUSTOM_TOOL_NAMES.has(n)
        || freeform.has(stripped) || KNOWN_CUSTOM_TOOL_NAMES.has(stripped)) {
      const name = (freeform.has(n) || KNOWN_CUSTOM_TOOL_NAMES.has(n)) ? n : stripped;
      out.push(responseCustomToolCallItem(
        `ctc_${callId}`, 'completed', callId, name, freeformInputFromArgs(args), reasoning));
    } else {
      out.push(responseFunctionCallItem(
        `fc_${callId}`, 'completed', callId, stripped, canonicalizeArgs(args), reasoning));
    }
  };
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tc, index) => {
      const callId = (tc.id && tc.id) || `call_${index}`;
      const fn = tc.function || {};
      pushOne(callId, fn.name || '', fn.arguments);
    });
  } else if (message.function_call) {
    const fc = message.function_call;
    const callId = (fc.id && fc.id) || 'call_0';
    pushOne(callId, fc.name || '', fc.arguments);
  }
  return out;
}

/**
 * 非流式 Chat Completions 响应 → Responses 响应。
 * @param {object} body Chat Completions 响应体
 * @param {object} [opts]
 * @param {CodexToolContext} [opts.toolContext]
 * @param {Set<string>} [opts.freeformToolNames] 兼容旧调用
 * @returns {object} Responses 响应体
 */
function chatToResponses(body, opts = {}) {
  const choices = body.choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new Error('No choices in chat response');
  }
  const choice = choices[0];
  const message = choice.message;
  if (!message) throw new Error('No message in chat choice');

  const responseId = responseIdFromChatId(body.id);
  const model = body.model || '';
  const createdAt = body.created || 0;
  const finishReason = choice.finish_reason;
  const toolContext = opts.toolContext || null;
  const freeformToolNames = opts.freeformToolNames
    || (toolContext ? toolContext.freeformToolNames() : new Set());

  const reasoning = chatReasoningText(message);
  const output = [];
  if (reasoning) {
    output.push({ id: `rs_${responseId}`, type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] });
  }
  const msgItem = chatMessageToResponseItem(message, responseId);
  if (msgItem) output.push(msgItem);
  output.push(...chatToolCallsToResponseItems(message, reasoning, toolContext, freeformToolNames));

  const response = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: responseStatusFromFinish(finishReason),
    model,
    output,
    usage: chatUsageToResponsesUsage(body.usage),
  };
  if (finishReason === 'length') response.incomplete_details = { reason: 'max_output_tokens' };
  return response;
}

// 把 Chat 上游错误体规整成 Responses 风格错误对象。
function chatErrorToResponseError(body) {
  if (body == null) {
    return { error: { message: 'Upstream returned an empty error response', type: 'upstream_error', code: null, param: null } };
  }
  if (typeof body === 'string') {
    return { error: { message: body, type: 'upstream_error', code: null, param: null } };
  }
  const source = (body && body.error) || body;
  const message = source.message || source.detail || source.status_msg
    || source.base_resp?.status_msg || (typeof source === 'string' ? source : null)
    || (() => { try { return JSON.stringify(source); } catch { return 'Upstream error'; } })();
  return {
    error: {
      message,
      type: source.type || 'upstream_error',
      code: source.code ?? source.base_resp?.status_code ?? null,
      param: source.param ?? null,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 3) 流式状态机：Chat Completions SSE chunk → Responses SSE 事件
// ════════════════════════════════════════════════════════════════════════════

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// inline <think> 检测三态
const THINK_DETECTING = 0, THINK_REASONING = 1, THINK_TEXT = 2;

// 决定缓冲区开头是否 <think>：'more'（需更多）| 'reasoning' | 'text'
function leadingThinkDecision(buffer) {
  const trimmed = buffer.replace(/^\s+/, '');
  if (!trimmed) return 'more';
  if (trimmed.startsWith(THINK_OPEN)) return 'reasoning';
  if (THINK_OPEN.startsWith(trimmed)) return 'more'; // 是 <think> 的前缀
  return 'text';
}

/**
 * Chat→Responses 流式状态机。逐个喂入 Chat SSE 解析出的 chunk 对象，吐出 Responses SSE 字符串。
 * 用法：
 *   const sm = new ChatToResponsesStream();
 *   out += sm.handleChunk(chatChunkObj);   // 每个 data: {...}
 *   out += sm.finalize();                  // 收到 [DONE] 或流结束
 *   // 出错：out += sm.failedEvent(msg, type)
 */
class ChatToResponsesStream {
  constructor(opts = {}) {
    this.responseStarted = false;
    this.completed = false;
    this.responseId = 'resp_llmproxy';
    this.model = '';
    this.createdAt = 0;
    this.nextIndex = 0;
    this.text = { outputIndex: null, itemId: '', text: '', added: false, done: false };
    this.reasoning = { outputIndex: null, itemId: '', text: '', added: false, done: false };
    this.inlineThink = { mode: THINK_DETECTING, buffer: '' };
    this.tools = new Map(); // chatIndex -> {outputIndex,itemId,callId,name,arguments,reasoningContent,added,done,freeform,toolSearch}
    this.outputItems = []; // [outputIndex, item]
    this.latestUsage = null;
    this.finishReason = null;
    // 工具上下文：回写时还原 namespace / custom / tool_search（对齐 cc-switch）
    this.toolContext = opts.toolContext || null;
    this.freeformToolNames = opts.freeformToolNames instanceof Set
      ? opts.freeformToolNames
      : (this.toolContext ? this.toolContext.freeformToolNames() : new Set(opts.freeformToolNames || []));
  }

  _isFreeform(chatName) {
    // Codex Desktop 的 exec/apply_patch：即便上下文漏登记也按 freeform 流式回写
    const stripped = stripDefaultNamespacePrefix(chatName);
    if (KNOWN_CUSTOM_TOOL_NAMES.has(chatName) || KNOWN_CUSTOM_TOOL_NAMES.has(stripped)) return true;
    if (this.toolContext) {
      return this.toolContext.isCustomToolChatName(chatName)
        || this.toolContext.isCustomToolChatName(stripped);
    }
    return this.freeformToolNames.has(chatName) || this.freeformToolNames.has(stripped);
  }

  _isToolSearch(chatName) {
    if (this.toolContext) {
      const s = this.toolContext.lookupChatName(chatName);
      return !!(s && s.kind === CodexToolKind.ToolSearch);
    }
    return chatName === TOOL_SEARCH_PROXY_NAME;
  }

  _buildToolItem(status, callId, chatName, args, reasoning) {
    if (this.toolContext) {
      return responseToolCallItemFromChatName(
        itemIdFromChatName(callId, chatName, this.toolContext),
        status, callId, chatName, args, reasoning, this.toolContext);
    }
    const name = this._isFreeform(chatName)
      ? (KNOWN_CUSTOM_TOOL_NAMES.has(chatName) ? chatName : stripDefaultNamespacePrefix(chatName))
      : stripDefaultNamespacePrefix(chatName);
    if (this._isFreeform(chatName)) {
      return responseCustomToolCallItem(
        `ctc_${callId}`, status, callId, name, freeformInputFromArgs(args), reasoning);
    }
    return responseFunctionCallItem(
      `fc_${callId}`, status, callId, name, canonicalizeArgs(args), reasoning);
  }

  _nextIndex() { return this.nextIndex++; }

  _baseResponse(status, output) {
    return {
      id: this.responseId, object: 'response', created_at: this.createdAt,
      status, model: this.model, output,
      usage: this.latestUsage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
  }

  _ensureStarted() {
    if (this.responseStarted) return '';
    this.responseStarted = true;
    return sseEvent('response.created', { type: 'response.created', response: this._baseResponse('in_progress', []) })
         + sseEvent('response.in_progress', { type: 'response.in_progress', response: this._baseResponse('in_progress', []) });
  }

  handleChunk(chunk) {
    let out = '';
    if (typeof chunk.id === 'string') this.responseId = responseIdFromChatId(chunk.id);
    if (typeof chunk.model === 'string' && chunk.model) this.model = chunk.model;
    if (typeof chunk.created === 'number') this.createdAt = chunk.created;

    out += this._ensureStarted();

    if (chunk.usage != null) this.latestUsage = chatUsageToResponsesUsage(chunk.usage);

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return out;

    const delta = choice.delta;
    if (delta) {
      const reasoning = extractReasoningFieldText(delta);
      if (reasoning) out += this._pushReasoningDelta(reasoning);

      if (typeof delta.content === 'string' && delta.content) {
        out += this._pushContentDelta(delta.content);
      }

      if (Array.isArray(delta.tool_calls)) {
        out += this._flushInlineThinkAtBoundary();
        const reasoningForTool = this._currentReasoningText();
        out += this._finalizeReasoning();
        for (const tc of delta.tool_calls) out += this._pushToolCallDelta(tc, reasoningForTool);
      }
    }
    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;
    return out;
  }

  _pushContentDelta(delta) {
    const it = this.inlineThink;
    if (it.mode === THINK_TEXT) {
      return this._finalizeReasoning() + this._pushTextDelta(delta);
    }
    if (it.mode === THINK_DETECTING) {
      it.buffer += delta;
      const decision = leadingThinkDecision(it.buffer);
      if (decision === 'more') return '';
      if (decision === 'reasoning') { it.mode = THINK_REASONING; return this._drainInlineThink(); }
      // text
      it.mode = THINK_TEXT;
      const text = it.buffer; it.buffer = '';
      return this._finalizeReasoning() + this._pushTextDelta(text);
    }
    // THINK_REASONING
    it.buffer += delta;
    return this._drainInlineThink();
  }

  _drainInlineThink() {
    const split = splitLeadingThinkBlock(this.inlineThink.buffer);
    if (!split) return '';
    this.inlineThink.mode = THINK_TEXT;
    this.inlineThink.buffer = '';
    let out = '';
    if (split[0]) { out += this._pushReasoningDelta(split[0]); out += this._finalizeReasoning(); }
    if (split[1]) out += this._pushTextDelta(split[1]);
    return out;
  }

  _flushInlineThinkAtBoundary() {
    const it = this.inlineThink;
    if (it.mode === THINK_TEXT) return '';
    if (it.mode === THINK_DETECTING) {
      it.mode = THINK_TEXT;
      const text = it.buffer; it.buffer = '';
      if (!text) return '';
      return this._finalizeReasoning() + this._pushTextDelta(text);
    }
    // THINK_REASONING
    const buffered = it.buffer; it.buffer = ''; it.mode = THINK_TEXT;
    const split = splitLeadingThinkBlock(buffered);
    if (split) {
      let out = '';
      if (split[0]) { out += this._pushReasoningDelta(split[0]); out += this._finalizeReasoning(); }
      if (split[1]) out += this._pushTextDelta(split[1]);
      return out;
    }
    const reasoning = stripLeadingThinkOpenTag(buffered) ?? buffered;
    if (!reasoning) return '';
    return this._pushReasoningDelta(reasoning) + this._finalizeReasoning();
  }

  _pushReasoningDelta(delta) {
    let out = '';
    if (!this.reasoning.added) {
      const oi = this._nextIndex();
      const itemId = `rs_${this.responseId}`;
      this.reasoning.outputIndex = oi;
      this.reasoning.itemId = itemId;
      this.reasoning.added = true;
      out += sseEvent('response.output_item.added', {
        type: 'response.output_item.added', output_index: oi,
        item: { id: itemId, type: 'reasoning', status: 'in_progress', summary: [] },
      });
      out += sseEvent('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added', item_id: itemId, output_index: oi,
        summary_index: 0, part: { type: 'summary_text', text: '' },
      });
    }
    this.reasoning.text += delta;
    out += sseEvent('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta', item_id: this.reasoning.itemId,
      output_index: this.reasoning.outputIndex ?? 0, summary_index: 0, delta,
    });
    return out;
  }

  _pushTextDelta(delta) {
    let out = '';
    if (!this.text.added) {
      const oi = this._nextIndex();
      const itemId = messageIdFromResponseId(this.responseId);
      this.text.outputIndex = oi;
      this.text.itemId = itemId;
      this.text.added = true;
      out += sseEvent('response.output_item.added', {
        type: 'response.output_item.added', output_index: oi,
        item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      out += sseEvent('response.content_part.added', {
        type: 'response.content_part.added', item_id: itemId, output_index: oi,
        content_index: 0, part: { type: 'output_text', text: '', annotations: [] },
      });
    }
    this.text.text += delta;
    out += sseEvent('response.output_text.delta', {
      type: 'response.output_text.delta', item_id: this.text.itemId,
      output_index: this.text.outputIndex ?? 0, content_index: 0, delta,
    });
    return out;
  }

  _currentReasoningText() {
    const t = this.reasoning.text.trim();
    return t || null;
  }

  _pushToolCallDelta(toolCall, reasoning) {
    const chatIndex = (typeof toolCall.index === 'number') ? toolCall.index : 0;
    const idDelta = (toolCall.id && typeof toolCall.id === 'string') ? toolCall.id : null;
    const fn = toolCall.function || {};
    const nameDelta = (typeof fn.name === 'string') ? fn.name : null;
    const argsDelta = (typeof fn.arguments === 'string') ? fn.arguments : '';

    let state = this.tools.get(chatIndex);
    if (!state) {
      state = {
        outputIndex: null, itemId: '', callId: '', name: '', arguments: '',
        reasoningContent: '', added: false, done: false, freeform: false, toolSearch: false, inputEmittedLen: 0,
      };
      this.tools.set(chatIndex, state);
    }
    if (idDelta) state.callId = idDelta;
    if (nameDelta) {
      state.name = nameDelta;
      state.freeform = this._isFreeform(nameDelta);
      state.toolSearch = this._isToolSearch(nameDelta);
    }
    if (argsDelta) state.arguments += argsDelta;
    if (!state.reasoningContent && reasoning && reasoning.trim()) state.reasoningContent = reasoning.trim();

    let out = '';
    if (!state.added && (state.callId || state.name)) {
      const assigned = this._nextIndex();
      state.added = true;
      if (!state.callId) state.callId = `call_${chatIndex}`;
      if (!state.name) state.name = 'unknown_tool';
      state.freeform = this._isFreeform(state.name);
      state.toolSearch = this._isToolSearch(state.name);
      state.outputIndex = assigned;
      if (state.freeform) {
        state.itemId = `ctc_${state.callId}`;
        const item = this._buildToolItem(
          'in_progress', state.callId, state.name, '', state.reasoningContent || null);
        out += sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: assigned, item });
        // freeform：把已缓冲的 args 转成 input 增量
        const inputSoFar = freeformInputFromArgs(state.arguments);
        if (inputSoFar) {
          state.inputEmittedLen = inputSoFar.length;
          out += sseEvent('response.custom_tool_call_input.delta', {
            type: 'response.custom_tool_call_input.delta', item_id: state.itemId,
            output_index: assigned, delta: inputSoFar,
          });
        }
      } else {
        state.itemId = itemIdFromChatName(state.callId, state.name, this.toolContext);
        const item = this._buildToolItem(
          'in_progress', state.callId, state.name, '', state.reasoningContent || null);
        out += sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: assigned, item });
        if (state.arguments && !state.toolSearch) {
          out += sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta', item_id: state.itemId,
            output_index: assigned, delta: state.arguments,
          });
        }
      }
    } else if (state.added && argsDelta) {
      if (state.freeform) {
        // 流式 JSON 拼完整前不好做精确 delta；finalize 时再给完整 input
      } else if (!state.toolSearch) {
        out += sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', item_id: state.itemId,
          output_index: state.outputIndex ?? 0, delta: argsDelta,
        });
      }
    }
    return out;
  }

  _finalizeReasoning() {
    if (!this.reasoning.added || this.reasoning.done) return '';
    const oi = this.reasoning.outputIndex ?? 0;
    const text = this.reasoning.text;
    const item = { id: this.reasoning.itemId, type: 'reasoning', summary: [{ type: 'summary_text', text }] };
    this.outputItems.push([oi, item]);
    this.reasoning.done = true;
    return sseEvent('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done', item_id: this.reasoning.itemId,
        output_index: oi, summary_index: 0, text,
      })
      + sseEvent('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done', item_id: this.reasoning.itemId,
        output_index: oi, summary_index: 0, part: { type: 'summary_text', text },
      })
      + sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
  }

  _finalizeText() {
    if (!this.text.added || this.text.done) return '';
    const oi = this.text.outputIndex ?? 0;
    const item = {
      id: this.text.itemId, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: this.text.text, annotations: [] }],
    };
    this.outputItems.push([oi, item]);
    this.text.done = true;
    return sseEvent('response.output_text.done', {
        type: 'response.output_text.done', item_id: this.text.itemId,
        output_index: oi, content_index: 0, text: this.text.text,
      })
      + sseEvent('response.content_part.done', {
        type: 'response.content_part.done', item_id: this.text.itemId, output_index: oi,
        content_index: 0, part: { type: 'output_text', text: this.text.text, annotations: [] },
      })
      + sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
  }

  _finalizeTools() {
    let out = '';
    for (const [, state] of this.tools) {
      if (state.done) continue;
      // 空名工具对 Codex 无效：跳过，避免 silent completed 无工具
      if (!(state.name || '').trim()) {
        state.done = true;
        continue;
      }
      state.freeform = state.freeform || this._isFreeform(state.name);
      state.toolSearch = state.toolSearch || this._isToolSearch(state.name);
      if (!state.added) {
        const assigned = this._nextIndex();
        state.added = true;
        if (!state.callId) state.callId = `call_${assigned}`;
        state.outputIndex = assigned;
        state.itemId = state.freeform
          ? `ctc_${state.callId}`
          : itemIdFromChatName(state.callId, state.name, this.toolContext);
        const item = this._buildToolItem(
          'in_progress', state.callId, state.name, '', state.reasoningContent || null);
        out += sseEvent('response.output_item.added', { type: 'response.output_item.added', output_index: assigned, item });
      }
      const oi = state.outputIndex ?? 0;
      if (state.freeform) {
        const input = freeformInputFromArgs(state.arguments);
        // 补发尚未流式出去的 input 尾部
        if (input.length > (state.inputEmittedLen || 0)) {
          out += sseEvent('response.custom_tool_call_input.delta', {
            type: 'response.custom_tool_call_input.delta', item_id: state.itemId,
            output_index: oi, delta: input.slice(state.inputEmittedLen || 0),
          });
        }
        const item = this._buildToolItem(
          'completed', state.callId, state.name, state.arguments, state.reasoningContent || null);
        state.done = true;
        this.outputItems.push([oi, item]);
        out += sseEvent('response.custom_tool_call_input.done', {
          type: 'response.custom_tool_call_input.done', item_id: state.itemId, output_index: oi, input,
        });
        out += sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
      } else {
        const args = canonicalizeArgs(state.arguments);
        const item = this._buildToolItem(
          'completed', state.callId, state.name, args, state.reasoningContent || null);
        state.done = true;
        this.outputItems.push([oi, item]);
        if (!state.toolSearch) {
          out += sseEvent('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done', item_id: state.itemId, output_index: oi, arguments: args,
          });
        }
        out += sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: oi, item });
      }
    }
    return out;
  }

  _completedOutputItems() {
    return this.outputItems.slice().sort((a, b) => a[0] - b[0]).map(([, item]) => item);
  }

  finalize() {
    if (this.completed) return '';
    let out = this._ensureStarted();
    out += this._flushInlineThinkAtBoundary();
    out += this._finalizeReasoning();
    out += this._finalizeText();
    out += this._finalizeTools();
    const status = responseStatusFromFinish(this.finishReason);
    const response = this._baseResponse(status, this._completedOutputItems());
    if (status === 'incomplete') response.incomplete_details = { reason: 'max_output_tokens' };
    out += sseEvent('response.completed', { type: 'response.completed', response });
    this.completed = true;
    return out;
  }

  failedEvent(message, errorType) {
    this.completed = true;
    const error = { message };
    if (errorType) error.type = errorType;
    const response = this._baseResponse('failed', this._completedOutputItems());
    response.error = error;
    return sseEvent('response.failed', { type: 'response.failed', response });
  }

  // 给记账用：取已累计的 usage（Responses 形态，含 input/output/cached）。
  getUsage() { return this.latestUsage; }
  getResponseId() { return this.responseId; }
}

module.exports = {
  responsesToChat,
  chatToResponses,
  chatErrorToResponseError,
  ChatToResponsesStream,
  collectFreeformToolNames,
  buildCodexToolContext,
  summarizeResponsesTools,
  sanitizeResponsesInputIds,
  // 导出内部 helper 供单测
  _internal: {
    canonicalizeArgs, splitLeadingThinkBlock, extractReasoningFieldText,
    extractReasoningSummaryText, chatUsageToResponsesUsage, responseIdFromChatId,
    leadingThinkDecision, responsesToolToChat, freeformInputFromArgs,
    toolCallArgsFromItem, responseCustomToolCallItem, flattenNamespaceToolName, stripDefaultNamespacePrefix,
    normalizeFunctionParameters, CodexToolKind, KNOWN_CUSTOM_TOOL_NAMES,
    DEFAULT_FUNCTION_NAMESPACE,
  },
};
