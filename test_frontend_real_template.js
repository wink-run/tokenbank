/**
 * 使用真实agent-landing.html模板测试工具详情渲染
 * 模拟真实SSE事件流
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

async function startMockServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/agent/hire/test-agent/ask') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        
        // 模拟真实的SSE事件序列
        setTimeout(() => {
          // 工具调用开始
          res.write('event: progress\n');
          res.write('data: ' + JSON.stringify({
            event: 'progress',
            task_id: 'task_001',
            text: '',
            tool: 'execute_command',
            parts: [{
              type: 'tool',
              name: 'execute_command',
              id: 'tool_001',
              detail: 'generate_image.sh --poem="夜来风雨声" --position=top-right',
              status: 'running'
            }]
          }) + '\n\n');
        }, 100);
        
        setTimeout(() => {
          // 工具完成
          res.write('event: progress\n');
          res.write('data: ' + JSON.stringify({
            event: 'progress',
            task_id: 'task_001',
            text: '',
            tool: 'execute_command',
            parts: [{
              type: 'tool',
              name: 'execute_command',
              id: 'tool_001',
              detail: 'generate_image.sh --poem="夜来风雨声" --position=top-right',
              result: 'Image generated: output.png\nPoem placed in top-right corner.',
              status: 'completed'
            }]
          }) + '\n\n');
        }, 500);
        
        setTimeout(() => {
          // 最终输出
          res.write('event: done\n');
          res.write('data: ' + JSON.stringify({
            event: 'done',
            task_id: 'task_001',
            output: '图片已生成：output.png\n\n诗已放置在右上角。',
            artifacts: []
          }) + '\n\n');
          res.end();
        }, 800);
        
      } else if (req.url.startsWith('/api/agents/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'test-agent',
          name: '测试智能体',
          displayName: '测试智能体',
          ownerName: 'test'
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    
    server.listen(18765, () => {
      console.log('Mock server started on http://localhost:18765');
      resolve(server);
    });
  });
}

async function runTest() {
  const server = await startMockServer();
  
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15'
    });
    
    const page = await context.newPage();
    
    // 加载实际的HTML模板
    const htmlPath = path.join(__dirname, 'server/static/agent-landing.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    
    // 替换必要的模板变量
    html = html.replace(/\{\{JS_VER\}\}/g, '1');
    html = html.replace(/\{\{CSS_VER\}\}/g, '1');
    html = html.replace(/\{\{APP_NAME\}\}/g, 'Token Bank');
    html = html.replace(/\{\{agent_id\}\}/g, 'test-agent');
    html = html.replace(/\{\{owner_name\}\}/g, 'test');
    
    // 注入mock API基础URL
    html = html.replace('<script>', `<script>
      window.__API_BASE__ = 'http://localhost:18765';
    `);
    
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    
    console.log('\n=== 真实模板前端测试 ===\n');
    
    // 等待Vue初始化
    await page.waitForTimeout(500);
    
    // 触发提问（模拟用户输入）
    const hasInput = await page.$('#q');
    if (hasInput) {
      await page.fill('#q', '配一张图，并把诗放在右上角');
      await page.click('button[type="submit"]');
      
      console.log('测试1: 等待工具进度事件');
      // 等待工具卡片出现
      await page.waitForSelector('.tool-fold', { timeout: 3000 });
      console.log('  ✓ 工具卡片已渲染');
      
      // 检查工具状态
      const toolStatus = await page.$eval('.tool-status', el => el.textContent);
      console.log(`  工具状态: ${toolStatus}`);
      
      // 等待工具完成
      await page.waitForTimeout(1000);
      
      console.log('\n测试2: 点击工具展开');
      const toolFold = await page.$('.tool-fold');
      await toolFold.click();
      await page.waitForTimeout(200);
      
      const isOpen = await toolFold.evaluate(el => el.open);
      console.log(`  展开状态: ${isOpen ? 'open' : 'closed'}`);
      
      if (isOpen) {
        // 检查detail内容
        const hasDetail = await page.$('.tool-fold pre');
        if (hasDetail) {
          const detailText = await hasDetail.textContent();
          console.log(`  详情内容: ${detailText.slice(0, 50)}...`);
          console.log('  ✓ 详情可见');
        } else {
          console.log('  ✗ 无详情内容');
        }
        
        // 检查result内容
        const hasResult = await page.$('.tool-fold .tool-result');
        if (hasResult) {
          const resultText = await hasResult.textContent();
          console.log(`  结果内容: ${resultText.slice(0, 50)}...`);
          console.log('  ✓ 结果可见');
        } else {
          console.log('  ✗ 无结果内容');
        }
      } else {
        console.log('  ✗ 工具未能展开');
      }
      
      console.log('\n测试3: 最终文本渲染');
      // 等待done事件
      await page.waitForTimeout(500);
      
      const finalText = await page.$('.md-body');
      if (finalText) {
        const text = await finalText.textContent();
        console.log(`  最终文本: ${text.slice(0, 50)}...`);
        console.log('  ✓ 最终文本已渲染');
      } else {
        console.log('  ✗ 未找到最终文本');
      }
      
      // 截图保存
      const screenshot = await page.screenshot();
      fs.writeFileSync('/tmp/tool-expand-test.png', screenshot);
      console.log('\n  截图已保存: /tmp/tool-expand-test.png');
      
    } else {
      console.log('✗ 未找到输入框');
    }
    
    await browser.close();
    console.log('\n=== 测试完成 ===');
    
  } catch (err) {
    console.error('测试失败:', err);
    throw err;
  } finally {
    server.close();
  }
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
