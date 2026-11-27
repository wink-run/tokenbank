// client/electron/model-redirects.js
// 模型改道：应用要的模型用不了时（下线了、账号没有、名字对不上），把这个名字转到另一个能用的模型。
// 由智能管家在请求失败后设置（guardian/model-heal.js），用户可以撤销；网关入口按这里改写模型名，只转一跳。
// 存在 ~/.tokenbank/model-redirects.json：{ "<请求的模型>": { to, by, reason, at } }
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

let cache = null;
function file() { return path.join(os.homedir(), '.tokenbank', 'model-redirects.json'); }

function all() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')) || {}; } catch { cache = {}; }
  return cache;
}

function save(next) {
  cache = next;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch { /* 写不了就只在内存里 */ }
}

function get(from) { return all()[String(from || '')] || null; }

function set(from, to, { by = 'user', reason = '' } = {}) {
  const f = String(from || '').trim();
  const t = String(to || '').trim();
  if (!f || !t || f === t) return false;
  save({ ...all(), [f]: { to: t, by, reason: String(reason || '').slice(0, 200), at: Date.now() } });
  return true;
}

function remove(from) {
  const cur = { ...all() };
  if (!cur[from]) return false;
  delete cur[from];
  save(cur);
  return true;
}

/** 网关入口：要改道就返回新名字，否则原样（只转一跳，不会转成环） */
function resolve(model) {
  const hit = get(model);
  return hit && hit.to ? hit.to : model;
}

module.exports = { all, get, set, remove, resolve, _reset: () => { cache = null; } };
