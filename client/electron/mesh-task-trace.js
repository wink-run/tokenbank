// client/electron/mesh-task-trace.js
// 跨设备执行的任务在本机的 Trace。
// 派到我其他设备上跑的任务，本机有一份镜像（agent_tasks 里 id 以 mesh: 开头），那台设备的执行步骤也同步回来存在
// agent_task_steps 里（_applyMeshResponse）。但应用明细的「按会话」和 Trace 只读本机应用自己的会话文件，看不到它们。
// 这里把镜像任务列成会话行（标上在哪台设备跑的），Trace 用同步回来的步骤拼出来，和本机会话同一种格式。
'use strict';

const MESH_PREFIX = 'mesh:';

function db() {
  return require('./local-stats').getDb();
}

function parseJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

/** 这个任务在那台设备上用哪个应用跑的：远端报的 harness，没有就从 mine:<应用>@<设备> 里取 */
function harnessOf(row) {
  const result = parseJson(row.result, {});
  const raw = String(result.remoteHarness || row.agent_id || '');
  return raw.replace(/^mine:/, '').replace(/@.*$/, '');
}

function deviceOf(row) {
  const result = parseJson(row.result, {});
  const ctx = parseJson(row.context, {});
  return String(result.device || ctx.meshDevice || '').trim();
}

/** 别名：claude-desktop 和 claude-code、codex-desktop 和 codex 算一个应用 */
function sameApp(a, b) {
  const norm = (x) => String(x || '').trim().toLowerCase().replace(/-desktop$/, '').replace(/^claude$/, 'claude-code');
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * 某个应用在这段时间里派到其他设备上跑的任务，列成会话行（和本机会话行同样的字段）
 * @param {string[]} agentIds 应用 id（含别名）
 * @param {number} days
 */
function listActivity(agentIds, days = 30) {
  const ids = (Array.isArray(agentIds) ? agentIds : [agentIds]).filter(Boolean);
  if (!ids.length) return [];
  const since = Date.now() - Number(days || 30) * 24 * 60 * 60 * 1000;
  let rows = [];
  try {
    rows = db().prepare(`
      SELECT t.id, t.agent_id, t.prompt, t.context, t.result, t.status, t.created_at, t.completed_at,
             (SELECT COUNT(*) FROM agent_task_steps s WHERE s.task_id = t.id) AS steps
      FROM agent_tasks t
      WHERE t.id LIKE 'mesh:%' AND t.created_at >= ?
      ORDER BY t.created_at DESC
      LIMIT 200
    `).all(since);
  } catch { return []; }
  const out = [];
  for (const r of rows) {
    const harness = harnessOf(r);
    if (!ids.some((id) => sameApp(id, harness))) continue;
    const device = deviceOf(r);
    out.push({
      session_id: r.id,
      project: device ? `@${device}` : '@其他设备',
      project_path: device ? `在 ${device} 上执行` : '在其他设备上执行',
      context: String(r.prompt || '').replace(/\s+/g, ' ').slice(0, 120),
      calls: Number(r.steps) || 0,
      tokens: 0,
      lastTs: Math.floor((Number(r.completed_at) || Number(r.created_at) || 0) / 1000),
      mesh_device: device || null,
      mesh: true,
      status: r.status,
    });
  }
  return out;
}

function isMeshSession(sessionId) {
  return String(sessionId || '').startsWith(MESH_PREFIX);
}

/** 把同步回来的步骤拼成 Trace（和本机会话 Trace 同样的格式：kind / label / text / tool / input …） */
function getTrace(taskId) {
  let task;
  let rows = [];
  try {
    task = db().prepare('SELECT id, agent_id, prompt, context, result, status, created_at, completed_at FROM agent_tasks WHERE id = ?').get(taskId);
    if (task) {
      rows = db().prepare(`
        SELECT step_number, step_type, content, tool_name, tool_input, tool_output, is_error, created_at
        FROM agent_task_steps WHERE task_id = ? ORDER BY step_number ASC, created_at ASC
      `).all(taskId);
    }
  } catch { /* 库不可用 */ }
  if (!task) return { error: 'not_found', notFound: true, steps: [] };
  const device = deviceOf(task);
  const steps = [{ kind: 'user', label: '任务', text: String(task.prompt || ''), ts: Number(task.created_at) || null }];
  const toolCount = {};
  for (const s of rows) {
    const ts = Number(s.created_at) || null;
    const type = String(s.step_type || 'output');
    if (type === 'tool_call') {
      const name = s.tool_name || '工具';
      toolCount[name] = (toolCount[name] || 0) + 1;
      steps.push({ kind: 'tool', tool: name, label: name, input: parseJson(s.tool_input, s.tool_input || s.content || null), ts });
    } else if (type === 'tool_result') {
      steps.push({ kind: 'tool_result', label: s.tool_name || '结果', text: String(s.tool_output || s.content || ''), is_error: !!s.is_error, ts });
    } else if (type === 'thinking') {
      steps.push({ kind: 'assistant', label: '思考', reasoning: String(s.content || ''), text: '', ts });
    } else if (type === 'output') {
      steps.push({ kind: 'assistant', label: 'AI', text: String(s.content || ''), ts });
    } else {
      steps.push({ kind: 'assistant', label: type, text: String(s.content || ''), ts });
    }
  }
  const tools = Object.values(toolCount).reduce((n, x) => n + x, 0);
  return {
    client: harnessOf(task) || 'mesh',
    agent: harnessOf(task),
    project: device ? `@${device}` : '',
    project_path: device ? `在 ${device} 上执行` : '',
    cwd: '',
    mesh_device: device || null,
    steps,
    stats: {
      steps: steps.length,
      tools,
      toolBreakdown: Object.entries(toolCount).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      tokens: {},
    },
  };
}

module.exports = { listActivity, getTrace, isMeshSession, sameApp };
