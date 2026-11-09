import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { getProfile, listKeys } from '../api/client';
import { loadUserAccounts, saveUserAccounts, syncProviderCatalog } from '../api/userAccounts';
import { getLocalConfig, getConfig, isElectron } from '../api/adapter';
import { getServerUrl, normalizeServerBase, getSyncServerBase, syncCloudConfigUrl, bootstrapServerUrl } from '../config';
import { stopAgent } from '../api/agentControl';
import { classifyProfileFailure } from '../../shared/contribute-autostart.js';

const AuthContext = createContext(null);

const POLL_INTERVAL = 30_000;

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
    startPolling();
    syncCloudKey();
    syncCloudConfigUrl();
    syncUserBilling();
    syncUserSession(token);
    window.electronAPI?.tray?.setAuthState?.(true);
    if (gen !== sessionGenRef.current) return;
    await syncAgentCredentials(r.data);
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

  useEffect(() => {
    // 桌面版无 token 时进游客。Docker / CLI Web 不开放游客，未登录只能停在登录页。
    const enterGuestMode = () => {
      localStorage.setItem('guest', '1');
      setGuest(true);
      // 游客不得继续用上次登录残留的转发 Key 打社区 P2P
      clearP2pAuthForGuest();
    };
    const stayLoggedOut = () => {
      localStorage.removeItem('guest');
      setGuest(false);
    };
    const onAnonymous = () => (isElectron() ? enterGuestMode() : stayLoggedOut());
      bootstrapServerUrl().then(async () => {
      const token = localStorage.getItem('token');
      // 启动即拉取应用目录（公开）；登录用户再全量同步 sources/scenes
      await syncRemoteConfig();
      if (!token) { onAnonymous(); setLoading(false); return; }
      getProfile()
        .then((r) => acceptProfile(r, token))
        .catch((err) => handleProfileFailure(err, onAnonymous))
        .finally(() => setLoading(false));
    }).catch(() => {
      // bootstrapServerUrl 失败（如 electronAPI 同步抛错）也必须解除 loading，
      // 否则 App 会永远卡在「加载中…」spinner、登录框无法出现。
      onAnonymous();
      setLoading(false);
    });
    return () => stopPolling();
  }, []);

  function loginSuccess(token, userData) {
    localStorage.removeItem('guest');   // 登录后退出游客模式
    setGuest(false);
    localStorage.setItem('token', token);
    profileReadyRef.current = true;
    setUser(userData);
    window.electronAPI?.tray?.setAuthState?.(true);
    startPolling();
    // 本进程若已手动停止或登出，主进程会拒绝自动拉起，不会抵消这次意图。
    syncAgentCredentials(userData);
    syncCloudKey();
    syncCloudConfigUrl();
    syncRemoteConfig();
    syncUserBilling();
    syncUserSession(token);
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
