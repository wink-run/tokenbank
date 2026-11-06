'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

describe('agent-gateway-loopback', () => {
  let testServer;
  let testPort;

  before(async () => {
    // 创建一个模拟的gateway服务器，用于测试loopback调用
    return new Promise((resolve) => {
      testServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          const isStream = parsed.stream;
          const harnessId = parsed.metadata?.harness_id;

          // 验证认证
          const auth = req.headers['authorization'] || '';
          if (!auth.startsWith('Bearer ')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
            return;
          }

          if (isStream) {
            // 流式响应：模拟SSE事件
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            });

            // 发送created事件
            res.write('event: response.created\n');
            res.write('data: {"id":"task_test","status":"in_progress"}\n\n');

            // 发送delta事件
            res.write('event: response.output_text.delta\n');
            res.write('data: {"delta":"Hello "}\n\n');

            res.write('event: response.output_text.delta\n');
            res.write('data: {"delta":"World!"}\n\n');

            // 发送completed事件（包含完整output）
            const completeData = {
              id: 'task_test',
              status: 'completed',
              metadata: { harness_id: harnessId },
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Hello World!' }],
                },
              ],
              usage: { duration_ms: 1000 },
            };
            res.write('event: response.completed\n');
            res.write(`data: ${JSON.stringify(completeData)}\n\n`);
            res.end();
          } else {
            // 非流式响应
            const response = {
              id: 'task_test',
              status: 'completed',
              metadata: { harness_id: harnessId },
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Non-stream response' }],
                },
              ],
              usage: { duration_ms: 500 },
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          }
        });
      });

      testServer.listen(0, '127.0.0.1', () => {
        testPort = testServer.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    if (testServer) {
      return new Promise((resolve) => {
        testServer.close(resolve);
      });
    }
  });

  test('SSE流式响应解析正确，completed事件包含output', async () => {
    const events = [];
    
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        input: 'test',
        metadata: { harness_id: 'test-agent' },
        stream: true,
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/v1/agent/responses',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-key',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';

          for (const block of blocks) {
            if (!block.trim()) continue;
            
            let event = '';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) {
                event = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                data = line.slice(6);
              }
            }

            if (event && data) {
              try {
                events.push({ event, data: JSON.parse(data) });
              } catch (e) {
                reject(new Error(`SSE parse error: ${e.message}`));
              }
            }
          }
        });

        res.on('end', () => {
          try {
            // 验证事件顺序和内容
            assert.equal(events.length, 4, '应收到4个SSE事件');
            
            assert.equal(events[0].event, 'response.created');
            assert.equal(events[0].data.status, 'in_progress');
            
            assert.equal(events[1].event, 'response.output_text.delta');
            assert.equal(events[1].data.delta, 'Hello ');
            
            assert.equal(events[2].event, 'response.output_text.delta');
            assert.equal(events[2].data.delta, 'World!');
            
            // 最重要：completed事件必须包含完整的output
            assert.equal(events[3].event, 'response.completed');
            assert.equal(events[3].data.status, 'completed');
            assert.ok(Array.isArray(events[3].data.output), 'completed事件应包含output数组');
            assert.equal(events[3].data.output.length, 1);
            
            const outputContent = events[3].data.output[0].content[0];
            assert.equal(outputContent.type, 'output_text');
            assert.equal(outputContent.text, 'Hello World!', 'completed事件output文本应完整');

            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });

  test('非流式响应包含完整output', async () => {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        input: 'test',
        metadata: { harness_id: 'test-agent' },
        stream: false,
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/v1/agent/responses',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer test-key',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let buffer = '';
        res.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
        res.on('end', () => {
          try {
            const response = JSON.parse(buffer);
            
            assert.equal(response.status, 'completed');
            assert.ok(Array.isArray(response.output), '响应应包含output数组');
            assert.equal(response.output.length, 1);
            
            const outputContent = response.output[0].content[0];
            assert.equal(outputContent.type, 'output_text');
            assert.equal(outputContent.text, 'Non-stream response', '非流式响应output文本应完整');

            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });

  test('缺少Authorization应返回401', async () => {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        input: 'test',
        metadata: { harness_id: 'test-agent' },
      });

      const req = http.request({
        hostname: '127.0.0.1',
        port: testPort,
        path: '/v1/agent/responses',
        method: 'POST',
        headers: {
          // 无Authorization头
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        assert.equal(res.statusCode, 401, '缺少Authorization应返回401');
        
        let buffer = '';
        res.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
        res.on('end', () => {
          try {
            const response = JSON.parse(buffer);
            assert.equal(response.error.message, 'invalid api key');
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  });
});
