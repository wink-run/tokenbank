/**
 * 测试executor → taskToResponse → Gateway response → 云端提取
 * 模拟工具调用后的实际stdout
 */

const path = require('path');

// 加载实际的parser
const parserPath = path.join(__dirname, 'client/electron/agent-output-parser.js');
const { summarizeAgentStdout } = require(parserPath);

// 加载taskToResponse逻辑（简化版）
function taskToResponse(task) {
  const text = task?.result?.summary || task?.result?.output || task?.error || '';
  return {
    id: task.id,
    status: 'completed',
    output: text 
      ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: String(text).slice(0, 20000) }] }]
      : [],
    artifacts: task?.result?.artifacts || []
  };
}

// 模拟云端提取逻辑
function extractOutputFromResponse(response) {
  let output_text = '';
  const output_list = response.output || [];
  if (output_list.length > 0) {
    const first_msg = output_list[0];
    if (first_msg && typeof first_msg === 'object') {
      const content = first_msg.content || [];
      for (const item of content) {
        if (item && item.type === 'output_text') {
          output_text = String(item.text || '');
          break;
        }
      }
    }
  }
  return output_text;
}

console.log('=== 测试场景 ===\n');

// 场景1: Claude Code流式JSON，工具调用后有output
const stdout1 = `
{"type":"agent_message","message_id":"msg_1","agent_event":"start_turn"}
{"type":"tool_call","tool_name":"execute_command","tool_params":"{\\"command\\":\\"generate_image.sh\\"}","agent_event":"continue_turn"}
{"type":"tool_result","tool_name":"execute_command","output":"Image generated: output.png\\nPoem placed in top-right corner.","agent_event":"continue_turn"}
{"type":"agent_message","content":"图片已生成：output.png\\n\\n诗已放置在右上角。","agent_event":"output_delta"}
{"type":"agent_message","message_id":"msg_1","agent_event":"end_turn"}
`.trim();

console.log('场景1: 流式JSON with output_delta');
console.log('Raw stdout length:', stdout1.length);
const summary1 = summarizeAgentStdout(stdout1, 'claude-code');
console.log('Summary:', summary1 ? `"${summary1.slice(0, 100)}..."` : '(empty)');

const task1 = {
  id: 'task_1',
  status: 'completed',
  result: {
    output: stdout1,
    summary: summary1,
    artifacts: []
  }
};

const response1 = taskToResponse(task1);
console.log('Response output array length:', response1.output.length);
const extracted1 = extractOutputFromResponse(response1);
console.log('Extracted output:', extracted1 ? `"${extracted1.slice(0, 100)}..."` : '(empty)');
console.log('');

// 场景2: 只有工具调用，没有明确的output delta
const stdout2 = `
{"type":"agent_message","message_id":"msg_2","agent_event":"start_turn"}
{"type":"tool_call","tool_name":"execute_command","tool_params":"{\\"command\\":\\"generate_image.sh\\"}","agent_event":"continue_turn"}
{"type":"tool_result","tool_name":"execute_command","output":"Done","agent_event":"continue_turn"}
{"type":"agent_message","message_id":"msg_2","agent_event":"end_turn"}
`.trim();

console.log('场景2: 只有工具调用，无output_delta');
console.log('Raw stdout length:', stdout2.length);
const summary2 = summarizeAgentStdout(stdout2, 'claude-code');
console.log('Summary:', summary2 ? `"${summary2.slice(0, 100)}..."` : '(empty)');

const task2 = {
  id: 'task_2',
  status: 'completed',
  result: {
    output: stdout2,
    summary: summary2,
    artifacts: []
  }
};

const response2 = taskToResponse(task2);
console.log('Response output array length:', response2.output.length);
const extracted2 = extractOutputFromResponse(response2);
console.log('Extracted output:', extracted2 ? `"${extracted2.slice(0, 100)}..."` : '(empty)');
console.log('');

// 场景3: 同步模式with final output
const stdout3 = `
{
  "message_id": "msg_3",
  "steps": [
    {"stepType": "tool_call", "tool_name": "execute_command", "content": "generate_image.sh"},
    {"stepType": "tool_result", "tool_name": "execute_command", "content": "Done"},
    {"stepType": "output", "content": "图片已生成，诗已放置在右上角。"}
  ],
  "sessionId": "session_3"
}
`.trim();

console.log('场景3: 同步JSON with output step');
console.log('Raw stdout length:', stdout3.length);
const summary3 = summarizeAgentStdout(stdout3, 'claude-code');
console.log('Summary:', summary3 ? `"${summary3.slice(0, 100)}..."` : '(empty)');

const task3 = {
  id: 'task_3',
  status: 'completed',
  result: {
    output: stdout3,
    summary: summary3,
    artifacts: []
  }
};

const response3 = taskToResponse(task3);
console.log('Response output array length:', response3.output.length);
const extracted3 = extractOutputFromResponse(response3);
console.log('Extracted output:', extracted3 ? `"${extracted3.slice(0, 100)}..."` : '(empty)');
console.log('');

console.log('=== 结论 ===');
console.log('场景1结果:', extracted1 ? '✓ 有输出' : '✗ 无输出');
console.log('场景2结果:', extracted2 ? '✓ 有输出' : '✗ 无输出 (关键问题!)');
console.log('场景3结果:', extracted3 ? '✓ 有输出' : '✗ 无输出');
