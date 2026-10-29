// 模型名前缀合并：只认最后一个横线。去掉最后一段后正好等于短名，才算同一条链。
// glm-5-turbo 属于 glm-5；glm-5-2-260617 的上一段是 glm-5-2，和 glm-5 不同代。
// 点号换代（glm-5 / glm-5.1）也不是同一条链。
'use strict';

/** longer 去掉最后一个「-段」后是否正好是 base。 */
function modelExtends(base, longer) {
  const head = String(base || '').trim();
  const name = String(longer || '').trim();
  if (!head || !name || name.length <= head.length) return false;
  const cut = name.lastIndexOf('-');
  if (cut <= 0) return false;
  return name.slice(0, cut) === head;
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

function stemBeforeLastHyphen(name) {
  const cut = String(name || '').lastIndexOf('-');
  if (cut <= 0) return '';
  return name.slice(0, cut);
}

/** 请求某个模型时，后面可以再试的名字。先是下一级，再是同一代的并列名字。 */
function prefixExtensions(head, names) {
  const base = String(head || '').trim();
  if (!base) return [];
  const list = uniqueNames(names);
  const direct = list.filter(name => modelExtends(base, name)).sort(byLengthThenName);
  if (direct.length) return direct;
  const { extras } = prefixModelRoutes(list);
  const own = extras.get(base);
  if (own?.length) return own.slice();
  for (const [owner, group] of extras) {
    if (!group.includes(base) || modelExtends(owner, base)) continue;
    return [owner, ...group.filter(name => name !== base)];
  }
  return [];
}

/**
 * 列表上的合并结果。
 * extras: 某个模型 → 只比它多最后一段的变体
 * hidden: 被收进上一级、不必再单独占一张卡的名字
 * 上一级自己也被收走时，这一级留在列表里，避免整张卡消失。
 */
function prefixModelRoutes(names) {
  const list = uniqueNames(names);
  const parentOf = new Map();
  for (const name of list) {
    for (const other of list) {
      if (modelExtends(other, name)) parentOf.set(name, other);
    }
  }
  const extras = new Map();
  const hidden = new Set();
  for (const [name, head] of parentOf) {
    if (parentOf.has(head)) continue;
    hidden.add(name);
    const group = extras.get(head) || [];
    group.push(name);
    extras.set(head, group);
  }
  // 同一代的并列名字：最后一段不同，但前缀里已经带了版本号。
  // doubao-seed-2.0-code / mini 收成一条；glm-5 和 glm-4.6v 的前缀 glm 没有版本，不并。
  const pools = new Map();
  for (const name of list) {
    if (parentOf.has(name) || extras.has(name)) continue;
    const stem = stemBeforeLastHyphen(name);
    if (!stem || !/\d/.test(stem)) continue;
    const pool = pools.get(stem) || [];
    pool.push(name);
    pools.set(stem, pool);
  }
  for (const pool of pools.values()) {
    if (pool.length < 2) continue;
    pool.sort(byLengthThenName);
    const [head, ...rest] = pool;
    const group = extras.get(head) || [];
    group.push(...rest);
    extras.set(head, group);
    for (const name of rest) hidden.add(name);
  }
  for (const group of extras.values()) group.sort(byLengthThenName);
  return { extras, hidden };
}

// 用 exports.xxx 而不是 module.exports = {}，Vite 才能对上具名导入。
exports.modelExtends = modelExtends;
exports.prefixExtensions = prefixExtensions;
exports.prefixModelRoutes = prefixModelRoutes;
