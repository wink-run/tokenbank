import React, { useEffect, useState, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getNetwork, getStats, browseCircles } from '../api/client';
import { modelStatsForIds, normalizeNetworkPayload } from '../lib/networkModelStats';
import { fetchServerCommunityModels } from '../lib/communityModels';
import { useLang } from '../store/lang';
import P2pWorldMap from '../components/P2pWorldMap';
import TruncTip from '../components/TruncTip';
import { avatarColor } from '../components/UserAvatar';

/** 贡献 Token 大数展示（M/K） */
function fmtContribTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(v);
}

/** 模型/智能体条目的去重键 */
function offerItemKey(item) {
  if (typeof item === 'string') return item;
  return item?.display_name || item?.name || item?.id || '';
}

/**
 * 按分享者聚合供给排行：同用户多真实节点 / 多虚拟 Agent 合并为一条，
 * Token 与接单量累加，模型与智能体去重合并。
 */
function aggregateWorkersBySharer(workers) {
  const map = new Map();
  for (const w of workers || []) {
    const key = w.sharer || w.worker_id || w.name || '';
    if (!key) continue;
    const toks = Number(w.period_tokens) || 0;
    const jobs = Number(w.period_agent_jobs) || 0;
    const lat = Number(w.avg_latency_ms) || 0;
    const models = Array.isArray(w.models) ? w.models : [];
    const agents = Array.isArray(w.agents) ? w.agents : [];
    const prev = map.get(key);
    if (!prev) {
      map.set(key, {
        ...w,
        period_tokens: toks,
        period_agent_jobs: jobs,
        models: [...models],
        agents: [...agents],
        agent_count: Number(w.agent_count) || agents.length || 0,
        _latSum: lat,
        _latN: lat > 0 ? 1 : 0,
        _nameToks: toks,
      });
      continue;
    }
    prev.period_tokens += toks;
    prev.period_agent_jobs += jobs;
    if (lat > 0) {
      prev._latSum += lat;
      prev._latN += 1;
    }
    prev.agent_count = (Number(prev.agent_count) || 0)
      + (Number(w.agent_count) || agents.length || 0);
    const modelKeys = new Set(prev.models.map(offerItemKey).filter(Boolean));
    for (const m of models) {
      const id = offerItemKey(m);
      if (id && !modelKeys.has(id)) {
        modelKeys.add(id);
        prev.models.push(m);
      }
    }
    const agentKeys = new Set(prev.agents.map(offerItemKey).filter(Boolean));
    for (const a of agents) {
      const id = offerItemKey(a);
      if (id && !agentKeys.has(id)) {
        agentKeys.add(id);
        prev.agents.push(a);
      }
    }
    // 展示名：避开 *.local 主机名；否则取用量更高的
    const candHost = /\.local$/i.test(String(w.name || ''));
    const prevHost = /\.local$/i.test(String(prev.name || ''));
    if (prevHost && !candHost) {
      prev.name = w.name;
      prev._nameToks = toks;
    } else if (!candHost && toks > (Number(prev._nameToks) || 0)) {
      prev.name = w.name;
      prev._nameToks = toks;
    } else if (candHost && prevHost && toks > (Number(prev._nameToks) || 0)) {
      prev.name = w.name;
      prev._nameToks = toks;
    }
  }
  return [...map.values()].map((r) => ({
    ...r,
    avg_latency_ms: r._latN ? Math.round(r._latSum / r._latN) : (Number(r.avg_latency_ms) || 0),
  }));
}

/** 节点上架：完整列表（悬浮用）与短摘要（列表展示） */
function workerOfferTexts(w, t) {
  const models = (Array.isArray(w?.models) ? w.models : [])
    .map((m) => (typeof m === 'string' ? m : m?.name))
    .filter(Boolean);
  const agents = Array.isArray(w?.agents)
    ? w.agents.map((a) => (typeof a === 'string' ? a : a?.display_name || a?.name || a?.id)).filter(Boolean)
    : [];
  const fullParts = [...models, ...agents];
  if (!fullParts.length && (w?.agent_count || 0) > 0) {
    const only = t('network.agentOnly', { n: w.agent_count });
    return { short: only, full: only };
  }
  if (!fullParts.length) {
    const empty = t('network.noOffers');
    return { short: empty, full: empty };
  }
  const full = fullParts.join(' · ');
  const shortParts = [...models.slice(0, 3), ...agents.slice(0, 3)];
  const more = Math.max(0, fullParts.length - shortParts.length);
  const short = more > 0 ? `${shortParts.join(' · ')} · +${more}` : shortParts.join(' · ');
  return { short, full };
}

// Extract param size from model name
function parseSize(name) {
  const m = name.match(/[:\-_](\d+(?:\.\d+)?)[bB]\b/);
  if (m) return m[1].replace(/\.0$/, '') + 'B';
  const m2 = name.match(/(\d+(?:\.\d+)?)[bB](?:[:\-_]|$)/);
  if (m2) return m2[1].replace(/\.0$/, '') + 'B';
  return null;
}

/**
 * 展示用被雇人数 = 真实 hire_count + [10,50] 稳定偏移（同一聚合键刷新不变）。
 */
function displayHiredCount(realCount, seedKey) {
  const real = Math.max(0, Number(realCount) || 0);
  const seed = String(seedKey || '');
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h = ((h << 5) - h) + seed.charCodeAt(i);
    h |= 0;
  }
  const boost = 10 + (Math.abs(h) % 41); // 10..50
  return real + boost;
}

/** 拆分智能体名称与所有者（去掉「昵称的」历史前缀） */
function parseAgentDisplay(a) {
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
  return {
    name: name || String(a?.name || '').trim() || a?.id || '智能体',
    owner,
  };
}

/**
 * 按智能体名聚合（同模型列表：多节点 → 多提供者）。
 * providerCount = 不同所有者数（无所有者时按 worker 计）。
 */
function aggregateAgentsByName(list) {
  const map = new Map();
  for (const a of list || []) {
    const { name, owner } = parseAgentDisplay(a);
    let g = map.get(name);
    if (!g) {
      g = {
        name,
        owners: new Set(),
        providerKeys: new Set(),
        hire_count: 0,
      };
      map.set(name, g);
    }
    if (owner) g.owners.add(owner);
    // 无昵称时用 worker_id 区分提供者，避免多人被压成 1
    g.providerKeys.add(owner || String(a.worker_id || a.id || ''));
    g.hire_count += Math.max(0, Number(a.hire_count) || 0);
  }
  return [...map.values()]
    .map((g) => ({
      name: g.name,
      providers: g.providerKeys.size || 1,
      hire_count: g.hire_count,
      // 完整所有者列表供悬浮；展示侧仍只显示「n 人提供」
      ownersFull: [...g.owners],
    }))
    .sort((a, b) => b.providers - a.providers || a.name.localeCompare(b.name, 'zh'));
}

export default function Network({ embedded = false }) {
  const { t } = useLang();
  const navigate  = useNavigate();
  const location = useLocation();
  // 嵌在交易页时跟交易页走；单独打开时只在网络页刷新
  const pageActive = embedded
    ? location.pathname === '/contribute'
    : location.pathname === '/network';
  const [network,        setNetwork]        = useState(null);
  const [myStats,        setMyStats]        = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [circleModelMap, setCircleModelMap] = useState({});
  const [communityIds,   setCommunityIds]   = useState([]);
  const [circles,        setCircles]        = useState([]);
  const [listTab,        setListTab]        = useState('models');

  useEffect(() => {
    if (!pageActive) return undefined;
    let cancelled = false;
    async function load() {
      try {
        const [netRes, statsRes, communityRes, circlesRes] = await Promise.allSettled([
          getNetwork(), getStats(), fetchServerCommunityModels(), browseCircles(),
        ]);
        if (cancelled) return;
        if (netRes.status === 'fulfilled') {
          const payload = netRes.value?.data ?? netRes.value;
          setNetwork(normalizeNetworkPayload(payload));
        }
        if (statsRes.status === 'fulfilled') setMyStats(statsRes.value?.data ?? null);
        if (communityRes.status === 'fulfilled') {
          const v = communityRes.value;
          setCommunityIds(Array.isArray(v?.ids) ? v.ids : []);
          setCircleModelMap(v?.circleMap && typeof v.circleMap === 'object' ? v.circleMap : {});
        }
        if (circlesRes.status === 'fulfilled') {
          const list = circlesRes.value?.data?.circles;
          setCircles(Array.isArray(list) ? list : []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, [pageActive]);

  // 模型列表与 /v1/models 一致；节点数从 workers 聚合补充
  const modelStats = useMemo(() => {
    try {
      return modelStatsForIds(communityIds, network);
    } catch {
      return [];
    }
  }, [communityIds, network]);

  // 排行：先按用户聚合，再按 Token / 接单量排序（避免同用户多节点占满榜单）
  const topWorkers = useMemo(() => {
    return aggregateWorkersBySharer(network?.workers)
      .sort((a, b) => {
        const tok = (b.period_tokens || 0) - (a.period_tokens || 0);
        if (tok !== 0) return tok;
        return (b.period_agent_jobs || 0) - (a.period_agent_jobs || 0);
      })
      .slice(0, 20);
  }, [network]);

  const totalNodes  = network?.summary?.online_workers ?? 0;
  const totalModels = modelStats.length;
  // 按智能体名聚合：同名多人提供 → 一行 +「n 人提供」
  const agentGroups = useMemo(
    () => aggregateAgentsByName(network?.available_agents),
    [network?.available_agents],
  );
  const totalAgents = agentGroups.length;
  const totalTokens = network?.summary?.contrib_tokens
    ?? network?.workers?.reduce((s, w) => s + (w.period_tokens || 0), 0)
    ?? 0;

  /** 已入圈 → 主页；否则确认后申请加入 */
  // 申请加入统一在「交易 → 圈子 → 发现」完成，这里只做入口
  function onCircleClick(c) {
    if (!c?.id) return;
    if (c.join_status === 'member') {
      navigate(`/circles/${c.id}`);
      return;
    }
    navigate('/contribute', { state: { tradeTab: 'circles', circlesView: 'discover' } });
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const circleCount = network?.summary?.circle_count ?? circles.length;
  const kpis = [
    { k: 'nodes', label: t('network.globalNodes'), value: totalNodes, sub: t('network.onlineWorkers'), tone: 'text-blue-600 dark:text-blue-400' },
    { k: 'models', label: t('network.availableModels'), value: totalModels, sub: t('network.dedupModels') },
    { k: 'agents', label: t('network.availableAgents'), value: totalAgents, sub: t('network.availableAgentsHint'), tone: 'text-amber-600 dark:text-amber-400' },
    { k: 'circles', label: t('network.circlesStat'), value: circleCount, sub: t('network.circlesStatHint'), tone: 'text-emerald-600 dark:text-emerald-400' },
    { k: 'tokens', label: t('network.contribTokens'), value: fmtContribTokens(totalTokens), sub: t('network.thisPeriod') },
    { k: 'users', label: t('network.activeUsers'), value: network?.summary?.active_users ?? 0, sub: t('network.contributing'), tone: 'text-green-600 dark:text-green-400' },
  ];
  const LISTS = [
    { id: 'models', label: t('network.modelsTitle'), n: modelStats.length },
    { id: 'agents', label: t('network.agentsTitle'), n: totalAgents },
    { id: 'circles', label: t('network.circlesTitle'), n: circles.length },
  ];
  const medal = (rank) => (rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : null);
  const myOnline = !!(myStats && myStats.active_workers > 0);
  const card = 'rounded-2xl border border-zinc-200/70 dark:border-white/[0.07] bg-white/55 dark:bg-zinc-900/40';
  const rowCls = 'flex items-center gap-3 px-4 py-2.5 border-b last:border-b-0 border-zinc-100/90 dark:border-white/[0.05]';
  // 左侧三个列表：单行紧凑，长列表在卡片内滚动
  const rowCompact = 'flex items-center gap-2.5 px-3.5 py-2 border-b last:border-b-0 border-zinc-100/90 dark:border-white/[0.05]';

  return (
    <div className={embedded ? 'space-y-4' : 'px-5 py-5 space-y-4'}>
      {!embedded && (
      /* 页头（嵌入交易页时由页签承担） */
      <div>
        <button onClick={() => navigate(-1)}
          className="electron-no-drag relative z-50 mb-2 text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 transition-colors">
          {t('network.backProviders')}
        </button>
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
              {t('network.title')}
              <span className="inline-flex items-center gap-1.5 text-[11px] font-normal px-2 py-0.5 rounded-full border border-green-200 dark:border-green-900 bg-green-50/80 dark:bg-green-950/30 text-green-700 dark:text-green-300">
                <span className="relative flex w-1.5 h-1.5"><span className="absolute inline-flex w-full h-full rounded-full bg-green-400 opacity-70 animate-ping" /><span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-green-500" /></span>
                {t('network.running').replace(/^[●○]\s*/, '')}
              </span>
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('network.subtitle')}</p>
          </div>
          <div className="electron-no-drag relative z-50 flex items-center gap-2">
            <button type="button" onClick={() => navigate('/contribute', { state: { tradeTab: 'hire' } })}
              className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/70 dark:bg-zinc-900/40 text-zinc-700 dark:text-zinc-200 hover:bg-white dark:hover:bg-zinc-800">
              {t('network.goHire')}
            </button>
            <button type="button" onClick={() => navigate('/contribute', { state: { tradeTab: 'supply' } })}
              className="tb-press text-xs font-medium px-3.5 py-1.5 rounded-lg bg-blue-600 text-white shadow-sm shadow-blue-600/25 hover:bg-blue-500">
              {t('network.join')}
            </button>
          </div>
        </div>
      </div>
      )}

      {/* 全网概况：一条 KPI 带 */}
      <div className={`${card} overflow-hidden grid grid-cols-3 lg:grid-cols-6`}>
        {kpis.map((m, i) => (
          <div key={m.k} className={`px-4 py-3 min-w-0 border-zinc-100 dark:border-white/[0.06] ${i % 3 ? 'border-l' : ''} ${i >= 3 ? 'border-t lg:border-t-0' : ''} ${i === 3 ? 'lg:border-l' : ''}`}>
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{m.label}</div>
            <div className={`mt-1 text-lg font-semibold tabular-nums tracking-tight ${m.tone || 'text-zinc-900 dark:text-zinc-50'}`}>{loading ? '—' : m.value}</div>
            <div className="text-[11px] text-zinc-400 truncate mt-0.5">{m.sub}</div>
          </div>
        ))}
      </div>

      {/* 全球节点地图 */}
      {!loading && network && (
        <section className={`${card} p-4 overflow-hidden`}>
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{t('network.mapTitle')}</h2>
            <span className="text-[11px] text-zinc-400">{t('network.mapHint')}</span>
          </div>
          <div className="max-w-2xl mx-auto">
          <P2pWorldMap
            workers={network.workers || []}
            labels={{
              idle: t('network.idle'),
              busy: t('network.busy'),
              agent: t('network.mapAgent'),
              country: code => t('network.countryCode', { code }),
              mapped: ({ mapped, total }) => t('network.mapMapped', { mapped, total }),
              unmapped: n => t('network.mapUnmapped', { n }),
            }}
          />
          </div>
        </section>
      )}

      {loading ? (
        <div className="text-xs text-zinc-400">{t('common.loading')}</div>
      ) : !network ? (
        <div className={`${card} px-6 py-10 text-center text-xs text-zinc-500`}>{t('network.loadFailed')}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px] items-start">
          {/* 左：模型 / 智能体 / 公开圈子 */}
          <section className="min-w-0 space-y-3">
            <div role="tablist" className="inline-flex p-0.5 rounded-lg bg-zinc-100/90 dark:bg-zinc-800/80">
              {LISTS.map(l => (
                <button key={l.id} type="button" role="tab" aria-selected={listTab === l.id} onClick={() => setListTab(l.id)}
                  className={`text-xs px-3 py-1.5 rounded-md transition-colors ${
                    listTab === l.id
                      ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-50 shadow-sm font-medium'
                      : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                  }`}>
                  {l.label}<span className="ml-1 text-[11px] font-normal text-zinc-400 tabular-nums">{l.n}</span>
                </button>
              ))}
            </div>

            {listTab === 'models' && (
              <ul className={`${card} max-h-[22rem] overflow-y-auto`}>
                {modelStats.length === 0 ? (
                  <li className="px-4 py-8 text-center text-xs text-zinc-400">{t('network.noOnlineModels')}</li>
                ) : modelStats.map(m => {
                  const avgS = m.latencyCount > 0 ? (m.totalLatency / m.latencyCount / 1000).toFixed(1) : null;
                  const size = parseSize(m.name);
                  const off = m.nodes === 0;
                  return (
                    <li key={m.name} className={`${rowCompact} ${off ? 'opacity-50' : ''}`}>
                      <span className="w-5 h-5 rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-300 flex items-center justify-center text-[9px] shrink-0" aria-hidden>◆</span>
                      <div className="flex-1 min-w-0 flex items-center gap-1.5">
                        <TruncTip as="span" title={m.name} className="text-xs font-mono text-zinc-800 dark:text-zinc-100 min-w-0">{m.name}</TruncTip>
                        {size && <span className="shrink-0 text-[10px] px-1 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">{size}</span>}
                        {circleModelMap?.[m.name] && (
                          <span title={circleModelMap[m.name]?.circle_name || ''} className="shrink-0 text-[10px] px-1 rounded bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300">
                            ◎ {circleModelMap[m.name]?.circle_name || t('contribute.scope.circleTag')}
                          </span>
                        )}
                      </div>
                      <span className="shrink-0 w-14 text-right text-[11px] tabular-nums text-zinc-400">{off ? '—' : (avgS ? `${avgS}s` : t('network.idle'))}</span>
                      <span className="shrink-0 w-16 flex items-center justify-end gap-1.5 text-[11px] tabular-nums text-zinc-600 dark:text-zinc-300">
                        <span className={`w-1.5 h-1.5 rounded-full ${off ? 'bg-zinc-300' : 'bg-green-500'}`} aria-hidden />
                        {off ? t('network.nodesZero') : t('network.nodes', { n: m.nodes })}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {listTab === 'agents' && (
              <ul className={`${card} max-h-[22rem] overflow-y-auto`}>
                {agentGroups.length === 0 ? (
                  <li className="px-4 py-8 text-center text-xs text-zinc-400">{t('network.noOnlineAgents')}</li>
                ) : agentGroups.map((g) => (
                  <li key={g.name} className={`${rowCompact} group`}>
                    <span className={`w-5 h-5 rounded-md ${avatarColor(g.name)} text-white flex items-center justify-center text-[10px] font-semibold shrink-0`} aria-hidden>
                      {(g.name || '?')[0].toUpperCase()}
                    </span>
                    <TruncTip as="span" title={g.name} className="flex-1 min-w-0 text-xs text-zinc-800 dark:text-zinc-100">{g.name}</TruncTip>
                    <TruncTip as="span" className="shrink-0 text-[11px] text-zinc-400" title={g.ownersFull.join('、') || t('network.agentProviders', { n: g.providers })}>
                      {t('network.agentProviders', { n: g.providers })} · {t('network.hiredCount', { n: displayHiredCount(g.hire_count, g.name) })}
                    </TruncTip>
                    <button type="button"
                      onClick={() => navigate('/contribute', { state: { tradeTab: 'hire', scope: 'all', agentQuery: g.name } })}
                      className="tb-press shrink-0 whitespace-nowrap text-[11px] px-2 py-0.5 rounded-md bg-blue-600 text-white hover:bg-blue-500">
                      {t('contribute.hireShort')}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {listTab === 'circles' && (
              <ul className={`${card} max-h-[22rem] overflow-y-auto`}>
                {circles.length === 0 ? (
                  <li className="px-4 py-8 text-center text-xs text-zinc-400">{t('network.noCircles')}</li>
                ) : circles.slice(0, 30).map((c) => {
                  const isMember = c.join_status === 'member';
                  const isPending = c.join_status === 'pending';
                  const desc = String(c.description || '').trim();
                  return (
                    <li key={c.id}>
                      <button type="button" onClick={() => onCircleClick(c)}
                        className={`${rowCompact} w-full text-left hover:bg-zinc-50/80 dark:hover:bg-white/[0.03] transition-colors`}>
                        <span className={`w-5 h-5 rounded-md ${avatarColor(c.name || '')} text-white flex items-center justify-center text-[10px] font-semibold shrink-0`} aria-hidden>
                          {(c.name || '?')[0]}
                        </span>
                        <TruncTip as="span" title={c.name} className="shrink-0 max-w-[40%] text-xs text-zinc-800 dark:text-zinc-100">{c.name}</TruncTip>
                        <TruncTip as="span" className="flex-1 min-w-0 text-[11px] text-zinc-400" title={desc || t('network.circleNoDesc')}>{desc || t('network.circleNoDesc')}</TruncTip>
                        <span className="shrink-0 text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">{t('circles.members', { n: c.member_count ?? 0 })}</span>
                        <span className={`shrink-0 w-12 text-right text-[10px] ${isMember ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'}`}>
                          {isMember ? t('network.circleJoined') : isPending ? t('circles.browse.pending') : c.full ? t('circles.browse.full') : t('network.circleOpen')}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* 右：我的节点 / 贡献排行 / 在线节点 */}
          <aside className="space-y-3">
            <section className={`${card} p-4 space-y-3`}>
              <div className="flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{t('network.myNode')}</h2>
                <span className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full border ${
                  myOnline
                    ? 'border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${myOnline ? 'bg-green-500' : 'bg-zinc-300'}`} aria-hidden />
                  {(myOnline ? t('network.online') : t('network.offline')).replace(/^[●○]\s*/, '')}
                </span>
              </div>
              {myStats ? (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      [t('network.activeNodes'), myStats.active_workers ?? 0],
                      [t('network.activeRequests'), myStats.active_requests ?? 0],
                      [t('network.contribRate'), `${myStats.contribute_req_per_min ?? 0}`],
                    ].map(([k, v]) => (
                      <div key={k} className="rounded-xl bg-zinc-50/80 dark:bg-zinc-900/50 px-3 py-2">
                        <div className="text-[10px] text-zinc-400 truncate">{k}</div>
                        <div className="text-[15px] font-semibold tabular-nums text-zinc-900 dark:text-zinc-50 mt-0.5">{v}</div>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => navigate('/contribute', { state: { tradeTab: 'supply' } })}
                    className="w-full py-1.5 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800">
                    {t('network.manageContrib')}
                  </button>
                </>
              ) : (
                <p className="text-xs text-zinc-400">{t('network.loginRequired')}</p>
              )}
            </section>

            <section className={`${card} overflow-hidden`}>
              <div className="flex items-baseline justify-between px-4 pt-3.5 pb-2">
                <h2 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{t('network.leaderboard')}</h2>
                <span className="text-[11px] text-zinc-400">{t('network.leaderboardHint')}</span>
              </div>
              <ul className="max-h-[26rem] overflow-y-auto">
                {topWorkers.length === 0 ? (
                  <li className="px-4 pb-4 text-xs text-zinc-400">{t('network.noContribData')}</li>
                ) : topWorkers.map((w, i) => {
                  const rank = i + 1;
                  const { short: offerShort, full: offerFull } = workerOfferTexts(w, t);
                  const jobs = Number(w.period_agent_jobs) || 0;
                  const toks = Number(w.period_tokens) || 0;
                  return (
                    <li key={w.sharer || w.worker_id || w.name} className={`${rowCls} ${rank <= 3 ? 'bg-amber-50/30 dark:bg-amber-950/10' : ''}`}>
                      <span className="w-6 text-center shrink-0 text-sm tabular-nums">
                        {medal(rank) || <span className="text-[11px] font-semibold text-zinc-400">{rank}</span>}
                      </span>
                      <div className="flex-1 min-w-0">
                        <TruncTip className="text-xs font-medium text-zinc-800 dark:text-zinc-100" title={w.name}>{w.name}</TruncTip>
                        <TruncTip className="text-[11px] text-zinc-400 mt-0.5" title={offerFull}>{offerShort}</TruncTip>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-xs font-semibold tabular-nums text-zinc-800 dark:text-zinc-100">
                          {toks > 0 || jobs === 0 ? `${fmtContribTokens(toks)} tok` : t('network.agentJobs', { n: jobs })}
                        </div>
                        <div className="text-[10px] text-zinc-400 tabular-nums">
                          {toks > 0 && jobs > 0 ? t('network.agentJobs', { n: jobs }) : `${w.avg_latency_ms ?? 0} ms`}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>

            {(network?.workers?.length ?? 0) > 0 && (
              <details className={`${card} overflow-hidden group`}>
                <summary className="flex items-center justify-between px-4 py-3 cursor-pointer select-none list-none">
                  <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">
                    <span className="inline-block mr-1 text-zinc-400 transition-transform group-open:rotate-90">›</span>
                    {t('network.workersTitle')}
                  </span>
                  <span className="text-[11px] text-zinc-400">{t('network.workersCount', { n: network.workers.length })}</span>
                </summary>
                <ul className="max-h-64 overflow-y-auto border-t border-zinc-100 dark:border-white/[0.05]">
                  {network.workers.map(w => {
                    const { short: offerShort, full: offerFull } = workerOfferTexts(w, t);
                    const geo = w.geo?.city || w.geo?.country || '';
                    const isAgentOnly = w.has_agents && !(w.models || []).length;
                    return (
                      <li key={w.worker_id || w.name} className={rowCls}>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${w.status === 'busy' ? 'bg-amber-500' : isAgentOnly ? 'bg-yellow-500' : 'bg-green-500'}`} aria-hidden />
                        <div className="flex-1 min-w-0">
                          <TruncTip as="span" className="text-xs text-zinc-800 dark:text-zinc-100" title={w.name}>{w.name}</TruncTip>
                          <TruncTip className="text-[11px] text-zinc-400 mt-0.5" title={geo ? `${offerFull} · ${geo}` : offerFull}>
                            {geo ? `${offerShort} · ${geo}` : offerShort}
                          </TruncTip>
                        </div>
                        <div className="text-right shrink-0 text-[10px] tabular-nums text-zinc-400">
                          <div>{w.avg_latency_ms ?? 0} ms</div>
                          <div>{Math.round(w.online_mins ?? 0)} min</div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
