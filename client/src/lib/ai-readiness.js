// Token Bank 的智能功能依赖两样东西：
//  - 模型：一句话建智能体、扫描后自动打标签、闲置技能判断，走本地网关 model:auto
//  - 应用（智能体运行时）：兴趣画像、为我推荐、安装助手等内置智能体，需投射到已纳管的应用
// 这里统一检测，结果短时缓存，供各处提示复用。
import { useCallback, useEffect, useState } from 'react';
import { fetchLocalGatewayModelsJsonOnly } from '../api/gatewayModels';

const BUILTIN = new Set(['resource-installer', 'resource-finder', 'resource-portrait']);
const TTL = 30 * 1000;
let cache = null;
let inflight = null;

async function checkModel() {
  try {
    const json = await fetchLocalGatewayModelsJsonOnly();
    if (!json) return false; // 网关未启动
    const list = Array.isArray(json.data) ? json.data : [];
    return list.some((m) => {
      const ty = String(m.model_type || m.type || 'chat');
      return (m.id || m.name) && ty !== 'image';
    });
  } catch {
    return null; // 不确定时不打扰
  }
}

async function checkAgent() {
  const api = window.electronAPI?.resource;
  if (!api?.listResources) return null;
  try {
    if (api.ensureBuiltinAssistants) await api.ensureBuiltinAssistants();
    const res = await api.listResources({ type: 'assistant' });
    const builtins = (res?.resources || []).filter((r) => BUILTIN.has(String(r.name || '')));
    if (!builtins.length) return null;
    return builtins.some((r) => (r.projections || []).length > 0);
  } catch {
    return null;
  }
}

/** @returns {Promise<{ model: boolean|null, agent: boolean|null }>} */
export function checkAiReadiness({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL) return Promise.resolve(cache.value);
  if (!force && inflight) return inflight;
  inflight = Promise.all([checkModel(), checkAgent()]).then(([model, agent]) => {
    const value = { model, agent };
    cache = { at: Date.now(), value };
    inflight = null;
    return value;
  });
  return inflight;
}

export function useAiReadiness() {
  const [state, setState] = useState({ model: null, agent: null, loading: true });
  const refresh = useCallback(async (force = true) => {
    setState((s) => ({ ...s, loading: true }));
    const v = await checkAiReadiness({ force });
    setState({ ...v, loading: false });
    return v;
  }, []);
  useEffect(() => {
    let alive = true;
    checkAiReadiness().then((v) => { if (alive) setState({ ...v, loading: false }); });
    return () => { alive = false; };
  }, []);
  return { ...state, refresh };
}
