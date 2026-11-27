// 派活到我的其他设备、任务树、后台派发（E2-1 / E4-1 / E4-3）
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const http = require('../agent-http');
const routes = require('../agent-routes');
const executor = require('../agent-executor');

function memoryDb() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL, context TEXT,
      status TEXT NOT NULL, result TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE agent_task_steps (id TEXT PRIMARY KEY, task_id TEXT, step_number INTEGER, step_type TEXT, content TEXT, created_at INTEGER);
    CREATE TABLE agent_modified_files (task_id TEXT, path TEXT);
  `);
  return db;
}

/** 临时把执行器换到内存库上，测完换回去 */
function withDb(fn) {
  const db = memoryDb();
  const orig = executor._getDb;
  executor._getDb = () => db;
  return Promise.resolve(fn(db)).finally(() => { executor._getDb = orig; db.close(); });
}

test('GET /v1/agent/responses 是列任务（按 parent_id）', () => {
  assert.deepStrictEqual(http.parseAgentRoute('GET', '/v1/agent/responses'), { op: 'list_responses' });
  assert.deepStrictEqual(http.parseAgentRoute('POST', '/v1/agent/responses'), { op: 'create' });
  assert.deepStrictEqual(http.parseAgentRoute('GET', '/v1/agent/responses/mesh%3Adev-b%3At1'), { op: 'get', id: 'mesh:dev-b:t1' });
});

test('任务响应带 parent_id、执行设备和进展', () => {
  const r = http.taskToResponse({
    id: 'mesh:dev-b:t1', agent_id: 'mine:codex@mini', status: 'running',
    context: { parentTaskId: 'task_p', meshDevice: 'mini' },
    result: { output: '做到一半', remoteSteps: 4 },
    steps: [],
  });
  assert.strictEqual(r.status, 'in_progress');
  assert.strictEqual(r.metadata.parent_id, 'task_p');
  assert.strictEqual(r.metadata.mesh_device, 'mini');
  assert.strictEqual(r.step_count, 4);
  const local = http.taskToResponse({ id: 't2', agent_id: 'codex', status: 'completed', context: {}, steps: [{}, {}] });
  assert.strictEqual(local.metadata.parent_id, undefined);
  assert.strictEqual(local.step_count, 2);
});

test('路由名单里勾了 codex，其他设备上的 codex 也算', () => {
  const agents = [
    { id: 'codex', type: 'cli' },
    { id: 'mine:codex@mini', type: 'mine', base: 'codex' },
    { id: 'mine:cursor@mini', type: 'mine', base: 'cursor' },
  ];
  const route = { candidates: ['codex'] };
  assert.deepStrictEqual(routes.filterAgents(route, agents).map((a) => a.id), ['codex', 'mine:codex@mini']);
  assert.ok(routes.canDispatchTo(route, 'mine:codex@mini', agents));
  assert.ok(!routes.canDispatchTo(route, 'mine:cursor@mini', agents));
  assert.strictEqual(routes.filterAgents({}, agents).length, 3);
});

test('执行器认得 mine: 目标和 mesh: 任务号', () => {
  assert.ok(executor.isMeshTarget('mine:codex@mini'));
  assert.ok(!executor.isMeshTarget('codex'));
  assert.ok(executor.isMeshTaskId('mesh:dev-b:t1'));
  assert.ok(!executor.isMeshTaskId('task_1'));
});

test('waitTasks：any 有一个做完就返回，all 等全部，none 立刻返回', async () => {
  const orig = executor.getTaskStatus;
  const t0 = Date.now();
  executor.getTaskStatus = async (id) => {
    if (id === 'fast') return { id, status: Date.now() - t0 > 300 ? 'completed' : 'running' };
    if (id === 'slow') return { id, status: Date.now() - t0 > 1200 ? 'completed' : 'running' };
    throw new Error('Task not found');
  };
  try {
    const none = await executor.waitTasks(['fast', 'slow'], { wait: 'none' });
    assert.deepStrictEqual(none.map((t) => t.status), ['running', 'running']);
    const any = await executor.waitTasks(['fast', 'slow', 'fast'], { wait: 'any', timeoutMs: 5000 });
    assert.deepStrictEqual(any.map((t) => t.status), ['completed', 'running'], '去重并保持顺序');
    const all = await executor.waitTasks(['fast', 'slow', 'nope'], { wait: 'all', timeoutMs: 5000 });
    assert.deepStrictEqual(all.map((t) => t.status), ['completed', 'completed', 'not_found']);
    const t1 = Date.now();
    const timeout = await executor.waitTasks(['slow2'], { wait: 'all', timeoutMs: 300 });
    assert.strictEqual(timeout[0].status, 'not_found');
    assert.ok(Date.now() - t1 < 1000);
  } finally {
    executor.getTaskStatus = orig;
  }
});

test('远端任务的本机镜像：跟着远端更新，到终态后不再变；子任务按父任务查得到', () => withDb(async (db) => {
  const pollerOrig = executor._pollMeshTask;
  executor._pollMeshTask = () => {};   // 不真的去连设备
  try {
    executor.trackMeshTask('mesh:dev-b:t1', {
      agentId: 'mine:codex@mini', device: 'mini', prompt: '修登录页', parentTaskId: 'task_parent',
      response: { id: 'mesh:dev-b:t1', status: 'in_progress', metadata: { mesh_device: 'mini' }, output: [], step_count: 2 },
    });
    let row = await executor.getTaskStatus('mesh:dev-b:t1');
    assert.strictEqual(row.status, 'running');
    assert.strictEqual(row.context.parentTaskId, 'task_parent');
    assert.strictEqual(row.result.remoteSteps, 2);

    // 连不上：不动
    assert.strictEqual(executor._applyMeshResponse('mesh:dev-b:t1', { status: 'unreachable' }), false);
    const done = executor._applyMeshResponse('mesh:dev-b:t1', {
      status: 'completed', metadata: { mesh_device: 'mini' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '改好了' }] }],
    });
    assert.strictEqual(done, true);
    row = await executor.getTaskStatus('mesh:dev-b:t1');
    assert.strictEqual(row.status, 'completed');
    assert.strictEqual(row.result.output, '改好了');
    assert.strictEqual(row.result.device, 'mini');
    // 终态之后远端再报什么也不覆盖
    executor._applyMeshResponse('mesh:dev-b:t1', { status: 'failed', output: [] });
    assert.strictEqual((await executor.getTaskStatus('mesh:dev-b:t1')).status, 'completed');

    executor.trackMeshTask('mesh:dev-b:t2', { agentId: 'mine:codex@mini', prompt: '写测试', parentTaskId: 'task_parent' });
    executor.trackMeshTask('mesh:dev-b:t3', { agentId: 'mine:codex@mini', prompt: '别的', parentTaskId: 'task_other' });
    const kids = executor.listChildTasks('task_parent');
    assert.deepStrictEqual(kids.map((k) => k.id), ['mesh:dev-b:t1', 'mesh:dev-b:t2']);
    assert.strictEqual(kids[0].result.output, '改好了');

    const resumed = [];
    executor._pollMeshTask = (id) => resumed.push(id);
    assert.strictEqual(executor.resumeMeshTasks(), 2);
    assert.deepStrictEqual(resumed.sort(), ['mesh:dev-b:t2', 'mesh:dev-b:t3']);
    assert.ok(db.prepare('SELECT COUNT(*) c FROM agent_tasks').get().c === 3);
  } finally {
    executor._pollMeshTask = pollerOrig;
  }
}));

test('设备网络没启动时派 mine: 目标给出明确原因', async () => {
  await assert.rejects(() => executor.execute('mine:codex@mini', 'x'), /设备网络没有启动/);
});

// ── 云端：领证书、吊销（E1-1 / E1-2） ───────────────────────────────────────
const { MeshCloud, needsCert } = require('../mesh/cloud');

test('要不要重新领证书：没有、快到期、换账号 / 设备 / 密钥', () => {
  const now = 1_000_000;
  const ok = { sub: '1', device_id: 'dev-a', endpoint_id: 'e1', exp: now + 30 * 86400 };
  assert.strictEqual(needsCert(null, { now }), true);
  assert.strictEqual(needsCert(ok, { userId: '1', deviceId: 'dev-a', endpointId: 'e1', now }), false);
  assert.strictEqual(needsCert({ ...ok, exp: now + 3 * 86400 }, { now }), true);
  assert.strictEqual(needsCert(ok, { userId: '2', now }), true);
  assert.strictEqual(needsCert(ok, { deviceId: 'dev-b', now }), true);
  assert.strictEqual(needsCert(ok, { endpointId: 'e2', now }), true);
});

test('云端客户端：带登录令牌，错误里给出服务端的原因', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/mesh/cert')) return { ok: false, status: 404, json: async () => ({ detail: '设备没有注册' }) };
    return { ok: true, status: 200, json: async () => ({ peers: [{ endpoint_id: 'x' }] }) };
  };
  const c = new MeshCloud({ serverUrl: 'http://s/', token: 'jwt', deviceId: 'dev-a', fetchImpl });
  assert.ok(c.ready);
  assert.deepStrictEqual(await c.peers(), [{ endpoint_id: 'x' }]);
  assert.strictEqual(calls[0].url, 'http://s/mesh/peers');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer jwt');
  await assert.rejects(() => c.requestCert({ endpointId: 'e' }), (e) => e.status === 404 && /没有注册/.test(e.message));
  assert.strictEqual(JSON.parse(calls[1].init.body).device_id, 'dev-a');
});

test('换上吊销列表：已连着的被吊销设备马上断开', () => {
  const { MeshNode } = require('../mesh/node');
  const n = new MeshNode({ log: () => {} });
  const closed = [];
  n.sessions.set('dev-b', { endpointId: 'eb' });
  n.sessions.set('dev-c', { endpointId: 'ec' });
  n.inbound.set('dev-b', { ws: { close: (c, r) => closed.push(['dev-b', r]) } });
  n.inbound.set('dev-c', { ws: { close: (c, r) => closed.push(['dev-c', r]) } });
  n.setRevoked(['eb']);
  assert.deepStrictEqual(closed, [['dev-b', 'revoked']]);
  assert.ok(!n.sessions.has('dev-b') && n.sessions.has('dev-c'));
  assert.ok(n.revoked.has('eb'));
});

// ── 模型降级链（E2-2）：本机 → 我的设备 → 免费 → 社区 → 付费 ──────────────────
test('同一个模型：本机的源 → 我的设备 → 免费 → 社区 → 付费', () => {
  const { orderBillingThenSpeed } = require('../routing-strategies');
  const order = orderBillingThenSpeed([
    { id: 'paid', type: 'paid' },
    { id: 'p2p', type: 'p2p', source: 'p2p' },
    { id: 'free-cloud', type: 'free' },
    { id: 'mesh:dev-b', type: 'mesh' },
    { id: 'ollama', type: 'free', is_local: true },
    { id: 'sub', type: 'paid', source: 'subscription' },
  ]).map((p) => p.id);
  assert.deepStrictEqual(order, ['sub', 'ollama', 'mesh:dev-b', 'free-cloud', 'paid', 'p2p']);
});

test('远端任务失联：标失联并写原因；那台设备回来后用真实结果补上；重新跟踪能查回失联的', () => withDb(async () => {
  const pollerOrig = executor._pollMeshTask;
  const polled = [];
  executor._pollMeshTask = (id) => { polled.push(id); };
  try {
    executor.trackMeshTask('mesh:dev-c:t1', { agentId: 'mine:codex@pc', device: 'pc', prompt: '跑测试' });
    executor.trackMeshTask('mesh:dev-d:t2', { agentId: 'mine:codex@nas', device: 'nas', prompt: '备份' });
    assert.strictEqual(executor._markMeshLost('mesh:dev-c:t1', '失联：31 分钟连不上执行它的设备'), true, '第一次标记要通知');
    assert.strictEqual(executor._markMeshLost('mesh:dev-c:t1', '失联：又一次'), false, '重复标记不再通知');
    let row = await executor.getTaskStatus('mesh:dev-c:t1');
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.result.lost, true);
    assert.match(row.error, /失联/);

    // 只重新跟这台设备的：失联的也算
    polled.length = 0;
    executor.resumeMeshTasks('dev-c');
    assert.deepStrictEqual(polled, ['mesh:dev-c:t1']);

    // 设备回来，真实结果补上
    const done = executor._applyMeshResponse('mesh:dev-c:t1', {
      status: 'completed', metadata: { mesh_device: 'pc' },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '全部通过' }] }],
    });
    assert.strictEqual(done, true);
    row = await executor.getTaskStatus('mesh:dev-c:t1');
    assert.strictEqual(row.status, 'completed');
    assert.strictEqual(row.result.output, '全部通过');
    assert.strictEqual(row.result.lost, undefined);
    // 真实终态之后不再标失联
    assert.strictEqual(executor._markMeshLost('mesh:dev-c:t1', 'x'), false);
  } finally {
    executor._pollMeshTask = pollerOrig;
  }
}));

test('跑在其他设备上的任务做完：小文件自动拉回、大文件等点了再拉，输出里写清文件在哪', () => withDb(async () => {
  const glue = require('../mesh/glue');
  const pollerOrig = executor._pollMeshTask;
  const pullOrig = glue.pullFile;
  executor._pollMeshTask = () => {};
  const pulled = [];
  glue.pullFile = async ({ entry, destDir }) => { pulled.push(entry.name); return { path: `${destDir}/${entry.name}`, size: entry.size }; };
  try {
    executor.trackMeshTask('mesh:dev-e:t1', { agentId: 'mine:claude-code@mini', device: 'mini', prompt: '出图' });
    executor._applyMeshResponse('mesh:dev-e:t1', {
      status: 'completed', metadata: { mesh_device: 'mini', mesh_files: [
        { token: 'aaaaaaaaaa', name: 'cover.png', size: 1024, sha256: 'x' },
        { token: 'bbbbbbbbbb', name: 'film.mp4', size: 80 * 1048576, sha256: 'y' },
      ] },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '做好了' }] }],
    });
    await executor._pullMeshOutputs('mesh:dev-e:t1');
    assert.deepEqual(pulled, ['cover.png'], '只自动拉小的');
    let row = await executor.getTaskStatus('mesh:dev-e:t1');
    assert.match(row.result.output, /cover\.png → .*cover\.png/);
    assert.match(row.result.output, /film\.mp4（80\.0MB，还在那台设备上/);
    const listed = executor.listTodayTasks('claude-code');
    assert.equal(listed[0].device, 'mini');
    assert.equal(listed[0].files.find((f) => f.name === 'film.mp4').pending, true);
    await executor.pullMeshTaskFile('mesh:dev-e:t1', 'bbbbbbbbbb');
    row = await executor.getTaskStatus('mesh:dev-e:t1');
    assert.ok(row.result.files.find((f) => f.name === 'film.mp4').path, '点了再拉之后有本机路径');
  } finally {
    executor._pollMeshTask = pollerOrig;
    glue.pullFile = pullOrig;
  }
}));

test('今天的任务数：派到其他设备上跑的算回它自己，另记几个在其他设备', () => withDb(async () => {
  const pollerOrig = executor._pollMeshTask;
  executor._pollMeshTask = () => {};
  try {
    executor.trackMeshTask('mesh:dev-f:t1', { agentId: 'mine:assistant:r1@mini', device: 'mini', prompt: 'a' });
    executor.trackMeshTask('mesh:dev-f:t2', { agentId: 'mine:assistant:r1@nas', device: 'nas', prompt: 'b' });
    const st = executor.todayTaskStats().by_agent['assistant:r1'];
    assert.strictEqual(st.tasks, 2);
    assert.strictEqual(st.remote, 2);
    assert.strictEqual(executor.listTodayTasks('assistant:r1').length, 2, '任务列表里也有');
  } finally {
    executor._pollMeshTask = pollerOrig;
  }
}));
