// 前端 ESM。算法与 shared/model-prefix-routes.js 保持一致（Vite 不能直接用具名方式引入那个 CommonJS 文件）。
// 只认最后一个横线：去掉最后一段后正好等于短名，才收成一条链。
// v4.1 与 v4-1、2.0 与 2-0 是同一写法；glm-5 / glm-5.1 这种点号换代仍然分开。

/** 同一版本的两种写法收成一个名字。
 *  v4.1 → v4-1。
 *  最后一段之前的 2.0 → 2-0，日期快照就能挂上 doubao-seed-2.0-mini。
 *  最后一段自己的点号不动，glm-5.1 仍是换代。
 */
function canonicalVersionName(name) {
  const text = String(name || '').trim().replace(
    /(^|-)(v)(\d+(?:\.\d+)+)/gi,
    (_, sep, v, ver) => `${sep}${v}${ver.replace(/\./g, '-')}`,
  );
  const cut = text.lastIndexOf('-');
  if (cut <= 0) return text;
  let head = text.slice(0, cut);
  let prev = '';
  while (head !== prev) {
    prev = head;
    head = head.replace(/(\d)\.(\d)/g, '$1-$2');
  }
  return head + text.slice(cut);
}

function cutLastSegment(name) {
  const text = String(name || '');
  const cut = text.lastIndexOf('-');
  if (cut <= 0) return '';
  return text.slice(0, cut);
}

/** longer 去掉最后一个「-段」后是否正好是 base。比较前先把 v4.1 / v4-1 归一。 */
export function modelExtends(base, longer) {
  const head = canonicalVersionName(base);
  const name = String(longer || '').trim();
  const baseRaw = String(base || '').trim();
  if (!head || !name || name.length <= baseRaw.length) return false;
  const stem = cutLastSegment(name);
  if (!stem) return false;
  return canonicalVersionName(stem) === head;
}

/** 原始字符串就能对上的上一级。用来区分「本来就是下一级」和「只是写法不同」。 */
function rawExtends(base, longer) {
  const head = String(base || '').trim();
  const name = String(longer || '').trim();
  if (!head || !name || name.length <= head.length) return false;
  return cutLastSegment(name) === head;
}

function uniqueNames(names) {
  const out = [];
  const seen = new Set();
  for (const raw of names || []) {
    const name = String(raw || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function byLengthThenName(a, b) {
  return (a.length - b.length) || a.localeCompare(b);
}

function rootHead(name, parentOf) {
  let cur = name;
  const seen = new Set();
  while (parentOf.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return cur;
}

/**
 * 列表上的合并结果。
 * extras: 某个模型 → 收进来的变体
 * hidden: 被收进上一级、不必再单独占一张卡的名字
 * folded: 只因为 v4.1 / v4-1 才收进来的名字。已保存的链也要带上，不用先恢复默认。
 * 上一级自己也被收走时，这一级留在列表里，避免整张卡消失。
 * 例外：只因为 v4.1 / v4-1 才对上的快照，跟着可见的链头走。
 */
export function prefixModelRoutes(names) {
  const list = uniqueNames(names);
  // 完全同一写法（v4.1 与 v4-1）先收成一个代表名，链上仍保留原来的名字。
  const byCanon = new Map();
  for (const name of list) {
    const key = canonicalVersionName(name);
    const group = byCanon.get(key) || [];
    group.push(name);
    byCanon.set(key, group);
  }
  const aliasOf = new Map();
  for (const group of byCanon.values()) {
    if (group.length < 2) continue;
    group.sort(byLengthThenName);
    const rep = group[0];
    for (const name of group) {
      if (name !== rep) aliasOf.set(name, rep);
    }
  }
  const reps = list.filter((name) => !aliasOf.has(name));

  const parentOf = new Map();
  for (const name of reps) {
    let parent = '';
    for (const other of reps) {
      if (other === name || !modelExtends(other, name)) continue;
      if (!parent || other.length > parent.length) parent = other;
    }
    if (parent) parentOf.set(name, parent);
  }

  const extras = new Map();
  const hidden = new Set();
  const folded = new Set();
  const addExtra = (head, name) => {
    if (!head || head === name) return;
    const group = extras.get(head) || [];
    if (!group.includes(name)) group.push(name);
    extras.set(head, group);
  };

  for (const [name, head] of parentOf) {
    if (parentOf.has(head)) {
      if (!rawExtends(head, name)) {
        hidden.add(name);
        folded.add(name);
        addExtra(rootHead(head, parentOf), name);
      }
      continue;
    }
    hidden.add(name);
    if (!rawExtends(head, name)) folded.add(name);
    addExtra(head, name);
  }

  // 同一代的并列名字：最后一段不同，但前缀里已经带了版本号。
  // doubao-seed-2.0-code / mini 收成一条；glm-5 和 glm-4.6v 的前缀 glm 没有版本，不并。
  const pools = new Map();
  for (const name of reps) {
    if (parentOf.has(name) || extras.has(name)) continue;
    const stem = cutLastSegment(canonicalVersionName(name));
    if (!stem || !/\d/.test(stem)) continue;
    const pool = pools.get(stem) || [];
    pool.push(name);
    pools.set(stem, pool);
  }
  for (const pool of pools.values()) {
    if (pool.length < 2) continue;
    pool.sort(byLengthThenName);
    const [head, ...rest] = pool;
    for (const name of rest) {
      hidden.add(name);
      addExtra(head, name);
    }
  }

  for (const [name, rep] of aliasOf) {
    hidden.add(name);
    folded.add(name);
    const root = rootHead(rep, parentOf);
    let head = extras.has(root) ? root : rep;
    if (!extras.has(root)) {
      for (const [owner, group] of extras) {
        if (group.includes(rep)) {
          head = owner;
          break;
        }
      }
    }
    addExtra(head, name);
  }

  for (const group of extras.values()) group.sort(byLengthThenName);
  return { extras, hidden, folded };
}
