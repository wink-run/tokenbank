import React, { useEffect, useState } from 'react';
import { useLang } from '../store/lang';

const copy = {
  zh: {
    title: 'OpenDecision · 本地分类',
    hint: '只用于含分类条件的场景，不改变明确选定模型的直连。旁路结果仅对比，不参与选路。',
    desktop: '此功能需要新版桌面端；浏览器版或旧主进程暂不支持。',
    loading: '正在读取配置…', off: '关闭 · 原分类器', shadow: '旁路对比', active: '正式路由（配置文件开启）',
    endpoint: '旁路服务', circuit: '当前分类服务熔断状态', unused: '尚无请求', closed: '未熔断', open: '已熔断', half_open: '等待恢复试探',
    probe: '检查连接与分类', enable: '开启旁路', disable: '关闭并回退', refresh: '刷新状态', busy: '处理中…',
    unsupported: '面板仅检查本机 OpenDecision：使用 127.0.0.1 或 [::1] 的 /v1/systemone 地址。其他服务仍可通过配置文件管理。',
    probeHint: '检查只发送内置示例，不发送聊天记录、不调用付费模型。健康检查通过不代表分类准确。',
    notChecked: '本次运行尚未检查；服务状态未知。', pass: '最近检查成功', fail: '最近检查失败', score: '得分（非准确率）',
    stats: '分类器本次运行统计（含其他分类服务）', samples: '旁路样本', comparable: '可比较', agreement: '一致率', errors: '旁路错误',
    fallbackLlm: 'LLM 回退成功', fallbackDefault: '默认链回退', noDefault: '缺少可用默认链',
    note: '仅双方都有有效类别的样本计入一致率；一致不等于正确。统计重启清零，点击刷新更新。按钮立即生效，无需整页保存。',
    safety: '当前面板不会开启正式路由。关闭只停止分类增强，不会终止独立服务进程。',
    failed: '操作失败', success: '已更新', wait: '秒后可试探',
  },
  en: {
    title: 'OpenDecision · Local classification',
    hint: 'Only classifier-conditioned scenes participate. Explicit model requests are unchanged. Shadow results never choose a route.',
    desktop: 'Requires the updated desktop app. Browser mode and older main processes are not supported.',
    loading: 'Loading configuration…', off: 'Off · Original classifier', shadow: 'Shadow comparison', active: 'Live routing (enabled in config)',
    endpoint: 'Shadow service', circuit: 'Active classifier circuit', unused: 'No requests yet', closed: 'Closed', open: 'Open', half_open: 'Recovery trial pending',
    probe: 'Check connection & inference', enable: 'Enable shadow', disable: 'Disable & revert', refresh: 'Refresh status', busy: 'Working…',
    unsupported: 'This panel only checks local OpenDecision at 127.0.0.1 or [::1] with /v1/systemone. Manage other services through configuration.',
    probeHint: 'Checks send a built-in example, not chat history, and never invoke a paid model. Connectivity does not establish accuracy.',
    notChecked: 'Not checked in this run; service availability is unknown.', pass: 'Last check succeeded', fail: 'Last check failed', score: 'Score (not accuracy)',
    stats: 'Classifier statistics for this run (all services)', samples: 'Shadow samples', comparable: 'Comparable', agreement: 'Agreement', errors: 'Shadow errors',
    fallbackLlm: 'Successful LLM fallback', fallbackDefault: 'Default-chain fallback', noDefault: 'No default chain',
    note: 'Agreement only includes pairs of valid labels; agreement is not accuracy. Counters reset on restart. Refresh to update. Actions apply immediately.',
    safety: 'This panel cannot enable live routing. Disabling classification does not stop the independent service process.',
    failed: 'Operation failed', success: 'Updated', wait: 'seconds until a recovery trial',
  },
};

export function DecisionPanelView({ status, busy, message, available, lang = 'zh', onAction }) {
  const t = copy[lang] || copy.zh;
  const shadow = status?.metrics?.shadow || {};
  const decisions = status?.metrics?.decisions || {};
  const probe = status?.probe;
  const button = 'rounded-lg border border-zinc-300 dark:border-zinc-600 px-3 py-2 text-xs disabled:opacity-40 disabled:cursor-not-allowed';
  return <section className="tb-soft-card rounded-2xl overflow-hidden" aria-label={t.title}>
    <div className="px-5 py-4 border-b border-white/40 dark:border-white/[0.06]">
      <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t.title}</h2>
      <p className="text-xs text-gray-500 mt-1">{t.hint}</p>
    </div>
    <div className="p-5 space-y-3 text-sm text-zinc-700 dark:text-zinc-300">
      {!available ? <p>{t.desktop}</p> : <>
        <div className="flex flex-wrap items-center gap-3">
          <strong>{status ? t[status.mode] : t.loading}</strong>
          <button className={button} disabled={!!busy} onClick={() => onAction('refresh')}>{t.refresh}</button>
        </div>
        {status && <>
          <p className="text-xs break-all">{t.endpoint}: {status.endpoint}</p>
          <p className="text-xs">{t.circuit}: {t[status.circuit.state]}{status.circuit.retryAfterMs > 0 && ` · ${Math.ceil(status.circuit.retryAfterMs / 1000)} ${t.wait}`}</p>
          {!status.supported && <p className="text-xs text-amber-600 dark:text-amber-400">{t.unsupported}</p>}
          {status.mode === 'active' && <p className="text-xs break-all">{status.activeProvider}: {status.activeEndpoint}</p>}
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={!!busy || !status.supported} onClick={() => onAction('probe')}>{t.probe}</button>
            <button className={button} disabled={!!busy || !status.supported || status.mode === 'shadow'} onClick={() => onAction('shadow')}>{t.enable}</button>
            <button className={button} disabled={!!busy || status.mode === 'off'} onClick={() => onAction('off')}>{t.disable}</button>
          </div>
          <p className="text-xs text-gray-500">{t.probeHint}</p>
          <p className="text-xs">{!probe ? t.notChecked : <>
            {probe.ok ? t.pass : t.fail} · {probe.ms} ms · {new Date(probe.checkedAt).toLocaleString()}
            {probe.choice && ` · ${probe.choice}`}{probe.confidence != null && ` · ${t.score}: ${probe.confidence.toFixed(3)}`}
            {probe.error && ` · ${probe.error}`}
          </>}</p>
          <h3 className="text-xs font-semibold pt-2">{t.stats}</h3>
          <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {[[t.samples, shadow.total || 0], [t.comparable, shadow.comparable || 0],
              [t.agreement, shadow.comparable ? `${(100 * shadow.agreed / shadow.comparable).toFixed(1)}%` : '—'],
              [t.errors, shadow.errors || 0], [t.fallbackLlm, decisions.fallback_llm || 0],
              [t.fallbackDefault, decisions.fallback_default || 0], [t.noDefault, decisions.no_default_route || 0],
            ].map(([label, value]) => <div key={label}><dt className="text-gray-500">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}
          </dl>
          <p className="text-xs text-gray-500">{t.note}</p>
          <p className="text-xs text-gray-500">{t.safety}</p>
        </>}
      </>}
      <p role="status" aria-live="polite" className="text-xs">{busy ? t.busy : message}</p>
    </div>
  </section>;
}

export default function DecisionPanel() {
  const { lang } = useLang();
  const api = typeof window !== 'undefined' ? window.electronAPI?.decision : null;
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const t = copy[lang] || copy.zh;
  useEffect(() => {
    let mounted = true;
    if (api) api.status().then(s => { if (mounted) setStatus(s); })
      .catch(() => { if (mounted) setMessage(t.failed); });
    return () => { mounted = false; };
  }, [api, t.failed]);
  async function onAction(action) {
    if (!api || busy) return;
    setBusy(action); setMessage('');
    try {
      const result = action === 'refresh' ? null : action === 'probe' ? await api.probe() : await api.setMode(action);
      setStatus(await api.status());
      if (result?.ok === false) setMessage(`${t.failed}: ${result.error || 'unknown'}`);
      else if (action === 'shadow' || action === 'off') setMessage(t.success);
    } catch (e) { setMessage(`${t.failed}: ${e.message || 'unknown'}`); }
    finally { setBusy(''); }
  }
  return <DecisionPanelView {...{ status, busy, message, lang, onAction }} available={!!api} />;
}
