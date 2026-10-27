import React, { useCallback, useEffect, useState } from 'react';

// 与 electron/usage 注册表 SUPPORTED_KEYS 同步（groq 仅有吞吐指标，不在此展示）
const USAGE_SUPPORTED = new Set([
  'claude', 'codex', 'copilot', 'gemini', 'volcengine', 'volcengine-ark',
  'openrouter', 'deepseek', 'cursor', 'siliconflow',
  'kimi-code', 'minimax', 'zhipu', 'agnes-ai',
]);

/** 切 tab 会卸载/重挂用量卡；短缓存避免重复打钥匙串 / 重复拉额度 */
const USAGE_CACHE_TTL_MS = 60 * 1000;
/** 这些源的余额要读系统钥匙串，列表加载时不自动拉取，等用户点「查看余额」 */
const KEYCHAIN_ON_VIEW = new Set(['claude', 'cursor']);
const usageResultCache = new Map();
const usageInflight = new Map();
/** 同一账户的列表行和卡片共用结果：密码确认后两边一起出余额 */
const usageListeners = new Map();

function publishUsage(ck, next) {
  usageResultCache.set(ck, { state: next, at: Date.now() });
  const bucket = usageListeners.get(ck);
  if (bucket) bucket.forEach((fn) => fn(next));
}

/** 火山：Coding 订阅 vs 方舟按量（/api/v3/）分流 */
function volcUsageKeyFromBase(base) {
  const b = String(base || '').toLowerCase();
  if (!/volces\.com|volcengine/.test(b)) return null;
  // 按量推理：…/api/v3（无 coding 段）
  if (/\/api\/v3(?!.*coding)/.test(b) || /\/api\/v3\/?$/.test(b)) return 'volcengine-ark';
  if (/\/api\/coding\//.test(b)) return 'volcengine';
  return 'volcengine';
}

function usageKey(p) {
  const raw = p?.auth_type === 'oauth' && p?.oauth_provider ? p.oauth_provider : p?.id;
  const k = String(raw || '').toLowerCase();
  // 按量方舟须先于 volcengine 前缀匹配
  if (k === 'volcengine-ark' || k === 'ark-payg' || k === 'volcengine-payg') return 'volcengine-ark';
  // 订阅模板 / 别名 → 抓取器 key
  if (k === 'api-volcengine' || k === 'doubao' || k === 'ark') return 'volcengine';
  if (k === 'volcengine' || k.includes('doubao')) return 'volcengine';
  if (k.includes('volcengine') && !k.includes('ark')) return 'volcengine';
  if (k === 'api-kimi-code' || k === 'kimicode' || k === 'kimi_code') return 'kimi-code';
  if (k.includes('kimi-code') || k.includes('kimicode')) return 'kimi-code';
  if (k === 'api-minimax' || k === 'minimaxi') return 'minimax';
  if (k.includes('minimax')) return 'minimax';
  if (k === 'api-zhipu' || k === 'zhipuai' || k === 'bigmodel' || k === 'glm') return 'zhipu';
  if (k.includes('zhipu') || k.includes('bigmodel')) return 'zhipu';
  if (k === 'api-agnes' || k === 'api-agnes-ai' || k === 'agnes' || k === 'agnesai') return 'agnes-ai';
  if (k.includes('agnes')) return 'agnes-ai';
  // 自定义卡可能只带 ark / kimi / minimax / bigmodel / agnes base_url
  const base = String(p?.base_url || '').toLowerCase();
  const volcKey = volcUsageKeyFromBase(base);
  if (volcKey) return volcKey;
  if (/api\.kimi\.com\/coding/.test(base)) return 'kimi-code';
  if (/minimaxi?\.com|minimax\.io/.test(base)) return 'minimax';
  if (/bigmodel\.cn|api\.z\.ai/.test(base)) return 'zhipu';
  if (/agnes-ai\.(com|cn)/.test(base)) return 'agnes-ai';
  return raw;
}

function fmtReset(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!isFinite(ms)) return null;
  if (ms <= 0) return '即将重置';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d >= 1) return `${d}天${h % 24}小时后重置`;
  if (h >= 1) return `${h}小时${m % 60}分后重置`;
  return `${m}分钟后重置`;
}

function usageBarColor(p) {
  if (p >= 90) return 'bg-red-500';
  if (p >= 70) return 'bg-amber-500';
  return 'bg-blue-500';
}

/** 已用百分比文案：满额标「已用尽」 */
function fmtUsedPercent(pct, { exhaustedLabel = false } = {}) {
  if (pct == null || !Number.isFinite(Number(pct))) return '—';
  const n = Math.round(Number(pct));
  if (exhaustedLabel && n >= 100) return '已用尽';
  return `已用${n}%`;
}

function fmtBalance(c) {
  if (!c) return null;
  // 无限额度：展示已用花费（Agnes hard_limit 哨兵等）
  if (c.unlimited) {
    const used = c.used != null ? Number(c.used) : null;
    if (used != null && Number.isFinite(used)) {
      if (c.currency === 'CNY') {
        return `已用 ¥${used.toFixed(4).replace(/\.?0+$/, '')}`;
      }
      const sym = c.currency === 'USD' ? '$' : '';
      return `已用 ${sym}${used.toFixed(2)}`;
    }
    return '无限';
  }
  const v = c.remaining != null ? c.remaining : c.total;
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // CNY：与火山/硅基控制台一致，保留最多 4 位小数（去尾零）
  if (c.currency === 'CNY') {
    const s = n.toFixed(4).replace(/\.?0+$/, '');
    return `¥${s}`;
  }
  const sym = c.currency === 'USD' ? '$' : '';
  return `${sym}${n.toFixed(2)}`;
}

/** 有订阅计划/窗口配额 →「订阅额度」；纯余额按量 →「用量」 */
function usageMeterTitle(d) {
  if (d?.plan) return '订阅额度';
  const wins = d?.windows || [];
  if (wins.length > 0 && !d?.credits) return '订阅额度';
  return '用量';
}

function fmtFetchedAt(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return null;
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 5) return '刚刚更新';
  if (sec < 60) return `${sec} 秒前更新`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟前更新`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前更新`;
  return `${Math.floor(h / 24)} 天前更新`;
}

/**
 * 火山 AccessKey 编辑区（嵌在订阅额度卡片内）。
 * 已配置时默认收起输入框，只显示摘要行。
 */
function AccessKeyEditor({
  ak, sk, showSecret = false,
  onAkChange, onSkChange, onCommit,
  emptyHint = '填写 AccessKey 以查询 Coding Plan 额度',
}) {
  const configured = !!(ak && sk);
  const [editOpen, setEditOpen] = useState(!configured);
  return (
    <div className="pt-1.5 mt-1.5 border-t border-zinc-200/80 dark:border-zinc-700/60 space-y-1.5">
      <button
        type="button"
        onClick={() => setEditOpen(v => !v)}
        className="flex items-center justify-between w-full text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300"
      >
        <span>
          {configured
            ? `AccessKey 已配置（${String(ak).slice(0, 8)}…）`
            : emptyHint}
        </span>
        <span>{editOpen ? '收起' : '编辑'}</span>
      </button>
      {editOpen && (
        <>
          <input
            value={ak || ''}
            onChange={e => onAkChange?.(e.target.value)}
            onBlur={onCommit}
            type="text"
            placeholder="AccessKey ID（AKLT…）"
            autoComplete="off"
            className="w-full bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-blue-500"
          />
          <input
            value={sk || ''}
            onChange={e => onSkChange?.(e.target.value)}
            onBlur={onCommit}
            type={showSecret ? 'text' : 'password'}
            placeholder="Secret Access Key"
            autoComplete="off"
            className="w-full bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-700 rounded-lg px-2.5 py-1.5 text-xs text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-600 focus:outline-none focus:border-blue-500"
          />
        </>
      )}
    </div>
  );
}

/** 额度抓取（带 60s 缓存）：卡片与列表行内共用 */
function useUsageData(provider, accessKey = null) {
  const api = typeof window !== 'undefined' ? window.electronAPI?.usage : null;
  const k = usageKey(provider);
  const supported = USAGE_SUPPORTED.has(k) && !(k === 'gemini' && !provider?.credentials?.access_token);
  // api-volcengine 等别名 → 用抓取键 volcengine 查网关条目上的凭证
  const fetchId = (k && provider?.id && k !== provider.id && /^api-/i.test(provider.id))
    ? k
    : (provider?.id || k);
  const credFp = [
    provider?.token ? 't' : '',
    provider?.credentials?.access_key_id || '',
    provider?.credentials?.secret_access_key ? 'sk' : '',
    accessKey?.ak || '',
    accessKey?.sk ? 'sk2' : '',
  ].join('|');
  const [state, setState] = useState({ loading: false, data: null, error: '' });
  const load = useCallback((force = false, opts = {}) => {
    if (!api || !supported || !fetchId) return;
    const interactive = !!opts.interactive;
    const ck = `${fetchId}::${credFp}`;
    if (!force) {
      const hit = usageResultCache.get(ck);
      if (hit && Date.now() - hit.at < USAGE_CACHE_TTL_MS) {
        setState(hit.state);
        return;
      }
      // 钥匙串源：没有缓存就停在提示，不发请求
      if (opts.cacheOnly) return;
    }
    setState(s => ({ ...s, loading: true, error: '' }));
    // 同一账户的列表行与展开卡片同时挂载时只发一次请求
    let pending = !force && usageInflight.get(ck);
    if (!pending) {
      pending = api.fetch(fetchId, { interactive })
        .then(r => (r && r.error && !r.plan && !(r.windows || []).length && !r.credits
          ? { loading: false, data: null, error: r.error }
          : { loading: false, data: r, error: (r && r.error) || '' }))
        .catch(e => ({ loading: false, data: null, error: e?.message || String(e) }))
        .then(next => {
          usageInflight.delete(ck);
          publishUsage(ck, next);
          return next;
        });
      usageInflight.set(ck, pending);
    }
    pending.then(next => setState(next));
  }, [api, supported, fetchId, credFp]);
  useEffect(() => {
    if (!fetchId) return undefined;
    const ck = `${fetchId}::${credFp}`;
    let bucket = usageListeners.get(ck);
    if (!bucket) {
      bucket = new Set();
      usageListeners.set(ck, bucket);
    }
    bucket.add(setState);
    return () => {
      bucket.delete(setState);
      if (!bucket.size) usageListeners.delete(ck);
    };
  }, [fetchId, credFp]);
  useEffect(() => {
    if (KEYCHAIN_ON_VIEW.has(k)) {
      load(false, { cacheOnly: true });
      return;
    }
    load(false);
  }, [load, k]);
  return { api, supported, state, load };
}

/**
 * 供给源 / 直连 App 订阅卡片上的用量条。
 * accessKey：可选，火山 IAM 凭证与额度同卡展示。
 * defaultOpen：额度条默认是否展开（火山卡传 true）。
 */
export default function UsageMeter({
  provider,
  planHint = null,
  defaultOpen = false,
  accessKey = null, // { ak, sk, showSecret, onAkChange, onSkChange, onCommit }
}) {
  const { api, supported, state, load } = useUsageData(provider, accessKey);
  const [open, setOpen] = useState(!!defaultOpen);

  // 仅 AccessKey、无 usage API 时仍展示同卡编辑区
  if (!api || !supported) {
    if (!accessKey) return null;
    return (
      <div className="mt-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40 p-2.5">
        <AccessKeyEditor {...accessKey} />
      </div>
    );
  }

  const d = state.data;
  const k = usageKey(provider);
  const hasFigures = !!(d && (d.credits || d.primary || (d.windows || []).length));
  // 已有余额就直接展示；只有还没读到数据时才停在「查看余额」
  const awaitingUnlock = !state.error && !state.loading && !hasFigures
    && (KEYCHAIN_ON_VIEW.has(k) || !!d?.needsKeychain)
    && (!d || d.needsKeychain);
  // 站点标签已挪到 base_url 后；额度徽章去掉「（中国站/国际站）」避免截断
  const rawPlan = d?.plan || planHint || null;
  const planLabel = typeof rawPlan === 'string'
    ? (rawPlan.replace(/[（(]\s*(中国站|国际站)\s*[）)]/g, '').replace(/\s+/g, ' ').trim() || null)
    : rawPlan;
  const title = usageMeterTitle(planLabel ? { ...(d || {}), plan: planLabel } : d);
  const refreshed = fmtFetchedAt(d?.fetchedAt);
  const primary = d?.primary || (d?.windows || [])[0] || null;
  const summary = (() => {
    if (state.loading && !d) return '加载中…';
    if (state.error && !d) return state.error;
    const bal = d?.credits && fmtBalance(d.credits);
    // 有现金余额时优先展示（控制台「余额」口径），配额百分比并列
    if (bal && primary && primary.usageKnown) {
      return `${bal} · ${fmtUsedPercent(primary.usedPercent, { exhaustedLabel: true })}`;
    }
    if (bal) return bal;
    if (primary && primary.usageKnown) {
      return fmtUsedPercent(primary.usedPercent, { exhaustedLabel: true });
    }
    if (d?.warning && !(d.windows || []).length) return '暂不可用';
    if (!d) return '—';
    return null;
  })();
  const summaryWarn = !!(primary?.usageKnown && Number(primary.usedPercent) >= 90);

  if (awaitingUnlock) {
    return (
      <div className="mt-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">首次需要解锁钥匙串才能查看</p>
          <button type="button" onClick={() => load(true, { interactive: true })}
            className="text-xs text-blue-500 dark:text-blue-400 hover:underline shrink-0">
            查看余额
          </button>
        </div>
        {accessKey && <AccessKeyEditor {...accessKey} />}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-800/40 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0 text-left"
        >
          <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0">{title}</span>
          {planLabel && (
            <span
              title="订阅情况"
              className="text-[11px] px-1.5 py-0.5 rounded-md bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200/80 dark:border-amber-800/50 shrink-0"
            >
              {planLabel}
            </span>
          )}
          {!open && summary && (
            <span className={`text-[11px] tabular-nums truncate ${
              summaryWarn
                ? 'text-red-500 dark:text-red-400'
                : 'text-zinc-400 dark:text-zinc-500'
            }`}>
              {summary}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {refreshed && !state.loading && open && (
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">{refreshed}</span>
          )}
          <button type="button" onClick={() => load(true)} disabled={state.loading}
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 disabled:opacity-50">
            {state.loading ? '…' : '刷新'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          >
            {open ? '收起' : '展开'}
          </button>
        </div>
      </div>
      {open && (
        state.error && !d ? (
          <p className="text-xs text-red-500">{state.error}</p>
        ) : !d ? (
          <p className="text-xs text-zinc-400">{state.loading ? '加载中…' : '—'}</p>
        ) : (
          <div className="space-y-1.5">
            {state.error && (
              <p className="text-xs text-amber-600 dark:text-amber-400">{state.error}</p>
            )}
            {(d.windows || []).map(w => (
              <div key={w.id}>
                <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{w.title}</span>
                  <span className={`tabular-nums ${
                    w.usageKnown && Number(w.usedPercent) >= 90
                      ? 'text-red-500 dark:text-red-400'
                      : ''
                  }`}>
                    {w.usageKnown ? fmtUsedPercent(w.usedPercent, { exhaustedLabel: true }) : '—'}
                    {w.resetsAt ? <span className="ml-2 text-zinc-400 dark:text-zinc-600">{fmtReset(w.resetsAt)}</span> : null}
                  </span>
                </div>
                <div className="mt-0.5 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                  <div className={`h-full ${usageBarColor(w.usedPercent)} transition-[width] duration-200 ease-out`}
                    style={{ width: `${Math.min(100, Math.max(0, w.usedPercent))}%` }} />
                </div>
              </div>
            ))}
            {d.credits && fmtBalance(d.credits) && (
              <div className="space-y-0.5">
                <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400">
                  <span>{d.credits.unlimited ? '累计花费' : '余额'}</span>
                  <span className="tabular-nums">{fmtBalance(d.credits).replace(/^已用\s*/, '')}</span>
                </div>
                {/* 与控制台「剩余可透支额度」对齐 */}
                {d.credits.creditLimit != null && (
                  <div className="flex items-center justify-between text-[11px] text-zinc-400 dark:text-zinc-500">
                    <span>剩余可透支</span>
                    <span className="tabular-nums">¥{Number(d.credits.creditLimit).toFixed(4).replace(/\.?0+$/, '')}</span>
                  </div>
                )}
              </div>
            )}
            {d.metrics && (
              <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5">
                {d.metrics.requestsPerMin != null && (
                  <div className="flex justify-between"><span>请求/分</span><span className="tabular-nums">{d.metrics.requestsPerMin.toFixed(1)}</span></div>
                )}
                {d.metrics.tokensPerMin != null && (
                  <div className="flex justify-between"><span>Token/分</span><span className="tabular-nums">{Math.round(d.metrics.tokensPerMin)}</span></div>
                )}
                {d.metrics.cacheHitsPerMin != null && (
                  <div className="flex justify-between"><span>缓存命中/分</span><span className="tabular-nums">{d.metrics.cacheHitsPerMin.toFixed(1)}</span></div>
                )}
              </div>
            )}
            {d.extra && d.extra.enabled && (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 pt-0.5">
                额外用量 {d.extra.usedPercent != null ? fmtUsedPercent(d.extra.usedPercent, { exhaustedLabel: true }) : ''}
                {d.extra.monthlyLimit != null ? ` · 上限 $${d.extra.monthlyLimit}` : ''}
              </p>
            )}
            {d.warning && !(d.windows || []).length && (
              <p className="text-[11px] text-zinc-400 dark:text-zinc-500">额度暂不可用：{d.warning}</p>
            )}
          </div>
        )
      )}
      {/* AccessKey 与额度同卡：始终可见摘要，编辑区可收起 */}
      {accessKey && <AccessKeyEditor {...accessKey} />}
    </div>
  );
}

/** 直连 App 订阅 → UsageMeter 所需的虚拟 provider */
export function usageProviderForDirect(instance) {
  const sid = String(instance?.source_id || instance?.agent_id || '').toLowerCase();
  const name = String(instance?.name || instance?.label || '').toLowerCase();
  if (sid === 'cursor' || name.includes('cursor')) return { id: 'cursor' };
  if (sid === 'codex' || name.includes('codex')) {
    return { id: 'codex', auth_type: 'oauth', oauth_provider: 'codex' };
  }
  // Claude Desktop / Claude Code：走 Claude 用量抓取（OAuth 或 Desktop Cookie）
  if (
    sid === 'claude'
    || sid === 'claude-code'
    || sid === 'claude-desktop'
    || sid.includes('claude')
    || name.includes('claude')
  ) {
    return { id: 'claude', auth_type: 'oauth', oauth_provider: 'claude' };
  }
  return null;
}

/**
 * 列表行内的紧凑额度：细进度条 + 已用百分比 / 余额（不支持或无数据时不渲染）。
 * 与卡片共用抓取缓存，展开详情时不重复请求。
 */
export function UsageInline({ provider }) {
  const { api, supported, state, load } = useUsageData(provider);
  const k = usageKey(provider);
  if (!api || !supported) return null;
  const d = state.data;
  if (KEYCHAIN_ON_VIEW.has(k) && !d && !state.loading && !state.error) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">首次需要解锁钥匙串才能查看</span>
        <button type="button" onClick={() => load(true, { interactive: true })}
          className="text-[11px] text-blue-500 dark:text-blue-400 hover:underline">
          查看余额
        </button>
      </span>
    );
  }
  if (!d) {
    return state.loading
      ? <span className="inline-block w-10 h-1 rounded-full bg-zinc-200/80 dark:bg-zinc-700/80 animate-pulse align-middle" aria-hidden />
      : null;
  }
  const wins = (d.windows || []).filter(w => w.usageKnown);
  // 多窗口（5 小时 / 每周）取最紧的一条，避免行内堆叠
  const tight = wins.reduce((a, w) => (a == null || Number(w.usedPercent) > Number(a.usedPercent) ? w : a), null);
  const bal = d.credits && fmtBalance(d.credits);
  if (!tight && !bal) return null;
  const pct = tight ? Math.min(100, Math.max(0, Number(tight.usedPercent) || 0)) : null;
  const warn = pct != null && pct >= 90;
  const tip = [
    ...wins.map(w => `${w.title} ${fmtUsedPercent(w.usedPercent, { exhaustedLabel: true })}${w.resetsAt ? ` · ${fmtReset(w.resetsAt)}` : ''}`),
    bal ? `${d.credits.unlimited ? '累计花费' : '余额'} ${bal.replace(/^已用\s*/, '')}` : null,
  ].filter(Boolean).join('\n');
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0 tabular-nums" title={tip}>
      {pct != null && (
        <>
          <span className="relative inline-block w-12 h-1 rounded-full bg-zinc-200/90 dark:bg-zinc-700/80 overflow-hidden shrink-0" aria-hidden>
            <span className={`absolute inset-y-0 left-0 rounded-full ${usageBarColor(pct)}`} style={{ width: `${pct}%` }} />
          </span>
          <span className={warn ? 'text-red-500 dark:text-red-400' : ''}>
            {fmtUsedPercent(pct, { exhaustedLabel: true })}
            {wins.length > 1 && tight?.title ? <span className="text-zinc-400 dark:text-zinc-500"> · {tight.title}</span> : null}
          </span>
        </>
      )}
      {bal && <span className={pct != null ? 'text-zinc-400 dark:text-zinc-500' : ''}>{pct != null ? '· ' : ''}{bal}</span>}
    </span>
  );
}
