// Agent 左侧竖排列表：聚合入口 + 各 Agent；可指定主 Agent（编排层）
// 选中态遵循材料层次：侧栏偏重、Hub 用实心强调色、条目用抬升面（非描边）
// 右缘可左右拖动调宽（记忆到 localStorage）
import React, { useCallback, useRef, useState } from 'react';
import { resolveBrandIcon } from '../lib/brandIcons';
import KimiAvatar from './KimiAvatar';
import { useLang } from '../store/lang';

/** 未命中品牌时的文字回退 */
const FALLBACK_ICON = {
  'claude-code': 'CC',
  codex: 'CX',
  cursor: 'CR',
  'kimi-code': 'KM',
  assistant: 'AG',
};

const SIDEBAR_W_KEY = 'tokenbank.debug.agentSidebarWidth';
const SIDEBAR_W_DEFAULT = 176; // ≈ Tailwind w-44
const SIDEBAR_W_MIN = 140;
const SIDEBAR_W_MAX = 360;

function readSidebarWidth() {
  try {
    const v = Number(localStorage.getItem(SIDEBAR_W_KEY));
    if (Number.isFinite(v) && v >= SIDEBAR_W_MIN && v <= SIDEBAR_W_MAX) return Math.round(v);
  } catch { /* ignore */ }
  return SIDEBAR_W_DEFAULT;
}

function clampSidebarWidth(w) {
  const max = Math.min(SIDEBAR_W_MAX, Math.floor(window.innerWidth * 0.45));
  return Math.max(SIDEBAR_W_MIN, Math.min(max, Math.round(w)));
}

/** 内置 Agent 用品牌 logo；自定义智能体保持文字回退 */
function AgentBrandIcon({ agent, isCustom }) {
  if (isCustom) {
    return <span className="text-[9px] font-mono leading-none text-zinc-500">{FALLBACK_ICON.assistant}</span>;
  }
  // Kimi 用组件渲染（与 @lobehub/icons Kimi.Avatar 同构），避免 img 裂图
  if (/kimi|moonshot/i.test(`${agent.id || ''} ${agent.name || ''}`)) {
    return <KimiAvatar size={14} />;
  }
  const brand = resolveBrandIcon(`${agent.id || ''} ${agent.name || ''}`);
  if (brand) {
    return (
      <img
        src={brand}
        alt=""
        className="w-3.5 h-3.5 object-contain"
        draggable={false}
      />
    );
  }
  return <span className="text-[9px] font-mono leading-none text-zinc-500">{FALLBACK_ICON[agent.id] || 'AG'}</span>;
}

/** 运行中提示：实心绿点（无 ping，避免监控态抢注意力） */
function RunningDot({ label }) {
  return (
    <span className="tb-live-dot" title={label} aria-label={label} />
  );
}

/** 按下即时反馈；颜色变化短、无弹跳 */
const pressCls = 'tb-press';

export default function AgentTabBar({
  agents,
  selectedAgent,
  mainAgentId,
  onSelect,
  onSetMainAgent,
  loading,
  /** Set / 数组：正在执行的 session key（含 __hub__） */
  runningKeys,
  /** 游乐场一键安装 Cursor Agent CLI */
  onInstallCursorCli,
  installingCursorCli,
}) {
  const { t } = useLang();
  const [width, setWidth] = useState(readSidebarWidth);
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  // 右缘拖拽：向右拉变宽，向左拉变窄
  const onResizeStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthRef.current;
    setDragging(true);
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev) => {
      const next = clampSidebarWidth(startW + (ev.clientX - startX));
      widthRef.current = next;
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      setDragging(false);
      try { localStorage.setItem(SIDEBAR_W_KEY, String(widthRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const running = runningKeys instanceof Set
    ? runningKeys
    : new Set(Array.isArray(runningKeys) ? runningKeys : []);

  const shellCls = `relative shrink-0 flex min-h-0 ${dragging ? 'select-none' : ''}`;
  // 隐式拖拽热区：无蓝线/分割条，仅 cursor 提示可左右调宽
  const resizeHandle = (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_W_MIN}
      aria-valuemax={SIDEBAR_W_MAX}
      aria-label={t('debug.preview.resize')}
      title={t('debug.preview.resize')}
      onMouseDown={onResizeStart}
      className="absolute right-0 top-0 bottom-0 z-10 w-2 translate-x-1/2 cursor-col-resize bg-transparent"
    />
  );

  if (loading) {
    return (
      <div className={shellCls} style={{ width }}>
        <aside className="w-full border-r border-white/40 dark:border-white/[0.06] bg-white/25 dark:bg-zinc-950/40 backdrop-blur-xl p-2 space-y-1.5 animate-pulse">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-8 w-full bg-zinc-200/80 dark:bg-zinc-800 rounded-lg" />
          ))}
        </aside>
        {resizeHandle}
      </div>
    );
  }

  if (!agents?.length) {
    return (
      <div className={shellCls} style={{ width }}>
        <aside className="w-full border-r border-white/40 dark:border-white/[0.06] bg-white/25 dark:bg-zinc-950/40 backdrop-blur-xl p-3">
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {t('debug.tabs.noAgents')}
          </p>
        </aside>
        {resizeHandle}
      </div>
    );
  }

  const mainAgent = agents.find(a => a.id === mainAgentId && !a.custom && a.type !== 'assistant' && a.installed !== false);
  const hubActive = !selectedAgent;

  return (
    /* 侧栏：偏重材料，与主内容玻璃顶栏分层，避免轻材质叠轻材质 */
    <div className={shellCls} style={{ width }}>
    <aside className="w-full border-r border-white/40 dark:border-white/[0.06] bg-white/25 dark:bg-zinc-950/40 backdrop-blur-xl flex flex-col min-h-0 min-w-0">
      <div className="shrink-0 px-3 pt-4 pb-2">
        <p className="text-[10px] font-semibold tracking-[0.04em] text-zinc-500 dark:text-zinc-400">
          {t('debug.tabs.agents')}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5 tb-scroll-layer">
        {/* Hub：选中与列表项同一玻璃高亮，避免实心蓝跳出体系 */}
        <button
          type="button"
          onClick={() => onSelect(null)}
          className={`
            w-full flex items-center gap-1.5 text-left px-2.5 py-1.5 text-[12px] rounded-lg ${pressCls}
            ${hubActive
              ? 'tb-soft-bubble text-zinc-900 dark:text-zinc-100 font-medium'
              : 'text-zinc-800 dark:text-zinc-200 font-medium hover:bg-black/[0.05] dark:hover:bg-white/[0.06]'
            }
          `}
        >
          <span className="min-w-0 flex-1 truncate">{t('debug.tabs.hub')}</span>
          {running.has('__hub__') && <RunningDot label={t('debug.tabs.orchestrating')} />}
        </button>
        {mainAgent && hubActive && (
          <p className="px-2.5 pt-1 pb-2 text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
            {t('debug.tabs.mainDispatch', { name: mainAgent.name })}
          </p>
        )}

        {/* 分隔用留白+细线，弱化硬分割 */}
        <div className="mx-1.5 my-2.5 border-t border-zinc-200/90 dark:border-zinc-800" />

        {agents.map(agent => {
          const active = selectedAgent?.id === agent.id;
          const isMain = agent.id === mainAgentId && !agent.custom;
          const isCommunity = agent.type === 'community' || !!agent.community;
          const isCustom = !isCommunity && (agent.custom || agent.type === 'assistant');
          const isRunning = running.has(agent.id);
          // 内置 CLI 未安装 → 灰色（对齐网关工具箱）
          const missing = !isCustom && !isCommunity && agent.installed === false;
          // Cursor：缺独立 Agent CLI（可一键装）；IDE 已装时文案更明确
          const cursorNeedCli = missing && agent.id === 'cursor' && !!agent.canInstallCli;
          const installing = cursorNeedCli && !!installingCursorCli;
          const subLine = missing
            ? (cursorNeedCli ? t('debug.tabs.cursorNeedCli') : t('debug.tabs.notInstalled'))
            : isCommunity
              ? t('debug.tabs.communityRemote')
              : (isCustom && agent.runtimeName)
                ? `→ ${agent.runtimeName}`
                : (!isCustom && agent.version ? `v${agent.version}` : '');
          return (
            <div key={agent.id} className={`relative group ${missing && !cursorNeedCli ? 'opacity-45' : ''}`}>
              <button
                type="button"
                onClick={() => onSelect(agent)}
                title={
                  missing
                    ? (cursorNeedCli
                      ? t('debug.tabs.cursorNeedCliHint')
                      : t('debug.tabs.notInstalledHint', { name: agent.name }))
                    : isCommunity
                    ? (agent.description || t('debug.tabs.communityHint'))
                    : isCustom && agent.runtimeName
                    ? (agent.execRuntimeName && agent.execRuntimeName !== agent.runtimeName
                      ? t('debug.tabs.projectExec', { name: agent.runtimeName, exec: agent.execRuntimeName })
                      : t('debug.tabs.projectTo', { name: agent.runtimeName }))
                    : agent.description
                }
                className={`
                  w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-lg ${pressCls}
                  ${missing ? 'grayscale' : ''}
                  ${active
                    ? 'tb-soft-bubble text-zinc-900 dark:text-zinc-100 font-medium'
                    : 'text-zinc-600 dark:text-zinc-400 font-medium hover:bg-black/[0.05] dark:hover:bg-white/[0.06] hover:text-zinc-900 dark:hover:text-zinc-200'
                  }
                `}
              >
                <span className={`relative shrink-0 flex items-center justify-center w-3.5 h-3.5 ${missing ? 'grayscale' : ''}`}>
                  <AgentBrandIcon agent={agent} isCustom={isCustom || isCommunity} />
                </span>
                <span className="min-w-0 flex-1 text-left">
                  <span className="flex items-center gap-1 min-w-0 leading-tight">
                    <span className="truncate">{agent.name}</span>
                    {isCommunity && (
                      <span className="shrink-0 text-[10px] px-1 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                        {t('debug.tabs.communityBadge')}
                      </span>
                    )}
                    {isMain && !missing && (
                      <span className="shrink-0 text-[10px] text-amber-500" title={t('debug.tabs.mainAgent')}>★</span>
                    )}
                  </span>
                  {subLine ? (
                    <span className={`block text-[10px] font-normal truncate mt-0.5 leading-tight ${
                      missing
                        ? 'text-zinc-400 dark:text-zinc-500'
                        : active ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'
                    }`}>
                      {subLine}
                    </span>
                  ) : null}
                </span>
                {isRunning && <RunningDot label={t('debug.tabs.runningNamed', { name: agent.name })} />}
              </button>
              {cursorNeedCli && onInstallCursorCli && (
                <button
                  type="button"
                  disabled={installing}
                  title={t('debug.tabs.installCliTitle')}
                  onClick={(e) => {
                    e.stopPropagation();
                    onInstallCursorCli();
                  }}
                  className={`mt-1 w-full text-[10px] py-1 rounded-md font-medium ${pressCls}
                    bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-60`}
                >
                  {installing ? t('debug.tabs.installingCli') : t('debug.tabs.installCli')}
                </button>
              )}
              {!isMain && !isCustom && !isCommunity && !missing && onSetMainAgent && (
                <button
                  type="button"
                  title={t('debug.tabs.setMain', { name: agent.name })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetMainAgent(agent);
                  }}
                  className={`absolute top-1.5 right-1.5 w-5 h-5 text-[10px] leading-none rounded-md
                    bg-zinc-50 dark:bg-zinc-900 border border-zinc-200/80 dark:border-zinc-700
                    text-zinc-400 hover:text-amber-500 hover:border-amber-400
                    opacity-0 group-hover:opacity-100 ${pressCls}`}
                >
                  ☆
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 底栏：结构区轻提示，无抢戏 */}
      {mainAgent && selectedAgent && (
        <div className="shrink-0 px-3 py-2.5 border-t border-zinc-200/90 dark:border-zinc-800 text-[10px] text-zinc-500 dark:text-zinc-400 leading-snug">
          {t('debug.tabs.mainFooter', { name: mainAgent.name })}
        </div>
      )}
    </aside>
    {resizeHandle}
    </div>
  );
}
