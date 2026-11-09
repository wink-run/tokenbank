'use strict';
// vision-assist.js — 场景路由识图增强：抽图 / 描述解析 / 替换为文本（网关预处理用）

const crypto = require('crypto');

const DEFAULT_ASSIST_PROMPT =
  '你是视觉助手：为下游纯文本模型提炼「与用户问题相关」的图像信息。\n'
  + '要求：\n'
  + '1. 紧扣用户问题选取图中要点，禁止无目的的看图说话或流水账罗列无关细节。\n'
  + '2. 用户问什么就优先写什么；问题未涉及的内容可省略。若问题含糊，再给一句场景总览。\n'
  + '3. 用简洁中文；多图时严格按下列格式逐条输出，不要前后缀：\n'
  + '[图片1]：...\n[图片2]：...\n'
  + '4. 不要猜测图中未见的信息；看不清就写「看不清」。';

const DEFAULT_ASSIST_MAX_TOKENS = 1024;

/** 图片指纹 → 描述缓存（避免历史消息里同一张图被反复识图） */
const _DESC_CACHE = new Map(); // key -> desc
const _DESC_CACHE_MAX = 200;

function cacheGet(fp) {
  if (!fp || !_DESC_CACHE.has(fp)) return null;
  const desc = _DESC_CACHE.get(fp);
  // LRU：再写入一次挪到末尾
  _DESC_CACHE.delete(fp);
  _DESC_CACHE.set(fp, desc);
  return desc;
}

function cacheSet(fp, desc) {
  if (!fp || !desc || !String(desc).trim()) return;
  if (_DESC_CACHE.has(fp)) _DESC_CACHE.delete(fp);
  _DESC_CACHE.set(fp, String(desc).trim());
  while (_DESC_CACHE.size > _DESC_CACHE_MAX) {
    _DESC_CACHE.delete(_DESC_CACHE.keys().next().value);
  }
}

function cacheClear() { _DESC_CACHE.clear(); }

/** 缓存键：有用户问题时按「图+问题」区分，避免同图不同问复用无关描述 */
function cacheKey(fp, userQuestion = '') {
  if (!fp) return '';
  const q = String(userQuestion || '').trim().slice(0, 400);
  if (!q) return fp;
  const qh = crypto.createHash('sha256').update(q).digest('hex').slice(0, 12);
  return `${fp}:${qh}`;
}

/** 图片内容指纹（同图跨轮复用描述） */
function imageFingerprint(img) {
  if (!img) return '';
  const h = crypto.createHash('sha256');
  if (img.url) h.update(String(img.url));
  else if (img.source) {
    h.update(String(img.source.type || ''));
    h.update(String(img.source.media_type || ''));
    h.update(String(img.source.data || img.source.url || ''));
  } else return '';
  return h.digest('hex').slice(0, 40);
}

/** 深拷贝请求体（失败时退回原引用） */
function cloneBody(body) {
  if (!body || typeof body !== 'object') return body;
  try { return JSON.parse(JSON.stringify(body)); } catch { return body; }
}

/** content 是否含 OpenAI image_url / Anthropic image / Responses input_image */
function contentHasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some((p) => {
    if (!p || typeof p !== 'object') return false;
    if (p.type === 'image_url' || p.type === 'image' || p.type === 'input_image') return true;
    // Read 等工具把图放在 tool_result 里面，不在消息顶层
    if (p.type === 'tool_result') return contentHasImage(p.content);
    return false;
  });
}

/** 请求体是否含图片（messages / input） */
function bodyHasImages(body) {
  if (!body || typeof body !== 'object') return false;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) if (contentHasImage(m && m.content)) return true;
  }
  if (Array.isArray(body.input)) {
    for (const m of body.input) {
      if (typeof m === 'string') continue;
      if (contentHasImage(m && m.content)) return true;
      if (m && (m.type === 'input_image' || m.type === 'image_url' || m.type === 'image')) return true;
    }
  }
  return false;
}

/**
 * 从 content 收集图片，转为助手可用的统一结构。
 * @returns {{ kind: 'oai'|'anth', url?: string, source?: object }[]}
 */
function collectImagesFromContent(content) {
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'image_url') {
      const url = p.image_url?.url || (typeof p.image_url === 'string' ? p.image_url : '');
      if (url) out.push({ kind: 'oai', url });
    } else if (p.type === 'input_image') {
      // Codex Responses：content 内嵌 input_image（image_url 可为 string 或 {url}）
      const url = typeof p.image_url === 'string' ? p.image_url : (p.image_url?.url || '');
      if (url) out.push({ kind: 'oai', url });
    } else if (p.type === 'image' && p.source) {
      out.push({ kind: 'anth', source: p.source });
    } else if (p.type === 'tool_result') {
      out.push(...collectImagesFromContent(p.content));
    }
  }
  return out;
}

/** Anthropic image.source → data URL / http URL（供 OpenAI 助手） */
function anthSourceToUrl(source) {
  if (!source || typeof source !== 'object') return null;
  if (source.type === 'base64' && source.data) {
    const mt = source.media_type || 'image/jpeg';
    return `data:${mt};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return source.url;
  return null;
}

/** 从完整 body 收集全部图片（顺序即图片序号） */
function collectImagesFromBody(body) {
  return collectImagesWithMeta(body).map((x) => x.img);
}

/**
 * 收集图片并标注是否在「最后一条 user」中。
 * 只对最后一条 user 里的未缓存图调用识图；历史图走缓存或占位，避免重复识别。
 * @returns {{ img: object, inLastUser: boolean, fp: string }[]}
 */
function collectImagesWithMeta(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;

  if (Array.isArray(body.messages)) {
    let lastUser = -1;
    for (let i = 0; i < body.messages.length; i++) {
      if (body.messages[i]?.role === 'user') lastUser = i;
    }
    body.messages.forEach((m, mi) => {
      for (const img of collectImagesFromContent(m && m.content)) {
        out.push({ img, inLastUser: mi === lastUser, fp: imageFingerprint(img) });
      }
    });
  }

  if (Array.isArray(body.input)) {
    let lastUser = -1;
    for (let i = 0; i < body.input.length; i++) {
      const m = body.input[i];
      if (m && typeof m === 'object' && m.role === 'user') lastUser = i;
    }
    if (lastUser < 0 && body.input.length) lastUser = body.input.length - 1;
    body.input.forEach((m, mi) => {
      if (typeof m === 'string') return;
      if (m && m.content != null) {
        for (const img of collectImagesFromContent(m.content)) {
          out.push({ img, inLastUser: mi === lastUser, fp: imageFingerprint(img) });
        }
      } else if (m && m.type === 'input_image' && m.image_url) {
        const url = typeof m.image_url === 'string' ? m.image_url : m.image_url?.url;
        if (url) {
          const img = { kind: 'oai', url };
          out.push({ img, inLastUser: mi === lastUser, fp: imageFingerprint(img) });
        }
      }
    });
  }
  return out;
}

/**
 * 规划每张图的描述来源：cache | api（仅最新 user 未缓存）| history（历史未缓存占位）。
 * 最新 user 的缓存按「图+问题」命中；历史图按纯图指纹复用。
 * @returns {{ descs: (string|null)[], needApiIdx: number[], cacheHits: number, historySkip: number }}
 */
function planImageDescriptions(items, userQuestion = '') {
  const descs = [];
  const needApiIdx = [];
  let cacheHits = 0;
  let historySkip = 0;
  for (let i = 0; i < items.length; i++) {
    const fp = items[i].fp;
    // 最新一轮：必须匹配当前问题；历史：用纯图指纹（上次识图结果）
    const hit = items[i].inLastUser
      ? cacheGet(cacheKey(fp, userQuestion))
      : cacheGet(fp);
    if (hit) {
      descs[i] = hit;
      cacheHits += 1;
    } else if (items[i].inLastUser) {
      descs[i] = null;
      needApiIdx.push(i);
    } else {
      descs[i] = '（历史图片，本次未重新识别；请结合上文已有描述理解）';
      historySkip += 1;
    }
  }
  return { descs, needApiIdx, cacheHits, historySkip };
}

/** 从 content 抽纯文本（含 Responses input_text） */
function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => {
    if (typeof p === 'string') return p;
    if (!p || typeof p !== 'object') return '';
    if (typeof p.text === 'string') return p.text;
    return '';
  }).filter(Boolean).join('\n');
}

/** 提取最后一条用户消息的文字（作为识图参考问题） */
function extractUserQuestion(body) {
  if (!body || typeof body !== 'object') return '';
  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m && m.role === 'user') return textFromContent(m.content).trim();
    }
  }
  if (Array.isArray(body.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const m = body.input[i];
      if (typeof m === 'string') return m.trim();
      if (m && typeof m === 'object' && (m.role === 'user' || !m.role)) {
        const t = textFromContent(m.content).trim();
        if (t) return t;
      }
    }
  }
  if (typeof body.prompt === 'string') return body.prompt.trim();
  if (typeof body.input === 'string') return body.input.trim();
  return '';
}

/**
 * 组装识图助手提示：默认/自定义 prompt + 用户问题（有则附加）。
 */
function buildAssistPrompt(basePrompt, userQuestion) {
  const base = (basePrompt && String(basePrompt).trim()) || DEFAULT_ASSIST_PROMPT;
  const q = String(userQuestion || '').trim().slice(0, 1500);
  if (!q) return base;
  return `${base}\n\n【用户问题】\n${q}\n\n请对照上述问题，只描述图片中对回答该问题有用的信息。`;
}

/**
 * 解析助手返回的多图描述。
 * 单图：整段文本即描述；多图：按 [图片N]： 分段；无标记时整段复用到每张。
 */
function parseAssistDescriptions(text, count) {
  const n = Math.max(0, Number(count) || 0);
  if (n <= 0) return [];
  const raw = String(text || '').trim();
  if (!raw) return Array.from({ length: n }, () => '');
  if (n === 1) return [raw];

  const re = /\[图片\s*(\d+)\s*\]\s*[:：]\s*/g;
  const hits = [];
  let m;
  while ((m = re.exec(raw))) {
    hits.push({ idx: Number(m[1]), start: m.index, end: m.index + m[0].length });
  }
  if (!hits.length) {
    return Array.from({ length: n }, () => raw);
  }
  const byNum = new Map();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const stop = i + 1 < hits.length ? hits[i + 1].start : raw.length;
    byNum.set(h.idx, raw.slice(h.end, stop).trim());
  }
  const out = Array.from({ length: n }, (_, i) => byNum.get(i + 1) || '');
  const filled = out.filter((d) => d && d.trim());
  const fallback = filled[0] || raw;
  return out.map((d) => (d && d.trim() ? d : fallback));
}

function replaceImagesInContent(content, descriptions, state) {
  if (!Array.isArray(content)) return content;
  const next = [];
  for (const p of content) {
    if (p && p.type === 'tool_result' && Array.isArray(p.content)) {
      next.push({ ...p, content: replaceImagesInContent(p.content, descriptions, state) });
      continue;
    }
    if (p && (p.type === 'image_url' || p.type === 'image' || p.type === 'input_image')) {
      const n = state.i + 1;
      const desc = descriptions[state.i];
      state.i += 1;
      const text = (desc && String(desc).trim())
        ? `【图片${n}的文字描述】\n${String(desc).trim()}`
        : `【图片${n}】（视觉助手未给出描述）`;
      // Responses 用 input_text；Chat / Anthropic 用 text
      next.push({ type: p.type === 'input_image' ? 'input_text' : 'text', text });
    } else {
      next.push(p);
    }
  }
  return next;
}

function replaceImagesInBody(body, descriptions) {
  const state = { i: 0 };
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (m && Array.isArray(m.content)) m.content = replaceImagesInContent(m.content, descriptions, state);
    }
  }
  if (Array.isArray(body.input)) {
    const nextInput = [];
    for (const m of body.input) {
      if (typeof m === 'string') { nextInput.push(m); continue; }
      if (m && Array.isArray(m.content)) {
        nextInput.push({ ...m, content: replaceImagesInContent(m.content, descriptions, state) });
      } else if (m && m.type === 'input_image') {
        const n = state.i + 1;
        const desc = descriptions[state.i];
        state.i += 1;
        const text = (desc && String(desc).trim())
          ? `【图片${n}的文字描述】\n${String(desc).trim()}`
          : `【图片${n}】（视觉助手未给出描述）`;
        nextInput.push({ type: 'input_text', text });
      } else {
        nextInput.push(m);
      }
    }
    body.input = nextInput;
  }
  return body;
}

function prependVisionAssistNotice(body, imageCount) {
  const notice = `（系统说明：原请求含 ${imageCount} 张图片，已由视觉助手转为下方「图片N的文字描述」。`
    + `你无法直接查看图片，请仅根据这些文字描述回答用户。）\n`;
  const injectIntoContent = (content) => {
    if (typeof content === 'string') return notice + content;
    if (!Array.isArray(content)) return [{ type: 'text', text: notice }];
    // Responses content 用 input_text；Chat 用 text
    const useInput = content.some((p) => p && (p.type === 'input_text' || p.type === 'input_image'));
    return [{ type: useInput ? 'input_text' : 'text', text: notice }, ...content];
  };
  if (Array.isArray(body.messages) && body.messages.length) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i];
      if (m && m.role === 'user') {
        m.content = injectIntoContent(m.content);
        return body;
      }
    }
  }
  if (Array.isArray(body.input) && body.input.length) {
    // 优先注入最后一条 user message 的 content；否则在头部插说明
    for (let i = body.input.length - 1; i >= 0; i--) {
      const m = body.input[i];
      if (m && typeof m === 'object' && m.role === 'user' && m.content != null) {
        m.content = injectIntoContent(m.content);
        return body;
      }
    }
    body.input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: notice }] }, ...body.input];
  }
  return body;
}

function stripImagesInBody(body) {
  const imgs = collectImagesFromBody(body);
  const descs = imgs.map(() => '');
  return replaceImagesInBody(cloneBody(body), descs);
}

function buildAssistUserContent(images, prompt, format, userQuestion) {
  const text = buildAssistPrompt(prompt, userQuestion);
  if (format === 'anthropic') {
    const blocks = [{ type: 'text', text }];
    for (const img of images) {
      if (img.kind === 'anth' && img.source) {
        blocks.push({ type: 'image', source: img.source });
      } else if (img.url || (img.kind === 'oai' && img.url)) {
        const url = img.url;
        const mm = /^data:([^;]+);base64,(.+)$/s.exec(url);
        if (mm) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
        } else if (url) {
          blocks.push({ type: 'image', source: { type: 'url', url } });
        }
      }
    }
    return blocks;
  }
  const parts = [{ type: 'text', text }];
  for (const img of images) {
    let url = img.url || null;
    if (!url && img.kind === 'anth') url = anthSourceToUrl(img.source);
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  return parts;
}

function extractAssistResponseText(j, isAnthropic) {
  if (!j || typeof j !== 'object') return '';
  const stripThink = (s) => String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^\s*<\/?think>\s*/gi, '')
    .trim();
  if (isAnthropic) {
    const blocks = Array.isArray(j.content) ? j.content : [];
    const texts = blocks.filter((b) => b && b.type === 'text' && b.text).map((b) => b.text);
    if (texts.length) return stripThink(texts.join(''));
    const thinks = blocks.map((b) => (b && (b.thinking || b.text)) || '').filter(Boolean);
    return stripThink(thinks.join('\n'));
  }
  const msg = j.choices?.[0]?.message || {};
  let c = msg.content;
  if (Array.isArray(c)) {
    c = c.map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      return p.text || p.content || '';
    }).join('');
  }
  if (typeof c === 'string' && c.trim()) return stripThink(c);
  for (const key of ['reasoning_content', 'reasoning']) {
    const v = msg[key];
    if (typeof v === 'string' && v.trim()) return stripThink(v);
  }
  return '';
}

module.exports = {
  DEFAULT_ASSIST_PROMPT,
  DEFAULT_ASSIST_MAX_TOKENS,
  cloneBody,
  bodyHasImages,
  contentHasImage,
  collectImagesFromContent,
  collectImagesFromBody,
  collectImagesWithMeta,
  planImageDescriptions,
  imageFingerprint,
  cacheGet,
  cacheSet,
  cacheClear,
  cacheKey,
  extractUserQuestion,
  buildAssistPrompt,
  anthSourceToUrl,
  parseAssistDescriptions,
  replaceImagesInContent,
  replaceImagesInBody,
  stripImagesInBody,
  buildAssistUserContent,
  extractAssistResponseText,
  prependVisionAssistNotice,
};
