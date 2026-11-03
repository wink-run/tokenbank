'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAgentRoute, inputText, harnessIdFromBody, taskToResponse } = require('../agent-http');

describe('agent-http', () => {
  test('路径和模型补全分开', () => {
    assert.equal(parseAgentRoute('POST', '/v1/responses'), null);
    assert.deepEqual(parseAgentRoute('GET', '/v1/agent/harnesses'), { op: 'list' });
    assert.deepEqual(parseAgentRoute('POST', '/v1/agent/responses'), { op: 'create' });
    assert.deepEqual(parseAgentRoute('GET', '/v1/agent/responses/task_1'), { op: 'get', id: 'task_1' });
    assert.deepEqual(parseAgentRoute('POST', '/v1/agent/responses/task_1/cancel'), { op: 'cancel', id: 'task_1' });
  });

  test('从 Responses 体里取出任务文本和 harness', () => {
    assert.equal(inputText('  看一下测试  '), '看一下测试');
    assert.equal(inputText([{ text: '第一段' }, { content: '第二段' }]), '第一段\n第二段');
    assert.equal(harnessIdFromBody({ metadata: { harness_id: 'pi' } }), 'pi');
  });

  test('任务状态映射成 response', () => {
    const body = taskToResponse({
      id: 't1',
      agent_id: 'pi',
      status: 'completed',
      created_at: 1000,
      completed_at: 4000,
      result: { summary: '好了' },
    });
    assert.equal(body.status, 'completed');
    assert.equal(body.metadata.harness_id, 'pi');
    assert.equal(body.output[0].content[0].text, '好了');
    assert.equal(body.usage.duration_ms, 3000);
  });
});
