// client/electron/guardian/share-suggest.js
// 分享推荐：自己写的技能 / 提示词用得多、社区里还没有类似的，就建议分享（别人纳管时你拿积分）。
// 只给建议并跳到资产页；分享要用户自己点，发布前还会做一遍「分享前整理」。
'use strict';

const guardian = require('./index');

const WINDOW_DAYS = 30;
const MIN_CALLS = 5;
const MAX_PER_RUN = 3;
const SIMILAR = 0.5;

function rm() {
  const m = require('../resource-manager');
  m.init();
  return m;
}

/** 自己写的：不是内置、不是从社区目录或 GitHub 装的、也还没分享过 */
function isOwnWork(r) {
  const meta = r.metadata || {};
  const url = String(r.source_url || '');
  if (meta.builtin || r.source === 'builtin' || r.source === 'catalog') return false;
  if (url.startsWith('catalog:') || url.startsWith('builtin:') || /^https?:\/\//.test(url)) return false;
  if (meta.github_source || meta.community_recommended || meta.user_recommended) return false;
  return true;
}

function grams(s) {
  const t = String(s || '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    if (/\S\S/.test(g)) set.add(g);
  }
  t.split(/[^a-z0-9]+/).filter(w => w.length > 2).forEach(w => set.add(w));
  return set;
}

function similar(a, b) {
  const ga = grams(a);
  const gb = grams(b);
  let n = 0;
  ga.forEach(x => { if (gb.has(x)) n++; });
  return n / Math.max(4, Math.min(ga.size, gb.size));
}

function useCounts(sinceMs) {
  try {
    const d = require('../local-stats').getDb();
    if (!d) return new Map();
    const rows = d.prepare('SELECT LOWER(skill_key) AS k, COUNT(*) AS n FROM skill_calls WHERE ts >= ? GROUP BY LOWER(skill_key)').all(sinceMs);
    return new Map(rows.map(r => [r.k, r.n]));
  } catch {
    return new Map();
  }
}

async function check() {
  if (guardian.modeOf('community') === 'off') return { ok: true, skipped: true };
  const m = rm();
  const uses = useCounts(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let catalog = [];
  try { catalog = require('../resource-catalog').listCatalogItems({}); } catch { /* 离线 */ }
  const picked = [];
  for (const r of m.listResources({}).filter(x => ['skill', 'prompt'].includes(x.type) && isOwnWork(x))) {
    const n = uses.get(String(r.name).toLowerCase()) || 0;
    if (n < MIN_CALLS) continue;
    const me = `${r.name} ${r.display_name || ''} ${r.description || ''}`;
    const twin = catalog.find(c => c.type === r.type
      && (c.name === r.name || similar(me, `${c.name} ${c.display_name || ''} ${c.description || ''}`) >= SIMILAR));
    if (twin) continue;
    picked.push({ r, n });
  }
  picked.sort((a, b) => b.n - a.n);
  for (const { r, n } of picked.slice(0, MAX_PER_RUN)) {
    guardian.record({
      category: 'community', kind: 'share-suggest', status: 'suggested', countAsRepeat: false,
      title: `「${r.display_name || r.name}」最近 ${WINDOW_DAYS} 天用了 ${n} 次，社区里还没有类似的`,
      advice: '分享到社区后，别人纳管时你能拿积分；发布前会先帮你去掉路径、密钥这类私人信息。',
      signature: `share-suggest|${r.id}`,
      link: { to: '/resources', label: '去分享', state: { resourceType: r.type, selectKey: `r-${r.id}` } },
      meta: { resourceId: r.id, uses: n },
    });
  }
  return { ok: true, suggested: Math.min(picked.length, MAX_PER_RUN) };
}

function register() {
  guardian.registerCheck('share-suggest', check, 12 * 60 * 60 * 1000);
}

module.exports = { register, check, isOwnWork };
