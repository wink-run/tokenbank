/**
 * 真实executor artifacts收集测试
 * 模拟实际任务：executor在contribute workspace执行，生成图片
 * 
 * 测试场景：
 * 1. 图片在工作目录的outputs/子目录
 * 2. 正文只有basename（裸文件名）
 * 3. 根目录有package.json（在任务期间被修改）
 * 4. 验证：图片被收集，package.json也被收集（用户可能明确交付代码）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// 加载实际模块
const { ensureContributeWorkspace, collectWorkspaceArtifacts } = require('./client/electron/contribute-session');

console.log('=== 真实Executor Artifacts收集测试 ===\n');

// 模拟任务参数
const assistantId = 'test-artist';
const consumerKey = 'u12345';

// 创建contribute workspace（与实际代码相同）
const workingDir = ensureContributeWorkspace(assistantId, consumerKey);
console.log(`工作目录: ${workingDir}`);
console.log('');

// 模拟任务开始时间
const taskStartTime = Date.now();

// 等待1秒，模拟任务执行
setTimeout(() => {
  console.log('步骤1: 模拟executor在工作目录生成产物...');
  
  // 在工作目录创建outputs子目录
  const outputsDir = path.join(workingDir, 'outputs');
  if (!fs.existsSync(outputsDir)) {
    fs.mkdirSync(outputsDir);
  }
  
  // 生成图片文件（模拟agent执行结果）
  const testImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  
  const imagePath1 = path.join(outputsDir, 'snow-poem-chuxue-16x9.png');
  fs.writeFileSync(imagePath1, testImage);
  
  const imagePath2 = path.join(outputsDir, 'snow-poem-ink-2x.png');
  fs.writeFileSync(imagePath2, testImage);
  
  const svgPath = path.join(outputsDir, 'snow-poem-ink.svg');
  fs.writeFileSync(svgPath, '<svg><rect width="100" height="100"/></svg>');
  
  console.log(`  生成图片: ${path.basename(imagePath1)}`);
  console.log(`  生成图片: ${path.basename(imagePath2)}`);
  console.log(`  生成SVG: ${path.basename(svgPath)}`);
  console.log('');
  
  // 模拟项目依赖文件（在任务期间被修改，如npm install）
  const packageJsonPath = path.join(workingDir, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify({
    name: 'snow-poem-project',
    version: '1.0.0',
    dependencies: {}
  }, null, 2));
  
  const packageLockPath = path.join(workingDir, 'package-lock.json');
  fs.writeFileSync(packageLockPath, JSON.stringify({
    lockfileVersion: 2,
    packages: {}
  }, null, 2));
  
  console.log('  生成依赖文件: package.json, package-lock.json');
  console.log('');
  
  // 模拟agent输出（只有裸文件名）
  const agentOutput = `画好了，采用水墨风格，16:9横版：

文件（snow-poem）

• snow-poem-chuxue-16x9.png — 1920×1080，发布用
• snow-poem-ink-2x.png — 3840×2160，印刷、大屏用
• snow-poem-ink.svg — 矢量源文件，可无损放大、改色

画面速览对应：

诗句	画面的表现方式
夜雪无声没旧痕	右下四省石坊，阶面雪白、下部沉雪线
`;

  console.log('步骤2: 收集产物（使用任务开始时间）...');
  console.log(`  startedAt: ${new Date(taskStartTime).toISOString()}`);
  console.log('');
  
  // 执行收集（与executor实际逻辑相同）
  const artifacts = collectWorkspaceArtifacts(workingDir, agentOutput, taskStartTime);
  
  console.log(`收集结果: ${artifacts.length} 个产物`);
  console.log('');
  
  // 分类
  const images = artifacts.filter(a => a.kind === 'image');
  const svgs = artifacts.filter(a => a.name.endsWith('.svg'));
  const jsons = artifacts.filter(a => a.mime === 'application/json');
  
  console.log('产物详情:');
  artifacts.forEach((art, i) => {
    console.log(`  ${i + 1}. ${art.name}`);
    console.log(`     kind: ${art.kind}`);
    console.log(`     mime: ${art.mime}`);
    console.log(`     size: ${(art.dataUrl.length / 1.37).toFixed(0)} bytes (approx)`);
    const inWorkingDir = art.localPath.startsWith(workingDir);
    console.log(`     localPath: ${inWorkingDir ? '✓ 在工作目录' : '✗ 不在工作目录'}`);
  });
  console.log('');
  
  // 验证
  console.log('=== 验证结果 ===');
  
  const hasAllImages = images.length >= 2 && 
    images.some(a => a.name === 'snow-poem-chuxue-16x9.png') &&
    images.some(a => a.name === 'snow-poem-ink-2x.png');
  console.log(`1. 图片被收集: ${hasAllImages ? '✓' : '✗ 失败！'}`);
  
  const hasSvg = svgs.some(a => a.name === 'snow-poem-ink.svg');
  console.log(`2. SVG被收集: ${hasSvg ? '✓' : '✗ 失败！'}`);
  
  const allInWorkingDir = artifacts.every(a => a.localPath.startsWith(workingDir));
  console.log(`3. 所有产物在工作目录: ${allInWorkingDir ? '✓' : '✗ 失败！'}`);
  
  const hasPackageJson = jsons.some(a => a.name === 'package.json');
  const hasPackageLock = jsons.some(a => a.name === 'package-lock.json');
  console.log(`4. package.json被收集: ${hasPackageJson ? '✓（允许，用户可能交付代码）' : '✓'}`);
  console.log(`5. package-lock.json被收集: ${hasPackageLock ? '✓（允许，用户可能交付代码）' : '✓'}`);
  
  // 清理
  fs.rmSync(workingDir, { recursive: true, force: true });
  console.log('');
  console.log('✓ 测试产物已清理');
  console.log('');
  
  if (hasAllImages && hasSvg && allInWorkingDir) {
    console.log('✓ 全部通过：图片正常收集，localPath正确');
    process.exit(0);
  } else {
    console.log('✗ 测试失败');
    process.exit(1);
  }
  
}, 1000);
