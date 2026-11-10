// client/src/pages/Contribute.jsx
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { getStats, getSettlements, getContributeSummary, listJoinedCircles, listMyCircles, listCommunityAgents, listPublicCommunityAgents } from '../api/client';
import { getConfig, getGateway, getLocalConfig } from '../api/adapter';
import { resolveLocalGatewayBase } from '../api/gatewayModels';
import { loadUserAccounts } from '../api/userAccounts';
import { collectPersonalAvailableModels, mergeAccountsForGateway } from '../lib/personalAvailableModels';
import {
  getAgentStatus, startAgent, stopAgent, getAgentLogs,
  subscribeAgentEvents, useAgentPolling,
} from '../api/agentControl';
import Circles from './Circles';
import Network from './Network';
import { SessionTraceModal } from './Gateway';
import TruncTip from '../components/TruncTip';
import CommunityEarningsCard from '../components/CommunityEarningsCard';
import { useLang } from '../store/lang';
import { useAuth } from '../store/index';
import { fmtContribTokens, fmtCreditCny, creditsToCny } from '../lib/credit-pricing';
import { avatarColor } from '../components/UserAvatar';
import {
  LIB_LIST_CLS, libRowCls, LibraryRowTitle, LibraryInspector, InspectorSection, LibrarySectionHead, FilterMenu,
} from '../components/LibraryControls';
import ServiceIcon from '../components/ServiceIcon';
import { resolveBrandIcon } from '../lib/brandIcons';
import { getServerUrl } from '../config';
import { copyText } from '../lib/resource-enable';
function multiplierToStars(m) {
  const n = m >= 1.3 ? 5 : m >= 1.1 ? 4 : m >= 0.9 ? 3 : m >= 0.7 ? 2 : 1;
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

/** 兼容 API 返回 list 或 JSON 字符串 */
function normalizeSettlementResources(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || '').trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        return data.map((x) => String(x || '').trim()).filter(Boolean);
      }
    } catch { /* ignore */ }
  }
  return [];
}

/** 结算时间：去掉 ISO 的 T，显示为 YYYY-MM-DD HH:mm（period_end 为墙钟时间，不按 UTC 偏移） */
function formatSettlementTime(iso) {
  if (!iso) return '—';
  const m = String(iso).trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[1]} ${m[2]}:${m[3]}`;
  return String(iso).slice(0, 16).replace('T', ' ');
}

/** 结算资源展示：模型名原样；agent → 智能体裸名（去掉「昵称的」前缀） */
function formatSettlementResource(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  let raw = s.startsWith('agent:') ? s.slice(6).trim() : s;
  // 兼容 id 形态与「所有者的名称」历史展示名
  raw = raw.replace(/^res-assistant-/, '').replace(/-assistant$/, '');
  const m = raw.match(/^(.+?)的(.+)$/);
  if (m && m[2]) raw = m[2].trim();
  return raw || s;
}

/** 按圈子 id 去重（统一为 number，避免 owned/joined 合并重复） */
function uniqueCircles(list) {
  const map = new Map();
  for (const c of list || []) {
    const id = Number(c.id);
    if (!id || map.has(id)) continue;
    map.set(id, { ...c, id });
  }
  return [...map.values()];
}

function uniqueCircleIds(ids) {
  return [...new Set((ids || []).map(id => Number(id)).filter(Boolean))];
}

/** 贡献可选模型：个人源 + agent providers + 已保存配置；类型取最高优先级（图文可覆盖 chat） */
function collectContributeAvailableModels(saved, accounts, localCfg) {
  const merged = mergeAccountsForGateway(localCfg || {}, accounts || {});
  const typeByName = {};
  const rank = (t) => {
    if (t === 'image' || t === 'embedding') return 3;
    if (t === 'vision') return 2;
    return 1;
  };
  const bump = (name, type = 'chat') => {
    const n = String(name || '').trim();
    if (!n) return;
    let t = String(type || 'chat').trim().toLowerCase();
    if (t === 'vl' || t === 'vlm' || t === 'multimodal') t = 'vision';
    else if (t === 'img' || t === 'imggen') t = 'image';
    else if (t === 'embed' || t === 'embeddings') t = 'embedding';
    else if (!['chat', 'vision', 'image', 'embedding'].includes(t)) t = 'chat';
    const cur = typeByName[n];
    // 非 chat 优先，避免个人源先写入 chat 盖住供给源上的图文
    if (!cur || rank(t) >= rank(cur)) typeByName[n] = t;
  };

  for (const { id } of collectPersonalAvailableModels(saved || {}, merged)) {
    bump(id, 'chat');
  }

  for (const p of (saved?.providers || [])) {
    if (p.type === 'p2p') continue;
    for (const m of (p.models || [])) {
      const name = typeof m === 'string' ? m : m.name;
      const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
      bump(name, type);
    }
  }

  for (const m of (saved?.models || [])) {
    const name = typeof m === 'string' ? m : m.name;
    const type = typeof m === 'string' ? 'chat' : (m.type || 'chat');
    bump(name, type);
  }

  for (const g of (saved?.model_groups || [])) {
    for (const m of (g.models || [])) {
      const name = typeof m === 'string' ? m : m.name;
      bump(name, typeof m === 'string' ? 'chat' : (m.type || 'chat'));
    }
  }

  return Object.entries(typeByName)
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function ContributionConfigCard({ onStart, onStop, running, agentError, onAgentsRefresh, circles: circlesProp = null, onManageCircles }) {
  const { t } = useLang();
  const location = useLocation();
  const pageActive = location.pathname === '/contribute';
  const [selectedNames,   setSelectedNames]   = useState(new Set()); // Set<string>
  const [availableModels, setAvailableModels] = useState([]);        // {name, type}[]
  const [availableAssistants, setAvailableAssistants] = useState([]);
  // 已安装、可按智能体同样上架的本机应用（Claude Code、Pi 等）
  const [availableApps, setAvailableApps] = useState([]);
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [selectedAssistantIds, setSelectedAssistantIds] = useState(new Set());
  const [nodeName,        setNodeName]        = useState('');
  const [autoStart,       setAutoStart]       = useState(false);
  const [saving,          setSaving]          = useState(false);
  const [savedMsg,        setSavedMsg]        = useState('');
  const [localGw,         setLocalGw]         = useState(() => resolveLocalGatewayBase());
  const [circles,         setCircles]         = useState([]);         // 可分享的圈子
  // 交易页「圈子」页签里新建 / 加入后同步到这里
  useEffect(() => { if (circlesProp) setCircles(uniqueCircles(circlesProp)); }, [circlesProp]);
  const [circleScope,     setCircleScope]     = useState('public');   // 'public' | 'circle'
  const [selectedCircleIds, setSelectedCircleIds] = useState(new Set());
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showAssistantPicker, setShowAssistantPicker] = useState(false);
  const [copiedAssistantId, setCopiedAssistantId] = useState('');
  const [assistantPickerBusy, setAssistantPickerBusy] = useState(false);
  // 首次加载时同步贡献配置里的已选智能体；之后刷新列表不覆盖用户勾选
  const assistantsHydratedRef = useRef(false);

  /** 可上架的非内置智能体（含投射状态，供选择器过滤） */
  const refreshAssistants = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.resource?.listResources) {
      return [];
    }
    try {
      const asstRes = await window.electronAPI.resource.listResources({ type: 'assistant' });
      const assistants = asstRes?.success ? (asstRes.resources || []) : (asstRes?.resources || []);
      const contributable = (Array.isArray(assistants) ? assistants : []).filter((a) => {
        if (!a) return false;
        if (a.source === 'builtin' || a.metadata?.builtin) return false;
        if (String(a.source_url || '').startsWith('builtin:')) return false;
        return true;
      });
      setAvailableAssistants(contributable);
      // 已选里去掉库中已删除的项；不重置用户刚勾选的
      const allowedIds = new Set(contributable.map((a) => a.id));
      setSelectedAssistantIds((prev) => {
        if (!assistantsHydratedRef.current) return prev;
        let changed = false;
        const next = new Set();
        for (const id of prev) {
          // app: 是本机应用，不在智能体资源库里
          if (allowedIds.has(id) || String(id).startsWith('app:')) next.add(id);
          else changed = true;
        }
        return changed ? next : prev;
      });
      return contributable;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    Promise.all([listMyCircles(), listJoinedCircles()])
      .then(([ownedRes, joinedRes]) => {
        const owned = ownedRes.data?.circles || [];
        const joined = joinedRes.data?.circles || [];
        setCircles(uniqueCircles([...owned, ...joined]));
      })
      .catch(() => {});
    Promise.all([
      getConfig().read().catch(() => null),
      getGateway().status().catch(() => null),
      loadUserAccounts().catch(() => ({})),
      getLocalConfig().get().catch(() => ({})),
      (typeof window !== 'undefined' && window.electronAPI?.resource?.listResources)
        ? window.electronAPI.resource.listResources({ type: 'assistant' }).catch(() => null)
        : Promise.resolve(null),
    ]).then(([saved, gwStatus, accounts, localCfg, asstRes]) => {
      // Dynamic gateway URL from actual running port
      const port = gwStatus?.port || 11430;
      const gw   = resolveLocalGatewayBase(port);
      setLocalGw(gw);

      const cfg = saved || {};
      const avail = collectContributeAvailableModels(cfg, accounts, localCfg);
      const prevNames = new Set(
        (cfg.model_groups || [])
          .flatMap(g => g.models || [])
          .map(m => typeof m === 'string' ? m : m.name)
          .filter(Boolean)
      );
      setAvailableModels(avail);
      setSelectedNames(prevNames);
      setNodeName(cfg.name || '');
      setAutoStart(!!cfg.auto_start);
      if (cfg.contribute_circle_ids?.length) {
        setCircleScope('circle');
        setSelectedCircleIds(new Set(uniqueCircleIds(cfg.contribute_circle_ids)));
      } else if (cfg.contribute_circle_id) {
        setCircleScope('circle');
        setSelectedCircleIds(new Set(uniqueCircleIds([cfg.contribute_circle_id])));
      }
      const assistants = asstRes?.success ? (asstRes.resources || []) : (asstRes?.resources || []);
      // 内置智能体不出现在贡献列表
      const contributable = (Array.isArray(assistants) ? assistants : []).filter((a) => {
        if (!a) return false;
        if (a.source === 'builtin' || a.metadata?.builtin) return false;
        if (String(a.source_url || '').startsWith('builtin:')) return false;
        return true;
      });
      setAvailableAssistants(contributable);
      const allowedIds = new Set(contributable.map((a) => a.id));
      const prevAsst = new Set(
        (cfg.contribute_assistants || [])
          .map((x) => (typeof x === 'string' ? x : x?.id))
          .filter((id) => id && (allowedIds.has(id) || String(id).startsWith('app:'))),
      );
      setSelectedAssistantIds(prevAsst);
      assistantsHydratedRef.current = true;
    });
  }, []);

  /** 已安装的本机应用，名片 id 用 app:<cli>，和智能体走同一份上架名单 */
  const refreshApps = useCallback(async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent?.listAgents) return [];
    try {
      const res = await window.electronAPI.agent.listAgents();
      const list = Array.isArray(res?.agents) ? res.agents : [];
      const rentable = new Set(['claude-code', 'codex', 'cursor', 'kimi-code', 'pi']);
      const apps = list.filter((a) => a && a.type === 'cli' && a.installed && rentable.has(a.id));
      setAvailableApps(apps);
      setAppsLoaded(true);
      return apps;
    } catch {
      return [];
    }
  }, []);

  // 打开「上架智能体」选择器时重新拉取，避免资源页刚投射后此处仍是旧列表
  useEffect(() => {
    if (!showAssistantPicker) return undefined;
    let cancelled = false;
    setAssistantPickerBusy(true);
    Promise.all([refreshAssistants(), refreshApps()])
      .finally(() => {
        if (!cancelled) setAssistantPickerBusy(false);
      });
    return () => { cancelled = true; };
  }, [showAssistantPicker, refreshAssistants, refreshApps]);

  // KeepAlive：从资源页切回交易页时刷新投射状态和已安装应用
  useEffect(() => {
    if (!pageActive) return;
    refreshAssistants();
    refreshApps();
  }, [pageActive, refreshAssistants, refreshApps]);

  function toggleModel(name) {
    setSelectedNames(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function toggleAssistant(id) {
    setSelectedAssistantIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** 复制已分享智能体的网页版链接（全球/圈子共用 /a/{id}） */
  async function copyAssistantWebLink(id) {
    const base = (getServerUrl() || '').replace(/\/$/, '');
    if (!base || !id) return;
    const url = `${base}/a/${encodeURIComponent(id)}`;
    const ok = await copyText(url);
    if (ok) {
      setCopiedAssistantId(id);
      setTimeout(() => setCopiedAssistantId((cur) => (cur === id ? '' : cur)), 1500);
    }
  }

  function listedAppRuntime(id) {
    const raw = String(id || '');
    return raw.startsWith('app:') ? raw.slice(4) : '';
  }

  function assistantDisabledReason(r) {
    // 内置智能体不可贡献（列表侧已过滤；此处兜底）
    if (r?.source === 'builtin' || r?.metadata?.builtin
      || String(r?.source_url || '').startsWith('builtin:')) {
      return t('contribute.assistantBuiltinBlocked');
    }
    const ENABLE = new Set(['claude-code', 'codex', 'cursor', 'kimi-code', 'workbuddy']);
    const ok = (r.projections || []).some((p) => ENABLE.has(p.agentId || p.agent_id));
    if (!ok) return t('contribute.assistantNeedProject');
    return '';
  }

  function toggleCircle(id) {
    const nid = Number(id);
    if (!nid) return;
    setSelectedCircleIds(prev => {
      const next = new Set(prev);
      if (next.has(nid)) next.delete(nid); else next.add(nid);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setSavedMsg('');
    try {
      const models = [...selectedNames].map(name =>
        availableModels.find(m => m.name === name) || { name, type: 'chat' }
      );
      const model_groups = [{ base_url: localGw, token: '', models }];
      const current      = (await getConfig().read().catch(() => null)) || {};
      const visibility = circleScope === 'circle' ? 'circle' : 'public';
      const contribute_assistants = [...selectedAssistantIds]
        .filter((id) => {
          if (String(id).startsWith('app:')) {
            // 安装列表还没回来时保留已选项，避免保存把应用抹掉
            if (!appsLoaded) return true;
            const runtime = id.slice(4);
            return availableApps.some((a) => a.id === runtime);
          }
          const row = availableAssistants.find((a) => a.id === id);
          return row && !assistantDisabledReason(row);
        })
        .map((id) => ({ id, visibility }));
      const updated      = {
        ...current,
        model_groups,
        llm_base_url: localGw,
        llm_token: '',
        models,
        name: nodeName,
        auto_start: autoStart,
        contribute_assistants,
      };
      const circleIds = circleScope === 'circle' ? uniqueCircleIds([...selectedCircleIds]) : [];
      await getConfig().write({
        ...updated,
        contribute_circle_ids: circleIds,
        contribute_circle_id: circleIds[0] ?? null,
      });
      // 保存后立即启动贡献节点
      const started = onStart ? await onStart() : true;
      setSavedMsg(started ? t('contribute.savedAndStarted') : t('common.saved'));
      // 启动后触发社区列表刷新（含延迟补刷，等节点重连上报）
      onAgentsRefresh?.();
      setTimeout(() => setSavedMsg(''), 2000);
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-3">
      {/* 状态头：一眼看清是否在线、对谁开放、上架了多少 */}
      <div className={`relative overflow-hidden rounded-2xl border px-5 py-4 ${
        running
          ? 'border-green-200/80 dark:border-green-900/60 bg-gradient-to-br from-green-50/90 via-white/70 to-emerald-50/60 dark:from-green-950/40 dark:via-zinc-900/40 dark:to-emerald-950/20'
          : 'border-zinc-200/70 dark:border-white/[0.07] bg-gradient-to-br from-zinc-50/90 via-white/70 to-blue-50/40 dark:from-zinc-900/60 dark:via-zinc-900/40 dark:to-blue-950/20'
      }`}>
        <div className="flex flex-wrap items-center gap-4">
          <div className={`w-11 h-11 rounded-2xl flex items-center justify-center text-lg shrink-0 ${
            running ? 'bg-green-500 text-white shadow-md shadow-green-500/30' : 'bg-white dark:bg-zinc-800 text-zinc-400 ring-1 ring-zinc-200 dark:ring-zinc-700'
          }`} aria-hidden>
            {running ? '⚡' : '⏸'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">
                {running ? t('contribute.heroOnline') : t('contribute.heroOffline')}
              </span>
              {running && <span className="relative flex w-2 h-2"><span className="absolute inline-flex w-full h-full rounded-full bg-green-400 opacity-60 animate-ping" /><span className="relative inline-flex w-2 h-2 rounded-full bg-green-500" /></span>}
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              {t('contribute.heroSummary', {
                models: selectedNames.size,
                agents: selectedAssistantIds.size,
                scope: circleScope === 'public'
                  ? t('contribute.scope.public')
                  : t('contribute.heroCircles', { n: selectedCircleIds.size }),
              })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">{savedMsg}</span>}
            {running && (
              <button
                type="button"
                onClick={() => {
                  // 停止会下线算力，二次确认避免误触
                  if (typeof window !== 'undefined' && !window.confirm(t('contribute.stopConfirm'))) return;
                  onStop?.();
                }}
                className="text-xs px-3.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/40 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
              >
                {t('contribute.stop')}
              </button>
            )}
            <button
              type="button"
              onClick={save}
              disabled={saving || (selectedNames.size === 0 && selectedAssistantIds.size === 0)}
              className="tb-press text-xs font-medium px-4 py-1.5 rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/25 hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? t('contribute.savingAndStarting') : (running ? t('contribute.saveAndApply') : t('contribute.saveAndStart'))}
            </button>
          </div>
        </div>
        {agentError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{agentError}</p>}
      </div>

      {/* ① 上架什么 */}
      <section className={`${LIB_LIST_CLS} p-5 space-y-4`}>
        <SupplySectionHead n="1" title={t('contribute.secWhat')} hint={t('contribute.secWhatHint')} />
      {/* 贡献模型：默认只展示已选；点 + 从候选里添加，避免占满整页 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200">
            <span className="w-5 h-5 rounded-md bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-300 flex items-center justify-center text-[10px]" aria-hidden>◆</span>
            {t('contribute.models')}
          </span>
          {selectedNames.size > 0 && (
            <span className="text-[11px] text-zinc-400">{t('contribute.modelsSelected', { n: selectedNames.size })}</span>
          )}
        </div>

        {availableModels.length === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.noModelsHint')}</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 items-center">
              {[...selectedNames].map((name) => {
                const m = availableModels.find((x) => x.name === name) || { name, type: 'chat' };
                const isImage = m.type === 'image';
                const typeTitle = isImage
                  ? t('contribute.modelTypeImage')
                  : m.type === 'vision'
                    ? t('contribute.modelTypeVision')
                    : t('contribute.modelTypeText');
                return (
                  // 仅 × 可移除；类型用 title，避免「对话」角标抢视觉
                  <span
                    key={name}
                    title={typeTitle}
                    className={`tb-tag pl-2.5 pr-0.5 py-1 text-xs font-mono ${
                      isImage ? 'tb-tag-purple' : 'tb-tag-blue'
                    }`}
                  >
                    <TruncTip as="span" title={name} className="max-w-[14rem]">{name}</TruncTip>
                    <button
                      type="button"
                      title={t('contribute.removeModel')}
                      aria-label={t('contribute.removeModel')}
                      onClick={() => toggleModel(name)}
                      className="ml-0.5 w-5 h-5 inline-flex items-center justify-center rounded-md text-current/55 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-colors duration-200"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setShowModelPicker((v) => !v)}
                className={`tb-tag tb-tag-muted border-dashed justify-center h-7 px-2.5 text-xs cursor-pointer ${
                  showModelPicker ? '!border-solid !bg-white/75 dark:!bg-zinc-700/80 !text-zinc-900 dark:!text-zinc-100' : ''
                }`}
                title={t('contribute.addModel')}
                aria-label={t('contribute.addModel')}
                aria-expanded={showModelPicker}
              >
                + {t('contribute.addShort')}
              </button>
            </div>
            {selectedNames.size === 0 && !showModelPicker && (
              <p className="text-[11px] text-zinc-400">{t('contribute.addModelHint')}</p>
            )}
            {showModelPicker && (
              <div className="tb-soft-card rounded-xl p-3 space-y-2 max-h-48 overflow-y-auto">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-zinc-500">{t('contribute.pickModelHint')}</p>
                  <button
                    type="button"
                    onClick={() => setShowModelPicker(false)}
                    className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                  >
                    {t('contribute.closePicker')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {availableModels
                    .filter((m) => !selectedNames.has(m.name))
                    .map((m) => {
                      const isImage = m.type === 'image';
                      return (
                        <button
                          key={m.name}
                          type="button"
                          title={isImage ? t('contribute.modelTypeImage') : t('contribute.modelTypeText')}
                          onClick={() => toggleModel(m.name)}
                          className="tb-tag tb-tag-muted px-2.5 py-1 text-xs font-mono cursor-pointer"
                        >
                          {m.name}
                        </button>
                      );
                    })}
                  {availableModels.every((m) => selectedNames.has(m.name)) && (
                    <p className="text-[11px] text-zinc-400">{t('contribute.allModelsAdded')}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 贡献智能体：默认只展示已选；点 + 添加（须已投射） */}
      <div className="space-y-2 pt-4 border-t border-zinc-100 dark:border-white/[0.06]">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-200">
            <span className="w-5 h-5 rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-300 flex items-center justify-center text-[10px]" aria-hidden>✦</span>
            {t('contribute.assistants')}
          </span>
          {selectedAssistantIds.size > 0 && (
            <span className="text-[11px] text-zinc-400">
              {t('contribute.assistantsSelected', { n: selectedAssistantIds.size })}
            </span>
          )}
        </div>
        {availableAssistants.length === 0 && availableApps.length === 0 && selectedAssistantIds.size === 0 ? (
          <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.noAssistantsHint')}</p>
        ) : null}
        {(availableAssistants.length > 0 || availableApps.length > 0 || selectedAssistantIds.size > 0) && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5 items-center">
              {[...selectedAssistantIds].map((id) => {
                const runtime = listedAppRuntime(id);
                const a = runtime ? null : availableAssistants.find((x) => x.id === id);
                const app = runtime ? availableApps.find((x) => x.id === runtime) : null;
                const label = app?.name || a?.display_name || a?.name || runtime || id;
                const reason = runtime
                  ? (app ? '' : t('contribute.appMissing'))
                  : (a ? assistantDisabledReason(a) : '');
                return (
                  // 仅操作按钮可点；避免点 chip 本体误删
                  <span
                    key={id}
                    title={reason || a?.description || undefined}
                    className="tb-tag tb-tag-amber pl-2.5 pr-0.5 py-0.5 text-xs"
                  >
                    <TruncTip as="span" title={label} className="max-w-[14rem]">{label}</TruncTip>
                    {reason && <span className="text-[10px] opacity-80">· {reason}</span>}
                    <button
                      type="button"
                      title={t('contribute.copyWebLink')}
                      aria-label={t('contribute.copyWebLink')}
                      onClick={() => copyAssistantWebLink(id)}
                      className="ml-0.5 px-1.5 h-5 inline-flex items-center justify-center rounded-md text-[10px] text-current/70 hover:text-current hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-colors duration-200"
                    >
                      {copiedAssistantId === id ? t('contribute.webLinkCopied') : t('contribute.webLink')}
                    </button>
                    <button
                      type="button"
                      title={t('contribute.removeAssistant')}
                      aria-label={t('contribute.removeAssistant')}
                      onClick={() => toggleAssistant(id)}
                      className="ml-0.5 w-5 h-5 inline-flex items-center justify-center rounded-md text-current/55 hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 cursor-pointer transition-colors duration-200"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
              <button
                type="button"
                onClick={() => setShowAssistantPicker((v) => !v)}
                className={`tb-tag tb-tag-muted border-dashed justify-center h-7 px-2.5 text-xs cursor-pointer ${
                  showAssistantPicker ? '!border-solid !bg-white/75 dark:!bg-zinc-700/80 !text-zinc-900 dark:!text-zinc-100' : ''
                }`}
                title={t('contribute.addAssistant')}
                aria-label={t('contribute.addAssistant')}
                aria-expanded={showAssistantPicker}
              >
                + {t('contribute.addShort')}
              </button>
            </div>
            {selectedAssistantIds.size === 0 && !showAssistantPicker && (
              <p className="text-[11px] text-zinc-400">{t('contribute.addAssistantHint')}</p>
            )}
            {showAssistantPicker && (
              <div className="tb-soft-card rounded-xl p-3 space-y-2 max-h-72 overflow-y-auto">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-zinc-500">
                    {assistantPickerBusy
                      ? t('contribute.pickAssistantRefreshing')
                      : t('contribute.pickAssistantHint')}
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={assistantPickerBusy}
                      onClick={() => {
                        setAssistantPickerBusy(true);
                        Promise.all([refreshAssistants(), refreshApps()]).finally(() => setAssistantPickerBusy(false));
                      }}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 disabled:opacity-40"
                    >
                      {t('contribute.refreshAssistants')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAssistantPicker(false)}
                      className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                    >
                      {t('contribute.closePicker')}
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {availableAssistants
                    .filter((a) => !selectedAssistantIds.has(a.id))
                    .map((a) => {
                      const reason = assistantDisabledReason(a);
                      const label = a.display_name || a.name;
                      if (reason) {
                        return (
                          <span
                            key={a.id}
                            title={reason}
                            className="tb-tag tb-tag-muted px-2.5 py-1 text-xs opacity-55 cursor-not-allowed"
                          >
                            {label}
                            <span className="ml-1 text-[10px] opacity-80">· {reason}</span>
                          </span>
                        );
                      }
                      return (
                        <button
                          key={a.id}
                          type="button"
                          title={a.description || a.name}
                          onClick={() => toggleAssistant(a.id)}
                          className="tb-tag tb-tag-muted px-2.5 py-1 text-xs cursor-pointer"
                        >
                          {label}
                        </button>
                      );
                    })}
                  {availableAssistants.filter((a) => !selectedAssistantIds.has(a.id) && !assistantDisabledReason(a)).length === 0 && (
                    <p className="text-[11px] text-zinc-400 w-full">{t('contribute.noAddableAssistants')}</p>
                  )}
                </div>
                <div className="pt-2 border-t border-zinc-100 dark:border-white/[0.06] space-y-1.5">
                  <p className="text-[11px] text-zinc-500">{t('contribute.localAppsHint')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {availableApps
                      .filter((a) => !selectedAssistantIds.has(`app:${a.id}`))
                      .map((a) => (
                        <button
                          key={a.id}
                          type="button"
                          title={a.name}
                          onClick={() => toggleAssistant(`app:${a.id}`)}
                          className="tb-tag tb-tag-muted px-2.5 py-1 text-xs cursor-pointer"
                        >
                          {a.name}
                        </button>
                      ))}
                    {availableApps.filter((a) => !selectedAssistantIds.has(`app:${a.id}`)).length === 0 && (
                      <p className="text-[11px] text-zinc-400 w-full">{t('contribute.noLocalApps')}</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      </section>

      {/* ② 给谁用：圈子即交易范围 */}
      <section className={`${LIB_LIST_CLS} p-5 space-y-3`}>
        <SupplySectionHead n="2" title={t('contribute.secWho')} hint={t('contribute.secWhoHint')} />
        <div role="radiogroup" aria-label={t('contribute.scope')} className="grid gap-2.5 sm:grid-cols-2">
          {[
            ['public', '🌐', t('contribute.scopePublicTitle'), t('contribute.scopePublicDesc')],
            ['circle', '◎', t('contribute.scopeCircleTitle'), t('contribute.scopeCircleDesc')],
          ].map(([v, icon, title, desc]) => {
            const on = circleScope === v;
            return (
              <button key={v} type="button" role="radio" aria-checked={on} onClick={() => setCircleScope(v)}
                className={`relative text-left flex gap-3 p-3.5 rounded-xl border transition-all ${
                  on
                    ? 'border-blue-500 bg-blue-50/70 dark:bg-blue-950/30 ring-2 ring-blue-500/15'
                    : 'border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 hover:border-zinc-300 dark:hover:border-zinc-600'
                }`}>
                <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0 ${
                  on ? 'bg-blue-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
                }`} aria-hidden>{icon}</span>
                <span className="min-w-0">
                  <span className={`block text-[13px] font-medium ${on ? 'text-blue-700 dark:text-blue-300' : 'text-zinc-800 dark:text-zinc-100'}`}>{title}</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">{desc}</span>
                </span>
                <span className={`absolute top-3 right-3 w-4 h-4 rounded-full border-2 ${
                  on ? 'border-blue-600 bg-blue-600 shadow-[inset_0_0_0_2px_white] dark:shadow-[inset_0_0_0_2px_rgb(24,24,27)]' : 'border-zinc-300 dark:border-zinc-600'
                }`} aria-hidden />
              </button>
            );
          })}
        </div>

        {circleScope === 'circle' && (
          <div className="rounded-xl bg-zinc-50/80 dark:bg-zinc-900/40 px-3.5 py-3 space-y-2">
            {circles.length === 0
              ? (
                <p className="text-xs text-zinc-500">
                  {t('contribute.noCircle')}
                  {onManageCircles && (
                    <button type="button" onClick={onManageCircles} className="ml-1.5 text-blue-600 dark:text-blue-400 hover:underline">
                      {t('contribute.createCircleLink')}
                    </button>
                  )}
                </p>
              )
              : (
                <div className="flex flex-wrap items-center gap-1.5">
                  {circles.map(c => {
                    const sel = selectedCircleIds.has(c.id);
                    return (
                      <button key={c.id} type="button" onClick={() => toggleCircle(c.id)} aria-pressed={sel}
                        className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                          sel
                            ? 'border-blue-500 bg-blue-600 text-white'
                            : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 hover:border-zinc-300'
                        }`}>
                        <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-semibold ${sel ? 'bg-white/25' : `${avatarColor(c.name)} text-white`}`} aria-hidden>
                          {sel ? '✓' : (c.name || '?')[0]}
                        </span>
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              )}
            <p className="text-[11px] text-zinc-400">{t('contribute.scopeHint')}</p>
          </div>
        )}
      </section>

      {/* ③ 节点设置 */}
      <section className={`${LIB_LIST_CLS} p-5 space-y-3`}>
        <SupplySectionHead n="3" title={t('contribute.secNode')} />
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">{t('contribute.nodeName')}</label>
            <input value={nodeName} onChange={e => setNodeName(e.target.value)} placeholder={t('contribute.nodeNamePh')}
              className="tb-soft-field w-full text-xs px-3 py-2 rounded-lg text-zinc-900 dark:text-zinc-100" />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1.5">{t('contribute.forwardUrl')}</label>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-50 dark:bg-zinc-900/50 border border-zinc-100 dark:border-white/[0.06]">
              <TruncTip as="span" title={localGw} className="flex-1 min-w-0 text-xs font-mono text-zinc-600 dark:text-zinc-300">{localGw}</TruncTip>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 pt-1">
          <div>
            <p className="text-xs text-zinc-700 dark:text-zinc-200">{t('contribute.autoStart')}</p>
            <p className="text-[11px] text-zinc-400 mt-0.5">{t('contribute.autoStartHint')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoStart}
            aria-label={t('contribute.autoStart')}
            onClick={() => setAutoStart((v) => !v)}
            className={`relative shrink-0 w-9 h-5 rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
              autoStart ? 'bg-blue-600' : 'bg-zinc-300 dark:bg-zinc-600'
            }`}
          >
            <span className={`absolute top-[2px] left-0 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${
              autoStart ? 'translate-x-[18px]' : 'translate-x-[2px]'
            }`} />
          </button>
        </div>
      </section>
    </div>
  );
}

/** 结算时间：今天 / 昨天 / 月-日 + 时:分 */
function settlementWhen(iso, t) {
  const full = formatSettlementTime(iso);
  const m = full.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/);
  if (!m) return { day: full, time: '' };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / 86400000);
  const day = diff === 0 ? t('contribute.today') : diff === 1 ? t('contribute.yesterday') : `${m[2]}-${m[3]}`;
  return { day, time: m[4] };
}

/** 收益记录：概览 + 每次结算积分柱图 + 结算明细 + 运行日志 */
function EarningsView({ settlements, summary, stats, logs, logRef }) {
  const { t } = useLang();
  const [hover, setHover] = useState(null);
  const rows = settlements || [];
  const chron = [...rows].reverse(); // 左旧右新
  const total = rows.reduce((n, r) => n + (Number(r.credits_awarded) || 0), 0);
  const avgMult = rows.length ? rows.reduce((n, r) => n + (Number(r.multiplier) || 1), 0) / rows.length : null;
  const last = rows[0];
  const max = Math.max(1, ...chron.map(r => Number(r.credits_awarded) || 0));
  const lastWhen = last ? settlementWhen(last.period_end, t) : null;

  // 累计收益（原交易页头部数据带）作为收益页的首行
  const tiles = [
    {
      k: 'credits', label: t('contribute.earnedCredits'), tone: 'text-green-600 dark:text-green-400',
      value: summary ? `+${(summary.contrib_credits ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}` : '—',
      sub: summary ? t('contribute.approxCny', { amount: fmtCreditCny(summary.contrib_cny) }) : '',
    },
    {
      k: 'tokens', label: t('contribute.totalTokens'),
      value: summary ? fmtContribTokens(summary.contrib_tokens) : '—',
      sub: summary?.period_tokens > 0 ? t('contribute.periodTokens', { n: fmtContribTokens(summary.period_tokens) }) : t('contribute.totalTokensHint'),
    },
    {
      k: 'saved', label: t('contribute.savedMoney'), tone: 'text-emerald-600 dark:text-emerald-400',
      value: summary ? fmtCreditCny(summary.saved_cny) : '—',
      sub: summary?.p2p_tokens > 0 ? t('contribute.p2pTokensUsed', { n: fmtContribTokens(summary.p2p_tokens) }) : t('contribute.savedHint'),
    },
    {
      k: 'rate', label: t('contribute.rate'), unit: 'req/min',
      value: stats ? `${stats.contribute_req_per_min ?? 0}` : '—',
      sub: stats ? t('contribute.liveSub', { active: stats.active_requests ?? 0, nodes: stats.active_workers ?? 0 }) : '',
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        {tiles.map(m => (
          <div key={m.k} className={`${LIB_LIST_CLS} px-4 py-3`}>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{m.label}</div>
            <div className={`mt-1 text-lg font-semibold tabular-nums tracking-tight ${m.tone || 'text-zinc-900 dark:text-zinc-50'}`}>
              {m.value}{m.unit && <span className="ml-1 text-[11px] font-normal text-zinc-400">{m.unit}</span>}
            </div>
            <div className="text-[11px] truncate mt-0.5 text-zinc-400">{m.sub || ' '}</div>
          </div>
        ))}
      </div>

      {/* 每次结算积分：单序列柱图（无需图例），悬停看明细 */}
      <section className="rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-white/55 dark:bg-zinc-900/40 px-4 pt-3.5 pb-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-5">
          <h3 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{t('contribute.earnChartTitle')}</h3>
          {rows.length > 0 && (
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex flex-wrap items-baseline gap-x-2">
              <span>{t('contribute.earnRecent', { n: rows.length })} <b className="font-semibold tabular-nums text-green-600 dark:text-green-400">+{total.toFixed(1)}</b></span>
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span>{t('contribute.earnLast')} <b className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">+{(Number(last.credits_awarded) || 0).toFixed(1)}</b>{lastWhen ? ` · ${lastWhen.day} ${lastWhen.time}` : ''}</span>
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span>{t('contribute.earnQuality')} <b className="font-semibold tabular-nums text-zinc-700 dark:text-zinc-200">{avgMult.toFixed(2)}×</b> <span className="text-yellow-600 dark:text-yellow-400">{multiplierToStars(avgMult)}</span></span>
            </span>
          )}
          <span className="ml-auto text-[11px] text-zinc-400">{t('contribute.earnChartHint')}</span>
        </div>
        {chron.length === 0 ? (
          <div className="h-32 flex items-center justify-center text-xs text-zinc-400">{t('contribute.noSettlements')}</div>
        ) : (
          <div className="relative">
            <div className="absolute inset-x-0 top-0 border-t border-dashed border-zinc-200/80 dark:border-white/[0.06]" aria-hidden />
            <div className="absolute left-0 -top-2 text-[10px] text-zinc-400 tabular-nums bg-white/0">{max.toFixed(0)}</div>
            <div className="h-32 flex items-end gap-[2px] border-b border-zinc-200 dark:border-zinc-700" role="img" aria-label={t('contribute.earnChartTitle')}>
              {chron.map((r, i) => {
                const v = Number(r.credits_awarded) || 0;
                const on = hover === i;
                return (
                  <div key={r.id ?? r.period_end} className="relative flex-1 h-full flex items-end justify-center"
                    onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                    <div className={`w-full max-w-[28px] rounded-t-[4px] transition-colors ${on ? 'bg-green-600 dark:bg-green-400' : 'bg-green-500/80 dark:bg-green-500/70'}`}
                      style={{ height: `${Math.max(2, (v / max) * 100)}%` }} />
                    {on && (
                      <div className="absolute bottom-full mb-1.5 left-1/2 -translate-x-1/2 z-10 whitespace-nowrap rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg px-2.5 py-1.5 text-[11px] pointer-events-none">
                        <div className="text-zinc-500">{formatSettlementTime(r.period_end)}</div>
                        <div className="font-semibold text-zinc-900 dark:text-zinc-50 tabular-nums">+{v.toFixed(1)} {t('contribute.creditsUnit')}</div>
                        <div className="text-zinc-500 tabular-nums">{fmtContribTokens(r.output_tokens ?? 0)} tok · {(Number(r.multiplier) || 1).toFixed(2)}×</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-1 text-[10px] text-zinc-400 tabular-nums">
              <span>{formatSettlementTime(chron[0].period_end).slice(5)}</span>
              <span>{formatSettlementTime(chron[chron.length - 1].period_end).slice(5)}</span>
            </div>
          </div>
        )}
      </section>

      <section>
        <LibrarySectionHead title={t('contribute.settlements')} count={rows.length || null} />
        {rows.length === 0 ? (
          <div className={`${LIB_LIST_CLS} px-6 py-10 text-center`}>
            <div className="text-2xl" aria-hidden>🪙</div>
            <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t('contribute.noSettlementsHint')}</p>
          </div>
        ) : (
          <ul className={LIB_LIST_CLS}>
            {rows.map(st => {
              const resources = normalizeSettlementResources(st.resources);
              const mult = Number(st.multiplier) || 1;
              const w = settlementWhen(st.period_end, t);
              const qualityLabel = t('contribute.qualityMult', { n: mult.toFixed(2) });
              return (
                <li key={st.id ?? st.period_end}
                  className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 border-b last:border-b-0 border-zinc-100/90 dark:border-white/[0.05] hover:bg-zinc-50/70 dark:hover:bg-white/[0.02]">
                  <div className="leading-tight">
                    <div className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{w.day}</div>
                    <div className="text-[11px] text-zinc-400 tabular-nums">{w.time}</div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                      <span className="tabular-nums text-zinc-700 dark:text-zinc-300">{fmtContribTokens(st.output_tokens ?? 0)} tok</span>
                      <span className="text-yellow-600 dark:text-yellow-400" title={qualityLabel} aria-label={qualityLabel}>{multiplierToStars(mult)}</span>
                      <span className="tabular-nums">{mult.toFixed(2)}×</span>
                    </div>
                    {resources.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {resources.map(r => {
                          const isAgent = String(r).startsWith('agent:');
                          return (
                            <span key={r} className={`text-[10px] px-1.5 py-px rounded ${isAgent
                              ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
                              : 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-300 font-mono'}`}>
                              {isAgent ? '✦ ' : ''}{formatSettlementResource(r)}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="text-right leading-tight">
                    <div className="text-[13px] font-semibold tabular-nums text-green-600 dark:text-green-400">+{(Number(st.credits_awarded) || 0).toFixed(1)}</div>
                    <div className="text-[11px] tabular-nums text-zinc-400">≈{fmtCreditCny(creditsToCny(st.credits_awarded))}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 运行日志：排障用，默认收起 */}
      <details className="group">
        <summary className="cursor-pointer select-none text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 list-none">
          <span className="inline-block transition-transform group-open:rotate-90 mr-1">›</span>
          {t('contribute.agentLog')}
          {logs.length > 0 && <span className="ml-1.5 text-zinc-400 tabular-nums">{logs.length}</span>}
        </summary>
        <div ref={logRef} className="mt-2 bg-zinc-950 border border-zinc-800 rounded-xl p-3 h-44 overflow-y-auto font-mono text-[11px] text-zinc-300 space-y-0.5">
          {logs.length === 0 ? <span className="text-zinc-500">{t('contribute.logEmpty')}</span> : logs.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </details>
    </div>
  );
}

/** 上架表单分节标题：序号 + 标题 + 说明 */
function SupplySectionHead({ n, title, hint }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-px w-5 h-5 rounded-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[10px] font-semibold flex items-center justify-center shrink-0">{n}</span>
      <div className="min-w-0">
        <h3 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">{title}</h3>
        {hint && <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}

/** 拆分智能体名与所有者（去掉「昵称的」前缀；展示为 owner/name 以区分同名） */
function parseCommunityAgent(a) {
  let owner = String(a?.owner_nickname || '').trim();
  const raw = String(a?.display_name || a?.name || '').trim();
  let name = raw;
  if (owner) {
    const prefix = `${owner}的`;
    if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  } else {
    const m = raw.match(/^(.+?)的(.+)$/);
    if (m && m[2]) {
      owner = m[1].trim();
      name = m[2].trim();
    }
  }
  name = name || String(a?.name || '').trim() || a?.id || '智能体';
  return { name, owner };
}

/** @deprecated 兼容旧调用：仅返回智能体名 */
function communityAgentTitle(a) {
  return parseCommunityAgent(a).name;
}

/** app:claude-code / community:app:claude-code@用户 → claude-code；自定义智能体返回空 */
function rentedAppRuntime(agent) {
  const id = String(agent?.id || agent?.assistantId || '');
  const m = id.match(/(?:^|:)app:([A-Za-z0-9._-]+)/);
  return m ? m[1].split('@')[0] : '';
}

/** 社区智能体卡片左侧图标。默认出租的应用用它自己的图标，其余仍是首字。 */
function CommunityAgentIcon({ agent, name, selected, small = false }) {
  const rt = rentedAppRuntime(agent);
  if (rt && resolveBrandIcon(rt)) {
    return (
      <ServiceIcon
        id={rt}
        name={name || rt}
        boxClass={small ? 'w-9 h-9' : 'w-11 h-11'}
        imgClass={small ? 'w-5 h-5' : 'w-6 h-6'}
        className={`!rounded-xl ring-1 ring-black/5 dark:ring-white/10 ${selected ? 'ring-2 ring-amber-400 dark:ring-amber-500' : ''}`}
      />
    );
  }
  const label = String(name || '?').trim() || '?';
  const initial = label[0].toUpperCase();
  return (
    <div
      className={`relative ${small ? 'w-9 h-9 rounded-xl text-sm' : 'w-11 h-11 rounded-2xl text-base'} shrink-0 flex items-center justify-center text-white font-semibold shadow-sm ring-1 ring-black/5 dark:ring-white/10 ${avatarColor(label)} ${
        selected ? 'ring-2 ring-amber-400 dark:ring-amber-500' : ''
      }`}
      aria-hidden
    >
      {/* 右下角小符号，区分「智能体」而非用户头像 */}
      <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-md bg-white dark:bg-zinc-900 flex items-center justify-center shadow-sm">
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5 text-zinc-600 dark:text-zinc-300" fill="currentColor">
          <path d="M8 1.5a1 1 0 0 1 1 1V4h1.5a2 2 0 0 1 2 2v1H14a1 1 0 1 1 0 2h-1.5v1a2 2 0 0 1-2 2H9v1.5a1 1 0 1 1-2 0V12H5.5a2 2 0 0 1-2-2v-1H2a1 1 0 1 1 0-2h1.5V6a2 2 0 0 1 2-2H7V2.5a1 1 0 0 1 1-1zM5.5 6v4h5V6h-5z" />
        </svg>
      </span>
      {initial}
    </div>
  );
}

/** 社区智能体：浏览在线名片 → 雇佣/取消雇佣（供游乐场与 MCP；此处不发起任务） */
function CommunityAgentsCard({ refreshKey = 0, circles = [], scope = 'all', onScopeChange, focusAgent = null }) {
  const { t } = useLang();
  const location = useLocation();
  const [agents, setAgents] = useState([]);
  const [hiredIds, setHiredIds] = useState(new Set());
  const [credits, setCredits] = useState(null);
  const [selected, setSelected] = useState(null); // { id, worker_id, display_name, runtime, description }
  const [hireMsg, setHireMsg] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(''); // '' | 'hire' | 'unhire'
  const [query, setQuery] = useState('');
  const [onlyHired, setOnlyHired] = useState(false);
  const [sortBy, setSortBy] = useState('popular');
  // 行内「雇佣」：先选中再在下一帧执行（hireSelected 读取 selected）
  const [pendingHire, setPendingHire] = useState(null);
  // 本机设备号。和名片上的 device_id 相同就是自己这台，不能雇。
  const [myDeviceId, setMyDeviceId] = useState('');
  // KeepAlive 下用 pathname 判断是否在交易页（再次进入需立刻刷新）
  const pageActive = location.pathname === '/contribute';
  const refreshRef = useRef(null);

  useEffect(() => {
    try {
      const id = window.electronAPI?.app?.getDeviceId?.();
      if (id) setMyDeviceId(String(id));
    } catch { /* 浏览器里没有设备号 */ }
  }, []);

  function isSelfMachine(a) {
    const mine = String(myDeviceId || '');
    const dev = String(a?.device_id || '');
    return !!(mine && dev && mine === dev);
  }

  function refreshHired() {
    if (!window.electronAPI?.agent?.listHiredCommunity) return;
    window.electronAPI.agent.listHiredCommunity()
      .then((r) => {
        const ids = new Set((r?.hired || []).map((h) => h.assistant_id));
        setHiredIds(ids);
      })
      .catch(() => {});
  }

  /** @param {{ quiet?: boolean }} [opts] quiet=true 时不闪 skeleton（定时/事件刷新） */
  async function refresh(opts = {}) {
    const quiet = !!opts.quiet;
    if (!quiet) setLoading(true);
    try {
      let list = [];
      try {
        const r = await listCommunityAgents();
        list = r.data?.agents || [];
        if (r.data?.credits_per_task != null) setCredits(r.data.credits_per_task);
      } catch {
        list = [];
      }
      // 登录接口只含此刻在线的名片。库里还有上架时补上，避免市场空白。
      try {
        const pub = await listPublicCommunityAgents();
        const seen = new Set(list.map((a) => a && a.id).filter(Boolean));
        for (const a of pub.data?.agents || []) {
          if (!a?.id || seen.has(a.id)) continue;
          seen.add(a.id);
          list.push(a);
        }
      } catch { /* 公开列表失败时保留已拿到的在线名片 */ }
      setAgents(list);
    } finally {
      if (!quiet) setLoading(false);
    }
    refreshHired();
  }
  refreshRef.current = refresh;

  // 进入交易页立即刷新（无定时轮询）
  useEffect(() => {
    if (!pageActive) return;
    refresh({ quiet: agents.length > 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随页面可见性触发
  }, [pageActive]);

  // 保存/停止：立刻刷一次，再于 0.8s、2s 补刷（等节点重连上报名片）
  useEffect(() => {
    if (!refreshKey) return undefined;
    let cancelled = false;
    (async () => {
      await refreshRef.current?.({ quiet: true });
      await new Promise((r) => setTimeout(r, 800));
      if (cancelled) return;
      await refreshRef.current?.({ quiet: true });
      await new Promise((r) => setTimeout(r, 1200));
      if (cancelled) return;
      await refreshRef.current?.({ quiet: true });
    })();
    return () => { cancelled = true; };
  }, [refreshKey]);

  async function hireSelected() {
    if (!selected || busy) return;
    if (isSelfMachine(selectedRow || selected)) {
      setErr(t('contribute.hireSelf'));
      return;
    }
    setErr('');
    setHireMsg('');
    setBusy('hire');
    try {
      if (!window.electronAPI?.agent?.hireCommunity) {
        throw new Error('请在桌面客户端中雇佣');
      }
      const r = await window.electronAPI.agent.hireCommunity({
        assistant_id: selected.id,
        owner_nickname: selected.owner_nickname,
        display_name: selected.display_name,
        runtime: selected.runtime,
        description: selected.description,
      });
      if (!r?.success) throw new Error(r?.error || 'hire failed');
      setHireMsg(t('contribute.hiredOk', { name: selected.display_name || selected.id, id: r.hired?.id }));
      refreshHired();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  }

  async function unhireSelected() {
    if (!selected || busy) return;
    setErr('');
    setHireMsg('');
    setBusy('unhire');
    try {
      if (!window.electronAPI?.agent?.unhireCommunity) {
        throw new Error('请在桌面客户端中操作');
      }
      const r = await window.electronAPI.agent.unhireCommunity(selected.id);
      if (!r?.success) throw new Error(r?.error || 'unhire failed');
      setHireMsg(t('contribute.unhiredOk', { name: selected.display_name || selected.id }));
      refreshHired();
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy('');
    }
  }

  const selectedHired = selected && hiredIds.has(selected.id);

  // 从圈子详情 / 社区网络跳来：定位并展开该智能体
  useEffect(() => {
    if (focusAgent?.query) setQuery(focusAgent.query);
  }, [focusAgent]);

  useEffect(() => {
    if (!focusAgent?.id || !agents.length) return;
    const a = agents.find(x => x.id === focusAgent.id);
    if (!a) return;
    // 目标不在当前范围内时回到「全部」，避免选中了却看不到
    if (!inScope(a)) onScopeChange?.('all');
    selectAgent(a, { toggle: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅随跳转目标 / 列表就绪触发
  }, [focusAgent, agents]);

  useEffect(() => {
    if (!pendingHire || !selected || selected.id !== pendingHire.id) return;
    setPendingHire(null);
    hireSelected();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在选中目标就绪时触发一次
  }, [pendingHire, selected]);
  const hireBannerRef = useRef(null);

  // 雇佣结果横幅：数秒后自动收起
  useEffect(() => {
    if (!hireMsg) return undefined;
    hireBannerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    const id = setTimeout(() => setHireMsg(''), 5000);
    return () => clearTimeout(id);
  }, [hireMsg]);

  function selectAgent(a, { toggle = true } = {}) {
    const { name: title, owner } = parseCommunityAgent(a);
    const same = selected && selected.id === a.id && selected.worker_id === a.worker_id;
    setSelected(same && toggle ? null : {
      id: a.id,
      worker_id: a.worker_id,
      display_name: title,
      runtime: a.runtime,
      description: a.description,
      owner_nickname: owner || a.owner_nickname,
    });
  }

  const circleName = (cid) => circles.find(c => c.id === cid)?.name || '';
  const inScope = (a) => {
    if (scope === 'all') return true;
    const isCircle = (a.visibility || 'public') !== 'public';
    if (scope === 'public') return !isCircle;
    // 旧服务端未返回 circle_ids 时，圈内项一律归入任意圈子
    if (!Array.isArray(a.circle_ids)) return isCircle;
    return a.circle_ids.includes(scope);
  };
  const q = query.trim().toLowerCase();
  const scoped = agents.filter(inScope);
  const filtered = scoped.filter((a) => {
    if (onlyHired && !hiredIds.has(a.id)) return false;
    if (!q) return true;
    const { name, owner } = parseCommunityAgent(a);
    return [name, owner, a.runtime, a.description].some(v => String(v || '').toLowerCase().includes(q));
  });
  const shown = sortBy === 'name'
    ? [...filtered].sort((x, y) => parseCommunityAgent(x).name.localeCompare(parseCommunityAgent(y).name))
    : [...filtered].sort((x, y) => (Number(y.hire_count) || 0) - (Number(x.hire_count) || 0));
  const selectedFull = selected
    ? (selected.owner_nickname ? `${selected.owner_nickname}/${selected.display_name || selected.id}` : (selected.display_name || selected.id))
    : '';
  const selectedRow = selected ? agents.find(a => a.id === selected.id && a.worker_id === selected.worker_id) : null;
  const hiredCount = agents.filter(a => hiredIds.has(a.id)).length;
  const onlineAgents = agents.filter(a => a.online !== false);
  const idleCount = onlineAgents.filter(a => !(Number(a.active_requests) > 0)).length;

  const scopeOptions = [
    { id: 'all', label: t('contribute.scope.all') },
    { id: 'public', label: t('contribute.scope.public') },
    ...circles.map(c => ({ id: c.id, label: c.name, circle: true })),
  ];
  const countIn = (id) => agents.filter(a => {
    if (id === 'all') return true;
    const isCircle = (a.visibility || 'public') !== 'public';
    if (id === 'public') return !isCircle;
    return Array.isArray(a.circle_ids) ? a.circle_ids.includes(id) : isCircle;
  }).length;

  const chip = (on) => `inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${
    on
      ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
      : 'border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/30 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800'
  }`;

  return (
    <div className="space-y-3">
      {/* 市场头：在线概况 + 搜索 */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-gradient-to-br from-violet-50/80 via-white/70 to-blue-50/60 dark:from-violet-950/30 dark:via-zinc-900/40 dark:to-blue-950/20 px-5 py-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-violet-500 to-blue-500 text-white flex items-center justify-center text-lg shadow-md shadow-violet-500/25 shrink-0" aria-hidden>✦</div>
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold text-zinc-900 dark:text-zinc-50">{t('contribute.marketTitle')}</div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 flex flex-wrap items-center gap-x-2">
              <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-green-500" aria-hidden />{t('contribute.marketOnline', { n: onlineAgents.length, idle: idleCount })}</span>
              <span className="text-zinc-300 dark:text-zinc-600">·</span>
              <span>{t('contribute.marketHired', { n: hiredCount })}</span>
              {credits != null && (<><span className="text-zinc-300 dark:text-zinc-600">·</span><span>{t('contribute.agentTaskCost', { n: credits })}</span></>)}
            </p>
          </div>
          <div className="relative w-72 max-w-full">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none" aria-hidden>
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" className="w-3.5 h-3.5"><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5 17 17" strokeLinecap="round" /></svg>
            </span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('contribute.searchAgents')}
              className="w-full text-xs pl-8 pr-3 py-2 rounded-xl bg-white/90 dark:bg-zinc-900/70 border border-zinc-200/80 dark:border-zinc-700 text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15"
            />
          </div>
        </div>
      </div>

      {/* 筛选：范围（圈子即交易范围）· 已雇佣 · 排序 */}
      <div className="flex flex-wrap items-center gap-1.5">
        {(circles.length > 0 ? scopeOptions : scopeOptions.slice(0, 1)).map(o => (
          <button key={o.id} type="button" role="radio" aria-checked={scope === o.id && !onlyHired}
            onClick={() => { setOnlyHired(false); onScopeChange?.(o.id); }}
            className={chip(scope === o.id && !onlyHired)}>
            {o.circle && <span className="opacity-60" aria-hidden>◎</span>}
            {o.label}
            <span className="tabular-nums opacity-60">{countIn(o.id)}</span>
          </button>
        ))}
        <span className="mx-1 w-px h-4 bg-zinc-200 dark:bg-zinc-700" aria-hidden />
        <button type="button" aria-pressed={onlyHired} onClick={() => setOnlyHired(v => !v)} className={chip(onlyHired)}>
          <span aria-hidden>✓</span>{t('contribute.filterHired')}<span className="tabular-nums opacity-60">{hiredCount}</span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <FilterMenu
            label={t('contribute.sortLabel')}
            value={sortBy}
            onChange={v => setSortBy(v || 'popular')}
            clearable={false}
            neutral
            align="right"
            options={[
              { value: 'popular', label: t('contribute.sortPopular') },
              { value: 'name', label: t('contribute.sortName') },
            ]}
          />
          <button type="button" onClick={() => refresh()} disabled={loading} title={t('contribute.refreshAgents')} aria-label={t('contribute.refreshAgents')}
            className="w-7 h-7 rounded-lg text-sm text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-white/70 dark:hover:bg-zinc-800 disabled:opacity-40">
            <span className={`inline-block ${loading ? 'animate-spin' : ''}`} aria-hidden>↻</span>
          </button>
        </div>
      </div>

      {hireMsg && (
        <div ref={hireBannerRef} role="status"
          className="flex items-start gap-2 rounded-xl border border-green-200 dark:border-green-800/60 bg-green-50 dark:bg-green-950/40 px-3 py-2">
          <span className="text-green-600" aria-hidden>✓</span>
          <p className="flex-1 text-xs text-green-800 dark:text-green-300 leading-snug">{hireMsg}</p>
          <button type="button" onClick={() => setHireMsg('')}
            className="shrink-0 text-xs text-green-700/70 dark:text-green-400/70 hover:text-green-900 dark:hover:text-green-200"
            aria-label={t('contribute.hireFeedbackDismiss')}>×</button>
        </div>
      )}
      {err && <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap" role="alert">{err}</p>}

      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          {loading ? (
            <div className={`${LIB_LIST_CLS} divide-y divide-zinc-100/90 dark:divide-white/[0.05]`} aria-busy="true" aria-label={t('contribute.agentsLoading')}>
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3 animate-pulse">
                  <div className="w-9 h-9 rounded-xl bg-zinc-200/80 dark:bg-zinc-700/80" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3 w-40 rounded bg-zinc-200/80 dark:bg-zinc-700/80" />
                    <div className="h-2.5 w-72 rounded bg-zinc-200/60 dark:bg-zinc-700/60" />
                  </div>
                </div>
              ))}
            </div>
          ) : shown.length === 0 ? (
            <div className={`${LIB_LIST_CLS} px-6 py-12 text-center`}>
              <div className="text-2xl" aria-hidden>{q || onlyHired ? '🔍' : '🌙'}</div>
              <p className="mt-2 text-[13px] font-medium text-zinc-700 dark:text-zinc-200">
                {q ? t('contribute.noAgentsMatch') : onlyHired ? t('contribute.noHiredYet') : t('contribute.noCommunityAgents')}
              </p>
              {(q || onlyHired || scope !== 'all') && (
                <button type="button" onClick={() => { setQuery(''); setOnlyHired(false); onScopeChange?.('all'); }}
                  className="mt-3 text-xs text-blue-600 dark:text-blue-400 hover:underline">{t('contribute.clearFilters')}</button>
              )}
            </div>
          ) : (
            <ul className={LIB_LIST_CLS} role="listbox" aria-label={t('contribute.communityAgents')}>
              <li className="hidden md:grid grid-cols-[minmax(0,1fr)_8rem_6.5rem_4.5rem_4rem] gap-3 px-4 py-2 text-[11px] text-zinc-400 border-b border-zinc-100/90 dark:border-white/[0.05]">
                <span>{t('contribute.col.agent')}</span>
                <span>{t('contribute.col.runtime')}</span>
                <span>{t('contribute.col.popularity')}</span>
                <span>{t('contribute.col.status')}</span>
                <span />
              </li>
              {shown.map((a) => {
                const key = `${a.worker_id}:${a.id}`;
                const sel = !!selected && selected.id === a.id && selected.worker_id === a.worker_id;
                const hired = hiredIds.has(a.id);
                const offline = a.online === false;
                const self = isSelfMachine(a);
                const busyNow = Number(a.active_requests) > 0;
                const hires = Number(a.hire_count) || 0;
                const { name: title, owner } = parseCommunityAgent(a);
                const blurb = String(a.description || '').trim();
                return (
                  <li
                    key={key}
                    role="option"
                    aria-selected={sel}
                    tabIndex={0}
                    onClick={() => selectAgent(a)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectAgent(a); } }}
                    className={`${libRowCls(sel)} grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_8rem_6.5rem_4.5rem_4rem]`}
                  >
                    <LibraryRowTitle
                      logo={<CommunityAgentIcon agent={a} name={title} small />}
                      name={owner ? (
                        <>
                          <span className="text-zinc-400 dark:text-zinc-500 font-normal">{owner}</span>
                          <span className="text-zinc-300 dark:text-zinc-600 mx-0.5">/</span>
                          {title}
                        </>
                      ) : title}
                      chips={(
                        <>
                          {(a.visibility || 'public') !== 'public' && (
                            <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300">
                              ◎ {(a.circle_ids || []).map(circleName).filter(Boolean)[0] || t('contribute.scope.circleTag')}
                              {(a.circle_ids || []).length > 1 ? ` +${a.circle_ids.length - 1}` : ''}
                            </span>
                          )}
                          {hired && (
                            <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300">
                              ✓ {t('contribute.hiredBadge')}
                            </span>
                          )}
                        </>
                      )}
                      sub={blurb || t('contribute.noAgentDesc')}
                      subClass={blurb ? undefined : 'text-zinc-400 dark:text-zinc-500 italic'}
                    />
                    <div className="hidden md:flex items-center gap-1.5 min-w-0 text-[11px] text-zinc-600 dark:text-zinc-300">
                      {a.runtime ? (
                        <>
                          <ServiceIcon id={a.runtime} name={a.runtime} boxClass="w-5 h-5" imgClass="w-3 h-3" className="!rounded-md shrink-0" />
                          <span className="truncate">{runtimeLabel(a.runtime)}</span>
                        </>
                      ) : '—'}
                    </div>
                    <div className="hidden md:block text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">
                      {hires > 0
                        ? <span>🔥 {t('contribute.hiresN', { n: hires })}</span>
                        : <span className="text-[10px] px-1.5 py-px rounded bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-300">{t('contribute.newListing')}</span>}
                    </div>
                    <div className="hidden md:flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                      <span className={`w-1.5 h-1.5 rounded-full ${offline ? 'bg-zinc-300' : busyNow ? 'bg-amber-500' : 'bg-green-500'}`} aria-hidden />
                      {offline ? t('network.offline') : busyNow ? t('network.busy') : t('network.idle')}
                    </div>
                    <div className="flex justify-end md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                      {!hired && (
                        <button
                          type="button"
                          disabled={!!busy || self || offline}
                          title={self ? t('contribute.hireSelf') : undefined}
                          onClick={() => { selectAgent(a, { toggle: false }); setPendingHire(a); }}
                          className="tb-press whitespace-nowrap text-[11px] px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-45"
                        >
                          {self ? t('contribute.hireSelf') : t('contribute.hireShort')}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        {selected && (
          <LibraryInspector
            logo={<CommunityAgentIcon agent={selected} name={selected.display_name || selected.id} />}
            title={selectedFull}
            chips={(
              <>
                {selectedHired && (
                  <span className="text-[10px] px-1.5 py-px rounded font-medium bg-green-50 dark:bg-green-950/40 text-green-700 dark:text-green-300">✓ {t('contribute.hiredBadge')}</span>
                )}
                {selectedRow && (selectedRow.visibility || 'public') !== 'public' && (
                  <span className="text-[10px] px-1.5 py-px rounded font-medium bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300">
                    ◎ {(selectedRow.circle_ids || []).map(circleName).filter(Boolean).join('、') || t('contribute.scope.circleTag')}
                  </span>
                )}
              </>
            )}
            desc={String(selected.description || '').trim() || t('contribute.noAgentDesc')}
            stats={[
              [t('contribute.col.runtime'), selected.runtime ? runtimeLabel(selected.runtime) : '—'],
              [t('contribute.col.cost'), credits != null ? t('contribute.creditsN', { n: credits }) : '—'],
              [t('contribute.col.popularity'), selectedRow && Number(selectedRow.hire_count) > 0 ? t('contribute.hiresN', { n: selectedRow.hire_count }) : t('contribute.newListing')],
            ]}
            onClose={() => setSelected(null)}
            closeLabel={t('circles.inviteClose')}
            footer={(
              <>
                <button
                  type="button"
                  onClick={hireSelected}
                  disabled={!!busy || isSelfMachine(selectedRow) || selectedRow?.online === false}
                  title={isSelfMachine(selectedRow) ? t('contribute.hireSelf') : undefined}
                  className="tb-press flex-1 text-xs font-medium px-3.5 py-2 rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/25 hover:bg-blue-500 disabled:opacity-50"
                >
                  {isSelfMachine(selectedRow)
                    ? t('contribute.hireSelf')
                    : (busy === 'hire' ? t('contribute.hiring') : (selectedHired ? t('contribute.hiredAgain') : t('contribute.hireBtn')))}
                </button>
                {selectedHired && (
                  <button
                    type="button"
                    onClick={unhireSelected}
                    disabled={!!busy}
                    className="text-xs px-3.5 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50"
                  >
                    {busy === 'unhire' ? t('contribute.unhiring') : t('contribute.unhireBtn')}
                  </button>
                )}
              </>
            )}
          >
            <InspectorSection title={t('contribute.hireHowTitle')}>
              <ol className="space-y-2.5">
                {[t('contribute.step1'), t('contribute.step2'), t('contribute.step3')].map((txt, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-300 text-[10px] font-semibold flex items-center justify-center shrink-0">{i + 1}</span>
                    <span className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300 pt-0.5">{txt}</span>
                  </li>
                ))}
              </ol>
            </InspectorSection>
            <CommunityApiExample
              assistantId={selected.id}
              owner={selected.owner_nickname}
              hired={!!selectedHired}
              t={t}
            />
            <InspectorSection title={t('contribute.safetyTitle')}>
              <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">🔒 {t('contribute.hireHint')}</p>
            </InspectorSection>
          </LibraryInspector>
        )}
      </div>
    </div>
  );
}

/** 已雇佣社区智能体的调用示例。harness 用 community:<id>@<用户名>，云端自动选设备。 */
function CommunityApiExample({ assistantId, owner, hired, t }) {
  const [copied, setCopied] = useState(false);
  // 本机网关的调用钥匙，不是网关应用的 Key
  const [apiKey, setApiKey] = useState('');
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.agent?.httpKey?.()
      .then((r) => { if (!cancelled && r?.api_key) setApiKey(r.api_key); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const aid = String(assistantId || '').trim();
  if (!aid) return null;
  const who = String(owner || '').trim().replace(/@/g, '');
  const harnessId = who ? `community:${aid}@${who}` : `community:${aid}`;
  const origin = resolveLocalGatewayBase().replace(/\/v1\/?$/, '');
  const body = JSON.stringify({
    input: '请按你的职责完成这个任务',
    stream: true,
    metadata: { harness_id: harnessId },
  });
  const bearer = apiKey || '<API Key>';
  const curl = `curl ${origin}/v1/agent/responses \\\n  -H "Authorization: Bearer ${bearer}" \\\n  -H "content-type: application/json" \\\n  -d '${body.replace(/'/g, `'\\''`)}'`;
  return (
    <InspectorSection title={t('contribute.apiExampleTitle')}>
      <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400 mb-2">
        {hired ? t('contribute.apiExampleHint') : t('contribute.apiExampleNeedHire')}
      </p>
      <div className="border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
        <div className="flex items-center bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5">
          <span className="text-[10px] font-medium text-zinc-500 truncate">POST /v1/agent/responses</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => { copyText(curl); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="text-[10px] px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-600 text-zinc-500 shrink-0"
          >
            {copied ? t('gateway.common.copied') : t('gateway.common.copy')}
          </button>
        </div>
        <pre className="px-2.5 py-2 text-[10px] font-mono leading-relaxed text-zinc-700 dark:text-zinc-300 overflow-x-auto whitespace-pre-wrap break-all">{curl}</pre>
      </div>
    </InspectorSection>
  );
}

/** 已进行时长：m:ss，超过一小时再带上小时。 */
function fmtTaskElapsed(ms) {
  const sec = Math.max(0, Math.floor(Number(ms) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 上架页：本机正在为雇佣方执行的智能体任务。浏览器里没有这份列表。 */
function LiveRentals({ pageActive, onCount }) {
  const { t } = useLang();
  const [tasks, setTasks] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  const [trace, setTrace] = useState(null);
  const [traceMiss, setTraceMiss] = useState('');
  const supported = typeof window !== 'undefined' && !!window.electronAPI?.agent?.listContributeTasks;

  async function openTaskTrace(task) {
    setTraceMiss('');
    let sessionId = task.cliSessionId || '';
    let agentId = task.runtime || '';
    try {
      const found = await window.electronAPI?.agent?.resolveContributeTrace?.(task.id);
      if (found?.sessionId && found?.agentId) {
        sessionId = found.sessionId;
        agentId = found.agentId;
      }
    } catch { /* 主进程还没这条接口时，用任务上已经有的会话号 */ }
    if (!sessionId || !agentId) {
      setTraceMiss(task.id);
      return;
    }
    setTrace({ sessionId, agentId });
  }

  useEffect(() => {
    onCount?.(tasks.length);
  }, [tasks.length, onCount]);

  useEffect(() => {
    if (!supported) return undefined;
    let cancelled = false;
    window.electronAPI.agent.listContributeTasks()
      .then((r) => { if (!cancelled) setTasks(Array.isArray(r?.tasks) ? r.tasks : []); })
      .catch(() => {});
    const off = window.electronAPI.agent.onContributeTasks?.((list) => {
      if (!cancelled) setTasks(Array.isArray(list) ? list : []);
    });
    return () => { cancelled = true; off?.(); };
  }, [supported]);

  useEffect(() => {
    if (!pageActive || tasks.length === 0) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pageActive, tasks.length]);

  if (!supported) return null;

  return (
    <section className={`${LIB_LIST_CLS} p-4 space-y-2`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-200">{t('contribute.liveTasks')}</span>
        {tasks.length > 0 && (
          <span className="text-[11px] tabular-nums text-zinc-400">{tasks.length}</span>
        )}
      </div>
      <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('contribute.liveTasksHint')}</p>
      {tasks.length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('contribute.liveTasksEmpty')}</p>
      ) : (
        <ul className="space-y-1.5">
          {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  title={t('contribute.liveTaskTrace')}
                  onClick={() => openTaskTrace(task)}
                  className="w-full text-left rounded-lg border border-zinc-200/80 dark:border-white/[0.08] bg-white/60 dark:bg-zinc-900/40 px-3 py-2 cursor-pointer hover:border-zinc-300 dark:hover:border-zinc-600"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-100 truncate">{task.name || task.assistantId}</span>
                    <span className="shrink-0 text-[10px] text-green-600 dark:text-green-400">{t('contribute.liveTaskRunning')}</span>
                    <span className="ml-auto shrink-0 text-[10px] tabular-nums text-zinc-400">
                      {fmtTaskElapsed(now - Number(task.startedAt || now))}
                    </span>
                  </div>
                  {task.prompt && (
                    <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{task.prompt}</p>
                  )}
                  {traceMiss === task.id && (
                    <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{t('contribute.liveTaskTraceWait')}</p>
                  )}
                </button>
              </li>
          ))}
        </ul>
      )}
      {trace && (
        <SessionTraceModal
          app={null}
          sessionId={trace.sessionId}
          traceAgentId={trace.agentId}
          onClose={() => setTrace(null)}
        />
      )}
    </section>
  );
}

/** 运行时展示名 */
function runtimeLabel(rt) {
  const map = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', 'kimi-code': 'Kimi Code', workbuddy: 'WorkBuddy', gemini: 'Gemini CLI' };
  return map[String(rt || '').toLowerCase()] || rt;
}

export default function Contribute() {
  const { t, lang } = useLang();
  const { user } = useAuth();
  const [running,     setRunning]     = useState(false);
  const [stats,       setStats]       = useState(null);
  const [settlements, setSettlements] = useState([]);
  const [summary,     setSummary]     = useState(null);
  const [logs,        setLogs]        = useState([]);
  const [agentError,  setAgentError]  = useState('');
  const [agentsRefreshKey, setAgentsRefreshKey] = useState(0);
  const logRef = useRef(null);
  const location = useLocation();
  const pageActive = location.pathname === '/contribute';
  const [tab, setTab] = useState(() => {
    try { return localStorage.getItem('tokenbank.trade.tab') || 'hire'; } catch { return 'hire'; }
  });
  // 圈子 = 交易范围：共享给雇佣筛选、上架范围、圈子管理
  const [myCircles, setMyCircles] = useState(null);
  const [scope, setScope] = useState('all');
  const [focusAgent, setFocusAgent] = useState(null);
  const [circlesView, setCirclesView] = useState('mine');
  const [circleResult, setCircleResult] = useState(null);
  const [liveTaskCount, setLiveTaskCount] = useState(0);

  useEffect(() => {
    Promise.all([listMyCircles(), listJoinedCircles()])
      .then(([o, j]) => setMyCircles(uniqueCircles([...(o.data?.circles || []), ...(j.data?.circles || [])])))
      .catch(() => setMyCircles([]));
  }, []);

  // 跨页跳转（圈子详情 / 社区网络 / 邀请链接 / 旧 /circles 路由）带来的定位
  useEffect(() => {
    if (location.pathname !== '/contribute') return;
    const st = location.state || {};
    if (st.tradeTab) changeTab(st.tradeTab);
    if (st.scope != null) setScope(st.scope);
    if (st.focusAgent) setFocusAgent({ id: st.focusAgent, at: Date.now() });
    if (st.agentQuery) setFocusAgent({ query: st.agentQuery, at: Date.now() });
    if (st.circlesView) setCirclesView(st.circlesView);
    if (st.circleResult) setCircleResult({ ...st.circleResult, at: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 每次导航触发一次
  }, [location.key]);
  function changeTab(id) {
    setTab(id);
    try { localStorage.setItem('tokenbank.trade.tab', id); } catch { /* ignore */ }
  }

  /** 触发社区智能体列表刷新（保存/停止后） */
  function bumpAgentsRefresh() {
    setAgentsRefreshKey((k) => k + 1);
  }

  useEffect(() => {
    const unsub = subscribeAgentEvents({
      onStatus: ({ running: r, error }) => {
        setRunning(r);
        if (error) setLogs(prev => [...prev.slice(-199), `[error] ${error}`]);
      },
      onLog: (line) => setLogs(prev => [...prev.slice(-199), line.trimEnd()]),
    });
    if (unsub) {
      getAgentStatus().then(({ running: r }) => setRunning(r));
      getAgentLogs().then(lines => {
        if (lines?.length) setLogs(lines.map(l => String(l).trimEnd()));
      });
      return unsub;
    }

    // Docker / CLI：只在交易页轮询 admin-api
    if (!pageActive || !useAgentPolling()) return undefined;
    let cancelled = false;
    async function poll() {
      try {
        const st = await getAgentStatus();
        if (cancelled) return;
        setRunning(!!st.running);
        const lines = await getAgentLogs();
        if (!cancelled && lines.length) setLogs(lines.map(l => String(l).trimEnd()));
      } catch {}
    }
    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [pageActive]);

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [logs]);

  useEffect(() => {
    if (!pageActive) return undefined;
    function poll() {
      getStats().then(r => {
        setStats(r.data);
      }).catch(() => {});
    }
    poll();
    const id = setInterval(poll, 60000);
    return () => clearInterval(id);
  }, [lang, pageActive]);

  useEffect(() => {
    if (!pageActive) return undefined;
    function loadSummary() {
      getContributeSummary().then(r => setSummary(r.data)).catch(() => {});
    }
    loadSummary();
    const id = setInterval(loadSummary, 60000);
    return () => clearInterval(id);
  }, [pageActive]);

  // KeepAlive 下只挂载一次：登录就绪后拉取，并定时刷新，避免首次失败后一直「暂无」
  useEffect(() => {
    if (!pageActive || !user?.id) return undefined;
    let cancelled = false;
    function loadSettlements() {
      getSettlements()
        .then((r) => {
          if (cancelled) return;
          setSettlements((r.data?.settlements || []).slice(0, 30));
        })
        .catch((e) => {
          console.warn('[contribute] settlements load failed', e?.message || e);
        });
    }
    loadSettlements();
    const id = setInterval(loadSettlements, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pageActive, user?.id]);

  async function handleStart() {
    setAgentError('');
    try {
      await startAgent();
      const st = await getAgentStatus();
      setRunning(!!st.running);
      const lines = await getAgentLogs();
      if (lines.length) setLogs(lines.map(l => String(l).trimEnd()));
      return true;
    } catch (e) {
      setAgentError(e.message || String(e));
      return false;
    }
  }

  async function handleStop() {
    setAgentError('');
    try {
      await stopAgent();
      setRunning(false);
      // 停止后刷新社区智能体（本机名片应尽快消失）
      bumpAgentsRefresh();
    } catch (e) {
      setAgentError(e.message || String(e));
    }
  }


  const TABS = [
    { id: 'hire', label: t('contribute.tab.hire') },
    { id: 'supply', label: t('contribute.tab.supply'), count: liveTaskCount || null },
    { id: 'circles', label: t('contribute.tab.circles'), count: myCircles?.length || null },
    { id: 'earnings', label: t('contribute.tab.earnings'), count: settlements.length || null },
    { id: 'network', label: t('contribute.tab.network'), icon: '🌐' },
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      <header className="shrink-0 px-5 pt-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('contribute.title')}</h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('contribute.subtitle')}</p>
          </div>
          <div className="electron-no-drag relative z-50 flex items-center gap-2">
            {/* 累计积分：点击看收益记录（明细数据都在该页签） */}
            {summary && (
              <button type="button" onClick={() => changeTab('earnings')}
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/40 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100">
                <span className="font-semibold tabular-nums text-green-600 dark:text-green-400">+{(summary.contrib_credits ?? 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}</span>
                {t('contribute.creditsUnit')}
              </button>
            )}
            {/* 供给状态：一眼可见，点击直达上架配置 */}
            <button
              type="button"
              onClick={() => changeTab('supply')}
              className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                running
                  ? 'border-green-200 dark:border-green-900 bg-green-50/80 dark:bg-green-950/30 text-green-700 dark:text-green-300'
                  : 'border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/40 text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <span className="relative flex w-2 h-2" aria-hidden>
                {running && <span className="absolute inline-flex w-full h-full rounded-full bg-green-400 opacity-60 animate-ping" />}
                <span className={`relative inline-flex w-2 h-2 rounded-full ${running ? 'bg-green-500' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
              </span>
              {running ? t('contribute.statusSupplying') : t('contribute.statusIdle')}
            </button>
          </div>
        </div>

        <div role="tablist" className="mt-4 flex items-end gap-4 sm:gap-6 overflow-x-auto border-b border-zinc-200/80 dark:border-white/[0.08]">
          {TABS.map(tb => (
            <button key={tb.id} type="button" role="tab" aria-selected={tab === tb.id} onClick={() => changeTab(tb.id)}
              className={`-mb-px pb-2.5 text-[13px] border-b-2 whitespace-nowrap shrink-0 transition-colors ${
                tab === tb.id
                  ? 'border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-50 font-semibold'
                  : 'border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}>
              {tb.icon && <span className="mr-1" aria-hidden>{tb.icon}</span>}
              {tb.label}
              {tb.count > 0 && <span className="ml-1.5 text-[11px] font-normal text-zinc-400 tabular-nums">{tb.count}</span>}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        {/* 三个页签常驻挂载：切换不丢未保存的上架配置 */}
        <div className={tab === 'hire' ? '' : 'hidden'}>
          <CommunityAgentsCard
            refreshKey={agentsRefreshKey}
            circles={myCircles || []}
            scope={scope}
            onScopeChange={setScope}
            focusAgent={focusAgent}
          />
        </div>

        <div className={tab === 'supply' ? 'space-y-2' : 'hidden'}>
          <LiveRentals pageActive={pageActive && tab === 'supply'} onCount={setLiveTaskCount} />
          <ContributionConfigCard
            onStart={handleStart}
            onStop={handleStop}
            running={running}
            agentError={agentError}
            onAgentsRefresh={bumpAgentsRefresh}
            circles={myCircles}
            onManageCircles={() => changeTab('circles')}
          />
        </div>

        <div className={tab === 'circles' ? '' : 'hidden'}>
          <Circles view={circlesView} circleResult={circleResult} onChanged={setMyCircles} />
        </div>

        {/* 社区网络：全网概览，仅在打开时挂载（避免后台轮询） */}
        {tab === 'network' && <Network embedded />}

        <div className={tab === 'earnings' ? '' : 'hidden'}>
          <CommunityEarningsCard />
          <EarningsView settlements={settlements} summary={summary} stats={stats} logs={logs} logRef={logRef} />
        </div>
      </div>
    </div>
  );
}
