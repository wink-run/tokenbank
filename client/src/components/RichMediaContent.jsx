import React, { useEffect, useRef, useState } from 'react';
import { resolveMediaUrl } from '../lib/mediaUrl';
import { isMarkdownStable, softenStreamingMarkdown } from '../lib/stream-markdown';
import {
  looksLikeLocalPath,
  openLocalPath,
  splitGluedLocalPath,
  unwrapLocalPathToken,
} from '../lib/local-path';

const IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * 流式文本展示:延迟渲染 + 定期用最新内容重绘,修正先前不完整片段造成的错版。
 * live=false 时立即用完整 Markdown。
 */
function useStableStreamText(raw, {
  live = false,
  debounceMs = 220,
  refreshMs = 700,
} = {}) {
  const [shown, setShown] = useState(() => String(raw || ''));
  const rawRef = useRef(raw);
  rawRef.current = raw;

  useEffect(() => {
    if (!live) {
      setShown(String(raw || ''));
      return undefined;
    }
    const t = setTimeout(() => {
      setShown(String(rawRef.current || ''));
    }, debounceMs);
    return () => clearTimeout(t);
  }, [raw, live, debounceMs]);

  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      const next = String(rawRef.current || '');
      setShown((prev) => (prev === next ? prev : next));
    }, refreshMs);
    return () => clearInterval(id);
  }, [live, refreshMs]);

  return shown;
}

/**
 * 流式安全 Markdown:延迟 + 定期重绘;未闭合标记时先纯文本,稳定后再 MD。
 */
export function StreamMarkdownContent({
  content,
  live = false,
  className = '',
  theme = 'default',
  preferPlainWhileLive = false,
  density = 'default',
}) {
  const stable = useStableStreamText(content, { live });
  const display = live ? softenStreamingMarkdown(stable) : String(stable || '');
  const usePlain = live && (preferPlainWhileLive || !isMarkdownStable(stable));

  if (!display) return null;

  if (usePlain) {
    const plainCls = density === 'reading'
      ? 'whitespace-pre-wrap break-words text-[14px] leading-normal font-sans m-0'
      : 'whitespace-pre-wrap break-words text-xs leading-relaxed font-sans m-0';
    return (
      <pre className={`${plainCls} ${className}`}>
        {display}
      </pre>
    );
  }

  return <MarkdownContent content={display} className={className} theme={theme} density={density} />;
}

/** 可点击本地路径（用 code/span，避免嵌套 button；中性字色，少网页蓝链感） */
export function PathLink({ path, className, title }) {
  return (
    <code
      role="link"
      tabIndex={0}
      title={title || '点击打开本地路径'}
      className={`px-1 py-0.5 rounded text-[0.9em] font-mono cursor-pointer break-all text-zinc-700 dark:text-zinc-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${className || ''}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openLocalPath(path);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          openLocalPath(path);
        }
      }}
    >
      {path}
    </code>
  );
}

/** 纯文本中的本地路径拆成可点击片段 */
function renderTextWithPaths(text, keyPrefix, pathClassName) {
  const s = String(text || '');
  if (!s) return null;
  // 勿把 `.` 列入终止符，否则 `/path/file.pptx` 会在扩展名前断开
  const re = /(?:^|[\s「『"'(=:：])((?:\/(?:Users|home|tmp|var|opt|private|Volumes)|~\/|[A-Za-z]:[\\/])[^\s`'"<>|]+)/g;
  const nodes = [];
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(s)) !== null) {
    const raw = m[1];
    // 剥开 `.mp4Duration` 这类扩展名后粘连的单词
    const { path: full } = splitGluedLocalPath(raw);
    const start = m.index + (m[0].length - raw.length);
    if (!full) {
      last = Math.max(last, start + raw.length);
      continue;
    }
    if (start > last) {
      nodes.push(<React.Fragment key={`${keyPrefix}-t${i++}`}>{s.slice(last, start)}</React.Fragment>);
    }
    if (looksLikeLocalPath(full)) {
      nodes.push(<PathLink key={`${keyPrefix}-p${i++}`} path={full} className={pathClassName} />);
      last = start + full.length;
      // 粘连后缀前补空格，避免视觉上仍像一个词
      if (/^[A-Za-z\u4e00-\u9fff]/.test(s.slice(last))) {
        nodes.push(<React.Fragment key={`${keyPrefix}-sp${i++}`}>{' '}</React.Fragment>);
      }
    } else {
      nodes.push(<React.Fragment key={`${keyPrefix}-t${i++}`}>{full}</React.Fragment>);
      last = start + full.length;
    }
  }
  if (last < s.length) {
    nodes.push(<React.Fragment key={`${keyPrefix}-t${i++}`}>{s.slice(last)}</React.Fragment>);
  }
  return nodes.length ? nodes : s;
}

/** 行内 Markdown */
function renderInline(text, codeClassName = 'bg-gray-100 dark:bg-gray-800', codeSize = 'text-[0.9em]') {
  if (!text) return null;
  // `_` 强调要求两侧不是词字符/路径符，避免 `a_b_c.png` 这类文件名被拆成斜体
  const re = /(\*\*[^*]+\*\*|(?<![\w/.\u4e00-\u9fff])__[^_]+__(?![\w\u4e00-\u9fff])|\*[^*\s][^*]*\*|(?<![\w/.\u4e00-\u9fff])_[^_\s][^_]*_(?![\w\u4e00-\u9fff])|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) });
    const token = m[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      parts.push({ type: 'bold', value: token.slice(2, -2) });
    } else if (token.startsWith('*') || token.startsWith('_')) {
      parts.push({ type: 'italic', value: token.slice(1, -1) });
    } else if (token.startsWith('`')) {
      parts.push({ type: 'code', value: token.slice(1, -1) });
    } else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (lm) parts.push({ type: 'link', label: lm[1], href: lm[2] });
      else parts.push({ type: 'text', value: token });
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });

  // 路径链接用中性色，避免网页蓝链；外链仍略区分
  const pathCodeCls = codeClassName.includes('white')
    ? `${codeClassName} text-white/90`
    : `${codeClassName} text-zinc-700 dark:text-zinc-300`;
  const externalLinkCls = codeClassName.includes('white')
    ? 'text-white/90 hover:opacity-80 break-all'
    : 'text-zinc-700 dark:text-zinc-300 underline decoration-zinc-300/80 dark:decoration-zinc-600 underline-offset-2 hover:decoration-zinc-500 break-all';

  return parts.map((p, i) => {
    // 粗体 / 斜体内部继续解析（如 **文件：`/path/a.png`** 里的路径仍可点）
    if (p.type === 'bold') return <strong key={i} className="font-semibold">{renderInline(p.value, codeClassName, codeSize)}</strong>;
    if (p.type === 'italic') return <em key={i}>{renderInline(p.value, codeClassName, codeSize)}</em>;
    if (p.type === 'code') {
      const trimmed = p.value.trim();
      // 整段已是合法路径时直接可点；折行后的路径先拼回再识别
      let { path: codePath, rest } = unwrapLocalPathToken(trimmed);
      if (!looksLikeLocalPath(codePath)) {
        ({ path: codePath, rest } = splitGluedLocalPath(trimmed));
      }
      if (looksLikeLocalPath(codePath)) {
        const gap = rest && /^[A-Za-z\u4e00-\u9fff]/.test(rest) ? ' ' : '';
        return (
          <React.Fragment key={i}>
            <PathLink path={codePath} className={pathCodeCls} />
            {gap}{rest || null}
          </React.Fragment>
        );
      }
      return (
        <code key={i} className={`px-1 py-0.5 rounded ${codeSize} font-mono ${codeClassName}`}>
          {p.value}
        </code>
      );
    }
    if (p.type === 'link') {
      const href = String(p.href || '').trim();
      // file:/// 或裸本地路径的 markdown 链接 → 应用内预览 / 系统打开
      if (looksLikeLocalPath(href.replace(/^file:\/\//i, '')) || /^file:\/\//i.test(href)) {
        const local = href.replace(/^file:\/\//i, '');
        const openTarget = looksLikeLocalPath(local)
          ? local
          : (splitGluedLocalPath(local).path || local);
        return (
          <span
            key={i}
            role="link"
            tabIndex={0}
            title="点击打开本地路径"
            className={`${pathCodeCls} cursor-pointer hover:bg-black/[0.04] dark:hover:bg-white/[0.06] rounded px-0.5`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLocalPath(openTarget); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openLocalPath(openTarget);
              }
            }}
          >
            {p.label}
          </span>
        );
      }
      return (
        <a key={i} href={resolveMediaUrl(p.href)} target="_blank" rel="noopener noreferrer"
          className={externalLinkCls}>
          {p.label}
        </a>
      );
    }
    return <React.Fragment key={i}>{renderTextWithPaths(p.value, `tx${i}`, pathCodeCls)}</React.Fragment>;
  });
}

function isBlockStart(line) {
  const t = line.trim();
  return !t
    || /^#{1,4}\s/.test(t)
    || /^[-*+•·▪▫]\s+/.test(t)
    || /^\d+\.\s+/.test(t)
    || /^\|.+\|/.test(t)
    || t.startsWith('>')
    || /^-{3,}$/.test(t)
    || /^\*{3,}$/.test(t);
}

/** 将文本块解析为 Markdown 块级元素 */
function parseMarkdownBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // 围栏代码块 ```lang
    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ type: 'code', lang, text: codeLines.join('\n') });
      continue;
    }

    const hm = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (hm) {
      blocks.push({ type: 'heading', level: hm[1].length, text: hm[2] });
      i++;
      continue;
    }

    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') });
      continue;
    }

    // GFM 表格：| a | b | / |---|---|
    if (/^\|.+\|/.test(trimmed)) {
      const rows = [];
      while (i < lines.length && /^\|.+\|/.test(lines[i].trim())) {
        const row = lines[i].trim();
        i++;
        // 跳过对齐分隔行
        if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(row)) continue;
        const cells = row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
        if (cells.length) rows.push(cells);
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }

    // 无序列表（含模型常输出的 • · 等）
    if (/^[-*+•·▪▫]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*+•·▪▫]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+•·▪▫]\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    const paraLines = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) blocks.push({ type: 'p', text: paraLines.join('\n') });
  }

  return blocks;
}

function renderTextBlock(text, keyPrefix, theme = 'default', density = 'default') {
  const blocks = parseMarkdownBlocks(text);
  const isInv = theme === 'inverted';
  // reading：比智能管家正文小一号，14px / 行高 1.5；代码和表格再小一档
  const reading = density === 'reading';
  const headingCls = reading
    ? {
      1: `text-[14px] font-semibold mt-1 ${isInv ? 'text-white' : 'text-zinc-900 dark:text-zinc-100'}`,
      2: `text-[14px] font-semibold mt-1 ${isInv ? 'text-white' : 'text-zinc-900 dark:text-zinc-100'}`,
      3: `text-[14px] font-semibold mt-1 ${isInv ? 'text-white' : 'text-zinc-900 dark:text-zinc-100'}`,
      4: `text-[14px] font-medium mt-0.5 ${isInv ? 'text-white/90' : 'text-zinc-800 dark:text-zinc-200'}`,
    }
    : {
      1: `text-lg font-bold mt-1 ${isInv ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`,
      2: `text-base font-bold mt-1 ${isInv ? 'text-white' : 'text-gray-900 dark:text-gray-100'}`,
      3: `text-sm font-semibold mt-1 ${isInv ? 'text-white' : 'text-gray-800 dark:text-gray-200'}`,
      4: `text-sm font-medium mt-0.5 ${isInv ? 'text-white/90' : 'text-gray-700 dark:text-gray-300'}`,
    };
  const bodyCls = isInv ? 'text-white/95' : 'text-gray-800 dark:text-gray-200';
  const quoteCls = isInv
    ? 'border-white/40 text-white/80'
    : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400';
  const hrCls = isInv ? 'border-white/30' : 'border-gray-200 dark:border-gray-600';
  const codeInlineCls = isInv
    ? 'bg-white/15 text-white'
    : 'bg-gray-100 dark:bg-gray-800';
  const codeSize = reading ? 'text-[12px]' : 'text-[0.9em]';
  const bodySize = reading ? 'text-[14px] leading-normal' : 'text-sm';
  const codeBlockSize = reading ? 'text-[11px] leading-relaxed' : 'text-xs';
  const tableSize = reading ? 'text-[12px] leading-relaxed' : 'text-xs';
  const inline = (value) => renderInline(value, codeInlineCls, codeSize);

  return blocks.map((b, i) => {
    const key = `${keyPrefix}-${i}`;
    if (b.type === 'heading') {
      const cls = headingCls[b.level] || headingCls[3];
      return <div key={key} className={cls}>{inline(b.text)}</div>;
    }
    if (b.type === 'code') {
      const trimmedCode = String(b.text || '').trim();
      // 整块已是路径优先原样使用；折行路径拼回后再判断
      const codePath = unwrapLocalPathToken(trimmedCode).path
        || splitGluedLocalPath(trimmedCode).path;
      // 本地路径代码块（含气泡里被折行的单条路径）：点击即可打开
      if (looksLikeLocalPath(codePath) && !/\n\s*\n/.test(trimmedCode)) {
        return (
          <pre
            key={key}
            role="link"
            tabIndex={0}
            title="点击打开本地路径"
            className={`${codeBlockSize} font-mono overflow-x-auto rounded-lg bg-zinc-900 dark:bg-zinc-950 text-zinc-200 px-3 py-2 my-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-words cursor-pointer hover:bg-zinc-800`}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLocalPath(codePath); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openLocalPath(codePath);
              }
            }}
          >
            {codePath}
          </pre>
        );
      }
      return (
        <pre key={key}
          className={`${codeBlockSize} font-mono overflow-x-auto rounded-lg bg-zinc-900 dark:bg-zinc-950 text-zinc-100 px-3 py-2 my-1 max-h-80 overflow-y-auto whitespace-pre-wrap break-words`}>
          {b.text}
        </pre>
      );
    }
    if (b.type === 'hr') {
      return <hr key={key} className={`${hrCls} my-2`} />;
    }
    if (b.type === 'quote') {
      return (
        <blockquote key={key}
          className={`border-l-2 pl-3 ${bodySize} italic ${quoteCls}`}>
          {inline(b.text)}
        </blockquote>
      );
    }
    if (b.type === 'ul') {
      return (
        <ul key={key} className={`list-disc list-outside pl-5 ${bodySize} space-y-0.5 ${bodyCls}`}>
          {b.items.map((item, j) => <li key={j} className="pl-0.5">{inline(item)}</li>)}
        </ul>
      );
    }
    if (b.type === 'ol') {
      return (
        <ol key={key} className={`list-decimal list-outside pl-5 ${bodySize} space-y-0.5 ${bodyCls}`}>
          {b.items.map((item, j) => <li key={j} className="pl-0.5">{inline(item)}</li>)}
        </ol>
      );
    }
    if (b.type === 'table') {
      const [header, ...body] = b.rows;
      const cellCls = isInv
        ? 'border-white/20 px-2 py-1'
        : 'border-zinc-200 dark:border-zinc-600 px-2 py-1';
      const thCls = isInv
        ? `${cellCls} text-left font-semibold bg-white/10`
        : `${cellCls} text-left font-semibold bg-zinc-50 dark:bg-zinc-800/60`;
      return (
        <div key={key} className="overflow-x-auto my-1">
          <table className={`${tableSize} border-collapse w-full min-w-[12rem] ${bodyCls}`}>
            {header && (
              <thead>
                <tr>
                  {header.map((c, j) => (
                    <th key={j} className={`border ${thCls}`}>
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            {body.length > 0 && (
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((c, j) => (
                      <td key={j} className={`border ${cellCls} align-top`}>
                        {inline(c)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
      );
    }
    return (
      <p key={key} className={`whitespace-pre-wrap ${bodySize} ${bodyCls}`}>
        {inline(b.text)}
      </p>
    );
  });
}

/** 轻量 Markdown 渲染（标题/列表/表格/引用/代码块/行内样式） */
export function MarkdownContent({ content, className = '', theme = 'default', density = 'default' }) {
  if (!content) return null;
  const reading = density === 'reading';
  return (
    <div className={`${reading ? 'space-y-1.5 leading-normal' : 'space-y-1.5 leading-relaxed'} break-words ${className}`}>
      {renderTextBlock(content, 'md', theme, density)}
    </div>
  );
}

/** 圈子消息富媒体展示：Markdown + 图片 */
export default function RichMediaContent({
  content,
  className = '',
  removable = false,
  onRemoveImage,
}) {
  if (!content) return null;

  const segments = [];
  let last = 0;
  let m;
  const re = new RegExp(IMG_RE.source, 'g');
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) segments.push({ type: 'text', value: content.slice(last, m.index) });
    segments.push({ type: 'image', alt: m[1], url: m[2] });
    last = m.index + m[0].length;
  }
  if (last < content.length) segments.push({ type: 'text', value: content.slice(last) });
  if (segments.length === 0) segments.push({ type: 'text', value: content });

  return (
    <div className={`space-y-2 leading-relaxed break-words ${className}`}>
      {segments.map((seg, i) => {
        if (seg.type === 'image') {
          return (
            <div key={i} className="relative inline-block max-w-full">
              <a href={resolveMediaUrl(seg.url)} target="_blank" rel="noopener noreferrer" className="block">
                <img
                  src={resolveMediaUrl(seg.url)}
                  alt={seg.alt || 'image'}
                  className="max-w-full max-h-80 rounded-lg border border-gray-100 dark:border-gray-700 object-contain bg-gray-50 dark:bg-gray-900/40"
                  loading="lazy"
                />
              </a>
              {removable && onRemoveImage && (
                <button
                  type="button"
                  onClick={() => onRemoveImage(seg.url)}
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white text-sm leading-none hover:bg-black/80"
                >
                  ×
                </button>
              )}
            </div>
          );
        }
        return <React.Fragment key={i}>{renderTextBlock(seg.value, `t${i}`, 'default')}</React.Fragment>;
      })}
    </div>
  );
}
