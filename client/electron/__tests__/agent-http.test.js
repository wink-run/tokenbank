'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { parseAgentRoute, inputText, harnessIdFromBody, taskToResponse, outputStreamEvent, buildAgentRouteLog, handle } = require('../agent-http');

function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    status: 0,
    body: '',
    writeHead(status) { this.status = status; this.headersSent = true; },
    end(payload) { this.body = payload || ''; this.writableEnded = true; },
  };
}

function fakeReq() {
  const req = new EventEmitter();
  req.headers = { authorization: 'Bearer bad' };
  return req;
}

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

  test('发起任务可以记成路由明细', () => {
    const ok = buildAgentRouteLog({
      ts: 1000,
      latencyMs: 250,
      harnessId: 'pi',
      prompt: '  看一下登录页的报错  ',
      ok: true,
    });
    assert.equal(ok.kind, 'agent');
    assert.equal(ok.status, 'ok');
    assert.equal(ok.ts, 1000);
    assert.equal(ok.model, 'pi');
    assert.equal(ok.requested_model, 'pi');
    assert.equal(ok.prompt_preview, '看一下登录页的报错');
    assert.equal(ok.latency_ms, 250);
    assert.equal(ok.place, 'local');
    assert.equal(ok.error, undefined);

    const directCommunity = buildAgentRouteLog({ harnessId: 'community:pi@ada', ok: true });
    assert.equal(directCommunity.place, 'local');

    const hired = buildAgentRouteLog({ harnessId: 'pi', callContext: 'hired', ok: true });
    assert.equal(hired.place, 'local');
    assert.equal(hired.call_context, 'hired');

    const ws = buildAgentRouteLog({ harnessId: 'assistant:poem', channel: 'ws', ok: true });
    assert.equal(ws.place, 'remote');

    const ignored = buildAgentRouteLog({ harnessId: 'pi', callContext: 'nope', ok: true });
    assert.equal(ignored.place, 'local');
    assert.equal(ignored.call_context, undefined);

    const bad = buildAgentRouteLog({ ok: false });
    assert.equal(bad.status, 'error');
    assert.equal(bad.model, 'agent');
    assert.equal(bad.error, 'agent_error');
  });

  test('密钥不对的发起任务会记一条失败明细', async () => {
    const calls = [];
    const res = fakeRes();
    await handle(fakeReq(), res, {
      method: 'POST',
      cleanPath: '/v1/agent/responses',
      knownKey: () => false,
      onCall: (info) => calls.push(info),
    });
    assert.equal(res.status, 401);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ok, false);
    assert.equal(calls[0].error, 'invalid api key');
    assert.equal(buildAgentRouteLog(calls[0]).status, 'error');
  });

  test('查询任务状态不写路由明细', async () => {
    const calls = [];
    await handle(fakeReq(), fakeRes(), {
      method: 'GET',
      cleanPath: '/v1/agent/responses/task_1',
      knownKey: () => false,
      onCall: (info) => calls.push(info),
    });
    assert.equal(calls.length, 0);
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
});
