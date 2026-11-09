// 闲置 Skill 大模型分析：分批处理；结合画像 / Trace 习惯 / 质量 / 命中综合判断

/** 每批送给模型的条数 */
import { resolveGatewayBase } from './gateway-base';
const BATCH_SIZE = 30;
/** 模型最多分析条数；超出部分仅用启发式逐条上屏 */
const MAX_AI_ITEMS = 300;
/** 批内逐条上屏间隔（毫秒），形成「分析一个出来一个」 */
const REVEAL_GAP_MS = 40;
const MAX_DESC = 96;
const PORTRAIT_KEY = 'tokenbank.resources.recommend.portrait';

/** 让出主线程，避免连续同步/大响应解析卡死界面 */
function yieldToUi() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/** 解析本地网关 base（与 resource-purpose 一致） */

/** 读取个性化推荐缓存的用户画像（若有） */
function loadPortraitFromStorage() {
  try {
    const r = JSON.parse(localStorage.getItem(PORTRAIT_KEY) || 'null');
    if (r && typeof r === 'object' && (r.persona || (r.goals && r.goals.length))) return r;
  } catch { /* ignore */ }
  return null;
}

/** 是否已有可用画像（清理页据此提示去分析画像） */
export function hasStoredPortrait() {
  return !!loadPortraitFromStorage();
}

/**
 * 汇总分析上下文：画像 + Trace 习惯命中 + 会话侧写
 * @param {number} days
 */
async function loadAnalysisContext(days) {
  const portrait = loadPortraitFromStorage();
  const needsRaw = (portrait?.needsByType?.skill || portrait?.needs || []).slice(0, 6);
  const needs = needsRaw.map((n) => (typeof n === 'string' ? n : (n?.text || ''))).filter(Boolean);

  let habits = [];
  let habitTotal = 0;
  try {
    const usage = await window.electronAPI?.localStats?.skillUsage?.({
      days: Math.max(Number(days) || 60, 90),
      limit: 40,
    });
    habitTotal = Number(usage?.total) || 0;
    habits = (usage?.items || []).slice(0, 15).map((u) => ({
      name: String(u.name || u.key || '').trim(),
      calls: Number(u.calls) || 0,
      agents: Number(u.agents) || 0,
    })).filter((h) => h.name);
  } catch { /* 无用量统计 */ }

  const digest = portrait?.digest || {};
  return {
    hasPortrait: !!(portrait?.persona || (portrait?.goals || []).length),
    persona: String(portrait?.persona || '').trim().slice(0, 160),
    traits: (portrait?.traits || []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 4),
    goals: (portrait?.goals || []).map((g) => String(g || '').trim()).filter(Boolean).slice(0, 4),
    needs,
    habits,
    habitTotal,
    agents: (digest.agents || []).slice(0, 8).map((a) => (
      typeof a === 'string' ? a : (a?.name || a?.id || '')
    )).filter(Boolean),
    projects: (digest.projects || []).slice(0, 6).map((p) => (
      typeof p === 'string' ? p : `${p?.name || ''}${p?.count ? `×${p.count}` : ''}`
    )).filter(Boolean),
  };
}

function compactItem(item, ctx = {}) {
  const desc = String(item.description || '').replace(/\s+/g, ' ').trim();
  const purposes = Array.isArray(item.purposes) ? item.purposes.filter(Boolean).slice(0, 3) : [];
  const habitHit = (ctx.habits || []).find((h) => {
    const a = h.name.toLowerCase();
    const b = String(item.name || '').toLowerCase();
    return a === b || a.includes(b) || b.includes(a);
  });
  // 质量粗分：有说明、有投射、有用途标签更高
  let quality = 0;
  if (desc.length >= 24) quality += 2;
  else if (desc.length >= 8) quality += 1;
  if ((item.projectionCount || 0) > 0) quality += 1;
  if (purposes.length) quality += 1;

  return {
    id: item.id,
    name: item.name,
    desc: desc.slice(0, MAX_DESC),
    descLen: desc.length,
    idleDays: item.idleDays || 0,
    never: !item.lastActivityAt,
    projections: item.projectionCount || 0,
    purposes,
    quality, // 0~4
    habitCalls: habitHit ? habitHit.calls : 0,
  };
}

/** 从模型文本里抠 JSON 数组/对象 */
function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* continue */ }
  const arr = raw.match(/\[[\s\S]*\]/);
  if (arr) {
    try { return JSON.parse(arr[0]); } catch { /* continue */ }
  }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    try { return JSON.parse(obj[0]); } catch { /* continue */ }
  }
  return null;
}

function contextBrief(ctx, zh) {
  if (!ctx) return zh ? '（无额外上下文）' : '(no extra context)';
  const lines = [];
  if (ctx.hasPortrait) {
    if (zh) {
      lines.push(`画像侧写: ${ctx.persona || '（有画像但侧写为空）'}`);
      if (ctx.traits.length) lines.push(`特质: ${ctx.traits.join('；')}`);
      if (ctx.goals.length) lines.push(`能力域/目标: ${ctx.goals.join('；')}`);
      if (ctx.needs.length) lines.push(`Skill 需求: ${ctx.needs.join('；')}`);
    } else {
      lines.push(`Persona: ${ctx.persona || '(empty)'}`);
      if (ctx.traits.length) lines.push(`Traits: ${ctx.traits.join('; ')}`);
      if (ctx.goals.length) lines.push(`Goals: ${ctx.goals.join('; ')}`);
      if (ctx.needs.length) lines.push(`Skill needs: ${ctx.needs.join('; ')}`);
    }
  } else {
    lines.push(zh ? '画像: 暂无（勿臆造用户身份）' : 'Portrait: none (do not invent)');
  }
  if (ctx.habits.length) {
    const top = ctx.habits.slice(0, 12).map((h) => `${h.name}×${h.calls}`).join(', ');
    lines.push(zh
      ? `近期命中习惯(Skill 调用榜, 共 ${ctx.habitTotal} 次): ${top}`
      : `Recent skill hits (total ${ctx.habitTotal}): ${top}`);
  } else {
    lines.push(zh ? '近期命中习惯: 暂无调用榜' : 'Recent skill hits: none');
  }
  if (ctx.agents.length) {
    lines.push(zh ? `常用 Agent: ${ctx.agents.join(', ')}` : `Agents: ${ctx.agents.join(', ')}`);
  }
  if (ctx.projects.length) {
    lines.push(zh ? `Trace 项目侧写: ${ctx.projects.join(', ')}` : `Projects: ${ctx.projects.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * 无模型时的多维兜底（不再用「同系列整批」套话）。
 * @returns {Record<string, { recommend: boolean, reason: string, source: string }>}
 */
export function heuristicIdleRecommendations(items, days = 60, ctx = null) {
  const out = {};
  const list = Array.isArray(items) ? items : [];
  const needText = (ctx?.needs || []).join(' ').toLowerCase();
  const goalText = (ctx?.goals || []).join(' ').toLowerCase();
  const habitNames = (ctx?.habits || []).map((h) => h.name.toLowerCase());

  for (const it of list) {
    const never = !it.lastActivityAt;
    const name = String(it.name || '').toLowerCase();
    const desc = String(it.description || '').toLowerCase();
    const blob = `${name} ${desc}`;
    const relatedNeed = needText && needText.split(/\s+/).some((w) => w.length > 1 && blob.includes(w));
    const relatedGoal = goalText && goalText.split(/\s+/).some((w) => w.length > 1 && blob.includes(w));
    const relatedHabit = habitNames.some((h) => h && (h.includes(name) || name.includes(h) || blob.includes(h)));
    const lowQuality = String(it.description || '').trim().length < 8 && !(it.projectionCount > 0);

    if (never && (relatedNeed || relatedGoal || relatedHabit)) {
      out[it.id] = {
        recommend: false,
        reason: relatedHabit
          ? '虽未调用，但贴近近期命中习惯/画像方向，建议保留'
          : '虽未调用，但与画像目标或 Skill 需求相关，建议保留',
        source: 'heuristic',
      };
    } else if (never && lowQuality) {
      out[it.id] = {
        recommend: true,
        reason: '从未命中、说明薄弱且与画像/习惯无关，可清理',
        source: 'heuristic',
      };
    } else if (never) {
      out[it.id] = {
        recommend: true,
        reason: '从未命中，且与当前画像目标、近期习惯无明显关联，可清理',
        source: 'heuristic',
      };
    } else if ((it.idleDays || 0) >= days) {
      out[it.id] = {
        recommend: false,
        reason: `已闲置 ${it.idleDays} 天但仍有历史命中，是否删除请结合习惯自行判断`,
        source: 'heuristic',
      };
    } else {
      out[it.id] = {
        recommend: false,
        reason: '闲置未达阈值，建议保留',
        source: 'heuristic',
      };
    }
  }
  return out;
}

/** 优先把「从未调用」送给模型，其余靠后 */
function prioritizeForAi(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => {
    const an = a.lastActivityAt ? 1 : 0;
    const bn = b.lastActivityAt ? 1 : 0;
    if (an !== bn) return an - bn;
    return (b.idleDays || 0) - (a.idleDays || 0);
  });
  return list;
}

/** 拒绝模型抄启发式套话时的标记 */
function looksLikeTemplateReason(reason) {
  const s = String(reason || '');
  return /同系列|整批清理|共\s*\d+\s*个均从未调用|均从未调用/.test(s);
}

async function analyzeBatch(base, batch, days, lang, signal, ctx) {
  if (signal?.aborted) throw new Error('aborted');
  const zh = lang !== 'en';
  const payload = batch.map((it) => compactItem(it, ctx));
  const brief = contextBrief(ctx, zh);
  const prompt = zh
    ? [
      '你是 Token Bank 的 Skill 清理顾问。候选均为「闲置」(近 N 天会话未调用)，但闲置≠必删。',
      `闲置阈值 N=${days} 天。请综合多维证据，逐条判断是否推荐删除，并给一句具体中文理由。`,
      '',
      '## 用户上下文',
      brief,
      '',
      '## 判断维度（须综合，禁止只看 never）',
      '1. 使用习惯：对照近期 Skill 调用榜与工作流；配套/常用链路 → 保留；与习惯脱节且从未命中 → 可删',
      '2. Skill 最佳实践：单一职责、说明清晰、可组合复用 → 倾向保留；职责重叠、说明空洞、一次性/过时玩具 → 可删',
      '3. 画像契合：与 persona/goals/needs 相关 → 倾向保留；完全无关 → 可删',
      '4. 质量信号：desc 空/过短、quality 低、无投射 → 倾向删；有实质说明或已投射 → 谨慎',
      '5. 系列冗余可提，但须逐条写差异化理由，禁止「同系列共 N 个均从未调用，建议整批清理」套话',
      '',
      '## 输出要求',
      '- 理由 ≤ 40 字，点出具体依据（习惯/最佳实践/画像/质量之一）',
      '- 不要编造不存在的替代技能或用户身份',
      '- 必须覆盖输入里每一个 id',
      '- 只输出 JSON 数组，不要 markdown：',
      '[{"id":"...","recommend":true,"reason":"..."}]',
      '',
      `候选字段说明: never=从未调用, quality=0~4质量粗分, habitCalls=名近命中次数, purposes=用途标签, projections=投射数`,
      `候选: ${JSON.stringify(payload)}`,
    ].join('\n')
    : [
      'You are a Token Bank Skill cleanup advisor. Candidates are idle (no session use in N days), but idle ≠ delete.',
      `Threshold N=${days}. Decide per item using multi-signal evidence; one short reason each.`,
      '',
      '## User context',
      brief,
      '',
      '## Dimensions (combine; do NOT decide on never alone)',
      '1. Usage habits (recent skill call ranking / workflow fit)',
      '2. Skill best practices (single responsibility, clear docs, composable vs redundant/toy/stale)',
      '3. Portrait fit (persona/goals/needs)',
      '4. Quality signals (desc/quality/projections)',
      '5. Series redundancy OK, but distinct per-item reasons — ban "all N unused, batch delete"',
      '',
      'Reason ≤ 40 words, cite habits/best-practice/portrait/quality. Cover every id. JSON array only:',
      '[{"id":"...","recommend":true,"reason":"..."}]',
      `Candidates: ${JSON.stringify(payload)}`,
    ].join('\n');

  const res = await window.electronAPI.llm.fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      temperature: 0.3,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (signal?.aborted) throw new Error('aborted');
  if (!res || res.status >= 400) throw new Error(`llm http ${res?.status || '?'}`);
  await yieldToUi();
  const data = JSON.parse(res.body || '{}');
  const text = data?.choices?.[0]?.message?.content || data?.content || '';
  const parsed = extractJson(text);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.recommendations)
      ? parsed.recommendations
      : [];
  const map = {};
  for (const row of rows) {
    if (!row || !row.id) continue;
    const reason = String(row.reason || '').trim().slice(0, 120);
    // 套话当作未命中，走多维启发式
    if (!reason || looksLikeTemplateReason(reason)) continue;
    map[String(row.id)] = {
      recommend: !!row.recommend,
      reason,
      source: 'ai',
    };
  }
  return map;
}

/**
 * 用本地网关大模型分析闲置 Skill（分批 + 进度回调）。
 * @param {object[]} items
 * @param {{
 *   days?: number,
 *   lang?: string,
 *   signal?: AbortSignal,
 *   onProgress?: (p: { done: number, total: number, batch: number, batches: number, phase: string }) => void,
 *   onPartial?: (map: Record<string, object>) => void,
 * }} [options]
 */
export async function analyzeIdleSkillsWithAi(items, options = {}) {
  const list = Array.isArray(items) ? items : [];
  const days = Math.max(1, Number(options.days) || 60);
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onPartial = typeof options.onPartial === 'function' ? options.onPartial : null;

  const ctx = await loadAnalysisContext(days);
  const fallback = heuristicIdleRecommendations(list, days, ctx);
  if (!list.length) return { map: {}, source: 'heuristic', batches: 0, context: ctx };

  const ranked = prioritizeForAi(list);
  const total = ranked.length;
  onProgress?.({ done: 0, total, batch: 0, batches: 0, phase: 'start' });
  await yieldToUi();

  /** 逐条上屏：每出一条就回调，不提前整表灌入 */
  async function revealOne(merged, it, entry, batchNo, batches) {
    merged[it.id] = entry;
    onPartial?.({ ...merged });
    onProgress?.({
      done: Object.keys(merged).length,
      total,
      batch: batchNo,
      batches,
      phase: 'ai',
    });
    await new Promise((r) => setTimeout(r, REVEAL_GAP_MS));
    await yieldToUi();
  }

  if (!window.electronAPI?.llm?.fetch) {
    const merged = {};
    for (const it of ranked) {
      if (signal?.aborted) break;
      await revealOne(merged, it, fallback[it.id], 0, 0);
    }
    return { map: merged, source: 'heuristic', error: 'no llm', batches: 0, context: ctx };
  }
  if (signal?.aborted) {
    return { map: {}, source: 'heuristic', error: 'aborted', batches: 0, context: ctx };
  }

  const aiQueue = ranked.slice(0, MAX_AI_ITEMS);
  const rest = ranked.slice(MAX_AI_ITEMS);
  const batches = Math.ceil(aiQueue.length / BATCH_SIZE) || 0;
  const merged = {};
  let aiHits = 0;
  let lastError = '';

  try {
    const base = await resolveGatewayBase();
    for (let i = 0; i < aiQueue.length; i += BATCH_SIZE) {
      if (signal?.aborted) {
        return { map: merged, source: aiHits > 0 ? 'ai' : 'heuristic', error: 'aborted', batches, context: ctx };
      }
      const batchNo = Math.floor(i / BATCH_SIZE) + 1;
      const batch = aiQueue.slice(i, i + BATCH_SIZE);
      onProgress?.({
        done: Object.keys(merged).length,
        total,
        batch: batchNo,
        batches,
        phase: 'ai',
      });

      let part = {};
      try {
        part = await analyzeBatch(base, batch, days, lang, signal, ctx);
      } catch (e) {
        if (String(e.message || e) === 'aborted') {
          return { map: merged, source: aiHits > 0 ? 'ai' : 'heuristic', error: 'aborted', batches, context: ctx };
        }
        lastError = e.message || String(e);
        part = {};
      }

      for (const it of batch) {
        if (signal?.aborted) {
          return { map: merged, source: aiHits > 0 ? 'ai' : 'heuristic', error: 'aborted', batches, context: ctx };
        }
        const hit = part[it.id];
        if (hit && hit.reason) {
          aiHits += 1;
          await revealOne(merged, it, hit, batchNo, batches);
        } else {
          await revealOne(merged, it, fallback[it.id], batchNo, batches);
        }
      }
    }

    for (const it of rest) {
      if (signal?.aborted) break;
      await revealOne(merged, it, fallback[it.id], batches, batches);
    }

    return {
      map: merged,
      source: aiHits > 0 ? 'ai' : 'heuristic',
      error: lastError || undefined,
      batches,
      aiCovered: aiQueue.length,
      skippedHeuristic: rest.length,
      context: ctx,
    };
  } catch (e) {
    return {
      map: merged,
      source: aiHits > 0 ? 'ai' : 'heuristic',
      error: e.message || String(e),
      batches,
      context: ctx,
    };
  }
}

/** 按推荐优先排序闲置列表 */
export function sortIdleByRecommendation(items, map = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => {
    const ar = map[a.id]?.recommend ? 1 : 0;
    const br = map[b.id]?.recommend ? 1 : 0;
    if (ar !== br) return br - ar;
    return (a.lastActivityAt || 0) - (b.lastActivityAt || 0);
  });
  return list;
}

export const IDLE_AI_BATCH_SIZE = BATCH_SIZE;
export const IDLE_AI_MAX_ITEMS = MAX_AI_ITEMS;
