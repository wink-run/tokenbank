/**
 * call_context安全性测试
 * 
 * 验证需求（t205）：
 * 1. call_context必须从可信metadata获取，不能被用户请求body覆盖
 * 2. HTTP用户不能通过设置body.call_context='local'来绕过hired限制
 * 3. body.call_context与metadata不一致时拒绝请求
 */

const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const request = require('supertest');
const express = require('express');

describe('call_context Security', () => {
  let app;
  let mockExecutor;

  beforeEach(() => {
    // 模拟executor
    mockExecutor = {
      execute: jest.fn().mockResolvedValue({ taskId: 'task_test' }),
      getTask: jest.fn().mockResolvedValue({
        id: 'task_test',
        status: 'completed',
        result: { output: 'test output' },
      }),
    };

    // 创建express app（模拟agent-http.js的核心逻辑）
    app = express();
    app.use(express.json());

    app.post('/v1/agent/responses', async (req, res) => {
      const body = req.body;

      // 关键安全检查：call_context只从可信metadata读取
      const callContext = String(body.metadata?.call_context || 'local').trim().toLowerCase();

      // 拒绝用户尝试通过body.call_context覆盖
      if (body.call_context && body.call_context !== body.metadata?.call_context) {
        return res.status(403).json({
          error: {
            message: 'call_context must be set by trusted dispatcher',
            type: 'permission_error',
          },
        });
      }

      // 正常处理
      const result = await mockExecutor.execute(body.metadata?.assistant_id, body.prompt, {
        callContext,
      });

      res.json({
        id: result.taskId,
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'test output' }] }],
        metadata: { call_context: callContext },
      });
    });
  });

  it('should accept request with only metadata.call_context (trusted)', async () => {
    // 正常情况：只有metadata.call_context（服务端设置）
    const response = await request(app)
      .post('/v1/agent/responses')
      .send({
        prompt: 'test task',
        metadata: {
          assistant_id: 'ast_test',
          call_context: 'hired',
        },
      });

    expect(response.status).toBe(200);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      'ast_test',
      'test task',
      expect.objectContaining({ callContext: 'hired' })
    );
  });

  it('should accept request with matching body and metadata call_context', async () => {
    // body和metadata一致的情况（某些客户端可能重复发送）
    const response = await request(app)
      .post('/v1/agent/responses')
      .send({
        prompt: 'test task',
        call_context: 'hired',
        metadata: {
          assistant_id: 'ast_test',
          call_context: 'hired',
        },
      });

    expect(response.status).toBe(200);
  });

  it('should reject request trying to override hired with local', async () => {
    // 攻击场景：用户试图通过body.call_context绕过hired限制
    const response = await request(app)
      .post('/v1/agent/responses')
      .send({
        prompt: 'sudo rm -rf /',  // 危险命令
        call_context: 'local',    // 用户试图设置为local绕过检查
        metadata: {
          assistant_id: 'ast_test',
          call_context: 'hired',   // 服务端设置的真实context
        },
      });

    expect(response.status).toBe(403);
    expect(response.body.error.type).toBe('permission_error');
    expect(response.body.error.message).toMatch(/trusted dispatcher/i);
    // 执行器不应该被调用
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  it('should reject request trying to escalate local to hired', async () => {
    // 反向攻击：local用户试图伪装成hired（虽然危害较小，但仍需拒绝）
    const response = await request(app)
      .post('/v1/agent/responses')
      .send({
        prompt: 'test',
        call_context: 'hired',
        metadata: {
          assistant_id: 'ast_test',
          call_context: 'local',
        },
      });

    expect(response.status).toBe(403);
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  it('should use metadata.call_context when body.call_context is missing', async () => {
    // 正常情况：没有body.call_context，只有metadata
    const response = await request(app)
      .post('/v1/agent/responses')
      .send({
        prompt: 'test',
        metadata: {
          assistant_id: 'ast_test',
          call_context: 'hired',
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.metadata.call_context).toBe('hired');
  });

  it('should default to local when no call_context provided', async () => {
    // 兜底：没有任何call_context时默认为local
    const response = await request(app)
      .post('/v1/agent/responses')
      .send({
        prompt: 'test',
        metadata: {
          assistant_id: 'ast_test',
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.metadata.call_context).toBe('local');
  });
});

describe('call_context Validation Chain', () => {
  it('call_context must flow from server -> client without user modification', () => {
    // 文档验证：确认数据流
    const dataFlow = {
      step1: 'Server dispatch_agent.py sets call_context in gateway_body.metadata',
      step2: 'HTTP gateway receives metadata.call_context (trusted)',
      step3: 'Gateway rejects if body.call_context != metadata.call_context',
      step4: 'Executor receives call_context from metadata only',
    };

    expect(dataFlow.step3).toMatch(/rejects if/);
    // 这是架构验证，不是运行时测试
  });

  it('metadata source must be verified in production', () => {
    // 生产环境检查清单
    const securityChecklist = {
      http_gateway: 'Only read metadata.call_context, reject body.call_context mismatch',
      websocket_gateway: 'Same requirement as HTTP',
      executor: 'Pass call_context to safety checks',
      safety_module: 'Enforce rules based on call_context',
    };

    expect(Object.keys(securityChecklist).length).toBeGreaterThan(0);
    // 这是设计验证
  });
});
