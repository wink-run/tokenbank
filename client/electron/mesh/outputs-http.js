// client/electron/mesh/outputs-http.js
// 产出相关的接口（设计 §8.4），本机网关和隧道里都是这一套：
//   GET  /v1/agent/responses/{id}/bundle                    代码改动的 git bundle（执行端）
//   GET  /v1/agent/responses/{id}/artifacts/file?path=&sha256=   单个产出文件（执行端，sha256 对不上回 409 changed）
//   POST /v1/agent/responses/{id}/collect  { dirs? }         取回：bundle 进本机仓库的 tb/mesh/<任务号> 分支（发起端）
//   GET  /v1/workspaces[?device=]                            命名工作区
//   GET  /v1/workspaces/{名字}/fs|file|diff|log[?device=]     远程只读查看（只本人）
// mesh:<设备>:<任务号>、?device= 不是本机时转给那台设备。
'use strict';

const fs = require('fs');
const outputs = require('./outputs');

function sendJson(res, status, obj) {
  if (res.headersSent) { try { res.end(); } catch { /* 已断 */ } return; }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const err = (res, e) => sendJson(res, e.status || 500, { error: { message: e.message, type: e.code || 'invalid_request_error' } });

function keyOf(req) {
  const raw = String(req.headers.authorization || req.headers['x-api-key'] || '');
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim();
}

async function readJson(req) {
  const parts = [];
  for await (const c of req) parts.push(c);
  try { return JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { return {}; }
}

/** 转给另一台设备，原样把响应（可能是二进制流）接回来 */
async function proxyRaw(deviceId, req, res, path, body) {
  const glue = require('./glue');
  const node = glue.getNode();
  if (!node) return sendJson(res, 503, { error: { message: '设备网络没有启动', type: 'mesh_disabled' } });
  const tunnel = require('./tunnel');
  try {
    const resp = await node.proxy(deviceId, {
      method: req.method, path, headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? Buffer.from(JSON.stringify(body)) : undefined,
    });
    await tunnel.pipeTo(resp, res);
  } catch (e) {
    sendJson(res, e.status || 502, { error: { message: e.message, type: 'mesh_error' } });
  }
}

function taskRow(executor, id) {
  return executor.getTaskStatus(id).catch(() => null);
}

/** 这个任务在本机的工作区根目录（工作树或原仓库） */
function taskRoot(task) {
  const o = task?.context?.outputs;
  return o?.root || task?.context?.workingDir || null;
}

async function handleTask(req, res, id, op, url) {
  const glue = require('./glue');
  const executor = require('../agent-executor');
  const mesh = glue.parseMeshTaskId(id);
  if (op === 'collect') return collect(req, res, id);
  if (mesh) {
    const q = url.search || '';
    return proxyRaw(mesh.deviceId, req, res, `/v1/agent/responses/${encodeURIComponent(mesh.id)}/${op === 'bundle' ? 'bundle' : 'artifacts/file'}${q}`);
  }
  const task = await taskRow(executor, id);
  if (!task) return sendJson(res, 404, { error: { message: 'Task not found' } });
  if (op === 'bundle') {
    const g = task.result?.git;
    if (!g?.ref) return sendJson(res, 404, { error: { message: '这个任务没有代码改动' } });
    let p;
    try { p = outputs.bundleStream(g, taskRoot(task)); } catch (e) { return err(res, e); }
    let started = false;
    let stderr = '';
    p.stderr.on('data', (c) => { stderr += c; });
    p.stdout.once('data', () => { started = true; });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Tb-Git-Ref': g.ref, 'X-Tb-Git-Base': g.base });
    p.stdout.pipe(res);
    p.on('exit', (code) => { if (code !== 0 && !started) { try { res.end(); } catch { /* 已断 */ } console.warn('[mesh] bundle:', stderr.trim()); } });
    return true;
  }
  // 单个产出文件
  const rel = url.searchParams.get('path') || '';
  const sha = url.searchParams.get('sha256') || '';
  try {
    const file = await outputs.locateArtifact(id, taskRoot(task), rel, sha);
    const st = fs.statSync(file);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  } catch (e) { err(res, e); }
  return true;
}

/**
 * 发起端：把子任务的改动取回本机分支（只建分支，不合并、不切换）。
 * @param {string} id 任务号（本机或 mesh:）
 * @param {{ dirs?: string[] }} opts 优先在这些目录里找仓库（比如主智能体的工作目录）
 */
async function collectTask(id, { dirs: extraDirs = [] } = {}) {
  const glue = require('./glue');
  const executor = require('../agent-executor');
  const task = await taskRow(executor, id);
  let gitInfo = task?.result?.git;
  if (!gitInfo && glue.parseMeshTaskId(id)) gitInfo = (await glue.fetchAgentTask(id, 'get'))?.git;
  if (!gitInfo) throw Object.assign(new Error('这个任务没有代码改动（或还没做完）'), { status: 404 });
  if (!gitInfo.changed) return { imported: false, reason: '这个任务没有改代码' };
  // 拉 bundle：本机任务直接生成，别的设备上的经隧道
  const file = outputs.inboxPath(id, 'changes.bundle');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file, { mode: 0o600 });
    out.on('error', reject);
    const mesh = glue.parseMeshTaskId(id);
    if (!mesh) {
      const p = outputs.bundleStream(gitInfo, taskRoot(task));
      p.stdout.pipe(out);
      p.on('exit', (code) => (code === 0 ? out.on('finish', resolve) : reject(new Error('git bundle 失败'))));
      return;
    }
    const node = glue.getNode();
    if (!node) return reject(Object.assign(new Error('设备网络没有启动'), { status: 503 }));
    node.proxy(mesh.deviceId, { method: 'GET', path: `/v1/agent/responses/${encodeURIComponent(mesh.id)}/bundle`, headers: {} })
      .then(async (resp) => {
        if (resp.status !== 200) {
          const t = (await require('./tunnel').readAll(resp)).toString('utf8');
          return reject(Object.assign(new Error(`那台设备没给出改动：${t.slice(0, 200)}`), { status: resp.status }));
        }
        for await (const c of resp.chunks) {
          if (!out.write(c)) await new Promise((r) => out.once('drain', r));
        }
        out.end();
        out.on('finish', resolve);
      })
      .catch(reject);
  });
  const dirs = [...extraDirs];
  const parent = task?.context?.parentTaskId ? await taskRow(executor, task.context.parentTaskId) : null;
  if (parent?.context?.workingDir) dirs.push(parent.context.workingDir);
  try {
    const ws = require('./workspaces').read(glue.meshDirPath());
    for (const w of Object.values(ws.workspaces || {})) dirs.push(require('./workspaces').expandHome(w.path));
  } catch { /* 没配工作区 */ }
  return outputs.importBundle({ taskId: id, bundlePath: file, gitInfo, repoDirs: dirs });
}

async function collect(req, res, id) {
  const body = await readJson(req);
  try {
    sendJson(res, 200, await collectTask(id, { dirs: Array.isArray(body.dirs) ? body.dirs : [] }));
  } catch (e) { err(res, e); }
  return true;
}

async function handleWorkspace(req, res, name, op, url) {
  const glue = require('./glue');
  const device = url.searchParams.get('device');
  if (device && !glue.isSelfDevice(device)) {
    const target = glue.findDevice(device);
    if (!target) return sendJson(res, 404, { error: { message: `没有叫 ${device} 的设备` } });
    const q = new URLSearchParams(url.searchParams);
    q.delete('device');
    // 看某个任务的 diff：那台设备只认它自己的任务号
    const mt = glue.parseMeshTaskId(q.get('task_id'));
    if (mt) q.set('task_id', mt.id);
    const tail = name ? `/${encodeURIComponent(name)}/${op}` : '';
    return proxyRaw(target.device_id, req, res, `/v1/workspaces${tail}${q.toString() ? `?${q}` : ''}`);
  }
  if (!name) {
    const ws = require('./workspaces').listPublic(glue.meshDirPath());
    return sendJson(res, 200, { object: 'list', data: ws });
  }
  let root;
  try { root = glue.resolveWorkspace(name); } catch (e) { return err(res, e); }
  if (!root) return sendJson(res, 404, { error: { message: `没有工作区 ${name}` } });
  const p = url.searchParams;
  try {
    if (op === 'fs') return sendJson(res, 200, outputs.listDir(root, p.get('path') || ''));
    if (op === 'file') return sendJson(res, 200, outputs.readFile(root, p.get('path') || '', p.get('offset'), p.get('limit')));
    if (op === 'log') return sendJson(res, 200, await outputs.log(root, p.get('limit')));
    if (op === 'diff') {
      const taskId = p.get('task_id');
      if (taskId) {
        const task = await taskRow(require('../agent-executor'), taskId);
        const g = task?.result?.git;
        if (!g?.changed) return sendJson(res, 404, { error: { message: '这个任务没有代码改动' } });
        return sendJson(res, 200, { task_id: taskId, ...(await outputs.diff(taskRoot(task), { base: g.base, head: g.head, rel: p.get('path') })) });
      }
      return sendJson(res, 200, await outputs.diff(root, { rel: p.get('path') }));
    }
  } catch (e) { return err(res, e); }
  return sendJson(res, 404, { error: { message: 'not_found' } });
}

/**
 * @returns {Promise<boolean>} 是不是这里处理的
 */
async function handle(req, res, { method, cleanPath, knownKey }) {
  const t = String(cleanPath || '').match(/^\/v1\/agent\/responses\/([^/]+)\/(bundle|artifacts\/file|collect)$/);
  const w = String(cleanPath || '').match(/^\/v1\/workspaces(?:\/([^/]+)\/(fs|file|diff|log))?$/);
  if (!t && !w) return false;
  const okMethod = t ? (t[2] === 'collect' ? method === 'POST' : method === 'GET') : method === 'GET';
  if (!okMethod) { sendJson(res, 405, { error: { message: 'method not allowed' } }); return true; }
  // 只本人：网关 Key、智能体 Key、设备网络 Key。只绑一个智能体的 Key 不能看工作区
  const key = keyOf(req);
  if (!key || typeof knownKey !== 'function' || !knownKey(key)) {
    req.resume();
    sendJson(res, 401, { error: { message: 'invalid api key', type: 'auth_error' } });
    return true;
  }
  const url = new URL(req.url || '/', 'http://x');
  try {
    if (t) {
      let id = t[1];
      try { id = decodeURIComponent(id); } catch { /* 原样 */ }
      await handleTask(req, res, id, t[2] === 'artifacts/file' ? 'file' : t[2], url);
    } else {
      await handleWorkspace(req, res, w[1] ? decodeURIComponent(w[1]) : '', w[2] || '', url);
    }
  } catch (e) { err(res, e); }
  return true;
}

module.exports = { handle, collectTask };
