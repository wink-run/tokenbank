// 模型页「在别处可选」关掉的模型：路由、游乐场、应用选模型时不列出。
// 存在网关配置的 hidden_models 里（模型名列表）；只影响「选」，不影响已经配好的路由和调用。
import { getConfig } from '../api/adapter';

export function readHiddenModels(cfg) {
  const list = Array.isArray(cfg?.hidden_models) ? cfg.hidden_models : [];
  return new Set(list.map(x => String(x || '').trim()).filter(Boolean));
}

export async function loadHiddenModels() {
  try { return readHiddenModels(await getConfig().read()); } catch { return new Set(); }
}

/** 改一个模型的「在别处可选」；返回新的集合 */
export async function setModelHidden(name, hidden) {
  const cfg = (await getConfig().read()) || {};
  const set = readHiddenModels(cfg);
  const key = String(name || '').trim();
  if (!key) return set;
  if (hidden) set.add(key); else set.delete(key);
  await getConfig().write({ ...cfg, hidden_models: [...set].sort() });
  return set;
}
