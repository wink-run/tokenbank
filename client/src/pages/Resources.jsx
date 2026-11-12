import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import ServiceIcon from '../components/ServiceIcon';
import {
  FilterMenu, LIFE_DOT,
  LIB_LIST_CLS, libRowCls, LibrarySectionHead, LibraryRowTitle,
  LibraryInspector, InspectorSection, InspectorPreview,
} from '../components/LibraryControls';
import McpProvidersTab from '../components/McpProvidersTab';
import SkillInstallDialog from '../components/SkillInstallDialog';
import AiNeedNotice from '../components/AiNeedNotice';
import DiagnosePanel from '../components/DiagnosePanel';
import { projectWithGuard } from '../lib/project-guard';
import { useAiReadiness } from '../lib/ai-readiness';
import { isWebBridge } from '../api/webBridge';
import {
  ASSET_BTN_GHOST,
  ASSET_BTN_MANAGED,
  ASSET_BTN_PRIMARY,
  AssetLogo,
  AssetMoreMenu,
  buildPreviewText,
  resourceDescription,
  resourceDisplayName,
  resourceIntro,
  shortenHomePath,
  typeVisual,
} from '../components/ResourceAssetCard';
import { useLang } from '../store/lang';
import { getSyncServerBase } from '../config';
import {
  PURPOSE_SLUGS,
  aggregateTagsWithAi,
  classifySkillsPurposeWithAi,
  inferPurposeHeuristic,
  loadAiPurposeMap,
  resolvePurposes,
  tagToPurpose,
} from '../lib/resource-purpose';
import {
  analyzeIdleSkillsWithAi,
  hasStoredPortrait,
  sortIdleByRecommendation,
} from '../lib/idle-skill-ai';
import { classifyLifecycle, isLifecycleExempt } from '../lib/resource-lifecycle';
import { buildInvokeText, copyText, completeEnablePackage } from '../lib/resource-enable';
import { catalogSharerHandle } from '../lib/catalog-sharer';
import { seriesKeyOf, groupBySeries } from '../lib/skill-series';
import {
  formatApiError,
  getCommunityCatalogPricing,
  recommendCommunitySkill,
  settleCommunityCatalogInstall,
} from '../api/client';
import {
  buildAssistantContent,
  generateAssistantFromNl,
  parseAssistantEditorContent,
  slugifyAssistantId,
} from '../lib/assistant-nl-create';

const VIEW_TAB_KEY = 'tokenbank.resources.viewTab';
const TYPE_FILTER_KEY = 'tokenbank.resources.typeFilter';
const SCAN_CUSTOM_DIR_KEY = 'tokenbank.resources.scanCustomDir';
const APP_FILTER_KEY = 'tokenbank.resources.appFilter';
const IDLE_DAYS_KEY = 'tokenbank.resources.idleDays';
const LAYER_FILTER_KEY = 'tokenbank.resources.layerFilter';
// 状态只说三种：在用、没在用（启用了没用过 / 闲置 / 没启用到应用）、有问题（管家体检）
const IDLE_LAYERS = new Set(['pending', 'dormant', 'cold', 'shelf']);
const STATE_DOT = { active: 'bg-emerald-500', idle: 'bg-zinc-400', issue: 'bg-rose-500' };
const LIST_SORT_KEY = 'tokenbank.resources.listSort';
const DEFAULT_IDLE_DAYS = 60;
/** 资产库列表列宽：名称 | 投射到 | 使用 | 状态 | 操作 */
// 名称 | 启用到 | 使用 | 状态（一个词 + 一句原因）| 操作
const LIB_GRID = 'grid-cols-[minmax(0,1fr)_9rem_3.5rem_11rem_8rem]';
const LIB_GRID_MD = 'md:grid-cols-[minmax(0,1fr)_9rem_3.5rem_11rem_8rem]';

const LIST_SORT_OPTIONS = [
  { id: 'smart', labelKey: 'resources.sort.smart' },
  { id: 'time', labelKey: 'resources.sort.time' },
  { id: 'name', labelKey: 'resources.sort.name' },
  { id: 'usage', labelKey: 'resources.sort.usage' },
];

function readIdleDays() {
  try {
    const n = Number(localStorage.getItem(IDLE_DAYS_KEY));
    if (Number.isFinite(n) && n >= 1 && n <= 3650) return Math.floor(n);
  } catch {}
  return DEFAULT_IDLE_DAYS;
}

function saveIdleDays(days) {
  try { localStorage.setItem(IDLE_DAYS_KEY, String(days)); } catch {}
}

// `.agents` / 自定义扫描等是公共 skill 目录，不是可筛选的 Agent 应用
const NON_AGENT_APP_IDS = new Set(['agents-hub', 'tokenbank', 'custom', 'aweskill']);
/** 未落入任何一级用途的筛选项 */
const PURPOSE_OTHER = 'other';

function isAgentAppId(agentId) {
  return !!agentId && !NON_AGENT_APP_IDS.has(agentId);
}

/** 用户添加的扫描目录列表（兼容旧版单字符串） */
function readScanCustomDirs() {
  try {
    const raw = localStorage.getItem(SCAN_CUSTOM_DIR_KEY);
    if (!raw) return [];
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw);
      return Array.isArray(arr)
        ? [...new Set(arr.map(d => String(d || '').trim()).filter(Boolean))]
        : [];
    }
    // 旧版：单个路径字符串
    const one = raw.trim();
    return one ? [one] : [];
  } catch {
    return [];
  }
}

function saveScanCustomDirs(dirs) {
  try {
    const list = [...new Set((dirs || []).map(d => String(d || '').trim()).filter(Boolean))];
    localStorage.setItem(SCAN_CUSTOM_DIR_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}


const TYPE_OPTIONS = [
  { id: '', labelKey: 'resources.type.all' },
  { id: 'prompt', labelKey: 'resources.type.prompt' },
  { id: 'skill', labelKey: 'resources.type.skill' },
  { id: 'assistant', labelKey: 'resources.type.assistant' },
  { id: 'mcp', labelKey: 'resources.type.mcp' },
];

function readViewTab() {
  try {
    const v = localStorage.getItem(VIEW_TAB_KEY);
    // 未选过时先显示「为你推荐」，加载后若本机已有资产再切到「已纳管」；旧 portrait 并入 recommend
    if (v === 'catalog' || v === 'portrait') return 'recommend';
    if (v === 'managed' || v === 'recommend') return v;
    if (v === 'discovered' || v === 'agents') return 'managed';
    return 'recommend';
  } catch { return 'recommend'; }
}

function saveViewTab(tab) {
  try { localStorage.setItem(VIEW_TAB_KEY, tab); } catch {}
}

const DISCOVER_TYPE_KEY = 'tokenbank.resources.discoverType';
const SERIES_OPEN_KEY = 'tokenbank.resources.seriesOpen';
const NUDGE_SNOOZE_KEY = 'tokenbank.resources.nudgeSnooze';
function readJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return v == null ? fallback : v;
  } catch { return fallback; }
}
function writeJson(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}
function readDiscoverType() {
  try {
    const v = localStorage.getItem(DISCOVER_TYPE_KEY) || '';
    return TYPE_OPTIONS.some((o) => o.id === v) ? v : '';
  } catch { return ''; }
}
function saveDiscoverType(type) {
  try { localStorage.setItem(DISCOVER_TYPE_KEY, type || ''); } catch { /* ignore */ }
}

function readTypeFilter() {
  try {
    const v = localStorage.getItem(TYPE_FILTER_KEY);
    // 第一个标签是「全部」，缺省就是它；记住用户上次选择
    if (v === 'prompt' || v === 'skill' || v === 'assistant' || v === 'mcp') return v;
    return '';
  } catch { return ''; }
}

function saveTypeFilter(type) {
  try { localStorage.setItem(TYPE_FILTER_KEY, type || ''); } catch {}
}

function readAppFilter() {
  try { return localStorage.getItem(APP_FILTER_KEY) || ''; } catch { return ''; }
}

function saveAppFilter(agentId) {
  try { localStorage.setItem(APP_FILTER_KEY, agentId || ''); } catch {}
}

function readListSort() {
  try {
    const v = localStorage.getItem(LIST_SORT_KEY);
    if (v === 'smart' || v === 'time' || v === 'name' || v === 'usage') return v;
  } catch { /* ignore */ }
  return 'smart';
}

function saveListSort(sort) {
  try { localStorage.setItem(LIST_SORT_KEY, sort || 'usage'); } catch {}
}

function typeBadge(type, t) {
  const map = {
    prompt: t('resources.type.prompt'),
    skill: t('resources.type.skill'),
    assistant: t('resources.type.assistant'),
  };
  return map[type] || type;
}

/** 内置资产：source / metadata / 固定 catalogId / name */
function isBuiltinResource(item) {
  if (!item) return false;
  if (item.source === 'builtin') return true;
  if (item.metadata?.builtin) return true;
  const url = String(item.source_url || '');
  if (url.startsWith('builtin:')) return true;
  const tags = item.metadata?.tags;
  if (Array.isArray(tags) && tags.includes('builtin')) return true;
  const catalogId = String(item.catalogId || item.catalog_id || '');
  if (
    catalogId === 'resource-finder-assistant'
    || catalogId === 'resource-installer-assistant'
    || catalogId === 'resource-portrait-assistant'
  ) {
    return true;
  }
  // 内置智能体固定名（目录卡可能尚未带 source）
  const name = String(item.name || '');
  return name === 'resource-finder'
    || name === 'resource-installer'
    || name === 'resource-portrait';
}

function sourceLabel(source, t) {
  if (!source || source === 'local') return t('resources.source.local');
  if (source === 'catalog' || String(source).startsWith('catalog')) return t('resources.source.catalog');
  if (source === 'builtin') return t('resources.source.builtin');
  if (String(source).startsWith('agent:')) return t('resources.source.scanned');
  if (source === 'imported') return t('resources.source.imported');
  return source;
}

function resourceKind(item) {
  let kind = String(item?.type || 'skill').trim().toLowerCase();
  if (kind === 'agent') kind = 'assistant';
  return kind;
}

/** 本机资产是否已由用户推送到社区（本地标记，或目录里的用户推荐条目） */
function isPushedToCommunity(item, catalog) {
  if (!item) return false;
  const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  if (meta.community_recommended) return true;
  const ownId = String(meta.community_catalog_id || '').trim();
  const name = String(item.name || '').trim().toLowerCase();
  const type = resourceKind(item);
  return (catalog || []).some((c) => {
    if (resourceKind(c) !== type) return false;
    const cid = String(c.catalogId || c.catalog_id || '').trim();
    const cm = c.metadata && typeof c.metadata === 'object' ? c.metadata : {};
    const isUserRec = !!(cm.user_recommended || cid.startsWith('user-'));
    if (!isUserRec) return false;
    if (ownId && cid && ownId === cid) return true;
    return !!name && String(c.name || '').trim().toLowerCase() === name;
  });
}

/** 提示词模版用途：文本对话 / 图像生成（存 metadata.promptKind） */
function promptKindOf(resource) {
  return resource?.metadata?.promptKind === 'image' ? 'image' : 'text';
}

/** 统一读取资源标签（metadata.tags） */
function resourceTags(item) {
  const raw = item?.metadata?.tags ?? item?.tags;
  if (!Array.isArray(raw)) return [];
  return raw.map(t => String(t || '').trim()).filter(Boolean);
}

/** 标签输入：逗号/空格分隔 → 数组 */
function parseTagsInput(text) {
  return String(text || '')
    .split(/[,，\s]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

const EMPTY_EDITOR = {
  id: '',
  type: 'prompt',
  name: '',
  display_name: '',
  description: '',
  detail: '',
  content: '',
  promptKind: 'text',
  tagsText: '',
  metadata: {},
  // 智能体：自然语言草稿 + 结构化人设/技能（保存时拼成 content JSON）
  nlBrief: '',
  soul: '',
  skills: [],
  prompts: [],
  runtime_agent: '',
  parameters: null,
  assistantExtra: {},
  skillQuery: '',
  promptQuery: '',
  /** 新建智能体两步：brief（先用一句话描述）→ form（确认人设与绑定） */
  asStep: 'brief',
  /** 生成时建议一起纳管的社区技能 [{ catalogId, name, display_name, paid, checked }] */
  suggestSkills: [],
  /** 本机和社区都没有的能力 */
  missingCaps: [],
  installCost: null,
};

/** 是否 Windows 前端环境（路径用反斜杠） */
function isWindowsPathEnv(sample = '') {
  const s = String(sample || '');
  if (s.includes('\\')) return true;
  if (s.includes('/')) return false;
  if (typeof navigator !== 'undefined') {
    return /Win/i.test(navigator.userAgent || '') || /Win/i.test(navigator.platform || '');
  }
  return false;
}

/** 拼本地路径，兼容 Windows `\` 与 POSIX `/` */
function joinFsPath(base, ...segments) {
  const sep = isWindowsPathEnv(base) ? '\\' : '/';
  const parts = [String(base || '').replace(/[/\\]+$/, '')];
  for (const seg of segments) {
    const bit = String(seg || '').replace(/^[/\\]+|[/\\]+$/g, '');
    if (bit) parts.push(bit);
  }
  return parts.filter(Boolean).join(sep);
}

/** 从智能体 content JSON 解析声明绑定的 skill / prompt 名列表 */
function depsFromAssistantContent(content) {
  try {
    const raw = typeof content === 'string' ? content : JSON.stringify(content || '');
    const obj = JSON.parse(raw || '{}');
    const names = (arr) => (Array.isArray(arr) ? arr.map(String).filter(Boolean) : []);
    return { skills: names(obj.skills), prompts: names(obj.prompts) };
  } catch {
    return { skills: [], prompts: [] };
  }
}

/** 智能体绑定的模型（content.model 或 content.parameters.model，与 resource-assistant 一致） */
function assistantModelOf(content) {
  try {
    const obj = typeof content === 'string' ? JSON.parse(content || '{}') : (content || {});
    return String(obj.model || obj.parameters?.model || '').trim();
  } catch {
    return '';
  }
}

/** Skill 权威目录（用户安装位置） */
function getSkillLocation(resource) {
  if (!resource) return null;
  if (resource.authorityPath) return resource.authorityPath;

  const meta = resource.metadata || {};
  let loc = meta.authorityPath || meta.scannedFrom || meta.canonicalPath;
  // 兼容 / 与 \，以及 SKILL.md / skill.md
  if (loc && /[/\\]skill\.md$/i.test(String(loc))) {
    loc = String(loc).replace(/[/\\][^/\\]+$/, '');
  }
  if (loc) return loc;

  const originProj = (resource.projections || []).find(
    p => p.projectionType === 'scan' || p.projectionType === 'origin',
  );
  return originProj?.targetPath || null;
}

/** 路径归一化后比较（判断是否同一权威目录；忽略分隔符与大小写，适配 Windows） */
function sameSkillDir(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/** 该投射是否指向权威源（唯一不可取消） */
function isAuthorityProjection(proj, authorityPath) {
  return sameSkillDir(proj?.targetPath, authorityPath);
}

/**
 * 可取消投射：非权威的软链/副本/其它位置实体均可 ×
 * 权威源仅保留一处，用「卸载」删除；无权威路径时 scan 不拦截（避免死锁）
 */
function canUnprojectProjection(proj, authorityPath) {
  if (!proj || !isAgentAppId(proj.agentId)) return false;
  if (isAuthorityProjection(proj, authorityPath)) return false;
  const t = proj.projectionType;
  if (t === 'symlink' || t === 'copy') return true;
  // 纯 DB 标记型投射（智能体 reference / 提示词 mcp）无权威目录顾虑，始终可取消
  if (t === 'reference' || t === 'mcp') return true;
  if (t === 'scan' || t === 'origin') {
    // 能识别权威源时，其它位置才可取消；识别不了则不挡卸载
    return !!authorityPath;
  }
  return false;
}

/** 闲置清理加载态：扫帚清扫尘埃 + 可选分批进度 */
function CleanupSweepMotion({ label, progress }) {
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.done / progress.total) * 100))
    : null;
  return (
    <div className="py-8 flex flex-col items-center gap-3">
      <div className="tb-cleanup-sweep" aria-hidden="true">
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__dust" />
        <span className="tb-cleanup-sweep__floor" />
        <span className="tb-cleanup-sweep__trail" />
        <span className="tb-cleanup-sweep__broom">
          <span className="tb-cleanup-sweep__handle" />
          <span className="tb-cleanup-sweep__head" />
        </span>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center">{label}</p>
      {pct != null && (
        <div className="w-48 space-y-1">
          <div className="h-1 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
            <div
              className="h-full rounded-full bg-amber-500/80 transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="text-[10px] text-zinc-400 text-center">
            {progress.batches > 0
              ? `${progress.done}/${progress.total} · ${progress.batch}/${progress.batches}`
              : `${progress.done}/${progress.total}`}
          </p>
        </div>
      )}
    </div>
  );
}

// 交付 cid 归一：Codex Desktop 与 CLI 共用 config.toml；Claude Desktop 归 Claude Code
const MCP_DELIVERY_ID_ALIASES = { 'codex-desktop': 'codex', 'claude-desktop': 'claude-code' };

/**
 * prompt / 智能体的投射目标 = 全部已纳管应用（与 Gateway apps:list 同源）。
 * apps:list 已做安装过滤与去重；此处取 hosted（已纳管）行，归一到交付 cid 后再去重。
 */
function deriveManagedAppTargets(apps) {
  const byId = new Map(); // deliveryId -> { label, canonical, order }
  let order = 0;
  for (const a of Array.isArray(apps) ? apps : []) {
    if (!a || a.draft || !a.hosted) continue;
    const raw = a.agent_id || a.preset_id || a.id;
    if (!raw) continue;
    const id = MCP_DELIVERY_ID_ALIASES[raw] || raw;
    const canonical = raw === id; // 非别名行(如 claude-code CLI shim)优先提供展示名
    const label = a.name || a.label || id;
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, { label, canonical, order: order++ });
    } else if (canonical && !prev.canonical) {
      // 别名行(Claude Desktop)先占位 → 被规范行(Claude Code CLI)接管展示名，位置不变
      byId.set(id, { label, canonical: true, order: prev.order });
    }
  }
  return [...byId.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([id, v]) => ({ id, label: v.label }));
}

/** 资产页：Prompt / Skill / Assistant 纳管与投射 */
export default function Resources() {
  const navigate = useNavigate();
  const location = useLocation();
  // keep-alive：切到其它页时本页仍挂载，全局快捷键只在本页可见时生效
  const pageActive = location.pathname === '/resources';
  const { t, lang } = useLang();
  const [viewTab, setViewTab] = useState(readViewTab);
  // 资产列表和发现页各记各的类型，互不影响
  const [typeFilter, setTypeFilter] = useState(() => (readViewTab() === 'recommend' ? readDiscoverType() : readTypeFilter()));
  const [query, setQuery] = useState('');
  // 说一句话就办：搜索框回车时，管理类指令弹确认
  const searchInputRef = useRef(null);
  /** 选中行（右侧详情面板）：资产库 r-/d-，社区 cat:，推荐 reco: */
  const [selectedKey, setSelectedKey] = useState(null);
  /** 发现页详情面板挂载点 */
  const [inspectorHost, setInspectorHost] = useState(null);
  /** MCP 类型：「新建」按钮 → 打开 MCP 组件内的自定义表单 */
  const [mcpCreateSignal, setMcpCreateSignal] = useState(0);
  /** MCP 已纳管数（由 MCP 组件上报；未加载为 null） */
  const [mcpCount, setMcpCount] = useState(null);
  // 未打开 MCP 页签前先取一次数量，平铺页签上直接显示计数（打开后由 MCP 组件接管上报）
  useEffect(() => {
    const api = window.electronAPI?.mcp;
    if (!api?.listServers) return;
    let alive = true;
    api.listServers().then((r) => {
      if (!alive || !Array.isArray(r?.servers)) return;
      const n = r.servers.filter(s => !s.builtin && String(s.name || '') !== 'tokenbank-relay').length;
      setMcpCount(c => (c == null ? n : c));
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  /** 当前可见行 key（键盘 ↑↓ 导航用，渲染时写入） */
  const visibleKeysRef = useRef([]);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [catalog, setCatalog] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [scanStats, setScanStats] = useState(null);
  const [resources, setResources] = useState([]);
  /** 全部智能体（不受 typeFilter 限制），用于标记被绑定为依赖的 Skill */
  const [assistantsForBind, setAssistantsForBind] = useState([]);
  const [agentInstallations, setAgentInstallations] = useState([]);
  const [agents, setAgents] = useState([]);
  const [promptAgents, setPromptAgents] = useState([]);
  const [assistantAgents, setAssistantAgents] = useState([]);
  // prompt / 智能体的投射目标 = 全部已纳管应用（与 Gateway 列表同源，含 Trae / API 应用）
  const [managedAppTargets, setManagedAppTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  /** 社区付费资源单价（登录后拉取；未知为 null） */
  const [communityCost, setCommunityCost] = useState(null);
  /** 付费资源第一次点击后进入「确认扣分」状态的 catalogId */
  const [payConfirmId, setPayConfirmId] = useState('');
  /** 缺依赖的智能体：等用户在详情里确认 */
  const [depsPendingId, setDepsPendingId] = useState('');
  const [msg, setMsg] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [projectMenu, setProjectMenu] = useState(null);
  const [projectSelected, setProjectSelected] = useState([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [skillInstallOpen, setSkillInstallOpen] = useState(false);
  const [editorForm, setEditorForm] = useState(EMPTY_EDITOR);
  /** 提示词子筛选：'' | 'text' | 'image' */
  const [promptKindFilter, setPromptKindFilter] = useState('');
  /** 用途筛选（空 = 全部；值为 purpose slug） */
  const [tagFilter, setTagFilter] = useState('');
  /** Hit-or-Exit 分层：'' | active | pending | dormant | cold | shelf */
  // 智能功能前置条件：模型（网关 model:auto）+ 应用（看护执行引擎的运行应用）
  const ai = useAiReadiness();
  const [aiNoticeHidden, setAiNoticeHidden] = useState(() => (readJson('tokenbank.resources.aiNoticeHide', 0) || 0) > Date.now());
  const hideAiNotice = () => {
    writeJson('tokenbank.resources.aiNoticeHide', Date.now() + 7 * 24 * 60 * 60 * 1000);
    setAiNoticeHidden(true);
  };
  // 技能系列展开状态（默认收起）
  const [openSeries, setOpenSeries] = useState(() => new Set(readJson(SERIES_OPEN_KEY, [])));
  const toggleSeries = useCallback((key) => {
    setOpenSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      writeJson(SERIES_OPEN_KEY, [...next]);
      return next;
    });
  }, []);
  // 投射检查：「暂不处理」后 7 天内不再提示同一批
  const [nudgeSnooze, setNudgeSnooze] = useState(() => readJson(NUDGE_SNOOZE_KEY, {}));
  const [layerFilter, setLayerFilter] = useState(() => {
    try {
      const v = localStorage.getItem(LAYER_FILTER_KEY) || '';
      if (['', 'active', 'idle', 'issue'].includes(v)) return v;
      if (['pending', 'dormant', 'cold', 'shelf'].includes(v)) return 'idle';   // 旧版本存下的细分状态
    } catch { /* ignore */ }
    return '';
  });
  /** AI / 静态聚合后的 tag→用途 映射 */
  const [purposeAiMap, setPurposeAiMap] = useState(loadAiPurposeMap);
  const purposeAiMapRef = useRef(purposeAiMap);
  purposeAiMapRef.current = purposeAiMap;
  /** 个性化推荐结果变更时递增，刷新用途芯片 */
  const [recoPurposeRev, setRecoPurposeRev] = useState(0);
  const [customScanDirs, setCustomScanDirs] = useState(readScanCustomDirs);
  const [defaultScanRoots, setDefaultScanRoots] = useState([]);
  const [scanning, setScanning] = useState(false);
  // 用 ref 做重入守卫，避免 scanning/autoTagging 进 runScan deps → 重建 loadAll → 误触发「搜索中」
  const scanningRef = useRef(false);
  const autoTaggingRef = useRef(false);
  /** 扫描后自动打标进行中（禁用再次扫描） */
  const [autoTagging, setAutoTagging] = useState(false);
  const [scanExpanded, setScanExpanded] = useState(false);
  const [showMissingRoots, setShowMissingRoots] = useState(false);
  const [lastScan, setLastScan] = useState(null);
  const [appFilter, setAppFilter] = useState(readAppFilter);
  const [listSort, setListSort] = useState(readListSort);
  /** Skill 闲置清理 */
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [idleLoading, setIdleLoading] = useState(false);
  const [idleAiLoading, setIdleAiLoading] = useState(false);
  const [idleResult, setIdleResult] = useState(null);
  const [idleSelected, setIdleSelected] = useState([]);
  const [idleDays, setIdleDays] = useState(readIdleDays);
  /** id → { recommend, reason, source } 大模型/启发式分析结果 */
  const [idleAiMap, setIdleAiMap] = useState({});
  const [idleAiMeta, setIdleAiMeta] = useState({ source: '', error: '' });
  /** 分批分析进度：done/total/batch/batches */
  const [idleAiProgress, setIdleAiProgress] = useState(null);
  const idleAiAbortRef = useRef(null);
  const projectMenuRef = useRef(null);
  const bootstrappedRef = useRef(false);
  // 社区目录同步代数：后完成的服务端结果不能被更早的本地读取盖掉
  const catalogFetchGen = useRef(0);
  const catalogAppliedGen = useRef(0);

  // 搜索防抖：避免每键触发全量扫描/加载
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 280);
    return () => clearTimeout(id);
  }, [query]);

  const scanFilters = useCallback(() => ({
    // 搜索在前端过滤；扫盘只跟监控目录有关，避免每次输入都重扫磁盘
    customDirs: customScanDirs,
    includeManaged: true,
  }), [customScanDirs]);

  const loadBase = useCallback(async ({ silent = false } = {}) => {
    if (!window.electronAPI?.resource) {
      setLoading(false);
      setError(t('resources.desktopOnly'));
      return;
    }
    if (!silent) setLoading(true);
    setError('');
    try {
      // 清理旧版本的三个系统智能体（已并入看护执行引擎，幂等）
      try { await window.electronAPI.resource.ensureBuiltinAssistants?.(); } catch { /* ignore */ }
      // 全量拉取，搜索/类型在前端筛，避免每次筛选触发 IPC
      const catalogGenAtStart = catalogFetchGen.current;
      const [catRes, resRes, agentRes, asstBindRes] = await Promise.all([
        window.electronAPI.resource.listCatalog({}),
        window.electronAPI.resource.listResources({}),
        window.electronAPI.resource.listAgentTargets(),
        // Skill 卡片「智能体依赖」标记：始终拉全量智能体（不受当前类型筛选）
        window.electronAPI.resource.listResources({ type: 'assistant' }),
      ]);
      if (catRes.success) {
        // 服务端刷新已写入更新的结果时，不再用这次本地缓存覆盖
        if (catalogAppliedGen.current <= catalogGenAtStart) setCatalog(catRes.items || []);
      } else {
        setError(catRes.error || t('resources.loadFailed'));
      }
      if (resRes.success) setResources(resRes.resources || []);
      if (asstBindRes?.success) setAssistantsForBind(asstBindRes.resources || []);
      if (agentRes.success) {
        setAgents(agentRes.agents || []);
        setPromptAgents(agentRes.promptAgents || []);
        setAssistantAgents(agentRes.assistantAgents || []);
      }
      try {
        const apps = await window.electronAPI.apps?.list?.();
        if (apps) setManagedAppTargets(deriveManagedAppTargets(apps));
      } catch { /* apps 拉取失败时回退到 agents */ }
    } catch (e) {
      setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  /** 拉取默认监控目录：listScanRoots → scanStatsHint → Agent skillRoot 回退 */
  const refreshDefaultScanRoots = useCallback(async (filters, scanStatsHint) => {
    const api = window.electronAPI?.resource;
    if (!api) return;
    // 1) 专用 IPC
    try {
      if (api.listScanRoots) {
        const res = await api.listScanRoots(filters || scanFilters());
        const defaults = (res?.roots || []).filter(r => r.kind === 'default' && r.path);
        if (res?.success && defaults.length) {
          setDefaultScanRoots(defaults);
          return;
        }
      }
    } catch { /* 旧主进程无 handler 时回退 */ }
    // 2) 扫描统计里附带的 defaultRoots
    if (Array.isArray(scanStatsHint?.defaultRoots) && scanStatsHint.defaultRoots.length) {
      setDefaultScanRoots(scanStatsHint.defaultRoots.filter(r => r.path));
      return;
    }
    // 3) 用已安装 Agent 的 skillRoot 拼一份，并补上 .agents
    try {
      const agentRes = await api.listAgentTargets();
      if (agentRes?.success) {
        const roots = (agentRes.agents || [])
          .filter(a => a.skillRoot)
          .map(a => ({
            id: a.id,
            label: a.label || a.id,
            path: a.skillRoot,
            kind: 'default',
            exists: true,
          }));
        // 从任一 skill 路径反推家目录，补全 .agents / .tokenbank（分隔符随平台）
        const sample = roots[0]?.path || '';
        const homeMatch = String(sample).match(/^(.*)[/\\]\.[^/\\]+[/\\]skills(?:-cursor)?$/i);
        const home = homeMatch?.[1];
        if (home) {
          const extras = [
            { id: 'agents-hub', label: '.agents', path: joinFsPath(home, '.agents', 'skills') },
            { id: 'tokenbank', label: '.tokenbank', path: joinFsPath(home, '.tokenbank', 'skills') },
          ];
          for (const ex of extras) {
            if (!roots.some(r => r.id === ex.id || sameSkillDir(r.path, ex.path))) {
              roots.push({ ...ex, kind: 'default', exists: true });
            }
          }
        }
        if (roots.length) setDefaultScanRoots(roots);
      }
    } catch { /* ignore */ }
  }, [scanFilters]);

  /** 扫描后 AI 打标；有未打标时才跑模型。返回是否实际进入打标 */
  const aiTagInflightRef = useRef(false);
  const aiTagAbortRef = useRef(null);
  const aiTagCancelledRef = useRef(false);
  /** 取消自动打标并立刻恢复可扫描状态（避免卡死） */
  const cancelAutoTagging = useCallback(() => {
    aiTagCancelledRef.current = true;
    try { aiTagAbortRef.current?.abort(); } catch { /* ignore */ }
    aiTagInflightRef.current = false;
    autoTaggingRef.current = false;
    scanningRef.current = false;
    setAutoTagging(false);
    setScanning(false);
    setMsg(t('resources.autoTaggingCancelled'));
  }, [t]);

  const silentAiTagAfterScan = useCallback(async (discoveredItems, aiMap = {}, { onTagging, signal } = {}) => {
    if (!window.electronAPI?.resource?.listResources) return false;
    if (aiTagInflightRef.current) return false;
    aiTagInflightRef.current = true;
    const aborted = () => !!signal?.aborted;
    try {
      if (aborted()) return false;
      const resRes = await window.electronAPI.resource.listResources({ type: 'skill' });
      if (aborted()) return false;
      const managedList = resRes.success ? (resRes.resources || []) : [];
      if (!managedList.length) return false;
      const byId = new Map(managedList.map((r) => [r.id, r]));
      // 仅未归入任何用途的技能；已打标的一律跳过（不先整表 setResources，避免列表闪空）
      const targets = (discoveredItems || []).filter((item) => {
        if (!item.resourceId) return false;
        const managed = byId.get(item.resourceId);
        if (!managed) return false;
        return resolvePurposes(managed, aiMap).length === 0;
      });
      if (!targets.length) return false;

      // 确有未打标项：通知 UI 进入「自动打标中」
      if (typeof onTagging === 'function') onTagging();
      if (aborted()) return false;

      const mapped = await classifySkillsPurposeWithAi(targets.map((item) => {
        const managed = byId.get(item.resourceId);
        return {
          id: item.resourceId,
          name: item.name || managed?.name || '',
          description: item.description || managed?.description || '',
        };
      }), { signal });
      if (aborted()) return false;

      // AI 返回后再拉一次，跳过本轮已被其它路径打上用途的项
      try {
        const again = await window.electronAPI.resource.listResources({ type: 'skill' });
        if (again?.success) {
          for (const r of again.resources || []) byId.set(r.id, r);
        }
      } catch { /* ignore */ }

      const taggedIds = new Set();
      for (const item of targets) {
        if (aborted()) break;
        const existing = byId.get(item.resourceId);
        if (!existing) continue;
        // 落库前再确认一次，避免并发/同步后已打标被覆盖
        if (resolvePurposes(existing, aiMap).length > 0) continue;
        // AI 结果优先；缺失时用名称/简介启发式，避免残留「其它」
        const purpose = PURPOSE_SLUGS.includes(mapped[item.resourceId])
          ? mapped[item.resourceId]
          : inferPurposeHeuristic(
            item.name || existing.name || '',
            item.description || existing.description || '',
          );
        const kept = resourceTags(existing).filter((tag) => {
          if (PURPOSE_SLUGS.includes(tag)) return false;
          return !tagToPurpose(tag, aiMap);
        });
        try {
          const saveRes = await window.electronAPI.resource.saveResource({
            id: existing.id,
            type: 'skill',
            name: existing.name,
            display_name: existing.display_name || existing.name,
            description: existing.description || item.description || '',
            content: existing.content || item.content || '',
            metadata: { ...(existing.metadata || {}), tags: [...kept, purpose] },
          });
          if (!saveRes.success || !saveRes.resource) continue;
          byId.set(saveRes.resource.id, saveRes.resource);
          taggedIds.add(saveRes.resource.id);
        } catch { /* 单条失败继续 */ }
      }
      if (aborted() || !taggedIds.size) return true;
      setDiscovered((prev) => prev.map((item) => {
        const r = item.resourceId ? byId.get(item.resourceId) : null;
        if (!r || !taggedIds.has(r.id)) return item;
        return {
          ...item,
          metadata: r.metadata || {},
          description: r.description || item.description,
        };
      }));
      // 只局部合并已打标项，避免整表替换导致短暂空白
      setResources((prev) => prev.map((r) => (taggedIds.has(r.id) ? (byId.get(r.id) || r) : r)));
      return true;
    } catch (e) {
      if (e?.name === 'AbortError') return false;
      // 打标失败不阻断扫描结果
      return false;
    } finally {
      aiTagInflightRef.current = false;
    }
  }, []);

  // announce=false：首屏自动扫描不弹「扫描完成」提示（仅手动扫描时告知结果）
  const runScan = useCallback(async ({ silent = false, autoTag = !silent, announce = true } = {}) => {
    if (!window.electronAPI?.resource) return;
    // 自动打标未结束时禁止再次手动扫描（读 ref，勿依赖 scanning state 以免重建 loadAll）
    if (!silent && (scanningRef.current || autoTaggingRef.current || aiTagInflightRef.current)) return;
    if (!silent) {
      scanningRef.current = true;
      setScanning(true);
      setError('');
      setMsg('');
    }
    let scanHint = '';
    try {
      const filters = scanFilters();
      const [scanRes, installRes] = await Promise.all([
        // 扫描即纳管：本机扫描到的 skill 即已纳管 skill
        window.electronAPI.resource.syncDiscovered(filters),
        window.electronAPI.resource.listAgentInstallations(filters),
      ]);
      if (scanRes.success) {
        const nextDiscovered = scanRes.items || [];
        setDiscovered(nextDiscovered);
        setScanStats(scanRes.scanStats || null);
        // 默认目录与扫描结果一并刷新
        await refreshDefaultScanRoots(filters, scanRes.scanStats);
        if (!silent) {
          setLastScan({
            total: scanRes.scanStats?.totalOnDisk ?? nextDiscovered.length,
            imported: scanRes.imported || 0,
            updated: scanRes.updated || 0,
            at: Date.now(),
          });
        }
        if (!silent && announce) {
          scanHint = t('resources.scanDoneHint', {
            total: scanRes.scanStats?.totalOnDisk ?? nextDiscovered.length,
            imported: scanRes.imported || 0,
            updated: scanRes.updated || 0,
          });
          setMsg(scanHint);
        }
        // 仅手动扫描才自动打标；首屏/静默刷新绝不进入，避免 loading 卡死空白与重复打标
        if (autoTag && !silent) {
          // 扫描 UI 先结束，列表可交互；打标单独占 autoTagging
          scanningRef.current = false;
          setScanning(false);
          const ac = new AbortController();
          aiTagCancelledRef.current = false;
          aiTagAbortRef.current = ac;
          try {
            await silentAiTagAfterScan(nextDiscovered, purposeAiMapRef.current, {
              signal: ac.signal,
              onTagging: () => {
                if (aiTagCancelledRef.current) return;
                autoTaggingRef.current = true;
                setAutoTagging(true);
                setMsg(t('resources.autoTagging'));
              },
            });
          } finally {
            if (aiTagAbortRef.current === ac) aiTagAbortRef.current = null;
          }
        }
      } else if (!silent) {
        setError(scanRes.error || t('resources.scanFailed'));
      }
      if (installRes.success) {
        setAgentInstallations(installRes.agents || []);
      }
    } catch (e) {
      if (!silent) setError(e.message);
    } finally {
      if (!silent) {
        const cancelled = aiTagCancelledRef.current;
        autoTaggingRef.current = false;
        scanningRef.current = false;
        setAutoTagging(false);
        setScanning(false);
        // 取消时保留「已取消」提示；正常结束恢复扫描摘要
        if (!cancelled && scanHint) setMsg(scanHint);
        aiTagCancelledRef.current = false;
      }
    }
  }, [scanFilters, refreshDefaultScanRoots, silentAiTagAfterScan, t]);

  // 看护资产体检的小标签（质量 / 安全 / 重复 / 新版本），按资产 id 索引
  const [assetFlags, setAssetFlags] = useState({});
  const [addMenuOpen, setAddMenuOpen] = useState(false);   // 右上角「添加」菜单
  useEffect(() => {
    if (!addMenuOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setAddMenuOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addMenuOpen]);
  // 投射了但跑不起来的智能体（要用的技能不在了 / 没有能跑它的应用），按资源 id 索引
  const [blockedAssistants, setBlockedAssistants] = useState({});
  const loadAssetFlags = useCallback(async () => {
    try {
      const r = await window.electronAPI?.guardian?.assetFlags?.();
      if (r?.flags) setAssetFlags(r.flags);
    } catch { /* 没有看护时不显示 */ }
    try {
      const r = await window.electronAPI?.agent?.listBlocked?.();
      if (r?.success) setBlockedAssistants(Object.fromEntries((r.agents || []).map(a => [a.resourceId, a])));
    } catch { /* 拿不到就不标 */ }
  }, []);

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    // 先扫描即纳管（入库），再读取 resources；打标不跟首屏走，避免整页空白
    await runScan({ silent, autoTag: false, announce: false });
    await loadBase({ silent });
    loadAssetFlags();
  }, [loadBase, runScan, loadAssetFlags]);

  // 首屏全量加载；之后筛选/搜索走 silent，避免列表被掏空
  useEffect(() => {
    let alive = true;
    (async () => {
      const silent = bootstrappedRef.current;
      if (silent) setSearching(true);
      try {
        await loadAll({ silent });
        if (alive) bootstrappedRef.current = true;
      } finally {
        if (alive) setSearching(false);
      }
    })();
    return () => { alive = false; };
  }, [loadAll]);

  /** 从服务端拉最新社区目录再刷列表。页面被缓存，切 tab 不会自己更新。 */
  const refreshCommunityCatalog = useCallback(async () => {
    const gen = ++catalogFetchGen.current;
    try {
      await window.electronAPI?.resource?.syncCommunityCatalog?.();
    } catch { /* 离线时仍读本地缓存 */ }
    if (gen !== catalogFetchGen.current) return;
    try {
      const catRes = await window.electronAPI?.resource?.listCatalog?.({});
      if (gen !== catalogFetchGen.current) return;
      if (catRes?.success) {
        catalogAppliedGen.current = gen;
        setCatalog(catRes.items || []);
      }
    } catch { /* ignore */ }
  }, []);

  // 从其它页切回来时重新拉社区目录（keep-alive 不会卸载，否则列表停在进来时的缓存）
  useEffect(() => {
    if (!pageActive) return undefined;
    refreshCommunityCatalog();
    return undefined;
  }, [pageActive, refreshCommunityCatalog]);

  // Esc 关闭编辑 / 清理模态（忙碌中不可关）
  useEffect(() => {
    if (!editorOpen && !cleanupOpen) return undefined;
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (busy === 'editor' || busy === 'cleanup' || idleLoading) return;
      if (editorOpen) setEditorOpen(false);
      if (cleanupOpen) {
        abortIdleAi();
        setCleanupOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorOpen, cleanupOpen, busy, idleLoading]);

  // 成功提示 3 秒后自动消失；错误同样收起，避免挡住操作
  useEffect(() => {
    if (!msg) return undefined;
    const timer = setTimeout(() => setMsg(''), 3000);
    return () => clearTimeout(timer);
  }, [msg]);

  useEffect(() => {
    if (!error) return undefined;
    const timer = setTimeout(() => setError(''), 4000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!projectMenu) return undefined;
    function onDoc(e) {
      if (projectMenuRef.current?.contains(e.target)) return;
      setProjectMenu(null);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [projectMenu]);

  // 滚动/缩放时跟随锚点重定位，而不是关闭（与 RouteSelect / Providers 下拉一致）
  useEffect(() => {
    const anchorEl = projectMenu?.anchorEl;
    if (!anchorEl) return undefined;
    let raf = 0;
    const reposition = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!anchorEl.isConnected) return;
        const r = anchorEl.getBoundingClientRect();
        setProjectMenu(prev => (prev ? {
          ...prev,
          anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
        } : null));
      });
    };
    // capture=true：捕获内部滚动容器的 scroll（scroll 不冒泡）
    document.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [projectMenu?.anchorEl]);

  // 按实际菜单尺寸贴齐锚点：下方不够则翻到上方，并限制在视口内
  useLayoutEffect(() => {
    if (!projectMenu?.anchor || !projectMenuRef.current) return;
    const el = projectMenuRef.current;
    const margin = 8;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    if (!h || !w) return;
    const { anchor } = projectMenu;
    let top = anchor.bottom + 4;
    if (top + h > window.innerHeight - margin) {
      top = Math.max(margin, anchor.top - h - 4);
    }
    if (top + h > window.innerHeight - margin) {
      top = margin;
    }
    let left = anchor.left;
    if (left + w > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - w - margin);
    }
    if (left === projectMenu.x && top === projectMenu.y) return;
    setProjectMenu(prev => (prev ? { ...prev, x: left, y: top } : null));
  }, [projectMenu, agents, promptAgents, assistantAgents, managedAppTargets]);

  const lastCatalogSyncRef = useRef(0);
  function changeViewTab(tab) {
    if (tab !== viewTab) setTypeFilter(tab === 'recommend' ? readDiscoverType() : readTypeFilter());
    setViewTab(tab);
    setSelectedKey(null);
    saveViewTab(tab);
    // 进入「发现」时同步社区目录；一分钟内重复进入不再拉，避免闪烁
    if (tab === 'recommend' && Date.now() - lastCatalogSyncRef.current > 60000) {
      lastCatalogSyncRef.current = Date.now();
      refreshCommunityCatalog();
    }
  }

  /** tab 指明写入哪一边的类型记忆（切 tab 的同一次点击里 viewTab 还没更新） */
  function changeTypeFilter(type, tab = viewTab) {
    setTypeFilter(type);
    if (tab === 'recommend') saveDiscoverType(type);
    else saveTypeFilter(type);
    setSelectedKey(null);
  }

  // 其它页跳转带类型（如供给源「MCP 工具已移到资源」）：navigate('/resources', { state: { resourceType } })
  useEffect(() => {
    const want = location.state?.resourceType;
    const selectKey = location.state?.selectKey;
    const wantTab = location.state?.viewTab;
    const wantQuery = location.state?.query;
    const wantApp = location.state?.app;
    if (!want && !selectKey && !wantTab && wantQuery == null && !wantApp) return;
    // 看护「能力缺口」跳来：打开发现页，并按推荐条目名搜索
    if (wantTab === 'recommend' || wantTab === 'managed') changeViewTab(wantTab);
    if (typeof wantQuery === 'string') setQuery(wantQuery);
    if (want && TYPE_OPTIONS.some(o => o.id === want)) changeTypeFilter(want);
    // 从网关某个应用的「调整」跳来：只看启用到这个应用的
    if (wantApp) { changeViewTab('managed'); changeAppFilter(wantApp); }
    // 从供给源「谁在用它」跳来：打开资产库并选中该条
    if (selectKey) { changeViewTab('managed'); setSelectedKey(selectKey); }
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state]); // eslint-disable-line react-hooks/exhaustive-deps

  function changeAppFilter(agentId) {
    setAppFilter(agentId);
    saveAppFilter(agentId);
  }

  function changeListSort(sort) {
    setListSort(sort);
    saveListSort(sort);
  }

  function updateCustomScanDirs(dirs) {
    const next = [...new Set((dirs || []).map(d => String(d || '').trim()).filter(Boolean))];
    setCustomScanDirs(next);
    saveScanCustomDirs(next);
  }

  function removeCustomScanDir(dir) {
    updateCustomScanDirs(customScanDirs.filter(d => !sameSkillDir(d, dir)));
  }

  /** 添加用户扫描目录（去重）；与默认目录并列，不互斥 */
  async function pickCustomScanDir() {
    if (!window.electronAPI?.resource?.pickImportPath) return;
    try {
      const pick = await window.electronAPI.resource.pickImportPath({
        title: t('resources.scanPickDirTitle'),
        allowFile: false,
        allowDirectory: true,
      });
      if (pick.success && pick.path) {
        const p = String(pick.path).trim();
        // Windows 路径大小写/分隔符可能不一致，用归一化去重
        if (p && !customScanDirs.some(d => sameSkillDir(d, p))) {
          updateCustomScanDirs([...customScanDirs, p]);
        }
      }
    } catch (e) {
      setError(e.message);
    }
  }

  // 展开扫描面板时拉取默认监控目录；首次挂载也拉一次
  useEffect(() => {
    refreshDefaultScanRoots();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- 仅启动时

  useEffect(() => {
    if (!scanExpanded) return undefined;
    refreshDefaultScanRoots();
    return undefined;
  }, [scanExpanded, refreshDefaultScanRoots]);

  function toggleScanPanel() {
    setScanExpanded(v => !v);
  }

  useEffect(() => {
    if (!localStorage.getItem('token')) return;
    getCommunityCatalogPricing()
      .then((r) => { const c = Number(r?.data?.install_cost); if (Number.isFinite(c)) setCommunityCost(c); })
      .catch(() => {});
  }, []);

  const isPaidCatalog = (item) => !!(item?.metadata?.user_recommended && item?.metadata?.recommender_user_id);

  /** 应用 id → 展示名（与网关列表同源） */
  function appLabelOf(id) {
    const hit = (managedAppTargets || []).find((a) => a.id === id)
      || (agents || []).find((a) => a.id === id);
    return (hit && (hit.label || hit.name)) || id;
  }

  /**
   * 所有「拿到一个资产」的入口统一收尾：投射到常用应用 + 复制调用口令。
   * 返回一句提示（写清用在了哪些应用），失败时返回空串，不影响入库结果。
   */
  async function enableResource(resource) {
    if (!resource?.id || resource.type === 'mcp') return '';
    try {
      const pack = await completeEnablePackage(resource, { lang });
      if (pack.invokeText) await copyText(pack.invokeText);
      try {
        const fresh = await window.electronAPI.resource.listResources({ type: resource.type });
        const hit = (fresh?.resources || []).find((r) => r.id === resource.id);
        if (hit) upsertResourceLocally(hit);
      } catch { /* ignore */ }
      const name = resource.display_name || resource.name;
      if (pack.projected && (pack.agentIds || []).length) {
        return t('resources.enabledIn', {
          name,
          apps: pack.agentIds.map(appLabelOf).join('、'),
          invoke: pack.invokeText,
        });
      }
      return pack.projected
        ? t('resources.enabledWithInvoke', { name, invoke: pack.invokeText })
        : t('resources.enabledNeedProject', { name, invoke: pack.invokeText });
    } catch {
      return '';
    }
  }

  /** 新建 / 导入后：切到该类型的资产列表并选中这一条 */
  function focusResource(resource) {
    if (!resource?.id) return;
    setViewTab('managed');
    saveViewTab('managed');
    if (resource.type && TYPE_OPTIONS.some((o) => o.id === resource.type)) {
      setTypeFilter(resource.type);
      saveTypeFilter(resource.type);
    }
    setTimeout(() => setSelectedKey(`r-${resource.id}`), 0);
  }

  /** 新建智能体时顺带纳管社区技能：不动全局 busy/msg，返回落库名 */
  async function installCatalogQuiet(c) {
    try {
      if (c.paid) {
        const { data: settled } = await settleCommunityCatalogInstall(c.catalogId);
        if (settled?.item) {
          try { await window.electronAPI.resource.upsertCommunitySkill?.({ item: settled.item }); } catch { /* ignore */ }
        }
      }
      const res = await window.electronAPI.resource.installCatalog({ catalogId: c.catalogId });
      if (!res?.success) return { ok: false };
      if (res.resource) {
        upsertResourceLocally(res.resource);
        markCatalogInstalled(c.catalogId, res.resource);
      } else {
        markCatalogInstalled(c.catalogId, null);
      }
      return { ok: true, name: res.resource?.name || c.name };
    } catch {
      return { ok: false };
    }
  }

  async function handleInstall(catalogId, { force = false } = {}) {
    const catalogItem = catalog.find(c => c.catalogId === catalogId);
    // 依赖缺失的智能体：先打开详情列出缺什么，由用户在详情里确认
    if (!force && catalogItem?.type === 'assistant' && catalogItem.depsBroken && catalogItem.missingDeps?.length) {
      setDepsPendingId(catalogId);
      setSelectedKey(`cat:${catalogId}`);
      return;
    }
    // 付费资源：第一次点击只显示价格确认，第二次才扣分
    if (isPaidCatalog(catalogItem) && !catalogItem.installed && payConfirmId !== catalogId) {
      if (!localStorage.getItem('token')) {
        setError(t('resources.recommendNeedLogin'));
        return;
      }
      setPayConfirmId(catalogId);
      setTimeout(() => setPayConfirmId((cur) => (cur === catalogId ? '' : cur)), 6000);
      // 付费把关：社区里有免费的类似技能时，打开详情让用户先看看
      if (freeAlternatives(catalogItem).length) setSelectedKey(`cat:${catalogId}`);
      return;
    }
    setPayConfirmId('');
    setDepsPendingId('');
    setBusy(catalogId);
    setMsg('');
    setError('');
    try {
      // 用户推荐项：先服务端结算（扣 8 / 奖推荐人 5，额度后台可改）
      const meta = catalogItem?.metadata || {};
      const needSettle = !!(meta.user_recommended && meta.recommender_user_id);
      if (needSettle) {
        if (!localStorage.getItem('token')) {
          setError(t('resources.recommendNeedLogin'));
          return;
        }
        try {
          const { data: settled } = await settleCommunityCatalogInstall(catalogId);
          if (settled?.item) {
            try {
              await window.electronAPI.resource.upsertCommunitySkill?.({ item: settled.item });
            } catch { /* 缓存写入失败仍尝试本地纳管 */ }
          }
          if (settled?.charged) {
            setMsg(t('resources.installCharged', {
              cost: settled.install_cost,
              reward: settled.recommend_reward,
            }));
          }
        } catch (e) {
          setError(formatApiError(e, t('resources.installSettleFailed')));
          return;
        }
      }

      const res = await window.electronAPI.resource.installCatalog({ catalogId });
      if (!res.success) {
        // 已结算过的付费项：服务端按「已付过」放行，重试不会重复扣分
        setError(needSettle ? t('resources.installFailedPaidRetry') : (res.error || t('resources.installFailed')));
        return;
      }
      setMsg((prev) => {
        const base = res.alreadyInstalled ? t('resources.alreadyManaged') : t('resources.installOk');
        return prev && needSettle ? `${prev} · ${base}` : base;
      });
      if (res.resource) {
        const note = await enableResource(res.resource);
        if (note) setMsg((prev) => (prev && needSettle ? `${prev.split(' · ')[0]} · ${note}` : note));
      }
      // 局部更新目录/本机列表，避免 loadAll 整页闪烁
      if (res.resource) {
        upsertResourceLocally(res.resource);
        markCatalogInstalled(catalogId, res.resource);
      } else {
        markCatalogInstalled(catalogId, null);
      }
      // 级联纳管依赖：静默刷新资源/目录列表（不置 loading）
      if ((res.installedDependencies || []).length) {
        try {
          const filters = { type: typeFilter || undefined, query: debouncedQuery || undefined };
          const [catRes, resRes] = await Promise.all([
            window.electronAPI.resource.listCatalog(filters),
            window.electronAPI.resource.listResources(filters),
          ]);
          if (catRes.success) setCatalog(catRes.items || []);
          if (resRes.success) setResources(resRes.resources || []);
        } catch { /* ignore */ }
      }
      // 留在当前「社区推荐」Tab，不跳转到已纳管
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  /** 从权威路径读 Skill 正文（目录则读 SKILL.md；列表行本身不带 content） */
  async function readSkillBodyFromPath(targetPath) {
    const api = window.electronAPI?.resource?.previewFile;
    const raw = String(targetPath || '').trim();
    if (!api || !raw) return '';
    const tryFile = async (p) => {
      try {
        const prev = await api({ targetPath: p });
        if (prev?.success && prev.kind !== 'directory' && prev.content) {
          return String(prev.content).trim();
        }
      } catch { /* ignore */ }
      return '';
    };
    let text = await tryFile(raw);
    if (text) return text;
    // previewFile 对目录只返回 entries、无 content，需拼 SKILL.md
    const base = raw.replace(/[/\\]+$/, '');
    const sep = /\\/.test(base) && !/\//.test(base) ? '\\' : '/';
    for (const name of ['SKILL.md', 'skill.md']) {
      text = await tryFile(`${base}${sep}${name}`);
      if (text) return text;
    }
    return '';
  }

  /** 推荐本机 Skill / Prompt / Assistant 到社区：他人可见并可纳管（纳管扣积分、推荐人获奖） */
  async function handleRecommendToCommunity(resourceLike) {
    if (!localStorage.getItem('token')) {
      setError(t('resources.recommendNeedLogin'));
      return;
    }
    let managed = resourceLike?.resourceId
      ? resourcesById.get(resourceLike.resourceId)
      : (resourceLike?.id ? resourcesById.get(resourceLike.id) : null);
    let rtype = String(managed?.type || resourceLike?.type || 'skill').trim().toLowerCase();
    if (rtype === 'agent') rtype = 'assistant';
    if (!['skill', 'prompt', 'assistant'].includes(rtype)) rtype = 'skill';
    // 内置资产不推荐
    if (managed?.source === 'builtin' || managed?.metadata?.builtin || isBuiltinResource(managed || resourceLike)) {
      setError(t('resources.recommendBuiltinBlocked'));
      return;
    }
    const name = String(managed?.name || resourceLike?.name || '').trim();
    if (!name) {
      setError(t('resources.recommendNeedContent'));
      return;
    }
    let content = String(managed?.content || resourceLike?.content || '').trim();
    const storedContent = content;
    // 扫描后本机列表可能尚未带上正文：再拉一次库
    if (!content && window.electronAPI?.resource?.listResources) {
      try {
        const resRes = await window.electronAPI.resource.listResources({ type: rtype });
        const hit = ((resRes && resRes.resources) || []).find(
          (r) => r.id === (managed?.id || resourceLike?.resourceId || resourceLike?.id)
            || r.name === name,
        );
        if (hit) {
          managed = hit;
          if (hit.content) content = String(hit.content).trim();
          upsertResourceLocally(hit);
        }
      } catch { /* ignore */ }
    }
    // Skill：重复推送时以磁盘上的 SKILL.md 为准，社区副本才能更新到最新正文
    let skillDir = '';
    if (rtype === 'skill') {
      skillDir = resourceLike?.authorityPath
        || managed?.authorityPath
        || managed?.metadata?.authorityPath
        || managed?.metadata?.scannedFrom
        || resourceLike?.skillDir
        || '';
      const fresh = await readSkillBodyFromPath(skillDir);
      if (fresh) content = fresh;
    }
    if (!content) {
      setError(t('resources.recommendNeedContent'));
      return;
    }
    // 无说明时从正文提炼，写入社区条目；本机若也缺说明则一并补上
    let description = String(managed?.description || resourceLike?.description || '').trim();
    const contentChanged = content !== storedContent;
    // `|` / `>` 是没读到的多行 YAML 标记；正文已变时重新提炼，避免社区介绍停在旧版
    if (!description || /^[|>][+-]?$/.test(description) || contentChanged) {
      description = '';
      try {
        const api = window.electronAPI?.resource;
        if (api?.extractDescription) {
          const ex = await api.extractDescription({ type: rtype, content, name });
          if (ex?.success && ex.description) description = String(ex.description).trim();
        }
      } catch { /* ignore */ }
      if (!description) {
        // 渲染进程兜底：取正文首段
        const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').trim();
        let soul = body;
        if (rtype === 'assistant') {
          try {
            const obj = JSON.parse(body);
            soul = String(obj?.soul || obj?.system_prompt || obj?.systemPrompt || body).trim();
          } catch { /* ignore */ }
        }
        const m = soul.match(/^[\s\S]+?[。.!！]/);
        description = String(m ? m[0] : soul).replace(/\s+/g, ' ').trim().slice(0, 180);
      }
    }
    const busyKey = `rec-${managed?.id || resourceLike?.resourceId || name}`;
    const alreadyPushed = isPushedToCommunity(managed || resourceLike, catalog);
    // 分享前整理：私人路径、密钥、邮箱、公司内网地址换成占位符；发布的是清理后的版本，本机原文不动
    const localDescription = description;
    let displayName = managed?.display_name || resourceLike?.display_name || name;
    let cleaned = null;
    try {
      const sc = await window.electronAPI?.guardian?.shareCheck?.({ content, description, displayName });
      if (sc?.changed) cleaned = sc;
    } catch { /* 看护不可用时照旧 */ }
    const baseConfirm = alreadyPushed
      ? t('resources.recommendAgainConfirm', { name })
      : t('resources.recommendConfirm', { name });
    const cleanNote = cleaned
      ? `\n\n${t('resources.shareCleanNote', {
        list: cleaned.findings.map((f) => `${f.label} ${f.count} 处（${f.samples.join('、')}）`).join('\n'),
      })}`
      : '';
    if (!window.confirm(baseConfirm + cleanNote)) return;
    if (cleaned) {
      content = cleaned.content;
      description = cleaned.description;
      displayName = cleaned.displayName || displayName;
    }
    setBusy(busyKey);
    setError('');
    setMsg('');
    try {
      // 本机缺说明时先落库，卡片也能立刻显示
      const storedDesc = String(managed?.description || '').trim();
      const storedBlank = !storedDesc || /^[|>][+-]?$/.test(storedDesc);
      if (localDescription && managed?.id && storedBlank
        && window.electronAPI?.resource?.saveResource) {
        try {
          const saved = await window.electronAPI.resource.saveResource({
            id: managed.id,
            type: rtype,
            name: managed.name || name,
            display_name: managed.display_name || name,
            description: localDescription,
            content: managed.content || content,
            metadata: managed.metadata || {},
          });
          if (saved?.success && saved.resource) {
            managed = saved.resource;
            upsertResourceLocally(saved.resource);
          }
        } catch { /* 补说明失败不阻断推荐 */ }
      }
      // 只打包含 SKILL.md 的技能目录，不上传整个仓库。读失败则不带 files，避免用空数组冲掉已发布的配套。
      let packedFiles = null;
      if (rtype === 'skill' && skillDir && window.electronAPI?.resource?.packSkillFiles) {
        try {
          const packed = await window.electronAPI.resource.packSkillFiles({ skillDir });
          if (packed?.success && Array.isArray(packed.files)) packedFiles = packed.files;
        } catch { /* 配套文件读失败不阻断推荐正文 */ }
      }
      const { data } = await recommendCommunitySkill({
        name,
        content,
        type: rtype,
        display_name: displayName,
        description,
        metadata: {
          ...(managed?.metadata || resourceLike?.metadata || {}),
          tags: managed?.metadata?.tags || resourceLike?.metadata?.tags,
          // 空数组也要带上，这样删掉配套文件后再次推荐能清掉旧列表
          ...(packedFiles ? { files: packedFiles } : {}),
        },
      });
      if (data?.item) {
        try {
          await window.electronAPI.resource.upsertCommunitySkill?.({ item: data.item });
        } catch { /* ignore */ }
      }
      // 本机打上「已推送」，刷新后仍能识别
      const catalogId = String(data?.item?.catalog_id || data?.item?.catalogId || '').trim();
      if (managed?.id && window.electronAPI?.resource?.saveResource) {
        try {
          const saved = await window.electronAPI.resource.saveResource({
            id: managed.id,
            type: rtype,
            name: managed.name || name,
            display_name: managed.display_name || name,
            description: managed.description || localDescription,
            content: managed.content || storedContent || content,
            metadata: {
              ...(managed.metadata || {}),
              community_recommended: true,
              community_catalog_id: catalogId || undefined,
              community_recommended_at: Date.now(),
            },
          });
          if (saved?.success && saved.resource) upsertResourceLocally(saved.resource);
        } catch { /* 标记失败不阻断推荐结果 */ }
      }
      try {
        await window.electronAPI.resource.syncCommunityCatalog?.();
      } catch { /* ignore */ }
      // 刷新目录列表，推荐 Tab 可见
      try {
        const catRes = await window.electronAPI.resource.listCatalog({});
        if (catRes.success) setCatalog(catRes.items || []);
      } catch { /* ignore */ }
      setMsg(t(data?.updated ? 'resources.recommendUpdated' : 'resources.recommendOk', {
        name: data?.item?.display_name || name,
      }));
    } catch (e) {
      setError(formatApiError(e, t('resources.recommendFailed')));
    } finally {
      setBusy('');
    }
  }

  async function handleOpenPath(targetPath) {
    if (!targetPath || !window.electronAPI?.resource?.openPath) return;
    try {
      const res = await window.electronAPI.resource.openPath({ targetPath });
      if (!res?.success) setError(res?.error || t('resources.openPathFailed'));
    } catch (e) {
      setError(e.message);
    }
  }

  /** 本机列表 upsert（纳管/保存/导入后局部刷新） */
  function upsertResourceLocally(resource) {
    if (!resource?.id) return;
    const projections = resource.projections || [];
    setResources(prev => {
      const idx = prev.findIndex(r => r.id === resource.id);
      const row = {
        ...(idx >= 0 ? prev[idx] : {}),
        ...resource,
        projections: projections.length ? projections : (idx >= 0 ? (prev[idx].projections || []) : []),
      };
      // 刚纳管/更新的顶到最前(与纳管时间倒序一致)
      if (idx >= 0) {
        const next = prev.filter((_, i) => i !== idx);
        return [row, ...next];
      }
      return [row, ...prev];
    });
    if (resource.type !== 'skill') return;
    setDiscovered(prev => {
      const idx = prev.findIndex(item => item.resourceId === resource.id || item.name === resource.name);
      const patch = {
        name: resource.name,
        display_name: resource.name,
        description: resource.description || '',
        managed: true,
        resourceId: resource.id,
        projections,
        // 打标后同步 metadata，用途芯片可立刻更新
        metadata: resource.metadata || {},
        authorityPath: resource.authorityPath || resource.metadata?.authorityPath || null,
        type: 'skill',
        contentChanged: false,
        created_at: resource.created_at || Date.now(),
        updated_at: resource.updated_at || Date.now(),
      };
      if (idx >= 0) {
        const next = prev.filter((_, i) => i !== idx);
        return [{ ...prev[idx], ...patch }, ...next];
      }
      return [patch, ...prev];
    });
  }

  /** 社区推荐：标记已纳管 */
  function markCatalogInstalled(catalogId, resource) {
    setCatalog(prev => prev.map(c => {
      if (catalogId && c.catalogId === catalogId) {
        return { ...c, installed: true, resourceId: resource?.id || c.resourceId || null };
      }
      if (resource && c.type === resource.type && c.name === resource.name) {
        return { ...c, installed: true, resourceId: resource.id };
      }
      return c;
    }));
  }

  /** 局部更新某资产的投射列表（避免 loadAll 整页抖动） */
  function applyResourcePatch(resourceId, nextResource) {
    const projections = nextResource?.projections || [];
    setResources(prev => prev.map(r => (
      r.id === resourceId
        ? { ...r, ...nextResource, projections }
        : r
    )));
    setDiscovered(prev => prev.map(item => (
      item.resourceId === resourceId
        ? { ...item, projections }
        : item
    )));
  }

  /** 局部移除已卸载/删除的资产 */
  function removeResourceLocally(resourceId, meta = {}) {
    const removed = resources.find((r) => r.id === resourceId)
      || discovered.find((i) => i.resourceId === resourceId || i.id === resourceId)
      || meta;
    setResources(prev => prev.filter(r => r.id !== resourceId));
    // Skill 卸载会删权威目录，本机列表中对应行一并移除
    setDiscovered(prev => prev.filter(item => item.resourceId !== resourceId));
    setScanStats(prev => (prev && typeof prev.totalOnDisk === 'number'
      ? { ...prev, totalOnDisk: Math.max(0, prev.totalOnDisk - 1) }
      : prev));
    // 社区目录标记恢复为未纳管
    if (removed) {
      setCatalog((prev) => prev.map((c) => {
        if (c.resourceId === resourceId) return { ...c, installed: false, resourceId: null };
        if (removed.name && c.type === (removed.type || typeFilter) && c.name === removed.name) {
          return { ...c, installed: false, resourceId: null };
        }
        return c;
      }));
      // 推荐页可能未挂载:直接改 localStorage 里的 adopted
      try {
        const LAST = 'tokenbank.resources.recommend.last';
        const names = new Set(
          [removed.name, removed.display_name, removed.displayName, removed.id, removed.resourceId, resourceId]
            .filter(Boolean).map(String),
        );
        for (const tf of ['skill', 'prompt', 'assistant']) {
          const key = `${LAST}.${tf}`;
          const data = JSON.parse(localStorage.getItem(key) || 'null');
          if (!data || !Array.isArray(data.items)) continue;
          let changed = false;
          const items = data.items.map((rec) => {
            const hit = [rec.slug, rec.name, rec.catalogId, rec.resourceId]
              .some((k) => k && names.has(String(k)));
            if (hit && rec.adopted) {
              changed = true;
              return { ...rec, adopted: false };
            }
            return rec;
          });
          if (changed) localStorage.setItem(key, JSON.stringify({ ...data, items }));
        }
      } catch { /* ignore */ }
    }
    // 通知个性化推荐(若在挂载)立刻刷新按钮
    try {
      window.dispatchEvent(new CustomEvent('tokenbank:resource-removed', {
        detail: {
          id: resourceId,
          name: removed && removed.name,
          display_name: removed && (removed.display_name || removed.displayName),
          type: (removed && removed.type) || typeFilter,
        },
      }));
    } catch { /* ignore */ }
  }

  async function handleDelete(resource) {
    // 已投射的智能体须先取消投射再删,避免 Agent 侧残留引用
    if (resource.type === 'assistant') {
      const authorityPath = resource.authorityPath || getSkillLocation(resource);
      if (hasProjectedLinks(resource.projections, authorityPath)) {
        setError(t('resources.deleteNeedUnproject'));
        return;
      }
    }
    if (!window.confirm(t('resources.deleteConfirm', { name: resource.display_name || resource.name }))) return;
    setBusy(resource.id);
    try {
      const res = await window.electronAPI.resource.deleteResource(resource.id);
      if (!res.success) {
        setError(res.error || t('resources.deleteFailed'));
        return;
      }
      removeResourceLocally(resource.id, resource);
    } finally {
      setBusy('');
    }
  }

  /** 是否仍有可取消的非权威投射（须先取消再卸载） */
  function hasProjectedLinks(projections, authorityPath) {
    return (projections || []).some(p => canUnprojectProjection(p, authorityPath));
  }

  /** Skill 卸载：有投射则确认强制撤投射并删权威目录 */
  async function handleUninstallSkill(item) {
    const resourceId = item.resourceId || item.id;
    if (!resourceId) return;
    const authorityPath = item.authorityPath || getSkillLocation(item);
    const name = item.display_name || item.name;
    const hasLinks = hasProjectedLinks(item.projections, authorityPath);
    // 系统弹窗确认（列表很长时顶部提示看不见）
    const ok = window.confirm(
      hasLinks
        ? t('resources.uninstallForceConfirm', { name })
        : t('resources.uninstallConfirm', { name }),
    );
    if (!ok) return;
    setBusy(resourceId);
    try {
      // 先撤可取消投射：不依赖 preload 是否已重载 force 参数，避免仍被后端拦截
      const removable = (item.projections || []).filter((p) => canUnprojectProjection(p, authorityPath));
      for (const p of removable) {
        const up = await window.electronAPI.resource.unproject({
          resourceId,
          agentId: p.agentId,
          projectionId: p.id,
        });
        if (!up?.success) {
          window.alert(up?.error || t('resources.unprojectFailed'));
          return;
        }
      }
      // force:true 双保险（preload 已更新时由主进程一并处理）
      const res = await window.electronAPI.resource.deleteResource(resourceId, { force: true });
      if (!res.success) {
        window.alert(res.error || t('resources.uninstallFailed'));
        return;
      }
      removeResourceLocally(resourceId, { ...item, id: resourceId, type: 'skill' });
    } finally {
      setBusy('');
    }
  }

  /** 中止进行中的闲置 AI 分析（关面板 / 重新扫描） */
  function abortIdleAi() {
    try { idleAiAbortRef.current?.abort(); } catch { /* ignore */ }
    idleAiAbortRef.current = null;
  }

  /** 根据分析结果同步默认勾选（只勾已分析且推荐项；无推荐时勾已分析全部） */
  function applyIdleSelectionFromMap(items, map, { streaming = false } = {}) {
    const analyzed = (items || []).filter((it) => map?.[it.id]);
    const recommended = analyzed
      .filter((it) => map[it.id]?.recommend)
      .map((it) => it.id);
    if (recommended.length) {
      setIdleSelected(recommended);
      return;
    }
    // 流式过程中无推荐则先不勾；结束后无推荐则勾已分析全部
    setIdleSelected(streaming ? [] : analyzed.map((it) => it.id));
  }

  /** 对闲置列表做大模型分析：每批 30 条，分析一条上屏一条 */
  async function analyzeIdleWithAi(items, days) {
    abortIdleAi();
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    idleAiAbortRef.current = ac;
    setIdleAiLoading(true);
    setIdleAiMap({});
    setIdleSelected([]);
    setIdleAiMeta({ source: '', error: '' });
    setIdleAiProgress({ done: 0, total: (items || []).length, batch: 0, batches: 0 });
    try {
      // 附上用途标签，供模型从「习惯/画像/质量」综合判断
      const enriched = (items || []).map((it) => ({
        ...it,
        purposes: purposesOf(it),
      }));
      const { map, source, error, skippedHeuristic } = await analyzeIdleSkillsWithAi(enriched, {
        days,
        lang: lang === 'en' ? 'en' : 'zh',
        signal: ac?.signal,
        onProgress: (p) => setIdleAiProgress(p),
        onPartial: (partial) => {
          setIdleAiMap(partial || {});
          applyIdleSelectionFromMap(enriched, partial || {}, { streaming: true });
        },
      });
      if (ac?.signal?.aborted) return;
      setIdleAiMap(map || {});
      setIdleAiMeta({
        source: source || '',
        error: error || '',
        skippedHeuristic: skippedHeuristic || 0,
      });
      applyIdleSelectionFromMap(items, map || {});
    } catch (e) {
      if (String(e.message || e) === 'aborted') return;
      setIdleAiMap({});
      setIdleAiMeta({ source: 'heuristic', error: e.message || String(e) });
      setIdleSelected((items || []).map((it) => it.id));
    } finally {
      if (idleAiAbortRef.current === ac) idleAiAbortRef.current = null;
      setIdleAiLoading(false);
      setIdleAiProgress(null);
    }
  }

  /** 按指定天数扫描闲置 Skill，并自动触发大模型分析 */
  async function scanIdleSkills(days = idleDays, { closeOnError = false } = {}) {
    if (!window.electronAPI?.resource?.listIdleSkills) return;
    abortIdleAi();
    const n = Math.max(1, Math.min(3650, Math.floor(Number(days) || DEFAULT_IDLE_DAYS)));
    setIdleDays(n);
    saveIdleDays(n);
    setIdleLoading(true);
    setIdleResult(null);
    setIdleSelected([]);
    setIdleAiMap({});
    setIdleAiMeta({ source: '', error: '' });
    setIdleAiProgress(null);
    try {
      const res = await window.electronAPI.resource.listIdleSkills({ days: n });
      if (!res.success) {
        setError(res.error || t('resources.cleanupScanFailed'));
        if (closeOnError) setCleanupOpen(false);
        return;
      }
      setIdleResult(res);
      // 先进入分析态再结束扫描态，避免中间一帧露出未分析列表
      if ((res.items || []).length) setIdleAiLoading(true);
      setIdleLoading(false);
      // 扫描完成后分批分析；结果在分析结束后再展示
      await analyzeIdleWithAi(res.items || [], n);
    } catch (e) {
      setError(e.message);
      if (closeOnError) setCleanupOpen(false);
      setIdleLoading(false);
    } finally {
      setIdleLoading(false);
    }
  }

  /** 打开闲置 Skill 清理面板并扫描 */
  async function openSkillCleanup() {
    if (!window.electronAPI?.resource?.listIdleSkills) return;
    setCleanupOpen(true);
    await scanIdleSkills(idleDays, { closeOnError: true });
  }

  function applyIdleDays(raw) {
    const n = Math.max(1, Math.min(3650, Math.floor(Number(raw) || DEFAULT_IDLE_DAYS)));
    setIdleDays(n);
    saveIdleDays(n);
  }

  function toggleIdleSelected(id) {
    setIdleSelected(prev => (
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    ));
  }

  function toggleIdleSelectAll() {
    const items = idleResult?.items || [];
    const recommended = items.filter((it) => idleAiMap[it.id]?.recommend).map((it) => it.id);
    // 有推荐时：全选推荐 ↔ 清空；无推荐：全选全部 ↔ 清空
    const target = recommended.length ? recommended : items.map((i) => i.id);
    setIdleSelected((prev) => (
      prev.length === target.length && target.every((id) => prev.includes(id)) ? [] : target
    ));
  }

  /** 一键清理勾选的闲置 Skill */
  async function confirmSkillCleanup() {
    if (!idleSelected.length) {
      setError(t('resources.cleanupPick'));
      return;
    }
    if (!window.confirm(t('resources.cleanupConfirm', { n: idleSelected.length, days: idleDays }))) {
      return;
    }
    setBusy('cleanup');
    try {
      const res = await window.electronAPI.resource.cleanupSkills({ resourceIds: idleSelected });
      if (!res.success && !res.cleaned) {
        setError(res.error || t('resources.cleanupFailed'));
        return;
      }
      const failed = (res.results || []).filter(r => !r.success);
      for (const r of res.results || []) {
        if (r.success) removeResourceLocally(r.id);
      }
      setCleanupOpen(false);
      setIdleResult(null);
      setIdleSelected([]);
      if (failed.length) {
        setError(t('resources.cleanupPartial', {
          ok: res.cleaned || 0,
          fail: failed.length,
        }));
      } else {
        setMsg(t('resources.cleanupOk', { n: res.cleaned || 0 }));
      }
      // 已在上方 removeResourceLocally，无需 loadAll
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  function formatIdleTime(ms) {
    if (!ms) return t('resources.cleanupNever');
    try {
      return new Date(ms).toLocaleString();
    } catch {
      return String(ms);
    }
  }

  async function openProjectMenu(e, resourceId) {
    const anchorEl = e.currentTarget; // 存活引用：滚动时据此重定位（异步 await 后 e.currentTarget 会失效）
    const rect = anchorEl.getBoundingClientRect();
    const menuWidth = 224; // w-56
    // 预估高度：标题 + 若干项 + 底栏；实际高度在 layout 后再校正
    const estimatedHeight = 260;
    const margin = 8;
    let x = rect.left;
    let y = rect.bottom + 4;
    // 下方空间不足则向上弹出，避免贴底被裁切
    if (y + estimatedHeight > window.innerHeight - margin) {
      y = Math.max(margin, rect.top - estimatedHeight - 4);
    }
    if (x + menuWidth > window.innerWidth - margin) {
      x = Math.max(margin, window.innerWidth - menuWidth - margin);
    }
    setProjectSelected([]);
    setProjectMenu({
      resourceId,
      x,
      y,
      anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      anchorEl,
    });

    // 先拉最新应用目录（服务端发布后无需重启），再刷新可投射 Agent 列表
    if (!window.electronAPI?.resource?.listAgentTargets) return;
    try {
      try {
        const base = await getSyncServerBase();
        if (base && window.electronAPI.toolsConfig?.importUrl) {
          await window.electronAPI.toolsConfig.importUrl(
            `${base}/api/config/apps`,
            localStorage.getItem('token'),
            { replace: true },
          );
        }
      } catch { /* 离线时沿用本地 yaml */ }
      const agentRes = await window.electronAPI.resource.listAgentTargets();
      if (!agentRes.success) return;
      setAgents(agentRes.agents || []);
      setPromptAgents(agentRes.promptAgents || []);
      setAssistantAgents(agentRes.assistantAgents || []);
      // prompt / 智能体：目标 = 全部已纳管应用（与 Gateway 应用列表同源，保证一致）
      try {
        const apps = await window.electronAPI.apps.list();
        setManagedAppTargets(deriveManagedAppTargets(apps));
      } catch { /* apps 拉取失败时回退到 agents 列表 */ }
    } catch { /* ignore */ }
  }

  async function confirmProject() {
    if (!projectMenu) return;
    if (!projectSelected.length) {
      setError(t('resources.pickAgent'));
      return;
    }
    const { resourceId } = projectMenu;
    // 依赖缺失的智能体：投射到应用前确认
    const target = resources.find(r => r.id === resourceId);
    if (target?.type === 'assistant' && target.depsBroken && target.missingDeps?.length) {
      const list = target.missingDeps.map(d => `${d.type}:${d.name}`).join(', ');
      if (!window.confirm(t('resources.depsBrokenConfirm', { list }))) return;
    }
    setProjectMenu(null);
    setBusy(resourceId);
    setError('');
    try {
      const res = await projectWithGuard({ resourceId, agentIds: projectSelected }, { t, name: target?.display_name || target?.name });
      if (res.canceled) return;
      if (!res.success) {
        setError(res.error || t('resources.projectFailed'));
        return;
      }
      // 目标处存在同名的其他目录：默认不覆盖，询问后再强制
      let finalRes = res;
      if (res.conflicts?.length
        && window.confirm(t('resources.forceProjectConfirm', { hint: res.hint || '' }))) {
        finalRes = await window.electronAPI.resource.project({
          resourceId,
          agentIds: projectSelected,
          force: true,
          allowRisky: true, // 走到这里说明不是高风险，或用户已确认过
        });
        if (finalRes.success) setMsg(finalRes.hint || t('resources.projectOk'));
        else setError(finalRes.error || t('resources.projectFailed'));
      } else if (res.conflicts?.length) {
        setMsg(res.hint || t('resources.projectSkippedConflict'));
      } else {
        setMsg(res.hint || t('resources.projectOk'));
      }
      // 用返回资源局部更新投射状态，避免整页重刷
      if (finalRes?.success && finalRes.resource) {
        applyResourcePatch(resourceId, finalRes.resource);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  /** 取消投射：优先按 projectionId，避免同 agent 多条时误删/找不到 */
  async function handleUnproject(resource, projOrAgentId) {
    const resourceId = resource?.id || resource?.resourceId;
    const proj = projOrAgentId && typeof projOrAgentId === 'object' ? projOrAgentId : null;
    const agentId = proj ? proj.agentId : projOrAgentId;
    if (!resourceId || !agentId) return;

    const busyKey = `${resourceId}-${agentId}`;
    setBusy(busyKey);
    setError('');
    // 先乐观去掉标签，避免「点了没反应」的观感；失败再回滚
    const prevProjs = resource.projections || [];
    const optimistic = prevProjs.filter((p) => (proj?.id ? p.id !== proj.id : p.agentId !== agentId));
    applyResourcePatch(resourceId, { ...resource, id: resourceId, projections: optimistic });

    try {
      const res = await window.electronAPI.resource.unproject({
        resourceId,
        agentId,
        ...(proj?.id ? { projectionId: proj.id } : {}),
      });
      if (!res?.success) {
        applyResourcePatch(resourceId, { ...resource, id: resourceId, projections: prevProjs });
        const err = res?.error || t('resources.unprojectFailed');
        setError(err);
        window.alert(err);
        return;
      }
      if (res.resource) applyResourcePatch(resourceId, res.resource);
      setMsg(t('resources.unprojectOk'));
    } catch (e) {
      applyResourcePatch(resourceId, { ...resource, id: resourceId, projections: prevProjs });
      const err = e?.message || t('resources.unprojectFailed');
      setError(err);
      window.alert(err);
    } finally {
      setBusy('');
    }
  }

  /** Hit-or-Exit：对该资源撤掉全部投射（沉睡/休眠轻推，不进清理面板） */
  async function handleUnprojectAll(resource) {
    const projs = resource?.projections || [];
    if (!projs.length) {
      setMsg(t('resources.layer.alreadyCold'));
      return;
    }
    const name = resource.display_name || resource.name || '';
    if (!window.confirm(t('resources.layer.unprojectConfirm', { name, n: projs.length }))) return;
    setBusy(`cold-${resource.id}`);
    setError('');
    try {
      let last = resource;
      for (const p of projs) {
        const res = await window.electronAPI.resource.unproject({
          resourceId: resource.id,
          agentId: p.agentId,
          projectionId: p.id,
        });
        if (!res.success) {
          setError(res.error || t('resources.unprojectFailed'));
          return;
        }
        last = res.resource || { ...last, projections: (last.projections || []).filter(x => x.id !== p.id) };
      }
      applyResourcePatch(resource.id, { ...last, projections: [] });
      setMsg(t('resources.layer.unprojectDone', { name }));
    } finally {
      setBusy('');
    }
  }

  /** 批量撤投射（系列 / 投射检查），一次确认 */
  async function handleUnprojectMany(list, label, busyKey = 'cold-bulk') {
    const targets = (list || []).filter(r => r?.id && (r.projections || []).length);
    if (!targets.length) {
      setMsg(t('resources.layer.alreadyCold'));
      return;
    }
    const total = targets.reduce((n, r) => n + r.projections.length, 0);
    if (!window.confirm(t('resources.layer.unprojectManyConfirm', { name: label, n: targets.length, p: total }))) return;
    setBusy(busyKey);
    setError('');
    let done = 0;
    try {
      for (const r of targets) {
        let last = r;
        for (const p of r.projections) {
          const res = await window.electronAPI.resource.unproject({
            resourceId: r.id,
            agentId: p.agentId,
            projectionId: p.id,
          });
          if (!res.success) {
            setError(res.error || t('resources.unprojectFailed'));
            return;
          }
          last = res.resource || last;
        }
        applyResourcePatch(r.id, { ...last, projections: [] });
        done += 1;
      }
      setMsg(t('resources.layer.unprojectManyDone', { n: done }));
    } finally {
      setBusy('');
    }
  }

  function openCreateEditor(presetType, pickType = false) {
    const type = ['prompt', 'skill', 'assistant'].includes(presetType)
      ? presetType
      : (['prompt', 'skill', 'assistant'].includes(typeFilter) ? typeFilter : 'prompt');
    setEditorForm({
      ...EMPTY_EDITOR,
      type,
      pickType,
      // 新建时若正筛「图片」提示词，默认归为图片类
      promptKind: typeFilter === 'prompt' && promptKindFilter === 'image' ? 'image' : 'text',
      // 当前标签筛选项预填，便于归类
      tagsText: tagFilter || '',
      metadata: {},
    });
    setEditorOpen(true);
  }

  /** 新建智能体的第一步：只填一句话描述 */
  const asstIsNew = () => editorForm.type === 'assistant' && !editorForm.id;
  const asstBrief = () => asstIsNew() && editorForm.asStep === 'brief';
  /** 新建提示词默认只露出内容；其余字段收进「更多设置」 */
  const quickPrompt = () => editorForm.type === 'prompt' && !editorForm.id && !editorForm.moreOpen;
  /** 新建智能体本次要付费纳管的技能数 / 总积分（价格未知时为 null） */
  const asstPaidCount = () => (editorForm.suggestSkills || []).filter((c) => c.checked && c.paid).length;
  const asstCost = () => {
    const n = asstPaidCount();
    if (!n) return 0;
    return editorForm.installCost != null ? Math.round(editorForm.installCost * n * 100) / 100 : null;
  };

  /** Skill 类型：打开安装对话框，由资源安装智能体执行 */

  function openEditEditor(resource) {
    const base = {
      id: resource.id,
      type: resource.type || 'prompt',
      name: resource.name || '',
      display_name: resource.display_name || resource.name || '',
      description: resource.description || '',
      detail: String(resource.metadata?.detail || resource.detail || ''),
      content: resource.content || '',
      promptKind: promptKindOf(resource),
      tagsText: resourceTags(resource).join(', '),
      // 保留原 metadata，避免编辑时冲掉其它字段
      metadata: { ...(resource.metadata || {}) },
      nlBrief: '',
      soul: '',
      skills: [],
      prompts: [],
      runtime_agent: '',
      parameters: null,
      assistantExtra: {},
      skillQuery: '',
      promptQuery: '',
    };
    if ((resource.type || '') === 'assistant') {
      const parsed = parseAssistantEditorContent(resource.content || '');
      Object.assign(base, {
        soul: parsed.soul,
        skills: parsed.skills,
        prompts: parsed.prompts,
        runtime_agent: parsed.runtime_agent,
        parameters: parsed.parameters,
        assistantExtra: parsed.extra || {},
      });
    }
    setEditorForm(base);
    setEditorOpen(true);
  }

  /** 自然语言 → 填充智能体表单（名称/人设/建议绑定的 skill 与提示词） */
  async function generateAssistantNl() {
    const brief = String(editorForm.nlBrief || '').trim();
    if (brief.length < 4) {
      setError(t('resources.assistantNlTooShort'));
      return;
    }
    setBusy('assistant-nl');
    setError('');
    try {
      const skillCandidates = (resources || [])
        .filter((r) => r.type === 'skill')
        .map((r) => ({
          name: r.name,
          display_name: r.display_name || r.name,
          description: r.description || '',
        }));
      const promptCandidates = (resources || [])
        .filter((r) => r.type === 'prompt')
        .map((r) => ({
          name: r.name,
          display_name: r.display_name || r.name,
          description: r.description || '',
        }));
      const communityCandidates = (catalog || [])
        .filter((c) => c.type === 'skill' && !c.installed && !isBuiltinResource(c))
        .map((c) => ({
          catalogId: c.catalogId,
          name: c.name,
          display_name: c.display_name || resourceDisplayName('skill', c) || c.name,
          description: resourceDescription(c) || '',
          paid: !!(c.metadata?.user_recommended && c.metadata?.recommender_user_id),
        }));
      const gen = await generateAssistantFromNl(brief, skillCandidates, promptCandidates, communityCandidates);
      let installCost = null;
      if ((gen.communitySkills || []).some((c) => c.paid) && localStorage.getItem('token')) {
        try { installCost = Number((await getCommunityCatalogPricing()).data?.install_cost); } catch { /* 价格未知时按「付费」显示 */ }
      }
      setEditorForm((prev) => ({
        ...prev,
        // 已有 id 时不改英文标识，避免冲突
        name: prev.id ? prev.name : (prev.name || gen.name || slugifyAssistantId(gen.display_name)),
        display_name: gen.display_name || prev.display_name,
        description: gen.description || prev.description,
        soul: gen.soul,
        skills: gen.skills || [],
        prompts: gen.prompts || [],
        tagsText: (gen.tags || []).join(', ') || prev.tagsText,
        asStep: 'form',
        // 创建时默认一起纳管
        suggestSkills: (gen.communitySkills || []).map((c) => ({ ...c, checked: true })),
        missingCaps: gen.missing || [],
        installCost: Number.isFinite(installCost) ? installCost : null,
      }));
      setMsg(t('resources.assistantNlOk'));
    } catch (e) {
      const code = e?.message || '';
      // 生成失败不卡在第一步：转手动，把描述带进人设
      if (code !== 'brief_too_short') {
        setEditorForm((prev) => ({
          ...prev,
          asStep: 'form',
          soul: prev.soul || brief,
          description: prev.description || brief.slice(0, 60),
        }));
      }
      if (code === 'brief_too_short') setError(t('resources.assistantNlTooShort'));
      else if (code === 'llm_unavailable') setError(t('resources.assistantNlNoLlmManual'));
      else if (code === 'soul_too_short' || code === 'bad_llm_json') setError(t('resources.assistantNlBad'));
      else setError(t('resources.assistantNlFailed', { detail: String(code).slice(0, 120) }));
    } finally {
      setBusy('');
    }
  }

  function toggleEditorSkill(skillName) {
    const name = String(skillName || '').trim();
    if (!name) return;
    setEditorForm((prev) => {
      const cur = Array.isArray(prev.skills) ? prev.skills : [];
      const next = cur.includes(name) ? cur.filter((s) => s !== name) : [...cur, name];
      return { ...prev, skills: next };
    });
  }

  function toggleEditorPrompt(promptName) {
    const name = String(promptName || '').trim();
    if (!name) return;
    setEditorForm((prev) => {
      const cur = Array.isArray(prev.prompts) ? prev.prompts : [];
      const next = cur.includes(name) ? cur.filter((s) => s !== name) : [...cur, name];
      return { ...prev, prompts: next };
    });
  }

  async function saveEditor() {
    let name = String(editorForm.name || '').trim();
    if (!name && editorForm.type === 'assistant' && !editorForm.id) {
      name = slugifyAssistantId(editorForm.display_name || editorForm.description || '', 'assistant-' + Date.now().toString(36));
    }
    // 新建提示词：只写内容也能保存，名称 / 标识 / 简介从内容推出
    let derived = {};
    if (editorForm.type === 'prompt' && !editorForm.id) {
      const body = String(editorForm.content || '').trim();
      if (!body) {
        setError(t('resources.promptContentRequired'));
        return;
      }
      const firstLine = body.split(/\r?\n/).map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '';
      const display = String(editorForm.display_name || '').trim() || (firstLine.length > 24 ? firstLine.slice(0, 24) + '…' : firstLine);
      if (!name) {
        const ascii = display.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        name = ascii.length >= 3 ? ascii : `prompt-${Date.now().toString(36)}`;
      }
      derived = {
        display_name: display,
        description: String(editorForm.description || '').trim() || (body.replace(/\s+/g, ' ').slice(0, 60)),
      };
    }
    if (!name) {
      setError(t('resources.editorNameRequired'));
      return;
    }
    setBusy('editor');
    try {
      const metadata = { ...(editorForm.metadata || {}) };
      if (editorForm.type === 'prompt') {
        metadata.promptKind = editorForm.promptKind === 'image' ? 'image' : 'text';
      }
      metadata.tags = parseTagsInput(editorForm.tagsText);
      const detail = String(editorForm.detail || '').trim();
      if (detail) metadata.detail = detail;
      else delete metadata.detail;
      let content = editorForm.content || '';
      // 新建技能：正文没写 YAML 头时按名称和描述补上，生成标准 SKILL.md
      if (editorForm.type === 'skill' && !/^\s*---/.test(content)) {
        const esc = (v) => String(v || '').replace(/\r?\n/g, ' ').replace(/"/g, '\\"');
        const header = `---\nname: ${name}\ndescription: "${esc(editorForm.description || editorForm.display_name || name)}"\n---\n\n`;
        content = header + (content.trim() || `# ${editorForm.display_name || name}\n`);
      }
      // 智能体：用人设 + 勾选 skill / prompt 拼 JSON
      let extraSkills = [];
      let skillInstallNote = '';
      if (editorForm.type === 'assistant' && !editorForm.id) {
        const picked = (editorForm.suggestSkills || []).filter((c) => c.checked);
        const paid = picked.filter((c) => c.paid);
        if (paid.length && !localStorage.getItem('token')) {
          setError(t('resources.recommendNeedLogin'));
          setBusy('');
          return;
        }
        if (paid.length) {
          const total = editorForm.installCost != null ? editorForm.installCost * paid.length : null;
          const ok = window.confirm(total != null
            ? t('resources.assistantPaidConfirm', { n: paid.length, cost: total })
            : t('resources.assistantPaidConfirmUnknown', { n: paid.length }));
          if (!ok) { setBusy(''); return; }
        }
        const failed = [];
        for (const c of picked) {
          const r = await installCatalogQuiet(c);
          if (r.ok) extraSkills.push(r.name || c.name);
          else failed.push(c.display_name || c.name);
        }
        if (picked.length) {
          skillInstallNote = failed.length
            ? t('resources.assistantSkillsPartial', { ok: extraSkills.length, failed: failed.join('、') })
            : t('resources.assistantSkillsInstalled', { n: extraSkills.length });
        }
      }
      if (editorForm.type === 'assistant') {
        const soul = String(editorForm.soul || '').trim();
        if (!soul) {
          setError(t('resources.assistantSoulRequired'));
          setBusy('');
          return;
        }
        content = buildAssistantContent({
          soul,
          skills: [...new Set([...(editorForm.skills || []), ...extraSkills])],
          prompts: editorForm.prompts || [],
          runtime_agent: editorForm.runtime_agent || '',
          parameters: editorForm.parameters,
          extra: editorForm.assistantExtra || {},
        });
        metadata.source = metadata.source || (editorForm.id ? metadata.source : 'composed');
        if (!editorForm.id) metadata.composed = true;
      }
      const res = await window.electronAPI.resource.saveResource({
        id: editorForm.id || undefined,
        type: editorForm.type,
        name,
        display_name: derived.display_name || editorForm.display_name || name,
        description: derived.description ?? (editorForm.description || ''),
        content,
        metadata,
      });
      if (!res.success) {
        setError(res.error || t('resources.saveFailed'));
        return;
      }
      setEditorOpen(false);
      setMsg(t('resources.saveOk'));
      changeViewTab('managed');
      if (res.resource) upsertResourceLocally(res.resource);
      // 新建：保存后直接启用（投射到常用应用 + 复制调用口令），并在对应类型列表里选中
      if (res.resource && !editorForm.id) {
        focusResource(res.resource);
        const note = await enableResource(res.resource);
        if (note || skillInstallNote) setMsg([skillInstallNote, note].filter(Boolean).join(' · '));
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function handleImportFile() {
    setBusy('import');
    try {
      const pick = await window.electronAPI.resource.pickImportPath({
        title: t('resources.importPickTitle'),
      });
      if (!pick.success) {
        if (!pick.canceled && pick.error) setError(pick.error);
        return;
      }
      const res = await window.electronAPI.resource.importFromPath({
        sourcePath: pick.path,
        type: typeFilter || undefined,
      });
      if (!res.success) {
        setError(res.error || t('resources.importFailed'));
        return;
      }
      if (res.hint) setMsg(res.hint);
      else if (res.alreadyInstalled) setMsg(t('resources.alreadyManaged'));
      else setMsg(t('resources.importOk'));
      changeViewTab('managed');
      if (res.resource) {
        upsertResourceLocally(res.resource);
        focusResource(res.resource);
        const note = await enableResource(res.resource);
        if (note) setMsg(note);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  // 目录 / 本机：提示词按文本|图片子类筛选
  const matchPromptKind = (r) => {
    if (typeFilter !== 'prompt' || !promptKindFilter) return true;
    if (r.type && r.type !== 'prompt') return true;
    return promptKindOf(r) === promptKindFilter;
  };

  /** 资源用途列表（含发现项从已纳管补 tags） */
  const purposesOf = useCallback((item, managedLookup) => {
    let probe = item;
    if (managedLookup && !(resourceTags(item).length || item?.metadata?.category)) {
      if (item?.resourceId && managedLookup.get(item.resourceId)) {
        probe = managedLookup.get(item.resourceId);
      } else if (item?.name) {
        const byName = [...managedLookup.values()].find(
          r => r.name === item.name && r.type === (item.type || 'skill'),
        );
        if (byName) probe = byName;
      }
    }
    return resolvePurposes(probe, purposeAiMap);
  }, [purposeAiMap]);

  /** 用途匹配（other = 未归入任一一级用途） */
  const matchTag = (item, managedLookup) => {
    if (!tagFilter) return true;
    const ps = purposesOf(item, managedLookup);
    if (tagFilter === PURPOSE_OTHER) return ps.length === 0;
    return ps.includes(tagFilter);
  };

  /** 名称/描述/标签本地搜索（不再靠后端 query 重扫） */
  const matchQuery = useCallback((item) => {
    const q = String(debouncedQuery || '').trim().toLowerCase();
    if (!q) return true;
    const hay = [
      item?.name, item?.display_name, item?.description,
      ...(resourceTags(item) || []),
      item?.metadata?.category,
    ].filter(Boolean).join('\n').toLowerCase();
    return hay.includes(q);
  }, [debouncedQuery]);

  // 类型切换：目录项必须与 typeFilter 一致（空=全部）
  // 旧版本的系统智能体（画像 / 发现 / 安装）已并入看护执行引擎；清理完成前的残留与旧目录缓存也不列出
  const shownResources = useMemo(() => resources.filter(r => !isBuiltinResource(r)), [resources]);
  const filteredCatalog = catalog.filter(r =>
    !isBuiltinResource(r)
    && (!typeFilter || r.type === typeFilter)
    && matchPromptKind(r) && matchTag(r) && matchQuery(r),
  );
  // 已纳管计数：跟随当前类型筛选，避免「智能体」Tab 显示全库数量
  const managedCount = typeFilter
    ? shownResources.filter(r => r.type === typeFilter).length
    : shownResources.length;
  const discoveredCount = scanStats?.totalOnDisk ?? discovered.length;
  const showSkillTabs = !typeFilter || typeFilter === 'skill';
  const isMcp = typeFilter === 'mcp';

  // 当前类型下的已纳管资源（分层/轻推与列表共用，避免串类型）
  const resourcesInType = useMemo(
    () => (typeFilter ? shownResources.filter(r => r.type === typeFilter) : shownResources),
    [shownResources, typeFilter],
  );

  // Hit-or-Exit：轻推条 + 分层计数
  const lifecycleNudges = useMemo(() => {
    const now = Date.now();
    return resourcesInType
      .filter((r) => !isLifecycleExempt(r))
      .map((r) => ({ r, life: classifyLifecycle(r, now) }))
      .filter(({ life }) => life.nudge)
      .filter(({ r }) => !(nudgeSnooze[r.id] && nudgeSnooze[r.id] > now))
      .sort((a, b) => b.life.ageMs - a.life.ageMs);
  }, [resourcesInType, nudgeSnooze]);

  // 投射检查按系列合并：同系列一个条目，一次处理整组
  const nudgeGroups = useMemo(() => {
    const blocks = groupBySeries(lifecycleNudges, ({ r }) => (r.type === 'skill' ? seriesKeyOf(r) : ''));
    return blocks.map((b) => {
      const list = b.group ? b.group.rows : [b.row];
      const unproject = list.filter(x => x.life.nudge !== 'invoke');
      return {
        key: b.group ? `g-${b.group.key}` : b.row.r.id,
        label: b.group ? b.group.label : (b.row.r.display_name || b.row.r.name),
        series: !!b.group,
        list,
        mode: unproject.length ? 'unproject' : 'invoke',
      };
    });
  }, [lifecycleNudges]);

  function snoozeNudges(list) {
    const until = Date.now() + 7 * 24 * 60 * 60 * 1000;
    setNudgeSnooze((prev) => {
      const next = {};
      const now = Date.now();
      for (const [k, v] of Object.entries(prev)) if (v > now) next[k] = v;
      for (const { r } of list) next[r.id] = until;
      writeJson(NUDGE_SNOOZE_KEY, next);
      return next;
    });
  }

  // 分层计数：空层不占筛选位（Simplicity）
  // 管家体检里要用户处理的：有风险、需完善、有新版本
  const hasAssetIssue = useCallback((id) => {
    const f = id && assetFlags[id];
    if (id && blockedAssistants[id]) return true;
    return !!(f && (f.security === 'high' || f.quality === 'warn' || f.updateAvailable));
  }, [assetFlags, blockedAssistants]);
  const layerCounts = useMemo(() => {
    const counts = { active: 0, pending: 0, dormant: 0, cold: 0, shelf: 0, idle: 0, issue: 0 };
    for (const r of resourcesInType) {
      if (hasAssetIssue(r.id)) counts.issue += 1;
      if (isLifecycleExempt(r)) continue;
      const layer = classifyLifecycle(r).layer;
      if (counts[layer] != null) counts[layer] += 1;
      if (IDLE_LAYERS.has(layer)) counts.idle += 1;
    }
    return counts;
  }, [resourcesInType, hasAssetIssue]);

  const changeLayerFilter = useCallback((next) => {
    setLayerFilter(next);
    try { localStorage.setItem(LAYER_FILTER_KEY, next); } catch { /* ignore */ }
  }, []);

  const copyInvokeFor = useCallback(async (resource) => {
    const text = buildInvokeText(resource, lang === 'en' ? 'en' : 'zh');
    if (!text) return;
    const ok = await copyText(text);
    setMsg(ok
      ? t('resources.enabledWithInvoke', { name: resource.display_name || resource.name, invoke: text })
      : text);
  }, [lang, t]);

  // 「本机」Tab 计数：技能=磁盘总数;提示词/助手=该类型已纳管数;全部=非 skill 已纳管 + 磁盘 skill
  const localCount = typeFilter === 'mcp'
    ? mcpCount
    : typeFilter === 'skill'
      ? discoveredCount
      : typeFilter
        ? managedCount
        : resources.filter(r => r.type !== 'skill').length + discoveredCount;

  // 类型分段计数（资产库）：技能以本机扫描为准，扫描为空时回退已纳管 skill
  const typeCounts = useMemo(() => {
    const skill = discovered.length > 0 ? discoveredCount : resources.filter(r => r.type === 'skill').length;
    const prompt = shownResources.filter(r => r.type === 'prompt').length;
    const assistant = shownResources.filter(r => r.type === 'assistant').length;
    return { all: skill + prompt + assistant, skill, prompt, assistant, mcp: mcpCount || 0 };
  }, [discovered.length, discoveredCount, resources, shownResources, mcpCount]);

  // 键盘：/ 聚焦搜索；资产库中 ↑↓ 切换选中行，Esc 关闭详情
  useEffect(() => {
    if (!pageActive) return undefined;
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable;
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (typing || viewTab !== 'managed' || editorOpen || projectMenu) return;
      // 下拉 / 菜单弹层打开时，Esc 与方向键交给弹层
      if (document.querySelector('body > [role="listbox"], body > [role="menu"]')) return;
      if (e.key === 'Escape' && selectedKey) { setSelectedKey(null); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const keys = visibleKeysRef.current;
      if (!keys.length) return;
      e.preventDefault();
      const i = keys.indexOf(selectedKey);
      const next = e.key === 'ArrowDown'
        ? keys[Math.min(keys.length - 1, i + 1)]
        : keys[Math.max(0, i < 0 ? 0 : i - 1)];
      setSelectedKey(next);
      requestAnimationFrame(() => {
        document.querySelector(`[data-lib-key="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' });
      });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pageActive, viewTab, selectedKey, editorOpen, projectMenu]);

  // 用户没手动选过 Tab 时：本机已有资产就默认落在「已纳管」，避免首屏停在空的推荐页
  const autoViewTabRef = useRef(false);
  useEffect(() => {
    if (autoViewTabRef.current || loading) return;
    let saved = null;
    try { saved = localStorage.getItem(VIEW_TAB_KEY); } catch { /* ignore */ }
    // 扫描结果可能晚于首屏加载到达：计数仍为 0 时不锁定，等后续计数更新再判断
    if (saved || localCount > 0) autoViewTabRef.current = true;
    if (!saved && localCount > 0) setViewTab('managed');
  }, [loading, localCount]);

  // 应用筛选：prompt / skill / 智能体均按已纳管应用
  const installedFilterAgents = agents;
  const appFilterOptions = (() => {
    const map = new Map();
    for (const a of installedFilterAgents) {
      if (!isAgentAppId(a.id)) continue;
      map.set(a.id, a.label || a.id);
    }
    return [{ id: '', label: t('resources.appFilterAll') }, ...[...map.entries()]
      .sort((a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: 'base' }))
      .map(([id, label]) => ({ id, label }))];
  })();

  // 若上次筛到了当前类型不可用的 Agent，回退到全部
  const effectiveAppFilter = (() => {
    if (!appFilter) return '';
    if (!isAgentAppId(appFilter)) return '';
    if (!appFilterOptions.some((o) => o.id === appFilter)) return '';
    return appFilter;
  })();

  const resourcesById = useMemo(
    () => new Map(resources.map(r => [r.id, r])),
    [resources],
  );

  /** agentId → 应用展示名：投射标签缺 label 时回退用，避免直接暴露 app-xxxx 原始 id */
  const appNameById = useMemo(() => {
    const map = new Map();
    for (const a of managedAppTargets) {
      if (a?.id && a.label) map.set(a.id, a.label);
    }
    for (const a of agents) {
      if (a?.id && a.label && !map.has(a.id)) map.set(a.id, a.label);
    }
    return map;
  }, [managedAppTargets, agents]);

  /** `${type}:${name}` → 声明绑定它的智能体列表（skill / prompt） */
  const resourceBoundByAssistants = useMemo(() => {
    const map = new Map();
    const add = (type, name, binder) => {
      const n = String(name || '').trim();
      if (!n) return;
      const key = `${type}:${n}`;
      if (!map.has(key)) map.set(key, []);
      const list = map.get(key);
      if (!list.some((x) => x.id === binder.id || x.name === binder.name)) {
        list.push(binder);
      }
    };
    for (const a of assistantsForBind) {
      const { skills, prompts } = depsFromAssistantContent(a.content);
      if (!skills.length && !prompts.length) continue;
      const binder = {
        id: a.id,
        name: a.name,
        label: a.display_name || a.name || a.id,
      };
      for (const sk of skills) add('skill', sk, binder);
      for (const pr of prompts) add('prompt', pr, binder);
    }
    return map;
  }, [assistantsForBind]);

  /** 各 Agent / 自添目录的本机技能数（来自 listAgentInstallations） */
  const skillCountByAgentId = useMemo(() => {
    const m = new Map();
    for (const a of agentInstallations) {
      if (a.id === 'custom') continue;
      m.set(a.id, a.count || 0);
    }
    return m;
  }, [agentInstallations]);

  const skillCountByCustomDir = useMemo(() => {
    const m = new Map();
    const custom = agentInstallations.find(a => a.id === 'custom');
    for (const item of custom?.items || []) {
      const root = item.customScanRoot;
      if (!root) continue;
      m.set(root, (m.get(root) || 0) + 1);
    }
    return m;
  }, [agentInstallations]);

  function countForCustomScanDir(dir) {
    for (const [root, n] of skillCountByCustomDir) {
      if (sameSkillDir(root, dir)) return n;
    }
    return 0;
  }

  const filteredDiscovered = discovered
    .filter(item => !effectiveAppFilter || (item.agents || []).some(a => a.agentId === effectiveAppFilter))
    .filter(item => matchTag(item, resourcesById))
    .filter(item => matchQuery(item));

  /**
   * 用途芯片：只展示「当前 Tab + 类型 + 应用筛选」下至少有一张卡片的用途。
   * 不计入 tagFilter 本身，否则选中后其它芯片会全部消失。
   * 同时统计各用途数量（一项可归入多个用途）与「全部」可见项总数。
   */
  const { availableTags, purposeCounts, purposeTotal, purposeOther } = useMemo(() => {
    const counts = Object.fromEntries(PURPOSE_SLUGS.map(s => [s, 0]));
    let total = 0;
    let other = 0;

    const visit = (item, managedLookup) => {
      total += 1;
      const ps = purposesOf(item, managedLookup).filter(p => counts[p] != null);
      if (!ps.length) {
        other += 1;
        return;
      }
      for (const p of ps) counts[p] += 1;
    };

    if (viewTab === 'managed') {
      // 与 renderLocalList 可见行对齐（不含用途筛选）
      if (!typeFilter || typeFilter !== 'skill') {
        const managedItems = typeFilter
          ? resources.filter(r => r.type === typeFilter)
          : resources.filter(r => r.type !== 'skill');
        for (const r of managedItems) {
          if (r.type === 'prompt' && !matchPromptKind(r)) continue;
          if (effectiveAppFilter
            && !(r.projections || []).some(p => p.agentId === effectiveAppFilter)) continue;
          visit(r);
        }
      }
      if (!typeFilter || typeFilter === 'skill') {
        for (const item of discovered) {
          if (effectiveAppFilter
            && !(item.agents || []).some(a => a.agentId === effectiveAppFilter)) continue;
          visit(item, resourcesById);
        }
      }
    } else {
      // 推荐 Tab：个性化缓存 + 下方社区目录
      try {
        const rt = typeFilter === 'prompt' || typeFilter === 'assistant' ? typeFilter : 'skill';
        const raw = localStorage.getItem(`tokenbank.resources.recommend.last.${rt}`);
        const doc = raw ? JSON.parse(raw) : null;
        for (const rec of (doc?.items || [])) {
          total += 1;
          const cat = String(rec?.category || '').trim();
          if (!cat) { other += 1; continue; }
          const purpose = PURPOSE_SLUGS.includes(cat) ? cat : tagToPurpose(cat, purposeAiMap);
          if (!purpose || counts[purpose] == null) { other += 1; continue; }
          counts[purpose] += 1;
        }
      } catch { /* ignore */ }
      for (const r of catalog) {
        if (typeFilter && r.type && r.type !== typeFilter) continue;
        if (!matchPromptKind(r)) continue;
        visit(r);
      }
    }

    return {
      availableTags: PURPOSE_SLUGS.filter(s => counts[s] > 0),
      purposeCounts: counts,
      purposeTotal: total,
      purposeOther: other,
    };
  }, [
    viewTab, typeFilter, promptKindFilter, effectiveAppFilter,
    resources, discovered, catalog, resourcesById, purposeAiMap,
    recoPurposeRev, purposesOf,
  ]);

  // 用途筛选项已不存在时回退（含「其它」）
  useEffect(() => {
    if (!tagFilter) return;
    if (tagFilter === PURPOSE_OTHER) {
      if (purposeOther <= 0) setTagFilter('');
      return;
    }
    if (availableTags.length && !availableTags.includes(tagFilter)) {
      setTagFilter('');
    }
  }, [tagFilter, availableTags, purposeOther]);

  // 未知原始标签 → 调本地网关 AI 归入用途（有缓存，失败静默）
  useEffect(() => {
    const raw = new Set();
    const collect = (item) => {
      if (typeFilter && item.type && item.type !== typeFilter) return;
      for (const t of resourceTags(item)) raw.add(t);
      if (item?.metadata?.category) raw.add(item.metadata.category);
    };
    catalog.forEach(collect);
    resources.forEach(collect);
    discovered.forEach(collect);
    const unknown = [...raw].filter(t => !tagToPurpose(t, purposeAiMap));
    if (!unknown.length) return undefined;
    let cancelled = false;
    aggregateTagsWithAi(unknown, purposeAiMap).then((next) => {
      if (cancelled) return;
      const grew = unknown.some((t) => {
        const k = String(t || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
        return next[k] && next[k] !== purposeAiMap[k];
      });
      if (grew) setPurposeAiMap(next);
    });
    return () => { cancelled = true; };
  }, [catalog, resources, discovered, typeFilter]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅资源变化时尝试 AI 归类

  // Skill / Prompt / 智能体均可按主公（Cursor 等）筛选投射目标
  const showAppFilterBar = !typeFilter
    || typeFilter === 'skill'
    || typeFilter === 'prompt'
    || typeFilter === 'assistant';

  /** 用途筛选条：零散 tag 已聚合成 SkillHub 一级用途 */
  function purposeLabel(slug) {
    if (slug === PURPOSE_OTHER) return t('resources.tagFilterOther');
    const key = `resources.reco.cat.${slug}`;
    const v = t(key);
    return v === key ? slug : v;
  }

  /** 用途芯片：玻璃底 + 选中亮片，去掉蓝边网页感 */
  function purposeChipClass(active, size = 'md') {
    const pad = size === 'sm' ? 'text-[10px] px-2 py-0.5 rounded-md' : 'text-[11px] px-2.5 py-1 rounded-lg';
    const round = size === 'sm' ? '!rounded-md' : '!rounded-lg';
    return active
      ? `tb-press tb-soft-bubble ${pad} text-zinc-900 dark:text-zinc-100 font-medium`
      : `tb-press tb-soft-tile ${pad} ${round} text-zinc-600 dark:text-zinc-400`;
  }

  /** 用量徽标：行自身优先，Skill 扫描行回退已纳管资源 */
  function renderUseCountBadge(item) {
    const linked = item?.resourceId ? resourcesById.get(item.resourceId) : null;
    const n = Math.max(0, Number(item?.use_count ?? linked?.use_count ?? 0) || 0);
    if (n <= 0) return null;
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 tabular-nums whitespace-nowrap"
        title={t('resources.useCountHint', { n })}
      >
        {t('resources.useCount', { n })}
      </span>
    );
  }

  /** Skill/Prompt 被智能体 content.skills / prompts 声明绑定 → 卡片标记 */
  function renderAssistantBoundBadge(type, name) {
    if (type !== 'skill' && type !== 'prompt') return null;
    const binders = resourceBoundByAssistants.get(`${type}:${String(name || '').trim()}`);
    if (!binders?.length) return null;
    const sep = lang === 'en' ? ', ' : '、';
    const list = binders.map((b) => b.label).join(sep);
    const label = binders.length === 1
      ? t('resources.assistantBoundOne', { name: binders[0].label })
      : t('resources.assistantBoundMany', { n: binders.length });
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded-md bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 whitespace-nowrap"
        title={t('resources.assistantBoundHint', { list })}
      >
        {label}
      </span>
    );
  }

  function renderProjections(resource, { inline = false } = {}) {
    // 只展示真实 Agent 应用的投射；.agents / custom 等公共目录不显示为应用标签
    const projs = (resource.projections || []).filter(p => isAgentAppId(p.agentId));
    const authorityPath = resource.authorityPath || getSkillLocation(resource);
    if (!projs.length) {
      return <span className="text-[10px] text-zinc-400">{t('resources.notProjected')}</span>;
    }
    const Wrap = inline ? React.Fragment : 'div';
    return (
      <Wrap {...(inline ? {} : { className: 'flex flex-wrap gap-1.5 mt-1' })}>
        {projs.map(p => {
          // 权威源唯一不可取消；其它软链/副本/多余实体均可 ×
          const canUnproject = canUnprojectProjection(p, authorityPath);
          const isAuthority = isAuthorityProjection(p, authorityPath);
          let typeLabel;
          if (isAuthority) {
            typeLabel = t('resources.projType.scan');
          } else if (p.projectionType === 'scan' || p.projectionType === 'origin') {
            typeLabel = t('resources.projType.extra');
          } else {
            const typeKey = `resources.projType.${p.projectionType}`;
            const typeRaw = t(typeKey);
            typeLabel = typeRaw === typeKey ? (p.projectionType || '') : typeRaw;
          }
          const pathLine = p.targetPath
            ? t('resources.projHover', { type: typeLabel, path: p.targetPath })
            : t('resources.projHoverNoPath', { type: typeLabel });
          const hoverTitle = canUnproject
            ? pathLine
            : `${pathLine}\n${t('resources.projAuthorityHint')}`;
          return (
            <span
              key={p.id}
              title={hoverTitle}
              className={`tb-tag text-[10px] pl-2 ${canUnproject ? 'pr-0.5' : 'pr-2'} py-0.5 cursor-default ${
                canUnproject ? 'tb-tag-blue' : 'tb-tag-muted !border-solid'
              }`}
            >
              {/* p.label 对自定义应用回退成 agentId（后端无友好名），此时用 apps 列表的展示名 */}
              {(p.label && p.label !== p.agentId)
                ? p.label
                : (appNameById.get(p.agentId) || p.agentId)}
              {canUnproject && (
                <button
                  type="button"
                  className="tb-press electron-no-drag ml-0.5 w-4 h-4 inline-flex items-center justify-center rounded-full text-current/55 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40"
                  title={t('resources.unproject')}
                  aria-label={t('resources.unproject')}
                  disabled={busy === `${resource.id || resource.resourceId}-${p.agentId}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleUnproject(resource, p);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </Wrap>
    );
  }

  /**
   * 「本机」Tab 列表：按类型筛选分流。
   * 技能→扫描行(discovered);提示词/助手→managed 行。
   * 排序：时间 / 字母 / 用量（默认用量）。
   */
  function renderLocalList() {
    const showSkills = !typeFilter || typeFilter === 'skill';
    const nameOf = (item) => String(item?.display_name || item?.name || '').trim();
    const byName = (a, b) => nameOf(a).localeCompare(nameOf(b), 'zh-CN', { sensitivity: 'base' });
    const linkedOf = (item) => (item?.resourceId ? resourcesById.get(item.resourceId) : null);
    // 用量：优先行自身，Skill 扫描行回退到已纳管资源
    const usageOf = (item) => {
      const linked = linkedOf(item);
      const useCount = Math.max(
        0,
        Number(item?.use_count ?? linked?.use_count ?? 0) || 0,
      );
      const lastUsed = Math.max(
        0,
        Number(item?.last_used_at ?? linked?.last_used_at ?? 0) || 0,
      );
      return { useCount, lastUsed };
    };
    const timeOf = (item) => {
      const linked = linkedOf(item);
      const lastUsed = Number(item?.last_used_at ?? linked?.last_used_at ?? 0) || 0;
      const created = Number(
        item?.created_at
        ?? item?.createdAt
        ?? item?.updated_at
        ?? item?.mtimeMs
        ?? item?.mtime
        ?? linked?.created_at
        ?? linked?.updated_at
        ?? 0,
      ) || 0;
      return Math.max(lastUsed, created);
    };
    const byTime = (a, b) => {
      const d = timeOf(b) - timeOf(a);
      return d !== 0 ? d : byName(a, b);
    };
    const byUsage = (a, b) => {
      const ua = usageOf(a);
      const ub = usageOf(b);
      if (ub.useCount !== ua.useCount) return ub.useCount - ua.useCount;
      if (ub.lastUsed !== ua.lastUsed) return ub.lastUsed - ua.lastUsed;
      return byTime(a, b);
    };
    // 默认：有问题的在前，其次最近用过 / 改过的
    const issueOf = (x) => (hasAssetIssue(x?.resourceId || x?.id) ? 1 : 0);
    const bySmart = (a, b) => (issueOf(b) - issueOf(a)) || byTime(a, b);
    const cmp = listSort === 'name' ? byName : listSort === 'time' ? byTime : listSort === 'usage' ? byUsage : bySmart;
    // Hit-or-Exit：与分层计数同源；Skill 扫描行回退到已纳管资源再判定
    const matchLayer = (item) => {
      if (!layerFilter) return true;
      const linked = item?.resourceId ? resourcesById.get(item.resourceId) : null;
      const probe = linked || item;
      if (layerFilter === 'issue') return hasAssetIssue(probe?.id);
      const life = classifyLifecycle(probe);
      if (life.layer === 'exempt') return false;
      if (layerFilter === 'idle') return IDLE_LAYERS.has(life.layer);
      return life.layer === layerFilter;
    };
    // 提示词/智能体：按 typeFilter 收窄；全部时排除 skill（技能走扫描行）
    const managedRows = (typeFilter === 'skill'
      ? []
      : (typeFilter ? resourcesInType : shownResources.filter(r => r.type !== 'skill')))
      .filter(r => {
        if (r.type === 'prompt' && !matchPromptKind(r)) return false;
        if (!matchTag(r)) return false;
        if (!matchQuery(r)) return false;
        if (!matchLayer(r)) return false;
        if (!effectiveAppFilter) return true;
        // Prompt / 智能体：按已投射到的 Agent 筛选
        return (r.projections || []).some(p => p.agentId === effectiveAppFilter);
      })
      .slice();
    // 技能优先磁盘扫描行；扫描为空时回退已纳管 skill（避免分层有数、列表空白）
    const useDiscoveredSkills = showSkills && discovered.length > 0;
    const skillBase = !showSkills
      ? []
      : useDiscoveredSkills
        ? filteredDiscovered
        : resources
          .filter(r => r.type === 'skill')
          .filter(r => matchTag(r) && matchQuery(r))
          .filter(r => !effectiveAppFilter
            || (r.projections || []).some(p => p.agentId === effectiveAppFilter));
    const skillRows = skillBase.filter(matchLayer);

    if (managedRows.length + skillRows.length === 0) {
      // 有本机 skill / 资源,但被来源应用筛选过滤空了
      if (showAppFilterBar && effectiveAppFilter && (discovered.length > 0 || resources.length > 0)) {
        return (
          <div className="space-y-3">
            <div className="text-center py-10 space-y-2">
              <p className="text-xs text-zinc-400">{t('resources.emptyDiscoveredFiltered')}</p>
              <button type="button" onClick={() => changeAppFilter('')} className="text-xs text-blue-600 hover:underline">
                {t('resources.clearAppFilter')}
              </button>
            </div>
          </div>
        );
      }
      if (tagFilter && (discovered.length > 0 || resources.length > 0)) {
        return (
          <div className="space-y-3">
            <div className="text-center py-10 space-y-2">
              <p className="text-xs text-zinc-400">{t('resources.emptyTagFiltered')}</p>
              <button type="button" onClick={() => setTagFilter('')} className="text-xs text-blue-600 hover:underline">
                {t('resources.clearTagFilter')}
              </button>
            </div>
          </div>
        );
      }
      // 分层筛空：提示切回「全部」，避免误显示「暂无已纳管」
      if (layerFilter && resourcesInType.length > 0) {
        return (
          <div className="space-y-3">
            <div className="text-center py-10 space-y-2">
              <p className="text-xs text-zinc-400">{t('resources.emptyLayerFiltered')}</p>
              <button type="button" onClick={() => changeLayerFilter('')} className="text-xs text-blue-600 hover:underline">
                {t('resources.clearLayerFilter')}
              </button>
            </div>
          </div>
        );
      }
      return (
        <div className="space-y-3">
          <div className="text-center py-10 space-y-2">
            <p className="text-xs text-zinc-400">{t('resources.emptyManaged')}</p>
            <button type="button" onClick={() => changeViewTab('recommend')} className="text-xs text-blue-600 hover:underline">
              {t('resources.goCatalog')}
            </button>
          </div>
        </div>
      );
    }

    const rows = [
      ...managedRows.map((item) => ({ key: `r-${item.id}`, kind: 'resource', item })),
      ...skillRows.map((item) => ({
        key: useDiscoveredSkills ? `d-${item.path || item.resourceId || item.name}` : `r-${item.id}`,
        kind: useDiscoveredSkills ? 'discovered' : 'resource',
        item,
      })),
    ]
      .sort((a, b) => cmp(a.item, b.item))
      .map(toLibraryItem);
    // 同系列技能折叠成一组；搜索时全部展开
    const searching = !!debouncedQuery;
    const blocks = groupBySeries(rows, (li) => (li.type === 'skill' ? seriesKeyOf(li.linked || li.item) : ''));
    const isOpen = (g) => searching || openSeries.has(g.key) || g.rows.some(r => r.key === selectedKey);
    const visibleRows = blocks.flatMap(b => (b.group ? (isOpen(b.group) ? b.group.rows : []) : [b.row]));
    visibleKeysRef.current = visibleRows.map(r => r.key);
    // 外部按资产 id 跳来（r-<id>），而技能列表按本机路径做 key（d-…）：换成对应的那一行
    if (selectedKey && selectedKey.startsWith('r-') && !rows.some(r => r.key === selectedKey)) {
      const rid = selectedKey.slice(2);
      const alias = rows.find(r => r.resourceId === rid || r.item?.resourceId === rid || r.item?.id === rid);
      if (alias && alias.key !== selectedKey) setTimeout(() => setSelectedKey(alias.key), 0);
    }
    const selected = rows.find(r => r.key === selectedKey) || null;

    return (
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-2">
          <div className={LIB_LIST_CLS}>
            <div className={`hidden md:grid ${LIB_GRID} gap-3 px-4 py-2 text-[11px] text-zinc-400 border-b border-zinc-100 dark:border-white/[0.05]`}>
              <span>{t('resources.col.name')}</span>
              <span>{t('resources.col.apps')}</span>
              <span className="text-right">{t('resources.col.uses')}</span>
              <span>{t('resources.col.status')}</span>
              <span />
            </div>
            <ul role="listbox" aria-label={t('resources.tab.library')}>
              {blocks.map((b) => {
                if (!b.group) return renderLibraryRow(b.row, b.row.key === selectedKey);
                const open = isOpen(b.group);
                return (
                  <React.Fragment key={`g-${b.group.key}`}>
                    {renderSeriesRow(b.group, open)}
                    {open && b.group.rows.map(li => renderLibraryRow(li, li.key === selectedKey, b.group.key))}
                  </React.Fragment>
                );
              })}
            </ul>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 text-[11px] text-zinc-400 px-1">
            <span>{t('resources.listCount', { n: rows.length })}</span>
            {showSkills && scanStats && <span>{t('resources.syncSummary', { n: scanStats.totalOnDisk })}</span>}
            <span className="hidden md:inline ml-auto [@media(pointer:coarse)]:hidden">{t('resources.kbdHint')}</span>
          </p>
        </div>
        {selected && renderInspector(selected)}
      </div>
    );
  }

  /** 资产库行数据：扫描到的 Skill 与已纳管资源统一成一种结构 */
  function toLibraryItem(row) {
    const { item, kind } = row;
    const disc = kind === 'discovered';
    const linked = disc && item.resourceId ? resourcesById.get(item.resourceId) : null;
    const type = disc ? 'skill' : item.type;
    const probe = disc ? (linked || item) : item;
    const apps = [];
    for (const p of item.projections || []) {
      if (!isAgentAppId(p.agentId) || apps.some(a => a.id === p.agentId)) continue;
      apps.push({ id: p.agentId, label: (p.label && p.label !== p.agentId) ? p.label : (appNameById.get(p.agentId) || p.agentId) });
    }
    return {
      key: row.key,
      kind,
      item,
      linked,
      type,
      name: resourceDisplayName(type, item),
      desc: resourceDescription(item),
      path: disc ? item.authorityPath : (item.type === 'skill' ? getSkillLocation(item) : null),
      apps,
      life: classifyLifecycle(probe),
      useCount: Math.max(0, Number(item.use_count ?? linked?.use_count ?? 0) || 0),
      lastUsed: Number(item.last_used_at ?? linked?.last_used_at ?? 0) || 0,
      purposes: disc ? purposesOf(item, resourcesById) : purposesOf(item),
      resourceId: disc ? item.resourceId : item.id,
      builtin: !disc && isBuiltinResource(item),
    };
  }

  /** 行 / 详情共用的次要操作（编辑、推荐、打开目录、卸载 / 删除） */
  function libraryMenuItems(li) {
    const { item, kind } = li;
    const disc = kind === 'discovered';
    const recTarget = disc ? item : item;
    const pushed = isPushedToCommunity(recTarget, catalog) || (disc && isPushedToCommunity(li.linked, catalog));
    const recKey = `rec-${li.resourceId}`;
    const canRec = disc
      ? !!li.resourceId
      : (['skill', 'prompt', 'assistant'].includes(item.type) && !li.builtin && item.source !== 'builtin' && !item.metadata?.builtin);
    return [
      !disc && {
        key: 'edit',
        label: t('resources.edit'),
        disabled: busy === 'editor' || busy === 'cleanup',
        onClick: () => openEditEditor(item),
      },
      canRec && {
        key: 'rec',
        label: busy === recKey ? t('resources.busy') : (pushed ? t('resources.pushedCommunity') : t('resources.recommendCommunity')),
        title: pushed ? t('resources.pushedCommunityHint') : t('resources.recommendHint'),
        disabled: !!busy && busy !== recKey && busy !== li.resourceId,
        onClick: () => handleRecommendToCommunity(item),
      },
      li.path && !isWebBridge() && {
        key: 'open',
        label: t('resources.openFolder'),
        onClick: () => handleOpenPath(li.path),
      },
      disc && li.resourceId && {
        key: 'uninstall',
        label: t('resources.uninstall'),
        danger: true,
        disabled: !!busy && busy !== li.resourceId,
        onClick: () => handleUninstallSkill(item),
      },
      !disc && item.source !== 'builtin' && !item.metadata?.builtin && {
        key: 'delete',
        label: t('resources.delete'),
        danger: true,
        title: item.type === 'assistant' && hasProjectedLinks(item.projections, item.authorityPath || getSkillLocation(item))
          ? t('resources.deleteNeedUnproject')
          : undefined,
        disabled: !!busy && busy !== item.id,
        onClick: () => handleDelete(item),
      },
    ].filter(Boolean);
  }

  function lifeLabel(life) {
    return life.layer === 'exempt' ? t('resources.source.builtin') : t(`resources.layer.${life.layer}`);
  }

  /** 技能系列组头：点击展开 / 收起；汇总应用、用量与状态 */
  function renderSeriesRow(group, open) {
    const members = group.rows;
    const apps = [];
    for (const li of members) for (const a of li.apps) if (!apps.some(x => x.id === a.id)) apps.push(a);
    const uses = members.reduce((n, li) => n + (li.useCount || 0), 0);
    const activeN = members.filter(li => li.life.layer === 'active').length;
    const idleN = members.filter(li => li.life.layer === 'dormant' || li.life.layer === 'cold').length;
    const projected = members.map(li => (li.kind === 'resource' ? li.item : li.linked)).filter(r => r?.projections?.length);
    const prefix = new RegExp(`^${group.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[-_:/.]?`, 'i');
    const shortNames = members.map(li => String(li.name || '').replace(prefix, '') || li.name);
    const busyKey = `series-${group.key}`;
    return (
      <li
        key={`g-${group.key}`}
        role="option"
        aria-expanded={open}
        aria-selected={false}
        onClick={() => toggleSeries(group.key)}
        className={`${libRowCls(false)} grid-cols-[minmax(0,1fr)_auto] ${LIB_GRID_MD} bg-zinc-50/70 dark:bg-white/[0.02]`}
      >
        <div className="relative flex items-center gap-2.5 min-w-0">
          <span className={`absolute -left-3.5 w-3 text-center text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>›</span>
          <AssetLogo type="skill" name={group.label} />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-800 dark:text-zinc-100 truncate">
              {group.label}
              <span className="shrink-0 text-[10px] px-1.5 py-px rounded bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 font-medium">
                {t('resources.series.badge', { n: members.length })}
              </span>
            </p>
            <p className="text-[11px] text-zinc-400 truncate" title={shortNames.join(' · ')}>{shortNames.join(' · ')}</p>
          </div>
        </div>
        <div className="hidden md:block min-w-0">{renderAppNames(apps)}</div>
        <div className="hidden md:block text-right text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">{t('resources.row.uses', { n: uses || 0 })}</div>
        <div className="hidden md:flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${idleN ? 'bg-amber-400' : activeN ? 'bg-emerald-500' : 'bg-zinc-300'}`} aria-hidden />
          <span className="truncate">
            {idleN ? t('resources.series.idle', { n: idleN }) : t('resources.series.active', { a: activeN, n: members.length })}
          </span>
        </div>
        <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
          <AssetMoreMenu
            label={t('resources.moreActions')}
            items={[
              { key: 'toggle', label: open ? t('resources.series.collapse') : t('resources.series.expand'), onClick: () => toggleSeries(group.key) },
              projected.length > 0 && {
                key: 'unproject',
                label: busy === busyKey ? t('resources.busy') : t('resources.series.unprojectAll', { n: projected.length }),
                disabled: !!busy,
                onClick: () => handleUnprojectMany(projected, group.label, busyKey),
              },
            ].filter(Boolean)}
          />
        </div>
      </li>
    );
  }

  /** 看护体检标签：有风险 > 需完善 > 有重复 > 有新版本 */
  function renderAssetFlags(resourceId) {
    const f = resourceId && assetFlags[resourceId];
    if (!f) return null;
    const chip = (key, cls, label, title) => (
      <span key={key} title={title} className={`shrink-0 text-[10px] px-1.5 py-px rounded ${cls}`}>{label}</span>
    );
    return (
      <>
        {f.security === 'high' && chip('risk', 'bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300', t('resources.flag.risk'), t('resources.flag.riskHint'))}
        {f.quality === 'warn' && chip('q', 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300', t('resources.flag.quality'), t('resources.flag.qualityHint'))}
        {f.duplicateOf?.length > 0 && chip('dup', 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300', t('resources.flag.dup'), t('resources.flag.dupHint'))}
        {f.updateAvailable && chip('up', 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300', t('resources.flag.update'), t('resources.flag.updateHint', { from: f.updateAvailable.from, to: f.updateAvailable.to }))}
      </>
    );
  }

  /** 启用到哪些应用：写名字，多了只写前两个 */
  function renderAppNames(apps) {
    if (!apps.length) return <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('resources.row.notEnabled')}</span>;
    const names = apps.map(a => a.label);
    const text = names.length > 2 ? t('resources.row.appsMore', { names: names.slice(0, 2).join('、'), n: names.length }) : names.join('、');
    return <span className="block text-[11px] text-zinc-600 dark:text-zinc-300 truncate" title={names.join('、')}>{text}</span>;
  }

  /** 行的状态：有问题（管家体检或依赖缺失）> 有新版本 > 在用 > 没在用，带一句原因 */
  function rowState(li) {
    const f = (li.resourceId && assetFlags[li.resourceId]) || {};
    if (f.security === 'high') return { kind: 'issue', word: t('resources.state.issue'), why: t('resources.row.whyRisk'), act: 'look' };
    const blocked = li.type === 'assistant' ? blockedAssistants[li.resourceId] : null;
    if (blocked?.reason === 'skills') return { kind: 'issue', word: t('resources.state.issue'), why: t('resources.row.whyDepsNamed', { skills: blocked.missing.join('、') }), act: 'look' };
    if (blocked?.reason === 'runtime') return { kind: 'issue', word: t('resources.state.issue'), why: t('resources.row.whyRuntime'), act: 'look' };
    if (li.type === 'assistant' && li.item.depsBroken) return { kind: 'issue', word: t('resources.state.issue'), why: t('resources.row.whyDeps'), act: 'look' };
    if (f.quality === 'warn') return { kind: 'issue', word: t('resources.state.issue'), why: t('resources.row.whyQuality'), act: 'look' };
    if (f.updateAvailable) return { kind: 'update', word: t('resources.row.update'), why: t('resources.row.whyUpdate', { to: f.updateAvailable.to }), act: 'look' };
    if (li.life.layer === 'exempt') return { kind: 'active', word: t('resources.source.builtin'), why: '', act: 'project' };
    // 智能体是模板：说它投射到了哪里，不说「在用 / 没在用」（运行情况在网关页）
    if (li.type === 'assistant') {
      return li.apps.length
        ? { kind: 'active', word: t('resources.tpl.projected', { n: li.apps.length }), why: t('resources.tpl.runInGateway'), act: 'project', gateway: true }
        : { kind: 'idle', word: t('resources.tpl.notProjected'), why: '', act: 'project' };
    }
    if (li.life.layer === 'active') {
      return { kind: 'active', word: t('resources.state.active'), why: li.apps.length ? t('resources.row.onApps', { n: li.apps.length }) : '', act: 'project' };
    }
    // 一句话说清楚，不再「没在用」+「启用了还没用过」两句打架
    const word = { pending: t('resources.row.whyPending'), dormant: t('resources.row.whyDormant'), cold: t('resources.row.whyCold'), shelf: t('resources.row.whyShelf') }[li.life.layer] || t('resources.state.idle');
    return { kind: 'idle', word, why: '', act: 'project' };
  }

  /** 行里的一句描述：不重复系统提示词；智能体模板写它带了哪些技能 */
  function rowDesc(li) {
    const d = String(li.desc || '').trim();
    if (li.type !== 'assistant') return d;
    const echo = !d || /^你是/.test(d) || d === `你是${li.name}` || d.length <= String(li.name || '').length + 3;
    if (!echo) return d;
    let skills = [];
    try {
      const raw = li.item?.content;
      const cfg = typeof raw === 'string' && raw.trim().startsWith('{') ? JSON.parse(raw) : (raw && typeof raw === 'object' ? raw : {});
      skills = Array.isArray(cfg.skills) ? cfg.skills.map(x => (typeof x === 'string' ? x : x?.name || x?.id)).filter(Boolean) : [];
    } catch { /* 解析不了就不写技能 */ }
    return skills.length ? t('resources.tpl.skillsDesc', { n: skills.length, names: skills.slice(0, 3).join('、') + (skills.length > 3 ? '…' : '') }) : t('resources.tpl.noSkills');
  }

  function renderLibraryRow(li, sel, nested = '') {
    const visual = typeVisual(li.type);
    const it = li.item;
    const rs = rowState(li);
    const stateCls = {
      issue: 'font-medium text-rose-700 dark:text-rose-300',
      update: 'font-medium text-amber-700 dark:text-amber-300',
      active: 'font-medium text-emerald-700 dark:text-emerald-300',
      idle: 'text-zinc-500 dark:text-zinc-400',
    }[rs.kind];
    const stateDot = { issue: 'bg-rose-500', update: 'bg-amber-400', active: 'bg-emerald-500', idle: 'bg-zinc-300 dark:bg-zinc-600' }[rs.kind];
    return (
      <li
        key={li.key}
        data-lib-key={li.key}
        role="option"
        aria-selected={sel}
        onClick={() => setSelectedKey(sel ? null : li.key)}
        className={`${libRowCls(sel)} grid-cols-[minmax(0,1fr)_auto] ${LIB_GRID_MD} ${nested ? 'md:pl-9 bg-zinc-50/40 dark:bg-white/[0.01]' : ''}`}
      >
        <LibraryRowTitle
          logo={<AssetLogo type={li.type} icon={it.icon || it.metadata?.icon} name={nested || li.name || it.id} />}
          name={li.name}
          sub={rowDesc(li) || (li.path ? shortenHomePath(li.path) : t('resources.emptyDetail'))}
          chips={(
            <>
              <span className={`shrink-0 text-[10px] px-1.5 py-px rounded font-medium ${visual.chip}`}>{typeBadge(li.type, t)}</span>
              {it.contentChanged && (
                <span className="shrink-0 text-[10px] px-1.5 py-px rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">{t('resources.contentChanged')}</span>
              )}
              {li.type === 'assistant' && it.depsBroken && (
                <span className="shrink-0 text-[10px] px-1.5 py-px rounded bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300">{t('resources.depsBroken')}</span>
              )}
              {renderAssetFlags(li.resourceId)}
            </>
          )}
        />
        <div className="md:hidden col-start-1 col-span-2 row-start-2 flex flex-nowrap items-center gap-1.5 min-w-0 text-[12px] pl-12 -mt-1">
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${stateDot}`} aria-hidden />
          <span className={`shrink-0 ${stateCls}`}>{rs.word}</span>
          {rs.why && (rs.gateway
            ? <button type="button" onClick={(e) => { e.stopPropagation(); navigate('/gateway', { state: { gatewayTab: 'pro' } }); }}
                className="truncate text-blue-600 dark:text-blue-400">· {rs.why}</button>
            : <span className="truncate text-zinc-500 dark:text-zinc-400">· {rs.why}</span>)}
        </div>
        <div className="hidden md:block min-w-0">{renderAppNames(li.apps)}</div>
        <div className="hidden md:block text-right text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">{li.type === 'assistant' ? '—' : t('resources.row.uses', { n: li.useCount || 0 })}</div>
        <div className="hidden md:flex items-start gap-1.5 text-[11px] min-w-0">
          <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${stateDot}`} aria-hidden />
          <span className="min-w-0">
            <span className={`block truncate ${stateCls}`}>{rs.word}</span>
            {rs.why && (rs.gateway
              ? <button type="button" onClick={(e) => { e.stopPropagation(); navigate('/gateway', { state: { gatewayTab: 'pro' } }); }}
                  className="block truncate text-blue-600 dark:text-blue-400 hover:underline text-left">{rs.why}</button>
              : <span className="block truncate text-zinc-400 dark:text-zinc-500" title={rs.why}>{rs.why}</span>)}
          </span>
        </div>
        <div className="flex items-center justify-end gap-1.5" onClick={e => e.stopPropagation()}>
          {rs.act === 'look' ? (
            <button
              type="button"
              onClick={() => {
                // 有问题：带着问题去智能管家对话页，由它直接处理；看更新仍打开详情
                if (rs.kind === 'issue') {
                  navigate('/guardian', { state: { autoSend: true, prompt: t('resources.row.askGuardian', {
                    type: typeBadge(li.type, t), name: li.name, why: rs.why || rs.word, id: li.resourceId || li.key,
                  }) } });
                } else setSelectedKey(li.key);
              }}
              className={`tb-press text-[11px] px-2.5 py-1 rounded-lg ${rs.kind === 'issue' ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border border-zinc-200 dark:border-zinc-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'}`}
            >
              {rs.kind === 'update' ? t('resources.row.seeUpdate') : t('resources.row.look')}
            </button>
          ) : li.resourceId && (
            <button
              type="button"
              disabled={!!busy && busy !== li.resourceId}
              onClick={(e) => openProjectMenu(e, li.resourceId)}
              className="tb-press text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-45"
            >
              {busy === li.resourceId ? t('resources.busy') : t('resources.row.enableTo')}
            </button>
          )}
          <AssetMoreMenu label={t('resources.moreActions')} items={libraryMenuItems(li)} />
        </div>
      </li>
    );
  }

  function fmtAgo(ts) {
    if (!ts) return '—';
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = Math.floor((Date.now() - ms) / 86400000);
    if (d <= 0) return t('resources.ago.today');
    if (d < 30) return t('resources.ago.days', { n: d });
    return new Date(ms).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN');
  }

  /** 右侧详情面板（资产库） */
  function renderInspector(li) {
    const it = li.item;
    const visual = typeVisual(li.type);
    const previewSrc = li.kind === 'discovered' ? (li.linked || it) : it;
    const menu = libraryMenuItems(li);
    return (
      <LibraryInspector
        logo={<AssetLogo type={li.type} icon={it.icon || it.metadata?.icon} name={li.name || it.id} />}
        title={li.name}
        closeLabel={t('resources.collapse')}
        onClose={() => setSelectedKey(null)}
        chips={(
          <>
            <span className={`text-[10px] px-1.5 py-px rounded font-medium ${visual.chip}`}>{typeBadge(li.type, t)}</span>
            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
              <span className={`w-1.5 h-1.5 rounded-full ${LIFE_DOT[li.life.layer] || 'bg-zinc-300'}`} aria-hidden />
              {lifeLabel(li.life)}
            </span>
            {!li.builtin && li.kind !== 'discovered' && (
              <span className="text-[10px] text-zinc-400">{sourceLabel(it.source, t)}</span>
            )}
          </>
        )}
        desc={li.desc}
        stats={[
          [t('resources.col.uses'), li.useCount || '0'],
          [t('resources.stat.lastUsed'), fmtAgo(li.lastUsed)],
          [t('resources.col.apps'), li.apps.length],
        ]}
        footer={menu.length > 0 ? (
          <>
            {menu.filter(m => !m.danger).map(m => (
              <button key={m.key} type="button" disabled={m.disabled} title={m.title} onClick={m.onClick} className={ASSET_BTN_GHOST}>{m.label}</button>
            ))}
            {menu.filter(m => m.danger).map(m => (
              <button key={m.key} type="button" disabled={m.disabled} title={m.title} onClick={m.onClick}
                className="ml-auto text-xs px-3 py-1.5 rounded-xl text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-45">{m.label}</button>
            ))}
          </>
        ) : null}
      >
        <InspectorSection title={t('resources.col.apps')}>
          <div className="space-y-2.5">
            {li.resourceId ? renderProjections({
              id: li.resourceId,
              type: li.type,
              projections: it.projections,
              authorityPath: li.kind === 'discovered' ? it.authorityPath : (it.authorityPath || li.path),
            }) : <span className="text-[11px] text-zinc-400">{t('resources.notProjected')}</span>}
            {li.resourceId && (
              <button type="button" disabled={!!busy && busy !== li.resourceId}
                onClick={(e) => openProjectMenu(e, li.resourceId)}
                className={`${ASSET_BTN_PRIMARY} w-full`}>
                {busy === li.resourceId ? t('resources.busy') : t('resources.project')}
              </button>
            )}
            {li.resourceId && <DiagnosePanel resourceId={li.resourceId} resourceName={li.name} onChanged={() => loadAll({ silent: true })} />}
          </div>
        </InspectorSection>
        {li.type === 'assistant' && (() => {
          const model = assistantModelOf(it.content);
          return (
            <InspectorSection title={t('resources.link.model')}>
              {model ? (
                <div className="flex items-center gap-2">
                  <code className="text-[11px] font-mono text-zinc-700 dark:text-zinc-200 truncate">{model}</code>
                  <button type="button" onClick={() => navigate('/providers', { state: { focusModel: model } })}
                    className="ml-auto shrink-0 text-[11px] text-blue-600 dark:text-blue-400 hover:underline">
                    {t('resources.link.viewSource')} →
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-zinc-400">{t('resources.link.modelDefault')}</p>
              )}
            </InspectorSection>
          );
        })()}
        {li.purposes.length > 0 && (
          <InspectorSection title={t('resources.filter.purpose')}>
            <div className="flex flex-wrap gap-1.5">
              {li.purposes.map(slug => (
                <button key={slug} type="button" onClick={() => setTagFilter(tagFilter === slug ? '' : slug)}
                  className={purposeChipClass(tagFilter === slug, 'sm')}>{purposeLabel(slug)}</button>
              ))}
              {renderAssistantBoundBadge(li.type, it.name)}
            </div>
          </InspectorSection>
        )}
        {li.path && (
          <InspectorSection title={t('resources.skillLocation')}>
            <button type="button" onClick={() => handleOpenPath(li.path)} title={li.path}
              className="text-[11px] font-mono text-zinc-500 hover:text-blue-600 dark:hover:text-blue-400 break-all text-left">
              {shortenHomePath(li.path)} ↗
            </button>
          </InspectorSection>
        )}
        {resourceIntro(previewSrc) ? (
          <InspectorSection title={t('resources.detailIntro')}>
            <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{resourceIntro(previewSrc)}</p>
          </InspectorSection>
        ) : null}
        <InspectorSection title={t('resources.preview')}>
          <InspectorPreview text={buildPreviewText(li.type, previewSrc) || t('resources.emptyDetail')} />
        </InspectorSection>
      </LibraryInspector>
    );
  }

  /** 社区目录行（为你推荐 Tab 下半部分）：与资产库同一列表样式 */
  function renderCatalogRow(item) {
    const key = `cat:${item.catalogId}`;
    const sel = selectedKey === key;
    const builtin = isBuiltinResource(item);
    const visual = typeVisual(item.type);
    const name = resourceDisplayName(item.type, item);
    return (
      <li
        key={key}
        role="option"
        aria-selected={sel}
        onClick={() => setSelectedKey(sel ? null : key)}
        className={`${libRowCls(sel)} grid-cols-[minmax(0,1fr)_auto]`}
      >
        <LibraryRowTitle
          logo={<AssetLogo type={item.type} icon={item.icon || item.metadata?.icon} name={name || item.catalogId} />}
          name={name}
          sub={resourceDescription(item) || t('resources.emptyDetail')}
          chips={(
            <>
              <span className={`shrink-0 text-[10px] px-1.5 py-px rounded font-medium ${visual.chip}`}>{typeBadge(item.type, t)}</span>
              <span className="shrink-0 text-[10px] text-zinc-400 truncate">
                {builtin ? t('resources.source.builtin') : t('resources.sharedBy', { handle: catalogSharerHandle(item) })}
              </span>
            </>
          )}
        />
        <div onClick={e => e.stopPropagation()}>{renderCatalogAction(item)}</div>
      </li>
    );
  }

  function renderCatalogAction(item, { block = false } = {}) {
    const builtin = isBuiltinResource(item);
    const done = item.installed || builtin;
    const paid = !done && isPaidCatalog(item);
    const confirming = paid && payConfirmId === item.catalogId;
    const costText = communityCost != null ? t('resources.costCredits', { cost: communityCost }) : t('resources.costPaid');
    let label = t('resources.enable');
    if (busy === item.catalogId) label = t('resources.busy');
    else if (done) label = t('resources.enabled');
    else if (confirming) label = communityCost != null ? t('resources.confirmPay', { cost: communityCost }) : t('resources.confirmPayUnknown');
    else if (paid) label = `${t('resources.enable')} · ${costText}`;
    return (
      <button
        type="button"
        disabled={(!!busy && busy !== item.catalogId) || done}
        onClick={() => handleInstall(item.catalogId)}
        title={paid ? t('resources.paidHint') : undefined}
        className={`${done ? ASSET_BTN_MANAGED : ASSET_BTN_PRIMARY} ${confirming ? '!bg-amber-500 hover:!bg-amber-600 !text-white' : ''} ${block ? 'w-full' : '!px-3 !py-1 !text-[11px] !rounded-lg whitespace-nowrap'}`}
      >
        {label}
      </button>
    );
  }

  /** 付费条目的免费替代：同类型、免费、名称与描述相近（规则打分，取前 3） */
  function freeAlternatives(item) {
    if (!item || !isPaidCatalog(item)) return [];
    const grams = (s) => {
      const t0 = String(s || '').toLowerCase();
      const set = new Set();
      for (let i = 0; i < t0.length - 1; i++) {
        const g = t0.slice(i, i + 2);
        if (/\S\S/.test(g)) set.add(g);
      }
      t0.split(/[^a-z0-9]+/).filter(w => w.length > 2).forEach(w => set.add(w));
      return set;
    };
    const mine = grams(`${item.name} ${item.display_name || ''} ${item.description || ''}`);
    return (catalog || [])
      .filter(c => c.catalogId !== item.catalogId && c.type === item.type && !isPaidCatalog(c))
      .map(c => {
        const g = grams(`${c.name} ${c.display_name || ''} ${c.description || ''}`);
        let n = 0;
        g.forEach(x => { if (mine.has(x)) n++; });
        return { c, score: n / Math.max(4, Math.min(mine.size, g.size)) };
      })
      .filter(x => x.score >= 0.35)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(x => x.c);
  }

  function renderCatalogInspector(item) {
    const visual = typeVisual(item.type);
    const name = resourceDisplayName(item.type, item);
    const builtin = isBuiltinResource(item);
    const purposes = purposesOf(item);
    return (
      <LibraryInspector
        logo={<AssetLogo type={item.type} icon={item.icon || item.metadata?.icon} name={name || item.catalogId} />}
        title={name}
        closeLabel={t('resources.collapse')}
        onClose={() => setSelectedKey(null)}
        chips={(
          <>
            <span className={`text-[10px] px-1.5 py-px rounded font-medium ${visual.chip}`}>{typeBadge(item.type, t)}</span>
            <span className="text-[10px] text-zinc-400">
              {builtin ? t('resources.source.builtin') : t('resources.sharedBy', { handle: catalogSharerHandle(item) })}
            </span>
          </>
        )}
        desc={resourceDescription(item)}
        footer={item.depsBroken && item.missingDeps?.length && !item.installed ? (
          <button
            type="button"
            disabled={!!busy}
            onClick={() => handleInstall(item.catalogId, { force: true })}
            className={`${ASSET_BTN_PRIMARY} w-full`}
          >
            {busy === item.catalogId ? t('resources.busy') : t('resources.depsEnableAnyway')}
          </button>
        ) : renderCatalogAction(item, { block: true })}
      >
        {item.depsBroken && item.missingDeps?.length > 0 && !item.installed && (
          <InspectorSection title={t('resources.depsMissingTitle')}>
            <div className={`rounded-lg border px-2.5 py-2 space-y-1 ${depsPendingId === item.catalogId ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30' : 'border-amber-200/70 bg-amber-50/60 dark:bg-amber-950/20'}`}>
              <p className="text-[11px] text-amber-800 dark:text-amber-300">{t('resources.depsMissingHint')}</p>
              <ul className="text-[11px] text-amber-900 dark:text-amber-200 list-disc pl-4">
                {item.missingDeps.map((d) => (
                  <li key={`${d.type}:${d.name}`}>{typeBadge(d.type, t)} · {d.name}</li>
                ))}
              </ul>
            </div>
          </InspectorSection>
        )}
        {!item.installed && freeAlternatives(item).length > 0 && (
          <InspectorSection title={t('resources.freeAltTitle')}>
            <div className="rounded-lg border border-emerald-200/80 dark:border-emerald-900/50 bg-emerald-50/60 dark:bg-emerald-950/20 px-2.5 py-2 space-y-1.5">
              <p className="text-[11px] text-emerald-800 dark:text-emerald-300">{t('resources.freeAltHint')}</p>
              <div className="flex flex-wrap gap-1.5">
                {freeAlternatives(item).map(alt => (
                  <button key={alt.catalogId} type="button" onClick={() => setSelectedKey(`cat:${alt.catalogId}`)}
                    className="text-[11px] px-2 py-0.5 rounded-md bg-white dark:bg-zinc-900 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 hover:bg-emerald-50 dark:hover:bg-emerald-950/40">
                    {alt.display_name || alt.name}
                  </button>
                ))}
              </div>
            </div>
          </InspectorSection>
        )}
        {purposes.length > 0 && (
          <InspectorSection title={t('resources.filter.purpose')}>
            <div className="flex flex-wrap gap-1.5">
              {purposes.map(slug => (
                <button key={slug} type="button" onClick={() => setTagFilter(tagFilter === slug ? '' : slug)}
                  className={purposeChipClass(tagFilter === slug, 'sm')}>{purposeLabel(slug)}</button>
              ))}
            </div>
          </InspectorSection>
        )}
        {resourceIntro(item) ? (
          <InspectorSection title={t('resources.detailIntro')}>
            <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{resourceIntro(item)}</p>
          </InspectorSection>
        ) : null}
        <InspectorSection title={t('resources.preview')}>
          <InspectorPreview text={buildPreviewText(item.type, item) || t('resources.emptyDetail')} />
        </InspectorSection>
      </LibraryInspector>
    );
  }

  function renderProjectMenu() {
    if (!projectMenu) return null;
    // 本机 Skill 行可能只在 discovered 里，需两边查找类型
    const resource = resources.find(r => r.id === projectMenu.resourceId)
      || discovered.find(i => i.resourceId === projectMenu.resourceId);
    // Skill 必须落盘到有 skills 目录的 agent（保持 agents）；
    // prompt / 智能体走 MCP/中转，可投到全部已纳管应用（含 Trae / API 应用）。
    const targetList = (resource?.type === 'prompt' || resource?.type === 'assistant')
      ? (managedAppTargets.length ? managedAppTargets : agents)
      : agents;
    const maxMenuH = Math.max(160, window.innerHeight - 16);
    return createPortal(
      <div
        ref={projectMenuRef}
        className="fixed z-[9999] w-64 flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg overflow-hidden"
        style={{
          left: projectMenu.x,
          top: projectMenu.y,
          maxHeight: maxMenuH,
        }}
      >
        <div className="shrink-0 px-3 py-2 border-b border-zinc-100 dark:border-zinc-700">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{t('resources.projectTo')}</p>
          {resource?.type === 'prompt' ? (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.promptMcpHint')}</p>
          ) : resource?.type !== 'skill' && (
            <p className="text-[10px] text-zinc-400 mt-0.5">{t('resources.nonSkillHint')}</p>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1">
          {targetList.length === 0 ? (
            <p className="text-[10px] text-zinc-400 px-2 py-1.5">
              {resource?.type === 'prompt'
                ? t('resources.promptNoMcpAgents')
                : t('resources.noProjectAgents')}
            </p>
          ) : targetList.map(a => (
            <label key={a.id} className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-xs ${
              projectSelected.includes(a.id) ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-zinc-50 dark:hover:bg-zinc-700/50'
            }`}>
              <input
                type="checkbox"
                checked={projectSelected.includes(a.id)}
                onChange={() => setProjectSelected(prev =>
                  prev.includes(a.id) ? prev.filter(x => x !== a.id) : [...prev, a.id],
                )}
                className="rounded border-zinc-300 dark:border-zinc-600"
              />
              <ServiceIcon id={a.id} name={a.label} boxClass="w-6 h-6" imgClass="w-3.5 h-3.5" />
              <span className="flex-1 truncate text-zinc-700 dark:text-zinc-200">{a.label}</span>
            </label>
          ))}
        </div>
        <div className="shrink-0 p-2 border-t border-zinc-100 dark:border-zinc-700 flex gap-2">
          <button
            type="button"
            className="flex-1 text-xs py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600"
            onClick={() => setProjectMenu(null)}
          >
            {t('resources.cancel')}
          </button>
          <button
            type="button"
            disabled={targetList.length === 0}
            className="tb-press flex-1 text-xs py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
            onClick={confirmProject}
          >
            {t('resources.confirmProject')}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  // Web / Docker 模式没有本机文件访问能力：整页换成说明卡，不展示点了才报错的按钮
  if (!window.electronAPI?.resource) {
    return (
      <div className="flex flex-col h-full min-h-0 bg-transparent">
        <header className="shrink-0 px-4 pt-4 pb-2">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('resources.title')}</h1>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('resources.subtitle')}</p>
        </header>
        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3.5 flex">
          <div className="tb-soft-card rounded-2xl px-6 py-8 max-w-xl w-full m-auto text-center space-y-4">
            <div className="text-3xl" aria-hidden>🖥️</div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{t('resources.webOnly.title')}</h2>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('resources.webOnly.desc')}</p>
            <ul className="text-xs text-left text-zinc-600 dark:text-zinc-300 space-y-1.5 inline-block">
              {['p1', 'p2', 'p3'].map(k => <li key={k}>✓ {t(`resources.webOnly.${k}`)}</li>)}
            </ul>
            <div>
              <a href="https://github.com/wink-run/tokenbank/releases" target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 transition-colors">
                {t('resources.webOnly.download')}
              </a>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-transparent">
      {/* 与下方内容同色：透明底，不单独铺白 */}
      <header className="shrink-0 px-5 pt-5">
        <div className="flex flex-wrap items-start gap-3">
          {/* 窄屏说明独占一行，避免被右侧按钮挤成逐字折行 */}
          <div className="min-w-0 basis-full md:basis-auto md:flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('resources.title')}</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">{t('resources.subtitle')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(() => {
              const busyEdit = busy === 'editor' || busy === 'cleanup';
              const primaryCls = 'tb-press text-xs font-medium px-3.5 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 shadow-sm shadow-blue-600/20 disabled:opacity-50 whitespace-nowrap';
              const ghostCls = 'tb-press text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/50 text-zinc-700 dark:text-zinc-200 hover:bg-white dark:hover:bg-zinc-800 disabled:opacity-50 whitespace-nowrap';
              const typed = ['prompt', 'skill', 'assistant'].includes(typeFilter);
              // 所有「加东西」的入口收进一个「添加」，不再随类型换按钮
              const items = [
                { key: 'catalog', label: t('resources.add.catalog'), hint: t('resources.add.catalogHint'), run: () => changeViewTab('recommend') },
                { key: 'install', label: t('resources.add.install'), hint: t('resources.menu.installHint'), run: () => setSkillInstallOpen(true) },
                { key: 'scan', label: t('resources.scanShort'), hint: t('resources.menu.scanHint'), run: () => {
                  if (!showSkillTabs) changeTypeFilter('skill', 'managed');
                  if (viewTab !== 'managed') changeViewTab('managed');
                  setScanExpanded(true);
                } },
                !isWebBridge() && { key: 'import', label: t('resources.add.import'), hint: t('resources.menu.importHint'), disabled: busy === 'import' || busyEdit, run: handleImportFile },
                { key: 'create', label: typed ? t('resources.createOf', { type: t(`resources.tabType.${typeFilter}`) }) : t('resources.add.create'), hint: t('resources.menu.createHint'), disabled: busyEdit,
                  run: () => { if (viewTab !== 'managed') changeViewTab('managed'); openCreateEditor(typed ? typeFilter : '', !typed); } },
                { key: 'tool', label: t('resources.add.tool'), hint: t('resources.add.toolHint'), run: () => {
                  if (viewTab !== 'managed') changeViewTab('managed');
                  if (!isMcp) changeTypeFilter('mcp', 'managed');
                  setTimeout(() => setMcpCreateSignal(n => n + 1), isMcp ? 0 : 150);
                } },
              ].filter(Boolean);
              return (
                <>
                  {typeFilter === 'skill' && viewTab === 'managed' && (
                    <button type="button" className={ghostCls} disabled={busy === 'cleanup' || idleLoading} onClick={openSkillCleanup} title={t('resources.cleanupTitle')}>
                      {idleLoading ? t('resources.cleanupScanning') : t('resources.cleanup')}
                    </button>
                  )}
                  <div className="relative">
                    <button type="button" className={primaryCls} aria-haspopup="menu" aria-expanded={addMenuOpen}
                      onClick={() => setAddMenuOpen(v => !v)}>
                      ＋ {t('resources.add.button')}
                    </button>
                    {addMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-[60]" onClick={() => setAddMenuOpen(false)} aria-hidden="true" />
                        <div role="menu" className="absolute right-0 top-full mt-1.5 z-[61] w-72 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg p-1"
                          onKeyDown={(e) => { if (e.key === 'Escape') setAddMenuOpen(false); }}>
                          {items.map(it => (
                            <button key={it.key} type="button" role="menuitem" disabled={it.disabled}
                              onClick={() => { setAddMenuOpen(false); it.run(); }}
                              className="block w-full text-left px-2.5 py-1.5 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700/60 disabled:opacity-40">
                              <span className="block text-xs font-medium text-zinc-800 dark:text-zinc-100">{it.label}</span>
                              <span className="block text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">{it.hint}</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
        {/* 主导航：资产类型直接作为一级 Tab（带数量），「发现」与之以竖线分隔 */}
        <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-1 border-b border-zinc-200/80 dark:border-white/[0.08]" role="tablist">
          {TYPE_OPTIONS.map(opt => {
            const active = viewTab !== 'recommend' && typeFilter === opt.id;
            const n = typeCounts[opt.id || 'all'];
            return (
              <button
                key={opt.id || 'all'}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => {
                  if (viewTab !== 'managed') changeViewTab('managed');
                  changeTypeFilter(opt.id, 'managed');
                  if (opt.id !== 'prompt') setPromptKindFilter('');
                }}
                className={`-mb-px pb-2.5 text-[13px] border-b-2 transition-colors ${
                  active
                    ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-50 font-semibold'
                    : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                }`}
              >
                {t(`resources.tabType.${opt.id || 'all'}`)}
                {n != null && <span className="ml-1.5 text-[11px] font-normal text-zinc-400 tabular-nums">{n}</span>}
              </button>
            );
          })}
          <div className="relative w-full md:w-64 md:ml-auto md:max-w-[40vw] mb-1.5 self-center">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" aria-hidden>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5 17 17" strokeLinecap="round" /></svg>
            </span>
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur(); }
              }}
              placeholder={t('resources.searchPlaceholder')}
              className="tb-soft-field w-full text-xs pl-8 pr-8 py-1.5 rounded-lg text-zinc-900 dark:text-zinc-100"
            />
            {searching ? (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-zinc-400 pointer-events-none">
                {t('resources.searching')}
              </span>
            ) : query ? (
              <button
                type="button"
                aria-label={t('resources.clearSearch')}
                onClick={() => setQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                <span className="text-sm leading-none" aria-hidden>×</span>
              </button>
            ) : (
              <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] px-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-400 font-sans pointer-events-none">/</kbd>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
        {viewTab === 'recommend' && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{t('resources.add.catalog')}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('resources.add.catalogHint')}</span>
            <button type="button" onClick={() => changeViewTab('managed')}
              className="ml-auto text-xs px-2.5 py-1 rounded-lg text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20">
              {t('resources.add.back')}
            </button>
          </div>
        )}
        {/* 筛选栏：类型分段 + 下拉筛选（用途 / 应用 / 状态）+ 排序 */}
        <div className="flex flex-wrap items-center gap-2">
          {viewTab === 'recommend' && (
          <div className="tb-glass-chip inline-flex rounded-lg p-0.5 gap-0.5">
            {TYPE_OPTIONS.map(opt => (
              <button
                key={opt.id || 'all'}
                type="button"
                onClick={() => {
                  changeTypeFilter(opt.id, 'recommend');
                  if (opt.id !== 'prompt') setPromptKindFilter('');
                }}
                className={`tb-press text-xs px-2.5 py-1 rounded-md transition-colors ${
                  typeFilter === opt.id
                    ? 'bg-white/90 dark:bg-white/10 text-zinc-900 dark:text-zinc-100 shadow-sm font-medium'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
          )}
          {typeFilter === 'prompt' && (
            <FilterMenu
              label={t('resources.filter.promptKind')}
              value={promptKindFilter}
              allLabel={t('resources.promptKind.all')}
              onChange={setPromptKindFilter}
              options={[
                { value: 'text', label: t('resources.promptKind.text') },
                { value: 'image', label: t('resources.promptKind.image') },
              ]}
            />
          )}
          {!isMcp && (availableTags.length > 0 || purposeOther > 0) && (
            <FilterMenu
              label={t('resources.filter.purpose')}
              value={tagFilter}
              allLabel={t('resources.tagFilterAll')}
              onChange={setTagFilter}
              options={[
                ...availableTags.map(slug => ({ value: slug, label: purposeLabel(slug), count: purposeCounts[slug] || 0 })),
                ...(purposeOther > 0 ? [{ value: PURPOSE_OTHER, label: purposeLabel(PURPOSE_OTHER), count: purposeOther }] : []),
              ]}
            />
          )}
          {!isMcp && viewTab === 'managed' && showAppFilterBar && appFilterOptions.length > 1 && (
            <FilterMenu
              label={t('resources.filter.app')}
              value={effectiveAppFilter}
              allLabel={t('resources.appFilterAll')}
              onChange={changeAppFilter}
              options={appFilterOptions.filter(o => o.id).map(o => ({
                value: o.id,
                label: o.label,
                icon: <ServiceIcon id={o.id} name={o.label} boxClass="w-4 h-4" imgClass="w-2.5 h-2.5" className="!rounded" />,
              }))}
            />
          )}
          {!isMcp && viewTab === 'managed' && (
            <FilterMenu
              label={t('resources.filter.status')}
              value={layerFilter}
              allLabel={t('resources.layer.filterAll')}
              onChange={changeLayerFilter}
              options={['active', 'idle', 'issue']
                .filter(id => layerCounts[id] > 0 || layerFilter === id)
                .map(id => ({ value: id, label: t(`resources.state.${id}`), count: layerCounts[id], dot: STATE_DOT[id] }))}
            />
          )}
          {!isMcp && viewTab === 'managed' && (
            <div className="ml-auto">
              <FilterMenu
                label={t('resources.sort.label')}
                value={listSort}
                neutral
                clearable={false}
                align="right"
                onChange={v => v && changeListSort(v)}
                options={LIST_SORT_OPTIONS.map(o => ({ value: o.id, label: t(o.labelKey) }))}
              />
            </div>
          )}
        </div>

        {!isMcp && !aiNoticeHidden && (
          <AiNeedNotice model={ai.model} agent={ai.agent} onRetry={() => ai.refresh()} onDismiss={hideAiNotice} />
        )}
        {!isMcp && viewTab === 'managed' && !layerFilter && (
          <>
        {lifecycleNudges.length > 0 && (() => {
          const unprojectAll = lifecycleNudges.filter(x => x.life.nudge !== 'invoke').map(x => x.r);
          const shown = nudgeGroups.slice(0, 4);
          const more = nudgeGroups.length - shown.length;
          return (
          <div className="rounded-xl border border-zinc-200/80 dark:border-zinc-700/70 bg-white/50 dark:bg-zinc-900/40 px-3 py-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[11px] text-zinc-600 dark:text-zinc-300 flex items-center gap-1.5 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden />
                <span className="font-medium">{t('resources.layer.nudgeTitle', { n: lifecycleNudges.length })}</span>
                <span className="text-zinc-400 hidden sm:inline">{t('resources.layer.nudgeSub')}</span>
              </p>
              <div className="ml-auto flex items-center gap-1.5">
                {unprojectAll.length > 1 && (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => handleUnprojectMany(unprojectAll, t('resources.layer.nudgeAllLabel'))}
                    className="tb-press text-[11px] px-2 py-0.5 rounded-md text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50"
                  >
                    {busy === 'cold-bulk' ? t('resources.busy') : t('resources.layer.nudgeUnprojectAll', { n: unprojectAll.length })}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => snoozeNudges(lifecycleNudges)}
                  title={t('resources.layer.nudgeSnoozeHint')}
                  className="tb-press text-[11px] px-2 py-0.5 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t('resources.layer.nudgeSnooze')}
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {shown.map((g) => {
                const one = g.list[0].r;
                const bk = g.series ? `series-${g.key}` : `cold-${one.id}`;
                return (
                <span
                  key={g.key}
                  className="inline-flex items-center rounded-md border border-zinc-200 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900/60 text-[11px] overflow-hidden"
                >
                  <span className="px-2 py-0.5 text-zinc-700 dark:text-zinc-200 max-w-[12rem] truncate" title={g.list.map(x => x.r.display_name || x.r.name).join('\n')}>
                    {g.label}
                    {g.series && <span className="ml-1 text-zinc-400">{t('resources.series.badge', { n: g.list.length })}</span>}
                  </span>
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => {
                      if (g.mode === 'invoke') { copyInvokeFor(one); return; }
                      if (g.series) handleUnprojectMany(g.list.map(x => x.r), g.label, bk);
                      else handleUnprojectAll(one);
                    }}
                    title={g.mode === 'invoke' ? t('resources.layer.nudgeInvokeHint') : t('resources.layer.nudgeUnprojectHint')}
                    className="tb-press px-2 py-0.5 border-l border-zinc-200 dark:border-zinc-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/40 disabled:opacity-50"
                  >
                    {busy === bk
                      ? t('resources.busy')
                      : g.mode === 'invoke' ? t('resources.layer.nudgeInvoke') : t('resources.layer.nudgeUnproject')}
                  </button>
                </span>
                );
              })}
              {more > 0 && (
                <button
                  type="button"
                  onClick={() => changeLayerFilter('dormant')}
                  className="tb-press text-[11px] px-2 py-0.5 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  {t('resources.layer.nudgeMore', { n: more })}
                </button>
              )}
            </div>
          </div>
          );
        })()}
          </>
        )}

        {/* 点击「扫描」展开：默认目录 ∪ 用户添加目录（并列，列出全部监控路径） */}
        {showSkillTabs && scanExpanded && (
          <div className="space-y-2 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-100 dark:bg-zinc-950/50">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-zinc-500 shrink-0">{t('resources.scanScopeLabel')}</span>
              <span className="text-[11px] text-zinc-400">
                {t('resources.scanRootsCount', {
                  n: defaultScanRoots.length + customScanDirs.length,
                })}
              </span>
              <button
                type="button"
                disabled={(!autoTagging && scanning) || busy === 'cleanup' || busy === 'editor'}
                onClick={autoTagging ? cancelAutoTagging : runScan}
                className="tb-press ml-auto text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 shrink-0"
              >
                {autoTagging
                  ? t('resources.autoTaggingCancel')
                  : (scanning ? t('resources.scanning') : t('resources.scanStart'))}
              </button>
            </div>
            <AiNeedNotice model={ai.model} agent={null} feature={t('resources.aiNeed.feat.tagging')} compact onRetry={() => ai.refresh()} />
            {lastScan && (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 flex flex-wrap gap-x-3">
                <span>{t('resources.scanLast.total', { n: lastScan.total })}</span>
                <span className={lastScan.imported ? 'text-emerald-600 dark:text-emerald-400 font-medium' : ''}>{t('resources.scanLast.imported', { n: lastScan.imported })}</span>
                <span>{t('resources.scanLast.updated', { n: lastScan.updated })}</span>
              </p>
            )}
            <ul className="space-y-1 max-h-48 overflow-y-auto">
              {defaultScanRoots
                .filter(root => showMissingRoots || root.exists !== false)
                .slice()
                .sort((a, b) => (skillCountByAgentId.get(b.id) || 0) - (skillCountByAgentId.get(a.id) || 0))
                .map(root => {
                const n = skillCountByAgentId.has(root.id)
                  ? skillCountByAgentId.get(root.id)
                  : null;
                return (
                <li
                  key={root.id || root.path}
                  className="flex items-center gap-2 text-[11px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5"
                >
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200/70 dark:border-sky-800/60">
                    {t('resources.scanRootDefault')}
                  </span>
                  <span className="shrink-0 text-zinc-500">{root.label}</span>
                  <span className="flex-1 min-w-0 truncate font-mono text-zinc-600 dark:text-zinc-300" title={root.path}>
                    {root.path}
                  </span>
                  {n != null && root.exists !== false && (
                    <span className="shrink-0 tabular-nums text-zinc-400">
                      {t('resources.agentSkillCount', { n })}
                    </span>
                  )}
                  {!root.exists && (
                    <span className="shrink-0 text-[10px] text-zinc-400">{t('resources.scanRootMissing')}</span>
                  )}
                </li>
                );
              })}
              {customScanDirs.map(dir => {
                const n = countForCustomScanDir(dir);
                return (
                <li
                  key={dir}
                  className="flex items-center gap-2 text-[11px] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5"
                >
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/70 dark:border-amber-800/60">
                    {t('resources.scanRootCustom')}
                  </span>
                  <span className="flex-1 min-w-0 truncate font-mono text-zinc-600 dark:text-zinc-300" title={dir}>
                    {dir}
                  </span>
                  <span className="shrink-0 tabular-nums text-zinc-400">
                    {t('resources.agentSkillCount', { n })}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeCustomScanDir(dir)}
                    className="shrink-0 text-zinc-400 hover:text-red-500 px-1"
                    title={t('resources.scanCustomDirRemove')}
                  >
                    ×
                  </button>
                </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={pickCustomScanDir}
                className="tb-press text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 hover:bg-white dark:hover:bg-zinc-800"
              >
                {t('resources.scanCustomDirAdd')}
              </button>
              {defaultScanRoots.some(r => r.exists === false) && (
                <button
                  type="button"
                  onClick={() => setShowMissingRoots(v => !v)}
                  className="tb-press text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  {showMissingRoots
                    ? t('resources.scanHideMissing')
                    : t('resources.scanShowMissing', { n: defaultScanRoots.filter(r => r.exists === false).length })}
                </button>
              )}
              <p className="text-[11px] text-zinc-400 flex-1 min-w-[12rem]">
                {t('resources.scanScopeMergedHint')}
              </p>
            </div>
          </div>
        )}
        {(msg || error) && createPortal(
          <div className="electron-no-drag fixed inset-0 z-[10050] flex items-center justify-center p-4 pointer-events-none">
            <div
              role="alert"
              className={`pointer-events-auto max-w-md text-center rounded-xl border px-4 py-3 text-sm shadow-lg ${
                error
                  ? 'border-red-200 bg-white text-red-600 dark:border-red-900/60 dark:bg-zinc-900 dark:text-red-400'
                  : 'border-blue-200 bg-white text-blue-700 dark:border-blue-900/50 dark:bg-zinc-900 dark:text-blue-300'
              }`}
            >
              {error || msg}
            </div>
          </div>,
          document.body,
        )}

        {isMcp ? (
          <McpProvidersTab viewTab={viewTab} searchQuery={debouncedQuery} createSignal={mcpCreateSignal} onCountChange={setMcpCount} />
        ) : loading ? (
          <div className="space-y-3 py-2" aria-busy="true">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-20 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 animate-pulse" />
            ))}
          </div>
        ) : viewTab === 'managed' ? (
          renderLocalList()
        ) : viewTab === 'recommend' ? (
          <div className="flex gap-4 items-start">
            <div className="flex-1 min-w-0 space-y-6">
              {/* 社区精选 */}
              <section>
                <LibrarySectionHead title={t('resources.catalogSection')} count={filteredCatalog.length || null} />
                {filteredCatalog.length === 0 ? (
                  <div className={`${LIB_LIST_CLS} text-center py-8 space-y-2`}>
                    <p className="text-xs text-zinc-400">
                      {tagFilter ? t('resources.emptyTagFiltered') : t('resources.emptyCatalog')}
                    </p>
                    {tagFilter && (
                      <button type="button" onClick={() => setTagFilter('')} className="text-xs text-blue-600 hover:underline">
                        {t('resources.clearTagFilter')}
                      </button>
                    )}
                  </div>
                ) : (
                  <ul className={LIB_LIST_CLS} role="listbox" aria-label={t('resources.catalogSection')}>
                    {filteredCatalog.map(item => renderCatalogRow(item))}
                  </ul>
                )}
              </section>
            </div>
            {/* 详情面板挂载点：社区条目由本页渲染 */}
            <div ref={setInspectorHost} className="contents">
              {(() => {
                if (!selectedKey?.startsWith('cat:')) return null;
                const item = filteredCatalog.find(c => `cat:${c.catalogId}` === selectedKey);
                return item ? renderCatalogInspector(item) : null;
              })()}
            </div>
          </div>
        ) : null}

      </div>

      {renderProjectMenu()}

      {/* 闲置 Skill 清理 — portal 到 body，避免被主内容区 / glass 裁切 */}
      {cleanupOpen && createPortal(
        <div
          className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/40"
          onClick={() => {
            if (!busy && !idleLoading && !idleAiLoading) {
              abortIdleAi();
              setCleanupOpen(false);
            }
          }}
        >
          <div
            className="w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 space-y-2">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {t('resources.cleanupTitle')}
              </h3>
              <p className="text-[10px] text-zinc-400">
                {t('resources.cleanupHint', { days: idleDays })}
              </p>
              {ai.model === false ? (
                <AiNeedNotice model={false} agent={null} feature={t('resources.aiNeed.feat.cleanup')} compact onRetry={() => ai.refresh()} />
              ) : (
              <p className="text-[10px] text-violet-600/90 dark:text-violet-400/90">
                {t('resources.cleanupAiHint')}
              </p>
              )}
              {!hasStoredPortrait() && (
                <div className="flex items-start gap-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 px-2.5 py-2">
                  <p className="min-w-0 flex-1 text-[10px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    {t('resources.cleanupPortraitTip')}
                  </p>
                  <button
                    type="button"
                    disabled={idleLoading || idleAiLoading || busy === 'cleanup'}
                    onClick={() => {
                      abortIdleAi();
                      setCleanupOpen(false);
                      saveDiscoverType('skill');
                      changeViewTab('recommend');
                    }}
                    className="shrink-0 text-[10px] text-violet-600 dark:text-violet-400 hover:underline disabled:opacity-50"
                  >
                    {t('resources.cleanupPortraitAction')}
                  </button>
                </div>
              )}
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
                  {t('resources.cleanupDaysLabel')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={idleDays}
                  disabled={idleLoading || busy === 'cleanup'}
                  onChange={e => applyIdleDays(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      scanIdleSkills(idleDays);
                    }
                  }}
                  className="w-20 px-2 py-1 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200"
                />
                <span className="text-[11px] text-zinc-400">{t('resources.cleanupDaysUnit')}</span>
                <button
                  type="button"
                  disabled={idleLoading || idleAiLoading || busy === 'cleanup'}
                  onClick={() => scanIdleSkills(idleDays)}
                  className="ml-auto px-2.5 py-1 text-[11px] rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  {idleLoading || idleAiLoading
                    ? (idleAiLoading ? t('resources.cleanupAiAnalyzing') : t('resources.cleanupScanning'))
                    : t('resources.cleanupRescan')}
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2">
              {idleLoading ? (
                <CleanupSweepMotion label={t('resources.cleanupScanning')} />
              ) : !(idleResult?.items || []).length ? (
                <p className="text-xs text-zinc-400 py-6 text-center">{t('resources.cleanupEmpty', { days: idleDays })}</p>
              ) : (
                <>
                  {(() => {
                    // 分析中：只展示已出结果的条目（分析一个出来一个）
                    const visibleItems = idleAiLoading
                      ? idleResult.items.filter((it) => idleAiMap[it.id])
                      : idleResult.items;
                    const sorted = sortIdleByRecommendation(visibleItems, idleAiMap);
                    const recommendCount = sorted.filter((it) => idleAiMap[it.id]?.recommend).length;
                    return (
                      <>
                        {idleAiLoading && (
                          <div className="rounded-xl border border-amber-200/80 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20 px-3 py-2.5 space-y-2">
                            <div className="flex items-center gap-3">
                              <div className="tb-cleanup-sweep scale-75 origin-left shrink-0" aria-hidden="true" style={{ width: '5.5rem', height: '2.4rem', margin: 0 }}>
                                <span className="tb-cleanup-sweep__dust" />
                                <span className="tb-cleanup-sweep__dust" />
                                <span className="tb-cleanup-sweep__dust" />
                                <span className="tb-cleanup-sweep__floor" />
                                <span className="tb-cleanup-sweep__trail" />
                                <span className="tb-cleanup-sweep__broom">
                                  <span className="tb-cleanup-sweep__handle" />
                                  <span className="tb-cleanup-sweep__head" />
                                </span>
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="text-[11px] text-amber-800 dark:text-amber-200">
                                  {t('resources.cleanupAiAnalyzing')}
                                </p>
                                {idleAiProgress && idleAiProgress.total > 0 && (
                                  <p className="text-[10px] text-zinc-400 mt-0.5">
                                    {t('resources.cleanupAiBatchProgress', {
                                      done: idleAiProgress.done,
                                      total: idleAiProgress.total,
                                      batch: idleAiProgress.batch || 0,
                                      batches: idleAiProgress.batches || 0,
                                    })}
                                  </p>
                                )}
                              </div>
                            </div>
                            {idleAiProgress && idleAiProgress.total > 0 && (
                              <div className="h-1 rounded-full bg-amber-100 dark:bg-amber-900/40 overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-amber-500/85 transition-[width] duration-300"
                                  style={{
                                    width: `${Math.min(100, Math.round((idleAiProgress.done / idleAiProgress.total) * 100))}%`,
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        )}
                        <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-400">
                          <span>
                            {t('resources.cleanupSummary', { n: idleResult.items.length, total: idleResult.totalManaged })}
                            {recommendCount > 0 && (
                              <>
                                {' · '}
                                <span className="text-amber-600 dark:text-amber-400">
                                  {t('resources.cleanupAiRecommendN', { n: recommendCount })}
                                </span>
                              </>
                            )}
                          </span>
                          <div className="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              disabled={idleAiLoading || busy === 'cleanup'}
                              onClick={() => analyzeIdleWithAi(idleResult.items, idleDays)}
                              className="text-violet-600 dark:text-violet-400 hover:underline disabled:opacity-50"
                            >
                              {t('resources.cleanupAiRetry')}
                            </button>
                            <button
                              type="button"
                              disabled={idleAiLoading}
                              onClick={toggleIdleSelectAll}
                              className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                            >
                              {idleSelected.length
                                ? t('resources.cleanupDeselectAll')
                                : t('resources.cleanupSelectRecommended')}
                            </button>
                          </div>
                        </div>
                        {!idleAiLoading && idleAiMeta.source === 'ai' && (
                          <p className="text-[10px] text-violet-600/80 dark:text-violet-400/80">
                            {t('resources.cleanupAiDone')}
                            {idleAiMeta.skippedHeuristic > 0
                              ? ` ${t('resources.cleanupAiPartial', { n: idleAiMeta.skippedHeuristic })}`
                              : ''}
                          </p>
                        )}
                        {!idleAiLoading && idleAiMeta.source === 'heuristic' && (
                          <p className="text-[10px] text-zinc-400">
                            {t('resources.cleanupAiFallback')}
                            {idleAiMeta.error ? ` (${idleAiMeta.error})` : ''}
                          </p>
                        )}
                        {idleAiLoading && !sorted.length && (
                          <p className="text-[10px] text-zinc-400 py-4 text-center">
                            {t('resources.cleanupAiAnalyzing')}
                          </p>
                        )}
                        {sorted.map((item) => {
                          const checked = idleSelected.includes(item.id);
                          const ai = idleAiMap[item.id];
                          const recommended = !!ai?.recommend;
                          return (
                            <label
                              key={item.id}
                              className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer ${
                                checked
                                  ? recommended
                                    ? 'border-amber-300 dark:border-amber-700 bg-amber-50/60 dark:bg-amber-900/20'
                                    : 'border-zinc-300 dark:border-zinc-600 bg-zinc-50/80 dark:bg-zinc-800/50'
                                  : recommended
                                    ? 'border-amber-200/80 dark:border-amber-900/50 hover:bg-amber-50/40 dark:hover:bg-amber-950/20'
                                    : 'border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/40'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleIdleSelected(item.id)}
                                className="mt-0.5 rounded border-zinc-300 dark:border-zinc-600"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <p className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">
                                    {item.display_name || item.name}
                                  </p>
                                  {item.type === 'assistant' && (
                                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
                                      {t('resources.type.assistant')}
                                    </span>
                                  )}
                                  {recommended && (
                                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                                      {t('resources.cleanupAiBadge')}
                                    </span>
                                  )}
                                </div>
                                <p className="text-[10px] text-zinc-400 mt-0.5">
                                  {t('resources.cleanupIdleDays', { n: item.idleDays })}
                                  {' · '}
                                  {t('resources.cleanupLastActivity')}: {formatIdleTime(item.lastActivityAt)}
                                </p>
                                {ai?.reason && (
                                  <p className={`text-[11px] mt-1 leading-snug ${
                                    recommended
                                      ? 'text-amber-800/90 dark:text-amber-200/90'
                                      : 'text-zinc-500 dark:text-zinc-400'
                                  }`}
                                  >
                                    {recommended
                                      ? t('resources.cleanupAiReason', { reason: ai.reason })
                                      : t('resources.cleanupAiKeep', { reason: ai.reason })}
                                  </p>
                                )}
                                {item.authorityPath && (
                                  <p className="text-[10px] text-zinc-400 font-mono truncate mt-0.5" title={item.authorityPath}>
                                    {item.authorityPath}
                                  </p>
                                )}
                              </div>
                            </label>
                          );
                        })}
                      </>
                    );
                  })()}
                </>
              )}
            </div>
            <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 flex gap-2 justify-end">
              <button
                type="button"
                disabled={!!busy}
                onClick={() => {
                  abortIdleAi();
                  setCleanupOpen(false);
                }}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600 disabled:opacity-50"
              >
                {t('resources.cancel')}
              </button>
              <button
                type="button"
                disabled={!!busy || idleLoading || idleAiLoading || !idleSelected.length}
                onClick={confirmSkillCleanup}
                className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-500 disabled:opacity-40"
              >
                {busy === 'cleanup'
                  ? t('resources.cleanupRunning')
                  : t('resources.cleanupAction', { n: idleSelected.length })}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      <SkillInstallDialog
        open={skillInstallOpen}
        onClose={() => setSkillInstallOpen(false)}
        onNeedAgent={() => {
          // 没有执行应用：到「自我进化」页设置（那里再引导去纳管）
          setSkillInstallOpen(false);
          navigate('/guardian');
        }}
        onInstalled={async ({ resource } = {}) => {
          // 安装完成：扫描即纳管，找出新入库的技能，直接启用并选中
          const before = new Set((resources || []).filter(r => r.type === 'skill').map(r => r.id));
          await loadAll({ silent: true });
          let fresh = [];
          try {
            const res = await window.electronAPI.resource.listResources({ type: 'skill' });
            fresh = (res?.resources || []).filter(r => !before.has(r.id));
          } catch { /* ignore */ }
          if (resource?.id && !fresh.some(r => r.id === resource.id)) fresh.unshift(resource);
          if (!fresh.length) {
            setMsg(t('resources.skillInstall.nothingNew'));
            return;
          }
          const notes = [];
          for (const r of fresh.slice(0, 5)) {
            const note = await enableResource(r);
            if (note) notes.push(note);
          }
          focusResource(fresh[0]);
          setMsg(notes.length ? notes.join(' · ') : t('resources.installOk'));
        }}
      />

      {editorOpen && createPortal(
        <div
          className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/40"
        >
          <div
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {editorForm.id ? t('resources.editTitle') : t('resources.createOf', { type: t(`resources.tabType.${editorForm.type}`) })}
              </h3>
              <p className="text-[11px] text-zinc-400 mt-1">{asstBrief() ? t('resources.assistantBriefHint') : (asstIsNew() ? t('resources.assistantReviewHint') : t('resources.editorHint'))}</p>
            </div>
            <div className="p-4 space-y-3">
              {!editorForm.id && editorForm.pickType && (
                <div className="grid grid-cols-3 gap-1 p-1 rounded-xl bg-zinc-100 dark:bg-zinc-800/70" role="radiogroup" aria-label={t('resources.editorType')}>
                  {['prompt', 'skill', 'assistant'].map(ty => (
                    <button
                      key={ty}
                      type="button"
                      role="radio"
                      aria-checked={editorForm.type === ty}
                      onClick={() => setEditorForm(prev => ({ ...prev, type: ty, asStep: ty === 'assistant' ? (prev.asStep || 'brief') : prev.asStep }))}
                      className={`text-xs py-1.5 rounded-lg transition ${editorForm.type === ty ? 'bg-white dark:bg-zinc-900 shadow-sm font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'}`}
                    >
                      {t(`resources.tabType.${ty}`)}
                    </button>
                  ))}
                </div>
              )}
              {!!editorForm.id && (
              <label className="block text-xs text-zinc-500">
                {t('resources.editorType')}
                <select
                  value={editorForm.type}
                  disabled={!!editorForm.id}
                  onChange={e => {
                    const type = e.target.value;
                    setEditorForm((prev) => {
                      if (type === 'assistant' && prev.type !== 'assistant') {
                        const parsed = parseAssistantEditorContent(prev.content);
                        return {
                          ...prev,
                          type,
                          soul: parsed.soul || prev.soul || '',
                          skills: parsed.skills?.length ? parsed.skills : (prev.skills || []),
                          prompts: parsed.prompts || prev.prompts || [],
                          runtime_agent: parsed.runtime_agent || prev.runtime_agent || '',
                          parameters: parsed.parameters || prev.parameters,
                          assistantExtra: parsed.extra || prev.assistantExtra || {},
                        };
                      }
                      return { ...prev, type };
                    });
                  }}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                >
                  {TYPE_OPTIONS.filter(o => o.id).map(opt => (
                    <option key={opt.id} value={opt.id}>{t(opt.labelKey)}</option>
                  ))}
                </select>
              </label>
              )}
              {asstIsNew() && !asstBrief() && editorForm.display_name && !editorForm.metaEdit && (
                <div className="flex items-start gap-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-800/40 px-3 py-2.5">
                  <span className="shrink-0 w-9 h-9 rounded-lg bg-violet-600 text-white flex items-center justify-center text-sm font-bold">
                    {String(editorForm.display_name).trim().slice(0, 1).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{editorForm.display_name}</div>
                    <div className="text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-2">{editorForm.description || t('resources.emptyDetail')}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditorForm(prev => ({ ...prev, metaEdit: true }))}
                    className="shrink-0 text-[11px] text-violet-600 dark:text-violet-400 hover:underline"
                  >
                    {t('resources.editorEdit')}
                  </button>
                </div>
              )}
              {editorForm.type === 'prompt' && !editorForm.id && !editorForm.moreOpen && (
                <div className="space-y-2">
                  <textarea
                    autoFocus
                    value={editorForm.content}
                    onChange={e => setEditorForm(prev => ({ ...prev, content: e.target.value }))}
                    rows={10}
                    placeholder={editorForm.promptKind === 'image' ? t('resources.promptQuickPhImage') : t('resources.promptQuickPh')}
                    className="w-full text-[13px] px-3 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 leading-relaxed"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800/70" role="radiogroup" aria-label={t('resources.editorPromptKind')}>
                      {['text', 'image'].map(k => (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={(editorForm.promptKind === 'image' ? 'image' : 'text') === k}
                          onClick={() => setEditorForm(prev => ({ ...prev, promptKind: k }))}
                          className={`text-[11px] px-2.5 py-1 rounded-md ${(editorForm.promptKind === 'image' ? 'image' : 'text') === k ? 'bg-white dark:bg-zinc-900 shadow-sm text-zinc-900 dark:text-zinc-100 font-medium' : 'text-zinc-500'}`}
                        >
                          {t(`resources.promptKind.${k}`)}
                        </button>
                      ))}
                    </div>
                    <input
                      value={editorForm.display_name}
                      onChange={e => setEditorForm(prev => ({ ...prev, display_name: e.target.value }))}
                      placeholder={t('resources.promptQuickNamePh')}
                      className="flex-1 min-w-[10rem] text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditorForm(prev => ({ ...prev, moreOpen: true }))}
                    className="text-[11px] text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                  >
                    {t('resources.promptQuickMore')}
                  </button>
                </div>
              )}
              {editorForm.type === 'prompt' && (editorForm.id || editorForm.moreOpen) && (
                <label className="block text-xs text-zinc-500">
                  {t('resources.editorPromptKind')}
                  <select
                    value={editorForm.promptKind === 'image' ? 'image' : 'text'}
                    onChange={e => setEditorForm(prev => ({ ...prev, promptKind: e.target.value }))}
                    className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                  >
                    <option value="text">{t('resources.promptKind.text')}</option>
                    <option value="image">{t('resources.promptKind.image')}</option>
                  </select>
                  <span className="block mt-1 text-[10px] text-zinc-400">{t('resources.editorPromptKindHint')}</span>
                </label>
              )}
              {editorForm.type !== 'assistant' && !quickPrompt() && (
              <label className="block text-xs text-zinc-500">
                {t('resources.editorName')}
                <input
                  value={editorForm.name}
                  disabled={!!editorForm.id}
                  onChange={e => setEditorForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="code-review"
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono"
                />
              </label>
              )}
              {!asstBrief() && !quickPrompt() && !(asstIsNew() && editorForm.display_name && !editorForm.metaEdit) && (
              <label className="block text-xs text-zinc-500">
                {t('resources.editorDisplayName')}
                <input
                  value={editorForm.display_name}
                  onChange={e => setEditorForm(prev => ({ ...prev, display_name: e.target.value }))}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                />
              </label>
              )}
              {!asstBrief() && !quickPrompt() && !(asstIsNew() && editorForm.display_name && !editorForm.metaEdit) && (
              <label className="block text-xs text-zinc-500">
                {t('resources.editorDescription')}
                <input
                  value={editorForm.description}
                  onChange={e => setEditorForm(prev => ({ ...prev, description: e.target.value }))}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                />
              </label>
              )}
              {editorForm.type !== 'assistant' && !quickPrompt() && (
              <label className="block text-xs text-zinc-500">
                {t('resources.editorDetail')}
                <textarea
                  value={editorForm.detail || ''}
                  onChange={e => setEditorForm(prev => ({ ...prev, detail: e.target.value }))}
                  rows={5}
                  placeholder={t('resources.editorDetailHint')}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 leading-relaxed"
                />
                <span className="block mt-1 text-[10px] text-zinc-400">{t('resources.editorDetailHint')}</span>
              </label>
              )}
              {editorForm.type !== 'assistant' && !quickPrompt() && (
              <label className="block text-xs text-zinc-500">
                {t('resources.editorTags')}
                <input
                  value={editorForm.tagsText || ''}
                  onChange={e => setEditorForm(prev => ({ ...prev, tagsText: e.target.value }))}
                  placeholder={t('resources.editorTagsPh')}
                  className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                />
                <span className="block mt-1 text-[10px] text-zinc-400">{t('resources.editorTagsHint')}</span>
              </label>
              )}
              {editorForm.type === 'assistant' ? (
                <>
                  {asstBrief() ? (
                  <div className="space-y-2">
                    <AiNeedNotice model={ai.model} agent={null} feature={t('resources.aiNeed.feat.assistant')} compact onRetry={() => ai.refresh()} />
                    <textarea
                      autoFocus
                      value={editorForm.nlBrief || ''}
                      onChange={e => setEditorForm(prev => ({ ...prev, nlBrief: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ai.model !== false) generateAssistantNl(); }}
                      rows={4}
                      placeholder={t('resources.assistantNlPh')}
                      className="w-full text-sm px-3 py-2.5 rounded-xl border border-violet-200 dark:border-violet-800/60 bg-white dark:bg-zinc-950 leading-relaxed focus:outline-none focus:ring-2 focus:ring-violet-400/40"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {(t('resources.assistantExamples') || '').split('|').filter(Boolean).map((ex) => {
                        const [label, text] = ex.split('::');
                        return (
                          <button
                            key={label}
                            type="button"
                            onClick={() => setEditorForm(prev => ({ ...prev, nlBrief: text || label }))}
                            className="text-[11px] px-2 py-1 rounded-full border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-violet-300 hover:text-violet-700 dark:hover:text-violet-300"
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        disabled={!!busy || ai.model === false}
                        title={ai.model === false ? t('resources.aiNeed.title.model', { feature: t('resources.aiNeed.feat.assistant') }) : undefined}
                        onClick={generateAssistantNl}
                        className="tb-press text-xs px-3.5 py-1.5 rounded-lg bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50"
                      >
                        {busy === 'assistant-nl' ? t('resources.busy') : t('resources.assistantNlGenerate')}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() => setEditorForm(prev => ({ ...prev, asStep: 'form', soul: prev.soul || String(prev.nlBrief || '').trim() }))}
                        className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:underline disabled:opacity-50"
                      >
                        {t('resources.assistantManual')}
                      </button>
                    </div>
                    <p className="text-[10px] text-zinc-400">{t('resources.assistantNlHint')}</p>
                  </div>
                  ) : (
                  <>
                  {asstIsNew() && (
                    <button
                      type="button"
                      onClick={() => setEditorForm(prev => ({ ...prev, asStep: 'brief' }))}
                      className="text-[11px] text-violet-600 dark:text-violet-400 hover:underline"
                    >
                      ← {t('resources.assistantRebrief')}
                    </button>
                  )}
                  {asstIsNew() && String(editorForm.soul || '').trim() && !editorForm.soulEdit ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs text-zinc-500">
                        <span>{t('resources.assistantSoul')}</span>
                        <button
                          type="button"
                          onClick={() => setEditorForm(prev => ({ ...prev, soulEdit: true }))}
                          className="text-[11px] text-violet-600 dark:text-violet-400 hover:underline"
                        >
                          {t('resources.editorExpandEdit')}
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setEditorForm(prev => ({ ...prev, soulEdit: true }))}
                        className="w-full text-left text-xs leading-relaxed whitespace-pre-wrap line-clamp-4 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/70 dark:bg-zinc-800/40 px-2.5 py-2 text-zinc-700 dark:text-zinc-300 hover:border-violet-300"
                      >
                        {editorForm.soul}
                      </button>
                    </div>
                  ) : (
                  <label className="block text-xs text-zinc-500">
                    {t('resources.assistantSoul')}
                    <textarea
                      value={editorForm.soul || ''}
                      onChange={e => setEditorForm(prev => ({ ...prev, soul: e.target.value }))}
                      rows={6}
                      spellCheck={false}
                      placeholder={t('resources.assistantSoulPh')}
                      className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 leading-relaxed"
                    />
                  </label>
                  )}
                  <details className="group rounded-lg border border-zinc-200 dark:border-zinc-700 px-2.5 py-2">
                    <summary className="flex items-center justify-between gap-2 cursor-pointer list-none">
                      <span className="text-xs text-zinc-600 dark:text-zinc-300">{t('resources.assistantSkills')}</span>
                      <span className="min-w-0 flex items-center gap-1 text-[10px] text-zinc-400">
                        {(editorForm.skills || []).length ? (
                          <span className="truncate max-w-[260px] text-zinc-600 dark:text-zinc-300">
                            {(editorForm.skills || []).map(n => {
                              const r = (resources || []).find(x => x.type === 'skill' && x.name === n);
                              return (r && (r.display_name || r.name)) || n;
                            }).join('、')}
                          </span>
                        ) : t('resources.assistantSkillsPicked', { n: 0 })}
                        <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
                      </span>
                    </summary>
                    <div className="space-y-1.5 mt-2">
                    <input
                      value={editorForm.skillQuery || ''}
                      onChange={e => setEditorForm(prev => ({ ...prev, skillQuery: e.target.value }))}
                      placeholder={t('resources.assistantSkillsSearch')}
                      className="w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                    />
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
                      {(() => {
                        const q = String(editorForm.skillQuery || '').trim().toLowerCase();
                        const list = (resources || [])
                          .filter((r) => r.type === 'skill')
                          .filter((r) => {
                            if (!q) return true;
                            const hay = `${r.name} ${r.display_name || ''} ${r.description || ''}`.toLowerCase();
                            return hay.includes(q);
                          })
                          .slice(0, 120);
                        if (!list.length) {
                          return (
                            <p className="px-2.5 py-3 text-[11px] text-zinc-400">{t('resources.assistantSkillsEmpty')}</p>
                          );
                        }
                        const picked = new Set(editorForm.skills || []);
                        return list.map((sk) => (
                          <label
                            key={sk.id || sk.name}
                            className="flex items-start gap-2 px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={picked.has(sk.name)}
                              onChange={() => toggleEditorSkill(sk.name)}
                              className="mt-0.5 shrink-0"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-xs text-zinc-800 dark:text-zinc-200 truncate">
                                {sk.display_name || sk.name}
                              </span>
                              <span className="block text-[10px] font-mono text-zinc-400 truncate">{sk.name}</span>
                              {sk.description ? (
                                <span className="block text-[10px] text-zinc-400 line-clamp-1">{sk.description}</span>
                              ) : null}
                            </span>
                          </label>
                        ));
                      })()}
                    </div>
                    <p className="text-[10px] text-zinc-400">{t('resources.assistantSkillsHint')}</p>
                    </div>
                  </details>
                  <details className="group rounded-lg border border-zinc-200 dark:border-zinc-700 px-2.5 py-2">
                    <summary className="flex items-center justify-between gap-2 cursor-pointer list-none">
                      <span className="text-xs text-zinc-600 dark:text-zinc-300">{t('resources.assistantPrompts')}</span>
                      <span className="min-w-0 flex items-center gap-1 text-[10px] text-zinc-400">
                        {(editorForm.prompts || []).length ? (
                          <span className="truncate max-w-[260px] text-zinc-600 dark:text-zinc-300">
                            {(editorForm.prompts || []).map(n => {
                              const r = (resources || []).find(x => x.type === 'prompt' && x.name === n);
                              return (r && (r.display_name || r.name)) || n;
                            }).join('、')}
                          </span>
                        ) : t('resources.assistantPromptsPicked', { n: 0 })}
                        <span className="ml-1 inline-block transition-transform group-open:rotate-90">›</span>
                      </span>
                    </summary>
                    <div className="space-y-1.5 mt-2">
                    <input
                      value={editorForm.promptQuery || ''}
                      onChange={e => setEditorForm(prev => ({ ...prev, promptQuery: e.target.value }))}
                      placeholder={t('resources.assistantPromptsSearch')}
                      className="w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                    />
                    <div className="max-h-40 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 divide-y divide-zinc-100 dark:divide-zinc-800">
                      {(() => {
                        const q = String(editorForm.promptQuery || '').trim().toLowerCase();
                        const list = (resources || [])
                          .filter((r) => r.type === 'prompt')
                          .filter((r) => {
                            if (!q) return true;
                            const hay = `${r.name} ${r.display_name || ''} ${r.description || ''}`.toLowerCase();
                            return hay.includes(q);
                          })
                          .slice(0, 120);
                        if (!list.length) {
                          return (
                            <p className="px-2.5 py-3 text-[11px] text-zinc-400">{t('resources.assistantPromptsEmpty')}</p>
                          );
                        }
                        const picked = new Set(editorForm.prompts || []);
                        return list.map((pr) => (
                          <label
                            key={pr.id || pr.name}
                            className="flex items-start gap-2 px-2.5 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={picked.has(pr.name)}
                              onChange={() => toggleEditorPrompt(pr.name)}
                              className="mt-0.5 shrink-0"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span className="block text-xs text-zinc-800 dark:text-zinc-200 truncate">
                                  {pr.display_name || pr.name}
                                </span>
                                <span className="shrink-0 text-[10px] px-1 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">
                                  {t(promptKindOf(pr) === 'image' ? 'resources.promptKind.image' : 'resources.promptKind.text')}
                                </span>
                              </span>
                              <span className="block text-[10px] font-mono text-zinc-400 truncate">{pr.name}</span>
                              {pr.description ? (
                                <span className="block text-[10px] text-zinc-400 line-clamp-1">{pr.description}</span>
                              ) : null}
                            </span>
                          </label>
                        ));
                      })()}
                    </div>
                    <p className="text-[10px] text-zinc-400">{t('resources.assistantPromptsHint')}</p>
                    </div>
                  </details>
                  {asstIsNew() && (editorForm.suggestSkills || []).length > 0 && (
                    <div className="rounded-lg border border-violet-200/80 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-950/20 px-2.5 py-2 space-y-1.5">
                      <div className="text-xs font-medium text-violet-700 dark:text-violet-300">{t('resources.assistantSuggestTitle')}</div>
                      {editorForm.suggestSkills.map((c, i) => (
                        <label key={c.catalogId} className="flex items-start gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={!!c.checked}
                            onChange={() => setEditorForm(prev => ({
                              ...prev,
                              suggestSkills: prev.suggestSkills.map((x, k) => (k === i ? { ...x, checked: !x.checked } : x)),
                            }))}
                            className="mt-0.5 shrink-0"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-1.5">
                              <span className="text-xs text-zinc-800 dark:text-zinc-200 truncate">{c.display_name || c.name}</span>
                              <span className={`shrink-0 text-[10px] px-1.5 py-px rounded ${c.paid ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'}`}>
                                {c.paid
                                  ? (editorForm.installCost != null ? t('resources.assistantSuggestCost', { cost: editorForm.installCost }) : t('resources.assistantSuggestPaid'))
                                  : t('resources.assistantSuggestFree')}
                              </span>
                            </span>
                            {c.description ? <span className="block text-[10px] text-zinc-400 line-clamp-1">{c.description}</span> : null}
                          </span>
                        </label>
                      ))}
                      <p className="text-[10px] text-violet-500/90 dark:text-violet-400/80">{t('resources.assistantSuggestHint')}</p>
                      <div className={`flex items-center justify-between gap-2 pt-1.5 mt-0.5 border-t text-[11px] ${asstPaidCount() ? 'border-amber-200 dark:border-amber-800/50 text-amber-800 dark:text-amber-300' : 'border-violet-200/70 dark:border-violet-800/40 text-violet-700 dark:text-violet-300'}`}>
                        <span>{t('resources.assistantCostLabel')}</span>
                        <b className="font-semibold tabular-nums">
                          {!asstPaidCount()
                            ? t('resources.assistantCostFree')
                            : asstCost() != null
                              ? t('resources.assistantCostPaid', { cost: asstCost(), n: asstPaidCount() })
                              : (localStorage.getItem('token') ? t('resources.assistantCostUnknown', { n: asstPaidCount() }) : t('resources.assistantCostLogin', { n: asstPaidCount() }))}
                        </b>
                      </div>
                    </div>
                  )}
                  {asstIsNew() && (editorForm.missingCaps || []).length > 0 && (
                    <div className="rounded-lg border border-amber-200/80 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/20 px-2.5 py-2 space-y-1.5">
                      <div className="text-xs text-amber-800 dark:text-amber-300">
                        {t('resources.assistantMissing', { list: editorForm.missingCaps.join('、') })}
                      </div>
                      <div className="flex flex-wrap gap-3">
                        <button
                          type="button"
                          onClick={() => setSkillInstallOpen(true)}
                          className="text-[11px] text-amber-800 dark:text-amber-300 underline underline-offset-2"
                        >
                          {t('resources.assistantMissingInstall')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditorOpen(false);
                            saveDiscoverType('skill');
                            changeViewTab('recommend');
                          }}
                          className="text-[11px] text-amber-800 dark:text-amber-300 underline underline-offset-2"
                        >
                          {t('resources.assistantMissingDiscover')}
                        </button>
                      </div>
                    </div>
                  )}
                  <details className="group">
                    <summary className="cursor-pointer list-none text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200">
                      <span className="inline-block mr-1 transition-transform group-open:rotate-90">›</span>{t('resources.editorAdvanced')}
                    </summary>
                    <div className="mt-2 space-y-3">
                      <label className="block text-xs text-zinc-500">
                        {t('resources.editorDetail')}
                        <textarea
                          value={editorForm.detail || ''}
                          onChange={e => setEditorForm(prev => ({ ...prev, detail: e.target.value }))}
                          rows={5}
                          placeholder={t('resources.editorDetailHint')}
                          className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 leading-relaxed"
                        />
                        <span className="block mt-1 text-[10px] text-zinc-400">{t('resources.editorDetailHint')}</span>
                      </label>
                      <label className="block text-xs text-zinc-500">
                        {t('resources.editorName')}
                        <input
                          value={editorForm.name}
                          disabled={!!editorForm.id}
                          onChange={e => setEditorForm(prev => ({ ...prev, name: e.target.value }))}
                          placeholder={t('resources.editorNameAuto')}
                          className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono"
                        />
                      </label>
                      <label className="block text-xs text-zinc-500">
                        {t('resources.editorTags')}
                        <input
                          value={editorForm.tagsText || ''}
                          onChange={e => setEditorForm(prev => ({ ...prev, tagsText: e.target.value }))}
                          placeholder={t('resources.editorTagsPh')}
                          className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                        />
                      </label>
                    </div>
                  </details>
                  </>
                  )}
                </>
              ) : quickPrompt() ? null : (
                <label className="block text-xs text-zinc-500">
                  {t('resources.editorContent')}
                  <textarea
                    value={editorForm.content}
                    onChange={e => setEditorForm(prev => ({ ...prev, content: e.target.value }))}
                    rows={12}
                    spellCheck={false}
                    placeholder={
                      editorForm.type === 'skill'
                        ? t('resources.skillBodyPh')
                        : ''
                    }
                    className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono leading-relaxed"
                  />
                </label>
              )}
            </div>
            <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 flex gap-2 justify-end items-center">
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                disabled={busy === 'editor' || busy === 'assistant-nl'}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600 disabled:opacity-50"
              >
                {t('resources.cancel')}
              </button>
              {!asstBrief() && (
              <button
                type="button"
                disabled={!!busy}
                onClick={saveEditor}
                className="tb-press text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy === 'editor' ? t('resources.busy') : (asstIsNew()
                  ? (asstPaidCount() && asstCost() != null ? t('resources.saveAndEnableCost', { cost: asstCost() }) : t('resources.saveAndEnable'))
                  : (!editorForm.id ? t('resources.saveAndEnable') : t('resources.save')))}
              </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
