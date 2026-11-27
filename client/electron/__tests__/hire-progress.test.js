// 雇佣任务：对方报的进度摘要留在本机，回看能看到做了哪些步骤（不是对方的完整执行记录）
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const executor = require('../agent-executor');
const client = require('../community-agent-client');

test('游乐场雇佣任务：工具进度记进步骤，结果里带摘要', async () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tasks (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, prompt TEXT NOT NULL, context TEXT,
      status TEXT NOT NULL, result TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER);
    CREATE TABLE agent_task_steps (id TEXT PRIMARY KEY, task_id TEXT, step_number INTEGER, step_type TEXT, content TEXT,
      tool_name TEXT, tool_use_id TEXT, is_error INTEGER, status TEXT, created_at INTEGER);
    CREATE TABLE agent_modified_files (task_id TEXT, path TEXT);
  `);
  db.prepare("INSERT INTO agent_tasks (id, agent_id, prompt, status, created_at) VALUES ('t1', 'community:a1@ada', 'x', 'running', 1)").run();
  const origDb = executor._getDb;
  const origRun = client.runCommunityAgentTask;
  const origOwner = client.resolveCommunityOwner;
  let asked;
  executor._getDb = () => db;
  client.resolveCommunityOwner = async () => 'ada';
  client.runCommunityAgentTask = async (q) => {
    asked = q;
    q.onProgress({ event: 'progress', parts: [{ type: 'tool', name: 'search', detail: '搜资料' }] });
    q.onProgress({ event: 'progress', parts: [{ type: 'tool', name: 'search', detail: '搜资料' }, { type: 'tool', name: 'write', detail: '写报告', done: true }] });
    return { ok: true, output: '好了' };
  };
  try {
    await executor._runCommunityTaskForExecute('t1', 'community:a1@ada', 'x', { model: 'glm-5.3' });
    assert.strictEqual(asked.stream, true, '不管界面要不要实时，都要进度');
    assert.strictEqual(asked.model, undefined, '雇来的智能体用出租方自己的模型，雇佣方带了也不发过去');
    const steps = db.prepare('SELECT step_type, tool_name FROM agent_task_steps WHERE task_id = ? ORDER BY step_number').all('t1');
    assert.deepStrictEqual(steps.map((s) => `${s.step_type}:${s.tool_name}`),
      ['tool_call:search', 'tool_result:search', 'tool_call:write', 'tool_result:write']);
    const result = JSON.parse(db.prepare('SELECT result FROM agent_tasks WHERE id = ?').get('t1').result);
    assert.deepStrictEqual(result.progress.map((p) => [p.tool, p.detail, !!p.done]), [['search', '搜资料', true], ['write', '写报告', true]]);
  } finally {
    executor._getDb = origDb;
    client.runCommunityAgentTask = origRun;
    client.resolveCommunityOwner = origOwner;
    db.close();
  }
});
