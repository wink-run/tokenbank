// 技能系列：同一前缀（arkcli-agent / arkcli-auth …）或同一父目录下的技能归为一组，
// 避免一个系列被打散在列表里。

const SEP_RE = /^([a-z0-9][a-z0-9.]*?)[-_:/]/i;
// 太泛的前缀不成系列
const GENERIC = new Set(['my', 'the', 'a', 'an', 'new', 'test', 'tmp', 'skill', 'skills', 'tool', 'tools']);

function nestedParent(path) {
  // …/skills/<series>/<skill>/SKILL.md → <series>
  const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
  const i = parts.lastIndexOf('skills');
  if (i < 0 || parts.length - i < 4) return '';
  return parts[i + 1];
}

/** 返回系列键（小写），无系列返回 '' */
export function seriesKeyOf(item) {
  if (!item) return '';
  const meta = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
  const explicit = meta.series || item.series;
  if (explicit) return String(explicit).toLowerCase();
  const nested = nestedParent(item.authorityPath || item.path || meta.authority_path);
  if (nested) return nested.toLowerCase();
  const name = String(item.name || item.display_name || '').trim();
  const m = name.match(SEP_RE);
  if (!m) return '';
  const key = m[1].toLowerCase();
  if (key.length < 2 || GENERIC.has(key)) return '';
  return key;
}

/**
 * 把已排序的行按系列分组：同系列 ≥2 项才成组，组的位置取首个成员的位置。
 * @returns {Array<{ group: null, row } | { group: { key, label, rows } }>}
 */
export function groupBySeries(rows, keyOf, minSize = 2) {
  const buckets = new Map();
  for (const row of rows) {
    const k = keyOf(row);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(row);
  }
  const out = [];
  const emitted = new Set();
  for (const row of rows) {
    const k = keyOf(row);
    const bucket = k ? buckets.get(k) : null;
    if (!bucket || bucket.length < minSize) {
      out.push({ group: null, row });
      continue;
    }
    if (emitted.has(k)) continue;
    emitted.add(k);
    out.push({ group: { key: k, label: k, rows: bucket } });
  }
  return out;
}
