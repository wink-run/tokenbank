// Agent CLI  stdout/stderr 解析：去 ANSI、过滤噪声、解析 Claude stream-json
'use strict';

const { expandMixedOutputSteps, normalizeLoose, looksLikeInlineReasoning, hasReasoningMeta, splitInlineReasoning, dedupeRepeatedText } = require('./inline-reasoning-split.cjs');

/** 去掉 ANSI 转义（含未带 ESC 的 [33m 形式） */
function stripAnsi(text) {
  return String(text || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\[[0-9;]+m/g, '');
}

const NOISE_PATTERNS = [
  /^Warning: no stdin data received/i,
  /^Reading additional input from stdin/i,
  /^failed to load skill/i,
  /^ERROR:/i,
  /^$/,
  /^[\s\-_=]+$/,
  // Codex CLI stderr（Rust 日志 / OAuth / MCP 连接失败）
  /Failed to refresh token/i,
  /failed to refresh available models/i,
  /worker quit with fatal/i,
  /failed to connect to websocket/i,
  /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+ERROR\s/i,
];

function isNoise(line) {
  const t = line.trim();
  if (!t) return true;
  return NOISE_PATTERNS.some(p => p.test(t));
}

function msgText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map(b => (b?.type === 'text' ? b.text : b?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** 抽取 tool_result 可读文本；图片块用占位，避免 Read PNG 时变成空串被丢弃 */
function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const b of content) {
      if (b == null) continue;
      if (typeof b === 'string') {
        if (b) parts.push(b);
        continue;
      }
      if (typeof b !== 'object') continue;
      if (typeof b.text === 'string' && b.text) {
        parts.push(b.text);
        continue;
      }
      // Claude Read 二进制图：{ type:'image', source:{ media_type, data } }
      const isImage = b.type === 'image'
        || (b.source && (b.source.type === 'base64' || b.source.media_type))
        || (typeof b.mime_type === 'string' && b.mime_type.startsWith('image/'));
      if (isImage) {
        const mime = b.mime_type || b.source?.media_type || 'image';
        parts.push(`[图片 ${mime}]`);
      }
    }
    return parts.join('\n');
  }
  if (typeof content === 'object') {
    try { return JSON.stringify(content, null, 2); } catch { return String(content); }
  }
  return String(content);
}

/** tool_result 展示文案：空内容也给占位，保证能与 tool_call 配对 */
function toolResultDisplay(content, isError = false) {
  const text = toolResultText(content).trim();
  return text || (isError ? '(失败)' : '(无输出)');
}

/** 解析 hook_response.output 内嵌 JSON，提取可读文本 */
function parseHookResponseOutput(obj) {
  const hookName = obj.hook_name || obj.hook_event || 'Hook';
  let payload = obj.output;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }

  const ctx = payload?.hookSpecificOutput?.additionalContext;
  if (typeof ctx === 'string' && ctx.trim()) {
    const text = ctx.trim();
    // 会话启动 hook 常注入超长 skill 说明，UI 只展示摘要
    if (/using-superpowers|EXTREMELY_IMPORTANT/i.test(text) && text.length > 400) {
      return [{
        stepType: 'system_event',
        content: `${hookName}：会话上下文已加载`,
        system_subtype: 'hook_response',
      }];
    }
    if (text.length <= 1200) {
      return [{ stepType: 'output', content: text }];
    }
    return [{
      stepType: 'system_event',
      content: `${hookName}：上下文就绪（${text.length} 字）`,
      system_subtype: 'hook_response',
    }];
  }

  const msg = payload?.message || obj.message;
  if (typeof msg === 'string' && msg.trim()) {
    return [{ stepType: 'system_event', content: msg.trim(), system_subtype: 'hook_response' }];
  }

  return [{
    stepType: 'system_event',
    content: `${hookName} 已响应`,
    system_subtype: 'hook_response',
  }];
}

/** Claude CLI 顶层 SDK 事件（参考 claude-code-reverse SDKMessageSchema），UI 不展示 */
const SKIP_TOP_LEVEL_JSON_TYPES = new Set([
  'rate_limit_event',
  'keep_alive',
  'auth_status',
  'tool_progress',
  'tool_use_summary',
  'prompt_suggestion',
  'control_request',
  'control_response',
  'control_cancel_request',
  'update_environment_variables',
  'task_notification',
  'task_started',
  'task_progress',
]);

/** Claude Code 启动警告：注入 API Key 时 CLI 会 prepend 到回复里 */
const CONNECTOR_WARNING_RE = /⚠️\s*claude\.ai connectors are disabled[\s\S]*?(?=\n\n|\n[^·]|$)/i;

function splitConnectorWarning(text) {
  const raw = String(text || '');
  const m = raw.match(CONNECTOR_WARNING_RE);
  if (!m) return { steps: [{ stepType: 'output', content: raw }], changed: false };
  const warning = m[0].trim();
  const rest = raw.slice(m.index + m[0].length).replace(/^\s+/, '');
  const steps = [];
  if (warning) {
    steps.push({
      stepType: 'system_event',
      content: warning,
      system_subtype: 'claude_connector_warning',
    });
  }
  if (rest) steps.push({ stepType: 'output', content: rest });
  return { steps, changed: true };
}

/** thinking 增量末尾误含 markdown/诗题开头 → 拆出 output */
function splitThinkingDeltaLeak(text) {
  const raw = String(text || '');
  const m = raw.match(/^(.*?)(\*\*\s*[《「][\s\S]*)$/)
    || raw.match(/^(.*?)(\*\s*[《「][\s\S]*)$/);
  if (m && m[1].trim().length >= 12 && hasReasoningMeta(m[1])) {
    return [
      { stepType: 'thinking', content: m[1].trim() },
      { stepType: 'output', content: m[2].trim() },
    ];
  }
  return null;
}

/** 是否与前序 output 重复（delta + 快照 + assistant 块） */
function isRedundantOutput(state, text) {
  const t = String(text || '').trim();
  const prev = String(state?.lastOutput || '').trim();
  if (!t || !prev) return false;
  if (t === prev) return true;
  const tn = normalizeLoose(t);
  const pn = normalizeLoose(prev);
  if (tn === pn) return true;
  return pn.startsWith(tn) || tn.startsWith(pn);
}

/** 是否与前序 thinking 重复（delta + 快照 + assistant 块） */
function isRedundantThinking(state, text) {
  const t = String(text || '').trim();
  const prev = String(state?.lastThinking || '').trim();
  if (!t || !prev) return false;
  if (t === prev) return true;
  const tn = normalizeLoose(t);
  const pn = normalizeLoose(prev);
  if (tn === pn) return true;
  return pn.startsWith(tn) || tn.startsWith(pn);
}

/** 合并 thinking 增量（供 streamState 跟踪） */
function mergeThinkingText(prev, next) {
  const a = String(prev || '');
  const b = String(next || '');
  if (!b) return a;
  if (!a || b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  return a + b;
}

/** 初始化/补全 stream-json 解析状态（对齐 CC stream_event 生命周期） */
function ensureStreamState(streamState) {
  if (!streamState) return null;
  if (!streamState.blockTypes) streamState.blockTypes = new Map();
  if (!streamState.blockTexts) streamState.blockTexts = new Map();
  if (!streamState.toolNamesById) streamState.toolNamesById = new Map();
  if (!streamState.toolBlockMeta) streamState.toolBlockMeta = new Map();
  if (!streamState.emittedToolUseIds) streamState.emittedToolUseIds = new Set();
  if (streamState.streaming == null) streamState.streaming = false;
  if (streamState.messageId == null) streamState.messageId = null;
  if (streamState.lastThinking == null) streamState.lastThinking = '';
  if (streamState.lastOutput == null) streamState.lastOutput = '';
  return streamState;
}

/** 从 tool_use content_block 生成工具调用步骤（按 id 去重，避免 stream_event + assistant 双发） */
function toolUseStepFromBlock(b, state) {
  if (!b || b.type !== 'tool_use') return null;
  const id = b.id || null;
  if (id && state?.emittedToolUseIds?.has(id)) return null;
  const name = String(b.name || '').trim() || 'tool';
  if (state?.toolNamesById && id) state.toolNamesById.set(id, name);
  if (id) state?.emittedToolUseIds?.add(id);
  const inputStr = b.input && typeof b.input === 'object'
    ? JSON.stringify(b.input, null, 2)
    : String(b.input || '');
  return {
    stepType: 'tool_call',
    tool_name: name,
    content: inputStr || '(无参数)',
    tool_use_id: id,
  };
}

/** 格式化 tool_use 累积的 partial JSON */
function formatToolInputJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return '(无参数)';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * 解析 content_block_delta 文本：区分 token 增量 vs CCR 全量快照
 * （ccrClient.accumulateStreamEvents 会把 text_delta 合并为 full-so-far）
 */
function resolveBlockDelta(state, index, incoming) {
  const next = String(incoming || '');
  if (!next) return null;

  const prev = state?.blockTexts?.get(index) || '';
  if (next === prev) return null;

  // 全量快照：新文本包含已有内容 → 替换而非拼接
  if (prev && next.startsWith(prev)) {
    state?.blockTexts?.set(index, next);
    return { text: next, is_delta: false, is_snapshot: true };
  }

  // 单 token 增量
  const merged = prev + next;
  state?.blockTexts?.set(index, merged);
  return { text: next, is_delta: true, is_snapshot: false };
}

function hasBlockType(blocks, type) {
  if (!blocks) return false;
  for (const t of blocks.values()) {
    if (t === type) return true;
  }
  return false;
}

/** 解析 Claude Code stream-json 单行；streamState 跟踪 content_block 类型 */
function parseClaudeJsonLine(obj, streamState) {
  if (!obj || typeof obj !== 'object') return null;

  const state = ensureStreamState(streamState);

  // 顶层 rate_limit_event 等遥测，与 system.subtype 形式等价处理
  if (SKIP_TOP_LEVEL_JSON_TYPES.has(obj.type)) return null;

  // stream-json：按 content_block / assistant 块推送（无 partial 时增量较少）
  if (obj.type === 'stream_event') {
    const evt = obj.event || {};
    const blocks = state?.blockTypes;

    // CC 流式生命周期：message_start → content_block_* → message_delta → message_stop
    if (evt.type === 'message_start') {
      blocks?.clear();
      state?.blockTexts?.clear();
      if (state) {
        state.streaming = true;
        state.messageId = evt.message?.id || null;
        state.lastThinking = '';
        state.lastOutput = '';
      }
      return [];
    }
    if (evt.type === 'message_stop') {
      // 流式结束前刷新 blockTexts，避免仅有 assistant 快照、无 delta 时丢回复
      const flushSteps = [];
      if (state?.blockTexts?.size) {
        for (const [idx, text] of state.blockTexts.entries()) {
          const t = String(text || '').trim();
          if (!t) continue;
          const blockType = blocks?.get(idx);
          // tool_use 参数 JSON 不应当回复正文刷出
          if (blockType === 'tool_use') continue;
          if (blockType === 'thinking' || blockType === 'redacted_thinking') {
            if (isRedundantThinking(state, t)) continue;
            if (state) state.lastThinking = t;
            flushSteps.push({ stepType: 'thinking', content: t, is_snapshot: true });
          } else {
            if (isRedundantOutput(state, t)) continue;
            if (state) state.lastOutput = t;
            flushSteps.push({ stepType: 'output', content: t, is_snapshot: true });
          }
        }
      }
      state?.toolBlockMeta?.clear();
      blocks?.clear();
      state?.blockTexts?.clear();
      if (state) {
        state.streaming = false;
        state.messageId = null;
      }
      return flushSteps;
    }
    if (evt.type === 'message_delta') {
      return [];
    }

    if (evt.type === 'content_block_start') {
      const cb = evt.content_block || {};
      const bt = cb.type || 'text';
      blocks?.set(evt.index, bt);
      // tool_use：记录名称，等 stop 时带完整参数发出（stream_event 不走 assistant 快照）
      if (bt === 'tool_use') {
        const name = String(cb.name || '').trim() || 'tool';
        if (state?.toolNamesById && cb.id) state.toolNamesById.set(cb.id, name);
        state?.toolBlockMeta?.set(evt.index, { id: cb.id || null, name });
        const seed = cb.input && typeof cb.input === 'object' && Object.keys(cb.input).length
          ? JSON.stringify(cb.input)
          : '';
        state?.blockTexts?.set(evt.index, seed);
      }
      return [];
    }
    // 保留 block 类型直到 message_stop（不在 stop 时 delete，避免后续 delta 误判）
    if (evt.type === 'content_block_stop') {
      const meta = state?.toolBlockMeta?.get(evt.index);
      if (meta) {
        const raw = state.blockTexts?.get(evt.index) || '';
        state.toolBlockMeta.delete(evt.index);
        state.blockTexts?.delete(evt.index);
        // 与 assistant.tool_use 去重
        if (meta.id && state?.emittedToolUseIds?.has(meta.id)) return [];
        if (meta.id) state?.emittedToolUseIds?.add(meta.id);
        return [{
          stepType: 'tool_call',
          tool_name: meta.name || 'tool',
          content: formatToolInputJson(raw),
          tool_use_id: meta.id || null,
        }];
      }
      return [];
    }

    if (evt.type === 'content_block_delta') {
      const delta = evt.delta || {};
      const blockType = blocks?.get(evt.index);

      if (delta.type === 'signature_delta') return [];
      // 累积 tool_use 参数 JSON 片段
      if (delta.type === 'input_json_delta') {
        if (blockType === 'tool_use') {
          const prev = state?.blockTexts?.get(evt.index) || '';
          state?.blockTexts?.set(evt.index, prev + String(delta.partial_json || ''));
        }
        return [];
      }

      // thinking 块：thinking_delta（CC claude.ts 严格校验 block.type === 'thinking'）
      const isThinkingBlock = blockType === 'thinking' || blockType === 'redacted_thinking';
      if (delta.type === 'thinking_delta' || (isThinkingBlock && delta.type !== 'text_delta')) {
        const raw = delta.thinking || delta.text || '';
        const resolved = resolveBlockDelta(state, evt.index, raw);
        if (!resolved) return [];

        const leak = splitThinkingDeltaLeak(resolved.text);
        if (leak) {
          return leak.map(s => ({
            ...s,
            is_delta: resolved.is_delta,
            is_snapshot: resolved.is_snapshot,
          }));
        }
        if (state) {
          state.lastThinking = resolved.is_snapshot
            ? resolved.text
            : mergeThinkingText(state.lastThinking, resolved.text);
        }
        return [{
          stepType: 'thinking',
          content: resolved.text,
          is_delta: resolved.is_delta,
          is_snapshot: resolved.is_snapshot,
        }];
      }

      // text 块：text_delta → 用户可见回复（CC extractTextContent 仅取 text 块）
      if (delta.type === 'text_delta' && delta.text) {
        if (blockType === 'thinking' || blockType === 'redacted_thinking') {
          const resolved = resolveBlockDelta(state, evt.index, delta.text);
          if (!resolved) return [];
          if (state) {
            state.lastThinking = resolved.is_snapshot
              ? resolved.text
              : mergeThinkingText(state.lastThinking, resolved.text);
          }
          return [{
            stepType: 'thinking',
            content: resolved.text,
            is_delta: resolved.is_delta,
            is_snapshot: resolved.is_snapshot,
          }];
        }
        if (blockType && blockType !== 'text') return [];

        const resolved = resolveBlockDelta(state, evt.index, delta.text);
        if (!resolved) return [];

        // 异常：尚无 text 块、text_delta 却像英文 meta → 归入 thinking（兜底）
        if (!hasBlockType(blocks, 'text') && hasBlockType(blocks, 'thinking')
          && looksLikeInlineReasoning(resolved.text)) {
          if (state) {
            state.lastThinking = resolved.is_snapshot
              ? resolved.text
              : mergeThinkingText(state.lastThinking, resolved.text);
          }
          return [{
            stepType: 'thinking',
            content: resolved.text,
            is_delta: resolved.is_delta,
            is_snapshot: resolved.is_snapshot,
          }];
        }

        const split = splitConnectorWarning(resolved.text);
        if (split.changed) {
          return split.steps.map(s => ({
            ...s,
            is_delta: s.system_subtype ? false : resolved.is_delta,
            is_snapshot: s.system_subtype ? false : resolved.is_snapshot,
          }));
        }
        if (state) {
          const full = String(state.blockTexts?.get(evt.index) || resolved.text || '').trim();
          if (full) state.lastOutput = full;
        }
        return [{
          stepType: 'output',
          content: resolved.text,
          is_delta: resolved.is_delta,
          is_snapshot: resolved.is_snapshot,
        }];
      }
    }
    return [];
  }

  // CC streamlined 输出：仅保留 text，thinking/tool_use 已剥离
  if (obj.type === 'streamlined_text' && obj.text?.trim()) {
    return [{ stepType: 'output', content: obj.text.trim(), is_snapshot: true }];
  }
  if (obj.type === 'streamlined_tool_use_summary' && obj.tool_summary?.trim()) {
    return [{
      stepType: 'system_event',
      content: obj.tool_summary.trim(),
      system_subtype: 'tool_use_summary',
    }];
  }

  if (obj.type === 'assistant') {
    const msg = obj.message || {};
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const parts = [];
    const steps = [];

    // streaming 期间 text/thinking 已由 stream_event 推送；仍须提取 tool_use（避免整包跳过丢工具名）
    if (state?.streaming) {
      for (const b of blocks) {
        const tu = toolUseStepFromBlock(b, state);
        if (tu) steps.push(tu);
      }
      return steps.length ? steps : null;
    }

    // CC content_block_stop 逐块产出 assistant（thinking-only / text-only 分离）
    if (blocks.length) {
      for (const b of blocks) {
        if (b?.type === 'thinking' || b?.type === 'reasoning' || b?.type === 'redacted_thinking') {
          if (parts.length) {
            steps.push({ stepType: 'output', content: parts.join('\n'), is_snapshot: true });
            parts.length = 0;
          }
          const think = String(b.thinking || b.text || '').trim();
          if (think) {
            if (isRedundantThinking(state, think)) continue;
            if (state) state.lastThinking = think;
            steps.push({ stepType: 'thinking', content: think, is_snapshot: true });
          }
        } else if (b?.type === 'text' && b.text?.trim()) {
          parts.push(b.text.trim());
        } else if (b?.type === 'tool_use') {
          if (parts.length) {
            steps.push({ stepType: 'output', content: parts.join('\n') });
            parts.length = 0;
          }
          const tu = toolUseStepFromBlock(b, state);
          if (tu) steps.push(tu);
        }
      }
    } else {
      const text = msgText(msg).trim();
      if (text) parts.push(text);
    }

    if (parts.length) {
      const joined = parts.join('\n');
      if (isRedundantOutput(state, joined)) {
        parts.length = 0;
      }
    }

    if (parts.length) {
      const joined = parts.join('\n');
      const split = splitConnectorWarning(joined);
      if (split.changed) {
        for (const s of split.steps) {
          if (s.stepType === 'output' && isRedundantOutput(state, s.content)) continue;
          if (s.stepType === 'output' && state) state.lastOutput = String(s.content || '').trim();
          steps.push({ ...s, is_snapshot: s.stepType === 'output' });
        }
      } else {
        if (state) state.lastOutput = joined;
        steps.push({ stepType: 'output', content: joined, is_snapshot: true });
      }
    }
    return steps.length ? steps : null;
  }

  if (obj.type === 'user') {
    const msg = obj.message || {};
    if (Array.isArray(msg.content)) {
      const steps = [];
      for (const b of msg.content) {
        if (b?.type === 'tool_result') {
          // 空/纯图片结果也必须发出，否则 UI 会一直挂起直到 closePending →「未收到结果」
          const toolName = (b.tool_use_id && state?.toolNamesById?.get(b.tool_use_id))
            || null;
          steps.push({
            stepType: 'tool_result',
            tool_name: toolName,
            content: toolResultDisplay(b.content, !!b.is_error),
            is_error: !!b.is_error,
            tool_use_id: b.tool_use_id || null,
          });
        }
      }
      if (steps.length) return steps;
    }
    return null;
  }

  if (obj.type === 'result') {
    // 终态信封:只取可读正文,绝不把整包 JSON(费用/usage/session_id)甩给 UI
    let text = '';
    if (typeof obj.result === 'string') text = obj.result;
    else if (obj.result && typeof obj.result === 'object') {
      text = String(obj.result.text || obj.result.content || obj.result.message || '').trim();
    }
    if (!text) text = String(obj.message || obj.output || '').trim();
    // 错误态可展示简短原因
    if (!text && obj.is_error) {
      const err = Array.isArray(obj.errors) ? obj.errors.filter(Boolean).join('; ') : '';
      text = err || String(obj.subtype || 'error');
    }
    if (!text) return [];
    if (isRedundantOutput(state, text)) return [];
    if (state) state.lastOutput = text;
    return [{ stepType: 'output', content: text, is_snapshot: true }];
  }

  if (obj.type === 'system' && obj.subtype === 'init') return null;

  // 内部遥测/进度事件（对齐 CC print.ts 过滤列表）
  const SKIP_SYSTEM = new Set([
    'thinking_tokens', 'thinking', 'rate_limit_event', 'hook_started',
    'hook_progress', 'task_notification', 'task_started', 'task_progress',
    'post_turn_summary', 'session_state_changed', 'status',
  ]);
  if (obj.type === 'system' && obj.subtype && SKIP_SYSTEM.has(obj.subtype)) return null;

  // SessionStart 等 hook 回调：解析 output 内嵌 JSON
  if (obj.type === 'system' && obj.subtype === 'hook_response') {
    return parseHookResponseOutput(obj);
  }

  // Claude stream-json 系统事件（API 重试等）
  if (obj.type === 'system' && obj.subtype) {
    const content = obj.subtype === 'api_retry'
      ? `API 重试 ${obj.attempt ?? '?'}/${obj.max_retries ?? '?'}`
      : String(obj.message || obj.subtype || 'system');
    return [{
      stepType: 'system_event',
      content,
      system_subtype: obj.subtype,
      attempt: obj.attempt,
      max_retries: obj.max_retries,
      retry_delay_ms: obj.retry_delay_ms,
      error_status: obj.error_status,
      message: obj.message || obj.error || null,
    }];
  }

  return null;
}

/** 统一工具步骤：与 Claude tool_use / tool_result 同构，供 ExecutionLog 一致渲染 */
function emitUnifiedToolSteps(state, {
  id, name, input, output, isError = false, callOnly = false,
}) {
  const steps = [];
  const toolName = String(name || 'tool').trim() || 'tool';
  const tid = id || null;
  const already = tid && state?.emittedToolUseIds?.has(tid);
  const inputStr = typeof input === 'string'
    ? input
    : JSON.stringify(input && typeof input === 'object' ? input : {}, null, 2);

  if (!already) {
    if (tid) state?.emittedToolUseIds?.add(tid);
    if (state?.toolNamesById && tid) state.toolNamesById.set(tid, toolName);
    steps.push({
      stepType: 'tool_call',
      tool_name: toolName,
      content: inputStr || '(无参数)',
      tool_use_id: tid,
    });
  }
  if (callOnly) return steps;

  steps.push({
    stepType: 'tool_result',
    tool_name: toolName,
    content: toolResultDisplay(output, isError),
    is_error: !!isError,
    tool_use_id: tid,
  });
  return steps;
}

function mcpResultText(result, error) {
  if (error?.message) return String(error.message);
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result.content)) return toolResultText(result.content);
  if (result.structured_content != null) {
    try { return JSON.stringify(result.structured_content, null, 2); } catch { /* ignore */ }
  }
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

/** 解析 Codex exec --json JSONL（归一到 thinking/output/tool_call/tool_result） */
function parseCodexJsonLine(obj, streamState) {
  if (!obj || typeof obj !== 'object') return null;
  const state = ensureStreamState(streamState);

  // 会话/轮次元数据，UI 不展示
  const SKIP_TYPES = new Set([
    'thread.started', 'turn.started', 'turn.completed', 'turn.failed',
  ]);
  if (SKIP_TYPES.has(obj.type)) return [];

  // 瞬态重连提示不当错误气泡
  if (obj.type === 'error') {
    const msg = String(obj.message || '').trim();
    if (!msg) return [];
    if (/^Reconnecting/i.test(msg)) {
      return [{ stepType: 'system_event', content: msg, system_subtype: 'reconnect' }];
    }
    return [{ stepType: 'terminal', content: msg }];
  }

  // item.started / updated / completed
  if (obj.type === 'item.started' || obj.type === 'item.updated' || obj.type === 'item.completed') {
    const item = obj.item || {};
    const itemType = item.type || item.item_type || '';
    const id = item.id || null;
    const done = obj.type === 'item.completed';
    const failed = item.status === 'failed' || !!item.is_error;

    if (itemType === 'reasoning') {
      const text = String(item.text || item.message || '').trim();
      return text ? [{ stepType: 'thinking', content: text }] : [];
    }
    if (itemType === 'agent_message' || itemType === 'assistant_message' || itemType === 'message') {
      const text = String(item.text || item.message || msgText(item) || '').trim();
      return text ? [{ stepType: 'output', content: text, is_snapshot: true }] : [];
    }
    if (itemType === 'command_execution') {
      return emitUnifiedToolSteps(state, {
        id,
        name: 'Bash',
        input: { command: item.command || '', description: '执行命令' },
        output: item.aggregated_output ?? '',
        isError: failed || (item.exit_code != null && item.exit_code !== 0),
        callOnly: !done,
      });
    }
    if (itemType === 'mcp_tool_call') {
      const server = item.server || 'mcp';
      const tool = item.tool || item.name || 'tool';
      return emitUnifiedToolSteps(state, {
        id,
        name: `mcp__${server}__${tool}`,
        input: item.arguments ?? {},
        output: mcpResultText(item.result, item.error),
        isError: failed || !!item.error,
        callOnly: !done,
      });
    }
    if (itemType === 'file_change' && done) {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map(c => c.path).filter(Boolean);
      const kinds = new Set(changes.map(c => c.kind));
      let name = 'Edit';
      if (kinds.size === 1 && kinds.has('add')) name = 'Write';
      if (kinds.size === 1 && kinds.has('delete')) name = 'Edit';
      const summary = changes.map(c => `${c.kind || 'update'} ${c.path || ''}`).join('\n');
      return emitUnifiedToolSteps(state, {
        id,
        name,
        input: { files: paths, changes },
        output: summary || (failed ? '文件变更失败' : '文件已变更'),
        isError: failed,
      });
    }
    if (itemType === 'web_search' && done) {
      return emitUnifiedToolSteps(state, {
        id,
        name: 'WebSearch',
        input: { query: item.query || '' },
        output: item.query ? `已搜索：${item.query}` : '(无查询)',
        isError: false,
      });
    }
    if (itemType === 'todo_list') {
      const todos = Array.isArray(item.items) ? item.items : [];
      return emitUnifiedToolSteps(state, {
        id,
        name: 'TodoWrite',
        input: { todos },
        output: todos.map(t => `${t.completed ? '✓' : '○'} ${t.text || ''}`).join('\n'),
        isError: false,
        callOnly: !done && obj.type === 'item.started',
      });
    }
    if (itemType === 'error' && done) {
      const msg = String(item.message || '').trim();
      return msg ? [{ stepType: 'system_event', content: msg, system_subtype: 'codex_item_error' }] : [];
    }
    if (itemType === 'function_call' || itemType === 'tool_call') {
      const inputStr = typeof item.arguments === 'string'
        ? item.arguments
        : JSON.stringify(item.arguments || item.input || {}, null, 2);
      return emitUnifiedToolSteps(state, {
        id,
        name: item.name || 'tool',
        input: inputStr,
        output: '',
        callOnly: !done,
        isError: failed,
      });
    }
    if (itemType === 'function_call_output' || itemType === 'tool_result') {
      const out = toolResultText(item.output ?? item.content ?? item.text).trim();
      const name = (id && state?.toolNamesById?.get(id)) || item.name || null;
      return [{
        stepType: 'tool_result',
        tool_name: name,
        content: out || '(无输出)',
        is_error: failed,
        tool_use_id: id,
      }];
    }
    // 未知 item：有正文才当 output，避免空数组误丢
    const fallback = String(item.text || item.message || '').trim();
    return fallback ? [{ stepType: 'output', content: fallback }] : [];
  }

  if (obj.type === 'event_msg') {
    const pt = obj.payload?.type;
    if (pt === 'agent_message') {
      const text = String(obj.payload.message || '').trim();
      if (text) return [{ stepType: 'output', content: text }];
    }
    if (pt === 'token_count' || pt === 'stream_error') return null;
    return null;
  }

  if (obj.type === 'response_item') {
    const p = obj.payload || {};
    if (p.type === 'function_call') {
      return emitUnifiedToolSteps(state, {
        id: p.id || p.call_id || null,
        name: p.name || 'tool',
        input: typeof p.arguments === 'string' ? p.arguments : (p.arguments || {}),
        callOnly: true,
      });
    }
    if (p.type === 'function_call_output' || p.type === 'tool_result') {
      const text = toolResultText(p.output ?? p.content).trim();
      if (text) {
        return [{
          stepType: 'tool_result',
          tool_name: p.name || null,
          content: text,
          is_error: !!p.is_error,
          tool_use_id: p.call_id || p.id || null,
        }];
      }
    }
    if (p.type === 'message' && p.role === 'assistant') {
      const text = msgText({ content: p.content }).trim();
      if (text) return [{ stepType: 'output', content: text }];
    }
    if (p.type === 'reasoning') {
      const text = msgText({ content: p.content }).trim();
      if (text) return [{ stepType: 'thinking', content: text }];
    }
  }

  return null;
}

/** Cursor call_id 偶发带换行，取首段 */
function normalizeCursorCallId(raw) {
  const s = String(raw || '').split(/[\r\n]/)[0].trim();
  return s || null;
}

/** shellToolCall → Bash；readToolCall → Read */
function cursorToolDisplayName(toolKey) {
  const short = String(toolKey || '').replace(/ToolCall$/i, '');
  const key = short.charAt(0).toLowerCase() + short.slice(1);
  const map = {
    shell: 'Bash',
    bash: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    delete: 'Delete',
    grep: 'Grep',
    glob: 'Glob',
    ls: 'LS',
    semSearch: 'SemSearch',
    mcp: 'MCP',
    todo: 'Todo',
  };
  if (map[key]) return map[key];
  if (map[short.toLowerCase()]) return map[short.toLowerCase()];
  return short || 'tool';
}

/** 从 Cursor tool_call.*ToolCall.args 提取展示用入参 */
function cursorToolArgsInput(args) {
  if (args == null) return {};
  if (typeof args === 'string') return args;
  if (typeof args !== 'object') return String(args);
  if (typeof args.command === 'string') return args.command;
  return args;
}

/** 从 Cursor tool_call.*ToolCall.result 提取 stdout / content */
function cursorToolResultText(result) {
  if (result == null) return { text: '', isError: false };
  if (typeof result === 'string') return { text: result, isError: false };
  if (typeof result !== 'object') return { text: String(result), isError: false };

  if (result.failure) {
    const f = result.failure;
    const text = [f.stderr, f.stdout, f.message, f.error]
      .map(x => (x == null ? '' : String(x)))
      .filter(Boolean)
      .join('\n')
      || JSON.stringify(f, null, 2);
    return { text, isError: true };
  }

  const success = result.success != null ? result.success : result;
  if (typeof success === 'string') return { text: success, isError: false };
  if (success && typeof success === 'object') {
    if (success.stdout != null || success.stderr != null) {
      return {
        text: [success.stdout, success.stderr].filter(x => x != null && String(x)).join('\n'),
        isError: Number(success.exitCode) > 0,
      };
    }
    if (success.content != null) return { text: String(success.content), isError: false };
    // write/read 元数据
    if (success.path || success.linesCreated != null || success.totalLines != null) {
      return { text: JSON.stringify(success, null, 2), isError: false };
    }
    return { text: JSON.stringify(success, null, 2), isError: false };
  }
  return { text: JSON.stringify(result, null, 2), isError: false };
}

/**
 * Cursor stream-json：type=tool_call subtype=started|completed
 * → tool_call / tool_result（与 Claude/Codex 同构）
 */
function parseCursorToolCallEvent(obj, streamState) {
  if (obj?.type !== 'tool_call') return null;
  const state = ensureStreamState(streamState);
  const subtype = String(obj.subtype || '');
  const callId = normalizeCursorCallId(obj.call_id || obj.toolCallId);
  const wrap = obj.tool_call && typeof obj.tool_call === 'object' ? obj.tool_call : {};

  // 官方：tool_call.readToolCall / shellToolCall / writeToolCall …
  let toolKey = null;
  let toolBody = null;
  for (const [k, v] of Object.entries(wrap)) {
    if (/ToolCall$/i.test(k) && v && typeof v === 'object') {
      toolKey = k;
      toolBody = v;
      break;
    }
  }
  // 兼容：tool_call.function = { name, arguments }
  if (!toolBody && wrap.function && typeof wrap.function === 'object') {
    toolKey = 'functionToolCall';
    toolBody = {
      args: (() => {
        const a = wrap.function.arguments;
        if (typeof a === 'string') {
          try { return JSON.parse(a); } catch { return { raw: a }; }
        }
        return a && typeof a === 'object' ? a : {};
      })(),
      result: wrap.function.result,
      _name: wrap.function.name,
    };
  }
  if (!toolBody) return [];

  const name = toolBody._name
    ? String(toolBody._name)
    : cursorToolDisplayName(toolKey);
  const args = toolBody.args || {};
  const input = cursorToolArgsInput(args);

  if (subtype === 'started') {
    return emitUnifiedToolSteps(state, {
      id: callId,
      name,
      input,
      callOnly: true,
    });
  }

  if (subtype === 'completed') {
    const { text, isError } = cursorToolResultText(toolBody.result);
    return emitUnifiedToolSteps(state, {
      id: callId,
      name,
      input,
      output: text || (isError ? '(失败)' : '(无输出)'),
      isError,
      callOnly: false,
    });
  }

  // 未知 subtype：忽略，避免原始 JSON 当正文
  return [];
}

/**
 * Cursor agent transcript / JSONL → 与 Claude/Codex 同构步骤
 * 兼容：stream-json tool_call 事件、{ role, message.content[] }、type=assistant
 */
function parseCursorJsonLine(obj, streamState) {
  if (!obj || typeof obj !== 'object') return null;

  // 官方 stream-json tool 生命周期
  if (obj.type === 'tool_call') {
    return parseCursorToolCallEvent(obj, streamState);
  }

  // 系统/用户事件不进对话步骤
  if (obj.type === 'system' || obj.type === 'user') return [];

  // stream-json assistant：{ type:"assistant", message:{ content:[{type:text}] } }
  if (obj.type === 'assistant' && obj.message) {
    const msg = obj.message;
    const blocks = Array.isArray(msg.content) ? msg.content : null;
    if (blocks) {
      const steps = [];
      for (const b of blocks) {
        if (b?.type === 'text' && b.text?.trim()) {
          steps.push({ stepType: 'output', content: b.text.trim(), is_snapshot: true });
        } else if (b?.type === 'thinking' || b?.type === 'reasoning') {
          const think = String(b.thinking || b.text || '').trim();
          if (think) steps.push({ stepType: 'thinking', content: think, is_snapshot: true });
        }
      }
      return steps;
    }
    const text = msgText(msg).trim();
    return text ? [{ stepType: 'output', content: text, is_snapshot: true }] : [];
  }

  // 终态 result：全文已在 assistant 事件展示过，跳过避免重复
  if (obj.type === 'result') return [];

  // Cursor 会话 JSONL：role + message.content blocks
  if (obj.role === 'assistant' || obj.role === 'user') {
    const msg = obj.message || {};
    const blocks = Array.isArray(msg.content) ? msg.content : null;
    if (!blocks) {
      const text = msgText(msg).trim();
      if (!text) return [];
      if (obj.role === 'user') return []; // 用户输入由 UI 侧维护
      return [{ stepType: 'output', content: text, is_snapshot: true }];
    }
    const steps = [];
    const state = ensureStreamState(streamState);
    for (const b of blocks) {
      const t = b?.type;
      if (t === 'tool_use' || t === 'tool-call') {
        const tu = toolUseStepFromBlock(
          { type: 'tool_use', id: b.id, name: b.name, input: b.input || b.arguments },
          state,
        );
        if (tu) steps.push(tu);
      } else if (t === 'tool_result') {
        steps.push({
          stepType: 'tool_result',
          tool_name: (b.tool_use_id && state?.toolNamesById?.get(b.tool_use_id)) || b.name || null,
          content: toolResultDisplay(b.content, !!b.is_error),
          is_error: !!b.is_error,
          tool_use_id: b.tool_use_id || null,
        });
      } else if (t === 'thinking' || t === 'reasoning' || t === 'redacted_thinking') {
        const think = String(b.thinking || b.text || '').trim();
        if (think) steps.push({ stepType: 'thinking', content: think, is_snapshot: true });
      } else if (t === 'text' && b.text?.trim()) {
        steps.push({ stepType: 'output', content: b.text.trim(), is_snapshot: true });
      }
    }
    return steps.length ? steps : [];
  }

  // 部分 Cursor 导出直接给 tool 角色
  if (obj.role === 'tool' || obj.type === 'tool_result') {
    return [{
      stepType: 'tool_result',
      tool_name: obj.name || null,
      content: toolResultDisplay(obj.content ?? obj.message?.content, !!obj.is_error),
      is_error: !!obj.is_error,
      tool_use_id: obj.tool_use_id || obj.toolCallId || null,
    }];
  }

  return null; // 交给 Claude stream-json 兜底
}

function detectPlainStepType(line) {
  if (/thinking|analyzing|reasoning/i.test(line)) return 'thinking';
  if (/tool use|using tool|calling tool|tool:|^\s*⎿/i.test(line)) return 'tool_call';
  if (/edit:|modif|wrote|created|updated file/i.test(line)) return 'code_edit';
  if (/^\$\s|run:|execut|bash:|shell:/i.test(line)) return 'terminal';
  return 'output';
}

/** 提取 Kimi assistant.content 为纯文本 */
function kimiContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return String(content || '');
}

/**
 * Kimi 常把推理与回复粘在同一 content（无 thinking 块）。
 * 归一为 thinking / output，与 Claude / Codex 展示一致。
 */
function splitKimiAssistantContent(text) {
  const raw = dedupeRepeatedText(String(text || '')).trim();
  if (!raw) return [];

  const shared = splitInlineReasoning(raw);
  if (shared.length >= 2) return shared;

  // "...answer.4" / "...tools.1\n\n2\n\n3"
  const gluedNum = raw.match(/^(The user[\s\S]*?[.!?])(\d[\s\S]*)$/);
  if (gluedNum && (looksLikeInlineReasoning(gluedNum[1]) || /\bThe user\b/i.test(gluedNum[1]))) {
    return [
      { stepType: 'thinking', content: gluedNum[1].trim() },
      { stepType: 'output', content: gluedNum[2].trim() },
    ];
  }

  // "...lines.The file ... **2 lines**" / markdown 正文
  const gluedMd = raw.match(
    /^(The user[\s\S]+?)((?:The |Here |Sure |I |[\u4e00-\u9fff]).{0,120}\*\*[\s\S]+)$/,
  );
  if (gluedMd) {
    return [
      { stepType: 'thinking', content: gluedMd[1].trim() },
      { stepType: 'output', content: gluedMd[2].trim() },
    ];
  }

  // 无 The user 前缀但「短句.Markdown 重述」
  const dupMd = raw.match(/^((?:The |I )[^.!?\n]+[.!?])((?:The |I |Here ).*\*\*[\s\S]+)$/);
  if (dupMd) {
    return [
      { stepType: 'thinking', content: dupMd[1].trim() },
      { stepType: 'output', content: dupMd[2].trim() },
    ];
  }

  // 纯推理（随后通常跟 tool_calls）
  if (looksLikeInlineReasoning(raw) || /^The user\b/i.test(raw) || hasReasoningMeta(raw)) {
    return [{ stepType: 'thinking', content: raw }];
  }

  return shared.length ? shared : [{ stepType: 'output', content: raw }];
}

/**
 * Kimi stream-json → thinking / output / tool_call / tool_result（与 Claude 同构）
 */
function parseKimiJsonLine(obj, streamState) {
  const state = ensureStreamState(streamState);
  if (!obj || typeof obj !== 'object') return [];

  if (obj.role === 'meta') return [];

  if (obj.role === 'tool') {
    const tid = obj.tool_call_id || obj.tool_use_id || null;
    const name = (tid && state?.toolNamesById?.get(tid)) || 'tool';
    return [{
      stepType: 'tool_result',
      tool_name: name,
      content: kimiContentText(obj.content).trim() || '(无输出)',
      tool_use_id: tid,
    }];
  }

  if (obj.role !== 'assistant') return [];

  const steps = [];
  const text = kimiContentText(obj.content).trim();
  const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];

  if (text) {
    if (toolCalls.length) {
      // 有工具调用时 content 多为推理
      steps.push({ stepType: 'thinking', content: text });
    } else {
      steps.push(...splitKimiAssistantContent(text));
    }
  }

  for (const tc of toolCalls) {
    if (!tc || typeof tc !== 'object') continue;
    const id = tc.id || null;
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : {};
    const name = String(fn.name || tc.name || 'tool').trim() || 'tool';
    let args = fn.arguments != null ? fn.arguments : tc.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* 保留原字符串 */ }
    }
    const inputStr = typeof args === 'string'
      ? args
      : JSON.stringify(args && typeof args === 'object' ? args : {}, null, 2);
    if (id && state?.emittedToolUseIds?.has(id)) continue;
    if (id) state?.emittedToolUseIds?.add(id);
    if (state?.toolNamesById && id) state.toolNamesById.set(id, name);
    steps.push({
      stepType: 'tool_call',
      tool_name: name,
      content: inputStr || '(无参数)',
      tool_use_id: id,
    });
  }

  return steps;
}

/**
 * 解析单行 CLI 输出 → 0..n 个步骤 { stepType, content, tool_name? }
 */
function parseAgentOutputLine(rawLine, agentId, streamState) {
  const line = stripAnsi(rawLine).trimEnd();
  if (isNoise(line)) return [];

  if (line.startsWith('{')) {
    try {
      const obj = JSON.parse(line);
      const aid = String(agentId || '');
      const isCodex = aid === 'codex';
      const isCursor = aid === 'cursor' || aid === 'cursor-agent';
      const isKimi = aid === 'kimi-code';

      let parsed = null;
      if (isCodex) {
        parsed = parseCodexJsonLine(obj, streamState);
      } else if (isCursor) {
        // Cursor transcript 优先；否则与 Claude stream-json 同构
        parsed = parseCursorJsonLine(obj, streamState);
        if (parsed == null) parsed = parseClaudeJsonLine(obj, streamState);
      } else if (isKimi) {
        parsed = parseKimiJsonLine(obj, streamState);
      } else {
        parsed = parseClaudeJsonLine(obj, streamState);
      }

      if (Array.isArray(parsed)) {
        // 空数组 = 已消费(含 result 重复/遥测),禁止再当纯文本
        if (!parsed.length) return [];
        return expandMixedOutputSteps(parsed);
      }
      // parsed === null:仍可能是已知信封
      if (isCodex) return [];
      if (obj.type === 'assistant' || obj.type === 'system' || obj.type === 'user'
        || obj.type === 'result'
        || obj.type === 'event_msg' || obj.type === 'response_item'
        || obj.type === 'stream_event'
        || obj.type === 'streamlined_text'
        || obj.type === 'streamlined_tool_use_summary'
        || obj.role === 'assistant' || obj.role === 'user' || obj.role === 'tool'
        || SKIP_TOP_LEVEL_JSON_TYPES.has(obj.type)) {
        return [];
      }
    } catch {
      // 不完整的 stream-json 信封:等后续字节凑齐,切勿当正文展示
      if (/^\{\s*"type"\s*:\s*"(result|assistant|system|user|tool_call|stream_event|streamlined_text|streamlined_tool_use_summary)"/
        .test(line.trim())) {
        return [];
      }
      if (/^\{\s*"type"\s*:\s*"(item\.|thread\.|turn\.|event_msg|response_item)/.test(line.trim())) {
        return [];
      }
      if (/^\{\s*"role"\s*:\s*"(assistant|user|tool)"/.test(line.trim())) {
        return [];
      }
    }
  }

  const trimmed = line.trim();
  if (!trimmed || isNoise(trimmed)) return [];

  // 整行已是 result 信封(极端兜底)
  if (/^\{\s*"type"\s*:\s*"result"/.test(trimmed) && /"subtype"\s*:/.test(trimmed)) {
    return [];
  }

  return [{
    stepType: detectPlainStepType(trimmed),
    content: trimmed,
  }];
}

/** 判断字符串是否像文件路径（排除误匹配的 skill 正文等） */
function isLikelyFilePath(raw) {
  const p = String(raw || '').trim();
  if (!p || p.length > 512) return false;
  // 含转义换行或真实换行 → 多半是正文而非路径
  if (/\\n|\\r|[\n\r]/.test(p)) return false;
  if (/^#+\s|^---|\*\*/.test(p)) return false;
  if (/^(true|false|null)$/i.test(p)) return false;
  return /[/\\]/.test(p) || /\.[a-z0-9]{1,8}$/i.test(p) || /^[\w.-]+$/.test(p);
}

/**
 * 从 CLI stdout 提取 Write/Edit 等工具修改的文件路径
 * - 优先解析 stream-json 中的 tool_use
 * - 跳过 JSON 行内的 Created: 误匹配（避免把 skill 正文当路径）
 */
function extractModifiedFiles(rawStdout) {
  const files = [];
  const seen = new Set();

  const addFile = (filePath, operation) => {
    const p = String(filePath || '').trim();
    if (!isLikelyFilePath(p)) return;
    const op = String(operation || 'modified').toLowerCase();
    const key = `${op}:${p}`;
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ path: p, operation: op });
  };

  for (const line of String(rawStdout || '').split('\n')) {
    const trimmed = stripAnsi(line).trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed);
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          for (const b of obj.message.content) {
            if (b?.type !== 'tool_use') continue;
            const name = String(b.name || '').toLowerCase();
            const input = b.input && typeof b.input === 'object' ? b.input : {};
            const fp = input.file_path || input.path || input.file;
            if (!fp) continue;
            if (name === 'write') addFile(fp, 'created');
            else if (name === 'edit' || name === 'multiedit') addFile(fp, 'modified');
          }
        }
      } catch { /* 非完整 JSON */ }
      continue;
    }

    // 纯文本行 fallback（整行匹配，避免 JSON 子串误伤）
    const match = trimmed.match(/^(Created|Modified|Edited):\s+(.+)$/i);
    if (match) addFile(match[2].trim(), match[1].toLowerCase());
  }

  return files;
}

/** Claude Code --output-format json：提取最终 result 对象 */
function extractClaudeResultObject(rawStdout) {
  const lines = stripAnsi(rawStdout).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.type === 'result') return obj;
    } catch { /* ignore */ }
  }
  const trimmed = stripAnsi(rawStdout).trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.type === 'result') return obj;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Claude Code 同步 JSON 输出 → 步骤（进程结束后一次性解析）
 */
function parseClaudeSyncStdout(rawStdout) {
  const obj = extractClaudeResultObject(rawStdout);
  if (!obj) return { steps: [], sessionId: extractCliSessionId(rawStdout, 'claude-code') };

  const sessionId = normalizeCliSessionId(obj.session_id || obj.sessionId);

  if (obj.is_error || obj.subtype === 'error_during_execution') {
    const err = Array.isArray(obj.errors) && obj.errors.length
      ? obj.errors.join('\n')
      : (typeof obj.error === 'string' && obj.error.trim()
        ? obj.error.trim()
        : (extractAuthFailureFromStdout(rawStdout) || 'Agent 执行失败'));
    return {
      steps: [{ stepType: 'terminal', content: err, is_snapshot: true }],
      sessionId,
      error: err,
    };
  }

  let rawResult = dedupeRepeatedText(String(obj.result || '').trim());
  if (!rawResult) return { steps: [], sessionId };

  const steps = expandMixedOutputSteps(splitInlineReasoning(rawResult))
    .map(s => ({ ...s, is_snapshot: true }));

  if (!steps.length) {
    steps.push({ stepType: 'output', content: rawResult, is_snapshot: true });
  }

  return { steps, sessionId, error: null };
}

/** 从 CLI stdout 提取 session/thread id，供续接对话 */
function normalizeCliSessionId(raw) {
  const s = String(raw || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
    ? s
    : null;
}

function normalizeKimiSessionId(raw) {
  const s = String(raw || '').trim();
  // kimi: session_<uuid> 或裸 uuid
  if (/^session_[0-9a-f-]{36}$/i.test(s)) return s;
  const uuid = normalizeCliSessionId(s);
  return uuid ? `session_${uuid}` : null;
}

function extractCliSessionId(rawStdout, agentId = 'claude-code') {
  for (const line of String(rawStdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (agentId === 'kimi-code') {
        // {"role":"meta","type":"session.resume_hint","session_id":"session_..."}
        if (obj.role === 'meta' && obj.session_id) {
          return normalizeKimiSessionId(obj.session_id);
        }
        if (obj.type === 'session.resume_hint' && obj.session_id) {
          return normalizeKimiSessionId(obj.session_id);
        }
        continue;
      }
      if (agentId === 'codex' && obj.type === 'thread.started') {
        return normalizeCliSessionId(obj.thread_id || obj.threadId);
      }
      if (obj.type === 'system' && obj.subtype === 'init') {
        return normalizeCliSessionId(obj.session_id || obj.sessionId);
      }
      if (obj.type === 'result') {
        return normalizeCliSessionId(obj.session_id || obj.sessionId);
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** 从 stdout 文本提炼 Claude/Codex OAuth 失效类错误（result 常无 errors 字段） */
function extractAuthFailureFromStdout(rawStdout) {
  const text = stripAnsi(rawStdout || '');
  if (/Failed to authenticate:\s*OAuth session expired/i.test(text)
    || /OAuth session expired and could not be refreshed/i.test(text)) {
    return 'Claude 登录已过期，无法刷新。请在终端执行 `claude /login` 重新登录，或确认 Claude Code 已绑路由走网关。';
  }
  if (/Failed to authenticate:/i.test(text)) {
    const m = text.match(/Failed to authenticate:\s*([^\n]+)/i);
    return m ? `Claude 认证失败：${m[1].trim()}` : 'Claude 认证失败，请重新登录。';
  }
  return null;
}

/** stream-json 中 result 标记失败（exit 0 但执行出错，如 --resume 无效） */
function detectAgentExecutionFailure(rawStdout) {
  let sawErrorResult = false;
  for (const line of String(rawStdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type !== 'result') continue;
      if (!obj.is_error && obj.subtype !== 'error_during_execution') continue;
      if (Array.isArray(obj.errors) && obj.errors.length) return obj.errors.join('\n');
      if (typeof obj.error === 'string' && obj.error.trim()) return obj.error.trim();
      // result 仅标失败、无文案：先记下来，再从 stdout 抽认证错误
      sawErrorResult = true;
    } catch { /* ignore */ }
  }
  if (sawErrorResult) {
    return extractAuthFailureFromStdout(rawStdout) || 'Agent 执行失败';
  }
  return null;
}

/**
 * 将原始 stdout 解析为步骤后，拼成可读摘要（供 MCP / 任务结果展示）
 */
function summarizeAgentStdout(rawStdout, agentId = 'claude-code') {
  if (agentId === 'claude-code') {
    const sync = parseClaudeSyncStdout(rawStdout);
    const outputs = sync.steps
      .filter(s => s.stepType === 'output' && s.content?.trim())
      .map(s => s.content.trim());
    if (outputs.length) return outputs.join('\n\n');
  }

  const lines = String(rawStdout || '').split('\n');
  const parts = [];
  for (const line of lines) {
    for (const step of parseAgentOutputLine(line, agentId)) {
      if (step.stepType === 'output' && step.content?.trim()) {
        parts.push(step.content.trim());
      } else if (step.stepType === 'tool_call' && step.content) {
        parts.push(`[工具 ${step.tool_name || 'call'}]\n${step.content}`);
      } else if (step.stepType === 'system_event' && step.content) {
        parts.push(step.content);
      }
    }
  }
  const summary = parts.join('\n\n').trim();
  if (summary) return summary;

  // 兜底：尝试从原始 JSONL 提取 agent_message / item.completed
  if (agentId === 'codex') {
    const fallback = [];
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'item.completed' && obj.item?.type === 'agent_message') {
          const t = String(obj.item.text || '').trim();
          if (t) fallback.push(t);
        }
      } catch { /* ignore */ }
    }
    if (fallback.length) return fallback.join('\n\n');
  }

  const trimmed = stripAnsi(rawStdout).trim();
  return trimmed || '(无输出)';
}

/** 从 stderr 内嵌 JSON 提取 error.message */
function extractJsonErrorMessage(text) {
  const m = String(text || '').match(/"message"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (!m) return null;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

/**
 * Agent 非零退出时，将冗长 stderr 提炼为可读错误（避免整墙日志抛给 UI）
 */
function formatAgentExitError(rawStderr, rawStdout, exitCode, agentId = 'claude-code', signal = null) {
  const execFail = detectAgentExecutionFailure(rawStdout);
  if (execFail) return execFail;

  const stderr = stripAnsi(rawStderr || '');
  const stdout = stripAnsi(rawStdout || '');
  const combined = `${stderr}\n${stdout}`.trim();

  if (!combined) {
    if (signal) return `Agent 进程被中断 (${signal})，请重试或检查工作目录与 CLI 状态`;
    if (exitCode == null) {
      return 'Agent 进程异常结束（无输出），可能被中断、工作目录无效或 CLI 未正常启动';
    }
    if (agentId === 'cursor' || agentId === 'cursor-agent') {
      return `Cursor 异常退出 (code ${exitCode})。若刚开始使用，请先在终端执行 \`cursor-agent login\` 或设置 CURSOR_API_KEY。`;
    }
    return `Agent 异常退出 (code ${exitCode})`;
  }

  // Claude OAuth 会话过期（常见于画像挖掘 / Debug 派发）
  const claudeAuth = extractAuthFailureFromStdout(combined);
  if (claudeAuth) return claudeAuth;

  // Codex / OpenAI OAuth：refresh token 已被轮换
  if (/refresh_token_reused|refresh token.*already been used|refresh token was already used/i.test(combined)) {
    const hint = agentId === 'codex'
      ? '请在终端执行 `codex logout && codex login` 重新登录，或在 Codex Desktop 退出后重新登录。'
      : '请在对应 CLI 中退出并重新登录。';
    return `Agent 登录凭证已失效（refresh token 已被使用）。${hint}`;
  }

  if (/token_expired|authentication token is expired/i.test(combined)) {
    const hint = agentId === 'codex' ? '请执行 `codex login` 重新登录。' : '请重新登录对应 Agent CLI。';
    return `Agent 访问令牌已过期。${hint}`;
  }

  // Cursor Agent：headless 需 login 或 CURSOR_API_KEY（与网关无关）
  if (/authentication required|not logged in|stored authentication is invalid|please run ['"]?agent login|CURSOR_API_KEY/i.test(combined)
    && (agentId === 'cursor' || agentId === 'cursor-agent' || /agent login|CURSOR_API_KEY/i.test(combined))) {
    return 'Cursor Agent CLI 未登录或凭证无效（与 Cursor IDE 登录不是同一套）。请在游乐场点「登录 Agent CLI」，或在终端执行 `agent login`；自动化场景可改设 CURSOR_API_KEY。';
  }

  if (/failed to refresh token/i.test(combined)) {
    const jsonMsg = extractJsonErrorMessage(combined);
    const hint = agentId === 'codex' ? '建议执行 `codex logout && codex login`。' : '';
    if (jsonMsg && !/already been used|already used/i.test(jsonMsg)) {
      return `Agent 无法刷新登录凭证：${jsonMsg}${hint ? ` ${hint}` : ''}`;
    }
    return `Agent 认证失败，无法刷新登录凭证。${hint || '请重新登录。'}`;
  }

  if (/401 unauthorized/i.test(combined) && /websocket|codex_api|chatgpt\.com/i.test(combined)) {
    const hint = agentId === 'codex' ? '请执行 `codex login` 重新登录。' : '';
    return `Agent 无法连接服务 (401 Unauthorized)。${hint || '请检查登录状态。'}`;
  }

  if (/401 unauthorized/i.test(combined)) {
    return 'Agent 认证失败 (401 Unauthorized)。请重新登录。';
  }

  // Codex：config.toml 声明了 model_provider，但缺少对应 [model_providers.*] 段
  const missingProvider = combined.match(/Model provider [`']([^`']+)[`'] not found/i);
  if (missingProvider) {
    const id = missingProvider[1];
    return `Codex 找不到模型供应商 \`${id}\`（~/.codex/config.toml 缺少 [model_providers.${id}]）。请在 Token Bank 重新纳管 Codex，或手动恢复该段。`;
  }

  // 兜底：去重、去噪后取前几行
  const seen = new Set();
  const lines = [];
  for (const line of combined.split('\n')) {
    let t = line.trim();
    if (!t || isNoise(t)) continue;
    t = t.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+ERROR\s+\S+:\s*/i, '');
    t = t.replace(/^ERROR:\s*/i, '').trim();
    if (!t || isNoise(t)) continue;
    const key = t.replace(/\s+/g, ' ').slice(0, 200);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(t);
  }

  if (lines.length) {
    const summary = lines.slice(0, 3).join('\n');
    const truncated = summary.length > 600 ? `${summary.slice(0, 600)}…` : summary;
    return `Agent 异常退出 (code ${exitCode})：\n${truncated}`;
  }

  return `Agent 异常退出 (code ${exitCode})`;
}

module.exports = {
  stripAnsi,
  parseAgentOutputLine,
  summarizeAgentStdout,
  extractModifiedFiles,
  isLikelyFilePath,
  extractCliSessionId,
  normalizeCliSessionId,
  detectAgentExecutionFailure,
  extractAuthFailureFromStdout,
  formatAgentExitError,
  extractClaudeResultObject,
  parseClaudeSyncStdout,
};
