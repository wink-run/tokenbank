// client/electron/agent-designation.js
// 在智能体路由的输入里点名执行者：「/codex 修一下登录页」「/codex@bf54 …」「/写诗专家 写一首…」。
// 点名了就跳过主智能体的挑选，直接交给这个智能体；带 @设备 或本机没有时走设备网络。
// 名字对不上任何智能体就不算点名，原样当普通文字（避免把 /usr/bin 之类的路径当成点名）。
'use strict';

// 应用的常用简称
const ALIASES = {
  claude: 'claude-code',
  cc: 'claude-code',
  'claude-code': 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  pi: 'pi',
  kimi: 'kimi-code',
  'kimi-code': 'kimi-code',
};

/**
 * 拆出点名。不是点名格式返回 null。
 *   "/codex@mini 修一下" → { name: 'codex', device: 'mini', text: '修一下', raw: '/codex@mini' }
 */
function parseDesignation(prompt) {
  const s = String(prompt || '');
  const m = s.match(/^\/([^\s@/]{1,64})(?:@([^\s/]{1,80}))?[ \t　]+(\S[\s\S]*)$/);
  if (!m) return null;
  return { name: m[1], device: m[2] || null, text: m[3].trim(), raw: `/${m[1]}${m[2] ? `@${m[2]}` : ''}` };
}

function norm(x) { return String(x || '').trim().toLowerCase(); }

/** 名字 → 本机智能体条目（应用 id、简称、专业 / 外部智能体的名字或 id） */
function matchLocal(name, agents) {
  const key = norm(name);
  const want = ALIASES[key] || key;
  const list = Array.isArray(agents) ? agents : [];
  return list.find((a) => a && !a.guardian && a.type === 'cli' && a.installed && a.id === want)
    || list.find((a) => a && (a.type === 'assistant' || a.type === 'external')
      && (norm(a.id) === key || norm(a.id) === `assistant:${key}` || norm(a.name) === key))
    || null;
}

/** 名字 → 别的设备上的智能体 id（只看在线设备）；没有返回 null */
function matchRemote(name, devices, deviceName) {
  const key = norm(name);
  const want = ALIASES[key] || key;
  for (const d of devices || []) {
    if (!d || d.self || !d.online) continue;
    if (deviceName && norm(d.name) !== norm(deviceName) && String(d.device_id) !== String(deviceName)) continue;
    const items = [...(d.descriptor?.apps || []), ...(d.descriptor?.assistants || [])];
    const hit = items.find((a) => norm(a.id) === want || norm(a.id) === `assistant:${key}` || norm(a.name) === key);
    if (hit) return hit.id;
  }
  return null;
}

/**
 * 解析点名。
 * @param {string} prompt
 * @param {{ agents: Array, devices?: Array }} ctx  agents 是本机 listAvailableAgents()，devices 是设备网络目录
 * @returns {null | { harnessId: string, text: string, raw: string, agentName: string, device: string|null }}
 */
function resolveDesignation(prompt, { agents, devices } = {}) {
  const p = parseDesignation(prompt);
  if (!p) return null;
  const local = matchLocal(p.name, agents);
  // 指定了设备：本机名也算本机
  if (p.device && !['本机', 'local', 'self'].includes(norm(p.device))) {
    const remoteId = matchRemote(p.name, devices, p.device) || (local && local.id) || ALIASES[norm(p.name)] || null;
    if (!remoteId) return null;
    return { harnessId: `mine:${remoteId}@${p.device}`, text: p.text, raw: p.raw, agentName: remoteId, device: p.device };
  }
  if (local) return { harnessId: local.id, text: p.text, raw: p.raw, agentName: local.name || local.id, device: null };
  const remoteId = matchRemote(p.name, devices, null);
  if (remoteId) return { harnessId: `mine:${remoteId}`, text: p.text, raw: p.raw, agentName: remoteId, device: null };
  return null;
}

module.exports = { parseDesignation, resolveDesignation, ALIASES };
