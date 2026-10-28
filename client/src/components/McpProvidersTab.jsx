import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ServiceIcon from './ServiceIcon';
import { useLang } from '../store/lang';
import { ASSET_BTN_GHOST, ASSET_BTN_MANAGED, ASSET_BTN_PRIMARY, AssetMoreMenu } from './ResourceAssetCard';
import {
  FilterMenu, AppIconStack, LIB_LIST_CLS, libRowCls, LibrarySectionHead, LibraryRowTitle,
  LibraryInspector, InspectorSection, InspectorPreview,
} from './LibraryControls';

/** MCP 列表列宽：勾选 | 名称 | 投射到 | 类型 | 状态 | 操作（Tailwind 需字面量） */
const MCP_GRID = 'grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[auto_minmax(0,1fr)_7rem_3.5rem_4.5rem_9rem]';
const MCP_HEAD_GRID = 'md:grid-cols-[auto_minmax(0,1fr)_7rem_3.5rem_4.5rem_9rem]';

/** MCP 图标：目录给的 emoji，缺省扳手 */
function McpLogo({ icon }) {
  return (
    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-zinc-100 dark:bg-zinc-800 ring-1 ring-zinc-200/70 dark:ring-zinc-700/70 text-base" aria-hidden>
      {icon || '🔧'}
    </span>
  );
}

const MCP_VIEW_TAB_KEY = 'tokenbank.providers.mcpViewTab';
const MCP_AGENT_TAB_KEY = 'tokenbank.providers.mcpAgentTab';

/** 目录分组 id → i18n key（无词条时回退后端 label） */
function localizeGroupLabel(group, t) {
  if (!group?.id) return group?.label || '';
  const key = `providers.mcp.group.${group.id}`;
  const v = t(key);
  return v === key ? (group.label || group.id) : v;
}

/** 目录项描述：按 catalogId 取词条 */
function localizeCatalogDesc(item, t) {
  const id = item?.catalogId || item?.id || item?.name;
  if (!id) return item?.description || '';
  const key = `providers.mcp.catalog.${id}.desc`;
  const v = t(key);
  return v === key ? (item?.description || '') : v;
}

/** 中文标签 → slug（品牌名保持原样） */
const MCP_TAG_SLUG = {
  内置: 'builtin',
  编排: 'orchestrate',
  提示词: 'prompt',
  官方: 'official',
  文件: 'file',
  记忆: 'memory',
  推理: 'reasoning',
  演示: 'demo',
  代码: 'code',
  搜索: 'search',
  抓取: 'fetch',
  网页: 'web',
  地图: 'maps',
  文档: 'docs',
  浏览器: 'browser',
  协作: 'collab',
  笔记: 'notes',
  监控: 'monitor',
  缓存: 'cache',
};

function localizeCatalogTag(tag, t) {
  const slug = MCP_TAG_SLUG[tag];
  if (!slug) return tag;
  const key = `providers.mcp.tag.${slug}`;
  const v = t(key);
  return v === key ? tag : v;
}

/** 纳管表单字段 label */
function localizeFieldLabel(field, t) {
  if (!field?.key) return field?.label || '';
  const key = `providers.mcp.field.${field.key}`;
  const v = t(key);
  return v === key ? (field.label || field.key) : v;
}

/** URL 型：远程 HTTP / SSE；否则为 CLI（stdio command） */
function isMcpUrlServer(s) {
  if (!s) return false;
  return !!(s.url || s.type === 'sse' || s.type === 'http');
}

const EMPTY_CUSTOM_FORM = {
  name: '',
  display_name: '',
  type: 'stdio', // stdio=CLI，http=URL
  command: 'npx',
  args: '-y mcp-fetch-server',
  url: '',
  headersText: '{}',
};

function readMcpAgentTab() {
  try {
    const v = localStorage.getItem(MCP_AGENT_TAB_KEY);
    return v && v !== 'all' ? v : '';
  } catch { return ''; }
}

function saveMcpAgentTab(tab) {
  try { localStorage.setItem(MCP_AGENT_TAB_KEY, tab); } catch {}
}

function readMcpViewTab() {
  try {
    const v = localStorage.getItem(MCP_VIEW_TAB_KEY);
    // 已安装 / 已纳管合并为「已纳管」（与 Skill 一致）
    if (v === 'catalog') return 'catalog';
    return 'managed';
  } catch { return 'managed'; }
}

function saveMcpViewTab(tab) {
  try { localStorage.setItem(MCP_VIEW_TAB_KEY, tab); } catch {}
}

/**
 * MCP 工具（资源页第四类资产）。
 * viewTab：由资源页「资产库 / 为你推荐」驱动（managed / catalog）；不传时自带视图切换。
 * searchQuery：资源页顶部搜索；createSignal 递增时打开「自定义 MCP」。
 */
export default function McpProvidersTab({ viewTab: controlledView = null, searchQuery = '', createSignal = 0, onCountChange } = {}) {
  const { t } = useLang();
  const [catalog, setCatalog] = useState([]);
  const [catalogGroups, setCatalogGroups] = useState([]);
  const [catalogFilter, setCatalogFilter] = useState('');
  const [mcpViewTab, setMcpViewTab] = useState(() => readMcpViewTab());
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [installTarget, setInstallTarget] = useState(null);
  const [installConfig, setInstallConfig] = useState({});
  const [showCustom, setShowCustom] = useState(false);
  const [customForm, setCustomForm] = useState(() => ({ ...EMPTY_CUSTOM_FORM }));
  /** 点击标题编辑已纳管 MCP */
  const [editServer, setEditServer] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncMsg, setSyncMsg] = useState('');
  const [agentTab, setAgentTab] = useState(() => readMcpAgentTab());
  const [syncMenuOpen, setSyncMenuOpen] = useState(false);
  const [syncMenuPos, setSyncMenuPos] = useState(null);
  /** null=批量安装菜单，string=单行 MCP id */
  const [installMenuServerId, setInstallMenuServerId] = useState(null);
  const [syncSelectedIds, setSyncSelectedIds] = useState([]);
  // 菜单模式：project=写盘投射；relay=中转绑定（分按钮入口）
  const [syncMenuMode, setSyncMenuMode] = useState('project');
  const [selectedServerIds, setSelectedServerIds] = useState([]);
  const effView = controlledView ? (controlledView === 'recommend' ? 'catalog' : 'managed') : mcpViewTab;
  const effQuery = controlledView ? String(searchQuery || '') : catalogFilter;
  const syncProjectBtnRef = useRef(null);
  const syncMenuRef = useRef(null);
  /** 编辑弹窗内容区：打开时滚回顶部 */
  const editPanelRef = useRef(null);
  /** 内置 MCP 网关状态（URL / token / 已路由列表） */
  const [gatewayInfo, setGatewayInfo] = useState(null);
  /** 网关按应用隔离：当前编辑/复制的目标应用 id */
  /** Gateway API 应用（与 apps:list 同源，避免下拉漏项） */
  const [gatewayApiApps, setGatewayApiApps] = useState([]);
  /** Gateway 应用全量（与「应用」页 apps:list 同源，供顶部筛选对齐已纳管） */
  const [gatewayApps, setGatewayApps] = useState([]);
  /** 选中行（右侧详情）：m:<serverId> / c:<catalogId> */
  const [selectedKey, setSelectedKey] = useState(null);
  /** 内置卡展开：null=自动（有未就绪应用时展开） */
  const [builtinCardOpen, setBuiltinCardOpen] = useState(null);
  /** 展开了「启用原生工具」说明的应用 */
  const [nativeOpenIds, setNativeOpenIds] = useState([]);
  /** 应用接入详情：是否明文显示中转令牌 */
  const [showRelayToken, setShowRelayToken] = useState(false);

  useEffect(() => { if (createSignal) setShowCustom(true); }, [createSignal]);
  // 上报已纳管数量（资源页「资产库」计数）
  // 计数只含可管理的第三方 MCP（内置与中转条目属基础设施）
  const listableCount = servers.filter((s) => !s.builtin && !isRelaySelfServer(s)).length;
  useEffect(() => { onCountChange?.(loading ? null : listableCount); }, [listableCount, loading, onCountChange]);

  // 主栏有 backdrop-filter 时 fixed 会相对主栏定位；弹窗挂到 body 并复位滚动
  useEffect(() => {
    if (!editServer) return undefined;
    const id = requestAnimationFrame(() => {
      if (editPanelRef.current) editPanelRef.current.scrollTop = 0;
    });
    return () => cancelAnimationFrame(id);
  }, [editServer]);

  const loadAll = useCallback(async (opts = {}) => {
    if (!window.electronAPI?.mcp) {
      setLoading(false);
      return;
    }
    const silent = !!opts.silent;
    // silent：投射等操作后局部刷新，不整页进入 loading
    if (!silent) setLoading(true);
    setError('');
    // apps:list 很重：与 MCP 并行拉，但不参与首屏 loading 门闩
    const appsPromise = window.electronAPI.apps?.list?.() || Promise.resolve([]);
    try {
      // 目录多为本地 yaml，先返回以尽快结束「加载中」；servers/sync 含扫盘+安装探测更慢
      const catRes = await window.electronAPI.mcp.listCatalog();
      if (catRes.success) {
        setCatalog(catRes.catalog || []);
        setCatalogGroups(catRes.grouped || []);
      } else {
        setError(catRes.error || t('providers.mcp.loadCatalogFailed'));
      }
      if (!silent) setLoading(false);

      const [srvRes, syncRes, gwRes] = await Promise.all([
        window.electronAPI.mcp.listServers(),
        window.electronAPI.mcp.getSyncStatus(),
        window.electronAPI.mcp.getGatewayInfo?.() || Promise.resolve(null),
      ]);
      if (srvRes.success) setServers(srvRes.servers || []);
      if (syncRes.success) setSyncStatus(syncRes);
      if (gwRes?.success) setGatewayInfo(gwRes);
      else if (gwRes && gwRes.success === false) setGatewayInfo(null);
    } catch (e) {
      setError(e.message);
      if (!silent) setLoading(false);
    }

    // 补齐 Gateway 纳管应用（筛选 / 投射列表）；失败不影响已展示的 MCP
    try {
      const appsList = await appsPromise;
      const rows = Array.isArray(appsList) ? appsList : [];
      setGatewayApps(rows.filter((a) => a && !a.draft));
      setGatewayApiApps(
        rows
          .filter((a) => a && !a.draft && !a._virtual_apikey && a.link_method === 'manual')
          .filter((a) => typeof a.id === 'string')
          .map((a) => ({
            id: a.id,
            label: a.name || a.id,
            kind: 'api-app',
            link_method: a.link_method,
          })),
      );
    } catch {
      /* ignore */
    }
  }, [t]);

  useEffect(() => { loadAll(); }, [loadAll]);

  /**
   * 与 Gateway 应用表「状态」列一致：已纳管 / API 在线 → true；未纳管 → false。
   * 见 Gateway.jsx 行内 isManaged 计算。
   */
  function isGatewayAppManaged(app) {
    if (!app || app.draft) return false;
    const keyApp = app.link_method === 'api-key' || app.link_method === 'manual';
    const isCfgApp = keyApp && app.host_method === 'config-file';
    const isDirectOnly = app.link_method === 'direct';
    const isSessionApp = app.link_method === 'session';
    const hostable = app.link_method === 'shim' || isCfgApp || isDirectOnly;
    const tracked = app.hosted === true && !app.needs_dev_mode;
    if (isSessionApp) return tracked;
    if (hostable) return tracked;
    return keyApp && !app._virtual_apikey;
  }

  // 投射/中转桌面列表：与顶部筛选同源（Gateway 已纳管，不含 API）
  // syncClientId：实际写盘目标（codex-desktop→codex，claude-desktop→claude-code）
  const MCP_SYNC_ID_ALIAS = {
    'codex-desktop': 'codex',
    'claude-desktop': 'claude-code',
  };
  // 与 CLI 复用写盘：投射列表不单独展示（选 Claude Code 即覆盖 Desktop）
  const MCP_PROJECT_LIST_HIDDEN = new Set(['claude-desktop']);
  function resolveSyncWriteId(filterId) {
    const cand = MCP_SYNC_ID_ALIAS[filterId] || filterId;
    const t = (syncStatus?.targets || []).find((x) => x.id === cand && x.syncEnabled !== false);
    return t ? t.id : null;
  }
  function expandClientMatchIds(filterId) {
    const ids = new Set([filterId]);
    const syncId = resolveSyncWriteId(filterId) || MCP_SYNC_ID_ALIAS[filterId];
    if (syncId) ids.add(syncId);
    for (const [from, to] of Object.entries(MCP_SYNC_ID_ALIAS)) {
      if (from === filterId || to === filterId || from === syncId || to === syncId) {
        ids.add(from);
        ids.add(to);
      }
    }
    return ids;
  }

  const syncWritableAgents = (() => {
    const items = [];
    const seen = new Set();
    for (const app of gatewayApps) {
      if (!isGatewayAppManaged(app) || app.link_method === 'manual') continue;
      const id = app.agent_id || app.preset_id || app.id;
      if (!id || seen.has(id)) continue;
      // Claude Desktop 不单独展示，与 Claude Code 复用
      if (MCP_PROJECT_LIST_HIDDEN.has(id)) continue;
      seen.add(id);
      const syncClientId = resolveSyncWriteId(id);
      items.push({
        id,
        label: app.name || id,
        syncClientId,
        projectable: !!syncClientId,
        installed: true,
        appId: app.id,
      });
    }
    return items;
  })();

  // 当前筛选目标须落在 Gateway「已纳管/在线」列表；尚未拉到 apps 时不误清
  useEffect(() => {
    if (!agentTab) return;
    if (gatewayApps.length === 0 && gatewayApiApps.length === 0) return;
    const managedIds = new Set();
    for (const app of gatewayApps) {
      if (!isGatewayAppManaged(app)) continue;
      if (app.link_method === 'manual' && app.id) managedIds.add(app.id);
      else {
        const aid = app.agent_id || app.preset_id || app.id;
        if (aid) managedIds.add(aid);
        if (app.id) managedIds.add(app.id);
        // Desktop 隐藏项：映射到复用的 CLI id，避免旧筛选态被清掉后空白
        const aliased = MCP_SYNC_ID_ALIAS[aid];
        if (aliased) managedIds.add(aliased);
      }
    }
    for (const a of gatewayApiApps) if (a?.id) managedIds.add(a.id);
    // 旧态若停在 claude-desktop，自动切到 claude-code
    if (MCP_PROJECT_LIST_HIDDEN.has(agentTab)) {
      const next = MCP_SYNC_ID_ALIAS[agentTab] || '';
      setAgentTab(next);
      saveMcpAgentTab(next);
      return;
    }
    if (managedIds.has(agentTab)) return;
    setAgentTab('');
    saveMcpAgentTab('');
  }, [agentTab, gatewayApps, gatewayApiApps]);

  /** 可加入网关代理：已启用的 stdio 或远程 URL */
  function canRouteViaGateway(s) {
    if (!s || s.status !== 'active') return false;
    if (isMcpUrlServer(s)) return true;
    return !!s.command;
  }

  /** 磁盘上已有投射（含客户端自配扫描到的安装），需保留「投射」入口以便取消 */
  function serverHasDiskProjection(s) {
    if (!s) return false;
    if (Array.isArray(s.sync_clients) && s.sync_clients.length > 0) return true;
    return (s.clientTargets || []).some((c) => c.installed);
  }

  /** Token Bank 内置 MCP（可进「通用」中转档，含派发桥） */
  function isTbBuiltinRelayMcp(s) {
    if (!s) return false;
    return s.id === 'tokenbank-agent-bridge'
      || s.id === 'tokenbank-prompts'
      || s.id === 'tokenbank-models'
      || s.id === 'tokenbank-resources';
  }

  function serverGatewayClients(server) {
    return Array.isArray(server?.gateway_clients) ? server.gateway_clients : [];
  }

  /** 可勾选同步的第三方 MCP（内置项默认同步，不进这批勾选） */
  const syncSelectableServers = servers.filter(
    s => s.status === 'active' && !s.builtin && !isRelaySelfServer(s),
  );
  const selectedSyncableIds = selectedServerIds.filter(id =>
    syncSelectableServers.some(s => s.id === id),
  );
  const allSyncSelectableChecked = syncSelectableServers.length > 0
    && syncSelectableServers.every(s => selectedServerIds.includes(s.id));

  function toggleServerSelected(serverId) {
    setSelectedServerIds(prev => (
      prev.includes(serverId) ? prev.filter(id => id !== serverId) : [...prev, serverId]
    ));
  }

  function toggleSelectAllServers() {
    if (allSyncSelectableChecked) {
      setSelectedServerIds([]);
    } else {
      setSelectedServerIds(syncSelectableServers.map(s => s.id));
    }
  }

  const closeSyncMenu = useCallback(() => {
    setSyncMenuOpen(false);
    setSyncMenuPos(null);
    setInstallMenuServerId(null);
  }, []);

  useEffect(() => {
    if (!syncMenuOpen) return;
    const onDoc = (e) => {
      const t = e.target;
      if (syncMenuRef.current?.contains(t)) return;
      if (syncProjectBtnRef.current?.contains(t)) return;
      if (t.closest?.('[data-row-install-btn]')) return;
      closeSyncMenu();
    };
    // 页面或任意外层滚动时关闭浮窗（菜单内部滚动除外）
    const onScroll = (e) => {
      if (syncMenuRef.current?.contains(e.target)) return;
      closeSyncMenu();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [syncMenuOpen, closeSyncMenu]);

  function openInstallMenu({ serverId = null, anchorEl, selectedAgentIds, mode = 'project' }) {
    if (syncMenuOpen && installMenuServerId === serverId && syncMenuMode === mode) {
      closeSyncMenu();
      return;
    }
    setInstallMenuServerId(serverId);
    setSyncMenuMode(mode);
    setSyncSelectedIds(selectedAgentIds);
    if (anchorEl) {
      const r = anchorEl.getBoundingClientRect();
      const menuW = 320;
      const spaceBelow = window.innerHeight - r.bottom - 8;
      const spaceAbove = r.top - 8;
      // 下方空间不足时向上展开，避免被视口裁切
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      const maxH = Math.min(400, Math.max(180, openUp ? spaceAbove : spaceBelow));
      const left = Math.min(Math.max(8, r.right - menuW), window.innerWidth - menuW - 8);
      setSyncMenuPos({
        top: openUp ? null : r.bottom + 4,
        bottom: openUp ? window.innerHeight - r.top + 4 : null,
        left,
        maxH,
      });
    }
    setSyncMenuOpen(true);
  }

  /** 收集某 MCP 当前已投射到的纳管应用（返回筛选同源 id） */
  function getInstalledAgentIds(server) {
    if (!server) return [];
    const ids = new Set();
    const hitIds = new Set();
    for (const c of server.clientTargets || []) {
      if (c.installed) hitIds.add(c.id);
    }
    for (const id of server.sync_clients || []) hitIds.add(id);

    for (const agent of syncWritableAgents) {
      const match = expandClientMatchIds(agent.id);
      if ([...hitIds].some((h) => match.has(h))) ids.add(agent.id);
    }
    return [...ids];
  }

  function relayTargetLabel(id) {
    return gatewayApiApps.find((a) => a.id === id)?.label
      || syncStatus?.targets?.find((t) => t.id === id)?.label
      || id;
  }

  /** 可接入的应用：可写配置的桌面 / CLI + 网关 API 应用 */
  function addTargets() {
    return [
      ...syncWritableAgents.map((a) => ({ id: a.id, label: a.label, kind: 'agent', agent: a })),
      ...gatewayApiApps.map((a) => ({ id: a.id, label: a.label, kind: 'api-app' })),
    ];
  }

  /** 某 MCP 在某应用上的现有接入方式：project（已写入应用配置）| relay（经网关）| null */
  function connectionOf(server, appId) {
    if (getInstalledAgentIds(server).includes(appId)) return 'project';
    if (serverGatewayClients(server).includes(appId)) return 'relay';
    return null;
  }

  /**
   * 投射的实现方式：第三方 MCP 经 TokenBank 网关中转（应用只需配置一次中转地址，增减 MCP 不再改应用配置，
   * 密钥只存在 TokenBank）；内置 MCP 属默认基础设施，直接写入应用配置。已写入配置的第三方老条目保留，可撤销。
   */
  function autoTransport(server, target) {
    // 内置 MCP 默认直接写入应用配置（由 TokenBank 按应用生成正确条目）；API 应用只能经中转
    if (server.builtin && target.kind !== 'api-app' && target.agent?.projectable) return 'project';
    if (canRelay(server)) return 'relay';
    return null;
  }

  /** 网关中转根地址（…/mcp）与某应用的专属中转地址（…/mcp/<appId>） */
  function relayBase() {
    return gatewayInfo?.endpoint?.url ? String(gatewayInfo.endpoint.url).replace(/\/mcp\/?$/, '') : '';
  }
  function relayUrlFor(appId) {
    const profile = (gatewayInfo?.profiles || []).find((p) => p.id === appId);
    if (profile?.url) return profile.url;
    const base = relayBase();
    return base ? `${base}/mcp/${appId}` : '';
  }

  /** 中转地址行：等宽显示 + 复制接入配置（含鉴权头） */
  function renderRelayUrl(appId, { compact = false, copy = true } = {}) {
    const url = relayUrlFor(appId);
    if (!url) return <span className="text-[10px] text-zinc-400">{t('providers.mcp.gatewayNotReady')}</span>;
    return (
      <div className={`flex items-center gap-1.5 min-w-0 ${compact ? '' : 'mt-0.5'}`}>
        <code className={`flex-1 min-w-0 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 select-all ${compact ? 'break-all' : 'truncate'}`} title={url}>{url}</code>
        {copy && (
          <button type="button" onClick={() => copyRelayConfigFor(appId)}
            title={t('resources.mcp.relayOnce')}
            className="shrink-0 text-[10px] text-blue-600 dark:text-blue-400 hover:underline">
            {t('resources.mcp.copyRelay')}
          </button>
        )}
      </div>
    );
  }

  /** 复制某应用的一次性中转接入配置（tokenbank-relay → /mcp/<appId>） */
  async function copyRelayConfigFor(appId) {
    const profile = (gatewayInfo?.profiles || []).find((p) => p.id === appId);
    const cfg = profile?.configJson
      || (gatewayInfo?.endpoint?.token
        ? {
          mcpServers: {
            'tokenbank-relay': {
              url: `${String(gatewayInfo.endpoint.url || '').replace(/\/mcp\/?$/, '')}/mcp/${appId}`,
              headers: { Authorization: `Bearer ${gatewayInfo.endpoint.token}` },
            },
          },
        }
        : null);
    if (!cfg) {
      alert(t('providers.mcp.gatewayNotReady'));
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(cfg, null, 2));
      setSyncMsg(t('resources.mcp.relayCopied', { app: addTargets().find((tg) => tg.id === appId)?.label || relayTargetLabel(appId) }));
    } catch {
      alert(t('providers.mcp.gatewayCopyFailed'));
    }
  }

  /** 打开「添加到应用」：单条 = 勾选现有接入；批量 = 不预勾选 */
  function openAddMenu(server, anchorEl) {
    const preset = server
      ? addTargets().filter((tg) => connectionOf(server, tg.id)).map((tg) => tg.id)
      : [];
    openInstallMenu({ serverId: server ? server.id : null, anchorEl, selectedAgentIds: preset, mode: 'add' });
  }

  /**
   * 应用勾选结果：新勾选按 autoTransport 接入；单条模式下取消勾选 = 撤掉现有接入（写盘或中转）。
   * 批量模式只做添加。
   */
  async function applyAddToApps(selectedIds) {
    const single = installMenuServerId;
    const serverIds = single ? [single] : selectedSyncableIds;
    if (!serverIds.length) {
      alert(t('providers.mcp.selectMcpFirst'));
      return;
    }
    const targets = addTargets();
    closeSyncMenu();
    setBusy(single || 'sync');
    setSyncMsg('');
    const parts = [];
    let relayApps = new Set();
    let projectedToWorkbuddy = false;
    try {
      for (const serverId of serverIds) {
        const s = servers.find((x) => x.id === serverId);
        if (!s) continue;
        const relayAdd = []; const relayRemove = [];
        const projAdd = []; const projRemove = [];
        for (const tg of targets) {
          const cur = connectionOf(s, tg.id);
          const want = selectedIds.includes(tg.id);
          if (want && !cur) {
            const how = autoTransport(s, tg);
            if (how === 'relay') relayAdd.push(tg.id);
            else if (how === 'project') projAdd.push(tg);
          } else if (!want && cur && single && !s.builtin) {
            // 内置 MCP 默认投射到所有应用，不可取消
            if (cur === 'relay') relayRemove.push(tg.id);
            else projRemove.push(tg);
          }
        }
        if (relayAdd.length) {
          const r = await window.electronAPI.mcp.setServerGatewayRouted({ serverId, enabled: true, clientIds: relayAdd });
          if (!r?.success) throw new Error(r?.error || t('providers.mcp.gatewayToggleFailed'));
          relayAdd.forEach((id) => relayApps.add(id));
        }
        if (relayRemove.length) {
          const r = await window.electronAPI.mcp.setServerGatewayRouted({ serverId, enabled: false, clientIds: relayRemove });
          if (!r?.success) throw new Error(r?.error || t('providers.mcp.gatewayToggleFailed'));
        }
        if (projAdd.length || projRemove.length) {
          const previously = getInstalledAgentIds(s);
          const removeIds = new Set(projRemove.map((tg) => tg.id));
          const keepIds = previously.filter((id) => !removeIds.has(id));
          const selectedSync = [...new Set([
            ...keepIds.map((id) => syncWritableAgents.find((a) => a.id === id)?.syncClientId || id),
            ...projAdd.map((tg) => tg.agent.syncClientId),
          ].filter(Boolean))];
          const res = await window.electronAPI.mcp.setServerSyncClients({
            serverId,
            clientIds: selectedSync,
            syncClientIds: [...new Set([...previously, ...selectedSync])],
          });
          if (!res?.success) throw new Error(res?.error || t('providers.mcp.installFailed'));
          for (const tg of projRemove) {
            try { await window.electronAPI.mcp.removeFromAgent({ serverId, clientId: tg.id }); } catch { /* ignore */ }
          }
          if (projAdd.some((tg) => String(tg.id).toLowerCase().includes('workbuddy'))) projectedToWorkbuddy = true;
        }
        const labelOf = (id) => targets.find((tg) => tg.id === id)?.label || relayTargetLabel(id);
        const added = [...relayAdd.map(labelOf), ...projAdd.map((tg) => tg.label)];
        const removed = [...relayRemove.map(labelOf), ...projRemove.map((tg) => tg.label)];
        const name = s.display_name || s.name;
        if (added.length) parts.push(t('resources.mcp.addedTo', { name, apps: added.join('、') }));
        if (removed.length) parts.push(t('resources.mcp.removedFrom', { name, apps: removed.join('、') }));
      }
      const needManual = [...relayApps].filter((id) => gatewayApiApps.some((a) => a.id === id) || !relayUsableViaBuiltin(id));
      if (needManual.length) parts.push(t('resources.mcp.relaySetupHint'));
      if (projectedToWorkbuddy) parts.push(t('providers.mcp.workbuddyTrustHint'));
      if (!single) setSelectedServerIds([]);
      await loadAll({ silent: true });
      setSyncMsg(parts.join('\n') || t('providers.mcp.notInstalledAny'));
    } catch (e) {
      setSyncMsg(e.message);
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  function toggleAddSelected(id) {
    setSyncSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** 「添加到应用」统一菜单：只选应用，接入方式自动决定并在行内标注 */
  function renderAddMenu() {
    if (!syncMenuOpen || !syncMenuPos) return null;
    const single = installMenuServerId ? servers.find((x) => x.id === installMenuServerId) : null;
    const batchServers = single ? [] : selectedSyncableIds.map((id) => servers.find((x) => x.id === id)).filter(Boolean);
    const probe = single || batchServers[0] || null;
    const targets = addTargets();
    return createPortal(
      <div
        ref={syncMenuRef}
        style={{
          position: 'fixed',
          left: syncMenuPos.left,
          ...(syncMenuPos.top != null ? { top: syncMenuPos.top } : { bottom: syncMenuPos.bottom }),
          maxHeight: syncMenuPos.maxH,
        }}
        className="electron-no-drag fixed z-[9999] w-80 flex flex-col rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-lg overflow-hidden"
      >
        <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-700 shrink-0">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
            {single
              ? t('resources.mcp.addTitle', { name: single.display_name || single.name })
              : t('resources.mcp.addTitleBatch', { n: batchServers.length })}
          </p>
          <p className="text-[10px] text-zinc-400 mt-0.5">{single?.builtin ? t('resources.mcp.builtinLockedHint') : t('resources.mcp.addHint')}</p>
        </div>
        <div className="p-2 min-h-0 flex-1 overflow-y-auto space-y-0.5">
          {targets.length === 0 && <p className="text-xs text-zinc-400 px-2 py-2">{t('providers.mcp.noAgents')}</p>}
          {targets.map((tg) => {
            const checked = syncSelectedIds.includes(tg.id);
            const cur = probe ? connectionOf(probe, tg.id) : null;
            const how = cur || (probe ? autoTransport(probe, tg) : (tg.kind === 'api-app' ? 'relay' : 'project'));
            // 内置 MCP 已投射的应用锁定（不可取消）；未投射的仍可补上
            const locked = !!(probe?.builtin && cur);
            const blocked = locked || (!cur && !how);
            return (
              <div key={tg.id} className={`rounded-lg ${checked || locked ? 'bg-blue-50 dark:bg-blue-950/30' : ''}`}>
                <label className={`flex items-center gap-2 px-2 py-1.5 text-xs ${locked ? 'cursor-default' : blocked ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer hover:bg-zinc-50/60 dark:hover:bg-zinc-700/40 rounded-lg'}`}>
                  <input
                    type="checkbox"
                    checked={checked || locked}
                    disabled={blocked}
                    onChange={() => toggleAddSelected(tg.id)}
                    className="rounded border-zinc-300 dark:border-zinc-600"
                  />
                  <ServiceIcon id={tg.id} name={tg.label} boxClass="w-6 h-6" imgClass="w-3.5 h-3.5" />
                  <span className="flex-1 truncate text-zinc-700 dark:text-zinc-200" title={tg.label}>{tg.label}</span>
                  {locked ? (
                    <span className="shrink-0 text-[10px] text-sky-600 dark:text-sky-300" title={t('resources.mcp.builtinLockedHint')}>
                      {t('resources.mcp.builtinLocked')}
                    </span>
                  ) : cur === 'project' && (
                    <span className="shrink-0 text-[10px] text-zinc-400" title={t('resources.mcp.legacyConfigHint')}>
                      {t('resources.mcp.legacyConfig')}
                    </span>
                  )}
                </label>
                {checked && how === 'relay' && (
                  tg.kind !== 'api-app' && relayUsableViaBuiltin(tg.id) ? (
                    <p className="pl-10 pr-2 pb-1.5 -mt-0.5 text-[10px] text-zinc-400">{t('resources.mcp.viaBuiltinNote')}</p>
                  ) : (
                    <div className="pl-10 pr-2 pb-1.5 -mt-0.5">{renderRelayUrl(tg.id, { compact: true })}</div>
                  )
                )}
              </div>
            );
          })}
        </div>
        <div className="shrink-0 p-2 border-t border-zinc-100 dark:border-zinc-700 flex gap-2">
          <button type="button" onClick={closeSyncMenu}
            className="flex-1 text-xs py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600">
            {t('providers.mcp.cancel')}
          </button>
          <button
            type="button"
            disabled={!!busy || (!single && syncSelectedIds.length === 0)}
            onClick={() => applyAddToApps(syncSelectedIds)}
            className="tb-press flex-1 text-xs py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40"
          >
            {busy ? t('providers.mcp.processing') : t('resources.mcp.addConfirm')}
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  /** 批量：勾选多条后一次添加到应用 */
  function renderSyncDropdown() {
    if (!selectedSyncableIds.length) return null;
    return (
      <button
        ref={syncProjectBtnRef}
        type="button"
        onClick={() => openAddMenu(null, syncProjectBtnRef.current)}
        disabled={!!busy || addTargets().length === 0}
        className="tb-press text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 inline-flex items-center gap-1"
      >
        {busy === 'sync' ? t('providers.mcp.processing') : t('resources.mcp.projectN', { n: selectedSyncableIds.length })}
        <span className="text-[10px] opacity-70">▾</span>
      </button>
    );
  }

  async function handleInstall(item) {
    if (item.alwaysInstalled || item.installed) return;
    if (item.configFields?.length) {
      const defaults = {};
      for (const f of item.configFields) {
        if (f.defaultValue) defaults[f.key] = f.defaultValue;
      }
      setInstallConfig(defaults);
      setInstallTarget(item);
      return;
    }
    setBusy(item.catalogId);
    const res = await window.electronAPI.mcp.installCatalog({ catalogId: item.catalogId });
    setBusy('');
    if (!res.success) alert(res.error || t('providers.mcp.importFailed'));
    else {
      setMcpViewTab('managed');
      saveMcpViewTab('managed');
      loadAll();
    }
  }

  async function confirmInstall() {
    if (!installTarget) return;
    setBusy(installTarget.catalogId);
    const res = await window.electronAPI.mcp.installCatalog({
      catalogId: installTarget.catalogId,
      config: installConfig,
    });
    setBusy('');
    if (!res.success) {
      alert(res.error || t('providers.mcp.importFailed'));
      return;
    }
    setInstallTarget(null);
    setInstallConfig({});
    setMcpViewTab('managed');
    saveMcpViewTab('managed');
    loadAll();
  }

  async function handleUninstall(server) {
    if (server.builtin) return;
    if (!confirm(t('providers.mcp.uninstallConfirm', { name: server.display_name || server.name }))) return;
    setBusy(server.id);
    try {
      const res = await window.electronAPI.mcp.uninstallServer(server.id);
      if (!res?.success) alert(res?.error);
      else loadAll();
    } catch (e) {
      alert(e?.message || String(e));
    } finally {
      setBusy('');
    }
  }

  async function saveCustomServer() {
    const isUrl = isMcpUrlServer(customForm);
    if (!customForm.name.trim()) {
      alert(t('providers.mcp.nameRequired'));
      return;
    }
    if (isUrl && !customForm.url.trim()) {
      alert(t('providers.mcp.urlRequired'));
      return;
    }
    if (!isUrl && !customForm.command.trim()) {
      alert(t('providers.mcp.commandRequired'));
      return;
    }
    let headers = {};
    if (isUrl) {
      try {
        headers = customForm.headersText.trim() ? JSON.parse(customForm.headersText) : {};
        if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
          alert(t('providers.mcp.headersObjectRequired'));
          return;
        }
      } catch (e) {
        alert(t('providers.mcp.headersJsonInvalid', { msg: e.message }));
        return;
      }
    }
    const args = customForm.args.split(/\s+/).filter(Boolean);
    const metadata = { category: 'custom', description: t('providers.mcp.customServerDesc') };
    if (isUrl && Object.keys(headers).length) metadata.headers = headers;
    setBusy('custom');
    const res = await window.electronAPI.mcp.saveServer({
      name: customForm.name.trim(),
      display_name: customForm.display_name.trim() || customForm.name.trim(),
      type: isUrl ? 'http' : 'stdio',
      command: isUrl ? '' : customForm.command.trim(),
      args: isUrl ? [] : args,
      url: isUrl ? customForm.url.trim() : null,
      metadata,
    });
    setBusy('');
    if (!res.success) {
      alert(res.error || t('providers.mcp.saveFailed'));
      return;
    }
    setShowCustom(false);
    setCustomForm({ ...EMPTY_CUSTOM_FORM });
    setMcpViewTab('managed');
    saveMcpViewTab('managed');
    loadAll();
  }

  /** CLI / URL 模式切换（内部仍用 stdio / http） */
  function renderTypeModeToggle(isUrl, onChange) {
    return (
      <div className="space-y-1">
        <span className="text-[10px] text-zinc-500">{t('providers.mcp.type')}</span>
        <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-xs">
          <button
            type="button"
            onClick={() => onChange(false)}
            className={`px-3 py-1.5 ${
              !isUrl
                ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium'
                : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            {t('providers.mcp.typeCli')}
          </button>
          <button
            type="button"
            onClick={() => onChange(true)}
            className={`px-3 py-1.5 ${
              isUrl
                ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium'
                : 'text-zinc-400 hover:text-zinc-600'
            }`}
          >
            {t('providers.mcp.typeUrl')}
          </button>
        </div>
        <p className="text-[10px] text-zinc-400">
          {isUrl ? t('providers.mcp.typeUrlHint') : t('providers.mcp.typeCliHint')}
        </p>
      </div>
    );
  }

  /** 打开编辑弹窗（内置不可改） */
  function openEditServer(server) {
    if (!server || server.builtin) return;
    const isUrl = isMcpUrlServer(server);
    const envObj = server.env && typeof server.env === 'object' ? server.env : {};
    const headers = server.metadata?.headers && typeof server.metadata.headers === 'object'
      ? server.metadata.headers
      : {};
    const form = {
      id: server.id,
      builtin: false,
      name: server.name || '',
      display_name: server.display_name || server.name || '',
      type: isUrl ? (server.type === 'sse' ? 'sse' : 'http') : 'stdio',
      command: server.command || '',
      args: Array.isArray(server.args) ? server.args.join(' ') : '',
      url: server.url || '',
      envText: JSON.stringify(envObj, null, 2),
      headersText: JSON.stringify(headers, null, 2),
      description: server.metadata?.description || '',
      metadata: server.metadata || {},
      syncToAgents: true,
      editMode: 'form', // form | json
      rawJson: '',
      installedCount: [...new Set([
        ...(server.clientTargets || []).filter(c => c.installed).map(c => c.id),
        ...(server.sync_clients || []).filter((id) => syncWritableAgents.some((t) => t.id === id)),
      ])].length,
    };
    form.rawJson = buildEditRawJson(form);
    setEditServer(form);
  }

  /** 表单 → 原始 JSON（与写入 Agent 的 MCP 条目对齐，并含 TB 字段） */
  function buildEditRawJson(form) {
    const isUrl = form.type === 'sse' || form.type === 'http';
    let env = {};
    let headers = {};
    try { env = form.envText?.trim() ? JSON.parse(form.envText) : {}; } catch { env = {}; }
    try { headers = form.headersText?.trim() ? JSON.parse(form.headersText) : {}; } catch { headers = {}; }
    const doc = {
      name: form.name || '',
      display_name: form.display_name || form.name || '',
      description: form.description || '',
      type: form.type || 'stdio',
    };
    if (isUrl) {
      doc.url = form.url || '';
      if (headers && typeof headers === 'object' && Object.keys(headers).length) {
        doc.headers = headers;
      }
    } else {
      doc.command = form.command || '';
      doc.args = String(form.args || '').split(/\s+/).filter(Boolean);
      if (env && typeof env === 'object' && Object.keys(env).length) doc.env = env;
    }
    return JSON.stringify(doc, null, 2);
  }

  /** 原始 JSON → 表单字段 */
  function applyRawJsonToForm(form, text) {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(t('providers.mcp.jsonObjectRequired'));
    }
    const hasUrl = !!(doc.url || doc.type === 'sse' || doc.type === 'http');
    const type = doc.type === 'http' || doc.type === 'sse'
      ? doc.type
      : (hasUrl ? 'sse' : 'stdio');
    return {
      ...form,
      name: String(doc.name ?? form.name ?? '').trim(),
      display_name: String(doc.display_name ?? doc.name ?? form.display_name ?? '').trim(),
      description: String(doc.description ?? form.description ?? ''),
      type,
      command: String(doc.command ?? ''),
      args: Array.isArray(doc.args) ? doc.args.join(' ') : String(doc.args || ''),
      url: String(doc.url ?? ''),
      envText: JSON.stringify(doc.env && typeof doc.env === 'object' ? doc.env : {}, null, 2),
      headersText: JSON.stringify(doc.headers && typeof doc.headers === 'object' ? doc.headers : {}, null, 2),
      rawJson: JSON.stringify(doc, null, 2),
    };
  }

  function switchEditMode(mode) {
    setEditServer(prev => {
      if (!prev || prev.editMode === mode) return prev;
      if (mode === 'json') {
        return { ...prev, editMode: 'json', rawJson: buildEditRawJson(prev) };
      }
      // json → form：先解析再切回
      try {
        return { ...applyRawJsonToForm(prev, prev.rawJson), editMode: 'form' };
      } catch (e) {
        alert(t('providers.mcp.rawJsonInvalidSwitch', { msg: e.message }));
        return prev;
      }
    });
  }

  async function saveEditServer() {
    if (!editServer) return;

    let form = editServer;
    if (editServer.editMode === 'json') {
      try {
        form = { ...applyRawJsonToForm(editServer, editServer.rawJson), editMode: 'json' };
      } catch (e) {
        alert(t('providers.mcp.rawJsonInvalid', { msg: e.message }));
        return;
      }
    }

    let env = {};
    let headers = {};
    try {
      env = form.envText.trim() ? JSON.parse(form.envText) : {};
      if (!env || typeof env !== 'object' || Array.isArray(env)) {
        alert(t('providers.mcp.envObjectRequired'));
        return;
      }
    } catch (e) {
      alert(t('providers.mcp.envJsonInvalid', { msg: e.message }));
      return;
    }
    try {
      headers = form.headersText.trim() ? JSON.parse(form.headersText) : {};
      if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
        alert(t('providers.mcp.headersObjectRequired'));
        return;
      }
    } catch (e) {
      alert(t('providers.mcp.headersJsonInvalid', { msg: e.message }));
      return;
    }

    const isUrl = form.type === 'sse' || form.type === 'http';
    if (!form.name.trim()) {
      alert(t('providers.mcp.nameRequired'));
      return;
    }
    if (isUrl && !form.url.trim()) {
      alert(t('providers.mcp.urlRequired'));
      return;
    }
    if (!isUrl && !form.command.trim()) {
      alert(t('providers.mcp.commandRequired'));
      return;
    }

    const metadata = {
      ...form.metadata,
      description: form.description.trim(),
    };
    if (Object.keys(headers).length) metadata.headers = headers;
    else delete metadata.headers;

    setBusy(form.id);
    try {
      const res = await window.electronAPI.mcp.saveServer({
        id: form.id,
        name: form.name.trim(),
        display_name: form.display_name.trim() || form.name.trim(),
        type: form.type,
        command: isUrl ? '' : form.command.trim(),
        args: isUrl ? [] : form.args.split(/\s+/).filter(Boolean),
        url: isUrl ? form.url.trim() : null,
        env,
        metadata,
        skipAutoSync: !form.syncToAgents,
        syncInstalled: !!form.syncToAgents,
      });
      if (!res.success) {
        alert(res.error || t('providers.mcp.saveFailed'));
        return;
      }
      const synced = (res.sync?.results || []).filter(r => r.success).map(r => r.label || r.clientId);
      if (form.syncToAgents && synced.length) {
        const hitWb = (res.sync?.results || []).some(
          (r) => r.success && String(r.clientId || r.label || '').toLowerCase().includes('workbuddy'),
        );
        const msg = t('providers.mcp.savedSynced', { agents: synced.join('、') });
        alert(hitWb ? `${msg}\n${t('providers.mcp.workbuddyTrustHint')}` : msg);
      } else if (form.syncToAgents && !synced.length) {
        alert(t('providers.mcp.savedNoAgents'));
      }
      setEditServer(null);
      loadAll();
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy('');
    }
  }

  function matchFilter(item) {
    if (!effQuery.trim()) return true;
    const q = effQuery.trim().toLowerCase();
    const tags = item.metadata?.tags || [];
    const hay = [
      item.display_name,
      item.name,
      item.description,
      localizeCatalogDesc(item, t),
      item.metadata?.package,
      ...tags,
      ...tags.map(tag => localizeCatalogTag(tag, t)),
      ...(item.metadata?.tools || []),
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q);
  }

  const filteredGroups = catalogGroups
    .map(g => ({ ...g, items: g.items.filter(matchFilter) }))
    .filter(g => g.items.length > 0);

  const totalCatalogCount = catalog.length;
  const managedCount = servers.length;

  // 应用筛选：严格对齐 Gateway「应用」页 — 仅「已纳管 / 在线」
  // Claude Desktop 与 Claude Code 复用 MCP，筛选不单独展示 Desktop
  const filterAppItems = (() => {
    const items = [];
    const seen = new Set();
    for (const app of gatewayApps) {
      if (!isGatewayAppManaged(app)) continue;
      const isApi = app.link_method === 'manual';
      const id = isApi ? app.id : (app.agent_id || app.preset_id || app.id);
      if (!id || seen.has(id)) continue;
      if (!isApi && MCP_PROJECT_LIST_HIDDEN.has(id)) continue;
      seen.add(id);
      items.push({
        id,
        label: app.name || id,
        kind: isApi ? 'api-app' : 'agent',
        appId: app.id,
      });
    }
    return items;
  })();
  const activeAgent = filterAppItems.find(a => a.id === agentTab) || null;

  // 按应用筛选：Agent → 已投射或已中转；API 应用 → 仅已中转绑定
  const serverMatchesQuery = (s) => {
    const q = effQuery.trim().toLowerCase();
    if (!q) return true;
    return [s.display_name, s.name, s.metadata?.description, ...(s.metadata?.tools || [])]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  };
  const filteredManagedServers = (() => {
    if (!agentTab) return servers.filter(serverMatchesQuery);
    const isApiTab = activeAgent?.kind === 'api-app'
      || gatewayApiApps.some((a) => a.id === agentTab)
      || (gatewayInfo?.apiApps || []).some((a) => a.id === agentTab)
      || String(agentTab).startsWith('app-');
    // 同时匹配 agent 目标 id、别名（codex↔codex-desktop）与 Gateway app.id
    const matchIds = expandClientMatchIds(agentTab);
    if (activeAgent?.appId) matchIds.add(activeAgent.appId);
    if (isApiTab) {
      return servers.filter((s) => (s.gateway_clients || []).some((id) => matchIds.has(id))).filter(serverMatchesQuery);
    }
    return servers.filter(serverMatchesQuery).filter((s) => {
      const onAgent = (s.clientTargets || []).some((c) => matchIds.has(c.id) && c.installed);
      const onGateway = (s.gateway_clients || []).some((id) => matchIds.has(id));
      const onSync = (s.sync_clients || []).some((id) => matchIds.has(id));
      return onAgent || onGateway || onSync;
    });
  })();

  function selectMcpViewTab(tab) {
    setMcpViewTab(tab);
    saveMcpViewTab(tab);
  }

  function selectAgentTab(id) {
    setAgentTab(id);
    saveMcpAgentTab(id);
  }

  function renderMcpSourceBadge(source) {
    const styles = {
      tb_sync: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      tb_scanned: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
      client: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
    };
    const labels = {
      tb_sync: t('providers.mcp.sourceTb'),
      tb_scanned: t('providers.mcp.sourceClient'),
      client: t('providers.mcp.sourceClient'),
    };
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${styles[source] || styles.client}`}>
        {labels[source] || labels.client}
      </span>
    );
  }

  /** 已纳管 MCP：用 tag 区分「通过 TB 安装」与「客户端自配」（扫描纳管） */
  function managedOriginSource(server) {
    if (server?.builtin) return null;
    if (server?.metadata?.origin === 'client_scan' || server?.metadata?.category === 'imported') {
      return 'client';
    }
    return 'tb_sync';
  }

  /** 应用筛选：与资产库同款下拉 */
  function renderAppFilterMenu() {
    if (filterAppItems.length === 0) return null;
    return (
      <FilterMenu
        label={t('resources.filter.app')}
        value={agentTab}
        allLabel={t('resources.appFilterAll')}
        onChange={selectAgentTab}
        options={filterAppItems.map(o => ({
          value: o.id,
          label: o.kind === 'api-app' ? `${o.label} · ${t('providers.mcp.gatewayApiAppTag')}` : o.label,
          icon: <ServiceIcon id={o.id} name={o.label} boxClass="w-4 h-4" imgClass="w-2.5 h-2.5" className="!rounded" />,
        }))}
      />
    );
  }

  function serverStatusDot(s) {
    return s.status === 'active' ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600';
  }

  function serverDesc(s) {
    return localizeCatalogDesc({
      catalogId: s.name || s.id,
      id: s.id,
      name: s.name,
      description: s.metadata?.description || s.metadata?.category || s.type,
    }, t);
  }

  function serverMenuItems(s) {
    return [
      !s.builtin && { key: 'edit', label: t('resources.edit'), disabled: !!busy, onClick: () => openEditServer(s) },
      !s.builtin && { key: 'uninstall', label: t('providers.mcp.uninstall'), danger: true, disabled: !!busy, onClick: () => handleUninstall(s) },
    ].filter(Boolean);
  }

  function canRelay(s) {
    return s.builtin ? isTbBuiltinRelayMcp(s) : canRouteViaGateway(s);
  }

  function renderServerActions(s, { block = false } = {}) {
    const active = s.status === 'active';
    if (!active || (!s.builtin && !canRelay(s) && !serverHasDiskProjection(s))) return null;
    return (
      <button
        type="button"
        data-row-install-btn
        disabled={!!busy || addTargets().length === 0}
        onClick={(e) => openAddMenu(s, e.currentTarget)}
        className={`${ASSET_BTN_PRIMARY} ${block ? 'w-full' : '!px-2.5 !py-1 !text-[11px] !rounded-lg'}`}
      >
        {busy === s.id ? t('providers.mcp.processing') : (block ? t('resources.project') : t('resources.projectShort'))}
      </button>
    );
  }

  /** 已接入的应用（写入配置 + 经网关，去重；不含内部「通用」档） */
  function connectedApps(server) {
    const out = [];
    const seen = new Set();
    for (const tg of addTargets()) {
      const how = connectionOf(server, tg.id);
      if (!how || seen.has(tg.id)) continue;
      seen.add(tg.id);
      out.push({ id: tg.id, label: tg.label, how });
    }
    return out;
  }

  function renderManagedListRow(s) {
    const key = `m:${s.id}`;
    const sel = selectedKey === key;
    const canSelect = s.status === 'active';
    const checked = selectedServerIds.includes(s.id);
    const origin = managedOriginSource(s);
    const menu = serverMenuItems(s);
    return (
      <li
        key={s.id}
        role="option"
        aria-selected={sel}
        onClick={() => setSelectedKey(sel ? null : key)}
        className={`${libRowCls(sel)} ${MCP_GRID}`}
      >
        <span className="w-4 flex justify-center" onClick={e => e.stopPropagation()}>
          {canSelect && (
            <input
              type="checkbox"
              checked={checked}
              disabled={!!busy}
              onChange={() => toggleServerSelected(s.id)}
              className="rounded border-zinc-300 dark:border-zinc-600"
              title={t('providers.mcp.checkToInstall')}
            />
          )}
        </span>
        <LibraryRowTitle
          logo={<McpLogo icon={s.metadata?.icon} />}
          name={s.display_name || s.name}
          sub={serverDesc(s)}
          chips={(
            <>
              <span className="shrink-0 text-[10px] px-1.5 py-px rounded font-medium bg-teal-50/80 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300">MCP</span>
              {s.builtin && <span className="shrink-0 text-[10px] text-sky-600 dark:text-sky-300">{t('providers.mcp.builtin')}</span>}
              {origin && <span className="shrink-0">{renderMcpSourceBadge(origin)}</span>}
            </>
          )}
        />
        <div className="hidden md:flex items-center gap-1.5 min-w-0">
          <AppIconStack apps={connectedApps(s)} emptyLabel="—" />
        </div>
        <span className="hidden md:block text-[11px] text-zinc-500">{isMcpUrlServer(s) ? t('providers.mcp.typeUrl') : t('providers.mcp.typeCli')}</span>
        <span className="hidden md:flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
          <span className={`w-1.5 h-1.5 rounded-full ${serverStatusDot(s)}`} aria-hidden />
          {s.status === 'active' ? t('providers.mcp.enabled') : t('providers.mcp.disabled')}
        </span>
        <div
          className={`flex items-center justify-end gap-1.5 transition-opacity ${sel ? '' : 'md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100'}`}
          onClick={e => e.stopPropagation()}
        >
          {renderServerActions(s)}
          {menu.length > 0 && <AssetMoreMenu label={t('resources.moreActions')} items={menu} />}
        </div>
      </li>
    );
  }

  function renderServerInspector(s) {
    const tools = s.metadata?.tools || [];
    const apps = connectedApps(s);
    const menu = serverMenuItems(s);
    const origin = managedOriginSource(s);
    return (
      <LibraryInspector
        logo={<McpLogo icon={s.metadata?.icon} />}
        title={s.display_name || s.name}
        closeLabel={t('resources.collapse')}
        onClose={() => setSelectedKey(null)}
        chips={(
          <>
            <span className="text-[10px] px-1.5 py-px rounded font-medium bg-teal-50/80 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300">MCP</span>
            <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
              <span className={`w-1.5 h-1.5 rounded-full ${serverStatusDot(s)}`} aria-hidden />
              {s.status === 'active' ? t('providers.mcp.enabled') : t('providers.mcp.disabled')}
            </span>
            <span className="text-[10px] text-zinc-400">{isMcpUrlServer(s) ? t('providers.mcp.typeUrl') : t('providers.mcp.typeCli')}</span>
            {s.builtin && <span className="text-[10px] text-sky-600 dark:text-sky-300">{t('providers.mcp.builtin')}</span>}
            {origin && renderMcpSourceBadge(origin)}
          </>
        )}
        desc={serverDesc(s)}
        stats={[
          [t('resources.mcp.toolCount'), tools.length],
          [t('resources.col.apps'), apps.length],
        ]}
        footer={menu.length > 0 ? (
          <>
            {menu.filter(m => !m.danger).map(m => (
              <button key={m.key} type="button" disabled={m.disabled} onClick={m.onClick} className={ASSET_BTN_GHOST}>{m.label}</button>
            ))}
            {menu.filter(m => m.danger).map(m => (
              <button key={m.key} type="button" disabled={m.disabled} onClick={m.onClick}
                className="ml-auto text-xs px-3 py-1.5 rounded-xl text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-45">{m.label}</button>
            ))}
          </>
        ) : null}
      >
        <InspectorSection title={t('resources.col.apps')}>
            <div className="space-y-2">
              {apps.length === 0 ? (
                <p className="text-[11px] text-zinc-400">{t('resources.mcp.notAdded')}</p>
              ) : (
                <ul className="space-y-1">
                  {apps.map((a) => (
                    <li key={a.id} className="text-xs">
                      <div className="flex items-center gap-2">
                        <ServiceIcon id={a.id} name={a.label} boxClass="w-5 h-5" imgClass="w-3 h-3" className="!rounded-md" />
                        <span className="flex-1 truncate text-zinc-700 dark:text-zinc-200">{a.label}</span>
                        {s.builtin ? (
                          <span className="text-[10px] text-sky-600 dark:text-sky-300" title={t('resources.mcp.builtinLockedHint')}>
                            {t('resources.mcp.builtinLocked')}
                          </span>
                        ) : a.how === 'project' && (
                          <span className="text-[10px] text-zinc-400" title={t('resources.mcp.legacyConfigHint')}>
                            {t('resources.mcp.legacyConfig')}
                          </span>
                        )}
                      </div>
                      {a.how === 'relay' && (
                        gatewayApiApps.some((x) => x.id === a.id) || !relayUsableViaBuiltin(a.id)
                          ? <div className="pl-7">{renderRelayUrl(a.id)}</div>
                          : <p className="pl-7 text-[10px] text-zinc-400">{t('resources.mcp.viaBuiltinNote')}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[10px] text-zinc-400 leading-relaxed">
                {s.builtin ? t('resources.mcp.builtinLockedHint') : t('resources.mcp.accessHint')}
              </p>
              {renderServerActions(s, { block: true })}
            </div>
          </InspectorSection>
        {tools.length > 0 && (
          <InspectorSection title={t('resources.mcp.tools', { n: tools.length })}>
            <div className="flex flex-wrap gap-1">
              {tools.map(tool => (
                <span key={tool} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{tool}</span>
              ))}
            </div>
          </InspectorSection>
        )}
        {(s.command || s.url) && (
          <InspectorSection title={t('resources.mcp.launch')}>
            <code className="block text-[11px] font-mono text-zinc-500 break-all">
              {s.url || [s.command, ...(Array.isArray(s.args) ? s.args : [])].join(' ')}
            </code>
          </InspectorSection>
        )}
      </LibraryInspector>
    );
  }

  /** 应用配置里的 TokenBank 中转条目（扫描导入的 url 指向本网关）：属基础设施，不作为普通 MCP 列出 */
  function isRelaySelfServer(s) {
    const url = String(s?.url || s?.metadata?.url || '');
    const base = relayBase();
    if (base && url.startsWith(`${base}/mcp`)) return true;
    return String(s?.name || '') === 'tokenbank-relay';
  }

  /** 内置工具：模型 / 资源为每个应用的必备项；提示词按需下发（有提示词投射时） */
  const BUILTIN_REQUIRED_IDS = ['tokenbank-models', 'tokenbank-resources'];
  function builtinRequiredServers() {
    return servers.filter((s) => BUILTIN_REQUIRED_IDS.includes(s.id) && s.status === 'active');
  }

  /** 已在配置里接入中转网关的应用（桌面 / CLI） */
  function relayConnectedIds() {
    const set = new Set();
    for (const s of servers) {
      if (!isRelaySelfServer(s)) continue;
      for (const id of getInstalledAgentIds(s)) set.add(id);
    }
    return set;
  }

  /**
   * 接入状态：
   * - 桌面 / CLI：内置 Resources 写入后即可经 tb_call_mcp 调用中转 MCP（relayVia=builtin），
   *   配置里另有 tokenbank-relay 条目则为原生接入（relayVia=native）；就绪只看内置工具。
   * - API 应用：无法写配置、无内置工具，需在应用侧手动配置一次中转地址（状态无法探测）。
   */
  function appSetupStatus(tg, relaySet) {
    if (tg.kind === 'api-app') return { api: true, builtinOk: null, relayVia: null, ready: null };
    const builtins = builtinRequiredServers();
    const builtinOk = builtins.length > 0 && builtins.every((b) => getInstalledAgentIds(b).includes(tg.id));
    const resourcesOk = servers.some((b) => b.id === 'tokenbank-resources' && getInstalledAgentIds(b).includes(tg.id));
    const relayVia = relaySet.has(tg.id) ? 'native' : (resourcesOk ? 'builtin' : null);
    return { api: false, builtinOk, relayVia, ready: builtinOk };
  }

  /** 桌面 / CLI 是否已可经内置工具使用中转 MCP */
  function relayUsableViaBuiltin(appId) {
    return servers.some((b) => b.id === 'tokenbank-resources' && getInstalledAgentIds(b).includes(appId));
  }

  /** 一键为某应用写入内置工具（模型 / 资源） */
  async function setupBuiltinsFor(tg) {
    if (!tg.agent?.syncClientId) return;
    setBusy(`setup-${tg.id}`);
    setSyncMsg('');
    try {
      for (const b of builtinRequiredServers()) {
        const previously = getInstalledAgentIds(b);
        if (previously.includes(tg.id)) continue;
        const keep = previously.map((id) => syncWritableAgents.find((a) => a.id === id)?.syncClientId || id);
        const selected = [...new Set([...keep, tg.agent.syncClientId])];
        const res = await window.electronAPI.mcp.setServerSyncClients({
          serverId: b.id,
          clientIds: selected,
          syncClientIds: [...new Set([...previously, ...selected])],
        });
        if (!res?.success) throw new Error(res?.error || t('providers.mcp.installFailed'));
      }
      await loadAll({ silent: true });
      setSyncMsg(t('resources.mcp.builtinDone', { app: tg.label }));
    } catch (e) {
      setSyncMsg(e.message);
    } finally {
      setBusy('');
    }
  }

  /** 复制中转接入：Claude Code 给一条命令，其它应用给 JSON */
  async function copyRelaySetup(tg) {
    const url = relayUrlFor(tg.id);
    const token = gatewayInfo?.endpoint?.token;
    if (tg.id === 'claude-code' && url && token) {
      try {
        await navigator.clipboard.writeText(`claude mcp add --transport http tokenbank-relay ${url} --header "Authorization: Bearer ${token}"`);
        setSyncMsg(t('resources.mcp.relayCmdCopied'));
      } catch {
        alert(t('providers.mcp.gatewayCopyFailed'));
      }
      return;
    }
    await copyRelayConfigFor(tg.id);
  }

  /** 置顶：TokenBank 内置（默认基础设施）+ 各应用接入引导 */
  function renderBuiltinCard() {
    const relaySet = relayConnectedIds();
    const targets = addTargets();
    const rows = targets.map((tg) => ({ tg, st: appSetupStatus(tg, relaySet) }));
    const agentRows = rows.filter((r) => !r.st.api);
    const readyN = agentRows.filter((r) => r.st.ready).length;
    const allReady = agentRows.length > 0 && readyN === agentRows.length;
    const open = builtinCardOpen ?? !allReady;
    const builtins = servers.filter((s) => s.builtin);
    const pill = (ok, label) => (ok == null ? (
      <span className="text-[10px] text-zinc-300 dark:text-zinc-600">—</span>
    ) : (
      <span className={`inline-flex items-center gap-1 text-[10px] ${ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
        <span aria-hidden>{ok ? '✓' : '!'}</span>{label}
      </span>
    ));
    return (
      <div className={LIB_LIST_CLS}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
          <span className="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/40 flex items-center justify-center" aria-hidden>🏦</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[13px] font-semibold text-zinc-900 dark:text-zinc-50">{t('resources.mcp.builtinTitle')}</h3>
              <span className="text-[10px] px-1.5 py-px rounded bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300">{t('resources.mcp.builtinDefault')}</span>
              <span className="inline-flex items-center gap-1 text-[11px] text-zinc-500">
                <span className={`w-1.5 h-1.5 rounded-full ${gatewayInfo?.running ? 'bg-emerald-500' : 'bg-zinc-300'}`} aria-hidden />
                {gatewayInfo?.running ? t('providers.mcp.gatewayRunning') : t('providers.mcp.gatewayStopped')}
              </span>
            </div>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">{t('resources.mcp.builtinDesc')}</p>
          </div>
          <span className={`text-[11px] ${allReady ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
            {t('resources.mcp.readyCount', { n: readyN, total: agentRows.length })}
          </span>
          <button type="button" onClick={() => setBuiltinCardOpen(!open)} className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline">
            {open ? t('resources.collapse') : t('resources.mcp.setupExpand')}
          </button>
        </div>
        {open && (
          <>
            <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3 -mt-1">
              <span className="text-[10px] text-zinc-400 mr-1">{t('resources.mcp.builtinTools')}</span>
              {builtins.map((b) => (
                <button key={b.id} type="button" onClick={() => setSelectedKey(`m:${b.id}`)}
                  className={`text-[11px] px-2 py-0.5 rounded-md border transition-colors ${
                    selectedKey === `m:${b.id}`
                      ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
                      : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800'
                  }`}>
                  {(b.display_name || b.name).replace(/^Token Bank\s*/i, '')}
                </button>
              ))}
            </div>
            <ul className="border-t border-zinc-100 dark:border-white/[0.05]">
              {rows.length === 0 && <li className="px-4 py-3 text-[11px] text-zinc-400">{t('providers.mcp.noAgents')}</li>}
              {rows.map(({ tg, st }) => {
                const nativeOpen = nativeOpenIds.includes(tg.id);
                return (
                <li
                  key={tg.id}
                  role="option"
                  aria-selected={selectedKey === `app:${tg.id}`}
                  onClick={() => setSelectedKey(selectedKey === `app:${tg.id}` ? null : `app:${tg.id}`)}
                  title={t('resources.mcp.appDetailHint')}
                  className={`px-4 py-2 border-b last:border-b-0 border-zinc-100/90 dark:border-white/[0.05] cursor-pointer transition-colors ${
                    selectedKey === `app:${tg.id}` ? 'bg-blue-50/80 dark:bg-blue-950/30' : 'hover:bg-zinc-50/80 dark:hover:bg-white/[0.03]'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <ServiceIcon id={tg.id} name={tg.label} boxClass="w-6 h-6" imgClass="w-3.5 h-3.5" className="!rounded-md" />
                    <span className="text-xs text-zinc-800 dark:text-zinc-100 min-w-[6rem]">{tg.label}</span>
                    {st.api ? (
                      <span className="text-[10px] text-zinc-500">{t('resources.mcp.apiNeedsSetup')}</span>
                    ) : (
                      <>
                        {pill(st.builtinOk, t('resources.mcp.builtinTools'))}
                        {st.relayVia
                          ? pill(true, st.relayVia === 'native' ? t('resources.mcp.relayNative') : t('resources.mcp.relayViaBuiltin'))
                          : pill(false, t('resources.mcp.gateway'))}
                      </>
                    )}
                    <div className="ml-auto flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      {st.builtinOk === false && (
                        <button type="button" disabled={!!busy} onClick={() => setupBuiltinsFor(tg)}
                          className="tb-press text-[11px] px-2.5 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-45">
                          {busy === `setup-${tg.id}` ? t('providers.mcp.processing') : t('resources.mcp.setupBuiltin')}
                        </button>
                      )}
                      {st.api && (
                        <button type="button" onClick={() => copyRelaySetup(tg)}
                          className="text-[11px] px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800">
                          {t('resources.mcp.copyRelay')}
                        </button>
                      )}
                      {!st.api && st.relayVia !== 'native' && (
                        <button type="button"
                          onClick={() => setNativeOpenIds((prev) => (prev.includes(tg.id) ? prev.filter((x) => x !== tg.id) : [...prev, tg.id]))}
                          title={t('resources.mcp.nativeHint')}
                          className="text-[11px] text-zinc-400 hover:text-blue-600 dark:hover:text-blue-400">
                          {t('resources.mcp.enableNative')} {nativeOpen ? '▴' : '▾'}
                        </button>
                      )}
                    </div>
                  </div>
                  {(st.api || nativeOpen) && (
                    <div className="pl-9 mt-1 space-y-1" onClick={(e) => e.stopPropagation()}>
                      <p className="text-[10px] text-zinc-400">
                        {st.api
                          ? t('resources.mcp.guideApi')
                          : `${t('resources.mcp.nativeHint')} ${tg.id === 'claude-code' ? t('resources.mcp.guideClaude') : t('resources.mcp.guideJson')}`}
                      </p>
                      {renderRelayUrl(tg.id, { compact: true, copy: false })}
                      {!st.api && (
                        <button type="button" onClick={() => copyRelaySetup(tg)}
                          className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline">
                          {tg.id === 'claude-code' ? t('resources.mcp.copyCmd') : t('resources.mcp.copyRelay')}
                        </button>
                      )}
                    </div>
                  )}
                </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    );
  }

  /** 应用接入详情：配置文件、内置工具、中转（地址 / 鉴权 / 可复制配置）、投射的 MCP */
  function renderAppInspector(tg) {
    const st = appSetupStatus(tg, relayConnectedIds());
    const target = (syncStatus?.targets || []).find((x) => x.id === (tg.agent?.syncClientId || tg.id))
      || (syncStatus?.targets || []).find((x) => x.id === tg.id);
    const url = relayUrlFor(tg.id);
    const token = gatewayInfo?.endpoint?.token || '';
    const shownToken = showRelayToken ? token : (token ? `${token.slice(0, 4)}${'•'.repeat(12)}` : '');
    const cfg = url ? {
      mcpServers: { 'tokenbank-relay': { url, headers: { Authorization: `Bearer ${shownToken}` } } },
    } : null;
    const cmd = url ? `claude mcp add --transport http tokenbank-relay ${url} --header "Authorization: Bearer ${shownToken}"` : '';
    const builtins = servers.filter((b) => b.builtin);
    const projected = servers
      .filter((x) => !x.builtin && !isRelaySelfServer(x))
      .map((x) => ({ s: x, how: connectionOf(x, tg.id) }))
      .filter((x) => x.how);
    const tbKeys = new Set(['tokenbank-relay', ...builtins.flatMap((b) => [b.name, b.id, `tb-${b.name}`, `tb-${b.id}`])]);
    const otherKeys = (target?.scannedKeys || []).filter((k) => !tbKeys.has(k));
    const copy = async (text, doneMsg) => {
      try { await navigator.clipboard.writeText(text); setSyncMsg(doneMsg); } catch { alert(t('providers.mcp.gatewayCopyFailed')); }
    };
    const relayLabel = st.api
      ? t('resources.mcp.apiNeedsSetup')
      : st.relayVia === 'native' ? t('resources.mcp.relayNative')
        : st.relayVia === 'builtin' ? t('resources.mcp.relayViaBuiltin') : t('resources.mcp.relayMissing');
    return (
      <LibraryInspector
        logo={<ServiceIcon id={tg.id} name={tg.label} boxClass="w-9 h-9" imgClass="w-5 h-5" className="!rounded-xl" />}
        title={tg.label}
        closeLabel={t('resources.collapse')}
        onClose={() => setSelectedKey(null)}
        chips={(
          <span className={`text-[10px] px-1.5 py-px rounded ${
            st.api ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
              : st.ready ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300'
                : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
          }`}>
            {st.api ? t('resources.mcp.apiApp') : st.ready ? t('resources.mcp.appReady') : t('resources.mcp.appNotReady')}
          </span>
        )}
        stats={st.api ? null : [
          [t('resources.mcp.configMcpCount'), target?.count ?? '—'],
          [t('resources.mcp.projectedCount'), projected.length],
          [t('resources.mcp.lastSync'), target?.lastSync ? new Date(target.lastSync).toLocaleString() : '—'],
        ]}
      >
        {!st.api && target?.path && (
          <InspectorSection title={t('resources.mcp.configFile')}>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 break-all text-[11px] font-mono text-zinc-600 dark:text-zinc-300 select-all">{target.path}</code>
              <button type="button" onClick={() => copy(target.path, t('resources.mcp.copied'))}
                className="shrink-0 text-[10px] text-blue-600 dark:text-blue-400 hover:underline">{t('resources.mcp.copy')}</button>
            </div>
            {!target.exists && <p className="text-[10px] text-amber-600 mt-1">{t('resources.mcp.configMissing')}</p>}
          </InspectorSection>
        )}
        {!st.api && (
          <InspectorSection title={t('resources.mcp.builtinTools')}>
            <ul className="space-y-1">
              {builtins.map((b) => {
                const ok = getInstalledAgentIds(b).includes(tg.id);
                return (
                  <li key={b.id} className="flex items-center gap-2 text-xs">
                    <span className={ok ? 'text-emerald-600' : 'text-zinc-300'}>{ok ? '✓' : '○'}</span>
                    <span className="flex-1 text-zinc-700 dark:text-zinc-200">{b.display_name || b.name}</span>
                    <code className="text-[10px] font-mono text-zinc-400">{b.name}</code>
                  </li>
                );
              })}
            </ul>
            {renderBuiltinMissingNote(st)}
            {st.builtinOk === false && (
              <button type="button" disabled={!!busy} onClick={() => setupBuiltinsFor(tg)} className={`${ASSET_BTN_PRIMARY} w-full mt-2`}>
                {busy === `setup-${tg.id}` ? t('providers.mcp.processing') : t('resources.mcp.setupBuiltin')}
              </button>
            )}
          </InspectorSection>
        )}
        <InspectorSection title={t('resources.mcp.gateway')}>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-zinc-500">{t('resources.mcp.relayMode')}</span>
              <span className="text-zinc-800 dark:text-zinc-100">{relayLabel}</span>
            </div>
            <div className="text-xs">
              <div className="text-zinc-500 mb-0.5">{t('resources.mcp.relayUrl')}</div>
              {renderRelayUrl(tg.id, { compact: true, copy: false })}
            </div>
            {token && (
              <div className="text-xs">
                <div className="flex items-center justify-between text-zinc-500 mb-0.5">
                  <span>{t('resources.mcp.authHeader')}</span>
                  <button type="button" onClick={() => setShowRelayToken((v) => !v)} className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline">
                    {showRelayToken ? t('resources.mcp.hideToken') : t('resources.mcp.showToken')}
                  </button>
                </div>
                <code className="block break-all text-[10px] font-mono text-zinc-600 dark:text-zinc-300">Authorization: Bearer {shownToken}</code>
              </div>
            )}
            {cfg && (
              <div className="text-xs">
                <div className="flex items-center justify-between text-zinc-500 mb-0.5">
                  <span>{t('resources.mcp.configJson')}</span>
                  <button type="button" onClick={() => copyRelayConfigFor(tg.id)} className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline">{t('resources.mcp.copy')}</button>
                </div>
                <InspectorPreview text={JSON.stringify(cfg, null, 2)} />
              </div>
            )}
            {tg.id === 'claude-code' && cmd && (
              <div className="text-xs">
                <div className="flex items-center justify-between text-zinc-500 mb-0.5">
                  <span>{t('resources.mcp.cliCommand')}</span>
                  <button type="button" onClick={() => copyRelaySetup(tg)} className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline">{t('resources.mcp.copy')}</button>
                </div>
                <InspectorPreview text={cmd} />
              </div>
            )}
            <p className="text-[10px] text-zinc-400 leading-relaxed">
              {st.api ? t('resources.mcp.guideApi') : st.relayVia === 'native' ? t('resources.mcp.nativeActive') : `${t('resources.mcp.viaBuiltinNote')}。${t('resources.mcp.nativeHint')}`}
            </p>
          </div>
        </InspectorSection>
        <InspectorSection title={t('resources.mcp.projectedHere', { n: projected.length })}>
          {projected.length === 0 ? (
            <p className="text-[11px] text-zinc-400">{t('resources.mcp.noneProjected')}</p>
          ) : (
            <ul className="space-y-1">
              {projected.map(({ s: x, how }) => (
                <li key={x.id} className="flex items-center gap-2 text-xs">
                  <button type="button" onClick={() => setSelectedKey(`m:${x.id}`)} className="flex-1 text-left truncate text-zinc-700 dark:text-zinc-200 hover:text-blue-600">
                    {x.display_name || x.name}
                  </button>
                  <span className="text-[10px] text-zinc-400">{how === 'project' ? t('resources.mcp.legacyConfig') : t('resources.mcp.viaRelayShort')}</span>
                </li>
              ))}
            </ul>
          )}
        </InspectorSection>
        {otherKeys.length > 0 && (
          <InspectorSection title={t('resources.mcp.otherInConfig', { n: otherKeys.length })}>
            <div className="flex flex-wrap gap-1">
              {otherKeys.map((k) => (
                <code key={k} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{k}</code>
              ))}
            </div>
          </InspectorSection>
        )}
      </LibraryInspector>
    );
  }

  function renderBuiltinMissingNote(st) {
    if (st.builtinOk !== false) return null;
    return <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1.5">{t('resources.mcp.builtinMissingNote')}</p>;
  }

  function renderManagedView() {
    const selected = selectedKey?.startsWith('m:') ? servers.find(x => `m:${x.id}` === selectedKey) : null;
    const selectedApp = selectedKey?.startsWith('app:') ? addTargets().find((tg) => `app:${tg.id}` === selectedKey) : null;
    const listServers = filteredManagedServers.filter((s) => !s.builtin && !isRelaySelfServer(s));
    return (
      <>
        {renderBuiltinCard()}
        {syncMsg && (
          <p className="text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-line rounded-lg bg-blue-50/70 dark:bg-blue-950/30 px-3 py-2">{syncMsg}</p>
        )}
        <div className="flex gap-4 items-start">
          <div className="flex-1 min-w-0 space-y-3">
            <LibrarySectionHead title={t('resources.mcp.thirdParty')} count={listServers.length} />
            {listServers.length === 0 ? (
              <div className={`${LIB_LIST_CLS} p-6 text-center space-y-2`}>
                <p className="text-xs text-zinc-400">
                  {agentTab && activeAgent
                    ? t('providers.mcp.noManagedOnAgent', { agent: activeAgent.label })
                    : t('providers.mcp.noManaged')}
                </p>
                {agentTab ? (
                  <button type="button" onClick={() => selectAgentTab('')} className="text-xs text-blue-600 hover:underline">
                    {t('resources.clearAppFilter')}
                  </button>
                ) : !controlledView && (
                  <button type="button" onClick={() => selectMcpViewTab('catalog')} className="text-xs text-blue-600 hover:underline">
                    {t('providers.mcp.goCatalog')}
                  </button>
                )}
              </div>
            ) : (
              <div className={LIB_LIST_CLS}>
                <div className={`hidden md:grid ${MCP_HEAD_GRID} gap-3 px-4 py-2 text-[11px] text-zinc-400 border-b border-zinc-100 dark:border-white/[0.05]`}>
                  <span className="w-4 flex justify-center">
                    {syncSelectableServers.length > 0 && (
                      <input
                        type="checkbox"
                        checked={allSyncSelectableChecked}
                        onChange={toggleSelectAllServers}
                        title={t('providers.mcp.selectAll')}
                        className="rounded border-zinc-300 dark:border-zinc-600"
                      />
                    )}
                  </span>
                  <span>{t('resources.col.name')}</span>
                  <span>{t('resources.col.apps')}</span>
                  <span>{t('resources.mcp.kind')}</span>
                  <span>{t('resources.col.status')}</span>
                  <span />
                </div>
                <ul role="listbox" aria-label="MCP">
                  {listServers.map(renderManagedListRow)}
                </ul>
              </div>
            )}
            <p className="text-[11px] text-zinc-400 px-1">{t('resources.mcp.accessHint')}</p>
          </div>
          {selected && renderServerInspector(selected)}
          {selectedApp && renderAppInspector(selectedApp)}
        </div>
      </>
    );
  }

  function renderCatalogListRow(item) {
    const key = `c:${item.catalogId}`;
    const sel = selectedKey === key;
    return (
      <li
        key={item.catalogId}
        role="option"
        aria-selected={sel}
        onClick={() => setSelectedKey(sel ? null : key)}
        className={`${libRowCls(sel)} grid-cols-[minmax(0,1fr)_auto]`}
      >
        <LibraryRowTitle
          logo={<McpLogo icon={item.metadata?.icon} />}
          name={item.display_name}
          sub={localizeCatalogDesc(item, t)}
          chips={(item.metadata?.tags || []).slice(0, 2).map(tag => (
            <span key={tag} className="shrink-0 text-[10px] px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">{localizeCatalogTag(tag, t)}</span>
          ))}
        />
        <div onClick={e => e.stopPropagation()}>{renderCatalogAction(item)}</div>
      </li>
    );
  }

  function renderCatalogAction(item, block = false) {
    if (item.alwaysInstalled) {
      return <span className="text-[11px] text-sky-600 dark:text-sky-300">{t('providers.mcp.builtin')}</span>;
    }
    return (
      <button
        type="button"
        disabled={!!busy || item.installed}
        onClick={() => handleInstall(item)}
        className={`${item.installed ? ASSET_BTN_MANAGED : ASSET_BTN_PRIMARY} ${block ? 'w-full' : '!px-3 !py-1 !text-[11px] !rounded-lg'}`}
      >
        {item.installed ? t('providers.mcp.managedTag') : busy === item.catalogId ? t('providers.mcp.importing') : t('providers.mcp.oneClickImport')}
      </button>
    );
  }

  function renderCatalogInspector(item) {
    const tools = item.metadata?.tools || [];
    return (
      <LibraryInspector
        logo={<McpLogo icon={item.metadata?.icon} />}
        title={item.display_name}
        closeLabel={t('resources.collapse')}
        onClose={() => setSelectedKey(null)}
        chips={(item.metadata?.tags || []).map(tag => (
          <span key={tag} className="text-[10px] px-1.5 py-px rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500">{localizeCatalogTag(tag, t)}</span>
        ))}
        desc={localizeCatalogDesc(item, t)}
        stats={tools.length ? [[t('resources.mcp.toolCount'), tools.length]] : null}
        footer={renderCatalogAction(item, true)}
      >
        {tools.length > 0 && (
          <InspectorSection title={t('resources.mcp.tools', { n: tools.length })}>
            <div className="flex flex-wrap gap-1">
              {tools.map(tool => (
                <span key={tool} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">{tool}</span>
              ))}
            </div>
          </InspectorSection>
        )}
        {(item.metadata?.package || item.name) && (
          <InspectorSection title={t('resources.mcp.package')}>
            <code className="text-[11px] font-mono text-zinc-500 break-all">{item.metadata?.package || item.name}</code>
          </InspectorSection>
        )}
      </LibraryInspector>
    );
  }

  function renderCatalogView() {
    const selected = selectedKey?.startsWith('c:') ? catalog.find(x => `c:${x.catalogId}` === selectedKey) : null;
    return (
      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0 space-y-5">
          {filteredGroups.length === 0 ? (
            <div className={`${LIB_LIST_CLS} p-6 text-center text-xs text-zinc-400`}>{t('providers.mcp.noMatch')}</div>
          ) : filteredGroups.map(group => (
            <section key={group.id}>
              <LibrarySectionHead title={localizeGroupLabel(group, t)} count={group.items.length} />
              <ul className={LIB_LIST_CLS} role="listbox" aria-label={localizeGroupLabel(group, t)}>
                {group.items.map(renderCatalogListRow)}
              </ul>
            </section>
          ))}
        </div>
        {selected && renderCatalogInspector(selected)}
      </div>
    );
  }

  function renderMcpViewTabs() {
    const tabs = [
      { id: 'managed', label: t('providers.mcp.tab.managed'), count: managedCount },
      { id: 'catalog', label: t('providers.mcp.tab.catalog'), count: totalCatalogCount },
    ];
    return (
      <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-xs shrink-0">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => selectMcpViewTab(tab.id)}
            className={`px-3 py-1.5 whitespace-nowrap ${
              mcpViewTab === tab.id
                ? 'bg-violet-50 dark:bg-violet-900/30 font-medium text-violet-800 dark:text-violet-200'
                : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
            }`}
          >
            {tab.label}{tab.count != null ? ` (${tab.count})` : ''}
          </button>
        ))}
      </div>
    );
  }

  if (!window.electronAPI?.mcp) {
    return (
      <p className="text-sm text-zinc-400 py-8 text-center">{t('providers.mcp.desktopOnly')}</p>
    );
  }

  return (
    <div className="space-y-4">
      {renderAddMenu()}
      {loading ? (
        <p className="text-xs text-zinc-400 py-8 text-center">{t('providers.mcp.loading')}</p>
      ) : error ? (
        <p className="text-xs text-red-500 py-4">{error}</p>
      ) : (
        <>
          {/* 工具栏：应用筛选 / 批量操作 / 刷新（嵌入资源页的目录视图无需工具栏） */}
          {!(controlledView && effView === 'catalog') && (
          <div className="flex flex-wrap items-center gap-2">
            {!controlledView && renderMcpViewTabs()}
            {effView === 'managed' && renderAppFilterMenu()}
            {effView === 'managed' && renderSyncDropdown()}
            <div className="ml-auto flex items-center gap-2">
              {effView === 'catalog' && !controlledView && (
                <input
                  type="search"
                  value={catalogFilter}
                  onChange={e => setCatalogFilter(e.target.value)}
                  placeholder={t('providers.mcp.searchPlaceholder')}
                  className="tb-soft-field w-52 text-xs px-3 py-1.5 rounded-lg"
                />
              )}
              <button type="button" onClick={() => loadAll()} disabled={!!busy} className={`${ASSET_BTN_GHOST} !rounded-lg !px-3 !py-1`}>
                {t('providers.mcp.refresh')}
              </button>
              {effView === 'managed' && !controlledView && (
                <button type="button" onClick={() => setShowCustom(true)} className={`${ASSET_BTN_GHOST} !rounded-lg !px-3 !py-1`}>
                  {t('providers.mcp.customMcp')}
                </button>
              )}
            </div>
          </div>
          )}

          {effView === 'catalog' ? renderCatalogView() : renderManagedView()}
        </>
      )}

      {/* 弹窗挂 body：避开主栏 backdrop-filter 导致 fixed 错位 */}
      {installTarget && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">{t('providers.mcp.importTitle', { name: installTarget.display_name })}</h3>
            {(installTarget.configFields || []).map(field => (
              <div key={field.key}>
                <label className="text-xs text-zinc-500 block mb-1">{localizeFieldLabel(field, t)}</label>
                <input
                  type={field.type === 'secret' ? 'password' : 'text'}
                  value={installConfig[field.key] ?? ''}
                  onChange={e => setInstallConfig(c => ({ ...c, [field.key]: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
                  placeholder={field.placeholder || field.defaultValue || ''}
                />
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setInstallTarget(null)} className="text-xs px-3 py-1.5 rounded-lg border">{t('providers.mcp.cancel')}</button>
              <button type="button" onClick={confirmInstall} disabled={!!busy} className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white">{t('providers.mcp.confirmImport')}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 编辑已纳管 MCP */}
      {editServer && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4">
          <div
            ref={editPanelRef}
            className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-y-auto shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold">{t('providers.mcp.editTitle')}</h3>
                <p className="text-[10px] text-zinc-400 mt-0.5">{t('providers.mcp.editHint')}</p>
              </div>
              <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden text-[10px] shrink-0">
                <button
                  type="button"
                  onClick={() => switchEditMode('form')}
                  className={`px-2.5 py-1 ${
                    editServer.editMode !== 'json'
                      ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium'
                      : 'text-zinc-400 hover:text-zinc-600'
                  }`}
                >
                  {t('providers.mcp.formMode')}
                </button>
                <button
                  type="button"
                  onClick={() => switchEditMode('json')}
                  className={`px-2.5 py-1 ${
                    editServer.editMode === 'json'
                      ? 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-200 font-medium'
                      : 'text-zinc-400 hover:text-zinc-600'
                  }`}
                >
                  {t('providers.mcp.rawJsonMode')}
                </button>
              </div>
            </div>

            {editServer.editMode === 'json' ? (
              <label className="block space-y-1">
                <span className="text-[10px] text-zinc-500">
                  {t('providers.mcp.rawJsonLabel')}
                </span>
                <textarea
                  value={editServer.rawJson}
                  onChange={e => setEditServer(f => ({ ...f, rawJson: e.target.value }))}
                  rows={16}
                  spellCheck={false}
                  className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono leading-relaxed"
                />
              </label>
            ) : (
              <>
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">{t('providers.mcp.displayName')}</span>
              <input
                value={editServer.display_name}
                onChange={e => setEditServer(f => ({ ...f, display_name: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">{t('providers.mcp.configName')}</span>
              <input
                value={editServer.name}
                onChange={e => setEditServer(f => ({ ...f, name: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
              />
            </label>
            {renderTypeModeToggle(isMcpUrlServer(editServer), (urlMode) => {
              setEditServer((f) => ({
                ...f,
                type: urlMode ? (f.type === 'sse' ? 'sse' : 'http') : 'stdio',
              }));
            })}
            {isMcpUrlServer(editServer) ? (
              <>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">URL</span>
                  <input
                    value={editServer.url}
                    onChange={e => setEditServer(f => ({ ...f, url: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                    placeholder={t('providers.mcp.urlPh')}
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">{t('providers.mcp.headersJson')}</span>
                  <textarea
                    value={editServer.headersText}
                    onChange={e => setEditServer(f => ({ ...f, headersText: e.target.value }))}
                    rows={3}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
              </>
            ) : (
              <>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">command</span>
                  <input
                    value={editServer.command}
                    onChange={e => setEditServer(f => ({ ...f, command: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">{t('providers.mcp.argsHint')}</span>
                  <input
                    value={editServer.args}
                    onChange={e => setEditServer(f => ({ ...f, args: e.target.value }))}
                    className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">{t('providers.mcp.envJson')}</span>
                  <textarea
                    value={editServer.envText}
                    onChange={e => setEditServer(f => ({ ...f, envText: e.target.value }))}
                    rows={3}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
              </>
            )}
            <label className="block space-y-1">
              <span className="text-[10px] text-zinc-500">{t('providers.mcp.description')}</span>
              <input
                value={editServer.description}
                onChange={e => setEditServer(f => ({ ...f, description: e.target.value }))}
                className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
              />
            </label>
              </>
            )}

            <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={editServer.syncToAgents}
                onChange={e => setEditServer(f => ({ ...f, syncToAgents: e.target.checked }))}
                className="rounded border-zinc-300 dark:border-zinc-600"
              />
              {t('providers.mcp.syncToAgents')}
              {editServer.installedCount > 0 && (
                <span className="text-[10px] text-zinc-400">{t('providers.mcp.syncCount', { n: editServer.installedCount })}</span>
              )}
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setEditServer(null)} className="text-xs px-3 py-1.5 rounded-lg border">{t('providers.mcp.cancel')}</button>
              <button
                type="button"
                onClick={saveEditServer}
                disabled={!!busy || (editServer.editMode !== 'json' && (!editServer.name.trim() || (editServer.type !== 'stdio' ? !editServer.url.trim() : !editServer.command.trim())))}
                className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white disabled:opacity-40"
              >
                {busy === editServer.id ? t('providers.mcp.saving') : t('providers.mcp.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* 自定义 Server */}
      {showCustom && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-3 shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-semibold">{t('providers.mcp.addCustomTitle')}</h3>
            <input
              placeholder={t('providers.mcp.namePh')}
              value={customForm.name}
              onChange={e => setCustomForm(f => ({ ...f, name: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
            />
            <input
              placeholder={t('providers.mcp.displayNamePh')}
              value={customForm.display_name}
              onChange={e => setCustomForm(f => ({ ...f, display_name: e.target.value }))}
              className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800"
            />
            {renderTypeModeToggle(isMcpUrlServer(customForm), (urlMode) => {
              setCustomForm((f) => ({ ...f, type: urlMode ? 'http' : 'stdio' }));
            })}
            {isMcpUrlServer(customForm) ? (
              <>
                <input
                  placeholder={t('providers.mcp.urlPh')}
                  value={customForm.url}
                  onChange={e => setCustomForm(f => ({ ...f, url: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                />
                <label className="block space-y-1">
                  <span className="text-[10px] text-zinc-500">{t('providers.mcp.headersJson')}</span>
                  <textarea
                    value={customForm.headersText}
                    onChange={e => setCustomForm(f => ({ ...f, headersText: e.target.value }))}
                    rows={3}
                    className="w-full text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                  />
                </label>
              </>
            ) : (
              <>
                <input
                  placeholder="command"
                  value={customForm.command}
                  onChange={e => setCustomForm(f => ({ ...f, command: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                />
                <input
                  placeholder={t('providers.mcp.argsPh')}
                  value={customForm.args}
                  onChange={e => setCustomForm(f => ({ ...f, args: e.target.value }))}
                  className="w-full text-sm px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 font-mono"
                />
              </>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setShowCustom(false); setCustomForm({ ...EMPTY_CUSTOM_FORM }); }} className="text-xs px-3 py-1.5 rounded-lg border">{t('providers.mcp.cancel')}</button>
              <button
                type="button"
                onClick={saveCustomServer}
                disabled={!!busy || !customForm.name.trim() || (isMcpUrlServer(customForm) ? !customForm.url.trim() : !customForm.command.trim())}
                className="text-xs px-3 py-1.5 rounded-lg bg-violet-600 text-white disabled:opacity-40"
              >
                {t('providers.mcp.save')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

