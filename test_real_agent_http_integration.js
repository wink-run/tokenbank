/**
 * 真实agent-http + executor集成测试
 * 
 * 不mock核心executor逻辑，使用真实的CLI可执行文件
 * 验证完整的hired workspace隔离与产物收集流程
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');

// 测试目录
const testRoot = path.join(os.tmpdir(), `test-agent-http-${Date.now()}`);
const fakeCLIPath = path.join(testRoot, 'fake-cli' + (process.platform === 'win32' ? '.bat' : ''));

console.log('=== 真实agent-http + executor集成测试 ===');
console.log(`测试根目录: ${testRoot}\n`);

// 创建fake CLI可执行文件
fs.mkdirSync(testRoot, { recursive: true });

// Fake CLI实现：输出stream-json格式
const fakeCliScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cwd = process.cwd();
const sessionId = 'sess-' + crypto.randomBytes(4).toString('hex');
const prompt = process.argv[process.argv.length - 1] || '';

// 输出metadata
console.log(JSON.stringify({ type: 'metadata', session_id: sessionId }));
console.log(JSON.stringify({ type: 'message_start' }));

// 根据prompt判断任务类型
const isDrawing = /画|图|draw|image/.test(prompt);

if (isDrawing) {
  // 绘图任务：生成图片 + package.json（测试过滤）
  const imgPath = path.join(cwd, 'output.png');
  const pkgPath = path.join(cwd, 'package.json');
  
  fs.writeFileSync(imgPath, Buffer.from('fake-png-' + Date.now()));
  fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test-deps' }));
  
  console.log(JSON.stringify({ 
    type: 'content_block', 
    index: 0, 
    content_type: 'text' 
  }));
  console.log(JSON.stringify({ 
    type: 'content_delta', 
    index: 0, 
    delta: { 
      type: 'text_delta', 
      text: '生成图片：output.png\\n工作目录：' + cwd 
    } 
  }));
} else {
  // 普通任务
  console.log(JSON.stringify({ 
    type: 'content_block', 
    index: 0, 
    content_type: 'text' 
  }));
  console.log(JSON.stringify({ 
    type: 'content_delta', 
    index: 0, 
    delta: { 
      type: 'text_delta', 
      text: 'Task completed in: ' + cwd 
    } 
  }));
}

console.log(JSON.stringify({ type: 'message_end' }));
`;

fs.writeFileSync(fakeCLIPath, fakeCliScript);
fs.chmodSync(fakeCLIPath, 0o755);

// 确保localStats可用
let localStats;
try {
  localStats = require('./client/electron/local-stats');
  const STATS_DIR = path.join(os.homedir(), '.tokenbank', 'stats');
  fs.mkdirSync(STATS_DIR, { recursive: true });
  const db = localStats.requireDb(STATS_DIR);
  console.log('✓ 数据库初始化成功\n');
} catch (e) {
  console.error('✗ 数据库初始化失败:', e.message);
  process.exit(1);
}

// 劫持AGENT_CLI配置，注入fake-cli
const Module = require('module');
const originalRequire = Module.prototype.require;
let agentExecutor = null;

Module.prototype.require = function(id) {
  const result = originalRequire.apply(this, arguments);
  
  if (id === './agent-executor' || id.endsWith('/agent-executor.js') || id.includes('agent-executor')) {
    if (!agentExecutor) {
      agentExecutor = result;
      console.log('✓ Agent executor模块已加载\n');
    }
    return result;
  }
  
  return result;
};

// 导入模块（触发劫持）
const agentHttp = require('./client/electron/agent-http');
const executor = require('./client/electron/agent-executor');

// 劫持_resolveLaunchSpec方法
const originalResolve = executor._resolveLaunchSpec.bind(executor);
executor._resolveLaunchSpec = function(agentId) {
  if (agentId === 'fake-cli') {
    return { executable: fakeCLIPath, argPrefix: [], detectCommand: 'fake-cli' };
  }
  return originalResolve(agentId);
};

// 劫持resolveAgentId方法
const originalResolveId = executor.resolveAgentId.bind(executor);
executor.resolveAgentId = async function(agentId) {
  if (agentId === 'fake-cli') {
    return 'fake-cli';
  }
  return originalResolveId(agentId);
};

console.log('✓ Agent executor已劫持fake-cli\n');

// HTTP服务器
let server;
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      if (req.url === '/v1/agent/responses' && req.method === 'POST') {
        await agentHttp.handle(req, res, { 
          method: 'POST', 
          cleanPath: '/v1/agent/responses',
          knownKey: () => true 
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, () => {
      const port = server.address().port;
      console.log(`✓ HTTP server listening on port ${port}\n`);
      resolve(port);
    });
  });
}

// 调用agent-http
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
async function waitForTask(taskId, timeoutMs = 30000) {
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
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('Task timeout');
}

// 测试用例
const tests = [];

async function runTests() {
  const port = await startServer();
  
  try {
    // ========== 测试1: hired首轮调用（绘图任务）==========
    console.log('测试1: hired首轮调用（绘图任务，验证workspace+产物过滤）');
    const resp1 = await callAgentHttp(port, {
      harness_id: 'fake-cli',
      input: '画一幅山水画',
      metadata: {
        assistant_id: 'artist-bot',
        consumer_key: 'u100',
        call_context: 'hired',
      },
    });
    
    if (resp1.status !== 200) {
      console.error(`✗ 请求失败: ${resp1.status}`, resp1.body);
      tests.push({ name: '首轮hired调用', pass: false });
    } else {
      const task = await waitForTask(resp1.body.id);
      const ws1 = task.result?.workspaceSessionId;
      const artifacts = task.result?.artifacts || [];
      
      console.log(`  response_id: ${resp1.body.id}`);
      console.log(`  workspace_session: ${ws1}`);
      console.log(`  artifacts: ${artifacts.length} 个`);
      console.log(`  工作目录: ${task.context?.workingDir || '(未知)'}`);
      
      const hasImage = artifacts.some(a => a.name === 'output.png');
      const hasPackage = artifacts.some(a => a.name === 'package.json');
      
      console.log(`  收集output.png: ${hasImage ? '✓' : '✗'}`);
      console.log(`  排除package.json: ${!hasPackage ? '✓' : '✗ 误收'}`);
      console.log(`  workspace目录存在: ${task.context?.workingDir && fs.existsSync(task.context.workingDir) ? '✓' : '✗'}`);
      
      tests.push({
        name: '首轮hired调用+产物过滤',
        pass: hasImage && !hasPackage && ws1 && task.context?.workingDir,
        taskId: resp1.body.id,
        ws: ws1,
      });
    }
    console.log('');
    
    // ========== 测试2: 续会话（相同cwd）==========
    console.log('测试2: 续会话（相同consumer，previous_response_id）');
    const test1 = tests.find(t => t.name === '首轮hired调用+产物过滤');
    if (!test1 || !test1.pass) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      const resp2 = await callAgentHttp(port, {
        harness_id: 'fake-cli',
        input: '再画一幅',
        previous_response_id: test1.taskId,
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u100',
          call_context: 'hired',
        },
      });
      
      if (resp2.status !== 200) {
        console.error(`✗ 请求失败: ${resp2.status}`, resp2.body);
        tests.push({ name: '续会话目录一致', pass: false });
      } else {
        const task = await waitForTask(resp2.body.id);
        const ws2 = task.result?.workspaceSessionId;
        
        console.log(`  workspace_session: ${ws2}`);
        console.log(`  会话一致: ${test1.ws === ws2 ? '✓' : '✗'}`);
        
        tests.push({
          name: '续会话目录一致',
          pass: test1.ws === ws2,
        });
      }
    }
    console.log('');
    
    // ========== 测试3: 跨consumer拒绝 ==========
    console.log('测试3: 跨consumer尝试续用会话（应拒绝403）');
    if (!test1 || !test1.pass) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      const resp3 = await callAgentHttp(port, {
        harness_id: 'fake-cli',
        input: '继续',
        previous_response_id: test1.taskId,
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u200',  // 不同consumer
          call_context: 'hired',
        },
      });
      
      const rejected = resp3.status === 403;
      console.log(`  HTTP状态: ${resp3.status}`);
      console.log(`  拒绝跨consumer: ${rejected ? '✓' : '✗ 允许了越权'}`);
      
      tests.push({
        name: '跨consumer拒绝',
        pass: rejected,
        security: true,
      });
    }
    console.log('');
    
    // ========== 测试4: 跨call_context拒绝 ==========
    console.log('测试4: 跨call_context续用会话（hired → local，应拒绝403）');
    if (!test1 || !test1.pass) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      const resp4 = await callAgentHttp(port, {
        harness_id: 'fake-cli',
        input: '继续',
        previous_response_id: test1.taskId,
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u100',
          call_context: 'local',  // 尝试从hired切换到local
        },
      });
      
      const rejected = resp4.status === 403;
      console.log(`  HTTP状态: ${resp4.status}`);
      console.log(`  拒绝跨context: ${rejected ? '✓' : '✗ 允许了切换'}`);
      
      tests.push({
        name: '跨call_context拒绝',
        pass: rejected,
        security: true,
      });
    }
    console.log('');
    
    // ========== 测试5: local调用不收集产物 ==========
    console.log('测试5: local调用（不收集产物）');
    const resp5 = await callAgentHttp(port, {
      harness_id: 'fake-cli',
      input: '画图',
      metadata: {
        call_context: 'local',
      },
    });
    
    if (resp5.status !== 200) {
      console.error(`✗ 请求失败: ${resp5.status}`, resp5.body);
      tests.push({ name: 'local不收集产物', pass: false });
    } else {
      const task = await waitForTask(resp5.body.id);
      const artifacts = task.result?.artifacts || [];
      const ws = task.result?.workspaceSessionId;
      
      console.log(`  artifacts: ${artifacts.length} 个`);
      console.log(`  workspace_session: ${ws || '(无)'}`);
      console.log(`  local不收集: ${artifacts.length === 0 ? '✓' : '✗ 泄漏了产物'}`);
      
      tests.push({
        name: 'local不收集产物',
        pass: artifacts.length === 0,
        security: true,
      });
    }
    console.log('');
    
    // ========== 测试6: hired缺失consumer拒绝 ==========
    console.log('测试6: hired缺失consumer_key（应拒绝400）');
    const resp6 = await callAgentHttp(port, {
      harness_id: 'fake-cli',
      input: '画图',
      metadata: {
        assistant_id: 'artist-bot',
        // 缺少consumer_key
        call_context: 'hired',
      },
    });
    
    const rejected6 = resp6.status === 400;
    console.log(`  HTTP状态: ${resp6.status}`);
    console.log(`  拒绝无consumer: ${rejected6 ? '✓' : '✗ 允许了匿名hired'}`);
    
    tests.push({
      name: 'hired缺失consumer拒绝',
      pass: rejected6,
      security: true,
    });
    console.log('');
    
  } finally {
    server.close();
  }
  
  // ========== 总结 ==========
  console.log('=== 测试结果 ===\n');
  
  const security = tests.filter(t => t.security);
  const functional = tests.filter(t => !t.security);
  
  console.log('安全检查:');
  security.forEach(t => {
    console.log(`  ${t.pass ? '✓' : '✗'} ${t.name}`);
  });
  console.log('');
  
  console.log('功能测试:');
  functional.forEach(t => {
    console.log(`  ${t.pass ? '✓' : '✗'} ${t.name}`);
  });
  console.log('');
  
  const allPassed = tests.every(t => t.pass);
  const securityPassed = security.every(t => t.pass);
  
  if (!securityPassed) {
    console.error('✗ 安全检查失败！');
    process.exit(1);
  }
  if (!allPassed) {
    console.warn('⚠ 部分功能测试失败');
    process.exit(1);
  }
  
  console.log('✓ 所有测试通过');
  process.exit(0);
}

runTests().catch(e => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
