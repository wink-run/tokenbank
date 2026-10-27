import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { MemoryRouter, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './store/index';
import KeepAliveRoutes, { findRouteConfig } from './components/KeepAliveRoutes';
import { ThemeProvider } from './store/theme';
import { LangProvider, useLang } from './store/lang';
import { CurrencyProvider } from './store/currency';
import { isElectron } from './api/adapter';
import Sidebar from './components/Sidebar';
import TokenDashboard from './pages/TokenDashboard';
import Gateway    from './pages/Gateway';
import Providers  from './pages/Providers';
import Resources  from './pages/Resources';
import Contribute from './pages/Contribute';
import Dashboard  from './pages/Dashboard';
import Network    from './pages/Network';
import Config     from './pages/Config';
import Login      from './pages/Login';
import Debug      from './pages/Debug';
import CircleDetail from './pages/CircleDetail';
import UpdateNotification from './components/UpdateNotification';
import ResourceHitToast from './components/ResourceHitToast';
import { UpdaterProvider } from './store/updater';
import { useDeviceReporter } from './hooks/useDeviceReporter';

const SIDEBAR_COLLAPSED_KEY = 'tokenbank.sidebarCollapsed';

function readSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { return false; }
}

/** 侧边栏主页面：切换时保持挂载以保留 state（如 Debug Agent 会话） */
const KEEP_ALIVE_ROUTE_CONFIGS = [
  { path: '/circles/:circleId', Component: CircleDetail, requireLogin: true, guestPreview: 'circles' },
  { path: '/gateway', Component: Gateway, requireAuthed: true },
  { path: '/providers', Component: Providers, requireAuthed: true },
  { path: '/resources', Component: Resources, requireAuthed: true },
  { path: '/contribute', Component: Contribute, requireLogin: true, guestPreview: 'trade' },
  { path: '/dashboard', Component: Dashboard, requireAuthed: true },
  { path: '/network', Component: Network },
  { path: '/config', Component: Config },
  { path: '/debug', Component: Debug },
  { path: '/account', Component: TokenDashboard, requireUser: true },
];

function Layout() {
  const { user, guest, loading } = useAuth();
  const { t } = useLang();
  const authed = user || guest;   // 登录用户 或 游客模式：可进入「中心」
  const navigate = useNavigate();
  const cliMode = !isElectron();
  // Windows titleBarOverlay 右侧约 138px 系统按钮，拖拽区须让开
  const isWin = isElectron() && window.electronAPI?.platform === 'win32';
  const dragRight = isWin ? 'right-36' : 'right-2.5';
  // CLI / Docker Web：侧边栏可收起，偏好写入 localStorage
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => (cliMode ? readSidebarCollapsed() : false));
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      if (cliMode) {
        try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0'); } catch {}
      }
      return next;
    });
  }, [cliMode]);
  useDeviceReporter(user);

  const location = useLocation();
  const isLegacyCircles = location.pathname === '/circles' || location.pathname === '/circles/browse';
  const keepAliveMatch = useMemo(
    () => findRouteConfig(KEEP_ALIVE_ROUTE_CONFIGS, location.pathname),
    [location.pathname],
  );

  useEffect(() => {
    if (!isElectron() || !window.electronAPI?.app?.onNavigate) return;
    return window.electronAPI.app.onNavigate((path) => navigate(path));
  }, [navigate]);

  // 公开页 /network?circle=ID → 登录后进入圈子主页（MemoryRouter 需手动跳转）
  useEffect(() => {
    if (!user) return;
    try {
      const sp = new URLSearchParams(window.location.search);
      const cid = (sp.get('circle') || '').trim();
      if (!/^\d+$/.test(cid)) return;
      navigate(`/circles/${cid}`);
      sp.delete('circle');
      const q = sp.toString();
      const next = window.location.pathname + (q ? `?${q}` : '') + window.location.hash;
      window.history.replaceState({}, '', next);
    } catch { /* ignore */ }
  }, [user, navigate]);

  if (loading) {
    return (
      <div className="tb-app-shell flex h-full items-center justify-center text-zinc-500 dark:text-zinc-400">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="tb-app-shell flex h-full text-zinc-700 dark:text-zinc-200">
      {isElectron() && !authed && (
        <div className={`electron-drag fixed top-0 left-0 ${dragRight} h-11 z-50`} aria-hidden />
      )}
      {isElectron() && authed && !sidebarCollapsed && (
        <div className={`electron-drag fixed top-0 left-40 ${dragRight} h-9 z-40`} aria-hidden />
      )}
      {authed && !sidebarCollapsed && (
        <Sidebar onToggleCollapse={cliMode ? toggleSidebar : undefined} />
      )}
      <main className="tb-app-main relative flex-1 min-h-0 overflow-y-auto min-w-0">
        {authed && cliMode && sidebarCollapsed && (
          <button
            type="button"
            onClick={toggleSidebar}
            title={t('sidebar.expand')}
            aria-label={t('sidebar.expand')}
            className="tb-press tb-material fixed top-4 left-4 z-50 flex items-center justify-center w-10 h-10 rounded-2xl border border-zinc-900/10 dark:border-white/10 text-zinc-600 dark:text-zinc-300 shadow-sm hover:bg-white dark:hover:bg-zinc-800"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        {/* 缓存层始终挂载，切换菜单 / 登录页时仅 hidden，保留 Debug 等页面 state */}
        <KeepAliveRoutes configs={KEEP_ALIVE_ROUTE_CONFIGS} user={user} guest={guest} />

        {location.pathname === '/' && (
          <Navigate to={authed ? '/gateway' : '/login'} replace />
        )}
        {location.pathname === '/login' && (
          <div className="relative z-10 min-h-full">
            <Login />
          </div>
        )}
        {/* 圈子已并入「交易」：旧入口统一转到交易 → 圈子 */}
        {isLegacyCircles && (
          <Navigate
            to="/contribute"
            replace
            state={{ ...(location.state || {}), tradeTab: 'circles', circlesView: location.pathname === '/circles/browse' ? 'discover' : 'mine' }}
          />
        )}
        {!keepAliveMatch && !isLegacyCircles && location.pathname !== '/login' && location.pathname !== '/' && (
          <Navigate to={authed ? '/gateway' : '/login'} replace />
        )}
      </main>
      <UpdateNotification />
      <ResourceHitToast />
    </div>
  );
}

export default function App() {
  return (
    <MemoryRouter>
      <ThemeProvider>
        <LangProvider>
          <CurrencyProvider>
            <AuthProvider>
              <UpdaterProvider>
                <Layout />
              </UpdaterProvider>
            </AuthProvider>
          </CurrencyProvider>
        </LangProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}
