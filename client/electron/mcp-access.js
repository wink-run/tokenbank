// client/electron/mcp-access.js
// 本机各应用用 Token Bank 工具（tokenbank MCP）的权限，和外部智能体是同样的四档：
//   off 关闭 / read 只看 / operate 能派活、调模型 / full 再加雇佣社区智能体、调第三方 MCP
// 本机应用默认 full；外部智能体的权限存在 external-agents 里，默认 off。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = path.join(os.homedir(), '.tokenbank', 'mcp-access.json');
const LEVELS = ['off', 'read', 'operate', 'full'];
const DEFAULT_APP_LEVEL = 'full';

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' && j.apps && typeof j.apps === 'object' ? j : { apps: {} };
  } catch {
    return { apps: {} };
  }
}

/** 这个应用的权限；没设过就是 full */
function appLevel(clientId) {
  const lv = read().apps[String(clientId || '')];
  return LEVELS.includes(lv) ? lv : DEFAULT_APP_LEVEL;
}

/** 所有设过的（UI 用） */
function appLevels() {
  return { ...read().apps };
}

function setAppLevel(clientId, level) {
  const id = String(clientId || '').trim();
  if (!/^[\w.-]{1,64}$/.test(id)) throw new Error('应用 id 不对');
  if (!LEVELS.includes(level)) throw new Error(`权限只能是 ${LEVELS.join(' / ')}`);
  const doc = read();
  if (level === DEFAULT_APP_LEVEL) delete doc.apps[id];
  else doc.apps[id] = level;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
  return appLevel(id);
}

module.exports = { LEVELS, DEFAULT_APP_LEVEL, appLevel, appLevels, setAppLevel };
