import axios from 'axios';
import { getServerUrl, normalizeServerBase, getApiBaseUrl } from '../config';

const http = axios.create({ timeout: 15000 });

// Read serverUrl and token from localStorage on every request
http.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/** Electron 主进程发请求，绕过系统代理 / CORS */
async function authRequest(method, path, { body, token } = {}) {
  if (window.electronAPI?.auth?.request) {
    const base = getServerUrl();
    const r = await window.electronAPI.auth.request({
      base, method, path, body: body ?? null, token: token || null,
    });
    let data = null;
    if (r.body) {
      try { data = JSON.parse(r.body); } catch { data = { detail: r.body }; }
    }
    // status 0 是主进程网络失败（代理/超时），不能当成空成功
    if (!r.status || r.status >= 400) {
      const detail = data?.detail ?? data?.message ?? r.body ?? `HTTP ${r.status}`;
      const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
      err.response = { status: r.status, data };
      throw err;
    }
    return { data };
  }
  const cfg = { method, url: path, baseURL: getApiBaseUrl() };
  if (body != null) cfg.data = body;
  if (token) cfg.headers = { Authorization: `Bearer ${token}` };
  return http.request(cfg);
}

function formatApiError(err, fallback) {
  if (err.response?.data?.detail) {
    const d = err.response.data.detail;
    return typeof d === 'string' ? d : JSON.stringify(d);
  }
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) {
    const base = getServerUrl();
    return base ? `连接超时，请检查服务地址 ${base}` : '连接超时，请先配置 Token Bank 服务地址';
  }
  if (!err.response) {
    const base = getServerUrl();
    return base
      ? `无法连接服务器 ${base}，请确认地址正确且服务已启动`
      : '请先填写 Token Bank 服务地址';
  }
  return fallback;
}

export { formatApiError };

export function login(email, password) {
  return authRequest('POST', '/user/login', { body: { email, password } });
}

export function register(email, password, nickname = '', referral_code = '', circle_code = '') {
  return authRequest('POST', '/user/register', { body: { email, password, nickname, referral_code, circle_code } });
}

/** 申请密码重置验证码 */
export function forgotPassword(email) {
  return authRequest('POST', '/user/forgot-password', { body: { email } });
}

/** 用验证码设置新密码 */
export function resetPassword(email, code, new_password) {
  return authRequest('POST', '/user/reset-password', { body: { email, code, new_password } });
}

export function getProfile() {
  const token = localStorage.getItem('token');
  return authRequest('GET', '/user/profile', { token });
}

/** 同步一句话画像到云端（贡献者主页展示）；空串清除 */
export function updateProfilePersona(persona) {
  const token = localStorage.getItem('token');
  if (!token) return Promise.resolve(null);
  return authRequest('PATCH', '/user/profile', {
    token,
    body: { persona: String(persona || '').trim().slice(0, 300) },
  });
}

export function getStats() {
  return http.get('/user/stats');
}

export function getTransactions() {
  return http.get('/user/transactions');
}

export function getSettlements() {
  // 与 profile 一致走 authRequest，Electron 下绕过代理/CORS，避免列表加载失败
  const token = localStorage.getItem('token');
  return authRequest('GET', '/user/settlements', { token });
}

/** 交易页汇总：累计 token、积分、P2P 节省金额 */
export function getContributeSummary() {
  return http.get('/user/contribute-summary');
}

/** 公开：社区推荐目录（仅上架；含 resources 扁平列表） */
export function getCommunityCatalog() {
  return http.get('/api/community-catalog');
}

/** 社区 skill 纳管/推荐积分额度 */
export function getCommunityCatalogPricing() {
  const token = localStorage.getItem('token');
  return authRequest('GET', '/user/community-catalog/pricing', { token });
}

/** 推荐本机 skill / prompt / assistant 到社区目录 */
export function recommendCommunitySkill(body) {
  const token = localStorage.getItem('token');
  return authRequest('POST', '/user/community-catalog/recommend', { body, token });
}

/** 社区 skill 纳管结算（用户推荐项扣积分） */
export function settleCommunityCatalogInstall(catalogId) {
  const token = localStorage.getItem('token');
  return authRequest('POST', '/user/community-catalog/install', {
    body: { catalog_id: catalogId },
    token,
  });
}

export function getNetwork() {
  return http.get('/public/network');
}

/** 公开武将名片列表（社区贡献） */
export function listPublicCommunityAgents() {
  return http.get('/public/agents');
}

/** 全球公开智能体单条名片（匿名） */
export function getPublicCommunityAgent(assistantId) {
  return http.get(`/public/agents/${encodeURIComponent(assistantId)}`);
}

/** 登录用户可见武将：公开 + 圈子 */
export function listCommunityAgents() {
  return http.get('/api/agents');
}

/** 当前用户可见的单条智能体名片 */
export function getCommunityAgent(assistantId) {
  return http.get(`/api/agents/${encodeURIComponent(assistantId)}`);
}

/** 雇佣上报（真实被雇次数 +1） */
export function reportCommunityAgentHire({ assistantId, workerId } = {}) {
  return http.post('/api/agents/hire', {
    assistant_id: assistantId,
    worker_id: workerId || undefined,
  });
}

/** 发起远程武将任务（对方本机执行，调用方只拿结果） */
export function createCommunityAgentTask({ assistantId, prompt, workerId, timeoutMs }) {
  // 武将任务可能长达数分钟，单独放宽超时
  return http.post('/api/agent-tasks', {
    assistant_id: assistantId,
    prompt,
    worker_id: workerId || undefined,
    timeout_ms: timeoutMs || undefined,
  }, { timeout: 620_000 });
}

export function listKeys() {
  return http.get('/user/keys');
}

export function createKey(note = '') {
  return http.post('/user/keys', { note });
}

export function toggleKey(keyId, isActive) {
  return http.patch(`/user/keys/${keyId}`, { is_active: isActive });
}

export function deleteKey(keyId) {
  return http.delete(`/user/keys/${keyId}`);
}

export function checkin() {
  return http.post('/user/checkin');
}

export function getCheckinStatus() {
  return http.get('/user/checkin/status');
}

/** 购买记录 + contact_info（管理员配置的付款方式） */
export function getPurchaseOrders() {
  return http.get('/user/purchase-orders');
}

export function createPurchaseOrder(amount_credits, note = '') {
  return http.post('/user/purchase-order', { amount_credits, note });
}

export function spin() {
  return http.post('/user/spin');
}

export function getSpinStatus() {
  return http.get('/user/spin/status');
}

export function getRates() {
  return http.get('/api/rates');
}

// 当前在线 worker 模型（OpenAI /v1/models；需用户 API Key，非登录 JWT）
export async function getOnlineModels() {
  const { getLocalConfig } = await import('./adapter');
  const cfg = await getLocalConfig().get().catch(() => null);
  const apiKey = cfg?.cloud_config?.token;
  if (!apiKey) return { data: { object: 'list', data: [] } };

  const base = normalizeServerBase(cfg?.cloud_config?.url || getServerUrl());
  if (window.electronAPI?.auth?.request) {
    const r = await window.electronAPI.auth.request({
      base, method: 'GET', path: '/v1/models', token: apiKey,
    });
    let data = { object: 'list', data: [] };
    if (r.body) {
      try { data = JSON.parse(r.body); } catch { /* keep empty */ }
    }
    if (r.status >= 400) return { data: { object: 'list', data: [] } };
    return { data };
  }

  const res = await fetch(`${base}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return { data: { object: 'list', data: [] } };
  return { data: await res.json() };
}

export function getProviderCatalog() {
  return http.get('/api/catalog');
}

export function getUserAccountsSettings() {
  return http.get('/user/accounts');
}

export function saveUserAccountsSettings(body) {
  return http.put('/user/accounts', body);
}

// ── Scene Routes ──────────────────────────────────────────────────────────────

export function getSceneRoutes() {
  return http.get('/user/scene-routes');
}

export function createSceneRoute(body) {
  return http.post('/user/scene-routes', body);
}

export function updateSceneRoute(id, body) {
  return http.put(`/user/scene-routes/${id}`, body);
}

export function deleteSceneRoute(id) {
  return http.delete(`/user/scene-routes/${id}`);
}

export function getKeysWithScene() {
  return http.get('/user/keys-with-scene');
}

export function bindKeyToScene(keyId, body) {
  return http.put(`/user/keys/${keyId}/bind-scene`, body);
}

// ── Dashboard Stats ───────────────────────────────────────────────────────────

export function getDashboardStats(days = 30) {
  return http.get(`/user/dashboard-stats?days=${days}`);
}

export function getModelStats(days = 30) {
  return http.get(`/user/model-stats?days=${days}`);
}

/** 个人页看板：各端上报盘点数据按设备维度聚合（云端）。
 *  走主进程，与 profile 一样绕过系统代理 / CORS，否则桌面端已登录也会同步失败。 */
export function getInventoryStats(days = 1) {
  const token = localStorage.getItem('token');
  return authRequest('GET', `/user/inventory-stats?days=${days}`, { token });
}


// ── Device management ─────────────────────────────────────────────────────────

export function getUserDevices() {
  return http.get('/user/devices');
}

export function deleteDevice(deviceId) {
  return http.delete(`/device/${deviceId}`);
}

export function registerDevice(info) {
  const token = localStorage.getItem('token');
  return authRequest('POST', '/device/register', { body: info, token });
}

export function heartbeatDevice(deviceId, payload = {}) {
  const { version, name, platform, type, ...stats } = payload;
  const token = localStorage.getItem('token');
  return authRequest('POST', '/device/heartbeat', {
    token,
    body: {
      device_id: deviceId,
      online: true,
      version: version || '',
      name: name || '',
      platform: platform || '',
      type: type || '',
      stats,
    },
  });
}

// ── Circles ───────────────────────────────────────────────────────────────────

export function createCircle(name, description = '') {
  return http.post('/user/circles', { name, description });
}

export function listMyCircles() {
  return http.get('/user/circles');
}

export function listJoinedCircles() {
  return http.get('/user/circles/joined');
}

export function dissolveCircle(circleId) {
  return http.delete(`/user/circles/${circleId}`);
}

export function leaveCircle(circleId) {
  return http.post(`/user/circles/${circleId}/leave`);
}

export function kickCircleMember(circleId, memberUid) {
  return http.delete(`/user/circles/${circleId}/members/${memberUid}`);
}

export function previewCircle(code) {
  return http.get(`/user/circles/join/${code}`);
}

export function joinCircle(code) {
  return http.post(`/user/circles/join/${code}`);
}

export function getModelsForCurrentUser() {
  return http.get('/v1/models');
}

export function listCircleMembers(circleId) {
  return http.get(`/user/circles/${circleId}/members`);
}

export function getCircleDetail(circleId) {
  return http.get(`/user/circles/${circleId}`);
}

export function createCirclePost(circleId, content) {
  return http.post(`/user/circles/${circleId}/posts`, { content });
}

export function updateCirclePost(circleId, postId, content) {
  return http.put(`/user/circles/${circleId}/posts/${postId}`, { content });
}

export function deleteCirclePost(circleId, postId) {
  return http.delete(`/user/circles/${circleId}/posts/${postId}`);
}

export function createCirclePostReply(circleId, postId, content) {
  return http.post(`/user/circles/${circleId}/posts/${postId}/replies`, { content });
}

export function updateCirclePostReply(circleId, postId, replyId, content) {
  return http.put(`/user/circles/${circleId}/posts/${postId}/replies/${replyId}`, { content });
}

export function deleteCirclePostReply(circleId, postId, replyId) {
  return http.delete(`/user/circles/${circleId}/posts/${postId}/replies/${replyId}`);
}

export function browseCircles(q = '') {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return http.get(`/user/circles/browse${qs}`);
}

export function applyJoinCircle(circleId, message = '') {
  return http.post(`/user/circles/${circleId}/apply`, { message });
}

export function listCircleJoinRequests(circleId) {
  return http.get(`/user/circles/${circleId}/join-requests`);
}

export function approveCircleJoinRequest(circleId, requestId) {
  return http.post(`/user/circles/${circleId}/join-requests/${requestId}/approve`);
}

export function rejectCircleJoinRequest(circleId, requestId) {
  return http.post(`/user/circles/${circleId}/join-requests/${requestId}/reject`);
}

/** 上传圈子图片（multipart） */
export function uploadCircleMedia(circleId, file) {
  const fd = new FormData();
  fd.append('file', file);
  return http.post(`/user/circles/${circleId}/media`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
}
