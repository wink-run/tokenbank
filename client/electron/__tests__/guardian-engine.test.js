'use strict';
// 看护执行引擎：画像 / 发现 / 安装不再是三个系统智能体，由看护交给一个已纳管的应用在后台跑
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-guardian-engine-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.LLM_AGENT_CONFIG_DIR = path.join(HOME, '.llm-agent');
fs.mkdirSync(process.env.LLM_AGENT_CONFIG_DIR, { recursive: true });

const localStats = require('../local-stats');
assert.ok(localStats.init(path.join(HOME, '.tokenbank'), { force: true }));
require('../../cli/ipc-bridge').installElectronStub();
const engine = require('../guardian/engine');
const targets = require('../resource-agent-targets');
const executor = require('../agent-executor');

test('catalog no longer ships the three system agents', () => {
  const cat = require('../resource-catalog');
  for (const id of ['resource-portrait-assistant', 'resource-finder-assistant', 'resource-installer-assistant']) {
    assert.equal(cat.getCatalogItem(id), null, id);
  }
});

test('legacy system agents from older versions are cleaned up', () => {
  const rm = require('../resource-manager');
  rm.init();
  // 模拟旧版本留下的：source=builtin、metadata.builtin
  for (const n of engine.LEGACY_ASSISTANTS) {
    rm.saveResource({ type: 'assistant', name: n, display_name: n, content: '{"soul":"x"}', metadata: { builtin: true } });
  }
  rm.saveResource({ type: 'assistant', name: 'my-helper', display_name: 'my-helper', content: '{"soul":"mine"}' });
  const r = rm.ensureBuiltinAssistants();
  assert.deepEqual(r.removed.sort(), [...engine.LEGACY_ASSISTANTS].sort());
  const names = rm.listResources({ type: 'assistant' }).map(x => x.name);
  assert.deepEqual(names, ['my-helper'], 'user assistants are untouched');
  assert.deepEqual(rm.ensureBuiltinAssistants().removed, [], 'idempotent');
});

test('status and runtime choice follow managed apps', () => {
  const orig = targets.listManagedResourceAgentIds;
  try {
    targets.listManagedResourceAgentIds = () => [];
    assert.deepEqual(engine.status(), { ready: false, runtime: null, runtimes: [] });
    targets.listManagedResourceAgentIds = () => ['pi', 'claude-code', 'codex'];
    const st = engine.status();
    assert.equal(st.ready, true);
    assert.deepEqual(st.runtimes.map(r => r.id), ['codex', 'claude-code'], 'only apps that can run tools, in preferred order');
    assert.equal(st.runtime, 'codex');
    assert.equal(engine.setRuntime('pi').ok, false);
    assert.equal(engine.setRuntime('claude-code').ok, true);
    assert.equal(engine.status().runtime, 'claude-code');
  } finally {
    targets.listManagedResourceAgentIds = orig;
  }
});

test('run hands the role + prompt to the chosen app', async () => {
  const origT = targets.listManagedResourceAgentIds;
  const origE = executor.execute;
  const calls = [];
  try {
    targets.listManagedResourceAgentIds = () => ['codex'];
    executor.execute = async (agentId, prompt, options) => { calls.push({ agentId, prompt, options }); return { taskId: 't-1' }; };
    const r = await engine.run({ kind: 'install', prompt: '装一下 owner/repo', sessionKey: 'resource-install' });
    assert.deepEqual(r, { ok: true, taskId: 't-1', runtime: 'codex' });
    assert.equal(calls[0].agentId, 'codex');
    assert.match(calls[0].prompt, /看护任务：资产安装[\s\S]*装一下 owner\/repo/);
    assert.equal(calls[0].options.sessionKey, 'resource-install');
    assert.equal((await engine.run({ kind: 'bogus', prompt: 'x' })).error, 'unknown-kind');
    targets.listManagedResourceAgentIds = () => [];
    assert.equal((await engine.run({ kind: 'portrait', prompt: 'x' })).error, 'no-runtime');
  } finally {
    targets.listManagedResourceAgentIds = origT;
    executor.execute = origE;
  }
});

test('health: off / needs attention with reasons / ok, and last task outcome', async () => {
  const guardian = require('../guardian');
  const health = require('../guardian/health');
  const modelCall = require('../guardian/model-call');
  const origT = targets.listManagedResourceAgentIds;
  const origE = executor.execute;
  const origM = modelCall.modelStatus;
  try {
    guardian.setSettings({ enabled: false });
    assert.equal((await health.health()).level, 'off');
    guardian.setSettings({ enabled: true });

    targets.listManagedResourceAgentIds = () => [];
    modelCall.modelStatus = async () => ({ ok: false, count: 0 });
    let h = await health.health();
    assert.equal(h.level, 'warn');
    assert.deepEqual(h.issues.map(i => i.code).sort(), ['no-model', 'no-runtime']);
    assert.equal(h.issues.find(i => i.code === 'no-runtime').link.to, '/gateway');

    targets.listManagedResourceAgentIds = () => ['codex'];
    modelCall.modelStatus = async () => ({ ok: true, count: 3 });
    guardian.record({ category: 'setup', kind: 'setup-no-model', status: 'suggested', title: 'x', signature: 'setup-no-model' });
    h = await health.health();
    assert.equal(guardian.listRecords({ limit: 300 }).find(r => r.signature === 'setup-no-model').status, 'resolved', 'stale reminder closes once a model is available');
    assert.equal(h.level, 'ok', JSON.stringify(h.issues));
    assert.equal(h.engine.runtime, 'codex');

    // 执行应用跑失败：标志变成需要注意，并说明原因
    executor.execute = async () => ({ taskId: 't-fail' });
    await engine.run({ kind: 'discover', prompt: 'x' });
    assert.equal(engine.lastTask().status, 'running');
    executor.emit('task:failed', { taskId: 't-fail', error: 'Agent 无法连接服务 (401 Unauthorized)' });
    assert.equal(engine.lastTask().status, 'failed');
    h = await health.health();
    assert.equal(h.level, 'warn');
    assert.match(h.issues.find(i => i.code === 'runtime-failed').text, /401/);
    executor.execute = async () => ({ taskId: 't-ok' });
    await engine.run({ kind: 'install', prompt: 'y' });
    executor.emit('task:completed', { taskId: 't-ok' });
    assert.equal((await health.health()).level, 'ok');

    // 后台检查出错也会显示
    guardian.registerCheck('boom', async () => { throw new Error('disk full'); });
    await guardian.runCheck('boom');
    h = await health.health();
    assert.ok(h.issues.some(i => i.code === 'check-boom' && /disk full/.test(i.text)));
  } finally {
    targets.listManagedResourceAgentIds = origT;
    executor.execute = origE;
    modelCall.modelStatus = origM;
  }
});

test('health.busy lists what is running right now, and clears when it ends', async () => {
  const guardian = require('../guardian');
  const health = require('../guardian/health');
  const modelCall = require('../guardian/model-call');
  const origT = targets.listManagedResourceAgentIds;
  const origE = executor.execute;
  const origM = modelCall.modelStatus;
  try {
    targets.listManagedResourceAgentIds = () => ['codex'];
    modelCall.modelStatus = async () => ({ ok: true, count: 1 });
    assert.deepEqual((await health.health()).busy, []);

    // 执行应用里正在跑一个资产发现（执行器查得到、状态是运行中）
    const origS = executor.getTaskStatus;
    executor.getTaskStatus = async (id) => (id === 't-busy' ? { status: 'running' } : origS.call(executor, id));
    executor.execute = async () => ({ taskId: 't-busy' });
    await engine.run({ kind: 'discover', prompt: 'x' });
    assert.ok((await health.health()).busy.some(b => /资产发现/.test(b)));
    executor.emit('task:completed', { taskId: 't-busy' });
    assert.deepEqual((await health.health()).busy, []);
    executor.getTaskStatus = origS;

    // 结束事件漏了：执行器里已经是完成，也会按完成收尾
    executor.getTaskStatus = async (id) => (id === 't-missed' ? { status: 'completed' } : origS.call(executor, id));
    executor.execute = async () => ({ taskId: 't-missed' });
    await engine.run({ kind: 'portrait', prompt: 'x' });
    assert.deepEqual((await health.health()).busy, []);
    assert.equal(engine.lastTask().status, 'completed');
    executor.getTaskStatus = origS;

    // 一项后台检查正在跑
    let release;
    guardian.registerCheck('assets', () => new Promise((r) => { release = r; }));
    const p = guardian.runCheck('assets');
    assert.ok((await health.health()).busy.some(b => /资产体检/.test(b)));
    release({ ok: true });
    await p;
    assert.deepEqual((await health.health()).busy, []);
  } finally {
    targets.listManagedResourceAgentIds = origT;
    executor.execute = origE;
    modelCall.modelStatus = origM;
  }
});

test('playground guardian agent: listed on the runner app, fresh context each time, resolves to the runner', async () => {
  const guardian = require('../guardian');
  const chat = require('../guardian/chat');
  const orig = targets.listManagedResourceAgentIds;
  targets.listManagedResourceAgentIds = () => ['codex'];
  try {
    assert.equal(chat.listEntry(new Set()), null, 'runner not launchable → not listed');
    const e = chat.listEntry(new Set(['codex']), { codex: { name: 'Codex', capabilities: ['code'] } });
    assert.equal(e.id, 'assistant:tb-guardian');
    assert.equal(e.guardian, true);
    assert.equal(e.runtimeAgentId, 'codex');
    guardian.record({ category: 'assets', kind: 'k', status: 'info', title: '「x」包含高风险操作', advice: '信任或撤下' });
    assert.match(chat.systemText(), /待处理：\n- \[info\] 「x」包含高风险操作（信任或撤下）/);
    assert.match(chat.systemText(), /改用户的文件、执行会改变状态的命令、删除任何东西之前/);
    assert.equal(await executor.resolveAgentId('assistant:tb-guardian'), 'assistant:tb-guardian');
    const r = executor._resolveAssistant('assistant:tb-guardian');
    assert.equal(r.agentId, 'codex');
    assert.match(r.assistant.launch.promptPrefix || JSON.stringify(r.assistant.launch), /看护（自我进化）本身/);
    // 看护对话失败时，记录里写「看护（Codex）」而不是内部 id
    const tw = require('../guardian/task-watch');
    assert.match(tw._internal.agentName('assistant:tb-guardian'), /^内置看护智能体（/);
    guardian.setSettings({ enabled: false });
    assert.equal(chat.listEntry(new Set(['codex'])), null, 'guardian off → not listed');
    guardian.setSettings({ enabled: true });
  } finally {
    targets.listManagedResourceAgentIds = orig;
  }
});
