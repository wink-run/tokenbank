#!/usr/bin/env node
/**
 * 附件端到端测试：图片/文件从HTTP body → executor → 落盘 → agent可读
 * 
 * 验证：
 * 1. agent-http解析body.images/files
 * 2. executor调用materializeAttachedImages/Files
 * 3. 文件落盘到工作目录
 * 4. agent进程可读取
 * 5. 多轮对话附件持久化
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

// 测试根目录
const testRoot = path.join(os.tmpdir(), `test-attach-${Date.now()}`);
const fakeCLIDir = path.join(testRoot, 'bin');
const fakeCLIPath = path.join(fakeCLIDir, 'claude');
const dbDir = path.join(testRoot, 'stats');

console.log('=== 附件端到端测试 ===');
console.log(`测试目录: ${testRoot}`);
console.log(`DB目录: ${dbDir}\n`);

// 创建fake CLI（会输出收到的文件列表）
fs.mkdirSync(fakeCLIDir, { recursive: true });
fs.mkdirSync(dbDir, { recursive: true });

const fakeCLIScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const cwd = process.cwd();
const sessionId = 'sess-attach-' + Date.now();

// 递归列出所有文件
function listAllFiles(dir, prefix = '') {
  const all = [];
  const entries = fs.readdirSync(dir);
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const displayPath = prefix ? path.join(prefix, entry) : entry;
    try {
      const stat = fs.statSync(fullPath);
      if (stat.isFile()) {
        all.push(displayPath);
      } else if (stat.isDirectory()) {
        all.push(...listAllFiles(fullPath, displayPath));
      }
    } catch {}
  }
  return all;
}

const files = listAllFiles(cwd);

// 输出stream-json
console.log(JSON.stringify({ type: 'metadata', session_id: sessionId }));
console.log(JSON.stringify({ type: 'message_start' }));
console.log(JSON.stringify({ type: 'content_block', index: 0, content_type: 'text' }));

const fileList = files.length > 0 
  ? \`我看到了 \${files.length} 个文件：\${files.join(', ')}\`
  : '当前目录为空';

console.log(JSON.stringify({ 
  type: 'content_delta', 
  index: 0, 
  delta: { type: 'text_delta', text: fileList } 
}));
console.log(JSON.stringify({ type: 'message_end' }));
`;

fs.writeFileSync(fakeCLIPath, fakeCLIScript);
fs.chmodSync(fakeCLIPath, 0o755);

// 修改PATH
process.env.PATH = `${fakeCLIDir}:${process.env.PATH}`;
process.env.STATS_DIR = dbDir;

// 初始化数据库
const localStats = require('./client/electron/local-stats');
const db = localStats.requireDb(dbDir);
console.log('✓ 数据库初始化\n');

// 导入模块
const agentHttp = require('./client/electron/agent-http');
const executor = require('./client/electron/agent-executor');

// 创建测试图片（1x1 PNG）
const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const testImageDataURL = `data:image/png;base64,${testImageBase64}`;

// 创建测试文本文件
const testTextContent = 'Test file content\nLine 2\nLine 3';
const testTextBase64 = Buffer.from(testTextContent, 'utf8').toString('base64');
const testTextDataURL = `data:text/plain;base64,${testTextBase64}`;

// HTTP请求
function callAgentHttp(port, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: 'localhost',
      port,
      path: '/v1/agent/responses',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': 'Bearer test-key',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// 等待任务完成
async function waitForTask(taskId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const task = await executor.getTaskStatus(taskId);
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        return task;
      }
    } catch (e) {
      // 任务可能还没创建
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Task timeout');
}

// 测试结果
const tests = [];
function addTest(name, pass) {
  tests.push({ name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
}

// 启动HTTP服务器
let server;
async function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      if (req.url === '/v1/agent/responses' && req.method === 'POST') {
        await agentHttp.handle(req, res, { 
          method: 'POST', 
          cleanPath: '/v1/agent/responses',
          knownKey: (key) => key === 'test-key',
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, () => {
      const port = server.address().port;
      resolve(port);
    });
  });
}

async function runTests() {
  const port = await startServer();
  console.log(`✓ HTTP server on port ${port}\n`);
  
  try {
    // ========== 测试1: 图片附件落盘 ==========
    console.log('测试1: hired调用带图片附件');
    
    const resp1 = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '查看当前目录',
      metadata: {
        assistant_id: 'test-assistant',
        consumer_key: 'u999',
        call_context: 'hired',
      },
      images: [testImageDataURL],
    });
    
    if (resp1.status !== 200) {
      console.error(`  请求失败: ${resp1.status}`, resp1.body.error?.message || resp1.body);
      addTest('带图片请求', false);
    } else {
      const task1 = await waitForTask(resp1.body.id);
      console.log(`  task_id: ${resp1.body.id}`);
      console.log(`  status: ${task1.status}`);
      
      // 解析agent输出
      const output = task1.result?.summary || task1.result?.output || '';
      console.log(`  agent输出: ${output.slice(0, 200)}`);
      
      // 检查是否提到了文件
      const mentionsFiles = /看到了|文件|image|png|upload/i.test(output);
      addTest('带图片请求成功', resp1.status === 200);
      addTest('图片文件落盘', mentionsFiles);
      
      // 验证工作目录
      const workDir = task1.context?.workingDir;
      if (workDir && fs.existsSync(workDir)) {
        // 递归列出所有文件
        function listAll(dir) {
          const result = [];
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isFile()) {
                result.push(item);
              } else if (stat.isDirectory()) {
                result.push(...listAll(fullPath).map(f => path.join(item, f)));
              }
            } catch {}
          }
          return result;
        }
        
        const allFiles = listAll(workDir);
        console.log(`  工作目录所有文件: ${allFiles.join(', ')}`);
        
        const hasImageFile = allFiles.some(f => /\.png$/i.test(f));
        addTest('工作目录有图片', hasImageFile);
      } else {
        addTest('工作目录有图片', false);
      }
      
      tests.task1Id = resp1.body.id;
      tests.workDir1 = workDir;
    }
    console.log('');
    
    // ========== 测试2: 文本附件落盘 ==========
    console.log('测试2: 文本文件附件');
    
    const resp2 = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '查看当前目录',
      metadata: {
        assistant_id: 'test-assistant',
        consumer_key: 'u888',
        call_context: 'hired',
      },
      files: [{ dataUrl: testTextDataURL, name: 'test.txt' }],
    });
    
    if (resp2.status !== 200) {
      console.error(`  请求失败: ${resp2.status}`);
      addTest('带文本文件请求', false);
    } else {
      const task2 = await waitForTask(resp2.body.id);
      const output = task2.result?.summary || task2.result?.output || '';
      console.log(`  agent输出: ${output.slice(0, 200)}`);
      
      const mentionsFile = /看到了|文件|txt|test/i.test(output);
      addTest('文本文件落盘', mentionsFile);
      
      const workDir = task2.context?.workingDir;
      if (workDir && fs.existsSync(workDir)) {
        function listAll(dir) {
          const result = [];
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isFile()) {
                result.push({ name: item, path: fullPath });
              } else if (stat.isDirectory()) {
                result.push(...listAll(fullPath).map(f => ({ name: path.join(item, f.name), path: f.path })));
              }
            } catch {}
          }
          return result;
        }
        
        const allFiles = listAll(workDir);
        const hasTextFile = allFiles.some(f => /\.txt$/i.test(f.name));
        addTest('工作目录有文本文件', hasTextFile);
        
        // 验证文件内容
        if (hasTextFile) {
          const txtFile = allFiles.find(f => /\.txt$/i.test(f.name));
          const content = fs.readFileSync(txtFile.path, 'utf8');
          addTest('文本内容正确', content.includes('Test file content'));
        }
      }
    }
    console.log('');
    
    // ========== 测试3: 图片+文本混合 ==========
    console.log('测试3: 图片和文本混合附件');
    
    const resp3 = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '列出所有文件',
      metadata: {
        assistant_id: 'test-assistant',
        consumer_key: 'u777',
        call_context: 'hired',
      },
      images: [testImageDataURL],
      files: [{ dataUrl: testTextDataURL, name: 'mixed.txt' }],
    });
    
    if (resp3.status === 200) {
      const task3 = await waitForTask(resp3.body.id);
      const output = task3.result?.summary || task3.result?.output || '';
      
      const workDir = task3.context?.workingDir;
      if (workDir && fs.existsSync(workDir)) {
        function listAll(dir) {
          const result = [];
          const items = fs.readdirSync(dir);
          for (const item of items) {
            const fullPath = path.join(dir, item);
            try {
              const stat = fs.statSync(fullPath);
              if (stat.isFile()) {
                result.push(item);
              } else if (stat.isDirectory()) {
                result.push(...listAll(fullPath).map(f => path.join(item, f)));
              }
            } catch {}
          }
          return result;
        }
        
        const allFiles = listAll(workDir);
        const hasImage = allFiles.some(f => /\.png$/i.test(f));
        const hasText = allFiles.some(f => /\.txt$/i.test(f));
        
        addTest('混合附件-图片', hasImage);
        addTest('混合附件-文本', hasText);
        addTest('混合附件-共2个文件', allFiles.length >= 2);
      }
    }
    console.log('');
    
    // ========== 测试4: local不落盘附件 ==========
    console.log('测试4: local调用不应落盘（无附件传递）');
    
    const resp4 = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '查看目录',
      metadata: {
        call_context: 'local',
      },
      images: [testImageDataURL],
    });
    
    if (resp4.status === 200) {
      const task4 = await waitForTask(resp4.body.id);
      const output = task4.result?.summary || task4.result?.output || '';
      console.log(`  local输出: ${output.slice(0, 300)}`);
      
      // local模式应该在默认目录，不应该有测试附件（png/txt）
      const noTestFiles = !/\.png|\.txt|image-|test\.txt|mixed\.txt/i.test(output);
      addTest('local不落盘附件', noTestFiles);
    }
    console.log('');
    
  } finally {
    server.close();
  }
  
  // ========== 总结 ==========
  console.log('=== 测试结果 ===\n');
  
  const passed = tests.filter(t => typeof t === 'object' && t.pass).length;
  const total = tests.filter(t => typeof t === 'object').length;
  
  tests.filter(t => typeof t === 'object').forEach(t => {
    console.log(`  ${t.pass ? '✓' : '✗'} ${t.name}`);
  });
  console.log('');
  
  console.log(`总计: ${passed}/${total} 个测试通过`);
  console.log('');
  
  if (passed < total) {
    console.error('✗ 部分测试失败');
    process.exit(1);
  }
  
  console.log('✓ 所有测试通过');
  process.exit(0);
}

runTests().catch(e => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
