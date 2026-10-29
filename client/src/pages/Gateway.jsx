import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { loadGatewayAvailableModels, resolveLocalGatewayBase, inferModelTypeFromName } from '../api/gatewayModels';
import { getSyncServerBase } from '../config';
import { getGateway, getLocalConfig, getConfig, getApps, getOauth } from '../api/adapter';
import { listAgents, applyAgent, revertAgent } from '../api/agents';
import claudeDevModeImg1 from '../assets/claude-devmode-1.webp';
import claudeDevModeImg2 from '../assets/claude-devmode-2.webp';
import { brandIconFor, resolveBrandIcon } from '../lib/brandIcons';
import { APP_ICONS, isAppIcon, appIconSvg } from '../lib/appIcons';
import { useLang } from '../store/lang';
import { useAuth } from '../store/index';
import RouteSelect, { tierOptgroups, usableSceneRoutes } from '../components/RouteSelect';
import {
  encodeTierModelRoute,
  parseRouteBinding,
  routeSelectValue,
} from '../lib/route-binding';
import { useCurrency } from '../store/currency';
import { runStreamChatTest } from '../lib/streamTestLatency';
import { getNetwork } from '../api/client';
import { normalizeNetworkPayload, workerInfo, workersForModel } from '../lib/networkModelStats';
import { buildInvokeText, buildMcpInvokeText } from '../lib/resource-enable';
import { speedDotClass, statusDotBucket } from '../lib/speed';

// tier:id 作为下拉唯一 value，避免同模型跨层选中错位
function modelTierKey(m) {
  return encodeTierModelRoute(m.tier, m.id);
}

/** 网关测试 / 接入示例：场景路由用 model_key；单层路由保留 tier 前缀 */
function exampleModelFromRoute(routeVal, routes, availableModels) {
  if (!routeVal) {
    const fallback = availableModels[0];
    return { model: fallback?.id || 'gpt-4o', modelType: fallback?.type };
  }
  const scene = routes.find(r => r.model_key === routeVal || r.id === routeVal);
  if (scene) {
    // 网关 scene 拦截按 model_key 索引，不能用 route UUID
    return { model: scene.model_key || scene.id || routeVal, modelType: undefined };
  }
  const parsed = parseRouteBinding(routeVal, routes);
  const entry = availableModels.find(m => modelTierKey(m) === routeVal)
    || (parsed.modelId && availableModels.find(m =>
      m.id === parsed.modelId && (!parsed.tier || m.tier === parsed.tier)));
  const model = parsed.tier ? routeVal : (parsed.modelId || routeVal);
  return { model, modelType: entry?.type };
}

/** 应用已绑定的路由 id 列表（多选存 route_ids，单选回退 route_id） */
function effectiveRouteIds(app) {
  if (Array.isArray(app?.route_ids) && app.route_ids.length) return app.route_ids;
  if (app?.route_id) return [app.route_id];
  return [];
}

/** Trae Work：自定义模型由用户在 IDE 内手工配置 */
function isTraeWorkApp(app) {
  const id = app?.agent_id || app?.preset_id || '';
  return id === 'trae-work' || id === 'trae' || String(id).toLowerCase() === 'trae';
}

// ── PolicyManager：策略组管理 UI ──────────────────────────────────────────────
function strategyOptions(t) {
  return [
    { value: 'fallback',    label: t('gateway.strategy.fallback'),    desc: t('gateway.strategy.fallbackDesc') },
    { value: 'round-robin', label: t('gateway.strategy.roundRobin'),  desc: t('gateway.strategy.roundRobinDesc') },
    { value: 'weighted',    label: t('gateway.strategy.weighted'),    desc: t('gateway.strategy.weightedDesc') },
    { value: 'latency',     label: t('gateway.strategy.latency'),     desc: t('gateway.strategy.latencyDesc') },
    { value: 'direct',      label: t('gateway.strategy.direct'),      desc: t('gateway.strategy.directDesc') },
  ];
}

function PolicyManager() {
  const { t } = useLang();
  const STRATEGY_OPTIONS = strategyOptions(t);
  const [policies, setPolicies] = useState([]);
  const [providers, setProviders] = useState([]);
  const [editing, setEditing] = useState(null);   // null | policy object | 'new'
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // 编辑表单状态
  const [formName, setFormName] = useState('');
  const [formStrategy, setFormStrategy] = useState('fallback');
  const [formProviders, setFormProviders] = useState([]);  // [{id, weight}]

  const load = useCallback(async () => {
    if (!window.electronAPI?.policies) return;
    const [pl, cfg] = await Promise.all([
      window.electronAPI.policies.list(),
      window.electronAPI.config?.read?.(),
    ]);
    setPolicies(Array.isArray(pl) ? pl : []);
    setProviders((cfg?.providers || []).filter(p => p.enabled && p.base_url));
  }, []);
  useEffect(() => { load(); }, [load]);

  function openNew() {
    setFormName(''); setFormStrategy('fallback'); setFormProviders([]);
    setEditing('new'); setMsg('');
  }
  function openEdit(p) {
    setFormName(p.name); setFormStrategy(p.strategy || 'fallback');
    setFormProviders((p.providers || []).map(x => typeof x === 'string' ? { id: x, weight: 1 } : x));
    setEditing(p); setMsg('');
  }
  function cancelEdit() { setEditing(null); setMsg(''); }

  async function save() {
    if (!window.electronAPI?.policies) return setMsg(t('gateway.sync.cliOnly'));
    if (!formName.trim()) return setMsg(t('gateway.policy.nameRequired'));
    setBusy(true);
    try {
      const d = { name: formName.trim(), strategy: formStrategy, providers: formProviders };
      if (editing === 'new') await window.electronAPI.policies.create(d);
      else await window.electronAPI.policies.update({ id: editing.id, ...d });
      await load(); setEditing(null); setMsg('');
    } catch (e) { setMsg('✗ ' + e.message); }
    setBusy(false);
  }

  async function del(id) {
    if (!window.electronAPI?.policies) return;
    if (!window.confirm(t('gateway.policy.confirmDelete'))) return;
    await window.electronAPI.policies.delete(id);
    await load();
  }

  function addProvider(provId) {
    if (!provId || formProviders.find(p => p.id === provId)) return;
    setFormProviders(prev => [...prev, { id: provId, weight: 1 }]);
  }
  function removeProvider(id) { setFormProviders(prev => prev.filter(p => p.id !== id)); }
  function setWeight(id, w) { setFormProviders(prev => prev.map(p => p.id === id ? { ...p, weight: Math.max(1, +w || 1) } : p)); }
  function moveUp(idx) { if (idx === 0) return; const a = [...formProviders]; [a[idx-1], a[idx]] = [a[idx], a[idx-1]]; setFormProviders(a); }

  return (
    <div className="tb-soft-card rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px] shrink-0 text-zinc-400 dark:text-zinc-500">
          <path d="M12 3c2.755 0 5.455.232 8.083.678.533.09.917.556.917 1.096v1.044a2.25 2.25 0 0 1-.659 1.591l-5.432 5.432a2.25 2.25 0 0 0-.659 1.591v2.927a2.25 2.25 0 0 1-1.244 2.013L9.75 21v-6.568a2.25 2.25 0 0 0-.659-1.591L3.659 7.409A2.25 2.25 0 0 1 3 5.818V4.774c0-.54.384-1.006.917-1.096A48.32 48.32 0 0 1 12 3Z" />
        </svg>
        <h2 className="font-semibold text-zinc-800 dark:text-zinc-100 text-sm">{t('gateway.policy.title')}</h2>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('gateway.policy.subtitle')}</span>
        <button onClick={openNew}
          className="ml-auto text-xs px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white transition-colors">
          {t('gateway.policy.new')}
        </button>
      </div>

      {/* 策略组列表 */}
      <div className="flex flex-col gap-1.5 mb-2">
        {policies.length === 0 && <div className="text-xs text-zinc-400 py-1">{t('gateway.policy.empty')}</div>}
        {policies.map(p => (
          <div key={p.id} className="tb-soft-tile flex items-center gap-2 px-3 py-2 rounded-lg text-sm">
            <span className="font-medium text-zinc-800 dark:text-zinc-100 truncate flex-1">{p.name}</span>
            <span className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0">
              {STRATEGY_OPTIONS.find(s => s.value === p.strategy)?.label || p.strategy}
            </span>
            <span className="text-xs text-zinc-400 shrink-0">{t('gateway.policy.providerCount', { n: (p.providers||[]).length })}</span>
            <button onClick={() => openEdit(p)}
              className="text-xs px-2 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300 shrink-0">
              {t('gateway.common.edit')}
            </button>
            <button onClick={() => del(p.id)}
              className="text-xs text-red-400 hover:text-red-600 shrink-0">{t('gateway.common.del')}</button>
          </div>
        ))}
      </div>

      {/* 编辑面板 */}
      {editing && (
        <div className="mt-3 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <div className="text-xs font-medium text-zinc-700 dark:text-zinc-200 mb-2">
            {editing === 'new' ? t('gateway.policy.newTitle') : t('gateway.policy.editTitle', { name: editing.name })}
          </div>
          <div className="flex flex-col gap-2">
            {/* 名称 */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-500 w-14 shrink-0">{t('gateway.policy.nameLabel')}</label>
              <input value={formName} onChange={e => setFormName(e.target.value)}
                placeholder={t('gateway.policy.namePlaceholder')}
                className="flex-1 text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200" />
            </div>
            {/* Strategy */}
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-500 w-14 shrink-0">{t('gateway.policy.strategyLabel')}</label>
              <select value={formStrategy} onChange={e => setFormStrategy(e.target.value)}
                className="flex-1 text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 outline-none text-zinc-800 dark:text-zinc-200">
                {STRATEGY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                ))}
              </select>
            </div>
            {/* Provider 列表 */}
            <div>
              <div className="flex items-center gap-2 mb-1">
                <label className="text-xs text-zinc-500 w-14 shrink-0">Provider</label>
                <select defaultValue="" onChange={e => { addProvider(e.target.value); e.target.value = ''; }}
                  className="flex-1 text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 outline-none text-zinc-800 dark:text-zinc-200">
                  <option value="">{t('gateway.policy.addProvider')}</option>
                  {providers.filter(p => !formProviders.find(fp => fp.id === p.id)).map(p => (
                    <option key={p.id} value={p.id}>{p.label || p.id}</option>
                  ))}
                </select>
              </div>
              {formProviders.map((fp, idx) => (
                <div key={fp.id} className="flex items-center gap-1.5 ml-16 mb-1">
                  <span className="text-xs text-zinc-600 dark:text-zinc-300 flex-1 truncate">{fp.id}</span>
                  {formStrategy === 'weighted' && (
                    <label className="text-xs text-zinc-400">weight
                      <input type="number" min="1" value={fp.weight} onChange={e => setWeight(fp.id, e.target.value)}
                        className="ml-1 w-12 text-xs bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded px-1 py-0.5 text-center" />
                    </label>
                  )}
                  <button onClick={() => moveUp(idx)} disabled={idx===0}
                    className="text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-30">↑</button>
                  <button onClick={() => removeProvider(fp.id)}
                    className="text-xs text-red-400 hover:text-red-600">✕</button>
                </div>
              ))}
              {formProviders.length === 0 && (
                <div className="ml-16 text-xs text-zinc-400">{t('gateway.policy.noProviders')}</div>
              )}
            </div>
            {/* 操作 */}
            {msg && <div className={`text-xs ml-16 ${msg.startsWith('✗') ? 'text-red-500' : 'text-green-600'}`}>{msg}</div>}
            <div className="flex gap-2 ml-16">
              <button onClick={save} disabled={busy}
                className="text-xs px-3 py-1 rounded bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white disabled:opacity-50">
                {busy ? t('gateway.common.saving') : t('gateway.common.save')}
              </button>
              <button onClick={cancelEdit}
                className="text-xs px-3 py-1 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300">
                {t('gateway.common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
        {t('gateway.policy.hint')}
      </p>
    </div>
  );
}

// ── ImportConfigButton：在线同步（地址取自设置页，不在 UI 展示）────────────
function ImportConfigButton({ onImported, endpoint = '/api/config/apps' }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const msgTimerRef = useRef(null);

  // 同步结果提示 5 秒后自动隐藏
  useEffect(() => {
    if (!msg) return;
    if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    msgTimerRef.current = setTimeout(() => setMsg(''), 5000);
    return () => {
      if (msgTimerRef.current) clearTimeout(msgTimerRef.current);
    };
  }, [msg]);

  function importedMsg(r, prefix) {
    const apps = Array.isArray(r.addedApps) ? r.addedApps : [];
    const routes = Array.isArray(r.addedRoutes) ? r.addedRoutes : [];
    const removed = Array.isArray(r.removedRoutes) ? r.removedRoutes : [];
    const parts = [];
    if (apps.length)    parts.push(t('gateway.sync.addedApps', { n: apps.length, list: apps.join('、') }));
    if (routes.length)  parts.push(t('gateway.sync.addedRoutes', { n: routes.length, list: routes.join('、') }));
    if (removed.length) parts.push(t('gateway.sync.removedRoutes', { n: removed.length, list: removed.join('、') }));
    if (parts.length)  return `${prefix}，${parts.join('；')}`;
    return t('gateway.sync.noChanges', { prefix });
  }

  async function handleSync() {
    const base = await getSyncServerBase();
    if (!base) {
      setMsg(t('gateway.sync.noServer'));
      return;
    }
    const fullUrl = base + endpoint;
    setBusy(true);
    setMsg('');
    const token = localStorage.getItem('token');

    // 桌面端：apps/sources/scenes 全量覆盖（scenes 含系统下发路由的同步删除）
    if (window.electronAPI?.toolsConfig?.importUrl) {
      const replace = endpoint.includes('/apps') || endpoint.includes('/sources') || endpoint.includes('/scenes');
      const r = await window.electronAPI.toolsConfig.importUrl(fullUrl, token, { replace });
      setMsg(r.ok ? '✓ ' + importedMsg(r, t('gateway.sync.done')) : '✗ ' + r.error);
      if (r.ok && onImported) onImported();
      setBusy(false);
      return;
    }

    // Docker / 浏览器 CLI 模式：在线同步需桌面端能力
    setMsg('✗ ' + t('gateway.sync.cliOnly'));
    setBusy(false);
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <button type="button" disabled={busy} onClick={handleSync}
        title={t('gateway.sync.title')}
        className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 transition-colors">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 shrink-0 ${busy ? 'animate-spin' : ''}`}>
          <path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
        {busy ? t('gateway.sync.syncing') : t('gateway.sync.btn')}
      </button>
      {msg && <div className={`text-xs ${msg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{msg}</div>}
    </div>
  );
}

// ── 百宝箱：安装/卸载说明弹框 ─────────────────────────────────────────────
function toolboxOsKind() {
  const p = typeof window !== 'undefined' && window.electronAPI?.platform;
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'win';
  if (typeof navigator !== 'undefined') {
    if (/Win/i.test(navigator.userAgent)) return 'win';
    if (/Mac/i.test(navigator.userAgent)) return 'mac';
  }
  return 'other';
}
function toolboxDefaultGuide(install, name, t) {
  const os = toolboxOsKind();
  if (install) {
    if (os === 'mac') return t('gateway.toolbox.defaultInstallGuideMac', { name });
    if (os === 'win') return t('gateway.toolbox.defaultInstallGuideWin', { name });
    return t('gateway.toolbox.defaultInstallGuide', { name });
  }
  if (os === 'mac') return t('gateway.toolbox.defaultUninstallGuideMac', { name });
  if (os === 'win') return t('gateway.toolbox.defaultUninstallGuideWin', { name });
  return t('gateway.toolbox.defaultUninstallGuide', { name });
}
function toolboxPlatformLabel(t, install) {
  const os = toolboxOsKind();
  if (os === 'mac') return install ? t('gateway.toolbox.platformMacInstall') : t('gateway.toolbox.platformMacUninstall');
  if (os === 'win') return install ? t('gateway.toolbox.platformWinInstall') : t('gateway.toolbox.platformWinUninstall');
  return null;
}

function AppToolboxGuideModal({ app, mode, onClose }) {
  const { t } = useLang();
  if (!app || !mode) return null;
  const install = mode === 'install';
  const url = install ? app.install_url : (app.uninstall_url || app.install_url);
  const configured = install ? app.install_guide : app.uninstall_guide;
  const body = configured || toolboxDefaultGuide(install, app.name, t);
  const platLabel = toolboxPlatformLabel(t, install);
  const title = install
    ? t('gateway.toolbox.installGuideTitle', { name: app.name })
    : t('gateway.toolbox.uninstallGuideTitle', { name: app.name });
  const brand = resolveBrandIcon(`${app.id} ${app.name}`);

  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md mx-auto flex flex-col max-h-[min(85vh,420px)]"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
          {brand
            ? <img src={brand} alt="" className="w-6 h-6 object-contain shrink-0" />
            : isAppIcon(app.icon)
              ? appIconSvg(app.icon, 'w-6 h-6 shrink-0')
              : <span className="text-xl shrink-0">{app.icon}</span>}
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 truncate">{title}</h3>
            {platLabel && (
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{platLabel}</span>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg leading-none shrink-0">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">{body}</p>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 shrink-0">
          {url && (
            <button type="button"
              onClick={() => getOauth().openExternal?.(url)}
              className="flex-1 text-xs px-3 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white font-medium transition-colors">
              {t('gateway.toolbox.openOfficialLink')}
            </button>
          )}
          <button type="button" onClick={onClose}
            className={`text-xs px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700/50 transition-colors ${url ? '' : 'flex-1'}`}>
            {t('gateway.toolbox.guideGotIt')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── 应用百宝箱：按钮侧下拉浮层，九宫格 + 安装/卸载 ─────────────────────────
function AppToolbox({ open, busy, onToggle, onClose, refreshKey = 0, syncError = null }) {
  const { t } = useLang();
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);
  const [pos, setPos] = useState({ top: 0, bottom: null, right: 16, maxH: 360 });
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState({});
  const [guideDlg, setGuideDlg] = useState(null);   // { app, mode: 'install'|'uninstall' }
  const [npmBusy, setNpmBusy] = useState({});       // { [id]: true } 一键安装进行中

  // 一键安装 CLI 工具：跑 npm i -g，装完刷新检测状态
  const oneClickInstall = useCallback(async (app) => {
    if (!getApps().npmGlobalInstall) return;
    setNpmBusy(b => ({ ...b, [app.id]: true }));
    try {
      const r = await getApps().npmGlobalInstall(app.id);
      if (!r?.ok) window.alert(t('gateway.toolbox.installFailed', { name: app.name, msg: r?.error || '' }));
      await loadItems();
    } catch (e) {
      window.alert(t('gateway.toolbox.installFailed', { name: app.name, msg: e.message }));
    } finally {
      setNpmBusy(b => { const c = { ...b }; delete c[app.id]; return c; });
    }
  }, [t]);

  // 一键卸载 CLI 工具：跑 npm uninstall -g，卸完刷新检测状态
  const oneClickUninstall = useCallback(async (app) => {
    if (!getApps().npmGlobalUninstall) return;
    if (!window.confirm(t('gateway.toolbox.uninstallConfirm', { name: app.name }))) return;
    setNpmBusy(b => ({ ...b, [app.id]: true }));
    try {
      const r = await getApps().npmGlobalUninstall(app.id);
      if (!r?.ok) window.alert(t('gateway.toolbox.uninstallFailed', { name: app.name, msg: r?.error || '' }));
      await loadItems();
    } catch (e) {
      window.alert(t('gateway.toolbox.uninstallFailed', { name: app.name, msg: e.message }));
    } finally {
      setNpmBusy(b => { const c = { ...b }; delete c[app.id]; return c; });
    }
  }, [t]);

  const updatePos = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    const spaceBelow = window.innerHeight - r.bottom - 12;
    // 相对视口定位（panel portal 到 body）；高度随可用空间放大
    const PANEL_MAX = 420;
    if (spaceBelow >= 200) {
      setPos({ top: r.bottom + 6, bottom: null, right, maxH: Math.min(PANEL_MAX, Math.max(220, spaceBelow)) });
    } else {
      setPos({
        top: null,
        bottom: window.innerHeight - r.top + 6,
        right,
        maxH: Math.min(PANEL_MAX, Math.max(180, r.top - 12)),
      });
    }
  }, []);

  const loadItems = useCallback(() => {
    setLoading(true);
    return Promise.resolve(getApps().supported?.() ?? [])
      .then(r => setItems(Array.isArray(r) ? r : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!open) return;
    loadItems();
    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [open, refreshKey, loadItems, updatePos]);

  // 点击外部关闭（按钮 + portal 浮层都算内部）
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      const t = e.target;
      if (wrapRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open, onClose]);

  const openGuide = (app, install) => setGuideDlg({ app, mode: install ? 'install' : 'uninstall' });

  const panel = (
    <div
      ref={panelRef}
      aria-hidden={!open}
      style={{
        ...(pos.top != null ? { top: pos.top } : {}),
        ...(pos.bottom != null ? { bottom: pos.bottom } : {}),
        right: pos.right,
        maxHeight: pos.maxH,
      }}
      className={`fixed z-[80] w-[min(calc(100vw-1rem),300px)] flex flex-col
        origin-top-right transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]
        ${open ? 'opacity-100 translate-y-0 scale-100 pointer-events-auto' : 'opacity-0 -translate-y-1.5 scale-[0.97] pointer-events-none'}`}>
      <div className="bg-white dark:bg-zinc-800 rounded-xl shadow-xl shadow-black/10 dark:shadow-black/40 border border-zinc-200/80 dark:border-zinc-700 flex flex-col min-h-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
          <h3 className="text-[11px] font-semibold text-zinc-800 dark:text-zinc-100 flex-1 truncate" title={t('gateway.toolbox.hint')}>
            {t('gateway.toolbox.panelTitle')}
          </h3>
          <button type="button" onClick={loadItems} title={t('gateway.common.refresh')}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 p-0.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-700/50 transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className="w-3 h-3">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
            </svg>
          </button>
          <button type="button" onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-sm leading-none p-0.5 transition-colors">✕</button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-2">
          {syncError && (
            <div className="mb-2 px-2 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200/80 dark:border-amber-800/50 text-[10px] text-amber-700 dark:text-amber-400 leading-snug">
              {t('gateway.toolbox.syncFailed', { error: syncError })}
            </div>
          )}
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-6 text-[11px] text-zinc-400">
              <div className="w-3 h-3 border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
              {t('gateway.toolbox.loading')}
            </div>
          ) : items.length === 0 ? (
            <div className="py-6 text-center text-[11px] text-zinc-400">{t('gateway.toolbox.empty')}</div>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {items.map(a => {
                const brand = resolveBrandIcon(`${a.id} ${a.name}`);
                const dim = a.installed ? '' : 'grayscale opacity-45';
                const install = !a.installed;
                const canNpm = install && !!a.npm_package && !!getApps().npmGlobalInstall;   // 未装 + 有 npm 包 → 可一键装
                const canNpmUninstall = !install && !!a.npm_package && !!getApps().npmGlobalUninstall;  // 已装 + 有 npm 包 → 可命令行卸
                const installing = !!npmBusy[a.id];
                const btnLabel = installing ? (install ? t('gateway.toolbox.installing') : t('gateway.toolbox.uninstalling'))
                  : canNpm ? t('gateway.toolbox.oneClickInstall')
                  : canNpmUninstall ? t('gateway.toolbox.oneClickUninstall')
                  : install ? t('gateway.toolbox.install') : t('gateway.toolbox.uninstall');
                const btnTitle = canNpm ? t('gateway.toolbox.oneClickTitle', { name: a.name })
                  : canNpmUninstall ? t('gateway.toolbox.oneClickUninstallTitle', { name: a.name })
                  : install ? t('gateway.toolbox.installTitle', { name: a.name })
                  : t('gateway.toolbox.uninstallTitle', { name: a.name });
                const onBtn = () => canNpm ? oneClickInstall(a)
                  : canNpmUninstall ? oneClickUninstall(a)
                  : openGuide(a, install);
                return (
                  <div key={a.id}
                    className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md border transition-colors
                      ${a.installed
                        ? 'border-zinc-200/80 dark:border-zinc-600/50 bg-zinc-50/50 dark:bg-zinc-700/20'
                        : 'border-zinc-100 dark:border-zinc-700/40'}`}>
                    <div className="w-7 h-7 flex items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-700/40 shrink-0">
                      {brand && !failed[a.id]
                        ? <img src={brand} alt="" aria-hidden onError={() => setFailed(f => ({ ...f, [a.id]: true }))}
                            className={`w-4 h-4 object-contain ${dim}`} />
                        : isAppIcon(a.icon)
                          ? appIconSvg(a.icon, `w-4 h-4 ${dim}`)
                          : <span aria-hidden className={`text-sm leading-none ${dim}`}>{a.icon}</span>}
                    </div>
                    <span className="text-[9px] font-medium text-zinc-700 dark:text-zinc-200 text-center truncate w-full leading-none" title={a.name}>
                      {a.name}
                    </span>
                    <button type="button" title={btnTitle} disabled={installing}
                      onClick={onBtn}
                      className={`text-[9px] px-1 py-px rounded font-medium transition-colors w-full leading-tight disabled:opacity-60
                        ${install
                          ? 'bg-blue-500 hover:bg-blue-600 text-white'
                          : 'border border-zinc-200 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50'}`}>
                      {btnLabel}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {guideDlg && (
        <AppToolboxGuideModal app={guideDlg.app} mode={guideDlg.mode} onClose={() => setGuideDlg(null)} />
      )}
      <div ref={wrapRef} className="relative ml-auto">
        <button ref={btnRef} type="button" onClick={onToggle} disabled={busy}
          title={t('gateway.toolbox.title')}
          aria-expanded={open}
          className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50
            ${open
              ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400'
              : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={`w-3.5 h-3.5 shrink-0 ${busy ? 'animate-spin' : ''}`}>
            {busy
              ? <path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
              : <>
                  <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8z" />
                  <path d="M3.3 7 12 12l8.7-5M12 22V12" />
                </>}
          </svg>
          {busy ? t('gateway.toolbox.syncing') : t('gateway.toolbox.btn')}
        </button>
      </div>
      {createPortal(panel, document.body)}
    </>
  );
}

// ── AppManager：应用列表（Tab1: 所有应用 & 托管 | Tab2: API Key 管理）────────
// 接入方式列：仅「应用」/「API」（manual=手工 API，其余均为应用）
function linkMethodLabel(method, t) {
  return method === 'manual' ? t('gateway.link.api') : t('gateway.link.app');
}
// 把绝对家目录前缀缩写成 ~（渲染进程拿不到 home，用平台启发式：/Users/x、/home/x、C:\Users\x）
function tildify(p) {
  return String(p || '')
    .replace(/^\/(?:Users|home)\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~');
}
// 应用列表统一栅格：固定短列 + minmax(0,fr) 弹性列，避免内容撑开导致各行列宽不一致
// 应用列保留 modest 最小宽；不设表格 min-width，避免常态出现横向滚动条
// 应用列加大最小宽；固定短列与路由 min 适当压缩，空间让给应用名
const APPS_TABLE_GRID = 'grid w-full grid-cols-[1.75rem_minmax(8rem,2fr)_5rem_1.75rem_3.75rem_3.5rem_3.75rem_minmax(4.5rem,1.6fr)_minmax(7.75rem,auto)] gap-x-2 items-center px-2.5 [&>*]:min-w-0';

/** 应用行测试状态：成功/进行中行内短提示；失败用浮层展示完整错误（避免窄列截断） */
function AppTestResultHint({ ts, t }) {
  if (!ts) return null;
  if (ts.busy) {
    return (
      <div className="mt-0.5 text-right text-[10px] leading-tight text-zinc-400">
        {t('gateway.common.testing')}
      </div>
    );
  }
  const multi = (ts.total || 1) > 1;
  if (ts.ok) {
    return (
      <div className="mt-0.5 text-right text-[10px] leading-tight font-mono text-green-500 dark:text-green-400">
        ✓ {multi ? `${ts.passedCount}/${ts.total} · ` : ''}{t('gateway.common.testFirstToken', { ms: ts.latency })}
      </div>
    );
  }
  // 多选部分失败：显示 x/N 通过（失败详情走下方错误浮层）
  if (multi && ts.passedCount > 0) {
    return (
      <div className="mt-0.5 text-right text-[10px] leading-tight font-mono text-amber-500 dark:text-amber-400">
        {ts.passedCount}/{ts.total} 通过
      </div>
    );
  }
  return null;
}

/** 测试失败浮层：挂在整行下方，不受操作列宽度限制 */
function AppTestErrorFloat({ error }) {
  if (!error) return null;
  return (
    <div className="flex justify-end px-4 -mt-0.5 pb-1.5 relative z-[5]">
      <div
        className="text-[10px] leading-snug font-mono text-red-600 dark:text-red-300 bg-white dark:bg-zinc-900 border border-red-200/80 dark:border-red-800/60 rounded-lg px-2.5 py-1.5 shadow-md dark:shadow-black/40 max-w-full whitespace-normal break-words text-left"
        role="alert"
      >
        ✗ {error}
      </div>
    </div>
  );
}
// 按 API Key 路由的应用：自动写配置的 api-key，和用户自配的 manual（手工添加）
const isKeyApp = (m) => m === 'api-key' || m === 'manual';

function strategyLabel(key, t) {
  const map = {
    'base_url-env': t('gateway.strategyLabel.baseUrlEnv'),
    'config-file':  t('gateway.strategyLabel.configFile'),
    'mitm-env':     t('gateway.strategyLabel.mitmEnv'),
  };
  return map[key] || key;
}

/** 资源/MCP 芯片区：自适应换行，超过约 5 行折叠，点展开 */
function BoundChipFold({ children, itemCount = 0, t }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // 单行约 30px（py-1.5 + 字号），行间距 gap-1.5=6px → 5 行
  const maxCollapsedH = 5 * 30 + 4 * 6;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => setOverflows(el.scrollHeight > maxCollapsedH + 2);
    check();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(check) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [itemCount, maxCollapsedH, expanded]);

  return (
    <div>
      <div
        ref={ref}
        className={`flex flex-wrap gap-1.5 ${expanded ? '' : 'overflow-hidden'}`}
        style={expanded ? undefined : { maxHeight: maxCollapsedH }}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          {expanded ? t('gateway.common.collapse') : t('gateway.app.boundExpand')}
        </button>
      )}
    </div>
  );
}

/** 资源/MCP 绑定匹配用的应用 id 集合（含 agent 别名） */
function appBoundMatchIds(app) {
  const ids = new Set();
  if (!app) return ids;
  for (const v of [app.agent_id, app.preset_id, app.activity_agent_id, app.id]) {
    if (typeof v === 'string' && v) ids.add(v);
  }
  // codex ↔ codex-desktop 互通
  if (ids.has('codex')) ids.add('codex-desktop');
  if (ids.has('codex-desktop')) ids.add('codex');
  return ids;
}

/** 跳转资源配置页前写入筛选（与 Resources.jsx localStorage key 对齐） */
function prepareResourcesNav(agentId) {
  try {
    localStorage.setItem('tokenbank.resources.appFilter', agentId || '');
    localStorage.setItem('tokenbank.resources.viewTab', 'managed');
  } catch { /* ignore */ }
}

/** 跳转 MCP 配置页前写入供给源 Tab + 应用筛选 */
function prepareMcpNav(agentId) {
  try {
    localStorage.setItem('tokenbank.providers.supplyTab', 'mcp');
    localStorage.setItem('tokenbank.providers.mcpAgentTab', agentId || '');
    localStorage.setItem('tokenbank.providers.mcpViewTab', 'managed');
  } catch { /* ignore */ }
}

/** 编辑页：只读展示当前智能体已投射的资源与已绑定的 MCP */
function AppBoundAssetsSection({ app, onClose }) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [resources, setResources] = useState([]);
  const [mcps, setMcps] = useState([]);
  // 当前选中的试用项（res:… / mcp:…），点芯片切换下方唯一示例
  const [selectedKey, setSelectedKey] = useState('');
  const matchIds = appBoundMatchIds(app);
  const isAgentApp = !!(app?.agent_id || app?.preset_id);
  // 跳转筛选：智能体用 agent_id；API 应用回退 app.id
  const resourceFilterId = app?.agent_id || app?.preset_id || app?.id || '';
  const mcpFilterId = app?.agent_id || app?.preset_id || app?.id || '';
  const invokeLang = lang === 'en' ? 'en' : 'zh';

  useEffect(() => {
    if (matchIds.size === 0) {
      setLoading(false);
      setResources([]);
      setMcps([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [resRes, mcpRes] = await Promise.all([
          window.electronAPI?.resource?.listResources?.({}) || { resources: [] },
          window.electronAPI?.mcp?.listServers?.() || { servers: [] },
        ]);
        if (cancelled) return;
        const allRes = Array.isArray(resRes?.resources) ? resRes.resources
          : (Array.isArray(resRes) ? resRes : []);
        const allMcp = Array.isArray(mcpRes?.servers) ? mcpRes.servers
          : (Array.isArray(mcpRes) ? mcpRes : []);
        // 资源：投射记录命中当前 agent
        setResources(allRes.filter((r) =>
          (r.projections || []).some((p) => matchIds.has(p.agentId || p.agent_id))));
        // MCP：写盘投射或网关中转任一命中
        setMcps(allMcp.filter((s) => {
          const sync = s.sync_clients || [];
          const gw = s.gateway_clients || [];
          const clients = s.clientTargets || [];
          return sync.some((id) => matchIds.has(id))
            || gw.some((id) => matchIds.has(id))
            || clients.some((c) => c?.installed && matchIds.has(c.id));
        }));
      } catch {
        if (!cancelled) { setResources([]); setMcps([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [app?.agent_id, app?.preset_id, app?.activity_agent_id, app?.id]);

  // 列表变化时：选中项失效则回落到第一项
  useEffect(() => {
    const keys = [
      ...resources.map((r) => `res:${r.id || `${r.type}-${r.name}`}`),
      ...mcps.map((s) => `mcp:${s.id || s.name}`),
    ];
    if (!keys.length) {
      if (selectedKey) setSelectedKey('');
      return;
    }
    if (!keys.includes(selectedKey)) setSelectedKey(keys[0]);
  }, [resources, mcps, selectedKey]);

  // 智能体应用始终展示；纯 API 应用仅在有绑定时展示
  if (matchIds.size === 0) return null;
  if (!loading && !isAgentApp && resources.length === 0 && mcps.length === 0) return null;

  function typeLabel(type) {
    const key = `resources.type.${type}`;
    const v = t(key);
    return v === key ? (type || '') : v;
  }

  function mcpBindTags(server) {
    const tags = [];
    const sync = server.sync_clients || [];
    const gw = server.gateway_clients || [];
    const clients = server.clientTargets || [];
    if (sync.some((id) => matchIds.has(id))
      || clients.some((c) => c?.installed && matchIds.has(c.id))) {
      tags.push(t('gateway.app.boundMcpSync'));
    }
    if (gw.some((id) => matchIds.has(id))) {
      tags.push(t('gateway.app.boundMcpGateway'));
    }
    return tags;
  }

  function goResources(e) {
    e?.preventDefault?.();
    prepareResourcesNav(resourceFilterId);
    onClose?.();
    navigate('/resources');
  }

  function goMcp(e) {
    e?.preventDefault?.();
    prepareMcpNav(mcpFilterId);
    onClose?.();
    navigate('/providers');
  }

  // 当前选中项对应的试用口令
  const selectedRes = resources.find((r) => `res:${r.id || `${r.type}-${r.name}`}` === selectedKey);
  const selectedMcp = mcps.find((s) => `mcp:${s.id || s.name}` === selectedKey);
  const exampleText = selectedRes
    ? buildInvokeText(selectedRes, invokeLang)
    : (selectedMcp ? buildMcpInvokeText(selectedMcp, invokeLang) : '');

  const chipBase = 'inline-flex items-center gap-1 max-w-full text-xs px-2.5 py-1.5 rounded-md border transition-colors';
  const chipIdle = 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-500';
  const chipActive = 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300';
  const linkCls = 'text-xs text-blue-600 dark:text-blue-400 hover:underline shrink-0';

  // 按类型分组，避免智能体/提示词/技能混在一起
  const RESOURCE_TYPE_ORDER = ['assistant', 'prompt', 'skill'];
  const resourcesByType = RESOURCE_TYPE_ORDER.map((type) => ({
    type,
    items: resources.filter((r) => r.type === type),
  })).filter((g) => g.items.length > 0);
  // 未归类类型单独一组
  const otherResources = resources.filter((r) => !RESOURCE_TYPE_ORDER.includes(r.type));
  if (otherResources.length) {
    resourcesByType.push({ type: 'other', items: otherResources });
  }

  function renderResourceChips(items) {
    return (
      <BoundChipFold t={t} itemCount={items.length}>
        {items.map((r) => {
          const key = `res:${r.id || `${r.type}-${r.name}`}`;
          const active = selectedKey === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setSelectedKey(key)}
              className={`${chipBase} ${active ? chipActive : chipIdle}`}
              title={r.display_name || r.name}
            >
              <span className="truncate">{r.display_name || r.name || r.id}</span>
            </button>
          );
        })}
      </BoundChipFold>
    );
  }

  return (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-1">{t('gateway.app.boundAssets')}</div>
      {/* 使用说明：投射 vs 中转 + 去哪改 + 复制试用 */}
      <div className="text-xs text-zinc-400 leading-relaxed mb-2">
        {t('gateway.app.boundHint')}
        {/* WorkBuddy 投射 MCP 后须在客户端「信任」自定义连接器 */}
        {String(app?.agent_id || app?.preset_id || app?.id || '').includes('workbuddy') && (
          <span className="block mt-1 text-amber-600 dark:text-amber-400">
            {t('gateway.app.workbuddyMcpTrustHint')}
          </span>
        )}
      </div>
      {loading ? (
        <div className="text-xs text-zinc-400">{t('gateway.app.boundLoading')}</div>
      ) : (resources.length === 0 && mcps.length === 0) ? (
        <div className="space-y-1.5">
          <div className="text-xs text-zinc-400">{t('gateway.app.boundEmpty')}</div>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={goResources} className={linkCls}>{t('gateway.app.boundGoResources')} →</button>
            <button type="button" onClick={goMcp} className={linkCls}>{t('gateway.app.boundGoMcp')} →</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2.5">
          {(resources.length > 0 || isAgentApp) && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-zinc-400">{t('gateway.app.boundResources')}</div>
                <button type="button" onClick={goResources} className={linkCls}>{t('gateway.app.boundGoResources')} →</button>
              </div>
              {resources.length > 0 ? (
                <div className="space-y-2">
                  {resourcesByType.map((g) => (
                    <div key={g.type}>
                      <div className="text-[11px] text-zinc-400 mb-1">
                        {g.type === 'other' ? t('gateway.app.boundResourcesOther') : typeLabel(g.type)}
                      </div>
                      {renderResourceChips(g.items)}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-zinc-400">{t('gateway.app.boundEmpty')}</div>
              )}
            </div>
          )}
          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="text-xs text-zinc-400">{t('gateway.app.boundMcp')}</div>
              <button type="button" onClick={goMcp} className={linkCls}>{t('gateway.app.boundGoMcp')} →</button>
            </div>
            {mcps.length > 0 ? (
              <BoundChipFold t={t} itemCount={mcps.length}>
                {mcps.map((s) => {
                  const key = `mcp:${s.id || s.name}`;
                  const active = selectedKey === key;
                  const tags = mcpBindTags(s);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedKey(key)}
                      className={`${chipBase} ${active ? chipActive : chipIdle}`}
                      title={s.display_name || s.name}
                    >
                      <span className="truncate">{s.display_name || s.name || s.id}</span>
                      {tags.map((tag) => (
                        <span key={tag} className={`text-[10px] shrink-0 ${active ? 'text-blue-400' : 'text-zinc-400'}`}>{tag}</span>
                      ))}
                    </button>
                  );
                })}
              </BoundChipFold>
            ) : (
              <div className="text-xs text-zinc-400">{t('gateway.app.boundEmpty')}</div>
            )}
          </div>

          {/* 单一试用示例：对齐接入配置的请求示例（点芯片切换 + 复制） */}
          {exampleText && (
            <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
              <div className="flex items-center bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-700 px-3 py-2">
                <span className="text-xs font-medium text-zinc-500">{t('gateway.app.boundTryHint')}</span>
                <div className="flex-1" />
                <CopyButton text={exampleText} label={t('gateway.common.copy')} className="py-1 text-xs" />
              </div>
              <pre className="px-4 py-3 text-xs font-mono leading-relaxed text-zinc-700 dark:text-zinc-300 overflow-x-auto bg-zinc-50/30 dark:bg-zinc-900/30 whitespace-pre-wrap break-words">
                {exampleText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 单个应用的设置面板（路由规则绑定 + 详细配置）
function AppSettingsPanel({ app, routes, availableModels = [], localBase = '', instanceCount = 1, onUpdate, onDelete, onRegenKey, onCancelManage, onWritten, onClose, onCancel }) {
  const { t } = useLang();
  const dismiss = onCancel || onClose;   // ✕/取消/点遮罩 → 取消（新应用未保存会被丢弃）
  const [name,           setName]           = useState(app.name || '');
  const [icon,           setIcon]           = useState(app.icon || 'icon:cube');
  const [desc,           setDesc]           = useState(app.description || '');
  const [routeId,        setRouteId]        = useState(() => routeSelectValue(app.route_id, availableModels, routes));
  const [routeIds,       setRouteIds]       = useState(() =>
    effectiveRouteIds(app).map(rid => routeSelectValue(rid, availableModels, routes)).filter(Boolean));
  const [modelIntercept, setModelIntercept] = useState(app.model_intercept || '');
  const [dirGlob,        setDirGlob]        = useState(app.instance?.dir_glob || '');   // CLI 实例生效目录
  const [busy,           setBusy]           = useState(false);
  const [copied,         setCopied]         = useState(false);
  const [claudeDevMode, setClaudeDevMode] = useState(null); // Claude Desktop 开发者模式状态
  // config-file 类 API Key 应用：两 Tab（0=配置文件写入和 API Key｜1=路由规则）
  const isCfg = app.link_method === 'api-key' && !!app.config_file;
  const isShim = app.link_method === 'shim';   // 透明托管：路由规则 + 基础信息
  const isDirectOnly = app.link_method === 'direct'; // 官方订阅 + 会话导入（Cursor 等）
  const isTraeManual = isTraeWorkApp(app);          // Trae：手工在 IDE 内配置自定义模型
  const showManualGuide = isDirectOnly || isTraeManual;
  const isClaudeDesktop = !!(app.integrations?.dev_mode_check || app.integrations?.claude_3p);
  // Claude Desktop 且开发者模式未就绪 → 需引导用户先启用
  const needDevMode = isClaudeDesktop && claudeDevMode && !claudeDevMode.dev_mode_ready;
  const [tab,         setTab]         = useState(0);
  const [written,     setWritten]     = useState(!!app.configured);  // 配置文件是否已写入（决定显示「取消 API Key 管理」）

  // Claude Desktop：检测开发者模式是否就绪
  useEffect(() => {
    if (!isClaudeDesktop) return;
    (async () => {
      try {
        const st = await window.electronAPI?.apps?.claudeDevModeStatus?.();
        setClaudeDevMode(st || null);
      } catch {}
    })();
  }, [isClaudeDesktop]);

  // 网关 origin（去掉 /v1），用于解析环境变量模板里的 {BASE}
  const gwOrigin = (localBase || resolveLocalGatewayBase()).replace(/\/v1\/?$/, '');
  // 只对字符串做占位符替换；对象/数组递归（WorkBuddy models.json 等嵌套 patch）
  const resolveEnv = (tpl) => {
    if (typeof tpl === 'string') {
      return tpl.replace(/\{BASE\}/g, gwOrigin).replace(/\{KEY\}/g, app.api_key || '');
    }
    if (Array.isArray(tpl)) return tpl.map(resolveEnv);
    if (tpl && typeof tpl === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(tpl)) out[k] = resolveEnv(v);
      return out;
    }
    return tpl;
  };
  // 环境变量编辑文本（VAR=value，每行一条）
  const [envText, setEnvText] = useState(() =>
    app.env ? Object.entries(app.env).map(([k, v]) => `${k}=${resolveEnv(v)}`).join('\n') : '');
  const [writeMsg, setWriteMsg] = useState('');

  function parseEnvText(text) {
    const out = {};
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
    return out;
  }

  async function save() {
    setBusy(true);
    const ids = app.route_multi_select
      ? routeIds.filter(Boolean)
      : (routeId ? [routeId] : []);
    await onUpdate({
      id: app.id, name, icon, description: desc,
      route_id: ids[0] || null,
      route_ids: ids.length ? ids : null,
      model_intercept: modelIntercept.trim() || null,
      ...(app.instance ? { instance: { ...app.instance, dir_glob: dirGlob.trim() || null } } : {}),
      ...(app.env && !app.config_file ? { env: parseEnvText(envText) } : {}),
    });
    setBusy(false);
    onClose();
  }

  async function writeEnv() {
    setWriteMsg('');
    const r = await window.electronAPI?.apps?.writeEnv(parseEnvText(envText)).catch(e => ({ ok: false, error: e.message }));
    if (r?.ok) setWriteMsg(t('gateway.app.envWritten', { count: r.count }));
    else setWriteMsg('✗ ' + (r?.error || t('gateway.common.writeFailed')));
  }

  // config-file 注入：解析 {BASE}/{KEY} 后改目标工具配置文件（如 Codex Desktop ~/.codex/config.toml）
  async function writeConfigFile(force = false) {
    setWriteMsg('');
    const patch = {};
    for (const [k, v] of Object.entries(app.patch || {})) patch[k] = resolveEnv(v);
    const env = {};
    for (const [k, v] of Object.entries(app.env || {})) env[k] = resolveEnv(v);
    const ids = app.route_multi_select
      ? routeIds.filter(Boolean)
      : (routeId ? [routeId] : []);
    const r = await window.electronAPI?.apps?.writeConfigFile({
      app_id: app.id, config_file: app.config_file, patch, env, force,
      route_id: ids[0] || null,
      route_ids: ids.length ? ids : null,
    }).catch(e => ({ ok: false, error: e.message }));
    // 冲突：目标配置项已有不同的值 → 弹确认显示当前值，确认后强制覆盖
    if (r && !r.ok && Array.isArray(r.conflicts) && r.conflicts.length) {
      const lines = r.conflicts.map(c => `· ${c.key}\n${t('gateway.app.conflictCurrent', { val: c.current })}\n${t('gateway.app.conflictWanted', { val: c.wanted })}`).join('\n');
      const ok = window.confirm(t('gateway.app.conflictConfirm', { lines }));
      if (ok) return writeConfigFile(true);   // 用户确认 → 强制覆盖
      setWriteMsg(t('gateway.app.conflictCancelled'));
      return;
    }
    if (r?.ok) {
      setWriteMsg(t('gateway.app.configWritten', { file: r.file, envPart: r.envCount ? t('gateway.app.configWrittenEnvPart', { n: r.envCount }) : '' }));
      setWritten(true);     // 已写入 → 显示「取消 API Key 管理」
      onWritten?.();        // 通知父级：该应用已落地（清除 _isNew，取消时不再删除）
    } else setWriteMsg('✗ ' + (r?.error || t('gateway.common.writeFailed')));
  }

  const ICONS = APP_ICONS;

  // ── 各区块（按布局组合：config-file 应用走两 Tab，其余走单页）──
  const baseInfoSection = (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.basicInfo')}</div>
      <div className="flex gap-2 mb-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder={t('gateway.app.namePlaceholder')}
          className="flex-1 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200" />
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {ICONS.map(e => (
          <button key={e} onClick={() => setIcon(e)} title={e.replace('icon:', '')}
            className={`p-1.5 rounded ${icon === e ? 'bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-400 text-blue-600 dark:text-blue-300' : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
            {appIconSvg(e, 'w-5 h-5')}
          </button>
        ))}
      </div>
      <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder={t('gateway.app.descPlaceholder')} rows={2}
        className="w-full text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none resize-none text-zinc-600 dark:text-zinc-400" />
    </div>
  );

  // 只要有 api_key 就展示（config-file / shim / session 等写入配置时也会用到）
  const apiKeyRow = app.api_key && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">API Key</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 text-zinc-600 dark:text-zinc-400 truncate">{app.api_key}</code>
        <button onClick={() => { navigator.clipboard.writeText(app.api_key); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="text-xs px-2 py-1.5 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300 shrink-0">
          {copied ? t('gateway.common.copied') : t('gateway.common.copy')}
        </button>
        {onRegenKey && (
          <button onClick={() => onRegenKey(app.id)}
            className="text-xs px-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 shrink-0">{t('gateway.common.reset')}</button>
        )}
      </div>
    </div>
  );

  // 官方订阅类应用：纳管说明 + 可选网关接入参数
  const directGuideBody = (() => {
    const raw = app.install_guide || toolboxDefaultGuide(true, app.name || app.agent_id || '', t);
    return String(raw || '')
      .replace(/\{BASE\}/g, gwOrigin)
      .replace(/\{KEY\}/g, app.api_key || '');
  })();
  const directGuideSection = showManualGuide && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.manualGuideTitle')}</div>
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/80 dark:bg-zinc-900/40 px-3 py-2.5">
        <p className="text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">{directGuideBody}</p>
      </div>
      {app.install_url && (
        <button type="button"
          onClick={() => getOauth().openExternal?.(app.install_url)}
          className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline">
          {t('gateway.toolbox.openOfficialLink')}
        </button>
      )}
    </div>
  );
  const directGatewaySection = showManualGuide && app.api_key && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.manualGatewayTitle')}</div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
        {isTraeManual ? t('gateway.app.traeGatewayHint') : t('gateway.app.directKeyHint')}
      </div>
      <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/40 px-3 py-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 shrink-0">Base URL</span>
          <code className="flex-1 text-[11px] font-mono text-zinc-700 dark:text-zinc-200 truncate">{gwOrigin}/v1/chat/completions</code>
          <button type="button"
            onClick={() => { navigator.clipboard.writeText(`${gwOrigin}/v1/chat/completions`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
            className="text-[11px] px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-600 text-zinc-500 shrink-0">
            {copied ? t('gateway.common.copied') : t('gateway.common.copy')}
          </button>
        </div>
      </div>
    </div>
  );
  // Trae：展示当前所选路由对应的模型 ID（供用户在 Trae 内填写）
  const traeRouteVal = app.route_multi_select ? routeIds[0] : routeId;
  const traeModelId = traeRouteVal
    ? exampleModelFromRoute(traeRouteVal, routes, availableModels).model
    : null;
  const traeModelSection = isTraeManual && traeModelId && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.traeModelIdTitle')}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 text-zinc-600 dark:text-zinc-400 truncate">{traeModelId}</code>
        <button type="button"
          onClick={() => { navigator.clipboard.writeText(traeModelId); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="text-[11px] px-2 py-0.5 rounded border border-zinc-200 dark:border-zinc-600 text-zinc-500 shrink-0">
          {copied ? t('gateway.common.copied') : t('gateway.common.copy')}
        </button>
      </div>
      <div className="text-xs text-zinc-400 mt-1">{t('gateway.app.traeModelIdHint')}</div>
    </div>
  );

  const envSection = app.link_method === 'api-key' && app.env && !app.config_file && (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300">{t('gateway.app.envTitle')}</div>
        <button onClick={writeEnv}
          className="text-xs px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white shrink-0">
          {t('gateway.app.writeConfig')}
        </button>
      </div>
      <textarea value={envText} onChange={e => setEnvText(e.target.value)} rows={Math.max(2, envText.split('\n').length)}
        spellCheck={false}
        className="w-full font-mono text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-2 outline-none focus:border-blue-400 text-zinc-700 dark:text-zinc-200 resize-y"
        placeholder={t('gateway.app.envPlaceholder')} />
      {writeMsg && <div className={`text-xs mt-1 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
      <div className="text-xs text-zinc-400 mt-1">
        {t('gateway.app.envHint')}
      </div>
    </div>
  );

  // 配置文件注入（信息展示；写入按钮在底部）
  // Claude Desktop 开发者模式引导（configLibrary 为空时显示）
  const devModeGuide = needDevMode && (
    <div className="rounded-lg border border-amber-300 dark:border-amber-700/50 bg-amber-50/60 dark:bg-amber-950/20 p-3">
      <div className="flex items-center gap-2 mb-2">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px] shrink-0 text-amber-600 dark:text-amber-400">
          <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
        </svg>
        <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">{t('gateway.app.devModeTitle')}</span>
      </div>
      <div className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1 mb-3">
        <p>{t('gateway.app.devModeIntro')}</p>
        <p>{t('gateway.app.devModeStep1')}</p>
        <p>{t('gateway.app.devModeStep2')}</p>
        <p>{t('gateway.app.devModeStep3')}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <div className="text-xs text-zinc-400 mb-1">{t('gateway.app.devModeImg1')}</div>
          <img src={claudeDevModeImg1} alt="Enable Developer Mode" className="rounded border border-zinc-200 dark:border-zinc-700 w-full" />
        </div>
        <div>
          <div className="text-xs text-zinc-400 mb-1">{t('gateway.app.devModeImg2')}</div>
          <img src={claudeDevModeImg2} alt="Configure Gateway" className="rounded border border-zinc-200 dark:border-zinc-700 w-full" />
        </div>
      </div>
      <button
        onClick={async () => {
          const st = await window.electronAPI?.apps?.claudeDevModeStatus?.();
          setClaudeDevMode(st || null);
          if (st?.dev_mode_ready) setWriteMsg(t('gateway.app.devModeReady'));
          else setWriteMsg(t('gateway.app.devModeNotReady'));
        }}
        className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors">
        {t('gateway.app.devModeRefresh')}
      </button>
      {writeMsg && <div className={`text-xs mt-2 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
    </div>
  );

  const configFileSection = app.config_file && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.configFileTitle')}</div>
      <div className="bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg p-2 space-y-1">
        <div className="font-mono text-xs text-zinc-700 dark:text-zinc-300 break-all">{app.config_file}</div>
        {Object.entries(app.patch || {}).map(([k, v]) => (
          <div key={k} className="font-mono text-xs text-zinc-500 break-all">{k} = {resolveEnv(v)}</div>
        ))}
        {Object.keys(app.env || {}).length > 0 && (
          <div className="font-mono text-xs text-zinc-400 pt-1">{t('gateway.app.envVars', { list: Object.keys(app.env).join(', ') })}</div>
        )}
      </div>
      {writeMsg && <div className={`text-xs mt-1 ${writeMsg.startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>{writeMsg}</div>}
      <div className="text-xs text-zinc-400 mt-1">
        {t('gateway.app.configFileHint')}
      </div>
    </div>
  );

  const routeSection = (isKeyApp(app.link_method) || app.link_method === 'shim'
    || (app.link_method === 'session' && app.route_bindable !== false))
    && app.route_bindable !== false && (
    <div className="space-y-3">
      <div>
        <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.routeRules')}</div>
        <RouteSelect
          multi={!!app.route_multi_select}
          value={routeId}
          values={routeIds}
          onChange={app.route_multi_select ? setRouteIds : (v => setRouteId(v || ''))}
          routes={routes}
          availableModels={availableModels}
          t={t}
          isManual={app.link_method === 'manual'}
        />
        {app.route_multi_select && (
          <div className="text-xs text-zinc-400 mt-1">{t('gateway.app.routeMultiHint')}</div>
        )}
      </div>
      {app.link_method === 'manual' && (
        <div>
          <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-1">{t('gateway.app.modelIntercept')}</div>
          <input value={modelIntercept} onChange={e => setModelIntercept(e.target.value)}
            placeholder={t('gateway.app.modelInterceptPlaceholder')}
            className="w-full text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200 font-mono" />
          <div className="text-xs text-zinc-400 mt-1">{t('gateway.app.modelInterceptHint')}</div>
        </div>
      )}
      {/* CLI 多账号实例：账号信息 + 生效目录（默认账号=兜底，无需设目录） */}
      {/* 生效目录：仅当同一工具有 ≥2 个账号实例时才需要（按启动目录分发到不同账号）。
          单实例 = 唯一账号全局生效，无需配目录。默认账号也给输入框，留空即作为兜底。 */}
      {app.instance && instanceCount >= 2 && (
        <div>
          <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-1">{t('gateway.app.instanceDir')}</div>
          {app.instance.account_email && (
            <div className="text-xs text-zinc-400 mb-1.5">
              {t('gateway.app.instanceAccount')}: <span className="font-mono">{app.instance.account_email}</span>
              {app.instance.subscription ? ` · ${app.instance.subscription}` : ''}
            </div>
          )}
          <div className="flex gap-2">
            <input value={dirGlob} onChange={e => setDirGlob(e.target.value)}
              placeholder="~/code/work"
              className="flex-1 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200 font-mono" />
            <button type="button" onClick={async () => { const d = await window.electronAPI?.apps?.selectDirectory?.(); if (d) setDirGlob(d); }}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 shrink-0">
              {t('gateway.app.browse')}
            </button>
          </div>
          <div className="text-xs text-zinc-400 mt-1">{t('gateway.app.instanceDirHint')}</div>
        </div>
      )}
    </div>
  );

  const accessSection = isKeyApp(app.link_method) && app.api_key && !app.env && !app.config_file && (
    <div>
      <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.accessConfig')}</div>
      <KeyConfigPanel apiKey={app.api_key} localBase={localBase || resolveLocalGatewayBase()}
        {...(routeId ? exampleModelFromRoute(routeId, routes, availableModels) : {})}
        hideAuto />
    </div>
  );

  // 当前智能体已投射资源 / 已绑定 MCP（只读）
  const boundAssetsSection = <AppBoundAssetsSection app={app} onClose={dismiss} />;

  const btnSave = (
    <button onClick={save} disabled={busy}
      className="flex-1 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white disabled:opacity-50">
      {busy ? t('gateway.common.saving') : t('gateway.common.save')}
    </button>
  );
  const btnCancel = (
    <button onClick={dismiss}
      className="px-4 py-2 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400">
      {t('gateway.common.cancel')}
    </button>
  );

  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/40" onClick={dismiss}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl mx-4 max-h-[92vh] overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          {(() => {
            const brand = brandIconFor(app);
            if (brand) return <img src={brand} alt="" className="w-6 h-6 object-contain" />;
            return isAppIcon(icon) ? appIconSvg(icon, 'w-6 h-6') : <span className="text-xl">{icon}</span>;
          })()}
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">{app.name || t('gateway.app.settingsTitle')}</h3>
          <button onClick={dismiss} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg">✕</button>
        </div>

        {(isCfg || isShim) ? (
          /* 纳管应用（config-file / 透明托管）：基础信息 + Key + 路由规则 */
          <>
            <div className="p-5 space-y-4">
              {baseInfoSection}{apiKeyRow}{routeSection}{boundAssetsSection}
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-zinc-200 dark:border-zinc-800">
              {btnSave}{btnCancel}
            </div>
          </>
        ) : isTraeManual ? (
          /* Trae Work：手工在 IDE 配置自定义模型 + 路由仅作参考 */
          <>
            <div className="p-5 space-y-4">
              {baseInfoSection}{apiKeyRow}{routeSection}{boundAssetsSection}{directGuideSection}{directGatewaySection}{traeModelSection}
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-zinc-200 dark:border-zinc-800">
              {btnSave}{btnCancel}
            </div>
          </>
        ) : isDirectOnly ? (
          /* 官方订阅 + 会话导入：基础信息 + Key + 手工说明 */
          <>
            <div className="p-5 space-y-4">
              {baseInfoSection}{apiKeyRow}{boundAssetsSection}{directGuideSection}{directGatewaySection}
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-zinc-200 dark:border-zinc-800">
              {btnSave}{btnCancel}
            </div>
          </>
        ) : (
          <>
            <div className="p-5 space-y-4">
              {baseInfoSection}{apiKeyRow}{envSection}{routeSection}{boundAssetsSection}{accessSection}
            </div>
            <div className="flex gap-2 px-5 py-4 border-t border-zinc-200 dark:border-zinc-800">
              {onDelete && isKeyApp(app.link_method) && (
                <button onClick={() => onDelete(app.id)}
                  className="px-4 py-2 text-sm rounded-xl border border-red-200 dark:border-red-900/50 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                  {t('gateway.common.delete')}
                </button>
              )}
              {btnSave}{btnCancel}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// 手工添加面板（弹层）：未被识别的应用 —— 仅给 Key + base_url，用户自行配置指向网关。
// 与 AppSettingsPanel（编辑/桌面应用托管）是两套独立组件。
function ManualAddPanel({ app, routes, availableModels = [], localBase = '', onUpdate, onRegenKey, onSave, onCancel }) {
  const { t } = useLang();
  const [name,           setName]           = useState(app.name || '');
  const [icon,           setIcon]           = useState(app.icon || 'icon:cube');
  const [desc,           setDesc]           = useState(app.description || '');
  const [routeId,        setRouteId]        = useState(() => routeSelectValue(app.route_id, availableModels, routes));
  const [modelIntercept, setModelIntercept] = useState(app.model_intercept || '');
  const [busy,           setBusy]           = useState(false);
  const [copied,         setCopied]         = useState(false);
  const ICONS = APP_ICONS;

  async function save() {
    setBusy(true);
    await onUpdate({
      id: app.id, name, icon, description: desc,
      route_id: routeId || null,
      model_intercept: modelIntercept.trim() || null,
    });
    setBusy(false);
    onSave();
  }

  // 接入类型：api（现有手工 API 应用）| cli（新建 claude/codex 账号实例）
  const [mode, setMode]       = useState('api');
  const [cliTool, setCliTool] = useState('claude-code');
  const [accounts, setAccounts] = useState([]);
  const [acctIdx, setAcctIdx] = useState(0);
  const [cliDir, setCliDir]   = useState('');
  const [cliRoute, setCliRoute] = useState('');
  const [cliBusy, setCliBusy] = useState(false);
  const [cliErr, setCliErr]   = useState('');
  useEffect(() => {
    if (mode !== 'cli') return;
    (async () => {
      const list = await window.electronAPI?.apps?.scanAccounts?.(cliTool).catch(() => []);
      setAccounts(Array.isArray(list) ? list : []);
      setAcctIdx(0);
    })();
  }, [mode, cliTool]);
  async function saveCli() {
    const acct = accounts[acctIdx];
    if (!acct || !acct.config_dir) { setCliErr(t('gateway.app.cliNeedAccount')); return; }
    setCliBusy(true); setCliErr('');
    const r = await window.electronAPI?.apps?.addInstance?.({
      tool: cliTool, config_dir: acct.config_dir, account_email: acct.email,
      subscription: acct.subscription, dir_glob: cliDir.trim() || null, route_id: cliRoute || null,
    }).catch(e => ({ ok: false, error: e.message }));
    setCliBusy(false);
    if (r?.ok) { onCancel(); }   // 删占位草稿 + 刷新，新实例出现在列表
    else setCliErr(r?.error === 'exists' ? t('gateway.app.cliAccountExists') : (r?.error || t('gateway.common.saveFailed')));
  }

  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
      <div
        className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl max-h-[92vh] overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}
      >
      <div className="flex items-center gap-3 px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        {isAppIcon(icon) ? appIconSvg(icon, 'w-6 h-6') : <span className="text-xl">{icon}</span>}
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">{t('gateway.app.newTitle')}</h3>
        <button onClick={onCancel} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg">✕</button>
      </div>
      {/* 接入类型选择 */}
      <div className="px-5 pt-4">
        <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.linkType')}</div>
        <div className="grid grid-cols-2 gap-2">
          {[['api', t('gateway.app.linkTypeApi'), t('gateway.app.linkTypeApiHint')], ['cli', t('gateway.app.linkTypeCli'), t('gateway.app.linkTypeCliHint')]].map(([m, label, hint]) => (
            <button key={m} type="button" onClick={() => setMode(m)}
              className={`text-left rounded-lg border px-3 py-2 transition-colors ${mode === m ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-600' : 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'}`}>
              <div className={`text-xs font-medium ${mode === m ? 'text-blue-700 dark:text-blue-300' : 'text-zinc-700 dark:text-zinc-200'}`}>{label}</div>
              <div className="text-[11px] text-zinc-400 mt-0.5 leading-snug">{hint}</div>
            </button>
          ))}
        </div>
      </div>
      {mode === 'cli' ? (
        <div className="p-5 space-y-4">
          <div>
            <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.cliTool')}</div>
            <div className="flex gap-2">
              {[['claude-code', 'Claude Code'], ['codex', 'Codex']].map(([id, label]) => (
                <button key={id} type="button" onClick={() => setCliTool(id)}
                  className={`flex-1 text-sm rounded-lg border px-3 py-1.5 transition-colors ${cliTool === id ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'}`}>{label}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.cliAccount')}</div>
            {accounts.length === 0 ? (
              <div className="text-xs text-zinc-400">{t('gateway.app.cliNoAccounts')}</div>
            ) : (
              <select value={acctIdx} onChange={e => setAcctIdx(Number(e.target.value))}
                className="w-full text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none text-zinc-800 dark:text-zinc-200">
                {accounts.map((a, i) => (
                  <option key={i} value={i} disabled={a.already_added || !a.config_dir}>
                    {(a.email || a.config_dir)}{a.subscription ? ` · ${a.subscription}` : ''}{a.already_added ? ` · ${t('gateway.app.cliAlreadyAdded')}` : (!a.config_dir ? ` · ${t('gateway.app.cliNoLocal')}` : '')}
                  </option>
                ))}
              </select>
            )}
            <div className="text-[11px] text-zinc-400 mt-1">{t('gateway.app.cliAccountHint')}</div>
          </div>
          <div>
            <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.instanceDir')}</div>
            <div className="flex gap-2">
              <input value={cliDir} onChange={e => setCliDir(e.target.value)} placeholder="~/code/work"
                className="flex-1 text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200 font-mono" />
              <button type="button" onClick={async () => { const d = await window.electronAPI?.apps?.selectDirectory?.(); if (d) setCliDir(d); }}
                className="text-xs px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50 shrink-0">{t('gateway.app.browse')}</button>
            </div>
            <div className="text-[11px] text-zinc-400 mt-1">{t('gateway.app.instanceDirHint')}</div>
          </div>
          <div>
            <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.routeRules')}</div>
            <RouteSelect value={cliRoute} onChange={v => setCliRoute(v || '')} routes={routes} availableModels={availableModels} t={t} />
            <div className="text-[11px] text-zinc-400 mt-1">{t('gateway.app.cliRouteHint')}</div>
          </div>
          {cliErr && <div className="text-xs text-red-500">{cliErr}</div>}
          <div className="flex justify-end gap-2">
            <button onClick={onCancel} className="text-sm px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700/50">{t('gateway.common.cancel')}</button>
            <button onClick={saveCli} disabled={cliBusy}
              className="text-sm px-4 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 text-white disabled:opacity-50">{cliBusy ? '…' : t('gateway.app.cliAddInstance')}</button>
          </div>
        </div>
      ) : (
      <>
      <div className="p-5 space-y-4">
        {/* 基础信息 */}
        <div>
          <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.basicInfo')}</div>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={t('gateway.app.namePlaceholder')}
            className="w-full text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200 mb-2" />
          <div className="flex flex-wrap gap-1.5 mb-2">
            {ICONS.map(e => (
              <button key={e} onClick={() => setIcon(e)} title={e.replace('icon:', '')}
                className={`p-1.5 rounded ${icon === e ? 'bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-400 text-blue-600 dark:text-blue-300' : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}>
                {appIconSvg(e, 'w-5 h-5')}
              </button>
            ))}
          </div>
          <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder={t('gateway.app.descPlaceholder')} rows={2}
            className="w-full text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none resize-none text-zinc-600 dark:text-zinc-400" />
        </div>
        {/* API Key */}
        {app.api_key && (
          <div>
            <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">API Key</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5 text-zinc-600 dark:text-zinc-400 truncate">{app.api_key}</code>
              <button onClick={() => { navigator.clipboard.writeText(app.api_key); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                className="text-xs px-2 py-1.5 rounded bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-600 dark:text-zinc-300 shrink-0">
                {copied ? t('gateway.common.copied') : t('gateway.common.copy')}
              </button>
              {onRegenKey && (
                <button onClick={() => onRegenKey(app.id)}
                  className="text-xs px-2 py-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 shrink-0">{t('gateway.common.reset')}</button>
              )}
            </div>
          </div>
        )}
        {/* 路由规则 */}
        <div>
          <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.routeRules')}</div>
          <select value={routeId} onChange={e => setRouteId(e.target.value)}
            className="w-full text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none text-zinc-800 dark:text-zinc-200">
            {/* 手工添加无官方可直连 → 必须绑定 */}
            <option value="" disabled>{t('gateway.app.routeRequired')}</option>
            {(() => {
              const usable = usableSceneRoutes(routes, availableModels);
              return usable.length > 0 && (
                <optgroup label={t('gateway.app.sceneRoutes')}>
                  {usable.map(r => <option key={r.id} value={r.model_key || r.id}>{r.icon && !r.icon.startsWith('icon:') ? r.icon + ' ' : ''}{r.scene_name}</option>)}
                </optgroup>
              );
            })()}
            {tierOptgroups(availableModels, t)}
          </select>
        </div>
        {/* 模型拦截：工具发过来的真实模型名 → 转发到上面选的路由 */}
        <div>
          <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-1">{t('gateway.app.modelIntercept')}</div>
          <input value={modelIntercept} onChange={e => setModelIntercept(e.target.value)}
            placeholder={t('gateway.app.modelInterceptPlaceholder')}
            className="w-full text-sm bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg px-3 py-1.5 outline-none focus:border-blue-400 text-zinc-800 dark:text-zinc-200 font-mono" />
          <div className="text-xs text-zinc-400 mt-1">{t('gateway.app.modelInterceptHint')}</div>
        </div>
        {/* 已绑定资源 / MCP（API 应用按 app.id 匹配中转） */}
        <AppBoundAssetsSection app={app} onClose={onCancel} />
        {/* 接入配置：Key + base_url + 示例（用户自行把应用指向网关）*/}
        {app.api_key && (
          <div>
            <div className="text-sm font-medium text-zinc-600 dark:text-zinc-300 mb-2">{t('gateway.app.accessConfigHint')}</div>
            <KeyConfigPanel apiKey={app.api_key} localBase={localBase || resolveLocalGatewayBase()}
              {...(routeId ? exampleModelFromRoute(routeId, routes, availableModels) : {})}
              hideAuto />
          </div>
        )}
      </div>
      <div className="flex gap-2 px-5 py-4 border-t border-zinc-200 dark:border-zinc-800">
        <button onClick={save} disabled={busy}
          className="flex-1 py-2 text-sm rounded-xl bg-blue-600 hover:bg-blue-700 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white disabled:opacity-50">
          {busy ? t('gateway.common.saving') : t('gateway.common.save')}
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 text-sm rounded-xl border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400">
          {t('gateway.common.cancel')}
        </button>
      </div>
      </>
      )}
      </div>
    </div>,
    document.body,
  );
}

// Trace 顶栏指标 pill（参考 tokentelemetry）
function TraceStatPill({ label, value, tone }) {
  const toneCls = tone === 'blue' ? 'text-blue-600 dark:text-blue-400'
    : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : tone === 'red' ? 'text-red-600 dark:text-red-400'
    : tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'cyan' ? 'text-cyan-600 dark:text-cyan-400'
    : 'text-zinc-800 dark:text-zinc-100';
  return (
    <div className="inline-flex items-center gap-1 bg-zinc-50 dark:bg-zinc-800/60 border border-zinc-200 dark:border-zinc-700 rounded-md px-2 h-7">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${toneCls}`}>{value}</span>
    </div>
  );
}

/** Trace 里 agent_id 缩写（对齐 tokentelemetry analytics 展示） */
function shortTraceAgent(agentId) {
  if (!agentId) return '';
  const id = String(agentId);
  if (id.startsWith('claude')) return 'claude';
  if (id === 'codex' || id.startsWith('codex')) return 'codex';
  if (id.includes('cursor')) return 'cursor';
  if (id.includes('workbuddy')) return 'workbuddy';
  return id;
}

function fmtCompactTok(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

// Session Trace 弹窗（参考 tokentelemetry，简化版）
function SessionTraceModal({ app, sessionId, traceAgentId, onClose }) {
  const { t } = useLang();
  const [trace, setTrace]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [stepIdx, setStepIdx] = useState(0);
  const [toolsOpen, setToolsOpen] = useState(false);   // 工具调用统计默认折叠
  const agentId = traceAgentId || app?.agent_id;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setStepIdx(0);
    Promise.resolve(getApps().sessionTrace?.(agentId, sessionId))
      .then(t => { if (alive) { setTrace(t); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [app, sessionId, agentId]);

  const steps = trace?.steps || [];
  const cur   = steps[stepIdx] || null;
  const st    = trace?.stats || {};
  const tok   = st.tokens || {};
  const fmtN  = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n ?? 0));
  const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
  const clientLabel = CLIENT_LABELS[trace?.client] || trace?.client || agentId || 'agent';

  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-4xl mx-4 max-h-[92vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0 space-y-2">
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 text-sm">{t('gateway.common.back')}</button>
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 shrink-0">Session Trace</h3>
            <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400 shrink-0" title={trace?.entrypoint ? `entrypoint: ${trace.entrypoint}` : undefined}>{clientLabel}</span>
            <span className="font-mono text-xs text-zinc-400 flex-1 text-right truncate select-all cursor-text" title={sessionId}>{sessionId}</span>
          </div>
          {!loading && !trace?.error && st.steps != null && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <TraceStatPill label="Steps" value={st.steps} />
              <TraceStatPill label="Tools" value={st.tools ?? 0} tone="blue" />
              {(st.skills ?? 0) > 0 && <TraceStatPill label="Skill" value={st.skills} tone="emerald" />}
              {(st.artifacts ?? 0) > 0 && <TraceStatPill label="Arts" value={st.artifacts} tone="emerald" />}
              <TraceStatPill label="Reason" value={st.reasoning ?? 0} tone="amber" />
              <TraceStatPill label="Turns" value={st.turns ?? 0} />
              <TraceStatPill label="Dur" value={st.duration || '—'} />
              <TraceStatPill label="Err" value={st.errors ?? 0} tone={(st.errors ?? 0) > 0 ? 'red' : undefined} />
              <div className="hidden sm:flex items-center gap-2 ml-1 px-2 h-7 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40">
                <span className="text-xs text-zinc-400">INPUT <strong className="text-zinc-700 dark:text-zinc-200">{fmtN(tok.input)}</strong></span>
                <span className="text-zinc-300">|</span>
                <span className="text-xs text-zinc-400">OUTPUT <strong className="text-zinc-700 dark:text-zinc-200">{fmtN(tok.output)}</strong></span>
                <span className="text-zinc-300">|</span>
                <span className="text-xs text-zinc-400">CACHED <strong className="text-cyan-600 dark:text-cyan-400">{fmtN(tok.cached)}</strong></span>
              </div>
            </div>
          )}
        </div>

        {loading ? (
          <div className="py-16 flex justify-center text-xs text-zinc-400">{t('gateway.trace.loading')}</div>
        ) : trace?.error ? (
          <div className="py-16 text-center text-xs text-zinc-400">{t('gateway.trace.notFound')}</div>
        ) : (
          <>
            {/* 会话元信息：路径单独一行，避免 truncate 截断 */}
            <div className="px-5 py-2 text-xs text-zinc-500 dark:text-zinc-400 border-b border-zinc-100 dark:border-zinc-800 shrink-0 space-y-1">
              <div>
                {t('gateway.detail.projectLabel')}{' '}
                <strong className="text-zinc-700 dark:text-zinc-300">{trace.project || '—'}</strong>
              </div>
              {projectPathTooltip(trace) !== '—' && (
                <div
                  className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 break-all leading-relaxed select-all"
                  title={projectPathTooltip(trace)}
                >
                  {projectPathTooltip(trace)}
                </div>
              )}
            </div>

            {/* 生态用量：Subagent / Skills / MCP（对齐 tokentelemetry analytics）+ 工具汇总 */}
            {(st.subagent_types?.length > 0 || st.skills_used?.length > 0 || st.mcp_servers?.length > 0
              || st.toolBreakdown?.length > 0) && (
              <div className="px-5 py-2.5 border-b border-zinc-100 dark:border-zinc-800 shrink-0 space-y-2">
                <button type="button" onClick={() => setToolsOpen(o => !o)}
                  className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                  <span className={`transition-transform ${toolsOpen ? 'rotate-90' : ''}`}>▸</span>
                  {t('gateway.trace.ecosystemSummary')}
                  <span className="text-zinc-300 dark:text-zinc-600 normal-case font-normal">
                    {[
                      st.subagent_types?.length ? `${st.subagent_types.length} subagent` : null,
                      st.skills_used?.length ? `${st.skills_used.length} skill` : null,
                      st.mcp_servers?.length ? `${st.mcp_servers.length} mcp` : null,
                      st.tools ? `${st.tools} tools` : null,
                    ].filter(Boolean).join(' · ')}
                  </span>
                </button>
                {toolsOpen && (
                  <div className="space-y-3">
                    {/* Subagent types */}
                    {st.subagent_types?.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-500/80 mb-1.5">
                          {t('gateway.trace.subagentTypes')}
                        </div>
                        <ul className="space-y-1.5">
                          {st.subagent_types.map(row => (
                            <li key={row.name} className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="min-w-0 flex flex-col">
                                <span className="font-mono text-zinc-800 dark:text-zinc-200 truncate" title={row.name}>{row.name}</span>
                                <span className="text-zinc-400">
                                  {row.spawns} spawn{row.spawns === 1 ? '' : 's'}
                                  {trace?.agent ? ` · ${shortTraceAgent(trace.agent)}` : ''}
                                </span>
                              </span>
                              <span className="text-right shrink-0 tabular-nums">
                                {(row.cost > 0 || row.tokens > 0) ? (
                                  <>
                                    <span className="block font-semibold text-amber-600 dark:text-amber-400">${(row.cost || 0).toFixed(2)}</span>
                                    <span className="block text-zinc-400">{fmtCompactTok(row.tokens)} tok</span>
                                  </>
                                ) : (
                                  <span className="text-zinc-400">tokens n/a</span>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Skills used */}
                    {st.skills_used?.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600/80 mb-1.5">
                          {t('gateway.trace.skillsUsed')}
                        </div>
                        <ul className="space-y-1.5">
                          {st.skills_used.map(s => (
                            <li key={s.name} className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="min-w-0">
                                <span className="font-mono text-zinc-800 dark:text-zinc-200 truncate block" title={s.name}>
                                  /{String(s.name).replace(/^\//, '')}
                                </span>
                                {trace?.agent && (
                                  <span className="text-[10px] text-zinc-400">{shortTraceAgent(trace.agent)}</span>
                                )}
                              </span>
                              <span className="tabular-nums text-zinc-400 whitespace-nowrap shrink-0">
                                ×{s.count}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* MCP servers */}
                    {st.mcp_servers?.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-600/80 mb-1.5">
                          {t('gateway.trace.mcpServers')}
                        </div>
                        <ul className="space-y-2">
                          {st.mcp_servers.map(m => (
                            <li key={m.name} className="text-[11px]">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-zinc-800 dark:text-zinc-200 truncate" title={m.name}>{m.name}</span>
                                <span className="tabular-nums text-zinc-400 whitespace-nowrap shrink-0">
                                  {m.calls} calls
                                </span>
                              </div>
                              {m.tools?.length > 0 && (
                                <div className="text-[10px] text-zinc-400 mt-0.5 truncate" title={m.tools.map(x => `${x.name} ×${x.count}`).join(' · ')}>
                                  {shortTraceAgent(trace?.agent)}
                                  {trace?.agent ? ' · ' : ''}
                                  {m.tools.slice(0, 4).map(x => `${x.name} ×${x.count}`).join(' · ')}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* 工具明细（折叠区内继续保留） */}
                    {st.toolBreakdown?.length > 0 && (
                      <div>
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400 mb-1.5">
                          {t('gateway.trace.toolSummary')}
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
                          {st.toolBreakdown.map(({ name, count }) => {
                            const max = st.toolBreakdown[0]?.count || 1;
                            const short = name.startsWith('mcp__') ? name.split('__').slice(-1)[0] : name;
                            return (
                              <div key={name} className="flex items-center gap-2 min-w-0" title={name}>
                                <span className="text-xs text-zinc-600 dark:text-zinc-300 truncate flex-1">{short}</span>
                                <span className="text-xs font-semibold tabular-nums text-zinc-400">×{count}</span>
                                <div className="w-10 h-1 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden shrink-0">
                                  <div className="h-full bg-blue-500/70" style={{ width: `${(count / max) * 100}%` }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-1 min-h-0">
              {/* 步骤索引 */}
              <div className="w-44 shrink-0 border-r border-zinc-100 dark:border-zinc-800 overflow-y-auto max-h-[55vh]">
                {steps.map((s, i) => (
                  <button key={i} onClick={() => setStepIdx(i)}
                    className={`w-full text-left px-3 py-1.5 text-xs border-b border-zinc-50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${stepIdx === i ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'text-zinc-600 dark:text-zinc-400'}`}>
                    <span className="text-zinc-400 mr-1">{String(i).padStart(3, '0')}</span>
                    <span className={`px-1 rounded text-xs mr-1 ${
                      s.kind === 'tool' ? (s.skill ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400')
                      : s.kind === 'tool_result' ? (s.is_error ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400')
                      : s.kind === 'user' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30'
                      : s.reasoning ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20'
                      : 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800'}`}>
                      {s.kind === 'tool' ? (s.skill ? 'SKILL' : s.tool || s.label)
                        : s.kind === 'tool_result' ? 'OUT'
                        : s.kind === 'user' ? 'USER'
                        : s.reasoning ? 'REASON' : 'AI'}
                    </span>
                    <span className="truncate block">{s.label}</span>
                  </button>
                ))}
              </div>

              {/* 步骤详情 */}
              <div className="flex-1 p-4 overflow-y-auto max-h-[55vh]">
                {cur ? (
                  <div className="space-y-2">
                    <div className="text-xs text-zinc-400 flex items-center gap-2">
                      <span>{fmtTime(cur.ts)} · {cur.label}</span>
                      {cur.kind === 'tool_result' && cur.is_error && (
                        <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] font-semibold">ERROR</span>
                      )}
                      {cur.encrypted && (
                        <span className="px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 text-[10px] font-semibold">{t('gateway.trace.encrypted')}</span>
                      )}
                    </div>
                    {cur.text && (
                      <pre className={`text-xs whitespace-pre-wrap break-words rounded-lg p-3 max-h-80 overflow-y-auto ${cur.kind === 'tool_result' && cur.is_error ? 'text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/10' : 'text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-800/50'}`}>{cur.text}</pre>
                    )}
                    {cur.encrypted && !cur.text && (
                      <div className="text-xs bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 space-y-1.5">
                        <p className="text-zinc-500 dark:text-zinc-400 italic">{t('gateway.trace.encryptedNote')}</p>
                        {cur.signature && <p className="font-mono text-[10px] text-zinc-400 break-all">sig: {cur.signature}…</p>}
                      </div>
                    )}
                    {cur.reasoning && !cur.text && !cur.encrypted && (
                      <div className="text-xs text-zinc-400 italic">{t('gateway.trace.noReasoning')}</div>
                    )}
                    {cur.input != null && (
                      <pre className="text-xs font-mono text-zinc-600 dark:text-zinc-400 whitespace-pre-wrap break-all bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 max-h-60 overflow-y-auto">
                        {typeof cur.input === 'string' ? cur.input : JSON.stringify(cur.input, null, 2)}
                      </pre>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-zinc-400">{t('gateway.trace.selectStep')}</div>
                )}
              </div>
            </div>

            {/* 步骤进度条 */}
            {steps.length > 1 && (
              <div className="px-5 py-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0">
                <div className="flex items-center gap-3 text-xs text-zinc-400 mb-1">
                  <span>Step {stepIdx + 1} / {steps.length}</span>
                  <span className="flex-1" />
                  <span>{cur?.label}</span>
                </div>
                <input type="range" min={0} max={steps.length - 1} value={stepIdx}
                  onChange={e => setStepIdx(+e.target.value)}
                  className="w-full h-1 accent-blue-600 cursor-pointer" />
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

const GLOBAL_KEY = '__global__';

/** 把提炼出的 markdown 拆成「全局」+「每个项目」段。
 *  顶级 # 全局级 → global；# 项目级 下的二级 ## <项目名> → 各为一个项目段。
 *  首部说明注释（preamble）前缀到每段，使每个保存的文件都自带生成说明。 */
function splitMemory(md = '') {
  const text = String(md).trim();
  const out = { preamble: '', global: '', projects: [] };
  if (!text) return out;
  const firstH = text.search(/^#\s+/m);
  if (firstH === -1) { out.global = text; return out; }       // 无标题兜底 → 全归全局
  out.preamble = firstH > 0 ? text.slice(0, firstH).trim() : '';
  const l1 = text.slice(firstH).split(/(?=^#\s+)/m).filter(s => s.trim());
  for (const sec of l1) {
    const head = sec.match(/^#\s+(.*)$/m)?.[1] || '';
    if (/项目|project/i.test(head)) {
      const afterHeader = sec.replace(/^#\s+.*\n?/m, '');     // 去掉「# 项目级」行
      const parts = afterHeader.split(/(?=^##\s+)/m).filter(s => s.trim());
      for (const pp of parts) {
        const name = pp.match(/^##\s+(.*)$/m)?.[1]?.trim() || '项目';
        out.projects.push({ name, body: pp.trim() });
      }
    } else if (/全局|global/i.test(head)) {
      out.global = out.global ? `${out.global}\n\n${sec.trim()}` : sec.trim();
    } else {
      out.global = out.global ? `${out.global}\n\n${sec.trim()}` : sec.trim();   // 未知顶级段归全局
    }
  }
  return out;
}

/** 记忆提炼：后台异步任务。点「生成」后台跑，关掉再点也行；
 *  完成后按「全局 + 每个项目」分 tab 展示，按需查看/编辑，保存各自的 AGENTS.md。 */
function PreferenceMiningModal({ onClose, flash, onJobStart }) {
  const { t } = useLang();
  const [job, setJob]     = useState({ status: 'idle', ok: false, model: null, scanned: 0, error: null });
  const [parsed, setParsed]   = useState({ preamble: '', global: '', projects: [] });
  const [paths, setPaths]     = useState({});      // 项目名 → 本机路径
  const [edits, setEdits]     = useState({});      // tabKey → 可编辑文本
  const [tabKey, setTabKey]   = useState(GLOBAL_KEY);
  const [dirty, setDirty]     = useState(false);   // 用户编辑过就不再被轮询结果覆盖
  const [availModels, setAvailModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');

  useEffect(() => {
    loadGatewayAvailableModels().then(all => {
      // 只展示 Personal 模型（free/paid），与 Scene routes 保持一致
      const ids = all.filter(m => m.tier === 'free' || m.tier === 'paid').map(m => m.id);
      if (ids.length) { setAvailModels(ids); setSelectedModel(ids[0]); }
    }).catch(() => {});
  }, []);

  const fetchResult = useCallback(async () => {
    const r = await window.electronAPI.sessions.knowledgeResult().catch(() => null);
    if (!r) return null;
    setJob({ status: r.status, ok: !!r.ok, model: r.model || null, scanned: r.scanned || 0, error: r.error || null });
    if (r.status === 'ready' && !dirty) {
      const p = splitMemory(r.content || '');
      const pre = p.preamble ? p.preamble + '\n\n' : '';
      const map = { [GLOBAL_KEY]: p.global ? pre + p.global : '' };
      for (const proj of p.projects) map[proj.name] = pre + proj.body;
      setParsed(p);
      setPaths(r.projectPaths || {});
      setEdits(map);
      // 默认 tab：全局有内容则全局，否则第一个项目。
      setTabKey(p.global ? GLOBAL_KEY : (p.projects[0]?.name || GLOBAL_KEY));
    }
    return r;
  }, [dirty]);

  useEffect(() => { fetchResult(); }, [fetchResult]);

  // 生成中时轮询，完成自动刷新；用户可随时关闭弹窗，下次打开仍能拿到结果。
  useEffect(() => {
    if (job.status !== 'running') return;
    const id = setInterval(fetchResult, 2500);
    return () => clearInterval(id);
  }, [job.status, fetchResult]);

  const start = async () => {
    setDirty(false); setEdits({}); setParsed({ preamble: '', global: '', projects: [] }); setTabKey(GLOBAL_KEY);
    await window.electronAPI.sessions.knowledgeStart(selectedModel ? { model: selectedModel } : {});
    setJob(j => ({ ...j, status: 'running' }));
    onJobStart?.();
  };

  // tab 列表：全局（始终有）+ 每个项目。
  const tabDefs = [{ key: GLOBAL_KEY, label: t('gateway.mine.tabGlobal'), dir: null }]
    .concat(parsed.projects.map(p => ({ key: p.name, label: p.name, dir: paths[p.name] || null })));
  const activeTab = tabDefs.find(d => d.key === tabKey) || tabDefs[0];
  const activeText = edits[tabKey] || '';

  const save = async () => {
    const dir = activeTab?.dir;
    const defaultPath = dir ? `${dir.replace(/\/+$/, '')}/AGENTS.md` : undefined;
    const r = await window.electronAPI.sessions.saveAgentsMd({ content: activeText, defaultPath });
    if (r?.ok) flash(t('gateway.mine.saved').replace('{file}', r.file));
    else if (!r?.canceled) flash(t('gateway.mine.saveFailed'));
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(activeText); flash(t('gateway.sessions.copied')); } catch {}
  };

  const ready = job.status === 'ready' || job.status === 'error';

  // 挂到 body，避免被会话卡片 overflow / transform 裁切
  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0 flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px] shrink-0 text-violet-500">
              <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
            </svg>
            <span className="truncate">{t('gateway.mine.title')}</span>
          </h3>
          {availModels.length > 0 && (
            <select
              value={selectedModel}
              onChange={e => setSelectedModel(e.target.value)}
              disabled={job.status === 'running'}
              className="text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 px-2 py-1 max-w-[180px] truncate disabled:opacity-50"
            >
              {availModels.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          )}
          {ready && job.ok && (
            <span className="text-xs text-zinc-400">{t('gateway.mine.stat').replace('{model}', job.model || '').replace('{sessions}', job.scanned)}</span>
          )}
        </div>

        {job.status === 'idle' ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
            <div className="text-xs text-zinc-400 max-w-sm">{t('gateway.mine.idleHint')}</div>
            <button onClick={start} className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg bg-violet-500 hover:bg-violet-600 text-white">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0">
                <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
              </svg>
              {t('gateway.mine.generate')}
            </button>
          </div>
        ) : job.status === 'running' ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16 px-6 text-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-8 h-8 text-violet-500 animate-pulse">
              <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
            </svg>
            <div className="text-xs text-zinc-500">{t('gateway.mine.running')}</div>
            <div className="text-[11px] text-zinc-400 max-w-sm">{t('gateway.mine.runningHint')}</div>
            <button onClick={onClose} className="mt-2 text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500">{t('gateway.mine.closeKeep')}</button>
          </div>
        ) : (
          <>
            <div className="px-5 py-2 border-b border-zinc-100 dark:border-zinc-800 text-xs shrink-0">
              {job.ok
                ? <span className="text-zinc-400">{t('gateway.mine.previewHint')}</span>
                : <span className="text-amber-600 dark:text-amber-400">{job.error === 'no_corpus' ? t('gateway.mine.empty') : t('gateway.mine.modelUnavailable')}</span>}
            </div>
            {/* tab 条：全局 + 每个项目（项目多时横向滚动）*/}
            {job.ok && (
              <div className="px-3 pt-2 shrink-0 flex items-center gap-1 overflow-x-auto">
                {tabDefs.map(d => (
                  <button key={d.key} onClick={() => setTabKey(d.key)} title={d.dir || d.label}
                    className={`text-xs px-3 py-1.5 rounded-lg whitespace-nowrap transition-colors ${
                      tabKey === d.key
                        ? 'bg-violet-500 text-white'
                        : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-700/50'
                    }`}>{d.label}</button>
                ))}
              </div>
            )}
            <div className="flex-1 overflow-y-auto p-3">
              <textarea value={activeText} onChange={e => { setEdits(prev => ({ ...prev, [tabKey]: e.target.value })); setDirty(true); }} spellCheck={false}
                placeholder={t('gateway.mine.tabEmpty')}
                className="w-full h-full min-h-[320px] text-xs font-mono leading-relaxed text-zinc-700 dark:text-zinc-200 bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3 border border-zinc-200 dark:border-zinc-700 focus:outline-none focus:border-violet-400 resize-none" />
            </div>
            <div className="px-5 py-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0 flex flex-col sm:flex-row sm:items-center gap-2">
              <button onClick={start} className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 shrink-0">↻ {t('gateway.mine.regenerate')}</button>
              {activeTab?.dir && (
                <span
                  className="text-[11px] font-mono text-zinc-400 break-all leading-relaxed min-w-0 flex-1"
                  title={`${activeTab.dir}/AGENTS.md`}
                >
                  → {activeTab.dir}/AGENTS.md
                </span>
              )}
              <div className="ml-auto flex gap-2 shrink-0">
                <button onClick={copy} disabled={!activeText} className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 disabled:opacity-40">{t('gateway.mine.copy')}</button>
                <button onClick={save} disabled={!activeText} className="text-xs px-3 py-1.5 rounded-lg bg-violet-500 hover:bg-violet-600 text-white disabled:opacity-40">{t('gateway.mine.save')}</button>
                <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500">{t('gateway.sessions.close')}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 会话管理面板：跨 agent 聚合 + 搜索/过滤 + 收藏/标签/归档 + 导出 */
function SessionManager() {
  const { t } = useLang();
  const [rows, setRows]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [q, setQ]                 = useState('');
  const [agentFilter, setAgent]   = useState('all');
  const [favOnly, setFavOnly]     = useState(false);
  const [traceRow, setTraceRow]   = useState(null);
  const [contState, setContState] = useState(null);
  const [handoffTargets, setHandoffTargets] = useState([]);
  const [mining, setMining]       = useState(false);
  const [kStatus, setKStatus]     = useState('idle'); // 知识提炼后台任务状态
  const [notice, setNotice]       = useState('');
  const fmtN = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n ?? 0));

  const reload = useCallback(() => {
    if (!window.electronAPI?.sessions) { setLoading(false); return; }
    setLoading(true);
    window.electronAPI.sessions.listAll({})
      .then(r => { setRows(Array.isArray(r) ? r : []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    window.electronAPI?.apps?.handoffTargets?.()
      .then(r => setHandoffTargets(Array.isArray(r) ? r : []))
      .catch(() => setHandoffTargets([]));
  }, []);

  // 知识提炼后台任务：进页面拉一次状态；running 时轮询，让工具栏按钮显示 loading。
  useEffect(() => {
    if (!window.electronAPI?.sessions?.knowledgeResult) return;
    let alive = true;
    const tick = () => window.electronAPI.sessions.knowledgeResult()
      .then(r => { if (alive && r) setKStatus(r.status); }).catch(() => {});
    tick();
    const id = setInterval(() => { if (kStatus === 'running') tick(); }, 2500);
    return () => { alive = false; clearInterval(id); };
  }, [kStatus]);

  const setMeta = async (row, patch) => {
    // 乐观更新本地行，避免收藏/标签每次触发全量扫盘
    setRows(prev => prev.map(r => (
      r.agent_id === row.agent_id && r.session_id === row.session_id
        ? { ...r, ...patch }
        : r
    )));
    await window.electronAPI.sessions.setMeta({
      agent_id: row.agent_id, session_id: row.session_id, ...patch,
    });
  };

  const flash = msg => { setNotice(msg); setTimeout(() => setNotice(''), 2500); };

  const doExport = async (row, format) => {
    const res = await window.electronAPI.sessions.export({
      agent_id: row.agent_id, trace_agent_id: row.trace_agent_id,
      session_id: row.session_id, format,
    });
    if (res?.error || !res?.ok) { flash(t('gateway.sessions.exportFailed')); return; }
    if (format === 'copy') {
      try { await navigator.clipboard.writeText(res.content); flash(t('gateway.sessions.copied')); }
      catch { flash(t('gateway.sessions.exportFailed')); }
      return;
    }
    flash(t('gateway.sessions.exported').replace('{file}', res.file));
  };

  // 按展示客户端分组（Claude Desktop / Claude Code 等），与应用列表拆分保持一致
  const rowClient = r => r.client || r.agent_id;
  const agents = Array.from(new Set(rows.map(rowClient)));
  const filtered = rows.filter(r => {
    if (agentFilter !== 'all' && rowClient(r) !== agentFilter) return false;
    if (favOnly && !r.favorite) return false;
    if (q) {
      const hay = `${r.project || ''} ${r.context || ''}`.toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });
  const favCount = rows.filter(r => r.favorite).length;

  if (!window.electronAPI?.sessions) {
    return <div className="px-5 py-16 text-center text-xs text-zinc-400">{t('gateway.sessions.desktopOnly')}</div>;
  }

  return (
    <div>
      {traceRow && (
        <SessionTraceModal app={null} sessionId={traceRow.session_id}
          traceAgentId={traceRow.trace_agent_id || traceRow.agent_id} onClose={() => setTraceRow(null)} />
      )}
      {contState && (
        <ContinueModal source={contState.row} target={contState.target} handoffTargets={handoffTargets} onClose={() => setContState(null)} />
      )}
      {mining && (
        <PreferenceMiningModal onClose={() => setMining(false)} flash={flash} onJobStart={() => setKStatus('running')} />
      )}

      {/* 操作栏 */}
      <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 space-y-2">
        {/* 第一行：搜索 + 统计（两端对齐）*/}
        <div className="flex items-center gap-3">
          <div className="relative flex-1 min-w-[180px]">
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder={t('gateway.sessions.search')}
              className="w-full text-xs pl-3 pr-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800" />
          </div>
          <div className="flex gap-3 text-xs text-zinc-400 shrink-0">
            <span><strong className="text-zinc-700 dark:text-zinc-200">{rows.length}</strong> {t('gateway.sessions.statSessions')}</span>
            <span><strong className="text-zinc-700 dark:text-zinc-200">{agents.length}</strong> {t('gateway.sessions.statAgents')}</span>
            <span><strong className="text-zinc-700 dark:text-zinc-200">{favCount}</strong> {t('gateway.sessions.statFav')}</span>
          </div>
          <button onClick={() => setMining(true)}
            className="text-xs px-3 py-1.5 rounded-full border border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 flex items-center gap-1.5 shrink-0">
            {kStatus === 'running'
              ? <><span className="inline-block w-3 h-3 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />{t('gateway.mine.busy')}</>
              : <>
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5 shrink-0">
                    <path d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456ZM16.894 20.567 16.5 21.75l-.394-1.183a2.25 2.25 0 0 0-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 0 0 1.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 0 0 1.423 1.423l1.183.394-1.183.394a2.25 2.25 0 0 0-1.423 1.423Z" />
                  </svg>
                  {t('gateway.mine.button')}
                </>}
          </button>
        </div>
        {/* 第二行：产品过滤芯片 */}
        <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => setAgent('all')}
          className={`text-xs px-3 py-1.5 rounded-full ${agentFilter === 'all' ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'border border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
          {t('gateway.sessions.all')}
        </button>
        <button onClick={() => setFavOnly(v => !v)}
          className={`text-xs px-3 py-1.5 rounded-full ${favOnly ? 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400' : 'border border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
          ★ {t('gateway.sessions.favOnly')}
        </button>
        {agents.map(a => {
          const brand = resolveBrandIcon(a);
          return (
            <button key={a} onClick={() => setAgent(a)}
              className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full ${agentFilter === a ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400' : 'border border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
              {brand && <img src={brand} alt="" className="w-3.5 h-3.5 object-contain shrink-0" />}
              {CLIENT_LABELS[a] || a}
            </button>
          );
        })}
        </div>
      </div>

      {notice && <div className="px-5 py-1.5 text-xs text-green-600 dark:text-green-400">{notice}</div>}

      {/* 列表 */}
      <div className="max-h-[60vh] overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {loading ? (
          <div className="px-5 py-16 text-center text-xs text-zinc-400">…</div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-16 text-center text-xs text-zinc-400">{t('gateway.sessions.empty')}</div>
        ) : filtered.map(row => (
          <SessionRow key={`${row.agent_id}-${row.session_id}`} row={row} fmtN={fmtN}
            handoffTargets={handoffTargets}
            onTrace={() => setTraceRow(row)} onMeta={patch => setMeta(row, patch)} onExport={fmt => doExport(row, fmt)}
            onContinue={target => setContState({ row, target })} />
        ))}
      </div>
    </div>
  );
}

// 会话来源客户端展示名（jsonl entrypoint 等，仅用于显示）
const CLIENT_LABELS = {
  'claude-desktop': 'Claude Desktop',
};

/** 单会话行 */
function SessionRow({ row, fmtN, handoffTargets = [], onTrace, onMeta, onExport, onContinue }) {
  const { t } = useLang();
  const { fmtCost } = useCurrency();
  const [exportOpen, setExportOpen] = useState(false);
  const [contOpen, setContOpen] = useState(false);
  const targets = handoffTargets.filter(x => x.id !== row.agent_id);
  const fmtTime = ts => ts ? new Date(ts * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

  const costUsd = Number(row.cost_usd) || 0;

  return (
    <div className="px-5 py-2.5">
      <div className="grid grid-cols-[7.25rem_minmax(0,1.4fr)_3.5rem_4rem_4.5rem_5rem_auto] gap-2 items-center text-xs">
        {(() => {
          const client = row.client || row.agent_id;
          const brand = resolveBrandIcon(client);
          const label = CLIENT_LABELS[client] || client;
          return (
            <span className="flex items-center gap-1.5 min-w-0" title={client === row.agent_id ? client : `${label} (${row.agent_id})`}>
              {brand && <img src={brand} alt="" className="w-4 h-4 object-contain shrink-0" />}
              <span className="truncate text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{label}</span>
            </span>
          );
        })()}
        <div className="min-w-0 cursor-pointer group" onClick={onTrace} title={t('gateway.detail.bySession')}>
          <div className="font-semibold text-zinc-700 dark:text-zinc-200 truncate flex items-center gap-1">
            <button onClick={e => { e.stopPropagation(); onMeta({ favorite: !row.favorite }); }}
              className={row.favorite ? 'text-amber-500' : 'text-zinc-300 hover:text-amber-400'}>★</button>
            <span className="truncate group-hover:text-blue-600 dark:group-hover:text-blue-400">{row.project || '—'}</span>
          </div>
          <div className="text-zinc-400 truncate">{row.context || '—'}</div>
        </div>
        <div className="text-right tabular-nums text-zinc-600 dark:text-zinc-300">{row.calls ?? 0}</div>
        <div className="text-right tabular-nums text-zinc-600 dark:text-zinc-300">{fmtN(row.tokens)}</div>
        <div
          className={`text-right tabular-nums ${costUsd > 0 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : 'text-zinc-400'}`}
          title={t('gateway.sessions.costHint')}
        >
          {fmtCost(costUsd)}
        </div>
        <div className="text-right text-zinc-400">{fmtTime(row.lastTs)}</div>
        <div className="flex gap-1.5 justify-end items-center relative">
          <button onClick={() => { setContOpen(v => !v); setExportOpen(false); }}
            className="px-2 py-1 rounded-md border border-blue-200 dark:border-blue-900/50 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 whitespace-nowrap">{t('gateway.sessions.continue')}</button>
          <button onClick={() => { setExportOpen(v => !v); setContOpen(false); }}
            className="px-2 py-1 rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 whitespace-nowrap">{t('gateway.sessions.export')}</button>
          {contOpen && (
            <div className="absolute right-0 top-8 z-10 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 text-xs w-44">
              <div className="px-3 py-1 text-zinc-400">{t('gateway.sessions.continueTo')}</div>
              {targets.map(tg => (
                <button key={tg.id} onClick={() => { onContinue(tg.id); setContOpen(false); }}
                  className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700">{tg.label}</button>
              ))}
            </div>
          )}
          {exportOpen && (
            <div className="absolute right-0 top-8 z-10 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg py-1 text-xs w-40">
              <button onClick={() => { onExport('json'); setExportOpen(false); }} className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700">{t('gateway.sessions.exportJson')}</button>
              <button onClick={() => { onExport('markdown'); setExportOpen(false); }} className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700">{t('gateway.sessions.exportMd')}</button>
              <button onClick={() => { onExport('copy'); setExportOpen(false); }} className="block w-full text-left px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-700">{t('gateway.sessions.copyMd')}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 跨智能体交接：生成交接 brief → 复制 → 可在 Terminal 启动目标 agent */
function ContinueModal({ source, target, handoffTargets = [], onClose }) {
  const { t } = useLang();
  const [res, setRes]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice]   = useState('');
  const targetLabel = (handoffTargets.find(x => x.id === target) || {}).label || target;

  useEffect(() => {
    let alive = true;
    window.electronAPI.sessions.continue({
      source_agent: source.agent_id, session_id: source.session_id, target_agent: target,
    }).then(r => {
      if (!alive) return;
      setRes(r); setLoading(false);
      if (r?.ok && r.brief && navigator.clipboard) {
        navigator.clipboard.writeText(r.brief)
          .then(() => setNotice(t('gateway.sessions.briefCopied'))).catch(() => {});
      }
    }).catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [source, target]);

  const launchLabel = `${t('gateway.sessions.openIn')} ${targetLabel}`;

  const doLaunch = async () => {
    const r = await window.electronAPI.sessions.launch({
      target_agent: target, cwd: res.cwd, handoffFile: res.handoffFile,
    });
    if (r?.ok) setNotice(t('gateway.sessions.appOpened').replace('{app}', targetLabel));
    else if (r?.error === 'app_not_found') setNotice(t('gateway.sessions.appNotFound').replace('{app}', targetLabel));
    else setNotice(t('gateway.sessions.continueFailed'));
  };

  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-2xl max-h-[88vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0 flex items-center gap-3">
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">{t('gateway.sessions.continueTitle')}</h3>
          <span className="text-xs px-2 py-0.5 rounded bg-zinc-100 text-zinc-500 dark:bg-zinc-800">{source.agent_id}</span>
          <span className="text-zinc-400">→</span>
          <span className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">{targetLabel}</span>
        </div>

        {loading ? (
          <div className="py-16 text-center text-xs text-zinc-400">{t('gateway.sessions.generating')}</div>
        ) : !res?.ok ? (
          <div className="py-16 text-center text-xs text-zinc-400">{t('gateway.sessions.continueFailed')}</div>
        ) : (
          <>
            <div className="px-5 py-2 text-xs text-zinc-500 border-b border-zinc-100 dark:border-zinc-800 flex flex-wrap items-center gap-x-3 gap-y-1 shrink-0">
              <span className={`px-2 py-0.5 rounded ${res.aiGenerated ? 'bg-green-50 text-green-600 dark:bg-green-900/30 dark:text-green-400' : 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                {res.aiGenerated ? `${t('gateway.sessions.aiBrief')}${res.model ? ` · ${res.model}` : ''}` : t('gateway.sessions.rawBrief')}
              </span>
              <span className="font-mono break-all leading-relaxed max-w-md" title={res.handoffFile}>{t('gateway.sessions.handoffFile')}: {res.handoffFile}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <div className="text-xs text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-900/40 rounded-lg px-3 py-2 flex items-start gap-2">
                <span>📋</span>
                <span>{t('gateway.sessions.pasteHint').replace('{target}', targetLabel)}</span>
              </div>
              <pre className="text-xs text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words bg-zinc-50 dark:bg-zinc-800/50 rounded-lg p-3">{res.brief}</pre>
            </div>
            <div className="px-5 py-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0 flex items-center gap-2">
              {notice && <span className="text-xs text-green-600 dark:text-green-400">{notice}</span>}
              <div className="ml-auto flex gap-2">
                <button onClick={() => { navigator.clipboard?.writeText(res.brief); setNotice(t('gateway.sessions.briefCopied')); }}
                  className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">{t('gateway.sessions.copyMd')}</button>
                <button onClick={doLaunch}
                  className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white">{launchLabel}</button>
                <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500">{t('gateway.sessions.close')}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 用量明细区块标题（1–5 结构化） */
function DetailSection({ n, title, hint, children }) {
  return (
    <section>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="w-4 h-4 rounded-full bg-zinc-100 dark:bg-zinc-800 text-xs font-bold text-zinc-500 dark:text-zinc-400 flex items-center justify-center shrink-0">{n}</span>
        <h4 className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">{title}</h4>
        {hint && <span className="text-xs text-zinc-400 font-normal ml-1">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

/** 是否展示「会话补录」数据来源（须显式启用用量导入） */
function appHasSessionUsageImport(app) {
  if (!app) return false;
  if (typeof app.session_usage_import === 'boolean') return app.session_usage_import;
  return !!app.capabilities?.session_usage_import;
}

/** 是否启用会话 trace（与用量导入独立） */
function appHasSessionTrace(app) {
  if (!app) return false;
  if (typeof app.session_trace === 'boolean') return app.session_trace;
  return !!app.capabilities?.session_trace;
}

/** 可打开 Session Trace 的 agent（由 handler 派生 trace_agent_id） */
function traceAgentIdForApp(app) {
  if (!app) return null;
  if (!appHasSessionTrace(app)) return null;
  return app.trace_agent_id || app.activity_agent_id || app.agent_id || null;
}

/** 数据来源摘要：网关 / 会话补录（或二者皆有） */
function buildDataSourceSummary(app, proxy, session, fmtN, t) {
  const hasSessionImport = appHasSessionUsageImport(app);
  const tags = [];
  // 有 proxy 记录即展示网关来源（manual/api-key/shim 均可能产生）
  if (proxy.calls > 0) {
    tags.push({ icon: '🛰️', label: t('gateway.detail.sourceGateway'), calls: proxy.calls, tokens: proxy.tokens, tone: 'blue' });
  }
  if (hasSessionImport && (session.calls > 0 || session.tokens > 0)) {
    tags.push({ icon: '📄', label: t('gateway.detail.sourceSession'), calls: session.calls, tokens: session.tokens, tone: 'green' });
  }
  const summary = tags.length === 2
    ? t('gateway.detail.sourceBoth')
    : tags[0]?.label || '—';
  return { summary, tags };
}

/** 悬浮提示用：真实工作区路径（过滤 Agent 内部存储目录） */
function projectPathTooltip(row) {
  const p = row?.project_path;
  if (!p) return row?.project || '—';
  const s = String(p).replace(/\\/g, '/');
  if (!/\/\.claude\/projects\//.test(s) && !/\/\.codex\/sessions\//.test(s)) return p;
  const slug = s.split('/').filter(Boolean).pop() || '';
  if (!slug) return p;
  // githubprojects 仓库名可含连字符
  const gh = slug.match(/^(.*?githubprojects-)(.+)$/i);
  if (gh) {
    const prefixPath = '/' + gh[1].replace(/-$/, '').replace(/^-/, '').replace(/-/g, '/');
    if (/^\/(Users|home|var|opt|Volumes|tmp)\//i.test(prefixPath)) {
      return `${prefixPath}/${gh[2]}`;
    }
  }
  const decoded = '/' + slug.replace(/^-/, '').replace(/-/g, '/');
  if (/^\/(Users|home|var|opt|Volumes|tmp)\//i.test(decoded)) return decoded;
  return p;
}

/** 从会话行提取短项目名（与 session-browser 逻辑一致） */
function shortProjectName(row) {
  if (!row) return '—';
  const p = row.project;
  if (p && !p.includes('/') && !/^-?Users-/i.test(p) && !/^githubprojects-/i.test(p)
      && !/^\d{1,2}$/.test(p) && p.length <= 64
      && !(/^-?[A-Za-z]+-/.test(p) && (p.match(/-/g) || []).length >= 3)) {
    return p;
  }
  const raw = row.project_path || p || '';
  const m = String(raw).match(/githubprojects-(.+)$/i);
  if (m) return m[1];
  const slug = String(raw).replace(/\\/g, '/').split('/').filter(Boolean).pop() || raw;
  const decoded = slug && /^-?[A-Za-z]/.test(slug) && slug.includes('-')
    ? '/' + slug.replace(/^-/, '').replace(/-/g, '/')
    : null;
  if (decoded && /^\/(Users|home|var|opt|Volumes|tmp)\//i.test(decoded)) {
    return decoded.split('/').filter(Boolean).pop() || decoded;
  }
  return p || slug || '—';
}

// 单个应用的用量明细弹窗
function AppDetailModal({ app, onClose }) {
  const { t } = useLang();
  const { fmtCost, fmtCostOptional } = useCurrency();
  const [days, setDays]           = useState(1);
  const [data, setData]           = useState(null);
  const [loading, setLoading]     = useState(true);
  const [selectedSid, setSelectedSid] = useState(null);
  const [traceSid, setTraceSid]   = useState(null);
  const [modelFilter, setModelFilter] = useState(null);  // 从「按模型」筛选下方调用明细

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSelectedSid(null);
    setTraceSid(null);
    setModelFilter(null);
    Promise.resolve(getApps().detail?.(app, days))
      .then(d => { if (alive) { setData(d); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [app, days]);

  const fmtN    = n => n >= 1_000_000 ? (n/1e6).toFixed(2)+'M' : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);
  /** 调用明细：↑输入 ↓输出 C缓存读（与 Trace 顶栏一致） */
  const fmtTokLine = (r) => (
    <span className="text-zinc-500 shrink-0 tabular-nums">
      ↑{fmtN(r.inTok)} ↓{fmtN(r.outTok)}
      {(r.cached || 0) > 0 && (
        <span className="text-cyan-600 dark:text-cyan-400"> C{fmtN(r.cached)}</span>
      )}
    </span>
  );
  const fmtMs   = n => (n != null) ? (n >= 1000 ? (n/1000).toFixed(1)+'s' : n+'ms') : null;
  /** 展示首 token 延迟（无首 token 记录时回退总延迟，兼容旧数据） */
  const fmtTtft = r => fmtMs(r?.first_token_ms ?? r?.latency_ms);
  const fmtTime = ts => ts ? new Date(ts*1000).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
  const shortId = id => id ? (String(id).length > 12 ? String(id).slice(0,8)+'…'+String(id).slice(-4) : String(id)) : '—';
  const proxy   = data?.bySource?.find(s => s.source === 'proxy')   || { calls:0, tokens:0 };
  const session = data?.bySource?.find(s => s.source === 'session') || { calls:0, tokens:0 };

  const hasUsageImport = appHasSessionUsageImport(app);
  const hasSessionTrace = appHasSessionTrace(app);
  const sourceSummary = buildDataSourceSummary(app, proxy, session, fmtN, t);
  const sessionHistoryRows = (data?.activity?.length ? data.activity : (
    hasUsageImport ? (data?.sessions || []).map(s => ({
      ...s, project: '—', context: shortId(s.session_id),
    })) : []
  )).map(r => ({
    ...r,
    project: shortProjectName(r),
    project_path: projectPathTooltip(r),
  }));
  const traceAgentId = traceAgentIdForApp(app);
  const canTrace = !!traceAgentId;
  // Cursor 等无真实 model 的应用：不展示「按模型统计」；有 model 配置则展示调用明细
  const showModelStats = data?.hasModelStats !== false && (data?.byModel?.length ?? 0) > 0;
  const showCallDetails = data?.hasModelStats !== false;
  const secSession = showModelStats ? 4 : 3;
  const secCalls   = showModelStats ? 5 : 4;

  // 调用明细：时间倒序平铺（可选按「按模型统计」筛选）
  const recentSorted = (() => {
    let rows = [...(data?.recent || [])];
    if (modelFilter) rows = rows.filter(r => r.model === modelFilter);
    return rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  })();

  return createPortal(
    <>
      {traceSid && canTrace && (
        <SessionTraceModal app={app} sessionId={traceSid} traceAgentId={traceAgentId} onClose={() => setTraceSid(null)} />
      )}
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-3xl mx-4 max-h-[92vh] overflow-y-auto flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 sticky top-0 bg-white dark:bg-zinc-800 z-10">
          {(() => {
            const brand = brandIconFor(app);
            if (brand) return <img src={brand} alt="" className="w-6 h-6 object-contain" />;
            return isAppIcon(app.icon) ? appIconSvg(app.icon, 'w-6 h-6') : <span className="text-xl">{app.icon}</span>;
          })()}
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">{t('gateway.detail.usageTitle', { name: app.name })}</h3>
          <select value={days} onChange={e => setDays(+e.target.value)}
            className="text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 outline-none text-zinc-600 dark:text-zinc-300">
            <option value={1}>{t('gateway.detail.days1')}</option><option value={7}>{t('gateway.detail.days7')}</option><option value={30}>{t('gateway.detail.days30')}</option><option value={90}>{t('gateway.detail.days90')}</option>
          </select>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 text-lg">✕</button>
        </div>

        {loading ? (
          <div className="py-16 flex flex-col items-center gap-2 text-xs text-zinc-400">
            <div className="w-5 h-5 border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin" />{t('gateway.common.loading')}
          </div>
        ) : !data ? (
          <div className="py-16 text-center text-xs text-zinc-400">{t('gateway.common.noData')}</div>
        ) : (
          <div className="p-5 space-y-6">

            {/* 1. 数据来源 */}
            <DetailSection n="1" title={t('gateway.detail.dataSource')}>
              <div className="text-xs text-zinc-600 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-800/40 rounded-lg px-3 py-2.5">
                <span className="text-zinc-700 dark:text-zinc-300">{sourceSummary.summary}</span>
                {sourceSummary.tags.length > 1 && (
                  <span className="text-xs text-zinc-400 ml-2">{t('gateway.detail.deduped')}</span>
                )}
                <div className="flex flex-wrap gap-2 mt-2">
                  {sourceSummary.tags.map(tag => (
                    <span key={tag.label}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                        tag.tone === 'blue'
                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-900/25 dark:text-blue-400'
                          : 'bg-green-50 text-green-600 dark:bg-green-900/25 dark:text-green-400'
                      }`}>
                      {tag.icon} {tag.label} {tag.calls} {t('gateway.common.times')} · {fmtN(tag.tokens)} tok
                    </span>
                  ))}
                </div>
              </div>
            </DetailSection>

            {/* 2. 概要总计 */}
            <DetailSection n="2" title={t('gateway.detail.summary')}>
              <div className="grid grid-cols-6 gap-2">
                {[
                  [t('gateway.detail.totalCalls'), fmtN(data.total.calls)],
                  [t('gateway.detail.totalTokens'),  fmtN(data.total.tokens)],
                  [t('gateway.detail.inputTokens'), fmtN(data.total.inTok)],
                  [t('gateway.detail.outputTokens'), fmtN(data.total.outTok)],
                  [t('gateway.detail.cachedTokens'), fmtN(data.total.cached)],
                  [t('gateway.detail.estCost'),  fmtCost(data.total.totalCost) || '—'],
                ].map(([l,v]) => (
                  <div key={l} className="bg-zinc-50 dark:bg-zinc-800/50 rounded-xl p-3">
                    <div className="text-xs text-zinc-400 dark:text-zinc-500">{l}</div>
                    <div className="text-lg font-bold text-zinc-800 dark:text-zinc-100 mt-0.5 truncate">{v}</div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-zinc-400 mt-2">{t('gateway.detail.costHint')}</p>
            </DetailSection>

            {/* 3. 按模型统计（无 model 字段的应用不展示） */}
            {showModelStats && (
            <DetailSection n="3" title={t('gateway.detail.byModel')} hint={modelFilter ? t('gateway.detail.filterActive', { model: modelFilter }) : t('gateway.detail.filterHint')}>
              <div className="border border-zinc-100 dark:border-zinc-800 rounded-lg divide-y divide-zinc-100 dark:divide-zinc-800">
                {data.byModel.map(m => (
                  <div key={m.model}
                    onClick={() => setModelFilter(modelFilter === m.model ? null : m.model)}
                    className={`flex items-center gap-3 px-3 py-1.5 text-xs cursor-pointer select-none hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${modelFilter === m.model ? 'bg-blue-50 dark:bg-blue-900/10' : ''}`}>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300 flex-1 min-w-0 break-all">{m.model}</span>
                    <span className="text-zinc-500 w-16 text-right">{m.calls} {t('gateway.common.times')}</span>
                    <span className="text-zinc-700 dark:text-zinc-300 w-20 text-right font-medium">{fmtN(m.tokens)} tok</span>
                  </div>
                ))}
              </div>
              {modelFilter && (
                <button type="button" onClick={() => setModelFilter(null)}
                  className="text-xs text-blue-600 dark:text-blue-400 mt-1.5">{t('gateway.detail.clearFilter')}</button>
              )}
            </DetailSection>
            )}

            {/* 4. 按会话历史（trace 或用量导入） */}
            {(hasSessionTrace || hasUsageImport) && (
            <DetailSection n={secSession} title={t('gateway.detail.bySession')} hint={canTrace ? t('gateway.detail.traceHint') : undefined}>
              {sessionHistoryRows.length === 0 ? (
                <div className="text-xs text-zinc-400 px-1">{t('gateway.detail.noSessions')}</div>
              ) : (
                <div className="tb-table-shell rounded-lg">
                  <div className="tb-table-head grid grid-cols-[minmax(5.5rem,1.15fr)_minmax(0,2fr)_3.5rem_3.5rem_4.5rem_3.5rem] gap-2 px-3 py-1.5">
                    <span>{t('gateway.detail.colProject')}</span><span>{t('gateway.detail.colContext')}</span><span className="text-right">{t('gateway.detail.colRequests')}</span><span className="text-right">Token</span><span className="text-right">{t('gateway.detail.colTime')}</span><span className="text-right">{canTrace ? 'Trace' : t('gateway.detail.colDetail')}</span>
                  </div>
                  <div className="divide-y divide-zinc-100 dark:divide-zinc-800 max-h-64 overflow-y-auto">
                    {sessionHistoryRows.map((row, ri) => (
                      <div key={`${row.session_id || 'sess'}-${ri}`}>
                        <div
                          className={`grid grid-cols-[minmax(5.5rem,1.15fr)_minmax(0,2fr)_3.5rem_3.5rem_4.5rem_3.5rem] gap-2 px-3 py-2 text-xs items-center hover:bg-zinc-50 dark:hover:bg-zinc-800/40 ${selectedSid === row.session_id ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}>
                          <span className="font-medium text-zinc-700 dark:text-zinc-300 truncate min-w-0" title={projectPathTooltip(row)}>{row.project}</span>
                          <span className="text-zinc-600 dark:text-zinc-400 truncate" title={row.context}>{row.context || '—'}</span>
                          <span className="text-zinc-500 text-right">{row.calls || 0}</span>
                          <span className="text-zinc-700 dark:text-zinc-300 text-right font-medium">{fmtN(row.tokens)}</span>
                          <span className="text-zinc-400 text-right text-xs">{fmtTime(row.lastTs)}</span>
                          <span className="text-right">
                            {canTrace ? (
                              <button type="button" onClick={() => setTraceSid(row.session_id)}
                                className="text-xs px-2 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400">
                                Trace
                              </button>
                            ) : (
                              <button type="button" onClick={() => setSelectedSid(selectedSid === row.session_id ? null : row.session_id)}
                                className="text-xs text-zinc-400 hover:text-zinc-600">
                                {selectedSid === row.session_id ? '▾' : '▸'}
                              </button>
                            )}
                          </span>
                        </div>
                        {selectedSid === row.session_id && !canTrace && (
                          <div className="bg-zinc-50 dark:bg-zinc-800/30 divide-y divide-zinc-100 dark:divide-zinc-800/60 pl-4 pb-1">
                            {(data?.recent || []).filter(r => r.session_id === row.session_id).slice(0, 20).map((r, i) => (
                              <div key={i} className="flex items-center gap-2 px-3 py-1 text-xs">
                                <span className="text-zinc-400 w-20 shrink-0">{fmtTime(r.ts)}</span>
                                <span className="text-zinc-600 dark:text-zinc-400 flex-1 truncate">{r.label || r.model || '—'}</span>
                                <span className="shrink-0">{fmtTokLine(r)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </DetailSection>
            )}

            {/* 5. 调用明细（无 model 的应用不展示） */}
            {showCallDetails && (
            <DetailSection n={secCalls} title={showModelStats ? t('gateway.detail.byModelCalls') : t('gateway.detail.callDetails')} hint={t('gateway.detail.recentCount', { n: recentSorted.length })}>
              {recentSorted.length === 0 ? (
                <div className="text-xs text-zinc-400 px-1">—</div>
              ) : (
                <div className="border border-zinc-100 dark:border-zinc-800 rounded-lg divide-y divide-zinc-100 dark:divide-zinc-800 max-h-80 overflow-y-auto">
                  {recentSorted.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs flex-wrap">
                      <span className="text-zinc-400 w-24 shrink-0">{fmtTime(r.ts)}</span>
                      <span className={`px-1 rounded text-xs shrink-0 ${r.source === 'proxy' ? 'bg-blue-50 text-blue-500 dark:bg-blue-900/20' : 'bg-green-50 text-green-600 dark:bg-green-900/20'}`}>
                        {r.source === 'proxy' ? t('gateway.detail.sourceProxy') : t('gateway.detail.sourceSess')}
                      </span>
                      {showModelStats && (
                        <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400 shrink-0 break-all" title={r.model}>{r.model || '—'}</span>
                      )}
                      {!showModelStats && (
                        <span className="text-zinc-600 dark:text-zinc-400 flex-1 truncate" title={r.label || r.context}>
                          {r.label || r.context || shortId(r.session_id) || '—'}
                        </span>
                      )}
                      <span className="ml-auto">{fmtTokLine(r)}</span>
                      {fmtTtft(r) && <span className="text-zinc-400 shrink-0">{fmtTtft(r)}</span>}
                      {fmtCostOptional(r.cost_usd) && <span className="text-emerald-600 dark:text-emerald-400 shrink-0">{fmtCostOptional(r.cost_usd)}</span>}
                      {r.status_code != null && r.status_code >= 400 && <span className="text-red-500 shrink-0">{r.status_code}</span>}
                    </div>
                  ))}
                </div>
              )}
            </DetailSection>
            )}

          </div>
        )}
      </div>
    </div>
    </>,
    document.body,
  );
}

function AppManager({ externalRoutes, availableModels = [], onActivity }) {
  const refresh = typeof onActivity === 'function' ? onActivity : () => {};
  const { t } = useLang();
  const appsApi = getApps();
  const [apps,     setApps]     = useState([]);
  const [detailApp, setDetailApp] = useState(null);   // 用量明细弹窗对应的 app
  const [claudeModels, setClaudeModels] = useState([]);  // 保留供后续 Claude 相关 UI 使用
  const [routes,   setRoutes]   = useState([]);
  const [localBase, setLocalBase] = useState('');
  // 当 Gateway 的 routes 更新时同步进来（场景路由新建后立即可选）
  useEffect(() => { if (externalRoutes?.length) setRoutes(externalRoutes); }, [externalRoutes]);
  const [settings, setSettings] = useState(null);     // 设置弹窗对应的 app（编辑/桌面应用托管）
  const [devTipApp, setDevTipApp] = useState(null);   // 开发者模式引导弹窗对应的 app
  const [devTipMsg, setDevTipMsg] = useState('');     // 引导弹窗内「刷新检测」结果提示
  const [manualDraft, setManualDraft] = useState(null); // 手工添加的内联面板对应的 app
  const [appStats, setAppStats] = useState({});     // id → {calls,tokens,lastTs}（当天用量）
  const [loading,  setLoading]  = useState(true);   // 首次加载中（应用检测较慢）→ 显示加载特效而非空状态
  const [toolboxOpen, setToolboxOpen] = useState(false);       // 应用百宝箱展开态
  const [toolboxBusy, setToolboxBusy] = useState(false);       // 展开前从云端拉取目录
  const [toolboxRefresh, setToolboxRefresh] = useState(0);     // 拉取完成后刷新图标行
  const [toolboxSyncError, setToolboxSyncError] = useState(null); // 云端拉取失败原因

  // 展开百宝箱：先从云端拉取 /api/config/apps，再结合本机安装状态展示彩色/灰色图标
  async function toggleToolbox() {
    if (toolboxOpen) { setToolboxOpen(false); return; }
    setToolboxBusy(true);
    setToolboxSyncError(null);
    try {
      const base = await getSyncServerBase();
      if (window.electronAPI?.toolsConfig?.importUrl && base) {
        const token = localStorage.getItem('token'); // apps 公开，token 可选
        const r = await window.electronAPI.toolsConfig.importUrl(base + '/api/config/apps', token, { replace: true });
        if (r.ok) {
          setToolboxRefresh(k => k + 1);
          await load();   // 同步后刷新下方应用列表（可能有新识别的应用）
        } else {
          const err = r.error || 'unknown';
          console.warn('[toolbox] cloud sync failed:', err);
          setToolboxSyncError(err);
        }
      } else if (!base) {
        setToolboxSyncError('no_server');
      }
    } finally {
      setToolboxBusy(false);
      setToolboxOpen(true);   // 即使拉取失败也展开，展示本地缓存目录
    }
  }

  const load = useCallback(async () => {
    try {
      const localCfg = await getLocalConfig().get().catch(() => ({}));
      setRoutes(localCfg?.scene_routes || []);

      const [appList, gw] = await Promise.all([
        appsApi.list().catch(() => []),
        getGateway().status().catch(() => null),
      ]);
      const list = Array.isArray(appList) ? appList : [];
      setApps(list);
      if (gw?.port) {
        setLocalBase(resolveLocalGatewayBase(gw.port));
      }
      if (list.length && appsApi.stats) {
        appsApi.stats(list).then(s => setAppStats(s || {})).catch(() => {});
      }
    } finally {
      setLoading(false);
    }
  }, [appsApi]);

  useEffect(() => { load(); }, [load]);

  // Claude 名（Claude Desktop inferenceModels 的 name 只能用 Anthropic 名）
  useEffect(() => { appsApi.claudeModels?.().then(m => setClaudeModels(Array.isArray(m) ? m : [])).catch(() => {}); }, [appsApi]);

  // 配置下发/变更后，主进程通知 → 重新加载应用列表（新托管/新可配置 api-key 行立即显示）
  useEffect(() => {
    const off = appsApi.onChanged?.(() => load());
    return () => { if (typeof off === 'function') off(); };
  }, [load, appsApi]);

  // 手工添加点击时就先持久化了一条草稿（为了显示 api_key）。若用户没保存/取消就切走 tab
  // （AppManager 卸载），把这条未保存草稿删掉，否则切回来会多出一条「新应用」。
  const manualDraftRef = useRef(null);
  useEffect(() => { manualDraftRef.current = manualDraft; }, [manualDraft]);
  useEffect(() => () => {
    const d = manualDraftRef.current;
    if (d?._isNew && d.id) getApps().delete(d.id).catch(() => {});
  }, []);

  async function handleUpdateApp(data) {
    let id = data.id;
    // 虚拟 shim 应用（仅展示、未落库）：先落库拿到真实 id 再更新
    const app = apps.find(a => a.id === data.id);
    if (app?._virtual && app.link_method === 'shim') {
      const created = await appsApi.ensureShimApp?.({
        agent_id: app.agent_id, name: app.name, icon: app.icon,
      }).catch(() => null);
      if (created?.id) id = created.id;
    }
    // 保存即清除草稿标记（新建面板保存后该应用才在列表显示）；对非草稿应用是无害的 no-op
    const updated = await appsApi.update({ ...data, id, draft: false }).catch(() => null);
    // shim 应用：路由/key 改动后需重写 shim 脚本才生效
    if (app?.link_method === 'shim' && app.agent_id) {
      await window.electronAPI.agents?.apply(app.agent_id).catch(() => {});
    }
    await load();
    // 若设置弹窗仍开着且 id 未变，刷新其数据
    if (updated && settings?.id === updated.id) setSettings(updated);
  }

  async function handleDeleteApp(id) {
    if (!window.confirm(t('gateway.apps.confirmDelete'))) return;
    await appsApi.delete(id).catch(() => {});
    if (settings?.id === id) setSettings(null);
    await load();
  }

  async function handleRegenKey(id) {
    const r = await appsApi.regenKey(id).catch(() => null);
    if (r?.ok) {
      await load();
      // 用最新 key 刷新设置弹窗 / 手工添加面板
      const fresh = (await appsApi.list().catch(() => []) || []).find(a => a.id === id);
      if (fresh && settings?.id === id) setSettings(fresh);
      if (fresh && manualDraft?.id === id) setManualDraft({ ...fresh, _isNew: true });
    }
  }

  // 打开设置：虚拟 shim 先落库以生成 api_key，便于展示写入配置的 Key
  async function openAppSettings(app) {
    if (app._virtual && app.link_method === 'shim' && app.agent_id) {
      const created = await appsApi.ensureShimApp?.({
        agent_id: app.agent_id, name: app.name, icon: app.icon,
      }).catch(() => null);
      if (created?.id) {
        await load();
        const fresh = (await appsApi.list().catch(() => []) || []).find(a => a.id === created.id);
        setSettings(fresh || created);
        return;
      }
    }
    setSettings(app);
  }

  // 默认路由：新应用自动绑当前可用模型的第一个（P2P 在线 > 付费 > 免费）。
  // 否则「直连」会把客户端原始模型名（claude-*/gpt-*）直发，P2P 后端没有这些名字必 502。
  function defaultRouteId() {
    const order = { p2p: 0, paid: 1, free: 2 };
    const pick = [...availableModels].sort(
      (a, b) => (order[a.tier] ?? 9) - (order[b.tier] ?? 9))[0];
    return pick ? encodeTierModelRoute(pick.tier, pick.id) : '';
  }

  // 手工添加：未被识别的应用 → 创建 manual 应用，弹层编辑
  // （原注释：内联展开 ManualAddPanel）
  // （已识别的 CLI/桌面应用都在列表里直接托管，不走此入口）
  async function addCustom() {
    // draft:true → 列表不显示这条临时条目（只在内联面板里编辑），保存时清除草稿标记才出现。
    const created = await appsApi.create({
      name: t('gateway.apps.newAppName'), icon: 'icon:cube', link_method: 'manual',
      route_id: defaultRouteId() || null, draft: true,
    }).catch(() => null);
    if (created?.id) setManualDraft({ ...created, _isNew: true });
  }
  // 重扫 CLI 多账号实例（发现新登录的 CONFIG_DIR）→ 刷新列表
  async function rescanInstances() {
    try { await appsApi.rescanInstances?.(); } catch {}
    await load();
  }
  // 手工添加面板：保存（已在面板内持久化）→ 关闭并刷新
  function closeManualDraft() { setManualDraft(null); load(); }
  // 手工添加面板：取消 → 删除这条未保存的应用再刷新
  async function cancelManualDraft() {
    const d = manualDraft;
    setManualDraft(null);
    if (d?.id) await appsApi.delete(d.id).catch(() => {});
    await load();
  }

  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState({});   // id → 提示文字
  const noticeTimers = useRef({});            // id → 自动隐藏定时器
  function showNotice(id, msg, ms = 3000) {
    if (noticeTimers.current[id]) clearTimeout(noticeTimers.current[id]);
    setNotice(n => ({ ...n, [id]: msg }));
    noticeTimers.current[id] = setTimeout(() => {
      setNotice(n => { const c = { ...n }; delete c[id]; return c; });
      delete noticeTimers.current[id];
    }, ms);
  }

  // 纳管/还原：
  //   纳管 = hosted:true + route_id:null + 官方订阅（还原配置/撤 shim，不走网关）
  //   还原 = hosted:false + route_id:null + 官方订阅（同上，停止纳管统计）
  // 走网关由路由下拉单独选择模型/路由触发。
  async function setTracked(app, on) {
    let appId = app.id;
    if (app._virtual && app.link_method === 'shim') {
      const c = await appsApi.ensureShimApp({ agent_id: app.agent_id, name: app.name, icon: app.icon }).catch(() => null);
      if (c) appId = c.id;
    }
    if (on) {
      setBusyId(appId);
      // 纳管默认官方订阅：清空路由，确保不注入网关
      await appsApi.update({ id: appId, hosted: true, route_id: null, route_ids: null }).catch(() => {});
      if (app.host_method === 'config-file') {
        await appsApi.revertConfigFile({ app_id: appId, config_file: app.config_file }).catch(() => {});
        showNotice(appId, t('gateway.apps.restartToApply'));
      } else if (app.link_method === 'shim' && app.agent_id) {
        await window.electronAPI.agents?.revert(app.agent_id).catch(() => {});
        showNotice(appId, t('gateway.apps.restartToApply'));
      } else if (app.link_method === 'direct') {
        showNotice(appId, t('gateway.apps.restartToApply'));
      } else {
        showNotice(appId, t('gateway.apps.restartToApply'));
      }
    } else {
      const msg = app.link_method === 'direct'
        ? t('gateway.apps.confirmUntrackDirect')
        : t('gateway.apps.confirmRevert');
      if (!window.confirm(msg)) return;
      setBusyId(appId);
      if (app.link_method === 'shim' && app.agent_id) {
        await window.electronAPI.agents?.revert(app.agent_id).catch(() => {});
        showNotice(appId, t('gateway.apps.restartToApply'));
      } else if (app.host_method === 'config-file') {
        await appsApi.revertConfigFile({ app_id: appId, config_file: app.config_file }).catch(() => {});
        showNotice(appId, t('gateway.apps.restartToApply'));
      } else if (app.link_method === 'direct') {
        showNotice(appId, t('gateway.apps.untracked'));
      }
      await appsApi.update({ id: appId, hosted: false, route_id: null, route_ids: null }).catch(() => {});
      if (settings?.id === appId) setSettings(null);
    }
    setBusyId(null);
    try { await window.electronAPI.claude3p?.sync(); } catch {}
    await load();
  }

  // 转发测试：用该应用的 api_key 向网关发一个最小请求，验证转发是否成功
  const [testState, setTestState] = useState({});   // appId -> {busy|ok|error|latency}
  const testHideTimers = useRef({});
  function scheduleTestHide(appId, ms = 3000) {
    if (testHideTimers.current[appId]) clearTimeout(testHideTimers.current[appId]);
    testHideTimers.current[appId] = setTimeout(() => {
      setTestState(s => { const n = { ...s }; delete n[appId]; return n; });
      delete testHideTimers.current[appId];
    }, ms);
  }
  async function runAppTest(app) {
    const key = app.api_key;
    if (!key) return;   // 无 key（未托管/虚拟行）不能测
    // 多选：逐条测试所有已绑定路由；无绑定则测一次默认/官方。只读——不改写绑定。
    const routeIds = effectiveRouteIds(app);
    const targets = routeIds.length ? routeIds : [''];
    setTestState(s => ({ ...s, [app.id]: { busy: true } }));
    const base = (localBase || resolveLocalGatewayBase()).replace(/\/$/, '');
    const url = `${base}/chat/completions`;
    const errText = (e) => e === 'timeout' ? t('gateway.common.timeout30s') : (e || t('gateway.common.connectFailed'));
    const results = [];
    for (const rid of targets) {
      const { model } = exampleModelFromRoute(rid, routes, availableModels);
      const body = { model, max_tokens: 1, messages: [{ role: 'user', content: 'Hello!' }] };
      try {
        const r = await runStreamChatTest({ url, headers: { authorization: `Bearer ${key}` }, body });
        results.push({ routeId: rid, model, ok: !!r.ok, error: r.ok ? null : errText(r.error), latency: r.latency });
      } catch (e) {
        results.push({ routeId: rid, model, ok: false, error: e?.message || t('gateway.common.connectFailed'), latency: null });
      }
    }
    const passed = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    const allOk = failed.length === 0;
    console.log('[route-test] results', { appId: app.id, total: results.length, passed: passed.length, failed: failed.map(f => f.model) });
    setTestState(s => ({ ...s, [app.id]: {
      ok: allOk,
      error: failed.length ? failed.map(r => `${r.model}: ${r.error}`).join('；') : null,
      latency: passed[0]?.latency ?? null,
      total: results.length, passedCount: passed.length, results,
    } }));
    scheduleTestHide(app.id, allOk ? 3000 : 8000);
    setTimeout(() => { load(); refresh(); }, 600);
  }
  // 写入某 api-key 应用的配置文件指向网关（解析 {BASE}/{KEY}，patch_route 在 main 进程按 handler 策略改写）。
  // 返回 true=成功。onAbort：冲突取消/写入失败时的回滚回调（新建时删条目；重新纳管不删）。
  async function writeApiKeyConfig(app, { onAbort } = {}) {
    const gwOrigin = (localBase || resolveLocalGatewayBase()).replace(/\/v1\/?$/, '');
    const apiKey = app.api_key || '';
    const resolveTpl = (tpl) => {
      if (typeof tpl === 'string') {
        return tpl.replace(/\{BASE\}/g, gwOrigin).replace(/\{KEY\}/g, apiKey);
      }
      if (Array.isArray(tpl)) return tpl.map(resolveTpl);
      if (tpl && typeof tpl === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(tpl)) out[k] = resolveTpl(v);
        return out;
      }
      return tpl;
    };
    const routeIds = effectiveRouteIds(app);
    const isGatewayConfig = app.patch && 'inferenceProvider' in app.patch;
    const run = async (force) => {
      let patch = resolveTpl(app.patch || {});
      const env   = resolveTpl(app.env || {});
      if (isGatewayConfig) {
        delete patch.modelDiscoveryEnabled;
        patch.chatTabEnabled = true;
        patch.coworkEgressAllowedHosts = ['*'];
        patch.disableDeploymentModeChooser = true;
        // inferenceModels 由 main.js applyRouteToProxyPatch（claude_inference_models）写入
      }
      const r = await appsApi.writeConfigFile({
        app_id: app.id, config_file: app.config_file, patch, env, force,
        route_id: routeIds[0] || null,
        route_ids: routeIds.length ? routeIds : null,
      }).catch(e => ({ ok: false, error: e.message }));
      // 冲突：目标配置项已有不同的值 → 确认后强制覆盖；取消则回滚
      if (r && !r.ok && Array.isArray(r.conflicts) && r.conflicts.length) {
        const lines = r.conflicts.map(c => `· ${c.key}\n${t('gateway.app.conflictCurrent', { val: c.current })}\n${t('gateway.app.conflictWanted', { val: c.wanted })}`).join('\n');
        if (window.confirm(t('gateway.app.conflictConfirm', { lines }))) return run(true);
        await onAbort?.();
        return false;
      }
      if (!r?.ok) { await onAbort?.(); window.alert(t('gateway.apps.hostFailed', { msg: r?.error || t('gateway.common.writeFailed') })); return false; }
      // Codex Desktop 缺官方登录态 → 门控会藏掉自定义模型，提示用户先登录官方账号
      if (r.warning === 'codex-no-official-login') window.alert(t('gateway.apps.codexNeedOfficialLogin'));
      return true;
    };
    return run(false);
  }

  /** 列表行路由下拉变更：单选 val 或多选 selected */
  async function applyAppRouteSelection(app, val, selected) {
    const routeIds = Array.isArray(selected) && selected.length ? selected : (val ? [val] : []);
    const primary = routeIds[0] || null;
    setBusyId(app.id);
    if (app.host_method === 'config-file') {
      await appsApi.update({
        id: app.id, route_id: primary, route_ids: routeIds.length ? routeIds : null,
        ...(primary ? { hosted: true } : {}),
      }).catch(() => {});
      if (routeIds.length) {
        await writeApiKeyConfig({ ...app, route_id: primary, route_ids: routeIds });
        showNotice(app.id, t('gateway.apps.restartToApply'));
      } else {
        await appsApi.revertConfigFile({ app_id: app.id, config_file: app.config_file }).catch(() => {});
        showNotice(app.id, t('gateway.apps.restartToApply'));
      }
    } else if (app.link_method === 'shim' && app.agent_id) {
      let appId = app.id;
      if (app._virtual) {
        const created = await appsApi.ensureShimApp({ agent_id: app.agent_id, name: app.name, icon: app.icon }).catch(() => null);
        if (created) appId = created.id;
      }
      await appsApi.update({
        id: appId, route_id: primary, route_ids: routeIds.length ? routeIds : null,
        ...(primary ? { hosted: true } : {}),
      }).catch(() => {});
      // 选路由 → 重生成 shim（注网关）。清路由(直连)：多账号「非默认」实例保留 shim（只切账号、
      // 不注网关，靠自己 config-dir 的配置直连；网关关着也照切账号）；默认/单账号实例 → 撤 shim 回官方。
      const keepShimOnDirect = !!(app.instance && !app.instance.is_default);
      if (primary || keepShimOnDirect) { await window.electronAPI.agents?.apply(app.agent_id).catch(() => {}); }
      else { await window.electronAPI.agents?.revert(app.agent_id).catch(() => {}); }
      showNotice(appId, t('gateway.apps.restartToApply'));
    } else if (app.link_method === 'session') {
      await appsApi.update({
        id: app.id, route_id: primary, route_ids: routeIds.length ? routeIds : null,
        ...(primary ? { hosted: true } : {}),
      }).catch(() => {});
      // Trae 不写配置文件，切换路由后提示用户按编辑面板说明手工改模型
      if (isTraeWorkApp(app) && routeIds.length) {
        showNotice(app.id, t('gateway.apps.traeManualRouteHint'), 5000);
      }
    } else {
      await appsApi.update({
        id: app.id, route_id: primary, route_ids: routeIds.length ? routeIds : null,
        ...(primary ? { hosted: true } : {}),
      }).catch(() => {});
    }
    // 切换路由后立即同步会话（覆盖所有 app 类型，不等 30s 定时器）
    try { await window.electronAPI.claude3p?.sync(); } catch {}
    setBusyId(null);
    await load();
  }

  // API Key 应用（虚拟行）「纳管」：建条目 + 标记 hosted（默认直连，不写配置）。要走网关在路由下拉选模型。
  async function addApiKeyApp(d) {
    setBusyId(d.id);
    const created = await appsApi.create({
      name: d.name, icon: d.icon, link_method: 'api-key',
      preset_id: d.preset_id, route_id: null,
      inject: 'config-file', config_file: d.config_file, patch: d.patch, env: d.env || null,
    }).catch(() => null);
    if (created?.id) await appsApi.update({ id: created.id, hosted: true }).catch(() => {});
    setBusyId(null);
    if (created?.id) showNotice(created.id, t('gateway.apps.restartToApply'));
    await load();
  }

  // 已保存但已取消纳管的 api-key 应用「重新纳管」→ 默认官方订阅（与列表纳管一致）
  async function rehostApiKeyApp(app) {
    await setTracked(app, true);
  }

  // 还原：与 setTracked(off) 一致，路由恢复官方订阅
  async function handleCancelManage(app) {
    await setTracked(app, false);
  }

  // 保存设置（已在面板内 onUpdate 持久化）→ 仅关闭并刷新
  function closeSettings() { setSettings(null); load(); }
  // 取消/关闭：若是未保存的新应用则删除（必须等删除完成再刷新，否则列表读到删除前的旧状态）
  async function cancelSettings() {
    const s = settings;
    setSettings(null);
    if (s?._isNew && s.id) {
      await appsApi.delete(s.id).catch(() => {});
    }
    await load();
  }

  // 列表只显示非草稿条目（新建面板未保存的临时条目 draft:true 不进列表）
  const visibleApps = apps.filter(a => !a.draft);

  // CLI 多账号分组：同 agent_id 的 shim 实例 ≥2 → 插一条父行 + 子行；单实例(或非实例)照旧一行。
  const renderList = (() => {
    const cnt = {};
    for (const a of visibleApps) if (a.link_method === 'shim' && a.agent_id && a.instance) cnt[a.agent_id] = (cnt[a.agent_id] || 0) + 1;
    const out = [];
    const done = new Set();
    for (const app of visibleApps) {
      const gid = app.agent_id;
      const grouped = app.link_method === 'shim' && app.instance && gid && cnt[gid] >= 2;
      if (grouped) {
        if (done.has(gid)) continue;
        done.add(gid);
        const members = visibleApps.filter(x => x.agent_id === gid && x.link_method === 'shim' && x.instance);
        out.push({ __parent: true, agentId: gid, count: members.length, sample: members[0] });
        for (const m of members) out.push({ app: m, isChild: true });
      } else {
        out.push({ app });
      }
    }
    return out;
  })();

  return (
    <>
      {/* 编辑已有应用 / 桌面应用托管 → 弹窗（AppSettingsPanel）*/}
      {settings && (
        <AppSettingsPanel app={settings} routes={routes} availableModels={availableModels} localBase={localBase}
          instanceCount={settings.agent_id ? visibleApps.filter(a => a.link_method === 'shim' && a.agent_id === settings.agent_id && a.instance).length : 1}
          onUpdate={handleUpdateApp} onDelete={handleDeleteApp} onRegenKey={handleRegenKey}
          onCancelManage={handleCancelManage}
          onWritten={() => setSettings(s => s ? { ...s, _isNew: false, configured: true } : s)}
          onClose={closeSettings} onCancel={cancelSettings} />
      )}
      {/* 用量明细弹窗（点击统计区打开）*/}
      {detailApp && <AppDetailModal app={detailApp} onClose={() => setDetailApp(null)} />}
      {/* Claude Desktop 开发者模式引导（「怎么启用」的步骤提示，非设置窗口）*/}
      {devTipApp && createPortal(
        <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={() => setDevTipApp(null)}>
          <div className="w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl p-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px] shrink-0 text-amber-600 dark:text-amber-400">
                <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
              </svg>
              <span className="text-sm font-semibold text-amber-700 dark:text-amber-400">{t('gateway.app.devModeTitle')}</span>
            </div>
            <div className="text-xs text-zinc-600 dark:text-zinc-300 space-y-1 mb-3">
              <p>{t('gateway.app.devModeIntro')}</p>
              <p>{t('gateway.app.devModeStep1')}</p>
              <p>{t('gateway.app.devModeStep2')}</p>
              <p>{t('gateway.app.devModeStep3')}</p>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div>
                <div className="text-xs text-zinc-400 mb-1">{t('gateway.app.devModeImg1')}</div>
                <img src={claudeDevModeImg1} alt="Enable Developer Mode" className="rounded border border-zinc-200 dark:border-zinc-700 w-full" />
              </div>
              <div>
                <div className="text-xs text-zinc-400 mb-1">{t('gateway.app.devModeImg2')}</div>
                <img src={claudeDevModeImg2} alt="Configure Gateway" className="rounded border border-zinc-200 dark:border-zinc-700 w-full" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  const st = await window.electronAPI?.apps?.claudeDevModeStatus?.();
                  if (st?.dev_mode_ready) { setDevTipApp(null); setDevTipMsg(''); await load(); }
                  else setDevTipMsg(t('gateway.app.devModeNotReady'));
                }}
                className="text-xs px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors">
                {t('gateway.app.devModeRefresh')}
              </button>
              <button onClick={() => setDevTipApp(null)}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
                {t('gateway.common.close')}
              </button>
              {devTipMsg && <span className="text-xs text-red-500">{devTipMsg}</span>}
            </div>
          </div>
        </div>,
        document.body,
      )}
      <div className="px-2.5 py-3">
            {/* 操作栏 */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <button onClick={() => manualDraft ? cancelManualDraft() : addCustom()}
                className="text-xs px-3 py-1.5 rounded-xl bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 text-white transition-colors font-medium shadow-sm shadow-blue-500/20">
                {t('gateway.apps.new')}
              </button>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('gateway.apps.newHint')}</span>
              <AppToolbox
                open={toolboxOpen}
                busy={toolboxBusy}
                onToggle={toggleToolbox}
                onClose={() => setToolboxOpen(false)}
                refreshKey={toolboxRefresh}
                syncError={toolboxSyncError}
              />
            </div>

            {/* 手工添加 → 弹层（ManualAddPanel，portal 到 body，避免被应用列表卡片裁切）*/}
            {manualDraft && (
              <ManualAddPanel app={manualDraft} routes={routes} availableModels={availableModels}
                localBase={localBase}
                onUpdate={handleUpdateApp} onRegenKey={handleRegenKey}
                onSave={closeManualDraft} onCancel={cancelManualDraft} />
            )}

            {/* 应用列表 */}
            {loading ? (
              <div className="py-10 flex flex-col items-center justify-center gap-2 text-xs text-zinc-400">
                <div className="w-5 h-5 border-2 border-zinc-300 dark:border-zinc-600 border-t-blue-500 rounded-full animate-spin" />
                {t('gateway.apps.loading')}
              </div>
            ) : visibleApps.length === 0 ? (
              <div className="py-6 text-center text-xs text-zinc-400">
                {t('gateway.apps.empty')}
              </div>
            ) : (
              // 嵌套在 soft-card 内：由 CSS 去掉第二层铺底，避免叠成实色
              <div className={`tb-table-shell rounded-xl ${visibleApps.length > 20 ? 'max-h-[min(75vh,900px)] overflow-y-auto' : ''}`}>
                <div className="overflow-x-auto">
                <div className={`${APPS_TABLE_GRID} tb-table-head py-2.5 sticky top-0 z-10`}>
                  <span className="text-base text-center shrink-0 invisible">🔧</span>
                  <div className="min-w-0">{t('gateway.apps.colApp')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colStatus')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colLink')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colCalls')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colTokens')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colLastUsed')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colRoute')}</div>
                  <div className="text-center min-w-0">{t('gateway.apps.colActions')}</div>
                </div>
                {renderList.map(entry => {
                  // CLI 多账号父行：轻量头行，标「N 账号」+ 添加账号（重扫）；不占状态/路由列
                  if (entry.__parent) {
                    const s = entry.sample;
                    const toolName = String(s.name || '').split(' · ')[0] || s.name;
                    const pbrand = brandIconFor(s);
                    return (
                      <div key={'grp-' + entry.agentId} className={`${APPS_TABLE_GRID} tb-table-row py-2.5`}>
                        {pbrand ? <img src={pbrand} alt="" className="w-[18px] h-[18px] mx-auto object-contain shrink-0" />
                          : isAppIcon(s.icon) ? appIconSvg(s.icon, 'w-[18px] h-[18px] mx-auto shrink-0')
                          : <span className="text-base text-center shrink-0">{s.icon}</span>}
                        <div className="text-xs font-medium tracking-tight text-zinc-800 dark:text-zinc-100 truncate min-w-0 flex items-center gap-1.5">
                          <span className="truncate">{toolName}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-700/60 text-zinc-500 dark:text-zinc-400 shrink-0">{t('gateway.apps.instanceCount', { n: entry.count })}</span>
                        </div>
                        <div /><div /><div /><div /><div />
                        <div className="text-center text-[10px] text-zinc-400">{t('gateway.apps.byInstance')}</div>
                        <div className="flex justify-end">
                          <button onClick={() => rescanInstances()} title={t('gateway.apps.addAccount')}
                            className="text-blue-500 hover:text-blue-600 dark:hover:text-blue-400 p-1 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-3.5 h-3.5"><path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14M5 12h14" /></svg>
                          </button>
                        </div>
                      </div>
                    );
                  }
                  const app = entry.app;
                  const isChild = entry.isChild;
                  const st = appStats[app.id] || { calls: 0, tokens: 0, lastTs: null };
                  const fmtTokens = n => n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M'
                    : n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n||0);
                  const fmtTime = ts => {
                    if (!ts) return '—';
                    const diff = Math.floor((Date.now() - ts*1000)/1000);
                    if (diff < 60) return t('gateway.common.justNow');
                    if (diff < 3600) return t('gateway.common.minutesAgo', { n: Math.floor(diff/60) });
                    if (diff < 86400) return t('gateway.common.hoursAgo', { n: Math.floor(diff/3600) });
                    if (diff < 7*86400) return t('gateway.common.daysAgo', { n: Math.floor(diff/86400) });
                    return new Date(ts*1000).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
                  };
                  // 状态列：在线(已纳管) / 未纳管；经网关与否由路由下拉区分
                  const keyApp = isKeyApp(app.link_method);
                  const isCfgApp = keyApp && app.host_method === 'config-file';
                  const isManual = app.link_method === 'manual';
                  const isDirectOnly = app.link_method === 'direct';        // 仅官方订阅（cursor 等）
                  const isSessionApp = app.link_method === 'session';       // 可绑路由的会话统计（WorkBuddy 等）
                  const hostable = app.link_method === 'shim' || isCfgApp || isDirectOnly;
                  // needs_dev_mode（Claude Desktop 开发者模式未就绪）时无法真正纳管：
                  // 强制按未纳管显示，避免「已纳管」与「启用开发者模式」并存的矛盾状态。
                  const tracked  = app.hosted === true && !app.needs_dev_mode;
                  const isManaged = isSessionApp ? tracked : (hostable ? tracked : (keyApp && !app._virtual_apikey));
                  const isGatewayRouted = isSessionApp
                    ? effectiveRouteIds(app).length > 0
                    : (hostable ? !!(tracked && effectiveRouteIds(app).length) : !!(keyApp && effectiveRouteIds(app).length));
                  const routeKnown = (val) => {
                    if (!val) return false;
                    // 场景路由始终可识别（按 model_key / id）
                    if (routes.some(r => (r.model_key || r.id) === val)) return true;
                    const avail = new Set(availableModels.map(m => m.id));
                    const usableRoutes = routes.filter(r => r.strategy || r.flow || (r.steps || []).some(s => s.strategy || s.scope || s.tier || s.provider || s.sharer || avail.has(s.model || s.label)));
                    return usableRoutes.some(r => (r.model_key || r.id) === val)
                      || availableModels.some(m => ['free', 'p2p', 'paid'].includes(m.tier) && modelTierKey(m) === val);
                  };
                  const currentRouteValue = (() => {
                    const primary = effectiveRouteIds(app)[0];
                    if (!primary) return '';
                    const val = routeSelectValue(primary, availableModels, routes);
                    if (keyApp && !isDirectOnly) return routeKnown(val) ? val : '';
                    if (isSessionApp) return routeKnown(val) ? val : (primary ? '' : '');
                    if (!tracked) return '';
                    return routeKnown(val) ? val : '';
                  })();
                  const currentRouteValues = app.route_multi_select
                    ? effectiveRouteIds(app)
                        .map(rid => routeSelectValue(rid, availableModels, routes))
                        .filter(v => routeKnown(v))
                    : [];
                  const isActive = isManaged;
                  /* 实心状态点，去掉霓虹 glow */
                  const statusDot = isManaged
                    ? 'bg-emerald-500'
                    : 'bg-zinc-300 dark:bg-zinc-600';
                  const rowBg = isManaged
                    ? ''
                    : 'bg-zinc-500/[0.03] dark:bg-white/[0.02]';
                  const canBindRoute = app.route_bindable !== false
                    && (app.link_method === 'session' || isDirectOnly || app.capabilities?.gateway_proxy !== false);
                  const routeLocked = isDirectOnly || !canBindRoute || ((hostable && !tracked) && !isSessionApp);
                  const showGatewayRoutes = canBindRoute && !isDirectOnly;
                  const isApiLink = app.link_method === 'manual';
                  const statusLabel = !isManaged
                    ? t('gateway.apps.statusUntracked')
                    : isApiLink
                      ? t('gateway.apps.statusApiOnline')
                      : t('gateway.apps.statusOnline');
                  const statusText = isManaged ? 'text-green-600 dark:text-green-400' : 'text-zinc-400';
                  return (
                    // 离线不整行压暗（否则操作按钮看着像禁用）；离线感由灰底/灰点/「离线」标签/
                    // 图标灰度/灰名体现，操作按钮保持全亮可点（含「测试」）。
                    <React.Fragment key={app.id}>
                    <div className={`${APPS_TABLE_GRID} tb-table-row py-3 ${rowBg}`}>
                      {/* 图标 + 名称（命中品牌则用 lobehub logo，否则回退 emoji）*/}
                      {(() => {
                        const brand = brandIconFor(app);
                        if (brand) return <img src={brand} alt="" className={`w-[18px] h-[18px] mx-auto object-contain shrink-0 ${isActive ? '' : 'grayscale opacity-60'}`} />;
                        if (isAppIcon(app.icon)) return appIconSvg(app.icon, `w-[18px] h-[18px] mx-auto shrink-0 ${isActive ? '' : 'grayscale opacity-60'}`);
                        return <span className={`text-base text-center shrink-0 ${isActive ? '' : 'grayscale opacity-60'}`}>{app.icon}</span>;
                      })()}
                      {isChild ? (
                        <div className="min-w-0 pl-4 border-l border-zinc-200 dark:border-zinc-800" title={app.name + (app.instance?.dir_glob ? '  ·  ' + app.instance.dir_glob : '')}>
                          <div className={`text-xs font-medium tracking-tight text-zinc-800 dark:text-zinc-100 truncate ${isActive ? '' : 'opacity-50'}`}>
                            {String(app.name || '').split(' · ').slice(1).join(' · ') || app.name}
                          </div>
                          {app.instance?.dir_glob && <div className="tb-table-cell-meta font-mono truncate">{tildify(app.instance.dir_glob)}</div>}
                          {app.instance?.account_email && <div className="tb-table-cell-meta truncate">{app.instance.account_email}</div>}
                        </div>
                      ) : (
                        <div
                          className={`text-xs font-medium tracking-tight text-zinc-800 dark:text-zinc-100 truncate min-w-0 ${isActive ? '' : 'opacity-50'}`}
                          title={app.name}
                        >{app.name}</div>
                      )}

                      {/* 状态列：应用=已纳管/未纳管，API=在线 */}
                      <div className="min-w-0 flex items-center gap-1.5 overflow-hidden">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`} />
                        <span className={`text-xs font-medium truncate ${statusText}`}>{statusLabel}</span>
                      </div>

                      {/* 接入方式列（居中，与表头对齐）*/}
                      <div className="min-w-0 tb-table-cell-meta truncate text-center">
                        {linkMethodLabel(app.link_method, t)}
                      </div>

                      {/* 统计：请求数 / token / 最后使用（点击打开用量明细）*/}
                      <div className="text-center overflow-hidden text-[11px] font-medium tabular-nums tracking-tight text-zinc-600 dark:text-zinc-300 rounded hover:bg-zinc-500/[0.06] dark:hover:bg-white/[0.06] cursor-pointer" title={t('gateway.apps.statsTitle')} onClick={() => setDetailApp(app)}>{st.calls > 0 ? st.calls.toLocaleString() : '—'}</div>
                      <div className="text-center overflow-hidden text-[11px] font-medium tabular-nums tracking-tight text-zinc-600 dark:text-zinc-300 rounded hover:bg-zinc-500/[0.06] dark:hover:bg-white/[0.06] cursor-pointer" title={t('gateway.apps.statsTitle')} onClick={() => setDetailApp(app)}>{st.tokens > 0 ? fmtTokens(st.tokens) : '—'}</div>
                      <div className="text-center overflow-hidden tb-table-cell-meta rounded hover:bg-zinc-500/[0.06] dark:hover:bg-white/[0.06] cursor-pointer" title={t('gateway.apps.statsTitle')} onClick={() => setDetailApp(app)}>{fmtTime(st.lastTs)}</div>

                      {/* 路由下拉：同一控件；不可绑路由时灰色禁用（与仅官方订阅应用一致） */}
                      <div className="min-w-0 overflow-visible">
                      {((keyApp || app.link_method === 'shim' || isSessionApp || isDirectOnly) && !app._virtual_apikey) && (
                      <RouteSelect
                        compact
                        multi={!!app.route_multi_select}
                        value={routeLocked ? '' : currentRouteValue}
                        values={routeLocked ? [] : currentRouteValues}
                        disabled={routeLocked}
                        routes={routes}
                        availableModels={availableModels}
                        t={t}
                        showGatewayRoutes={showGatewayRoutes}
                        isManual={isManual}
                        onChange={async (val) => {
                          if (routeLocked) return;
                          if (app.route_multi_select) {
                            await applyAppRouteSelection(app, val[0] || null, val);
                          } else {
                            await applyAppRouteSelection(app, val || null, val ? [val] : []);
                          }
                        }}
                      />
                      )}
                      </div>

                      {/* 操作区 */}
                      <div className="relative min-w-0">
                        <div className="flex items-center justify-end gap-1.5 min-w-0 max-w-full overflow-hidden">
                      {(app.api_key || isDirectOnly) && (() => {
                        const ts = testState[app.id];
                        return (
                          <button onClick={() => runAppTest(app)} disabled={ts?.busy || !isGatewayRouted}
                            className={`text-[11px] px-1.5 py-1 rounded-lg border transition-colors shrink-0 ${ts?.busy
                              ? 'border-zinc-300 dark:border-zinc-600 text-zinc-400 opacity-60 cursor-wait'
                              : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-500'} disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-zinc-200 disabled:hover:text-zinc-500`}>
                            {ts?.busy ? t('gateway.common.testing') : t('gateway.common.test')}
                          </button>
                        );
                      })()}
                      {!app._virtual_apikey ? (
                        <button onClick={() => openAppSettings(app)}
                          className="text-[11px] px-1.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors shrink-0">
                          {t('gateway.common.settings')}
                        </button>
                      ) : null}
                      {isDirectOnly || isSessionApp ? (
                        tracked ? (
                          <button onClick={() => setTracked(app, false)} disabled={busyId === app.id}
                            title={t('gateway.apps.revertTitle')}
                            className="text-[11px] px-1.5 py-1 rounded-lg border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 shrink-0">
                            {busyId === app.id ? '…' : t('gateway.common.revert')}
                          </button>
                        ) : (
                          <button onClick={() => setTracked(app, true)} disabled={busyId === app.id}
                            className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 text-white disabled:opacity-40 shrink-0 font-medium transition-colors">
                            {busyId === app.id ? '…' : t('gateway.common.manage')}
                          </button>
                        )
                      ) : app.link_method === 'shim' ? (
                        tracked ? (
                          <button onClick={() => setTracked(app, false)} disabled={busyId === app.agent_id || busyId === app.id}
                            className="text-[11px] px-1.5 py-1 rounded-lg border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 shrink-0">
                            {(busyId === app.agent_id || busyId === app.id) ? '…' : t('gateway.common.revert')}
                          </button>
                        ) : (
                          <button onClick={() => setTracked(app, true)} disabled={busyId === app.agent_id || busyId === app.id}
                            className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 text-white disabled:opacity-40 shrink-0 font-medium transition-colors">
                            {(busyId === app.agent_id || busyId === app.id) ? '…' : t('gateway.common.manage')}
                          </button>
                        )
                      ) : app._virtual_apikey ? (
                        <button onClick={() => addApiKeyApp(app)} disabled={busyId === app.id}
                          className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 text-white disabled:opacity-40 shrink-0 font-medium transition-colors">
                          {busyId === app.id ? '…' : t('gateway.common.manage')}
                        </button>
                      ) : app.host_method === 'config-file' ? (
                        app.needs_dev_mode ? (
                          // 开发者模式未就绪：弹出「如何启用」的步骤提示（非设置窗口），绝不显示危险的「删除」
                          <button onClick={() => { setDevTipMsg(''); setDevTipApp(app); }}
                            title={t('gateway.app.devModeTitle')}
                            className="text-[11px] px-2.5 py-1 rounded-lg border border-amber-300 dark:border-amber-700/60 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors shrink-0 font-medium">
                            {t('gateway.apps.enableDevMode')}
                          </button>
                        ) : tracked ? (
                          <button onClick={() => setTracked(app, false)} disabled={busyId === app.id}
                            className="text-[11px] px-1.5 py-1 rounded-lg border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-40 shrink-0">
                            {busyId === app.id ? '…' : t('gateway.common.revert')}
                          </button>
                        ) : (
                          <button onClick={() => setTracked(app, true)} disabled={busyId === app.id}
                            className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 text-white disabled:opacity-40 shrink-0 font-medium transition-colors">
                            {busyId === app.id ? '…' : t('gateway.common.manage')}
                          </button>
                        )
                      ) : (
                        <button onClick={() => handleDeleteApp(app.id)}
                          className="text-[11px] px-1.5 py-1 rounded-lg border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors shrink-0">
                          {t('gateway.common.delete')}
                        </button>
                      )}
                        </div>
                      {(app.api_key || isDirectOnly) && (
                        <AppTestResultHint ts={testState[app.id]} t={t} />
                      )}
                      {(() => {
                        const key = app.agent_id || app.id;
                        const msg = notice[key];
                        if (!msg) return null;
                        const isWarn = msg.startsWith('⚠');
                        return (
                          <div
                            className={`mt-0.5 text-right text-[10px] leading-tight truncate max-w-full ${isWarn ? 'text-amber-500 dark:text-amber-400' : 'text-green-600 dark:text-green-400'}`}
                            title={msg}
                          >{msg}</div>
                        );
                      })()}
                      </div>
                    </div>
                    {(app.api_key || isDirectOnly) && testState[app.id]?.ok === false && !testState[app.id]?.busy && (
                      <AppTestErrorFloat error={testState[app.id].error} />
                    )}
                    </React.Fragment>
                  );
                })}
                </div>
              </div>
            )}
          </div>
    </>
  );
}

function AgentLinker() {
  const { t } = useLang();
  const [agents, setAgents]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState({});   // id → true
  const [notice, setNotice]   = useState({});   // id → 提示文字

  const refresh = useCallback(async () => {
    try { setAgents(await listAgents()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleApply(id) {
    setBusy(b => ({ ...b, [id]: true }));
    setNotice(n => ({ ...n, [id]: '' }));
    try {
      const r = await applyAgent(id);
      if (r.ok) {
        let msg = r.needsRestartShell ? t('gateway.agent.appliedShell') : t('gateway.agent.applied');
        if (r.enabledProvider) msg += t('gateway.agent.enabledProvider', { name: r.enabledProvider });
        setNotice(n => ({ ...n, [id]: msg }));
        await refresh();
      } else {
        setNotice(n => ({ ...n, [id]: '✗ ' + (r.error || t('gateway.common.failed')) }));
      }
    } catch (e) { setNotice(n => ({ ...n, [id]: '✗ ' + e.message })); }
    setBusy(b => ({ ...b, [id]: false }));
  }

  async function handleRevert(id) {
    setBusy(b => ({ ...b, [id]: true }));
    setNotice(n => ({ ...n, [id]: '' }));
    try {
      const r = await revertAgent(id);
      if (r.ok) { setNotice(n => ({ ...n, [id]: t('gateway.agent.reverted') })); await refresh(); }
      else       { setNotice(n => ({ ...n, [id]: '✗ ' + (r.error || t('gateway.common.failed')) })); }
    } catch (e) { setNotice(n => ({ ...n, [id]: '✗ ' + e.message })); }
    setBusy(b => ({ ...b, [id]: false }));
  }

  return (
    <div className="tb-soft-card rounded-xl p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px] shrink-0 text-zinc-400 dark:text-zinc-500">
          <path d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
        <h2 className="font-semibold text-zinc-800 dark:text-zinc-100 text-sm">{t('gateway.agent.title')}</h2>
        <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('gateway.agent.subtitle')}</span>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={refresh} className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">{t('gateway.common.refresh')}</button>
          <ImportConfigButton onImported={refresh} />
        </div>
      </div>
      {loading ? (
        <div className="text-xs text-zinc-400 py-2">{t('gateway.agent.detecting')}</div>
      ) : agents.length === 0 ? (
        <div className="text-xs text-zinc-400 py-2">{t('gateway.agent.empty')}</div>
      ) : (
        <div className="flex flex-col gap-2">
          {agents.map(a => (
            <div key={a.id}
              className={`tb-soft-tile flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
                ${!a.installed ? 'opacity-40' :
                  a.linked ? 'border-green-300/70 dark:border-green-800/60 bg-green-50/50 dark:bg-green-950/25' : ''}`}
            >
              {/* 状态点 */}
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                !a.installed ? 'bg-zinc-300 dark:bg-zinc-600' :
                a.linked     ? 'bg-green-400' : 'bg-zinc-400 dark:bg-zinc-500'}`} />

              {/* 名称 + 策略 */}
              <div className="flex-1 min-w-0">
                <span className="font-medium text-zinc-800 dark:text-zinc-100">{a.name}</span>
                <span className="ml-2 text-xs text-zinc-400">
                  {a.installed ? (strategyLabel(a.strategy, t) || a.strategy) : t('gateway.agent.notInstalled')}
                </span>
              </div>

              {/* 接入状态标签 */}
              {a.installed && (
                <span className={`text-xs px-2 py-0.5 rounded-full shrink-0
                  ${a.linked ? 'bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300'
                              : 'bg-zinc-100 dark:bg-zinc-700 text-zinc-500 dark:text-zinc-400'}`}>
                  {a.linked ? t('gateway.agent.linked') : t('gateway.agent.notLinked')}
                </span>
              )}

              {/* 提示文字 */}
              {notice[a.id] && (
                <span className={`text-xs shrink-0 max-w-[200px] truncate ${notice[a.id].startsWith('✓') ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}
                  title={notice[a.id]}>
                  {notice[a.id]}
                </span>
              )}

              {/* 操作按钮 */}
              {a.installed && !a.linked && (
                <button
                  disabled={busy[a.id]}
                  onClick={() => handleApply(a.id)}
                  className="shrink-0 text-xs px-3 py-1 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white disabled:opacity-50 transition-colors">
                  {busy[a.id] ? t('gateway.agent.applying') : t('gateway.agent.apply')}
                </button>
              )}
              {a.installed && a.linked && (
                <button
                  disabled={busy[a.id]}
                  onClick={() => handleRevert(a.id)}
                  className="shrink-0 text-xs px-3 py-1 rounded-lg bg-zinc-200 dark:bg-zinc-700 hover:bg-zinc-300 dark:hover:bg-zinc-600 text-zinc-700 dark:text-zinc-300 disabled:opacity-50 transition-colors">
                  {busy[a.id] ? t('gateway.agent.reverting') : t('gateway.common.revert')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">
        {t('gateway.agent.hint')}
      </p>
    </div>
  );
}

// ── Tier helpers ──────────────────────────────────────────────────────────────

// 层级配色：柔和、跟随明暗模式（浅色 -50 底/-700 字，深色 -900/25 底/-300 字），与全站徽标一致
function tierStyle(tier) {
  if (tier === 'p2p')  return 'bg-blue-50 dark:bg-blue-900/25 border-blue-200 dark:border-blue-800/40 text-blue-700 dark:text-blue-300';
  if (tier === 'paid') return 'bg-amber-50 dark:bg-amber-900/25 border-amber-200 dark:border-amber-800/40 text-amber-700 dark:text-amber-300';
  return 'bg-emerald-50 dark:bg-emerald-900/25 border-emerald-200 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-300';
}
function tierDot(tier) {
  if (tier === 'p2p')  return 'bg-blue-500';
  if (tier === 'paid') return 'bg-amber-500';
  return 'bg-emerald-500';
}
// 路由明细 inline 短标签：远程(p2p) / 本地(free/paid)
function tierShortLabel(tier, t) {
  if (tier === 'p2p') return t('gateway.app.tier.remoteShort');
  if (tier === 'free' || tier === 'paid') return t('gateway.app.tier.localShort');
  return tier;
}

// Resolve step tier: 优先 step 上记录的 tier（同 id 跨层时），再查 availableModels
function resolveStepTier(stepModel, step, availableModels) {
  if (step?.tier) return step.tier;
  const m = availableModels.find(x => x.id === stepModel);
  return m ? m.tier : 'free';
}

// ── CopyButton ────────────────────────────────────────────────────────────────

function CopyButton({ text, label: labelProp, className = '' }) {
  const { t } = useLang();
  const label = labelProp ?? t('gateway.common.copy');
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button onClick={copy}
      className={`text-xs px-2 py-1 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors ${className}`}>
      {copied ? t('gateway.common.copiedSpace') : label}
    </button>
  );
}

// ── ModelSelect ───────────────────────────────────────────────────────────────

function ModelSelect({ availableModels, value, onChange }) {
  const { t } = useLang();
  const freeModels = availableModels.filter(m => m.tier === 'free');
  const p2pModels  = availableModels.filter(m => m.tier === 'p2p');
  const paidModels = availableModels.filter(m => m.tier === 'paid');
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full bg-zinc-200 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded-lg px-2.5 py-2 text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500">
      {freeModels.length > 0 && (
        <optgroup label={t('gateway.app.tier.freeLayer')}>
          {freeModels.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}
        </optgroup>
      )}
      {p2pModels.length > 0 && (
        <optgroup label={t('gateway.app.tier.p2pLayer')}>
          {p2pModels.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}
        </optgroup>
      )}
      {paidModels.length > 0 && (
        <optgroup label={t('gateway.app.tier.paidLayer')}>
          {paidModels.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}
        </optgroup>
      )}
    </select>
  );
}

// ── SceneRouteEditor ──────────────────────────────────────────────────────────

// 条件路由：条件类型元数据（与网关 evalWhen 的 type/op 一致）
function ruleCondTypes(t) {
  return [
    { type: 'request_type', label: t('gateway.rule.type.requestType'), ops: ['is', 'not'], values: ['chat', 'image', 'video', 'embedding', 'audio'] },
    { type: 'input_tokens', label: t('gateway.rule.type.inputTokens'), ops: ['gt', 'lt', 'gte', 'lte'], value: 'number' },
    { type: 'keyword',      label: t('gateway.rule.type.keyword'),     ops: ['match', 'contains'], value: 'text', placeholder: t('gateway.rule.keywordPlaceholder') },
    { type: 'model',        label: t('gateway.rule.type.model'),       ops: ['is', 'contains'], value: 'text', placeholder: t('gateway.rule.modelPlaceholder') },
    { type: 'caller',       label: t('gateway.rule.type.caller'),      ops: ['is'], value: 'text', placeholder: t('gateway.rule.callerPlaceholder') },
    { type: 'classifier',   label: t('gateway.rule.type.classifier'),  ops: ['is', 'not'], value: 'category' },
  ];
}
function ruleOpLabel(t) {
  return { is: t('gateway.rule.op.is'), not: t('gateway.rule.op.not'), gt: '>', lt: '<', gte: '≥', lte: '≤', match: t('gateway.rule.op.match'), contains: t('gateway.rule.op.contains') };
}
const RULE_SEL = 'bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded px-1.5 py-1 text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500';
// 路由级设置下拉（过滤/流转/输出风格）统一样式
const ROUTE_META_SEL = 'text-xs bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded px-2 py-1 text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500';

// 单条 when 条件编辑器：条件类型 + 算子 + 值（值控件随类型变化）。
// categories：智能分类的类别集合（来自分类器配置），用于「智能分类」条件的值下拉。
function RuleConditionEditor({ when, onChange, categories = [] }) {
  const { t } = useLang();
  const RULE_COND_TYPES = ruleCondTypes(t);
  const RULE_OP_LABEL = ruleOpLabel(t);
  const meta = RULE_COND_TYPES.find(c => c.type === when.type) || RULE_COND_TYPES[0];
  const setType = (t) => {
    const m = RULE_COND_TYPES.find(c => c.type === t);
    const v = m.values ? m.values[0] : (m.value === 'number' ? 0 : (m.value === 'category' ? (categories[0] || '') : ''));
    onChange({ type: t, op: m.ops[0], value: v });
  };
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-xs text-zinc-500 shrink-0">{t('gateway.rule.when')}</span>
      <select value={when.type} onChange={e => setType(e.target.value)} className={RULE_SEL}>
        {RULE_COND_TYPES.map(c => <option key={c.type} value={c.type}>{c.label}</option>)}
      </select>
      <select value={when.op} onChange={e => onChange({ ...when, op: e.target.value })} className={RULE_SEL}>
        {meta.ops.map(o => <option key={o} value={o}>{RULE_OP_LABEL[o] || o}</option>)}
      </select>
      {meta.values ? (
        <select value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} className={RULE_SEL}>
          {meta.values.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
      ) : meta.value === 'category' ? (
        categories.length
          ? <select value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} className={RULE_SEL}>
              {categories.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          : <input value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} placeholder={t('gateway.rule.categoryPlaceholder')} className={RULE_SEL + ' w-44'} />
      ) : meta.value === 'number' ? (
        <input type="number" value={when.value} onChange={e => onChange({ ...when, value: +e.target.value })} className={RULE_SEL + ' w-24'} />
      ) : (
        <input value={when.value} onChange={e => onChange({ ...when, value: e.target.value })} placeholder={meta.placeholder} className={RULE_SEL + ' w-44'} />
      )}
    </div>
  );
}

// 路由链编辑器（默认链 + 每条规则各一个）。每步是一个 Selector：model + 可选 strategy/sharer。
// 分享者(sharer)化名句柄来自 /public/network（服务端带盐哈希；不含用户名）。
function ChainEditor({ steps, setSteps, availableModels, network, sources, fScope = '', fTier = '', categories = [], softIncomplete = false }) {
  const { t } = useLang();
  const list = steps || [];
  // 路由级过滤：顶层选了 仅免费/仅付费/仅个人/仅社区 → 顺带过滤模型菜单（个人≈非社区的本地模型）
  const filteredModels = (availableModels || []).filter(m => {
    if (fTier && m.tier !== fTier) return false;
    if (fScope === 'community' && m.tier !== 'p2p') return false;
    if (fScope === 'personal' && m.tier === 'p2p') return false;
    return true;
  });
  // 该步选定模型下可用的具体源：源声明了该模型（或无 models 列表=接受任意）+ tier 匹配
  const sourcesForStep = (step) => {
    if (!step.model) return [];
    return (sources || []).filter(p => {
      if (step.tier && p.type !== step.tier) return false;
      const ms = p.models || [];
      return !Array.isArray(ms) || ms.length === 0 || ms.some(m => (typeof m === 'string' ? m : m?.name) === step.model);
    });
  };
  // 该步选定模型下的社区服务节点（分享账户）——与社区源界面同源：workersForModel + 打码用户名 w.name。
  // 钉选值优先用稳定的 sharer（云端部署后有），否则回退 worker_id。
  const nodesForStep = (step) => {
    if (!step.model) return [];
    return workersForModel(step.model, network).map(w => ({
      id: w.sharer || w.worker_id || w.name,
      name: w.name || 'node',
      ttft: w.last_ttft_ms,
    }));
  };
  const add    = () => setSteps([...list, { label: '', model: '', scope: '', tier: '', strategy: '', sharer: '' }]);
  const remove = (i) => setSteps(list.filter((_, idx) => idx !== i));
  const patch  = (i, p) => setSteps(list.map((s, idx) => idx === i ? { ...s, ...p } : s));
  const updateModel = (i, val) => {
    // 清空「选择模型」= 未配置完整：一并清掉残留 tier，避免保存成开放扫描步
    if (!val) {
      patch(i, {
        label: '', model: '', tier: '', scope: '', strategy: '',
        provider: undefined, sharer: undefined, vision_assist: undefined,
      });
      return;
    }
    const m = availableModels.find(x => modelTierKey(x) === val)
           || availableModels.find(x => x.id === val);
    const modelId = m?.id ?? val;
    const tier = m?.tier ?? 'free';
    patch(i, { label: modelId, model: modelId, tier, provider: undefined, sharer: undefined });   // 换模型清掉旧的源钉选(账户/节点)
  };
  return (
    <div className="space-y-1.5">
      {list.map((step, i) => {
        // 两级：模型 → 具体源。第二级按所选模型动态：社区模型=共享节点(用户名)；直连模型=源账户。
        const isCommunityModel = step.tier === 'p2p';
        const specificOpts = !step.model ? []
          : (isCommunityModel
              ? nodesForStep(step).map(n => ({ value: n.id, label: n.name }))
              : sourcesForStep(step).map(p => ({ value: p.id, label: p.label || p.name || p.id })));
        const specificVal = isCommunityModel ? (step.sharer || '') : (step.provider || '');
        const setSpecific = (v) => patch(i, isCommunityModel
          ? { sharer: v || undefined, provider: undefined }
          : { provider: v || undefined, sharer: undefined });
        // 模型下拉的选中值：优先精确 tier:model，tier 被改成"任意/其它"时退回按同名任一项，保证模型名不消失
        const modelVal = !step.model ? ''
          : (step.tier && availableModels.some(m => modelTierKey(m) === modelTierKey({ id: step.model, tier: step.tier }))
              ? modelTierKey({ id: step.model, tier: step.tier })
              : (availableModels.find(m => m.id === step.model) ? modelTierKey(availableModels.find(m => m.id === step.model)) : step.model));
        return (
        <div key={i} className={`group border rounded-lg px-2 py-1.5 ${
          !step.model && !step.strategy
            ? (softIncomplete
              ? 'border-dashed border-zinc-300 dark:border-zinc-600 bg-transparent'
              : 'border-amber-300/80 dark:border-amber-700/50 bg-amber-50/40 dark:bg-amber-900/10')
            : step.when
              ? 'border-blue-300/70 dark:border-blue-700/50 bg-blue-50/30 dark:bg-blue-900/10'
              : 'border-zinc-200/70 dark:border-zinc-700/70'
        }`}>
          {/* 该步的条件（可选）：带条件=命中才用，无条件=兜底 */}
          {step.when && (
            <div className="flex items-start gap-2 mb-1.5 pb-1.5 border-b border-blue-200/50 dark:border-blue-800/40">
              <span className="text-[11px] text-blue-500 dark:text-blue-400 shrink-0 pt-1">{t('gateway.route.conditionLabel')}</span>
              <div className="flex-1 min-w-0"><RuleConditionEditor when={step.when} onChange={w => patch(i, { when: w })} categories={categories} /></div>
              <button onClick={() => patch(i, { when: undefined })} title={t('gateway.route.removeCondition')}
                className="text-[11px] text-zinc-400 hover:text-red-500 shrink-0 pt-1 px-1">✕</button>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400 w-4 text-right shrink-0">{i + 1}</span>
            <select value={modelVal} onChange={e => updateModel(i, e.target.value)}
              className="flex-1 min-w-0 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded-lg px-2.5 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500">
              <option value="">{t('gateway.route.selectModel')}</option>
              {tierOptgroups(filteredModels, t)}
            </select>
            {!step.when && (
              <button onClick={() => patch(i, { when: { type: 'input_tokens', op: 'gt', value: 50000 } })}
                className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline shrink-0 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">{t('gateway.route.addCondition')}</button>
            )}
            <button onClick={() => remove(i)}
              className="text-xs text-zinc-400 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-1">✕</button>
          </div>
          {/* 第二级：具体源——按所选模型动态。社区模型=共享节点(用户名)；直连模型=源账户。只在有多个源时出现 */}
          {step.model && specificOpts.length >= 2 && (
          <div className="flex items-center gap-2 mt-1 pl-6">
            <span className="text-[11px] text-zinc-400 shrink-0">{isCommunityModel ? t('gateway.route.pickNode') : t('gateway.route.pickAccount')}</span>
            <select value={specificVal} onChange={e => setSpecific(e.target.value)}
              title={isCommunityModel ? t('gateway.route.sharerPin') : t('gateway.route.sourcePin')}
              className="min-w-0 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded px-1.5 py-1 text-[11px] text-zinc-700 dark:text-zinc-300 focus:outline-none">
              <option value="">{t('gateway.route.sourceAuto')}</option>
              {specificOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          )}
          {/* 识图增强：有图时先调多模态助手，再把描述交给本步主模型 */}
          {step.model && (
          <div className="flex items-center gap-2 mt-1 pl-6">
            <span className="text-[11px] text-zinc-400 shrink-0" title={t('gateway.route.visionAssistHint')}>{t('gateway.route.visionAssist')}</span>
            <select
              value={step.vision_assist?.model
                ? (availableModels.find(m => m.id === step.vision_assist.model)
                    ? modelTierKey(availableModels.find(m => m.id === step.vision_assist.model))
                    : step.vision_assist.model)
                : ''}
              onChange={(e) => {
                const val = e.target.value;
                if (!val) { patch(i, { vision_assist: undefined }); return; }
                const m = availableModels.find(x => modelTierKey(x) === val)
                  || availableModels.find(x => x.id === val);
                patch(i, {
                  vision_assist: {
                    model: m?.id || val,
                    ...(m?.tier ? { tier: m.tier } : {}),
                    ...(step.vision_assist?.prompt ? { prompt: step.vision_assist.prompt } : {}),
                    ...(step.vision_assist?.max_tokens ? { max_tokens: step.vision_assist.max_tokens } : {}),
                  },
                });
              }}
              className="min-w-0 flex-1 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded px-1.5 py-1 text-[11px] text-zinc-700 dark:text-zinc-300 focus:outline-none">
              <option value="">{t('gateway.route.visionAssistOff')}</option>
              {tierOptgroups(
                // 识图助手只列图文模型（type=vision / vision 标志）
                (() => {
                  const visionOnly = filteredModels.filter(m => m.type === 'vision' || !!m.vision);
                  const curId = step.vision_assist?.model;
                  // 历史已选非图文仍保留一项，避免下拉空白丢配置
                  if (curId && !visionOnly.some(m => m.id === curId)) {
                    const cur = availableModels.find(m => m.id === curId)
                      || filteredModels.find(m => m.id === curId);
                    if (cur) return [cur, ...visionOnly];
                  }
                  return visionOnly;
                })(),
                t,
              )}
            </select>
          </div>
          )}
        </div>
        );
      })}
      <button onClick={add} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{t('gateway.route.addStep')}</button>
    </div>
  );
}

function SceneRouteEditor({ route, availableModels, network, sources, onSave, onCancel }) {
  const { t } = useLang();
  const [name, setName]   = useState(route.scene_name || '');
  const [icon, setIcon]   = useState(route.icon || 'icon:shuffle');
  // 统一步骤：每步可选带一个条件 when；老 rules 摊平成"带 rule.when 的步" + 默认步(无 when)
  const [steps, setSteps] = useState(() => {
    const flat = [];
    for (const r of (route.rules || [])) for (const s of (r.steps || [])) flat.push({ ...s, when: s.when || r.when });
    for (const s of (route.steps || [])) flat.push(s);
    return flat;
  });
  const [clsModel, setClsModel] = useState(route.classifier?.model || '');
  const [clsCats,  setClsCats]  = useState((route.classifier?.categories || t('gateway.rule.defaultCategories').split(/[,、]/).map(s => s.trim()).filter(Boolean)).join('、'));
  const [cavemanLevel, setCavemanLevel] = useState(route.caveman_level || null);
  const [flow, setFlow] = useState(route.flow || 'round-robin');   // 链级流转策略（步之间怎么走）；无「默认」项，空即轮询
  // 路由级统一过滤（和流转并列在顶层）：来源 rScope(personal/community) 与 价格 rTier(free/paid) 互斥选一，
  // 选中后顺带过滤下方步骤的模型菜单。空=不限。
  const [rScope, setRScope] = useState(route.scope || '');
  const [rTier, setRTier]   = useState(route.tier || '');
  const routeFilter = rScope || rTier || '';
  const setRouteFilter = (v) => {
    if (v === 'personal' || v === 'community') { setRScope(v); setRTier(''); }
    else if (v === 'free' || v === 'paid')     { setRTier(v); setRScope(''); }
    else { setRScope(''); setRTier(''); }
  };

  const usesClassifier = steps.some(s => s.when?.type === 'classifier');
  const categories = clsCats.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean);

  // ── codec 预览（默认折叠，点路由名后的按钮展开）：flow · filter 头 + 每步「[条件⇒] 模型@源」。
  // 全部用英文 codec token(personal/community/free/paid、input_tokens 等)，不本地化——codec 是技术串。
  const [showCodec, setShowCodec] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const _condLabel = (w) => (!w || !w.type) ? '' : `${w.type} ${w.op || 'is'} ${w.value ?? ''}`.trim();
  const codecHead = [flow, rScope || rTier].filter(Boolean).join(' · ');
  // 仅「已选模型 / 显式 strategy」算已配置；裸 tier 残留不进 codec
  const codecSteps = (steps || [])
    .filter(s => s.model || s.strategy)
    .map(s => {
      const cond = s.when && s.when.type ? `${_condLabel(s.when)} ⇒ ` : '';
      const src = (s.provider || s.sharer) ? `@${s.provider || s.sharer}` : '';
      const body = s.model ? `${s.model}${src}` : (s.strategy || '任意');
      return cond + body;
    });
  // 未选模型的步骤：有「限定/流转」时不算错误（策略路由会忽略它们）；否则须选模型或删掉
  const incompleteSteps = (steps || []).filter(s => !s.model && !s.strategy);
  const strategyMode = !!(flow || rScope || rTier);

  function save() {
    // 只持久化已选模型（或显式 strategy）的步骤；未选模型的空步丢弃，避免与流转策略抢语义
    const clean = (arr) => (arr || []).filter(s => s.model || s.strategy).map(s => ({
      ...(s.model ? { model: s.model } : {}),
      ...(s.scope ? { scope: s.scope } : {}),
      ...(s.tier ? { tier: s.tier } : {}),
      ...(s.strategy ? { strategy: s.strategy } : {}),
      ...(s.sharer   ? { sharer: s.sharer }     : {}),
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.when && s.when.type ? { when: s.when } : {}),
      ...(s.vision_assist?.model ? {
        vision_assist: {
          model: s.vision_assist.model,
          ...(s.vision_assist.tier ? { tier: s.vision_assist.tier } : {}),
          ...(s.vision_assist.prompt ? { prompt: s.vision_assist.prompt } : {}),
          ...(s.vision_assist.max_tokens ? { max_tokens: s.vision_assist.max_tokens } : {}),
        },
      } : {}),
    }));
    const cleaned = clean(steps);
    // 既无步骤模型，又无限定/流转 → 无法路由
    if (!cleaned.length && !strategyMode) {
      setSaveErr(t('gateway.route.needStepsOrStrategy'));
      return;
    }
    setSaveErr('');
    const classifier = (usesClassifier && clsModel && categories.length)
      ? { model: clsModel, categories } : undefined;
    onSave({ ...route, scene_name: name, icon, rules: undefined, steps: cleaned, classifier, caveman_level: cavemanLevel || null, flow: flow || undefined, scope: rScope || undefined, tier: rTier || undefined });
  }

  return (
    <div className="border-t border-zinc-200/60 dark:border-zinc-800/60 bg-zinc-50/50 dark:bg-zinc-800/20 px-5 py-4 space-y-3">
      <div className="flex gap-2 items-center">
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder={t('gateway.route.namePlaceholder')}
          className="flex-1 bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 rounded-lg px-2.5 py-1.5 text-xs text-zinc-800 dark:text-zinc-200 focus:outline-none focus:border-blue-500" />
        {/* codec 预览：默认折叠，点击展开 */}
        <button type="button" onClick={() => setShowCodec(v => !v)} title="codec"
          className="shrink-0 flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors">
          codec <span className={`transition-transform ${showCodec ? 'rotate-180' : ''}`}>▾</span>
        </button>
      </div>
      {showCodec && (
        <div className="rounded-lg bg-zinc-100/70 dark:bg-zinc-800/40 px-3 py-2 font-mono text-[11px] text-zinc-600 dark:text-zinc-300 leading-relaxed break-words">
          <span className="text-blue-600 dark:text-blue-400">{codecHead || 'round-robin'}</span>
          {codecSteps.map((c, i) => (
            <span key={i}><span className="text-zinc-400 dark:text-zinc-500">{i === 0 ? '  ‖  ' : '  ▸  '}</span>{c}</span>
          ))}
        </div>
      )}

      {/* 路由级设置（全局，最上层）：过滤 + 流转策略 + 输出风格，一行紧凑排布（窄屏自动换行）*/}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 pt-1 pb-2 border-b border-zinc-200/60 dark:border-zinc-700/50">
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500 shrink-0">{t('gateway.route.filterLabel')}</span>
          <select value={routeFilter} onChange={e => setRouteFilter(e.target.value)}
            title={t('gateway.route.filterHint')} className={ROUTE_META_SEL}>
            <option value="">{t('gateway.route.filterAny')}</option>
            <option value="free">{t('gateway.route.tierFree')}</option>
            <option value="paid">{t('gateway.route.tierPaid')}</option>
            <option value="personal">{t('gateway.route.scopePersonal')}</option>
            <option value="community">{t('gateway.route.scopeCommunity')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500 shrink-0">{t('gateway.route.flowLabel')}</span>
          <select value={flow || 'round-robin'} onChange={e => setFlow(e.target.value || 'round-robin')}
            title={t('gateway.route.flowHint')} className={ROUTE_META_SEL}>
            <option value="auto">auto · {t('gateway.route.flowAuto')}</option>
            <option value="adaptive">adaptive · {t('gateway.route.flowAdaptive')}</option>
            <option value="cost">cost · {t('gateway.route.flowCost')}</option>
            <option value="speed">speed · {t('gateway.route.flowSpeed')}</option>
            <option value="round-robin">round-robin · {t('gateway.route.flowRoundRobin')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-500 shrink-0">{t('gateway.route.outputStyle')}</span>
          <select value={cavemanLevel || ''} onChange={e => setCavemanLevel(e.target.value || null)}
            className={ROUTE_META_SEL}>
            <option value="">{t('gateway.route.outputStyleDefault')}</option>
            <option value="lite">{t('gateway.route.outputStyleLite')}</option>
            <option value="full">{t('gateway.route.outputStyleFull')}</option>
            <option value="ultra">{t('gateway.route.outputStyleUltra')}</option>
          </select>
        </label>
      </div>

      {/* 步骤（整合了原「条件规则」+「默认链」）：每步可选带一个条件；候选怎么选由「流转策略」决定 */}
      <ChainEditor steps={steps} setSteps={setSteps} availableModels={availableModels} network={network} sources={sources} fScope={rScope} fTier={rTier} categories={categories} softIncomplete={strategyMode} />
      {steps.length === 0 && !flow && <p className="text-xs text-zinc-500">{t('gateway.route.noSteps')}</p>}
      {incompleteSteps.length > 0 && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {strategyMode ? t('gateway.route.incompleteStepsIgnored') : t('gateway.route.incompleteSteps')}
        </p>
      )}

      {/* 分类器配置（某步用「智能分类」条件时显示）：先用便宜模型把输入归类，再按类别路由 */}
      {usesClassifier && (
        <div className="border border-indigo-200 dark:border-indigo-800/40 rounded-lg p-2.5 space-y-2 bg-indigo-50/40 dark:bg-indigo-900/10">
          <div className="text-xs font-medium text-indigo-600 dark:text-indigo-400">{t('gateway.route.classifier')}</div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-500 w-12 shrink-0">{t('gateway.route.clsModel')}</label>
            <select value={clsModel} onChange={e => setClsModel(e.target.value)} className={RULE_SEL + ' flex-1'}>
              <option value="">{t('gateway.route.clsModelPlaceholder')}</option>
              {availableModels.map(m => <option key={modelTierKey(m)} value={modelTierKey(m)}>{m.id}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-zinc-500 w-12 shrink-0">{t('gateway.route.clsCategories')}</label>
            <input value={clsCats} onChange={e => setClsCats(e.target.value)} placeholder={t('gateway.route.clsCategoriesPlaceholder')}
              className={RULE_SEL + ' flex-1'} />
          </div>
          <div className="text-xs text-zinc-400">{t('gateway.route.clsHint')}</div>
        </div>
      )}

      {saveErr && <p className="text-xs text-red-500">{saveErr}</p>}
      <div className="flex gap-2 pt-1">
        <button onClick={save}
          className="text-xs bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white px-4 py-1.5 rounded-lg font-medium transition-colors">
          {t('gateway.common.save')}
        </button>
        <button onClick={onCancel}
          className="text-xs bg-zinc-100 dark:bg-zinc-700 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 px-3 py-1.5 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-600 transition-colors">
          {t('gateway.common.cancel')}
        </button>
      </div>
    </div>
  );
}

// ── Code snippets ─────────────────────────────────────────────────────────────

function snippetModelType(model, modelType) {
  if (modelType && modelType !== 'chat') return modelType;
  const bare = model ? (parseRouteBinding(model).modelId || model) : '';
  return bare ? inferModelTypeFromName(bare) : 'chat';
}

function codeSnippet(lang, baseUrl, apiKey, model = 'claude-opus-4-5', modelType) {
  const modality = snippetModelType(model, modelType);

  // 图像模态 → OpenAI Images API
  if (modality === 'image') {
    switch (lang) {
      case 'curl':
      case 'curl-oai':
        return `curl ${baseUrl}/images/generations \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "prompt": "一只可爱的狗",
    "n": 1,
    "response_format": "b64_json"
  }'`;
      case 'python':
      case 'openai':
        return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",
)
resp = client.images.generate(
    model="${model}",
    prompt="一只可爱的狗",
    n=1,
    response_format="b64_json",
)
print(resp.data[0].b64_json[:80], "...")`;
      case 'nodejs':
        return `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${baseUrl}',
  apiKey: '${apiKey}',
});
const resp = await client.images.generate({
  model: '${model}',
  prompt: '一只可爱的狗',
  n: 1,
  response_format: 'b64_json',
});
console.log(resp.data[0].b64_json?.slice(0, 80), '...');`;
      default: return '';
    }
  }

  // 向量模态 → OpenAI Embeddings API
  if (modality === 'embedding') {
    switch (lang) {
      case 'curl':
      case 'curl-oai':
        return `curl ${baseUrl}/embeddings \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "input": "Hello!"
  }'`;
      case 'python':
      case 'openai':
        return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",
)
resp = client.embeddings.create(
    model="${model}",
    input="Hello!",
)
print(len(resp.data[0].embedding))`;
      case 'nodejs':
        return `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${baseUrl}',
  apiKey: '${apiKey}',
});
const resp = await client.embeddings.create({
  model: '${model}',
  input: 'Hello!',
});
console.log(resp.data[0].embedding.length);`;
      default: return '';
    }
  }

  // 对话模态（默认）
  switch (lang) {
    case 'curl':
      return `curl ${baseUrl}/messages \\
  -H "x-api-key: ${apiKey}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "stream": true,
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
    case 'python':
      return `import anthropic

client = anthropic.Anthropic(
    base_url="${baseUrl}",
    api_key="${apiKey}",
)
msg = client.messages.create(
    model="${model}",
    max_tokens=1024,
    stream=True,
    messages=[{"role": "user", "content": "Hello!"}],
)
for event in msg:
    if event.type == "content_block_delta":
        print(event.delta.text, end="", flush=True)`;
    case 'nodejs':
      return `import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: '${baseUrl}',
  apiKey: '${apiKey}',
});
const stream = await client.messages.create({
  model: '${model}',
  maxTokens: 1024,
  stream: true,
  messages: [{ role: 'user', content: 'Hello!' }],
});
for await (const event of stream) {
  if (event.type === 'content_block_delta') process.stdout.write(event.delta.text);
}`;
    case 'openai':
      return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${apiKey}",
)
stream = client.chat.completions.create(
    model="${model}",
    stream=True,
    messages=[{"role": "user", "content": "Hello!"}],
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`;
    case 'curl-oai':
      return `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${apiKey}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "${model}",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
    default: return '';
  }
}

// ── KeyConfigPanel ────────────────────────────────────────────────────────────

const CONFIG_TABS = [
  { id: 'curl',     label: 'curl' },
  { id: 'curl-oai', label: 'curl (OAI)' },
  { id: 'python',   label: 'Python' },
  { id: 'nodejs',   label: 'Node.js' },
  { id: 'openai',   label: 'OpenAI SDK' },
  { id: 'auto',     labelKey: 'gateway.key.autoConfig' },
];

function KeyConfigPanel({ apiKey, localBase, model, modelType, hideAuto = false }) {
  const { t } = useLang();
  const TOOLS = autoConfigTools(t);
  const [tab,     setTab]     = useState('curl');
  const [tool,    setTool]    = useState('claude-code');
  const [writeOk, setWriteOk] = useState(false);
  const tabs = hideAuto ? CONFIG_TABS.filter(tabItem => tabItem.id !== 'auto') : CONFIG_TABS;

  const resolvedType = snippetModelType(model, modelType);
  const isRouter = model?.startsWith('llm-router-');
  const envText  = [
    `ANTHROPIC_BASE_URL=${localBase}`,
    `ANTHROPIC_API_KEY=${apiKey}`,
    model ? `ANTHROPIC_MODEL=${model}` : '',
  ].filter(Boolean).join('\n');

  async function handleWrite() {
    try {
      await window.electronAPI?.claude?.configure(localBase, apiKey, []);
      setWriteOk(true);
    } catch (e) {
      alert(t('gateway.common.writeFailed') + ': ' + e.message);
    }
  }

  const isCodeTab = tab !== 'auto';
  const code = isCodeTab ? codeSnippet(tab, localBase, apiKey, model, resolvedType) : '';

  return (
    <div className="border border-zinc-200 dark:border-zinc-700 rounded-xl overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-200 dark:border-zinc-700">
        {tabs.map(tabItem => (
          <button key={tabItem.id} onClick={() => { setTab(tabItem.id); setWriteOk(false); }}
            className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === tabItem.id
                ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300'
            }`}>
            {tabItem.labelKey ? t(tabItem.labelKey) : tabItem.label}
          </button>
        ))}
        {isCodeTab && (
          <>
            <div className="flex-1" />
            <CopyButton text={code} label={t('gateway.common.copy')} className="mx-2 py-1 text-xs" />
          </>
        )}
      </div>

      {/* Code snippet */}
      {isCodeTab && (
        <pre className="px-4 py-3 text-xs font-mono leading-relaxed text-zinc-700 dark:text-zinc-300 overflow-x-auto bg-zinc-50/30 dark:bg-zinc-900/30 whitespace-pre">
          {code}
        </pre>
      )}

      {/* Auto-configure tab */}
      {tab === 'auto' && (
        <div className="p-4 space-y-4">
          {/* Model name badge */}
          {model && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">{t('gateway.key.modelName')}</span>
              <code className={`text-xs font-mono px-2 py-0.5 rounded border ${
                isRouter
                  ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800/40 text-purple-600 dark:text-purple-400'
                  : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
              }`}>{model}</code>
              <CopyButton text={model} label={t('gateway.common.copy')} className="py-0.5 text-xs" />
            </div>
          )}
          <div className="grid grid-cols-4 gap-2">
            {TOOLS.map(t => (
              <button key={t.id} onClick={() => { setTool(t.id); setWriteOk(false); }}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border transition-colors ${
                  tool === t.id
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 hover:border-zinc-400 dark:hover:border-zinc-600'
                }`}>
                {(() => {
                  const brand = resolveBrandIcon(`${t.id} ${t.label}`);
                  return brand
                    ? <img src={brand} alt="" className="w-5 h-5 object-contain" />
                    : <span className="text-xl">{t.icon}</span>;
                })()}
                <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200">{t.label}</span>
                <span className={`text-xs ${tool === t.id ? 'text-blue-600 dark:text-blue-400' : 'text-zinc-400'}`}>{t.hint}</span>
              </button>
            ))}
          </div>
          <div className="bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200 dark:border-zinc-700 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-200 dark:border-zinc-700">
              <span className="text-xs text-zinc-500 font-medium">{t('gateway.key.envVars')}</span>
              <CopyButton text={envText} label={t('gateway.common.copyAll')} className="py-0.5 text-xs" />
            </div>
            <pre className="px-3 py-2.5 text-xs font-mono text-zinc-700 dark:text-zinc-300 leading-relaxed">
              {envText}
            </pre>
          </div>
          {tool === 'claude-code' && window.electronAPI?.claude && (
            <button onClick={handleWrite} disabled={writeOk}
              className="w-full py-2 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:bg-green-700 text-white">
              {writeOk ? t('gateway.key.writtenClaude') : t('gateway.key.writeClaude')}
            </button>
          )}
        </div>
      )}

      {/* tier 前缀说明：与示例 model 字段对齐 */}
      <p className="px-4 py-2.5 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50/40 dark:bg-zinc-900/20">
        {t('gateway.key.modelTierHint')}
      </p>
    </div>
  );
}

// ── InstanceList ──────────────────────────────────────────────────────────────

function InstanceList({ keysScene, onDelete, localBase, newKeyId, routeHealth }) {
  const { t } = useLang();
  const [expandedId, setExpandedId] = useState(newKeyId ?? null);

  // Auto-expand whenever a brand-new key is passed in
  React.useEffect(() => { if (newKeyId) setExpandedId(newKeyId); }, [newKeyId]);

  // Newest first — ids are random hex; sort by created_at ISO string (lexicographic = chronological)
  const sorted = [...keysScene].sort((a, b) =>
    (b.created_at || '').localeCompare(a.created_at || ''));
  // { [keyId]: { busy, ok, latency, error } | null }
  const [testState, setTestState]   = useState({});

  async function runTest(k) {
    setTestState(s => ({ ...s, [k.id]: { busy: true } }));
    const model = k.model_key || 'claude-opus-4-5';
    const base = (localBase || resolveLocalGatewayBase()).replace(/\/$/, '');
    try {
      const result = await runStreamChatTest({
        url: `${base}/chat/completions`,
        headers: { authorization: `Bearer ${k.key}` },
        body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'Hello!' }] },
      });
      if (!result.ok) {
        const msg = result.error === 'timeout' ? t('gateway.common.timeout30s') : (result.error || t('gateway.common.connectFailed'));
        setTestState(s => ({ ...s, [k.id]: { ok: false, error: msg, latency: result.latency } }));
      } else {
        setTestState(s => ({ ...s, [k.id]: { ok: true, latency: result.latency } }));
      }
    } catch (e) {
      setTestState(s => ({ ...s, [k.id]: { ok: false, error: e.message || t('gateway.common.connectFailed'), latency: null } }));
    }
    setTimeout(() => setTestState(s => ({ ...s, [k.id]: null })), 6000);
  }

  if (keysScene.length === 0) return null;
  return (
    <div className="border-t border-zinc-200 dark:border-zinc-800">
      <div className="px-5 py-3 flex items-center justify-between">
        <span className="text-xs text-zinc-500 font-medium">{t('gateway.key.appList')}</span>
        <span className="text-xs text-zinc-400">{t('gateway.key.appCount', { n: keysScene.length })}</span>
      </div>
      <div className="max-h-96 overflow-y-auto divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {sorted.map(k => {
          const ts = testState[k.id];
          const rh = k.model_key ? (routeHealth?.[k.model_key] ?? null) : null;
          const rhFt = rh?.first_token_ms ?? null;
          const rhFtLabel = rhFt != null ? t('gateway.route.firstToken', { s: (rhFt / 1000).toFixed(1) }) : null;
          // test result overrides health dot (temporary, 6s)
          const dotColor = ts && !ts.busy
            ? ts.ok ? speedDotClass('fast') : speedDotClass('fail')
            : rh
              ? speedDotClass(statusDotBucket({
                ms: rhFt,
                failed: rh.status === 'error',
                ok: rh.status === 'ok',
              }))
              : k.is_active ? speedDotClass('fast') : speedDotClass('unknown');
          const dotTitle = ts && !ts.busy
            ? ts.ok
              ? t('gateway.key.testPassed', { latency: ts.latency ? t('gateway.key.testPassedLatency', { ms: ts.latency }) : '' })
              : t('gateway.key.testFailed', { error: ts.error || t('gateway.common.connectError') })
            : rh
              ? rh.status === 'error' ? t('gateway.key.routeRecentFailed')
                : rh.status === 'ok'
                  ? [rh.degraded ? t('gateway.route.degradedTo', { step: rh.activeStep }) : t('gateway.route.hitStep', { step: rh.activeStep }), rhFtLabel].filter(Boolean).join(' · ')
                  : t('gateway.key.routeNoRequests')
              : k.is_active ? t('gateway.key.appEnabled') : t('gateway.key.appDisabled');
          return (
            <div key={k.id}>
              <div
                className="flex items-center gap-3 px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/20 transition-colors cursor-pointer"
                onClick={() => setExpandedId(expandedId === k.id ? null : k.id)}
              >
                <div title={dotTitle} className={`w-1.5 h-1.5 rounded-full shrink-0 cursor-help ${dotColor}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200 truncate">{k.app_name || k.note || t('gateway.common.unnamed')}</span>
                    {k.scene_name && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-800/40 shrink-0">
                        {k.icon && !k.icon.startsWith('icon:') ? k.icon + ' ' : ''}{k.scene_name}
                      </span>
                    )}
                  </div>
                  <code className="text-xs font-mono text-zinc-400 mt-0.5 block">{k.key?.slice(0, 20)}…</code>
                </div>

                <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                  {/* Test result badge */}
                  {ts && !ts.busy && (
                    <span className={`text-xs font-mono shrink-0 max-w-[140px] truncate ${ts.ok ? 'text-green-500 dark:text-green-400' : 'text-red-400'}`}
                      title={ts.ok ? t('gateway.common.testFirstToken', { ms: ts.latency }) : ts.error}>
                      {ts.ok ? `✓ ${t('gateway.common.testFirstToken', { ms: ts.latency })}` : `✗ ${ts.error}`}
                    </span>
                  )}
                  <button
                    onClick={() => runTest(k)}
                    disabled={ts?.busy}
                    className={`text-xs px-2 py-1 rounded border transition-colors shrink-0 ${
                      ts?.busy
                        ? 'border-zinc-300 dark:border-zinc-600 text-zinc-400 opacity-60 cursor-wait'
                        : 'border-zinc-300 dark:border-zinc-600 text-zinc-500 dark:text-zinc-400 hover:border-blue-400 hover:text-blue-500 dark:hover:text-blue-400'
                    }`}>
                    {ts?.busy ? t('gateway.common.testing') : t('gateway.common.test')}
                  </button>
                  <CopyButton text={k.key} label={t('gateway.common.copy')} className="text-xs py-1 px-2 min-w-0" />
                  <button onClick={() => onDelete(k.id)}
                    className="text-xs text-zinc-400 hover:text-red-500 dark:hover:text-red-400 transition-colors">{t('gateway.common.delete')}</button>
                </div>
                <span className="text-zinc-400 text-xs shrink-0">{expandedId === k.id ? '▲' : '▼'}</span>
              </div>
              {expandedId === k.id && (
                <div className="px-5 pb-4 pt-1">
                  <KeyConfigPanel
                    apiKey={k.key}
                    localBase={localBase}
                    model={k.model_key || undefined}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Auto-config tool list ─────────────────────────────────────────────────────

function autoConfigTools(t) {
  return [
    { id: 'claude-code', icon: '🤖', label: t('gateway.tool.claudeCode'), hint: t('gateway.tool.autoWrite') },
    { id: 'cursor',      icon: '🔮', label: t('gateway.tool.cursor'),     hint: t('gateway.tool.manualConfig') },
    { id: 'continue',    icon: '🪟', label: t('gateway.tool.continue'),   hint: t('gateway.tool.manualConfig') },
    { id: 'other',       icon: '📋', label: t('gateway.tool.other'),      hint: t('gateway.tool.generic') },
  ];
}

// ── Route log detail modal ────────────────────────────────────────────────────

function RouteLogDetailModal({ entry, onClose }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  if (!entry) return null;

  const fmtMs = n => (n != null && n > 0) ? (n >= 1000 ? (n/1000).toFixed(1)+'s' : n+'ms') : '—';
  const isError = entry.status === 'error';
  const errorText = entry.error || '';
  const providerErrors = entry.provider_errors || [];

  const copyError = () => {
    const lines = [
      errorText,
      ...providerErrors.map(pe => `[${pe.provider}] ${pe.error}`),
    ].filter(Boolean).join('\n');
    navigator.clipboard?.writeText(lines).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  const DetailRow = ({ label, children }) => (
    <div className="flex gap-3 text-xs">
      <span className="text-zinc-400 shrink-0 w-20">{label}</span>
      <span className="text-zinc-700 dark:text-zinc-300 flex-1 min-w-0 break-words">{children}</span>
    </div>
  );

  return createPortal(
    <div className="electron-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-800 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-lg mx-4 max-h-[85vh] overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0 flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full shrink-0 ${isError ? 'bg-red-400' : 'bg-green-400'}`} />
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100 flex-1">{t('gateway.log.detailTitle')}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-lg leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-3">
          <DetailRow label={t('gateway.log.requestTime')}>
            {new Date(entry.ts).toLocaleString('zh-CN')}
          </DetailRow>
          <DetailRow label={t('gateway.log.requestedModel')}>
            <span className="font-mono">{entry.requested_model || '—'}</span>
          </DetailRow>
          {entry.claude_from && (
            <DetailRow label={t('gateway.log.claudeMap')}>
              <span className="font-mono">
                {entry.claude_from}
                {entry.model && entry.model !== entry.claude_from ? (
                  <> → <span className="text-emerald-600 dark:text-emerald-400">{entry.model}</span></>
                ) : null}
              </span>
            </DetailRow>
          )}
          {entry.scene_name && (
            <DetailRow label={t('gateway.log.sceneName')}>
              {entry.scene_name}
            </DetailRow>
          )}
          {entry.tried?.length > 0 && (
            <DetailRow label={t('gateway.log.triedModels')}>
              <span className="font-mono text-red-400">{entry.tried.join(' → ')}</span>
            </DetailRow>
          )}
          {entry.model && (
            <DetailRow label={t('gateway.log.actualModel')}>
              <span className="font-mono">{entry.model}</span>
              {entry.tier && <span className="ml-1 text-zinc-400">({entry.tier})</span>}
            </DetailRow>
          )}
          {entry.vision_assist && (
            <DetailRow label={t('gateway.log.visionAssist')}>
              <span className="font-mono">
                {entry.vision_assist.model || '—'}
                {entry.vision_assist.status === 'ok' ? (
                  <span className="text-emerald-600 dark:text-emerald-400"> · ok</span>
                ) : (
                  <span className="text-amber-600 dark:text-amber-400"> · {entry.vision_assist.error || entry.vision_assist.status || 'fallback'}</span>
                )}
                {entry.vision_assist.latency_ms != null && (
                  <span className="text-zinc-400"> · {fmtMs(entry.vision_assist.latency_ms)}</span>
                )}
              </span>
            </DetailRow>
          )}
          {(entry.via_label || entry.via) && (
            <DetailRow label={t('gateway.log.provider')}>
              {entry.via_label || entry.via}
            </DetailRow>
          )}
          {entry.status === 'ok' && (
            <DetailRow label={t('gateway.log.latency')}>
              {fmtMs(entry.first_token_ms ?? entry.latency_ms)}
            </DetailRow>
          )}

          {/* 错误详情 */}
          {isError && errorText && (
            <div className="mt-2">
              <div className="text-xs text-zinc-400 mb-1.5">{t('gateway.log.errorDetail')}</div>
              <pre className="text-xs font-mono text-red-600 dark:text-red-400 whitespace-pre-wrap break-words bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/40 rounded-lg p-3">{errorText}</pre>
              {entry.error_code && (
                <div className="mt-1.5 text-xs text-zinc-400">{t('gateway.log.errorCode')}: <span className="font-mono">{entry.error_code}</span></div>
              )}
            </div>
          )}

          {/* 各 provider 尝试失败记录 */}
          {providerErrors.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-zinc-400 mb-1.5">{t('gateway.log.providerErrors')}</div>
              <div className="space-y-1.5">
                {providerErrors.map((pe, i) => (
                  <div key={i} className="text-xs bg-zinc-50 dark:bg-zinc-800/60 rounded-lg px-3 py-2 border border-zinc-100 dark:border-zinc-700">
                    <span className="font-mono text-blue-600 dark:text-blue-400">{pe.provider}</span>
                    {pe.status && <span className="ml-2 text-zinc-400">HTTP {pe.status}</span>}
                    <div className="mt-0.5 font-mono text-red-500 dark:text-red-400 break-words">{pe.error}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {isError && errorText && (
          <div className="px-5 py-3 border-t border-zinc-100 dark:border-zinc-800 shrink-0 flex items-center gap-2">
            {copied && <span className="text-xs text-green-600 dark:text-green-400">{t('gateway.log.copied')}</span>}
            <div className="ml-auto flex gap-2">
              <button onClick={copyError}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300">
                {t('gateway.log.copyError')}
              </button>
              <button onClick={onClose}
                className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500">
                {t('gateway.sessions.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Gateway() {
  const { t } = useLang();
  const { user } = useAuth();
  const [status, setStatus]     = useState(null);
  const [stats, setStats]       = useState(null);
  const [logEntries, setLog]    = useState([]);
  const [network, setNetwork]   = useState(null);   // /public/network 快照：路由日志把 worker_id join 成分享者
  const [selectedLog, setSelectedLog] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const [mainTab, setMainTab]   = useState(0);   // 0=应用列表 1=场景路由 2=会话
  // 其它页跳转到场景路由：navigate('/gateway', { state: { gatewayTab: 'routes' } })
  const gwLocation = useLocation();
  const gwNavigate = useNavigate();
  useEffect(() => {
    const want = gwLocation.state?.gatewayTab;
    if (!want) return;
    if (want === 'routes') setMainTab(1);
    else if (want === 'apps') setMainTab(0);
    gwNavigate(gwLocation.pathname, { replace: true, state: null });
  }, [gwLocation.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sessionsMounted, setSessionsMounted] = useState(false); // 首次进入会话 Tab 后保持挂载

  // Scene routing
  const [routes, setRoutes]               = useState([]);
  const [expandedRoute, setExpandedRoute] = useState(null);
  const [newRoute, setNewRoute]           = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [sources, setSources] = useState([]);   // 已启用供给源（路由里"某模型下锁具体源"用）
  // 应用列表汇总（与表格「今日请求/Token」列求和一致）

  // Keys list
  const [keysScene, setKeysScene] = useState([]);
  const [newKeyId,  setNewKeyId]  = useState(null);  // auto-expand after creation

  // 场景应用 — new unified flow
  const [appNote,        setAppNote]        = useState('');
  const [appBusy,        setAppBusy]        = useState(false);
  const [appKey,         setAppKey]         = useState(null);   // created key object
  const [appRouteMode,   setAppRouteMode]   = useState(null);   // 'scene' | 'model'
  const [appSceneId,     setAppSceneId]     = useState('');
  const [appModelId,     setAppModelId]     = useState('');
  const [appRouterModel, setAppRouterModel] = useState('');     // resolved model/router key

  const localBase = resolveLocalGatewayBase(status?.port);

  // ── Data loading ────────────────────────────────────────────────────────────

  const loadAvailableModels = useCallback(async () => {
    try {
      setAvailableModels(await loadGatewayAvailableModels({ includeCommunity: !!user }));
    } catch (e) {
      console.error('loadAvailableModels', e);
    }
    // 已启用供给源（供路由步"锁定某模型下的具体源"）
    try {
      const cfg = await getConfig().read();
      setSources((cfg?.providers || []).filter(p => p.enabled && p.base_url));
    } catch {}
  }, [user]);

  const refresh = useCallback(async () => {
    const [s, st, lg] = await Promise.all([
      getGateway().status(),
      getGateway().getDailyStats(),
      getGateway().getLog(),
    ]);
    setStatus(s);
    setStats(st);
    setLog(lg.slice(0, 50));
    loadAvailableModels();
  }, [loadAvailableModels]);

  const loadSceneData = useCallback(async () => {
    try {
      const cfg = await getLocalConfig().get();
      const localRoutes = cfg.scene_routes || [];
      setRoutes(localRoutes);
      // Enrich local keys with scene info
      const enriched = (cfg.local_keys || []).map(k => {
        const route = k.model_key ? localRoutes.find(r => r.model_key === k.model_key) : null;
        return { ...k, scene_name: route?.scene_name, icon: route?.icon, steps: route?.steps };
      });
      setKeysScene(enriched);
    } catch (e) {
      console.error('loadSceneData', e);
    }
  }, []);

  // /public/network 快照（把路由日志里的 p2p worker_id join 成分享者名/模型）。
  // worker_id 随重连变化、网络拓扑变化慢 → 独立低频拉取（30s），仅登录后。
  const loadNetwork = useCallback(async () => {
    if (!user) { setNetwork(null); return; }
    try { setNetwork(normalizeNetworkPayload(await getNetwork())); }
    catch { /* 离线/未登录：日志侧回退成截断 worker_id */ }
  }, [user]);

  useEffect(() => {
    refresh();
    loadSceneData();
    // 状态/统计 5s 刷新（含模型列表，以便供给源开关变更后下拉及时更新）
    const statsId = setInterval(refresh, 5000);
    return () => { clearInterval(statsId); };
  }, [refresh, loadSceneData]);

  useEffect(() => {
    loadNetwork();
    const netId = setInterval(loadNetwork, 30000);
    return () => { clearInterval(netId); };
  }, [loadNetwork]);

  // ── Computed stats ──────────────────────────────────────────────────────────

  const totalCalls   = stats?.total_calls ?? 0;
  const totalTokens  = stats?.total_tokens ?? 0;
  // 顶部四项统一取自同一份「今日」统计（本地 0 点至今），避免与盘点页、网关占比口径不一。
  // 不再用应用列表求和：未归属到应用的请求（或应用列表为空时）会被漏算成 0。
  const headerCalls  = totalCalls;
  const headerTokens = totalTokens;
  const proxyCalls   = (stats?.agent_sources ?? []).find(s => s.source === 'proxy')?.calls ?? 0;
  const gatewayRatio = totalCalls > 0 ? Math.round((proxyCalls / totalCalls) * 100) : null;
  const fmtTokens    = n => n >= 1_000_000 ? (n / 1e6).toFixed(2) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n || 0);
  const fmtMs        = n => (n != null && n > 0) ? (n >= 1000 ? (n/1000).toFixed(1)+'s' : n+'ms') : null;
  const okLogs       = logEntries.filter(e => e.status === 'ok');
  const recentOkLogs = okLogs.filter(e => e.ts >= Date.now() - 5 * 60 * 1000);
  // 优先近 5 分钟；无近期成功请求时回退到内存日志全部 ok，避免刷新后显示 —
  const logsForLatency = recentOkLogs.length > 0 ? recentOkLogs : okLogs;
  const routeAvgLatency = logsForLatency.length > 0
    ? Math.round(logsForLatency.reduce((s, e) => s + (e.first_token_ms ?? e.latency_ms ?? 0), 0) / logsForLatency.length)
    : 0;
  const dbAvgLatency = stats?.avg_latency_ms ?? 0;
  // 网关实时日志（近 5 分钟）优先；否则用 DB 均值（含 session 补录的 OpenCode/Codex 等）
  const avgLatency = (recentOkLogs.length > 0 && routeAvgLatency > 0)
    ? routeAvgLatency
    : (dbAvgLatency > 0 ? dbAvgLatency : routeAvgLatency);

  // ── Route / model health: derived from recent log entries ─────────────────
  // Covers both scene-route keys (llm-router-xxx) and direct model keys
  const routeHealth = React.useMemo(() => {
    // Collect all known model_keys: from routes + from keysScene
    const allKeys = new Set([
      ...routes.map(r => r.model_key).filter(Boolean),
      ...keysScene.map(k => k.model_key).filter(Boolean),
    ]);
    const map = {};
    for (const key of allKeys) {
      const entries = logEntries.filter(e => e.requested_model === key);
      if (!entries.length) { map[key] = { status: null, activeStep: null, triedSteps: [], degraded: false }; continue; }
      const last = entries[0]; // newest first
      map[key] = {
        status: last.status,
        activeStep: last.status === 'ok' ? last.model : null,
        triedSteps: Array.isArray(last.tried) ? last.tried : [],
        degraded: last.status === 'ok' && Array.isArray(last.tried) && last.tried.length > 0,
        first_token_ms: last.first_token_ms ?? null,
      };
    }
    return map;
  }, [logEntries, routes, keysScene]);

  // ── Scene route actions ────────────────────────────────────────────────────

  const saveRoute = async (route) => {
    try {
      if (route.id) {
        await getLocalConfig().updateSceneRoute({
          id: route.id, scene_name: route.scene_name, icon: route.icon, steps: route.steps, rules: route.rules, classifier: route.classifier,
          flow: route.flow, caveman_level: route.caveman_level, scope: route.scope, tier: route.tier,
        });
      } else {
        await getLocalConfig().createSceneRoute({
          scene_name: route.scene_name, icon: route.icon, steps: route.steps, rules: route.rules, classifier: route.classifier,
          flow: route.flow, caveman_level: route.caveman_level, scope: route.scope, tier: route.tier,
        });
      }
      setNewRoute(null);
      setExpandedRoute(null);
      await loadSceneData();
    } catch (e) {
      alert(t('gateway.common.saveFailed', { msg: e.message }));
    }
  };

  const removeRoute = async (id) => {
    if (!confirm(t('gateway.route.confirmDelete'))) return;
    try { await getLocalConfig().deleteSceneRoute(id); await loadSceneData(); }
    catch (e) { alert(t('gateway.common.deleteFailed')); }
  };

  // ── App key actions ────────────────────────────────────────────────────────

  async function handleCreateAppKey() {
    if (!appNote.trim()) return;
    setAppBusy(true);
    setAppKey(null);
    setAppRouteMode(null);
    setAppSceneId('');
    setAppModelId('');
    setAppRouterModel('');
    try {
      const key = await getLocalConfig().createKey({ note: appNote.trim() });
      setAppKey(key);
      setNewKeyId(key.id);
      await loadSceneData();
    } catch (e) {
      alert(t('gateway.common.createFailed', { msg: e.message }));
    } finally {
      setAppBusy(false);
    }
  }

  async function handleDeleteKey(keyId) {
    if (!confirm(t('gateway.route.confirmDeleteKey'))) return;
    try { await getLocalConfig().deleteKey(keyId); await loadSceneData(); }
    catch (e) { alert(t('gateway.common.deleteFailed')); }
  }

  // 降级链在模型列表里调整，不进场景路由。
  const sceneRouteRows = useMemo(
    () => (routes || []).filter(route => !route.list_route),
    [routes],
  );

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="px-4 py-4 space-y-3.5">

      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="relative flex h-2.5 w-2.5" aria-hidden>
          <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${status?.running ? 'bg-green-500' : 'bg-zinc-400'}`} />
        </span>
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{t('gateway.title')}</h1>
        {status && (
          <span className={`text-xs px-2 py-0.5 rounded-full border ${
            status.running
              ? 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 border-green-300 dark:border-green-800/50'
              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border-zinc-300 dark:border-zinc-700'
          }`}>
            {status.running ? t('gateway.running', { port: status.port }) : t('gateway.stopped')}
          </span>
        )}
        <button
          onClick={async () => {
            if (restarting) return;
            setRestarting(true);
            await getGateway().restart();
            await new Promise(r => setTimeout(r, 600));
            await refresh();
            setRestarting(false);
          }}
          disabled={restarting}
          title={t('gateway.restartTitle')}
          className="ml-auto flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:border-zinc-300 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"
            className={`w-3.5 h-3.5 ${restarting ? 'animate-spin' : ''}`}>
            <path fillRule="evenodd" d="M13.836 2.477a.75.75 0 0 1 .75.75v3.182a.75.75 0 0 1-.75.75h-3.182a.75.75 0 0 1 0-1.5h1.37l-.84-.841a4.5 4.5 0 0 0-7.08 1.01.75.75 0 1 1-1.3-.75 6 6 0 0 1 9.44-1.344l.842.841V3.227a.75.75 0 0 1 .75-.75Zm-.911 7.5A.75.75 0 0 1 13.199 11a6 6 0 0 1-9.44 1.344l-.84-.841v1.371a.75.75 0 0 1-1.5 0V9.691a.75.75 0 0 1 .75-.75H5.35a.75.75 0 0 1 0 1.5H3.98l.841.841a4.5 4.5 0 0 0 7.08-1.01.75.75 0 0 1 1.025-.295Z" clipRule="evenodd" />
          </svg>
          {restarting ? t('gateway.restarting') : t('gateway.restart')}
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-2.5">
        {[
          { label: t('gateway.stat.todayCalls'), hint: t('gateway.stat.todayCallsHint'), value: stats ? headerCalls.toLocaleString() : '—', color: 'text-zinc-900 dark:text-zinc-100' },
          { label: t('gateway.stat.todayTokens'), value: stats ? fmtTokens(headerTokens) : '—', color: 'text-blue-600 dark:text-blue-400' },
          { label: t('gateway.stat.gatewayRatio'), hint: t('gateway.stat.gatewayRatioHint'), value: gatewayRatio !== null ? `${gatewayRatio}%` : '—', color: 'text-violet-600 dark:text-violet-400' },
          { label: t('gateway.stat.avgLatency'), hint: t('gateway.stat.avgLatencyHint'), value: avgLatency > 0 ? `${avgLatency}ms` : '—', color: 'text-zinc-500 dark:text-zinc-400' },
        ].map(({ label, hint, value, color }) => (
          <div key={label} title={hint} className="tb-soft-card rounded-xl px-4 py-3.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500 mb-1.5">{label}</div>
            <div className={`text-[22px] font-bold leading-none tabular-nums tracking-tight ${color}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* 应用列表 / 场景路由 Tab — 大面板用更透的 soft-panel */}
      <div className="tb-soft-panel rounded-2xl overflow-hidden">
        {/* Tab bar（macOS 分段控件）+ Endpoint 合并一行 */}
        <div className="flex items-center gap-3 px-2.5 py-2 border-b border-white/40 dark:border-white/[0.06]">
          <div className="tb-glass-chip inline-flex items-center gap-0.5 p-0.5 rounded-[10px]">
          {[
            { label: t('gateway.tab.apps'), icon: (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[15px] h-[15px] shrink-0">
                <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
              </svg>
            )},
            { label: t('gateway.tab.routes'), icon: (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[15px] h-[15px] shrink-0">
                <path d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            )},
            { label: t('gateway.tab.sessions'), icon: (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[15px] h-[15px] shrink-0">
                <path d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155" />
              </svg>
            )},
          ].map(({ label, icon }, i) => (
            <button key={i} onClick={() => {
              setMainTab(i);
              if (i === 2) setSessionsMounted(true);
            }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] text-xs font-medium transition-[background-color,color,box-shadow] duration-150 ease-out ${mainTab === i
                ? 'bg-white/80 dark:bg-white/10 text-zinc-900 dark:text-white shadow-sm'
                : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200'}`}>
              {icon}
              {label}
            </button>
          ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">{localBase}</span>
            <CopyButton text={localBase} label={t('gateway.common.copy')} />
          </div>
        </div>

        {/* Tab0: 应用列表 & 托管 */}
        {mainTab === 0 && (
          <AppManager externalRoutes={routes} availableModels={availableModels} onActivity={refresh} />
        )}

        {/* Tab1: 场景路由 */}
        {mainTab === 1 && (
        <div>
        {/* 操作栏：新建（蓝色，最左）｜说明｜在线同步（最右）——布局与应用列表一致 */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-white/40 dark:border-white/[0.06] flex-wrap">
          <button
            onClick={() => { if (newRoute) { setNewRoute(null); } else { setExpandedRoute(null); setNewRoute({ scene_name: '', icon: 'icon:shuffle', steps: [] }); } }}
            className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] text-white transition-colors"
          >{t('gateway.route.new')}</button>
          <span className="text-xs text-zinc-400 dark:text-zinc-500">{t('gateway.route.hint')}</span>
          <div className="ml-auto">
            <ImportConfigButton onImported={() => { refresh(); loadSceneData(); loadAvailableModels(); }} endpoint="/api/config/scenes" />
          </div>
        </div>
        <div className="space-y-2 px-3 pb-3">
          {/* 新建路由编辑器：放在列表最上面 */}
          {newRoute && (
            <SceneRouteEditor key="new-route-editor" route={newRoute} availableModels={availableModels} network={network} sources={sources} onSave={saveRoute} onCancel={() => setNewRoute(null)} />
          )}
          {sceneRouteRows.map(route => {
            const health = routeHealth[route.model_key] ?? { status: null, activeStep: null, degraded: false };
            const ftMs = health.first_token_ms;
            // 本地供给源是否缺少该路由用到的模型（缺则名称前的点也标红）
            const availSet = new Set(availableModels.map(m => m.id));
            const _allSteps = [...(route.steps || []), ...(route.rules || []).flatMap(r => r.steps || [])];
            // strategy-only 步无 model，不参与"模型缺失"判定
            const routeMissing = _allSteps.some(s => (s.model || s.label) && !availSet.has(s.model || s.label));
            const healthDot = speedDotClass(statusDotBucket({
              ms: ftMs,
              failed: routeMissing || health.status === 'error',
              ok: health.status === 'ok',
            }));
            const ftLabel = ftMs != null ? t('gateway.route.firstToken', { s: (ftMs / 1000).toFixed(1) }) : null;
            const healthTitle =
              routeMissing ? t('gateway.route.missingModels') :
              health.status === 'error' ? t('gateway.route.recentFailed') :
              health.status === 'ok'
                ? [health.degraded ? t('gateway.route.degradedShort') : t('gateway.route.runningOk'), ftLabel].filter(Boolean).join(' · ')
                : t('gateway.route.noRequests');
            // 任一步配置了识图增强 → 列表显示标识，方便一眼辨认
            const hasVisionAssist = _allSteps.some(s => s?.vision_assist?.model);
            return (
            <div key={route.id}>
              <div
                className="tb-soft-tile flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer"
                onClick={() => setExpandedRoute(expandedRoute === route.id ? null : route.id)}
                title={t('gateway.common.edit')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
                  className={`w-3.5 h-3.5 shrink-0 text-zinc-400 transition-transform ${expandedRoute === route.id ? 'rotate-90' : ''}`}>
                  <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
                {isAppIcon(route.icon)
                  ? appIconSvg(route.icon, 'w-5 h-5 shrink-0')
                  : String(route.icon || '').startsWith('icon:')
                    ? appIconSvg('icon:shuffle', 'w-5 h-5 shrink-0')
                    : <span className="text-base shrink-0">{route.icon}</span>}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span title={healthTitle} className={`w-2 h-2 rounded-full shrink-0 ${healthDot}`} />
                    <span className="text-xs font-medium text-zinc-800 dark:text-zinc-200">{route.scene_name}</span>
                    {hasVisionAssist && (
                      <span
                        title={t('gateway.route.visionAssistBadgeHint')}
                        className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-900/25 border border-sky-200/80 dark:border-sky-800/50 text-sky-600 dark:text-sky-400 shrink-0"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 shrink-0" aria-hidden>
                          <path d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                          <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                        </svg>
                        {t('gateway.route.visionAssistBadge')}
                      </span>
                    )}
                    {route.caveman_level && (
                      <span
                        title={t('gateway.route.compressBadgeHint')}
                        className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded bg-violet-50 dark:bg-violet-900/25 border border-violet-200/80 dark:border-violet-800/50 text-violet-600 dark:text-violet-400 shrink-0"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 shrink-0" aria-hidden>
                          <path d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25" />
                        </svg>
                        {{
                          lite: t('gateway.route.compressBadgeLite'),
                          full: t('gateway.route.compressBadgeFull'),
                          ultra: t('gateway.route.compressBadgeUltra'),
                        }[route.caveman_level] || t('gateway.route.compressBadge')}
                      </span>
                    )}
                    {route.model_key && (
                      <>
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-zinc-100/70 dark:bg-zinc-800/60 text-zinc-400 dark:text-zinc-500 shrink-0">
                          {route.model_key}
                        </span>
                        <span onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(route.model_key); }}
                          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 cursor-pointer transition-colors shrink-0">{t('gateway.common.copy')}</span>
                      </>
                    )}
                    {routeMissing && (
                      <span title={t('gateway.route.missingModels')} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/40 text-amber-600 dark:text-amber-400 shrink-0">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 shrink-0">
                          <path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                        </svg>
                        {t('gateway.route.needReset')}
                      </span>
                    )}
                    {health.degraded && (
                      <span className="text-xs px-1 py-0.5 rounded bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/40 text-rose-600 dark:text-rose-400 shrink-0">
                        {t('gateway.route.degraded')}
                      </span>
                    )}
                    {route.rules?.length > 0 && (
                      <span title={t('gateway.route.rulesTitle')} className="text-xs px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 text-indigo-600 dark:text-indigo-400 shrink-0">
                        {t('gateway.route.rulesCount', { n: route.rules.length })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0" onClick={e => e.stopPropagation()}>
                  <button onClick={() => removeRoute(route.id)}
                    className="text-xs px-2 py-1 rounded-lg border border-red-200 dark:border-red-800/60 text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                    {t('gateway.common.delete')}
                  </button>
                </div>
              </div>
              {expandedRoute === route.id && (
                <SceneRouteEditor key={'editor-' + route.id} route={route} availableModels={availableModels} network={network} sources={sources} onSave={saveRoute} onCancel={() => setExpandedRoute(null)} />
              )}
            </div>
            );
          })}
          {sceneRouteRows.length === 0 && !newRoute && (
            <div className="px-5 py-8 text-xs text-zinc-400 text-center">{t('gateway.route.empty')}</div>
          )}
        </div>
        </div>
        )}

        {/* Tab2: 会话管理 — 首次进入后保持挂载，避免切 Tab 反复扫盘 */}
        {sessionsMounted && (
          <div className={mainTab === 2 ? '' : 'hidden'}>
            <SessionManager />
          </div>
        )}
      </div>

      {/* 路由明细 — 仅在「场景路由」Tab 显示，应用列表 Tab 不显示 */}
      {mainTab === 1 && (
      <div className="tb-soft-card rounded-2xl p-5">
        <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 mb-3">{t('gateway.log.title')}</h2>
        {logEntries.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {t('gateway.log.empty')}{' '}
            <code className="font-mono text-green-600 dark:text-green-400">{localBase}</code>{t('gateway.log.emptySuffix')}
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto space-y-1.5 pr-1">
            {logEntries.map((e, i) => {
              const isRouter = e.requested_model?.startsWith('llm-router-');
              // 社区(p2p)派发：e.worker=服务/失败的 worker_id → join /public/network 显示分享者
              const wi = e.worker ? workerInfo(e.worker, network) : null;
              const workerName = wi?.name || (e.worker ? String(e.worker).slice(0, 8) : null);
              const workerTitle = e.worker
                ? `worker ${e.worker}${wi?.geo ? ` · ${wi.geo}` : ''}${wi?.models?.length ? ` · ${wi.models.join(', ')}` : ''}`
                : undefined;
              const isError = e.status === 'error';
              const clickable = isError || e.status === 'ok';
              return (
                <div key={`${e.ts}-${e.via}-${i}`}
                  role={clickable ? 'button' : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  onClick={clickable ? () => setSelectedLog(e) : undefined}
                  onKeyDown={clickable ? (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setSelectedLog(e); } } : undefined}
                  title={clickable ? t('gateway.log.clickHint') : undefined}
                  className={`tb-soft-tile flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
                    clickable ? 'cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-700/60 transition-colors' : ''
                  }`}>
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${e.status === 'ok' ? 'bg-green-400' : 'bg-red-400'}`} />
                  <span className="font-mono text-zinc-400 shrink-0 w-12">
                    {new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                  </span>

                  {/* Model chain */}
                  <div className="flex-1 min-w-0 flex items-center gap-1 flex-wrap">
                    {/* Scene route label */}
                    {isRouter && (
                      <span className="font-mono text-purple-500 dark:text-purple-400 shrink-0">{e.requested_model}</span>
                    )}
                    {/* Claude 透明映射标记：claude 名 → (改写成真实模型) */}
                    {e.claude_from && (
                      <>
                        <span title={t('gateway.log.claudeMap')} className="font-mono text-xs px-1 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 text-indigo-600 dark:text-indigo-400 shrink-0">
                          🎭 {e.claude_from}
                        </span>
                        <span className="text-zinc-300 dark:text-zinc-600">→</span>
                      </>
                    )}
                    {/* Failed models in degradation chain */}
                    {e.tried?.map((m, j) => (
                      <React.Fragment key={j}>
                        {(isRouter || j > 0) && <span className="text-zinc-300 dark:text-zinc-600">→</span>}
                        <span className="font-mono text-red-400 line-through opacity-60 shrink-0">{m}</span>
                      </React.Fragment>
                    ))}
                    {/* Actual model used */}
                    {(isRouter || e.tried?.length > 0) && <span className="text-zinc-300 dark:text-zinc-600">→</span>}
                    <span className="font-mono text-zinc-700 dark:text-zinc-300 truncate">
                      {e.model || '—'}
                      {e.tier && (
                        <span className={`ml-0.5 text-xs not-italic ${
                          e.tier === 'p2p'  ? 'text-blue-500 dark:text-blue-400' :
                          e.tier === 'paid' ? 'text-amber-500 dark:text-amber-400' :
                                              'text-green-600 dark:text-green-500'
                        }`}>({tierShortLabel(e.tier, t)})</span>
                      )}
                      {!e.claude_from && !isRouter && (
                        <span title={t('gateway.log.directTitle')} className="ml-1 text-xs text-zinc-400">{t('gateway.log.direct')}</span>
                      )}
                    </span>
                  </div>

                  <span className="text-zinc-400 shrink-0">→</span>
                  <span className={`shrink-0 font-medium ${e.status === 'ok' ? 'text-blue-600 dark:text-blue-400' : 'text-red-500'}`}>
                    {e.status === 'ok' ? (e.via_label || e.via || '—') : t('gateway.log.failed')}
                  </span>
                  {/* 社区节点归因：哪个分享者的 worker 服务/失败了本次请求 */}
                  {workerName && (
                    <span title={workerTitle}
                      className={`shrink-0 font-mono text-[11px] px-1 py-0.5 rounded truncate max-w-[7rem] ${
                        e.status === 'ok'
                          ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                          : 'bg-red-50 dark:bg-red-900/20 text-red-500 dark:text-red-400'
                      }`}>
                      👤 {workerName}
                    </span>
                  )}
                  {isError && (
                    <span className="text-zinc-400 shrink-0 opacity-60">{t('gateway.log.detailShort')} ›</span>
                  )}
                  {e.status === 'ok' && fmtMs(e.first_token_ms ?? e.latency_ms) && (
                    <span className="text-zinc-400 shrink-0">{fmtMs(e.first_token_ms ?? e.latency_ms)}</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {selectedLog && <RouteLogDetailModal entry={selectedLog} onClose={() => setSelectedLog(null)} />}
    </div>
  );
}
