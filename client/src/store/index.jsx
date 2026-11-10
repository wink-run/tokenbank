import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { getProfile, listKeys } from '../api/client';
import { loadUserAccounts, saveUserAccounts, syncProviderCatalog } from '../api/userAccounts';
import { getLocalConfig, getConfig, isElectron } from '../api/adapter';
import { getServerUrl, normalizeServerBase, getSyncServerBase, syncCloudConfigUrl, bootstrapServerUrl } from '../config';
import { stopAgent } from '../api/agentControl';
import { classifyProfileFailure } from '../../shared/contribute-autostart.mjs';

const AuthContext = createContext(null);

const POLL_INTERVAL = 30_000;
// 上次成功的资料。冷启动用它进界面，不再等登录接口和贡献 WebSocket。
const PROFILE_CACHE_KEY = 'tb.profile';

function readCachedProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || 'null');
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

function writeCachedProfile(data) {
  try {
    if (data) localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(data));
    else localStorage.removeItem(PROFILE_CACHE_KEY);
  } catch { /* 隐私模式写不了就当没有缓存 */ }
}

// 将登录 JWT 同步到网关主进程 / CLI admin-api（用量上报与设备心跳须 JWT，非 P2P Key）
async function syncUserSession(jwt) {
  // Electron：经 IPC 写入主进程即可，勿打 Vite 同源 /api（会 404）
  if (isElectron()) {
    try {
      await window.electronAPI.gateway?.setUserAuth?.(jwt || null);
    } catch {}
    if (jwt) syncProviderCatalog().catch(() => {});
    return;
  }
  // CLI / 浏览器：同源 admin-api
  try {
    if (jwt) {
      const serverUrl = normalizeServerBase(getServerUrl() || '');
      await fetch('/api/user-session', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          ...(serverUrl ? { 'X-TokenBank-Server': serverUrl } : {}),
        },
      });
      syncProviderCatalog().catch(() => {});
    } else {
      await fetch('/api/user-session', { method: 'DELETE' });
    }
  } catch {}
}

function workerSocketUrl() {
  const base = normalizeServerBase(getServerUrl());
  if (!base) return '';
  return base.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws')) + '/ws/worker';
}

// 登录后把 worker_key 写入 config.json。桌面版在主进程里只改这两个字段，并按 auto_start 决定是否拉起。
async function syncAgentCredentials(userData) {
  const wk = userData?.worker_key;
  const serverUrl = workerSocketUrl();
  if (!wk || !serverUrl) return;
  try {
    if (isElectron() && window.electronAPI?.contribute?.credentialsReady) {
      await window.electronAPI.contribute.credentialsReady({ workerKey: wk, serverUrl });
      return;
    }
    const current = (await getConfig().read().catch(() => null)) || {};
    await getConfig().write({ ...current, server_url: serverUrl, worker_key: wk });
  } catch {}
}

/** 明确登出：停贡献并只丢掉凭证。模型名单和圈子仍留在配置里。 */
async function logoutContribution() {
  try {
    if (isElectron() && window.electronAPI?.contribute?.logout) {
      await window.electronAPI.contribute.logout();
      return;
    }
  } catch {}
  try { await stopAgent(); } catch {}
  try {
    const current = (await getConfig().read().catch(() => null)) || {};
    if (!current.worker_key && !current.server_url) return;
    const next = { ...current };
    delete next.worker_key;
    delete next.server_url;
    await getConfig().write(next);
  } catch {}
}

/** 资料接口认定凭证失效：停贡献，不再用这把 worker_key 重连。 */
async function rejectContributionAuth() {
  try {
    if (isElectron() && window.electronAPI?.contribute?.authRejected) {
      await window.electronAPI.contribute.authRejected();
      return;
    }
  } catch {}
  await logoutContribution();
}

// Push the user's first active cloud key + backend URL into the local gateway
// so it can forward P2P model requests to the backend.
async function syncCloudKey() {
  try {
    const r = await listKeys();
    const keys = r.data?.keys || r.data || [];
    const active = (Array.isArray(keys) ? keys : []).find(k => k.is_active);
    if (active) {
      await getLocalConfig().setCloudConfig({
        url:   normalizeServerBase(getServerUrl()),
        token: active.key,
      });
    }
  } catch {}
}

/** 进入游客态：清登录 JWT，并去掉残留 P2P 转发 Key（保留服务 URL） */
async function clearP2pAuthForGuest() {
  syncUserSession(null);
  try {
    const cfg = await getLocalConfig().get();
    const url = cfg?.cloud_config?.url || normalizeServerBase(getServerUrl()) || null;
    await getLocalConfig().setCloudConfig({ url, token: null });
  } catch {}
}

// 启动时从服务端拉取 apps（公开）/ sources+scenes（需登录）；apps 与 sources 全量覆盖本地默认。
async function syncRemoteConfig() {
  if (!window.electronAPI?.toolsConfig) return;
  const base = await getSyncServerBase();
  if (!base) return;
  const token = localStorage.getItem('token');
  try {
    if (token && window.electronAPI.toolsConfig.syncRemote) {
      await window.electronAPI.toolsConfig.syncRemote({ token, serverUrl: base, replace: true });
    } else if (window.electronAPI.toolsConfig.importUrl) {
      // 游客模式：仅拉取公开的应用目录
      await window.electronAPI.toolsConfig.importUrl(base + '/api/config/apps', null, { replace: true });
    }
  } catch {}
}

// 个人供给源配置仅本机；账户摘要由 useDeviceReporter 心跳单向上报
async function syncUserBilling() {}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [guest, setGuest] = useState(false);  // 游客模式：不登录浏览（记忆在 localStorage，直到主动登录）
  const timerRef = useRef(null);

  const profileReadyRef = useRef(false);
  const sessionGenRef = useRef(0);

  async function acceptProfile(r, token) {
    const gen = sessionGenRef.current;
    profileReadyRef.current = true;
    setUser(r.data);
    setGuest(false);
    writeCachedProfile(r.data);
    startPolling();
    syncCloudKey();
    syncCloudConfigUrl();
    syncUserBilling();
    syncUserSession(token);
    window.electronAPI?.tray?.setAuthState?.(true);
    if (gen !== sessionGenRef.current) return;
    // 贡献 WebSocket 在后台连，不把资料回调卡住
    syncAgentCredentials(r.data).catch(() => {});
  }

  async function handleProfileFailure(err, onAnonymous) {
    if (classifyProfileFailure(err) !== 'auth') {
      // 断网或 5xx：保留 token、worker_key、上架名单。已在跑的贡献不停。
      if (!profileReadyRef.current) startPolling();
      return;
    }
    profileReadyRef.current = false;
    sessionGenRef.current += 1;
    localStorage.removeItem('token');
    writeCachedProfile(null);
    stopPolling();
    window.electronAPI?.tray?.setAuthState?.(false);
    await rejectContributionAuth();
    if (typeof onAnonymous === 'function') onAnonymous();
  }

  function startPolling() {
    if (timerRef.current) clearInterval(timerRef.current);
    const gen = sessionGenRef.current;
    timerRef.current = setInterval(() => {
      if (gen !== sessionGenRef.current) return;
      const token = localStorage.getItem('token');
      if (!token) return;
      getProfile()
        .then((r) => {
          if (gen !== sessionGenRef.current) return;
          const first = !profileReadyRef.current;
          setUser(r.data);
          if (first) acceptProfile(r, token).catch(() => {});
        })
        .catch((err) => {
          if (gen !== sessionGenRef.current) return;
          handleProfileFailure(err).catch(() => {});
        });
    }, POLL_INTERVAL);
  }

  function stopPolling() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // 桌面版无 token 时进游客。Docker / CLI Web 不开放游客，未登录只能停在登录页。
  function onAnonymous() {
    setUser(null);
    if (isElectron()) {
      localStorage.setItem('guest', '1');
      setGuest(true);
      // 游客不得继续用上次登录残留的转发 Key 打社区 P2P
      clearP2pAuthForGuest();
    } else {
      localStorage.removeItem('guest');
      setGuest(false);
    }
  }

  // 本机已保存的贡献凭证：马上连 WebSocket，不等这次登录校验。
  function connectSavedContribution() {
    getConfig().read().then((cfg) => {
      const wk = cfg?.worker_key;
      const url = cfg?.server_url || workerSocketUrl();
      if (!wk || !url) return;
      if (isElectron() && window.electronAPI?.contribute?.credentialsReady) {
        window.electronAPI.contribute.credentialsReady({ workerKey: wk, serverUrl: url }).catch(() => {});
      }
    }).catch(() => {});
  }

  // 恢复登录态。资料接口和长连接并行，调用方不等它们结束。
  function resumeCloudSession(token) {
    if (!token) return;
    syncUserSession(token);
    connectSavedContribution();
    getProfile()
      .then((r) => acceptProfile(r, token))
      .catch((err) => handleProfileFailure(err, onAnonymous));
  }

  useEffect(() => {
    const token = localStorage.getItem('token');
    const cached = token ? readCachedProfile() : null;
    // 界面只看本机：有缓存就直接进，没有也不等登录接口或贡献 WebSocket。
    if (cached) {
      localStorage.removeItem('guest');
      setGuest(false);
      setUser(cached);
      profileReadyRef.current = true;
      startPolling();
    } else if (!token) {
      onAnonymous();
    } else if (isElectron()) {
      // 有凭证但资料还没到：先以游客进本机功能，资料回来再换成登录态
      setGuest(true);
    }
    setLoading(false);

    // 登录校验、贡献长连接立刻开始，不排在地址回填或目录同步后面
    resumeCloudSession(token);
    bootstrapServerUrl().catch(() => {}).then(() => {
      syncRemoteConfig().catch(() => {});
    });
    return () => stopPolling();
  }, []);

  function loginSuccess(token, userData) {
    localStorage.removeItem('guest');   // 登录后退出游客模式
    setGuest(false);
    localStorage.setItem('token', token);
    profileReadyRef.current = true;
    setUser(userData);
    writeCachedProfile(userData);
    window.electronAPI?.tray?.setAuthState?.(true);
    startPolling();
    // 会话和贡献长连接都在后台。没有 worker_key 时等资料回来再连。
    syncUserSession(token);
    syncCloudKey();
    syncCloudConfigUrl();
    syncRemoteConfig();
    syncUserBilling();
    if (userData?.worker_key) syncAgentCredentials(userData).catch(() => {});
    else {
      // 登录接口没有 worker_key：后台拉资料再连，不用本机上一个账号的长连接
      getProfile()
        .then((r) => acceptProfile(r, token))
        .catch((err) => handleProfileFailure(err, onAnonymous));
    }
  }

  function enterGuest() {
    // Docker / CLI Web 必须登录，不能绕进游客。
    if (!isElectron()) return;
    localStorage.removeItem('token');
    localStorage.setItem('guest', '1');
    setUser(null);
    setGuest(true);
    clearP2pAuthForGuest();
  }

  function logout() {
    localStorage.removeItem('token');
    writeCachedProfile(null);
    profileReadyRef.current = false;
    sessionGenRef.current += 1;
    setUser(null);
    stopPolling();
    if (isElectron()) {
      // 桌面退出后仍可浏览网关/设置
      localStorage.setItem('guest', '1');
      setGuest(true);
    } else {
      localStorage.removeItem('guest');
      setGuest(false);
    }
    syncUserSession(null);
    // 先标成未登录再停贡献。logout 会清 worker_key，并抑制本进程自动拉起。
    window.electronAPI?.tray?.setAuthState?.(false);
    logoutContribution();
    getLocalConfig().setCloudConfig({ url: null, token: null }).catch(() => {});
  }

  function refreshUser() {
    return getProfile().then((r) => setUser(r.data));
  }

  return (
    <AuthContext.Provider value={{ user, loading, guest, enterGuest, loginSuccess, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

const defaultAuth = {
  user: null,
  loading: false,
  guest: false,
  enterGuest: () => {},
  loginSuccess: () => {},
  logout: () => {},
  refreshUser: () => Promise.resolve(),
};

export function useAuth() {
  return useContext(AuthContext) ?? defaultAuth;
}
