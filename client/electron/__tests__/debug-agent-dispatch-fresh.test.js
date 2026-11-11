'use strict';
// 回归：「新会话」后切换窗口/标签，不应回填已完成的旧对话；进行中的派发仍可镜像。
const test = require('node:test');
const assert = require('node:assert');

let S;
test.before(async () => {
  S = await import('../../src/lib/debug-agent-store.js');
});

test('运行中的派发：子标签刚开新会话时，切过去仍能镜像出执行过程', async () => {
  const agents = [{ id: 'assistant:res-poem', name: '写诗专家', type: 'assistant', resourceId: 'res-poem' }];
  const child = 'assistant:res-poem';

  S.clearSessionTaskState(child);
  assert.equal(S.isFreshAgentSession(S.getStoreSession(child)), true, '前置：应为 fresh 会话');

  S.beginSessionInstance('__hub__');
  const hubInstance = S.getStoreSession('__hub__').sessionInstanceId;
  S.patchDelegation('__hub__', 'd1', {
    agentId: child,
    prompt: '写首诗',
    steps: [{ stepType: 'output', content: '床前明月光' }],
    status: 'running',
    sessionInstanceId: hubInstance,
  });

  const ok = S.syncDelegatedMirrorToAgentTab(child, agents);
  const sess = S.getStoreSession(child);

  assert.equal(ok, true, 'syncDelegatedMirrorToAgentTab 应返回 true（已镜像）');
  assert.equal(sess.executing, true, '新会话应处于执行中');
  assert.ok((sess.taskSteps || []).some(s => /床前明月光/.test(s.content)), '新会话应显示派发步骤');
});

test('已完成的派发：新会话后切回标签，不应回填旧对话', async () => {
  const agents = [{ id: 'assistant:res-poem2', name: '写诗专家', type: 'assistant', resourceId: 'res-poem2' }];
  const child = 'assistant:res-poem2';

  S.beginSessionInstance('__hub__');
  const hubInstance = S.getStoreSession('__hub__').sessionInstanceId;
  S.patchDelegation('__hub__', 'd2', {
    agentId: child,
    prompt: '写一首诗，主题不限',
    steps: [{ stepType: 'output', content: '《夏夜独坐》' }],
    status: 'completed',
    result: { summary: '《夏夜独坐》' },
    sessionInstanceId: hubInstance,
  });

  // 用户点「新会话」
  S.clearSessionTaskState(child);
  assert.equal(S.isFreshAgentSession(S.getStoreSession(child)), true);

  // 切换窗口再回来 → 不应把已完成派发灌进新会话
  const ok = S.syncDelegatedMirrorToAgentTab(child, agents);
  const sess = S.getStoreSession(child);
  assert.equal(ok, false, 'fresh 会话不应回填已完成派发');
  assert.equal((sess.conversationTurns || []).length, 0, '新会话应保持空白');
  assert.equal(S.isFreshAgentSession(sess), true, '仍应保持 fresh，避免 recoverSessionHistory 回填');
});

test('刷新后恢复进行中任务会接上原来的会话实例', () => {
  const key = 'refresh-hub';
  assert.equal(S.getStoreSession(key).sessionInstanceId, '');
  assert.equal(S.eventMatchesSession(key, 'sess_old'), true);

  S.mergeTaskIntoStore({
    id: 'task_refresh',
    agent_id: 'pi',
    prompt: '画一幅',
    status: 'running',
    context: { sessionKey: key, sessionInstanceId: 'sess_old', mode: 'orchestrator' },
    steps: [],
  });

  const sess = S.getStoreSession(key);
  assert.equal(sess.executing, true);
  assert.equal(sess.sessionInstanceId, 'sess_old');
  assert.equal(S.eventMatchesSession(key, 'sess_old'), true);
  assert.equal(S.eventMatchesSession(key, 'sess_other'), false);
});

test('已完成的派发：mergeTaskIntoStore 不污染 fresh 子标签', async () => {
  const child = 'assistant:res-poem3';
  S.clearSessionTaskState(child);

  const completed = {
    id: 'd3',
    agent_id: child,
    prompt: '写首诗',
    status: 'completed',
    context: { parentTaskId: 'phub', sessionKey: '__hub__', sessionInstanceId: 'Hx' },
    steps: [{ step_number: 0, step_type: 'output', content: '《观棋》' }],
    result: { summary: '《观棋》' },
    completed_at: Date.now(),
  };
  S.mergeTaskIntoStore(completed);

  const sess = S.getStoreSession(child);
  assert.equal((sess.conversationTurns || []).length, 0, 'fresh 子标签不应被历史完成任务归档');
});

test('归档步骤：DB 步骤不能覆盖前端派发步骤', () => {
  const stored = [
    { stepType: 'delegation', phase: 'start', childTaskId: 'c1', content: '写 Python 诗', timestamp: 1 },
    { stepType: 'thinking', content: '正在协调', timestamp: 2 },
    { stepType: 'output', content: '最终汇总', timestamp: 3 },
  ];
  const db = [
    { stepType: 'output', content: '最终汇总', timestamp: 3 },
  ];
  const merged = S.resolveArchiveSteps(db, stored);
  assert.ok(merged.some(s => s.stepType === 'delegation'), '应保留派发步骤');
  assert.ok(merged.some(s => s.stepType === 'thinking'), '应保留编排推理步骤');
});

test('子任务步骤：前端流式细节优先于 DB 摘要', () => {
  const stored = [
    { stepType: 'thinking', content: '构思诗句' },
    { stepType: 'output', content: 'import poem' },
  ];
  const db = [{ stepType: 'output', content: 'import poem' }];
  const picked = S.preferRicherSteps(db, stored);
  assert.equal(picked.length, 2, '应保留 thinking 过程');
  assert.ok(picked.some(s => s.stepType === 'thinking'));
});

test('Codex 场景：DB 条数更多但前端合并内容更完整时保留 stored', () => {
  const stored = [
    { stepType: 'thinking', content: '构思一首诗' },
    { stepType: 'output', content: '床前明月光，疑是地上霜。', is_snapshot: true },
  ];
  const db = [
    { stepType: 'output', content: '床前' },
    { stepType: 'output', content: '床前明月光' },
    { stepType: 'output', content: '床前明月光，疑是地上霜。' },
  ];
  const picked = S.preferRicherSteps(db, stored);
  assert.equal(picked, stored);
});

test('归档轮次：delegations 随 conversationTurns 持久化', () => {
  S.clearSessionTaskState('__hub__');
  S.archiveCompletedTurn('__hub__', {
    user: '分别写一首诗',
    steps: [{ stepType: 'delegation', phase: 'start', childTaskId: 'c1', content: 'Python 诗' }],
    delegations: {
      c1: { agentId: 'assistant:py', prompt: 'Python 诗', steps: [{ stepType: 'output', content: 'import poem' }], status: 'completed' },
    },
    taskId: 'hub-1',
  });
  const turn = S.getStoreSession('__hub__').conversationTurns[0];
  assert.ok(turn.delegations?.c1, '归档应保存 delegations');
  assert.equal(turn.delegations.c1.steps[0].content, 'import poem');
});

test('归档轮次：同 taskId 以更完整步骤 upsert', () => {
  S.clearSessionTaskState('__hub__');
  S.archiveCompletedTurn('__hub__', {
    user: '写首诗',
    steps: [{ stepType: 'thinking', content: 'The user wants a poem' }],
    taskId: 't-poem',
    result: { summary: 'The user wants a poem' },
  });
  S.archiveCompletedTurn('__hub__', {
    user: '写首诗',
    steps: [
      { stepType: 'thinking', content: 'The user wants a poem' },
      { stepType: 'output', content: '床前明月光，疑是地上霜。' },
    ],
    taskId: 't-poem',
    result: { summary: '床前明月光，疑是地上霜。' },
  });
  const turns = S.getStoreSession('__hub__').conversationTurns;
  assert.equal(turns.length, 1);
  assert.ok(turns[0].steps.some(s => /床前明月光/.test(s.content)));
});

test('preferRicherSteps：DB 缺 tool_result 时保留内存失败态，避免变回执行中', () => {
  const db = [
    { stepType: 'thinking', content: 'working' },
    { stepType: 'tool_call', tool_use_id: 'tu1', content: '{}' },
  ];
  const stored = [
    { stepType: 'tool_call', tool_use_id: 'tu1', content: '{}' },
    { stepType: 'tool_result', tool_use_id: 'tu1', content: 'boom', is_error: true },
  ];
  const got = S.preferRicherSteps(db, stored);
  assert.equal(got, stored);
  assert.ok(got.some(s => s.is_error), '应保留 is_error');
  assert.equal(S.hasOpenToolCalls(got), false);
});

test('archiveCompletedTurn：归档时闭合未完成工具，避免历史显示不全', () => {
  S.clearSessionTaskState('__hub__');
  S.archiveCompletedTurn('__hub__', {
    user: '生成 PPT',
    steps: [
      { stepType: 'output', content: '开始生成' },
      { stepType: 'tool_call', tool_use_id: 'm1', tool_name: 'tb_resolve_model', content: '{"preferred":"jimeng-5.0"}' },
    ],
    status: 'cancelled',
    taskId: 't-hist-1',
  });
  const turn = S.getStoreSession('__hub__').conversationTurns[0];
  assert.ok(turn.steps.some(s => s.stepType === 'tool_result' && s.tool_use_id === 'm1'));
  assert.equal(S.hasOpenToolCalls(turn.steps), false);
});

test('workingDirBasename 取路径末段', () => {
  assert.equal(S.workingDirBasename('/Users/ully/githubprojects/testabc'), 'testabc');
  assert.equal(S.workingDirBasename('C:\\proj\\foo\\'), 'foo');
  assert.equal(S.workingDirBasename(''), '');
});
