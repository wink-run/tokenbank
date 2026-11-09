import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** 类型色板:推荐 / 已纳管 / 目录卡片共用(与 Resources 原视觉一致) */
export function typeVisual(type) {
  const map = {
    prompt: {
      icon: '✎',
      tile: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
      chip: 'bg-amber-50/80 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
    },
    skill: {
      icon: '⚡',
      tile: 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
      chip: 'bg-sky-50/80 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300',
    },
    assistant: {
      icon: '◇',
      tile: 'bg-violet-50 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
      chip: 'bg-violet-50/80 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300',
    },
  };
  return map[type] || {
    icon: '·',
    tile: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
    chip: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  };
}

/** 稳定哈希 → 智能体人像配色 */
function hashSeed(seed) {
  let h = 0;
  const s = String(seed || 'agent');
  for (let i = 0; i < s.length; i++) h = (s.charCodeAt(i) + ((h << 5) - h)) | 0;
  return Math.abs(h);
}

const PERSON_SKINS = ['#F5C6A5', '#E8B896', '#D4A574', '#C68642', '#8D5524', '#FFDBAC'];
const PERSON_HAIRS = ['#1C1917', '#292524', '#44403C', '#78350F', '#92400E', '#A16207', '#B45309'];
const PERSON_SHIRTS = ['#3B82F6', '#6366F1', '#8B5CF6', '#0D9488', '#059669', '#D97706', '#E11D48'];
const PERSON_BGS = ['#F4F4F5', '#EEF2FF', '#F0FDFA', '#FFF7ED', '#FDF2F8', '#F5F3FF'];

function toSvgDataUri(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 本地 SVG 人像头像（按 name/id 稳定生成，无需外网）。
 * 圆脸 + 发型变体 + 肩线，一眼是「人」而不是菱形占位。
 */
export function assistantAvatarDataUri(seed) {
  const h = hashSeed(seed);
  const skin = PERSON_SKINS[h % PERSON_SKINS.length];
  const hair = PERSON_HAIRS[(h >> 3) % PERSON_HAIRS.length];
  const shirt = PERSON_SHIRTS[(h >> 6) % PERSON_SHIRTS.length];
  const bg = PERSON_BGS[(h >> 9) % PERSON_BGS.length];
  const style = h % 3; // 0 短发 / 1 侧分 / 2 蓬松
  const hairPath = style === 0
    ? 'M10 16c0-7 4.5-11 10-11s10 4 10 11v2c-2.5-3-6-4.5-10-4.5S12.5 15 10 18v-2z'
    : style === 1
      ? 'M9 17c1-8 5-12.5 11-12.5 5.5 0 9.5 3.5 10.5 10.5-3-1.5-5.5-2-8-2-3.5 0-7 1.2-13.5 4z'
      : 'M8 18c.5-8 5-13 12-13s11.5 5 12 13c-2-4-5.5-6-12-6s-10 2-12 6z';
  return toSvgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" fill="${bg}"/>
    <ellipse cx="20" cy="38" rx="14" ry="10" fill="${shirt}"/>
    <circle cx="20" cy="17" r="8.5" fill="${skin}"/>
    <path d="${hairPath}" fill="${hair}"/>
    <circle cx="16.8" cy="17.2" r="0.9" fill="#44403C" opacity=".55"/>
    <circle cx="23.2" cy="17.2" r="0.9" fill="#44403C" opacity=".55"/>
    <path d="M17.5 21c1.2 1.2 3.8 1.2 5 0" stroke="#B45309" stroke-width="0.9" stroke-linecap="round" opacity=".35"/>
  </svg>`);
}

const SKILL_PALETTES = [
  { bg: '#E0F2FE', ink: '#0369A1', accent: '#0EA5E9' },
  { bg: '#ECFEFF', ink: '#0E7490', accent: '#06B6D4' },
  { bg: '#EEF2FF', ink: '#4338CA', accent: '#6366F1' },
  { bg: '#F0FDF4', ink: '#15803D', accent: '#22C55E' },
  { bg: '#F5F3FF', ink: '#6D28D9', accent: '#8B5CF6' },
  { bg: '#FFF7ED', ink: '#C2410C', accent: '#F97316' },
];

const PROMPT_PALETTES = [
  { bg: '#FFFBEB', ink: '#B45309', accent: '#F59E0B' },
  { bg: '#FFF7ED', ink: '#C2410C', accent: '#FB923C' },
  { bg: '#FEF3C7', ink: '#A16207', accent: '#EAB308' },
  { bg: '#FDF2F8', ink: '#BE185D', accent: '#F472B6' },
  { bg: '#F5F3FF', ink: '#7C3AED', accent: '#A78BFA' },
  { bg: '#ECFDF5', ink: '#047857', accent: '#34D399' },
];

/**
 * 技能图标：能力/模块/工具等复合符号（按 seed 选变体）。
 * 0 闪电徽章 · 1 拼图模块 · 2 扳手火花 · 3 层叠流水线 · 4 齿轮勾选 · 5 终端光标
 */
export function skillIconDataUri(seed) {
  const h = hashSeed(seed);
  const { bg, ink, accent } = SKILL_PALETTES[h % SKILL_PALETTES.length];
  const v = h % 6;
  let glyph = '';
  if (v === 0) {
    // 六边形 + 闪电
    glyph = `<path d="M20 6l10 5.5v11L20 28l-10-5.5v-11L20 6z" stroke="${ink}" stroke-width="1.6" fill="${accent}" fill-opacity=".18"/>
      <path d="M21.5 13l-5 7h4l-1.5 7 6.5-9h-4l2-5z" fill="${ink}"/>`;
  } else if (v === 1) {
    // 拼图
    glyph = `<path d="M12 14h6c0-2.2 1.8-3.5 3.2-3.5S24.5 11.8 24.5 14H28v6c2.2 0 3.5 1.8 3.5 3.2S30.2 26.5 28 26.5V30H14c-1.1 0-2-.9-2-2V14z" fill="${accent}" fill-opacity=".25" stroke="${ink}" stroke-width="1.5"/>
      <circle cx="18.5" cy="20.5" r="1.4" fill="${ink}"/>`;
  } else if (v === 2) {
    // 扳手 + 火花
    glyph = `<path d="M24 10a5 5 0 0 0-6.7 6.1L10 23.4 12.6 26l7.3-7.3A5 5 0 0 0 24 10z" fill="${accent}" fill-opacity=".3" stroke="${ink}" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M27 13l2.2-1 .8 2.2 2-1.2-.2 2.4 2.4.4-2 1.5 1.2 2.1-2.3-.6-.6 2.3-1.4-2-2.3.8.8-2.3-2.1-1.2 2.4-.6z" fill="${ink}"/>`;
  } else if (v === 3) {
    // 三层堆叠
    glyph = `<rect x="10" y="10" width="20" height="5.5" rx="1.5" fill="${accent}" fill-opacity=".35" stroke="${ink}" stroke-width="1.4"/>
      <rect x="12" y="17.25" width="16" height="5.5" rx="1.5" fill="${accent}" fill-opacity=".55" stroke="${ink}" stroke-width="1.4"/>
      <rect x="14" y="24.5" width="12" height="5.5" rx="1.5" fill="${ink}"/>`;
  } else if (v === 4) {
    // 齿轮 + 勾
    glyph = `<circle cx="18" cy="19" r="5.5" fill="${accent}" fill-opacity=".25" stroke="${ink}" stroke-width="1.5"/>
      <circle cx="18" cy="19" r="2.2" fill="${ink}"/>
      <path d="M18 10.5v2.2M18 25.3v2.2M10.5 19h2.2M23.3 19h2.2M12.7 13.7l1.5 1.5M21.8 22.8l1.5 1.5M12.7 24.3l1.5-1.5M21.8 15.2l1.5-1.5" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M25 24.5l2 2 4-4.5" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  } else {
    // 终端窗口 + 光标
    glyph = `<rect x="9" y="11" width="22" height="18" rx="2.5" fill="${accent}" fill-opacity=".2" stroke="${ink}" stroke-width="1.5"/>
      <path d="M13 17l3.5 2.5L13 22" stroke="${ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M19 22h7" stroke="${ink}" stroke-width="1.6" stroke-linecap="round"/>`;
  }
  return toSvgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="10" fill="${bg}"/>
    ${glyph}
  </svg>`);
}

/**
 * 提示词图标：文稿/对话/引用等复合符号。
 * 0 文稿+笔 · 1 对话气泡 · 2 引用卡片 · 3 卷轴火花 · 4 双气泡 · 5 记事本
 */
export function promptIconDataUri(seed) {
  const h = hashSeed(seed);
  const { bg, ink, accent } = PROMPT_PALETTES[h % PROMPT_PALETTES.length];
  const v = h % 6;
  let glyph = '';
  if (v === 0) {
    glyph = `<rect x="11" y="9" width="15" height="20" rx="2" fill="${accent}" fill-opacity=".22" stroke="${ink}" stroke-width="1.5"/>
      <path d="M14.5 15h8M14.5 19h8M14.5 23h5" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M24 22l5.5 5.5c.6.6.6 1.5 0 2.1l-1.4 1.4c-.6.6-1.5.6-2.1 0L20.5 25.5V22H24z" fill="${accent}" stroke="${ink}" stroke-width="1.3" stroke-linejoin="round"/>`;
  } else if (v === 1) {
    glyph = `<path d="M10 12.5c0-1.4 1.1-2.5 2.5-2.5h15c1.4 0 2.5 1.1 2.5 2.5v10c0 1.4-1.1 2.5-2.5 2.5H18l-4.5 4v-4H12.5c-1.4 0-2.5-1.1-2.5-2.5v-10z" fill="${accent}" fill-opacity=".25" stroke="${ink}" stroke-width="1.5"/>
      <path d="M15 16h10M15 20h7" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>`;
  } else if (v === 2) {
    glyph = `<rect x="9" y="10" width="22" height="20" rx="3" fill="${accent}" fill-opacity=".2" stroke="${ink}" stroke-width="1.5"/>
      <path d="M14 16c0-2 1.2-3.2 3-3.2v2.1c-.8 0-1.3.5-1.3 1.3H18v6h-4v-6.2zM22 16c0-2 1.2-3.2 3-3.2v2.1c-.8 0-1.3.5-1.3 1.3H26v6h-4v-6.2z" fill="${ink}"/>`;
  } else if (v === 3) {
    glyph = `<path d="M12 11h12a3 3 0 0 1 3 3v14l-3-2-3 2-3-2-3 2-3-2V14a3 3 0 0 1 3-3z" fill="${accent}" fill-opacity=".25" stroke="${ink}" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M16 17h8M16 21h6" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>
      <path d="M28.5 12.5l1.2-2.4 1.2 2.4 2.5.3-1.9 1.7.6 2.5-2.4-1.4-2.4 1.4.6-2.5-1.9-1.7z" fill="${accent}"/>`;
  } else if (v === 4) {
    glyph = `<rect x="8" y="12" width="15" height="11" rx="2.5" fill="${accent}" fill-opacity=".35" stroke="${ink}" stroke-width="1.4"/>
      <rect x="17" y="17" width="15" height="11" rx="2.5" fill="${bg}" stroke="${ink}" stroke-width="1.5"/>
      <path d="M20.5 21.5h8M20.5 24.5h5" stroke="${ink}" stroke-width="1.3" stroke-linecap="round"/>`;
  } else {
    glyph = `<rect x="11" y="8" width="18" height="24" rx="2.5" fill="${accent}" fill-opacity=".2" stroke="${ink}" stroke-width="1.5"/>
      <rect x="14" y="11" width="12" height="3" rx="1" fill="${ink}" opacity=".35"/>
      <path d="M15 18h10M15 22h10M15 26h7" stroke="${ink}" stroke-width="1.4" stroke-linecap="round"/>`;
  }
  return toSvgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="10" fill="${bg}"/>
    ${glyph}
  </svg>`);
}

/** 按类型生成默认图标 data URI；自定义 URL 时不走这里 */
export function assetIconDataUri(type, seed) {
  if (type === 'assistant') return assistantAvatarDataUri(seed);
  if (type === 'skill') return skillIconDataUri(seed);
  if (type === 'prompt') return promptIconDataUri(seed);
  return '';
}

/** 优先 metadata.icon(URL);否则按类型生成有含义的本地 SVG */
export function AssetLogo({ type, icon, name }) {
  const visual = typeVisual(type);
  const raw = String(icon || '').trim();
  const isUrl = /^https?:\/\//i.test(raw) || raw.startsWith('data:');
  const seed = name || raw || type || 'asset';
  // 有真实图片 URL 则用 URL；否则技能/提示词/智能体都走复合 SVG
  const generated = !isUrl ? assetIconDataUri(type, seed) : '';
  const imgSrc = isUrl ? raw : generated;
  const round = type === 'assistant';

  return (
    <span
      className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden ${
        round ? 'rounded-full' : 'rounded-xl'
      } ${
        imgSrc
          ? 'bg-zinc-100 dark:bg-zinc-800 ring-1 ring-zinc-200/70 dark:ring-zinc-700/70'
          : visual.tile
      }`}
      aria-hidden
    >
      {imgSrc ? (
        <img
          src={imgSrc}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="text-sm leading-none">{raw || visual.icon}</span>
      )}
    </span>
  );
}

export const ASSET_CARD_CLASS =
  'tb-soft-tile group rounded-2xl px-4 py-3.5';

/** 路径展示：把用户主目录折叠成 ~，完整路径放 title */
export function shortenHomePath(p) {
  return String(p || '').replace(/^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/, '~');
}

/**
 * 卡片「⋯」更多菜单：低频 / 危险操作收纳于此，卡片只露出主操作。
 * 菜单 portal 到 body 并按按钮位置 fixed 定位（列表滚动容器会裁切 absolute 弹层），空间不足时向上弹出。
 * items: [{ key, label, onClick, danger?, disabled?, title? }]
 */
export function AssetMoreMenu({ items, label = 'More' }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const menuRef = useRef(null);
  const list = (items || []).filter(Boolean);

  useEffect(() => {
    if (!pos) return undefined;
    const close = (e) => {
      if (menuRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setPos(null);
    };
    const onKey = (e) => { if (e.key === 'Escape') setPos(null); };
    const onScroll = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [pos]);

  if (!list.length) return null;

  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const menuH = list.length * 34 + 10;
    const up = r.bottom + menuH + 8 > window.innerHeight;
    setPos({ right: Math.max(8, window.innerWidth - r.right), top: up ? undefined : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : undefined });
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        title={label}
        aria-label={label}
        className={`${ASSET_BTN_GHOST} !px-2.5 tracking-widest`}
      >
        ⋯
      </button>
      {pos && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ position: 'fixed', right: pos.right, top: pos.top, bottom: pos.bottom }}
          className="electron-no-drag z-[10040] min-w-[9rem] py-1 rounded-xl border border-zinc-200/90 dark:border-zinc-700 bg-white dark:bg-zinc-900 shadow-lg"
        >
          {list.map(it => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.title}
              onClick={() => { setPos(null); it.onClick?.(); }}
              className={`block w-full text-left text-xs px-3 py-2 disabled:opacity-45 transition-colors ${
                it.danger
                  ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
                  : 'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800'
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export const ASSET_BTN_PRIMARY =
  'tb-press text-xs px-3.5 py-1.5 rounded-xl bg-blue-600 text-white shadow-sm shadow-blue-600/20 '
  + 'hover:bg-blue-500 disabled:opacity-45 disabled:shadow-none transition-colors';

export const ASSET_BTN_MANAGED =
  'text-xs px-3.5 py-1.5 rounded-xl border border-blue-200/90 dark:border-blue-800/80 '
  + 'bg-blue-50/90 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 '
  + 'disabled:opacity-70 cursor-default';

export const ASSET_BTN_GHOST =
  'tb-press text-xs px-3.5 py-1.5 rounded-xl border border-zinc-200/90 dark:border-zinc-700 '
  + 'text-zinc-600 dark:text-zinc-300 bg-white/80 dark:bg-zinc-900/60 '
  + 'hover:bg-zinc-50 dark:hover:bg-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-600 '
  + 'disabled:opacity-45 transition-colors';

/**
 * 统一展示名:技能固定用 name/slug(与落库一致);其它优先 display_name。
 */
export function resourceDisplayName(type, item) {
  if (!item) return '';
  if (type === 'skill') return String(item.name || item.slug || '').trim();
  return String(item.display_name || item.name || item.slug || '').trim();
}

/** 统一说明（卡片上的一句简介） */
export function resourceDescription(item) {
  return String(item?.description || '').trim();
}

/**
 * 详细介绍：特点和用法。卡片不展示这段。
 * 作者写在 detail / metadata.detail 里的优先；否则从正文整理。
 * 与 server/community_catalog.py 的 resource_detail 对齐。
 */
export function resourceDetailText(item) {
  const explicit = String(item?.detail || item?.metadata?.detail || '').trim();
  if (explicit) return explicit.slice(0, 4000);
  const type = item?.type === 'agent' ? 'assistant' : (item?.type || '');
  const desc = String(item?.description || '').trim();
  const raw = String(item?.content || item?.soul || '').trim();
  if (type === 'skill') {
    return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').trim().slice(0, 4000);
  }
  if (type === 'assistant') {
    let soul = '';
    let skills = [];
    let prompts = [];
    try {
      const obj = JSON.parse(raw || '{}');
      soul = String(obj?.soul || obj?.system_prompt || obj?.systemPrompt || '').trim();
      skills = (obj?.skills || []).map((x) => String(x || '').trim()).filter(Boolean);
      prompts = (obj?.prompts || []).map((x) => String(x || '').trim()).filter(Boolean);
    } catch {
      soul = raw;
    }
    const lines = [];
    if (soul) lines.push('特点', soul);
    if (skills.length || prompts.length) {
      lines.push('', '用法', '在客户端纳管后直接对话即可。');
      if (skills.length) lines.push(`已搭配技能：${skills.join('、')}`);
      if (prompts.length) lines.push(`已搭配提示词：${prompts.join('、')}`);
    }
    return lines.join('\n').trim().slice(0, 4000);
  }
  if (type === 'prompt') {
    const names = [];
    const re = /\{\{\s*#?(?:if|unless)?\s*([A-Za-z_][\w]*)/g;
    let m = re.exec(raw);
    while (m) {
      if (m[1] && !names.includes(m[1])) names.push(m[1]);
      m = re.exec(raw);
    }
    const lines = [];
    if (desc) lines.push('特点', desc);
    lines.push('', '用法');
    lines.push(names.length
      ? `纳管后选用这条提示词，补上：${names.join('、')}。`
      : '纳管后直接选用，把要处理的内容发给智能体即可。');
    if (raw) lines.push('', raw.slice(0, 2500));
    const text = lines.join('\n').trim();
    if (text === '用法\n纳管后直接选用，把要处理的内容发给智能体即可。') return '';
    return text.slice(0, 4000);
  }
  return '';
}

/** 详情里要展示的介绍。和卡片简介完全一样时不重复。 */
export function resourceIntro(item) {
  const text = resourceDetailText(item);
  const desc = resourceDescription(item);
  if (!text || text === desc) return '';
  return text;
}

/**
 * 预览正文:优先 content/soul,智能体 JSON 美化;否则回退说明。
 */
export function buildPreviewText(type, item) {
  const soul = String(item?.soul || '').trim();
  let raw = String(item?.content || '').trim() || soul;
  if (!raw) return resourceDescription(item);
  if (type === 'assistant') {
    try {
      const obj = JSON.parse(raw);
      return JSON.stringify(obj, null, 2).slice(0, 8000);
    } catch {
      // soul 纯文本或非 JSON
      return raw.slice(0, 8000);
    }
  }
  return raw.slice(0, 8000);
}

/**
 * 统一资源卡片壳体:图标 + 标题 + 类型徽标 + 说明 + 可选预览区。
 * actions / meta 由调用方注入(投射、匹配理由、安装按钮等)。
 */
export default function ResourceAssetCard({
  type,
  item,
  typeLabel,
  categoryLabel,
  badges,
  description,
  meta,
  actions,
  className = '',
  expanded = false,
  onTogglePreview,
  previewText,
  emptyPreviewLabel = '',
  previewLabel = 'Preview',
  collapseLabel = 'Collapse',
  showPreviewBtn = true,
  // row/col：操作条贴卡片底横排（避免右侧竖堆）；stack：目录/推荐卡内贴底
  layout = 'row',
}) {
  const visual = typeVisual(type);
  const title = resourceDisplayName(type, item);
  const desc = description != null ? String(description).trim() : resourceDescription(item);
  const intro = resourceIntro(item);
  const detail = previewText != null ? String(previewText) : (intro || buildPreviewText(type, item));
  const icon = item?.icon || item?.metadata?.icon;
  const stacked = layout === 'stack';
  const hasActions = !!(actions || (showPreviewBtn && onTogglePreview));
  // stack：贴卡片底；row：宽屏放在内容右侧一行（按钮已精简为 预览 / 主操作 / ⋯），窄屏换到下方
  const actionsCls = stacked
    ? 'flex shrink-0 flex-wrap gap-1.5 justify-end pt-1 mt-auto'
    : 'flex shrink-0 flex-wrap items-center justify-end gap-1.5 sm:flex-nowrap';

  const actionBar = hasActions ? (
    <div className={actionsCls}>
      {showPreviewBtn && onTogglePreview && (
        <button type="button" className={ASSET_BTN_GHOST} onClick={onTogglePreview}>
          {expanded ? collapseLabel : previewLabel}
        </button>
      )}
      {actions}
    </div>
  ) : null;

  return (
    <div className={`${ASSET_CARD_CLASS}${stacked ? ' h-full flex flex-col' : ''}${className ? ` ${className}` : ''}`}>
      <div className={`flex gap-3 ${stacked ? 'flex-col flex-1 min-h-0' : 'flex-col sm:flex-row sm:items-start'}`}>
        <div className="flex min-w-0 flex-1 gap-3">
          <AssetLogo type={type} icon={icon} name={title || item?.id || item?.slug} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {onTogglePreview ? (
                <button
                  type="button"
                  className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 truncate text-left hover:text-violet-700 dark:hover:text-violet-300 transition-colors"
                  title={previewLabel}
                  onClick={onTogglePreview}
                >
                  {title}
                </button>
              ) : (
                <span className="text-[13px] font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 truncate" title={title}>
                  {title}
                </span>
              )}
              {typeLabel && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${visual.chip}`}>
                  {typeLabel}
                </span>
              )}
              {categoryLabel && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 whitespace-nowrap">
                  {categoryLabel}
                </span>
              )}
              {badges}
            </div>
            {desc ? (
              <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400 mt-1.5 line-clamp-2">{desc}</p>
            ) : null}
            {meta}
          </div>
        </div>
        {actionBar}
      </div>
      {expanded && (
        <pre className="mt-3.5 text-[11px] leading-relaxed p-3.5 rounded-xl border border-zinc-100 dark:border-zinc-800 bg-zinc-50/90 dark:bg-zinc-950 text-zinc-600 dark:text-zinc-300 overflow-x-auto max-h-64 whitespace-pre-wrap">
          {detail || emptyPreviewLabel}
        </pre>
      )}
    </div>
  );
}
