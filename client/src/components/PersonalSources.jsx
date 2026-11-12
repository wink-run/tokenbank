// 个人源体系 UI 组件集（账户统计 / 源模板库 / 个人源双视图 / 同步差异）。
// 数据来自 IPC getUserAccounts（billing-config）：account_stats / source_templates /
// direct_source_instances / sync_diff / user_subscriptions / user_payg_providers。
// 保存统一走父级传入的 onSave(patch)（= saveAccounts），写 source_template_overrides /
// direct_source_billing / user_payg_providers 等字段。
import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import { useLang } from '../store/lang';
import { useCurrency } from '../store/currency';
import { getGateway, isElectron } from '../api/adapter';
import ServiceIcon from './ServiceIcon';
import { resolveProviderBrandIcon } from '../lib/brandIcons';
import { speedDotClass, statusDotBucket } from '../lib/speed';
import { parseRoute } from '../lib/route-binding';
import { prefixModelRoutes } from '../lib/model-prefix-routes';
import UsageMeter, { usageProviderForDirect } from './UsageMeter';

// 服务质量(上次转发结果)：成功=绿 / 冷却=蓝 / 429=红 / 失败=红 / 无请求=灰。文字区分 429 与 失败。
export const healthDotClass = (h) => h == null ? 'bg-zinc-300 dark:bg-zinc-600'
  : h === 'cool' ? 'bg-sky-400'
  : h === 'ok' ? 'bg-green-500'
  : 'bg-red-500';
export const healthWordOf = (h) => h == null ? '无请求'
  : h === 'cool' ? '冷却中'
  : h === 'ok' ? '成功'
  : h === 'rate' ? '429'
  : '失败';
// hover 提示：说明这是"上次通过这个源转发请求"的结果，避免只看"成功/失败"不知含义。
export const healthTitle = (h) =>
  h == null ? '服务质量：还没通过这个源转发过请求'
  : h === 'cool' ? '冷却中：此供给源暂时不可用（配额/限流等）'
  : h === 'ok' ? '服务质量：上次转发成功（2xx）'
  : h === 'rate' ? '服务质量：上次被限流（429）'
  : '服务质量：上次转发失败';

/** 服务质量徽标：圆点 + 文字；冷却中优先于上次成功/失败，避免绿点误导。 */
export function QualityBadge({ health, note, cooling = false }) {
  const h = cooling ? 'cool' : health;
  return (
    <span className="relative group/q inline-flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full shrink-0 ${healthDotClass(h)}`} />
      <span className={cooling ? 'text-sky-600 dark:text-sky-400' : undefined}>{healthWordOf(h)}</span>
      <span className="pointer-events-none invisible opacity-0 group-hover/q:visible group-hover/q:opacity-100 transition-opacity absolute bottom-full right-0 mb-1 z-50 whitespace-nowrap rounded-md bg-zinc-900 text-white px-2 py-1 text-[10px] leading-tight shadow-lg font-normal">
        {healthTitle(h)}{note && !cooling ? `（${note}）` : ''}
      </span>
    </span>
  );
}

const INVALID_MODEL_NAMES = new Set(['_excluded_models', 'excluded_models']);

/** 探针目标 → 卡片上的裸模型名（paid:provider:model / paid:model 都能剥） */
function probeTargetBare(current) {
  const pr = parseRoute(current);
  return String(pr.model || current || '').trim().toLowerCase();
}

/** 模型名（字符串或 { name/id } 对象） */
function modelEntryName(m) {
  let n = '';
  if (typeof m === 'string') n = m.trim();
  else n = String(m?.name || m?.id || '').trim();
  return n && !INVALID_MODEL_NAMES.has(n) ? n : '';
}

/** 供给源 logo 去重键：同一 provider 多账户只显示一个图标 */
function providerDedupKey(inst) {
  const brand = resolveProviderBrandIcon({
    id: inst.source_id || inst.provider_id,
    name: inst.label || inst.name,
    base_url: inst.base_url,
    signup_url: inst.signup_url,
  });
  if (brand) return brand;
  return String(inst.source_id || inst.provider_id || inst.gateway_id || inst.id || '');
}

function dedupeByProvider(insts) {
  const seen = new Set();
  const out = [];
  for (const inst of insts) {
    const k = providerDedupKey(inst);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(inst);
  }
  return out;
}

/** 供给源 logo（紧凑图标，hover 显示名称） */
function SourceProviderLogo({ inst }) {
  const name = inst.name || inst.label || inst.source_id;
  return (
    <span title={name} className="inline-flex items-center justify-center w-4 h-4 shrink-0">
      <ServiceIcon
        id={inst.source_id || inst.provider_id}
        name={name}
        icon={inst.icon}
        baseUrl={inst.base_url}
        signupUrl={inst.signup_url}
        boxClass="w-4 h-4 !rounded !bg-transparent"
        imgClass="w-3.5 h-3.5"
      />
    </span>
  );
}

const PRICE_FIELDS = ['in', 'out', 'cacheRead'];

/** 从刊例价字段推断模态（图像模型仅有 image 价） */
export function inferModalityFromPricing(rates = {}) {
  if (!rates || typeof rates !== 'object') return 'chat';
  if (rates.image != null && rates.in == null && rates.out == null && rates.cacheRead == null) return 'image';
  return 'chat';
}

/** 各模态对应的刊例价字段 */
export function priceFieldsForModality(type) {
  if (type === 'image') return ['image'];
  if (type === 'embedding') return ['in', 'out'];
  return PRICE_FIELDS;
}

/** 计费表格列头/占位：图像按张，其余按百万 Token */
export function priceFieldLabel(field, type, t) {
  if (field === 'image') return t('providers.billing.priceImage');
  return field;
}

/** 模型模态短标签（文/图/嵌），供供给源页与路由下拉复用 */
export function modelTypeLabel(type, t) {
  if (type === 'image') return t('providers.models.typeImage');
  if (type === 'embedding') return t('providers.models.typeEmbedding');
  if (type === 'vision') return t('providers.models.typeVision');
  return t('providers.models.typeText');
}

export function modelTypeBtnClass(type) {
  if (type === 'image') {
    return 'bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-400 hover:bg-purple-200 dark:hover:bg-purple-800/60';
  }
  if (type === 'embedding') {
    return 'bg-teal-50 dark:bg-teal-900/20 text-teal-600 dark:text-teal-400 hover:bg-teal-100 dark:hover:bg-teal-900/40';
  }
  if (type === 'vision') {
    return 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/40';
  }
  return 'bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/40';
}

// ── 模型多时的整理：按厂商分组、去掉厂商前缀、日期/档位版本折叠到主模型下 ──
const MODEL_VENDORS = [
  ['DeepSeek', /^deepseek/i, /^deepseek[-_]?/i],
  ['豆包', /^(doubao|seed|ark|skylark)/i, /^doubao[-_]?/i],
  ['GLM', /^(glm|chatglm|cogview|cogvideo|charglm|codegeex)/i, /^glm[-_]?/i],
  ['OpenAI', /^(gpt|o\d|chatgpt|codex|dall-e|text-embedding|whisper|tts)/i, /^gpt[-_]?/i],
  ['Claude', /^claude/i, /^claude[-_]?/i],
  ['Gemini', /^(gemini|gemma|imagen)/i, /^gemini[-_]?/i],
  ['通义', /^(qwen|qwq|qvq|tongyi|wan)/i, /^qwen[-_]?/i],
  ['Kimi', /^(kimi|moonshot)/i, /^(kimi|moonshot)[-_]?/i],
  ['MiniMax', /^(minimax|abab|hailuo)/i, /^minimax[-_]?/i],
  ['Grok', /^grok/i, /^grok[-_]?/i],
  ['Llama', /^(llama|meta-llama)/i, null],
  ['Mistral', /^(mistral|mixtral|codestral|devstral|magistral)/i, null],
];

/** 模型归哪个厂商：org/model 写法按 org，其余按名字开头 */
export function modelVendor(name) {
  const raw = String(name || '').trim();
  const [org, rest] = raw.includes('/') ? raw.split('/', 2) : ['', raw];
  for (const [label, re] of MODEL_VENDORS) if (re.test(rest)) return label;
  if (org) return org.charAt(0).toUpperCase() + org.slice(1);
  return '其它';
}

/** 卡片上显示的短名：去掉 org/ 和厂商前缀（deepseek-v4-flash → v4-flash） */
export function modelShortName(name) {
  const raw = String(name || '').trim();
  const rest = raw.includes('/') ? raw.split('/').slice(1).join('/') : raw;
  for (const [, re, strip] of MODEL_VENDORS) {
    if (re.test(rest) && strip) {
      const short = rest.replace(strip, '');
      return short || rest;
    }
  }
  return rest;
}

/** 日期、档位版本归到哪个主模型（deepseek-v4-flash-ga-260731 → deepseek-v4-flash） */
export function modelBaseName(name) {
  let n = String(name || '').trim();
  for (let i = 0; i < 3; i++) {
    const next = n
      .replace(/[-_@](\d{4}-\d{2}-\d{2}|\d{6,8})$/, '')
      .replace(/[-_](ga|economy|eco|preview|latest|exp|beta|turbo-\d+)$/i, '');
    if (next === n) break;
    n = next;
  }
  return n;
}

/** 模型名旁的来源标记：同步 = 服务端目录；手工 = 本地添加或改过 */
function ModelOriginBadge({ origin, t }) {
  if (origin !== 'manual' && origin !== 'synced') return null;
  const manual = origin === 'manual';
  return (
    <span
      title={t(manual ? 'providers.billing.originManualTip' : 'providers.billing.originSyncedTip')}
      className={`ml-1.5 inline-block align-middle whitespace-nowrap font-sans text-[10px] leading-none px-1 py-0.5 rounded ${
        manual
          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
          : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
      }`}
    >
      {t(manual ? 'providers.billing.originManual' : 'providers.billing.originSynced')}
    </span>
  );
}

/** 计费表格（模型 → 模态相关刊例价字段）。图像：image（$/张）；对话：in/out/cacheRead；嵌入：in/out。 */
export const PricingTable = memo(function PricingTable({
  rows, onCell, onAddModel, onRemoveModel, t,
  withModality = false, modelTypes = {}, onToggleType,
}) {
  const [newModel, setNewModel] = useState('');
  const [inputType, setInputType] = useState('chat');
  // 编辑中用本地 draft，避免父级轮询/乐观更新打断输入导致闪动
  const [draft, setDraft] = useState({});   // 'model:field' → 编辑中的原始字符串
  const keyOf = (m, f) => `${m}:${f}`;
  const cellVal = (m, f, num) => {
    const k = keyOf(m, f);
    return draft[k] !== undefined ? draft[k] : (num ?? '');
  };
  const onInput = (m, f, str) => setDraft(d => ({ ...d, [keyOf(m, f)]: str }));
  const onCommit = (m, f, str) => {
    setDraft(d => { const n = { ...d }; delete n[keyOf(m, f)]; return n; });
    onCell(m, f, str);
  };
  const resolveType = (name, row) => modelTypes[name] || row?.type || 'chat';

  // 带模态：每行按类型渲染不同价格列（与服务端 admin 表单一致）
  if (withModality) {
    return (
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="min-w-[17rem] space-y-1.5">
          <div className="flex gap-1.5 text-[10px] text-zinc-400 px-0.5">
            <span className="flex-1 min-w-0">{t('psrc.model')}</span>
            <span className="w-7 text-center shrink-0">{t('providers.models.modalityCol')}</span>
            <span className="flex-[3] text-right">{t('providers.billing.priceCol')}</span>
            <span className="w-4 shrink-0" />
          </div>
          {rows.length === 0 && (
            <p className="text-xs text-zinc-400 py-1.5 text-center">{t('psrc.noModels')}</p>
          )}
          {rows.map(r => {
            const mType = resolveType(r.model, r);
            const fields = priceFieldsForModality(mType);
            return (
              <div key={r.model} className={`flex gap-1.5 items-start ${r._override ? 'bg-amber-50/50 dark:bg-amber-900/10 rounded px-0.5 py-0.5' : ''}`}>
                <span className="flex-1 min-w-0 text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all leading-snug px-0.5 py-0.5" title={r.model}>
                  {r.model}
                  <ModelOriginBadge origin={r._origin} t={t} />
                </span>
                {onToggleType && (
                  <button
                    type="button"
                    onClick={() => onToggleType(r.model)}
                    title={t('providers.models.toggleType')}
                    className={`shrink-0 w-7 h-6 flex items-center justify-center text-[10px] font-sans rounded border border-zinc-200 dark:border-zinc-700 transition-colors ${modelTypeBtnClass(mType)}`}
                  >
                    {modelTypeLabel(mType, t)}
                  </button>
                )}
                <div className="flex flex-1 gap-1 min-w-0 justify-end">
                  {fields.map(f => (
                    <input
                      key={f}
                      type="text"
                      inputMode="decimal"
                      value={cellVal(r.model, f, r[f])}
                      placeholder={priceFieldLabel(f, mType, t)}
                      title={priceFieldLabel(f, mType, t)}
                      onChange={e => onInput(r.model, f, e.target.value)}
                      onBlur={e => onCommit(r.model, f, e.target.value)}
                      className="text-xs text-right bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1 py-1 w-full min-w-[2.5rem] max-w-[4.5rem] tabular-nums"
                    />
                  ))}
                </div>
                {onRemoveModel
                  ? <button type="button" onClick={() => onRemoveModel(r.model)} className="shrink-0 text-xs text-red-400 hover:text-red-500 pt-1 w-4">×</button>
                  : <span className="w-4 shrink-0" />}
              </div>
            );
          })}
          {onAddModel && (
            <div className="flex flex-wrap gap-1.5 pt-1 items-center">
              <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder={t('psrc.addModelPh')}
                className="flex-1 min-w-[8rem] text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 font-mono" />
              <select value={inputType} onChange={e => setInputType(e.target.value)}
                className="shrink-0 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-1 text-zinc-700 dark:text-zinc-300">
                <option value="chat">{t('providers.models.typeText')}</option>
                <option value="vision">{t('providers.models.typeVision')}</option>
                <option value="image">{t('providers.models.typeImage')}</option>
                <option value="embedding">{t('providers.models.typeEmbedding')}</option>
              </select>
              <button type="button" disabled={!newModel.trim()}
                onClick={() => {
                  if (newModel.trim()) {
                    onAddModel(newModel.trim(), inputType);
                    setNewModel('');
                  }
                }}
                className="shrink-0 text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-700 disabled:opacity-50 whitespace-nowrap">
                + {t('providers.models.add')}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const rowGrid = 'grid-cols-[minmax(0,1fr)_repeat(3,minmax(2.5rem,3rem))_1.25rem]';

  return (
    <div className="overflow-x-auto -mx-1 px-1">
      <div className={`min-w-[17rem] space-y-1.5 ${withModality ? 'min-w-[20rem]' : ''}`}>
      <div className={`grid ${rowGrid} gap-x-1.5 gap-y-0.5 text-[10px] text-zinc-400 px-0.5`}>
        <span className="min-w-0">{t('psrc.model')}</span>
        {withModality && <span className="text-center">{t('providers.models.modalityCol')}</span>}
        {PRICE_FIELDS.map(f => <span key={f} className="text-right tabular-nums">{f}</span>)}
        <span />
      </div>
      {rows.length === 0 && (
        <p className="text-xs text-zinc-400 py-1.5 text-center">{t('psrc.noModels')}</p>
      )}
      {rows.map(r => {
        const mType = resolveType(r.model, r);
        return (
          <div key={r.model} className={`grid ${rowGrid} gap-x-1.5 gap-y-0.5 items-start ${r._override ? 'bg-amber-50/50 dark:bg-amber-900/10 rounded px-0.5 py-0.5' : ''}`}>
            <span
              className="text-xs font-mono text-zinc-700 dark:text-zinc-300 break-all leading-snug px-0.5 py-0.5 min-w-0"
              title={r.model}
            >
              {r.model}
              <ModelOriginBadge origin={r._origin} t={t} />
            </span>
            {withModality && onToggleType && (
              <button
                type="button"
                onClick={() => onToggleType(r.model)}
                title={t('providers.models.toggleType')}
                className={`shrink-0 w-7 h-6 flex items-center justify-center text-[10px] font-sans rounded border border-zinc-200 dark:border-zinc-700 transition-colors ${modelTypeBtnClass(mType)}`}
              >
                {modelTypeLabel(mType, t)}
              </button>
            )}
            {PRICE_FIELDS.map(f => (
              <input key={f} type="text" inputMode="decimal" value={cellVal(r.model, f, r[f])} placeholder="—"
                onChange={e => onInput(r.model, f, e.target.value)}
                onBlur={e => onCommit(r.model, f, e.target.value)}
                className="text-xs text-right bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1 py-1 w-full tabular-nums min-w-0" />
            ))}
            {onRemoveModel
              ? <button type="button" onClick={() => onRemoveModel(r.model)} className="text-xs text-red-400 hover:text-red-500 pt-1">×</button>
              : <span />}
          </div>
        );
      })}
      {onAddModel && (
        <div className="flex flex-wrap gap-1.5 pt-1 items-center">
          <input value={newModel} onChange={e => setNewModel(e.target.value)} placeholder={t('psrc.addModelPh')}
            className="flex-1 min-w-[8rem] text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 font-mono" />
          {withModality && (
            <select value={inputType} onChange={e => setInputType(e.target.value)}
              className="shrink-0 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-1.5 py-1 text-zinc-700 dark:text-zinc-300">
              <option value="chat">{t('providers.models.chat')}</option>
              <option value="image">{t('providers.models.image')}</option>
              <option value="embedding">{t('providers.models.embedding')}</option>
            </select>
          )}
          <button type="button" disabled={!newModel.trim()}
            onClick={() => {
              if (newModel.trim()) {
                onAddModel(newModel.trim(), withModality ? inputType : undefined);
                setNewModel('');
              }
            }}
            className="shrink-0 text-xs px-2 py-1 rounded bg-zinc-100 dark:bg-zinc-700 disabled:opacity-50 whitespace-nowrap">
            + {withModality ? t('providers.models.add') : t('psrc.add')}
          </button>
        </div>
      )}
      </div>
    </div>
  );
}, (prev, next) => (
  // 忽略回调引用变化：父级延迟轮询重渲染时不应打断输入 draft
  prev.rows === next.rows
  && prev.withModality === next.withModality
  && prev.modelTypes === next.modelTypes
  && prev.t === next.t
  && !!prev.onAddModel === !!next.onAddModel
  && !!prev.onRemoveModel === !!next.onRemoveModel
  && !!prev.onToggleType === !!next.onToggleType
));

// ── 第1块：账户统计 ────────────────────────────────────────────────────────────
export function AccountStatsView({ data, t, filter = 'all', onFilter }) {
  const stats = data?.account_stats || { subscription: 0, api: 0, total: 0 };
  const subs = data?.user_subscriptions || [];
  const payg = data?.user_payg_providers || [];
  const direct = data?.direct_source_instances || [];
  // 直连源按各自计费类型并入订阅 / API 两类（与 accountStats 统计一致）
  const directSubs = direct.filter(d => d.mode !== 'api');
  const directApi = direct.filter(d => d.mode === 'api');
  // 点统计方块 = 按订阅/API 粗筛；再点已选的取消回「全部」
  const card = (key, label, n, color, ring, hint) => {
    const active = filter === key;
    const clickable = !!onFilter;
    return (
      <div
        role={clickable ? 'button' : undefined}
        onClick={clickable ? () => onFilter(active ? 'all' : key) : undefined}
        className={`flex-1 rounded-2xl border p-4 transition ${color} ${clickable ? 'cursor-pointer hover:opacity-90' : ''} ${active ? ring : ''}`}>
        <div className="text-3xl font-bold tabular-nums">{n}</div>
        <div className="text-sm font-medium mt-1">{label}</div>
        {hint && <div className="text-xs opacity-70 mt-0.5">{hint}</div>}
      </div>
    );
  };
  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        {card('subscription', t('psrc.stat.subscription'), stats.subscription,
          'border-amber-200 dark:border-amber-800/40 bg-amber-50/50 dark:bg-amber-900/10 text-amber-700 dark:text-amber-300',
          'ring-2 ring-amber-400',
          t('psrc.stat.hintCount', { added: subs.length, direct: directSubs.length }))}
        {card('api', t('psrc.stat.api'), stats.api,
          'border-emerald-200 dark:border-emerald-800/40 bg-emerald-50/50 dark:bg-emerald-900/10 text-emerald-700 dark:text-emerald-300',
          'ring-2 ring-emerald-400',
          t('psrc.stat.hintCount', { added: payg.length, direct: directApi.length }))}
      </div>
    </div>
  );
}

/** 可折叠「模型和计费」区块，默认收起 */
// 冷却展示辅助：reason → 图标/配色/标签；剩余时长/恢复时刻格式化。
// reset 感知(冷到确切重置点)用蓝雪花；退避档(鉴权/欠费/限流)用橙时钟。
const COOLDOWN_META = {
  'quota-reset': { icon: '❄', blue: true,  label: 'psrc.cooldown.reason.quota',    resetAware: true },
  quota:         { icon: '❄', blue: true,  label: 'psrc.cooldown.reason.quota' },
  'rate-limit':  { icon: '⚡', blue: false, label: 'psrc.cooldown.reason.rateLimit' },
  transient:     { icon: '⚡', blue: false, label: 'psrc.cooldown.reason.rateLimit' },
  auth:          { icon: '⏱', blue: false, label: 'psrc.cooldown.reason.auth' },
  credit:        { icon: '⏱', blue: false, label: 'psrc.cooldown.reason.credit' },
};
export function cooldownMeta(reason) { return COOLDOWN_META[reason] || COOLDOWN_META.quota; }
export function fmtCooldownRemain(untilMs, t) {
  const ms = untilMs - Date.now();
  if (ms <= 0) return t('psrc.cooldown.soon');
  const m = Math.round(ms / 60000);
  if (m < 1)  return t('psrc.cooldown.lt1min');
  if (m < 60) return t('psrc.cooldown.mins', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('psrc.cooldown.hours', { n: h });
  return t('psrc.cooldown.days', { n: Math.round(h / 24) });
}
export function fmtCooldownUntil(untilMs) {
  const d = new Date(untilMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 折叠态：跟在计费摘要后的一小段冷却文字（+重试链接）。
export function CooldownInline({ cooldown, t, onRetry }) {
  if (!cooldown) return null;
  const m = cooldownMeta(cooldown.reason);
  const color = m.blue ? 'text-blue-600 dark:text-blue-400' : 'text-amber-600 dark:text-amber-400';
  return (
    <>
      <span className="text-[11px] text-zinc-400">·</span>
      <span className={`text-[11px] inline-flex items-center gap-1 ${color}`}>
        <span aria-hidden>{m.icon}</span>
        {t('psrc.cooldown.chip', { reason: t(m.label), remain: fmtCooldownRemain(cooldown.until, t) })}
      </span>
      {onRetry && (
        <button type="button" onClick={(e) => { e.stopPropagation(); onRetry(cooldown.key); }}
          className="text-[11px] text-blue-500 hover:text-blue-600 dark:text-blue-400">{t('psrc.cooldown.retry')}</button>
      )}
    </>
  );
}

// 展开态：刊例价表格上方的冷却详情块。
function CooldownDetail({ cooldown, t, onRetry }) {
  if (!cooldown) return null;
  const m = cooldownMeta(cooldown.reason);
  const bg = m.blue ? 'bg-blue-50 dark:bg-blue-900/20' : 'bg-amber-50 dark:bg-amber-900/20';
  const fg = m.blue ? 'text-blue-700 dark:text-blue-300' : 'text-amber-700 dark:text-amber-300';
  return (
    <div className={`rounded-lg px-3 py-2.5 ${bg}`}>
      <div className="flex items-center justify-between gap-2">
        <div className={`flex items-center gap-1.5 text-xs font-medium ${fg}`}>
          <span aria-hidden>{m.icon}</span>
          <span>{t('psrc.cooldown.detailTitle', { reason: t(m.label) })}</span>
          {m.resetAware && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-800/40">{t('psrc.cooldown.resetAware')}</span>}
        </div>
        {onRetry && (
          <button type="button" onClick={() => onRetry(cooldown.key)}
            className="text-[11px] px-2 py-1 rounded-md border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 shrink-0">
            {t('psrc.cooldown.retryNow')}
          </button>
        )}
      </div>
      <div className={`text-[11px] mt-1.5 leading-relaxed ${m.blue ? 'text-blue-600 dark:text-blue-400' : 'text-amber-600 dark:text-amber-400'}`}>
        {t('psrc.cooldown.recoverAt', { time: fmtCooldownUntil(cooldown.until), remain: fmtCooldownRemain(cooldown.until, t) })}
        {cooldown.note && <><br />{t('psrc.cooldown.lastError')}: <span className="text-rose-500 dark:text-rose-400 break-all">{cooldown.note}</span></>}
      </div>
    </div>
  );
}

export function CollapsibleBillingPanel({ hint, summary, t, children, cooldown = null, onRetryCooldown = null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{t('providers.billing.section')}</span>
          {!open && summary && (
            <span className="text-[11px] text-zinc-400 truncate">{summary}</span>
          )}
          {!open && <CooldownInline cooldown={cooldown} t={t} onRetry={onRetryCooldown} />}
        </div>
        <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
          className="tb-press text-xs px-2.5 py-1 rounded-lg border border-zinc-300/80 dark:border-zinc-700 bg-white/50 dark:bg-zinc-800/60 backdrop-blur-sm text-zinc-600 dark:text-zinc-400 hover:bg-white/80 dark:hover:bg-zinc-700/80 transition-colors shrink-0">
          {open ? t('providers.models.collapse') : t('providers.models.expand')}
        </button>
      </div>
      {open && (
        <div className="space-y-3 mt-3">
          <CooldownDetail cooldown={cooldown} t={t} onRetry={onRetryCooldown} />
          {hint && <p className="text-[11px] text-zinc-400">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

// ── 第3块：直连源卡（与其它供给源卡片同风格，编辑自动保存）────────────────────────
export function DirectSourceCard({
  instance, onSave, onRemove, allowApiBilling = false, canConvertToApi = false, onConvertToApi, t,
  cooldown = null, onRetryCooldown = null,
}) {
  const baseMonthly = instance.monthly_usd != null ? String(instance.monthly_usd) : '';
  const basePricing = instance.pricing || {};
  const baseApi = allowApiBilling && instance.mode === 'api';
  const [monthly, setMonthly] = useState(baseMonthly);
  const [pricing, setPricing] = useState(basePricing);
  const [isApi, setIsApi] = useState(baseApi);
  const [removing, setRemoving] = useState(false);
  const [converting, setConverting] = useState(false);
  const saveTimer = useRef(null);
  const savingRef = useRef(false);

  const sig = `${baseMonthly}|${JSON.stringify(basePricing)}|${baseApi}`;
  const sigRef = useRef(sig);
  useEffect(() => {
    if (sigRef.current === sig) return;
    sigRef.current = sig;
    if (savingRef.current) return;
    setMonthly(baseMonthly);
    setPricing(basePricing);
    setIsApi(baseApi);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  useEffect(() => {
    if (!allowApiBilling && isApi) setIsApi(false);
  }, [allowApiBilling, isApi]);

  const rows = Object.keys(pricing).map(m => ({ model: m, ...pricing[m] }));
  const hasPricing = !!instance.has_pricing;
  // Cursor 等不可转 API 的 App 订阅：仅说明直连官方，不单独罗列模型名
  const isDirectAppSub = !canConvertToApi && !isApi;

  function buildPatch(m, p, a) {
    const num = m.trim() === '' ? null : Number(m);
    const billing = { ...(instance._allBilling || {}) };
    billing[instance.agent_id] = {
      ...(billing[instance.agent_id] || {}),
      mode: (allowApiBilling && a) ? 'api' : 'subscription',
      monthly_usd: (num != null && Number.isFinite(num)) ? num : null,
      pricing: allowApiBilling && a ? p : {},
    };
    return { direct_source_billing: billing };
  }

  const flushSave = async (m, p, a) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    savingRef.current = true;
    try { await onSave(buildPatch(m, p, a)); }
    finally { savingRef.current = false; }
  };

  const scheduleSave = (m, p, a) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => flushSave(m, p, a), 400);
  };

  const onCell = (model, field, val) => {
    const next = { ...pricing, [model]: { ...(pricing[model] || {}) } };
    if (val === '' || val == null) delete next[model][field];
    else { const num = Number(val); if (Number.isFinite(num)) next[model][field] = num; }
    setPricing(next);
    scheduleSave(monthly, next, isApi);
  };
  const onAddModel = (m) => {
    if (pricing[m]) return;
    const next = { ...pricing, [m]: {} };
    setPricing(next);
    scheduleSave(monthly, next, isApi);
  };
  const onRemoveModel = (m) => {
    const next = { ...pricing };
    delete next[m];
    setPricing(next);
    scheduleSave(monthly, next, isApi);
  };

  const doRemove = async () => {
    if (!onRemove) return;
    setRemoving(true);
    try { await onRemove(instance); }
    finally { setRemoving(false); }
  };

  const doConvert = async () => {
    if (!onConvertToApi) return;
    setConverting(true);
    try { await onConvertToApi(instance); }
    finally { setConverting(false); }
  };

  const toggleMode = () => {
    const nv = !isApi;
    setIsApi(nv);
    flushSave(monthly, pricing, nv);
  };

  const billingSummary = (() => {
    const parts = [];
    if (!isApi && monthly.trim()) parts.push(`$${monthly.trim()}${t('psrc.direct.monthlyUnit')}`);
    if (allowApiBilling && isApi && rows.length) parts.push(t('providers.billing.modelCount', { n: rows.length }));
    return parts.join(' · ') || null;
  })();

  // Cursor / Codex 等直连 App：读订阅与 session 额度（Codex 走非官方订阅登录凭证）
  const usageProvider = usageProviderForDirect(instance);

  return (
    <div className="tb-soft-tile rounded-2xl overflow-hidden">
      <div className="flex items-start gap-3 p-3.5">
        <div className="w-8 h-8 rounded-lg bg-zinc-100/70 dark:bg-zinc-800/70 backdrop-blur-sm flex items-center justify-center text-[15px] shrink-0 mt-0.5">
          <ServiceIcon id={instance.source_id} name={instance.label} icon={instance.icon} baseUrl={instance.base_url} signupUrl={instance.signup_url} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{instance.name}</span>
              <span className="inline-flex items-center justify-center w-5 h-5 rounded-md border shrink-0 bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800/50" title={t('providers.filter.appSub')}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" className="w-3 h-3" aria-hidden>
                  <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
                  <circle cx="8" cy="8" r="2" />
                </svg>
              </span>
            </div>
            {onRemove && (
              <button type="button" onClick={doRemove} disabled={removing}
                title={t('providers.custom.removeTitle')}
                className="text-zinc-400 hover:text-red-500 dark:hover:text-red-400 text-lg leading-none transition-colors disabled:opacity-40 shrink-0">×</button>
            )}
          </div>
          {!hasPricing && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">⚠ {t('psrc.direct.noPricing')}</p>
          )}
          {canConvertToApi && onConvertToApi && (
            <div className="mt-2">
              <button type="button" onClick={doConvert} disabled={converting || removing}
                className="text-xs px-2.5 py-1 rounded-lg border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40">
                {converting ? t('psrc.direct.converting') : t('psrc.direct.convertToApi')}
              </button>
            </div>
          )}
          {usageProvider && <UsageMeter provider={usageProvider} />}
        </div>
      </div>

      <CollapsibleBillingPanel
        t={t}
        summary={billingSummary}
        cooldown={cooldown}
        onRetryCooldown={onRetryCooldown}
        hint={isDirectAppSub ? t('psrc.direct.officialModelsHint') : (isApi ? t('psrc.direct.apiTitle') : t('psrc.direct.subTitle'))}
      >
        <div className="flex flex-wrap items-center gap-2">
          {!isApi && (
            <>
              <span className="text-xs text-zinc-400">$</span>
              <input type="text" inputMode="decimal" value={monthly} placeholder="0"
                onChange={e => setMonthly(e.target.value)}
                onBlur={() => flushSave(monthly, pricing, isApi)}
                className="w-24 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1 tabular-nums" />
              <span className="text-xs text-zinc-400">{t('psrc.direct.monthlyUnit')}</span>
            </>
          )}
          {allowApiBilling && (
            <button type="button" onClick={toggleMode}
              className={`text-xs ${isApi ? '' : 'ml-auto'} text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300`}>
              {isApi ? t('psrc.direct.switchSub') : t('psrc.direct.switchApi')}
            </button>
          )}
        </div>
        {allowApiBilling && isApi && (
          <PricingTable rows={rows} onCell={onCell} onAddModel={onAddModel} onRemoveModel={onRemoveModel} t={t} />
        )}
      </CollapsibleBillingPanel>
    </div>
  );
}

// ── 第3块：供给源实例卡（图标/名称与统计一致，可删除）────────────────────────────
export function UnenrolledInstanceCard({ instance, onRemove, t }) {
  const i = instance;
  return (
    <div className="tb-soft-tile flex items-center gap-2 px-3 py-2 rounded-xl">
      <ServiceIcon id={i.source_id} name={i.label} icon={i.icon} baseUrl={i.base_url} signupUrl={i.signup_url} />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300 truncate">{i.name}</div>
        <div className="text-[10px] text-zinc-400 truncate">
          {i.billing_type === 'api'
            ? `${t('psrc.stat.api')}${i.models?.length ? ` · ${i.models.length} ${t('psrc.unenrolled.models')}` : ''}`
            : `${t('psrc.stat.subscription')}${i.plan_label ? ` · ${i.plan_label}` : ''}${i.monthly_usd != null ? ` · $${i.monthly_usd}/mo` : ''}`}
        </div>
      </div>
      {onRemove && (
        <button type="button" onClick={() => onRemove(i)} title={t('psrc.tpl.removeInstance')}
          className="shrink-0 text-zinc-400 hover:text-red-500 text-lg leading-none px-1">×</button>
      )}
    </div>
  );
}

/** 账户实例可能对应的网关 provider_id（与 local-stats 落账字段对齐） */
function accountProviderIds(inst) {
  const raw = [
    inst.gateway_id,
    inst.provider_id,
    inst.source_id,
    inst.id,
    inst.id ? `acct-${String(inst.id).replace(/^acct-/, '')}` : null,
  ].filter(Boolean);
  return [...new Set(raw.map(String))];
}

/** 在延迟表里查找模型（兼容大小写 / 带前缀别名） */
function providerLatencyMap(latencyMap, model) {
  if (!latencyMap || !model) return null;
  if (latencyMap[model]) return latencyMap[model];
  const lower = model.toLowerCase();
  for (const key of Object.keys(latencyMap)) {
    if (key.toLowerCase() === lower) return latencyMap[key];
    if (key.endsWith(`/${model}`) || key.endsWith(`/${lower}`)) return latencyMap[key];
  }
  return null;
}

/** 读取某模型在某账户上的最近延迟/健康（失败也要显示，不能当成无请求） */
function resolveAccountLatencyRow(latencyMap, model, inst) {
  const pmap = providerLatencyMap(latencyMap, model);
  if (!pmap) return null;
  let best = null;
  for (const pid of accountProviderIds(inst)) {
    const row = pmap[pid];
    if (!row) continue;
    const ts = row.last_ts || 0;
    const code = row.last_status_code ?? null;
    const ok = code >= 200 && code < 300;
    const rawTtft = row.last_ttft_ms > 0 ? row.last_ttft_ms : (row.avg_ttft_ms > 0 ? row.avg_ttft_ms : 0);
    const ttft = ok && rawTtft > 0 ? rawTtft : 0;
    if (!ok && code == null && ttft <= 0) continue;
    if (!best || ts > best.ts) {
      best = {
        ts, ttft: ttft > 0 ? ttft : null, statusCode: code,
        avgTtft: row.avg_ttft_ms > 0 ? row.avg_ttft_ms : (ttft > 0 ? ttft : null),
        calls: row.calls || 0,
        success: row.success || 0,
      };
    }
  }
  return best;
}

/** status_code → 健康档：2xx=ok / 429=rate / 其它=fail / 无=null */
export function healthFromStatus(code) {
  if (code == null) return null;
  if (code >= 200 && code < 300) return 'ok';
  if (code === 429) return 'rate';
  return 'fail';
}


function accountDisplayName(inst) {
  return inst.name || inst.label || inst.plan_label || inst.source_id || inst.gateway_id || inst.provider_id || '—';
}

// ── 第3块：按模型视图（仿社区源 P2P 网格：一行两列，左模型、右供给源 logo）────────
/** 能写进场景步的网关供给源 id。直连账户没有这个 id，不能被指定。 */
function sourceChainId(inst) {
  return String(inst?.gateway_id || '').trim();
}

/** 默认降级顺序：订阅，然后免费，然后按量。和网关 costRank 同一档。 */
function sourceBillingRank(inst) {
  const tag = String(inst?.tag || inst?.kind || '');
  if (tag === 'api_sub' || tag === 'sub_to_api' || tag === 'app_sub' || tag === 'sub') return 0;
  if (tag === 'free') return 1;
  return 2;
}

function orderChainSources(srcs, route, head, latencyOf) {
  const auto = [...(srcs || [])].sort((a, b) => {
    const rank = sourceBillingRank(a) - sourceBillingRank(b);
    if (rank) return rank;
    const ta = latencyOf?.(a);
    const tb = latencyOf?.(b);
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    return accountDisplayName(a).localeCompare(accountDisplayName(b));
  });
  // 只有钉了账户的步骤才打乱默认序；「自动」步不带 provider
  const saved = (route?.steps || [])
    .filter(s => s?.provider && (!s.model || s.model === head))
    .map(s => s.provider);
  if (!saved.length) return auto;
  const byId = new Map();
  for (const inst of auto) {
    const id = sourceChainId(inst);
    if (id && !byId.has(id)) byId.set(id, inst);
  }
  const ordered = [];
  const used = new Set();
  for (const id of saved) {
    const inst = byId.get(id);
    if (!inst || used.has(id)) continue;
    ordered.push(inst);
    used.add(id);
  }
  for (const inst of auto) {
    const id = sourceChainId(inst);
    if (id && used.has(id)) continue;
    ordered.push(inst);
    if (id) used.add(id);
  }
  return ordered;
}

/** 一条可排序的链：供给源和追加的模型混在一起，顺序就是场景步骤顺序。 */
function buildChainItems(srcs, route, head, latencyOf) {
  const auto = orderChainSources(srcs, null, head, latencyOf);
  const steps = route?.steps || [];
  if (!steps.length) return auto.map(inst => ({ kind: 'source', inst }));

  const byId = new Map();
  for (const inst of auto) {
    const id = sourceChainId(inst);
    if (id && !byId.has(id)) byId.set(id, inst);
  }
  const items = [];
  const used = new Set();
  let placedAuto = false;
  const placeAuto = () => {
    if (placedAuto) return;
    placedAuto = true;
    for (const inst of auto) {
      const id = sourceChainId(inst);
      if (id && used.has(id)) continue;
      items.push({ kind: 'source', inst });
      if (id) used.add(id);
    }
  };

  for (const step of steps) {
    const name = String(step?.model || '').trim();
    if (!name) continue;
    if (name !== head) {
      const provider = String(step.provider || '').trim();
      if (!items.some(it => it.kind === 'model' && it.name === name && (it.provider || '') === provider)) {
        items.push({ kind: 'model', name, provider });
      }
      continue;
    }
    if (step.provider) {
      const inst = byId.get(step.provider);
      if (inst && !used.has(step.provider)) {
        items.push({ kind: 'source', inst });
        used.add(step.provider);
      }
      continue;
    }
    placeAuto();
  }
  if (!placedAuto) {
    const pending = auto.filter(inst => {
      const id = sourceChainId(inst);
      return !id || !used.has(id);
    });
    const at = items.findIndex(it => it.kind === 'model');
    const rows = pending.map(inst => ({ kind: 'source', inst }));
    if (at === -1) items.push(...rows);
    else items.splice(at, 0, ...rows);
  }
  return items;
}

/** 列表卡片上的供给源图标：链上每一步都算，不只链头自己的账户。 */
function chainIconInsts(head, srcs, route, sourcesByModel) {
  const items = buildChainItems(srcs, route, head, () => null);
  const out = [];
  const seen = new Set();
  const push = (inst) => {
    if (!inst) return;
    const key = String(sourceChainId(inst) || inst.id || inst.source_id || inst.agent_id || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(inst);
  };
  for (const it of items) {
    if (it.kind === 'source') {
      push(it.inst);
      continue;
    }
    const list = sourcesByModel?.[it.name] || [];
    const provider = String(it.provider || '').trim();
    for (const inst of list) {
      if (!provider) {
        push(inst);
        continue;
      }
      const id = String(sourceChainId(inst) || inst.source_id || inst.provider_id || '').trim();
      if (id === provider) push(inst);
    }
  }
  return out.length ? out : (srcs || []);
}

/** 这一步最近一次转发是否成功。模型步看该模型任一供给源。 */
function chainItemOk(item, head, latencyMap) {
  if (item.kind === 'model') {
    const pmap = providerLatencyMap(latencyMap, item.name);
    if (!pmap) return false;
    return Object.values(pmap).some((row) => {
      const code = row?.last_status_code;
      return code >= 200 && code < 300;
    });
  }
  const row = resolveAccountLatencyRow(latencyMap, head, item.inst);
  const code = row?.statusCode;
  return code >= 200 && code < 300;
}

/** 链头没成功，但后面某一步成功了：卡片用黄点，表示正在降级。 */
function chainServingLater(head, srcs, route, latencyMap) {
  const chain = buildChainItems(srcs, route, head, () => null);
  if (chain.length < 2) return false;
  const firstOk = chain.findIndex((item) => chainItemOk(item, head, latencyMap));
  return firstOk > 0;
}

export function PersonalSourceModelView({
  instances, t, trailing = null, onEmptyAdd = null, onEmptySync = null, syncing = false,
  syncSecrets = false,
  modelTypeMap = {},
  latencyMap: latencyMapProp = null, onRefreshLatency = null, probeTargets = [],
  // 冷却查询：(...ids) => cooldown | null；冷却中不显示绿色「成功」
  cooldownFor = null,
  sceneRoutes = [],
  onSaveListRoute = null,
  onDeleteListRoute = null,
}) {
  const [chainModel, setChainModel] = useState(null);
  // 点「降级链整理」后，已进链的模型不再单独占卡。添加列表仍用全部模型。
  const [chainTidied, setChainTidied] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [openVendors, setOpenVendors] = useState(() => new Set());   // 展开了「其余」的厂商
  const [latencyMapLocal, setLatencyMapLocal] = useState({});
  const latencyMap = latencyMapProp ?? latencyMapLocal;
  const [probing, setProbing] = useState(null);     // null | { done, total, current }
  const probeAbortRef = useRef(false);

  const routeByModel = useMemo(() => {
    const map = new Map();
    for (const r of sceneRoutes || []) {
      if (r?.list_route && r.model_key) map.set(r.model_key, r);
    }
    return map;
  }, [sceneRoutes]);

  const modelSources = useMemo(() => {
    const m = {};
    for (const inst of instances) {
      const modelList = (inst.models || []).map(modelEntryName).filter(Boolean);
      if (!modelList.length) continue;
      for (const model of modelList) {
        const list = m[model] || (m[model] = []);
        const uid = inst.id || inst.agent_id || inst.source_id;
        if (!list.some(x => (x.id || x.agent_id || x.source_id) === uid)) list.push(inst);
      }
    }
    return m;
  }, [instances]);

  // 短名带上更长的变体。已经写进某条降级链的模型先不单独占卡，移出后恢复。
  const prefixRoutes = useMemo(() => prefixModelRoutes(Object.keys(modelSources)), [modelSources]);
  const hiddenChainModels = useMemo(() => {
    const hidden = new Set();
    const folded = prefixRoutes.folded || new Set();
    for (const [head, route] of routeByModel) {
      for (const step of route.steps || []) {
        const name = String(step?.model || '').trim();
        if (name && name !== head) hidden.add(name);
      }
    }
    for (const [head, extras] of prefixRoutes.extras) {
      for (const name of extras) {
        // 已保存的链仍尊重用户移出的普通变体；v4.1 / v4-1 这种写法始终收进链头
        if (routeByModel.has(head) && !folded.has(name)) continue;
        hidden.add(name);
      }
    }
    return hidden;
  }, [prefixRoutes, routeByModel]);

  const isModelRoute = (name) => routeByModel.has(name) || (prefixRoutes.extras.get(name)?.length > 0);

  const byModel = useMemo(() => {
    // 有降级链的排在前面，其余按名称字母序
    return Object.entries(modelSources).sort((a, b) => {
      const ar = isModelRoute(a[0]) ? 0 : 1;
      const br = isModelRoute(b[0]) ? 0 : 1;
      if (ar !== br) return ar - br;
      return a[0].localeCompare(b[0]);
    });
  }, [modelSources, routeByModel, prefixRoutes]);

  const displayModels = useMemo(
    () => (chainTidied ? byModel.filter(([name]) => !hiddenChainModels.has(name)) : byModel),
    [byModel, hiddenChainModels, chainTidied],
  );

  function routeForModel(name) {
    const extras = prefixRoutes.extras.get(name) || [];
    const folded = prefixRoutes.folded || new Set();
    const saved = routeByModel.get(name) || null;
    if (!saved) {
      if (!extras.length) return null;
      return { steps: [{ model: name }, ...extras.map(model => ({ model }))], flow: 'fallback', list_route: true };
    }
    // 保存过的链没有「恢复默认」时，也要把 v4.1 / v4-1 补进当前这条链
    const have = new Set((saved.steps || []).map(s => String(s?.model || '').trim()));
    const missing = extras.filter(n => folded.has(n) && !have.has(n));
    if (!missing.length) return saved;
    return { ...saved, steps: [...(saved.steps || []), ...missing.map(model => ({ model }))] };
  }

  // 探针队列跟网格展示一致：按卡片从左到右、从上到下逐个测
  const orderedProbeTargets = useMemo(() => {
    const raw = probeTargets || [];
    if (!raw.length) return raw;
    const buckets = new Map();
    for (const t of raw) {
      const bare = probeTargetBare(t);
      if (!bare) continue;
      const list = buckets.get(bare) || [];
      list.push(t);
      buckets.set(bare, list);
    }
    const out = [];
    const used = new Set();
    for (const [model] of displayModels) {
      const hits = buckets.get(String(model).trim().toLowerCase());
      if (!hits) continue;
      for (const t of hits) {
        if (used.has(t)) continue;
        used.add(t);
        out.push(t);
      }
    }
    for (const t of raw) {
      if (!used.has(t)) out.push(t);
    }
    return out;
  }, [probeTargets, displayModels]);

  // 测一批目标。消耗自己供给源的真实计费（非积分），完后刷新圆点。
  const runProbeTargets = async (targets) => {
    if (probing || !targets.length) return;
    probeAbortRef.current = false;
    setProbing({ done: 0, total: targets.length, current: targets[0] });
    for (let i = 0; i < targets.length; i++) {
      if (probeAbortRef.current) break;
      setProbing({ done: i, total: targets.length, current: targets[i] });
      try { await window.electronAPI?.gateway?.probeModel?.(targets[i]); } catch { /* ignore */ }
      try { await loadLatency(); } catch { /* ignore */ }
      if (probeAbortRef.current) break;
      setProbing({ done: i + 1, total: targets.length, current: targets[i + 1] || null });
    }
    try { await loadLatency(); } catch { /* ignore */ }
    if (!probeAbortRef.current) setProbing(null);
    probeAbortRef.current = false;
  };
  const probeAllPersonal = () => runProbeTargets(orderedProbeTargets);
  // 点卡片上的圆点：只测这一个模型（它的各供给源各测一次）
  const probeOneModel = (modelName) => {
    const bare = String(modelName || '').trim().toLowerCase();
    const targets = orderedProbeTargets.filter(t => probeTargetBare(t) === bare);
    return runProbeTargets(targets);
  };
  const cancelProbe = () => {
    probeAbortRef.current = true;
    setProbing(null);
  };

  const loadLatency = useCallback(async () => {
    if (onRefreshLatency) {
      onRefreshLatency();
      return;
    }
    try {
      const map = await getGateway().getModelProviderLatency(7);
      if (map && typeof map === 'object') setLatencyMapLocal({ ...map });
    } catch { /* 网关未就绪时忽略 */ }
  }, [onRefreshLatency]);

  // 无父级注入时自行拉取
  useEffect(() => {
    if (latencyMapProp) return undefined;
    loadLatency();
    const fast = chainModel ? 5000 : 30000;
    const id = setInterval(loadLatency, fast);
    return () => clearInterval(id);
  }, [loadLatency, chainModel, latencyMapProp]);

  useEffect(() => {
    if (latencyMapProp || !isElectron() || !window.electronAPI?.localStats?.onChanged) return undefined;
    return window.electronAPI.localStats.onChanged(loadLatency);
  }, [loadLatency, latencyMapProp]);

  useEffect(() => {
    if (chainModel) loadLatency();
  }, [chainModel, loadLatency]);

  // 参与供给的账户（按 provider 去重 logo），统计仍用全部账户数
  const uniqueProviders = useMemo(() => {
    const withModels = instances.filter(inst =>
      (inst.models || []).map(modelEntryName).filter(Boolean).length > 0,
    );
    return dedupeByProvider(withModels);
  }, [instances]);

  const accountCount = useMemo(() => {
    return instances.filter(inst =>
      (inst.models || []).map(modelEntryName).filter(Boolean).length > 0,
    ).length;
  }, [instances]);

  if (byModel.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 min-w-0">
          <p className="text-xs text-zinc-400">
            {t('psrc.model.empty')}
            {onEmptyAdd && (
              <>
                ，
                <button type="button" onClick={onEmptyAdd}
                  className="text-blue-500 dark:text-blue-400 hover:underline">
                  {t('psrc.model.emptyAdd')}
                </button>
              </>
            )}
            {onEmptySync && (
              <>
                ，{t('psrc.model.emptyOr')}{' '}
                <button type="button" onClick={onEmptySync} disabled={syncing}
                  className="text-blue-500 dark:text-blue-400 hover:underline disabled:opacity-60">
                  {syncing ? t('psrc.model.syncing') : t('psrc.model.emptySync')}
                </button>
                {' '}{syncSecrets ? t('psrc.model.emptySyncTailWithKeys') : t('psrc.model.emptySyncTail')}
                {' '}{syncSecrets ? t('psrc.model.syncKeyHintOn') : t('psrc.model.syncKeyHint')}
              </>
            )}
          </p>
          {trailing}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2 min-w-0">
        <div className="flex flex-col gap-1 min-w-0 flex-1">
          {uniqueProviders.length > 0 && (
            <div className="flex items-center -space-x-1 shrink-0">
              {uniqueProviders.map((s, i) => (
                <span
                  key={providerDedupKey(s) + ':' + i}
                  className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-zinc-50 dark:bg-zinc-900 ring-1 ring-zinc-200 dark:ring-zinc-700"
                >
                  <SourceProviderLogo inst={s} />
                </span>
              ))}
            </div>
          )}
          <span className="text-xs text-zinc-500 truncate">
            {t('psrc.modelView.summary', { accounts: accountCount, models: displayModels.length })}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={() => setChainTidied(true)} disabled={chainTidied}
            title={t('psrc.route.tidyHint')}
            className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 whitespace-nowrap disabled:opacity-40">
            {t('psrc.route.tidy')}
          </button>
          {orderedProbeTargets.length > 0 && (
            <button type="button" onClick={probing ? cancelProbe : probeAllPersonal}
              title={probing ? t('providers.probe.cancelHint') : t('providers.probe.titlePersonal')}
              className="text-xs text-blue-500 hover:text-blue-600 dark:text-blue-400 flex items-center gap-1 whitespace-nowrap">
              {probing ? t('providers.probe.running', { done: probing.done, total: probing.total }) : t('providers.probe.all')}
            </button>
          )}
          {trailing}
        </div>
      </div>
      <ModelChipGroups
        displayModels={displayModels}
        modelTypeMap={modelTypeMap}
        latencyMap={latencyMap}
        probing={probing}
        chainModel={chainModel}
        isModelRoute={isModelRoute}
        routeForModel={routeForModel}
        query={modelQuery}
        setQuery={setModelQuery}
        typeFilter={typeFilter}
        setTypeFilter={setTypeFilter}
        openVendors={openVendors}
        setOpenVendors={setOpenVendors}
        onOpen={setChainModel}
        t={t}
      />
      {chainModel && (
        <ChainDrawer
          model={chainModel}
          sources={byModel.find(([name]) => name === chainModel)?.[1] || []}
          route={routeForModel(chainModel)}
          latencyMap={latencyMap}
          skipSpeed={modelTypeMap[chainModel] === 'image'}
          cooldownFor={cooldownFor}
          // 整理只影响卡片。添加列表始终是全部模型，已在别的链里的也能加进来。
          modelChoices={byModel.map(([name]) => name)}
          sourcesByModel={Object.fromEntries(byModel)}
          modelTypeMap={modelTypeMap}
          t={t}
          onClose={() => setChainModel(null)}
          onSave={onSaveListRoute}
          onReset={onDeleteListRoute}
        />
      )}
    </div>
  );
}

/** 模型按厂商一行，每个模型一个小芯片；没在用的折到「+N」，版本折到主模型「×N」 */
function ModelChipGroups({
  displayModels, modelTypeMap, latencyMap, probing, chainModel, isModelRoute, routeForModel,
  query, setQuery, typeFilter, setTypeFilter, openVendors, setOpenVendors, onOpen, t,
}) {
  // 每个模型的状态：圆点颜色、最快速度、是否在用（进了降级链，或最近有请求/测速）
  const info = useMemo(() => {
    const m = new Map();
    for (const [model, srcs] of displayModels) {
      const mType = modelTypeMap[model];
      const skipSpeed = mType === 'image';
      const rows = srcs.map(s => resolveAccountLatencyRow(latencyMap, model, s));
      const ttfts = rows.map(r => (r?.ttft > 0 ? r.ttft : null)).filter(Boolean);
      const fastMs = skipSpeed || !ttfts.length ? null : Math.min(...ttfts);
      const anyFail = !skipSpeed && !fastMs && rows.some(r => r?.statusCode != null && (r.statusCode < 200 || r.statusCode >= 300));
      // 在用：进了降级链，或最近 7 天有成功的请求（只有失败的不算，测速失败也不算）
      const okRecently = rows.some(r => r && (r.ttft > 0 || (r.statusCode >= 200 && r.statusCode < 300)));
      const route = routeForModel(model);
      const degraded = !skipSpeed && !!route && chainServingLater(model, srcs, route, latencyMap);
      const probingThis = !skipSpeed && !!(probing?.current && probeTargetBare(probing.current) === String(model).trim().toLowerCase());
      const bucket = skipSpeed ? 'unknown' : (probingThis ? 'fast' : degraded ? 'slow' : statusDotBucket({ ms: fastMs, failed: anyFail, ok: !!fastMs }));
      m.set(model, { srcs, mType, fastMs, anyFail, bucket, probingThis, inChain: isModelRoute(model), used: isModelRoute(model) || okRecently });
    }
    return m;
  }, [displayModels, modelTypeMap, latencyMap, probing, isModelRoute, routeForModel]);

  // 版本折叠：同一主模型下的日期/档位版本，主模型在就挂在它下面
  const { heads, variantsOf } = useMemo(() => {
    const names = displayModels.map(([n]) => n);
    // v4-1 和 v4.1 当成同一个版本号
    const norm = (n) => String(n).toLowerCase().replace(/(\d)-(\d)/g, '$1.$2');
    const headByNorm = new Map(names.map(n => [norm(n), n]));
    const vOf = new Map();
    const hs = [];
    for (const n of names) {
      const head = headByNorm.get(norm(modelBaseName(n)));
      if (head && head !== n) {
        if (!vOf.has(head)) vOf.set(head, []);
        vOf.get(head).push(n);
      } else hs.push(n);
    }
    return { heads: hs, variantsOf: vOf };
  }, [displayModels]);

  const types = useMemo(() => {
    const seen = new Set();
    for (const [n] of displayModels) seen.add(modelTypeMap[n] || 'chat');
    return ['chat', 'vision', 'embedding', 'image'].filter(x => seen.has(x));
  }, [displayModels, modelTypeMap]);

  const q = query.trim().toLowerCase();
  const matches = (name) => {
    if (typeFilter && (modelTypeMap[name] || 'chat') !== typeFilter) return false;
    if (!q) return true;
    const group = [name, ...(variantsOf.get(name) || [])];
    return group.some(n => n.toLowerCase().includes(q));
  };

  // 按厂商分组；在用的多的厂商排前面
  const groups = useMemo(() => {
    const g = new Map();
    for (const n of heads) {
      if (!matches(n)) continue;
      const v = modelVendor(n);
      if (!g.has(v)) g.set(v, []);
      g.get(v).push(n);
    }
    const used = (n) => info.get(n)?.used || (variantsOf.get(n) || []).some(x => info.get(x)?.used);
    const out = [...g.entries()].map(([vendor, list]) => {
      const sorted = [...list].sort((a, b) => (info.get(b)?.inChain - info.get(a)?.inChain) || (used(b) - used(a)) || a.localeCompare(b));
      return { vendor, shown: sorted.filter(used), rest: sorted.filter(n => !used(n)) };
    });
    return out.sort((a, b) => (b.shown.length - a.shown.length) || (b.rest.length - a.rest.length) || a.vendor.localeCompare(b.vendor));
  }, [heads, variantsOf, info, q, typeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const [idleOpen, setIdleOpen] = useState(false);
  // 一个在用的都没有的厂商：合成最后一行「其余 N 个厂商」，搜索/筛选时展开
  const activeGroups = groups.filter(g => g.shown.length > 0);
  const idleGroups = groups.filter(g => g.shown.length === 0);
  const idleModels = idleGroups.reduce((s, g) => s + g.rest.length, 0);
  const usedTotal = groups.reduce((s, g) => s + g.shown.length, 0);
  const allTotal = groups.reduce((s, g) => s + g.shown.length + g.rest.length, 0);
  const searching = !!q || !!typeFilter;

  const chip = (name, dim = false) => {
    const it = info.get(name) || {};
    const vars = variantsOf.get(name) || [];
    const tip = [
      name,
      vars.length ? `${t('psrc.chips.versions', { n: vars.length + 1 })}：${vars.join('、')}` : '',
      it.probingThis ? '测速中' : it.fastMs ? `最快 ${(it.fastMs / 1000).toFixed(1)}s` : (it.anyFail ? '最近请求失败' : ''),
      (it.srcs || []).length > 1 ? t('psrc.chips.accounts', { n: it.srcs.length }) : '',
    ].filter(Boolean).join(' · ');
    return (
      <button key={name} type="button" title={tip} onClick={() => onOpen(name)}
        className={`inline-flex items-center gap-1.5 max-w-full min-h-[30px] md:min-h-[26px] px-2 rounded-lg border text-xs transition-colors ${
          chainModel === name ? 'border-blue-400/70 bg-blue-50/60 dark:bg-blue-950/30'
            : it.inChain ? 'border-zinc-400/70 dark:border-zinc-500/70 bg-white/80 dark:bg-zinc-800'
              : 'border-zinc-200 dark:border-zinc-700/70 bg-white/60 dark:bg-zinc-800/60 hover:border-zinc-400/70'
        } ${dim ? 'opacity-70' : ''}`}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${it.probingThis ? 'bg-green-400 tb-probe-pulse' : speedDotClass(it.bucket)}`} />
        <span className="truncate text-zinc-800 dark:text-zinc-200">{modelShortName(name)}</span>
        {vars.length > 0 && <span className="shrink-0 text-[10px] text-zinc-400">×{vars.length + 1}</span>}
        {it.mType && it.mType !== 'chat' && (
          <span className={`shrink-0 text-[9px] leading-none px-1 py-px rounded ${modelTypeBtnClass(it.mType)}`}>{modelTypeLabel(it.mType, t)}</span>
        )}
        {it.inChain && <span className="shrink-0 text-[9px] leading-none px-1 py-px rounded bg-zinc-200/80 dark:bg-zinc-700 text-zinc-500">{t('psrc.route.chainMark')}</span>}
      </button>
    );
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('psrc.chips.search')}
          className="min-h-[36px] md:min-h-[30px] w-full md:w-56 px-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/80 dark:bg-zinc-900 text-sm md:text-xs text-zinc-900 dark:text-zinc-100" />
        <div className="flex flex-wrap gap-1">
          {['', ...types].map(tp => (
            <button key={tp || 'all'} type="button" onClick={() => setTypeFilter(tp)}
              className={`min-h-[32px] md:min-h-[26px] px-2 rounded-lg text-xs border ${typeFilter === tp
                ? 'border-blue-400 text-blue-600 dark:text-blue-300 bg-blue-50/70 dark:bg-blue-950/30'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400'}`}>
              {tp ? modelTypeLabel(tp, t) : t('psrc.chips.all')}
            </button>
          ))}
        </div>
        <span className="md:ml-auto text-[11px] text-zinc-400">{t('psrc.chips.summary', { used: usedTotal, all: allTotal })}</span>
      </div>
      <div className="tb-table-shell rounded-xl overflow-hidden">
        {groups.length === 0 && <div className="py-6 text-center text-xs text-zinc-400">{t('psrc.chips.none')}</div>}
        {[...activeGroups, ...((searching || idleOpen) ? idleGroups : [])].map(({ vendor, shown, rest }) => {
          const open = searching || openVendors.has(vendor) || shown.length === 0;
          return (
            <div key={vendor} className="tb-table-row flex flex-col md:flex-row md:items-start gap-1.5 md:gap-3 px-3 py-2.5">
              <span className="md:w-24 shrink-0 pt-1 flex items-baseline gap-1 min-w-0 text-xs font-semibold text-zinc-700 dark:text-zinc-200" title={vendor}>
                <span className="truncate">{vendor}</span><span className="shrink-0 font-normal text-zinc-400">{shown.length + rest.length}</span>
              </span>
              <div className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                {shown.map(n => chip(n))}
                {open && rest.map(n => chip(n, true))}
                {rest.length > 0 && !searching && shown.length > 0 && (
                  <button type="button" onClick={() => setOpenVendors(prev => { const n = new Set(prev); if (n.has(vendor)) n.delete(vendor); else n.add(vendor); return n; })}
                    className="min-h-[30px] md:min-h-[26px] px-2 rounded-lg text-[11px] text-blue-600 dark:text-blue-400 hover:bg-blue-50/70 dark:hover:bg-blue-950/30">
                    {openVendors.has(vendor) ? t('psrc.chips.less') : t('psrc.chips.more', { n: rest.length })}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {!searching && idleGroups.length > 0 && (
          <button type="button" onClick={() => setIdleOpen(v => !v)}
            className="tb-table-row w-full flex items-center gap-2 px-3 py-2.5 text-left text-xs text-zinc-500 dark:text-zinc-400 hover:bg-white/40 dark:hover:bg-white/[0.03]">
            <span className="font-semibold text-zinc-600 dark:text-zinc-300">{idleOpen ? t('psrc.chips.idleLess') : t('psrc.chips.idle', { v: idleGroups.length, n: idleModels })}</span>
            <span className="text-zinc-400 truncate">{idleOpen ? '' : idleGroups.map(g => g.vendor).join('、')}</span>
            <span className="ml-auto text-blue-600 dark:text-blue-400 shrink-0">{idleOpen ? '▴' : '▾'}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** 右侧面板仍列出供给源和测速。落库步骤与场景路由相同：没调顺序就不钉账户。 */
function ChainDrawer({
  model, sources, route, latencyMap, skipSpeed, cooldownFor, modelChoices = [],
  sourcesByModel = {}, modelTypeMap = {}, t, onClose, onSave, onReset,
}) {
  const [pick, setPick] = useState('');
  const latencyOf = (inst) => {
    const row = resolveAccountLatencyRow(latencyMap, model, inst);
    return row?.ttft > 0 ? row.ttft : null;
  };
  const chain = buildChainItems(sources, route, model, latencyOf);
  // 没钉 provider 的模型步表示这一家都走，整名不再出现。钉过的只去掉这一家。
  const takenModels = new Set();
  const takenPairs = new Set();
  for (const it of chain) {
    if (it.kind !== 'model') continue;
    if (it.provider) takenPairs.add(`${it.provider}\0${it.name}`);
    else takenModels.add(it.name);
  }
  // 每条候选只有一个 provider id，按「provider:模型名」字母序排。
  const choices = [];
  for (const name of modelChoices) {
    if (!name || name === model || takenModels.has(name)) continue;
    const seen = new Set();
    for (const inst of sourcesByModel[name] || []) {
      const id = String(sourceChainId(inst) || inst.source_id || inst.provider_id || '').trim();
      if (!id || seen.has(id) || takenPairs.has(`${id}\0${name}`)) continue;
      seen.add(id);
      choices.push({ provider: id, name, label: `${id}:${name}` });
    }
  }
  choices.sort((a, b) => a.label.localeCompare(b.label));
  const autoSources = orderChainSources(sources, null, model, latencyOf);

  function persist(items) {
    const steps = [];
    for (const it of items) {
      if (it.kind === 'model') {
        const name = String(it.name || '').trim();
        if (name && name !== model) {
          const provider = String(it.provider || '').trim();
          // 兜底模型钉一家供给源，不再把同名的其他账户一起带上
          steps.push(provider ? { model: name, provider } : { model: name });
        }
        continue;
      }
      const id = sourceChainId(it.inst);
      if (id) steps.push({ model, provider: id });
    }
    const ids = steps.filter(s => s.provider).map(s => s.provider);
    const autoIds = autoSources.map(sourceChainId).filter(Boolean);
    const sameOrder = ids.join('\0') === autoIds.join('\0') && steps.every(s => s.model === model);
    if (sameOrder) {
      if (route?.id) onReset?.(route.id);
      return;
    }
    if (!steps.length) return;
    onSave?.(model, { steps });
  }

  function moveItem(index, dir) {
    const j = index + dir;
    if (j < 0 || j >= chain.length) return;
    const next = chain.slice();
    const [item] = next.splice(index, 1);
    next.splice(j, 0, item);
    persist(next);
  }

  function addModel() {
    const cut = pick.indexOf('\0');
    if (cut < 0) return;
    const provider = pick.slice(0, cut);
    const name = pick.slice(cut + 1).trim();
    if (!name || name === model || takenModels.has(name)) return;
    if (provider && takenPairs.has(`${provider}\0${name}`)) return;
    setPick('');
    persist([...chain, { kind: 'model', name, provider }]);
  }

  function removeModel(name, provider) {
    persist(chain.filter(it => !(it.kind === 'model' && it.name === name && (it.provider || '') === (provider || ''))));
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40">
      <button
        type="button"
        className="absolute inset-0 bg-black/20"
        aria-label={t('providers.list.close')}
        onClick={onClose}
      />
      <aside className="tb-drawer-in absolute inset-y-0 right-0 w-[min(28rem,100vw)] bg-white dark:bg-zinc-900 border-l border-zinc-200 dark:border-zinc-700 overflow-y-auto">
        <div className="sticky top-0 z-10 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-700 px-4 py-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate" title={model}>{model}</div>
            <div className="text-[11px] text-zinc-400 mt-0.5">{t('psrc.route.chainTitle')}</div>
          </div>
          {/* 避开窗口顶部拖拽条，否则点击会被当成拖动窗口 */}
          <button type="button" className="electron-no-drag mt-8 text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 shrink-0" onClick={onClose}>
            {t('providers.list.close')}
          </button>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="text-[11px] leading-relaxed text-zinc-500">{t('psrc.route.chainHint')}</p>
          <p className="text-[11px] text-zinc-400">{route ? t('psrc.route.custom') : t('psrc.route.auto')}</p>
          {chain.length < 2 && takenModels.size === 0 && takenPairs.size === 0 && (
            <p className="text-[11px] text-zinc-400">{t('psrc.route.onlyOne')}</p>
          )}
          <ol className="space-y-1">
            {chain.map((it, i) => {
              if (it.kind === 'model') {
                const modelSrcs = (sourcesByModel[it.name] || []).filter(inst => {
                  if (!it.provider) return true;
                  const id = String(sourceChainId(inst) || inst.source_id || inst.provider_id || '').trim();
                  return id === it.provider;
                });
                const modelSkip = modelTypeMap[it.name] === 'image';
                let shown = null;
                for (const inst of modelSrcs) {
                  const row = resolveAccountLatencyRow(latencyMap, it.name, inst);
                  if (!row) continue;
                  // 有成功速度就显示最快的一次；否则显示最近一次失败
                  const betterSpeed = row.ttft > 0 && (!shown?.row?.ttft || row.ttft < shown.row.ttft);
                  const newerFail = !(row.ttft > 0) && !(shown?.row?.ttft > 0) && (row.ts || 0) > (shown?.row?.ts || 0);
                  if (!shown || betterSpeed || newerFail) shown = { inst, row };
                }
                const row = shown?.row || null;
                const health = modelSkip || row?.statusCode == null ? null : healthFromStatus(row.statusCode);
                const cooling = !!(shown && typeof cooldownFor === 'function' && cooldownFor(
                  shown.inst.gateway_id, shown.inst.id, shown.inst.agent_id, shown.inst.source_id, shown.inst.provider_id,
                ));
                const providerLabel = [...new Set(modelSrcs.map(accountDisplayName))].join(' · ');
                return (
                  <li
                    key={'m:' + (it.provider || '') + ':' + it.name}
                    className="flex items-start gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
                  >
                    <span className="w-4 pt-0.5 text-[11px] text-zinc-400 tabular-nums shrink-0">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className="shrink-0 tabular-nums text-zinc-400">{modelSkip ? '—' : (row?.ttft != null ? `${Math.round(row.ttft)}ms` : '—')}</span>
                        {modelSrcs.map((s, si) => (
                          <SourceProviderLogo key={(s.id || s.source_id || si) + ':' + si} inst={s} />
                        ))}
                        <span className="text-zinc-800 dark:text-zinc-200 break-all">{providerLabel}</span>
                        <QualityBadge health={health} cooling={cooling} />
                      </div>
                      <div className="mt-0.5 text-[11px] text-zinc-500 break-all" title={it.name}>{it.name}</div>
                    </div>
                    <span className="flex flex-col shrink-0">
                      <button
                        type="button"
                        disabled={i === 0}
                        className="text-[10px] leading-none px-1 py-0.5 text-zinc-500 disabled:opacity-30 shrink-0"
                        onClick={() => moveItem(i, -1)}
                      >{t('psrc.route.moveUp')}</button>
                    <button
                      type="button"
                      disabled={i === chain.length - 1}
                      className="text-[10px] leading-none px-1 py-0.5 text-zinc-500 disabled:opacity-30 shrink-0"
                      onClick={() => moveItem(i, 1)}
                    >{t('psrc.route.moveDown')}</button>
                    <button
                      type="button"
                      className="text-[10px] leading-none px-1 py-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 shrink-0"
                      onClick={() => removeModel(it.name, it.provider)}
                    >{t('psrc.route.remove')}</button>
                    </span>
                  </li>
                );
              }
              const inst = it.inst;
              const row = resolveAccountLatencyRow(latencyMap, model, inst);
              const health = skipSpeed || row?.statusCode == null ? null : healthFromStatus(row.statusCode);
              const cooling = !!(typeof cooldownFor === 'function' && cooldownFor(
                inst.gateway_id, inst.id, inst.agent_id, inst.source_id, inst.provider_id,
              ));
              return (
                <li
                  key={sourceChainId(inst) || i}
                  className="flex items-start gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 px-2 py-1.5"
                >
                  <span className="w-4 pt-0.5 text-[11px] text-zinc-400 tabular-nums shrink-0">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span className="shrink-0 tabular-nums text-zinc-400">{skipSpeed ? '—' : (row?.ttft != null ? `${Math.round(row.ttft)}ms` : '—')}</span>
                      <SourceProviderLogo inst={inst} />
                      <span className="text-zinc-800 dark:text-zinc-200 break-all">{accountDisplayName(inst)}</span>
                      <QualityBadge health={health} cooling={cooling} />
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-500 break-all" title={model}>{model}</div>
                  </div>
                  {chain.length > 1 && sourceChainId(inst) && (
                    <span className="flex flex-col shrink-0">
                      <button
                        type="button"
                        disabled={i === 0}
                        className="text-[10px] leading-none px-1 py-0.5 text-zinc-500 disabled:opacity-30"
                        onClick={() => moveItem(i, -1)}
                      >{t('psrc.route.moveUp')}</button>
                      <button
                        type="button"
                        disabled={i === chain.length - 1}
                        className="text-[10px] leading-none px-1 py-0.5 text-zinc-500 disabled:opacity-30"
                        onClick={() => moveItem(i, 1)}
                      >{t('psrc.route.moveDown')}</button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <div className="space-y-1.5">
            <p className="text-[11px] text-zinc-500">{t('psrc.route.modelStep')}</p>
            {choices.length > 0 && (
              <div className="flex gap-2 items-start">
                {/* 列表留在抽屉里滚动，避免原生下拉被窗口底边裁掉后选不到后面的模型 */}
                <div className="flex-1 min-w-0 max-h-40 overflow-y-auto rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800">
                  {choices.map(c => {
                    const value = `${c.provider}\0${c.name}`;
                    return (
                    <button
                      key={value}
                      type="button"
                      title={c.label}
                      onClick={() => setPick(value)}
                      className={`block w-full text-left text-xs px-2 py-1 truncate ${
                        pick === value
                          ? 'bg-blue-500 text-white'
                          : 'text-zinc-800 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-700'
                      }`}
                    >{c.label}</button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  disabled={!pick}
                  className="text-xs px-2.5 py-1 rounded-lg bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900 shrink-0 disabled:opacity-40"
                  onClick={addModel}
                >{t('psrc.route.addModel')}</button>
              </div>
            )}
          </div>
          {route?.id && (
            <button
              type="button"
              className="text-[11px] text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              onClick={() => onReset?.(route.id)}
            >{t('psrc.route.reset')}</button>
          )}
        </div>
      </aside>
    </div>
  );
}

// ── 第2块：源模板库网格（彩/灰均可点编辑）────────────────────────────────────────
function templateKindBase(tpl, t) {
  const base = tpl.kind === 'payg' ? t('psrc.kind.payg') : tpl.kind === 'api_sub' ? t('psrc.kind.apiSub') : t('psrc.kind.appSub');
  return tpl.custom ? `${base} · ${t('psrc.tpl.customTag')}` : base;
}

function templateKindLabel(tpl, t) {
  const base = templateKindBase(tpl, t);
  // 免费账户附加标识，便于在源模板库中发现
  if (tpl.tier === 'free') return `${t('providers.add.freeTag')} · ${base}`;
  return base;
}

export function SourceTemplateGrid({
  templates, addedKeys, onEdit, onAdd, t,
  hintKey = 'psrc.tpl.hint', showAdd = true,
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">{t(hintKey)}</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {templates.map(tpl => {
          const added = addedKeys.has(tpl.key);
          const isFree = tpl.tier === 'free';
          return (
            <button key={tpl.key} type="button" onClick={() => onEdit(tpl)}
              title={`${tpl.label} · ${templateKindLabel(tpl, t)}${tpl._override ? ' · ' + t('psrc.tpl.edited') : ''}`}
              className={`tb-soft-tile flex items-center gap-2 px-3 py-2 rounded-xl text-left ${
                added ? '' : 'opacity-70'
              }`}>
              <span className={added ? '' : 'grayscale opacity-60'}>
                <ServiceIcon id={tpl.key} name={tpl.label} icon={tpl.icon} baseUrl={tpl.base_url} signupUrl={tpl.signup_url} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-xs font-medium truncate ${added ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-500'}`}>{tpl.label}</span>
                <span className="flex flex-wrap items-center gap-1 mt-0.5">
                  {isFree && (
                    <span className="text-[10px] px-1 py-0.5 rounded font-semibold bg-emerald-100/90 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
                      {t('providers.add.freeTag')}
                    </span>
                  )}
                  <span className="text-[10px] text-zinc-400">{templateKindBase(tpl, t)}{tpl._override ? ' · ' + t('psrc.tpl.edited') : ''}</span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {/* 完整个人页：选源加实例 */}
      {showAdd && onAdd && (
        <button type="button" onClick={onAdd}
          className="w-full text-xs py-2 rounded-xl border-2 border-dashed border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
          + {t('psrc.tpl.addSource2')}
        </button>
      )}
    </div>
  );
}

// 添加源弹窗：选一个已有源 → 打开该源的编辑弹窗加实例
export function SourcePickerModal({ templates, onPick, onClose, t }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-3 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('psrc.tpl.pickSource')}</h3>
        <p className="text-[11px] text-zinc-400">{t('psrc.tpl.pickHint')}</p>
        <div className="grid grid-cols-2 gap-2">
          {templates.map(tpl => {
            const ready = templateReadyForInstance(tpl);   // 没配模型的(灰)点击去配置
            const isFree = tpl.tier === 'free';
            return (
              <button key={tpl.key} type="button" onClick={() => onPick(tpl)}
                title={ready ? '' : t('psrc.tpl.needConfig')}
                className={`tb-soft-tile flex items-center gap-2 px-3 py-2 rounded-xl text-left ${
                  ready ? '' : 'opacity-60'
                }`}>
                <span className={ready ? '' : 'grayscale opacity-60'}>
                  <ServiceIcon id={tpl.key} name={tpl.label} icon={tpl.icon} baseUrl={tpl.base_url} signupUrl={tpl.signup_url} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className={`block text-xs font-medium truncate ${ready ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-500'}`}>{tpl.label}</span>
                  <span className="flex flex-wrap items-center gap-1 mt-0.5">
                    {isFree && (
                      <span className="text-[10px] px-1 py-0.5 rounded font-semibold bg-emerald-100/90 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200">
                        {t('providers.add.freeTag')}
                      </span>
                    )}
                    <span className="text-[10px] text-zinc-400">
                      {templateKindBase(tpl, t)}{ready ? '' : ' · ' + t('psrc.tpl.needConfigTag')}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex justify-end pt-1">
          <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800">{t('psrc.cancel')}</button>
        </div>
      </div>
    </div>
  );
}

// 基于模板建一个实例（字段与 add* 一致）。供模板编辑弹窗 + 选源弹窗（直接添加）共用。
const OAUTH_SUB_TO_GW = { claude: 'anthropic-paid', codex: 'openai', copilot: 'github-copilot' };

function collectUsedGatewayIds(payg = [], subs = []) {
  const ids = new Set();
  for (const p of payg) {
    if (p.gateway_id) ids.add(p.gateway_id);
    else if (p.provider_id) ids.add(p.provider_id);
  }
  for (const s of subs) {
    if (s.gateway_id) ids.add(s.gateway_id);
    else if (s.source_id) ids.add(s.source_id);
  }
  return ids;
}

function allocateGatewayId(baseId, used, instanceId) {
  if (baseId && !used.has(baseId)) return baseId;
  return `acct-${instanceId}`;
}

function baseGatewayForPayg(providerId) {
  return providerId;
}

function baseGatewayForSubTpl(tpl, isApiSub) {
  if (isApiSub) return tpl.plan_provider_id || tpl.key;
  if (tpl.custom) return tpl.key;
  if (tpl.subscription_to_api) return OAUTH_SUB_TO_GW[tpl.key] || tpl.plan_provider_id || tpl.key;
  return tpl.key;
}

/** 解析账户实例添加时间（毫秒），用于列表按添加顺序排列 */
export function accountInstanceAddedOrder(inst, directBilling = {}) {
  const toMs = (v) => {
    if (v == null) return NaN;
    if (typeof v === 'number') return v;
    const t = Date.parse(v);
    return Number.isNaN(t) ? NaN : t;
  };
  const fromAddedAt = toMs(inst?.added_at);
  if (!Number.isNaN(fromAddedAt)) return fromAddedAt;
  if (inst?.kind === 'direct' && inst?.id) {
    const fromBill = toMs(directBilling[inst.id]?.added_at);
    if (!Number.isNaN(fromBill)) return fromBill;
  }
  // 新实例 id 前缀为 Date.now().toString(36)，可回退解析
  const id = String(inst?.id || inst?.agent_id || '').replace(/^acct-/, '');
  const prefix = id.match(/^([0-9a-z]+)/i)?.[1];
  if (prefix) {
    const n = parseInt(prefix, 36);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

/** 从源模板预填模型列表（保留 modality / type） */
function seedModelsFromTemplate(tpl) {
  const seedModels = [];
  for (const m of tpl?.models || []) {
    if (typeof m === 'string') {
      const mt = tpl.model_types?.[m] || 'chat';
      seedModels.push(mt === 'chat' ? m : { name: m, type: mt });
    } else if (m && typeof m === 'object') {
      const name = m.name || m.id;
      if (name) seedModels.push({ name, type: m.type || m.modality || 'chat' });
    }
  }
  return seedModels;
}

export function buildInstancePatch(tpl, { payg = [], subs = [], planId } = {}) {
  const key = tpl.key;
  const isPayg = tpl.kind === 'payg';
  const isApiSub = tpl.kind === 'api_sub';
  const uid = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const addedAt = Date.now();
  const nextName = (list, kf) => {
    const n = (list || []).filter(x => x[kf] === key).length;
    return n > 0 ? `${tpl.label}_${n + 1}` : tpl.label;
  };
  const usedGw = collectUsedGatewayIds(payg, subs);
  if (isPayg) {
    const instId = uid();
    const gateway_id = allocateGatewayId(baseGatewayForPayg(key), usedGw, instId);
    const seedModels = seedModelsFromTemplate(tpl);
    const inst = {
      id: instId, provider_id: key, gateway_id, label: tpl.label,
      name: nextName(payg, 'provider_id'), icon: tpl.icon, models: seedModels, enabled: true,
      added_at: addedAt,
    };
    return { user_payg_providers: [...payg, inst] };
  }
  const tplPlans = tpl.plans || [];
  const plan = tplPlans.find(p => p.id === planId) || tplPlans[0] || {};
  const instId = uid();
  const needsGateway = isApiSub || tpl.subscription_to_api === true;
  const gateway_id = needsGateway
    ? allocateGatewayId(baseGatewayForSubTpl(tpl, isApiSub), usedGw, instId)
    : `acct-${instId}`;
  // API 订阅与按量一样预填目录模型（如 Kimi Code 的 kimi-for-coding / k3）
  const seedModels = isApiSub ? seedModelsFromTemplate(tpl) : [];
  const inst = {
    id: instId, subscription_kind: isApiSub ? 'api' : 'app', source_id: key, gateway_id,
    name: nextName(subs, 'source_id'), agent_id: isApiSub ? null : (tpl.agent_id || null),
    app_name: tpl.label, app_icon: tpl.icon,
    plan_id: plan.id || 'custom', plan_label: plan.label || plan.id || tpl.label,
    monthly_usd: plan.monthly_usd ?? null,
    subscription_to_api: isApiSub ? true : (tpl.subscription_to_api === true),
    models: seedModels,
    ...(isApiSub ? { plan_provider_id: tpl.plan_provider_id || key } : {}),
    added_at: addedAt,
  };
  return { user_subscriptions: [...subs, inst] };
}

/** 纯 APP 订阅（不可转 API）→ 写入直连源计费，在个人源页「直连源」区展示 */
export function buildDirectSourcePatch(tpl, { billing = {}, planId } = {}) {
  const agentId = tpl.agent_id || tpl.key;
  if (!agentId) return {};
  const plans = tpl.plans || [];
  const plan = (planId && plans.find(p => p.id === planId)) || plans[0] || {};
  return {
    direct_source_billing: {
      ...(billing || {}),
      [agentId]: {
        ...((billing || {})[agentId] || {}),
        mode: 'subscription',
        monthly_usd: plan.monthly_usd ?? null,
        name: tpl.label || agentId,
        plan_id: plan.id || null,
        plan_label: plan.label || null,
        source_id: tpl.key,
        added_at: ((billing || {})[agentId]?.added_at) ?? Date.now(),
      },
    },
  };
}

/** 删除直连源：清除计费登记 */
export function buildDirectSourceRemovePatch(agentId, billing = {}) {
  if (!agentId) return {};
  const next = { ...(billing || {}) };
  delete next[agentId];
  return { direct_source_billing: next };
}

/** 模板是否已配好（UI 提示用）：按量源无预填模型也可直接添加 */
export function templateReadyForInstance(tpl) {
  if (tpl.kind === 'payg') return true;
  if (tpl.kind === 'app_sub' || tpl.kind === 'api_sub') {
    if ((tpl.plans || []).length > 0) return true;
    if (tpl.kind === 'app_sub' && !tpl.subscription_to_api) return true;
  }
  if (Object.keys(tpl.pricing || {}).length > 0) return true;
  if (tpl.kind !== 'payg' && tpl.plan_provider_id) return true;
  return (tpl.models || []).length > 0;
}

// ── 第2块：模板编辑弹窗（写 source_template_overrides）──────────────────────────
export function TemplateEditModal({
  template, overrides, payg = [], subs = [], customTemplates = {}, paygCatalog = [],
  onSave, onClose, onInstanceAdded, t, editOnly = false,
}) {
  const key = template.key;
  const cur = overrides[key] || {};
  const isPayg = template.kind === 'payg';
  const isAppSub = template.kind === 'app_sub';
  const isApiSub = template.kind === 'api_sub';
  const isSub = isAppSub || isApiSub;
  const isCustomTpl = template.custom === true;

  const [subToApi, setSubToApi] = useState(template.subscription_to_api === true);
  // 模型+计费：所有模板（含订阅）都配。订阅模板若指向官方 payg，预填其模型作为「支持的模型」。
  const [pricing, setPricing] = useState(() => {
    const base = { ...(template.pricing || {}) };
    if (isSub && template.plan_provider_id && !Object.keys(base).length) {
      const cat = (paygCatalog || []).find(x => (x.provider_id || x.id) === template.plan_provider_id);
      for (const m of (cat?.models || [])) base[m] = (cat?.pricing && cat.pricing[m]) || {};
    }
    return base;
  });

  // 「添加为我的源」：基于模板实例化（字段与 UserAccountsPanel 的 add* 保持一致）
  const tplPlans = template.plans || [];
  const [planId, setPlanId] = useState(tplPlans[0]?.id || '');
  // 所有模板（含订阅）都必须有支持的模型，才能添加实例
  const tplReady = Object.keys(pricing).length > 0;
  const myInstances = isPayg ? payg.filter(p => p.provider_id === key) : subs.filter(s => s.source_id === key);
  function addInstance() {
    const effectiveTpl = { ...template, pricing, subscription_to_api: subToApi };
    if (isAppSub && !subToApi) {
      onSave(buildDirectSourcePatch(effectiveTpl, { billing: {} }));
    } else {
      onSave(buildInstancePatch(effectiveTpl, { payg, subs, planId }));
      onInstanceAdded?.(key);
    }
  }
  function removeInstance(id) {
    if (isPayg) onSave({ user_payg_providers: payg.filter(p => p.id !== id) });
    else onSave({ user_subscriptions: subs.filter(s => s.id !== id) });
  }

  const rows = Object.keys(pricing).map(m => ({ model: m, ...pricing[m] }));
  const onCell = (model, field, val) => setPricing(p => {
    const next = { ...p, [model]: { ...(p[model] || {}) } };
    if (val === '') delete next[model][field]; else next[model][field] = Number(val);
    return next;
  });
  const onAddModel = (m) => setPricing(p => (p[m] ? p : { ...p, [m]: {} }));
  const onRemoveModel = (m) => setPricing(p => { const n = { ...p }; delete n[m]; return n; });

  function save() {
    if (isCustomTpl) {
      // 自定义模板：直接更新模板本身（custom_source_templates）
      const ct = { ...(customTemplates || {}) };
      ct[key] = {
        ...(ct[key] || {}), kind: template.kind, label: template.label, icon: template.icon,
        pricing, models: Object.keys(pricing), plans: tplPlans,
        subscription_to_api: isAppSub ? subToApi : (ct[key]?.subscription_to_api === true),
      };
      onSave({ custom_source_templates: ct });
    } else {
      // 官方模板：写本地覆盖
      const next = { ...overrides };
      const ov = { ...(cur || {}) };
      ov.pricing = pricing;
      if (isAppSub && isCustomTpl) ov.subscription_to_api = subToApi;
      ov._baseHash = template._serverHash;   // 记录基于哪个服务端模板版本改的（供 diff）
      next[key] = ov;
      onSave({ source_template_overrides: next });
    }
    onClose();
  }
  function reset() {
    if (isCustomTpl) {
      // 自定义模板没有服务端默认 → 删除整个自定义源（模板 + 其实例），删前确认
      const n = payg.filter(p => p.provider_id === key).length + subs.filter(s => s.source_id === key).length;
      if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('psrc.tpl.deleteConfirm', { n }))) return;
      const ct = { ...(customTemplates || {}) };
      delete ct[key];
      onSave({
        custom_source_templates: ct,
        user_payg_providers: payg.filter(p => p.provider_id !== key),
        user_subscriptions: subs.filter(s => s.source_id !== key),
      });
    } else {
      const next = { ...overrides };
      delete next[key];
      onSave({ source_template_overrides: next });
    }
    onClose();
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-700 w-full max-w-md p-5 space-y-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <ServiceIcon id={template.key} name={template.label} icon={template.icon} baseUrl={template.base_url} signupUrl={template.signup_url} />
          <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{t('psrc.tpl.editTitle', { name: template.label })}</h3>
        </div>
        {isAppSub && isCustomTpl && (
          <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
            <input type="checkbox" checked={subToApi} onChange={e => setSubToApi(e.target.checked)} />
            {t('psrc.tpl.subToApi')}
          </label>
        )}
        {isAppSub && !isCustomTpl && (
          <p className="text-xs text-zinc-400">
            {template.subscription_to_api ? t('psrc.tpl.serverSubToApiOn') : t('psrc.tpl.serverSubToApiOff')}
          </p>
        )}
        {/* 模型 + 计费：所有模板都配（订阅模板也要有支持的模型才能加实例）*/}
        <div className="space-y-1">
          <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{isSub ? t('psrc.tpl.subModels') : t('psrc.tpl.pricing')}</p>
          <PricingTable rows={rows} onCell={onCell} onAddModel={onAddModel} onRemoveModel={onRemoveModel} t={t} />
        </div>

        {/* 添加为我的源（实例化此模板）；供给页 billing 模式仅编辑模板，实例在下方添加 */}
        {!editOnly && (
          <div className="space-y-2 pt-2 border-t border-zinc-100 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">{t('psrc.tpl.instances')}</p>
            {myInstances.length === 0 && <p className="text-[11px] text-zinc-400">{t('psrc.tpl.noInstance')}</p>}
            {myInstances.map(inst => (
              <div key={inst.id} className="flex items-center gap-2 text-xs px-2 py-1 rounded-lg bg-zinc-50 dark:bg-zinc-800">
                <span className="flex-1 truncate">
                  {inst.name || inst.label || inst.app_name}
                  {inst.plan_label ? <span className="text-zinc-400"> · {inst.plan_label}</span> : null}
                </span>
                <button type="button" onClick={() => removeInstance(inst.id)} className="text-red-400 hover:text-red-500 px-1">×</button>
              </div>
            ))}
            {!tplReady && <p className="text-[11px] text-amber-500">{t('psrc.tpl.needConfig')}</p>}
            <div className="flex items-center gap-2">
              {isSub && tplPlans.length > 0 && (
                <select value={planId} onChange={e => setPlanId(e.target.value)}
                  className="flex-1 text-xs bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-2 py-1.5">
                  {tplPlans.map(p => (
                    <option key={p.id} value={p.id}>{p.label}{p.monthly_usd != null ? ` · $${p.monthly_usd}/mo` : ''}</option>
                  ))}
                </select>
              )}
              <button type="button" onClick={addInstance} disabled={!tplReady}
                className="text-xs px-3 py-1.5 rounded-lg border border-dashed border-blue-300 dark:border-blue-700 text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40 disabled:cursor-not-allowed">
                + {t('psrc.tpl.addInstance')}
              </button>
            </div>
          </div>
        )}

        <div className="flex justify-between gap-2 pt-1">
          <button type="button" onClick={reset} className="text-xs text-zinc-400 hover:text-red-500">{isCustomTpl ? t('psrc.tpl.deleteCustom') : t('psrc.tpl.reset')}</button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800">{t('psrc.cancel')}</button>
            <button type="button" onClick={save} className="text-xs px-3 py-1.5 rounded-lg bg-blue-500 text-white">{t('psrc.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 同步差异 Banner ────────────────────────────────────────────────────────────
export function SyncDiffBanner({ syncDiff, onAdoptServer, onDismissDrift, t }) {
  const migrations = syncDiff?.migrations || [];
  const drifts = syncDiff?.overrideDrifts || [];
  if (!migrations.length && !drifts.length) return null;
  return (
    <div className="space-y-2">
      {migrations.map(m => (
        <div key={m.instanceId} className="text-xs px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800/40">
          {t('psrc.diff.migrate', { name: m.label })}
        </div>
      ))}
      {drifts.map(d => (
        <div key={d.templateKey} className="text-xs px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800/40 space-y-1">
          <div className="font-medium">{t('psrc.diff.drift', { name: d.label })}{d.serverChanged ? ' · ' + t('psrc.diff.serverChanged') : ''}</div>
          <ul className="ml-3 list-disc space-y-0.5">
            {d.changedFields.map((f, i) => (
              <li key={i}>{f.field}{f.model ? `(${f.model})` : ''}: {t('psrc.diff.mine')} {JSON.stringify(f.mine)} / {t('psrc.diff.server')} {JSON.stringify(f.server)}</li>
            ))}
          </ul>
          <div className="flex gap-2 pt-0.5">
            <button type="button" onClick={() => onAdoptServer(d.templateKey)} className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-800/40">{t('psrc.diff.adopt')}</button>
            <button type="button" onClick={() => onDismissDrift(d.templateKey)} className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800">{t('psrc.diff.keep')}</button>
          </div>
        </div>
      ))}
    </div>
  );
}
