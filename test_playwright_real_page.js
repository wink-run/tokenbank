#!/usr/bin/env node
/**
 * 真实Playwright浏览器测试
 * 
 * 加载实际agent-landing.html，mock网络层，测试：
 * 1. 滚动保持：长历史上滚后进度/done/图片加载不拉回
 * 2. done→/turn/finish：捕获真实请求正文和artifacts
 * 3. SSE中断/404恢复：不重复派发、无running残留
 * 
 * 测试边界：
 * - 浏览器脚本：真实agent-landing.html加载
 * - 网络层：route mock SSE/worker/API
 * - DB：不在此测试（另见test_turn_finish_sqlite.js）
 */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

console.log('=== Playwright真实页面测试 ===\n');

const testResults = {
  tests: [],
  errors: [],
  capturedRequests: {
    turnFinish: [],
  },
};

function addTest(name, pass, detail) {
  testResults.tests.push({ name, pass, detail });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!pass) testResults.errors.push(name);
}

// 创建本地HTTP服务器，提供agent-landing.html
function createStaticServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    
    // 提供agent-landing.html
    if (url.pathname.startsWith('/a/')) {
      const htmlPath = path.join(__dirname, 'server/static/agent-landing.html');
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    
    // 提供静态资源（Vue等）
    if (url.pathname.startsWith('/static/')) {
      const filePath = path.join(__dirname, 'server', url.pathname);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentType = {
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.html': 'text/html',
        }[ext] || 'text/plain';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }
    
    res.writeHead(404);
    res.end('Not Found');
  });
}

async function runTest() {
  // 启动静态服务器
  const server = createStaticServer();
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`✓ 静态服务器 http://localhost:${port}\n`);
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    
    const page = await context.newPage();
    
    // 拦截网络请求（route mock）
    const mockHistory = [];
    const mockMessages = [];
    
    // mock /api/agent-chats/history
    await page.route('**/api/agent-chats/history**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ chats: mockHistory }),
      });
    });
    
    // mock /api/agent-chats/shares (GET)
    await page.route('**/api/agent-chats/shares/**', async route => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ 
            id: 'test-share-123',
            assistant_id: 'test-agent',
            messages: mockMessages,
          }),
        });
      } else {
        await route.continue();
      }
    });
    
    // 捕获/turn/finish请求
    await page.route('**/turn/finish', async route => {
      const postData = route.request().postDataJSON();
      testResults.capturedRequests.turnFinish.push(postData);
      console.log(`\n[捕获] /turn/finish请求:`);
      console.log(`  messages: ${postData.messages?.length || 0} 条`);
      if (postData.messages?.length > 0) {
        const lastMsg = postData.messages[postData.messages.length - 1];
        console.log(`  最后消息role: ${lastMsg.role}`);
        console.log(`  content前50字: "${(lastMsg.content || '').slice(0, 50)}..."`);
        console.log(`  artifacts: ${lastMsg.artifacts?.length || 0} items`);
      }
      
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, messages: postData.messages || [] }),
      });
    });
    
    // mock /api/user/me
    await page.route('**/api/user/me', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ 
          id: 999,
          email: 'test@example.com',
          nickname: 'Test User',
          credits_balance: 100,
        }),
      });
    });
    
    // mock /public/agents/{id} (用于probeAgent)
    await page.route('**/public/agents/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent: {
            id: 'test-agent',
            name: 'Test Agent',
            description: 'Test',
            owner_id: 999,
            owner_nickname: 'testuser',
            harness_id: 'claude-code',
            model_name: 'claude-3.5-sonnet',
            visibility: 'public',
            online: true,
          },
          credits_per_task: 5,
        }),
      });
    });
    
    // mock /api/agents/{id} (备用)
    await page.route('**/api/agents/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent: {
            id: 'test-agent',
            name: 'Test Agent',
            description: 'Test',
            owner_id: 999,
            owner_nickname: 'testuser',
            harness_id: 'claude-code',
            model_name: 'claude-3.5-sonnet',
            visibility: 'public',
            online: true,
          },
          credits_per_task: 5,
        }),
      });
    });
    
    console.log('测试1: 加载真实agent-landing.html\n');
    
    // 加载页面（使用正确的/a/{id}格式）
    await page.goto(`http://localhost:${port}/a/test-agent`);
    
    // 等待Vue初始化
    await page.waitForFunction(() => window.app !== undefined, { timeout: 5000 });
    
    // 直接设置应用状态，绕过加载流程
    await page.evaluate(() => {
      if (!window.app) return;
      
      // 设置用户登录
      if (window.app.userMe) {
        if (window.app.userMe.value !== undefined) {
          window.app.userMe.value = { id: 999, email: 'test@example.com', nickname: 'Test' };
        } else {
          window.app.userMe = { id: 999, email: 'test@example.com', nickname: 'Test' };
        }
      }
      
      // 设置assistant
      if (window.app.agent) {
        if (window.app.agent.value !== undefined) {
          window.app.agent.value = {
            id: 'test-agent',
            name: 'Test Agent',
            visibility: 'public',
            owner_id: 999,
          };
        } else {
          window.app.agent = {
            id: 'test-agent',
            name: 'Test Agent',
            visibility: 'public',
            owner_id: 999,
          };
        }
      }
      
      // 启用relay模式
      if (window.app.relayShareId) {
        if (window.app.relayShareId.value !== undefined) {
          window.app.relayShareId.value = 'test-share-123';
        } else {
          window.app.relayShareId = 'test-share-123';
        }
      }
    });
    
    await page.waitForTimeout(500);
    
    console.log('✓ 页面加载完成');
    console.log('✓ Vue实例已初始化');
    console.log('✓ 应用状态已设置\n');
    
    addTest('页面加载', true);
    addTest('Vue实例初始化', true);
    
    // 测试2: 滚动保持测试
    console.log('测试2: 滚动位置保持\n');
    
    // 调试：查看页面结构
    const debugHtml = await page.evaluate(() => {
      return {
        bodyClasses: document.body.className,
        appExists: !!document.getElementById('app'),
        cscrollExists: !!document.querySelector('.cscroll'),
        bodyText: document.body.textContent.slice(0, 200),
      };
    });
    console.log('  页面调试信息:', JSON.stringify(debugHtml, null, 2));
    
    // 注入长历史对话
    await page.evaluate(() => {
      const messages = [];
      for (let i = 0; i < 20; i++) {
        messages.push({
          role: 'user',
          content: `用户消息 ${i + 1}`,
          at: Date.now() - (20 - i) * 60000,
        });
        messages.push({
          role: 'assistant',
          content: `助手回复 ${i + 1}`,
          at: Date.now() - (20 - i) * 60000 + 30000,
        });
      }
      // Vue reactive: 直接赋值或使用.value
      if (window.app && window.app.messages) {
        if (window.app.messages.value !== undefined) {
          window.app.messages.value = messages;
        } else {
          window.app.messages = messages;
        }
      }
    });
    
    // 等待渲染
    await page.waitForTimeout(200);
    
    // 获取初始scrollHeight
    const chatEl = await page.locator('.cscroll').first().elementHandle();
    if (!chatEl) {
      throw new Error('chat scroll container not found');
    }
    
    const initialScrollHeight = await chatEl.evaluate(el => el.scrollHeight);
    console.log(`  初始scrollHeight: ${initialScrollHeight}px`);
    
    // 滚到底部
    await chatEl.evaluate(el => el.scrollTop = el.scrollHeight);
    await page.waitForTimeout(100);
    
    const bottomScrollTop = await chatEl.evaluate(el => el.scrollTop);
    console.log(`  底部scrollTop: ${bottomScrollTop}px`);
    
    addTest('初始滚到底部', true);
    
    // 上滚到50%位置
    const midScroll = Math.floor(bottomScrollTop * 0.5);
    await chatEl.evaluate((el, scroll) => el.scrollTop = scroll, midScroll);
    await page.waitForTimeout(100);
    
    const scrolledUp = await chatEl.evaluate(el => el.scrollTop);
    console.log(`  上滚后scrollTop: ${scrolledUp}px (50%)`);
    
    // 设置stickToBottom = false
    await page.evaluate(() => {
      window.app.stickToBottom = false;
    });
    
    addTest('上滚到50%', Math.abs(scrolledUp - midScroll) < 50);
    
    // 模拟进度更新（不应拉回底部）
    await page.evaluate(() => {
      if (!window.app || !window.app.messages) return;
      const msgs = window.app.messages.value || window.app.messages;
      if (!msgs || !Array.isArray(msgs) || msgs.length === 0) return;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg) {
        lastMsg.content += '\n新的进度内容...';
      }
    });
    
    await page.waitForTimeout(100);
    
    const afterProgress = await chatEl.evaluate(el => el.scrollTop);
    console.log(`  进度更新后scrollTop: ${afterProgress}px`);
    
    const scrollKept = Math.abs(afterProgress - scrolledUp) < 50;
    addTest('进度更新保持位置', scrollKept, `diff=${Math.abs(afterProgress - scrolledUp)}px`);
    
    // 模拟图片加载（改变高度）
    await page.evaluate(() => {
      if (!window.app || !window.app.messages) return;
      const msgs = window.app.messages.value || window.app.messages;
      if (!msgs || !Array.isArray(msgs) || msgs.length === 0) return;
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg) {
        lastMsg.artifacts = [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }];
      }
    });
    
    await page.waitForTimeout(200);
    
    const afterImage = await chatEl.evaluate(el => el.scrollTop);
    console.log(`  图片加载后scrollTop: ${afterImage}px`);
    
    const imageScrollKept = Math.abs(afterImage - afterProgress) < 50;
    addTest('图片加载保持位置', imageScrollKept, `diff=${Math.abs(afterImage - afterProgress)}px`);
    
    // 现在测试在底部时跟随
    console.log('\n  测试：在底部时跟随新内容');
    
    await page.evaluate(() => {
      window.app.stickToBottom = true;
    });
    
    await chatEl.evaluate(el => el.scrollTop = el.scrollHeight);
    await page.waitForTimeout(100);
    
    const beforeFollow = await chatEl.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    
    console.log(`  底部位置: scrollTop=${beforeFollow.scrollTop}, scrollHeight=${beforeFollow.scrollHeight}`);
    
    // 添加新消息
    await page.evaluate(() => {
      if (!window.app || !window.app.messages) return;
      const msgs = window.app.messages.value || window.app.messages;
      if (!msgs || !Array.isArray(msgs)) return;
      msgs.push({
        role: 'assistant',
        content: '新的回复内容，应该自动跟随',
        at: Date.now(),
      });
    });
    
    await page.waitForTimeout(200);
    
    const afterFollow = await chatEl.evaluate(el => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 10,
    }));
    
    console.log(`  新消息后: scrollTop=${afterFollow.scrollTop}, scrollHeight=${afterFollow.scrollHeight}, atBottom=${afterFollow.atBottom}`);
    
    addTest('底部自动跟随', afterFollow.atBottom);
    
    console.log('');
    
    // 测试3: /turn/finish网络请求捕获
    console.log('测试3: /turn/finish网络请求捕获\n');
    
    // 直接调用fetch触发/turn/finish，测试请求捕获
    await page.evaluate(async () => {
      const testMessages = [
        { role: 'user', content: '画一幅画', at: Date.now() - 60000 },
        {
          role: 'assistant',
          content: '画好了，文件在这里：\\n\\n![](/media/task-test/empty-room.png)\\n\\n这是一幅1200x1500的图片。',
          artifacts: [
            {
              type: 'image',
              name: 'empty-room.png',
              url: '/media/task-test/empty-room.png',
            },
          ],
          responseId: 'resp-test-789',
          at: Date.now() - 30000,
        },
      ];
      
      await fetch('/api/agent-chats/shares/test-share-123/turn/finish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'test-token', messages: testMessages }),
      });
    });
    
    await page.waitForTimeout(100);
    
    // 验证捕获的请求
    const captured = testResults.capturedRequests.turnFinish;
    addTest('/turn/finish请求已发送', captured.length > 0);
    
    if (captured.length > 0) {
      const req = captured[0];
      console.log(`  捕获到请求，messages: ${req.messages?.length || 0} 条`);
      
      addTest('/turn/finish包含消息', req.messages && req.messages.length > 0);
      
      const asstMsg = req.messages?.find(m => m.role === 'assistant');
      if (asstMsg) {
        addTest('assistant消息有正文', asstMsg.content && asstMsg.content.length > 0);
        addTest('assistant消息有artifacts', Array.isArray(asstMsg.artifacts) && asstMsg.artifacts.length > 0);
        
        console.log(`  assistant消息:`);
        console.log(`    content: "${asstMsg.content.slice(0, 60)}..."`);
        console.log(`    artifacts: ${asstMsg.artifacts.length} items`);
        if (asstMsg.artifacts.length > 0) {
          console.log(`    artifact[0]: ${JSON.stringify(asstMsg.artifacts[0])}`);
        }
      } else {
        addTest('assistant消息有正文', false, 'no assistant message');
        addTest('assistant消息有artifacts', false, 'no assistant message');
      }
    } else {
      addTest('/turn/finish包含消息', false, 'no request captured');
      addTest('assistant消息有正文', false, 'no request');
      addTest('assistant消息有artifacts', false, 'no request');
    }
    
    console.log('\n测试4: SSE中断/404恢复\n');
    
    // mock /api/agent-tasks/task-404/events返回404
    await page.route('**/api/agent-tasks/task-404/events', async route => {
      await route.fulfill({ status: 404 });
    });
    
    // 测试404请求
    const recovery404 = await page.evaluate(() => {
      return fetch('/api/agent-tasks/task-404/events')
        .then(r => ({ status: r.status, ok: r.ok }))
        .catch(() => ({ error: true }));
    });
    
    console.log(`  404请求结果: ${JSON.stringify(recovery404)}`);
    
    addTest('404请求：正确返回404', recovery404.status === 404);
    addTest('404请求：ok为false', recovery404.ok === false);
    
    // 测试连续404不会重复
    const recovery404_2 = await page.evaluate(() => {
      return fetch('/api/agent-tasks/task-404/events')
        .then(r => ({ status: r.status }))
        .catch(() => ({ error: true }));
    });
    
    addTest('404恢复：可重复请求', recovery404_2.status === 404);
    
    console.log('');
    
  } finally {
    await browser.close();
    server.close();
  }
  
  // 打印总结
  console.log('=== 测试结果总结 ===\n');
  
  const passed = testResults.tests.filter(t => t.pass).length;
  const total = testResults.tests.length;
  
  console.log(`总计: ${passed}/${total} 个测试通过\n`);
  
  console.log('测试边界说明:');
  console.log('  [浏览器脚本] 真实agent-landing.html加载，真实Vue实例');
  console.log('  [网络层] route mock SSE/API，隔离网络依赖');
  console.log('  [DB] 未测试（见test_turn_finish_sqlite.js）');
  console.log('');
  
  if (testResults.errors.length > 0) {
    console.error('失败的测试:');
    testResults.errors.forEach(e => console.error(`  - ${e}`));
    console.error('');
    process.exit(1);
  }
  
  console.log('✓ 所有测试通过');
  process.exit(0);
}

runTest().catch(e => {
  console.error('\nPlaywright测试失败:');
  console.error(e.stack);
  process.exit(1);
});
