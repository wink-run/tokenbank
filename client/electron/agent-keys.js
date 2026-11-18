// client/electron/agent-keys.js
// 每个可调用的智能体（专业智能体、外部智能体、智能体路由）各有一个接口 Key：
// 用它调 /v1/agent 只能调这一个智能体；可以在网关页重新生成（旧的立刻作废）。
// 通用智能体（Claude Code、Codex 等应用）用应用自己的 Key，不在这里。
// 存在 ~/.tokenbank/agent-keys.json（只有本人可读）。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function file() { return path.join(os.homedir(), '.tokenbank', 'agent-keys.json'); }

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return d && typeof d.keys === 'object' && d.keys ? d : { keys: {} };
  } catch { return { keys: {} }; }
}

function write(d) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2), { mode: 0o600 });
}

function newKey() { return `tbk_${crypto.randomBytes(20).toString('hex')}`; }

/** 这个智能体的 Key；还没有就生成一个 */
function get(agentId) {
  const id = String(agentId || '').trim();
  if (!id) throw new Error('缺少智能体 id');
  const d = read();
  if (!d.keys[id]) {
    d.keys[id] = { key: newKey(), createdAt: Date.now() };
    write(d);
  }
  return d.keys[id].key;
}

/** 重新生成：旧 Key 立刻不能用 */
function regenerate(agentId) {
  const id = String(agentId || '').trim();
  if (!id) throw new Error('缺少智能体 id');
  const d = read();
  d.keys[id] = { key: newKey(), createdAt: Date.now() };
  write(d);
  return d.keys[id].key;
}

/** 这个 Key 属于哪个智能体；不是智能体 Key 返回 null */
function agentForKey(key) {
  const k = String(key || '').trim();
  if (!k.startsWith('tbk_')) return null;
  for (const [id, v] of Object.entries(read().keys)) {
    if (v && v.key && v.key.length === k.length && crypto.timingSafeEqual(Buffer.from(v.key), Buffer.from(k))) return id;
  }
  return null;
}

module.exports = { get, regenerate, agentForKey, _internal: { file } };
