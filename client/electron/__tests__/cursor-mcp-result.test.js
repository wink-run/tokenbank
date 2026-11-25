'use strict';
// Cursor 的 MCP 工具结果：content 是对象列表，要取出文字，不能显示成 [object Object]
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAgentOutputLine } = require('../agent-output-parser');

function resultOf(content) {
  const line = JSON.stringify({
    type: 'tool_call', subtype: 'completed', call_id: 'c1',
    tool_call: { mcpToolCall: { args: { name: 'tokenbank-tb_list_agents', providerIdentifier: 'tokenbank', toolName: 'tb_list_agents', args: {} }, result: { success: { content, isError: false } } } },
  });
  const steps = [].concat(parseAgentOutputLine(line, 'cursor', {}) || []);
  return steps.find((s) => s && s.stepType === 'tool_result');
}

test('Cursor 包过一层的 [{ text: { text } }] 取出文字', () => {
  const r = resultOf([{ text: { text: '- claude-code: Claude Code' } }, { text: { text: '- codex: Codex' } }]);
  assert.ok(r, '有 tool_result');
  assert.equal(r.content, '- claude-code: Claude Code\n- codex: Codex');
  assert.ok(!String(r.content).includes('[object Object]'));
});

test('MCP 原样的 [{ type: "text", text }] 也行', () => {
  const r = resultOf([{ type: 'text', text: '共 3 个模型' }]);
  assert.equal(r.content, '共 3 个模型');
});
