// client/electron/guardian/engine.js
// 看护的执行引擎：技能安装这类需要「会用工具的应用」才能做的事，由看护在后台交给
// 一个已纳管的命令行应用（Codex / Claude Code / Cursor / Kimi Code …）去跑；内置看护智能体也跑在它上面。
// 没有单独的系统智能体资产：角色说明写在这里，不纳管、不投射。
'use strict';

const store = require('./store');

// 能跑这类任务的应用（需要能执行命令、检索）：按优先序
const RUNTIMES = ['codex', 'claude-code', 'cursor', 'kimi-code', 'workbuddy'];

// 旧版本留下的三个系统智能体：启动时清理掉
const LEGACY_ASSISTANTS = ['resource-portrait', 'resource-finder', 'resource-installer'];

const ROLES = {
  install: [
    '【Token Bank 看护任务：资产安装】',
    '用户给出 Skill 安装命令或说明（skillhub install <slug>、npx skills add …、GitHub 地址、技能 slug）。',
    '1. 理解意图，提取要安装的 skill 名称 / slug / 来源；',
    '2. 在本机安装，默认目录 ~/.tokenbank/skills（Windows：%USERPROFILE%\\.tokenbank\\skills）：',
    '   - GitHub URL / owner/repo：不要当 skillhub slug；用 git clone --depth 1 <url> ~/.tokenbank/skills/<仓库名>（失败可下 zip 解压），确认有 SKILL.md；',
    '   - SkillHub slug：skillhub install <slug> --dir <上述目录> --json；',
    '   - 也可在安全前提下执行用户原生命令（如 npx skills add <url> -g -y）；',
    '3. 完成后确认目录下有 SKILL.md（或 skill.md），用简短中文汇报：成功 / 失败、技能名、路径；',
    '4. 不要编造已安装成功；失败时给出可操作的原因。',
  ].join('\n'),
};

function label(id) {
  try { return require('../config-loader').appEntityById(id)?.name || id; } catch { return id; }
}

/** 已纳管、能跑看护任务的应用 */
function runtimes() {
  let managed = [];
  try { managed = require('../resource-agent-targets').listManagedResourceAgentIds() || []; } catch { /* ignore */ }
  return RUNTIMES.filter(id => managed.includes(id)).map(id => ({ id, label: label(id) }));
}

function status() {
  const list = runtimes();
  const pref = store.readJson('engine.json', {}).runtime;
  const runtime = list.find(r => r.id === pref)?.id || list[0]?.id || null;
  return { ready: !!runtime, runtime, runtimes: list };
}

function setRuntime(id) {
  if (!runtimes().some(r => r.id === id)) return { ok: false, error: '这个应用还没有纳管' };
  store.writeJson('engine.json', { ...store.readJson('engine.json', {}), runtime: id });
  return { ok: true, runtime: id };
}

/** 跑一个看护任务；返回执行器的 taskId，进度和结果沿用智能体任务的事件与查询 */
async function run({ kind, prompt, sessionKey } = {}) {
  if (!ROLES[kind]) return { ok: false, error: 'unknown-kind' };
  if (!String(prompt || '').trim()) return { ok: false, error: 'empty-prompt' };
  const st = status();
  if (!st.ready) return { ok: false, error: 'no-runtime' };
  const executor = require('../agent-executor');
  watch(executor);
  let res;
  try {
    res = await executor.execute(st.runtime, `${ROLES[kind]}\n\n---\n\n${prompt}`, {
      mode: 'direct', sessionKey: sessionKey || `tokenbank-guardian-${kind}`,
    });
  } catch (e) {
    noteLast({ kind, runtime: st.runtime, status: 'failed', error: e.message });
    throw e;
  }
  if (res?.taskId) pending.set(res.taskId, { kind, runtime: st.runtime, startedAt: Date.now() });
  noteLast({ kind, runtime: st.runtime, status: 'running' });
  return { ok: true, taskId: res?.taskId, runtime: st.runtime };
}

// ── 最近一次任务的结果：设置页据此显示执行应用是否正常 ──────────────────────
const pending = new Map();
let watching = false;

function noteLast(last) {
  store.writeJson('engine.json', { ...store.readJson('engine.json', {}), last: { ...last, at: Date.now() } });
}

function watch(executor) {
  if (watching || !executor || typeof executor.on !== 'function') return;
  watching = true;
  const done = (status) => (evt = {}) => {
    const job = pending.get(evt.taskId);
    if (!job) return;
    pending.delete(evt.taskId);
    delete job.startedAt;
    const error = status === 'failed' ? String(evt.error || evt.result?.error || 'failed').slice(0, 200) : null;
    noteLast({ ...job, status, error });
  };
  executor.on('task:completed', done('completed'));
  executor.on('task:failed', done('failed'));
  executor.on('task:cancelled', done('cancelled'));
}

const STALE_MS = 2 * 60 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/**
 * 正在执行应用里跑的看护任务。先向执行器核对一遍：结束事件万一漏了（或进程重启前留下的），
 * 按执行器记录的终态收尾；超过 2 小时还没结束的也不再算「正在执行」，避免小圆点一直转。
 */
async function runningTasks() {
  let executor = null;
  try { executor = require('../agent-executor'); } catch { /* ignore */ }
  for (const [taskId, job] of [...pending.entries()]) {
    if (Date.now() - (job.startedAt || 0) > STALE_MS) { pending.delete(taskId); continue; }
    try {
      const st = executor && typeof executor.getTaskStatus === 'function' ? await executor.getTaskStatus(taskId) : null;
      const status = st && (st.status || st.task?.status);
      if (TERMINAL.has(status)) {
        pending.delete(taskId);
        noteLast({ kind: job.kind, runtime: job.runtime, status, error: status === 'failed' ? String(st.error || st.task?.error || 'failed').slice(0, 200) : null });
      }
    } catch (e) {
      // 执行器里根本没有这条任务：不可能还在跑，直接不算
      if (/not found/i.test(String(e && e.message))) pending.delete(taskId);
    }
  }
  return [...pending.values()].map(j => j.kind);
}

function lastTask() {
  return store.readJson('engine.json', {}).last || null;
}

/** 清理旧版本的三个系统智能体（撤投射 + 删除）；幂等 */
function retireLegacyAssistants() {
  const removed = [];
  try {
    const m = require('../resource-manager');
    m.init();
    for (const r of m.listResources({ type: 'assistant' })) {
      if (!LEGACY_ASSISTANTS.includes(r.name)) continue;
      try { m.deleteResource(r.id, { force: true, allowBuiltin: true }); removed.push(r.name); } catch (e) {
        console.warn('[guardian] retire legacy assistant failed:', r.name, e.message);
      }
    }
  } catch { /* 资产库不可用 */ }
  return removed;
}

module.exports = { status, setRuntime, run, runtimes, lastTask, runningTasks, retireLegacyAssistants, ROLES, LEGACY_ASSISTANTS, _internal: { watch, pending } };
