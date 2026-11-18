// client/src/api/deviceName.js
// 设备名称：每台设备一个，盘点里显示、派活时写 @名称、出租接单也上报它。
// 存在那台设备自己的 ~/.llm-agent/config.json 的 name（交易页「设备名称」同一个字段）。
// 改本机：经本机网关写（同时推给我的其他设备）；网关没开设备网络时直接写本机配置。
// 改别的设备：经本机网关和设备网络转给那台设备，由它自己保存。
import { getConfig, getGateway, getLocalConfig } from './adapter';
import { resolveLocalGatewayBase } from './gatewayModels';

const RESERVED = new Set(['本机', 'local', 'self', 'localhost']);

/** 名称不合规返回原因（中文），合规返回空串。空名称表示用回电脑名，合规 */
export function deviceNameError(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  if (n.length > 32) return '名称最多 32 个字';
  if (/[\s@/\\]/.test(n)) return '名称里不能有空格、@、/：派活时要写 @名称';
  if (RESERVED.has(n.toLowerCase())) return '不能叫「本机」';
  return '';
}

async function gatewayRequest(path, body) {
  let port = 11430;
  try { port = (await getGateway().status())?.port || port; } catch { /* 用默认端口 */ }
  let key = '';
  try { key = String((await getLocalConfig().get())?.agent_api_key || ''); } catch { key = ''; }
  const base = resolveLocalGatewayBase(port);
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

/**
 * 改设备名称。
 * @param {'self'|string} deviceId 本机传 'self'
 * @returns {Promise<{ ok: true, name: string|null } | { ok: false, error: string }>}
 */
export async function renameDevice(deviceId, name) {
  const n = String(name || '').trim();
  const bad = deviceNameError(n);
  if (bad) return { ok: false, error: bad };
  const self = deviceId === 'self';
  try {
    const { status, json } = await gatewayRequest(`/devices/${encodeURIComponent(deviceId)}/name`, { name: n });
    if (status === 200) return { ok: true, name: json?.name ?? (n || null) };
    // 网关没开设备网络：本机的名称照样能改，直接写本机配置
    if (!(self && status === 503)) return { ok: false, error: json?.error?.message || `没改成（HTTP ${status}）` };
  } catch (e) {
    if (!self) return { ok: false, error: `连不上本机网关：${e.message}` };
  }
  const cur = (await getConfig().read().catch(() => null)) || {};
  const next = { ...cur };
  if (n) next.name = n; else delete next.name;
  await getConfig().write(next);
  return { ok: true, name: n || null };
}
