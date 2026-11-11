import React from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

// 看护的回答：除了成段的话，还能出列表、表格和图表。
// 只认一小部分 Markdown（列表、表格、加粗、行内代码、代码块），外加 ```chart 代码块（JSON）画图。
// 不渲染任何 HTML：内容全部当文字处理。

const SERIES_COLORS = ['#2563eb', '#f59e0b', '#059669', '#dc2626'];

function inline(text, keyBase) {
  // **加粗** 和 `代码`
  const out = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('**')
      ? <strong key={`${keyBase}-b${i}`} className="font-semibold">{tok.slice(2, -2)}</strong>
      : <code key={`${keyBase}-c${i}`} className="px-1 py-0.5 rounded bg-zinc-200/70 dark:bg-zinc-700/70 text-[13px] font-mono">{tok.slice(1, -1)}</code>);
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

/** 把文字切成块：段落 / 列表 / 表格 / 图表 / 代码 */
export function parseBlocks(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```\s*(\w+)?\s*$/);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      if ((fence[1] || '').toLowerCase() === 'chart') {
        try {
          const spec = JSON.parse(body.join('\n'));
          if (spec && Array.isArray(spec.data) && spec.data.length) { blocks.push({ type: 'chart', spec }); continue; }
        } catch { /* 画不了就当代码显示 */ }
      }
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    // 表格：表头行 + 分隔行
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push({ type: 'table', head, rows });
      continue;
    }
    const li = line.match(/^\s*(?:([-*•])|(\d+)[.)、])\s+(.*)$/);
    if (li) {
      const ordered = !!li[2];
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:([-*•])|(\d+)[.)、])\s+(.*)$/);
        if (!m || !!m[2] !== ordered) break;
        items.push(m[3]);
        i++;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) { blocks.push({ type: 'heading', text: heading[1] }); i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^```/.test(lines[i]) && !/^\s*(?:[-*•]|\d+[.)、])\s+/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))) {
      para.push(lines[i++]);
    }
    blocks.push({ type: 'p', text: para.join('\n') });
  }
  return blocks;
}

function Chart({ spec }) {
  const series = Array.isArray(spec.series) && spec.series.length ? spec.series.slice(0, 4) : ['value'];
  const labels = spec.labels || {};
  const kind = spec.type === 'line' ? 'line' : 'bar';
  const summary = spec.data.slice(0, 12).map(d => `${d.name}：${series.map(s => `${labels[s] || s} ${d[s] ?? 0}`).join('，')}`).join('；');
  const Wrap = kind === 'line' ? LineChart : BarChart;
  return (
    <figure className="m-0 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200/70 dark:border-zinc-700 p-3">
      {spec.title && <figcaption className="text-xs font-medium text-zinc-700 dark:text-zinc-200 pb-2">{spec.title}</figcaption>}
      <div role="img" aria-label={`${spec.title || '图表'}。${summary}`} style={{ width: '100%', height: 220 }}>
        <ResponsiveContainer>
          <Wrap data={spec.data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#d4d4d8" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 11 }} interval={0} />
            <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
            <Tooltip />
            {series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
            {series.map((s, idx) => (kind === 'line'
              ? <Line key={s} type="monotone" dataKey={s} name={labels[s] || s} stroke={SERIES_COLORS[idx]} strokeWidth={2} dot={false} />
              : <Bar key={s} dataKey={s} name={labels[s] || s} fill={SERIES_COLORS[idx]} radius={[3, 3, 0, 0]} />))}
          </Wrap>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

export default function RichText({ text }) {
  const blocks = parseBlocks(text);
  return (
    <div className="space-y-2.5 text-[15px] leading-[1.75] text-zinc-900 dark:text-zinc-100 min-w-0">
      {blocks.map((b, i) => {
        if (b.type === 'p') return <p key={i} className="m-0 whitespace-pre-wrap">{inline(b.text, i)}</p>;
        if (b.type === 'heading') return <p key={i} className="m-0 font-semibold">{inline(b.text, i)}</p>;
        if (b.type === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul';
          return (
            <Tag key={i} className={`m-0 pl-5 space-y-1 ${b.ordered ? 'list-decimal' : 'list-disc'}`}>
              {b.items.map((it, j) => <li key={j}>{inline(it, `${i}-${j}`)}</li>)}
            </Tag>
          );
        }
        if (b.type === 'table') {
          return (
            <div key={i} className="overflow-x-auto rounded-xl border border-zinc-200/70 dark:border-zinc-700 bg-white dark:bg-zinc-900">
              <table className="w-full text-[13px] leading-relaxed border-collapse">
                <thead>
                  <tr>{b.head.map((h, j) => <th key={j} scope="col" className="text-left font-medium text-zinc-600 dark:text-zinc-300 px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 whitespace-nowrap">{inline(h, `${i}-h${j}`)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j} className="border-b last:border-b-0 border-zinc-100 dark:border-zinc-800">
                      {b.head.map((_, k) => <td key={k} className={`px-3 py-2 align-top ${(r[k] || '').length <= 14 ? 'whitespace-nowrap' : ''}`}>{inline(r[k] || '', `${i}-${j}-${k}`)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.type === 'chart') return <Chart key={i} spec={b.spec} />;
        return <pre key={i} className="m-0 overflow-x-auto rounded-xl bg-zinc-900 text-zinc-100 text-[12px] leading-relaxed p-3">{b.text}</pre>;
      })}
    </div>
  );
}
