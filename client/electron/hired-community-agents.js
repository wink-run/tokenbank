// hired-community-agents.js
// 雇佣的社区武将：仅存名片引用（无正文），供 MCP / 游乐场派发
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STORE_PATH = path.join(os.homedir(), '.llm-agent', 'hired-community-agents.json');
const COMMUNITY_PREFIX = 'community:';
// 云端 worker 连接时发的设备 id（uuid 前 8 位）。对外标识不用它。
const DEVICE_ID_RE = /^[0-9a-f]{8}$/i;

/** 用户名里不能再带 @，否则和 community:<id>@<用户名> 的分隔符冲突。 */
function communityOwnerToken(owner) {
  return String(owner || '').trim().replace(/^@+/, '').replace(/@/g, '');
}

function makeCommunityAgentId(assistantId, owner) {
  const aid = String(assistantId || '').trim();
  if (!aid) return '';
  const who = communityOwnerToken(owner);
  // 旧数据可能把设备 id 传进来，不写进对外标识
  if (!who || DEVICE_ID_RE.test(who)) return `${COMMUNITY_PREFIX}${aid}`;
  return `${COMMUNITY_PREFIX}${aid}@${who}`;
}

function parseCommunityAgentId(agentId) {
  const raw = String(agentId || '').trim();
  if (!raw.startsWith(COMMUNITY_PREFIX)) return null;
  const rest = raw.slice(COMMUNITY_PREFIX.length);
  if (!rest) return null;
  const at = rest.indexOf('@');
  if (at < 0) return { assistant_id: rest, worker_id: null, owner: null };
  const suffix = rest.slice(at + 1) || '';
  // 旧链接 @ 后面是设备 id，不当作用户名
  if (DEVICE_ID_RE.test(suffix)) {
    return { assistant_id: rest.slice(0, at), worker_id: suffix, owner: null };
  }
  return {
    assistant_id: rest.slice(0, at),
    worker_id: null,
    owner: suffix || null,
  };
}

function isCommunityAgentId(agentId) {
  return String(agentId || '').startsWith(COMMUNITY_PREFIX);
}

function readStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { hired: [] };
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const hired = Array.isArray(raw?.hired) ? raw.hired : [];
    return { hired };
  } catch {
    return { hired: [] };
  }
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify({ hired: store.hired || [] }, null, 2), 'utf8');
}

/** @returns {object[]} */
function listHired() {
  return readStore().hired.filter((h) => h && h.id && h.assistant_id);
}

/**
 * 雇佣（写入本机白名单；不下载正文）
 * @param {{ assistant_id: string, owner?: string, owner_nickname?: string, display_name?: string, description?: string, runtime?: string }} card
 */
function hire(card = {}) {
  const assistant_id = String(card.assistant_id || card.id || '').trim();
  if (!assistant_id) throw new Error('missing assistant_id');
  const owner = communityOwnerToken(card.owner || card.owner_nickname) || null;
  const id = makeCommunityAgentId(assistant_id, owner);
  const store = readStore();
  const next = {
    id,
    assistant_id,
    owner,
    display_name: String(card.display_name || card.name || assistant_id).slice(0, 80),
    description: String(card.description || '').slice(0, 200),
    runtime: String(card.runtime || '').slice(0, 40),
    hired_at: new Date().toISOString(),
  };
  const idx = store.hired.findIndex((h) => h.id === id);
  if (idx >= 0) store.hired[idx] = { ...store.hired[idx], ...next };
  else store.hired.push(next);
  writeStore(store);
  return next;
}

function unhire(agentIdOrAssistantId) {
  const raw = String(agentIdOrAssistantId || '').trim();
  if (!raw) return false;
  const store = readStore();
  const before = store.hired.length;
  store.hired = store.hired.filter((h) => {
    if (h.id === raw) return false;
    if (h.assistant_id === raw) return false;
    if (makeCommunityAgentId(h.assistant_id, h.owner || h.owner_nickname) === raw) return false;
    return true;
  });
  if (store.hired.length === before) return false;
  writeStore(store);
  return true;
}

function getHired(agentId) {
  const parsed = parseCommunityAgentId(agentId);
  const list = listHired();
  if (!parsed) {
    return list.find((h) => h.id === agentId || h.assistant_id === agentId) || null;
  }
  return list.find((h) => {
    if (h.id === agentId) return true;
    if (h.assistant_id !== parsed.assistant_id) return false;
    if (parsed.owner) {
      const ho = communityOwnerToken(h.owner || h.owner_nickname);
      if (ho && ho.toLowerCase() !== parsed.owner.toLowerCase()) return false;
    }
    return true;
  }) || null;
}

/** 转为 listAvailableAgents 条目 */
function toAgentListEntries() {
  return listHired().map((h) => ({
    id: makeCommunityAgentId(h.assistant_id, h.owner || h.owner_nickname),
    name: h.display_name || h.assistant_id,
    type: 'community',
    custom: true,
    community: true,
    assistantId: h.assistant_id,
    owner: h.owner || h.owner_nickname || null,
    runtimeAgentId: h.runtime || '',
    runtimeName: 'remote',
    description: h.description || '社区智能体（对方设备执行，不下载正文）',
    capabilities: ['chat', 'community'],
    status: 'active',
  }));
}

module.exports = {
  COMMUNITY_PREFIX,
  STORE_PATH,
  makeCommunityAgentId,
  parseCommunityAgentId,
  isCommunityAgentId,
  listHired,
  hire,
  unhire,
  getHired,
  toAgentListEntries,
};
