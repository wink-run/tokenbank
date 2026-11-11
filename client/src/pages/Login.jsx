import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { login, register, joinCircle, formatApiError, forgotPassword, resetPassword } from '../api/client';
import { useAuth } from '../store/index';
import logo from '../assets/logo.svg';
import { useLang } from '../store/lang';
import { SERVER_URL_PLACEHOLDER, DEFAULT_TOKEN_SERVER_URL, normalizeServerBase, syncCloudConfigUrl, bootstrapServerUrl } from '../config';
import { isElectron } from '../api/adapter';

/** 切换服务器时清除旧 token，避免跨服鉴权失败 */
function persistServerUrl(url) {
  const next = normalizeServerBase(url);
  if (!next) return '';
  const prev = normalizeServerBase(localStorage.getItem('serverUrl') || '');
  if (prev && prev !== next) localStorage.removeItem('token');
  localStorage.setItem('serverUrl', next);
  return next;
}

function Field({ label, type = 'text', value, onChange, placeholder }) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5 uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-3 py-2.5 text-[13px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:border-blue-400 focus:bg-white dark:focus:bg-zinc-700/50 transition-colors"
      />
    </div>
  );
}

/** 仅允许站内相对路径，避免 open redirect */
function safeReturnPath(from) {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('//')) return '/';
  return from;
}

/** 登录 / 注册 / 找回密码页（与设置页分离，未登录也可从侧栏进入） */
export default function Login() {
  const { user, loginSuccess, enterGuest } = useAuth();
  const { t } = useLang();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath(location.state?.from);

  // 从邀请链接读取圈子码和推荐码
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const inviteCircleCode = urlParams.get('c') || '';
  const inviteRefCode    = urlParams.get('ref') || '';

  // 服务端地址属于高级设置：默认官方服务时折叠，只在自建/已改过时展开
  const [showServerField, setShowServerField] = useState(false);
  const [serverUrl, setServerUrl] = useState(
    () => normalizeServerBase(localStorage.getItem('serverUrl') || '')
  );
  // login | register | forgot
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [referralCode, setReferralCode] = useState(inviteRefCode);
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [firstRun, setFirstRun] = useState(false);
  // 找回密码：发码后进入第二步
  const [forgotStep, setForgotStep] = useState(1);
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [contactInfo, setContactInfo] = useState('');

  // 已登录则无需停留登录页
  useEffect(() => {
    if (user) navigate(returnTo, { replace: true });
  }, [user, navigate, returnTo]);

  useEffect(() => {
    if (!isElectron()) return;
    window.electronAPI.config.read().then((cfg) => { if (!cfg) setFirstRun(true); });
    bootstrapServerUrl().then((url) => { if (url) setServerUrl(url); });
  }, []);

  function afterAuth(token, circleResult = null) {
    localStorage.setItem('token', token);
    const base = normalizeServerBase(localStorage.getItem('serverUrl') || serverUrl || '');
    // 服务地址、个人资料、贡献 WebSocket 都在 loginSuccess 里后台做
    syncCloudConfigUrl(base).catch(() => {});
    loginSuccess(token, { email: email.trim() });
    // 有邀请圈子结果时跳转到圈子页并传递提示
    if (circleResult) {
      navigate('/contribute', { replace: true, state: { tradeTab: 'circles', circleResult } });
    } else {
      navigate(returnTo, { replace: true });
    }
  }

  async function handleLogin(e) {
    e.preventDefault();
    setError('');
    const base = persistServerUrl(serverUrl);
    if (!base) { setError(t('config.serverRequired')); return; }
    setSaving(true);
    try {
      setServerUrl(base);
      const res = await login(email, password);
      // 已注册用户通过邀请链接登录时，登录后手动调入圈接口
      let circleResult = null;
      if (inviteCircleCode) {
        try {
          localStorage.setItem('token', res.data.token);
          const jr = await joinCircle(inviteCircleCode);
          circleResult = jr.data;
        } catch (_) {}
      }
      await afterAuth(res.data.token, circleResult);
    } catch (err) {
      localStorage.removeItem('token');
      setError(formatApiError(err, t('config.loginFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function handleRegister(e) {
    e.preventDefault();
    setError('');
    const base = persistServerUrl(serverUrl);
    if (!base) { setError(t('config.serverRequired')); return; }
    setSaving(true);
    try {
      setServerUrl(base);
      // 注册时服务端自动入圈，circle_code 传给后端
      const res = await register(email, password, nickname, referralCode, inviteCircleCode);
      const circleResult = inviteCircleCode ? {
        ok: res.data.circle_joined || false,
        already_member: false,
        full: res.data.circle_full || false,
      } : null;
      await afterAuth(res.data.token, circleResult);
    } catch (err) {
      localStorage.removeItem('token');
      setError(formatApiError(err, t('config.registerFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function handleSendCode(e) {
    e.preventDefault();
    setError('');
    setOkMsg('');
    const base = persistServerUrl(serverUrl);
    if (!base) { setError(t('config.serverRequired')); return; }
    if (!email.trim()) { setError(t('config.email')); return; }
    setSaving(true);
    try {
      setServerUrl(base);
      const res = await forgotPassword(email.trim());
      setContactInfo(res.data?.contact_info || '');
      setOkMsg(res.data?.message || t('config.codeSent'));
      setForgotStep(2);
    } catch (err) {
      setError(formatApiError(err, t('config.resetFailed')));
    } finally {
      setSaving(false);
    }
  }

  async function handleResetPassword(e) {
    e.preventDefault();
    setError('');
    setOkMsg('');
    if (newPassword.length < 6) { setError(t('config.passwordMin')); return; }
    if (newPassword !== confirmPassword) { setError(t('config.passwordMismatch')); return; }
    setSaving(true);
    try {
      await resetPassword(email.trim(), resetCode.trim(), newPassword);
      setOkMsg(t('config.resetSuccess'));
      setPassword('');
      setResetCode('');
      setNewPassword('');
      setConfirmPassword('');
      setForgotStep(1);
      setMode('login');
    } catch (err) {
      setError(formatApiError(err, t('config.resetFailed')));
    } finally {
      setSaving(false);
    }
  }

  function switchMode(m) {
    setMode(m);
    setError('');
    setOkMsg('');
    setForgotStep(1);
    setResetCode('');
    setNewPassword('');
    setConfirmPassword('');
    setContactInfo('');
  }

  /** 跳过登录，以游客身份进入主界面 */
  function handleGuest() {
    enterGuest();
    navigate('/gateway', { replace: true });
  }

  if (user) return null;

  return (
    <div className="flex h-full items-center justify-center bg-transparent">
      <div className="w-full max-w-[360px] px-5 sm:px-8 py-8 sm:py-10 space-y-5">
        <div className="flex flex-col items-center gap-3 mb-2">
          <img src={logo} alt="Token Bank" className="w-14 h-14" />
          <div className="text-center">
            <h1 className="text-[17px] font-bold text-zinc-900 dark:text-zinc-100 tracking-tight">Token Bank</h1>
            <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-0.5">{t('sidebar.tagline')}</p>
          </div>
        </div>

        {mode !== 'forgot' && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center leading-relaxed px-1">
            {t('config.loginBenefits')}
          </p>
        )}

        {firstRun && (
          <div className="bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-xl px-4 py-3 text-sm text-blue-700 dark:text-blue-300">
            {t('config.firstRun')}
          </div>
        )}

        {!(showServerField || (serverUrl && serverUrl !== normalizeServerBase(DEFAULT_TOKEN_SERVER_URL))) ? (
          <div className="flex justify-center">
            <button type="button" onClick={() => setShowServerField(true)}
              className="text-xs text-zinc-400 hover:text-blue-500 transition-colors">
              {t('config.serverAdvanced')}
            </button>
          </div>
        ) : (
        <div className="space-y-2">
          <label className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1.5 uppercase tracking-wider">{t('config.serverUrl')}</label>
          <input
            type="text"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={(e) => {
              const v = persistServerUrl(e.target.value);
              setServerUrl(v);
            }}
            placeholder={SERVER_URL_PLACEHOLDER}
            className="w-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-xl px-3 py-2.5 text-[13px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:border-blue-400 focus:bg-white dark:focus:bg-zinc-700/50 transition-colors"
          />
        </div>
        )}

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-3">
            <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
            <Field label={t('config.password')} type="password" value={password} onChange={setPassword} placeholder="••••••" />
            <div className="flex justify-end -mt-1">
              <button type="button" onClick={() => switchMode('forgot')}
                className="text-xs text-blue-500 hover:underline">{t('config.forgotPassword')}</button>
            </div>
            {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
            {okMsg && <p className="text-green-600 dark:text-green-400 text-sm">{okMsg}</p>}
            <button type="submit" disabled={saving}
              className="tb-press w-full py-2.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 disabled:opacity-50 rounded-xl text-[13px] font-semibold text-white">
              {saving ? t('config.loggingIn') : t('config.login')}
            </button>
            <p className="text-center text-sm text-zinc-600 dark:text-zinc-500">
              {t('config.noAccount')}
              <button type="button" onClick={() => switchMode('register')}
                className="text-blue-500 hover:underline ml-1">{t('config.register')}</button>
            </p>
          </form>
        ) : mode === 'register' ? (
          <form onSubmit={handleRegister} className="space-y-3">
            <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
            <Field label={t('config.nickname')} type="text" value={nickname} onChange={setNickname} placeholder={t('config.nicknamePh')} />
            <Field label={t('config.password')} type="password" value={password} onChange={setPassword} placeholder={t('config.passwordMin')} />
            <Field label={t('config.referral')} type="text" value={referralCode} onChange={setReferralCode} placeholder={t('config.referralPh')} />
            {inviteCircleCode && (
              <p className="text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 rounded-lg px-3 py-2">
                注册后将自动加入邀请圈子 🎉
              </p>
            )}
            {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
            <button type="submit" disabled={saving}
              className="tb-press w-full py-2.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 disabled:opacity-50 rounded-xl text-[13px] font-semibold text-white">
              {saving ? t('config.registering') : t('config.registerBtn')}
            </button>
            <p className="text-center text-sm text-zinc-600 dark:text-zinc-500">
              {t('config.hasAccount')}
              <button type="button" onClick={() => switchMode('login')}
                className="text-blue-500 hover:underline ml-1">{t('config.goLogin')}</button>
            </p>
          </form>
        ) : (
          /* 找回密码：① 发码 → ② 验证码 + 新密码 */
          <div className="space-y-3">
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200 text-center">{t('config.forgotTitle')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 text-center leading-relaxed">{t('config.forgotHint')}</p>
            {forgotStep === 1 ? (
              <form onSubmit={handleSendCode} className="space-y-3">
                <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
                {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
                <button type="submit" disabled={saving}
                  className="tb-press w-full py-2.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 disabled:opacity-50 rounded-xl text-[13px] font-semibold text-white">
                  {saving ? t('config.sendingCode') : t('config.sendCode')}
                </button>
              </form>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-3">
                <Field label={t('config.email')} type="email" value={email} onChange={setEmail} placeholder="you@example.com" />
                <Field label={t('config.resetCode')} type="text" value={resetCode} onChange={setResetCode} placeholder={t('config.resetCodePh')} />
                <Field label={t('config.newPassword')} type="password" value={newPassword} onChange={setNewPassword} placeholder={t('config.passwordMin')} />
                <Field label={t('config.confirmPassword')} type="password" value={confirmPassword} onChange={setConfirmPassword} placeholder={t('config.passwordMin')} />
                {okMsg && <p className="text-green-600 dark:text-green-400 text-sm">{okMsg}</p>}
                {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}
                {contactInfo ? (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed">
                    {t('config.contactAdmin')} <span className="text-zinc-700 dark:text-zinc-300">{contactInfo}</span>
                  </p>
                ) : (
                  <p className="text-xs text-zinc-400 dark:text-zinc-500">{t('config.contactAdmin')}{t('config.noContact')}</p>
                )}
                <button type="submit" disabled={saving}
                  className="tb-press w-full py-2.5 bg-blue-600 hover:bg-blue-500 dark:bg-[#3f6699] dark:hover:bg-[#4a73a8] active:bg-blue-700 disabled:opacity-50 rounded-xl text-[13px] font-semibold text-white">
                  {saving ? t('config.resetting') : t('config.resetBtn')}
                </button>
                <button type="button" onClick={() => { setForgotStep(1); setError(''); setOkMsg(''); }}
                  className="w-full text-center text-xs text-blue-500 hover:underline">
                  {t('config.sendCode')}
                </button>
              </form>
            )}
            <p className="text-center text-sm text-zinc-600 dark:text-zinc-500">
              <button type="button" onClick={() => switchMode('login')}
                className="text-blue-500 hover:underline">{t('config.backToLogin')}</button>
            </p>
          </div>
        )}

        {/* 桌面版未登录可以先看社区网络。Docker / CLI Web 必须登录后才能进各页。 */}
        {isElectron() && mode !== 'forgot' && (
          <div className="pt-2 border-t border-zinc-200/70 dark:border-white/[0.06]">
            <button type="button" onClick={() => navigate('/network')}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 text-xs rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/40 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 transition-colors">
              <span aria-hidden>🌐</span>{t('guestPreview.browseNetwork')} →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
