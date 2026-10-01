// client/electron/local-gateway.js
'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const codexTransform = require('./codex-transform');
const reqRouter = require('./request-router');
const routingStrategies = require('./routing-strategies');
const jevShadow = require('./jev-shadow');
const cooldown = require('./gateway-cooldown');
const upstreamHints = require('./gateway-upstream-hints');
const { TIER_ROUTE_RE, parseRoute, STRATEGY_NAMES, SCOPE_NAMES, TIER_NAMES, SHARER_RE } = require('../shared/route-binding');
const _STRAT_SET = new Set(STRATEGY_NAMES || []);
const _SCOPE_SET = new Set(SCOPE_NAMES || []);
const _TIER_SET  = new Set(TIER_NAMES || []);
// 纯前缀 codec：整串都是已知 codec token(strategy/scope/tier/sharer)、无裸模型 → 当策略/过滤路由。
function parsePureCodec(str) {
  const segs = String(str == null ? '' : str).split(':').filter(Boolean);
  const isTok = (s) => _STRAT_SET.has(s) || _SCOPE_SET.has(s) || _TIER_SET.has(s) || (SHARER_RE && SHARER_RE.test(s));
  if (!segs.length || !segs.every(isTok)) return null;
  const out = { strategy: null, scope: null, tier: null, sharer: null };
  for (const s of segs) {
    if (_STRAT_SET.has(s)) out.strategy = s;
    else if (_SCOPE_SET.has(s)) out.scope = s;
    else if (_TIER_SET.has(s)) out.tier = s;
    else if (SHARER_RE.test(s)) out.sharer = s;
  }
  return out;
}

/** p2p 派发的路由指令 → X-TB-Route 头值（服务端按此做 auto 排序 / 钉分享者）。 */
function encodeRouteHeader(meta) {
  if (!meta) return '';
  const parts = [];
  if (meta.strategy) parts.push(`strategy=${meta.strategy}`);
  if (meta.sharer)   parts.push(`sharer=${meta.sharer}`);
  return parts.join(';');
}

/** 仅对 p2p provider 且带 _routeMeta 时注入 X-TB-Route 头（上游只收裸模型名）。 */
function applyP2pRouteHeader(headers, provider) {
  if (provider && provider.type === 'p2p' && provider._routeMeta) {
    const v = encodeRouteHeader(provider._routeMeta);
    if (v) headers['X-TB-Route'] = v;
  }
  return headers;
}
const oauth = require('./oauth');
const { withClaudeOAuthModels } = require('./claude-models');
const { estimateCost } = require('./pricing');
const { compressBody, compressionRatio } = require('./compressor');
const { handleTts }             = require('./handlers/ttsHandler');
const { handleImageGeneration, resolveImageRequestTimeoutMs } = require('./handlers/imageHandler');
const { handleEmbedding }       = require('./handlers/embeddingHandler');
const visionAssist = require('./vision-assist');

// 出站代理：境外供给源常需走本机代理才能连通。
// 优先级：provider.proxy > 全局 cfg.network_proxy > 环境变量(HTTPS_PROXY/HTTP_PROXY，遵守 NO_PROXY)。
// CLI 入口也可能不经 main.js，此处再确保系统代理已注入到环境变量。
try { require('../shared/inject-proxy-env').injectProxyEnv(); } catch {}
const { resolveOutboundProxyAgent } = require('../shared/outbound-proxy');
function resolveProxyAgent(provider, urlStr) {
  let networkProxy;
  try { networkProxy = _getConfig()?.network_proxy; } catch {}
  return resolveOutboundProxyAgent({ provider, urlStr, networkProxy });
}

// ── In-memory state ───────────────────────────────────────────────────────────

const LOG_MAX = 100;
const log = []; // circular, newest last

// 路由明细持久化：进程重启后 in-memory log 会清空，落盘后可恢复（与 stats DB 对齐）
const ROUTE_LOG_FILE = path.join(os.homedir(), '.tokenbank', 'gateway-route-log.json');
let _routeLogSaveTimer = null;
function _loadRouteLog() {
  try {
    const arr = JSON.parse(fs.readFileSync(ROUTE_LOG_FILE, 'utf8'));
    if (Array.isArray(arr)) for (const e of arr.slice(-LOG_MAX)) log.push(e);
  } catch {}
}
function _saveRouteLog() {
  // 节流：合并 1s 内的多次写入，避免每请求一次磁盘 IO
  if (_routeLogSaveTimer) return;
  _routeLogSaveTimer = setTimeout(() => {
    _routeLogSaveTimer = null;
    try {
      fs.mkdirSync(path.dirname(ROUTE_LOG_FILE), { recursive: true });
      fs.writeFileSync(ROUTE_LOG_FILE, JSON.stringify(log));
    } catch {}
  }, 1000);
}
_loadRouteLog();

// ── 压缩比数据记录 ───────────────────────────────────────────────────────────
// 每次无损压缩的 before/after/ratio 追加到 JSONL（best-effort，不阻塞热路径），
// 并维护累计聚合，便于回看整体压缩效果。
const COMPRESSION_LOG_FILE = path.join(os.homedir(), '.tokenbank', 'compression-log.jsonl');
const _compAgg = { count: 0, before: 0, after: 0 };
function _recordCompression(model, before, after) {
  _compAgg.count += 1; _compAgg.before += before; _compAgg.after += after;
  const rec = {
    ts: new Date().toISOString(), model: model || null,
    before, after, saved: before - after, ratio: +compressionRatio(before, after).toFixed(4),
  };
  try {
    fs.mkdirSync(path.dirname(COMPRESSION_LOG_FILE), { recursive: true });
    fs.appendFile(COMPRESSION_LOG_FILE, JSON.stringify(rec) + '\n', () => {});
  } catch {}
  return rec;
}
/** 累计压缩比（供调试/查看）。 */
function compressionStats() {
  return { ...(_compAgg), ratio: +compressionRatio(_compAgg.before, _compAgg.after).toFixed(4) };
}

// 调试日志：把完整请求/响应写到文件，便于排查 Claude Desktop 等客户端实际发了什么
const DEBUG_LOG_FILE = path.join(os.homedir(), 'tokenbank-gateway-debug.log');
function debugLog(label, data) {
  try {
    const line = `\n[${new Date().toISOString()}] ${label}\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}\n`;
    fs.appendFileSync(DEBUG_LOG_FILE, line);
  } catch {}
}

let _getConfig   = null;     // () => config object (set at start)
let _saveConfig  = null;     // (config) => void  写回配置（OAuth 刷新后回写凭证）
let _server      = null;
let _port        = 11430;
// 'llm-router-{id}' → { steps: [{model, tier, ...}], scene_name }
let _routerModelMap = {};
// P2P models with active workers (for UI display only, not used in routing)
let _peerModels   = new Set();
// Backend config: p2p providers forward here by default
let _backendUrl   = null;
let _cloudToken   = null;
// 登录 JWT（用量上报 /device/* 须用户登录，不能用 P2P API Key）
let _userJwt      = null;

// Stats recorder callback — set by main process via setStatsRecorder()
let _statsRecorder = null;
// Local stats module — set by main process via setLocalStats(), used for HTTP queries
let _localStats    = null;
// local-config 读取器（由 main 注入，供策略组调度查 policies[]）
let _getLocalConfig = null;

// ── Format conversion (Anthropic ↔ OpenAI) ───────────────────────────────────

// 纯文本 Code 模型（火山 Coding Plan 等不支持 image_url 输入）
const _TEXT_ONLY_MODELS = new Set([
  'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner',
  'glm-4.7', 'glm-4.6', 'glm-5', 'glm-5.1', 'glm-4-flash', 'glm-4-air',
  'doubao-seed-2.0-code', 'doubao-seed-code', 'doubao-seed-2.0-code-preview',
  'ark-code-latest', 'minimax-m2', 'minimax-m2.1', 'minimax-m2.5',
]);

function providerModelType(model, provider) {
  const list = provider?.models;
  if (!Array.isArray(list)) return null;
  for (const m of list) {
    const id = typeof m === 'string' ? m : (m.name || m.id);
    if (id === model) return typeof m === 'string' ? 'chat' : (m.type || 'chat');
  }
  return null;
}

function modelSupportsVision(model, provider) {
  // 优先用供给源模型条目的显式模态：type='vision'(图文)→支持；'chat'(文本)/'embedding'→不支持
  const list = provider?.models;
  if (Array.isArray(list)) {
    for (const m of list) {
      const id = typeof m === 'string' ? m : (m.name || m.id);
      if (id === model && typeof m === 'object') {
        if (m.type === 'vision' || (m.type === 'chat' && m.vision)) return true;
        if (m.type === 'chat' || m.type === 'text' || m.type === 'embedding') return false;
      }
    }
  }
  const t = providerModelType(model, provider);
  if (t === 'image') return true;
  if (t === 'chat') return false;
  return !_TEXT_ONLY_MODELS.has(String(model || '').toLowerCase());
}

/** Coding Plan 类端点（/coding/）常拒收 image_url → HTTP 400，识图助手应后置或跳过 */
function providerIsCodingPlanEndpoint(provider) {
  return /\/coding(\/|$)/i.test(String(provider?.base_url || ''));
}

// Anthropic image.source → OpenAI image_url
function anthropicImageSourceToUrl(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && source.data) {
    const mt = source.media_type || 'image/jpeg';
    return `data:${mt};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return source.url;
  return null;
}

function anthropicBlockToOaiPart(block, opts = {}) {
  if (!block || typeof block !== 'object') return null;
  const includeImages = opts.includeImages !== false;
  switch (block.type) {
    case 'text':
      return block.text != null ? { type: 'text', text: String(block.text) } : null;
    case 'image': {
      if (!includeImages) return { type: 'text', text: '[图片]' };
      const url = anthropicImageSourceToUrl(block.source);
      return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[图片]' };
    }
    // thinking 等 Anthropic 专有块：OAI 上游不识别，跳过
    case 'thinking':
    case 'redacted_thinking':
      return null;
    default:
      return null;
  }
}

function toolResultContentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text') return b.text || '';
      if (b?.type === 'image') return '[image]';
      return '';
    }).filter(Boolean).join('\n');
  }
  return content != null ? String(content) : '';
}

function anthropicSystemToOai(system) {
  if (system == null) return null;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text') return b.text || '';
      return '';
    }).filter(Boolean).join('\n');
  }
  return String(system);
}

function anthropicToolsToOai(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.map((t) => {
    if (!t || typeof t !== 'object') return null;
    if (t.type === 'custom') return null;
    return {
      type: 'function',
      function: {
        name: t.name || '',
        description: t.description || '',
        parameters: t.input_schema || t.parameters || { type: 'object', properties: {} },
      },
    };
  }).filter(Boolean);
  return out.length ? out : undefined;
}

function anthropicToolChoiceToOai(toolChoice) {
  if (toolChoice == null) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (typeof toolChoice !== 'object') return undefined;
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'auto' || toolChoice.type === 'none') return toolChoice.type;
  return undefined;
}

// 将 Anthropic messages 转为 OpenAI chat.completions 消息列表
function anthropicMessagesToOai(messages, opts = {}) {
  const out = [];
  for (const msg of messages || []) {
    if (!msg || !msg.role) continue;
    const { content, role } = msg;

    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      out.push({ role, content: content != null ? content : '' });
      continue;
    }

    if (role === 'assistant') {
      const textParts = [];
      const thinkParts = [];
      const toolCalls = [];
      for (const block of content) {
        if (block?.type === 'text' && block.text) textParts.push(block.text);
        // DeepSeek/Kimi thinking 模式：多轮必须把上一轮推理以 reasoning_content 回传
        else if (block?.type === 'thinking' && block.thinking) thinkParts.push(String(block.thinking));
        else if (block?.type === 'redacted_thinking') {
          // 无明文时仍占位，避免上游报「must be passed back」
          thinkParts.push(block.data ? String(block.data) : '(redacted)');
        } else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input != null ? block.input : {}),
            },
          });
        }
      }
      const oaiMsg = { role: 'assistant' };
      if (textParts.length) oaiMsg.content = textParts.join('');
      else if (!toolCalls.length) oaiMsg.content = '';
      else oaiMsg.content = null; // 纯工具调用：与 OpenAI 惯例一致
      if (toolCalls.length) oaiMsg.tool_calls = toolCalls;
      if (thinkParts.length) oaiMsg.reasoning_content = thinkParts.join('\n');
      out.push(oaiMsg);
      continue;
    }

    if (role === 'user') {
      const toolResults = [];
      const parts = [];
      for (const block of content) {
        if (block?.type === 'tool_result') {
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: toolResultContentToString(block.content),
          });
        } else {
          const p = anthropicBlockToOaiPart(block, opts);
          if (p) parts.push(p);
        }
      }
      out.push(...toolResults);
      if (parts.length === 1 && parts[0].type === 'text') out.push({ role: 'user', content: parts[0].text });
      else if (parts.length) out.push({ role: 'user', content: parts });
      continue;
    }

    if (role === 'system') {
      const text = content.map((b) => anthropicBlockToOaiPart(b, opts)).filter(Boolean).map((p) => p.text).join('\n');
      out.push({ role: 'system', content: text || '' });
      continue;
    }

    const parts = content.map((b) => anthropicBlockToOaiPart(b, opts)).filter(Boolean);
    if (parts.length === 1 && parts[0].type === 'text') out.push({ role, content: parts[0].text });
    else if (parts.length) out.push({ role, content: parts });
    else out.push({ role, content: '' });
  }
  return out;
}

// 兜底：把 OAI 消息里残留的 image_url 换成文本占位
function stripImagesFromOaiMessages(messages) {
  for (const msg of messages || []) {
    if (!Array.isArray(msg.content)) continue;
    const next = [];
    for (const part of msg.content) {
      if (part?.type === 'image_url') next.push({ type: 'text', text: '[图片]' });
      else if (part) next.push(part);
    }
    if (!next.length) msg.content = '';
    else if (next.length === 1 && next[0].type === 'text') msg.content = next[0].text;
    else msg.content = next;
  }
}

function anthropicToOpenai(body, opts = {}) {
  const oaiMessages = anthropicMessagesToOai(body.messages || [], opts);
  const sys = anthropicSystemToOai(body.system);
  const messages = (sys != null && sys !== '')
    ? [{ role: 'system', content: sys }, ...oaiMessages.filter((m) => m.role !== 'system')]
    : oaiMessages;

  const oai = { model: body.model || '', messages, stream: !!body.stream };
  if (body.max_tokens  != null) oai.max_tokens  = body.max_tokens;
  if (body.temperature != null) oai.temperature = body.temperature;
  if (body.top_p       != null) oai.top_p       = body.top_p;
  if (body.stop_sequences)      oai.stop        = body.stop_sequences;
  const tools = anthropicToolsToOai(body.tools);
  if (tools) oai.tools = tools;
  const toolChoice = anthropicToolChoiceToOai(body.tool_choice);
  if (toolChoice != null) oai.tool_choice = toolChoice;
  if (opts.includeImages === false) stripImagesFromOaiMessages(oai.messages);
  return oai;
}

// ── 反向 tool 转换 helper（OpenAI ⇄ Anthropic，响应/反向请求用）──────────────
function _toolId(prefix) { return prefix + Math.random().toString(36).slice(2, 14); }

// OpenAI finish_reason → Anthropic stop_reason
function oaiFinishToAnthStop(finish, hadTool) {
  if (finish === 'tool_calls' || hadTool) return 'tool_use';
  if (finish === 'length') return 'max_tokens';
  if (finish === 'stop' || finish == null) return 'end_turn';
  return finish;
}
// Anthropic stop_reason → OpenAI finish_reason
function anthStopToOaiFinish(stop, hadTool) {
  if (stop === 'tool_use' || hadTool) return 'tool_calls';
  if (stop === 'max_tokens') return 'length';
  if (stop === 'end_turn' || stop == null) return 'stop';
  return stop;
}

// OpenAI message.tool_calls（+ legacy function_call）→ Anthropic tool_use content blocks
function oaiToolCallsToAnthBlocks(msg) {
  const blocks = [];
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls
    : (msg.function_call ? [{ id: _toolId('call_'), function: msg.function_call }] : []);
  for (const tc of toolCalls) {
    const fn = tc.function || {};
    let input = {};
    try { input = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { input = {}; }
    blocks.push({ type: 'tool_use', id: tc.id || _toolId('toolu_'), name: fn.name || '', input });
  }
  return blocks;
}

// OpenAI tools → Anthropic tools
function oaiToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const t of tools) {
    const fn = (t && t.function) ? t.function : t;
    if (!fn || !fn.name) continue;
    out.push({ name: fn.name, description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} } });
  }
  return out.length ? out : undefined;
}
// OpenAI tool_choice → Anthropic tool_choice
function oaiToolChoiceToAnthropic(tc) {
  if (tc == null) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'auto')     return { type: 'auto' };
    if (tc === 'required') return { type: 'any' };
    if (tc === 'none')     return { type: 'none' };
    return undefined;
  }
  if (tc.type === 'function' && tc.function?.name) return { type: 'tool', name: tc.function.name };
  return undefined;
}

// OpenAI image_url part → Anthropic image block
function oaiImagePartToAnth(part) {
  const url = part.image_url?.url || '';
  const mm = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (mm) return { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } };
  if (url) return { type: 'image', source: { type: 'url', url } };
  return null;
}

// OpenAI messages（tool_calls / role:tool / 多模态）→ Anthropic messages
function oaiMessagesToAnthropic(messages) {
  const out = [];
  // tool_result 必须落在 user turn；连续 tool 结果合并进同一条 user message（保证 role 交替）
  const pushUserBlocks = (blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role: 'user', content: blocks });
  };
  for (const m of (messages || [])) {
    if (!m || m.role === 'system') continue; // system 单独抽到顶层 anth.system
    if (m.role === 'tool') {
      pushUserBlocks([{ type: 'tool_result', tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : toolResultContentToString(m.content) }]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      // OpenAI 客户端多轮：保留 reasoning_content → Anthropic thinking
      const reasoning = typeof m.reasoning_content === 'string' ? m.reasoning_content.trim() : '';
      if (reasoning) blocks.push({ type: 'thinking', thinking: reasoning });
      const text = typeof m.content === 'string' ? m.content : '';
      if (text) blocks.push({ type: 'text', text });
      blocks.push(...oaiToolCallsToAnthBlocks(m));
      out.push({ role: 'assistant', content: blocks.length ? blocks : (text || '') });
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push({ type: 'text', text: m.content });
      else out.push({ role: 'user', content: m.content });
    } else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const p of m.content) {
        if (!p) continue;
        if (p.type === 'text') blocks.push({ type: 'text', text: p.text || '' });
        else if (p.type === 'image_url') { const im = oaiImagePartToAnth(p); if (im) blocks.push(im); }
      }
      pushUserBlocks(blocks);
    }
  }
  return out;
}

function openaiToAnthropic(oai, model) {
  const choice = (oai.choices || [{}])[0];
  const msg    = choice.message || {};
  const finish = choice.finish_reason || 'stop';
  const usage  = oai.usage || {};
  const content = [];
  // 推理单独成 thinking 块，便于 Claude Code 多轮原样回传 → 再转成 reasoning_content
  const reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content.trim() : '';
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  const text = typeof msg.content === 'string' ? msg.content : '';
  if (text) content.push({ type: 'text', text });
  const toolBlocks = oaiToolCallsToAnthBlocks(msg);
  content.push(...toolBlocks);
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: oai.id || ('msg_' + Math.random().toString(36).slice(2, 26)),
    type: 'message', role: 'assistant',
    content,
    model,
    stop_reason: oaiFinishToAnthStop(finish, toolBlocks.length > 0),
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
  };
}

// Convert OpenAI request body → Anthropic request body
function oaiRequestToAnthropic(oai) {
  if (Number(oai.n) > 1) {
    throw Object.assign(new Error('Claude only supports n=1. Set SillyTavern "Multiple swipes per generation" to 1.'), {
      status: 400, apiErrorType: 'invalid_request_error',
    });
  }
  const sys  = (oai.messages || []).find(m => m.role === 'system');
  const anth = { model: oai.model, max_tokens: oai.max_tokens || 4096,
    messages: oaiMessagesToAnthropic(oai.messages || []) };
  if (sys) anth.system = typeof sys.content === 'string' ? sys.content : (sys.content?.[0]?.text || '');
  if (oai.temperature != null) anth.temperature = oai.temperature;
  if (oai.top_p       != null) anth.top_p       = oai.top_p;
  if (oai.stop) anth.stop_sequences = Array.isArray(oai.stop) ? oai.stop : [oai.stop];
  if (oai.stream) anth.stream = true;
  const tools = oaiToolsToAnthropic(oai.tools);
  if (tools) anth.tools = tools;
  const toolChoice = oaiToolChoiceToAnthropic(oai.tool_choice);
  if (toolChoice != null) anth.tool_choice = toolChoice;
  return anth;
}

// Convert Anthropic response body → OpenAI response body
function anthropicRespToOai(anth) {
  const blocks   = anth.content || [];
  const text     = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const toolUses = blocks.filter(b => b.type === 'tool_use');
  const toolCalls = toolUses.map(b => ({
    id: b.id || _toolId('call_'), type: 'function',
    function: { name: b.name || '', arguments: JSON.stringify(b.input != null ? b.input : {}) },
  }));
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const inTok  = anth.usage?.input_tokens  || 0;
  const outTok = anth.usage?.output_tokens || 0;
  return {
    id: anth.id || ('chatcmpl-' + Math.random().toString(36).slice(2)),
    object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: anth.model || '',
    choices: [{ index: 0, message,
      finish_reason: anthStopToOaiFinish(anth.stop_reason, toolCalls.length > 0), logprobs: null }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// ── Provider helpers ──────────────────────────────────────────────────────────

// 归一 base_url：去掉尾部斜杠 + 任意版本尾段（/v1 /v2 /v3 …）。
// 网关转发时用 base + '/' + apiVer(原url) + '/chat/completions'，
// 保留原版本号（如 /v3）而不是一律改成 /v1。
function normBase(url) {
  return (url || '').replace(/\/+$/, '').replace(/\/v\d+$/, '');
}
// 提取 base_url 末尾版本号，默认 v1。
function apiVer(url) {
  const m = (url || '').replace(/\/+$/, '').match(/\/(v\d+)$/);
  return m ? m[1] : 'v1';
}

// OAI 流式默认不返回 usage，需在请求体加 stream_options.include_usage=true 才会在末帧返回。
// 上游不识别此选项时会被忽略（不报错），所以默认注入是安全的。
function withUsageOption(body) {
  if (!body?.stream || body.stream_options) return body;
  return { ...body, stream_options: { include_usage: true } };
}

// All enabled providers, each with an effective models list.
// P2P providers: base_url/token come from backend config; models come from live _peerModels.
// 个人源：合并账户登记 + 刊例价覆盖的模型（与供给源页按模型视图一致）。
function enabledProviders() {
  if (!_getConfig) return [];
  const cfg = _getConfig();
  let providers = cfg.providers || [];
  try {
    const localCfg = _getLocalConfig?.() || null;
    if (localCfg) {
      providers = require('./billing-config').enrichProvidersFromAccounts(providers, localCfg);
    }
  } catch {}
  let gatewayIds = null;
  try {
    const localCfg = _getLocalConfig?.() || null;
    if (localCfg) {
      gatewayIds = new Set(require('./billing-config').resolveUserGatewayProviderIds(localCfg));
    }
  } catch {}
  return providers
    .filter(p => {
      // 显式关闭 → 不参与路由/模型列表；未写 enabled 视为启用（默认开）
      if (p.enabled === false) return false;
      // 未登记账户且未显式启用的付费源：不自动接入（避免 yaml 预填误启用）
      if (p.enabled == null && p.type === 'paid' && gatewayIds && !gatewayIds.has(p.id)) return false;
      // 社区 P2P：需后端地址 + 用户已登录（仅有残留转发 Key 不够）
      if (p.type === 'p2p') return !!_backendUrl && !!_userJwt;
      return !!p.base_url;
    })
    .map(p => {
      if (p.type === 'p2p') {
        return { ...p, enabled: true, base_url: _backendUrl, token: _cloudToken || p.token, models: [..._peerModels] };
      }
      // 与离线目录共享兜底：空清单补全，用户显式选择不覆盖。
      return withClaudeOAuthModels({ ...p, enabled: true });
    });
}

// 个人源模型名集合（路由 scope=personal 过滤用）：委托 billing-config 共享实现，
// 与主进程 collectPersonalModelsMain / 供给源页「按模型视图」同源，保证一致。
function collectPersonalModels() {
  try {
    const lc = _getLocalConfig?.() || null;
    if (!lc) return [];
    return require('./billing-config').collectPersonalModelNames(lc);
  } catch { return []; }
}

// Returns true if provider can serve the given model
// strict：P2P hop 贡献节点转发时，不接受「空 models 列表 = 任意模型」的兜底
function providerHasModel(provider, model, { strict = false } = {}) {
  const list = provider.models;
  // P2P 仅服务云端在线模型列表，不能因 models 为空就匹配任意模型（否则会抢在付费源之前回退）
  if (provider.type === 'p2p') {
    return _peerModels.size > 0 && _peerModels.has(model);
  }
  if (!Array.isArray(list) || list.length === 0) return strict ? false : true; // 无列表 = 接受任意（付费/免费自定义源）
  return list.some(m => (typeof m === 'string' ? m : m.name) === model);
}

// 源整体失效级错误（配额/鉴权/限流）：该源的其它模型也会同样失败，failover 时应跳过整个源，
// 避免把一个 429 的源的 5-6 个模型都试一遍白白拖几秒（导致 Codex 等客户端超时"没返回"）。
function isSourceLevelError(err) {
  const m = String((err && err.message) || '');
  return /HTTP_(429|401|403)\b/.test(m)
    || /quota|rate[\s_-]?limit|invalid[\s_-]*api[\s_-]*key|unauthorized|exceeded your current quota/i.test(m);
}

/** 从上游 4xx/5xx 响应体提取可读错误信息 */
function formatHttpError(statusCode, bodyStr) {
  let msg = `HTTP_${statusCode}`;
  if (!bodyStr) return msg;
  try {
    const j = JSON.parse(bodyStr);
    const em = j.error?.message || j.error?.detail || j.detail || (typeof j.error === 'string' ? j.error : '');
    if (em) return `${msg}: ${em}`;
  } catch {}
  const t = String(bodyStr).trim().slice(0, 240);
  return t ? `${msg}: ${t}` : msg;
}

function readProxyError(proxyRes, reject, traceCtx = null) {
  // 社区(p2p)派发失败时，服务端把「最后失败的 worker」放在 X-TB-Worker 头
  // （错误体里另有 error.worker_id / error.workers）——带回来供路由日志按 worker 归因。
  const workerId = proxyRes.headers['x-tb-worker'] || null;
  const statusCode = proxyRes.statusCode;
  const chunks = [];
  proxyRes.on('data', c => chunks.push(c));
  proxyRes.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const msg = formatHttpError(statusCode, body);
    if (traceCtx && statusCode >= 400) {
      try {
        require('./api-retry-trace').traceGatewayProviderFail({
          source: 'readProxyError',
          status: statusCode,
          message: msg,
          body_preview: body.slice(0, 400),
          worker_id: workerId,
          ...traceCtx,
        });
      } catch { /* ignore */ }
    }
    // 带上响应头：限流/配额重置时刻常在 Retry-After / *-ratelimit-*-reset 头里（供失败冷却精确解析）
    reject(Object.assign(new Error(msg), { status: statusCode, body, worker_id: workerId, headers: proxyRes.headers }));
  });
  proxyRes.on('error', () => {
    reject(Object.assign(new Error(`HTTP_${statusCode}`), { status: statusCode, worker_id: workerId, headers: proxyRes.headers }));
  });
}

/** 路由 failover 中间失败（不一定写入 route log） */
function traceRouteProviderFail(err, ctx) {
  try {
    require('./api-retry-trace').traceGatewayProviderFail({
      status: err?.status,
      message: err?.message,
      error_code: err?.code,
      worker_id: err?.worker_id,
      will_failover: !!ctx?.will_failover,
      ...ctx,
    });
  } catch { /* ignore */ }
}

/** 从 OpenAI 兼容 JSON（含 SSE data 行）提取 error */
function extractOpenaiPayloadError(obj) {
  if (!obj || typeof obj !== 'object' || !obj.error) return null;
  const err = obj.error;
  if (typeof err === 'string') return { message: err, type: 'api_error' };
  const message = err.message || err.detail || JSON.stringify(err).slice(0, 500);
  const type = err.type || err.code || 'api_error';
  return { message: String(message), type: String(type) };
}

/** OpenAI error.type → HTTP 状态码（与 server/api_errors.parse_worker_error 对齐） */
function openaiErrorTypeToStatus(type) {
  const t = String(type || '').toLowerCase();
  if (t === 'rate_limit_exceeded' || t === 'rate_limit_error') return 429;
  if (t === 'insufficient_credits') return 402;
  if (t === 'authentication_error') return 401;
  if (t === 'timeout' || t === 'timeout_error') return 504;
  if (t === 'service_unavailable') return 503;
  if (t === 'invalid_request_error') return 400;
  return 502;
}

function toAnthropicErrorType(openaiType) {
  const t = String(openaiType || '').toLowerCase();
  if (t === 'rate_limit_exceeded') return 'rate_limit_error';
  if (t === 'insufficient_credits') return 'billing_error';
  if (t === 'timeout') return 'timeout_error';
  return t === 'authentication_error' ? 'authentication_error' : 'api_error';
}

/** Anthropic /v1/messages 错误体 */
function writeAnthropicApiError(res, status, message, openaiType) {
  if (res.headersSent) return;
  res.writeHead(status, apiErrorHeaders(status));
  res.end(JSON.stringify({
    type: 'error',
    error: { type: toAnthropicErrorType(openaiType), message },
  }));
}

function rejectOpenaiPayloadError(reject, errObj, res, { anthropic = false } = {}) {
  const status = openaiErrorTypeToStatus(errObj.type);
  const msg = errObj.message;
  // 不在此处写 res：候选失败后 failover 循环可能还要试下一个源。提前 writeHead/end 会占用响应，
  // 令 res.headersSent=true 从而阻断 failover —— Anthropic /v1/messages 只试第一个候选就 502（agnes 等根本轮不到）。
  // 终端错误由外层 fail() 按协议（anthropic / openai / responses）统一输出。apiErrorType 透传给 fail() 复原格式。
  reject(Object.assign(new Error(`HTTP_${status}: ${msg}`), { status, apiErrorType: errObj.type }));
}

/** 路由失败时优先展示付费/本地源错误，避免 P2P 401 掩盖上游真实原因 */
function pickBestRouteError(errors) {
  if (!errors?.length) return null;
  const nonP2p = errors.find(e => e.id !== 'tokenbank-p2p');
  return (nonP2p || errors[0]).err;
}

/** 路由明细：各 provider 尝试失败原因（供 UI 点击展开） */
function serializeProviderErrors(errors) {
  if (!errors?.length) return undefined;
  return errors.map(({ id, err }) => ({
    provider: id,
    error: err?.message || String(err),
    code: err?.code || undefined,
    status: err?.status || undefined,
  }));
}

/** 社区 P2P 供给源 */
function isP2pProvider(provider) {
  return provider?.type === 'p2p' || provider?.id === 'tokenbank-p2p';
}

// 失败冷却键：个人源(直连)整源冷却（provider.id）；社区源(p2p)按 provider.id::model（池级），
// 若钉选了具体 worker(sharer) 则细到 provider.id::model::sharer（该 worker 独立冷却，不误伤池）。
function coolKey(provider, model, sharer) {
  if (!isP2pProvider(provider)) return provider.id;
  return sharer ? `${provider.id}::${model}::${sharer}` : `${provider.id}::${model}`;
}
// failover catch 里记冷却 + 首次进入冷却时打一条日志。三档策略：
//  - 个人源(直连)：你自己的账号，配额确定性、reset 权威 → noteFailure（reset 感知、可落盘、整源）。
//  - 社区源·钉选了具体 worker(sharer)：re-request 会再打同一个 worker，是确定性单账号目标，
//    和个人源同一套 noteFailure（有 reset 就冷到点、reset 远才落盘；key 稳定按 sharer，落盘也合法）。
//  - 社区源·未钉选的池路由：worker 由服务端动态挑、客户端左右不了，池的 reset 是单 worker 的不代表池 →
//    noteTransient（忽略 reset，只 45s 短兜底防连续空跑）。
function noteCooldown(provider, model, err, sharer) {
  const p2p = isP2pProvider(provider);
  const key = coolKey(provider, model, sharer);
  // 个人源 与 钉选 worker(有 sharer) 同走 noteFailure；仅未钉选的池走 noteTransient。
  const e = (p2p && !sharer) ? cooldown.noteTransient(key, err) : cooldown.noteFailure(key, err);
  if (e && e._new) {
    const until = new Date(e.until).toLocaleString();
    console.log(`[gateway-cooldown] ${key} 冷却至 ${until}（${e.reason}）→ 后续请求将下沉此候选`);
  }
  return e;
}

/** 构建同模型各源的速度表（分源 TTFT / 历史延迟 / policy 延迟） */
function buildSpeedByProvider(model, providers) {
  const map = {};
  let ps = null;
  try { ps = require('./provider-speed'); } catch {}
  let hist = null;
  try {
    if (_localStats?.queryModelProviderLatency) {
      hist = _localStats.queryModelProviderLatency(_localStats.sinceTsForDays?.(7) || (Math.floor(Date.now() / 1000) - 7 * 86400));
    }
  } catch {}
  const modelHist = hist && (hist[model] || hist[String(model || '').toLowerCase()]);
  let latMap = {};
  try { latMap = reqRouter.getLatencyMap?.() || {}; } catch {}
  for (const p of providers || []) {
    if (!p?.id) continue;
    let ms = ps ? ps.getProviderSpeedMs(model, p.id) : null;
    if (ms == null && modelHist?.[p.id]) {
      const h = modelHist[p.id];
      const v = Number(h.avg_ttft_ms ?? h.last_ttft_ms ?? h.last_latency_ms);
      if (Number.isFinite(v) && v > 0) ms = v;
    }
    if (ms == null && latMap[p.id] != null) ms = Number(latMap[p.id]);
    if (ms != null && Number.isFinite(ms)) map[p.id] = ms;
  }
  return map;
}

/**
 * 同模型多源默认序：订阅 → 免费 → 按量；同档比速度；再把冷却/慢源下沉。
 * 用于直连与场景步（非用户指定 provider 时）。
 */
function orderSameModelProviders(providers, model, sharer) {
  const list = Array.isArray(providers) ? providers.slice() : [];
  if (list.length <= 1) return list;
  const speedByProvider = buildSpeedByProvider(model, list);
  const ranked = routingStrategies.orderBillingThenSpeed(list, { speedByProvider });
  return cooldown.sink(ranked, (p) => coolKey(p, model, sharer));
}

/**
 * 成功后学习：相对同模型其它源明显更慢 → 短时下沉，避免下次仍先撞慢源。
 */
function learnSlowPeers(model, winner, result, peers, sharer) {
  if (!winner?.id || !model) return;
  const winnerMs = Number(result?.first_token_ms || result?.latency);
  if (!Number.isFinite(winnerMs) || winnerMs <= 0) return;
  const speedByProvider = buildSpeedByProvider(model, peers);
  speedByProvider[winner.id] = winnerMs;
  const known = Object.values(speedByProvider).filter((v) => Number.isFinite(v) && v > 0);
  const best = known.length ? Math.min(...known) : winnerMs;
  // 阈值：≥ max(最快×3, 15s) 视为慢源
  const slowFloor = Math.max(best * 3, 15_000);
  for (const p of peers || []) {
    if (!p?.id || p.id === winner.id) continue;
    const ms = speedByProvider[p.id];
    if (ms == null || !Number.isFinite(ms)) continue;
    if (ms < slowFloor) continue;
    const key = coolKey(p, model, sharer);
    const e = cooldown.noteSlow(key, undefined, `${Math.round(ms)}ms vs best ${Math.round(best)}ms`);
    if (e && e._new) {
      console.log(`[gateway-cooldown] ${key} 慢源学习下沉（${e.note}）→ 优先走更快供给源`);
    }
  }
  // 本次赢家自己若远慢于已知最佳，也下沉（罕见：排序数据陈旧时先撞上慢源）
  if (winnerMs >= slowFloor && best < winnerMs) {
    const key = coolKey(winner, model, sharer);
    const e = cooldown.noteSlow(key, undefined, `self ${Math.round(winnerMs)}ms`);
    if (e && e._new) {
      console.log(`[gateway-cooldown] ${key} 本次偏慢，下沉以便下次先试更快源`);
    }
  }
}

function recordProviderSpeed(model, provider, result, streaming) {
  try {
    require('./provider-speed').record(model, {
      firstTokenMs: result?.first_token_ms,
      outputTokens: result?.output_tokens,
      totalMs: result?.latency,
      streaming,
      providerId: provider?.id,
    });
  } catch {}
}

/** 用户是否在供给源页启用了社区分享网络 */
function isCommunityP2pEnabled() {
  if (!_getConfig) return true;
  // getConfig 可能返回 null（配置尚未就绪），需与 shared/community-p2p 一致做空值保护
  const cfg = _getConfig();
  const p = (cfg?.providers || []).find(x => x.id === 'tokenbank-p2p' || x.type === 'p2p');
  if (!p) return true;
  return p.enabled !== false;
}

/** P2P 首 token 超时（毫秒） */
const P2P_TTFT_MS = 20_000;

function p2pTtftError() {
  return Object.assign(new Error('P2P first token timeout (20s)'), { status: 504, code: 'timeout' });
}

/**
 * P2P 请求首 token 守卫：超过 20s 未收到首 token 则断开连接。
 * onFirstToken() 在收到首个有效输出时调用；dispose() 在请求正常结束时调用。
 */
function createP2pTtftGuard(provider, { proxyReq, res, isStream, reject }) {
  if (!isP2pProvider(provider)) {
    return { setProxyRes() {}, onFirstToken() {}, dispose() {} };
  }
  let proxyRes = null;
  let fired = false;
  let gotFirst = false;
  const errJson = JSON.stringify({ error: { message: 'P2P first token timeout (20s)', type: 'timeout' } });

  const fire = () => {
    if (fired || gotFirst) return;
    fired = true;
    try { proxyReq.destroy(); } catch {}
    try { proxyRes?.destroy?.(); } catch {}
    if (!res.headersSent) {
      res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(errJson);
    } else if (!res.writableEnded) {
      if (isStream) res.write(`data: ${errJson}\n\n`);
      res.end();
    }
    reject(p2pTtftError());
  };

  const timer = setTimeout(fire, P2P_TTFT_MS);
  return {
    setProxyRes(pr) { proxyRes = pr; },
    onFirstToken() {
      if (gotFirst) return;
      gotFirst = true;
      clearTimeout(timer);
    },
    dispose() { clearTimeout(timer); },
  };
}

/** 云端 P2P 积分不足（402 / Insufficient credits） */
function isP2pCreditsError(err) {
  if (!err) return false;
  if (err.status === 402) return true;
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('insufficient credits') || msg.includes('http_402');
}

function modelNotFoundError(model, tier) {
  const detail = `Model '${model}' is not available${tier ? ` (tier=${tier})` : ''}`;
  return Object.assign(new Error(detail), { status: 404, code: 'model_not_found' });
}

/** 客户端可重试错误的 Retry-After（秒）与 provider failover 间隔 */
const MIN_CLIENT_RETRY_AFTER_SEC = 3;
const MIN_FAILOVER_DELAY_MS = 2000;

function isRetryableHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 529;
}

function apiErrorHeaders(status) {
  const h = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };
  if (isRetryableHttpStatus(status)) h['Retry-After'] = String(MIN_CLIENT_RETRY_AFTER_SEC);
  return h;
}

function pauseBeforeNextProvider(err) {
  const st = resolveFailStatus(err);
  if (!isRetryableHttpStatus(st)) return Promise.resolve();
  return new Promise(r => setTimeout(r, MIN_FAILOVER_DELAY_MS));
}

/** 客户端错误优先透传 4xx/5xx，其余维持 502 */
function resolveFailStatus(err) {
  const s = err?.status;
  return (typeof s === 'number' && s >= 400 && s < 600) ? s : 502;
}

/** P2P 积分不足：直接 402 拒绝，不再尝试其他 provider */
function writeInsufficientCredits(res, isResponses) {
  const detail = 'Insufficient credits';
  const payload = isResponses
    ? codexTransform.chatErrorToResponseError({ error: { message: detail, type: 'insufficient_credits' } })
    : { error: { message: detail, type: 'insufficient_credits', code: 'insufficient_credits' } };
  if (!res.headersSent) {
    res.writeHead(402, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
  }
}

const P2P_API_KEY_HINT =
  'P2P relay API Key not configured. Open Community (社区算力) and set Gateway relay API Key.';
const P2P_LOGIN_HINT =
  'Login required to use community P2P. Please sign in and enable Community compute.';

/** 是否已配置 P2P 转发 Key（cloud_config.token 或 provider 自带 token） */
function hasP2pRelayKey(provider) {
  return !!String(_cloudToken || provider?.token || '').trim();
}

/** 是否已登录（JWT）；与转发 Key 分离，游客不得走社区 P2P */
function hasP2pUserLogin() {
  return !!String(_userJwt || '').trim();
}

/** P2P 鉴权失败（未配置 Key / 云端 401） */
/** 无可用 worker / 模型不存在（上游 404 或错误体含 no worker）——非鉴权错误 */
function isNoWorkerError(err) {
  if (!err) return false;
  if (err.code === 'model_not_found') return true;
  const hay = (String(err.message || '') + ' ' + String(err.body || '')).toLowerCase();
  return hay.includes('no worker') || hay.includes('model_not_found');
}

function isP2pApiKeyError(err) {
  if (!err) return false;
  if (err.code === 'p2p_api_key_required' || err.code === 'p2p_login_required') return true;
  // 「无可用 worker / 模型不存在」不是转发 Key 问题（否则会误报"未配置转发 Key"）
  if (isNoWorkerError(err)) return false;
  // 只在错误体确有鉴权失败信号时才判为转发 Key 问题；
  // 不再把任意 401 一律当成"未配置转发 Key"（no-worker 等非鉴权 401 会被误伤）。
  const hay = (String(err.message || '') + ' ' + String(err.body || '')).toLowerCase();
  return /missing api key|invalid or disabled api key|invalid api key|unauthorized|forbidden|api key required/.test(hay);
}

/** P2P 未配置转发 Key：401 拒绝，不降级到其他 provider */
function writeP2pApiKeyRequired(res, isResponses) {
  const detail = P2P_API_KEY_HINT;
  const payload = isResponses
    ? codexTransform.chatErrorToResponseError({ error: { message: detail, type: 'p2p_api_key_required' } })
    : { error: { message: detail, type: 'p2p_api_key_required', code: 'p2p_api_key_required' } };
  if (!res.headersSent) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
  }
}

/** P2P 未登录：401 拒绝 */
function writeP2pLoginRequired(res, isResponses) {
  const detail = P2P_LOGIN_HINT;
  const payload = isResponses
    ? codexTransform.chatErrorToResponseError({ error: { message: detail, type: 'p2p_login_required' } })
    : { error: { message: detail, type: 'p2p_login_required', code: 'p2p_login_required' } };
  if (!res.headersSent) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(payload));
  }
}

/**
 * 调用 P2P 前检查登录 + 转发 Key。
 * @returns {false|'login'|'api_key'} 已写入响应时返回原因，否则 false
 */
function rejectP2pIfUnconfigured(provider, res, isResponses) {
  if (!isP2pProvider(provider)) return false;
  if (!hasP2pUserLogin()) {
    writeP2pLoginRequired(res, isResponses);
    return 'login';
  }
  if (!hasP2pRelayKey(provider)) {
    writeP2pApiKeyRequired(res, isResponses);
    return 'api_key';
  }
  return false;
}

/** P2P 致命错误（积分不足 / 未配置 Key）：已写入响应则返回 true */
function handleP2pFatal(provider, err, res, isResponses) {
  if (!isP2pProvider(provider)) return false;
  if (isP2pCreditsError(err)) {
    writeInsufficientCredits(res, isResponses);
    return true;
  }
  if (isP2pApiKeyError(err)) {
    writeP2pApiKeyRequired(res, isResponses);
    return true;
  }
  return false;
}

function p2pAbortError(kind) {
  if (kind === 'login') {
    return Object.assign(new Error(P2P_LOGIN_HINT), { status: 401, code: 'p2p_login_required' });
  }
  if (kind === 'api_key') {
    return Object.assign(new Error(P2P_API_KEY_HINT), { status: 401, code: 'p2p_api_key_required' });
  }
  return Object.assign(new Error('Insufficient credits'), { status: 402, code: 'insufficient_credits' });
}

// ── HTTP proxy ────────────────────────────────────────────────────────────────

function proxyRequest(provider, reqPath, body, res) {
  return new Promise((resolve, reject) => {
    // 只对 OAI chat 路径注入 stream_options（Anthropic / Responses 上游不识别或语义不同）
    let sendBody = /\/chat\/completions$/.test(reqPath) ? withUsageOption(body) : body;
    let headers  = {
      'Content-Type':   'application/json',
      'Accept':         'text/event-stream, application/json',
    };
    // OAuth：注入鉴权头/体，并采用 applyAuth 返回的上游 base（Codex→chatgpt backend 等）
    let effectiveBase = provider.base_url;
    if (provider._oauth) {
      const ap = provider._oauth.applyAuth({ headers, body: sendBody, credentials: provider.credentials });
      headers = ap.headers; sendBody = ap.body;
      if (ap.baseUrl) effectiveBase = ap.baseUrl;
    } else if (provider.token) {
      if (providerApiFormat(provider) === 'anthropic') {
        headers['x-api-key'] = provider.token;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${provider.token}`;
      }
    }
    applyP2pRouteHeader(headers, provider);
    const bodyStr = JSON.stringify(sendBody);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);

    let u;
    let fullUrl;
    try {
      fullUrl = resolveUpstreamUrl(effectiveBase, reqPath);
      u = new URL(fullUrl);
    } catch { return reject(new Error('invalid_url')); }

    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method:  'POST',
      headers,
      timeout: 120_000,
      // 走环境变量 / network_proxy 出站代理（与 Gemini 路径一致）
      agent: resolveProxyAgent(provider, fullUrl),
    };

    const t0 = Date.now();
    let firstTokenMs = null;
    const isStream = !!body.stream;
    let ttftGuard = null;

    const proxyReq = mod.request(opts, (proxyRes) => {
      ttftGuard?.setProxyRes(proxyRes);
      if (proxyRes.statusCode >= 400) {
        ttftGuard?.dispose();
        return readProxyError(proxyRes, reject);
      }
      if (res.headersSent) {
        proxyRes.resume();
        return reject(new Error('headers_already_sent'));
      }
      res.writeHead(proxyRes.statusCode, {
        'Content-Type':          proxyRes.headers['content-type'] || 'text/event-stream',
        'Cache-Control':         'no-cache',
        'X-Accel-Buffering':     'no',
        'Access-Control-Allow-Origin': '*',
      });

      const status = proxyRes.statusCode;
      // 社区(p2p)派发成功时服务端回 X-TB-Worker=服务此请求的 worker_id；
      // 非 p2p 上游无此头 → null。供路由日志 join /public/network 显示「谁的节点」。
      const workerId = proxyRes.headers['x-tb-worker'] || null;
      if (isStream) {
        // Streaming: pipe to client while sniffing SSE events for usage + upstream message id.
        // Cache tokens may appear too (Anthropic message_start / message_delta).
        // Responses API：usage 在 response.completed / response.usage 事件的 response.usage。
        let usageIn = 0, usageOut = 0, cacheCreate = 0, cacheRead = 0, msgId = null;
        let sseBuf = '';
        let streamError = null;
        proxyRes.on('data', (chunk) => {
          res.write(chunk);
          sseBuf += chunk.toString();
          const lines = sseBuf.split('\n');
          sseBuf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const ds = line.slice(6).trim();
            if (!ds || ds === '[DONE]') continue;
            if (firstTokenMs === null) {
              firstTokenMs = Date.now() - t0;
              ttftGuard?.onFirstToken();
            }
            try {
              const obj = JSON.parse(ds);
              streamError = streamError || extractOpenaiPayloadError(obj)
                || (obj.type === 'response.failed' ? extractOpenaiPayloadError(obj.response) : null);
              // 上游响应 id：OpenAI chunk 顶层 id；Anthropic message_start；Responses response.id
              if (!msgId) msgId = obj.id || obj.message?.id || obj.response?.id || null;
              // Anthropic 缓存 token 分布在 message_start / message_delta
              const au = obj.message?.usage || (obj.type === 'message_delta' ? obj.usage : null);
              if (au) {
                if (au.input_tokens                != null) usageIn     = au.input_tokens;
                if (au.output_tokens               != null) usageOut    = au.output_tokens;
                if (au.cache_creation_input_tokens != null) cacheCreate = au.cache_creation_input_tokens;
                if (au.cache_read_input_tokens     != null) cacheRead   = au.cache_read_input_tokens;
              }
              const ru = obj.response?.usage || obj.usage;
              if (ru) {
                usageIn  = ru.prompt_tokens     || ru.input_tokens     || usageIn;
                usageOut = ru.completion_tokens || ru.output_tokens    || usageOut;
                if (ru.input_tokens_details?.cached_tokens != null) {
                  cacheRead = ru.input_tokens_details.cached_tokens;
                }
                if (ru.cache_read_input_tokens != null) cacheRead = ru.cache_read_input_tokens;
              }
            } catch {}
          }
        });
        const done = () => {
          ttftGuard?.dispose();
          return { provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: usageIn, output_tokens: usageOut, cache_create_tokens: cacheCreate, cache_read_tokens: cacheRead,
          message_id: msgId, status_code: status, worker_id: workerId };
        };
        proxyRes.on('end', () => {
          const result = done();
          res.end();
          if (streamError) return rejectOpenaiPayloadError(reject, streamError, res);
          resolve(result);
        });
        proxyRes.on('error', (err) => { ttftGuard?.dispose(); res.destroy(err); reject(err); });
      } else {
        // Non-streaming: buffer, forward, then parse usage + id from JSON
        const chunks = [];
        proxyRes.on('data', c => {
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - t0;
            ttftGuard?.onFirstToken();
          }
          chunks.push(c);
        });
        proxyRes.on('end', () => {
          ttftGuard?.dispose();
          const buf = Buffer.concat(chunks);
          res.end(buf);
          let usageIn = 0, usageOut = 0, cacheCreate = 0, cacheRead = 0, msgId = null;
          try {
            const obj = JSON.parse(buf.toString());
            msgId = obj.id || null; // OpenAI chatcmpl_xxx / Anthropic msg_xxx / Responses resp_xxx
            const u2  = obj.usage || {};
            usageIn  = u2.prompt_tokens     || u2.input_tokens                || 0;
            usageOut = u2.completion_tokens || u2.output_tokens               || 0;
            cacheCreate = u2.cache_creation_input_tokens || 0;
            cacheRead   = u2.cache_read_input_tokens
              || u2.input_tokens_details?.cached_tokens || 0;
          } catch {}
          resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: Date.now() - t0,
            input_tokens: usageIn, output_tokens: usageOut, cache_create_tokens: cacheCreate, cache_read_tokens: cacheRead,
            message_id: msgId, status_code: status, worker_id: workerId });
        });
        proxyRes.on('error', (err) => { ttftGuard?.dispose(); res.destroy(err); resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: Date.now() - t0, input_tokens: 0, output_tokens: 0, status_code: status, worker_id: workerId }); });
      }
    });

    ttftGuard = createP2pTtftGuard(provider, { proxyReq, res, isStream, reject });
    proxyReq.on('error',   (err) => { ttftGuard?.dispose(); reject(err); });
    proxyReq.on('timeout', () => { ttftGuard?.dispose(); proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Converted proxy: non-streaming Anthropic ─────────────────────────────────

function proxyConvertSync(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    };
    if (provider._oauth) Object.assign(headers, provider._oauth.applyAuth({ headers, credentials: provider.credentials }).headers);
    else if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;
    applyP2pRouteHeader(headers, provider);

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
      agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        // 捕获上游错误体（含 "no worker available" 等信息）→ 供错误分类识别，
        // 避免非鉴权 401（如无可用 worker）被误判成"未配置转发 Key"。
        return readProxyError(proxyRes, reject);
      }
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        try {
          const oaiResp = JSON.parse(Buffer.concat(chunks).toString());
          const oaiErr = extractOpenaiPayloadError(oaiResp);
          if (oaiErr) return rejectOpenaiPayloadError(reject, oaiErr, res, { anthropic: true });
          const resp    = JSON.stringify(openaiToAnthropic(oaiResp, model));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(resp);
          const latency = Date.now() - t0;
          const usage   = oaiResp?.usage || {};
          resolve({ provider: provider.id, latency, first_token_ms: latency,
            input_tokens:  usage.prompt_tokens     || usage.input_tokens     || 0,
            output_tokens: usage.completion_tokens || usage.output_tokens    || 0,
            message_id: oaiResp?.id || null, status_code: proxyRes.statusCode,
            worker_id: proxyRes.headers['x-tb-worker'] || null });
        } catch (err) { reject(err); }
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Converted proxy: streaming Anthropic ─────────────────────────────────────

function proxyConvertStream(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(withUsageOption(oaiBody));
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider._oauth) Object.assign(headers, provider._oauth.applyAuth({ headers, credentials: provider.credentials }).headers);
    else if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;
    applyP2pRouteHeader(headers, provider);

    const t0       = Date.now();
    let ttftGuard  = null;
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
      agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      ttftGuard?.setProxyRes(proxyRes);
      if (proxyRes.statusCode >= 400) {
        ttftGuard?.dispose();
        return readProxyError(proxyRes, reject);
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }

      const msgId = 'msg_' + Math.random().toString(36).slice(2, 26);
      let streamStarted = false;
      let settled = false;

      const settleStreamError = (oaiErr) => {
        if (settled) return;
        settled = true;
        ttftGuard?.dispose();
        rejectOpenaiPayloadError(reject, oaiErr, res, { anthropic: true });
      };

      const ensureStreamStarted = () => {
        if (streamStarted || settled) return;
        streamStarted = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
        });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: {
          id: msgId, type: 'message', role: 'assistant', content: [], model,
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
        }})}\n\n`);
        res.write('event: ping\ndata: {"type":"ping"}\n\n');
      };

      let buf = '', outputTokens = 0, stopReason = 'end_turn', firstTokenMs = null;
      let usageIn = 0, usageOut = 0; // from actual usage field in SSE, if present
      let hadToolCall = false;
      // dedup 用客户端实际收到的 id：本路径把上游 OpenAI 流重新包成 Anthropic SSE，
      // 客户端（如 Claude Code）写进 transcript 的是上面这个合成的 msgId，所以 dedup 键用它。

      // ── content block 状态机：Anthropic SSE 要求块顺序开/关，同一时刻仅一个块打开 ──
      // text → {type:text}+text_delta；tool_calls → {type:tool_use}+input_json_delta（增量 partial_json）。
      // 文本/工具块按出现顺序分配 index；切换块前先 content_block_stop 上一个。
      let nextBlockIndex = 0;
      let cur = null; // { kind:'text'|'tool'|'thinking', index, oaiIndex }
      const closeCur = () => {
        if (!cur) return;
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: cur.index })}\n\n`);
        cur = null;
      };
      const openText = () => {
        closeCur();
        const index = nextBlockIndex++;
        cur = { kind: 'text', index };
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start', index, content_block: { type: 'text', text: '' },
        })}\n\n`);
      };
      const openThinking = () => {
        closeCur();
        const index = nextBlockIndex++;
        cur = { kind: 'thinking', index };
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' },
        })}\n\n`);
      };
      const openTool = (oaiIndex, id, name) => {
        closeCur();
        const index = nextBlockIndex++;
        cur = { kind: 'tool', index, oaiIndex };
        res.write(`event: content_block_start\ndata: ${JSON.stringify({
          type: 'content_block_start', index,
          content_block: { type: 'tool_use', id: id || _toolId('toolu_'), name: name || '', input: {} },
        })}\n\n`);
      };

      proxyRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ds = line.slice(6).trim();
          if (ds === '[DONE]') continue;
          try {
            const c      = JSON.parse(ds);
            const oaiErr = extractOpenaiPayloadError(c);
            if (oaiErr) {
              try { proxyRes.destroy(); } catch {}
              settleStreamError(oaiErr);
              return;
            }
            const choice = (c.choices || [{}])[0];
            const delta  = choice.delta || {};
            // 推理与正文分流：reasoning → thinking 块，content → text 块（多轮才能回传）
            const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
            const text = typeof delta.content === 'string' ? delta.content : '';
            const finish = choice.finish_reason;
            if (reasoning) {
              ensureStreamStarted();
              if (firstTokenMs === null) {
                firstTokenMs = Date.now() - t0;
                ttftGuard?.onFirstToken();
              }
              outputTokens++;
              if (!cur || cur.kind !== 'thinking') openThinking();
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index: cur.index,
                delta: { type: 'thinking_delta', thinking: reasoning },
              })}\n\n`);
            }
            if (text) {
              ensureStreamStarted();
              if (firstTokenMs === null) {
                firstTokenMs = Date.now() - t0;
                ttftGuard?.onFirstToken();
              }
              outputTokens++;
              if (!cur || cur.kind !== 'text') openText();
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta', index: cur.index,
                delta: { type: 'text_delta', text },
              })}\n\n`);
            }
            // 工具调用增量：OpenAI delta.tool_calls[] 带 index/id/function.{name,arguments}
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                hadToolCall = true;
                ensureStreamStarted();
                if (firstTokenMs === null) {
                  firstTokenMs = Date.now() - t0;
                  ttftGuard?.onFirstToken();
                }
                const oaiIndex = (tc.index != null) ? tc.index : 0;
                if (!cur || cur.kind !== 'tool' || cur.oaiIndex !== oaiIndex) {
                  openTool(oaiIndex, tc.id, tc.function?.name);
                }
                const args = tc.function?.arguments;
                if (args) {
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta', index: cur.index,
                    delta: { type: 'input_json_delta', partial_json: args },
                  })}\n\n`);
                }
              }
            }
            if (finish) {
              stopReason = finish === 'tool_calls' ? 'tool_use'
                : finish === 'stop' ? 'end_turn'
                : finish === 'length' ? 'max_tokens' : finish;
            }
            // Capture actual usage if provider includes it (e.g. final chunk with usage)
            if (c.usage) {
              usageIn  = c.usage.prompt_tokens     || c.usage.input_tokens     || usageIn;
              usageOut = c.usage.completion_tokens || c.usage.output_tokens    || usageOut;
            }
          } catch {}
        }
      });

      proxyRes.on('end', () => {
        ttftGuard?.dispose();
        if (settled) return;
        if (!streamStarted) {
          settleStreamError({ message: 'Empty response from upstream', type: 'api_error' });
          return;
        }
        // Prefer actual usage from provider; fall back to manual output token count
        const finalOut = usageOut || outputTokens;
        if (hadToolCall && stopReason === 'end_turn') stopReason = 'tool_use';
        closeCur();
        res.write(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: finalOut },
        })}\n\n`);
        res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        res.end();
        resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0, input_tokens: usageIn, output_tokens: finalOut, message_id: msgId, status_code: proxyRes.statusCode, worker_id: proxyRes.headers['x-tb-worker'] || null });
      });

      proxyRes.on('error', (err) => { ttftGuard?.dispose(); res.destroy(err); resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0, input_tokens: usageIn, output_tokens: usageOut || outputTokens, message_id: msgId, status_code: proxyRes.statusCode, worker_id: proxyRes.headers['x-tb-worker'] || null }); });
    });
    ttftGuard = createP2pTtftGuard(provider, { proxyReq, res, isStream: true, reject });
    proxyReq.on('error', (err) => { ttftGuard?.dispose(); reject(err); });
    proxyReq.on('timeout', () => { ttftGuard?.dispose(); proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── OpenAI client → Anthropic provider: format bridge ───────────────────────

function proxyAnthropicSync(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    let anthBody    = oaiRequestToAnthropic({ ...oaiBody, stream: false });
    const base      = normBase(provider.base_url);
    const fullUrl   = base + '/v1/messages';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    let headers   = {
      'Content-Type':      'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (provider._oauth) {
      const ap = provider._oauth.applyAuth({ headers, body: anthBody, credentials: provider.credentials });
      headers = ap.headers; anthBody = ap.body;
    } else if (provider.token) headers['x-api-key'] = provider.token;
    const bodyStr = JSON.stringify(anthBody);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
      agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        return readProxyError(proxyRes, reject);
      }
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        try {
          const anthResp = JSON.parse(Buffer.concat(chunks).toString());
          const oaiResp  = anthropicRespToOai(anthResp);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(oaiResp));
          const latency = Date.now() - t0;
          resolve({ provider: provider.id, latency, first_token_ms: latency,
            input_tokens:        anthResp.usage?.input_tokens                || 0,
            output_tokens:       anthResp.usage?.output_tokens               || 0,
            cache_create_tokens: anthResp.usage?.cache_creation_input_tokens || 0,
            cache_read_tokens:   anthResp.usage?.cache_read_input_tokens     || 0,
            message_id: anthResp.id || null, status_code: proxyRes.statusCode });
        } catch (err) { reject(err); }
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

function proxyAnthropicStream(provider, oaiBody, model, res) {
  return new Promise((resolve, reject) => {
    let anthBody    = oaiRequestToAnthropic({ ...oaiBody, stream: true });
    const base      = normBase(provider.base_url);
    const fullUrl   = base + '/v1/messages';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    let headers   = {
      'Content-Type':      'application/json',
      'anthropic-version': '2023-06-01',
      'Accept':            'text/event-stream',
    };
    if (provider._oauth) {
      const ap = provider._oauth.applyAuth({ headers, body: anthBody, credentials: provider.credentials });
      headers = ap.headers; anthBody = ap.body;
    } else if (provider.token) headers['x-api-key'] = provider.token;
    const bodyStr = JSON.stringify(anthBody);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const t0       = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
      agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        return readProxyError(proxyRes, reject);
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
      });

      const chatId  = 'chatcmpl-' + Math.random().toString(36).slice(2, 26);
      const created = Math.floor(Date.now() / 1000);
      // Send role delta
      res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);

      let buf = '', usageIn = 0, usageOut = 0, cacheCreate = 0, cacheRead = 0, firstTokenMs = null, msgId = null;
      let stopReason = 'stop';
      let streamError = null;
      // Anthropic content block index → OpenAI tool_calls index（仅工具块计数，文本块不占）
      const toolIndexByBlock = new Map();
      let toolCounter = 0;

      proxyRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ds = line.slice(6).trim();
          if (!ds || ds === '[DONE]') continue;
          try {
            const evt = JSON.parse(ds);
            if (streamError) continue;
            const error = extractOpenaiPayloadError(evt);
            if (error) {
              streamError = error;
              res.write(`data: ${JSON.stringify({ error })}\n\n`);
              continue;
            }
            if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
              // 工具块起始：分配 OpenAI tool index，先发带 id+name 的 tool_calls 帧
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              const oaiIndex = toolCounter++;
              toolIndexByBlock.set(evt.index, oaiIndex);
              res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: oaiIndex, id: evt.content_block.id, type: 'function', function: { name: evt.content_block.name || '', arguments: '' } }] }, finish_reason: null }] })}\n\n`);
            } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }] })}\n\n`);
            } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
              // 工具参数增量：partial_json → OpenAI tool_calls[].function.arguments 增量
              const oaiIndex = toolIndexByBlock.has(evt.index) ? toolIndexByBlock.get(evt.index) : 0;
              const pj = evt.delta.partial_json || '';
              if (pj) res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: oaiIndex, function: { arguments: pj } }] }, finish_reason: null }] })}\n\n`);
            } else if (evt.type === 'message_start') {
              msgId       = evt.message?.id                                 || msgId;
              usageIn     = evt.message?.usage?.input_tokens                || 0;
              cacheCreate = evt.message?.usage?.cache_creation_input_tokens || 0;
              cacheRead   = evt.message?.usage?.cache_read_input_tokens     || 0;
            } else if (evt.type === 'message_delta') {
              const sr = evt.delta?.stop_reason;
              if (sr) stopReason = sr === 'tool_use' ? 'tool_calls' : sr === 'end_turn' ? 'stop' : sr === 'max_tokens' ? 'length' : sr;
              if (evt.usage?.output_tokens               != null) usageOut    = evt.usage.output_tokens;
              if (evt.usage?.cache_creation_input_tokens != null) cacheCreate = evt.usage.cache_creation_input_tokens;
              if (evt.usage?.cache_read_input_tokens     != null) cacheRead   = evt.usage.cache_read_input_tokens;
            }
          } catch {}
        }
      });

      proxyRes.on('end', () => {
        if (streamError) {
          res.end();
          return rejectOpenaiPayloadError(reject, streamError, res);
        }
        res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: stopReason }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: usageIn, output_tokens: usageOut, cache_create_tokens: cacheCreate, cache_read_tokens: cacheRead,
          message_id: msgId, status_code: proxyRes.statusCode });
      });

      proxyRes.on('error', (err) => { res.destroy(err); reject(err); });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Provider API format detection ────────────────────────────────────────────
// OAuth's native protocol wins; other sources honor explicit api_format, with
// URL heuristics only as a fallback for older providers.
function providerApiFormat(provider) {
  // Claude OAuth uses the native Messages API, even when an old account was
  // persisted with the generic OpenAI default. Do not override API-key sources.
  if (provider.auth_type === 'oauth' && provider.oauth_provider === 'claude') return 'anthropic';
  if (provider.api_format) return provider.api_format;
  if (/anthropic/i.test(provider.base_url || '')) return 'anthropic';
  if (/generativelanguage\.googleapis\.com/i.test(provider.base_url || '')) return 'gemini';
  return 'openai';
}

/**
 * 上游是否原生支持 OpenAI Responses API（/v1/responses 或 Codex backend /responses）。
 * 支持时网关对 Codex 客户端请求做透传（保留 previous_response_id 等），否则降级转 Chat。
 */
function providerSupportsResponses(provider) {
  if (!provider) return false;
  if (provider.supports_responses === false) return false;
  if (provider.supports_responses === true) return true;
  if (provider.api_format === 'responses') return true;
  // Codex ChatGPT 订阅 OAuth：上游 chatgpt.com/backend-api/codex 本身就是 Responses
  if (provider.auth_type === 'oauth' && provider.oauth_provider === 'codex') return true;
  // 官方 OpenAI API
  if (/api\.openai\.com/i.test(String(provider.base_url || ''))) return true;
  if (provider.id === 'openai' || provider.id === 'codex') return true;
  return false;
}

/** 拼上游 URL：ChatGPT Codex backend 的 Responses 无 /v1 前缀。 */
function resolveUpstreamUrl(baseUrl, reqPath) {
  const base = normBase(baseUrl);
  const path = String(reqPath || '');
  if (/chatgpt\.com\/backend-api\/codex$/i.test(base) && /\/responses\/?$/.test(path)) {
    return base + '/responses';
  }
  const ver = apiVer(baseUrl);
  return base + path.replace(/^\/v1\//, `/${ver}/`);
}

// ── Gemini (generateContent) ⇄ OpenAI ───────────────────────────────────────
// Google Gemini 用 generateContent / streamGenerateContent，认证头 x-goog-api-key，
// 请求体/响应体与 OpenAI 完全不同。这里做 OpenAI ⇄ Gemini 双向转换（与 server/virtual_worker.py 对齐）。
function isGeminiProvider(provider) {
  return providerApiFormat(provider) === 'gemini' || provider.api_style === 'gemini';
}

// gemini base：用户 base_url 已含 /v1beta 时不重复拼接
function geminiBase(rawBaseUrl) {
  const raw = (rawBaseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  return /\/v1beta/i.test(raw) ? raw : raw + '/v1beta';
}

// Gemini thought_signature 校验绕过常量（thoughtSignature 位于 part 层级，与 functionCall 同级）
const GEMINI_DUMMY_SIG = 'skip_thought_signature_validator';

// Gemini 不支持部分 JSON Schema 元字段，递归清洗（否则 functionDeclarations 会被上游 400）。
// 移植自 ccx types/gemini.go sanitizeGeminiSchemaNode：删元字段、const→enum、
// properties 的直接子键是用户参数名（不剥离 schema 关键字）。
function sanitizeGeminiSchema(v, insideProperties = false) {
  if (Array.isArray(v)) return v.map(x => sanitizeGeminiSchema(x, false));
  if (v && typeof v === 'object') {
    const out = {};
    let constValue, hasConst = false;
    for (const [k, val] of Object.entries(v)) {
      if (insideProperties) { out[k] = sanitizeGeminiSchema(val, false); continue; }
      switch (k) {
        case '$schema': case 'title': case 'examples': case 'additionalProperties':
        case 'propertyNames': case 'exclusiveMinimum': case 'exclusiveMaximum':
          continue;
        case 'const': constValue = val; hasConst = true; continue;
        default: out[k] = sanitizeGeminiSchema(val, k === 'properties');
      }
    }
    if (hasConst && out.enum === undefined) out.enum = [sanitizeGeminiSchema(constValue, false)];
    return out;
  }
  return v;
}

// OpenAI tools → Gemini functionDeclarations
function oaiToolsToGemini(tools) {
  if (!Array.isArray(tools)) return undefined;
  const decls = [];
  for (const t of tools) {
    const fn = (t && t.function) ? t.function : t;
    if (!fn || !fn.name) continue;
    decls.push({ name: fn.name, description: fn.description || '',
      parameters: sanitizeGeminiSchema(fn.parameters || { type: 'object', properties: {} }) });
  }
  return decls.length ? [{ functionDeclarations: decls }] : undefined;
}

// OpenAI tool_choice → Gemini toolConfig.functionCallingConfig
function oaiToolChoiceToGemini(tc) {
  if (tc == null) return undefined;
  if (typeof tc === 'string') {
    if (tc === 'auto')     return { functionCallingConfig: { mode: 'AUTO' } };
    if (tc === 'required') return { functionCallingConfig: { mode: 'ANY' } };
    if (tc === 'none')     return { functionCallingConfig: { mode: 'NONE' } };
    return undefined;
  }
  if (tc.type === 'function' && tc.function?.name) {
    return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.function.name] } };
  }
  return undefined;
}

// Gemini functionResponse.response 必须是对象：字符串包成 {result}
function geminiFnResponsePayload(content) {
  if (content == null) return { result: '' };
  if (typeof content === 'string') return { result: content };
  if (typeof content === 'object') return content;
  return { result: String(content) };
}

// OpenAI message content（string | parts[]）→ Gemini parts（text + inlineData 图片）
function oaiContentToGeminiParts(content) {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text') { if (p.text) parts.push({ text: p.text }); }
    else if (p.type === 'image_url') {
      const url = p.image_url?.url || '';
      const mm = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (mm) parts.push({ inlineData: { mimeType: mm[1], data: mm[2] } });
    }
  }
  return parts;
}

// OpenAI chat body → Gemini generateContent body（含 tool calling + 多模态）
function oaiToGeminiBody(oai) {
  const systemParts = [];
  const contents = [];
  for (const m of (oai.messages || [])) {
    const role = m.role || 'user';
    if (role === 'system') {
      for (const p of oaiContentToGeminiParts(m.content)) if (p.text) systemParts.push({ text: p.text });
      continue;
    }
    if (role === 'tool') {
      // 工具结果 → functionResponse（user 角色；name 用 tool_call_id 做关联键）
      contents.push({ role: 'user', parts: [{ functionResponse: {
        name: m.tool_call_id, response: geminiFnResponsePayload(m.content) } }] });
      continue;
    }
    if (role === 'assistant') {
      const parts = oaiContentToGeminiParts(m.content);
      const tcs = m.tool_calls || (m.function_call ? [{ function: m.function_call }] : []);
      for (const tc of tcs) {
        const fn = tc.function || {};
        let args = {};
        try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch { args = {}; }
        // thoughtSignature 与 functionCall 同级（part 层级）
        parts.push({ functionCall: { name: fn.name, args }, thoughtSignature: GEMINI_DUMMY_SIG });
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    const parts = oaiContentToGeminiParts(m.content);
    contents.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] });
  }
  const body = { contents };
  if (systemParts.length) body.systemInstruction = { parts: systemParts };
  const tools = oaiToolsToGemini(oai.tools);
  if (tools) body.tools = tools;
  const toolCfg = oaiToolChoiceToGemini(oai.tool_choice);
  if (toolCfg) body.toolConfig = toolCfg;
  const gen = {};
  if (oai.max_tokens != null) gen.maxOutputTokens = oai.max_tokens;
  if (oai.temperature != null) gen.temperature = oai.temperature;
  if (oai.top_p != null) gen.topP = oai.top_p;
  if (oai.stop) gen.stopSequences = Array.isArray(oai.stop) ? oai.stop : [oai.stop];
  if (Object.keys(gen).length) body.generationConfig = gen;
  return body;
}

// 提取 Gemini 响应的 text + functionCall（→ OpenAI tool_calls）。
// Gemini 用 functionCall.name 当关联键（无独立 call_id），args 是对象（需 JSON.stringify）。
function geminiExtractParts(data) {
  let text = '';
  const toolCalls = [];
  for (const cand of (data.candidates || [])) {
    for (const part of (cand.content?.parts || [])) {
      if (part.thought) continue; // 跳过 thinking part
      if (typeof part.text === 'string') text += part.text;
      if (part.functionCall) {
        const fc = part.functionCall;
        toolCalls.push({ id: fc.name, type: 'function',
          function: { name: fc.name, arguments: JSON.stringify(fc.args || {}) } });
      }
    }
  }
  return { text, toolCalls };
}

// Gemini 非流式：generateContent → OpenAI json / Anthropic json（按客户端协议）
function proxyGeminiSync(provider, oaiBody, model, res, outAnthropic) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${geminiBase(provider.base_url)}/models/${model}:generateContent`;
    let u; try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }
    const mod = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiToGeminiBody(oaiBody));
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'x-goog-api-key': provider.token || '',
    };
    const t0 = Date.now();
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000, agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        if (proxyRes.statusCode >= 400) {
          debugLog('proxyGeminiSync 上游错误', { status: proxyRes.statusCode, body: raw.slice(0, 400) });
          return reject(Object.assign(new Error(formatHttpError(proxyRes.statusCode, raw)), { status: proxyRes.statusCode, body: raw }));
        }
        let data; try { data = JSON.parse(raw); } catch (err) { return reject(err); }
        const { text, toolCalls } = geminiExtractParts(data);
        const um = data.usageMetadata || {};
        const inTok = um.promptTokenCount || 0, outTok = um.candidatesTokenCount || 0;
        const latency = Date.now() - t0;
        const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
        if (toolCalls.length) message.tool_calls = toolCalls;
        const oaiResp = {
          id: 'chatcmpl-' + Math.random().toString(36).slice(2, 12),
          object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
        };
        const out = outAnthropic ? openaiToAnthropic(oaiResp, model) : oaiResp;
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(out));
        resolve({ provider: provider.id, latency, first_token_ms: latency,
          input_tokens: inTok, output_tokens: outTok, message_id: oaiResp.id, status_code: 200 });
      });
      proxyRes.on('error', reject);
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// Gemini 流式：streamGenerateContent?alt=sse → 客户端 SSE（OpenAI 或 Anthropic 格式）
function proxyGeminiStream(provider, oaiBody, model, res, outAnthropic) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${geminiBase(provider.base_url)}/models/${model}:streamGenerateContent?alt=sse`;
    let u; try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }
    const mod = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(oaiToGeminiBody(oaiBody));
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept': 'text/event-stream',
      'x-goog-api-key': provider.token || '',
    };
    const t0 = Date.now();
    let firstTokenMs = null;
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000, agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const ec = [];
        proxyRes.on('data', c => ec.push(c));
        proxyRes.on('end', () => {
          const errBody = Buffer.concat(ec).toString().slice(0, 400);
          debugLog('proxyGeminiStream 上游错误', { status: proxyRes.statusCode, body: errBody });
          reject(Object.assign(new Error(formatHttpError(proxyRes.statusCode, errBody)), { status: proxyRes.statusCode, body: errBody }));
        });
        proxyRes.on('error', () => reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode })));
        return;
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });

      const chatId = 'chatcmpl-' + Math.random().toString(36).slice(2, 26);
      const msgId  = 'msg_' + Math.random().toString(36).slice(2, 26);
      const created = Math.floor(Date.now() / 1000);
      let usageIn = 0, usageOut = 0, stopReason = 'end_turn';

      // 开场事件
      if (outAnthropic) {
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: {
          id: msgId, type: 'message', role: 'assistant', content: [], model,
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`);
      }

      const emitText = (text) => {
        if (!text) return;
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        if (outAnthropic) {
          res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
        }
      };

      let buf = '';
      // Gemini 流式里 functionCall 一次性完整出现（非增量），先缓存，流末统一发工具帧。
      const pendingTools = [];
      proxyRes.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const ds = line.slice(5).replace(/^ /, '').trim();
          if (!ds || ds === '[DONE]') continue;
          let obj; try { obj = JSON.parse(ds); } catch { continue; }
          for (const cand of (obj.candidates || [])) {
            for (const part of (cand.content?.parts || [])) {
              if (part.thought) continue;
              if (typeof part.text === 'string') emitText(part.text);
              if (part.functionCall) {
                if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
                pendingTools.push({ name: part.functionCall.name, args: part.functionCall.args || {} });
              }
            }
            if (cand.finishReason) stopReason = (cand.finishReason === 'STOP' || cand.finishReason === 'END_TURN') ? 'end_turn' : 'stop';
          }
          const um = obj.usageMetadata;
          if (um) { usageIn = um.promptTokenCount || usageIn; usageOut = um.candidatesTokenCount || usageOut; }
        }
      });

      const done = () => ({ provider: provider.id, latency: Date.now() - t0,
        first_token_ms: firstTokenMs ?? Date.now() - t0, input_tokens: usageIn, output_tokens: usageOut,
        message_id: outAnthropic ? msgId : chatId, status_code: 200 });

      proxyRes.on('end', () => {
        if (outAnthropic) {
          // 文本块（index 0）收尾；工具块从 index 1 起，逐个 start→input_json_delta→stop
          res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
          let bi = 1;
          for (const tcall of pendingTools) {
            res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: bi, content_block: { type: 'tool_use', id: tcall.name, name: tcall.name, input: {} } })}\n\n`);
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: bi, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tcall.args || {}) } })}\n\n`);
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: bi })}\n\n`);
            bi++;
          }
          const sr = pendingTools.length ? 'tool_use' : stopReason;
          res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: sr, stop_sequence: null }, usage: { output_tokens: usageOut } })}\n\n`);
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        } else {
          let ti = 0;
          for (const tcall of pendingTools) {
            res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: ti, id: tcall.name, type: 'function', function: { name: tcall.name, arguments: JSON.stringify(tcall.args || {}) } }] }, finish_reason: null }] })}\n\n`);
            ti++;
          }
          res.write(`data: ${JSON.stringify({ id: chatId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: pendingTools.length ? 'tool_calls' : 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
        }
        res.end();
        resolve(done());
      });
      proxyRes.on('error', (err) => { res.destroy(err); resolve(done()); });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── P2P: always stream from backend, buffer to sync response for non-streaming clients ──

function proxyP2PSync(provider, oaiBody, model, res) {
  // Sends stream:true to backend regardless of client request; assembles & returns Anthropic JSON
  return new Promise((resolve, reject) => {
    const streamBody = withUsageOption({ ...oaiBody, stream: true });
    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(streamBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider._oauth) Object.assign(headers, provider._oauth.applyAuth({ headers, credentials: provider.credentials }).headers);
    else if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;
    applyP2pRouteHeader(headers, provider);

    const t0 = Date.now();
    let ttftGuard = null;
    const proxyReq = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''),
      method: 'POST', headers, timeout: 120_000,
      agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      ttftGuard?.setProxyRes(proxyRes);
      if (proxyRes.statusCode >= 400) {
        ttftGuard?.dispose();
        const errChunks = [];
        proxyRes.on('data', c => errChunks.push(c));
        proxyRes.on('end', () => {
          const body = Buffer.concat(errChunks).toString();
          let errObj = extractOpenaiPayloadError((() => { try { return JSON.parse(body); } catch { return null; } })());
          if (!errObj) {
            errObj = {
              message: formatHttpError(proxyRes.statusCode, body).replace(/^HTTP_\d+\s*:?\s*/, ''),
              type: proxyRes.statusCode === 429 ? 'rate_limit_exceeded' : 'api_error',
            };
          }
          rejectOpenaiPayloadError(reject, errObj, res, { anthropic: true });
        });
        proxyRes.on('error', () => {
          rejectOpenaiPayloadError(reject, { message: `HTTP_${proxyRes.statusCode}`, type: 'api_error' }, res, { anthropic: true });
        });
        return;
      }
      let buf = '', fullText = '', inputTokens = 0, outputTokens = 0, stopReason = 'end_turn', firstTokenMs = null, msgId = null;
      let settled = false;
      let streamError = null;
      let sawFinish = false;                 // 上游是否给过 finish_reason —— 区分「干净的空完成」与「真的没响应」
      const toolCallsByIndex = new Map();   // index → { id, name, args } —— 累积流式 tool_calls 分片

      const settleP2pError = (oaiErr) => {
        if (settled) return;
        settled = true;
        streamError = oaiErr;
        ttftGuard?.dispose();
        rejectOpenaiPayloadError(reject, oaiErr, res, { anthropic: true });
      };

      proxyRes.on('data', (chunk) => {
        if (settled) return;
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ds = line.slice(6).trim();
          if (ds === '[DONE]') continue;
          try {
            const c      = JSON.parse(ds);
            const oaiErr = extractOpenaiPayloadError(c);
            if (oaiErr) {
              try { proxyRes.destroy(); } catch {}
              settleP2pError(oaiErr);
              return;
            }
            if (!msgId) msgId = c.id || null;
            const choice = (c.choices || [{}])[0];
            const text   = (choice.delta || {}).content || '';
            if (text) {
              if (firstTokenMs === null) {
                firstTokenMs = Date.now() - t0;
                ttftGuard?.onFirstToken();
              }
              fullText += text;
            }
            // 累积 tool_calls 分片（OpenAI 流式：按 index 聚合 id/name/arguments）——
            // 否则纯工具调用响应（无文本）会被判为「空响应」而 502，Claude Code 的工具调用全挂。
            const tcs = (choice.delta || {}).tool_calls;
            if (Array.isArray(tcs)) {
              if (firstTokenMs === null) { firstTokenMs = Date.now() - t0; ttftGuard?.onFirstToken(); }
              for (const tc of tcs) {
                const idx = tc.index != null ? tc.index : 0;
                let cur = toolCallsByIndex.get(idx);
                if (!cur) { cur = { id: null, name: '', args: '' }; toolCallsByIndex.set(idx, cur); }
                if (tc.id) cur.id = tc.id;
                if (tc.function) {
                  if (tc.function.name) cur.name = tc.function.name;
                  if (tc.function.arguments) cur.args += tc.function.arguments;
                }
              }
            }
            const finish = choice.finish_reason;
            if (finish) { stopReason = finish === 'stop' ? 'end_turn' : finish; sawFinish = true; }
            if (c.usage) {
              inputTokens  = c.usage.prompt_tokens     || inputTokens;
              outputTokens = c.usage.completion_tokens || outputTokens;
            }
          } catch {}
        }
      });
      proxyRes.on('end', () => {
        ttftGuard?.dispose();
        if (settled) return;
        // 组装 tool_use 块（按 index 排序，arguments 解析为 input 对象）
        const toolUseBlocks = [...toolCallsByIndex.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, tc]) => {
            let input = {};
            try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = {}; }
            return { type: 'tool_use', id: tc.id || ('toolu_' + Math.random().toString(36).slice(2, 14)), name: tc.name || '', input };
          });
        if (!fullText && !toolUseBlocks.length) {
          // 上游没给 finish_reason 才当作「真的没响应」→ 报错触发 failover；
          // 若干净结束（有 finish，比如 max_tokens 太小/模型选择不输出），返回 200 空文本完成，
          // 免得 Claude Desktop 等客户端的连通性探测把「空完成」误判为网关故障。
          if (streamError || !sawFinish) {
            settleP2pError(streamError || { message: 'Empty response from upstream', type: 'api_error' });
            return;
          }
        }
        const content = [];
        if (fullText) content.push({ type: 'text', text: fullText });
        for (const b of toolUseBlocks) content.push(b);
        if (!content.length) content.push({ type: 'text', text: '' }); // 干净空完成 → 给个空文本块，保证 content 合法
        // 有工具调用 → Anthropic stop_reason 用 tool_use（上游 finish 常是 tool_calls）
        if (toolUseBlocks.length && (stopReason === 'end_turn' || stopReason === 'tool_calls')) stopReason = 'tool_use';
        try {
          const resp = JSON.stringify({
            id: 'msg_' + Math.random().toString(36).slice(2, 26),
            type: 'message', role: 'assistant',
            content,
            model, stop_reason: stopReason, stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          });
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(resp);
          }
          resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0, input_tokens: inputTokens, output_tokens: outputTokens, message_id: msgId, status_code: proxyRes.statusCode });
        } catch (err) { reject(err); }
      });
      proxyRes.on('error', (err) => { ttftGuard?.dispose(); reject(err); });
    });
    ttftGuard = createP2pTtftGuard(provider, { proxyReq, res, isStream: true, reject });
    proxyReq.on('error', (err) => { ttftGuard?.dispose(); reject(err); });
    proxyReq.on('timeout', () => { ttftGuard?.dispose(); proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Codex Responses ⇄ Chat Completions ───────────────────────────────────────
// Codex 客户端走 Responses 协议（/v1/responses）。上游若原生支持 Responses 则透传；
// 否则（多数第三方仅 Chat Completions）在此把 Responses ⇄ Chat 互转。
function proxyResponsesViaChat(provider, responsesBody, model, res) {
  return new Promise((resolve, reject) => {
    const streaming = !!responsesBody.stream;
    // Responses → Chat 请求体（含 stream 时自动注入 include_usage）
    const chatBody = codexTransform.responsesToChat({ ...responsesBody, model });
    // 工具上下文：回写时还原 namespace / custom / tool_search（对齐 cc-switch）
    const toolContext = chatBody._codexToolContext
      || codexTransform.buildCodexToolContext(responsesBody);
    delete chatBody._codexToolContext; // 内部字段，勿发给上游

    // 工具链路诊断：入站类型 → 展平后 chat tools → 便于排查「无工具日志」
    const inboundTools = codexTransform.summarizeResponsesTools(responsesBody);
    const chatToolNames = (chatBody.tools || []).map(t => t && t.function && t.function.name).filter(Boolean);
    debugLog('proxyResponsesViaChat 工具转换', {
      provider: provider.id, model,
      inbound: inboundTools,
      chat_tools: chatToolNames.length,
      chat_tool_names: chatToolNames.slice(0, 40),
      has_exec: chatToolNames.includes('exec'),
    });
    console.log(`[gateway] responses→chat tools=${chatToolNames.length} exec=${chatToolNames.includes('exec')} inbound=${inboundTools.top_level}+add=${inboundTools.additional}`);

    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/chat/completions';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }

    const mod     = u.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(chatBody);
    const headers = {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      'Accept':         'text/event-stream, application/json',
    };
    if (provider._oauth) Object.assign(headers, provider._oauth.applyAuth({ headers, credentials: provider.credentials }).headers);
    else if (provider.token) headers['Authorization'] = `Bearer ${provider.token}`;
    applyP2pRouteHeader(headers, provider);

    const t0 = Date.now();
    let firstTokenMs = null;
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
      agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const ec = [];
        proxyRes.on('data', c => ec.push(c));
        proxyRes.on('end', () => {
          const errBody = Buffer.concat(ec).toString().slice(0, 800);
          debugLog('proxyResponsesViaChat 上游错误', { status: proxyRes.statusCode, base_url: provider.base_url, provider: provider.id, body: errBody });
          reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode, body: errBody }));
        });
        proxyRes.on('error', () => reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode })));
        return;
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }
      const status = proxyRes.statusCode;

      if (streaming) {
        // 流式：上游 Chat SSE → 状态机 → Responses SSE，边转边写给客户端
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*',
        });
        const sm = new codexTransform.ChatToResponsesStream({ toolContext });
        let buf = '';
        const usageOf = () => { const u2 = sm.getUsage() || {}; return {
          provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: u2.input_tokens || 0, output_tokens: u2.output_tokens || 0,
          cache_read_tokens: u2.cache_read_input_tokens || u2.input_tokens_details?.cached_tokens || 0,
          message_id: sm.getResponseId(), status_code: status }; };

        proxyRes.on('data', (chunk) => {
          buf += chunk.toString();
          // 按行解析（兼容事件间为单个 \n 或标准 \n\n 的上游；每个 data: 行即一个 chat chunk）
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).replace(/^ /, '');
            if (!data) continue;
            if (data.trim() === '[DONE]') { res.write(sm.finalize()); continue; }
            let obj; try { obj = JSON.parse(data); } catch { continue; }
            if (obj.error) { res.write(sm.failedEvent(obj.error.message || 'upstream error', obj.error.type)); continue; }
            if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
            res.write(sm.handleChunk(obj));
          }
        });
        proxyRes.on('end',   () => { if (!sm.completed) res.write(sm.finalize()); res.end(); resolve(usageOf()); });
        proxyRes.on('error', (err) => { if (!sm.completed) res.write(sm.failedEvent(`Stream error: ${err.message}`, 'stream_error')); res.destroy(err); resolve(usageOf()); });
      } else {
        // 非流式：缓冲完整 Chat JSON → 转 Responses JSON
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          let respObj, usageIn = 0, usageOut = 0, cacheRead = 0, msgId = null;
          try {
            const chatResp = JSON.parse(raw);
            respObj = codexTransform.chatToResponses(chatResp, { toolContext });
            const u2 = respObj.usage || {};
            usageIn = u2.input_tokens || 0; usageOut = u2.output_tokens || 0;
            cacheRead = u2.cache_read_input_tokens || u2.input_tokens_details?.cached_tokens || 0;
            msgId = respObj.id || null;
          } catch (err) { return reject(err); }
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify(respObj));
          resolve({ provider: provider.id, latency: Date.now() - t0, first_token_ms: Date.now() - t0,
            input_tokens: usageIn, output_tokens: usageOut, cache_read_tokens: cacheRead,
            message_id: msgId, status_code: status });
        });
        proxyRes.on('error', reject);
      }
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Codex Responses → Anthropic 供给源（如 Claude OAuth）──────────────────────
// Codex 客户端走 Responses 协议，但 Claude 供给源是 Anthropic /v1/messages。
// 串联现有转换器：Responses→Chat（codexTransform）→ Anthropic（oaiRequestToAnthropic）出，
// 回程 Anthropic→Chat（anthropicRespToOai）→ Responses（chatToResponses / ChatToResponsesStream）。
function proxyResponsesViaAnthropic(provider, responsesBody, model, res) {
  return new Promise((resolve, reject) => {
    const streaming = !!responsesBody.stream;
    const chatBody  = codexTransform.responsesToChat({ ...responsesBody, model });
    const toolContext = chatBody._codexToolContext
      || codexTransform.buildCodexToolContext(responsesBody);
    delete chatBody._codexToolContext;
    let anthBody    = oaiRequestToAnthropic({ ...chatBody, stream: streaming });

    const base    = normBase(provider.base_url);
    const fullUrl = base + '/' + apiVer(provider.base_url) + '/messages';
    let u;
    try { u = new URL(fullUrl); } catch { return reject(new Error('invalid_url')); }
    const mod = u.protocol === 'https:' ? https : http;

    let headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (streaming) headers['Accept'] = 'text/event-stream';
    if (provider._oauth) {
      const ap = provider._oauth.applyAuth({ headers, body: anthBody, credentials: provider.credentials });
      headers = ap.headers; anthBody = ap.body;
    } else if (provider.token) headers['x-api-key'] = provider.token;
    const bodyStr = JSON.stringify(anthBody);
    headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const t0 = Date.now();
    let firstTokenMs = null;
    const proxyReq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: 120_000,
      agent: resolveProxyAgent(provider, fullUrl),
    }, (proxyRes) => {
      if (proxyRes.statusCode >= 400) {
        const ec = [];
        proxyRes.on('data', c => ec.push(c));
        proxyRes.on('end', () => {
          const errBody = Buffer.concat(ec).toString().slice(0, 800);
          debugLog('proxyResponsesViaAnthropic 上游错误', { status: proxyRes.statusCode, body: errBody, sent_headers: Object.keys(headers) });
          reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode, body: errBody }));
        });
        proxyRes.on('error', () => reject(Object.assign(new Error(`HTTP_${proxyRes.statusCode}`), { status: proxyRes.statusCode })));
        return;
      }
      if (res.headersSent) { proxyRes.resume(); return reject(new Error('headers_already_sent')); }
      const status = proxyRes.statusCode;

      if (streaming) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
        const sm = new codexTransform.ChatToResponsesStream({ toolContext });
        const chatId = 'chatcmpl-' + Math.random().toString(36).slice(2, 26);
        let buf = '', usageIn = 0, usageOut = 0, started = false;
        const feed = (obj) => { res.write(sm.handleChunk(obj)); };
        proxyRes.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const ds = line.slice(5).replace(/^ /, '').trim();
            if (!ds || ds === '[DONE]') continue;
            let evt; try { evt = JSON.parse(ds); } catch { continue; }
            if (evt.type === 'message_start') {
              usageIn = evt.message?.usage?.input_tokens || 0;
              if (!started) { started = true; feed({ id: chatId, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }); }
            } else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta' && evt.delta.text) {
              if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
              feed({ id: chatId, choices: [{ index: 0, delta: { content: evt.delta.text }, finish_reason: null }] });
            } else if (evt.type === 'message_delta') {
              if (evt.usage?.output_tokens != null) usageOut = evt.usage.output_tokens;
              const stop = evt.delta?.stop_reason;
              if (stop) feed({ id: chatId, choices: [{ index: 0, delta: {}, finish_reason: stop === 'end_turn' ? 'stop' : stop }],
                usage: { prompt_tokens: usageIn, completion_tokens: usageOut, total_tokens: usageIn + usageOut } });
            }
          }
        });
        const done = () => ({ provider: provider.id, latency: Date.now() - t0, first_token_ms: firstTokenMs ?? Date.now() - t0,
          input_tokens: usageIn, output_tokens: usageOut, message_id: sm.getResponseId ? sm.getResponseId() : null, status_code: status });
        proxyRes.on('end', () => { if (!sm.completed) res.write(sm.finalize()); res.end(); resolve(done()); });
        proxyRes.on('error', (err) => { if (!sm.completed) res.write(sm.failedEvent(`Stream error: ${err.message}`, 'stream_error')); res.destroy(err); resolve(done()); });
      } else {
        const chunks = [];
        proxyRes.on('data', c => chunks.push(c));
        proxyRes.on('end', () => {
          try {
            const anthResp = JSON.parse(Buffer.concat(chunks).toString());
            const respObj  = codexTransform.chatToResponses(anthropicRespToOai(anthResp), { toolContext });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(respObj));
            const latency = Date.now() - t0;
            resolve({ provider: provider.id, latency, first_token_ms: latency,
              input_tokens: anthResp.usage?.input_tokens || 0, output_tokens: anthResp.usage?.output_tokens || 0,
              cache_read_tokens: anthResp.usage?.cache_read_input_tokens || 0,
              message_id: anthResp.id || null, status_code: status });
          } catch (err) { reject(err); }
        });
        proxyRes.on('error', reject);
      }
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(bodyStr);
    proxyReq.end();
  });
}

// ── Route ─────────────────────────────────────────────────────────────────────

// Claude Code 2.x 会在 /v1/messages body 里带较新的顶层参数（如 context_management 上下文自动编辑）。
// 官方 api.anthropic.com 支持；三方 / p2p 的 anthropic 兼容端点多用严格 schema，遇到未知顶层字段直接 400
// （"context_management: Extra inputs are not permitted"）。转发给非官方 anthropic 上游前剥掉这些字段。
// 内置名单 + 学习表 strip（gateway-upstream-hints）合并应用。
const ANTHROPIC_EXTRA_FIELDS = ['context_management'];
function stripUnsupportedAnthropicFields(body, provider, model) {
  if (!body || typeof body !== 'object') return body;
  if (/api\.anthropic\.com/i.test(String(provider && provider.base_url || ''))) return body; // 官方支持，原样透传
  let out = body;
  for (const k of ANTHROPIC_EXTRA_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(out, k)) {
      if (out === body) out = { ...body };
      delete out[k];
    }
  }
  // 学习到的 strip（同供给源 * 与具体 model）
  const learned = upstreamHints.getMerged(provider && provider.id, model);
  if (learned && learned.strip && learned.strip.length) {
    out = upstreamHints.applyMutations(out, { strip: learned.strip });
  }
  return out;
}

// Call one provider with format conversion; throws on HTTP error.
// provider is already resolved (base_url/token correct, models populated).
// ── 出站 max_tokens 夹紧 ─────────────────────────────────────────────────────
// 部分客户端（如 WorkBuddy）按模型上下文窗口（256K）直接把 max_tokens 设成 262144，
// 但上游对「输出」另有更小的硬上限，超过直接 400（例：Kimi K2 输出上限 131072）。
// 网关按已知模型族夹紧输出 token，仅在请求值超过已知上限时收窄；未知模型一律不动，避免误伤。
const OUTPUT_TOKEN_CAPS = [
  { re: /kimi|moonshot|(^|[^a-z0-9])k2(\.|[-_ ]|$)/i, cap: 131072 },  // Kimi/Moonshot K2 系列输出上限 128K
];
function modelOutputCap(model) {
  const m = String(model || '');
  for (const { re, cap } of OUTPUT_TOKEN_CAPS) if (re.test(m)) return cap;
  return null;
}
// 就地夹紧（传入的应为每次尝试的浅拷贝 body）。覆盖三种字段名：
// OpenAI(max_tokens / max_completion_tokens)、Anthropic(max_tokens)、Responses(max_output_tokens)。
function clampOutputTokens(model, body) {
  const cap = modelOutputCap(model);
  if (!cap || !body || typeof body !== 'object') return body;
  for (const f of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (Number.isFinite(body[f]) && body[f] > cap) {
      debugLog('夹紧 max_tokens（超模型输出上限）', { model, field: f, from: body[f], to: cap });
      body[f] = cap;
    }
  }
  return body;
}

// 上游 400 报文约束：可解析则同源改参重试并学习；429/401/403/402 等硬错误原样抛出，
// 由路由层 noteCooldown + sink 做候选降级（见 gateway-cooldown / gateway-upstream-hints 头注）。
function parseFixedTemperatureError(err) {
  const m = upstreamHints.parseBodyConstraintError(err);
  const v = m && m.set && m.set.temperature;
  return Number.isFinite(v) ? v : null;
}

// DeepSeek thinking 模式：历史 assistant 缺 reasoning_content 时会 400。
// 兼容 OpenAI（reasoning_content 字段）与 Anthropic（thinking 块）报文。
function isMissingReasoningContentError(err) {
  const text = [err && err.message, err && err.body].filter(Boolean).join('\n');
  return /reasoning_content[\s\S]{0,80}must be passed back/i.test(text);
}

function ensureReasoningContentOnAssistants(body, placeholder = ' ') {
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((m) => {
    if (!m || m.role !== 'assistant') return m;

    // Anthropic：content 为块数组 → 补 thinking 块（转 OAI 时会变成 reasoning_content）
    if (Array.isArray(m.content)) {
      const hasThinking = m.content.some(
        (b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'),
      );
      if (hasThinking) return m;
      changed = true;
      return {
        ...m,
        content: [{ type: 'thinking', thinking: placeholder }, ...m.content],
      };
    }

    // OpenAI：顶层 reasoning_content
    const has = typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0;
    if (has) return m;
    changed = true;
    return { ...m, reasoning_content: placeholder };
  });
  return changed ? { ...body, messages } : body;
}

async function callProvider(provider, isAnthropic, streaming, reqPath, body, attemptModel, res, routeMeta = null) {
  const providerId = provider && provider.id;
  // 已学习的 set/strip：首包改写，避免每次先 400 再同源重试
  let reqBody = upstreamHints.applyHints(body, providerId, attemptModel);
  if (reqBody !== body) {
    const desc = upstreamHints.describeMutations(upstreamHints.getMerged(providerId, attemptModel));
    debugLog('上游约束按学习表首包改参', { model: attemptModel, provider: providerId, desc });
    console.log(`[gateway] body-fix (learned) ${desc} model="${attemptModel}" via "${providerId}"`);
  }

  try {
    return await callProviderOnce(provider, isAnthropic, streaming, reqPath, reqBody, attemptModel, res, routeMeta);
  } catch (err) {
    // 响应已开始写出则无法改参重试；429 等硬错误交给外层 cooldown 降级
    if (res && res.headersSent) throw err;

    // thinking 多轮缺 reasoning_content：补占位后同源再试（修好后再 failover 到第二源才有意义）
    if (isMissingReasoningContentError(err)) {
      const fixedReasoning = ensureReasoningContentOnAssistants(reqBody);
      if (fixedReasoning !== reqBody) {
        console.log(`[gateway] body-fix 重试 fill:reasoning_content model="${attemptModel}" via "${providerId}"`);
        try {
          return await callProviderOnce(
            provider, isAnthropic, streaming, reqPath,
            fixedReasoning, attemptModel, res, routeMeta,
          );
        } catch (err2) {
          // 仍失败则继续走通用改参 / 外层 failover
          err = err2;
        }
      }
    }

    const mutations = upstreamHints.parseBodyConstraintError(err);
    if (!mutations) throw err;
    const fixedBody = upstreamHints.applyMutations(reqBody, mutations);
    if (fixedBody === reqBody) throw err; // 改无可改 → failover
    upstreamHints.noteHints(providerId, attemptModel, mutations);
    const desc = upstreamHints.describeMutations(mutations);
    debugLog('上游约束自动降级重试', { model: attemptModel, provider: providerId, desc });
    console.log(`[gateway] body-fix 重试 ${desc} model="${attemptModel}" via "${providerId}"`);
    return await callProviderOnce(
      provider, isAnthropic, streaming, reqPath,
      fixedBody, attemptModel, res, routeMeta,
    );
  }
}

async function callProviderOnce(provider, isAnthropic, streaming, reqPath, body, attemptModel, res, routeMeta = null) {
  // OAuth 供给源：确保 access_token 有效（必要时刷新并回写 config），附加 _oauth 模块
  provider = await oauth.prepare(provider, _getConfig, _saveConfig);
  // p2p 派发：把本次路由指令（auto 排序 / 钉分享者）挂到 provider 副本，供各 p2p 代理注入 X-TB-Route。
  // 每次调用生成独立副本，避免并发请求间串写（provider 对象在 enabledProviders 间可能共享引用）。
  if (routeMeta && provider.type === 'p2p') provider = { ...provider, _routeMeta: routeMeta };

  debugLog(`callProvider 选中 provider`, {
    provider_id: provider.id,
    provider_type: provider.type,
    base_url: provider.base_url,
    api_format: provider.api_format,
    isAnthropic,
    streaming,
    reqPath,
    attemptModel,
  });
  // 转发请求日志（控制台常驻）：看清每次请求实际转发到哪个 provider / 哪个模型
  console.log(`[gateway] → forward model="${attemptModel}" via provider="${provider.id}" (${provider.type}) ${provider.base_url}`);

  // Codex Responses 请求：
  //  - 上游原生支持 Responses → 透传（保留 previous_response_id 等多轮字段）
  //  - Anthropic → Responses→Anthropic 桥
  //  - 其余（仅 Chat Completions）→ Responses⇄Chat 转换
  if (reqPath === '/v1/responses' || reqPath === '/responses') {
    const fmt = providerApiFormat(provider);
    const rb = clampOutputTokens(attemptModel, { ...body, model: attemptModel });
    if (fmt === 'anthropic') {
      return await proxyResponsesViaAnthropic(provider, rb, attemptModel, res);
    }
    if (providerSupportsResponses(provider)) {
      console.log(`[gateway] → responses native passthrough via "${provider.id}"`);
      // 纠正历史遗留的坏 message id（resp_..._msg），否则官方 Responses API 会以
      // invalid_id_prefix 拒收多轮回传的 input。
      codexTransform.sanitizeResponsesInputIds(rb);
      return await proxyRequest(provider, '/v1/responses', rb, res);
    }
    return await proxyResponsesViaChat(provider, rb, attemptModel, res);
  }
  const attemptBody = clampOutputTokens(attemptModel, { ...body, model: attemptModel });
  const oaiConvertOpts = { includeImages: modelSupportsVision(attemptModel, provider) };

  // Gemini provider（generateContent）：先把客户端请求归一成 OpenAI 体，再转 Gemini
  if (isGeminiProvider(provider)) {
    const oaiBody = isAnthropic ? anthropicToOpenai(attemptBody, oaiConvertOpts) : attemptBody;
    return streaming
      ? await proxyGeminiStream(provider, oaiBody, attemptModel, res, isAnthropic)
      : await proxyGeminiSync(provider, oaiBody, attemptModel, res, isAnthropic);
  }

  // Anthropic-compatible provider
  const isAnthropicProvider = providerApiFormat(provider) === 'anthropic';
  if (isAnthropicProvider) {
    if (isAnthropic) {
      // Anthropic client → Anthropic provider: direct proxy to /v1/messages
      // 剥掉非官方上游不认的新字段（context_management 等），避免严格 schema 400
      return await proxyRequest(provider, '/v1/messages', stripUnsupportedAnthropicFields(attemptBody, provider, attemptModel), res);
    } else {
      // OpenAI client → Anthropic provider: convert request/response format
      return streaming
        ? await proxyAnthropicStream(provider, attemptBody, attemptModel, res)
        : await proxyAnthropicSync(provider, attemptBody, attemptModel, res);
    }
  }

  const oaiBody = isAnthropic ? anthropicToOpenai(attemptBody, oaiConvertOpts) : null;
  if (isAnthropic) {
    return streaming
      ? await proxyConvertStream(provider, oaiBody, attemptModel, res)
      // P2P backends often only support streaming; use proxyP2PSync (sends stream:true internally)
      : (provider.type === 'p2p'
          ? await proxyP2PSync(provider, oaiBody, attemptModel, res)
          : await proxyConvertSync(provider, oaiBody, attemptModel, res));
  }
  return await proxyRequest(provider, reqPath, attemptBody, res);
}

// ── 条件路由规则引擎（零成本条件）──────────────────────────────────────────────
// 请求模态（从路径推断）：chat / image / video / embedding / audio
function modalityOf(reqPath) {
  const p = String(reqPath || '');
  if (/\/images?(\/|$)/.test(p)) return 'image';
  if (/\/video/.test(p)) return 'video';
  if (/\/embeddings$/.test(p)) return 'embedding';
  if (/\/audio\//.test(p)) return 'audio';
  return 'chat';  // /chat/completions /messages /responses /v1beta(gemini) 等
}
// 拼接输入文本（messages / input / prompt）—— 给 keyword/未来分类器用
function extractText(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  const push = (c) => {
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) for (const s of c) { if (typeof s === 'string') parts.push(s); else if (s && typeof s.text === 'string') parts.push(s.text); }
  };
  if (Array.isArray(body.messages)) for (const m of body.messages) push(m && m.content);
  if (Array.isArray(body.input))    for (const m of body.input)    push(typeof m === 'string' ? m : (m && m.content));
  if (typeof body.prompt === 'string') parts.push(body.prompt);
  if (typeof body.input === 'string')  parts.push(body.input);
  return parts.join('\n');
}
// 粗估输入 token：约 4 字符/token（零成本，足够做长上下文分流）
function estimateInputTokens(body) { return Math.ceil(extractText(body).length / 4); }

/** 流式上游常只回 completion_tokens；有输出但 input 为 0 时用请求体粗估（与路由规则同算法） */
function fillMissingInputTokens(usage, body) {
  if (!usage || usage.input_tokens || !body) return usage;
  if (!(usage.output_tokens > 0)) return usage;
  return { ...usage, input_tokens: estimateInputTokens(body) };
}

// 关键词匹配只看「最后一条用户消息」（当前意图）——否则历史里出现过的词会一直命中、切不回去
function extractLastUserText(body) {
  if (!body || typeof body !== 'object') return '';
  const collect = (c) => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(s => (typeof s === 'string' ? s : (s && typeof s.text === 'string' ? s.text : ''))).join('\n');
    return '';
  };
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m && m.role === 'user') return collect(m.content);
    }
  }
  if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const m = body.input[i];
      if (typeof m === 'string') return m;
      if (m && (m.role === 'user' || !m.role)) return collect(m.content);
    }
  }
  if (typeof body.prompt === 'string') return body.prompt;
  if (typeof body.input === 'string') return body.input;
  return '';
}

// 单条 when 求值。type: request_type|model|input_tokens|keyword|caller；op: is/not/in/gt/lt/gte/lte/match/contains
function evalWhen(when, ctx) {
  if (!when || !when.type) return false;
  const op = when.op || 'is', val = when.value;
  let cur;
  switch (when.type) {
    case 'request_type': cur = ctx.modality; break;
    case 'model':        cur = ctx.model; break;
    case 'input_tokens': cur = ctx.input_tokens; break;
    case 'keyword':      cur = (ctx.keyword_text != null ? ctx.keyword_text : ctx.text); break;
    case 'caller':       cur = ctx.caller; break;
    case 'classifier':
      // Abstention must not match negative/regex/numeric conditions either.
      if (ctx.classifier_label == null) return false;
      cur = ctx.classifier_label; break;
    default: return false;
  }
  switch (op) {
    case 'is':       return String(cur) === String(val);
    case 'not':      return String(cur) !== String(val);
    case 'in':       return Array.isArray(val) && val.map(String).includes(String(cur));
    case 'gt':       return Number(cur) >  Number(val);
    case 'lt':       return Number(cur) <  Number(val);
    case 'gte':      return Number(cur) >= Number(val);
    case 'lte':      return Number(cur) <= Number(val);
    case 'match':    try { return new RegExp(val, 'i').test(String(cur || '')); } catch { return false; }
    case 'contains': return String(cur || '').toLowerCase().includes(String(val).toLowerCase());
    default: return false;
  }
}
// 统一步骤按 when 过滤（同步，不含分类器）：无条件=兜底，带条件=命中才用；保持顺序。
function pickSteps(scene, ctx) {
  return unifySteps(scene).filter(s => s && (!s.when || evalWhen(s.when, ctx)));
}

// ── 语义分类器 / 识图助手：内部「调一次模型拿纯文本」，不写 res。
// promptOrContent：字符串，或 OpenAI parts[] / Anthropic blocks[]（多模态）。
// kimi 等经火山时正文常在 reasoning_content，content 可能为空——必须兼容提取。
function extractInternalCompleteText(j, isAnthropic) {
  return visionAssist.extractAssistResponseText(j, isAnthropic);
}

function internalComplete(provider, model, promptOrContent, maxTokens = 8, opts = {}) {
  const isAnthropic = providerApiFormat(provider) === 'anthropic';
  const _ver = apiVer(provider.base_url);
  let u;
  try { u = new URL(normBase(provider.base_url) + (isAnthropic ? `/${_ver}/messages` : `/${_ver}/chat/completions`)); }
  catch { return Promise.reject(new Error('invalid_url')); }
  const content = promptOrContent;
  // 不默认 temperature:0 —— kimi k3 等 Coding 模型只允许 temperature=1，硬编码 0 会直接 HTTP_400
  let body = isAnthropic
    ? { model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }
    : { model, max_tokens: maxTokens, stream: false, messages: [{ role: 'user', content }] };
  body = upstreamHints.applyHints(body, provider && provider.id, model);

  const sendOnce = (reqBody) => new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(reqBody);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) };
    if (provider.token) {
      if (isAnthropic) { headers['x-api-key'] = provider.token; headers['anthropic-version'] = '2023-06-01'; }
      else headers['Authorization'] = `Bearer ${provider.token}`;
    }
    const timeoutMs = opts.timeoutMs || (Array.isArray(content) ? 60000 : 15000);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST', headers, timeout: timeoutMs,
      signal: opts.signal,
      agent: resolveProxyAgent(provider, u.href),
    }, (rs) => {
      let data = '';
      rs.on('error', reject);
      rs.on('aborted', () => reject(new Error('response_aborted')));
      rs.on('data', c => data += c);
      rs.on('end', () => {
        if (rs.statusCode >= 400) {
          const err = new Error(`HTTP_${rs.statusCode}`);
          err.status = rs.statusCode;
          err.body = String(data || '').slice(0, 800);
          // 把上游文案拼进 message，便于 parseBodyConstraintError / 路由详情
          const snip = err.body.replace(/\s+/g, ' ').slice(0, 180);
          if (snip) err.message = `HTTP_${rs.statusCode}: ${snip}`;
          return reject(err);
        }
        try {
          const j = JSON.parse(data);
          const text = extractInternalCompleteText(j, isAnthropic);
          const usage = isAnthropic
            ? { input_tokens: j.usage?.input_tokens || 0, output_tokens: j.usage?.output_tokens || 0, message_id: j.id }
            : {
              input_tokens: j.usage?.prompt_tokens || 0,
              output_tokens: j.usage?.completion_tokens || 0,
              message_id: j.id,
            };
          resolve({ text: String(text || ''), usage });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(bodyStr); req.end();
  });

  return sendOnce(body).catch((err) => {
    const mutations = upstreamHints.parseBodyConstraintError(err);
    if (!mutations) throw err;
    const fixed = upstreamHints.applyMutations(body, mutations);
    if (fixed === body) throw err;
    upstreamHints.noteHints(provider && provider.id, model, mutations);
    console.log(`[gateway] vision-assist body-fix 重试 ${upstreamHints.describeMutations(mutations)} model="${model}" via "${provider && provider.id}"`);
    return sendOnce(fixed);
  });
}

const _classifyCache = new Map();   // 模型/供给源/类别/输入/预算 → { ts, label }；5min 缓存
const _classifyPending = new Map(); // Bound LLM fallback load when System One is down.

function routingCfg() {
  let yamlRouting = {}, runtime = {};
  try { yamlRouting = require('./config-loader').routing(); } catch {}
  try { runtime = _getConfig?.()?.routing || {}; } catch {}
  return jevShadow.effectiveRouting(yamlRouting, runtime);
}

/** 现有小模型分类器（原 classifyInput 逻辑） */
async function classifyInputLlm(text, classifier, timeoutMs = 3000) {
  if (!classifier || !classifier.model || !Array.isArray(classifier.categories) || !classifier.categories.length) return null;
  const cats = classifier.categories.map(String);
  const snippet = String(text || '').slice(0, classifier.max_chars || 600);
  if (!snippet) return null;
  const provider = enabledProviders().find(p => providerHasModel(p, classifier.model));
  if (!provider) return null;
  const key = JSON.stringify([classifier.model, provider.id, provider.base_url, cats, snippet, timeoutMs]);
  const now = Date.now();
  const hit = _classifyCache.get(key);
  if (hit && now - hit.ts < 300000) return hit.label;
  if (_classifyPending.has(key)) return _classifyPending.get(key);
  if (_classifyPending.size >= 4) return null;
  const task = (async () => {
    const prompt = `把下面这条用户请求归到这些类别之一，只回类别词本身，不要解释。\n类别: ${cats.join(', ')}\n\n请求:\n${snippet}`;
    let out;
    try {
      const r = await jevShadow.withDeadline(timeoutMs, signal =>
        internalComplete(provider, classifier.model, prompt, 8, { timeoutMs, signal }));
      out = typeof r === 'string' ? r : (r && r.text);
    } catch { return null; }
    const low = String(out || '').trim().replace(/^["'`]|["'`]$/g, '').toLowerCase();
    const label = cats.find(c => String(c).toLowerCase() === low) || null;
    if (label) _classifyCache.set(key, { ts: now, label });
    if (_classifyCache.size > 500) _classifyCache.delete(_classifyCache.keys().next().value);
    return label;
  })();
  _classifyPending.set(key, task);
  try { return await task; } finally { _classifyPending.delete(key); }
}

/**
 * 场景语义分类：可走 systemone（OpenDecision/Jev）做真实路由，失败可回退小模型。
 * 配置：routing.decision_classifier.engine = llm | systemone
 */
async function classifyInput(text, classifier) {
  if (!classifier || !Array.isArray(classifier.categories) || !classifier.categories.length) return null;
  const cats = classifier.categories.map(String);
  const dc = jevShadow.loadDecisionConfig(routingCfg());

  if (dc.engine === 'systemone') {
    let so;
    const maxChars = Math.min(dc.maxChars, Number(classifier.max_chars) > 0 ? Number(classifier.max_chars) : dc.maxChars);
    try { so = await jevShadow.classifyForRouting(text, cats, { ...dc, maxChars }); } catch { so = null; }
    if (so && so.choice) {
      try {
        jevShadow.logDecision({
          provider: so.provider || dc.provider,
          endpoint: dc.endpoint,
          local_label: null,
          jev_choice: so.choice,
          jev_confidence: so.confidence,
          jev_ms: so.ms,
          used: 'systemone',
          categories: cats,
        });
      } catch {}
      return so.choice;
    }
    const label = dc.fallbackLlm ? await classifyInputLlm(text, classifier, dc.llmTimeoutMs) : null;
    try {
      jevShadow.logDecision({
        provider: dc.provider,
        endpoint: dc.endpoint,
        jev_choice: so && so.choice || null,
        jev_confidence: so && so.confidence,
        jev_ms: so && so.ms,
        jev_error: so && so.error || 'no_result',
        used: label ? 'fallback_llm' : 'abstain',
        local_label: label,
        fallback_llm_attempted: dc.fallbackLlm,
        categories: cats,
      });
    } catch {}
    return label;
  }

  return classifyInputLlm(text, classifier, dc.llmTimeoutMs);
}

/**
 * 场景步识图增强：有图且配置了 vision_assist 时，先调多模态助手，再把图片换成描述。
 * 仅对「最后一条 user」中尚未缓存的图调用识图；历史图复用缓存，避免重复识别。
 */
async function applyVisionAssistIfNeeded(step, body, { callerKey, reqPath, skipP2P = false } = {}) {
  const assist = step && step.vision_assist;
  const assistModel = assist && (typeof assist === 'string' ? assist : assist.model);
  if (!assistModel || !visionAssist.bodyHasImages(body)) {
    return { body, meta: null };
  }
  const t0 = Date.now();
  const items = visionAssist.collectImagesWithMeta(body);
  if (!items.length) return { body, meta: null };

  // 带上用户问题，避免识图助手无的放矢「看图说话」
  const userQuestion = visionAssist.extractUserQuestion(body);
  const planned = visionAssist.planImageDescriptions(items, userQuestion);
  const descs = planned.descs.slice();
  const needApiIdx = planned.needApiIdx;

  // 无需调识图：全部命中缓存或仅为历史图占位
  if (!needApiIdx.length) {
    const next = visionAssist.replaceImagesInBody(visionAssist.cloneBody(body), descs);
    visionAssist.prependVisionAssistNotice(next, items.length);
    return {
      body: next,
      meta: {
        model: assistModel,
        status: 'ok',
        latency_ms: Date.now() - t0,
        image_count: items.length,
        cache_hits: planned.cacheHits,
        history_skip: planned.historySkip,
        api_images: 0,
      },
    };
  }

  const prompt = (assist && assist.prompt) || visionAssist.DEFAULT_ASSIST_PROMPT;
  const maxTokens = (assist && assist.max_tokens) || visionAssist.DEFAULT_ASSIST_MAX_TOKENS;
  const tierHint = (assist && assist.tier) || step.tier || null;

  let providers = enabledProviders().filter(p => !skipP2P || p.type !== 'p2p');
  providers = providers.filter(p => providerHasModel(p, assistModel, { strict: skipP2P }));
  if (tierHint) providers = providers.filter(p => p.type === tierHint);
  providers = [
    ...providers.filter(p => modelSupportsVision(assistModel, p)),
    ...providers.filter(p => !modelSupportsVision(assistModel, p)),
  ];
  if (!providers.length) {
    return {
      body: visionAssist.stripImagesInBody(body),
      meta: { model: assistModel, status: 'error', error: 'assist_provider_missing', latency_ms: Date.now() - t0 },
    };
  }

  const apiImgs = needApiIdx.map((i) => items[i].img);
  let lastErr = null;
  let lastProvider = null;

  for (const provider of providers) {
    lastProvider = provider;
    const fmt = providerApiFormat(provider) === 'anthropic' ? 'anthropic' : 'openai';
    const userContent = visionAssist.buildAssistUserContent(apiImgs, prompt, fmt, userQuestion);
    try {
      const result = await internalComplete(provider, assistModel, userContent, maxTokens, { timeoutMs: 60000 });
      const text = result && result.text;
      const parsed = visionAssist.parseAssistDescriptions(text, apiImgs.length);
      if (!parsed.some(d => d && String(d).trim())) {
        lastErr = new Error('empty_description');
        continue;
      }
      needApiIdx.forEach((itemIdx, j) => {
        descs[itemIdx] = parsed[j];
        if (parsed[j]) {
          const fp = items[itemIdx].fp;
          // 问题相关键 + 纯图键：后者供下一轮历史复用
          visionAssist.cacheSet(visionAssist.cacheKey(fp, userQuestion), parsed[j]);
          visionAssist.cacheSet(fp, parsed[j]);
        }
      });
      const next = visionAssist.replaceImagesInBody(visionAssist.cloneBody(body), descs);
      visionAssist.prependVisionAssistNotice(next, items.length);
      const usage = result.usage || {};
      try {
        recordStats(provider.id, assistModel, {
          ...usage,
          latency: Date.now() - t0,
          status_code: 200,
        }, _providerTier(provider), callerKey, false, provider.billing_type || null, reqPath);
        reportUsage(provider.id, assistModel, (usage.input_tokens || 0) + (usage.output_tokens || 0));
      } catch {}
      return {
        body: next,
        meta: {
          model: assistModel,
          via: provider.id,
          via_label: provider.label,
          status: 'ok',
          latency_ms: Date.now() - t0,
          image_count: items.length,
          cache_hits: planned.cacheHits,
          history_skip: planned.historySkip,
          api_images: apiImgs.length,
        },
      };
    } catch (err) {
      lastErr = err;
      console.warn(`[gateway] vision-assist fail model="${assistModel}" via="${provider.id}":`, err && err.message);
    }
  }

  // 识图失败：已有缓存描述仍尽量用上；未识别的槽位留空占位
  const next = visionAssist.replaceImagesInBody(visionAssist.cloneBody(body), descs.map((d) => d || ''));
  visionAssist.prependVisionAssistNotice(next, items.length);
  return {
    body: next,
    meta: {
      model: assistModel,
      via: lastProvider && lastProvider.id,
      via_label: lastProvider && lastProvider.label,
      status: 'error',
      error: lastErr && lastErr.message ? lastErr.message : String(lastErr || 'assist_failed'),
      latency_ms: Date.now() - t0,
      image_count: items.length,
      cache_hits: planned.cacheHits,
      history_skip: planned.historySkip,
      api_images: apiImgs.length,
    },
  };
}


// 统一步骤：每步可选带 when 条件。老 rules 摊平成"带 rule.when 的步"，再接默认步(无 when)。
function unifySteps(scene) {
  const all = [];
  if (Array.isArray(scene && scene.rules)) {
    for (const rule of scene.rules) {
      if (rule && Array.isArray(rule.steps)) {
        for (const s of rule.steps) all.push({ ...s, when: s.when || rule.when || null });
      }
    }
  }
  for (const s of ((scene && scene.steps) || [])) all.push(s);
  return all;
}

// 选路由链（异步）：把统一步骤按各步自己的 when 过滤——无条件=兜底，带条件=命中才用；保持顺序。
// 含分类器条件时懒计算 label（每请求只分类一次）。
async function resolveSteps(scene, ctx) {
  const all = unifySteps(scene);
  if (all.some(s => s && s.when && s.when.type === 'classifier')) {
    const classifier = scene && scene.classifier;
    const dc = jevShadow.loadDecisionConfig(routingCfg());
    // Classify the current user intent, not the prefix of a long chat history.
    // Empty latest-user text is a real abstention, not a reason to use system text.
    const text = ctx.keyword_text != null ? ctx.keyword_text : ctx.text;
    // systemone 决策时不再叠一层 shadow；llm 决策时可旁路并行对比
    if (dc.engine === 'llm') {
      const localP = classifyInput(text, classifier);
      try {
        jevShadow.observeParallel({
          text,
          categories: classifier && classifier.categories,
          localLabelPromise: localP,
          routingCfg: routingCfg(),
          meta: { scene_name: scene && scene.scene_name || null },
        });
      } catch {}
      ctx.classifier_label = await localP;
    } else {
      ctx.classifier_label = await classifyInput(text, classifier);
    }
  }
  const selected = all.filter(s => s && (!s.when || evalWhen(s.when, ctx)));
  if (Object.hasOwn(ctx, 'classifier_label') && ctx.classifier_label == null) {
    jevShadow.logDecision({
      scene_name: scene && scene.scene_name,
      used: selected.some(s => !s.when) ? 'fallback_default' : selected.length ? 'fallback_rules' : 'no_default_route',
    });
  }
  return selected;
}

// 去掉 Claude 模型名的日期快照后缀：claude-sonnet-4-5-20250929 → claude-sonnet-4-5。
// 仅剥形如 -YYYYMMDD 的 8 位日期尾巴，不误伤 claude-haiku-4-5 这类版本号。
// 同时归一 UI 点号版本：claude-opus-4.8 → claude-opus-4-8。
function stripModelDate(m) {
  return String(m || '').replace(/-\d{8}$/, '');
}
function normalizeClaudeModelId(m) {
  return stripModelDate(m).replace(/(\d)\.(\d+)/g, '$1-$2');
}

// 统一路由：解析一个 scene 是否为「策略路由」——route-level strategy（旧）或
// 单步 strategy-only（无 model，新统一表示 steps:[{strategy}]）都算，并带出该步的 tier/provider/sharer 过滤。
function stratStepOf(scene) {
  if (!scene) return null;
  // 带条件规则(rules)的路由必须走场景/规则分支(resolveSteps 评估 token/关键字条件)，
  // 不能被"单步策略"抢先短路——否则 rules 被绕过。
  if (Array.isArray(scene.rules) && scene.rules.length) return null;
  const rScope = scene.scope || null, rTier = scene.tier || null;   // 路由级统一过滤（顶层，和 flow 并列）
  if (scene.strategy) return { strategy: scene.strategy, scope: rScope, tier: rTier, provider: null, sharer: null };
  const steps = scene.steps || [];
  // 多步都未选模型（也无显式 strategy）= UI 添加了但没配完 → 不当开放扫描，回退路由级 flow/tier
  const hasModel = steps.some(s => s && s.model);
  const hasExplicitStrategy = steps.some(s => s && s.strategy);
  if (steps.length > 1 && !hasModel && !hasExplicitStrategy) {
    const strat = scene.flow || ((rScope || rTier) ? 'fallback' : null);
    if (strat) return { strategy: strat, scope: rScope, tier: rTier, provider: null, sharer: null };
    return null;
  }
  const s = steps[0] || {};
  // 单步(或无步)且无 model = 开放式选择：策略取 step.strategy || 路由级 flow || (有 scope/tier/provider 时)fallback。
  // 默认策略路由(综合最优/实惠优先…)用路由级 flow 表达，flow 即其选优策略；纯来源/价格路由(仅个人/仅免费…)靠 scope/tier 过滤。
  // 路由级过滤(scene.scope/scene.tier)与步级合并（步级优先）。
  if (steps.length <= 1 && !s.model) {
    const scope = s.scope || rScope, tier = s.tier || rTier;
    const strat = s.strategy || scene.flow || ((scope || tier || s.provider) ? 'fallback' : null);
    if (strat) return { strategy: strat, scope: scope || null, tier: tier || null, provider: s.provider || null, sharer: s.sharer || null };
  }
  return null;
}

// 自进化路由 reward 回灌（懒加载运行时，任何异常都不影响请求）
let _routePolicyRuntime = null;
function recordRouteReward(reqCtx, model, reward01) {
  try {
    if (!_routePolicyRuntime) _routePolicyRuntime = require('./route-policy-runtime');
    _routePolicyRuntime.recordReward(reqCtx, model, reward01);
  } catch { /* 运行时不可用不影响请求 */ }
}

// 策略路由候选：扫该模态下所有 (源,模型)，按 filters 过滤，再按 strategy 排序。
// filters 两组正交条件：scope=来源(personal 个人源集 / community p2p) + tier=价格(free/paid)；
// 另有 provider(锁具体源) / model(锁具体模型)。
function buildStrategyCandidates(strategyName, filters, reqPath, skipP2P, rrKey, reqCtx) {
  const modality = modalityOf(reqPath);
  let ps = null; try { ps = require('./provider-speed'); } catch {}
  const scope = filters && filters.scope;
  const personalSet = scope === 'personal' ? new Set(collectPersonalModels()) : null;
  const cands = [];
  for (const p of enabledProviders()) {
    if (skipP2P && p.type === 'p2p') continue;
    if (scope === 'community' && p.type !== 'p2p') continue;          // 来源=社区
    if (filters && filters.tier && p.type !== filters.tier) continue; // 价格层(free/paid)
    if (filters && filters.provider && p.id !== filters.provider) continue;
    for (const m of (p.models || [])) {
      const name = typeof m === 'string' ? m : (m && m.name);
      let mtype = typeof m === 'string' ? 'chat' : (m.type || 'chat');
      if (mtype === 'vision' || mtype === 'text') mtype = 'chat';   // 图文/文本对路由都算 chat 模态
      if (!name || mtype !== modality) continue;
      if (personalSet && !personalSet.has(name)) continue;           // 来源=个人：模型须在个人源集
      if (filters && filters.model && name !== filters.model) continue;
      // 分源测速优先，避免同模型多源共享一个 TTFT
      const speedMs = ps ? ps.getProviderSpeedMs(name, p.id) : null;
      cands.push({ providerId: p.id, provider: p, providerTier: p.type, source: p.source, model: name,
                   speedMs });
    }
  }
  if (!cands.length) return [];
  return routingStrategies.orderModelCandidates(strategyName, cands, { rrKey, reqCtx });
}

// 链级流转策略：决定多个匹配条件(步)之间先走哪一步。
// fallback（默认）= 按列出顺序；cost/speed/auto = 用「每步在该策略下的最佳候选」作代表，
// 把代表们按该策略排序，得出步序。步内候选仍由各步自身 strategy 决定（两级组合）。
function orderStepsByFlow(steps, flow, reqPath, skipP2P, reqCtx) {
  const list = steps || [];
  if (!flow || flow === 'fallback' || list.length <= 1) return list;
  const reps = [];
  list.forEach((step, i) => {
    const cands = buildStrategyCandidates(flow, { scope: step.scope, tier: step.tier, provider: step.provider, model: step.model },
      reqPath, skipP2P, `flow:${i}`, reqCtx);
    if (cands[0]) reps.push({ ...cands[0], _stepIdx: i });
  });
  if (reps.length <= 1) return list;
  const ordered = routingStrategies.orderModelCandidates(flow, reps, { rrKey: 'flowsteps' });
  const seen = new Set();
  const out = [];
  for (const c of ordered) { if (!seen.has(c._stepIdx)) { seen.add(c._stepIdx); out.push(list[c._stepIdx]); } }
  list.forEach((s, i) => { if (!seen.has(i)) out.push(s); });   // 无候选的步保底追加（保持相对序）
  return out;
}

function resolveClaudeShimScene({ reqPath, origModel, isApiKeyCaller, scene }) {
  // Legacy CLI shim fallback belongs only to the native Anthropic ingress.
  // A Claude model name on Chat Completions/Responses is a real model choice,
  // not evidence that the caller is Claude Code. Explicit key bindings remain.
  return reqPath === '/v1/messages' && !isApiKeyCaller && /^claude-/i.test(origModel)
    ? scene : null;
}

/** 解析绑定场景：shim 兜底 / 精确 keyScene > Claude 名/通配 > Codex gpt-* 兜底。 */
function resolveBoundScene({
  origModel, callerKey, isApiKeyCaller, isClaudeClientName, claudeKey,
  shimClaudeScene = null, keyScene = {}, codexGptFallback = {},
}) {
  const keyBucket = (isApiKeyCaller && callerKey) ? keyScene[callerKey] : null;
  const exactKeyScene = (keyBucket && keyBucket[origModel]) || null;
  const claudeKeyScene = keyBucket
    ? ((claudeKey && keyBucket[claudeKey]) || (isClaudeClientName && keyBucket['*']) || null)
    : null;
  const codexGptScene = (!exactKeyScene && callerKey && /^gpt/i.test(origModel))
    ? codexGptFallback[callerKey]
    : null;
  return shimClaudeScene || exactKeyScene || claudeKeyScene || codexGptScene || null;
}

async function route(model, reqPath, body, res, callerKey, skipP2P = false) {
  const t0          = Date.now();
  let lastErr       = null;
  const isAnthropic = reqPath === '/v1/messages';
  const isResponses = reqPath === '/v1/responses' || reqPath === '/responses';
  const streaming   = !!body.stream;

  // 保留原始请求名 origModel。Claude 客户端模型名（claude-*）经 keyScene 透明改写成
  // 应用绑定的真实模型；claudeFrom 仅用于路由明细展示「claude名 → 真实」这层透明转化。
  const origModel = model;
  // Claude 客户端（尤其 Claude Code CLI）会发带日期快照后缀的模型名
  // （claude-sonnet-4-5-20250929）；去掉后缀匹配基名，命中 keyScene / _claudeModels 的绑定。
  const claudeKey = _claudeModels.includes(origModel)
    ? origModel
    : (() => {
      const norm = normalizeClaudeModelId(origModel);
      if (_claudeModels.includes(norm)) return norm;
      const stripped = stripModelDate(origModel);
      if (_claudeModels.includes(stripped)) return stripped;
      return null;
    })();
  // Claude 客户端路由区分（避免 Claude Code 与 Claude Desktop 互相顶掉）：
  //  - Claude Code CLI（anthropic shim）用自己的 claude.ai OAuth 调用、发标准 claude-* 名，
  //    仅 /v1/messages 且 callerKey 不在 appControls 的 key 集合里时走旧 shim 兜底；
  //  - Claude Desktop 等 api-key 应用（callerKey 命中 _appKeys）→ 按各自 keyScene[模型名] 绑定。
  const isClaudeClientName = /^claude-/i.test(origModel);
  const isApiKeyCaller = !!(callerKey && _appKeys.has(callerKey));
  const shimClaudeScene = resolveClaudeShimScene({ reqPath, origModel, isApiKeyCaller, scene: _claudeShimScene });
  // 先解析绑定，再决定是否标记 Claude 透明改写（见下 claudeFrom）
  const boundScene = resolveBoundScene({
    origModel,
    callerKey,
    isApiKeyCaller,
    isClaudeClientName,
    claudeKey,
    shimClaudeScene,
    keyScene: _keyScene,
    codexGptFallback: _codexGptFallback,
  });
  // claudeFrom 仅表示「Claude 客户端名被透明改写到其它模型」。
  // Codex 等多选若把 claude-opus-4-8 当真实模型绑进 keyScene，会自指命中；
  // 若仍标 claudeFrom，路由详情会误显示「Claude 透明映射」且请求名=实际名。
  const claudeFrom = (() => {
    if (shimClaudeScene) return origModel;
    const keyBucket = (isApiKeyCaller && callerKey) ? _keyScene[callerKey] : null;
    const slot = keyBucket
      ? ((claudeKey && keyBucket[claudeKey]) || (isClaudeClientName && keyBucket['*']) || null)
      : null;
    if (!slot) return null;
    const target = slot.steps?.[0]?.model || slot.scene_name || '';
    if (target && (target === origModel || (claudeKey && target === claudeKey))) return null;
    return claudeKey || origModel;
  })();
  // 请求模型名可带分层 codec 前缀（strategy:tier:sharer:provider:model）；上游只认裸模型名。
  // tier/provider 客户端过滤候选；strategy/sharer 通过 X-TB-Route 头交服务端（p2p 派发）执行。
  let requestTier = null, requestScope = null, requestStrategy = null, requestSharer = null, requestProvider = null;
  {
    const _provIds = new Set((_getConfig?.()?.providers || []).map((p) => p && p.id).filter(Boolean));
    const pr = parseRoute(model, _provIds);
    // 纯前缀 codec(整串都是 token、无裸模型) 另走策略分支，这里不当 model 前缀处理
    if (pr.model && !parsePureCodec(origModel)) {
      if (pr.tier || pr.scope || pr.strategy || pr.sharer || pr.provider) {
        requestTier     = pr.tier;
        requestScope    = pr.scope;
        requestStrategy = pr.strategy;
        requestSharer   = pr.sharer;
        requestProvider = pr.provider;
        model = pr.model;
      }
    }
  }
  // 交给 p2p provider 的路由指令（只在有 strategy/sharer 时挂头）
  const routeMeta = (requestStrategy || requestSharer)
    ? { strategy: requestStrategy, sharer: requestSharer } : null;

  function fail(scene_name, failedModels, providerErrors) {
    debugLog(`<<< 路由失败 fail()`, {
      requested_model: origModel,
      scene_name,
      failedModels,
      lastErr: lastErr?.message,
      lastErr_stack: lastErr?.stack,
    });
    pushLog({
      ts: t0, requested_model: origModel, model, scene_name, claude_from: claudeFrom,
      tried: failedModels?.length ? [...failedModels] : undefined,
      via: null, latency_ms: Date.now() - t0, status: 'error',
      error: lastErr?.message,
      error_code: lastErr?.code || undefined,
      provider_errors: serializeProviderErrors(providerErrors),
    });
    try {
      require('./api-retry-trace').traceGatewayClientError({
        source: 'route_fail',
        requested_model: origModel,
        model,
        scene_name,
        status: resolveFailStatus(lastErr),
        error: lastErr?.message,
        error_code: lastErr?.code,
        provider_errors: serializeProviderErrors(providerErrors),
      });
    } catch { /* ignore */ }
    recordError(model, callerKey, lastErr, reqPath); // 失败也落账，保证不丢账
    if (!res.headersSent) {
      const detail = lastErr?.message || 'all_providers_failed';
      const status = resolveFailStatus(lastErr);
      if (isAnthropic && !isResponses && lastErr?.code === 'model_not_found') {
        writeAnthropicApiError(res, status, detail, 'model_not_found');
        return;
      }
      // 模型不存在：OpenAI 兼容 error 体，便于服务端识别并下线误贡献的模型
      if (lastErr?.code === 'model_not_found') {
        const payload = isResponses
          ? codexTransform.chatErrorToResponseError({ error: { message: detail, type: 'model_not_found', code: 'model_not_found' } })
          : { error: { message: detail, type: 'model_not_found', code: 'model_not_found' } };
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return;
      }
      // Anthropic 客户端（/v1/messages）：终端错误必须是 anthropic 错误体 {type:'error',error:{...}}，
      // 否则 Claude Desktop/CLI 解析不了。之前靠 rejectOpenaiPayloadError 提前写，现改由此处统一输出。
      if (isAnthropic && !isResponses) {
        writeAnthropicApiError(res, status, detail, lastErr?.apiErrorType || 'api_error');
        return;
      }
      const payload = isResponses
        ? codexTransform.chatErrorToResponseError({ error: { message: detail, type: 'all_providers_failed' } })
        : { error: 'all_providers_failed', detail };
      res.writeHead(status, apiErrorHeaders(status));
      res.end(JSON.stringify(payload));
    }
  }

  // ── Scene route：Claude 透明名 keyScene / llm-router-* ──
  // api_key 只绑定应用（统计归因），不改写 model；模型以请求体为准。
  // Claude Desktop：keyScene[claude-*] 按 inferenceModels.name 透明改写到绑定的 route。
  // Codex：keyScene[模型名] 精确命中已绑定的多选路由；其余未知 gpt-*（内建辅助模型）才兜底到主路由。
  // boundScene 已在上方与 claudeFrom 一并解析。
  const isLlmRouter = origModel.startsWith('llm-router-');
  const interceptScene = !boundScene ? _routerModelMap[origModel] : null;
  debugLog(`route() 路由判定`, {
    requested_model: origModel,
    callerKey: callerKey?.slice(0, 20),
    has_boundScene: !!boundScene,
    boundScene_steps: boundScene?.steps,
    is_llm_router: isLlmRouter,
    has_intercept: !!interceptScene,
  });

  // ── 策略路由（route-level strategy 旧写法，或统一后的单步 strategy-only）：
  //    模型无关，扫该模态下所有 (源,模型) 候选按策略排序 + failover。step 的 tier/provider/sharer 作过滤/钉选。──
  let _stratScene = null, _stratStep = null;
  for (const cand of [boundScene, interceptScene, (isLlmRouter ? _routerModelMap[origModel] : null)]) {
    const st = stratStepOf(cand);
    if (st) { _stratScene = cand; _stratStep = st; break; }
  }
  // 纯前缀 codec 直接当 model 传（auto:free / auto:personal / community / speed:paid 等）→ 合成策略/过滤路由
  if (!_stratScene && !boundScene && !claudeFrom && !isLlmRouter) {
    const pc = parsePureCodec(origModel);
    if (pc) {
      _stratScene = { scene_name: origModel, id: origModel };
      _stratStep  = { strategy: pc.strategy || 'round-robin', scope: pc.scope || null, tier: pc.tier || null, provider: null, sharer: pc.sharer || null };
    }
  }
  if (_stratScene) {
    const stratSharer = _stratStep.sharer || requestSharer;   // 有效钉选 worker（与 stratMeta.sharer 一致）
    // 自进化路由用的请求特征（分桶 + reward 回灌）；estimateInputTokens 即含缓存的真实上下文长度
    const routeReqCtx = { modality: modalityOf(reqPath), model: origModel,
      input_tokens: estimateInputTokens(body), text: extractText(body), caller: callerKey };
    const ordered = cooldown.sink(buildStrategyCandidates(
      _stratStep.strategy, { scope: _stratStep.scope, tier: _stratStep.tier, provider: _stratStep.provider }, reqPath, skipP2P, _stratScene.id, routeReqCtx),
      (c) => coolKey(c.provider, c.model, stratSharer));   // 冷却中的候选下沉到末尾（fresh 先试，成功即返回，省空跑）
    if (!ordered.length) {
      const _flt = [_stratStep.scope, _stratStep.tier].filter(Boolean).join('/');
      lastErr = new Error(`该路由过滤(${_flt || _stratStep.strategy || 'any'})下没有可用的${modalityOf(reqPath)}模型/模型来源`);
      fail(_stratScene.scene_name, null); return;
    }
    const routeErrors = [];
    const deadSources = new Set();   // 已发生配额/鉴权级失败(429/401/403)的源，跳过其余模型加速降级
    for (const c of ordered) {
      if (deadSources.has(c.provider.id)) continue;
      {
        const p2pReject = rejectP2pIfUnconfigured(c.provider, res, isResponses);
        if (p2pReject) { lastErr = p2pAbortError(p2pReject); recordError(c.model, callerKey, lastErr, reqPath); return; }
      }
      try {
        // 策略路由：把场景策略（auto/cost…）+ 钉分享者传给 p2p 服务端，令其对该源 worker 也按策略排序/过滤
        const stratMeta = { strategy: _stratStep.strategy || null, sharer: _stratStep.sharer || requestSharer };
        const result = await callProvider(c.provider, isAnthropic, streaming, reqPath, body, c.model, res,
          (stratMeta.strategy || stratMeta.sharer) ? stratMeta : null);
        if (result.latency) reqRouter.recordLatency(c.provider.id, result.latency);
        recordProviderSpeed(c.model, c.provider, result, streaming);
        learnSlowPeers(c.model, c.provider, result, ordered.map(x => x.provider).filter(Boolean), stratSharer);
        pushLog({ ts: t0, requested_model: origModel, model: c.model, scene_name: _stratScene.scene_name, claude_from: claudeFrom,
                  tier: c.provider.type, via: c.provider.id, via_label: c.provider.label,
                  latency_ms: result.latency, first_token_ms: result.first_token_ms, status: 'ok',
                  worker: result.worker_id || undefined });
        recordStats(c.provider.id, c.model, fillMissingInputTokens(result, body), _providerTier(c.provider), callerKey, streaming, c.provider.billing_type || null, reqPath, origModel);
        reportUsage(c.provider.id, c.model, (result.input_tokens || 0) + (result.output_tokens || 0));
        cooldown.clear(coolKey(c.provider, c.model, stratSharer));   // 成功 → 源已恢复，清除冷却
        recordRouteReward(routeReqCtx, c.model, 1);   // 自进化路由：成功 → reward 1（暖启动所有策略路由）
        return;
      } catch (err) {
        if (handleP2pFatal(c.provider, err, res, isResponses)) { lastErr = err; recordError(c.model, callerKey, lastErr, reqPath); return; }
        traceRouteProviderFail(err, {
          source: 'strategy_route',
          requested_model: origModel,
          model: c.model,
          provider_id: c.provider.id,
          scene_name: _stratScene.scene_name,
          will_failover: !res.headersSent,
        });
        routeErrors.push({ id: c.provider.id, err }); lastErr = err;
        recordRouteReward(routeReqCtx, c.model, 0);   // 自进化路由：失败 → reward 0（冷却被后验吸收）
        recordProviderFail(c.provider, c.model, err, Date.now() - t0, callerKey, reqPath);
        noteCooldown(c.provider, c.model, err, stratSharer);   // 硬失败(429/401/403/402)记冷却，下次请求下沉此候选
        // 源级失效跳过：仅对「单账号多模型」的直连源有效（如 openai 一个账号下多个 gpt-* 全 429）。
        // p2p 所有模型共享同一 provider.id(tokenbank-p2p) 但各是独立 worker，一个挂不代表其它挂，
        // 绝不能因某个 p2p 模型源级失败就拉黑整个 p2p 池（否则会跳过后面能用的 agnes 等）。
        if (isSourceLevelError(err) && !isP2pProvider(c.provider)) deadSources.add(c.provider.id);
        if (res.headersSent) return fail(_stratScene.scene_name, [c.model], routeErrors);
        await pauseBeforeNextProvider(err);
      }
    }
    lastErr = pickBestRouteError(routeErrors) || lastErr;
    fail(_stratScene.scene_name, null);
    return;
  }

  const hasScene = (s) => !!(s && (s.steps?.length || s.rules?.length));
  if (hasScene(boundScene) || isLlmRouter || hasScene(interceptScene)) {
    const scene = hasScene(boundScene) ? boundScene : (interceptScene || _routerModelMap[origModel]);
    if (!hasScene(scene)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'scene_not_found', model }));
      return;
    }

    // 按请求特征选本次路由链：命中的规则链 / 默认链（零成本条件，从路径+body 提取）
    const ruleCtx = {
      modality: modalityOf(reqPath), model: origModel,
      input_tokens: estimateInputTokens(body), text: extractText(body),
      keyword_text: extractLastUserText(body), caller: callerKey,
    };
    let steps = await resolveSteps(scene, ruleCtx);
    // 链级流转策略：按 scene.flow 重排步序（步之间怎么走），fallback 保持原序
    steps = orderStepsByFlow(steps, scene.flow, reqPath, skipP2P, ruleCtx);
    if (!steps.length) {   // 规则全不命中且无默认链
      lastErr = new Error(Object.hasOwn(ruleCtx, 'classifier_label') && ruleCtx.classifier_label == null
        ? 'classifier unavailable and no fallback rule matched; configure an unconditional default step for this scene'
        : `no rule matched for ${ruleCtx.modality} request and route has no default chain`);
      fail(scene.scene_name, null, null);
      return;
    }

    const all          = enabledProviders().filter(p => !skipP2P || p.type !== 'p2p');
    const failedModels = [];
    const stepErrors   = [];

    for (const step of steps) {
      // 场景步骤就是真实模型；claudeFrom 标记原始 claude 名（路由明细展示透明转化）。
      const stepModel     = step.model;
      const stepClaudeFrom = claudeFrom;
      // 无 model 的步 = 开放式选择（strategy / 纯 tier / 纯 provider）：展开成候选逐个 failover。
      // 无显式 strategy 但有 tier/provider 时按 fallback 顺序；都没有则跳过（避免 model=undefined 发上游）。
      if (!stepModel) {
        const stepScope = step.scope || scene.scope, stepTier = step.tier || scene.tier;   // 合并路由级过滤
        const stepStrat = step.strategy || ((stepScope || stepTier || step.provider) ? 'fallback' : null);
        if (!stepStrat) continue;
        const stepSharer = step.sharer || null;   // 有效钉选 worker（与 sMeta.sharer 一致）
        const sOrdered = cooldown.sink(
          buildStrategyCandidates(stepStrat, { scope: stepScope, tier: stepTier, provider: step.provider }, reqPath, skipP2P, `${scene.id}:${stepStrat}`, ruleCtx),
          (c) => coolKey(c.provider, c.model, stepSharer));   // 冷却候选下沉
        const sMeta = { strategy: step.strategy || null, sharer: stepSharer };
        const deadSources = new Set();
        for (const c of sOrdered) {
          if (deadSources.has(c.provider.id)) continue;
          {
            const p2pReject = rejectP2pIfUnconfigured(c.provider, res, isResponses);
            if (p2pReject) { lastErr = p2pAbortError(p2pReject); recordError(c.model, callerKey, lastErr, reqPath); return; }
          }
          try {
            const result = await callProvider(c.provider, isAnthropic, streaming, reqPath, body, c.model, res, sMeta);
            pushLog({ ts: t0, requested_model: origModel, model: c.model, scene_name: scene.scene_name, claude_from: stepClaudeFrom,
              tried: failedModels.length ? [...failedModels] : undefined,
              tier: c.provider.type, via: c.provider.id, via_label: c.provider.label,
              latency_ms: result.latency, first_token_ms: result.first_token_ms, status: 'ok', worker: result.worker_id || undefined });
            recordStats(c.provider.id, c.model, fillMissingInputTokens(result, body), _providerTier(c.provider), callerKey, streaming, c.provider.billing_type || null, reqPath, origModel);
            reportUsage(c.provider.id, c.model, (result.input_tokens || 0) + (result.output_tokens || 0));
            if (result.latency) reqRouter.recordLatency(c.provider.id, result.latency);
            recordProviderSpeed(c.model, c.provider, result, streaming);
            learnSlowPeers(c.model, c.provider, result, sOrdered.map(x => x.provider).filter(Boolean), stepSharer);
            cooldown.clear(coolKey(c.provider, c.model, stepSharer));   // 成功 → 清除冷却
            recordRouteReward(ruleCtx, c.model, 1);   // 自进化路由：成功 → reward 1
            return;
          } catch (err) {
            if (handleP2pFatal(c.provider, err, res, isResponses)) { lastErr = err; recordError(c.model, callerKey, lastErr, reqPath); return; }
            traceRouteProviderFail(err, {
              source: 'scene_strategy_step',
              requested_model: origModel,
              model: c.model,
              provider_id: c.provider.id,
              scene_name: scene.scene_name,
              will_failover: !res.headersSent,
            });
            stepErrors.push({ id: c.provider.id, err }); lastErr = err;
            recordRouteReward(ruleCtx, c.model, 0);   // 自进化路由：失败 → reward 0
            recordProviderFail(c.provider, c.model, err, Date.now() - t0, callerKey, reqPath);
            noteCooldown(c.provider, c.model, err, stepSharer);   // 硬失败记冷却
            // 见上：p2p 各模型独立 worker，不能因一个源级失败拉黑整个 tokenbank-p2p 池
            if (isSourceLevelError(err) && !isP2pProvider(c.provider)) deadSources.add(c.provider.id);
            if (res.headersSent) return fail(scene.scene_name, [...failedModels, c.model], stepErrors);
            await pauseBeforeNextProvider(err);
          }
        }
        failedModels.push(step.strategy);
        continue;
      }
      // Match providers by model list；step.tier 指定时只走对应供给层（同模型跨 P2P/付费）
      let stepCandidates = all.filter(p => providerHasModel(p, stepModel, { strict: skipP2P }));
      // 步级 tier/provider + 路由级过滤(scene.scope/scene.tier)
      const mTier = step.tier || scene.tier;
      if (mTier) stepCandidates = stepCandidates.filter(p => p.type === mTier);
      if (scene.scope === 'community') stepCandidates = stepCandidates.filter(p => p.type === 'p2p');
      if (scene.scope === 'personal') { const _ps = new Set(collectPersonalModels()); if (!_ps.has(stepModel)) stepCandidates = []; }
      if (step.provider) stepCandidates = stepCandidates.filter(p => p.id === step.provider);
      // 该步的 p2p 路由指令：step 自带 strategy/sharer（Selector）优先，否则用请求级 routeMeta
      const stepMeta = (step.strategy || step.sharer)
        ? { strategy: step.strategy || null, sharer: step.sharer || null } : routeMeta;
      const stepMetaSharer = stepMeta && stepMeta.sharer;   // 有效钉选 worker（与发给服务端的 meta 一致）
      // 未锁具体源时：订阅→免费→按量，同档比速度，冷却/慢源下沉
      const stepProviders = step.provider
        ? stepCandidates
        : orderSameModelProviders(stepCandidates, stepModel, stepMetaSharer);
      let   stepSucceeded = false;

      // 识图增强：本步只预处理一次；failover 共用替换后的 body
      let stepBody = body;
      let visionMeta = null;
      if (step.vision_assist) {
        const va = await applyVisionAssistIfNeeded(step, body, { callerKey, reqPath, skipP2P });
        stepBody = va.body;
        visionMeta = va.meta;
      }

      for (const provider of stepProviders) {
        const p2pReject = rejectP2pIfUnconfigured(provider, res, isResponses);
        if (p2pReject) {
          lastErr = p2pAbortError(p2pReject);
          pushLog({
            ts: t0, requested_model: origModel, model: stepModel,
            scene_name: scene.scene_name, claude_from: stepClaudeFrom,
            tier: provider.type, via: provider.id, via_label: provider.label,
            latency_ms: Date.now() - t0, status: 'error',
            error: lastErr.message, error_code: lastErr.code || undefined,
            vision_assist: visionMeta || undefined,
          });
          recordError(stepModel, callerKey, lastErr, reqPath);
          return;
        }
        try {
          const result = await callProvider(provider, isAnthropic, streaming, reqPath, stepBody, stepModel, res, stepMeta);
          pushLog({
            ts: t0, requested_model: origModel, model: stepModel,
            scene_name: scene.scene_name, claude_from: stepClaudeFrom,
            tried: failedModels.length ? [...failedModels] : undefined,
            tier: provider.type, via: provider.id, via_label: provider.label,
            latency_ms: result.latency, first_token_ms: result.first_token_ms, status: 'ok',
            worker: result.worker_id || undefined,
            vision_assist: visionMeta || undefined,
          });
          const stepTok  = (result.input_tokens || 0) + (result.output_tokens || 0);
          const stepTier = _providerTier(provider);
          recordStats(provider.id, stepModel, fillMissingInputTokens(result, stepBody), stepTier, callerKey, streaming, provider.billing_type || null, reqPath, origModel);
          reportUsage(provider.id, stepModel, stepTok);
          if (result.latency) reqRouter.recordLatency(provider.id, result.latency);
          recordProviderSpeed(stepModel, provider, result, streaming);
          learnSlowPeers(stepModel, provider, result, stepProviders, stepMetaSharer);
          cooldown.clear(coolKey(provider, stepModel, stepMetaSharer));   // 成功 → 清除冷却
          stepSucceeded = true;
          return;
        } catch (err) {
          if (handleP2pFatal(provider, err, res, isResponses)) {
            lastErr = err;
            pushLog({
              ts: t0, requested_model: origModel, model: stepModel,
              scene_name: scene.scene_name, claude_from: stepClaudeFrom,
              tier: provider.type, via: provider.id, via_label: provider.label,
              latency_ms: Date.now() - t0, status: 'error',
              error: lastErr.message, error_code: lastErr.code || undefined,
              worker: lastErr.worker_id || undefined,
              vision_assist: visionMeta || undefined,
            });
            recordError(stepModel, callerKey, lastErr, reqPath);
            return;
          }
          traceRouteProviderFail(err, {
            source: 'scene_step',
            requested_model: origModel,
            model: stepModel,
            provider_id: provider.id,
            scene_name: scene.scene_name,
            will_failover: !res.headersSent,
          });
          stepErrors.push({ id: provider.id, err });
          lastErr = err;
          recordProviderFail(provider, stepModel, err, Date.now() - t0, callerKey, reqPath);
          noteCooldown(provider, stepModel, err, stepMetaSharer);   // 硬失败记冷却，下次请求下沉此源
          if (res.headersSent) return fail(scene.scene_name, [...failedModels, stepModel], stepErrors);
          await pauseBeforeNextProvider(err);
        }
      }
      if (!stepSucceeded) failedModels.push(stepModel);
    }

    lastErr = pickBestRouteError(stepErrors) || lastErr;
    if (isNoWorkerError(lastErr) && lastErr && !lastErr.code) lastErr.code = 'model_not_found';
    if (isP2pApiKeyError(lastErr)) {
      recordError(model, callerKey, lastErr, reqPath);
      writeP2pApiKeyRequired(res, isResponses);
      return;
    }
    if (isP2pCreditsError(lastErr)) {
      recordError(model, callerKey, lastErr, reqPath);
      writeInsufficientCredits(res, isResponses);
      return;
    }
    fail(scene.scene_name, failedModels, stepErrors);
    return;
  }

  // ── Direct model request ──────────────────────────────────────────────────
  const allEnabled = enabledProviders().filter(p => !skipP2P || p.type !== 'p2p');
  const modelMatch = { strict: skipP2P }; // 贡献节点 P2P hop：禁止空 models 列表兜底匹配

  // ★ 三层特征提取 + 策略组调度：按 policy 决定 provider 优先顺序
  let sorted;
  try {
    const { providerIds, fallthrough, features, policyRef } =
      reqRouter.resolveProviderOrder(body, callerKey, reqPath, _getLocalConfig);

    if (!fallthrough && providerIds.length > 0) {
      // 策略组有明确 provider 列表：按策略顺序排，不在策略组里的 enabled providers 追加兜底
      const inPolicy = providerIds
        .map(id => allEnabled.find(p => p.id === id))
        .filter(Boolean)
        .filter(p => providerHasModel(p, model, modelMatch));
      const others   = allEnabled.filter(p => !providerIds.includes(p.id) && providerHasModel(p, model, modelMatch));
      sorted = [...inPolicy, ...others];
      pushLog({ ts: t0, requested_model: model, model, policy: policyRef,
                features: { task_type: features.task_type, has_tools: features.has_tools,
                            context_length: features.context_length }, status: 'routing' });
    } else {
      // fallthrough：策略组为空或未匹配 → 同模型多源默认序（订阅→免费→按量 + 速度）
      const candidates = allEnabled.filter(p => providerHasModel(p, model, modelMatch));
      sorted = orderSameModelProviders(candidates, model, routeMeta && routeMeta.sharer);
    }
  } catch {
    const candidates = allEnabled.filter(p => providerHasModel(p, model, modelMatch));
    sorted = orderSameModelProviders(candidates, model, routeMeta && routeMeta.sharer);
  }

  // 请求体指定 tier 时只走对应供给层（同模型跨 P2P/付费/免费）
  if (requestTier) sorted = sorted.filter(p => p.type === requestTier);
  // codec 指定 scope=来源：personal 只走个人源模型；community 只走 p2p
  if (requestScope === 'community') sorted = sorted.filter(p => p.type === 'p2p');
  else if (requestScope === 'personal') {
    const personalSet = new Set(collectPersonalModels());
    if (!personalSet.has(model)) sorted = [];
  }
  // codec 指定 provider 时锁定该供给源
  if (requestProvider) sorted = sorted.filter(p => p.id === requestProvider);
  // P2P hop：再次确保不会选到未声明该模型的供给源（防止策略组/inPolicy 漏网）
  if (skipP2P) sorted = sorted.filter(p => providerHasModel(p, model, modelMatch));

  debugLog(`直接模型路由候选 providers`, {
    requested_model: origModel,
    resolved_model: model,
    request_tier: requestTier,
    candidate_count: sorted.length,
    candidates: sorted.map(p => ({ id: p.id, type: p.type, models: p.models })),
  });

  if (!sorted.length) {
    lastErr = modelNotFoundError(model, requestTier);
    fail(null, null, null);
    return;
  }

  const routeErrors = [];
  for (const provider of sorted) {
    const p2pReject = rejectP2pIfUnconfigured(provider, res, isResponses);
    if (p2pReject) {
      lastErr = p2pAbortError(p2pReject);
      pushLog({
        ts: t0, requested_model: origModel, model, claude_from: claudeFrom,
        tier: provider.type, via: provider.id, via_label: provider.label,
        latency_ms: Date.now() - t0, status: 'error',
        error: lastErr.message, error_code: lastErr.code || undefined,
      });
      recordError(model, callerKey, lastErr, reqPath);
      return;
    }
    try {
      const result = await callProvider(provider, isAnthropic, streaming, reqPath, body, model, res, routeMeta);
      // 记录延迟（供 latency 策略下次参考）
      if (result.latency) reqRouter.recordLatency(provider.id, result.latency);
      recordProviderSpeed(model, provider, result, streaming);
      learnSlowPeers(model, provider, result, sorted, routeMeta && routeMeta.sharer);
      cooldown.clear(coolKey(provider, model, routeMeta && routeMeta.sharer));
      pushLog({
        ts: t0, requested_model: origModel, model, claude_from: claudeFrom,
        tier: provider.type, via: provider.id, via_label: provider.label,
        latency_ms: result.latency, first_token_ms: result.first_token_ms, status: 'ok',
        worker: result.worker_id || undefined,
      });
      const directTok  = (result.input_tokens || 0) + (result.output_tokens || 0);
      const directTier = _providerTier(provider);
      recordStats(provider.id, model, fillMissingInputTokens(result, body), directTier, callerKey, streaming, provider.billing_type || null, reqPath, origModel);
      reportUsage(provider.id, model, directTok);
      return;
    } catch (err) {
      if (handleP2pFatal(provider, err, res, isResponses)) {
        lastErr = err;
        pushLog({
          ts: t0, requested_model: origModel, model, claude_from: claudeFrom,
          tier: provider.type, via: provider.id, via_label: provider.label,
          latency_ms: Date.now() - t0, status: 'error',
          error: lastErr.message, error_code: lastErr.code || undefined,
          worker: lastErr.worker_id || undefined,
        });
        recordError(model, callerKey, lastErr, reqPath);
        return;
      }
      traceRouteProviderFail(err, {
        source: 'direct_model',
        requested_model: origModel,
        model,
        provider_id: provider.id,
        will_failover: !res.headersSent,
      });
      routeErrors.push({ id: provider.id, err });
      lastErr = err;
      recordProviderFail(provider, model, err, Date.now() - t0, callerKey, reqPath);
      noteCooldown(provider, model, err, routeMeta && routeMeta.sharer);
      if (res.headersSent) return fail(null, [model], routeErrors);
      await pauseBeforeNextProvider(err);
    }
  }

  lastErr = pickBestRouteError(routeErrors) || lastErr;
  if (isNoWorkerError(lastErr) && lastErr && !lastErr.code) lastErr.code = 'model_not_found';
  if (isP2pApiKeyError(lastErr)) {
    recordError(model, callerKey, lastErr, reqPath);
    writeP2pApiKeyRequired(res, isResponses);
    return;
  }
  if (isP2pCreditsError(lastErr)) {
    recordError(model, callerKey, lastErr, reqPath);
    writeInsufficientCredits(res, isResponses);
    return;
  }
  fail(null, null, routeErrors);
}

function pushLog(entry) {
  log.push(entry);
  if (log.length > LOG_MAX) log.shift();
  _saveRouteLog();
}

// 把单次请求的真实用量（含输入/输出/缓存命中/缓存写入）推给 recorder（local-stats）。
// 兼容旧字段：tokens = input + output。
// request_id = 上游响应 id（msg_/chatcmpl_），用于与会话文件导入跨来源去重；
// data_source='proxy' 标记这是网关实时拦截记录；并补全延迟/首字/状态码/是否流式。
// 合成唯一 request_id：上游未返回 id（多为 401/502/404 等错误响应）时兜底，杜绝 NULL。
// 唯一 → 每条独立记录、不会误去重；成功响应仍优先用真实上游 msg_id（保证跨源去重）。
function synthReqId() { return 'gw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

/** api-key 命中优先；否则按协议路径挂到 shim 应用（Claude Code OAuth 无 app key） */
function resolveStatsAppId(apiKey, reqPath) {
  return appIdForKey(apiKey) || (reqPath && resolveAppControl(apiKey, reqPath)?.app_id) || null;
}

function recordStats(providerId, model, usage, tier, apiKey, streaming, billingType, reqPath, requestedModel) {
  const inTok   = usage?.input_tokens        || 0;
  const outTok  = usage?.output_tokens       || 0;
  const cCreate = usage?.cache_create_tokens || 0;
  const cRead   = usage?.cache_read_tokens   || 0;
  _statsRecorder?.({
    api_key:     apiKey     || null,
    app_id:      resolveStatsAppId(apiKey, reqPath),
    model:       model      || null,
    provider_id: providerId || null,
    tier:        tier       || null,
    tokens:               inTok + outTok,
    input_tokens:         inTok,
    output_tokens:        outTok,
    cache_create_tokens:  cCreate,
    cache_read_tokens:    cRead,
    request_id:           usage?.message_id || synthReqId(),   // 强制非空：有真实上游 msg_id 用之(跨源去重)，否则合成唯一 id
    data_source:          'proxy',
    status_code:          (usage?.status_code != null) ? usage.status_code : 200,
    is_streaming:         !!streaming,
    latency_ms:           (usage?.latency        != null) ? usage.latency        : null,
    first_token_ms:       (usage?.first_token_ms != null) ? usage.first_token_ms : null,
    // 免费源真实 USD 成本为 0；P2P 在服务端按积分结算（非 USD）。仅付费源用刊例价估算，
    // 否则免费/P2P 流量会按 Claude/GPT 刊例价虚增 dashboard 的 total_cost。
    cost_usd:             (tier === 'free' || tier === 'p2p') ? 0 : estimateCost(model, inTok, outTok, cCreate, cRead, providerId),
    billing_type:         billingType || null,
    // 客户端原本请求的模型（换模后与 model 不同）：盘点页据此估算「帮你省了多少」
    requested_model:      requestedModel || null,
  });
}

// 单个供给源失败：带上 provider_id，个人源展开才能显示「失败」而不是「无请求」
function recordProviderFail(provider, model, err, latencyMs, apiKey, reqPath) {
  if (!provider?.id || !model) return;
  _statsRecorder?.({
    api_key:     apiKey || null,
    app_id:      resolveStatsAppId(apiKey, reqPath),
    model,
    provider_id: provider.id,
    tier:        _providerTier(provider),
    tokens: 0, input_tokens: 0, output_tokens: 0,
    request_id:  synthReqId(),
    data_source: 'proxy',
    status_code: err?.status || 502,
    error:       err?.message || 'provider_failed',
    latency_ms:  (latencyMs > 0) ? latencyMs : null,
  });
}

// 失败也落账：所有 provider 都失败时记一条 0-token 的错误行（不丢账）。
// request_id 用合成唯一 id（强制非空）→ 每次失败独立记录、不会误去重。
function recordError(model, apiKey, err, reqPath) {
  _statsRecorder?.({
    api_key:     apiKey || null,
    app_id:      resolveStatsAppId(apiKey, reqPath),
    model:       model  || null,
    provider_id: null,
    tier:        null,
    tokens: 0, input_tokens: 0, output_tokens: 0,
    request_id:  synthReqId(),
    data_source: 'proxy',
    status_code: err?.status || 502,
    error:       err?.message || 'all_providers_failed',
  });
}

// Determine routing tier from provider object or id string.
// Priority: explicit config tier > known P2P id > has token + non-local URL = paid > free
const _LOCAL_URL = /localhost|127\.0\.0\.1|::1|192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./;

function _providerTier(provider) {
  if (!provider) return 'free';
  const id   = typeof provider === 'string' ? provider : (provider.id || '');
  const obj  = typeof provider === 'object' ? provider : null;
  // Explicit tier in provider config
  if (obj?.tier) return obj.tier;
  // 显式配置的层级类型（free/paid/p2p）优先于任何启发式：例如免费供给源虽带 API
  // key + 远程 URL，也应按配置记为 free，而非被下面的兜底误判为 paid。
  if (obj?.type === 'p2p' || id === 'tokenbank-p2p') return 'p2p';
  if (obj?.type === 'free') return 'free';
  if (obj?.type === 'paid') return 'paid';
  // Known paid IDs (fallback for old persisted stats that only store id)
  const KNOWN_PAID = new Set(['openai','anthropic-paid','anthropic','openrouter','deepseek','xai','fireworks']);
  if (KNOWN_PAID.has(id)) return 'paid';
  // Has API token + non-local base URL → paid
  if (obj?.token && obj?.base_url && !_LOCAL_URL.test(obj.base_url)) return 'paid';
  return 'free';
}

// Fire-and-forget: report a completed non-P2P call to the backend so it appears
// in dashboard stats. P2P calls are already recorded server-side.
// 须用户登录 JWT；未登录或仅有 P2P API Key 时不请求。
function reportUsage(providerId, model, totalTokens) {
  if (!_backendUrl || !_userJwt) return;
  const tier = _providerTier(providerId);
  if (tier === 'p2p') return; // already recorded by backend
  const body = JSON.stringify({ model, tokens: totalTokens, tier, provider_id: providerId });
  try {
    const u   = new URL(_backendUrl + '/api/gateway/record-usage');
    const mod = u.protocol === 'https:' ? require('https') : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${_userJwt}`,
      },
      timeout: 10_000,
    }, res => { res.resume(); }); // drain response
    req.on('error', () => {}); // ignore errors — best-effort
    req.write(body);
    req.end();
  } catch {}
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

// /v1/models 列表按客户端分离构建，Desktop 与 CLI/其他各走独立函数：
// ── Claude Desktop 路径：只暴露透明 mask 名（owned_by=anthropic），供 Desktop inferenceModels 校验。
function buildClaudeMaskModelList() {
  const data = [];
  for (const id of _claudeModels) {
    if (!id) continue;
    data.push({ id, object: 'model', created: 0, owned_by: 'anthropic' });
  }
  return data;
}
// ── CLI / 前端 / 其他路径：暴露各供给源 + 社区 p2p 的真实模型，不含 Desktop mask 名。
function buildDefaultModelList() {
  const data = [];
  const seen = new Set();
  const add = (id, owned, modelType) => {
    if (!id) return;
    const ob = owned || 'tokenbank';
    const key = `${ob}\0${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    data.push({
      id,
      object: 'model',
      created: 0,
      owned_by: ob,
      // chat / vision / image / embedding 四类全部透出（与客户端 Providers 对齐）
      ...(modelType && modelType !== 'chat' ? { model_type: modelType } : {}),
    });
  };
  if (isCommunityP2pEnabled()) {
    for (const id of _peerModels) add(id, 'p2p');
  }
  try {
    for (const p of enabledProviders()) {
      if (p.type === 'p2p') continue;
      for (const m of (p.models || [])) {
        const id = typeof m === 'string' ? m : m.name;
        if (_claudeModels.includes(id)) continue;   // mask 名不进通用列表，仅 Desktop 路径暴露
        add(id, p.id, providerModelType(id, p));
      }
    }
  } catch {}
  return data;
}

function handleRequest(req, res) {
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-api-key, anthropic-version, x-p2p-hop');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { method, url } = req;
  // 归一化路径：去查询串、折叠多斜杠、去尾斜杠。
  // 容忍客户端用尾斜杠 baseURL（如 http://host:11430/）拼出的 //v1/models、带 ?查询、/v1/models/ 等变体。
  const cleanPath = (url.split('?')[0] || '/').replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1');
  // /health 是 shim 探活，正常时很密，不打请求日志
  if (!(method === 'GET' && cleanPath === '/health')) {
    console.log('[gw-req]', method, url, 'auth=' + (req.headers['authorization'] ? req.headers['authorization'].slice(0,25) : (req.headers['x-api-key'] ? 'x-api-key:'+String(req.headers['x-api-key']).slice(0,18) : 'none')));
  }

  // Health
  if (method === 'GET' && cleanPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: _port }));
    return;
  }

  // 测速表（调试/前端可用）：每模型 TTFT/TPS/bucket，并用历史请求延迟兜底未测速的模型
  if (method === 'GET' && cleanPath === '/speed') {
    let latency = {};
    try {
      const since = _localStats?.sinceTsForDays ? _localStats.sinceTsForDays(7) : Math.floor(Date.now() / 1000) - 7 * 86400;
      latency = _localStats?.queryModelProviderLatency ? _localStats.queryModelProviderLatency(since) : {};
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(require('./provider-speed').getSpeedMapWithLatency(latency)));
    return;
  }

  // Models list：返回全部可用模型 + Claude 客户端模型名。
  //   Claude 模型名（claude-*）让 Claude Desktop 通过「必须 Anthropic 模型」校验、有名字可选；
  //   真实模型（在线 P2P + 各 provider）供其他客户端直接选用。
  //   Claude 发的 claude-* 请求由 keyScene（应用绑定的路由）透明改写成真实模型。
  if (method === 'GET' && (cleanPath === '/v1/models' || cleanPath === '/models')) {
    // 按 caller 分离：Claude Desktop（按 app key 命中且 app_id 属 claude-desktop）只看透明 mask 名；
    // CLI（OAuth）/前端/其他看真实源模型。
    const authRaw = req.headers['authorization'] || req.headers['x-api-key'] || '';
    const modelsKey = authRaw.startsWith('Bearer ') ? authRaw.slice(7).trim() : String(authRaw).trim();
    const modelsCtrl = resolveAppControl(modelsKey, cleanPath);
    const data = String(modelsCtrl?.app_id || '').includes('claude-desktop')
      ? buildClaudeMaskModelList()
      : buildDefaultModelList();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
    return;
  }

  // Local stats query — used by CLI/browser frontend
  if (method === 'GET' && url.startsWith('/api/local-stats')) {
    const qs   = new URL('http://x' + url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 1));
    const data = _localStats ? _localStats.queryDashboard(days) : {
      total_calls: 0, total_tokens: 0, total_cost: 0,
      tiers: { free: 0, p2p: 0, paid: 0 },
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, tokens: 0, cost_usd: 0, isNow: false })),
      daily: [],
      models: [], keys: [], providers: [], agent_sources: [],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  if (method === 'GET' && url.startsWith('/api/model-provider-latency')) {
    const qs   = new URL('http://x' + url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 7));
    const since = _localStats?.sinceTsForDays ? _localStats.sinceTsForDays(days) : Math.floor(Date.now() / 1000) - days * 86400;
    const data = _localStats?.queryModelProviderLatency
      ? _localStats.queryModelProviderLatency(since)
      : {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // 压缩比统计（盘点页用）
  if (method === 'GET' && url.startsWith('/api/compression-stats')) {
    const qs   = new URL('http://x' + url).searchParams;
    const days = Math.max(1, Math.min(365, parseInt(qs.get('days'), 10) || 1));
    let summary = { count: 0, before: 0, after: 0, saved: 0, ratio: 0, saved_usd: 0, models: [] };
    try {
      let rates = null;
      if (_localStats?.sinceTsForDays && _localStats?.queryGatewayInputCostRate) {
        rates = _localStats.queryGatewayInputCostRate(_localStats.sinceTsForDays(days));
      }
      summary = require('./compression-report').readCompressionSummary(days, rates);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(summary));
    return;
  }

  // Gateway status for CLI frontend
  if (method === 'GET' && cleanPath === '/api/gateway/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStatus()));
    return;
  }

  // TTS
  if (method === 'POST' && cleanPath === '/v1/audio/speech') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { handleTts(JSON.parse(body), res, enabledProviders); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
    });
    return;
  }

  // Embeddings
  if (method === 'POST' && cleanPath === '/v1/embeddings') {
    const authRaw = req.headers['authorization'] || req.headers['x-api-key'] || '';
    const callerKey = authRaw.startsWith('Bearer ') ? authRaw.slice(7).trim() : authRaw.trim();
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        handleEmbedding(JSON.parse(body), res, enabledProviders, {
          onComplete({ ok, status, latencyMs, origModel, model, provider, error }) {
            const t0 = Date.now() - (latencyMs || 0);
            pushLog({
              ts: t0, requested_model: origModel, model,
              via: provider?.id || null, via_label: provider?.label,
              tier: provider ? _providerTier(provider) : null,
              latency_ms: latencyMs, status: ok ? 'ok' : 'error',
              error: ok ? undefined : (error || `HTTP_${status}`),
              provider_errors: (!ok && provider) ? [{
                provider: provider.id, error: error || `HTTP_${status}`, status,
              }] : undefined,
            });
            if (ok && provider) {
              recordStats(provider.id, model, {
                status_code: status, latency: latencyMs, first_token_ms: latencyMs,
              }, _providerTier(provider), callerKey, false, provider.billing_type || null, cleanPath, origModel);
            } else if (provider) {
              recordProviderFail(provider, model, { status, message: error || `HTTP_${status}` }, latencyMs, callerKey, cleanPath);
            } else {
              recordError(model || origModel, callerKey, { status, message: error }, cleanPath);
            }
          },
        });
      }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
    });
    return;
  }

  // Image generation
  if (method === 'POST' && (cleanPath === '/v1/images/generations' || cleanPath === '/v1/images/generate')) {
    const skipP2P = !!req.headers['x-p2p-hop'];
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { handleImageGeneration(JSON.parse(body), res, enabledProviders, {
        skipP2P,
        networkProxy: (() => { try { return _getConfig()?.network_proxy; } catch { return null; } })(),
        requestTimeoutMs: resolveImageRequestTimeoutMs((() => { try { return _getConfig?.(); } catch { return null; } })()),
      }); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
    });
    return;
  }

  // Chat completions (OpenAI + Anthropic) + Codex Responses
  const isChatPath   = cleanPath === '/v1/chat/completions' || cleanPath === '/v1/messages'
                    || cleanPath === '/v1/responses' || cleanPath === '/responses';
  if (!isChatPath || method !== 'POST') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
    return;
  }

  req.on('error', (err) => {
    console.error('[gateway] request error:', err.message);
    if (!res.headersSent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'request_error' }));
    }
  });

  // Extract caller's API key (used to attribute stats to the right scene/key)
  const authRaw = req.headers['authorization'] || req.headers['x-api-key'] || '';
  const callerKey = authRaw.startsWith('Bearer ') ? authRaw.slice(7).trim() : authRaw.trim();

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks).toString();
    let body = {};
    try { body = JSON.parse(rawBody); } catch {}
    const model = body.model || '';

    console.log(`[gw] ${method} ${cleanPath} model="${model}" stream=${!!body.stream} key=${callerKey.slice(0, 20) || 'none'}`);

    // 调试：记录入站请求关键信息（不 dump 完整 body，避免日志膨胀）
    debugLog(`>>> 入站请求 ${method} ${url}`, {
      model,
      auth: callerKey.slice(0, 20),
      stream: !!body.stream,
      user_agent: req.headers['user-agent'],
    });

    // ── 应用匹配（api-key 按 key、shim 按路径，用于统计归因）────────────────
    const ctrl = resolveAppControl(callerKey, cleanPath);
    debugLog(`匹配的 app control`, ctrl ? { app_name: ctrl.app_name, has_match_key: !!ctrl.match?.key } : 'null（未匹配任何应用，按默认策略路由）');

    // ── 压缩 stage（默认关闭，opt-in）──────────────────────────────────────
    // 转发前对 chat 请求做无损 JSON 压缩，减少发给上游的输入 token。
    // 开关：cfg.compress.enabled 或环境变量 TOKENBANK_COMPRESS=1。
    if (modalityOf(cleanPath) === 'chat') {
      let compCfg = {};
      try { compCfg = _getConfig?.()?.compress || {}; } catch {}
      const enabled = process.env.TOKENBANK_COMPRESS === '1' || !!compCfg.enabled;
      if (enabled) {
        try {
          const r = compressBody(body, { enabled: true });
          if (r.saved > 0) {
            body = r.body;
            const rec = _recordCompression(model, r.before, r.after);
            debugLog('压缩 stage（无损）', { ...rec, 累计: compressionStats() });
          }
        } catch (e) { debugLog('压缩 stage 失败（跳过）', e.message); }
      }
    }

    const skipP2P = !!req.headers['x-p2p-hop'];
    try {
      await route(model, cleanPath, body, res, callerKey, skipP2P);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(port, getConfig, saveConfig, bindHost = '127.0.0.1', onListenError) {
  if (_server) return;
  // 日志管道断开（stdout/stderr 被下游关闭，如 `| head`、父进程退出）不应打断网关：
  // 否则 EPIPE 会以未捕获异常冒泡（console.log → write EPIPE）拖垮进程。吞掉即可。
  try {
    if (!process.stdout.__tbEpipeGuard) { process.stdout.on('error', () => {}); process.stdout.__tbEpipeGuard = true; }
    if (!process.stderr.__tbEpipeGuard) { process.stderr.on('error', () => {}); process.stderr.__tbEpipeGuard = true; }
  } catch {}
  _port       = port || 11430;
  _getConfig  = getConfig;
  _saveConfig = saveConfig || null;
  _server     = http.createServer(handleRequest);
  // 图像生成上游可能 30–120s 无响应字节（内部轮询），放宽服务端超时
  _server.requestTimeout = 600_000;
  _server.headersTimeout = 610_000;
  _server.listen(_port, bindHost, () => {
    console.log(`[gateway] listening on ${bindHost}:${_port}`);
  });
  _server.on('error', (err) => {
    console.error('[gateway] server error:', err.message);
    // 监听失败（主要是 EADDRINUSE 端口占用）上报给调用方处理（弹框 + 退出）
    if (typeof onListenError === 'function') { try { onListenError(err); } catch {} }
  });
}

function stop() {
  if (!_server) return;
  const s = _server;
  _server = null;
  s.close(() => {
    console.log('[gateway] stopped');
  });
}

function restart() {
  return new Promise((resolve) => {
    const port = _port;
    const getConfig = _getConfig;
    if (_server) {
      const s = _server;
      _server = null;
      s.close(() => {
        console.log('[gateway] restarting...');
        start(port, getConfig);
        resolve({ ok: true });
      });
    } else {
      start(port, getConfig);
      resolve({ ok: true });
    }
  });
}

function setStrategy() { /* deprecated */ }

function getStatus() {
  return { running: !!_server, port: _port, peerModels: [..._peerModels] };
}

function getLog() {
  return [...log].reverse(); // newest first
}

// claude-* 透明名 → route 步骤（Claude Desktop inferenceModels.name）；api_key 不在此映射
let _keyScene = {};
function setKeySceneMap(map) { _keyScene = map && typeof map === 'object' ? map : {}; }
// Claude Code CLI（anthropic shim）绑定的路由。它用 OAuth 调用、无 app key，故单独存放，
// 只对 /v1/messages 的非 api-key 调用方兜底，不影响 ST 等 OpenAI 协议客户端的真实模型选择。
let _claudeShimScene = null;
function setClaudeShimScene(scene) {
  // 接受两类有效场景：① 带 steps/rules 的模型链路由；② 空 steps 的策略/过滤路由（靠 flow/strategy/scope/tier，
  // 如综合最优/免费源）。之前只认前者 → claude shim 绑到策略路由时 _claudeShimScene 被置 null，OAuth 兜底 404。
  const valid = scene && (scene.steps?.length || scene.rules?.length || scene.flow || scene.strategy || scene.scope || scene.tier);
  _claudeShimScene = valid ? scene : null;
}
// Codex 内建 gpt-* 辅助模型的兜底路由（api_key → scene）
let _codexGptFallback = {};
function setCodexGptFallback(map) { _codexGptFallback = map && typeof map === 'object' ? map : {}; }

// Claude 客户端模型名（内部透明逻辑）：仅用于 /v1/models 暴露给 Claude + 标记 Claude 请求。
// 真实模型由 claude-* → keyScene 透明改写；其余请求以请求体 model 为准。
let _claudeModels = [];
function setClaudeModels(list) { _claudeModels = Array.isArray(list) ? list.filter(x => typeof x === 'string') : []; }

// ── 应用匹配（api-key 按 key 匹配，shim 按协议路径匹配）─────────────────────
// 每项：{ app_id, app_name, match:{key|path} }
let _appControls = [];
// api-key 应用的 caller key 集合（用于区分「api-key 应用」与「shim/OAuth 调用方」）。
let _appKeys = new Set();

function setAppControls(list) {
  _appControls = Array.isArray(list) ? list : [];
  _appKeys = new Set(_appControls.filter((c) => c && c.match && c.match.key).map((c) => c.match.key));
}

function resolveAppControl(callerKey, reqPath) {
  if (callerKey) {
    const byKey = _appControls.find(c => c.match && c.match.key && c.match.key === callerKey);
    if (byKey) return byKey;
  }
  return _appControls.find(c => c.match && c.match.path && reqPath.startsWith(c.match.path)) || null;
}

// 按 caller key 反查应用 id（api-key 应用按 key 匹配）→ 统计按稳定的 app_id 记账，
// 不受 api_key 变化/取消重新纳管影响（与 shim 用 data_source 同理）。
function appIdForKey(callerKey) {
  if (!callerKey) return null;
  const c = _appControls.find(c => c.match && c.match.key && c.match.key === callerKey);
  return c?.app_id || null;
}

function setRouterModelMap(map) {
  _routerModelMap = map && typeof map === 'object' ? map : {};
}

function setPeerModels(list) {
  _peerModels = Array.isArray(list) ? new Set(list) : new Set();
  console.log(`[gateway] P2P models updated: ${_peerModels.size} models`);
}

function setBackendConfig({ url, token } = {}) {
  _backendUrl  = url   || null;
  _cloudToken  = token || null;
  console.log(`[gateway] backend config: url=${_backendUrl} token=${_cloudToken ? '***' : 'none'}`);
}

/** 同步用户登录 JWT（登出时传 null，停止云端用量上报） */
function setUserAuth(jwt) {
  _userJwt = jwt || null;
  console.log(`[gateway] user auth: ${_userJwt ? 'logged in' : 'logged out'}`);
}

function setStatsRecorder(fn) {
  _statsRecorder = typeof fn === 'function' ? fn : null;
}

function setLocalStats(mod) {
  _localStats = mod && typeof mod.queryDashboard === 'function' ? mod : null;
}

// 注入 local-config 读取器（供策略组调度查 policies[]）
function setLocalConfigReader(fn) {
  _getLocalConfig = typeof fn === 'function' ? fn : null;
}

module.exports = {
  start, stop, restart, setStrategy, getStatus, getLog,
  setKeySceneMap, setClaudeShimScene, setCodexGptFallback, setRouterModelMap, setPeerModels, setBackendConfig, setUserAuth,
  setStatsRecorder, setLocalStats, setLocalConfigReader, setAppControls,
  setClaudeModels,
  resolveBoundScene, resolveClaudeShimScene,
  // 条件路由规则引擎（供单测/复用）
  pickSteps, evalWhen, modalityOf, estimateInputTokens, extractText, _providerTier,
  stratStepOf, encodeRouteHeader, orderStepsByFlow, buildStrategyCandidates, parsePureCodec, unifySteps,
  isP2pProvider, isP2pCreditsError, isP2pApiKeyError, hasP2pRelayKey, resolveFailStatus,
  // Responses 透传判定 / URL 拼装（供单测）
  providerSupportsResponses, resolveUpstreamUrl, providerApiFormat,
  // 格式转换（供单测/复用）：Anthropic ⇄ OpenAI（含 tool-calling）
  anthropicToOpenai, openaiToAnthropic, oaiRequestToAnthropic, anthropicRespToOai,
  // thinking / reasoning_content 多轮回传（DeepSeek 等）
  isMissingReasoningContentError, ensureReasoningContentOnAssistants,
  // Gemini 转换（供单测/复用，含 tool-calling）
  oaiToGeminiBody, geminiExtractParts, sanitizeGeminiSchema,
  // 上游 400 报文约束解析（供单测；完整 API 见 gateway-upstream-hints）
  parseFixedTemperatureError,
};
