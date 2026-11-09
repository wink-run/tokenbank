import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '../store/lang';
import { createPortal } from 'react-dom';
import {
  ASSET_BTN_GHOST,
  ASSET_BTN_MANAGED,
  ASSET_BTN_PRIMARY,
  AssetLogo,
  buildPreviewText,
  resourceDescription,
  resourceIntro,
  resourceDisplayName,
  typeVisual,
} from './ResourceAssetCard';
import {
  LIB_LIST_CLS, libRowCls, LibrarySectionHead, LibraryRowTitle,
  LibraryInspector, InspectorSection, InspectorPreview,
} from './LibraryControls';
import PortraitShareModal, { PortraitVisualBoard } from './PortraitShareCard';
import { tagToPurpose } from '../lib/resource-purpose';
import { completeEnablePackage, copyText } from '../lib/resource-enable';
import { updateProfilePersona } from '../api/client';

const FINDER_NAME = 'resource-finder';
const PORTRAIT_NAME = 'resource-portrait';
const MAX_RECS = 20;
const LAST_KEY = 'tokenbank.resources.recommend.last';
/** 跨技能/提示词/智能体共享的稳定画像(不必每种资产重头分析) */
const PORTRAIT_KEY = 'tokenbank.resources.recommend.portrait';
/** 画像挖掘可跑的 CLI runtime（缺一不可：至少一个已纳管） */
const MINE_RUNTIME_IDS = new Set(['codex', 'claude-code', 'cursor', 'kimi-code']);
const RUNTIME_PREF_KEY = 'tokenbank.resources.recommend.runtime';

function readRuntimePref() {
  try {
    const v = localStorage.getItem(RUNTIME_PREF_KEY);
    return MINE_RUNTIME_IDS.has(v) ? v : '';
  } catch { return ''; }
}
function saveRuntimePref(id) {
  try {
    if (MINE_RUNTIME_IDS.has(id)) localStorage.setItem(RUNTIME_PREF_KEY, id);
  } catch { /* ignore */ }
}

/** 写入智能体 content.runtime_agent（保留其余字段） */
function contentWithRuntime(content, runtimeId) {
  const rt = String(runtimeId || '').trim();
  let obj;
  try {
    obj = JSON.parse(String(content || '').trim() || '{}');
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = { soul: String(content || '') };
  } catch {
    obj = { soul: String(content || '') };
  }
  obj.runtime_agent = rt;
  return JSON.stringify(obj, null, 2);
}

const normType = (tf) => (tf === 'prompt' || tf === 'assistant' ? tf : 'skill');
const instKey = (rt) => (rt === 'prompt' ? 'prompts' : rt === 'assistant' ? 'assistants' : 'skills');

// SkillHub 12 个一级分类 slug —— category 必须取其一,否则前端无法国际化
const CATEGORY_SLUGS = [
  'dev-programming', 'data-analysis', 'content-creation', 'office-efficiency',
  'design-media', 'ai-agent', 'knowledge-management', 'business-ops',
  'education', 'professional', 'it-ops-security', 'life-service',
];
const CATEGORY_RULE = `- category 只能取以下英文 slug 之一(不要用中文或其它词):${CATEGORY_SLUGS.join(', ')}。`;

const TYPE_SOURCES = {
  // SkillHub 为主;ECC/skills 作补充探索路径(目录名即真实 skill)
  skill: '来源:① 用 find-skill / `skillhub search --json` 在 SkillHub 检索;② https://github.com/affaan-m/ECC/tree/main/skills。只推荐真实存在的 slug/目录名,禁止编造。',
  // 社区目录优先;ECC/agents 作补充探索(可参考其 md 写 composed soul)
  assistant: '来源(智能体):① 优先选下方「Token Bank 社区目录」真实条目(填 catalogId);② https://github.com/affaan-m/ECC/tree/main/agents;③ 目录与 ECC 没有合适的,可按用户需求自建:写完整 soul + 搭配客观存在的技能。',
  prompt: '来源(提示词):① https://github.com/f/awesome-chatgpt-prompts(prompts.csv);② https://www.aishort.top/;③ https://lexica.art/。',
};
const TYPE_JSON = {
  skill: '{"recommendations":[{"slug":"","name":"","description":"","category":"","reason":"","downloads":0,"icon":""}]}',
  // catalog=目录项;composed=自建(须完整 soul + 真实 skills)
  assistant: '{"recommendations":[{"catalogId":"目录有则填否则空","slug":"短英文id","name":"","description":"","category":"","reason":"","soul":"完整人设/系统提示(自建必填)","skills":["真实技能slug"],"source":"catalog|composed"}]}',
  prompt: '{"recommendations":[{"name":"","description":"","category":"","reason":"","content":"full prompt text","source":""}]}',
};

/** 明显编造的泛化「技能名」,不是客观存在的 skill slug。 */
const FAKE_SKILL_SLUGS = new Set([
  'python', 'javascript', 'typescript', 'java', 'golang', 'go', 'rust', 'c++', 'cpp',
  'react', 'vue', 'nodejs', 'node', 'frontend', 'backend', 'fullstack', 'full-stack',
  'api', 'api-dev', 'api-design', 'testing', 'testing-patterns', 'unit-test',
  'ai', 'llm', 'coding', 'debugging', 'devops', 'docker', 'k8s', 'sql',
  'design', 'writing', 'marketing', 'product', 'manager', 'assistant',
]);

function looksLikeSkillSlug(s) {
  const t = String(s || '').trim().toLowerCase();
  if (!t || t.length < 3 || t.length > 64) return false;
  if (!/^[a-z][a-z0-9]+(?:-[a-z0-9]+)+$/.test(t) && !/^[a-z][a-z0-9-]{3,}$/.test(t)) return false;
  if (FAKE_SKILL_SLUGS.has(t)) return false;
  // 单段无连字符的常见语言名已在 FAKE;允许多段 kebab(如 systematic-debugging)
  return true;
}

function slugifyAssistantId(name, fallback) {
  const raw = String(name || fallback || 'custom-assistant').trim();
  const ascii = raw
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (ascii.length >= 3) return ascii.slice(0, 48);
  // 中文名等:用稳定短 hash,避免非法 id
  let h = 0;
  for (let i = 0; i < raw.length; i += 1) h = ((h << 5) - h) + raw.charCodeAt(i);
  return `assistant-${(h >>> 0).toString(36)}`;
}

function lastKey(tf) { return `${LAST_KEY}.${normType(tf)}`; }
function loadLast(tf) { try { const r = JSON.parse(localStorage.getItem(lastKey(tf))); if (r && Array.isArray(r.items)) return r; } catch { /* */ } return null; }
function saveLast(tf, items) { try { localStorage.setItem(lastKey(tf), JSON.stringify({ items, savedAt: Date.now() })); } catch { /* */ } }
function clearAllLast() {
  for (const tf of ['skill', 'prompt', 'assistant']) {
    try { localStorage.removeItem(lastKey(tf)); } catch { /* */ }
  }
}
function recKey(rec) { return rec.slug || rec.name || ''; }

/** 推荐卡片是否对应当前已纳管资源 */
function recMatchesManaged(rec, managedKeys) {
  if (!rec || !managedKeys || !managedKeys.size) return false;
  const keys = [rec.slug, rec.name, rec.catalogId, rec.resourceId]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  return keys.some((k) => managedKeys.has(k));
}

/** 从已纳管记录取第一条命中(用于对齐名称/说明/正文) */
function findManagedHit(rec, byKey) {
  if (!rec || !byKey) return null;
  for (const k of [rec.slug, rec.name, rec.catalogId, rec.resourceId]) {
    const key = String(k || '').trim();
    if (key && byKey.has(key)) return byKey.get(key);
  }
  return null;
}

/**
 * 用本机已纳管列表校正 adopted,并把名称/说明与已纳管对齐(推荐卡 ↔ 已纳管卡一致)。
 */
function applyManagedAlign(items, managedKeys, byKey, rtype) {
  if (!Array.isArray(items)) return items;
  let changed = false;
  const next = items.map((rec) => {
    const adopted = recMatchesManaged(rec, managedKeys);
    const hit = findManagedHit(rec, byKey);
    let patch = { ...rec };
    if (!!rec.adopted !== adopted) {
      changed = true;
      patch.adopted = adopted;
    }
    if (hit) {
      // 技能标题以落库 name 为准;其它优先 display_name
      const alignedName = resourceDisplayName(rtype, {
        name: hit.name,
        slug: rec.slug || hit.name,
        display_name: hit.display_name,
      });
      const alignedDesc = resourceDescription(hit) || resourceDescription(rec);
      const alignedContent = String(hit.content || '').trim() || String(rec.content || rec.soul || '').trim();
      if (rtype === 'skill') {
        if (alignedName && alignedName !== (rec.slug || rec.name)) {
          changed = true;
          patch = { ...patch, slug: alignedName, name: alignedName };
        }
      } else if (alignedName && alignedName !== (rec.name || rec.slug)) {
        changed = true;
        patch = { ...patch, name: alignedName, display_name: hit.display_name || alignedName };
      }
      if (alignedDesc && alignedDesc !== resourceDescription(rec)) {
        changed = true;
        patch = { ...patch, description: alignedDesc };
      }
      if (alignedContent && alignedContent !== String(rec.content || rec.soul || '').trim()) {
        changed = true;
        patch = { ...patch, content: alignedContent };
        if (rtype === 'assistant' && !patch.soul) patch.soul = alignedContent;
      }
    }
    return patch;
  });
  return changed ? next : items;
}

async function fetchManagedIndex(rtype) {
  const keys = new Set();
  const byKey = new Map();
  const remember = (k, r) => {
    const key = String(k || '').trim();
    if (!key) return;
    keys.add(key);
    const prev = byKey.get(key) || {};
    byKey.set(key, {
      name: r.name || prev.name || '',
      display_name: r.display_name || prev.display_name || '',
      description: resourceDescription(r) || prev.description || '',
      content: String(r.content || '').trim() || prev.content || '',
    });
  };
  try {
    const res = await window.electronAPI.resource.listResources({ type: rtype });
    for (const r of (res && res.resources) || []) {
      remember(r.id, r);
      remember(r.name, r);
      remember(r.display_name, r);
      const src = String(r.source_url || r.source || '');
      const m = /^catalog:(.+)$/.exec(src);
      if (m) remember(m[1], r);
    }
  } catch { /* ignore */ }
  if (rtype === 'skill') {
    try {
      const scan = await window.electronAPI.resource.scanDiscovered({ includeManaged: true });
      for (const i of (scan && scan.items) || []) {
        remember(i.name, i);
        remember(i.resourceId, i);
      }
    } catch { /* ignore */ }
  }
  return { keys, byKey };
}

function loadPortrait() {
  try {
    const r = JSON.parse(localStorage.getItem(PORTRAIT_KEY) || 'null');
    if (r && typeof r === 'object' && (r.persona || (r.goals && r.goals.length))) return r;
  } catch { /* */ }
  return null;
}
function syncPersonaToServer(persona) {
  // 有登录态时把一句话画像同步到云端，供贡献者主页展示
  updateProfilePersona(persona || '').catch(() => {});
}
function savePortrait(patch) {
  try {
    const prev = loadPortrait() || {};
    const needsByType = { ...(prev.needsByType || {}), ...((patch && patch.needsByType) || {}) };
    const next = { ...prev, ...patch, needsByType, updatedAt: Date.now() };
    localStorage.setItem(PORTRAIT_KEY, JSON.stringify(next));
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'persona') || next.persona) {
      syncPersonaToServer(next.persona || '');
    }
    return next;
  } catch { return patch; }
}
function clearPortrait() {
  try { localStorage.removeItem(PORTRAIT_KEY); } catch { /* */ }
  syncPersonaToServer('');
  clearAllLast();
  // 进行中的挖掘/发现任务状态一并清掉
  try {
    for (const rt of ['skill', 'prompt', 'assistant']) clearRun(rt);
  } catch { /* ignore */ }
}
/** 某类型尚无 needs 时,用能力域顶上去,避免换资产还要重跑画像 */
function seedNeedsFromGoals(goals) {
  return (Array.isArray(goals) ? goals : [])
    .map((g) => String(g || '').trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((text) => ({ text, category: '' }));
}
function applyPortraitToState(portrait, rtype) {
  if (!portrait) {
    return {
      digest: null, installed: null, persona: '', traits: [], goals: [], extensions: [], needs: [],
    };
  }
  const typed = (portrait.needsByType && portrait.needsByType[rtype]) || [];
  return {
    digest: portrait.digest || null,
    installed: portrait.installed || null,
    persona: portrait.persona || '',
    traits: portrait.traits || [],
    goals: portrait.goals || [],
    extensions: portrait.extensions || [],
    needs: typed.length ? typed : seedNeedsFromGoals(portrait.goals),
  };
}

/** 常见 agent id → 可读名(未知则原样)。 */
const AGENT_LABELS = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  'claude-3p': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  workbuddy: 'WorkBuddy',
  'trae-work': 'Trae',
  'trae-cn': 'Trae',
};
function agentLabel(id) { return AGENT_LABELS[id] || id || ''; }

/** 从 digest 汇总：分析了哪些智能体、看到了哪些对话。 */
function evidenceFromDigest(digest) {
  if (!digest) return { agents: [], dialogues: [], sessions: 0 };
  const fromDlg = (digest.dialogues || []).map((d) => d.agent).filter(Boolean);
  const agents = [...new Set([...(digest.agents || []), ...fromDlg].filter(Boolean))];
  return {
    agents,
    dialogues: digest.dialogues || [],
    sessions: digest.sessions || 0,
  };
}

/** 分析依据：只展示汇总(会话数/对话数/智能体),不展开对话明细。 */
function EvidencePanel({ digest, t }) {
  const ev = evidenceFromDigest(digest);
  if (!ev.sessions && !ev.dialogues.length && !ev.agents.length) return null;
  const agentNames = ev.agents.map(agentLabel).filter(Boolean);

  return (
    <div className="rounded-md border border-zinc-100 dark:border-zinc-800 bg-zinc-50/80 dark:bg-zinc-800/40 p-2.5 space-y-2">
      <div className="min-w-0 space-y-1">
        <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">{t('resources.reco.evidenceTitle')}</p>
        <p className="text-[10px] text-zinc-500">
          {t('resources.reco.evidenceSummary', {
            sessions: ev.sessions,
            dialogues: ev.dialogues.length,
            agents: agentNames.length ? agentNames.join('、') : t('resources.reco.evidenceNoAgent'),
          })}
        </p>
      </div>
      {agentNames.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {agentNames.map((name) => (
            <span key={name} className="text-[10px] px-1.5 py-0.5 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── 跨 tab 切换 / 页面导航存活的运行状态 ─────────────────────────────────────
// agent 任务跑在主进程,组件卸载不影响它;这里把 UI 侧状态提到模块级 + localStorage,
// 重新挂载时按类型恢复并继续轮询,回来即可收口。
const RUN_KEY = 'tokenbank.resources.recommend.run';
const RUNS = new Map();    // rtype -> { phase, digest, persona, traits, goals, extensions, needs, ... }
const PENDING = new Map(); // taskId -> job(跨组件实例)

function persistRuns() {
  try { localStorage.setItem(RUN_KEY, JSON.stringify([...RUNS.entries()])); } catch { /* */ }
}
function restoreRuns() {
  try {
    for (const [k, v] of JSON.parse(localStorage.getItem(RUN_KEY) || '[]')) {
      if (!v || typeof v !== 'object') continue;
      RUNS.set(k, v);
      if (v.taskId && v.job) PENDING.set(v.taskId, v.job);
    }
  } catch { /* */ }
}
restoreRuns();

function getRun(rt) { return RUNS.get(rt) || null; }
function setRun(rt, patch) {
  RUNS.set(rt, { ...(RUNS.get(rt) || {}), ...patch });
  persistRuns();
}
function clearRun(rt) { RUNS.delete(rt); persistRuns(); }

function fmtAgo(ts, t) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return t('resources.reco.ago.now');
  if (s < 3600) return t('resources.reco.ago.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('resources.reco.ago.hour', { n: Math.floor(s / 3600) });
  return t('resources.reco.ago.day', { n: Math.floor(s / 86400) });
}

/** 对话素材 → 稳定身份 + 有人味的风格透镜 + 可迁移能力域 + 延伸兴趣。 */
function digestToAnalyzePrompt(digest, installed, rtype, typeLabel, langLine) {
  const L = [];
  const dialogues = digest.dialogues || [];
  L.push(
    `以下是我与纳管智能体近 ${digest.sessions} 个会话的对话摘录。`,
    '对话只是证据:用来认出「我是谁」。过去做过的具体题/具体功能 ≠ 未来该配什么资源。',
    '',
    '## 核心原则(必守)',
    '- 画像看稳定身份,不看最近琐事。例:学生常问「二年级某道数学题」→「需要学习陪伴的学生」,',
    `  再配${typeLabel}(讲解教练、练习生成、错题整理…),而不是「只会解那一道题」。`,
    '- persona / traits / goals / extensions 是跨资产可复用的稳定画像;needs 才针对本轮的资源类型。',
    '- goals / needs 写「这类人长期该配备的能力」,不是「当前项目/岗位说明书」。',
    '  反例:「Agent 编排全链路」「Electron 打包 CI」——复述正在做的产品。',
    '  正例:「独立产品从 0 到 1」「可复用自动化工作流」「设计系统与体验」「技术表达与知识变现」。',
    '- 能力域可迁移:换一批会话仍大体不变;禁止任务/仓库/页面级垂直。',
    '- 至少 1 条 goals 跳出对话里反复出现的当前产品主题;适当延伸相邻人设与兴趣。',
    '',
    '## 风格透镜(要有人味,但非确诊)',
    '请大胆而有依据地推测性格与做事气质,让画像像「真人侧写」而不是干巴巴的职能描述。',
    '鼓励使用(可组合):MBTI 倾向、DISC/Belbin、学习风格;可选星座意象作气质修辞。',
    '',
    '## 输出文风(必守)',
    '- 只给结论,不要暴露推理过程:禁止引用用户原话、禁止「反复要求/从对话可见/执着于…」等证据链。',
    '- 禁止用「——」「→」串联「依据 → 启示」;每条 traits 写成干净短句即可。',
    '- 禁止括号里的教学说明(如「非诊断」「心理透镜」之类元说明写进正文)。',
    '- 正例:「偏 INTJ:爱搭可组合系统,适合架构权衡与清单型助手」',
    '- 反例:「偏 INTJ:反复要求『抽象度不够』…——不是解决眼前问题…→ 适合…」',
  );
  if (dialogues.length) {
    L.push('', '## 对话摘录(证据,勿逐条复述成目标)');
    dialogues.forEach((d, i) => {
      const head = [d.project && `项目:${d.project}`, d.agent && `Agent:${d.agent}`].filter(Boolean).join(' · ');
      L.push(`${i + 1}. ${head ? `(${head}) ` : ''}${d.goal}`);
      (d.notes || []).forEach((n) => L.push(`   - ${n}`));
    });
  } else {
    L.push('', '(暂无可用的用户对话摘录)');
  }
  if (digest.projects && digest.projects.length) {
    L.push('', `- 常涉项目:${digest.projects.map((x) => `${x.name}×${x.count}`).join(', ')}(仅背景,勿写进 goals/needs)`);
  }
  const inst = (installed && installed[instKey(rtype)]) || [];
  if (inst.length) L.push(`- 我已拥有的${typeLabel}:${inst.join('、')}`);
  L.push(
    '',
    '## 请输出',
    '1) persona:一句话真人侧写(身份 + 气质 + 做事方式)。直接写结论,不要括号注释,不要推理过程。',
    '2) traits: 3~4 条干净短句;至少 1 条含「偏 INTJ/ENFP」等标签;格式「偏 XX:气质一句话,适合…助手」。',
    '   勿写依据、勿引原话、勿用破折号展开推理。',
    '3) goals: 3~4 条可迁移能力域短标题;至少 1 条跳出当前产品主题。',
    '4) extensions: 2~4 条相邻人设或兴趣短标题。',
    `5) needs: 4~6 条${typeLabel}短标题——「这类人该长期配备什么」;宽、可搜索;禁止仓库贴身清单。`,
    '',
    '## 输出格式',
    '只输出唯一一个 ```json 代码块,字段填入真实推断(不要照抄尖括号说明):',
    '```json',
    '{',
    '  "persona": "<有人味的主身份侧写,无括号说明>",',
    '  "traits": ["<偏 INTJ:…,适合…>", "<偏 C 型:…,适合…>", "<…>"],',
    '  "goals": ["<可迁移能力域A>", "<可迁移能力域B>", "<可迁移能力域C>"],',
    '  "extensions": ["<相邻人设或兴趣1>", "<相邻人设或兴趣2>"],',
    '  "needs": [{"text": "<可搜索的宽能力方向>", "category": "<slug>"}]',
    '}',
    '```',
    '此步先不要推荐具体资源条目。',
    langLine,
  );
  return L.join('\n');
}

/** 稳定身份 + 有人味风格 + 可迁移能力域 → 发现匹配气质且非项目贴身的资源。 */
function discoverPrompt(persona, traits, goals, extensions, needs, supplement, excludeKeys, rtype, typeLabel, langLine, catalogPool) {
  const L = [];
  L.push(`我的画像侧写:${persona || '一名使用者'}。`);
  if (traits && traits.length) {
    L.push('性格与风格:');
    traits.forEach((tr, i) => L.push(`${i + 1}. ${tr}`));
  }
  if (goals && goals.length) {
    L.push('可迁移能力域(身份级,不是当前仓库待办):');
    goals.forEach((g, i) => L.push(`${i + 1}. ${g}`));
  }
  if (extensions && extensions.length) {
    L.push('可延伸的相邻人设/兴趣(保留新颖性):');
    extensions.forEach((e, i) => L.push(`${i + 1}. ${e}`));
  }
  L.push(`因此我需要这些${typeLabel}:`);
  (needs || []).forEach((n, i) => L.push(`${i + 1}. ${n.text}${n.category ? `(${n.category})` : ''}`));
  if (supplement && supplement.trim()) L.push('', `补充诉求(请重点考虑):${supplement.trim()}`);
  L.push(
    '',
    TYPE_SOURCES[rtype],
    '',
    `请为上述画像发现多样化的${typeLabel},最多 ${MAX_RECS} 个,只发现不安装。`,
    '- 约 60% 主能力域,25% extensions,15% 对话未出现但对同类身份有杠杆的通用能力。',
    '- 优先换项目仍有用;禁止只服务某一仓库/功能链的贴身清单。',
    '- reason 一句话点明匹配点即可,不要复述用户对话细节或推理链。',
    '- 助手气质跟 traits 走:INTJ/结构化→架构权衡与清单;ENFP/探索→头脑风暴与表达;一人公司→复盘与自动化。',
  );
  if (rtype === 'prompt') L.push('- content 必须是提示词正文全文;无正文的不要列。');
  if (rtype === 'skill') {
    L.push('- 每条必须来自 `skillhub search --json` 或 ECC/skills 真实目录名,slug 原样回填;搜不到的不要编。');
  }
  if (rtype === 'assistant') {
    L.push(
      '- 优先选「Token Bank 社区目录」里已有智能体(填 catalogId,可省略 soul)。',
      '- 也可参考 ECC/agents 下真实 agent md,提炼为自建智能体(source=composed)。',
      '- 目录与 ECC 覆盖不到的需求:允许自建智能体(source=composed):必须写完整 soul(角色/职责/工作方式/输出风格),并搭配客观存在的技能。',
      '- skills 硬约束:只能填下方目录技能 name、ECC/skills 真实目录名,或经 `skillhub search --json` 确认存在的真实 slug;禁止 python/api-dev/testing-patterns 等泛化假名。',
      '- 自建至少搭配 1~6 个真实技能;没有真实技能可配的不要硬凑。',
    );
    if (catalogPool && catalogPool.assistants && catalogPool.assistants.length) {
      L.push('', '## Token Bank 社区目录(智能体,有合适的优先选)');
      catalogPool.assistants.forEach((a) => {
        const sk = (a.skills && a.skills.length) ? ` skills=[${a.skills.join(',')}]` : '';
        L.push(`- catalogId=${a.catalogId} | name=${a.name} | ${a.display_name || a.name}: ${(a.description || '').slice(0, 80)}${sk}`);
      });
    }
    if (catalogPool && catalogPool.skills && catalogPool.skills.length) {
      L.push('', `## 客观存在的目录技能(自建优先从这里选):${catalogPool.skills.map((s) => s.name).join(', ')}`);
      L.push('若目录不够,再用 skillhub search 补真实 slug,并原样写入 skills。');
    }
  }
  if (excludeKeys && excludeKeys.length) L.push(`- 排除这些已展示过的项:${excludeKeys.join(', ')}`);
  L.push(CATEGORY_RULE, langLine, '', '最后输出唯一一个 ```json 代码块:', TYPE_JSON[rtype]);
  return L.join('\n');
}

/** 从目录条目 content 解析 skills 列表。 */
function skillsFromCatalogContent(content) {
  try {
    const raw = String(content || '').trim();
    if (!raw.startsWith('{')) return [];
    const o = JSON.parse(raw);
    return Array.isArray(o.skills) ? o.skills.map(String).filter(Boolean) : [];
  } catch { return []; }
}

/**
 * 过滤 skills:目录内必留;目录外仅保留像真实 skillhub slug 的项(安装时再校验)。
 */
function filterRealSkills(skills, catalogSkillNames) {
  const known = catalogSkillNames instanceof Set ? catalogSkillNames : new Set(catalogSkillNames || []);
  const out = [];
  const seen = new Set();
  for (const raw of skills || []) {
    const s = String(raw || '').trim();
    if (!s || seen.has(s)) continue;
    if (known.has(s) || looksLikeSkillSlug(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * 智能体推荐对账:
 * - 目录命中 → 用目录条目(skills 以目录为准,可叠加真实额外技能)
 * - 未命中 → 允许自建:须完整 soul + 至少 1 个客观技能
 */
function resolveAssistantRecs(recs, catalogPool) {
  const assistants = (catalogPool && catalogPool.assistants) || [];
  const skillNames = new Set(((catalogPool && catalogPool.skills) || []).map((s) => s.name));
  const byId = new Map(assistants.map((a) => [a.catalogId, a]));
  const byName = new Map(assistants.map((a) => [a.name, a]));
  const out = [];
  const seen = new Set();
  for (const r of recs || []) {
    const hit = (r.catalogId && byId.get(r.catalogId))
      || byName.get(r.slug)
      || byName.get(r.name);
    if (hit) {
      if (seen.has(hit.catalogId)) continue;
      seen.add(hit.catalogId);
      const declared = skillsFromCatalogContent(hit.content).filter((s) => skillNames.has(s));
      const extra = filterRealSkills(r.skills, skillNames).filter((s) => !declared.includes(s));
      out.push({
        catalogId: hit.catalogId,
        slug: hit.name,
        name: hit.display_name || hit.name,
        description: hit.description || r.description || '',
        category: r.category || (hit.metadata && hit.metadata.category) || '',
        reason: r.reason || '',
        skills: [...declared, ...extra],
        source: 'catalog',
      });
      continue;
    }

    // 自建:目录没有合适条目时,用人设 + 真实技能组合
    const soul = String(r.soul || r.content || '').trim();
    if (soul.length < 40) continue;
    const skills = filterRealSkills(r.skills, skillNames);
    if (!skills.length) continue; // 无客观技能则不采纳
    const name = String(r.name || r.slug || '').trim();
    if (!name || isPlaceholderText(name)) continue;
    const slug = slugifyAssistantId(r.slug || name);
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      catalogId: '',
      slug,
      name,
      description: String(r.description || '').trim(),
      category: r.category || '',
      reason: r.reason || '',
      soul,
      skills,
      source: 'composed',
    });
  }
  return out;
}

function parseJsonBlock(text) {
  if (!text || typeof text !== 'string') return null;
  const fence = /```json\s*([\s\S]*?)```/gi; let m; const tryP = (s) => { try { return JSON.parse(s); } catch { return null; } };
  while ((m = fence.exec(text)) !== null) { const o = tryP(m[1].trim()); if (o) return o; }
  const i = text.indexOf('{'); if (i >= 0) { const o = tryP(text.slice(i)); if (o) return o; }
  return null;
}
/** 过滤模型照抄的占位符(方向1 / ... / goal1 等)。 */
function isPlaceholderText(s) {
  const t = String(s || '').trim();
  if (!t) return true;
  if (/^[.…。•·\-\s]+$/.test(t)) return true;
  if (/^(方向|目标|goal|direction|need|需要|资源)\s*\d+$/i.test(t)) return true;
  if (/^<\s*.+\s*>$/.test(t)) return true; // <一句话真实画像>
  if (/^(todo|tbd|n\/a|null|undefined)$/i.test(t)) return true;
  return false;
}

/** 从原文提取特质标签前缀(「偏 INTJ」「独立全链条交付者」等)。 */
function extractTraitTag(raw) {
  const m = /^([^:：，。；;\n]{1,16})[:：]/.exec(String(raw || '').trim());
  return m ? m[1].trim() : '';
}

/**
 * 画像正文清洗:去掉括号元说明、证据链与「依据→启示」推理暴露。
 * 例:「偏 INTJ:反复要求『抽象度不够』…——…→ 适合…」→「偏 INTJ:适合…」
 */
function sanitizePortraitText(s) {
  const raw = String(s || '').trim();
  if (!raw) return '';
  const tag = extractTraitTag(raw);
  // 去掉标签后只清洗正文,最后再拼回,避免标签重复
  const colonIdx = tag ? raw.search(/[:：]/) : -1;
  let body = colonIdx >= 0 ? raw.slice(colonIdx + 1).trim() : raw;
  body = body.replace(/[（(][^）)]{0,40}[）)]/g, '');
  if (/[→⟶]/.test(body)) {
    const parts = body.split(/\s*[→⟶]\s*/);
    body = (parts[parts.length - 1] || body).trim();
  } else if (/——|––/.test(body)) {
    const parts = body.split(/\s*(?:——|––)\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      // 「…——适合…」优先结论;否则短前段视为结论、长前段视为证据
      body = /^(适合|建议|推荐|宜)/.test(last) || parts[0].length > 28
        ? last
        : parts[0];
    }
  }
  body = body
    .replace(/(反复要求|从对话(中|里)?(可见|看出)|执着于|多次提到|你曾说)[^,，;；。]*/g, '')
    .replace(/^[：:\s,，;；、]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!body) return tag || '';
  return tag ? `${tag}:${body}` : body;
}

function parseAnalyze(text) {
  const o = parseJsonBlock(text);
  const mapStrList = (arr) => (Array.isArray(arr) ? arr : [])
    .map((g) => (typeof g === 'string' ? g : (g && g.text) || ''))
    .map((g) => sanitizePortraitText(g))
    .filter((g) => g && !isPlaceholderText(g) && g.length >= 4);
  const personaRaw = sanitizePortraitText((o && o.persona) || '');
  const persona = isPlaceholderText(personaRaw) ? '' : personaRaw;
  const goals = mapStrList(o && o.goals);
  const traits = mapStrList(o && (o.traits || o.styles || o.psychology));
  const extensions = mapStrList(o && (o.extensions || o.adjacent || o.interests));
  const needs = (o && Array.isArray(o.needs) ? o.needs : [])
    .map((n) => {
      if (n && typeof n === 'object') return { ...n, text: sanitizePortraitText(n.text || '') };
      return { text: sanitizePortraitText(n) };
    })
    .filter((n) => n.text && !isPlaceholderText(n.text));
  return { persona, traits, goals, extensions, needs };
}
function parseRecommendations(text) { const o = parseJsonBlock(text); return (o && Array.isArray(o.recommendations)) ? o.recommendations : []; }

/** agent_task_steps 行 → 一句可读的活动描述(轮询用) */
function stepRowLabel(r, t) {
  if (!r) return '';
  const type = String(r.step_type || r.stepType || '');
  const c = String(r.content || '').replace(/\s+/g, ' ').trim();
  if (type === 'thinking') return c ? `${t('resources.reco.thinking')}: ${c.slice(0, 44)}` : t('resources.reco.thinkingIdle');
  if (/tool/i.test(type)) return c ? `${t('resources.reco.tool')}: ${c.slice(0, 44)}` : t('resources.reco.toolIdle');
  if (type === 'system_event') return c ? c.slice(0, 44) : '';
  if (c) return c.length > 52 ? `${c.slice(0, 52)}…` : c;
  return '';
}

/** 从 steps 拼出完整输出文本(比 result.summary 更全,用于解析 JSON 块) */
function stepsToText(rows) {
  return (rows || [])
    .filter((r) => String(r.step_type || '') !== 'thinking')
    .map((r) => String(r.content || ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * 个性化推荐(上半区)。流程:采对话 → 推测「是谁/目标」→ 补充 → 发现资源。
 * 三类统一走发现智能体;安装:技能走 skillhub;智能体优先社区目录级联纳管配套技能。
 */
/** 推荐项是否命中用途筛选（category 多为 SkillHub slug；other = 未归类） */
function recMatchesPurpose(rec, purposeFilter) {
  if (!purposeFilter) return true;
  const cat = String(rec?.category || '').trim();
  if (purposeFilter === 'other') {
    if (!cat) return true;
    if (CATEGORY_SLUGS.includes(cat)) return false;
    return !tagToPurpose(cat);
  }
  if (!cat) return false;
  if (cat === purposeFilter) return true;
  return tagToPurpose(cat) === purposeFilter;
}

/** 推荐卡是否命中搜索词（名称/slug/说明/分类/匹配理由） */
function recMatchesQuery(rec, searchQuery) {
  const q = String(searchQuery || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    rec?.name,
    rec?.slug,
    rec?.display_name,
    rec?.description,
    rec?.reason,
    rec?.match,
    rec?.match_reason,
    rec?.category,
  ].filter(Boolean).join('\n').toLowerCase();
  return hay.includes(q);
}

export default function PersonalizedRecommend({
  typeFilter,
  purposeFilter = '',
  searchQuery = '',
  LogoComp,
  onNeedProject,
  onNeedAgent,
  onRefresh,
  onAdopted,
  onItemsChange,
  /** portrait=画像挖掘展示；recommend=基于画像推荐（默认 recommend 保持资源页原行为） */
  panel = 'recommend',
  /** 无画像时引导去画像页 */
  onGoPortrait,
  /** 与资产库共用的选中态 / 详情面板挂载点（key 前缀 reco:） */
  selectedKey = null,
  onSelect,
  inspectorHost = null,
}) {
  const { t } = useLang();
  const rtype = normType(typeFilter);
  const typeLabel = t(`resources.type.${rtype}`);
  const langLine = t('resources.reco.outputLang');
  // category 优先按 slug 查 i18n;模型若返回了自由文本(如「设计多媒体」),查不到就原样显示,不露 key
  const catLabel = (c) => {
    if (!c) return '';
    const key = `resources.reco.cat.${c}`;
    const label = t(key);
    return label === key ? String(c) : label;
  };

  // 从模块级运行存储恢复(切 tab / 切页面回来后,进行中的流程原样接上)
  const saved0 = getRun(rtype) || {};
  const [ready, setReady] = useState({ loading: true });
  /** 本机已纳管的可挖掘 runtime 列表 [{id,label}] */
  const [runtimes, setRuntimes] = useState([]);
  const [selectedRuntime, setSelectedRuntime] = useState(readRuntimePref);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [phase, setPhase] = useState(saved0.phase || 'idle'); // idle | mining | analyzing | review | discovering | done
  const [digest, setDigest] = useState(saved0.digest || null);
  const [installed, setInstalled] = useState(saved0.installed || null);
  const [persona, setPersona] = useState(saved0.persona || '');
  const [traits, setTraits] = useState(saved0.traits || []);
  const [goals, setGoals] = useState(saved0.goals || []);
  const [extensions, setExtensions] = useState(saved0.extensions || []);
  const [needs, setNeeds] = useState(saved0.needs || []);
  const [supplement, setSupplement] = useState(saved0.supplement || '');
  const [items, setItems] = useState(() => { const l = loadLast(typeFilter); return l ? l.items : null; });
  const [savedAt, setSavedAt] = useState(() => { const l = loadLast(typeFilter); return l ? l.savedAt : null; });
  const [installing, setInstalling] = useState({});
  const [expandedKey, setExpandedKey] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [catalogPool, setCatalogPool] = useState({ assistants: [], skills: [] });
  const [status, setStatus] = useState('');
  const [steps, setSteps] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [activity, setActivity] = useState([]);
  const [taskId, setTaskId] = useState(saved0.taskId || null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // 用途 + 顶部搜索：共同过滤推荐卡
  const visibleItems = useMemo(() => {
    if (!items || !items.length) return items;
    return items.filter(
      (rec) => recMatchesPurpose(rec, purposeFilter) && recMatchesQuery(rec, searchQuery),
    );
  }, [items, purposeFilter, searchQuery]);

  const hasListFilter = !!(purposeFilter || String(searchQuery || '').trim());

  // 打开画像/推荐时：若本地已有一句话画像，补同步到云端（贡献者主页）
  useEffect(() => {
    const p = loadPortrait();
    const text = String(p?.persona || '').trim();
    if (text) syncPersonaToServer(text);
  }, []);

  // 推荐列表变化 → 父级刷新用途芯片
  useEffect(() => {
    if (items) onItemsChange?.(items);
  }, [items]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 终态统一处理(事件与轮询共用,PENDING 去重,先到先处理) */
  const handleTerminalRef = useRef(null);
  handleTerminalRef.current = (tid, fullText, errText) => {
    const job = PENDING.get(tid);
    if (!job) return;
    PENDING.delete(tid);
    setTaskId(null);
    if (errText) {
      const raw = String(errText).replace(/\s+/g, ' ').trim().slice(0, 300);
      const detail = raw ? `: ${raw}` : '';
      if (job.type === 'analyze') { setPhase('review'); setRun(rtype, { phase: 'review', taskId: null, job: null }); setErr(t('resources.reco.analyzeFailed', { detail })); }
      else if (job.type === 'search') { setPhase('done'); clearRun(rtype); setErr(t('resources.reco.discoverFailed', { detail })); }
      else setInstalling((s) => ({ ...s, [job.key]: undefined }));
      return;
    }
    if (job.type === 'analyze') {
      const a = parseAnalyze(fullText);
      const runSnap = getRun(rtype) || {};
      setPersona(a.persona); setTraits(a.traits); setGoals(a.goals); setExtensions(a.extensions); setNeeds(a.needs); setPhase('review');
      setRun(rtype, { phase: 'review', persona: a.persona, traits: a.traits, goals: a.goals, extensions: a.extensions, needs: a.needs, taskId: null, job: null });
      // 写入共享画像:换技能/提示词/智能体 tab 可直接复用,不必重头分析
      savePortrait({
        digest: runSnap.digest || digest,
        installed: runSnap.installed || installed,
        persona: a.persona,
        traits: a.traits,
        goals: a.goals,
        extensions: a.extensions,
        needsByType: { [rtype]: a.needs },
      });
      if (!a.needs.length && !a.persona && !a.goals.length) setMsg(t('resources.reco.noParse', { type: typeLabel }));
    } else if (job.type === 'search') {
      const seen = new Set(job.exclude || []); let out = [];
      const raw = parseRecommendations(fullText);
      if (rtype === 'assistant') {
        // 对账到社区目录,丢掉编造智能体/假技能
        out = resolveAssistantRecs(raw, job.catalogPool || catalogPool)
          .filter((r) => { const k = recKey(r); if (!k || seen.has(k)) return false; seen.add(k); return true; })
          .slice(0, MAX_RECS);
      } else {
        for (const r of raw) {
          const k = recKey(r); if (!k || seen.has(k)) continue;
          // 技能必须有真实 slug
          if (rtype === 'skill' && !String(r.slug || '').trim()) continue;
          seen.add(k); out.push(r); if (out.length >= MAX_RECS) break;
        }
      }
      setPhase('done'); clearRun(rtype);
      if (out.length > 0) { setItems(out); setSavedAt(Date.now()); saveLast(typeFilter, out); }
      else setMsg((job.exclude && job.exclude.length) ? t('resources.reco.noNew') : t('resources.reco.noCandidates'));
    } else if (job.type === 'install') {
      setInstalling((s) => ({ ...s, [job.key]: 'done' }));
      setItems((prev) => {
        const next = (prev || []).map((r) => (recKey(r) === job.key ? { ...r, adopted: true } : r));
        saveLast(typeFilter, next);
        return next;
      });
      setMsg(t('resources.reco.installedOk', { name: job.key }));
      // 技能装完后静默刷新资源列表(不卸载本组件)
      (async () => {
        try { await window.electronAPI.resource.syncDiscovered({}); } catch { /* ignore */ }
        if (typeof onRefresh === 'function') {
          try { await onRefresh(); } catch { /* ignore */ }
        }
      })();
    }
  };

  // 切类型:进行中的任务跟本类型 run;否则复用共享画像,不必重头分析
  useEffect(() => {
    const rt = normType(typeFilter);
    const l = loadLast(typeFilter);
    setItems(l ? l.items : null); setSavedAt(l ? l.savedAt : null);
    const s = getRun(rt) || {};
    const portrait = loadPortrait();
    setStatus(''); setSteps(0); setActivity([]); setMsg(''); setErr('');
    setSupplement(s.supplement || '');
    setTaskId(s.taskId || null);
    setInstalling({});

    // 本类型正在分析/发现:跟 run,不打断
    if (s.phase === 'analyzing' || s.phase === 'discovering' || s.taskId) {
      setPhase(s.phase || 'idle');
      setDigest(s.digest || (portrait && portrait.digest) || null);
      setInstalled(s.installed || (portrait && portrait.installed) || null);
      setPersona(s.persona || (portrait && portrait.persona) || '');
      setTraits(s.traits || (portrait && portrait.traits) || []);
      setGoals(s.goals || (portrait && portrait.goals) || []);
      setExtensions(s.extensions || (portrait && portrait.extensions) || []);
      setNeeds(s.needs || []);
      return;
    }

    if (portrait && (portrait.persona || (portrait.goals && portrait.goals.length))) {
      const applied = applyPortraitToState(portrait, rt);
      setDigest(applied.digest);
      setInstalled(applied.installed);
      setPersona(applied.persona);
      setTraits(applied.traits);
      setGoals(applied.goals);
      setExtensions(applied.extensions);
      setNeeds(applied.needs);
      // 该类型已有推荐结果则保持 done;否则直接进入审阅,用已有画像发现
      if (s.phase === 'done' || (l && l.items && l.items.length)) setPhase('done');
      else if (s.phase === 'review') setPhase('review');
      else setPhase('review');
      // 若本类型 needs 是用 goals 顶的,写回缓存便于下次
      if (!(portrait.needsByType && portrait.needsByType[rt] && portrait.needsByType[rt].length)
        && applied.needs.length) {
        savePortrait({ needsByType: { [rt]: applied.needs } });
      }
      return;
    }

    setPhase(s.phase || 'idle');
    setDigest(s.digest || null); setInstalled(s.installed || null);
    setPersona(s.persona || ''); setTraits(s.traits || []); setGoals(s.goals || []);
    setExtensions(s.extensions || []); setNeeds(s.needs || []);
  }, [typeFilter]);

  /** 按本机真实纳管状态校正推荐卡片的「已纳管」标记,并对齐名称/说明 */
  const reconcileAdopted = useCallback(async () => {
    const rt = normType(typeFilter);
    const cur = loadLast(typeFilter);
    const list = (cur && cur.items) || items;
    if (!list || !list.length) return;
    const { keys: managedKeys, byKey } = await fetchManagedIndex(rt);
    const next = applyManagedAlign(list, managedKeys, byKey, rt);
    if (next !== list) {
      setItems(next);
      saveLast(typeFilter, next);
    }
    // 清掉已删除资源对应的 installing=done
    setInstalling((prev) => {
      let dirty = false;
      const n = { ...prev };
      for (const rec of next) {
        const k = recKey(rec);
        if (k && !rec.adopted && n[k] === 'done') {
          delete n[k];
          dirty = true;
        }
      }
      return dirty ? n : prev;
    });
  }, [typeFilter, items]);

  useEffect(() => {
    reconcileAdopted();
  }, [typeFilter]); // eslint-disable-line react-hooks/exhaustive-deps -- 切类型/挂载时对账

  useEffect(() => {
    const onRemoved = () => { reconcileAdopted(); };
    const onVis = () => {
      if (document.visibilityState === 'visible') reconcileAdopted();
    };
    window.addEventListener('tokenbank:resource-removed', onRemoved);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('tokenbank:resource-removed', onRemoved);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [reconcileAdopted]);

  const reusePortrait = () => {
    const portrait = loadPortrait();
    if (!portrait) return;
    const applied = applyPortraitToState(portrait, rtype);
    setDigest(applied.digest);
    setInstalled(applied.installed);
    setPersona(applied.persona);
    setTraits(applied.traits);
    setGoals(applied.goals);
    setExtensions(applied.extensions);
    setNeeds(applied.needs);
    setPhase('review');
    setRun(rtype, {
      phase: 'review',
      digest: applied.digest,
      installed: applied.installed,
      persona: applied.persona,
      traits: applied.traits,
      goals: applied.goals,
      extensions: applied.extensions,
      needs: applied.needs,
      taskId: null,
      job: null,
    });
    setMsg(t('resources.reco.reusedPortrait'));
  };

  /** 把内置智能体切到指定 runtime：确保投射 + 写入 runtime_agent */
  const applyBuiltinRuntime = useCallback(async (resource, agentId) => {
    if (!resource?.id || !MINE_RUNTIME_IDS.has(agentId)) return resource;
    let working = resource;
    const already = (resource.projections || []).some((p) => p?.agentId === agentId);
    let currentRt = '';
    try {
      currentRt = String(JSON.parse(String(resource.content || '').trim() || '{}').runtime_agent || '');
    } catch { /* ignore */ }
    // 已投射且 runtime_agent 已对齐 → 无需再写
    if (already && currentRt === agentId) return resource;

    if (!already) {
      const proj = await window.electronAPI.resource.project({
        resourceId: resource.id,
        agentIds: [agentId],
        force: true,
      });
      if (!proj || proj.success === false) {
        throw new Error((proj && proj.error) || t('resources.reco.runtimeSwitchFailed'));
      }
      if (proj.resource) working = proj.resource;
    }
    // 即便已投射，也要写 runtime_agent，否则多投射时仍沿用旧配置
    const saved = await window.electronAPI.resource.saveResource({
      id: working.id,
      type: 'assistant',
      name: working.name,
      display_name: working.display_name || working.name,
      description: working.description || '',
      content: contentWithRuntime(working.content, agentId),
      metadata: working.metadata || {},
      source: working.source,
    });
    if (!saved || !saved.success || !saved.resource) {
      throw new Error((saved && saved.error) || t('resources.reco.runtimeSwitchFailed'));
    }
    return saved.resource;
  }, [t]);

  /** 画像 + 发现两个内置智能体同步到同一 runtime */
  const applyBothRuntimes = useCallback(async (portrait, finder, agentId) => {
    const nextPortrait = portrait ? await applyBuiltinRuntime(portrait, agentId) : portrait;
    const nextFinder = finder ? await applyBuiltinRuntime(finder, agentId) : finder;
    return { portrait: nextPortrait, finder: nextFinder };
  }, [applyBuiltinRuntime]);

  const checkReady = useCallback(async () => {
    try {
      // 内置画像分析 / 资产发现：后端自动纳管并尽量投射
      if (window.electronAPI?.resource?.ensureBuiltinAssistants) {
        await window.electronAPI.resource.ensureBuiltinAssistants();
      }
      // 本机已纳管的可挖掘 runtime
      let mineRuntimes = [];
      try {
        const agentRes = await window.electronAPI.resource.listAgentTargets();
        mineRuntimes = ((agentRes && agentRes.agents) || [])
          .filter((a) => a?.id && MINE_RUNTIME_IDS.has(a.id))
          .map((a) => ({ id: a.id, label: a.label || a.id }));
      } catch { /* 列表失败时按无 runtime 处理 */ }
      setRuntimes(mineRuntimes);
      if (!mineRuntimes.length) {
        setSelectedRuntime('');
        return setReady({ loading: false, step: 'needAgent' });
      }
      const pref = readRuntimePref();
      const managedIds = mineRuntimes.map((r) => r.id);

      const res = await window.electronAPI.resource.listResources({ type: 'assistant' });
      const list = (res && res.resources) || [];
      let portrait = list.find((r) => r.name === PORTRAIT_NAME);
      let finder = list.find((r) => r.name === FINDER_NAME);
      // 缺任一内置智能体都无法完整跑通画像→发现
      if (!portrait || !finder) return setReady({ loading: false, step: 'needAgent' });

      const projectedMine = [...(portrait.projections || []), ...(finder.projections || [])]
        .map((p) => p?.agentId)
        .filter((id) => id && MINE_RUNTIME_IDS.has(id) && managedIds.includes(id));
      const pick = managedIds.includes(pref) ? pref
        : (projectedMine[0] || managedIds[0]);
      setSelectedRuntime(pick);
      saveRuntimePref(pick);

      try {
        ({ portrait, finder } = await applyBothRuntimes(portrait, finder, pick));
      } catch (e) {
        if (!projectedMine.length) {
          setErr(e.message || String(e));
          return setReady({ loading: false, step: 'needAgent', portrait, finder });
        }
      }
      return setReady({ loading: false, step: 'ready', portrait, finder });
    } catch (e) { setReady({ loading: false, step: 'error' }); setErr(e.message || String(e)); }
  }, [applyBothRuntimes]);
  useEffect(() => { checkReady(); }, [checkReady]);

  /** 用户手动指定 runtime */
  const changeRuntime = async (agentId) => {
    if (!MINE_RUNTIME_IDS.has(agentId) || agentId === selectedRuntime || runtimeBusy) return;
    setErr('');
    setRuntimeBusy(true);
    setSelectedRuntime(agentId);
    saveRuntimePref(agentId);
    try {
      if (!ready.portrait?.id || !ready.finder?.id) throw new Error(t('resources.reco.needAgent'));
      const next = await applyBothRuntimes(ready.portrait, ready.finder, agentId);
      setReady((r) => ({ ...r, step: 'ready', ...next }));
      setMsg(t('resources.reco.runtimeSwitched', { agent: nextLabel(agentId) }));
    } catch (e) {
      setErr(e.message || String(e));
      await checkReady();
    } finally {
      setRuntimeBusy(false);
    }
  };

  function nextLabel(id) {
    return (runtimes.find((r) => r.id === id) || {}).label || id;
  }

  // 事件通道(尽力而为:某些运行时的 step 事件 taskId 与任务不一致,故仅作快速触发)
  useEffect(() => {
    const api = window.electronAPI && window.electronAPI.agent;
    if (!api || !api.onCompleted) return undefined;
    const offDone = api.onCompleted((data) => {
      const text = (data && data.result && (data.result.summary || data.result.text)) || '';
      handleTerminalRef.current(data && data.taskId, text, null);
    });
    const offFail = api.onFailed((data) => {
      const raw = (data && (data.error
        || (data.result && (data.result.error || data.result.stderr || data.result.summary)))) || '';
      handleTerminalRef.current(data && data.taskId, '', raw || 'failed');
    });
    return () => { try { offDone(); offFail(); } catch { /* */ } };
  }, []);

  // 计时:从任务真实开始时间算,切 tab 回来仍准确
  useEffect(() => {
    if (phase !== 'discovering' && phase !== 'analyzing') return undefined;
    const tick = () => {
      const st = (getRun(rtype) || {}).startedAt || Date.now();
      setElapsed(Math.max(0, Math.floor((Date.now() - st) / 1000)));
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [phase, rtype]);

  // 轮询任务状态:拿真实 agent 进度(步骤/活动),并兜底终态(事件漏配时也能收口)
  // 只要有运行中的 taskId 就轮询(含安装任务),不依赖 phase,避免事件不可靠导致收不了口
  useEffect(() => {
    if (!taskId) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await window.electronAPI.agent.getTaskStatus(taskId);
        const task = res && res.status;
        if (!task || stopped) return;
        const rows = task.steps || [];
        setSteps(rows.length);
        const labels = rows.map((r) => stepRowLabel(r, t)).filter(Boolean);
        if (labels.length) { setActivity(labels.slice(-4)); setStatus(labels[labels.length - 1]); }
        if (task.status === 'completed') {
          const full = [(task.result && task.result.summary) || '', stepsToText(rows)].filter(Boolean).join('\n');
          handleTerminalRef.current(taskId, full, null);
        } else if (task.status === 'failed') {
          handleTerminalRef.current(taskId, '', task.error || 'failed');
        } else if (task.status === 'cancelled') {
          handleTerminalRef.current(taskId, '', 'cancelled');
        }
      } catch { /* 轮询失败忽略,下次再试 */ }
    };
    poll();
    const iv = setInterval(poll, 2500);
    return () => { stopped = true; clearInterval(iv); };
  }, [phase, taskId, t]);

  const runAgent = async (prompt, job, nextPhase) => {
    setActivity([]); setSteps(0);
    // 画像分析 → resource-portrait；资源发现 → resource-finder（职责分离）
    const agentName = job?.type === 'analyze'
      ? ((ready.portrait && ready.portrait.name) || PORTRAIT_NAME)
      : ((ready.finder && ready.finder.name) || FINDER_NAME);
    const sessionKey = job?.type === 'analyze'
      ? 'personalized-portrait'
      : 'personalized-recommend';
    const exec = await window.electronAPI.agent.execute({
      agentId: agentName,
      prompt, options: { mode: 'direct', sessionKey },
    });
    if (!exec || !exec.success || !exec.taskId) throw new Error((exec && exec.error) || 'agent start failed');
    PENDING.set(exec.taskId, job);
    setTaskId(exec.taskId);
    // 记进模块级存储:切 tab / 切页面回来后据此恢复并续上轮询
    if (nextPhase) setRun(rtype, { phase: nextPhase, taskId: exec.taskId, job, startedAt: Date.now() });
  };

  const stopRun = async () => {
    const tid = taskId;
    if (!tid) return;
    try { await window.electronAPI.agent.cancel(tid); } catch { /* ignore */ }
    PENDING.delete(tid);
    setTaskId(null);
    const next = phase === 'analyzing' ? 'review' : 'done';
    setPhase(next);
    if (next === 'review') setRun(rtype, { phase: 'review', taskId: null, job: null });
    else clearRun(rtype);
    setMsg(t('resources.reco.stopped'));
  };

  const retryBuiltinSetup = async () => {
    setErr(''); setMsg(t('resources.reco.enabling'));
    setReady((s) => ({ ...s, loading: true }));
    try {
      await checkReady();
      setMsg('');
    } catch (e) { setErr(e.message || String(e)); setMsg(''); }
  };

  // 第一步:采对话素材 → 推测 persona + 目标 + 资源需求
  const mine = async () => {
    // 无可用 runtime 时直接拦住，避免进入分析再失败
    if (ready.step !== 'ready') {
      setErr(t('resources.reco.needAgent'));
      setPhase('idle');
      return;
    }
    setErr(''); setMsg(''); setPersona(''); setTraits([]); setGoals([]); setExtensions([]); setNeeds([]); setPhase('mining');
    try {
      // 挖掘前再确认画像/发现智能体都落到所选 runtime
      if (selectedRuntime && ready.portrait && ready.finder) {
        const synced = await applyBothRuntimes(ready.portrait, ready.finder, selectedRuntime);
        setReady((r) => ({ ...r, ...synced }));
      }
      const res = await window.electronAPI.resource.mineDemand({});
      if (!res || !res.success) throw new Error((res && res.error) || 'mine failed');
      setDigest(res.digest); setInstalled(res.installed);
      if (!res.sessions) { setPhase('done'); clearRun(rtype); return; }
      setStatus(''); setSteps(0); setPhase('analyzing');
      setRun(rtype, { digest: res.digest, installed: res.installed, persona: '', traits: [], goals: [], extensions: [], needs: [] });
      await runAgent(digestToAnalyzePrompt(res.digest, res.installed, rtype, typeLabel, langLine), { type: 'analyze' }, 'analyzing');
    } catch (e) { setErr(e.message || String(e)); setPhase('done'); clearRun(rtype); }
  };

  // 第二步:据身份+风格+能力域+延伸发现资源
  const discover = async () => {
    setErr(''); setMsg('');
    const exclude = (items || []).map(recKey).filter(Boolean);
    setStatus(''); setSteps(0); setPhase('discovering');
    // 把本类型 needs 写回共享画像,换资产时仍可复用人格层
    savePortrait({
      digest, installed, persona, traits, goals, extensions,
      needsByType: { [rtype]: needs },
    });
    setRun(rtype, { supplement, persona, traits, goals, extensions, needs, digest, installed });
    try {
      if (selectedRuntime && ready.portrait && ready.finder) {
        const synced = await applyBothRuntimes(ready.portrait, ready.finder, selectedRuntime);
        setReady((r) => ({ ...r, ...synced }));
      }
      // 拉取社区目录,供智能体选题,并在结果阶段对账真实性
      let pool = { assistants: [], skills: [] };
      if (rtype === 'assistant') {
        const [aRes, sRes] = await Promise.all([
          window.electronAPI.resource.listCatalog({ type: 'assistant' }),
          window.electronAPI.resource.listCatalog({ type: 'skill' }),
        ]);
        const assistants = ((aRes && aRes.items) || []).map((a) => ({
          catalogId: a.catalogId,
          name: a.name,
          display_name: a.display_name || a.name,
          description: a.description || '',
          content: a.content || '',
          metadata: a.metadata || {},
          skills: skillsFromCatalogContent(a.content),
        }));
        const skills = ((sRes && sRes.items) || []).map((s) => ({
          catalogId: s.catalogId, name: s.name, description: s.description || '',
        }));
        pool = { assistants, skills };
        setCatalogPool(pool);
      }
      await runAgent(
        discoverPrompt(persona, traits, goals, extensions, needs, supplement, exclude, rtype, typeLabel, langLine, pool),
        { type: 'search', exclude, catalogPool: pool },
        'discovering',
      );
    } catch (e) { setErr(e.message || String(e)); setPhase('done'); clearRun(rtype); }
  };

  const install = async (rec) => {
    const key = recKey(rec);
    setErr(''); setMsg(''); setInstalling((s) => ({ ...s, [key]: 'busy' }));
    /** 纳管成功:本地标记已纳管,并用落库资源对齐名称/说明/正文 */
    const markDone = async (okMsg, resource) => {
      setInstalling((s) => ({ ...s, [key]: 'done' }));
      setItems((prev) => {
        const next = (prev || []).map((r) => {
          if (recKey(r) !== key) return r;
          if (!resource) return { ...r, adopted: true };
          const alignedName = resourceDisplayName(rtype, resource) || r.slug || r.name;
          return {
            ...r,
            adopted: true,
            name: rtype === 'skill' ? alignedName : (resource.display_name || resource.name || r.name),
            slug: rtype === 'skill' ? alignedName : (r.slug || alignedName),
            display_name: resource.display_name || resource.name || r.display_name,
            description: resourceDescription(resource) || resourceDescription(r),
            content: String(resource.content || '').trim() || r.content || r.soul || '',
            resourceId: resource.id || r.resourceId,
          };
        });
        saveLast(typeFilter, next);
        return next;
      });
      // 启用包：默认投射到主公 + 复制点将口令
      let finalMsg = okMsg || '';
      if (resource?.id) {
        try {
          const lang = (typeof navigator !== 'undefined' && String(navigator.language || '').startsWith('zh'))
            ? 'zh' : 'en';
          const pack = await completeEnablePackage(resource, { lang });
          if (pack.invokeText) await copyText(pack.invokeText);
          const name = resource.display_name || resource.name || key;
          finalMsg = pack.projected
            ? t('resources.enabledWithInvoke', { name, invoke: pack.invokeText })
            : t('resources.enabledNeedProject', { name, invoke: pack.invokeText });
        } catch { /* 保留 okMsg */ }
      }
      if (finalMsg) setMsg(finalMsg);
    };
    /** 写入本机列表并复核;失败则不算安装成功 */
    const commitAdopted = async (resource, meta = {}) => {
      if (!resource || !resource.id) throw new Error(t('resources.reco.adoptNoResource'));
      const checkType = resource.type || rtype;
      const check = await window.electronAPI.resource.listResources({ type: checkType });
      const list = (check && check.resources) || [];
      const found = list.some((r) => r.id === resource.id || r.name === resource.name);
      if (!found) throw new Error(t('resources.reco.adoptNotInList', { name: resource.display_name || resource.name || key }));
      if (typeof onAdopted === 'function') {
        onAdopted(resource, meta);
      } else if (typeof onRefresh === 'function') {
        try { await onRefresh(); } catch { /* ignore */ }
      }
      return resource;
    };
    try {
      if (rtype === 'skill') {
        // 主进程直接 skillhub 装到 ~/.agents/skills 并同步纳管(不信任智能体口头「装好了」)
        const slug = String(rec.slug || rec.name || '').trim();
        if (!slug) throw new Error('missing slug');
        const res = await window.electronAPI.resource.installSkillhub({
          slug,
          description: rec.description || '',
        });
        if (!res || !res.success) throw new Error((res && res.error) || 'install skill failed');
        await commitAdopted(res.resource, { slug });
        await markDone(t('resources.reco.installedOk', { name: slug }), res.resource);
      } else if (rtype === 'assistant') {
        // 目录项优先;否则按自建 soul + 真实技能纳管
        let catalogId = rec.catalogId;
        if (!catalogId && rec.source !== 'composed') {
          const cat = await window.electronAPI.resource.listCatalog({ type: 'assistant' });
          const hit = ((cat && cat.items) || []).find((a) => a.name === rec.slug || a.name === rec.name
            || a.display_name === rec.name || a.catalogId === rec.slug);
          if (hit) catalogId = hit.catalogId;
        }
        if (catalogId) {
          const res = await window.electronAPI.resource.installCatalog({ catalogId });
          if (!res || !res.success) throw new Error((res && res.error) || 'install catalog failed');
          await commitAdopted(res.resource, {
            catalogId,
            deps: res.installedDependencies || [],
          });
          const depN = (res.installedDependencies && res.installedDependencies.length) || 0;
          await markDone(depN
            ? t('resources.reco.installedWithSkills', { name: rec.name || key, n: depN })
            : t('resources.reco.installedOk', { name: rec.name || key }), res.resource);
        } else {
          // 自建智能体:落库 soul + 真实 skills,级联装目录技能,其余走 skillhub
          const soul = String(rec.soul || rec.content || '').trim();
          if (soul.length < 40) throw new Error(t('resources.reco.needSoul'));
          const skillRes = await window.electronAPI.resource.listCatalog({ type: 'skill' });
          const catalogSkillNames = new Set(((skillRes && skillRes.items) || []).map((s) => s.name));
          const skills = filterRealSkills(rec.skills, catalogSkillNames);
          if (!skills.length) throw new Error(t('resources.reco.needRealSkills'));
          const idName = slugifyAssistantId(rec.slug || rec.name || key);
          const content = JSON.stringify({
            soul,
            skills,
            prompts: Array.isArray(rec.prompts) ? rec.prompts.filter(Boolean).map(String) : [],
            parameters: { temperature: 0.3 },
          }, null, 2);
          const res = await window.electronAPI.resource.saveResource({
            type: 'assistant',
            name: idName,
            display_name: rec.name || idName,
            description: rec.description || '',
            content,
            metadata: {
              tags: [rec.category].filter(Boolean),
              source: 'composed',
              composed: true,
            },
          });
          if (!res || !res.success) throw new Error((res && res.error) || 'save failed');
          // 目录外技能用 skillhub 安装
          const hubSkills = skills.filter((s) => !catalogSkillNames.has(s));
          let hubOk = 0;
          if (hubSkills.length) {
            const hubRes = await window.electronAPI.resource.installSkillhub({ slugs: hubSkills });
            hubOk = (hubRes && hubRes.installed) || 0;
            const fail = (hubRes && hubRes.results || []).filter((r) => !r.success);
            if (!hubOk && fail.length) {
              throw new Error(fail[0].error || 'companion skills install failed');
            }
            if (fail.length) {
              setErr(t('resources.reco.partialSkills', { detail: fail.map((f) => f.slug).join(', ') }));
            }
          }
          await commitAdopted(res.resource, { composed: true });
          const depN = ((res.installedDependencies && res.installedDependencies.length) || 0) + hubOk
            || skills.length;
          await markDone(t('resources.reco.installedWithSkills', { name: rec.name || key, n: depN }), res.resource);
        }
      } else {
        // 提示词:saveResource 落库
        const content = rec.content || rec.description || '';
        if (!content) throw new Error('missing content');
        const res = await window.electronAPI.resource.saveResource({
          type: rtype, name: rec.slug || rec.name || key, display_name: rec.name || key,
          description: rec.description || '', content,
          metadata: { tags: [rec.category].filter(Boolean), source: rec.source || 'discovery' },
        });
        if (!res || !res.success) throw new Error((res && res.error) || 'save failed');
        await commitAdopted(res.resource, {});
        await markDone(t('resources.reco.installedOk', { name: rec.name || key }), res.resource);
      }
    } catch (e) { setErr(e.message || String(e)); setInstalling((s) => ({ ...s, [key]: undefined })); }
  };

  if (ready.loading) return <p className="text-xs text-zinc-400 py-6 text-center">{t('resources.reco.preparing')}</p>;

  const sharedPortrait = loadPortrait();
  const hasSharedPortrait = !!(sharedPortrait && (sharedPortrait.persona || (sharedPortrait.goals && sharedPortrait.goals.length)));
  // 分享用快照:审阅中优先当前态,否则用共享画像
  const sharePortrait = (persona || (goals && goals.length))
    ? {
      persona,
      traits,
      goals,
      extensions,
      needs,
      digest: digest || sharedPortrait?.digest || null,
      // 海报披露已装资源体量
      installed: installed || sharedPortrait?.installed || null,
    }
    : (sharedPortrait || null);
  const canShare = !!(sharePortrait && (sharePortrait.persona || (sharePortrait.goals && sharePortrait.goals.length)));
  const busy = phase === 'mining' || phase === 'analyzing' || phase === 'discovering';
  const mineLabel = phase === 'mining' ? t('resources.reco.collecting')
    : phase === 'analyzing' ? t('resources.reco.analyzing')
      : phase === 'discovering' ? t('resources.reco.discovering')
        : (hasSharedPortrait || (items && items.length) ? t('resources.reco.remine') : t('resources.reco.mine', { type: typeLabel }));
  const runtimeAgent = selectedRuntime
    || ((ready.portrait && ready.portrait.projections) || (ready.finder && ready.finder.projections) || [])
      .map((p) => p.agentId)
      .find((id) => MINE_RUNTIME_IDS.has(id))
    || '';
  const runtimeLabel = (runtimes.find((r) => r.id === runtimeAgent) || {}).label || runtimeAgent;
  const isPortraitPanel = panel === 'portrait';
  const isRecommendPanel = panel !== 'portrait';

  /** 运行时选择条：有 1+ 可选时展示 */
  function renderRuntimePicker({ compact = false } = {}) {
    if (ready.step !== 'ready' || runtimes.length === 0) return null;
    return (
      <label className={`inline-flex items-center gap-1.5 ${compact ? 'text-[10px]' : 'text-xs'} text-zinc-500`}>
        <span className="shrink-0">{t('resources.reco.runtimeLabel')}</span>
        <select
          value={selectedRuntime || ''}
          disabled={busy || runtimeBusy || runtimes.length < 1}
          onChange={(e) => changeRuntime(e.target.value)}
          className="max-w-[11rem] truncate rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-zinc-700 dark:text-zinc-200 disabled:opacity-50"
          title={t('resources.reco.runtimeHint')}
        >
          {runtimes.map((r) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </select>
      </label>
    );
  }

  /** 删除本机画像（及基于画像的推荐缓存），可重新挖掘 */
  const deletePortrait = () => {
    if (busy) return;
    if (!window.confirm(t('resources.reco.deleteConfirm'))) return;
    clearPortrait();
    setDigest(null);
    setInstalled(null);
    setPersona('');
    setTraits([]);
    setGoals([]);
    setExtensions([]);
    setNeeds([]);
    setSupplement('');
    setItems(null);
    setSavedAt(null);
    setInstalling({});
    setExpandedKey(null);
    setShareOpen(false);
    setPhase('idle');
    setTaskId(null);
    setActivity([]);
    setSteps(0);
    setStatus('');
    setMsg(t('resources.reco.deleteOk'));
    setErr('');
    try { if (typeof onItemsChange === 'function') onItemsChange(); } catch { /* ignore */ }
  };

  /** 画像页审阅完成：只落盘画像，不进入资源发现 */
  const finishPortrait = () => {
    savePortrait({
      persona, traits, goals, extensions,
      needsByType: { [rtype]: needs },
      digest, installed,
    });
    setPhase('idle');
    setRun(rtype, { phase: 'idle', taskId: null, job: null });
    setMsg(t('resources.reco.portraitSaved'));
  };

  return (
    <div className="space-y-3">
      {ready.step === 'needAgent' && (
        <div className={`${LIB_LIST_CLS} p-4 text-xs space-y-2`}>
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" aria-hidden />
            {t('resources.reco.needAgent')}
          </p>
          <p className="text-zinc-500 dark:text-zinc-400">{t('resources.reco.needAgentHint')}</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => (onNeedAgent ? onNeedAgent() : (onNeedProject ? onNeedProject() : null))}
              className={ASSET_BTN_PRIMARY}
            >
              {t('resources.skillInstall.goManageAgent')}
            </button>
            <button
              type="button"
              onClick={retryBuiltinSetup}
              className={ASSET_BTN_GHOST}
            >
              {t('resources.skillInstall.retrySetup')}
            </button>
          </div>
        </div>
      )}

      {ready.step === 'ready' && phase !== 'review' && phase !== 'analyzing' && phase !== 'discovering' && (() => {
        const showPortrait = hasSharedPortrait && phase !== 'mining';
        const sessions = showPortrait
          ? sharedPortrait.digest?.sessions
          : digest?.sessions;
        return (
          <div className={`${LIB_LIST_CLS} p-4`}>
            <div className="flex flex-wrap items-start gap-3">
              <span className="w-9 h-9 shrink-0 rounded-xl bg-violet-50 dark:bg-violet-950/40 text-violet-600 dark:text-violet-300 flex items-center justify-center text-base" aria-hidden>✦</span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">
                  {showPortrait ? t('resources.reco.portraitTitle') : t('resources.reco.heroTitle')}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-2">
                  {showPortrait ? (sharedPortrait.persona || t('resources.reco.portraitReusable')) : t('resources.reco.heroDesc')}
                </p>
                {sessions != null && (
                  <p className="text-[10px] text-zinc-400 mt-1">{t('resources.reco.sessions', { n: sessions })}</p>
                )}
              </div>
              {runtimes.length > 0 && (
                <div className="flex items-center gap-2 shrink-0">
                  {renderRuntimePicker({ compact: true })}
                  {runtimeBusy && <span className="text-[10px] text-zinc-400">{t('resources.reco.runtimeSwitching')}</span>}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-3 pl-12">
              {showPortrait ? (
                <>
                  {isRecommendPanel && (
                    <button type="button" onClick={reusePortrait} disabled={busy || runtimeBusy} className={ASSET_BTN_PRIMARY}>
                      {t('resources.reco.reusePortrait', { type: typeLabel })}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={isPortraitPanel ? mine : (onGoPortrait || mine)}
                    disabled={busy || runtimeBusy}
                    className={ASSET_BTN_GHOST}
                  >
                    {isPortraitPanel
                      ? t('resources.reco.remine')
                      : (onGoPortrait ? t('resources.reco.goPortraitRemine') : t('resources.reco.remine'))}
                  </button>
                  {canShare && (
                    <button type="button" onClick={() => setShareOpen(true)} disabled={busy} className={ASSET_BTN_GHOST}>
                      {t('resources.reco.share')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={deletePortrait}
                    disabled={busy || runtimeBusy}
                    className="ml-auto text-xs px-3 py-1.5 rounded-xl text-zinc-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-45"
                  >
                    {t('resources.reco.delete')}
                  </button>
                </>
              ) : isPortraitPanel || !onGoPortrait ? (
                <button type="button" onClick={mine} disabled={busy || runtimeBusy} className={ASSET_BTN_PRIMARY}>{mineLabel}</button>
              ) : (
                <button type="button" onClick={onGoPortrait} className={ASSET_BTN_PRIMARY}>
                  {t('resources.reco.goPortraitMine')}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
      {err && <p className="text-xs text-red-500">{err}</p>}

      {/* 分析中 / 发现中：画像页只跑分析；推荐页可跑发现 */}
      {((phase === 'analyzing') || (isRecommendPanel && phase === 'discovering')) && (
        <div className="rounded-lg border border-violet-200 dark:border-violet-800/50 bg-violet-50/60 dark:bg-violet-900/15 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2.5 w-2.5" aria-hidden>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-violet-500" />
            </span>
            <span className="text-xs text-violet-700 dark:text-violet-200 truncate">
              {status || (phase === 'analyzing' ? t('resources.reco.analyzing') : t('resources.reco.discovering'))}
            </span>
            <span className="ml-auto text-[10px] text-violet-400 whitespace-nowrap tabular-nums">{elapsed}s</span>
          </div>
          <div className="h-1 rounded-full bg-violet-100 dark:bg-violet-900/40 overflow-hidden">
            <div className="h-full w-1/3 rounded-full bg-violet-500/80 tb-pr-scan" />
          </div>

          {/* 分析阶段先亮出依据,让用户知道在看什么 */}
          {phase === 'analyzing' && digest && (
            <EvidencePanel digest={digest} t={t} />
          )}

          <div className="rounded-md bg-white/70 dark:bg-zinc-900/50 border border-violet-100 dark:border-violet-900/40 p-2 space-y-1">
            <div className="flex items-center justify-between text-[10px] text-violet-500/90">
              <span>{t('resources.reco.runningOn', {
                agent: runtimeLabel || runtimeAgent
                  || (phase === 'analyzing' ? PORTRAIT_NAME : FINDER_NAME),
              })}</span>
              <span>{steps > 0 ? t('resources.reco.stepsN', { n: steps }) : t('resources.reco.starting')}</span>
            </div>
            {activity.length > 0 ? (
              <ul className="space-y-0.5">
                {activity.map((a, i) => (
                  <li key={i} className={`text-[10px] truncate ${i === activity.length - 1 ? 'text-violet-700 dark:text-violet-200' : 'text-zinc-400'}`}>
                    <span className="opacity-50 mr-1">›</span>{a}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[10px] text-zinc-400">{elapsed < 15 ? t('resources.reco.bootingRuntime') : t('resources.reco.noOutputYet')}</p>
            )}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-[10px] text-violet-400/80">{phase === 'analyzing' ? t('resources.reco.analyzingHint') : t('resources.reco.discoveringHint')}</p>
            <button type="button" onClick={stopRun} className="text-[10px] text-zinc-400 hover:text-red-500 shrink-0">{t('resources.reco.stop')}</button>
          </div>
          <style>{'@keyframes pr-scan{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}.tb-pr-scan{animation:pr-scan 1.4s var(--ease-in-out,ease-in-out) infinite}@media (prefers-reduced-motion:reduce){.tb-pr-scan{animation:none!important}}'}</style>
        </div>
      )}

      {/* 审阅:依据 → 分析结论 → 补充发现 */}
      {phase === 'review' && (
        <div className="tb-soft-card rounded-lg p-3 space-y-3">
          {/* 1) 依据：分析了谁、看到了什么 */}
          {digest && <EvidencePanel digest={digest} t={t} />}

          {/* 2) 结论：图文可视化画像(非纯文字堆砌) */}
          <div className="border-t border-zinc-100 dark:border-zinc-800 pt-3">
            <PortraitVisualBoard
              persona={persona}
              traits={traits}
              goals={goals}
              extensions={extensions}
              needs={needs}
              digest={digest}
              t={t}
              typeLabel={typeLabel}
              canShare={canShare}
              onShare={() => setShareOpen(true)}
            />
          </div>

          {/* 3) 资源方向 + 补充 */}
          <div className="border-t border-zinc-100 dark:border-zinc-800 pt-3 space-y-2">
            {needs.length > 0 ? (
              <>
                <p className="text-xs text-zinc-700 dark:text-zinc-200">{t('resources.reco.needsTitle', { type: typeLabel })}</p>
                <div className="flex flex-wrap gap-1.5">
                  {needs.map((n, i) => (
                    <span key={i} className="text-[11px] px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-300">
                      {n.text}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('resources.reco.noNeeds', { type: typeLabel })}</p>
            )}
            {isRecommendPanel && (
              <textarea value={supplement} onChange={(e) => { setSupplement(e.target.value); setRun(rtype, { supplement: e.target.value }); }} rows={2}
                placeholder={t('resources.reco.supplement', { type: typeLabel, opt: t('resources.reco.optional') })}
                className="w-full text-xs rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent px-2 py-1.5 resize-none" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {renderRuntimePicker({ compact: true })}
              {isPortraitPanel ? (
                <button type="button" onClick={finishPortrait}
                  className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-xs hover:bg-violet-700">
                  {t('resources.reco.portraitSavedBtn')}
                </button>
              ) : (
                <button type="button" onClick={discover} disabled={runtimeBusy}
                  className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-xs hover:bg-violet-700 disabled:opacity-50">{t('resources.reco.startDiscover')}</button>
              )}
              <button type="button" onClick={() => { setPhase('idle'); clearRun(rtype); }} className="text-xs text-zinc-400 hover:text-zinc-600">{t('resources.reco.cancel')}</button>
            </div>
          </div>
        </div>
      )}

      {/* 画像页：闲时展示已有画像看板 */}
      {isPortraitPanel && hasSharedPortrait && phase === 'idle' && !busy && (
        <div className="tb-soft-card rounded-lg p-3">
          <PortraitVisualBoard
            persona={sharedPortrait.persona}
            traits={sharedPortrait.traits || []}
            goals={sharedPortrait.goals || []}
            extensions={sharedPortrait.extensions || []}
            needs={(sharedPortrait.needsByType && sharedPortrait.needsByType[rtype]) || sharedPortrait.needs || []}
            digest={sharedPortrait.digest}
            t={t}
            typeLabel={typeLabel}
            canShare={canShare}
            onShare={() => setShareOpen(true)}
          />
        </div>
      )}

      {isRecommendPanel && phase === 'done' && digest && digest.sessions === 0 && (
        <p className="text-xs text-zinc-400 py-4 text-center">{t('resources.reco.noSessions')}</p>
      )}

      <PortraitShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        portrait={sharePortrait}
        typeLabel={typeLabel}
        t={t}
      />

      {/* 推荐结果：与资产库同一列表 + 右侧详情 */}
      {isRecommendPanel && items && items.length > 0 && phase !== 'analyzing' && phase !== 'discovering' && (() => {
        const list = visibleItems || items;
        const rows = list.map((rec, idx) => {
          const key = recKey(rec) || `x-${idx}`;
          const st = installing[key] || (rec.adopted ? 'done' : undefined);
          const cardItem = {
            ...rec,
            name: rtype === 'skill' ? (rec.slug || rec.name) : (rec.name || rec.slug),
            display_name: rec.display_name || rec.name,
            description: resourceDescription(rec),
            content: rec.content || rec.soul || '',
            metadata: { icon: rec.icon },
          };
          return { rec, key, selKey: `reco:${key}`, st, cardItem, name: resourceDisplayName(rtype, cardItem) };
        });
        const visual = typeVisual(rtype);
        const actionBtn = (r, block = false) => (
          <button
            type="button"
            onClick={() => install(r.rec)}
            disabled={r.st === 'busy' || r.st === 'done'}
            className={`${r.st === 'done' ? ASSET_BTN_MANAGED : ASSET_BTN_PRIMARY} ${block ? 'w-full' : '!px-3 !py-1 !text-[11px] !rounded-lg'}`}
          >
            {r.st === 'done' ? t('resources.reco.adopted') : r.st === 'busy' ? t('resources.reco.working') : t('resources.reco.adopt')}
          </button>
        );
        const sel = rows.find(r => r.selKey === selectedKey);
        const logo = (r) => (LogoComp
          ? <LogoComp type={rtype} icon={r.rec.icon} name={r.name || r.key} />
          : <AssetLogo type={rtype} icon={r.rec.icon} name={r.name || r.key} />);
        const inspector = sel && (
          <LibraryInspector
            logo={logo(sel)}
            title={sel.name}
            closeLabel={t('resources.collapse')}
            onClose={() => onSelect?.(null)}
            chips={(
              <>
                <span className={`text-[10px] px-1.5 py-px rounded font-medium ${visual.chip}`}>{typeLabel}</span>
                {sel.rec.category && <span className="text-[10px] text-zinc-400">{catLabel(sel.rec.category)}</span>}
              </>
            )}
            desc={resourceDescription(sel.cardItem)}
            stats={sel.rec.downloads ? [[t('resources.reco.downloadsLabel'), sel.rec.downloads]] : null}
            footer={actionBtn(sel, true)}
          >
            {sel.rec.reason && (
              <InspectorSection title={t('resources.reco.reason')}>
                <p className="text-xs leading-relaxed text-violet-700 dark:text-violet-300">{sel.rec.reason}</p>
              </InspectorSection>
            )}
            {rtype === 'assistant' && Array.isArray(sel.rec.skills) && sel.rec.skills.length > 0 && (
              <InspectorSection title={t('resources.reco.skillsLabel')}>
                <div className="flex flex-wrap gap-1.5">
                  {sel.rec.skills.map(sk => (
                    <span key={sk} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300">{sk}</span>
                  ))}
                </div>
                {(sel.rec.source === 'catalog' || sel.rec.source === 'composed') && (
                  <p className="text-[10px] text-zinc-400 mt-2">
                    {sel.rec.source === 'composed' ? t('resources.reco.fromComposedHint') : t('resources.reco.fromCatalogHint')}
                  </p>
                )}
              </InspectorSection>
            )}
            {rtype === 'prompt' && !!sel.rec.source && (
              <InspectorSection title={t('resources.reco.sourceLabel')}>
                <p className="text-[11px] text-zinc-500 break-all">{sel.rec.source}</p>
              </InspectorSection>
            )}
            {resourceIntro(sel.cardItem) ? (
              <InspectorSection title={t('resources.detailIntro')}>
                <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{resourceIntro(sel.cardItem)}</p>
              </InspectorSection>
            ) : null}
            <InspectorSection title={t('resources.preview')}>
              <InspectorPreview text={buildPreviewText(rtype, {
                ...sel.cardItem,
                content: sel.cardItem.content || resourceDescription(sel.cardItem),
              }) || t('resources.emptyDetail')} />
            </InspectorSection>
          </LibraryInspector>
        );
        return (
          <section>
            <LibrarySectionHead
              title={t('resources.reco.listTitle')}
              count={rows.length}
              extra={(
                <>
                  {savedAt && <span>{t('resources.reco.updatedAgo', { ago: fmtAgo(savedAt, t) })}</span>}
                  {hasSharedPortrait && (
                    <button type="button" onClick={reusePortrait} className="text-blue-600 dark:text-blue-400 hover:underline">
                      {t('resources.reco.refresh')}
                    </button>
                  )}
                </>
              )}
            />
            {hasListFilter && rows.length === 0 ? (
              <div className={`${LIB_LIST_CLS} text-center py-8 space-y-2`}>
                <p className="text-xs text-zinc-400">
                  {String(searchQuery || '').trim()
                    ? t('resources.reco.searchFilteredEmpty')
                    : t('resources.emptyTagFiltered')}
                </p>
                <p className="text-[11px] text-zinc-400">
                  {t('resources.reco.purposeFilteredHint', { n: items.length })}
                </p>
              </div>
            ) : (
              <ul className={LIB_LIST_CLS} role="listbox" aria-label={t('resources.reco.listTitle')}>
                {rows.map(r => {
                  const isSel = r.selKey === selectedKey;
                  return (
                    <li
                      key={r.key}
                      role="option"
                      aria-selected={isSel}
                      onClick={() => onSelect?.(isSel ? null : r.selKey)}
                      className={`${libRowCls(isSel)} grid-cols-[minmax(0,1fr)_auto]`}
                    >
                      <LibraryRowTitle
                        logo={logo(r)}
                        name={r.name}
                        sub={r.rec.reason || resourceDescription(r.cardItem)}
                        subClass={r.rec.reason ? 'text-violet-600/90 dark:text-violet-300/90' : undefined}
                        chips={(
                          <>
                            <span className={`shrink-0 text-[10px] px-1.5 py-px rounded font-medium ${visual.chip}`}>{typeLabel}</span>
                            {r.rec.category && <span className="shrink-0 text-[10px] text-zinc-400">{catLabel(r.rec.category)}</span>}
                          </>
                        )}
                      />
                      <div onClick={e => e.stopPropagation()}>{actionBtn(r)}</div>
                    </li>
                  );
                })}
              </ul>
            )}
            {inspector && (inspectorHost ? createPortal(inspector, inspectorHost) : inspector)}
          </section>
        );
      })()}
    </div>
  );
}
