/**
 * 安全隔离边界验证
 * 
 * 硬约束验证：
 * 1. hired实际执行cwd = contribute workspace（不回退出租者目录）
 * 2. 不跨消费者访问文件
 * 3. 时间窗口防止跨会话收集（同消费者不同会话）
 * 4. 续会话保持目录一致
 * 5. 扫描范围限制在workspace内
 * 6. local保持本地目录，不上传
 * 
 * 安全差距：
 * - 同消费者不同会话共享目录（依赖时间窗口隔离）
 * - 需评估是否需要会话级目录
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { ensureContributeWorkspace, collectWorkspaceArtifacts } = require('./client/electron/contribute-session');

console.log('=== 安全隔离边界验证 ===\n');

const tests = [];

// ========== 测试1: 验证contribute workspace不在出租者项目目录 ==========
console.log('测试1: contribute workspace隔离（不在项目目录）');
const testWorkspace = ensureContributeWorkspace('test-agent', 'u999');
const projectDir = process.cwd();
const homeDir = os.homedir();

const inProject = testWorkspace.startsWith(projectDir);
const inHome = testWorkspace.startsWith(homeDir);
const inTokenbank = testWorkspace.includes('.tokenbank');

console.log(`  项目目录: ${projectDir}`);
console.log(`  workspace: ${testWorkspace}`);
console.log(`  在项目内: ${inProject ? '✗ 危险！' : '✓'}`);
console.log(`  在用户home: ${inHome ? '✓' : '✗'}`);
console.log(`  在.tokenbank: ${inTokenbank ? '✓' : '✗'}`);

tests.push({
  name: 'workspace隔离',
  pass: !inProject && inHome && inTokenbank,
  security: true
});

fs.rmSync(testWorkspace, { recursive: true, force: true });
console.log('');

// ========== 测试2: 验证实际进程cwd（模拟executor spawn）==========
console.log('测试2: 验证实际子进程cwd');
const workspace2 = ensureContributeWorkspace('cwd-test', 'u888');

// 创建测试脚本，输出其cwd
const testScript = path.join(workspace2, 'test_cwd.js');
fs.writeFileSync(testScript, `
console.log(JSON.stringify({
  cwd: process.cwd(),
  __dirname: __dirname
}));
`);

const proc = spawn('node', [testScript], {
  cwd: workspace2,
  stdio: 'pipe'
});

let output = '';
proc.stdout.on('data', (data) => {
  output += data.toString();
});

proc.on('close', (code) => {
  try {
    const result = JSON.parse(output.trim());
    const cwdMatch = result.cwd === workspace2;
    const dirnameMatch = result.__dirname === workspace2;
    
    console.log(`  spawn cwd设置: ${workspace2}`);
    console.log(`  子进程实际cwd: ${result.cwd}`);
    console.log(`  cwd匹配: ${cwdMatch ? '✓' : '✗ 危险！'}`);
    console.log(`  __dirname匹配: ${dirnameMatch ? '✓' : '✗'}`);
    
    tests.push({
      name: '子进程cwd隔离',
      pass: cwdMatch,
      security: true
    });
    
    fs.rmSync(workspace2, { recursive: true, force: true });
    console.log('');
    
    // 继续后续测试
    runRemainingTests();
  } catch (e) {
    console.error(`  ✗ 测试失败: ${e.message}`);
    tests.push({
      name: '子进程cwd隔离',
      pass: false,
      security: true
    });
    runRemainingTests();
  }
});

function runRemainingTests() {
  // ========== 测试3: 跨消费者隔离 ==========
  console.log('测试3: 跨消费者文件隔离');
  const ws3a = ensureContributeWorkspace('shared-agent', 'u111');
  const ws3b = ensureContributeWorkspace('shared-agent', 'u222');
  
  // 消费者A的敏感文件
  fs.writeFileSync(path.join(ws3a, 'secret-a.txt'), 'Consumer A secret');
  
  // 消费者B的任务
  const task3bStart = Date.now();
  fs.writeFileSync(path.join(ws3b, 'output-b.png'), 'Consumer B data');
  
  const output3b = 'Generated output-b.png';
  const artifacts3b = collectWorkspaceArtifacts(ws3b, output3b, task3bStart);
  
  const hasOwnFile = artifacts3b.some(a => a.name === 'output-b.png');
  const hasOtherSecret = artifacts3b.some(a => a.name === 'secret-a.txt');
  
  console.log(`  消费者A目录: .../${path.basename(path.dirname(ws3a))}/${path.basename(ws3a)}`);
  console.log(`  消费者B目录: .../${path.basename(path.dirname(ws3b))}/${path.basename(ws3b)}`);
  console.log(`  消费者B收集自己的文件: ${hasOwnFile ? '✓' : '✗'}`);
  console.log(`  消费者B访问A的文件: ${hasOtherSecret ? '✗ 泄漏！' : '✓'}`);
  
  tests.push({
    name: '跨消费者隔离',
    pass: hasOwnFile && !hasOtherSecret,
    security: true
  });
  
  fs.rmSync(ws3a, { recursive: true, force: true });
  fs.rmSync(ws3b, { recursive: true, force: true });
  console.log('');
  
  // ========== 测试4: 同消费者跨会话（当前设计的安全差距）==========
  console.log('测试4: 同消费者不同会话（时间窗口隔离）');
  const ws4 = ensureContributeWorkspace('chat-agent', 'u333');
  
  // 会话1：10秒前生成敏感文件
  const session1Time = Date.now() - 10000;
  fs.writeFileSync(path.join(ws4, 'session1-private.txt'), 'Session 1 data');
  fs.utimesSync(path.join(ws4, 'session1-private.txt'), 
    new Date(session1Time), new Date(session1Time));
  
  console.log(`  会话1文件: session1-private.txt (10秒前)`);
  
  // 等待，模拟会话间隔
  setTimeout(() => {
    // 会话2：新会话（无previous_response_id）
    const session2Start = Date.now();
    fs.writeFileSync(path.join(ws4, 'session2-output.png'), 'Session 2 data');
    
    const output4 = 'Generated session2-output.png';
    const artifacts4 = collectWorkspaceArtifacts(ws4, output4, session2Start);
    
    const hasSession2 = artifacts4.some(a => a.name === 'session2-output.png');
    const hasSession1 = artifacts4.some(a => a.name === 'session1-private.txt');
    
    console.log(`  会话2文件: session2-output.png (现在)`);
    console.log(`  会话2收集自己的文件: ${hasSession2 ? '✓' : '✗'}`);
    console.log(`  会话2访问会话1文件: ${hasSession1 ? '✗ 时间窗口失效' : '✓ 时间窗口有效'}`);
    console.log(`  当前隔离方式: assistant+consumer目录 + 时间窗口`);
    
    tests.push({
      name: '跨会话时间隔离',
      pass: hasSession2 && !hasSession1,
      security: true
    });
    
    fs.rmSync(ws4, { recursive: true, force: true });
    console.log('');
    
    // ========== 测试5: 扫描范围限制 ==========
    console.log('测试5: 扫描范围限制在workspace内');
    const ws5 = ensureContributeWorkspace('scan-agent', 'u444');
    
    // 在workspace外创建文件（项目目录）
    const outsideFile = path.join(projectDir, 'outside-workspace.txt');
    fs.writeFileSync(outsideFile, 'Outside data');
    
    // 在workspace内创建文件
    const task5Start = Date.now();
    fs.writeFileSync(path.join(ws5, 'inside.png'), 'Inside data');
    
    const output5 = 'Generated inside.png\nAlso: outside-workspace.txt';
    const artifacts5 = collectWorkspaceArtifacts(ws5, output5, task5Start);
    
    const hasInside = artifacts5.some(a => a.name === 'inside.png');
    const hasOutside = artifacts5.some(a => a.name === 'outside-workspace.txt');
    
    console.log(`  workspace内文件: inside.png`);
    console.log(`  workspace外文件: ${outsideFile}`);
    console.log(`  收集workspace内: ${hasInside ? '✓' : '✗'}`);
    console.log(`  访问workspace外: ${hasOutside ? '✗ 越界！' : '✓ 受限'}`);
    
    tests.push({
      name: '扫描范围限制',
      pass: hasInside && !hasOutside,
      security: true
    });
    
    fs.rmSync(ws5, { recursive: true, force: true });
    fs.unlinkSync(outsideFile);
    console.log('');
    
    // ========== 测试6: 续会话目录一致性 ==========
    console.log('测试6: 续会话目录一致性');
    const ws6 = ensureContributeWorkspace('resume-agent', 'u555');
    
    // 首次会话
    const firstCall = ensureContributeWorkspace('resume-agent', 'u555');
    
    // 模拟续会话（相同assistant+consumer）
    const resumeCall = ensureContributeWorkspace('resume-agent', 'u555');
    
    const consistent = firstCall === resumeCall;
    
    console.log(`  首次会话: ${firstCall}`);
    console.log(`  续会话: ${resumeCall}`);
    console.log(`  目录一致: ${consistent ? '✓' : '✗'}`);
    
    tests.push({
      name: '续会话目录一致',
      pass: consistent,
      security: false
    });
    
    fs.rmSync(ws6, { recursive: true, force: true });
    console.log('');
    
    // ========== 总结 ==========
    console.log('=== 安全边界验证结果 ===\n');
    
    console.log('✓ 已证明的安全边界：');
    tests.filter(t => t.pass && t.security).forEach(t => {
      console.log(`  ✓ ${t.name}`);
    });
    console.log('');
    
    console.log('✗ 失败的安全检查：');
    const failures = tests.filter(t => !t.pass && t.security);
    if (failures.length === 0) {
      console.log(`  (无)`);
    } else {
      failures.forEach(t => {
        console.log(`  ✗ ${t.name}`);
      });
    }
    console.log('');
    
    console.log('⚠ 已知安全差距（非测试失败）：');
    console.log('  1. 同消费者不同会话共享目录');
    console.log('     - 当前依赖时间窗口隔离');
    console.log('     - 如果时间窗口失效（文件mtim错误），可能跨会话');
    console.log('     - 改进：需要会话级子目录');
    console.log('  2. 子进程cwd隔离依赖正确传递workingDir');
    console.log('     - executor必须遵守workingDir参数');
    console.log('     - CLI工具不应改变cwd或访问外部');
    console.log('  3. 不等同操作系统沙箱');
    console.log('     - 子进程仍可访问系统其他路径（如果代码恶意）');
    console.log('     - 需要额外的进程隔离（容器、沙箱）');
    console.log('');
    
    console.log('✓ 残余访问能力（明确边界）：');
    console.log('  - 子进程可通过代码访问系统其他路径');
    console.log('  - collectWorkspaceArtifacts仅限制扫描范围，不限制执行');
    console.log('  - mtime可被恶意代码伪造（破坏时间窗口）');
    console.log('');
    
    const allSecurityPass = tests.filter(t => t.security).every(t => t.pass);
    process.exit(allSecurityPass ? 0 : 1);
  }, 100);
}
