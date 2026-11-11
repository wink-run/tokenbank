'use strict';
// 智能管家执行引擎：画像 / 发现 / 安装不再是三个系统智能体，由智能管家交给一个已纳管的应用在后台跑
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
    assert.deepEqual(st.runtimes.map(r => r.id), ['codex', 'claude-code', 'pi'], 'tool-capable apps, preferred order; Pi last');
    assert.equal(st.runtime, 'codex');
    assert.equal(engine.setRuntime('pi').ok, true);
    assert.equal(engine.status().runtime, 'pi');
    assert.equal(engine.setRuntime('claude-code').ok, true);
    assert.equal(engine.status().runtime, 'claude-code');
    targets.listManagedResourceAgentIds = () => ['pi'];
    assert.equal(engine.status().ready, true);
    assert.equal(engine.status().runtime, 'pi');
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
    assert.match(calls[0].prompt, /智能管家任务：资产安装[\s\S]*装一下 owner\/repo/);
    assert.equal(calls[0].options.sessionKey, 'resource-install');
    assert.equal((await engine.run({ kind: 'bogus', prompt: 'x' })).error, 'unknown-kind');
    targets.listManagedResourceAgentIds = () => [];
    assert.equal((await engine.run({ kind: 'install', prompt: 'x' })).error, 'no-runtime');
  } finally {
    targets.listManagedResourceAgentIds = origT;
    executor.execute = origE;
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

    // 执行应用里正在跑一个技能安装（执行器查得到、状态是运行中）
    const origS = executor.getTaskStatus;
    executor.getTaskStatus = async (id) => (id === 't-busy' ? { status: 'running' } : origS.call(executor, id));
    executor.execute = async () => ({ taskId: 't-busy' });
    await engine.run({ kind: 'install', prompt: 'x' });
    assert.ok((await health.health()).busy.some(b => /技能安装/.test(b)));
    executor.emit('task:completed', { taskId: 't-busy' });
    assert.deepEqual((await health.health()).busy, []);
    executor.getTaskStatus = origS;

    // 结束事件漏了：执行器里已经是完成，也会按完成收尾
    executor.getTaskStatus = async (id) => (id === 't-missed' ? { status: 'completed' } : origS.call(executor, id));
    executor.execute = async () => ({ taskId: 't-missed' });
    await engine.run({ kind: 'install', prompt: 'x' });
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

test('butler in the playground: runs on Pi when Pi is the only managed runner, and prefers Codex when both are there', () => {
  const chat = require('../guardian/chat');
  const orig = targets.listManagedResourceAgentIds;
  try {
    targets.listManagedResourceAgentIds = () => ['pi'];
    assert.equal(chat.listEntry(new Set(['pi']), { pi: { name: 'Pi', capabilities: ['chat'] } }).runtimeAgentId, 'pi');
    targets.listManagedResourceAgentIds = () => ['pi', 'codex'];
    assert.equal(chat.listEntry(new Set(['pi', 'codex']), { codex: { name: 'Codex', capabilities: ['code'] } }).runtimeAgentId, 'codex');
  } finally {
    targets.listManagedResourceAgentIds = orig;
  }
});
