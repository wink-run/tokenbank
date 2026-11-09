/**
 * 资源用途分类：把零散 tags 聚合到 SkillHub 一级用途（与个性化推荐一致）。
 * 流程：静态别名 → AI 映射缓存 → 未命中则跳过（不展示碎片标签）。
 */
import { resolveGatewayBase } from './gateway-base';

/** 与 PersonalizedRecommend CATEGORY_SLUGS 对齐 */
export const PURPOSE_SLUGS = [
  'dev-programming',
  'data-analysis',
  'content-creation',
  'office-efficiency',
  'design-media',
  'ai-agent',
  'knowledge-management',
  'business-ops',
  'education',
  'professional',
  'it-ops-security',
  'life-service',
];

const PURPOSE_SET = new Set(PURPOSE_SLUGS);

const AI_MAP_KEY = 'tokenbank.resources.purposeAiMap.v1';

/** 社区 / 内置常见 tag → 用途（从「用来干什么」出发） */
const TAG_ALIASES = {
  // 开发编程
  code: 'dev-programming',
  coding: 'dev-programming',
  review: 'dev-programming',
  api: 'dev-programming',
  backend: 'dev-programming',
  frontend: 'dev-programming',
  git: 'dev-programming',
  commit: 'dev-programming',
  workflow: 'dev-programming',
  debug: 'dev-programming',
  debugging: 'dev-programming',
  python: 'dev-programming',
  javascript: 'dev-programming',
  typescript: 'dev-programming',
  regex: 'dev-programming',
  text: 'dev-programming',
  development: 'dev-programming',
  dev: 'dev-programming',
  quality: 'dev-programming',
  refactor: 'dev-programming',
  testing: 'dev-programming',

  // 数据分析
  sql: 'data-analysis',
  data: 'data-analysis',
  analysis: 'data-analysis',
  analytics: 'data-analysis',
  chart: 'data-analysis',
  spreadsheet: 'data-analysis',
  excel: 'data-analysis',

  // 内容创作
  writing: 'content-creation',
  email: 'content-creation',
  communication: 'content-creation',
  summary: 'content-creation',
  grammar: 'content-creation',
  editing: 'content-creation',
  tone: 'content-creation',
  english: 'content-creation',
  language: 'content-creation',
  translation: 'content-creation',
  creative: 'content-creation',
  ideation: 'content-creation',
  structure: 'content-creation',

  // 办公效率
  work: 'office-efficiency',
  productivity: 'office-efficiency',
  planning: 'office-efficiency',
  meeting: 'office-efficiency',
  report: 'office-efficiency',
  office: 'office-efficiency',

  // 设计多媒体
  design: 'design-media',
  media: 'design-media',
  image: 'design-media',
  video: 'design-media',
  ui: 'design-media',

  // AI Agent
  assistant: 'ai-agent',
  agent: 'ai-agent',
  mcp: 'ai-agent',
  prompt: 'ai-agent',
  llm: 'ai-agent',
  ai: 'ai-agent',

  // 知识管理
  knowledge: 'knowledge-management',
  notes: 'knowledge-management',
  thinking: 'knowledge-management',
  decision: 'knowledge-management',
  general: 'knowledge-management',

  // 商业运营
  business: 'business-ops',
  marketing: 'business-ops',
  ops: 'business-ops',
  sales: 'business-ops',

  // 教育学习
  learning: 'education',
  education: 'education',
  quiz: 'education',
  explain: 'education',
  tutor: 'education',
  reading: 'education',
  teach: 'education',

  // 行业专业
  career: 'professional',
  resume: 'professional',
  interview: 'professional',
  legal: 'professional',
  professional: 'professional',

  // IT 运维与安全
  devops: 'it-ops-security',
  security: 'it-ops-security',
  docker: 'it-ops-security',
  k8s: 'it-ops-security',
  ops_sec: 'it-ops-security',

  // 生活服务
  life: 'life-service',
  travel: 'life-service',
  cooking: 'life-service',
  fitness: 'life-service',
  health: 'life-service',
  finance: 'life-service',
};

/** assistant.metadata.category 旧 5 类 → 用途 */
const CATEGORY_ALIASES = {
  development: 'dev-programming',
  writing: 'content-creation',
  learning: 'education',
  career: 'professional',
  life: 'life-service',
};

function normKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}

/** 读 AI 归类缓存 { [tag]: purposeSlug } */
export function loadAiPurposeMap() {
  try {
    const raw = localStorage.getItem(AI_MAP_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (PURPOSE_SET.has(v)) out[normKey(k)] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveAiPurposeMap(map) {
  try {
    localStorage.setItem(AI_MAP_KEY, JSON.stringify(map || {}));
  } catch { /* ignore */ }
}

/**
 * 单标签 → 用途 slug；无法归类返回 null（避免碎片进入筛选项）
 * @param {string} tag
 * @param {Record<string, string>} [aiMap]
 */
export function tagToPurpose(tag, aiMap = {}) {
  const key = normKey(tag);
  if (!key) return null;
  if (PURPOSE_SET.has(key)) return key;
  if (TAG_ALIASES[key]) return TAG_ALIASES[key];
  // 去连字符再试（code-review → 拆不开时用整词）
  const compact = key.replace(/-/g, '');
  if (TAG_ALIASES[compact]) return TAG_ALIASES[compact];
  // 前缀匹配：code-review → code
  for (const [alias, purpose] of Object.entries(TAG_ALIASES)) {
    if (key === alias || key.startsWith(`${alias}-`) || key.endsWith(`-${alias}`)) {
      return purpose;
    }
  }
  if (aiMap[key] && PURPOSE_SET.has(aiMap[key])) return aiMap[key];
  return null;
}

/** 资源 → 用途 slug 列表（去重） */
export function resolvePurposes(item, aiMap = {}) {
  const set = new Set();
  const cat = item?.metadata?.category;
  if (cat) {
    const key = normKey(cat);
    if (PURPOSE_SET.has(key)) set.add(key);
    else if (CATEGORY_ALIASES[key]) set.add(CATEGORY_ALIASES[key]);
  }
  const tags = item?.metadata?.tags ?? item?.tags;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const p = tagToPurpose(t, aiMap);
      if (p) set.add(p);
    }
  }
  return [...set];
}

/** 解析本地网关 base（与 idle-skill-ai 一致） */

/**
 * 用本地网关小模型把未知标签归入用途；失败则返回原缓存。
 * @param {string[]} rawTags
 * @param {Record<string, string>} [prevMap]
 * @returns {Promise<Record<string, string>>}
 */
export async function aggregateTagsWithAi(rawTags, prevMap = {}) {
  const map = { ...prevMap };
  const unknown = [...new Set((rawTags || []).map(normKey).filter(Boolean))]
    .filter((t) => !tagToPurpose(t, map));
  if (!unknown.length) return map;
  if (!window.electronAPI?.llm?.fetch) return map;

  const base = await resolveGatewayBase();
  const purposeList = PURPOSE_SLUGS.join(', ');
  const prompt = [
    '你是资源标签归类器。把每个标签归到「用途」分类，只输出 JSON 对象，不要解释。',
    `用途只能是: ${purposeList}`,
    '从「这个资源用来干什么」判断，例如 git→dev-programming，writing→content-creation，cooking→life-service。',
    `标签: ${JSON.stringify(unknown)}`,
    '输出格式: {"tag1":"purpose-slug","tag2":"purpose-slug"}',
  ].join('\n');

  try {
    const res = await window.electronAPI.llm.fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'auto',
        temperature: 0,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    // ipc 返回 { status, body }
    if (!res || res.status >= 400) return map;
    const data = JSON.parse(res.body || '{}');
    const text = data?.choices?.[0]?.message?.content || data?.content || '';
    const jsonMatch = String(text).match(/\{[\s\S]*\}/);
    if (!jsonMatch) return map;
    const parsed = JSON.parse(jsonMatch[0]);
    for (const [k, v] of Object.entries(parsed || {})) {
      const purpose = normKey(v);
      if (PURPOSE_SET.has(purpose)) map[normKey(k)] = purpose;
    }
    saveAiPurposeMap(map);
  } catch {
    // 网关不可用时静默回退静态映射
  }
  return map;
}

/** 每批送给模型的未打标技能数（偏小，降低截断/漏标） */
const SKILL_PURPOSE_BATCH = 10;
/** 补跑遗漏时更小批次 */
const SKILL_PURPOSE_RETRY_BATCH = 5;

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
}

/**
 * 名称/简介启发式用途（AI 漏标时兜底，尽量不落到「其它」）。
 * @param {string} [name]
 * @param {string} [description]
 * @returns {string} purposeSlug
 */
export function inferPurposeHeuristic(name = '', description = '') {
  const text = `${name} ${description}`.toLowerCase();
  const hits = new Map();
  const bump = (purpose, n = 1) => {
    if (!PURPOSE_SET.has(purpose)) return;
    hits.set(purpose, (hits.get(purpose) || 0) + n);
  };
  for (const tok of text.split(/[^a-z0-9\u4e00-\u9fff]+/).filter((t) => t.length >= 2)) {
    const p = tagToPurpose(tok);
    if (p) bump(p, 1);
  }
  for (const [alias, purpose] of Object.entries(TAG_ALIASES)) {
    if (alias.length >= 3 && text.includes(alias)) bump(purpose, 2);
  }
  let best = null;
  let bestN = 0;
  for (const [p, n] of hits) {
    if (n > bestN) {
      best = p;
      bestN = n;
    }
  }
  // 无信号时归入知识管理，避免长期留在「其它」
  return best || 'knowledge-management';
}

/** 把模型 JSON 键对齐到 batch 内的真实 id（兼容 name / 短 id） */
function resolveBatchId(rawKey, batch) {
  const key = String(rawKey || '').trim();
  if (!key) return '';
  if (batch.some((s) => s.id === key)) return key;
  const byName = batch.find((s) => s.name === key || normKey(s.name) === normKey(key));
  if (byName) return byName.id;
  const bySuffix = batch.find((s) => s.id.endsWith(key) || s.id.endsWith(`-${key}`));
  if (bySuffix) return bySuffix.id;
  return '';
}

async function classifyBatchWithAi(batch, base, purposeList, signal) {
  throwIfAborted(signal);
  const ids = batch.map((s) => s.id);
  const prompt = [
    '你是 Skill 用途分类器。根据技能名称与简介，为每个技能选一个最合适的用途。',
    '只输出 JSON 对象，不要解释、不要 markdown。',
    `用途只能是: ${purposeList}`,
    `必须为下列每一个 id 都给出用途（不得省略）: ${JSON.stringify(ids)}`,
    `技能: ${JSON.stringify(batch)}`,
    '输出格式: {"res-skill-xxx":"dev-programming","res-skill-yyy":"content-creation"}',
  ].join('\n');

  const res = await window.electronAPI.llm.fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      temperature: 0,
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  throwIfAborted(signal);
  if (!res || res.status >= 400) return {};
  const data = JSON.parse(res.body || '{}');
  const text = data?.choices?.[0]?.message?.content || data?.content || '';
  const jsonMatch = String(text).match(/\{[\s\S]*\}/);
  if (!jsonMatch) return {};
  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(parsed || {})) {
    const purpose = normKey(v);
    const id = resolveBatchId(k, batch);
    if (id && PURPOSE_SET.has(purpose)) out[id] = purpose;
  }
  return out;
}

/**
 * 用本地网关按 name/description 为未打标 Skill 推断一级用途。
 * 漏标会小批次补跑，仍缺则启发式兜底，保证尽量每项都有用途。
 * @param {Array<{ id: string, name?: string, description?: string }>} skills
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<Record<string, string>>} id → purposeSlug
 */
export async function classifySkillsPurposeWithAi(skills = [], opts = {}) {
  const signal = opts.signal;
  const list = (skills || [])
    .map((s) => ({
      id: String(s?.id || '').trim(),
      name: String(s?.name || '').trim().slice(0, 80),
      description: String(s?.description || '').trim().slice(0, 180),
    }))
    .filter((s) => s.id);
  if (!list.length) return {};

  const out = {};
  // 网关不可用时直接启发式，避免全部留在「其它」
  if (!window.electronAPI?.llm?.fetch) {
    for (const s of list) out[s.id] = inferPurposeHeuristic(s.name, s.description);
    return out;
  }

  throwIfAborted(signal);
  const base = await resolveGatewayBase();
  throwIfAborted(signal);
  const purposeList = PURPOSE_SLUGS.join(', ');

  const runBatches = async (items, size) => {
    for (let i = 0; i < items.length; i += size) {
      throwIfAborted(signal);
      const batch = items.slice(i, i + size);
      try {
        const part = await classifyBatchWithAi(batch, base, purposeList, signal);
        Object.assign(out, part);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
      }
    }
  };

  await runBatches(list, SKILL_PURPOSE_BATCH);

  // 补跑 AI 未返回的 id
  let missing = list.filter((s) => !out[s.id]);
  if (missing.length) {
    await runBatches(missing, SKILL_PURPOSE_RETRY_BATCH);
    missing = list.filter((s) => !out[s.id]);
  }

  // 仍缺：启发式兜底
  for (const s of missing) {
    out[s.id] = inferPurposeHeuristic(s.name, s.description);
  }
  return out;
}
