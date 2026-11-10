import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import logoUrl from '../assets/logo.svg';
import { DEFAULT_TOKEN_SERVER_URL } from '../config';

const W = 1080;
const H = 1440;
const OFFICIAL_URL = DEFAULT_TOKEN_SERVER_URL;
const GITHUB_URL = 'https://github.com/wink-run/tokenbank';
const PRODUCT_SLOGAN = '个人AI中枢 · Token 管家';

/**
 * 四套气质互斥的海报风格(design-taste):
 * 专业 / 可爱 / 幽默 / 简约: 布局/字族/色板/装饰语言完全不同。
 */
export const POSTER_STYLES = [
  {
    id: 'pro',
    label: '专业',
    layout: 'pro',
    light: false,
    fonts: {
      display: '"Avenir Next","Helvetica Neue","PingFang SC",sans-serif',
      body: '"Avenir Next","PingFang SC","Hiragino Sans GB",sans-serif',
      meta: '"SF Mono","Menlo","Consolas",monospace',
      quote: '"Avenir Next","PingFang SC",sans-serif',
    },
    bg: ['#070b14', '#0f172a', '#1e293b'],
    panel: '#0f172a',
    accent: '#60a5fa',
    accent2: '#38bdf8',
    ink: '#f1f5f9',
    mute: 'rgba(226,232,240,0.55)',
    tiles: ['#60a5fa', '#38bdf8', '#34d399'],
    radius: 16,
    tracking: -0.02,
    grain: 0.03,
  },
  {
    id: 'cute',
    label: '可爱',
    layout: 'cute',
    light: true,
    fonts: {
      display: '"Hiragino Maru Gothic ProN","Yu Gothic UI","PingFang SC",sans-serif',
      body: '"PingFang SC","Hiragino Maru Gothic ProN",sans-serif',
      meta: '"PingFang SC","Hiragino Maru Gothic ProN",sans-serif',
      quote: '"Hiragino Maru Gothic ProN","PingFang SC",sans-serif',
    },
    bg: ['#fff7fb', '#ffe4f0', '#e0f2fe'],
    panel: '#ffffff',
    accent: '#fb7185',
    accent2: '#7dd3fc',
    ink: '#9f1239',
    mute: 'rgba(159,18,57,0.45)',
    tiles: ['#fda4af', '#7dd3fc', '#fcd34d'],
    radius: 36,
    tracking: 0.02,
    grain: 0.012,
  },
  {
    id: 'humor',
    label: '幽默',
    layout: 'humor',
    light: true,
    fonts: {
      display: '"Arial Black","Helvetica Neue Condensed Black","PingFang SC",sans-serif',
      body: '"Helvetica Neue","PingFang SC",sans-serif',
      meta: '"Chalkboard SE","PingFang SC",sans-serif',
      quote: '"Arial Black","PingFang SC",sans-serif',
    },
    bg: ['#fffaf0', '#fff3d6', '#ffe8a3'],
    panel: '#fffef8',
    accent: '#ff5a5f',
    accent2: '#ffd166',
    ink: '#1a1a1a',
    mute: 'rgba(26,26,26,0.5)',
    tiles: ['#ff5a5f', '#06d6a0', '#ffd166'],
    radius: 8,
    tracking: -0.035,
    grain: 0.02,
  },
  {
    id: 'minimal',
    label: '简约',
    layout: 'minimal',
    light: true,
    fonts: {
      display: '"Avenir Next","Helvetica Neue","PingFang SC",sans-serif',
      body: '"Avenir Next","PingFang SC",sans-serif',
      meta: '"Avenir Next","PingFang SC",sans-serif',
      quote: '"Avenir Next","PingFang SC",sans-serif',
    },
    bg: ['#f7f7f5', '#f7f7f5', '#f0f0ec'],
    panel: '#f7f7f5',
    accent: '#111111',
    accent2: '#b0b0a8',
    ink: '#111111',
    mute: 'rgba(17,17,17,0.4)',
    tiles: ['#111111', '#6b6b63', '#b0b0a8'],
    radius: 0,
    tracking: 0.12,
    grain: 0.006,
  },
];

/** 取风格字族 */
function face(theme, role = 'body') {
  const f = theme?.fonts || {};
  return f[role] || f.body || '"PingFang SC",system-ui,sans-serif';
}

/** canvas font 快捷拼接 */
function fnt(theme, weight, sizePx, role = 'body') {
  return `${weight} ${sizePx}px ${face(theme, role)}`;
}

/** 按风格施加字距(tracking 为相对字号比例) */
function withTrack(ctx, theme, sizePx, draw) {
  const prev = ctx.letterSpacing;
  if (theme?.tracking != null && typeof ctx.letterSpacing !== 'undefined') {
    ctx.letterSpacing = `${(theme.tracking * sizePx).toFixed(2)}px`;
  }
  try {
    draw();
  } finally {
    if (typeof prev !== 'undefined') ctx.letterSpacing = prev;
  }
}

/** 风格圆角 */
function rad(theme, fallback = 20) {
  return theme?.radius ?? fallback;
}

/** 缺省占位 */
const NA = '-';

export function getPosterStyle(index = 0) {
  const n = POSTER_STYLES.length;
  return POSTER_STYLES[((Number(index) || 0) % n + n) % n];
}

function wrapLines(ctx, text, maxWidth, maxLines = 4) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const fitOne = (s) => {
    if (ctx.measureText(s).width <= maxWidth) return s;
    let rest = s;
    while (rest && ctx.measureText(`${rest}…`).width > maxWidth) rest = rest.slice(0, -1);
    return rest ? `${rest}…` : '…';
  };
  if (maxLines <= 1) return [fitOne(raw)];
  const lines = [];
  let line = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = line + ch;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines - 1) {
        lines.push(fitOne(raw.slice(i)));
        return lines;
      }
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(Math.max(0, r), w / 2, h / 2);
  ctx.beginPath();
  if (rr <= 0) {
    ctx.rect(x, y, w, h);
  } else {
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
  }
  ctx.closePath();
}

function headline(text, maxLen = 6) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const head = raw.split(/[:：,，。；;]/)[0].trim() || raw;
  return head.length > maxLen ? `${head.slice(0, maxLen - 1)}…` : head;
}

function phrase(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  return raw.split(/[:：]/)[0].trim() || raw;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function stampGrain(ctx, alpha = 0.035) {
  const tile = document.createElement('canvas');
  tile.width = 96;
  tile.height = 96;
  const t = tile.getContext('2d');
  const data = t.createImageData(96, 96);
  for (let i = 0; i < data.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = v;
    data.data[i + 3] = (alpha * 255) | 0;
  }
  t.putImageData(data, 0, 0);
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.fillRect(0, 0, W, H);
}

function hexAlpha(hex, a) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = h.length === 3
    ? h.split('').map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  return `rgba(${n[0]},${n[1]},${n[2]},${a})`;
}

function linkHost(url) {
  return String(url || '').replace(/^https?:\/\//, '');
}

function fillBg(ctx, theme, x = 0, y = 0, w = W, h = H) {
  const stops = theme.bg || ['#fafafa', '#f5f5f5'];
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  stops.forEach((c, i) => g.addColorStop(i / Math.max(1, stops.length - 1), c));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

/** 实色阅读板 */
function paintCard(ctx, x, y, w, h, r, theme, alpha = 0.96) {
  if (r > 0) {
    roundRect(ctx, x + 3, y + 5, w, h, r);
    ctx.fillStyle = 'rgba(15,23,42,0.08)';
    ctx.fill();
  }
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = hexAlpha(theme.panel, alpha);
  ctx.fill();
  ctx.strokeStyle = hexAlpha(theme.accent, theme.layout === 'minimal' ? 0.12 : 0.22);
  ctx.lineWidth = theme.layout === 'humor' ? 3 : 1.25;
  ctx.stroke();
}

function paintFooter(ctx, theme, logo, brand) {
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '500', 13, 'meta');
  ctx.fillText('官网', 56, H - 58);
  ctx.fillText('GitHub', 56, H - 30);
  ctx.fillStyle = theme.accent;
  ctx.font = fnt(theme, '500', 15, 'body');
  ctx.fillText(linkHost(OFFICIAL_URL), 100, H - 58);
  ctx.fillText(linkHost(GITHUB_URL), 120, H - 30);
  if (logo) ctx.drawImage(logo, W - 96, H - 78, 36, 36);
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '600', 14, 'meta');
  ctx.fillText(brand, W - 112, H - 48);
  ctx.textAlign = 'left';
}

function drawIcon(ctx, kind, cx, cy, color, scale = 1) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (kind === 'compass') {
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(4, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-4, 7);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'hex') {
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const x = Math.cos(a) * 14;
      const y = Math.sin(a) * 14;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  } else if (kind === 'heart') {
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.bezierCurveTo(-14, -4, -10, -16, 0, -10);
    ctx.bezierCurveTo(10, -16, 14, -4, 0, 6);
    ctx.fill();
  } else if (kind === 'star') {
    ctx.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
      const r = i % 2 === 0 ? 14 : 6;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(2, -14);
    ctx.lineTo(-5, 2);
    ctx.lineTo(2, 2);
    ctx.lineTo(-2, 14);
    ctx.lineTo(7, -2);
    ctx.lineTo(0, -2);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function sessText(sessions) {
  return String(sessions != null ? sessions : NA);
}

/** 从画像快照抽出海报可用的丰富字段 */
function buildSharePayload(portrait) {
  const traits = (portrait?.traits || []).map((t) => phrase(t)).filter(Boolean);
  const goals = (portrait?.goals || []).map((g) => phrase(g)).filter(Boolean);
  const needs = (portrait?.needs || [])
    .map((n) => phrase(typeof n === 'string' ? n : n?.text))
    .filter(Boolean);
  const extensions = (portrait?.extensions || []).map((e) => phrase(e)).filter(Boolean);
  const digest = portrait?.digest || {};
  const sessions = digest.sessions;
  const agents = Array.isArray(digest.agents) ? digest.agents.filter(Boolean) : [];
  const projects = (digest.projects || [])
    .map((p) => (typeof p === 'string' ? p : p?.name))
    .filter(Boolean)
    .slice(0, 4);
  const installed = portrait?.installed || null;
  const instSkills = Array.isArray(installed?.skills) ? installed.skills.length : 0;
  const instPrompts = Array.isArray(installed?.prompts) ? installed.prompts.length : 0;
  const instAssist = Array.isArray(installed?.assistants) ? installed.assistants.length : 0;
  const metaParts = [];
  if (sessions != null) metaParts.push(`${sessions} 会话`);
  if (agents.length) metaParts.push(`${agents.length} 智能体`);
  if (projects.length) metaParts.push(`项目 ${projects.slice(0, 3).join(' / ')}`);
  if (instSkills || instPrompts || instAssist) {
    const bits = [];
    if (instSkills) bits.push(`Skill ${instSkills}`);
    if (instPrompts) bits.push(`Prompt ${instPrompts}`);
    if (instAssist) bits.push(`Agent ${instAssist}`);
    metaParts.push(`已装 ${bits.join(' · ')}`);
  }
  return {
    traits,
    goals,
    needs,
    extensions,
    sessions,
    agents,
    projects,
    installed,
    metaLine: metaParts.join('  ·  ') || '',
    quote: String(portrait?.persona || '').trim() || '正在从你的 Agent 会话中形成画像…',
    columns: [
      { k: '风格', items: traits.slice(0, 3) },
      { k: '能力', items: goals.slice(0, 3) },
      { k: '延伸', items: extensions.slice(0, 3) },
      { k: '发现', items: needs.slice(0, 3) },
    ],
  };
}

/** 信息栏：摘要一行 */
function paintMetaStrip(ctx, theme, x, y, w, metaLine, ink = null) {
  if (!metaLine) return;
  ctx.fillStyle = ink || theme.mute;
  ctx.font = fnt(theme, '500', 13, 'meta');
  const lines = wrapLines(ctx, metaLine, w, 2);
  lines.forEach((ln, i) => ctx.fillText(ln, x, y + i * 18));
}

/**
 * 多栏要点列表（每栏标题 + 最多 3 条）
 * @returns {number} 占用高度
 */
function paintInfoColumns(ctx, theme, x, y, totalW, columns, {
  gap = 14,
  cardH = 168,
  fill = '#ffffff',
  ink = '#0f172a',
  mute = 'rgba(15,23,42,0.45)',
  accentBar = true,
  radius: r = 14,
} = {}) {
  const cols = (columns || []).filter((c) => c && (c.items?.length || c.k));
  if (!cols.length) return 0;
  const cw = Math.floor((totalW - gap * (cols.length - 1)) / cols.length);
  cols.forEach((col, i) => {
    const cx = x + i * (cw + gap);
    const color = theme.tiles[i % theme.tiles.length];
    softPanel(ctx, cx, y, cw, cardH, rad(theme, r), fill, 0.08);
    if (accentBar) {
      ctx.fillStyle = color;
      ctx.fillRect(cx, y, 4, cardH);
    }
    ctx.fillStyle = mute;
    ctx.font = fnt(theme, '600', 12, 'meta');
    ctx.fillText(col.k, cx + 18, y + 28);
    const items = (col.items && col.items.length) ? col.items : [NA];
    ctx.fillStyle = ink;
    ctx.font = fnt(theme, '600', 15, 'body');
    let yy = y + 56;
    items.slice(0, 3).forEach((raw) => {
      const lines = wrapLines(ctx, `· ${raw}`, cw - 36, 2);
      lines.forEach((ln) => {
        ctx.fillText(ln, cx + 18, yy);
        yy += 20;
      });
      yy += 4;
    });
  });
  return cardH;
}

/** 柔光 */
function glow(ctx, cx, cy, r, color, a = 0.5) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, hexAlpha(color, a));
  g.addColorStop(0.5, hexAlpha(color, a * 0.28));
  g.addColorStop(1, hexAlpha(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

/** 带阴影的软面板 */
function softPanel(ctx, x, y, w, h, r, fill, shadowA = 0.14) {
  if (shadowA > 0) {
    roundRect(ctx, x, y + 12, w, h, r);
    ctx.fillStyle = `rgba(15,23,42,${shadowA})`;
    ctx.fill();
  }
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * 专业主视觉:深空光轨枢纽
 */
function paintArtPro(ctx, theme, sessions, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const bg = ctx.createLinearGradient(x, y, x + w * 0.2, y + h);
  bg.addColorStop(0, '#060a12');
  bg.addColorStop(0.5, '#0c1930');
  bg.addColorStop(1, '#0a1628');
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);

  // 大气光斑
  glow(ctx, x + w * 0.72, y + h * 0.28, w * 0.42, theme.accent, 0.35);
  glow(ctx, x + w * 0.28, y + h * 0.7, w * 0.35, theme.accent2, 0.22);
  glow(ctx, x + w * 0.55, y + h * 0.55, w * 0.2, '#34d399', 0.12);

  const cx = x + w * 0.5;
  const cy = y + h * 0.48;

  // 细轨道椭圆
  for (let i = 0; i < 4; i += 1) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, 90 + i * 55, 48 + i * 28, -0.35 + i * 0.08, 0, Math.PI * 2);
    ctx.strokeStyle = i === 2 ? hexAlpha(theme.accent, 0.55) : 'rgba(148,163,184,0.14)';
    ctx.lineWidth = i === 2 ? 2.2 : 1.2;
    ctx.stroke();
  }

  // 连接点
  const n = Math.min(14, Math.max(8, Number(sessions) || 10));
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 - 0.4;
    const rr = 110 + (i % 4) * 42;
    const px = cx + Math.cos(a) * rr;
    const py = cy + Math.sin(a) * rr * 0.55;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(px, py);
    ctx.strokeStyle = hexAlpha(theme.accent, 0.1 + (i % 3) * 0.04);
    ctx.lineWidth = 1;
    ctx.stroke();
    glow(ctx, px, py, 18, i % 2 ? theme.accent : theme.accent2, 0.55);
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#e2e8f0';
    ctx.fill();
  }

  // 核心透镜
  const core = ctx.createRadialGradient(cx - 12, cy - 14, 4, cx, cy, 58);
  core.addColorStop(0, '#e0f2fe');
  core.addColorStop(0.35, theme.accent);
  core.addColorStop(1, '#0f172a');
  ctx.beginPath();
  ctx.arc(cx, cy, 52, 0, Math.PI * 2);
  ctx.fillStyle = core;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.stroke();
  // 内环高光
  ctx.beginPath();
  ctx.arc(cx, cy, 34, -0.8, 0.9);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

/**
 * 可爱主视觉:柔光角色场景
 */
function paintArtCute(ctx, theme, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  const sky = ctx.createLinearGradient(x, y, x, y + h);
  sky.addColorStop(0, '#ffe4f1');
  sky.addColorStop(0.55, '#fff1f7');
  sky.addColorStop(1, '#e0f2fe');
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, h);

  glow(ctx, x + w * 0.2, y + h * 0.25, 120, theme.tiles[0], 0.4);
  glow(ctx, x + w * 0.85, y + h * 0.2, 100, theme.tiles[1], 0.35);
  glow(ctx, x + w * 0.7, y + h * 0.75, 130, theme.tiles[2], 0.25);

  // 远景云
  const cloud = (cx, cy, s, a) => {
    ctx.fillStyle = `rgba(255,255,255,${a})`;
    ctx.beginPath();
    ctx.arc(cx - s * 0.4, cy, s * 0.38, 0, Math.PI * 2);
    ctx.arc(cx + s * 0.32, cy + 4, s * 0.34, 0, Math.PI * 2);
    ctx.arc(cx, cy - s * 0.22, s * 0.44, 0, Math.PI * 2);
    ctx.fill();
  };
  cloud(x + w * 0.18, y + h * 0.2, 58, 0.85);
  cloud(x + w * 0.82, y + h * 0.16, 48, 0.75);

  const cx = x + w * 0.5;
  const cy = y + h * 0.54;

  // 地面软影
  ctx.beginPath();
  ctx.ellipse(cx, cy + 118, 100, 18, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(159,18,57,0.08)';
  ctx.fill();

  // 身体
  const bodyG = ctx.createLinearGradient(cx, cy - 20, cx, cy + 110);
  bodyG.addColorStop(0, '#ffffff');
  bodyG.addColorStop(1, '#ffe4ec');
  ctx.beginPath();
  ctx.ellipse(cx, cy + 28, 92, 88, 0, 0, Math.PI * 2);
  ctx.fillStyle = bodyG;
  ctx.fill();
  ctx.strokeStyle = hexAlpha(theme.accent, 0.25);
  ctx.lineWidth = 3;
  ctx.stroke();

  // 头
  const headG = ctx.createRadialGradient(cx - 16, cy - 95, 8, cx, cy - 72, 78);
  headG.addColorStop(0, '#ffffff');
  headG.addColorStop(1, '#fff1f5');
  ctx.beginPath();
  ctx.arc(cx, cy - 72, 72, 0, Math.PI * 2);
  ctx.fillStyle = headG;
  ctx.fill();
  ctx.strokeStyle = hexAlpha(theme.accent, 0.28);
  ctx.lineWidth = 3;
  ctx.stroke();

  // 耳朵
  [[-44, -128], [44, -128]].forEach(([ex, ey], i) => {
    ctx.beginPath();
    ctx.moveTo(cx + ex - 14, cy + ey + 28);
    ctx.quadraticCurveTo(cx + ex, cy + ey - 18, cx + ex + 18, cy + ey + 30);
    ctx.closePath();
    ctx.fillStyle = i ? hexAlpha(theme.tiles[1], 0.55) : hexAlpha(theme.tiles[0], 0.6);
    ctx.fill();
    ctx.strokeStyle = hexAlpha(theme.accent, 0.3);
    ctx.stroke();
  });

  // 腮红
  ctx.beginPath();
  ctx.ellipse(cx - 38, cy - 58, 13, 7, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + 38, cy - 58, 13, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = hexAlpha(theme.tiles[0], 0.45);
  ctx.fill();

  // 眼睛(更大更润)
  [[-26, -78], [26, -78]].forEach(([ex, ey]) => {
    ctx.beginPath();
    ctx.ellipse(cx + ex, cy + ey, 11, 13, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#4c0519';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + ex + 3, cy + ey - 4, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  });

  // 微笑
  ctx.beginPath();
  ctx.arc(cx, cy - 52, 16, 0.2 * Math.PI, 0.8 * Math.PI);
  ctx.strokeStyle = '#4c0519';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();

  // 胸口心形徽章
  ctx.beginPath();
  ctx.arc(cx, cy + 34, 26, 0, Math.PI * 2);
  const badge = ctx.createLinearGradient(cx - 26, cy + 8, cx + 26, cy + 60);
  badge.addColorStop(0, theme.tiles[0]);
  badge.addColorStop(1, theme.accent);
  ctx.fillStyle = badge;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();
  drawIcon(ctx, 'heart', cx, cy + 34, '#fff', 0.95);

  // 漂浮星点
  [[0.16, 0.62], [0.84, 0.58], [0.72, 0.32]].forEach(([px, py], i) => {
    glow(ctx, x + w * px, y + h * py, 22, theme.tiles[i % 3], 0.5);
    drawIcon(ctx, 'star', x + w * px, y + h * py, theme.tiles[i % 3], 0.65);
  });

  ctx.restore();
}

/**
 * 幽默主视觉:波普机器人舞台
 */
function paintArtHumor(ctx, theme, x, y, w, h) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // 奶油底 + 半调
  ctx.fillStyle = '#fff8e7';
  ctx.fillRect(x, y, w, h);
  for (let yy = y; yy < y + h; yy += 14) {
    for (let xx = x; xx < x + w; xx += 14) {
      if ((xx + yy) % 28 === 0) {
        ctx.beginPath();
        ctx.arc(xx, yy, 1.4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(26,26,26,0.07)';
        ctx.fill();
      }
    }
  }

  const cx = x + w * 0.5;
  const cy = y + h * 0.5;

  // 背后色块舞台
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.08);
  roundRect(ctx, -150, -130, 300, 260, 20);
  ctx.fillStyle = theme.accent2;
  ctx.fill();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.restore();

  // 放射线
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30);
    ctx.lineTo(cx + Math.cos(a) * (w * 0.48), cy + Math.sin(a) * (h * 0.48));
    ctx.strokeStyle = i % 2 ? hexAlpha(theme.accent, 0.1) : hexAlpha(theme.tiles[1], 0.12);
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  // 机器人
  softPanel(ctx, cx - 58, cy - 10, 116, 110, 14, theme.tiles[1], 0);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 4;
  roundRect(ctx, cx - 58, cy - 10, 116, 110, 14);
  ctx.stroke();

  softPanel(ctx, cx - 68, cy - 118, 136, 96, 18, '#fff', 0);
  roundRect(ctx, cx - 68, cy - 118, 136, 96, 18);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 4;
  ctx.stroke();

  // 天线
  ctx.beginPath();
  ctx.moveTo(cx - 28, cy - 118);
  ctx.lineTo(cx - 40, cy - 158);
  ctx.moveTo(cx + 28, cy - 118);
  ctx.lineTo(cx + 42, cy - 152);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - 40, cy - 162, 9, 0, Math.PI * 2);
  ctx.arc(cx + 42, cy - 156, 9, 0, Math.PI * 2);
  ctx.fillStyle = theme.accent;
  ctx.fill();
  ctx.stroke();

  // 搞怪眼
  ctx.beginPath();
  ctx.arc(cx - 30, cy - 72, 16, 0, Math.PI * 2);
  ctx.fillStyle = theme.accent2;
  ctx.fill();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 3;
  ctx.stroke();
  roundRect(ctx, cx + 14, cy - 88, 32, 32, 4);
  ctx.fillStyle = theme.accent;
  ctx.fill();
  ctx.stroke();

  // 大笑
  ctx.beginPath();
  ctx.ellipse(cx, cy - 42, 32, 16, 0, 0, Math.PI);
  ctx.fillStyle = theme.ink;
  ctx.fill();

  // 手臂
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.strokeStyle = theme.ink;
  ctx.beginPath();
  ctx.moveTo(cx - 58, cy + 20);
  ctx.quadraticCurveTo(cx - 110, cy - 20, cx - 125, cy + 10);
  ctx.moveTo(cx + 58, cy + 30);
  ctx.quadraticCurveTo(cx + 120, cy + 60, cx + 135, cy + 90);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx - 125, cy + 10, 14, 0, Math.PI * 2);
  ctx.arc(cx + 135, cy + 90, 14, 0, Math.PI * 2);
  ctx.fillStyle = theme.accent2;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.stroke();

  // 爆炸标
  const burst = (bx, by, s, c) => {
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? s : s * 0.42;
      const px = bx + Math.cos(a) * r;
      const py = by + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = c;
    ctx.fill();
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 3;
    ctx.stroke();
  };
  burst(x + w * 0.14, y + h * 0.22, 38, theme.accent);
  burst(x + w * 0.88, y + h * 0.72, 32, theme.tiles[1]);

  ctx.restore();
}

/**
 * 简约主视觉:东方留白线描
 */
function paintArtMinimal(ctx, theme, x, y, w, h) {
  ctx.save();
  const cx = x + w * 0.52;
  const cy = y + h * 0.5;

  // 极淡同心圆
  for (let i = 0; i < 4; i += 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, 70 + i * 52, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(17,17,17,${0.035 + i * 0.015})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 一笔肖像(更流畅的贝塞尔)
  ctx.beginPath();
  ctx.moveTo(cx - 20, cy - 150);
  ctx.bezierCurveTo(cx + 90, cy - 160, cx + 120, cy - 40, cx + 95, cy + 30);
  ctx.bezierCurveTo(cx + 80, cy + 90, cx + 30, cy + 140, cx - 20, cy + 155);
  ctx.bezierCurveTo(cx - 70, cy + 130, cx - 95, cy + 50, cx - 75, cy);
  ctx.bezierCurveTo(cx - 105, cy - 40, cx - 70, cy - 120, cx - 20, cy - 150);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 1.75;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // 眼
  ctx.beginPath();
  ctx.moveTo(cx + 20, cy - 45);
  ctx.bezierCurveTo(cx + 45, cy - 58, cx + 70, cy - 48, cx + 78, cy - 28);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + 52, cy - 40, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = theme.ink;
  ctx.fill();

  // 鼻线
  ctx.beginPath();
  ctx.moveTo(cx + 55, cy - 20);
  ctx.quadraticCurveTo(cx + 70, cy + 10, cx + 48, cy + 28);
  ctx.strokeStyle = 'rgba(17,17,17,0.55)';
  ctx.lineWidth = 1.25;
  ctx.stroke();

  // 轨道节点(稀疏)
  for (let i = 0; i < 6; i += 1) {
    const a = -1.1 + (i / 5) * 2.4;
    const r = 175;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r * 0.72;
    ctx.beginPath();
    ctx.arc(px, py, i === 2 ? 5 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = i === 2 ? theme.ink : 'rgba(17,17,17,0.28)';
    ctx.fill();
  }

  ctx.restore();
}

function paintHumorPanelArt(ctx, kind, x, y, w, h, color, ink) {
  const cx = x + w / 2;
  const cy = y + h * 0.48;
  ctx.save();
  glow(ctx, cx, cy, 50, color, 0.2);
  if (kind === 0) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, 44, 52, 0, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx - 14, cy - 6, 9, 12, -0.2, 0, Math.PI * 2);
    ctx.ellipse(cx + 14, cy - 6, 9, 12, 0.2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + 16, 14, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  } else if (kind === 1) {
    ctx.beginPath();
    ctx.moveTo(cx - 45, cy + 28);
    ctx.quadraticCurveTo(cx - 55, cy - 40, cx - 5, cy - 48);
    ctx.quadraticCurveTo(cx + 35, cy - 15, cx + 40, cy + 38);
    ctx.lineTo(cx - 5, cy + 42);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    drawIcon(ctx, 'bolt', cx + 6, cy - 8, ink, 1.3);
  } else {
    ctx.beginPath();
    ctx.arc(cx - 6, cy - 8, 34, 0, Math.PI * 2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx - 6, cy - 8, 26, 0, Math.PI * 2);
    ctx.fillStyle = hexAlpha(color, 0.3);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + 18, cy + 16);
    ctx.lineTo(cx + 48, cy + 50);
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.strokeStyle = ink;
    ctx.stroke();
  }
  ctx.restore();
}

/* ========== 专业:深空编辑海报 ========== */
function paintLayoutPro(ctx, d) {
  const { theme, sessions, quote, logo, brand, slogan, tagline, title, footer, columns, metaLine } = d;

  // 全幅深空主视觉（略收，给信息区更多空间）
  paintArtPro(ctx, theme, sessions, 0, 0, W, 760);

  // 顶部玻璃品牌条
  ctx.fillStyle = 'rgba(7,11,20,0.35)';
  ctx.fillRect(0, 0, W, 100);
  if (logo) ctx.drawImage(logo, 48, 28, 44, 44);
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '600', 24, 'display');
  withTrack(ctx, theme, 24, () => ctx.fillText(brand, 108, 48));
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '500', 13, 'meta');
  ctx.fillText(slogan, 108, 74);
  ctx.textAlign = 'right';
  ctx.fillStyle = hexAlpha(theme.accent, 0.9);
  ctx.font = fnt(theme, '500', 12, 'meta');
  withTrack(ctx, theme, 12, () => ctx.fillText('AI WORK PORTRAIT', W - 48, 42));
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '300', 42, 'display');
  ctx.fillText(sessText(sessions), W - 48, 86);
  ctx.textAlign = 'left';

  // 悬浮引语卡
  softPanel(ctx, 48, 560, W - 96, 200, 20, 'rgba(15,23,42,0.82)', 0.25);
  ctx.strokeStyle = hexAlpha(theme.accent, 0.25);
  ctx.lineWidth = 1;
  roundRect(ctx, 48, 560, W - 96, 200, 20);
  ctx.stroke();
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '500', 12, 'meta');
  withTrack(ctx, theme, 12, () => ctx.fillText(title.toUpperCase(), 80, 596));
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '400', 24, 'quote');
  wrapLines(ctx, quote, W - 180, 4).forEach((ln, i) => {
    ctx.fillText(ln, 80, 640 + i * 32);
  });

  // 下部浅色信息层：摘要 + 四栏要点
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(0, 780, W, H - 780);
  paintMetaStrip(ctx, theme, 52, 812, W - 104, metaLine, 'rgba(15,23,42,0.5)');
  paintInfoColumns(ctx, theme, 48, 848, W - 96, columns, {
    cardH: 200, fill: '#ffffff', ink: '#0f172a', mute: 'rgba(15,23,42,0.45)',
  });

  // 宣言
  ctx.fillStyle = '#0f172a';
  roundRect(ctx, 48, 1072, W - 96, 88, 14);
  ctx.fill();
  ctx.fillStyle = '#f8fafc';
  ctx.font = fnt(theme, '600', 20, 'display');
  ctx.fillText(tagline, 76, 1108);
  ctx.fillStyle = 'rgba(248,250,252,0.65)';
  ctx.font = fnt(theme, '400', 14, 'body');
  wrapLines(ctx, footer, W - 180, 1).forEach((ln) => ctx.fillText(ln, 76, 1138));

  const lightTheme = { ...theme, ink: '#0f172a', mute: 'rgba(15,23,42,0.45)', accent: '#2563eb' };
  paintFooter(ctx, lightTheme, logo, brand);
}

/* ========== 可爱:柔光角色海报 ========== */
function paintLayoutCute(ctx, d) {
  const { theme, sessions, quote, logo, brand, slogan, tagline, title, footer, columns, metaLine } = d;

  // 全页柔彩底
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#fff7fb');
  bg.addColorStop(0.4, '#ffe4f0');
  bg.addColorStop(1, '#e0f2fe');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  glow(ctx, 200, 180, 220, theme.tiles[0], 0.35);
  glow(ctx, 900, 300, 260, theme.tiles[1], 0.3);
  glow(ctx, 540, 1100, 280, theme.tiles[2], 0.22);

  // 顶品牌(轻)
  if (logo) ctx.drawImage(logo, 48, 44, 40, 40);
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '700', 22, 'display');
  withTrack(ctx, theme, 22, () => ctx.fillText(brand, 104, 62));
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '500', 13, 'meta');
  ctx.fillText(slogan, 104, 88);

  // 会话糖
  glow(ctx, W - 100, 78, 50, theme.accent, 0.35);
  ctx.beginPath();
  ctx.arc(W - 100, 78, 44, 0, Math.PI * 2);
  const sg = ctx.createLinearGradient(W - 140, 40, W - 60, 120);
  sg.addColorStop(0, theme.tiles[0]);
  sg.addColorStop(1, theme.accent);
  ctx.fillStyle = sg;
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.font = fnt(theme, '800', 24, 'display');
  ctx.fillText(sessText(sessions), W - 100, 76);
  ctx.font = fnt(theme, '600', 11, 'meta');
  ctx.fillText('会话', W - 100, 98);
  ctx.textAlign = 'left';

  // 角色区略收，给信息腾位
  softPanel(ctx, 80, 120, W - 160, 380, 40, 'rgba(255,255,255,0.55)', 0.06);
  paintArtCute(ctx, theme, 80, 120, W - 160, 380);

  // 引语卡
  softPanel(ctx, 64, 520, W - 128, 170, 28, '#ffffff', 0.1);
  ctx.strokeStyle = hexAlpha(theme.accent, 0.18);
  ctx.lineWidth = 1.5;
  roundRect(ctx, 64, 520, W - 128, 170, 28);
  ctx.stroke();
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '600', 13, 'meta');
  ctx.fillText(title, 96, 556);
  drawIcon(ctx, 'heart', W - 112, 548, theme.accent, 0.85);
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '500', 22, 'quote');
  wrapLines(ctx, quote, W - 220, 3).forEach((ln, i) => {
    ctx.fillText(ln, 96, 596 + i * 30);
  });

  paintMetaStrip(ctx, theme, 68, 712, W - 136, metaLine, theme.mute);
  paintInfoColumns(ctx, theme, 56, 740, W - 112, columns, {
    cardH: 188, fill: '#ffffff', ink: theme.ink, mute: theme.mute, radius: 22,
  });

  // 底波浪色带
  ctx.beginPath();
  ctx.moveTo(0, 960);
  for (let x = 0; x <= W; x += 36) {
    ctx.lineTo(x, 960 + Math.sin(x * 0.035) * 10);
  }
  ctx.lineTo(W, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  const wg = ctx.createLinearGradient(0, 960, W, H);
  wg.addColorStop(0, '#fb7185');
  wg.addColorStop(0.5, '#7dd3fc');
  wg.addColorStop(1, '#fcd34d');
  ctx.fillStyle = wg;
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = fnt(theme, '700', 22, 'display');
  withTrack(ctx, theme, 22, () => ctx.fillText(tagline, 64, 1060));
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.font = fnt(theme, '500', 14, 'body');
  wrapLines(ctx, footer, W - 160, 1).forEach((ln) => ctx.fillText(ln, 64, 1094));

  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  roundRect(ctx, 40, H - 118, W - 80, 92, 22);
  ctx.fill();
  paintFooter(ctx, theme, logo, brand);
}

/* ========== 幽默:波普漫画海报 ========== */
function paintLayoutHumor(ctx, d) {
  const { theme, sessions, quote, logo, brand, slogan, tagline, title, footer, columns, metaLine } = d;

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#fffaf0');
  bg.addColorStop(1, '#ffe8a3');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 外框
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 8;
  ctx.strokeRect(28, 28, W - 56, H - 56);

  // 顶黄条
  ctx.fillStyle = theme.accent2;
  ctx.fillRect(40, 40, W - 80, 92);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 4;
  ctx.strokeRect(42, 42, W - 84, 88);
  if (logo) ctx.drawImage(logo, 60, 58, 48, 48);
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '900', 28, 'display');
  withTrack(ctx, theme, 28, () => ctx.fillText(brand.toUpperCase(), 128, 78));
  ctx.font = fnt(theme, '700', 14, 'meta');
  ctx.fillText(slogan, 128, 108);

  // POW
  ctx.save();
  ctx.translate(W - 150, 86);
  ctx.rotate(-0.14);
  ctx.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const a = (i / 10) * Math.PI * 2;
    const r = i % 2 ? 58 : 38;
    const px = Math.cos(a) * r;
    const py = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = theme.accent;
  ctx.fill();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = fnt(theme, '900', 24, 'display');
  ctx.fillText(sessText(sessions), 0, 2);
  ctx.font = fnt(theme, '700', 11, 'meta');
  ctx.fillText('会话!', 0, 24);
  ctx.restore();
  ctx.textAlign = 'left';

  // 英雄漫画格（略矮）
  ctx.fillStyle = '#fff';
  ctx.fillRect(48, 150, W - 96, 300);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 5;
  ctx.strokeRect(50, 152, W - 100, 296);
  paintArtHumor(ctx, theme, 56, 158, W - 112, 280);

  // 对话框
  softPanel(ctx, 56, 470, W - 112, 160, 10, theme.panel, 0);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 4;
  roundRect(ctx, 56, 470, W - 112, 160, 10);
  ctx.stroke();
  ctx.fillStyle = theme.accent;
  ctx.font = fnt(theme, '900', 15, 'meta');
  ctx.fillText(`【${title}】说:`, 84, 508);
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '800', 22, 'quote');
  wrapLines(ctx, quote, W - 180, 3).forEach((ln, i) => {
    ctx.fillText(ln, 84, 548 + i * 28);
  });

  paintMetaStrip(ctx, theme, 60, 658, W - 120, metaLine, theme.mute);

  // 四格：标题条 + 多条要点（保留漫画边框）
  const panels = (columns || []).map((c, i) => ({
    k: `${c.k}!`,
    items: (c.items && c.items.length) ? c.items : [i === 0 ? '神秘选手' : i === 1 ? '隐藏技能' : i === 2 ? '兴趣外挂' : '彩蛋待拆'],
    c: theme.tiles[i % theme.tiles.length],
  }));
  const gap = 12;
  const pw = Math.floor((W - 112 - gap * (panels.length - 1)) / panels.length);
  panels.forEach((p, i) => {
    const x = 56 + i * (pw + gap);
    ctx.fillStyle = '#fff';
    ctx.fillRect(x, 688, pw, 230);
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 4;
    ctx.strokeRect(x + 2, 690, pw - 4, 226);
    ctx.fillStyle = p.c;
    ctx.fillRect(x + 2, 690, pw - 4, 36);
    ctx.fillStyle = theme.ink;
    ctx.font = fnt(theme, '900', 15, 'display');
    ctx.fillText(p.k, x + 12, 716);
    ctx.font = fnt(theme, '800', 14, 'body');
    let yy = 752;
    p.items.slice(0, 3).forEach((raw) => {
      wrapLines(ctx, `· ${raw}`, pw - 28, 2).forEach((ln) => {
        ctx.fillText(ln, x + 12, yy);
        yy += 20;
      });
      yy += 6;
    });
  });

  // 锯齿宣言
  ctx.fillStyle = theme.accent;
  ctx.beginPath();
  ctx.moveTo(40, 950);
  for (let x = 40; x <= W - 40; x += 26) {
    ctx.lineTo(x + 13, 932);
    ctx.lineTo(x + 26, 950);
  }
  ctx.lineTo(W - 40, 1050);
  ctx.lineTo(40, 1050);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = fnt(theme, '900', 20, 'display');
  withTrack(ctx, theme, 20, () => ctx.fillText(tagline, 68, 992));
  ctx.font = fnt(theme, '700', 13, 'body');
  wrapLines(ctx, footer, W - 160, 1).forEach((ln) => ctx.fillText(ln, 68, 1024));

  ctx.fillStyle = theme.panel;
  ctx.fillRect(40, H - 118, W - 80, 90);
  ctx.strokeStyle = theme.ink;
  ctx.lineWidth = 3;
  ctx.strokeRect(42, H - 116, W - 84, 86);
  paintFooter(ctx, theme, logo, brand);
}

/* ========== 简约:留白海报 ========== */
function paintLayoutMinimal(ctx, d) {
  const { theme, sessions, quote, logo, brand, slogan, tagline, title, footer, columns, metaLine } = d;

  ctx.fillStyle = '#f7f7f5';
  ctx.fillRect(0, 0, W, H);

  // 顶细线
  ctx.strokeStyle = 'rgba(17,17,17,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(72, 88);
  ctx.lineTo(W - 72, 88);
  ctx.stroke();

  if (logo) {
    ctx.globalAlpha = 0.85;
    ctx.drawImage(logo, 72, 40, 28, 28);
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '500', 13, 'meta');
  withTrack(ctx, theme, 13, () => ctx.fillText(brand.toUpperCase(), 112, 60));
  ctx.textAlign = 'right';
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '400', 12, 'meta');
  ctx.fillText(slogan, W - 72, 60);
  ctx.textAlign = 'left';

  // 主插画略收
  paintArtMinimal(ctx, theme, 160, 110, W - 320, 420);

  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '400', 12, 'meta');
  withTrack(ctx, theme, 12, () => {
    ctx.fillText(`${sessText(sessions)}  SESSIONS`, 72, 560);
  });
  paintMetaStrip(ctx, theme, 72, 586, W - 144, metaLine, theme.mute);

  // 引语
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '500', 11, 'meta');
  withTrack(ctx, theme, 11, () => ctx.fillText(title, 72, 640));
  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '300', 26, 'quote');
  wrapLines(ctx, quote, W - 200, 3).forEach((ln, i) => {
    ctx.fillText(ln, 72, 682 + i * 36);
  });

  // 四栏要点（细线分隔，多条）
  const cols = columns || [];
  const colW = Math.floor((W - 144 - 24 * 3) / 4);
  cols.forEach((col, i) => {
    const x = 72 + i * (colW + 24);
    ctx.strokeStyle = 'rgba(17,17,17,0.15)';
    ctx.beginPath();
    ctx.moveTo(x, 820);
    ctx.lineTo(x + colW, 820);
    ctx.stroke();
    ctx.fillStyle = theme.mute;
    ctx.font = fnt(theme, '500', 11, 'meta');
    withTrack(ctx, theme, 11, () => ctx.fillText(col.k, x, 848));
    ctx.fillStyle = theme.ink;
    ctx.font = fnt(theme, '400', 15, 'body');
    let yy = 878;
    const items = (col.items && col.items.length) ? col.items : [NA];
    items.slice(0, 3).forEach((raw) => {
      wrapLines(ctx, raw, colW, 2).forEach((ln) => {
        ctx.fillText(ln, x, yy);
        yy += 22;
      });
      yy += 8;
    });
  });

  ctx.fillStyle = theme.ink;
  ctx.font = fnt(theme, '500', 16, 'display');
  withTrack(ctx, theme, 16, () => ctx.fillText(tagline, 72, 1120));
  ctx.fillStyle = theme.mute;
  ctx.font = fnt(theme, '400', 13, 'body');
  wrapLines(ctx, footer, W - 200, 1).forEach((ln) => ctx.fillText(ln, 72, 1150));

  paintFooter(ctx, theme, logo, brand);
}

export async function renderPortraitSharePng(portrait, labels, styleIndex = 0) {
  const {
    brand = 'Token Bank',
    slogan = PRODUCT_SLOGAN,
    tagline = '越用越懂你 · 自动发现',
    title = '我的 AI 工作画像',
    footer = '用 Agent 越多，Token Bank 越懂你要什么',
  } = labels || {};
  const theme = getPosterStyle(styleIndex);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const payload = buildSharePayload(portrait);

  let logo = null;
  try { logo = await loadImage(logoUrl); } catch { /* */ }

  const data = {
    theme,
    ...payload,
    logo, brand, slogan, tagline, title, footer,
  };

  if (theme.layout === 'cute') paintLayoutCute(ctx, data);
  else if (theme.layout === 'humor') paintLayoutHumor(ctx, data);
  else if (theme.layout === 'minimal') paintLayoutMinimal(ctx, data);
  else paintLayoutPro(ctx, data);

  stampGrain(ctx, theme.grain != null ? theme.grain : (theme.light ? 0.02 : 0.04));

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('png failed'));
      else resolve(blob);
    }, 'image/png');
  });
}

export function buildPortraitShareText(portrait, t, typeLabel) {
  const p = buildSharePayload(portrait);
  const lines = [];
  lines.push('我在 Token Bank 被自动认出了工作画像');
  lines.push(PRODUCT_SLOGAN);
  lines.push('越用越懂你 · 自动发现技能 / 提示词 / 智能体');
  lines.push('');
  if (p.quote && !p.quote.startsWith('正在从')) lines.push(`「${portrait?.persona || p.quote}」`);
  if (p.metaLine) {
    lines.push('');
    lines.push(p.metaLine);
  }
  lines.push('');
  if (p.traits.length) {
    lines.push(`风格 · ${p.traits.slice(0, 4).map((x) => headline(x, 12)).join(' / ')}`);
  }
  if (p.goals.length) {
    lines.push(`能力 · ${p.goals.slice(0, 4).map((x) => headline(x, 12)).join(' / ')}`);
  }
  if (p.extensions.length) {
    lines.push(`延伸 · ${p.extensions.slice(0, 4).map((x) => headline(x, 12)).join(' / ')}`);
  }
  if (p.needs.length) {
    const label = typeLabel ? `建议配备的${typeLabel}` : '发现';
    lines.push(`${label} · ${p.needs.slice(0, 4).map((x) => headline(x, 14)).join(' / ')}`);
  }
  if (p.agents.length) {
    lines.push(`纳管智能体 · ${p.agents.slice(0, 6).join(' · ')}`);
  }
  if (p.projects.length) {
    lines.push(`常涉项目 · ${p.projects.join(' · ')}`);
  }
  const inst = portrait?.installed;
  if (inst) {
    const bits = [];
    if (inst.skills?.length) bits.push(`Skill ${inst.skills.length}`);
    if (inst.prompts?.length) bits.push(`Prompt ${inst.prompts.length}`);
    if (inst.assistants?.length) bits.push(`Agent ${inst.assistants.length}`);
    if (bits.length) lines.push(`本地已装 · ${bits.join(' · ')}`);
  }
  lines.push('');
  lines.push(`官网 ${OFFICIAL_URL}`);
  lines.push(`GitHub ${GITHUB_URL}`);
  lines.push('#TokenBank #越用越懂你 #自动发现');
  return lines.join('\n');
}

export function PortraitVisualBoard({
  persona,
  traits = [],
  goals = [],
  extensions = [],
  needs = [],
  digest,
  t,
  typeLabel,
  onShare,
  canShare,
  onRemove,       // (field, index) => void：删掉一条画像（看护会记住，下次不再生成）
  onEditPersona,  // () => void：改一句话画像
}) {
  const traitHeads = traits.map((x) => headline(x, 10));
  const goalHeads = goals.map((x) => headline(x, 12));
  const needHeads = needs.map((n) => headline(typeof n === 'string' ? n : n?.text, 10));
  const extHeads = extensions.map((x) => headline(x, 10));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-zinc-700 dark:text-zinc-200">{t('resources.reco.conclusionTitle')}</p>
        {canShare && onShare && (
          <button
            type="button"
            onClick={onShare}
            className="text-[11px] px-2.5 py-1 rounded-md border border-amber-300/80 dark:border-amber-700/60 text-amber-800 dark:text-amber-200 hover:bg-amber-50 dark:hover:bg-amber-950/30"
          >
            {t('resources.reco.share')}
          </button>
        )}
      </div>

      <div className="relative overflow-hidden rounded-2xl border border-zinc-200/80 dark:border-zinc-700/70 min-h-[140px]">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse at 30% 40%, rgba(251,191,36,0.35), transparent 55%),'
              + 'radial-gradient(ellipse at 80% 20%, rgba(99,102,241,0.28), transparent 50%),'
              + 'linear-gradient(135deg, #0c0a09 0%, #1e1b4b 45%, #1c1917 100%)',
          }}
        />
        <div className="absolute left-[18%] top-1/2 -translate-y-1/2 w-28 h-28 rounded-full border border-amber-400/40" />
        <div className="absolute left-[18%] top-1/2 -translate-y-1/2 w-16 h-16 rounded-full border-2 border-amber-300/70 bg-amber-400/20" />

        <div className="relative z-[1] p-4 pl-[42%] sm:pl-[38%] space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-amber-200/80">{t('resources.reco.analysis')}</span>
            {digest?.sessions != null && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-black/30 text-amber-100/80 border border-amber-500/30">
                {t('resources.reco.sessions', { n: digest.sessions })}
              </span>
            )}
          </div>
          {persona ? (
            <p className="text-sm leading-relaxed text-stone-50 font-medium">
              <span className="text-amber-300/80 text-lg leading-none mr-1">“</span>
              {persona}
              {onEditPersona && (
                <button type="button" onClick={onEditPersona} title={t('resources.reco.editPersona')}
                  className="ml-2 align-middle text-[10px] px-1.5 py-0.5 rounded border border-amber-400/40 text-amber-200/90 hover:bg-white/10">
                  {t('resources.reco.editPersona')}
                </button>
              )}
            </p>
          ) : (
            <p className="text-[11px] text-stone-400">{t('resources.reco.noPersona')}</p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {[
          {
            field: 'traits',
            title: t('resources.reco.traitsTitle'),
            items: traitHeads,
            icon: '◎',
            tone: 'from-sky-500/20 to-sky-900/10 border-sky-300/40 text-sky-800 dark:text-sky-200',
            chip: 'bg-sky-100/80 dark:bg-sky-900/40 text-sky-700 dark:text-sky-200',
          },
          {
            field: 'goals',
            title: t('resources.reco.goalsTitle'),
            items: goalHeads,
            icon: '⬡',
            tone: 'from-amber-500/20 to-amber-900/10 border-amber-300/40 text-amber-900 dark:text-amber-100',
            chip: 'bg-amber-100/80 dark:bg-amber-900/40 text-amber-800 dark:text-amber-100',
          },
          {
            field: needHeads.length ? 'needs' : 'extensions',
            title: t('resources.reco.needsTitle', { type: typeLabel }),
            items: needHeads.length ? needHeads : extHeads,
            icon: '⚡',
            tone: 'from-violet-500/20 to-violet-900/10 border-violet-300/40 text-violet-900 dark:text-violet-100',
            chip: 'bg-violet-100/80 dark:bg-violet-900/40 text-violet-800 dark:text-violet-100',
          },
        ].map((col) => (
          <div
            key={col.title}
            className={`rounded-xl border bg-gradient-to-b p-3 space-y-2 min-h-[108px] ${col.tone}`}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/70 dark:bg-black/30 text-base shadow-sm">
                {col.icon}
              </span>
              <p className="text-[10px] font-semibold opacity-80 leading-tight">{col.title}</p>
            </div>
            {col.items.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {col.items.slice(0, 4).map((item, i) => (
                  <span key={i} className={`group inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-md ${col.chip}`}>
                    {item}
                    {onRemove && (
                      <button type="button" onClick={() => onRemove(col.field, i)} aria-label={t('resources.reco.removeEntry', { name: item })}
                        title={t('resources.reco.removeEntry', { name: item })}
                        className="ml-0.5 leading-none opacity-50 hover:opacity-100">×</button>
                    )}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[10px] opacity-50">—</p>
            )}
          </div>
        ))}
      </div>

      {extHeads.length > 0 && needHeads.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-zinc-400 shrink-0">{t('resources.reco.extensionsTitle')}</span>
          {extHeads.slice(0, 4).map((e, i) => (
            <span key={i} className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/25 text-amber-700 dark:text-amber-300 border border-amber-200/50 dark:border-amber-800/40">
              {e}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PortraitShareModal({ open, onClose, portrait, typeLabel, t }) {
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [styleIndex, setStyleIndex] = useState(0);
  const blobRef = useRef(null);
  const styleRef = useRef(0);

  const labels = useMemo(() => ({
    brand: 'Token Bank',
    slogan: PRODUCT_SLOGAN,
    tagline: t('resources.reco.shareTagline'),
    title: t('resources.reco.shareTitle'),
    footer: t('resources.reco.shareFooter'),
  }), [t]);

  const styleLabel = getPosterStyle(styleIndex).label;

  const regenerate = useCallback(async (advance = false) => {
    if (!portrait) return;
    let idx = styleRef.current;
    if (advance) {
      idx = (idx + 1) % POSTER_STYLES.length;
      styleRef.current = idx;
      setStyleIndex(idx);
    }
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const blob = await renderPortraitSharePng(portrait, labels, idx);
      blobRef.current = blob;
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(blob);
      });
      setMsg(t('resources.reco.shareReadyStyle', { style: getPosterStyle(idx).label }));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [portrait, labels, t]);

  useEffect(() => {
    if (!open) return undefined;
    styleRef.current = 0;
    setStyleIndex(0);
    regenerate(false);
    return undefined;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  if (!open) return null;

  const download = () => {
    if (!previewUrl) return;
    const a = document.createElement('a');
    a.href = previewUrl;
    a.download = `tokenbank-portrait-${getPosterStyle(styleIndex).id}-${Date.now()}.png`;
    a.click();
    setMsg(t('resources.reco.shareSaved'));
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(buildPortraitShareText(portrait, t, typeLabel));
      setMsg(t('resources.reco.shareCopied'));
    } catch {
      setErr(t('resources.reco.shareCopyFailed'));
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/55 backdrop-blur-[3px]" role="dialog" aria-modal>
      <div className="w-full max-w-xl max-h-[92vh] overflow-y-auto rounded-2xl border border-zinc-200/80 dark:border-zinc-700/80 bg-white dark:bg-zinc-900 shadow-2xl">
        <div className="flex items-start justify-between gap-3 p-4 border-b border-zinc-100 dark:border-zinc-800">
          <div>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{t('resources.reco.shareModalTitle')}</p>
            <p className="text-[11px] text-zinc-500 mt-0.5">{t('resources.reco.shareModalHint')}</p>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200">
            {t('resources.reco.cancel')}
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="rounded-2xl overflow-hidden border border-zinc-200 dark:border-zinc-700 bg-zinc-950 aspect-[1080/1440] max-h-[56vh] flex items-center justify-center">
            {previewUrl ? (
              <img src={previewUrl} alt="" className="w-full h-full object-contain" />
            ) : (
              <div className="flex flex-col items-center gap-2 py-20 text-zinc-500">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-60" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-amber-500" />
                </span>
                <p className="text-xs">{busy ? t('resources.reco.shareGenerating') : '—'}</p>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-zinc-500 leading-relaxed">{t('resources.reco.shareVisualHint')}</p>
            <span className="shrink-0 text-[10px] px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400">
              {t('resources.reco.shareStyleBadge', { style: styleLabel, n: styleIndex + 1, total: POSTER_STYLES.length })}
            </span>
          </div>
          {(msg || err) && (
            <p className={`text-[11px] ${err ? 'text-red-500' : 'text-emerald-600'}`}>{err || msg}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy || !previewUrl} onClick={download}
              className="px-3.5 py-2 rounded-xl bg-amber-600 text-white text-xs font-medium hover:bg-amber-500 disabled:opacity-45">
              {t('resources.reco.shareDownload')}
            </button>
            <button type="button" disabled={busy} onClick={copyText}
              className="px-3.5 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              {t('resources.reco.shareCopy')}
            </button>
            <button type="button" disabled={busy} onClick={() => regenerate(true)}
              className="px-3.5 py-2 rounded-xl border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-500 hover:bg-zinc-50 dark:hover:bg-zinc-800">
              {t('resources.reco.shareRegen')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
