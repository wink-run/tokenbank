// 网关页底部「用接口接入」：页面顶部两个地址能做什么、认哪些协议、怎么调用。
// 接口没有单独的菜单，放在网关页里；用 Key 接入的应用就是「新建应用」，会出现在上面的列表里。
import React from 'react';
import { useLang } from '../store/lang';

function Path({ children }) {
  return <code className="font-mono text-[11px] px-1 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 break-all">{children}</code>;
}

export default function GatewayApiSection({ localBase = '' }) {
  const { t } = useLang();
  const base = String(localBase || 'http://127.0.0.1:11430/v1').replace(/\/$/, '');
  const curl = [
    `curl ${base}/chat/completions \\`,
    `  -H "Authorization: Bearer [${t('gateway.api.yourKey')}]" \\`,
    '  -H "Content-Type: application/json" \\',
    `  -d '{"model": "claude-sonnet-4-6", "messages": [{"role": "user", "content": "Hello"}]}'`,
  ].join('\n');
  return (
    <section aria-labelledby="gw-api-title" className="tb-soft-card rounded-2xl px-4 py-4 space-y-3 min-w-0">
      <h2 id="gw-api-title" className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{t('gateway.api.title')}</h2>
      <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{t('gateway.api.intro')}</p>
      <div className="grid gap-4 sm:grid-cols-2 min-w-0">
        <div className="space-y-1.5 min-w-0 text-xs text-zinc-700 dark:text-zinc-200">
          <div className="font-medium">{t('gateway.api.modelTitle')}</div>
          <div>{t('gateway.api.openai')} <Path>/v1/chat/completions</Path></div>
          <div>{t('gateway.api.anthropic')} <Path>/v1/messages</Path></div>
          <div>{t('gateway.api.codex')} <Path>/v1/responses</Path></div>
          <div>{t('gateway.api.models')} <Path>/v1/models</Path></div>
        </div>
        <div className="space-y-1.5 min-w-0 text-xs text-zinc-700 dark:text-zinc-200">
          <div className="font-medium">{t('gateway.api.agentTitle')}</div>
          <div>{t('gateway.api.agentList')} <Path>GET /v1/agent/harnesses</Path></div>
          <div>{t('gateway.api.agentRun')} <Path>POST /v1/agent/responses</Path></div>
          <div className="text-zinc-500 dark:text-zinc-400">{t('gateway.api.agentHint')}</div>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-200 mb-1">{t('gateway.api.example')}</div>
        <pre className="m-0 text-[11px] leading-relaxed font-mono rounded-xl bg-zinc-900 text-zinc-100 px-3 py-2.5 overflow-x-auto">{curl}</pre>
      </div>
    </section>
  );
}
