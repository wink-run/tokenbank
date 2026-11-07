#!/usr/bin/env node
/**
 * 真实agent-http + executor集成测试
 * 
 * 使用PATH中的fake claude命令，测试完整的HTTP handler + executor + spawn流程
 * 验证：
 * 1. hired真实spawn cwd
 * 2. 续聊相同cwd/session
 * 3. DB重建后续聊保持
 * 4. 跨consumer/assistant/context拒绝且无spawn
 * 5. local不收集产物
 * 6. 产物从子目录basename收集
 * 7. 绘图排除所有依赖文件
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

// 测试根目录
const testRoot = path.join(os.tmpdir(), `test-agent-real-${Date.now()}`);
const fakeCLIDir = path.join(testRoot, 'bin');
const fakeCLIPath = path.join(fakeCLIDir, 'claude');
const dbDir = path.join(testRoot, 'stats');

console.log('=== 真实agent-http + executor集成测试 ===');
console.log(`测试目录: ${testRoot}`);
console.log(`fake CLI: ${fakeCLIPath}`);
console.log(`DB目录: ${dbDir}\n`);

// 创建fake CLI
fs.mkdirSync(fakeCLIDir, { recursive: true });
fs.mkdirSync(dbDir, { recursive: true });

// Fake claude CLI：模拟stream-json输出
const fakeCLIScript = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cwd = process.cwd();
const sessionId = 'sess-' + crypto.randomBytes(4).toString('hex');
const args = process.argv.slice(2);

// 记录spawn到文件（测试验证用）
const spawnLog = path.join('${testRoot}', 'spawn-log.txt');
fs.appendFileSync(spawnLog, JSON.stringify({ cwd, sessionId, args, timestamp: Date.now() }) + '\\n');

// 输出stream-json
console.log(JSON.stringify({ type: 'metadata', session_id: sessionId }));
console.log(JSON.stringify({ type: 'message_start' }));

const prompt = args[args.length - 1] || '';
const isDrawing = /画|图|draw|image/i.test(prompt);

if (isDrawing) {
  // 绘图任务：子目录中的图片 + 依赖文件
  const subdir = path.join(cwd, 'output');
  fs.mkdirSync(subdir, { recursive: true });
  
  // 图片在子目录
  fs.writeFileSync(path.join(subdir, 'drawing.png'), Buffer.from('fake-png-data'));
  
  // 根目录依赖（应排除）
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'deps-root' }));
  
  // 子目录依赖（也应排除）
  fs.writeFileSync(path.join(subdir, 'package.json'), JSON.stringify({ name: 'deps-sub' }));
  
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
      text: '已生成图片：output/drawing.png\\n工作目录：' + cwd 
    } 
  }));
} else {
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
      text: 'Completed in: ' + cwd 
    } 
  }));
}

console.log(JSON.stringify({ type: 'message_end' }));
`;

fs.writeFileSync(fakeCLIPath, fakeCLIScript);
fs.chmodSync(fakeCLIPath, 0o755);

// 清空spawn日志
fs.writeFileSync(path.join(testRoot, 'spawn-log.txt'), '');

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

// 读取spawn日志
function getSpawnLogs() {
  const logPath = path.join(testRoot, 'spawn-log.txt');
  if (!fs.existsSync(logPath)) return [];
  const content = fs.readFileSync(logPath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
}

// 清空spawn日志
function clearSpawnLogs() {
  fs.writeFileSync(path.join(testRoot, 'spawn-log.txt'), '');
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

// 测试结果
const tests = [];
function addTest(name, pass, security = false) {
  tests.push({ name, pass, security });
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
    // ========== 测试1: hired首轮spawn cwd ==========
    console.log('测试1: hired首轮调用 - 验证spawn cwd');
    clearSpawnLogs();
    
    const resp1 = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '画一幅山水画',
      metadata: {
        assistant_id: 'artist-bot',
        consumer_key: 'u100',
        call_context: 'hired',
      },
    });
    
    if (resp1.status !== 200) {
      console.error(`  请求失败: ${resp1.status}`, resp1.body.error?.message || resp1.body);
      addTest('首轮hired spawn', false);
    } else {
      const task1 = await waitForTask(resp1.body.id);
      const spawns1 = getSpawnLogs();
      const ws1 = task1.result?.workspaceSessionId;
      const artifacts = task1.result?.artifacts || [];
      
      console.log(`  task_id: ${resp1.body.id}`);
      console.log(`  spawn次数: ${spawns1.length}`);
      console.log(`  spawn cwd: ${spawns1[0]?.cwd || '(无)'}`);
      console.log(`  workspace_session: ${ws1}`);
      console.log(`  artifacts: ${artifacts.length} 个`);
      
      const hasImage = artifacts.some(a => a.name === 'drawing.png');
      const hasRootPkg = artifacts.some(a => a.name === 'package.json');
      const cwdMatches = spawns1.length === 1 && spawns1[0].cwd && spawns1[0].cwd.includes('artist-bot') && spawns1[0].cwd.includes('u100');
      
      addTest('spawn一次', spawns1.length === 1);
      addTest('spawn cwd正确', cwdMatches);
      addTest('收集子目录图片', hasImage);
      addTest('排除根目录package.json', !hasRootPkg, true);
      
      // 验证子目录package.json也被排除
      const hasSubPkg = artifacts.some(a => a.localPath && a.localPath.includes('output') && a.name === 'package.json');
      addTest('排除子目录package.json', !hasSubPkg, true);
      
      // 保存用于后续测试
      tests.task1Id = resp1.body.id;
      tests.ws1 = ws1;
      tests.cwd1 = spawns1[0]?.cwd;
    }
    console.log('');
    
    // ========== 测试2: 续聊相同cwd ==========
    console.log('测试2: 续聊相同consumer - 验证相同cwd');
    if (!tests.task1Id) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      clearSpawnLogs();
      
      const resp2 = await callAgentHttp(port, {
        harness_id: 'claude-code',
        input: '再画一幅',
        previous_response_id: tests.task1Id,
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u100',
          call_context: 'hired',
        },
      });
      
      if (resp2.status !== 200) {
        console.error(`  请求失败: ${resp2.status}`, resp2.body.error?.message || resp2.body);
        addTest('续聊spawn', false);
      } else {
        const task2 = await waitForTask(resp2.body.id);
        const spawns2 = getSpawnLogs();
        const ws2 = task2.result?.workspaceSessionId;
        
        console.log(`  workspace_session: ${ws2}`);
        console.log(`  spawn cwd: ${spawns2[0]?.cwd || '(无)'}`);
        console.log(`  会话一致: ${tests.ws1 === ws2 ? 'yes' : 'no'}`);
        console.log(`  cwd一致: ${tests.cwd1 === spawns2[0]?.cwd ? 'yes' : 'no'}`);
        
        addTest('续聊session一致', tests.ws1 === ws2);
        addTest('续聊cwd一致', tests.cwd1 === spawns2[0]?.cwd);
        
        tests.task2Id = resp2.body.id;
      }
    }
    console.log('');
    
    // ========== 测试3: DB重建后续聊保持 ==========
    console.log('测试3: DB重建后续聊 - 验证持久化context');
    if (!tests.task1Id) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      // 重新初始化executor（模拟进程重启）
      const newExecutor = new (Object.getPrototypeOf(executor).constructor)();
      
      // 验证getTaskStatus能读出context
      const task1 = await newExecutor.getTaskStatus(tests.task1Id);
      const ctx = task1.context || {};
      
      console.log(`  context.assistantId: ${ctx.assistantId || '(无)'}`);
      console.log(`  context.consumerKey: ${ctx.consumerKey || '(无)'}`);
      console.log(`  context.callContext: ${ctx.callContext || '(无)'}`);
      
      addTest('持久化assistantId', ctx.assistantId === 'artist-bot');
      addTest('持久化consumerKey', ctx.consumerKey === 'u100');
      addTest('持久化callContext', ctx.callContext === 'hired');
      
      // 续聊应该仍然能用相同目录
      clearSpawnLogs();
      const resp3 = await callAgentHttp(port, {
        harness_id: 'claude-code',
        input: '继续',
        previous_response_id: tests.task1Id,
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u100',
          call_context: 'hired',
        },
      });
      
      if (resp3.status === 200) {
        const task3 = await waitForTask(resp3.body.id);
        const spawns3 = getSpawnLogs();
        addTest('DB重建后续聊cwd保持', spawns3[0]?.cwd === tests.cwd1);
      } else {
        addTest('DB重建后续聊cwd保持', false);
      }
    }
    console.log('');
    
    // ========== 测试4: 跨consumer拒绝 ==========
    console.log('测试4: 跨consumer续用 - 验证拒绝且无spawn');
    if (!tests.task1Id) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      clearSpawnLogs();
      
      const resp4 = await callAgentHttp(port, {
        harness_id: 'claude-code',
        input: '继续',
        previous_response_id: tests.task1Id,
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u200',  // 不同consumer
          call_context: 'hired',
        },
      });
      
      const spawns4 = getSpawnLogs();
      console.log(`  HTTP状态: ${resp4.status}`);
      console.log(`  spawn次数: ${spawns4.length}`);
      
      addTest('跨consumer返回403', resp4.status === 403, true);
      addTest('跨consumer无spawn', spawns4.length === 0, true);
    }
    console.log('');
    
    // ========== 测试5: 跨assistant拒绝 ==========
    console.log('测试5: 跨assistant续用 - 验证拒绝且无spawn');
    if (!tests.task1Id) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      clearSpawnLogs();
      
      const resp5 = await callAgentHttp(port, {
        harness_id: 'claude-code',
        input: '继续',
        previous_response_id: tests.task1Id,
        metadata: {
          assistant_id: 'coder-bot',  // 不同assistant
          consumer_key: 'u100',
          call_context: 'hired',
        },
      });
      
      const spawns5 = getSpawnLogs();
      console.log(`  HTTP状态: ${resp5.status}`);
      console.log(`  spawn次数: ${spawns5.length}`);
      
      addTest('跨assistant返回403', resp5.status === 403, true);
      addTest('跨assistant无spawn', spawns5.length === 0, true);
    }
    console.log('');
    
    // ========== 测试6: 跨call_context拒绝 ==========
    console.log('测试6: 跨call_context续用 - 验证拒绝且无spawn');
    if (!tests.task1Id) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      clearSpawnLogs();
      
      const resp6 = await callAgentHttp(port, {
        harness_id: 'claude-code',
        input: '继续',
        previous_response_id: tests.task1Id,
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u100',
          call_context: 'local',  // 切换context
        },
      });
      
      const spawns6 = getSpawnLogs();
      console.log(`  HTTP状态: ${resp6.status}`);
      console.log(`  spawn次数: ${spawns6.length}`);
      
      addTest('跨context返回403', resp6.status === 403, true);
      addTest('跨context无spawn', spawns6.length === 0, true);
    }
    console.log('');
    
    // ========== 测试7: 缺失current信息拒绝 ==========
    console.log('测试7: hired缺失consumer_key - 验证拒绝且无spawn');
    clearSpawnLogs();
    
    const resp7 = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '画图',
      metadata: {
        assistant_id: 'artist-bot',
        // 缺少consumer_key
        call_context: 'hired',
      },
    });
    
    const spawns7 = getSpawnLogs();
    console.log(`  HTTP状态: ${resp7.status}`);
    console.log(`  spawn次数: ${spawns7.length}`);
    
    addTest('缺consumer返回400', resp7.status === 400, true);
    addTest('缺consumer无spawn', spawns7.length === 0, true);
    console.log('');
    
    // ========== 测试8: previous_response_id不存在拒绝 ==========
    console.log('测试8: previous_response_id不存在 - 验证拒绝且无spawn');
    clearSpawnLogs();
    
    const resp8 = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '继续',
      previous_response_id: 'task_nonexistent_12345678',
      metadata: {
        assistant_id: 'artist-bot',
        consumer_key: 'u100',
        call_context: 'hired',
      },
    });
    
    const spawns8 = getSpawnLogs();
    console.log(`  HTTP状态: ${resp8.status}`);
    console.log(`  spawn次数: ${spawns8.length}`);
    
    addTest('不存在返回400', resp8.status === 400, true);
    addTest('不存在无spawn', spawns8.length === 0, true);
    console.log('');
    
    // ========== 测试9: local不收集产物 ==========
    console.log('测试9: local调用默认目录 - 验证不收集产物');
    clearSpawnLogs();
    
    const resp9 = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '画图',
      metadata: {
        call_context: 'local',
      },
    });
    
    if (resp9.status !== 200) {
      console.error(`  请求失败: ${resp9.status}`, resp9.body.error?.message || resp9.body);
      addTest('local不收集', false);
    } else {
      const task9 = await waitForTask(resp9.body.id);
      const artifacts = task9.result?.artifacts || [];
      
      console.log(`  artifacts: ${artifacts.length} 个`);
      console.log(`  workspace_session: ${task9.result?.workspaceSessionId || '(无)'}`);
      
      addTest('local不收集产物', artifacts.length === 0, true);
      addTest('local无workspace_session', !task9.result?.workspaceSessionId);
    }
    console.log('');
    
    // ========== 测试9b: local显式working_dir ==========
    console.log('测试9b: local显式working_dir - 验证spawn cwd');
    clearSpawnLogs();
    
    const localExplicitDir = path.join(testRoot, 'local-explicit-' + Date.now());
    fs.mkdirSync(localExplicitDir, { recursive: true });
    
    const resp9b = await callAgentHttp(port, {
      harness_id: 'claude-code',
      input: '画图',
      metadata: {
        call_context: 'local',
        working_dir: localExplicitDir,
      },
    });
    
    if (resp9b.status !== 200) {
      console.error(`  请求失败: ${resp9b.status}`, resp9b.body.error?.message || resp9b.body);
      addTest('local显式目录spawn', false);
    } else {
      const task9b = await waitForTask(resp9b.body.id);
      const spawns9b = getSpawnLogs();
      const artifacts9b = task9b.result?.artifacts || [];
      
      console.log(`  显式目录: ${localExplicitDir}`);
      console.log(`  spawn cwd: ${spawns9b[0]?.cwd || '(无)'}`);
      console.log(`  cwd匹配: ${spawns9b[0]?.cwd === localExplicitDir ? 'yes' : 'no'}`);
      console.log(`  artifacts: ${artifacts9b.length} 个`);
      console.log(`  workspace_session: ${task9b.result?.workspaceSessionId || '(无)'}`);
      
      addTest('local显式cwd正确', spawns9b[0]?.cwd === localExplicitDir);
      addTest('local显式不收集', artifacts9b.length === 0, true);
      addTest('local显式无hired workspace', !task9b.result?.workspaceSessionId, true);
    }
    console.log('');
    
    // ========== 测试10: 缺旧prev授权字段拒绝 ==========
    console.log('测试10: 续用旧任务（缺context字段）- 验证fail closed');
    if (!tests.task1Id) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      // 模拟旧数据：直接修改DB，删除context字段
      const db = executor._getDb();
      db.prepare('UPDATE agent_tasks SET context = ? WHERE id = ?').run(null, tests.task1Id);
      
      clearSpawnLogs();
      
      const resp10 = await callAgentHttp(port, {
        harness_id: 'claude-code',
        input: '继续',
        previous_response_id: tests.task1Id,
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u100',
          call_context: 'hired',
        },
      });
      
      const spawns10 = getSpawnLogs();
      console.log(`  HTTP状态: ${resp10.status}`);
      console.log(`  spawn次数: ${spawns10.length}`);
      
      addTest('缺prev context返回403', resp10.status === 403, true);
      addTest('缺prev context无spawn', spawns10.length === 0, true);
      
      // 恢复context以便后续测试
      const ctx = { workingDir: tests.cwd1, assistantId: 'artist-bot', consumerKey: 'u100', callContext: 'hired' };
      db.prepare('UPDATE agent_tasks SET context = ? WHERE id = ?').run(JSON.stringify(ctx), tests.task1Id);
    }
    console.log('');
    
    // ========== 测试11: 新会话不同目录 ==========
    console.log('测试11: 同consumer新会话 - 验证不同目录');
    if (!tests.cwd1) {
      console.log('  ⊘ 跳过（测试1未通过）\n');
    } else {
      clearSpawnLogs();
      
      const resp11 = await callAgentHttp(port, {
        harness_id: 'claude-code',
        input: '画肖像画',
        // 无previous_response_id
        metadata: {
          assistant_id: 'artist-bot',
          consumer_key: 'u100',
          call_context: 'hired',
        },
      });
      
      if (resp11.status !== 200) {
        console.error(`  请求失败: ${resp11.status}`, resp11.body.error?.message || resp11.body);
        addTest('新会话不同目录', false);
      } else {
        const task11 = await waitForTask(resp11.body.id);
        const spawns11 = getSpawnLogs();
        
        console.log(`  新会话cwd: ${spawns11[0]?.cwd || '(无)'}`);
        console.log(`  与task1不同: ${tests.cwd1 !== spawns11[0]?.cwd ? 'yes' : 'no'}`);
        
        addTest('新会话不同目录', tests.cwd1 !== spawns11[0]?.cwd, true);
      }
    }
    console.log('');
    
  } finally {
    server.close();
  }
  
  // ========== 总结 ==========
  console.log('=== 测试结果 ===\n');
  
  const security = tests.filter(t => typeof t === 'object' && t.security);
  const functional = tests.filter(t => typeof t === 'object' && !t.security);
  
  console.log(`安全检查 (${security.filter(t => t.pass).length}/${security.length}):`);
  security.forEach(t => {
    console.log(`  ${t.pass ? '✓' : '✗'} ${t.name}`);
  });
  console.log('');
  
  console.log(`功能测试 (${functional.filter(t => t.pass).length}/${functional.length}):`);
  functional.forEach(t => {
    console.log(`  ${t.pass ? '✓' : '✗'} ${t.name}`);
  });
  console.log('');
  
  const allPassed = tests.filter(t => typeof t === 'object').every(t => t.pass);
  const securityPassed = security.every(t => t.pass);
  
  console.log(`总计: ${tests.filter(t => typeof t === 'object').filter(t => t.pass).length}/${tests.filter(t => typeof t === 'object').length} 个测试通过`);
  console.log('');
  
  if (!securityPassed) {
    console.error('✗ 安全检查失败！');
    process.exit(1);
  }
  if (!allPassed) {
    console.warn('⚠ 部分测试失败');
    process.exit(1);
  }
  
  console.log('✓ 所有测试通过');
  process.exit(0);
}

runTests().catch(e => {
  console.error('测试执行失败:', e);
  process.exit(1);
});
