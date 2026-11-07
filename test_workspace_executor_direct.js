/**
 * Workspace隔离直接测试
 * 
 * 绕过HTTP层，直接测试executor + contribute-session的核心逻辑
 * 验证workspace目录创建、产物收集过滤
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { ensureContributeWorkspace, collectWorkspaceArtifacts } = require('./client/electron/contribute-session');

console.log('=== Workspace隔离直接测试 ===\n');

const tests = [];

function test(name, fn, security = false) {
  try {
    fn();
    tests.push({ name, pass: true, security });
    console.log(`✓ ${name}`);
  } catch (e) {
    tests.push({ name, pass: false, security });
    console.error(`✗ ${name}: ${e.message}`);
  }
}

// ========== 测试1: ensureContributeWorkspace目录隔离 ==========
console.log('测试1: ensureContributeWorkspace基础隔离\n');

test('u100的workspace目录', () => {
  const dir1 = ensureContributeWorkspace('artist-bot', 'u100');
  if (!dir1.includes('artist-bot') || !dir1.includes('u100')) {
    throw new Error(`目录路径不正确: ${dir1}`);
  }
  if (!fs.existsSync(dir1)) {
    throw new Error('目录未创建');
  }
});

test('u200的workspace目录与u100隔离', () => {
  const dir1 = ensureContributeWorkspace('artist-bot', 'u100');
  const dir2 = ensureContributeWorkspace('artist-bot', 'u200');
  if (dir1 === dir2) {
    throw new Error('未隔离：相同目录');
  }
  if (!dir2.includes('u200')) {
    throw new Error(`u200目录路径不正确: ${dir2}`);
  }
}, true);

test('不同assistant隔离', () => {
  const dir1 = ensureContributeWorkspace('artist-bot', 'u100');
  const dir2 = ensureContributeWorkspace('coder-bot', 'u100');
  if (dir1 === dir2) {
    throw new Error('未隔离：相同assistant不同目录');
  }
  if (!dir2.includes('coder-bot')) {
    throw new Error(`coder-bot目录不正确: ${dir2}`);
  }
}, true);

console.log('');

// ========== 测试2: collectWorkspaceArtifacts产物过滤 ==========
console.log('测试2: collectWorkspaceArtifacts产物过滤\n');

// 准备测试目录
const testWorkspace = path.join(os.tmpdir(), `test-workspace-${Date.now()}`);
fs.mkdirSync(testWorkspace, { recursive: true });

// 绘图场景：图片+package.json（应该只收集图片）
const imagePath = path.join(testWorkspace, 'output.png');
const packagePath = path.join(testWorkspace, 'package.json');
const packageLockPath = path.join(testWorkspace, 'package-lock.json');

fs.writeFileSync(imagePath, Buffer.from('fake-png-data'));
fs.writeFileSync(packagePath, JSON.stringify({ name: 'accidental-dep' }));
fs.writeFileSync(packageLockPath, JSON.stringify({ lockfileVersion: 2 }));

const drawingOutput = '生成了图片：output.png\n\n图片已保存到当前目录。';
const taskStartTime = Date.now() - 1000; // 1秒前开始

test('绘图任务收集图片', () => {
  const artifacts = collectWorkspaceArtifacts(testWorkspace, drawingOutput, taskStartTime);
  const hasImage = artifacts.some(a => a.name === 'output.png');
  if (!hasImage) {
    throw new Error('未收集到output.png');
  }
});

test('绘图任务排除根目录package.json', () => {
  const artifacts = collectWorkspaceArtifacts(testWorkspace, drawingOutput, taskStartTime);
  const hasPackage = artifacts.some(a => a.name === 'package.json');
  if (hasPackage) {
    throw new Error('误收了package.json');
  }
}, true);

test('绘图任务排除根目录package-lock.json', () => {
  const artifacts = collectWorkspaceArtifacts(testWorkspace, drawingOutput, taskStartTime);
  const hasPackageLock = artifacts.some(a => a.name === 'package-lock.json');
  if (hasPackageLock) {
    throw new Error('误收了package-lock.json');
  }
}, true);

// 代码交付场景：正文明确提及package.json（应该收集）
const codeOutput = '项目已创建：\n- package.json\n- README.md\n\n配置已完成。';
const readmePath = path.join(testWorkspace, 'README.md');
fs.writeFileSync(readmePath, '# Test Project');

test('代码交付正文提及package.json时收集', () => {
  const artifacts = collectWorkspaceArtifacts(testWorkspace, codeOutput, taskStartTime);
  const hasPackage = artifacts.some(a => a.name === 'package.json');
  if (!hasPackage) {
    throw new Error('未收集正文提及的package.json');
  }
});

test('代码交付收集README.md', () => {
  const artifacts = collectWorkspaceArtifacts(testWorkspace, codeOutput, taskStartTime);
  const hasReadme = artifacts.some(a => a.name === 'README.md');
  if (!hasReadme) {
    throw new Error('未收集README.md');
  }
});

// 子目录场景：子目录中的package.json默认也排除（除非正文明确提及）
const subDir = path.join(testWorkspace, 'subproject');
fs.mkdirSync(subDir, { recursive: true });
const subPackagePath = path.join(subDir, 'package.json');
fs.writeFileSync(subPackagePath, JSON.stringify({ name: 'subproject' }));

test('绘图任务排除子目录package.json', () => {
  const drawingSubOutput = '生成了图片，子目录里有配置文件。';
  const artifacts = collectWorkspaceArtifacts(testWorkspace, drawingSubOutput, taskStartTime);
  const hasSubPackage = artifacts.some(a => a.name === 'package.json' && a.localPath && a.localPath.includes('subproject'));
  if (hasSubPackage) {
    throw new Error('误收了子目录的package.json');
  }
}, true);

test('明确提及时收集子目录package.json（中文标点）', () => {
  const explicitSubOutput = '子项目已创建：subproject/package.json';
  const artifacts = collectWorkspaceArtifacts(testWorkspace, explicitSubOutput, taskStartTime);
  const hasSubPackage = artifacts.some(a => a.name === 'package.json' && a.localPath && a.localPath.includes('subproject'));
  if (!hasSubPackage) {
    throw new Error('未收集正文提及的子目录package.json');
  }
});

test('Markdown反引号中的文件路径', () => {
  const mdOutput = '生成了文件 `subproject/package.json` 和其他文件。';
  const artifacts = collectWorkspaceArtifacts(testWorkspace, mdOutput, taskStartTime);
  const hasSubPackage = artifacts.some(a => a.name === 'package.json' && a.localPath && a.localPath.includes('subproject'));
  if (!hasSubPackage) {
    throw new Error('未识别反引号中的路径');
  }
});

// 时间窗口测试：旧文件不应被收集
const oldFile = path.join(testWorkspace, 'old-output.png');
fs.writeFileSync(oldFile, Buffer.from('old-data'));
// 将文件时间设置为过去
const oldTime = taskStartTime - 10000; // 10秒前
fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

test('时间窗口外的文件不收集', () => {
  const output = '新图片：output.png\n旧图片不应该被收集。';
  const artifacts = collectWorkspaceArtifacts(testWorkspace, output, taskStartTime);
  const hasOld = artifacts.some(a => a.name === 'old-output.png');
  if (hasOld) {
    throw new Error('误收了时间窗口外的文件');
  }
}, true);

// 清理
try {
  fs.rmSync(testWorkspace, { recursive: true, force: true });
} catch {}

console.log('');

// ========== 测试3: 路径安全验证 ==========
console.log('测试3: collectWorkspaceArtifacts路径安全\n');

const safeWorkspace = path.join(os.tmpdir(), `test-safe-${Date.now()}`);
fs.mkdirSync(safeWorkspace, { recursive: true });

// 创建一个符号链接指向外部
const outsideDir = path.join(os.tmpdir(), `outside-${Date.now()}`);
fs.mkdirSync(outsideDir, { recursive: true });
const outsideFile = path.join(outsideDir, 'secret.txt');
fs.writeFileSync(outsideFile, 'secret data');

const symlinkPath = path.join(safeWorkspace, 'link-to-outside');
try {
  fs.symlinkSync(outsideDir, symlinkPath);
  
  test('拒绝收集符号链接', () => {
    const output = '文件：link-to-outside/secret.txt';
    const artifacts = collectWorkspaceArtifacts(safeWorkspace, output, Date.now() - 1000);
    const hasSymlink = artifacts.some(a => a.localPath && a.localPath.includes('link-to-outside'));
    if (hasSymlink) {
      throw new Error('误收了符号链接文件');
    }
  }, true);
} catch (e) {
  console.log(`  ⊘ 跳过符号链接测试: ${e.message}`);
}

// 清理
try {
  fs.rmSync(safeWorkspace, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
} catch {}

console.log('');

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
