// Agent 对话流：典型 Agent 交互风格（用户消息 + 思考/工具/终端/回复 + 编排派发）
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  mergeStreamText,
  foldStreamSteps,
  normalizeLoose,
  looksLikeLeakedReasoning,
  looksLikeInlineReasoning,
  stripReasoningLeakage,
  repairThinkingOutputBoundary,
  hasClearReasoningBoundary,
  findUserFacingStart,
} from '../../shared/stream-text-merge.js';
import { MarkdownContent, StreamMarkdownContent, PathLink } from './RichMediaContent';
import { useLang } from '../store/lang';
import { usePinBottomScroll } from '../lib/use-pin-bottom-scroll';
import { closePendingToolSteps, hasOpenToolCalls } from '../lib/debug-agent-store';
import { ResolvedDebugImage } from './ResolvedDebugImage';
import { fileMarkerName } from '../lib/debug-image-store';

/** 启动/Hook 类系统事件：只进「正在执行」细节，不单独占卡片 */
function isEphemeralSystemEvent(ev) {
  if (!ev) return false;
  const sub = String(ev.system_subtype || '');
  if (sub === 'process_started' || sub === 'hook_response') return true;
  const c = String(ev.content || ev.message || '');
  return /SessionStart|会话上下文已加载|等待模型流式/i.test(c);
}

function isEphemeralSystemItem(item) {
  if (item?.kind === 'system_event') return isEphemeralSystemEvent(item);
  if (item?.kind === 'system_event_group') {
    const events = item.events || [];
    return events.length > 0 && events.every(isEphemeralSystemEvent);
  }
  return false;
}

/** 回复是否已是干净用户可见正文 */
function isCleanUserReply(text) {
  const o = String(text || '').trim();
  if (!o) return false;
  if (looksLikeLeakedReasoning(o)) return false;
  return /^(Hi|Hello|Hey|Sure|OK|Yes|No)\b/i.test(o) || /^[\u4e00-\u9fff《「]/.test(o);
}

/**
 * 时间线重绘（截断拼回已在 repairThinkingOutputBoundary 内完成）：
 * - 分界清晰 → 保留推理卡 + 干净回复
 * - 分界不清 → 不展示推理，整段当输出
 */
function redrawThinkingOutputPairs(items) {
  const out = items.map((x) => ({ ...x }));
  for (let i = 0; i < out.length; i++) {
    if (out[i]?.kind !== 'thinking_group') continue;
    let j = i + 1;
    while (j < out.length && (out[j]?.kind === 'system_event' || out[j]?.kind === 'system_event_group')) {
      j += 1;
    }
    if (j >= out.length || out[j]?.kind !== 'assistant') continue;

    const repaired = repairThinkingOutputBoundary(out[i].content, out[j].content);
    const think = String(repaired.thinking || '').trim();
    const reply = String(repaired.output || '').trim();
    // repair 已处理截断拼回；此处仅决定是否还单独展示推理卡
    const clear = !!think && isCleanUserReply(reply);

    if (!clear) {
      out[j] = { ...out[j], content: reply || [think, reply].filter(Boolean).join(' ').trim() || think };
      out.splice(i, 1);
      i -= 1;
      continue;
    }
    out[i] = { ...out[i], content: think };
    out[j] = { ...out[j], content: reply };
  }
  return out.filter(Boolean);
}

/** 步骤类型元数据（标签随语言切换） */
function getStepMeta(t) {
  return {
    /* 底色极淡：靠发丝线 + 字色区分，避免大块彩底抢视线 */
    thinking: { icon: '', label: t('debug.log.thinking'), accent: 'tb-soft-bubble' },
    tool_call: { icon: '', label: t('debug.log.toolCall'), accent: 'tb-soft-bubble' },
    tool_result: { icon: '', label: t('debug.log.toolResult'), accent: 'tb-soft-bubble' },
    code_edit: { icon: '', label: t('debug.log.codeEdit'), accent: 'tb-soft-bubble' },
    terminal: { icon: '', label: t('debug.log.terminal'), accent: 'border-zinc-300 bg-zinc-900/90 dark:border-zinc-600 text-zinc-100' },
    system_event: { icon: '', label: t('debug.log.system'), accent: 'tb-soft-bubble' },
    output: { icon: '', label: t('debug.log.reply'), accent: '' },
  };
}

/** 合并连续流式 output/thinking 片段 */
function mergeStreamingContents(steps) {
  return foldStreamSteps(steps);
}

/** 合并同一子任务的派发 start/complete 为一张卡片，避免只露出最终摘要 */
function mergeDelegationPairs(items) {
  const startIdx = new Map();
  const out = [];
  for (const item of items) {
    if (item.kind !== 'delegation' || !item.childTaskId) {
      out.push(item);
      continue;
    }
    if (item.phase === 'start') {
      startIdx.set(item.childTaskId, out.length);
      out.push({ ...item });
      continue;
    }
    if (item.phase === 'complete') {
      const idx = startIdx.get(item.childTaskId);
      if (idx != null) {
        const target = out[idx];
        out[idx] = {
          ...target,
          phase: 'complete',
          completeContent: item.content,
          status: item.status || target.status,
          delStatus: item.delStatus || target.delStatus,
          nestedSteps: (item.nestedSteps?.length ? item.nestedSteps : target.nestedSteps) || [],
          timestamp: item.timestamp || target.timestamp,
        };
        continue;
      }
    }
    out.push({ ...item });
  }
  return out;
}

/** 已有推理卡片时，将泄漏 reasoning 并入最后一张推理卡 */
function mergeLeakIntoThinkingItems(items, step) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].kind !== 'thinking_group') continue;
    items[i] = {
      ...items[i],
      content: mergeStreamText(items[i].content, step.content, {
        isDelta: !!step.is_delta,
        isSnapshot: !!step.is_snapshot,
      }),
      count: (items[i].count || 1) + 1,
      timestamp: step.timestamp || items[i].timestamp,
    };
    return true;
  }
  return false;
}

/** 已有推理卡时去掉重复的泄漏 assistant 气泡 */
function stripLeakedAssistantsWhenThinking(items) {
  const hasThinking = items.some(it => it.kind === 'thinking_group');
  if (!hasThinking) return items;
  return items.filter(it => {
    if (it.kind !== 'assistant' || !looksLikeLeakedReasoning(it.content)) return true;
    return false;
  });
}

/** 合并连续 output / thinking 步骤，减少碎片化 */
function buildTimeline(userPrompt, steps = [], delegations = {}, agentNames = {}, userImages = []) {
  const items = [];
  const imgs = Array.isArray(userImages) ? userImages.filter(Boolean) : [];
  if (userPrompt || imgs.length) {
    items.push({ kind: 'user', content: userPrompt || '', images: imgs });
  }

  let outputBuf = [];
  let thinkingBuf = [];
  let systemBuf = [];

  const flushOutput = () => {
    if (!outputBuf.length) return;
    items.push({
      kind: 'assistant',
      content: mergeStreamingContents(outputBuf),
      timestamp: outputBuf[outputBuf.length - 1]?.timestamp,
    });
    outputBuf = [];
  };

  const flushThinking = () => {
    if (!thinkingBuf.length) return;
    const content = mergeStreamingContents(thinkingBuf);
    const count = thinkingBuf.length;
    const ts = thinkingBuf[thinkingBuf.length - 1]?.timestamp;
    thinkingBuf = [];
    // 避免与上一条推理卡片重复
    const prev = items[items.length - 1];
    if (prev?.kind === 'thinking_group' && normalizeLoose(prev.content) === normalizeLoose(content)) {
      return;
    }
    items.push({
      kind: 'thinking_group',
      content,
      count,
      timestamp: ts,
    });
  };

  const flushSystem = () => {
    if (!systemBuf.length) return;
    if (systemBuf.length === 1) {
      items.push({ kind: 'system_event', ...systemBuf[0] });
    } else {
      items.push({
        kind: 'system_event_group',
        events: [...systemBuf],
        timestamp: systemBuf[systemBuf.length - 1]?.timestamp,
      });
    }
    systemBuf = [];
  };

  for (const step of steps) {
    const type = step.stepType || 'output';

    if (type === 'delegation') {
      flushOutput();
      flushThinking();
      flushSystem();
      const del = step.childTaskId ? delegations[step.childTaskId] : null;
      items.push({
        kind: 'delegation',
        ...step,
        agentName: agentNames[step.agentId] || step.agentId,
        nestedSteps: del?.steps || [],
        delStatus: del?.status,
      });
      continue;
    }

    if (type === 'thinking') {
      flushOutput();
      flushSystem();
      const last = thinkingBuf[thinkingBuf.length - 1];
      if (last) {
        const merged = mergeStreamText(last.content, step.content, {
          isDelta: !!step.is_delta,
          isSnapshot: !!step.is_snapshot,
        });
        if (merged === last.content && merged === step.content) continue;
        thinkingBuf[thinkingBuf.length - 1] = {
          ...last,
          content: merged,
          timestamp: step.timestamp || last.timestamp,
        };
        continue;
      }
      thinkingBuf.push(step);
      continue;
    }

    if (type === 'system_event') {
      flushOutput();
      flushThinking();
      const prev = systemBuf[systemBuf.length - 1];
      // 相同系统事件不重复堆叠（如 thinking_tokens 流式上报）
      if (prev
        && prev.system_subtype === step.system_subtype
        && prev.content === step.content) {
        continue;
      }
      systemBuf.push(step);
      continue;
    }

    if (type === 'output') {
      flushSystem();
      // 误泄漏的 reasoning：仅在分界清晰时拆出推理；否则整段当输出
      let outStep = step;
      if (looksLikeLeakedReasoning(step.content)) {
        const thinkHint = thinkingBuf[thinkingBuf.length - 1]?.content
          || [...items].reverse().find((it) => it.kind === 'thinking_group')?.content
          || '';
        const raw = String(step.content || '');
        const cleaned = stripReasoningLeakage(raw, thinkHint);
        const probe = thinkHint ? `${thinkHint} ${raw}` : raw;
        const cut = findUserFacingStart(raw);
        const canSplit = cut > 0 && cleaned && isCleanUserReply(cleaned)
          && hasClearReasoningBoundary(probe);
        if (canSplit) {
          const leakOnly = raw.slice(0, cut).trim();
          if (leakOnly) {
            const leakStep = { ...step, content: leakOnly, stepType: 'thinking' };
            if (thinkingBuf.length) {
              const last = thinkingBuf[thinkingBuf.length - 1];
              thinkingBuf[thinkingBuf.length - 1] = {
                ...last,
                content: mergeStreamText(last.content, leakOnly, {
                  isDelta: !!step.is_delta,
                  isSnapshot: !!step.is_snapshot,
                }),
                timestamp: step.timestamp || last.timestamp,
              };
            } else if (!mergeLeakIntoThinkingItems(items, leakStep)) {
              thinkingBuf.push(leakStep);
            }
          }
          outStep = { ...step, content: cleaned };
        }
        // else: 分界不清，outStep 保持原文输出
      }
      flushThinking();
      const last = outputBuf[outputBuf.length - 1];
      if (last) {
        const merged = mergeStreamText(last.content, outStep.content, {
          isDelta: !!outStep.is_delta,
          isSnapshot: !!outStep.is_snapshot,
        });
        if (merged === last.content && merged === outStep.content) continue;
        outputBuf[outputBuf.length - 1] = {
          ...last,
          content: merged,
          timestamp: outStep.timestamp || last.timestamp,
        };
      } else {
        outputBuf.push(outStep);
      }
      continue;
    }
    flushThinking();
    flushSystem();
    flushOutput();
    items.push({ kind: type, ...step });
  }
  flushThinking();
  flushSystem();
  flushOutput();
  // 重绘修正 → 按 tool_use_id / 相邻关系合并 call+result（Tutti upsert 思路）
  return mergeToolCallResultPairs(dedupeAssistantItems(redrawThinkingOutputPairs(stripLeakedAssistantsWhenThinking(dedupeAssistantItems(
    collapseAdjacentThinkingGroups(pruneMixedAssistantBubbles(mergeDelegationPairs(items))),
  )))));
}

/**
 * 合并 tool_call + tool_result → tool_group
 * 优先按 tool_use_id upsert（中间可夹其它事件）；否则回退相邻配对
 */
function mergeToolCallResultPairs(items = []) {
  const out = [];
  // id → 在 out 中的下标
  const pendingById = new Map();

  const pushGroup = (g) => {
    out.push(g);
    if (g.tool_use_id && g.resultContent == null) {
      pendingById.set(g.tool_use_id, out.length - 1);
    }
  };

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'tool_call') {
      const next = items[i + 1];
      if (next?.kind === 'tool_result'
        && (!it.tool_use_id || !next.tool_use_id || it.tool_use_id === next.tool_use_id)) {
        pushGroup({
          kind: 'tool_group',
          tool_name: it.tool_name || next.tool_name,
          callContent: it.content,
          resultContent: next.content,
          is_error: !!next.is_error,
          timestamp: next.timestamp || it.timestamp,
          tool_use_id: it.tool_use_id || next.tool_use_id || null,
        });
        if (it.tool_use_id) pendingById.delete(it.tool_use_id);
        i += 1;
        continue;
      }
      pushGroup({
        kind: 'tool_group',
        tool_name: it.tool_name,
        callContent: it.content,
        resultContent: null,
        is_error: false,
        pending: true,
        timestamp: it.timestamp,
        tool_use_id: it.tool_use_id || null,
      });
      continue;
    }
    if (it.kind === 'tool_result') {
      const id = it.tool_use_id || null;
      const idx = id != null ? pendingById.get(id) : undefined;
      if (idx != null && out[idx]?.kind === 'tool_group') {
        out[idx] = {
          ...out[idx],
          tool_name: out[idx].tool_name || it.tool_name,
          resultContent: it.content,
          is_error: !!it.is_error,
          pending: false,
          timestamp: it.timestamp || out[idx].timestamp,
        };
        pendingById.delete(id);
        continue;
      }
      // 无匹配 call：与前一条未完成的 tool_group 相邻合并
      const prev = out[out.length - 1];
      if (prev?.kind === 'tool_group' && prev.resultContent == null) {
        out[out.length - 1] = {
          ...prev,
          tool_name: prev.tool_name || it.tool_name,
          resultContent: it.content,
          is_error: !!it.is_error,
          pending: false,
          timestamp: it.timestamp || prev.timestamp,
        };
        if (prev.tool_use_id) pendingById.delete(prev.tool_use_id);
        continue;
      }
      pushGroup({
        kind: 'tool_group',
        tool_name: it.tool_name,
        callContent: null,
        resultContent: it.content,
        is_error: !!it.is_error,
        timestamp: it.timestamp,
        tool_use_id: id,
      });
      continue;
    }
    out.push(it);
  }
  return out;
}

/** 合并内容相同/互为前缀的连续推理卡片 */
function collapseAdjacentThinkingGroups(items) {
  const out = [];
  for (const item of items) {
    if (item.kind !== 'thinking_group') {
      out.push(item);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.kind === 'thinking_group') {
      const pa = normalizeLoose(prev.content);
      const pb = normalizeLoose(item.content);
      if (!pa || !pb || pa === pb || pa.startsWith(pb) || pb.startsWith(pa)) {
        const longer = String(prev.content || '').length >= String(item.content || '').length
          ? prev.content
          : item.content;
        prev.content = longer;
        prev.count = (prev.count || 1) + (item.count || 1);
        prev.timestamp = item.timestamp || prev.timestamp;
        continue;
      }
    }
    out.push({ ...item });
  }
  return out;
}

/** 去重内容相同/互为前缀的 assistant 气泡
 * 仅合并时间线上「紧邻」的两条；中间夹了工具/派发等则不合并，
 * 避免把工具后的终稿合并进工具前的气泡，打乱回复与调用顺序。
 */
function dedupeAssistantItems(items) {
  const out = [];
  for (const item of items) {
    if (item.kind !== 'assistant') {
      out.push(item);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev?.kind === 'assistant') {
      const pa = normalizeLoose(prev.content);
      const pb = normalizeLoose(item.content);
      if (pa && pb && (pa === pb || pa.startsWith(pb) || pb.startsWith(pa))) {
        const prevLeaked = looksLikeLeakedReasoning(prev.content);
        const nextLeaked = looksLikeLeakedReasoning(item.content);
        let keep = prev;
        if (prevLeaked && !nextLeaked) keep = item;
        else if (!prevLeaked && nextLeaked) keep = prev;
        else if (String(item.content || '').length > String(prev.content || '').length) keep = item;
        out[out.length - 1] = { ...keep };
        continue;
      }
    }
    out.push({ ...item });
  }
  return out;
}

/** 去掉 thinking 卡片前后误生成的混合 assistant 气泡 */
function pruneMixedAssistantBubbles(items) {
  const hasThinking = items.some(x => x.kind === 'thinking_group');
  return items.filter((item, i, arr) => {
    if (item.kind !== 'assistant' || !looksLikeLeakedReasoning(item.content)) return true;
    if (hasThinking) return false;
    const hasThinkingAfter = arr.slice(i + 1).some(x => x.kind === 'thinking_group');
    const hasCleanAfter = arr.slice(i + 1).some(x =>
      x.kind === 'assistant' && x.content?.trim() && !looksLikeLeakedReasoning(x.content),
    );
    return !(hasThinkingAfter || hasCleanAfter);
  });
}

/** 嵌套步骤分组（派发卡片内复用） */
function groupNestedSteps(steps = []) {
  const groups = [];
  let thinkingBuf = [];
  let systemBuf = [];

  const flushThinking = () => {
    if (!thinkingBuf.length) return;
    groups.push({
      kind: 'thinking_group',
      content: mergeStreamingContents(thinkingBuf),
      count: thinkingBuf.length,
    });
    thinkingBuf = [];
  };

  const flushSystem = () => {
    if (!systemBuf.length) return;
    if (systemBuf.length === 1) {
      groups.push({ kind: 'system_event', ...systemBuf[0] });
    } else {
      groups.push({ kind: 'system_event_group', events: [...systemBuf] });
    }
    systemBuf = [];
  };

  for (const step of steps) {
    const type = step.stepType || 'output';
    if (type === 'thinking') {
      thinkingBuf.push(step);
      continue;
    }
    if (type === 'system_event') {
      flushThinking();
      systemBuf.push(step);
      continue;
    }
    flushThinking();
    flushSystem();
    groups.push({ kind: type, ...step });
  }
  flushThinking();
  flushSystem();
  return mergeToolCallResultPairs(groups);
}

/** 将轮次 steps 与 result 摘要合并为时间线条目 */
function buildTurnTimeline(turn, delegations = {}, agentNames = {}, t) {
  // 仅对已终态轮次补闭合；进行中的轮次保留 pending，避免把「等待结果」画成失败
  const rawSteps = Array.isArray(turn.steps) ? turn.steps : [];
  const terminal = ['completed', 'failed', 'cancelled'].includes(turn.status);
  const steps = terminal && hasOpenToolCalls(rawSteps)
    ? closePendingToolSteps(
      rawSteps,
      turn.status === 'cancelled'
        ? (t?.('debug.agent.aborted') || '已中止')
        : (t?.('debug.agent.noResult') || '未收到结果'),
    )
    : rawSteps;
  let items = buildTimeline(turn.user, steps, delegations, agentNames, turn.images);
  const hasCleanAssistant = items.some(
    it => it.kind === 'assistant' && it.content?.trim() && !looksLikeLeakedReasoning(it.content),
  );
  if (hasCleanAssistant) return items;
  const summary = normalizeDisplayText(
    turn.result?.summary || turn.result?.output || '',
  );
  if (!summary || looksLikeLeakedReasoning(summary)) return items;
  items.push({
    kind: 'assistant',
    content: summary,
    timestamp: turn.timestamp,
  });
  return items;
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 若整段/尾部是 Claude result 信封 JSON，只保留可读正文（防泄漏兜底） */
function stripResultEnvelopeLeak(raw) {
  const s = String(raw || '');
  if (!s.includes('"type"') || !s.includes('"result"')) return s;
  // 整段就是信封
  const tryParse = (chunk) => {
    try {
      const obj = JSON.parse(chunk);
      if (obj?.type !== 'result') return null;
      if (typeof obj.result === 'string') return obj.result;
      if (obj.result && typeof obj.result === 'object') {
        return String(obj.result.text || obj.result.content || obj.result.message || '').trim() || null;
      }
      return String(obj.message || '').trim() || '';
    } catch {
      return null;
    }
  };
  const whole = tryParse(s.trim());
  if (whole != null) return whole;
  // 正文后面粘了整包 result JSON
  const idx = s.search(/\n?\s*\{\s*"type"\s*:\s*"result"/);
  if (idx >= 0) {
    const head = s.slice(0, idx).trim();
    const tail = tryParse(s.slice(idx).trim());
    if (tail != null) return head || tail;
  }
  return s;
}

/** 展示前还原字面量 \\n / \\t，避免单行截断 */
function normalizeDisplayText(text) {
  if (text == null) return '';
  return stripResultEnvelopeLeak(
    String(text)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .trim(),
  );
}

/** 判断是否为有效文件路径（过滤误写入的正文摘要） */
function isLikelyFilePath(raw) {
  const p = String(raw || '').trim();
  if (!p || p.length > 512) return false;
  if (/\\n|\\r|[\n\r]/.test(p)) return false;
  if (/^#+\s|^---|\*\*/.test(p)) return false;
  if (/^(true|false|null)$/i.test(p)) return false;
  return /[/\\]/.test(p) || /\.[a-z0-9]{1,8}$/i.test(p) || /^[\w.-]+$/.test(p);
}

/** 任务完成卡片：展示摘要与修改文件，支持长内容滚动 */
function TaskCompletionCard({ result, task }) {
  const { t } = useLang();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const summary = normalizeDisplayText(result?.summary || result?.output || '');

  const rawFiles = result?.files || [];
  const files = rawFiles.filter(f => isLikelyFilePath(f.path || f.file_path));

  // 曾被误识别为「文件」的正文，回退到摘要区展示
  const misfiledText = rawFiles
    .map(f => f.path || f.file_path)
    .filter(p => p && !isLikelyFilePath(p))
    .map(normalizeDisplayText)
    .join('\n\n');

  const displaySummary = summary || misfiledText;
  const duration = task?.completed_at && task?.started_at
    ? ((task.completed_at - task.started_at) / 1000).toFixed(1)
    : null;

  return (
    <div className="rounded-xl border border-green-200 dark:border-green-800/50 bg-green-50/60 dark:bg-green-900/15 px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium text-green-700 dark:text-green-400 mb-2">
        <span>✅</span> {t('debug.log.taskDone')}
        {duration && (
          <span className="text-xs font-normal text-green-600/80 dark:text-green-500/80">
            · {duration}s
          </span>
        )}
      </div>

      {displaySummary && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setSummaryOpen(v => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-green-800/90 dark:text-green-300/90 mb-1"
          >
            <span>📋</span> {t('debug.log.summary')}
            <span className="text-zinc-400">{summaryOpen ? '▾' : '▸'}</span>
          </button>
          {summaryOpen && (
            <div className="text-xs leading-relaxed max-h-96 overflow-y-auto rounded-lg tb-soft-field px-3 py-2 text-zinc-700 dark:text-zinc-300">
              <MarkdownContent content={displaySummary} />
            </div>
          )}
        </div>
      )}

      {files.length > 0 && (
        <div className="space-y-1 mt-2">
          <div className="text-xs font-medium text-green-800/80 dark:text-green-400/80 mb-1">{t('debug.log.changedFiles')}</div>
          {files.map((f, idx) => {
            const fp = f.path || f.file_path;
            return (
              <div key={idx} className="flex items-start gap-2 text-xs font-mono text-zinc-600 dark:text-zinc-400">
                <span className="shrink-0">{f.operation === 'created' ? '📝' : '✏️'}</span>
                <PathLink
                  path={fp}
                  title={t('debug.preview.clickHint')}
                  className="bg-transparent px-0"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** 格式化重试等待时间（过短则按最低 2s 展示，避免误导性 612ms） */
function formatRetryDelay(ms) {
  const n = Number(ms);
  const displayMs = Number.isFinite(n) && n > 0 ? Math.max(n, 2000) : 0;
  if (!displayMs) return '≥2s';
  if (displayMs < 1000) return `${Math.round(displayMs)}ms`;
  return `${(displayMs / 1000).toFixed(1)}s`;
}

/** 系统事件文案（api_retry 等） */
function describeSystemEvent(ev, t) {
  if (!ev) return { title: t('debug.log.systemEvent'), detail: '' };
  if (ev.system_subtype === 'api_retry') {
    const attempt = ev.attempt ?? '?';
    const max = ev.max_retries ?? '?';
    const status = ev.error_status != null ? String(ev.error_status) : '—';
    return {
      title: t('debug.log.apiRetry', { attempt, max }),
      detail: t('debug.log.apiRetryDetail', { status, delay: formatRetryDelay(ev.retry_delay_ms) }),
      badge: status,
    };
  }
  if (ev.system_subtype === 'claude_connector_warning') {
    return {
      title: t('debug.log.connectorHint'),
      detail: ev.content || ev.message || '',
      badge: null,
    };
  }
  if (ev.system_subtype === 'process_started') {
    return {
      title: t('debug.log.started'),
      detail: ev.message || ev.content || t('debug.log.waitStream'),
      badge: null,
    };
  }
  const msg = ev.message || ev.content || '';
  return { title: t('debug.log.system'), detail: msg, badge: null };
}

/** 供「正在执行」条展示的一行系统细节 */
function formatSystemStatusLine(ev, t) {
  if (!ev) return '';
  const info = describeSystemEvent(ev, t);
  if (ev.system_subtype === 'api_retry') {
    return [info.title, info.detail].filter(Boolean).join(' · ');
  }
  return (info.detail || info.title || '').trim();
}

/** 单条系统事件：扁平行，不再套内层 panel */
function SystemEventRow({ ev, index }) {
  const { t } = useLang();
  const info = describeSystemEvent(ev, t);
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="w-4 shrink-0 text-[10px] font-medium tabular-nums text-zinc-400 pt-0.5 text-right">
        {index ?? ev.attempt ?? '·'}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-snug">
          <span className="font-medium text-zinc-700 dark:text-zinc-200">{info.title}</span>
          {info.detail ? (
            <span className="text-zinc-500 dark:text-zinc-400"> · {info.detail}</span>
          ) : null}
        </p>
      </div>
      {info.badge && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-mono shrink-0">
          {info.badge}
        </span>
      )}
    </div>
  );
}

/** 系统事件卡片（单条） */
function SystemEventCard({ step }) {
  const { t } = useLang();
  const info = describeSystemEvent(step, t);
  const meta = getStepMeta(t).system_event;

  return (
    <div className="flex justify-start w-full">
      <div className={`max-w-[88%] w-full rounded-xl ${meta.accent} overflow-hidden`}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/40 dark:border-white/[0.06]">
          {meta.icon ? <span>{meta.icon}</span> : null}
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{info.title}</span>
          <span className="ml-auto text-[10px] text-zinc-400">{formatTime(step.timestamp)}</span>
        </div>
        <div className="px-3 py-1.5">
          <SystemEventRow ev={step} />
        </div>
      </div>
    </div>
  );
}

/** 合并连续系统事件（如多次 API 重试） */
function SystemEventGroupCard({ item }) {
  const { t } = useLang();
  const events = item.events || [];
  const retries = events.filter(e => e.system_subtype === 'api_retry');
  const title = retries.length
    ? t('debug.log.apiRetryGroup', { n: retries.length })
    : t('debug.log.systemGroup', { n: events.length });
  // 默认折叠，避免系统事件刷屏抢视线
  const [open, setOpen] = useState(false);
  const meta = getStepMeta(t).system_event;
  // 折叠时用首条细节作一行预览
  const preview = !open && events[0]
    ? formatSystemStatusLine(events[0], t)
    : '';

  return (
    <div className="flex justify-start w-full">
      <div className={`max-w-[88%] w-full rounded-xl ${meta.accent} overflow-hidden`}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-zinc-500/[0.04] dark:hover:bg-white/[0.04] transition-colors"
        >
          {meta.icon ? <span>{meta.icon}</span> : null}
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300 shrink-0">{title}</span>
          {!open && preview && (
            <span className="flex-1 min-w-0 text-[10px] text-zinc-400 truncate" title={preview}>
              {preview}
            </span>
          )}
          {open && retries.length > 0 && (
            <span className="text-[10px] text-zinc-400">
              {t('debug.log.retryHint')}
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-400 shrink-0">{formatTime(item.timestamp)}</span>
          <span className="text-xs text-zinc-400 shrink-0">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="px-3 pb-2 border-t border-zinc-200/50 dark:border-white/[0.06] divide-y divide-zinc-200/40 dark:divide-white/[0.05]">
            {events.map((ev, idx) => (
              <SystemEventRow key={idx} ev={ev} index={ev.attempt ?? idx + 1} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Claude / Codex 常见工具 → 友好名（对齐 Tutti TOOL_NAME_TRANSLATION_KEYS） */
function getToolFriendlyLabels(t) {
  return {
    bash: t('debug.log.tool.bash'),
    shell: t('debug.log.tool.bash'),
    read: t('debug.log.tool.read'),
    write: t('debug.log.tool.write'),
    edit: t('debug.log.tool.edit'),
    multiedit: t('debug.log.tool.multiedit'),
    grep: t('debug.log.tool.grep'),
    glob: t('debug.log.tool.glob'),
    ls: t('debug.log.tool.ls'),
    askuserquestion: t('debug.log.tool.ask'),
    todowrite: t('debug.log.tool.todoWrite'),
    todoread: t('debug.log.tool.todoRead'),
    skill: 'Skill',
    task: t('debug.log.tool.task'),
    webfetch: t('debug.log.tool.webfetch'),
    websearch: t('debug.log.tool.websearch'),
    notebookedit: t('debug.log.tool.notebook'),
  };
}

/** 从参数 JSON 推断常见 Claude Code 内置工具名（DB 旧数据缺 tool_name 时兜底） */
function inferBuiltinToolName(content) {
  try {
    const obj = JSON.parse(String(content || ''));
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.command === 'string') return 'Bash';
    if (obj.file_path && obj.old_string != null) return 'Edit';
    if (obj.file_path && obj.content != null) return 'Write';
    if (obj.file_path && obj.command == null) return 'Read';
    if (obj.pattern != null && obj.path != null) return 'Grep';
    if (obj.pattern != null || obj.glob != null) return 'Glob';
  } catch { /* ignore */ }
  return null;
}

function friendlyToolLabel(name, t) {
  const key = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return getToolFriendlyLabels(t)[key] || null;
}

/** 折叠头一行摘要：命令 / 路径 / 描述 */
function toolCompactSummary(callContent, t) {
  const text = String(callContent || '').trim();
  const noArgs = t('debug.log.noArgs');
  if (!text || text === '(无参数)' || text === noArgs) return '';
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return '';
    if (typeof obj.command === 'string') {
      return obj.command.replace(/\s+/g, ' ').trim().slice(0, 72);
    }
    if (typeof obj.file_path === 'string') return obj.file_path.slice(0, 72);
    if (typeof obj.path === 'string' && obj.pattern) {
      return `${obj.pattern} @ ${obj.path}`.slice(0, 72);
    }
    if (typeof obj.pattern === 'string') return obj.pattern.slice(0, 72);
    if (typeof obj.glob === 'string') return obj.glob.slice(0, 72);
    if (typeof obj.description === 'string') return obj.description.slice(0, 72);
    if (typeof obj.skill === 'string') return obj.skill.slice(0, 72);
  } catch { /* ignore */ }
  return text.replace(/\s+/g, ' ').slice(0, 72);
}

/** 解析 MCP / 派发工具名，便于展示 */
function parseToolName(raw, content, t) {
  if (!raw) {
    const inferred = inferBuiltinToolName(content);
    const label = friendlyToolLabel(inferred, t) || inferred;
    return { display: label || t('debug.log.unknownTool'), server: null, rawName: inferred };
  }
  if (raw.startsWith('dispatch:')) {
    return { display: raw.slice('dispatch:'.length), server: t('debug.log.dispatchServer'), rawName: raw };
  }
  if (raw.startsWith('mcp__')) {
    const parts = raw.split('__').filter(Boolean);
    if (parts.length >= 3) {
      const tool = parts[parts.length - 1];
      return {
        display: friendlyToolLabel(tool, t) || tool,
        server: parts.slice(1, -1).join(' · '),
        rawName: tool,
      };
    }
  }
  return {
    display: friendlyToolLabel(raw, t) || raw,
    server: null,
    rawName: raw,
  };
}

/** 格式化工具参数（JSON 美化） */
function formatToolPayload(content) {
  const text = String(content || '').trim();
  if (!text) return { formatted: '{}', empty: true, isJson: true };
  try {
    const obj = JSON.parse(text);
    const empty = obj != null && typeof obj === 'object' && !Array.isArray(obj)
      && Object.keys(obj).length === 0;
    return {
      formatted: JSON.stringify(obj, null, 2),
      empty,
      isJson: true,
    };
  } catch {
    return { formatted: text, empty: !text, isJson: false };
  }
}

/** 按工具类型选图标（对齐 Tutti AgentToolCallHeader 分流） */
function toolRowIcon(rawName, { err, pending } = {}) {
  if (err) return '⚠️';
  const key = String(rawName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (pending) {
    if (/read|notebook/.test(key)) return '📄';
    if (/write|edit|multiedit|patch/.test(key)) return '📝';
    return '🔨';
  }
  if (/bash|shell/.test(key)) return '⚙';
  if (/read|ls|list/.test(key)) return '📄';
  if (/write/.test(key)) return '📝';
  if (/edit|multiedit|patch/.test(key)) return '✏';
  if (/grep|search/.test(key)) return '🔍';
  if (/glob|find/.test(key)) return '🗂';
  if (/web/.test(key)) return '🌐';
  if (/todo/.test(key)) return '☑';
  if (/askuser|question/.test(key)) return '❓';
  if (/skill/.test(key)) return '✨';
  if (/task|agent/.test(key)) return '↗';
  return '🛠';
}

/**
 * 单次工具行（Tutti AgentToolCallCard 风格）：
 * 图标 + 友好名 + 状态 + 一行摘要；默认折叠，展开才见参数/输出
 */
function ToolGroupCard({ step, live = false }) {
  const { t } = useLang();
  const callContent = step.callContent ?? (step.kind === 'tool_call' ? step.content : null);
  const resultContent = step.resultContent ?? (step.kind === 'tool_result' ? step.content : null);
  const { display, server, rawName } = parseToolName(step.tool_name, callContent, t);
  const payload = formatToolPayload(callContent || '');
  const summary = toolCompactSummary(callContent, t);
  const err = !!step.is_error;
  // 已有结果（含失败）绝不再显示「执行中」；仅任务仍在跑且尚无结果时才 pending
  const pending = !err && !!step.pending && resultContent == null && live;
  const incomplete = !err && !!step.pending && resultContent == null && !live;
  const hasDetail = (!payload.empty && callContent != null)
    || (resultContent != null && String(resultContent).trim());
  const [open, setOpen] = useState(false);

  let status = '';
  if (err) status = t('debug.log.failed');
  else if (pending) status = t('debug.log.running');
  else if (incomplete) status = t('debug.log.incomplete');
  else if (resultContent != null) status = t('debug.log.completed');

  const icon = toolRowIcon(rawName || step.tool_name, { err, pending });

  return (
    <div className="flex justify-start w-full max-w-[92%]">
      <div className="w-full min-w-0">
        <button
          type="button"
          disabled={!hasDetail}
          onClick={() => hasDetail && setOpen(v => !v)}
          className={`w-full flex items-center gap-1.5 px-1 py-1 text-left rounded-md transition-colors ${
            hasDetail ? 'hover:bg-zinc-100/80 dark:hover:bg-zinc-800/50 cursor-pointer' : 'cursor-default'
          }`}
          aria-expanded={hasDetail ? open : undefined}
        >
          {/* 工具行整体缩小一档，避免压过正文回复 */}
          <span className={`shrink-0 text-[11px] leading-none w-3.5 text-center ${pending ? 'animate-pulse' : ''}`}>
            {icon}
          </span>
          <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-300 shrink-0">
            {display}
          </span>
          {server && (
            <span className="text-[9px] text-zinc-400 dark:text-zinc-500 truncate max-w-[100px] shrink-0">
              {server}
            </span>
          )}
          {status && (
            <span className={`text-[10px] shrink-0 ${
              err ? 'text-red-500 dark:text-red-400'
                : pending ? 'text-zinc-400 dark:text-zinc-500'
                  : 'text-zinc-400 dark:text-zinc-500'
            }`}>
              {status}{pending ? '…' : ''}
            </span>
          )}
          {summary && (
            <span
              className="min-w-0 flex-1 truncate text-[10px] text-zinc-400 dark:text-zinc-500 font-mono"
              title={summary}
            >
              {summary}
            </span>
          )}
          {!summary && <span className="flex-1" />}
          {hasDetail && (
            <span className="text-zinc-400 dark:text-zinc-500 text-[10px] shrink-0">
              {open ? '▾' : '▸'}
            </span>
          )}
        </button>

        {open && hasDetail && (
          <div className="ml-5 mt-0.5 mb-1 space-y-1 border-l border-zinc-200 dark:border-zinc-700 pl-2.5">
            {callContent != null && !payload.empty && (
              <pre className="text-[10px] leading-relaxed font-mono text-zinc-500 dark:text-zinc-400 whitespace-pre-wrap break-all max-h-36 overflow-y-auto tb-soft-field rounded px-2 py-1.5">
                {payload.formatted}
              </pre>
            )}
            {resultContent != null && String(resultContent).trim() && (
              <pre className={`text-[10px] leading-relaxed font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto rounded px-2 py-1.5 ${
                err
                  ? 'text-red-700 dark:text-red-300 bg-red-50/80 dark:bg-red-950/25'
                  : 'text-zinc-500 dark:text-zinc-400 tb-soft-field'
              }`}>
                {String(resultContent)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCard({ step, live = false }) {
  const { t } = useLang();
  if (step.kind === 'tool_group' || step.kind === 'tool_call' || step.kind === 'tool_result') {
    return <ToolGroupCard step={step} live={live} />;
  }
  if (step.kind === 'system_event') {
    return <SystemEventCard step={step} />;
  }

  const stepMeta = getStepMeta(t);
  const meta = stepMeta[step.kind] || stepMeta.output;
  // 思考过程默认折叠，避免刷屏
  const collapsible = step.kind === 'thinking' || (step.content || '').length > 280;
  const [open, setOpen] = useState(step.kind !== 'thinking');

  return (
    <div className="flex justify-start">
      <div className={`max-w-[88%] w-full rounded-xl ${meta.accent}`}>
        <button
          type="button"
          onClick={() => collapsible && setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
        >
          {meta.icon ? <span>{meta.icon}</span> : null}
          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{meta.label}</span>
          {step.tool_name && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 font-mono">
              {step.tool_name}
            </span>
          )}
          {!open && step.kind === 'thinking' && step.content && (
            <span className="flex-1 min-w-0 text-[10px] text-zinc-400 truncate">
              {String(step.content).replace(/\s+/g, ' ').slice(0, 60)}…
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-400 shrink-0">{formatTime(step.timestamp)}</span>
          {collapsible && <span className="text-xs text-zinc-400 shrink-0">{open ? '▾' : '▸'}</span>}
        </button>
        {open && (
          step.kind === 'terminal' || step.kind === 'code_edit' ? (
            <pre className={`px-3 pb-3 text-xs whitespace-pre-wrap break-words font-mono leading-relaxed max-h-72 overflow-y-auto ${
              step.kind === 'terminal' ? 'text-zinc-100' : 'text-zinc-700 dark:text-zinc-300'
            }`}>
              {step.content}
            </pre>
          ) : (
            <div className="px-3 pb-3 text-xs max-h-72 overflow-y-auto text-zinc-700 dark:text-zinc-300">
              <MarkdownContent content={normalizeDisplayText(step.content)} />
            </div>
          )
        )}
      </div>
    </div>
  );
}

/** 执行中可展示的过程文本(推理 / 回复 / 工具 / 系统状态) */
function extractLiveProgress(timeline = [], t) {
  let thinking = '';
  let output = '';
  let systemStatus = '';
  const tools = [];
  for (const it of timeline) {
    if (it.kind === 'thinking_group' && it.content?.trim()) {
      thinking = String(it.content);
    } else if (it.kind === 'assistant' && it.content?.trim() && !looksLikeLeakedReasoning(it.content)) {
      output = String(it.content);
    } else if (it.kind === 'system_event') {
      const line = formatSystemStatusLine(it, t);
      if (line) systemStatus = line;
    } else if (it.kind === 'system_event_group' && it.events?.length) {
      const line = formatSystemStatusLine(it.events[it.events.length - 1], t);
      if (line) systemStatus = line;
    } else if (it.kind === 'tool_group' || it.kind === 'tool_call' || it.kind === 'tool_result'
      || it.kind === 'terminal' || it.kind === 'code_edit') {
      const name = it.tool_name || it.kind;
      if (name && !tools.includes(name)) tools.push(name);
      if (tools.length > 6) tools.shift();
    } else if (it.kind === 'delegation' && it.nestedSteps?.length) {
      const nested = extractLiveProgress(
        (it.nestedSteps || []).map((ns) => ({
          kind: ns.kind === 'thinking_group' ? 'thinking_group'
            : ns.kind === 'assistant' ? 'assistant'
              : ns.kind === 'system_event' ? 'system_event'
                : ns.kind === 'system_event_group' ? 'system_event_group'
                  : (ns.kind || ns.stepType || 'output'),
          content: ns.content,
          tool_name: ns.tool_name,
          system_subtype: ns.system_subtype,
          message: ns.message,
          events: ns.events,
          attempt: ns.attempt,
          max_retries: ns.max_retries,
          error_status: ns.error_status,
          retry_delay_ms: ns.retry_delay_ms,
        })),
        t,
      );
      if (nested.thinking) thinking = nested.thinking;
      if (nested.output) output = nested.output;
      if (nested.systemStatus) systemStatus = nested.systemStatus;
      nested.tools.forEach((t) => {
        if (!tools.includes(t)) tools.push(t);
      });
    }
  }
  return { thinking, output, tools, systemStatus };
}

/** 取文本尾部若干行,便于过程预览 */
function tailLines(text, maxLines = 8, maxChars = 900) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const sliced = raw.length > maxChars ? `…${raw.slice(-maxChars)}` : raw;
  const lines = sliced.split(/\n/);
  if (lines.length <= maxLines) return sliced;
  return `…\n${lines.slice(-maxLines).join('\n')}`;
}

/** 折叠预览取最后一行（流式时看最新进度）；过长则截尾部 */
function lastThinkingPreview(text, maxChars = 140) {
  const lines = String(text || '')
    .split(/\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const last = lines.length
    ? lines[lines.length - 1]
    : String(text || '').replace(/\s+/g, ' ').trim();
  if (!last) return '';
  if (last.length <= maxChars) return last;
  return `…${last.slice(-maxChars)}`;
}

/** 推理卡：默认折叠；live 时用动效提示仍在执行 */
function ThinkingGroupCard({ item, live = false }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const raw = normalizeDisplayText(item.content);
  const preview = lastThinkingPreview(raw);
  const meta = getStepMeta(t).thinking;

  return (
    <div className="flex justify-start items-start">
      <div
        className={[
          'max-w-[80%] min-w-0 rounded-xl overflow-hidden',
          meta.accent,
          live ? 'ring-1 ring-zinc-300/50 dark:ring-white/10' : '',
        ].filter(Boolean).join(' ')}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left relative"
        >
          {/* 执行中底部扫光（reduce 时由 CSS 关掉 animation） */}
          {live && (
            <>
              <style>{'@keyframes tb-think-scan{0%{transform:translateX(-120%)}100%{transform:translateX(420%)}}@media (prefers-reduced-motion:reduce){.tb-think-scan{animation:none!important}}'}</style>
              <span
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] overflow-hidden"
                aria-hidden
              >
                <span
                  className="tb-think-scan block h-full w-1/3 bg-zinc-400/70 dark:bg-zinc-500/80"
                  style={{ animation: 'tb-think-scan 1.35s var(--ease-in-out, ease-in-out) infinite' }}
                />
              </span>
            </>
          )}
          {live ? (
            <span className="inline-block h-2.5 w-2.5 rounded-sm bg-zinc-400 dark:bg-zinc-500 shrink-0" />
          ) : (
            meta.icon ? <span className="text-sm leading-none">{meta.icon}</span> : null
          )}
          <span className={`text-xs font-medium shrink-0 ${live ? 'text-zinc-600 dark:text-zinc-300 animate-pulse' : 'text-zinc-600 dark:text-zinc-300'}`}>
            {live ? t('debug.log.thinkingLive') : t('debug.log.thinking')}
          </span>
          {/* 预览截断与光标分离，保证尾部呼吸光标始终可见 */}
          {!open && (preview || live) && (
            <span className="flex-1 min-w-0 flex items-center gap-0.5 overflow-hidden">
              <span
                className="min-w-0 flex-1 truncate text-[10px] text-zinc-400"
                title={preview || undefined}
              >
                {preview || t('debug.log.thinkingHint')}
              </span>
              {live && (
                <span className="inline-block animate-pulse text-zinc-400 shrink-0 leading-none">▊</span>
              )}
            </span>
          )}
          {live && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0 animate-pulse">
              {t('debug.log.live')}
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-400 shrink-0">{formatTime(item.timestamp)}</span>
          <span className="text-xs text-zinc-400 shrink-0">{open ? '▾' : '▸'}</span>
        </button>
        {open && (
          <div className="px-3 pb-2.5 text-xs max-h-80 overflow-y-auto text-zinc-700 dark:text-zinc-300 border-t border-zinc-200/50 dark:border-white/[0.06]">
            <StreamMarkdownContent
              content={raw}
              live={live}
              preferPlainWhileLive
            />
            {live && (
              <span className="inline-block animate-pulse text-zinc-400 ml-0.5">▊</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 执行中底部过程面板:仅在尚无可见输出/推理气泡时展示 */
function LiveProgressPanel({ agentName, timeline }) {
  const { t } = useLang();
  const { thinking, output, tools, systemStatus } = useMemo(
    () => extractLiveProgress(timeline, t),
    [timeline, t],
  );
  // 上方已有回复/推理气泡时隐藏整卡，避免与流式正文重复
  const hasVisibleBubble = useMemo(
    () => timeline.some((it) => (
      ((it.kind === 'assistant' || it.kind === 'thinking_group')
        && String(it.content || '').trim())
      || (it.kind === 'tool_group' || it.kind === 'tool_call'
        || it.kind === 'tool_result' || it.kind === 'terminal' || it.kind === 'code_edit')
    )),
    [timeline],
  );
  if (hasVisibleBubble || output || thinking) return null;

  const statusDetail = systemStatus || t('debug.log.waitStream');

  return (
    <div className="rounded-xl tb-soft-bubble overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-600 dark:text-zinc-300">
        <span className="inline-block h-3 w-16 rounded bg-zinc-200/80 dark:bg-zinc-700 animate-pulse shrink-0" />
        <span className="font-medium shrink-0">{agentName || 'Agent'} {t('debug.log.executing')}</span>
        {tools.length > 0 && (
          <span className="text-[10px] text-zinc-400 truncate max-w-[40%]" title={tools.join(', ')}>
            {tools.slice(-3).join(' · ')}
          </span>
        )}
      </div>
      <p className="px-3 pb-2.5 text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
        {statusDetail}
      </p>
    </div>
  );
}

/** 编排派发卡片：主 Agent 视角展示子 Agent 工作形态 */
function DelegationCard({ item }) {
  const { t } = useLang();
  const [open, setOpen] = useState(true);
  const isStart = item.phase === 'start';
  const isComplete = item.phase === 'complete';
  const resultContent = item.completeContent || (isComplete && !isStart ? item.content : '');
  const running = (isStart || isComplete) && item.delStatus === 'running';
  const failed = isComplete && (item.status === 'failed' || item.delStatus === 'failed');

  const statusLabel = running
    ? t('debug.log.executing')
    : failed
      ? t('debug.log.failed')
      : isComplete
        ? t('debug.log.completed')
        : '';

  return (
    <div className="flex justify-start">
      <div className={`max-w-[92%] w-full rounded-xl border ${
        failed
          ? 'border-red-200 bg-red-50/50 dark:border-red-800/40 dark:bg-red-900/10'
          : 'border-indigo-200 bg-indigo-50/50 dark:border-indigo-800/40 dark:bg-indigo-900/10'
      }`}>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        >
          <span>{isComplete ? (failed ? '❌' : '✅') : '📤'}</span>
          <span className="text-xs font-semibold text-indigo-800 dark:text-indigo-300">
            {isComplete && !running ? t('debug.log.dispatchDone') : t('debug.log.dispatch')} → {item.agentName || item.agentId}
          </span>
          {statusLabel && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${
              running
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
                : failed
                  ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                  : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
            }`}>
              {statusLabel}
            </span>
          )}
          <span className="ml-auto text-[10px] text-zinc-400">{formatTime(item.timestamp)}</span>
          <span className="text-xs text-zinc-400">{open ? '▾' : '▸'}</span>
        </button>

        {open && (
          <div className="px-3 pb-3 space-y-2">
            {/* 派发任务描述（start 阶段保留的 prompt） */}
            {item.content && (isStart || item.completeContent) && (
              <div className="text-xs border-l-2 border-indigo-300 dark:border-indigo-700 pl-2 text-zinc-600 dark:text-zinc-400">
                <span className="text-zinc-400">{t('debug.log.taskColon')}</span>
                <MarkdownContent content={normalizeDisplayText(item.content)} />
              </div>
            )}

            {/* 子 Agent 执行过程（推理/工具/输出） */}
            {item.nestedSteps?.length > 0 && (
              <div className="rounded-lg tb-soft-bubble p-2 space-y-2">
                <p className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">
                  {t('debug.log.agentOutput', { name: item.agentName || item.agentId || 'Agent' })}
                </p>
                {groupNestedSteps(item.nestedSteps).map((ns, idx, arr) => {
                  if (ns.kind === 'thinking_group') {
                    const lastThink = [...arr].reverse().find((x) => x.kind === 'thinking_group');
                    return (
                      <ThinkingGroupCard
                        key={idx}
                        item={ns}
                        live={running && ns === lastThink}
                      />
                    );
                  }
                  // 启动/Hook 或执行中：不单独出 system 卡
                  if (ns.kind === 'system_event_group' || ns.kind === 'system_event') {
                    if (running || isEphemeralSystemItem(ns)) return null;
                    return ns.kind === 'system_event_group'
                      ? <SystemEventGroupCard key={idx} item={ns} />
                      : <SystemEventCard key={idx} step={ns} />;
                  }
                  if (ns.kind === 'output' || ns.stepType === 'output') {
                    return (
                      <div key={idx} className="text-xs text-zinc-700 dark:text-zinc-300">
                        <StreamMarkdownContent
                          content={normalizeDisplayText(ns.content)}
                          live={running}
                        />
                      </div>
                    );
                  }
                  return <ToolCard key={idx} step={{ kind: ns.kind || ns.stepType, ...ns }} />;
                })}
              </div>
            )}

            {isComplete && resultContent && (
              <div className="text-xs max-h-48 overflow-y-auto text-zinc-700 dark:text-zinc-300">
                <span className="text-zinc-400 block mb-1">{t('debug.log.resultSummary')}</span>
                <MarkdownContent content={normalizeDisplayText(resultContent)} />
              </div>
            )}

            {isStart && !item.nestedSteps?.length && running && (
              <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
                <span className="inline-block h-2.5 w-10 rounded bg-blue-200 dark:bg-blue-800 animate-pulse" />
                {t('debug.log.waitAgent', { name: item.agentName || item.agentId || 'Agent' })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ExecutionLog({
  conversationTurns = [],
  userPrompt,
  userImages = [],
  steps,
  status,
  result,
  task,
  agentName,
  delegations = {},
  agentNames = {},
  onPreviewImage,
}) {
  const { t } = useLang();
  const endRef = useRef(null);
  // 本轮用户消息变化时重新钉住底部（刚发送应看到最新输出）
  const pinKey = `${conversationTurns.length}|${String(userPrompt || '')}|${(userImages || []).length}`;

  /** 合并历史轮次 + 当前轮次；currentStart 之后才是本轮（呼吸光标只挂这里） */
  const { timeline, currentStart } = useMemo(() => {
    const items = [];
    for (const turn of conversationTurns) {
      items.push(...buildTurnTimeline(turn, turn.delegations || {}, agentNames, t));
    }
    const currentStart = items.length;
    items.push(...buildTimeline(userPrompt, steps, delegations, agentNames, userImages));
    // 当前轮已完成但 steps 无干净回复时，用 result 摘要补全（跳过泄漏推理）
    if (status === 'completed' && result) {
      const currentSlice = items.slice(currentStart);
      const hasClean = currentSlice.some(
        (it) => it.kind === 'assistant' && it.content?.trim() && !looksLikeLeakedReasoning(it.content),
      );
      if (!hasClean) {
        const summary = normalizeDisplayText(result.summary || result.output || '');
        if (summary && !looksLikeLeakedReasoning(summary)) {
          items.push({ kind: 'assistant', content: summary, timestamp: task?.completed_at });
        }
      }
    }
    return { timeline: items, currentStart };
  }, [conversationTurns, userPrompt, userImages, steps, delegations, agentNames, status, result, task?.completed_at, t]);

  // 仅在本轮内找「正在流式」的气泡，避免光标粘在历史回复上
  const lastAssistantIdx = useMemo(() => {
    let idx = -1;
    for (let i = currentStart; i < timeline.length; i++) {
      if (timeline[i].kind === 'assistant') idx = i;
    }
    return idx;
  }, [timeline, currentStart]);
  const lastThinkingIdx = useMemo(() => {
    let idx = -1;
    for (let i = currentStart; i < timeline.length; i++) {
      if (timeline[i].kind === 'thinking_group') idx = i;
    }
    return idx;
  }, [timeline, currentStart]);
  // 本轮尚无任何过程气泡时，用空回复承载呼吸光标
  const waitingForReply = useMemo(() => {
    if (status !== 'running') return false;
    if (!String(userPrompt || '').trim() && !(userImages || []).length) return false;
    for (let i = currentStart; i < timeline.length; i++) {
      const k = timeline[i].kind;
      if (k === 'assistant' || k === 'thinking_group' || k === 'tool_group'
        || k === 'tool_call' || k === 'tool_result'
        || k === 'terminal' || k === 'code_edit' || k === 'delegation') {
        return false;
      }
    }
    return true;
  }, [status, userPrompt, userImages, timeline, currentStart]);

  usePinBottomScroll(
    endRef,
    timeline,
    // 新一轮用户输入时重新贴底；上滑阅读时不打断
    { forcePinKey: pinKey },
  );

  const empty = !conversationTurns.length && !userPrompt && !(userImages || []).length && timeline.length === 0;

  if (empty) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center text-zinc-400 dark:text-zinc-500 select-none">
        <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400 mb-1">
          {agentName || t('debug.modeAgent')}
        </p>
        <p className="text-sm max-w-sm">
          {agentName
            ? t('debug.log.emptyNamed', { name: agentName })
            : t('debug.log.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-4">
      {timeline.map((item, i) => {
        if (item.kind === 'user') {
          const imgs = Array.isArray(item.images) ? item.images : [];
          const text = normalizeDisplayText(item.content);
          return (
            <div key={`u-${i}`} className="flex justify-end">
              <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm bg-blue-600 text-white">
                {imgs.length > 0 && (
                  <div className={`flex flex-wrap gap-1.5 ${text ? 'mb-2' : ''}`}>
                    {imgs.map((src, j) => {
                      const fileName = fileMarkerName(src);
                      if (fileName) {
                        return (
                          <span key={j} title={fileName} className="text-[11px] px-1.5 py-1 rounded bg-white/15 max-w-[12rem] truncate">
                            {fileName}
                          </span>
                        );
                      }
                      if (!src || src === '__b64_omitted__') {
                        return (
                          <span key={j} className="text-[11px] opacity-80 px-1.5 py-1 rounded bg-white/15">
                            {t('debug.imageNotRestored')}
                          </span>
                        );
                      }
                      return (
                        <ResolvedDebugImage
                          key={j}
                          src={src}
                          alt={`attach-${j}`}
                          className="h-20 max-w-[12rem] object-cover rounded-lg cursor-zoom-in border border-white/20"
                          onClick={onPreviewImage}
                        />
                      );
                    })}
                  </div>
                )}
                {text ? (
                  <MarkdownContent content={text} theme="inverted" />
                ) : null}
              </div>
            </div>
          );
        }

        if (item.kind === 'assistant') {
          const isLive = status === 'running' && i >= currentStart && i === lastAssistantIdx;
          // 紧挨在推理卡后：头像已在推理行，回复只缩进对齐
          return (
            <div key={`a-${i}`} className="flex justify-start">
              <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm tb-soft-bubble text-zinc-900 dark:text-zinc-100">
                <StreamMarkdownContent
                  content={normalizeDisplayText(item.content)}
                  live={isLive}
                />
                {isLive && (
                  <span className="inline-block animate-pulse text-blue-500 dark:text-blue-400 ml-0.5">▊</span>
                )}
              </div>
            </div>
          );
        }

        if (item.kind === 'delegation') {
          return <DelegationCard key={`d-${i}`} item={item} />;
        }

        if (item.kind === 'thinking_group') {
          const isLive = status === 'running' && i >= currentStart && i === lastThinkingIdx;
          return <ThinkingGroupCard key={`tg-${i}`} item={item} live={isLive} />;
        }

        // 启动/Hook 类已在 buildTimeline 过滤；执行中其余 system 也只进底部状态条
        if (item.kind === 'system_event_group') {
          if (status === 'running' || isEphemeralSystemItem(item)) return null;
          return <SystemEventGroupCard key={`sg-${i}`} item={item} />;
        }

        if (item.kind === 'system_event') {
          if (status === 'running' || isEphemeralSystemItem(item)) return null;
          return <SystemEventCard key={`se-${i}`} step={item} />;
        }

        return (
          <ToolCard
            key={`t-${i}`}
            step={item}
            live={status === 'running' && i >= currentStart}
          />
        );
      })}

      {/* 本轮尚无回复/推理气泡：新开一条空回复放呼吸光标，不粘在历史消息上 */}
      {waitingForReply && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-xl px-4 py-2.5 text-sm tb-soft-bubble border-blue-200/60 dark:border-blue-800/40 text-zinc-900 dark:text-zinc-100 min-h-[2.25rem] flex items-center gap-2">
            <span className="inline-block h-2.5 w-14 rounded bg-blue-200 dark:bg-blue-800 animate-pulse shrink-0" />
            <span className="text-xs text-blue-600/90 dark:text-blue-300/90 animate-pulse">{t('debug.log.executing')}</span>
            <span className="inline-block animate-pulse text-blue-500 dark:text-blue-400">▊</span>
          </div>
        </div>
      )}

      {/* 已有本轮气泡或占位光标时不再叠「正在执行」卡 */}
      {status === 'running' && !waitingForReply && (
        <LiveProgressPanel
          agentName={agentName}
          timeline={timeline.slice(currentStart)}
        />
      )}

      {status === 'failed' && task?.error && (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">
          {task.error}
        </div>
      )}

      {result && status === 'completed' && (
        <TaskCompletionCard result={result} task={task} />
      )}

      <div ref={endRef} />
    </div>
  );
}
