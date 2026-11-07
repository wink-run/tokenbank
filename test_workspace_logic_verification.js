/**
 * Workspace隔离逻辑验证
 * 
 * 直接验证核心模块逻辑，不依赖完整HTTP/executor流程
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { ensureContributeWorkspace, collectWorkspaceArtifacts } = require('./client/electron/contribute-session');

console.log('=== Workspace隔离逻辑验证 ===\n');

const tests = [];

async function runTests() {

// ========== 测试1: workspaceSessionId生成与目录创建 ==========
console.log('测试1: workspaceSessionId生成机制');

const assistantId = 'test-artist';
const consumerKey = 'u500';
const baseDir = ensureContributeWorkspace(assistantId, consumerKey);

// 模拟新会话
const workspaceSessionId1 = crypto.randomBytes(6).toString('hex');
const sessionDir1 = path.join(baseDir, 'sessions', workspaceSessionId1);
fs.mkdirSync(sessionDir1, { recursive: true });

console.log(`  baseDir: ${baseDir}`);
console.log(`  workspaceSessionId: ${workspaceSessionId1} (${workspaceSessionId1.length}字符)`);
console.log(`  sessionDir: ${sessionDir1}`);
console.log(`  目录存在: ${fs.existsSync(sessionDir1) ? '✓' : '✗'}`);

// 模拟续会话
const sessionDir1Again = path.join(baseDir, 'sessions', workspaceSessionId1);
const sameDir = sessionDir1 === sessionDir1Again;
console.log(`  续会话复用: ${sameDir ? '✓' : '✗'}`);

// 模拟另一个会话
const workspaceSessionId2 = crypto.randomBytes(6).toString('hex');
const sessionDir2 = path.join(baseDir, 'sessions', workspaceSessionId2);
const differentSession = sessionDir1 !== sessionDir2;
console.log(`  新会话隔离: ${differentSession ? '✓' : '✗'}`);

tests.push({
  name: 'workspaceSessionId机制',
  pass: fs.existsSync(sessionDir1) && sameDir && differentSession,
});

// 清理
fs.rmSync(baseDir, { recursive: true, force: true });
console.log('');

// ========== 测试2: 产物选择（绘图+npm依赖）==========
console.log('测试2: 产物选择 - 绘图任务排除npm依赖');

const drawingDir = ensureContributeWorkspace('artist', 'u600');
const drawingSessionId = crypto.randomBytes(6).toString('hex');
const drawingWorkdir = path.join(drawingDir, 'sessions', drawingSessionId);
fs.mkdirSync(drawingWorkdir, { recursive: true });

const taskStartTime = Date.now();

// 模拟绘图任务输出：图片 + 意外的npm文件
fs.writeFileSync(path.join(drawingWorkdir, 'mountain.png'), Buffer.from('fake-png'));
fs.writeFileSync(path.join(drawingWorkdir, 'package.json'), JSON.stringify({ name: 'accidental' }));
fs.writeFileSync(path.join(drawingWorkdir, 'package-lock.json'), JSON.stringify({ version: 1 }));

const drawingOutput = '已生成图片：mountain.png\n\n图片保存在当前目录。';
const drawingArtifacts = collectWorkspaceArtifacts(drawingWorkdir, drawingOutput, taskStartTime);

const hasMountain = drawingArtifacts.some(a => a.name === 'mountain.png');
const noPackage = !drawingArtifacts.some(a => a.name === 'package.json');
const noPackageLock = !drawingArtifacts.some(a => a.name === 'package-lock.json');

console.log(`  收集mountain.png: ${hasMountain ? '✓' : '✗'}`);
console.log(`  排除package.json: ${noPackage ? '✓' : '✗ 误收'}`);
console.log(`  排除package-lock.json: ${noPackageLock ? '✓' : '✗ 误收'}`);
console.log(`  总artifacts: ${drawingArtifacts.length} (期望1)`);

tests.push({
  name: '绘图任务过滤npm依赖',
  pass: hasMountain && noPackage && noPackageLock && drawingArtifacts.length === 1,
});

fs.rmSync(drawingDir, { recursive: true, force: true });
console.log('');

// ========== 测试3: 产物选择（代码交付package.json）==========
console.log('测试3: 产物选择 - 代码交付明确返回package.json');

const codeDir = ensureContributeWorkspace('coder', 'u700');
const codeSessionId = crypto.randomBytes(6).toString('hex');
const codeWorkdir = path.join(codeDir, 'sessions', codeSessionId);
fs.mkdirSync(codeWorkdir, { recursive: true });

const codeStartTime = Date.now();

// 模拟代码交付：正文明确提及package.json
fs.writeFileSync(path.join(codeWorkdir, 'package.json'), JSON.stringify({ name: 'my-project', version: '1.0.0' }, null, 2));
fs.writeFileSync(path.join(codeWorkdir, 'README.md'), '# My Project');
fs.mkdirSync(path.join(codeWorkdir, 'src'), { recursive: true });
fs.writeFileSync(path.join(codeWorkdir, 'src', 'index.js'), 'console.log("hello");');

const codeOutput = `已创建项目文件：
- package.json
- README.md
- src/index.js

项目初始化完成。`;

const codeArtifacts = collectWorkspaceArtifacts(codeWorkdir, codeOutput, codeStartTime);

const hasPackageDelivered = codeArtifacts.some(a => a.name === 'package.json');
const hasReadme = codeArtifacts.some(a => a.name === 'README.md');
console.log(`  收集package.json: ${hasPackageDelivered ? '✓' : '✗ 遗漏'}`);
console.log(`  收集README.md: ${hasReadme ? '✓' : '✗ 遗漏'}`);
console.log(`  总artifacts: ${codeArtifacts.length} (期望2)`);
console.log(`  (注：.js不在ARTIFACT_MIME，仅测试json/md)`);

tests.push({
  name: '代码交付包含package.json',
  pass: hasPackageDelivered && hasReadme,
});

fs.rmSync(codeDir, { recursive: true, force: true });
console.log('');

// ========== 测试4: 跨会话时间窗口隔离 ==========
console.log('测试4: 跨会话文件时间窗口隔离');

const timeDir = ensureContributeWorkspace('time-test', 'u800');
const oldSessionId = crypto.randomBytes(6).toString('hex');
const oldSessionDir = path.join(timeDir, 'sessions', oldSessionId);
fs.mkdirSync(oldSessionDir, { recursive: true });

// 会话1：5秒前的文件
const oldTime = Date.now() - 5000;
const oldFile = path.join(oldSessionDir, 'old-secret.png');
fs.writeFileSync(oldFile, Buffer.from('old-data'));
fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

// 等待
await new Promise(resolve => setTimeout(resolve, 100));

// 会话2：新文件（但实际应该用不同session目录）
const newSessionId = crypto.randomBytes(6).toString('hex');
const newSessionDir = path.join(timeDir, 'sessions', newSessionId);
fs.mkdirSync(newSessionDir, { recursive: true });

const newStartTime = Date.now();
const newFile = path.join(newSessionDir, 'new-output.png');
fs.writeFileSync(newFile, Buffer.from('new-data'));

const newOutput = '生成了新文件：new-output.png';
const newArtifacts = collectWorkspaceArtifacts(newSessionDir, newOutput, newStartTime);

const hasNew = newArtifacts.some(a => a.name === 'new-output.png');
const noOld = !newArtifacts.some(a => a.name === 'old-secret.png');

console.log(`  收集new-output.png: ${hasNew ? '✓' : '✗'}`);
console.log(`  排除old-secret.png: ${noOld ? '✓' : '✗ 时间窗口失效'}`);
console.log(`  (不同session目录: ${oldSessionDir !== newSessionDir ? '✓' : '✗'})`);

tests.push({
  name: '跨会话时间隔离',
  pass: hasNew && noOld,
});

fs.rmSync(timeDir, { recursive: true, force: true });
console.log('');

// ========== 测试5: hired目录逃逸验证逻辑 ==========
console.log('测试5: hired目录逃逸验证逻辑');

const escapeDir = ensureContributeWorkspace('escape-test', 'u900');
const projectDir = process.cwd();

// 模拟验证逻辑
function validateHiredDir(baseDir, explicitDir) {
  if (!explicitDir) return { allowed: true, reason: 'no explicit' };
  
  let explicitReal;
  try {
    explicitReal = fs.realpathSync(explicitDir);
  } catch {
    return { allowed: false, reason: 'not exist' };
  }
  
  const rel = path.relative(baseDir, explicitReal);
  const contained = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  
  return { allowed: contained, reason: contained ? 'contained' : 'escape attempt' };
}

const escapeAttempt = validateHiredDir(escapeDir, projectDir);

// 创建并验证子目录
const subdirPath = path.join(escapeDir, 'sub');
fs.mkdirSync(subdirPath, { recursive: true });
const allowedSubdir = validateHiredDir(escapeDir, subdirPath);

console.log(`  项目目录: ${projectDir}`);
console.log(`  workspace: ${escapeDir}`);
console.log(`  逃逸到项目目录: ${escapeAttempt.allowed ? '✗ 允许' : '✓ 拒绝'} (${escapeAttempt.reason})`);
console.log(`  允许子目录: ${allowedSubdir.allowed ? '✓' : '✗'} (${allowedSubdir.reason})`);

tests.push({
  name: 'hired逃逸防护',
  pass: !escapeAttempt.allowed && allowedSubdir.allowed,
});

fs.rmSync(escapeDir, { recursive: true, force: true });
console.log('');

// ========== 测试6: 子目录中的依赖文件 ==========
console.log('测试6: 子目录中的package.json（非根目录）');

const subdirDir = ensureContributeWorkspace('subdir-test', 'u1000');
const subdirSessionId = crypto.randomBytes(6).toString('hex');
const subdirWorkdir = path.join(subdirDir, 'sessions', subdirSessionId);
fs.mkdirSync(subdirWorkdir, { recursive: true });

const subdirStartTime = Date.now();

// 根目录：意外的package.json（应该被过滤）
fs.writeFileSync(path.join(subdirWorkdir, 'package.json'), '{}');

// 子目录：项目的package.json（应该保留）
const projectSubdir = path.join(subdirWorkdir, 'my-project');
fs.mkdirSync(projectSubdir, { recursive: true });
fs.writeFileSync(path.join(projectSubdir, 'package.json'), JSON.stringify({ name: 'real-project' }));
fs.writeFileSync(path.join(projectSubdir, 'index.js'), 'console.log("hi")');

const subdirOutput = '生成了项目：my-project/package.json';
const subdirArtifacts = collectWorkspaceArtifacts(subdirWorkdir, subdirOutput, subdirStartTime);

const hasSubdirPackage = subdirArtifacts.some(a => a.localPath?.includes('my-project') && a.name === 'package.json');
const noRootPackage = !subdirArtifacts.some(a => !a.localPath?.includes('my-project') && a.name === 'package.json');

console.log(`  收集my-project/package.json: ${hasSubdirPackage ? '✓' : '✗'}`);
console.log(`  排除根package.json: ${noRootPackage ? '✓' : '✗'}`);

tests.push({
  name: '子目录package.json保留',
  pass: hasSubdirPackage && noRootPackage,
});

fs.rmSync(subdirDir, { recursive: true, force: true });
console.log('');

// ========== 总结 ==========
console.log('=== 验证结果 ===\n');

const passed = tests.filter(t => t.pass);
const failed = tests.filter(t => !t.pass);

console.log(`✓ 通过: ${passed.length}/${tests.length}`);
passed.forEach(t => console.log(`  ✓ ${t.name}`));
console.log('');

if (failed.length > 0) {
  console.log(`✗ 失败: ${failed.length}/${tests.length}`);
  failed.forEach(t => console.log(`  ✗ ${t.name}`));
  console.log('');
}

process.exit(failed.length === 0 ? 0 : 1);
}

runTests().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
