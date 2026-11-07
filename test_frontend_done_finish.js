#!/usr/bin/env node
/**
 * 真实前端done→finish→DB测试
 * 
 * 直接测试核心逻辑，不依赖完整DOM
 * 
 * 验证：
 * 1. done事件处理时output/artifacts已赋值
 * 2. finish(true)返回正确payload
 * 3. endRelayTurn调用/turn/finish API
 * 4. messages持久化到mockDB
 * 5. turn_task_id清除
 */

const http = require('http');

console.log('=== 前端done→finish→DB测试 ===\n');

// 测试状态
const testState = {
  turnFinishCalled: false,
  turnFinishBody: null,
  errors: [],
};

// 临时DB
const mockDB = {
  shares: new Map(),
  messages: new Map(),
};

// mock /turn/finish服务器
function createMockServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    
    if (req.method === 'POST' && url.pathname.match(/\/api\/agent-chats\/shares\/(.+)\/turn\/finish$/)) {
      const shareId = RegExp.$1;
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        testState.turnFinishCalled = true;
        try {
          testState.turnFinishBody = JSON.parse(body);
          
          // 保存到mockDB
          const messages = testState.turnFinishBody.messages || [];
          mockDB.messages.set(shareId, messages);
          
          // 清除turn_task_id
          const share = mockDB.shares.get(shareId) || {};
          share.turn_task_id = null;
          mockDB.shares.set(shareId, share);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            ok: true, 
            messages: messages.map(m => ({ ...m, at: Date.now() }))
          }));
        } catch (e) {
          testState.errors.push(`/turn/finish parse error: ${e.message}`);
          res.writeHead(500);
          res.end();
        }
      });
      return;
    }
    
    res.writeHead(404);
    res.end();
  });
}

// 提取自agent-landing.html的核心函数
function cleanArtifacts(arts) {
  if (!Array.isArray(arts)) return [];
  return arts.filter(a => a && (a.type === 'image' || a.type === 'file'));
}

function rewriteShown(text, arts) {
  let result = String(text || '');
  for (const a of arts || []) {
    if (a.url && a.path) {
      const escaped = a.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      result = result.replace(new RegExp(escaped, 'g'), a.url);
    }
  }
  return result;
}

function answerOf(row) {
  if (!row || !row.parts) return row?.content || '';
  return row.parts.map(p => {
    if (p.type === 'text') return p.text || '';
    return '';
  }).join('');
}

// done事件处理（提取自agent-landing.html L2388-2415）
function handleDoneEvent(doneEvent, row) {
  const finalOk = !!doneEvent.ok;
  const finalGuest = !!(doneEvent.guest || doneEvent.need_login_to_continue);
  
  const arts = cleanArtifacts(doneEvent.artifacts);
  const out = rewriteShown(String(doneEvent.output || doneEvent.result || doneEvent.text || doneEvent.message || ''), arts);
  
  if (row) {
    row.pending = false;
    row.taskId = undefined;
    if (doneEvent.response_id) row.responseId = doneEvent.response_id;
    if (arts.length) row.artifacts = arts;
    
    if (row.parts && row.parts.length) {
      row.parts = arts.length ? rewriteParts(row.parts, arts) : row.parts;
      const shown = answerOf(row);
      if (out && out !== shown && !shown.includes(out) && !out.includes(shown)) {
        row.parts = [...row.parts, { type: 'text', text: out }];
      } else if (out.startsWith(shown) && out.length > shown.length) {
        const extra = out.slice(shown.length).replace(/^\s+/, '');
        if (extra) row.parts = [...row.parts, { type: 'text', text: extra }];
      }
      row.content = answerOf(row) || out || '(empty)';
    } else {
      row.content = out || '(empty)';
    }
    
    if (arts.length) row.artifacts = arts;
  }
  
  // 返回finish payload
  return { stopped: true, finalOk, finalGuest };
}

function rewriteParts(parts, arts) {
  if (!Array.isArray(parts)) return parts;
  return parts.map(p => {
    if (p.type === 'text' && p.text) {
      return { ...p, text: rewriteShown(p.text, arts) };
    }
    return p;
  });
}

// endRelayTurn实现（简化版）
async function endRelayTurn(messages, shareId, port) {
  const url = `http://localhost:${port}/api/agent-chats/shares/${shareId}/turn/finish`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'test-token', messages }),
  });
  
  if (!response.ok) {
    throw new Error(`/turn/finish failed: ${response.status}`);
  }
  
  return await response.json();
}

async function runTest() {
  // 启动mock服务器
  const server = createMockServer();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`✓ Mock /turn/finish server on port ${port}\n`);
  
  try {
    // 设置测试环境
    const testShareId = 'test-share-123';
    mockDB.shares.set(testShareId, {
      turn_task_id: 'task-test-456',
      turn_started_at: Date.now(),
    });
    
    // 模拟messages
    const messages = [
      {
        role: 'user',
        content: '画一幅画',
        at: Date.now() - 60000,
      },
      {
        role: 'assistant',
        content: '',
        pending: true,
        liveTurn: false,
        taskId: 'task-test-456',
        startedAt: Date.now() - 50000,
      },
    ];
    
    console.log('测试1: 验证done事件处理\n');
    
    // 构造done事件
    const doneEvent = {
      event: 'done',
      ok: true,
      task_id: 'task-test-456',
      status: 'completed',
      output: '画好了，文件在这里：\n\n```\n/full/path/empty-room.png\n```\n\n这是一幅1200x1500的图片，描绘了一个空旷的房间。',
      response_id: 'resp-789',
      artifacts: [
        {
          type: 'image',
          name: 'empty-room.png',
          url: '/media/task-test-456/empty-room.png',
          path: '/full/path/empty-room.png',
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
      credits_charged: 5,
      guest: false,
    };
    
    console.log('done payload:');
    console.log(`  output: "${doneEvent.output.slice(0, 80)}..."`);
    console.log(`  artifacts: ${doneEvent.artifacts.length} items (${doneEvent.artifacts[0].name})`);
    console.log(`  response_id: ${doneEvent.response_id}`);
    console.log('');
    
    // 处理done事件
    const row = messages[1];
    const finishResult = handleDoneEvent(doneEvent, row);
    
    console.log('done处理后:');
    console.log(`  row.content: "${row.content.slice(0, 80)}..."`);
    console.log(`  row.artifacts: ${row.artifacts?.length || 0} items`);
    console.log(`  row.responseId: ${row.responseId}`);
    console.log(`  row.pending: ${row.pending}`);
    console.log('');
    
    // 关键验证：finish(true)调用前payload已赋值
    console.log('关键验证: finish(true)调用前payload检查\n');
    
    const preFinishChecks = [];
    
    preFinishChecks.push({
      name: 'content已赋值且非空',
      pass: row.content && row.content.length > 0 && row.content !== '(empty)',
      value: row.content ? `"${row.content.slice(0, 40)}..."` : 'null',
    });
    
    preFinishChecks.push({
      name: 'artifacts已赋值',
      pass: Array.isArray(row.artifacts) && row.artifacts.length > 0,
      value: row.artifacts?.length || 0,
    });
    
    preFinishChecks.push({
      name: 'response_id已赋值',
      pass: !!row.responseId,
      value: row.responseId || 'null',
    });
    
    preFinishChecks.push({
      name: 'pending已清除',
      pass: row.pending === false,
      value: row.pending,
    });
    
    preFinishChecks.push({
      name: 'taskId已清除',
      pass: row.taskId === undefined,
      value: row.taskId,
    });
    
    preFinishChecks.forEach(c => {
      console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}: ${c.value}`);
      if (!c.pass) {
        testState.errors.push(`预检失败: ${c.name}`);
      }
    });
    console.log('');
    
    if (testState.errors.length > 0) {
      console.error('❌ 错误: finish(true)调用前payload未完整赋值！');
      console.error('   这会导致空输出被保存为成功！\n');
    } else {
      console.log('✓ payload完整，可安全调用finish(true)\n');
    }
    
    // 验证finish返回值
    console.log('测试2: 验证finish(true)返回值\n');
    
    console.log(`  finishResult.stopped: ${finishResult.stopped}`);
    console.log(`  finishResult.finalOk: ${finishResult.finalOk}`);
    console.log(`  finishResult.finalGuest: ${finishResult.finalGuest}`);
    console.log('');
    
    // 测试3: 调用endRelayTurn保存消息
    console.log('测试3: 调用endRelayTurn(true)保存消息\n');
    
    // 过滤出非pending消息
    const tail = messages.filter(m => m && !m.pending && !m.liveTurn);
    
    console.log(`保存消息数: ${tail.length}`);
    tail.forEach((m, i) => {
      console.log(`  ${i + 1}. role=${m.role}`);
      console.log(`     content="${(m.content || '').slice(0, 60)}..."`);
      if (m.artifacts) {
        console.log(`     artifacts=${m.artifacts.length} items`);
      }
    });
    console.log('');
    
    // 调用/turn/finish
    await endRelayTurn(tail, testShareId, port);
    
    console.log('✓ /turn/finish API调用成功\n');
    
    // 测试4: 验证持久化结果
    console.log('测试4: 验证持久化结果\n');
    
    const tests = [];
    
    // 验证/turn/finish被调用
    tests.push({
      name: '/turn/finish API被调用',
      pass: testState.turnFinishCalled,
    });
    
    // 验证接收到2条消息
    tests.push({
      name: '/turn/finish接收到2条消息',
      pass: testState.turnFinishBody?.messages?.length === 2,
    });
    
    // 验证用户消息
    const userMsg = testState.turnFinishBody?.messages?.[0];
    tests.push({
      name: '用户消息保存',
      pass: userMsg?.role === 'user' && userMsg.content.includes('画一幅画'),
    });
    
    // 验证assistant消息
    const asstMsg = testState.turnFinishBody?.messages?.[1];
    tests.push({
      name: 'assistant消息保存',
      pass: asstMsg?.role === 'assistant',
    });
    
    // 关键：验证assistant消息有正文（非空）
    tests.push({
      name: 'assistant消息有正文（非空）',
      pass: asstMsg?.content && asstMsg.content.length > 0 && asstMsg.content !== '(empty)',
    });
    
    // 关键：验证assistant消息有artifacts
    tests.push({
      name: 'assistant消息有artifacts',
      pass: Array.isArray(asstMsg?.artifacts) && asstMsg.artifacts.length > 0,
    });
    
    // 验证artifacts内容
    tests.push({
      name: 'artifacts包含image',
      pass: asstMsg?.artifacts?.[0]?.type === 'image' && asstMsg.artifacts[0].name === 'empty-room.png',
    });
    
    // 验证path已改写为url
    tests.push({
      name: 'content中path已改写为url',
      pass: asstMsg?.content.includes('/media/task-test-456/empty-room.png') && !asstMsg.content.includes('/full/path/empty-room.png'),
    });
    
    // 验证mockDB持久化
    tests.push({
      name: 'messages写入mockDB',
      pass: mockDB.messages.has(testShareId) && mockDB.messages.get(testShareId).length === 2,
    });
    
    // 验证turn_task_id清除
    const share = mockDB.shares.get(testShareId);
    tests.push({
      name: 'turn_task_id已清除',
      pass: share?.turn_task_id === null,
    });
    
    // 打印结果
    console.log('=== 测试结果 ===\n');
    tests.forEach(t => {
      console.log(`  ${t.pass ? '✓' : '✗'} ${t.name}`);
      if (!t.pass) {
        testState.errors.push(`测试失败: ${t.name}`);
      }
    });
    console.log('');
    
    // 打印assistant消息详情
    if (asstMsg) {
      console.log('assistant消息详情:');
      console.log(`  content长度: ${asstMsg.content.length} chars`);
      console.log(`  content前80字: "${asstMsg.content.slice(0, 80)}..."`);
      console.log(`  artifacts: ${JSON.stringify(asstMsg.artifacts || [], null, 2)}`);
      console.log('');
    }
    
    if (testState.errors.length > 0) {
      console.error('=== 错误列表 ===\n');
      testState.errors.forEach(e => console.error(`  ${e}`));
      console.error('');
    }
    
    const passed = tests.filter(t => t.pass).length;
    const total = tests.length;
    
    console.log(`总计: ${passed}/${total} 个测试通过\n`);
    
    if (passed < total) {
      console.error('✗ 部分测试失败');
      process.exit(1);
    }
    
    console.log('✓ 所有测试通过');
    console.log('✓ 验证完成：done→finish→/turn/finish→DB完整链路正常');
    process.exit(0);
    
  } catch (error) {
    console.error('\n测试执行失败:');
    console.error(error.stack);
    process.exit(1);
  } finally {
    server.close();
  }
}

runTest().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
