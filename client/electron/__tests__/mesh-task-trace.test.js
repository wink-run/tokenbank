'use strict';
// 派到其他设备上跑的任务：在本机应用明细里列出来（标上设备），Trace 用同步回来的步骤拼出来
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const localStats = require('../local-stats');
const meshTrace = require('../mesh-task-trace');

test('跨设备任务：列成会话行、Trace 按步骤拼出来', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mesh-trace-'));
  localStats.close();
  assert.ok(localStats.init(dir, { force: true }));
  try {
    const db = localStats.getDb();
    const now = Date.now();
    db.prepare(`INSERT INTO agent_tasks (id, agent_id, prompt, context, result, status, created_at, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`).run(
      'mesh:dev-mini:t1', 'mine:claude-code@macmini', '把 README 翻成英文',
      JSON.stringify({ mesh: true, meshDevice: 'macmini' }),
      JSON.stringify({ device: 'macmini', remoteHarness: 'claude-code', output: 'done' }), now - 5000, now - 5000, now);
    db.prepare(`INSERT INTO agent_tasks (id, agent_id, prompt, context, status, created_at, started_at)
      VALUES ('local-1', 'claude-code', '本机的', '{}', 'completed', ?, ?)`).run(now, now);
    const step = db.prepare(`INSERT INTO agent_task_steps (id, task_id, step_number, step_type, content, tool_name, tool_input, tool_output, is_error, created_at)
      VALUES (?, 'mesh:dev-mini:t1', ?, ?, ?, ?, ?, ?, ?, ?)`);
    step.run('s1', 1, 'thinking', '先读文件', null, null, null, 0, now - 4000);
    step.run('s2', 2, 'tool_call', '', 'Read', JSON.stringify({ file_path: 'README.md' }), null, 0, now - 3000);
    step.run('s3', 3, 'tool_result', '', 'Read', null, '# 标题', 0, now - 2000);
    step.run('s4', 4, 'output', '已翻译', null, null, null, 0, now - 1000);

    const rows = meshTrace.listActivity(['claude-code'], 30);
    assert.equal(rows.length, 1, '只列跨设备的');
    assert.equal(rows[0].project, '@macmini');
    assert.equal(rows[0].calls, 4);
    assert.equal(rows[0].mesh, true);
    assert.equal(meshTrace.listActivity(['claude-desktop'], 30).length, 1, '别名也算');
    assert.equal(meshTrace.listActivity(['codex'], 30).length, 0);

    const trace = meshTrace.getTrace('mesh:dev-mini:t1');
    assert.deepEqual(trace.steps.map((s) => s.kind), ['user', 'assistant', 'tool', 'tool_result', 'assistant']);
    assert.equal(trace.steps[2].tool, 'Read');
    assert.deepEqual(trace.steps[2].input, { file_path: 'README.md' });
    assert.equal(trace.steps[1].reasoning, '先读文件');
    assert.equal(trace.stats.tools, 1);
    assert.equal(trace.project, '@macmini');
    assert.equal(meshTrace.getTrace('mesh:nope').notFound, true);
  } finally {
    localStats.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
