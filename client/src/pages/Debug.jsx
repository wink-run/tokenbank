import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { getConfig, getLocalConfig, getGateway } from '../api/adapter';
import { loadGatewayAvailableModels, resolveGatewayModelType, resolveLocalGatewayBase } from '../api/gatewayModels';
import { encodeTierModelRoute } from '../lib/route-binding';
import { usableSceneRoutes } from '../components/RouteSelect';
import {
  agentSessionKey,
  getStoreSession,
  mergeTaskIntoStore,
  patchStoreSession,
  readStoreSnapshot,
  resolveTaskRoute,
  resolveSessionKey,
  routeTask,
  routeTaskMirror,
  resolveMirrorRoute,
  resolveFinalizeKey,
  resolveTaskInstance,
  beginSessionInstance,
  eventMatchesSession,
  eventMatchesAgentMirror,
  sessionTaskInstanceMatches,
  setStoreSelectedAgentId,
  getStoreSelectedAgentId,
  releaseAllExecutingSessions,
  releaseExecutingForTask,
  clearSessionTaskState,
  isFreshAgentSession,
  inferSessionKeyFromTask,
  stepsFromTaskStatus,
  resolveArchiveSteps,
  preferRicherSteps,
  getCachedAgentsList,
  setCachedAgentsList,
  archiveCompletedTurn,
  patchDelegation,
  syncDelegatedToAgentTab,
  syncDelegatedMirrorToAgentTab,
  shouldContinueCliSession,
  canResumeInterruptedSession,
  buildInterruptedContinuePrompt,
  normalizeWorkingDir,
  workingDirBasename,
  hasOpenToolCalls,
  closePendingToolSteps,
} from '../lib/debug-agent-store';
import { useLang } from '../store/lang';
import { usePinBottomScroll } from '../lib/use-pin-bottom-scroll';
import {
  mergeStreamText,
  splitInlineReasoning,
  looksLikeInlineReasoning,
  normalizeLoose,
  stripDuplicateThinkingPrefix,
  stripReasoningLeakage,
  looksLikeLeakedReasoning,
  sanitizeThinkingOutputPairs,
} from '../../shared/stream-text-merge.js';
import AgentTabBar from '../components/AgentTabBar';
import ExecutionLog from '../components/ExecutionLog';
import AgentSessionHistoryPanel from '../components/AgentSessionHistoryPanel';
import LlmSessionHistoryPanel from '../components/LlmSessionHistoryPanel';
import LocalFilePreviewHost from '../components/LocalFilePreview';
import { StreamMarkdownContent } from '../components/RichMediaContent';
import { openLocalPath } from '../lib/local-path';
import { saveAgentSessionSnapshot, saveLlmSessionSnapshot, listAgentSessionSnapshots, listLlmSessionSnapshots, findAgentSessionForContinue } from '../lib/debug-session-history';
import {
  B64_OMITTED, persistImageList, resolveImageList, serializeImageSrc, isImageRef,
  collectImageRefIds, deleteUnreferencedImageIds,
} from '../lib/debug-image-store';
import { useResolvedImageSrc } from '../components/ResolvedDebugImage';

/** 下拉 value：同 id 跨层时用 tier:id，避免 HTML option 重复 value 选中错位 */
function modelSelectValue(m) {
  if (!m) return '';
  const id = m.name || m.id || '';
  return m.tier ? encodeTierModelRoute(m.tier, id) : id;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** 合并 Agent 流式步骤；output 去重/剥离已展示的 thinking */
function coalesceAgentSteps(prev, stepData) {
  const next = appendCoalescedStep(prev || [], stepData);
  return sanitizeSteps(next);
}

/** 合并相邻/被泄漏 output 分隔的重复 thinking 步骤 */
function dedupeThinkingSteps(steps) {
  if (!steps?.length) return steps;
  const out = [];
  for (const step of steps) {
    if (step.stepType !== 'thinking') {
      out.push(step);
      continue;
    }
    let j = out.length - 1;
    while (j >= 0 && out[j].stepType === 'output' && looksLikeLeakedReasoning(out[j].content)) {
      j -= 1;
    }
    if (j >= 0 && out[j].stepType === 'thinking') {
      const last = out[j];
      const merged = mergeStreamText(last.content, step.content, {
        isSnapshot: !!step.is_snapshot,
        isDelta: !!step.is_delta,
      });
      const la = normalizeLoose(last.content);
      const lb = normalizeLoose(step.content);
      const lm = normalizeLoose(merged);
      if (la === lb || la === lm || lb === lm || la.startsWith(lb) || lb.startsWith(la)) {
        out[j] = {
          ...last,
          content: String(merged).length >= String(last.content).length
            ? merged
            : last.content,
          timestamp: step.timestamp || last.timestamp,
        };
        continue;
      }
    }
    out.push(step);
  }
  return out;
}

/** 合并被重复 output 步骤（快照与 delta 交替）
 * 仅合并「相邻」output（中间可夹泄漏 thinking）；禁止跨 tool_* 合并，
 * 否则会把工具后的终稿拽到工具前，造成回复/调用顺序错乱。
 */
function dedupeOutputSteps(steps) {
  if (!steps?.length) return steps;
  const out = [];
  for (const step of steps) {
    if (step.stepType !== 'output') {
      out.push(step);
      continue;
    }
    let j = out.length - 1;
    while (j >= 0 && out[j].stepType === 'thinking' && looksLikeLeakedReasoning(out[j].content)) {
      j -= 1;
    }
    // 必须紧邻（跳过泄漏 thinking 后仍是 output）；中间有工具则保留独立步骤
    const prevOut = (j >= 0 && out[j].stepType === 'output') ? out[j] : null;
    if (prevOut) {
      const prevLeaked = looksLikeLeakedReasoning(prevOut.content);
      const nextLeaked = looksLikeLeakedReasoning(step.content);
      // 泄漏推理与用户正文分开保留，避免合并后 sanitize 误删正文
      if (prevLeaked !== nextLeaked) {
        out.push(step);
        continue;
      }
      const merged = mergeStreamText(prevOut.content, step.content, {
        isSnapshot: !!step.is_snapshot,
        isDelta: !!step.is_delta,
      });
      const pa = normalizeLoose(prevOut.content);
      const pb = normalizeLoose(step.content);
      const pm = normalizeLoose(merged);
      if (pa === pb || pa === pm || pb === pm || pa.startsWith(pb) || pb.startsWith(pa)) {
        prevOut.content = String(merged).length >= String(prevOut.content).length
          ? merged
          : prevOut.content;
        prevOut.timestamp = step.timestamp || prevOut.timestamp;
        continue;
      }
    }
    out.push(step);
  }
  return out;
}

/** 全量清理：去掉误分类混合 output + 修复边界 + 尾部剥离 */
function sanitizeSteps(steps) {
  return sanitizeTailOutput(sanitizeThinkingOutputPairs(
    dedupeOutputSteps(dedupeThinkingSteps(dropOrphanMixedOutputs(steps))),
  ));
}

/** 已有 thinking 或后续干净 output 时，删除前面的混合 output */
function dropOrphanMixedOutputs(steps) {
  if (!steps?.length) return steps;
  return steps.filter((step, i, arr) => {
    if (step.stepType !== 'output' || !looksLikeLeakedReasoning(step.content)) return true;
    const hasThinking = arr.some(s => s.stepType === 'thinking');
    const hasLaterClean = arr.slice(i + 1).some(s =>
      s.stepType === 'output' && s.content?.trim() && !looksLikeLeakedReasoning(s.content),
    );
    return !(hasThinking || hasLaterClean);
  });
}

function appendCoalescedStep(steps, stepData) {
  const last = steps[steps.length - 1];
  const type = stepData.stepType || 'output';

  if (last && last.stepType === type && (type === 'output' || type === 'thinking')) {
    const merged = mergeStreamText(last.content, stepData.content, {
      isDelta: !!stepData.is_delta,
      isSnapshot: !!stepData.is_snapshot,
    });
    if (normalizeLoose(merged) === normalizeLoose(last.content)
      && normalizeLoose(merged) === normalizeLoose(stepData.content)) {
      return steps;
    }
    if (merged === last.content && merged === stepData.content) return steps;
    return [
      ...steps.slice(0, -1),
      {
        ...last,
        ...stepData,
        content: merged,
        timestamp: stepData.timestamp || last.timestamp,
        is_delta: undefined,
        is_snapshot: undefined,
      },
    ];
  }

  // 相邻 thinking 内容相同 → 跳过重复
  if (type === 'thinking' && last?.stepType === 'thinking'
    && normalizeLoose(last.content) === normalizeLoose(stepData.content)) {
    return steps;
  }

  if (last && last.stepType === type && last.content === stepData.content) return steps;
  return [...steps, stepData];
}

/** 清理尾部 output：剥离重复推理，仅在无 thinking 步骤时才拆分 */
function sanitizeTailOutput(steps) {
  const last = steps[steps.length - 1];
  if (!last || last.stepType !== 'output') return steps;

  const lastThinking = [...steps].reverse().find(s => s.stepType === 'thinking');
  let content = last.content;

  if (lastThinking) {
    content = stripReasoningLeakage(content, lastThinking.content);
  } else if (looksLikeInlineReasoning(content)) {
    const parts = splitInlineReasoning(content);
    if (parts.some(p => p.stepType === 'thinking')) {
      let acc = steps.slice(0, -1);
      for (const part of parts) {
        acc = appendCoalescedStep(acc, {
          ...last,
          stepType: part.stepType,
          content: part.content,
          is_delta: undefined,
          is_snapshot: undefined,
        });
      }
      return acc;
    }
    const outputs = parts.filter(p => p.stepType === 'output');
    if (outputs.length) content = outputs.map(o => o.content).join('');
  }

  if (content === last.content) return steps;
  // 剥离后为空则丢弃该 output，避免空气泡覆盖已有正文
  if (!String(content || '').trim()) return steps.slice(0, -1);
  return [...steps.slice(0, -1), { ...last, content }];
}

function isAnthropicUrl(url) {
  try { return /anthropic/i.test(new URL(url).hostname + new URL(url).pathname); } catch { return false; }
}

function buildChatUrl(base, anthropic) {
  const b = base.replace(/\/+$/, '');
  return b + (anthropic ? '/v1/messages' : '/v1/chat/completions');
}

function buildImageUrl(base) {
  return base.replace(/\/+$/, '') + '/v1/images/generations';
}

/** 附图上限：张数 / 单文件大小 */
const ATTACH_MAX_COUNT = 4;
const ATTACH_MAX_BYTES = 5 * 1024 * 1024;
const ATTACH_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp';

/** File → data URL（供 image_url 使用） */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * 组装 OpenAI 多模态 content：无图保持 string；有图则 parts 数组。
 * images 为 data:/http URL 列表。
 */
function buildMultimodalContent(text, images = []) {
  const urls = (images || []).filter(u => u && u !== B64_OMITTED);
  const trimmed = String(text || '').trim();
  if (!urls.length) return trimmed;
  const parts = [];
  if (trimmed) parts.push({ type: 'text', text: trimmed });
  for (const url of urls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/** OpenAI image_url part → Anthropic image block（对齐网关 oaiImagePartToAnth） */
function oaiImagePartToAnth(part) {
  const url = part?.image_url?.url || '';
  const mm = /^data:([^;]+);base64,(.*)$/s.exec(url);
  if (mm) return { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } };
  if (url) return { type: 'image', source: { type: 'url', url } };
  return null;
}

/** OAI content（string | parts）→ Anthropic content */
function oaiContentToAnth(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  const blocks = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text' && p.text != null) blocks.push({ type: 'text', text: String(p.text) });
    else if (p.type === 'image_url') {
      const im = oaiImagePartToAnth(p);
      if (im) blocks.push(im);
    }
  }
  return blocks.length ? blocks : '';
}

function toAnthropicBody(messages, model, stream) {
  const sys = messages.find(m => m.role === 'system');
  const sysText = !sys ? undefined
    : typeof sys.content === 'string' ? sys.content
    : Array.isArray(sys.content) ? sys.content.map(b => b.text || '').join('') : '';
  return {
    model, max_tokens: 8096, stream: !!stream,
    // 多模态：把 OAI image_url 转成 Anthropic image，直连 Anthropic 才能看图
    messages: messages.filter(m => m.role !== 'system').map(m => ({
      ...m,
      content: oaiContentToAnth(m.content),
    })),
    ...(sysText ? { system: sysText } : {}),
  };
}

function parseSseLines(lines, anthropic, firstTokenTime, onChunk, evRef) {
  for (const line of lines) {
    const t = line.trimEnd();
    if (!t) { evRef.v = null; continue; }
    if (anthropic) {
      if (t.startsWith('event: ')) { evRef.v = t.slice(7).trim(); }
      else if (t.startsWith('data: ') && evRef.v === 'content_block_delta') {
        try {
          const d = JSON.parse(t.slice(6));
          const text = d.delta?.type === 'text_delta' ? d.delta.text : '';
          if (text) { if (firstTokenTime.v === null) firstTokenTime.v = Date.now(); onChunk(text); }
        } catch {}
      }
    } else {
      if (t === 'data: [DONE]') continue;
      if (t.startsWith('data: ')) {
        try {
          const d = JSON.parse(t.slice(6));
          const delta = d.choices?.[0]?.delta?.content ?? '';
          if (delta) { if (firstTokenTime.v === null) firstTokenTime.v = Date.now(); onChunk(delta); }
        } catch {}
      }
    }
  }
}

/** 从非 SSE / 错误 JSON 体中提取可读错误信息 */
function extractStreamError(raw, fallback) {
  const text = String(raw || '').trim();
  if (!text) return fallback;
  try {
    const j = JSON.parse(text);
    const msg = j.error?.message || j.message || j.detail;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch { /* 非 JSON */ }
  // 截断过长原文，避免把整段 HTML/堆栈塞进气泡
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

async function doStreamChat({ baseUrl, token, model, messages, stream, anthropic, onChunk, onDone, onError, emptyError }) {
  const url = buildChatUrl(baseUrl, anthropic);
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    if (anthropic) { headers['x-api-key'] = token; headers['anthropic-version'] = '2023-06-01'; }
    else headers['Authorization'] = `Bearer ${token}`;
  }
  const body = JSON.stringify(anthropic ? toAnthropicBody(messages, model, stream) : { model, messages, stream });
  const startTime = Date.now();
  const firstTokenTime = { v: null };
  const emptyMsg = emptyError || 'Empty response from model';

  const finishEmptyOrDone = (gotContent, rawBuf) => {
    if (gotContent) {
      onDone({ firstTokenMs: firstTokenTime.v ? firstTokenTime.v - startTime : null, totalMs: Date.now() - startTime });
      return;
    }
    onError(extractStreamError(rawBuf, emptyMsg));
  };

  const useIpc = !!window.electronAPI?.llm;
  if (useIpc) {
    if (!stream) {
      try {
        const r = await window.electronAPI.llm.fetch(url, { method: 'POST', headers, body });
        if (r.status >= 300) { onError(`HTTP ${r.status}: ${r.body}`); return; }
        const data = JSON.parse(r.body);
        const content = anthropic
          ? (data.content || []).map(b => b.text || '').join('')
          : (data.choices?.[0]?.message?.content ?? '');
        if (!String(content || '').trim()) { onError(extractStreamError(r.body, emptyMsg)); return; }
        onChunk(content);
        onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      } catch (e) { onError(e.message); }
      return;
    }
    await new Promise(resolve => {
      let buf = ''; let full = ''; const evRef = { v: null }; let gotContent = false;
      const wrapChunk = (text) => { if (text) gotContent = true; onChunk(text); };
      window.electronAPI.llm.stream({ url, method: 'POST', headers, body },
        raw => {
          full += raw;
          buf += raw;
          const lines = buf.split('\n'); buf = lines.pop();
          parseSseLines(lines, anthropic, firstTokenTime, wrapChunk, evRef);
        },
        () => { finishEmptyOrDone(gotContent, full + buf); resolve(); },
        err => { onError(err); resolve(); }
      );
    });
    return;
  }

  try {
    const resp = await fetch(url, { method: 'POST', headers, body });
    if (!resp.ok) { onError(`HTTP ${resp.status}: ${await resp.text()}`); return; }
    if (!stream) {
      const text = await resp.text();
      const data = JSON.parse(text);
      const content = anthropic
        ? (data.content || []).map(b => b.text || '').join('')
        : (data.choices?.[0]?.message?.content ?? '');
      if (!String(content || '').trim()) { onError(extractStreamError(text, emptyMsg)); return; }
      onChunk(content);
      onDone({ firstTokenMs: Date.now() - startTime, totalMs: Date.now() - startTime });
      return;
    }
    const reader = resp.body.getReader(); const decoder = new TextDecoder();
    let buf = ''; let full = ''; const evRef = { v: null }; let gotContent = false;
    const wrapChunk = (text) => { if (text) gotContent = true; onChunk(text); };
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      const raw = decoder.decode(value, { stream: true });
      full += raw;
      buf += raw;
      const lines = buf.split('\n'); buf = lines.pop();
      parseSseLines(lines, anthropic, firstTokenTime, wrapChunk, evRef);
    }
    finishEmptyOrDone(gotContent, full + buf);
  } catch (e) { onError(e.message); }
}

async function doGenerateImage({ baseUrl, token, model, prompt, ratio, resolution, onDone, onError, t }) {
  const url = buildImageUrl(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const extra = {};
  if (ratio) extra.ratio = ratio;
  if (resolution) extra.resolution = resolution;
  const body = JSON.stringify({ model, prompt, n: 1, response_format: 'b64_json', ...extra });
  const startTime = Date.now();

  const parse = async (text) => {
    let data = JSON.parse(text);
    // 网关曾把截断后的 JSON 字符串二次序列化，需再 parse 一层
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { throw new Error(t('debug.emptyImageList', { text: text.slice(0, 200) })); }
    }
    const errMsg = data.detail
      || (typeof data.error === 'string' ? data.error : data.error?.message);
    if (errMsg) throw new Error(errMsg);
    const images = (Array.isArray(data.data) ? data.data : [])
      .map(item => (item && (item.b64_json || item.url || item.image?.url)) || '')
      .filter(Boolean);
    if (!images.length) throw new Error(t('debug.emptyImageList', { text: text.slice(0, 200) }));
    onDone({ images, totalMs: Date.now() - startTime });
  };

  try {
    if (window.electronAPI?.llm) {
      const r = await window.electronAPI.llm.fetch(url, {
        method: 'POST', headers, body, timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
      });
      if (r.status >= 300 || r.status === 0) {
        onError(r.status === 0 ? (r.body || t('debug.imageTimeout')) : `HTTP ${r.status}: ${r.body}`);
        return;
      }
      await parse(r.body);
    } else {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS) : null;
      try {
        const resp = await fetch(url, { method: 'POST', headers, body, signal: ctrl?.signal });
        if (!resp.ok) { onError(`HTTP ${resp.status}: ${await resp.text()}`); return; }
        await parse(await resp.text());
      } catch (e) {
        if (e?.name === 'AbortError') onError(t('debug.imageTimeout'));
        else onError(e.message);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } catch (e) { onError(e.message); }
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** 图像生成 IPC/HTTP 超时（须 ≥ 上游轮询耗时，如即梦 ~30–60s） */
const IMAGE_FETCH_TIMEOUT_MS = 300_000;

const LOCAL_GW = { id: '__local_gw__', base_url: 'http://127.0.0.1:11430', token: '', models: [] };
const CUSTOM   = { id: '__custom__',   base_url: '', token: '', models: [] };

const TIER_ORDER = ['free', 'p2p', 'paid'];

function normModel(m) { return typeof m === 'string' ? { name: m, type: 'chat' } : { name: m.name, type: m.type || 'chat' }; }

function providerOptions(cfg, localCfg, localGw, t) {
  // 本地网关模型由 loadGatewayAvailableModels() 动态拉取（含 free/p2p/paid）
  const opts = [{ ...localGw, label: t('debug.localGw'), models: [] }];
  for (const p of (cfg?.providers || [])) {
    if (!p.enabled || p.type === 'p2p' || !p.base_url) continue;
    const label = (() => { try { return new URL(p.base_url).hostname; } catch { return p.id; } })();
    opts.push({ id: p.id, label, base_url: p.base_url, token: p.token || '', models: (p.models || []).map(normModel) });
  }
  // P2P backend from local-config cloud_config
  const cc = localCfg?.cloud_config;
  if (cc?.url) {
    const label = (() => { try { return new URL(cc.url).hostname; } catch { return t('debug.p2pBackend'); } })();
    opts.push({ id: '__p2p__', label: `🌐 ${label}`, base_url: cc.url, token: cc.token || '', models: [] });
  }
  opts.push({ ...CUSTOM, label: t('debug.custom') });
  return opts;
}

/** localStorage 键：调试页聊天记录（切换页面/重启后恢复） */
const DEBUG_CHAT_KEY = 'tokenbank.debug.chat';
const DEBUG_CHAT_MAX = 200;

const defaultLane = () => ({
  conversation: [],
  input: '',
  systemPrompt: '',
  showSystem: false,
  selectedPromptId: '',
});

/** 对话 / 图像分车道，避免切换模式时共用聊天记录与输入框 */
const defaultPanel = () => ({
  imageMode: false,
  streamMode: true,
  imageRatio: '',
  imageResolution: '',
  chat: defaultLane(),
  image: defaultLane(),
});

const PANEL_LANE_KEYS = new Set(['conversation', 'input', 'systemPrompt', 'showSystem', 'selectedPromptId']);

function panelLaneKey(imageMode) {
  return imageMode ? 'image' : 'chat';
}

function normalizeLane(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const conversation = (Array.isArray(src.conversation) ? src.conversation : [])
    .slice(-DEBUG_CHAT_MAX)
    .map(m => ({ ...m, streaming: false, generating: false }));
  // 系统提示词编辑 UI 已移除；加载时丢弃残留，避免不可见脏数据跨会话注入
  // （历史会话恢复仍会通过 restoreLlmSession 显式写回 systemPrompt）
  return {
    ...defaultLane(),
    systemPrompt: '',
    showSystem: false,
    selectedPromptId: src.selectedPromptId || '',
    input: typeof src.input === 'string' ? src.input : '',
    conversation,
  };
}

/** 合并 panel 补丁：车道字段写入当前（或补丁指定的）对话/图像车道 */
function patchDebugPanel(prevMain, patch) {
  const shared = {};
  const lanePatch = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (PANEL_LANE_KEYS.has(k)) lanePatch[k] = v;
    else shared[k] = v;
  }
  let next = { ...prevMain, ...shared };
  if (Object.keys(lanePatch).length) {
    const key = panelLaneKey(
      Object.prototype.hasOwnProperty.call(patch, 'imageMode') ? patch.imageMode : prevMain.imageMode,
    );
    next = { ...next, [key]: { ...(prevMain[key] || defaultLane()), ...lanePatch } };
  }
  return next;
}

/** 底部对话栏输入框高度（拖中间框线调整） */
const COMPOSER_H_KEY = 'tokenbank.debug.composerTextH';
const COMPOSER_H_MIN = 56;
const COMPOSER_H_MAX = 360;

function clampComposerTextH(h) {
  return Math.min(COMPOSER_H_MAX, Math.max(COMPOSER_H_MIN, Math.round(Number(h) || COMPOSER_H_MIN)));
}

function readComposerTextH() {
  try {
    const n = Number(localStorage.getItem(COMPOSER_H_KEY));
    if (Number.isFinite(n)) return clampComposerTextH(n);
  } catch { /* ignore */ }
  return COMPOSER_H_MIN;
}

/** 持久化前清洗：去掉流式态；裸 base64 丢掉，tbimg/http 保留 */
function serializeDebugMessage(msg) {
  const base = { ...msg, streaming: false, generating: false };
  if (!Array.isArray(base.images)) return base;
  return {
    ...base,
    images: base.images.map(serializeImageSrc),
  };
}

function PersistableGenImage({ src, t, onPreview }) {
  const url = useResolvedImageSrc(src);
  if (url === undefined) {
    return <div className="h-36 w-full max-w-xs rounded-lg bg-zinc-100 dark:bg-zinc-800 animate-pulse" />;
  }
  if (!url) {
    return <p className="px-2 pb-1 text-xs text-zinc-400 dark:text-zinc-500">{t('debug.imageNotRestored')}</p>;
  }
  return (
    <div className="relative group">
      <img src={url} alt="" className="rounded-xl max-w-full cursor-zoom-in" onClick={() => onPreview(url)} />
      <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button onClick={async () => { try { const b = await (await fetch(url)).blob(); await navigator.clipboard.write([new ClipboardItem({ [b.type]: b })]); } catch {} }}
          className="px-2 py-1 text-xs bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm">{t('debug.copy')}</button>
        <button onClick={() => { const a = document.createElement('a'); a.href = url; a.download = `gen-${Date.now()}.png`; a.click(); }}
          className="px-2 py-1 text-xs bg-black/60 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm">{t('debug.saveImage')}</button>
      </div>
    </div>
  );
}

function PersistableThumb({ src, omittedLabel, onPreview }) {
  const url = useResolvedImageSrc(src);
  if (!src || src === B64_OMITTED || url === '') {
    return <span className="text-[11px] opacity-80 px-1.5 py-1 rounded bg-white/15">{omittedLabel}</span>;
  }
  if (url === undefined) {
    return <div className="h-16 w-16 rounded-lg bg-white/15 animate-pulse" />;
  }
  return (
    <img
      src={url}
      alt=""
      className="h-16 w-16 object-cover rounded-lg cursor-zoom-in border border-white/20"
      onClick={() => onPreview(url)}
    />
  );
}

function loadDebugPanel() {
  try {
    const raw = localStorage.getItem(DEBUG_CHAT_KEY);
    if (!raw) return defaultPanel();
    const data = JSON.parse(raw);
    const imageMode = !!data.imageMode;
    const base = {
      ...defaultPanel(),
      imageMode,
      streamMode: data.streamMode !== false,
      imageRatio: data.imageRatio || '',
      imageResolution: data.imageResolution || '',
    };
    // 新格式：chat / image 分车道
    if (data.chat || data.image) {
      return {
        ...base,
        chat: normalizeLane(data.chat),
        image: normalizeLane(data.image),
      };
    }
    // 旧格式：单一 conversation → 归入当时模式对应车道
    const legacy = normalizeLane({
      conversation: data.conversation,
      systemPrompt: data.systemPrompt,
      showSystem: data.showSystem,
    });
    return {
      ...base,
      chat: imageMode ? defaultLane() : legacy,
      image: imageMode ? legacy : defaultLane(),
    };
  } catch {
    return defaultPanel();
  }
}

function persistDebugPanel(panel) {
  try {
    const serLane = (lane) => ({
      conversation: (lane?.conversation || []).slice(-DEBUG_CHAT_MAX).map(serializeDebugMessage),
      systemPrompt: lane?.systemPrompt || '',
      showSystem: !!lane?.showSystem,
    });
    localStorage.setItem(DEBUG_CHAT_KEY, JSON.stringify({
      imageMode: !!panel.imageMode,
      streamMode: panel.streamMode !== false,
      imageRatio: panel.imageRatio || '',
      imageResolution: panel.imageResolution || '',
      chat: serLane(panel.chat),
      image: serLane(panel.image),
    }));
  } catch { /* quota 超限等：忽略，不影响当前会话 */ }
}

// ── Agent 模式常量 ─────────────────────────────────────────────────────────────

const MAIN_AGENT_STORAGE_KEY = 'tokenbank.mainAgentId';
/** 聚合入口固定使用开发模式 Profile（含 Agent 桥 + 已纳管 MCP） */
const MCP_PROFILE_DEVELOPMENT = 'development'; // fixed: no multi-profile UI
const AGENT_WORKING_DIR_KEY = 'tokenbank.agentWorkingDir';
const DEBUG_MODE_KEY = 'tokenbank.debugMode';

function loadMainAgentId() {
  try { return localStorage.getItem(MAIN_AGENT_STORAGE_KEY) || ''; } catch { return ''; }
}

function saveMainAgentId(id) {
  try {
    if (id) localStorage.setItem(MAIN_AGENT_STORAGE_KEY, id);
    else localStorage.removeItem(MAIN_AGENT_STORAGE_KEY);
  } catch {}
}

function loadAgentWorkingDir() {
  try { return localStorage.getItem(AGENT_WORKING_DIR_KEY) || ''; } catch { return ''; }
}

function saveAgentWorkingDir(dir) {
  try {
    if (dir) localStorage.setItem(AGENT_WORKING_DIR_KEY, dir);
    else localStorage.removeItem(AGENT_WORKING_DIR_KEY);
  } catch {}
}

/** 空会话才用上次目录当种子；已有轮次的会话尊重其自身绑定 */
function seedEmptySessionWorkingDir(key) {
  if (!key) return;
  const sess = getStoreSession(key);
  if (normalizeWorkingDir(sess.sessionWorkingDir)) return;
  if (sess.conversationTurns?.length || sess.cliSessionId) return;
  const last = loadAgentWorkingDir();
  if (last) patchStoreSession(key, { sessionWorkingDir: last });
}

function loadDebugMode() {
  try { return localStorage.getItem(DEBUG_MODE_KEY) || 'llm'; } catch { return 'llm'; }
}

function saveDebugMode(mode) {
  try { localStorage.setItem(DEBUG_MODE_KEY, mode); } catch {}
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Debug() {
  const { t } = useLang();
  const location = useLocation();
  const navigate = useNavigate();
  const isDebugRouteRef = useRef(location.pathname === '/debug');
  isDebugRouteRef.current = location.pathname === '/debug';
  
  // 模式切换：'llm' | 'agent'
  const [mode, setMode] = useState(() => loadDebugMode());
  
  // LLM 模式状态
  const [cfg,            setCfg]           = useState(null);
  const [provOpts,       setProvOpts]      = useState([]);
  const [selectedId,     setSelectedId]    = useState('__local_gw__');
  const [manualBaseUrl,  setManualBaseUrl] = useState('');
  const [token,          setToken]         = useState('');
  const [showToken,      setShowToken]     = useState(false);
  const [models,         setModels]        = useState([]);   // {name, type}[]
  const [sceneRoutes,    setSceneRoutes]   = useState([]);   // 本地网关场景路由（对话下拉用）
  const [model,          setModel]         = useState('');
  const [manualModel,    setManualModel]   = useState(false);
  const [loadingModels,  setLoadingModels] = useState(false);
  const [panels,         setPanels]        = useState(() => ({ main: loadDebugPanel() }));
  const [sending,        setSending]       = useState(false);
  const [lightbox,       setLightbox]      = useState(null);
  const [copiedMsgIdx,   setCopiedMsgIdx]  = useState(null);
  // 对话模式待发附图（dataURL）；不进 panel 持久化
  const [pendingImages,  setPendingImages] = useState([]);
  const [attachError,    setAttachError]   = useState('');
  const fileInputRef = useRef(null);
  // LLM 模式：从资产加载的提示词列表，选中后填入输入框（按对话/图像分车道）
  const [promptList,     setPromptList]    = useState([]);

  // Agent 模式状态
  const [agents, setAgents] = useState(() => getCachedAgentsList() || []);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [installingCursorCli, setInstallingCursorCli] = useState(false);
  const [cursorInstallError, setCursorInstallError] = useState('');
  const [agentPrompt, setAgentPrompt] = useState('');
  const [agentWorkingDir, setAgentWorkingDir] = useState(() => loadAgentWorkingDir());
  const [dirError, setDirError] = useState('');
  const [currentUserPrompt, setCurrentUserPrompt] = useState('');
  const [currentUserImages, setCurrentUserImages] = useState([]);
  const [currentTask, setCurrentTask] = useState(null);
  const [taskSteps, setTaskSteps] = useState([]);
  const [taskResult, setTaskResult] = useState(null);
  const [executing, setExecuting] = useState(false);
  const [mainAgentId, setMainAgentId] = useState(() => loadMainAgentId());
  const [delegations, setDelegations] = useState({});
  const [conversationTurns, setConversationTurns] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [llmHistoryOpen, setLlmHistoryOpen] = useState(false);
  // 底部输入框高度（拖中间框线调整，持久化）
  const [composerTextH, setComposerTextH] = useState(readComposerTextH);
  const composerTextHRef = useRef(composerTextH);
  composerTextHRef.current = composerTextH;
  const [composerResizing, setComposerResizing] = useState(false);
  // 任意会话 executing 变化时递增，驱动侧栏运行绿点刷新
  const [runningRev, setRunningRev] = useState(0);
  const agentTextareaRef = useRef(null);
  const selectedAgentRef = useRef(null);
  selectedAgentRef.current = selectedAgent;
  const agentsRef = useRef([]);
  agentsRef.current = agents;
  const syncSessionToStateRef = useRef(null);
  const finalizeTaskInUiRef = useRef(null);
  const finishDelegatedChildRef = useRef(null);

  // 当前生效的 Agent：直调 tab 或聚合入口的主 Agent
  const mainAgent = agents.find(a => a.id === mainAgentId && !a.custom && a.installed !== false)
    || agents.find(a => a.type === 'cli' && a.installed !== false)
    || null;
  const isHubMode = !selectedAgent;
  const activeAgent = isHubMode ? mainAgent : selectedAgent;

  /** 将当前标签页已完成对话写入本地历史（新会话前/归档后） */
  function persistCurrentSessionHistory(key) {
    if (!key) return;
    const sess = getStoreSession(key);
    if (!sess.conversationTurns?.length) return;
    // 「新会话」后短时间内勿按工作目录并回旧条
    const disallowDirMerge = !!(sess.skipHistoryRecover
      && Date.now() - sess.skipHistoryRecover < 120_000);
    saveAgentSessionSnapshot(key, {
      conversationTurns: sess.conversationTurns,
      sessionWorkingDir: sess.sessionWorkingDir,
      cliSessionId: sess.cliSessionId,
      historyThreadId: sess.historyThreadId,
      disallowDirMerge,
    });
  }

  /** 恢复历史会话到当前标签页 */
  function applyHistorySnapshot(execKey, snapshot) {
    if (!execKey || !snapshot) return;
    // 恢复时按时间戳排轮次，避免合并治愈后仍显示乱序
    const turns = [...(snapshot.conversationTurns || [])].sort((a, b) => {
      const ta = Number(a?.timestamp) || 0;
      const tb = Number(b?.timestamp) || 0;
      if (ta > 0 && tb > 0 && ta !== tb) return ta - tb;
      return 0;
    });
    const threadId = snapshot.historyThreadId
      || snapshot.sessionKey
      || (turns[0]?.taskId ? `task:${turns[0].taskId}` : null)
      || null;
    // 先归档当前未保存会话，再切入目标 session，互不影响
    persistCurrentSessionHistory(execKey);
    patchSession(execKey, {
      conversationTurns: turns,
      currentUserPrompt: '',
      currentUserImages: [],
      taskSteps: [],
      taskResult: null,
      currentTask: null,
      executing: false,
      delegations: {},
      agentPrompt: '',
      // 目录跟这条历史走，不写进全局以免污染其它会话
      sessionWorkingDir: snapshot.sessionWorkingDir || getStoreSession(execKey).sessionWorkingDir || '',
      cliSessionId: snapshot.cliSessionId || null,
      historyThreadId: threadId,
      skipHistoryRecover: Date.now(),
    });
    syncSessionToState(execKey);
  }

  function restoreHistorySession(snapshot) {
    const execKey = agentSessionKey(selectedAgent);
    if (executing) {
      cancelAgent().then(() => applyHistorySnapshot(execKey, snapshot));
      return;
    }
    applyHistorySnapshot(execKey, snapshot);
  }

  const panel = panels.main;
  const { streamMode, imageMode, imageRatio, imageResolution } = panel;
  const activeLane = panel[panelLaneKey(imageMode)] || defaultLane();
  const {
    conversation,
    input,
    systemPrompt,
    selectedPromptId = '',
  } = activeLane;

  const messagesEndRef = useRef(null);
  const textareaRef    = useRef(null);

  // LLM 对话：仅贴底时跟随（必须与其它 hooks 同层，不可放在中部函数之后）
  const llmPinKey = useMemo(() => {
    const lastUser = [...conversation].reverse().find((m) => m.role === 'user');
    return `${conversation.filter((m) => m.role === 'user').length}|${String(lastUser?.content || '').slice(0, 80)}`;
  }, [conversation]);
  usePinBottomScroll(messagesEndRef, conversation, { forcePinKey: llmPinKey });

  // 向上拖中间框线 → 增高底部输入区（提前声明，避免 hooks 穿插在普通函数中间）
  const onComposerResizeStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startH = composerTextHRef.current;
    setComposerResizing(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      const next = clampComposerTextH(startH + (startY - ev.clientY));
      composerTextHRef.current = next;
      setComposerTextH(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setComposerResizing(false);
      try { localStorage.setItem(COMPOSER_H_KEY, String(composerTextHRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // 进入游乐场即预加载 Agent / 提示词（切换模式时无需再等）
  useEffect(() => {
    loadAgents();
    loadPromptList();
  }, []);

  // 游乐场 keep-alive：从「资产」返回时强制刷新智能体与提示词
  const prevDebugPathRef = useRef(location.pathname);
  useEffect(() => {
    const wasActive = prevDebugPathRef.current === '/debug';
    prevDebugPathRef.current = location.pathname;
    if (location.pathname === '/debug' && !wasActive) {
      loadAgents({ force: true });
      loadPromptList();
    }
  }, [location.pathname]);

  // 切到 LLM 模式时刷新提示词（资产页新建后可立即选用）
  useEffect(() => {
    if (mode === 'llm') loadPromptList();
  }, [mode]);

  // Load Agents when switching to agent mode（缓存为空时补拉）
  useEffect(() => {
    if (mode === 'agent' && agents.length === 0 && !loadingAgents) {
      loadAgents();
    }
  }, [mode]);

  const autoFinalizeTimersRef = useRef({});

  /** 同步 JSON 步骤到齐后延迟收尾（IPC completed 丢失兜底） */
  function scheduleAutoFinalize(taskId, key) {
    if (!taskId || !key) return;
    const timers = autoFinalizeTimersRef.current;
    if (timers[taskId]) clearTimeout(timers[taskId]);
    timers[taskId] = setTimeout(async () => {
      delete timers[taskId];
      const sess = getStoreSession(key);
      if (isFreshAgentSession(sess)) return;
      if (!sessionTaskInstanceMatches(sess, taskId)) return;
      if (!sess.executing) return;
      const routed = resolveTaskRoute(taskId, null, null, agentsRef.current);
      const mirrorKey = resolveMirrorRoute(taskId);
      const isMirrorTab = mirrorKey === key
        || (sess.currentTask?.parentTaskId && sess.currentTask?.id === taskId);
      if (routed && routed !== key && !isMirrorTab) return;
      if (sess.currentTask?.id && sess.currentTask.id !== taskId) return;

      try {
        const res = await window.electronAPI.agent.getTaskStatus(taskId);
        if (res.success && ['completed', 'failed', 'cancelled'].includes(res.status?.status)) {
          const status = res.status;
          const terminal = status.status;
          if (status.context?.parentTaskId || sess.currentTask?.parentTaskId) {
            finishDelegatedChildRef.current?.(
              { taskId, agentId: status.agent_id, sessionInstanceId: status.context?.sessionInstanceId, result: status.result },
              status,
              terminal,
            );
            return;
          }
          const steps = resolveTaskSteps(status, { taskId, result: status.result }, key);
          finalizeTaskInUiRef.current?.(taskId, key, {
            currentTask: { ...status, status: status.status },
            currentUserPrompt: status.prompt || sess.currentUserPrompt,
            taskResult: status.result || null,
            taskSteps: preferRicherSteps(steps, sess.taskSteps || []),
          });
          return;
        }
      } catch { /* ignore */ }

      if (!sess.taskSteps?.some(s => s.content?.trim())) return;
      // 仍有未闭合工具：只是在等结果，绝不可提前收尾成「未收到结果/失败」
      if (hasOpenToolCalls(sess.taskSteps)) return;
      // 派发镜像：有步骤但 DB 未终态时，仍走委派收尾
      if (sess.currentTask?.parentTaskId) {
        finishDelegatedChildRef.current?.(
          { taskId, sessionInstanceId: resolveTaskInstance(taskId) },
          null,
          'completed',
        );
        return;
      }
      // 尚无用户可见正文时不提前收尾（避免只归档推理过程）
      const hasCleanOutput = sess.taskSteps.some(s =>
        s.stepType === 'output' && s.content?.trim() && !looksLikeLeakedReasoning(s.content),
      );
      if (!hasCleanOutput) return;

      const summary = sess.taskSteps
        .filter(s => s.stepType === 'output' && s.content?.trim())
        .map(s => s.content)
        .join('\n\n')
        || sess.taskSteps
          .filter(s => s.stepType === 'thinking' && s.content?.trim())
          .map(s => s.content)
          .join('\n\n')
        || null;
      finalizeTaskInUiRef.current?.(taskId, key, {
        currentTask: { id: taskId, status: 'completed', completed_at: Date.now() },
        currentUserPrompt: sess.currentUserPrompt,
        taskResult: {
          ...(summary ? { summary } : {}),
          cliSessionId: sess.cliSessionId || null,
        },
        taskSteps: sess.taskSteps,
      });
    }, 600);
  }
  const scheduleAutoFinalizeRef = useRef(scheduleAutoFinalize);
  scheduleAutoFinalizeRef.current = scheduleAutoFinalize;

  /** 切换标签时恢复会话：优先本地多轮历史，避免只捞 DB 最近 1 条把续跑拆成新会话 */
  const recoverSessionHistory = useCallback(async (syncKey) => {
    if (!syncKey || syncKey === '__hub__') return;
    const sess = getStoreSession(syncKey);
    if (sess.currentUserPrompt || sess.taskSteps?.length || sess.executing || sess.conversationTurns?.length) return;
    // 「新会话」后切换窗口/标签，不回填任何历史（含旧派发）
    if (sess.skipHistoryRecover && Date.now() - sess.skipHistoryRecover < 120_000) return;

    try {
      const local = findAgentSessionForContinue(syncKey, {
        workingDir: sess.sessionWorkingDir || loadAgentWorkingDir(),
        cliSessionId: sess.cliSessionId,
      }) || listAgentSessionSnapshots(syncKey)[0];
      if (local?.conversationTurns?.length) {
        // 回填时按时间排序，避免历史合并残留乱序
        const turns = [...local.conversationTurns].sort((a, b) => {
          const ta = Number(a?.timestamp) || 0;
          const tb = Number(b?.timestamp) || 0;
          if (ta > 0 && tb > 0 && ta !== tb) return ta - tb;
          return 0;
        });
        const threadId = local.sessionKey
          || (turns[0]?.taskId ? `task:${turns[0].taskId}` : null);
        patchStoreSession(syncKey, {
          conversationTurns: turns,
          sessionWorkingDir: local.sessionWorkingDir || '',
          cliSessionId: local.cliSessionId || null,
          historyThreadId: threadId,
          currentUserPrompt: '',
          currentUserImages: [],
          taskSteps: [],
          taskResult: null,
          currentTask: null,
          executing: false,
          delegations: {},
        });
        syncSessionToStateRef.current?.(syncKey);
        return;
      }

      if (!window.electronAPI?.agent?.listRecentTasks) return;
      const res = await window.electronAPI.agent.listRecentTasks({ agentId: syncKey, limit: 1 });
      if (!res.success || !res.tasks?.length) return;
      const recent = res.tasks[0];
      mergeTaskIntoStore(recent);
      syncSessionToStateRef.current?.(syncKey);
    } catch (err) {
      console.warn('[Debug] recoverSessionHistory failed:', err);
    }
  }, []);

  // Agent 列表加载后，校验主 Agent 偏好并恢复上次选中的 Agent 标签
  useEffect(() => {
    if (!agents.length) return;
    // 主 Agent 仅从已安装 CLI 里选
    const cliAgents = agents.filter(a => a.type === 'cli' && a.installed !== false);
    if (cliAgents.length) {
      if (!mainAgentId || !cliAgents.some(a => a.id === mainAgentId)) {
        const fallback = cliAgents[0].id;
        setMainAgentId(fallback);
        saveMainAgentId(fallback);
      }
    }
    const savedId = getStoreSelectedAgentId();
    if (savedId && agents.some(a => a.id === savedId)) {
      const agent = agents.find(a => a.id === savedId);
      if (agent && selectedAgent?.id !== savedId) {
        setSelectedAgent(agent);
        selectedAgentRef.current = agent;
        seedEmptySessionWorkingDir(savedId);
        syncSessionToState(savedId);
        recoverSessionHistory(savedId);
      }
    }
  }, [agents, mainAgentId]);

  function setMainAgent(agent) {
    if (!agent?.id || agent.custom || agent.type === 'assistant') return;
    if (agent.installed === false) return;
    setMainAgentId(agent.id);
    saveMainAgentId(agent.id);
  }

  /**
   * @param {string} key
   * @param {{ preserveAgentPrompt?: boolean }} [opts]
   *   preserveAgentPrompt：保留输入框正文（轮询/步骤推送时勿用 store 空串覆盖）
   */
  function syncSessionToState(key, opts = {}) {
    const saved = readStoreSnapshot(key);
    if (!opts.preserveAgentPrompt) {
      setAgentPrompt(saved.agentPrompt || '');
    }
    setCurrentUserPrompt(saved.currentUserPrompt || '');
    setCurrentUserImages(Array.isArray(saved.currentUserImages) ? saved.currentUserImages : []);
    setCurrentTask(saved.currentTask || null);
    setTaskSteps(saved.taskSteps || []);
    setTaskResult(saved.taskResult || null);
    setExecuting(!!saved.executing);
    setDelegations(saved.delegations || {});
    setConversationTurns(saved.conversationTurns || []);
    // 作曲栏展示当前会话目录，勿用全局 lastDefault 覆盖
    setAgentWorkingDir(saved.sessionWorkingDir || '');
  }
  syncSessionToStateRef.current = syncSessionToState;

  /** 更新模块级会话；当前标签页被修改时立即同步 React state */
  function patchSession(key, patch) {
    const prevExec = !!getStoreSession(key).executing;
    patchStoreSession(key, patch);
    if ('executing' in patch && !!patch.executing !== prevExec) {
      setRunningRev(r => r + 1);
    }
    if (!isDebugRouteRef.current) return getStoreSession(key);

    const activeKey = agentSessionKey(selectedAgentRef.current);
    if (activeKey === key) {
      // 未显式改 agentPrompt 时保留输入框，避免步骤/轮询把正在输入的内容清掉
      syncSessionToState(key, { preserveAgentPrompt: !('agentPrompt' in patch) });
      return getStoreSession(key);
    }

    // 子 Agent 任务完成时，若当前正在看聚合入口，同步 hub 派发状态
    const patchTaskId = patch.currentTask?.id;
    const routedKey = patchTaskId
      ? resolveTaskRoute(patchTaskId, null, null, agentsRef.current)
      : null;
    if (activeKey === '__hub__' && (key === '__hub__' || routedKey === '__hub__')) {
      syncSessionToState('__hub__', { preserveAgentPrompt: !('agentPrompt' in patch) });
    } else if (patch.executing === false && routedKey === activeKey) {
      syncSessionToState(activeKey, { preserveAgentPrompt: true });
    }
    return getStoreSession(key);
  }

  /** 任务结束：释放 executing、归档对话轮次并同步当前标签页 */
  function finalizeTaskInUi(taskId, key, patch) {
    const resolvedKey = resolveFinalizeKey(taskId, key, agentsRef.current);
    if (!resolvedKey) return;
    const sess = getStoreSession(resolvedKey);

    // 用户已开新会话：仅释放 executing 锁，避免迟到事件把旧输出写回空白页
    if (isFreshAgentSession(sess)) {
      releaseExecutingForTask(taskId, { status: patch.currentTask?.status });
      return;
    }

    const touched = releaseExecutingForTask(taskId, {
      status: patch.currentTask?.status,
    });
    const terminal = patch.currentTask?.status;
    if (resolvedKey && terminal && ['completed', 'failed', 'cancelled'].includes(terminal)) {
      const rawSteps = preferRicherSteps(patch.taskSteps || [], sess.taskSteps || []);
      const archiveSteps = closePendingToolSteps(
        rawSteps,
        terminal === 'cancelled' ? t('debug.agent.aborted') : t('debug.agent.noResult'),
      );
      archiveCompletedTurn(resolvedKey, {
        user: patch.currentUserPrompt || sess.currentUserPrompt,
        images: sess.currentUserImages || [],
        steps: archiveSteps,
        delegations: sess.delegations || {},
        result: patch.taskResult || sess.taskResult || null,
        status: terminal === 'cancelled' ? 'failed' : terminal,
        taskId,
        cliSessionId: patch.taskResult?.cliSessionId || sess.cliSessionId || null,
        workingDir: normalizeWorkingDir(sess.sessionWorkingDir || agentWorkingDir.trim()),
        timestamp: patch.currentTask?.completed_at || Date.now(),
      });
    }

    if (resolvedKey) {
      const afterArchive = getStoreSession(resolvedKey);
      const wasRunning = !!afterArchive.executing;
      patchStoreSession(resolvedKey, {
        currentTask: patch.currentTask,
        executing: false,
        // 已归档到 conversationTurns，避免与当前轮重复展示
        currentUserPrompt: '',
        currentUserImages: [],
        taskSteps: [],
        taskResult: null,
        delegations: {},
        conversationTurns: afterArchive.conversationTurns,
        // 中止也保留 sessionId，便于停止后续接
        cliSessionId: patch.taskResult?.cliSessionId || afterArchive.cliSessionId || null,
        sessionWorkingDir: afterArchive.sessionWorkingDir,
      });
      if (wasRunning) setRunningRev(r => r + 1);
      persistCurrentSessionHistory(resolvedKey);
    }

    if (!isDebugRouteRef.current) return;
    const activeKey = agentSessionKey(selectedAgentRef.current);
    const routedKey = resolveTaskRoute(taskId, null, null, agentsRef.current);
    const mirrorKey = resolveMirrorRoute(taskId);
    const activeSess = getStoreSession(activeKey);
    const shouldSync = touched.includes(activeKey)
      || activeKey === resolvedKey
      || activeKey === mirrorKey
      || routedKey === activeKey
      || activeSess.currentTask?.id === taskId
      || (activeSess.executing && (routedKey === activeKey || mirrorKey === activeKey));
    if (shouldSync) syncSessionToState(activeKey);
  }
  finalizeTaskInUiRef.current = finalizeTaskInUi;

  const recoverActiveTasks = useCallback(async (syncKey) => {
    if (!window.electronAPI?.agent?.listActiveTasks) return false;
    try {
      const res = await window.electronAPI.agent.listActiveTasks();
      if (!res.success) return false;
      const tasks = res.tasks || [];
      for (const task of tasks) mergeTaskIntoStore(task);

      // 当前标签：后端仍在跑但 UI 已空闲 → 强制拉回进行中
      const key = syncKey || agentSessionKey(selectedAgentRef.current);
      const activeForKey = tasks.find((t) => {
        const k = inferSessionKeyFromTask(t);
        return k === key && ['running', 'pending'].includes(t.status);
      });
      const sess = getStoreSession(key);
      if (activeForKey && !sess.executing) {
        mergeTaskIntoStore(activeForKey);
        setRunningRev(r => r + 1);
      }
      // 后端已无进行中任务，但 UI 仍锁着 → 用状态收尾（避免假「执行中」）
      if (!activeForKey && sess.executing && sess.currentTask?.id) {
        try {
          const st = await window.electronAPI.agent.getTaskStatus(sess.currentTask.id);
          if (st.success && ['completed', 'failed', 'cancelled'].includes(st.status?.status)) {
            finalizeTaskInUiRef.current?.(sess.currentTask.id, key, {
              currentTask: { ...st.status, status: st.status.status },
              currentUserPrompt: st.status.prompt || sess.currentUserPrompt,
              taskResult: st.status.result || null,
              taskSteps: preferRicherSteps(
                stepsFromTaskStatus(st.status),
                sess.taskSteps || [],
              ),
            });
          }
        } catch { /* ignore */ }
      }

      // 对账只刷新任务态，绝不覆盖输入框
      syncSessionToStateRef.current?.(key, { preserveAgentPrompt: true });
      return tasks.some(t => ['running', 'pending'].includes(t.status));
    } catch (err) {
      console.warn('[Debug] recoverActiveTasks failed:', err);
      return false;
    }
  }, []);

  /** 镜像标签卡在 executing 时，从 DB 拉取子任务终态并收尾 */
  async function recoverStuckMirrorTask(agentKey) {
    if (!agentKey || agentKey === '__hub__' || !window.electronAPI?.agent) return;
    const sess = getStoreSession(agentKey);
    if (!sess.executing || !sess.currentTask?.id || !sess.currentTask?.parentTaskId) return;
    if (!sessionTaskInstanceMatches(sess, sess.currentTask.id)) return;
    try {
      const res = await window.electronAPI.agent.getTaskStatus(sess.currentTask.id);
      if (!res.success) return;
      const status = res.status;
      if (!['completed', 'failed', 'cancelled'].includes(status.status)) return;
      finishDelegatedChildRef.current?.(
        {
          taskId: sess.currentTask.id,
          agentId: status.agent_id,
          sessionInstanceId: status.context?.sessionInstanceId,
          result: status.result,
        },
        status,
        status.status,
      );
      syncSessionToState(agentKey);
    } catch {
      // ignore
    }
  }

  // 切换侧边栏回到调试页时，从 store / 后端恢复进行中的任务
  useEffect(() => {
    if (location.pathname !== '/debug') return;
    const key = agentSessionKey(selectedAgent);
    // 空会话才用上次目录当种子；已有会话尊重其自身绑定
    seedEmptySessionWorkingDir(key);
    syncSessionToState(key);
    recoverActiveTasks(key);
    syncDelegatedMirrorToAgentTab(key, agentsRef.current);
    syncSessionToState(key);
    recoverStuckMirrorTask(key);
    recoverSessionHistory(key);
  }, [location.pathname, selectedAgent, recoverActiveTasks, recoverSessionHistory]);

  // 定期与后端对账：避免 UI 已显示「执行」而进程仍在跑
  useEffect(() => {
    if (location.pathname !== '/debug' || mode !== 'agent') return undefined;
    let alive = true;
    const tick = async () => {
      if (!alive || !isDebugRouteRef.current) return;
      const key = agentSessionKey(selectedAgentRef.current);
      await recoverActiveTasks(key);
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [location.pathname, mode, selectedAgent, recoverActiveTasks]);

  useEffect(() => {
    saveDebugMode(mode);
  }, [mode]);

  const agentNameMap = useMemo(
    () => Object.fromEntries((agents || []).map(a => [a.id, a.name])),
    [agents],
  );

  // 侧栏呼吸绿点：扫描各 Agent / 聚合入口会话是否在执行
  const runningAgentKeys = useMemo(() => {
    const keys = new Set();
    if (getStoreSession('__hub__').executing) keys.add('__hub__');
    for (const a of agents || []) {
      if (a?.id && getStoreSession(a.id).executing) keys.add(a.id);
    }
    return keys;
    // executing / runningRev：覆盖当前页与后台标签的启停
  }, [agents, executing, runningRev]);

  // 切换 Agent 标签时保存/恢复会话状态
  function switchAgent(agent) {
    const prevKey = agentSessionKey(selectedAgent);
    persistCurrentSessionHistory(prevKey);
    patchStoreSession(prevKey, {
      agentPrompt,
      currentUserPrompt,
      currentTask,
      taskSteps,
      taskResult,
      executing,
      delegations,
      conversationTurns,
      sessionWorkingDir: normalizeWorkingDir(agentWorkingDir) || getStoreSession(prevKey).sessionWorkingDir,
    });

    const key = agentSessionKey(agent);
    setStoreSelectedAgentId(agent?.id ?? null);
    selectedAgentRef.current = agent;
    setSelectedAgent(agent);
    seedEmptySessionWorkingDir(key);
    syncSessionToState(key);
    setDirError('');
    syncDelegatedMirrorToAgentTab(key, agentsRef.current);
    syncSessionToState(key);
    recoverStuckMirrorTask(key);
    recoverSessionHistory(key);
  }

  /** 将事件里的 agentId 规范化为当前标签页 session key */
  function eventSessionKey(agentId, sessionKey) {
    return resolveSessionKey(sessionKey, agentsRef.current)
      || resolveSessionKey(agentId, agentsRef.current)
      || sessionKey
      || agentId
      || null;
  }

  /** 从任务状态/完成事件补全步骤（DB 无步骤时用 summary/stdout 兜底） */
  function resolveTaskSteps(status, data, key) {
    const stored = getStoreSession(key).taskSteps || [];
    const dbSteps = status ? stepsFromTaskStatus(status) : [];
    const merged = resolveArchiveSteps(dbSteps, stored);
    if (merged.length) return merged;
    const out = status?.result?.summary
      || status?.result?.output
      || data?.result?.summary
      || data?.result?.output;
    if (out && String(out).trim()) {
      return [{
        taskId: status?.id || data?.taskId,
        stepType: 'output',
        content: String(out).trim(),
        timestamp: status?.completed_at || Date.now(),
        agentId: status?.agent_id || data?.agentId,
      }];
    }
    return [];
  }

  // 监听 Agent 事件：路由到对应标签页（主 Agent / 被派发子 Agent）
  useEffect(() => {
    if (!window.electronAPI?.agent) return;

    const finishDelegatedChild = (data, status, terminalStatus) => {
      const parentId = status?.context?.parentTaskId || data.parentTaskId;
      if (!parentId) return false;

      const parentKey = resolveTaskRoute(parentId, null, null, agentsRef.current) || '__hub__';
      const childId = data.taskId;
      const instanceId = status?.context?.sessionInstanceId
        || data.sessionInstanceId
        || resolveTaskInstance(childId);

      // 过期 session：若镜像标签仍匹配，继续收尾镜像页
      if (instanceId && !eventMatchesSession(parentKey, instanceId)) {
        const agentId = status?.agent_id || data.agentId;
        const agentKey = resolveSessionKey(agentId, agentsRef.current) || eventSessionKey(agentId, data.sessionKey);
        if (agentKey && eventMatchesAgentMirror(agentKey, instanceId)) {
          routeTaskMirror(childId, agentKey);
          let resolvedSteps = resolveTaskSteps(status, data, agentKey);
          if (!resolvedSteps.length) {
            resolvedSteps = getStoreSession(agentKey).taskSteps || [];
          }
          if (!resolvedSteps.length) {
            const summary = status?.result?.summary || data?.result?.summary;
            if (summary) {
              resolvedSteps = [{ stepType: 'output', content: String(summary), timestamp: Date.now(), agentId }];
            }
          }
          finalizeTaskInUiRef.current?.(childId, agentKey, {
            currentTask: status
              ? { ...status, status: terminalStatus }
              : { id: childId, status: terminalStatus, error: data.error },
            currentUserPrompt: status?.prompt || data.prompt || getStoreSession(agentKey).currentUserPrompt,
            taskResult: status?.result || data.result || null,
            taskSteps: resolvedSteps,
          });
          return true;
        }
        releaseExecutingForTask(childId, { status: terminalStatus });
        return true;
      }
      const agentId = status?.agent_id || data.agentId;
      const agentKey = resolveSessionKey(agentId, agentsRef.current) || eventSessionKey(agentId, data.sessionKey);
      const mirrorKey = resolveMirrorRoute(childId) || agentKey;

      const prevDel = getStoreSession(parentKey).delegations?.[childId] || {};
      const mirrorStored = prevDel.steps?.length
        ? prevDel.steps
        : (getStoreSession(mirrorKey).taskSteps || []);
      const dbSteps = status ? stepsFromTaskStatus(status) : [];
      let resolvedSteps = preferRicherSteps(dbSteps, mirrorStored);
      if (!resolvedSteps.length) {
        resolvedSteps = prevDel.steps || getStoreSession(mirrorKey).taskSteps || [];
      }
      if (!resolvedSteps.length) {
        const summary = status?.result?.summary || data?.result?.summary;
        if (summary) {
          resolvedSteps = [{
            stepType: 'output',
            content: String(summary),
            timestamp: status?.completed_at || Date.now(),
            agentId,
          }];
        }
      }
      const nextDel = {
        ...prevDel,
        agentId,
        status: terminalStatus,
        result: status?.result || data.result || null,
        steps: resolvedSteps,
      };
      patchSession(parentKey, {
        delegations: {
          ...(getStoreSession(parentKey).delegations || {}),
          [childId]: nextDel,
        },
      });

      // 子 Agent 标签同步收尾归档
      if (agentKey && agentKey !== parentKey) {
        routeTaskMirror(childId, agentKey);
        finalizeTaskInUiRef.current?.(childId, agentKey, {
          currentTask: status
            ? { ...status, status: terminalStatus }
            : { id: childId, status: terminalStatus, error: data.error },
          currentUserPrompt: nextDel.prompt || status?.prompt || data.prompt || '',
          taskResult: status?.result || data.result || null,
          taskSteps: resolvedSteps.length ? resolvedSteps : (nextDel.steps || getStoreSession(agentKey).taskSteps),
        });
      } else {
        releaseExecutingForTask(childId, { status: terminalStatus });
      }
      return true;
    };
    finishDelegatedChildRef.current = finishDelegatedChild;

    const finishTask = async (data) => {
      if (!data?.taskId) return;

      // 收到 completed/failed 事件时，DB 可能仍为 running（写入延迟），需强制终态
      const eventTerminal = data.error ? 'failed' : 'completed';

      // 优先用已注册路由，确保子 Agent 标签页能正确收尾
      let key = resolveTaskRoute(data.taskId, null, null, agentsRef.current)
        || resolveTaskRoute(
          data.taskId,
          data.agentId,
          data.sessionKey,
          agentsRef.current,
        );

      try {
        const statusResult = await window.electronAPI.agent.getTaskStatus(data.taskId);
        if (statusResult.success) {
          const status = statusResult.status;
          key = key || inferSessionKeyFromTask(status);
          key = resolveSessionKey(key, agentsRef.current) || key;
          if (!key) key = data.sessionKey || data.agentId || resolveTaskRoute(data.taskId) || null;
          if (!key) return;

          const steps = resolveTaskSteps(status, data, key);
          const terminalStatus = ['completed', 'failed', 'cancelled'].includes(status.status)
            ? status.status
            : eventTerminal;

          const parentId = status.context?.parentTaskId || data.parentTaskId;
          if (parentId && finishDelegatedChild(data, status, terminalStatus)) {
            return;
          }

          const taskInstanceId = status.context?.sessionInstanceId
            || data.sessionInstanceId
            || resolveTaskInstance(data.taskId);
          if (taskInstanceId && key && !eventMatchesSession(key, taskInstanceId)) {
            releaseExecutingForTask(data.taskId, { status: terminalStatus });
            return;
          }

          finalizeTaskInUiRef.current?.(data.taskId, key, {
            currentTask: { ...status, status: terminalStatus },
            currentUserPrompt: status.prompt || getStoreSession(key).currentUserPrompt,
            taskResult: status.result || data.result || null,
            taskSteps: preferRicherSteps(steps, getStoreSession(key).taskSteps || []),
          });
          return;
        }
      } catch (err) {
        console.warn('[Debug] finishTask getTaskStatus failed:', err);
      }

      // DB 不可用或查询失败时仍释放 UI 锁，避免一直「正在执行…」
      key = key || eventSessionKey(data.agentId, data.sessionKey) || data.agentId || data.sessionKey;
      if (!key) return;
      const steps = resolveTaskSteps(null, data, key);
      const terminalStatus = data.error ? 'failed' : 'completed';

      const parentId = data.parentTaskId;
      if (parentId && finishDelegatedChild(data, null, terminalStatus)) {
        return;
      }

      finalizeTaskInUiRef.current?.(data.taskId, key, {
        currentUserPrompt: getStoreSession(key).currentUserPrompt || data.prompt,
        currentTask: { id: data.taskId, status: terminalStatus, error: data.error },
        taskResult: data.result || null,
        taskSteps: steps.length ? steps : getStoreSession(key).taskSteps,
      });
    };

    const handleDispatched = ({ parentTaskId, childTaskId, agentId, prompt, parentSessionKey, parentSessionInstanceId }) => {
      if (!childTaskId || !agentId) return;

      // 编排派发：子任务归属父窗口 session（当前标签页）
      if (parentTaskId) {
        const parentKey = resolveTaskRoute(parentTaskId, null, null, agentsRef.current)
          || parentSessionKey
          || '__hub__';
        const instanceId = parentSessionInstanceId
          || getStoreSession(parentKey).sessionInstanceId;
        if (instanceId && !eventMatchesSession(parentKey, instanceId)) return;

        routeTask(childTaskId, parentKey, instanceId);
        routeTask(parentTaskId, parentKey, instanceId);

        const parent = getStoreSession(parentKey);
        patchSession(parentKey, {
          delegations: {
            ...(parent.delegations || {}),
            [childTaskId]: {
              agentId,
              prompt,
              steps: [],
              status: 'running',
              result: null,
              sessionInstanceId: instanceId,
            },
          },
        });

        // 镜像到子 Agent 标签，切换过去也能看到执行过程
        const agentKey = resolveSessionKey(agentId, agentsRef.current)
          || eventSessionKey(agentId, agentId);
        if (agentKey && agentKey !== parentKey) {
          routeTaskMirror(childTaskId, agentKey);
          patchSession(agentKey, {
            currentUserPrompt: prompt,
            currentTask: { id: childTaskId, status: 'running', parentTaskId },
            taskSteps: [],
            taskResult: null,
            executing: true,
            mirroredSessionInstanceId: instanceId,
            // 认领子标签会话：即便刚点了「新会话」，派发也要落到该会话
            skipHistoryRecover: 0,
          });
          scheduleAutoFinalizeRef.current?.(childTaskId, agentKey);
        }
        return;
      }

      // 无父任务：直调子 Agent 标签
      const ownerKey = eventSessionKey(agentId, agentId);
      routeTask(childTaskId, ownerKey);
      patchSession(ownerKey, {
        currentUserPrompt: prompt,
        currentTask: { id: childTaskId, status: 'running' },
        taskSteps: [],
        taskResult: null,
        executing: true,
      });
    };

    const handleStep = (stepData) => {
      const { taskId, parentTaskId, agentId, sessionKey, sessionInstanceId, stepType } = stepData;

      if (stepType === 'delegation') {
        const hubKey = resolveTaskRoute(taskId, null, null, agentsRef.current) || '__hub__';
        const instanceId = sessionInstanceId || resolveTaskInstance(taskId);
        if (instanceId && !eventMatchesSession(hubKey, instanceId)) return;
        if (hubKey) {
          const hub = getStoreSession(hubKey);
          patchSession(hubKey, {
            taskSteps: [...(hub.taskSteps || []), stepData],
          });
          if (stepData.phase === 'complete' && stepData.childTaskId) {
            const dels = { ...(hub.delegations || {}) };
            if (dels[stepData.childTaskId]) {
              dels[stepData.childTaskId] = {
                ...dels[stepData.childTaskId],
                status: stepData.status || 'completed',
              };
            }
            patchSession(hubKey, { delegations: dels });
          }
        }
        return;
      }

      // 派发子任务步骤：父窗口 delegations + 子 Agent 标签镜像
      const mirrorKey = resolveMirrorRoute(taskId);
      const isDelegatedChild = !!parentTaskId || !!mirrorKey;
      if (isDelegatedChild) {
        const parentKey = parentTaskId
          ? (resolveTaskRoute(parentTaskId, null, null, agentsRef.current) || '__hub__')
          : (resolveTaskRoute(taskId, null, null, agentsRef.current) || '__hub__');
        const instanceId = sessionInstanceId
          || resolveTaskInstance(taskId)
          || resolveTaskInstance(parentTaskId);
        if (instanceId && !eventMatchesSession(parentKey, instanceId)) return;
        const parent = getStoreSession(parentKey);
        const dels = { ...(parent.delegations || {}) };
        const del = dels[taskId] || { agentId, prompt: '', steps: [], status: 'running' };
        del.steps = coalesceAgentSteps(del.steps || [], stepData);
        dels[taskId] = del;
        patchSession(parentKey, { delegations: dels });

        const agentKey = mirrorKey
          || resolveSessionKey(agentId, agentsRef.current)
          || eventSessionKey(agentId, sessionKey);
        if (agentKey && agentKey !== parentKey) {
          if (instanceId && !eventMatchesAgentMirror(agentKey, instanceId)) return;
          const agentSess = getStoreSession(agentKey);
          patchSession(agentKey, {
            currentUserPrompt: del.prompt || agentSess.currentUserPrompt,
            currentTask: {
              id: taskId,
              status: 'running',
              parentTaskId: parentTaskId || agentSess.currentTask?.parentTaskId,
            },
            taskSteps: coalesceAgentSteps(agentSess.taskSteps || [], stepData),
            executing: true,
          });
          if (stepData.content?.trim() || stepData.is_snapshot) {
            scheduleAutoFinalizeRef.current?.(taskId, agentKey);
          }
        }
        return;
      }

      const ownerKey = resolveTaskRoute(
        taskId,
        agentId,
        sessionKey,
        agentsRef.current,
      ) || eventSessionKey(agentId, sessionKey);
      if (ownerKey) {
        const instanceId = sessionInstanceId || resolveTaskInstance(taskId);
        if (instanceId && !eventMatchesSession(ownerKey, instanceId)) return;
        const sess = getStoreSession(ownerKey);
        const sameTask = !sess.currentTask || sess.currentTask.id === taskId;
        if (sameTask) {
          const prev = sess.taskSteps || [];
          // 收到步骤时拉回 executing，避免锁被误释放后无法停止/继续
          patchSession(ownerKey, {
            currentTask: sess.currentTask?.id === taskId
              ? { ...sess.currentTask, status: 'running' }
              : { id: taskId, status: 'running', parentTaskId: parentTaskId || sess.currentTask?.parentTaskId },
            taskSteps: coalesceAgentSteps(prev, stepData),
            executing: true,
          });
          // 同步 JSON 批量步骤到达后延迟收尾
          if (stepData.content?.trim() || stepData.is_snapshot) {
            scheduleAutoFinalizeRef.current?.(taskId, ownerKey);
          }
        }
      }
    };

    const handleCancelled = (data) => {
      const key = resolveTaskRoute(
        data.taskId,
        data.agentId,
        data.sessionKey,
        agentsRef.current,
      ) || eventSessionKey(data.agentId, data.sessionKey);
      if (key) {
        const sess = getStoreSession(key);
        const cliSid = data.result?.cliSessionId || sess.cliSessionId || null;
        finalizeTaskInUiRef.current?.(data.taskId, key, {
          currentTask: { id: data.taskId, status: 'cancelled' },
          currentUserPrompt: sess.currentUserPrompt,
          taskSteps: closePendingToolSteps(sess.taskSteps || [], t('debug.agent.aborted')),
          taskResult: {
            ...(sess.taskResult || {}),
            ...(data.result || {}),
            cliSessionId: cliSid,
            cancelled: true,
          },
        });
      }
    };

    /** 流式阶段尽早记住 sessionId，停止后即可 --resume */
    const handleCliSession = (data) => {
      if (!data?.taskId || !data?.cliSessionId) return;
      const key = resolveTaskRoute(
        data.taskId,
        data.agentId,
        data.sessionKey,
        agentsRef.current,
      ) || eventSessionKey(data.agentId, data.sessionKey);
      if (!key) return;
      const sess = getStoreSession(key);
      if (sess.currentTask?.id && sess.currentTask.id !== data.taskId) return;
      patchSession(key, { cliSessionId: data.cliSessionId });
    };

    const removeStep = window.electronAPI.agent.onStep(handleStep);
    const removeDispatched = window.electronAPI.agent.onDispatched
      ? window.electronAPI.agent.onDispatched(handleDispatched)
      : () => {};
    const removeCompleted = window.electronAPI.agent.onCompleted(finishTask);
    const removeFailed = window.electronAPI.agent.onFailed(finishTask);
    const removeCancelled = window.electronAPI.agent.onCancelled
      ? window.electronAPI.agent.onCancelled(handleCancelled)
      : () => {};
    const removeCliSession = window.electronAPI.agent.onCliSession
      ? window.electronAPI.agent.onCliSession(handleCliSession)
      : () => {};

    return () => {
      removeStep?.();
      removeDispatched?.();
      removeCompleted?.();
      removeFailed?.();
      removeCancelled?.();
      removeCliSession?.();
    };
  }, []);

  // Load available agents（有缓存则先展示，后台刷新）
  async function loadAgents({ force = false } = {}) {
    if (!window.electronAPI?.agent) {
      console.warn('Agent API not available');
      return;
    }

    const cached = getCachedAgentsList();
    // 旧缓存无 installed 字段时丢弃，避免未安装项误显示为彩色
    const cacheOk = cached?.length && !cached.some(
      (a) => a.type === 'cli' && typeof a.installed !== 'boolean',
    );
    if (cacheOk && !force) {
      setAgents(cached);
      setLoadingAgents(false);
    } else {
      setLoadingAgents(true);
    }

    try {
      const result = await window.electronAPI.agent.list({ force });
      if (result.success) {
        const list = result.agents || [];
        setCachedAgentsList(list);
        setAgents(list);
        // 若当前选中 Cursor 且已装好 CLI，同步刷新 selectedAgent
        setSelectedAgent((prev) => {
          if (!prev?.id) return prev;
          const next = list.find((a) => a.id === prev.id);
          return next || prev;
        });
      }
    } catch (error) {
      console.error('Failed to load agents:', error);
    } finally {
      setLoadingAgents(false);
    }
  }

  /** 游乐场一键安装 Cursor Agent CLI（官方脚本） */
  async function installCursorCli({ confirm = true } = {}) {
    if (!window.electronAPI?.agent?.installCursorCli) {
      alert(t('debug.agent.cursorNeedCli'));
      return false;
    }
    if (installingCursorCli) return false;
    if (confirm && !window.confirm(t('debug.agent.cursorInstallConfirm'))) return false;
    setInstallingCursorCli(true);
    setCursorInstallError('');
    try {
      const res = await window.electronAPI.agent.installCursorCli();
      if (!res?.success) {
        const msg = t('debug.agent.cursorInstallFail', { error: res?.error || 'unknown' });
        setCursorInstallError(msg);
        alert(msg);
        return false;
      }
      await loadAgents({ force: true });
      alert(res.already ? t('debug.agent.cursorInstallAlready') : t('debug.agent.cursorInstallOk'));
      return true;
    } catch (err) {
      const msg = t('debug.agent.cursorInstallFail', { error: err?.message || String(err) });
      setCursorInstallError(msg);
      alert(msg);
      return false;
    } finally {
      setInstallingCursorCli(false);
    }
  }

  /** 从资产加载已纳管的提示词，供 LLM 模式选用为 System */
  async function loadPromptList() {
    if (!window.electronAPI?.resource?.listResources) return;
    try {
      const res = await window.electronAPI.resource.listResources({ type: 'prompt' });
      if (res.success) {
        setPromptList(res.resources || []);
        // 列表刷新后若原选项已删除，清空选中态（保留已填入正文）
        setPanels(prev => {
          const main = prev.main;
          const key = panelLaneKey(main.imageMode);
          const lane = main[key] || defaultLane();
          const id = lane.selectedPromptId;
          if (!id) return prev;
          if ((res.resources || []).some(p => p.id === id)) return prev;
          return {
            ...prev,
            main: { ...main, [key]: { ...lane, selectedPromptId: '' } },
          };
        });
      }
    } catch (error) {
      console.warn('[PlayGround] loadPromptList failed:', error);
    }
  }

  /** 选择提示词模版 → 用模版全文覆盖输入框（取消选择则清空） */
  function applyPromptSelection(promptId) {
    if (!promptId) {
      // 顺带清掉历史残留的 systemPrompt（模版已改为写入 input，不再写系统提示）
      setPanel({ selectedPromptId: '', input: '', systemPrompt: '', showSystem: false });
      return;
    }
    const prompt = promptList.find(p => p.id === promptId);
    if (!prompt) return;
    setPanel({
      selectedPromptId: promptId,
      input: prompt.content || '',
      systemPrompt: '',
      showSystem: false,
    });
  }

  /** 当前轮仍有未闭合工具 / 任务未终态 → 视为进行中（可停止） */
  const taskCanStop = !!(
    executing
    || ['running', 'pending'].includes(currentTask?.status)
    || (currentUserPrompt && hasOpenToolCalls(taskSteps))
  );

  /** 停止后可一键续接（同工作目录 + 有 session / 中止轮） */
  const canResumeContinue = !taskCanStop && !!activeAgent && !!agentWorkingDir.trim()
    && canResumeInterruptedSession(agentSessionKey(selectedAgent), normalizeWorkingDir(agentWorkingDir.trim()));

  /** 停止后点「继续」：带 --resume / 进度摘要续跑 */
  function continueInterruptedAgent() {
    if (taskCanStop || !activeAgent) return;
    const text = agentPrompt.trim() || t('debug.agent.resumePrompt');
    executeAgent(text);
  }

  /** UI 展示用任务状态：与停止按钮同源，避免假「已完成」 */
  function displayTaskStatus() {
    if (taskCanStop) return 'running';
    const s = currentTask?.status;
    if (s === 'running' || s === 'pending') return 'completed';
    return s;
  }

  /** 轮询任务状态直到终态（IPC 事件兜底） */
  async function pollTaskUntilTerminal(taskId, execKey) {
    const maxAttempts = 1200; // ~10min
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise(r => setTimeout(r, 500));
      const sess = getStoreSession(execKey);
      if (isFreshAgentSession(sess)) return;
      if (!sessionTaskInstanceMatches(sess, taskId)) return;
      if (!sess.executing && sess.currentTask?.id === taskId
        && ['completed', 'failed', 'cancelled'].includes(sess.currentTask?.status)) {
        return;
      }

      // 不在此处提前收尾：1s 时往往只有推理、尚无正文，会导致归档后最终输出消失
      try {
        const res = await window.electronAPI.agent.getTaskStatus(taskId);
        if (!res.success) continue;
        const status = res.status;
        if (!['completed', 'failed', 'cancelled'].includes(status.status)) continue;

        if (status.context?.parentTaskId || sess.currentTask?.parentTaskId) {
          finishDelegatedChildRef.current?.(
            { taskId, agentId: status.agent_id, sessionInstanceId: status.context?.sessionInstanceId, result: status.result },
            status,
            status.status,
          );
          return;
        }

        const steps = resolveTaskSteps(status, { taskId, result: status.result }, execKey);
        finalizeTaskInUiRef.current?.(taskId, execKey, {
          currentTask: { ...status, status: status.status },
          currentUserPrompt: status.prompt || sess.currentUserPrompt,
          taskResult: status.result || null,
          taskSteps: steps.length ? steps : sess.taskSteps,
        });
        return;
      } catch {
        // 继续轮询
      }
    }
  }

  // Execute agent task（promptOverride 供「继续」一键续接，避免等 setState）
  async function executeAgent(promptOverride) {
    const text = String(promptOverride != null ? promptOverride : agentPrompt).trim();
    const attachList = promptOverride != null ? [] : pendingImages;
    const attachPayload = attachList.map(p => ({ dataUrl: p.dataUrl, name: p.name }));
    // 纯图时给默认提示，否则 CLI 无任务描述
    const prompt = text || (attachPayload.length ? t('debug.agent.imageOnlyPrompt') : '');
    if (!activeAgent || !prompt || !window.electronAPI?.agent) {
      return;
    }
    if (executing || taskCanStop) return;
    if (activeAgent.custom && isHubMode) {
      return;
    }
    // 未安装的 CLI 不可执行；Cursor 引导一键安装官方 Agent CLI
    if (activeAgent.type === 'cli' && activeAgent.installed === false) {
      if (activeAgent.id === 'cursor' && activeAgent.canInstallCli) {
        await installCursorCli({ confirm: true });
      } else {
        alert(t('debug.agent.notInstalled', { name: activeAgent.name }));
      }
      return;
    }
    // 聚合入口：主 Agent 须支持 MCP 编排（Claude Code / Codex）
    const orchestratorAgents = new Set(['claude-code', 'codex']);
    if (isHubMode && mainAgent && !orchestratorAgents.has(mainAgent.id)) {
      alert(t('debug.agent.hubNeedsMcp', { name: mainAgent.name }));
      return;
    }

    const execKey = agentSessionKey(selectedAgent);
    const workDir = normalizeWorkingDir(
      getStoreSession(execKey).sessionWorkingDir || agentWorkingDir.trim(),
    );
    if (!workDir) {
      setDirError(t('debug.agent.needWorkingDir'));
      return;
    }

    setDirError('');
    // 气泡展示原文；附图单独存 currentUserImages 缩略图渲染
    const displayPrompt = text || (attachPayload.length ? t('debug.agent.imageOnlyPrompt') : '');
    let displayImages = attachPayload.map(p => p.dataUrl).filter(Boolean);
    try { displayImages = await persistImageList(displayImages); } catch { /* 落盘失败仍用内存图 */ }
    setAgentPrompt(prompt);
    let sess = getStoreSession(execKey);

    // 内存轮次空但非「新会话」：从本地历史回填，避免跟一嘴就拆成新历史条
    if (!sess.conversationTurns?.length && !isFreshAgentSession(sess)) {
      const hist = findAgentSessionForContinue(execKey, {
        workingDir: workDir,
        cliSessionId: sess.cliSessionId,
      });
      if (hist?.conversationTurns?.length) {
        const threadId = hist.sessionKey
          || (hist.conversationTurns[0]?.taskId ? `task:${hist.conversationTurns[0].taskId}` : null);
        patchStoreSession(execKey, {
          conversationTurns: hist.conversationTurns,
          historyThreadId: threadId,
          cliSessionId: sess.cliSessionId || hist.cliSessionId || null,
          sessionWorkingDir: workDir || hist.sessionWorkingDir || '',
        });
        sess = getStoreSession(execKey);
        syncSessionToState(execKey, { preserveAgentPrompt: true });
      }
    }

    const continueSession = shouldContinueCliSession(execKey, workDir);
    const lastTurn = sess.conversationTurns?.length
      ? sess.conversationTurns[sess.conversationTurns.length - 1]
      : null;
    const resumeCliSessionId = continueSession
      ? (sess.cliSessionId || lastTurn?.cliSessionId || lastTurn?.result?.cliSessionId || undefined)
      : undefined;
    // 无 sessionId 时把上次进度写进 prompt，避免停止后续接「失忆」
    const execPrompt = (continueSession && !resumeCliSessionId
      && ['cancelled', 'failed'].includes(lastTurn?.status))
      ? buildInterruptedContinuePrompt(prompt, lastTurn)
      : prompt;
    const instanceId = beginSessionInstance(execKey);

    // 粘住历史线程：有轮次时务必带上 historyThreadId，防止后续归档按新 taskId 拆条
    const stickyThread = sess.historyThreadId
      || (sess.conversationTurns?.[0]?.taskId
        ? `task:${sess.conversationTurns[0].taskId}`
        : null);

    patchSession(execKey, {
      currentUserPrompt: displayPrompt,
      currentUserImages: displayImages,
      agentPrompt: '',
      executing: true,
      taskSteps: [],
      taskResult: null,
      currentTask: null,
      delegations: {},
      sessionWorkingDir: workDir,
      sessionInstanceId: instanceId,
      // 续接时保留 id，避免新一轮开始前被清空
      cliSessionId: resumeCliSessionId || sess.cliSessionId || null,
      historyThreadId: stickyThread,
    });
    setPendingImages([]);
    setAttachError('');

    // 聚合入口 = 主 Agent 编排；Agent tab = 直调
    const execMode = isHubMode ? 'orchestrator' : 'direct';

    try {
      const result = await window.electronAPI.agent.execute({
        agentId: activeAgent.id,
        prompt: execPrompt,
        options: {
          workingDir: workDir,
          mode: execMode,
          mainAgentId: isHubMode ? activeAgent.id : mainAgentId,
          mcpProfile: isHubMode ? MCP_PROFILE_DEVELOPMENT : undefined,
          sessionKey: execKey,
          sessionInstanceId: instanceId,
          continueSession,
          cliSessionId: resumeCliSessionId,
          images: attachPayload.length ? attachPayload : undefined,
        },
      });

      if (result.success) {
        routeTask(result.taskId, execKey, instanceId);
        patchSession(execKey, {
          currentUserPrompt: displayPrompt,
          currentUserImages: displayImages,
          executing: true,
          taskSteps: [],
          taskResult: null,
          currentTask: { id: result.taskId, status: 'running' },
          agentPrompt: '',
        });
        // IPC 完成事件丢失时的轮询兜底
        pollTaskUntilTerminal(result.taskId, execKey);
      } else {
        patchSession(execKey, { executing: false });
        setExecuting(false);
        alert(t('debug.agent.execFailed', { msg: result.error || t('debug.agent.unknownError') }));
      }
    } catch (error) {
      setExecuting(false);
      console.error('Agent execution error:', error);
      alert(t('debug.agent.execFailed', { msg: error.message }));
    }
  }

  async function pickWorkingDir() {
    if (!window.electronAPI?.agent?.pickWorkingDir) return;
    if (executing || taskCanStop) return;
    try {
      const result = await window.electronAPI.agent.pickWorkingDir(
        agentWorkingDir.trim() ? { defaultPath: agentWorkingDir.trim() } : {},
      );
      if (result.success && result.path) {
        const execKey = agentSessionKey(selectedAgent);
        const path = normalizeWorkingDir(result.path);
        const sess = getStoreSession(execKey);
        const prev = normalizeWorkingDir(sess.sessionWorkingDir);
        const hadTurns = !!(sess.conversationTurns?.length || sess.cliSessionId);
        // 绑到当前会话；已有对话换目录则丢掉 CLI resume，避免 --resume 到错误 cwd
        patchSession(execKey, {
          sessionWorkingDir: path,
          ...(hadTurns && prev && prev !== path ? { cliSessionId: null } : {}),
        });
        setAgentWorkingDir(path);
        saveAgentWorkingDir(path); // 仅作新会话种子
        setDirError('');
      }
    } catch (error) {
      console.error('Failed to pick directory:', error);
    }
  }

  async function cancelAgent() {
    if (!window.electronAPI?.agent) return;
    const execKey = agentSessionKey(selectedAgent);
    const snap = readStoreSnapshot(execKey);
    const closedSteps = closePendingToolSteps(snap.taskSteps || [], t('debug.agent.aborted'));
    const taskId = currentTask?.id || snap.currentTask?.id;
    // 停止前记下 session，取消接口也会回传已解析的 id
    let cliSid = snap.cliSessionId || snap.taskResult?.cliSessionId || null;

    try {
      if (window.electronAPI.agent.cancelAllActive) {
        const res = await window.electronAPI.agent.cancelAllActive();
        if (res?.cliSessionId) cliSid = res.cliSessionId;
      } else if (taskId) {
        const res = await window.electronAPI.agent.cancel(taskId);
        if (res?.cliSessionId) cliSid = res.cliSessionId;
      }
      if (taskId && !cliSid) {
        const st = await window.electronAPI.agent.getTaskStatus(taskId);
        cliSid = st?.status?.result?.cliSessionId || cliSid;
      }
    } catch (error) {
      console.error('Failed to cancel agent:', error);
    }

    // 无论后端是否找到进程，都释放 UI 锁并闭合未完成工具，避免卡死
    releaseAllExecutingSessions();
    const task = currentTask?.id
      ? { ...currentTask, status: 'cancelled' }
      : snap.currentTask?.id
        ? { ...snap.currentTask, status: 'cancelled' }
        : null;
    const resultWithSession = {
      ...(snap.taskResult || {}),
      cliSessionId: cliSid || snap.taskResult?.cliSessionId || null,
      cancelled: true,
    };
    // 有用户输入时归档本轮；保留 cliSessionId 供下一轮 --resume
    if (snap.currentUserPrompt || (snap.currentUserImages || []).length) {
      archiveCompletedTurn(execKey, {
        user: snap.currentUserPrompt || t('debug.agent.imageOnlyPrompt'),
        images: snap.currentUserImages || [],
        steps: closedSteps,
        delegations: snap.delegations || {},
        result: resultWithSession,
        status: 'cancelled',
        taskId: task?.id || null,
        cliSessionId: cliSid || null,
        workingDir: normalizeWorkingDir(snap.sessionWorkingDir || agentWorkingDir.trim()),
        timestamp: Date.now(),
      });
      patchSession(execKey, {
        executing: false,
        currentTask: task,
        currentUserPrompt: '',
        currentUserImages: [],
        taskSteps: [],
        taskResult: null,
        delegations: {},
        cliSessionId: cliSid || getStoreSession(execKey).cliSessionId || null,
        conversationTurns: getStoreSession(execKey).conversationTurns,
      });
    } else {
      patchSession(execKey, {
        executing: false,
        currentTask: task,
        taskSteps: closedSteps,
        cliSessionId: cliSid || snap.cliSessionId || null,
      });
    }
  }

  /** 清空当前标签页对话，便于开启新任务（目录继承当前会话，类似 Cursor 同工程开新 chat） */
  function startNewAgentSession() {
    const execKey = agentSessionKey(selectedAgent);
    const keepDir = normalizeWorkingDir(
      getStoreSession(execKey).sessionWorkingDir || agentWorkingDir || loadAgentWorkingDir(),
    );
    const doClear = () => {
      persistCurrentSessionHistory(execKey);
      clearSessionTaskState(execKey);
      if (keepDir) patchStoreSession(execKey, { sessionWorkingDir: keepDir });
      syncSessionToState(execKey);
    };
    if (executing || taskCanStop) {
      cancelAgent().then(() => {
        persistCurrentSessionHistory(execKey);
        clearSessionTaskState(execKey);
        if (keepDir) patchStoreSession(execKey, { sessionWorkingDir: keepDir });
        syncSessionToState(execKey);
      });
      return;
    }
    doClear();
  }

  // Load config + gateway status (to get actual running port)
  useEffect(() => {
    Promise.all([
      getConfig().read().catch(() => null),
      getLocalConfig().get().catch(() => null),
      getGateway().status().catch(() => null),
    ]).then(([c, lc, gwStatus]) => {
      setCfg(c);
      const gwPort = gwStatus?.port || 11430;
      const localGw = { ...LOCAL_GW, base_url: resolveLocalGatewayBase(gwPort).replace(/\/v1\/?$/, '') };
      setProvOpts(providerOptions(c, lc, localGw, t));
    });
  }, [t]);

  // When selected provider changes
  useEffect(() => {
    const opt = provOpts.find(o => o.id === selectedId) || LOCAL_GW;
    if (selectedId === '__custom__') {
      setToken(''); setModels([]); setSceneRoutes([]); setModel(''); setManualModel(true); return;
    }
    setToken(opt.token || '');

    // 本地网关：拉 /v1/models + P2P 在线，按 free/p2p/paid 分层
    if (selectedId === '__local_gw__') {
      setLoadingModels(true); setModels([]); setModel(''); setManualModel(false);
      let cancelled = false;
      (async () => {
        try {
          const [list, c, lc] = await Promise.all([
            loadGatewayAvailableModels(),
            getConfig().read().catch(() => null),
            getLocalConfig().get().catch(() => null),
          ]);
          if (cancelled) return;
          setSceneRoutes(Array.isArray(lc?.scene_routes) ? lc.scene_routes : []);
          const provById = Object.fromEntries((c?.providers || []).map(p => [p.id, p]));
          // 付费源未配 Key（如 Claude Code 官方订阅透传）：只能由对应客户端带自身登录凭证调用，游乐场直接发会失败
          const needsClientAuth = (m) => {
            if (m.personal || m.tier !== 'paid' || !m.owner) return false;
            const p = provById[m.owner];
            return !!p && p.type === 'paid' && !p.token;
          };
          const mapped = list.map((m) => ({
            name: m.id,
            tier: m.tier,
            type: resolveGatewayModelType(m.id, c),
            ...(needsClientAuth(m) ? { needsClientAuth: true } : {}),
          }));
          setModels(mapped);
          const preferred = mapped.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
          // 默认选第一个游乐场能直接调用的模型；都不可用时仍选第一个，由输入区提示引导
          const usable = preferred.filter(m => !m.needsClientAuth);
          setModel(modelSelectValue(usable[0] || preferred[0] || mapped[0]));
          setManualModel(mapped.length === 0);
        } catch {
          if (!cancelled) { setModels([]); setManualModel(true); }
        } finally {
          if (!cancelled) setLoadingModels(false);
        }
      })();
      return () => { cancelled = true; };
    }

    const staticMods = opt.models || [];
    if (staticMods.length > 0) {
      setModels(staticMods);
      const preferred = staticMods.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
      setModel((preferred[0] || staticMods[0])?.name || '');
      setManualModel(false);
      return;
    }
    // Try to fetch /v1/models from the provider
    const base = (opt.base_url || '').replace(/\/+$/, '');
    if (!base) { setModels([]); setModel(''); setManualModel(true); return; }
    const url = base + '/v1/models';
    const headers = {};
    if (opt.token) {
      if (/anthropic/i.test(base)) { headers['x-api-key'] = opt.token; headers['anthropic-version'] = '2023-06-01'; }
      else headers['Authorization'] = `Bearer ${opt.token}`;
    }
    setLoadingModels(true); setModels([]); setModel(''); setManualModel(false);
    const doFetch = async () => {
      try {
        let data;
        if (window.electronAPI?.llm) {
          const r = await window.electronAPI.llm.fetch(url, { headers });
          data = JSON.parse(r.body);
        } else {
          data = await fetch(url, { headers }).then(r => r.json());
        }
        const list = (data.data || []).map(m => ({ name: m.id || m.name, type: m.model_type || 'chat' })).filter(m => m.name);
        setModels(list);
        const preferred = list.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
        setModel((preferred[0] || list[0])?.name || '');
        setManualModel(list.length === 0);
      } catch {
        setModels([]); setManualModel(true);
      } finally {
        setLoadingModels(false);
      }
    };
    doFetch();
  }, [selectedId, provOpts, imageMode]);

  // When imageMode changes, try to switch to right model type
  useEffect(() => {
    if (!models.length) return;
    const preferred = models.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
    // 对话模式且当前选中场景路由 → 保留，勿被「非 image 模型列表」冲掉
    const sceneKeys = new Set(
      usableSceneRoutes(sceneRoutes, models).map(r => r.model_key || r.id).filter(Boolean),
    );
    if (!imageMode && sceneKeys.has(model)) return;
    if (preferred.length && !preferred.some(m => modelSelectValue(m) === model)) {
      setModel(modelSelectValue(preferred.find(m => !m.needsClientAuth) || preferred[0]));
    }
  }, [imageMode, models, model, sceneRoutes]);

  // 切到文生图时清空待发附图
  useEffect(() => {
    if (imageMode) {
      setPendingImages([]);
      setAttachError('');
    }
  }, [imageMode]);

  // Esc 关闭全屏预览
  useEffect(() => {
    if (!lightbox) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  // LLM ↔ Agent 切换时清空待发附图（两边共用 pendingImages）
  useEffect(() => {
    setPendingImages([]);
    setAttachError('');
  }, [mode]);

  // 聊天记录落盘：流式/生成中不写，避免频繁 IO
  useEffect(() => {
    if (sending) return;
    if (conversation.some(m => m.streaming || m.generating)) return;
    persistDebugPanel(panel);
  }, [panel, sending, conversation]);

  function setPanel(patch) {
    setPanels(prev => ({ ...prev, main: patchDebugPanel(prev.main, patch) }));
  }

  /** 更新当前模式车道的 conversation（流式/生图回调用） */
  function patchActiveConversation(mutator) {
    setPanels(prev => {
      const main = prev.main;
      const key = panelLaneKey(main.imageMode);
      const lane = main[key] || defaultLane();
      const nextConv = mutator([...(lane.conversation || [])]);
      return { ...prev, main: { ...main, [key]: { ...lane, conversation: nextConv } } };
    });
  }

  function handleClearChat() {
    if (!window.confirm(t('debug.clearConfirm'))) return;
    const doomed = collectImageRefIds(conversation);
    const otherLane = panel[imageMode ? 'chat' : 'image']?.conversation;
    const keep = collectImageRefIds(
      otherLane,
      listLlmSessionSnapshots().map((it) => it.conversation),
    );
    deleteUnreferencedImageIds(doomed, keep).catch(() => {});
    // 只清空当前模式车道，保留另一模式的聊天记录
    // 同步清空 systemPrompt：编辑 UI 已移除，残留会成不可见脏数据（如旧菜谱模版）
    setPanel({ conversation: [], input: '', selectedPromptId: '', systemPrompt: '', showSystem: false });
    setPendingImages([]);
    setAttachError('');
  }

  /** 用户消息是否可归档（有文字或附图） */
  function hasLlmUserTurn(msgs) {
    return (msgs || []).some(m =>
      m.role === 'user' && (String(m.content || '').trim() || (Array.isArray(m.images) && m.images.length > 0))
    );
  }

  /** 归档当前对话后开新会话 */
  function startNewLlmSession() {
    if (sending) return;
    const msgs = conversation || [];
    if (hasLlmUserTurn(msgs)) {
      saveLlmSessionSnapshot({
        conversation: msgs,
        systemPrompt,
        imageMode,
      });
    }
    // 必须清 systemPrompt：旧版「提示词→系统提示词」残留会跨会话继续注入
    setPanel({ conversation: [], input: '', selectedPromptId: '', systemPrompt: '', showSystem: false });
    setPendingImages([]);
    setAttachError('');
  }

  /** 恢复历史：先归档当前，再载入快照 */
  function restoreLlmSession(snapshot) {
    if (sending) return;
    const msgs = conversation || [];
    if (hasLlmUserTurn(msgs)) {
      saveLlmSessionSnapshot({
        conversation: msgs,
        systemPrompt,
        imageMode,
      });
    }
    const nextConv = (snapshot.conversation || []).map(m => ({
      ...m,
      streaming: false,
      generating: false,
    }));
    const nextImageMode = snapshot.imageMode != null ? !!snapshot.imageMode : imageMode;
    setPanel({
      imageMode: nextImageMode,
      conversation: nextConv,
      input: '',
      selectedPromptId: '',
      systemPrompt: snapshot.systemPrompt != null ? snapshot.systemPrompt : systemPrompt,
      showSystem: !!(snapshot.systemPrompt && String(snapshot.systemPrompt).trim()),
    });
    setPendingImages([]);
    setAttachError('');
  }

  const effectiveBase = selectedId === '__custom__' ? manualBaseUrl : (provOpts.find(o => o.id === selectedId)?.base_url || '');
  const anthropic     = isAnthropicUrl(effectiveBase);
  const filteredModels = models.filter(m => imageMode ? m.type === 'image' : m.type !== 'image');
  // 本地网关下无可直接调用的模型（列表为空，或选中的是需客户端凭证的源且未填 Key）→ 输入区给出引导
  const selectedModelEntry = models.find(m => modelSelectValue(m) === model);
  const modelBlockReason = (selectedId !== '__local_gw__' || loadingModels || manualModel || token) ? null
    : filteredModels.length === 0 ? 'none'
    : selectedModelEntry?.needsClientAuth ? 'clientAuth'
    : null;
  // 仅本地网关 + 对话模式展示场景路由（图像生成走图片类模型）
  const debugSceneRoutes = (selectedId === '__local_gw__' && !imageMode)
    ? usableSceneRoutes(sceneRoutes, models)
    : [];

  async function handleSend() {
    const text = input.trim();
    const attachUrls = pendingImages.map(p => p.dataUrl).filter(Boolean);
    // 对话模式：有文字或附图即可；文生图仍要求文字
    if (!model || !effectiveBase || sending || modelBlockReason) return;
    if (imageMode ? !text : (!text && !attachUrls.length)) return;

    if (imageMode) {
      const idx = conversation.length + 1;
      // 图像 API 无独立 system：将系统提示词前缀拼进最终 prompt
      const imagePrompt = systemPrompt.trim()
        ? `${systemPrompt.trim()}\n\n${text}`
        : text;
      setPanel({ input: '', conversation: [...conversation, { role: 'user', content: text }, { role: 'assistant', images: null, generating: true }] });
      setSending(true);
      await doGenerateImage({
        baseUrl: effectiveBase, token, model, prompt: imagePrompt,
        ratio: imageRatio || undefined, resolution: imageResolution || undefined, t,
        onDone: ({ images, totalMs }) => {
          persistImageList(images).then((stored) => {
            patchActiveConversation((next) => {
              next[idx] = { ...next[idx], images: stored, generating: false, timing: { totalMs } };
              return next;
            });
            setSending(false);
          }).catch(() => {
            patchActiveConversation((next) => {
              next[idx] = { ...next[idx], images, generating: false, timing: { totalMs } };
              return next;
            });
            setSending(false);
          });
        },
        onError: msg => {
          patchActiveConversation((next) => {
            next[idx] = { ...next[idx], generating: false, error: msg };
            return next;
          });
          setSending(false);
        },
      });
      return;
    }

    const apiMessages = [];
    if (systemPrompt.trim()) apiMessages.push({ role: 'system', content: systemPrompt.trim() });
    // 跳过空/失败的 assistant，避免上游报 messages.content 为空；历史用户附图一并带上
    for (const m of conversation) {
      if (m.role === 'user') {
        const raw = Array.isArray(m.images) ? m.images.filter(u => u && u !== B64_OMITTED) : [];
        let histImgs = raw;
        try { histImgs = await resolveImageList(raw); } catch { /* 用原列表 */ }
        histImgs = (histImgs || []).filter(u => u && u !== B64_OMITTED && !isImageRef(u));
        apiMessages.push({ role: 'user', content: buildMultimodalContent(m.content, histImgs) });
      } else if (m.role === 'assistant' && !m.error && String(m.content || '').trim()) {
        apiMessages.push({ role: 'assistant', content: m.content });
      }
    }
    apiMessages.push({ role: 'user', content: buildMultimodalContent(text, attachUrls) });

    let storedAttach = attachUrls;
    try { storedAttach = await persistImageList(attachUrls); } catch { /* 展示内存图 */ }
    const userMsg = storedAttach.length
      ? { role: 'user', content: text, images: storedAttach }
      : { role: 'user', content: text };
    const assistantIdx = conversation.length + 1;
    setPanel({ input: '', conversation: [...conversation, userMsg, { role: 'assistant', content: '', streaming: true }] });
    setPendingImages([]);
    setAttachError('');
    setSending(true);

    await doStreamChat({
      baseUrl: effectiveBase, token, model, messages: apiMessages, stream: streamMode, anthropic,
      emptyError: t('debug.emptyReply'),
      onChunk: delta => {
        patchActiveConversation((next) => {
          next[assistantIdx] = { ...next[assistantIdx], content: next[assistantIdx].content + delta };
          return next;
        });
      },
      onDone: timing => {
        patchActiveConversation((next) => {
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, timing };
          return next;
        });
        setSending(false);
      },
      onError: msg => {
        patchActiveConversation((next) => {
          next[assistantIdx] = { ...next[assistantIdx], streaming: false, error: msg };
          return next;
        });
        setSending(false);
      },
    });
  }

  function handleKeyDown(e) { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); } }
  function handleInputChange(e) {
    setPanel({ input: e.target.value });
  }

  /** 校验并加入待发附图 */
  async function addAttachFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => f && f.type.startsWith('image/'));
    if (!files.length) return;
    setAttachError('');
    const room = ATTACH_MAX_COUNT - pendingImages.length;
    if (room <= 0) {
      setAttachError(t('debug.attachLimit', { n: ATTACH_MAX_COUNT }));
      return;
    }
    const take = files.slice(0, room);
    if (files.length > room) setAttachError(t('debug.attachLimit', { n: ATTACH_MAX_COUNT }));
    const next = [...pendingImages];
    for (const file of take) {
      if (file.size > ATTACH_MAX_BYTES) {
        setAttachError(t('debug.attachSizeError'));
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        if (!dataUrl) continue;
        next.push({
          id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          dataUrl,
          name: file.name || 'image',
        });
      } catch {
        setAttachError(t('debug.attachSizeError'));
      }
    }
    setPendingImages(next.slice(0, ATTACH_MAX_COUNT));
  }

  function handleComposerPaste(e) {
    // 文生图模式不附图；Agent / LLM 对话均可粘贴
    if (mode === 'llm' && imageMode) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (!imageFiles.length) return;
    e.preventDefault();
    addAttachFiles(imageFiles);
  }

  function removePendingImage(id) {
    setPendingImages(prev => prev.filter(p => p.id !== id));
    setAttachError('');
  }

  // 共用：分段控件 — 轨道略深，选中白片才够对比（避免与浅色顶栏糊成一片）
  const segTrack = 'inline-flex rounded-lg p-0.5 bg-zinc-200/70 dark:bg-zinc-800/80 border border-zinc-300/50 dark:border-white/10';
  const segItem = (on) => `
    px-3 py-1 text-sm font-medium rounded-md transition-colors active:scale-[0.97]
    ${on
      ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-semibold shadow-[0_1px_2px_rgb(15_23_42/0.08)]'
      : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-100'
    }`;
  const segItemXs = (on) => `
    px-3 py-1.5 text-xs font-medium rounded-md transition-colors active:scale-[0.97]
    ${on
      ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 font-semibold shadow-[0_1px_2px_rgb(15_23_42/0.08)]'
      : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-300/40 dark:hover:bg-white/5'
    }`;
  const primaryBtn = 'shrink-0 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg flex items-center justify-center gap-2 transition-[transform,colors,opacity] duration-100 active:scale-[0.97]';
  const chromeTop = 'shrink-0 border-b border-white/40 dark:border-white/[0.06] bg-white/25 dark:bg-zinc-900/35 backdrop-blur-xl backdrop-saturate-150 relative z-40';
  const chromeBottom = 'shrink-0 border-t border-white/40 dark:border-white/[0.06] bg-white/40 dark:bg-zinc-900/45 backdrop-blur-xl backdrop-saturate-150 electron-no-drag relative z-40';
  const fieldCls = 'tb-soft-field rounded-lg text-xs text-zinc-900 dark:text-zinc-100';
  const ghostBtn = 'tb-soft-tile shrink-0 px-2.5 py-1.5 text-xs rounded-lg text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-40';
  const composerField = 'tb-soft-field flex-1 rounded-xl px-3 py-2.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 overflow-y-auto disabled:opacity-50';

  const modeSwitcher = (
    <div className={segTrack}>
      <button type="button" onClick={() => setMode('llm')} className={segItem(mode === 'llm')}>
        {t('debug.modeLlm')}
      </button>
      <button type="button" onClick={() => setMode('agent')} className={segItem(mode === 'agent')}>
        {t('debug.modeAgent')}
      </button>
    </div>
  );

  return (
    /* 顶栏拉通；智能体列表仅在 Agent 模式内容区内 */
    <div className="relative h-full min-h-0 flex flex-col bg-transparent">
      {/* ── 顶栏两层：模式+连接 / 模型（对话选项下沉到输入区上方）── */}
      <div className={`${chromeTop} px-4 pt-3 pb-2 electron-drag ${mode === 'llm' ? 'space-y-2' : ''}`}>

        {/* 第 1 层：LLM|Agent + 供给源 + URL + API Key */}
        <div className="flex gap-2 items-center flex-wrap min-h-[2rem]">
          <div className="electron-no-drag shrink-0">
            {modeSwitcher}
          </div>
          {mode === 'llm' && (
            <div className="electron-no-drag flex gap-2 items-center flex-wrap flex-1 min-w-0">
              <select value={selectedId} onChange={e => setSelectedId(e.target.value)}
                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 shrink-0">
                {provOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {selectedId === '__custom__' ? (
                <input value={manualBaseUrl} onChange={e => setManualBaseUrl(e.target.value)}
                  placeholder={t('debug.baseUrlPh')}
                  className="flex-1 min-w-[160px] bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500" />
              ) : (
                <code className="text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate max-w-[220px]">{effectiveBase}</code>
              )}
              <div className="flex gap-1 items-center ml-auto">
                {anthropic && effectiveBase && (
                  <span className="text-xs px-1.5 py-0.5 rounded-lg border border-zinc-200 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 shrink-0">{t('debug.protocolAnthropic')}</span>
                )}
                <input value={token} onChange={e => setToken(e.target.value)}
                  type={showToken ? 'text' : 'password'} placeholder={t('debug.apiKeyPh')} autoComplete="off"
                  className="w-36 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500" />
                <button onClick={() => setShowToken(v => !v)}
                  className="text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors shrink-0">
                  {showToken ? t('debug.hide') : t('debug.show')}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 第 2 层：对话/图像 → 模型 → 流式 */}
        {mode === 'llm' && (
          <div className="electron-no-drag flex gap-2 items-center flex-wrap">
            <div className={`${segTrack} shrink-0`}>
              {[{ v: false, l: t('debug.modeChat') }, { v: true, l: t('debug.modeImage') }].map(({ v, l }) => (
                <button key={String(v)} type="button" onClick={() => setPanel({ imageMode: v })}
                  className={segItemXs(imageMode === v)}>{l}</button>
              ))}
            </div>
            {loadingModels ? (
              <span className="text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-1.5">
                <span className="inline-block h-3 w-16 rounded bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
                {t('debug.loadingModels')}
              </span>
            ) : !manualModel && (filteredModels.length > 0 || debugSceneRoutes.length > 0) ? (
              <select value={model} onChange={e => setModel(e.target.value)}
                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 max-w-[280px]">
                {debugSceneRoutes.length > 0 && (
                  <optgroup label={t('gateway.app.sceneRoutes')}>
                    {debugSceneRoutes.map(r => (
                      <option key={r.id} value={r.model_key || r.id}>
                        {r.icon && !String(r.icon).startsWith('icon:') ? `${r.icon} ` : ''}{r.scene_name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {filteredModels.some(m => m.tier)
                  ? [{ key: 'local', tiers: ['free', 'paid'] }, { key: 'remote', tiers: ['p2p'] }].map(g => {
                      const tms = filteredModels.filter(m => g.tiers.includes(m.tier));
                      return tms.length ? (
                        <optgroup key={g.key} label={t(`debug.tier.${g.key}`)}>
                          {tms.map(m => <option key={modelSelectValue(m)} value={modelSelectValue(m)}>{m.name}{m.needsClientAuth ? t('debug.needsClientAuthTag') : ''}</option>)}
                        </optgroup>
                      ) : null;
                    })
                  : filteredModels.map(m => <option key={m.name} value={m.name}>{m.name}</option>)
                }
              </select>
            ) : (
              <input value={model} onChange={e => setModel(e.target.value)}
                placeholder={t('debug.modelPh')}
                className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-blue-500 w-44" />
            )}
            {!loadingModels && models.length > 0 && (
              <button onClick={() => setManualModel(v => !v)}
                className="text-xs text-zinc-400 hover:text-blue-500 transition-colors shrink-0">
                {manualModel ? t('debug.pickFromList') : t('debug.manualInput')}
              </button>
            )}
            {!imageMode && (
              <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer select-none">
                <input type="checkbox" checked={streamMode} onChange={e => setPanel({ streamMode: e.target.checked })} className="w-3.5 h-3.5 accent-blue-600" />
                {t('debug.stream')}
              </label>
            )}
            {/* 图像：比例 / 分辨率放顶部 */}
            {imageMode && (
              <>
                <select value={imageRatio} onChange={e => setPanel({ imageRatio: e.target.value })}
                  className={`${fieldCls} px-2 py-1.5`}>
                  <option value="">{t('debug.ratioDefault')}</option>
                  {['1:1','4:3','3:4','16:9','9:16','3:2','2:3','21:9'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <select value={imageResolution} onChange={e => setPanel({ imageResolution: e.target.value })}
                  className={`${fieldCls} px-2 py-1.5`}>
                  <option value="">{t('debug.resolutionDefault')}</option>
                  {['1k','2k','4k'].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </>
            )}
          </div>
        )}

      </div>

      {/* ── 主体：Agent 模式下左侧智能体列表 + 右侧对话 ── */}
      <div className="flex flex-1 min-h-0 min-w-0">
        {mode === 'agent' && (
          <AgentTabBar
            agents={agents}
            selectedAgent={selectedAgent}
            mainAgentId={mainAgentId}
            onSelect={switchAgent}
            onSetMainAgent={setMainAgent}
            loading={loadingAgents && agents.length === 0}
            runningKeys={runningAgentKeys}
            onInstallCursorCli={() => installCursorCli({ confirm: true })}
            installingCursorCli={installingCursorCli}
          />
        )}

        <div className="flex flex-col flex-1 min-w-0 min-h-0 tb-chat-well rounded-br-[var(--tb-radius-shell)] overflow-hidden">
      {/* ── Message list / Agent UI（井底略深，衬出气泡对比）── */}
      <div className="flex-1 overflow-y-auto px-4 pt-3 pb-4 space-y-4 min-h-0 tb-scroll-layer">
        {mode === 'llm' ? (
          /* LLM Mode: Chat messages */
          <>
        {conversation.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-zinc-400 dark:text-zinc-500 select-none">
            <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">{imageMode ? t('debug.modeImage') : t('debug.modeChat')}</p>
            <p className="text-sm max-w-sm">{imageMode ? t('debug.emptyImage') : t('debug.emptyChat')}</p>
          </div>
        )}

        {conversation.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[75%]">
              {msg.error ? (
                <div className="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-xl px-4 py-2.5 text-sm text-red-600 dark:text-red-400">{msg.error}</div>
              ) : msg.role === 'assistant' && msg.images !== undefined ? (
                <div className="rounded-xl overflow-hidden tb-soft-bubble">
                  {msg.generating ? (
                    <div className="px-4 py-6 space-y-2">
                      <div className="h-3 w-28 rounded bg-zinc-200 dark:bg-zinc-700 animate-pulse" />
                      <div className="h-36 w-full max-w-xs rounded-lg bg-zinc-100 dark:bg-zinc-800 animate-pulse" />
                      <p className="text-xs text-zinc-400">{t('debug.generating')}</p>
                    </div>
                  ) : (() => {
                    const displayImages = (msg.images || []).filter(src => src && src !== B64_OMITTED);
                    const hasOmitted = (msg.images || []).some(src => src === B64_OMITTED);
                    if (displayImages.length > 0) {
                      return (
                    <div className="space-y-2 p-2">
                      {displayImages.map((src, j) => (
                        <PersistableGenImage key={j} src={src} t={t} onPreview={setLightbox} />
                      ))}
                      {hasOmitted && (
                        <p className="px-2 pb-1 text-xs text-zinc-400 dark:text-zinc-500">{t('debug.imageNotRestored')}</p>
                      )}
                    </div>
                      );
                    }
                    if (hasOmitted) {
                      return <div className="px-4 py-3 text-sm text-zinc-400 dark:text-zinc-500">{t('debug.imageNotRestored')}</div>;
                    }
                    return <div className="px-4 py-3 text-sm text-zinc-400 dark:text-zinc-500">{t('debug.noImage')}</div>;
                  })()}
                </div>
              ) : (
                <div className={`relative group rounded-xl px-4 py-2.5 text-sm ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white whitespace-pre-wrap'
                    : 'tb-soft-bubble text-zinc-900 dark:text-zinc-100'
                }`}>
                  {msg.role === 'assistant' ? (
                    <>
                      <StreamMarkdownContent
                        content={msg.content || ''}
                        live={!!msg.streaming}
                        className="text-sm leading-relaxed"
                      />
                      {msg.streaming && (
                        <span className="animate-pulse text-blue-400 dark:text-blue-400 ml-0.5">▊</span>
                      )}
                      {/* 悬停显示复制；复制原文 Markdown */}
                      {!msg.streaming && String(msg.content || '').trim() && (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(msg.content);
                              setCopiedMsgIdx(i);
                              setTimeout(() => setCopiedMsgIdx(v => (v === i ? null : v)), 1500);
                            } catch { /* ignore */ }
                          }}
                          className="absolute top-2 right-2 px-2 py-0.5 text-[11px] rounded-lg bg-zinc-100/90 dark:bg-zinc-700/90 text-zinc-500 dark:text-zinc-300 border border-zinc-200/80 dark:border-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          {copiedMsgIdx === i ? t('debug.copied') : t('debug.copy')}
                        </button>
                      )}
                    </>
                  ) : (
                    <>
                      {/* 用户附图缩略图（持久化后可能为占位） */}
                      {Array.isArray(msg.images) && msg.images.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-1.5">
                          {msg.images.map((src, j) => (
                            <PersistableThumb
                              key={j}
                              src={src}
                              omittedLabel={t('debug.imageNotRestored')}
                              onPreview={setLightbox}
                            />
                          ))}
                        </div>
                      )}
                      {msg.content || null}
                    </>
                  )}
                </div>
              )}
              {msg.timing && (
                <p className="text-xs text-zinc-400 dark:text-zinc-400 mt-1 px-1 flex items-center gap-2">
                  <span>
                    {msg.timing.firstTokenMs != null ? t('debug.firstToken', { ms: msg.timing.firstTokenMs }) : ''}{t('debug.total', { ms: msg.timing.totalMs })}
                  </span>
                </p>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
          </>
        ) : (
          /* Agent Mode：右侧对话流 */
          <div className="h-full flex flex-col">
            {isHubMode ? (
              /* 聚合入口：由主 Agent 编排 */
              !mainAgent ? (
                <div className="flex-1 flex items-center justify-center text-center text-zinc-400 dark:text-zinc-500">
                  <p className="text-sm">{t('debug.agent.noAgents')}</p>
                </div>
              ) : !conversationTurns.length && !currentUserPrompt && !currentUserImages.length && !taskSteps.length && !executing ? (
                <div className="flex-1 flex items-center justify-center text-center text-zinc-400 dark:text-zinc-500 px-6">
                  <div className="max-w-md">
                    <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-2">{t('debug.tabs.hub')}</p>
                    <p className="text-sm mb-4">{t('debug.agent.hubEmpty')}</p>
                    <div className="flex items-center justify-center gap-2 text-sm">
                      <span className="text-zinc-500">{t('debug.agent.mainAgentColon')}</span>
                      <select
                        value={mainAgentId}
                        onChange={e => {
                          const agent = agents.find(a => a.id === e.target.value);
                          if (agent) setMainAgent(agent);
                        }}
                        className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2 py-1 text-zinc-900 dark:text-zinc-100"
                      >
                        {agents.filter(a => a.type === 'cli' && a.installed !== false).map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                    <p className="text-xs text-zinc-400 mt-3">
                      {t('debug.agent.setMainHint')}
                    </p>
                  </div>
                </div>
              ) : (
                <ExecutionLog
                  conversationTurns={conversationTurns}
                  userPrompt={currentUserPrompt}
                  userImages={currentUserImages}
                  steps={taskSteps}
                  status={displayTaskStatus()}
                  result={taskResult}
                  task={currentTask}
                  agentName={t('debug.agent.mainSuffix', { name: mainAgent.name })}
                  delegations={delegations}
                  agentNames={agentNameMap}
                  onPreviewImage={setLightbox}
                />
              )
            ) : selectedAgent?.id === 'cursor' && selectedAgent.installed === false ? (
              /* Cursor 缺 Agent CLI：默认展示一键安装引导 */
              <div className="flex-1 flex items-center justify-center text-center px-6">
                <div className="max-w-md space-y-3">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {t('debug.agent.cursorInstallTitle')}
                  </p>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    {t('debug.agent.cursorInstallBody')}
                  </p>
                  {selectedAgent.idePresent && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">
                      {t('debug.agent.cursorInstallIdeNote')}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={installingCursorCli}
                    onClick={() => installCursorCli({ confirm: true })}
                    className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium disabled:opacity-60"
                  >
                    {installingCursorCli ? t('debug.tabs.installingCli') : t('debug.tabs.installCli')}
                  </button>
                  {cursorInstallError && (
                    <p className="text-xs text-red-500 dark:text-red-400">{cursorInstallError}</p>
                  )}
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono break-all">
                    {t('debug.agent.cursorInstallManual')}
                  </p>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 font-mono break-all">
                    {t('debug.agent.cursorInstallManualWin')}
                  </p>
                </div>
              </div>
            ) : (
              <ExecutionLog
                conversationTurns={conversationTurns}
                userPrompt={currentUserPrompt}
                userImages={currentUserImages}
                steps={taskSteps}
                status={displayTaskStatus()}
                result={taskResult}
                task={currentTask}
                agentName={selectedAgent?.name}
                onPreviewImage={setLightbox}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Input bar（毛玻璃；顶缘可拖调高）── */}
      <div className={`${chromeBottom} px-4 py-3${composerResizing ? ' select-none' : ''}`}>
        {/* 顶缘隐式拖拽热区：无蓝线/分割条，仅 cursor 提示可调高输入区 */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('debug.composerResize')}
          title={t('debug.composerResize')}
          onMouseDown={onComposerResizeStart}
          className="absolute left-0 right-0 top-0 h-2 -mt-1 z-50 cursor-row-resize bg-transparent"
        />
        {mode === 'llm' ? (
          <div className="space-y-2">
            {modelBlockReason && (
              <div className="flex items-center gap-3 rounded-lg border border-blue-200/70 dark:border-blue-900/50 bg-blue-50/70 dark:bg-blue-950/30 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-300">
                <span className="flex-1">
                  {modelBlockReason === 'none' ? t('debug.noUsableModel') : t('debug.clientAuthModel')}
                </span>
                <button type="button" onClick={() => navigate('/providers')}
                  className="shrink-0 px-2.5 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 transition-colors">
                  {t('debug.goProviders')}
                </button>
              </div>
            )}
            {/* 提示词模板 / 历史 */}
            <div className="flex gap-2 items-center flex-wrap">
              <select
                value={selectedPromptId}
                onChange={e => applyPromptSelection(e.target.value)}
                title={t('debug.promptSelectTitle')}
                className={`${fieldCls} px-2 py-1 max-w-[280px]`}
              >
                {(() => {
                  // 图像模式只列图片类；对话模式只列文本类（缺省视为文本）
                  const modePrompts = promptList.filter(p => {
                    const kind = p?.metadata?.promptKind === 'image' ? 'image' : 'text';
                    return imageMode ? kind === 'image' : kind === 'text';
                  });
                  return (
                    <>
                      <option value="">
                        {modePrompts.length === 0 ? t('debug.promptEmpty') : t('debug.promptNone')}
                      </option>
                      {modePrompts.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.display_name || p.name}
                        </option>
                      ))}
                    </>
                  );
                })()}
              </select>
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => setLlmHistoryOpen(true)} className={ghostBtn}>
                  {t('debug.agent.history')}
                </button>
                {conversation.length > 0 && (
                  <button type="button" onClick={startNewLlmSession} disabled={sending} className={ghostBtn}>
                    {t('debug.agent.newSession')}
                  </button>
                )}
                {conversation.length > 0 && (
                  <button type="button" onClick={handleClearChat}
                    className="text-xs text-zinc-400 dark:text-zinc-500 hover:text-red-500 dark:hover:text-red-400 transition-colors px-1"
                    title={t('debug.clearChat')}>
                    {t('debug.clearChat')}
                  </button>
                )}
              </div>
            </div>
            {/* 待发附图缩略图（仅对话模式） */}
            {!imageMode && pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 items-center">
                {pendingImages.map(p => (
                  <div key={p.id} className="relative group">
                    <img
                      src={p.dataUrl}
                      alt={p.name}
                      className="h-14 w-14 object-cover rounded-lg border border-zinc-200 dark:border-zinc-600"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(p.id)}
                      title={t('debug.removeImage')}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 text-white text-xs leading-none opacity-80 hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachError && !imageMode && (
              <p className="text-xs text-red-500 dark:text-red-400">{attachError}</p>
            )}
            <div className="flex gap-2 items-end">
              {!imageMode && (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={ATTACH_ACCEPT}
                    multiple
                    className="hidden"
                    onChange={e => {
                      addAttachFiles(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sending || pendingImages.length >= ATTACH_MAX_COUNT}
                    title={t('debug.attachImage')}
                    className={`${ghostBtn} w-9 h-9 shrink-0 flex items-center justify-center`}
                  >
                    {/* 回形针图标：选图附图 */}
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                </>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handleComposerPaste}
                placeholder={imageMode ? t('debug.inputImagePh') : t('debug.inputChatPh')}
                rows={2}
                style={{ resize: 'none', height: composerTextH, minHeight: COMPOSER_H_MIN }}
                className={composerField}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={
                  sending
                  || !model
                  || !effectiveBase
                  || !!modelBlockReason
                  || (imageMode ? !input.trim() : (!input.trim() && pendingImages.length === 0))
                }
                className={`${primaryBtn} w-9 h-9`}
              >
                {sending
                  ? <span className="w-3.5 h-3.5 rounded-sm bg-white/70 animate-pulse" />
                  : <span className="text-white text-sm">↑</span>}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {/* 工作目录 + 历史 / 新会话：始终可见 */}
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={pickWorkingDir}
                disabled={!activeAgent || executing || taskCanStop}
                title={t('debug.agent.pickDirHint')}
                className={ghostBtn}
              >
                {t('debug.agent.pickDir')}
              </button>
              {isHubMode && mainAgent && (
                <span className="shrink-0 text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('debug.agent.mainShort', { name: mainAgent.name })}
                </span>
              )}
              {agentWorkingDir ? (
                <button
                  type="button"
                  onClick={() => openLocalPath(agentWorkingDir)}
                  title={t('debug.agent.sessionDirTitle', { dir: agentWorkingDir })}
                  className="flex-1 min-w-0 truncate text-xs font-mono text-left text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors"
                >
                  <span className="font-sans font-medium text-zinc-700 dark:text-zinc-200">
                    {workingDirBasename(agentWorkingDir)}
                  </span>
                  <span className="text-zinc-400 dark:text-zinc-500 ml-1.5">{agentWorkingDir}</span>
                </button>
              ) : (
                <span className="flex-1 min-w-0 truncate text-xs font-mono text-zinc-400 dark:text-zinc-500">
                  {t('debug.agent.noWorkingDir')}
                </span>
              )}
              <button type="button" onClick={() => setHistoryOpen(true)} className={ghostBtn}>
                {t('debug.agent.history')}
              </button>
              {(conversationTurns.length > 0 || currentUserPrompt || currentUserImages.length > 0 || taskSteps.length > 0 || executing || taskCanStop) && (
                <button type="button" onClick={startNewAgentSession} className={ghostBtn}>
                  {t('debug.agent.newSession')}
                </button>
              )}
            </div>
            {dirError && <p className="text-xs text-red-500 dark:text-red-400">{dirError}</p>}

            {/* 待发附图缩略图 */}
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 items-center">
                {pendingImages.map(p => (
                  <div key={p.id} className="relative group">
                    <img
                      src={p.dataUrl}
                      alt={p.name}
                      className="h-14 w-14 object-cover rounded-lg border border-zinc-200 dark:border-zinc-600"
                    />
                    <button
                      type="button"
                      onClick={() => removePendingImage(p.id)}
                      title={t('debug.removeImage')}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-800 text-white text-xs leading-none opacity-80 hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachError && (
              <p className="text-xs text-red-500 dark:text-red-400">{attachError}</p>
            )}

            <div className="flex gap-2 items-end">
              <input
                ref={fileInputRef}
                type="file"
                accept={ATTACH_ACCEPT}
                multiple
                className="hidden"
                onChange={e => {
                  addAttachFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!activeAgent || taskCanStop || pendingImages.length >= ATTACH_MAX_COUNT}
                title={t('debug.attachImage')}
                className={`${ghostBtn} w-9 h-9 shrink-0 flex items-center justify-center`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <textarea
                ref={agentTextareaRef}
                value={agentPrompt}
                onChange={e => setAgentPrompt(e.target.value)}
                onPaste={handleComposerPaste}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (!taskCanStop && activeAgent && (agentPrompt.trim() || pendingImages.length > 0)) executeAgent();
                  }
                }}
                disabled={!activeAgent}
                placeholder={
                  !activeAgent
                    ? t('debug.agent.needAgent')
                    : isHubMode
                      ? t('debug.agent.hubPlaceholder', { name: mainAgent?.name || '' })
                      : t('debug.agent.directPlaceholder', { name: selectedAgent.name })
                }
                rows={2}
                style={{ resize: 'none', height: composerTextH, minHeight: COMPOSER_H_MIN }}
                className={`${composerField} resize-none`}
              />
              {taskCanStop ? (
                <button type="button" onClick={cancelAgent}
                  className="shrink-0 px-4 h-9 bg-red-600 hover:bg-red-500 text-white rounded-lg flex items-center justify-center gap-2 transition-[transform,colors] duration-100 active:scale-[0.97]">
                  <span className="w-3 h-3 bg-white rounded-sm" />
                  <span className="text-sm">{t('debug.agent.stop')}</span>
                </button>
              ) : canResumeContinue ? (
                <button type="button" onClick={continueInterruptedAgent} title={t('debug.agent.continueTitle')}
                  className={`${primaryBtn} px-4 h-9`}>
                  <span className="text-sm">{t('debug.agent.continue')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => executeAgent()}
                  disabled={!activeAgent || (!agentPrompt.trim() && pendingImages.length === 0)}
                  className={`${primaryBtn} px-4 h-9`}
                >
                  <span className="text-sm">{t('debug.agent.execute')}</span>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
      </div>

      {/* 右侧：文件夹 / 文本 / 图片预览侧栏 */}
      <LocalFilePreviewHost />
      </div>

      {/* ── 历史会话 ── */}
      <LlmSessionHistoryPanel
        open={llmHistoryOpen && mode === 'llm'}
        onClose={() => setLlmHistoryOpen(false)}
        onRestore={restoreLlmSession}
      />
      <AgentSessionHistoryPanel
        open={historyOpen && mode === 'agent'}
        onClose={() => setHistoryOpen(false)}
        agentKey={agentSessionKey(selectedAgent)}
        agentLabel={isHubMode ? t('debug.agent.hubLabel', { name: mainAgent?.name || '' }) : selectedAgent?.name}
        listAgentId={isHubMode ? mainAgent?.id : selectedAgent?.id}
        onRestore={restoreHistorySession}
      />

      {/* 全屏预览挂到 body；须 electron-no-drag，否则顶部拖拽条会吞掉关闭点击 */}
      {lightbox && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9999]" role="dialog" aria-modal="true">
          {/* 独立遮罩层：整屏可点关闭 */}
          <button
            type="button"
            className="electron-no-drag absolute inset-0 bg-black/85 border-0 cursor-default"
            onClick={() => setLightbox(null)}
            aria-label={t('debug.preview.close')}
          />
          {/* 关闭钮避开顶部 h-11 拖拽热区（App.jsx electron-drag） */}
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="electron-no-drag fixed top-12 right-4 z-[10001] w-11 h-11 rounded-full bg-zinc-900/80 text-white text-xl leading-none flex items-center justify-center hover:bg-zinc-800 border border-white/20 shadow-lg"
            aria-label={t('debug.preview.close')}
          >
            ✕
          </button>
          <div className="relative z-[10000] flex h-full w-full items-center justify-center p-6 pt-16 pointer-events-none">
            <img
              src={lightbox}
              alt="preview"
              className="max-w-full max-h-full object-contain pointer-events-auto shadow-2xl"
            />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
