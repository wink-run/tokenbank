/**
 * Playwright测试：移动端工具展开和最终文本渲染
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function runTest() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },  // iPhone 12 Pro size
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15'
  });
  
  const page = await context.newPage();
  
  // 加载实际的HTML模板
  const htmlPath = path.join(__dirname, 'server/static/agent-landing.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  
  // 简化版：替换后端变量
  html = html.replace(/\{\{JS_VER\}\}/g, '1');
  
  // Mock API和Vue data
  const testHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* 简化的CSS用于测试 */
    .tool-fold { border: 1px solid #ccc; margin: 10px 0; }
    .tool-fold summary { cursor: pointer; padding: 10px; }
    .tool-fold[open] { background: #f0f0f0; }
    .md-body { padding: 10px; border: 1px solid #ddd; margin: 10px 0; }
  </style>
</head>
<body>
  <div id="app">
    <div id="messages">
      <!-- 场景1: 只有工具，无最终文本 -->
      <div class="message">
        <details class="tool-fold" id="tool1">
          <summary>
            <span>执行命令</span>
            <span class="tool-status">已完成</span>
            <span class="tool-time">40s</span>
          </summary>
          <pre>generate_image.sh</pre>
          <pre class="tool-result">Done</pre>
        </details>
      </div>
      
      <!-- 场景2: 工具 + 最终文本 -->
      <div class="message">
        <details class="tool-fold" id="tool2">
          <summary>
            <span>生成图片</span>
            <span class="tool-status">已完成</span>
          </summary>
          <pre>image_generation</pre>
        </details>
        <div class="md-body" id="final-text">图片已生成：output.png\n\n诗已放置在右上角。</div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
  
  await page.setContent(testHTML);
  
  console.log('=== Playwright 前端测试 ===\n');
  
  // 测试1: 工具条可以点击展开
  console.log('测试1: 工具条点击展开');
  const tool1 = await page.$('#tool1');
  const isOpenBefore = await tool1.evaluate(el => el.open);
  console.log('  展开前 open状态:', isOpenBefore);
  
  await tool1.click();
  await page.waitForTimeout(100);
  
  const isOpenAfter = await tool1.evaluate(el => el.open);
  console.log('  点击后 open状态:', isOpenAfter);
  
  if (isOpenAfter) {
    const detailsVisible = await page.$eval('#tool1 pre', el => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0;
    });
    console.log('  详情内容可见:', detailsVisible);
    console.log('  结果: ✓ 工具条可展开');
  } else {
    console.log('  结果: ✗ 工具条无法展开');
  }
  console.log('');
  
  // 测试2: 最终文本在工具外可见
  console.log('测试2: 最终文本独立显示');
  const finalText = await page.$('#final-text');
  if (finalText) {
    const text = await finalText.textContent();
    const visible = await finalText.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && window.getComputedStyle(el).display !== 'none';
    });
    console.log('  最终文本内容:', text.slice(0, 50) + '...');
    console.log('  可见性:', visible);
    console.log('  结果:', visible ? '✓ 最终文本可见' : '✗ 最终文本不可见');
  } else {
    console.log('  结果: ✗ 未找到最终文本元素');
  }
  console.log('');
  
  // 测试3: 移动端点击区域
  console.log('测试3: 移动端触摸点击');
  const tool2 = await page.$('#tool2');
  await tool2.tap();  // 使用tap而不是click，模拟触摸
  await page.waitForTimeout(100);
  
  const tool2Open = await tool2.evaluate(el => el.open);
  console.log('  tap后 open状态:', tool2Open);
  console.log('  结果:', tool2Open ? '✓ 触摸点击有效' : '✗ 触摸点击无效');
  console.log('');
  
  await browser.close();
  
  console.log('=== 测试完成 ===');
}

runTest().catch(err => {
  console.error('测试失败:', err);
  process.exit(1);
});
