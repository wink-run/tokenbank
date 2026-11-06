'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { parseAgentRoute, inputText, harnessIdFromBody, taskToResponse, outputStreamEvent, handle } = require('../agent-http');

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

  test('stream 开关：快照只推新增片段', () => {
    const first = outputStreamEvent('', { stepType: 'output', content: '你好' });
    assert.equal(first.event, 'response.output_text.delta');
    assert.equal(first.data.delta, '你好');
    const more = outputStreamEvent(first.prev, { stepType: 'output', content: '你好，世界' });
    assert.equal(more.data.delta, '，世界');
    const same = outputStreamEvent(more.prev, { stepType: 'output', content: '你好，世界' });
    assert.equal(same.event, null);
    const replaced = outputStreamEvent(more.prev, { stepType: 'output', content: '另一段' });
    assert.equal(replaced.event, 'response.output_text.snapshot');
    assert.equal(replaced.data.text, '另一段');
  });

  test('WebSocket已认证时无需Authorization头', async () => {
    // 模拟经WebSocket转发的请求：无Authorization头，但提供knownKey
    const mockReq = Readable.from([Buffer.from(JSON.stringify({ input: 'test', metadata: { harness_id: 'pi' } }))]);
    mockReq.method = 'POST';
    mockReq.url = '/v1/agent/responses';
    mockReq.headers = {}; // 无 Authorization

    let statusCode = null;
    let responseBody = null;
    const mockRes = {
      writeHead(status) { statusCode = status; },
      write(chunk) { responseBody = chunk; },
      end(chunk) { if (chunk) responseBody = chunk; },
    };

    // knownKey: () => true 表示WebSocket已认证，应允许通过
    const handled = await handle(mockReq, mockRes, {
      method: 'POST',
      cleanPath: '/v1/agent/responses',
      knownKey: () => true,
    });

    // 应该被处理（不是401），实际执行会失败因为没有真正的executor，但不应该在鉴权步骤被拒绝
    assert.equal(handled, true);
    // 如果是401，说明鉴权逻辑有问题
    assert.notEqual(statusCode, 401, 'WebSocket已认证请求不应返回401');
  });

  test('无Authorization且无knownKey时应401', async () => {
    const mockReq = Readable.from([Buffer.from(JSON.stringify({ input: 'test', metadata: { harness_id: 'pi' } }))]);
    mockReq.method = 'POST';
    mockReq.url = '/v1/agent/responses';
    mockReq.headers = {}; // 无 Authorization

    let statusCode = null;
    let responseBody = null;
    const mockRes = {
      writeHead(status) { statusCode = status; },
      write() {},
      end(chunk) { if (chunk) responseBody = chunk; },
    };

    // 无knownKey，应严格检查密钥
    const handled = await handle(mockReq, mockRes, {
      method: 'POST',
      cleanPath: '/v1/agent/responses',
    });

    assert.equal(handled, true);
    assert.equal(statusCode, 401);
    const body = JSON.parse(responseBody);
    assert.equal(body.error.message, 'invalid api key');
  });
});
