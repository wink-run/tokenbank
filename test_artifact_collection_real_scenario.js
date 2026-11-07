/**
 * 真实场景回归测试：模拟生产问题
 * - 图片在子目录生成
 * - 输出包含裸文件名
 * - 工作目录包含无关的package.json
 */

const fs = require('fs');
const path = require('path');
const { collectWorkspaceArtifacts } = require('./client/electron/contribute-session');

// 创建临时工作目录
const tmpDir = path.join(__dirname, 'tmp_real_scenario');
if (fs.existsSync(tmpDir)) {
  fs.rmSync(tmpDir, { recursive: true });
}
fs.mkdirSync(tmpDir, { recursive: true });

// 创建子目录
const outputDir = path.join(tmpDir, 'outputs');
fs.mkdirSync(outputDir);

console.log('=== 真实场景回归测试 ===\n');
console.log('模拟场景：');
console.log('  任务开始：08:39:55（时间戳：1699332000000）');
console.log('  任务结束：08:42:27（时间戳：1699332150000，+150s）');
console.log('  时间窗口：Date.now() - 300000 = 1699331850000 (08:37:30)');
console.log('');

// 模拟时间线
const taskStartTime = 1699332000000; // 08:39:55
const taskEndTime = 1699332150000;   // 08:42:27
const windowStartTime = taskEndTime - 300000; // 08:37:30

// 场景1：package.json在任务前就存在，但在窗口内被修改
const packageJsonPath = path.join(tmpDir, 'package.json');
fs.writeFileSync(packageJsonPath, JSON.stringify({ name: 'test' }, null, 2));
fs.utimesSync(packageJsonPath, 
  new Date(windowStartTime + 60000),  // 访问时间：08:38:30
  new Date(windowStartTime + 60000)); // 修改时间：08:38:30

const packageLockPath = path.join(tmpDir, 'package-lock.json');
fs.writeFileSync(packageLockPath, JSON.stringify({ lockfileVersion: 2 }, null, 2));
fs.utimesSync(packageLockPath, 
  new Date(windowStartTime + 60000), 
  new Date(windowStartTime + 60000));

console.log('场景1: 无关JSON文件（在时间窗口内）');
console.log(`  package.json mtime: ${new Date(windowStartTime + 60000).toISOString()}`);
console.log(`  在窗口内: ${windowStartTime + 60000 >= windowStartTime ? '✓' : '✗'}`);
console.log('');

// 场景2：图片在任务期间生成（在outputs子目录）
const testImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const imagePath1 = path.join(outputDir, 'snow-poem-chuxue-16x9.png');
fs.writeFileSync(imagePath1, testImage);
fs.utimesSync(imagePath1,
  new Date(taskStartTime + 60000),  // 08:40:55
  new Date(taskStartTime + 60000));

const imagePath2 = path.join(outputDir, 'snow-poem-ink-2x.png');
fs.writeFileSync(imagePath2, testImage);
fs.utimesSync(imagePath2,
  new Date(taskStartTime + 70000),
  new Date(taskStartTime + 70000));

const svgPath = path.join(outputDir, 'snow-poem-ink.svg');
fs.writeFileSync(svgPath, '<svg></svg>');
fs.utimesSync(svgPath,
  new Date(taskStartTime + 80000),
  new Date(taskStartTime + 80000));

const pyPath = path.join(outputDir, 'gen_svg.py');
fs.writeFileSync(pyPath, 'print("hello")');
fs.utimesSync(pyPath,
  new Date(taskStartTime + 50000),
  new Date(taskStartTime + 50000));

console.log('场景2: 图片文件（在outputs子目录）');
console.log(`  snow-poem-chuxue-16x9.png mtime: ${new Date(taskStartTime + 60000).toISOString()}`);
console.log(`  路径: outputs/snow-poem-chuxue-16x9.png`);
console.log('');

// 场景3：模拟agent输出（包含裸文件名）
const agentOutput = `画好了，采用水墨风格，16:9横版：

文件（snow-poem）

• snow-poem-chuxue-16x9.png — 1920×1080，发布用
• snow-poem-ink-2x.png — 3840×2160，印刷、大屏用
• snow-poem-ink.svg — 矢量源文件，可无损放大、改色
• gen_svg.py — 生成脚本，修改坐标即可重新生成

画面速览对应：

诗句	画面的表现方式
夜雪无声没旧痕	右下四省石坊，阶面雪白、下部沉雪线
`;

console.log('场景3: Agent输出');
console.log('  包含裸文件名: snow-poem-chuxue-16x9.png');
console.log('  包含相对路径: (无，只有裸名)');
console.log('');

// 执行收集（使用任务结束时间 - 5分钟）
console.log('执行收集...');
console.log(`  workingDir: ${tmpDir}`);
console.log(`  startedAt: ${windowStartTime} (${new Date(windowStartTime).toISOString()})`);
console.log('');

const artifacts = collectWorkspaceArtifacts(tmpDir, agentOutput, windowStartTime);

console.log(`收集结果: ${artifacts.length} 个产物`);
console.log('');

// 分类统计
const images = artifacts.filter(a => a.kind === 'image');
const files = artifacts.filter(a => a.kind === 'file');
const jsons = artifacts.filter(a => a.mime === 'application/json');

console.log('分类统计:');
console.log(`  图片 (image): ${images.length}`);
console.log(`  文件 (file): ${files.length}`);
console.log(`  JSON: ${jsons.length}`);
console.log('');

// 详细列表
console.log('产物详情:');
artifacts.forEach((art, i) => {
  console.log(`  ${i + 1}. ${art.name}`);
  console.log(`     mime: ${art.mime}`);
  console.log(`     kind: ${art.kind}`);
  console.log(`     localPath: ${art.localPath}`);
  console.log(`     size: ${art.dataUrl ? (art.dataUrl.length / 1.37).toFixed(0) : 0} bytes (approx)`);
});
console.log('');

// 验证问题
console.log('=== 问题验证 ===');

const hasSnowPoemImages = artifacts.some(a => 
  a.name.includes('snow-poem') && a.kind === 'image'
);
console.log(`1. 图片被收集: ${hasSnowPoemImages ? '✓' : '✗ BUG!'}`);

const hasPackageJson = artifacts.some(a => a.name === 'package.json');
const hasPackageLock = artifacts.some(a => a.name === 'package-lock.json');
console.log(`2. package.json被误收: ${hasPackageJson ? '✗ BUG!' : '✓'}`);
console.log(`3. package-lock.json被误收: ${hasPackageLock ? '✗ BUG!' : '✓'}`);

const allHaveLocalPath = artifacts.every(a => a.localPath && a.localPath.length > 0);
console.log(`4. 所有产物都有localPath: ${allHaveLocalPath ? '✓' : '✗ BUG!'}`);

console.log('');

// 清理
fs.rmSync(tmpDir, { recursive: true });

// 总结
console.log('=== 测试总结 ===');
if (hasSnowPoemImages && !hasPackageJson && !hasPackageLock && allHaveLocalPath) {
  console.log('✓ 全部通过');
  process.exit(0);
} else {
  console.log('✗ 发现问题：');
  if (!hasSnowPoemImages) console.log('  - 图片未被收集');
  if (hasPackageJson || hasPackageLock) console.log('  - 无关JSON被误收');
  if (!allHaveLocalPath) console.log('  - localPath缺失');
  process.exit(1);
}
