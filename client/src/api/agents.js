// client/src/api/agents.js
// CLI agent 透明接入 IPC 封装（Electron 模式专用）。

export function isElectron() {
  return typeof window !== 'undefined' && !!window.electronAPI && !window.electronAPI.__web;
}

export async function listAgents() {
  if (!isElectron()) return [];
  return window.electronAPI.agents.list();
}

export async function applyAgent(id) {
  if (!isElectron()) return { ok: false, error: 'not-electron' };
  return window.electronAPI.agents.apply(id);
}

export async function revertAgent(id) {
  if (!isElectron()) return { ok: false, error: 'not-electron' };
  return window.electronAPI.agents.revert(id);
}
