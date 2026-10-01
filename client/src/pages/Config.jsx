import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../store/index';
import { useTheme } from '../store/theme';
import { getConfig, getGateway } from '../api/adapter';
import { useLang } from '../store/lang';
import { useCurrency } from '../store/currency';
import { useUpdater } from '../store/updater';
import DecisionPanel from '../components/DecisionPanel';
import { defaultCurrencyForLang, DEFAULT_USD_CNY_RATE } from '../utils/currency';
import { SERVER_URL_PLACEHOLDER, normalizeServerBase, syncCloudConfigUrl, bootstrapServerUrl } from '../config';

/** 切换服务器时清除旧 token，避免跨服鉴权失败 */
function persistServerUrl(url) {
  const next = normalizeServerBase(url);
  if (!next) return '';
  const prev = normalizeServerBase(localStorage.getItem('serverUrl') || '');
  if (prev && prev !== next) localStorage.removeItem('token');
  localStorage.setItem('serverUrl', next);
  return next;
}

export default function Config() {
  const { user, logout } = useAuth();

  const [serverUrl, setServerUrl] = useState(
    () => normalizeServerBase(localStorage.getItem('serverUrl') || '')
  );

  useEffect(() => {
    bootstrapServerUrl().then((url) => { if (url) setServerUrl(url); });
  }, []);

  function handleLogout() {
    logout();
    // 留在当前页，侧栏自动切换为「未登录」
  }

  // 设置页：登录与否均可访问
  return <Settings user={user} onLogout={handleLogout} serverUrl={serverUrl} setServerUrl={setServerUrl} />;
}

// ── Toggle helper ─────────────────────────────────────────────────────────────
function Toggle({ enabled, onChange }) {
  return (
    <div onClick={onChange}
      className={`relative w-9 h-5 rounded-full cursor-pointer transition-colors shrink-0 ${enabled ? 'bg-blue-600' : 'bg-gray-600'}`}>
      <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
    </div>
  );
}

// ── Row helper ────────────────────────────────────────────────────────────────
function Row({ label, hint, children }) {
  return (
    <div className="flex items-center justify-between px-5 py-4">
      <div>
        <div className="text-sm text-zinc-800 dark:text-zinc-200">{label}</div>
        {hint && <div className="text-xs text-gray-500 mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0 ml-4">{children}</div>
    </div>
  );
}

function SelectRow({ label, hint, value, onChange, options }) {
  return (
    <Row label={label} hint={hint}>
      <select value={value} onChange={e => onChange(e.target.value)}
        className="bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-700 dark:text-zinc-300 focus:outline-none focus:border-blue-500">
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Row>
  );
}

// ── Settings（登录与否均可访问）──────────────────────────────────────────────
function Settings({ user, onLogout, serverUrl, setServerUrl }) {
  const { theme, setTheme } = useTheme();
  const { lang, setLang, t } = useLang();
  const { currency, usdCnyRate, applySettings } = useCurrency();
  const updater = useUpdater();
  const navigate = useNavigate();
  const isDesktop = !!window.electronAPI?.updater;

  // 应用更新
  const [allowPrerelease, setAllowPrerelease] = useState(false);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');

  // 导出诊断日志（troubleshooting）
  const [diagBusy, setDiagBusy] = useState(false);
  const [diagMsg, setDiagMsg] = useState('');
  async function handleExportDiagnostics() {
    setDiagBusy(true); setDiagMsg('');
    try {
      const r = await window.electronAPI?.diagnostics?.export();
      if (r?.canceled) setDiagMsg('');
      else if (r?.ok) setDiagMsg(t('settings.diagExported', { kb: Math.max(1, Math.round((r.bytes || 0) / 1024)) }));
      else setDiagMsg(t('settings.diagFailed') + (r?.error ? '：' + r.error : ''));
    } catch (e) { setDiagMsg(t('settings.diagFailed') + '：' + (e?.message || e)); }
    finally { setDiagBusy(false); }
  }

  // 货币展示（内部仍以 USD 结算）
  const [displayCurrency, setDisplayCurrency] = useState(currency);
  const [usdCnyRateInput, setUsdCnyRateInput] = useState(String(usdCnyRate));

  // Gateway settings
  const [gatewayPort,    setGatewayPort]    = useState(11430);
  const [autoLaunch,     setAutoLaunch]     = useState(false);
  const [reqTimeout,     setReqTimeout]     = useState('60');
  const [maxConcurrent,  setMaxConcurrent]  = useState('8');
  const [logLevel,       setLogLevel]       = useState('warn');

  // Routing settings
  const [retryCount,     setRetryCount]     = useState('1');
  const [healthInterval, setHealthInterval] = useState('60');
  const [keepRouteLogs,  setKeepRouteLogs]  = useState(true);

  // Compression settings（仅内置无损 JSON 压缩）
  const [compressEnabled, setCompressEnabled] = useState(false);
  // macOS：是否隐藏 Dock（默认否，设置中可开）
  const [hideDockIcon, setHideDockIcon] = useState(false);
  const isMac = window.electronAPI?.platform === 'darwin';

  const [savedMsg, setSavedMsg] = useState('');
  const [saving,   setSaving]   = useState(false);

  // 同步全局货币设置到表单
  useEffect(() => {
    setDisplayCurrency(currency);
    setUsdCnyRateInput(String(usdCnyRate));
  }, [currency, usdCnyRate]);

  // Load saved config on mount
  useEffect(() => {
    getConfig().read().then(cfg => {
      if (!cfg) return;
      if (cfg.gateway_port)      setGatewayPort(cfg.gateway_port);
      if (cfg.auto_launch != null) setAutoLaunch(!!cfg.auto_launch);
      if (cfg.req_timeout)       setReqTimeout(String(cfg.req_timeout));
      if (cfg.max_concurrent)    setMaxConcurrent(String(cfg.max_concurrent));
      if (cfg.log_level)         setLogLevel(cfg.log_level);
      if (cfg.retry_count != null) setRetryCount(String(cfg.retry_count));
      if (cfg.health_interval)   setHealthInterval(String(cfg.health_interval));
      if (cfg.keep_route_logs != null) setKeepRouteLogs(!!cfg.keep_route_logs);
      if (cfg.compress) setCompressEnabled(!!cfg.compress.enabled);
      if (cfg.currency) setDisplayCurrency(cfg.currency === 'USD' ? 'USD' : 'CNY');
      if (cfg.usd_cny_rate != null) setUsdCnyRateInput(String(cfg.usd_cny_rate));
      // 默认 false：未设置时不隐藏 Dock
      setHideDockIcon(!!cfg.hide_dock_icon);
    }).catch(() => {});
    // Read live gateway port from status
    getGateway().status().then(s => {
      if (s?.port) setGatewayPort(s.port);
    }).catch(() => {});
    window.electronAPI?.updater?.getSettings?.().then(s => {
      if (s?.allowPrerelease != null) setAllowPrerelease(!!s.allowPrerelease);
    }).catch(() => {});
  }, []);

  async function handleAllowPrereleaseChange(next) {
    setAllowPrerelease(next);
    setUpdateMsg('');
    try {
      await window.electronAPI?.updater?.setAllowPrerelease?.(next);
    } catch { /* 离线 */ }
  }

  async function handleCheckUpdate() {
    if (!window.electronAPI?.updater?.checkNow) return;
    setUpdateChecking(true);
    setUpdateMsg('');
    try {
      const r = await window.electronAPI.updater.checkNow();
      if (r.status === 'dev') {
        setUpdateMsg(t('settings.updateDevSkip'));
      } else if (r.status === 'available') {
        setUpdateMsg(t('settings.updateAvailable', { version: r.version }));
      } else if (r.status === 'latest') {
        setUpdateMsg(t('settings.updateLatest', { version: r.version || window.electronAPI.version }));
      } else {
        setUpdateMsg(`${t('settings.updateError')}${r.message ? `: ${r.message}` : ''}`);
      }
    } catch (e) {
      setUpdateMsg(`${t('settings.updateError')}: ${e.message || ''}`);
    } finally {
      setUpdateChecking(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const base = persistServerUrl(serverUrl);
      setServerUrl(base);
      await syncCloudConfigUrl(base);
      const current = (await getConfig().read().catch(() => null)) || {};
      const rate = Math.max(0.01, Number(usdCnyRateInput) || DEFAULT_USD_CNY_RATE);
      await getConfig().write({
        ...current,
        gateway_port:    Number(gatewayPort),
        auto_launch:     autoLaunch,
        req_timeout:     Number(reqTimeout),
        max_concurrent:  Number(maxConcurrent),
        log_level:       logLevel,
        retry_count:     Number(retryCount),
        health_interval: Number(healthInterval),
        keep_route_logs: keepRouteLogs,
        compress: { enabled: compressEnabled },
        currency: displayCurrency,
        usd_cny_rate: rate,
        hide_dock_icon: isMac ? hideDockIcon : false,
      });
      applySettings({ currency: displayCurrency, usdCnyRate: rate });
      if (isMac) {
        try { await window.electronAPI?.app?.setHideDockIcon?.(hideDockIcon); } catch { /* ignore */ }
      }
      setSavedMsg(t('settings.saved'));
      setTimeout(() => setSavedMsg(''), 2000);
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setGatewayPort(11430); setAutoLaunch(false); setReqTimeout('60');
    setMaxConcurrent('8'); setLogLevel('warn'); setRetryCount('1');
    setHealthInterval('60'); setKeepRouteLogs(true);
    setCompressEnabled(false);
    setHideDockIcon(false);
    const defCur = defaultCurrencyForLang(lang);
    setDisplayCurrency(defCur);
    setUsdCnyRateInput(String(DEFAULT_USD_CNY_RATE));
    applySettings({ currency: defCur, usdCnyRate: DEFAULT_USD_CNY_RATE });
  }

  /** 货币/汇率切换后立即全局生效（与主题、语言一致，无需等保存） */
  function handleCurrencyChange(c) {
    setDisplayCurrency(c);
    applySettings({
      currency: c,
      usdCnyRate: Math.max(0.01, Number(usdCnyRateInput) || DEFAULT_USD_CNY_RATE),
    });
  }

  function handleRateChange(raw) {
    setUsdCnyRateInput(raw);
    const rate = Math.max(0.01, Number(raw) || DEFAULT_USD_CNY_RATE);
    applySettings({ currency: displayCurrency, usdCnyRate: rate });
  }

  const THEME_OPTIONS = [
    { value: 'light',  label: t('theme.light') },
    { value: 'system', label: t('theme.system') },
    { value: 'dark',   label: t('theme.dark') },
  ];

  const LANG_OPTIONS = [
    { value: 'zh', label: t('lang.zh') },
    { value: 'en', label: t('lang.en') },
  ];

  const CURRENCY_OPTIONS = [
    { value: 'CNY', label: t('settings.currencyCNY') },
    { value: 'USD', label: t('settings.currencyUSD') },
  ];

  return (
    <div className="px-4 py-4 space-y-4 w-full max-w-4xl mx-auto">

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('settings.title')}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{t('settings.subtitle')}</p>
      </div>

      {/* Gateway section */}
      <div className="tb-soft-card rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.gateway')}</h2>
        </div>
        <div className="divide-y divide-white/40 dark:divide-white/[0.06]">
          <Row label={t('settings.port')} hint={t('settings.portHint')}>
            <div className="flex items-center gap-2">
              <input
                type="number"
                value={gatewayPort}
                onChange={e => setGatewayPort(e.target.value)}
                className="w-24 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-800 dark:text-zinc-200 text-right font-mono focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-gray-600">{t('settings.restartNote')}</span>
            </div>
          </Row>
          <Row label={t('settings.autoLaunch')} hint={t('settings.autoLaunchHint')}>
            <Toggle enabled={autoLaunch} onChange={() => setAutoLaunch(v => !v)} />
          </Row>
          <SelectRow label={t('settings.reqTimeout')} hint={t('settings.reqTimeoutHint')}
            value={reqTimeout} onChange={setReqTimeout}
            options={[
              { value: '30', label: t('settings.timeout30') },
              { value: '60', label: t('settings.timeout60') },
              { value: '120', label: t('settings.timeout120') },
              { value: '0', label: t('settings.timeoutUnlimited') },
            ]}
          />
          <SelectRow label={t('settings.maxConcurrent')} hint={t('settings.maxConcurrentHint')}
            value={maxConcurrent} onChange={setMaxConcurrent}
            options={[{ value: '4', label: '4' }, { value: '8', label: '8' }, { value: '16', label: '16' }, { value: '32', label: '32' }]}
          />
          <SelectRow label={t('settings.logLevel')} hint={t('settings.logLevelHint')}
            value={logLevel} onChange={setLogLevel}
            options={[
              { value: 'error', label: 'Error' },
              { value: 'warn', label: 'Warn' },
              { value: 'info', label: 'Info' },
              { value: 'debug', label: 'Debug' },
            ]}
          />
        </div>
      </div>

      {/* Routing section */}
      <div className="tb-soft-card rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.routing')}</h2>
        </div>
        <div className="divide-y divide-white/40 dark:divide-white/[0.06]">
          <SelectRow label={t('settings.retryCount')} hint={t('settings.retryCountHint')}
            value={retryCount} onChange={setRetryCount}
            options={[
              { value: '0', label: t('settings.retry0') },
              { value: '1', label: t('settings.retry1') },
              { value: '2', label: t('settings.retry2') },
              { value: '3', label: t('settings.retry3') },
            ]}
          />
          <SelectRow label={t('settings.healthInterval')} hint={t('settings.healthIntervalHint')}
            value={healthInterval} onChange={setHealthInterval}
            options={[
              { value: '30', label: t('settings.health30') },
              { value: '60', label: t('settings.health60') },
              { value: '300', label: t('settings.health300') },
              { value: '0', label: t('settings.healthOff') },
            ]}
          />
          <Row label={t('settings.keepRouteLogs')} hint={t('settings.keepRouteLogsHint')}>
            <Toggle enabled={keepRouteLogs} onChange={() => setKeepRouteLogs(v => !v)} />
          </Row>
        </div>
      </div>

      <DecisionPanel />

      {/* Compression section */}
      <div className="tb-soft-card rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.compression')}</h2>
        </div>
        <div className="divide-y divide-white/40 dark:divide-white/[0.06]">
          <Row label={t('settings.compressEnabled')} hint={t('settings.compressEnabledHint')}>
            <Toggle enabled={compressEnabled} onChange={() => setCompressEnabled(v => !v)} />
          </Row>
        </div>
      </div>

      {/* Appearance section */}
      <div className="tb-soft-card rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.appearance')}</h2>
        </div>
        <div className="divide-y divide-white/40 dark:divide-white/[0.06]">
          <Row label={t('config.theme')} hint={t('settings.themeHint')}>
            <div className="flex rounded-lg overflow-hidden border border-zinc-300 dark:border-zinc-700 text-xs">
              {THEME_OPTIONS.map(o => (
                <button key={o.value} onClick={() => setTheme(o.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${theme === o.value ? 'bg-blue-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </Row>
          <Row label={t('config.lang')} hint={t('config.langHint')}>
            <div className="flex rounded-lg overflow-hidden border border-zinc-300 dark:border-zinc-700 text-xs">
              {LANG_OPTIONS.map(o => (
                <button key={o.value} onClick={() => setLang(o.value)}
                  className={`px-3 py-1.5 font-medium transition-colors ${lang === o.value ? 'bg-blue-600 text-white' : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                  {o.label}
                </button>
              ))}
            </div>
          </Row>
          <SelectRow label={t('settings.currency')} hint={t('settings.currencyHint')}
            value={displayCurrency} onChange={handleCurrencyChange}
            options={CURRENCY_OPTIONS}
          />
          {isMac && isDesktop && (
            <Row label={t('settings.hideDockIcon')} hint={t('settings.hideDockIconHint')}>
              <Toggle
                enabled={hideDockIcon}
                onChange={async () => {
                  const next = !hideDockIcon;
                  setHideDockIcon(next);
                  try {
                    await window.electronAPI?.app?.setHideDockIcon?.(next);
                  } catch { /* ignore */ }
                }}
              />
            </Row>
          )}
          <Row label={t('settings.usdCnyRate')} hint={t('settings.usdCnyRateHint')}>
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">1 USD =</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={usdCnyRateInput}
                onChange={e => handleRateChange(e.target.value)}
                className="w-20 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-zinc-800 dark:text-zinc-200 text-right font-mono focus:outline-none focus:border-blue-500"
              />
              <span className="text-xs text-zinc-500">CNY</span>
            </div>
          </Row>
        </div>
      </div>

      {/* 应用更新（仅桌面端） */}
      {isDesktop && (
        <div className="tb-soft-card rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
            <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.update')}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{t('settings.updateHint')}</p>
          </div>
          <div className="divide-y divide-white/40 dark:divide-white/[0.06]">
            <Row label={t('settings.updateAllowBeta')} hint={t('settings.updateAllowBetaHint')}>
              <Toggle
                enabled={allowPrerelease}
                onChange={() => handleAllowPrereleaseChange(!allowPrerelease)}
              />
            </Row>
            <div className="px-5 py-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleCheckUpdate}
                disabled={updateChecking}
                className="text-sm px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors"
              >
                {updateChecking ? t('settings.updateChecking') : t('settings.updateCheck')}
              </button>
              {updater?.pendingVersion && (
                <button
                  type="button"
                  onClick={() => updater.install()}
                  className="text-sm px-4 py-2 rounded-xl bg-green-600 hover:bg-green-500 text-white font-medium transition-colors"
                >
                  {t('settings.updateInstall')}
                </button>
              )}
              {updateMsg && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{updateMsg}</span>
              )}
              {!updateMsg && updater?.pendingVersion && (
                <span className="text-xs text-green-600 dark:text-green-400">
                  {t('settings.updateReady', { version: updater.pendingVersion })}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Server URL */}
      <div className="tb-soft-card rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.server')}</h2>
        </div>
        <div className="px-5 py-4">
          <div className="text-xs text-gray-500 mb-2">{t('settings.serverUrlHint')}</div>
          <input
            type="text"
            value={serverUrl}
            onChange={e => setServerUrl(e.target.value)}
            onBlur={async e => {
              const v = persistServerUrl(e.target.value);
              setServerUrl(v);
              await syncCloudConfigUrl(v);
            }}
            placeholder={SERVER_URL_PLACEHOLDER}
            className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:border-blue-500 font-mono"
          />
        </div>
      </div>

      {/* Diagnostics / troubleshooting section */}
      <div className="tb-soft-card rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.diagnostics')}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{t('settings.diagnosticsHint')}</p>
        </div>
        <div className="px-5 py-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleExportDiagnostics}
            disabled={diagBusy}
            className="text-sm px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors"
          >
            {diagBusy ? t('settings.diagExporting') : t('settings.diagExport')}
          </button>
          {diagMsg && <span className="text-xs text-zinc-500 dark:text-zinc-400">{diagMsg}</span>}
          <span className="text-xs text-gray-400 dark:text-gray-500 w-full">{t('settings.diagRedactNote')}</span>
        </div>
      </div>

      {/* Account section */}
      <div className="tb-soft-card rounded-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
          <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('settings.account')}</h2>
        </div>
        <div className="divide-y divide-white/40 dark:divide-white/[0.06]">
          {user ? (
            <>
              <Row label={t('config.email')} hint={user.email}>
                <span className="text-xs text-gray-500 bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 rounded-lg">
                  {user.nickname || '—'}
                </span>
              </Row>
              <div className="flex items-center justify-between px-5 py-4">
                <div>
                  <div className="text-sm text-red-600 dark:text-red-400">{t('settings.logout')}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{t('settings.logoutHint')}</div>
                </div>
                <button onClick={onLogout}
                  className="text-xs text-red-600 dark:text-red-400 hover:text-red-300 bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-800/50 px-3 py-1.5 rounded-lg transition-colors">
                  {t('settings.signOut')}
                </button>
              </div>
            </>
          ) : (
            <div className="px-5 py-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm text-zinc-800 dark:text-zinc-200">{t('sidebar.guest')}</div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 leading-relaxed">{t('settings.loginHint')}</div>
              </div>
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="shrink-0 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg transition-colors"
              >
                {t('config.login')}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Save row */}
      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors">
          {saving ? t('settings.saving') : t('settings.save')}
        </button>
        <button onClick={handleReset}
          className="px-4 py-2.5 bg-zinc-100 dark:bg-zinc-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-zinc-700 dark:text-zinc-300 text-sm rounded-xl border border-zinc-300 dark:border-zinc-700 transition-colors">
          {t('settings.reset')}
        </button>
        {savedMsg && <span className="text-xs text-green-600 dark:text-green-400">✓ {savedMsg}</span>}
      </div>

      {/* Version footer */}
      <div className="text-xs text-gray-400 dark:text-gray-600 pb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>Token Bank</span>
        {window.electronAPI?.version && (
          <span className="font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-500 dark:text-zinc-400">
            v{window.electronAPI.version}
          </span>
        )}
        <span>·</span>
        <a href="https://github.com/wink-run/tokenbank" target="_blank" rel="noreferrer"
          className="hover:text-gray-500 dark:hover:text-gray-400 transition-colors underline">
          GitHub
        </a>
        <span>·</span>
        <span>{t('settings.contact')}</span>
      </div>
    </div>
  );
}
