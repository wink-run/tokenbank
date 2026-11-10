import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from '../store/lang';


/** 识别用户输入中的 GitHub Skill 来源（与主进程 parseGithubSkillRef 对齐的轻量检测） */
function extractGithubSkillSource(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const m = text.match(
    /(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:\/(?:tree|blob)\/[^\s#]+)?/i,
  );
  if (m) return m[0].replace(/[.,;]+$/, '');
  // owner/repo（整段输入或夹在「安装skill」类说明里）
  const short = text.match(/(?:^|[\s`'"(【])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:[\s`'"),。；;】]|$)/);
  if (short && !/\s/.test(short[1])) return short[1];
  return null;
}

/** 组装交给安装智能体的任务提示 */
function buildInstallPrompt(userInput) {
  const text = String(userInput || '').trim();
  return [
    '请根据用户提供的安装命令或说明，在本机安装 Skill（Agent Skill / SKILL.md）。',
    '',
    '## 用户输入',
    text,
    '',
    '## 安装要求',
    '1. 解析要安装的 skill slug、包名、GitHub 地址，或直接执行用户给出的安装命令。',
    '2. 默认安装目录：`~/.tokenbank/skills`（Windows：`%USERPROFILE%\\.tokenbank\\skills`）。',
    '3. 来源分流：',
    '   - **GitHub URL / owner/repo**：不要调用 skillhub；用 `git clone --depth 1 <url> ~/.tokenbank/skills/<repo名>`（或下载 zip 解压），确认存在 SKILL.md。',
    '   - **SkillHub slug**：`skillhub install <slug> --dir <上述目录> --json`。',
    '   - 其它：可用用户给出的安全命令（如 `npx skills add <url> -g -y`）。',
    '4. 安装完成后检查目录下存在 `SKILL.md`（或 `skill.md`），再汇报结果。',
    '5. 禁止编造「已安装成功」；失败时用中文说明可操作的原因。',
    '6. 最终用简短中文总结：成功/失败、技能名、安装路径。',
  ].join('\n');
}

async function loadEngineStatus() {
  try { return await window.electronAPI?.guardian?.engineStatus?.(); } catch { return null; }
}

/**
 * Skill 安装对话框：GitHub 地址直接装；其它说明交给看护执行引擎（在一个已纳管的应用里后台安装）。
 * 没有可用应用时引导用户去纳管。
 */
export default function SkillInstallDialog({
  open,
  onClose,
  onNeedAgent,
  onInstalled,
}) {
  const { t } = useLang();
  const [input, setInput] = useState('');
  // step: preparing | needAgent | ready | error
  const [ready, setReady] = useState({ loading: true, step: 'preparing' });
  const [phase, setPhase] = useState('idle'); // idle | enabling | running | done
  const [taskId, setTaskId] = useState(null);
  const [status, setStatus] = useState('');
  const [activity, setActivity] = useState([]);
  const [steps, setSteps] = useState(0);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [summary, setSummary] = useState('');
  const handleTerminalRef = useRef(() => {});
  const setupGenRef = useRef(0);

  /** 看护执行引擎是否有可用的应用 */
  const ensureInstallerReady = useCallback(async () => {
    const gen = ++setupGenRef.current;
    setReady({ loading: true, step: 'preparing' });
    setPhase('enabling');
    setErr('');
    setMsg(t('resources.skillInstall.enabling'));

    try {
      const st = await loadEngineStatus();
      if (gen !== setupGenRef.current) return;
      if (!st) throw new Error(t('resources.skillInstall.enableFailed'));

      if (st.ready) {
        const label = (st.runtimes || []).find((r) => r.id === st.runtime)?.label || st.runtime;
        setReady({ loading: false, step: 'ready', runtime: label });
        setMsg(t('resources.skillInstall.autoReady', { agent: label }));
        setPhase('idle');
        return;
      }

      // 没有已纳管、能执行命令的应用
      setReady({ loading: false, step: 'needAgent' });
      setMsg('');
      setPhase('idle');
    } catch (e) {
      if (gen !== setupGenRef.current) return;
      setReady({ loading: false, step: 'error' });
      setErr(e.message || String(e));
      setMsg('');
      setPhase('idle');
    }
  }, [t]);

  useEffect(() => {
    if (!open) return undefined;
    setInput('');
    setPhase('idle');
    setTaskId(null);
    setStatus('');
    setActivity([]);
    setSteps(0);
    setMsg('');
    setErr('');
    setSummary('');
    ensureInstallerReady();
    return () => { setupGenRef.current += 1; };
  }, [open, ensureInstallerReady]);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (phase === 'running' || phase === 'enabling') return;
      onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, phase, onClose]);

  const finishOk = useCallback(async (text, resource) => {
    setPhase('done');
    setTaskId(null);
    setSummary(String(text || '').trim());
    setMsg(t('resources.skillInstall.done'));
    setStatus(t('resources.skillInstall.scanHint'));
    try {
      if (typeof onInstalled === 'function') await onInstalled({ resource: resource || null });
    } catch { /* ignore */ }
  }, [onInstalled, t]);

  const finishFail = useCallback((raw) => {
    setPhase('idle');
    setTaskId(null);
    setErr(String(raw || t('resources.skillInstall.failed')).trim());
  }, [t]);

  useEffect(() => {
    handleTerminalRef.current = (tid, text, error) => {
      if (!tid || (taskId && tid !== taskId)) return;
      if (error) finishFail(error);
      else finishOk(text);
    };
  }, [taskId, finishFail, finishOk]);

  useEffect(() => {
    if (!open) return undefined;
    const api = window.electronAPI && window.electronAPI.agent;
    if (!api || !api.onCompleted) return undefined;
    const offDone = api.onCompleted((data) => {
      const text = (data && data.result && (data.result.summary || data.result.text)) || '';
      handleTerminalRef.current(data && data.taskId, text, null);
    });
    const offFail = api.onFailed((data) => {
      const raw = (data && (data.error
        || (data.result && (data.result.error || data.result.stderr || data.result.summary)))) || '';
      handleTerminalRef.current(data && data.taskId, '', raw || 'failed');
    });
    return () => { try { offDone(); offFail(); } catch { /* */ } };
  }, [open]);

  useEffect(() => {
    if (!open || !taskId) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await window.electronAPI.agent.getTaskStatus(taskId);
        const task = res && res.status;
        if (!task || stopped) return;
        const rows = task.steps || [];
        setSteps(rows.length);
        const labels = rows
          .map((r) => {
            if (!r) return '';
            if (r.label) return String(r.label);
            if (r.type === 'thinking') return t('resources.reco.thinkingIdle');
            if (r.type === 'tool') return t('resources.reco.toolIdle');
            return '';
          })
          .filter(Boolean);
        if (labels.length) {
          setActivity(labels.slice(-4));
          setStatus(labels[labels.length - 1]);
        }
        if (task.status === 'completed') {
          const full = [
            (task.result && task.result.summary) || '',
            rows.map((r) => r && (r.label || r.summary || '')).filter(Boolean).join('\n'),
          ].filter(Boolean).join('\n');
          handleTerminalRef.current(taskId, full, null);
        } else if (task.status === 'failed') {
          handleTerminalRef.current(taskId, '', task.error || 'failed');
        } else if (task.status === 'cancelled') {
          handleTerminalRef.current(taskId, '', 'cancelled');
        }
      } catch { /* 下次再试 */ }
    };
    poll();
    const iv = setInterval(poll, 2500);
    return () => { stopped = true; clearInterval(iv); };
  }, [open, taskId, t]);

  const startInstall = async () => {
    const text = input.trim();
    if (!text) {
      setErr(t('resources.skillInstall.needInput'));
      return;
    }

    // GitHub URL：主进程确定性安装，不依赖安装智能体 / skillhub slug
    const githubSrc = extractGithubSkillSource(text);
    if (githubSrc) {
      setErr('');
      setMsg('');
      setSummary('');
      setActivity([]);
      setSteps(0);
      setStatus(t('resources.skillInstall.githubInstalling'));
      setPhase('running');
      try {
        const api = window.electronAPI.resource;
        if (!api || !api.installGithubSkill) {
          throw new Error(t('resources.skillInstall.githubUnsupported'));
        }
        const res = await api.installGithubSkill({ source: text, force: false });
        if (!res || !res.success) {
          throw new Error((res && res.error) || t('resources.skillInstall.failed'));
        }
        const name = (res.resource && (res.resource.name || res.resource.display_name))
          || res.skillName
          || githubSrc;
        const lines = [
          res.alreadyInstalled ? `技能已存在：${name}` : `安装成功：${name}`,
          res.skillDir ? `安装路径：${res.skillDir}` : '',
          res.sourceUrl ? `来源：${res.sourceUrl}` : '',
        ].filter(Boolean);
        await finishOk(lines.join('\n'), res.resource);
      } catch (e) {
        setErr(e.message || String(e));
        setPhase('idle');
        setTaskId(null);
      }
      return;
    }

    if (ready.step !== 'ready') {
      await ensureInstallerReady();
    }
    const st = await loadEngineStatus();
    if (!st || !st.ready) {
      setErr(t('resources.skillInstall.notReady'));
      return;
    }
    const runtimeLabel = (st.runtimes || []).find((r) => r.id === st.runtime)?.label || st.runtime;
    setReady({ loading: false, step: 'ready', runtime: runtimeLabel });

    setErr('');
    setMsg('');
    setSummary('');
    setActivity([]);
    setSteps(0);
    setStatus(t('resources.reco.starting'));
    setPhase('running');
    try {
      const exec = await window.electronAPI.guardian.engineRun({
        kind: 'install',
        prompt: buildInstallPrompt(text),
        sessionKey: 'resource-install',
      });
      if (!exec || !exec.success || !exec.taskId) {
        throw new Error((exec && exec.error) || 'agent start failed');
      }
    try { window.dispatchEvent(new Event('tb-guardian-changed')); } catch { /* 侧边栏小圆点立即显示「正在执行」 */ }
      setTaskId(exec.taskId);
    } catch (e) {
      setErr(e.message || String(e));
      setPhase('idle');
      setTaskId(null);
    }
  };

  const stopRun = async () => {
    const tid = taskId;
    if (!tid) return;
    try { await window.electronAPI.agent.cancel(tid); } catch { /* ignore */ }
    setTaskId(null);
    setPhase('idle');
    setMsg(t('resources.reco.stopped'));
  };

  if (!open) return null;

  const running = phase === 'running';
  const preparing = phase === 'enabling' || ready.loading;
  const githubReady = !!extractGithubSkillSource(input);
  // GitHub 直装不依赖安装智能体；其它路径仍需 ready
  const canStart = !!input.trim() && (githubReady || ready.step === 'ready');
  const runtimeAgent = ready.runtime || '';

  return createPortal(
    <div
      className="electron-no-drag fixed inset-0 z-[9998] flex items-center justify-center p-4 bg-black/40"
      onClick={() => { if (!running && !preparing) onClose(); }}
    >
      <div
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {t('resources.skillInstall.title')}
          </h3>
          <p className="text-[11px] text-zinc-400 mt-1">{t('resources.skillInstall.hint')}</p>
        </div>

        <div className="p-4 space-y-3">
          {preparing && (
            <p className="text-xs text-zinc-400">
              {msg || t('resources.skillInstall.preparing')}
            </p>
          )}

          {!preparing && ready.step === 'needAgent' && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20 p-3 text-xs space-y-2">
              <p className="text-amber-800 dark:text-amber-200">{t('resources.skillInstall.needAgent')}</p>
              <p className="text-amber-700/80 dark:text-amber-300/70">{t('resources.skillInstall.needAgentHint')}</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => { if (onNeedAgent) onNeedAgent(); }}
                  className="px-3 py-1.5 rounded-md bg-amber-600 text-white hover:bg-amber-700"
                >
                  {t('resources.skillInstall.goManageAgent')}
                </button>
                <button
                  type="button"
                  onClick={ensureInstallerReady}
                  className="px-3 py-1.5 rounded-md border border-amber-400/80 text-amber-800 dark:text-amber-200 hover:bg-amber-100/60 dark:hover:bg-amber-950/40"
                >
                  {t('resources.skillInstall.retrySetup')}
                </button>
              </div>
            </div>
          )}

          {!preparing && ready.step === 'error' && (
            <div className="rounded-lg border border-red-300 dark:border-red-800/60 bg-red-50 dark:bg-red-950/20 p-3 text-xs space-y-2">
              <p className="text-red-700 dark:text-red-300">{err || t('resources.skillInstall.enableFailed')}</p>
              <button
                type="button"
                onClick={ensureInstallerReady}
                className="px-3 py-1.5 rounded-md border border-red-300 text-red-700 dark:text-red-300 hover:bg-red-100/60"
              >
                {t('resources.skillInstall.retrySetup')}
              </button>
            </div>
          )}

          <label className="block text-xs text-zinc-500">
            {t('resources.skillInstall.inputLabel')}
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={running || preparing}
              rows={6}
              spellCheck={false}
              placeholder={t('resources.skillInstall.inputPh')}
              className="mt-1 w-full text-xs px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950 font-mono leading-relaxed disabled:opacity-60"
            />
          </label>

          {running && (
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/40 p-3 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-zinc-600 dark:text-zinc-300">
                  {githubReady
                    ? t('resources.skillInstall.githubInstalling')
                    : t('resources.reco.runningOn', { agent: runtimeAgent })}
                </span>
                <span className="text-[10px] text-zinc-400">
                  {githubReady
                    ? ''
                    : (steps ? t('resources.reco.stepsN', { n: steps }) : t('resources.reco.starting'))}
                </span>
              </div>
              {!githubReady && (
                <p className="text-zinc-500">{status || t('resources.reco.bootingRuntime')}</p>
              )}
              {activity.length > 0 && (
                <ul className="text-[11px] text-zinc-400 space-y-0.5 list-disc pl-4">
                  {activity.map((line, i) => (
                    <li key={`${i}-${line}`}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {summary && (
            <pre className="text-[11px] whitespace-pre-wrap rounded-lg border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/80 dark:bg-emerald-950/20 p-3 text-emerald-800 dark:text-emerald-200 max-h-40 overflow-y-auto">
              {summary}
            </pre>
          )}

          {!preparing && msg && <p className="text-xs text-emerald-600">{msg}</p>}
          {!preparing && ready.step !== 'error' && err && (
            <p className="text-xs text-red-500">{err}</p>
          )}
        </div>

        <div className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 flex gap-2 justify-end">
          {running ? (
            <button
              type="button"
              onClick={stopRun}
              className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600"
            >
              {t('resources.reco.stop')}
            </button>
          ) : phase !== 'done' ? (
            <button
              type="button"
              disabled={preparing}
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-600 disabled:opacity-50"
            >
              {t('resources.cancel')}
            </button>
          ) : null}
          {phase === 'done' ? (
            <button
              type="button"
              onClick={onClose}
              className="tb-press text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500"
            >
              {t('resources.skillInstall.close')}
            </button>
          ) : (
            <button
              type="button"
              disabled={running || preparing || !canStart}
              onClick={startInstall}
              className="tb-press text-xs px-3 py-1.5 rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {running ? t('resources.reco.working') : t('resources.skillInstall.start')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
