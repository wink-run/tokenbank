'use strict';

const { stripAnsi, parseAgentOutputLine } = require('../agent-output-parser');
const assert = require('assert');

// ANSI 剥离
assert.strictEqual(
  stripAnsi('\x1b[33mWarning\x1b[39m test'),
  'Warning test',
);
assert.strictEqual(
  stripAnsi('[33mWarning: no stdin[39m'),
  'Warning: no stdin',
);

// 噪声过滤
assert.deepStrictEqual(parseAgentOutputLine('Warning: no stdin data received in 3s', 'claude-code'), []);

// Claude stream-json
const jsonSteps = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: '正在编写贪吃蛇游戏…' },
      { type: 'tool_use', name: 'Write', input: { file_path: 'snake.py' } },
    ],
  },
}), 'claude-code');
assert.strictEqual(jsonSteps.length, 2);
assert.strictEqual(jsonSteps[0].stepType, 'output');
assert.strictEqual(jsonSteps[1].stepType, 'tool_call');
assert.strictEqual(jsonSteps[1].tool_name, 'Write');

// Claude system / api_retry
const retrySteps = parseAgentOutputLine(JSON.stringify({
  type: 'system',
  subtype: 'api_retry',
  attempt: 2,
  max_retries: 10,
  retry_delay_ms: 1105.609,
  error_status: 529,
}), 'claude-code');
assert.strictEqual(retrySteps.length, 1);
assert.strictEqual(retrySteps[0].stepType, 'system_event');
assert.strictEqual(retrySteps[0].system_subtype, 'api_retry');
assert.strictEqual(retrySteps[0].attempt, 2);

assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'system', subtype: 'thinking_tokens',
}), 'claude-code'), []);

// 顶层 rate_limit_event（Claude CLI 遥测，不应混入回复正文）
assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'rate_limit_event',
  rateLimitInfo: {
    status: 'allowed',
    resetsAt: 1783691400,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
  },
  uuid: '40ece55a-a9e4-41d9-bd0e-70e686433dda',
  sessionId: '5550fa92-351c-4adb-aaf8-1f654c4b8bd7',
}), 'claude-code'), []);

// hook_started 跳过
assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'system',
  subtype: 'hook_started',
  hook_name: 'SessionStart:startup',
}), 'claude-code'), []);

// hook_response 解析内嵌 JSON
const hookSteps = parseAgentOutputLine(JSON.stringify({
  type: 'system',
  subtype: 'hook_response',
  hook_name: 'SessionStart:startup',
  output: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: '会话已就绪，开始工作。',
    },
  }),
}), 'claude-code');
assert.strictEqual(hookSteps.length, 1);
assert.strictEqual(hookSteps[0].stepType, 'output');
assert.strictEqual(hookSteps[0].content, '会话已就绪，开始工作。');

const { summarizeAgentStdout, extractModifiedFiles, isLikelyFilePath, extractCliSessionId } = require('../agent-output-parser');
const summary = summarizeAgentStdout(
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '你好' }] } }),
  'claude-code',
);
assert.strictEqual(summary, '你好');

// 文件路径提取：stream-json Write
const writeLine = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'tool_use', name: 'Write', input: { file_path: 'skills/code-avatar/SKILL.md', content: '---\nname: x\n---' } },
    ],
  },
});
const extracted = extractModifiedFiles(`${writeLine}\n`);
assert.strictEqual(extracted.length, 1);
assert.strictEqual(extracted[0].path, 'skills/code-avatar/SKILL.md');
assert.strictEqual(extracted[0].operation, 'created');

// JSON 行内 Created: 子串不应误匹配 skill 正文
const badJson = JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: 'Created: false\\n---\\n\\n# Code Avatar' }] },
});
assert.strictEqual(extractModifiedFiles(badJson).length, 0);
assert.strictEqual(isLikelyFilePath('false\\n---\\n\\n# Title'), false);
assert.ok(isLikelyFilePath('src/foo.py'));

const VALID_SID = '5550fa92-351c-4adb-aaf8-1f654c4b8bd7';
const VALID_THREAD = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

assert.strictEqual(
  extractCliSessionId(JSON.stringify({ type: 'thread.started', thread_id: VALID_THREAD }), 'codex'),
  VALID_THREAD,
);
assert.strictEqual(
  extractCliSessionId(JSON.stringify({ type: 'system', subtype: 'init', session_id: VALID_SID }), 'claude-code'),
  VALID_SID,
);
assert.strictEqual(
  extractCliSessionId(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-9' }), 'claude-code'),
  null,
);

// Codex JSONL
const codexSteps = parseAgentOutputLine(JSON.stringify({
  type: 'event_msg',
  payload: { type: 'agent_message', message: '正在分析代码…' },
}), 'codex');
assert.strictEqual(codexSteps.length, 1);
assert.strictEqual(codexSteps[0].stepType, 'output');

// Codex 新版 item.completed
const itemSteps = parseAgentOutputLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_1',
    type: 'agent_message',
    text: '# 冒泡排序\n\n算法原理…',
  },
}), 'codex');
assert.strictEqual(itemSteps.length, 1);
assert.strictEqual(itemSteps[0].stepType, 'output');
assert.ok(itemSteps[0].content.includes('冒泡排序'));

assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'thread.started',
  thread_id: 'abc',
}), 'codex'), []);

// stream_event token 增量
const deltaSteps = parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '你好' },
  },
}), 'claude-code');
assert.strictEqual(deltaSteps.length, 1);
assert.strictEqual(deltaSteps[0].stepType, 'output');
assert.strictEqual(deltaSteps[0].content, '你好');
assert.strictEqual(deltaSteps[0].is_delta, true);

assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_start' },
}), 'claude-code'), []);

// content_block 类型跟踪：thinking 与 text 分离
const state = { blockTypes: new Map() };
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'thinking', thinking: '' },
  },
}), 'claude-code', state);
const thinkDelta = parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'The user is asking' },
  },
}), 'claude-code', state);
assert.strictEqual(thinkDelta.length, 1);
assert.strictEqual(thinkDelta[0].stepType, 'thinking');

parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'text', text: '' },
  },
}), 'claude-code', state);
const textDelta = parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: '我是 Claude' },
  },
}), 'claude-code', state);
assert.strictEqual(textDelta.length, 1);
assert.strictEqual(textDelta[0].stepType, 'output');

// streaming 期间跳过 assistant 快照（由 stream_event 处理，避免重复卡片）
const streamState = { blockTypes: new Map(), blockTexts: new Map(), streaming: true, lastThinking: '', lastOutput: '' };
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_start' },
}), 'claude-code', streamState);
const dupSnap = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'thinking', thinking: 'The user is saying hi' },
      { type: 'text', text: 'Hi. What are you working on?' },
    ],
  },
}), 'claude-code', streamState);
assert.deepStrictEqual(dupSnap, []);

// message_stop 刷新 blockTexts 作为兜底输出
streamState.blockTexts.set(0, 'Hi. What are you working on?');
streamState.blockTypes.set(0, 'text');
const stopFlush = parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: { type: 'message_stop' },
}), 'claude-code', streamState);
assert.ok(stopFlush.some(s => s.stepType === 'output'));

// 非 streaming 时 assistant 仍正常解析
const mixedAssistant = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [{
      type: 'text',
      text: 'The user is just saying hi. I should respond concisely without any fluff, as per their CLAUDE.md instructions.Hi. What are you working on?',
    }],
  },
}), 'claude-code');
assert.ok(mixedAssistant.some(s => s.stepType === 'thinking'));
assert.ok(mixedAssistant.some(s => s.stepType === 'output'));
assert.ok(mixedAssistant.find(s => s.stepType === 'output').content.includes('Hi. What'));

// content_block_stop 后 block 类型仍保留
const st2 = { blockTypes: new Map(), streaming: true, lastThinking: '' };
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
}), 'claude-code', st2);
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_stop', index: 1 },
}), 'claude-code', st2);
const afterStop = parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Hello' },
  },
}), 'claude-code', st2);
assert.strictEqual(afterStop[0]?.stepType, 'output');

// 尚无 text 块时 meta 英文 text_delta 归入 thinking
const st3 = { blockTypes: new Map(), streaming: true, lastThinking: '' };
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
}), 'claude-code', st3);
const metaLeak = parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: "The user is just saying hi - a simple greeting. I'll respond concisely." },
  },
}), 'claude-code', st3);
assert.strictEqual(metaLeak[0]?.stepType, 'thinking');

// CC 逐块 assistant + CCR 全量 text_delta 快照
const snapState = { blockTypes: new Map(), blockTexts: new Map(), streaming: true, lastThinking: '' };
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
}), 'claude-code', snapState);
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '你好' },
  },
}), 'claude-code', snapState);
const snap2 = parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: '你好，世界' },
  },
}), 'claude-code', snapState);
assert.strictEqual(snap2.length, 1);
assert.strictEqual(snap2[0].stepType, 'output');
assert.strictEqual(snap2[0].is_snapshot, true);
assert.strictEqual(snap2[0].content, '你好，世界');

// CC content_block_stop 逐块产出：thinking-only assistant
const thinkOnly = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_01',
    content: [{ type: 'thinking', thinking: 'The user said hi.' }],
  },
}), 'claude-code');
assert.strictEqual(thinkOnly.length, 1);
assert.strictEqual(thinkOnly[0].stepType, 'thinking');

// 紧随其后的 text-only assistant
const textOnly = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_01',
    content: [{ type: 'text', text: 'Hi! 有什么可以帮你的？' }],
  },
}), 'claude-code');
assert.strictEqual(textOnly.length, 1);
assert.strictEqual(textOnly[0].stepType, 'output');
assert.strictEqual(textOnly[0].content, 'Hi! 有什么可以帮你的？');

// streamlined_text（CC verbose 关闭时的精简输出）
const streamlined = parseAgentOutputLine(JSON.stringify({
  type: 'streamlined_text',
  text: '精简回复文本',
  session_id: 'sess-1',
}), 'claude-code');
assert.strictEqual(streamlined[0].stepType, 'output');
assert.strictEqual(streamlined[0].content, '精简回复文本');

// keep_alive / tool_progress 等 SDK 噪声
assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({ type: 'keep_alive' }), 'claude-code'), []);
assert.deepStrictEqual(parseAgentOutputLine(JSON.stringify({
  type: 'system', subtype: 'task_progress', task_id: 't1',
}), 'claude-code'), []);

const { formatAgentExitError } = require('../agent-output-parser');

// Codex refresh token 失效 → 简短中文提示
const codexAuthErr = formatAgentExitError(
  'Reading additional input from stdin...\n'
  + '\x1b[2m2026-07-10T09:06:36.121403Z\x1b[0m \x1b[31mERROR\x1b[0m codex_login::auth::manager: '
  + 'Failed to refresh token: 401 Unauthorized: {\n  "error": {\n'
  + '    "message": "Your refresh token has already been used to generate a new access token. Please try signing in again.",\n'
  + '    "code": "refresh_token_reused"\n  }\n}\n'
  + 'Failed to refresh token: Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.\n',
  '',
  1,
  'codex',
);
assert.ok(codexAuthErr.includes('refresh token 已被使用'));
assert.ok(codexAuthErr.includes('codex logout'));
assert.ok(!codexAuthErr.includes('Reading additional input'));

// token 过期
const expiredErr = formatAgentExitError(
  'ERROR rmcp::transport::worker: HTTP 401: "message": "Provided authentication token is expired. Please try signing in again.", "code": "token_expired"',
  '',
  1,
  'codex',
);
assert.ok(expiredErr.includes('访问令牌已过期'));

const { detectAgentExecutionFailure } = require('../agent-output-parser');
assert.strictEqual(
  detectAgentExecutionFailure(JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['resume failed'],
  })),
  'resume failed',
);

// result 无 errors 字段时，从 stdout 抽取 Claude OAuth 过期文案（画像挖掘失败现场）
const oauthStdout = [
  'Failed to authenticate: OAuth session expired and could not be refreshed',
  JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
].join('\n');
const oauthFail = detectAgentExecutionFailure(oauthStdout);
assert.ok(oauthFail.includes('登录已过期'), oauthFail);
assert.ok(oauthFail.includes('claude /login') || oauthFail.includes('绑路由'), oauthFail);

const oauthExit = formatAgentExitError('', oauthStdout, 1, 'claude-code');
assert.ok(oauthExit.includes('登录已过期'), oauthExit);

const nullExitMsg = formatAgentExitError('', '', null, 'claude-code', 'SIGTERM');
assert.ok(nullExitMsg.includes('SIGTERM'));

const cursorAuthErr = formatAgentExitError(
  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
  '',
  1,
  'cursor',
);
assert.ok(cursorAuthErr.includes('agent login'));
assert.ok(cursorAuthErr.includes('CURSOR_API_KEY'));
assert.ok(cursorAuthErr.includes('不是同一套') || cursorAuthErr.includes('Agent CLI'));

const { parseClaudeSyncStdout } = require('../agent-output-parser');
const syncSample = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'The user wants a poem.秋夜独坐\n\n一帘秋雨叩窗棂。',
  session_id: '3761b2cc-2d0f-4922-bd87-53a9ef114262',
});
const syncParsed = parseClaudeSyncStdout(syncSample);
assert.strictEqual(syncParsed.sessionId, '3761b2cc-2d0f-4922-bd87-53a9ef114262');
assert.ok(syncParsed.steps.some(s => s.stepType === 'output' && s.content.includes('秋夜独坐')));
assert.ok(!syncParsed.steps.some(s => String(s.content).includes('"type":"result"')));
assert.ok(summarizeAgentStdout(syncSample, 'claude-code').includes('秋夜独坐'));

// stream-json result 信封：只展示正文，绝不把整包 JSON 当 output
const resultState = { lastOutput: '' };
const resultEnv = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 6705,
  duration_api_ms: 4475,
  result: '我在 /Users/ully/githubprojects 目录下工作。',
  total_cost_usd: 0.001005,
  usage: { input_tokens: 0, output_tokens: 67 },
  session_id: 'sess-result-1',
};
const resultSteps = parseAgentOutputLine(JSON.stringify(resultEnv), 'claude-code', resultState);
assert.strictEqual(resultSteps.length, 1);
assert.strictEqual(resultSteps[0].stepType, 'output');
assert.strictEqual(resultSteps[0].content, '我在 /Users/ully/githubprojects 目录下工作。');
assert.ok(!String(resultSteps[0].content).includes('"type":"result"'));
assert.ok(!String(resultSteps[0].content).includes('duration_ms'));

// 与前序流式正文重复的 result → 吞掉，避免气泡里再贴一整包 JSON
resultState.lastOutput = '我在 /Users/ully/githubprojects 目录下工作。';
assert.deepStrictEqual(
  parseAgentOutputLine(JSON.stringify(resultEnv), 'claude-code', resultState),
  [],
);

// 不完整 result JSON 行不得当纯文本泄漏
assert.deepStrictEqual(
  parseAgentOutputLine('{"type":"result","subtype":"success","result":"partial', 'claude-code'),
  [],
);

// tool_result 不得当成 AI 回复 output
const toolState = { blockTypes: new Map(), blockTexts: new Map(), toolNamesById: new Map(), emittedToolUseIds: new Set(), streaming: false };
const bashCall = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [{
      type: 'tool_use',
      id: 'tu_bash_1',
      name: 'Bash',
      input: { command: 'ls /tmp', description: 'List tmp' },
    }],
  },
}), 'claude-code', toolState);
assert.strictEqual(bashCall[0]?.stepType, 'tool_call');
assert.strictEqual(bashCall[0]?.tool_name, 'Bash');

const bashResult = parseAgentOutputLine(JSON.stringify({
  type: 'user',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: 'tu_bash_1',
      content: 'a\nb\nc',
      is_error: false,
    }],
  },
}), 'claude-code', toolState);
assert.strictEqual(bashResult.length, 1);
assert.strictEqual(bashResult[0].stepType, 'tool_result');
assert.strictEqual(bashResult[0].tool_name, 'Bash');
assert.strictEqual(bashResult[0].content, 'a\nb\nc');

// Read PNG：tool_result 仅含 image 块时不得丢弃（否则 UI 补「未收到结果」）
const imgState = {
  blockTypes: new Map(), blockTexts: new Map(),
  toolNamesById: new Map([['tu_read_img', 'Read']]),
  emittedToolUseIds: new Set(['tu_read_img']),
  streaming: false,
};
const imgResult = parseAgentOutputLine(JSON.stringify({
  type: 'user',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: 'tu_read_img',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      }],
      is_error: false,
    }],
  },
}), 'claude-code', imgState);
assert.strictEqual(imgResult.length, 1);
assert.strictEqual(imgResult[0].stepType, 'tool_result');
assert.strictEqual(imgResult[0].tool_name, 'Read');
assert.strictEqual(imgResult[0].tool_use_id, 'tu_read_img');
assert.ok(/图片|image\/png/i.test(imgResult[0].content), `expected image placeholder, got: ${imgResult[0].content}`);
assert.strictEqual(imgResult[0].is_error, false);

// 完全空的 tool_result 也应发出占位，保证配对
const emptyResult = parseAgentOutputLine(JSON.stringify({
  type: 'user',
  message: {
    content: [{
      type: 'tool_result',
      tool_use_id: 'tu_read_img',
      content: [],
      is_error: false,
    }],
  },
}), 'claude-code', imgState);
assert.strictEqual(emptyResult.length, 1);
assert.strictEqual(emptyResult[0].content, '(无输出)');

// streaming 期间仍提取 tool_use（不再整包丢弃）
const streamToolState = {
  blockTypes: new Map(), blockTexts: new Map(), toolNamesById: new Map(),
  emittedToolUseIds: new Set(), streaming: true, lastThinking: '', lastOutput: '',
};
const streamTool = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: 'ignore during stream' },
      { type: 'tool_use', id: 'tu_w', name: 'Write', input: { file_path: 'a.txt', content: 'x' } },
    ],
  },
}), 'claude-code', streamToolState);
assert.strictEqual(streamTool.length, 1);
assert.strictEqual(streamTool[0].stepType, 'tool_call');
assert.strictEqual(streamTool[0].tool_name, 'Write');

// stream_event content_block_stop 产出 tool_call
const seState = {
  blockTypes: new Map(), blockTexts: new Map(), toolNamesById: new Map(),
  toolBlockMeta: new Map(), emittedToolUseIds: new Set(), streaming: true,
};
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tu_se', name: 'Bash', input: {} },
  },
}), 'claude-code', seState);
parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' },
  },
}), 'claude-code', seState);
const seStop = parseAgentOutputLine(JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_stop', index: 0 },
}), 'claude-code', seState);
assert.strictEqual(seStop[0]?.stepType, 'tool_call');
assert.strictEqual(seStop[0]?.tool_name, 'Bash');
assert.ok(seStop[0]?.content.includes('pwd'));

// Codex command_execution → 与 Claude Bash 同构 tool_call / tool_result
const codexToolState = { emittedToolUseIds: new Set(), toolNamesById: new Map() };
const cmdStart = parseAgentOutputLine(JSON.stringify({
  type: 'item.started',
  item: {
    id: 'item_cmd',
    type: 'command_execution',
    command: 'bash -lc ls',
    aggregated_output: '',
    status: 'in_progress',
  },
}), 'codex', codexToolState);
assert.strictEqual(cmdStart[0]?.stepType, 'tool_call');
assert.strictEqual(cmdStart[0]?.tool_name, 'Bash');
assert.ok(cmdStart[0]?.content.includes('bash -lc ls'));

const cmdDone = parseAgentOutputLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_cmd',
    type: 'command_execution',
    command: 'bash -lc ls',
    aggregated_output: 'a\nb\n',
    exit_code: 0,
    status: 'completed',
  },
}), 'codex', codexToolState);
assert.strictEqual(cmdDone.length, 1);
assert.strictEqual(cmdDone[0].stepType, 'tool_result');
assert.ok(cmdDone[0].content.includes('a') && cmdDone[0].content.includes('b'));
assert.strictEqual(cmdDone[0].tool_use_id, 'item_cmd');

// Codex mcp_tool_call → mcp__server__tool
const mcpDone = parseAgentOutputLine(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_mcp',
    type: 'mcp_tool_call',
    server: 'docs',
    tool: 'search',
    arguments: { q: 'exec' },
    result: { content: [{ type: 'text', text: 'Found 3' }] },
    status: 'completed',
  },
}), 'codex', { emittedToolUseIds: new Set(), toolNamesById: new Map() });
assert.ok(mcpDone.some(s => s.stepType === 'tool_call' && s.tool_name === 'mcp__docs__search'));
assert.ok(mcpDone.some(s => s.stepType === 'tool_result' && s.content.includes('Found 3')));

// Cursor transcript → 同构步骤
const cursorSteps = parseAgentOutputLine(JSON.stringify({
  role: 'assistant',
  message: {
    content: [
      { type: 'thinking', thinking: 'Need to list files' },
      { type: 'tool_use', id: 'cu_1', name: 'Bash', input: { command: 'ls' } },
      { type: 'text', text: 'Listing…' },
    ],
  },
}), 'cursor', { emittedToolUseIds: new Set(), toolNamesById: new Map() });
assert.ok(cursorSteps.some(s => s.stepType === 'thinking'));
assert.ok(cursorSteps.some(s => s.stepType === 'tool_call' && s.tool_name === 'Bash'));
assert.ok(cursorSteps.some(s => s.stepType === 'output' && s.content.includes('Listing')));

// Kimi stream-json → thinking / output / tool_call / tool_result（与其它 Agent 同构）
const kimiState = { emittedToolUseIds: new Set(), toolNamesById: new Map() };
const kimiThinkTool = parseAgentOutputLine(JSON.stringify({
  role: 'assistant',
  content: 'The user wants me to read a file and count its lines. Let me use Bash.',
  tool_calls: [{
    type: 'function',
    id: 'call_kimi_1',
    function: { name: 'Bash', arguments: '{"command":"wc -l /tmp/x"}' },
  }],
}), 'kimi-code', kimiState);
assert.ok(kimiThinkTool.some(s => s.stepType === 'thinking' && /The user wants/.test(s.content)));
assert.ok(kimiThinkTool.some(s => s.stepType === 'tool_call' && s.tool_name === 'Bash'));
assert.ok(kimiThinkTool.some(s => s.stepType === 'tool_call' && s.content.includes('wc -l')));

const kimiToolRes = parseAgentOutputLine(JSON.stringify({
  role: 'tool',
  tool_call_id: 'call_kimi_1',
  content: '2 /tmp/x\n',
}), 'kimi-code', kimiState);
assert.equal(kimiToolRes.length, 1);
assert.equal(kimiToolRes[0].stepType, 'tool_result');
assert.equal(kimiToolRes[0].tool_name, 'Bash');
assert.ok(kimiToolRes[0].content.includes('2 /tmp/x'));

const kimiGlued = parseAgentOutputLine(JSON.stringify({
  role: 'assistant',
  content: 'The user is asking a simple math question: what is 2+2? They want just the number answer.4',
}), 'kimi-code', { emittedToolUseIds: new Set(), toolNamesById: new Map() });
assert.ok(kimiGlued.some(s => s.stepType === 'thinking'));
assert.ok(kimiGlued.some(s => s.stepType === 'output' && s.content.trim() === '4'));

const kimiMd = parseAgentOutputLine(JSON.stringify({
  role: 'assistant',
  content: 'The file has 2 lines.The file `/tmp/x` has **2 lines**.',
}), 'kimi-code', { emittedToolUseIds: new Set(), toolNamesById: new Map() });
assert.ok(kimiMd.some(s => s.stepType === 'output' && s.content.includes('**2 lines**')));

const kimiMeta = parseAgentOutputLine(JSON.stringify({
  role: 'meta',
  type: 'session.resume_hint',
  session_id: 'session_abc',
  content: 'To resume…',
}), 'kimi-code');
assert.deepStrictEqual(kimiMeta, []);

// Cursor stream-json tool_call started/completed → Bash tool_call / tool_result
const cursorTcState = { emittedToolUseIds: new Set(), toolNamesById: new Map() };
const cursorStarted = parseAgentOutputLine(JSON.stringify({
  type: 'tool_call',
  subtype: 'started',
  call_id: 'call-abc\nfc_extra',
  tool_call: {
    shellToolCall: {
      args: {
        command: 'curl -s "https://example.com" | head -c 100',
        workingDirectory: '',
        timeout: 30000,
      },
    },
  },
  session_id: 'sess-1',
}), 'cursor', cursorTcState);
assert.equal(cursorStarted.length, 1);
assert.equal(cursorStarted[0].stepType, 'tool_call');
assert.equal(cursorStarted[0].tool_name, 'Bash');
assert.ok(cursorStarted[0].content.includes('curl -s'));
assert.equal(cursorStarted[0].tool_use_id, 'call-abc');

const cursorDone = parseAgentOutputLine(JSON.stringify({
  type: 'tool_call',
  subtype: 'completed',
  call_id: 'call-abc',
  tool_call: {
    shellToolCall: {
      args: { command: 'curl -s "https://example.com" | head -c 100' },
      result: {
        success: { stdout: '{"ok":true}\n', stderr: '', exitCode: 0 },
      },
    },
  },
}), 'cursor', cursorTcState);
assert.equal(cursorDone.length, 1);
assert.equal(cursorDone[0].stepType, 'tool_result');
assert.equal(cursorDone[0].tool_name, 'Bash');
assert.ok(cursorDone[0].content.includes('{"ok":true}'));

const cursorRead = parseAgentOutputLine(JSON.stringify({
  type: 'tool_call',
  subtype: 'started',
  call_id: 'toolu_read_1',
  tool_call: { readToolCall: { args: { path: 'README.md' } } },
}), 'cursor', { emittedToolUseIds: new Set(), toolNamesById: new Map() });
assert.ok(cursorRead.some(s => s.stepType === 'tool_call' && s.tool_name === 'Read'));

const cursorAssist = parseAgentOutputLine(JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'I will run curl next.' }],
  },
  session_id: 'sess-1',
}), 'cursor');
assert.ok(cursorAssist.some(s => s.stepType === 'output' && s.content.includes('curl')));

console.log('agent-output-parser.test.js OK');
