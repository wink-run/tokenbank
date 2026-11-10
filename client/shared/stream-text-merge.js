// 流式文本片段合并：避免 token 增量 + 完整 assistant 快照重复展示
'use strict';

import {
  dedupeRepeatedText,
  normalizeLoose,
  splitInlineReasoning,
  looksLikeInlineReasoning,
  expandMixedOutputSteps,
  dedupeConsecutiveSteps,
  stripDuplicateThinkingPrefix,
  stripReasoningLeakage,
  looksLikeLeakedReasoning,
  repairThinkingOutputBoundary,
  sanitizeThinkingOutputPairs,
  hasClearReasoningBoundary,
  findUserFacingStart,
  isTruncatedThinking,
  joinThinkingOutput,
} from './inline-reasoning-split.js';

export {
  dedupeRepeatedText,
  splitInlineReasoning,
  looksLikeInlineReasoning,
  expandMixedOutputSteps,
  dedupeConsecutiveSteps,
  normalizeLoose,
  stripDuplicateThinkingPrefix,
  stripReasoningLeakage,
  looksLikeLeakedReasoning,
  repairThinkingOutputBoundary,
  sanitizeThinkingOutputPairs,
  hasClearReasoningBoundary,
  findUserFacingStart,
  isTruncatedThinking,
  joinThinkingOutput,
};

function tightText(s) {
  return String(s).replace(/\s+/g, '').toLowerCase();
}

function lineBreaks(s) {
  return (String(s).match(/\n/g) || []).length;
}

/** 最长公共子串。只用于判断两段是不是同一篇被拆开的正文，长度封顶避免超长思考卡顿。 */
function longestCommonSubstringLen(a, b) {
  let x = a.length > 4000 ? a.slice(0, 4000) : a;
  let y = b.length > 4000 ? b.slice(0, 4000) : b;
  if (x.length > y.length) [x, y] = [y, x];
  let prev = new Array(x.length + 1).fill(0);
  let best = 0;
  for (let j = 0; j < y.length; j++) {
    const cur = new Array(x.length + 1).fill(0);
    const cb = y[j];
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== cb) continue;
      const v = prev[i] + 1;
      cur[i + 1] = v;
      if (v > best) best = v;
    }
    prev = cur;
  }
  return best;
}

/**
 * 同一篇正文的两份拷贝，留下换行更多、能排版的那份。
 * 历史步骤没有 is_snapshot：增量粘成一行，重复字还会被吃掉；文末快照仍是完整 Markdown。
 */
function preferFormattedOverlap(a, b) {
  const ta = tightText(a);
  const tb = tightText(b);
  if (!ta || !tb) return null;
  const ba = lineBreaks(a);
  const bb = lineBreaks(b);

  // 只多了空白和换行，字符没少
  if (tb.includes(ta) && bb >= ba && b.length >= a.length) return b;
  // 快照少了一小段前缀（比如漏进正文的英文思考），但换行明显更多
  if (ta.includes(tb) && bb > ba && ta.length - tb.length <= 80) return b;

  // 增量已经损坏，整段包含对不上，但有一段相同正文，且 b 才是排版稿
  if (bb >= ba + 2 && b.length >= 40 && b.length >= a.length * 0.45) {
    if (longestCommonSubstringLen(ta, tb) >= 24) return b;
  }
  return null;
}

/**
 * @param {string} prev 已有文本
 * @param {string} next 新片段
 * @param {{ isDelta?: boolean, isSnapshot?: boolean }} [opts]
 */
export function mergeStreamText(prev, next, opts = {}) {
  const { isDelta = false, isSnapshot = false } = opts;
  let a = String(prev || '');
  let b = String(next || '');
  if (!b) return a;
  if (!a) return b;
  if (a === b) return a;
  if (b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  if (b.includes(a)) return b;
  if (a.includes(b)) return a;

  const formatted = preferFormattedOverlap(a, b);
  if (formatted != null) return formatted;

  // 快照优先：避免 delta 与完整 assistant 消息简单拼接造成重复
  if (isSnapshot && !isDelta) {
    const looseA = normalizeLoose(a);
    const looseB = normalizeLoose(b);
    if (looseB.includes(looseA)) return b;
    if (looseA.includes(looseB)) return a;
    return b.length >= a.length ? b : a;
  }

  if (isDelta) return dedupeRepeatedText(a + b);
  return dedupeRepeatedText(a + b);
}

/** 折叠步骤列表为单一文本 */
export function foldStreamSteps(steps) {
  if (!steps?.length) return '';
  return steps.reduce(
    (acc, s) => mergeStreamText(acc, s?.content, {
      isDelta: !!s?.is_delta,
      isSnapshot: !!s?.is_snapshot,
    }),
    '',
  );
}
