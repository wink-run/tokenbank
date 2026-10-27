import React from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../store/index';
import { useLang } from '../store/lang';
import { useUpdater } from '../store/updater';
import logoSvg from '../assets/logo.svg';

export default function Sidebar({ onToggleCollapse }) {
  const { user, guest } = useAuth();
  const { t } = useLang();
  const { pendingVersion, reopenToast } = useUpdater() || {};
  const navigate = useNavigate();
  const location = useLocation();

  const iconCls = 'w-[18px] h-[18px]';
  const svgProps = {
    xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
  };
  const NAV = [
    { to: '/gateway', labelKey: 'nav.gateway', icon: (
      <svg {...svgProps} className={iconCls}>
        <path d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z" />
      </svg>
    )},
    { to: '/providers', labelKey: 'nav.providers', icon: (
      <svg {...svgProps} className={iconCls}>
        <path d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m-3 2.25h.008v.008h-.008v-.008Zm0-4.5h.008v.008h-.008V12.75Zm-3 2.25h.008v.008h-.008v-.008Z" />
      </svg>
    )},
    { to: '/resources', labelKey: 'nav.resources', icon: (
      <svg {...svgProps} className={iconCls}>
        <path d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
      </svg>
    )},
    { to: '/contribute', labelKey: 'nav.contribute', icon: (
      <svg {...svgProps} className={iconCls}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 2.25v19.5M16.5 5.25H10.125a3.375 3.375 0 0 0 0 6.75h3.75a3.375 3.375 0 0 1 0 6.75H6.75" />
      </svg>
    )},
    { to: '/dashboard', labelKey: 'nav.dashboard', icon: (
      <svg {...svgProps} className={iconCls}>
        <path d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 0 1 3 19.875v-6.75ZM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V8.625ZM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 0 1-1.125-1.125V4.125Z" />
      </svg>
    )},
    { to: '/debug', labelKey: 'nav.debug', icon: (
      <svg {...svgProps} className={iconCls}>
        <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
      </svg>
    )},
  ];
  const profileActive = location.pathname === '/account';
  const settingsActive = location.pathname === '/config';
  const showUserBar = user || (guest && !user);

  const settingsBtn = (
    <button
      onClick={() => navigate('/config')}
      title={pendingVersion ? t('updater.pendingTitle', { version: pendingVersion }) : t('nav.settings')}
      className={`tb-press relative shrink-0 flex items-center justify-center w-10 rounded-xl ${
        settingsActive
          ? 'bg-white/55 dark:bg-white/[0.12] text-zinc-900 dark:text-white ring-1 ring-white/40 dark:ring-white/10'
          : 'text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-white/35 dark:hover:bg-white/5'
      }`}
    >
      {pendingVersion && (
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-blue-500 ring-2 ring-white dark:ring-zinc-900" />
      )}
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px] shrink-0">
        <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.49l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.49l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281Z" />
        <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
    </button>
  );

  // 待重启更新：副标题替换为提示，点击可重新打开底部安装弹窗
  const pendingHint = pendingVersion ? (
    <p
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); reopenToast?.(); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); reopenToast?.(); } }}
      title={t('updater.pendingTitle', { version: pendingVersion })}
      className="text-xs leading-tight truncate mt-0.5 text-blue-500 dark:text-blue-400 hover:underline cursor-pointer"
    >
      {t('updater.pendingHint', { version: pendingVersion })}
    </p>
  ) : null;

  // 交易（含圈子）需登录；未登录时仍展示菜单项，点击跳转登录页
  const LOGIN_PATHS = new Set(['/contribute']);

  return (
    <aside className="tb-app-sidebar relative w-[160px] flex flex-col pb-4 shrink-0">
      {/* CLI：收起侧边栏 */}
      {onToggleCollapse && (
        <button
          type="button"
          onClick={onToggleCollapse}
          title={t('sidebar.collapse')}
          aria-label={t('sidebar.collapse')}
          className="tb-press electron-no-drag absolute top-3 right-2 z-10 flex items-center justify-center w-8 h-8 rounded-xl text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-white/70 dark:hover:bg-white/10"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
            <path d="M15 18 9 12l6-6" />
          </svg>
        </button>
      )}
      {/* Logo — pt-14 避开 macOS 交通灯 / Windows 标题栏按钮；electron-drag 允许拖动窗口 */}
      <div className="electron-drag flex items-center gap-2.5 pt-14 pb-4 px-3.5 select-none mb-2">
        <img src={logoSvg} alt="Token Bank" className="w-10 h-10 shrink-0 rounded-2xl" />
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-gray-900 dark:text-gray-100 leading-tight tracking-tight">Token Bank</p>
          <p className="text-[10px] text-gray-400 dark:text-gray-500 leading-tight mt-0.5">{t('sidebar.tagline')}</p>
        </div>
      </div>

      {/* Nav items：大圆角胶囊选中态 */}
      <nav className="electron-no-drag flex-1 flex flex-col gap-1 px-2.5">
        {NAV.map(({ to, icon, labelKey }) => {
          const navCls = (active) =>
            'tb-press flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm w-full text-left ' +
            (active
              ? 'bg-white/55 dark:bg-white/[0.12] text-zinc-900 dark:text-white font-semibold shadow-[0_1px_0_rgba(255,255,255,0.45)_inset] ring-1 ring-white/40 dark:ring-white/10'
              : 'text-zinc-600 dark:text-zinc-300 hover:bg-white/35 dark:hover:bg-white/5 hover:text-zinc-900 dark:hover:text-zinc-100');

          // 游客进入圈子 / 交易看到价值预览页（由路由层渲染），非游客才直接去登录
          if (!user && !guest && LOGIN_PATHS.has(to)) {
            return (
              <button
                key={to}
                type="button"
                onClick={() => navigate('/login', { state: { from: to } })}
                className={navCls(false)}
              >
                <span className="w-5 h-5 shrink-0 flex items-center justify-center">{icon}</span>
                <span className="truncate font-medium">{t(labelKey)}</span>
              </button>
            );
          }

          return (
            <NavLink key={to} to={to}
              // 圈子详情属于「交易」：保持交易高亮
              className={({ isActive }) => navCls(isActive || (to === '/contribute' && location.pathname.startsWith('/circles')))}>
              <span className="w-5 h-5 shrink-0 flex items-center justify-center">{icon}</span>
              <span className="truncate font-medium">{t(labelKey)}</span>
            </NavLink>
          );
        })}
      </nav>

      {/* 用户 / 未登录 + 设置：底部同一行（布局一致） */}
      {showUserBar && (
        <div className="electron-no-drag px-2.5">
          <div className="flex items-stretch gap-1">
            <button
              onClick={() => {
                if (user) navigate('/account');
                else navigate('/login');
              }}
              className={`tb-press flex-1 min-w-0 flex items-center gap-2 px-2.5 py-2 rounded-xl text-left ${
                profileActive
                  ? 'bg-white/55 dark:bg-white/[0.12] shadow-[0_1px_0_rgba(255,255,255,0.45)_inset] ring-1 ring-white/40 dark:ring-white/10'
                  : 'hover:bg-white/35 dark:hover:bg-white/5'
              }`}
            >
              {user ? (
                <>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold uppercase ${profileActive ? 'bg-zinc-700 dark:bg-zinc-500 text-white' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'}`}>
                    {(user.nickname || user.email)?.[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[11.5px] font-semibold leading-tight truncate ${profileActive ? 'text-zinc-900 dark:text-white' : 'text-zinc-700 dark:text-zinc-200'}`}>{user.nickname}</p>
                    {pendingHint || (user.credits_balance != null && (
                      <p className={`text-xs leading-tight truncate mt-0.5 ${profileActive ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
                        💎 {Math.floor(user.credits_balance ?? 0).toLocaleString()} {t('credits.unit')}
                      </p>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-bold uppercase ${profileActive ? 'bg-zinc-700 dark:bg-zinc-500 text-white' : 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300'}`}>
                    ?
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[11.5px] font-semibold leading-tight truncate ${profileActive ? 'text-zinc-900 dark:text-white' : 'text-zinc-700 dark:text-zinc-200'}`}>{t('sidebar.guest')}</p>
                    {pendingHint || (
                      <p className={`text-xs leading-tight truncate mt-0.5 ${profileActive ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
                        {t('sidebar.guestStats')}
                      </p>
                    )}
                  </div>
                </>
              )}
            </button>
            {settingsBtn}
          </div>
        </div>
      )}
    </aside>
  );
}
